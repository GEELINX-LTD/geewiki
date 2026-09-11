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
import type { AuthCapabilities } from '../api'

/** 导航项可以要求的能力。取值必须是服务端下发的 `AuthCapabilities` 的键 —— 用 `keyof` 约束，避免手写字符串漂移 */
export type NavCapability = keyof AuthCapabilities

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
