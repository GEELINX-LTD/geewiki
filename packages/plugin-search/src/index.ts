/**
 * @geewiki/search —— GeeWiki 全文检索插件
 *
 * 「AI-Native 知识库」的检索地基：为 pages 表建立 SQLite FTS5 索引，对外提供
 * `GET /api/search`。后续 LLM 检索增强（RAG）可直接复用本插件的命中与片段。
 *
 * 挂载路由（经 @geewiki/http 路由服务）：
 *   GET /api/search?q=<查询>&limit=<可选条数>
 *
 * 两条检索路径（响应里的 `mode` 会回传实际走的那条，便于观测与测试）：
 * - `fts`：查询串（去首尾空白后）**≥3 字符** → `pages_fts MATCH ?`，按 BM25 相关度排序。
 * - `like`：**<3 字符** → LIKE 兜底。这是 trigram 分词器的硬缺口：索引切的是 3 字符
 *   片段，短于 3 字符的查询（中文 2 字词「检索」、英文 2 字母）在 MATCH 下恒为空，
 *   只能全表 LIKE。该路径**直接扫 pages 表**（不经过 pages_fts）：短查询本就用不上
 *   trigram 索引，且这样在索引漂移时仍能给出正确结果（见下方实现处注释）。
 *
 * 索引与同步由插件自带迁移 `migrations/0001_search.sql` 建立（external content +
 * 三触发器），激活前由管理器的迁移控制器执行。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { isAsyncAdapter, type DatabaseAdapter, type GeeWikiManifest, type HttpRouterService, type Principal, type RouteHandlerContext } from '@geewiki/core'

/* ============================== 配置 ============================== */

export interface SearchConfig {
  /** 单次检索返回的命中条数上限（total 不受此限制） */
  limit?: number
  /** 高亮片段中命中词两侧各保留的字符数 */
  snippetRadius?: number
}

/**
 * 配置 Schema（schemastery）：驱动管理台自动生成配置表单，并在配置热更新前做校验。
 * 同一实例也作为插件模块的 Config（cordis 据此自动校验并填默认值）。
 */
export const SearchConfigSchema = Schema.object({
  limit: Schema.number()
    .default(20)
    .min(1)
    .max(100)
    .description('单次检索返回的命中条数上限（total 仍为全量命中数）'),
  snippetRadius: Schema.number()
    .default(48)
    .min(8)
    .max(400)
    .description('高亮片段中命中词两侧各保留的字符数'),
})

/** 包内置迁移目录（绝对路径，供插件管理器迁移控制器读取） */
export const SEARCH_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export const manifest: GeeWikiManifest = {
  name: '@geewiki/search',
  version: '0.1.0',
  geewiki: {
    displayName: '全文检索',
    description: '为页面标题与正文建立全文索引，支持中文与英文关键词检索',
    provides: 'search-service',
    // 依赖以服务标识声明（非具体插件名）：数据库切换（SQLite→PG）对业务插件透明，
    // 依赖边由管理器按 provides 解析（deps.ts resolveDependency）
    // `policy-service` 是 P2 引入的**读路径依赖**：检索在返回任何命中之前必须先问它
    // "这个主体能看哪些条目"。声明它同时也保证了激活顺序（策略层先就绪）。
    requires: ['database-provider', 'http-service', 'policy-service'],
    conflictGroup: undefined,
    // 索引表由本插件自己的迁移建立（迁移控制器在激活前执行），不依赖 db-sqlite 的迁移
    migrations: './migrations',
    runtime: {
      supportsHotReload: true, // 无进程内状态：索引在库里，可安全热插拔
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: SearchConfigSchema,
  },
}

/* ============================ 服务契约 ============================ */

/**
 * 检索命中的一条结果（与 `GET /api/search` 响应里 `hits[]` 的元素**逐字段一致**）。
 * 抽成具名类型是为了让它成为跨包契约：AI/RAG 插件消费 `search-service` 时依赖这里。
 */
export interface SearchHit {
  slug: string
  title: string
  snippet: string
  /**
   * 相关度：FTS 路为 BM25 取负后的值（**越大越相关**），LIKE 路恒为 0。
   *
   * **只在同一次查询的结果内部可比**：它不是归一化分数（值域无界），量级随语料规模与
   * 查询词变化，跨查询比大小无意义；两种 mode 的 score 也不可比。
   */
  score: number
  updated_at: string
}

/** 一次检索的结果：`mode` 回传实际走的那条路径（观测与测试用） */
export interface SearchResult {
  mode: 'fts' | 'like'
  /** 全量命中数，**不受 limit 影响** */
  total: number
  hits: readonly SearchHit[]
}

/**
 * `policy-service` 的**最小结构需求**（结构化类型，刻意不 import `@geewiki/authz`）。
 *
 * 与 `@geewiki/wiki` 的同名声明保持一致的口径：依赖的是**服务标识**
 * （manifest 的 `requires`），而不是钉死在某个包的模块上 —— 将来完全可能有另一种
 * 策略实现，只要它 `ctx.provide('policy-service', …)` 且形状一致即可。
 */
interface PolicyServiceLike {
  visibleSlugs(principal: Principal, q?: { prefix?: string; levels?: readonly string[] }): Promise<string[]>
}

/**
 * `search-service` 服务契约（本插件经 `ctx.provide('search-service', svc)` 提供）。
 *
 * 存在的意义：让消费方（AI/RAG 插件）**不必**知道检索插件内部怎么建索引、
 * 也不必直接 `SELECT` wiki 的 `pages` 表（那会把表结构变成跨包隐式契约）。
 *
 * ★ P2：**两个方法都显式要求 `principal` 且改为异步**（设计文档 §9 R2）。
 * 为什么必须显式传主体：cordis 服务是进程级单例，把主体藏在服务内部等于让
 * "忘了传"变成"按上一个人的权限返回"。故 principal 是**必填首参**——
 * 漏传在编译期即报错，运行期再兜一道（见 {@link assertPrincipal}）。
 *
 * 为什么从同步改成异步：可见性判定要走 `policy-service`（`visibleSlugs` 是异步的，
 * 它可能要查祖先链）。这是 P2 的**破坏性契约变更**，消费方（`@geewiki/ai`）已同步跟进。
 */
export interface SearchService {
  /**
   * 全文检索。与 `GET /api/search` 是**同一份实现**（端点只是把它包成 HTTP），
   * 故两者在同主体、同 q、同 limit 下结果逐字段一致。
   *
   * **结果已在 SQL 层按主体裁剪**：`total`、`hits`、`snippet` 全部只覆盖当前主体
   * 可见（`full` 档）的条目。**绝不是"先取全量再后过滤"** —— 那样 `total`、
   * 高亮与分页语义会一起泄漏（设计文档 §5.6 明令禁止）。
   *
   * @param principal 主体（匿名用 `anonymousPrincipal()`，不可省略）
   * @param q    查询串（调用方无需 trim，内部会 trim；trim 后为空则返回空结果）
   * @param opts limit 为本次返回条数上限（1..100，非法值抛错——与端点的 400 语义对应）；
   *             mode 为查询语义：`'phrase'`（默认）= 整串字面短语（搜索框语义），
   *             `'terms'` = 切成词元后 OR（**问句检索**语义，RAG 用）。
   */
  search(
    principal: Principal,
    q: string,
    opts?: { limit?: number; mode?: SearchMode },
  ): Promise<SearchResult>

  /**
   * 按 slug 批量取整页正文，供 RAG 拼上下文。
   * 只包含**真实存在且当前主体可见（`full` 档）**的 slug（查不到/无权看的键不出现）；
   * 空数组直接返回空 Map。
   *
   * ⚠️ 这是 RAG 的**正文入口**，也是 §5.6 点名的第三条泄漏旁路：调用方若绕过它
   * 直接读 `pages` 表，权限就白做了。裁剪在本方法内部完成（唯一出口）。
   */
  contents(principal: Principal, slugs: readonly string[]): Promise<ReadonlyMap<string, string>>
}

/**
 * 主体守卫（§9 R2 的运行时兜底）。
 *
 * 编译期已经强制传 principal，但 JS 调用方、`as any`、以及将来某个消费方从
 * 动态结构里取值时仍可能漏。**这里必须抛错而不是"当作匿名"**：当作匿名会静默
 * 少给内容（可发现），而"不过滤"会静默多给（不可发现且是安全事故）。
 */
function assertPrincipal(principal: Principal | undefined): Principal {
  if (!principal || typeof principal !== 'object' || typeof principal.kind !== 'string') {
    throw new Error(
      '@geewiki/search: 检索方法必须显式传入 principal —— ' +
        '拒绝在缺少主体的情况下返回任何结果（设计文档 §9 R2：漏传必须抛错，不得放行）',
    )
  }
  return principal
}

/* ============================ 纯函数工具 ============================ */

/** trigram 分词器的最小可检索长度：短于此长度 MATCH 恒为空，必须走 LIKE */
export const MIN_TRIGRAM_LENGTH = 3

/** limit 的硬上限（与 configSchema 的 max 一致，防止手改配置绕过校验） */
const MAX_LIMIT = 100

/**
 * 下推到 SQL 的可见 slug 上限。
 *
 * 取值依据：SQLite 自 3.32 起 `SQLITE_MAX_VARIABLE_NUMBER` 默认为 **32766**，
 * 这里保守取一半，给 `matchExpr`/`pattern`/`limit` 等其它参数留余量。
 * 超限时 {@link SearchPlugin} 会**显式抛错**（见 `visiblePlaceholders` 的说明）。
 */
const MAX_VISIBLE_SLUGS = 16_000

/**
 * 查询串长度上限（服务层护栏）。
 *
 * 与 `@geewiki/ai` 的 `MAX_QUERY_LENGTH = 500` **刻意保持一致**：REST 端点与 AI 插件
 * 对"多长的问句算合理"应有同一口径，否则从两个入口进来的同一句话会有不同结果。
 * 这里不复用对方的常量：search 是下层（ai 依赖 search-service），下层不能反向依赖上层，
 * 故两处各自持有该数值并在注释里互相指认。
 *
 * 为什么需要护栏：`buildTermQuery` 的词元数随长度线性增长，而 MATCH 表达式长度随之增长；
 * REST 侧本来就受 Node 的请求行上限（约 16KB）保护，但**直接调用 search-service 的消费方
 * 不受此保护**，可传入任意长度（例如把整篇正文当查询）。超限一律拒绝而不是静默截断——
 * 截断会给出"看起来正常但实际只搜了一部分"的结果，比报错更难定位。
 */
export const MAX_QUERY_LENGTH = 500

/** HTML 转义：片段会被前端以 HTML 渲染，正文来自用户，必须转义后再插 <mark> */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * LIKE 模式串转义：`%`（任意串）、`_`（任意单字符）与转义符 `\` 本身。
 * 不转义的话，用户搜 `100%` 会变成"以 100 开头的一切"，搜 `_` 会命中任意单字符。
 * 配合 SQL 里的 `ESCAPE '\'` 使用。
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
}

/**
 * 把用户输入转成 FTS5 的**字面短语**查询串：整体加双引号，内部双引号翻倍。
 *
 * 这一步是**查询语法注入防护**：用户输入绝不按 FTS5 语法解释，否则 `*`、`NEAR(`、
 * `a OR b`、裸 `"` 等会抛 `fts5: syntax error`/`unknown special query`，甚至改变语义
 * （把"字面包含 a OR b"变成"包含 a 或 b"）。实测 24 种敌意输入在加引号后 0 抛错，
 * 且 `a OR b` 只匹配正文里字面含有 `a OR b` 的行。
 */
export function toFtsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`
}

/**
 * **逐字切分**的文字系统：这些文字没有词边界（不靠空格分词），trigram 索引里存的是
 * 3 字符片段，因此查询必须同样按 3 字符滑窗切，否则整串会被当成一个 token 而恒不命中。
 *
 * 覆盖范围（用 Unicode script 属性而非手写码点区间）：
 * - `Han`：汉字（含扩展 A/B… 与 BMP 外的扩展区——属性转义天然覆盖代理对）；
 * - `Hiragana` / `Katakana`：日文假名（含半角片假名）；
 * - `Hangul`：韩文谚文（音节 + 字母）。
 *
 * 为什么必须显式列出假名/谚文：它们**不属于 Han**，而按"非 CJK 分支"处理时会被
 * `\p{L}+` 当成**一个整词**（假名与谚文都是字母类），于是复现"整句一个词元 → 恒 0 命中"
 * 的原缺陷（实测 `けんさくかくちょうせいせいとは何か` 曾整串成一个 15 字词元）。
 */
const NEEDS_TRIGRAM = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 把查询切成"连续的需要 3-gram 的片段"与"其余片段"交替的序列（split 保留捕获组） */
function splitCjkRuns(q: string): string[] {
  return q.split(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u)
}

/**
 * 把查询切成**可检索词元**（`mode:'terms'` 用），每段分别加引号后以 OR 连接。
 *
 * 为什么需要它：`toFtsPhrase` 把**整串**当一个短语，于是自然语言问句
 * （「检索增强怎么做」）要求正文里连续出现该整串——问句几乎不可能逐字出现在正文里，
 * 结果恒为 0 命中（`/api/ai/ask` 的检索地基因此不可用）。防注入的正确姿势是
 * "每个输入单元都当字面量"，而不是"把整句当一个单元"。
 *
 * 切分规则（由 trigram 分词器的硬约束决定：**短于 3 字符的 token 在 MATCH 下恒为空**，
 * 因为索引用的是 3 字符片段）：
 * - **无词边界的文字（汉字/假名/谚文）连续片段**：取长度 3 的滑窗 3-gram
 *   （「检索增强怎么做」→ 检索增/索增强/…）。取窗口而非整段，是为了让"词元在正文里出现"
 *   这一条件退化成"该 3-gram 在正文里出现"，从而绕过 trigram 无法按词匹配的限制。
 * - **有词边界的文字（拉丁字母、数字）**：按空白与常见标点切词，只保留**长度 ≥3** 的词元
 *   （<3 在 MATCH 下恒为空——实测 `MATCH '"42"'` 命中 0，即使正文含「42」）。
 * - 去重且保持出现顺序（顺序稳定便于测试与排障）。
 *
 * **已知语义（<3 字符的片段被丢弃）**：中文 2 字词（「检索」）与英文 2 字母词切不出词元，
 * 会被本函数**丢弃**；整串都切不出词元时由调用方回退 LIKE 兜底（结果仍然正确）。
 * 但**混排**场景下（「检索 abc」这类）被丢弃的短片段**不参与** FTS 召回——这是既有取舍：
 * 把短片段并入 LIKE 需要把 FTS 与 LIKE 两路结果合并去重，会改变 `mode` 的语义与返回结构，
 * 代价大于收益。REST 端点对 <3 字符的**整串**查询仍走 LIKE，行为不受影响。
 *
 * **返回值不是 SQL**：调用方必须对每个词元调用 {@link toFtsPhrase} 再拼 OR——
 * 本函数只负责"切词"，绝不负责"转义"，两者分开才能保证注入防护只有一处实现。
 */
export function buildTermQuery(q: string): string[] {
  const terms: string[] = []
  // Set 去重：`terms.includes` 是 O(n²)，长查询（例如把整段正文当查询）会明显退化
  const seen = new Set<string>()
  const push = (t: string): void => {
    if (t.length >= MIN_TRIGRAM_LENGTH && !seen.has(t)) {
      seen.add(t)
      terms.push(t)
    }
  }

  for (const seg of splitCjkRuns(q)) {
    if (seg === '') continue
    if (NEEDS_TRIGRAM.test(seg)) {
      // 逐字切分的文字系统：滑窗 3-gram。
      // 用 `[...seg]` 展开而非 `seg[i]`：BMP 外的 CJK 扩展字是**代理对**，
      // 按下标取会把它拆成两个半个字符，切出的 3-gram 永远不可能命中索引。
      const chars = [...seg]
      for (let i = 0; i + MIN_TRIGRAM_LENGTH <= chars.length; i += 1) {
        push(chars.slice(i, i + MIN_TRIGRAM_LENGTH).join(''))
      }
      continue
    }
    // 其余片段（拉丁字母、数字等有词边界的文字）：按空白与标点切词，逐词判断长度
    for (const word of seg.split(/[^\p{L}\p{N}_]+/u)) {
      if (word !== '') push(word)
    }
  }
  return terms
}

/** 一次检索的查询语义：`phrase` = 整串字面短语（默认，向后兼容）；`terms` = 词元 OR（问句检索） */
export type SearchMode = 'phrase' | 'terms'

/**
 * 自实现高亮片段（不用 FTS5 的 `snippet()`：trigram 下它上限约 64 token ≈ 中文 64 字，
 * 太短且会把片段切得很碎）。
 *
 * 取第一个命中位置，两侧各取 radius 个字符，命中词包 `<mark>`；截断处补省略号。
 * **转义顺序**：先按原始下标切片，再对三段分别做 HTML 转义，最后拼进 `<mark>`——
 * 这样 `&`/`<` 等字符不会与标签混淆，正文里的 `<script>` 不可能逃逸成真标签。
 * 命中词在文本里找不到（例如 FTS 命中了 title 而片段取 content）时返回 null。
 */
export function buildSnippet(text: string, query: string, radius: number): string | null {
  if (!text) return null
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + query.length + radius)
  const lead = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const before = escapeHtml(text.slice(start, idx))
  const hit = escapeHtml(text.slice(idx, idx + query.length))
  const after = escapeHtml(text.slice(idx + query.length, end))
  return `${lead}${before}<mark>${hit}</mark>${after}${tail}`
}

/* ============================ 插件本体 ============================ */

interface SearchHitRow {
  slug: string
  title: string
  content: string
  updated_at: string
  /** FTS 路为 FTS5 `rank` 原始值（BM25，**负值**，越小越相关）；LIKE 路恒为 0 */
  score?: number
}

const SELECT_COLUMNS = `p.slug AS slug, p.title AS title, p.content AS content, p.updated_at AS updated_at`

export const SearchPlugin = {
  name: '@geewiki/search',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: SearchConfigSchema,

  apply(ctx: Context, config: SearchConfig = {}) {
    const db = ctx.get('db') as DatabaseAdapter | undefined
    if (!db) throw new Error('@geewiki/search: 数据库服务不可用（@geewiki/db-sqlite 未激活）')
    // **能力边界：显式失败**。全文索引建立在 SQLite 专有的 FTS5 之上（`tokenize='trigram'`，
    // 中文子串检索的关键），**PostgreSQL 没有 FTS5**——PG 侧的等价物是 `tsvector` +
    // 分词配置，属另一个工程（本批不做）。若在这里静默放行，会先炸在迁移脚本的语法上，
    // 或更糟：启动成功但检索恒为空。故提前拒绝并说清原因与替代方案。
    // 判据用「方言」而非「同步/异步」：将来若有同步的 PG 驱动，本插件同样不适用。
    const dialect = isAsyncAdapter(db) ? db.dialect : (db.dialect ?? 'sqlite')
    if (dialect !== 'sqlite') {
      throw new Error(
        `@geewiki/search: 当前数据库方言是 ${dialect}，而本插件的全文索引依赖 SQLite 专有的 FTS5` +
          '（trigram 分词器），暂不支持该方言。请改用 @geewiki/db-sqlite，或等待基于 tsvector 的 PG 检索实现。',
      )
    }
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/search: http 路由服务不可用（@geewiki/http 未激活）')

    /**
     * 卸载标志：插件卸载后正常路径是 `ctx.get('search-service')` 回到 undefined，
     * 但**已经持有 svc 引用的消费方**仍可能再调一次。那种调用必须**显式报错**，
     * 不能返回空结果——"卸载后静默返回 0 命中"会被误读成"库里没有匹配内容"，
     * 正是最难定位的那类症状。
     */
    let disposed = false
    const assertLive = (): void => {
      if (disposed) {
        throw new Error('@geewiki/search: 插件已卸载，search-service 不可再调用（重新激活插件后再用）')
      }
    }

    const defaultLimit = Math.min(Math.max(config.limit ?? 20, 1), MAX_LIMIT)
    const snippetRadius = Math.max(config.snippetRadius ?? 48, 8)
    const cleanups: (() => void)[] = []

    /**
     * 策略服务（P2）。**逐请求活查询**，不做构造期快照 —— `@geewiki/authz` 在本插件
     * 之后激活时也能拿到服务；反过来，若策略层缺失则**拒绝返回任何结果**（§9 R2：
     * 绝不因策略层缺失而放行）。
     */
    const policy = (): PolicyServiceLike => {
      const svc = ctx.get('policy-service') as PolicyServiceLike | undefined
      if (!svc) {
        throw new Error(
          '@geewiki/search: policy-service 不可用 —— 拒绝返回任何检索结果（绝不因策略层缺失而放行，见设计文档 §9 R2）',
        )
      }
      return svc
    }

    /**
     * `IN (?,?,…)` 的占位符串。
     *
     * 为什么把**可见集合**而不是"隐藏集合"传进来：隐藏集合在"全站皆私有"时同样是
     * 全量，不解决规模问题；而可见集合是策略层的**唯一真源**输出，语义直白。
     *
     * 规模边界（**已知并接受**）：SQLite 的绑定参数上限是 32766（3.32+），故设
     * {@link MAX_VISIBLE_SLUGS} 为保守阈值。**超限时显式抛错而不是静默截断**：
     * 截断会让 `total` 变成"部分集合的总数"，是那种"看起来正常但结果是错的"故障。
     */
    const visiblePlaceholders = (slugs: readonly string[]): string => slugs.map(() => '?').join(',')

    /**
     * **检索的单一实现**：`GET /api/search` 与 `search-service.search()` 都走这里。
     * 端点只负责把 HTTP 参数解析成 `(q, limit)` 并把结果包成响应体——
     * 若两处各写一份 SQL，迟早会出现"REST 与插件内检索结果不一致"的漂移。
     *
     * ★ P2：**先按主体取可见集合，再把它下推到 SQL**。三条路（FTS / 短查询 LIKE /
     * `contents`）全部如此。**绝不先取全量再在 JS 里过滤** —— 那样 `total`、高亮
     * 片段与分页语义会一起泄漏（设计文档 §5.6 明令禁止）。
     */
    const search = async (
      principal: Principal,
      rawQuery: string,
      opts?: { limit?: number; mode?: SearchMode },
    ): Promise<SearchResult> => {
      assertLive()
      assertPrincipal(principal)
      const q = (rawQuery ?? '').trim()
      // 空查询在这里返回空结果：空串传给 MATCH 会抛
      // `SqliteError: fts5: syntax error near ""`（FTS5 不接受空表达式）。
      // 端点另在解析阶段用 400 invalid_query 拦下（HTTP 语义），此处是服务层兜底。
      if (!q) return { mode: 'like', total: 0, hits: [] }
      // 长度护栏（服务层）：直接调用 search-service 的消费方不受 REST 的请求行上限保护，
      // 可传入任意长度（例如把整篇正文当查询）→ 词元数与 MATCH 表达式随之膨胀。
      // 这里抛错而不是静默截断：截断会给出"看起来正常但只搜了一部分"的结果。
      // REST 端点在解析阶段另有 400（HTTP 语义），不会走到这里。
      if (q.length > MAX_QUERY_LENGTH) {
        throw new RangeError(`查询串过长（${q.length} 字符，上限 ${MAX_QUERY_LENGTH}）`)
      }

      let limit = defaultLimit
      if (opts?.limit !== undefined) {
        if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_LIMIT) {
          throw new RangeError(`limit 须为 1..${MAX_LIMIT} 的整数，实际 ${String(opts.limit)}`)
        }
        limit = opts.limit
      }

      // 查询语义：phrase（默认，搜索框）与 terms（问句）**不改变返回结构**，
      // 只决定"喂给 MATCH 的表达式"；两条路最终都落到同一个 FTS 查询与同一段排序逻辑。
      const queryMode: SearchMode = opts?.mode ?? 'phrase'
      // terms 模式先把查询切成词元；切不出词元（<3 字符、纯标点）时**回退 LIKE**——
      // 不能构造空 MATCH（`MATCH ''` 抛 fts5 syntax error），也不该静默返回空结果：
      // 短查询的正确答案由 LIKE 给出（与 <3 字符的短语路径完全一致）。
      const terms = queryMode === 'terms' ? buildTermQuery(q) : []
      const useFts = queryMode === 'terms' ? terms.length > 0 : q.length >= MIN_TRIGRAM_LENGTH

      /*
       * ★ P2：本主体的**可见集合**，交给下面的 SQL 下推（三条路共用）。
       *
       * 为什么只取 `full` 档：`summary` 档的语义是"只见标题与占位"（§2.2）。若让它
       * 参与检索，命中片段（`snippet`）与 `SELECT_COLUMNS` 里的 `p.content` 就会把
       * 正文带出来 —— 那正是"看起来有权限"的假象。**宁可少给，不可多给。**
       */
      const visible = await policy().visibleSlugs(principal, { levels: ['full'] })
      if (visible.length > MAX_VISIBLE_SLUGS) {
        throw new Error(
          `@geewiki/search: 可见条目数（${visible.length}）超过下推上限 ${MAX_VISIBLE_SLUGS} —— ` +
            '拒绝静默截断（截断会让 total 变成"部分集合的总数"，属于"看起来正常但结果是错的"）。' +
            '这是本实现已知的规模边界，需要改为数据库侧可见性下推（设计文档 §5.6）。',
        )
      }
      // 一条都看不见 ⇒ 直接返回空结果、**不查库**：既省一次全表扫，也避免构造 `IN ()` 这种非法 SQL。
      // mode 仍按"本来会走哪条路"报告，避免调用方据 mode 反推出"这个人有没有可见内容"。
      if (visible.length === 0) return { mode: useFts ? 'fts' : 'like', total: 0, hits: [] }
      const inClause = visiblePlaceholders(visible)

      let total: number
      let rows: SearchHitRow[]
      let mode: 'fts' | 'like'
      let scoreOf: (row: SearchHitRow) => number

      if (useFts) {
        // phrase：整串一个短语。terms：每个词元各自 toFtsPhrase（**仍字面、仍防注入**）后 OR 连接。
        const matchExpr =
          queryMode === 'terms' ? terms.map((t) => toFtsPhrase(t)).join(' OR ') : toFtsPhrase(q)
        // total 必须是 **distinct 行数**：OR 会让同一行被多个词元各自命中，
        // COUNT(*) 会把行数按命中次数重复计入（实测一行命中 2 个词元时 COUNT(*)=该行计 2 次），
        // 而契约里 total 是"全量命中数"（与 hits 的行语义一致）。
        total = countOf(
          db.query<{ n: number }>(
            `SELECT COUNT(DISTINCT p.id) AS n FROM pages_fts f JOIN pages p ON p.id = f.rowid
              WHERE f.pages_fts MATCH ? AND p.slug IN (${inClause})`,
            [matchExpr, ...visible],
          ),
        )
        rows = db.query<SearchHitRow>(
          `SELECT ${SELECT_COLUMNS}, f.rank AS score
             FROM pages_fts f JOIN pages p ON p.id = f.rowid
            WHERE f.pages_fts MATCH ? AND p.slug IN (${inClause}) ORDER BY f.rank LIMIT ?`,
          [matchExpr, ...visible, limit],
        )
        mode = 'fts'
        // BM25（FTS5 的 `rank`）原始值是**负的**，越小越相关；这里**取负**换成
        // "越大越相关"再对外。**这不是归一化**：值域没有界、量级随语料规模与查询词
        // 变化，故**只在同一次查询的结果内部可比**，跨查询（乃至跨库）比大小无意义。
        // terms 模式下 BM25 天然让"命中词元更多"的行排前（OR 的相关度是各词元得分之和）。
        scoreOf = (row) => -(row.score ?? 0)
      } else {
        const pattern = `%${escapeLike(q)}%`
        // **LIKE 路直接扫 pages 表（不经过 pages_fts）**，这是刻意的：
        // 1. 短查询本就用不上 trigram 索引（切不出完整 3 字符片段），走索引没有收益
        //    （实测 5000 行语料：裸表 3.0ms vs 经 pages_fts 4.0ms，裸表还更快）；
        // 2. 更稳：万一索引与内容表出现漂移（迁移未跑全、触发器被删），短查询仍能给出
        //    正确结果，而不会静默漏行——"兜底"就该兜在真正的真源上。
        // ≥3 字符的 FTS 路则必须有索引，索引缺失会显式报错（宁可响，不可静默空）。
        total = countOf(
          db.query<{ n: number }>(
            // 括号不能省：`A OR B AND C` 的优先级是 `A OR (B AND C)`，会让权限过滤只作用于一半条件。
            `SELECT COUNT(*) AS n FROM pages p
              WHERE (p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')
                AND p.slug IN (${inClause})`,
            [pattern, pattern, ...visible],
          ),
        )
        rows = db.query<SearchHitRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM pages p
            WHERE (p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')
              AND p.slug IN (${inClause})
            ORDER BY p.updated_at DESC LIMIT ?`,
          [pattern, pattern, ...visible, limit],
        )
        mode = 'like'
        // LIKE 路没有相关度可言（全表子串匹配），统一给 0；
        // 两种 mode 的 score 只在各自内部可比，跨 mode 不要比大小
        scoreOf = () => 0
      }

      return {
        mode,
        total,
        hits: rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          // 片段优先取正文；正文没出现（例如只命中标题）时退回标题。
          // terms 模式下**不能用整句去定位**：问句本身不在正文里，那样每条命中都会
          // snippet 为空、高亮消失（命中却看不到"为什么命中"）。故逐个词元试，取第一个
          // 能在正文里定位到的词元作为锚点；都定位不到时退回整句（结果为 ''）。
          snippet: snippetFor(row, terms, q, snippetRadius),
          score: scoreOf(row),
          updated_at: row.updated_at,
        })),
      }
    }

    /**
     * 批量取正文（RAG 拼上下文用）。
     *
     * **占位符按 slugs.length 动态生成**：SQLite 的 `?` 绑定不接受数组
     * （better-sqlite3 传数组会抛 "Too many parameter values were provided"），
     * 故必须按个数拼 `?,?,?`。**拼的只是占位符本身，slug 值一律走参数绑定**——
     * 绝不把 slug 文本拼进 SQL（否则 `' OR 1=1 --` 之类的输入会变成注入）。
     */
    const contents = async (
      principal: Principal,
      slugs: readonly string[],
    ): Promise<ReadonlyMap<string, string>> => {
      assertLive()
      assertPrincipal(principal)
      const out = new Map<string, string>()
      if (slugs.length === 0) return out

      /*
       * ★ P2：这是 RAG 的**正文入口**，也是设计文档 §5.6 点名的第三条泄漏旁路
       * （原先它是"给什么 slug 就吐什么正文"的裸接口）。
       *
       * 做法是**先求交集再查库**：`allowed = 请求的 slug ∩ 本主体可见（full 档）`。
       * 因此不可见的 slug **从来没有**进入过 SQL —— 这不是"先取全量再在 JS 里过滤"
       * （那种做法会把 `total`、高亮、分页一起泄漏，是被明令禁止的）。
       *
       * 为什么不像检索那样把"可见集合"也一并下推做第二道过滤：`allowed` 由构造保证
       * 是 `visible` 的子集，第二道 `IN` 是可证明冗余的，却会让绑定参数翻倍并更早
       * 撞上 SQLite 的参数上限。**冗余检查换不来安全性，只换来更早的规模边界。**
       */
      const visible = new Set(await policy().visibleSlugs(principal, { levels: ['full'] }))
      const allowed = slugs.filter((slug) => visible.has(slug))
      if (allowed.length === 0) return out

      const placeholders = allowed.map(() => '?').join(',')
      const rows = db.query<{ slug: string; content: string }>(
        `SELECT slug, content FROM pages WHERE slug IN (${placeholders})`,
        [...allowed],
      )
      for (const row of rows) out.set(row.slug, row.content)
      // 查不到 / 无权看的 slug 都不进 Map（消费方据此区分"页面不存在"与"正文为空串"）
      return out
    }

    /** 服务实例：契约见 {@link SearchService} */
    const svc: SearchService = { search, contents }

    cleanups.push(
      router.register('GET', '/api/search', async (h: RouteHandlerContext) => {
        const q = (h.url.searchParams.get('q') ?? '').trim()
        // 空查询必须在这里拦下（HTTP 语义：400 比"200 + 空结果"更能暴露调用方 bug）
        if (!q) {
          h.json(400, {
            ok: false,
            error: 'invalid_query',
            message: '查询串不能为空（请提供 q 参数，且不能只有空白字符）',
          })
          return
        }
        // 长度上限：必须在调用 search() **之前**拦下并给出 400——search() 对超长查询抛
        // RangeError，而路由层对同步抛错统一转成 **500**（见 server 的 dispatch catch），
        // 那是"服务器故障"的语义，与"调用方传得太长"不符。
        // 错误码 `too_long` 与 @geewiki/ai 的 `/api/ai/ask` 保持一致口径。
        if (q.length > MAX_QUERY_LENGTH) {
          h.json(400, {
            ok: false,
            error: 'too_long',
            message: `查询串过长（${q.length} 字符，上限 ${MAX_QUERY_LENGTH}）`,
          })
          return
        }
        const limitRaw = h.url.searchParams.get('limit')
        let limit: number | undefined
        if (limitRaw !== null && limitRaw !== '') {
          const parsed = Number(limitRaw)
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
            h.json(400, {
              ok: false,
              error: 'invalid_limit',
              message: `limit 须为 1..${MAX_LIMIT} 的整数`,
            })
            return
          }
          limit = parsed
        }

        // mode：不传 = phrase（搜索框语义，向后兼容）；非法值显式 400，
        // 不静默降级——把 'term'/'keywords' 这类拼错当 phrase 会表现为"问了却没结果"，
        // 正是最难定位的症状。
        const modeRaw = h.url.searchParams.get('mode')
        let queryMode: SearchMode = 'phrase'
        if (modeRaw !== null && modeRaw !== '') {
          if (modeRaw !== 'phrase' && modeRaw !== 'terms') {
            h.json(400, {
              ok: false,
              error: 'invalid_mode',
              message: `mode 须为 phrase 或 terms，实际 ${modeRaw}`,
            })
            return
          }
          queryMode = modeRaw
        }

        // 查询本体完全交给 search()（单一实现）；端点只管 HTTP 层
        //
        // ★ P2：主体必须显式取出并传入。路由层已由 P0 的闸门保证 `access: 'public'`
        // 的端点上 `h.principal` 也已解析（匿名有 anonymousPrincipal 对象，不是 undefined）；
        // 但这里仍显式判空并 401 —— 与 `@geewiki/wiki` 同款兜底，宁可返回错误也不放行。
        const principal = h.principal
        if (!principal) {
          h.json(401, {
            ok: false,
            error: 'unauthorized',
            message: '缺少主体信息，无法判定可见范围',
          })
          return
        }
        const result = await search(principal, q, {
          ...(limit === undefined ? {} : { limit }),
          mode: queryMode,
        })
        h.json(200, {
          ok: true,
          query: q,
          mode: result.mode,
          queryMode,
          total: result.total,
          hits: result.hits,
        })
      }),
    )

    // 真正创建 cordis 服务：manifest 的 provides 只是依赖图 token，不会建服务。
    // 两者名字**必须一致**（'search-service'），否则消费方 ctx.get 拿到 undefined，
    // 表现为"AI 永远只回空结果"这类极难定位的症状。
    const unprovide = ctx.provide('search-service', svc)

    console.log('[@geewiki/search] 已激活: GET /api/search 与 search-service 服务')
    return () => {
      // 先立"已卸载"标志：此后任何仍持有 svc 引用的调用都会显式报错而非返回空结果
      disposed = true
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      unprovide()
      console.log('[@geewiki/search] 已卸载: REST 路由已摘除，search-service 已注销')
    }
  },
}

/** COUNT(*) 结果取值（SqliteDatabase 返回的行里字段名与别名一致） */
function countOf(rows: { n: number }[]): number {
  return Number(rows[0]?.n ?? 0)
}

/**
 * 取一条命中的高亮片段。
 *
 * phrase 模式：整串即锚点（行为与既有实现逐字一致）。
 * terms 模式：整句通常不在正文里，故**按词元顺序**试锚点，取第一个能定位到的；
 * 正文与标题都定位不到时退回整句（buildSnippet 返回 null，最终得到空串）——
 * 与既有"只命中标题时退回标题片段"的降级链保持一致。
 */
function snippetFor(row: SearchHitRow, terms: readonly string[], q: string, radius: number): string {
  const anchors = terms.length > 0 ? terms : [q]
  for (const anchor of anchors) {
    const content = buildSnippet(row.content, anchor, radius)
    if (content !== null) return content
  }
  for (const anchor of anchors) {
    const title = buildSnippet(row.title, anchor, radius)
    if (title !== null) return title
  }
  return ''
}
