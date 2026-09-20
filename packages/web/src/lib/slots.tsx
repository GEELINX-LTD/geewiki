import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type ComponentType,
  type DragEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
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
/*
 * ★ P4：界面扩展平台的**宿主节点目录**（浏览器安全子路径，与 slots 同一真源体系）。
 * 为什么要 import 目录而不是继续用 `isBuiltinSlotName || isPluginSlotName`：
 * 目录把"宿主节点"从 7 个插槽扩到了 `shell-*` / `ui-*` 等**不带 `/`** 的名字上，
 * 只认插槽白名单会把 `ui-button` 当成笔误拒掉（那正是本轮要实现的能力）。
 */
import {
  HOST_NODE_NAMES,
  extModesOf,
  hostNodeSpec,
  isExtName,
  nestedSlotsOf,
  supportsExtMode,
  type ExtMode,
  type HostNodeName,
} from '@geewiki/core/extensions'
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
  /**
   * 贡献模式（P4）：`extend` 追加、`wrap` 包一层、`replace` 整体接管。
   *
   * 缺省 `'extend'` ⇒ 所有既有调用点行为逐字不变。模式只在 {@link Ext} 出口里被解释；
   * `SlotOutlet` / `PluginSlotOutlet` 一律按追加处理（它们服务的是"只有追加语义"的老契约）。
   */
  readonly mode: ExtMode
  /**
   * 是否渲染进 **Shadow Root**（P9，仅 `replace` 模式有意义）。
   *
   * 由贡献者显式声明（`registerExtension(node, c, { mode: 'replace', shadow: true })`）。
   * 两种模式（`wrap` / `extend`）上声明它会被**忽略并告警**——`wrap` 要把宿主默认元素
   * 放进 `default`，而宿主默认元素在 shadow 边界之外，隔离只隔离得了自己；
   * `extend` 是"追加在宿主元素旁边"，隔离一个追加块没有意义。
   *
   * 语义（设计文档 §7.3）：CSS 自定义属性（`--gw-*`）**跨 shadow 边界继承**，
   * 故主题令牌自动生效；宿主的 Tailwind 工具类**进不去**，因此声明者必须自带样式。
   */
  readonly shadow: boolean
}

const EMPTY: readonly SlotEntry[] = Object.freeze([])
const registry = new Map<SlotName, readonly SlotEntry[]>()
const listeners = new Set<() => void>()

/** 名字是否可接受：宿主节点目录 ∪ 插件自定义扩展点语法（**不含**"任意字符串"这条退路）。 */
function isSlotName(name: string): name is SlotName {
  return isExtName(name)
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
  // 宿主节点目录（插槽 + shell-* + ui-* …）在前——它们是宿主固定渲染点，
  // 快照要能回答"这个位置当前有没有人贡献"，而不只是"7 个插槽"。
  for (const name of HOST_NODE_NAMES) out[name] = entriesOf(name).length
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
/** ★ P4：带模式的注册（`replace` / `wrap` 必须由作者显式写出，见 `registerSlotByName` 的校验） */
export function registerSlot(name: SlotName, component: AnySlotComponent, source?: string, mode?: ExtMode): () => void
/** ★ P9：再带 Shadow DOM 隔离（仅 `replace` 有意义，见 {@link SlotEntry.shadow}） */
export function registerSlot(
  name: SlotName,
  component: AnySlotComponent,
  source?: string,
  mode?: ExtMode,
  shadow?: boolean,
): () => void
export function registerSlot(
  name: SlotName,
  component: AnySlotComponent,
  source = 'host',
  mode: ExtMode = 'extend',
  shadow = false,
): () => void {
  const entry: SlotEntry = { component, source, mode, shadow }
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
export function registerSlotByName(
  name: string,
  component: AnySlotComponent,
  source = 'host',
  mode: ExtMode = 'extend',
  shadow = false,
): () => void {
  if (!isSlotName(name)) {
    console.warn(
      `[geewiki-slot] 未知扩展点名 "${name}"，已忽略（宿主节点见 @geewiki/core/extensions 的目录；` +
        '自定义扩展点须形如 "命名空间/名字"：小写 kebab 且至少含一个 `/`）',
    )
    return () => {}
  }
  /*
    `shadow` 只在 `replace` 上成立（见 `SlotEntry.shadow`）：其余模式**丢弃这个标志并告警**，
    但**不丢弃整条贡献**——"隔离没生效"与"我的组件根本没渲染"是两个严重程度完全不同的结果，
    后者会让作者去查一个并不存在的加载失败。
  */
  const isolated = mode === 'replace' && shadow
  if (shadow && !isolated) {
    console.warn(
      `[geewiki-slot] 节点 "${name}" 的 ${mode} 模式忽略 shadow: true（Shadow DOM 只对 replace 有意义：` +
        'wrap 的宿主默认元素在 shadow 之外、extend 只是追加一块）',
    )
  }
  if (!supportsExtMode(name, mode)) {
    /*
      模式校验**必须在这里再做一次**（后端已经拒过一遍）：前端拿到的可能是
      ① 一个手写 registerSlot 的插件（不走后端声明）、② 后端版本较旧、③ 缓存里的旧入口表。
      静默接受的后果是"插件 replace 了页头，于是整个页头消失"——那是必须被挡下的。
    */
    console.warn(
      `[geewiki-slot] 节点 "${name}" 不允许 ${mode} 模式（允许：${JSON.stringify(extModesOf(name)) || '[]'}），已忽略`,
    )
    return () => {}
  }
  /*
    容器节点 + shadow 的**提前告知**（P11c）：隔离本身仍然生效，但 `props.slots` 给出的挂载点
    会被忽略（出口必须留在 light DOM，否则其他插件的贡献被拖进隔离根、丢掉宿主样式）。
    在这里说，作者才知道"我摆了挂载点却没反应"不是宿主坏了。
    位置刻意在模式校验**之后**：被拒的注册不该再收到第二条告警（那是噪声）。
  */
  const nested = nestedSlotsOf(name)
  if (isolated && nested.length > 0) {
    console.warn(
      `[geewiki-slot] 节点 "${name}" 是容器节点（内层出口：${nested.join('、')}）：shadow: true 仍然生效，` +
        '但 props.slots 里的挂载点会被忽略——内层出口必须留在 light DOM，' +
        '否则其他插件的贡献会被拖进隔离根并丢掉宿主样式。',
    )
  }
  return registerSlot(name, component, source, mode, isolated)
}

/**
 * **扩展点注册入口**（宿主 SDK 的 `registerExtension` 实现，P4；P9 增加 `shadow`）。
 *
 * 与 {@link registerSlotByName} 的关系：后者是它的兼容前身（模式固定 `extend`），
 * 这里多一层"节点是否允许该模式"的判断，并把告警文案指向目录真源。
 */
export function registerExtensionByName(
  node: string,
  component: AnySlotComponent,
  source = 'host',
  mode: ExtMode = 'extend',
  shadow = false,
): () => void {
  return registerSlotByName(node, component, source, mode, shadow)
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

/**
 * **回退记录**（`replace` / `wrap` 的贡献渲染失败时）。
 *
 * ## 为什么要有这份记录，而不是只 console.error
 * `replace` / `wrap` 的失败语义是**回退宿主默认实现**（用户拍板：插件渲染失败不能让控件消失）。
 * 但"控件还在"恰恰意味着**失败是不可见的**——页头看起来完全正常，只是插件没生效。
 * 于是必须有第二个出口：管理台读取这份记录并把"N 个扩展点回退到默认实现"显示出来。
 *
 * 快照引用稳定（`useSyncExternalStore` 的 `getSnapshot` 要求），变更时才换新数组。
 */
export interface ExtFailure {
  readonly node: string
  readonly source: string
  readonly mode: ExtMode
  readonly message: string
}

const extFailureLog = new Map<string, ExtFailure>()
let extFailureSnapshot: readonly ExtFailure[] = Object.freeze([])

/** 当前的回退记录（新增在前；无记录时返回稳定的空数组） */
export function extFailures(): readonly ExtFailure[] {
  return extFailureSnapshot
}

/** 清空回退记录（管理台"我知道了"与单测用） */
export function clearExtFailures(): void {
  if (extFailureLog.size === 0) return
  extFailureLog.clear()
  extFailureSnapshot = Object.freeze([])
  emit()
}

function recordExtFailure(failure: ExtFailure): void {
  const key = `${failure.node}#${failure.source}`
  const prev = extFailureLog.get(key)
  // 同一条重复失败（父组件重挂）不重复播报，避免日志刷屏
  if (prev && prev.message === failure.message) return
  extFailureLog.set(key, failure)
  extFailureSnapshot = Object.freeze([...extFailureLog.values()])
  emit()
}

/**
 * **回退边界**：`replace` / `wrap` 的贡献抛错时，渲染 `fallback`（宿主默认实现）。
 *
 * ## 为什么不用 {@link SlotErrorBoundary}
 * 那个边界渲染的是"插件界面渲染失败"占位文案——对**追加**语义是诚实的（少一块看得见），
 * 但对 `replace` / `wrap` 是**灾难**：控件本身会消失（用户拍板的失败语义正是"不能消失"）。
 *
 * ## 为什么不加 `data-ext-fallback` 标记元素
 * 设计文档初稿写了"外层元素带 `data-ext-fallback`"。实现时放弃：那需要一个包裹元素，
 * 而宿主默认实现可能处在**对子元素有要求**的位置（`<tr>`、flex 行、`<ul>` 等），
 * 插一个 `<span>` 轻则样式错位、重则 HTML 结构非法。代价大于收益，故改用
 * {@link extFailures} 的**记录**（管理台可见、可断言）＋ console.error。
 *
 * ## 为什么导出（`export`）
 * React 的**错误边界只在客户端生效**：`react-dom/server` 下子组件抛错会直接冒泡，
 * `componentDidCatch` 根本不会被调用。因此"回退到宿主默认实现"这条**用户拍板的语义**
 * 在 SSR 路径上无法被渲染测试覆盖，只能白盒实例化本类来钉（见 `test/extOutlet.test.ts`）。
 * 这是宿主内部组件，**不属于插件 API**（插件拿不到它）。
 */
export class ExtBoundary extends Component<
  { readonly node: string; readonly source: string; readonly mode: ExtMode; readonly fallback: ReactNode; readonly children: ReactNode },
  BoundaryState
> {  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `[geewiki-ext] ${this.props.mode} 贡献渲染失败（节点：${this.props.node}，来源：${this.props.source}）：` +
        '已回退宿主默认实现',
      error,
    )
    recordExtFailure({ node: this.props.node, source: this.props.source, mode: this.props.mode, message })
  }

  render(): ReactNode {
    if (this.state.error !== null) return this.props.fallback
    return this.props.children
  }
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
  /*
    server snapshot 与 client snapshot 指向**同一个**注册表快照（与 `Ext` 同口径）。
    本仓是纯 SPA（没有 SSR，见设计文档 §9.6），因此不存在水合不一致；反过来，
    若这里传 `() => EMPTY`，则"容器节点被 replace 时其他插件的贡献仍然渲染"这条契约
    在单测里**根本断言不了**（`renderToStaticMarkup` 是服务端路径），只能靠浏览器 CDP。
    这条契约是用户当场驳回缺陷后定下的，值得有单元级的回归保护。
  */
  const entries = useSyncExternalStore(
    subscribe,
    () => entriesOf(name),
    () => entriesOf(name),
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
          {`插件界面「${f.name}」加载失败，相关功能在本页不可用。作者可能漏发产物，请在「插件管理」页检查。`}
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

/* ==================== P11b：容器节点的内层插槽出口（挂载点 + 承运者） ==================== */

/*
  ## 要解决的问题（用户当场驳回的缺陷）
  `shell-header` / `shell-footer` 的 DOM 里嵌着**多方共存**的插槽出口（`app-header` /
  `app-footer`）。若 `replace` 让单个插件接管整棵子树，它就获得了"删掉其他所有插件贡献"的
  权力——这与"`multi` 插槽不得 `replace`"是同一条纪律，只是藏在了一层 DOM 嵌套里。

  ## 解法：宿主渲染，插件只决定"落在哪"
  出口**永远由宿主渲染恰好一次**（`NestedSlotOutlet`），贡献者拿到的 `props.slots[名]` 只是
  一个**挂载点元素**（`ExtSlotMount`）：在自己的输出里渲染它，出口就搬到那里。于是
  "贡献丢失"在结构上不可能发生，最坏情况只是位置不合意（插件没渲染挂载点 ⇒ 留在宿主位置）。

  ## 为什么用"登记表 + 订阅"而不是在渲染期嗅探 DOM
  搬运必须在**绘制前**完成，否则会看到一次跳动。挂载点用 `useLayoutEffect` 在提交后、
  绘制前登记自己并通知；承运者经 `useSyncExternalStore` 同步重渲染后 portal 过去——
  整条链在一次绘制内完成。反过来（先按宿主位置渲染、提交后再嗅探有没有挂载点）也能做到
  "不丢"，但**插件内部 state 变化**导致挂载点出现/消失时承运者不会重渲染，
  会出现"重复渲染"或"漏兜底"两种失准；登记表把这两个方向都封死了。
*/
const mountRegistry = new Map<string, Set<HTMLElement>>()
const mountListeners = new Set<() => void>()
let mountTargets: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 挂载点是否可用：必须在文档里、且必须位于 **light DOM**（不能落在 Shadow Root 内）。
 *
 * ## 为什么 Shadow Root 内的挂载点必须被忽略（P11c，**先实测再修**）
 * 容器节点（`shell-header` / `shell-footer`）的内层出口装的是**其他插件**的贡献。
 * 若贡献者用 `{ mode: 'replace', shadow: true }` 接管外壳、又把 `props.slots[…]` 渲染在隔离根里，
 * 出口就会被 portal 进 Shadow Root：那些贡献随即丢掉全部宿主 Tailwind 样式，
 * 而且从宿主视角看**与"贡献消失了"完全一样**——`document.querySelector` 不穿透 shadow，
 * 于是 CDP 探针第一次读到的就是 `counterLight:false, outletsLight:0`。
 * 这是"单个插件在不知情中破坏别人"，与 `replace` 删掉他人贡献同类，故一律拒绝：
 * 挂载点被忽略、出口留在宿主位置（light DOM），并告警一次。
 *
 * `doc` 只为可测性存在（Node 下没有 `document`），生产调用不传。
 */
export function isUsableMountTarget(
  /*
    形参是**结构化**的（只用到这两个成员）而不是 `HTMLElement`：这个判据只做同一性比较，
    收窄成完整元素类型既没有表达力上的好处，又让 Node 下的单测必须造一整个假 `Node`
    （假对象还要伪造 46 个属性），最后逼出 `as unknown as Node` 这种把断言变成噪音的写法。
  */
  el: { readonly isConnected: boolean; getRootNode(): unknown },
  doc: unknown = typeof document === 'undefined' ? undefined : document,
): boolean {
  if (!el.isConnected) return false
  if (doc === undefined) return false
  return el.getRootNode() === doc
}

/** 每个插槽只告警一次：挂载点的 layout effect 会随插件重渲染反复触发，不去重就是刷屏 */
const warnedShadowMounts = new Set<string>()

function notifyMounts(): void {
  const next = new Map<string, HTMLElement>()
  for (const [slot, elements] of mountRegistry) {
    for (const el of elements) {
      // 卸载中的元素静默跳过（正常瞬态，不是错误用法）
      if (!el.isConnected) continue
      if (!isUsableMountTarget(el)) {
        if (!warnedShadowMounts.has(slot)) {
          warnedShadowMounts.add(slot)
          console.warn(
            `[geewiki-slot] 内层插槽出口 "${slot}" 的挂载点落在 Shadow Root 内，已忽略：` +
              '出口必须留在 light DOM，否则其他插件的贡献会被拖进隔离根、丢掉宿主样式。' +
              '若你的 replace 贡献开了 shadow: true，请把 props.slots[…] 渲染在隔离标记之外。',
          )
        }
        continue
      }
      next.set(slot, el)
      break
    }
  }
  mountTargets = next
  for (const listener of mountListeners) listener()
}

function subscribeMounts(listener: () => void): () => void {
  mountListeners.add(listener)
  return () => {
    mountListeners.delete(listener)
  }
}

function mountTargetOf(slot: string): HTMLElement | null {
  return mountTargets.get(slot) ?? null
}

/*
  `useLayoutEffect` 在服务端渲染里不执行且会告警。本仓是纯 SPA，但**单测**用
  `renderToStaticMarkup`（服务端路径）跑渲染断言，故按环境选一次：服务端退化为 `useEffect`
  （不执行，也就没有搬运——与"SSR 下先按宿主位置渲染"的期望一致）。
*/
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * **内层插槽出口的挂载点**：贡献者把它渲染在自己标记里的任意位置，宿主承载的出口就搬过去。
 *
 * 只渲染一个 `<span style="display: contents">`：`display: contents` 让它**不生成盒子**，
 * 于是被搬进来的出口在布局上等同于直接写在该位置（与 `ShadowHost` 同一个纪律：
 * 扩展点不该改变宿主布局）。渲染多次时**第一个仍在文档里的**生效（其余留空）。
 */
export function ExtSlotMount({ slot }: { slot: SlotName }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  useIsomorphicLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const elements = mountRegistry.get(slot) ?? new Set<HTMLElement>()
    mountRegistry.set(slot, elements)
    elements.add(el)
    notifyMounts()
    return () => {
      elements.delete(el)
      if (elements.size === 0) mountRegistry.delete(slot)
      notifyMounts()
    }
  }, [slot])
  return <span ref={ref} data-ext-slot-mount={slot} style={{ display: 'contents' }} />
}

/**
 * **容器节点的内层插槽出口**（宿主渲染点）：`<header>` / `<footer>` 里那个由宿主独占的出口。
 *
 * 默认渲染在宿主位置（与接线前的 DOM 逐字一致）；若某贡献者渲染了对应挂载点，
 * 则在**绘制前** portal 过去。**永远恰好渲染一次**：搬运的是同一个出口，不是复制。
 *
 * @param node 所属容器节点（只用于校验声明，见 `nestedSlotsOf`）
 * @param slot 内层插槽名（必须是该节点在目录里声明过的 `nestedSlots`）
 */
export function NestedSlotOutlet({ node, slot }: { node: HostNodeName; slot: BuiltinSlotName }): ReactNode {
  const declared = nestedSlotsOf(node)
  if (!declared.includes(slot)) {
    // 声明与渲染不一致是**宿主自己的**接线错误（插件无法触发），故只告警不抛：
    // 抛出去会让整页白屏，而这条错误的真实后果只是"这个出口没被声明过"。
    console.warn(
      `[geewiki-slot] ${node} 未在目录里声明内层出口 ${slot}（nestedSlots），` +
        `请在 packages/core/src/extensions.ts 补上声明；当前仍按宿主位置渲染。`,
    )
  }
  const target = useSyncExternalStore(subscribeMounts, () => mountTargetOf(slot), () => null)
  const outlet = <SlotOutlet name={slot} />
  return target === null ? outlet : createPortal(outlet, target)
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
 * **在组件定义处接线**的助手（P7）：把 `packages/web/src/ui/*` 的基础原语接成宿主节点。
 *
 * ## 为什么用 HOC 而不是在每个组件里手写 `<Ext>`
 * 逐个组件手写要把整块 JSX 再缩进一层（十来个文件、几百行 diff），而收益完全相同：
 * 两种写法在**无贡献时产出的 DOM 逐字相同**（`Ext` 无贡献时直接返回 `children`）。
 * HOC 还带来一条纪律：接线点只有一处（`withExt('ui-button', ButtonBase)`），
 * 一眼能看出"这个原语是不是宿主节点"。
 *
 * ## 为什么"全站所有调用点同时生效"
 * `Button` 被全仓几十处**直接** import（`../ui/Button`，不走 barrel），因此接线必须在**定义处**——
 * 在 `ui/index.ts` 桶文件里包一层会漏掉所有直接 import 的调用点。
 *
 * ## 契约
 * - 节点的 props = 组件自己的 props（原样转发给贡献者，含 `children`）；
 * - 贡献者另外收到 `default`（宿主默认元素，`wrap` 用）与 `propsVersion`；
 * - 贡献失败 ⇒ 回退宿主默认实现（{@link Ext} 的语义，用户拍板）。
 */
export function withExt<P extends object>(
  id: HostNodeName,
  Component: ComponentType<P>,
): ComponentType<P> {
  const Wrapped: ComponentType<P> = (props: P) => (
    <Ext id={id} props={props as Record<string, unknown>}>
      <Component {...props} />
    </Ext>
  )
  // 便于 React DevTools / 报错栈里看出这是哪个原语（不参与任何逻辑判定）
  Wrapped.displayName = `Ext(${Component.displayName ?? Component.name ?? String(id)})`
  return Wrapped
}

/**
 * 某扩展点当前的贡献者名单（快照）。非法名返回空数组。
 * 给"声明扩展点的插件"渲染空态/计数用（例如"还没有插件扩展这里"）。
 */
export function slotContributors(name: string): readonly string[] {
  if (!isSlotName(name)) return []
  return entriesOf(name).map((entry) => entry.source)
}

/* ==================== ★ P4：模式化出口 <Ext>（replace / wrap / extend） ==================== */

/** {@link Ext} 的属性 */
export interface ExtProps {
  /**
   * 宿主节点 id（`HostNodeName`：编译期枚举目录里的名字）。
   *
   * 为什么是 {@link HostNodeName} 而不是 `string`：这是**宿主自己**的渲染点，
   * 写错一个字母就应该编译不过（与 `SlotOutlet` 的 `BuiltinSlotName` 同一条纪律）。
   * 插件侧注册走字符串路径（`registerExtension`），由 `isExtName` 运行期校验。
   */
  readonly id: HostNodeName
  /** 转发给贡献组件的属性（含 `default` 与 `propsVersion`，见下） */
  readonly props?: Record<string, unknown>
  /** **宿主默认实现**：无贡献时渲染它；`replace` 接管后由它决定渲染什么；失败时回退到它 */
  readonly children: ReactNode
}

/**
 * **Shadow DOM 隔离壳**（P9）：把 `replace` 贡献渲染进一个 Shadow Root。
 *
 * ## 为什么包一层 `<span style="display: contents">`
 * `attachShadow` 必须挂在一个**元素**上，于是宿主无论如何都要引入一个包装元素。
 * `display: contents` 让这个元素**不生成盒子**（它的子树在布局上直接参与父容器），
 * 因此包装元素对栅格 / flex 行 / `<tr>` 里的排版没有影响——这与"扩展点不应改变宿主布局"
 * 是同一条纪律。⚠️ 该性质由 `scripts/acceptance/plugin-ui-cdp.mjs` 在真实浏览器里复验
 * （Node 下没有 DOM，单测只能钉住"贡献没有被内联渲染"这一半）。
 *
 * ## 为什么 SSR 下是空的（刻意，不是缺陷）
 * Shadow Root 只能由 DOM API 创建，而服务端渲染没有 DOM。本仓是**纯 SPA**
 * （设计文档 §9.6：`GET /` 的首屏 HTML 不含插件内容），因此这条路径下"先空后挂载"
 * 与其它插件内容的可见时机一致。用"先内联渲染再搬进 shadow"来掩盖它，反而会
 * 造成一次真实的重复渲染与闪烁，并让"隔离是否生效"变得难以断言。
 *
 * ## 能穿透与不能穿透（设计文档 §7.3）
 * - **能**：CSS 自定义属性（`--gw-*`）跨 shadow 边界继承 ⇒ 主题令牌自动生效，
 *   这正是选「令牌 + Shadow DOM」而不是「类名 + Shadow DOM」的原因；
 * - **不能**：宿主的 Tailwind 工具类进不去 shadow root ⇒ 声明者必须自带样式
 *   （`<style>` 元素或内联样式），否则会渲染出裸 HTML。
 */
function ShadowHost({ children }: { children: ReactNode }): ReactNode {
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const [root, setRoot] = useState<ShadowRoot | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    // 复用已有 root：React 19 的 StrictMode 会双跑 effect，重复 attachShadow 会抛
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    setRoot(shadow)
    return () => {
      setRoot(null)
    }
  }, [])

  return (
    <span ref={hostRef} data-ext-shadow="" style={{ display: 'contents' }}>
      {root === null ? null : createPortal(children, root)}
    </span>
  )
}

/**
 * **模式化扩展点出口**（界面扩展平台 P4）。
 *
 * ## 渲染规则（与设计文档 §4 一一对应）
 * ```
 * 结果 = extend( wrap( replace( 默认实现 ) ) )
 * ```
 * 1. `replace` 胜出者渲染 ⇒ 默认实现不渲染（它拿到 `default: undefined`）；
 * 2. `wrap` 胜出者渲染 ⇒ 它拿到 `default: <上一步的结果>` 作为属性；
 * 3. `extend` 贡献按注册顺序**追加**在结果之后（各自独立错误边界，与插槽行为一致）。
 *
 * ## 容器节点（`nestedSlots` 非空的节点）
 * `shell-header` / `shell-footer` 内部嵌着多方共存的插槽出口，它们**由宿主渲染**
 * （{@link NestedSlotOutlet}），**不在本组件的子树里**——因此上面的 `replace` 无论如何都删不掉
 * 其他插件的贡献。本组件额外把 {@link ExtSlotMount} 作为 `props.slots[插槽名]` 交给贡献者，
 * 让它决定那个出口落在自己标记里的哪一处（见文件头"容器节点"一节）。
 *
 * ## 失败语义（用户拍板）
 * `replace` / `wrap` 抛错 ⇒ **回退宿主默认实现**（控件不消失），并在 {@link extFailures} 留记录；
 * `extend` 抛错 ⇒ 只丢弃那一条，渲染既有的 `.slot-error` 占位（少一块是看得见的）。
 *
 * ## 为什么"单占用"的裁决不在这里做
 * 裁决（`replace`/`wrap` 至多一个生效者）由后端 `resolveExtensions` 完成，被抑制者
 * **根本不会注册**（前端只认 effective）。前端如果自己再判一次，就会出现
 * "后端说 A 生效、前端渲染 B"的两套真相——本仓在 `resolvePluginUiHit` 上已经吃过一次。
 * 这里只按注册顺序取第一条，作为"后端没给出裁决时"的**确定性兜底**。
 */
export function Ext({ id, props, children }: ExtProps): ReactNode {
  /*
    server snapshot 与 client snapshot 指向**同一个**注册表快照。
    本仓是纯 SPA（没有 SSR，见设计文档 §9.6），因此不存在"服务端渲染一份、客户端再变"的
    水合不一致；反过来说，若这里传 `() => EMPTY`，则 SSR 路径下**任何贡献都渲染不出来**，
    于是这条链路的测试只能靠白盒——收益远小于代价。（`subscribe` 的第三个参数是
    React 的 `getServerSnapshot`，它必须返回缓存过的引用，`entriesOf` 正是稳定引用。）
  */
  const snapshot = useCallback(() => entriesOf(id), [id])
  const entries = useSyncExternalStore(subscribe, snapshot, snapshot)
  const spec = hostNodeSpec(id)
  const propsVersion = spec?.propsVersion ?? 1
  const replaceEntry = entries.find((e) => e.mode === 'replace')
  const wrapEntry = entries.find((e) => e.mode === 'wrap')
  const extendEntries = entries.filter((e) => e.mode === 'extend')
  /*
    ★ P11b：容器节点（`shell-header` / `shell-footer`）的内层插槽出口以**挂载点**形式交给贡献者
    （见上面 `NestedSlotOutlet` / `ExtSlotMount` 的说明）。出口本身由宿主渲染，
    这里给出的只是"可以把它摆在哪"的能力 —— 因此贡献者**不渲染它也绝不会丢**。
    三种模式都注入：规则只有一条"拿到 props 的贡献者就能摆放"，不必逐模式记忆。
  */
  const nestedSlots = nestedSlotsOf(id)
  const sharedProps: Record<string, unknown> = {
    ...(props ?? {}),
    ...(nestedSlots.length === 0
      ? {}
      : {
          slots: Object.fromEntries(
            nestedSlots.map((slot) => [slot, <ExtSlotMount key={slot} slot={slot} />]),
          ),
        }),
  }

  let node: ReactNode = children
  if (replaceEntry) {
    const Replace = replaceEntry.component as ComponentType<Record<string, unknown>>
    const contribution = <Replace {...sharedProps} default={undefined} propsVersion={propsVersion} />
    /*
      ★ P9：声明了 `shadow: true` 的 replace 贡献渲染进 Shadow Root。

      顺序是**边界在外、隔离壳在内**（不是反过来）：边界的 `fallback` 是宿主默认实现，
      若把壳套在边界外面，一旦贡献抛错，回退出来的宿主默认元素也会被塞进 shadow root ——
      那是"控件还在、样式全丢"，比不隔离更坏。壳在边界内则失败路径完全走宿主原有渲染。
      跨 shadow 的 portal 抛错同样会被最近的错误边界接住（React 的错误沿 React 树冒泡，
      而不是沿 DOM 树），故这条顺序不会漏掉隔离壳里的异常。
    */
    node = (
      <ExtBoundary node={id} source={replaceEntry.source} mode="replace" fallback={children}>
        {replaceEntry.shadow ? <ShadowHost>{contribution}</ShadowHost> : contribution}
      </ExtBoundary>
    )
  }
  if (wrapEntry) {
    const Wrap = wrapEntry.component as ComponentType<Record<string, unknown>>
    const inner = node
    node = (
      <ExtBoundary node={id} source={wrapEntry.source} mode="wrap" fallback={inner}>
        <Wrap {...sharedProps} default={inner} propsVersion={propsVersion} />
      </ExtBoundary>
    )
  }
  if (extendEntries.length === 0) return node
  return (
    <>
      {node}
      {extendEntries.map((entry, index) => {
        const C = entry.component as ComponentType<Record<string, unknown>>
        return (
          <SlotErrorBoundary key={`${entry.source}#${index}`} source={entry.source}>
            <C {...sharedProps} propsVersion={propsVersion} />
          </SlotErrorBoundary>
        )
      })}
    </>
  )
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
  `插件界面「${name}」加载失败，相关功能在本页不可用。作者可能漏发产物，请在「插件管理」页检查。`

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
  '当前编辑器由插件提供，它没有插入附件的能力：拖入或粘贴的文件不会上传。请在「插件管理」页改用内置编辑器（内置编辑器支持拖拽与粘贴上传）。'

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
