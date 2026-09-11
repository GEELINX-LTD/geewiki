/**
 * 会话 Cookie 与 CSRF 的 HTTP 细节。
 *
 * 这些逻辑**单独成文件**是因为它们全是纯函数（除了读请求头），可以脱离路由与数据库单测：
 * Cookie 解析/序列化的边界（属性顺序、空值、同名多个）与 CSRF 判据一旦写错，
 * 表现为"偶尔登录不上"或"某个浏览器下所有写操作 403"，极难定位。
 */
import type { IncomingMessage } from 'node:http'

/**
 * 会话 cookie 名。
 *
 * 与设计文档 §6.5 的缓存分流约定一致：**门户渲染按"存在该 cookie"降级为 `private, no-store`**
 * （判存在性而非会话有效性 —— 后者要查库，而前者是纯 header 解析，且更保守：
 * 拿到任意垃圾 cookie 也走 `no-store`）。改名会让那条约定失效。
 */
export const SESSION_COOKIE = 'gw_sid'

/** 自定义 CSRF 头：跨站表单**无法**设置自定义头，这是第二道闸门 */
export const CSRF_HEADER = 'x-gw-csrf'

/** 解析 Cookie 头；找不到返回 `null` */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (typeof raw !== 'string' || raw.length === 0) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return value.length > 0 ? decodeURIComponent(value) : null
  }
  return null
}

/** 读取会话令牌（cookie 的原始值） */
export function readSessionToken(req: IncomingMessage): string | null {
  return readCookie(req, SESSION_COOKIE)
}

export interface CookieOptions {
  /** 有效期（秒）；`0` 表示立即失效（登出） */
  maxAgeSeconds: number
  /** 是否加 `Secure`（生产必须为 true；本地 http 调试时必须为 false，否则浏览器不回传） */
  secure: boolean
}

/**
 * 序列化任意 cookie（会话与 OIDC 绑定票据共用同一套属性规则）。
 *
 * - `HttpOnly`：JS 读不到 ⇒ XSS 不能直接偷走凭据。
 * - `SameSite=Lax`：阻断绝大多数跨站 POST（CSRF 主防线）。
 * - `Path=/`：全站可用（门户与 API 同源）。
 * - **不加 `Domain`**：保持 host-only，避免子域互相覆盖。
 *
 * 两个 cookie 必须用**同一套属性**：属性不一致会让浏览器留下两个同名但不同作用域的
 * cookie，"登出后还能用"这类问题正是这么来的。
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
  ]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/** 序列化会话 cookie。 */
export function sessionCookie(rawToken: string, opts: CookieOptions): string {
  return serializeCookie(SESSION_COOKIE, rawToken, opts)
}

/** 清空会话 cookie（登出）。属性必须与设置时一致，否则浏览器不会覆盖同名 cookie。 */
export function clearedSessionCookie(opts: { secure: boolean }): string {
  return sessionCookie('', { maxAgeSeconds: 0, secure: opts.secure })
}

/** 是否为"会改变服务端状态"的方法（CSRF 保护的作用域） */
export function isStateChanging(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS'
}

export interface CsrfViolation {
  code: string
  message: string
}

/**
 * CSRF 判据（返回 `null` 表示通过）。
 *
 * 三道判据，**证据强度从高到低**：
 * 1. `Sec-Fetch-Site`：现代浏览器必发。值为 `cross-site` 即拒；`same-origin` / `none`
 *    （地址栏直达）放行。**只在头存在时判定** —— 老浏览器与命令行没有这个头。
 * 2. `Origin`：若存在且 host 与本服务不一致 ⇒ 拒。浏览器对跨站 POST **必发** `Origin`，
 *    而表单提交无法伪造它；curl 默认不发 ⇒ 不影响脚本与测试。
 * 3. **自定义头 `X-GW-CSRF`（仅在"请求带了会话 cookie"时要求）**：跨站表单无法设置自定义头，
 *    因此"带 cookie 但没有该头"就是典型的 CSRF 形态。
 *
 * **为什么第 3 条以"带 cookie"为前提**：CSRF 的危害来自**环境凭据**（浏览器自动附带的 cookie）。
 * 用显式头令牌（break-glass）或纯 API 调用的请求天然免疫 —— 攻击者的站点设置不了那个头。
 * 若对所有非 GET 一律要求该头，会把命令行脚本与既有运维流程一并打断，却换不来额外安全。
 */
export function checkCsrf(req: IncomingMessage, hasSessionCookie: boolean): CsrfViolation | null {
  if (!isStateChanging(req.method)) return null

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.length > 0 && site !== 'same-origin' && site !== 'none') {
    return { code: 'csrf_rejected', message: `跨站请求被拒绝（Sec-Fetch-Site: ${site}）` }
  }

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    const host = req.headers.host
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host
    } catch {
      return { code: 'csrf_rejected', message: 'Origin 头格式非法' }
    }
    /*
     * **失败关闭**：拿不到 Host 就无法判断"是否同源"，此时**必须拒绝**。
     * 曾经的写法是 `if (host && originHost !== host)` —— Host 缺失时整个校验被跳过，
     * 即"无法校验"等于"放行"。HTTP/1.1 起 Host 是必需头，但**依赖传输层的规范性来保证
     * 安全属性**是错的：反向代理剥头、HTTP/1.0 客户端、畸形请求都能触发这条路径。
     */
    if (typeof host !== 'string' || host.length === 0) {
      return { code: 'csrf_rejected', message: '缺少 Host 头，无法校验 Origin' }
    }
    if (originHost !== host) {
      return { code: 'csrf_rejected', message: `跨站请求被拒绝（Origin: ${originHost} ≠ ${host}）` }
    }
  }

  if (hasSessionCookie && req.headers[CSRF_HEADER] !== '1') {
    return { code: 'csrf_rejected', message: `缺少 ${CSRF_HEADER}: 1 请求头` }
  }

  return null
}
