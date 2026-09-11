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
      const normal = decideNormally(rank, publishedAt, grant, p)
      let level = normal.level
      let reason = normal.reason
      let overrode = false
      if (level === 'none' && isAdminRole(p)) {
        // ★ 规则 O1：owner/admin 恒可看一切。**只在"本来会被拒"时才算覆盖** ——
        // 否则管理员的日常浏览会把审计表刷爆，真实信号被噪声淹没（§2.3 边界 1）。
        level = 'full'
        reason = p.orgRole === 'owner' ? 'owner' : 'admin'
        overrode = true
      }
      const canEdit = level === 'full' && (normal.canEdit || isAdminRole(p))
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
       * ★ P3a：块级授权的**唯一入口**。
       *
       * 现在恒为空数组，因为 `block_grants` 表属 P3b（`0016_block_grants.sql`）——
       * 在它落地之前，**不存在任何块级授权**，空数组是语义正确的结果。
       * 检索侧因此退化为"只看 `tier` 等级分支"，与其 SQL 里的 `OR b.id IN (...)`
       * 收在恒假分支上，行为等价。
       *
       * **为什么不做"表存在就查、不存在就空"的自适应**：那会让同一份代码在不同
       * schema 版本下走不同分支，而"没有授权"与"查不到授权表"在授权语义上是**必须
       * 区分**的两件事（后者应当显式失败，而不是静默降级成"没人有权限"或"所有人有权限"）。
       * P3b 落地这张表时，把本方法换成真实查询即可 —— 调用方无需改动。
       */
      async grantedBlockIds(rawP): Promise<readonly number[]> {
        requirePrincipal(rawP, 'grantedBlockIds')
        return []
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
    const setPortalHeaders = (h: RouteHandlerContext, contentType: string): void => {
      const setHeader = h.res?.setHeader
      // 测试替身可能没有 setHeader：那是夹具的能力问题，不该让请求失败
      if (typeof setHeader !== 'function') return
      setHeader.call(h.res, 'content-type', contentType)
      setHeader.call(
        h.res,
        'cache-control',
        hasSessionCookie(h) ? 'private, no-store' : 'public, max-age=60, s-maxage=300',
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
      })

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
          setHeader.call(h.res, 'cache-control', 'no-store, private')
          setHeader.call(h.res, 'x-robots-tag', X_ROBOTS_TAG)
        }
        const urls = slugs.map((s) => `  <url><loc>/p/${esc(s)}</loc></url>`).join('\n')
        h.res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>\n`)
      })

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
      })
    }

    const unprovide = ctx.provide('policy-service', svc)
    console.log('[@geewiki/authz] 已激活: policy-service 服务（可见性判定的唯一真源）')
    return () => unprovide()
  },
}
