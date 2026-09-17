/**
 * 能力服务作为**独立 cordis 插件**提供（★ F9）。
 *
 * ## 为什么不能由管理器在自己的 `apply` 里 provide
 * 这一点是**实测踩出来的**，与 `slot-plugin.ts` 的结论完全同源，故不再犯第二次：
 *
 * 最初的 F9 实现是"管理器在 `apply` 里 `ctx.provide('capability-service', …)`，
 * 然后 `boot()` 激活各插件"。结果：**插件在自己的 `apply` 里 `ctx.get('capability-service')`
 * 拿到 `undefined`，它的能力注册被静默跳过** —— 表现是"插件声明了能力、却没有对应的求解器"，
 * 于是那道能力闸门对所有主体恒 403，而**没有任何报错**能把它与"这个插件本来就没注册"区分开。
 *
 * 机制（仓库已记录）：**在一个插件 `apply` 尚未结算时 `provide` 的服务，
 * 对它在此期间创建的子插件不可见**；而 `boot()` 正是在管理器的 `apply` 内部激活插件，
 * 于是"管理器 provide + 自己 boot"这个组合天然不成立。
 *
 * 正确做法与 `@geewiki/slot` / `@geewiki/db-sqlite` / `@geewiki/http` 一样：
 * 把提供者**前移为独立插件**并排在管理器之前 —— 它的 `apply` 先结算，服务随之进入
 * 可见状态，之后管理器 boot 出来的插件都能拿到。
 *
 * ## 与管理器的分工
 * 本插件只**持有并暴露**注册表（`provide` + 卸载时 `unprovide`）；
 * 生命周期语义（激活时按 manifest 登记声明、卸载时按 owner 回收求解器）仍由管理器负责 ——
 * 它才是"卸载统一出口"的持有者。注册表实例经 `ctx.get('capability-service')` 取用，
 * 因此**全进程只有一份**，不存在两处各记一份的问题。
 */
import type { Context } from 'cordis'
import { CapabilityRegistry } from './capabilities.js'

/** 本插件声明的服务名（`ctx.get('capability-service')` 用它查找） */
export const CAPABILITY_SERVICE_NAME = 'capability-service'

export interface CapabilityPluginConfig {
  /** 可选：注入一个既有注册表（测试用；缺省新建） */
  registry?: CapabilityRegistry
}

/**
 * 能力服务插件。**必须在管理器之前注册**（见文件头说明）。
 *
 * 导出形态与仓库其它插件一致：`{ name, apply }`，`apply` 返回 disposer。
 */
export const capabilityPlugin = {
  name: '@geewiki/capability',
  apply(ctx: Context, config: CapabilityPluginConfig = {}) {
    const registry = config.registry ?? new CapabilityRegistry()
    const unprovide = ctx.provide(CAPABILITY_SERVICE_NAME, registry)
    return () => {
      // 服务先撤销、再清空注册表：撤销前若有调用方在途读 snapshot()，读到的是最后一次
      // 已知状态，而不是"所有插件能力都没了"的假象。
      unprovide()
      registry.releaseAll()
    }
  },
}
