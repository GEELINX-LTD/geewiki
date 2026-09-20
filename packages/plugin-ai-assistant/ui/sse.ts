/**
 * 回合流的**客户端解码器**（SSE 帧字节 → 已校验的事件）。
 *
 * ## 为什么校验要做得这么细（服务端明明是我们自己写的）
 * 三条理由，每条都在本仓有先例：
 * 1. **帧来自网络**。中间层（代理、缓冲、网关）能改写或截断它；一个"我们自己的服务端
 *    不会发这种帧"的假设，在部署形态变化的那天就变成一次运行期崩溃。
 * 2. **畸形帧必须降级成 `invalid` 而不是抛错**。抛在 `onmessage` 里会中断整条流的处理，
 *    用户看到的是"回答卡住"，而真正的原因是一条没人认识的控制帧。
 * 3. **字节边界不确定**：一个 chunk 可能切在 `event:` 与 `data:` 之间、切在多字节字符
 *    中间、或一次带来三帧半。解码器必须是**增量**的，且对残帧收尾有明确行为。
 *
 * 与 `packages/plugin-ai-qa/ui/sse.ts` 是**两份**实现（两个插件各自的帧载荷不同），
 * 但解码的骨架刻意一致——它们共用的是同一套线上协议（`@geewiki/core` 的 `sse.ts`）。
 */
import { fromTurnImages, type DockImage } from './imagePlan.js'

export type { DockImage }

/** 工具执行发生在哪一侧 */
export type ToolSide = 'server' | 'client'

/**
 * 依据的出处。与服务端 `@geewiki/ai-tools` 的 `AiToolGrounding` 同值
 * （本地镜像的理由同 {@link ToolSide}：浏览器侧不能 import 那个包的顶层）。
 */
export type GroundingSource = 'kb' | 'web'

/** 一次工具调用在界面上的记录 */
export interface ToolActivityView {
  readonly id: string
  readonly name: string
  readonly side: ToolSide
  readonly arguments: string
  /** `null` = 正在执行 */
  readonly ok: boolean | null
  readonly summary: string
}

export interface TurnToolCallView {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** 往返于客户端与服务端的消息（与服务端 `TurnMessage` 逐字段一致） */
export interface DockMessage {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: string
  /**
   * `role:'user'` 时：随这条消息一起发的图片（多模态）。
   *
   * 服务端把用户那条**连图一起**放进 `done.messages` 回传（转录唯一真源），
   * 这里原样解出来、原样存下、下一轮原样带回。旧服务端不发这个字段 ⇒ 空数组。
   */
  readonly images?: readonly DockImage[]
  readonly toolCalls?: readonly TurnToolCallView[]
  readonly toolCallId?: string
  readonly name?: string
}

export type DockFinishReason = 'stop' | 'tool_calls' | 'length' | 'rounds'

export interface StatusData {
  readonly round: number
  readonly tools: readonly string[]
  readonly clientToolsAccepted: readonly string[]
}
export interface DoneData {
  readonly messages: readonly DockMessage[]
  readonly answer: string | null
  readonly finishReason: DockFinishReason
  readonly toolCalls: readonly TurnToolCallView[] | null
  /** `toolCalls` 里会改东西的那些工具名（服务端按描述符的 `mutating` 算出；旧服务端可能不发） */
  readonly mutatingTools?: readonly string[]
  /**
   * 这一回合的回答有没有知识库依据（需求 ⑥）。
   *
   * **可选**，且缺省语义是"不知道"而**不是** `false`：旧服务端不发这个字段，
   * 把它当 `false` 会让每一条回答都挂上「未使用知识库资料」的标注——
   * 一个恒亮的告警等于没有告警，而它同时还会让真话变得不可信。
   */
  readonly grounded?: boolean
  /**
   * 本回合声明过的**全部**出处（去重、字典序）。**缺省 `[]`**。
   *
   * 本地镜像 `'kb' | 'web'`（浏览器侧不能 import `@geewiki/ai-tools` 的顶层取得
   * `AiToolGrounding`，同 `ToolSide`）。它与服务端 `TurnDoneEvent.data.groundingSources`
   * 是一份事实的两半，由 `test/uiDock.test.ts` 的镜像守卫逐字比对。
   *
   * 为什么不能只读 `grounded`：联网搜索有依据，它不是知识库依据。只看布尔的话，
   * 「依据的是公开网络资料」要么被当成"有依据"（不标注 ⇒ 用户以为话出自本知识库），
   * 要么被当成"没依据"（标注成「来自模型自身的知识」⇒ 把模型给的来源链接说成是它编的）。
   * 两条都是需求 ⑥ 要消灭的误读，故必须按档下传。
   */
  readonly groundingSources: readonly GroundingSource[]
  readonly toolResults: readonly ToolActivityView[]
  readonly usage: { readonly promptTokens?: number; readonly completionTokens?: number } | null
  readonly partial: boolean
  readonly rounds: number
  readonly elapsedMs: number
}

/** 已校验的帧。`invalid` 是一个**正常**结果，不是异常 */
export type TurnEvent =
  | { readonly event: 'status'; readonly data: StatusData }
  | { readonly event: 'delta'; readonly data: { readonly text: string } }
  /**
   * 模型的思考内容增量（推理型模型才有）。
   *
   * 与 `delta` 是**两个事件名**：思考要折起来、正文要摊开，混在一个字段里
   * 就只能靠别的手段猜（而"猜"的那一天正好是模型在正文里写了句"让我想想"）。
   * 它**不进 `DockState.messages`**：`messages` 来自 `done` 帧，是给模型看的历史。
   */
  | { readonly event: 'thinking'; readonly data: { readonly text: string } }
  | { readonly event: 'tool'; readonly data: ToolActivityView }
  | { readonly event: 'done'; readonly data: DoneData }
  | { readonly event: 'error'; readonly data: { readonly code: string; readonly message: string } }
  | { readonly event: 'invalid'; readonly reason: string }

/* ============================== 常量镜像 ============================== */

/**
 * 事件名。**本地镜像**（浏览器侧不能 import `@geewiki/core` 的顶层：那里 `import 'node:fs'`），
 * 由 `test/uiDock.test.ts` 里的源码级守卫与服务端逐字比对——漂移的症状是
 * "服务端发的帧客户端一个都不认识"，而它不会让任何编译失败。
 */
export const EVENT_STATUS = 'status'
export const EVENT_DELTA = 'delta'
/* 思考帧与工具帧一样是**插件私有的中间帧**，不进 `@geewiki/core`（理由见服务端 `SSE_EVENT_TOOL`） */
export const EVENT_THINKING = 'thinking'
export const EVENT_TOOL = 'tool'
export const EVENT_DONE = 'done'
export const EVENT_ERROR = 'error'

/* ============================== 增量解码 ============================== */

export interface TurnDecoder {
  /** 送入一段字节，返回**本次能完整解出**的帧 */
  push(chunk: string): TurnEvent[]
  /** 流结束时收尾：把缓冲里剩下的半帧解出来（可能为空） */
  flush(): TurnEvent[]
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * 解析一个字符串数组字段。**缺省与形状不符都回 `null`**（= "这次没读到这个字段"），
 * 由调用方决定是"不发这个键"（可选字段的正确处置）还是判帧无效。
 *
 * 返回 `[]` 与返回 `null` 是两件事：`[]` 是服务端明确说了"一个都没有"，
 * 而 `null` 是"这次没读到"。把后者当 `[]` 就是上面 `mutatingTools` 那个缺陷的形状。
 */
function parseStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function parseToolCalls(raw: unknown): TurnToolCallView[] | null {
  if (!Array.isArray(raw)) return null
  const out: TurnToolCallView[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const o = item as Record<string, unknown>
    const id = asString(o['id'])
    const name = asString(o['name'])
    const args = asString(o['arguments'])
    if (id === null || id === '' || name === null || name === '' || args === null) return null
    out.push({ id, name, arguments: args })
  }
  return out
}

function parseMessages(raw: unknown): DockMessage[] | null {
  if (!Array.isArray(raw)) return null
  const out: DockMessage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const o = item as Record<string, unknown>
    const role = o['role']
    const content = asString(o['content'])
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null
    if (content === null) return null
    const message: {
      role: 'user' | 'assistant' | 'tool'
      content: string
      images?: DockImage[]
      toolCalls?: TurnToolCallView[]
      toolCallId?: string
      name?: string
    } = { role, content }
    /*
     * 图片**坏一条就整帧判 invalid**（与 `toolCalls` 同口径），而不是"跳过坏的、留好的"：
     * 静默丢一张图的表现是"模型说它看不到图"，而用户明明发出去了——
     * 那正是本仓反复记档的"静默降级"。
     */
    if (o['images'] !== undefined) {
      const images = fromTurnImages(o['images'])
      const raw = o['images']
      if (!Array.isArray(raw) || images.length !== raw.length) return null
      if (images.length > 0) message.images = images
    }
    if (o['toolCalls'] !== undefined) {
      const calls = parseToolCalls(o['toolCalls'])
      if (calls === null) return null
      if (calls.length > 0) message.toolCalls = calls
    }
    const callId = asString(o['toolCallId'])
    if (callId !== null && callId !== '') message.toolCallId = callId
    const name = asString(o['name'])
    if (name !== null && name !== '') message.name = name
    out.push(message)
  }
  return out
}

function parseActivities(raw: unknown): ToolActivityView[] | null {
  if (!Array.isArray(raw)) return null
  const out: ToolActivityView[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const o = item as Record<string, unknown>
    const id = asString(o['id'])
    const name = asString(o['name'])
    if (id === null || name === null) return null
    out.push({
      id,
      name,
      side: o['side'] === 'client' ? 'client' : 'server',
      arguments: asString(o['arguments']) ?? '',
      ok: typeof o['ok'] === 'boolean' ? o['ok'] : null,
      summary: asString(o['summary']) ?? '',
    })
  }
  return out
}

function parseFinishReason(raw: unknown): DockFinishReason | null {
  return raw === 'stop' || raw === 'tool_calls' || raw === 'length' || raw === 'rounds' ? raw : null
}

/**
 * 解析 `groundingSources`。**任何形状不符都回 `[]`，绝不判帧无效**。
 *
 * 三条判据，各自的理由：
 * - 缺省 `[]`：旧服务端不发这个字段，而"这次没读到"必须退化成**不新增信息**，
 *   不能变成"什么都没声明"以外的任何结论（`grounded` 那边同一条理）。
 * - 非数组 / 认不出的取值 ⇒ 整份丢掉回 `[]`：这里采取**全有或全无**而不是逐项过滤，
 *   与同文件的 `parseStringList` / `parseToolCalls` 一致。一半可信的清单更坏——
 *   例如 `['web','未来档']` 过滤后只剩 `'web'`，界面会照它渲染「依据的是公开网络资料」，
 *   而服务端说的其实是两档混合，那句标注就成了一句没根据的话。
 * - 不判 `invalid`：一条认不出的可选字段不该把整帧 `done` 丢掉。丢了这一帧，
 *   客户端拿不到权威转录，用户看到的是"回答没收完"——那比少一条标注严重得多。
 */
function parseGroundingSources(raw: unknown): GroundingSource[] {
  if (!Array.isArray(raw)) return []
  const out: GroundingSource[] = []
  for (const item of raw) {
    if (item !== 'kb' && item !== 'web') return []
    out.push(item)
  }
  return out
}

/**
 * 校验一帧。**任何形状不符都返回 `invalid`**，绝不抛——一条没人认识的帧不该
 * 把整条流带崩（用户会以为"回答卡住了"，而真正的原因可能只是一条多余的注释帧）。
 */
export function parseTurnEvent(event: string, raw: string): TurnEvent {
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    return { event: 'invalid', reason: `data 不是合法 JSON（event=${event}）` }
  }
  if (typeof data !== 'object' || data === null) {
    return { event: 'invalid', reason: `data 不是对象（event=${event}）` }
  }
  const o = data as Record<string, unknown>

  if (event === EVENT_DELTA) {
    const text = asString(o['text'])
    return text === null ? { event: 'invalid', reason: 'delta 缺 text' } : { event: 'delta', data: { text } }
  }

  // 思考帧与 delta **同形同校验**：缺 text 即无效。空串是合法增量（上游偶尔发一个空片），
  // 不在这里丢——丢与不丢对界面没有区别，少一条分支就少一处漂移。
  if (event === EVENT_THINKING) {
    const text = asString(o['text'])
    return text === null ? { event: 'invalid', reason: 'thinking 缺 text' } : { event: 'thinking', data: { text } }
  }

  if (event === EVENT_STATUS) {
    const tools = o['tools']
    if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) {
      // `tools` 缺失不至于是致命的：它只用来展示"AI 能做哪些事"。给空数组而不是判整帧无效
      return {
        event: 'status',
        data: {
          round: typeof o['round'] === 'number' ? o['round'] : 0,
          tools: [],
          clientToolsAccepted: [],
        },
      }
    }
    const accepted = o['clientToolsAccepted']
    return {
      event: 'status',
      data: {
        round: typeof o['round'] === 'number' ? o['round'] : 0,
        tools: tools as string[],
        clientToolsAccepted: Array.isArray(accepted) ? accepted.filter((x): x is string => typeof x === 'string') : [],
      },
    }
  }

  if (event === EVENT_TOOL) {
    const id = asString(o['id'])
    const name = asString(o['name'])
    if (id === null || name === null) return { event: 'invalid', reason: 'tool 帧缺 id 或 name' }
    return {
      event: 'tool',
      data: {
        id,
        name,
        side: o['side'] === 'client' ? 'client' : 'server',
        arguments: asString(o['arguments']) ?? '',
        ok: typeof o['ok'] === 'boolean' ? o['ok'] : null,
        summary: asString(o['summary']) ?? '',
      },
    }
  }

  if (event === EVENT_ERROR) {
    const code = asString(o['code'])
    return code === null
      ? { event: 'invalid', reason: 'error 帧缺 code' }
      : { event: 'error', data: { code, message: asString(o['message']) ?? '' } }
  }

  if (event === EVENT_DONE) {
    const messages = parseMessages(o['messages'])
    const finishReason = parseFinishReason(o['finishReason'])
    if (messages === null) return { event: 'invalid', reason: 'done 帧的 messages 形状不符' }
    if (finishReason === null) return { event: 'invalid', reason: 'done 帧的 finishReason 不是已知取值' }
    const calls = o['toolCalls'] === null || o['toolCalls'] === undefined ? [] : parseToolCalls(o['toolCalls'])
    if (calls === null) return { event: 'invalid', reason: 'done 帧的 toolCalls 形状不符' }
    const activities = parseActivities(o['toolResults']) ?? []
    /*
     * ⚠️ 这里曾经漏掉了 `mutatingTools`（P5 修）。
     *
     * 字段在接口上声明了、服务端也一直在发，但**解码这一层没读它**——
     * 于是 `DoneData.mutatingTools` 恒为 `undefined`，而它的消费者
     * （`ui/index.tsx` 的 `mutatingCalls`）在 `undefined` 时的语义是"一个写工具都没有"，
     * 于是 `recordClientMutation` 一次都没被调用过：**编辑框的改动从来没进过日志**，
     * 也就从来不可回退。整条链路不报错、类型全对，只有端到端点一次「回退」才会发现。
     *
     * 这也是为什么本文件末尾那条"服务端 `TurnDoneEvent` 的字段与这里逐字对齐"的
     * 源码守卫必须覆盖**可选字段**：漏读一个必填字段，消费者会拿到 `undefined` 并当场炸；
     * 漏读一个可选字段，则什么都不会发生。
     */
    const mutatingTools = parseStringList(o['mutatingTools'])
    return {
      event: 'done',
      data: {
        messages,
        answer: asString(o['answer']),
        finishReason,
        toolCalls: calls.length > 0 ? calls : null,
        ...(mutatingTools === null ? {} : { mutatingTools }),
        /*
         * `grounded` 缺省**不定为 false**：旧服务端不发它，把"不知道"读成"没有依据"
         * 会让每一条回答都挂上标注（见 `DoneData.grounded` 的注释）。
         */
        ...(typeof o['grounded'] === 'boolean' ? { grounded: o['grounded'] } : {}),
        /*
         * `groundingSources` 与 `grounded` 相反：**恒有键**，缺省 `[]`。
         * 它只用来选标注的措辞，而"没读到"与"服务端说了一档都没有"在措辞上没有区别
         * （都要落到"按 grounded 判"），所以不需要留住"有没有这个键"。
         */
        groundingSources: parseGroundingSources(o['groundingSources']),
        toolResults: activities,
        usage: (o['usage'] as DoneData['usage']) ?? null,
        partial: o['partial'] === true,
        rounds: typeof o['rounds'] === 'number' ? o['rounds'] : 0,
        elapsedMs: typeof o['elapsedMs'] === 'number' ? o['elapsedMs'] : 0,
      },
    }
  }

  return { event: 'invalid', reason: `未知事件名：${event}` }
}

/** 解一块 SSE 文本块（`event:` 行 + 一到多行 `data:`） */
function decodeBlock(block: string): TurnEvent | null {
  const lines = block.split('\n').filter((l) => l !== '')
  if (lines.length === 0) return null
  const eventLine = lines.find((l) => l.startsWith('event:'))
  if (eventLine === undefined) return null
  const event = eventLine.slice('event:'.length).trim()
  const data = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice('data:'.length).replace(/^ /, ''))
    .join('\n')
  return parseTurnEvent(event, data)
}

/**
 * 增量解码器。
 *
 * 缓冲策略：只把**最后一个** `\n\n` 之前的部分当完整帧处理，其余留在缓冲里等下一块。
 * 这样切在多字节字符中间也不会出错（不完整的块根本不会被送去 `JSON.parse`）。
 */
export function createTurnDecoder(): TurnDecoder {
  let buffer = ''
  const take = (): TurnEvent[] => {
    const events: TurnEvent[] = []
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const ev = decodeBlock(block)
      if (ev !== null) events.push(ev)
      index = buffer.indexOf('\n\n')
    }
    return events
  }
  return {
    push(chunk: string): TurnEvent[] {
      // 兼容 CRLF：某些中间层会把 \n 改写成 \r\n
      buffer += chunk.replace(/\r\n/g, '\n')
      return take()
    },
    flush(): TurnEvent[] {
      const events = take()
      const rest = buffer.trim()
      buffer = ''
      if (rest !== '') {
        const ev = decodeBlock(rest)
        if (ev !== null) events.push(ev)
      }
      return events
    },
  }
}
