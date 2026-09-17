/**
 * `@geewiki/ai-summary` 的常量、配置 schema 与对外形状。
 *
 * 与 `plugin-ai-qa` / `plugin-ai-assistant` 同一条约定：**测试专用的注入口不进
 * `configSchema`**（它们不是运行时配置，暴露出去只会让运维以为可以调）。
 */
import Schema from 'schemastery'

/* ============================== 路径与名字 ============================== */

/** 取/生成某一页摘要（`GET` 读、`POST` 重算） */
export const SUMMARY_PATH = '/api/ai/summary'
/** 按摘要检索（**人也能用**：需求 ③ 的那个能力不该只有模型够得着） */
export const SUMMARY_SEARCH_PATH = '/api/ai/summary/search'
/** 能力探测：有没有可用的模型 */
export const SUMMARY_CAPABILITIES_PATH = '/api/ai/summary/capabilities'

/** 本插件贡献的两条工具名（**已按名排序**：这份名单进模型看到的工具表，顺序必须稳定） */
export const SUMMARY_TOOL_NAMES: readonly string[] = ['get_summary', 'search_summaries']

/** manifest 名（也用作工具总线的 owner） */
export const PLUGIN_NAME = '@geewiki/ai-summary'

/* ============================== 输入护栏 ============================== */

export const MAX_SLUG_CHARS = 512
export const MAX_QUERY_CHARS = 300
export const DEFAULT_SEARCH_LIMIT = 8
export const MAX_SEARCH_LIMIT = 20

/* ============================== 配置 ============================== */

/**
 * 配置面刻意只有四项。
 *
 * 少不是省事，而是因为**这里的每一项都有代价，而代价不由配置它的人承担**：
 * `maxSourceChars` 决定摘要漏掉多少正文，`maxSummaryChars` 决定卡片有多长，
 * `debounceMs` 决定一次连写十段会花掉几次模型调用。给不出"什么时候该改"的项就不该有。
 */
export const AiSummaryConfigSchema = Schema.object({
  /**
   * 送给模型的正文上限（字符）。
   *
   * 默认 12000 而不是"全部正文"：一页可以很长，而摘要是**整篇的概述**，
   * 头 12000 字符已经覆盖绝大多数条目。超出部分会被截断，且**模型会被告知**
   * （`TRUNCATION_NOTE`）——静默截断会让摘要看起来完整却漏掉后半篇。
   */
  maxSourceChars: Schema.number().min(1000).max(120000).default(12000),
  /** 摘要长度上限（字符）。卡片折叠态要能一行放下，300 是"能说清一件事"的下限附近 */
  maxSummaryChars: Schema.number().min(60).max(2000).default(300),
  /**
   * 同一页连续保存的合并窗口（毫秒）。
   *
   * 为什么必须有：编辑器会连续保存，而**每次保存都要花一次模型调用**。
   * 0 = 不去抖（每次保存都生成）——测试与"我就是要立刻看到"的场景才该这么设。
   */
  debounceMs: Schema.number().min(0).max(60000).default(2000),
  /**
   * 保存后**自动**生成摘要。
   *
   * 关掉它剩下的不是"没有摘要"，而是"只有被明确要求过的那几页有摘要"：
   * 卡片上的「重新生成」照常工作（那是显式请求，不受本开关约束）。
   * 这个区分是有意的——`autoGenerate` 管的是**花钱的自动行为**，不是整个功能。
   */
  autoGenerate: Schema.boolean().default(true),
})

/* ============================== 对外形状 ============================== */

/** 生成摘要时所用投影对应的读者档（写进库里，供审计） */
export type SummaryAudience = 'public' | 'org' | 'restricted'

/**
 * `GET /api/ai/summary?slug=…` 的响应体。
 *
 * **`available: false` 与 `summary: null` 是两件不同的事**，界面必须分开处理：
 * - `available: false`（没有可用模型）⇒ **整张卡片不渲染**。这一条是 P6 的验收判据之一，
 *   理由是"一张永远转不出结果的折叠卡"比没有卡片更糟：读者点开、看到一句
 *   「暂无摘要」，然后学会不再用它——而真正有摘要的那些页面也一起被忽略。
 * - `available: true, summary: null` ⇒ 卡片渲染成"还没生成"，编辑者可以点一下生成。
 */
export interface SummaryView {
  readonly ok: true
  readonly available: boolean
  readonly slug: string
  /** 文章标题（取自 wiki，与摘要同源；卡片折叠态要显示它） */
  readonly title: string | null
  readonly summary: string | null
  /** 摘要对应的正文已经变了（{@link isStale}）。`summary === null` 时恒为 false */
  readonly stale: boolean
  readonly generatedAt: string | null
  readonly model: string | null
  /** 生成时用的投影档（审计用；也用来向读者解释"这份摘要只覆盖公开部分"） */
  readonly audience: SummaryAudience | null
  /** 当前主体**能不能**触发生成（有编辑权且模型可用）。界面据此决定「重新生成」按钮的显隐 */
  readonly canRegenerate: boolean
  /** `available: false` 或 `canRegenerate: false` 时的一句话原因（界面直接显示，不自己编） */
  readonly reason?: string
}

/** 一条摘要检索命中 */
export interface SummaryHit {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly score: number
  readonly generatedAt: string
}

/** `GET /api/ai/summary/search?q=…` 的响应体 */
export interface SummarySearchView {
  readonly ok: true
  readonly query: string
  readonly total: number
  readonly hits: readonly SummaryHit[]
}
