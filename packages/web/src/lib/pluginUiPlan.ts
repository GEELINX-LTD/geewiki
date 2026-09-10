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
}

export interface ParsedUiTable {
  /** 整表指纹：用于 `If-None-Match` 与"什么都没变"的快速短路 */
  revision: string
  entries: Record<string, UiTableEntry>
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
  const item = raw as { entry?: unknown; css?: unknown; rev?: unknown }
  // entry 缺失或文件名非法 → 整条丢弃（后端保证不会发生，这里防的是中间层/旧版本)
  if (typeof item.entry !== 'string' || !PLUGIN_UI_FILE_SEGMENT.test(item.entry)) return undefined
  // css 非法同样整条丢弃：与后端 `pluginUiEntryOf` 的"坏声明整体视为未声明"保持一致，
  // 避免出现"入口可用但样式名是穿越路径"这种半可信状态
  if (item.css !== undefined && (typeof item.css !== 'string' || !PLUGIN_UI_FILE_SEGMENT.test(item.css))) {
    return undefined
  }
  // rev 只用于变更检测；不是字符串时整条丢弃（后端必定下发，宁可少加载一个也不做无依据的变更判断）
  if (typeof item.rev !== 'string') return undefined
  return item.css === undefined ? { entry: item.entry, rev: item.rev } : { entry: item.entry, css: item.css, rev: item.rev }
}

/**
 * 解析入口表响应体。
 *
 * @returns 成功返回 `{ revision, entries }`；**整体不可信时返回 `undefined`**——
 *          调用方据此**既不加载也不卸载**（网络抖动/中间层改坏响应时，绝不能把已加载的 UI 清空）。
 *
 * 整体判为不可信的情形：非对象/数组/`null`、`version !== 1`、`plugins` 不是对象、
 * `revision` 不是字符串。
 * 单条判为不可信的情形（只跳过该条 + `console.debug`，不影响其它插件）：插件名非法、
 * `entry`/`css` 文件名非法、`rev` 不是字符串。
 */
export function parseUiTable(payload: unknown): ParsedUiTable | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as { version?: unknown; revision?: unknown; plugins?: unknown }
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
  return { revision: body.revision, entries }
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
 * @returns `load` = 表中新增的 + rev 变化的；`unload` = 已加载但表中没有的 + rev 变化的。
 *          **rev 变化会同时出现在两个数组里**（先卸后装），因为产物换了必须重新执行 `register`；
 *          两者都按名排序，保证同一输入必定得到同一计划（幂等、可断言、不会因 Map 顺序抖动）。
 */
export function planUiSync(entries: Readonly<Record<string, UiTableEntry>>, loaded: ReadonlyMap<string, string>): UiSyncPlan {
  const load: string[] = []
  const unload: string[] = []
  for (const name of Object.keys(entries)) {
    const current = loaded.get(name)
    if (current === undefined) load.push(name)
    else if (current !== (entries[name] as UiTableEntry).rev) {
      unload.push(name)
      load.push(name)
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
 * 且没有多余的在加载项。
 *
 * **为什么需要它**：调用方只有在收敛时才敢用 `If-None-Match` 做 304 短路。两者可能脱钩——某次加载
 * 失败时 `revision` 已推进到新值而该插件并不在已加载集合里；由于 `revision` 只是表格内容的哈希，
 * "启用 → 停用 → 再启用"会回到**同一个** revision，此时 304 会让宿主**永久**漏加载那个插件。
 * 因此未收敛时必须放弃 304、强制取一次完整表重新对齐。
 *
 * @param failed 已知加载失败的条目（插件名 → 失败时的 rev）。它们被视为已收敛，避免每轮轮询
 *               都为同一个坏产物重复 import 与重复告警；rev 变化后自然重新尝试。
 */
export function isUiSettled(
  entries: Readonly<Record<string, UiTableEntry>>,
  loaded: ReadonlyMap<string, string>,
  failed: ReadonlyMap<string, string> = new Map(),
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
    return false
  }
  // 除已成功加载的那些之外不该有多余项（多出来的要卸载；含"在加载但已不在表中"的情况）
  return loaded.size === settled
}
