/**
 * @geewiki/auth —— GeeWiki 身份插件（P1：身份与登录）
 *
 * 提供本地账号密码登录、会话管理与初始化向导。设计依据：
 * docs/design/access-control.md §3.1（数据模型）、§7（OIDC 留到 P1.5）、
 * §8.1 的 P1 行 / §8.2 的 P1 验收标准。
 *
 * 挂载路由（经 @geewiki/http 路由服务；`access` 为粗粒度准入等级，见设计文档 §2.5）：
 *   GET    /api/auth/state              初始化状态（public）—— 前端据此决定去 #/setup 还是 #/login
 *   POST   /api/auth/setup              创建首个账号（public，但自守卫：已有账号即 409）
 *   POST   /api/auth/login              登录（public）
 *   POST   /api/auth/logout             登出（public；吊销服务端会话，不只是删 cookie）
 *   GET    /api/auth/me                 当前身份（user）
 *   POST   /api/auth/password           修改自己的密码（user）
 *   GET    /api/auth/identities         列出自己的外部身份（user）—— P1.5
 *   POST   /api/auth/identities/link    确认绑定外部身份（user）—— P1.5，读 HttpOnly 票据 cookie
 *   POST   /api/auth/identities/unlink  解绑外部身份（user）—— P1.5，至少保留一种登录方式
 *
 * 同时经 `ctx.provide('auth-service', …)` 提供身份服务（契约见 {@link AuthService}）。
 *
 * **P1.5（OIDC）在本包内的分工**：本包持有 **provider 注册表**与**账号策略**（谁可以建号、
 * 绑定与解绑的裁决、票据的签发校验），而 **OIDC 协议本身**（发现文档、JWKS、PKCE、回跳路由）
 * 全在 `@geewiki/oidc` —— 形态对齐 `llm-service` 持有注册表、`@geewiki/openai` 提供协议实现。
 * 因此**未启用 `@geewiki/oidc` 时 `/api/auth/oidc/*` 根本不存在（404）**，
 * 而本包的本地密码通道完全不受影响（设计文档 §7.5）。
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
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  USER_LOGIN_EVENT,
  asAsync,
  auditIpHash,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type AuthService,
  type AuthUser,
  type DatabaseAdapterAsync,
  type GeeWikiManifest,
  type HttpRouterService,
  type OidcAuthOutcome,
  type Principal,
  type RequestVerdict,
  type RouteHandlerContext,
  type UserLoginEvent,
  builtinCapabilitiesOf,
  type CapabilityService,
  type CapabilitySet,
} from '@geewiki/core'
import { dummyVerify, hashPassword, verifyPassword, type StoredCredential } from './password.js'
import {
  checkCsrf,
  clearedSessionCookie,
  readCookie,
  readSessionToken,
  serializeCookie,
  sessionCookie,
} from './http.js'
import {
  LINK_COOKIE,
  TICKET_TTL_MS,
  normalizeIssuer,
  signLinkTicket,
  verifyLinkTicket,
  type OidcClaims,
  type OidcProvider,
} from './oidc.js'

export type { OidcClaims, OidcProvider, OidcProviderInfo } from './oidc.js'
export { LINK_COOKIE, normalizeIssuer, TICKET_TTL_MS } from './oidc.js'
/*
 * cookie 工具对外导出：SSO 适配器（`@geewiki/oidc`）要用**同一套 cookie 属性**写票据 cookie。
 * 属性不一致会让浏览器留下两个同名但不同作用域的 cookie —— "登出后还能用"正是这么来的。
 */
export {
  CSRF_HEADER,
  SESSION_COOKIE,
  clearedSessionCookie,
  readCookie,
  serializeCookie,
  sessionCookie,
} from './http.js'

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
  /**
   * OIDC 首登的 provisioning 策略（设计文档 §7.3）。
   *
   * - `off`：OIDC 首登**一律不建号**
   * - `invite_only`（**默认**）：必须存在该 email 的未消费邀请，否则 403 `no_invitation`
   * - `auto`：直接建号 —— **等价于把入站访问控制交给 IdP**，需显式开启
   *
   * 该策略放在**本包**而不是 `@geewiki/oidc`：它决定的是"账号能不能被创建"，
   * 属于身份策略而非协议细节；放两处会让"禁用 OIDC 插件"与"建号策略"两套配置互相打架。
   */
  oidcProvisioningMode?: 'off' | 'invite_only' | 'auto'
  /** `auto` 模式下的邮箱域名白名单（空数组 = 不限制；仅对 `auto` 生效） */
  oidcAllowedEmailDomains?: string[]
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
  oidcProvisioningMode: Schema.union([
    Schema.const('off').description('OIDC 首登一律不建号'),
    Schema.const('invite_only').description('必须存在该邮箱的未消费邀请（默认）'),
    Schema.const('auto').description('直接建号 —— 等价于把入站访问控制交给 IdP'),
  ])
    .default('invite_only')
    .description('OIDC 首次登录时的建号策略'),
  oidcAllowedEmailDomains: Schema.array(Schema.string())
    .default([])
    .description('auto 模式下的邮箱域名白名单（空 = 不限制；仅对 auto 生效）'),
})

/* ======================= auth-service 服务契约 ======================= */

/*
 * ★ F3：契约已**下沉到 `@geewiki/core`**（真源 `packages/core/src/services.ts`）。
 *
 * 这里只做**转出**，保证既有 `import { AuthService } from '@geewiki/auth'` 不破。
 * 但**新的消费方与替换实现请直接从 `@geewiki/core` 取** —— 替换身份实现的插件
 * 不该为了拿接口类型而依赖它要替换的那个包（语义倒挂，F3 消掉的正是它）。
 */
export type { AuthService, AuthUser, OidcAuthOutcome } from '@geewiki/core'

export const manifest: GeeWikiManifest = {
  name: '@geewiki/auth',
  version: '0.1.0',
  geewiki: {
    // ★ F10：跨界能力声明（宿主不强制，用于评审与可观测）
    permissions: ['env'],
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

interface IdentityRow {
  id: number
  issuer: string
  subject: string
  email_at_link: string | null
  linked_at: string
  last_login_at: string | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX = 254
const DISPLAY_NAME_MAX = 100
const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

/** 请求体上限（登录/设置密码都是小 JSON；1MB 与全仓其它读体处同量级） */
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

/*
 * ★ F9：**能力集合的真源已上移到 `@geewiki/core`**。
 *
 * 原先这里有一个本地的 `AuthCapabilities`（三个布尔字段），`web/src/api.ts` 里还有
 * 一模一样的第二份，`web/src/lib/navPlan.ts` 里还有第三份名字清单。三份真源意味着
 * "加一个能力"要改三处，而漏改一处**不会编译报错**——它只会让那个入口永远不出现。
 *
 * 现在：
 * - **能力名**在 `core/src/domain.ts`（内置三个 + 插件用 `a/b` 命名空间声明）；
 * - **取值规则**在 `core/src/services.ts` 的 `builtinCapabilitiesOf()`（本文件原先的
 *   `capabilitiesOf()` 就是它——规则本身没变，只是搬到了替换 auth 的插件也能拿到的地方）；
 * - **插件贡献的值**由 `capability-service` 注册的求解器给出。
 */

/**
 * 某主体的能力快照：内置（角色推导） ∪ 插件注册的求解器。
 *
 * **逐请求现取能力服务**，不在激活期存快照：提供者可能晚于本插件激活，
 * 也可能被热替换，而 `ctx.get` 拿不到时是**静默**返回 `undefined` 的——
 * 存快照会把"服务晚到"永久固化成"插件能力永远算不出来"。
 *
 * 拿不到服务时**退回纯内置**：这是保守的一侧（插件能力缺失 ⇒ 前端藏起对应入口），
 * 而不是"全都给"。
 */
function capabilitySnapshot(ctx: Context, principal: Principal | undefined): CapabilitySet {
  const svc = ctx.get('capability-service') as CapabilityService | undefined
  return svc ? svc.snapshot(principal) : builtinCapabilitiesOf(principal)
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
      /*
       * **"可登录的账号"必须把 OIDC 身份也算上**：OIDC 首登建出来的账号**没有密码行**
       * （身份即凭据）。若这里只数 `user_credentials`，一个"只有 SSO 用户"的实例会被判成
       * 没东西可登录 ⇒ 所有 `access:'user'` 端点返回 503 `bootstrap_required`（系统未就绪）
       * 而不是 401，前端会掉进"去初始化"的死循环。
       */
      const rows = await db.query<{ n: number | string }>(
        `SELECT COUNT(DISTINCT u.id) AS n FROM users u
           LEFT JOIN user_credentials c ON c.user_id = u.id
           LEFT JOIN user_identities  i ON i.user_id = u.id
          WHERE u.status = 'active' AND (c.user_id IS NOT NULL OR i.user_id IS NOT NULL)`,
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

    /* ---------- OIDC：provider 注册表 + 绑定票据 ---------- */
    /*
     * 本包只持有**注册表与账号策略**，协议实现在 `@geewiki/oidc`（见文件头）。
     * 注册表为空 ⇒ `capabilities.oidc.available=false`（reason `'disabled'`），
     * 前端不渲染 SSO 按钮；这与"插件未启用"是同一条通路，无需第二套判据。
     */
    const provisioningMode = config.oidcProvisioningMode ?? 'invite_only'
    const allowedEmailDomains = (config.oidcAllowedEmailDomains ?? [])
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter((d) => d.length > 0)

    /**
     * 票据签名密钥。
     *
     * 优先取 `GEEWIKI_OIDC_TICKET_SECRET`（多实例 / 重启后仍有效）；未配置则**每进程随机**。
     * 随机密钥的后果是"进程重启让有效期内的票据失效"——**失败关闭**方向（拒绝而非放行），
     * 且票据只有 5 分钟，用户重走一次 SSO 即可。绝不用固定默认值兜底：那等于把
     * "猜不到密钥"这条保证换成"读源码就知道"。
     */
    const ticketSecretEnv = (process.env.GEEWIKI_OIDC_TICKET_SECRET ?? '').trim()
    const ticketSecret =
      ticketSecretEnv.length >= 16 ? Buffer.from(ticketSecretEnv, 'utf8') : randomBytes(32)

    const oidcProviders = new Map<string, OidcProvider>()

    /**
     * `capabilities.oidc` 的取值。
     *
     * 三种形态对前端是**同一个判据**（`available === false` ⇒ 不渲染 SSO 按钮）：
     * - 没有 provider（插件未装 / 未启用）⇒ `reason: 'disabled'`
     * - 有 provider 但 IdP 不可达 / 配置不全 ⇒ `reason: 'unreachable' | 'unconfigured'`
     * - 可用 ⇒ 带 `startPath`，前端直接导航过去
     *
     * **同步**：`GET /api/auth/state` 是每个访客冷启动都会打的热路径，不能在这里做网络 IO ——
     * 可用性由 provider 自己缓存（见 `@geewiki/oidc`）。
     */
    const oidcCapability = ():
      | { available: true; providerId: string; label: string; startPath: string }
      | { available: false; reason: string } => {
      const all = [...oidcProviders.values()]
      const usable = all.find((p) => p.available())
      if (usable) {
        return {
          available: true,
          providerId: usable.id,
          label: usable.label,
          startPath: usable.startPath,
        }
      }
      return { available: false, reason: all[0]?.reason() ?? 'disabled' }
    }

    /** 邀请表是否已存在（`invitations` 属 P2 的 `0011_org_team.sql`；缺失时 `invite_only` 一律拒绝） */
    const hasInvitations = tables.has('invitations')

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

    /* ---------- OIDC：账号策略（设计文档 §7.2 / §7.3） ---------- */
    /*
     * 本段**不做任何 token 校验** —— 签名、`iss`、`aud`、`exp`、`nonce` 全部由调用方
     * （`@geewiki/oidc`）在拿到 ID token 时完成。这里只回答三个问题：
     * 这个外部身份是谁？它对应哪个账号？要不要建号 / 要不要先绑定？
     */

    /** 建会话 + 刷新 last_seen + 组装可直接写进响应头的 Set-Cookie */
    const loginAs = async (
      userId: number,
      req: IncomingMessage,
      method: 'password' | 'oidc' = 'password',
    ): Promise<{ user: AuthUser; setCookie: string; expiresAt: string }> => {
      await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [new Date().toISOString(), userId])
      const session = await createSession(userId, req)
      const user = await loadUser(userId)
      // 会话已建但账号读不到 = 并发删号。抛出去让调用方 500，而不是发一个指向空账号的 cookie。
      if (!user) throw new Error('@geewiki/auth: 会话已建立但账号不可读（并发删除？）')
      /*
       * F7 平台事件：登录成功（**SSO 侧**）。
       *
       * `loginAs` 被 SSO 的两条子路径共用（已绑定账号 / 首次建号），在这里发一次即可；
       * **本地密码路径不走 `loginAs`**（它在 `POST /api/auth/login` 里内联建会话），
       * 那边单独发同一个事件——两处都必须发，漏一处就是"某种登录方式不触发订阅者"，
       * 而那种缺口极难被发现。`method` 字段正是用来让订阅者区分两者的。
       *
       * 负载刻意**不含会话标识**：本事件是**广播**，所有订阅者都会收到；
       * 会话 id 属于"能关联到具体一次登录"的敏感标识，需要它的场景（审计关联）
       * 已经落在 `audit()` 里，不必再广播一份。
       */
      try {
        ctx.emit(USER_LOGIN_EVENT, { userId, method } satisfies UserLoginEvent)
      } catch (err) {
        console.warn(`[@geewiki/auth] ${USER_LOGIN_EVENT} 的订阅者抛错（已忽略，登录本身照常成功）:`, err)
      }
      return {
        user,
        setCookie: sessionCookie(session.rawToken, {
          maxAgeSeconds: session.maxAgeSeconds,
          secure: secureCookie,
        }),
        expiresAt: session.expiresAt,
      }
    }

    /** 统一拒绝出口：先落审计（**不含任何 token 内容**），再返回裁决 */
    const denyOidc = (
      reason: string,
      email: string | null,
      ipHash: string | null,
    ): OidcAuthOutcome => {
      audit({
        action: 'login.fail',
        targetKind: 'user',
        targetId: email ?? '(unknown)',
        actorIpHash: ipHash,
        after: { via: 'oidc', reason },
      })
      return { kind: 'denied', reason, email }
    }

    const issueTicket = (
      issuer: string,
      claims: OidcClaims,
    ): { ticket: string; expiresAt: string } => {
      const exp = Date.now() + TICKET_TTL_MS
      const ticket = signLinkTicket(
        {
          iss: issuer,
          sub: claims.subject,
          email: claims.email,
          emailVerified: claims.emailVerified,
          displayName: claims.displayName,
          exp,
        },
        ticketSecret,
      )
      return { ticket, expiresAt: new Date(exp).toISOString() }
    }

    const authenticateOidc = async (
      claims: OidcClaims,
      req: IncomingMessage,
    ): Promise<OidcAuthOutcome> => {
      const ipHash = auditIpHash(clientIp(req))
      const issuer = normalizeIssuer(claims.issuer)
      const subject = claims.subject.trim()
      if (issuer === null || subject.length === 0) return denyOidc('invalid_claims', null, ipHash)
      const email = claims.email === null ? null : claims.email.trim().toLowerCase()

      /* ① 已绑定的外部身份 → 直接登录（绝大多数登录走这条） */
      const bound = await db.query<{ iid: number; user_id: number; status: string }>(
        `SELECT i.id AS iid, i.user_id, u.status
           FROM user_identities i JOIN users u ON u.id = i.user_id
          WHERE i.issuer = ? AND i.subject = ?`,
        [issuer, subject],
      )
      const b = bound[0]
      if (b) {
        if (b.status !== 'active') return denyOidc('account_disabled', email, ipHash)
        const userId = Number(b.user_id)
        await db.run('UPDATE user_identities SET last_login_at = ? WHERE id = ?', [
          new Date().toISOString(),
          b.iid,
        ])
        const out = await loginAs(userId, req, 'oidc')
        audit({
          action: 'login.ok',
          targetKind: 'user',
          targetId: String(userId),
          actorId: userId,
          actorIpHash: ipHash,
          after: { via: 'oidc', issuer },
        })
        return { kind: 'login', ...out }
      }

      /*
       * ② 未绑定，但该 email 已有本地账号 ⇒ **绝不自动合并**（设计文档 §7.2）。
       * 两条理由都是账号接管：IdP 的 email 未验证或被攻破时可接管本地账号；
       * 反向也能预先占位等真实用户"被合并"进攻击者的账号。
       * 注意：即便 `emailVerified` 为真也**仍然要求手动确认** —— 那只是 IdP 的**声明**。
       */
      if (email !== null) {
        const existing = await db.query<{ id: number }>(
          'SELECT id FROM users WHERE org_id = 1 AND email = ?',
          [email],
        )
        if (existing[0]) {
          const { ticket, expiresAt } = issueTicket(issuer, claims)
          audit({
            action: 'login.fail',
            targetKind: 'user',
            targetId: email,
            actorIpHash: ipHash,
            after: { via: 'oidc', reason: 'identity_link_required' },
          })
          return { kind: 'link_required', ticket, email, expiresAt }
        }
      }

      /* ③ 建号策略 */
      if (provisioningMode === 'off') return denyOidc('provisioning_off', email, ipHash)
      if (email === null) return denyOidc('email_required', null, ipHash)
      if (provisioningMode === 'auto') {
        if (allowedEmailDomains.length > 0) {
          const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
          if (!allowedEmailDomains.includes(domain)) {
            return denyOidc('email_domain_not_allowed', email, ipHash)
          }
        }
      } else {
        // invite_only（默认）。邀请表属 P2 的 0011 迁移：不存在时一律按"无邀请"拒绝，
        // 且**查询失败也按无邀请处理**（失败关闭），不让表结构差异变成一条放行路径。
        const invited = hasInvitations ? await hasUnconsumedInvite(email) : false
        if (!invited) {
          audit({
            action: 'login.fail',
            targetKind: 'user',
            targetId: email,
            actorIpHash: ipHash,
            after: { via: 'oidc', reason: 'no_invitation' },
          })
          return { kind: 'no_invitation', email }
        }
      }

      /* ④ 建号 + 绑定（同事务；两处唯一索引兜住并发） */
      const displayName = (claims.displayName ?? email.split('@')[0] ?? 'user').slice(
        0,
        DISPLAY_NAME_MAX,
      )
      try {
        const created = await db.transaction(async (tx) => {
          const now = new Date().toISOString()
          const inserted = await tx.run(
            `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at)
             VALUES (?, ?, ?, 'active', ?, ?) RETURNING id`,
            [1, email, displayName, claims.emailVerified ? 1 : 0, now],
          )
          const userId = Number(inserted.lastInsertRowid)
          await tx.run(
            `INSERT INTO user_identities (user_id, issuer, subject, email_at_link, linked_at)
             VALUES (?, ?, ?, ?, ?)`,
            [userId, issuer, subject, email, now],
          )
          if (hasInvitations) {
            await tx.run(
              `UPDATE invitations SET accepted_at = ?
                WHERE org_id = 1 AND email = ? AND accepted_at IS NULL`,
              [now, email],
            )
          }
          return userId
        })
        // 首个 SSO 账号同样是"可登录账号" ⇒ 探针必须即时更新（否则写端点会一直 503）
        await refreshCredentialSource()
        const out = await loginAs(created, req, 'oidc')
        audit({
          action: 'user.create',
          targetKind: 'user',
          targetId: String(created),
          actorId: created,
          actorIpHash: ipHash,
          after: { via: 'oidc', issuer, email, emailVerified: claims.emailVerified },
        })
        /*
         * 建号与首次登录是**两件事**，审计里都要有：只记 `user.create` 的话，
         * "某个账号第一次是怎么进来的"在登录流水里会显示成空白。
         */
        audit({
          action: 'login.ok',
          targetKind: 'user',
          targetId: String(created),
          actorId: created,
          actorIpHash: ipHash,
          after: { via: 'oidc', issuer, created: true },
        })
        return { kind: 'login', ...out }
      } catch (err) {
        /*
         * 并发下可能撞 `idx_users_org_email` 或 `idx_identities_issuer_sub`。
         * 退化成"需要绑定"（不是放行、也不是 500）；若账号确实还不存在，说明是别的故障，
         * 原样抛出，不要把它伪装成可恢复的业务结果。
         */
        const again = await db.query<{ id: number }>(
          'SELECT id FROM users WHERE org_id = 1 AND email = ?',
          [email],
        )
        if (!again[0]) throw err
        const { ticket, expiresAt } = issueTicket(issuer, claims)
        return { kind: 'link_required', ticket, email, expiresAt }
      }
    }

    /** 是否存在该 email 的未消费邀请。**任何异常都按"没有"处理**（失败关闭）。 */
    const hasUnconsumedInvite = async (email: string): Promise<boolean> => {
      try {
        const rows = await db.query<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM invitations
            WHERE org_id = 1 AND email = ? AND accepted_at IS NULL AND expires_at > ?`,
          [email, new Date().toISOString()],
        )
        return Number(rows[0]?.n ?? 0) > 0
      } catch (err) {
        console.error('[@geewiki/auth] 邀请查询失败，按"无邀请"处理（失败关闭）:', err)
        return false
      }
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
          capabilities: capabilitySnapshot(ctx, h.principal),
          /** OIDC 通道（P1.5）：未启用 `@geewiki/oidc` 时 `available:false`，前端不渲染 SSO 按钮 */
          oidc: oidcCapability(),
        })
      }, { access: 'public' }),
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
            message: `密码长度须在 ${PASSWORD_MIN}–${PASSWORD_MAX} 之间`,
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
      }, { access: 'public' }),
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
         * LEFT JOIN 而非 INNER：账号存在但凭据行缺失（数据损坏、或建号时未设密码）时，
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
         * "密码错"（慢）的耗时有数量级差异，攻击者可据此枚举出哪些邮箱已注册。
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
          h.json(401, { ok: false, error: 'invalid_credentials', message: '邮箱或密码不正确' })
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
        /*
         * F7 平台事件：登录成功（**本地密码路径**）。
         *
         * 这条路径**不走 `loginAs`**（它内联建会话），所以事件必须在这里单独发一次。
         * 两处都发是刻意的：只发 SSO 那一处，症状是"用密码登录的人不触发订阅者"——
         * 而写订阅者的插件作者通常只用密码测试，于是这个缺口会一直潜伏到某个用户报障。
         */
        try {
          ctx.emit(USER_LOGIN_EVENT, { userId, method: 'password' } satisfies UserLoginEvent)
        } catch (err) {
          console.warn(`[@geewiki/auth] ${USER_LOGIN_EVENT} 的订阅者抛错（已忽略，登录本身照常成功）:`, err)
        }
        h.json(200, { ok: true, user: await loadUser(userId), expiresAt: session.expiresAt })
      }, { access: 'public' }),
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
      }, { access: 'public' }),
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
            capabilities: capabilitySnapshot(ctx, h.principal),
          })
        },
        { access: 'user' },
      ),
    )

    /* ---------- ★ P4：会话管理（admin） ---------- */
    /*
     * 三条端点的共同约束：
     *
     * - **服务端吊销**（写 `revoked_at`），不是"删掉客户端的 cookie" —— 后者对已经拿到
     *   令牌副本的人零效果。
     * - `ip_hash` 是**哈希**不是 IP 原文；界面上不要把它渲染成 "IP"。它存在的意义是
     *   "同一来源的会话能对上"，不是回溯到具体地址。
     * - 吊销必须**写审计**：把人在线踢下来是有后果的运维动作，要能事后回答"谁踢的、何时"。
     * - 我们**不提供**"列出会话令牌"这类信息 —— `token_hash` 连哈希都不出接口，
     *   因为它是可离线爆破的凭据材料（哪怕成本高，也没有任何展示必要）。
     */
    const SESSION_LIST_MAX = 200

    interface SessionRow {
      id: string
      user_id: number
      created_at: string
      last_used_at: string
      expires_at: string
      idle_expires_at: string
      revoked_at: string | null
      user_agent: string | null
      ip_hash: string | null
    }

    const sessionView = (r: SessionRow, now: string) => ({
      id: r.id,
      userId: r.user_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      idleExpiresAt: r.idle_expires_at,
      revokedAt: r.revoked_at,
      userAgent: r.user_agent,
      ipHash: r.ip_hash,
      /*
       * 综合状态：`revoked` 优先于过期 —— 一条被显式踢下线的会话，运维想知道的是
       * "被人踢了"，而不是"它同时恰好也过期了"。时间列都是 ISO8601，字符串比较即时间比较。
       */
      status:
        r.revoked_at !== null
          ? 'revoked'
          : r.expires_at <= now || r.idle_expires_at <= now
            ? 'expired'
            : 'active',
    })

    cleanups.push(
      router.register(
        'GET',
        '/api/admin/sessions',
        async (h) => {
          const rawUserId = h.url.searchParams.get('userId')
          const rawLimit = Number(h.url.searchParams.get('limit') ?? SESSION_LIST_MAX)
          const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(1, Math.trunc(rawLimit)), SESSION_LIST_MAX)
            : SESSION_LIST_MAX
          const now = new Date().toISOString()

          const where: string[] = []
          const params: unknown[] = []
          if (rawUserId !== null && rawUserId !== '') {
            const userId = Number(rawUserId)
            if (!Number.isInteger(userId) || userId <= 0) {
              h.json(400, { ok: false, error: 'invalid_user_id', message: 'userId 必须是正整数' })
              return
            }
            where.push('user_id = ?')
            params.push(userId)
          }
          const sql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
          const countRows = await db.query<{ n: number | string }>(
            `SELECT COUNT(*) AS n FROM sessions${sql}`,
            params,
          )
          // PG 的 COUNT(*) 返回字符串，必须强转
          const total = Number(countRows[0]?.n ?? 0)
          const rows = await db.query<SessionRow>(
            `SELECT id, user_id, created_at, last_used_at, expires_at, idle_expires_at,
                    revoked_at, user_agent, ip_hash
               FROM sessions${sql}
              ORDER BY last_used_at DESC, id DESC
              LIMIT ?`,
            [...params, limit],
          )
          h.json(200, { ok: true, total, limit, entries: rows.map((r) => sessionView(r, now)) })
        },
        { access: 'admin' },
      ),
    )

    cleanups.push(
      router.register(
        'POST',
        '/api/admin/sessions/:id/revoke',
        async (h) => {
          const id = h.params.id ?? ''
          const now = new Date().toISOString()
          const row = (
            await db.query<{ user_id: number; revoked_at: string | null }>(
              'SELECT user_id, revoked_at FROM sessions WHERE id = ?',
              [id],
            )
          )[0]
          if (!row) {
            h.json(404, { ok: false, error: 'not_found', message: `会话不存在: ${id}` })
            return
          }
          if (row.revoked_at !== null) {
            /*
             * **幂等**：对已吊销的会话再吊销一次不算错（运维脚本重跑、界面重复点击都常见）。
             * 但**不重复写审计** —— 否则同一个事实被记成多次，审计就不再是"发生过什么"的记录。
             */
            h.json(200, { ok: true, id, alreadyRevoked: true, revokedAt: row.revoked_at })
            return
          }
          await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
            now,
            id,
          ])
          audit({
            action: 'admin.session_revoke',
            targetKind: 'session',
            targetId: id,
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { revokedAt: null },
            after: { revokedAt: now, userId: row.user_id },
          })
          h.json(200, { ok: true, id, alreadyRevoked: false, revokedAt: now })
        },
        { access: 'admin' },
      ),
    )

    cleanups.push(
      router.register(
        'POST',
        '/api/admin/users/:userId/sessions/revoke',
        async (h) => {
          const userId = Number(h.params.userId ?? '')
          if (!Number.isInteger(userId) || userId <= 0) {
            h.json(400, { ok: false, error: 'invalid_user_id', message: 'userId 必须是正整数' })
            return
          }
          const now = new Date().toISOString()
          const before = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
            [userId],
          )
          const affected = Number(before[0]?.n ?? 0)
          await db.run(
            'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
            [now, userId],
          )
          // 无人可踢时也写审计：这是"某账号被要求下线"的意图记录，不是被踢人数的统计
          audit({
            action: 'admin.session_revoke',
            targetKind: 'user',
            targetId: String(userId),
            actorId: h.principal?.userId ?? null,
            actorIpHash: auditIpHash(clientIp(h.req)),
            after: { revokedAt: now, revokedCount: affected },
          })
          h.json(200, { ok: true, userId, revokedCount: affected, revokedAt: now })
        },
        { access: 'admin' },
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
              message: `密码长度须在 ${PASSWORD_MIN}–${PASSWORD_MAX} 之间`,
            })
            return
          }
          const rows = await db.query<StoredCredential>(
            'SELECT algo, params, salt, hash FROM user_credentials WHERE user_id = ?',
            [userId],
          )
          const stored = rows[0]
          if (!stored || !(await verifyPassword(currentPassword, stored))) {
            h.json(401, { ok: false, error: 'invalid_credentials', message: '当前密码不正确' })
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
             * 改密后**吊销除当前会话外的全部会话**：密码泄露的典型应对就是改密，
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

    /* ---------- POST /api/auth/profile（user）：改邮箱 / 显示名 ---------- */
    /*
     * ★ 为什么邮箱与显示名走**同一个**端点，而不是各开一个：
     * 两者的准入条件必须完全一样（下一条），而"改邮箱要密码、改名字不要"这种差别
     * 一旦拆开，就会在前端与后端各写一遍判据，迟早漏一处。合成一个动作之后，
     * 这条规则只有一个形态。
     *
     * ★ **必须验当前密码**。邮箱是**登录标识符**，改它等于改"这个账号怎么被认出来"；
     * 只凭一个会话 cookie 就能改的话，一个被盗的会话（或一台没锁屏的机器）就等于
     * 账号接管 —— 攻击者把邮箱改成自己的，再走"忘记密码"那条路（若将来有）就完成了。
     * 验证当前密码把这一步重新绑回"知道凭据的人"。
     *
     * ★ 改邮箱**不吊销其它会话**（与改密码那条不同）。两者对应的是不同的威胁：
     * 改密码是"凭据可能已泄露"的应对，故必须把别人踢下线；改邮箱是可逆的展示层
     * 归属变更，且已经要求了密码 —— 顺手把用户自己的其它设备全踢下线是净损失。
     *
     * ★ **OIDC 用户走不通这条路**（`no_local_credential`）：SSO 开户的账号没有
     * `user_credentials` 行，因而没有可验证的当前密码。本轮**不动 OIDC**，
     * 这条边界是刻意留着的 —— 处理它需要一个显式的产品决定（允许改显示名？
     * 还是以 IdP 为准、这里干脆不给改？）。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/auth/profile',
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
          // 空串 = "这一项不改"（与"改成空"区分开：邮箱与显示名都不允许为空）
          const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
          const rawDisplay = typeof body.displayName === 'string' ? body.displayName.trim() : ''
          if (rawEmail === '' && rawDisplay === '') {
            h.json(400, { ok: false, error: 'nothing_to_update', message: '没有要修改的内容' })
            return
          }
          if (rawEmail !== '' && (!EMAIL_RE.test(rawEmail) || rawEmail.length > EMAIL_MAX)) {
            h.json(400, { ok: false, error: 'invalid_email', message: '邮箱格式不合法' })
            return
          }
          if (rawDisplay !== '' && rawDisplay.length > DISPLAY_NAME_MAX) {
            h.json(400, { ok: false, error: 'invalid_display_name', message: '显示名过长' })
            return
          }

          const credRows = await db.query<StoredCredential>(
            'SELECT algo, params, salt, hash FROM user_credentials WHERE user_id = ?',
            [userId],
          )
          const stored = credRows[0]
          if (!stored) {
            h.json(409, {
              ok: false,
              error: 'no_local_credential',
              message: '该账号通过 SSO 登录，没有本地密码，暂不支持在这里修改资料',
            })
            return
          }
          if (!(await verifyPassword(currentPassword, stored))) {
            h.json(401, { ok: false, error: 'invalid_credentials', message: '当前密码不正确' })
            return
          }

          const current = await db.query<{ email: string; display_name: string }>(
            'SELECT email, display_name FROM users WHERE id = ?',
            [userId],
          )
          const row = current[0]
          if (!row) {
            h.json(401, { ok: false, error: 'unauthorized', message: '账号不存在' })
            return
          }
          const nextEmail = rawEmail !== '' ? rawEmail : row.email
          const nextDisplay = rawDisplay !== '' ? rawDisplay : row.display_name

          /*
           * 唯一性判据与 `idx_users_org_email`（0010）一致：**org_id + email**。
           * 只在真的改了邮箱时查 —— 否则"只改显示名"会撞上自己那一行。
           * 不靠捕获唯一索引冲突来报错：那样拿到的是驱动的错误串，翻不成一句人话。
           */
          if (nextEmail !== row.email) {
            const dup = await db.query<{ id: number }>(
              'SELECT id FROM users WHERE org_id = ? AND email = ? AND id <> ?',
              [DEFAULT_ORG_ID, nextEmail, userId],
            )
            if (dup[0]) {
              h.json(409, { ok: false, error: 'email_taken', message: '该邮箱已被占用' })
              return
            }
          }

          if (nextEmail === row.email && nextDisplay === row.display_name) {
            // 没有任何字段真的变了：如实返回"没变"，不写一条空审计
            h.json(200, { ok: true, changed: false, user: { id: userId, email: row.email, displayName: row.display_name } })
            return
          }

          await db.run('UPDATE users SET email = ?, display_name = ? WHERE id = ?', [
            nextEmail,
            nextDisplay,
            userId,
          ])
          /*
           * `before` / `after` 都写全：审计页会把它们渲染成「改成了什么」的差异
           * （`changedFields`）。身份变更的台账价值全在这里 —— 只记"某人改了资料"
           * 等于没记。
           */
          audit({
            action: 'user.profile.update',
            targetKind: 'user',
            targetId: String(userId),
            actorId: userId,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { email: row.email, displayName: row.display_name },
            after: { email: nextEmail, displayName: nextDisplay },
          })
          h.json(200, {
            ok: true,
            changed: true,
            user: { id: userId, email: nextEmail, displayName: nextDisplay },
          })
        },
        { access: 'user' },
      ),
    )

    /* ---------- GET /api/auth/identities（user） ---------- */
    cleanups.push(
      router.register(
        'GET',
        '/api/auth/identities',
        async (h) => {
          const userId = h.principal?.userId ?? null
          if (userId === null) {
            h.json(401, { ok: false, error: 'unauthorized', message: '需要登录' })
            return
          }
          const rows = await db.query<IdentityRow>(
            `SELECT id, issuer, subject, email_at_link, linked_at, last_login_at
               FROM user_identities WHERE user_id = ? ORDER BY id`,
            [userId],
          )
          const cred = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?',
            [userId],
          )
          h.json(200, {
            ok: true,
            /** 前端据此判断"能不能解绑"：没有密码且只有一个身份时不可以 */
            hasPassword: Number(cred[0]?.n ?? 0) > 0,
            identities: rows.map((r) => ({
              id: Number(r.id),
              issuer: r.issuer,
              subject: r.subject,
              emailAtLink: r.email_at_link,
              linkedAt: r.linked_at,
              lastLoginAt: r.last_login_at,
            })),
          })
        },
        { access: 'user' },
      ),
    )

    /* ---------- POST /api/auth/identities/link（user） ---------- */
    /*
     * 票据**只从 HttpOnly cookie 读**，不接受请求体传入：票据是 bearer 凭据，
     * 一旦允许从 body/query 传，它就会出现在前端代码、日志与截图里。
     * 前端因此不需要（也看不到）票据，只需"带着 cookie"调用本端点。
     */
    cleanups.push(
      router.register(
        'POST',
        '/api/auth/identities/link',
        async (h) => {
          const userId = h.principal?.userId ?? null
          if (userId === null) {
            h.json(401, { ok: false, error: 'unauthorized', message: '需要登录' })
            return
          }
          const clearLink = (): void => {
            h.res.setHeader('set-cookie', serializeCookie(LINK_COOKIE, '', { maxAgeSeconds: 0, secure: secureCookie }))
          }
          const raw = readCookie(h.req, LINK_COOKIE)
          if (raw === null) {
            h.json(400, { ok: false, error: 'link_ticket_missing', message: '没有待确认的绑定请求' })
            return
          }
          const payload = verifyLinkTicket(raw, ticketSecret)
          if (payload === null) {
            clearLink()
            h.json(400, { ok: false, error: 'link_ticket_invalid', message: '绑定请求已过期或无效，请重新登录 SSO' })
            return
          }
          const existing = await db.query<{ id: number; user_id: number }>(
            'SELECT id, user_id FROM user_identities WHERE issuer = ? AND subject = ?',
            [payload.iss, payload.sub],
          )
          const found = existing[0]
          if (found) {
            clearLink()
            if (Number(found.user_id) !== userId) {
              // 该外部身份已属于别人 —— 这是需要人工介入的状态，不能静默改绑
              h.json(409, {
                ok: false,
                error: 'identity_already_bound',
                message: '该外部身份已绑定到其他账号',
              })
              return
            }
            h.json(200, { ok: true, alreadyLinked: true })
            return
          }
          try {
            await db.run(
              `INSERT INTO user_identities (user_id, issuer, subject, email_at_link, linked_at)
               VALUES (?, ?, ?, ?, ?)`,
              [userId, payload.iss, payload.sub, payload.email, new Date().toISOString()],
            )
          } catch {
            /*
             * 撞 `idx_identities_issuer_sub` = 票据被重放，或并发下另一个请求先插进去了。
             * **唯一索引就是"一次性"的实现**（见 oidc.ts 的说明）：这里如实报冲突，不放行。
             */
            clearLink()
            h.json(409, {
              ok: false,
              error: 'identity_already_bound',
              message: '该外部身份已绑定',
            })
            return
          }
          clearLink()
          audit({
            action: 'identity.link',
            targetKind: 'user',
            targetId: String(userId),
            actorId: userId,
            actorIpHash: auditIpHash(clientIp(h.req)),
            after: { issuer: payload.iss, subject: payload.sub },
          })
          h.json(200, { ok: true, alreadyLinked: false })
        },
        { access: 'user' },
      ),
    )

    /* ---------- POST /api/auth/identities/unlink（user） ---------- */
    cleanups.push(
      router.register(
        'POST',
        '/api/auth/identities/unlink',
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
          const identityId = Number(body.identityId)
          if (!Number.isInteger(identityId) || identityId <= 0) {
            h.json(400, { ok: false, error: 'invalid_identity_id', message: 'identityId 不合法' })
            return
          }
          const rows = await db.query<IdentityRow>(
            'SELECT id, issuer, subject, email_at_link, linked_at, last_login_at FROM user_identities WHERE id = ? AND user_id = ?',
            [identityId, userId],
          )
          const row = rows[0]
          if (!row) {
            // 不属于自己与不存在返回同一个结果：不泄漏"某个 id 是否存在"
            h.json(404, { ok: false, error: 'identity_not_found', message: '外部身份不存在' })
            return
          }
          /*
           * **至少保留一种登录方式**（设计文档 §7.2）：解绑最后一个身份且没有密码
           * ⇒ 该账号再也无法登录，而它可能还挂着内容的所有权。
           */
          const cred = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?',
            [userId],
          )
          const ident = await db.query<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ?',
            [userId],
          )
          const hasPassword = Number(cred[0]?.n ?? 0) > 0
          if (!hasPassword && Number(ident[0]?.n ?? 0) <= 1) {
            h.json(409, {
              ok: false,
              error: 'last_credential',
              message: '这是最后一个登录方式，无法解绑（请先设置密码）',
            })
            return
          }
          await db.run('DELETE FROM user_identities WHERE id = ? AND user_id = ?', [identityId, userId])
          audit({
            action: 'identity.unlink',
            targetKind: 'user',
            targetId: String(userId),
            actorId: userId,
            actorIpHash: auditIpHash(clientIp(h.req)),
            before: { issuer: row.issuer, subject: row.subject },
          })
          h.json(200, { ok: true })
        },
        { access: 'user' },
      ),
    )

    /* ---------- 对外服务 ---------- */
    const svc: AuthService = {
      hasCredentialSource: () => credentialSource,
      resolveSession: async (rawToken: string) => (await lookupSession(rawToken))?.user,
      registerOidcProvider: (provider: OidcProvider) => {
        // 重复 id 抛错而非静默覆盖：两个 adapter 抢同一个 id 是需要被看见的配置冲突
        // （与 llm-service 的路由注册表同一裁决）。
        if (oidcProviders.has(provider.id)) {
          throw new Error(`@geewiki/auth: OIDC provider id 重复注册: ${provider.id}`)
        }
        oidcProviders.set(provider.id, provider)
        return () => {
          if (oidcProviders.get(provider.id) === provider) oidcProviders.delete(provider.id)
        }
      },
      listOidcProviders: () =>
        [...oidcProviders.values()].map((p) => {
          const available = p.available()
          return {
            id: p.id,
            label: p.label,
            startPath: p.startPath,
            available,
            reason: available ? null : (p.reason() ?? 'unavailable'),
          }
        }),
      authenticateOidc,
      /*
       * ★ P2 新增：由**受信插件**（当前只有 @geewiki/org 的邀请流程）建本地账号。
       *
       * 为什么放在服务契约而不是再加一个 HTTP 端点：账号创建是**身份域**的能力
       * （密码哈希、唯一性、credentialSource 的维护都在本插件），而"凭什么是这个人
       * 可以有账号"是**组织域**的判断（有效邀请）。让组织插件经服务调用来要这个能力，
       * 比让它自己写 `user_credentials` 表要正确得多 —— 后者会把密码哈希算法复制成
       * 两份，将来升级算法必然漏掉一处。
       *
       * **它不是"开放注册"**：这个方法本身不做任何鉴权，暴露面由调用方承担；
       * 调用方（org）必须先验证一个 256 位熵的、未过期、未消费、邮箱匹配的邀请令牌。
       */
      async createLocalUser(input) {
        const email = input.email.trim().toLowerCase()
        /*
         * 校验放在**服务这一侧**而不是调用方：密码强度与邮箱格式是身份域的规则，
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
