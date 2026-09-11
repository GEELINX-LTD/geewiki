/**
 * @geewiki/auth —— GeeWiki 身份插件（P1：身份与登录）
 *
 * 提供本地账号密码登录、会话管理与初始化向导。设计依据：
 * docs/design/access-control.md §3.1（数据模型）、§7（OIDC 留到 P1.5）、
 * §8.1 的 P1 行 / §8.2 的 P1 验收标准。
 *
 * 挂载路由（经 @geewiki/http 路由服务；`access` 为粗粒度准入等级，见设计文档 §2.5）：
 *   GET    /api/auth/state    初始化状态（public）—— 前端据此决定去 #/setup 还是 #/login
 *   POST   /api/auth/setup    创建首个账号（public，但自守卫：已有账号即 409）
 *   POST   /api/auth/login    登录（public）
 *   POST   /api/auth/logout   登出（public；吊销服务端会话，不只是删 cookie）
 *   GET    /api/auth/me       当前身份（user）
 *   POST   /api/auth/password 修改自己的口令（user）
 *
 * 同时经 `ctx.provide('auth-service', …)` 提供身份服务（契约见 {@link AuthService}）。
 *
 * **两条与 P0 骨架的接缝**（设计文档 §2.5）：
 * 1. **会话解析挂在 `router.use?.(hook)` 上**，不改进 server 的 `resolvePrincipal`。
 *    理由：`resolvePrincipal` 只处理 break-glass（读环境变量，无 IO），把它异步化会让
 *    "无钩子时的全同步快路径"这条承诺一并作废；而钩子通路本来就是 async，且
 *    §2.5 ③ 契约第 3 条明确写了"钩子可以替换 h.principal —— 这是 P1 会话解析的挂载点"。
 *    代价是钩子**只对匹配到的路由生效**（§2.5.2 边界一）—— 对身份解析而言这正好：
 *    没有匹配到路由就没有处理器，也就没有需要身份的地方。
 * 2. **`hasCredentialSource()` 供 server 的 `judgeAccess` 判 `bootstrap_required`**。
 *    P0 的判据是"配没配 GEEWIKI_ADMIN_TOKEN"；P1 起还必须算上"有没有可登录的账号"，
 *    否则未配令牌时 `GET /api/auth/me` 会返回 503（系统未就绪）而不是 401（请登录），
 *    前端会掉进"去初始化"的死循环。该探针必须是**同步**的（`judgeAccess` 是纯函数），
 *    故这里用进程内缓存，setup 成功后立即置真。
 */
import type { IncomingMessage } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  asAsync,
  auditIpHash,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type DatabaseAdapterAsync,
  type GeeWikiManifest,
  type HttpRouterService,
  type Principal,
  type RequestVerdict,
  type RouteHandlerContext,
} from '@geewiki/core'
import { dummyVerify, hashPassword, verifyPassword, type StoredCredential } from './password.js'
import { checkCsrf, clearedSessionCookie, readSessionToken, sessionCookie } from './http.js'

export interface AuthConfig {
  /** 会话绝对有效期（天）：从登录那一刻起算，不可滑动延长 */
  sessionAbsoluteDays?: number
  /** 会话空闲有效期（天）：每次使用滑动，长期不用即失效 */
  sessionIdleDays?: number
  /** 登录失败次数上限（同一 IP + email，窗口内） */
  loginMaxFailures?: number
  /** 登录失败计数的窗口（秒） */
  loginWindowSeconds?: number
  /** 强制 cookie 带 Secure（生产必须；本地 http 调试须关掉，否则浏览器不回传） */
  cookieSecure?: boolean
}

export const AuthConfigSchema = Schema.object({
  sessionAbsoluteDays: Schema.number()
    .default(30)
    .min(1)
    .max(365)
    .description('会话绝对有效期（天），从登录起算不可延长'),
  sessionIdleDays: Schema.number()
    .default(7)
    .min(1)
    .max(365)
    .description('会话空闲有效期（天），每次使用滑动'),
  loginMaxFailures: Schema.number()
    .default(10)
    .min(1)
    .max(1000)
    .description('登录失败次数上限（同一 IP + 邮箱，窗口内超过即 429）'),
  loginWindowSeconds: Schema.number().default(60).min(1).max(86400).description('登录失败计数窗口（秒）'),
  cookieSecure: Schema.boolean()
    .default(false)
    .description('会话 cookie 是否强制带 Secure 属性（生产环境应开启）'),
})

/* ======================= auth-service 服务契约 ======================= */

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

export const manifest: GeeWikiManifest = {
  name: '@geewiki/auth',
  version: '0.1.0',
  geewiki: {
    displayName: '身份与登录',
    description: '本地账号密码登录、会话管理与首次初始化向导',
    provides: 'auth-service',
    requires: ['http-service', 'database-provider'],
    conflictGroup: undefined,
    // 本插件**没有**自己的迁移：users/sessions/audit_log 等表由 db 插件的
    // 0010_identity.sql / 0013_audit.sql 建立（它们属核心基础设施，不属于某个业务插件）。
    migrations: undefined,
    runtime: {
      // **不可热插拔**：本插件承载登录态。热卸载会让所有会话的解析通道瞬间消失，
      // 而"谁登录了"这件事没有任何安全的即时降级方式（不像 wiki 那样只是功能不可用）。
      supportsHotReload: false,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: AuthConfigSchema,
  },
}

/* ============================ 小工具 ============================ */

interface UserRow {
  id: number
  org_id: number
  email: string
  display_name: string
  status: string
  email_verified: number | boolean
  created_at: string
  last_seen_at: string | null
}

interface SessionJoinRow extends UserRow {
  s_id: string
  s_expires_at: string
  s_idle_expires_at: string
  s_revoked_at: string | null
  s_last_used_at: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX = 254
const DISPLAY_NAME_MAX = 100
const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

/** 请求体上限（登录/设置口令都是小 JSON；1MB 与全仓其它读体处同量级） */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 读取并解析 JSON 请求体。
 *
 * 错误消息用**前缀即错误码**的约定（与 plugin-wiki / manager 同范式），
 * 由调用方翻译成 HTTP 状态码 —— 这样"解析层"不必知道状态码。
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

/** 客户端 IP（不含代理链解析：`X-Forwarded-For` 可伪造，除非部署层已收口） */
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? '-'
}

/** ISO8601 时间加减；返回 ISO 字符串（两个方言列都是 TEXT，可直接字典序比较） */
function isoPlus(from: Date, ms: number): string {
  return new Date(from.getTime() + ms).toISOString()
}

/** 由原始令牌算 DB 存储用的哈希（DB 泄露也不可直接冒用会话） */
function tokenHashOf(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function toAuthUser(row: UserRow, orgRole: AuthUser['orgRole']): AuthUser {
  return {
    id: Number(row.id),
    email: row.email,
    displayName: row.display_name,
    orgId: Number(row.org_id),
    orgRole,
    // SQLite 回 0/1、PG 也回 0/1（两方言都刻意用 INTEGER，见 0010 迁移的方言对照表）
    emailVerified: Number(row.email_verified) === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
  }
}

/**
 * 默认组织 id。**本期单组织（D1）：恒为 1**，由 `0011_org_team.sql` 的幂等种子建立。
 * 表结构带 `org_id` 是为了将来升多租户时不必做"加列 + 全表回填"，
 * 但**判别逻辑一律经此常量**而不是散落的字面量 `1`，多租户时只需改这一处。
 */
const DEFAULT_ORG_ID = 1

/** 组织角色的合法取值（唯一来源是 `org_members.role`，0011_org_team.sql） */
const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const

/** 类型守卫：库里出现不认识的角色字符串时**不猜测**，一律当作"无角色"（失败关闭） */
function isOrgRole(value: unknown): value is NonNullable<AuthUser['orgRole']> {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)
}

/**
 * 组织角色的**唯一来源**：`org_members` 表（设计文档 §3.2）。
 *
 * **P2 起这里是真实查表**。P1 曾让它恒返回 `null`（= Guest 语义），因为角色的持久化
 * 位置就是这张表，而当时它还不存在；P1 刻意**不**另造存储（例如给 `users` 加一列
 * `is_owner`），以避免"同一事实两处真源"—— 本设计通篇在避免的正是这类漂移。
 *
 * **为什么由 auth 直接读这张表，而不是经 `org-service`**：`org_members` 与
 * `users`/`sessions`/`audit_log` 同属**核心基础设施表**（由 db 插件的 0011 迁移建立），
 * 不是某个业务插件的私有数据。让 Principal 的组装依赖另一个业务插件的服务，会引入
 * 一个只在"登录成功"这一条路径上才需要的反向依赖，且会让"org 插件没启用时无法登录"
 * 这种荒谬的耦合成为可能。
 *
 * **无行 = Guest**（不是"最低档角色"）：返回 `null`。设计文档 §2.1 明确 guest 是
 * "没有默认组织角色"，这样它永远不会被组织级继承规则牵连。
 */
async function resolveOrgRole(
  db: DatabaseAdapterAsync,
  userId: number,
  orgId: number,
): Promise<AuthUser['orgRole']> {
  const rows = await db.query<{ role: unknown }>(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?',
    [orgId, userId],
  )
  const role = rows[0]?.role
  return isOrgRole(role) ? role : null
}

/**
 * 展开用户所属的组 id（`group_members`，同样属核心基础设施表）。
 *
 * 这些 id 直接喂给策略层的 `subject_kind='group'` 判定：**组成员身份由组表决定，
 * 不由授权表决定** —— 所以"把人加进组"就自动获得该组名下的全部授权，
 * 不需要逐条改 `page_grants`（设计文档 §3.2 的"为什么邀请要支持组"）。
 *
 * 与 `resolveOrgRole` 一样按 `orgId` 收窄：跨组织的组 id 不得进入本主体的判定集合。
 */
async function resolveGroupIds(
  db: DatabaseAdapterAsync,
  userId: number,
  orgId: number,
): Promise<number[]> {
  const rows = await db.query<{ group_id: number | string }>(
    `SELECT gm.group_id AS group_id
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ? AND g.org_id = ?`,
    [userId, orgId],
  )
  // PG 的整数可能以字符串返回（与 COUNT(*) 同源），统一 Number 收敛
  return rows.map((r) => Number(r.group_id))
}

/** 下发给前端的**能力**集合（与"能看什么"完全正交，见设计文档 §2.0） */
export interface AuthCapabilities {
  editContent: boolean
  administer: boolean
  manageVisibility: boolean
}

/**
 * 由组织角色推导能力集合。
 *
 * **只用于前端隐藏入口 —— 服务端判定一律独立进行**：前端隐藏不是安全措施
 * （设计文档 §9 R10 反模式第 5 条），这些布尔值被改掉也不会多出任何权限。
 *
 * 角色语义（§2.1）：
 * - `owner` / `admin`：管理成员、组、邀请、插件；改任何条目的可见性。
 * - `member`：建改内容；对自己有编辑权的条目改可见性与授予例外。
 * - `viewer`：**只读**（能看组织内可见条目，不能写）。
 * - `null`（= guest，未入伙）：什么都不能做，只能看被显式授予的内容。
 *
 * `manageVisibility` 给的是"**是否可能拥有**"的上界；**逐条目的**判定由
 * policy-service 的 `PageAccess.canManageVisibility` 给出（本文件不认识条目）。
 */
function capabilitiesOf(principal: Principal | undefined): AuthCapabilities {
  if (principal?.kind === 'break-glass') {
    // 应急通道的意义是"身份系统本身出问题时还能进场"，能力上界等同 owner。
    // 它的每次使用都由 server 层写 `access.break_glass` 留痕（设计文档 D7）。
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

/* ============================ 插件本体 ============================ */

export const AuthPlugin = {
  name: '@geewiki/auth',
  Config: AuthConfigSchema,

  async apply(ctx: Context, config: AuthConfig = {}) {
    const rawDb = ctx.get('db') as AnyDatabaseAdapter | undefined
    if (!rawDb) throw new Error('@geewiki/auth: 数据库服务不可用（没有任何插件提供 database-provider）')
    const db: DatabaseAdapterAsync = asAsync(rawDb)
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/auth: http 路由服务不可用（@geewiki/http 未激活）')

    const absoluteMs = (config.sessionAbsoluteDays ?? 30) * 24 * 3600 * 1000
    const idleMs = (config.sessionIdleDays ?? 7) * 24 * 3600 * 1000
    const maxFailures = config.loginMaxFailures ?? 10
    const windowMs = (config.loginWindowSeconds ?? 60) * 1000
    // 生产默认开 Secure：NODE_ENV=production 且未显式关闭
    const secureCookie = config.cookieSecure ?? process.env.NODE_ENV === 'production'

    const cleanups: (() => void)[] = []

    /* ---------- 表存在性自检 ---------- */
    /*
     * 本插件不自带迁移（表由 db 插件的 0010/0013 建立）。若表缺失，症状会是
     * 运行时零散的 "no such table: sessions"，难以定位到"迁移没跑"。
     * 故在激活时一次性说清 —— 失败要响，不要静默降级成"所有人都登录不了"。
     */
    const tables = new Set(await db.listTables())
    const missing = ['users', 'user_credentials', 'sessions', 'user_identities', 'audit_log'].filter(
      (t) => !tables.has(t),
    )
    if (missing.length > 0) {
      throw new Error(
        `@geewiki/auth: 缺少数据表 ${missing.join(', ')} —— 请确认 db 插件的迁移 0010_identity.sql / 0013_audit.sql 已应用`,
      )
    }

    /* ---------- 凭据来源探针（同步，供 judgeAccess） ---------- */
    let credentialSource = false
    const refreshCredentialSource = async (): Promise<void> => {
      const rows = await db.query<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM users u
           JOIN user_credentials c ON c.user_id = u.id
          WHERE u.status = 'active'`,
      )
      credentialSource = Number(rows[0]?.n ?? 0) > 0
    }
    await refreshCredentialSource()

    /* ---------- 登录失败限流（进程内滑动窗口） ---------- */
    const failures = new Map<string, { count: number; resetAt: number }>()
    const rateKey = (req: IncomingMessage, email: string): string => `${clientIp(req)}|${email}`
    const isRateLimited = (key: string): boolean => {
      const bucket = failures.get(key)
      if (!bucket) return false
      if (bucket.resetAt <= Date.now()) {
        failures.delete(key)
        return false
      }
      return bucket.count >= maxFailures
    }
    const noteFailure = (key: string): void => {
      const now = Date.now()
      const bucket = failures.get(key)
      if (!bucket || bucket.resetAt <= now) {
        failures.set(key, { count: 1, resetAt: now + windowMs })
        return
      }
      bucket.count += 1
    }
    const clearFailures = (key: string): void => {
      failures.delete(key)
    }

    /* ---------- 审计 ---------- */
    /*
     * 审计写入**不阻塞主流程、也不让请求失败**：审计表损坏不该导致"谁都无法登录"。
     * 但失败必须留下痕迹（console.error），否则会变成静默的审计空洞。
     */
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
        console.error('[@geewiki/auth] 审计写入失败:', err)
      })
    }

    /* ---------- 会话 ---------- */
    interface SessionLookup {
      user: AuthUser
      sessionId: string
      expiresAt: string
      idleExpiresAt: string
      lastUsedAt: string
    }

    const lookupSession = async (rawToken: string): Promise<SessionLookup | undefined> => {
      /*
       * 显式给会话列起别名（`s_*`）：`s.id` 与 `u.id` 同名，直接 `SELECT s.*, u.*` 会让
       * 后一列覆盖前一列 —— 症状是"会话 id 看起来是个用户 id"，且完全不会报错。
       */
      const rows = await db.query<SessionJoinRow>(
        `SELECT s.id AS s_id,
                s.expires_at AS s_expires_at,
                s.idle_expires_at AS s_idle_expires_at,
                s.revoked_at AS s_revoked_at,
                s.last_used_at AS s_last_used_at,
                u.id, u.org_id, u.email, u.display_name, u.status,
                u.email_verified, u.created_at, u.last_seen_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
        [tokenHashOf(rawToken)],
      )
      const row = rows[0]
      if (!row) return undefined
      const now = new Date().toISOString()
      if (row.s_revoked_at !== null) return undefined
      // ISO8601 同为 UTC 'Z' 定长格式 ⇒ 字典序即时间序（不必解析成 Date）
      if (row.s_expires_at <= now || row.s_idle_expires_at <= now) return undefined
      if (row.status !== 'active') return undefined
      const user = toAuthUser(row, await resolveOrgRole(db, Number(row.id), Number(row.org_id)))
      return {
        user,
        sessionId: row.s_id,
        expiresAt: row.s_expires_at,
        idleExpiresAt: row.s_idle_expires_at,
        lastUsedAt: row.s_last_used_at,
      }
    }

    /**
     * 滑动空闲过期。
     *
     * **有节流**：`last_used_at` 距今不足 60 秒就不写库。理由：本函数在每个已登录请求上
     * 都会跑，逐请求一次 UPDATE 会把读路径变成写路径（SQLite 下还会放大 WAL 写入）。
     * 代价是空闲过期最多晚 60 秒生效 —— 对"7 天不用才失效"这个量级完全可忽略。
     */
    const touchSession = async (session: SessionLookup): Promise<void> => {
      const now = Date.now()
      if (now - Date.parse(session.lastUsedAt) < 60_000) return
      const iso = new Date(now).toISOString()
      await db.run('UPDATE sessions SET last_used_at = ?, idle_expires_at = ? WHERE id = ?', [
        iso,
        isoPlus(new Date(now), idleMs),
        session.sessionId,
      ])
    }

    const createSession = async (
      userId: number,
      req: IncomingMessage,
    ): Promise<{ rawToken: string; maxAgeSeconds: number; expiresAt: string }> => {
      const rawToken = randomBytes(32).toString('base64url')
      const now = new Date()
      const expiresAt = isoPlus(now, absoluteMs)
      await db.run(
        `INSERT INTO sessions
           (id, user_id, token_hash, created_at, last_used_at, expires_at, idle_expires_at, user_agent, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomBytes(16).toString('hex'),
          userId,
          tokenHashOf(rawToken),
          now.toISOString(),
          now.toISOString(),
          expiresAt,
          isoPlus(now, idleMs),
          typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null,
          auditIpHash(clientIp(req)),
        ],
      )
      return { rawToken, maxAgeSeconds: Math.floor(absoluteMs / 1000), expiresAt }
    }

    const revokeSession = async (sessionId: string): Promise<void> => {
      await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
        new Date().toISOString(),
        sessionId,
      ])
    }

    /* ---------- 前端钩子：CSRF 判据 + 会话解析 ---------- */
    /*
     * **顺序**：先 CSRF、后会话。CSRF 是纯 header 判定（无 IO），放在最前可以把
     * 跨站请求挡在"连会话都不查"的位置；而且它的判据里"是否带会话 cookie"只需看
     * cookie 的**存在性**，不需要解析出会话。
     *
     * **为什么钩子不因"会话无效"而拒绝**：无效/过期的 cookie 只应让主体退回匿名，
     * 而不该让**公开页面**也打不开（用户只是登录过期了，不是做错了事）。
     * 需要身份的端点由 `access` 闸门统一给出 401。
     */
    const authHook = async (h: RouteHandlerContext): Promise<RequestVerdict> => {
      const rawToken = readSessionToken(h.req)
      const violation = checkCsrf(h.req, rawToken !== null)
      if (violation) {
        return { ok: false, status: 403, code: violation.code, message: violation.message }
      }
      // 应急主体优先：break-glass 的意义正是"身份系统本身出问题时还能进场"，
      // 不该被一个损坏的 cookie 覆盖掉（否则应急通道会被"清 cookie"这类操作反向挟持）。
      if (h.principal?.kind === 'break-glass') return { ok: true }
      if (rawToken === null) return { ok: true }
      const session = await lookupSession(rawToken)
      if (!session) return { ok: true }
      const principal: Principal = {
        kind: 'user',
        userId: session.user.id,
        orgId: session.user.orgId,
        orgRole: session.user.orgRole,
        // ★ P2：组身份由组表展开（见 resolveGroupIds）。**必须逐请求现算**：
        // Principal 是"此刻的权限快照"，缓存它会让"把人移出组"在下一次请求仍生效 ——
        // 这正是设计文档 §9 R10 反模式第 3 条（用 TTL 缓存权限判定）的形态。
        groupIds: await resolveGroupIds(db, session.user.id, session.user.orgId),
        sessionId: session.sessionId,
      }
      h.principal = principal
      await touchSession(session)
      return { ok: true }
    }
    cleanups.push(router.use?.(authHook) ?? (() => {}))

    /* ---------- 端点实现 ---------- */

    const loadUser = async (userId: number): Promise<AuthUser | undefined> => {
      const rows = await db.query<UserRow>('SELECT * FROM users WHERE id = ?', [userId])
      const row = rows[0]
      if (!row) return undefined
      return toAuthUser(row, await resolveOrgRole(db, userId, Number(row.org_id)))
    }

    /* ---------- GET /api/auth/state（public） ---------- */
    /*
     * **一次调用拿到"我该去哪 + 我是谁"**，这是前端 authStore 的唯一数据源。
     *
     * 为什么不让前端"先问 state 再问 me"：`me` 是 `access:'user'`，未登录必然 401，
     * 而那个 401 会被 api 层的统一出口当成"会话失效"处理（跳登录页）—— 冷启动时
     * 每个匿名访客都会触发一次无意义的跳转。让公共端点顺带回传"调用者自己的身份"
     * 既省一次往返，也把"未登录"表达成正常状态而非错误。
     * （`GET /api/auth/me` 仍然保留：验收标准要求它未登录时返回 401。）
     */
    cleanups.push(
      router.register('GET', '/api/auth/state', async (h) => {
        const userId = h.principal?.kind === 'user' ? h.principal.userId : null
        const user = userId === null ? null : ((await loadUser(userId)) ?? null)
        h.json(200, {
          ok: true,
          /** true ⇒ 库里还没有任何可登录账号，前端应去 #/setup 而不是 #/login */
          setupRequired: !credentialSource,
          authenticated: h.principal?.kind === 'user' || h.principal?.kind === 'break-glass',
          /** 未登录时为 null；已登录时为调用者自己的公开字段（**不含**任何凭据） */
          user,
          /**
           * 能力下发：**只用于前端隐藏入口**，服务端判定一律独立进行
           * （前端隐藏不是安全措施，见设计文档 §9 R10 反模式第 5 条）。
           */
          capabilities: capabilitiesOf(h.principal),
          /** OIDC 通道属 P1.5：这里恒为 false，前端据此不渲染 SSO 按钮 */
          oidc: { available: false },
        })
      }),
    )

    /* ---------- POST /api/auth/setup（public；仅首次可用） ---------- */
    cleanups.push(
      router.register('POST', '/api/auth/setup', async (h) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(h)
        } catch (err) {
          const message = (err as Error).message
          const [code = 'invalid_body'] = message.split(':')
          h.json(code === 'payload_too_large' ? 413 : 400, { ok: false, error: code, message })
          return
        }
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const displayName =
          typeof body.displayName === 'string' && body.displayName.trim().length > 0
            ? body.displayName.trim()
            : email.split('@')[0] ?? 'owner'
        if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) {
          h.json(400, { ok: false, error: 'invalid_email', message: '邮箱格式不合法' })
          return
        }
        if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
          h.json(400, {
            ok: false,
            error: 'invalid_password',
            message: `口令长度须在 ${PASSWORD_MIN}–${PASSWORD_MAX} 之间`,
          })
          return
        }
        if (displayName.length > DISPLAY_NAME_MAX) {
          h.json(400, { ok: false, error: 'invalid_display_name', message: '显示名过长' })
          return
        }
        /*
         * **自守卫**：本端点是 public（否则首次引导无法进行），因此必须在处理体里
         * 自己把"已经有账号"这条路堵死 —— 否则它会变成一个匿名的"创建任意账号"接口。
         * 判定与写入放在**同一事务**里，避免两个并发请求同时看到"库里没有账号"。
         */
        const outcome = await db.transaction(async (tx) => {
          const existing = await tx.query<{ n: number | string }>('SELECT COUNT(*) AS n FROM users')
          if (Number(existing[0]?.n ?? 0) > 0) return { kind: 'already' as const }
          const now = new Date().toISOString()
          const inserted = await tx.run(
            `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at)
             VALUES (?, ?, ?, 'active', 1, ?) RETURNING id`,
            [1, email, displayName, now],
          )
          const userId = Number(inserted.lastInsertRowid)
          const credential: StoredCredential = await hashPassword(password)
          await tx.run(
            `INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, credential.algo, credential.params, credential.salt, credential.hash, now],
          )
          /*
           * ★ 引导 owner 的**组织成员身份**（P2）。
           *
           * 没有这一步，系统里将**永远不存在** owner/admin：`access:'admin'` 的端点
           * （插件管理台）在浏览器里永久不可用，而 `orgRole` 也恒为 null —— 这正是
           * P1 结束时的状态，也正是本阶段要解除的那条遗留后果。
           *
           * **与账号写入放在同一事务**：账号与"它是 owner"必须同时成立，否则中途失败
           * 会留下一个既不能管、又无法被提升的孤儿账号（它占着"库里已有账号"这个判据）。
           *
           * 本文件直写 `org_members` 而不调 `org-service`：这张表与 `users`/`sessions`
           * 同属核心基础设施表（0011 迁移建立），理由见 `resolveOrgRole` 的说明。
           */
          await tx.run(
            `INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
            [DEFAULT_ORG_ID, userId, now],
          )
          return { kind: 'created' as const, userId }
        })
        if (outcome.kind === 'already') {
          h.json(409, {
            ok: false,
            error: 'setup_already_done',
            message: '已完成初始化；请直接登录',
          })
          return
        }
        credentialSource = true
        const session = await createSession(outcome.userId, h.req)
        const user = await loadUser(outcome.userId)
        audit({
          action: 'user.setup',
          targetKind: 'user',
          targetId: String(outcome.userId),
          actorId: outcome.userId,
          actorIpHash: auditIpHash(clientIp(h.req)),
          after: { email, displayName, emailVerified: true },
        })
        h.res.setHeader('set-cookie', sessionCookie(session.rawToken, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookie }))
        h.json(201, { ok: true, user, expiresAt: session.expiresAt })
      }),
    )

    /* ---------- POST /api/auth/login（public） ---------- */
    cleanups.push(
      router.register('POST', '/api/auth/login', async (h) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(h)
        } catch (err) {
          const message = (err as Error).message
          const [code = 'invalid_body'] = message.split(':')
          h.json(code === 'payload_too_large' ? 413 : 400, { ok: false, error: code, message })
          return
        }
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const key = rateKey(h.req, email)
        if (isRateLimited(key)) {
          audit({
            action: 'login.rate_limited',
            targetKind: 'user',
            targetId: email || '(empty)',
            actorIpHash: auditIpHash(clientIp(h.req)),
          })
          h.json(429, {
            ok: false,
            error: 'too_many_requests',
            message: `登录失败次数过多，请 ${Math.ceil(windowMs / 1000)} 秒后再试`,
          })
          return
        }
        /*
         * LEFT JOIN 而非 INNER：账号存在但凭据行缺失（数据损坏、或建号时未设口令）时，
         * 仍要走到"凭据不存在"这条分支，而不是让查询返回空集把它伪装成"账号不存在"。
         * 凭据列因此可空 —— 类型上如实声明为 `| null`，不靠断言掩盖。
         */
        const rows = await db.query<
          UserRow & { algo: string | null; params: string | null; salt: string | null; hash: string | null }
        >(
          `SELECT u.*, c.algo, c.params, c.salt, c.hash
             FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
            WHERE u.email = ? AND u.org_id = 1`,
          [email],
        )
        const row = rows[0]
        const credential =
          row && row.algo && row.params && row.salt && row.hash
            ? { algo: row.algo, params: row.params, salt: row.salt, hash: row.hash }
            : null
        let ok = false
        if (row !== undefined && row.status === 'active' && credential !== null) {
          ok = await verifyPassword(password, credential)
        }
        /*
         * **账号不存在（或无凭据）时补跑一次同代价的 scrypt**：否则"邮箱不存在"（快）与
         * "口令错"（慢）的耗时有数量级差异，攻击者可据此枚举出哪些邮箱已注册。
         * 响应文案与错误码在两条路径上**完全一致**（设计文档 §7.4 第 7 条同理）。
         */
        if (credential === null) await dummyVerify(password)
        // `row === undefined` 与 `!ok` 同时判定：前者在逻辑上已被 `ok` 蕴含，
        // 但显式写出才能让类型收窄（否则下面 `row.id` 报 possibly undefined）。
        // 顺带：若将来有人改坏了上面的判定，这里也是最后一道失败关闭。
        if (!ok || row === undefined) {
          noteFailure(key)
          audit({
            action: 'login.fail',
            targetKind: 'user',
            targetId: email || '(empty)',
            actorIpHash: auditIpHash(clientIp(h.req)),
          })
          h.json(401, { ok: false, error: 'invalid_credentials', message: '邮箱或口令不正确' })
          return
        }
        clearFailures(key)
        const userId = Number(row.id)
        const now = new Date().toISOString()
        await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now, userId])
        const session = await createSession(userId, h.req)
        audit({
          action: 'login.ok',
          targetKind: 'user',
          targetId: String(userId),
          actorId: userId,
          actorIpHash: auditIpHash(clientIp(h.req)),
        })
        h.res.setHeader('set-cookie', sessionCookie(session.rawToken, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookie }))
        h.json(200, { ok: true, user: await loadUser(userId), expiresAt: session.expiresAt })
      }),
    )

    /* ---------- POST /api/auth/logout（public） ---------- */
    cleanups.push(
      router.register('POST', '/api/auth/logout', async (h) => {
        const rawToken = readSessionToken(h.req)
        if (rawToken !== null) {
          const session = await lookupSession(rawToken)
          if (session) {
            /*
             * **服务端吊销**，不是"让浏览器删掉 cookie"：后者对已经泄露出去的令牌
             * 毫无作用。验收标准（§8.2 P1 第 3 条）正是"登出后原 cookie 立即失效"。
             */
            await revokeSession(session.sessionId)
            audit({
              action: 'logout',
              targetKind: 'session',
              targetId: session.sessionId,
              actorId: session.user.id,
              actorIpHash: auditIpHash(clientIp(h.req)),
            })
          }
        }
        h.res.setHeader('set-cookie', clearedSessionCookie({ secure: secureCookie }))
        h.json(200, { ok: true })
      }),
    )

    /* ---------- GET /api/auth/me（user） ---------- */
    cleanups.push(
      router.register(
        'GET',
        '/api/auth/me',
        async (h) => {
          const userId = h.principal?.userId ?? null
          if (userId === null) {
            // 闸门已保证非匿名；走到这里说明 principal 被下游换掉了 —— 仍按失败关闭处理
            h.json(401, { ok: false, error: 'unauthorized', message: '需要登录' })
            return
          }
          const user = await loadUser(userId)
          if (!user) {
            h.json(401, { ok: false, error: 'unauthorized', message: '账号不存在或已停用' })
            return
          }
          h.json(200, {
            ok: true,
            user,
            session: { id: h.principal?.sessionId ?? null },
            /*
             * 能力下发：**只用于前端隐藏入口**，服务端判定一律独立进行
             * （前端隐藏不是安全措施，见设计文档 §9 R10 反模式第 5 条）。
             */
            capabilities: capabilitiesOf(h.principal),
          })
        },
        { access: 'user' },
      ),
    )

    /* ---------- POST /api/auth/password（user） ---------- */
    cleanups.push(
      router.register(
        'POST',
        '/api/auth/password',
        async (h) => {
          const userId = h.principal?.userId ?? null
          if (userId === null) {
            h.json(401, { ok: false, error: 'unauthorized', message: '需要登录' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(h)
          } catch (err) {
            const message = (err as Error).message
            const [code = 'invalid_body'] = message.split(':')
            h.json(code === 'payload_too_large' ? 413 : 400, { ok: false, error: code, message })
            return
          }
          const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
          const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
          if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
            h.json(400, {
              ok: false,
              error: 'invalid_password',
              message: `口令长度须在 ${PASSWORD_MIN}–${PASSWORD_MAX} 之间`,
            })
            return
          }
          const rows = await db.query<StoredCredential>(
            'SELECT algo, params, salt, hash FROM user_credentials WHERE user_id = ?',
            [userId],
          )
          const stored = rows[0]
          if (!stored || !(await verifyPassword(currentPassword, stored))) {
            h.json(401, { ok: false, error: 'invalid_credentials', message: '当前口令不正确' })
            return
          }
          const next = await hashPassword(newPassword)
          const now = new Date().toISOString()
          await db.transaction(async (tx) => {
            await tx.run(
              `UPDATE user_credentials SET algo = ?, params = ?, salt = ?, hash = ?, updated_at = ?
                WHERE user_id = ?`,
              [next.algo, next.params, next.salt, next.hash, now, userId],
            )
            /*
             * 改密后**吊销除当前会话外的全部会话**：口令泄露的典型应对就是改密，
             * 若旧会话仍然有效，改密就挡不住已经进来的攻击者。
             * 保留当前会话是为了不把正在操作的这个浏览器自己也踢下线。
             */
            await tx.run(
              'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
              [now, userId, h.principal?.sessionId ?? ''],
            )
          })
          audit({
            action: 'password.change',
            targetKind: 'user',
            targetId: String(userId),
            actorId: userId,
            actorIpHash: auditIpHash(clientIp(h.req)),
          })
          h.json(200, { ok: true, revokedOtherSessions: true })
        },
        { access: 'user' },
      ),
    )

    /* ---------- 对外服务 ---------- */
    const svc: AuthService = {
      hasCredentialSource: () => credentialSource,
      resolveSession: async (rawToken: string) => (await lookupSession(rawToken))?.user,
      /*
       * ★ P2 新增：由**受信插件**（当前只有 @geewiki/org 的邀请流程）建本地账号。
       *
       * 为什么放在服务契约而不是再加一个 HTTP 端点：账号创建是**身份域**的能力
       * （口令哈希、唯一性、credentialSource 的维护都在本插件），而"凭什么是这个人
       * 可以有账号"是**组织域**的判断（有效邀请）。让组织插件经服务调用来要这个能力，
       * 比让它自己写 `user_credentials` 表要正确得多 —— 后者会把口令哈希算法复制成
       * 两份，将来升级算法必然漏掉一处。
       *
       * **它不是"开放注册"**：这个方法本身不做任何鉴权，暴露面由调用方承担；
       * 调用方（org）必须先验证一个 256 位熵的、未过期、未消费、邮箱匹配的邀请令牌。
       */
      async createLocalUser(input) {
        const email = input.email.trim().toLowerCase()
        /*
         * 校验放在**服务这一侧**而不是调用方：口令强度与邮箱格式是身份域的规则，
         * 让 org 插件各写一份"长度至少几位"必然与这里漂移，而漂移的方向通常是
         * "某个入口悄悄放宽了"。调用方只需要把用户输入原样递进来。
         */
        if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) {
          return { ok: false as const, error: 'invalid_email' as const }
        }
        if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
          return { ok: false as const, error: 'invalid_password' as const }
        }
        return await db.transaction(async (tx) => {
          // 唯一性判据与 0010 的 `idx_users_org_email` 一致（org_id + email）
          const existing = await tx.query<{ id: number }>(
            'SELECT id FROM users WHERE org_id = ? AND email = ?',
            [DEFAULT_ORG_ID, email],
          )
          if (existing[0]) return { ok: false as const, error: 'email_taken' as const }
          const now = new Date().toISOString()
          const inserted = await tx.run(
            `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at)
             VALUES (?, ?, ?, 'active', 1, ?) RETURNING id`,
            [DEFAULT_ORG_ID, email, input.displayName, now],
          )
          const userId = Number(inserted.lastInsertRowid)
          const credential: StoredCredential = await hashPassword(input.password)
          await tx.run(
            `INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, credential.algo, credential.params, credential.salt, credential.hash, now],
          )
          return { ok: true as const, userId }
        }).then((result) => {
          // 库里从此有可登录账号 ⇒ 闸门不该再报 503 bootstrap_required（与 setup 同理）
          if (result.ok) credentialSource = true
          return result
        })
      },
    }
    const unprovide = ctx.provide('auth-service', svc)

    console.log(
      '[@geewiki/auth] 已激活: /api/auth/{state,setup,login,logout,me,password}, auth-service 服务' +
        `（凭据来源: ${credentialSource ? '已存在' : '无（需初始化）'}，cookie Secure: ${secureCookie ? 'on' : 'off'}）`,
    )

    return () => {
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      failures.clear()
      unprovide()
      console.log('[@geewiki/auth] 已卸载: 认证路由全部摘除，auth-service 已注销')
    }
  },
}
