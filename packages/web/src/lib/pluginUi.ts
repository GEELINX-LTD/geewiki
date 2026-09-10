import { registerSlot, type SlotComponent } from './slots'
import type { GeeWikiHostSdk } from './hostSdk'

/**
 * 插件客户端 UI 加载器（过渡实现）。
 *
 * ## 入口表
 * 插件界面入口由一份**入口表**声明：`GET /plugins-ui/registry.json`
 * （形如 `{ "version": 1, "plugins": { "<插件名>": { "entry": "client.js", "css": "client.css" } } }`）。
 * 只有出现在入口表里、且当前 `GET /api/plugins` 中 `state === 'active'` 的插件才会被加载。
 *
 * 当前这份入口表由夹具构建产出（`packages/web/fixtures`，见其 README）。之所以不用
 * 「拼约定 URL + 试探」而是显式入口表，是三条实测结论逼出来的：
 *
 * 1. **dev（Vite）下不能 `import('/plugins-ui/...')`**：Vite 的 import-analysis 会把动态 import
 *    改写成 `import(__vite__injectQuery(url, 'import'))`，而该 helper 对以 `.`/`/` 开头的 URL 一律
 *    追加 `?import`；dev server 随即以 500 拒绝——"This file is in /public and will be copied
 *    as-is during build ... should not be imported from source code. It can only be referenced via
 *    HTML tags."。所以入口必须是**同源绝对 URL**（`url[0] !== './'` ⇒ helper 原样返回）。
 * 2. **dev 下"缺失入口"返回 200 + text/html**（SPA fallback），直接 import 会让浏览器打出
 *    "Failed to load module script ... MIME type of text/html"，该日志 JS 捕获不掉。
 * 3. **prod 下"缺失入口"返回 404**，而 Chrome 会把任何 404 记为控制台 `log:error`
 *    （"Failed to load resource"）。—— 于是"先探测再 import"在 prod 必然产生控制台错误。
 *
 * 结论：靠约定 URL 猜 = 要么噪声、要么误判；显式入口表既能零噪声，也正好是下一步的形态。
 *
 * ## TODO（下一批「入口下发 + 生命周期绑定」）
 * 1. 入口表改由后端随插件清单下发（manifest 的 `client.entry` / `client.slots`），删除这份静态 JSON；
 * 2. 订阅 fork 事件（enable/disable/热更新）自动 `refreshPluginUi()`，不再由调用方手动刷新；
 * 3. 插件 UI 的版本与完整性校验（当前无签名、无版本协商）。
 *
 * ## 插件 bundle 契约（v1，最小）
 * `export function register(host: PluginUiHost): void | (() => void)`
 * —— 可返回清理函数；`host.registerSlot()` 返回的注销函数由加载器代为收集。
 */
export interface PluginUiHost {
  readonly React: unknown
  readonly jsxRuntime: { jsx: unknown; jsxs: unknown; Fragment: unknown }
  registerSlot(name: string, component: SlotComponent): () => void
  unregisterSlot(name: string, token?: unknown): void
  readonly version: string
  readonly pluginName: string
}

/** 过渡期入口表路径（正式方案改为后端下发） */
export const PLUGIN_UI_REGISTRY_PATH = '/plugins-ui/registry.json'

interface RegistryEntry {
  entry: string
  css?: string
}

interface RegistryFile {
  version?: number
  plugins?: Record<string, { entry?: unknown; css?: unknown } | undefined>
}

interface PluginSummary {
  name: string
  state?: string
}

interface PluginUiModule {
  register?: (host: PluginUiHost) => unknown
  default?: unknown
}

interface LoadedUi {
  readonly plugin: string
  readonly disposers: Array<() => void>
  readonly link?: HTMLLinkElement
}

const loaded = new Map<string, LoadedUi>()

/** 插件名的一段：允许 `@scope` 前缀，拒绝空格/`..`/斜杠等 */
const PATH_SEGMENT = /^@?[A-Za-z0-9][A-Za-z0-9._-]*$/
/** 入口文件名：单段、无路径分隔符（入口必须落在插件自己的目录内） */
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 插件名 → 该插件界面目录的**同源绝对 URL**。
 * 必须是绝对 URL：相对/根路径形式的动态 import 会被 Vite 注入 `?import`（见文件头第 1 条）。
 */
export function pluginUiBase(name: string): string | undefined {
  const segments = name.split('/')
  if (segments.length === 0 || segments.length > 2) return undefined
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment === '.' || segment === '..') return undefined
  }
  return new URL(`/plugins-ui/${segments.join('/')}`, window.location.origin).href
}

function sanitizeFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !FILE_SEGMENT.test(value)) return undefined
  return value
}

/**
 * 读取入口表。
 * @returns 成功（含 404＝"没有任何插件界面"）返回条目 Map；网络/解析失败返回 undefined，
 *          调用方据此**不做卸载动作**（避免入口表临时不可用时把已加载界面清空）。
 */
async function fetchRegistry(): Promise<Map<string, RegistryEntry> | undefined> {
  const out = new Map<string, RegistryEntry>()
  const url = new URL(PLUGIN_UI_REGISTRY_PATH, window.location.origin).href
  let body: RegistryFile
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.debug(`[geewiki-plugin-ui] 没有插件界面入口表（HTTP ${res.status}），跳过插件界面加载`)
      return out
    }
    body = (await res.json()) as RegistryFile
  } catch (err) {
    console.debug('[geewiki-plugin-ui] 入口表读取失败：', err instanceof Error ? err.message : err)
    return undefined
  }
  for (const [name, raw] of Object.entries(body.plugins ?? {})) {
    const entry = sanitizeFile(raw?.entry)
    if (!entry) {
      console.debug(`[geewiki-plugin-ui] 入口表条目非法，跳过：${name}`)
      continue
    }
    const css = sanitizeFile(raw?.css)
    out.set(name, css ? { entry, css } : { entry })
  }
  return out
}

/** 插件 CSS 由宿主集中注入：lib 模式不会自动注入样式，集中注入可避免重复与卸载残留。 */
function injectCss(name: string, href: string): HTMLLinkElement | undefined {
  if (document.querySelector(`link[data-plugin-ui="${name}"]`)) return undefined
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.pluginUi = name
  document.head.appendChild(link)
  return link
}

async function loadPluginUi(name: string, meta: RegistryEntry, sdk: GeeWikiHostSdk): Promise<void> {
  if (loaded.has(name)) return
  const base = pluginUiBase(name)
  if (!base) {
    console.debug(`[geewiki-plugin-ui] 插件名不符合路径约定，跳过：${name}`)
    return
  }
  let mod: PluginUiModule
  try {
    mod = (await import(/* @vite-ignore */ `${base}/${meta.entry}`)) as PluginUiModule
  } catch (err) {
    // 入口已声明却加载失败属于真实故障（作者漏发产物的典型症状），但不该打断宿主启动
    console.warn(`[geewiki-plugin-ui] 插件界面加载失败：${name}`, err instanceof Error ? err.message : err)
    return
  }
  const register =
    typeof mod.register === 'function'
      ? (mod.register as (host: PluginUiHost) => unknown)
      : typeof mod.default === 'function'
        ? (mod.default as (host: PluginUiHost) => unknown)
        : undefined
  if (!register) {
    console.debug(`[geewiki-plugin-ui] 插件 bundle 未导出 register(host)，跳过：${name}`)
    return
  }
  const disposers: Array<() => void> = []
  const host: PluginUiHost = {
    React: sdk.React,
    jsxRuntime: sdk.jsxRuntime,
    version: sdk.version,
    pluginName: name,
    registerSlot: (slot, component) => {
      const off = registerSlot(slot, component, name)
      disposers.push(off)
      return off
    },
    unregisterSlot: sdk.unregisterSlot,
  }
  try {
    const cleanup = register(host)
    if (typeof cleanup === 'function') disposers.push(cleanup as () => void)
  } catch (err) {
    // 插件入口自身执行失败：回滚它已经注册的部分，避免留下半截 UI
    console.warn(`[geewiki-plugin-ui] 插件 ${name} 的客户端入口执行失败，已回滚：`, err)
    for (const off of disposers.splice(0)) off()
    return
  }
  const link = meta.css ? injectCss(name, `${base}/${meta.css}`) : undefined
  loaded.set(name, { plugin: name, disposers, link })
  console.debug(`[geewiki-plugin-ui] 已加载插件界面：${name}`)
}

/** 卸载某插件的界面贡献（注销插槽注册 + 移除 CSS）。ESM 模块本身无法从模块图中卸载。 */
export function unloadPluginUi(name: string): boolean {
  const entry = loaded.get(name)
  if (!entry) return false
  for (const off of entry.disposers.splice(0)) {
    try {
      off()
    } catch (err) {
      console.debug(`[geewiki-plugin-ui] 注销 ${name} 的插槽注册时出错：`, err)
    }
  }
  entry.link?.remove()
  loaded.delete(name)
  return true
}

/** 已加载界面的插件名（排障/测试用）。 */
export function loadedPluginUi(): string[] {
  return [...loaded.keys()]
}

/**
 * 拉取插件清单与入口表，让界面与之一致：激活且在入口表里的插件加载 UI；
 * 不再激活（或已从入口表移除）的插件卸载。幂等：重复调用不会重复加载。
 */
export async function refreshPluginUi(): Promise<void> {
  const sdk = window.__GEEWIKI_HOST__
  if (!sdk) {
    console.warn('[geewiki-plugin-ui] 宿主 SDK 未初始化，跳过插件界面加载')
    return
  }
  let plugins: PluginSummary[] = []
  try {
    const res = await fetch('/api/plugins')
    if (!res.ok) {
      console.debug(`[geewiki-plugin-ui] 拉取插件列表失败：HTTP ${res.status}`)
      return
    }
    const body = (await res.json()) as { plugins?: PluginSummary[] } | PluginSummary[]
    plugins = Array.isArray(body) ? body : (body.plugins ?? [])
  } catch (err) {
    console.debug('[geewiki-plugin-ui] 拉取插件列表失败：', err instanceof Error ? err.message : err)
    return
  }
  const registry = await fetchRegistry()
  if (!registry) return
  const active = new Set(plugins.filter((item) => item.state === 'active').map((item) => item.name))
  for (const [name, meta] of registry) {
    if (active.has(name)) await loadPluginUi(name, meta, sdk)
  }
  for (const name of loadedPluginUi()) {
    if (!active.has(name) || !registry.has(name)) unloadPluginUi(name)
  }
}

declare global {
  interface Window {
    /** 过渡期的调试/测试入口；入口表由后端下发后可移除 */
    __GEEWIKI_PLUGIN_UI__?: {
      refresh: () => Promise<void>
      unload: (name: string) => boolean
      loaded: () => string[]
      /** 插件名 → 界面目录 URL（非法名返回 undefined），供排障与测试断言 */
      base: (name: string) => string | undefined
    }
  }
}

window.__GEEWIKI_PLUGIN_UI__ = {
  refresh: refreshPluginUi,
  unload: unloadPluginUi,
  loaded: loadedPluginUi,
  base: pluginUiBase,
}
