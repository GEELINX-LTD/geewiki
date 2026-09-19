import type { AiToolContext } from '@geewiki/ai-tools'
/**
 * Agent loop —— 本插件的核心，也是**唯一**调用模型的地方。
 *
 * ## 它刻意不含的东西
 * 不含任何检索逻辑。`search_kb` / `read_page` / `list_pages` 是 `@geewiki/ai-kb` 贡献的
 * **工具**，本文件只按名字拿到 `ResolvedTool` 并调用它（设计文档 §1：
 * 「ai-assistant：agent loop + SSE + 系统提示 + 预算；★ 不含任何检索逻辑」）。
 * 这条边界有一个立即可验证的好处：换一个知识库实现、加一个网络检索工具，
 * 本文件一行都不用改。
 *
 * ## 三条结构性的硬约束
 *
 * ### 1. 每一个工具调用都**必须**留下一条配对的结果消息
 * 上游的消息协议要求 `assistant.toolCalls` 里的每个 `id` 都有恰好一条
 * `role:'tool'` + 同 `toolCallId` 的消息。少一条，下一次请求就是一个
 * "孤儿调用"，多数网关**直接 400**——而报错点离病因（我们悄悄跳过了某条调用）很远。
 * 因此这里有 `unknown` 一档：模型报了一个不存在的工具名时，也要回一条说明性的工具结果，
 * 而不是当没看见。
 *
 * ### 2. 上游没给 `id` 的调用**不可执行**
 * `LlmToolCall.id` 为空串表示上游违约（见 `@geewiki/llm` 的注释："把它回灌会失败——
 * 调用方应视为不可执行，而不是拿空 id 去试"）。这里选择**让整个回合失败**并回一个
 * `invalid_tool_call`，而不是丢掉那条调用继续：丢掉它会让模型以为自己调过了，
 * 于是"明明没查却说查过了"——这正是本仓最不能接受的一类失败。
 *
 * ### 3. 截断**必须**说出来
 * 工具结果超预算时截断，并在结果文本里写明"这是截断的、不要据此断言没有"。
 * 实测踩过（`data/verify/ai-native-probe/` 的 E4）：静默截断把「我没看到」
 * 伪装成了「资料里没有」，模型据此回答"知识库资料不足"。
 */
import type { Principal } from '@geewiki/core'
import type { AiToolGrounding, AiToolResult, ResolvedTool } from '@geewiki/ai-tools'
import {
  assembleToolCalls,
  redact,
  type LlmMessage,
  type LlmService,
  type LlmToolCall,
  type LlmToolCallDelta,
  type LlmToolDef,
  type LlmUsage,
} from '@geewiki/llm'
import { buildMessages, SYSTEM_PROMPT, type PageHint } from './prompt.js'
import type { TurnMessage } from './types.js'
import type { ToolActivity, TurnFinishReason, TurnToolSide } from './sse.js'

/* ============================== 事件与结果 ============================== */

/** loop 向外的单向事件流。SSE 处理器把它逐条翻成帧，测试把它收集成数组 */
export type LoopEvent =
  | { readonly type: 'delta'; readonly text: string }
  /**
   * 模型的思考内容增量（推理型模型才有；普通模型一条都不发）。
   *
   * 与 `delta` **分开**是刻意的：它是**过程**而非回答，不写进 `messages`（不给模型看见），
   * 上层把它翻成一条独立的 `thinking` 帧——复用 `delta` 会让不认识思考的旧界面
   * 把它当正文渲染出来（把草稿当答案，比不显示更糟）。
   */
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-start'; readonly id: string; readonly name: string; readonly side: TurnToolSide; readonly arguments: string }
  | { readonly type: 'tool-end'; readonly activity: ToolActivity }

export interface LoopFailure {
  readonly code: string
  readonly message: string
}

export interface LoopOutcome {
  /** **权威转录**：客户端下一次原样带上 */
  readonly messages: readonly TurnMessage[]
  readonly answer: string | null
  readonly finishReason: TurnFinishReason
  /** 待**客户端**执行的调用；没有则为 null */
  readonly pendingToolCalls: readonly LlmToolCall[] | null
  /**
   * `pendingToolCalls` 里**会改东西**的那些工具名（判定来自工具描述符的 `mutating`）。
   *
   * 为什么由服务端算而不是让浏览器自己认名字：`mutating` 是**描述符上的声明**，
   * 而浏览器手里只有名字。让浏览器去猜（"以 editor. 开头且不含 read 的"）就是第二份判据，
   * 它会在某个工具改名时静默失效——而失效的后果是"改了的没记进日志，回退时漏一条"。
   *
   * ⚠️ **跨轮累积，不是"最后一轮待执行的调用"**（2026-09-16 修正）。
   * 原实现取 `partial.pending`（该帧里模型发起、还没执行的调用）⇒ 模型"调用写工具后直接收尾"
   * 这一最常见的情形下，最后一帧的 `pending` 是空的，于是这份名单**恒为空**：
   * 客户端据此判定"这一回合没有写操作"，AI 改完正文后页面不刷新（用户报的缺陷）、
   * 变更日志的接线也永远收不到信号。现在在执行处按描述符累加，与"在哪一轮跑的"无关。
   */
  readonly mutatingTools: readonly string[]
  /**
   * 这一回合的回答**有没有知识库依据**（需求 ⑥ / 决策 4 的结构化标记）。
   *
   * 判据是**代码手里的事实**，不是模型的自述：只要有任何一条工具结果声明了
   * `grounding: 'kb'`（`@geewiki/ai-tools` 的 `AiToolResult`），它就是 true。
   * 由此推出两条必须记住的边界：
   *
   * - `false` **不蕴含**"这答案一定错"——它只说明模型这次没有拿到知识库资料，
   *   于是回答来自它的先验知识。界面据此给出显著标注，由用户决定信不信。
   * - 只有 `side: 'server'` 的工具能贡献它。客户端工具的结果由浏览器直接拼成
   *   `tool` 消息回灌，服务端**看不到** `AiToolResult`——所以那条路上不存在
   *   "声明的依据"，这不是遗漏，是链路形状决定的。
   */
  readonly grounded: boolean
  /**
   * 本回合所有工具结果声明过的**完整出处清单**（去重、稳定排序）。
   *
   * 为什么不能只下发 `grounded`：联网搜索有依据，但那不是**知识库**依据。
   * 界面只拿一个布尔的话，只有两条路——把它也当成"有依据"（于是「依据的是公开网络资料」
   * 被渲染成没有任何标注，用户以为话出自本知识库），或者当成"没依据"
   * （于是渲染「来自模型自身的知识」，而模型明明给了来源链接）。**两条都是误导**，
   * 而误导的方向恰好是需求 ⑥ 要消灭的那一种。故判据必须按出处分档下传，
   * 标注的措辞由界面按档选择。
   *
   * 排序稳定（字典序）而不是按抵达顺序：同一份事实在两次请求里应当是同一份字节，
   * 客户端与测试都可以直接比较数组。
   */
  readonly groundingSources: readonly AiToolGrounding[]
  readonly toolResults: readonly ToolActivity[]
  readonly usage: LlmUsage | null
  /** 本回合实际调用模型的次数 */
  readonly rounds: number
  /** 非 null 表示这一轮没能正常收尾（处理器据此发 `error` 帧而不是 `done`） */
  readonly error: LoopFailure | null
}

/**
 * 这一轮为什么被中止（`AbortSignal.reason` 里带过来的值）。
 *
 * 为什么要区分：这四种情况对用户是**完全不同的处境**，要给的下一步也不同
 * （等一等再继续 / 把要求拆小 / 是页面离开了 / 是运维动作）。
 * 早先四条路径共用一句"本轮已取消（超时或客户端断开）"，用户看不出发生了什么
 * —— 用户就是这么问上来的。
 */
export type TurnAbortReason = 'idle_timeout' | 'hard_timeout' | 'client_disconnect' | 'shutdown'

/** 中止原因的**唯一**文案映射（两处 abort 分支共用；改写见 README 的对应批次） */
export function abortMessageOf(reason: unknown, toolCount: number): string {
  const tail = toolCount > 0 ? `（本回合已执行 ${toolCount} 个工具，结果都还在）` : ''
  switch (reason) {
    case 'idle_timeout':
      /*
       * 措辞刻意**不把锅扣给上游**：空闲判据是"一段时间内没有任何进展"，而"进展"既可能是
       * 上游在吐字，也可能是某个工具正在跑。真正卡住的是两者之一，界面上分不出来，
       * 就不该替用户断定（第一版写死了"模型服务一直没有响应"，被用户当场指出上游明明有反应）。
       */
      return `本轮长时间没有任何进展（上游没有响应，或某个工具卡住了），已中止${tail}。可以直接点下面的「继续」接着做。`
    case 'hard_timeout':
      return `本轮超过了硬性时限，已中止${tail}。这次要读/搜的东西比较多，可以把要求拆小一点，或点下面的「继续」接着做。`
    case 'client_disconnect':
      return '页面已离开或连接断开，本轮已中止（服务端会同时停止调用上游，不会继续消耗额度）。'
    case 'shutdown':
      return '服务正在关闭或插件被卸载，本轮已中止。'
    default:
      return `本轮已取消（超时或客户端断开）${tail}`
  }
}

export interface LoopOptions {
  readonly llm: LlmService
  readonly principal: Principal
  /**
   * 这次提问的轮次标识（原样透传给工具执行体）。
   *
   * 与 `principal` 同一档：**必填**。写工具靠它把变更记进可回退的那一轮，
   * 而"忘了传"的表现是日志里多出一批无处归属的记录——在用户点回退之前完全不报错。
   * 客户端没带时为 `null`，但那是**明确表达"没有"**，由工具自己决定要不要在这种情况下动手。
   */
  readonly context: AiToolContext
  /** **已经收窄过**的工具表（交集由 `resolveTurnTools()` 负责，这里不再判权限） */
  readonly tools: readonly ResolvedTool[]
  readonly messages: readonly TurnMessage[]
  readonly page: PageHint | null
  readonly maxRounds: number
  readonly maxToolResultChars: number
  readonly maxHistoryMessages: number
  readonly signal: AbortSignal
}

/* ============================== 消息转换 ============================== */

/**
 * `TurnMessage` → `LlmMessage`。
 *
 * 丢掉 `name`（它只给界面看）；其余字段**逐字往返**。这个函数刻意做成纯映射，
 * 不做任何裁剪或补全——裁剪在 `buildMessages()`，那里一处就够。
 */
function toLlmMessages(messages: readonly TurnMessage[]): LlmMessage[] {
  return messages.map((m) => {
    const out: {
      role: TurnMessage['role']
      content: string
      toolCalls?: readonly LlmToolCall[]
      toolCallId?: string
    } = { role: m.role, content: m.content }
    if (m.toolCalls !== undefined) out.toolCalls = m.toolCalls
    if (m.toolCallId !== undefined) out.toolCallId = m.toolCallId
    return out
  })
}

function toToolDefs(tools: readonly ResolvedTool[]): LlmToolDef[] {
  return tools.map((t) => ({
    name: t.descriptor.name,
    description: t.descriptor.description,
    parameters: t.descriptor.parameters,
  }))
}

/** 把一行的换行与连续空白压平，供界面显示（`summary` 会进 DOM 的一行里） */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/* ============================== 工具执行 ============================== */

/**
 * 按预算截断工具结果，并**在文本里写明截断**。
 *
 * 这条 note 的措辞与 `@geewiki/ai-kb` 的 `read_page` 刻意一致：模型在别处见过同样的话，
 * 更容易把"该换 search_kb 定位"当成一条通用纪律，而不是一次性的特例说明。
 */
function truncateResult(content: string, budget: number): string {
  if (content.length <= budget) return content
  return (
    `${content.slice(0, budget)}\n\n` +
    `[本条工具结果共 ${content.length} 字符，上面只含前 ${budget} 字符。` +
    '**不要**据此断言"资料里没有相关内容"——请换更精确的查询词重新检索。]'
  )
}

/**
 * 执行一条工具并返回**给模型的**内容。
 *
 * 失败**不抛异常**：抛出去会让整个回合失败，而"某个工具这次没查到"是正常情况，
 * 模型应当看到失败原因并自己决定换一条路。错误文本经 `redact()` 脱敏
 * （工具内部报错可能夹带路径、URL 或凭据，而它会原样进模型上下文）。
 */
async function executeTool(
  tool: ResolvedTool,
  call: LlmToolCall,
  principal: Principal,
  context: AiToolContext,
  budget: number,
): Promise<{ content: string; ok: boolean; summary: string; grounding: AiToolGrounding | null }> {
  let result: AiToolResult
  try {
    result = await tool.execute(principal, parseArguments(call.arguments), context)
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err))
    return {
      content: JSON.stringify({ error: 'tool_failed', message, note: '该工具本次执行失败。可以换一条路，或如实告诉用户这次没查到。' }),
      ok: false,
      summary: `执行失败：${oneLine(message, 80)}`,
      // 失败没有产出任何资料——"跑了但没拿到"不算依据（与 search_kb 0 命中同一条判据）
      grounding: null,
    }
  }
  const content = truncateResult(result.content, budget)
  /*
   * ★ 依据看的是**这次返回了什么**，不是这个工具是什么。
   *
   * 逐字透传工具声明的出处，而**不是**在这里收窄成"是不是 kb"：收窄会把它压回一个布尔，
   * 界面就再也分不出"依据公开网络"与"来自模型自身知识"（见 `LoopOutcome.groundingSources`）。
   *
   * 截断不改变这条判据：截断后的内容仍然是那一家的资料（而且截断已在文本里写明）。
   * 但 `search_kb` 命中 0 条是另一回事——它跑了，却一个字都没给模型，
   * 于是它自己就不声明 `grounding`，这里落到 `null`。
   */
  return {
    content,
    ok: true,
    summary: oneLine(content, 120),
    grounding: result.grounding ?? null,
  }
}

/**
 * 解析模型产出的参数。
 *
 * **解析失败不是错误**，而是"模型给了个坏参数"这个事实——把它当成一条可读的说明交回去，
 * 模型下一轮通常会自己改对。这里**不抛**：抛出去等于把一次可恢复的模型失误
 * 升级成整轮对话失败。
 */
function parseArguments(raw: string): unknown {
  const text = raw.trim()
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { __invalid_arguments: raw }
  }
}

/* ============================== 主循环 ============================== */

/** 把一次 `done` chunk 的 usage 累加进总计（每轮都是一次独立的上游请求，成本应当相加） */
function addUsage(total: LlmUsage | null, next: LlmUsage | undefined): LlmUsage | null {
  if (next === undefined) return total
  return {
    promptTokens: (total?.promptTokens ?? 0) + (next.promptTokens ?? 0),
    completionTokens: (total?.completionTokens ?? 0) + (next.completionTokens ?? 0),
  }
}

/**
 * 跑一个回合。
 *
 * 返回的 `messages` 是**权威转录**——它包含客户端传来的历史、本轮助手消息、
 * 以及服务端执行掉的工具结果。客户端只需把它存下来，下一次原样带回。
 */
export async function runAgentLoop(
  opts: LoopOptions,
  emit: (ev: LoopEvent) => void,
): Promise<LoopOutcome> {
  const transcript: TurnMessage[] = [...opts.messages]
  const toolResults: ToolActivity[] = []
  const byName = new Map(opts.tools.map((t) => [t.descriptor.name, t]))
  const toolDefs = toToolDefs(opts.tools)
  let usage: LlmUsage | null = null
  let rounds = 0
  let lastText = ''
  /*
   * ★ 一旦拿到过知识库资料就**永远**是 true：这是"这次回答有没有依据"的单调量。
   * 后续轮次做了什么（改页面、跳转）都不会把已经读到的资料从上下文里拿走——
   * `transcript` 里那条 `tool` 消息一直在。把它做成"最后一轮有没有"会让
   * "先 read_page 再 page.update"这种最常见的组合被判成无依据。
   */
  let grounded = false
  /*
   * ★ 本回合声明过的**全部**出处，去重后按字典序排（`Set` 的迭代序是抵达顺序，
   * 而同一份事实应当在两次请求里是同一份字节）。它与 `grounded` 同时维护而不是互相推导：
   * 前者是"给界面标注用的完整清单"，后者是"有没有知识库依据"这个沿用已久的判据，
   * 两者共同的边界（失败 / 未声明 ⇒ 什么都不进）必须只有一处。
   */
  const groundingSources = new Set<AiToolGrounding>()
  /**
   * 本回合**执行过的**写工具名（跨轮累积、去重）。
   *
   * 为什么在执行处累加而不是从某帧的 `pending` 推导：见 {@link LoopOutcome.mutatingTools} 的注释
   * —— 模型"调用写工具后直接收尾"时最后一帧没有 pending，推导出来的名单恒为空，
   * 而那份名单正是"谁需要失效缓存/记日志"的唯一信号。
   */
  const executedMutating = new Set<string>()
  const groundingList = (): AiToolGrounding[] => [...groundingSources].sort()

  const finish = (
    partial: { answer: string | null; finishReason: TurnFinishReason; pending?: readonly LlmToolCall[] | null },
  ): LoopOutcome => ({
    messages: transcript,
    answer: partial.answer,
    finishReason: partial.finishReason,
    pendingToolCalls: partial.pending ?? null,
    mutatingTools: [...executedMutating],
    grounded,
    groundingSources: groundingList(),
    toolResults,
    usage,
    rounds,
    error: null,
  })

  for (let round = 0; round < opts.maxRounds; round++) {
    /*
     * 每轮开头先看信号：超时或客户端断开之后**不该再发起任何上游请求**。
     * 只在流读取的循环里判是不够的——那时请求已经发出去了，配额已经花了。
     */
    if (opts.signal.aborted) {
      return {
        messages: transcript,
        answer: null,
        finishReason: 'stop',
        pendingToolCalls: null,
        // 没有待客户端执行的调用 ⇒ 也就没有写操作要记（这些分支都是"提前收场"）
        mutatingTools: [...executedMutating],
        grounded,
        // 提前收场的分支也带这个字段：形状恒定，客户端不必判"有没有"
        groundingSources: groundingList(),
        toolResults,
        usage,
        rounds,
        error: { code: 'ABORTED', message: abortMessageOf(opts.signal.reason, toolResults.length) },
      }
    }
    rounds++

    /*
     * 每轮都重新组装消息表：这一轮新增的工具结果必须进去。
     * `tools` 键**只在有工具时才出现**——沿用 P0 定下的口径（不填 ≠ 发空数组），
     * 让"一个工具都没有"的请求与存量调用方逐字节一致。
     */
    /*
     * 系统提示在**这里**拼在最前，而不是在 `buildMessages()` 里。
     *
     * 分开的理由是类型：`TurnMessage.role` 刻意不含 `'system'`（客户端不得注入系统消息，
     * 见 `types.ts` 的红线 1），若让 `buildMessages()` 返回一个含 system 的数组，
     * 那个联合就得为"服务端自己拼的"和"客户端传来的"开一个口子——而一个口子
     * 在下一批就会被当成"system 其实是可以传的"。
     *
     * 于是规则变成一句话，任何读者都能一眼验证：**发给上游的第一条恒为系统提示，
     * 其余全部来自 `transcript`（外部输入）**。
     */
    const llmMessages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...toLlmMessages(
        buildMessages(transcript, { page: opts.page, maxHistoryMessages: opts.maxHistoryMessages }),
      ),
    ]
    const request = {
      messages: llmMessages,
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
    }

    let text = ''
    let finishReason: string | undefined
    const deltas: LlmToolCallDelta[] = []
    let errorCode: string | null = null

    for await (const chunk of opts.llm.stream(request, { signal: opts.signal })) {
      if (chunk.type === 'status') continue
      if (chunk.type === 'text-delta') {
        text += chunk.text
        emit({ type: 'delta', text: chunk.text })
        continue
      }
      /*
       * 思考内容**只往外发，不入账**：`text` 是这一轮的正文（要拼进 `messages` 回传上游），
       * 思考拼进去会让下一轮的上游请求带上 `reasoning_content`——多数网关拒收，
       * 个别会把它当成新的指令。它就是给人看的，别喂给模型。
       */
      if (chunk.type === 'reasoning-delta') {
        emit({ type: 'reasoning', text: chunk.text })
        continue
      }
      if (chunk.type === 'tool-call-delta') {
        deltas.push(chunk)
        continue
      }
      if (chunk.type === 'done') {
        finishReason = chunk.finishReason
        usage = addUsage(usage, chunk.usage)
        break
      }
      // chunk.type === 'error'
      errorCode = chunk.code
      break
    }

    if (opts.signal.aborted) {
      return {
        messages: transcript,
        answer: null,
        finishReason: 'stop',
        pendingToolCalls: null,
        // 没有待客户端执行的调用 ⇒ 也就没有写操作要记（这些分支都是"提前收场"）
        mutatingTools: [...executedMutating],
        grounded,
        // 提前收场的分支也带这个字段：形状恒定，客户端不必判"有没有"
        groundingSources: groundingList(),
        toolResults,
        usage,
        rounds,
        error: { code: 'ABORTED', message: abortMessageOf(opts.signal.reason, toolResults.length) },
      }
    }
    if (errorCode !== null) {
      /*
       * 两种"没能生成"必须说不同的话（照 `@geewiki/ai-qa` 的同一处取舍）：
       * `NO_ADAPTER` = 选路阶段就没有可用路由（该去查配置）；其余 = 路由是有的、
       * 请求真的发出去了、上游那样回的（该做的是稍后重试，不是去翻配置）。
       * 把后者说成"没有可用路由"，用户会照着去查一个根本没坏的地方。
       *
       * `error` chunk **刻意不带 message**（上游文本可能夹带密钥，见 `@geewiki/llm` 的类型注释），
       * 所以这句话只能由 code 现推——也正因如此，客户端**按 code 分支，不按 message 分支**。
       */
      const hint =
        errorCode === 'NO_ADAPTER'
          ? '当前没有已注册或可用（缺密钥 / 未就绪）的模型路由'
          : '请求已发往模型服务，是它拒绝了或没能及时返回；配置本身没问题，可稍后重试'
      return {
        messages: transcript,
        answer: null,
        finishReason: 'stop',
        pendingToolCalls: null,
        // 没有待客户端执行的调用 ⇒ 也就没有写操作要记（这些分支都是"提前收场"）
        mutatingTools: [...executedMutating],
        grounded,
        // 提前收场的分支也带这个字段：形状恒定，客户端不必判"有没有"
        groundingSources: groundingList(),
        toolResults,
        usage,
        rounds,
        error: { code: errorCode, message: `模型调用失败（${errorCode}）：${hint}` },
      }
    }

    const calls = assembleToolCalls(deltas)
    lastText = text

    /*
     * 上游没给 id 的调用：整轮失败，不猜、不丢。
     * 见文件头硬约束 2——丢掉它会让模型以为调过了。
     */
    const missingId = calls.find((c) => c.id === '')
    if (missingId !== undefined) {
      transcript.push({ role: 'assistant', content: text })
      return {
        messages: transcript,
        answer: null,
        finishReason: 'stop',
        pendingToolCalls: null,
        // 没有待客户端执行的调用 ⇒ 也就没有写操作要记（这些分支都是"提前收场"）
        mutatingTools: [...executedMutating],
        grounded,
        // 提前收场的分支也带这个字段：形状恒定，客户端不必判"有没有"
        groundingSources: groundingList(),
        toolResults,
        usage,
        rounds,
        error: {
          code: 'invalid_tool_call',
          message: `上游返回的工具调用缺少 id（工具 ${missingId.name}），无法把它与结果配对，本回合终止`,
        },
      }
    }

    transcript.push({
      role: 'assistant',
      content: text,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    })

    if (calls.length === 0) {
      return finish({
        answer: text,
        // `length` 意味着这句话可能是半截的——如实透传，不假装正常收尾
        finishReason: finishReason === 'length' ? 'length' : 'stop',
      })
    }

    /* ---- 分流：服务端自己跑 / 交给客户端 / 模型报了个不存在的名字 ---- */
    /**
     * 记一条活动并**同时**外发。
     *
     * 两件事必须一起发生：漏掉 `toolResults` 则界面拿不到最终清单，
     * 漏掉 `emit` 则回答期间界面一片死寂。分开写在两处迟早会漏掉一边，
     * 所以这里只有一个出口。
     */
    const record = (activity: ToolActivity): void => {
      toolResults.push(activity)
      emit({ type: 'tool-end', activity })
    }
    const clientCalls: LlmToolCall[] = []
    for (const call of calls) {
      const tool = byName.get(call.name)
      /*
       * 写工具在**调用处**就登记（而不是等执行结果）：名单的用途是"这一回合动过东西吗"，
       * 而"动过"这件事在模型决定调它的那一刻就确定了需要下游关心；执行失败时下游多刷一次，
       * 代价远小于"改了却不刷新"。客户端侧的写工具也一并登记——同一条判据、同一份名单。
       */
      if (tool?.descriptor.mutating === true) executedMutating.add(call.name)

      /*
       * 先分「名字在不在表里」，再分「在哪一侧执行」。
       *
       * 两个判定**必须分成两步**而不是合成一个三元表达式：合并之后 TypeScript
       * 无法把 `tool` 收窄成非空（`noUncheckedIndexedAccess` 下 `Map.get` 恒带 undefined），
       * 于是真正执行时要么加一个 `!`、要么加一次假的空值判断——两者都是在用注释
       * 掩盖一个本可以结构上成立的事实。分开写之后，走到执行那一行时 `tool` 已确定为
       * `ResolvedTool`，编译器与读者看到的是同一件事。
       */
      if (tool === undefined) {
        /*
         * 模型报了一个不存在的工具名。**仍要留下配对的结果消息**（硬约束 1），
         * 但绝不能真去执行什么——名字不在收窄后的交集里，就没有任何东西可执行。
         *
         * `side` 只标服务端：它**确实由服务端就地回绝**，界面上表现为一条立刻完成的
         * 失败活动，比让它悬在客户端一侧准确。
         */
        emit({ type: 'tool-start', id: call.id, name: call.name, side: 'server', arguments: call.arguments })
        const content = JSON.stringify({
          error: 'unknown_tool',
          message: `没有名为 ${call.name} 的工具。可用工具见本轮工具表；不要臆造工具名。`,
        })
        transcript.push({ role: 'tool', content, toolCallId: call.id, name: call.name })
        record({
          id: call.id,
          name: call.name,
          side: 'server',
          arguments: call.arguments,
          ok: false,
          summary: '未知工具（未执行）',
        })
        continue
      }

      if (tool.descriptor.side === 'client') {
        // 客户端工具不在这里执行，也不外发活动——它由客户端自己跑并回报
        clientCalls.push(call)
        continue
      }

      emit({ type: 'tool-start', id: call.id, name: call.name, side: 'server', arguments: call.arguments })
      const outcome = await executeTool(tool, call, opts.principal, opts.context, opts.maxToolResultChars)
      transcript.push({ role: 'tool', content: outcome.content, toolCallId: call.id, name: call.name })
      /*
       * `grounded` 只认 `'kb'`（它问的是"有没有知识库依据"）；`groundingSources` 收全部档。
       * 两个判断写法不同不是笔误：把任何档都塞进 `grounded` 会让「依据公开网络」
       * 在界面上变成"有知识库依据"，那正是需求 ⑥ 要消灭的误读。
       */
      if (outcome.grounding !== null) groundingSources.add(outcome.grounding)
      if (outcome.grounding === 'kb') grounded = true
      record({
        id: call.id,
        name: call.name,
        side: 'server',
        arguments: call.arguments,
        ok: outcome.ok,
        summary: outcome.summary,
      })
    }

    if (clientCalls.length > 0) {
      /*
       * 有客户端工具要跑：把控制权交回去。
       *
       * 注意此时**服务端该跑的都跑完了**，它们的结果已经在 `transcript` 里，
       * 随 `done.messages` 一起回到客户端。客户端只需要补上 `clientCalls` 的结果、
       * 带上整份转录再发一轮——服务端不需要记得任何东西。
       */
      return finish({ answer: null, finishReason: 'tool_calls', pending: clientCalls })
    }
  }

  /*
   * 撞上轮次上限：模型一直在调工具但始终没收口。
   * **如实说**（`rounds` + `partial`），而不是把最后一轮的半截文本当成正常回答——
   * 用户看到一段没写完的话却不知道为什么，比看到"这次没查完"更糟。
   */
  return finish({ answer: lastText === '' ? null : lastText, finishReason: 'rounds' })
}
