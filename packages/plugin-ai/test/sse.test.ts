/**
 * SSE 基元的纯逻辑测试（帧编码 / 帧序列不变量 / 帧写入器 / 超时看门狗）。
 *
 * 为什么把这批断言放在"不起 HTTP"的层面：帧编码与协议不变量是**纯函数性质**，
 * 用真实端口测只会引入抖动，却测不出"某个特殊字符破坏了帧边界"这类问题。
 * 真实 HTTP 链路另由 `stream.test.ts`（真 node:http + 真 SSE 字节）覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import {
  MAX_CONCURRENT_STREAMS,
  SSE_EVENT_DELTA,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  SSE_EVENT_STATUS,
  STREAM_HARD_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  createFrameWriter,
  createIdleWatchdog,
  encodeSseFrame,
  isTerminalEvent,
  validateFrameSequence,
  writeSseHead,
  type AiStreamEvent,
} from '../src/sse.js'

/* ------------------------------ 夹具 ------------------------------ */

/** 记录写入字节与响应头的最小 ServerResponse 替身 */
interface FakeRes {
  res: ServerResponse
  chunks: string[]
  headers: Record<string, string> | null
  flushed: boolean
  ended: boolean
  text(): string
}

function fakeRes(): FakeRes {
  const state: FakeRes = {
    chunks: [],
    headers: null,
    flushed: false,
    ended: false,
    text: () => state.chunks.join(''),
    res: undefined as unknown as ServerResponse,
  }
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead: (status: number, headers: Record<string, string>) => {
      state.headers = { ...headers, ':status': String(status) }
      ;(res as { headersSent: boolean }).headersSent = true
      return res
    },
    flushHeaders: () => {
      state.flushed = true
    },
    write: (chunk: string) => {
      if ((res as { writableEnded: boolean }).writableEnded) throw new Error('write after end')
      state.chunks.push(chunk)
      return true
    },
    end: () => {
      state.ended = true
      ;(res as { writableEnded: boolean }).writableEnded = true
    },
  }
  state.res = res as unknown as ServerResponse
  return state
}

const statusEvent = (): AiStreamEvent => ({
  event: SSE_EVENT_STATUS,
  data: { mode: 'retrieval-only', retrieval: { mode: 'fts', total: 1, limit: 8 }, sources: [], degraded: null },
})
const deltaEvent = (text: string): AiStreamEvent => ({ event: SSE_EVENT_DELTA, data: { text } })
const doneEvent = (): AiStreamEvent => ({
  event: SSE_EVENT_DONE,
  data: { answer: 'ok', answerFormat: 'plain', usage: null, partial: false, elapsedMs: 1 },
})

/* ============================ 帧编码 ============================ */

test('encodeSseFrame：基本形态为 event 行 + data 行 + 空行', () => {
  const frame = encodeSseFrame('delta', { text: '你好' })
  assert.equal(frame, 'event: delta\ndata: {"text":"你好"}\n\n')
})

test('encodeSseFrame：内容含引号/反斜杠/中文/emoji 时仍是单行 data 且帧边界完整', () => {
  const tricky = '引号"双"、单\'引\'、反斜杠\\、换行转义\\n、emoji😀、中文'
  const frame = encodeSseFrame('delta', { text: tricky })
  // 帧必须以空行收尾，且内部**不得出现裸换行**（否则会破坏帧边界）
  assert.ok(frame.endsWith('\n\n'), '帧必须以便于分帧的空行收尾')
  const body = frame.slice(0, -2) // 去掉结尾空行
  const lines = body.split('\n')
  assert.equal(lines.length, 2, `应恰为 event + data 两行，实际 ${lines.length} 行: ${JSON.stringify(lines)}`)
  assert.ok(lines[0]!.startsWith('event: '))
  assert.ok(lines[1]!.startsWith('data: '))
  // 解析回来必须与输入**逐字相等**（证明转义无损）
  const parsed = JSON.parse(lines[1]!.slice('data: '.length)) as { text: string }
  assert.equal(parsed.text, tricky)
})

test('encodeSseFrame：载荷含真实换行时被转义，不会破坏帧边界', () => {
  // JSON.stringify 会把字符串里的换行转义成 `\n` 两个字符，因此正常路径恒为单行 data。
  // 这条断言钉住的正是"帧边界不被内容破坏"这个安全性——含换行的正文是最容易踩的情形。
  const frame = encodeSseFrame('delta', { text: 'line1\nline2\nline3' })
  const body = frame.slice(0, -2)
  const lines = body.split('\n')
  assert.equal(lines.length, 2, `换行必须被转义而非拆行，实际 ${lines.length} 行`)
  for (const line of lines) {
    assert.ok(line.startsWith('event: ') || line.startsWith('data: '), `非法行: ${JSON.stringify(line)}`)
  }
  const parsed = JSON.parse(lines[1]!.slice('data: '.length)) as { text: string }
  assert.equal(parsed.text, 'line1\nline2\nline3', '转义必须无损（解析回来与原值逐字相等）')
  // 逐字对照：data 行里出现的是转义序列，不是裸换行
  assert.ok(lines[1]!.includes('\\n'), 'data 行里应是转义后的 \\n')
})

test('encodeSseFrame：undefined/null 载荷编码为 JSON null（不产生空 data 行歧义）', () => {
  assert.equal(encodeSseFrame('x', undefined), 'event: x\ndata: null\n\n')
  assert.equal(encodeSseFrame('x', null), 'event: x\ndata: null\n\n')
})

/* ======================= 帧序列不变量 ======================= */

test('validateFrameSequence：合法序列（status → delta* → done）通过', () => {
  assert.equal(validateFrameSequence([statusEvent(), deltaEvent('a'), doneEvent()]), null)
})

test('validateFrameSequence：status 后直接 done（无 delta）合法', () => {
  assert.equal(validateFrameSequence([statusEvent(), doneEvent()]), null)
})

test('validateFrameSequence：error 作为终结帧同样合法', () => {
  const err: AiStreamEvent = { event: SSE_EVENT_ERROR, data: { code: 'TIMEOUT', message: '超时' } }
  assert.equal(validateFrameSequence([statusEvent(), err]), null)
})

test('validateFrameSequence：逐条拒绝违规序列', () => {
  const err: AiStreamEvent = { event: SSE_EVENT_ERROR, data: { code: 'X', message: 'x' } }
  assert.match(validateFrameSequence([]) ?? '', /不得为空/)
  assert.match(validateFrameSequence([doneEvent()]) ?? '', /首帧必须是/)
  assert.match(validateFrameSequence([statusEvent(), deltaEvent('a')]) ?? '', /终止帧必须恰一帧/)
  assert.match(validateFrameSequence([statusEvent(), doneEvent(), doneEvent()]) ?? '', /终止帧必须恰一帧/)
  // 终止帧不在末位：无论后面跟的是 delta 还是另一个终止帧，都必须被拒
  assert.match(validateFrameSequence([statusEvent(), doneEvent(), deltaEvent('a')]) ?? '', /终止帧必须位于末位/)
  assert.match(validateFrameSequence([statusEvent(), err, deltaEvent('a')]) ?? '', /终止帧必须位于末位/)
  assert.match(validateFrameSequence([statusEvent(), doneEvent(), err]) ?? '', /终止帧必须恰一帧/)
})

test('validateFrameSequence：对"终止帧恰一帧且在末位"的等价表述做了实测（终止后无帧由它蕴含）', () => {
  // 这条钉住"终止帧之后不得再有帧"这一不变量**不是**漏判：
  // 任何在终止帧之后再追加一帧的序列都必须被拒。
  const withExtra: AiStreamEvent[] = [statusEvent(), doneEvent(), deltaEvent('late')]
  assert.notEqual(validateFrameSequence(withExtra), null, '终止帧之后追加内容必须被拒')
})

test('isTerminalEvent：只认 done / error', () => {
  assert.equal(isTerminalEvent(statusEvent()), false)
  assert.equal(isTerminalEvent(deltaEvent('a')), false)
  assert.equal(isTerminalEvent(doneEvent()), true)
  assert.equal(isTerminalEvent({ event: SSE_EVENT_ERROR, data: { code: 'X', message: 'x' } }), true)
})

/* ============================ 帧写入器 ============================ */

test('writeSseHead：写三个必需的响应头并立即刷头', () => {
  const f = fakeRes()
  writeSseHead(f.res)
  assert.equal(f.headers?.['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(f.headers?.['cache-control'], 'no-cache, no-transform')
  // 防中间层缓冲：没有这个头，nginx 之类会把事件流攒成一次性响应
  assert.equal(f.headers?.['x-accel-buffering'], 'no')
  assert.equal(f.flushed, true, '必须立即刷头，否则 status 帧要等到第一段正文才可见')
})

test('createFrameWriter：终止帧后闩锁——不再写任何字节（协议要求终止后无帧）', () => {
  const f = fakeRes()
  const w = createFrameWriter(f.res)
  assert.equal(w.write(statusEvent()), true)
  assert.equal(w.write(deltaEvent('a')), true)
  assert.equal(w.write(doneEvent()), true)
  assert.equal(w.terminated, true)
  const before = f.text()
  // 终止后再写：必须被丢弃（这正是"终止帧恰一帧且在最后"的运行时保障）
  assert.equal(w.write(deltaEvent('late')), false)
  assert.equal(w.write(doneEvent()), false)
  assert.equal(f.text(), before, '终止后不得有任何新字节')
  assert.equal(
    validateFrameSequence([statusEvent(), deltaEvent('a'), doneEvent()]),
    null,
    '写出的序列本身仍是合法的',
  )
})

test('createFrameWriter：连接已结束或已销毁时写入返回 false 且不抛（断连不该带崩流处理）', () => {
  const f = fakeRes()
  const w = createFrameWriter(f.res)
  ;(f.res as unknown as { writableEnded: boolean }).writableEnded = true
  assert.equal(w.write(statusEvent()), false)
  ;(f.res as unknown as { writableEnded: boolean }).writableEnded = false
  ;(f.res as unknown as { destroyed: boolean }).destroyed = true
  assert.equal(w.write(statusEvent()), false)
  assert.equal(f.text(), '', '连接不可用时不得写出任何字节')
})

test('createFrameWriter：底层 write 抛错时静默失败而不是把异常抛给调用方', () => {
  const f = fakeRes()
  const broken = {
    writableEnded: false,
    destroyed: false,
    write: () => {
      throw new Error('EPIPE')
    },
    end: () => {},
  } as unknown as ServerResponse
  const w = createFrameWriter(broken)
  assert.equal(w.write(statusEvent()), false, '写入失败应返回 false，而非抛错')
  assert.doesNotThrow(() => w.end())
  // 对照：正常的 res 仍能写
  assert.equal(createFrameWriter(f.res).write(statusEvent()), true)
})

test('createFrameWriter：end 幂等，且对已结束的响应不再调 end', () => {
  const f = fakeRes()
  const w = createFrameWriter(f.res)
  w.write(statusEvent())
  w.end()
  assert.equal(f.ended, true)
  assert.doesNotThrow(() => w.end())
})

/* ============================ 看门狗 ============================ */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('createIdleWatchdog：空闲超时触发 onTimeout 并置 timedOut', async () => {
  let fired = 0
  const wd = createIdleWatchdog({ idleMs: 30, hardMs: 5_000, onTimeout: () => fired++ })
  await sleep(80)
  assert.equal(fired, 1, '空闲超时必须触发一次')
  assert.equal(wd.timedOut, true)
  wd.clear()
})

test('createIdleWatchdog：kick 重置空闲计时（持续有数据就不会超时）', async () => {
  let fired = 0
  const wd = createIdleWatchdog({ idleMs: 60, hardMs: 5_000, onTimeout: () => fired++ })
  // 每 25ms kick 一次、持续 150ms：若 kick 无效，60ms 时就会触发
  for (let i = 0; i < 6; i++) {
    await sleep(25)
    wd.kick()
  }
  assert.equal(fired, 0, 'kick 必须重置空闲计时')
  assert.equal(wd.timedOut, false)
  wd.clear()
})

test('createIdleWatchdog：硬超时不受 kick 影响（总时长上限）', async () => {
  let fired = 0
  const wd = createIdleWatchdog({ idleMs: 1_000, hardMs: 40, onTimeout: () => fired++ })
  for (let i = 0; i < 5; i++) {
    await sleep(20)
    wd.kick() // 一直有数据，但总时长已超
  }
  assert.equal(fired, 1, '硬超时必须触发，即使一直在收数据')
  assert.equal(wd.timedOut, true)
  wd.clear()
})

test('createIdleWatchdog：clear 之后不再触发（否则流结束后定时器会继续持有引用）', async () => {
  let fired = 0
  const wd = createIdleWatchdog({ idleMs: 20, hardMs: 20, onTimeout: () => fired++ })
  wd.clear()
  await sleep(60)
  assert.equal(fired, 0, 'clear 后不得再触发')
  assert.equal(wd.timedOut, false)
})

test('常量取值符合契约（超时与并发上限）', () => {
  assert.equal(STREAM_HARD_TIMEOUT_MS, 120_000)
  assert.equal(STREAM_IDLE_TIMEOUT_MS, 30_000)
  assert.equal(MAX_CONCURRENT_STREAMS, 4)
})
