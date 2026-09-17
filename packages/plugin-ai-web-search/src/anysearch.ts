/**
 * AnySearch 提供方：把公开检索 API 翻译成 {@link WebSearchProvider}。
 *
 * ## 契约来源
 *
 * 按 AnySearch 公开 HTTP API 实现（与官方 `@anysearch/anysearch-dsh` 的客户端同款形状）：
 * - `POST {baseUrl}/v1/search`，body `{query, max_results?, tag?, params?, zone?, language?}`；
 * - 应答是**信封**：`{code, message, request_id?, error_code?, data: {results, metadata}}`，
 *   其中 `code !== 0` 表示业务失败（HTTP 可能仍是 200）；
 * - 鉴权是可选的 `Authorization: Bearer <key>`；**不带就是匿名额度**（按来源 IP 计）。
 *
 * ## 这一层刻意对齐上游的四个决定（都不是随手写的）
 *
 * 1. **不重试**。上游自己也不重试（"the client never retries"）。重试在这里是负收益：
 *    超时预算已经 20s，叠一次就是 40s，而用户与模型都还在等；匿名额度下重试还会把
 *    一次失败放大成两三次配额消耗。
 * 2. **`redirect: 'error'`**。跟随重定向会让"密钥被发到另一台主机"变成一次静默的
 *    凭证外泄；检索接口不需要重定向。
 * 3. **上游文本是有界的数据**。HTTP 错误体与 `message` 字段都是**外部可控字符串**，
 *    它们会进模型的工具结果，因此一律 JSON 引用 + 截断（见 {@link MAX_UPSTREAM_ERROR_CHARS}）。
 * 4. **占位密钥直接拒**。把 `ANYSEARCH_API_KEY` 这种"环境变量名被误填进密钥框"的值
 *    当成密钥发出去，得到的是一个与"密钥失效"长得一模一样的 401——把病因埋在 40 行外。
 */
import {
  sanitizeText,
  type WebSearchHit,
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResponse,
} from './types.js'

/** 公开 API 根地址（AnySearch 官方默认值）。 */
export const ANYSEARCH_DEFAULT_BASE_URL = 'https://api.anysearch.com'

/**
 * 发给上游的客户端标识。
 *
 * 与上游 `dsh/<version>` 的惯例一致：出问题时对方能从流量里认出是谁在调，而
 * 我们的版本号是**唯一的**诊断线索（匿名额度被打满时尤其需要）。
 */
export const ANYSEARCH_CLIENT_ID = 'geewiki/0.1.0'

/** 上游错误文本进入模型上下文前的截断长度。 */
export const MAX_UPSTREAM_ERROR_CHARS = 300

/** 搜索参数的取值范围（与上游一致：1..20）。 */
export const MIN_MAX_RESULTS = 1
export const MAX_MAX_RESULTS = 20

/**
 * 密钥框里出现这些值 = 用户把"应该填的东西"当成了值本身。
 *
 * 白名单式地只拒这两个已知形态，而不是"像不像密钥"的黑名单：真正的密钥可以长得
 * 毫无规律，猜错一次就等于把一个**能用**的密钥判成不能用（且报错指向错误的病因）。
 */
const API_KEY_PLACEHOLDERS: ReadonlySet<string> = new Set(['ANYSEARCH_API_KEY', 'as_sk_your_key'])

export type AnySearchErrorKind =
  /** 配置就不对（baseUrl 非法、密钥是占位符）——重试与换关键词都没用 */
  | 'config'
  /** 网络层失败（DNS/TCP/TLS） */
  | 'network'
  /** 超时 */
  | 'timeout'
  /** 上游 HTTP 非 2xx */
  | 'http'
  /** 上游 HTTP 正常但业务码非 0 */
  | 'business'
  /** 应答不是我们能读懂的形状 */
  | 'invalid'

/** 一次检索失败。**只带可安全外传的事实**，不带上游原始对象。 */
export class AnySearchError extends Error {
  readonly kind: AnySearchErrorKind
  readonly httpStatus?: number
  readonly requestId?: string
  readonly errorCode?: string
  readonly authentication: 'anonymous' | 'credential'
  readonly retryAfter?: string

  constructor(
    message: string,
    options: {
      kind: AnySearchErrorKind
      authentication: 'anonymous' | 'credential'
      httpStatus?: number
      requestId?: string
      errorCode?: string
      retryAfter?: string
      cause?: unknown
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AnySearchError'
    this.kind = options.kind
    this.authentication = options.authentication
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus
    if (options.requestId !== undefined) this.requestId = options.requestId
    if (options.errorCode !== undefined) this.errorCode = options.errorCode
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter
  }
}

/** 供测试注入的 fetch 形态（默认取全局 fetch）。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface AnySearchProviderOptions {
  /** API 根地址；留空用 {@link ANYSEARCH_DEFAULT_BASE_URL}。 */
  readonly baseUrl?: string
  /** API 密钥；留空/空白 = 匿名调用。 */
  readonly apiKey?: string
  /** HTTP 超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 注入 fetch（测试用）。 */
  readonly fetchImpl?: FetchLike
}

/**
 * 把根地址与路径拼成一个可用的 URL；**非法即 `undefined`**（不抛）。
 *
 * 只放行 http/https：`file:` 与 `data:` 在这里是纯粹的配置事故，而放行它们意味着
 * 工具可以读到本机文件——一条不该存在的路径不如它不存在。
 */
function endpoint(baseUrl: string, path: string): string | undefined {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

/** 上游错误文本的**有界**引用：JSON 引用 + 截断，杜绝"一行日志被塞进 5000 字"。 */
function boundedDetail(detail: string): string {
  const bounded = detail.length <= MAX_UPSTREAM_ERROR_CHARS ? detail : `${detail.slice(0, MAX_UPSTREAM_ERROR_CHARS - 1)}…`
  return JSON.stringify(bounded)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} 必须是字符串`)
  return value
}

function asCount(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${key} 必须是非负整数`)
  }
  return value
}

/** 绝对 http(s) URL —— 相对地址的检索结果点了没用，不如在这里就判掉。 */
function asAbsoluteHttpUrl(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new TypeError(`${key} 必须是字符串`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`${key} 必须是绝对 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${key} 必须是 http(s) URL`)
  }
  return value
}

/** 解析一条命中（导出以便单测直接打这条最容易出偏差的路径）。 */
export function parseAnySearchHit(value: unknown, index: number, contentBudget: { left: number }): WebSearchHit {
  const record = asRecord(value)
  if (record === undefined) throw new TypeError(`data.results[${index}] 必须是对象`)
  const title = sanitizeText(asRequiredString(record, 'title', index))
  const url = asAbsoluteHttpUrl(record['url'], `data.results[${index}].url`)
  const snippetRaw = asOptionalString(record, 'snippet')
  const contentRaw = asOptionalString(record, 'content')
  const hit: { title: string; url: string; snippet?: string; content?: string } = { title, url }
  if (snippetRaw !== undefined) hit.snippet = sanitizeText(snippetRaw)
  if (contentRaw !== undefined) {
    // 正文保留换行（模型要读段落结构），但**累计**受配额约束：上游一次可能给回
    // 20 万字符的正文，不设总量上限就等于让一次搜索吃掉整个上下文窗口。
    const remaining = Math.max(0, contentBudget.left)
    const text = sanitizeText(contentRaw, { keepNewlines: true })
    const kept = text.slice(0, remaining)
    contentBudget.left -= kept.length
    if (kept.length > 0) hit.content = kept
  }
  return hit
}

function asRequiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key]
  if (typeof value !== 'string') throw new TypeError(`data.results[${index}].${key} 必须是字符串`)
  return value
}

/** 解析信封的 `data`（导出以便单测）。 */
export function parseAnySearchData(data: unknown, maxContentChars: number): {
  results: WebSearchHit[]
  totalResults: number
  searchTimeMs: number
} {
  const record = asRecord(data)
  if (record === undefined) throw new TypeError('data 必须是对象')
  const rawResults = record['results']
  if (!Array.isArray(rawResults)) throw new TypeError('data.results 必须是数组')
  const budget = { left: Math.max(0, maxContentChars) }
  const results = rawResults.map((item, index) => parseAnySearchHit(item, index, budget))
  const metadata = asRecord(record['metadata'])
  if (metadata === undefined) throw new TypeError('data.metadata 必须是对象')
  return {
    results,
    totalResults: asCount(metadata, 'total_results'),
    searchTimeMs: asCount(metadata, 'search_time_ms'),
  }
}

/**
 * 创建 AnySearch 提供方。
 *
 * 密钥是**激活时的那一份快照**，不是每次调用现读：配置变更的真实形态是"重新激活"
 * （管理器先 `unprovide` 再 `apply`，见 `@geewiki/manager` 的热更新路径），因此新密钥
 * 一定会随着一次新的 apply 进来。反过来，在闭包里现读 `config` 只会让"这个对象到底
 * 看着哪一份配置"变得需要推理。
 */
export function createAnySearchProvider(options: AnySearchProviderOptions = {}): WebSearchProvider {
  const baseUrl = options.baseUrl !== undefined && options.baseUrl.trim() !== ''
    ? options.baseUrl.trim()
    : ANYSEARCH_DEFAULT_BASE_URL
  const timeoutMs = options.timeoutMs ?? 20000
  const apiKey = options.apiKey?.trim()
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))

  const searchUrl = (): string | undefined => endpoint(baseUrl, '/v1/search')

  return {
    id: 'anysearch',
    available: () => searchUrl() !== undefined,
    async search(query: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResponse> {
      const url = searchUrl()
      if (url === undefined) {
        throw new AnySearchError(`AnySearch 根地址非法（只接受 http/https）：${JSON.stringify(baseUrl)}`, {
          kind: 'config',
          authentication: 'anonymous',
        })
      }

      const key = apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined
      if (key !== undefined && API_KEY_PLACEHOLDERS.has(key)) {
        throw new AnySearchError(
          'AnySearch 密钥看起来是占位符（像是把环境变量名填进了密钥框）。留空即用匿名额度，或填入真实密钥。',
          { kind: 'config', authentication: 'anonymous' },
        )
      }
      const authenticated = key !== undefined
      const authentication: 'anonymous' | 'credential' = authenticated ? 'credential' : 'anonymous'

      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': ANYSEARCH_CLIENT_ID,
        'x-anysearch-client': ANYSEARCH_CLIENT_ID,
      }
      if (authenticated) headers['authorization'] = `Bearer ${key}`

      const body = JSON.stringify({
        query: query.query,
        ...(query.maxResults === undefined ? {} : { max_results: query.maxResults }),
        ...(query.tag === undefined ? {} : { tag: query.tag }),
        ...(query.params === undefined ? {} : { params: query.params }),
        ...(query.zone === undefined ? {} : { zone: query.zone }),
        ...(query.language === undefined ? {} : { language: query.language }),
      })

      /*
       * 超时用**自己的控制器**发信号，而不是 `AbortSignal.timeout`：需要区分
       * "超时"与"调用方取消"（两者的补救动作完全不同——前者可以换关键词重试，
       * 后者说明用户已经走了）。`AbortSignal.any` 把两个来源合成一个。
       */
      const timeoutController = new AbortController()
      const timer = setTimeout(() => {
        timeoutController.abort(new DOMException('AnySearch HTTP 请求超时', 'TimeoutError'))
      }, timeoutMs)
      const requestSignal = signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([signal, timeoutController.signal])

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          // 见文件头第 2 条：跟随重定向会把密钥发给另一台主机
          redirect: 'error',
          headers,
          body,
          signal: requestSignal,
        })
      } catch (error) {
        if (timeoutController.signal.aborted) {
          throw new AnySearchError(`AnySearch 检索超时（${timeoutMs}ms）`, {
            kind: 'timeout',
            authentication,
            cause: error,
          })
        }
        if (signal?.aborted === true) {
          throw new AnySearchError('AnySearch 检索已取消', { kind: 'network', authentication, cause: error })
        }
        throw new AnySearchError(`AnySearch 检索请求失败：${error instanceof Error ? error.message : String(error)}`, {
          kind: 'network',
          authentication,
          cause: error,
        })
      } finally {
        clearTimeout(timer)
      }

      const retryAfter = response.headers.get('retry-after') ?? undefined
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new AnySearchError(`AnySearch 检索返回的不是 JSON（HTTP ${response.status}）`, {
          kind: 'invalid',
          authentication,
          httpStatus: response.status,
          ...(retryAfter === undefined ? {} : { retryAfter }),
          cause: error,
        })
      }

      const envelope = asRecord(payload)
      const requestId = envelope === undefined ? undefined : asString(envelope['request_id'])
      const errorCode = envelope === undefined ? undefined : asString(envelope['error_code'])
      const upstreamMessage = envelope === undefined ? undefined : asString(envelope['message'])

      if (!response.ok) {
        throw new AnySearchError(
          `AnySearch 检索失败（HTTP ${response.status}，${authentication === 'anonymous' ? '匿名额度' : '账号额度'}）` +
            `${requestId === undefined ? '' : `，request_id ${requestId}`}` +
            `${errorCode === undefined ? '' : `，error_code ${errorCode}`}：${boundedDetail(upstreamMessage ?? 'API error')}`,
          {
            kind: 'http',
            authentication,
            httpStatus: response.status,
            ...(requestId === undefined ? {} : { requestId }),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(retryAfter === undefined ? {} : { retryAfter }),
          },
        )
      }

      if (envelope === undefined) {
        throw new AnySearchError('AnySearch 检索返回的信封不是对象', { kind: 'invalid', authentication, httpStatus: response.status })
      }
      const code = envelope['code']
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
        throw new AnySearchError('AnySearch 检索返回的信封缺少整数 code', {
          kind: 'invalid',
          authentication,
          httpStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
        })
      }
      if (code !== 0) {
        throw new AnySearchError(
          `AnySearch 检索被拒绝（code ${code}，${authentication === 'anonymous' ? '匿名额度' : '账号额度'}）` +
            `${requestId === undefined ? '' : `，request_id ${requestId}`}` +
            `${errorCode === undefined ? '' : `，error_code ${errorCode}`}：${boundedDetail(upstreamMessage ?? 'API error')}`,
          {
            kind: 'business',
            authentication,
            httpStatus: response.status,
            ...(requestId === undefined ? {} : { requestId }),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(retryAfter === undefined ? {} : { retryAfter }),
          },
        )
      }

      let parsed: { results: WebSearchHit[]; totalResults: number; searchTimeMs: number }
      try {
        parsed = parseAnySearchData(envelope['data'], query.maxContentChars ?? 8000)
      } catch (error) {
        throw new AnySearchError(`AnySearch 检索应答形状非法：${error instanceof Error ? error.message : String(error)}`, {
          kind: 'invalid',
          authentication,
          httpStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
          cause: error,
        })
      }

      return {
        results: parsed.results,
        totalResults: parsed.totalResults,
        searchTimeMs: parsed.searchTimeMs,
        ...(requestId === undefined ? {} : { requestId }),
        authenticated,
      }
    },
  }
}
