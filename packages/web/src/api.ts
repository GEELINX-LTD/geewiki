/**
 * GeeWiki 前端 API 客户端。
 * 后端约定：成功 { ok: true, ... }；失败 { ok: false, error, message, details }，
 * HTTP 状态码与 ManagerError.code 映射（404 not_found / 409 冲突类 / 400 / 500）。
 */

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* 非 JSON（如 204） */
  }
  if (!res.ok) {
    const f = (data ?? {}) as Partial<ApiFailure>
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

/** 降级原因：**按它分支文案，绝不按 message 文本分支**（上游 message 可能变化/被脱敏） */
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
  | 'empty_query'

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

export const api = {
  /* 插件管理 */
  plugins: () =>
    request<{ ok: true; plugins: PluginInfo[]; issues?: DiscoveryIssueInfo[] }>('GET', '/api/plugins'),
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
}
