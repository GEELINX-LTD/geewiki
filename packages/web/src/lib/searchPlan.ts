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
 *
 * 原先这里还有第三类（`degraded.reason` → 提示条文案 + `answerFormat` → 渲染方式）。
 * 它们服务的是**问答面板**，而面板已随本批移入 `@geewiki/ai-qa` 自带的界面：宿主检索视图
 * 只呈现检索结果，没有 `degraded` 可解释（`SearchResponse` 里就没有这个字段）。
 * 留着它们等于在宿主里维护一份没人消费、又必须跟着后端枚举改的死镜像。
 */

/** 查询串上限（与后端一致：`packages/plugin-search/src/index.ts` 的 `MAX_QUERY_LENGTH = 500`） */
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

/* ------------------------- 查询语义（mode） ------------------------- */

/**
 * 查询语义：**我们怎么问**（`GET /api/search?mode=`）。
 *
 * - `phrase`：整串当一个**连续短语**（后端缺省）。等价于对正文做 Ctrl+F，精确，
 *   但要求逐字连续出现——自然语言问句几乎不可能逐字出现在正文里，于是**恒为 0 命中**。
 * - `terms`：按 3-gram / ≥3 字符词切成词元后 **OR** 连接（宽召回）。切词规则与硬约束
 *   见后端 `packages/plugin-search/src/index.ts` 的 `buildTermQuery`。
 *
 * ⚠️ 本类型与 `api.ts` 的 `SearchMode`（`'fts' | 'like'`）**不是一回事**，两者会同时出现在
 * 同一轮检索里：本类型是**请求侧**的（怎么问），`SearchMode` 是**响应侧**的（服务端最终
 * 走了 FTS5 还是 LIKE 兜底）。名字刻意区分开，好让"改了请求侧却去读响应侧"这类错配一眼可见。
 */
export type SearchQueryMode = 'phrase' | 'terms'

/** 与后端端点的缺省一致（`packages/plugin-search/src/index.ts:744`：不传 mode 即 phrase） */
export const DEFAULT_QUERY_MODE: SearchQueryMode = 'phrase'

/**
 * 长查询阈值（**按字符数**，不是字节）：达到即判为"成句"。
 *
 * 为什么是 10：中文 4–9 字仍可能是用户**确知正文里有**的术语（「插件热插拔」「段落级阅读权限」），
 * 此时 phrase 的精确语义有正面价值；10 字往上更像一句话，把它当整串逐字匹配的期望值已经很低，
 * 而 terms 至少还有召回。阈值刻意取**保守**的一侧——短关键词的既有精确语义不因本批改变。
 */
const LONG_QUERY_CHARS = 10

/**
 * 问号/叹号（半角与全角）：出现即视为问句
 */
const QUESTION_PUNCT = /[?？!！]/

/**
 * 问句引导词。刻意**只收"几乎是问句信号"的词**：像「的」「是」「有」这种高频字一旦收进来，
 * 「段落级阅读权限是什么」以外的绝大多数正常关键词都会被误判成问句。
 */
const QUESTION_WORDS = /(怎么|如何|怎样|为什么|为何|什么是|是什么|哪些|哪个|哪一种|是否|能否|可否)/

/**
 * "请求式"动词短语：`介绍一下…` / `说明一下…`。
 *
 * ⚠️ 这里**必须带「一下」**，不能只匹配 `介绍|说明|解释|总结`：那几个词本身是常见的
 * **正文用词**，而「说明书模板」「插件平台介绍」「总结报告」都是完全正常的**精确**关键词
 * （用户确知页面标题里就有这几个字）。只匹配「动词 + 一下」既覆盖了真正的请求式问句，
 * 又不会把这些精确检索误判成宽召回。
 */
const REQUEST_PHRASES = /(介绍|说明|解释|总结|讲讲|说说)(一下|下|下这)/

/**
 * 猜一个**默认**查询语义（用户仍可在界面上改）。
 *
 * 判据是"这串东西看起来像不像一段能在正文里逐字找到的片段"：
 * 1. **含空白** → `terms`。phrase 要求正文里连着出现**含这段空白**的原串；用户打多个词
 *    （无论中英）表达的通常是"这些词都相关"，不是"正文里有这一串带空格的字符"。
 * 2. **含问号/叹号、问句引导词，或"请求式"短语（`介绍一下…`）** → `terms`。问句的意图是"找讲这件事的页面"。
 * 3. **长度 ≥ {@link LONG_QUERY_CHARS}** → `terms`。理由见该常量的注释。
 * 4. 其余（短关键词）→ `phrase`，保持搜索框既有的精确语义——**包括「说明书模板」这类
 *    恰好含"请求式动词"的精确关键词**，见 {@link REQUEST_PHRASES} 的说明。
 *
 * 纯函数、不读全局，故可单测；`''` 返回缺省值（调用方应先过 {@link checkQuery}）。
 */
export function detectQueryMode(raw: string): SearchQueryMode {
  const q = raw.trim()
  if (q === '') return DEFAULT_QUERY_MODE
  if (/\s/.test(q)) return 'terms'
  if (QUESTION_PUNCT.test(q)) return 'terms'
  if (QUESTION_WORDS.test(q)) return 'terms'
  if (REQUEST_PHRASES.test(q)) return 'terms'
  // 按**码点**计数（`[...q]`）而非 `.length`：BMP 外的汉字是代理对，`.length` 会算成 2 个
  if ([...q].length >= LONG_QUERY_CHARS) return 'terms'
  return DEFAULT_QUERY_MODE
}

/** 两个可选语义的界面文案（`label` 上按钮，`hint` 作 title 与结果区解释） */
export interface QueryModeOption {
  id: SearchQueryMode
  label: string
  hint: string
}

/**
 * 选项**逐个命名**而不是内联进数组：`noUncheckedIndexedAccess` 下 `QUERY_MODE_OPTIONS[0]`
 * 的类型含 `undefined`，回退分支就没法直接返回它。命名常量让"缺省项"有确定类型。
 */
const PHRASE_OPTION: QueryModeOption = {
  id: 'phrase',
  label: '精确',
  hint: '整句连续匹配：要求正文里逐字连着出现这段文字。适合你确知正文写法的短关键词，如「插件热插拔」。',
}

const TERMS_OPTION: QueryModeOption = {
  id: 'terms',
  label: '分词',
  hint: '按词元宽松匹配：中文切 3 字滑窗、英文按词切，命中任意一个词元即算。适合问句与长查询，如「怎么配置 OIDC」。',
}

export const QUERY_MODE_OPTIONS: readonly QueryModeOption[] = [PHRASE_OPTION, TERMS_OPTION]

/** 取某个语义的界面文案（未知值回落缺省，避免界面出现空白按钮） */
export function queryModeOption(mode: SearchQueryMode): QueryModeOption {
  return QUERY_MODE_OPTIONS.find((o) => o.id === mode) ?? PHRASE_OPTION
}

/**
 * 结果区那句"这一轮是怎么问的"——**必须显示**，否则用户无法解释"同一句话换个模式结果天差地别"。
 *
 * 注意它与响应里的 `mode`（`fts`/`like`，服务端怎么答的）是两件事，界面上两者都会出现。
 */
export function queryModeNote(mode: SearchQueryMode): string {
  return mode === 'terms' ? '分词匹配（词元 OR，召回更宽）' : '精确匹配（整串连续）'
}

/**
 * 0 命中时是否该引导用户换用 `terms`。
 *
 * 只在**精确匹配且一条都没有**时给这条引导：这正是本轮要修的症状——用户把问句粘进搜索框，
 * phrase 要求整串逐字出现，于是"明明写过却搜不到"。反向不成立：`terms` 已经是最宽的一侧，
 * 它 0 命中时换成 `phrase` 只会更少，给按钮等于骗人。
 *
 * **只引导、不自动重试**：静默换模式会让用户以为自己搜的就是原串（也违背本仓"失败语义诚实"）。
 */
export function suggestTermsOnEmpty(mode: SearchQueryMode, total: number): boolean {
  return mode === 'phrase' && total === 0
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
