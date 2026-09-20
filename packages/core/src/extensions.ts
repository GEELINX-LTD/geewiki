/**
 * 宿主节点（host node）目录与扩展模式契约 —— **浏览器安全的唯一真源**。
 *
 * ## 这个文件解决什么
 * 现有插槽机制能做的只有"在某处**追加**一块 UI"（`packages/core/src/slots.ts`）。
 * 用户诉求是「一切前端元素可被扩展、修改、替换」，于是需要把同一套机制泛化出
 * **三种模式**（{@link ExtMode}）与一份**宿主节点目录**（{@link HOST_NODE_CATALOG}），
 * 而不是新造一个与 Slot 并行的概念（设计真源：`docs/design/ui-extension-platform.md` §1）。
 *
 * ## 与 slots.ts 的关系（单一真源，不是两套）
 * - 7 个内置插槽**就是**目录里 `kind: 'slot'` 的条目，`HostNodeName` 直接**并**入
 *   {@link BuiltinSlotName}，**不在这里重抄一遍名字**（镜像漂移是本仓反复踩过的坑）。
 * - 插槽的占用基数仍以 `SLOT_CARDINALITY` 为唯一真源：`kind: 'slot'` 的条目
 *   **不得**自带 `extendCardinality`（守卫 `packages/core/test/extensions-catalog.test.ts` 钉住）。
 * - 插件自定义扩展点的语法沿用 `PLUGIN_SLOT_NAME`（含 `/`），不新造判据。
 *
 * ## 命名判据（硬约束，见设计文档 §2）
 * - **不含 `/`** ⇒ 宿主节点 id，必须在目录里；否则按**笔误**拒绝并告警。
 * - **含 `/`** ⇒ 插件自定义扩展点。
 *
 * 因此宿主节点 id **一律不含 `/`**（`shell-brand`，不是 `shell/brand`）：一旦宿主名里出现
 * `/`，"拼写错误的宿主节点名"就再也无法与"插件自定义扩展点"区分开。
 *
 * ## 本文件的两条硬约束（与 slots.ts 相同，由 `packages/core/test/slots-browser-safe.test.ts` 钉住）
 * 1. 不得引入任何 `node:*` / cordis / schemastery 依赖 —— 它要能被 Vite 打进浏览器 bundle。
 * 2. 不得 import 本包的 `index.ts`。
 */

import { SLOT_CARDINALITY, isBuiltinSlotName, isPluginSlotName, type BuiltinSlotName, type SlotName } from './slots.js'

/**
 * 贡献的**模式** —— 只有三种，语义见设计文档 §4。
 *
 * - `extend`：宿主元素照常渲染，贡献追加在其后（等价于今天的插槽）。
 * - `wrap`：贡献拿到宿主默认元素（`props.default`），返回自己的树 ⇒ 加壳而不重写内部。
 * - `replace`：贡献**完全接管**该节点，宿主默认不渲染。
 *
 * 为什么 `wrap` 与 `replace` 必须分开：`replace` 的作者要自己承担"控件还在不在"的责任
 * （无障碍、键盘可达、样式），`wrap` 不可能弄丢控件。合成一个 `override` 会让
 * "只想加个角标"的插件无意间承担 `replace` 的风险。
 */
export type ExtMode = 'replace' | 'wrap' | 'extend'

/** 节点的宿主归属分组（用于文档、管理台分组与"这一批是谁接的线"） */
export type HostNodeKind = 'slot' | 'shell' | 'page' | 'ui'

/**
 * 外壳节点（`App.tsx` 这一层）。
 *
 * **只登记"已经接线"的节点**：目录是"插件声明了就能生效"的承诺，把一个还没接线的
 * 名字放进来，插件会得到"声明成功、界面毫无变化"的静默失败——比拒绝更坏。
 * 每接入一个，在 {@link HOST_NODE_CATALOG} 里加一条并把名字加进本联合。
 *
 * - `shell-brand`：页头品牌位（**整块 `<a>`**：图标 + 字样 + 回首页链接）。
 *   `replace` 者负责完整的品牌标记（含链接语义与无障碍）——它是"换个牌子"的正规入口。
 * - `shell-brand-text`：**只**是品牌字样那个 `<span>`（`App.tsx` 的 `text-wordmark`）。
 *   存在的理由：最常见的需求是"改掉左上角那串字"，而为此替换整块 `<a>` 会连带
 *   丢掉链接与图标语义（用户只是想改名，不是想重写品牌区）。窄节点让责任与需求对齐。
 * - `shell-header`：顶栏**内容**（品牌 + 导航 + 搜索 / 外观 / 身份区）。
 *   ⚠️ `<header>` **元素本身**与 `app-header` 插槽出口由**宿主独占**（见下面"容器节点"一节）：
 *   `replace` 换掉的是整条顶栏的可见内容，而其他插件在页头的贡献**结构上不可能被它删掉**。
 *   与 `shell-brand` 的关系是"宽窄两档"：只想换一块的插件应当用更窄的节点。
 * - `shell-footer`：页脚**内容**（宿主默认内容为空）。`<footer class="app-footer">` 与
 *   `app-footer` 出口同样由宿主独占，故"空则不占位"那条 CSS 契约
 *   （`.app-footer:has(> .slot-outlet[data-count='0']:only-child)`）在接线后**逐字成立**：
 *   无贡献时 footer 的唯一子元素仍是那个 `.slot-outlet`。
 * - `shell-theme-toggle`：外观切换控件（宿主默认实现是浅 / 深切换按钮）。`replace` 者要自己
 *   负责读写主题（宿主把 `themeEpoch` 的重挂载留给默认实现，见 `App.tsx` 的注释）。
 * - `shell-command-palette`：命令面板（受控对话框，⌘K / Ctrl+K / `/` 打开）。`replace` 者要自己
 *   负责受控开关与焦点归还；**只想加命令的插件不必碰它**（用 `registerTool` 即可）。
 * - `shell-status-dialog`：系统状态对话框（受控）。它同时是"portal 类组件不接 `ui-*` 节点"
 *   的补偿路径：要自定义对话框外观，替换**使用它的宿主节点**而不是 Dialog 原语。
 *
 * ## 容器节点：内层插槽出口由宿主承载，插件可以摆放但**不可能删掉**
 *
 * `shell-header` / `shell-footer` 是**容器节点**：它们的 DOM 里原本嵌着一个多方共存的插槽出口
 * （`app-header` / `app-footer`）。若让单个插件的 `replace` 接管**整棵子树**，它就获得了
 * "删掉其他所有插件贡献"的权力——这与"`multi` 插槽不得 `replace`"是同一条纪律，
 * 只是藏在了一层 DOM 嵌套里（**这一版最初的接线正是这么错的，被用户当场驳回**）。故规则是：
 *
 * 1. **外壳元素与内层出口由宿主独占**：`<header>` / `<footer class="app-footer">` 及其中的
 *    插槽出口**永远由宿主渲染**，节点只覆盖容器**内容**。于是 `replace` 既换不掉外壳本身
 *    （定位 / 高度 / 底色仍由宿主类名与 `--gw-*` 令牌保证一致），也删不掉别人的贡献。
 * 2. **插件可以把它们摆进自己的标记里**：`props.slots` 形如 `{ [插槽名]: 挂载点元素 }`，
 *    贡献者在自己的输出里渲染 `props.slots['app-header']`，该出口就搬到那里
 *    （宿主用 portal 在**绘制前**搬运 ⇒ 无闪烁）。不渲染则出口留在宿主位置——
 *    **最坏情况只是位置不合意，永远不是丢失、也不会重复**。
 * 3. 每个内层出口**恰好渲染一次**：宿主渲染它，贡献者只决定它落在哪个挂载点。
 * 4. **落在 Shadow Root 内的挂载点会被忽略**（P11c，先实测后修）：容器节点上开
 *    `shadow: true` 仍然允许，但挂载点装的是**别人**的贡献，被 portal 进隔离根会丢掉
 *    全部宿主样式，而且在宿主视角与"贡献消失"无法区分（`document.querySelector` 不穿透 shadow）。
 *    故出口留在 light DOM 并告警一次——判据是纯函数 `isUsableMountTarget`（在 `lib/slots.tsx`）。
 *
 * `extend` 的追加语义不变（`Ext` 把 extend 条目渲染为被包裹节点的**兄弟**，
 * `packages/web/src/lib/slots.tsx` 的 `Ext` 实现）：在容器节点上，因为节点本身位于外壳元素
 * **内部**，追加出来的内容也就落在外壳里——页脚因此显形，符合直觉。
 *
 * ## 为什么没有 `shell-sidebar`
 * 设计文档初稿把"侧栏"列为候选，接线时发现**宿主外壳里没有这个元素**：桌面导航是
 * `<header>` 里的横向 `<nav>`（已由 `shell-header` 覆盖），阅读页的右栏/折叠块在
 * `WikiPage.tsx` 里、由 `wiki-toc` 覆盖。为一个不存在的元素登记名字，插件会得到
 * "声明成功、界面毫无变化"的静默失败——比拒绝更坏，故**移除该候选**而不是硬凑一个挂点。
 */
export type ShellNodeName =
  | 'shell-brand'
  | 'shell-brand-text'
  | 'shell-header'
  | 'shell-footer'
  | 'shell-theme-toggle'
  | 'shell-command-palette'
  | 'shell-status-dialog'

/**
 * 页面内**元素级**节点（P6）。
 *
 * 粒度是"页面上的一个元素"，**不是整页**：`wiki-meta` 是元信息行、`wiki-actions` 是操作条、
 * `wiki-toc` 是目录、`graph-toolbar` 是插件管理页的工具条、`account-profile` 是资料卡。
 *
 * ## 为什么不做整页替换（设计文档 §9.5）
 * 换掉整页等于插件自己实现路由、鉴权与数据加载——那已经不是一个"扩展点"，
 * 而是"用插件重写应用"。收益与风险不匹配，故 `kind: 'page'` 只提供元素级挂点。
 *
 * ## 与 `kind: 'ui'` 的区别（两者都允许三种模式，别混为一谈）
 * - `kind: 'ui'`：**组件原语**（`ui-button` 这类），在定义处接线，一次接线全站所有调用点生效；
 * - `kind: 'page'`：**具体页面上的具体位置**（"文章页的操作条"），只在那一处渲染。
 *   同一个 `ui-button` 会被几十处调用，而 `wiki-actions` 只在文章详情页出现一次。
 */
export type PageNodeName =
  | 'wiki-meta'
  | 'wiki-actions'
  | 'wiki-toc'
  | 'graph-toolbar'
  | 'account-profile'

/**
 * `packages/web/src/ui/*` 的**基础原语**节点（P7）。
 *
 * 这一组是「一切前端元素可被扩展」的关键杠杆：原语在**定义处**接线，于是全仓
 * 所有调用点（`Button` 有几十处，且多数是直接 `import '../ui/Button'`、不走 barrel）
 * 同时获得扩展能力——不需要逐页改。
 *
 * ## 为什么没有 portal 类组件（Dialog / ConfirmDialog / DropdownMenu / Tooltip）
 * 它们的根不是页面上被渲染的元素（Radix 的 `<Portal>` 把内容投到别处）。`replace` 尚可解释
 * （插件自己负责 portal），但 `wrap` 会在调用处留下一个**空的包裹元素**——一个肉眼可见的布局残留。
 * 与其提供一个语义可疑的模式，不如**先不接**：目录只登记"契约站得住"的节点。
 * 需要自定义对话框外观时，插件可以整块替换使用对话框的那个宿主节点（`shell-status-dialog` /
 * `shell-command-palette`，P11 起已接线），而不是替换 Dialog 原语。
 */
export type UiNodeName =
  | 'ui-badge'
  | 'ui-button'
  | 'ui-card'
  | 'ui-empty-state'
  | 'ui-error-notice'
  | 'ui-error-state'
  | 'ui-input'
  | 'ui-textarea'
  | 'ui-loading-state'
  | 'ui-skeleton'
  | 'ui-spinner'
  // portal 类（只开放 `replace`，见 `PORTAL_UI_MODES`）
  | 'ui-dialog-content'
  | 'ui-dropdown-menu-content'
  | 'ui-confirm-dialog'
  | 'ui-tooltip'

/**
 * 宿主节点 id 的联合。
 *
 * `BuiltinSlotName` 是**并入**而不是重抄：插槽名一旦在这里出现第二份字面量，
 * 就会漂移（漂移的表现是"后端登记了、前端当未知节点忽略"，日志干净）。
 */
export type HostNodeName = BuiltinSlotName | ShellNodeName | PageNodeName | UiNodeName

/**
 * 一个宿主节点的契约。
 *
 * 字段刻意少：节点的 `props` 全貌由 `SLOT_PROPS_SCHEMA`（插槽）或管理台登记（自定义）承担，
 * 这里只放**裁决需要**的事实，避免同一事实两处表示。
 */
export interface HostNodeSpec {
  readonly kind: HostNodeKind
  /**
   * 该节点**允许**的模式，必须含 `'extend'`（追加永远合法）。
   *
   * `replace` / `wrap` 必须逐个节点显式开启：不是每个节点都适合被整体替换
   * （例如 `app-footer` 被替换掉就等于宿主不再有页脚语义，收益与风险不匹配）。
   */
  readonly modes: readonly ExtMode[]
  /**
   * props 契约版本：**只做加法时不变**，删字段 / 改语义必须 +1。
   *
   * 插件在 `props.propsVersion` 里收到它并据此自我判断（不匹配时**不要**渲染，
   * 让宿主默认生效——比渲染出半坏界面更可预期）。
   */
  readonly propsVersion: number
  readonly description: string
  /**
   * 该节点的宿主默认实现**渲染在 portal 里**（Radix `Portal`），DOM 不在调用处。
   *
   * 为什么这是一个**事实标记**而不是注释：它决定了这个节点**不能开放 `wrap`**。
   * `wrap` 的契约是"把你的元素包在宿主默认实现外面"，而 portal 的内容挂在 `document.body`
   * 附近、**不在包装元素的子树里** ⇒ 包装元素落在调用处、样式与作用域都进不去，
   * 作者看到的是"我明明包住了，什么都没生效"。这不是"少了个能力"，是**静默失效**。
   *
   * 另两个模式仍然成立：`replace` 接管整个渲染（自己决定 portal 与否）、
   * `extend` 在调用处追加（看得见、位置可预期）。
   *
   * 守卫据此断言"标了 portal 的节点**不含 `wrap`**、且仍支持 `replace` 与 `extend`"
   * （`extensions-catalog.test.ts`），于是新增 portal 节点时**不可能**顺手拿到 `wrap`。
   */
  readonly portal?: true
  /**
   * `extend` 模式的占用基数。**仅非 slot 节点可设置**：`kind: 'slot'` 的基数
   * 一律取 `SLOT_CARDINALITY`（单一真源），在这里再写一份就是镜像。
   */
  readonly extendCardinality?: 'single' | 'multi'
  /**
   * 该节点**内部由宿主承载**的插槽出口（容器节点才有，见文件头"容器节点"一节）。
   *
   * 语义：这些出口**不随节点被替换而消失**——宿主永远渲染它们，贡献者只是通过
   * `props.slots[插槽名]`（一个挂载点元素）决定它们落在自己标记里的哪一处。
   * 因此 `replace` / `wrap` 在容器节点上**不可能**删掉其他插件的贡献。
   *
   * 为什么写进目录而不是只写在 `App.tsx`：这是**裁决与文档需要的事实**——
   * 守卫据此断言"声明了内层出口的节点，宿主确实承载了它"，插件作者也据此知道
   * `props.slots` 里会有什么。`kind: 'slot'` 的条目不得设置（插槽套插槽没有语义）。
   */
  readonly nestedSlots?: readonly SlotName[]
}

/**
 * `packages/web/src/ui/*` 的原语允许的模式。
 *
 * 三种都开放的依据：它们是**叶子元素**（一个 span / button / input / div），
 * `replace` 的意义明确（"我要自己的按钮"），`wrap` 不可能弄丢控件（默认元素在 `default` 里），
 * `extend` 是追加。风险由宿主侧的**回退语义**兜住（贡献渲染失败 ⇒ 回退默认实现）。
 */
const UI_MODES: readonly ExtMode[] = Object.freeze(['extend', 'wrap', 'replace'])

/**
 * **portal 类** ui 节点允许的模式：`extend` + `replace`，**不含 `wrap`**。
 *
 * ## 为什么不是"先不接"
 * 这四个（`ui-dialog-content` / `ui-dropdown-menu-content` / `ui-confirm-dialog` / `ui-tooltip`）
 * 曾经整批不接线，理由写的是"`wrap` 会在调用处留下空的包裹元素"。那个理由**不完整**：
 * 真正的问题是 **`wrap` 在这里不可能生效**——宿主的默认实现经 Radix `Portal` 渲染到
 * `document.body` 附近，**不在包装元素的 DOM 子树里**，所以包装元素既包不住它、
 * 也传不进样式（CSS 继承与选择器都跨不过 portal 边界）。作者看到的是"我包住了但什么都没变"。
 *
 * 于是取舍变成：要么整批不接（"一切界面元素可被扩展"留一个说不清的洞），要么**只砍掉真正
 * 坏掉的那个模式**。逐条看：
 * - `replace`：**接管整个渲染**（自己决定要不要 portal），语义完全成立，而且是自由度最高的模式；
 * - `extend`：在**调用处**追加一块——调用处就是"用到这个 tooltip / 对话框的地方"，
 *   追加的东西看得见、位置可预期，不涉及"装进 portal 里"这件事，因此成立
 *   （也满足"每个节点都必须支持 extend"这条既有不变量）；
 * - `wrap`：唯一**静默失效**的一个，砍掉它不是限制能力，是**不提供陷阱**。
 *
 * 插件侧的代价与其它 `replace` 一致（无障碍、焦点陷阱、Escape 关闭都转移到作者身上），
 * 且插件**能**做到：SDK 暴露了 `ReactDOM` / `createPortal` / `ReactDOMClient`。
 */
const PORTAL_UI_MODES: readonly ExtMode[] = Object.freeze(['extend', 'replace'])

/**
 * `kind: 'page'` 的页面内元素级挂点允许的模式（与 {@link UI_MODES} 同口径）。
 *
 * 三种全开的依据与 ui 一致：它们是**叶子元素**（一行元信息、一组按钮、一块目录），
 * `replace` 的语义明确（"这一块我要自己的"），`wrap` 不可能弄丢控件（默认元素在 `default` 里），
 * `extend` 是追加。风险同样由宿主侧回退语义兜住（贡献渲染失败 ⇒ 回退默认实现）。
 */
const PAGE_MODES: readonly ExtMode[] = Object.freeze(['extend', 'wrap', 'replace'])

/**
 * 宿主节点目录 —— 插件能声明/贡献的**全部**位置。
 *
 * 初版只有 7 个内置插槽（`kind: 'slot'`，语义与今天**完全一致**，故本文件的引入
 * 不改变任何既有行为）；`shell-*` / `ui-*` 由 P5–P7 逐个接线后加入。
 */
const CATALOG: Readonly<Record<HostNodeName, HostNodeSpec>> = Object.freeze({
  'app-header': {
    kind: 'slot',
    modes: ['extend'],
    propsVersion: 1,
    description: '页头（零属性，多方追加）',
  },
  'app-footer': {
    kind: 'slot',
    modes: ['extend'],
    propsVersion: 1,
    description: '页脚（零属性，多方追加）',
  },
  editor: {
    kind: 'slot',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '编辑区（单占用；可整体替换 ⇒ 换一个编辑器）',
  },
  'editor-toolbar': {
    kind: 'slot',
    modes: ['extend'],
    propsVersion: 1,
    description: '编辑页工具条（多方追加；不替换编辑区）',
  },
  'app-dock': {
    kind: 'slot',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '常驻底部输入条（单占用；AI 对话唯一入口）',
  },
  'article-summary': {
    kind: 'slot',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '文章标题下方的摘要位（单占用）',
  },
  'account-identities': {
    kind: 'slot',
    modes: ['extend'],
    propsVersion: 1,
    description: '账号页「外部身份（SSO）」区（多方追加）',
  },
  'shell-brand': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '页头品牌位（整块链接：图标 + 字样 + 回首页）',
  },
  'shell-brand-text': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '页头品牌**字样**（只替换文字，保留宿主的链接与图标）',
  },
  'shell-header': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '顶栏内容（品牌 + 导航 + 搜索 / 外观 / 身份区；<header> 外壳与 app-header 出口由宿主独占）',
    nestedSlots: ['app-header'],
  },
  'shell-footer': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '页脚内容（<footer class="app-footer"> 与 app-footer 出口由宿主独占，空时不占位）',
    nestedSlots: ['app-footer'],
  },
  'shell-theme-toggle': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '外观（浅 / 深）切换控件',
  },
  'shell-command-palette': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '命令面板（受控对话框：⌘K / Ctrl+K / `/`）',
  },
  'shell-status-dialog': {
    kind: 'shell',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    description: '系统状态对话框（受控）',
  },
  'wiki-meta': {
    kind: 'page',
    modes: PAGE_MODES,
    propsVersion: 1,
    description: '文章页元信息行（版本徽标 / 更新时间 / 快照加载提示）',
  },
  'wiki-actions': {
    kind: 'page',
    modes: PAGE_MODES,
    propsVersion: 1,
    description: '文章页操作按钮组（权限 / 删除 / 编辑）',
  },
  'wiki-toc': {
    kind: 'page',
    modes: PAGE_MODES,
    propsVersion: 1,
    description: '文章页目录（窄屏折叠块与右侧栏**两处同一个节点**）',
  },
  'graph-toolbar': {
    kind: 'page',
    modes: PAGE_MODES,
    propsVersion: 1,
    description: '插件管理页工具条（刷新与全局操作区）',
  },
  'account-profile': {
    kind: 'page',
    modes: PAGE_MODES,
    propsVersion: 1,
    description: '账号页「资料」卡（邮箱 / 用户名 / 改资料表单）',
  },
  'ui-badge': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '徽标（Badge）' },
  'ui-button': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '按钮（Button）' },
  'ui-card': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '卡片（Card）' },
  'ui-empty-state': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '空态（EmptyState）' },
  'ui-error-notice': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '错误提示条（ErrorNotice）' },
  'ui-error-state': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '错误态（ErrorState）' },
  'ui-input': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '单行输入（Input）' },
  'ui-textarea': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '多行输入（Textarea）' },
  'ui-loading-state': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '加载态（LoadingState）' },
  'ui-skeleton': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '骨架屏（Skeleton）' },
  'ui-spinner': { kind: 'ui', modes: UI_MODES, propsVersion: 1, description: '转圈（Spinner）' },
  /*
    portal 类：只开放 `replace`（理由见 `PORTAL_UI_MODES`）。节点名对应**真正渲染内容的那个
    导出**：`Dialog` / `DropdownMenu` 只是 Radix `Root` 的再导出（渲染不出 DOM，也不是可见元素），
    可见的对话框 / 菜单面由 `DialogContent` / `DropdownMenuContent` 渲染，故节点挂在后者上。
  */
  'ui-dialog-content': {
    kind: 'ui',
    modes: PORTAL_UI_MODES,
    portal: true,
    propsVersion: 1,
    description: '对话框面板（DialogContent，portal 渲染）',
  },
  'ui-dropdown-menu-content': {
    kind: 'ui',
    modes: PORTAL_UI_MODES,
    portal: true,
    propsVersion: 1,
    description: '下拉菜单面板（DropdownMenuContent，portal 渲染）',
  },
  'ui-confirm-dialog': {
    kind: 'ui',
    modes: PORTAL_UI_MODES,
    portal: true,
    propsVersion: 1,
    description: '危险操作确认框（ConfirmDialog，内含 portal 面板）',
  },
  'ui-tooltip': {
    kind: 'ui',
    modes: PORTAL_UI_MODES,
    portal: true,
    propsVersion: 1,
    description: '悬浮提示（Tooltip，portal 渲染）',
  },
})

/** 目录的只读视图（管理台与诊断端点据此下发"可用节点"） */
export const HOST_NODE_CATALOG: Readonly<Record<HostNodeName, HostNodeSpec>> = CATALOG

/** 全部宿主节点 id（顺序 = 目录声明顺序，可复现） */
export const HOST_NODE_NAMES: readonly HostNodeName[] = Object.freeze(
  Object.keys(CATALOG) as HostNodeName[],
)

/** 缺省模式：`extend`（只追加是风险最小的语义，也是既有插槽的行为） */
export const DEFAULT_EXT_MODE: ExtMode = 'extend'

/** 三种模式的完整列表（供校验与文档枚举使用；顺序 = 应用顺序） */
export const EXT_MODES: readonly ExtMode[] = Object.freeze(['replace', 'wrap', 'extend'])

/**
 * 是否宿主节点 id。
 *
 * 注意判据是**目录成员资格**，不是"语法看起来像"：`app-headr`（笔误）在这里返回 false，
 * 于调用方可以给出"你可能是想写 app-header"这样的告警，而不是把它当成一个新节点。
 */
export function isHostNodeName(name: unknown): name is HostNodeName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, name)
}

/**
 * 是否**任意合法扩展点名** = 宿主节点 ∪ 插件自定义扩展点。
 *
 * 与 `isSlotName`（`packages/manager/src/slots.ts:45`）判据一致，只是宿主侧的白名单
 * 从 7 个插槽扩为整份目录。
 */
export function isExtName(name: unknown): name is SlotName {
  return isHostNodeName(name) || isPluginSlotName(name)
}

/** 查目录条目；未知节点返回 `undefined`（调用方决定是告警还是忽略） */
export function hostNodeSpec(name: string): HostNodeSpec | undefined {
  return (CATALOG as Readonly<Record<string, HostNodeSpec>>)[name]
}

/**
 * 插件自定义扩展点**只允许**的模式。
 *
 * 为什么不为它背书 `replace` / `wrap`：那个扩展点的契约（props 语义、`single`/`multi`）
 * 由**开这个扩展点的插件**定义，宿主既不知道它的语义，也不知道替换掉它意味着什么。
 * 真需要"可被替换的自定义位置"，应该由宿主目录提供节点——那才是宿主能负责的位置。
 */
const PLUGIN_ONLY_MODES: readonly ExtMode[] = Object.freeze(['extend'])

/** 节点允许的模式；未知节点返回空数组（不是抛错——诊断端点要能容忍旧插件声明） */
export function extModesOf(name: string): readonly ExtMode[] {
  const spec = hostNodeSpec(name)
  if (spec) return spec.modes
  return isPluginSlotName(name) ? PLUGIN_ONLY_MODES : []
}

/** 该节点是否允许某个模式 */
export function supportsExtMode(name: string, mode: ExtMode): boolean {
  return extModesOf(name).includes(mode)
}

/**
 * `extend` 模式的占用基数。
 *
 * `kind: 'slot'` 取 `SLOT_CARDINALITY`（单一真源，见本文件头）；其余节点取目录声明，
 * 未声明即 `multi`——"没说过要独占"按可叠加处理是更安全的默认
 * （判错方向会把本来能共存的贡献抑制掉，且用户看不出原因）。
 *
 * 未知节点同样返回 `'multi'`：它要么会被上层按"未声明的自定义扩展点"处理，要么被拒绝，
 * 这里不做第三种裁决。
 */
export function extendCardinalityOf(name: string): 'single' | 'multi' {
  const spec = hostNodeSpec(name)
  if (spec?.kind === 'slot' && isBuiltinSlotName(name)) return SLOT_CARDINALITY[name]
  return spec?.extendCardinality ?? 'multi'
}

/**
 * 某个模式下的占用基数。
 *
 * `replace` / `wrap` **恒为 `single`**：这是模式定义的一部分（同一位置不可能同时被
 * 两个实现"完全接管"或"包两层"），不是可配置项。多方声明时按设计文档 §5
 * **激活顺序最早者胜出**，其余进 `suppressed` 并记为冲突。
 */
export function modeCardinalityOf(name: string, mode: ExtMode): 'single' | 'multi' {
  return mode === 'extend' ? extendCardinalityOf(name) : 'single'
}

/**
 * 该节点**内部由宿主承载**的插槽出口（容器节点才有，见文件头"容器节点"一节）。
 *
 * 宿主侧用它做两件事：① 给贡献者的 `props.slots` 造挂载点；② 断言"宿主确实承载了它"。
 * 对非容器节点（含未知/畸形名字）返回**空数组**——"没有内层出口"是正常状态，
 * 不需要调用方区分"未知节点"与"已知但没有"。
 */
export function nestedSlotsOf(name: unknown): readonly SlotName[] {
  return typeof name === 'string' ? hostNodeSpec(name)?.nestedSlots ?? [] : []
}
