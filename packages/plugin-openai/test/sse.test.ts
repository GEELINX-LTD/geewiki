/**
 * SSE 切帧的纯逻辑测试（无网络、无 IO）。
 *
 * 这一层值得单独测，理由是它是"整条流上最容易被上游的不守规矩搞坏"的地方：
 * 多行 data 拼接、`\r\n`、注释/心跳行、非 `data:` 字段、以及跨 TCP 分片被切断的帧
 * （含跨分片的多字节 UTF-8 字符）。上游这些形态都会真实出现，且一旦处理错，
 * 症状是"回答缺字/串行"而非报错——属于最难定位的那类缺陷。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDoneSentinel, parseSseData } from '../src/sse.js'

/** 把若干字符串片段当作字节流喂进去（可精确控制分片边界） */
async function* bytes(...chunks: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const chunk of chunks) yield encoder.encode(chunk)
}

async function collect(...chunks: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const data of parseSseData(bytes(...chunks))) out.push(data)
  return out
}

test('SSE：基本多帧按空行分隔', async () => {
  assert.deepEqual(await collect('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}'])
})

test('SSE：多行 data 按规范以 \\n 拼接为一帧', async () => {
  // 规范要求：同一事件内的多个 data: 行用 \n 连接后再交给消费方。
  // 写错的表现是把它们当成两帧，于是 JSON 被截断 —— 这是各家 SDK 最常见的 SSE 缺陷。
  assert.deepEqual(await collect('data: line1\ndata: line2\n\n'), ['line1\nline2'])
})

test('SSE：忽略注释/心跳行与非 data 字段', async () => {
  assert.deepEqual(
    await collect(': keep-alive\nevent: message\nid: 42\nretry: 100\ndata: {"ok":true}\n\n'),
    ['{"ok":true}'],
  )
})

test('SSE：容忍 CRLF 行尾', async () => {
  assert.deepEqual(await collect('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'), ['{"a":1}', '{"b":2}'])
})

test('SSE：data: 后仅去掉一个前导空格（多出的空格属载荷）', async () => {
  assert.deepEqual(await collect('data:  two-spaces\n\n'), [' two-spaces'])
})

test('SSE：帧被 TCP 分片切断仍能正确重组', async () => {
  // 逐字符喂入，覆盖所有可能的切分点
  assert.deepEqual(await collect('da', 'ta: {"a"', ':1}\n', '\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}'])
})

test('SSE：跨分片的多字节 UTF-8 字符不被破坏（TextDecoder stream 模式）', async () => {
  const encoder = new TextEncoder()
  const frame = encoder.encode('data: {"t":"检索增强"}\n\n')
  // 故意在"检"字的 3 个字节中间切开
  const parts = [frame.slice(0, 12), frame.slice(12)]
  async function* piecewise(): AsyncGenerator<Uint8Array> {
    for (const p of parts) yield p
  }
  const out: string[] = []
  for await (const data of parseSseData(piecewise())) out.push(data)
  assert.deepEqual(out, ['{"t":"检索增强"}'])
  assert.equal(JSON.parse(out[0] ?? '{}')['t'], '检索增强', '多字节字符不得被分片破坏')
})

test('SSE：收尾时 flush 没有以换行结尾的残留帧', async () => {
  // 上游在最后一帧后直接关闭连接（没有尾随空行）也要能拿到内容
  assert.deepEqual(await collect('data: {"a":1}\n\ndata: {"b":2}'), ['{"a":1}', '{"b":2}'])
})

test('SSE：`data:` 无值产出空载荷，由上层当坏帧忽略（本层不抛错）', async () => {
  // 如实记录本层行为：`data:` 单独一行是一个"合法的空载荷帧"，本层照常产出。
  // 它不会造成缺陷——上层对空串 JSON.parse 失败即忽略（见 provider 的 safeParseJson），
  // 这正是"坏帧不中断整条流"的一部分。这里钉住它，避免将来有人误以为本层会吞帧。
  assert.deepEqual(await collect('data:\n\ndata: x\n\n'), ['', 'x'])
})

test('SSE：坏 JSON 不属于本层职责，切帧照常（解析由上层忽略单帧）', async () => {
  assert.deepEqual(await collect('data: {not json\n\ndata: {"ok":1}\n\n'), ['{not json', '{"ok":1}'])
})

test('isDoneSentinel：识别 [DONE] 且容忍空白', async () => {
  assert.equal(isDoneSentinel('[DONE]'), true)
  assert.equal(isDoneSentinel('  [DONE]  '), true)
  assert.equal(isDoneSentinel('[done]'), false, '大小写敏感：规范里就是大写')
  assert.equal(isDoneSentinel('{"a":1}'), false)
  assert.equal(isDoneSentinel(''), false)
})
