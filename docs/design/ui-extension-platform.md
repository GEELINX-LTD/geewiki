# 界面扩展平台（UI Extension Platform）设计真源

> 目标（用户诉求原文口径）：**「一切前端元素可被扩展、修改、替换」+「所有主题统一化」**。
> 本文是这条链路的**唯一契约**：节点目录、模式语义、裁决规则、回退语义、主题令牌、
> API 形状、分阶段与验收。实现与本文不一致时，**以本文为准**（或先改本文）。

状态：P0（主题令牌统一化）**已落盘并有守卫**；P0b（令牌契约守卫）**已落盘**；
P1（本文）定档；P2 起为实现。

---

## 1. 为什么不是新造一套并行系统

现有链路已有一条**完整、有守卫、有诊断**的插件界面通路：

| 环节 | 现有真源 |
| --- | --- |
| 前端产物发现与加载 | `packages/manager/src/plugin-ui.ts` 双资产根 → `GET /api/plugins/ui` → `packages/web/src/lib/pluginUi.ts` 动态 `import()` |
| 贡献登记 | 清单 `geewiki.slots` + 运行期 `ctx.get('slot').contribute(...)`（`packages/manager/src/slots.ts`） |
| 基数裁决 | 纯函数 `resolveSlots()`（`packages/manager/src/slots.ts:123`） |
| 渲染出口 | `packages/web/src/lib/slots.tsx` 的 `SlotOutlet` + 每个贡献一个 ErrorBoundary |
| 冲突诊断 | `GET /api/plugins/slots`（读端点 public）→ 管理台告警块 |
| 插件 API | `window.__GEEWIKI_HOST__`（`packages/web/src/lib/hostSdk.ts`，v0.9.0） |

**决策**：把这套机制**泛化**为「宿主节点（host node）扩展点」，而**不是**新建 Slot 2.0 之类
的平行概念。理由：插件生命周期回收、基数裁决、冲突诊断、产物加载、ErrorBoundary 这五件事
都已经解决过一次；再建一套就要再解决一次，且用户会面对两个语义相近的 API。

泛化的具体动作：`SLOT_NAMES`（7 个）成为**节点目录的子集**，
`SlotRegistry` / `resolveSlots` / `SlotOutlet` 分别演进为 `ExtRegistry` / `resolveExtensions` / `<Ext>`，
**服务名与端点路径不变**（`ctx.get('slot')`、`GET /api/plugins/slots`），避免动到那条
「提供者必须排在管理器之前」的时序约束（根因见 `packages/manager/src/slot-plugin.ts` 文件头）。

---

## 2. 命名空间判据（不动摇）

沿用既有的**语法切分**，不引入第二套规则：

- **不含 `/`** ⇒ 宿主节点 id，**必须**在节点目录（`HOST_NODE_CATALOG`）里。
  不在目录里又不含 `/` 的名字（`ui-buton`、`shell-brandd`）⇒ **按笔误拒绝并告警**。
- **含 `/`** ⇒ 插件自定义扩展点，须匹配 `PLUGIN_SLOT_NAME`
  （`packages/core/src/slots.ts:91`：`/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/`）。

因此**宿主节点 id 一律用连字符、绝不含 `/`**（`shell-brand` 而非 `shell/brand`）：
若宿主节点名里出现 `/`，上面那条判据立刻失效——插件可以"自证"成宿主节点，
而"拼写错误的宿主节点名"再也无法被识别。这是本设计**唯一**的硬命名约束。

---

## 3. 节点目录（catalog）

目录条目（`packages/core/src/extensions.ts`，浏览器安全：不得引 `node:*` / `cordis` / `schemastery`，
由 `packages/core/test/slots-browser-safe.test.ts` 同款守卫钉住）：

```ts
interface HostNodeSpec {
  /** 稳定 id，小写连字符，不含 `/`。改 id = 破坏性变更 */
  readonly id: HostNodeName
  readonly kind: 'slot' | 'shell' | 'page' | 'ui'
  /** `extend` 之外还允许哪些模式；`replace` 单独列出，因为它要求作者明确声明 */
  readonly modes: readonly ExtMode[] // 'replace' | 'wrap' | 'extend'
  readonly defaultMode: ExtMode
  /** props 契约版本：只做加法时不变；删/改字段必须 +1 */
  readonly propsVersion: number
  readonly description: string
}
```

**范围**（P5–P7 已落地，见 §10）分四组：

1. `kind: 'slot'` —— 既有 7 个，语义**完全不变**（`app-header`/`app-footer`/`editor`/
   `editor-toolbar`/`app-dock`/`article-summary`/`account-identities`）。它们的 `modes = ['extend']`，
   其中单占用者（`editor`/`app-dock`/`article-summary`）额外允许 `replace`、`wrap`——
   这正是插件作者今天想做而做不到的事（换一个编辑器）。
2. `kind: 'shell'` —— 外壳可替换件。**已接线 7 个**（P11 收尾后候选已清空）：
   `shell-brand`（页头品牌位：整块 `<a href="#/wiki">`，含图标 + 字样 + 回首页链接）与
   `shell-brand-text`（**只**是那串字样 `App.tsx` 的 `.text-wordmark`；最常见的需求是
   "改掉左上角那串字"，而为此替换整块 `<a>` 会连带丢掉链接与图标语义——窄节点让责任与需求对齐）；
   另有五个外壳节点：`shell-header`（顶栏**内容**：品牌 + 导航 + 搜索 / 外观 / 身份区）、
   `shell-footer`（页脚**内容**，宿主默认内容为空）、`shell-theme-toggle`（外观切换控件）、
   `shell-command-palette`（命令面板）、`shell-status-dialog`（系统状态对话框）。
   ⚠️ `shell-header` / `shell-footer` 是**容器节点**（见 §4.5）：`<header>` / `<footer class="app-footer">`
   元素与 `app-header` / `app-footer` 插槽出口**由宿主独占**，`replace` 只换内容——
   这是"单个插件不可能删掉其他插件贡献"的结构保证（**初版接线把整个 `<header>` 交给 replace，
   被用户当场驳回**）。
   后两个仍然是"要自定义**整套对话框流程**"时的补偿路径——替换**使用对话框的宿主节点**
   （`shell-status-dialog` / `shell-command-palette`，§9.4）。
   原候选里的 **`shell-sidebar` 已移除**：宿主外壳里**没有这个元素**（桌面导航在 `<header>` 的
   `<nav>` 里、阅读页右栏由 `wiki-toc` 覆盖），为不存在的元素登记名字比拒绝更坏（§9.7）。
   ★ `extend` 的追加语义：`Ext` 把 extend 条目渲染为被包裹节点的**兄弟**，而在容器节点上
   节点本身位于外壳元素**内部**，故追加出来的内容也落在外壳里（`extend shell-footer`
   ⇒ 内容在 `<footer>` 内、页脚因此显形，符合直觉）。
3. `kind: 'page'` —— 页面内的**元素级**挂点（不是整页替换）。**已接线 5 个**：
   `wiki-meta`（文章页元信息行）、`wiki-actions`（文章页操作按钮组）、`wiki-toc`
   （文章页目录，**窄屏折叠块与右侧栏两处共用同一个 id**）、`graph-toolbar`（插件管理页工具条）、
   `account-profile`（账号页「资料」卡）。整页替换不做（风险与收益不匹配：整页换掉等于插件
   自己实现路由与权限判定）。
4. `kind: 'ui'` —— `packages/web/src/ui/*` 的**基础原语**，**已接线 11 个**：`ui-badge`、`ui-button`、
   `ui-card`、`ui-empty-state`、`ui-error-notice`、`ui-error-state`、`ui-input`、`ui-textarea`、
   `ui-loading-state`、`ui-skeleton`、`ui-spinner`（完整名单以 `HOST_NODE_CATALOG` 为准）。
   这一组是「一切元素」的关键杠杆：**在组件定义处包一层，全站所有调用点同时生效**
   （`packages/web/src/ui/*.tsx` 末尾的 `withExt('ui-x', XBase)`），不需要逐页改。
   **portal 类（`ui-dialog-content` / `ui-dropdown-menu-content` / `ui-confirm-dialog` /
   `ui-tooltip`）已接线，但只开放 `extend` + `replace`**（`PORTAL_UI_MODES`）：它们的可见内容
   经 Radix `<Portal>` 渲染到 `document.body` 附近、**不在调用处的 DOM 子树里**，而 `wrap` 的契约
   是"把你的元素包在宿主默认实现外面"——包装元素**装不下** portal 的内容，样式与选择器也跨不过
   portal 边界，作者看到的是"我明明包住了，什么都没变"。**砍掉它是不提供陷阱，不是限制能力**：
   `replace`（接管渲染，自由度最高）与 `extend`（在调用处追加，看得见、位置可预期）都成立。
   目录里标 `portal: true`（**事实标记**），守卫按规则钉住"标了 portal 的节点不得含 `wrap`"。
   节点名对应**真正渲染内容的导出**：`Dialog` / `DropdownMenu` 只是 Radix `Root` 的再导出
   （渲染不出 DOM、也不是可见元素），故不进目录。

---

## 4. 模式语义（三种，仅此三种）

设宿主默认实现为 `D`，节点上的生效贡献为 `W`（wrap 胜出者，至多一个）、
`R`（replace 胜出者，至多一个）、`E₁…Eₙ`（extend，按激活顺序全部生效）：

```
结果 = extend( wrap( replace( D ) ) )
       ├─ 有 R 且 R 渲染成功 ⇒ 用 R 的输出替代 D（W 仍然包在它外面）
       ├─ 无 R              ⇒ 用宿主默认 D
       └─ 任一环节失败      ⇒ 该环节回退到"没有它的结果"（见 §6）
```

- **`extend`**（默认，multi）：宿主元素**照常渲染**，贡献追加在其后。等价于今天的 Slot。
- **`wrap`**（single）：贡献拿到宿主默认元素作为 `props.default`（一个已渲染的 ReactNode），
  返回自己的树 ⇒ 可以加壳（外框、角标、上下文菜单）而不重写内部。
- **`replace`**（single）：贡献**完全接管**该节点，宿主默认不渲染。这是"改 GeeWiki 字样"
  的正规做法。

**为什么 `wrap` 与 `replace` 分成两种**：`replace` 需要作者承担"这个控件还在不在"的责任
（无障碍属性、键盘可达、样式）；`wrap` 不可能弄丢控件。把两者混成一个 `override` 会让
"只想加个角标"的插件无意间承担 `replace` 的风险。

**顺序为什么是 replace → wrap → extend**：先确定"渲染什么"（R 或 D），再"包一层"（W），
最后"追加"（E）。这个次序是**纯函数式**的（每步只依赖上一步的输出），因此可以脱离 React 描述、
在单测里断言字符串，而不必起 DOM。

### 4.5 容器节点：内层插槽出口由宿主承载（`nestedSlots`）

`shell-header` / `shell-footer` 的 DOM 里嵌着一个**多方共存**的插槽出口（`app-header` /
`app-footer`）。若让单个插件的 `replace` 接管**整棵子树**，它就获得了"删掉其他所有插件贡献"
的权力——这与"`multi` 插槽不得 `replace`"是同一条纪律，只是藏在了一层 DOM 嵌套里。
**本平台初版接线正是这么错的（`replace shell-header` 连插槽出口一起接管），被用户当场驳回。**

规则（目录字段 `HostNodeSpec.nestedSlots`，真源 `packages/core/src/extensions.ts`）：

1. **外壳元素与内层出口由宿主独占**。`<header>` / `<footer class="app-footer">` 与其中的
   插槽出口**永远由宿主渲染**，节点只覆盖容器**内容**。于是 `replace` 既换不掉外壳本身
   （定位 / 高度 / 底色仍由宿主类名与 `--gw-*` 令牌保证一致），也删不掉别人的贡献。
   宿主侧渲染点是 `<NestedSlotOutlet node slot>`（`packages/web/src/lib/slots.tsx`）。
2. **贡献者可以把出口摆进自己的标记里**：`props.slots` 形如 `{ [插槽名]: 挂载点元素 }`
   （挂载点是 `<span data-ext-slot-mount="…" style="display: contents">`，`ExtSlotMount`）。
   在自己的输出里渲染它，出口就搬到那里。
3. **恰好渲染一次**：宿主渲染它，贡献者只决定它落在哪个挂载点。搬运由宿主在**绘制前**完成
   （挂载点 `useLayoutEffect` 登记 ⇒ 承运者经 `useSyncExternalStore` 同步重渲染 ⇒ portal），
   因此没有闪烁；未渲染挂载点时留在宿主位置。
   **最坏情况只是位置不合意，永远不是丢失、也不会重复**（"忘了渲染 `props.slots`"不会造成
   静默失效，这是它相对"插件负责渲染别人的贡献"的关键优势）。

**代价（如实记录）**：贡献者不能替换 `<header>` / `<footer>` 元素本身，也不能把别人的贡献
搬到宿主外壳之外。要"完全自定义外壳"目前不支持——那正是会删掉其他插件贡献的那种权力。
`extend` 在容器节点上的行为与别处一致（兄弟追加），只因节点位于外壳内部而落在外壳里。

**与 Shadow DOM 的交互（P11c，先实测再修）**：容器节点上的 `replace` **可以**同时声明
`shadow: true`（隔离对自己仍然生效），但**落在 Shadow Root 内的挂载点会被忽略**，出口留在
light DOM 宿主位置，并告警一次。理由：挂载点装的是**其他插件**的贡献，一旦被 portal 进隔离根，
它们会丢掉全部宿主样式，而且从宿主视角看**与"贡献消失"完全一样**（`document.querySelector`
不穿透 shadow —— 未修复时的 CDP 读数就是 `counterLight:false, outletsLight:0`，
两侧都查才看到 `counterShadow:true, outletsShadow:1`）。判据是纯函数
`isUsableMountTarget(el, doc)`（`el.isConnected && el.getRootNode() === document`），
注册时另有一条提前告知的告警。

---

## 5. 裁决（与既有 single 规则同源）

沿用 `resolveSlots()` 已确立的规则，**不新造**：

- `replace` / `wrap` 是**单占用**：多方声明时 **激活顺序最早者胜出**，其余进 `suppressed`
  并被记为冲突（`SlotConflict` 同款结构）。理由见 `packages/manager/src/slots.ts:117`：
  最新胜出会让后来者**静默顶掉**正在工作的实现，用户只看到"东西被换了"却没有任何提示。
- `extend` 是**叠加**：全部生效，按激活顺序渲染。
- 冲突必须**可见**：`GET /api/plugins/slots` 的 `suppressed` + 管理台告警块
  （`packages/web/src/pages/GraphPage.tsx` 的既有插件管理页），文案需区分
  "被抑制"与"渲染失败回退"——这是两种完全不同的处置路径。
- **前端只认 effective**：被抑制的 owner **不得注册组件**（既有裁决：后端在生效集合为空时
  会省略 `slots` 键，前端据此判断），否则会出现"后端说没生效、前端却渲染了"的分裂。

---

## 6. 失败语义（已与用户定档）

| 模式 | 贡献渲染抛错时 | 诊断可见性 |
| --- | --- | --- |
| `replace` | **回退宿主默认实现**（控件不消失） | `console.error`；`extFailures()` 记录；管理台可列出 |
| `wrap` | 同上（回退到未包裹的宿主默认） | 同上 |
| `extend` | 只丢弃该条贡献，渲染既有 `.slot-error` 提示（`packages/web/src/lib/slots.tsx` 的 `SlotErrorBoundary`） | 可见文案：「插件界面渲染失败」 |

> **与初版设计的一处偏离（以实现为准）**：初版写的是"外层元素带 `data-ext-fallback="<owner>"`"。
> 实现改为 `extFailures()` 记录（`packages/web/src/lib/slots.tsx`），**没有**加那个标记属性——
> 标记需要额外的包裹元素，而回退路径恰恰发生在 `<tr>` / flex 行这类位置，多一层元素会造成
> 布局错位甚至非法 HTML。"控件没消失"必须是真的没变化，不能为了可诊断性引入新问题。

**要点**：`replace` / `wrap` 的失败**绝不**能表现为"控件不见了"——那会让整页不可用，
且用户不知道是谁干的。因此这两条路径的错误边界**内建默认实现**（boundary 自己持有 `D`），
而不是渲染一个错误占位。

---

## 7. 主题层（P0 已落盘的部分 + 本节余项）

### 7.1 单一令牌空间（已落盘）

- **真值只在 `--gw-*`**，且**必须声明在非 `@theme` 块**（`:root` / `.dark` / `@media`）——
  Tailwind v4 的 `@theme` **不输出**自定义属性声明。守卫：`packages/web/test/themeTokenContract.test.ts`。
- `@theme inline` 与契约块（`:root` 第 4b 节）**只放 `var(--gw-*)` 别名**。
  守卫：同文件（阴性对照实测：把 `@theme inline` 里的 `--radius-md` 改成字面值 `8px` 会红）。
- 六类尺度已全部进入 `--gw-*`：`--gw-text-*`、`--gw-radius-*`、`--gw-shadow-*`、
  `--gw-ease-*`、`--gw-z-*`、`--gw-spacing-*`（真值表钉在同一条守卫里）。
- **直接收益（已由守卫钉住）**：`registerTheme` 的 `TOKEN_NAME` 只放行 `--gw-*`
  （`packages/web/src/lib/pluginTheme.ts:57`），因此在 P0 之前**字号 / 圆角 / 阴影 / 层级
  对插件完全不可改**；现在它们与颜色同处一个命名空间，`registerTheme` 一次覆盖全站尺度。

### 7.2 插件侧约束（P10 已落地）

- 插件 CSS **只许** `var(--gw-*)`，**禁止硬编码颜色**（`#rgb`、`rgb()`、`hsl()`、常见颜色关键字）。
  判据是精确的：**把 `var(...)` 调用整体摘掉，再在剩下的文本里找颜色字面量**——
  于是本仓夹具的约定 `var(--gw-accent-soft-ink, #1d4ed8)`（插件不假定 token 一定存在）
  **合法**，而 `color: #1d4ed8` 违规。实现 `packages/web/src/lib/pluginCssPlan.ts`，
  守卫 `packages/web/test/pluginCssGuard.test.ts`（扫夹具源码 + `plugins/*/dist/client.css` 产物，
  后者曾因此抓到"改了源码但没重建产物"）。
- 回退值**允许但不豁免名字检查**：回退值会把"token 名写错"变成静默降级（`--gw-muted` 那次事故），
  故名字存在性由 `packages/web/test/fixtureTokens.test.ts` 静态守卫。
- 硬编码的颜色还有一个更隐蔽的后果：**对比度告警看不见它**——算不出来的颜色不会被报告。

### 7.3 隔离（P9 已落地，可选）
`replace` 模式额外允许贡献声明 `shadow: true`（`registerExtension(node, c, { mode: 'replace', shadow: true })`）：
宿主把它渲染进 Shadow Root。

- **能穿透**：CSS 自定义属性（`--gw-*`）**会**跨 shadow 边界继承 ⇒ 令牌自动生效，
  这正是选择「令牌 + Shadow DOM」而不是「类名 + Shadow DOM」的原因。
  CDP 实证：shadow 内 `style="color: var(--gw-accent)"` 与宿主内同值。
- **不能穿透**：宿主的 Tailwind 工具类**进不去** shadow root ⇒ 声明者必须自带样式。
  CDP 实证：shadow 内 `.font-bold` 的字重是 400（继承值），宿主内同 class 是 700。
- **包装元素**：`attachShadow` 必须挂在一个元素上，故宿主引入一个
  `<span data-ext-shadow style="display:contents">`——`display: contents` 让它**不生成盒子**，
  对栅格 / flex 行 / `<tr>` 的排版没有影响（CDP 实证计算值为 `contents`）。
- **只在 `replace` 上成立**：`wrap` 的宿主默认元素在 shadow 之外（隔离只隔离得了自己）、
  `extend` 只是追加一块。在其余模式上传 `shadow` 会**丢弃该标志并告警**，
  但**不丢弃整条贡献**——"隔离没生效"与"组件根本没渲染"的严重程度完全不同。
- **SSR 下是空的**（刻意）：Shadow Root 只能由 DOM API 创建；本仓是纯 SPA（§9.6），
  用"先内联渲染再搬进 shadow"来掩盖它只会造成真实的重复渲染与闪烁。
- 默认**不开**：Shadow DOM 会让调试、打印样式、`::selection` 等行为与常规渲染不同，
  应当是作者明确选择的取舍，而不是所有人默默承受的差异。
- **容器节点上的边界（P11c）**：在 `shell-header` / `shell-footer` 上开隔离**仍然允许**，
  但 `props.slots` 的挂载点若落在 Shadow Root 内会**被忽略**（出口留在 light DOM）并告警一次。
  理由与实测证据见 §4.5 末段与 §9.10：挂载点装的是**别人**的贡献，被拖进隔离根会丢掉宿主样式，
  且在宿主视角与"贡献消失"无法区分。

### 7.4 对比度告警（P10 已落地）

复用 `packages/web/src/lib/contrastPlan.ts`：`themeContrastIssues()`（`pluginTheme.ts`）
对每个主题贡献的**文字 × 背景** token 对做 ≥4.5:1 校验，不达标在**管理台**告警
（`packages/web/src/pages/GraphPage.tsx` 的插件管理页新增告警块；不阻断注册——
糟糕主题的最终判据是运维，而不是让宿主替用户决定）。

- 配对表按 **token 名**（`THEME_TEXT_TOKENS` × `THEME_BACKGROUND_TOKENS`），因为插件覆盖的是 token。
- 背景值解析顺序：贡献自己的值 → 合并后的生效值 → **沿 `var()` 链从文档解析**
  （`getComputedStyle` 对自定义属性返回的是指定值如 `var(--gw-gray-50)`，不解析链就只能检查
  "贡献同时给了文字与背景"这一种情形，而最常见的坏主题恰恰是只改了一个文字色）。
- 两侧都解析不出 `#rrggbb` 时**跳过**而不是报失败：报告一个算不出来的失败会让告警迅速变成噪声。

---

## 8. API 形状

### 8.1 清单（后端声明）

```jsonc
{
  "geewiki": {
    // 既有：等价于 { node: <name>, mode: "extend" }
    "slots": ["app-header"],
    // 新增：显式模式
    "extensions": [
      { "node": "shell-brand", "mode": "replace" },
      { "node": "ui-button", "mode": "wrap" }
    ]
  }
}
```

### 8.2 运行期（服务端）

`ctx.get('slot')`（服务名不变）：

```ts
contribute(owner, node, meta?)          // 既有：等价 extend（保持兼容）
extend(owner, node, mode, meta?)        // 新增；mode 缺省取目录的 defaultMode
define(node, spec)                      // 面向"插件自开扩展点"：登记自定义节点 + cardinality
```

### 8.3 前端（宿主 SDK，`window.__GEEWIKI_HOST__`）

```ts
registerExtension(node, component, opts?)   // 新增；返回撤销函数。opts = { mode?, shadow? }
registerSlot(name, component)               // 既有：等价 registerExtension(name, c, { mode: 'extend' })
PluginSlotOutlet / useSlotEntries           // 既有
themeContributors / registerTheme           // 既有
```

#### 8.3.1 两个形态，以及为什么**受限宿主**也必须提供 `registerExtension`（P12 / P13）

插件 bundle 有两种写法：`export function register(host)`，与**模块求值时**直接调
`window.__GEEWIKI_HOST__`。P13 之后**两者行为完全一致**——加载期间全局对象**就是**按插件作用域
构造的那个宿主（`pluginUi.ts` 的 `installPluginScope`）：

| 形态 | 拿到什么 | 注册来源（`source`） | 卸载时能否按 owner 回收 | 越权闸门 |
| --- | --- | --- | --- | --- |
| `export function register(host)` | **作用域宿主** `PluginUiHost` | 插件名 | ✅ 收集 disposer | ✅ 两道闸门 |
| 顶层直接调全局 SDK | **同一个对象**（加载期间被临时装上） | 插件名 | ✅ 同一份 disposer | ✅ 同一套闸门 |

P12 之前，受限宿主上**只有 `registerSlot`**（= 只会 `extend`）⇒ 走这条正规形态的插件**用不了**
`replace` / `wrap` / `shadow`；改用全局 SDK 又丢掉归属与闸门。两个形态各缺一半，等于
"带模式注册"没有一条既受管辖、又能被回收的路。现在受限宿主也提供 `registerExtension`，
参数与全局 SDK 同义（`opts = { mode?, shadow? }`）。

**为什么必须是"加载期间临时装上全局对象"，而不是"让插件改用参数"**：顶层形态没有别的入口可用
（模块求值期宿主还没调到 `register`），而两种形态行为不一致的代价是**静默**的——作者换一种写法，
贡献就悄悄变成收不回、不受管辖。作用域因此由**构造**保证，不依赖作者写对哪一种。

**栈式安装与还原**（`scopeStack`）：`import()` 是异步的，若两次加载在 await 处交错，"还原成我
进来时看到的那个"会把先装的那层一起抹掉（那段时间里插件注册的东西又落回 `host-sdk` 名下）。
栈的语义是"撤销我这一层、回到栈顶"，全部撤销后必然回到基础 SDK。作用域**覆盖 `import()` 与
`register(host)` 两段**，`finally` 保证每个出口（含失败、迟到、入口抛错）都还原。

随之成立的三件事：

1. **顶层注册也能被回收**：模块求值期的注册进的是**同一份** `disposers`，`unloadPluginUi` 照常
   执行；不导出 `register(host)` 的 bundle 现在**照样登记**（以前直接 `return`：既没进 `loaded`
   ⇒ 停用时收不回，也不受 `failed` / `loaded` 短路保护 ⇒ 每轮轮询重复 import）。失败/迟到路径
   同样会回滚模块求值期已经注册的部分，不留半截 UI。
2. **作用域宿主 = 完整 SDK**：`registerTool` / `registerTheme` / `registerMarkdownExtension` /
   `unregister*` / `ReactDOM` / `t` / `PluginSlotOutlet` … 全部可用，注册一律归属插件名。
   实现是 `{ ...sdk, …覆盖注册与注销两类 }`——**摊开**而不是逐项转发：逐项转发意味着 SDK 每加一个
   成员就多一处必须同步的副本，而漏掉的症状是"插件里那个字段是 undefined"，只在真正调用时才炸
   （`hostSdkSurface.test.ts` 的文件头记着同一类坑）。作用域宿主另有全局 SDK **没有**的字段
   `pluginName`（"我是谁"，模块求值期即可用）。
3. **注销只作用于自己的来源**：`unregisterThemes('other-plugin')` 这类调用在作用域宿主上
   **告警并拒绝**（全局 SDK 上它一直合法 ⇒ 任何插件都能拆掉别的插件的主题 / 路由 / 工具，
   被拆的一方只看到"我的界面不见了"、查不到是谁干的）；`unregisterSlot(node)` 不带 token 时
   也只清自己的来源（旧写法会删掉该节点上**所有**插件的贡献）。

> `'host-sdk'` 现在只剩一个含义：**没有插件作用域时的来源**（宿主自己的代码，或插件在加载结束
> 之后才注册的东西）。它仍然可诊断——管理台里来源是 `host-sdk` 就说明这条贡献不归任何插件。


#### 8.3.2 两道越权闸门（`registerSlot` 与 `registerExtension` 共用）

单占用节点的权威裁决在服务端，被抑制的插件**仍然是 active 的**（bundle 照样加载、照样注册），
所以前端必须自己拦：

1. **主判据**：`GET /api/plugins/slots` 的 `suppressed`（`slots[]` **与** `extensions[]` 两个数组都要读）。
   只读 `slots[]` 覆盖不到 `ui-*` / `shell-*` / `page` 节点 —— 两个插件抢同一个 `ui-button` 时，
   被抑制者会蒙混过关，而 `Ext` 按**注册顺序**取第一个 ⇒ 可能渲染出被抑制的那一个。
2. **次判据**：入口表的生效节点（`slots` ∪ `extNodes`，**逐字段**校验：某字段缺省 ⇒ 不校验该空间）。
   字段缺省意味着"纯浏览器侧注册的插件"（不在后端 owners 里），这条既有行为必须保留。
   两个字段**刻意不合并**：合并会让只声明 `geewiki.extensions` 的插件，其**既有**的插槽注册
   被突然拦下（插件没改一行，界面却少一块）。

入口表因此新增 **`extNodes`** 字段（生效的非插槽节点；与 `slots` 互不重叠，空值省略、计入 `revision`）。
判据是**两个名字空间各用各的判定函数**：插槽用 `isSlotName`（内置插槽 ∪ 含 `/` 的自定义扩展点），
宿主节点用 `isExtName`（目录 ∪ 自定义扩展点）。混用不报错、只**静默失效**——P12 第一版正是这么写的，
被 `packages/web/test/pluginUiPlan.test.ts` 当场抓到（`ui-button` 被当非法名逐条丢弃 ⇒ 闸门形同不存在）。

`shadow`（P9，仅 `replace` 有意义，见 §7.3）是**客户端**声明的：它影响的是渲染方式，
与清单无关（清单的 `geewiki.extensions` 只回答"这个插件**可以**往哪些节点贡献、允许哪些模式"，
那份判据在服务端）。`HOST_SDK_VERSION` 因此从 `0.10.0` 升到 `0.11.0`；
插件应**特性探测**（`typeof host.registerExtension === 'function'`）而不是比版本号。

`component` 接收的 props 在既有 `SlotProps`（`packages/core/src/slots.ts` 的 `SLOT_PROPS_SCHEMA`）
基础上统一增加：

- `default: ReactNode` —— 宿主默认实现（`wrap` 模式必须使用；`replace` 忽略）
- `propsVersion: number` —— 该节点的契约版本；插件据此自我判断（版本不匹配时**不要**渲染，
  让宿主默认生效，比渲染出半坏界面更可预期）

### 8.4 诊断端点

`GET /api/plugins/slots` 保持路径与 public 姿态，响应条目增加 `modes` / `suppressed` / `fallbacks`；
新增 `version` 字段以便前端按版本解析（既有前端解析器 `packages/web/src/lib/pluginUiPlan.ts`
`readSuppressed` 已是"从宽解析"，新字段按同一姿态处理：坏掉不影响加载）。

---

## 9. 安全与已知边界（必须如实写在文档里）

1. **没有沙箱**：插件产物在页面 JS realm 内运行，拥有完整 DOM 与网络能力。
   扩展点是**协作契约**，不是安全边界——能装插件的人本来就能改整站。
2. **样式默认不隔离**：插件 CSS 仍以全局 `<link>` 注入，可命中任何宿主类名（既有行为，未改变）。
   `shadow: true` 是 `replace` 模式上的**显式可选**隔离（§7.3），需要插件自带样式。
3. **ESM 实例不回收**：产物更新后需**整页刷新**才生效（`packages/web/src/lib/pluginUi.ts` 的既有裁决）。
4. **裁决只看激活顺序**：没有"某插件优先"的显式权重；互斥应通过 `conflictGroup` 声明。
5. **整页替换不做**：`kind: 'page'` 只提供元素级挂点。
6. **无服务端渲染**：扩展点只在浏览器侧生效，`GET /` 的首屏 HTML 不含插件内容
   （`shadow: true` 的内容在 SSR 下更是空的，见 §7.3）。
7. **目录只登记"已经接线"的节点**：没接线的名字放进去，插件会得到"声明成功、界面毫无变化"
   的静默失败——比拒绝更坏。P11 起设计文档点名的外壳候选**已全部接线**（7 个 `shell-*`），
   接线同时补了 `packages/web/test/shellChromeExt.test.ts` 那套"目录 ⇄ 源码双向比对"；
   `shell-sidebar` 因**外壳里不存在该元素**被移除（是决定，不是漏做）。
   纪律仍然有效：**今后新增任何节点，先接线再登记**。
8. **两条端到端缺口**（P11 如实登记，详见 §11）：陈旧脚本 `plugin-ui-cdp.mjs` 待修；
   插件 bundle → `registerExtension(mode)` 这条链目前只有单测覆盖。
9. **容器节点的外壳元素不可替换**（§4.5 的代价）：`shell-header` / `shell-footer` 的
   `<header>` / `<footer>` 元素由宿主独占，贡献者换不掉它本身（定位 / 高度 / 底色随宿主），
   也**不能把内层插槽出口搬出外壳之外**。要"完全自定义外壳"目前不支持——那正是会删掉
   其他插件贡献的那种权力。**这是决定，不是待办**（除非将来能给出"替换外壳但保证多方贡献"
   的可验证机制）。
10. **Shadow Root 内的挂载点被忽略**（§4.5 末段，P11c）：容器节点上的 `replace` 声明
   `shadow: true` 时，`props.slots` 的挂载点若落在隔离根内就**不生效**（出口留在 light DOM）。
   这不是缺陷而是纪律：内层出口装的是别人的贡献，被拖进隔离根会丢掉宿主样式、
   且在宿主视角与"贡献消失"无法区分。副作用是"作者摆了挂载点却没反应"——故注册时与忽略时
   各有一条点名 `props.slots` 的告警。
11. ~~**顶层直接调全局 SDK 的注册没有归属**（P12 时发现并登记）~~ —— **P13 已修复**（见 §8.3.1）：
   加载期间全局对象被换成按插件作用域的宿主，顶层形态与 `register(host)` 形态拿到的是**同一个
   对象**（来源 = 插件名、同一份 disposer、同一套闸门）。`'host-sdk'` 只剩"没有插件作用域时"
   这一种含义。端到端读数见 §11 的 P13 两条（渲染 + 停用后回收）。

---

## 10. 分阶段与验收

| 阶段 | 内容 | 状态与验收读数 |
| --- | --- | --- |
| **P0** | 令牌真值入 `--gw-*`，`@theme`/契约块变别名 | ✅ 已落盘：web 单测全绿、`typecheck` 绿、产物实证 `var(--gw-radius-md)` 内联；CDP 实证 `rounded-md` 随 `registerTheme` 覆盖 `--gw-radius-md` 从 8px 变 17px、卸载还原 |
| **P0b** | `themeTokenContract.test.ts` 5 条守卫（含 4 个阴性对照实测有效） | ✅ |
| **P1** | 本文 | ✅ |
| **P2** | `packages/core/src/extensions.ts`：目录 + 类型 + 纯判定函数；`slots.ts` 改为复用 | ✅ `extensions-catalog.test.ts` 15 条；`slots-browser-safe.test.ts` 增「界面扩展平台」段 |
| **P3** | `resolveExtensions()` 纯函数 + `SlotRegistry.register` + 端点字段 + 冲突诊断 | ✅ `packages/manager/test/extensions.test.ts` 13 条（含"幽灵贡献"真缺陷的回归） |
| **P4** | `<Ext>` 出口 + 边界回退默认 + SDK `registerExtension` | ✅ `packages/web/test/extOutlet.test.ts` 9 条（**回退用 `extFailures()` 记录，不是 `data-ext-fallback`**，见 §6） |
| **P5** | `shell-brand` / `shell-brand-text` 接入（**含 GeeWiki 字样**，本目标的起点） | ✅ `shellBrandExt.test.ts` 5 条；CDP：replace 后字样变 `MyWiki`、卸载逐字还原 `GeeWiki` |
| **P6** | 页面元素节点接入：`wiki-meta` / `wiki-actions` / `wiki-toc`（两处渲染点共用 id）/ `graph-toolbar` / `account-profile` | ✅ `packages/web/test/pageExt.test.ts` 6 条（含"目录 ⇄ 源码双向比对"）；CDP：extend `wiki-actions` 追加进 `.gw-reader-actions` |
| **P7** | `ui/*` 11 个原语在**定义处**包一层 | ✅ `uiExt.test.ts` 7 条（目录 ⇄ 源码双向比对）；CDP：replace `ui-button` 后 9 个宿主按钮中 5 个（走原语的调用点）同时改变、卸载后残留 0 |
| **P8** | i18n 全覆盖（品牌名可被语言/插件覆盖） | ✅ 字样走 `t('host.app.title')`；新增 `OVERRIDABLE_HOST_KEYS`（**唯一一项**）让插件可在**自己的**文案目录里覆盖它，其余宿主键仍拒；`packages/core/test/i18n.test.ts` + `packages/web/test/i18n.test.ts` 各 2 条 |
| **P9** | `shadow: true`（**仅 replace**） | ✅ `packages/web/test/extShadow.test.ts` 3 条（Node 无 DOM，只钉注册语义 + 不内联渲染 + 源码接线）；CDP 三条硬证据：壳 `display: contents`、shadow 内 `.font-bold` **不生效**（400 vs 宿主 700）、`var(--gw-accent)` 与宿主**同值** |
| **P10** | 插件 CSS 硬编码颜色守卫 + 对比度告警 | ✅ `pluginCssPlan.ts` + `pluginCssGuard.test.ts` 7 条（**顺手修掉了夹具里真实存在的 3 处硬编码**，并因扫到旧构建产物而暴露了"产物未重建"）；`themeContrastIssues()` 接入管理台告警块 |
| **P11** | CDP 端到端 + 文档更新 + **外壳节点收尾** | ✅ 新增 `scripts/acceptance/ui-extension-cdp.mjs`（当时读数 **22/22**，prod 构建 + Chrome 151）；5 个外壳节点接线（`shell-header` / `shell-footer` / `shell-theme-toggle` / `shell-command-palette` / `shell-status-dialog`）+ `shell-sidebar` 移除，守卫 `packages/web/test/shellChromeExt.test.ts` |
| **P11b** | **容器节点**：内层插槽出口由宿主承载（`nestedSlots` + `props.slots` 挂载点 + 绘制前 portal） | ✅ 起因：`replace shell-header` 曾把整个 `<header>` 子树交给单个插件，**用户当场驳回**（其他插件的页头贡献被删）。`ExtSlotMount` / `NestedSlotOutlet` / `nestedSlotsOf` 落盘；守卫 10 条（含"无视 `props.slots` 时贡献仍在"的 SSR 回归）+ CDP 4 条；core 目录守卫 3 条。**当时读数 27/27**（文档里一度误写为 28，见 §11 勘误） |
| **P11c** | 容器节点 × Shadow DOM：**隔离根内的挂载点必须被忽略** | ✅ 先实测后修：未修复时 CDP 读到 `counterLight:false, outletsLight:0`（贡献被 portal 进 shadow root，宿主视角与"消失"无异）。新增纯函数 `isUsableMountTarget`、忽略时告警一次、注册时提前告知；守卫 `extShadow.test.ts` +2 条（含假对象判据）、CDP +1 条。**读数 28/28** |
| **P12** | **越权闸门补全 + 受限宿主提供 `registerExtension`**（入口表新增 `extNodes`） | ✅ 修两个真缺陷：① 受限宿主只有 `registerSlot` ⇒ 走正规形态的插件用不了 `replace`/`wrap`/`shadow`；② 闸门只认插槽裁决 ⇒ 非插槽节点的被抑制 `replace` 仍会注册（"赢家 A、渲染 B"）。落盘：`PluginUiTableEntry.extNodes`、`buildPluginUiTable` 的 `extAssignments`、`parseSuppressedOwners` 合并 `extensions[]`、`createPluginUiHost`（抽出、可单测）、示例插件演示 `wrap shell-brand-text`。守卫：`pluginUiHost.test.ts` 8 条（含三条反向对照）、`pluginUiPlan.test.ts` +3、`plugin-ui.test.ts` +1。**读数 web 971/971、manager 290/290、CDP 28/28** |
| **P12b** | **验收层补齐**：`lib/session.mjs` 鉴权夹具 + 修陈旧的 `plugin-ui-cdp.mjs` + P12b 真浏览器场景 | ✅ 起因：`plugin-ui-cdp.mjs` 断言 `loaded()` 含 `@geewiki/wiki`（夹具早已搬到 `ui-demo`）且裸 `fetch` 调启停端点（要求 admin 会话 ⇒ 实测 401），**整脚本跑不动**。新增共用夹具（break-glass / setup / 验收账号三条路径 + `x-gw-csrf`）；`ui-extension-cdp.mjs` 加 **P12b 8 条**（真插件产物经受限宿主带 mode 注册 → 渲染 → 停用按 owner 回收）。修复中还抓到两个脚本自身的真问题：`Runtime.enable` **重放** console 历史、首屏断言假设"默认有启用的夹具插件"。**读数 `ui-extension-cdp` 36/36、`plugin-ui-cdp` 全通过（2 项按鉴权模式显式跳过）** |
| **P13** | **按插件 SDK 作用域**：加载期间全局对象 = 按插件作用域构造的宿主（栈式安装 / 还原、覆盖 `import()` 与 `register(host)` 两段、`finally` 兜底）；作用域宿主补成**完整 SDK** + `pluginName`；注销类成员只作用于自己的来源（新增 `unregisterSlotFrom`）；不导出 `register(host)` 的 bundle 也登记 | ✅ 修掉"顶层注册无归属"这个**静默**缺陷（收不回 + 不过闸门）。读数：`packages/web` **976/976**、CDP **39/39**、`HOST_SDK_VERSION` **0.12.0** |
| **P13b** | **portal 类原语接线**：`ui-dialog-content` / `ui-dropdown-menu-content` / `ui-confirm-dialog` / `ui-tooltip` 进目录，模式为 `extend` + `replace`（`PORTAL_UI_MODES`）；目录新增**事实标记** `portal: true`，守卫按规则钉住"标了 portal 的节点不得含 `wrap`" | ✅ 关闭"portal 类不接"这个洞：`wrap` 在 portal 上**不可能生效**（包装元素装不下 portal 内容、样式跨不过边界）⇒ 不提供陷阱；`replace` / `extend` 成立。守卫 `uiExt.test.ts` 改写并加"`portal: true` 必须有源码证据"，CDP +3 条 ⇒ **42/42** |

**涉及 UI 的批次一律要求浏览器端到端验收**（真实渲染，走
`scripts/acceptance/` 的零依赖 CDP 惯例，刻意不进 `pnpm test`），且 console 零错误、无失败请求。

## 11. 验收读数与已知缺口（P11）

**命令**（prod 构建；dev 下需另跑一遍，因为 Vite 的 `?import` 改写只在 dev 出现）：

```bash
pnpm --filter @geewiki/web run build && pnpm start          # 或 pnpm dev
google-chrome --headless=new --no-sandbox --remote-debugging-port=9461 about:blank
node scripts/acceptance/ui-extension-cdp.mjs http://127.0.0.1:3000 9461
```

**读数**（Chrome 151 headless，2026-09 本批）：**42 项全绿**（portal 批次后；P12b 时 36、P13 时 39），含

> **勘误（2026-09-21，P11c 时核对）**：P11b 那一轮文档里写成"28/28"，**实测是 27/27**。
> 复核方式：静态 `check(` 调用 29 处，减去 P9 场景里 `if (probe.error) … else …` 那对二选一 ⇒ 28，
> 再减去当时尚未存在的 P11c 一条 ⇒ 27。现读数以 `node scripts/acceptance/ui-extension-cdp.mjs <url>`
> 输出的 `ok` 行数为准（P11c 后 28，P12b 后 **36**，P13 后 **39**，portal 批次后 **42**）。
>
> **验收需要鉴权（P12b 起）**：启停插件要求 admin 会话。三条路径由 `scripts/acceptance/lib/session.mjs`
> 自动选择：① 实例启动时设 `GEEWIKI_ADMIN_TOKEN=<任意值>`（脚本读同一环境变量走 `x-gw-admin-token`
> break-glass 通道，**不产生会话 cookie** ⇒ 依赖"页面自己已登录"的用例会显式跳过）；
> ② 实例无账号时脚本用 `POST /api/auth/setup` 建首个 owner；③ 否则用固定验收账号登录。
> 都拿不到时，依赖鉴权的用例**明确跳过**（打印 `skip` 并写进结果 JSON），不记失败也不记通过。

- `P5` replace 品牌字样 → `MyWiki`；卸载 → `GeeWiki`（逐字还原）
- `P4` wrap 的 `props.default` 里确实是宿主默认元素
- `P7` replace `ui-button` → 9 个宿主按钮里 5 个（经原语的调用点）同时改变；卸载残留 0
- `P11` 空页脚 computed `display: none` 且 `<footer>` 只有 1 个子元素（`:only-child` 基线）；
  replace `shell-footer` 后插件内容**落在 `<footer>` 之内**、`<footer>` 与 `app-footer` 出口
  仍在且**恰好一份**，卸载后重新不占位；extend `shell-footer` ⇒ 页脚显形；
  replace `shell-header` 后品牌字样让位而 **`<header>` 仍在**；wrap `shell-header` 的 `default`
  是顶栏内容（品牌字样仍在其内、仍在 `<header>` 中）
- `P11b` **容器节点的要害断言**（用户当场驳回缺陷的回归）：先注册一个 `app-header` 贡献，
  再 `replace shell-header` 且**完全无视 `props.slots`** ⇒ 该贡献**仍然渲染**（`counterInHeader: true`，
  而宿主品牌已让位）；随后改为渲染 `props.slots['app-header']` ⇒ 贡献被**搬进**插件标记里
  （`mountInNav: true`、`counterInNav: true`、壳 `display: contents`、出口**恰好 1 份**）；
  卸载后贡献回到宿主位置、挂载点消失
- `P11c` **容器节点 × Shadow DOM**：`replace shell-header` + `shadow: true`，贡献者把
  `props.slots['app-header']` 渲染在隔离根内 ⇒ 读数 `{"shadowHost":true,"mountInShadow":true,`
  `"counterLight":true,"counterShadow":false,"outletsLight":1,"outletsShadow":0}`：
  **出口与别人的贡献都留在 light DOM**（挂载点被忽略并告警），隔离只作用于贡献者自己的标记
- `P12b` **插件 bundle → 受限宿主 → 带模式注册**（真产物、真加载器）：启用 `@geewiki-plugin/ui-demo` ⇒
  `{"counter":true,"counterInHeader":true}`（`registerSlot` 路径）、`{"brandTag":true,"brandTagInHeader":true}`
  且 `wordmark="GeeWiki"`（**`registerExtension(wrap)` 路径，且 `default` 没丢**）、产物与 CSS 经入口表加载；
  停用 ⇒ `{"counter":false,"brandTag":false}`、字样逐字还原、`<link>` 移除
  —— 最后一条同时证明"贡献归属到插件名 ⇒ 停用即按 owner 回收"
- `P13` **模块求值期（顶层形态）用全局 SDK 注册** ⇒ 归属到插件名并渲染
  `{"toplevel":true,"toplevelInHeader":true}`；停用 ⇒ `{"toplevel":false}`
  —— **修复前这条贡献的来源是 `'host-sdk'`，这个标记会残留**（这条断言就是那个缺陷的回归）
- `P13` **portal 类节点**：`replace ui-tooltip` ⇒ 调用点被换掉 **1 处**（定义处接线在全站生效），
  卸载 ⇒ 残留 **0**；同一节点用 `wrap` 注册 ⇒ 渲染 **0 处**（宿主侧模式校验真的拦下来了，
  并留下一条精确文案的告警——它本身就是断言对象，故在白名单里按精确文案放行）
- `P9` 壳 `display: contents`；shadow 内 `.font-bold` 字重 400（宿主内 700）⇒ 工具类进不去；
  shadow 内 `var(--gw-accent)` = 宿主内同值 ⇒ 令牌跨边界继承
- `P0` `registerTheme` 覆盖 `--gw-radius-md: 17px` ⇒ `.rounded-md` 计算值 8px → 17px → 卸载还原
- 入口表：未启用插件列为 `skipped(inactive)`；静态层 `/plugins-ui/<名>/client.js` 200
- console 零错误、无失败请求（匿名态下 SPA 自身的 401 由脚本**显式探测并记录**，不静默容忍）

**已知缺口（如实登记，勿当成已完成）**：

1. ~~**`scripts/acceptance/plugin-ui-cdp.mjs` 已陈旧**~~ —— **已由 P12b 修复**：新增共用鉴权夹具
   `scripts/acceptance/lib/session.mjs`（break-glass / `POST /api/auth/setup` / 固定验收账号三条路径，
   状态变更请求自动带 `x-gw-csrf`），断言也按夹具搬家后的实际形态更新；`plugin-ui-cdp.mjs`
   **全通过**（含 `--missing-asset` 路径；按鉴权模式显式跳过的用例会打印 `skip` 并写进结果 JSON）。
2. ~~**插件 bundle → `registerExtension(mode)` 这条端到端路径没有 CDP 覆盖**~~ —— **已由 P12b 补齐**：
   脚本改为启用**真实示例插件**（`@geewiki-plugin/ui-demo`，产物由 `build:fixtures` 构建到
   `plugins/<名>/dist`），断言它的 `registerSlot` 与 `registerExtension(wrap)` 贡献出现、停用后
   按 owner 回收；P13 又在同一场景里加了"**模块求值期**顶层形态的注册同样归属插件名、停用即回收"。
3. **`kind: 'page'` 的整页替换仍然不做**（§9.5）。外壳候选节点**已全部接线**（7 个 `shell-*`，
   守卫 `shellChromeExt.test.ts` 9 条）；`shell-sidebar` 经核实**外壳里不存在该元素**，已从候选移除。
   portal 类原语**已接线**（`extend` + `replace`，`wrap` 由规则排除，§3）；
   要自定义**整套对话框流程**仍可替换**使用它的宿主节点**（`shell-status-dialog` /
   `shell-command-palette`）——那是"换掉流程"，不是"换掉面板"。
