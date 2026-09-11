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
import {
  asAsync,
  closeAfterResponse,
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
  BlockParseError,
  parseBlocks,
  projectBlocks,
  sha256Hex,
  syncBlocksForPage,
  tierFor,
  type BlockTier,
  type BlockVisibility,
  type ParsedBlock,
  type PageLevel,
  type ReaderTier,
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
 * 三条要点，每条都对应一个具体的失败模式：
 *
 * 1. **优先读 `blocks` 表**（P3a 起由 `syncBlocksForPage` 在写入事务里维护）。
 * 2. **`blocks` 为空时现场解析 `pages.content`** —— P3a 之前保存的历史页面没有块行，
 *    若此时直接返回 `page.content`，那些页面里可能存在的受限区段就会被**原样吐出**。
 *    **读路径不能依赖"写入路径已经跑过"**：那是可被绕过的假设（旧数据、直接改库、
 *    迁移未回填都能让它不成立），而它一旦不成立就是泄漏。
 * 3. **读者等级只看组织角色**：匿名 = `0`，有组织角色 = `1`。`granted` 档由
 *    `projectBlocks` 判为永不命中（授权分支 `block_grants` 属 P3b）—— 失败关闭。
 *
 * 与检索的分工：`blocks.tier` 管"搜不搜得到"，这里管"读不读得到"；两者共用
 * `blockLevelOf` 的判据，写反方向会让"搜不到但读得到"成为泄漏。
 */
async function projectPageContent(
  db: { query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> },
  args: { pageId: number; content: string; principal: Principal; grantedBlockIds?: readonly number[] },
): Promise<{ text: string; gatedCount: number }> {
  /*
   * ★ P3b：**必须把 `id` 一起取出来**。授权分支是拿块 id 去查的
   * （`block_grants.block_id`），少了这一列，被授予的 `granted` 块会**对授权者也
   * 不可见** —— 症状是"授权明明写进去了却看不到"，而且不报任何错。
   */
  const rows = await db.query<{ id: number; ordinal: number; text: string; visibility: string }>(
    'SELECT id, ordinal, text, visibility FROM blocks WHERE page_id = ? ORDER BY ordinal',
    [args.pageId],
  )
  const blocks =
    rows.length > 0
      ? rows.map((r) => ({
          // 块 id 必须原样带过去 —— 它是授权分支唯一的键
          id: Number(r.id),
          ordinal: r.ordinal,
          text: r.text,
          visibility: r.visibility as BlockVisibility,
        }))
      : /*
         * 现场解析的降级路径：**没有块 id** ⇒ 授权分支必然落空
         * （见 `ProjectableBlock.id` 的说明 —— 拿会漂移的 ordinal 去查权限表是错的）。
         * 也就是说，**P3a 之前保存、且尚未被回填的历史页面里，`granted` 块对被授权者
         * 也不可见**，直到该页被重新保存为止。方向是失败关闭。
         */
        parseBlocks(args.content)
  const anonymous = args.principal.kind === 'anonymous'
  const tier: ReaderTier = anonymous ? 0 : 1
  return projectBlocks(blocks, {
    tier,
    anonymous,
    grantedBlockIds: args.grantedBlockIds ?? [],
  })
}

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
        await adb.query<PageRow>(
          `SELECT p.id, p.slug, p.title, p.created_at, p.updated_at,
                  (SELECT COUNT(*) FROM page_versions v WHERE v.page_id = p.id) AS version_count
             FROM pages p ORDER BY p.updated_at DESC, p.id DESC`,
        )
      )
        .filter((r) => visible.has(r.slug))
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          updated_at: r.updated_at,
          version: Number((r as unknown as { version_count: number }).version_count) + 1,
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
      const projectedContent = await projectPageContent(adb, {
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
      const versions = await adb.query<{ id: number; saved_at: string }>(
        `SELECT id, saved_at FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT ?`,
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
        versions: versions.map((v) => ({ id: v.id, saved_at: v.saved_at })),
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
    const savePage = async (slug: string, input: WikiSaveInput): Promise<WikiSaveResult> => {
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
            syncIndex: blocksIndexSupported,
          })
          await rebuildLinks(tx, slug, input.content)
          return 'created'
        }
        // 幂等保存：标题与正文均未变化 → 不更新 updated_at、不写历史
        if (existing.title === input.title && existing.content === input.content) return 'unchanged'
        // 快照旧正文到版本历史，再更新页面
        await tx.run('INSERT INTO page_versions (page_id, content, saved_at) VALUES (?, ?, ?)', [
          existing.id,
          existing.content,
          now,
        ])
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
    const deletePage = async (slug: string): Promise<boolean> => {
      const deleted = await adb.transaction(async (tx) => {
        const page = (await tx.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
        if (!page) return false
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
        return true
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
        return deletePage(slug)
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
        const page = await getPage(h.params.slug ?? '', requirePrincipal(h))
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        h.json(200, page)
      }),
    )

    /* ---------- GET /api/pages/:slug/versions/:id：读取历史版本正文 ---------- */
    cleanups.push(
      router.register('GET', '/api/pages/:slug/versions/:id', async (h) => {
        const page = (await adb.query<PageRow>('SELECT id FROM pages WHERE slug = ?', [h.params.slug]))[0]
        if (!page) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${h.params.slug}` })
          return
        }
        const version = (
          await adb.query<{ id: number; content: string; saved_at: string }>(
            'SELECT id, content, saved_at FROM page_versions WHERE id = ? AND page_id = ?',
            [Number(h.params.id), page.id],
          )
        )[0]
        if (!version) {
          h.json(404, { ok: false, error: 'not_found', message: `版本不存在: ${h.params.id}` })
          return
        }
        h.json(200, { id: version.id, content: version.content, saved_at: version.saved_at })
      }),
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
          result = await savePage(slug, save)
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
    cleanups.push(
      router.register('DELETE', '/api/pages/:slug', async (h) => {
        const slug = h.params.slug ?? ''
        if (!(await deletePage(slug))) {
          h.json(404, { ok: false, error: 'not_found', message: `页面不存在: ${slug}` })
          return
        }
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
     *    策略层据此做代际失效；**绝不用 TTL**（TTL 必然产生"撤销后仍可见"的窗口）。
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
        if (target.level === 'none' || !(await pageExists(slug))) {
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
        if (target.level === 'none' || !(await pageExists(slug))) {
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
