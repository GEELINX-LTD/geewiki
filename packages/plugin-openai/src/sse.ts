/**
 * Server-Sent Events 帧解析（纯逻辑，无 IO，便于单测）。
 *
 * 为什么手写而不用库：本仓库硬约束是**零新增依赖**，而 SSE 的帧语法小到可以完整实现：
 * 事件以空行分隔，`data:` 行按出现顺序用 `\n` 拼接（**多行 data 要拼接**，这是规范要求，
 * 也是各家 SDK 最常写错的地方）。
 *
 * 健壮性要求（上游不总是守规矩，一个坏帧不能毁掉整条流）：
 * 1. 忽略注释/心跳行（以 `:` 开头）——不少网关用它做 keep-alive；
 * 2. 忽略非 `data:` 字段（`event:` / `id:` / `retry:`）——本用例只消费正文增量；
 * 3. **无法解析的帧由调用方忽略**（本模块只负责切帧，不做 JSON 解析，故天然不会因坏 JSON 抛错）；
 * 4. 容忍 `\r\n` 与 `\n` 两种行尾；
 * 5. 处理"最后一行没有换行符就结束"的截断情况（收尾时 flush 解码器与残留缓冲）。
 */

/** 把字节流切成一段段 `data` 载荷（不含 `data:` 前缀，多行已按规范拼接） */
export async function* parseSseData(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  /** 收下一行：空行结束当前帧；`data:` 累积；其余忽略 */
  function* handleLine(rawLine: string): Generator<string> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (dataLines.length > 0) {
        yield dataLines.join('\n')
        dataLines = []
      }
      return
    }
    if (line.startsWith(':')) return // 注释 / 心跳
    if (!line.startsWith('data:')) return // event: / id: / retry: 等
    // 规范：`data:` 后若紧跟一个空格则去掉该空格（仅一个）
    let value = line.slice('data:'.length)
    if (value.startsWith(' ')) value = value.slice(1)
    dataLines.push(value)
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      yield* handleLine(line)
    }
  }

  // 收尾：flush 解码器（处理跨 chunk 的多字节字符），再把没有换行符的残留当最后一行
  buffer += decoder.decode()
  if (buffer !== '') yield* handleLine(buffer)
  if (dataLines.length > 0) {
    yield dataLines.join('\n')
    dataLines = []
  }
}

/** 判断是否为流结束标记（OpenAI 兼容端点用 `data: [DONE]`） */
export function isDoneSentinel(data: string): boolean {
  return data.trim() === '[DONE]'
}
