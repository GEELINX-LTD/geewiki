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
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  asAsync,
  auditIpHash,
  closeAfterResponse,
  DEFAULT_DATA_DIR,
  resolveProjectPath,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type DatabaseExecutor,
  type GeeWikiManifest,
  type HttpRouterService,
  type Principal,
  type RouteHandlerContext,
} from '@geewiki/core'
import { extractLinkTargets } from './links.js'
import {
  ATTACHMENT_EXT_WHITELIST,
  DEFAULT_MAX_BYTES,
  attachmentUrl,
  dispositionKindOf,
  effectiveMime,
  formatDisposition,
  normalizeExt,
  resolveAttachmentPath,
} from './attachments.js'
import { AttachmentStoreError, ensureAttachmentDirs, isUniqueViolation, storeStream } from './attachment-store.js'
import {
  BlockParseError,
  BlockSyncError,
  parseBlocks,
  projectPageContentFor,
  readExistingBlocks,
  sha256Hex,
  syncBlocksForPage,
  tierFor,
  type BlockKind,
  type BlockReader,
  type BlockTier,
  type BlockVisibility,
  type ParsedBlock,
  type PageLevel,
} from './blocks.js'

/**
 * `policy-service` 的**最小结构需求**（结构化类型，刻意不 import `@geewiki/authz`）。
 *
 * 与 plugin-org 对 `auth-service` 的处理同理：插件间依赖应当经**服务标识**表达
 * （manifest 的 `requires`），而不是钉死在某个包的模块上 —— 将来完全可能有另一种
 * 策略实现（例如把判定下沉到外部授权服务），只要它 `ctx.provide('policy-service', …)`
 * 就应当能接上。
 */
interface PolicyServiceLike {
  resolvePage(principal: Principal, slug: string): Promise<PageAccessLike>
  resolvePages(principal: Principal, slugs: readonly string[]): Promise<Map<string, PageAccessLike>>
  visibleSlugs(principal: Principal, q?: { prefix?: string; levels?: readonly string[] }): Promise<string[]>
  /**
   * 页面的**有效检索等级**（与主体无关）—— 块级索引 `blocks.tier` 的输入（§4.3）。
   *
   * **可选**：P3a 之前的策略实现没有这个方法。缺它时**按 `null` 处理**（失败关闭：
   * 该页的块不进等级索引 ⇒ 搜不到，而不是"按页面自身档位猜一个更宽的等级"）。
   * 后者才是危险的 —— 页面自身 `public` 但祖先把它收紧成 org 时，"猜"会**泄漏**。
   * 漏算由 `GET /api/admin/search/verify` 的 `tier IS NULL` 计数探针兜住。
   */
  effectiveIndexLevel?(
    slug: string,
    self?: { visibility: string; inherit: number | boolean; published_at: string | null },
  ): Promise<0 | 1 | null>
  /**
   * ★ P3b：该主体被**显式授予**的块 id 集合（`block_grants`）。
   *
   * **可选**：P3b 之前的策略实现没有这个方法。缺它时**按空集处理**（失败关闭：
   * 被授予的 `granted` 块对该主体不可见，而不是"猜一个更宽的可见性"）。
   * 后者才是危险的 —— `granted` 档存在的意义就是"默认谁都不能看"。
   *
   * 约定（与 `authz` 接口注释一致）：**只返回 id，绝不返回文本**；且必须已按
   * `expires_at` 过滤掉过期授予。匿名主体应返回空集。
   */
  grantedBlockIds?(principal: Principal): Promise<readonly number[]>
}

interface PageAccessLike {
  slug: string
  level: 'none' | 'summary' | 'full'
  canEdit: boolean
  canDelete: boolean
  canManageVisibility: boolean
  reason: string
  /** 载荷裁剪的唯一出口（见 policy-service 的实现说明） */
  project<T extends { content?: string }>(payload: T): T
}

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
  /** 单个附件的字节上限（默认 25MB） */
  attachmentMaxBytes?: number
  /** 单页附件总字节配额（默认 200MB） */
  attachmentPageQuotaBytes?: number
  /** 允许的附件扩展名（**只能收窄内置白名单**，不能放宽） */
  attachmentAllowedExt?: string[]
  /** 是否允许 SVG 内联展示（默认 false；同源内联 SVG 可执行脚本） */
  attachmentInlineSvg?: boolean
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
  /*
   * 附件四项（本批 M2）。**上界 200MB 是硬编码的**：单文件上限越大，"一个并发上传打满
   * 内存/磁盘"的代价越高，而这一层没有独立的限流设施 —— 所以把可用上限写死在
   * 插件里，而不是让配置随手调到几个 GB。
   */
  attachmentMaxBytes: Schema.number()
    .default(DEFAULT_MAX_BYTES)
    .min(1)
    .max(200 * 1024 * 1024)
    .description('单个附件的字节上限（默认 25MB，最大 200MB）'),
  attachmentPageQuotaBytes: Schema.number()
    .default(200 * 1024 * 1024)
    .min(1)
    .description('单个页面的附件总字节配额（默认 200MB）'),
  /*
   * ⚠️ 这个配置**只能收窄**内置白名单（apply 里取交集），不能放宽：
   * 放宽会让 `.html` 这类同源可执行内容进得来，而落盘路径的 `attachmentRelPath`
   * 断言仍然按内置白名单校验 ⇒ 要么静默失败、要么（更糟）被绕过。收窄方向永远安全。
   * **收窄只影响新的上传**：已收录附件的下载不查这个集合（否则一改配置，
   * 历史附件会集体变成 404 —— 那是把一次配置调整变成数据不可读）。
   */
  attachmentAllowedExt: Schema.array(Schema.string())
    .default([...ATTACHMENT_EXT_WHITELIST])
    .description('允许上传的附件扩展名（含前导点；只能收窄内置白名单，不能放宽）'),
  attachmentInlineSvg: Schema.boolean()
    .default(false)
    .description('是否允许 SVG 内联展示（默认关闭：同源内联 SVG 可执行脚本 = 存储型 XSS，除非另配 CSP）'),
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
  /**
   * 最近版本历史（条数受 config.recentVersions 限制，按 id 倒序）。
   *
   * ★ `author`（0019）：**做出这次改动的人**，不是"快照内容的作者"。
   * 快照存的是**改动前**的正文（`savePage` 的既有约定："先快照旧的，再改"），
   * 而 `saved_by` 与 `saved_at` 记的是同一次动作 ⇒ 把「什么时候 + 谁 + 这次改了哪几行」
   * 对齐成一条改动。落成一句话：**第 i 条快照的作者 = 把它覆盖掉的那个人**。
   *
   * `author: null` 的三种来源（读侧一律显示「未记录」，**不编造**）：
   *   1. 0019 之前写入的历史行（`saved_by` 列还不存在）；
   *   2. 经 `wiki-service.save()` 跨插件代调用、没有可归属主体的写入；
   *   3. 该用户已被删除 —— 0019 刻意**不加外键**（历史资产必须留存，见迁移注释），
   *      所以 id 可能指向一个查不到的账号，LEFT JOIN 会回 NULL。
   *
   * `title` 是**该快照当时的标题**。为什么标题也在 `content` 列旁边：`savePage` 允许
   * 只改标题（正文不变时走 `unchanged` 分支不写历史，但标题+正文同时改会写一条），
   * 时间线上要能看出"这次连标题一起改了" —— 只给正文的 diff 会漏掉这一半。
   */
  versions: {
    id: number
    saved_at: string
    title: string | null
    author: { id: number; displayName: string | null } | null
  }[]
  /**
   * ★ P2：当前主体对这条目的**能力**，供前端条件化渲染按钮。
   *
   * **前端隐藏只是体验，不是安全** —— 服务端在写路径上另有强制（§9 R10 反模式 5）。
   * 之所以要下发：否则界面会对每个访客都显示"编辑/删除"，点下去才 401/403，
   * 那是把权限做成了猜谜。
   */
  capabilities: { canEdit: boolean; canDelete: boolean; canManageVisibility: boolean }
  /**
   * ★ P2：可见性档位。**只在有管理权时下发** —— 它是"谁能看"的结构信息，
   * 普通读者不需要它，管理面板才需要回填。
   */
  visibility?: 'private' | 'org' | 'public'
  inherit?: boolean
  published?: boolean
}

export interface WikiSaveInput {
  title: string
  content: string
}

/**
 * 一次 `blocks.tier` 扇出重算的**结果**：把"没重算"与"重算失败"分开。
 *
 * 为什么需要这一层：`resynced === 0` 本身是**歧义**的 —— 它既可能是"该页没有子孙"
 * （完全正常），也可能是"扇出抛错、一个都没算"（**内容泄漏级**：祖先收紧没传导到
 * 子孙的 `tier`，于是读路径 404 而检索仍命中并吐出正文片段）。调用方拿到一个裸数字
 * 时无法区分这两者，而它们的处置完全不同。
 *
 * 单一真源：写入路径的响应（`WikiSaveResult.indexTiersResync`）、档位变更端点、
 * 以及 `POST /api/admin/blocks/resync` 的逐页结果都用这一个类型。
 */
export interface ResyncReport {
  /** 被重算的**块**数（0 且 `failed === false` = 该页没有子孙 / 没有块） */
  resynced: number
  /** 是否**整个扇出抛错**（true 时 `resynced` 必然为 0，且必须处置） */
  failed: boolean
  error?: string
}

export interface WikiSaveResult {
  outcome: 'created' | 'updated' | 'unchanged'
  version: number
  /**
   * 仅 `outcome === 'created'` 时可能出现：新建的页可能**成为已有页的祖先**（slug 前缀），
   * 于是那些子孙的有效档位被收紧，必须重算它们的 `blocks.tier`（否则检索仍按旧档位 ⇒
   * 读路径 404 而检索命中，属内容泄漏级）。
   */
  indexTiersResync?: ResyncReport
}

/**
 * `GET /api/pages/:slug/versions` 的查询行（内部类型，不下发）。
 *
 * 单独命名而不是内联在查询里：这条 SQL 要在**两个方言**上跑，行形状被三处消费
 * （分页、`change` 的对照行、响应映射），内联书写时改一处漏一处最容易漂移。
 */
interface VersionListRow {
  id: number
  /** `ROW_NUMBER() OVER (ORDER BY id DESC)`：1 = 最新快照。版本号由它反推 */
  rn: number
  saved_at: string
  title: string | null
  /** 0021：'content' | 'acl' | null（null = 0021 之前的行） */
  origin: string | null
  author_id: number | null
  author_name: string | null
  content: string
  blocks_json: string | null
  acl_json: string | null
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
  /**
   * `true`=目标存在且可见；`false`=目标不存在（红链，可创建）；
   * `'hidden'`=**存在但你看不到** —— 前端不得把它渲染成"不存在"，
   * 否则用户会去创建一个已存在的页面（脏数据 + 错误引导）。
   */
  exists?: boolean | 'hidden'
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
 *
 * **方法全部返回 Promise（自本批起）**：本插件同时支持同步适配器（better-sqlite3）与
 * 异步适配器（pg），后者本质上是异步的，故唯一的共同形态是异步。
 * 契约变更的代价为零：全仓 grep 确认**没有任何 `ctx.get('wiki-service')` 消费者**
 * （只有提及它的注释），故不存在需要同步迁移的调用方。
 */
export interface WikiService {
  /*
   * ★ P2：**所有读方法都显式要求 `principal`**（设计文档 §9 R2）。
   *
   * 本服务是 cordis 全局单例，不持有请求上下文。若把主体做成可选参数，
   * 任何"忘了传"的调用点都会静默退化成"不过滤"—— 那是把一次编码疏忽变成全量泄漏。
   * 加必填参数让它在**编译期**就炸，而不是在运行时悄悄放行。
   */
  /** 页面摘要列表（按 updated_at 倒序，与端点同序）；只含该主体可见的条目 */
  list(principal: Principal): Promise<WikiPageSummary[]>
  /** 页面详情；**不存在或无权**均返回 `undefined`（对应端点 404，不泄露存在性） */
  get(slug: string, principal: Principal): Promise<WikiPageDetail | undefined>
  /** 新建或更新（幂等 upsert）：标题与正文均未变化时 outcome='unchanged' 且不写历史 */
  save(slug: string, input: WikiSaveInput): Promise<WikiSaveResult>
  /** 删除页面及其全部版本历史；返回是否确实删除（false 对应端点 404） */
  remove(slug: string): Promise<boolean>
  /** 引用了该页的页面（按标题、slug 稳定排序）；页面不存在时返回 `undefined`（对应端点 404）。已按主体可见性过滤 */
  backlinks(slug: string, principal: Principal): Promise<WikiBacklink[] | undefined>
  /** 该页正文指向的目标；`undefined` 对应 404。不可见的目标带 `exists:'hidden'`，**不得**当作"不存在" */
  links(slug: string, principal: Principal): Promise<WikiOutlink[] | undefined>
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
    // `policy-service` 是 P2 引入的**读路径依赖**：本插件在提供任何内容之前必须
    // 先问它"这个主体能不能看这条"。声明它同时也保证了激活顺序（策略层先就绪）。
    requires: ['http-service', 'database-provider', 'policy-service'],
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

/**
 * ★ P3a：把某页正文投影成**该主体可见的样子**（受限块替换为显式占位）。
 *
 * 实现已**上移**到 `./blocks.js` 的 `projectPageContentFor`（本批 M3）：
 * 附件下载端点必须复用**同一条判据**判断"这份附件是否出现在该主体看得见的正文里"，
 * 而两份实现必然漂移 —— 漂移的表现是"正文里看不到、附件却能下载"，且不会报错。
 */

interface PageRow {
  id: number
  slug: string
  title: string
  content: string
  created_at: string
  updated_at: string
  /*
   * ★ P2 的可见性列（`0012_page_acl.sql`）。声明为可选：`getPage` 里有一条
   * `SELECT id, title, content FROM pages` 的窄查询（只取判定所需的最小列），
   * 用它构造的行**没有**这几列 —— 标成必填会让那条查询的返回值类型说谎。
   * 用到它们的地方（详情响应）走的是 `SELECT *`。
   */
  visibility?: string
  inherit?: number | boolean
  published_at?: string | null
}

/**
 * 附件元数据行（`attachments` 表，本批 M2）。
 *
 * **磁盘上只有字节，这张表才是真源**：`sha256` + `ext` 一起决定落盘路径
 * （`resolveAttachmentPath`），`byte_size`/`mime`/`original_name` 只用于响应头与展示。
 * 下载路径因此**先查这张表、再拼路径**，而不是"拿 URL 里的东西去拼文件路径"。
 */
interface AttachmentRow {
  id: number
  page_id: number
  sha256: string
  ext: string
  byte_size: number
  mime: string
  original_name: string
  uploader_id: number | null
  /** 联查 `pages` 得到的**当前** slug（判定用现值；`attachments.page_slug` 只是审计冗余列） */
  live_slug: string
  /** 联查 `pages` 得到的正文 —— 块级投影的输入 */
  page_content: string
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
 * 版本快照的**来源**（`page_versions.origin`，0021）。
 *
 * 存在的意义只有一个：让用户能分清"**正文**被改了"与"**只动了权限**"。
 * 两者都会产生快照，但读者关心的事情完全不同 —— 所以它必须是**受控枚举**：
 * 让调用方随手写字符串，就等于把这个区分交给每个调用点的自觉。
 *
 * - `content`：这次动作**改了正文**（保存、恢复历史版本）
 * - `acl`：正文没动，只动了档位/发布/授权（以及随正文保存而变的块级可见性）
 */
export const VERSION_ORIGINS = ['content', 'acl'] as const
export type VersionOrigin = (typeof VERSION_ORIGINS)[number]

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

  /**
   * 异步 apply：本插件要支持异步适配器（pg），而 `db.migrate()`/`appliedMigrations()`
   * 在异步形态下是 Promise，故激活过程必须可等待。
   *
   * `packages/manager/src/index.ts` 的 `await this.ctx.plugin(...)` 会等激活完成
   * （含 async apply），失败经 `_error` 抛出；`@geewiki/postgres` 已是同一模式。
   */
  async apply(ctx: Context, config: WikiConfig = {}) {
    const db = ctx.get('db') as AnyDatabaseAdapter | undefined
    if (!db) throw new Error('@geewiki/wiki: 数据库服务不可用（@geewiki/db-sqlite 未激活）')
    /*
     * **两种驱动，一条代码路径**：`asAsync` 把同步适配器（better-sqlite3）提升为异步门面，
     * 异步适配器则原样返回。于是本文件不再需要任何 `isAsyncAdapter` 分支——
     * 那正是上一版"异步下拒绝启动"守卫的替代品。
     *
     * ⚠️ 事务回调**必须使用传入的 `tx`**，不能用外层的 `adb`：异步适配器背后是连接池，
     * `pool.query()` 会把语句分派到任意空闲连接上，导致 `BEGIN` 与后续语句不在同一条连接，
     * **事务静默失效**（不报错但回滚不了）。`rebuildLinks` 因此把 `tx` 作为首参。
     */
    const adb = asAsync(db)
    /*
     * `blocks_fts` 只在 SQLite 下存在（FTS5 是 SQLite 专有对象，见设计文档 §4.3 ★v7）。
     *
     * ★ 判据必须在这里**按方言**得出，而不是在写块时靠捕获异常去试。实测过的教训：
     * PG 的错误文案是 `relation "blocks_fts" does not exist`（不是 SQLite 的
     * `no such table:`），只匹配后者会让错误被抛出 ⇒ **每一次写块都失败、`blocks` 恒为
     * 0 条、整个块模型在 PG 上不可用**；而就算把两种文案都匹配上也不行 —— PG 的事务
     * 一旦报错就进入 aborted 状态，后续语句一律失败，"捕获后继续"在那条路上不成立。
     */
    const blocksIndexSupported = db.dialect === 'sqlite'
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
    const migrationsBefore = new Set(await adb.appliedMigrations())
    await adb.migrate(WIKI_MIGRATIONS_DIR)
    const justAppliedMigration = (await adb.appliedMigrations()).some(
      (name) => !migrationsBefore.has(name),
    )

    /* ---------------------------------------------------------------------
     * 内部实现（端点与 wiki-service **共用**，单一真源）
     * 下面四个函数是全部业务语义所在；HTTP 处理器只负责参数解析/状态码翻译，
     * 服务方法只负责入参校验后转发——两条路径因此不可能行为漂移。
     * ------------------------------------------------------------------- */

    /* ------------------------- 附件存储（本批 M1/M2） ------------------------- */

    /**
     * 附件的**数据根**与临时目录。
     *
     * ⚠️ 名字先把话说死（此处曾被误读，进而以为临时目录落在 `data/attachments/tmp`）：
     * `attachmentDataRoot` 是**数据根 `<data>` 本身**，**不是** `attachments/`。附件的最终
     * 路径要在它之下再加一层 `attachments/`（见 `resolveAttachmentPath`），即
     * `<data>/attachments/<sha 前 2>/<sha 3-4>/<sha><ext>`。
     *
     * 环境变量优先（`GEEWIKI_DATA_DIR`，与 docker-compose 的卷挂载约定一致），默认 `./data`
     * —— 与 `@geewiki/db-sqlite` 取数据库路径时**逐字同款**的写法。相对路径经
     * `resolveProjectPath` 以**仓库根**为基准解析：否则从不同 cwd 启动（`pnpm dev` /
     * 子目录内 `node`）会落到不同的附件目录，表现为"刚上传的图刷新就 404"。
     */
    const attachmentDataRoot = resolveProjectPath(
      process.env.GEEWIKI_DATA_DIR ?? DEFAULT_DATA_DIR,
      import.meta.url,
    )
    /**
     * 临时目录**刻意放在 `attachments/` 之外**：`join(<data>, 'tmp')` ⇒ **`<data>/tmp`**
     * （默认部署即 `<仓库根>/data/tmp`）—— 注意**不是** `<data>/attachments/tmp`：
     *
     * 1. 内容寻址目录里因此**只可能出现完整的最终文件** —— 没有半截文件的中间态，
     *    运维核对"磁盘上有哪些附件"时看到的集合就是数据库里的集合；
     * 2. 临时文件与最终路径仍在同一文件系统（同一个数据根）⇒ `rename` 是原子的，
     *    不会退化成跨设备拷贝。
     *
     * 已核对（决策依据）：全仓**没有**别的东西在用 `<data>/tmp` ——
     * 在 `packages/` 各包的 `src/` 下搜 `'tmp'` 只命中本处，故这里不是"与他人共用的目录"，
     * 也就不存在"挪走会撞车"的问题；而它本来就已经在 `attachments/` 之外，
     * 无须再挪一次。e2e 的 `tmp_count()`（`packages/plugin-wiki/test/e2e-attachments.sh:161`）
     * 断言的正是 `$TMP/data/tmp`，是这条口径的实测证据。
     */
    const attachmentTmpDir = join(attachmentDataRoot, 'tmp')
    /** 单文件字节上限与单页配额（`Schema.number()` 已保证是正整数） */
    const attachmentMaxBytes = config.attachmentMaxBytes ?? DEFAULT_MAX_BYTES
    const attachmentPageQuotaBytes = config.attachmentPageQuotaBytes ?? 200 * 1024 * 1024
    /**
     * 生效的扩展名白名单 = **内置白名单 ∩ 配置**（只收窄、不放宽，理由见配置项注释）。
     * 空集是合法的（等于关掉上传），故不在这里兜底成内置白名单。
     */
    const attachmentAllowedExt: ReadonlySet<string> = new Set(
      (config.attachmentAllowedExt ?? ATTACHMENT_EXT_WHITELIST)
        .map((e) => e.toLowerCase())
        .filter((e) => ATTACHMENT_EXT_WHITELIST.includes(e)),
    )
    const attachmentInlineSvg = config.attachmentInlineSvg === true

    /**
     * 激活期探针：**建一次目录**，把"附件目录不可写"这件事在启动时就暴露出来。
     *
     * 但**失败只告警、不阻止激活**：只读挂载 / 权限没配好的场景下，若在这里抛错，
     * 整个 wiki 插件（含页面读写）会一起起不来 —— 那是把"附件用不了"升级成"整站用不了"。
     * 正文与版本历史与附件目录毫无关系，它们没有理由陪葬。
     */
    void ensureAttachmentDirs(attachmentDataRoot, attachmentTmpDir).catch((err: unknown) => {
      console.warn(
        `[@geewiki/wiki] 附件目录不可用（${attachmentDataRoot}）：上传将返回 503 storage_unavailable。` +
          '页面与版本历史不受影响。原因:',
        err,
      )
    })

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
    /**
     * 策略服务（P2）。**逐请求活查询**，不做构造期快照 —— `@geewiki/authz` 在本插件
     * 之后才激活，构造期拿到的一定是 undefined（与 server 侧 `credentialSourceProbe`
     * 是同一类注册顺序陷阱）。
     *
     * **拿不到就抛错，绝不降级放行**（设计文档 §9 R2 铁律）：策略层缺失时若"不过滤"，
     * 等于把一次插件装配事故变成一个静默的全量泄漏。宁可让读操作 500。
     */
    /**
     * 主体守卫。路由层已保证 `h.principal` 存在（`judgeAccess` 对每个非 public 端点
     * 都要求非匿名），但**读端点保持 public** —— 匿名访客拿到的就是 `anonymousPrincipal`。
     * 这里仍显式判空：`Principal` 的缺位绝不允许被解释成"那就不过滤"。
     */
    const requirePrincipal = (h: RouteHandlerContext): Principal => {
      const p = h.principal
      if (!p || typeof p.kind !== 'string') {
        throw new Error('@geewiki/wiki: 请求缺少 Principal —— 拒绝提供内容（失败关闭）')
      }
      return p
    }

    const policy = (): PolicyServiceLike => {
      const svc = ctx.get('policy-service') as PolicyServiceLike | undefined
      if (!svc) {
        throw new Error(
          '@geewiki/wiki: policy-service 不可用 —— 拒绝提供内容（绝不因策略层缺失而放行，见设计文档 §9 R2）',
        )
      }
      return svc
    }

    /**
     * ★ P3b：该主体被显式授予的**块 id 集合**（读路径与检索共用的唯一入口）。
     *
     * **失败关闭，方向与 `pageLevelOf` 一致**：策略层没实现该方法、或它抛错 ⇒ **空集**。
     * 空集的后果是"被授予的 `granted` 块对该主体也不可见"（**少给**），
     * 而绝不是"所有块都可见"（**多给**）。前者是可用性问题，后者是泄漏 ——
     * 两害相权，只能取前者。
     */
    const grantedBlockIdsOf = async (p: Principal): Promise<readonly number[]> => {
      try {
        const svc = policy()
        if (typeof svc.grantedBlockIds !== 'function') return []
        return await svc.grantedBlockIds(p)
      } catch {
        return []
      }
    }

    /**
     * 页面的**有效检索等级** —— `blocks.tier` 的输入（§4.3）。
     *
     * **失败关闭**：策略层不可用、没实现该方法、或它抛错 ⇒ 一律 `null`。
     * `null` 写进 `blocks.tier` 的后果是"该块不被等级分支命中"（搜不到），
     * 而不是"按页面自身档位猜一个更宽的等级" —— 后者在"页面自身 public 但祖先把它
     * 收紧成 org" 时会**泄漏**。漏算由 `/api/admin/search/verify` 的
     * `tier IS NULL` 计数探针报警。
     *
     * `self` 只用于**新建**条目：那一行还在本事务里没提交，而策略层走另一条连接
     * （PG 下看不到），不传就会被误判成"页面不存在"。更新分支不需要它 ——
     * `savePage` 只改 title/content/updated_at，不碰任何可见性列。
     */
    const pageLevelOf = async (
      slug: string,
      self?: { visibility: string; inherit: number | boolean; published_at: string | null },
    ): Promise<PageLevel> => {
      const svc = ctx.get('policy-service') as PolicyServiceLike | undefined
      if (!svc?.effectiveIndexLevel) {
        console.warn(
          '[@geewiki/wiki] policy-service 未提供 effectiveIndexLevel —— 该页的块按 tier=NULL 写入' +
            '（不进等级索引 = 搜不到；失败关闭方向，由 /api/admin/search/verify 报警）',
        )
        return null
      }
      try {
        return await svc.effectiveIndexLevel(slug, self)
      } catch (err) {
        console.warn('[@geewiki/wiki] effectiveIndexLevel 调用失败，按 null（失败关闭）处理:', err)
        return null
      }
    }

    const listPages = async (principal: Principal): Promise<WikiPageSummary[]> => {
      // 先拿"这个主体看得见的集合"，再用它过滤 —— 过滤发生在**服务端**，
      // 且复用策略层的唯一出口（不自己写第二套可见性规则）
      const visible = new Set(await policy().visibleSlugs(principal))
      return (
        await adb.query<PageRow & { version_count: number | string | null }>(
          /*
            版本数一次算完，不再逐行跑相关子查询。
            原先是 `(SELECT COUNT(*) FROM page_versions v WHERE v.page_id = p.id)`：
            页数一多就是 N 次针对 page_versions 的独立扫描（PG 下每次还是一个独立子计划），
            而"可见性过滤"只能发生在 JS 侧（见上方注释，DB 层拿不到"可见的第 N 页"），
            所以这里**不做服务端分页**，只把 N 次扫描降到 1 次。
            `LEFT JOIN`（不是 INNER）保证"一次都没存过版本的页面"仍然出现在结果里 ——
            此时计数是 NULL，下面按 0 处理，语义与旧的子查询一致（COUNT 恒为 0 而不会是 NULL）。
          */
          `SELECT p.id, p.slug, p.title, p.created_at, p.updated_at, v.n AS version_count
             FROM pages p
             LEFT JOIN (SELECT page_id, COUNT(*) AS n FROM page_versions GROUP BY page_id) v
                    ON v.page_id = p.id
            ORDER BY p.updated_at DESC, p.id DESC`,
        )
      )
        .filter((r) => visible.has(r.slug))
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          updated_at: r.updated_at,
          /*
            **必须 Number() 强转**（与 getPage 的详情端点同一条理由，见那里的注释）：
            `COUNT(*)` 是 bigint，`pg` 为免精度丢失把它作为**字符串**返回，而 better-sqlite3
            返回数字。少了这层强转，PG 下 `+ 1` 会变成字符串拼接（"0" + 1 → "01"），
            version 悄悄从数字变字符串 —— 只在 PG 这一种驱动下发生，只跑 SQLite 的测试看不到。
            `?? 0` 兜住 LEFT JOIN 未命中时的 NULL。
          */
          version: Number(r.version_count ?? 0) + 1,
        }))
    }

    /** 页面详情（正文 + 最近 recentLimit 条版本历史）；不存在**或无权**一律返回 undefined */
    const getPage = async (slug: string, principal: Principal): Promise<WikiPageDetail | undefined> => {
      /*
       * **判定先于取数**：`level='none'` 直接返回 undefined，调用方翻译成 404。
       *
       * 为什么"不存在"与"无权"返回同一个值：区分开就等于提供了一个
       * "这个 slug 存不存在"的探测接口（设计文档 §2.3 明确要求匿名一律 404）。
       * 已登录用户的 403 语义在**写路径**与显式的拒绝页上表达，不在详情读路径。
       */
      const access = await policy().resolvePage(principal, slug)
      if (access.level === 'none') return undefined
      const page = (await adb.query<PageRow>('SELECT * FROM pages WHERE slug = ?', [slug]))[0]
      if (!page) return undefined
      /*
       * ★ P3a：**正文必须按读者等级投影后才能进响应体**（§2.4 约束 1、§5）。
       *
       * 位置很关键：在 `resolvePage` 判定之后、**在构造详情对象之前**。放到构造之后再
       * "想办法删掉"正是最容易漏的形式 —— 那时原文已经进了对象，任何一条提前 return
       * 都会把它带出去。
       */
      const projectedContent = await projectPageContentFor(adb, {
        pageId: page.id,
        content: page.content,
        principal,
        /*
         * ★ P3b：授权集合与**投影**必须来自同一次策略调用 —— 否则会出现"判定用了
         * 这份授权、渲染用了另一份"的窗口（缓存与并发下尤其明显，而且这种不一致
         * 恰好会以"某次请求多显示一段"的形式出现，最难复现）。
         */
        grantedBlockIds: await grantedBlockIdsOf(principal),
      })
      /*
       * 版本列表连同**作者**一起取（0019）。
       *
       * `LEFT JOIN users` 而不是 `INNER JOIN`：作者可能是 NULL（0019 之前的历史行、
       * 跨插件代调用、或账号已被删除 —— 后者是刻意的，见迁移注释"历史资产必须留存"），
       * `INNER JOIN` 会把这些行**整条丢掉**，表现为"历史少了几条"这种最难察觉的错误。
       *
       * 取 `display_name` 而不是 `email`：版本时间线是给同事看的协作信息，
       * 邮箱属于身份信息，没有必要为了显示"谁改的"而扩大它的暴露面。
       */
      const versions = await adb.query<{
        id: number
        saved_at: string
        title: string | null
        author_id: number | null
        author_name: string | null
      }>(
        `SELECT v.id, v.saved_at, v.title, v.saved_by AS author_id, u.display_name AS author_name
           FROM page_versions v
           LEFT JOIN users u ON u.id = v.saved_by
          WHERE v.page_id = ? ORDER BY v.id DESC LIMIT ?`,
        [page.id, recentLimit],
      )
      const totalVersions = (
        await adb.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])
      )[0] as unknown as { n: number }
      /*
       * ★ **载荷裁剪的唯一出口**（设计文档 §2.4 约束 1）：详情对象在这里过一遍
       * `access.project(...)`，`level !== 'full'` 时正文根本不会进入响应
       * —— 这不是"前端隐藏"，而是服务端序列化之前就不存在。
       *
       * `versions` 一并裁掉：历史列表暴露的是"这条改过几次、什么时候改的"，
       * 对只该看到占位的主体属于多余的结构信息；正文历史另有独立端点且要求编辑权。
       */
      const detail: WikiPageDetail = {
        slug: page.slug,
        title: page.title,
        // ★ P3a：**投影后的**正文，不是 `page.content`。受限块在这里已经被替换成占位，
        // 原文从未进入这个对象 ⇒ 也就不可能出现在任何响应分支里。
        content: projectedContent.text,
        created_at: page.created_at,
        updated_at: page.updated_at,
        // **必须 Number() 强转**：`pg` 把 `COUNT(*)`（bigint）作为**字符串**返回以避免精度丢失，
        // 而 better-sqlite3 返回数字。直接 `+ 1` 在 PG 下会变成字符串拼接（"0"+1 → "01"），
        // 响应里的 version 就成了字符串——契约悄悄变化，且只在 PG 这一种驱动下发生。
        version: Number(totalVersions.n) + 1,
        versions: versions.map((v) => ({
          id: v.id,
          saved_at: v.saved_at,
          title: v.title ?? null,
          /*
           * `author` 只在**两列都拿得到**时给对象：`saved_by` 有值但 `users` 查不到
           * （账号已删，0019 刻意不加外键）时返回 `null` 而不是 `{ id, displayName: null }`
           * —— 后者会让界面渲染出"某人（名字缺失）"这种半截信息，不如统一按「未记录」。
           */
          author:
            v.author_id === null || v.author_id === undefined || v.author_name === null
              ? null
              : { id: Number(v.author_id), displayName: v.author_name },
        })),
        capabilities: {
          canEdit: access.canEdit,
          canDelete: access.canDelete,
          canManageVisibility: access.canManageVisibility,
        },
        // 档位只在有管理权时下发（见接口注释）：普通读者不需要，管理面板才要回填
        ...(access.canManageVisibility
          ? {
              visibility: page.visibility as 'private' | 'org' | 'public',
              inherit: page.inherit === 1 || page.inherit === true,
              published: page.published_at !== null,
            }
          : {}),
      }
      const projected = access.project(detail)
      if (projected === detail) return detail
      return { ...projected, versions: [] }
    }

    /* ---------------- 反向链接索引（page_links 的读写） ---------------- */

    /**
     * 重建某页的出链（**必须在调用方的事务内调用**，故本函数自身不开事务）。
     *
     * 语义是"重建"而非"追加"：先删该页全部出行，再按当前正文重插。
     * 这样删掉正文里的链接后，旧边会被一并清掉——若只追加，反向链接会永远累积陈旧边。
     *
     * **首参是 `tx` 而不是闭包里的 `adb`**：事务内所有语句必须走同一条连接，
     * 用适配器自身的方法在连接池下会落到别的连接上，事务静默失效（见 apply 顶部注释）。
     */
    const rebuildLinks = async (tx: DatabaseExecutor, slug: string, content: string): Promise<void> => {
      await tx.run('DELETE FROM page_links WHERE source_slug = ?', [slug])
      for (const target of extractLinkTargets(content, isValidSlug)) {
        await tx.run('INSERT INTO page_links (source_slug, target_slug) VALUES (?, ?)', [slug, target])
      }
    }

    /** 页面是否存在（比 getPage 轻：不取正文、不取版本历史） */
    const pageExists = async (slug: string): Promise<boolean> =>
      (await adb.query<{ slug: string }>('SELECT slug FROM pages WHERE slug = ?', [slug])).length > 0

    /**
     * ★ P4：记录一次**越权尝试**（`access.denied`）。这是它的**唯一出口**。
     *
     * **只在"页面存在、但对该主体不可见"时调用**。这条判据不能省 —— 对外两条路径都返回
     * 404（§2.3 要求匿名一律 404、不泄露存在性），但在**服务端内部**两者分得清：
     * 「请求了不存在的页」只是普通 404，「请求了存在但无权看的页」才是越权尝试。
     * 把前者也记进来只会把有用信号淹没在噪声里。
     *
     * **为什么要与权限变更分开**（§8.2 P4 第 4 条）：`access.denied` 是**安全事件**（要告警），
     * `acl.change` 之类是**合规记录**（要留存）。两类混在一个视图里，"有人在探测权限边界"
     * 会被"某人改了可见性"稀释掉。它们在 `GET /api/admin/audit` 里分属不同 `view`。
     *
     * **记什么**：slug（排障时可直接复现，且与其它 `target_kind='page'` 的审计行同口径）、
     * 主体种类、原因码、IP 哈希（只存哈希，不留原文）。
     * **不记什么**：请求体、正文、查询串 —— 与 `before/after` 不含正文的红线一致。
     */
    const recordAccessDenied = (
      h: RouteHandlerContext,
      slug: string,
      reason: string,
      p: Principal,
    ): void => {
      void writeAuditLog(adb, {
        action: 'access.denied',
        targetKind: 'page',
        targetId: slug,
        actorId: p.userId ?? null,
        actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
        after: { reason, principalKind: p.kind },
      }).catch((e: unknown) => console.error('[@geewiki/wiki] 越权尝试的审计写入失败:', e))
    }

    /**
     * 引用了 `slug` 的页面（反向链接）。
     *
     * 用 `JOIN pages` 取标题，于是**指向不存在页面的行不会出现**（不可能有标题）。
     * 排序 `title, slug`：标题做主序便于阅读，`slug` 是不能省的次级键——
     * 同名页面（或中文标题的同一码点序）下顺序才不会由查询计划决定。
     */
    const listBacklinks = async (slug: string, principal: Principal): Promise<WikiBacklink[]> => {
      /*
       * ★ **反链会泄露标题**（设计文档 §5.4）：引用方的 `title` 直接暴露了
       * "存在这样一条你看不到的条目"。所以结果必须按主体可见集合过滤 ——
       * 不可见的引用方**整条不出现**（不是"标题打码"：打码仍然确认了它的存在）。
       */
      const visible = new Set(await policy().visibleSlugs(principal))
      const rows = await adb.query<WikiBacklink>(
        `SELECT p.slug AS slug, p.title AS title
           FROM page_links l JOIN pages p ON p.slug = l.source_slug
          WHERE l.target_slug = ? ORDER BY p.title, p.slug`,
        [slug],
      )
      return rows.filter((r) => visible.has(r.slug))
    }

    /** 该页正文指向的目标；`LEFT JOIN` 让"尚未创建的目标"也返回（title 为 null） */
    const listOutlinks = async (slug: string, principal: Principal): Promise<WikiOutlink[]> => {
      /*
       * ★ **出链要区分三种"没有标题"**（设计文档 §5.5）：目标不存在（红链，可创建）、
       * 目标存在但你看不到（`hidden`，不能渲染成"不存在"——否则用户会去创建一个
       * 已存在的页面，产生脏数据与错误引导）。
       */
      const visible = new Set(await policy().visibleSlugs(principal))
      /*
       * ★ 必须区分**三种**"没有标题"，而不是两种：
       *   - 目标存在且可见      → 正常返回 title，`exists: true`
       *   - 目标存在但你看不到  → `exists: 'hidden'`（**存在性本身也不该暴露**：
       *                          传 `slug` 是必要的，否则前端连"这是个链接"都不知道；
       *                          但标题与正文一律不给）
       *   - 目标根本不存在      → `exists: false`（红链，前端可以引导创建）
       *
       * 判据必须是"**存在性**"而不是"可见性"：只拿可见集合去判，会把"不存在"误标成
       * `'hidden'`，于是前端永远不敢让用户创建新页面（红链功能整条失效）。
       */
      const existing = new Set(
        (await adb.query<{ slug: string }>('SELECT slug FROM pages')).map((r) => r.slug),
      )
      const rows = await adb.query<WikiOutlink>(
        `SELECT l.target_slug AS slug, p.title AS title
           FROM page_links l LEFT JOIN pages p ON p.slug = l.target_slug
          WHERE l.source_slug = ? ORDER BY l.target_slug`,
        [slug],
      )
      const mayKnowExistence = principal.kind === 'user'
      return rows.map((r) => {
        if (visible.has(r.slug)) return { ...r, exists: true as const }
        /*
         * ★ 匿名主体一律报 `false`（= "不存在"）：`'hidden'`（存在但你看不到）与
         * `false`（根本不存在）的**区别本身就是存在性信息**。设计文档要求"匿名访问受限
         * 资源一律 404、不泄露存在性"（§2.3），所以对匿名必须把两者压成同一个值。
         * 已登录用户（`kind='user'`）已知组织存在这些条目，`'hidden'` 不额外泄露，
         * 而它换来的"灰锁链接"体验正是 §5.5 想要的三步态。
         */
        if (mayKnowExistence && existing.has(r.slug)) {
          return { slug: r.slug, title: null, exists: 'hidden' as const }
        }
        return { slug: r.slug, title: null, exists: false as const }
      })
    }

    /** 老库升级时一次性回填（恰好一次；理由见上面迁移段落） */
    const backfillLinks = async (): Promise<void> => {
      const rows = await adb.query<{ slug: string; content: string }>('SELECT slug, content FROM pages')
      await adb.transaction(async (tx) => {
        await tx.run('DELETE FROM page_links')
        for (const r of rows) await rebuildLinks(tx, r.slug, r.content)
      })
      console.log(`[@geewiki/wiki] 反向链接已回填: ${rows.length} 个页面`)
    }
    if (justAppliedMigration) await backfillLinks()

    /**
     * ★ P3a：**存量 `pages.content` → `blocks` 回填**。
     *
     * ## 为什么必须做
     *
     * `blocks` 是**解析产物**：P3a 之前保存的页面只有 `pages.content`，没有块行。
     * 不回填的后果有两条，都不是"体验差一点"而是**功能失效**：
     *   1. **检索搜不到存量内容** —— `blocks_fts` 只索引块，而 `pages_fts` 已废弃；
     *   2. **块级遮蔽对存量内容不生效** —— 详情路径在没有块行时会现场解析（那是最低限度的
     *      兜底），但检索、AI 两条路都以 `blocks` 为准。
     *
     * ## 触发条件为什么是"扫描没有块的行"，而不是"迁移刚应用过"
     *
     * `justAppliedMigration` 只覆盖"这一次激活恰好跑了迁移"这一个窗口。而回填没跑成的
     * 可能有多种：迁移由别的进程跑掉、上一次激活中途失败、页面由导入脚本或第三方插件插入。
     * 判据落在**数据现状**（`NOT EXISTS (SELECT 1 FROM blocks …)`）上，上述情况全部覆盖，
     * 且天然幂等 —— 已回填过的页面不会被重复处理。
     *
     * ## 分批 + 失败不阻断
     *
     * 启动路径上的大规模写会拖长激活、甚至卡死大库，故**分批**（每批一个事务）。
     * 失败一律**尽力而为**：告警后返回，不阻断激活 —— 块随时可以从 `pages.content` 重建，
     * 而"插件激活不了"会让整个 wiki 不可用，两者代价不对等。
     */
    const backfillBlocks = async (): Promise<void> => {
      const BATCH = 200
      let done = 0
      let skipped = 0
      /*
       * ★ keyset 游标（`p.id > ?`）是**必须的**，不是优化。
       *
       * 查询条件是"还没有 blocks 行的页面"。一旦某页被跳过（下面 try/catch 的分支），
       * 它下次仍然满足该条件 ⇒ 若没有游标，下一轮会把**同一页**再选出来 ⇒
       * **在本轮激活里无限循环**。带上游标后，无论成功还是跳过，循环都严格向前推进；
       * 跳过的页面留给**下一次启动**再试（判据仍是数据现状，天然幂等）。
       */
      let cursor = 0
      try {
        for (;;) {
          const rows = await adb.query<{ id: number; slug: string; content: string }>(
            `SELECT p.id, p.slug, p.content FROM pages p
              WHERE p.id > ? AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = p.id)
              ORDER BY p.id LIMIT ?`,
            [cursor, BATCH],
          )
          if (rows.length === 0) break
          for (const r of rows) {
            cursor = r.id
            /*
             * ★ 单条失败**只跳过这一条**。
             *
             * 本函数的注释一直写着"逐条一个事务：单条失败不影响同批其它条目"，但当初
             * try/catch 在循环**外面** ⇒ 一个页面失败就中止整轮。代价不只是"少回填几条"：
             * 失败的那页**仍然没有 blocks 行** ⇒ 下次启动再次被选中、再次失败，
             * **它之后的所有存量页面永远回填不到**（块级遮蔽与检索对这些页面整体失效）。
             *
             * 最典型的触发源是**遗留正文里的旧标记**（`<!--gated:role=editor-->`）——
             * `parseBlocks` 会显式拒绝它（那是刻意的，不是 bug），于是它成了"合法的新写入
             * 拒了、非法的旧内容卡住回填"这个组合。内容问题该由作者改，不该阻塞其余页面。
             */
            try {
              const now = new Date().toISOString()
              const pageLevel = await pageLevelOf(r.slug)
              await adb.transaction(async (tx) => {
                await syncBlocksForPage(tx, {
                  pageId: r.id,
                  content: r.content,
                  pageLevel,
                  now,
                  /*
                   * 回填的选中条件就是"这一页**还没有任何块行**"（`NOT EXISTS (SELECT 1
                   * FROM blocks …)`），故已有块必然是空的 —— 传 `[]` 是**由判据保证**的，
                   * 不是"图省事省略"。
                   */
                  existing: [],
                  syncIndex: blocksIndexSupported,
                })
                // `content_hash` 由调用方一并维护（syncBlocksForPage 只管块与索引）——
                // 它是一致性探针 `/api/admin/blocks/verify` 的比对基准，不回填会让存量页面恒报不一致
                await tx.run('UPDATE pages SET content_hash = ? WHERE id = ?', [sha256Hex(r.content), r.id])
              })
              done += 1
            } catch (err) {
              skipped += 1
              if (skipped <= 5) {
                console.warn(
                  `[@geewiki/wiki] 存量块回填跳过一页（${r.slug}）—— 该页正文无法解析或写入失败；` +
                    '`/api/admin/blocks/verify` 会把这类页面作为 unparseable 报出。原因:',
                  err instanceof Error ? err.message : err,
                )
              }
            }
          }
          if (rows.length < BATCH) break
        }
        if (done > 0) console.log(`[@geewiki/wiki] 存量条目已回填块: ${done} 条`)
        if (skipped > 0) {
          console.warn(
            `[@geewiki/wiki] 存量块回填跳过 ${skipped} 页（正文含已废弃标记或写入失败）—— ` +
              '这些页面的块级遮蔽与检索暂不生效，修正正文后重启即可补齐',
          )
        }
      } catch (err) {
        console.warn(
          `[@geewiki/wiki] 存量条目的块回填失败（已回填 ${done} 条后中断）—— 不回填只影响存量内容的` +
            '检索与块级遮蔽，不影响新写入；重启可续（判据是"还没有块的行"，天然幂等）。原因:',
          err,
        )
      }
    }
    // 无条件跑：没有待回填的行时那条查询是空的，代价可忽略；有则必须补上（见上方理由）
    await backfillBlocks()

    /**
     * upsert：保存前把旧正文快照进 page_versions（版本即历史）。
     * 幂等：标题与正文均未变化时既不更新 updated_at、也不写历史。
     * 入参须已由 normalizeSaveFields 校验（服务与端点都走该校验）。
     */
    const savePage = async (
      slug: string,
      input: WikiSaveInput,
      /**
       * 本次改动的触发者（`Principal.userId`）。
       *
       * **为什么是可选参数而不是必填**：`savePage` 同时被 HTTP 端点与
       * `wiki-service.save()` 调用，后者是**跨插件契约**、可以在没有 HTTP 主体的
       * 场合被其它插件调用（例如导入脚本）。这类调用没有可归属的用户，写 `NULL`
       * 比编一个假 id 诚实；界面据 `null` 显示「未知」而不是「某个人」。
       */
      actorId?: number | null,
    ): Promise<WikiSaveResult> => {
      const now = new Date().toISOString()
      const outcome = await adb.transaction(async (tx): Promise<'created' | 'updated' | 'unchanged'> => {
        const existing = (await tx.query<PageRow>('SELECT id, title, content FROM pages WHERE slug = ?', [slug]))[0]
        if (!existing) {
          /*
           * ★ **两层默认值的应用层那一半**（设计文档 §3.3 v5 说明 / D8）：
           * `pages.visibility` 的 DDL 默认值是 `'private'`（失败关闭，守"没人管的写入路径"），
           * 而**经产品新建的条目一律显式写 `'org'`**（组织内可见）—— 这是本产品的常态。
           * 若这里图省事省略该列，新建的页面会默认为私有，与用户预期相反；
           * 而若把 DDL 默认改成 'org'，则导入脚本/第三方插件的插入路径会意外公开内容。
           */
          const ins = await tx.run(
            /*
             * ★ `RETURNING id` 不是可选的：SQLite 有隐式 rowid，**PostgreSQL 没有** ——
             * PG 下不写 `RETURNING id` 时 `lastInsertRowid` 恒为 0，于是紧接着写块会用
             * `page_id = 0` 撞外键，**每一个新建页面的请求都 500**（实测）。
             * 见 `packages/db-postgres/src/index.ts:237-238`。
             */
            `INSERT INTO pages (slug, title, content, created_at, updated_at, visibility, inherit, acl_revision, content_hash)
             VALUES (?, ?, ?, ?, ?, 'org', 1, 0, ?) RETURNING id`,
            [slug, input.title, input.content, now, now, sha256Hex(input.content)],
          )
          const pageId = Number(ins.lastInsertRowid)
          /*
           * ★ P3a：块与块索引的**唯一写入路径**（§9 R12），与 pages 行**同事务**。
           *
           * `self` 是必需的：这一行还在本事务里没提交，而策略层走另一条连接读 pages
           * （PG 下看不到未提交的行），不传就会被误判成"页面不存在" ⇒ tier 全是 NULL。
           * 传进去的正是刚写下的那一行的可见性三列。
           */
          const level = await pageLevelOf(slug, {
            visibility: 'org',
            inherit: 1,
            published_at: null,
          })
          await syncBlocksForPage(tx as unknown as Parameters<typeof syncBlocksForPage>[0], {
            pageId,
            content: input.content,
            pageLevel: level,
            now,
            /*
             * 新建分支：这一行刚插进去，库里不可能有它的块。
             * 传 `[]` 而不是省略 —— `existing` 是**必填**参数，正是为了让"没考虑
             * 已有块"这件事在编译期就暴露，而不是运行期静默走删光重建（丢授权）。
             */
            existing: [],
            syncIndex: blocksIndexSupported,
          })
          await rebuildLinks(tx, slug, input.content)
          return 'created'
        }
        // 幂等保存：标题与正文均未变化 → 不更新 updated_at、不写历史
        if (existing.title === input.title && existing.content === input.content) return 'unchanged'
        /*
         * 快照旧正文到版本历史，再更新页面。
         *
         * ★ P3c：**连同权限一起快照**（块集合 + 页面级 ACL + 授予）。理由：本次保存
         * 也可能改变**块级可见性**（正文里的 `<!--gated:…-->` 标记一改，块的 visibility
         * 就变），所以只存正文的话，「恢复此版本」会把当时的正文配上现在的权限 ——
         * 可能放宽。快照取的是**此刻**（更新之前）的块，正是"变更前状态"。
         */
        const snap = await versionSnapshotOf(tx, existing.id)
        /*
         * `saved_by`（0019）：记的是**这次保存的触发者**，与 `saved_at` 同一时刻 ——
         * 而快照内容存的是"改动前"的正文，两者在时间上并不指同一次动作。
         * 这个组合正是读侧要的：把「什么时候 + 谁 + 这次改了哪几行」对齐成一条改动。
         *
         * `title`（0019）：存**改动前**的标题（`existing.title`，与 `existing.content`
         * 同一时刻的取值）—— 时间线上"只改了标题"的那一次才不会显示成"正文未变"。
         *
         * `origin`（0021）恒为 `'content'`：这条 INSERT 只出现在 `savePage` 里，而
         * `savePage` 的幂等分支（标题与正文都没变 ⇒ 直接 return `'unchanged'`）保证
         * 走得到这里时**确实有内容被改**。所以来源不需要由调用方传参 —— 多一个
         * 可以由调用方写错的参数，不如让它在唯一的写入点上是个常量。
         */
        await tx.run(
          `INSERT INTO page_versions (page_id, content, saved_at, blocks_json, acl_json, saved_by, title, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'content')`,
          [existing.id, existing.content, now, snap.blocksJson, snap.aclJson, actorId ?? null, existing.title],
        )
        await tx.run('UPDATE pages SET title = ?, content = ?, updated_at = ?, content_hash = ? WHERE id = ?', [
          input.title,
          input.content,
          now,
          sha256Hex(input.content),
          existing.id,
        ])
        /*
         * ★ P3a：块与块索引随正文重建（**同一事务**，故正文/块/索引三者不会不一致）。
         * 本分支不传 `self`：可见性三列没被改，库里已提交的那一行就是准确的。
         */
        await syncBlocksForPage(tx as unknown as Parameters<typeof syncBlocksForPage>[0], {
          pageId: existing.id,
          content: input.content,
          pageLevel: await pageLevelOf(slug),
          now,
          /*
           * ★ P3b：**必须读已有块**（含每块的授权计数），否则保守重解析无从谈起，
           * 只能退化成"删光重建"⇒ `block_grants` 被外键 CASCADE 静默清空。
           * 走 `tx` 而不是 `adb`：同一事务、同一连接，读到的就是这次保存将要改的那一份。
           */
          existing: await readExistingBlocks(tx as unknown as BlockReader, existing.id),
          syncIndex: blocksIndexSupported,
        })
        // 出链随正文重建（同一事务内，故正文与索引不会不一致）
        await rebuildLinks(tx, slug, input.content)
        return 'updated'
      })
      const version =
        (
          await adb.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = ?',
            [slug],
          )
        )[0] as unknown as { n: number }
      /*
       * ★ 新建的页可能**成为已有页的祖先**（slug 前缀）⇒ 那些子孙的有效档位被收紧，
       * 而它们的 `blocks.tier` 是物化值、不会自己变。不重算就是**内容泄漏级**：
       * 读路径已经 404（判定按前缀实时算），检索却仍按旧 tier 命中并吐出正文片段。
       *
       * 实测复现（审查给出）：建 `a/b`（public + published）→ 匿名读 200、匿名搜 total=1；
       * 再 `PUT /api/pages/a`（默认 org）→ 匿名读 `a/b` 404，但匿名 `/api/search` 仍
       * `total:1` 且响应体里出现该页的唯一词。
       *
       * **为什么只能在提交之后**：`pageLevelOf` 走策略层（另一条连接读 `pages`），
       * PG 的 MVCC 下它看不到本事务未提交的插入 ⇒ 在事务内算会漏掉刚建的这个祖先，
       * 等于没修。
       */
      const indexTiersResync =
        outcome === 'created' ? await resyncDescendantsReporting(slug) : undefined
      // 同上：PG 的 COUNT(*) 是字符串，必须强转（否则 "1"+1 → "11"）
      const versionNo = Number(version.n) + 1
      /*
       * ⚠️ **键要条件构造**，不能写成 `{ outcome, version, indexTiersResync }` ——
       * 后者在非 `created` 时会留下一个"存在但值为 `undefined`"的自有属性，
       * 而 `assert.deepEqual` 与 `deepStrictEqual` **都会**把这个键算作差异
       * （表现是 expected/actual 打印出来一模一样却断言失败，极难看出原因）。
       */
      return indexTiersResync === undefined
        ? { outcome, version: versionNo }
        : { outcome, version: versionNo, indexTiersResync }
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
    /*
     * ★ 删除同样要扇出，而且是**两条**独立的理由：
     *
     * 1. 被删页可能是别人的祖先 ⇒ 那些子孙的有效档位可能**变宽**（少了本页的收紧）。
     * 2. 更阴的一条：被删页可能是**断链点**（`inherit = 0`）。策略层的 `effectiveRank`
     *    对"祖先不存在"是 `continue`、对"`inherit !== 1`"才是 `break` —— 于是删掉断链点后，
     *    更上层**更严**的祖先会重新开始压制，子孙的 rank 反而**变窄**。
     *    这个 `continue`/`break` 的不对称是刻意的（缺失祖先不压制、断链才截断），
     *    要修的是"档位变了要重算 tier"这条链，不是那个语义。
     *
     * 实测复现（审查给出）：`a`=private(inherit=1)、`a/b`=public+published+**inherit=0**、
     * `a/b/c`=public+published ⇒ 匿名读 `c` 200、搜得到；`DELETE /api/pages/a%2Fb` 后
     * ⇒ 匿名读 `a/b/c` **404**，但匿名搜仍 `total:1`、唯一词出现在响应体里。
     *
     * 同样必须在**提交之后**跑：策略层读的是另一条连接，PG 下看不到未提交的删除。
     */
    /**
     * 删除页面（连同版本历史与出链）。
     *
     * 返回**被删条目的摘要**而不是布尔值：删除是本插件里唯一"数据真的没了"的动作
     * （版本历史随外键级联清空，不可恢复），所以审计必须留下**删掉的是什么** ——
     * 只记一个 slug 的话，事后无法回答"当时删掉的那篇讲了什么、有多少历史"。
     * 摘要必须在 `DELETE` **之前**取（删完就查不到了）。
     */
    const deletePage = async (
      slug: string,
    ): Promise<
      | false
      | { title: string; versions: number; bytes: number; createdAt: string; contentHash: string | null }
    > => {
      const deleted = await adb.transaction(async (tx) => {
        const page = (
          await tx.query<{
            id: number
            title: string
            created_at: string
            content_hash: string | null
            bytes: number
          }>(
            `SELECT id, title, created_at, content_hash, LENGTH(content) AS bytes FROM pages WHERE slug = ?`,
            [slug],
          )
        )[0]
        if (!page) return false
        // 摘要与删除同事务取出：事后（甚至并发删除后）再查就会拿到 null 或别人的数据
        const versionCount = (
          await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])
        )[0] as unknown as { n: number }
        const summary = {
          title: page.title,
          // `Number()`：PG 把 COUNT(*) 当字符串回（与 getPage 同款理由）
          versions: Number(versionCount.n),
          bytes: Number(page.bytes),
          createdAt: page.created_at,
          contentHash: page.content_hash,
        }
        await tx.run('DELETE FROM page_versions WHERE page_id = ?', [page.id])
        /*
         * ★ P3a：`blocks_fts` **必须手工清** —— `blocks` 行会被下面的 FK CASCADE 带走，
         * 但 contentless FTS 表**没有触发器**（tier 重算不是纯 SQL 能表达的，见
         * 0002_blocks_fts.sql 的说明）⇒ 不清就会留下孤儿索引行。
         * 检索查询会 JOIN `blocks`，所以孤儿行不会产出命中，但会**留着正文文本**，
         * 并让 `/api/admin/search/verify` 的 `extra` 计数非零。先删索引再删页。
         */
        /*
         * ⚠️ **必须受方言守卫**：`blocks_fts` 由 `@geewiki/search` 的迁移建立，是
         * **FTS5 / SQLite 专有**表 —— PG 上它根本不存在。不加 `blocksIndexSupported`
         * 就会直接抛 `relation "blocks_fts" does not exist`，而 PG 的事务一旦报错即进入
         * aborted 状态、后续语句一律失败 ⇒ **在 PostgreSQL 上删除任何页面都返回 500，
         * 且页面删不掉**（事务整体回滚）。
         *
         * 这个缺陷是新增的「阶段 L」方言中立断言抓到的（`deletePage` 此前从未在 PG 上被
         * 端到端跑到过）—— 正是"块模型的 PG 可用性不由类型系统保证，必须有真方言 e2e 兜底"
         * 的又一例。`blocks.ts` 那边靠调用方传 `syncIndex: blocksIndexSupported` 已经是
         * 安全的，只有这里漏了。
         */
        if (blocksIndexSupported) {
          await tx.run('DELETE FROM blocks_fts WHERE rowid IN (SELECT id FROM blocks WHERE page_id = ?)', [page.id])
        }
        await tx.run('DELETE FROM pages WHERE id = ?', [page.id])
        await tx.run('DELETE FROM page_links WHERE source_slug = ? OR target_slug = ?', [slug, slug])
        return summary
      })
      if (deleted) await resyncDescendantsReporting(slug)
      return deleted
    }

    /** 服务方法共用：卸载后任何仍持有 svc 引用的调用都应显式报错，而非返回空结果 */
    let disposed = false
    const assertLive = (): void => {
      if (disposed) {
        throw new Error('@geewiki/wiki: 插件已卸载，wiki-service 不可再调用（重新激活插件后再用）')
      }
    }

    /** 服务实例：契约见 {@link WikiService}（方法集与六个端点一一对应） */
    const svc: WikiService = {
      list: async (principal) => {
        assertLive()
        return listPages(principal)
      },
      get: async (slug, principal) => {
        assertLive()
        return getPage(slug, principal)
      },
      save: async (slug, input) => {
        assertLive()
        assertValidSlug(slug)
        return savePage(slug, normalizeSaveFields(input?.title, input?.content))
      },
      remove: async (slug) => {
        assertLive()
        assertValidSlug(slug)
        /*
         * 服务契约声明的是 `Promise<boolean>`（跨插件调用方只关心"删没删掉"），
         * 而内部实现返回的是被删条目的摘要（审计要用）⇒ 在这一层收敛成布尔值。
         * 不要为了少写这一个转换去改 `WikiService` 的公开契约。
         */
        return (await deletePage(slug)) !== false
      },
      backlinks: async (slug, principal) => {
        assertLive()
        return (await pageExists(slug)) ? listBacklinks(slug, principal) : undefined
      },
      links: async (slug, principal) => {
        assertLive()
        return (await pageExists(slug)) ? listOutlinks(slug, principal) : undefined
      },
    }

    /* ---------- GET /api/pages：列表 ---------- */
    /*
     * 端点处理器一律 **async**：这些是**短请求**，返回 Promise 是正确且更好的——
     * `packages/server/src/index.ts` 的 `dispatch()` 只在 `isThenable(result)` 为真时才把
     * `exitHandler` 挂到结算上，故 async 处理器会被**正确计入在途请求**，排空会等它们。
     *
     * ⚠️ 反例：**SSE / 长连接处理器必须同步返回非 thenable**，否则会被永久计为在途，
     * 让排空空转到超时并打印假的"排空超时"告警。已核实**本插件没有 SSE 端点**
     * （全是请求-响应式的 JSON 端点），故此处不存在该风险。
     */
    cleanups.push(
      router.register('GET', '/api/pages', async (h) => {
        h.json(200, { pages: await listPages(requirePrincipal(h)) })
      }),
    )

    /* ---------- GET /api/pages/:slug：详情 + 最近版本历史 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug', async (h) => {
        // 路由段存在即为字符串；`?? ''` 仅为类型收窄（无匹配行 → 404，与既有行为一致）
        const slug = h.params.slug ?? ''
        const p = requirePrincipal(h)
        const page = await getPage(slug, p)
        if (!page) {
          /*
           * ★ P4：对外仍是 404（不泄露存在性），但**内部区分**两种情形 ——
           * 只有"页存在但无权看"才是越权尝试，才记 `access.denied`。
           * 记录失败不影响响应：审计是旁路，不能让它的故障把 404 变成 500。
           */
          if (await pageExists(slug)) recordAccessDenied(h, slug, 'no_read_access', p)
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, page)
      }),
    )

    /*
     * ---------- GET /api/pages/:slug/versions：完整版本列表（分页，带作者） ----------
     *
     * 为什么需要它：详情接口里的 `versions` 只给最近 `recentVersions`（默认 10）条且
     * **没有分页**，所以"把版本号做成可下拉选择"这件事在后端本来没有对应能力 ——
     * 用户看不到第 11 个版本以前的东西，界面也就无从列出。
     *
     * 权限：与单版本快照端点**同口径**（要求 `canEdit`）。历史列表暴露的是"这条改过
     * 几次、什么时候、谁改的、改了多大"，对只读者属于多余的结构信息 —— 与详情接口
     * 裁掉 `versions` 的既有决定一致。
     *
     * **不下发正文**：一页可能有上百个版本，正文全带上会是几 MB。正文仍走
     * `GET /api/pages/:slug/versions/:id` 按需取；这里只给"改动"的元数据：
     * 时间、作者、篇幅（`bytes`/`lines`）—— 够界面算出"这次改了多少"。
     */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/versions', async (h) => {
        const slug = h.params.slug ?? ''
        const page = (await adb.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        const access = page ? await policy().resolvePage(requirePrincipal(h), slug) : null
        if (!page || !access || !access.canEdit) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        /*
         * 查询串里的整数参数：**非法值显式 400**，不静默取默认 ——
         * `limit=abc` 被当成默认值会表现为"问了却没结果"，正是最难定位的症状
         * （与 `/api/search` 的 `invalid_limit` 同一纪律）。
         */
        const limitRaw = h.url.searchParams.get('limit')
        let limit = VERSIONS_PAGE_DEFAULT
        if (limitRaw !== null && limitRaw !== '') {
          const parsed = Number(limitRaw)
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > VERSIONS_PAGE_MAX) {
            h.json(400, {
              ok: false,
              error: 'invalid_limit',
              message: `limit 须为 1..${VERSIONS_PAGE_MAX} 的整数`,
            })
            return
          }
          limit = parsed
        }
        /*
         * ★ **游标分页**（`before=<id>`），不是 OFFSET。
         *
         * 为什么：`OFFSET` 在"翻页期间有人又保存了一次"时会**跳条或重复** —— 新行插在
         * 列表头部，OFFSET=10 于是指向了另一条。版本列表恰恰是"越旧越稳定、越新越可能
         * 正在变"的数据，用 OFFSET 正好踩在这个失效模式上。游标以**具体的行 id** 为锚，
         * 翻到哪里都不会错位（`before` 语义：只取 id 严格更小的那些行 = 更旧的历史）。
         */
        const beforeRaw = h.url.searchParams.get('before')
        let before: number | null = null
        if (beforeRaw !== null && beforeRaw !== '') {
          const parsed = Number(beforeRaw)
          if (!Number.isInteger(parsed) || parsed < 1) {
            // 用 `invalid_cursor` 而不是 `invalid_offset`：参数名与语义都换了，
            // 错误码跟着换，调用方才不会按旧语义去重试
            h.json(400, { ok: false, error: 'invalid_cursor', message: 'before 须为正整数（版本快照 id）' })
            return
          }
          before = parsed
        }
        /*
         * `LEFT JOIN users` 取作者显示名：`INNER JOIN` 会把作者不可归属的行整条丢掉
         * （0019 之前的历史行、跨插件代调用、账号已删）⇒ 表现为"历史少了几条"。
         */
        const viewer = requirePrincipal(h)
        const baseSelect = `SELECT v.id, v.saved_at, v.title, v.origin, v.saved_by AS author_id,
                     u.display_name AS author_name, v.content, v.blocks_json, v.acl_json,
                     ROW_NUMBER() OVER (ORDER BY v.id DESC) AS rn
                FROM page_versions v
                LEFT JOIN users u ON u.id = v.saved_by
               WHERE v.page_id = ?`
        /*
         * `ROW_NUMBER()` 算出**权威的版本号**：窗口函数在 SQLite 3.25+ 与 PostgreSQL
         * 8.0+ 都可用，两侧同形。不能靠 `total - i` 在应用层推 —— 那只在"从最新一页
         * 开始、且期间没有新写入"时成立；一旦用游标翻到中间，偏移量就无从得知了。
         *
         * ★ **游标条件按有无分两条 SQL，不要写成 `(? IS NULL OR id < ?)`**：
         *   PostgreSQL 在 `$2 IS NULL` 这种写法下**无法推断参数类型**，报
         *   `could not determine data type of parameter $2`（本仓库实测；SQLite 不报）。
         *   这是"同一份 SQL 跑两个方言"的典型陷阱：SQLite 全绿、PG 上整个端点 500。
         *   分开写还有个附带好处 —— 有游标时 PG 能用上 `page_id` 索引的顺序，
         *   而 `OR` 会让它退化成顺序扫描。
         */
        const rows =
          before === null
            ? await adb.query<VersionListRow>(`SELECT * FROM (${baseSelect}) ranked ORDER BY id DESC LIMIT ?`, [
                page.id,
                limit,
              ])
            : await adb.query<VersionListRow>(
                `SELECT * FROM (${baseSelect}) ranked WHERE id < ? ORDER BY id DESC LIMIT ?`,
                [page.id, before, limit],
              )
        /*
         * `change` 需要每条的**上一条**（更新时间更晚、id 更大那条）作对照 ——
         * 而它不一定落在同一页里：游标翻到第 3 页时，第一条的"上一条"在第 2 页。
         * 所以单独查一次"该条之后最近的 1 条"，逐条比对；页大小上限 200，最多 200 次
         * 索引点查（`idx_page_versions_page_id` 覆盖），代价可接受且换来语义正确。
         */
        const ids = rows.map((r) => Number(r.id))
        const newerOf = new Map<number, { content: string; blocks_json: string | null; acl_json: string | null }>()
        for (const id of ids) {
          const n = (
            await adb.query<{ content: string; blocks_json: string | null; acl_json: string | null }>(
              'SELECT content, blocks_json, acl_json FROM page_versions WHERE page_id = ? AND id > ? ORDER BY id ASC LIMIT 1',
              [page.id, id],
            )
          )[0]
          if (n) newerOf.set(id, n)
        }
        /*
         * `hasMore`：本页最后一条（= 最旧的那条）之后还有没有更旧的。
         * **不要**用"页长 == limit"去猜 —— 恰好整除时会误报"还有更多"，让界面显示出
         * 一个点了没反应的「加载更早」。这里直接问一次存在性。
         */
        const oldestId = ids.length === 0 ? null : Math.min(...ids)
        const hasMore =
          oldestId === null
            ? false
            : ((
                await adb.query<{ n: number }>(
                  'SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ? AND id < ?',
                  [page.id, oldestId],
                )
              )[0] as unknown as { n: number }).n > 0
        const totalRow = (
          await adb.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])
        )[0] as unknown as { n: number }
        // `Number()` 不可省：PG 把 COUNT(*)（bigint）当字符串回（与 getPage 同款理由）
        const total = Number(totalRow.n)
        /*
         * ★ 作者名只对**有权知道它**的人显示。
         *
         * 为什么不能一律回 `display_name`：`GET /api/org/members` 是
         * `{access:'admin'}` + 组织管理员闸门 —— 普通成员**本来无权枚举组织成员**。
         * 而在版本列表里回真名等于开了一条旁路：作者 id 是可枚举的整数，逐个翻页就
         * 能拼出成员名单。这与仓库既有的"置灰即泄露"立场冲突。
         *
         * 规则（三档）：
         *   1. 就是你自己 ⇒ 回你自己的名字（本来就知道）；
         *   2. 你是 owner/admin ⇒ 回真名（你本来就有成员目录的读取权）；
         *   3. 其余 ⇒ `displayName: null`，界面显示「另一位成员」。
         * `id` 一律照回：它是"同一人的多次改动"能聚在一起的最小信息，
         * 而单看一个不透明的整数并不能得到姓名。
         */
        const viewerIsAdmin = viewer.orgRole === 'owner' || viewer.orgRole === 'admin'
        h.json(200, {
          ok: true,
          slug,
          total,
          limit,
          hasMore,
          versions: rows.map((v) => {
            const id = Number(v.id)
            const newer = newerOf.get(id)
            return {
              id,
              /*
               * 权威版本号 = 窗口函数给的名次（1 = 最新那一条快照）。
               * `page.version = total + 1`（当前版本号），故快照名次 r 对应 `total + 1 - r`。
               * **不可能出现 0 或负值**：`rn` 由 `ROW_NUMBER()` 保证落在 `1..total`，
               * 而 `total + 1 - rn` 的最小值是 1（当 rn = total）。若真出现越界，
               * 说明 `page_versions` 与本页 `page_id` 的对应关系被破坏了 —— 那是数据事故，
               * 这里不做"兜底成 1"的掩盖（掩盖只会让事故更难被发现）。
               */
              number: total + 1 - Number(v.rn),
              saved_at: v.saved_at,
              title: v.title ?? null,
              // 0021：'content'（正文/标题被改）| 'acl'（只动了权限）| null（升级前的行）
              origin: v.origin ?? null,
              author:
                v.author_id === null || v.author_id === undefined
                  ? null
                  : {
                      id: Number(v.author_id),
                      displayName:
                        viewerIsAdmin || Number(v.author_id) === viewer.userId ? (v.author_name ?? null) : null,
                    },
              /*
               * 这一版**相对下一版**（更晚的那条快照）改了什么 —— 也就是说：把这条快照
               * 覆盖掉的那次编辑做了什么。最早的一版没有对照对象 ⇒ `null`（**不是**
               * "什么都没改"）。
               *
               * `blocksDelta`/`grantsDelta` 是**结构计数差**（块条数、授权条数），
               * 不是字节差：字节差会被一个字的改动放大成几百，读数没有意义。
               */
              change:
                newer === undefined
                  ? null
                  : {
                      /*
                       * **比正文本身**，不是比 `blocks_json`：块快照只在"块解析结果"层面
                       * 相等/不等，而"只改了标题"或"改了空格"这类改动不会体现在块里 ——
                       * 那会让界面把一次真实的正文编辑说成"正文未变"。
                       */
                      contentChanged: v.content !== newer.content,
                      blocksDelta: countBlocks(v.blocks_json) - countBlocks(newer.blocks_json),
                      grantsDelta: countGrants(v.acl_json) - countGrants(newer.acl_json),
                    },
            }
          }),
        })
      }, { access: 'user' }),
    )

    /*
     * ---------- GET /api/pages/:slug/versions/:id/diff：块级结构差异 ----------
     *
     * 回答"这一次改动动了哪些块"，**只给结构、绝不给正文**。
     *
     * ★★ **安全硬规则：响应体里不得出现块的文本**（不得有 `t` / `text` / `content` 字段）。
     *    理由：某一块可能是 `granted` 档、而调用者并未被授予 —— 若 diff 回文本，就等于
     *    让"能编辑本页的人"通过 diff 读到**他自己在正文里看不到的**那段内容。
     *    而"某一段被单独收紧过"这个**事实**不构成增量泄露：能走到这里的人本来就能读
     *    历史原文（`canEdit` 可读快照正文，v2 设计已裁决）。
     *    这条规则由 `packages/plugin-wiki/test/version-diff.test.ts` 的源码守卫钉死。
     *
     * ★ 语义：**与更旧的那一版比**（`id` 小于它且最大的那条）。
     *    快照存的是"改动前"的状态，所以这个差集回答的是：
     *    「这一版所代表的状态，相对上一版发生了什么」。
     *
     * ★ **为什么按 ordinal 归并，而不是复用 `blocks.ts` 的 `lcsPairs`**：
     *   `lcsPairs` 按 `(kind, contentHash)` 配对，对"文本一字未动、只把某块的可见性
     *   从 org 收到 granted"这种改动，两侧哈希相同 ⇒ 它根本不认为这是同一块，
     *   结果会显示成"删掉一块 + 新增一块"，而用户真正做的是**改了一档可见性**。
     *   本页的块由 `syncBlocksForPage` 维护、ordinal 在保守重解析下稳定（同一块保留
     *   原 ordinal），所以按 `o` 归并既更贴语义、复杂度也从 O(n·m) 降到 O(n)。
     *   两侧块数差异大（整段插入/删除）时，多出来的一侧自然落进 added/removed。
     */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/versions/:id/diff', async (h) => {
        const slug = h.params.slug ?? ''
        const page = (await adb.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        const access = page ? await policy().resolvePage(requirePrincipal(h), slug) : null
        if (!page || !access || !access.canEdit) {
          // 与其它版本端点同形：不区分"不存在/无权"，不引入新的探测面
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        const versionId = Number(h.params.id)
        if (!Number.isInteger(versionId) || versionId < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const current = (
          await adb.query<{ id: number; blocks_json: string | null }>(
            'SELECT id, blocks_json FROM page_versions WHERE id = ? AND page_id = ?',
            [versionId, page.id],
          )
        )[0]
        if (!current) {
          h.json(404, { ok: false, error: 'not_found', message: `版本不存在: ${h.params.id}` })
          return
        }
        const previous = (
          await adb.query<{ id: number; blocks_json: string | null }>(
            'SELECT id, blocks_json FROM page_versions WHERE page_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
            [page.id, versionId],
          )
        )[0]
        if (!previous) {
          /*
           * 最早的一版没有对照对象。用**独立的错误码**而不是空结果：空结果会被前端
           * 渲染成"这次什么都没改"，而事实是"无从比较" —— 两者对用户的意义完全不同。
           */
          h.json(404, {
            ok: false,
            error: 'no_previous',
            message: '这是最早的一版，没有更早的版本可比',
          })
          return
        }
        if (current.blocks_json === null || previous.blocks_json === null) {
          // 早于块级权限功能（0017）的快照没有块快照 —— 给不出块级差异，**不猜**
          h.json(409, {
            ok: false,
            error: 'snapshot_incomplete',
            message: '两侧之一缺少块快照（该版本早于块级权限功能），无法比较块级结构',
          })
          return
        }
        /*
         * 解析失败按"无法比较"处理（409）而不是回一个空的差异：回空差异等于告诉用户
         * "这次没改块"，而真实情况是我们读不懂那份快照 —— 那是编造。
         */
        const parseBlocks = (json: string): { o: number; k: string; v: string; t: string }[] | null => {
          try {
            const v: unknown = JSON.parse(json)
            return Array.isArray(v) ? (v as { o: number; k: string; v: string; t: string }[]) : null
          } catch {
            return null
          }
        }
        const curr = parseBlocks(current.blocks_json)
        const prev = parseBlocks(previous.blocks_json)
        if (curr === null || prev === null) {
          h.json(409, {
            ok: false,
            error: 'snapshot_incomplete',
            message: '块快照无法解析，不能给出可靠的块级差异',
          })
          return
        }
        const prevByOrdinal = new Map<number, { k: string; v: string; t: string }>()
        for (const b of prev) prevByOrdinal.set(Number(b.o), { k: String(b.k), v: String(b.v), t: String(b.t) })
        const added: { ordinal: number; kind: string; visibility: string }[] = []
        const removed: { ordinal: number; kind: string; visibility: string }[] = []
        const modified: {
          ordinal: number
          kind: string
          visibility: string
          changed: ('text' | 'visibility')[]
        }[] = []
        let unchangedCount = 0
        for (const b of curr) {
          const ord = Number(b.o)
          const old = prevByOrdinal.get(ord)
          // ★ 只取结构字段进响应；`t`（文本）**刻意不读进任何返回对象**
          const now = { ordinal: ord, kind: String(b.k), visibility: String(b.v) }
          if (old === undefined) {
            added.push(now)
            continue
          }
          prevByOrdinal.delete(ord)
          const changed: ('text' | 'visibility')[] = []
          if (old.t !== String(b.t)) changed.push('text')
          if (old.v !== String(b.v)) changed.push('visibility')
          if (changed.length === 0) unchangedCount++
          else modified.push({ ...now, changed })
        }
        for (const [ord, old] of prevByOrdinal) {
          removed.push({ ordinal: ord, kind: old.k, visibility: old.v })
        }
        /*
         * `from`/`to` 用**版本号**而不是行 id（与列表端点的 `number` 同口径）：
         * 用户看到的是「v3 → v4」，两个内部主键对他没有意义；而界面在别处已经拿到
         * 权威版本号，两处必须是同一套数字，否则会出现"列表说 v4、diff 说 17"。
         *
         * 版本号 = `total + 1 - rank`（rank 由 id DESC 的 ROW_NUMBER 给，1 = 最新快照），
         * 与 `GET /api/pages/:slug/versions` 完全同源 —— 这里再算一次而不是让调用方传，
         * 是因为 diff 也可能被直接调用（深链接、curl），不能依赖调用方先查列表。
         */
        const rankOf = async (id: number): Promise<number> => {
          const r = (
            await adb.query<{ n: number }>(
              'SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ? AND id >= ?',
              [page.id, id],
            )
          )[0] as unknown as { n: number }
          return Number(r.n)
        }
        const totalRow = (
          await adb.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', [page.id])
        )[0] as unknown as { n: number }
        const total = Number(totalRow.n)
        const toNumber = total + 1 - (await rankOf(Number(current.id)))
        const fromNumber = total + 1 - (await rankOf(Number(previous.id)))
        h.json(200, {
          ok: true,
          // 版本号（与列表端点的 `number` 同源）；行 id 另给 `comparedVersionId` 便于排障
          from: fromNumber,
          to: toNumber,
          comparedVersionId: Number(previous.id),
          added,
          removed,
          modified,
          unchangedCount,
        })
      }, { access: 'user' }),
    )

    /* ---------- GET /api/pages/:slug/versions/:id：读取历史版本快照 ---------- */
    /*
     * ★ P3c：**非 `canEdit` 一律 404**（不是 403、不是裁剪）。
     *
     * 为什么不是"投影历史"：历史行里含 `blocks_json` / `acl_json` —— 那是**权限结构本身**
     * （哪些块被单独收紧过、谁被授予过）。把它按当前主体裁剪等于把 ACL 结构暴露给
     * 本来读不到它的人；而"哪一段被刻意收紧过"本身就是敏感信息。
     * 所以历史**只对能编辑该页的人开放**，其他人一律 404（与"不存在"同形，不泄露存在性）。
     */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/versions/:id', async (h) => {
        const slug = h.params.slug ?? ''
        const page = (await adb.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        const access = page ? await policy().resolvePage(requirePrincipal(h), slug) : null
        if (!page || !access || !access.canEdit) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        const version = (
          await adb.query<{
            id: number
            content: string
            saved_at: string
            title: string | null
            blocks_json: string | null
            acl_json: string | null
          }>(
            'SELECT id, content, saved_at, title, blocks_json, acl_json FROM page_versions WHERE id = ? AND page_id = ?',
            [Number(h.params.id), page.id],
          )
        )[0]
        if (!version) {
          h.json(404, { ok: false, error: 'not_found', message: `版本不存在: ${h.params.id}` })
          return
        }
        h.json(200, {
          id: version.id,
          content: version.content,
          saved_at: version.saved_at,
          /*
           * 快照**当时**的标题（0019）。`null` = 0019 之前的行 ⇒ 调用方据此不下标题差异的
           * 结论（**不猜**"标题没变"）；对照"当前标题"由调用方自己取（它手上就有页面详情）。
           */
          title: version.title ?? null,
          // 老版本这两列为 NULL ⇒ 调用方据此提示"该版本早于块级权限功能"
          blocks: version.blocks_json === null ? null : (JSON.parse(version.blocks_json) as unknown),
          acl: version.acl_json === null ? null : (JSON.parse(version.acl_json) as unknown),
        })
      }),
    )

    /* ---------- POST /api/pages/:slug/versions/:id/restore：恢复某个版本（★ P3c） ---------- */
    /*
     * ★ **恢复是四位一体**：正文 + 块级权限 + 页面 `visibility` + `published_at` + `inherit`。
     * 只恢复正文会把"当时的正文"配上"现在的权限" —— 可能把本该受限的内容**放开**
     * （这正是 `0017_version_blocks.sql` 那条规则的由来）。
     *
     * ★ 恢复**本身也产生一条版本**（记变更前的状态）⇒ 恢复是可逆的：再恢复一次就能退回来。
     *
     * ★ 块的重建**走唯一写入路径** `syncBlocksForPage`，但经它的 `parse` 注入点喂入
     * **快照里的块**而不是重新解析正文。这样同时满足两件事：
     *   - R12（不得绕过写入路径，否则 `blocks_fts` 与 `blocks` 漂移）；
     *   - 忠实恢复"当时那组块"（解析器若在这期间升过级，重新解析会得到不同的块）。
     * 反过来，"删光重建"是**不可接受**的：`block_grants.block_id` 是 `ON DELETE CASCADE`，
     * 删光会让块 id 全变、**授权被静默清空**（见 `blocks.ts` 的说明）。
     */
    const MAX_SNAPSHOT_BYTES = 1_000_000

    /**
     * 版本列表（`GET /api/pages/:slug/versions`）的分页上限。
     *
     * `recentVersions`（默认 10）是**详情载荷**的裁剪量，不是分页量 —— 这条通路是为
     * "下拉选择版本"服务的另一件事。默认 50：多数页面一次列完；上限 200：每项只有
     * id/时间/作者/标题/字节数/行数，200 项也就十几 KB，不至于让响应体失控。
     */
    const VERSIONS_PAGE_DEFAULT = 50
    const VERSIONS_PAGE_MAX = 200

    /**
     * `blocks_json` 里有多少个块。
     *
     * 用途：版本列表的 `change.blocksDelta`（这一版相对下一版，块多了还是少了）。
     * **容错是刻意的**：这一列在老行上可以是 NULL、在极端情况下可能是坏 JSON ——
     * 而它只用于展示"改动有多大"，不该因为一条历史行格式异常就让整个版本列表 500。
     * 解析失败按 0 计（差异随之显示为 0），**不猜**成别的数字。
     */
    const countBlocks = (json: string | null): number => {
      if (json === null || json === '') return 0
      try {
        const v: unknown = JSON.parse(json)
        return Array.isArray(v) ? v.length : 0
      } catch {
        return 0
      }
    }

    /**
     * `acl_json` 里有几条**额外的**授权（页面级 grants + 块级 grants）。
     *
     * 只数"多出来的授权"而不数整份 ACL 的大小：`change.grantsDelta` 要回答的是
     * "这一次是不是给别人开了权限 / 收了权限"，而 `visibility`/`published_at` 这些
     * 字段的字符串长度变化与"授权条数"无关，混进来只会让读数变噪声。
     */
    const countGrants = (json: string | null): number => {
      if (json === null || json === '') return 0
      try {
        const v = JSON.parse(json) as { grants?: unknown; blockGrants?: unknown }
        const pageGrants = Array.isArray(v.grants) ? v.grants.length : 0
        const blockGrants = Array.isArray(v.blockGrants) ? v.blockGrants.length : 0
        return pageGrants + blockGrants
      } catch {
        return 0
      }
    }

    /** 块级可见性对应的"读者等级"：`granted` 不属于任何等级，只有 admin 覆盖能触及它。 */
    const requiredRankOfBlock = (v: string): number => (v === 'granted' ? 2 : v === 'org' ? 1 : 0)

    /** 主体的读者等级。owner/admin 记 2（与 D14 的应急可见一致），member/viewer 记 1，其余 0。 */
    const readerRankOf = (p: Principal): number => {
      if (p.kind === 'break-glass') return 2
      if (p.orgRole === 'owner' || p.orgRole === 'admin') return 2
      return p.orgRole !== null ? 1 : 0
    }

    cleanups.push(
      router.register('POST', '/api/pages/:slug/versions/:id/restore', async (h) => {
        const slug = h.params.slug ?? ''
        // 恢复会改写**权限** ⇒ 用 requireManage（canManageVisibility），不是普通 canEdit
        const guard = await requireManage(h, slug)
        if (!guard) return
        const versionId = Number(h.params.id)
        if (!Number.isInteger(versionId) || versionId < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const page = (await adb.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        const row = (
          await adb.query<{
            id: number
            content: string
            title: string | null
            blocks_json: string | null
            acl_json: string | null
          }>(
            'SELECT id, content, title, blocks_json, acl_json FROM page_versions WHERE id = ? AND page_id = ?',
            [versionId, page.id],
          )
        )[0]
        if (!row) {
          h.json(404, { ok: false, error: 'not_found', message: `版本不存在: ${h.params.id}` })
          return
        }
        /*
         * 快照体积上限：`blocks_json` 是整页块的文本，理论上可以很大。
         * 超限**显式 413**而不是截断 —— 截断等于恢复出一份残缺的正文。
         */
        if (row.blocks_json !== null && Buffer.byteLength(row.blocks_json, 'utf8') > MAX_SNAPSHOT_BYTES) {
          closeAfterResponse(h)
          h.json(413, {
            ok: false,
            error: 'snapshot_too_large',
            message: `该版本的块快照过大（上限 ${MAX_SNAPSHOT_BYTES} 字节）`,
          })
          return
        }

        const now = new Date().toISOString()
        const actorId = guard.principal.userId

        /*
         * 老版本（`blocks_json IS NULL`，早于块级权限功能）：**只恢复正文**，绝不猜测当时的权限。
         * 猜错的后果正是"把本该受限的内容放开" —— 宁可少恢复，不可猜。
         */
        if (row.blocks_json === null || row.acl_json === null) {
          const revision = await adb.transaction(async (tx) => {
            // 恢复前记一条 ⇒ 本次恢复可逆。
            // `origin='content'`：这次动作**改的就是正文**（下面那句 UPDATE 即可为证），
            // 标成 `'acl'` 会让界面告诉用户"只动了权限"。
            await snapshotAclVersion(tx, slug, guard.principal.userId, 'content')
            await tx.run('UPDATE pages SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?', [
              row.content,
              sha256Hex(row.content),
              now,
              page.id,
            ])
            await syncBlocksForPage(tx, {
              pageId: Number(page.id),
              content: row.content,
              pageLevel: await pageLevelOf(slug),
              now,
              existing: await readExistingBlocks(tx, Number(page.id)),
              // ★ rebase 收尾：P3a 把 `syncIndex` 改成必填后，P3c 新增的恢复路径也必须显式传
              //   （否则 PG 上会去写不存在的 `blocks_fts` ⇒ 整个恢复事务失败）
              syncIndex: blocksIndexSupported,
              // ★ 恢复是"显式回到那个状态"，可能改变块结构 ⇒ 放行编辑路径那三道守卫
              restructure: true,
            })
            return bumpAclRevision(tx, slug)
          })
          void writeAuditLog(adb, {
            action: 'acl.change',
            targetKind: 'page',
            targetId: slug,
            actorId,
            /*
             * ★ 「从哪一版回到哪一版」必须写在审计里（本批补）。
             *
             * 只记 `restored_version` 时，这条审计回答的是"恢复了**哪个快照**"，而恢复
             * **之后**页面变成第几版是另一个数 —— 排查"这条内容现在到底对应哪一版、
             * 是哪次恢复弄成这样的"时，两者缺一不可。
             *
             * `to_version` 与详情端点的 `page.version` 同源：`COUNT(page_versions) + 1`。
             * 上面事务里 `snapshotAclVersion` 已经插入了一行（恢复前的状态），所以
             * **恢复后**的版本号就是"当前行数 + 1" —— 这里不再多查一次库。
             *
             * `from_title` 取的是**被覆盖掉的**那一版标题（与快照 `title` 列同一语义）；
             * 老行（0020 之前）为 NULL，读侧当"未记录"，不编造。
             */
            after: {
              restored_version: versionId,
              restored_title: row.title ?? null,
              to_version: (await adb.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?',
                [page.id],
              ))[0]!.n + 1,
              block_acls_restored: false,
            },
          }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))
          h.json(200, {
            ok: true,
            slug,
            restored: versionId,
            acl_revision: revision,
            warnings: ['block_acls_not_restored'],
          })
          return
        }

        let snapshotBlocks: Array<{ o: number; k: string; t: string; v: string; i: number; m: string | null }>
        let acl: {
          visibility: string
          inherit: number
          published_at: string | null
          page_grants: Array<{ k: string; s: string; r: string; e: string | null }>
          block_grants: Array<{ o: number; k: string; s: string; r: string; e: string | null }>
        }
        try {
          snapshotBlocks = JSON.parse(row.blocks_json) as typeof snapshotBlocks
          acl = JSON.parse(row.acl_json) as typeof acl
        } catch {
          h.json(500, { ok: false, error: 'corrupt_snapshot', message: '该版本的快照无法解析' })
          return
        }
        if (
          !Array.isArray(snapshotBlocks) ||
          !Array.isArray(acl.page_grants) ||
          !Array.isArray(acl.block_grants)
        ) {
          h.json(500, { ok: false, error: 'corrupt_snapshot', message: '该版本的快照结构不完整' })
          return
        }

        /*
         * ★ 逐块可见性校验（§8.2 P3c）：恢复者必须"看得见"该版本里的**每一个块**。
         * 否则一个只能看到 `org` 档的编辑者就能把含 `granted` 块的旧版本恢复回来 ——
         * 版本恢复于是成了绕过"granted 默认谁都不能看"的写入通道。
         * 回报 `details.blockedOrdinals` 便于调用方定位是哪几段。
         */
        const readerRank = readerRankOf(guard.principal)
        const blockedOrdinals = snapshotBlocks
          .filter((b) => requiredRankOfBlock(String(b.v)) > readerRank)
          .map((b) => Number(b.o))
        if (blockedOrdinals.length > 0) {
          h.json(403, {
            ok: false,
            error: 'forbidden',
            message: '该版本含有你无权触及的内容块，无法恢复',
            details: { reason: 'blocked_blocks', blockedOrdinals },
          })
          return
        }

        const revision = await adb.transaction(async (tx) => {
          // ① 恢复前先记一条版本 ⇒ 恢复可逆。
          //    `origin='content'`：这一步改的是正文（②里有 `UPDATE pages SET content = …`）。
          await snapshotAclVersion(tx, slug, guard.principal.userId, 'content')
          // ② 页面级 ACL + 正文
          await tx.run(
            `UPDATE pages SET content = ?, content_hash = ?, updated_at = ?, visibility = ?, inherit = ?, published_at = ?
              WHERE id = ?`,
            [
              row.content,
              sha256Hex(row.content),
              now,
              acl.visibility,
              acl.inherit === 1 ? 1 : 0,
              acl.published_at,
              page.id,
            ],
          )
          // ③ 块集合：注入快照块（走唯一写入路径；块身份由保守重解析维持 ⇒ 授权不会因 id 全变而丢失）
          const parsed: ParsedBlock[] = snapshotBlocks.map((b) => ({
            ordinal: Number(b.o),
            kind: String(b.k) as BlockKind,
            text: String(b.t),
            visibility: String(b.v) as BlockVisibility,
            inherit: Number(b.i) === 1,
            marker: b.m ?? null,
            contentHash: sha256Hex(String(b.t)),
          }))
          await syncBlocksForPage(tx, {
            pageId: Number(page.id),
            content: row.content,
            /*
             * ★ `self` 传**恢复后**的档位：策略层读的是它自己的连接，看不到本事务里
             * 尚未提交的 `UPDATE pages` —— 不传 `self` 就会按**旧**档位算 tier，
             * 于是恢复完的块 tier 全是错的（检索判定随之错误）。
             */
            pageLevel: await pageLevelOf(slug, {
              visibility: acl.visibility,
              inherit: acl.inherit === 1 ? 1 : 0,
              published_at: acl.published_at,
            }),
            now,
            existing: await readExistingBlocks(tx, Number(page.id)),
            parse: () => parsed,
            // ★ rebase 收尾：同上，`syncIndex` 在 P3a 修复后是必填
            syncIndex: blocksIndexSupported,
            /*
             * ★ 同上：恢复可能改变块结构（快照里的块数与当前不同），
             * 而 `restructure` 只放行"改结构"，不触及任何可见性判定。
             */
            restructure: true,
          })
          // ④ 授予：整体替换为快照里的那一组。"恢复权限"必须包含授予 ——
          //    否则旧版本是私有的、而当前的 page_grants 仍然生效 ⇒ 恢复出的权限**更宽**。
          await tx.run('DELETE FROM page_grants WHERE page_slug = ?', [slug])
          for (const g of acl.page_grants) {
            await tx.run(
              `INSERT INTO page_grants (page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [slug, String(g.k), String(g.s), String(g.r), actorId, now, g.e ?? null],
            )
          }
          await tx.run('DELETE FROM block_grants WHERE page_slug = ?', [slug])
          for (const g of acl.block_grants) {
            // 按 ordinal 找回重建后的块 id（快照按 ordinal 引用块，正是为了这一刻）
            const b = (
              await tx.query<{ id: number }>('SELECT id FROM blocks WHERE page_id = ? AND ordinal = ?', [
                page.id,
                Number(g.o),
              ])
            )[0]
            if (!b) continue
            await tx.run(
              `INSERT INTO block_grants (block_id, page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [Number(b.id), slug, String(g.k), String(g.s), String(g.r), actorId, now, g.e ?? null],
            )
          }
          return bumpAclRevision(tx, slug)
        })

        /*
         * ★ 恢复也会改**祖先的档位**，因而必须与档位端点一样做子孙扇出。
         *
         * 上面的 `UPDATE pages ... visibility = ?, inherit = ?, published_at = ?` 会把本页的
         * 有效档位改掉，而**子孙的 `blocks.tier` 是物化派生列**（`pageLevelOf` 只影响本页）。
         * 漏掉扇出的后果是内容泄漏级：把祖先从 public **恢复成 private** 后，子页的读路径
         * 已 404，但它的 `blocks.tier` 仍是旧值 0 ⇒ **匿名 `/api/search` 仍命中并吐出正文片段**；
         * 反方向（放宽）则退化为"搜不到但读得到"。
         *
         * 放在提交**之后**：`pageLevelOf` 走策略层（另一条连接），PG 的 MVCC 下读不到本事务
         * 未提交的那次 UPDATE ⇒ 放进事务里会按**旧**档位算，等于没修。
         * 失败不回滚已提交的恢复（那是用户要的结果），但由 `resyncDescendantsReporting`
         * 升级成响应字段 + 审计行 —— "重算了 0 个子孙"与"扇出整个失败"是两件处置不同的事。
         */
        const resync = await resyncDescendantsReporting(slug)

        /*
         * 与"只恢复正文"那条分支同款：把「从哪一版回到哪一版」写进审计。
         * `to_version = COUNT(page_versions) + 1`（事务里已插入"恢复前"那一行快照，
         * 故恢复后的版本号就是当前行数 + 1），与详情端点的 `page.version` 同源。
         */
        const toVersion = (await adb.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?',
          [page.id],
        ))[0]!.n + 1

        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'page',
          targetId: slug,
          actorId,
          after: {
            restored_version: versionId,
            restored_title: row.title ?? null,
            to_version: toVersion,
            block_acls_restored: true,
            acl_revision: revision,
          },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, {
          ok: true,
          slug,
          restored: versionId,
          // ★ 恢复**之后**的版本号：界面据此说"已恢复到 v{n} 并生成新版本"
          version: toVersion,
          acl_revision: revision,
          warnings: [],
          // 子孙块被重算的条数（0 = 没有子孙）
          index_tiers_resynced: resync.resynced,
          // ★ 与上面那个 0 区分开：true 表示**扇出抛错、一个都没算**（内容泄漏级）
          index_tiers_resync_failed: resync.failed,
          ...(resync.error === undefined ? {} : { index_tiers_resync_error: resync.error }),
        })
      }, { access: 'user' }),
    )

    /* ---------- PUT /api/pages/:slug：upsert（保存时先快照旧正文，幂等：内容未变不产生新历史） ----------
     *
     * 访问等级 `user`（P0）：本端点此前**匿名可调**，任何人可增删改任何条目。
     * 读端点（列表/详情/版本/反链/出链）**保持 public**，行为与 P0 之前完全一致——
     * 按可见性裁剪读取是 P2 的事（需要在服务端逐对象判定，见设计文档 §5）。
     * 注意：`access` 是**粗粒度**闸门，它只保证"不是匿名"，不区分"谁能改哪一条"。
     */
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
        let result: WikiSaveResult
        try {
          /*
           * ★ 把**当前主体**传给保存：它是 `page_versions.saved_by` 的唯一来源，
           * 也就是界面里「谁改的」那一列的来源。不传的话这列永远是 NULL。
           * （`wiki-service.save()` 那条路径刻意不传 —— 跨插件调用没有可归属的主体。）
           */
          result = await savePage(slug, save, h.principal?.userId ?? null)
          /*
           * ★ **保存也写审计**（T5）。
           *
           * 与"版本历史本身就是记录"的分工：`page_versions` 回答"这条**内容**改过几次、
           * 每次是什么样"，审计回答"**谁在什么时候动过它**"、且能把页面事件与同一时间窗
           * 内的权限变更、越权尝试放在一条时间线上看。少了它，"谁改的"就只能靠翻版本
           * 列表逐条查 —— 而运维排查通常是从审计入口进来的。
           *
           * 只记 `version`（版本号）与结果类别，**不记正文也不记 hash**：
           * `packages/core/src/audit.ts` 的 `FORBIDDEN_AUDIT_KEYS` 会**静默删掉** `hash`
           * 这类键，而正文进审计表意味着"内容永久留档"，与审计表的定位不符。
           *
           * `outcome === 'unchanged'` 也记：用户点了保存但内容没变，这本身是有效信息
           * （"我按了保存却没生效"的排查起点）。这条不产生版本，所以版本号与上一条相同。
           */
          void writeAuditLog(adb, {
            action: 'page.save',
            targetKind: 'page',
            targetId: slug,
            actorId: h.principal?.userId ?? null,
            /*
             * ★ 补上 `title`（本批）：只有 `{outcome, version}` 时，审计能回答"谁在什么时候
             * 把页面推到了哪一版"，但回答不了"**改的是标题还是正文**" —— 而时间线上这两类
             * 改动长得很像（`outcome` 都是 `updated`，版本号都 +1）。
             *
             * `title` 是**用户自己填的页面标题**（不是正文的派生物），进审计与仓库"只记结构
             * 与归属、不记内容"的纪律不冲突；真正的正文与它的哈希一律**不进审计**
             * （`FORBIDDEN_AUDIT_KEYS` 连 `hash`/`content_hash` 都禁）。
             */
            after: { outcome: result.outcome, version: result.version, title: save.title },
          }).catch((err: unknown) => console.error('[@geewiki/wiki] 保存审计写入失败:', err))
        } catch (err) {
          /*
           * 正文里的块标记不合法（旧标记 `role=*`、未知档位、`gated` 区段未闭合、代码围栏
           * 未闭合…）是**用户输入问题**，不是服务器故障 —— 必须映射成 400 + 机器码，
           * 而不是让它冒到 `dispatch` 的统一 catch 变成 **500**。
           *
           * 500 的代价是具体的：① 它把"作者写错了"混进"服务出故障"的告警与监控；
           * ② 调用方拿不到 `gated_marker_removed` 这类**可判别**的错误码，只能去正则匹配
           * 一句中文；③ 而"显式拒绝"的价值恰恰在于作者能立刻知道**为什么**被拒。
           * `BlockParseError.code` 就是为此存在的（沿用仓库"消息前缀即错误码"的约定）。
           */
          if (err instanceof BlockParseError) {
            h.json(400, { ok: false, error: err.code, message: err.message })
            return
          }
          /*
           * ★ P3b：保守重解析的冲突 ⇒ **409**（不是 400，也不是 500）。
           *
           * 语义是"请求本身没错，但与资源的当前状态冲突"：作者想删/合并一个**已有块级
           * 授权的块**，而那会静默丢掉授权（§4.2）。解决办法是用户先去撤销授权再改 ——
           * 所以是"冲突"而非"请求非法"。两个错误码：`block_merge_conflict` /
           * `block_grant_orphan`。
           */
          if (err instanceof BlockSyncError) {
            h.json(409, { ok: false, error: err.code, message: err.message })
            return
          }
          throw err
        }
        const { outcome, version, indexTiersResync } = result
        h.json(200, {
          ok: true,
          slug,
          title: save.title,
          outcome,
          version,
          /*
           * ★ 仅 `outcome === 'created'` 时出现（见 `WikiSaveResult.indexTiersResync`）：
           * 新建的页可能成为已有页的祖先，那些子孙的 `blocks.tier` 必须重算。
           * `index_tiers_resync_failed: true` 表示**扇出整个失败**（内容泄漏级），
           * 与 `index_tiers_resynced: 0`（没有子孙，正常）是两件事 —— 调用方必须分开判。
           */
          ...(indexTiersResync === undefined
            ? {}
            : {
                index_tiers_resynced: indexTiersResync.resynced,
                index_tiers_resync_failed: indexTiersResync.failed,
                ...(indexTiersResync.error === undefined
                  ? {}
                  : { index_tiers_resync_error: indexTiersResync.error }),
              }),
        })
      }, { access: 'user' }),
    )

    /* ---------- DELETE /api/pages/:slug（版本历史依赖外键级联；此处显式事务删除以防实现差异） ---------- */
    /*
     * ★ **删除必须留审计**（与其他写路径的取舍不同）：
     *   保存/恢复都有 `page_versions` 兜底（可回滚），而删除是本插件里**唯一不可逆**的
     *   动作 —— 版本历史随外键级联清空，删完就没有任何地方能回答"当时那篇写了什么"。
     *   此前这条路径**一行审计都不写**（只有 ACL 类动作写），于是"谁把页面删了"在
     *   审计里查不到，只能靠 `access.denied` 之类的旁证去猜。
     *
     *   记的是**被删条目的摘要**（标题/历史条数/字节数），不是正文 ——
     *   审计表要长期留存，把正文抄进去等于复制一份永不可删的内容。
     *
     *   ★ **连内容哈希也不记**（`content_hash` 曾在此写入，已移除）：它是正文的**派生物**，
     *   落进审计等于把"内容指纹"长期留存 —— 与"审计不记内容派生物"的既有纪律相悖
     *   （`packages/core/src/audit.ts` 的 `FORBIDDEN_AUDIT_KEYS` 连 `hash` 都禁）。
     *   若确实需要与外部备份比对"被删的是哪一版"，那属于独立的取证需求，
     *   应由备份侧算、而不是让审计表承担。
     *
     *   放在删除**之后**写：删失败（404）不该留一条"删除了"的假记录；
     *   而 `void … .catch` 让审计写入失败**不回滚**已经完成的删除（数据已经没了，
     *   报错给用户也无法挽回 —— 与恢复端点"失败不回滚已提交的恢复"同一取舍）。
     */
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug', async (h) => {
        const slug = h.params.slug ?? ''
        const removed = await deletePage(slug)
        if (removed === false) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        void writeAuditLog(adb, {
          action: 'page.delete',
          targetKind: 'page',
          targetId: slug,
          actorId: h.principal?.userId ?? null,
          after: {
            title: removed.title,
            versions: removed.versions,
            bytes: removed.bytes,
            created_at: removed.createdAt,
          },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 删除审计写入失败:', err))
        h.json(200, { ok: true, deleted: slug })
      }, { access: 'user' }),
    )

    /* ---------- 可见性写侧（P2）：改档位 / 发与撤授权 ---------- */

    /*
     * 为什么这组端点必须存在：P2 之前**没有任何端点能改 `pages.visibility`** ——
     * 读侧判定全部就位，但功能实际不可用（每条永远停留在创建时的那个档）。
     *
     * 治理规则（设计文档 §2.3）：改可见性与改授权同权，都要 `canManageVisibility`。
     * **收紧与放宽同门**：收紧是安全方向、放宽是风险方向，但两者都在改变"谁能看"，
     * 把放宽单列一道门的收益很小、却会多出"谁有权放宽"这个第二真源。
     *
     * 三条不变式：
     * 1. **不泄露存在性** —— `level === 'none'` 一律 404（不是 403）：无权看的人
     *    也不该通过"403 vs 404"知道它存在。
     * 2. **每次 ACL 变更都递增 `acl_revision`**（全局行 + 该条目自己的列）——
     *    它是一个**版本标记与观测信号**（响应里回传，便于发现"变更没生效"）。
     *    ⚠️ **不要写成"策略层据此做代际失效"**：判定层（`packages/plugin-authz`）**没有任何
     *    决策缓存**，每个请求现查库（`loadVisibilityIndex()` 有四处调用点），所以变更天然立即生效、
     *    并没有"失效"这个动作。真正被禁止的是**给判定加 TTL 缓存**
     *    （TTL 必然产生"撤销后仍可见"的窗口）。
     * 3. **审计不含正文**（`before`/`after` 只放档位与授权元数据）。
     */
    const VISIBILITIES = ['private', 'org', 'public'] as const
    /** ★ D13：授权对象**只有** user|group —— 角色不是授权对象（角色只决定能力） */
    const SUBJECT_KINDS = ['user', 'group'] as const
    const GRANT_ROLES = ['editor', 'viewer'] as const

    /** 递增全局 ACL 版本号。单行表，`id = 1` 由迁移预置。 */
    const bumpAclRevision = async (tx: DatabaseExecutor, slug: string): Promise<number> => {
      await tx.run('UPDATE acl_revision SET revision = revision + 1 WHERE id = 1')
      await tx.run('UPDATE pages SET acl_revision = acl_revision + 1 WHERE slug = ?', [slug])
      const row = (await tx.query<{ revision: number }>('SELECT revision FROM acl_revision WHERE id = 1'))[0]
      return Number(row?.revision ?? 0)
    }

    /**
     * 某页当前的**版本快照载荷**：块集合 + 页面级 ACL + 例外授予。
     *
     * ★ **为什么把「授予」也放进快照**（而不只是 visibility/inherit/published_at）：
     * 「恢复此版本」若只恢复档位、不恢复授予，就会出现**放宽**事故 —— 旧版本里这条是私有的，
     * 但**当前**的 `page_grants` 仍然生效，恢复后那些被授予者依然能看 ⇒ 恢复出来的权限比
     * 该版本实际拥有的**更宽**。这正是 `0017_version_blocks.sql` 里那条规则要防的事：
     * 版本快照与「恢复」必须覆盖同一组事实，否则两者脱节。
     *
     * 块级授予按 **`ordinal`** 引用而不是块 id：恢复时块会被整体重建，id 不保证延续，
     * 而 `ordinal` 在 `blocks_json` 里就是块的身份，两边能对上。
     */
    const versionSnapshotOf = async (
      tx: DatabaseExecutor,
      pageId: number,
    ): Promise<{ blocksJson: string; aclJson: string }> => {
      const blocks = await tx.query<{
        ordinal: number
        kind: string
        text: string
        visibility: string
        inherit: number
        marker: string | null
      }>(
        'SELECT ordinal, kind, text, visibility, inherit, marker FROM blocks WHERE page_id = ? ORDER BY ordinal',
        [pageId],
      )
      const page = (
        await tx.query<{ visibility: string; inherit: number; published_at: string | null }>(
          'SELECT visibility, inherit, published_at FROM pages WHERE id = ?',
          [pageId],
        )
      )[0]
      const pageGrants = await tx.query<{
        subject_kind: string
        subject_id: string
        role: string
        expires_at: string | null
      }>(
        `SELECT subject_kind, subject_id, role, expires_at FROM page_grants
          WHERE page_slug = (SELECT slug FROM pages WHERE id = ?) ORDER BY id`,
        [pageId],
      )
      const blockGrants = await tx.query<{
        ordinal: number
        subject_kind: string
        subject_id: string
        role: string
        expires_at: string | null
      }>(
        `SELECT b.ordinal AS ordinal, g.subject_kind, g.subject_id, g.role, g.expires_at
           FROM block_grants g JOIN blocks b ON b.id = g.block_id
          WHERE b.page_id = ? ORDER BY b.ordinal, g.id`,
        [pageId],
      )
      return {
        blocksJson: JSON.stringify(
          blocks.map((b) => ({
            o: Number(b.ordinal),
            k: b.kind,
            t: b.text,
            v: b.visibility,
            i: Number(b.inherit),
            m: b.marker,
          })),
        ),
        aclJson: JSON.stringify({
          visibility: page?.visibility ?? 'private',
          inherit: Number(page?.inherit ?? 1),
          published_at: page?.published_at ?? null,
          page_grants: pageGrants.map((g) => ({
            k: g.subject_kind,
            s: g.subject_id,
            r: g.role,
            e: g.expires_at,
          })),
          block_grants: blockGrants.map((g) => ({
            o: Number(g.ordinal),
            k: g.subject_kind,
            s: g.subject_id,
            r: g.role,
            e: g.expires_at,
          })),
        }),
      }
    }

    /**
     * 记一条**中间版本**：`content` 取"当前"（即变更前）的正文，`blocks_json` / `acl_json`
     * 一并定格，供恢复时回到那一刻。
     *
     * 由**两类路径**调用：
     *   - 改权限的路径（改档位、页面授予、块级授予、申请批准）—— 正文不动 ⇒ `origin='acl'`
     *     （默认值；随正文保存而变的块级可见性由 `savePage` 那条版本负责，见 `0017_version_blocks.sql`）
     *   - **恢复历史版本**（两条分支：老版本只回正文、新版本连 ACL 一起回）—— 这次动作
     *     **改的就是正文** ⇒ 必须显式传 `origin='content'`
     *
     * ★ 为什么 `origin` 必须由调用方传、而不能像原来那样写死 `'acl'`：这个字段的全部意义
     *   就是让用户分清"正文被改了"与"只动了权限"。恢复路径在写完本快照后**紧接着**
     *   `UPDATE pages SET content = …`，若仍标 `'acl'`，界面会告诉用户"这次只动了权限"——
     *   那是**说反了**，比不标还糟。
     *
     * 记的是**变更前**的状态 —— 与 `savePage` 的既有约定一致（"先快照旧的，再改"），
     * 于是"版本 N = 变更 N 之前的状态"，恢复版本 N 得到的就是那一刻。
     * `title` 随之取**变更前**的标题：它与 `origin`/`saved_at` 一起描述"被替换掉的那一版"，
     * 三者自洽；恢复目标版本的标题由 `GET /versions/:id` 那条记录自己带着。
     */
    const snapshotAclVersion = async (
      tx: DatabaseExecutor,
      slug: string,
      /**
       * 本次写入的触发者。可见性/授权/恢复都由 `requireManage` 把关，
       * 那里一定拿得到主体；传 `null` 只用于"确实没有主体"的服务侧调用。
       */
      actorId?: number | null,
      /**
       * 本条的来源（受控枚举）。默认 `'acl'` = "只动了权限"；
       * 恢复历史版本的两条分支必须显式传 `'content'`。
       */
      origin: VersionOrigin = 'acl',
    ): Promise<void> => {
      const page = (
        await tx.query<{ id: number; content: string; title: string }>(
          'SELECT id, content, title FROM pages WHERE slug = ?',
          [slug],
        )
      )[0]
      if (!page) return
      const snap = await versionSnapshotOf(tx, Number(page.id))
      await tx.run(
        `INSERT INTO page_versions (page_id, content, saved_at, blocks_json, acl_json, saved_by, title, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(page.id),
          page.content,
          new Date().toISOString(),
          snap.blocksJson,
          snap.aclJson,
          actorId ?? null,
          page.title,
          origin,
        ],
      )
    }

    /**
     * 把某一页**全部块**的 `tier` 重算为 `tierFor(level, 该块自身的 visibility)`。
     *
     * 为什么要复用 `tierFor` 而不是在 SQL 里重写一遍：`tier` 的语义（"页面压上限、
     * 块只能更窄"，以及 `granted ⇒ NULL`）**只有一处真源**。在 SQL 里再写一份
     * （哪怕是等价的 `CASE WHEN`）必然漂移，而漂移的后果是检索的可见性判定错误。
     */
    const applyTierToPageBlocks = async (
      tx: DatabaseExecutor,
      pageId: number,
      level: PageLevel,
    ): Promise<number> => {
      const rows = await tx.query<{ id: number; visibility: string }>(
        'SELECT id, visibility FROM blocks WHERE page_id = ?',
        [pageId],
      )
      for (const r of rows) {
        await tx.run('UPDATE blocks SET tier = ? WHERE id = ?', [
          tierFor(level, r.visibility as BlockVisibility),
          r.id,
        ])
      }
      return rows.length
    }

    /**
     * 重算**子孙页面**的 `blocks.tier` —— §9 R13 所说的"tier 重算扇出"。
     *
     * 祖先的 `visibility` / `inherit` 一变，整棵子树的**有效档位**都跟着变，而 `tier`
     * 是检索的唯一依据 ⇒ 不重算就等于"收紧没生效"。层级在本仓就是 slug 前缀
     * （`SLUG_MAX_DEPTH = 8`），与策略层的判定同一口径，故这里按前缀取子树。
     *
     * ⚠️ **必须在调用方的事务提交之后跑**：`pageLevelOf` 走策略层（另一条连接），
     * PG 下看不到未提交的祖先改动，在事务内算会拿到**旧**祖先值 —— 那正是本函数
     * 要修的东西。故它自己开一个事务。
     *
     * 返回被重算的块数（0 表示该页没有子孙）。
     */
    const resyncDescendantTiers = async (slug: string): Promise<number> => {
      const prefix = `${slug}/`
      // 按前缀在 JS 侧筛，而不是 `slug LIKE 'a/%'`：slug 允许 `.` `_` `-`，
      // 而 LIKE 里的 `_` 是通配符 —— 用它得再引入 ESCAPE，多一处能写错的地方。
      const all = await adb.query<{ id: number; slug: string }>('SELECT id, slug FROM pages')
      const targets = all.filter((p) => p.slug.startsWith(prefix))
      if (targets.length === 0) return 0
      return adb.transaction(async (tx) => {
        let touched = 0
        for (const p of targets) {
          touched += await applyTierToPageBlocks(tx, p.id, await pageLevelOf(p.slug))
        }
        return touched
      })
    }

    /**
     * 跑扇出并把失败**升级为一等可观测信号**（响应字段 + 审计行），而不是只打一行 warn。
     *
     * 为什么失败不回滚、不抛给调用方：档位变更**已经提交且是用户要的结果**，
     * 为了一个派生的索引列去回滚用户的操作是本末倒置。正确做法是让偏差**可发现
     * 且可修复**：响应里带 `index_tiers_resync_failed`、审计里留 `acl.resync_failed`、
     * 由 `GET /api/admin/blocks/verify` 的 `tier_mismatched` 长期盯住，
     * 并用 **`POST /api/admin/blocks/resync`** 真正把它重算回去 —— 探针只负责报警，
     * **没有修复入口的报警等于把问题永远挂在那里**。
     */
    const resyncDescendantsReporting = async (slug: string): Promise<ResyncReport> => {
      try {
        return { resynced: await resyncDescendantTiers(slug), failed: false }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(
          '[@geewiki/wiki] 子孙块的 tier 重算失败（检索可能仍按旧档位，属内容泄漏级，' +
            `须用 /api/admin/blocks/verify 核对并重算）: slug=${slug}`,
          err,
        )
        // 审计是持久信号：日志会被轮转，审计行不会
        void writeAuditLog(adb, {
          action: 'acl.resync_failed',
          targetKind: 'page',
          targetId: slug,
          after: { error: message },
        }).catch((e: unknown) => console.error('[@geewiki/wiki] 扇出失败的审计写入也失败了:', e))
        return { resynced: 0, failed: true, error: message }
      }
    }

    /**
     * 管理权限守卫：解析主体、判定可见性与 `canManageVisibility`、取回 page id。
     * 返回 `null` 表示已写出响应（调用方直接 return）。
     */
    const requireManage = async (
      h: RouteHandlerContext,
      slug: string,
    ): Promise<{ principal: Principal } | null> => {
      const principal = h.principal
      if (!principal) {
        h.json(401, { ok: false, error: 'unauthorized', message: '缺少主体信息，无法判定可管理性' })
        return null
      }
      if (!isValidSlug(slug)) {
        h.json(400, { ok: false, error: 'invalid_slug', message: SLUG_HINT })
        return null
      }
      // 策略层是判定单点：**不在这里自己查 visibility**（那会成为第二个真源）
      const access = await policy().resolvePage(principal, slug)
      if (access.level === 'none') {
        h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
        return null
      }
      if (!access.canManageVisibility) {
        h.json(403, {
          ok: false,
          error: 'forbidden',
          message: '没有管理该条目可见性的权限',
          details: { reason: access.reason },
        })
        return null
      }
      return { principal }
    }

    const visibilityStateOf = async (
      slug: string,
    ): Promise<{ visibility: string; inherit: number; published_at: string | null } | undefined> =>
      (await adb.query<{ visibility: string; inherit: number; published_at: string | null }>(
        'SELECT visibility, inherit, published_at FROM pages WHERE slug = ?',
        [slug],
      ))[0]

    /* ---------- PUT /api/pages/:slug/visibility：改档位 / 发布 / 断继承 ---------- */
    cleanups.push(
      router.register('PUT', '/api/pages/:slug/visibility', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return

        let body: Record<string, unknown>
        try {
          body = (await readBody(h)) as Record<string, unknown>
        } catch (err) {
          const message = (err as Error).message
          if (message.startsWith('payload_too_large')) {
            closeAfterResponse(h)
            h.json(413, { ok: false, error: 'payload_too_large', message })
            return
          }
          h.json(400, { ok: false, error: 'invalid_body', message })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          h.json(400, { ok: false, error: 'invalid_body', message: '请求体须为 JSON 对象' })
          return
        }
        const unknown = Object.keys(body).filter(
          (k) => k !== 'visibility' && k !== 'inherit' && k !== 'published',
        )
        if (unknown.length > 0) {
          h.json(400, { ok: false, error: 'invalid_body', message: `未知字段: ${unknown.join(', ')}` })
          return
        }

        const before = await visibilityStateOf(slug)
        if (!before) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }

        const nextVisibility = body['visibility'] ?? before.visibility
        if (typeof nextVisibility !== 'string' || !(VISIBILITIES as readonly string[]).includes(nextVisibility)) {
          h.json(400, {
            ok: false,
            error: 'invalid_visibility',
            message: `visibility 须为 ${VISIBILITIES.join(' | ')} 之一`,
          })
          return
        }
        const nextInherit = body['inherit'] === undefined ? before.inherit : body['inherit'] === true ? 1 : 0
        if (body['inherit'] !== undefined && typeof body['inherit'] !== 'boolean') {
          h.json(400, { ok: false, error: 'invalid_inherit', message: 'inherit 须为布尔值' })
          return
        }
        /*
         * 发布是**独立开关**（设计文档 §2.2）：`public` 档只有配上 `published_at`
         * 才真正对匿名可见，而发布**不继承**。`published: true` 打上时间戳；
         * `false` 清空。不传则保持原状。
         */
        let nextPublished = before.published_at
        if (body['published'] === true) nextPublished = before.published_at ?? new Date().toISOString()
        else if (body['published'] === false) nextPublished = null
        else if (body['published'] !== undefined) {
          h.json(400, { ok: false, error: 'invalid_published', message: 'published 须为布尔值' })
          return
        }

        const revision = await adb.transaction(async (tx) => {
          /*
           * ★ P3c：**改档位也必须产生一条版本**（记的是变更前的状态）。
           * 若只恢复正文、不恢复权限，「恢复此版本」会把当时的正文配上现在的权限 ——
           * 结果可能是把本该受限的内容放开（见 0017 迁移的说明）。
           */
          await snapshotAclVersion(tx, slug, guard.principal.userId)
          await tx.run('UPDATE pages SET visibility = ?, inherit = ?, published_at = ? WHERE slug = ?', [
            nextVisibility,
            nextInherit,
            nextPublished,
            slug,
          ])
          /*
           * ★ 本页块的 `tier` **必须在同一事务里重算**。
           *
           * `tier` 是检索的唯一依据，而它此前只在 `syncBlocksForPage`（保存正文）时按
           * **当时的**页面档位算过一次 —— 于是"发布"只改 `published_at`、不重算 `tier`，
           * 页面在检索里就仍是旧档位。**这个缺陷实测复现过，且是内容泄漏级的**：
           * 创建（默认 org，tier=1）→ 发布为 public → **重新保存**（此时页面已 public，
           * tier 重算成 0）→ 收回成 org，此时 `tier` 仍是 0 ⇒ **匿名在 `/api/search`
           * 里命中该页、并拿到高亮片段（正文内容）**，而同一时刻读路径是 404。
           * 读路径安全、检索路径泄漏 —— 正是"两条路必须用同一条判据"要防的事。
           *
           * 用 `self` 传新档位而不是让它去查库：那一行刚刚在本事务里被改过，而策略层
           * 走另一条连接（PG 下看不到未提交的改动）⇒ 不传就会拿到**旧**档位，
           * 等于没修。
           */
          const row = (await tx.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
          if (row) {
            const level = await pageLevelOf(slug, {
              visibility: nextVisibility,
              inherit: nextInherit,
              published_at: nextPublished,
            })
            await applyTierToPageBlocks(tx, row.id, level)
          }
          return bumpAclRevision(tx, slug)
        })

        /*
         * 祖先的档位会传导到整棵子树（§9 R13）。放在提交**之后**：
         * `pageLevelOf` 走策略层，PG 下读不到本事务里未提交的那次 UPDATE。
         *
         * 失败**不回滚**已提交的档位变更（那是用户要的结果），但必须**可观测** ——
         * 见 `resyncDescendantsReporting`：它把失败升级成响应字段 + 审计行，
         * 因为"重算了 0 个子孙"与"扇出整个失败"是两件处置完全不同的事。
         */
        const resync = await resyncDescendantsReporting(slug)

        // 审计：只记档位与发布状态，**不含正文**
        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'page',
          targetId: slug,
          actorId: guard.principal.userId,
          before: { visibility: before.visibility, inherit: before.inherit === 1, published_at: before.published_at },
          after: { visibility: nextVisibility, inherit: nextInherit === 1, published_at: nextPublished },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, {
          ok: true,
          slug,
          visibility: nextVisibility,
          inherit: nextInherit === 1,
          published_at: nextPublished,
          acl_revision: revision,
          // 子孙块被重算的条数（0 = 没有子孙）。让调用方能观测扇出是否真的发生了。
          index_tiers_resynced: resync.resynced,
          // ★ 与上面那个 0 区分开：true 表示**扇出抛错、一个都没算**
          //（内容泄漏级：读路径已收紧而检索仍按旧档位）。false 才是"没有子孙"。
          index_tiers_resync_failed: resync.failed,
          ...(resync.error === undefined ? {} : { index_tiers_resync_error: resync.error }),
        })
      }, { access: 'user' }),
    )

    /* ---------- GET /api/pages/:slug/grants：列出例外授予 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/grants', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const grants = await adb.query<{
          id: number
          subject_kind: string
          subject_id: string
          role: string
          granted_at: string
          expires_at: string | null
        }>(
          `SELECT id, subject_kind, subject_id, role, granted_at, expires_at
             FROM page_grants WHERE page_slug = ? ORDER BY id`,
          [slug],
        )
        h.json(200, { ok: true, slug, grants })
      }, { access: 'user' }),
    )

    /* ---------- POST /api/pages/:slug/grants：新增/更新一条例外授予 ---------- */
    cleanups.push(
      router.register('POST', '/api/pages/:slug/grants', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return

        let body: Record<string, unknown>
        try {
          body = (await readBody(h)) as Record<string, unknown>
        } catch (err) {
          const message = (err as Error).message
          if (message.startsWith('payload_too_large')) {
            closeAfterResponse(h)
            h.json(413, { ok: false, error: 'payload_too_large', message })
            return
          }
          h.json(400, { ok: false, error: 'invalid_body', message })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          h.json(400, { ok: false, error: 'invalid_body', message: '请求体须为 JSON 对象' })
          return
        }
        const unknown = Object.keys(body).filter(
          (k) => k !== 'subjectKind' && k !== 'subjectId' && k !== 'role' && k !== 'expiresAt',
        )
        if (unknown.length > 0) {
          h.json(400, { ok: false, error: 'invalid_body', message: `未知字段: ${unknown.join(', ')}` })
          return
        }
        const subjectKind = body['subjectKind']
        if (typeof subjectKind !== 'string' || !(SUBJECT_KINDS as readonly string[]).includes(subjectKind)) {
          // ★ D13：这里**明确拒绝** `org_role` —— 角色只决定能力，不是授权对象
          h.json(400, {
            ok: false,
            error: 'invalid_subject_kind',
            message: `subjectKind 须为 ${SUBJECT_KINDS.join(' | ')} 之一（角色不是授权对象，见 D13）`,
          })
          return
        }
        const subjectId = body['subjectId']
        if (typeof subjectId !== 'string' || subjectId.length === 0 || subjectId.length > 128) {
          h.json(400, { ok: false, error: 'invalid_subject_id', message: 'subjectId 须为非空字符串（≤128 字符）' })
          return
        }
        const role = body['role']
        if (typeof role !== 'string' || !(GRANT_ROLES as readonly string[]).includes(role)) {
          h.json(400, { ok: false, error: 'invalid_role', message: `role 须为 ${GRANT_ROLES.join(' | ')} 之一` })
          return
        }
        const expiresAt = body['expiresAt'] === undefined || body['expiresAt'] === null ? null : body['expiresAt']
        if (expiresAt !== null && typeof expiresAt !== 'string') {
          h.json(400, { ok: false, error: 'invalid_expires_at', message: 'expiresAt 须为 ISO 时间字符串或 null' })
          return
        }

        const now = new Date().toISOString()
        const grantedBy = guard.principal.userId
        /*
         * 幂等 upsert：同一 `(page_slug, subject_kind, subject_id)` 唯一（迁移里建了唯一索引）。
         * 先查后写（而不是 `INSERT OR REPLACE`）：后者会重置 `granted_at` 与 `granted_by`，
         * 把"改角色"伪装成"新授予"，审计会失真。
         */
        const revision = await adb.transaction(async (tx) => {
          // ★ P3c：授予变更也要产生版本（否则恢复旧版本时，当前授予仍在 ⇒ 恢复出的权限更宽）
          await snapshotAclVersion(tx, slug, guard.principal.userId)
          const existing = (
            await tx.query<{ id: number; role: string; expires_at: string | null }>(
              'SELECT id, role, expires_at FROM page_grants WHERE page_slug = ? AND subject_kind = ? AND subject_id = ?',
              [slug, subjectKind, subjectId],
            )
          )[0]
          if (existing) {
            await tx.run('UPDATE page_grants SET role = ?, expires_at = ? WHERE id = ?', [role, expiresAt, existing.id])
          } else {
            await tx.run(
              `INSERT INTO page_grants (page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [slug, subjectKind, subjectId, role, grantedBy, now, expiresAt],
            )
          }
          return bumpAclRevision(tx, slug)
        })

        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'grant',
          targetId: `${slug}:${subjectKind}:${subjectId}`,
          actorId: grantedBy,
          after: { role, expires_at: expiresAt },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, { ok: true, slug, subjectKind, subjectId, role, expiresAt, acl_revision: revision })
      }, { access: 'user' }),
    )

    /* ---------- DELETE /api/pages/:slug/grants/:id：撤销一条例外授予 ---------- */
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug/grants/:id', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const id = Number(h.params.id)
        if (!Number.isInteger(id) || id < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const revision = await adb.transaction(async (tx) => {
          // 带上 page_slug 条件：防止用 A 页的授权 id 去操作 B 页（越权改他人授权）
          const removed = (await tx.query<{ id: number; subject_kind: string; subject_id: string; role: string }>(
            'SELECT id, subject_kind, subject_id, role FROM page_grants WHERE id = ? AND page_slug = ?',
            [id, slug],
          ))[0]
          if (!removed) return null
          // ★ P3c：撤销授予同样产生版本 —— **放在存在性检查之后**，否则 404 也会写出一条无意义的版本
          await snapshotAclVersion(tx, slug, guard.principal.userId)
          await tx.run('DELETE FROM page_grants WHERE id = ? AND page_slug = ?', [id, slug])
          const rev = await bumpAclRevision(tx, slug)
          return { rev, removed }
        })
        if (!revision) {
          h.json(404, { ok: false, error: 'not_found', message: `授权不存在: ${id}` })
          return
        }
        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'grant',
          targetId: `${slug}:${revision.removed.subject_kind}:${revision.removed.subject_id}`,
          actorId: guard.principal.userId,
          before: { role: revision.removed.role },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, { ok: true, slug, removed: id, acl_revision: revision.rev })
      }, { access: 'user' }),
    )

    /* ---------- 申请访问（★ P3b，§8.2 P3b 第 6 条） ---------- */
    /*
     * 一等流程：无权用户不必去找管理员私聊 —— 403 页与受限块的占位文案上都应有入口。
     *
     * 与授权的区别（别混）：`page_grants` / `block_grants` 是**已生效的授予**；
     * `access_requests` 是**待裁决的请求**，批准后才落一条授予。分开存是因为"请求"有
     * 生命周期（pending/approved/denied/withdrawn）与裁决人，"授予"只有生效/过期两态。
     *
     * ★ 本端点的判据是「**是不是已登录的真实用户**」，**不是**「能不能读」——
     * 它服务的恰恰是"读不到"的人，所以**绝不能**在入口处做读权限检查。
     *
     * ⚠️ 一个已知的 UX 缺口（记录在案，不在本次修）：详情读路径对**所有**主体一律返回
     * 404，而非设计文档 §2.3 写的"匿名 404 / 已登录 403" —— 见 `getPage` 的注释与
     * 本文件 :1268-1269：区分 404 与 403 就等于提供了一个存在性探测接口。这个选择更严，
     * 但**代价是"申请访问"失去了自然触发点**（用户拿到 404 时分不清"无权"与"不存在"）。
     * 因此申请入口必须由前端在**已知 slug** 的拒绝态页面/受限块占位文案上提供
     * （§8.2 P3b 第 6 条），不能指望读路径给出 403。
     */
    const MAX_REQUEST_MESSAGE = 500

    /** 读 JSON 对象请求体；失败时已写出响应并返回 null（空体视作 `{}`，见 readBody）。 */
    const readObjectBody = async (h: RouteHandlerContext): Promise<Record<string, unknown> | null> => {
      let raw: unknown
      try {
        raw = await readBody(h)
      } catch (err) {
        const message = (err as Error).message
        if (message.startsWith('payload_too_large')) {
          closeAfterResponse(h)
          h.json(413, { ok: false, error: 'payload_too_large', message })
          return null
        }
        h.json(400, { ok: false, error: 'invalid_body', message })
        return null
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        h.json(400, { ok: false, error: 'invalid_body', message: '请求体须为 JSON 对象' })
        return null
      }
      return raw as Record<string, unknown>
    }

    /** 校验 `role` / `expiresAt` 两个可选字段；不合法时已写出响应并返回 null。 */
    const readGrantFields = (
      h: RouteHandlerContext,
      body: Record<string, unknown>,
      allowed: readonly string[],
    ): { role: string; expiresAt: string | null } | null => {
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
      if (unknown.length > 0) {
        h.json(400, { ok: false, error: 'invalid_body', message: `未知字段: ${unknown.join(', ')}` })
        return null
      }
      const role = body['role'] === undefined ? 'viewer' : body['role']
      if (typeof role !== 'string' || !(GRANT_ROLES as readonly string[]).includes(role)) {
        h.json(400, { ok: false, error: 'invalid_role', message: `role 须为 ${GRANT_ROLES.join(' | ')} 之一` })
        return null
      }
      const raw = body['expiresAt'] === undefined ? null : body['expiresAt']
      if (raw !== null && typeof raw !== 'string') {
        h.json(400, { ok: false, error: 'invalid_expires_at', message: 'expiresAt 须为 ISO 时间字符串或 null' })
        return null
      }
      return { role, expiresAt: raw }
    }

    /*
     * 提交申请：落一条 `pending`。
     *
     * 唯一键是 `(page_slug, user_id, status)`（见 0014 迁移），它同时满足两件事：
     *   - 同一人**不会**积压多条 pending（否则审批人会重复点、重复落授予）；
     *   - 被拒绝之后**可以再次申请**（情形会变），因为那时 status 已经是 `denied`。
     * 这里**先查后插**（为了给出干净的 409 与可判别错误码），**同时**捕获唯一约束冲突
     * 兜住并发窗口 —— 唯一索引才是数据库层的最终保证，先查只是为了让常见路径的报错友好。
     */
    cleanups.push(
      router.register('POST', '/api/pages/:slug/access-requests', async (h) => {
        const slug = h.params.slug ?? ''
        const principal = h.principal
        if (!principal || principal.kind !== 'user' || principal.userId === null) {
          h.json(401, { ok: false, error: 'unauthorized', message: '请先登录后再申请访问' })
          return
        }
        if (!isValidSlug(slug)) {
          h.json(400, { ok: false, error: 'invalid_slug', message: SLUG_HINT })
          return
        }
        const body = await readObjectBody(h)
        if (!body) return
        const fields = readGrantFields(h, body, ['message', 'role'])
        if (!fields) return
        const rawMessage = body['message']
        if (rawMessage !== undefined && rawMessage !== null && typeof rawMessage !== 'string') {
          h.json(400, { ok: false, error: 'invalid_message', message: 'message 须为字符串' })
          return
        }
        const message =
          typeof rawMessage === 'string' && rawMessage.trim().length > 0 ? rawMessage.trim() : null
        if (message !== null && message.length > MAX_REQUEST_MESSAGE) {
          h.json(400, {
            ok: false,
            error: 'invalid_message',
            message: `message 过长（上限 ${MAX_REQUEST_MESSAGE} 字符）`,
          })
          return
        }

        const page = (await adb.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        // 已经有权限就不必申请（否则待审列表会被这类无意义条目灌满）
        const access = await policy().resolvePage(principal, slug)
        if (access.level !== 'none') {
          h.json(409, { ok: false, error: 'already_has_access', message: '你已有该条目的访问权限，无需申请' })
          return
        }
        const pending = (
          await adb.query<{ id: number }>(
            `SELECT id FROM access_requests WHERE page_slug = ? AND user_id = ? AND status = 'pending'`,
            [slug, principal.userId],
          )
        )[0]
        if (pending) {
          h.json(409, { ok: false, error: 'already_requested', message: '你已提交过申请，请等待处理' })
          return
        }

        const now = new Date().toISOString()
        let created: number
        try {
          /*
           * ★ `RETURNING id` 不是可选的：SQLite 有隐式 rowid，**PostgreSQL 没有** ——
           * PG 适配器的 `lastInsertRowid` 只在 SQL 里写了 `RETURNING id` 时才非 0。
           * 本仓既有插件（plugin-auth ×3 / plugin-org / plugin-wiki 的 blocks 写入）都遵守这条。
           */
          const res = await adb.run(
            `INSERT INTO access_requests (page_slug, user_id, message, status, created_at)
             VALUES (?, ?, ?, 'pending', ?) RETURNING id`,
            [slug, principal.userId, message, now],
          )
          created = Number(res.lastInsertRowid)
        } catch (err) {
          const text = (err as Error).message
          // 并发窗口：两个请求同时通过了上面的先查。唯一索引是最终保证 —— 认得出就报 409。
          if (/UNIQUE constraint failed|duplicate key value/i.test(text)) {
            h.json(409, { ok: false, error: 'already_requested', message: '你已提交过申请，请等待处理' })
            return
          }
          throw err
        }
        // 返回 `id`：客户端要用它来撤回自己的申请（撤回端点按 id 定位）
        h.json(200, { ok: true, slug, id: created, status: 'pending', requestedRole: fields.role })
      }, { access: 'user' }),
    )

    /* ---------- GET /api/pages/:slug/access-requests：待审列表（需可管理可见性） ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/access-requests', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const rows = await adb.query<{
          id: number
          user_id: number
          message: string | null
          status: string
          created_at: string
          decided_at: string | null
        }>(
          `SELECT id, user_id, message, status, created_at, decided_at
             FROM access_requests WHERE page_slug = ? AND status = 'pending'
            ORDER BY created_at DESC, id DESC LIMIT 200`,
          [slug],
        )
        h.json(200, {
          ok: true,
          slug,
          requests: rows.map((r) => ({
            id: Number(r.id),
            userId: Number(r.user_id),
            // 自由文本：原样回传，**由展示端负责转义**（迁移注释已注明这是唯一承载用户
            // 自由文本的列）。这里不截断 —— 长度在上游写入时已限死。
            message: r.message,
            status: r.status,
            createdAt: r.created_at,
            decidedAt: r.decided_at,
          })),
        })
      }, { access: 'user' }),
    )

    /* ---------- POST /api/pages/:slug/access-requests/:id/approve：批准并落授予 ---------- */
    /*
     * 批准 = **一条 `page_grants` + `acl_revision++`**。被批准者**无需重新登录即可见**，
     * 原因是**判定层没有任何决策缓存**（`packages/plugin-authz` 每个请求现查库），
     * **不是**因为 `acl_revision` 触发了什么失效 —— 它只是版本标记与观测信号。
     * ⚠️ 反过来说：**一旦给判定层加了 TTL 缓存，这条性质就会失效**（§4.5 明令不要那样做）。
     */
    cleanups.push(
      router.register('POST', '/api/pages/:slug/access-requests/:id/approve', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const id = Number(h.params.id)
        if (!Number.isInteger(id) || id < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const body = await readObjectBody(h)
        if (!body) return
        const fields = readGrantFields(h, body, ['role', 'expiresAt'])
        if (!fields) return

        const now = new Date().toISOString()
        const actorId = guard.principal.userId
        const outcome = await adb.transaction(async (tx) => {
          // 带上 page_slug 条件：防止用 A 页的申请 id 去批准 B 页（越权改他人授权）
          const req = (
            await tx.query<{ id: number; user_id: number; status: string }>(
              'SELECT id, user_id, status FROM access_requests WHERE id = ? AND page_slug = ?',
              [id, slug],
            )
          )[0]
          if (!req) return null
          if (req.status !== 'pending') return { conflict: req.status } as const
          // ★ P3c：批准等同于"新增一条 page_grant" ⇒ 同样必须产生版本
          await snapshotAclVersion(tx, slug, guard.principal.userId)
          const subjectId = String(Number(req.user_id))
          // 幂等 upsert（与 POST /grants 同款）：先查后写，避免把"改角色"伪装成"新授予"
          const existing = (
            await tx.query<{ id: number }>(
              'SELECT id FROM page_grants WHERE page_slug = ? AND subject_kind = ? AND subject_id = ?',
              [slug, 'user', subjectId],
            )
          )[0]
          if (existing) {
            await tx.run('UPDATE page_grants SET role = ?, expires_at = ? WHERE id = ?', [
              fields.role,
              fields.expiresAt,
              existing.id,
            ])
          } else {
            await tx.run(
              `INSERT INTO page_grants (page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
               VALUES (?, 'user', ?, ?, ?, ?, ?)`,
              [slug, subjectId, fields.role, actorId, now, fields.expiresAt],
            )
          }
          await tx.run(`UPDATE access_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`, [
            actorId,
            now,
            id,
          ])
          const rev = await bumpAclRevision(tx, slug)
          return { conflict: null, requesterId: Number(req.user_id), rev } as const
        })
        if (!outcome) {
          h.json(404, { ok: false, error: 'not_found', message: `申请不存在: ${id}` })
          return
        }
        if (outcome.conflict !== null) {
          h.json(409, {
            ok: false,
            error: 'request_not_pending',
            message: `该申请已是 ${outcome.conflict} 状态，无法再次裁决`,
          })
          return
        }
        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'grant',
          targetId: `${slug}:user:${outcome.requesterId}`,
          actorId,
          after: { role: fields.role, expires_at: fields.expiresAt, via: 'access_request', request_id: id },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, {
          ok: true,
          slug,
          approved: id,
          userId: outcome.requesterId,
          role: fields.role,
          acl_revision: outcome.rev,
        })
      }, { access: 'user' }),
    )

    /* ---------- POST /api/pages/:slug/access-requests/:id/deny：拒绝 ---------- */
    cleanups.push(
      router.register('POST', '/api/pages/:slug/access-requests/:id/deny', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const id = Number(h.params.id)
        if (!Number.isInteger(id) || id < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const now = new Date().toISOString()
        const actorId = guard.principal.userId
        const outcome = await adb.transaction(async (tx) => {
          const req = (
            await tx.query<{ id: number; status: string }>(
              'SELECT id, status FROM access_requests WHERE id = ? AND page_slug = ?',
              [id, slug],
            )
          )[0]
          if (!req) return null
          if (req.status !== 'pending') return { conflict: req.status } as const
          // 拒绝**不**动 acl_revision：没有任何授权的增减，判定结果不变
          await tx.run(`UPDATE access_requests SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ?`, [
            actorId,
            now,
            id,
          ])
          return { conflict: null } as const
        })
        if (!outcome) {
          h.json(404, { ok: false, error: 'not_found', message: `申请不存在: ${id}` })
          return
        }
        if (outcome.conflict !== null) {
          h.json(409, {
            ok: false,
            error: 'request_not_pending',
            message: `该申请已是 ${outcome.conflict} 状态，无法再次裁决`,
          })
          return
        }
        h.json(200, { ok: true, slug, denied: id })
      }, { access: 'user' }),
    )

    /* ---------- POST /api/pages/:slug/access-requests/:id/withdraw：撤回自己的申请 ---------- */
    /*
     * 撤回**不需要** `canManageVisibility` —— 那会要求申请人先有管理权，自相矛盾。
     * 判据是"这条申请是不是你自己的"。
     */
    cleanups.push(
      router.register('POST', '/api/pages/:slug/access-requests/:id/withdraw', async (h) => {
        const slug = h.params.slug ?? ''
        const principal = h.principal
        if (!principal || principal.kind !== 'user' || principal.userId === null) {
          h.json(401, { ok: false, error: 'unauthorized', message: '请先登录' })
          return
        }
        const id = Number(h.params.id)
        if (!Number.isInteger(id) || id < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const now = new Date().toISOString()
        const outcome = await adb.transaction(async (tx) => {
          const req = (
            await tx.query<{ id: number; user_id: number; status: string }>(
              'SELECT id, user_id, status FROM access_requests WHERE id = ? AND page_slug = ?',
              [id, slug],
            )
          )[0]
          // 不是自己的申请 ⇒ 与"不存在"同样回 404（不泄露"这里有一条别人的申请"）
          if (!req || Number(req.user_id) !== principal.userId) return null
          if (req.status !== 'pending') return { conflict: req.status } as const
          await tx.run(`UPDATE access_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?`, [now, id])
          return { conflict: null } as const
        })
        if (!outcome) {
          h.json(404, { ok: false, error: 'not_found', message: `申请不存在: ${id}` })
          return
        }
        if (outcome.conflict !== null) {
          h.json(409, {
            ok: false,
            error: 'request_not_pending',
            message: `该申请已是 ${outcome.conflict} 状态，无法撤回`,
          })
          return
        }
        h.json(200, { ok: true, slug, withdrawn: id })
      }, { access: 'user' }),
    )

    /* ---------- GET /api/pages/:slug/blocks：块级治理视图（★ P3b） ---------- */
    /*
     * ★ **刻意不返回 `text`**。
     *
     * 这是治理面板的数据源（"这一页哪些块被单独收紧过、谁被授予了"），不是阅读界面 ——
     * 而受限块的正文按定义就不该出现在这里。一旦带上 `text`，这个端点立刻变成
     * "只要 canManageVisibility 就能读到所有 `granted` 块正文"的旁路，而 `granted`
     * 档的语义恰恰是"默认谁都不能看"（§2.2）。要读正文请走详情页，那里有完整投影。
     */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/blocks', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const page = (await adb.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        const rows = await adb.query<{
          id: number
          ordinal: number
          kind: string
          visibility: string
          inherit: number
          marker: string | null
          tier: number | null
        }>(
          `SELECT b.id, b.ordinal, b.kind, b.visibility, b.inherit, b.marker, b.tier
             FROM blocks b WHERE b.page_id = ? ORDER BY b.ordinal`,
          [page.id],
        )
        const grants = await adb.query<{
          id: number
          block_id: number
          subject_kind: string
          subject_id: string
          role: string
          granted_at: string
          expires_at: string | null
        }>(
          `SELECT g.id, g.block_id, g.subject_kind, g.subject_id, g.role, g.granted_at, g.expires_at
             FROM block_grants g JOIN blocks b ON b.id = g.block_id
            WHERE b.page_id = ? ORDER BY g.id`,
          [page.id],
        )
        const byBlock = new Map<number, typeof grants>()
        for (const g of grants) {
          const list = byBlock.get(Number(g.block_id)) ?? []
          list.push(g)
          byBlock.set(Number(g.block_id), list)
        }
        h.json(200, {
          ok: true,
          slug,
          blocks: rows.map((b) => ({
            id: Number(b.id),
            ordinal: Number(b.ordinal),
            kind: b.kind,
            visibility: b.visibility,
            inherit: Number(b.inherit) === 1,
            marker: b.marker,
            /** `null` = 该块不属于任何读者等级（`granted` 档，只能靠授权放行） */
            tier: b.tier === null ? null : Number(b.tier),
            grants: (byBlock.get(Number(b.id)) ?? []).map((g) => ({
              id: Number(g.id),
              subjectKind: g.subject_kind,
              subjectId: g.subject_id,
              role: g.role,
              grantedAt: g.granted_at,
              expiresAt: g.expires_at,
            })),
          })),
        })
      }, { access: 'user' }),
    )

    /* ---------- POST /api/pages/:slug/blocks/:blockId/grants：块级例外授予 ---------- */
    cleanups.push(
      router.register('POST', '/api/pages/:slug/blocks/:blockId/grants', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const blockId = Number(h.params.blockId)
        if (!Number.isInteger(blockId) || blockId < 1) {
          h.json(400, { ok: false, error: 'invalid_block_id', message: 'blockId 须为正整数' })
          return
        }
        let body: Record<string, unknown>
        try {
          body = (await readBody(h)) as Record<string, unknown>
        } catch (err) {
          const message = (err as Error).message
          if (message.startsWith('payload_too_large')) {
            closeAfterResponse(h)
            h.json(413, { ok: false, error: 'payload_too_large', message })
            return
          }
          h.json(400, { ok: false, error: 'invalid_body', message })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          h.json(400, { ok: false, error: 'invalid_body', message: '请求体须为 JSON 对象' })
          return
        }
        const unknown = Object.keys(body).filter(
          (k) => k !== 'subjectKind' && k !== 'subjectId' && k !== 'role' && k !== 'expiresAt',
        )
        if (unknown.length > 0) {
          h.json(400, { ok: false, error: 'invalid_body', message: `未知字段: ${unknown.join(', ')}` })
          return
        }
        const subjectKind = body['subjectKind']
        if (typeof subjectKind !== 'string' || !(SUBJECT_KINDS as readonly string[]).includes(subjectKind)) {
          // ★ D13：块级与页面级**完全同构** —— 同样明确拒绝 `org_role`
          h.json(400, {
            ok: false,
            error: 'invalid_subject_kind',
            message: `subjectKind 须为 ${SUBJECT_KINDS.join(' | ')} 之一（角色不是授权对象，见 D13）`,
          })
          return
        }
        const subjectId = body['subjectId']
        if (typeof subjectId !== 'string' || subjectId.length === 0 || subjectId.length > 128) {
          h.json(400, { ok: false, error: 'invalid_subject_id', message: 'subjectId 须为非空字符串（≤128 字符）' })
          return
        }
        const role = body['role']
        if (typeof role !== 'string' || !(GRANT_ROLES as readonly string[]).includes(role)) {
          h.json(400, { ok: false, error: 'invalid_role', message: `role 须为 ${GRANT_ROLES.join(' | ')} 之一` })
          return
        }
        const expiresAt = body['expiresAt'] === undefined || body['expiresAt'] === null ? null : body['expiresAt']
        if (expiresAt !== null && typeof expiresAt !== 'string') {
          h.json(400, { ok: false, error: 'invalid_expires_at', message: 'expiresAt 须为 ISO 时间字符串或 null' })
          return
        }

        const now = new Date().toISOString()
        const grantedBy = guard.principal.userId
        const outcome = await adb.transaction(async (tx) => {
          /*
           * ★ **必须校验块确实属于该页**（而不是分别校验"页可管"与"块存在"）。
           *
           * 只查 `blocks WHERE id = ?` 会留下一个组合式越权口：拿 A 页的 slug（自己有
           * 管理权）配 B 页的 blockId，就能给别人的块加授权。这类"父 ID + 子 ID 组合"
           * 的绕过在真实产品里出现过（设计文档 §9 R10 第 4 条引的正是这种形态）。
           */
          const block = (
            await tx.query<{ id: number; visibility: string }>(
              `SELECT b.id, b.visibility FROM blocks b JOIN pages p ON p.id = b.page_id
                WHERE b.id = ? AND p.slug = ?`,
              [blockId, slug],
            )
          )[0]
          if (!block) return null
          // ★ P3c：块级授予同样产生版本 —— 放在校验之后，避免 404 也写出版本
          await snapshotAclVersion(tx, slug, guard.principal.userId)
          // 幂等 upsert（同页面级：先查后写，避免把"改角色"伪装成"新授予"）
          const existing = (
            await tx.query<{ id: number }>(
              'SELECT id FROM block_grants WHERE block_id = ? AND subject_kind = ? AND subject_id = ?',
              [blockId, subjectKind, subjectId],
            )
          )[0]
          if (existing) {
            await tx.run('UPDATE block_grants SET role = ?, expires_at = ? WHERE id = ?', [role, expiresAt, existing.id])
          } else {
            await tx.run(
              `INSERT INTO block_grants (block_id, page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [blockId, slug, subjectKind, subjectId, role, grantedBy, now, expiresAt],
            )
          }
          return { rev: await bumpAclRevision(tx, slug), blockVisibility: block.visibility }
        })
        if (!outcome) {
          h.json(404, { ok: false, error: 'not_found', message: `块不存在于本页: ${blockId}` })
          return
        }
        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'grant',
          targetId: `${slug}#block:${blockId}:${subjectKind}:${subjectId}`,
          actorId: grantedBy,
          after: { role, expires_at: expiresAt },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, {
          ok: true,
          slug,
          blockId,
          subjectKind,
          subjectId,
          role,
          expiresAt,
          acl_revision: outcome.rev,
          /*
           * 把该块**自身声明**的档位回给调用方。规则 B1（§2.3）说"块只能比页面更窄、
           * 不能更宽"，所以当这个块是 `public`/`org`、而页面本身更窄时，授权**不会**
           * 让它突破页面上限 —— 前端据此提示"实际可见性由页面决定"，而不是让用户
           * 以为授权没生效。这里只回声明值，不回算出的有效值（那个由读路径判定）。
           */
          block_visibility: outcome.blockVisibility,
        })
      }, { access: 'user' }),
    )

    /* ---------- DELETE /api/pages/:slug/blocks/:blockId/grants/:grantId：撤销块级授予 ---------- */
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug/blocks/:blockId/grants/:grantId', async (h) => {
        const slug = h.params.slug ?? ''
        const guard = await requireManage(h, slug)
        if (!guard) return
        const blockId = Number(h.params.blockId)
        const grantId = Number(h.params.grantId)
        if (!Number.isInteger(blockId) || blockId < 1 || !Number.isInteger(grantId) || grantId < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'blockId 与 grantId 须为正整数' })
          return
        }
        const outcome = await adb.transaction(async (tx) => {
          // 同样带上"块属于本页"的条件，防止拿别的页的 id 组合操作（同 POST 的越权口）
          const owned = (
            await tx.query<{ id: number }>(
              `SELECT b.id FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = ? AND p.slug = ?`,
              [blockId, slug],
            )
          )[0]
          if (!owned) return null
          const removed = (
            await tx.query<{ id: number; subject_kind: string; subject_id: string; role: string }>(
              'SELECT id, subject_kind, subject_id, role FROM block_grants WHERE id = ? AND block_id = ?',
              [grantId, blockId],
            )
          )[0]
          if (!removed) return null
          // ★ P3c：撤销块级授予同样产生版本（放在存在性检查之后）
          await snapshotAclVersion(tx, slug, guard.principal.userId)
          await tx.run('DELETE FROM block_grants WHERE id = ? AND block_id = ?', [grantId, blockId])
          return { rev: await bumpAclRevision(tx, slug), removed }
        })
        if (!outcome) {
          h.json(404, { ok: false, error: 'not_found', message: `授权不存在: ${grantId}` })
          return
        }
        void writeAuditLog(adb, {
          action: 'acl.change',
          targetKind: 'grant',
          targetId: `${slug}#block:${blockId}:${outcome.removed.subject_kind}:${outcome.removed.subject_id}`,
          actorId: guard.principal.userId,
          before: { role: outcome.removed.role },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

        h.json(200, { ok: true, slug, blockId, removed: grantId, acl_revision: outcome.rev })
      }, { access: 'user' }),
    )

    /* ---------- 附件（本批 M1/M2/M3）：上传 / 下载 / 列表 / 删除 ---------- */
    /*
     * ## 为什么不能把 `attachments/` 挂成静态目录（这条否掉了最省事的方案）
     *
     * `packages/server/src/index.ts:969 serveStatic` 与 `:850 servePluginUiAsset` 都在
     * **路由层之外**执行：它们在 `dispatch()` 判定"无匹配路由"或走插件 UI 分支时直接写响应，
     * 完全不经过 `:251 judgeAccess`，也不触发任何 `RequestHook`。而附件的路径就是**内容哈希**
     * —— 它会出现在正文、搜索结果、访问日志与浏览器历史里，**任何拿到 URL 的人都能拼出来**。
     * 把 `attachments/` 挂成静态根 = 整体旁路页面 ACL 与块级投影，而且**不会有任何报错**。
     * 所以下载必须走一个 `public` 路由 + 处理器内的逐对象判定。
     *
     * ## 为什么 `GET` 端点必须是 `public`
     *
     * 图片是**内联子请求**（`<img src>`），匿名访客读公开页时也走它。设成 `user` 会让
     * 公开页里的图对匿名用户全部破图 —— 而"页面能读、图读不到"并不是更安全，
     * 只是坏掉。真正的判定在处理器里（见该端点的时序注释），`access` 只是粗粒度闸门。
     *
     * ## 统一响应头（T2）：四个端点**一律**发 `x-content-type-options: nosniff`
     *
     * `h.json` 只写 `content-type`、**不带** nosniff（实现见
     * `packages/server/src/index.ts:565`），而这些端点的响应体里会回显**用户可控的字符串**
     * （原始文件名、slug、id）。一旦某个中间层丢掉或改写了 `content-type`，浏览器就可能把
     * JSON 文本**猜**成 HTML 去执行 —— 而"上传的字节完全由用户控制"正是这个能力的既定前提。
     *
     * 下载端点原本只在 200/304 上带它（见下面的 `VALIDATORS`），400/404/413 这些**错误响应
     * 漏了**；故改为在**每个处理器入口处**各设置一次：node 的 `writeHead(status, headers)`
     * 会与先前 `setHeader` 的值**合并**（同名时 `writeHead` 优先），于是该端点上的全部出口
     * ——`h.json` 的每个错误分支、`sendHead` 的 200 与 304——都自动带上，不会漏。
     *
     * ⚠️ **但这只覆盖"进得来处理器"的响应**（X3 的订正，此前这段注释把话说满了）：
     * 401（`@geewiki/http` 的 `gateThenInvoke` 里 `judgeAccess` 拒绝）与 403 `csrf_rejected`
     * （`@geewiki/auth` 的前置钩子拒绝）都发生在**处理器之前**，插件入口的 `setHeader`
     * 根本轮不到执行 —— 真机实测：这两个响应的 `x-content-type-options` 曾是 **null**。
     * 所以 nosniff 与 `no-store` 各由**两层**共同负责，缺一层就漏一档：
     *   · **网关层**（`packages/server/src/index.ts` 的 `runHooks` 拒绝分支与
     *     `gateThenInvoke` 拒绝分支）→ 覆盖**未进入处理器**的拒绝（401 / 403 / 钩子拒绝）；
     *   · **插件处理器入口**（本节这四个端点）→ 覆盖进入处理器之后的**全部**出口
     *     （200 / 201 / 304 / 400 / 404 / 409 / 413 / 415 / 503）。
     * 别把这段读成"插件设了就万事大吉"：网关层的两个分支必须自己设（server 侧有注释与测试钉住）。
     *
     * ## 统一响应头（T6）：错误响应的 `cache-control` 必须是 `no-store`
     *
     * `h.json` 也**不带** `cache-control`，而 404 这类错误响应浏览器是**可以启发式缓存**的：
     * 没有显式指令时，它会按 `Last-Modified`/`Date` 猜一个新鲜期。于是"先越权拿到 404、
     * 之后获得授权仍复用那份旧 404"会表现为**授权了还是破图**，而且用户按 F5 也未必解决
     * （启发式缓存命中时连请求都不发）。错误响应的语义是"**此刻**的状态不允许"，它天然
     * **不可复用**；故与 nosniff 同一处、同一理由：在**每个处理器入口**把默认值设成
     * `no-store`，让 400/401/404/409/413/415/503 一个都不漏。
     * ⚠️ 同样的分工也适用于 `no-store`：上面那条"处理器入口"只覆盖进得来处理器的响应，
     * 网关层的 401/403 由 `packages/server/src/index.ts` 的两个拒绝分支自己设（同为 X3）。
     *
     * ⚠️ **成功分支必须显式覆盖**这层默认值（`res.setHeader` 同名后写者胜），否则成功响应
     * 也会变成 `no-store`，那会把"可复用但要回源校验"的优化一起关掉。两者的分工：
     *   · 错误（含 404 / 413 / 403 之外的全部失败）→ `no-store`：别留下任何可复用的副本；
     *   · 成功 → `private, no-cache`（下载再带 `no-transform`，因为它在传字节流）：
     *     **可以留**，但每次复用前必须回源校验（见 `VALIDATORS` 上方的长注释：要禁止的
     *     从来不是"存"，而是"不校验就复用"）。
     */

    /**
     * 幂等写入附件元数据（同页同内容只一行）。
     *
     * **为什么不是 `INSERT OR IGNORE`**：那是 SQLite 方言，PG 要写 `ON CONFLICT DO NOTHING`；
     * 而且两种写法在"被忽略"时都**不告诉我们命中的是哪一行**，仍然要再查一次。直接
     * "查 → 插"少一层方言分支，`UNIQUE (page_id, sha256)` 依旧兜住并发（下面的唯一冲突分支）。
     */
    const writeAttachmentRow = async (i: {
      pageId: number
      pageSlug: string
      sha256: string
      ext: string
      byteSize: number
      mime: string
      originalName: string
      uploaderId: number | null
      now: string
    }): Promise<{ kind: 'created' | 'dedup' | 'conflict' | 'quota'; id: number }> => {
      type RowOutcome = { kind: 'created' | 'dedup' | 'conflict' | 'quota'; id: number }
      const lookup = async (q: DatabaseExecutor): Promise<RowOutcome | null> => {
        const existing = (
          await q.query<{ id: number; ext: string }>(
            'SELECT id, ext FROM attachments WHERE page_id = ? AND sha256 = ?',
            [i.pageId, i.sha256],
          )
        )[0]
        if (!existing) return null
        /*
         * ★ 同页同内容但扩展名不一致 ⇒ 409（不是覆盖、也不是静默去重）。
         * 扩展名决定响应头（`Content-Type` 与 `Content-Disposition`），而同一份字节不可能
         * 同时是 `.png` 和 `.zip`。若静默保留第一次的扩展名，第二次上传者拿到的响应会与
         * 他上传的东西不符 —— 那是最容易演变成"用户以为传了 PDF、实际伺服成图片"的形态。
         */
        return { kind: existing.ext === i.ext ? 'dedup' : 'conflict', id: Number(existing.id) }
      }
      try {
        return await adb.transaction(async (tx): Promise<RowOutcome> => {
          const hit = await lookup(tx)
          if (hit) return hit
          /*
           * 配额在同一事务里**再判一次**（端点在读流之前已用 Content-Length 判过一次）：
           * 前置那次是为了"不浪费一次上传"，这次才是权威判据 —— 两个并发上传都通过前置检查
           * 时，只有事务内的累计值能拦住超额。
           */
          const total = Number(
            (
              await tx.query<{ n: number | string }>(
                'SELECT COALESCE(SUM(byte_size), 0) AS n FROM attachments WHERE page_id = ?',
                [i.pageId],
              )
            )[0]?.n ?? 0,
          )
          if (total + i.byteSize > attachmentPageQuotaBytes) return { kind: 'quota', id: 0 }
          const ins = await tx.run(
            `INSERT INTO attachments (page_id, page_slug, sha256, ext, byte_size, mime, original_name, uploader_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [i.pageId, i.pageSlug, i.sha256, i.ext, i.byteSize, i.mime, i.originalName, i.uploaderId, i.now],
          )
          const id = Number(ins.lastInsertRowid)
          if (!Number.isFinite(id) || id <= 0) {
            throw new Error('attachments_writer_no_rowid: 插入附件后拿不到 id（缺少 RETURNING id？）')
          }
          return { kind: 'created', id }
        })
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        /*
         * 并发下的幂等重放：另一个同内容请求刚插进去。
         * **必须在事务之外重查** —— PG 的事务一旦有语句报错就进入 aborted 状态，
         * 后续语句一律失败，"捕获后继续"在那条路上不成立（与 blocks.ts 的说明同源）。
         */
        const again = (
          await adb.query<{ id: number; ext: string }>(
            'SELECT id, ext FROM attachments WHERE page_id = ? AND sha256 = ?',
            [i.pageId, i.sha256],
          )
        )[0]
        if (!again) throw err
        return { kind: again.ext === i.ext ? 'dedup' : 'conflict', id: Number(again.id) }
      }
    }

    /** 请求头里的单个值（`content-length` 在 Node 里可能是数组，统一取第一个）。 */
    const headerValue = (h: RouteHandlerContext, name: string): string | null => {
      const raw = h.req.headers[name]
      if (typeof raw === 'string') return raw
      if (Array.isArray(raw)) return raw[0] ?? null
      return null
    }

    /* ---------- PUT /api/attachments/:slug?name=<urlencoded>：上传（裸 body） ---------- */
    /*
     * 请求体**就是文件字节**，`Content-Type` 是调用方声明的 MIME（不信任，见 `effectiveMime`）。
     * 不用 multipart 的理由写在 `attachments.ts` 的文件头（undici 的 `formData()` 会整份缓冲
     * 且没有 per-file 上限）。原始文件名经查询串的 `name` 传，**只进展示列**。
     */
    cleanups.push(
      router.register('PUT', '/api/attachments/:slug', async (h) => {
        /*
         * 本能力统一响应头（T2 + T6）：错误响应也要带 nosniff；`cache-control` 的**默认值**
         * 是 `no-store`（错误响应不可复用），成功分支会显式覆盖成 `private, no-cache`。
         * 两条的理由见本节标题下的「统一响应头（T2）」「统一响应头（T6）」。
         */
        h.res.setHeader('x-content-type-options', 'nosniff')
        h.res.setHeader('cache-control', 'no-store')
        const slug = h.params.slug ?? ''
        if (!isValidSlug(slug)) {
          h.json(400, { ok: false, error: 'invalid_slug', message: SLUG_HINT })
          return
        }
        const p = requirePrincipal(h)
        /*
         * ★ 扩展名**第一步就判**：非法类型不该消耗一次上传（更不该先把字节写进临时目录）。
         * `attachmentAllowedExt` 是"内置白名单 ∩ 配置"，只可能比内置白名单更窄。
         */
        const originalName = h.url.searchParams.get('name') ?? ''
        const ext = normalizeExt(originalName)
        if (ext === null || !attachmentAllowedExt.has(ext)) {
          /*
           * ★ 状态码是 **415 `unsupported_media_type`**（不是 400 `unsupported_ext`）。
           *
           * RFC 9110 §15.5.16 的 415 就是"**源服务器拒绝服务该请求，因为载荷的格式不被
           * 支持**"——这正是本分支的语义（扩展名不在白名单 ⇒ 我们不接受这种媒体类型），
           * 比笼统的 400 精确。而且这条口径**前端与设计文档早已按 415 写**
           * （`packages/web/src/api.ts` 的 `uploadAttachment` 注释、`docs/design/attachments.md`
           * §4.2 的错误码表与 §12.2.4 的分歧表），只有后端实现落在了 400 上——
           * 三处不一致比"选哪个码"更糟，故以 415 为准。
           *
           * 错误码同步从 `unsupported_ext` 改成 `unsupported_media_type`：调用方匹配的是
           * 这个字符串（`error` 字段），改名必须与状态码同批做，否则会出现"码和名各自对一半"。
           */
          h.json(415, {
            ok: false,
            error: 'unsupported_media_type',
            message: `不支持的附件类型：只接受 ${[...attachmentAllowedExt].join(' ')}（按文件名的最后一个扩展名判定）`,
          })
          return
        }
        /*
         * ★ 页面级判定先做，且**看不到与不能编辑都回 404**：
         * 403/404 的差别本身就是一个存在性探测接口（设计文档 §2.3 要求不泄露存在性）。
         * `canEdit` 与 `level` 都取自策略层的唯一出口（不在这里自己查 visibility）。
         */
        const access = await policy().resolvePage(p, slug)
        if (access.level === 'none' || !access.canEdit) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        const page = (await adb.query<{ id: number; slug: string }>('SELECT id, slug FROM pages WHERE slug = ?', [slug]))[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }

        /*
         * ★ **先看 `Content-Length`，缺失或超限就 413 且一个字节都不读。**
         *
         * 为什么"缺失"也要拒：没有长度就意味着只能边收边判 —— 那时已经被迫读了一大段
         * 才可能发现超限（虽然 `storeStream` 仍会封顶，但前置拒绝是**零成本**的那一层）。
         * 为什么必须在读流之前：`h.req` 是同一个 socket 上的可读流，一旦开始读，要么把
         * 它收完（可能几个 GB），要么中断连接 —— 而中断连接前我们已经无法回一个干净的
         * 413 响应体。`closeAfterResponse` 负责"请求体没读完也要让连接正确收尾"。
         */
        const lengthRaw = headerValue(h, 'content-length')
        const declared = lengthRaw !== null && /^[0-9]+$/.test(lengthRaw) ? Number(lengthRaw) : null
        if (declared === null) {
          closeAfterResponse(h)
          h.json(413, {
            ok: false,
            error: 'length_required',
            message: '上传必须带 Content-Length（本端点不接受长度未知的裸 body：上限无法前置判定）',
          })
          return
        }
        if (declared > attachmentMaxBytes) {
          closeAfterResponse(h)
          h.json(413, {
            ok: false,
            error: 'payload_too_large',
            message: `附件超过上限（${attachmentMaxBytes} 字节）`,
          })
          return
        }
        /*
         * 单页配额前置检查（用声明长度当上界；权威判定在 `writeAttachmentRow` 的事务里）。
         * 前置这一层的作用是"不为一必然失败的请求写盘"。
         */
        const usedBytes = Number(
          (
            await adb.query<{ n: number | string }>(
              'SELECT COALESCE(SUM(byte_size), 0) AS n FROM attachments WHERE page_id = ?',
              [page.id],
            )
          )[0]?.n ?? 0,
        )
        if (usedBytes + declared > attachmentPageQuotaBytes) {
          closeAfterResponse(h)
          h.json(413, {
            ok: false,
            error: 'page_quota_exceeded',
            message: `该页附件总量将超过配额（已用 ${usedBytes} / ${attachmentPageQuotaBytes} 字节）`,
          })
          return
        }

        /* 流式哈希 + 落盘（内容寻址；超限在 storeStream 内再次封顶并中断） */
        let stored: { sha256: string; byteSize: number; dedup: boolean }
        try {
          stored = await storeStream(h.req, {
            dataDir: attachmentDataRoot,
            tmpDir: attachmentTmpDir,
            maxBytes: attachmentMaxBytes,
            ext,
            /*
             * ★ 把**声明**的长度交给存储层做"实收 vs 声明"对照（X6）——理由与
             * "为什么放在 rename 之前"写在 `attachment-store.ts` 的那段长注释里。
             * 这里只强调一点：`declared` 在进入本分支前已被校验为**纯数字且 ≤ 上限**，
             * 所以它可以直接当基准，不需要在这里再兜一层。
             */
            expectedBytes: declared,
          })
        } catch (err) {
          if (err instanceof AttachmentStoreError && err.code === 'payload_too_large') {
            closeAfterResponse(h)
            h.json(413, { ok: false, error: 'payload_too_large', message: err.message })
            return
          }
          /*
           * ★ 实收字节数与声明不符 ⇒ **400 `length_mismatch`**（调用方的请求有问题，
           * 不是服务或存储的问题）。临时文件已由存储层删除，**最终路径从未被创建** ——
           * 故这里不需要（也不应该）去删任何已落盘的文件：删最终文件会误伤
           * `dedup` 场景下别页正在引用的那份内容。
           * 不 `closeAfterResponse`：走到这里说明请求体已经读完（或已断），
           * 连接状态是干净的，没必要额外关掉它。
           */
          if (err instanceof AttachmentStoreError && err.code === 'length_mismatch') {
            h.json(400, { ok: false, error: 'length_mismatch', message: err.message })
            return
          }
          /*
           * ★ 存储不可用 ⇒ **503 而不是 500**：磁盘只读/写满/无权限是**运维状态**，
           * 不是本服务故障。500 会把它计入 `stats().consecutiveFailures`，连续失败
           * 可能触发看门狗熔断 —— 于是"磁盘满了"被升级成"整站被熔断"。
           */
          if (err instanceof AttachmentStoreError && err.code === 'storage_unavailable') {
            console.warn('[@geewiki/wiki] 附件落盘失败（存储不可用）:', err.message)
            h.json(503, { ok: false, error: 'storage_unavailable', message: err.message })
            return
          }
          throw err
        }

        const mime = effectiveMime(ext, headerValue(h, 'content-type') ?? '')
        /*
         * ⚠️ 这里有一个**可接受的**中间态：字节已经落盘、而元数据行可能还没写成功
         * （配额被事务内的权威判定拦下、或并发冲突）。此时磁盘上会留下一个
         * **没有元数据指向**的文件。它不会造成越权（没有行就没有 URL），
         * 也不会被下载到（下载先查表），最终由 GC 回收（判据正是"没有任何
         * `attachments` 行指向它"，见 `0018` 的索引 `idx_attachments_sha`）。
         * 反过来（先写行、后落盘）才是不可接受的：那会留下"有 URL 但打不开"的死链。
         */
        const outcome = await writeAttachmentRow({
          pageId: Number(page.id),
          pageSlug: page.slug,
          sha256: stored.sha256,
          ext,
          byteSize: stored.byteSize,
          mime,
          originalName,
          uploaderId: p.userId ?? null,
          now: new Date().toISOString(),
        })
        if (outcome.kind === 'conflict') {
          h.json(409, {
            ok: false,
            error: 'attachment_conflict',
            message: `同一份内容在本页已按 ${ext} 收录；同一内容的扩展名不能中途改变（请先删除原附件再上传）`,
          })
          return
        }
        if (outcome.kind === 'quota') {
          h.json(413, {
            ok: false,
            error: 'page_quota_exceeded',
            message: `该页附件总量超过配额（${attachmentPageQuotaBytes} 字节）`,
          })
          return
        }
        /*
         * 审计：**只在真的新增了元数据行时写**。幂等重放（`dedup`）不重复留痕 ——
         * 与"下载不写审计"同一条理由：高频重复事件会把审计表冲垮，真正有用的信号被淹没。
         *
         * 字段名必须是 `sha256` 而**不是** `hash`：`packages/core/src/audit.ts:61` 的
         * `FORBIDDEN_AUDIT_KEYS` 含 `hash`，写进去会被 `redactForAudit` **静默删掉**。
         * 同样刻意不记 `original_name` 之外的任何内容，也不记正文。
         */
        if (outcome.kind === 'created') {
          void writeAuditLog(adb, {
            action: 'attachment.upload',
            targetKind: 'attachment',
            targetId: String(outcome.id),
            actorId: p.userId ?? null,
            actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
            after: { page: page.slug, sha256: stored.sha256, ext, byte_size: stored.byteSize, mime },
          }).catch((err: unknown) => console.error('[@geewiki/wiki] 附件上传审计写入失败:', err))
        }
        /*
         * 状态码统一 201：本端点是**幂等 PUT**，重放同一个请求得到同形状的响应，
         * "这次是否真的新建了行"由 `dedup` 表达（与 `PUT /api/pages/:slug` 用
         * `outcome` 表达 created/updated/unchanged 是同一种做法）。
         */
        // T6：成功响应**覆盖**入口那层 `no-store` —— 可以留，但每次复用前要回源校验
        h.res.setHeader('cache-control', 'private, no-cache')
        h.json(201, {
          ok: true,
          id: outcome.id,
          url: attachmentUrl(outcome.id),
          mime,
          size: stored.byteSize,
          sha256: stored.sha256,
          dedup: outcome.kind === 'dedup',
        })
      }, { access: 'user' }),
    )

    /**
     * 下载端点对外**唯一**的"附件不存在"响应（T1）。
     *
     * 越权（页面不可见 / 所在段落不可见 / 引用已从正文移除）与"这个 id 根本没有行"必须回
     * **同一个字节序列**，否则可枚举的连续整数 id 立刻变成一个"附件存在性预言机"：
     * 从 403 与 404 的差别里就能读出"这里有一个存在、但被某个受限段落挡住的附件"。
     * 这与 `getPage`（`index.ts:705-712` 的注释：不存在与无权同值）是同一条哲学。
     *
     * ⚠️ **审计不受此影响**：越权仍然照写 `access.denied`（见下面两个调用点）。
     * "对外无差别"是为了不把信息交给**请求方**；审计是内部的，它必须记下**真实原因**，
     * 否则"谁在探测、探到了什么"就查不出来了。别把"响应统一"误读成"不用记"。
     *
     * 调用方一律传**数值 id**：消息里的数字必须来自同一处，才能保证
     * "存在但越权"与"不存在"两条路径的响应体逐字节相同（e2e 有 `cmp` 级别的断言）。
     */
    const attachmentNotFound = (h: RouteHandlerContext, id: number): void => {
      h.json(404, { ok: false, error: 'not_found', message: `附件不存在: ${id}` })
    }

    /* ---------- GET /api/attachments/:id：下载（★ 判定时序是本能力最关键的安全点） ---------- */
    /*
     * ## 判定时序：页面级 → 401/404 → 块级投影 → 404 → **最后才开文件**
     *
     * 顺序不能换。反过来（先 `open` 再判权限）就是"先读盘再判权限"：任何一条提前
     * `return` 都可能已经把字节交给了响应流，而**响应头一旦发出就改不了状态码** ——
     * 于是越权者拿到的是 200 + 文件内容。`index.ts` 里 `getPage` 的注释记的正是这条教训
     * （投影必须发生在构造详情对象之前）。
     *
     * ## 判据为什么是"投影后的正文里是否含这个 URL"
     *
     * 而不是"自己重算一遍块可见性"：`granted` / `org` / 页面档位 / `expires_at` 全部由
     * `projectBlocks`（`blocks.ts:785-787` 的两条分支）唯一决定。第二套规则必然漂移，
     * 而漂移方向一旦是"放宽"，就是"正文里看不到的段落，附件却能下载"——**不会报错的泄漏**。
     * 复用投影还有一条额外好处：附件被从正文里删掉引用后，判定立即变成 404（无需任何缓存失效）。
     *
     * ## 为什么不做投影缓存
     *
     * `pages.acl_revision` 只在 ACL 变更时自增（`bumpAclRevision`，8 个调用点），而块级可见性
     * 还会随**正文编辑**（`blocks.visibility` 由标记决定）与**块级授权**（`block_grants` 的
     * `expires_at` 到点即失效）变化 —— 这些都不改 `acl_revision`。要正确缓存就得再引入一套
     * 失效键，而"撤销后仍可见的窗口"正是本仓明令禁止给判定加 TTL 缓存的原因（见 `0012` 的说明）。
     * 因此这里**每次现查**：一次块查询，代价可控，且没有陈旧窗口。
     */
    cleanups.push(
      router.register('GET', '/api/attachments/:id', async (h) => {
        /*
         * 本能力统一响应头（T2 + T6）：错误响应也要带 nosniff；`cache-control` 的**默认值**
         * 是 `no-store`（错误响应不可复用），成功分支会显式覆盖成 `private, no-cache`。
         * 两条的理由见本节标题下的「统一响应头（T2）」「统一响应头（T6）」。
         */
        h.res.setHeader('x-content-type-options', 'nosniff')
        h.res.setHeader('cache-control', 'no-store')
        const id = Number(h.params.id)
        if (!Number.isInteger(id) || id < 1) {
          h.json(404, { ok: false, error: 'not_found', message: `附件不存在: ${h.params.id}` })
          return
        }
        const p = requirePrincipal(h)
        /*
         * 联查 `pages` 取**当前** slug 与正文。判定一律用现值：
         * `attachments.page_slug` 只是"审计/排障时可读"的冗余列。已核实本仓**不存在改名路径**
         * （`savePage` 按 slug upsert、全仓无 `UPDATE pages SET slug`），故两者当前恒等；
         * 取现值是为了将来真出现改名时判定不会跟着陈旧。
         */
        const row = (
          await adb.query<AttachmentRow>(
            `SELECT a.id, a.page_id, a.sha256, a.ext, a.byte_size, a.mime, a.original_name, a.uploader_id,
                    p.slug AS live_slug, p.content AS page_content
               FROM attachments a JOIN pages p ON p.id = a.page_id
              WHERE a.id = ?`,
            [id],
          )
        )[0]
        if (!row) {
          attachmentNotFound(h, id)
          return
        }
        /* ① 页面级判定 */
        const access = await policy().resolvePage(p, row.live_slug)
        if (access.level === 'none') {
          // 页存在但无权看：对外 404（不泄露存在性），内部记一次越权尝试
          recordAccessDenied(h, row.live_slug, 'no_read_access', p)
          attachmentNotFound(h, id)
          return
        }
        /*
         * ② 可用性补丁：**上传者本人 + 有编辑权**时，可以读自己刚上传、但正文还来不及引用的附件。
         *
         * 没有它就会出现"传完刷新就破图"——上传与"把引用写进正文并保存"之间有真实的窗口
         * （上传接口不回写正文，前端保存正文是另一次请求）。
         *
         * 边界必须收紧：`uploader_id` 与主体 **user id 相等**、且该主体对**这一页**有
         * `canEdit`。于是"另一个同样能编辑该页的用户"读同一份未引用附件仍然是 404
         * （e2e 有这条负向断言）—— 补丁放宽的只是"自己上传的字节"，不是"这一页的附件"。
         */
        const ownUpload =
          access.canEdit && p.userId !== null && row.uploader_id !== null && Number(row.uploader_id) === p.userId
        /* ③ 块级判定（复用自己的正文投影判据） */
        if (!ownUpload) {
          const proj = await projectPageContentFor(adb, {
            pageId: Number(row.page_id),
            content: row.page_content,
            principal: p,
            /*
             * 授权集合与投影必须来自**同一次**策略调用（与 `getPage` 同款要求）：
             * 分别取两次会出现"判定用了一份授权、渲染用了另一份"的窗口。
             */
            grantedBlockIds: await grantedBlockIdsOf(p),
          })
          if (!proj.text.includes(attachmentUrl(Number(row.id)))) {
            /*
             * ★ T1：**与"不存在"回同一个 404**（此前是 403 `attachment_gated`）。
             *
             * 403 与 404 的差别本身就是信息：id 是连续整数、可枚举，于是"403"等于告诉任何
             * 路过的人"这个 id 存在，而且它处在一个被收紧的段落里"。这条信息对有权者毫无
             * 用处（他本来就能看），对无权者却是一次成功的侦察。要给出的唯一答案是
             * "这个 url 没有可给你的东西"，而不是"为什么没有"。
             *
             * 审计**照写**（`attachment_gated` 保留为真实原因）：对外响应无差别与内部留痕
             * 是两件事 —— 少了这条审计，"有人在逐个 id 探测受限段落"就查不出来了。
             */
            recordAccessDenied(h, row.live_slug, 'attachment_gated', p)
            attachmentNotFound(h, Number(row.id))
            return
          }
        }
        /* ④ 到这里才碰文件：先 stat（"元数据在、文件不在"是可诊断的状态，不是 500） */
        const absPath = resolveAttachmentPath(attachmentDataRoot, row.sha256, row.ext)
        let size: number
        try {
          size = (await stat(absPath)).size
        } catch {
          console.error(`[@geewiki/wiki] 附件元数据存在但文件缺失: id=${row.id} ${absPath}`)
          h.json(404, { ok: false, error: 'blob_missing', message: '附件文件缺失（元数据存在）' })
          return
        }
        if (size !== Number(row.byte_size)) {
          // 不拦（仍按实际字节伺服），但必须留痕：路径即哈希，尺寸不符意味着内容被替换过
          console.warn(
            `[@geewiki/wiki] 附件尺寸与元数据不符: id=${row.id} db=${row.byte_size} disk=${size}`,
          )
        }

        const etag = `"${row.sha256}"`
        /*
         * ★ 缓存必须是 `private`：**同一个 URL 的可见性会随 ACL 变化**，
         * 而中间缓存（CDN/共享代理）只认 URL。若给 `public`/`immutable`，
         * 一份曾被有权者取走的受限附件会被喂给下一个人 —— 浏览器之外没人再判一次权限。
         * `no-transform` 阻止代理压缩/改写字节（那会破坏 ETag 的语义）。
         *
         * ★ T2：`max-age=300` → **`no-cache`**。
         *
         * `max-age=300` 说的是"5 分钟内别再问服务端"。而本能力的判定是**逐请求现查**的
         * （块级授权可撤销、正文引用可删除、`expires_at` 到点即失效 —— 见本端点上方
         * "为什么不做投影缓存"）：本地缓存会把"撤销后立刻生效"重新变成一个 ≤5 分钟的窗口，
         * 而且更糟 —— 撤权之后浏览器**根本不再发请求**，服务端连拒绝的机会都没有。
         *
         * `no-cache` 的语义是"**每次复用前必须回源校验**"，正是这里需要的那一条：
         * 校验请求带着 `If-None-Match`，会把上面那整套判定**重跑一遍**，于是
         *   · 仍然有权 ⇒ 304（一个空响应，不重传字节：性能与 `max-age` 几乎无差）；
         *   · 已撤权 ⇒ 落到上面的 404 分支，本地那份副本随即作废。
         * 校验路径本身与本头无关（`If-None-Match` 命中就 304），此处只是把"何时允许复用"
         * 从"5 分钟内随便用"收紧成"每次都得先问一句"。
         *
         * **为什么不是 `no-store`**：`no-store` 连"留一份可复用的字节"都不允许，会让每次
         * `<img>` 加载都完整重传文件 —— 图片是页面上最高频的子请求，代价最大；而这里
         * **不需要**禁止存储：本端点是内容寻址的，`ETag` 就是 `sha256`，
         * "同一 ETag ⇒ 同一字节"恒真，304 复用不可能复用错内容。要禁止的从来不是"存"，
         * 而是"**不校验就复用**" —— 那正是 `no-cache`。一句话：`no-store` 关掉的是性能，
         * `no-cache` 关掉的才是那个窗口。
         */
        const VALIDATORS: Record<string, string | number> = {
          'cache-control': 'private, no-cache, no-transform',
          etag,
          /*
           * ★ 恒发 nosniff：没有它，浏览器可能把 `application/octet-stream` 的响应
           * **猜**成 HTML 并执行（内容嗅探），而上传的字节完全由用户控制。
           */
          'x-content-type-options': 'nosniff',
        }
        const sendHead = (status: number, headers: Record<string, string | number>): void => {
          for (const [k, v] of Object.entries(headers)) h.res.setHeader(k, v)
          // 走统一的记账出口（`h.json` 会 end，故这里只记状态码），否则该请求不计入 stats()
          h.noteStatus?.(status)
          h.res.writeHead(status)
        }
        const inm = headerValue(h, 'if-none-match')
        if (inm !== null && inm.split(',').some((t) => t.trim() === etag)) {
          /*
           * 304 **只回校验器**：表示（representation）的那几个头（`content-type` /
           * `content-disposition`）与 `content-length` 都不该出现在 304 上 ——
           * 后者是规范禁止的，前者会让"实体头"与"无实体"自相矛盾。
           */
          sendHead(304, VALIDATORS)
          h.res.end()
          return
        }
        sendHead(200, {
          ...VALIDATORS,
          'content-type': effectiveMime(row.ext, row.mime),
          'content-disposition': formatDisposition(
            dispositionKindOf(row.ext, { inlineSvg: attachmentInlineSvg }),
            row.original_name,
          ),
          'content-length': size,
        })
        await new Promise<void>((resolve) => {
          const stream = createReadStream(absPath)
          stream.on('error', (err) => {
            // 响应头已发出：改不了状态码，只能断开连接（让客户端看到截断，而不是一个 200 空体）
            console.error(`[@geewiki/wiki] 附件读取失败: id=${row.id}`, err)
            h.res.destroy()
            resolve()
          })
          h.res.on('close', () => {
            // 客户端提前断开（例如只加载了图片头部）：及时释放文件句柄
            stream.destroy()
            resolve()
          })
          stream.pipe(h.res)
          stream.on('end', () => resolve())
        })
      }),
    )

    /* ---------- GET /api/pages/:slug/attachments：该页附件清单（管理面） ---------- */
    /*
     * `access: 'public'` + **处理器内要求 `canEdit`**：清单包含"有哪些附件、谁传的、
     * 什么时候传的"，属于结构信息，普通读者不需要它（与"版本历史只对可编辑者开放"同款判据）。
     * 可见但不可编辑 ⇒ 403；连页都看不到 ⇒ 404（不泄露存在性）。
     */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/attachments', async (h) => {
        /*
         * 本能力统一响应头（T2 + T6）：错误响应也要带 nosniff；`cache-control` 的**默认值**
         * 是 `no-store`（错误响应不可复用），成功分支会显式覆盖成 `private, no-cache`。
         * 两条的理由见本节标题下的「统一响应头（T2）」「统一响应头（T6）」。
         */
        h.res.setHeader('x-content-type-options', 'nosniff')
        h.res.setHeader('cache-control', 'no-store')
        const slug = h.params.slug ?? ''
        if (!isValidSlug(slug)) {
          h.json(400, { ok: false, error: 'invalid_slug', message: SLUG_HINT })
          return
        }
        const p = requirePrincipal(h)
        const access = await policy().resolvePage(p, slug)
        if (access.level === 'none') {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        if (!access.canEdit) {
          h.json(403, { ok: false, error: 'forbidden', message: '没有编辑该条目的权限，附件清单不对外提供' })
          return
        }
        const page = (await adb.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        const rows = await adb.query<{
          id: number
          sha256: string
          ext: string
          byte_size: number
          mime: string
          original_name: string
          uploader_id: number | null
          created_at: string
        }>(
          `SELECT id, sha256, ext, byte_size, mime, original_name, uploader_id, created_at
             FROM attachments WHERE page_id = ? ORDER BY id DESC`,
          [page.id],
        )
        // T6：成功响应覆盖入口的 `no-store`（同上；这里没有字节流，故不需要 no-transform）
        h.res.setHeader('cache-control', 'private, no-cache')
        h.json(200, {
          ok: true,
          slug,
          attachments: rows.map((r) => ({
            id: Number(r.id),
            name: r.original_name,
            url: attachmentUrl(Number(r.id)),
            ext: r.ext,
            mime: r.mime,
            size: Number(r.byte_size),
            sha256: r.sha256,
            uploaderId: r.uploader_id === null ? null : Number(r.uploader_id),
            createdAt: r.created_at,
          })),
        })
      }),
    )

    /* ---------- DELETE /api/attachments/:id：删元数据（磁盘文件留给 GC） ---------- */
    /*
     * ★ **只删 `attachments` 行，不删磁盘文件**：落盘路径是**内容寻址**的，同一份字节
     * 可能被他页（乃至同页的另一条记录）共享 —— 在删除时顺手 `unlink` 会让别处正在引用的
     * 附件变成破图，而且这种损坏是**跨页**的、极难归因。回收由 GC 负责：扫描磁盘、
     * 删掉"没有任何元数据行指向"的文件（本批不做，属后续工作）。
     *
     * 权限：`canEdit` **或** 上传者本人（本人删自己传错的附件不该需要额外权限）。
     */
    cleanups.push(
      router.register('DELETE', '/api/attachments/:id', async (h) => {
        /*
         * 本能力统一响应头（T2 + T6）：错误响应也要带 nosniff；`cache-control` 的**默认值**
         * 是 `no-store`（错误响应不可复用），成功分支会显式覆盖成 `private, no-cache`。
         * 两条的理由见本节标题下的「统一响应头（T2）」「统一响应头（T6）」。
         */
        h.res.setHeader('x-content-type-options', 'nosniff')
        h.res.setHeader('cache-control', 'no-store')
        const id = Number(h.params.id)
        if (!Number.isInteger(id) || id < 1) {
          h.json(400, { ok: false, error: 'invalid_id', message: 'id 须为正整数' })
          return
        }
        const p = requirePrincipal(h)
        /*
         * 选列里带上 `sha256` / `ext` / `byte_size`：**审计要用**（删掉之后这两列在库里
         * 就没有了 —— 审计是这条记录唯一的去处）。刻意不选 `original_name`：
         * 展示名由上传者完全控制，而审计条目会被导出、被别的系统消费，
         * 让"用户可控的任意字符串"进入审计正文没有收益（`target_id` 已经能唯一定位）。
         */
        const row = (
          await adb.query<{
            id: number
            uploader_id: number | null
            live_slug: string
            sha256: string
            ext: string
            byte_size: number
          }>(
            `SELECT a.id, a.uploader_id, a.sha256, a.ext, a.byte_size, p.slug AS live_slug
               FROM attachments a JOIN pages p ON p.id = a.page_id
              WHERE a.id = ?`,
            [id],
          )
        )[0]
        if (!row) {
          attachmentNotFound(h, id)
          return
        }
        const access = await policy().resolvePage(p, row.live_slug)
        if (access.level === 'none') {
          // 页存在但无权看：对外 404（不泄露存在性），内部记一次越权尝试
          recordAccessDenied(h, row.live_slug, 'no_read_access', p)
          attachmentNotFound(h, id)
          return
        }
        const isUploader = p.userId !== null && row.uploader_id !== null && Number(row.uploader_id) === p.userId
        if (!access.canEdit && !isUploader) {
          /*
           * ★ T5：**与下载端点完全同口径** —— 越权删除一律回同一个 `attachmentNotFound` 信封
           * （此前是 403 `forbidden`）。
           *
           * 为什么必须统一：附件 id 是**可枚举的连续整数**，而"可见但删不动"与"根本不存在"
           * 若给出不同状态码，任何能看见该页的人都能把 id 从 1 逐个试上去，靠 403 与 404 的
           * 差别列出"这一页有哪些附件、哪些是别人传的"。这条信息对有权者毫无用处，对探测者
           * 却是一次完整的侦察；要给出的唯一答案是"这个 url 没有可给你的东西"。
           * 响应体也必须逐字节相同 —— `attachmentNotFound` 只回数值 id，不带任何标识字段
           * （e2e 有 `cmp` 级别的断言）。
           *
           * ⚠️ **审计照写**（`no_edit_access` 是真实原因）：对外无差别是为了不把信息交给
           * **请求方**，审计是内部的，它必须记下真实原因，否则"谁在逐个 id 试探删除权限"
           * 就查不出来了 —— 别把"响应统一"误读成"不用记"（同下载端点 `attachment_gated` 的精神）。
           */
          recordAccessDenied(h, row.live_slug, 'no_edit_access', p)
          attachmentNotFound(h, id)
          return
        }
        await adb.run('DELETE FROM attachments WHERE id = ?', [id])
        /*
         * ★ 审计：**成功的删除必须留痕**（X5）。
         *
         * 此前只有上传写审计、删除什么都不写 —— 而删除是**破坏性**动作：
         * 它是"这份附件为什么不见了"的唯一答案，也是"谁在批量清空某一页的附件"的唯一线索。
         * 只记成功不记拒绝是**刻意**的：拒绝路径已经在文件里 `recordAccessDenied(...)`
         * 写了 `access.denied`（那是安全事件），这里补的是"合规记录"这一半。
         *
         * 与上传同款的两条纪律：
         *   ① 字段名是 `sha256`、**不是** `hash` —— `packages/core/src/audit.ts` 的
         *      `FORBIDDEN_AUDIT_KEYS` 含 `hash`，写了会被 `redactForAudit` **静默删掉**；
         *   ② 不记正文、不记磁盘绝对路径（路径由 sha 推出，记了只是把服务器布局抄进审计）。
         * `id` 同时出现在 `targetId`（审计表的一等列）与 `after` 里：前者可被索引与按 id 过滤，
         * 后者让这条 JSON **自解释**（导出/迁库后单看 `after` 就知道删的是哪一个）。
         * 写入失败**不让删除失败**：行已经删掉了，回滚审计等于把"已发生的事实"藏起来；
         * 故与上传同款 `void … .catch(console.error)`。
         */
        void writeAuditLog(adb, {
          action: 'attachment.delete',
          targetKind: 'attachment',
          targetId: String(id),
          actorId: p.userId ?? null,
          actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
          after: {
            id,
            page_slug: row.live_slug,
            sha256: row.sha256,
            ext: row.ext,
            size: Number(row.byte_size),
          },
        }).catch((err: unknown) => console.error('[@geewiki/wiki] 附件删除审计写入失败:', err))
        // T6：成功响应覆盖入口的 `no-store`
        h.res.setHeader('cache-control', 'private, no-cache')
        h.json(200, { ok: true, deleted: id })
      }, { access: 'user' }),
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
      router.register('GET', '/api/pages/:slug/backlinks', async (h) => {
        const slug = h.params.slug ?? ''
        /*
         * ★ 两重检查，缺一不可：
         *   1. 目标页**存在** —— 不存在时 404 才能与"存在但没人链接"区分开；
         *   2. 目标页**对该主体可见** —— 只看存在性的话，`/api/pages/<受限slug>/backlinks`
         *      的 200/404 就成了一个匿名可用的**存在性探测接口**（真机端到端验收时抓到）。
         * 注意第 2 条与 `pageExists` 是两件事：前者是权限，后者是数据。
         */
        const p = requirePrincipal(h)
        const target = await policy().resolvePage(p, slug)
        // ★ P4：先取存在性（原先靠 `||` 短路跳过这一步）—— 它是区分"不存在"与"越权尝试"的唯一依据
        const exists = await pageExists(slug)
        if (target.level === 'none' || !exists) {
          if (exists) recordAccessDenied(h, slug, 'no_read_access', p)
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, slug, backlinks: await listBacklinks(slug, p) })
      }),
    )

    /* ---------- GET /api/pages/:slug/links：本页指向了谁（出链） ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/links', async (h) => {
        const slug = h.params.slug ?? ''
        // 与 backlinks 同理：目标页不可见时一律 404，不给出存在性差异
        const p = requirePrincipal(h)
        const target = await policy().resolvePage(p, slug)
        // 与 backlinks 同理：先取存在性，再区分"不存在"与"越权尝试"
        const exists = await pageExists(slug)
        if (target.level === 'none' || !exists) {
          if (exists) recordAccessDenied(h, slug, 'no_read_access', p)
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
        h.json(200, { ok: true, slug, links: await listOutlinks(slug, p) })
      }),
    )

    /* ---------- GET /api/admin/blocks/verify：块与正文的双写一致性探针 ---------- */
    /*
     * 设计文档 §8.2 的 P3a 验收第 3 条（编排者裁定：该端点从 P4 提前到 P3a —— 没有它
     * 就无法验收 P3a 自身）。
     *
     * ## 它为什么必须存在
     *
     * P3a 把块索引的同步保证从"数据库触发器"换成了"**应用层纪律**"（`blocks_fts` 是
     * contentless 表，且写入前要算 `tier`，那不是触发器能表达的 SQL）。纪律没有编译期
     * 约束，所以必须有探针兜底：**任何绕过 `syncBlocksForPage` 的写入路径都会在这里
     * 以非零 `mismatched` 显式报出**，而不是静默地让检索少召回或让遮蔽失效。
     *
     * ## 比对两件事，任一不符即计入 `mismatched`
     *
     *   1. `pages.content_hash` 是否等于 `sha256Hex(pages.content)`（正文自身的自洽性）
     *   2. `blocks` 行是否与**重新解析 `pages.content` 的结果**逐字段一致
     *      （`ordinal` / `kind` / `text` / `visibility` / `inherit` / `marker` / `content_hash`）
     *
     * ## 为什么"不可解析"单独计数而不算漂移
     *
     * 遗留正文里的旧标记（`<!--gated:role=editor-->`）会让 `parseBlocks` 抛
     * `BlockParseError`。那是**内容问题**（作者需要改文档），不是"双写漂移"问题。
     * 混进 `mismatched` 会让这个探针失去"**应恒为 0**"这个可断言的语义 —— 而一个
     * "平时就非零"的探针等于没有探针。故它单列 `unparseable` 并在 `samples` 里点名。
     *
     * 返回里带 `samples`（最多 10 条 slug + 原因）是为了**可排障**：只有计数的话，
     * 拿到 `mismatched: 3` 的人无从下手。它是 admin 端点，slug 不算敏感。
     */
    cleanups.push(
      router.register(
        'GET',
        '/api/admin/blocks/verify',
        async (h) => {
          const principal = h.principal
          if (!principal) {
            h.json(401, { ok: false, error: 'unauthorized', message: '缺少主体信息' })
            return
          }

          /*
           * 分批扫描（keyset 分页），不把整库正文读进内存 —— 大库上这条端点也要能跑完。
           * 每批只发两条查询：取该批页面、取该批页面的全部块。
           */
          const BATCH = 500
          const MAX_SAMPLES = 10
          let cursor = 0
          let checked = 0
          let mismatched = 0
          let unparseable = 0
          let tierMismatched = 0
          let tierChecked = 0
          const samples: { slug: string; reason: string }[] = []
          // tier 的样本**单独一份**：两类不一致必须各自可数、可看，混在一份里就分不出
          // "块与正文漂移"和"tier 算错"了 —— 而这两者的修法完全不同。
          const tierSamples: { slug: string; reason: string }[] = []

          /*
           * tier 检查需要页面**有效档位**（含祖先交集与发布闸门），那只在策略层算得出来。
           * 策略服务缺席时跳过这一项并如实标出 —— 而不是把"算不了"报成"不一致"。
           */
          const policyReady = Boolean(
            (ctx.get('policy-service') as PolicyServiceLike | undefined)?.effectiveIndexLevel,
          )

          for (;;) {
            const pages = await adb.query<{
              id: number
              slug: string
              content: string
              content_hash: string | null
            }>('SELECT id, slug, content, content_hash FROM pages WHERE id > ? ORDER BY id LIMIT ?', [
              cursor,
              BATCH,
            ])
            if (pages.length === 0) break
            const last = pages[pages.length - 1]
            if (!last) break
            cursor = last.id
            checked += pages.length

            const ids = pages.map((p) => p.id)
            const placeholders = ids.map(() => '?').join(', ')
            const rows = await adb.query<{
              page_id: number
              ordinal: number
              kind: string
              text: string
              visibility: string
              inherit: number | boolean
              marker: string | null
              content_hash: string
              tier: number | null
            }>(
              `SELECT page_id, ordinal, kind, text, visibility, inherit, marker, content_hash, tier
                 FROM blocks WHERE page_id IN (${placeholders}) ORDER BY page_id, ordinal`,
              ids,
            )
            const byPage = new Map<number, typeof rows>()
            for (const r of rows) {
              const bucket = byPage.get(r.page_id)
              if (bucket) bucket.push(r)
              else byPage.set(r.page_id, [r])
            }

            for (const p of pages) {
              const reasons: string[] = []
              if (p.content_hash !== sha256Hex(p.content)) reasons.push('content_hash 与正文不符')

              let expected: ParsedBlock[]
              try {
                expected = parseBlocks(p.content)
              } catch (err) {
                unparseable += 1
                if (samples.length < MAX_SAMPLES) {
                  samples.push({
                    slug: p.slug,
                    reason: `正文不可解析: ${err instanceof Error ? err.message : String(err)}`,
                  })
                }
                continue
              }

              const stored = byPage.get(p.id) ?? []
              if (stored.length !== expected.length) {
                reasons.push(`块数不符（库 ${stored.length} / 解析 ${expected.length}）`)
              } else {
                for (let i = 0; i < expected.length; i += 1) {
                  const e = expected[i]
                  const s = stored[i]
                  if (!e || !s) break
                  const same =
                    s.ordinal === e.ordinal &&
                    s.kind === e.kind &&
                    s.text === e.text &&
                    s.visibility === e.visibility &&
                    Number(s.inherit) === (e.inherit ? 1 : 0) &&
                    (s.marker ?? null) === (e.marker ?? null) &&
                    s.content_hash === e.contentHash
                  if (!same) {
                    reasons.push(`第 ${i} 个块与正文不符`)
                    break
                  }
                }
              }

              /*
               * ★ tier 一致性检查。
               *
               * 上面两项只比"块 ↔ 正文"，**完全看不到 `tier`** —— 而 `tier` 是检索的
               * 唯一依据。`tier` 算错（或不重算）时，块与正文可以完全一致而检索结果
               * 是错的。这个缺陷真实发生过：改页面可见性后 `tier` 不重算，
               * 于是"public → org 的收紧"在检索里不生效 ⇒ **匿名能搜到并拿到正文片段**，
               * 而同刻读路径是 404。故它是本探针不可省的一项。
               */
              if (policyReady) {
                const level = await pageLevelOf(p.slug)
                for (const s of stored) {
                  tierChecked += 1
                  const want = tierFor(level, s.visibility as BlockVisibility)
                  if ((s.tier ?? null) !== (want ?? null)) {
                    tierMismatched += 1
                    if (tierSamples.length < MAX_SAMPLES) {
                      tierSamples.push({
                        slug: p.slug,
                        reason: `块 ordinal=${s.ordinal} 的 tier 不符（库 ${String(s.tier)} / 应为 ${String(want)}）`,
                      })
                    }
                    break
                  }
                }
              }

              if (reasons.length > 0) {
                mismatched += 1
                if (samples.length < MAX_SAMPLES) samples.push({ slug: p.slug, reason: reasons.join('；') })
              }
            }

            if (pages.length < BATCH) break
          }

          // 审计：只记计数，**不含正文**（`redactForAudit` 还有一道兜底）
          void writeAuditLog(adb, {
            action: 'admin.verify_blocks',
            targetKind: 'system',
            targetId: 'blocks',
            actorId: principal.userId,
            after: { checked, mismatched, unparseable, tierMismatched, tierChecked },
          }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

          h.json(200, {
            ok: true,
            checked,
            mismatched,
            unparseable,
            // 独立的两个计数：`mismatched` 是"块 ↔ 正文"漂移，`tierMismatched` 是
            // "tier ↔ 有效档位"不符。两者**必须都为 0**，且**互不包含** ——
            // 混成一个数就看不出是哪一类，而这两类的修法完全不同。
            tier_checked: tierChecked,
            tier_mismatched: tierMismatched,
            tier_check_skipped: !policyReady,
            samples,
            tier_samples: tierSamples,
          })
        },
        { access: 'admin' },
      ),
    )

    /* ---------- POST /api/admin/blocks/resync：把 tier 重算回一致（修复入口） ---------- */
    /*
     * 与上面的 `blocks/verify` 是一对：**verify 是探针（只报警），本端点是修复入口**。
     *
     * ## 为什么必须有它（审查标出的合并条件）
     *
     * 扇出（`resyncDescendantTiers`）在**事务提交之后**执行，这是技术必需 ——
     * `pageLevelOf` 走策略层的另一条连接，PG 的 MVCC 下看不到本事务未提交的行
     * （见 `resyncDescendantTiers` 的注释）。代价是那里有一个**毫秒级窗口**：
     * 若进程恰在"档位已提交、扇出未跑完"之间崩溃，或扇出抛错，子孙的 `tier` 就会
     * **永久陈旧** —— 读路径 404 而检索仍命中并吐出正文片段。
     *
     * 那种状态下探针会报 `tier_mismatched > 0`，但**光有报警修不好它**：
     * 回填只处理"还没有块行"的页，`plugin-search` 的索引重建只从 `blocks` 抄文本、
     * 不重算 `tier`，而扇出只覆盖"刚被改动的那个祖先的子树"。
     * 本端点就是缺的那个入口，两者合起来才构成"报警 → 修复 → 归零"的闭环。
     *
     * ## 用法
     *
     *   POST /api/admin/blocks/resync               全库重算
     *   POST /api/admin/blocks/resync?prefix=a/b    只重算某子树（按 slug 前缀）
     *
     * ## 为什么复用 `applyTierToPageBlocks` 而不是在 SQL 里重写
     *
     * `tier` 的语义（"页面压上限、块只能更窄"、`granted ⇒ NULL`）**只有一处真源**
     * （`tierFor`）。在 SQL 里再写一份必然漂移，而漂移的后果正是检索的可见性判定错误
     * —— 那恰恰是本端点要修的东西，不能自己再造一个第二真源。
     *
     * ## 幂等与分批
     *
     * `tier` 是"页面有效档位 × 块自身档位"的**纯函数**，故重复跑结果一致。
     * 扫描按 keyset 分批（每批独立事务），单页失败**不中断整体**：
     * 计入 `failed` 并留样本 —— 否则"某几页有问题"与"整个跑不动"不可区分。
     *
     * ## 已知代价
     *
     * 前缀筛选在 JS 侧做（原因同 `resyncDescendantTiers`：slug 允许 `_`，LIKE 需 ESCAPE），
     * 所以带 `prefix` 时**仍然全表扫描**，只是只对匹配的页做写。库很大时应分批调用。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/admin/blocks/resync',
        async (h) => {
          const principal = h.principal
          if (!principal) {
            h.json(401, { ok: false, error: 'unauthorized', message: '缺少主体信息' })
            return
          }

          /*
           * `tier` 只能由策略层算出来。策略服务缺席时**显式失败**，而不是"重算成 0 个"
           * —— 后者会被读成"已经一致了"，把一个"算不了"伪装成"没问题"。
           */
          const policyReady = Boolean(
            (ctx.get('policy-service') as PolicyServiceLike | undefined)?.effectiveIndexLevel,
          )
          if (!policyReady) {
            h.json(503, {
              ok: false,
              error: 'policy_unavailable',
              message: 'policy-service 不可用，无法计算页面有效档位（重算未执行）',
            })
            return
          }

          // 归一：去首尾空白与**尾部斜杠**，使 `?prefix=a/b` 与 `?prefix=a/b/` 等价。
          const prefix = (h.url.searchParams.get('prefix') ?? '').trim().replace(/\/+$/, '')
          const subtreeOnly = prefix.length > 0
          // 与 `resyncDescendantTiers` 同一口径：`a/b` 的子树是 `a/b/...`，**不含 `a/b` 自身**
          const childPrefix = `${prefix}/`

          const BATCH = 500
          const MAX_SAMPLES = 10
          let pages = 0
          let blocks = 0
          let failed = 0
          const samples: { slug: string; reason: string }[] = []
          let cursor = 0

          for (;;) {
            const rows = await adb.query<{ id: number; slug: string }>(
              'SELECT id, slug FROM pages WHERE id > ? ORDER BY id LIMIT ?',
              [cursor, BATCH],
            )
            if (rows.length === 0) break
            cursor = rows[rows.length - 1]!.id
            const targets = subtreeOnly ? rows.filter((r) => r.slug.startsWith(childPrefix)) : rows

            for (const p of targets) {
              pages += 1
              try {
                const level = await pageLevelOf(p.slug)
                blocks += await adb.transaction((tx) => applyTierToPageBlocks(tx, p.id, level))
              } catch (err) {
                failed += 1
                if (samples.length < MAX_SAMPLES) {
                  samples.push({
                    slug: p.slug,
                    reason: err instanceof Error ? err.message : String(err),
                  })
                }
              }
            }

            if (rows.length < BATCH) break
          }

          // 审计：只记计数与样本，**不含正文**（`redactForAudit` 还有一道兜底）
          void writeAuditLog(adb, {
            action: 'admin.resync_tiers',
            targetKind: 'system',
            targetId: subtreeOnly ? prefix : 'blocks',
            actorId: principal.userId,
            after: { prefix: subtreeOnly ? prefix : null, pages, blocks, failed },
          }).catch((err: unknown) => console.error('[@geewiki/wiki] 审计写入失败:', err))

          h.json(200, {
            ok: true,
            // 回显实际生效的筛选范围，让调用方能确认"我确实只重算了这一棵子树"
            subtree: subtreeOnly ? prefix : null,
            pages,
            blocks,
            failed,
            samples,
          })
        },
        { access: 'admin' },
      ),
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
