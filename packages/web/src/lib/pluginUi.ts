import { registerSlotByName, type AnySlotComponent } from './slots'
import { registerRoute, unregisterRoutes, type PluginRouteProps } from './routes'
import { hostSdk, type GeeWikiHostSdk } from './hostSdk'
import { errorDetail } from './errorText'
import type { ComponentType } from 'react'
import {
  PLUGIN_UI_TABLE_PATH,
  SLOT_TABLE_PATH,
  isLazyOnlyEntry,
  isUiSettled,
  parseSuppressedOwners,
  parseUiTable,
  planUiSync,
  pluginUiBase as baseOf,
  type BuiltinSlotName,
  type PluginRouteDecl,
  type SlotName,
  type SuppressedOwners,
  type UiSkipped,
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
 * ① 插件页动作成功后（`pages/GraphPage.tsx` 的 `load()` 是四条变更成功路径的汇聚点，只挂一处）；
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
  registerSlot(name: string, component: AnySlotComponent): () => void
  unregisterSlot(name: string, token?: unknown): void
  /**
   * 把 markdown 渲染成**已消毒**的 HTML（宿主 `lib/sanitize.ts` 的同一条管线）。
   *
   * 为什么这是宿主能力而不是插件自带：消毒白名单是**安全边界**，一份实现才有审计点。
   * 插件拿到的是可直接 `dangerouslySetInnerHTML` 的字符串；往里面**再拼**未经消毒的串
   * 就绕过了这条边界，属插件的契约违约（阅读页同源，风险面一致）。
   */
  renderMarkdown(markdown: string): string
  /**
   * 注册本插件的一个**页面组件**（F2）。返回幂等的注销函数。
   *
   * `id` 必须已在 `package.json#geewiki.routes` 里声明——路由参与"要不要加载这个产物"
   * 的决策，未声明的 id 没有加载依据（详见实现处的说明）。
   */
  registerRoute(id: string, component: ComponentType<PluginRouteProps>): () => void
  /** 注销某来源的全部路由（卸载/重载的统一出口） */
  unregisterRoutes(source: string): void
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
const EMPTY_SKIPPED: readonly UiSkipped[] = Object.freeze([])
const EMPTY_NAMES: readonly string[] = Object.freeze([])

const failed = new Map<string, string>()
/**
 * **加载失败备忘（要给人看的那一份）**：插件名 → 失败原因。
 *
 * 与 {@link failed} 的分工：那个存"失败时的 rev"，只用于"同一 rev 不重复重试"的短路判断；
 * 这一份是**界面事实** —— "这个插件的界面此刻是不可用的"。此前加载失败只打一条 `console.warn`，
 * 用户看到的是"某个功能凭空不见了"（页脚少了一块、编辑器退回纯文本）而没有任何解释，
 * 也不知道该找谁。现在由 `slots.tsx` 的 `SlotOutlet` 读 {@link pluginUiFailed} 渲染一条
 * `role="status"` 提示条（用 `lib/pluginUiPlan.ts` 之外的这一份状态，不再重复 console 之外的信息）。
 *
 * 失败记录是**可自愈**的：reset（成功加载 / 卸载 / rev 变化后重试）时删除，
 * 故提示条不会在问题解决后残留。
 */
const failedLoads = new Map<string, string>()

/** 一条"插件界面加载失败"（name 用于文案，message 只作排障线索，不进正文） */
export interface PluginUiFailure {
  readonly name: string
  readonly message: string
}

const EMPTY_FAILURES: readonly PluginUiFailure[] = Object.freeze([])
let cachedFailures: readonly PluginUiFailure[] = EMPTY_FAILURES

/**
 * 失败清单的**稳定快照**（按插件名排序）。
 *
 * 为什么必须缓存引用：`useSyncExternalStore` 要求 getSnapshot 在状态未变时返回**同一个对象**，
 * 否则每次读取都算"变了" ⇒ 无限重渲染。这里的比对按内容做，内容不变就复用上一次的数组。
 */
function failureSnapshot(): readonly PluginUiFailure[] {
  const next = [...failedLoads]
    .map(([name, message]) => ({ name, message }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const same =
    next.length === cachedFailures.length &&
    next.every((x, i) => x.name === cachedFailures[i]?.name && x.message === cachedFailures[i]?.message)
  if (!same) cachedFailures = Object.freeze(next)
  return cachedFailures
}

/** 当前**界面加载失败**的插件（引用稳定；供 SlotOutlet 与测试读）。 */
export function pluginUiFailed(): readonly PluginUiFailure[] {
  return cachedFailures
}

/** {@link pluginUiFailedFor} 的按插槽缓存（引用稳定性同 {@link failureSnapshot} 的理由） */
const cachedFailuresBySlot = new Map<SlotName, readonly PluginUiFailure[]>()
/** {@link pluginUiDeclaredFor} 的按插槽缓存（同上：引用稳定性是 `useSyncExternalStore` 的硬要求） */
const cachedDeclaredBySlot = new Map<SlotName, readonly string[]>()

/**
 * **某个插槽**的加载失败清单：只保留"入口表里声明过该插槽"的插件。
 *
 * 为什么需要按插槽过滤：{@link pluginUiFailed} 是全局清单，`app-header` 的 outlet 把它渲染一遍、
 * `app-footer` 再渲染一遍，而某个插槽的出口若也照抄全局清单，就会出现"文章摘要卡说某个页脚插件
 * 加载失败"这种毫不相干的提示——用户照着去查，查到的却是另一个插件。
 * 判据用入口表的 `slots`（后端从 manifest × 仲裁派生），因此"插件声明了 `article-summary`
 * 而它的 bundle 加载失败"这件事只会出现在那个插槽里，且随失败自愈而消失。
 *
 * 引用稳定：`useSyncExternalStore` 要求状态未变时返回同一对象，故比对内容后复用旧数组。
 */
export function pluginUiFailedFor(slot: SlotName): readonly PluginUiFailure[] {
  const next = cachedFailures.filter((f) => (desired[f.name]?.slots ?? []).includes(slot))
  const prev = cachedFailuresBySlot.get(slot)
  if (prev !== undefined && prev.length === next.length && prev.every((x, i) => x === next[i])) {
    return prev
  }
  const frozen = Object.freeze(next)
  cachedFailuresBySlot.set(slot, frozen)
  return frozen
}

/**
 * **入口表里声明了某插槽、且该插槽归它生效**的插件名（不要求 bundle 已加载）。
 *
 * 这是"宿主该不该显示某个功能的入口"的**唯一正确判据**。两个看起来更直接的判据都错：
 * - 用"已注册的插槽组件"判 ⇒ **自锁**：懒加载插槽（`ON_DEMAND_SLOTS` 里的那些）的
 *   组件只有**进入那个视图之后**才会加载，而入口按钮恰恰在进入之前才需要出现。用它判等于
 *   "按钮永远不出现，除非按钮已经出现过"（实测踩过：列表页的"AI 问答"入口恒不渲染，
 *   而那个入口与插槽已随 P8 拆除——判据本身仍然成立，且现在依然被断言守着）。
 * - 用 `GET /api/plugins` 的激活态 + 硬编码插件名判 ⇒ 把功能的归属写死在宿主里，换名/换实现/
 *   第三方接管都会让入口静默错位（本批要消除的第一件事）。
 *
 * 入口表由后端从"清单 × 激活集合 × 产物存在性 × 插槽仲裁"派生，`slots` 字段是**已裁决的生效集**
 * （被抑制的单占用声明者不在其中），因此它恰好回答"点进去之后真的有人渲染面板吗"。
 *
 * 引用稳定：与 {@link pluginUiFailedFor} 同理由（`useSyncExternalStore` 要求未变化时同一对象）。
 */
export function pluginUiDeclaredFor(slot: SlotName): readonly string[] {
  const next = Object.keys(desired)
    .filter((name) => (desired[name]?.slots ?? []).includes(slot))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const prev = cachedDeclaredBySlot.get(slot)
  if (prev !== undefined && prev.length === next.length && prev.every((x, i) => x === next[i])) return prev
  const frozen = Object.freeze(next)
  cachedDeclaredBySlot.set(slot, frozen)
  return frozen
}

/**
 * 已按需推迟的条目（插件名 → 决定推迟时的 rev）。
 *
 * 与 {@link failed} 同构：用于让 {@link isSettled} 把"刻意推迟"视为已收敛，
 * 否则每轮 15s 轮询都会放弃 304、白拉一次完整表。rev 变了自然作废并重新评估。
 */
const deferred = new Map<string, string>()
/** 推迟中的条目（按需加载时要用它们的 entry/css） */
const deferredEntries = new Map<string, UiTableEntry>()
/** 按需加载的单飞标记（同一插件的并发触发只加载一次） */
const onDemandInflight = new Map<string, Promise<void>>()
/** 单飞：重叠的同步请求复用同一个 promise（三个触发点可能同时打过来） */
let inflight: Promise<void> | null = null
/** 最近一次成功解析的「未列出 UI 的插件与原因」，供管理台展示（见 `classifyUiSkips`） */
let lastSkipped: readonly UiSkipped[] = EMPTY_SKIPPED
/**
 * 被抑制的单占用插槽声明者（插槽名 → 插件名集合），来自权威仲裁端点。
 *
 * 空 Map 表示"没有冲突"，此时不拦任何注册。取不到仲裁信息时**保持上一次的值**（不重置为空，
 * 否则一次网络抖动会让被抑制者趁机注册进去，两个编辑器又同时出现）。
 */
let suppressedOwners: SuppressedOwners = new Map()

/** 供 UI 订阅的只读快照（排障入口与管理台用） */
export interface PluginUiState {
  /** 最近一次成功解析的整表指纹（未成功过则为 undefined） */
  revision: string | undefined
  /** 未列出 UI 的插件与原因（顺序与后端一致：后端已按名排序） */
  skipped: readonly UiSkipped[]
  /** 当前已成功挂载界面的插件名（已排序，便于断言） */
  loaded: readonly string[]
  /** 界面**加载失败**的插件（已排序）。此前只进 console，现由 SlotOutlet 渲染成可见提示条 */
  failed: readonly PluginUiFailure[]
}

const stateListeners = new Set<() => void>()
let cachedState: PluginUiState = {
  revision: undefined,
  skipped: EMPTY_SKIPPED,
  loaded: EMPTY_NAMES,
  failed: EMPTY_FAILURES,
}

/** 按当前内部状态构造一份快照 */
function snapshotState(): PluginUiState {
  return {
    revision: lastRevision,
    skipped: lastSkipped,
    loaded: Object.freeze([...loaded.keys()].sort()),
    failed: failureSnapshot(),
  }
}

/** 两份快照是否等价（逐字段比，数组按序比） */
function sameState(a: PluginUiState, b: PluginUiState): boolean {
  if (a.revision !== b.revision) return false
  if (a.loaded.length !== b.loaded.length) return false
  for (let i = 0; i < a.loaded.length; i++) if (a.loaded[i] !== b.loaded[i]) return false
  if (a.skipped.length !== b.skipped.length) return false
  for (let i = 0; i < a.skipped.length; i++) {
    const x = a.skipped[i] as UiSkipped
    const y = b.skipped[i] as UiSkipped
    if (x.name !== y.name || x.reason !== y.reason) return false
  }
  // 失败清单也要参与比对：否则"只有失败变了"时 emitState 会提前返回、订阅者收不到通知，
  // 提示条就永远不出现（SlotOutlet 不因插槽注册变化而重渲染——失败时根本没有注册发生）。
  if (a.failed.length !== b.failed.length) return false
  for (let i = 0; i < a.failed.length; i++) {
    const x = a.failed[i]
    const y = b.failed[i]
    if (x === undefined || y === undefined || x.name !== y.name || x.message !== y.message) return false
  }
  return true
}

/**
 * 通知订阅者"插件 UI 状态变了"。
 *
 * 两条约束同时成立：
 * ① `useSyncExternalStore` 要求 `getSnapshot` 在状态**未变**时返回**同一个引用**，否则每次读取
 *    都算"变了"→ 无限重渲染；
 * ② 反过来，状态**没实质变化**时也不该通知——15s 轮询每次成功同步都会走到这里，若无脑通知，
 *    管理台就会每 15 秒白重渲染一次。
 * 故：先比对，真的变了才换引用 + 通知。
 */
function emitState(): void {
  const next = snapshotState()
  if (sameState(cachedState, next)) return
  cachedState = next
  for (const listener of [...stateListeners]) listener()
}

/** 订阅插件 UI 状态变更（返回取消订阅函数）。 */
export function subscribePluginUiState(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/**
 * 当前插件 UI 状态快照（引用稳定：未变更时返回同一个对象）。
 * 所有变更点都会经 {@link emitState} 更新缓存，故这里直接读缓存。
 */
export function pluginUiState(): PluginUiState {
  return cachedState
}

/** 未列出 UI 的插件与原因（排障/测试用）。 */
export function pluginUiSkipped(): readonly UiSkipped[] {
  return lastSkipped
}

/** 一条归属明确的**生效路由声明**（入口表 × 插件名，F2） */
export interface DeclaredRoute extends PluginRouteDecl {
  /** 声明它的插件名 */
  readonly plugin: string
}

/**
 * 已声明路由的**稳定快照**。
 *
 * 与 `cachedState` 同样的理由：`useSyncExternalStore` 要求数据未变时返回同一引用，
 * 现算数组会让 React 无限重渲染。故只在 `desired` 变化时重建（见 {@link rebuildRoutes}）。
 */
let routesSnapshot: readonly DeclaredRoute[] = Object.freeze([])

/**
 * 从当前入口表重建路由快照。
 *
 * 排序规则在这里定死（不是在 App 里）：`group`（main 在前）→ `order`（缺省 100）→ `label` → `id`。
 * 放在这里是因为**导航有多处渲染点**（桌面标签、窄屏菜单、命令面板），
 * 若各处自己排一遍，迟早出现"桌面顺序对、命令面板顺序不对"这类只在某个入口复现的漂移
 * （`navPlan.ts` 的注释记录过同一条教训）。
 */
function rebuildRoutes(): void {
  const out: DeclaredRoute[] = []
  for (const name of Object.keys(desired).sort()) {
    const entry = desired[name]
    for (const route of entry?.routes ?? []) out.push({ ...route, plugin: name })
  }
  out.sort((a, b) => {
    const ga = a.group === 'main' ? 0 : 1
    const gb = b.group === 'main' ? 0 : 1
    if (ga !== gb) return ga - gb
    const oa = a.order ?? 100
    const ob = b.order ?? 100
    if (oa !== ob) return oa - ob
    return (a.label ?? a.id).localeCompare(b.label ?? b.id) || a.id.localeCompare(b.id)
  })
  routesSnapshot = Object.freeze(out)
}

/** 当前全部**生效的**插件页面路由声明（按导航展示顺序；稳定引用）。 */
export function pluginUiRoutes(): readonly DeclaredRoute[] {
  return routesSnapshot
}

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
  return isUiSettled(desired, loadedRevs, failed, deferred)
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
    /*
      记进**要给人看的那一份**并广播：否则界面上的表现只是"这块功能不见了"，
      用户既不知道原因，也不知道该去插件管理里检查产物。emitState 必须显式调用 ——
      失败路径上没有任何插槽注册发生，不广播就永远不会有订阅者重渲染。
      存的是**排障摘要**（`errorDetail`），它只会落在 console 与 `data-*` 上：
      给用户看的正文是 `slots.tsx` 里那句固定中文（原始串可能含英文/路径，不能直接展示）。
    */
    failedLoads.set(name, errorDetail(err))
    emitState()
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
      /*
       * **越权拦阻（两道）**。单占用插槽（editor）的权威裁决在后端，被抑制的插件**仍然是
       * active 的**——它的 bundle 照样加载、照样调 registerSlot。不拦的后果是两个编辑器同时渲染。
       *
       * ① 权威仲裁（`GET /api/plugins/slots` 的 suppressed）：这是**主判据**。
       *    不能只靠入口表的 `slots` 字段——实测证明那条路是漏的：后端在生效插槽为空时
       *    **省略该键**，于是"声明了但被抑制"与"根本没声明插槽"无法区分，被抑制者会蒙混过关
       *    （E2E 抓到过：赢家是 A，界面却渲染了被抑制的 B）。
       * ② 入口表的生效插槽（次判据）：只有当该插件**声明过**插槽（字段存在）时才校验，
       *    用于挡住"声明了 editor 却去注册 app-header"这种越界。
       *    字段缺失 ⇒ 不校验：那是**纯浏览器侧注册**的插件（如 `plugins/ui-demo` 在 client.js 里
       *    注册 app-header/app-footer），它们不在后端 owners 里，既有行为必须保留。
       */
      const suppressed = suppressedOwners.get(slot as SlotName)
      if (suppressed?.has(name) === true) {
        console.warn(
          `[geewiki-plugin-ui] 插件 ${name} 是插槽 "${slot}" 的**被抑制**声明者（单占用插槽已被` +
            `激活顺序更早的插件占用），其注册已忽略——否则会出现两个编辑器同时渲染。`,
        )
        return () => {}
      }
      if (meta.slots !== undefined && !meta.slots.includes(slot as SlotName)) {
        console.warn(
          `[geewiki-plugin-ui] 插件 ${name} 尝试注册未获生效的插槽 "${slot}"，已忽略` +
            `（该插件生效插槽：${meta.slots.join(', ') || '无'}）`,
        )
        return () => {}
      }
      const off = registerSlotByName(slot, component, name)
      disposers.push(off)
      return off
    },
    unregisterSlot: sdk.unregisterSlot,
    renderMarkdown: (markdown: string) => sdk.renderMarkdown(markdown),
    /*
     * F2：插件页面路由的组件注册。
     *
     * **必须按清单已声明的 id 注册**：入口表里的 `routes` 是真源（后端已裁决冲突、
     * 且据此把该插件标为不可推迟加载）。这里再挡一道"该 id 是否真在本插件的生效声明里"——
     * 否则插件可以注册一个它没声明过的 id，而后端从未为它把产物标成"必须加载"，
     * 于是那个页面在某些加载路径下会是空白（与 `slots` 的次判据完全同一条理由）。
     *
     * 放宽的情形：入口表**没有** `routes` 键（后端在空值时省略）⇒ 说明该插件未声明路由 ⇒ 拒绝。
     * 但纯浏览器侧注册的插件（不在后端 owners 里）会因此被拒——这是**刻意的**：
     * 路由参与"要不要加载这个产物"的决策，不走声明的路由没有加载保证，
     * 允许它注册只会制造"有时能打开、有时打不开"的不确定。
     */
    registerRoute: (id, component) => {
      const declared = meta.routes ?? []
      if (!declared.some((r) => r.id === id)) {
        console.warn(
          `[geewiki-plugin-ui] 插件 ${name} 尝试注册未声明的路由 "${id}"，已忽略` +
            `（该插件生效路由：${declared.map((r) => r.id).join(', ') || '无'}）。` +
            '路由必须先在 package.json#geewiki.routes 里声明，否则宿主没有加载该产物的依据。',
        )
        return () => {}
      }
      const off = registerRoute(id, component, name)
      disposers.push(off)
      return off
    },
    unregisterRoutes: (source) => unregisterRoutes(source),
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
  // 成功即自愈：清掉这个插件此前可能留下的失败记录，否则提示条会在问题已解决后继续挂着
  failedLoads.delete(name)
  emitState()
  console.debug(`[geewiki-plugin-ui] 已加载插件界面：${name}`)
}

/** 卸载某插件的界面贡献（注销插槽注册 + 移除 CSS）。ESM 模块本身无法从模块图中卸载。 */
export function unloadPluginUi(name: string): boolean {
  // 无论此前是否真的加载过，都要推进代次：可能有在途 import 尚未结算
  epochs.set(name, (epochs.get(name) ?? 0) + 1)
  /*
    失败记录**先清**（且不看 loaded 里有没有）：插件被停用/移出入口表之后，
    "它的界面加载失败"这条提示就过期了 —— 留着会让用户对着一条无法处理的红字。
    若是 rev 变化导致的重试，紧接着的加载失败会重新写入，语义仍然正确。
  */
  const hadFailure = failedLoads.delete(name)
  const entry = loaded.get(name)
  if (!entry) {
    if (hadFailure) emitState()
    return false
  }
  for (const off of entry.disposers.splice(0)) {
    try {
      off()
    } catch (err) {
      console.debug(`[geewiki-plugin-ui] 注销 ${name} 的插槽注册时出错：`, err)
    }
  }
  entry.link?.remove()
  loaded.delete(name)
  emitState()
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
export interface PluginUiSyncRequest {
  /**
   * 强制拉取完整表、**不用** `If-None-Match` 短路。
   *
   * 为什么需要它：整表 `revision` 只覆盖 `plugins`（已激活 ∩ 有界面 ∩ 产物存在），
   * **不含 `skipped`**。所以"新装了一个未启用（或没有前端界面）的插件"这类变化不会改变
   * `revision`，走 304 短路就永远看不到它。管理台要看这种信息时必须强制一次；
   * 轮询/可见性触发的常规同步不需要（省掉无谓请求）。
   */
  force?: boolean
}

export function syncPluginUi(options: PluginUiSyncRequest = {}): Promise<void> {
  if (inflight) {
    if (options.force !== true) return inflight
    // 强制同步不能被单飞吞掉：等在途这次结算后再无条件下拉一次完整表。
    // 此时 inflight 已被 finally 置空，故这次递归不会再次命中本分支。
    const again = (): Promise<void> => syncPluginUi({ force: true })
    return inflight.then(again, again)
  }
  const run = doSync(options.force === true).finally(() => {
    inflight = null
  })
  inflight = run
  return run
}

async function doSync(force: boolean): Promise<void> {
  const sdk = hostSdk()
  if (!sdk) {
    console.warn('[geewiki-plugin-ui] 宿主 SDK 未初始化，跳过插件界面加载')
    return
  }
  const url = new URL(PLUGIN_UI_TABLE_PATH, window.location.origin).href
  // 只有"已收敛"时才敢用 304 短路（否则可能永久漏加载，见 isSettled 的说明）；force 时一律不用
  const useEtag = !force && lastRevision !== undefined && isSettled()
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
  lastSkipped = Object.freeze(table.skipped)
  // 路由快照紧随入口表重建（F2）：导航项来自声明，必须在 bundle 加载**之前**就可见
  rebuildRoutes()

  /*
   * 取权威插槽仲裁（与入口表**并行**，不额外增加一轮往返）。
   * 失败时**保留上一次的值**（不重置）：一次网络抖动不该让被抑制者趁机注册进去。
   */
  try {
    const slotRes = await fetch(new URL(SLOT_TABLE_PATH, window.location.origin).href)
    if (slotRes.ok) {
      const parsed = parseSuppressedOwners(await slotRes.json())
      if (parsed) suppressedOwners = parsed
      else console.debug('[geewiki-plugin-ui] 插槽仲裁响应不可信，沿用上一次结果')
    }
  } catch (err) {
    console.debug('[geewiki-plugin-ui] 插槽仲裁请求失败，沿用上一次结果：', err instanceof Error ? err.message : err)
  }
  // 先广播"跳过项变了"：即使随后没有任何 load/unload（这是常见情形——例如只是新装了一个
  // 未启用插件），管理台也要能立刻看到新的 skipped。
  emitState()
  const loadedRevs = new Map([...loaded].map(([name, entry]) => [name, entry.rev]))

  // 重算推迟集合：只有**非空且全部是 editor** 的生效插槽才推迟（理由见 isLazyOnlyEntry）。
  // 每次都整体重算（而不是增量维护）——入口表就是真源，增量维护只会多一份可能漂移的账。
  deferred.clear()
  deferredEntries.clear()
  for (const [name, meta] of Object.entries(table.entries)) {
    if (isLazyOnlyEntry(meta)) {
      deferred.set(name, meta.rev)
      deferredEntries.set(name, meta)
    }
  }

  const plan = planUiSync(table.entries, loadedRevs, new Set(deferred.keys()))
  // 先卸后装：产物更新的插件会同时出现在两个数组里（rev 变化），换新代码前必须先回收旧注册
  for (const name of plan.unload) unloadPluginUi(name)
  for (const name of plan.load) {
    const meta = table.entries[name]
    if (meta) await loadPluginUi(name, meta, sdk)
  }
}

/**
 * 按需加载**被推迟**的插件界面，直到 `slot` 有贡献者为止（幂等、单飞）。
 *
 * 调用方：宿主在真正要渲染某个按需插槽之前（当前只有 `editor`，见 `WikiPage` 的编辑视图）。
 * 返回的 promise 结算后，插槽注册表**可能**已经有了贡献者——调用方据此重渲染
 * （`slots.tsx` 的 `useEditorSlot` 走 `useSyncExternalStore`，注册发生时自动触发）。
 *
 * 为什么需要"同步一次再加载"：推迟决定是基于**某一次**入口表快照做的，而插件可能在
 * 这期间被启用/停用。先 `syncPluginUi()` 把快照对齐，再按新的推迟集合加载，才不会
 * 加载一个已被停用的插件、也不会漏掉刚启用的那个。
 *
 * 单飞的理由与 `syncPluginUi` 相同：编辑视图挂载与用户手动刷新可能同时打过来。
 */
export function ensureSlotLoaded(slot: BuiltinSlotName): Promise<void> {
  const existing = onDemandInflight.get(slot)
  if (existing) return existing
  const run = (async () => {
    // 先把入口表对齐（可能带 304 短路，代价极小），确保 deferredEntries 是最新的
    await syncPluginUi()
    const sdk = hostSdk()
    if (!sdk) return
    for (const [name, meta] of [...deferredEntries]) {
      // 已被别处加载/卸载的跳过；只看"当前仍被推迟且仍需要"的
      if (loaded.has(name) || !(name in desired)) continue
      if (meta.slots === undefined || !meta.slots.includes(slot)) continue
      await loadPluginUi(name, meta, sdk)
    }
  })().finally(() => {
    onDemandInflight.delete(slot)
  })
  onDemandInflight.set(slot, run)
  return run
}

/** 当前被推迟（尚未加载，等按需触发）的插件名。排障与测试断言用。 */
export function deferredPluginUi(): string[] {
  return [...deferred.keys()].sort()
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
      /** 当前被推迟（等按需触发）的插件名，供懒加载验收断言 */
      deferred: () => string[]
      /** 按需加载某插槽的贡献者（幂等、单飞），供懒加载验收直接驱动 */
      ensureSlot: (slot: BuiltinSlotName) => Promise<void>
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
  deferred: deferredPluginUi,
  ensureSlot: ensureSlotLoaded,
}
