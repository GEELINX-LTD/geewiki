/**
 * @geewiki/wiki —— GeeWiki Wiki 核心插件
 *
 * 面向 DatabaseAdapter 编程（不依赖具体数据库实现），提供页面
 * 与版本历史的 REST API。每个页面正文更新前把旧内容写入
 * page_versions 快照（版本即历史），删除页面时级联清空历史。
 *
 * 挂载路由（经 @geewiki/http 路由服务）：
 *   GET    /api/pages         页面列表（摘要，含版本数）
 *   GET    /api/pages/:slug   页面详情（正文 + 版本历史）
 *   PUT    /api/pages/:slug   新建或更新（幂等 upsert）
 *   DELETE /api/pages/:slug   删除页面（含历史）
 *
 * 同时经 `ctx.provide('wiki-service', …)` 提供页面服务（契约见 WikiService）：
 * 方法集与上述四个端点一一对应，两者**共用同一份内部实现**（listPages/getPage/
 * savePage/deletePage），故同一入参下结果逐字段一致。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { closeAfterResponse, isAsyncAdapter, type DatabaseAdapter, type GeeWikiManifest, type HttpRouterService, type RouteHandlerContext } from '@geewiki/core'
import { extractLinkTargets } from './links.js'

/**
 * 本插件自带迁移目录（`page_links` 表）。
 *
 * **为什么在 `apply` 里自己跑 `db.migrate()`，而不是靠 `manifest.geewiki.migrations`**：
 * 内置插件的迁移目录是在组合根 `defaultRegistry()` 里**硬编码**的
 * （见 `packages/server/src/index.ts` 各条目的 `migrationsDirs`），manifest 的那个字段
 * 只对**外部**插件（走 discovery）生效。本插件的表此前一直由 db-sqlite 的 `0001` 建立，
 * 故当时 `migrations` 是 `undefined`；新增 `page_links` 时若走注册表路径就需要改 server，
 * 而自己应用同样安全：`db.migrate()` 以 `_migrations` 表去重，天然幂等、可重放。
 * 该常量已导出，将来若把迁移目录上移到注册表，直接引用它即可（重复应用无害）。
 */
export const WIKI_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export interface WikiConfig {
  /** 页面详情中返回的最近版本历史条数上限 */
  recentVersions?: number
}

/**
 * 配置 Schema（schemastery）：驱动管理台自动生成配置表单，并在配置热更新前做校验。
 * 同一实例也作为插件模块的 Config（cordis 据此自动校验并填默认值）。
 */
export const WikiConfigSchema = Schema.object({
  recentVersions: Schema.number()
    .default(10)
    .min(1)
    .max(100)
    .description('页面详情返回的最近版本历史条数上限'),
})

/* ======================= wiki-service 服务契约 ======================= */

/** 页面摘要（对应 GET /api/pages 的单项） */
export interface WikiPageSummary {
  slug: string
  title: string
  updated_at: string
  /** 版本号 = 历史快照数 + 1（与端点同口径） */
  version: number
}

/** 页面详情（对应 GET /api/pages/:slug 的响应体） */
export interface WikiPageDetail {
  slug: string
  title: string
  content: string
  created_at: string
  updated_at: string
  version: number
  /** 最近版本历史（条数受 config.recentVersions 限制，按 id 倒序） */
  versions: { id: number; saved_at: string }[]
}

export interface WikiSaveInput {
  title: string
  content: string
}

export interface WikiSaveResult {
  outcome: 'created' | 'updated' | 'unchanged'
  version: number
}

/** 反向链接项：**引用**了某页的页面（对应 GET /api/pages/:slug/backlinks 的单项） */
export interface WikiBacklink {
  slug: string
  title: string
}

/**
 * 正向链接项：某页正文里**指向**的目标。
 *
 * `title` 为 `null` 表示目标页面**尚不存在**（先写引用、后建页面是正常用法，
 * 与 wiki 的"红链"语义一致），这正是本表 `target_slug` 不加外键的原因。
 */
export interface WikiOutlink {
  slug: string
  title: string | null
}

/**
 * `wiki-service` 服务契约（本插件经 `ctx.provide('wiki-service', svc)` 提供）。
 *
 * 存在的意义：让消费方**不必**直接 `SELECT` 本插件的 `pages` / `page_versions` 表——
 * 那会把表结构变成跨包隐式契约，并绕开本插件的"幂等保存 + 版本快照"语义
 * （保存时先快照旧正文；标题与正文都未变化时不写历史、不动 updated_at）。
 *
 * **为什么必须有它**：manifest 的 `geewiki.provides` 只是依赖图 token，**不会**创建
 * cordis 服务。此前本插件声明了 `provides: 'wiki-service'` 却从未 `ctx.provide`，
 * 于是任何按 `requires: ['wiki-service']` 依赖本插件的消费方 `ctx.get('wiki-service')`
 * 都会拿到 `undefined`（同类症状极难定位：调用方看到的只是"永远拿不到数据"）。
 *
 * **方法集与四个 REST 端点一一对应**（不引入端点之外的新语义）：
 *   list()   ↔ GET    /api/pages
 *   get()    ↔ GET    /api/pages/:slug
 *   save()   ↔ PUT    /api/pages/:slug
 *   remove() ↔ DELETE /api/pages/:slug
 *   backlinks() ↔ GET /api/pages/:slug/backlinks
 *   links()     ↔ GET /api/pages/:slug/links
 *
 * 入参非法时抛错（而非静默返回空值）：`message` 以 `<code>: ` 开头，`code` 与端点的
 * 400/413 错误码同源（`invalid_slug` / `invalid_title` / `content_too_large`）。
 */
export interface WikiService {
  /** 页面摘要列表（按 updated_at 倒序，与端点同序） */
  list(): WikiPageSummary[]
  /** 页面详情；slug 不存在时返回 `undefined`（对应端点 404） */
  get(slug: string): WikiPageDetail | undefined
  /** 新建或更新（幂等 upsert）：标题与正文均未变化时 outcome='unchanged' 且不写历史 */
  save(slug: string, input: WikiSaveInput): WikiSaveResult
  /** 删除页面及其全部版本历史；返回是否确实删除（false 对应端点 404） */
  remove(slug: string): boolean
  /** 引用了该页的页面（按标题、slug 稳定排序）；页面不存在时返回 `undefined`（对应端点 404） */
  backlinks(slug: string): WikiBacklink[] | undefined
  /** 该页正文指向的目标（含尚未创建的页面，其 title 为 null）；同理 `undefined` 对应 404 */
  links(slug: string): WikiOutlink[] | undefined
}

export const manifest: GeeWikiManifest = {
  name: '@geewiki/wiki',
  version: '0.1.0',
  geewiki: {
    displayName: '知识库页面',
    description: '创建、编辑与删除页面，并保留每次保存的历史版本',
    provides: 'wiki-service',
    // 依赖以服务标识声明（非具体插件名）：数据库切换（SQLite→PG）对业务插件透明，
    // 依赖边由管理器按 provides 解析（deps.ts resolveDependency）
    requires: ['http-service', 'database-provider'],
    conflictGroup: undefined,
    // 页面/版本历史两张表由 db-sqlite 的 0001 迁移建立（本插件在 db 之后激活）。
    // 本插件**自己**的迁移（page_links）不在此声明：内置插件的迁移目录在组合根
    // `defaultRegistry()` 里硬编码，manifest 该字段只对外部插件生效；
    // 故由 `apply()` 直接调用 `db.migrate(WIKI_MIGRATIONS_DIR)`，见该常量注释。
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无内部状态：可安全热插拔
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: WikiConfigSchema,
    // **本插件当前没有真实的前端界面**，故不声明 `geewiki.client`。
    //
    // 曾经这里声明过 `client`，而 `packages/web/fixtures/` 的验收夹具（计数器 + 抛错按钮）
    // 正好被构建到了 `plugins-ui/@geewiki/wiki/`，于是**测试脚手架冒充成本插件的 UI 贡献**，
    // 出现在产品页头/页脚的插槽里。夹具现已改为独立示例插件（`plugins/ui-demo/`）。
    //
    // 将来若真做出 wiki 的界面产物，把 `client` 加回来即可 —— 契约与入口表机制
    // （`GeeWikiClient` 类型、`GET /api/plugins/ui`）都未改动。
  },
}

interface PageRow {
  id: number
  slug: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

/**
 * 读取并解析 JSON 请求体（上限 1MB，与 manager 的 readJsonBody 同范式）：
 * - 超限：暂停读取剩余请求体，以 `payload_too_large` 前缀的错误拒绝；
 *   响应由调用方经统一出口 `h.json(413, …)` 写出（保证计入 stats()，见看门狗探针）；
 * - 畸形 JSON：以 `invalid_json` 前缀错误拒绝（→ 400）。
 */
function readBody(h: RouteHandlerContext, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let rejected = false
    const chunks: Buffer[] = []
    h.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        if (rejected) return // 已拒绝：忽略后续数据块
        rejected = true
        // 不再消费剩余请求体：交由调用方写出 413 后关闭连接（见 PUT 处理器）
        h.req.pause()
        rejectBody(new Error(`payload_too_large: 请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    h.req.on('end', () => {
      if (rejected) return
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        rejectBody(new Error(`invalid_json: ${(err as Error).message}`))
      }
    })
    h.req.on('error', (err) => {
      if (!rejected) rejectBody(err)
    })
  })
}

/**
 * 单个 slug 段的字符集：字母或数字开头，仅含 a-z A-Z 0-9 . _ -。
 *
 * 与改造前的整串正则**逐字相同**，只是现在应用到**每一段**而不是整串——
 * 因此既有扁平 slug（`getting-started`）的判定结果一字未变。
 * 该正则天然拒绝：空段、以 `.`/`-`/`_` 开头的段、含 `/` 以外的特殊字符、以及 `..`。
 */
const SLUG_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

/** slug 总长上限（沿用既有 ≤80 的预算；层级路径的各段共享这一预算） */
export const SLUG_MAX_LENGTH = 80

/** 层级深度上限：超过即拒绝（避免无意义的极深嵌套） */
export const SLUG_MAX_DEPTH = 8

/**
 * 会被**前端路由吃掉**的保留首段：这些路径永远进不了详情页。
 * 与服务端无关，但若允许创建，用户会得到一个"建得出来却打不开"的页面。
 *   来源：`packages/web/src/pages/WikiPage.tsx` 的 hash 路由分发
 *
 * 导出是刻意的：**这里是单一事实来源**，前端的镜像规则应当消费它而不是各写一份
 * （前端目前仍是自己的副本，待其批次对齐）。
 */
export const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(['search', 'ask', 'new', 'list'])

/** 第二段为该值时是"编辑"路由（`<slug>/edit`），故不能作为页面路径的第二段 */
export const RESERVED_SECOND_SEGMENT = 'edit'

/**
 * slug 是否合法（**端点与服务共用的唯一判定**）。
 *
 * 规则（自本批起支持 `/` 分层）：
 *   - 非空，总长 ≤ {@link SLUG_MAX_LENGTH}，段数 ≤ {@link SLUG_MAX_DEPTH}
 *   - 每段都满足 {@link SLUG_SEGMENT_RE}（⇒ 拒绝空段、首尾斜杠、`.`/`..`、非法字符）
 *   - 首段不在 {@link RESERVED_FIRST_SEGMENTS}，第二段不是 {@link RESERVED_SECOND_SEGMENT}
 *
 * 为什么不用单个正则：保留段判定依赖"第几段"的位置语义，正则表达力用尽也难读；
 * 拆成"逐段字符集 + 位置规则"两件事后，每条规则都能单独测试。
 */
export function isValidSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) return false
  const segs = slug.split('/')
  if (segs.length > SLUG_MAX_DEPTH) return false
  // 逐段校验同时覆盖了：空段（`a//b`、首尾斜杠）、`.`/`..`（首字符必须字母数字）
  for (const seg of segs) {
    if (!SLUG_SEGMENT_RE.test(seg)) return false
  }
  if (RESERVED_FIRST_SEGMENTS.has(segs[0] as string)) return false
  if (segs.length >= 2 && segs[1] === RESERVED_SECOND_SEGMENT) return false
  return true
}

/** slug 非法时的提示文案（端点与服务共用同一份文案） */
export const SLUG_HINT =
  '页面标识非法：每段须以字母或数字开头，仅含 a-z 0-9 . _ -；可用 / 分层；总长 ≤80 字符；首段不能是 search/ask/new/list，第二段不能是 edit'

/**
 * slug 校验（服务层入口）：非法即抛错。消息以 `invalid_slug: ` 开头——
 * 沿用本插件"消息前缀即错误码"的既有约定（端点据前缀/码分流 400/413）。
 */
function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) throw new Error(`invalid_slug: ${SLUG_HINT}`)
}

/**
 * 归一化并校验标题/正文（**端点与服务共用的唯一实现**）。
 * 消息前缀保持既有约定：`invalid_title` → 400、`content_too_large` → 413。
 */
function normalizeSaveFields(title: unknown, content: unknown): WikiSaveInput {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  const body = typeof content === 'string' ? content : ''
  if (!trimmed) throw new Error('invalid_title: 标题不能为空')
  if (trimmed.length > 200) throw new Error('invalid_title: 标题过长（≤200 字符）')
  if (body.length > 500_000) throw new Error('content_too_large: 正文过长（≤500KB）')
  return { title: trimmed, content: body }
}

/** 从请求体提取 { title, content }：白名单字段，未知字段/超限一律 400 */
function parseSaveBody(body: unknown): WikiSaveInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b !== 'object' || Array.isArray(b)) {
    throw new Error('invalid_body: 请求体须为 JSON 对象')
  }
  const unknown = Object.keys(b).filter((k) => k !== 'title' && k !== 'content')
  if (unknown.length > 0) {
    throw new Error(`invalid_body: 未知字段: ${unknown.join(', ')}`)
  }
  return normalizeSaveFields(b.title, b.content)
}

export const WikiPlugin = {
  name: '@geewiki/wiki',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: WikiConfigSchema,

  apply(ctx: Context, config: WikiConfig = {}) {
    const db = ctx.get('db') as DatabaseAdapter | undefined
    if (!db) throw new Error('@geewiki/wiki: 数据库服务不可用（@geewiki/db-sqlite 未激活）')
    // **能力边界：显式失败，而不是静默坏掉**。本插件的查询/事务按**同步**适配器
    // （better-sqlite3）编写；异步驱动（PostgreSQL）下这些调用返回 Promise 而拿不到行，
    // 表现为"能启动但每个接口都读不到数据"——最难排查的一类故障。
    // 异步化改造（约 15 处 db 调用）留待后续批次；在此之前明确拒绝并给出可执行指引。
    if (isAsyncAdapter(db)) {
      throw new Error(
        `@geewiki/wiki: 当前数据库是异步适配器（${db.dialect}），本插件尚未支持。` +
          '请改用 @geewiki/db-sqlite，或等待本插件的异步化改造（见 docs/plugin-platform-plan.md 的 PostgreSQL 条目）。',
      )
    }
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/wiki: http 路由服务不可用（@geewiki/http 未激活）')
    const recentLimit = config.recentVersions ?? 10

    const cleanups: (() => void)[] = []

    /* ---------------------------------------------------------------------
     * 迁移与反向链接回填
     *
     * `page_links` 是本插件**自己的**表，故在此应用自带迁移（理由见 WIKI_MIGRATIONS_DIR）。
     * 用 `appliedMigrations()` 的前后差判断"这次是否真的应用了新脚本"——只有真应用了才回填，
     * 于是回填**恰好发生一次**（老库升级时），新装的库因 pages 为空而是空操作，
     * 后续每次启动都直接跳过（不会重复扫描全部正文）。
     * ------------------------------------------------------------------- */
    const migrationsBefore = new Set(db.appliedMigrations())
    db.migrate(WIKI_MIGRATIONS_DIR)
    const justAppliedMigration = db.appliedMigrations().some((name) => !migrationsBefore.has(name))

    /* ---------------------------------------------------------------------
     * 内部实现（端点与 wiki-service **共用**，单一真源）
     * 下面四个函数是全部业务语义所在；HTTP 处理器只负责参数解析/状态码翻译，
     * 服务方法只负责入参校验后转发——两条路径因此不可能行为漂移。
     * ------------------------------------------------------------------- */

    /**
     * 页面摘要列表（按 updated_at 倒序；version = 历史快照数 + 1）。
     *
     * **次级键 `p.id DESC` 不是装饰，是正确性要求**：`updated_at` 是秒级 ISO 字符串，
     * 批量导入/脚本创建时极易出现完全相同的时间戳，此时单键排序的结果**取决于查询计划**。
     * 实测（同一份并列数据）：
     *   - 无索引（`SCAN pages` + 临时 B 树）→ `alpha,beta,gamma,delta,epsilon`
     *   - 加上 `(updated_at DESC, id DESC)` 索引（`SCAN pages USING INDEX …`）→ **完全反转**
     * 即"看起来稳定"的顺序会在加索引那一刻悄悄翻转——分页/侧边栏会因此漏项或重项。
     * 显式 tiebreaker 让顺序由 SQL 决定，而非由计划决定。
     */
    const listPages = (): WikiPageSummary[] =>
      db
        .query<PageRow>(
          `SELECT p.id, p.slug, p.title, p.created_at, p.updated_at,
                  (SELECT COUNT(*) FROM page_versions v WHERE v.page_id = p.id) AS version_count
             FROM pages p ORDER BY p.updated_at DESC, p.id DESC`,
        )
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          updated_at: r.updated_at,
          version: Number((r as unknown as { version_count: number }).version_count) + 1,
        }))

    /** 页面详情（正文 + 最近 recentLimit 条版本历史）；slug 不存在返回 undefined */
    const getPage = (slug: string): WikiPageDetail | undefined => {
      const page = db.query<PageRow>('SELECT * FROM pages WHERE slug = ?', [slug])[0]
      if (!page) return undefined
      const versions = db.query<{ id: number; saved_at: string }>(
        `SELECT id, saved_at FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT ?`,
        [page.id, recentLimit],
      )
      const totalVersions = (
        db.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])[0] as unknown as { n: number }
      ).n
      return {
        slug: page.slug,
        title: page.title,
        content: page.content,
        created_at: page.created_at,
        updated_at: page.updated_at,
        version: totalVersions + 1,
        versions: versions.map((v) => ({ id: v.id, saved_at: v.saved_at })),
      }
    }

    /* ---------------- 反向链接索引（page_links 的读写） ---------------- */

    /**
     * 重建某页的出链（**必须在调用方的事务内调用**，故本函数自身不开事务）。
     *
     * 语义是"重建"而非"追加"：先删该页全部出行，再按当前正文重插。
     * 这样删掉正文里的链接后，旧边会被一并清掉——若只追加，反向链接会永远累积陈旧边。
     */
    const rebuildLinks = (slug: string, content: string): void => {
      db.run('DELETE FROM page_links WHERE source_slug = ?', [slug])
      for (const target of extractLinkTargets(content, isValidSlug)) {
        db.run('INSERT INTO page_links (source_slug, target_slug) VALUES (?, ?)', [slug, target])
      }
    }

    /** 页面是否存在（比 getPage 轻：不取正文、不取版本历史） */
    const pageExists = (slug: string): boolean =>
      db.query<{ slug: string }>('SELECT slug FROM pages WHERE slug = ?', [slug]).length > 0

    /**
     * 引用了 `slug` 的页面（反向链接）。
     *
     * 用 `JOIN pages` 取标题，于是**指向不存在页面的行不会出现**（不可能有标题）。
     * 排序 `title, slug`：标题做主序便于阅读，`slug` 是不能省的次级键——
     * 同名页面（或中文标题的同一码点序）下顺序才不会由查询计划决定。
     */
    const listBacklinks = (slug: string): WikiBacklink[] =>
      db.query<WikiBacklink>(
        `SELECT p.slug AS slug, p.title AS title
           FROM page_links l JOIN pages p ON p.slug = l.source_slug
          WHERE l.target_slug = ? ORDER BY p.title, p.slug`,
        [slug],
      )

    /** 该页正文指向的目标；`LEFT JOIN` 让"尚未创建的目标"也返回（title 为 null） */
    const listOutlinks = (slug: string): WikiOutlink[] =>
      db.query<WikiOutlink>(
        `SELECT l.target_slug AS slug, p.title AS title
           FROM page_links l LEFT JOIN pages p ON p.slug = l.target_slug
          WHERE l.source_slug = ? ORDER BY l.target_slug`,
        [slug],
      )

    /** 老库升级时一次性回填（恰好一次；理由见上面迁移段落） */
    const backfillLinks = (): void => {
      const rows = db.query<{ slug: string; content: string }>('SELECT slug, content FROM pages')
      db.transaction(() => {
        db.run('DELETE FROM page_links')
        for (const r of rows) rebuildLinks(r.slug, r.content)
      })
      console.log(`[@geewiki/wiki] 反向链接已回填: ${rows.length} 个页面`)
    }
    if (justAppliedMigration) backfillLinks()

    /**
     * upsert：保存前把旧正文快照进 page_versions（版本即历史）。
     * 幂等：标题与正文均未变化时既不更新 updated_at、也不写历史。
     * 入参须已由 normalizeSaveFields 校验（服务与端点都走该校验）。
     */
    const savePage = (slug: string, input: WikiSaveInput): WikiSaveResult => {
      const now = new Date().toISOString()
      const outcome = db.transaction((): 'created' | 'updated' | 'unchanged' => {
        const existing = db.query<PageRow>('SELECT id, title, content FROM pages WHERE slug = ?', [slug])[0]
        if (!existing) {
          db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
            slug,
            input.title,
            input.content,
            now,
            now,
          ])
          rebuildLinks(slug, input.content)
          return 'created'
        }
        // 幂等保存：标题与正文均未变化 → 不更新 updated_at、不写历史
        if (existing.title === input.title && existing.content === input.content) return 'unchanged'
        // 快照旧正文到版本历史，再更新页面
        db.run('INSERT INTO page_versions (page_id, content, saved_at) VALUES (?, ?, ?)', [
          existing.id,
          existing.content,
          now,
        ])
        db.run('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
          input.title,
          input.content,
          now,
          existing.id,
        ])
        // 出链随正文重建（同一事务内，故正文与索引不会不一致）
        rebuildLinks(slug, input.content)
        return 'updated'
      })
      const version =
        (db.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = ?',
          [slug],
        )[0] as unknown as { n: number }).n + 1
      return { outcome, version }
    }

    /**
     * 删除页面及其版本历史；返回是否确实删除（版本历史此处显式删除以防实现差异）。
     *
     * `page_links` **两侧都清**：该页作为源的出行（它自己没了）与作为目标的入行
     * （引用它的页面此时指向一个不存在的 slug，属悬挂边）。
     * 代价（刻意取舍，已登记）：若之后重建同名页面，原先指向它的反向链接不会自动回来，
     * 需引用方重新保存一次。选择"清两侧"是为了让索引与"页面存在"这一事实保持一致，
     * 不让索引里长期留有指向已删页面的边。
     */
    const deletePage = (slug: string): boolean =>
      db.transaction(() => {
        const page = db.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug])[0]
        if (!page) return false
        db.run('DELETE FROM page_versions WHERE page_id = ?', [page.id])
        db.run('DELETE FROM pages WHERE id = ?', [page.id])
        db.run('DELETE FROM page_links WHERE source_slug = ? OR target_slug = ?', [slug, slug])
        return true
      })

    /** 服务方法共用：卸载后任何仍持有 svc 引用的调用都应显式报错，而非返回空结果 */
    let disposed = false
    const assertLive = (): void => {
      if (disposed) {
        throw new Error('@geewiki/wiki: 插件已卸载，wiki-service 不可再调用（重新激活插件后再用）')
      }
    }

    /** 服务实例：契约见 {@link WikiService}（方法集与六个端点一一对应） */
    const svc: WikiService = {
      list: () => {
        assertLive()
        return listPages()
      },
      get: (slug) => {
        assertLive()
        return getPage(slug)
      },
      save: (slug, input) => {
        assertLive()
        assertValidSlug(slug)
        return savePage(slug, normalizeSaveFields(input?.title, input?.content))
      },
      remove: (slug) => {
        assertLive()
        assertValidSlug(slug)
        return deletePage(slug)
      },
      backlinks: (slug) => {
        assertLive()
        return pageExists(slug) ? listBacklinks(slug) : undefined
      },
      links: (slug) => {
        assertLive()
        return pageExists(slug) ? listOutlinks(slug) : undefined
      },
    }

    /* ---------- GET /api/pages：列表 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages', (h) => {
        h.json(200, { pages: listPages() })
      }),
    )

    /* ---------- GET /api/pages/:slug：详情 + 最近版本历史 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug', (h) => {
        // 路由段存在即为字符串；`?? ''` 仅为类型收窄（无匹配行 → 404，与既有行为一致）
        const page = getPage(h.params.slug ?? '')
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        h.json(200, page)
      }),
    )

    /* ---------- GET /api/pages/:slug/versions/:id：读取历史版本正文 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/versions/:id', (h) => {
        const page = db.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [h.params.slug])[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        const version = db.query<{ id: number; content: string; saved_at: string }>(
          'SELECT id, content, saved_at FROM page_versions WHERE id = ? AND page_id = ?',
          [Number(h.params.id), page.id],
        )[0]
        if (!version) {
          h.json(404, { ok: false, error: 'not_found', message: `版本不存在: ${h.params.id}` })
          return
        }
        h.json(200, { id: version.id, content: version.content, saved_at: version.saved_at })
      }),
    )

    /* ---------- PUT /api/pages/:slug：upsert（保存时先快照旧正文，幂等：内容未变不产生新历史） ---------- */
    cleanups.push(
      router.register('PUT', '/api/pages/:slug', async (h) => {
        const slug = h.params.slug ?? ''
        if (!isValidSlug(slug)) {
          h.json(400, {
            ok: false,
            error: 'invalid_slug',
            message: SLUG_HINT,
          })
          return
        }
        let save: WikiSaveInput
        try {
          save = parseSaveBody(await readBody(h))
        } catch (err) {
          const message = (err as Error).message
          if (message.startsWith('payload_too_large')) {
            // 请求体未读完且已暂停：经统一出口写出 413（计入 stats），随后关闭连接
            closeAfterResponse(h)
            h.json(413, { ok: false, error: 'payload_too_large', message })
            return
          }
          if (message.startsWith('content_too_large')) {
            // 正文过长与"请求体过大"是不同错误：按 error 分流的调用方不应混判
            h.json(413, { ok: false, error: 'content_too_large', message })
            return
          }
          h.json(400, { ok: false, error: 'invalid_body', message })
          return
        }
        const { outcome, version } = savePage(slug, save)
        h.json(200, { ok: true, slug, title: save.title, outcome, version })
      }),
    )

    /* ---------- DELETE /api/pages/:slug（版本历史依赖外键级联；此处显式事务删除以防实现差异） ---------- */
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug', (h) => {
        const slug = h.params.slug ?? ''
        if (!deletePage(slug)) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, deleted: slug })
      }),
    )

    /* ---------- GET /api/pages/:slug/backlinks：谁链接了本页 ---------- */
    /*
     * 响应信封用 `{ ok: true, slug, backlinks }`：本插件**较早**的读端点（列表/详情/版本）
     * 直接返回裸对象或 `{ pages }`，并没有 `ok`；但从"对外契约"的角度看，写端点
     * （PUT/DELETE）与全仓的 `{ ok:false, error, message }` 错误形状都以 `ok` 为准，
     * 新端点带上 `ok` 既与错误形状对称，也**纯属可加字段**——只读 `backlinks` 的调用方
     * 不受影响，故取兼容性更好的一侧。
     *
     * 页面不存在 → 404（而不是 200 空数组）：与 `GET /api/pages/:slug` 同一语义。
     * 否则"页面不存在"与"存在但没人链接"会被压成同一个响应，调用方无法区分，
     * 而这两种情况的界面处理明显不同（前者该显示"页面不存在"，后者该显示"暂无反向链接"）。
     */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/backlinks', (h) => {
        const slug = h.params.slug ?? ''
        if (!pageExists(slug)) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, slug, backlinks: listBacklinks(slug) })
      }),
    )

    /* ---------- GET /api/pages/:slug/links：本页指向了谁（出链） ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/links', (h) => {
        const slug = h.params.slug ?? ''
        if (!pageExists(slug)) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, slug, links: listOutlinks(slug) })
      }),
    )

    // 真正创建 cordis 服务：manifest 的 provides 只是依赖图 token，不会建服务。
    // 两者名字**必须一致**（'wiki-service'），否则消费方 ctx.get 拿到 undefined。
    const unprovide = ctx.provide('wiki-service', svc)

    console.log(
      '[@geewiki/wiki] 已激活: GET /api/pages, GET/PUT/DELETE /api/pages/:slug, ' +
        'GET /api/pages/:slug/{backlinks,links}, wiki-service 服务',
    )
    return () => {
      // 先立"已卸载"标志：此后任何仍持有 svc 引用的调用都会显式报错而非返回空结果
      disposed = true
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      unprovide()
      console.log('[@geewiki/wiki] 已卸载: REST 路由全部摘除，wiki-service 已注销')
    }
  },
}
