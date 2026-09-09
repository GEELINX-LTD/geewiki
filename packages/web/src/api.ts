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
  plugins: () => request<{ ok: true; plugins: PluginInfo[] }>('GET', '/api/plugins'),
  graph: () => request<{ ok: true; graph: GraphData }>('GET', '/api/plugins/graph'),
  session: () => request<{ ok: true } & SessionState>('GET', '/api/session'),
  enable: (name: string, config?: Record<string, unknown>) =>
    request<{ ok: true; plugin: PluginInfo }>('POST', `/api/plugins/${encodeURIComponent(name)}/enable`, { config: config ?? {} }),
  disable: (name: string) =>
    request<{ ok: true }>('POST', `/api/plugins/${encodeURIComponent(name)}/disable`),
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
