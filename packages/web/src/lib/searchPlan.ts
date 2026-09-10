/**
 * 检索/问答的**纯逻辑**（不接触 DOM/window），因此可在 node 下单测。
 *
 * 这里放两类最容易做错、也最值得钉住的判断：
 * 1. **`snippet` 的渲染方式**——它由服务端 HTML 转义并注入 `<mark>`，
 *    前端**不得二次转义**（会显示成字面 `&lt;mark&gt;`），也不得当纯文本（会丢高亮）。
 *    下面的 {@link snippetToHtml} 是唯一出口，并**顺带做一次白名单消毒**：
 *    只允许 `<mark>`，其余标签一律转义——即使服务端将来改了契约（或某条数据被污染），
 *    也不会把任意 HTML 注入宿主页面。
 * 2. **降级文案**——按 `degraded.reason`（稳定枚举）分叉，**绝不按 `message` 文本分支**。
 */
import type { Degraded, DegradedReason } from '../api'

/** 查询串上限（与后端 `MAX_QUERY_LENGTH` 一致：`packages/plugin-ai/src/index.ts` 的 500） */
export const MAX_QUERY_LENGTH = 500

/** 片段里允许出现的标签：只有 `<mark>`（服务端高亮的唯一产物） */
const ALLOWED_MARK = /<mark>/gi

/** 匹配"标签或裸的尖括号"：`<...>`、孤立的 `<`、孤立的 `>` */
const TAG_OR_BRACKET = /<[^>]*>|<|>/g

/**
 * 服务端片段 → 可安全注入的 HTML。
 *
 * 服务端（`packages/plugin-search/src/index.ts` 的 `buildSnippet`）已把正文 HTML 转义，
 * 再把命中词包进 `<mark>`，所以正常输入形如 `foo &lt;b&gt; <mark>命中</mark> bar`。
 *
 * 本函数**逐字符保真**，只做一件事：把**除了 `<mark>` / `</mark>` 之外**的标签与裸尖括号
 * 转义掉（白名单消毒）。关键是**不能对整串再转义一遍**——那会把正文里已有的 `&lt;`
 * 变成 `&amp;lt;`，用户就会看到字面的 `&lt;`（这就是"二次转义"的经典症状）。
 * 因此这里只替换"尖括号片段"，已有的实体（`&amp;`/`&lt;`/`&quot;`…）原样保留。
 *
 * 消毒意义：即使服务端契约将来放宽、或某条数据被污染，也不会把任意标签/事件属性
 * 注入宿主页面（`<mark onclick=…>` 这种带属性的形式不匹配白名单，会被转义）。
 */
export function snippetToHtml(snippet: string): string {
  return snippet.replace(TAG_OR_BRACKET, (token) =>
    /^<\/?mark>$/i.test(token) ? token.toLowerCase() : escapeHtml(token),
  )
}

/** HTML 转义（与 `packages/plugin-search/src/index.ts` 的 `escapeHtml` 同规则） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 片段里是否真的带高亮（用于测试与排障，不参与渲染决策） */
export function hasHighlight(snippet: string): boolean {
  return ALLOWED_MARK.test(snippet)
}

/** 前端预检查询串：空/超长在本地就拦下并给出明确文案（同时仍容忍后端 400） */
export function checkQuery(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim()
  if (value === '') return { ok: false, message: '请输入查询内容' }
  if (value.length > MAX_QUERY_LENGTH) {
    return { ok: false, message: `查询过长（${value.length} 字符，上限 ${MAX_QUERY_LENGTH}）` }
  }
  return { ok: true, value }
}

/** 降级提示条的文案：`title` 简短、`detail` 补充说明（均按 reason 分叉） */
export interface DegradedNotice {
  title: string
  detail: string
  /** 语义级别：info = 信息性（结果照常可用，不要用红色淹没）；warn = 需要留意 */
  level: 'info' | 'warn'
}

const REASON_NOTICE: Record<DegradedReason, DegradedNotice> = {
  no_provider: {
    title: '未配置模型密钥，以下为检索结果与摘要',
    detail: '启用模型插件并配置密钥后，回答将由模型基于这些来源生成。',
    level: 'info',
  },
  missing_credential: {
    title: '未配置模型密钥，以下为检索结果与摘要',
    detail: '启用模型插件并配置密钥后，回答将由模型基于这些来源生成。',
    level: 'info',
  },
  invalid_credential: { title: '模型凭据无效，已降级为检索结果', detail: '请检查密钥配置。', level: 'warn' },
  rate_limit: { title: '模型调用被限流，已降级为检索结果', detail: '稍后重试可恢复。', level: 'warn' },
  timeout: { title: '模型调用超时，已降级为检索结果', detail: '检索结果不受影响。', level: 'warn' },
  context_window_exceeded: {
    title: '命中内容超出模型上下文，已自动截断',
    detail: '标注「未引用」的来源没有进入模型上下文。',
    level: 'info',
  },
  network: { title: '模型网络异常，已降级为检索结果', detail: '检索结果不受影响。', level: 'warn' },
  provider_error: { title: '模型调用失败，已降级为检索结果', detail: '检索结果不受影响。', level: 'warn' },
  search_unavailable: { title: '检索服务不可用', detail: '请先启用检索插件（@geewiki/search）。', level: 'warn' },
  empty_query: { title: '查询为空', detail: '请输入要检索的内容。', level: 'warn' },
}

/**
 * 把 `degraded` 映射成提示条。
 *
 * 未知 reason（后端将来新增枚举而前端未更新）→ 回退到通用文案并带上 `message`，
 * **绝不 throw**——降级提示本身不该成为新的故障点。
 */
export function degradedNotice(degraded: Degraded | null | undefined): DegradedNotice | null {
  if (!degraded) return null
  const known = REASON_NOTICE[degraded.reason]
  if (known) return { ...known, detail: degraded.message || known.detail }
  return {
    title: '已降级为检索结果',
    detail: degraded.message || '模型不可用，以下为检索结果。',
    level: 'warn',
  }
}

/** 回答格式 → 渲染方式（markdown 必须经 `lib/sanitize.ts` 的 `mdToHtml` 消毒） */
export function answerRenderer(format: 'markdown' | 'plain' | undefined): 'markdown' | 'plain' {
  return format === 'markdown' ? 'markdown' : 'plain'
}
