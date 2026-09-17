/**
 * 导航与命令面板的**可见性纯逻辑**（无 DOM、无 React、可单测）。
 * ============================================================================
 *
 * 为什么单独一个文件：顶栏导航有**三处渲染点**（桌面 tab、桌面「管理 ▾」下拉、
 * 窄屏菜单），命令面板又是一处独立的硬编码动作表。这四处的"某项该不该出现"
 * 必须用**同一个判据**，否则迟早漂移成"桌面看不到、窄屏却看得到"这类
 * 只在某个宽度下复现的问题。这里把判据收成唯一的纯函数，各渲染点只负责画。
 *
 * ## 判据的方向：**失败关闭**
 *
 * `caps === null` 表示"还不知道我是谁"（首帧，`/api/auth/state` 尚未回来）。
 * 此时**一律不显示**需要能力的目的地 —— 而不是先显示再收回。
 * 理由：先显示后收回会让管理员菜单在首帧闪一下，而"闪一下"本身就在告诉
 * 匿名访客"这里有个运维入口"；反过来，管理员多等一次请求是没有代价的。
 *
 * 服务端对匿名主体下发的是**全 `false` 的对象**（不是 `null`，
 * 见 `packages/plugin-auth/src/index.ts:453-454`），所以正常路径下
 * 这个函数拿到的要么是 `null`（加载中），要么是可以直接信任的布尔值。
 *
 * ⚠️ **前端隐藏不是安全措施**（设计文档 §9 R10 反模式第 5 条）：服务端的判定
 * 独立进行，这里只是**不显示入口**，让界面不出现点了必然失败的按钮。
 */
import {
  BUILTIN_CAPABILITIES,
  isCapabilityName,
  type CapabilityName,
} from '@geewiki/core/domain'
import type { AuthCapabilities } from '../api'

/**
 * 导航项可以要求的能力。
 *
 * ★ F9：从 `keyof AuthCapabilities`（编译期闭合的三个键）放宽为开放的能力名 ——
 * 内置的三个 + 插件用 `a/b` 命名空间**声明**的任何名字。原先插件想让自己的导航项
 * 要求一个新能力是**做不到**的：键不存在 ⇒ `caps?.[key] === true` 恒假 ⇒
 * 该入口永远不出现、且没有任何日志。
 */
export type NavCapability = CapabilityName

/**
 * 一个"目的地"：导航项与命令面板动作共用的最小形状。
 *
 * 刻意只要求 `id` / `label` / `requires?`：调用方可以在其上叠加 `icon` / `run` /
 * `hint` 等各自需要的字段（泛型 `T extends NavDest` 会把它们原样带出来），
 * 于是**图标这类 React 节点不必进这个纯模块**。
 */
export interface NavDest {
  id: string
  label: string
  /** 缺省 = 对所有访问者可见（含未登录）。给了值 ⇒ 该能力为 `true` 才显示 */
  requires?: NavCapability
}

/**
 * 按能力过滤目的地。**保持入参顺序**（导航顺序是产品契约，不在这里重排）。
 *
 * 判据写成 `caps?.[d.requires] === true` 而不是 `!== false`：
 * - `caps === null`（加载中）⇒ `undefined === true` 为假 ⇒ **不显示**（失败关闭）；
 * - 能力键缺失（服务端将来改名/漏发）⇒ 同样为假 ⇒ 不显示。
 * 用 `!== false` 会把这两种情况都判成"显示"，方向正好相反。
 */
export function visibleDests<T extends NavDest>(
  dests: readonly T[],
  caps: AuthCapabilities | null,
): T[] {
  return dests.filter((d) => d.requires === undefined || caps?.[d.requires] === true)
}

/* ==================== F2：插件声明的路由 → 导航项 ==================== */

/**
 * **内置**能力键的运行期清单。
 *
 * ★ F9：不再是本地手抄的第三份 —— 直接转出 `@geewiki/core/domain` 的唯一真源。
 * 原先这里手写三元素数组、再用一对 `Expect<...>` 编译期断言与 `keyof AuthCapabilities`
 * 互钉，那套机器存在的全部理由是"有三份真源要保持同步"。真源归一后它就该消失：
 * **构造上不可能漂移**比"漂移了会被测试发现"更强。
 */
export const NAV_CAPABILITIES = BUILTIN_CAPABILITIES

/** 插件路由声明里与导航相关的字段（`PluginRouteDecl` 的结构子集） */
export interface PluginNavSource {
  readonly id: string
  readonly label?: string
  readonly group?: 'main' | 'admin'
  readonly requires?: string
}

/**
 * 把插件声明的路由折算成**导航项**：只有同时给了 `label` 与 `group` 的才进导航
 * （缺任一个 = 该页面只能被链接访问，不出现在任何菜单里）。
 *
 * ## 判据方向同样是**失败关闭**
 * - 未识别的 `requires` 值 ⇒ **丢弃该项并告警**，而不是"当作无要求"放行。
 *   放行会让一个要求 `administer` 却把键拼错的页面**对所有匿名访客可见**——
 *   虽然服务端仍会拦（前端隐藏不是安全措施），但用户会看到一个点进去必然失败的入口。
 * - 缺 `label`/`group` 而 `requires` 又非法 ⇒ 同样丢弃（但只对进导航的那些告警，避免噪声）。
 *
 * 返回值保持**入参顺序**（插件路由的顺序已在 `pluginUi.ts` 的 `rebuildRoutes()` 里定死）。
 */
export function pluginNavDests<T extends PluginNavSource>(
  routes: readonly T[],
): (T & { label: string; requires?: NavCapability })[] {
  const out: (T & { label: string; requires?: NavCapability })[] = []
  for (const route of routes) {
    if (route.label === undefined || route.group === undefined) continue
    const requires = route.requires
    /*
     * ★ F9：合法判据从"必须命中内置三键"放宽为"内置 ∪ 插件命名空间（含 `/`）"。
     *
     * 放宽**没有**牺牲拼写错误的可见性：斜杠把两个命名空间切开了，所以
     * `edtiContent` 既不匹配任何内置名、也不满足 `a/b` 的语法 ⇒ 仍然走告警分支。
     * 这一点是刻意的设计（见 core 的 `PLUGIN_CAPABILITY_NAME` 注释）——
     * 若改成"任意字符串都算合法能力名"，一次拼写错误就会变成一次**静默放行**。
     */
    if (requires !== undefined && !isCapabilityName(requires)) {
      console.warn(
        `[geewiki-nav] 插件路由 "${route.id}" 声明了非法的能力键 ${JSON.stringify(requires)}，` +
          `该导航项已隐藏（内置能力：${BUILTIN_CAPABILITIES.join(', ')}；` +
          '插件自定义能力须形如 "namespace/name"）。' +
          '若这是拼写错误，请改正；宿主不会把未知能力当作"无要求"放行。',
      )
      continue
    }
    out.push({
      ...route,
      label: route.label,
      ...(requires === undefined ? {} : { requires: requires as NavCapability }),
    })
  }
  return out
}
