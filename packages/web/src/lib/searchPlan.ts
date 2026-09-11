/**
 * 检索/问答的**纯逻辑**（不接触 DOM/window），因此可在 node 下单测。
 *
 * 这里放两类最容易做错、也最值得钉住的判断：
 * 1. **`snippet` 的渲染方式**——它由服务端 HTML 转义并注入 `<mark>`，
 *    前端**不得二次转义**（会显示成字面 `&lt;mark&gt;`），也不得当纯文本（会丢高亮）。
 *    下面的 {@link snippetToHtml} 是唯一出口，并**顺带做一次白名单消毒**：
 *    只允许 `<mark>`，其余标签一律转义——即使服务端将来改了契约（或某条数据被污染），
 *    也不会把任意 HTML 注入宿主页面。
 * 2. **相关度呈现**——后端给的是**取负后的 BM25**（越大越相关），但它**不是归一化分数**：
 *    值域无界、量级随语料规模与查询词变化。实测本仓库语料下只有 `1e-6 ~ 2e-6` 量级，
 *    直接 `toFixed(2)` 会**恒为 `0.00`**（等于没有信息量、还误导用户"分数都为零"）。
 *    因此只呈现**同一次查询内的相对值**（见 {@link scoreBadges}），绝不呈现绝对值。
 * 3. **降级文案**——按 `degraded.reason`（稳定枚举）分叉，**绝不按 `message` 文本分支**。
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

/* ------------------------- 相关度呈现 ------------------------- */

/** 需要相关度徽标的命中（与 `api.ts` 的 `SearchHit` 结构兼容，便于直接传入） */
export interface ScoredHit {
  score: number
}

/** 一条命中的相关度徽标（纯数据，调用方直接渲染） */
export interface ScoreBadge {
  /** 展示文本：`100%` / `60%` / `<1%` / `0%` / `关键词匹配` */
  label: string
  /** 悬停说明：已含"相对值、非绝对相关度、仅同次查询内可比"的限定 */
  title: string
  /** 是否为本次最高分（可能并列）——调用方可用于加亮 */
  top: boolean
  /** 该结果只是关键词匹配（`like` 兜底路径），后端不产生相关度分 */
  keywordOnly: boolean
}

/** 每次呈现都必须带上的限定语：后端给的是绝对量级不定的 BM25，只有相对关系有意义 */
const RELATIVE_HINT = '相对值，非绝对相关度；仅同一次查询内可比'

/** `like` 兜底路径（命中全部零分）的统一徽标：明确说明"没有分数"而不是显示 `0%` */
const KEYWORD_ONLY_LABEL = '关键词匹配'

/**
 * 把后端返回的 `score` 数组转成**可渲染的相对相关度徽标**（与入参等长、同序）。
 *
 * 语义（**只呈现相对值**）：
 * - 以本次结果的**最高分**为基准：最高分 → `100%`，其余 → 相对最高分的百分比（取整）；
 *   并列最高分时**都为 `100%`**（它们确实同等相关）。
 * - 非最高分**永不超过 `99%`**（避免出现两个 `100%` 造成歧义）。
 * - 正分但不足最高分的 `0.5%` → `<1%`（不显示 `0%`，否则与"真的没有分"混淆）。
 * - **本次没有任何正分**（`like` 兜底路径的典型情形，实测 `score` 恒为 0）→ 全部标
 *   `关键词匹配`，**绝不显示 `0%`**（那会被读成"相关度为零"）。
 * - 非有限值（`NaN`/`±Infinity`）与负值都按"没有相关度分"处理 → `0%`。
 *
 * **永不产生** `NaN`、`Infinity`、负百分比，也不会除零（基准 ≤ 0 时走上面的零分分支）。
 */
export function scoreBadges(hits: readonly ScoredHit[]): ScoreBadge[] {
  if (hits.length === 0) return []

  let max = Number.NEGATIVE_INFINITY
  for (const hit of hits) {
    if (Number.isFinite(hit.score) && hit.score > max) max = hit.score
  }

  // 无任何正分（like 兜底 / 全 0 / 全非有限值）：无法给出相对值
  if (!Number.isFinite(max) || max <= 0) {
    return hits.map(() => ({
      label: KEYWORD_ONLY_LABEL,
      // 这里**不提"相对值"**：本次根本没有分数，说相对值会误导（它是"没有分"而非"分很低"）
      title: '短查询兜底的关键词匹配（LIKE），后端不产生相关度分，故不显示百分比',
      top: false,
      keywordOnly: true,
    }))
  }

  return hits.map((hit) => {
    const score = hit.score
    if (!Number.isFinite(score) || score <= 0) {
      // 本次确实有正分，而这一条没有 → 它没有相关度信号（不是"最低分"）
      return { label: '0%', title: `本次未给出相关度分（${RELATIVE_HINT}）`, top: false, keywordOnly: false }
    }
    if (score >= max) {
      return { label: '100%', title: `本次最高分（${RELATIVE_HINT}）`, top: true, keywordOnly: false }
    }
    const pct = Math.round((score / max) * 100)
    if (pct <= 0) {
      return { label: '<1%', title: `不足本次最高分的 1%（${RELATIVE_HINT}）`, top: false, keywordOnly: false }
    }
    const capped = Math.min(99, pct)
    return {
      label: `${capped}%`,
      title: `约为本次最高分的 ${capped}%（${RELATIVE_HINT}）`,
      top: false,
      keywordOnly: false,
    }
  })
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
