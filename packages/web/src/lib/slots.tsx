import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'

/**
 * 前端插槽注册表：插件通过宿主 SDK 把 UI 组件注册到命名插槽，宿主在固定位置渲染 `<SlotOutlet>`。
 *
 * 设计要点：
 * - 注册返回**注销函数**，插件卸载时可精确回滚自己的贡献（不误伤其它插件）。
 * - 同一插槽可有多个来源的组件；每个组件外包一层错误边界，某个插件抛错不影响其它插件与宿主。
 * - 通过 `useSyncExternalStore` 订阅注册表变更，注册/注销即时反映到界面。
 * - 组件本身不接收 props（宿主不向插件传数据，避免跨版本契约耦合）。
 */
export type SlotName = 'app-header' | 'app-footer'

/** 当前宿主暴露的插槽白名单；插件传未知插槽名会被忽略并告警。 */
export const SLOT_NAMES: readonly SlotName[] = ['app-header', 'app-footer']

export type SlotComponent = ComponentType<Record<string, never>>

export interface SlotEntry {
  readonly component: SlotComponent
  /** 注册来源（插件名或 'host'），用于排障与注销 */
  readonly source: string
}

const EMPTY: readonly SlotEntry[] = Object.freeze([])
const registry = new Map<SlotName, readonly SlotEntry[]>()
const listeners = new Set<() => void>()

function isSlotName(name: string): name is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(name)
}

function emit(): void {
  // 复制一份再遍历：监听器在回调里可能触发注册/注销
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function entriesOf(name: SlotName): readonly SlotEntry[] {
  return registry.get(name) ?? EMPTY
}

/** 只读快照：供宿主自身与测试观察当前插槽占用情况。 */
export function slotSummary(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of SLOT_NAMES) out[name] = entriesOf(name).length
  return out
}

/**
 * 注册一个插槽组件，返回注销函数（幂等：重复调用只生效一次）。
 * 同一个插件重复注册同名插槽不会泄漏——每次调用都返回各自的注销函数。
 */
export function registerSlot(name: string, component: SlotComponent, source = 'host'): () => void {
  if (!isSlotName(name)) {
    console.warn(`[geewiki-slot] 未知插槽名 "${name}"，已忽略（可用：${SLOT_NAMES.join(', ')}）`)
    return () => {}
  }
  const entry: SlotEntry = { component, source }
  registry.set(name, [...entriesOf(name), entry])
  emit()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = registry.get(name)
    if (!current) return
    const next = current.filter((item) => item !== entry)
    if (next.length > 0) registry.set(name, next)
    else registry.delete(name)
    emit()
  }
}

/**
 * 注销插槽注册：
 * - 传入 token（registerSlot 的返回值）时只注销那一条；
 * - 不传 token 时清空该插槽的全部注册（插件加载失败/批量回滚时的兜底）。
 */
export function unregisterSlot(name: string, token?: unknown): void {
  if (!isSlotName(name)) return
  if (typeof token === 'function') {
    ;(token as () => void)()
    return
  }
  if (!registry.has(name)) return
  registry.delete(name)
  emit()
}

interface BoundaryState {
  error: string | null
}

/** 单个插件 UI 的错误边界：捕获渲染期异常，替换为占位块。 */
class SlotErrorBoundary extends Component<{ source: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[geewiki-slot] 插件界面渲染失败（来源：${this.props.source}）:`, error)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <span className="slot-error" data-slot-source={this.props.source} data-error={this.state.error}>
          插件界面渲染失败
        </span>
      )
    }
    return this.props.children
  }
}

/** 插槽出口：渲染该插槽下所有已注册组件（各自独立错误边界）。 */
export function SlotOutlet({ name }: { name: SlotName }): ReactNode {
  const entries = useSyncExternalStore(
    subscribe,
    () => entriesOf(name),
    () => EMPTY,
  )
  return (
    <div className="slot-outlet" data-slot={name} data-count={entries.length}>
      {entries.map((entry, index) => (
        <SlotErrorBoundary key={`${entry.source}#${index}`} source={entry.source}>
          <entry.component />
        </SlotErrorBoundary>
      ))}
    </div>
  )
}
