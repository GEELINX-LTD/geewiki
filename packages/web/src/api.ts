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

export const api = {
  /* 插件管理 */
  plugins: () =>
    request<{ ok: true; plugins: PluginInfo[]; issues?: DiscoveryIssueInfo[] }>('GET', '/api/plugins'),
  graph: () => request<{ ok: true; graph: GraphData }>('GET', '/api/plugins/graph'),
  session: () => request<{ ok: true } & SessionState>('GET', '/api/session'),
  enable: (name: string, config?: Record<string, unknown>) =>
    request<{ ok: true; plugin: PluginInfo }>('POST', `/api/plugins/${encodeURIComponent(name)}/enable`, { config: config ?? {} }),
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
}
