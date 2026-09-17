/**
 * **服务契约**（`ctx.provide` / `ctx.get` 的跨包类型）的单一真源。
 *
 * 为什么这个文件存在 —— 「语义倒挂」：
 * 服务契约原先声明在**实现它的插件包**里（`@geewiki/plugin-search` 里的 `SearchService`、
 * `@geewiki/plugin-auth` 里的 `AuthService`、…）。后果是：**想替换某个服务的插件，
 * 必须先依赖被它替换的那个包**（只为了拿到接口类型）。替换者依赖被替换者，语义正好反了 ——
 * 而且这让"删掉实现包"变成一个会震碎所有替换者的动作，与"万物皆插件"直接冲突。
 *
 * 所以契约搬到这里：`@geewiki/core` 是**被所有人依赖、自己不依赖业务**的那一层，
 * 与 `DatabaseAdapter` / `HttpRouterService` / `SlotService` 同处一地（它们本来就在 core）。
 *
 * **与 `slots.ts` 的区别（别搞混）**：
 * - `slots.ts` 是**浏览器安全**的（零 node/cordis 依赖），因为前端要 `import type` 它；
 * - 本文件**不是**（`AuthService` 要 `IncomingMessage` 等 node 类型），只服务后端。
 *   前端**不要**从这里取类型 —— core 的根 `index.ts` 在 web 的 tsconfig（DOM lib）下会炸
 *   （cordis 的全局 `Context` 与 DOM 撞名，详见 `docs/review/plugin-freedom-audit.md` §0.5）。
 *
 * 实现包的既有导出**保持可用**：它们改为从本文件 `export type` 转出，故既有 import 不破。
 */
import type { Principal } from './index.js'
import type { IncomingMessage } from 'node:http'
import type { Readable } from 'node:stream'
import type { CapabilityName, CapabilitySet } from './domain.js'

/* ============================ search-service ============================ */

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
   * 也正是从这些块的文本里取的（见 `snippetFor`）。**这里只可能出现可见块**：
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
 * `search-service` 服务契约（实现方经 `ctx.provide('search-service', svc)` 提供）。
 *
 * 存在的意义：让消费方（AI/RAG 插件）**不必**知道检索插件内部怎么建索引、
 * 也不必直接 `SELECT` wiki 的 `pages` 表（那会把表结构变成跨包隐式契约）。
 *
 * ★ P2：**两个方法都显式要求 `principal` 且改为异步**（设计文档 §9 R2）。
 * 为什么必须显式传主体：cordis 服务是进程级单例，把主体藏在服务内部等于让
 * "忘了传"变成"按上一个人的权限返回"。故 principal 是**必填首参**——
 * 漏传在编译期即报错，运行期再兜一道。
 *
 * 为什么从同步改成异步：可见性判定要走 `policy-service`（`visibleSlugs` 是异步的，
 * 它可能要查祖先链）。这是 P2 的**破坏性契约变更**，消费方（`@geewiki/ai-qa`）已同步跟进。
 *
 * ★ F3：契约已从 `@geewiki/plugin-search` **下沉到本文件** —— 替换检索实现的插件
 * 现在只需依赖 `@geewiki/core`，不必依赖它要替换的那个包。
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

/** 一次检索的查询语义：`phrase` = 整串字面短语（默认，向后兼容）；`terms` = 词元 OR（问句检索） */
export type SearchMode = 'phrase' | 'terms'

/* ============================ auth-service ============================ */

/** 对外可见的用户信息（**不含**任何凭据字段） */
export interface AuthUser {
  id: number
  email: string
  displayName: string
  orgId: number
  /**
   * 组织角色，**唯一来源是 `org_members` 表**（见 `resolveOrgRole`）。
   * `null` = guest（**没有**组织角色，不是最低档角色）—— 设计文档 §2.1。
   * 它**只用于能力判定**，不参与"能看哪条内容"的判定（§2.0 两条正交的轴）。
   */
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  emailVerified: boolean
  createdAt: string
  lastSeenAt: string | null
}

/**
 * `authenticateOidc` 的裁决结果（设计文档 §7.2 那张表）。
 *
 * 每个分支都对应一个明确的 HTTP 语义，由**调用方**（`@geewiki/oidc` 的回跳路由）翻译：
 * 本包不认识 HTTP，保持可测。
 */
export type OidcAuthOutcome =
  /** 身份已绑定（或按策略新建并绑定）⇒ 已建会话；`setCookie` 可直接写进响应头 */
  | { kind: 'login'; user: AuthUser; setCookie: string; expiresAt: string }
  /**
   * `(issuer,sub)` 未绑定，但该 email 已有本地账号 ⇒ **绝不自动合并**。
   * `ticket` 是 bearer 凭据，**只能经 HttpOnly cookie 交付**，不得出现在 URL / 响应体里。
   */
  | { kind: 'link_required'; ticket: string; email: string; expiresAt: string }
  /** `invite_only` 且无未消费邀请 */
  | { kind: 'no_invitation'; email: string | null }
  /** 其它拒绝（`off` / 域名不允许 / 账号停用 / 声明不合法） */
  | { kind: 'denied'; reason: string; email: string | null }

export interface AuthService {
  /**
   * 是否存在**任何可用的凭据来源**（存在可登录账号，或将来接入的 OIDC 通道）。
   *
   * **必须同步返回**：消费方是 `judgeAccess`（纯函数），用于区分
   * 503 `bootstrap_required`（根本没东西可登录）与 401 `unauthorized`（请去登录）。
   * 实现是进程内缓存的布尔值（激活时查一次，setup / 口令变更后就地更新）。
   */
  hasCredentialSource(): boolean
  /** 解析原始会话令牌（cookie 值）→ 用户；无效 / 过期 / 已吊销 / 账号停用一律 `undefined` */
  resolveSession(rawToken: string): Promise<AuthUser | undefined>
  /**
   * 注册一个 OIDC provider（由 `@geewiki/oidc` 调用）。返回注销函数。
   *
   * 同 id 重复注册**抛错**而非静默覆盖 —— 两个 adapter 抢同一个 id 是需要被看见的配置冲突
   * （与 `llm-service` 的路由注册表同一裁决）。
   */
  registerOidcProvider(provider: OidcProvider): () => void
  /** 当前已注册的 provider 快照（供 `capabilities` 下发；已停用的返回空数组） */
  listOidcProviders(): readonly OidcProviderInfo[]
  /**
   * 用**已验证**的 OIDC 身份声明完成登录 / 建号 / 判定需要绑定。
   *
   * 调用方必须先完成全部密码学校验（签名、`iss`、`aud`、`exp`、`nonce`）——
   * 本方法**不做任何 token 校验**，它只负责账号策略与数据库。
   */
  authenticateOidc(claims: OidcClaims, req: IncomingMessage): Promise<OidcAuthOutcome>
  /**
   * ★ P2：由**受信插件**创建本地账号（当前调用方只有 @geewiki/org 的邀请流程）。
   *
   * **本方法不做任何鉴权** —— 它假定调用方已经验证过"这个人确实该有账号"
   * （org 用的是一个 256 位熵、未过期、未消费、且邮箱匹配的邀请令牌）。
   * 因此**绝不要**把它直接接到任何 HTTP 端点上。
   *
   * 好处是口令哈希、邮箱唯一性、`credentialSource` 的维护都留在身份域内，
   * 不会被复制到第二个插件里（复制出来的那份将来必然漏掉算法升级）。
   */
  createLocalUser(input: {
    email: string
    displayName: string
    password: string
  }): Promise<
    { ok: true; userId: number } | { ok: false; error: 'email_taken' | 'invalid_email' | 'invalid_password' }
  >
}

/* ---- OIDC：身份声明与 provider 注册表（原 `@geewiki/auth` 的 oidc.ts）---- */

export interface OidcClaims {
  /** 已规范化的 issuer（`new URL(issuer).href`） */
  issuer: string
  /** OIDC `sub`：IdP 内稳定且唯一的用户标识 */
  subject: string
  /** IdP 声明的邮箱（可能为空） */
  email: string | null
  /** IdP 对邮箱的**声明**（不是我们独立验证的事实，故不用于自动绑定） */
  emailVerified: boolean
  /** IdP 声明的显示名（可空） */
  displayName: string | null
}
/**
 * 一个 OIDC provider 的**描述**（由 `@geewiki/oidc` 注册进 `auth-service`）。
 *
 * 本包只持有描述，**不碰 OIDC 协议本身**（发现文档、JWKS、PKCE 都在 `@geewiki/oidc`）——
 * 形态对齐 `llm-service` 的路由注册表：契约层持有注册表，adapter 提供实现。
 *
 * 三个方法都**必须同步**：`capabilities` 在 `GET /api/auth/state` 里下发，
 * 而那是每个访客冷启动都会打的热路径，不能在那里做网络 IO。可用性由 provider
 * 自己缓存（并在后台按需刷新）。
 */
export interface OidcProvider {
  /** 注册表键（重复注册时 `registerOidcProvider` 抛错，不静默覆盖） */
  id: string
  /** 前端 SSO 按钮的展示名 */
  label: string
  /** 前端导航到的入口路径（由 provider 自己注册的路由提供，形如 `/api/auth/oidc/start`） */
  startPath: string
  /** 当前是否可用（IdP 可达 + 配置完整） */
  available(): boolean
  /** 不可用原因：`'unreachable' | 'unconfigured'` 等；可用时返回 `null` */
  reason(): string | null
}

/** 下发到前端的 provider 快照（不带函数，可直接 JSON 序列化） */
export interface OidcProviderInfo {
  id: string
  label: string
  startPath: string
  available: boolean
  reason: string | null
}

/* ============================ wiki-service ============================ */

/** 页面摘要（对应 GET /api/pages 的单项） */
export interface WikiPageSummary {
  slug: string
  title: string
  updated_at: string
  /** 版本号 = 历史快照数 + 1（与端点同口径） */
  version: number
  /**
   * 是否被"在左侧边栏隐藏"（站点级，存 `page_nav_state.hidden`）。
   *
   * 注意语义边界：它**不影响可见性**——被隐藏的页面照样能通过直链、检索、权限判定访问，
   * 只是不出现在侧栏与"上一篇/下一篇"里（`navTree.ts` 负责继承与剪枝）。
   * 之所以要下发到列表里：侧栏与「全部页面」共用这一份列表，"隐藏"必须能被**看见**
   * （列表页把隐藏项标成灰色）而不是"消失得无影无踪"。
   */
  nav_hidden: boolean
}

/**
 * 一个父级下的**同级顺序**（`parent` 为空串 = 顶层）。
 *
 * 为什么顺序不写在页面摘要里：同层还可能是**没有页面的分组**（层级由 slug 决定，
 * `guides` 本身可能不是页面，本仓的 `guide`/`demo` 就是），它们同样需要位次——
 * 顺序因此按"父级 → item 列表"下发，item 既可能是页面 slug，也可能是分组路径。
 */
export interface WikiNavOrder {
  parent: string
  items: string[]
}

/** 页面详情（对应 GET /api/pages/:slug 的响应体） */
export interface WikiPageDetail {
  slug: string
  title: string
  content: string
  /**
   * 正文口径。缺省（`undefined`）= **按读者投影后**的正文：受限段落已替换成占位、
   * gated 标记已消费。`'raw'` = 原文（含 `<!--gated:…-->` 标记），
   * 只在显式请求 `?content=raw` **且主体可编辑这一页**时出现。
   *
   * 为什么要有这个自述字段：两种口径的正文长得几乎一样（都是一段 Markdown），
   * 而拿错口径的后果不对称 —— 把投影结果当原文**存回去**会毁掉段落权限标记、
   * 让受限段落静默变公开。故响应必须自己说清楚它是哪一种。
   */
  contentMode?: 'raw'
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
  /**
   * 初始可见性档位。**只在创建分支生效**，且**只有跨插件服务路径能传**：
   * HTTP 的 `parseSaveBody` 对未知字段回 400，故"改可见性"仍然只有带
   * `canManageVisibility` 的专用端点这一条路（§2.2）。
   *
   * 存在的意义：系统写方（如 `@geewiki/builtin-docs` 同步内置文档）需要以
   * 非默认档位**创建**页面，而创建时的块 `tier` 是按档位算的（见创建分支里
   * `pageLevelOf` 的 `self` 参数）——事后改档位会留下一段错算的窗口。
   * 缺省仍是 `'org'`（两层默认的应用层那一半，§3.3 v5 / D8）。
   */
  visibility?: 'private' | 'org' | 'public'
  /**
   * 创建时是否直接发布（打 `published_at`）。与 `visibility` 同一条生效规则：
   * 只在创建分支生效、只有服务路径能传。发布闸门只约束 public 档
   * （未发布的 public 页面对任何人都不可见，见 authz 的 `decideNormally`），
   * 所以**创建为 public 而不发布等于没创建**——系统写方若要公开，两者一起给。
   */
  published?: boolean
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
 * **方法集与四个 REST 端点一一对应**（不引入端点之外的新语义；唯一的例外是
 * `exists()`——它没有安全的端点形态，理由写在其声明处）：
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
  /**
   * 页面详情；**不存在或无权**均返回 `undefined`（对应端点 404，不泄露存在性）。
   *
   * ★ `opts.rawContent` 是**编辑口径**：返回含 `<!--gated:…-->` 标记的原文，
   * 而不是投影后的正文。**授权由本方法自己强制**（要求 `canEdit`），够不着就
   * **静默退回投影口径**——响应自带 `contentMode: 'raw'` 自述，调用方据它分辨拿到了哪一种。
   *
   * 为什么把这条判据放在服务里、而不是继续留给路由层：
   * 路由层那份检查只保护"经 HTTP 进来的调用"。跨插件调用（`ctx.get('wiki-service')`）
   * 根本不经过路由，于是 `@geewiki/ai-kb` 的 `read_page` 与 `@geewiki/ai-pages` 的
   * `page.update` 曾经**读投影、写原文**——一次 AI 改写就能把受限区段连标记一起抹掉，
   * 受限段落静默变成公开块，且不报错。判据放在只有一处的地方，才不会有一条绕过去的路。
   */
  get(slug: string, principal: Principal, opts?: { rawContent?: boolean }): Promise<WikiPageDetail | undefined>
  /** 新建或更新（幂等 upsert）：标题与正文均未变化时 outcome='unchanged' 且不写历史。
   * `input.visibility / published` 仅创建分支生效且仅服务路径可传（见 {@link WikiSaveInput}） */
  save(slug: string, input: WikiSaveInput): Promise<WikiSaveResult>
  /** 删除页面及其全部版本历史；返回是否确实删除（false 对应端点 404） */
  remove(slug: string): Promise<boolean>
  /**
   * 该 slug 的页面行是否存在——**与可见性无关**的存在性探测。
   *
   * ★ 契约"与 REST 端点一一对应"的**唯一例外**，因为它没有安全的端点形态：
   * 暴露成 HTTP 就成了"探测 slug 是否存在"的接口（404 语义刻意不区分"不存在/无权"，
   * 见 `get`）。它是给**系统写方**的服务内方法：`@geewiki/builtin-docs` 同步前
   * 需要知道"这个 slug 是不是被用户的页面占了"（接管护栏），而 `get()` 对
   * 看不见的既有页面一律返回 `undefined`，回答不了这个问题。
   */
  exists(slug: string): Promise<boolean>
  /**
   * 把给定页面的块 `tier` 按**策略层当前判定**重算一遍（返回被重算的块数；不存在的 slug 跳过）。
   *
   * "与 REST 端点对应"的第二个例外（第一个是 `exists`）。为什么不能复用
   * `POST /api/admin/blocks/resync`：那个端点是 `access: 'admin'`，系统写方**没有也不该有**
   * admin 主体——它要的是"我改了某个影响档位推导的输入，请把派生列刷成正确值"。
   *
   * 存在的意义：`blocks.tier` 是**物化派生列**，检索命中层只看它（这正是"受限文本
   * 从不离开数据库"的实现方式）。任何**不进 `pages.visibility` 列**的策略输入变化，
   * 都需要有人显式触发重算，否则读路径已收紧而检索仍命中——那正是 §9 R13 警告的
   * "泄漏级漂移"。当前唯一的使用者：`@geewiki/builtin-docs` 在激活时重同步记账页
   * （它的 `hidden` 开关不写库、只改判据，翻动必须物化到 tier 才在检索侧生效）。
   */
  resyncTiers(slugs: readonly string[]): Promise<number>

  /**
   * 写"在左侧边栏隐藏"（站点级，落到 `page_nav_state.hidden`）。返回是否写入成功
   * （页面不存在 ⇒ false，不留下悬挂的导航状态行）。
   *
   * **刻意不碰可见性**：隐藏只改导航呈现，不改 `pages.visibility`、不改块的 `tier`、
   * 也不写审计为权限事件。被隐藏的页面照样能被直链打开、被检索命中、被有权者编辑——
   * 这与"私有/组织内"是两件正交的事，混在一起会让"隐藏"变成一种(半吊子的)权限。
   */
  setNavHidden(slug: string, hidden: boolean): Promise<boolean>

  /**
   * 把 `parent` 这一层级的**直接子级**顺序整体写成给定顺序（下标即位次），返回写入行数。
   *
   * `items` 里的每一项既可以是页面 slug，也可以是**没有页面的分组路径**（如 `guide`）——
   * 分级由 slug 决定，`guide` 本身可能不是页面，但它同样需要在同一层里有位次。
   *
   * 为什么是"整组一起写"而不是"移动某一条"：拖动只表达"我看重这个顺序"，一次写全组
   * 才能让顺序自洽（不会出现两条同 sort_key 或新旧混排）；也让重放安全（同样输入同样的结果）。
   *
   * 拒绝条件（抛 {@link NavOrderError}，HTTP 层翻译成 400）：空列表、重复 slug、
   * 某个 slug 的直接父级不等于 `parent`。**跨层级拖动永远不会被接受**——层级由 slug 决定，
   * 改变层级意味着改 URL（那是"移动页面"，不是排序）。
   */
  setNavOrder(parent: string | null, items: readonly string[]): Promise<number>
  /** 引用了该页的页面（按标题、slug 稳定排序）；页面不存在时返回 `undefined`（对应端点 404）。已按主体可见性过滤 */
  backlinks(slug: string, principal: Principal): Promise<WikiBacklink[] | undefined>
  /** 该页正文指向的目标；`undefined` 对应 404。不可见的目标带 `exists:'hidden'`，**不得**当作"不存在" */
  links(slug: string, principal: Principal): Promise<WikiOutlink[] | undefined>
}

/* ============================ attachment-service ============================ */

/**
 * 附件存储层的错误码 —— **即端点要回的错误码**（沿用仓库"消息前缀即错误码"的约定）：
 *
 * - `payload_too_large` ⇒ 413（调用方的输入问题）
 * - `length_mismatch` ⇒ **400**（实收字节数与声明的 `Content-Length` 不符：上传被截断/半途而废）
 * - `storage_unavailable` ⇒ **503**（不是 500）。这一点是刻意的：磁盘只读/写满/无权限是
 *   **运维状态**，不是本服务故障。报 500 会让每个失败请求都计入 `stats().consecutiveFailures`，
 *   连续失败达到阈值就可能触发看门狗熔断 —— 于是"磁盘满了"被升级成"整站被熔断"。
 *   503 的表达更准确：**依赖不可用，服务本身是活的**。
 */
export type AttachmentServiceErrorCode = 'payload_too_large' | 'length_mismatch' | 'storage_unavailable'

/** 附件存储层的错误。`code` 即端点要回的错误码，消息前缀也是 `code`。 */
export class AttachmentServiceError extends Error {
  constructor(
    readonly code: AttachmentServiceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'AttachmentServiceError'
  }
}

/** 一次 `put()` 的结果。**原始文件名不参与**：去重与寻址都只看内容哈希。 */
export interface StoredAttachment {
  /** 内容哈希（hex，64 位）。 */
  sha256: string
  /** 实际写入的字节数（来自流，不是 `Content-Length`）。 */
  byteSize: number
  /** `true` = 该内容此前已在存储里（本次没有产生第二份）。 */
  dedup: boolean
}

/** 一个已存对象的句柄：能报字节数、也能开流。 */
export interface StoredBlob {
  /** 字节数（供响应头用；与元数据不符时由调用方留痕）。 */
  readonly size: number
  /** 打开内容流。调用方负责消费或销毁。 */
  open(): Readable
}

/**
 * 附件**字节存储**的服务契约（`ctx.provide('attachment-service', …)`）。
 *
 * **边界刻意划在这里**：元数据**不归本服务** —— `attachments` 表（`sha256`/`ext`/`mime`/
 * `byte_size`/`original_name`）以及"谁能看这个附件"的判定，仍完全属于 wiki。
 * 本服务只管"按内容寻址把字节放进去 / 取出来 / 删掉"，所以一个 S3/WebDAV 实现
 * 既不必理解块级授权、也不必碰 `attachments` 表。
 *
 * **为什么需要它**（审计 §2 B2）：原先字节存储硬编码在 `plugin-wiki` 的
 * `attachment-store.ts`（`node:fs` + sha256 内容寻址），于是"换对象存储"要么改 wiki 源码、
 * 要么整体替换 wiki（连带丢掉页面 ACL 与块级投影）。接口化之后，替换者只需
 * `provides` 同一个 token，wiki 侧一行不改。
 */
export interface AttachmentService {
  /** 启动期准备（建目录 / 探通路）。失败应抛 {@link AttachmentServiceError}，供激活期探针报 503。 */
  ready(): Promise<void>
  /**
   * 把 `src` 流式写入存储。
   *
   * @param o.maxBytes 字节上限：累计超出即中断并抛 `payload_too_large`。
   * @param o.ext 已过白名单的扩展名（内容寻址的落盘路径需要它）。
   * @param o.expectedBytes **声明**的字节数（HTTP 场景即 `Content-Length`）。给了就必须与实收
   *   一致，否则抛 `length_mismatch`；不传则不做这项校验。
   */
  put(src: Readable, o: { maxBytes: number; ext: string; expectedBytes?: number }): Promise<StoredAttachment>
  /** 取一个已存对象；不存在返回 `undefined`（**不是**抛错 —— "元数据在、文件不在"是可诊断状态）。 */
  get(sha256: string, ext: string): Promise<StoredBlob | undefined>
  /** 删除一个已存对象。不存在视为成功（幂等）。 */
  remove(sha256: string, ext: string): Promise<void>
}

/* ============================ embedding-service ============================ */

/** `ctx.get()` 用的服务名（`ctx.provide('embedding-service', …)`）。 */
export const EMBEDDING_SERVICE_NAME = 'embedding-service'

/**
 * ★ F18：**向量 / 语义检索的提供方契约**。
 *
 * ## 为什么只定接口、不带实现
 * `docs/roadmap.md` 的 **L-17 把语义检索有意后置**，而"后置"最容易悄悄变成"没有"：
 * 一旦检索侧硬编码某个具体实现，后来者就只能去改它。所以这里先把**能力边界**钉下来，
 * 实现留给插件 —— 宿主因此不必背 `onnxruntime` / `transformers.js` 这类重依赖
 * （与"仅 SQLite 即可跑"的极致轻量目标直接冲突），也不会绑死任何一家模型供应商。
 *
 * ## 消费者必须遵守的三条
 * 1. **逐请求 `ctx.get('embedding-service')`，不要缓存快照。** 服务在提供者 `apply`
 *    结算之前对其它插件不可见（`ctx.get` 返回 `undefined` 且**静默**），缓存快照会把
 *    "提供者晚到"这件事**永久固化成**"这个部署永远没有语义能力"。
 * 2. **`dim` 必须随向量一起持久化。** 换掉 provider 就会换维度；只存向量不存维度，
 *    混合维度的库要到算相似度时才发现对不上，而那时数据早已写进去了。
 * 3. **没有提供者不是错误，是"能力不存在"。** 缺服务时应走"语义检索不可用"的**显式**路径
 *    （拒绝该 mode / 隐藏入口），**不要**退化成字面检索后假装成功 —— 那会让用户以为
 *    语义检索已生效，而实际只是关键词匹配（L-17 里"同义改写搜不到"的抱怨会原样回来）。
 *
 * ## 为什么是 `embed(texts)` 批量，而不是 `embed(text)` 单个
 * 远程 embedding API 的主要成本是**往返延迟**，不是算力。单文本接口会把"N 段文档"
 * 变成 N 次往返，且提供方**无法**在内部合并（它看不到尚未发生的调用）。批量是这类 API
 * 的天然形态，故契约直接按批量定；只嵌一条的消费者传长度为 1 的数组即可。
 *
 * ## 为什么错误类住在 core
 * 与 {@link AttachmentServiceError} 同一条教训：错误类若定义在实现包里，替换者要么依赖
 * 被替换的包、要么自造一个同名类，而 `err instanceof XxxError` 会**静默失配** ——
 * 于是"限流/超时"被降级成 500 并计进 `stats().consecutiveFailures`，把一个运维状态
 * 升级成看门狗熔断。
 */
export type EmbeddingServiceErrorCode =
  /** 没有提供者 / 提供者未就绪 / 探活失败 ⇒ **503**（依赖不可用，服务本身是活的）。 */
  | 'provider_unavailable'
  /** 输入非法（空数组、含非字符串、超过提供方上限）⇒ **400**。 */
  | 'invalid_input'
  /** 提供方限流或额度耗尽 ⇒ **503**（可重试，且不是本服务的故障）。 */
  | 'rate_limited'
  /** 提供方返回的东西不符合本契约（数量不符 / 维度不齐 / 含非有限数）⇒ **502**。 */
  | 'provider_malformed'

/** 语义能力的错误。`code` 即消费方要回的错误码，消息前缀也是 `code`。 */
export class EmbeddingServiceError extends Error {
  constructor(
    readonly code: EmbeddingServiceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'EmbeddingServiceError'
  }
}

/** 一次批量嵌入的结果。`vectors[i]` 对应输入 `texts[i]`。 */
export interface EmbeddingResult {
  /** 与输入**等长、同序**；每条都是有限数组成的向量。 */
  readonly vectors: readonly (readonly number[])[]
  /** 每条向量的维度（= `vectors[0].length`）。**消费方必须与向量一起持久化**（见文件头第 2 条）。 */
  readonly dim: number
  /** 提供方的模型标识（诊断用；换了它 `dim` 可能跟着变）。 */
  readonly model: string
}

export interface EmbeddingProvider {
  /**
   * 就绪探针。**是方法而不是属性**（与 {@link AttachmentService.ready} 同款裁决）：
   * 探活必须能**抛错** —— 远程提供者要真打一次接口，而读一个属性问不出"现在通不通"。
   * 抛错即视为未就绪。
   */
  ready(): Promise<void>
  /** 提供方当前产出的维度。**未就绪时也应有值**（供界面展示"这个 provider 会产出多少维"）。 */
  readonly dim: number
  /** 提供方的模型标识（与 {@link EmbeddingResult.model} 同义，供**调用之前**展示）。 */
  readonly model: string
  /**
   * 批量嵌入。
   *
   * 实现**必须**保证：返回条数与入参等长同序、每条维度一致且为有限数、`dim` 与实际长度相符。
   * 拿不准就调 {@link assertEmbeddingResult} —— 它会把这三种偏差变成一条可读的错误，
   * 而不是让 NaN 流进索引。
   */
  embed(texts: readonly string[]): Promise<EmbeddingResult>
}

/**
 * 校验一次批量嵌入的结果是否符合契约；不符即抛 `provider_malformed`。
 *
 * 为什么放在 core 而不是让各消费方自己写：**这是契约的一部分**，不是某个消费方的业务。
 * 各写一份的必然结果是宽严不一 —— 宽松的那份会把 `NaN` 写进索引，之后每一次相似度计算
 * 都得 `NaN`，而**写入的那一刻不会报任何错**（排序还会安静地退化成"原序"）。
 *
 * @param texts 原始入参（用于比对数量与顺序）
 */
export function assertEmbeddingResult(texts: readonly string[], raw: unknown): EmbeddingResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new EmbeddingServiceError('provider_malformed', '提供方未返回对象')
  }
  const r = raw as { vectors?: unknown; dim?: unknown; model?: unknown }
  if (!Array.isArray(r.vectors)) {
    throw new EmbeddingServiceError('provider_malformed', '`vectors` 不是数组')
  }
  if (r.vectors.length !== texts.length) {
    throw new EmbeddingServiceError(
      'provider_malformed',
      `返回条数 ${r.vectors.length} 与入参条数 ${texts.length} 不符（顺序与数量必须一一对应）`,
    )
  }
  let dim = -1
  const vectors: number[][] = []
  for (let i = 0; i < r.vectors.length; i++) {
    const v: unknown = r.vectors[i]
    if (!Array.isArray(v) || v.length === 0) {
      throw new EmbeddingServiceError('provider_malformed', `第 ${i} 条不是非空数组`)
    }
    if (dim < 0) dim = v.length
    else if (v.length !== dim) {
      throw new EmbeddingServiceError(
        'provider_malformed',
        `维度不齐：第 ${i} 条是 ${v.length} 维，第 0 条是 ${dim} 维`,
      )
    }
    const nums: number[] = []
    for (let j = 0; j < v.length; j++) {
      const n: unknown = v[j]
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new EmbeddingServiceError('provider_malformed', `第 ${i} 条第 ${j} 维不是有限数`)
      }
      nums.push(n)
    }
    vectors.push(nums)
  }
  if (vectors.length === 0) {
    // 空入参本身不是错误（批量接口的合法调用），但 `dim` 无从得出，故要求显式给出
    if (typeof r.dim !== 'number' || !Number.isInteger(r.dim) || r.dim <= 0) {
      throw new EmbeddingServiceError('provider_malformed', '空批量必须显式给出正整数 `dim`')
    }
    dim = r.dim
  } else if (r.dim !== undefined && r.dim !== dim) {
    throw new EmbeddingServiceError('provider_malformed', `声明的 dim=${String(r.dim)} 与实际长度 ${dim} 不符`)
  }
  if (typeof r.model !== 'string' || r.model === '') {
    throw new EmbeddingServiceError('provider_malformed', '缺 `model` 标识（换模型会换维度，排障必须能看出来）')
  }
  return { vectors, dim, model: r.model }
}

/**
 * 语义能力的**可用性探针**结果。
 *
 * 刻意做成可辨识联合而不是 `{ available, reason? }`：后者允许出现
 * `{ available: true, reason: '...' }` 与 `{ available: false }` 这类自相矛盾的值，
 * 而每一个消费方都得再判一次。联合类型让"可用就一定有 model/dim"由编译器保证。
 */
export type EmbeddingProbe =
  | { readonly available: true; readonly model: string; readonly dim: number }
  | { readonly available: false; readonly reason: string }

/**
 * 探测一个 embedding 提供者是否可用。**本函数永不抛错**（这是它的全部意义）。
 *
 * ## 为什么需要它，而不是让消费方自己写
 * 每个消费方都要重复这四步，而其中三步**默认写法都是错的**：
 * 1. 服务没注册（`undefined`）—— 天真写法会 `provider.ready()` 直接 TypeError，把
 *    "这个部署没配语义能力"变成一个 500；**必须**当成正常状态。
 * 2. 形态不对（插件 provide 了错东西）—— 同上，且这种错在运行期才暴露。
 * 3. `ready()` **抛错**（远程提供者探测失败）—— 必须被接住并转成 `available:false`，
 *    否则一次网络抖动会让检索端点整个 500，并计进看门狗的连续失败计数。
 * 4. `ready()` **永不 settle** —— 消费方不该在这里挂住请求；本函数**不做**超时，
 *    因为超时时长属于消费方的请求预算（检索端点的预算与后台索引任务的预算不同）。
 *    若需要，请在消费方用 `Promise.race` 包一层。
 *
 * ## 调用姿势（重要）
 * **逐请求**调用，参数**直接传当次 `ctx.get(EMBEDDING_SERVICE_NAME)` 的结果：
 * ```ts
 * const probe = await probeEmbeddingProvider(ctx.get(EMBEDDING_SERVICE_NAME))
 * if (!probe.available) return h.json(503, { ok: false, error: 'semantic_unavailable', message: probe.reason })
 * ```
 * 把 `ctx.get()` 的结果缓存下来会让"提供者晚到"永久固化成"永远没有语义能力"
 * （原因见 {@link EmbeddingProvider} 文件头第 1 条）。参数设计成"传值"而不是"传 ctx"，
 * 正是为了让这件事在调用点上显式可见。
 *
 * @param provider 当次 `ctx.get(EMBEDDING_SERVICE_NAME)` 的结果（可以是 `undefined`）
 */
export async function probeEmbeddingProvider(provider: unknown): Promise<EmbeddingProbe> {
  if (provider === undefined || provider === null) {
    return { available: false, reason: '未注册 embedding 提供者（没有插件 provide embedding-service）' }
  }
  if (typeof provider !== 'object') {
    return { available: false, reason: 'embedding 提供者不是对象（register 形态不合法）' }
  }
  const p = provider as Partial<EmbeddingProvider>
  if (typeof p.ready !== 'function') {
    return { available: false, reason: 'embedding 提供者缺 ready() 方法' }
  }
  if (typeof p.embed !== 'function') {
    return { available: false, reason: 'embedding 提供者缺 embed() 方法' }
  }
  try {
    await p.ready()
  } catch (err) {
    return {
      available: false,
      reason: `embedding 提供者未就绪: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  // ready() 通过后再读元信息：就绪之前它们可能还是占位值
  const model = typeof p.model === 'string' && p.model !== '' ? p.model : '（未声明 model）'
  const dim = typeof p.dim === 'number' && Number.isInteger(p.dim) && p.dim > 0 ? p.dim : 0
  if (dim <= 0) {
    return { available: false, reason: 'embedding 提供者未声明有效的正整数 dim（消费方无法安全持久化向量）' }
  }
  return { available: true, model, dim }
}

/* ============================ capability-service ============================ */

/**
 * 一个能力的**同步**求解器：给定主体，回答"它有没有这个能力"。
 *
 * **必须同步 —— 这不是代码风格问题**。消费方是 `judgeAccess`
 * （`packages/server/src/index.ts`），它在请求热路径上被**同步**调用，且被设计成纯函数
 * （只用入参、不 await）。若允许异步求解器，整条闸门要改成异步，于是"await 期间主体是否
 * 还有效"变成一个全新的竞态面 —— 而那是权限判定最不该有的东西。
 */
export type CapabilityResolver = (principal: Principal) => boolean

/** 一个能力声明（谁声明的、给用户看什么）。 */
export interface CapabilityDeclaration {
  /** 声明者（插件名）。卸载时据此成组撤销 */
  readonly owner: string
  readonly name: CapabilityName
  /** 面向用户的名字（管理/诊断界面用）；缺省回退到 `name` */
  readonly label?: string
  readonly description?: string
}

/**
 * **能力注册表服务**（`ctx.provide('capability-service', …)`）。
 *
 * **为什么需要它**（审计 §2 B4）：能力原先是一个**编译期闭合**的三键接口
 * （`AuthCapabilities`，且真源在**前端包** `web/src/api.ts`）。后果是插件无法让自己的
 * 导航项/路由要求一个新能力 —— 键不存在，`caps?.[key] === true` 恒假，
 * 那个入口**永远不出现且没有任何日志**。能力值又只能由 `plugin-auth` 按 `orgRole` 推导，
 * 插件没有任何地方能贡献"我这类用户算不算有 X 能力"。
 *
 * 修法是把能力拆成两半，各归其位：
 * - **名字**：单一真源在 `domain.ts`（内置的三个 + 插件用 `a/b` 命名空间声明）；
 * - **值**：内置的仍由角色推导（{@link builtinCapabilitiesOf}），插件的由本服务注册的
 *   求解器提供，两者在 {@link CapabilityService.snapshot} 里合成一张表。
 *
 * 前端**不需要**知道谁提供了哪个能力 —— 它只读 `snapshot` 下发的那张表，
 * 并以 `=== true` 判定（缺失即不具备）。于是"新增一个能力"对前端是**零改动**的。
 */
export interface CapabilityService {
  /**
   * 注册一个插件能力名及其求解器。
   *
   * **不做鉴权、不做角色推导** —— 求解器就是全部判据，它对该主体返回什么就是什么。
   * 因此一个求解器写得过宽，等价于把该能力发给所有人：调用方（插件作者）必须把它
   * 当成**权限边界**来写，而不是"方便前端显示"的开关。
   *
   * @returns 撤销函数（卸载时调用；owner 整体卸载时也会成组撤销）
   */
  provide(
    owner: string,
    name: CapabilityName,
    resolve: CapabilityResolver,
    meta?: { label?: string; description?: string },
  ): () => void
  /** 已知能力声明：内置的三个在前（固定顺序），其后是插件声明的（按能力名字典序） */
  declarations(): readonly CapabilityDeclaration[]
  /**
   * 某主体的能力快照 = 内置（角色推导） ∪ 全部已注册求解器。
   *
   * 形参接受 `undefined`（= 完全没有主体信息），与 {@link builtinCapabilitiesOf} 对齐：
   * 调用方在"认证中间件还没跑完"这条路径上拿到的就是 `undefined`，让它在这里多一个
   * 可空分支没有意义 —— 语义上 `undefined` 与匿名等价，都判为"不具备"。
   */
  snapshot(principal: Principal | undefined): CapabilitySet
}

/**
 * 由**组织角色**推导内置能力 —— 唯一的角色语义真源。
 *
 * **本函数只描述"前端可以显示哪些入口"，服务端判定一律独立进行**：
 * 前端隐藏不是安全措施（设计文档 §9 R10 反模式第 5 条），这些布尔值被改掉也不会
 * 多出任何权限。
 *
 * 角色语义（设计文档 §2.1）：
 * - `owner` / `admin`：管理成员、组、邀请、插件；改任何条目的可见性。
 * - `member`：建改内容；对自己有编辑权的条目改可见性与授予例外。
 * - `viewer`：**只读**（能看组织内可见条目，不能写）。
 * - `null`（= guest，未入伙）：什么都不能做，只能看被显式授予的内容。
 * - `break-glass`：应急通道的意义是"身份系统本身出问题时还能进场"，故能力上界等同 owner
 *   （每次使用由 server 层写 `access.break_glass` 留痕，设计文档 D7）。
 *
 * `manageVisibility` 给的是"**是否可能拥有**"的上界；**逐条目的**判定由
 * `policy-service` 的 `PageAccess.canManageVisibility` 给出（本函数不认识任何条目）。
 *
 * **为什么搬进 core**：它原先在 `plugin-auth` 里。而 `judgeAccess`（server）与
 * `/api/auth/me`（auth）都要用它，把规则留在实现包里等于让替换 auth 的插件
 * 重新发明一遍角色语义 —— 那份复制品迟早会与这份漂移。
 */
export function builtinCapabilitiesOf(principal: Principal | undefined): CapabilitySet {
  if (principal?.kind === 'break-glass') {
    return { editContent: true, administer: true, manageVisibility: true }
  }
  if (principal?.kind !== 'user') {
    return { editContent: false, administer: false, manageVisibility: false }
  }
  const role = principal.orgRole
  const isAdmin = role === 'owner' || role === 'admin'
  return {
    editContent: isAdmin || role === 'member',
    administer: isAdmin,
    manageVisibility: isAdmin || role === 'member',
  }
}
