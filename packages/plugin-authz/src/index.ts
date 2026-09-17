/**
 * `@geewiki/authz` —— 授权策略的**唯一真源**（`policy-service`）
 *
 * 设计依据：docs/design/access-control.md §2.3（继承与裁决）、§2.4（函数签名）、
 * §9 R2（逐调用传主体）、§9 R10（反模式清单）。
 *
 * ## 为什么必须是一个"单点"
 *
 * OWASP 的原话：*"Remember an attacker only needs to find one way in."* 只要有一条读路径
 * 自己拼 payload、自己决定裁多少，它就是第二个真源，迟早与这里漂移 —— 而漂移的方向
 * 通常是"某条路径忘了过滤"。所以本服务把三件事绑在一起：
 *   1. **判定**（谁能看） 2. **裁剪**（`project`，看到多少） 3. **可复用出口**（`visibleSlugs`）
 *
 * ## 失败关闭（§9 R2 铁律）
 *
 * 服务是**全局单例**，不持有请求上下文。因此每个方法都**必须显式收到 `Principal`**，
 * 且发现它不是合法主体时**抛错而不是放行**。绝不允许写 `if (principal) { 过滤 }` ——
 * 那会把"调用方忘了传"变成"全量返回"。
 *
 * ## 位置性继承（§2.3）
 *
 * 祖先收紧**按 slug 前缀实时计算**，不做物化副本、不在创建时拷贝 ACL：
 * "移动条目"就是改 slug，判定随即变化，不存在需要同步的第二个事实。
 */
import type { Context } from 'cordis'
import {
  anonymousPrincipal,
  asAsync,
  auditIpHash,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type DatabaseAdapterAsync,
  type GeeWikiManifest,
  type HttpRouterService,
  type Principal,
  type RouteHandlerContext,
} from '@geewiki/core'

/* ============================== 类型 ============================== */

/** `none` = 404 语义；`summary` = 只见标题与占位；`full` = 完整可见 */
export type AccessLevel = 'none' | 'summary' | 'full'

/** 判定来源。**没有"按角色授予"这一档**（D13：角色不是授权对象） */
export type AccessReason =
  | 'owner'
  | 'admin'
  | 'grant'
  | 'org'
  | 'public'
  | 'inherited-denied'
  | 'default-deny'

export interface PageAccess {
  slug: string
  level: AccessLevel
  canEdit: boolean
  canDelete: boolean
  canManageVisibility: boolean
  reason: AccessReason
  /**
   * **载荷裁剪的唯一出口**（§2.4 约束 1）。
   *
   * 任何端点若自己拼 payload 就是第二个真源，必然漂移。`level !== 'full'` 时正文
   * 一律不得进入响应 —— 这不是"前端隐藏"，而是**服务端序列化之前**就不存在。
   */
  project<T extends { content?: string }>(payload: T): T
}

/** 判定失败。调用方翻译成 HTTP（策略层不认识 HTTP，保持可测 —— §2.4 约束 2） */
export class PolicyError extends Error {
  readonly code: 'forbidden' | 'invalid_principal'
  constructor(code: PolicyError['code'], message: string) {
    super(message)
    this.name = 'PolicyError'
    this.code = code
  }
}

export interface VisibleQuery {
  /** 只返回该 slug 前缀下的条目（按段匹配，不是字符串前缀 —— `a/b` 不匹配 `a/bc`） */
  prefix?: string
  /** 只要这些等级，默认 `['full','summary']` */
  levels?: readonly AccessLevel[]
}

export interface PolicyService {
  resolvePage(p: Principal, slug: string): Promise<PageAccess>
  resolvePages(p: Principal, slugs: readonly string[]): Promise<Map<string, PageAccess>>
  /** **唯一允许被 list / search / backlinks / RAG / portal / sitemap 复用的出口** */
  visibleSlugs(p: Principal, q?: VisibleQuery): Promise<string[]>
  /**
   * 页面的**有效检索等级** —— **与主体无关**（检索索引是全体共用的，不能按人算）。
   *
   * 返回 `0`（匿名可见）/ `1`（组织内可见）/ `null`（没有任何等级能看）。
   * 供块级索引的 `blocks.tier` 计算使用（设计文档 §4.3）。
   *
   * `self` 用于**页面行尚未提交**的场景（新建条目时，写入方在自己的事务里刚 INSERT，
   * 而本方法走的是另一条连接 —— PG 下看不到未提交的行，会误判成"页面不存在"）。
   * 传入后它**只覆盖该 slug 自身那一行**，祖先链仍按库里的真实状态算。
   */
  effectiveIndexLevel(slug: string, self?: PageVisRow): Promise<0 | 1 | null>
  /**
   * ★ P3a：本主体**被显式授权**的块 id 集合 —— `granted` 档块的唯一入口。
   *
   * 为什么必须有它：`granted` 档的 `blocks.tier` 写 `NULL`，于是**永远不会被等级分支
   * 命中**（`NULL <= ?` 恒不成立，失败关闭）。要让这类块可检索，只能在检索 SQL 里
   * 加一个显式的授权分支，而那个集合的**判定必须来自这里**（单点）——
   * 检索插件若自己查 `block_grants`，就等于造出第二套授权规则，迟早漂移。
   *
   * **P3a 阶段恒返回空数组**：`block_grants` 表属 **P3b**（`0016_block_grants.sql`），
   * 在它落地之前不存在任何块级授权。返回空数组是**语义正确**的，不是占位 TODO：
   * 没有授权 = 没有块能被授权分支放行。SQL 侧因此退化为"只看等级分支"。
   *
   * ⚠️ 实现 P3b 时必须遵守的边界：本方法只返回**块 id**，不返回任何文本；
   * 且必须按 `expires_at` 过滤（过期的授权不算授权）。
   */
  grantedBlockIds(p: Principal): Promise<readonly number[]>
}

/* ============================== 档位序 ============================== */

/*
 * 越右越窄（§2.3 B1）。页面级用 private=2 与块级 granted=2 同为最窄档。
 * 数值只在本文件内使用；对外只暴露 AccessLevel 与 reason。
 */
const RANK_PUBLIC = 0
const RANK_ORG = 1
const RANK_PRIVATE = 2

function rankOf(visibility: string): number {
  if (visibility === 'public') return RANK_PUBLIC
  if (visibility === 'org') return RANK_ORG
  return RANK_PRIVATE // 未知取值一律当最窄档（失败关闭：宁可少给，不可多给）
}

/**
 * slug 的全部祖先，由近及远。`a/b/c` → `['a/b', 'a']`。
 *
 * 为什么由近及远：`inherit=false` 的语义是"我这一档不再往下传"，而它同时**截断链**——
 * 因此遇到第一个 `inherit=false` 的祖先就停止向上（"断链即断继承"，§2.3 的例子：
 * `secret.inherit=false` ⇒ `secret/x` 不再被 secret 限制）。
 */
function ancestorsOf(slug: string): string[] {
  const parts = slug.split('/')
  const out: string[] = []
  for (let i = parts.length - 1; i >= 1; i -= 1) out.push(parts.slice(0, i).join('/'))
  return out
}

/** 段级前缀匹配：`a/b` 匹配 `a/b` 与 `a/b/c`，但不匹配 `a/bc` */
function underPrefix(slug: string, prefix: string): boolean {
  return slug === prefix || slug.startsWith(`${prefix}/`)
}

/** 页面可见性快照（不含正文；列表与判定都只需这几列） */
interface PageVisRow {
  slug: string
  visibility: string
  inherit: number | boolean
  published_at: string | null
}

/* ============================== 插件 ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/authz',
  version: '0.1.0',
  geewiki: {
    displayName: '授权策略',
    description: '条目可见性判定的唯一真源：判定、载荷裁剪与可见集合三个出口',
    provides: 'policy-service',
    // 只要数据库：主体（含 orgRole / groupIds）由调用方经 Principal 传入，
    // 本插件**不认识** auth 或 org 插件 —— 这正是"策略与身份解耦"的落点。
    requires: ['database-provider', 'http-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      // 可热插拔：策略层不持有状态（缓存只是本次判定的中间产物），
      // 卸载后消费方会在 ctx.get('policy-service') 处拿到 undefined 并显式失败。
      supportsHotReload: true,
      requiresCachePurge: true,
      drainTimeout: 5,
    },
  },
}

interface GrantRow {
  page_slug: string
  role: string
  subject_kind: string
  subject_id: string
  expires_at: string | null
}

export const AuthzPlugin = {
  name: '@geewiki/authz',

  async apply(ctx: Context) {
    const rawDb = ctx.get('db') as AnyDatabaseAdapter | undefined
    if (!rawDb) throw new Error('@geewiki/authz: 数据库服务不可用（没有任何插件提供 database-provider）')
    const db: DatabaseAdapterAsync = asAsync(rawDb)

    /** 表存在性自检：缺表就指名道姓，而不是等第一个请求报 `no such table` */
    try {
      await db.query('SELECT slug, visibility, inherit, published_at FROM pages WHERE 1 = 0')
    } catch (err) {
      throw new Error(`@geewiki/authz: pages 缺少 P2 的可见性列 —— 请确认 0012_page_acl.sql 已应用（${(err as Error).message}）`)
    }
    try {
      await db.query('SELECT page_slug, subject_kind, subject_id, role FROM page_grants WHERE 1 = 0')
    } catch (err) {
      throw new Error(`@geewiki/authz: 缺少表 page_grants —— 请确认 0012_page_acl.sql 已应用（${(err as Error).message}）`)
    }
    /*
     * ★ P3b：块级授权表。
     *
     * **必须有这条自检，不能"表不在就返回空集"** —— 见下方 `grantedBlockIds` 的说明：
     * "没有授权"与"查不到授权表"在授权语义上是必须区分的两件事。缺表时显式失败，
     * 而不是静默降级成"没人有任何块级权限"（那会让 `granted` 档的块对所有被授权者
     * 也无故不可见，故障现象离根因很远）。
     */
    try {
      await db.query('SELECT block_id, subject_kind, subject_id, expires_at FROM block_grants WHERE 1 = 0')
    } catch (err) {
      throw new Error(
        `@geewiki/authz: 缺少表 block_grants —— 请确认 0016_block_grants.sql 已应用（${(err as Error).message}）`,
      )
    }

    /**
     * 主体守卫 —— **失败关闭的铁律**（§9 R2）。
     *
     * 判定函数签名要求 `Principal`，但 TS 的可选链与 `any` 仍可能让 `undefined` 溜进来
     * （插件消费方、测试替身、将来的新调用点）。这里**显式抛错**：宁可让请求 500，
     * 也绝不"因为没有主体而返回全部内容"。
     */
    const requirePrincipal = (p: Principal | undefined | null, who: string): Principal => {
      if (p === undefined || p === null || typeof p.kind !== 'string') {
        throw new PolicyError(
          'invalid_principal',
          `policy-service.${who}: 缺少 Principal —— 拒绝判定（绝不因"没传主体"而放行，见设计文档 §9 R2）`,
        )
      }
      return p
    }

    /* ------------------------- 数据读取 ------------------------- */

    /** 全表可见性快照。判定都要祖先链，逐条查会退化成 N×depth 次查询；一次读全表再内存算更稳 */
    const loadVisibilityIndex = async (): Promise<Map<string, PageVisRow>> => {
      const rows = await db.query<PageVisRow>(
        'SELECT slug, visibility, inherit, published_at FROM pages',
      )
      const map = new Map<string, PageVisRow>()
      for (const r of rows) {
        map.set(r.slug, {
          slug: r.slug,
          visibility: r.visibility,
          // 两方言都刻意用 INTEGER 0/1（见 0010/0012 的方言对照），但仍容忍布尔形态
          inherit: r.inherit === true || Number(r.inherit) === 1 ? 1 : 0,
          published_at: r.published_at ?? null,
        })
      }
      return map
    }

    /**
     * 某页的**位置性**有效档位：本条与全部「未断链」祖先的最窄档（§2.3 规则 1）。
     *
     * 纯函数、只依赖传入的快照 —— 因此"移动条目"（改 slug）后无需任何同步动作，
     * 判定随新的前缀链自动变化（§2.3 规则 3 反对"创建时拷贝 ACL"的原因）。
     */
    const effectiveRank = (slug: string, index: Map<string, PageVisRow>): number => {
      const self = index.get(slug)
      // 页面不存在：返回最窄档。**调用方会先判存在性**，这里只是不给出更宽的档
      if (!self) return RANK_PRIVATE
      let rank = rankOf(self.visibility)
      for (const anc of ancestorsOf(slug)) {
        const row = index.get(anc)
        if (!row) continue // 祖先不存在（红链/未建页）：不构成收紧
        if (row.inherit !== 1) break // ★ 断链：该祖先及其以上都不再下传
        rank = Math.max(rank, rankOf(row.visibility)) // 越窄档数值越大 ⇒ max 即"最严格优先"
      }
      return rank
    }

    /** 主体对某页的显式授予（user 直授 + group 授）。过期授予**判定时即失效**，不依赖清理任务 */
    const loadGrants = async (p: Principal, slugs: readonly string[]): Promise<Map<string, string>> => {
      const out = new Map<string, string>()
      if (p.kind !== 'user' || p.userId === null) return out
      const now = new Date().toISOString()
      const wanted = new Set(slugs)
      const rows = await db.query<GrantRow>(
        `SELECT page_slug, role, subject_kind, subject_id, expires_at
           FROM page_grants
          WHERE (subject_kind = 'user' AND subject_id = ?)`,
        [String(p.userId)],
      )
      const groupIds = p.groupIds.map((g) => String(g))
      if (groupIds.length > 0) {
        // 组授予：用 IN 一次取回（组集合来自 Principal.groupIds，已按 org 收窄）
        const placeholders = groupIds.map(() => '?').join(',')
        const groupRows = await db.query<GrantRow>(
          `SELECT page_slug, role, subject_kind, subject_id, expires_at
             FROM page_grants
            WHERE subject_kind = 'group' AND subject_id IN (${placeholders})`,
          groupIds,
        )
        rows.push(...groupRows)
      }
      for (const r of rows) {
        if (!wanted.has(r.page_slug)) continue
        if (r.expires_at !== null && r.expires_at !== undefined && r.expires_at <= now) continue // 已过期 ⇒ 视同没有
        // editor 优先于 viewer（同一人可能既有直授又有组授）
        const prev = out.get(r.page_slug)
        if (prev === 'editor') continue
        out.set(r.page_slug, r.role === 'editor' ? 'editor' : 'viewer')
      }
      return out
    }

    /* ------------------------- 核心判定 ------------------------- */

    const isAdminRole = (p: Principal): boolean => p.orgRole === 'owner' || p.orgRole === 'admin'

    /* ------------------------- 内置文档覆盖（可选消费面） ------------------------- */

    /**
     * `builtin-docs-service` 的**最小结构需求**（结构化类型，刻意不 import
     * `@geewiki/builtin-docs`，也不把它写进 requires）：内置文档是**可选插件**，
     * 硬依赖会让"没启用文档"变成"authz 起不来"。与 wiki/search 对 policy-service
     * 的反向消费同一条先例：只消费结果，不 import 实现。
     */
    interface BuiltinDocsPolicyLike {
      /** 该 slug 是否内置文档插件**建过**的页（记账表为权威，撞名未接管的不算） */
      isManagedPage(slug: string): boolean
      /** 当前的隐藏开关 */
      isHidden(): boolean
    }

    /**
     * 懒取内置文档判据服务：**每次调用都现取**，不缓存。
     *
     * 为什么必须现取：`hidden` 配置的热更新与插件重装都表现为"重新 activate ⇒
     * provide 一个**新对象**"，缓存旧引用会把"关掉即隐藏"退化成"重启才隐藏"。
     * 代价只是每次判定多一次服务表查找。缺席（未启用该插件）⇒ `undefined` ⇒ 无覆盖，
     * 这是设计好的常态，不是异常。
     */
    const builtinDocs = (): BuiltinDocsPolicyLike | undefined => {
      try {
        return ctx.get('builtin-docs-service') as BuiltinDocsPolicyLike | undefined
      } catch {
        return undefined
      }
    }

    /** 不带应急覆盖的"本来会怎样" —— 规则 O1 的审计判据就是拿它与最终结果比（§2.3 边界 1） */
    const decideNormally = (
      rank: number,
      publishedAt: string | null,
      grant: string | undefined,
      p: Principal,
    ): { level: AccessLevel; reason: AccessReason; canEdit: boolean } => {
      if (grant !== undefined) {
        // 显式授予：只放宽，不突破祖先收紧？—— 不，授予是**明确指名**的例外，
        // 它对本条生效（设计文档 §2.3 优先级表把 page_grants 排在祖先收紧之前）
        return { level: 'full', reason: 'grant', canEdit: grant === 'editor' }
      }
      if (rank === RANK_PUBLIC && publishedAt !== null) {
        return { level: 'full', reason: 'public', canEdit: p.kind === 'user' }
      }
      if (rank === RANK_ORG && p.kind === 'user' && p.orgRole !== null) {
        // 组织内可见**不要求发布**：D8 把存量条目回填成 org 而 published_at 保持 NULL，
        // 若这里要求发布，升级当天全站条目会对组织成员也不可见。
        return { level: 'full', reason: 'org', canEdit: true }
      }
      // 落空：区分"被祖先收紧"与"本条就是最窄档"，便于产品文案与排障
      return {
        level: 'none',
        reason: rank === RANK_PRIVATE ? 'default-deny' : 'inherited-denied',
        canEdit: false,
      }
    }

    const buildAccess = (
      p: Principal,
      slug: string,
      rank: number,
      publishedAt: string | null,
      grant: string | undefined,
    ): { access: PageAccess; overrode: boolean } => {
      /*
       * ★ 内置文档覆盖（`@geewiki/builtin-docs`）：两条规则都**收敛在这一个出口**——
       * resolvePage / resolvePages / visibleSlugs 三条路径全走 buildAccess，
       * 于是 HTTP 写路由、AI 写工具（先问 canEdit）、前端按钮（capabilities）、
       * 列表与检索（visibleSlugs）拿到的都是同一份结论，没有第二条路可以绕。
       */
      const bd = builtinDocs()
      const managed = bd !== undefined && bd.isManagedPage(slug)
      const hidden = managed && bd!.isHidden()
      const normal = decideNormally(rank, publishedAt, grant, p)
      let level = normal.level
      let reason = normal.reason
      let overrode = false
      if (hidden) {
        /*
         * 隐藏的内置文档：对**所有主体**（含 owner/admin）判 `level === 'none'` ⇒
         * 列表、检索、阅读一律视同不存在。隐藏优先于 O1 与显式授予——
         * 让后两者把它抬回来，"隐藏"就成了泄漏；管理员取消隐藏走配置开关，
         * 不需要隔着隐藏层偷看。不留覆盖审计：这不是"越权看到了"，
         * 是一个产品开关的形态。
         */
        level = 'none'
        reason = 'default-deny'
      } else if (level === 'none' && isAdminRole(p)) {
        // ★ 规则 O1：owner/admin 恒可看一切。**只在"本来会被拒"时才算覆盖** ——
        // 否则管理员的日常浏览会把审计表刷爆，真实信号被噪声淹没（§2.3 边界 1）。
        level = 'full'
        reason = p.orgRole === 'owner' ? 'owner' : 'admin'
        overrode = true
      }
      // 内置文档只读：编辑/删除/改可见性对**任何主体**恒 false（含 owner/admin、
      // 含显式 editor 授予——授予只买得到"读"，买不到"改"）。判据权威是内置文档的
      // 记账表（isManagedPage），不是代码目录：slug 撞名而未被接管的页面不受影响。
      const canEdit = managed ? false : level === 'full' && (normal.canEdit || isAdminRole(p))
      const access: PageAccess = {
        slug,
        level,
        canEdit,
        canDelete: canEdit,
        // "改可见性"是能力，来自角色与内容级授予档；O1 不新增能力（§2.3 边界 2）
        canManageVisibility: canEdit && (p.orgRole === 'member' || isAdminRole(p)),
        reason,
        project<T extends { content?: string }>(payload: T): T {
          if (level === 'full') return payload
          // ★ 服务端裁剪：非 full 时正文**根本不得存在**于响应里（不是前端隐藏）
          const { content: _dropped, ...rest } = payload as T & { content?: string }
          return rest as unknown as T
        },
      }
      return { access, overrode }
    }

    /** 覆盖式访问的留痕。**不阻塞主流程**：审计写不进去不该让读操作失败 */
    const auditOverride = (p: Principal, slug: string): void => {
      void writeAuditLog(db, {
        action: 'access.admin_override',
        targetKind: 'page',
        targetId: slug,
        actorId: p.userId,
        after: { role: p.orgRole },
      }).catch((err: unknown) => {
        console.error('[@geewiki/authz] 覆盖式访问审计写入失败:', err)
      })
    }

    /* ------------------------- 服务实现 ------------------------- */

    const svc: PolicyService = {
      async resolvePage(rawP, slug) {
        const p = requirePrincipal(rawP, 'resolvePage')
        const index = await loadVisibilityIndex()
        const row = index.get(slug)
        if (!row) {
          // 页面不存在 ⇒ 与"无权"返回同一个 level（调用方一律 404）。
          // **不区分二者**是刻意的：区分开就等于提供了"这个 slug 存不存在"的探测接口。
          return {
            slug,
            level: 'none',
            canEdit: false,
            canDelete: false,
            canManageVisibility: false,
            reason: 'default-deny',
            project: <T extends { content?: string }>(payload: T): T => payload,
          }
        }
        const grants = await loadGrants(p, [slug])
        const { access, overrode } = buildAccess(
          p,
          slug,
          effectiveRank(slug, index),
          row.published_at,
          grants.get(slug),
        )
        if (overrode) auditOverride(p, slug)
        return access
      },

      /**
       * 页面的有效检索等级（与主体无关）—— 供块级索引的 `blocks.tier` 计算使用。
       *
       * **与 {@link buildAccess} 的判定同源**：同一条 `effectiveRank`（含祖先交集与
       * `inherit=false` 截链）+ 同一个发布闸门，只是把"某个主体能不能看"换成
       * "哪个读者等级能看"。这样索引里的等级与判定的结论不会各自漂移。
       *
       *   - `rank === RANK_ORG`    ⇒ `1`（组织成员可见；**组织内可见不要求发布**，
       *                              理由见 buildAccess 里那段：D8 把存量条目回填成 org
       *                              而 published_at 保持 NULL，若要求发布则升级当天全站
       *                              条目对组织成员也不可见）
       *   - `rank === RANK_PUBLIC` ⇒ 已发布 ? `0` : `null`
       *                              （**发布闸门只约束 public 档** ⇒ 未发布的 public 页面
       *                               没有任何等级能看 ⇒ null，匿名搜索不得命中）
       *   - 其余（`RANK_PRIVATE` / 未知取值 / 页面不存在）⇒ `null`
       *
       * **失败关闭**：算不出来一律 `null`。写进 `blocks.tier` 的后果是"该块不被等级分支
       * 命中"（搜不到），而不是"被所有人搜到"。这条取舍由 `tier IS NULL` 计数探针兜住
       * （见 GET /api/admin/search/verify）。
       */
      async effectiveIndexLevel(slug: string, self?: PageVisRow): Promise<0 | 1 | null> {
        /*
         * ★ 内置文档覆盖（与 buildAccess 同一份判据、同一个服务现取）：隐藏的记账页
         * 返回 `null` = "没有任何通用主体读得到" ⇒ 块 `tier` 算成 NULL ⇒ **检索命中层
         * 也看不见它**。`blocks.tier` 是物化派生列（search 的命中谓词只看 tier，不再求
         * visibleSlugs 交集，见 plugin-search 的注释），所以隐藏开关翻动时由
         * `@geewiki/builtin-docs` 主动重同步记账页的 tier（`WikiService.resyncTiers`）；
         * 本函数负责的是另一半——**重算出来的结果必须正确**。
         * `self`（创建事务内的未提交行）也罩不住隐藏：先查覆盖再谈 self。
         */
        const bdHidden = builtinDocs()
        if (bdHidden !== undefined && bdHidden.isManagedPage(slug) && bdHidden.isHidden()) return null
        const index = await loadVisibilityIndex()
        if (self) {
          // 只覆盖自身那一行（调用方刚 INSERT、还没提交，另一条连接看不到）。
          // 祖先链仍按库里的真实状态算 —— 覆盖整条链就等于让调用方自己发明规则。
          index.set(slug, {
            slug,
            visibility: self.visibility,
            inherit: self.inherit === true || Number(self.inherit) === 1 ? 1 : 0,
            published_at: self.published_at ?? null,
          })
        }
        const row = index.get(slug)
        if (!row) return null
        const rank = effectiveRank(slug, index)
        if (rank === RANK_ORG) return 1
        if (rank === RANK_PUBLIC) return row.published_at !== null ? 0 : null
        return null
      },

      async resolvePages(rawP, slugs) {
        const p = requirePrincipal(rawP, 'resolvePages')
        const index = await loadVisibilityIndex()
        const grants = await loadGrants(p, slugs)
        const out = new Map<string, PageAccess>()
        for (const slug of slugs) {
          const row = index.get(slug)
          if (!row) {
            out.set(slug, {
              slug,
              level: 'none',
              canEdit: false,
              canDelete: false,
              canManageVisibility: false,
              reason: 'default-deny',
              project: <T extends { content?: string }>(payload: T): T => payload,
            })
            continue
          }
          // **批量判定不写覆盖审计**：列表页一次可能覆盖成百上千条，"逐条记一行"
          // 会让审计表迅速被管理员的日常浏览淹没。留痕落在**单条访问**（resolvePage）上，
          // 那才是"一次访问"。这条取舍在设计文档 §2.3 边界 1 的精神之内。
          out.set(slug, buildAccess(p, slug, effectiveRank(slug, index), row.published_at, grants.get(slug)).access)
        }
        return out
      },

      async visibleSlugs(rawP, q) {
        const p = requirePrincipal(rawP, 'visibleSlugs')
        const levels = new Set(q?.levels ?? ['full', 'summary'])
        const index = await loadVisibilityIndex()
        const candidates = [...index.keys()].filter((s) => (q?.prefix ? underPrefix(s, q.prefix) : true))
        const grants = await loadGrants(p, candidates)
        const out: string[] = []
        for (const slug of candidates) {
          const row = index.get(slug)
          if (!row) continue
          const access = buildAccess(p, slug, effectiveRank(slug, index), row.published_at, grants.get(slug)).access
          if (levels.has(access.level)) out.push(slug)
        }
        return out
      },

      /**
       * ★ P3b：块级授权的**唯一入口** —— 返回该主体被授予的**块 id 集合**。
       *
       * 三个必须守住的边界（前两条写在 P3a 的接口注释里，第三条是实现补充）：
       *
       * 1. **只返回块 id，绝不返回任何文本** —— 它唯一的消费者是检索的
       *    `OR b.id IN (:grantedBlockIds)` 与读路径的投影，两边都只需要"是不是这块"。
       *    返回文本会把受限内容带进这一层内存，正是 P3a 刻意避免的那类泄漏面。
       * 2. **必须按 `expires_at` 过滤** —— 过期授权不算授权。判定时比较即可，
       *    **不依赖后台清理任务**（清理只是回收空间，与 page_grants 同款）。
       * 3. **不做"表存在就查、不存在就空"的自适应** —— "没有授权"与"查不到授权表"
       *    在授权语义上是必须区分的两件事。缺表由激活期的表存在性自检显式报错。
       *
       * **为什么匿名与 break-glass 直接返回空集**：匿名的 `userId`/`groupIds` 都是空，
       * 不可能持有授予；break-glass 靠 owner/admin 的**应急覆盖**直接看全文（规则 O1），
       * 不经过授权分支。提前返回既省一次查询，也让"匿名拿到非空授权集合"这种不可能
       * 状态无从产生 —— 它在检索里会直接变成"匿名看见了 granted 块"。
       */
      async grantedBlockIds(rawP): Promise<readonly number[]> {
        const p = requirePrincipal(rawP, 'grantedBlockIds')
        if (p.kind !== 'user' || p.userId === null) return []

        const now = new Date().toISOString()
        const ids = new Set<number>()
        const rows = await db.query<{ block_id: number; expires_at: string | null }>(
          `SELECT block_id, expires_at FROM block_grants
            WHERE subject_kind = 'user' AND subject_id = ?`,
          [String(p.userId)],
        )
        const groupIds = p.groupIds.map((g) => String(g))
        if (groupIds.length > 0) {
          // 组授予：用 IN 一次取回（组集合来自 Principal.groupIds，已按 org 收窄）
          const placeholders = groupIds.map(() => '?').join(',')
          const groupRows = await db.query<{ block_id: number; expires_at: string | null }>(
            `SELECT block_id, expires_at FROM block_grants
              WHERE subject_kind = 'group' AND subject_id IN (${placeholders})`,
            groupIds,
          )
          rows.push(...groupRows)
        }
        for (const r of rows) {
          if (r.expires_at !== null && r.expires_at !== undefined && r.expires_at <= now) continue // 已过期 ⇒ 视同没有
          ids.add(Number(r.block_id))
        }
        return [...ids]
      },
    }

    /* ------------------------- P2：公开门户与收录控制 ------------------------- */

    /*
     * 门户是**服务端渲染**的：它必须在 `serveStatic` 之前接管 `/portal`，否则会拿到
     * SPA 的 index.html —— 外壳由 JS 渲染，爬虫与社交分享预览都看不到内容。
     * 路由注册天然优先于静态层（`dispatch` 先匹配路由，未命中才交给静态层）。
     *
     * ★ D4：门户**存在但不许搜索引擎收录**。三件套缺一不可：
     *   `robots.txt` 的 Disallow（管愿意守规矩的爬虫）+ `X-Robots-Tag` 响应头
     *   （管非 HTML 响应与"已被收录页面的重新抓取"）+ HTML `<meta name="robots">`（纵深）。
     * **但它们都不是访问控制** —— 内容本身只由 policy-service 裁剪，本文件不例外。
     */
    const SESSION_COOKIE = 'gw_sid'
    const X_ROBOTS_TAG = 'noindex, nofollow, noarchive'

    const hasSessionCookie = (h: RouteHandlerContext): boolean => {
      const raw = h.req.headers.cookie
      if (typeof raw !== 'string' || raw.length === 0) return false
      return raw.split(';').some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
    }

    /**
     * 门户类响应的缓存策略（§6.5）。
     *
     * 判 **cookie 存在性**而非会话有效性：判有效性要查库（每请求一次 IO），
     * 而存在性只是 header 解析；安全上后者更保守（拿任意垃圾 cookie 也走 `no-store`）。
     *
     * `Vary: Cookie` 是 `public` 与 `private` 之间的**正确性锚点**：即便某中间缓存
     * 忽略了 `no-store`，`Vary` 也保证不会把匿名渲染结果喂给登录用户
     * （web cache deception —— 这是唯一防线，不是可选项）。
     */
    /**
     * 门户类响应的缓存串 —— **提成常量**，供下面的运维端点如实复述。
     * 若在运维端点里再硬编码一份副本，两份必然漂移，而漂移的后果是
     * "运维按提示清了一个并不存在的缓存、真正共享缓存的那条却没清"。
     */
    const CACHE_PORTAL_ANON = 'public, max-age=60, s-maxage=300'
    const CACHE_PORTAL_PRIVATE = 'private, no-store'
    /** sitemap 刻意 `no-store`：它现在是运维的泄漏核对工具，不该被任何中间缓存留存 */
    const CACHE_SITEMAP = 'no-store, private'

    const setPortalHeaders = (h: RouteHandlerContext, contentType: string): void => {
      const setHeader = h.res?.setHeader
      // 测试替身可能没有 setHeader：那是夹具的能力问题，不该让请求失败
      if (typeof setHeader !== 'function') return
      setHeader.call(h.res, 'content-type', contentType)
      setHeader.call(
        h.res,
        'cache-control',
        hasSessionCookie(h) ? CACHE_PORTAL_PRIVATE : CACHE_PORTAL_ANON,
      )
      setHeader.call(h.res, 'vary', 'Cookie')
      setHeader.call(h.res, 'x-robots-tag', X_ROBOTS_TAG)
    }

    /** 最小 HTML 转义（门户要渲染 slug/title，两者都来自用户输入） */
    const esc = (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

    /** 匿名主体能看见的全部 slug —— 门户与 sitemap **共用**这一个出口（禁止第二份筛选逻辑） */
    const anonymousVisible = async (): Promise<string[]> => svc.visibleSlugs(anonymousPrincipal(), { levels: ['full'] })

    const router = ctx.get('http') as HttpRouterService | undefined
    if (router) {
      router.register('GET', '/robots.txt', (h: RouteHandlerContext) => {
        const setHeader = h.res?.setHeader
        if (typeof setHeader === 'function') {
          setHeader.call(h.res, 'content-type', 'text/plain; charset=utf-8')
          setHeader.call(h.res, 'cache-control', 'public, max-age=3600')
        }
        h.res.end('User-agent: *\nDisallow: /\n')
      }, { access: 'public' })

      /*
       * `sitemap.xml` 的定位在 D4 下变了：**不给爬虫，给运维做泄漏核对**
       * （与匿名可见集合做集合差必须为空 —— 这是一条可自动化的安全回归断言）。
       * 保留端点而不提交给搜索引擎，正是"安全价值留下、收录副作用去掉"。
       */
      router.register('GET', '/sitemap.xml', async (h: RouteHandlerContext) => {
        const slugs = await anonymousVisible()
        const setHeader = h.res?.setHeader
        if (typeof setHeader === 'function') {
          setHeader.call(h.res, 'content-type', 'application/xml; charset=utf-8')
          setHeader.call(h.res, 'cache-control', CACHE_SITEMAP)
          setHeader.call(h.res, 'x-robots-tag', X_ROBOTS_TAG)
        }
        /*
         * ⚠️ `/p/<slug>` 这个前缀**只是本端点的数据形态，不保证可解析**：全仓没有注册任何
         * `/p/...` 路由（真实读路径是 `/api/pages/:slug`；门户链接用 `/#/wiki/<slug>`）。
         * 本端点在 D4 下**不给爬虫、只给运维做集合差核对**（见上方注释），`<loc>` 的唯一消费者
         * 是运维脚本 —— 而**核对请走真实读路径** `/api/pages/:slug`（见
         * `packages/plugin-authz/test/e2e-p4.sh` 阶段 I 的 I1），不要照 `<loc>` 去请求：
         * 那会落进 serveStatic 的 SPA fallback、拿到 index.html + 200，看起来"可访问"。
         */
        const urls = slugs.map((s) => `  <url><loc>/p/${esc(s)}</loc></url>`).join('\n')
        h.res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>\n`)
      }, { access: 'public' })

      router.register('GET', '/portal', async (h: RouteHandlerContext) => {
        // 匿名主体：门户展出的必须与"未登录访客看得到的内容"逐字一致
        const slugs = await anonymousVisible()
        setPortalHeaders(h, 'text/html; charset=utf-8')
        const items = slugs.map((s) => `<li><a href="/#/wiki/${esc(s)}">${esc(s)}</a></li>`).join('\n')
        h.res.end(
          `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- ★ D4：不收录。这不是访问控制，内容是否可见只由 policy-service 决定。 -->
<meta name="robots" content="${X_ROBOTS_TAG}">
<title>知识库</title>
</head>
<body>
<main>
<h1>知识库</h1>
${slugs.length === 0 ? '<p>暂无公开内容。</p>' : `<ul>\n${items}\n</ul>`}
</main>
</body>
</html>
`,
        )
      }, { access: 'public' })

      /*
       * ---------- GET /api/admin/audit：审计查询（★ P4） ----------
       *
       * `view` 把**两类记录分开**（§8.2 P4 第 4 条）：越权尝试属于**安全事件**（要告警），
       * 权限变更属于**合规记录**（要留存）。混在一个视图里，"有人在探测权限边界"会被
       * "某人改了可见性"稀释掉，而两者的处置完全不同。
       *
       * **为什么用显式白名单而不是"排除法"**：排除法会把将来新增的每个动作**默认**归进
       * acl 视图；白名单则让未分类的动作**只出现在 `all` 里** —— 漏分类是**可见的**，
       * 而不是悄悄进了错误的视图。安全事件被误分类的代价远高于多维护一个集合。
       */
      const SECURITY_ACTIONS = new Set([
        'access.denied', // 越权尝试（"页存在但无权看"）；由 @geewiki/wiki 独家写入
        'access.admin_override', // owner/admin 应急可见：特权访问，要复查
        'access.break_glass', // 应急令牌：特权访问，要复查
        'login.fail',
        'login.rate_limited',
      ])
      const ACL_ACTIONS = new Set([
        'acl.change',
        'acl.resync_failed',
        'page.publish',
        /*
         * 附件的内容变更（X5）。**为什么归 acl 视图而不是 security 视图**：
         * 这两个动作都是"**已获授权的主体做成了某事**"，没有发生权限判定失败 ——
         * 它们要回答的是"这份附件是谁传的 / 谁删的"（合规追溯），
         * 而不是"谁在被拒绝"（要告警）。安全视图（`SECURITY_ACTIONS`）里的动作
         * 全部以"被拒/被限流/走了应急通道"为共同特征，把正常的上传塞进去会**稀释告警**，
         * 让"有人在探测权限边界"淹没在正常流量里 —— 这正是白名单存在的理由。
         * 两者的另一半（越权上传/越权删除）不受影响：它们由 `access.denied` 记录，
         * 本来就落在安全视图里。
         */
        'attachment.upload',
        'attachment.delete',
        /*
         * 页面删除。**为什么必须进白名单**：不进的话它只出现在 `all` 视图，
         * 而"谁把一篇页面删了"恰恰是最需要被合规追溯的动作 —— 保存与恢复都有
         * `page_versions` 兜底（可回滚），删除是**唯一不可逆**的正文变更。
         * 归 acl 而不是 security 的理由与附件同款：它是"已获授权的主体做成了某事"，
         * 要回答"谁删的"，不是"谁在被拒"（越权删除由 `access.denied` 落在安全视图）。
         */
        'page.delete',
        /*
         * 正文保存。**为什么也要进白名单**（而不只是留在 `view=all`）：
         * 版本历史回答的是"内容改过几次"，审计回答的是"**谁**在什么时候动过它" ——
         * 排查通常从审计入口进来，而不分类的动作在界面上等于不存在。
         * 噪音顾虑是真实的（每次保存一条），但代价可接受：审计表的定位就是append-only
         * 的合规记录，而"这条页面最近被谁动过"恰恰是最高频的问询。
         */
        'page.save',
        'identity.link',
        'identity.unlink',
        'user.create',
        'user.setup',
        'password.change',
        'rollback',
        'meltdown',
        'none',
        'admin.resync_tiers',
        'admin.verify_blocks',
        'admin.verify_search',
        'admin.session_revoke',
        'admin.grants_purge',
        'admin.access_explain',
        'admin.verify_sitemap',
        'admin.cache_plan',
        'org.group.add_member',
        'org.group.create',
        'org.group.delete',
        'org.group.remove_member',
        'org.invitation.accept',
        'org.invitation.create',
        'org.invitation.purge',
        'org.invitation.redeem',
        'org.invitation.revoke',
        'org.member.remove',
        'org.member.set_role',
      ])

      /** 单页上限：审计表是 append-only 且无上界增长（§9 R16 的邻域），不给上限等于给了一个全表下载口 */
      const AUDIT_PAGE_MAX = 200

      interface AuditRow {
        id: number
        at: string
        actor_id: number | null
        actor_ip_hash: string | null
        action: string
        target_kind: string
        target_id: string
        before_json: string | null
        after_json: string | null
        request_id: string | null
      }

      const parseAuditJson = (s: string | null): unknown => {
        if (s === null || s === '') return null
        try {
          return JSON.parse(s) as unknown
        } catch {
          // 不抛：一条损坏的审计行不该让整个查询失败。显式标注而不是静默当成 null
          return { _unparseable: true }
        }
      }

      router.register(
        'GET',
        '/api/admin/audit',
        async (h: RouteHandlerContext) => {
          const q = h.url.searchParams
          const view = q.get('view') ?? 'all'
          if (view !== 'all' && view !== 'acl' && view !== 'security') {
            h.json(400, {
              ok: false,
              error: 'invalid_view',
              message: 'view 须为 all | acl | security 之一',
            })
            return
          }

          const where: string[] = []
          const params: unknown[] = []
          if (view === 'acl' || view === 'security') {
            const names = [...(view === 'acl' ? ACL_ACTIONS : SECURITY_ACTIONS)]
            where.push(`action IN (${names.map(() => '?').join(', ')})`)
            params.push(...names)
          }
          for (const [key, column] of [
            ['action', 'action'],
            ['targetKind', 'target_kind'],
            ['targetId', 'target_id'],
          ] as const) {
            const v = q.get(key)
            if (v !== null && v !== '') {
              where.push(`${column} = ?`)
              params.push(v)
            }
          }
          const since = q.get('since')
          if (since !== null && since !== '') {
            where.push('at >= ?')
            params.push(since)
          }
          const until = q.get('until')
          if (until !== null && until !== '') {
            where.push('at <= ?')
            params.push(until)
          }
          const sql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

          const rawLimit = Number(q.get('limit') ?? AUDIT_PAGE_MAX)
          const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(1, Math.trunc(rawLimit)), AUDIT_PAGE_MAX)
            : AUDIT_PAGE_MAX
          const rawOffset = Number(q.get('offset') ?? 0)
          const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0

          const countRows = await db.query<{ n: number | string }>(
            `SELECT COUNT(*) AS n FROM audit_log${sql}`,
            params,
          )
          // PG 的 COUNT(*) 返回字符串，必须强转（否则 "1" + 1 → "11"）
          const total = Number(countRows[0]?.n ?? 0)
          const rows = await db.query<AuditRow>(
            `SELECT id, at, actor_id, actor_ip_hash, action, target_kind, target_id,
                    before_json, after_json, request_id
               FROM audit_log${sql}
              ORDER BY at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [...params, limit, offset],
          )

          h.json(200, {
            ok: true,
            view,
            total,
            limit,
            offset,
            entries: rows.map((r) => ({
              id: r.id,
              at: r.at,
              actorId: r.actor_id,
              actorIpHash: r.actor_ip_hash,
              action: r.action,
              targetKind: r.target_kind,
              targetId: r.target_id,
              before: parseAuditJson(r.before_json),
              after: parseAuditJson(r.after_json),
              requestId: r.request_id,
            })),
          })
        },
        { access: 'admin' },
      )

      /*
       * ---------- POST /api/admin/grants/purge：回收已过期的条目授权（★ P4） ----------
       *
       * ⚠️ **这不是"让过期授权失效"的手段** —— 失效在**判定时**就已经发生：
       * `loadGrants` 里那句 `if (r.expires_at <= now) continue // 已过期 ⇒ 视同没有`。
       * 本条端点只做**空间回收**（§8.2 P4 第 3 条原话："无需人工清理即生效；清理任务只是回收"）。
       *
       * **为什么非要把这层区分写进注释和响应**：一旦它被当成"失效开关"，就会派生出
       * "清理任务没跑 ⇒ 过期授权仍然有效"这种最糟的误解 —— 而那是**失败开放**方向。
       * 响应里同时给 `expired`（本次回收数）与 `remaining`（表里还剩多少），
       * 让运维一眼看出这条端点的作用域。
       *
       * **只在真的回收了东西时才写审计**：与"踢人下线"不同，维护动作的空跑没有副作用，
       * 每 N 分钟记一条"回收了 0 条"只会把审计淹掉。有副作用才留痕。
       */
      router.register(
        'POST',
        '/api/admin/grants/purge',
        async (h: RouteHandlerContext) => {
          const now = new Date().toISOString()
          const count = async (): Promise<number> => {
            const rows = await db.query<{ n: number | string }>(
              'SELECT COUNT(*) AS n FROM page_grants WHERE expires_at IS NOT NULL AND expires_at <= ?',
              [now],
            )
            // PG 的 COUNT(*) 返回字符串，必须强转
            return Number(rows[0]?.n ?? 0)
          }
          const expired = await count()
          if (expired > 0) {
            await db.run(
              'DELETE FROM page_grants WHERE expires_at IS NOT NULL AND expires_at <= ?',
              [now],
            )
          }
          const remainRows = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM page_grants',
            [],
          )
          const remaining = Number(remainRows[0]?.n ?? 0)
          if (expired > 0) {
            void writeAuditLog(db, {
              action: 'admin.grants_purge',
              targetKind: 'grant',
              targetId: 'page_grants',
              actorId: h.principal?.userId ?? null,
              actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
              after: { expired, remaining, at: now },
            }).catch((e: unknown) => console.error('[@geewiki/authz] 回收审计写入失败:', e))
          }
          h.json(200, { ok: true, expired, remaining, at: now })
        },
        { access: 'admin' },
      )

      /*
       * ---------- GET /api/admin/access-explain：反向展开「谁能看这条」（★ P4b） ----------
       *
       * §8.1 P4 的原始要求：**不做递归实现**，只如实展示**三条来源**，并标注每一条是
       * "正在起作用"还是"可能相关"。设计意图是让人**一眼看出"为什么这个人看得到"**，
       * 而不是丢回一个还需要二次推导的中间结果。
       *
       * 三条来源的**真实强度不同**，这个区分就是本端点的全部价值：
       *   1. 直接授予（`page_grants` / `block_grants`）—— **确定生效**：`decideNormally`
       *      里授予分支排在档位之前，授予是"明确指名的例外"（§2.3 优先级表）。
       *   2. 祖先链 —— 逐级复述 `effectiveRank` 在这个 slug 上的**真实遍历过程**：
       *      哪一级**真的收紧了**、哪一级因 `inherit=false` **截断了链条**（其以上不再下传，
       *      故标 `not_consulted`）、哪些祖先**根本不存在**（红链/未建页 —— **不构成收紧、
       *      也不截断**，见 `effectiveRank` 里那个 `continue`）。
       *   3. 组织角色 / owner-admin 应急覆盖（D14）—— **与主体有关**，故只标相关、不标生效。
       *
       * ⚠️ **复用 `loadVisibilityIndex` / `effectiveRank` / `ancestorsOf` / `decideNormally`，
       * 绝不重写判定**：第二份实现必然与判定单点漂移，而漂移的后果是
       * "解释是对的、实际判定却是另一个" —— 那比没有解释更糟。
       *
       * ⚠️ 响应**不含正文、不含任何块文本**：本端点是排障与治理工具，不是读取通道。
       */
      interface ExplainGrantRow {
        subject_kind: string
        subject_id: string
        role: string
        granted_at: string | null
        expires_at: string | null
      }

      router.register(
        'GET',
        '/api/admin/access-explain',
        async (h: RouteHandlerContext) => {
          const slug = (h.url.searchParams.get('slug') ?? '').trim()
          if (slug === '') {
            h.json(400, { ok: false, error: 'missing_slug', message: '需要 slug 查询参数' })
            return
          }
          const index = await loadVisibilityIndex()
          const self = index.get(slug)
          if (self === undefined) {
            // 不编造：页面不存在就如实说，**不推测**"可能是红链"——那需要调用方自己判断
            h.json(404, { ok: false, error: 'page_not_found', message: `页面不存在: ${slug}` })
            return
          }

          const rank = effectiveRank(slug, index)
          const publishedAt = self.published_at ?? null

          // ---- 来源 2：祖先链（逐级、如实） ----
          /*
           * ⚠️ `tightens` 必须拿**累计档位**（runningRank）做基准，而不是拿**本条页面的档位**：
           * 后者会把"本来就已经被更近的祖先收到同一档、删掉它也不改变结果"的祖先也标成收紧了。
           * 反例：`c`=public、`a/b`=org、`a`=org —— 两条祖先的档位都高于 `c`，但真正起作用的是
           * 更近的 `a/b`，`a` 只是重复。与 `effectiveRank` 里那句 `rank = Math.max(rank, …)`
           * 逐级累积是同一个口径。
           */
          let runningRank = rankOf(self.visibility)
          const ancestors: Record<string, unknown>[] = []
          let broken = false
          for (const anc of ancestorsOf(slug)) {
            if (broken) {
              ancestors.push({ slug: anc, effect: 'not_consulted', reason: 'chain_break_above' })
              continue
            }
            const row = index.get(anc)
            if (row === undefined) {
              ancestors.push({
                slug: anc,
                effect: 'not_present',
                reason: 'missing_ancestor_does_not_tighten',
              })
              continue
            }
            if (row.inherit !== 1) {
              broken = true
              ancestors.push({
                slug: anc,
                visibility: row.visibility,
                inherit: false,
                effect: 'chain_break',
                reason: 'inherit=false ⇒ 本级及其以上都不再下传',
              })
              continue
            }
            const ancRank = rankOf(row.visibility)
            const tightens = ancRank > runningRank
            if (tightens) runningRank = ancRank
            ancestors.push({
              slug: anc,
              visibility: row.visibility,
              inherit: true,
              effect: tightens ? 'tightens' : 'no_effect',
            })
          }

          // ---- 来源 1：直接授予（页级 + 块级），含过期状态 ----
          const now = new Date().toISOString()
          const grantView = (r: ExplainGrantRow): Record<string, unknown> => ({
            subjectKind: r.subject_kind,
            subjectId: r.subject_id,
            role: r.role,
            grantedAt: r.granted_at,
            expiresAt: r.expires_at,
            // 过期判定与 `loadGrants` 逐字同款：`expires_at <= now` ⇒ 视同没有
            status: r.expires_at !== null && r.expires_at <= now ? 'expired' : 'active',
          })
          const pageGrantRows = await db.query<ExplainGrantRow>(
            `SELECT subject_kind, subject_id, role, granted_at, expires_at
               FROM page_grants WHERE page_slug = ? ORDER BY granted_at, subject_kind, subject_id`,
            [slug],
          )
          // 块级授予用冗余的 `page_slug` 列查 —— 它存在的理由正是"治理查询与排障"，
          // 因此**不需要**读 @geewiki/wiki 拥有的 `blocks` 表：判定插件不跨界读别人的表。
          // （代价：这里给不出块序号 ordinal，调用方需要时配合 wiki 的页面端点自行映射。）
          //
          // ⚠️ **表可能不存在**（`block_grants` 是 0016 迁移建的，而 P3b 之前没有它）⇒
          // 这里**显式区分"没有块级授予"与"查不到块级授予表"**：前者是正常情形（`available: true`
          // 且列表为空），后者必须如实上报 `available: false`，**不能静默当成空集** ——
          // 那会让排障的人以为"没人有块级授权"，而真相是"这张表根本没建起来"。
          // 与 `grantedBlockIds()` 的激活期自检同一条纪律。
          let blockGrants: Record<string, unknown>[] = []
          let blockGrantsAvailable = true
          try {
            const rows = await db.query<ExplainGrantRow>(
              `SELECT subject_kind, subject_id, role, granted_at, expires_at
                 FROM block_grants WHERE page_slug = ? ORDER BY granted_at, subject_kind, subject_id`,
              [slug],
            )
            blockGrants = rows.map(grantView)
          } catch (err) {
            blockGrantsAvailable = false
            console.warn(
              '[@geewiki/authz] access-explain: 读取 block_grants 失败（该表可能未建）——' +
                '本次如实上报 available:false，不把它伪装成"空集"。原因:',
              err,
            )
          }
          const pageGrants = pageGrantRows.map(grantView)
          const anyActive = (rows: Record<string, unknown>[]): boolean =>
            rows.some((g) => g['status'] === 'active')

          // ---- 与实际判定同源的可达性 ----
          // 匿名：直接调 `decideNormally` + 真实的 `anonymousPrincipal()`，逐字同源。
          const anon = decideNormally(rank, publishedAt, undefined, anonymousPrincipal())
          // 组织成员：`decideNormally` 需要 `kind === 'user' && orgRole !== null`。
          // **刻意不构造"假 Principal"** —— 假主体一旦与真实 Principal 形状漂移，
          // 解释就会开始撒谎。这里如实复述它的两条分支（出处：本文件的 decideNormally）。
          const orgMemberCanSee = (rank === RANK_PUBLIC && publishedAt !== null) || rank === RANK_ORG

          h.json(200, {
            ok: true,
            slug,
            self: { visibility: self.visibility, inherit: self.inherit === 1, publishedAt },
            positionalRank: rank,
            reach: {
              // "本来会怎样"——**不含** D14 应急覆盖；特权路径见 sources.adminOverride
              anonymous: anon.level === 'full' ? 'full' : 'none',
              anonymousReason: anon.reason,
              orgMember: orgMemberCanSee ? 'full' : 'none',
            },
            sources: {
              ancestors,
              grants: {
                pages: pageGrants,
                blocks: blockGrants,
                // `available: false` = 查不到块级授予表（区别于"没有块级授予"）
                blockGrantsAvailable,
                effective: anyActive(pageGrants) || (blockGrantsAvailable && anyActive(blockGrants)),
              },
              orgRole: {
                // 与主体有关 ⇒ 只标"相关"，不标"生效"（生效与否取决于看的人是不是成员）
                effective: false,
                relevant: true,
                rule:
                  "rank === org 时，kind === 'user' 且 orgRole !== null 的成员可见" +
                  '（D8：组织内可见不要求发布）',
              },
              adminOverride: {
                effective: false,
                relevant: true,
                rule: 'owner/admin 可应急可见，每次覆盖式访问写 access.admin_override 审计（D14）',
              },
            },
          })

          void writeAuditLog(db, {
            action: 'admin.access_explain',
            targetKind: 'page',
            targetId: slug,
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
            after: { positionalRank: rank, anonymous: anon.level, orgMember: orgMemberCanSee },
          }).catch((e: unknown) => console.error('[@geewiki/authz] 反向展开的审计写入失败:', e))
        },
        { access: 'admin' },
      )

      /*
       * ---------- GET /api/admin/sitemap-audit：sitemap 与「匿名可读」的交叉核对（★ P4b） ----------
       *
       * §5.12 把 `sitemap.xml` 的定位从"给爬虫"改成"**给运维做泄漏核对**"：与匿名可见集合
       * 做集合差必须为空。但这里有一个**必须如实说明**的事实：
       *
       * ⚠️ **关于本端点的实际信息量，必须说实话**（我第一版把它写大了，这里纠正）：
       * `sitemap.xml` 由 `anonymousVisible()` 生成，而 `anonymousVisible()` 走
       * `svc.visibleSlugs()` → `buildAccess()` → `decideNormally()`；本端点复算用的也是
       * `decideNormally()`。**对匿名主体这两条是同一套规则，所以今天 `unreadable` 与
       * `omitted` 都恒为空** —— 它不是"两条独立来源的差集"，而是：
       *   - `page_missing`：列表里有、`pages` 里已经没有这一行（真实可发生的漂移）；
       *   - **规则漂移哨兵**：若将来 `buildAccess()` 为匿名加了新规则而没同步
       *     `decideNormally()`，这里会立刻不一致 —— 这是本端点唯一的结构性价值。
       *
       * **真正独立的口径在端到端层面**：`packages/plugin-authz/test/e2e-p4.sh`
       * 的阶段 I 会取自 `/sitemap.xml` 的每个 `<loc>`，再**逐条真去匿名读一次**并断言
       * 全部拿得到 —— 那才是 §5.12 想要的"集合差为空"，因为读是**另一条 HTTP 路径**。
       * 进程内没法做这件事（要自打 HTTP），所以两处各司其职。
       */
      router.register(
        'GET',
        '/api/admin/sitemap-audit',
        async (h: RouteHandlerContext) => {
          const index = await loadVisibilityIndex()
          const advertised = await anonymousVisible()
          const advertisedSet = new Set(advertised)
          const anonCanRead = (slug: string): { level: string; reason: string } => {
            const self = index.get(slug)
            if (self === undefined) return { level: 'missing', reason: 'page_missing' }
            const d = decideNormally(
              effectiveRank(slug, index),
              self.published_at ?? null,
              undefined,
              anonymousPrincipal(),
            )
            return { level: d.level, reason: d.reason }
          }

          const unreadable: Record<string, unknown>[] = []
          for (const slug of advertised) {
            const r = anonCanRead(slug)
            if (r.level !== 'full') unreadable.push({ slug, reason: r.reason })
          }

          const omitted: string[] = []
          for (const slug of index.keys()) {
            if (advertisedSet.has(slug)) continue
            if (anonCanRead(slug).level === 'full') omitted.push(slug)
          }

          h.json(200, {
            ok: true,
            // ⚠️ 恒为 true，且**今天两个方向都恒为空**（理由见上方注释）：本端点不是
            // "两条独立来源的差集"，它的价值是 page_missing 与规则漂移哨兵。
            // 真正独立的口径在 e2e（取自 /sitemap.xml 再逐条匿名读）。
            sameSource: true,
            advertisedCount: advertised.length,
            unreadable,
            omitted,
            consistent: unreadable.length === 0,
          })

          void writeAuditLog(db, {
            action: 'admin.verify_sitemap',
            targetKind: 'sitemap',
            targetId: 'sitemap.xml',
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
            after: {
              advertisedCount: advertised.length,
              unreadable: unreadable.length,
              omitted: omitted.length,
            },
          }).catch((e: unknown) => console.error('[@geewiki/authz] sitemap 核对的审计写入失败:', e))
        },
        { access: 'admin' },
      )

      /*
       * ---------- GET /api/admin/cache-plan：权限收紧后的清缓存指引（★ P4b，§5.10） ----------
       *
       * 为什么需要它：门户 `/portal` 对**匿名**响应允许共享缓存（`s-maxage=300`），所以
       * "收紧某条可见性"之后，CDN 上可能还留着**旧的匿名渲染结果**。那不是判定错误
       * （判定每请求现查库、收紧立即生效），而是**缓存里的陈旧副本**。
       *
       * 本端点如实复述**实际的缓存串**（取自与设置响应头**同一个常量**，不是另抄一份），
       * 并报出自 `since` 以来的 ACL 变更类审计条数 —— 让"要不要清、清哪一条"有依据。
       *
       * ⚠️ 它**不**自己去清缓存：本进程看不见 CDN。这里给的是**依据与目标**。
       */
      router.register(
        'GET',
        '/api/admin/cache-plan',
        async (h: RouteHandlerContext) => {
          const sinceRaw = h.url.searchParams.get('since')
          const since =
            sinceRaw !== null && sinceRaw !== ''
              ? sinceRaw
              : new Date(Date.now() - 24 * 3600 * 1000).toISOString()
          const rows = await db.query<{ action: string; n: number | string }>(
            `SELECT action, COUNT(*) AS n FROM audit_log
              WHERE at >= ?
                AND action IN ('acl.change','page.publish','rollback','admin.resync_tiers')
              GROUP BY action ORDER BY n DESC`,
            [since],
          )
          const events = rows.map((r) => ({ action: r.action, count: Number(r.n) }))
          const eventCount = events.reduce((a, e) => a + e.count, 0)
          h.json(200, {
            ok: true,
            since,
            events,
            eventCount,
            purgeRecommended: eventCount > 0,
            sharedCacheable: [
              {
                path: '/portal',
                cacheControl: CACHE_PORTAL_ANON,
                vary: 'Cookie',
                note: '仅**匿名**响应可被共享缓存；带任何 cookie 时走 private, no-store',
              },
            ],
            notSharedCacheable: [
              { path: '/sitemap.xml', cacheControl: CACHE_SITEMAP },
              { path: '/api/*', cacheControl: '（未设共享缓存头，默认不可共享缓存）' },
            ],
            targets: ['/portal'],
            note:
              '判定每请求现查库，收紧**立即生效**；需要处理的是共享缓存里的旧匿名渲染。' +
              'sitemap 是 no-store，无需清理。',
          })

          void writeAuditLog(db, {
            action: 'admin.cache_plan',
            targetKind: 'cache',
            targetId: 'portal',
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(h.req.socket?.remoteAddress ?? null),
            after: { since, eventCount },
          }).catch((e: unknown) => console.error('[@geewiki/authz] 清缓存指引的审计写入失败:', e))
        },
        { access: 'admin' },
      )
    }

    const unprovide = ctx.provide('policy-service', svc)
    console.log('[@geewiki/authz] 已激活: policy-service 服务（可见性判定的唯一真源）')
    return () => unprovide()
  },
}
