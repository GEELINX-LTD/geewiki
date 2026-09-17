/**
 * 输入条的**纯逻辑**：流式状态机、回合请求的组装、本地会话存储。
 *
 * 与 React 分开，是为了让它们能被**直接测**：本仓的插件界面测试都在"不起浏览器"的层面
 * （`plugin-ai-qa/test/uiPanel.test.ts` 是同一形态）。要在这里验证的三类东西，
 * 恰好都是在真浏览器里"常常正好不复现"的：
 * 1. **帧序列的边界情形**（残帧、畸形帧、终止后再来一帧）；
 * 2. **本地会话的裁剪与隔离**（近 10 段、按用户分键、损坏数据不炸）；
 * 3. **服务端→客户端交接**（`tool_calls` 之后要补哪些消息、补漏了会怎样）。
 */
import {
  createTurnDecoder,
  type DockFinishReason,
  type DoneData,
  type DockMessage,
  type ToolActivityView,
  type TurnEvent,
  type TurnToolCallView,
} from './sse.js'

/* ============================== 端点常量 ============================== */

/**
 * 端点路径。**本地镜像**（不能 import 服务端包：那里依赖 cordis 与 `node:http`），
 * 由 `test/uiDock.test.ts` 的源码级守卫与服务端逐字比对。
 */
export const TURN_PATH = '/api/ai/turn'
export const CAPABILITIES_PATH = '/api/ai/assistant/capabilities'

/**
 * 客户端最多连续接几轮"模型要调客户端工具"。
 *
 * 服务端有自己的 `maxRounds`（它管**服务端**能跑几轮）；这一条管**客户端**愿意陪着跑几轮。
 * 两者不是重复：服务端每一轮都是一次独立的 HTTP 回合，客户端这里的计数是唯一能看到
 * "整段对话已经来回几次"的地方。没有它的话，一个持续请求客户端工具的模型会让浏览器
 * 无限发请求——而每一轮都真的花钱。
 */
export const MAX_CLIENT_ROUNDS = 8

/* ============================== 流式状态机 ============================== */

export interface DockState {
  /** **权威转录**：来自 `done.messages`（服务端是唯一真源，客户端不自己拼） */
  readonly messages: readonly DockMessage[]
  /** 是否仍在生成（含"停下来等客户端执行工具"的那一段） */
  readonly streaming: boolean
  /** 本轮累积的正文（流式期间是纯文本，结束才交给 markdown 渲染） */
  readonly answer: string
  /** 本轮交给模型的工具名（来自 status 帧） */
  readonly tools: readonly string[]
  /** 本轮的工具活动（按 id 归并，起止两条帧合一条记录） */
  readonly activities: readonly ToolActivityView[]
  readonly error: { readonly code: string; readonly message: string } | null
  readonly finishReason: DockFinishReason | null
  readonly partial: boolean
  readonly rounds: number
  /**
   * 本次提问**有没有任何一回合**收到过 `grounded` 字段？（需求 ⑥）
   *
   * 与 {@link DockState.anyGrounded} 一起表达"这次回答没有知识库依据"，
   * 而**不能**只看最后一回合：无状态协议下一次提问可能跨多个 HTTP 回合
   * （客户端工具跑完再发一轮），而第二个回合的服务端**看不到**第一回合执行过的
   * 服务端工具——它算出来的 `grounded` 必然是 `false`。
   * 只看最后一回合的后果是：凡是"先 read_page 再改编辑框"的正常用法，
   * 最终答案都会被误标成"未使用知识库资料"。**一个总在误报的标注等于没有标注**，
   * 而且它会让真的那一次也不可信。
   */
  readonly sawGrounding: boolean
  /** 本次提问里有**至少一回合**拿到过知识库依据 */
  readonly anyGrounded: boolean
  /** 本次提问里有**至少一回合**拿到过公开网络依据（`'web'`） */
  readonly anyWeb: boolean
  /**
   * `messages` 里没有知识库依据的助手消息下标（渲染标注用，也是落盘的形态）。
   *
   * 与上面三个累加量分开：那些只描述**正在进行**的这一问，而这一份要跨刷新存活
   * （从 `DockConversation` 读回来），否则刷新后同一条回答就掉了标注。
   */
  readonly notGrounded: readonly number[]
  /**
   * `messages` 里**依据的是公开网络资料**的助手消息下标（与 `notGrounded` 同一种东西）。
   *
   * 为什么不能只靠"服务端说过有 web 依据"这一个布尔：标注是**逐条回答**的。
   * 一段对话里第一问查了知识库、第二问查了网络，用整段对话的累加量去渲染，
   * 第一问那条也会被标上"依据的是公开网络资料"——那是把有知识库出处的回答降级了。
   * 故与 `notGrounded` 一样按下标逐条记，并同样落盘。
   */
  readonly webGrounded: readonly number[]
}

/**
 * 把**本回合**的工具活动压成**一行**摘要（用户原话："回答完后，所有工具的使用都会堆积在下面，感觉不好"）。
 *
 * 为什么必须压：原先每个工具调用都是一行 `<li>` 平铺在回答下面，一轮里查两次知识库、
 * 搜一次网络、改一次页面就是四五行堆在底部——它们全是**过程信息**，而用户在回答结束之后
 * 要看的是结论。压成一行、需要时展开，过程信息不丢，版面也不再堆。
 *
 * 用**去重后的名字**（同名工具跑两次不必写两遍），数量仍按**调用次数**报（"跑了 2 次"
 * 与"用了 1 个工具"是两件事）。正在跑的时候只报"正在执行 N 个"，因为那时名字列表还在变。
 */
export function toolRunSummary(activities: readonly { readonly name: string; readonly ok: boolean | null }[]): string {
  const total = activities.length
  if (total === 0) return ''
  const names = [...new Set(activities.map((a) => a.name))]
  const list = names.join('、')
  const running = activities.filter((a) => a.ok === null).length
  if (running > 0) return `正在执行 ${total} 个工具：${list}`
  const failed = activities.filter((a) => a.ok === false).length
  const head = `本次用了 ${total} 个工具：${list}`
  return failed > 0 ? `${head}（其中 ${failed} 个失败）` : head
}

/**
 * 判定"滚动条已经贴到底"的容差（px）。
 *
 * 24px 是刻意偏大的：滚动位置是小数、长内容里浏览器还会留一两像素，
 * 用 `=== 0` 判定会让"明明在底部"被算成"用户滚上去了"，表现为**流式回答不再自动跟随**
 * （用户原话："发送新消息时不会自动置底，每次都要手动滑到最下面"）。
 * 另一头也不能太大：容差一旦超过半屏，"用户往上翻了一屏"会被误判成仍在底部，于是被强行拽下去。
 */
export const STICK_BOTTOM_EPS = 24

/**
 * 内容增长时该不该继续跟随到底部。
 *
 * 判据只有一条：**此刻是否贴底**。贴底 ⇒ 跟着滚（用户在看最新内容）；
 * 不贴底 ⇒ 一动不动（用户主动往上翻了，回看旧回答时被拽下去是最烦人的那种"贴心"）。
 * 与 `useActiveHeading` 里"读 DOM 判定"同一个思路：把判定写成纯函数，边界才测得住。
 */
export function isAtBottom(
  metrics: { readonly scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number },
  eps = STICK_BOTTOM_EPS,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= eps
}

export function initialDockState(): DockState {
  return {
    messages: [],
    streaming: false,
    answer: '',
    tools: [],
    activities: [],
    error: null,
    finishReason: null,
    partial: false,
    rounds: 0,
    sawGrounding: false,
    anyGrounded: false,
    anyWeb: false,
    notGrounded: [],
    webGrounded: [],
  }
}

/** 依据账的四个量（状态机与 `runTurn` 各自持有一份，故抽成一个可复用的形状） */
export interface GroundingLedger {
  readonly sawGrounding: boolean
  readonly anyGrounded: boolean
  readonly anyWeb: boolean
  readonly notGrounded: readonly number[]
  readonly webGrounded: readonly number[]
}

/**
 * 消费一帧 `done` 之后的依据账。
 *
 * **从 `applyTurnEvent` 里抽出来是必须的，不是整理**：`ui/index.tsx` 的 `runTurn`
 * 在流读取期间无法读到自己刚 `setState` 的值（`setState` 是异步的，而落盘发生在
 * 同一个 tick 之后），只能自己维护一份。两份实现必然漂移，而漂移的表现是
 * 「屏幕上标了、刷新之后没标」——正好是这个标注最不能出的一种错。
 */
export function groundingAfterDone(ledger: GroundingLedger, d: DoneData): GroundingLedger {
  const sawGrounding = ledger.sawGrounding || typeof d.grounded === 'boolean'
  const anyGrounded = ledger.anyGrounded || d.grounded === true
  // `'web'` 与 `'kb'` 是两笔账：前者不满足"有知识库依据"，故不能并进 `anyGrounded`
  const anyWeb = ledger.anyWeb || d.groundingSources.includes('web')
  /*
   * 标注只在**这一问真正结束**时落一次（`tool_calls` 只是把控制权交回客户端，
   * 那时还没有答复可标）。此刻几个累加量已经覆盖了所有回合，判据是完整的。
   *
   * 两条标注**互斥**（不是优先级）：`notGrounded` 是"既没有知识库依据、也没有网络依据"
   * 那一条，`webGrounded` 是"没有知识库依据、但有网络依据"那一条。把它们写成
   * "先判 kb 再判 web"会让"两者都有"落进 web 那条——而那时回答确实引用了知识库，
   * 不该挂任何标注。
   */
  const finished = d.finishReason !== 'tool_calls'
  const noKbGrounding = sawGrounding && !anyGrounded
  return {
    sawGrounding,
    anyGrounded,
    anyWeb,
    notGrounded:
      finished && noKbGrounding && !anyWeb
        ? withIndex(ledger.notGrounded, lastAssistantIndex(d.messages))
        : ledger.notGrounded,
    webGrounded:
      finished && noKbGrounding && anyWeb
        ? withIndex(ledger.webGrounded, lastAssistantIndex(d.messages))
        : ledger.webGrounded,
  }
}

/** 往一份下标集合里加一个（已存在、或下标非法时原样返回，且保持引用稳定） */
function withIndex(indexes: readonly number[], index: number): readonly number[] {
  if (index < 0 || indexes.includes(index)) return indexes
  return [...indexes, index].sort((a, b) => a - b)
}

/**
 * 转录里**最后一条有正文的助手消息**的下标（= 这一问的答复所在的位置）。
 *
 * 判据是"有正文"而不是"最后一条 assistant"：带工具调用的助手消息 `content` 常常是空串，
 * 取到它会把标注贴到一条没有正文的消息上（界面上什么都不显示，而真正的答复裸奔）。
 */
function lastAssistantIndex(messages: readonly DockMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === 'assistant' && m.content.trim() !== '') return i
  }
  return -1
}

/** 起一条用户消息并把状态推进到"正在生成"（请求发出**之前**就要显示出来） */
export function withUserMessage(state: DockState, text: string): DockState {
  return {
    ...state,
    messages: [...state.messages, { role: 'user', content: text }],
    streaming: true,
    answer: '',
    activities: [],
    error: null,
    finishReason: null,
    partial: false,
    // 新的提问 ⇒ 依据的账重新开始算（跨问题累加会让第二个问题继承第一个的结论）
    sawGrounding: false,
    anyGrounded: false,
    anyWeb: false,
  }
}

/** 按 id 归并一条工具活动（同 id 的后到的帧覆盖先到的：start 帧 ok=null，end 帧带结果） */
function upsertActivity(
  activities: readonly ToolActivityView[],
  next: ToolActivityView,
): ToolActivityView[] {
  const index = activities.findIndex((a) => a.id === next.id)
  if (index < 0) return [...activities, next]
  const copy = [...activities]
  copy[index] = next
  return copy
}

/**
 * 把一帧折进状态。**纯函数**：同一串帧喂两次得到同样的状态。
 *
 * `invalid` 帧被**静默忽略**（不置错误、不中断流）：它表示"有一条不认识的帧"，
 * 而流本身可能完全正常。把它显示成错误会让用户以为回答坏了——
 * 真正需要看见的是"生成失败"（`error` 帧），那是另一回事。
 */
export function applyTurnEvent(state: DockState, ev: TurnEvent): DockState {
  switch (ev.event) {
    case 'status':
      return {
        ...state,
        streaming: true,
        answer: '',
        tools: ev.data.tools,
        activities: [],
        error: null,
        finishReason: null,
        partial: false,
      }
    case 'delta':
      return { ...state, answer: state.answer + ev.data.text }
    case 'tool':
      return { ...state, activities: upsertActivity(state.activities, ev.data) }
    case 'done': {
      const d = ev.data
      /*
       * `finishReason === 'tool_calls'` 时**仍然是 streaming**：服务端只是把控制权交回来了，
       * 这一轮对话还没结束（客户端要去执行工具、再发一轮）。把它当成结束会让界面
       * 在工具执行期间显示"已完成"，而用户马上会看到又冒出一段新回答。
       */
      let activities = state.activities
      for (const activity of d.toolResults) activities = upsertActivity(activities, activity)
      return {
        ...state,
        messages: d.messages,
        answer: d.answer ?? state.answer,
        activities,
        streaming: d.finishReason === 'tool_calls',
        finishReason: d.finishReason,
        partial: d.partial,
        rounds: d.rounds,
        ...groundingAfterDone(state, d),
      }
    }
    case 'error':
      return { ...state, streaming: false, error: ev.data, partial: true }
    case 'invalid':
      return state
  }
}

/* ============================== 回合请求 ============================== */

/** 当前页指路牌（只给 slug / title，**不给正文**） */
export interface PageHint {
  readonly slug: string
  readonly title?: string
}

export interface TurnRequestBody {
  readonly messages: readonly DockMessage[]
  readonly clientTools: readonly string[]
  readonly round: number
  readonly page: PageHint | null
  /**
   * 会话 id 与**轮次 id**（P4 新增）。
   *
   * 服务端把它们原样透传给工具执行体，写工具据此把变更记进"可回退的那一轮"。
   * - `conversationId`：挂载时定下、整段对话不变；
   * - `turnId`：**每问一句换一个**，但在这一句引发的所有客户端工具回合里保持不变
   *   ——回退粒度是"一次提问"，不是一次 HTTP 回合（决策 10）。
   *
   * ⚠️ 这两个字段与服务端的 `TurnRequest.conversationId/turnId` 是一份事实的两半，
   * 缺了它们**不会报错**，只会让写工具明确拒绝动手（"记不下来就别改"）。
   * 那条设计是刻意的：静默改完却不可回退，比不改严重得多。
   */
  readonly conversationId: string
  readonly turnId: string
}

export function buildTurnBody(input: {
  messages: readonly DockMessage[]
  clientTools: readonly string[]
  round: number
  page: PageHint | null
  conversationId: string
  turnId: string
}): TurnRequestBody {
  return {
    messages: input.messages,
    clientTools: [...input.clientTools],
    round: input.round,
    page: input.page,
    conversationId: input.conversationId,
    turnId: input.turnId,
  }
}

/**
 * 解析模型给客户端工具的参数。
 *
 * 与**服务端**对同一个问题的处理刻意不同：服务端把坏 JSON 原样包成
 * `{__invalid_arguments: raw}` 交给模型自己去改（它下一轮通常能改对）；
 * 而这里参数要交给**浏览器里的执行体**，一个坏参数没有任何"下一轮"可救——
 * 故直接拒绝，让调用方把失败如实回报给模型。若两端都"宽容地包一层"，
 * 症状是工具收到一个它看不懂的对象并静默改了别的东西。
 */
export function parseToolArguments(raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  const text = raw.trim()
  if (text === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 客户端工具执行完之后要补进转录的消息。
 *
 * **每一条调用都必须补一条**：缺失的结果会在下一轮变成一个"孤儿调用"，
 * 而服务端会把整份转录发给上游——上游对孤儿调用的反应是 400，
 * 报错点离病因（浏览器少补了一条）很远。故这里对"没拿到结果"的调用
 * 也要补一条说明性的结果，而不是跳过。
 */
export function toolResultMessages(
  calls: readonly TurnToolCallView[],
  results: ReadonlyMap<string, { readonly ok: boolean; readonly content: string }>,
): DockMessage[] {
  return calls.map((call) => {
    const result = results.get(call.id)
    const content =
      result?.content ??
      JSON.stringify({ error: 'no_result', message: `客户端工具 ${call.name} 没有返回结果` })
    return { role: 'tool', content, toolCallId: call.id, name: call.name }
  })
}

/**
 * 把错误码翻成**一句可执行的话**。
 *
 * 为什么不让服务端的 `message` 直接上屏：`message` 是给运维看的
 * （"请求已发往模型服务，是它拒绝了"），而用户需要知道的是**他该做什么**。
 * 分档而不是照抄，也是本仓既有界面的一贯做法。
 */
export function errorLine(code: string, message: string): string {
  switch (code) {
    case 'model_unavailable':
      return 'AI 助手当前不可用：还没有配置可用的模型。请到「管理台 → 模型接入」填好服务商与密钥。'
    case 'unauthorized':
      return '请先登录再使用 AI 助手。'
    case 'too_many_streams':
      return '同时进行的对话太多了，稍等几秒再试。'
    case 'unavailable':
      return 'AI 助手刚被停用（或正在重载），刷新页面后再试。'
    case 'network':
      return `连不上服务端：${message}`
    case 'stream_broken':
      return '连接中断了，这次回答没有收完。可以重问一次。'
    case 'too_many_rounds':
      return message
    default:
      return message === '' ? `出错了（${code}）` : message
  }
}

/**
 * 执行模型请求的客户端工具，**每一条都必须拿到一个结果**（哪怕失败）。
 *
 * 缺结果会在下一轮变成"孤儿调用"，而上游对孤儿调用的反应是 400——
 * 报错点离病因（浏览器少补了一条）很远。故这里四条路径（参数坏、调用抛错、
 * 返回 undefined、正常）都产出内容。
 */
export async function runClientTools(
  calls: readonly TurnToolCallView[],
  invoke: (name: string, args: unknown) => Promise<unknown>,
): Promise<Map<string, { ok: boolean; content: string }>> {
  const results = new Map<string, { ok: boolean; content: string }>()
  for (const call of calls) {
    const parsed = parseToolArguments(call.arguments)
    if (!parsed.ok) {
      results.set(call.id, {
        ok: false,
        content: JSON.stringify({ error: 'invalid_arguments', message: parsed.reason }),
      })
      continue
    }
    try {
      const value = await invoke(call.name, parsed.value)
      results.set(call.id, { ok: true, content: JSON.stringify(value ?? null) })
    } catch (err) {
      results.set(call.id, {
        ok: false,
        content: JSON.stringify({ error: 'tool_failed', message: err instanceof Error ? err.message : String(err) }),
      })
    }
  }
  return results
}

/* ============================== 本地会话 ============================== */

/** `localStorage` 的最小子集（测试注入假实现，故只依赖这两个方法） */
export interface MiniStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const MAX_CONVERSATIONS = 10
export const STORAGE_NAMESPACE = 'geewiki.ai.dock.v1'

export interface DockConversation {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly messages: readonly DockMessage[]
  /**
   * `messages` 里**没有知识库依据**的那些助手消息的下标（需求 ⑥）。
   *
   * 为什么必须落盘：标注是那条回答的一部分。刷新之后同一条回答若掉了标注，
   * 用户会把它读成"有出处的"，而那恰好是这个标注要防的误读——
   * 一个刷新就消失的警告比没有警告更坏。
   *
   * 为什么不塞进 `DockMessage`：那份形状是**发给服务端的线上消息**
   * （`TurnMessage`），服务端对未知字段是**报 400** 的（`parseTurnBody` 的白名单），
   * 往里加一个展示用的字段会让整个回合失败。下标是旁路信息，就该走旁路。
   */
  readonly notGrounded: readonly number[]
  /**
   * 同上，`messages` 里**依据公开网络资料**的那些助手消息下标。
   *
   * 与 `notGrounded` 逐条同命的理由：标注是那条回答的一部分，刷新之后掉了标注，
   * 用户会把它读成"出自本知识库的"——而在这一档上，那个误读恰好就是需求 ⑥
   * 要防的那一个（模型明明给了网络来源，界面却说不出它来自网络）。
   */
  readonly webGrounded: readonly number[]
}

/**
 * 存储键**按用户隔离**（决策 12）。
 *
 * `userId` 为 null 时用 `anon` 而不是"不存"：未登录本就不该渲染 dock（决策 5），
 * 但这个键仍然存在是为了让"登录态在渲染后变化"的那一帧有一个确定的落点——
 * 写成 `undefined` 会拼出 `...uundefined` 这种两个用户共用的键。
 */
export function conversationsKey(userId: number | null): string {
  return `${STORAGE_NAMESPACE}.u${userId === null ? 'anon' : String(userId)}`
}

/** 会话标题：第一条用户消息压平后截断；没有用户消息时给一个中性的占位 */
export function titleOf(messages: readonly DockMessage[], max = 24): string {
  const first = messages.find((m) => m.role === 'user')
  const flat = (first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return '新对话'
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * 历史条目的相对时间。
 *
 * 历史列表里**光有标题不够用**：本地最多留 10 段，标题又都长得差不多
 * （用户往往连着问同一件事），没有时间就分不清哪段是刚才的、哪段是上周的。
 *
 * 刻意在 30 天处切成绝对日期：那时候"87 天前"对人已经没有意义，
 * 反而要让人自己换算。`now` 是参数而不是内部取 `Date.now()`，这样它是纯函数、可测。
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at)) return ''
  const diff = now - at
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 读取本地会话。
 *
 * **损坏数据一律折算成空数组**，绝不抛：这份数据在 `localStorage` 里，
 * 用户（或另一个标签页的旧版本）可以把它改成任何东西。为一个"读不出来"的
 * 副作用把输入条整个崩掉，是最不划算的一种失败。
 */
export function loadConversations(store: MiniStore, userId: number | null): DockConversation[] {
  let raw: string | null
  try {
    raw = store.getItem(conversationsKey(userId))
  } catch {
    return []
  }
  if (raw === null || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: DockConversation[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const id = typeof o['id'] === 'string' ? o['id'] : ''
    if (id === '') continue
    const messages = Array.isArray(o['messages']) ? (o['messages'] as DockMessage[]) : []
    /*
     * 下标越界的条目**丢弃**（而不是原样留着）：`messages` 被裁过或手改过时，
     * 一个指向不存在消息的下标会让标注落到别人的回答上——把"没依据"的标签
     * 贴到一条真有依据的回答上，比不贴更坏。
     */
    const notGrounded = Array.isArray(o['notGrounded'])
      ? (o['notGrounded'] as unknown[]).filter(
          (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < messages.length,
        )
      : []
    // 与 `notGrounded` 同一套越界丢弃：老数据没有这个字段 ⇒ 空数组（不炸、也不误标）
    const webGrounded = Array.isArray(o['webGrounded'])
      ? (o['webGrounded'] as unknown[]).filter(
          (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < messages.length,
        )
      : []
    out.push({
      id,
      title: typeof o['title'] === 'string' && o['title'] !== '' ? o['title'] : titleOf(messages),
      updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : 0,
      messages,
      notGrounded,
      webGrounded,
    })
  }
  // 新的在前，并裁到上限（**只留最近 10 段**，同决策 9）
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS)
}

/**
 * 写入一段会话，返回**写入后**的列表（调用方据此更新历史入口）。
 *
 * 同 id 覆盖而不是追加：一段对话在一次会话里会被反复保存（每轮结束一次），
 * 追加会让"近 10 段"在几轮之内就被同一段对话占满。
 */
export function saveConversation(
  store: MiniStore,
  userId: number | null,
  conversation: DockConversation,
): DockConversation[] {
  const existing = loadConversations(store, userId).filter((c) => c.id !== conversation.id)
  const next = [conversation, ...existing]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS)
  try {
    store.setItem(conversationsKey(userId), JSON.stringify(next))
  } catch {
    // 配额满 / 隐私模式：存不下就算了，绝不让"存不进去"影响对话本身
  }
  return next
}

/* ============================== 传输 ============================== */

/** 一次回合的传输结果（把 fetch 的失败也折算成数据，而不是让调用方 try/catch） */
export type TurnTransportResult =
  | { readonly kind: 'ok'; readonly status: number; readonly body: ReadableStream<Uint8Array> | null; readonly text: string | null }
  | { readonly kind: 'network'; readonly message: string }

export interface TurnTransport {
  (path: string, body: unknown, signal: AbortSignal): Promise<TurnTransportResult>
}

/**
 * 默认传输：`fetch` + 把网络异常折算成 `{kind:'network'}`。
 *
 * 为什么不直接抛：调用方（组件）在**每一条**失败路径上都要做同一件事
 * （结束 streaming、显示一句可读的错），而抛异常会逼着每个 await 点都包一层 try。
 */
export const defaultTransport: TurnTransport = async (path, body, signal) => {
  try {
    const res = await fetch(path, {
      method: 'POST',
      /*
       * ⚠️ 这两个头**一个都不能少**（P3 补的一次真实缺陷）。
       *
       * `x-gw-csrf: 1`：服务端在带会话 cookie 时**强制**校验它，跨站表单无法设置自定义头，
       * 所以这一个头就是 CSRF 防线本身（`packages/web/src/api.ts:65` 与 `:159` 都写着
       * "绝不能漏"）。漏了它的表现是**每个登录用户的每一次提问都 401**。
       * `credentials: 'same-origin'`：不显式写出来时，行为取决于浏览器默认值——
       * 而这正是那种"在 A 浏览器一切正常、在 B 浏览器静默丢会话"的差异。
       *
       * 为什么 P2b 没发现：它的验收脚本（`scripts/acceptance/p2b-turn/run.ts`）从 node 发请求、
       * 自己显式带 cookie 与 CSRF 头，**根本没走这个浏览器传输**。抓到它的是
       * `packages/web/test/pluginUi.test.ts` 里那条按已构建产物做断言的守卫
       * （它检查 client.js 里有没有 `credentials` 与 `x-gw-csrf`）——
       * 那是全仓唯一一条会读**构建产物字节**的测试，而它这次生效了。
       */
      credentials: 'same-origin',
      headers: { 'x-gw-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || res.body === null) {
      // 前置条件的失败是**普通 JSON**（401/400/413/429/503）——如实读出它的 message
      return { kind: 'ok', status: res.status, body: null, text: await res.text() }
    }
    return { kind: 'ok', status: res.status, body: res.body, text: null }
  } catch (err) {
    return { kind: 'network', message: err instanceof Error ? err.message : String(err) }
  }
}

/* ============================== 变更日志（P4 的回退 UI） ============================== */

/** 写路径与回退路径（都由 `@geewiki/ai-journal` 提供） */
export const JOURNAL_PATH = '/api/ai/journal'
export const JOURNAL_UNDO_PATH = '/api/ai/journal/undo'
export const JOURNAL_ACK_PATH = '/api/ai/journal/undo/ack'

/**
 * 浏览器侧写操作的**域归属**。
 *
 * 用宿主包的规范名而不是 `'web-editor'` 这类临时串：服务端按 owner 回收注册
 * （`release(owner)` 的先例），而"谁改的"也经这一行进入日志、最终显示给用户。
 */
export const EDITOR_DOMAIN_OWNER = '@geewiki/web'

/** 浏览器侧写操作的**域**：服务端没有它的读路径与撤销执行体 ⇒ 进 `clientSteps` */
export const EDITOR_DOMAIN = 'editor'

/** 一条变更记录在浏览器看到的形状（与服务端 `MutationRecord` 的字段子集） */
export interface JournalRecordView {
  readonly id: number
  readonly turnId: string
  readonly tool: string
  readonly domain: string
  readonly target: string
  readonly before: string | null
  readonly after: string | null
  /** 已撤销的时刻；`null` = 还没撤 */
  readonly undoneAt: string | null
}

/**
 * 一轮里的变更（服务端 `TurnGroup` 的视图子集）。
 *
 * ⚠️ **`pending` 是"还没撤的条数"，不是数组**——服务端刻意这么设计（`TurnGroup` 的
 * 注释：UI 据此禁用按钮）。P4 初版这里写成了 `readonly pending: JournalRecordView[]`，
 * 于是 `pending.length` 恒为 `undefined`，回退入口**一个都不显示**且不报错。
 * 真正要展示的条目在 `records` 里。
 */
export interface JournalTurnView {
  readonly turnId: string
  readonly at: string
  readonly tools: readonly string[]
  /** 该轮里**还没撤销**的条数；0 = 已经撤干净了 */
  readonly pending: number
  readonly records: readonly JournalRecordView[]
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function recordView(raw: unknown): JournalRecordView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = Number(r['id'])
  if (!Number.isFinite(id)) return null
  return {
    id,
    turnId: str(r['turnId']),
    tool: str(r['tool']),
    domain: str(r['domain']),
    target: str(r['target']),
    before: typeof r['before'] === 'string' ? r['before'] : null,
    after: typeof r['after'] === 'string' ? r['after'] : null,
    undoneAt: typeof r['undoneAt'] === 'string' ? r['undoneAt'] : null,
  }
}

/**
 * 解析 `GET /api/ai/journal` 的响应。
 *
 * 全程**防御性**：这个响应决定"要不要显示回退按钮"，而形状读错的表现是
 * "按钮不出现"或"按钮点了报错"——两者都不会崩，但都会让用户以为这功能坏了。
 * 认不出的条目直接丢掉（丢掉一条 = 少一个回退入口，不会误导用户去点一个假的东西）。
 */
export function parseJournalTurns(raw: unknown): JournalTurnView[] {
  if (typeof raw !== 'object' || raw === null) return []
  const turns = (raw as Record<string, unknown>)['turns']
  if (!Array.isArray(turns)) return []
  const out: JournalTurnView[] = []
  for (const item of turns) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    const turnId = str(t['turnId'])
    if (turnId === '') continue
    const recordsRaw = Array.isArray(t['records']) ? t['records'] : []
    const records = recordsRaw.map(recordView).filter((r): r is JournalRecordView => r !== null)
    /*
     * `pending` 以服务端为准（它是权威计数）；服务端没给时**从记录现算**，
     * 而不是猜 0 —— 猜 0 会让回退入口消失，用户以为"这次没改东西"。
     */
    const pendingRaw = t['pending']
    const pending =
      typeof pendingRaw === 'number' && Number.isFinite(pendingRaw)
        ? pendingRaw
        : records.filter((r) => r.undoneAt === null).length
    out.push({
      turnId,
      at: str(t['at']),
      tools: Array.isArray(t['tools']) ? t['tools'].filter((x): x is string => typeof x === 'string') : [],
      pending,
      records,
    })
  }
  return out
}

/**
 * 这一轮回退**影响了哪些页面**（供宿主失效当前正文用）。
 *
 * 为什么从"记录"取而不是从服务端的撤销报告取：报告里只有给人看的一句话
 * （`undone: string[]`），不携带结构化目标；而记录本身就带 `target`（页面 slug）——
 * 撤销的就是它们，所以判据在这里是完整的。
 *
 * 语义与 {@link affectedSlugs} 对齐的两种形态：有具体 slug ⇒ 精确失效；
 * 记录里一个 slug 都取不到（老记录、编辑器草稿这类没有页面目标的域）⇒
 * 返回 `null`，调用方按"不知道是哪一页"处理（重取当前页）。
 */
export function undoneSlugs(records: readonly JournalRecordView[]): string[] | null {
  const slugs = new Set<string>()
  for (const r of records) {
    if (r.undoneAt !== null) continue // 已经撤过的记录不构成"这次要改的东西"
    if (r.target !== '') slugs.add(r.target)
  }
  return slugs.size === 0 ? null : [...slugs]
}

/** 需要在**浏览器**里执行的撤销步骤（服务端没有该域的撤销执行体，如编辑框草稿） */
export interface RestoreStepView {
  readonly record: JournalRecordView
  readonly expected: string | null
}

export interface UndoReportView {
  /** 已由服务端撤掉的（给人看的一句话） */
  readonly undone: readonly string[]
  /** 服务端试过但失败的 */
  readonly failed: readonly string[]
  /** 没撤的：目标被改过、或拿不到当前值（**不会强行覆盖**） */
  readonly conflicts: readonly string[]
  /** 要浏览器自己执行的（草稿） */
  readonly clientSteps: readonly RestoreStepView[]
}

export function parseUndoReport(raw: unknown): UndoReportView {
  const empty: UndoReportView = { undone: [], failed: [], conflicts: [], clientSteps: [] }
  if (typeof raw !== 'object' || raw === null) return empty
  const r = raw as Record<string, unknown>
  const detailOf = (item: unknown): string => {
    if (typeof item === 'string') return item
    if (typeof item === 'object' && item !== null) {
      const d = (item as Record<string, unknown>)['detail']
      return typeof d === 'string' ? d : ''
    }
    return ''
  }
  const reasonOf = (item: unknown): string => {
    if (typeof item === 'object' && item !== null) {
      const reason = (item as Record<string, unknown>)['reason']
      if (typeof reason === 'string') return reason
    }
    return detailOf(item)
  }
  const list = (value: unknown, pick: (item: unknown) => string): string[] =>
    Array.isArray(value) ? value.map(pick).filter((x) => x !== '') : []
  const stepsRaw = Array.isArray(r['clientSteps']) ? r['clientSteps'] : []
  const clientSteps: RestoreStepView[] = []
  for (const item of stepsRaw) {
    if (typeof item !== 'object' || item === null) continue
    const record = recordView((item as Record<string, unknown>)['record'])
    if (record === null) continue
    const expected = (item as Record<string, unknown>)['expected']
    clientSteps.push({ record, expected: typeof expected === 'string' ? expected : null })
  }
  return {
    undone: list(r['undone'], detailOf),
    failed: list(r['failed'], detailOf),
    conflicts: list(r['conflicts'], reasonOf),
    clientSteps,
  }
}

/** 回退结果的**一句话**（含"没撤的为什么没撤"——只报成功的那种界面等于说谎） */
export function undoHeadline(report: UndoReportView): string {
  const parts: string[] = []
  if (report.undone.length > 0) parts.push(`已撤销 ${report.undone.length} 处改动`)
  if (report.failed.length > 0) parts.push(`${report.failed.length} 处没能撤销`)
  if (report.conflicts.length > 0) parts.push(`${report.conflicts.length} 处被拒绝（目标已被改动过，或拿不到它的当前值）`)
  if (parts.length === 0 && report.clientSteps.length === 0) return '这一轮没有需要撤销的改动。'
  return parts.join('；') + '。'
}

/** 客户端工具调用里**会改东西**的那些（判定权在服务端，见 `DoneData.mutatingTools`） */
export function mutatingCalls(
  calls: readonly TurnToolCallView[],
  mutatingTools: readonly string[] | undefined,
): readonly TurnToolCallView[] {
  if (mutatingTools === undefined || mutatingTools.length === 0) return []
  const set = new Set(mutatingTools)
  return calls.filter((call) => set.has(call.name))
}

/**
 * 这一回合里**成功的写操作**影响到的页面 slug（供宿主失效当前正文用）。
 *
 * 返回值是三态，别把它压成二叉：
 *   · `null` —— 这一回合没有任何成功的写操作 ⇒ **不要**发广播（读了页面不算"改了东西"）；
 *   · `[]`   —— 改了东西，但参数里解析不出 slug（工具换了参数名、参数不是合法 JSON 等）
 *              ⇒ 仍然要广播，宿主按"不知道是哪一页"处理（重取当前页）。宁可多刷一次，
 *              也不要让用户盯着过期正文；
 *   · `['a','b']` —— 具体是哪几页。
 *
 * 判据与 {@link mutatingCalls} **同一份**：写操作的身份由服务端按描述符的 `mutating` 算出
 * （`DoneData.mutatingTools`），浏览器只负责读，不按工具名猜。
 *
 * ⚠️⚠️ 入参是 **`toolResults`（执行结果）而不是 `toolCalls`（模型的调用意图）**。
 * 这一条是真踩过的：本函数第一版从 `done.toolCalls` 里找写工具，本地单测全绿，
 * 但真回合里 **AI 改了库、屏幕却不动**——因为最终 done 帧的 `toolCalls` 是 `null`
 * （那一轮模型没再发起调用，写操作的记录只出现在 `toolResults` 里）。
 * 单测当时喂的是"我自己以为的形状"（toolCalls 里有那条写调用），所以照不出这个错。
 * 现在的用例直接喂这个真实形状（`toolCalls: null` + 一条成功的 `page.update` 结果）。
 * `ToolActivityView` 自带 `name`/`arguments`/`ok`，正好了；能不用 id 去跟 `toolCalls` 对齐就不用。
 */
export function affectedSlugs(
  results: readonly ToolActivityView[],
  mutatingTools: readonly string[] | undefined,
): string[] | null {
  if (mutatingTools === undefined || mutatingTools.length === 0) return null
  const set = new Set(mutatingTools)
  // 只排除**明确失败**的（`ok === false`）；`null`（还在跑）按"可能改了"处理——漏刷的代价比多刷大
  const writes = results.filter((r) => set.has(r.name) && r.ok !== false)
  if (writes.length === 0) return null
  const slugs = new Set<string>()
  for (const w of writes) {
    /*
     * `arguments` 是**字符串**（SSE 原样下发的 JSON 文本）。解析失败不是异常路径：
     * 工具可能用了别的参数名（`target` 而不是 `slug`），也可能压根没有 slug 概念
     * （比如"重排导航"那种批量写）——那就退化成"不知道是哪一页"（空数组 ⇒ 仍然广播）。
     */
    let parsed: unknown
    try {
      parsed = JSON.parse(w.arguments)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const slug = (parsed as { slug?: unknown }).slug
    if (typeof slug === 'string' && slug !== '') slugs.add(slug)
  }
  return [...slugs]
}

/**
 * 变更日志的传输（GET 与 POST 都要）。
 *
 * 与 {@link defaultTransport} 分开写：那个是**流式**的（返回 `ReadableStream`），
 * 而日志是一次性 JSON。硬凑成一个会让两边都长出用不到的分支。
 * 但 CSRF 与凭据这两个头**必须与它逐字一致**——那是同一道防线。
 */
export interface JournalTransport {
  (method: 'GET' | 'POST', path: string, body: unknown | null): Promise<{ ok: boolean; status: number; body: unknown }>
}

export const defaultJournalTransport: JournalTransport = async (method, path, body) => {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-gw-csrf': '1', 'content-type': 'application/json' },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      // 非 JSON 响应（网关错误页）——留着 ok/status 让调用方如实报错
      parsed = null
    }
    return { ok: res.ok, status: res.status, body: parsed }
  } catch (err) {
    return { ok: false, status: 0, body: { message: err instanceof Error ? err.message : String(err) } }
  }
}

/** 读某段对话的变更轮次（回退 UI 的输入） */
export async function readJournal(
  transport: JournalTransport,
  conversationId: string,
): Promise<JournalTurnView[]> {
  const res = await transport('GET', `${JOURNAL_PATH}?conversationId=${encodeURIComponent(conversationId)}`, null)
  if (!res.ok) return []
  return parseJournalTurns(res.body)
}

/**
 * 回退到某一轮**之前**。
 *
 * `snapshots` 只该装**服务端没有探针的域**（目前只有 `editor`：草稿在浏览器里，
 * 服务端没有任何读路径）。页面的当前值由服务端自己的探针读——**客户端报了也不算数**
 * （探针优先），所以这里不需要、也不应该替页面报值。
 *
 * 漏报一个 `editor` 目标的后果不是"回退错"，而是**那一条被拒绝**：
 * `planRollback` 对"拿不到当前值"按冲突处理（不知道 ≠ 没变过）。
 * 这是一个安全的方向，但会让用户看到"点了没反应"，所以调用方必须尽力报全。
 */
export async function undoTurn(
  transport: JournalTransport,
  conversationId: string,
  turnId: string,
  snapshots: Record<string, string | null> = {},
): Promise<UndoReportView> {
  const res = await transport('POST', JOURNAL_UNDO_PATH, { conversationId, turnId, snapshots })
  return parseUndoReport(res.body)
}

/**
 * 为一次回退收集**只有浏览器知道**的当前值（`editor` 域的草稿）。
 *
 * 读不到（不在编辑页）就**不报**——那一条会进 `conflicts` 并说明"没有拿到当前值"，
 * 而不是拿一个空串去顶替。空串是**一个值**，它会让"读不到"看起来像"现在是空的"，
 * 于是要么误判成冲突（保守但误导），要么（若恰好等于 after）**放行一次基于假数据的回退**。
 */
export async function collectSnapshots(
  records: readonly JournalRecordView[],
  invoke: (name: string, args: unknown) => Promise<unknown>,
): Promise<Record<string, string | null>> {
  const targets = records.filter((r) => r.domain === EDITOR_DOMAIN && r.undoneAt === null)
  if (targets.length === 0) return {}
  const text = await readDocText(invoke)
  if (text === null) return {}
  const out: Record<string, string | null> = {}
  for (const record of targets) out[`${EDITOR_DOMAIN}:${record.target}`] = text
  return out
}

/** 读一次编辑框正文（没有编辑框时返回 null——不是错误，是"这个页面没有草稿域"） */
export async function readDocText(invoke: (name: string, args: unknown) => Promise<unknown>): Promise<string | null> {
  try {
    const value = await invoke('editor.read_doc', {})
    if (typeof value !== 'object' || value === null) return null
    const text = (value as Record<string, unknown>)['text']
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * 把一次**客户端**写操作记进变更日志。
 *
 * 为什么由会话核心（而不是浏览器工具自己）记：只有它知道 `conversationId` / `turnId`，
 * 而客户端工具的处理器签名里没有这两个东西（`ClientToolHandler = (args) => …`）。
 * 把回合身份塞进处理器签名会污染一个"模型参数进、结果出"的纯接口。
 *
 * 载荷是**前后两份草稿全文**：`before` 是回退的唯一依据，比对全文而不是 diff
 * 是因为草稿的差异可能是重排（diff 表达不了，而全文永远表达得了）。
 */
export async function recordClientMutation(
  transport: JournalTransport,
  input: {
    readonly conversationId: string
    readonly turnId: string
    readonly tool: string
    readonly target: string
    readonly before: string
    readonly after: string
  },
): Promise<boolean> {
  const res = await transport('POST', JOURNAL_PATH, {
    conversationId: input.conversationId,
    turnId: input.turnId,
    // ★ `owner` 是**必填**（服务端按它做"卸载时回收"的归属）。漏了它得到的是
    // `400 invalid_body: owner 必须是字符串`，而表现是"编辑框的改动没进日志、
    // 回退时少一条"——一个不会崩、只会静默少东西的失败。
    owner: EDITOR_DOMAIN_OWNER,
    tool: input.tool,
    domain: EDITOR_DOMAIN,
    target: input.target,
    before: input.before,
    after: input.after,
  })
  return res.ok
}

/** 浏览器执行完 `clientSteps` 之后回报（单独一趟，理由见服务端注释：两件事不能混） */
export async function ackRestored(transport: JournalTransport, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return
  await transport('POST', JOURNAL_ACK_PATH, { ids, detail: '已由浏览器把编辑框草稿还原' })
}

/**
 * 执行回退里的**客户端步骤**（编辑框草稿）。
 *
 * 走 `editor.restore_doc` —— 一条**只登记给宿主、不进模型工具表**的客户端工具
 * （`packages/web/src/lib/editorTools.ts` 的 `RESTORE_DOC_TOOL`）。
 * 回退不受"当前页是不是编辑页"之外的限制：编辑框不在场时 `invoke` 会抛，
 * 那条会被如实记进 `failed`，而不是静默算成功。
 */
export async function runRestoreSteps(
  steps: readonly RestoreStepView[],
  invoke: (name: string, args: unknown) => Promise<unknown>,
): Promise<{ readonly restored: readonly number[]; readonly failed: readonly string[] }> {
  const restored: number[] = []
  const failed: string[] = []
  for (const step of steps) {
    if (step.record.before === null) {
      failed.push(`${step.record.target}：这条记录记的是"新建"，无法用旧值还原`)
      continue
    }
    try {
      await invoke('editor.restore_doc', { text: step.record.before })
      restored.push(step.record.id)
    } catch (err) {
      failed.push(`${step.record.target}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { restored, failed }
}

/* ============================== 便捷导出 ============================== */

export { createTurnDecoder }
export type { DockFinishReason, DockMessage, ToolActivityView, TurnEvent, TurnToolCallView }
