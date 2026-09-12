/**
 * 编辑器 AI 辅助（`POST /api/ai/assist`）—— 纯生成端点，**不做任何检索**。
 *
 * ## 为什么单独一个文件
 *
 * 本文件承载三条**必须能被机器检查**的硬规则，单独成文件才能让守卫测试用
 * "整个文件里不得出现某标识符"这种最不易漂移的方式钉住：
 *
 * 1. **上下文只来自调用方给的文本**：`selection` / `before` 由前端从编辑器缓冲区
 *    取出并随请求发来，服务端**不读任何页面正文、不查任何索引**。这是块级权限红线 ——
 *    用户看不到的受限段落，从结构上就不可能进入模型上下文（不是"我们记得过滤"，
 *    而是"这里根本没有取正文的代码路径"）。
 * 2. **`slug` 只用于权限校验**：绝不用于取正文。若将来有人用 slug 去读页面正文，
 *    那就是把"AI 辅助"变成"服务端替他读取页面"，红线当场失守。
 * 3. **没有模型就明确不可用**：`text` 恒为 `null` + `degraded` 指明原因，
 *    **绝不**用抽取式摘要（那属于问答能力）冒充续写/改写。
 *
 * ## 与 `/api/ai/ask` 的分工
 *
 * `ask` 是"检索 + 生成"，`assist` 是"只有生成"。两者共用同一份降级投影与脱敏出口；
 * 本文件**不自己做 HTTP body 读取**（由 index.ts 传入已解析的 JSON），
 * 因此整个模块可以用纯函数单测驱动，不必起服务。
 */
import { type LlmErrorCode, type LlmMessage, type LlmService } from '@geewiki/llm'
import { degradedFromCode, makeDegraded } from './degrade.js'
import type { AiAssistAction, AiAssistResponse, Degraded } from './types.js'

/** 四个动作（MVP）。用 `as const` 保证运行时校验与类型同源，不手写第二份清单。 */
export const ASSIST_ACTIONS = ['continue', 'rewrite', 'polish', 'summarize'] as const

/**
 * 单段文本上限（字符）。
 *
 * 为什么是 4000：模型上下文按 token 计费，而本端点的输入是**用户自己编辑器里的文本**，
 * 4000 字 ≈ 中文两三屏，足够覆盖"续写/改写一段"的真实用法；更长的输入由前端
 * 按"靠近光标的一侧"截断（见 `packages/web/src/lib/assistPlan.ts`），
 * 而不是让服务端静默丢弃用户看不见的部分。
 */
export const ASSIST_TEXT_MAX = 4000

/** `maxTokens` 的上下界：写作产物比问答短，故上界低于 `AiConfigSchema.maxAnswerTokens` 的 20000 */
export const ASSIST_MIN_TOKENS = 1
export const ASSIST_MAX_TOKENS = 2048

/** 各动作的默认 token 预算（按产物预期长度区分，不搞"一刀切"） */
const TOKEN_BUDGET: Readonly<Record<AiAssistAction, number>> = {
  continue: 512,
  rewrite: 1024,
  polish: 1024,
  summarize: 512,
}

/**
 * 每个动作的系统提示词。
 *
 * 纪律：只描述"写作任务"，**不掺入任何本站语义**（不提权限、不提页面、不提检索）——
 * 模型看不到除用户文本以外的任何东西，提示词也不该暗示它能看到。
 */
const SYSTEM_PROMPTS: Readonly<Record<AiAssistAction, string>> = {
  continue:
    '你是中文技术写作助手。请在用户给出的片段之后顺势续写，保持原有语气、人称与 Markdown 结构。' +
    '只输出续写的正文本身，不要复述已有内容、不要解释你在做什么、不要加代码围栏。',
  rewrite:
    '你是中文技术写作助手。请改写用户给出的段落：保留全部事实与结论，改善结构与表达。' +
    '只输出改写后的段落本身，不要解释改动、不要加代码围栏。',
  polish:
    '你是中文校对助手。请润色用户给出的段落：修正错别字、标点与病句，保持原意与篇幅。' +
    '只输出润色后的段落本身，不要解释改动、不要加代码围栏。',
  summarize:
    '你是中文摘要助手。请为用户给出的内容写一段简明摘要（不超过原内容四分之一）。' +
    '只输出摘要本身，不要加标题、不要加代码围栏。',
}

/** 各动作对输入的硬性要求：`continue` 要 `before`，其余要 `selection`（摘要允许退回 before） */
export function missingInput(action: AiAssistAction, hasSelection: boolean, hasBefore: boolean): string | null {
  if (action === 'continue') return hasBefore ? null : 'continue 需要提供 before（光标前的文本）'
  if (action === 'summarize') return hasSelection || hasBefore ? null : 'summarize 需要提供 selection 或 before'
  return hasSelection ? null : `${action} 需要提供 selection（选中的文本）`
}

/** 拼装给模型的 messages：**只含系统提示词与用户文本**，没有任何其它来源 */
export function buildAssistMessages(
  action: AiAssistAction,
  input: { selection: string; before: string; title: string },
): LlmMessage[] {
  const parts: string[] = []
  // 标题只作为语气与主题的提示，**不是内容来源**；它同样来自用户当前正在编辑的页面。
  if (input.title !== '') parts.push(`（本文标题：${input.title}）`)
  if (action === 'continue') parts.push(`以下是我已写好的内容，请接着写下去：\n\n${input.before}`)
  else if (action === 'summarize' && input.selection === '') parts.push(`请为以下内容写摘要：\n\n${input.before}`)
  else parts.push(`以下是需要处理的段落：\n\n${input.selection}`)
  return [
    { role: 'system', content: SYSTEM_PROMPTS[action] },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/** 校验失败的信封（与 index.ts 的 `h.json` 参数同形，便于直接透传） */
export interface AssistInputError {
  ok: false
  status: number
  error: string
  message: string
}

export interface AssistInput {
  action: AiAssistAction
  selection: string
  before: string
  title: string
  slug: string
  maxTokens: number
}

/**
 * 解析并**全量校验**请求体。与 HTTP 层解耦，便于单测直接驱动。
 *
 * 未知字段一律 400（不静默忽略）：拼错字段名却"看起来成功"是最难排查的一类缺陷。
 */
export function parseAssistBody(raw: unknown): { ok: true; value: AssistInput } | AssistInputError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'invalid_body', message: '请求体须为 JSON 对象' }
  }
  const body = raw as Record<string, unknown>
  const allowed = ['action', 'selection', 'before', 'title', 'slug', 'maxTokens']
  const unknownKeys = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknownKeys.length > 0) {
    return { ok: false, status: 400, error: 'invalid_body', message: `未知字段: ${unknownKeys.join(', ')}` }
  }
  const action = body['action']
  if (typeof action !== 'string' || !(ASSIST_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_action',
      message: `action 必须是 ${ASSIST_ACTIONS.join(' / ')} 之一`,
    }
  }
  const pick = (key: string): string | AssistInputError => {
    const v = body[key]
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string') return { ok: false, status: 400, error: 'invalid_body', message: `${key} 必须是字符串` }
    if (v.length > ASSIST_TEXT_MAX) {
      return {
        ok: false,
        status: 400,
        error: 'payload_too_large',
        message: `${key} 超过上限（${ASSIST_TEXT_MAX} 字符）`,
      }
    }
    return v
  }
  const selection = pick('selection')
  if (typeof selection !== 'string') return selection
  const before = pick('before')
  if (typeof before !== 'string') return before
  const title = pick('title')
  if (typeof title !== 'string') return title
  const slug = pick('slug')
  if (typeof slug !== 'string') return slug

  const typedAction = action as AiAssistAction
  const missing = missingInput(typedAction, selection.trim() !== '', before.trim() !== '')
  if (missing !== null) return { ok: false, status: 400, error: 'invalid_body', message: missing }

  let maxTokens = TOKEN_BUDGET[typedAction]
  const rawMax = body['maxTokens']
  if (rawMax !== undefined && rawMax !== null) {
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax)) {
      return { ok: false, status: 400, error: 'invalid_maxTokens', message: 'maxTokens 必须是整数' }
    }
    if (rawMax < ASSIST_MIN_TOKENS || rawMax > ASSIST_MAX_TOKENS) {
      return {
        ok: false,
        status: 400,
        error: 'invalid_maxTokens',
        message: `maxTokens 必须在 ${ASSIST_MIN_TOKENS}..${ASSIST_MAX_TOKENS} 之间`,
      }
    }
    maxTokens = rawMax
  }

  return { ok: true, value: { action: typedAction, selection, before, title, slug: slug.trim(), maxTokens } }
}

/** 页面访问结论里本模块需要的两个字段（结构化子集，避免引入跨包类型依赖） */
export interface AssistPageAccess {
  level: string
  canEdit: boolean
}

/** 把 `policy-service.resolvePage` 的结论收成"这一页能不能编辑"（缺失即**失败关闭**） */
export function pageEditableFrom(access: AssistPageAccess | null | undefined): boolean {
  if (!access) return false
  if (access.level === 'none') return false
  return access.canEdit === true
}

/**
 * 本模块只依赖主体的这两个字段（结构化子集）。
 *
 * 为什么不直接 import `@geewiki/core` 的 `Principal`：`@geewiki/ai` 的 dependencies 里
 * 只有 core/llm/cordis/schemastery，引入业务主体类型会让本模块与鉴权实现耦合；
 * 而"是不是有编辑权"这件事的判据只有 `kind` 与 `orgRole` 两项，用结构化子集
 * 反而让守卫测试更好写（假主体不必造全字段）。
 */
export interface AssistPrincipal {
  kind?: string
  orgRole?: string | null
}

/** 主体是否具备写作能力：与 `plugin-auth` 下发的 `editContent` 同一判据（owner/admin/member） */
export function hasEditContent(principal: AssistPrincipal | undefined): boolean {
  if (!principal || principal.kind !== 'user') return false
  return principal.orgRole === 'owner' || principal.orgRole === 'admin' || principal.orgRole === 'member'
}

/** 依赖注入面：让核心逻辑可在单测里用假实现驱动 */
export interface AssistDeps {
  /** 取 llm-service（未激活时返回 undefined ⇒ 按 no_provider 降级） */
  getLlm(): LlmService | undefined
  /** 判定某页面对该主体是否可编辑；`policy-service` 缺失时返回 null ⇒ 失败关闭 */
  resolveEditAccess(
    principal: AssistPrincipal | undefined,
    slug: string,
  ): Promise<AssistPageAccess | null>
  /** 生成前的降级投影（与问答出口共用同一份实现，保证"意图"与"结果"一致） */
  preGenerationDegraded(): Degraded | null
}

/** 端点结果：`assist()` 的返回值，由 index.ts 翻译成 HTTP */
export interface AssistOutcome {
  status: number
  body: AiAssistResponse | { ok: false; error: string; message: string }
}

/**
 * 端点核心。**注意顺序**：先校验输入 → 再判权限 → 再看降级 → 最后才调模型。
 *
 * 为什么权限在降级之前：否则"没配密钥"会变成一条**权限探测通道**——
 * 无编辑权的人也能从响应差异里分辨出"这个 slug 存在且我能问/不能问"。
 */
export async function assist(
  principal: AssistPrincipal | undefined,
  rawBody: unknown,
  deps: AssistDeps,
): Promise<AssistOutcome> {
  const started = Date.now()
  const parsed = parseAssistBody(rawBody)
  if (!parsed.ok) {
    return { status: parsed.status, body: { ok: false, error: parsed.error, message: parsed.message } }
  }
  const { action, selection, before, title, slug, maxTokens } = parsed.value

  if (!hasEditContent(principal)) {
    /*
      匿名与「已登录但无编辑权」**给同一个 403**，不区分 401/403。
      理由：本端点的能力判据只有一条（能不能改内容），区分两者会把响应变成
      "你是否已登录"的探测口；也与仓库既有的拒绝语义一致（少泄露优先）。
      代价是设计契约里写的 401 在真实链路上不会出现 —— 这是**有意的偏离**，不是遗漏。
    */
    return {
      status: 403,
      body: { ok: false, error: 'forbidden', message: '没有编辑知识库内容的能力，AI 辅助写作不可用' },
    }
  }
  // 带 slug 时收紧到该页的编辑权限：与"能改这一页"同权，
  // 不用 administer（运维能力）也不用 manageVisibility（改谁能看）。
  // ⚠️ slug 到此为止只用于这一次判定，绝不用于读取正文（见文件头硬规则 2）。
  if (slug !== '') {
    const access = await deps.resolveEditAccess(principal, slug)
    if (!pageEditableFrom(access)) {
      return {
        status: 403,
        body: { ok: false, error: 'forbidden', message: '没有编辑该条目的权限，AI 辅助写作不可用' },
      }
    }
  }

  const unavailable = (degraded: Degraded): AssistOutcome => ({
    status: 502,
    body: { ok: false, mode: 'unavailable', action, text: null, degraded, elapsedMs: Date.now() - started },
  })

  const pre = deps.preGenerationDegraded()
  if (pre !== null) {
    // 没模型：**明确不可用**。不生成任何文本、不退化成抽取式摘要。
    return unavailable(pre)
  }
  const llm = deps.getLlm()
  if (!llm) {
    return unavailable(makeDegraded('no_provider', null, 'llm-service 不可用（@geewiki/llm 未激活）'))
  }

  const messages = buildAssistMessages(action, { selection, before, title })
  let text = ''
  let errorCode: LlmErrorCode | null = null
  try {
    for await (const chunk of llm.stream({
      messages,
      maxTokens,
      // 写作比问答需要更多自由度；仍偏低，避免"自由发挥"式改写。
      temperature: 0.3,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'done') break
      else if (chunk.type === 'error') {
        errorCode = chunk.code
        break
      }
    }
  } catch (err) {
    // 契约保证 stream 不抛；真抛了按 provider_error 降级而不是 500
    errorCode = 'PROVIDER_ERROR'
    console.warn(
      `[@geewiki/ai] assist: llm.stream 意外抛错（已脱敏）: ${err instanceof Error ? String(err.message).slice(0, 200) : 'unknown'}`,
    )
  }
  if (errorCode !== null) {
    return unavailable(degradedFromCode(errorCode, `模型不可用（${errorCode}）。AI 辅助写作需要模型。`))
  }

  return {
    status: 200,
    body: { ok: true, mode: 'generated', action, text, degraded: null, elapsedMs: Date.now() - started },
  }
}
