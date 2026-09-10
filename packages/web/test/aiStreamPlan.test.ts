/**
 * 流式问答的**增量解析与状态归约**单测（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/web test
 *
 * 本文件重点钉住三件最容易做错、且在本地小数据量下**不会自然复现**的事：
 * 1. **多字节安全**：一个中文（3 字节）或 emoji（4 字节，代理对）被 HTTP chunk 边界切断时，
 *    `TextDecoder` 必须带 `{ stream: true }` 才能拼回；否则会解出 `U+FFFD` 乱码。
 *    这里直接**按字节**切分来构造这种边界。
 * 2. **帧边界**：一帧 `event: x\ndata: {...}\n\n` 可能被切成任意多段到达，解析器必须自带缓冲。
 * 3. **`done.answer` 的权威性**：它必须覆盖流式累积值（否则会出现丢字/重复）；
 *    而 `error` 必须**保留已渲染的 sources**（不能让用户丢掉检索结果）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAiStreamEvent,
  applyLocalFailure,
  createAiStreamDecoder,
  createSseParser,
  initialAiStreamState,
  markAiStreamStarted,
  parseAiStreamFrame,
  visibleAnswer,
  type AiStreamState,
} from '../src/lib/aiStreamPlan'

const enc = new TextEncoder()

/** 一帧的字节形式（与服务端 `event: X\ndata: Y\n\n` 一致） */
function frameBytes(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function statusFrame(): Uint8Array {
  return frameBytes('status', {
    mode: 'rag',
    retrieval: { mode: 'fts', total: 2, limit: 8 },
    sources: [{ n: 1, slug: 'kb', title: '知识库', snippet: 'a<mark>b</mark>', score: 1, updated_at: 'x', used: true }],
    degraded: null,
  })
}

/** 按固定大小把字节流切片模拟 HTTP chunk */
function sliceBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

/* ------------------------------ SSE 分帧 ------------------------------ */

test('SSE 分帧：一帧被切成任意多段仍能完整解析', () => {
  // 这里只验**分帧**，故按"字符"逐片喂（字节层的多字节切分由下面的解码器用例专门覆盖）：
  // 逐字符切会把 \n、冒号、引号、转义序列全部切开，是最严苛的帧边界。
  const text = `event: delta\ndata: ${JSON.stringify({ text: '你好' })}\n\n`
  const parser = createSseParser()
  const events: string[] = []
  for (const ch of text) {
    for (const f of parser.push(ch)) events.push(`${f.event}:${f.data}`)
  }
  assert.equal(events.length, 1, `逐字符切应仍解析出 1 帧，实际 ${JSON.stringify(events)}`)
  assert.equal(events[0], 'delta:{"text":"你好"}')
})

test('SSE 分帧：CRLF 与注释行、多行 data 拼接', () => {
  const parser = createSseParser()
  // 注释行（: 开头）应被忽略；data 分两行按规范用 \n 拼接；CRLF 也要认
  const frames = parser.push(': keep-alive\r\nevent: delta\r\ndata: {"text":"a\r\ndata: b"}\r\n\r\n')
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.event, 'delta')
  assert.equal(frames[0]?.data, '{"text":"a\nb"}')
})

test('SSE 分帧：多个帧在一次 push 中、且尾帧不完整时只下发完整帧', () => {
  const parser = createSseParser()
  const frames = parser.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3')
  assert.deepEqual(
    frames.map((f) => f.event),
    ['a', 'b'],
    '尾帧没有空行结尾，应留在缓冲里等后续 chunk',
  )
  // 补上结尾后应吐出来
  const more = parser.push('\n\n')
  assert.deepEqual(
    more.map((f) => f.event),
    ['c'],
  )
})

test('SSE 分帧：payload 内出现 \\n\\n 字样不会被误当帧边界', () => {
  const parser = createSseParser()
  const frames = parser.push(`event: delta\ndata: ${JSON.stringify({ text: '第一段\n\n第二段' })}\n\n`)
  assert.equal(frames.length, 1, 'JSON 里的换行是转义序列（字面 \\n），不应切帧')
  const ev = parseAiStreamFrame(frames[0]!)
  assert.deepEqual(ev, { kind: 'delta', text: '第一段\n\n第二段' })
})

/* --------------------------- 字节 → 事件（多字节） --------------------------- */

test('解码器：中文被 chunk 边界切成 1 字节一片也不产生乱码', () => {
  const bytes = frameBytes('delta', { text: '检索增强生成' })
  const decoder = createAiStreamDecoder()
  const events = sliceBytes(bytes, 1).flatMap((b) => decoder.push(b))
  events.push(...decoder.flush())
  const deltas = events.filter((e) => e.kind === 'delta')
  assert.equal(deltas.length, 1)
  assert.equal((deltas[0] as { text: string }).text, '检索增强生成')
  assert.ok(!JSON.stringify(events).includes('\uFFFD'), `不应出现替换字符 U+FFFD：${JSON.stringify(events)}`)
})

test('解码器：emoji（4 字节，代理对）被切断仍完整', () => {
  const bytes = frameBytes('delta', { text: '🎉👍完成' })
  const decoder = createAiStreamDecoder()
  const events = sliceBytes(bytes, 1).flatMap((b) => decoder.push(b))
  events.push(...decoder.flush())
  const text = events
    .filter((e) => e.kind === 'delta')
    .map((e) => (e as { text: string }).text)
    .join('')
  assert.equal(text, '🎉👍完成')
  assert.ok(!JSON.stringify(events).includes('\uFFFD'), '不应出现替换字符')
})

test('解码器：status → delta → done 全序列（2 字节切片）', () => {
  const all = new Uint8Array([
    ...statusFrame(),
    ...frameBytes('delta', { text: '根据资料，' }),
    ...frameBytes('delta', { text: '答案是 42。' }),
    ...frameBytes('done', { answer: '根据资料，答案是 42。', answerFormat: 'plain', usage: { promptTokens: 1 }, partial: false, elapsedMs: 12 }),
  ])
  const decoder = createAiStreamDecoder()
  const events = sliceBytes(all, 2).flatMap((b) => decoder.push(b))
  events.push(...decoder.flush())
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'delta', 'delta', 'done'],
  )
})

/* --------------------------- 事件形状与容错 --------------------------- */

test('parseAiStreamFrame：坏 JSON / 未知事件 / 形状不符一律降级为 invalid，不抛错', () => {
  const cases: { frame: { event: string; data: string }; why: string }[] = [
    { frame: { event: 'delta', data: '{不是 JSON' }, why: '坏 JSON' },
    { frame: { event: 'delta', data: '[]' }, why: '载荷不是对象' },
    { frame: { event: 'delta', data: '{"text":123}' }, why: 'text 不是字符串' },
    { frame: { event: 'status', data: '{"mode":"乱写"}' }, why: 'mode 非法' },
    { frame: { event: 'nope', data: '{}' }, why: '未知事件名' },
  ]
  for (const c of cases) {
    const ev = parseAiStreamFrame(c.frame)
    assert.equal(ev.kind, 'invalid', `${c.why} 应判为 invalid`)
  }
})

test('parseAiStreamFrame：缺字段时取安全默认（sources 非数组 → 空数组）', () => {
  const ev = parseAiStreamFrame({ event: 'status', data: '{"mode":"retrieval-only"}' })
  assert.equal(ev.kind, 'status')
  if (ev.kind !== 'status') return
  assert.deepEqual(ev.payload.sources, [])
  assert.equal(ev.payload.degraded, null)
  assert.equal(ev.payload.retrieval.total, 0)
})

/* --------------------------- 状态归约 --------------------------- */

function reduce(events: Parameters<typeof applyAiStreamEvent>[1][], from?: AiStreamState): AiStreamState {
  let s = from ?? markAiStreamStarted(initialAiStreamState())
  for (const e of events) s = applyAiStreamEvent(s, e)
  return s
}

test('归约：status 立刻给出 sources/degraded（token 之前就能渲染来源）', () => {
  const s = reduce([parseAiStreamFrame({ event: 'status', data: JSON.stringify({ mode: 'rag', retrieval: { mode: 'fts', total: 1, limit: 8 }, sources: [{ slug: 'a' }], degraded: null }) })])
  assert.equal(s.phase, 'streaming')
  assert.equal(s.mode, 'rag')
  assert.equal(s.sources.length, 1, 'status 一到就应有来源')
  assert.equal(s.streamText, '', '此时还没有任何 token')
})

test('归约：delta 逐字追加（多个 delta 累加而非覆盖）', () => {
  const s = reduce([
    { kind: 'delta', text: '检索' },
    { kind: 'delta', text: '增强' },
    { kind: 'delta', text: '生成' },
  ])
  assert.equal(s.streamText, '检索增强生成')
  assert.equal(s.phase, 'streaming')
})

test('归约：done.answer 覆盖流式累积值（权威文本）', () => {
  const s = reduce([
    { kind: 'delta', text: '这是被截断的半截' },
    { kind: 'done', payload: { answer: '这是完整答案。', answerFormat: 'plain', usage: null, partial: false, elapsedMs: 9 } },
  ])
  assert.equal(s.phase, 'done')
  const v = visibleAnswer(s)
  assert.equal(v.text, '这是完整答案。')
  assert.equal(v.authoritative, true, 'done 之后必须用权威文本渲染')
})

test('归约：error 保留已渲染的 sources（不让用户丢掉检索结果）', () => {
  const s = reduce([
    { kind: 'status', payload: { mode: 'rag', retrieval: { mode: 'fts', total: 1, limit: 8 }, sources: [{ slug: 'keep-me' } as never], degraded: null } },
    { kind: 'delta', text: '半截' },
    { kind: 'error', code: 'RATE_LIMIT', message: '上游限流' },
  ])
  assert.equal(s.phase, 'error')
  assert.equal(s.error?.code, 'RATE_LIMIT')
  assert.equal(s.sources.length, 1, 'error 后 sources 必须保留')
  assert.equal(s.sources[0]?.slug, 'keep-me')
})

test('归约：invalid 事件是 no-op（一帧坏数据不能中断整条流）', () => {
  const before = reduce([{ kind: 'delta', text: 'abc' }])
  const after = applyAiStreamEvent(before, { kind: 'invalid', reason: 'x' })
  assert.deepEqual(after, before)
})

test('归约：done.answer 为 null 时回退显示累积文本（不丢已生成内容）', () => {
  const s = reduce([
    { kind: 'delta', text: '只有流式部分' },
    { kind: 'done', payload: { answer: null, answerFormat: 'plain', usage: null, partial: true, elapsedMs: 3 } },
  ])
  const v = visibleAnswer(s)
  assert.equal(v.text, '只有流式部分')
  assert.equal(v.authoritative, false, '回退到累积文本时不是权威值')
})

test('归约：本地失败（网络中断）也落在同一套状态，且保留 sources', () => {
  const s = applyLocalFailure(
    reduce([{ kind: 'status', payload: { mode: 'rag', retrieval: { mode: 'fts', total: 1, limit: 8 }, sources: [{ slug: 's' } as never], degraded: null } }]),
    'stream_failed',
    '网络中断',
  )
  assert.equal(s.phase, 'error')
  assert.equal(s.error?.code, 'stream_failed')
  assert.equal(s.sources.length, 1)
})

test('markAiStreamStarted：提交瞬间即进入 streaming（UI 不必等首字节）', () => {
  const s = markAiStreamStarted(initialAiStreamState())
  assert.equal(s.phase, 'streaming')
  assert.equal(s.mode, null)
  assert.deepEqual(s.sources, [])
})

test('端到端（纯逻辑）：完整字节流 → 最终状态与渲染选择', () => {
  const all = new Uint8Array([
    ...statusFrame(),
    ...frameBytes('delta', { text: '根据资料，' }),
    ...frameBytes('delta', { text: '答案是 42。' }),
    ...frameBytes('done', { answer: '根据资料，答案是 42。', answerFormat: 'markdown', usage: null, partial: false, elapsedMs: 12 }),
  ])
  const decoder = createAiStreamDecoder()
  const events = [...sliceBytes(all, 3).flatMap((b) => decoder.push(b)), ...decoder.flush()]
  const s = reduce(events)
  assert.equal(s.phase, 'done')
  assert.equal(s.mode, 'rag')
  assert.equal(s.sources.length, 1)
  const v = visibleAnswer(s)
  assert.equal(v.text, '根据资料，答案是 42。')
  assert.equal(v.format, 'markdown', 'done 之后应按 answerFormat 走 mdToHtml 消毒')
  assert.equal(s.elapsedMs, 12)
})
