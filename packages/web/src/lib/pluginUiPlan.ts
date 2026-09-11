/**
 * 插件 UI 入口表的**纯函数**部分：解析后端下发的表、算出"该加载/该卸载"的差集、
 * 以及插件名 → UI 目录 URL 的组装。
 *
 * 独立成模块的原因很实际：`pluginUi.ts` 顶层就写 `window.__GEEWIKI_PLUGIN_UI__ = …`，
 * 在 node 里 import 它会直接 `ReferenceError: window is not defined`。把可判定逻辑挤进
 * 这个不接触 DOM/window 的模块，才能用 `node --test` 直接单测（见 `packages/web/test/`）。
 *
 * ## 与后端契约的对应关系
 *
 * 后端 `GET /api/plugins/ui`（`packages/manager/src/plugin-ui.ts` 的 `buildPluginUiTable`）
 * 返回 `{ ok, version: 1, revision, plugins: { <插件名>: { entry, css?, rev } }, skipped: [...] }`，
 * 其中 `plugins` **只含**"已激活 ∩ 声明了 `geewiki.client` ∩ 入口文件确实存在"的插件。
 * 因此前端不再需要（也不应该）自己拿 `GET /api/plugins` 的 state 去和入口表对齐——那是竞态源：
 * 两次请求之间插件状态可能变化，于是"表里有、列表里没"这类瞬时不一致就会被误判成卸载。
 *
 * ## 两条已实测证伪的坑（改动本模块前请先读）
 *
 * 1. **不要给 bundle URL 加 `?v=<rev>` 之类的 query**：给**根相对** URL 加 query 在 dev 下会被
 *    Vite 的 `injectQuery` 改写成 `?import&v=…` → 必然 500（`This file is in /public…`）；
 *    而即使改用同源绝对 URL 绕开改写，`rev` 一变就产生**新模块实例**，可 ESM 无法从模块图卸载
 *    → 每次改版常驻一份实例（实测插槽条目翻倍）。故 `rev` 只用作**变更检测**，不进 URL；
 *    真正换代码的路径是 unload → load（同 URL 命中模块缓存，新产物需整页刷新才生效）。
 * 2. **`/* @vite-ignore *\/` 并不能阻止 Vite 改写动态 import**：dev 之所以没踩坑，是因为
 *    {@link pluginUiBase} 返回的是**同源绝对 URL**（首字符 `h`），而 `injectQuery` 只对以
 *    `.`/`/` 开头的 URL 追加参数。这个"同源绝对 URL"的形态是硬要求，不要改成相对路径。
 */

/** 后端入口表端点（`GET /api/plugins/ui`） */
export const PLUGIN_UI_TABLE_PATH = '/api/plugins/ui'

/**
 * UI 资产文件名（单段）：与 core 的 `PLUGIN_UI_FILE_SEGMENT` **同一规则**。
 * web 侧不引入 `@geewiki/core`（它顶层 `import 'node:fs'`，进不了浏览器），故保留同名副本；
 * 两处一致性由测试的同一张输入表钉住（`packages/web/test/pluginUiPlan.test.ts`）。
 */
export const PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** UI 资产 URL 前缀（与 core 的 `PLUGIN_UI_PREFIX` 同一常量值） */
export const PLUGIN_UI_PREFIX = '/plugins-ui'

/** 入口表中单个插件的条目 */
export interface UiTableEntry {
  /** UI 入口文件名（单段） */
  entry: string
  /** 可选样式文件名（单段） */
  css?: string
  /** 该插件产物指纹（后端 stat 出来的 mtime-大小哈希）；**只用于变更检测，不进 URL** */
  rev: string
  /**
   * 该插件**实际生效**的插槽（后端经 `effectiveSlotsByOwner` 按基数裁决后下发）。
   *
   * 两个用途，彼此独立：
   * ① **越权拦阻**：被抑制的声明者不会出现在这里，宿主据此拒绝它注册该插槽——
   *    于是单占用插槽的权威裁决在后端，前端不需要自己算激活顺序。
   * ② **懒加载判定**：见 {@link isLazyOnlyEntry}。
   *
   * 后端在无生效插槽时**省略该键**（保持既有部署的 `revision` 不变），故这里可能缺省。
   */
  slots?: SlotName[]
}

/**
 * 插槽白名单：与 core 的 `SLOT_NAMES` / `slots.tsx` 的 `SLOT_NAMES` 是同一份事实的镜像。
 * web 侧不引 `@geewiki/core`（顶层 `import 'node:fs'`），故保留副本；
 * 三处一致性由 `packages/web/test/editorSlotProps.test.ts` 的源码级守卫钉住。
 */
export type SlotName = 'app-header' | 'app-footer' | 'editor'

export const SLOT_NAMES: readonly SlotName[] = ['app-header', 'app-footer', 'editor']

function isSlotName(value: unknown): value is SlotName {
  return typeof value === 'string' && (SLOT_NAMES as readonly string[]).includes(value)
}

/** 入口表的 `slots` 字段：非数组按缺省处理、未知插槽名逐条丢弃（前向兼容）。 */
function readSlots(raw: unknown): SlotName[] | undefined {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.debug('[geewiki-plugin-ui] 入口表 slots 不是数组，按缺省处理')
    return undefined
  }
  const out: SlotName[] = []
  for (const item of raw) {
    if (!isSlotName(item)) {
      console.debug(`[geewiki-plugin-ui] 入口表插槽名未知，已忽略：${String(item)}`)
      continue
    }
    if (!out.includes(item)) out.push(item)
  }
  return out
}

/**
 * 只有 `editor` 一个生效插槽的条目 ⇒ **可以推迟加载**。
 *
 * ## 为什么这是一个可推导的判据，而不是拍脑袋的启发式
 * 懒加载的目的：**首屏不该为一个"用户大概率用不到"的插件付出加载成本**。
 * 而"用户何时需要它"取决于它贡献到哪个插槽：
 * - `app-header` / `app-footer` **首屏就渲染**（在 App 外壳里），推迟它们毫无意义，
 *   反而会先渲染空位再补内容（视觉抖动）；
 * - `editor` 只在进入编辑视图时才渲染，而绝大多数访问**只看文档**——正是值得推迟的那一类。
 *
 * 因此：**生效插槽非空且全部是 `editor`** 的插件，其 `client.js` 推迟到编辑视图真正挂载时再取。
 * 若它同时还贡献了 header/footer，则**不推迟**（首屏就要用）。
 *
 * ## 已知边界（这是本判据的局限，已作为范围外发现上报）
 * 后端 manifest 目前只能声明 `slots: SlotName[]`，**表达不了"某个插槽贡献是懒的"**——
 * `SlotContributionMeta.lazy` 只在运行期 `contribute()` 时可用，而运行期 contribute 本身
 * 就要求先加载 bundle，对懒加载是循环依赖。所以"部分懒"（同一插件既贡献 header 又懒贡献 editor）
 * 今天**做不到**：这类插件只能整包不推迟。真正的解法是让 manifest/入口表带上 per-slot 的 lazy
 * 标志（需改 core 契约）。
 */
export function isLazyOnlyEntry(entry: UiTableEntry): boolean {
  const slots = entry.slots
  if (slots === undefined || slots.length === 0) return false
  return slots.every((slot) => slot === 'editor')
}

/* ===================== 插槽仲裁（单占用被抑制者不得注册） ===================== */

/** 后端 `GET /api/plugins/slots` 的路径 */
export const SLOT_TABLE_PATH = '/api/plugins/slots'

/**
 * 被抑制的声明者：插槽名 → 不得注册该插槽的插件名集合。
 *
 * ## 为什么前端必须独立拿这份信息（**这是实测抓出来的真缺陷**）
 * `editor` 是单占用插槽，被抑制的插件**仍然是 active 的**：它的 bundle 照样加载、照样调用
 * `registerSlot('editor', …)`。若不拦，两个编辑器会同时渲染。
 *
 * 最初我按入口表的 `slots` 字段来拦（"该字段存在且不含此插槽 ⇒ 拒绝"），**E2E 实测发现这条路
 * 是漏的**：后端在**生效插槽为空时省略该键**（为了让既有部署的 revision 不无谓变化），
 * 于是"声明了但被抑制"与"根本没声明插槽"在入口表里**无法区分**——被抑制者因为键缺失而通过了检查，
 * 结果抑制者的编辑器真的渲染了出来（实测 `editorSource: '@geewiki/editor-plain'`，
 * 而赢家是 `@demo/editor-alt`）。
 *
 * 故改为读**权威仲裁**：`GET /api/plugins/slots` 的 `suppressed` 字段。
 * 这与管理器自己的注释一致——`packages/manager/src/index.ts:376-379` 明写
 * "前端（`GET /api/plugins/ui`）与诊断端点（`GET /api/plugins/slots`）都必须读同一份结果；
 * 若各处各自按 list() 重新判一遍基数，就会出现'表里说 A 生效、界面渲染 B'这种极难排查的分裂"。
 *
 * ## 为什么不会误伤"运行期贡献"的插件
 * 后端 `owners` 只含**服务端**声明（manifest）与**服务端** `ctx.slot.contribute()` 的贡献；
 * 纯浏览器侧注册的插件（如 `plugins/ui-demo` 在 `client.js` 里注册 app-header/app-footer）
 * 根本不在 `owners` 里，因此**不受任何限制**——既有行为完全保留。
 */
export type SuppressedOwners = ReadonlyMap<SlotName, ReadonlySet<string>>

/** 解析 `GET /api/plugins/slots` 响应，取出"被抑制的声明者"。整体不可信时返回 undefined。 */
export function parseSuppressedOwners(payload: unknown): SuppressedOwners | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as { slots?: unknown }
  if (!Array.isArray(body.slots)) return undefined
  const out = new Map<SlotName, Set<string>>()
  for (const raw of body.slots) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { slot?: unknown; suppressed?: unknown }
    if (!isSlotName(item.slot)) continue
    if (!Array.isArray(item.suppressed) || item.suppressed.length === 0) continue
    const set = out.get(item.slot) ?? new Set<string>()
    for (const owner of item.suppressed) {
      if (typeof owner === 'string' && owner) set.add(owner)
    }
    if (set.size > 0) out.set(item.slot, set)
  }
  return out
}

/**
 * 入口表**没**列出某插件的原因（后端 `buildPluginUiTable` 的四值枚举）。
 *
 * 判定优先级（后端顺序，前端不重算、只如实展示）：`invalid_name` > `inactive` > `no_client` > `entry_missing`。
 */
export type UiSkipReason = 'inactive' | 'no_client' | 'entry_missing' | 'invalid_name'

/** 入口表里被跳过的一项 */
export interface UiSkipped {
  /** 插件名（原样，不做 URL 编码） */
  name: string
  reason: UiSkipReason
}

/** 全部合法 reason（校验与测试共用一张表） */
export const UI_SKIP_REASONS: readonly UiSkipReason[] = ['inactive', 'no_client', 'entry_missing', 'invalid_name']

export interface ParsedUiTable {
  /** 整表指纹：用于 `If-None-Match` 与"什么都没变"的快速短路 */
  revision: string
  entries: Record<string, UiTableEntry>
  /**
   * 未被列出 UI 的插件与原因。**注意**：`revision` 只覆盖 `plugins`，不含 `skipped`
   * （见后端 `buildPluginUiTable` 的哈希输入），所以"新装了一个未启用/无界面的插件"这类
   * 变化**不会**改变 `revision`。管理台要看到这种情况必须走 `syncPluginUi({ force: true })`
   * 拉一次完整表（见 `AdminPage` 的 `load()`）。
   */
  skipped: UiSkipped[]
}

/** 单个路径段是否可作为插件名的一部分：非空、无分隔符、不是 `.`/`..`、无空白与控制字符 */
function isNameSegment(segment: string): boolean {
  if (!segment) return false
  if (segment === '.' || segment === '..') return false
  if (segment.includes('/') || segment.includes('\\')) return false
  // eslint-disable-next-line no-control-regex -- 显式排除控制字符（含 NUL）是安全校验的一部分
  if (/[\s\u0000-\u001f\u007f]/.test(segment)) return false
  return true
}

/**
 * 插件名能否安全地原样放进 URL 路径。规则与后端 `isPluginUiName` **逐条一致**：
 * 非 scope 名恰好 1 段且不以 `@` 开头（`wiki`）；scope 名恰好 2 段、首段以 `@` 开头且长度 > 1
 * （`@geewiki/wiki`）。因此 `a/b/c`、`../x`、`a b`、`@scope`（只有 scope 无名字）、`wiki/x`、
 * 空串都非法。
 *
 * **插件名不做 URL 编码**：编码后的 `%40geewiki%2Fwiki` 在 dev 会落 SPA fallback（200 + text/html）、
 * 在 prod 静态层不解码必 404，所以这里一律拒绝而非"修正"。
 */
export function isPluginUiName(name: string): boolean {
  const segments = name.split('/')
  if (segments.length === 1) {
    const only = segments[0] as string
    return !only.startsWith('@') && isNameSegment(only)
  }
  if (segments.length === 2) {
    const scope = segments[0] as string
    const rest = segments[1] as string
    return scope.length > 1 && scope.startsWith('@') && isNameSegment(scope) && isNameSegment(rest)
  }
  return false
}

/**
 * 插件名 → 该插件 UI 目录的**同源绝对 URL**（不带结尾斜杠、不带 query）。
 *
 * @param origin 同源基准（如 `window.location.origin`）。显式传入而非内部读 `window`，
 *               这样本模块保持纯净、可在 node 下测试。
 * @returns 插件名非法时返回 `undefined`（与既有调试入口 `__GEEWIKI_PLUGIN_UI__.base(name)`
 *          的"非法名返回 undefined"语义一致；选择**返回 undefined 而非抛错**，是因为调用点
 *          都在异步加载路径上，抛错只会变成未处理的 rejection）。
 */
export function pluginUiBase(name: string, origin: string): string | undefined {
  if (!isPluginUiName(name)) return undefined
  return new URL(`${PLUGIN_UI_PREFIX}/${name}`, origin).href
}

function readEntry(raw: unknown): UiTableEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const item = raw as { entry?: unknown; css?: unknown; rev?: unknown; slots?: unknown }
  // entry 缺失或文件名非法 → 整条丢弃（后端保证不会发生，这里防的是中间层/旧版本)
  if (typeof item.entry !== 'string' || !PLUGIN_UI_FILE_SEGMENT.test(item.entry)) return undefined
  // css 非法同样整条丢弃：与后端 `pluginUiEntryOf` 的"坏声明整体视为未声明"保持一致，
  // 避免出现"入口可用但样式名是穿越路径"这种半可信状态
  if (item.css !== undefined && (typeof item.css !== 'string' || !PLUGIN_UI_FILE_SEGMENT.test(item.css))) {
    return undefined
  }
  // rev 只用于变更检测；不是字符串时整条丢弃（后端必定下发，宁可少加载一个也不做无依据的变更判断）
  if (typeof item.rev !== 'string') return undefined
  // slots 从宽（与 skipped 同理）：它影响的是"哪些插槽允许注册"与"是否可推迟加载"，
  // 坏掉的 slots 不该让整条 UI 加载失败——按缺省（无生效插槽）处理，
  // 后果只是"该插件不能注册插槽 / 不被推迟"，而不是"界面消失"。
  const slots = readSlots(item.slots)
  return {
    entry: item.entry,
    rev: item.rev,
    ...(item.css === undefined ? {} : { css: item.css }),
    ...(slots === undefined ? {} : { slots }),
  }
}

function isSkipReason(value: unknown): value is UiSkipReason {
  return typeof value === 'string' && (UI_SKIP_REASONS as readonly string[]).includes(value)
}

/**
 * 解析 `skipped` 数组。
 *
 * **刻意从宽**：`skipped` 只用于管理台展示，而入口表是 UI 加载的关键路径——一个坏掉的
 * `skipped` 绝不能连带把"加载/卸载"也判为不可信。因此数组本身不可信时当空数组处理，
 * 单条不可信时只丢该条。未知 reason 也丢弃（前向兼容：宁可少显示一项，也不要误分级）。
 */
function readSkipped(raw: unknown): UiSkipped[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.debug('[geewiki-plugin-ui] 入口表 skipped 不是数组，按空处理')
    return []
  }
  const out: UiSkipped[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { name?: unknown; reason?: unknown }
    if (typeof entry.name !== 'string' || !entry.name) continue
    if (!isSkipReason(entry.reason)) {
      console.debug(`[geewiki-plugin-ui] 入口表跳过项原因未知，已忽略：${entry.name}`)
      continue
    }
    out.push({ name: entry.name, reason: entry.reason })
  }
  return out
}

/**
 * 解析入口表响应体。
 *
 * @returns 成功返回 `{ revision, entries, skipped }`；**整体不可信时返回 `undefined`**——
 *          调用方据此**既不加载也不卸载**（网络抖动/中间层改坏响应时，绝不能把已加载的 UI 清空）。
 *
 * 整体判为不可信的情形：非对象/数组/`null`、`version !== 1`、`plugins` 不是对象、
 * `revision` 不是字符串。
 * 单条判为不可信的情形（只跳过该条 + `console.debug`，不影响其它插件）：插件名非法、
 * `entry`/`css` 文件名非法、`rev` 不是字符串。
 * `skipped` 单独从宽处理（见 {@link readSkipped}），不影响上面的可信性判定。
 */
export function parseUiTable(payload: unknown): ParsedUiTable | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as { version?: unknown; revision?: unknown; plugins?: unknown; skipped?: unknown }
  if (body.version !== 1) return undefined
  if (typeof body.revision !== 'string') return undefined
  const raw = body.plugins
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entries: Record<string, UiTableEntry> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPluginUiName(name)) {
      console.debug(`[geewiki-plugin-ui] 入口表插件名非法，跳过：${name}`)
      continue
    }
    const parsed = readEntry(value)
    if (!parsed) {
      console.debug(`[geewiki-plugin-ui] 入口表条目非法，跳过：${name}`)
      continue
    }
    entries[name] = parsed
  }
  return { revision: body.revision, entries, skipped: readSkipped(body.skipped) }
}

/** 跳过项的分级：`attention` = 本该可见却没出现（或清单有问题），`normal` = 设计上就没有 UI */
export type UiSkipSeverity = 'attention' | 'normal'

export interface UiSkipGroups {
  /** 需要注意：`entry_missing`（声明了入口但产物不存在）与 `invalid_name`（插件名不合路径约定） */
  attention: UiSkipped[]
  /** 正常：`inactive`（未启用）与 `no_client`（本就没有前端界面） */
  normal: UiSkipped[]
}

/**
 * 按 severity 把跳过项分成两组，供管理台**分级呈现**。
 *
 * 分级的理由：`entry_missing` 是"作者声明了界面、产物却没跟上"的真实故障（典型症状是发布漏带
 * `dist/`），必须显著；而 `inactive` / `no_client` 是**预期状态**——把它们和故障同级用告警样式
 * 呈现，只会让真正的故障淹没在噪声里。两组各自按名排序，保证渲染确定性。
 */
export function classifyUiSkips(skipped: readonly UiSkipped[]): UiSkipGroups {
  const attention: UiSkipped[] = []
  const normal: UiSkipped[] = []
  for (const item of skipped) {
    if (item.reason === 'entry_missing' || item.reason === 'invalid_name') attention.push(item)
    else normal.push(item)
  }
  const byName = (a: UiSkipped, b: UiSkipped): number => a.name.localeCompare(b.name)
  attention.sort(byName)
  normal.sort(byName)
  return { attention, normal }
}

/** reason → 中文短标签（管理台展示用） */
export const UI_SKIP_LABEL: Record<UiSkipReason, string> = {
  entry_missing: '界面产物缺失',
  invalid_name: '插件名不合约定',
  inactive: '未启用',
  no_client: '无前端界面',
}

/** reason → 一句人话解释（管理台展示用，说明"这意味着什么、要不要管"） */
export const UI_SKIP_HELP: Record<UiSkipReason, string> = {
  entry_missing: '清单声明了 geewiki.client，但入口文件在插件自带产物与内置根里都找不到——通常是发布时漏带 dist/ 目录。',
  invalid_name: '插件名不能作为 URL 路径段（需 1 段，或 2 段的 @scope/name），因此它的界面资产无法定位。',
  inactive: '插件当前未启用。界面只跟随已激活的插件，启用后会自动出现。',
  no_client: '该插件未声明 geewiki.client，按设计就没有前端界面（例如纯后端服务插件）。',
}

export interface UiSyncPlan {
  /** 需要加载的插件名（按名排序，保证确定性） */
  load: string[]
  /** 需要卸载的插件名（按名排序） */
  unload: string[]
}

/**
 * 算出"当前已加载"到"入口表要求"的差集。
 *
 * @param entries 入口表条目
 * @param loaded  已加载插件的 `名字 → 当时加载的 rev`
 * @param defer   需要**推迟加载**的插件名（见 {@link isLazyOnlyEntry}）：它们**不出现在 `load` 里**，
 *                改由 `ensureSlotLoaded()` 在插槽真正要渲染时按需加载。
 *                刻意用**显式参数**而不是在函数里自行推导：推迟是调用方的策略，
 *                这个纯函数只负责算差集，便于单测两种策略下的行为。
 * @returns `load` = 表中新增的 + rev 变化的（**减去被推迟的**）；`unload` = 已加载但表中没有的 + rev 变化的。
 *          **rev 变化会同时出现在两个数组里**（先卸后装），因为产物换了必须重新执行 `register`；
 *          两者都按名排序，保证同一输入必定得到同一计划（幂等、可断言、不会因 Map 顺序抖动）。
 */
export function planUiSync(
  entries: Readonly<Record<string, UiTableEntry>>,
  loaded: ReadonlyMap<string, string>,
  defer: ReadonlySet<string> = new Set(),
): UiSyncPlan {
  const load: string[] = []
  const unload: string[] = []
  for (const name of Object.keys(entries)) {
    const current = loaded.get(name)
    const rev = (entries[name] as UiTableEntry).rev
    if (current === undefined) {
      // 未加载且被推迟 ⇒ 不进 load（留给按需加载）
      if (!defer.has(name)) load.push(name)
    } else if (current !== rev) {
      // rev 变化：**即使被推迟也必须先卸**（旧产物必须停止贡献），重新装载则等按需触发
      unload.push(name)
      if (!defer.has(name)) load.push(name)
    }
  }
  for (const name of loaded.keys()) {
    if (!(name in entries)) unload.push(name)
  }
  load.sort()
  unload.sort()
  return { load, unload }
}

/**
 * 界面是否已经"收敛"到入口表 `entries`：每个条目要么已按同一 rev 加载，要么已按同一 rev 失败过，
 * 要么**已被按需推迟**，且没有多余的在加载项。
 *
 * **为什么需要它**：调用方只有在收敛时才敢用 `If-None-Match` 做 304 短路。两者可能脱钩——某次加载
 * 失败时 `revision` 已推进到新值而该插件并不在已加载集合里；由于 `revision` 只是表格内容的哈希，
 * "启用 → 停用 → 再启用"会回到**同一个** revision，此时 304 会让宿主**永久**漏加载那个插件。
 * 因此未收敛时必须放弃 304、强制取一次完整表重新对齐。
 *
 * @param failed 已知加载失败的条目（插件名 → 失败时的 rev）。它们被视为已收敛，避免每轮轮询
 *               都为同一个坏产物重复 import 与重复告警；rev 变化后自然重新尝试。
 * @param deferred 已按需推迟的条目（插件名 → 决定推迟时的 rev）。与 `failed` **同构**：
 *               它们"处理完了"（按需加载是刻意的，不是遗漏），故视为收敛，
 *               否则每轮轮询都会放弃 304、白拉一次完整表。rev 变化后推迟决定自然作废并重新评估。
 */
export function isUiSettled(
  entries: Readonly<Record<string, UiTableEntry>>,
  loaded: ReadonlyMap<string, string>,
  failed: ReadonlyMap<string, string> = new Map(),
  deferred: ReadonlyMap<string, string> = new Map(),
): boolean {
  let settled = 0
  for (const name of Object.keys(entries)) {
    const rev = (entries[name] as UiTableEntry).rev
    if (loaded.get(name) === rev) {
      settled++
      continue
    }
    // 已按同一 rev 失败过 → 也算"处理完了"（它不在 loaded 里，故不计入 settled）
    if (failed.get(name) === rev) continue
    // 已按同一 rev 决定按需推迟 → 同样算"处理完了"（推迟是刻意的，不是遗漏）
    if (deferred.get(name) === rev) continue
    return false
  }
  // 除已成功加载的那些之外不该有多余项（多出来的要卸载；含"在加载但已不在表中"的情况）
  return loaded.size === settled
}
