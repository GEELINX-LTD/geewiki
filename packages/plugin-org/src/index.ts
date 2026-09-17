/**
 * `@geewiki/org` —— 组织与团队管理（P2）
 *
 * 见 docs/design/access-control.md §3.2、§2.1、§8.1 的 P2 行。
 *
 * 本插件回答的是"**谁在这个组织里、是什么身份、属于哪些组**"，不回答"谁能看哪条内容"
 * ——后者是 `policy-service`（@geewiki/authz）的职责。这条分工是设计文档 §2.0 那两条
 * 正交的轴在本插件里的体现：**角色只管能力**。
 *
 * ## 为什么 `org-service` 只暴露读接口
 *
 * 写操作全部走 HTTP 端点（它们需要 `Principal` 才能做权限判定，而服务契约是全局单例、
 * 不接受主体）。把 `setRole(userId, role)` 这样的方法放到服务上，会诱使将来的调用方
 * **绕过权限判定**直接改角色 —— 这正是设计文档 §9 R2 点名的反模式。所以服务面只给
 * "读"：`roleOf` / `groupIdsOf` 是纯查询，无主体也不构成越权。
 *
 * ## 与 @geewiki/auth 的分工
 *
 * 角色的**判定**（把 `org_members.role` 装进 `Principal`）发生在 auth 的钩子里，本插件
 * 只负责**维护**这张表。两边直读同一张表是刻意的：`org_members` 与 `users`/`sessions`
 * 同属核心基础设施表（由 db 插件的 0011 迁移建立），不是某个业务插件的私有数据。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  asAsync,
  auditIpHash,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type DatabaseAdapterAsync,
  type DatabaseExecutor,
  type GeeWikiManifest,
  type HttpRouterService,
  type Principal,
  type RouteHandlerContext,
} from '@geewiki/core'

/* ============================== 配置 ============================== */

export interface OrgConfig {
  /** 邀请有效期（天）。默认 7。 */
  invitationTtlDays?: number
}

export const OrgConfigSchema = Schema.object({
  invitationTtlDays: Schema.number()
    .default(7)
    .min(1)
    .max(365)
    .description('邀请链接的有效期（天）'),
})

/* ============================== 类型 ============================== */

/** 组织角色。**只管能力，不是授权对象**（§2.0 / D13）。 */
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer']

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)
}

/** 管理类动作只允许 owner/admin（与 `judgeAccess` 的 `access:'admin'` 判据一致） */
function isAdminRole(role: Principal['orgRole'] | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export interface OrgMemberView {
  userId: number
  email: string
  displayName: string
  role: OrgRole
  joinedAt: string
}

export interface OrgGroupView {
  id: number
  name: string
  createdAt: string
  memberIds: number[]
}

export interface OrgInvitationView {
  id: string
  email: string
  /** `null` = guest 通道（入伙但不给组织角色） */
  orgRole: OrgRole | null
  groupId: number | null
  expiresAt: string
  acceptedAt: string | null
  createdAt: string
}

/**
 * 对外服务契约。**全部是只读查询** —— 理由见文件头注释。
 */
export interface OrgService {
  /** 用户在组织里的角色；无行 = guest ⇒ `null` */
  roleOf(userId: number): Promise<OrgRole | null>
  /** 用户所属的组 id（已按 org 收窄） */
  groupIdsOf(userId: number): Promise<number[]>
  /** 组织成员总数。用于"是否还有 owner"这类不变式检查与界面上的人数展示 */
  memberCount(): Promise<number>
}

/** 默认组织 id。本期单组织（D1）：恒为 1，由 0011 的幂等种子建立。 */
const DEFAULT_ORG_ID = 1

/**
 * `auth-service` 的**最小结构需求**（结构化类型，刻意不 import `@geewiki/auth` 的模块）。
 *
 * 为什么用结构化类型而不是 import 那个包：插件之间的依赖应当经**服务标识**
 * （manifest 的 `requires: ['auth-service']`）表达，而不是经包名。import 了具体模块，
 * 就等于把"组织功能"钉死在"auth 这个包"上 —— 而将来完全可能换一个身份实现
 * （OIDC-only、外部 IdP 代理），只要它 `ctx.provide('auth-service', …)` 就应当能接上。
 */
interface AuthServiceLike {
  createLocalUser(input: {
    email: string
    displayName: string
    password: string
  }): Promise<
    { ok: true; userId: number } | { ok: false; error: 'email_taken' | 'invalid_email' | 'invalid_password' }
  >
}

const MAX_BODY_BYTES = 64 * 1024
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX = 254
const GROUP_NAME_MAX = 80

/* ============================== 小工具 ============================== */

/*
 * 下面两个 helper 与 @geewiki/auth/src/index.ts 里的同名函数是**刻意的重复**：
 * 让一个业务插件 import 另一个业务插件的内部工具，会造出一条"组织功能依赖身份插件
 * 实现细节"的耦合 —— 而它们本该只经核心契约（http-service / database-provider）通信。
 * 两边都只有十几行，重复的代价远小于耦合的代价。
 */
async function readJsonBody(h: RouteHandlerContext): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of h.req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) {
      h.req.pause()
      throw new Error(`payload_too_large: 请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid_body: 请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid_body: 请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? '-'
}

/** 由原始令牌算 DB 存储用的哈希（与 sessions 同款纪律：DB 泄露不可直接冒用） */
function tokenHashOf(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function isoPlus(from: Date, ms: number): string {
  return new Date(from.getTime() + ms).toISOString()
}

/* ============================== 清单 ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/org',
  version: '0.1.0',
  geewiki: {
    displayName: '组织与团队',
    description: '成员与角色、组、邀请，并提供 org-service 供策略层查询',
    provides: 'org-service',
    // `auth-service` 是**顺序依赖**而非调用依赖：本插件的端点读 `h.principal`，
    // 而 principal 由 @geewiki/auth 的钩子填充。声明它可以让管理器保证激活顺序，
    // 避免出现"org 先激活、于是所有请求都看到匿名主体"的启动期竞态。
    requires: ['http-service', 'database-provider', 'auth-service'],
    conflictGroup: undefined,
    // 本插件没有自己的迁移：org_* 表由 db 插件的 0011_org_team.sql 建立
    // （与 users/sessions 同属核心基础设施，不属于某个业务插件）。
    migrations: undefined,
    runtime: {
      // **不可热插拔**：热卸载会让"谁是 owner"这个问题瞬间无人可答，
      // 而 `access:'admin'` 的判定依赖它 —— 与 auth 同理，没有安全的即时降级方式。
      supportsHotReload: false,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: OrgConfigSchema,
  },
}

/* ============================== 插件本体 ============================== */

export const OrgPlugin = {
  name: '@geewiki/org',
  Config: OrgConfigSchema,

  async apply(ctx: Context, config: OrgConfig = {}) {
    const rawDb = ctx.get('db') as AnyDatabaseAdapter | undefined
    if (!rawDb) throw new Error('@geewiki/org: 数据库服务不可用（没有任何插件提供 database-provider）')
    const db: DatabaseAdapterAsync = asAsync(rawDb)
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/org: http 路由服务不可用（@geewiki/http 未激活）')

    const invitationTtlMs = (config.invitationTtlDays ?? 7) * 24 * 3600 * 1000

    /*
     * 表存在性自检（与 @geewiki/auth 同款）：缺表就**指名道姓**抛错，
     * 而不是等第一个请求才零散地报 `no such table: org_members`。
     *
     * 探测方式是 `SELECT 1 FROM t WHERE 1 = 0`：它在 SQLite 与 PostgreSQL 上**同样有效**，
     * 不必先查 `sqlite_master`（那张表在 PG 上不存在，会让自检本身分叉成两条路径）。
     */
    for (const table of ['orgs', 'org_members', 'groups', 'group_members', 'invitations']) {
      try {
        await db.query(`SELECT 1 FROM ${table} WHERE 1 = 0`)
      } catch (err) {
        throw new Error(
          `@geewiki/org: 缺少表 ${table} —— 请确认 db 插件的 0011_org_team.sql 已应用（${(err as Error).message}）`,
        )
      }
    }

    /* ---------- 审计 ---------- */
    const audit = (entry: {
      action: string
      targetKind: string
      targetId: string
      actorId?: number | null
      actorIpHash?: string | null
      before?: unknown
      after?: unknown
    }): void => {
      void writeAuditLog(db, entry).catch((err: unknown) => {
        console.error('[@geewiki/org] 审计写入失败:', err)
      })
    }

    /* ---------- 不变式 ---------- */

    /**
     * 组织里 owner 的数量。
     *
     * **这是本插件最重要的不变式**：owner 是唯一能授予/撤销 owner 的角色，
     * 一旦归零，组织将永久失去管理能力 —— 没有自助恢复路径（只能改库）。
     * 所以"降级最后一个 owner"与"移除最后一个 owner"都必须被拒绝，
     * 且检查与写入要在**同一事务**里，否则两个并发请求会各自看到"还剩一个"。
     */
    const countOwners = async (exec: DatabaseExecutor): Promise<number> => {
      const rows = await exec.query<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'`,
        [DEFAULT_ORG_ID],
      )
      // PG 的 COUNT(*) 以字符串返回（与 plugin-wiki 的同款坑）
      return Number(rows[0]?.n ?? 0)
    }

    /** 参与者必须是 owner/admin；否则写 403 并返回 false */
    const requireAdmin = (h: RouteHandlerContext): boolean => {
      if (isAdminRole(h.principal?.orgRole)) return true
      h.json(403, { ok: false, error: 'forbidden', message: '需要管理员权限' })
      return false
    }

    /** 参与者必须是 owner；用于"授予/撤销 owner"这类高危动作 */
    const requireOwner = (h: RouteHandlerContext): boolean => {
      if (h.principal?.orgRole === 'owner') return true
      h.json(403, { ok: false, error: 'forbidden', message: '该操作需要 owner 权限' })
      return false
    }

    const readBodyOr400 = async (h: RouteHandlerContext): Promise<Record<string, unknown> | null> => {
      try {
        return await readJsonBody(h)
      } catch (err) {
        const message = (err as Error).message
        const [code = 'invalid_body'] = message.split(':')
        h.json(code === 'payload_too_large' ? 413 : 400, { ok: false, error: code, message })
        return null
      }
    }

    const cleanups: (() => void)[] = []

    /* ==================== GET /api/org（user） ==================== */
    /*
     * 一次调用回答"这是什么组织、我在这里是谁"。前端据此决定渲染哪些入口。
     * `access:'user'` 而非 `public`：组织信息本身就带成员数等内部信息，
     * 而访客（未登录）在这个产品里看到的是门户页，不是工作台。
     */
    cleanups.push(
      router.register(
        'GET',
        '/api/org',
        async (h) => {
          const p = h.principal
          const rows = await db.query<{ id: number; slug: string; name: string; visibility: string; created_at: string }>(
            'SELECT id, slug, name, visibility, created_at FROM orgs WHERE id = ?',
            [DEFAULT_ORG_ID],
          )
          const org = rows[0]
          if (!org) {
            h.json(404, { ok: false, error: 'org_not_found', message: '默认组织不存在（0011 迁移未应用？）' })
            return
          }
          const counts = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?',
            [DEFAULT_ORG_ID],
          )
          h.json(200, {
            ok: true,
            org: {
              id: Number(org.id),
              slug: org.slug,
              name: org.name,
              visibility: org.visibility,
              createdAt: org.created_at,
            },
            me: {
              userId: p?.userId ?? null,
              role: p?.orgRole ?? null,
              // guest 的明确表达：登录了但**没有**组织角色
              isGuest: p?.kind === 'user' && p.orgRole === null,
              groupIds: p?.groupIds ?? [],
            },
            // PG 的 COUNT(*) 以字符串返回（与 plugin-wiki 的同款坑），统一 Number 收敛
            memberCount: Number(counts[0]?.n ?? 0),
          })
        },
        { access: 'user' },
      ),
    )

    /*
     * ==================== GET /api/org/members（**任何登录用户**） ====================
     *
     * ★ 本批放宽：原为 `admin`，现为 `{ access: 'user' }` —— 已认证即可读。
     *
     * 为什么放宽（一个真实的功能阻塞）：改页面/段落权限只要求 `manageVisibility`，而**组织成员
     * 也有**这个能力；但"授权给谁"必须知道对方的 id，而 id 的名单此前只有管理员拿得到
     * ⇒ 出现"有权授权、却只能凭记忆猜一个数字 id"的人。作者的原话是"授权时，所谓的 id 是什么"，
     * 那正是这个缺口的症状。故：**能看到名单，才谈得上按名单授权**。
     *
     * 放宽了什么（明说，不静默）：登录用户现在能看到成员列表，其中含 `email`、`displayName`、
     * `role`（组织角色）与 `joinedAt`。邮箱是**刻意保留**的：重名时它是唯一能区分"授权给谁"的
     * 信息，去掉它会让选择框变成猜谜。**邀请（含邮箱与被邀请人状态）仍然只有管理员可见**
     * （`GET /api/org/invitations` 未改），因为那里面还有尚未加入的人与邀请状态。
     */
    cleanups.push(
      router.register(
        'GET',
        '/api/org/members',
        async (h) => {
          /*
           * 不再要求 admin：路由的 `{ access: 'user' }` 已保证"已认证"，
           * 而本端点的用途是"让我选一个授权对象"—— 凡是能走到授权界面的人都该看得到。
           */
          const rows = await db.query<{
            user_id: number
            email: string
            display_name: string
            role: string
            joined_at: string
          }>(
            `SELECT m.user_id, u.email, u.display_name, m.role, m.joined_at
               FROM org_members m JOIN users u ON u.id = m.user_id
              WHERE m.org_id = ?
              ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                       m.joined_at`,
            [DEFAULT_ORG_ID],
          )
          h.json(200, {
            ok: true,
            members: rows.map((r) => ({
              userId: Number(r.user_id),
              email: r.email,
              displayName: r.display_name,
              role: isOrgRole(r.role) ? r.role : 'viewer',
              joinedAt: r.joined_at,
            })),
          })
        },
        { access: 'user' },
      ),
    )

    /* ==================== PUT /api/org/members/:userId（admin/owner） ==================== */
    cleanups.push(
      router.register(
        'PUT',
        '/api/org/members/:userId',
        async (h) => {
          if (!requireAdmin(h)) return
          const targetId = Number(h.params.userId)
          if (!Number.isInteger(targetId) || targetId <= 0) {
            h.json(400, { ok: false, error: 'invalid_user_id', message: 'userId 必须是正整数' })
            return
          }
          const body = await readBodyOr400(h)
          if (!body) return
          const role = body.role
          if (!isOrgRole(role)) {
            h.json(400, {
              ok: false,
              error: 'invalid_role',
              message: `role 必须是 ${ORG_ROLES.join('|')} 之一`,
            })
            return
          }
          const actor = h.principal
          const existing = await db.query<{ role: string }>(
            'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?',
            [DEFAULT_ORG_ID, targetId],
          )
          const previous = existing[0]?.role

          /*
           * **owner 是不可被 admin 触碰的**（含"把 owner 降级"与"把别人提升为 owner"）：
           * 否则一个 admin 可以先把 owner 降级、再把自己提上去 —— 这是最典型的
           * 权限提升路径，而它只需要两个合法的 API 调用。
           */
          const touchesOwner = previous === 'owner' || role === 'owner'
          if (touchesOwner && actor?.orgRole !== 'owner') {
            h.json(403, {
              ok: false,
              error: 'forbidden',
              message: '涉及 owner 的变更需要 owner 权限',
            })
            return
          }
          if (previous === undefined) {
            h.json(404, { ok: false, error: 'member_not_found', message: '该用户不是组织成员' })
            return
          }

          try {
            const outcome = await db.transaction(async (tx) => {
              // ★ 不变式检查与写入同事务：并发降级两个 owner 时，第二个会看到 count=1 而被拒
              if (previous === 'owner' && role !== 'owner' && (await countOwners(tx)) <= 1) {
                return { kind: 'last_owner' as const }
              }
              await tx.run(
                'UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?',
                [role, DEFAULT_ORG_ID, targetId],
              )
              return { kind: 'ok' as const }
            })
            if (outcome.kind === 'last_owner') {
              h.json(409, {
                ok: false,
                error: 'last_owner',
                message: '不能降级最后一个 owner —— 组织将永久失去管理能力',
              })
              return
            }
          } catch (err) {
            h.json(500, { ok: false, error: 'internal_error', message: (err as Error).message })
            return
          }

          audit({
            action: 'org.member.set_role',
            targetKind: 'user',
            targetId: String(targetId),
            actorId: actor?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { role: previous },
            after: { role },
          })
          h.json(200, { ok: true, userId: targetId, role })
        },
        { access: 'admin' },
      ),
    )

    /* ==================== DELETE /api/org/members/:userId（admin/owner） ==================== */
    cleanups.push(
      router.register(
        'DELETE',
        '/api/org/members/:userId',
        async (h) => {
          if (!requireAdmin(h)) return
          const targetId = Number(h.params.userId)
          if (!Number.isInteger(targetId) || targetId <= 0) {
            h.json(400, { ok: false, error: 'invalid_user_id', message: 'userId 必须是正整数' })
            return
          }
          const actor = h.principal
          const existing = await db.query<{ role: string }>(
            'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?',
            [DEFAULT_ORG_ID, targetId],
          )
          const previous = existing[0]?.role
          if (previous === undefined) {
            h.json(404, { ok: false, error: 'member_not_found', message: '该用户不是组织成员' })
            return
          }
          if (previous === 'owner' && actor?.orgRole !== 'owner') {
            h.json(403, { ok: false, error: 'forbidden', message: '移除 owner 需要 owner 权限' })
            return
          }
          /*
           * 不允许移除自己：这不是洁癖 —— "把自己的成员身份删掉"会立刻把自己锁在门外
           * （下一次请求 orgRole 变 null，再也改不回来），而它几乎总是误操作
           * （想"退出登录"或"转让所有权"却点错）。转让所有权应由另一条显式路径完成。
           */
          if (targetId === actor?.userId) {
            h.json(409, {
              ok: false,
              error: 'cannot_remove_self',
              message: '不能移除自己的成员身份（如需转让所有权，请先指定另一位 owner）',
            })
            return
          }
          try {
            const outcome = await db.transaction(async (tx) => {
              if (previous === 'owner' && (await countOwners(tx)) <= 1) {
                return { kind: 'last_owner' as const }
              }
              await tx.run('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [
                DEFAULT_ORG_ID,
                targetId,
              ])
              // 组的成员关系一并清理：留在组里会让"已移出组织的人"仍能凭组授权访问内容
              await tx.run('DELETE FROM group_members WHERE user_id = ?', [targetId])
              return { kind: 'ok' as const }
            })
            if (outcome.kind === 'last_owner') {
              h.json(409, {
                ok: false,
                error: 'last_owner',
                message: '不能移除最后一个 owner —— 组织将永久失去管理能力',
              })
              return
            }
          } catch (err) {
            h.json(500, { ok: false, error: 'internal_error', message: (err as Error).message })
            return
          }
          audit({
            action: 'org.member.remove',
            targetKind: 'user',
            targetId: String(targetId),
            actorId: actor?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { role: previous },
          })
          h.json(200, { ok: true, removed: targetId })
        },
        { access: 'admin' },
      ),
    )

    /*
     * ==================== GET /api/org/groups（**任何登录用户**） ====================
     *
     * 与成员名单同一口径、同一理由（见上面 members 的注释）：用户组本身**不是秘密** ——
     * 它是授权对象；看不见组名就没法按组授权。组的**增删与成员调整**仍需管理员
     * （本文件其余 `/api/org/groups*` 路由的 `access: 'admin'` 未改）。
     */
    cleanups.push(
      router.register(
        'GET',
        '/api/org/groups',
        async (h) => {
          // 不再要求 admin（理由见上面的路由注释）：组是**授权对象**，看不见就选不了
          const groups = await db.query<{ id: number; name: string; created_at: string }>(
            'SELECT id, name, created_at FROM groups WHERE org_id = ? ORDER BY name',
            [DEFAULT_ORG_ID],
          )
          const members = await db.query<{ group_id: number; user_id: number }>(
            `SELECT gm.group_id, gm.user_id FROM group_members gm
               JOIN groups g ON g.id = gm.group_id WHERE g.org_id = ?`,
            [DEFAULT_ORG_ID],
          )
          const byGroup = new Map<number, number[]>()
          for (const m of members) {
            const key = Number(m.group_id)
            const list = byGroup.get(key)
            if (list) list.push(Number(m.user_id))
            else byGroup.set(key, [Number(m.user_id)])
          }
          h.json(200, {
            ok: true,
            groups: groups.map((g) => ({
              id: Number(g.id),
              name: g.name,
              createdAt: g.created_at,
              memberIds: byGroup.get(Number(g.id)) ?? [],
            })),
          })
        },
        { access: 'user' },
      ),
    )

    /* ==================== POST /api/org/groups（admin） ==================== */
    cleanups.push(
      router.register(
        'POST',
        '/api/org/groups',
        async (h) => {
          if (!requireAdmin(h)) return
          const body = await readBodyOr400(h)
          if (!body) return
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (name.length === 0 || name.length > GROUP_NAME_MAX) {
            h.json(400, {
              ok: false,
              error: 'invalid_group_name',
              message: `组名长度须在 1–${GROUP_NAME_MAX} 之间`,
            })
            return
          }
          const now = new Date().toISOString()
          try {
            const inserted = await db.run(
              `INSERT INTO groups (org_id, name, created_at) VALUES (?, ?, ?) RETURNING id`,
              [DEFAULT_ORG_ID, name, now],
            )
            const id = Number(inserted.lastInsertRowid)
            audit({
              action: 'org.group.create',
              targetKind: 'group',
              targetId: String(id),
              actorId: h.principal?.userId ?? null,
              actorIpHash: auditIpHash(clientIp(h.req)),
              after: { name },
            })
            h.json(201, { ok: true, group: { id, name, createdAt: now, memberIds: [] } })
          } catch (err) {
            // 组名在组织内唯一（idx_groups_org_name）—— 撞唯一约束要给可读的 409，
            // 而不是把驱动的原始错误抛给前端
            const message = (err as Error).message
            if (/UNIQUE|duplicate key/i.test(message)) {
              h.json(409, { ok: false, error: 'group_exists', message: `组「${name}」已存在` })
              return
            }
            h.json(500, { ok: false, error: 'internal_error', message })
          }
        },
        { access: 'admin' },
      ),
    )

    /* ==================== DELETE /api/org/groups/:id（admin） ==================== */
    cleanups.push(
      router.register(
        'DELETE',
        '/api/org/groups/:id',
        async (h) => {
          if (!requireAdmin(h)) return
          const groupId = Number(h.params.id)
          if (!Number.isInteger(groupId) || groupId <= 0) {
            h.json(400, { ok: false, error: 'invalid_group_id', message: 'id 必须是正整数' })
            return
          }
          const rows = await db.query<{ name: string }>(
            'SELECT name FROM groups WHERE id = ? AND org_id = ?',
            [groupId, DEFAULT_ORG_ID],
          )
          if (!rows[0]) {
            h.json(404, { ok: false, error: 'group_not_found', message: '组不存在' })
            return
          }
          /*
           * 删组会连带 `ON DELETE CASCADE` 清掉 group_members，于是**所有**以该组为主体的
           * 授权同时失效（`page_grants` 里 `subject_kind='group'` 的行仍在，但判定时
           * 展开出的 groupIds 不再包含它）。这是**收紧**方向的变化，安全上正确；
           * 但必须在审计里留下"这个组曾经存在、叫这个名字"，否则事后完全无法解释
           * "为什么某人昨天还能看、今天不能了"。
           */
          await db.run('DELETE FROM groups WHERE id = ? AND org_id = ?', [groupId, DEFAULT_ORG_ID])
          audit({
            action: 'org.group.delete',
            targetKind: 'group',
            targetId: String(groupId),
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { name: rows[0].name },
          })
          h.json(200, { ok: true, removed: groupId })
        },
        { access: 'admin' },
      ),
    )

    /* ============ PUT / DELETE /api/org/groups/:id/members/:userId（admin） ============ */
    const groupMember = (method: 'PUT' | 'DELETE') =>
      router.register(
        method,
        '/api/org/groups/:id/members/:userId',
        async (h) => {
          if (!requireAdmin(h)) return
          const groupId = Number(h.params.id)
          const userId = Number(h.params.userId)
          if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) {
            h.json(400, { ok: false, error: 'invalid_id', message: 'id 与 userId 必须是正整数' })
            return
          }
          const group = await db.query<{ id: number }>(
            'SELECT id FROM groups WHERE id = ? AND org_id = ?',
            [groupId, DEFAULT_ORG_ID],
          )
          if (!group[0]) {
            h.json(404, { ok: false, error: 'group_not_found', message: '组不存在' })
            return
          }
          if (method === 'PUT') {
            /*
             * 只允许把**已是组织成员**的人加进组。否则会出现"组里有个人，但他不在组织里"
             * 的幽灵成员：他能凭组授权访问内容，却不出现在成员列表里，排查"谁能看这条"
             * 时会漏掉他。这正是设计文档 §9 R10 反模式第 4 条（只校验两端各自的权限、
             * 不校验隶属关系）在组这一层的形态。
             */
            const member = await db.query<{ user_id: number }>(
              'SELECT user_id FROM org_members WHERE org_id = ? AND user_id = ?',
              [DEFAULT_ORG_ID, userId],
            )
            if (!member[0]) {
              h.json(409, {
                ok: false,
                error: 'not_org_member',
                message: '只能把组织成员加入组 —— 请先邀请他加入组织',
              })
              return
            }
            const exists = await db.query<{ user_id: number }>(
              'SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?',
              [groupId, userId],
            )
            if (!exists[0]) {
              await db.run('INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)', [
                groupId,
                userId,
                new Date().toISOString(),
              ])
              audit({
                action: 'org.group.add_member',
                targetKind: 'group',
                targetId: String(groupId),
                actorId: h.principal?.userId ?? null,
                actorIpHash: auditIpHash(clientIp(h.req)),
                after: { userId },
              })
            }
            h.json(200, { ok: true, groupId, userId, added: true })
            return
          }
          await db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])
          audit({
            action: 'org.group.remove_member',
            targetKind: 'group',
            targetId: String(groupId),
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { userId },
          })
          h.json(200, { ok: true, groupId, userId, added: false })
        },
        { access: 'admin' },
      )
    cleanups.push(groupMember('PUT'), groupMember('DELETE'))

    /* ==================== GET /api/org/invitations（admin） ==================== */
    cleanups.push(
      router.register(
        'GET',
        '/api/org/invitations',
        async (h) => {
          if (!requireAdmin(h)) return
          const rows = await db.query<{
            id: string
            /** `null` = 通用码（见 0022 迁移） */
            email: string | null
            org_role: string | null
            group_id: number | null
            expires_at: string
            accepted_at: string | null
            /** 凭这条邀请入伙的用户（0023）；null = 还没被用，或是 0023 之前的历史行 */
            accepted_by: number | null
            created_at: string
          }>(
            `SELECT id, email, org_role, group_id, expires_at, accepted_at, accepted_by, created_at
               FROM invitations WHERE org_id = ? ORDER BY created_at DESC LIMIT 200`,
            [DEFAULT_ORG_ID],
          )
          h.json(200, {
            ok: true,
            // **绝不回传 token_hash，也回传不了原始 token** —— 原始令牌只在创建时
            // 返回一次（与"会话令牌只存哈希"同一纪律）。
            invitations: rows.map((r) => ({
              id: r.id,
              email: r.email,
              orgRole: isOrgRole(r.org_role) ? r.org_role : null,
              groupId: r.group_id === null ? null : Number(r.group_id),
              expiresAt: r.expires_at,
              acceptedAt: r.accepted_at,
              /*
               * `acceptedBy` 是**用户 id**，不是姓名 —— 本插件不查 users 表（那是身份域），
               * 界面拿成员列表自己映射（`GET /api/org/members`，access:'user'）。
               * 与审计页 `actorId` 的处理同款：这里如实给出 id，不假装已经解析过。
               */
              acceptedBy: r.accepted_by === null ? null : Number(r.accepted_by),
              createdAt: r.created_at,
            })),
          })
        },
        { access: 'admin' },
      ),
    )

    /* ==================== POST /api/org/invitations（admin） ==================== */
    cleanups.push(
      router.register(
        'POST',
        '/api/org/invitations',
        async (h) => {
          if (!requireAdmin(h)) return
          const body = await readBodyOr400(h)
          if (!body) return
          /*
           * `email` **可选**（2026-09-17 起）：
           *   · 不传 / 空串 ⇒ **通用码**，落库为 NULL —— 持码者注册时自填邮箱；
           *   · 传了 ⇒ **定向码**，注册时填的邮箱必须与它相等。
           *
           * ★ 定向码这一半**不是兼容包袱**：OIDC 的 `invite_only` 闸门是
           * **按邮箱查这张表**的（`@geewiki/auth` 的 `hasUnconsumedInvite(email)`）。
           * 把 email 整列删掉会让"OIDC 首次登录要不要放行"失去判据 —— 所以它保留，
           * 只是不再是必填。（OIDC 那条路本轮**一行不改**。）
           */
          const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
          let email: string | null = null
          if (rawEmail !== '') {
            if (!EMAIL_RE.test(rawEmail) || rawEmail.length > EMAIL_MAX) {
              h.json(400, { ok: false, error: 'invalid_email', message: '邮箱格式不合法' })
              return
            }
            email = rawEmail
          }
          /*
           * `orgRole` 缺省 / null ⇒ **guest 通道**（入伙但不给组织角色）。这不是"最低档
           * 角色"，而是"没有角色"（§2.1）：他只能看到被显式授予的内容，且不会被
           * 组织级继承规则牵连 —— 这正是外部协作者要的语义。
           */
          const orgRole = body.orgRole === undefined || body.orgRole === null ? null : body.orgRole
          if (orgRole !== null && !isOrgRole(orgRole)) {
            h.json(400, {
              ok: false,
              error: 'invalid_role',
              message: `orgRole 必须是 ${ORG_ROLES.join('|')} 或 null`,
            })
            return
          }
          // 只有 owner 能签发 owner 邀请 —— 否则 admin 可以绕过"owner 变更需 owner"的限制
          if (orgRole === 'owner' && h.principal?.orgRole !== 'owner') {
            h.json(403, { ok: false, error: 'forbidden', message: '签发 owner 邀请需要 owner 权限' })
            return
          }
          const groupId =
            body.groupId === undefined || body.groupId === null ? null : Number(body.groupId)
          if (groupId !== null) {
            if (!Number.isInteger(groupId) || groupId <= 0) {
              h.json(400, { ok: false, error: 'invalid_group_id', message: 'groupId 必须是正整数' })
              return
            }
            const group = await db.query<{ id: number }>(
              'SELECT id FROM groups WHERE id = ? AND org_id = ?',
              [groupId, DEFAULT_ORG_ID],
            )
            if (!group[0]) {
              h.json(404, { ok: false, error: 'group_not_found', message: '组不存在' })
              return
            }
          }

          const rawToken = randomBytes(32).toString('base64url')
          const id = randomBytes(16).toString('hex')
          const now = new Date()
          const expiresAt = isoPlus(now, invitationTtlMs)
          await db.run(
            `INSERT INTO invitations
               (id, org_id, email, org_role, group_id, invited_by, token_hash, expires_at, accepted_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            [
              id,
              DEFAULT_ORG_ID,
              email,
              orgRole,
              groupId,
              h.principal?.userId ?? null,
              tokenHashOf(rawToken),
              expiresAt,
              now.toISOString(),
            ],
          )
          audit({
            action: 'org.invitation.create',
            targetKind: 'invitation',
            targetId: id,
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            // **不记 token**：审计表是长期留存物，把凭据写进去等于把它的生命周期
            // 延长到"审计表被清空为止"
            after: { email, orgRole, groupId, expiresAt },
          })
          h.json(201, {
            ok: true,
            invitation: { id, email, orgRole, groupId, expiresAt, acceptedAt: null, createdAt: now.toISOString() },
            /*
             * ★ 原始令牌**只在这一次响应里出现**。库里只有 sha256，之后再也取不回来。
             * 与会话 cookie 同一纪律：DB 泄露不足以让人冒用。
             */
            token: rawToken,
          })
        },
        { access: 'admin' },
      ),
    )

    /* ==================== DELETE /api/org/invitations/:id（admin） ==================== */
    cleanups.push(
      router.register(
        'DELETE',
        '/api/org/invitations/:id',
        async (h) => {
          if (!requireAdmin(h)) return
          const id = h.params.id ?? ''
          if (id.length === 0) {
            h.json(400, { ok: false, error: 'invalid_id', message: '缺少邀请 id' })
            return
          }
          const rows = await db.query<{ email: string; accepted_at: string | null }>(
            'SELECT email, accepted_at FROM invitations WHERE id = ? AND org_id = ?',
            [id, DEFAULT_ORG_ID],
          )
          if (!rows[0]) {
            h.json(404, { ok: false, error: 'invitation_not_found', message: '邀请不存在' })
            return
          }
          await db.run('DELETE FROM invitations WHERE id = ? AND org_id = ?', [id, DEFAULT_ORG_ID])
          audit({
            action: 'org.invitation.revoke',
            targetKind: 'invitation',
            targetId: id,
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { email: rows[0].email, acceptedAt: rows[0].accepted_at },
          })
          h.json(200, { ok: true, removed: id })
        },
        { access: 'admin' },
      ),
    )

    /* ==================== POST /api/org/invitations/:id/rotate（admin） ====================
     *
     * ## 它解决什么
     *
     * 原始令牌**只在签发那一次响应里出现**，库里只有 sha256（与会话 cookie 同一纪律：
     * DB 泄露不足以让人冒用）。代价是"签发即失联"：管理员关掉那个提示框之后就再也拿不到
     * 那个码了，只能撤销重发一条邀请 —— 而"撤销 + 重建"会丢掉这条邀请已经带上的
     * `org_role` / `group_id` 配置，也让列表里平白多出一行已撤销的垃圾。
     *
     * 本端点给的是**换发**：为**同一条**邀请生成一个新令牌（旧的立即作废）。
     * 于是"随时能拿到一个可用的码"与"库里不存明文"两件事可以同时成立 ——
     * 这正是选择换发而不是"把码明文存起来、列表里直接显示"的理由：
     * 后者会让一份数据库泄露（备份、只读账号、注入读路径）直接变成**可开号**的凭据。
     *
     * ## 三条边界（都是"写错了不会报错"的那类）
     *
     * 1. **只能换发"未接受且未过期"的**。已接受的换发等于把一次性的邀请重新变成可用 ——
     *    会让**第二个人**用同一个邀请进来，直接破坏"一人一码"。
     * 2. **已过期的拒绝，而不是顺手延长有效期**。延长是另一个决定（"再给他 7 天"），
     *    混进换发里会让"我只是想再复制一次链接"变成"我悄悄给他续了 7 天"。
     * 3. **换发 owner 邀请需要 owner**，与签发时同一判据 —— 否则一个 admin 只要找到
     *    一条 owner 邀请（哪怕是别人签的），换发一下就能自己用掉，绕开
     *    "admin 不得签发 owner 邀请"那条限制。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/org/invitations/:id/rotate',
        async (h) => {
          if (!requireAdmin(h)) return
          const id = h.params.id ?? ''
          if (id.length === 0) {
            h.json(400, { ok: false, error: 'invalid_id', message: '缺少邀请 id' })
            return
          }
          const rows = await db.query<{
            email: string | null
            org_role: string | null
            expires_at: string
            accepted_at: string | null
          }>(
            'SELECT email, org_role, expires_at, accepted_at FROM invitations WHERE id = ? AND org_id = ?',
            [id, DEFAULT_ORG_ID],
          )
          const invite = rows[0]
          if (!invite) {
            h.json(404, { ok: false, error: 'invitation_not_found', message: '邀请不存在' })
            return
          }
          const now = new Date().toISOString()
          if (invite.accepted_at !== null) {
            h.json(409, {
              ok: false,
              error: 'already_accepted',
              message: '这条邀请已经被使用过了 —— 换发会让另一个人也能凭它进来',
            })
            return
          }
          if (invite.expires_at <= now) {
            h.json(409, {
              ok: false,
              error: 'invitation_expired',
              message: '这条邀请已过期，请重新签发一条（换发不会顺带延长有效期）',
            })
            return
          }
          if (invite.org_role === 'owner' && h.principal?.orgRole !== 'owner') {
            h.json(403, { ok: false, error: 'forbidden', message: '换发 owner 邀请需要 owner 权限' })
            return
          }

          const rawToken = randomBytes(32).toString('base64url')
          await db.run('UPDATE invitations SET token_hash = ? WHERE id = ? AND org_id = ?', [
            tokenHashOf(rawToken),
            id,
            DEFAULT_ORG_ID,
          ])
          audit({
            action: 'org.invitation.rotate',
            targetKind: 'invitation',
            targetId: id,
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            // 同样**不记令牌**（审计表是长期留存物）
            after: { email: invite.email, orgRole: invite.org_role, expiresAt: invite.expires_at },
          })
          h.json(200, {
            ok: true,
            id,
            email: invite.email,
            expiresAt: invite.expires_at,
            /*
             * 新令牌**只在这**一次响应里出现，与签发端点同款：旧的那个已经作废，
             * 库里仍然只有新哈希。
             */
            token: rawToken,
          })
        },
        { access: 'admin' },
      ),
    )

    /* ==================== POST /api/org/invitations/purge（admin） ====================
     *
     * ⚠️ **这不是"让过期邀请失效"的手段** —— 失效在**兑换判定时**就已经发生：
     * 兑换路径那句 `invite.expires_at > now`（见下方兑换端点的 `invite !== undefined &&
     * invite.accepted_at === null && invite.expires_at > now`）。本条只做**空间回收**，
     * 与 `@geewiki/authz` 的 `POST /api/admin/grants/purge` 是同一条口径
     * （§8.2 P4 第 3 条原话："无需人工清理即生效；清理任务只是回收"）。
     *
     * **为什么非要把这层区分写进注释与响应**：一旦它被当成"失效开关"，就会派生出
     * "清理任务没跑 ⇒ 过期邀请仍然可用"这种最糟的误解 —— 而那是**失败开放**方向。
     *
     * **只回收"未接受 且 已过期"的邀请**：已接受的（`accepted_at IS NOT NULL`）即便早已过期
     * 也要留着 —— 那是**入伙记录**，清了就丢掉了"谁在什么时候通过哪条邀请进来的"这条溯源链。
     * 所以删除条件是两者**同时**成立，不是单看 `expires_at`。
     *
     * **只在真的回收了东西时才写审计**：与 grants/purge 同款 —— 维护动作的空跑没有副作用，
     * 每 N 分钟记一条"回收了 0 条"只会把审计淹掉。有副作用才留痕。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/org/invitations/purge',
        async (h) => {
          if (!requireAdmin(h)) return
          const now = new Date().toISOString()
          const countExpired = async (): Promise<number> => {
            const rows = await db.query<{ n: number | string }>(
              `SELECT COUNT(*) AS n FROM invitations
                WHERE org_id = ? AND accepted_at IS NULL AND expires_at <= ?`,
              [DEFAULT_ORG_ID, now],
            )
            // PG 的 COUNT(*) 返回字符串，必须强转（否则 "1" + 1 → "11"）
            return Number(rows[0]?.n ?? 0)
          }
          const expired = await countExpired()
          if (expired > 0) {
            await db.run(
              `DELETE FROM invitations
                WHERE org_id = ? AND accepted_at IS NULL AND expires_at <= ?`,
              [DEFAULT_ORG_ID, now],
            )
          }
          const remainRows = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?',
            [DEFAULT_ORG_ID],
          )
          const remaining = Number(remainRows[0]?.n ?? 0)
          if (expired > 0) {
            audit({
              action: 'org.invitation.purge',
              targetKind: 'invitation',
              targetId: 'invitations',
              actorId: h.principal?.userId ?? null,
              actorIpHash: auditIpHash(clientIp(h.req)),
              after: { expired, remaining, at: now },
            })
          }
          h.json(200, { ok: true, expired, remaining, at: now })
        },
        { access: 'admin' },
      ),
    )

    /* ---------- 邀请：共用的读取与入伙逻辑 ---------- */

    interface InvitationRow {
      id: string
      /** `null` = **通用码**（持码者注册时自填邮箱）；非 null = 定向码（邮箱必须相等） */
      email: string | null
      org_role: string | null
      group_id: number | null
      expires_at: string
      accepted_at: string | null
    }

    /** 按**令牌哈希**取邀请（库里从不存原始令牌） */
    const loadInvitationByToken = async (token: string): Promise<InvitationRow | undefined> => {
      const rows = await db.query<InvitationRow>(
        `SELECT id, email, org_role, group_id, expires_at, accepted_at
           FROM invitations WHERE token_hash = ? AND org_id = ?`,
        [tokenHashOf(token), DEFAULT_ORG_ID],
      )
      return rows[0]
    }

    /**
     * 入伙 + 一次性消费邀请。**必须整体在一个事务里**：
     * 否则会出现"成员已写入、邀请未被标记消费"，同一张邀请于是可以被反复使用。
     *
     * 两条容易写错的语义在这里固定下来：
     * - `org_role` 为 `null` ⇒ **guest 通道**：不写 `org_members`。这正是"无组织角色"
     *   的表达（§2.1），而不是"写入一个最低档角色"。
     * - 已是成员时**不改动其现有角色**：邀请是入伙凭证，不是升降级指令；
     *   否则一张几个月前发出的 viewer 邀请就能把现任 owner 降级。
     */
    const joinAndConsume = async (
      invite: InvitationRow,
      userId: number,
      now: string,
    ): Promise<{ alreadyMember: boolean; orgRole: OrgRole | null; groupId: number | null }> => {
      const groupId = invite.group_id === null ? null : Number(invite.group_id)
      const orgRole = isOrgRole(invite.org_role) ? invite.org_role : null
      let alreadyMember = false
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ role: string }>(
          'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?',
          [DEFAULT_ORG_ID, userId],
        )
        if (existing[0]) {
          alreadyMember = true
        } else if (orgRole !== null) {
          await tx.run(
            'INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
            [DEFAULT_ORG_ID, userId, orgRole, now],
          )
        }
        if (groupId !== null) {
          const inGroup = await tx.query<{ user_id: number }>(
            'SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?',
            [groupId, userId],
          )
          if (!inGroup[0]) {
            await tx.run('INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)', [
              groupId,
              userId,
              now,
            ])
          }
        }
        /*
         * `accepted_by` 与 `accepted_at` **同一条语句**写入：它们是同一件事的两个面
         * （谁、什么时候），分开写就存在"标记了已接受但没记下是谁"的中间态。
         * `AND accepted_at IS NULL` 那条守卫是一次性消费的原子判据，保留不动。
         */
        await tx.run(
          'UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL',
          [now, userId, invite.id],
        )
      })
      return { alreadyMember, orgRole, groupId }
    }

    /** 邀请可用性的共用判据。统一文案：不区分"令牌不存在"与"已用/已过期"。 */
    const invitationUsable = (invite: InvitationRow | undefined, now: string): invite is InvitationRow =>
      invite !== undefined && invite.accepted_at === null && invite.expires_at > now

    /* ==================== POST /api/org/invitations/accept（user） ==================== */
    /*
     * 给**已有账号**的登录用户用：他凭邀请入伙（或补一个组）。
     * "新用户第一次进组织"走下面的 redeem（那条是 public，因为他还无法登录）。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/org/invitations/accept',
        async (h) => {
          const p = h.principal
          if (p?.kind !== 'user' || p.userId === null) {
            // 闸门已保证非匿名；走到这里说明主体被下游换掉了 —— 仍按失败关闭处理
            h.json(401, { ok: false, error: 'unauthorized', message: '需要登录' })
            return
          }
          const body = await readBodyOr400(h)
          if (!body) return
          const token = typeof body.token === 'string' ? body.token.trim() : ''
          if (token.length === 0) {
            h.json(400, { ok: false, error: 'invalid_token', message: '缺少邀请令牌' })
            return
          }
          const now = new Date().toISOString()
          const invite = await loadInvitationByToken(token)
          const invalid = (): void => {
            h.json(400, { ok: false, error: 'invalid_invitation', message: '邀请无效、已使用或已过期' })
          }
          if (!invitationUsable(invite, now)) return invalid()

          const users = await db.query<{ email: string }>('SELECT email FROM users WHERE id = ?', [
            p.userId,
          ])
          const myEmail = users[0]?.email?.toLowerCase()
          /*
           * **定向码必须邮箱一致**：它是发给某个邮箱的，凭一个被转发的令牌让任意登录用户
           * 入伙等于把"发给谁"这个决策作废。失败关闭 —— 拿不到自己的邮箱也拒绝。
           *
           * ★ 通用码（`invite.email === null`）**不做这一比**：它本来就不限定人，
           * 唯一的凭据是那个 256 位熵的令牌本身。这是 2026-09-17 起的新语义
           * （见 0022 迁移），不是放宽 —— 通用码的防滥用靠"一次性 + 7 天 + 可随时吊销"。
           */
          if (invite.email !== null && (!myEmail || myEmail !== invite.email.toLowerCase())) {
            h.json(403, {
              ok: false,
              error: 'email_mismatch',
              message: '该邀请不是发给当前账号的邮箱',
            })
            return
          }

          const outcome = await joinAndConsume(invite, p.userId, now)
          audit({
            action: 'org.invitation.accept',
            targetKind: 'invitation',
            targetId: invite.id,
            actorId: p.userId,
            actorIpHash: auditIpHash(clientIp(h.req)),
            after: outcome,
          })
          h.json(200, { ok: true, ...outcome })
        },
        { access: 'user' },
      ),
    )

    /* ==================== POST /api/org/invitations/redeem（public） ==================== */
    /*
     * ★ "凭邀请自助开户"：这条路径解决一个 P1 遗留的死结 ——
     * `/api/auth/setup` 是**一次性**的（只在库里没有账号时可用），因此系统里原本
     * 根本不存在"创建第二个用户"的途径，邀请也就无人可接受、等于死功能。
     *
     * **为什么是 public**：新用户此刻还没有账号，自然无法登录 ——
     * 要求登录才能接受邀请会让这条路径永远不可达。
     *
     * **它为什么不是"开放注册"**：必须先出示一个 256 位熵（`randomBytes(32)`）、
     * 未过期、未消费的邀请令牌。令牌的传递是带外的（管理员自己发出去），
     * 与"用邮件里的链接注册"是同一个信任模型。
     *
     * ★ **2026-09-17 起邮箱由注册者自选**（原先取自邀请本身）。邀请码因此分两种
     * （见 0022 迁移）：定向码仍限定邮箱（必须一致），通用码不限定 ——
     * 后者是默认形态，因为"登录标识符"是账号最私人的属性，不该由管理员代填。
     * 防滥用改为依赖"一次性 + 有效期 + 可随时吊销"，而不是"码只发给某个人"。
     *
     * 开户成功后**不在本端点里建会话**：客户端拿用户自己刚设的密码去调
     * `/api/auth/login` 即可 —— 会话的建立属于身份域，绕开它去手搓 cookie
     * 等于把会话令牌的纪律复制到第二个地方。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/org/invitations/redeem',
        async (h) => {
          const body = await readBodyOr400(h)
          if (!body) return
          const token = typeof body.token === 'string' ? body.token.trim() : ''
          const password = typeof body.password === 'string' ? body.password : ''
          /*
           * 注册时自填的邮箱（**通用码必填**，定向码可选且必须与邀请一致）。
           * 格式校验交给 auth-service（身份域的规则只有一份实现，见下面的注释）。
           */
          const bodyEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
          if (token.length === 0) {
            h.json(400, { ok: false, error: 'invalid_token', message: '缺少邀请令牌' })
            return
          }
          const now = new Date().toISOString()
          const invite = await loadInvitationByToken(token)
          if (!invitationUsable(invite, now)) {
            h.json(400, { ok: false, error: 'invalid_invitation', message: '邀请无效、已使用或已过期' })
            return
          }

          /*
           * 密码与邮箱格式的校验在 auth-service 内部（身份域的规则不该在组织插件里
           * 再写一份）。displayName 缺省取邮箱 @ 前的部分，与 setup 的取舍一致。
           */
          const authSvc = ctx.get('auth-service') as AuthServiceLike | undefined
          if (!authSvc) {
            h.json(503, {
              ok: false,
              error: 'auth_unavailable',
              message: '身份服务不可用（@geewiki/auth 未激活），无法开户',
            })
            return
          }
          /*
           * 确定本次开户用的邮箱。两条分支的取舍：
           *   · 定向码 ⇒ **以邀请里的邮箱为准**（客户端可以不传，行为与 0022 之前完全一致）；
           *     但若客户端传了一个**不同的**邮箱，直接拒绝 —— 不静默用邀请里那个，
           *     否则用户会以为"我注册成了 alice@b.com"，实际是邀请里的 alice@a.com。
           *   · 通用码 ⇒ 必须由客户端给出邮箱；没给就明确报错，而不是编一个。
           */
          let email: string
          if (invite.email !== null) {
            if (bodyEmail !== '' && bodyEmail !== invite.email.toLowerCase()) {
              h.json(403, {
                ok: false,
                error: 'email_mismatch',
                message: '该邀请码是发给另一个邮箱的',
              })
              return
            }
            email = invite.email.toLowerCase()
          } else {
            if (bodyEmail === '') {
              h.json(400, { ok: false, error: 'email_required', message: '请填写邮箱' })
              return
            }
            email = bodyEmail
          }
          const displayName =
            typeof body.displayName === 'string' && body.displayName.trim().length > 0
              ? body.displayName.trim()
              : (email.split('@')[0] ?? 'member')

          const created = await authSvc.createLocalUser({ email, displayName, password })
          if (!created.ok) {
            if (created.error === 'email_taken') {
              h.json(409, {
                ok: false,
                error: 'email_taken',
                message: '该邮箱已有账号 —— 请直接登录后再接受这份邀请',
              })
              return
            }
            h.json(400, { ok: false, error: created.error, message: created.error === 'invalid_email' ? '邮箱格式不合法' : '密码长度不合法' })
            return
          }

          const outcome = await joinAndConsume(invite, created.userId, now)
          audit({
            action: 'org.invitation.redeem',
            targetKind: 'invitation',
            targetId: invite.id,
            actorId: created.userId,
            actorIpHash: auditIpHash(clientIp(h.req)),
            after: { ...outcome, email },
          })
          h.json(201, { ok: true, userId: created.userId, email, ...outcome })
        },
        { access: 'public' },
      ),
    )

    /* ==================== 服务契约（只读） ==================== */
    const svc: OrgService = {
      async roleOf(userId: number): Promise<OrgRole | null> {
        const rows = await db.query<{ role: unknown }>(
          'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?',
          [DEFAULT_ORG_ID, userId],
        )
        const role = rows[0]?.role
        return isOrgRole(role) ? role : null
      },
      async groupIdsOf(userId: number): Promise<number[]> {
        const rows = await db.query<{ group_id: number | string }>(
          `SELECT gm.group_id AS group_id FROM group_members gm
             JOIN groups g ON g.id = gm.group_id
            WHERE gm.user_id = ? AND g.org_id = ?`,
          [userId, DEFAULT_ORG_ID],
        )
        return rows.map((r) => Number(r.group_id))
      },
      async memberCount(): Promise<number> {
        const rows = await db.query<{ n: number | string }>(
          'SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?',
          [DEFAULT_ORG_ID],
        )
        return Number(rows[0]?.n ?? 0)
      },
    }
    const unprovide = ctx.provide('org-service', svc)
    cleanups.push(unprovide)

    console.log('[@geewiki/org] 已激活: GET /api/org, /api/org/members, /api/org/groups, /api/org/invitations, org-service 服务')
    return () => {
      for (const fn of cleanups.splice(0).reverse()) fn()
    }
  },
}
