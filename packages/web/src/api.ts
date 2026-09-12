/**
 * GeeWiki 前端 API 客户端。
 * 后端约定：成功 { ok: true, ... }；失败 { ok: false, error, message, details }，
 * HTTP 状态码与 ManagerError.code 映射（404 not_found / 409 冲突类 / 400 / 500）。
 */
import { createAiStreamDecoder, type AiStreamEvent } from './lib/aiStreamPlan'
import { ATTACHMENT_URL_PREFIX } from './lib/attachmentPlan'
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

/* ------------------------- 附件（M4，裸 body PUT） ------------------------- */

/**
 * `PUT /api/attachments/:slug` 的成功响应。
 *
 * `url` 是**相对路径**（`/api/attachments/<id>`），写进正文的就是它：同源请求自动带
 * HttpOnly 会话 cookie，因此前端**不拼绝对地址、不携带任何 token**（绝对地址会在换域名/
 * 反代后指向错误主机；token 进正文等于把凭据写进人人都能读的内容里）。
 */
export interface AttachmentUploadResult {
  ok: true
  id: number
  url: string
  mime: string
  size: number
  sha256: string
  /** `true` = 同页已有同内容同类型的附件，服务端复用了旧行（本次没有新写盘） */
  dedup: boolean
}

/**
 * 附件列表的一行（`GET /api/pages/:slug/attachments`，需 `canEdit`）。
 *
 * ⚠️ 与上传响应不同，列表行的**字段名以后端实现为准**：`name` / `createdAt` 目前按
 * 常规命名声明，且都标成可空 —— 界面在它们缺席时退化为显示 id 与 MIME，而不是崩掉。
 */
export interface AttachmentSummary {
  id: number
  url: string
  name?: string
  mime?: string
  size?: number
  createdAt?: string
  sha256?: string
}

export interface AttachmentListResult {
  ok: true
  slug: string
  attachments: AttachmentSummary[]
}

/** `DELETE /api/attachments/:id`（`canEdit` 或上传者本人）。`removed` 由后端决定是否返回。 */
export interface AttachmentDeleteResult {
  ok: true
  removed?: number
}

/**
 * 裸 body 上传的实现体（**只有上传走这条路**）。
 *
 * 为什么不复用 `request<T>`：它固定 `JSON.stringify(body)` 并强制
 * `content-type: application/json`，而上传要把 `File` 原样当 body —— 塞进
 * `JSON.stringify` 只会得到 `{}`。因此 `request<T>` **一行未改**（既有签名与行为不变），
 * 这里另开一条路径，但把错误处理的三件事照抄，保证两条路径对调用方完全一致：
 * ① 非 2xx 解析 `{ok:false,error,message,details}` → `ApiError`；
 * ② 401/403 走同一个全局出口 `notifyAuthFailure`（否则"会话过期"在上传上表现为静默失败）；
 * ③ `credentials: 'same-origin'`。
 *
 * ⚠️ **`x-gw-csrf: 1` 绝不能漏**：服务端在带会话 cookie 时强制校验这个头（见
 * `requestHeaders` 的说明），裸 PUT 同样会被拦 —— 少了它，用户看到的是没有任何解释的失败。
 *
 * 进度：`fetch` 对**请求体上传**没有标准进度事件（上传流 + `duplex: 'half'` 仅 Chromium
 * 实验性支持），所以这里只报"开始/结束"两态，**不做百分比**（做不到的进度条比没有更糟）。
 */
async function uploadRaw<T>(
  path: string,
  file: File,
  onProgressNote?: (state: 'uploading' | 'done') => void,
): Promise<T> {
  onProgressNote?.('uploading')
  try {
    const res = await fetch(path, {
      method: 'PUT',
      headers: {
        // 后端按扩展名判定（不受支持 ⇒ **415 `unsupported_media_type`**），故这里必须**如实**给出文件的类型
        'content-type': file.type || 'application/octet-stream',
        'x-gw-csrf': '1',
      },
      body: file,
      credentials: 'same-origin',
    })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      /* 非 JSON（如反向代理返回的 HTML 错误页） */
    }
    if (!res.ok) {
      const f = (data ?? {}) as Partial<ApiFailure>
      notifyAuthFailure(res.status, f.error, path)
      throw new ApiError(res.status, f.error ?? 'http_' + res.status, f.message ?? `请求失败 (${res.status})`, f.details)
    }
    return data as T
  } finally {
    /*
      `done` 的语义是**"本次尝试结束了"**（成功与否看 Promise 是 resolve 还是 reject），
      而不是"上传成功了"。写在 `finally` 里是刻意的：失败时若不发这一条，用
      `onProgressNote` 显示"上传中…"的父组件会**永远停在"上传中"**。
      网络层失败（fetch 抛 TypeError）不额外包装，原样抛出 —— `errorText.isUnreachable`
      按 `instanceof TypeError` 判"连不上"，包一层自定义错误会把"断网"误报成"服务出错"。
    */
    onProgressNote?.('done')
  }
}

/**
 * 上传一个文件到某页面（`PUT /api/attachments/:slug?name=<urlencoded>`）。
 *
 * 需登录；错误码与界面处置：401 未登录 / 404 页面不可编辑或不存在 /
 * **400 `length_mismatch`**（实收字节数与 `Content-Length` 不符 ⇒ 上传被截断，服务端不落盘）/
 * 409 同页同内容但类型不一致 / 413 `payload_too_large` 与 `page_quota_exceeded` /
 * **415 `unsupported_media_type`**（扩展名不在白名单）/ 503 `storage_unavailable`。
 * 这些**一律经 `ApiError` 抛出**，由调用方（编辑器）转成正文里的一行失败说明 + 界面提示，
 * 不在这里吞掉。
 *
 * ⚠️ 本文件**不维护"错误码 → 中文文案"的映射表**：界面上展示的是服务端返回的 `message`
 * （`errorText.ts` 也没有为这些码建表）。故后端改错误码/文案时，前端只需跟着改**注释口径**
 * ——这正是 X2 那次"注释写 415、后端回 400"能被长期忽略的原因，别再让注释成为第三个真源。
 */
export function uploadAttachment(
  slug: string,
  file: File,
  onProgressNote?: (state: 'uploading' | 'done') => void,
): Promise<AttachmentUploadResult> {
  const path = `${ATTACHMENT_URL_PREFIX}${encodeURIComponent(slug)}?name=${encodeURIComponent(file.name)}`
  return uploadRaw<AttachmentUploadResult>(path, file, onProgressNote)
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

/**
 * 版本元数据（详情端点内嵌的 `versions[]`：最近 N 条，按 id 降序）。
 *
 * ★ 三个字段的语义（后端 0019 起全量下发）：
 *   · `title`  —— **该快照当时的标题**（`null` = 0019 之前的历史行）
 *   · `author` —— **做出这次改动的人**（`null` = 未记录；**不是**"匿名"）
 *
 * ⚠️ **作者 ≠ 快照内容的作者**：快照存的是**改动前**的状态（`savePage` 的既有约定
 *    "先快照旧的，再改"），而 `author` 与 `saved_at` 记的是**同一次保存动作**。
 *    所以第 i 条快照的作者 = **把它覆盖掉的那个人**。界面据此把
 *    「什么时候 + 谁 + 这次改了哪几行」对齐成一条改动。
 *
 * `author: null` 的三种来源（显示「未记录」，**不编造**）：0019 之前的历史行、
 * 经 `wiki-service.save()` 代调用且无主体的写入、以及账号已被删除（0019 刻意不加外键
 * —— 历史资产必须留存，见迁移注释，故 id 可能指向查不到的账号）。
 */
export interface VersionMeta {
  id: number
  saved_at: string
  /** 保存前的旧标题（`null` 时不显示标题差异，**不猜**） */
  title: string | null
  /** 该版本的作者；`null` ⇒ 界面显示「未记录」 */
  author: { id: number; displayName: string | null } | null
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

/* --------------------------- AI 辅助写作 --------------------------- */

/** 四个动作（与后端 `ASSIST_ACTIONS` 一一对应；新增动作必须同时改两侧与文案映射） */
export type AiAssistAction = 'continue' | 'rewrite' | 'polish' | 'summarize'

export interface AiAssistRequest {
  action: AiAssistAction
  /** 选区文本（改写/润色必填；摘要可省） */
  selection?: string
  /** 光标前的文本（续写必填；摘要可省） */
  before?: string
  title?: string
  /** 带 slug 时服务端会额外收紧到"该页可编辑"；不传则只要求全局编辑能力 */
  slug?: string
  maxTokens?: number
}

/**
 * `POST /api/ai/assist` 的响应体。
 *
 * **不变式**：`mode === 'unavailable'` ⇒ `text === null` 且 `degraded` 非空。
 * 前端不得为"不可用"编造任何替代文本（例如拿摘要冒充续写）。
 */
export interface AiAssistResponse {
  ok: boolean
  mode: 'generated' | 'unavailable'
  action: AiAssistAction
  text: string | null
  degraded: Degraded | null
  elapsedMs: number
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

/* ---------------- 组织与邀请管理（P5-B M4/M5） ---------------- */

/**
 * 组织角色。
 *
 * ⚠️ 这是后端 `packages/plugin-org/src/index.ts:58` 的
 * `OrgRole = 'owner' | 'admin' | 'member' | 'viewer'` 的**手抄镜像**
 * （web 不能 import 后端包，与 `PageVisibility` / `DegradedReason` 同款做法）。
 * 改一侧必须改另一侧。
 *
 * 两个容易搞错的点：
 * 1. **`null` 不是角色**：它是 "Guest 通道"（登录了但没有组织角色），
 *    与 `viewer`（有角色、只是最窄）**不是同一件事**，不能互相回退；
 * 2. 除 `GET /api/org` 之外，组织侧端点全部要求 `admin+`（owner / admin），
 *    涉及 owner 的变更还要 owner（服务端 403）。
 */
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

/** `GET /api/org` 的 `org` 字段：组织档案。 */
export interface OrgInfo {
  id: number
  slug: string
  name: string
  /** 档位（服务端未在此端点约束取值，界面原样展示、不猜） */
  visibility: string
  createdAt: string
}

/**
 * `GET /api/org` 的 `me` 字段：**我在组织里的身份**。
 *
 * 这个端点标的是 `access: 'user'`（登录即可读，**不需要管理员**），
 * 所以它是"我是谁、我在哪个组织、我属于哪些组"的唯一非管理员来源。
 */
export interface OrgSelf {
  /** 后端为 `p?.userId ?? null`；该端点要求登录，正常路径下非空 */
  userId: number | null
  /** null = 无组织角色（Guest 语义）——**不等于 viewer** */
  role: OrgRole | null
  /** 登录了但没有任何组织角色 */
  isGuest: boolean
  /** 我所在的用户组 id（判定页面/块授权时按它展开） */
  groupIds: number[]
}

export interface OrgResponse {
  ok: true
  org: OrgInfo
  me: OrgSelf
  /** 组织成员数（服务端 `COUNT(*)` 已收敛成 Number） */
  memberCount: number
}

/** `GET /api/org/members` 的一行（`access: 'admin'`）。 */
export interface OrgMember {
  userId: number
  email: string
  displayName: string
  role: OrgRole
  joinedAt: string
}

/** `GET /api/org/groups` 的一行。**没有改名端点**，组只有建/删与成员增删。 */
export interface OrgGroup {
  id: number
  name: string
  createdAt: string
  /**
   * 组内成员的**用户 id**（服务端只回 id 列表，不含邮箱/昵称）。
   * 界面要显示人名时去 `orgMembers()` 的结果里查，**不要**再按组逐个拉取。
   */
  memberIds: number[]
}

/**
 * `GET /api/org/invitations` 的一行。
 *
 * ⚠️ **没有 `token` 字段，也不可能有** —— 库里只存 `sha256`，原始令牌
 * 只在 `POST /api/org/invitations` 的**那一次**响应里出现（见 `InvitationCreated`）。
 */
export interface OrgInvitationView {
  /** **字符串**（后端 `randomBytes(16).toString('hex')`），不是数字 —— 别当 number 处理 */
  id: string
  email: string
  /** null = **Guest 通道**（不给组织角色），与 `viewer` 不同 */
  orgRole: OrgRole | null
  /** 入伙时一并加入的用户组（null = 不入组） */
  groupId: number | null
  expiresAt: string
  /** 非 null ⇒ 已被接受（这是一条**入伙记录**，删除它不会移除已入伙的成员） */
  acceptedAt: string | null
  createdAt: string
}

/**
 * `POST /api/org/invitations` 的响应（201）。
 *
 * ★ `token` **只在这一次响应里出现**：库里只有 sha256，之后任何端点都取不回来。
 * 因此界面必须"只在刚创建成功的分支里渲染它，关闭即清空"，且
 * **不得**写入 URL / 本地存储 / 控制台 —— 那等于把一个一次性凭据变成长期凭据。
 */
export interface InvitationCreated {
  ok: true
  invitation: OrgInvitationView
  token: string
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
  /**
   * AI 辅助写作（编辑器内的续写/改写/润色/摘要）。
   *
   * ⚠️ **降级不是错误**：模型不可用时服务端回 **502** 且 `body.mode === 'unavailable'`，
   * 此时 `request()` 会抛 `ApiError`（`status=502`）——调用方**必须**按"不可用"呈现，
   * 而不是当成网络故障报错。`text` 在没有模型时恒为 `null`，**不存在**任何兜底文本。
   */
  aiAssist: (body: AiAssistRequest) => request<AiAssistResponse>('POST', '/api/ai/assist', body),
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

  /* ---------------- 可见性与授权（权限治理界面 M1-M3） ---------------- */
  /**
   * 改档位 / 发布 / 断继承。**部分更新**：只传**用户实际改动过**的字段。
   *
   * ⚠️ 不要"顺手带上"其它字段：服务端对未传字段保持原值（`body['inherit'] === undefined`
   * 时用 `before.inherit`），而 `inherit: false` 表示"不再继承祖先档位"——
   * 一次多余的传参就会把继承态悄悄改掉，且用户无从察觉。
   *
   * 响应里的 `index_tiers_resync_failed: true` 是**内容泄漏级**信号（读路径已收紧、
   * 检索仍按旧档位），界面须按 `lib/accessPlan.ts` 的 `resyncNotice()` 渲染，不得显示"已同步成功"。
   */
  setVisibility: (
    slug: string,
    patch: { visibility?: PageVisibility; inherit?: boolean; published?: boolean },
  ) =>
    request<VisibilityResult>('PUT', `/api/pages/${encodeURIComponent(slug)}/visibility`, patch),
  /** 例外授予列表（**snake_case** 字段，见 `PageGrantRow`）。需要该条目的可见性管理权，否则 403/404。 */
  pageGrants: (slug: string) =>
    request<GrantsResponse>('GET', `/api/pages/${encodeURIComponent(slug)}/grants`),
  /**
   * 新增/更新一条例外授予（同一 `(页面, 主体)` 是幂等 upsert）。
   *
   * `subjectKind` **只有** user | group —— 角色不是授权对象（服务端 D13 会 400
   * `invalid_subject_kind`）。`subjectId` 是**自由文本**（用户填用户 id、组填组 id）：
   * 界面刻意不做成员选择器，因为成员列表端点需要 org admin（普通成员会 403）。
   */
  addPageGrant: (
    slug: string,
    body: { subjectKind: SubjectKind; subjectId: string; role: GrantRole; expiresAt?: string | null },
  ) =>
    request<GrantMutationResult & { subjectKind: SubjectKind; subjectId: string; expiresAt: string | null }>(
      'POST',
      `/api/pages/${encodeURIComponent(slug)}/grants`,
      body,
    ),
  removePageGrant: (slug: string, id: number) =>
    request<GrantRemovalResult>('DELETE', `/api/pages/${encodeURIComponent(slug)}/grants/${id}`),
  /**
   * 块级治理视图。**刻意不含正文**（后端不返回 `text`）——受限块的正文按定义不该出现在
   * 治理列表里，要读正文请走详情页（那里有完整投影）。
   */
  blocks: (slug: string) =>
    request<BlocksResponse>('GET', `/api/pages/${encodeURIComponent(slug)}/blocks`),
  /**
   * 块级例外授予。响应额外回 `block_visibility`（该块**自身声明**的档位）：
   * 规则 B1 是"块只能比页面更窄"，所以当块比页面宽时授权**不会**突破页面上限，
   * 界面据此提示"实际可见性由页面决定"，而不是让用户以为授权没生效。
   */
  addBlockGrant: (
    slug: string,
    blockId: number,
    body: { subjectKind: SubjectKind; subjectId: string; role: GrantRole; expiresAt?: string | null },
  ) =>
    request<BlockGrantResult & { subjectKind: SubjectKind; subjectId: string; expiresAt: string | null }>(
      'POST',
      `/api/pages/${encodeURIComponent(slug)}/blocks/${blockId}/grants`,
      body,
    ),
  removeBlockGrant: (slug: string, blockId: number, grantId: number) =>
    request<GrantRemovalResult>(
      'DELETE',
      `/api/pages/${encodeURIComponent(slug)}/blocks/${blockId}/grants/${grantId}`,
    ),
  /**
   * **待审**访问申请（`status = 'pending'`，服务端最多 200 条、无总数）。
   * 界面文案必须照此写（"待审申请"），**不得**写成"共 N 条申请"。
   */
  accessRequests: (slug: string) =>
    request<AccessRequestsResponse>('GET', `/api/pages/${encodeURIComponent(slug)}/access-requests`),
  /**
   * 提交一次访问申请。**未登录会 401**；已有权限 409 `already_has_access`；
   * 已有待审申请 409 `already_requested`；页面不存在 404 `not_found`。
   * 返回的 `id` 是申请人**撤回**自己的申请所需的句柄（服务端按 id 定位）。
   */
  requestAccess: (slug: string, body: { message?: string; role?: GrantRole }) =>
    request<AccessRequestCreated>('POST', `/api/pages/${encodeURIComponent(slug)}/access-requests`, body),
  /** 批准：默认 `viewer`；`expiresAt` 省略即不过期。非 pending ⇒ 409 `request_not_pending`。 */
  approveAccessRequest: (
    slug: string,
    id: number,
    body?: { role?: GrantRole; expiresAt?: string | null },
  ) =>
    request<{ ok: true; slug: string; approved: number; userId: number; role: GrantRole; acl_revision: number }>(
      'POST',
      `/api/pages/${encodeURIComponent(slug)}/access-requests/${id}/approve`,
      body ?? {},
    ),
  /** 拒绝：不动 `acl_revision`（没有授权的增减）。非 pending ⇒ 409 `request_not_pending`。 */
  denyAccessRequest: (slug: string, id: number) =>
    request<{ ok: true; slug: string; denied: number }>(
      'POST',
      `/api/pages/${encodeURIComponent(slug)}/access-requests/${id}/deny`,
    ),
  /**
   * 撤回**自己**的申请 —— 不需要可见性管理权（那会要求申请人先有管理权，自相矛盾）。
   * 不是自己的申请 ⇒ 服务端按"不存在"处理（404），不泄露"这里有一条别人的申请"。
   */
  withdrawAccessRequest: (slug: string, id: number) =>
    request<{ ok: true; slug: string; withdrawn: number }>(
      'POST',
      `/api/pages/${encodeURIComponent(slug)}/access-requests/${id}/withdraw`,
    ),

  /* ---------------- 组织与邀请管理（P5-B M4/M5） ---------------- */
  /**
   * 组织档案 + 我在组织里的身份。
   * **`access: 'user'`**：登录即可读，不需要管理员 —— 这是它与本组其它端点唯一的区别，
   * 也是"Guest 到底有没有组织角色"的唯一权威来源（`me.role === null` 即 Guest）。
   */
  org: () => request<OrgResponse>('GET', '/api/org'),
  /** 成员列表（`access: 'admin'`：普通成员会 403，这是治理界面几乎全在本页的原因）。 */
  orgMembers: () => request<{ ok: true; members: OrgMember[] }>('GET', '/api/org/members'),
  /**
   * 改某个成员的组织角色。
   *
   * 冲突面（服务端）：涉及 owner 的变更（目标是 owner / 要把谁变成 owner）**仅 owner 可做**
   * ⇒ 403 `forbidden`；降级/移除最后一位 owner ⇒ 409 `last_owner`。
   * 界面先用 `lib/orgPlan.ts` 的 `roleChangeOptions()` 收敛选项，让这两种错不可能发出去。
   */
  setOrgMemberRole: (userId: number, role: OrgRole) =>
    request<{ ok: true; userId: number; role: OrgRole }>(
      'PUT',
      `/api/org/members/${encodeURIComponent(String(userId))}`,
      { role },
    ),
  /**
   * 移除成员。**级联已核实**（`packages/plugin-org/src/index.ts:479`）：事务内显式删
   * `org_members` 并额外 `DELETE FROM group_members WHERE user_id = ?` ⇒ 该用户**立即**
   * 失去组织内一切访问权限（含其所在的用户组带来的授权）；而 `page_grants` / `block_grants`
   * 里 `subject_kind='user'` 的行**保留**（不删）。
   * 冲突：移除自己 ⇒ 409 `cannot_remove_self`；移除最后一位 owner ⇒ 409 `last_owner`。
   */
  removeOrgMember: (userId: number) =>
    request<{ ok: true; removed: number }>(
      'DELETE',
      `/api/org/members/${encodeURIComponent(String(userId))}`,
    ),
  orgGroups: () => request<{ ok: true; groups: OrgGroup[] }>('GET', '/api/org/groups'),
  /** 建组：名称 1–80 字符；同名 ⇒ 409 `group_exists`（唯一约束在组织内）。**没有改名端点**。 */
  createOrgGroup: (name: string) =>
    request<{ ok: true; group: OrgGroup }>('POST', '/api/org/groups', { name }),
  /**
   * 删组。**级联已核实**（`packages/plugin-org/src/index.ts:641`）：只删 `groups` 行，
   * `group_members` 靠 `ON DELETE CASCADE` 清掉；`page_grants` / `block_grants` 里
   * `subject_kind='group'` 的行**保留在库里**，但判定时展开的 `groupIds` 不再包含它
   * ⇒ 该组的授权**实际失效**。方向是**收紧**（相关页面可能变得不可读），
   * 不是"删了也没关系"——界面的确认文案必须照此措辞。
   */
  deleteOrgGroup: (id: number) =>
    request<{ ok: true; removed: number }>('DELETE', `/api/org/groups/${encodeURIComponent(String(id))}`),
  /**
   * 把成员加入用户组。
   * **只能加已是组织成员的人**，否则 409 `not_org_member`（防止"组里有个人但不在组织里"
   * 的幽灵成员：他能凭组授权访问，却不出现在成员列表里）。
   */
  addGroupMember: (groupId: number, userId: number) =>
    request<{ ok: true; groupId: number; userId: number; added: boolean }>(
      'PUT',
      `/api/org/groups/${encodeURIComponent(String(groupId))}/members/${encodeURIComponent(String(userId))}`,
    ),
  removeGroupMember: (groupId: number, userId: number) =>
    request<{ ok: true; groupId: number; userId: number; added: boolean }>(
      'DELETE',
      `/api/org/groups/${encodeURIComponent(String(groupId))}/members/${encodeURIComponent(String(userId))}`,
    ),
  /** 邀请列表（**没有 token 字段**；服务端最多回 200 条，无总数）。 */
  orgInvitations: () =>
    request<{ ok: true; invitations: OrgInvitationView[] }>('GET', '/api/org/invitations'),
  /**
   * 签发邀请。`orgRole` 缺省 / `null` ⇒ **Guest 通道**（入伙但不给组织角色）——
   * 这不是"最低档位"，它就是"没有角色"；`viewer` 是另一件事。
   * 签发 owner 邀请需要 owner（否则 403）。
   * 响应里的 `token` **只此一次**（见 `InvitationCreated`）。
   */
  createInvitation: (body: { email: string; orgRole?: OrgRole | null; groupId?: number | null }) =>
    request<InvitationCreated>('POST', '/api/org/invitations', body),
  /**
   * 撤销邀请：服务端**不区分是否已接受**，无条件删行；已接受者的成员身份不受影响
   * （接受时已写入 `org_members`）—— 界面对"已接受"的行必须说清这一点，
   * 否则管理员会以为"撤销 = 把人踢出去"。
   */
  revokeInvitation: (id: string) =>
    request<{ ok: true; removed: string }>(
      'DELETE',
      `/api/org/invitations/${encodeURIComponent(id)}`,
    ),

  /* 附件（M4） */
  /**
   * 上传（**裸 body PUT**，见 {@link uploadAttachment}）。放在 `api` 上只是为了与其它
   * 端点同一个调用面；真正的实现在模块顶层，编辑器可直接 `import { uploadAttachment }`。
   */
  uploadAttachment,
  /** 某页面的附件列表（需 `canEdit`；无权限时服务端回 404/403，不在这里降级处理）。 */
  pageAttachments: (slug: string) =>
    request<AttachmentListResult>(
      'GET',
      `/api/pages/${encodeURIComponent(slug)}/attachments`,
    ),
  /** 删除附件（`canEdit` 或上传者本人）。按 **id** 定位，不按文件名。 */
  deleteAttachment: (id: number) =>
    request<AttachmentDeleteResult>('DELETE', `${ATTACHMENT_URL_PREFIX}${encodeURIComponent(String(id))}`),
}

/* ------------------- 可见性与授权（权限治理 M1-M3） ------------------- */

/**
 * 页面档位。与后端 `packages/plugin-wiki/src/index.ts:1724` 的
 * `VISIBILITIES = ['private', 'org', 'public']` **同集合**（白名单，服务端不认识别的值）。
 * 这里的刻度是**宽松度**：private（最窄）< org < public（最宽）。
 */
export type PageVisibility = 'private' | 'org' | 'public'

/**
 * 块档位。与后端 `packages/plugin-wiki/src/blocks.ts:28` 的
 * `BlockVisibility = 'public' | 'org' | 'granted'` **同集合** —— 注意它**不是**
 * 页面档位那一套：块**没有** `private`，多出 `granted`（默认谁都不能看，只能靠单独授权放行）。
 *
 * 块档位由作者在 Markdown 里用 `<!--gated:org-->` / `<!--gated:granted-->` 标记声明
 * （打开/闭合 `<!--/gated-->`），保存正文时解析入库；**没有**改块档位的端点，
 * 因此治理界面只读地展示它，不提供"改档位"的控件。
 */
export type BlockVisibility = 'public' | 'org' | 'granted'

/** 授权对象类别。**只有** user | group —— 角色不是授权对象（服务端 D13 明确拒绝 `org_role`）。 */
export type SubjectKind = 'user' | 'group'

/** 授予角色。`editor` 比 `viewer` 宽（同一人既有直授又有组授时 editor 优先）。 */
export type GrantRole = 'editor' | 'viewer'

/** `PUT /api/pages/:slug/visibility` 的响应。 */
export interface VisibilityResult {
  ok: true
  slug: string
  visibility: PageVisibility
  inherit: boolean
  published_at: string | null
  acl_revision: number
  /** 被重算 `tier` 的**子孙块**条数（0 = 该页没有子孙块）。 */
  index_tiers_resynced: number
  /**
   * ★ **与上面那个 0 必须分开对待**：`true` 表示扇出**抛错、一个都没算**
   * （读路径已收紧而检索仍按旧档位 ⇒ **内容泄漏级**），`false` 才是"没有子孙块"。
   * 界面文案见 `lib/accessPlan.ts` 的 `resyncNotice()`。
   */
  index_tiers_resync_failed: boolean
  /** 仅失败时出现：服务端的原始错误串（给运维看，不要直接当界面文案）。 */
  index_tiers_resync_error?: string
}

/**
 * 页级例外授予的一行。
 *
 * ⚠️ **字段是 snake_case** —— 服务端 `GET /api/pages/:slug/grants` 直接回表列名
 * （`subject_kind` / `subject_id` / `granted_at` / `expires_at`），
 * 而**块级**授予在 `GET /api/pages/:slug/blocks` 里是 camelCase（见 `BlockGrantRow`）。
 * 两种命名并存是既有事实，前端按实际形状读，不要"统一"。
 */
export interface PageGrantRow {
  id: number
  subject_kind: SubjectKind
  subject_id: string
  role: GrantRole
  granted_at: string
  /** null = 不过期。过期授予在**判定时**即失效，不依赖清理任务。 */
  expires_at: string | null
}

/** 块级例外授予的一行（嵌在 `BlockRow.grants` 里，**camelCase**）。 */
export interface BlockGrantRow {
  id: number
  subjectKind: SubjectKind
  subjectId: string
  role: GrantRole
  grantedAt: string
  expiresAt: string | null
}

/** `GET /api/pages/:slug/blocks` 的一块。**没有 `text`**（后端刻意不返回正文）。 */
export interface BlockRow {
  id: number
  ordinal: number
  kind: string
  /** 该块**自身声明**的档位（不是与页面合成后的有效档位） */
  visibility: BlockVisibility
  inherit: boolean
  /** 来源标记原文（`'org'` / `'granted'`），null = 未标记。仅用于展示，不参与判定。 */
  marker: string | null
  /**
   * 检索等级：`0`/`1` 是该块所属的读者等级，**`null` = 不属于任何等级**
   * （`granted` 档 ⇒ 只能靠单独授权命中）。界面据此区分"授权档"。
   */
  tier: number | null
  grants: BlockGrantRow[]
}

/** 待审申请的一行（**camelCase**）。`message` 是唯一承载用户自由文本的字段，展示端负责转义。 */
export interface AccessRequestRow {
  id: number
  userId: number
  message: string | null
  status: string
  createdAt: string
  decidedAt: string | null
}

export interface GrantsResponse {
  ok: true
  slug: string
  grants: PageGrantRow[]
}

export interface BlocksResponse {
  ok: true
  slug: string
  blocks: BlockRow[]
}

export interface AccessRequestsResponse {
  ok: true
  slug: string
  /** **只有待审**（服务端已按 `status = 'pending'` 过滤并 LIMIT 200）；没有总数字段。 */
  requests: AccessRequestRow[]
}

/** 新增/更新一条授予的结果（页级与块级共用的部分）。 */
export interface GrantMutationResult {
  ok: true
  slug: string
  role: GrantRole
  acl_revision: number
}

export interface GrantRemovalResult {
  ok: true
  slug: string
  removed: number
  acl_revision: number
}

/** 块级授权的响应：额外带该块**自身声明**的档位。 */
export interface BlockGrantResult extends GrantMutationResult {
  blockId: number
  /** 该块自身声明的档位 —— 当它比页面更宽时，授权不会突破页面上限（规则 B1） */
  block_visibility: string
}

/** `POST /api/pages/:slug/access-requests` 的响应：`id` 是撤回自己的申请所需的句柄。 */
export interface AccessRequestCreated {
  ok: true
  slug: string
  id: number
  status: string
  requestedRole: GrantRole
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
