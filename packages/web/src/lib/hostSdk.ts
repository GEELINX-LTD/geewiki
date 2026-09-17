import * as React from 'react'
import {
  registerMarkdownExtension,
  unregisterMarkdownExtensions,
  markdownExtensions as markdownExtensionList,
  type MarkdownExtension,
} from './markdownExt'
import type { ComponentType } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import {
  PluginSlotOutlet as PluginSlotOutletImpl,
  registerSlotByName,
  slotContributors as slotContributorsImpl,
  unregisterSlot,
  useSlotEntries as useSlotEntriesImpl,
  type AnySlotComponent,
  type SlotEntry,
} from './slots'
import { mdToHtml } from './sanitize'
import { getLocale, t } from './i18n'
import {
  registerRoute,
  unregisterRoutes,
  type PluginRouteProps,
} from './routes'
import {
  clientToolNamesSnapshot,
  invokeClientTool,
  registerClientTool,
  unregisterClientTools,
} from './clientTools'
import {
  registerTheme,
  themeContributors as themeContributorList,
  unregisterThemes,
  type ThemeContribution,
  type ThemeContributor,
} from './pluginTheme'

/**
 * 宿主 SDK：插件客户端 bundle 与宿主之间唯一的进程内契约。
 *
 * 必须在**任何插件 bundle 被动态 import 之前**完成挂载：
 * `public/host-sdk/*.js`（import map 的目标）在模块求值期就读取 `globalThis.__GEEWIKI_HOST__`，
 * 未挂载时会直接抛 `[geewiki-host-sdk] window.__GEEWIKI_HOST__ 未初始化`。
 * 因此 `main.tsx` 的第一行就是这个模块的副作用导入。
 *
 * `React` 取 `react` 包本身（不是 react-dom/client）：插件只需要组件与 hooks；
 * `jsxRuntime` 取宿主真实的 `react/jsx-runtime`，插件用 automatic JSX 时由它产出元素。
 *
 * ## 版本
 * `0.2.0` 起新增 {@link GeeWikiHostSdk.renderMarkdown}。
 * `0.3.0` 起新增 {@link GeeWikiHostSdk.registerTool} / {@link GeeWikiHostSdk.invokeTool}
 * （客户端工具：编辑框一类的动作只能在浏览器里跑）。
 * `0.4.0` 起新增 {@link GeeWikiHostSdk.PluginSlotOutlet} / `slotContributors` / `useSlotEntries`：
 * **插件第一次可以自己开扩展点**，而不再只能抢占宿主预先挖好的 7 个格子。
 * `0.5.0` 起新增 {@link GeeWikiHostSdk.registerRoute} / `unregisterRoutes`：
 * **插件第一次拥有自己的页面与 URL**（清单 `geewiki.routes` 声明 + 运行期注册组件）。
 * `0.6.0` 起新增 {@link GeeWikiHostSdk.ReactDOM} / `ReactDOMClient` / `createPortal` /
 * `createRoot`：插件可以做全屏浮层与 shadow DOM 样式隔离（**仍然不得自带框架**，
 * 映射的目的是共用宿主那一份实例，避免两份 react-dom 让 portal 丢事件）。
 * `0.7.0` 起新增 {@link GeeWikiHostSdk.registerMarkdownExtension}。
 * `0.8.0` 起新增 {@link GeeWikiHostSdk.registerTheme} / `unregisterThemes`：
 * **插件第一次可以改变整站配色**（覆盖 `--gw-*` 设计 token），而不再只能做局部组件。
 * `0.9.0` 起新增 {@link GeeWikiHostSdk.t} / `getLocale`：
 * **插件与宿主共用同一套 message catalog**（键空间 `host.*` / `plugin.<短名>.*`，
 * 回退链与插值由 `@geewiki/core/domain` 实现一处）。插件应优先用它取文案，
 * 而不是自带一份字典 —— 后者会让"同一个界面里宿主说一套、插件说另一套"，
 * 而且没有任何地方能看到完整的待翻译清单。
 * 插件侧应**特性探测**再用（`typeof host.renderMarkdown === 'function'`），
 * 不要按 version 字符串比大小——老宿主上没有这个函数，退化路径应当是"不注册该工具 /
 * 显示纯文本"，而不是抛错。
 */
export const HOST_SDK_VERSION = '0.9.0'

/** {@link GeeWikiHostSdk.PluginSlotOutlet} 的属性 */
export interface PluginSlotOutletProps {
  /** 扩展点名：形如 `"命名空间/名字"`（小写 kebab，至少含一个 `/`） */
  readonly name: string
  /** 转发给每个贡献组件的属性（契约由声明扩展点的插件与贡献者自行约定） */
  readonly props?: Record<string, unknown>
  /** 该扩展点是单占用时传 `true`：只渲染第一条贡献 */
  readonly single?: boolean
}

export interface GeeWikiHostSdk {
  readonly React: typeof React
  readonly jsxRuntime: { jsx: unknown; jsxs: unknown; Fragment: unknown }
  /**
   * 注册插槽组件，返回幂等的注销函数。
   *
   * 名称是**运行期字符串**（插件 bundle 不参与本仓库的类型检查），由
   * `registerSlotByName` 做运行期校验；组件类型是零属性与带数据插槽两种形态的联合。
   */
  registerSlot(name: string, component: AnySlotComponent): () => void
  /** 传入 token 只注销一条；不传则清空该插槽 */
  unregisterSlot(name: string, token?: unknown): void
  /**
   * **插件自定义扩展点的出口**（`0.4.0` 起）：在自己的界面里渲染它，把一块区域开放给别的插件。
   *
   * 为什么这个能力是"万物皆插件"的分水岭：在此之前，插件能出现的位置完全由宿主
   * 预先枚举的插槽白名单决定——宿主没挖的坑，插件永远进不去。有了它，**插件可以自己开扩展点**，
   * 别的插件再往里贡献；宿主不必事先知道这个扩展点存在。
   *
   * 用法：
   * ```js
   * const { React, PluginSlotOutlet } = window.__GEEWIKI_HOST__
   * // 声明方（服务端 slot.define('my-plugin/toolbar', …) 声明基数）渲染出口：
   * function Toolbar(props) {
   *   return React.createElement(PluginSlotOutlet, { name: 'my-plugin/toolbar', props })
   * }
   * // 贡献方（服务端 manifest 的 slots 里写上同一个名字）注册组件：
   * host.registerSlot('my-plugin/toolbar', (p) => React.createElement(MyButton, p))
   * ```
   *
   * 契约由**声明方与贡献方自行约定**——宿主不认识这些 `props`，也无法替它们定义。
   */
  readonly PluginSlotOutlet: React.ComponentType<PluginSlotOutletProps>
  /**
   * 某扩展点当前的贡献者名单（快照）。给声明方渲染空态/计数用
   * （例如"还没有插件扩展这里"）。非法名返回空数组。
   */
  slotContributors(name: string): readonly string[]
  /**
   * 订阅某扩展点的贡献**条目**（React hook）。
   *
   * 返回条目数组而不是名单数组是刻意的：`useSyncExternalStore` 要求数据未变时
   * `getSnapshot` 返回**同一引用**，映射（→ 名单）请调用方在渲染期自己做。
   */
  readonly useSlotEntries: (name: string) => readonly SlotEntry[]
  /**
   * **注册一个插件页面**（`0.5.0` 起，F2）：`id` 对应 `#/<id>`，组件收到
   * {@link PluginRouteProps}（`sub` / `query` / `onNavigate`）。
   *
   * ⚠️ **`id` 必须先在 `package.json#geewiki.routes` 里声明**。这不是形式要求：
   * 入口表靠那份声明把该插件的产物标为"**不可推迟加载**"（`isLazyOnlyEntry`）。
   * 只在这里注册而没声明，症状是——**bundle 恰好被别的功能加载过时能打开，
   * 冷启动直接访问 `#/<id>` 时一片空白且不报错**（产物从未被加载，没有组件可渲染，
   * 而宿主也不会为它特殊加载）。走 `register(host)` 那条路径时宿主会直接拒绝未声明的 id
   * 并告警；用本全局对象注册则绕过了那道检查，**责任在插件**。
   */
  registerRoute(id: string, component: ComponentType<PluginRouteProps>): () => void
  /** 注销某来源的全部页面路由（插件卸载/重载的统一出口） */
  unregisterRoutes(source: string): void
  /**
   * **宿主这一份** `react-dom` 实例（`0.6.0` 起，F6）。
   *
   * 为什么必须是同一个实例：React 的 hooks 依赖"当前渲染器"这一**模块级**状态。
   * 插件自带一份 react-dom 时，它 `createPortal` 到宿主树里的元素会丢失事件与 context
   * （症状是"点击没反应 / context 读到默认值"），且**不报任何错**。
   * 所以 import map 把 `react-dom` 也映射到宿主 shim——插件**仍然不得自带框架**，
   * 只是多了一个共享入口。
   */
  readonly ReactDOM: typeof ReactDOM
  /** **宿主这一份** `react-dom/client`（`createRoot` / `hydrateRoot`）。用途见 {@link createRoot 的说明}。 */
  readonly ReactDOMClient: typeof ReactDOMClient
  /**
   * `react-dom` 的 `createPortal`（便捷直出，等价于 `host.ReactDOM.createPortal`）。
   *
   * 用途：把插件界面渲染到**宿主 DOM 树之外**的位置（全屏浮层、模态、独立面板）。
   * 在此之前插件只能挤在宿主给的那块插槽高度里，做不了全屏工具。
   */
  readonly createPortal: typeof ReactDOM.createPortal
  /**
   * 在**插件自己拥有的 DOM 节点**上建独立 React 根（`react-dom/client` 的 `createRoot`）。
   *
   * ## 最重要的用法：shadow DOM 样式隔离
   * ```js
   * const host = document.createElement('div')
   * const shadow = host.attachShadow({ mode: 'open' })
   * const mount = document.createElement('div')
   * shadow.append(mount, myStyleEl)
   * const root = host.createRoot(mount)
   * root.render(React.createElement(MyPage))
   * return () => root.unmount()   // ← 必须自己收
   * ```
   * 这绕开了"插件 CSS 全局注入、只靠前缀约定"这条既有边界。
   *
   * ## 边界（宿主不代管）
   * 宿主**不会**替你卸载这个根。插件必须在自己被卸载时 `root.unmount()`
   * （放进 `register(host)` 返回的清理函数里），否则那棵 React 树会一直留在内存里。
   */
  readonly createRoot: typeof ReactDOMClient.createRoot
  /** `react-dom/client` 的 `hydrateRoot`（服务端预渲染场景；当前宿主不产出 SSR，故极少用） */
  readonly hydrateRoot: typeof ReactDOMClient.hydrateRoot
  /**
   * markdown → **已消毒** HTML（与阅读页同一条 `lib/sanitize.ts` 管线：marked → DOMPurify）。
   *
   * 为什么这个能力在宿主而不在插件：消毒白名单是**安全边界**，只该有一处实现、一处审计。
   * 插件把返回值直接 `dangerouslySetInnerHTML` 是允许的；在它**外面再拼**未经消毒的串则
   * 绕过了这条边界，属插件违约。
   */
  renderMarkdown(markdown: string): string
  /**
   * 登记一个**客户端工具**（在浏览器里执行的动作，如改写编辑框选区），返回幂等的注销函数。
   *
   * 为什么这类工具必须由宿主登记、而不是插件自己执行自己的：设计文档 §3.3 的安全红线——
   * 客户端上报的「可调用集」**只能收窄，绝不能扩权**。名单来自宿主登记 ⇒ 服务端只认
   * "宿主登记的 ∩ 模型请求的"这份交集；若让插件自己拼名单，它就能声明任意工具名去让模型调用。
   *
   * 名字全局唯一，**重复登记抛错**（不静默覆盖）。名字必须与插件在**服务端**
   * `ai-tool-service` 里以 `side: 'client'` 声明的那个同名——服务端说"它存在"，
   * 浏览器说"它在我这儿怎么跑"，任何一边都不得单独定义"它存在"。
   */
  registerTool(name: string, execute: (args: unknown) => Promise<unknown> | unknown): () => void
  /** 注销某登记方的**全部**客户端工具（插件卸载/重载时的统一出口） */
  unregisterTools(source: string): void
  /**
   * 执行一个**已登记**的客户端工具；未登记的名字**拒绝**（抛错）。
   *
   * 拒绝而不是返回 `undefined`：调用方是服务端回灌来的模型请求，
   * "这个名字不存在"与"它跑完没结果"必须可区分——前者说明客户端的可调用集与
   * 服务端认为的不一致（那是个真 bug）。
   */
  invokeTool(name: string, args: unknown): Promise<unknown>
  /** 当前已登记的客户端工具名（已排序；顺序稳定才能命中上游前缀缓存） */
  readonly clientTools: readonly string[]
  /**
   * ★ F8：登记一个 **Markdown 渲染扩展**（自定义围栏语言 / 块语法 / 行内语法）。
   *
   * ```js
   * const undo = host.registerMarkdownExtension({
   *   name: 'fence-mermaid',
   *   marked: { renderer: { code(t) { return t.lang === 'mermaid' ? `…` : false } } },
   * })
   * ```
   *
   * 返回**幂等的注销函数**；插件卸载请用 {@link unregisterMarkdownExtensions}。
   *
   * ⚠️ 产出的是 HTML **字符串**，它会照旧经过宿主的 DOMPurify 消毒 ——
   * 这是硬边界，不是建议：扩展**无法**借此执行脚本（`<script>`、`onerror` 等会被摘掉）。
   * 同理，扩展也**拿不到**宿主后处理（链接改写、附件标注、标题锚点）之外的能力。
   */
  registerMarkdownExtension(ext: MarkdownExtension): () => void
  /** 注销某登记方（插件名）注册的**全部** Markdown 扩展 */
  unregisterMarkdownExtensions(owner: string): void
  /** 当前生效的 Markdown 扩展（`{ owner, name }`，注册顺序）——排障"我的渲染器为什么没生效" */
  readonly markdownExtensions: readonly { owner: string; name: string }[]
  /**
   * ★ F16：登记一组**主题 token 覆盖**，改变整站配色（品牌 / 深色微调）。
   *
   * ```js
   * const undo = host.registerTheme({
   *   name: 'Acme 品牌',
   *   light: { '--gw-blue-600': '#0b5fff' },
   *   dark:  { '--gw-blue-600': '#5b9bff' },
   * })
   * ```
   *
   * 只能覆盖 `--gw-*` 开头的**原始设计 token**（语义 token `--color-*` 会被拒绝）——
   * 因为语义 token 只**指向** `--gw-*`，改原始值才能让深浅两套主题与全部工具类自动跟随；
   * 详见 `lib/pluginTheme.ts` 的文件头。
   *
   * 深浅两模式**分别**给值：只给 `light` 时**不会**泄漏进深色模式（宿主按模式分段注入）。
   * 同一 token 多来源时，**按当前贡献者集合、注册顺序在前者胜**；撤销先注册者后，
   * 仍加载着的后来者会接管该 token。冲突与压制情况可在 {@link themeContributors} 里看到。
   *
   * 返回**幂等的注销函数**；插件卸载请用 {@link unregisterThemes}。
   */
  registerTheme(contribution: ThemeContribution): () => void
  /** 注销某登记方（插件名）注册的**全部**主题 token */
  unregisterThemes(owner: string): void
  /** 当前主题贡献者与冲突（排障"我的配色为什么没生效"） */
  readonly themeContributors: readonly ThemeContributor[]
  /**
   * ★ F15：取一条**共享文案**（宿主与插件同一套 catalog）。
   *
   * 键必须写在自己的命名空间下（`plugin.<你的短名>.…`）；越权的键在**服务端装载时**
   * 就会被拒绝并报告，不会静默生效 —— 否则任何插件都能改写宿主界面上的任意文案。
   *
   * **缺失时返回键名本身**，绝不返回空串：空串会让界面静默缺一块，
   * 而键名一眼就能看出是漏了文案。
   */
  t(key: string, params?: Readonly<Record<string, string | number>>): string
  /** ★ F15：当前界面语言（如 `zh-CN` / `en`） */
  getLocale(): string
  readonly version: string
}

declare global {
  interface Window {
    __GEEWIKI_HOST__?: GeeWikiHostSdk
  }
}

const sdk: GeeWikiHostSdk = {
  React,
  jsxRuntime: {
    jsx: jsxRuntime.jsx,
    jsxs: jsxRuntime.jsxs,
    Fragment: jsxRuntime.Fragment,
  },
  registerSlot: (name, component) => registerSlotByName(name, component, 'host-sdk'),
  unregisterSlot,
  PluginSlotOutlet: PluginSlotOutletImpl,
  slotContributors: slotContributorsImpl,
  useSlotEntries: useSlotEntriesImpl,
  registerRoute: (id, component) => registerRoute(id, component, 'host-sdk'),
  unregisterRoutes,
  ReactDOM,
  ReactDOMClient,
  createPortal: ReactDOM.createPortal,
  createRoot: ReactDOMClient.createRoot,
  hydrateRoot: ReactDOMClient.hydrateRoot,
  renderMarkdown: mdToHtml,
  registerTool: (name, execute) => registerClientTool(name, execute, 'host-sdk'),
  unregisterTools: unregisterClientTools,
  registerMarkdownExtension: (ext) => registerMarkdownExtension('host-sdk', ext),
  unregisterMarkdownExtensions,
  /* 同 `clientTools`：用 getter，插件登记发生在 sdk 构造之后 */
  get markdownExtensions() {
    return markdownExtensionList()
  },
  registerTheme: (contribution) => registerTheme('host-sdk', contribution),
  unregisterThemes,
  /* 同上：getter，而不是构造期快照 */
  get themeContributors() {
    return themeContributorList()
  },
  invokeTool: invokeClientTool,
  /*
   * `clientTools` 用 getter 而不是快照值：`sdk` 是模块加载期构造的**单例**，
   * 而工具登记发生在之后（插件 `register(host)` 时）。快照会让插件永远读到空数组——
   * 且不会报错，只是"我登记了工具但名单里没有我"，属于最难定位的那类静默失败。
   */
  get clientTools() {
    return clientToolNamesSnapshot()
  },
  t: (key, params) => t(key, params),
  getLocale: () => getLocale(),

  version: HOST_SDK_VERSION,
}

if (!window.__GEEWIKI_HOST__) {
  window.__GEEWIKI_HOST__ = sdk
}

export function hostSdk(): GeeWikiHostSdk | undefined {
  return window.__GEEWIKI_HOST__
}
