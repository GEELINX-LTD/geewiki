import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
/*
  ⚠️ 这里与 `pluginUi.ts` 是**双向 import**（那边要 `registerSlotByName`），刻意接受：
  两边的引用都只发生在**函数体内**（本文件只在渲染时读失败清单，那边只在加载完成时注册插槽），
  而 `pluginUiFailed` / `subscribePluginUiState` 都是函数声明（提升），故模块求值顺序无关、
  不存在 TDZ 风险。拆成第三个模块只会把"失败记录"这份状态的所有权切碎。
*/
import { pluginUiFailed, subscribePluginUiState } from './pluginUi'

/**
 * 前端插槽注册表：插件通过宿主 SDK 把 UI 组件注册到命名插槽，宿主在固定位置渲染 `<SlotOutlet>`。
 *
 * 设计要点：
 * - 注册返回**注销函数**，插件卸载时可精确回滚自己的贡献（不误伤其它插件）。
 * - 同一插槽可有多个来源的组件；每个组件外包一层错误边界，某个插件抛错不影响其它插件与宿主。
 * - 通过 `useSyncExternalStore` 订阅注册表变更，注册/注销即时反映到界面。
 * - `app-header` / `app-footer` 是**零属性**插槽：宿主不向插件传数据，避免跨版本契约耦合。
 *   这条隔离裁决**未被推翻**，也不应被推翻。
 * - `editor` 是**带数据的单占用**插槽：编辑器场景本质上需要正文与保存回调，没有数据插件做不了
 *   编辑器。故它是一个**显式窄契约**（{@link EditorSlotProps}），字段逐个人工审定，
 *   且**刻意没有** `[k: string]: unknown` 逃生口——加字段必须显式改类型，必然经过一次评审。
 *
 * ## 与 core 的关系：这是一份**必要的镜像**
 * web 不能 import `@geewiki/core`（其顶层 `import 'node:fs'`，进不了浏览器 bundle），
 * 所以 `SlotName` 与 `EditorSlotProps` 在这里各有一份副本。两处一致性由守卫测试钉住
 * （manager 侧的插槽名守卫 + `packages/web/test/editorSlotProps.test.ts` 的字段守卫），
 * 照 `PLUGIN_UI_FILE_SEGMENT` / `DegradedReason` 的既有做法。
 */
export type SlotName = 'app-header' | 'app-footer' | 'editor'

/** 当前宿主暴露的插槽白名单；插件传未知插槽名会被忽略并告警。 */
export const SLOT_NAMES: readonly SlotName[] = ['app-header', 'app-footer', 'editor']

/** 零属性插槽：宿主**不**向插件传任何数据。 */
export type ZeroPropsSlotName = 'app-header' | 'app-footer'

export type SlotComponent = ComponentType<Record<string, never>>

/**
 * `editor` 插槽的 props —— **前端镜像**，与 `packages/core/src/index.ts` 的 `EditorSlotProps` 逐字对应。
 *
 * 语义（设计理由见 core 的 JSDoc，此处不重复）：
 * - `value` 是**受控值**，由宿主持有；插件只读，通过 `onChange` 回传。
 * - `mode === 'create'` 时 `slug` 可能是空串/尚未确定，插件不得假定它合法或非空。
 * - `readOnly` 为真时插件应禁用编辑并隐藏保存入口。
 * - 保存/冲突检测/落库**全部由宿主负责**，插件不直接写数据库。
 */
export interface EditorSlotProps {
  /** 当前正文 Markdown 源文（受控值：由宿主持有，插件只读 + 通过 onChange 回传） */
  readonly value: string
  /** `create` = 新建页面的空编辑器；`edit` = 编辑既有页面 */
  readonly mode: 'create' | 'edit'
  /** 目标页面标识（`mode === 'create'` 时可能为空串或尚未确定） */
  readonly slug: string
  /** 只读预览（如查看历史快照）：为 true 时插件应禁用编辑并隐藏保存入口 */
  readonly readOnly?: boolean
  /** 正文变更回传（宿主据此维护草稿/脏值判定） */
  onChange(next: string): void
  /** 请求保存（宿主负责校验、冲突检测与落库；插件不直接写数据库） */
  onSave(): void
  /** 请求取消编辑（宿主负责未保存确认） */
  onCancel(): void
}

export type EditorSlotComponent = ComponentType<EditorSlotProps>

/** 插槽名 → 该插槽的组件类型。`registerSlot` 据此做**按名区分**的类型检查。 */
export interface SlotComponentMap {
  'app-header': SlotComponent
  'app-footer': SlotComponent
  editor: EditorSlotComponent
}

/** 注册表内部存储用的联合类型（对外始终经由 {@link SlotComponentMap} 约束）。 */
export type AnySlotComponent = SlotComponent | EditorSlotComponent

/**
 * 单占用插槽：同一时刻只有一个贡献生效。
 * 与 core 的 `SLOT_CARDINALITY` 是同一份事实的两个镜像（core 那里还带 `multi` 的那些）。
 */
export const SINGLE_OCCUPANCY_SLOTS: readonly SlotName[] = ['editor']

export interface SlotEntry {
  readonly component: AnySlotComponent
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
 *
 * 类型按插槽名区分：`registerSlot('editor', …)` 的组件必须接收 {@link EditorSlotProps}，
 * `registerSlot('app-header' | 'app-footer', …)` 仍必须是零属性组件。
 * **不使用 `any`/`Record<string, unknown>` 放宽**——那会让契约漂移失去类型层面的拦阻。
 *
 * 插件 bundle 只能拿到**字符串**插槽名（它不参与本仓库的类型检查），那条路径走
 * {@link registerSlotByName}：先运行期校验名字，再委托到这里。
 */
export function registerSlot<K extends SlotName>(
  name: K,
  component: SlotComponentMap[K],
  source?: string,
): () => void
export function registerSlot(name: SlotName, component: AnySlotComponent, source?: string): () => void
export function registerSlot(name: SlotName, component: AnySlotComponent, source = 'host'): () => void {
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
 * **运行期名称**的注册入口：插件 bundle 传进来的是普通字符串，必须先校验再委托。
 *
 * 与 {@link registerSlot} 的分工：后者靠类型保证（宿主自己的代码），前者靠运行期校验
 * （不可信来源）。未知插槽名忽略并告警、返回空操作注销函数——与既有"不阻断插件加载"一致。
 */
export function registerSlotByName(name: string, component: AnySlotComponent, source = 'host'): () => void {
  if (!isSlotName(name)) {
    console.warn(`[geewiki-slot] 未知插槽名 "${name}"，已忽略（可用：${SLOT_NAMES.join(', ')}）`)
    return () => {}
  }
  return registerSlot(name, component, source)
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
  /*
    插件界面**加载期**失败的可见提示（本批 T4）。
    为什么必须在这里渲染：失败发生在 `loadPluginUi` 的 import 阶段 —— 那时**没有任何插槽注册**，
    所以这一块此前是彻底沉默的：用户只看到"某个功能不见了"（页脚少一块、编辑器退回纯文本），
    既不知道原因也不知道下一步。`pluginUiFailed()` 是引用稳定的快照，配合同一个 store 的订阅，
    失败一发生这里就会重渲染。
    文案刻意给出**可执行的下一步**（去插件管理检查），而不是只说"加载失败"。
  */
  const failures = useSyncExternalStore(subscribePluginUiState, pluginUiFailed, pluginUiFailed)
  return (
    <div className="slot-outlet" data-slot={name} data-count={entries.length}>
      {failures.map((f) => (
        /*
          `data-*` 上带排障摘要（与上面错误边界的 `data-error` 同一形态），**不放进可见文案**：
          原始串可能是英文/含路径，`lib/errorText.ts` 的 `cleanHint` 之所以拦掉它们，
          就是为了不让界面出现这种文本。用户看到的是下一行的固定中文句子。
        */
        <p key={f.name} className="slot-error" role="status" data-plugin-ui-failed={f.name} data-error={f.message}>
          {`插件界面「${f.name}」加载失败，相关功能在本页不可用。作者可能漏发产物，请在插件管理中检查。`}
        </p>
      ))}
      {entries.map((entry, index) => {
        // 零属性出口：这里只渲染 app-header / app-footer 这类零属性插槽，
        // 但注册表内部存的是联合类型，故收窄一次（editor 走 EditorSlotOutlet）。
        const Zero = entry.component as SlotComponent
        return (
          <SlotErrorBoundary key={`${entry.source}#${index}`} source={entry.source}>
            <Zero />
          </SlotErrorBoundary>
        )
      })}
    </div>
  )
}

/* ============================ editor（带数据的单占用插槽） ============================ */

/**
 * 当前的 `editor` 贡献者（无贡献时 undefined）。
 *
 * **单占用取"最早注册"的一条**：这与后端 `resolveSlots` 的裁决规则（激活顺序最早者胜出）
 * 同向——但前端**不以此为准**。权威裁决在后端：入口表只把**生效**的插槽写进
 * `plugins[name].slots`，而 `pluginUi.ts` 的宿主包装会**拒绝**注册未获生效的插槽。
 * 因此正常情况下这里最多只有一条；`entries[0]` 只是"万一有两条"时的确定性兜底。
 */
export function editorEntry(): SlotEntry | undefined {
  return entriesOf('editor')[0]
}

/** `editor` 插槽是否有生效贡献（稳定引用：供 `useSyncExternalStore` 直接使用）。 */
export function editorEntrySnapshot(): SlotEntry | undefined {
  return entriesOf('editor')[0]
}

/** 订阅 `editor` 贡献变化，返回当前贡献者。宿主据此决定"渲染插件编辑器还是内置编辑器"。 */
export function useEditorSlot(): SlotEntry | undefined {
  return useSyncExternalStore(subscribe, editorEntrySnapshot, () => undefined)
}

/**
 * `editor` 插槽出口：把宿主持有的编辑态作为 props 交给**生效的那一个**编辑器插件。
 *
 * 与 {@link SlotOutlet} 的差别：这是**单占用 + 带数据**的出口，故只渲染第一条，
 * 且必须由调用方提供完整的 {@link EditorSlotProps}（宿主是这些值的唯一持有者）。
 */
export function EditorSlotOutlet(props: EditorSlotProps): ReactNode {
  const entry = useEditorSlot()
  if (!entry) return null
  const Editor = entry.component as EditorSlotComponent
  return (
    <div className="slot-outlet" data-slot="editor" data-count={1} data-editor-source={entry.source}>
      <SlotErrorBoundary source={entry.source}>
        <Editor {...props} />
      </SlotErrorBoundary>
    </div>
  )
}
