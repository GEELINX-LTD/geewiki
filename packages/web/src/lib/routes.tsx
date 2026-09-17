/**
 * 插件页面路由的**组件注册表**（F2）。
 *
 * ## 与清单声明的分工（不要合并）
 * - **清单**（`geewiki.routes`）声明 `id` / 导航元信息 / **"这个插件有页面"**；
 * - **本注册表**只登记**组件**，且必须按**清单里已声明的 id** 注册。
 *
 * 为什么不把导航元信息也搬到运行期：入口表要据此决定"要不要推迟加载该插件产物"
 * （见 `pluginUiPlan.ts` 的 `isLazyOnlyEntry`）——那是一个**在 bundle 加载之前**就要回答的问题，
 * 运行期注册回答不了（循环依赖）。于是导航信息只有清单一个真源，
 * 本模块只负责"把组件挂到那个 id 上"。
 *
 * ## 与 `slots.tsx` 同构
 * 注册返回**幂等注销函数**、按 owner 批量回收、`useSyncExternalStore` 订阅、
 * 每个页面外包一层错误边界。差别只有一处：插槽是"同一位置的多个贡献者"，
 * 路由是"一个 id 对应一个页面"，故注册是**先到先得**（后来者告警并被拒），不是叠加。
 */
import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { PLUGIN_ROUTE_ID, RESERVED_ROUTE_IDS } from './pluginUiPlan'

/**
 * 插件页面组件收到的属性。
 *
 * 与插槽 props 的"逐字段人工审定窄契约"不同，这里只有三个**通用**字段——原因很实际：
 * 页面是插件自己的地盘（不像插槽那样嵌在宿主界面里），宿主没有立场规定它该收到什么。
 * 宿主只提供"我在哪、怎么跳"，其余状态插件自己去 `api.ts` 取。
 */
export interface PluginRouteProps {
  /** hash 首段之后的部分（已去掉前导 `/`）：`#/my-page/a/b` → `'a/b'` */
  readonly sub: string
  /** 原始查询串（含 `?`，无则为空串）。交给页面自己解析——宿主不猜哪个参数对它有意义 */
  readonly query: string
  /** 统一 hash 跳转（宿主保证首尾斜杠规范化，与内置页面走同一条路） */
  readonly onNavigate: (path: string) => void
}

export interface RouteEntry {
  readonly id: string
  readonly component: ComponentType<PluginRouteProps>
  /** 注册来源（插件名或 'host'），用于排障与按 owner 回收 */
  readonly source: string
}

const registry = new Map<string, RouteEntry>()
const listeners = new Set<() => void>()
const EMPTY: readonly RouteEntry[] = Object.freeze([])

/**
 * 对外暴露的**稳定快照**（按 id 排序）。
 *
 * 必须在注册表变化时**整体替换**这个数组，而不是每次 `getSnapshot()` 现算：
 * `useSyncExternalStore` 要求数据未变时返回同一引用，现算会让 React 判定"每次都变了"
 * 并陷入无限重渲染（`slots.tsx` 那边靠"取 Map 里那个稳定数组"达到同一效果）。
 */
let snapshot: readonly RouteEntry[] = EMPTY

function rebuild(): void {
  snapshot = Object.freeze([...registry.values()].sort((a, b) => a.id.localeCompare(b.id)))
}

function emit(): void {
  rebuild()
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前全部已注册路由（稳定快照，按 id 排序）。 */
export function routeEntries(): readonly RouteEntry[] {
  return snapshot
}

/** 订阅路由注册表（React hook） */
export function useRouteEntries(): readonly RouteEntry[] {
  return useSyncExternalStore(subscribe, routeEntries, () => EMPTY)
}

/** 某个 id 是否已被注册（宿主据此决定渲染页面还是"未就绪"占位）。 */
export function registeredRoute(id: string): RouteEntry | undefined {
  return registry.get(id)
}

/**
 * 注册一个插件页面组件。返回**幂等的注销函数**。
 *
 * 校验（全部告警 + 拒绝，不抛）：id 语法非法、落在宿主保留 id 里、已被**别的**来源注册。
 * 同名重复注册**先到先得**：若允许后者覆盖，一个插件就能把另一个插件的页面顶掉，
 * 而用户只会看到"我的页面内容变了"——这与 `single` 插槽"先来的继续工作"是同一条裁决。
 */
export function registerRoute(
  id: string,
  component: ComponentType<PluginRouteProps>,
  source = 'host',
): () => void {
  if (typeof id !== 'string' || !PLUGIN_ROUTE_ID.test(id)) {
    console.warn(
      `[geewiki-route] 路由 id "${String(id)}" 非法，已忽略（须为小写 kebab 且不含 \`/\`）`,
    )
    return () => {}
  }
  if (RESERVED_ROUTE_IDS.includes(id)) {
    console.warn(
      `[geewiki-route] 路由 id "${id}" 是宿主保留路由，已忽略（插件不得覆盖内置页面）`,
    )
    return () => {}
  }
  const existing = registry.get(id)
  if (existing && existing.source !== source) {
    console.warn(
      `[geewiki-route] 路由 "${id}" 已由 ${existing.source} 注册，忽略 ${source} 的重复注册（先到先得）`,
    )
    return () => {}
  }
  const entry: RouteEntry = { id, component, source }
  registry.set(id, entry)
  emit()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // 只在自己仍是当前登记项时才删（避免"卸载旧实例"误删后来者的条目）
    if (registry.get(id) !== entry) return
    registry.delete(id)
    emit()
  }
}

/**
 * 注销某来源的**全部**路由（插件卸载/重载的统一出口）。
 *
 * 为什么按来源批量回收而不是逐个 token：插件可能注册多页，而卸载路径上拿不到那些 token
 * （它们散落在插件自己的闭包里）。这与 `HttpRouter.closeStreams(owner)`、
 * `SlotRegistry.release(owner)` 是同一条记账约定。
 */
export function unregisterRoutes(source: string): void {
  let changed = false
  for (const [id, entry] of [...registry]) {
    if (entry.source === source) {
      registry.delete(id)
      changed = true
    }
  }
  if (changed) emit()
}

/** 当前已注册路由的 id 列表（诊断/测试用） */
export function routeIds(): readonly string[] {
  return snapshot.map((entry) => entry.id)
}

/* ============================ 页面级错误边界 ============================ */

interface BoundaryState {
  error: string | null
}

/**
 * 单个插件页面的错误边界。
 *
 * 为什么比插槽那边更必要：页面是**整屏**的，一个未捕获的渲染异常若冒泡到根，
 * 用户看到的是整个应用白屏（连导航都没了，无法自救）。这里退化成一块"这一页坏了"
 * 的占位——导航仍在，用户能走开。
 */
class RouteErrorBoundary extends Component<{ source: string; id: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[geewiki-route] 插件页面渲染失败（${this.props.id}，来源：${this.props.source}）:`, error)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="route-error" data-route={this.props.id} data-error={this.state.error} role="alert">
          {`插件页面「${this.props.id}」渲染失败，其功能在本页不可用。请在「插件管理」页检查该插件状态。`}
        </div>
      )
    }
    return this.props.children
  }
}

/** 渲染一个已注册的插件页面（带错误边界）。未注册时由调用方决定占位。 */
export function PluginRouteOutlet({ entry, props }: { entry: RouteEntry; props: PluginRouteProps }): ReactNode {
  const Page = entry.component
  return (
    <RouteErrorBoundary source={entry.source} id={entry.id}>
      <Page {...props} />
    </RouteErrorBoundary>
  )
}
