import { registerSlot, type SlotComponent } from './slots'
import { hostSdk, type GeeWikiHostSdk } from './hostSdk'
import {
  PLUGIN_UI_TABLE_PATH,
  isUiSettled,
  parseUiTable,
  planUiSync,
  pluginUiBase as baseOf,
  type UiTableEntry,
} from './pluginUiPlan'

/**
 * 插件客户端 UI 加载器。
 *
 * ## 入口表：后端下发（不再是构建生成物）
 *
 * 宿主读 `GET /api/plugins/ui`（见 `packages/manager/src/plugin-ui.ts` 的 `buildPluginUiTable`）。
 * 该表由**活状态**派生：注册表（谁声明了 `geewiki.client`）× 当前激活集合 × 产物是否真的存在，
 * 于是"装了插件就有 UI、停用就消失"不需要任何重新构建。响应含 `revision`（整表指纹）与逐插件
 * `rev`（产物指纹），带 `If-None-Match` 命中时后端回 304。
 *
 * 之所以不"拼约定 URL + 试探"，是三条实测结论逼出来的（第 1 条详见 `pluginUiPlan.ts` 文件头）：
 * ① dev 下非绝对 URL 的动态 import 会被 Vite 追加 `?import` 并 500；
 * ② dev 下缺失入口返回 200 + text/html → 浏览器报 MIME 错；
 * ③ prod 下缺失入口返回 404 → Chrome 记一条控制台 error（"先探测再 import"必然产生噪声）。
 * 现在"产物缺失"由后端归入 `skipped: entry_missing`，前端根本不会去 import —— 三种噪声结构性消失。
 *
 * ## 生命周期：跟着 fork 走
 *
 * `startPluginUiSync()` 建立三个触发点，全部收敛到幂等、单飞的 {@link syncPluginUi}：
 * ① 管理台动作成功后（`AdminPage` 的 `load()` 是四条变更成功路径的汇聚点，只挂一处）；
 * ② `visibilitychange` 变可见时；③ 可见期低频轮询（默认 15s，`If-None-Match` 让空闲期几乎零成本）。
 * 轮询存在的理由：**外部变更不经过前端**——看门狗试用期回滚会在后端异步 `disable()`，
 * 其它标签页/CLI/直接改清单同理，只靠"动作后刷新"会让界面长期与后端不一致。
 *
 * ## 已知边界（决策，不是待办）
 *
 * - **ESM 模块实例无法从模块图卸载**：`unload` 只回滚插槽注册与 CSS。`rev` 进 URL 已被证伪
 *   （见 `pluginUiPlan.ts` 文件头），所以**产物更新后需要整页刷新**才能拿到新代码；未更新时重新
 *   enable 会命中模块缓存、复用同一实例（`register` 重跑，不累积实例）。
 * - 未做入口完整性/签名校验与版本协商。
 */
export interface PluginUiHost {
  readonly React: unknown
  readonly jsxRuntime: { jsx: unknown; jsxs: unknown; Fragment: unknown }
  registerSlot(name: string, component: SlotComponent): () => void
  unregisterSlot(name: string, token?: unknown): void
  readonly version: string
  readonly pluginName: string
}

interface PluginUiModule {
  register?: (host: PluginUiHost) => unknown
  default?: unknown
}

interface LoadedUi {
  readonly plugin: string
  /** 加载时该插件的产物指纹（变更检测用） */
  readonly rev: string
  readonly disposers: Array<() => void>
  readonly link?: HTMLLinkElement
}

const loaded = new Map<string, LoadedUi>()
/**
 * 每个插件的"代次"。卸载时自增，用于丢弃**在途**的加载：
 * `import()` 是异步的，卸载可能发生在它结算之前，若不检查就会把已卸载插件的 UI 又装回去。
 */
const epochs = new Map<string, number>()
/** 最近一次成功解析的入口表条目（供加载完成前的"是否仍然需要"复核，以及 {@link isSettled}） */
let desired: Record<string, UiTableEntry> = {}
/** 最近一次成功解析的整表指纹（`If-None-Match` 用） */
let lastRevision: string | undefined
/**
 * 加载失败备忘（插件名 → 失败时的 rev）。
 *
 * 两个作用：① 避免每轮轮询都为同一个坏 bundle 重复 import、重复打 warn（rev 变了会自动重试）；
 * ② 让 {@link isSettled} 把"已知失败的条目"视为已收敛，从而恢复 304 短路。
 *
 * 边界：若文件内容变了但 rev 恰好不变（等同名同大小同 mtime 的文件被换回），该 rev 不会再被重试，
 * 直到整页刷新（这两个映射都是进程内状态）。这是刻意的取舍——真出问题时刷新一次即可。
 */
const failed = new Map<string, string>()
/** 单飞：重叠的同步请求复用同一个 promise（三个触发点可能同时打过来） */
let inflight: Promise<void> | null = null

/**
 * 当前界面是否已经"收敛"到最近一次看到的入口表（见 `pluginUiPlan.ts` 的 `isUiSettled`）。
 *
 * **为什么必须有这个判断**：`If-None-Match` 的 304 短路只在"revision 没变 ⇒ 我这边也一定没变"
 * 时成立。但两者可能脱钩——例如某次加载失败（产物 404 / bundle 抛错）时，`revision` 已经推进到新值
 * 而 `loaded` 里并没有那个插件；此后再回到同一个 revision（启用→停用→再启用就会回到同一个哈希，
 * 因为 revision 只是表格内容的哈希），后端回 304，宿主就会**永久**漏加载这个插件。
 * 所以：只要 loaded 与 desired 对不上，就**不带** `If-None-Match`，强制拿一次完整表重新对齐。
 */
function isSettled(): boolean {
  const loadedRevs = new Map<string, string>()
  for (const [name, entry] of loaded) loadedRevs.set(name, entry.rev)
  return isUiSettled(desired, loadedRevs, failed)
}

/**
 * 插件名 → 该插件界面目录的**同源绝对 URL**（不带 query）。
 * 必须是绝对 URL：相对/根路径形式的动态 import 会被 Vite 注入 `?import`（见 `pluginUiPlan.ts` 文件头）。
 * 非法名返回 undefined。
 */
export function pluginUiBase(name: string, origin: string = window.location.origin): string | undefined {
  return baseOf(name, origin)
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

async function loadPluginUi(name: string, meta: UiTableEntry, sdk: GeeWikiHostSdk): Promise<void> {
  if (loaded.has(name)) return
  // 同一个 rev 已经失败过就不再重试（否则 15s 轮询会反复 import + 反复打日志）
  if (failed.get(name) === meta.rev) return
  const base = pluginUiBase(name)
  if (!base) {
    console.debug(`[geewiki-plugin-ui] 插件名不符合路径约定，跳过：${name}`)
    failed.set(name, meta.rev)
    return
  }
  // 记下本次加载所属的代次：await 期间若发生卸载（epoch 自增），这次加载必须作废
  const epoch = epochs.get(name) ?? 0
  let mod: PluginUiModule
  try {
    // 注意：这里**不能**加 `?v=` 之类的 query（已被实测证伪，见 pluginUiPlan.ts 文件头）
    mod = (await import(/* @vite-ignore */ `${base}/${meta.entry}`)) as PluginUiModule
  } catch (err) {
    // 入口已声明却加载失败属于真实故障（作者漏发产物的典型症状），但不该打断宿主启动
    console.warn(`[geewiki-plugin-ui] 插件界面加载失败：${name}`, err instanceof Error ? err.message : err)
    failed.set(name, meta.rev)
    return
  }
  // 迟到检查：await 期间该插件可能已被卸载，或已不再被入口表需要（例如用户刚点了停用）
  if ((epochs.get(name) ?? 0) !== epoch || !(name in desired) || loaded.has(name)) {
    console.debug(`[geewiki-plugin-ui] 丢弃迟到的插件界面加载：${name}`)
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
  loaded.set(name, { plugin: name, rev: meta.rev, disposers, link })
  console.debug(`[geewiki-plugin-ui] 已加载插件界面：${name}`)
}

/** 卸载某插件的界面贡献（注销插槽注册 + 移除 CSS）。ESM 模块本身无法从模块图中卸载。 */
export function unloadPluginUi(name: string): boolean {
  // 无论此前是否真的加载过，都要推进代次：可能有在途 import 尚未结算
  epochs.set(name, (epochs.get(name) ?? 0) + 1)
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

/** 最近一次成功解析的整表指纹（排障/测试用）。 */
export function pluginUiRevision(): string | undefined {
  return lastRevision
}

/** 拉一次入口表并让界面与之对齐（幂等、单飞）。三个触发点都调它。 */
export function syncPluginUi(): Promise<void> {
  if (inflight) return inflight
  const run = doSync().finally(() => {
    inflight = null
  })
  inflight = run
  return run
}

async function doSync(): Promise<void> {
  const sdk = hostSdk()
  if (!sdk) {
    console.warn('[geewiki-plugin-ui] 宿主 SDK 未初始化，跳过插件界面加载')
    return
  }
  const url = new URL(PLUGIN_UI_TABLE_PATH, window.location.origin).href
  // 只有"已收敛"时才敢用 304 短路（否则可能永久漏加载，见 isSettled 的说明）
  const useEtag = lastRevision !== undefined && isSettled()
  let res: Response
  try {
    res = await fetch(url, {
      headers: useEtag ? { 'If-None-Match': `"${lastRevision as string}"` } : {},
    })
  } catch (err) {
    // 网络抖动：既不加载也不卸载（不能把已加载界面清空）
    console.debug('[geewiki-plugin-ui] 入口表请求失败：', err instanceof Error ? err.message : err)
    return
  }
  if (res.status === 304) return // 什么都没变：零动作（不触碰已加载 UI、不触发重渲染）
  if (!res.ok) {
    console.debug(`[geewiki-plugin-ui] 入口表不可用（HTTP ${res.status}），跳过本次同步`)
    return
  }
  let payload: unknown
  try {
    payload = await res.json()
  } catch (err) {
    console.debug('[geewiki-plugin-ui] 入口表解析失败：', err instanceof Error ? err.message : err)
    return
  }
  const table = parseUiTable(payload)
  if (!table) {
    console.debug('[geewiki-plugin-ui] 入口表格式不可信，跳过本次同步')
    return
  }
  lastRevision = table.revision
  desired = table.entries
  const loadedRevs = new Map([...loaded].map(([name, entry]) => [name, entry.rev]))
  const plan = planUiSync(table.entries, loadedRevs)
  // 先卸后装：产物更新的插件会同时出现在两个数组里（rev 变化），换新代码前必须先回收旧注册
  for (const name of plan.unload) unloadPluginUi(name)
  for (const name of plan.load) {
    const meta = table.entries[name]
    if (meta) await loadPluginUi(name, meta, sdk)
  }
}

/**
 * 兼容入口：早期调用方（与调试入口 `refresh()`）用它做一次同步。
 * 现在等价于 {@link syncPluginUi}——同源、幂等、带 304 短路。
 */
export function refreshPluginUi(): Promise<void> {
  return syncPluginUi()
}

export interface PluginUiSyncOptions {
  /** 轮询间隔（毫秒）。`document.hidden` 时跳过；带 `If-None-Match`，未变化时只有一个 304。 */
  intervalMs?: number
}

let stopSync: (() => void) | null = null

/**
 * 建立插件界面与 fork 生命周期的自动同步：先立即同步一次，再挂 `visibilitychange` 与轮询。
 * @returns 停止函数（幂等）；重复调用返回同一个停止函数，不会叠加定时器。
 */
export function startPluginUiSync(options: PluginUiSyncOptions = {}): () => void {
  if (stopSync) return stopSync
  const intervalMs = options.intervalMs ?? 15_000
  const onVisibility = (): void => {
    if (!document.hidden) void syncPluginUi()
  }
  document.addEventListener('visibilitychange', onVisibility)
  const timer = setInterval(() => {
    if (!document.hidden) void syncPluginUi()
  }, intervalMs)
  const stop = (): void => {
    document.removeEventListener('visibilitychange', onVisibility)
    clearInterval(timer)
    stopSync = null
  }
  stopSync = stop
  void syncPluginUi()
  return stop
}

declare global {
  interface Window {
    /** 调试/测试入口（排障与 CDP 验收脚本依赖它，故保留 refresh/unload/loaded/base 四个旧方法） */
    __GEEWIKI_PLUGIN_UI__?: {
      /** 做一次同步（等价于 sync，保留旧名以免破坏既有排障习惯） */
      refresh: () => Promise<void>
      sync: () => Promise<void>
      unload: (name: string) => boolean
      loaded: () => string[]
      /** 最近一次成功解析的整表指纹（未成功过则为 undefined） */
      revision: () => string | undefined
      /** 插件名 → 界面目录 URL（非法名返回 undefined），供排障与测试断言 */
      base: (name: string) => string | undefined
    }
  }
}

window.__GEEWIKI_PLUGIN_UI__ = {
  refresh: refreshPluginUi,
  sync: syncPluginUi,
  unload: unloadPluginUi,
  loaded: loadedPluginUi,
  revision: pluginUiRevision,
  base: pluginUiBase,
}
