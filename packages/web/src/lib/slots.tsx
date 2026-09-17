import {
  Component,
  useCallback,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type ComponentType,
  type DragEvent,
  type ReactNode,
} from 'react'
/*
  ⚠️ 这里与 `pluginUi.ts` 是**双向 import**（那边要 `registerSlotByName`），刻意接受：
  两边的引用都只发生在**函数体内**（本文件只在渲染时读失败清单，那边只在加载完成时注册插槽），
  而 `pluginUiFailed` / `subscribePluginUiState` 都是函数声明（提升），故模块求值顺序无关、
  不存在 TDZ 风险。拆成第三个模块只会把"失败记录"这份状态的所有权切碎。
*/
import {
  pluginUiDeclaredFor,
  pluginUiFailed,
  pluginUiFailedFor,
  subscribePluginUiState,
  type PluginUiFailure,
} from './pluginUi'
/*
  ⚠️ 插槽白名单**不再是本文件的副本**：单一真源是 `@geewiki/core/slots`（core 的浏览器安全
  子路径，见 `packages/core/src/slots.ts`）。本文件只做转出，供 web 内部与插件 SDK 使用。

  为什么可以这么做了：core 的顶层 `import 'node:fs'` 进不了浏览器 bundle 是"必须手抄镜像"
  的**唯一**原因；把这份纯常量拆到独立文件并开一个子路径导出之后，这个原因就不存在了。
  改造前这里有 4 份同一事实的副本（本文件的白名单、`pluginUiPlan.ts` 的白名单、
  本文件的 `SINGLE_OCCUPANCY_SLOTS`、core 的 `SLOT_CARDINALITY`）。现在 0 份。
  回归由 `packages/core/test/slots-browser-safe.test.ts` 钉住。
*/
import {
  PLUGIN_SLOT_NAME,
  SLOT_CARDINALITY,
  SLOT_NAMES,
  isBuiltinSlotName,
  isPluginSlotName,
  type BuiltinSlotName,
  type SlotName,
} from '@geewiki/core/slots'
/* ★ F5：`PageVisibility` 与 `EditorSlotProps.blockTiers` 同刻度，真源在 core 的浏览器安全子路径 */
import type { PageVisibility } from '@geewiki/core/domain'

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
 * - `editor-toolbar`（**多占用 + 带数据**，{@link EditorToolbarSlotProps}）沿用同一条
 *   "具名窄契约"路线：插件要能读选区、要能请求写回，但**拿不到任意宿主状态**。
 *   这个位置是 AI 类界面的落点（辅助写作工具条），宿主只提供位置与数据，
 *   **不提供任何 AI 文案**——插件停用后那块位置就整体消失，不会留下与插件名绑定的死文案。
 *   原先还有一个 `wiki-ask`（单占用 + 带数据）搭在 `#/wiki/ask/<q>` 路由上，**P8 已拆除**
 *   （决策 17：对话的唯一入口是 `app-dock`）。
 *
 * ## 与 core 的关系：白名单是**转出**，不再是副本
 * 插槽名与基数（`BuiltinSlotName` / `SLOT_NAMES` / `SLOT_CARDINALITY` / `PLUGIN_SLOT_NAME`）
 * 的真源在 `@geewiki/core/slots`，本文件 import 后原样转出。
 *
 * 这里曾经写的是"web 不能 import `@geewiki/core`（其顶层 `import 'node:fs'`），
 * 所以必须手抄一份副本、靠守卫测试钉住"。那句话在当时是对的，**现在是错的**：
 * core 把这份纯常量拆到了 `src/slots.ts` 并开了 `./slots` 子路径导出，浏览器可直接消费。
 * 保留这段历史的价值在于提醒：**"不能 import"是当时结构的结果，不是物理定律** ——
 * 一旦有人把 Node 依赖挪回 `slots.ts`，镜像就会被迫长回来
 * （故 `packages/core/test/slots-browser-safe.test.ts` 以源码级断言钉死这条约束）。
 *
 * 仍留在本文件的是**前端自己的**决策，不是 core 的事实：
 * {@link EditorSlotProps} 等各插槽 props 的渲染用类型（编辑器那份与 core 对偶，
 * 由 `packages/web/test/editorSlotProps.test.ts` 守卫）、以及 {@link SINGLE_OCCUPANCY_SLOTS}。
 *
 * ## 从"7 个格子"到"开放键空间"（A1 批次）
 * {@link SLOT_NAMES} 里的 7 个是**宿主固定渲染点**（{@link BuiltinSlotName}），编译期枚举、
 * 类型安全。此外插件可以**自己开扩展点**：名字须含 `/`（见 {@link PLUGIN_SLOT_NAME}），
 * 由插件在自己的界面里用 {@link PluginSlotOutlet} 渲染。
 * 这样"插件能不能扩展"不再取决于宿主预先挖了几个坑——而是插件之间自己去约定。
 *
 * 为什么用 `/` 而不是"任意字符串"：内置名一律不含 `/`，于是含 `/` 的一定是自定义扩展点，
 * 不含 `/` 又不在白名单里的就是**笔误**，仍然告警。开放键空间没有牺牲拼写错误的可见性。
 */
/*
 * 白名单与判定函数**由 core 转出**（真源唯一，见文件头的说明）。
 *
 * 这里同时转出给 web 内部各消费点与宿主 SDK 使用，故既有
 * `import { SLOT_NAMES, isBuiltinSlotName } from '../lib/slots'` 的调用点无需改动。
 *
 * 注：A1 批次新增的那对 `Expect<A extends B>` 编译期镜像守卫（本文件 ↔ `pluginUiPlan.ts`）
 * 已随镜像一起删除 —— 没有了第二份事实，就没有需要同步的东西。
 */
export {
  PLUGIN_SLOT_NAME,
  SLOT_CARDINALITY,
  SLOT_NAMES,
  isBuiltinSlotName,
  isPluginSlotName,
}
export type { BuiltinSlotName, SlotName }

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
  /*
   * ★ F5：以下五个与 core 的 `EditorSlotProps` **逐字对应**（含可选性），
   * 守卫 `packages/web/test/editorSlotProps.test.ts` 钉住字段名与可选性两侧一致。
   * 语义与设计理由见 core 的 JSDoc，此处不重复。
   */
  onUploadFiles?(files: File[]): Promise<string[]>
  blockTiers?: { readonly pageVisibility: PageVisibility | null } | null
  onManageBlockGrants?(block: { readonly ordinal: number; readonly excerpt: string }): void
  onSelectionChange?(selection: EditorToolbarSelection | null): void
  onEditorHandle?(handle: EditorHandle | null): void
}

/**
 * ★ F5：编辑器命令式写回契约 —— **前端镜像**，与 core 的 `EditorHandle` 逐字对应。
 * 语义见 core 的 JSDoc（`insertAtCursor` 有选区时替换选区；两者都要可一次撤销）。
 */
export interface EditorHandle {
  insertAtCursor(text: string): void
  replaceSelection(text: string): boolean
  /** AI 回退用（整篇替换）。**可选**：不实现则 AI 回退在该编辑器上不可用 */
  setDoc?(text: string): void
}

export type EditorSlotComponent = ComponentType<EditorSlotProps>

/** 编辑页选区（`editor-toolbar` 用）：`from`/`to` 是文档内 0 基字符偏移。**core 的镜像** */
export interface EditorToolbarSelection {
  readonly text: string
  readonly from: number
  readonly to: number
}

/**
 * `editor-toolbar` 插槽的 props —— **前端镜像**，与 core 的 `EditorToolbarSlotProps` 逐字对应
 * （守卫：`packages/web/test/slotPropsMirror.test.ts`）。
 *
 * 与 `editor` 的差别：这里**不替换**编辑区，宿主内置编辑器仍在场；`insertAtCursor` /
 * `replaceSelection` **可选**——`editor` 被插件编辑器占住时宿主没有写回通道，届时它们
 * 是 `undefined`（而不是骗人的空函数），插件据此禁用写回并说明原因。
 */
export interface EditorToolbarSlotProps {
  readonly mode: 'create' | 'edit'
  readonly slug: string
  /** 当前正文全文（`summarize` 一类动作需要整篇） */
  readonly docText: string
  readonly selection: EditorToolbarSelection | null
  readonly readOnly?: boolean
  insertAtCursor?(text: string): void
  replaceSelection?(text: string): void
}

export type EditorToolbarSlotComponent = ComponentType<EditorToolbarSlotProps>

/**
 * `app-dock` 插槽的 props —— **前端镜像**，与 `packages/core/src/index.ts` 的
 * `AppDockSlotProps` 逐字段对应（`slotPropsMirror.test.ts` 的源码级守卫钉住）。
 *
 * 语义（设计理由见 core 的 JSDoc，此处不重复）：
 * - `page` 为 `null` 是**合法**状态（列表 / 图谱 / 管理台），插件不得回落到"上一次的 slug"；
 * - `clientTools` 是**宿主登记的**可调用名单，不是插件自己拼的；
 * - `invokeTool` 对未登记的名字必须拒绝——权限判据在宿主，不在调用方。
 */
export interface AppDockSlotProps {
  readonly page: {
    readonly slug: string
    /* 只有两种取值（core 侧同一份事实的镜像）—— 宿主实际只产出这两种，见 lib/dockPlan.ts */
    readonly kind: 'view' | 'edit'
  } | null
  readonly clientTools: readonly string[]
  /** 当前登录用户 id；`null` = 未登录（宿主此时根本不渲染本插槽）。插件据此给本地会话分键 */
  readonly userId: number | null
  openPage(slug: string): void
  invokeTool(name: string, args: unknown): Promise<unknown>
}

export type AppDockSlotComponent = ComponentType<AppDockSlotProps>

/**
 * `article-summary` 插槽的 props —— **前端镜像**，与 `packages/core/src/index.ts` 的
 * `ArticleSummarySlotProps` 逐字段对应（`slotPropsMirror.test.ts` 的源码级守卫钉住）。
 *
 * 只有两个字段，而且**都不是摘要本身**：摘要是插件服务端的事，宿主只知道
 * "这是哪一页、它叫什么"。在宿主侧放一个 `summary` 字段就等于把"取摘要"
 * 从插件搬进宿主，而这个插槽的整个意义是**摘要归插件**。
 */
export interface ArticleSummarySlotProps {
  /** 当前文章 slug（宿主路由的真源；插件不得自行解析 hash） */
  readonly slug: string
  /** 当前文章的标题（宿主此刻渲染的那一份） */
  readonly title: string
}

export type ArticleSummarySlotComponent = ComponentType<ArticleSummarySlotProps>

/** 插槽名 → 该插槽的组件类型。`registerSlot` 据此做**按名区分**的类型检查。 */
/**
 * `account-identities` 插槽的 props。
 *
 * 为什么要给这一块传数据（它本来可以是零属性的）：唯一的输入是**路由上的提示**
 * `?link=required`（SSO 回跳后"这个身份要不要绑到当前账号"）。这个提示属于**路由**，
 * 而路由归宿主；插件是独立构建的产物，让它去读 `window.location` 会让"插件不碰路由"
 * 这条纪律出现第一个例外（守卫 `pluginUi.test.ts` 明令禁止）。宿主读、宿主传，
 * 插件只管画——身份列表本身仍然由插件自己按会话取（那是它的数据，不是宿主的）。
 *
 * `linkPending` 可选：缺省（宿主没传/不是这次回跳）就是不显示确认卡片。
 */
export interface AccountIdentitiesSlotProps {
  readonly linkPending?: boolean
}

export type AccountIdentitiesSlotComponent = ComponentType<AccountIdentitiesSlotProps>

export interface SlotComponentMap {
  'app-header': SlotComponent
  'app-footer': SlotComponent
  editor: EditorSlotComponent
  'editor-toolbar': EditorToolbarSlotComponent
  'app-dock': AppDockSlotComponent
  'article-summary': ArticleSummarySlotComponent
  /** 带 props：提示（`?link=required`）由宿主给，名单由插件自己取（见 `AccountIdentitiesSlotProps`） */
  'account-identities': AccountIdentitiesSlotComponent
}

/** 注册表内部存储用的联合类型（对外始终经由 {@link SlotComponentMap} 约束）。 */
export type AnySlotComponent =
  | SlotComponent
  | EditorSlotComponent
  | EditorToolbarSlotComponent
  | AppDockSlotComponent
  | ArticleSummarySlotComponent
  | AccountIdentitiesSlotComponent

/**
 * 单占用插槽：同一时刻只有一个贡献生效。
 *
 * **从 core 的 {@link SLOT_CARDINALITY} 现算**，不再手抄 —— 这里曾经是同一份事实的
 * 第四份副本（另三份：core 的表、本文件的白名单、`pluginUiPlan.ts` 的白名单）。
 * 手抄的漂移是静默的：core 把某插槽改成 `single` 而这里没跟上 ⇒ 前后端对
 * "同时能生效几个"的判断不一致，表现为"两个插件都渲染出来了"或"本该显示的没显示"，
 * 且没有任何报错。
 *
 * `editor` 属于"两个同时渲染没有意义"的位置：两个编辑器同时渲染不是丰富，是坏掉。
 * `app-dock` 同理：屏幕底部叠两条一模一样的输入框同样是坏掉。
 * `article-summary` 再多一层理由：两份摘要不只是重复，**它们可能互相矛盾**
 * （来自两次不同的生成），而读者没有任何办法判断该信哪一份。
 */
export const SINGLE_OCCUPANCY_SLOTS: readonly BuiltinSlotName[] = SLOT_NAMES.filter(
  (name) => SLOT_CARDINALITY[name] === 'single',
)

export interface SlotEntry {
  readonly component: AnySlotComponent
  /** 注册来源（插件名或 'host'），用于排障与注销 */
  readonly source: string
}

const EMPTY: readonly SlotEntry[] = Object.freeze([])
const registry = new Map<SlotName, readonly SlotEntry[]>()
const listeners = new Set<() => void>()

/** 名字是否可接受：内置 ∪ 插件自定义扩展点语法（**不含**"任意字符串"这条退路）。 */
function isSlotName(name: string): name is SlotName {
  return isBuiltinSlotName(name) || isPluginSlotName(name)
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
  // 自定义扩展点也要报出来，否则"插件开了扩展点但当前无人贡献"在快照里完全不可见，
  // 排障时看不出这个扩展点存在（内置在前、自定义按字典序附在其后）。
  for (const name of [...registry.keys()].filter((n) => !isBuiltinSlotName(n)).sort()) {
    out[name] = entriesOf(name).length
  }
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
export function registerSlot<K extends BuiltinSlotName>(
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
    console.warn(
      `[geewiki-slot] 未知插槽名 "${name}"，已忽略（内置：${SLOT_NAMES.join(', ')}；` +
        '自定义扩展点须形如 "命名空间/名字"：小写 kebab 且至少含一个 `/`）',
    )
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

/** 插槽出口：渲染该插槽下所有已注册组件（各自独立错误边界）。**宿主固定渲染点**。 */
export function SlotOutlet({ name }: { name: BuiltinSlotName }): ReactNode {
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
          {`插件界面「${f.name}」加载失败，相关功能在本页不可用。作者可能漏发产物，请在「依赖图」页检查。`}
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

/* ==================== 插件自定义扩展点出口（A1：把"格子"交给插件自己开） ==================== */

/**
 * **插件自定义扩展点的出口**：插件在自己的界面里调用它，把一块区域开放给别的插件扩展。
 *
 * ## 与 {@link SlotOutlet} 的分工
 * 后者只服务**宿主固定渲染点**（名字类型是 {@link BuiltinSlotName}，宿主写错编译不过）。
 * 这个出口接受任意**合法的自定义扩展点名**（含 `/`），把 `props` 原样转发给每个贡献者。
 *
 * ## 为什么 props 是 `Record<string, unknown>` 而不是窄契约
 * 宿主**没有听说过**这个扩展点，自然无法为它定义数据结构。要给自定义扩展点也套一层
 * "props Schema"只会把刚打开的自由度又收回去，且与"扩展点契约是插件之间的事"这一事实不符。
 * 内置插槽之所以有逐字段人工审定的窄契约，是因为它们是**宿主的**界面位置——
 * 两种情形不同，故不强行统一。
 *
 * @param name 扩展点名（须含 `/`；与 `slot.define()` / manifest `slots` 里写的是**同一个字符串**）
 * @param props 转发给每个贡献组件的属性；不传即零属性
 * @param single 声明为单占用时传 `true`：只渲染**第一条**贡献。*
 *   *裁决不在前端重复做*——声明者知道自己的基数，在声明处与渲染处保持一致即可，
 *   否则就会出现"后端已抑制、前端仍渲染"的两套真相。
 */
export function PluginSlotOutlet({
  name,
  props,
  single = false,
}: {
  name: string
  props?: Record<string, unknown>
  single?: boolean
}): ReactNode {
  const entries = useSyncExternalStore(
    subscribe,
    () => entriesOf(name),
    () => EMPTY,
  )
  if (isBuiltinSlotName(name) || !isPluginSlotName(name)) {
    // 传内置名或非法名都是**用错 API**：明确报出来，不静默渲染成一个空 div
    return (
      <span className="slot-error" data-plugin-slot-invalid={name}>
        {`扩展点名 "${name}" 不可用于 PluginSlotOutlet：它只接受形如 "命名空间/名字" 的自定义扩展点（内置插槽由宿主在固定位置渲染）`}
      </span>
    )
  }
  const rendered = single ? entries.slice(0, 1) : entries
  return (
    <div className="slot-outlet" data-slot={name} data-count={rendered.length}>
      {rendered.map((entry, index) => {
        const C = entry.component as ComponentType<Record<string, unknown>>
        return (
          <SlotErrorBoundary key={`${entry.source}#${index}`} source={entry.source}>
            <C {...(props ?? {})} />
          </SlotErrorBoundary>
        )
      })}
    </div>
  )
}

/**
 * 某扩展点当前的贡献者名单（快照）。非法名返回空数组。
 * 给"声明扩展点的插件"渲染空态/计数用（例如"还没有插件扩展这里"）。
 */
export function slotContributors(name: string): readonly string[] {
  if (!isSlotName(name)) return []
  return entriesOf(name).map((entry) => entry.source)
}

/**
 * 订阅某扩展点的贡献**条目**（React hook，已通过宿主 SDK 暴露给插件）。
 *
 * 为什么返回条目数组而不是名单数组：`useSyncExternalStore` 的 `getSnapshot` 在数据未变时
 * 必须返回**同一个引用**，否则 React 会判定"每次渲染都变了"并陷入无限重渲染。
 * 实现里用 `useCallback([name])` 把快照函数与 `name` 绑定，`entriesOf()` 取的是注册表里
 * 那个稳定数组——映射（→ 贡献者名单）留给调用方在渲染期做。
 */
export function useSlotEntries(name: SlotName): readonly SlotEntry[] {
  const snapshot = useCallback(() => entriesOf(name), [name])
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

/* ============================ 带 props 的插槽出口（editor-toolbar / app-dock / article-summary / account-identities） ============================ */

/**
 * 加载期失败的固定文案（`SlotOutlet` 与带 props 的出口共用一份来源）。
 *
 * 文案刻意给出**可执行的下一步**（去插件管理检查），而不是只说"加载失败"。
 * 排障摘要只进 `data-error`，不进可见正文（原始串可能是英文/含路径，见 `lib/errorText.ts`）。
 */
export const pluginUiFailureNotice = (name: string): string =>
  `插件界面「${name}」加载失败，相关功能在本页不可用。作者可能漏发产物，请在「依赖图」页检查。`

/**
 * **本插槽**的加载期失败清单。
 *
 * 刻意不用全局的 `pluginUiFailed()`：那样问答页会替一个页脚插件报"加载失败"，
 * 用户照着去查会查到完全不相干的插件。按入口表的 `slots` 过滤，失败只在它该出现的位置出现。
 */
function useSlotLoadFailures(name: SlotName): readonly PluginUiFailure[] {
  const snapshot = useCallback(() => pluginUiFailedFor(name), [name])
  return useSyncExternalStore(subscribePluginUiState, snapshot, () => NO_FAILURES)
}

const NO_FAILURES: readonly PluginUiFailure[] = Object.freeze([])

/**
 * `editor-toolbar` 插槽出口（**多占用 + 带数据**）：渲染所有贡献者，各自独立错误边界。
 *
 * 与 `EditorSlotOutlet` 一样由调用方提供 props，但这里渲染**全部**条目——编辑页允许多个
 * 插件各挂自己的按钮组。无任何贡献且无加载失败时返回 `null`：不留一个空壳 `<div>` 撑出
 * 编辑页的空白条。
 */
export function EditorToolbarSlotOutlet(props: EditorToolbarSlotProps): ReactNode {
  const entries = useSlotEntries('editor-toolbar')
  const failures = useSlotLoadFailures('editor-toolbar')
  if (entries.length === 0 && failures.length === 0) return null
  return (
    <div className="slot-outlet slot-outlet-toolbar" data-slot="editor-toolbar" data-count={entries.length}>
      {failures.map((f) => (
        <p key={f.name} className="slot-error" role="status" data-plugin-ui-failed={f.name} data-error={f.message}>
          {pluginUiFailureNotice(f.name)}
        </p>
      ))}
      {entries.map((entry, index) => {
        const Toolbar = entry.component as EditorToolbarSlotComponent
        return (
          <SlotErrorBoundary key={`${entry.source}#${index}`} source={entry.source}>
            <Toolbar {...props} />
          </SlotErrorBoundary>
        )
      })}
    </div>
  )
}

/** 稳定的空数组（`useSyncExternalStore` 的 server snapshot 必须引用稳定） */
export const NO_DECLARED: readonly string[] = Object.freeze([])

/**
 * 某插槽的**生效声明者**名单（来自后端入口表，**不要求它们的 bundle 已加载**）。
 *
 * 为什么"入口显隐"必须用这个而不是"已注册的组件"：懒加载插槽的组件只在进入对应视图后才加载，
 * 而入口恰恰要在进入之前出现 —— 用后者判会得到"按钮永远不出现，除非按钮已经出现过"。
 * 判据细节与两条被否决的路见 `pluginUi.ts` 的 {@link pluginUiDeclaredFor}。
 *
 * **P8 之后暂无调用方**（原先唯一消费者是问答入口按钮，随 `wiki-ask` 一起拆除）。
 * 保留它是因为判据本身仍是宿主资产：任何"该不该显示某功能入口"的问题都只有这一个正确答案，
 * 删掉它等于邀请下一个人重新踩一遍自锁那个坑。
 */
export function useSlotDeclared(name: BuiltinSlotName): readonly string[] {
  return useSyncExternalStore(subscribePluginUiState, () => pluginUiDeclaredFor(name), () => NO_DECLARED)
}


/* ============================ app-dock（常驻底部输入条） ============================ */

/**
 * 当前的 `app-dock` 贡献者（无贡献时 `undefined`）。
 *
 * 与 `articleSummaryEntry` 同一套裁决口径：单占用取"最早注册"的一条，但**权威裁决在后端**
 * （入口表只把生效的插槽写进 `plugins[name].slots`），这里只是确定性兜底。
 */
export function appDockEntry(): SlotEntry | undefined {
  return entriesOf('app-dock')[0]
}

/** 引用稳定的 `app-dock` 贡献者快照（`useSyncExternalStore` 需要它，直接取数组会每次新对象） */
export function appDockEntrySnapshot(): SlotEntry | undefined {
  return entriesOf('app-dock')[0]
}

/** 订阅 `app-dock` 的贡献者变化 */
export function useAppDockSlot(): SlotEntry | undefined {
  return useSyncExternalStore(subscribe, appDockEntrySnapshot, () => undefined)
}

/**
 * `app-dock` 插槽出口（**单占用 + 带数据**）。
 *
 * ## 无贡献时返回 `null`，且**不渲染任何占位**
 * 这与 `SlotOutlet` 那条"无贡献也要说一句"的路线不同（问答页曾整页都是插件面板，空着会让人
 * 以为页面坏了，那条路线随 `wiki-ask` 在 P8 一起拆掉）。而 dock 是一条常驻输入条：
 * 没有它时页面**本来就是完整的**，
 * 补任何占位都只会平白占掉屏幕底部一条。这也是决策 5（匿名不渲染）能成立的前提——
 * "不渲染"在这里就是字面意义上的什么都不产出。
 *
 * ## 渲染点决定会话存活
 * 它挂在 `App.tsx` 的 `<main>` **之外**，与 `app-header` / `app-footer` 同一位置。
 * App 不随路由重挂 ⇒ 组件实例（连同它内部的会话状态）在**切页时不丢**（决策 9）。
 * 这条不是"顺手"得来的：把它放进任何一条路由的组件树里都会让切页重建实例。
 */
export function AppDockSlotOutlet(props: AppDockSlotProps): ReactNode {
  const entry = useAppDockSlot()
  const failures = useSlotLoadFailures('app-dock')
  if (!entry && failures.length === 0) return null
  return (
    <div
      className="slot-outlet slot-outlet-dock"
      data-slot="app-dock"
      data-count={entry ? 1 : 0}
      {...(entry ? { 'data-dock-source': entry.source } : {})}
    >
      {failures.map((f) => (
        <p key={f.name} className="slot-error" role="status" data-plugin-ui-failed={f.name} data-error={f.message}>
          {pluginUiFailureNotice(f.name)}
        </p>
      ))}
      {entry &&
        (() => {
          const Dock = entry.component as AppDockSlotComponent
          return (
            <SlotErrorBoundary source={entry.source}>
              <Dock {...props} />
            </SlotErrorBoundary>
          )
        })()}
    </div>
  )
}


/* ============================ article-summary（文章顶部的折叠摘要位） ============================ */

/**
 * 当前的 `article-summary` 贡献者（无贡献时 `undefined`）。
 *
 * 与 `appDockEntry` 同一套裁决口径：单占用取"最早注册"的一条，
 * 但**权威裁决在后端**（入口表只把生效的插槽写进 `plugins[name].slots`），
 * 这里只是"万一有两条"时的确定性兜底。
 */
export function articleSummaryEntry(): SlotEntry | undefined {
  return entriesOf('article-summary')[0]
}

/** 引用稳定的快照（`useSyncExternalStore` 需要它，直接取数组会每次新对象） */
export function articleSummaryEntrySnapshot(): SlotEntry | undefined {
  return entriesOf('article-summary')[0]
}

/** 订阅 `article-summary` 的贡献者变化 */
export function useArticleSummarySlot(): SlotEntry | undefined {
  return useSyncExternalStore(subscribe, articleSummaryEntrySnapshot, () => undefined)
}

/**
 * `article-summary` 插槽出口（**单占用 + 带数据**）。
 *
 * ## 无贡献时返回 `null`，且**不渲染任何占位**
 * 与 `app-dock` 出口同一条理由（`wiki-ask` 那条"无贡献也要补一句占位"的路线已随 P8 拆除）：
 * 文章页没有摘要是**正常的**——
 * 绝大多数知识库页面本来就没有摘要，而"这里本该有一张摘要卡"并不是读者需要知道的事。
 * 补一句占位文案只会让每一篇文章顶部多一行噪音。
 *
 * ## 为什么出口本身不管"有没有模型"
 * "没有模型 ⇒ 整张卡片不渲染"这条判据在**插件**手里（它问自己的
 * `GET /api/ai/summary`）。宿主在这里多判一次就是第二份判据——而两份判据必然漂移，
 * 漂移的表现是"插件认为该显示、宿主不给它位置"，排查时看哪一边都像是对的。
 */
export function ArticleSummarySlotOutlet(props: ArticleSummarySlotProps): ReactNode {
  const entry = useArticleSummarySlot()
  const failures = useSlotLoadFailures('article-summary')
  if (!entry && failures.length === 0) return null
  return (
    <div
      className="slot-outlet slot-outlet-summary"
      data-slot="article-summary"
      data-count={entry ? 1 : 0}
      {...(entry ? { 'data-summary-source': entry.source } : {})}
    >
      {failures.map((f) => (
        <p key={f.name} className="slot-error" role="status" data-plugin-ui-failed={f.name} data-error={f.message}>
          {pluginUiFailureNotice(f.name)}
        </p>
      ))}
      {entry &&
        (() => {
          const Card = entry.component as ArticleSummarySlotComponent
          return (
            <SlotErrorBoundary source={entry.source}>
              <Card {...props} />
            </SlotErrorBoundary>
          )
        })()}
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
 * 插件编辑器路径上的**附件兜底文案**（X1）。
 *
 * 导出是为了让界面与源码级守卫测试共用同一份来源 —— 这类"用户唯一的解释"一旦两处措辞
 * 漂移，测试钉住的就不再是用户真正看到的那句话。文案刻意给出**可执行的下一步**
 * （去插件管理换回内置编辑器），而不是只说"不支持"。
 */
export const EDITOR_SLOT_NO_UPLOAD_HINT =
  '当前编辑器由插件提供，它没有插入附件的能力：拖入或粘贴的文件不会上传。请在「依赖图」页改用内置编辑器（内置编辑器支持拖拽与粘贴上传）。'

/**
 * `editor` 插槽出口：把宿主持有的编辑态作为 props 交给**生效的那一个**编辑器插件。
 *
 * 与 {@link SlotOutlet} 的差别：这是**单占用 + 带数据**的出口，故只渲染第一条，
 * 且必须由调用方提供完整的 {@link EditorSlotProps}（宿主是这些值的唯一持有者）。
 *
 * ---------------------------------------------------------------------------
 * ## 附件兜底（X1）—— **这是兜底，不是替代方案**
 *
 * {@link EditorSlotProps} 里**没有**上传通道：`value` / `mode` / `slug` / `readOnly` /
 * `onChange` / `onSave` / `onCancel` 七个字段，一个都表达不了"把文件交给宿主上传"。
 * 于是**任何**插件编辑器接管 `editor` 插槽后，用户拖入文件都会直接落到浏览器的默认行为上：
 * 浏览器**导航到那个文件**，编辑器里未保存的正文一起丢掉，而且全程零提示。
 * （真机实测：拖入 PNG 时 0 个请求、无占位、无提示，窗口 target 数 6→7 —— 页面真的被顶掉了。）
 *
 * 这里只做两件事：
 *   ① `preventDefault()` 拦住默认拖放 —— 这一条是**硬要求**，不拦就是丢数据；
 *   ② 给一句 `role="status"` 的**可见**提示，指出可执行的下一步。
 *
 * ⚠️ 它**不**解决"插件编辑器能不能上传附件"这个能力问题 —— 那需要把上传通道加进
 * {@link EditorSlotProps}（core 侧的权威副本 + 本文件镜像 + `editorSlotProps.test.ts`
 * 的镜像守卫要一起改），属于契约演进，不在本次修复范围。在那一刻到来之前，
 * **不要让任何插件默认占用 `editor` 插槽**（`config/plugins.base.json` 的默认清单里
 * 没有 `@geewiki/editor-plain`，理由就是这个）。
 *
 * 两条实现取舍：
 * - **`event.defaultPrevented` 为真时保持沉默**：React 的合成事件按 DOM 深度冒泡，
 *   插件组件在内层、先跑；插件自己接住了拖放就说明它有话事权，宿主不该再弹提示。
 *   将来的编辑器插件真接上上传后，这里自动让路，不必再改一次。
 * - **提示用 state 渲染，而不是直接改 DOM**：`role="status"` 要被播报，实时区域就必须
 *   先于内容存在（见下面那个恒常存在的 `<p>`），临时塞进去的节点多半不会被读出来。
 */
export function EditorSlotOutlet(props: EditorSlotProps): ReactNode {
  const entry = useEditorSlot()
  /** 用户刚刚试图拖入/粘贴文件（而当前编辑器接不住）——只用于驱动那句可见提示 */
  const [uploadBlocked, setUploadBlocked] = useState(false)
  /*
   * ★ F5：宿主提供了 `onUploadFiles` 时，上传**由插件编辑区自己接住**（粘贴/拖放归它），
   * 外层就不该拦事件、更不该报"编辑器不支持上传"。仍是"能力不存在才提示"的那条口径：
   * 只有宿主确实没给这个能力时，才拦下来并给可见反馈。
   */
  const uploadSupported = props.onUploadFiles !== undefined

  /** `dataTransfer` / `clipboardData` 里是否带着**文件**（纯文本拖放/粘贴不归这里管） */
  const carriesFiles = (dt: DataTransfer | null): boolean =>
    dt !== null && Array.from(dt.types).includes('Files')

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (uploadSupported) return
    if (!carriesFiles(event.dataTransfer) || event.defaultPrevented) return
    // 必须拦：不拦的话浏览器会把窗口导航到被拖入的文件，正在编辑的正文一起丢
    event.preventDefault()
    event.dataTransfer.dropEffect = 'none'
    setUploadBlocked(true)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (uploadSupported) return
    if (!carriesFiles(event.dataTransfer) || event.defaultPrevented) return
    // 双保险：即使某些浏览器在 dragover 之后仍然派发了 drop，也不能让它落到默认行为上
    event.preventDefault()
    setUploadBlocked(true)
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (uploadSupported) return
    if (!carriesFiles(event.clipboardData) || event.defaultPrevented) return
    // 粘贴文件没有"浏览器默认动作"要拦（textarea 本来也贴不进去），但同样必须给可见反馈，
    // 否则用户看到的就是"贴了一下，什么都没发生"
    event.preventDefault()
    setUploadBlocked(true)
  }

  if (!entry) return null
  const Editor = entry.component as EditorSlotComponent
  return (
    <div
      className="slot-outlet"
      data-slot="editor"
      data-count={1}
      data-editor-source={entry.source}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <SlotErrorBoundary source={entry.source}>
        <Editor {...props} />
      </SlotErrorBoundary>
      {/*
        这个 `<p>` **恒常存在**（空闲时内容为空串、CSS 里由 `:empty` 收掉内边距）：
        实时区域要先于内容出现，屏幕阅读器才会播报随后写进去的那句话。
        `data-editor-upload-hint` 暴露状态供真机验收与测试观察。
      */}
      <p className="slot-hint" role="status" data-editor-upload-hint={uploadBlocked ? 'shown' : 'idle'}>
        {uploadBlocked ? EDITOR_SLOT_NO_UPLOAD_HINT : ''}
      </p>
    </div>
  )
}

/* ------------------------- account-identities（账号页的外部身份区） ------------------------- */

/**
 * 取该插槽当前生效的贡献（`multi` 基数 ⇒ 可以有多条，全部渲染）。
 *
 * 与 `article-summary` 的 `useArticleSummarySlot` 不同：那个是 `single`，只取一条；
 * 这里按"多个 IdP 各自一行绑定入口也不矛盾"（core 的 `SLOT_CARDINALITY` 把它定为 `multi`）渲染全部。
 */
export function useAccountIdentitiesSlots(): readonly SlotEntry[] {
  return useSyncExternalStore(subscribe, () => entriesOf('account-identities'), () => EMPTY)
}

/**
 * `account-identities` 插槽出口（**可多占用 + 带 props**）。
 *
 * 没有贡献者（没装任何外部身份提供者）时**返回 null**：这正是本次归属变更要的效果——
 * 账号页在没装 SSO 插件时不再出现任何讲 SSO 的界面（此前宿主自己写死了一块，
 * 于是没装插件的部署也看到一个指向不存在功能的空态）。
 */
export function AccountIdentitiesSlotOutlet(props: AccountIdentitiesSlotProps): ReactNode {
  const entries = useAccountIdentitiesSlots()
  const failures = useSlotLoadFailures('account-identities')
  if (entries.length === 0 && failures.length === 0) return null
  return (
    <div className="slot-outlet" data-slot="account-identities" data-count={entries.length}>
      {failures.map((f) => (
        <p key={f.name} className="slot-error" role="status" data-plugin-ui-failed={f.name} data-error={f.message}>
          {pluginUiFailureNotice(f.name)}
        </p>
      ))}
      {entries.map((entry, index) => {
        const Panel = entry.component as AccountIdentitiesSlotComponent
        return (
          <SlotErrorBoundary key={`${entry.source}#${index}`} source={entry.source}>
            <Panel {...props} />
          </SlotErrorBoundary>
        )
      })}
    </div>
  )
}
