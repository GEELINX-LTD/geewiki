/**
 * `/api/ai/stream` 的**增量解析与状态归约**——全部是不接触 DOM 的纯逻辑，便于 node 单测。
 *
 * 为什么单独抽一个模块：流式渲染最容易出错的不是 UI，而是**字节层**与**帧边界**：
 * 1. **多字节安全**：`TextDecoder` 必须用 `{ stream: true }` 跨 chunk 解码，否则一个中文
 *    （3 字节）或 emoji（4 字节，代理对）被 TCP/HTTP chunk 边界切断时会解出 `U+FFFD`。
 *    这类 bug 在本地小数据量下常常不复现，故这里把「喂字节 → 出事件」做成纯函数并用单测钉住。
 * 2. **帧边界**：一帧 `event: x\ndata: {...}\n\n` 可能被切成任意多段到达，解析器必须自带缓冲，
 *    按**空行**分帧（`\n\n` / `\r\n\r\n` 都要认）。
 * 3. **`done` 的权威性**：`done.answer` 是最终文本，必须**覆盖**流式累积值（否则重连/重放场景会
 *    出现丢字或重复）。
 *
 * 契约（与后端 @geewiki/ai 的 `/api/ai/stream` 定稿一致）：
 * - 首帧必为 `status`；`delta` 可 0..n 个；末帧**恰一个** `done` 或 `error`。
 * - `status.data` = `{ mode, retrieval, sources, degraded }`
 * - `delta.data`  = `{ text }`
 * - `done.data`   = `{ answer, answerFormat, usage, partial, elapsedMs }`
 * - `error.data`  = `{ code, message }`
 */
import type { AskMode, AskSource, Degraded, SearchMode } from '../api'

/* ------------------------------ SSE 分帧 ------------------------------ */

export interface SseFrame {
  /** 事件名（缺省为 `message`，与 SSE 规范一致） */
  event: string
  /** 该帧 `data:` 行的内容；多行按规范用 `\n` 连接 */
  data: string
}

/**
 * 增量 SSE 解析器：`push()` 喂**文本**（可任意切分），返回本次能完整解析出的帧。
 *
 * 只实现本项目用到的字段（`event` / `data`），忽略 `id` / `retry` 与 `:` 开头的注释行。
 */
export function createSseParser(): { push(text: string): SseFrame[]; flush(): SseFrame[] } {
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []

  const takeFrame = (): SseFrame | null => {
    // 无 data 行的事件（例如只有注释或 event: 心跳）不作为帧下发——本项目所有真实帧都带 data
    if (dataLines.length === 0) {
      eventName = ''
      return null
    }
    const frame: SseFrame = { event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') }
    eventName = ''
    dataLines = []
    return frame
  }

  const consumeLines = (text: string, final: boolean): SseFrame[] => {
    const out: SseFrame[] = []
    // 逐行消费；最后一段若没有换行结尾则留在缓冲里等下一个 chunk（除非 final）
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) break
      let line = text.slice(start, nl)
      start = nl + 1
      if (line.endsWith('\r')) line = line.slice(0, -1) // CRLF
      if (line === '') {
        const frame = takeFrame()
        if (frame) out.push(frame)
        continue
      }
      if (line.startsWith(':')) continue // 注释行
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1) // 规范：冒号后一个空格可选
      if (field === 'event') eventName = value
      else if (field === 'data') dataLines.push(value)
      // id / retry / 其它字段：本项目不使用，忽略
    }
    const rest = text.slice(start)
    if (final && rest !== '') {
      // 收尾宽容策略：按规范，未以空行结束的残帧应当丢弃；但**丢掉 `done` 的代价更大**
      // （UI 会永远停在"生成中"）。故这里把残留内容也当作一行处理，再由上层的 JSON 校验
      // 兜住半截数据（解析失败 → invalid → 忽略）。
      let line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
      if (line !== '' && !line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') eventName = value
        else if (field === 'data') dataLines.push(value)
      }
      const frame = takeFrame()
      if (frame) out.push(frame)
    }
    return out
  }

  return {
    push(text: string): SseFrame[] {
      buffer += text
      const out = consumeLines(buffer, false)
      // consumeLines 用 indexOf 已消费到最后一行开头；把剩余（不完整行）留在缓冲
      const lastNl = buffer.lastIndexOf('\n')
      buffer = lastNl === -1 ? buffer : buffer.slice(lastNl + 1)
      return out
    },
    flush(): SseFrame[] {
      const out = consumeLines(buffer, true)
      buffer = ''
      return out
    },
  }
}

/* --------------------------- 字节 → 事件 --------------------------- */

/** 契约里的事件载荷 */
export interface AiStatusPayload {
  mode: AskMode
  retrieval: { mode: SearchMode; total: number; limit: number }
  sources: AskSource[]
  degraded: Degraded | null
}

export interface AiDonePayload {
  answer: string | null
  answerFormat: 'markdown' | 'plain'
  usage: unknown
  partial: boolean
  elapsedMs: number
}

export type AiStreamEvent =
  | { kind: 'status'; payload: AiStatusPayload }
  | { kind: 'delta'; text: string }
  | { kind: 'done'; payload: AiDonePayload }
  | { kind: 'error'; code: string; message: string }
  /** 未知事件名 / JSON 不合法 / 形状不符：调用方**必须忽略**（不能让一帧坏数据中断整条流） */
  | { kind: 'invalid'; reason: string }

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 把一帧映射为强类型事件；任何不合形状的输入都降级为 `invalid` 而不是抛错 */
export function parseAiStreamFrame(frame: SseFrame): AiStreamEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch (err) {
    return { kind: 'invalid', reason: 'JSON 解析失败' }
  }
  const obj = asRecord(parsed)
  if (!obj) return { kind: 'invalid', reason: '载荷不是对象' }

  if (frame.event === 'delta') {
    const text = obj['text']
    return typeof text === 'string' ? { kind: 'delta', text } : { kind: 'invalid', reason: 'delta.text 不是字符串' }
  }
  if (frame.event === 'status') {
    const mode = obj['mode']
    if (mode !== 'retrieval-only' && mode !== 'rag' && mode !== 'rag-partial') {
      return { kind: 'invalid', reason: 'status.mode 非法' }
    }
    const retrieval = asRecord(obj['retrieval'])
    const sources = obj['sources']
    return {
      kind: 'status',
      payload: {
        mode,
        retrieval: {
          mode: (retrieval?.['mode'] === 'like' ? 'like' : 'fts') as SearchMode,
          total: typeof retrieval?.['total'] === 'number' ? (retrieval['total'] as number) : 0,
          limit: typeof retrieval?.['limit'] === 'number' ? (retrieval['limit'] as number) : 0,
        },
        sources: Array.isArray(sources) ? (sources as AskSource[]) : [],
        degraded: (asRecord(obj['degraded']) as Degraded | null) ?? null,
      },
    }
  }
  if (frame.event === 'done') {
    const answer = obj['answer']
    return {
      kind: 'done',
      payload: {
        answer: typeof answer === 'string' ? answer : null,
        answerFormat: obj['answerFormat'] === 'markdown' ? 'markdown' : 'plain',
        usage: obj['usage'] ?? null,
        partial: obj['partial'] === true,
        elapsedMs: typeof obj['elapsedMs'] === 'number' ? (obj['elapsedMs'] as number) : 0,
      },
    }
  }
  if (frame.event === 'error') {
    return {
      kind: 'error',
      code: typeof obj['code'] === 'string' ? (obj['code'] as string) : 'unknown',
      message: typeof obj['message'] === 'string' ? (obj['message'] as string) : '生成失败',
    }
  }
  return { kind: 'invalid', reason: `未知事件名：${frame.event}` }
}

/**
 * 字节流读取器：**自己持有 `TextDecoder`（`{ stream: true }`）**，保证多字节字符被 chunk
 * 边界切断时不会解成乱码。用法：把每个 `reader.read()` 的 `value` 喂给 `push`，
 * 流结束后（可选）调 `flush()` 取回尾部残留帧。
 */
export function createAiStreamDecoder(): {
  push(bytes: Uint8Array): AiStreamEvent[]
  flush(): AiStreamEvent[]
} {
  const decoder = new TextDecoder('utf-8')
  const parser = createSseParser()
  return {
    push(bytes: Uint8Array): AiStreamEvent[] {
      const text = decoder.decode(bytes, { stream: true })
      return parser.push(text).map(parseAiStreamFrame)
    },
    flush(): AiStreamEvent[] {
      // 先补齐解码器内部可能残留的半个字符，再 flush 解析器
      const tail = decoder.decode()
      const frames = [...parser.push(tail), ...parser.flush()]
      return frames.map(parseAiStreamFrame)
    },
  }
}

/* --------------------------- 状态归约 --------------------------- */

export interface AiStreamState {
  /** idle=还没提交；streaming=已开始收流；done=收到 done；error=收到 error 帧或本地失败 */
  phase: 'idle' | 'streaming' | 'done' | 'error'
  mode: AskMode | null
  retrieval: AiStatusPayload['retrieval'] | null
  sources: AskSource[]
  degraded: Degraded | null
  /** 流式累积文本（**纯文本渲染**，避免每帧跑 markdown 消毒） */
  streamText: string
  /** 收到的 `delta` 帧数。用于诚实区分"模型真的产出了内容"与"只拿到抽取式摘要" */
  deltaCount: number
  /** `done.answer` —— 最终权威文本，非 null 时优先于 streamText */
  answer: string | null
  answerFormat: 'markdown' | 'plain'
  usage: unknown
  partial: boolean
  elapsedMs: number
  /** 流内 `error` 帧或本地异常 */
  error: { code: string; message: string } | null
}

export function initialAiStreamState(): AiStreamState {
  return {
    phase: 'idle',
    mode: null,
    retrieval: null,
    sources: [],
    degraded: null,
    streamText: '',
    deltaCount: 0,
    answer: null,
    answerFormat: 'plain',
    usage: null,
    partial: false,
    elapsedMs: 0,
    error: null,
  }
}

/** 标记"已提交、等待首帧"：让 UI 立刻进入生成中态，而不是等第一个字节 */
export function markAiStreamStarted(state: AiStreamState): AiStreamState {
  return { ...initialAiStreamState(), phase: 'streaming' }
}

/**
 * 归约一帧事件。要点：
 * - `status` **立刻**给出 sources/degraded（用户先看到"检索到了什么"，再等 token）；
 * - `delta` 追加；
 * - `done` 用权威文本覆盖（`answer` 优先于 `streamText`）；
 * - `error` **保留已渲染的 sources**（不让用户丢掉检索结果）；
 * - `invalid` 忽略。
 */
export function applyAiStreamEvent(state: AiStreamState, ev: AiStreamEvent): AiStreamState {
  switch (ev.kind) {
    case 'status':
      return {
        ...state,
        phase: 'streaming',
        mode: ev.payload.mode,
        retrieval: ev.payload.retrieval,
        sources: ev.payload.sources,
        degraded: ev.payload.degraded,
      }
    case 'delta':
      return { ...state, phase: 'streaming', streamText: state.streamText + ev.text, deltaCount: state.deltaCount + 1 }
    case 'done':
      return {
        ...state,
        phase: 'done',
        answer: ev.payload.answer,
        answerFormat: ev.payload.answerFormat,
        usage: ev.payload.usage,
        partial: ev.payload.partial,
        elapsedMs: ev.payload.elapsedMs,
        error: null,
      }
    case 'error':
      return { ...state, phase: 'error', error: { code: ev.code, message: ev.message } }
    default:
      return state
  }
}

/** 本地异常（网络中断/非 2xx/未捕获异常）也要落到同一套状态里 */
export function applyLocalFailure(state: AiStreamState, code: string, message: string): AiStreamState {
  return { ...state, phase: 'error', error: { code, message } }
}

/** 该渲染哪段答案：`done.answer` 优先（权威），否则流式累积 */
export function visibleAnswer(state: AiStreamState): { text: string; format: 'markdown' | 'plain'; authoritative: boolean } {
  if (state.answer !== null) return { text: state.answer, format: state.answerFormat, authoritative: true }
  return { text: state.streamText, format: 'plain', authoritative: false }
}
