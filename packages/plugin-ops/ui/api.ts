/**
 * 「审计与运维」的 HTTP 客户端。
 *
 * ## 为什么插件要自己写一份 fetch，而不是用宿主的 `api.ts`
 *
 * 插件的客户端产物是**独立构建**的（`react` 系是唯一的 external，见
 * `packages/web/fixtures/vite.config.ts`），`import '../api'` 会失败或把宿主的整份
 * API 层打进产物。宿主的 SDK 也刻意没有暴露 `api` —— 那会把宿主的内部模块结构
 * 变成插件契约，宿主每加一个端点都要考虑兼容性。
 *
 * ## CSRF：一个静态头，插件自己就能满足
 *
 * 服务端的三道闸门见 `packages/plugin-auth/src/http.ts` 的 `checkCsrf`。第三道要求
 * "带会话 cookie 的请求必须带 `x-gw-csrf`" —— 跨站表单设置不了自定义头，所以这一个头
 * 就是那道闸门的全部。**没有令牌交换**：值恒为 `'1'`（与宿主 `api.ts` 完全一致）。
 *
 * 漏掉它的症状值得单独写下来：读端点照常工作（`checkCsrf` 只判状态改变方法），
 * 而**所有写动作**（吊销会话、回收、重算）返回 403，界面上表现为"点了没反应"。
 */
import type {
  AccessExplainResponse,
  AuditFilters,
  AuditResponse,
  BlocksResyncResponse,
  BlocksVerifyResponse,
  CachePlanResponse,
  PurgeResponse,
  RevokeSessionsResponse,
  SearchVerifyResponse,
  SessionsResponse,
  SitemapAuditResponse,
} from './plan.js'
import { AUDIT_PAGE_SIZE, auditQuery } from './plan.js'

/** 一个可呈现的错误：`title` 是"发生了什么"，`hint` 是"能做什么" */
export interface OpsErrorView {
  readonly title: string
  readonly hint: string
}

/** 请求失败。带上可呈现的两个字段，让调用方不必再猜 */
export class OpsRequestError extends Error {
  readonly title: string
  readonly hint: string

  constructor(title: string, hint: string) {
    super(title)
    this.name = 'OpsRequestError'
    this.title = title
    this.hint = hint
  }
}

/**
 * 把任意异常转成可呈现的错误。
 *
 * 与宿主 `lib/errorText.ts` 的 `describeError` 同一形态（两个字段），但**刻意不复用**：
 * 那是宿主的模块，插件拿不到。契约只有"两个字段"这一点，两边各自实现即可。
 */
export function describeOpsError(err: unknown): OpsErrorView {
  if (err instanceof OpsRequestError) return { title: err.title, hint: err.hint }
  if (err instanceof Error) return { title: err.message, hint: '' }
  return { title: String(err), hint: '' }
}

/** 端点回执的错误体（`{ ok: false, error, message }`）—— 后端所有失败路径的统一形状 */
interface ErrorBody {
  readonly error?: unknown
  readonly message?: unknown
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      // 与宿主 api.ts 一致：会话走 cookie，凭据只在同源请求上携带
      credentials: 'same-origin',
      headers: {
        'x-gw-csrf': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (err) {
    throw new OpsRequestError('网络请求失败', err instanceof Error ? err.message : String(err))
  }

  /*
   * 先按文本读，再决定怎么解析。
   *
   * 直接用 `res.json()` 有一个真实且难查的失败方式：反向代理或宿主在 502/504 时返回
   * HTML 错误页，`res.json()` 抛出的是一句 `Unexpected token '<'` —— 那句话既不是
   * 状态码也不是后端的话，用户看到的是一句纯粹的乱码。这里对非 JSON 的响应给
   * "HTTP <状态码>"并附上前 120 个字符，排障时至少知道对端返回了什么。
   */
  const text = await res.text()
  let parsed: unknown = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      if (!res.ok) {
        throw new OpsRequestError(`请求失败（HTTP ${res.status}）`, `响应不是 JSON：${text.slice(0, 120)}`)
      }
      throw new OpsRequestError('响应不是合法 JSON', text.slice(0, 120))
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as ErrorBody
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
    const message = typeof body.message === 'string' ? body.message : ''
    throw new OpsRequestError(message === '' ? `请求失败（${code}）` : message, `HTTP ${res.status} · ${code}`)
  }
  return parsed as T
}

/** 审计查询。`view` 只允许两类 —— 见 `plan.ts` 的 `auditQuery` 说明 */
export function fetchAudit(
  view: 'security' | 'acl',
  filters: AuditFilters,
  offset: number,
  limit = AUDIT_PAGE_SIZE,
): Promise<AuditResponse> {
  return request<AuditResponse>('GET', `/api/admin/audit?${auditQuery(view, filters, offset, limit)}`)
}

export function fetchSessions(): Promise<SessionsResponse> {
  return request<SessionsResponse>('GET', '/api/admin/sessions')
}

export function revokeSession(id: string): Promise<{ readonly ok: true; readonly revoked: boolean }> {
  return request('POST', `/api/admin/sessions/${encodeURIComponent(id)}/revoke`)
}

/**
 * 按用户批量吊销。
 *
 * 这个端点（`POST /api/admin/users/:userId/sessions/revoke`）此前**界面上没有任何入口** ——
 * 端点能用、界面进不去，等价于"把某人踢下线"这件事对运维不存在，只能一条一条点。
 */
export function revokeUserSessions(userId: number): Promise<RevokeSessionsResponse> {
  return request<RevokeSessionsResponse>('POST', `/api/admin/users/${String(userId)}/sessions/revoke`)
}

export function fetchAccessExplain(slug: string): Promise<AccessExplainResponse> {
  return request<AccessExplainResponse>('GET', `/api/admin/access-explain?slug=${encodeURIComponent(slug)}`)
}

export function fetchSitemapAudit(): Promise<SitemapAuditResponse> {
  return request<SitemapAuditResponse>('GET', '/api/admin/sitemap-audit')
}

export function fetchCachePlan(since?: string): Promise<CachePlanResponse> {
  const q = since === undefined || since === '' ? '' : `?since=${encodeURIComponent(since)}`
  return request<CachePlanResponse>('GET', `/api/admin/cache-plan${q}`)
}

export function purgeGrants(): Promise<PurgeResponse> {
  return request<PurgeResponse>('POST', '/api/admin/grants/purge')
}

export function purgeInvitations(): Promise<PurgeResponse> {
  return request<PurgeResponse>('POST', '/api/org/invitations/purge')
}

/** 搜索索引核对（`@geewiki/search`）—— 此前界面上没有入口 */
export function verifySearchIndex(): Promise<SearchVerifyResponse> {
  return request<SearchVerifyResponse>('GET', '/api/admin/search/verify')
}

/** 块 ↔ 正文 / tier ↔ 档位 核对（`@geewiki/wiki`）—— 此前界面上没有入口 */
export function verifyBlocks(): Promise<BlocksVerifyResponse> {
  return request<BlocksVerifyResponse>('GET', '/api/admin/blocks/verify')
}

/**
 * tier 重算（修复入口）—— 此前界面上没有入口。
 *
 * `prefix` 是**查询参数**而不是请求体（见 `packages/plugin-wiki/src/index.ts:5382`），
 * 且服务端会把尾部斜杠归一掉。留空 = 全库重算，那在大库上是重活，故界面上必须显式确认。
 */
export function resyncBlocks(prefix: string): Promise<BlocksResyncResponse> {
  const p = prefix.trim().replace(/\/+$/, '')
  const q = p === '' ? '' : `?prefix=${encodeURIComponent(p)}`
  return request<BlocksResyncResponse>('POST', `/api/admin/blocks/resync${q}`)
}