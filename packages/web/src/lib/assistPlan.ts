/**
 * AI 辅助写作的**纯逻辑**（无 React、无网络）—— 单测靶子。
 *
 * 放在这里的每一条都是"错了但不会报错"的那类判断：动作可用性、上下文截断方向、
 * 降级文案映射、写回落点。它们一旦漂移，表现是"AI 输出莫名其妙"而不是崩溃，
 * 因此必须有独立的单测钉住（render 测试抓不到这些）。
 */
import type { AiAssistAction, Degraded } from '../api'

/** 与后端 `ASSIST_TEXT_MAX` 一致：**同一口径两份真源**，故此处注明镜像关系并由单测断言取值。 */
export const ASSIST_TEXT_LIMIT = 4000

/** 四个动作的中文标签（按钮与预览弹窗共用，避免两处各写一份） */
export const ASSIST_ACTION_LABEL: Readonly<Record<AiAssistAction, string>> = {
  continue: '续写',
  rewrite: '改写选中',
  polish: '润色',
  summarize: '摘要',
}

/** 动作顺序即按钮顺序：从"最常用"到"最重" */
export const ASSIST_ACTION_ORDER: readonly AiAssistAction[] = ['continue', 'rewrite', 'polish', 'summarize']

export interface AssistSelection {
  from: number
  to: number
  text: string
}

/**
 * 选区是否算"有内容可处理"。
 *
 * 纯空白不算：用户只是敲了几个空格或换行时，"改写选中"没有意义，
 * 给一个点了必然得到废话的按钮比禁用更糟。
 */
export function hasUsableSelection(sel: AssistSelection | null): boolean {
  return sel !== null && sel.text.trim() !== ''
}

/**
 * 计算此刻哪些动作可用。
 *
 * 规则（与后端 `missingInput` 必须一致，否则会出现"点了却被 400 拒绝"的按钮）：
 * - `continue`：需要光标**之前**有内容（文首无内容时无处可续）
 * - `rewrite` / `polish`：需要**非空白选区**
 * - `summarize`：有全文即可（选区与全文都行）
 */
export function availableActions(input: { selection: AssistSelection | null; docText: string }): AiAssistAction[] {
  const hasSel = hasUsableSelection(input.selection)
  const hasDoc = input.docText.trim() !== ''
  const out: AiAssistAction[] = []
  if (hasDoc) out.push('continue')
  if (hasSel) out.push('rewrite', 'polish')
  if (hasDoc || hasSel) out.push('summarize')
  return out
}

/**
 * 从**靠近光标的一侧**截断文本（保留最近的内容）。
 *
 * 为什么方向重要：续写要用"光标前的文本"，越靠近光标的句子越相关。若从头截断，
 * 长文的结尾（也就是模型真正需要接续的地方）会被整段丢掉，输出会显得"跑题"。
 * `fromStart = true` 用于摘要这类"开头更重要"的场景（标题与首段决定全文主旨）。
 */
export function clampContext(text: string, fromStart: boolean, limit = ASSIST_TEXT_LIMIT): string {
  if (text.length <= limit) return text
  return fromStart ? text.slice(0, limit) : text.slice(text.length - limit)
}

/** 光标前的文本：从 `from` 往前取，并**按靠近光标的一侧**截断 */
export function beforeCursor(docText: string, cursorPos: number): string {
  const before = docText.slice(0, Math.max(0, Math.min(cursorPos, docText.length)))
  return clampContext(before, false)
}

/** 组装请求体：只发送该动作真正需要的字段，避免把整篇正文无谓地发给服务端 */
export function buildAssistRequest(input: {
  action: AiAssistAction
  selection: AssistSelection | null
  docText: string
  title: string
  slug: string
}): { action: AiAssistAction; selection?: string; before?: string; title?: string; slug?: string } {
  const body: { action: AiAssistAction; selection?: string; before?: string; title?: string; slug?: string } = {
    action: input.action,
  }
  const sel = hasUsableSelection(input.selection) ? input.selection : null
  if (input.action === 'continue') {
    body.before = beforeCursor(input.docText, sel === null ? input.docText.length : sel.from)
  } else if (input.action === 'summarize') {
    // 摘要优先用选区（用户明确圈定的范围），没选区就用全文的开头部分
    if (sel !== null) body.selection = clampContext(sel.text, false)
    else body.before = clampContext(input.docText, true)
  } else {
    body.selection = clampContext(sel === null ? '' : sel.text, false)
  }
  if (input.title !== '') body.title = input.title
  if (input.slug !== '') body.slug = input.slug
  return body
}

/** 降级/不可用时给用户看的文案（**必须与 `title` 属性区分开：这条要能读屏**） */
export function unavailableText(input: {
  /** `@geewiki/ai` 插件是否已激活（未激活时端点 404） */
  pluginActive: boolean
  /** `GET /api/ai/capabilities` 的 available */
  modelAvailable: boolean
  degraded: Degraded | null
}): string {
  if (!input.pluginActive) return '未启用智能问答插件：AI 辅助写作需要 @geewiki/ai，可在插件管理中启用。'
  if (input.degraded !== null && input.degraded.code === 'MISSING_CREDENTIAL') {
    return '已注册模型路由但缺少凭据：请在插件配置里设置密钥环境变量名，检索与问答仍可用。'
  }
  if (input.degraded !== null && input.degraded.code === 'NO_ADAPTER') {
    return '没有可用的模型路由：AI 辅助写作需要模型，检索与问答仍可用。'
  }
  if (!input.modelAvailable) return '未配置模型密钥：AI 辅助写作需要模型，检索与问答仍可用。'
  return ''
}

/** 预览弹窗里"采纳"按钮的文案（落点不同，措辞必须不同，否则用户不知道会改哪里） */
export function applyLabel(action: AiAssistAction): string {
  return action === 'continue' ? '插入到光标处' : '替换选中内容'
}

/**
 * 采纳时的写回文案（供 `role="status"` 播报）。
 *
 * 摘要不写回正文（它是给用户看的结果，不是要粘进文章的段落），
 * 因此这里只对"可写回"的三个动作给文案，摘要走"复制"路径。
 */
export function appliedText(action: AiAssistAction): string {
  if (action === 'continue') return '已插入 AI 续写的内容（⌘Z 可撤销）'
  if (action === 'summarize') return '摘要仅供查看，不会写入正文'
  return `已用 AI ${ASSIST_ACTION_LABEL[action]}的结果替换选中内容（⌘Z 可撤销）`
}

/** 摘要是否可写回正文：只有它不可（避免把"摘要"当成段落粘进文章） */
export function canApplyToBody(action: AiAssistAction): boolean {
  return action !== 'summarize'
}
