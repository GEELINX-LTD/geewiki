/**
 * OIDC 相关的**纯**逻辑：类型、`issuer` 规范化、`link_ticket` 的签发与校验。
 *
 * 单独成文件的原因与 `http.ts` 相同：这些是**纯函数**，可以脱离路由、数据库与网络单测。
 * 其中 `link_ticket` 是"禁止按 email 自动绑定"（设计文档 §7.2）的载体 ——
 * 它的签名校验一旦写错，表现为"绑定静默失败"或更糟的"任意人可伪造绑定"。
 *
 * 本文件**不 import 本包的 `index.ts`**（避免循环依赖）：需要 `AuthUser` 的类型定义留在
 * `index.ts`，这里只放与它无关的部分。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/* ======================= 身份声明 ======================= */

/**
 * 从 ID token 里**验证通过后**提取的身份声明。
 *
 * `issuer` 必须是**已规范化**的值（见 {@link normalizeIssuer}）—— 生产方（`@geewiki/oidc`）
 * 负责规范化，消费方（本包）不再重复规范化时才比较，避免两处规则漂移。
 */
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
 * 规范化 `issuer`：`https://idp.example.com` 与 `https://idp.example.com/` 必须视为**同一个**。
 *
 * OIDC 规范允许 issuer 带或不带尾部斜杠，而 `user_identities` 的 `(issuer, subject)`
 * 唯一索引是**逐字节**比较的（设计文档 §7.1）。若不规范化，同一个 IdP 会产生两条 identity，
 * 表现为"同一个人每次登录都新建一个身份"。
 *
 * 非法值返回 `null`（调用方按失败关闭处理），**绝不回退成"原样使用"**。
 */
export function normalizeIssuer(issuer: string): string | null {
  const raw = issuer.trim()
  if (raw.length === 0) return null
  try {
    const url = new URL(raw)
    // 只接受 http(s)：其它 scheme（如 `javascript:`、`file:`）不是合法 issuer，
    // 且放行它们会让"配置错误"变成更难发现的行为。
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.href
  } catch {
    return null
  }
}

/* ======================= 绑定票据 ======================= */

/**
 * 绑定票据的载荷（设计文档 §7.2 的 `link_ticket`）。
 *
 * **为什么是签名票据而不是数据库里的一行**：设计文档 §7.6 明确要求本阶段
 * **迁移增量为 0**（`user_identities` 已在 P1 建表），而 §7.2 又要求票据"存 DB"。
 * 两者不可兼得时选择了**不新增表**，并把"一次性"这件事交给数据库的
 * `idx_identities_issuer_sub` 唯一索引来兜底 —— 重放同一张票据会在插入时撞唯一约束，
 * 效果与"票据被消费过"等价（见 `index.ts` 的 `POST /api/auth/identities/link`）。
 *
 * 代价（必须知道）：进程重启会让有效期内的票据失效（用户重走一次 SSO 即可），
 * 且多实例部署下票据不通用。两者都是**失败关闭**方向（拒绝，而不是放行）。
 */
export interface LinkTicketPayload {
  /** 已规范化的 issuer */
  iss: string
  /** OIDC sub */
  sub: string
  email: string | null
  emailVerified: boolean
  displayName: string | null
  /** 过期时刻（epoch ms） */
  exp: number
}

/** 票据有效期：设计文档 §7.2 定为 5 分钟 */
export const TICKET_TTL_MS = 5 * 60 * 1000

/**
 * 承载票据的 cookie 名。
 *
 * **`HttpOnly` 且从不出现在 URL 里**：票据是 bearer 凭据，放进查询串会经
 * `Referer`、浏览器历史、反代日志与截图泄漏。前端因此**看不到**票据，
 * 只能"带着 cookie"调用绑定端点（见 `index.ts`）。
 */
export const LINK_COOKIE = 'gw_link'

/** 签发绑定票据：`base64url(JSON).base64url(HMAC-SHA256)` */
export function signLinkTicket(payload: LinkTicketPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

/**
 * 校验绑定票据；任何一处不合法都返回 `null`（**失败关闭**）。
 *
 * 校验顺序：格式 → 签名（恒时比较）→ 载荷形状 → 过期。
 * 先验签名再解析载荷，避免把未经验证的 JSON 当作可信输入去读字段。
 */
export function verifyLinkTicket(
  token: string,
  secret: Buffer,
  now: number = Date.now(),
): LinkTicketPayload | null {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)

  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const given = Buffer.from(mac, 'utf8')
  const want = Buffer.from(expected, 'utf8')
  // 长度不等时 timingSafeEqual 会抛错，故先比长度（长度本身不是秘密）
  if (given.length !== want.length) return null
  if (!timingSafeEqual(given, want)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.iss !== 'string' || p.iss.length === 0) return null
  if (typeof p.sub !== 'string' || p.sub.length === 0) return null
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null
  if (p.exp <= now) return null
  const email = typeof p.email === 'string' && p.email.length > 0 ? p.email : null
  const displayName = typeof p.displayName === 'string' && p.displayName.length > 0 ? p.displayName : null
  return {
    iss: p.iss,
    sub: p.sub,
    email,
    emailVerified: p.emailVerified === true,
    displayName,
    exp: p.exp,
  }
}

/* ======================= provider 注册表 ======================= */

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
