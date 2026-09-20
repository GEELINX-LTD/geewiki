import {
  registerExtensionByName,
  registerSlotByName,
  unregisterSlotFrom,
  type AnySlotComponent,
} from './slots'
import { registerRoute, unregisterRoutes, type PluginRouteProps } from './routes'
import { registerClientTool, unregisterClientTools } from './clientTools'
import { registerMarkdownExtension, unregisterMarkdownExtensions } from './markdownExt'
import { registerTheme, unregisterThemes } from './pluginTheme'
import { hostSdk, type GeeWikiHostSdk } from './hostSdk'
import { errorDetail } from './errorText'
import type { ExtMode } from '@geewiki/core/extensions'
import { isBuiltinSlotName } from '@geewiki/core/slots'
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
/**
 * **按插件作用域的宿主**：`export function register(host)` 的参数，**也是加载期间
 * `window.__GEEWIKI_HOST__` 指向的那个对象**（P13，见 {@link installPluginScope}）。
 *
 * ## 为什么它现在 `extends GeeWikiHostSdk`（P13）
 * P12 之前它是**手写的一份子集**（只有 `React` / `jsxRuntime` / `registerSlot` / …），
 * 于是"受限宿主"与"全局 SDK"是两个形状不同的对象、各缺一半能力：走 `register(host)` 的插件
 * 用不了 `registerExtension` 的模式参数，改用全局 SDK 又丢掉归属与闸门（详见 `registerExtension`
 * 的说明）。**两个对象形状不同这件事本身就是缺陷源**——每加一个 SDK 成员就多一处要同步的副本，
 * 漏掉的症状是"插件里那个字段是 undefined"，只在真正调用时才炸。
 *
 * 现在改为**摊开基础 SDK 再覆盖注册/注销两类**（`{ ...sdk, … }`）：形状由构造保证一致，
 * 不可能漂移。因此 `registerRoute` / `registerTool` / `registerTheme` / `registerMarkdownExtension`
 * / `t` / `ReactDOM` / `PluginSlotOutlet` … 全都在这个对象上，且**注册一律归属到插件名**。
 */
export interface PluginUiHost extends GeeWikiHostSdk {
  registerSlot(name: string, component: AnySlotComponent): () => void
  /**
   * **以指定模式往宿主节点贡献界面**（P12 新增到受限宿主上）。
   *
   * ## 为什么必须补上它（这是一个真缺陷，不是"更全的 API"）
   * `registerExtension` 早就在**全局 SDK**（`window.__GEEWIKI_HOST__`）上了，但受限宿主
   * ——也就是 bundle 的 `export function register(host)` 拿到的那个对象——**只有 `registerSlot`**。
   * 于是走这条**正规形态**的插件（本仓的示例 `plugins/ui-demo` 就是）**根本用不了**
   * `replace` / `wrap` / `shadow`，只能用默认的 `extend`；而改用全局 SDK 直接注册虽然能带模式，
   * 却有两个代价：注册来源是 `'host-sdk'`（**卸载时无法按 owner 回收**，插件停用后贡献会残留），
   * 且完全绕过下面两道越权闸门。两个形态各缺一半，等于"带模式注册"没有一条既受管辖、
   * 又能被回收的路。
   *
   * 现在这条路径：来源 = 插件名（卸载即回收）、过同一套闸门、`opts.shadow` 与全局 SDK 同义。
   */
  registerExtension(
    node: string,
    component: AnySlotComponent,
    opts?: { readonly mode?: ExtMode; readonly shadow?: boolean },
  ): () => void
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
  /** 注销**本插件**的全部路由（卸载/重载的统一出口；传别的来源会被拒绝并告警） */
  unregisterRoutes(source: string): void
  /**
   * 本插件名。**"我是谁"的唯一来源**：作用域宿主上的注册一律以它作为 `source`，
   * 因此插件的**模块求值期**代码也能据此判断当前是谁在加载（例如只在某个插件名下注册
   * 演示贡献的夹具）。全局 SDK 上**没有**这个字段——它是作用域宿主独有的。
   */
  readonly pluginName: string
}

interface PluginUiModule {
  register?: (host: PluginUiHost) => unknown
  default?: unknown
}

/**
 * {@link createPluginUiHost} 的上下文（P12 抽出）。
 *
 * 为什么把它抽成显式参数而不是继续闭包捕获模块状态：越权闸门是**最容易写错、且错了完全静默**
 * 的一段（漏拦的后果是"后端说 A 生效、界面却渲染了 B"）。内联在 `loadPluginUi` 里就只能靠
 * E2E 覆盖；抽出来之后单测可以拿假 `meta` / 假 `suppressed` 把每条闸门走一遍。
 */
export interface PluginUiHostContext {
  /** 插件名。同时作为注册来源（`source`）——卸载时靠它按 owner 回收贡献 */
  readonly name: string
  /** 宿主 SDK（`React` / `jsxRuntime` / `renderMarkdown` / `unregisterSlot` 都转发自它） */
  readonly sdk: GeeWikiHostSdk
  /** 该插件在入口表里的条目（生效插槽 / 生效扩展节点 / 生效路由的真源） */
  readonly meta: UiTableEntry
  /** 被后端抑制的声明者（插槽与扩展节点**共用同一份**解析结果） */
  readonly suppressed: SuppressedOwners
  /** 收集本插件注册产生的注销函数（卸载时统一执行） */
  readonly disposers: Array<() => void>
}

/**
 * 构造**按插件作用域的受限宿主**：插件 bundle 的 `export function register(host)` 拿到的就是它。
 *
 * ## 两道越权闸门（`registerSlot` 与 `registerExtension` 共用同一套判据）
 * 单占用节点的权威裁决在后端，被抑制的插件**仍然是 active 的**——它的 bundle 照样加载、
 * 照样调注册。不拦的后果是两个实现同时渲染（两个编辑器 / 两个顶栏）。
 *
 * ① **权威仲裁**（`GET /api/plugins/slots` 的 `suppressed`，插槽与扩展节点共用）：**主判据**。
 *    不能只靠入口表字段——后端在生效集合为空时**省略该键**，于是"声明了但被抑制"与
 *    "根本没声明"无法区分，被抑制者会蒙混过关（E2E 抓到过：赢家是 A，界面却渲染了 B）。
 * ② **入口表的生效节点**（`meta.slots` ∪ `meta.extNodes`）：**次判据**，挡住"声明了 `editor`
 *    却去注册 `app-header`"这种越界。**两个字段都缺省 ⇒ 不校验**：那是纯浏览器侧注册的插件
 *    （不在后端 owners 里，例如 `plugins/hello-geewiki` 的产物），既有行为必须保留。
 *
 * 两处入口共用同一个 `gate()`：分成两份实现必然漂移，而漂移的表现是
 * "插槽被拦住了、扩展节点没被拦住"——最难被发现的那种半失效。
 */
export function createPluginUiHost(ctx: PluginUiHostContext): PluginUiHost {
  const { name, sdk, meta, suppressed, disposers } = ctx
  /**
   * 越权判定：返回**告警文案**（该忽略这条注册）或 `null`（放行）。
   *
   * `space` 决定用入口表的哪个字段做**次判据**（`slot` = `meta.slots`，`ext` = `meta.extNodes`）。
   * **两个字段刻意不合并**：次判据的语义是**逐字段**的——"该字段缺省 ⇒ 不校验"，因为缺省意味着
   * 这是纯浏览器侧注册的插件（不在后端 owners 里，例如 `plugins/hello-geewiki` 的产物）。
   * 若取并集，一个只声明了 `geewiki.extensions` 的插件，它**既有**的插槽注册会被突然拦下
   * ——插件没改一行，界面却少一块（`packages/web/test/pluginUiHost.test.ts` 有专门的反向对照）。
   */
  const gate = (node: string, space: 'slot' | 'ext'): string | null => {
    if (suppressed.get(node as SlotName)?.has(name) === true) {
      return (
        `[geewiki-plugin-ui] 插件 ${name} 是节点 "${node}" 的**被抑制**声明者（单占用节点已被` +
        '激活顺序更早的插件占用），其注册已忽略——否则会出现两个实现同时渲染。'
      )
    }
    const declared = space === 'slot' ? meta.slots : meta.extNodes
    if (declared !== undefined && !declared.includes(node as SlotName)) {
      return (
        `[geewiki-plugin-ui] 插件 ${name} 尝试注册未获生效的节点 "${node}"，已忽略` +
        `（该插件生效${space === 'slot' ? '插槽' : '扩展节点'}：${declared.join(', ') || '无'}）`
      )
    }
    return null
  }

  /**
   * 注销类成员**只能作用于本插件自己的来源**（P13）。
   *
   * 全局 SDK 上 `unregisterThemes('other-plugin')` 是合法调用，于是任何插件都能拆掉别的插件的
   * 主题 / 路由 / 工具——被拆的一方只看到"我的界面/主题不见了"，查不到是谁干的。
   * 作用域的意义正是"你只能动你自己的"，故传别的来源时**告警并拒绝**（不静默放行、
   * 也不静默忽略：作者必须知道这条调用没生效）。
   */
  const scopedUnregister = (source: string, run: (owner: string) => void, api: string): void => {
    if (source !== name) {
      console.warn(
        `[geewiki-plugin-ui] 插件 ${name} 调用了 ${api}("${source}")，已忽略：作用域宿主只允许注销自己的来源。`,
      )
      return
    }
    run(name)
  }

  return {
    /*
      先摊开基础 SDK 的**全部**成员，再覆盖"注册 / 注销"这两类。
      为什么是摊开而不是逐项转发：逐项转发意味着 SDK 每加一个成员就多一处必须同步的副本，
      而漏掉的症状是"插件里那个字段是 undefined"——只在真正调用时才炸，错误现场离原因很远
      （`packages/web/test/hostSdkSurface.test.ts` 的文件头记着同一类坑）。
    */
    ...sdk,
    pluginName: name,
    registerSlot: (slot, component) => {
      const reason = gate(slot, 'slot')
      if (reason !== null) {
        console.warn(reason)
        return () => {}
      }
      const off = registerSlotByName(slot, component, name)
      disposers.push(off)
      return off
    },
    registerExtension: (node, component, opts) => {
      // 空间由名字本身决定：内置插槽名走插槽字段，其余（宿主节点 / 自定义扩展点）走扩展节点字段。
      // 不能一律当扩展节点——`registerExtension('app-header', c)` 是合法用法（模式化注册插槽）。
      const reason = gate(node, isBuiltinSlotName(node) ? 'slot' : 'ext')
      if (reason !== null) {
        console.warn(reason)
        return () => {}
      }
      const off = registerExtensionByName(node, component, name, opts?.mode ?? 'extend', opts?.shadow ?? false)
      disposers.push(off)
      return off
    },
    /*
      以下三类在 P13 之前**只存在于全局 SDK**（来源写死 `'host-sdk'`）：插件用它们注册的东西
      既收不回、也不过闸门。现在它们与 `registerSlot` / `registerExtension` / `registerRoute`
      走同一条路——来源 = 插件名、注销函数收进 `disposers`、卸载时统一执行。
    */
    registerTool: (toolName, execute) => {
      const off = registerClientTool(toolName, execute, name)
      disposers.push(off)
      return off
    },
    registerMarkdownExtension: (ext) => {
      const off = registerMarkdownExtension(name, ext)
      disposers.push(off)
      return off
    },
    registerTheme: (contribution) => {
      const off = registerTheme(name, contribution)
      disposers.push(off)
      return off
    },
    unregisterSlot: (slot, token) => {
      // 传了 token（通常就是上面返回的注销函数）就按那条精确注销，否则**只清自己的来源**。
      // 旧写法是直接转发全局 `unregisterSlot`：不带 token 时它会删掉该节点上所有插件的贡献。
      if (typeof token === 'function') {
        ;(token as () => void)()
        return
      }
      unregisterSlotFrom(slot, name)
    },
    renderMarkdown: (markdown: string) => sdk.renderMarkdown(markdown),
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
    unregisterRoutes: (source) => scopedUnregister(source, unregisterRoutes, 'unregisterRoutes'),
    unregisterTools: (source) => scopedUnregister(source, unregisterClientTools, 'unregisterTools'),
    unregisterMarkdownExtensions: (owner) =>
      scopedUnregister(owner, unregisterMarkdownExtensions, 'unregisterMarkdownExtensions'),
    unregisterThemes: (owner) => scopedUnregister(owner, unregisterThemes, 'unregisterThemes'),
  }
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

/**
 * 加载期间的**按插件 SDK 作用域**（P13）。
 *
 * ## 为什么必须临时替换全局对象
 * 插件 bundle 有两种写法（设计文档 §8.3.1）：`export function register(host)`，与**模块求值时**
 * 直接调 `window.__GEEWIKI_HOST__`。后者走的是全局对象，而全局对象上的注册函数把来源写死成
 * `'host-sdk'` ⇒ ① `unloadPluginUi` 收不回这些贡献（插件停用后界面 / 主题 / 路由 / 工具残留），
 * ② 完全绕过两道越权闸门。两者都是**静默失效**。
 *
 * 修法是让**加载期间的全局对象就是那个按插件作用域构造的宿主**——于是"用全局"与"用参数"
 * 拿到的是**同一个对象**，归属与闸门由构造保证，不依赖作者写对哪一种形态。
 *
 * ## 为什么是栈而不是"存旧值、还原旧值"
 * `import()` 是异步的。今天的调用点都是顺序 `await`（那是**调用方的性质**，不是本函数的保证），
 * 一旦两次加载在 await 处交错，"还原成我进来时看到的那个"会把**先装的那层**也一起抹掉
 * （外层作用域消失 ⇒ 那段时间里插件注册的东西又落回全局 SDK 名下）。
 * 栈的语义是"撤销我这一层，回到栈顶"：无论交错顺序如何，全部撤销后必然回到基础 SDK。
 *
 * ## 为什么用 `globalThis` 而不是 `window`
 * 浏览器里 `window === globalThis`（`hostSdk.ts` 写的也是同一个对象），而 `globalThis` 让这段
 * 逻辑在 Node 单测里可以直接验证（`packages/web/test/pluginUiHost.test.ts` 真的把它装/卸一遍）。
 */
const scopeStack: PluginUiHost[] = []

export function installPluginScope(host: PluginUiHost, base: GeeWikiHostSdk): () => void {
  const glob = globalThis as { __GEEWIKI_HOST__?: GeeWikiHostSdk }
  scopeStack.push(host)
  glob.__GEEWIKI_HOST__ = host
  let restored = false
  return () => {
    // 幂等：成功路径、失败路径与 finally 都会调它，重复调用必须是空操作
    if (restored) return
    restored = true
    const index = scopeStack.indexOf(host)
    if (index >= 0) scopeStack.splice(index, 1)
    const top = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : undefined
    glob.__GEEWIKI_HOST__ = top ?? base
  }
}

/** 执行并清空一批注销函数（注册失败 / 迟到 / 入口抛错时的回滚） */
function rollbackDisposers(disposers: Array<() => void>): void {
  for (const off of disposers.splice(0)) {
    try {
      off()
    } catch (err) {
      console.debug('[geewiki-plugin-ui] 回滚注册时出错：', err)
    }
  }
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
  /*
    作用域宿主**必须在 `import()` 之前构造并装上**：bundle 的**模块求值期**就会注册（顶层形态），
    晚一步装上，那批注册仍然落在全局 SDK 名下 —— 既收不回、也不过闸门，正是本批要修的缺陷。
    于是"用全局 SDK"与"用 `register(host)` 的参数"是**同一个对象**，两种形态由构造统一，
    不依赖作者写对哪一种。
  */
  const disposers: Array<() => void> = []
  const host = createPluginUiHost({ name, sdk, meta, suppressed: suppressedOwners, disposers })
  const restoreScope = installPluginScope(host, sdk)
  try {
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
      /*
        模块求值期可能已经注册了一部分（顶层形态）：必须回滚，否则"加载失败"的插件会留下半截 UI。
        装上作用域之前这不可能发生 —— 那批注册会落到全局 SDK 名下，只是更难发现而已。
      */
      rollbackDisposers(disposers)
      return
    }
    // 迟到检查：await 期间该插件可能已被卸载，或已不再被入口表需要（例如用户刚点了停用）
    if ((epochs.get(name) ?? 0) !== epoch || !(name in desired) || loaded.has(name)) {
      console.debug(`[geewiki-plugin-ui] 丢弃迟到的插件界面加载：${name}`)
      // 同上：模块求值期的注册必须跟着这次作废的加载一起回滚
      rollbackDisposers(disposers)
      return
    }
    const register =
      typeof mod.register === 'function'
        ? (mod.register as (host: PluginUiHost) => unknown)
        : typeof mod.default === 'function'
          ? (mod.default as (host: PluginUiHost) => unknown)
          : undefined
    if (!register) {
      /*
        顶层注册形态（bundle 在模块求值时注册、**不导出** `register(host)`）：以前这里直接 return ——
        于是这类插件的贡献既没进 `loaded`（停用时收不回），也不受 `failed` / `loaded` 短路保护
        （每轮轮询重复 import）。现在照样登记：它注册的东西已经在 `disposers` 里了。
      */
      console.debug(`[geewiki-plugin-ui] 插件 bundle 未导出 register(host)，按其模块顶层注册登记：${name}`)
    } else {
      try {
        const cleanup = register(host)
        if (typeof cleanup === 'function') disposers.push(cleanup as () => void)
      } catch (err) {
        // 插件入口自身执行失败：回滚它已经注册的部分，避免留下半截 UI
        console.warn(`[geewiki-plugin-ui] 插件 ${name} 的客户端入口执行失败，已回滚：`, err)
        rollbackDisposers(disposers)
        return
      }
    }
    const link = meta.css ? injectCss(name, `${base}/${meta.css}`) : undefined
    loaded.set(name, { plugin: name, rev: meta.rev, disposers, link })
    // 成功即自愈：清掉这个插件此前可能留下的失败记录，否则提示条会在问题已解决后继续挂着
    failedLoads.delete(name)
    emitState()
    console.debug(`[geewiki-plugin-ui] 已加载插件界面：${name}`)
  } finally {
    // 所有出口（含上面每个 return）都还原全局对象：作用域绝不能跨过本次加载存活
    restoreScope()
  }
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

/*
 * 验收脚本用的调试出口 —— **只在浏览器里**挂。
 *
 * 与 `hostSdk.ts` 的安装同一理由（P7）：`src/ui/*` 的原语在定义处接了 `<Ext>`，
 * 于是 Node 测试直接 import 那些原语时会牵进本模块，模块求值期读 `window` 会当场炸，
 * 而报错点看起来完全不在被测代码上。守卫之后 Node 下 import 本模块是安全的。
 */
if (typeof window !== 'undefined') {
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
}
