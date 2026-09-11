/**
 * GeeWiki 前端 API 客户端。
 * 后端约定：成功 { ok: true, ... }；失败 { ok: false, error, message, details }，
 * HTTP 状态码与 ManagerError.code 映射（404 not_found / 409 冲突类 / 400 / 500）。
 */
import { createAiStreamDecoder, type AiStreamEvent } from './lib/aiStreamPlan'
import { authFailureAction, type AuthFailureAction } from './lib/authFailure'
import type { SlotName } from './lib/slots'

export interface ApiFailure {
  ok: false
  error: string
  message?: string
  details?: unknown
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message || code)
  }
}

/**
 * 认证失败的**全局出口**（由 `lib/authStore.ts` 在模块加载时注册）。
 *
 * 为什么用"注册回调"而不是让 api.ts 直接跳转：
 * 1. **避免循环依赖** —— `api → authStore → api` 在 ESM 下能跑但初始化顺序敏感；
 *    这里 api 只提供一个注册点，谁想处理谁注册。
 * 2. api.ts 保持"只做 HTTP"的单一职责，跳转策略（含"401 不弹提示"这类产品判断）
 *    留在 `lib/authFailure.ts` + authStore。
 */
export type AuthFailureHandler = (action: NonNullable<AuthFailureAction>) => void

let authFailureHandler: AuthFailureHandler | null = null

export function setAuthFailureHandler(handler: AuthFailureHandler): void {
  authFailureHandler = handler
}

/**
 * **提交凭据**的端点：它们返回 401 表示"这次提交的凭据不对"，而不是"你的会话失效了"。
 *
 * 必须排除在全局出口之外，否则用户在登录页输错口令会被"跳转到登录页"（页面上刚显示的
 * 错误提示随之消失，表现为"点了一下登录、页面闪了一下什么都没发生"），
 * 改口令时输错当前口令也会被踢到登录页。
 */
const CREDENTIAL_ENDPOINTS = new Set(['/api/auth/login', '/api/auth/password'])

/** 认证类失败时调用统一出口（非认证类失败、以及提交凭据的端点，都不触发）。 */
function notifyAuthFailure(status: number, code: string | undefined, path: string): void {
  if (authFailureHandler === null) return
  if (CREDENTIAL_ENDPOINTS.has(path)) return
  const action = authFailureAction(status, code, window.location.hash)
  if (action !== null) authFailureHandler(action)
}

/**
 * 统一请求头。
 *
 * - `x-gw-csrf: 1`：**每个请求都带**。跨站表单无法设置自定义头，因此这一个头就是
 *   CSRF 的第二道闸门（服务端只在"带会话 cookie"时强制要求它，见 plugin-auth 的 checkCsrf）。
 * - **不加 `Authorization`**：会话走 HttpOnly cookie，令牌对 JS 不可见
 *   （XSS 偷不到会话；代价是必须防 CSRF，故有上面那个头）。
 * - `credentials: 'same-origin'`：带 cookie。**SSE 那条裸 fetch 同样必须带**，
 *   否则流永远是匿名的，且失败是静默的。
 */
function requestHeaders(hasBody: boolean): Record<string, string> {
  return {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    'x-gw-csrf': '1',
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: requestHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* 非 JSON（如 204） */
  }
  if (!res.ok) {
    const f = (data ?? {}) as Partial<ApiFailure>
    notifyAuthFailure(res.status, f.error, path)
    throw new ApiError(res.status, f.error ?? 'http_' + res.status, f.message ?? `请求失败 (${res.status})`, f.details)
  }
  return data as T
}

/* ------------------------- 插件管理器 ------------------------- */

export type PluginState = 'active' | 'inactive' | 'error'
export type PluginLayer = 'base' | 'session' | null

export interface PluginInfo {
  name: string
  version: string
  state: PluginState
  layer: PluginLayer
  hotReloadable: boolean
  provides?: string
  requires: string[]
  conflictGroup?: string
  migrations?: string
  config?: Record<string, unknown>
  error?: string
  /** 来源：内置（组合根登记）/ 外部（plugins/ 目录发现） */
  source?: 'builtin' | 'external'
  /** 是否声明了配置 schema（决定管理台渲染表单还是 JSON 编辑框） */
  configurable?: boolean
  /**
   * 面向人的名称（manifest 的 `geewiki.displayName`）。
   *
   * **可选**：由后端从插件清单读取后透出，旧版本后端不会返回它，
   * 因此前端一律经 `displayNameOf()` 回退（`displayName ?? 去 scope 的短名`），
   * 不得假定它存在。
   */
  displayName?: string
  /** 一句话说明（manifest 的 `geewiki.description`）；同样可能缺失 */
  description?: string
}

/* --------------------- 插件配置 schema（schemastery） --------------------- */

/** schema 载荷中的单个节点（refs 的值为节点；节点上没有 uid 字段） */
export interface ConfigSchemaNode {
  type?: string
  meta?: Record<string, unknown>
  dict?: Record<string, number>
  list?: number[]
  inner?: number
  sKey?: number
  bits?: Record<string, number>
  value?: unknown
}

/** 后端下发的 schema 载荷：refs 是 uid 字符串到节点的映射（非数组） */
export interface ConfigSchemaPayload {
  uid: number
  refs: Record<string, ConfigSchemaNode>
}

export interface ConfigIssue {
  message: string
  path?: (string | number)[]
}

export interface PluginConfigResponse {
  ok: true
  name: string
  /** 配置的**持久化层**（存在哪个清单里、重启后是否生效） */
  layer: PluginLayer
  /** **激活层**（未激活为 null）；与 layer 是不同维度 */
  activeLayer: PluginLayer | null
  config: Record<string, unknown>
  schema: ConfigSchemaPayload | null
}

export interface ConfigUpdateResult {
  ok: true
  config: Record<string, unknown>
  hotUpdated: boolean
  /** 未发生热更新（插件未激活）：配置已落盘，待下次激活/重启生效 */
  requiresRestart: boolean
}

/** 冲突组替换结果（POST /api/plugins/:name/replace） */
export interface ReplaceResult {
  ok: true
  plugin: PluginInfo
  /** 被顶替的插件（无冲突时为 null） */
  replaced: { name: string; config?: Record<string, unknown> } | null
  /** 被卸载后接回新提供者的依赖方插件名 */
  restarted: string[]
}

/** 外部插件发现期被跳过的目录（GET /api/plugins 的 issues） */
export interface DiscoveryIssueInfo {
  code: string
  dir: string
  message: string
}

export interface GraphNodeInfo {
  id: string
  label: string
  layer: PluginLayer
  state: PluginState
  hotReloadable: boolean
  conflictGroup?: string
}

export interface GraphData {
  nodes: GraphNodeInfo[]
  edges: { id: string; source: string; target: string }[]
}

export interface ListEntry {
  name: string
  config?: Record<string, unknown>
}

export interface SessionState {
  base: { enabled: ListEntry[] }
  session: { enabled: ListEntry[] }
  bootErrors: string[]
}

export interface PageSummary {
  slug: string
  title: string
  updated_at: string
  version: number
}

export interface VersionMeta {
  id: number
  saved_at: string
}

export interface PageDetail extends PageSummary {
  content: string
  created_at: string
  versions: VersionMeta[]
  /**
   * ★ P2：当前主体对这条目的能力。**前端据此隐藏按钮只是体验，不是安全** ——
   * 服务端在写路径上另有强制（前端隐藏永远不能当判定用）。之所以要下发：
   * 对每个人都显示"编辑/删除"、点下去才 401/403，等于把权限做成了猜谜。
   */
  capabilities: { canEdit: boolean; canDelete: boolean; canManageVisibility: boolean }
  /** ★ P2：档位字段**只在有管理权时**由服务端下发（普通读者不需要，管理面板才要回填） */
  visibility?: 'private' | 'org' | 'public'
  inherit?: boolean
  published?: boolean
}

/**
 * 站内链接引用。
 *
 * ⚠️ **判"目标在不在"要看 `exists`，不要看 `title === null`**：`title` 只是 `LEFT JOIN`
 * 的副产物。后端按主体算出的事实是 `exists`：
 * - `true`     → 目标存在且你看得到
 * - `false`    → 目标不存在（「红链」，先写引用后建页的正常用法）
 * - `'hidden'` → 目标**存在但你看不到**（匿名主体拿不到这个值 —— 见 `PageLinks` 的说明）
 * - 缺失       → 反向链接没有这个字段（服务端已按可见性过滤过）
 *
 * `'hidden'` 与 `false` 必须分开渲染：把"存在但你看不到"显示成"不存在"，用户会去
 * **创建一个已存在的页面** ⇒ 脏数据 + 错误引导（设计文档 §5.5）。
 */
export interface PageLinkRef {
  slug: string
  title: string | null
  exists?: boolean | 'hidden'
}

/** `GET /api/pages/:slug/backlinks` —— 谁引用了本页。 */
export interface BacklinksResponse {
  ok: true
  slug: string
  backlinks: { slug: string; title: string }[]
}

/** `GET /api/pages/:slug/links` —— 本页引用了谁。 */
export interface OutLinksResponse {
  ok: true
  slug: string
  links: PageLinkRef[]
}

export interface SaveResult {
  ok: true
  slug: string
  title: string
  outcome: 'created' | 'updated' | 'unchanged'
  version: number
}

/* ------------------------- 检索与 AI 问答 ------------------------- */

/**
 * 检索路径：`fts`（查询 ≥3 字符，走 FTS5/BM25）/ `like`（<3 字符的兜底全表扫描）。
 * 中文 2 字词（如「检索」）属于后者——这是 trigram 分词器的硬缺口，不是错误。
 */
export type SearchMode = 'fts' | 'like'

export interface SearchHit {
  slug: string
  title: string
  /**
   * **服务端已 HTML 转义**的片段，且只含 `<mark>`。
   * 渲染时必须按 HTML 注入（见 `lib/snippet.ts` 的 `snippetToHtml`），**不得二次转义**
   * ——那会把 `<mark>` 显示成字面文本；也不得当纯文本插入（会丢高亮）。
   */
  snippet: string
  /** 取负后的 BM25（越大越相关）；**仅同一次查询内可比**，`mode === 'like'` 时恒为 0 */
  score: number
  updated_at: string
}

export interface SearchResponse {
  ok: true
  query: string
  mode: SearchMode
  /** 全量命中数（不受 limit 影响） */
  total: number
  hits: SearchHit[]
}

/**
 * 降级原因：**按它分支文案，绝不按 message 文本分支**（上游 message 可能变化/被脱敏）。
 *
 * ⚠️ 这是 `packages/plugin-ai/src/types.ts` 的**手抄镜像**（web 不能 import 后端包）。
 * 手抄会漂移 ⇒ 两侧成员集合由 `packages/web/test/degradedReason.test.ts` 的
 * 源码级守卫逐个比对，**改一侧必须改另一侧**。
 *
 * 注意与 **HTTP 错误码**的区别：`empty_query` / `too_long` 等是 400 错误码
 * （走 `ApiError.code`），**不是**降级原因，故都不在本枚举里。
 */
export type DegradedReason =
  | 'no_provider'
  | 'missing_credential'
  | 'invalid_credential'
  | 'rate_limit'
  | 'timeout'
  | 'context_window_exceeded'
  | 'network'
  | 'provider_error'
  | 'search_unavailable'

export interface Degraded {
  reason: DegradedReason
  /** 上游错误码（本插件自身原因时为 null，如 search_unavailable） */
  code: string | null
  /** 已脱敏的人类可读说明 */
  message: string
}

export type AskMode = 'retrieval-only' | 'rag' | 'rag-partial'

export interface AskSource {
  /** 引用编号（只对 used:true 连续编号）；null = 该条未进模型上下文（被截断丢弃） */
  n: number | null
  slug: string
  title: string
  /** 同 SearchHit.snippet：已转义、只含 `<mark>`，按 HTML 渲染 */
  snippet: string
  score: number
  updated_at: string
  /** 是否真的进了模型上下文 */
  used: boolean
}

/**
 * `POST /api/ai/ask` / `GET /api/ai/ask` 的响应体。
 * **200 一律正常**——包含「没有模型密钥」与「检索无结果」两种情况（降级信息在 `degraded` 里）。
 * 只有 `400 empty_query` / `400 too_long` 才是输入问题。
 */
export interface AskResponse {
  ok: true
  query: string
  mode: AskMode
  degraded: Degraded | null
  /** 无模型时为抽取式摘要；模型不可用且无来源时为 null */
  answer: string | null
  answerFormat: 'markdown' | 'plain'
  sources: AskSource[]
  retrieval: { mode: SearchMode; total: number; limit: number }
  usage: unknown
  elapsedMs: number
  /** 回答是否被中断/截断 */
  partial: boolean
}

/** `GET /api/ai/capabilities`：仅在 `@geewiki/ai` **已激活**时才有此端点（未启用时 404） */
export interface AiCapabilitiesResponse {
  ok: true
  available: boolean
  degraded: boolean
  providers: { route: string; label: string; vendor: string; model: string; available: boolean }[]
  message: string
}

/* --------------------------- 流式问答 --------------------------- */

export interface AiStreamOptions {
  limit?: number
  extractive?: boolean
  /** 供组件卸载/切换页面/重新提交时取消。**取消不是失败**，调用方不应渲染成错误 */
  signal?: AbortSignal
  onEvent: (ev: AiStreamEvent) => void
}

/**
 * `POST /api/ai/stream`：**逐帧**流式问答（SSE 文本帧）。
 *
 * 为什么必须用 `fetch` + `getReader()` 而**不用 `EventSource`**：原生 `EventSource` 只能发
 * GET、不能带请求体与自定义头，而问答必然要 POST 一个 JSON body。
 *
 * 错误面（调用方需分别处理）：
 * 1. **流开始前**的非 2xx：后端按普通 JSON 返回（`400` / `404` 插件未启用 / `429` 并发超限 /
 *    `500`），这里统一抛 `ApiError`（含 `status` 与 `code`）——`404` 是**回退到一次性端点**的信号。
 * 2. **流中途**失败：由后端发 `error` 帧（本函数不抛错，交给 `onEvent` 的 `error` 事件）。
 * 3. **取消**：`signal` 触发时 `reader.read()` 会抛 `AbortError`，原样向上抛，由调用方识别。
 */
export async function aiAskStream(q: string, opts: AiStreamOptions): Promise<void> {
  const res = await fetch('/api/ai/stream', {
    method: 'POST',
    // 与 `request()` 同一套头与凭据：**漏掉 `credentials` 会让这条流永远是匿名的**，
    // 而且失败是静默的（服务端只会把主体当成 anonymous，不报错）。
    headers: requestHeaders(true),
    credentials: 'same-origin',
    body: JSON.stringify({
      q,
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts.extractive === undefined ? {} : { extractive: opts.extractive }),
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      /* 非 JSON 错误体（例如网关返回 HTML）：退化为状态码 */
    }
    const f = (data ?? {}) as Partial<ApiFailure>
    throw new ApiError(res.status, f.error ?? 'http_' + res.status, f.message ?? `请求失败 (${res.status})`, f.details)
  }

  const body = res.body
  if (body === null) throw new ApiError(res.status, 'no_body', '响应没有可读的流')
  if (typeof TextDecoder === 'undefined') throw new ApiError(res.status, 'no_decoder', '当前环境不支持流式解码')

  const decoder = createAiStreamDecoder()
  const reader = body.getReader()
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      if (step.value) for (const ev of decoder.push(step.value)) opts.onEvent(ev)
    }
    // 收尾：把解码器/解析器里可能残留的最后半个字符与末帧取回
    for (const ev of decoder.flush()) opts.onEvent(ev)
  } finally {
    // 提前退出（取消或异常）时释放底层 reader，避免连接悬挂
    try {
      reader.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
}

/**
 * `GET /api/plugins/slots` 的响应形状。
 *
 * ⚠️ 这里刻意按**后端实际返回**建模，而不是按 `packages/manager/src/slots.ts:57` 的
 * `SlotConflict`：REST handler（`packages/manager/src/index.ts:1572-1576`）返回的是
 * **过滤后的 `SlotAssignment`**，字段为 `{slot, cardinality, owners, effective, suppressed}`，
 * **没有 `winner`**——胜出者是 `effective[0]`。
 *
 * 两处形状不一致是既有事实（`conflictsOf()` 产出 `winner` 但端点没用它）。前端必须按**实际**
 * 形状写：若照 `SlotConflict` 读 `c.winner`，拿到的是 `undefined`，界面会显示成空名字而不是报错
 * ——正是本仓库反复在打的那类静默故障。
 */
export interface SlotAssignmentInfo {
  slot: SlotName
  cardinality: 'single' | 'multi'
  /** 全部声明者，按激活顺序（未激活过的排在最后，按名字典序） */
  owners: string[]
  /** 实际生效者：`multi` 全部生效；`single` 只取激活顺序里的第一个 */
  effective: string[]
  /** 被抑制的声明者（仅 `single` 且被多方声明时非空） */
  suppressed: string[]
}

export interface SlotsResponse {
  ok: true
  slots: SlotAssignmentInfo[]
  /** 只保留"真有多方声明"的单占用插槽（后端已按 `suppressed.length > 0` 过滤） */
  conflicts: SlotAssignmentInfo[]
}

/* ------------------------- 身份与登录（P1） ------------------------- */

/**
 * 当前登录用户（**后端 AuthUser 的前端镜像**）。
 *
 * ⚠️ **本仓库的 core 包不能进浏览器包**（它顶层 `import 'node:fs'`），所以这类
 * 前后端共享的形状只能在前端持一份副本 —— 与 `lib/slugRules.ts`、`lib/pluginUiPlan.ts`
 * 的做法一致。副本与后端不一致的症状是"类型说有的字段运行时是 undefined"，
 * 故改动后端 `AuthUser` 时必须同步这里。
 */
export interface AuthUser {
  id: number
  email: string
  displayName: string
  orgId: number
  /** P1 恒为 null（组织的角色存储属 P2）；null 表示"无组织角色"= Guest 语义 */
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  emailVerified: boolean
  createdAt: string
  lastSeenAt: string | null
}

/** 服务端下发的能力。**只用于前端隐藏入口**，服务端判定独立进行（前端隐藏不是安全措施）。 */
export interface AuthCapabilities {
  editContent: boolean
  administer: boolean
  manageVisibility: boolean
}

/**
 * SSO 通道的能力下发（P1.5）。
 *
 * **三种形态对前端是同一个判据**：`available === false` ⇒ 不渲染 SSO 按钮。
 * 区分 `reason` 只为排障与文案（`disabled` = 没装/没启用 OIDC 插件；
 * 其它值 = 装了但不可用，如 `unreachable` / `issuer_mismatch`）。
 */
export type AuthOidcCapability =
  | { available: true; providerId: string; label: string; startPath: string }
  | { available: false; reason: string }

/** 已绑定的外部身份（**不含**任何凭据） */
export interface AuthIdentity {
  id: number
  issuer: string
  subject: string
  emailAtLink: string | null
  linkedAt: string
  lastLoginAt: string | null
}

export interface AuthStateResponse {
  ok: true
  /** true ⇒ 库里还没有任何可登录账号，应去 #/setup */
  setupRequired: boolean
  authenticated: boolean
  user: AuthUser | null
  capabilities: AuthCapabilities
  oidc: AuthOidcCapability
}

export interface AuthMeResponse {
  ok: true
  user: AuthUser
  session: { id: string | null }
  capabilities: AuthCapabilities
}

export const api = {
  /* 身份与登录（P1） */
  /**
   * 登录态与初始化状态。**公共端点**：未登录时也返回 200（`user: null`），
   * 因此它是 `authStore` 的唯一数据源 —— 用一个必然成功（而非必然 401）的端点
   * 表达"当前是谁"，冷启动时就不会因为 401 而无谓地跳一次登录页。
   */
  authState: () => request<AuthStateResponse>('GET', '/api/auth/state'),
  /** 当前身份。`access:'user'`：未登录时 **401**（验收标准要求的行为）。 */
  authMe: () => request<AuthMeResponse>('GET', '/api/auth/me'),
  authLogin: (email: string, password: string) =>
    request<{ ok: true; user: AuthUser | null }>('POST', '/api/auth/login', { email, password }),
  authLogout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  authSetup: (email: string, password: string, displayName?: string) =>
    request<{ ok: true; user: AuthUser | null }>('POST', '/api/auth/setup', {
      email,
      password,
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    }),
  authChangePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; revokedOtherSessions: boolean }>('POST', '/api/auth/password', {
      currentPassword,
      newPassword,
    }),

  /* 外部身份绑定（P1.5） */
  /**
   * 我的外部身份列表。`hasPassword` 用于前端判断"能不能解绑"
   * （没有口令且只剩一个身份时服务端会 409 `last_credential`，前端先hide入口更友好）。
   */
  authIdentities: () =>
    request<{ ok: true; hasPassword: boolean; identities: AuthIdentity[] }>(
      'GET',
      '/api/auth/identities',
    ),
  /**
   * 确认绑定待处理的外部身份。
   *
   * **不带任何参数**：票据只存在于 `HttpOnly` cookie 里（服务端在 SSO 回跳时下发），
   * JS 读不到也传不了 —— 这是刻意的，票据放进 URL 或请求体会经 Referer、历史、
   * 日志与错误上报泄漏。调用方只需确保浏览器带着 cookie。
   */
  authLinkIdentity: () =>
    request<{ ok: true; alreadyLinked: boolean }>('POST', '/api/auth/identities/link'),
  authUnlinkIdentity: (identityId: number) =>
    request<{ ok: true }>('POST', '/api/auth/identities/unlink', { identityId }),

  /* 插件管理 */
  plugins: () =>
    request<{ ok: true; plugins: PluginInfo[]; issues?: DiscoveryIssueInfo[] }>('GET', '/api/plugins'),
  /**
   * 插槽裁决与冲突诊断。**与入口表分开的只读端点**（后端注释：入口表给前端驱动加载、走 revision +
   * 304；冲突是运维/排障问题，必须每次现算）。
   */
  slots: () => request<SlotsResponse>('GET', '/api/plugins/slots'),
  graph: () => request<{ ok: true; graph: GraphData }>('GET', '/api/plugins/graph'),
  session: () => request<{ ok: true } & SessionState>('GET', '/api/session'),
  enable: (name: string, config?: Record<string, unknown>) =>
    request<{ ok: true; plugin: PluginInfo }>('POST', `/api/plugins/${encodeURIComponent(name)}/enable`, { config: config ?? {} }),
  /** 冲突组替换：顶替同 conflictGroup 的已激活插件（旧插件卸载、其依赖方接回新提供者） */
  replace: (name: string, config?: Record<string, unknown>) =>
    request<ReplaceResult>('POST', `/api/plugins/${encodeURIComponent(name)}/replace`, { config: config ?? {} }),
  disable: (name: string) =>
    request<{ ok: true }>('POST', `/api/plugins/${encodeURIComponent(name)}/disable`),
  pluginConfig: (name: string) =>
    request<PluginConfigResponse>('GET', `/api/plugins/${encodeURIComponent(name)}/config`),
  updatePluginConfig: (name: string, config: Record<string, unknown>) =>
    request<ConfigUpdateResult>('PUT', `/api/plugins/${encodeURIComponent(name)}/config`, { config }),
  persist: () => request<{ ok: true; promoted: string[] }>('POST', '/api/session/persist'),

  /* Wiki 页面 */
  pages: () => request<{ ok: true; pages: PageSummary[] }>('GET', '/api/pages'),
  page: (slug: string) => request<PageDetail & { ok: true }>('GET', `/api/pages/${encodeURIComponent(slug)}`),
  savePage: (slug: string, body: { title: string; content: string }) =>
    request<SaveResult>('PUT', `/api/pages/${encodeURIComponent(slug)}`, body),
  deletePage: (slug: string) => request<{ ok: true }>('DELETE', `/api/pages/${encodeURIComponent(slug)}`),
  version: (slug: string, id: number) =>
    request<{ ok: true; id: number; content: string; saved_at: string }>(
      'GET',
      `/api/pages/${encodeURIComponent(slug)}/versions/${id}`,
    ),
  /*
    反向链接与出链：**按 slug 的两个小端点**。

    ⚠️ 刻意**不**为了它们去拉 `GET /api/pages` 全量列表——详情页此前为算「上一篇/下一篇」重复拉过
    整张列表，是 O(N)/页 的规模瓶颈（已由 pagesStore 修掉）。这里必须保持按 slug 取数。
    两个端点都由 wiki 插件提供；插件未启用时会 404，调用方须优雅降级。
  */
  backlinks: (slug: string) =>
    request<BacklinksResponse>('GET', `/api/pages/${encodeURIComponent(slug)}/backlinks`),
  links: (slug: string) =>
    request<OutLinksResponse>('GET', `/api/pages/${encodeURIComponent(slug)}/links`),

  /* 检索与 AI 问答（后端插件未启用时这两个端点会 404，调用方须优雅降级） */
  search: (q: string, limit?: number) =>
    request<SearchResponse>(
      'GET',
      `/api/search?q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${encodeURIComponent(String(limit))}`}`,
    ),
  aiAsk: (q: string, opts?: { limit?: number; extractive?: boolean }) =>
    request<AskResponse>('POST', '/api/ai/ask', {
      q,
      ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts?.extractive === undefined ? {} : { extractive: opts.extractive }),
    }),
  aiCapabilities: () => request<AiCapabilitiesResponse>('GET', '/api/ai/capabilities'),
  /** 流式问答（见 `aiAskStream` 的文档：取消与三类错误面） */
  aiAskStream: (q: string, opts: AiStreamOptions) => aiAskStream(q, opts),

  /* 服务健康：「系统状态」面板用产品化方式呈现，不再把裸 JSON 端点做成头部链接 */
  health: () => request<HealthResponse>('GET', '/api/health'),

  /* ---------------- 审计与运维（P4） ---------------- */
  /**
   * 审计查询。`view` 把**两类记录分开**：`security` 是安全事件（要告警），
   * `acl` 是权限变更（要留存），`all` 是两者的并集。
   *
   * ⚠️ 调用方必须**分开呈现**这两类 —— 混在一张表里，"有人在探测权限边界"会被
   * "某人改了可见性"稀释掉，而两者的处置完全不同。服务端的分法（显式白名单
   * SECURITY_ACTIONS / ACL_ACTIONS）就是这个判据，前端不要自行改判。
   */
  auditLog: (opts?: {
    view?: 'all' | 'acl' | 'security'
    action?: string
    targetKind?: string
    targetId?: string
    since?: string
    until?: string
    limit?: number
    offset?: number
  }) => {
    const q = new URLSearchParams()
    if (opts?.view !== undefined) q.set('view', opts.view)
    for (const k of ['action', 'targetKind', 'targetId', 'since', 'until'] as const) {
      const v = opts?.[k]
      if (v !== undefined && v !== '') q.set(k, v)
    }
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit))
    if (opts?.offset !== undefined) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return request<AuditResponse>('GET', `/api/admin/audit${qs === '' ? '' : `?${qs}`}`)
  },
  /**
   * 全部会话（含已吊销与已过期）。
   * ⚠️ `ipHash` 是**哈希不是原文** —— 界面不得把它显示成 IP。
   */
  sessions: () => request<SessionsResponse>('GET', '/api/admin/sessions'),
  /** 定点吊销一条会话：**服务端**写 `revoked_at`，原 cookie 立即失效。 */
  revokeSession: (id: string) =>
    request<{ ok: true; revoked: boolean }>(
      'POST',
      `/api/admin/sessions/${encodeURIComponent(id)}/revoke`,
    ),
  /**
   * 回收已过期的条目授权。
   * ⚠️ **不是"让过期授权失效"的手段** —— 失效在**判定时**就已经发生
   * （判定层比较 `expires_at`）。本条只做空间回收，界面文案也应按此措辞。
   */
  purgeGrants: () =>
    request<{ ok: true; expired: number; remaining: number; at: string }>(
      'POST',
      '/api/admin/grants/purge',
    ),
  /** 回收已过期的邀请。只回收"**未接受** 且 已过期"的：已接受的是入伙记录，要留。 */
  purgeInvitations: () =>
    request<{ ok: true; expired: number; remaining: number; at: string }>(
      'POST',
      '/api/org/invitations/purge',
    ),
  /** 反向展开「谁能看这条」：三条来源，并标注哪条**真的在起作用**。 */
  accessExplain: (slug: string) =>
    request<AccessExplainResponse>(
      'GET',
      `/api/admin/access-explain?slug=${encodeURIComponent(slug)}`,
    ),
  /**
   * sitemap 与"匿名可读"的交叉核对。
   * ⚠️ `sameSource: true` 意味着 sitemap 与匿名可见集合**同源**，两者的集合差恒空、
   * 无信息量；有信息量的是 `unreadable`（被广告却读不到 —— 泄漏方向）与
   * `omitted`（读得到却没被广告）。界面不要把它渲染成"发现 N 处泄漏"。
   */
  sitemapAudit: () => request<SitemapAuditResponse>('GET', '/api/admin/sitemap-audit'),
  /** 权限收紧后的清缓存指引（给依据与目标；本进程看不见 CDN，不会自己去清）。 */
  cachePlan: (since?: string) =>
    request<CachePlanResponse>(
      'GET',
      `/api/admin/cache-plan${since === undefined || since === '' ? '' : `?since=${encodeURIComponent(since)}`}`,
    ),
}

export interface AuditEntry {
  id: number
  at: string
  actorId: number | null
  actorIpHash: string | null
  action: string
  targetKind: string
  targetId: string
  before?: unknown
  after?: unknown
  requestId?: string | null
}

export interface AuditResponse {
  ok: true
  view: 'all' | 'acl' | 'security'
  total: number
  limit: number
  offset: number
  entries: AuditEntry[]
}

export interface SessionEntry {
  id: string
  userId: number | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
  idleExpiresAt: string | null
  revokedAt: string | null
  userAgent: string | null
  /** **哈希**，不是 IP 原文 */
  ipHash: string | null
  status: string
}

export interface SessionsResponse {
  ok: true
  total: number
  limit: number
  entries: SessionEntry[]
}

export interface AccessExplainResponse {
  ok: true
  slug: string
  self: { visibility: string; inherit: boolean; publishedAt: string | null }
  positionalRank: number
  reach: { anonymous: 'full' | 'none'; anonymousReason: string; orgMember: 'full' | 'none' }
  sources: {
    ancestors: {
      slug: string
      visibility?: string
      inherit?: boolean
      effect: string
      reason?: string
    }[]
    grants: {
      pages: Record<string, unknown>[]
      blocks: Record<string, unknown>[]
      blockGrantsAvailable: boolean
      effective: boolean
    }
    orgRole: { effective: boolean; relevant: boolean; rule: string }
    adminOverride: { effective: boolean; relevant: boolean; rule: string }
  }
}

export interface SitemapAuditResponse {
  ok: true
  /** 恒为 true：广告集合与匿名可见集合同源 ⇒ 它们的集合差没有信息量 */
  sameSource: true
  advertisedCount: number
  unreadable: { slug: string; reason: string }[]
  omitted: string[]
  consistent: boolean
}

export interface CachePlanResponse {
  ok: true
  since: string
  events: { action: string; count: number }[]
  eventCount: number
  purgeRecommended: boolean
  sharedCacheable: { path: string; cacheControl: string; vary?: string; note?: string }[]
  notSharedCacheable: { path: string; cacheControl: string }[]
  targets: string[]
  note: string
}

/**
 * `GET /api/health` 的响应形状（`packages/server/src/index.ts` 的 healthHandler）。
 * `db.tables` / `db.migrations` 仅在数据库就绪时存在。
 */
export interface HealthResponse {
  ok: true
  uptime: number
  timestamp: string
  db: {
    present: boolean
    tables?: string[]
    migrations?: string[]
  }
}
