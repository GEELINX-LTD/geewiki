/**
 * 回合流的帧契约（`/api/ai/turn` 的 SSE 载荷）。
 *
 * ## 帧的形状：`status → delta* → done | error`
 * 与 `@geewiki/ai-qa` 的问答流**共用同一套平台原语**（`@geewiki/core` 的 `sse.ts`：
 * 帧编码、终止闩锁、写前存活检查、空闲/硬超时看门狗、帧序列校验）。
 * 这里只定义**本插件自己的载荷形状**——原语一行都不重写。
 *
 * ## 一条实现期的改写：工具调用不单独占一个帧名
 * 设计文档 §3.3 的草图写的是 `status → delta* → tool-calls | done | error`，
 * 把 `tool-calls` 和 `done` 并列成两种终结帧。实现时改成**只用 `done` 一种终结帧**，
 * 工具调用装在 `done.toolCalls` 里，理由是平台层的 `isTerminalEvent()` 只认
 * `done` / `error` 两个名字，而那条判据被两个插件共用：
 *
 * - 若给 core 加第三个终结事件，`validateFrameSequence()` 就会对所有消费者放宽
 *   （问答流也会被允许以一个它永远不会发的帧收尾），平台不变量为了一个消费方的
 *   便利而变弱；
 * - 而"这一轮结束了"本来就是**同一件事**——结束时顺手带上"我为什么结束、
 *   还需要谁做什么"才是诚实的形状。分成两种帧反而要求客户端在两条路径上
 *   各写一遍收尾逻辑。
 *
 * 于是客户端的分支落在 `done.finishReason` 上，而不是落在帧名上。
 *
 * ## `done.messages` 是**权威转录**
 * 服务端不持有跨回合状态，所以每一回合都必须把它这一轮产生的全部消息
 * （助手带工具调用的消息 + 服务端执行掉的工具结果）**还给客户端**，
 * 客户端下一次原样带上。客户端不需要自己拼——自己拼就是两份实现，会漂。
 */
import type { AiToolGrounding } from '@geewiki/ai-tools'
import type { LlmToolCall, LlmUsage } from '@geewiki/llm'
import type { TurnMessage } from './types.js'

/*
 * 原语与常量**从平台层再导出**，这样本插件的 UI bundle 与后端都只 import 这一个模块
 * （UI 侧不能 import `@geewiki/core` 的顶层：那里 `import 'node:fs'`）。
 */
export {
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
  type FrameWriter,
  type SseFrame,
  type Watchdog,
} from '@geewiki/core'

import {
  SSE_EVENT_DELTA,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  SSE_EVENT_STATUS,
} from '@geewiki/core'

/**
 * 工具活动帧的事件名。
 *
 * **刻意不放进 `@geewiki/core`**：平台层的 `isTerminalEvent()` 只认 `done` / `error`，
 * 而 `validateFrameSequence()` 对"首帧之后、终止帧之前"的中间帧**不作名字约束**——
 * 所以一个插件私有的中间帧不需要、也不应该去动平台的事件名集合。
 * 把它加进 core 会让问答流也被允许发一个它永远不会发的帧名，白白放宽不变量。
 */
export const SSE_EVENT_TOOL = 'tool'

/** 工具执行发生在哪一侧。与 `@geewiki/ai-tools` 的 `AiToolSide` 同值（此处避免为一个联合引入依赖） */
export type TurnToolSide = 'server' | 'client'

/**
 * 一次工具调用在**界面**上的记录。
 *
 * 刻意与 `TurnMessage` 分开：`TurnMessage` 是**给模型的**（必须严格符合上游的消息协议），
 * 这个是**给人的**（"正在查摘要…"要有一句能读的摘要）。两者混用会逼着其中一方将就另一方。
 * `summary` 是服务端算好的短句，**不进模型上下文**。
 */
export interface ToolActivity {
  readonly id: string
  readonly name: string
  readonly side: TurnToolSide
  /** 参数的原样 JSON 文本（可能很长，界面自行折叠） */
  readonly arguments: string
  readonly ok: boolean
  readonly summary: string
}

/**
 * 终结原因。**四档各有明确含义**，界面据此决定显示什么：
 * - `stop`：模型正常答完（`answer` 非空）；
 * - `tool_calls`：模型请求了**客户端**工具，服务端停下来等客户端执行（`toolCalls` 非空）；
 * - `length`：撞上输出长度上限，`answer` 可能是半句话 ⇒ `partial: true`；
 * - `rounds`：撞上 `maxRounds`（模型一直在调工具但没收口）⇒ `partial: true`。
 *
 * 后两档**必须**让用户看见：它们是"这次没能好好回答"的两种真实情形，
 * 用一句正常回答的语气糊过去，用户无法分辨。
 */
export type TurnFinishReason = 'stop' | 'tool_calls' | 'length' | 'rounds'

/** `status`：首帧，必为第一帧。它描述"这一轮拿到的工具表"，而不是结果 */
export interface TurnStatusEvent {
  readonly event: typeof SSE_EVENT_STATUS
  readonly data: {
    readonly round: number
    /** 本回合真正交给模型的工具名（收窄后的交集）。界面据此告诉用户"AI 现在能做哪些事" */
    readonly tools: readonly string[]
    /** 客户端声明的客户端工具里，有多少被采纳（收窄是安全属性，值得可见） */
    readonly clientToolsAccepted: readonly string[]
  }
}

export interface TurnDeltaEvent {
  readonly event: typeof SSE_EVENT_DELTA
  readonly data: { readonly text: string }
}

/**
 * 工具活动帧（**中间帧**，可出现在 `status` 之后、终止帧之前的任意位置）。
 *
 * 它存在的唯一理由是**延迟可见性**：一次工具调用可能跑几百毫秒，
 * 期间模型一个字都没吐。没有这条帧，界面就只能干等着，用户不知道它在干什么、
 * 也不知道它是不是卡住了。`done.toolResults` 是同一批活动的**最终**版本
 * （权威），这条只是过程中的快照。
 */
export interface TurnToolEvent {
  readonly event: typeof SSE_EVENT_TOOL
  readonly data: {
    readonly id: string
    readonly name: string
    readonly side: TurnToolSide
    /** 参数的原样 JSON 文本 */
    readonly arguments: string
    /** `null` = 正在执行；`true`/`false` = 已结束及其成败 */
    readonly ok: boolean | null
    /** 执行中的说明；`ok === null` 时为空串 */
    readonly summary: string
  }
}

export interface TurnDoneEvent {
  readonly event: typeof SSE_EVENT_DONE
  readonly data: {
    /** 权威转录：客户端下一次原样带上（含服务端已执行的工具结果） */
    readonly messages: readonly TurnMessage[]
    /** 模型的最终答复；`finishReason === 'tool_calls'` 时为 null */
    readonly answer: string | null
    readonly finishReason: TurnFinishReason
    /** 待**客户端**执行的调用；没有则为 null */
    readonly toolCalls: readonly LlmToolCall[] | null
    /**
     * `toolCalls` 里**会改东西**的工具名（服务端按描述符的 `mutating` 算出）。
     *
     * 客户端据此决定"要不要在调用前后各存一份快照用于回退"——判断权在服务端，
     * 因为只有那里有描述符；浏览器手里的名单会在工具改名时静默失效。
     */
    readonly mutatingTools: readonly string[]
    /**
     * 这一回合的回答**有没有知识库依据**（需求 ⑥ / 决策 4 的结构化标记）。
     *
     * 由服务端从工具结果的 `grounding` 算出，**不是**模型的一句自述——
     * 提示层写「请标注这不是知识库内容」不算护栏（模型可以不听），而这条标注正是
     * 用户判断"该不该信这句话"的唯一依据。
     *
     * ⚠️ 客户端必须把**一次提问的多个 HTTP 回合**取或（见 `ui/dockPlan.ts`）：
     * 无状态协议下一次提问可能跨多个回合（客户端工具执行完再发一轮），
     * 而第二个回合的服务端**看不到**第一回合执行过的那些服务端工具。
     */
    readonly grounded: boolean
    /**
     * 本回合声明过的**全部**出处（`'kb'` / `'web'`，去重、字典序）。
     *
     * **可选**，理由与 `grounded` 逐字相同：旧服务端不发它，把它当空数组
     * 会让"依据公开网络"的回答退回按 `grounded=false` 渲染——也就是渲染成
     * 「来自模型自身的知识」，而模型明明给了来源链接。
     *
     * 与 `grounded` 并列而不是取代它：`grounded` 是"有没有知识库依据"这个
     * 沿用已久的判据（界面靠它决定要不要标注），这份清单只回答"标注该怎么说"。
     * 联网搜索这一档单独存在，是因为**它有依据，只是依据不在本知识库里**——
     * 只看布尔的界面只有"有依据/没依据"两条路，两条都会把用户引向误读。
     */
    readonly groundingSources?: readonly AiToolGrounding[]
    /** 本回合服务端已经执行掉的调用（供界面展示，**不影响转录**） */
    readonly toolResults: readonly ToolActivity[]
    readonly usage: LlmUsage | null
    /** 回答是否不完整（`length` / `rounds` 两档为 true） */
    readonly partial: boolean
    /** 本回合实际调用模型的次数 */
    readonly rounds: number
    readonly elapsedMs: number
  }
}

export interface TurnErrorEvent {
  readonly event: typeof SSE_EVENT_ERROR
  readonly data: {
    /** `LlmErrorCode` 或本层的判定码（如 `invalid_tool_call`）；客户端**按 code 分支，不按 message** */
    readonly code: string
    /** 已脱敏的可读说明 */
    readonly message: string
  }
}

export type TurnStreamEvent = TurnStatusEvent | TurnDeltaEvent | TurnToolEvent | TurnDoneEvent | TurnErrorEvent
