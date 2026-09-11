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
import { asAsync, isAsyncAdapter, writeAuditLog, type DatabaseAdapter, type GeeWikiManifest, type HttpRouterService, type Principal, type RouteHandlerContext } from '@geewiki/core'

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
/** 命中的块（★ P3a：命中定位与高亮的唯一来源）。 */
export interface SearchBlockRef {
  ordinal: number
  kind: string
  text: string
}

export interface SearchHit {
  slug: string
  title: string
  snippet: string
  /**
   * ★ P3a：本页**当前主体可见**的块（按 `ordinal` 升序）。
   *
   * 为什么要有它：块级模型下"这一页为什么命中"必须落在**具体的块**上 —— 高亮片段
   * 也正是从这些块的文本里取的（见 {@link snippetFor}）。**这里只可能出现可见块**：
   * 不可见的块既不出现在数组里，其文本也从不经过 SQL 返回给本层。
   */
  blocks: readonly SearchBlockRef[]
  /**
   * ★ P3a：本页**被裁剪掉**（当前主体看不到）的块数。**不含任何内容，只是计数。**
   *
   * **对匿名主体恒为 0**（设计文档 §4.5 第 3 条）：匿名下若 `gatedCount > 0`，就等于
   * 确认"这里存在你看不到的内容"，那是存在性泄漏。故匿名一律拿到 0，与"这页确实没有
   * 受限块"不可区分。
   */
  gatedCount: number
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
  /**
   * ★ P3a：本主体**被显式授权**的块 id 集合 —— `granted` 档块的**唯一入口**。
   *
   * `granted` 档的 `blocks.tier` 写 `NULL`，因此**永远不会被等级分支命中**
   * （`NULL <= ?` 恒不成立，失败关闭，见 §4.3）：它只能靠检索时的这个授权分支放行。
   *
   * **为什么不在这里自己查 `block_grants`**：那会在检索插件里造出**第二套授权判定**，
   * 与 `policy-service` 的单点判定漂移。授权规则只有一处真源，本插件只消费它的结果。
   *
   * **返回空集合是正常情形**（没有任何块被单独授权），SQL 侧由 `visibilityPredicates`
   * 处理：空集合时用**字面量 `0`（恒假）/ `1`（恒真）**，**不是** `IN (NULL)` ——
   * `x NOT IN (NULL)` 与 `x IN (NULL)` 一样恒为 `NULL`（不是 `FALSE`），在 `WHERE` 里不成立，
   * 会让"受限块计数"恒为 0、探针与 `gatedCount` 双双失真。详见该函数的注释。
   */
  grantedBlockIds(principal: Principal): Promise<readonly number[]>
}

/**
 * ★ P3a：一页正文的**可见块投影**（`contents()` 的返回值，设计文档 §4.5）。
 *
 * 为什么不直接返回字符串：RAG 需要**块级引用定位**（`sources` 帧按 `ordinal` 指向具体块），
 * 而那必须来自**同一次**投影结果 —— 二次查询会让"答案提到了、sources 里没有"成为可能。
 */
export interface ContentView {
  /** 该主体可见块的拼接文本（块间 `'\n\n'`） */
  text: string
  /** 可见块，按 `ordinal` 升序 —— 供 `sources` 帧与引用定位 */
  blocks: readonly SearchBlockRef[]
  /** 被裁剪掉的块数（**不含内容**，仅计数）。**对匿名主体恒为 0**（同 {@link SearchHit.gatedCount}） */
  gatedCount: number
  /**
   * 可见块里 `tier` 的最大值（域 `{0,1}`）。
   * **仅诊断用**：它**不反映** `granted` 档的可见块（那些块 `tier` 为 `NULL`）。
   * 判定一律走 `policy-service`，**不得**据本字段做任何放行/拒绝。
   */
  maxVisibleTier: number
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
   * 按 slug 批量取**可见块投影**，供 RAG 拼上下文。
   * 只包含**真实存在且当前主体可见（`full` 档）**的 slug（查不到/无权看的键不出现）；
   * 空数组直接返回空 Map。**值里只有可见块** —— 不可见块的文本从不进入返回结构。
   *
   * ⚠️ 这是 RAG 的**正文入口**，也是 §5.6 点名的第三条泄漏旁路：调用方若绕过它
   * 直接读 `pages` / `blocks` 表，权限就白做了。裁剪在本方法内部完成（唯一出口）。
   *
   * ★ P3a：返回值由 `ReadonlyMap<string, string>` 改为 `ReadonlyMap<string, ContentView>`
   * （**破坏性契约变更**）—— RAG 的 `sources` 帧需要块级引用定位，而它必须来自同一次投影。
   */
  contents(principal: Principal, slugs: readonly string[]): Promise<ReadonlyMap<string, ContentView>>
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

/*
 * ★ P3a 删除了 `MAX_VISIBLE_SLUGS`（= 16_000）与 `visiblePlaceholders()` —— 它们是
 * "把可见 slug 集合下推进 `IN (...)`"那套做法的产物。改用 `blocks.tier` 之后：
 *   - 检索不再需要逐主体构造 slug 列表（等级过滤是**与主体无关**的列比较，见 §4.3）；
 *   - 于是那条"可见条目数超过 16_000 就显式抛错"的**规模边界也随之消失**。
 * 保留这段说明是为了让后人知道那道上限**不是被遗忘，而是被设计取代了**。
 */

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

/**
 * ★ P3a：检索的**页面级**结果行（每条命中一页）。
 *
 * 为什么还要页面级聚合：`hits` 的行语义是"一页"，而块级模型下一条 SQL 会为同一页
 * 返回**多行**（每个命中块一行）。若直接把这些行当 hits，`total`（= `COUNT(DISTINCT
 * b.page_id)`）与 `hits.length` 的行语义就对不上，分页也会错。
 * 故：**`LIMIT` 作用在页上**（Q1 先 `GROUP BY` 取出至多 `limit` 页），块再按页取（Q2）。
 */
interface PageHitRow {
  page_id: number
  slug: string
  title: string
  updated_at: string
  /** FTS 路为 `MIN(f.rank)`（BM25，**负值**，越小越相关）；LIKE 路不取（恒 0） */
  score?: number
}

/** ★ P3a：块行（Q2 的返回）。**只含可见块** —— 谓词在 SQL 里，不在这里过滤。 */
interface BlockRow {
  page_id: number
  ordinal: number
  kind: string
  text: string
  tier: number | null
}

/**
 * 把 `pages` 表从检索的列清单里摘掉了 —— 这是 P3a 的关键：**不再有
 * `p.content`**（它就是 §5.6 点名的泄漏源）。命中与高亮现在全部来自 `blocks`。
 */
const PAGE_COLUMNS = `p.id AS page_id, p.slug AS slug, p.title AS title, p.updated_at AS updated_at`
const BLOCK_COLUMNS = `b.page_id AS page_id, b.ordinal AS ordinal, b.kind AS kind, b.text AS text, b.tier AS tier`

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
     * **检索的单一实现**：`GET /api/search` 与 `search-service.search()` 都走这里。
     * 端点只负责把 HTTP 参数解析成 `(q, limit)` 并把结果包成响应体——
     * 若两处各写一份 SQL，迟早会出现"REST 与插件内检索结果不一致"的漂移。
     *
     * ★ P3a：**可见性判定全部下沉到 SQL**，走 `blocks.tier` 的等级分支与块级授权的
     * 授权分支（见 {@link visibilityPredicates}）。两条路（FTS / 短查询 LIKE）与
     * `contents()` 共用同一对谓词。**绝不先取全量再在 JS 里过滤** —— 那样 `total`、
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
       * ★ P3a：可见性判定**下沉到 SQL**，走 `blocks.tier` 的分层模型（设计文档 §4.3 / §5.6）。
       * 两条路共用同一对谓词，见 {@link visibilityPredicates}。
       *
       * **为什么不再用 `visibleSlugs()` 下推 `slug IN (...)`**：`blocks.tier` 已经把
       * "页面有效档位"与"块自身档位"合并成一个**与主体无关**的冗余列（`tierFor` 取更严
       * 的一方）。检索索引是全体的、不能按人算，所以等级过滤就该用这一列 —— 而把某个人的
       * 可见集合塞进 `IN` 列表既撞绑定上限（旧实现有一道 `MAX_VISIBLE_SLUGS` 硬闸），
       * 又**表达不了块级差异**。
       */
      const readerTier = readerTierOf(principal)
      const grantedIds = [...(await policy().grantedBlockIds(principal))]
      const vis = visibilityPredicates(readerTier, grantedIds)
      // 匿名主体不得拿到 `gatedCount`：`> 0` 就等于确认"这里存在你看不到的内容"（§4.5 第 3 条）
      const exposeGated = principal.kind !== 'anonymous'

      let total: number
      let pages: PageHitRow[]
      let mode: 'fts' | 'like'
      let scoreOf: (row: PageHitRow) => number

      if (useFts) {
        // phrase：整串一个短语。terms：每个词元各自 toFtsPhrase（**仍字面、仍防注入**）后 OR 连接。
        const matchExpr =
          queryMode === 'terms' ? terms.map((t) => toFtsPhrase(t)).join(' OR ') : toFtsPhrase(q)
        // ★ 坑 1（已实测）：tier 过滤**绝不能写在 FTS 表上** —— contentless 表的
        //   `UNINDEXED` 列不可读，谓词恒不成立 ⇒ **静默返回 0 行**（不报错）。
        //   正确形态是把 `tier` 冗余在 `blocks` 上，检索时 JOIN 过去过滤。
        // `COUNT(DISTINCT b.page_id)`：一条 SQL 会为同一页返回多个命中块（每块一行），
        // 不 distinct 的话 total 会把"块数"当成"页数"。
        total = countOf(
          db.query<{ n: number }>(
            `SELECT COUNT(DISTINCT b.page_id) AS n
               FROM blocks_fts f JOIN blocks b ON b.id = f.rowid
              WHERE f.blocks_fts MATCH ? AND ${vis.visible}`,
            [matchExpr, readerTier, ...vis.params],
          ),
        )
        // LIMIT 作用在**页**上（GROUP BY p.id），否则一页的多块命中会吃掉配额，
        // 让 hits 的页数少于 limit，且 total 与 hits 的行语义对不上。
        pages = db.query<PageHitRow>(
          `SELECT ${PAGE_COLUMNS}, MIN(f.rank) AS score
             FROM blocks_fts f JOIN blocks b ON b.id = f.rowid JOIN pages p ON p.id = b.page_id
            WHERE f.blocks_fts MATCH ? AND ${vis.visible}
            GROUP BY p.id ORDER BY score LIMIT ?`,
          [matchExpr, readerTier, ...vis.params, limit],
        )
        mode = 'fts'
        // BM25（FTS5 的 `rank`）原始值是**负的**，越小越相关；这里**取负**换成
        // "越大越相关"再对外。**这不是归一化**：值域没有界、量级随语料规模与查询词
        // 变化，故**只在同一次查询的结果内部可比**，跨查询（乃至跨库）比大小无意义。
        scoreOf = (row) => -(row.score ?? 0)
      } else {
        const pattern = `%${escapeLike(q)}%`
        // ★ 短查询 LIKE 路是**独立的另一条 SQL**（v1 曾漏判它）：它原先直接扫 `pages` 并读
        //   `p.content` —— 块级模型下那等于读出不看可见性的全文，中文 2 字词会成为匿名
        //   泄漏通道。现在改扫 `blocks`。
        //   **权衡退化（显式记录）**：兜底不再兜在"页面真源"上而兜在 `blocks` 上 ⇒ 若
        //   `blocks` 与 `pages.content` 漂移，短查询会漏行。缓解是 `content_hash` 自检 +
        //   `GET /api/admin/search/verify`，把"静默漏行"变成"显式不一致"。
        total = countOf(
          db.query<{ n: number }>(
            // 括号不能省：`A OR B AND C` 的优先级是 `A OR (B AND C)`，会让匹配条件与
            // 可见性谓词各作用于一半 —— 那是真实的泄漏路径。
            `SELECT COUNT(DISTINCT b.page_id) AS n
               FROM blocks b JOIN pages p ON p.id = b.page_id
              WHERE (p.title LIKE ? ESCAPE '\\' OR b.text LIKE ? ESCAPE '\\')
                AND ${vis.visible}`,
            [pattern, pattern, readerTier, ...vis.params],
          ),
        )
        pages = db.query<PageHitRow>(
          `SELECT ${PAGE_COLUMNS}
             FROM blocks b JOIN pages p ON p.id = b.page_id
            WHERE (p.title LIKE ? ESCAPE '\\' OR b.text LIKE ? ESCAPE '\\')
              AND ${vis.visible}
            GROUP BY p.id ORDER BY p.updated_at DESC LIMIT ?`,
          [pattern, pattern, readerTier, ...vis.params, limit],
        )
        mode = 'like'
        // LIKE 路没有相关度可言（全表子串匹配），统一给 0；
        // 两种 mode 的 score 只在各自内部可比，跨 mode 不要比大小
        scoreOf = () => 0
      }

      /*
       * 命中页的**可见块**（Q2）与**受限块计数**（Q3）。
       *
       * 为什么分两条查、而不是把受限块也取回来在 JS 里分开：那会把**受限块的文本**带进
       * 本层内存 —— 一旦后续某处漏判就会泄漏。这里受限块的文本**从不离开数据库**，
       * 出来的只有一个计数。
       */
      const pageIds = pages.map((r) => r.page_id)
      const blocksByPage = new Map<number, SearchBlockRef[]>()
      if (pageIds.length > 0) {
        const rows = db.query<BlockRow>(
          `SELECT ${BLOCK_COLUMNS} FROM blocks b
            WHERE b.page_id IN (${placeholders(pageIds.length)}) AND ${vis.visible}
            ORDER BY b.page_id, b.ordinal`,
          [...pageIds, readerTier, ...vis.params],
        )
        for (const r of rows) {
          const list = blocksByPage.get(r.page_id) ?? []
          list.push({ ordinal: r.ordinal, kind: r.kind, text: r.text })
          blocksByPage.set(r.page_id, list)
        }
      }

      const gatedByPage = new Map<number, number>()
      if (exposeGated && pageIds.length > 0) {
        const rows = db.query<{ page_id: number; n: number }>(
          `SELECT b.page_id AS page_id, COUNT(*) AS n FROM blocks b
            WHERE b.page_id IN (${placeholders(pageIds.length)}) AND ${vis.gated}
            GROUP BY b.page_id`,
          [...pageIds, readerTier, ...vis.params],
        )
        for (const r of rows) gatedByPage.set(r.page_id, Number(r.n))
      }

      return {
        mode,
        total,
        hits: pages.map((row) => {
          const blocks = blocksByPage.get(row.page_id) ?? []
          return {
            slug: row.slug,
            title: row.title,
            // 片段优先取**可见块**的正文；都没定位到（例如只命中标题）时退回标题。
            // terms 模式下**不能用整句去定位**：问句本身不在正文里，那样每条命中都会
            // snippet 为空、高亮消失（命中却看不到"为什么命中"）。故逐个词元试。
            snippet: snippetFor({ title: row.title, blocks }, terms, q, snippetRadius),
            blocks,
            gatedCount: exposeGated ? (gatedByPage.get(row.page_id) ?? 0) : 0,
            score: scoreOf(row),
            updated_at: row.updated_at,
          }
        }),
      }
    }

    /**
     * 批量取**可见块投影**（RAG 拼上下文用）。
     *
     * ★ P3a：这是第三条泄漏旁路的封堵点（另两处是检索的 FTS 路与 LIKE 路）。它现在
     * **只从 `blocks` 取内容**，并按可见性谓词在 SQL 里过滤 —— `pages.content` 是
     * 作者源快照（含未裁剪的全文与标记本身）⇒ **绝不能再作为 RAG 的正文来源**。
     *
     * **占位符按个数动态生成**：SQLite 的 `?` 绑定不接受数组，故必须按个数拼 `?,?,?`。
     * **拼的只是占位符本身，slug / id 值一律走参数绑定** —— 绝不把文本拼进 SQL。
     */
    const contents = async (
      principal: Principal,
      slugs: readonly string[],
    ): Promise<ReadonlyMap<string, ContentView>> => {
      assertLive()
      assertPrincipal(principal)
      const out = new Map<string, ContentView>()
      if (slugs.length === 0) return out

      const readerTier = readerTierOf(principal)
      const grantedIds = [...(await policy().grantedBlockIds(principal))]
      const vis = visibilityPredicates(readerTier, grantedIds)
      const exposeGated = principal.kind !== 'anonymous'

      // 先把 slug 映射成 page_id —— **这条 SQL 不取任何正文**（只取 id/slug），
      // 所以它本身不构成泄漏面；真正的裁剪在下面那条带可见性谓词的块查询上。
      // 也因此不必再走 `visibleSlugs()` 求交集：页面级有效档位已经体现在 `blocks.tier` 里。
      const pageRows = db.query<{ id: number; slug: string }>(
        `SELECT id, slug FROM pages WHERE slug IN (${placeholders(slugs.length)})`,
        [...slugs],
      )
      if (pageRows.length === 0) return out
      const pageIds = pageRows.map((r) => r.id)

      const rows = db.query<BlockRow>(
        `SELECT ${BLOCK_COLUMNS} FROM blocks b
          WHERE b.page_id IN (${placeholders(pageIds.length)}) AND ${vis.visible}
          ORDER BY b.page_id, b.ordinal`,
        [...pageIds, readerTier, ...vis.params],
      )
      const byPage = new Map<number, BlockRow[]>()
      for (const r of rows) {
        const list = byPage.get(r.page_id) ?? []
        list.push(r)
        byPage.set(r.page_id, list)
      }

      // 受限块**只计数、不取文本**（同一理由：受限块的文本从不离开数据库）
      const gatedByPage = new Map<number, number>()
      if (exposeGated) {
        const g = db.query<{ page_id: number; n: number }>(
          `SELECT b.page_id AS page_id, COUNT(*) AS n FROM blocks b
            WHERE b.page_id IN (${placeholders(pageIds.length)}) AND ${vis.gated}
            GROUP BY b.page_id`,
          [...pageIds, readerTier, ...vis.params],
        )
        for (const r of g) gatedByPage.set(r.page_id, Number(r.n))
      }

      for (const row of pageRows) {
        const own = byPage.get(row.id) ?? []
        /*
         * 一个可见块都没有 ⇒ **不进 Map**（与既有语义一致：查不到 / 无权看的 slug 都不出现）。
         * 这里刻意把"页面存在但块全受限"与"页面不存在"压成同一种表现 —— 后者本就不该出现，
         * 而前者若出现在 Map 里，RAG 的 `sources` 帧就会带出空条目并**暗示存在受限内容**。
         */
        if (own.length === 0) continue
        out.set(row.slug, {
          text: own.map((b) => b.text).join('\n\n'),
          blocks: own.map((b) => ({ ordinal: b.ordinal, kind: b.kind, text: b.text })),
          gatedCount: exposeGated ? (gatedByPage.get(row.id) ?? 0) : 0,
          // 仅诊断用：`granted` 档的可见块 `tier` 为 NULL，故本值不反映它们
          maxVisibleTier: own.reduce((m, b) => Math.max(m, b.tier ?? 0), 0),
        })
      }
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

    /* ---------- GET /api/admin/search/verify：块索引一致性探针 ---------- */
    /*
     * 设计文档 §8.2 的 P3a 验收第 3 条（编排者裁定：该端点从 P4 提前到 P3a —— 没有它
     * 就无法验收 P3a 自身）。
     *
     * ## 它为什么必须存在
     *
     * `blocks_fts` 是 contentless 表且**没有触发器**：tier 重算依赖页面有效档位（含祖先
     * 交集与发布闸门），不是触发器能表达的 SQL，所以同步责任落在应用层（见
     * `rebuildBlocksIndex` 与 `@geewiki/wiki` 的 `syncBlocksForPage`）。
     * **纪律没有编译期约束**，故必须有探针兜底：任何绕过写入路径、或"块有而索引空"的
     * 窗口，都会在这里以非零 `missing` / `extra` 显式报出。
     *
     * ## 四项检查
     *
     *   1. `missing` —— `blocks` 里有、索引里没有（**检索会少召回**）
     *   2. `extra`  —— 索引里有、`blocks` 里没有（**索引孤儿**：块已删、文本还在索引文件里）
     *   3. `tier_mismatch` —— `blocks.tier IS NULL` 的条数是否等于 `visibility='granted'` 的条数
     *      （§8.2 P3a 第 10 条。不等说明 `tier` 算错了：要么该 `NULL` 的没 `NULL`，
     *      要么不该 `NULL` 的成了 `NULL`。）
     *   4. `sample_misses` —— 抽样若干块，从文本里取一段 ≥3 字符的 token 用 `MATCH` 反查，
     *      确认**索引真的能命中这些行**。前三项只比行数，行数对而词元全丢的可能性它挡不住。
     *
     * ## 索引表不存在时
     *
     * 那是"**索引缺失**"而不是"漂移"（搜索是可选插件；`blocks_fts` 由本插件的迁移建立）。
     * 此时 `missing` / `extra` 无意义，如实给 `null` 并标 `index: 'absent'`，
     * 而不是拿 `missing = 全部块数` 去冒充一个吓人的数字。
     */
    cleanups.push(
      router.register(
        'GET',
        '/api/admin/search/verify',
        (h: RouteHandlerContext) => {
          const principal = h.principal
          if (!principal) {
            h.json(401, { ok: false, error: 'unauthorized', message: '缺少主体信息' })
            return
          }

          /*
           * 从块文本里取第一段 ≥3 字符的连续字母/数字/CJK —— 那是 trigram 索引的**最小
           * 可匹配单元**。短于 3 字符的查询在 `MATCH` 下恒为空（已实测：2 字查询返回空集），
           * 故抽样必须从这里取，不能拿整个块文本或随便一段字符去试。
           */
          const firstTokenRun = (text: string): string | null => {
            const m = /[\p{L}\p{N}]{3,}/u.exec(text)
            return m ? m[0].slice(0, 12) : null
          }

          // PG 的 `COUNT(*)` 返回的是**字符串**，必须强转（§9 R8）
          const countOf = (sql: string): number => Number(db.query<{ n: unknown }>(sql)[0]?.n ?? 0)

          const blocks = countOf('SELECT COUNT(*) AS n FROM blocks')
          const tierNull = countOf('SELECT COUNT(*) AS n FROM blocks WHERE tier IS NULL')
          const granted = countOf("SELECT COUNT(*) AS n FROM blocks WHERE visibility = 'granted'")

          let indexPresent = true
          try {
            db.query('SELECT 1 FROM blocks_fts LIMIT 1')
          } catch {
            indexPresent = false
          }

          const VERIFY_SAMPLE_SIZE = 20
          let missing: number | null = null
          let extra: number | null = null
          let sampled = 0
          let sampleMisses = 0
          const missSamples: number[] = []

          if (indexPresent) {
            missing = countOf(
              'SELECT COUNT(*) AS n FROM blocks b WHERE NOT EXISTS (SELECT 1 FROM blocks_fts f WHERE f.rowid = b.id)',
            )
            extra = countOf(
              'SELECT COUNT(*) AS n FROM blocks_fts f WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = f.rowid)',
            )
            const rows = db.query<{ id: number; text: string }>(
              'SELECT id, text FROM blocks ORDER BY id LIMIT ?',
              [VERIFY_SAMPLE_SIZE],
            )
            for (const r of rows) {
              const token = firstTokenRun(r.text)
              if (!token) continue
              sampled += 1
              const hits = db.query<{ rowid: number }>('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', [
                toFtsPhrase(token),
              ])
              if (!hits.some((x) => Number(x.rowid) === Number(r.id))) {
                sampleMisses += 1
                if (missSamples.length < 5) missSamples.push(Number(r.id))
              }
            }
          }

          const payload = {
            ok: true as const,
            index: indexPresent ? ('present' as const) : ('absent' as const),
            blocks,
            missing,
            extra,
            tier_null: tierNull,
            granted,
            tier_mismatch: tierNull !== granted,
            sampled,
            sample_misses: sampleMisses,
            miss_samples: missSamples,
          }

          // 审计：只记计数，**不含正文**
          // `writeAuditLog` 的 `AuditExecutor` 是**异步**形态（`run` 返回 Promise），
          // 而本插件是同步适配器 ⇒ 用 `asAsync()` 包一层（与 plugin-wiki 的 `adb` 同源）。
          void writeAuditLog(asAsync(db), {
            action: 'admin.verify_search',
            targetKind: 'system',
            targetId: 'blocks_fts',
            actorId: principal.userId,
            after: {
              index: payload.index,
              blocks,
              missing,
              extra,
              tier_mismatch: payload.tier_mismatch,
              sample_misses: sampleMisses,
            },
          }).catch((err: unknown) => console.error('[@geewiki/search] 审计写入失败:', err))

          h.json(200, payload)
        },
        { access: 'admin' },
      ),
    )

    // 真正创建 cordis 服务：manifest 的 provides 只是依赖图 token，不会建服务。
    // 两者名字**必须一致**（'search-service'），否则消费方 ctx.get 拿到 undefined，
    // 表现为"AI 永远只回空结果"这类极难定位的症状。
    const unprovide = ctx.provide('search-service', svc)

    /*
     * ★ P3a：**从 `blocks` 重建 `blocks_fts`**（§4.3）。
     *
     * ## 为什么必须在激活时做
     *
     * `blocks_fts` 是 contentless 表，**没有触发器** —— tier 重算是业务逻辑（依赖页面有效
     * 档位，含祖先交集与发布闸门），不是触发器能表达的 SQL，所以同步责任在应用层。
     * 而 `@geewiki/wiki` 的**存量块回填发生在它自己激活时**，那一刻本插件可能尚未激活、
     * `blocks_fts` 这张表**根本不存在** ⇒ `syncBlocksForPage` 会跳过索引写入
     * （它刻意不因索引缺席而让"保存页面"失败）。结果是"**块有、索引空**"⇒ 检索恒为空。
     * 本函数补的就是这个窗口。
     *
     * ## 为什么是"全量清空 + 逐块插入"而不是增量
     *
     * contentless 表上裸 `DELETE FROM` 可用（已实测：清空后 `count(*)=0`，之后可正常插入
     * 与 MATCH），所以清空重建能连**索引孤儿行**（块已删、索引行还在）一并清掉 ——
     * 那正是按 rowid 增量删清不干净的东西，也是 `GET /api/admin/search/verify` 的
     * `extra` 计数会报出来的东西。整体幂等，重启重跑无副作用。
     *
     * ## 为什么是同步的
     *
     * 本插件在 `apply()` 顶部就有**方言守卫**：非 `sqlite` 一律同步抛错（FTS5 是 SQLite
     * 专有）。所以走到这里 `db` **必然是同步适配器**，用它的 `transaction(fn)` / `run`
     * 即可，`apply` 保持同步 ⇒ 守卫那句 `throw` 仍然同步，既有 `assert.throws` 用例不受影响。
     *
     * 失败**不阻断激活**：索引随时可以从 `blocks`（真源）重建，而"插件激活不了"等于检索
     * 功能整体不可用 —— 两者代价不对等。差异由 verify 探针显式报出，不靠静默。
     */
    const rebuildBlocksIndex = (): void => {
      try {
        const rows = db.query<{ id: number; text: string }>('SELECT id, text FROM blocks ORDER BY id')
        db.transaction(() => {
          db.run('DELETE FROM blocks_fts')
          for (const r of rows) {
            db.run('INSERT INTO blocks_fts (rowid, text) VALUES (?, ?)', [r.id, r.text])
          }
        })
        if (rows.length === 0) {
          /*
           * `0 块` 不是故障，但**很容易被误读成"索引被清空了"**，故显式解释：
           * 本插件与 `@geewiki/wiki` 之间**没有依赖边**，激活顺序不保证。若本插件先激活，
           * 此刻 wiki 的存量块回填还没跑（`blocks` 尚为空）；等它跑完，`syncBlocksForPage`
           * 会因为 `blocks_fts` 已存在而**一并写入索引** —— 两条顺序最终都收敛到"索引与
           * `blocks` 一致"。真出问题由 `GET /api/admin/search/verify` 报，不靠这行日志判断。
           */
          console.log('[@geewiki/search] 块索引已从 blocks 重建: 0 块（blocks 当前为空；若 wiki 稍后回填存量块，它会一并写入索引）')
        } else {
          console.log(`[@geewiki/search] 块索引已从 blocks 重建: ${rows.length} 块`)
        }
      } catch (err) {
        console.warn(
          '[@geewiki/search] 块索引重建失败（检索可能不完整；`blocks` 是真源，重启可重建）。原因:',
          err,
        )
      }
    }
    rebuildBlocksIndex()

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

/** `?,?,?` 占位符串（个数决定），值一律走参数绑定 */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/**
 * ★ P3a：主体的**读者等级**（`blocks.tier` 的分档刻度）。
 *
 * - 匿名 ⇒ `0`：只够得着 `tier = 0`（有效公开）的块
 * - **组织成员（有 `orgRole`）** ⇒ `1`：还够得着 `tier = 1`（组织内）的块
 * - `guest`（已登录但无组织角色，`orgRole === null`）⇒ **`0`**：他不是组织成员，
 *   `org` 档的内容与他无关（设计 §2.1：guest 是"没有默认组织角色"，不是最低档角色）
 * - break-glass ⇒ `1`：应急通道视同最高读者等级
 *
 * ⚠️ **不能只看 `kind === 'user'`**：那会把 guest 抬到 `org` 档，等于让"登录了但不是
 * 成员"的人读到组织内内容。
 */
function readerTierOf(principal: Principal): 0 | 1 {
  if (principal.kind === 'break-glass') return 1
  return principal.orgRole !== null ? 1 : 0
}

/**
 * ★ P3a：检索的可见性谓词（**两个分支，缺一不可**，设计文档 §4.3 / §5.6）。
 *
 * ```
 * 可见  = ( b.tier <= :readerTier OR b.id IN (:grantedBlockIds) )
 * 受限  = ( b.tier IS NULL OR b.tier > :readerTier ) AND b.id NOT IN (:grantedBlockIds)
 * ```
 *
 * **为什么空列表时用字面量 `0` / `1` 而不是 `IN (NULL)`**：`x NOT IN (NULL)` 与
 * `x IN (NULL)` 一样恒为 `NULL`（不是 `FALSE`），而 `NULL` 在 `WHERE` 里不成立 ——
 * 于是"受限块计数"会恒为 0，探针与 `gatedCount` 双双失真。用 `0`（恒假）与 `1`（恒真）
 * 既准确又无需绑定参数。
 *
 * **为什么 `tier` 的比较天然 NULL 安全**：`NULL <= ?` 求值为 `NULL` ⇒ 不成立 ⇒
 * `granted` 档（`tier IS NULL`）**永不被等级分支命中**，只能由授权分支放行。
 * 这是刻意的失败关闭方向（写错的后果是"搜不到"，不是"泄漏"）。
 */
function visibilityPredicates(readerTier: 0 | 1, grantedIds: readonly number[]): {
  visible: string
  gated: string
  params: number[]
} {
  const positive = grantedIds.length === 0 ? '0' : `b.id IN (${placeholders(grantedIds.length)})`
  const negative = grantedIds.length === 0 ? '1' : `b.id NOT IN (${placeholders(grantedIds.length)})`
  return {
    // 括号不能省：`A OR B AND C` 的优先级是 `A OR (B AND C)`。调用方会把本谓词与
    // 其它条件用 `AND` 串起来，少了这层括号会让可见性只作用于其中一个分支。
    visible: `( b.tier <= ? OR ${positive} )`,
    gated: `( ( b.tier IS NULL OR b.tier > ? ) AND ${negative} )`,
    params: [...grantedIds],
  }
}

/**
 * 取一条命中的高亮片段。
 *
 * phrase 模式：整串即锚点（行为与既有实现逐字一致）。
 * terms 模式：整句通常不在正文里，故**按词元顺序**试锚点，取第一个能定位到的；
 * 块正文与标题都定位不到时退回整句（buildSnippet 返回 null，最终得到空串）——
 * 与既有"只命中标题时退回标题片段"的降级链保持一致。
 *
 * ★ P3a：片段来源由 `pages.content` 换成**该主体可见的块**（按 `ordinal` 升序）。
 * 两个必须守住的性质：
 *   1. **只用可见块** —— 受限块的文本从不进入参数，故片段里不可能出现它；
 *   2. **非空且含命中词** —— 不能用 FTS5 的 `snippet()`：实测它在 contentless 表上
 *      **静默返回 `null` 而不报错**，一旦沿用会让所有高亮静默消失。这里自己定位，
 *      并有"高亮非空且含命中词"的单测钉住。
 */
function snippetFor(
  hit: { title: string; blocks: readonly SearchBlockRef[] },
  terms: readonly string[],
  q: string,
  radius: number,
): string {
  const anchors = terms.length > 0 ? terms : [q]
  for (const block of hit.blocks) {
    for (const anchor of anchors) {
      const content = buildSnippet(block.text, anchor, radius)
      if (content !== null) return content
    }
  }
  for (const anchor of anchors) {
    const title = buildSnippet(hit.title, anchor, radius)
    if (title !== null) return title
  }
  return ''
}
