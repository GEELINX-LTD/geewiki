/**
 * 插槽服务作为**独立 cordis 插件**提供。
 *
 * ## 为什么不能由管理器在自己的 `apply` 里 provide（实测踩过）
 * 最初的写法是"管理器在 `apply` 开头 `ctx.provide('slot', …)`，然后 `boot()` 激活插件"，
 * 理由是"这样插件激活时就能拿到 slot 服务"。**这个推理是错的**，实测证据：
 * 外部插件的 `apply` 里 `ctx.get('slot')` 返回 **undefined**，并因此**静默跳过**了它自己的
 * 运行期贡献（夹具里 `if (!slot) return`）——而服务端的插槽裁决里查不到任何痕迹，
 * 与"这个插件本来就没贡献"完全没法区分。
 *
 * 机制：**在一个插件 `apply` 尚未结算时 `provide` 的服务，对它在此期间创建的子插件不可见。**
 * 而 `boot()` 正是在管理器的 `apply` 内部激活各插件的，于是"管理器 provide + 自己 boot"
 * 这个组合天然不成立——子插件看到的永远是 provide 之前的视图。
 *
 * 正确的做法是把提供者**前移为独立的插件**并排在管理器之前：它的 `apply` 先结算，
 * 服务随之进入可见状态，之后管理器 boot 出来的插件（以及管理器自己）都能拿到。
 * 这与 `@geewiki/db-sqlite`、`@geewiki/http` 的位置关系是同一种——它们是兄弟插件，
 * 后来的插件能看到先结算者提供的服务（plugin-wiki 的 `ctx.get('db')` 正是这么工作的）。
 *
 * ## 与管理器的分工
 * 本插件只**持有并暴露**注册表（`provide` + 卸载时 `unprovide`）；
 * 生命周期语义（激活时按 manifest 登记、卸载时按 owner 回收）仍由管理器负责，
 * 因为管理器才是"卸载统一出口"的持有者。注册表实例经 `ctx.get('slot')` 取用，
 * 因此**全进程只有一份**，不存在两处各记一份的问题。
 */
import type { Context } from 'cordis'
import { SlotRegistry } from './slots.js'

/** 本插件声明的服务名（`ctx.get('slot')` 用它查找） */
export const SLOT_SERVICE_NAME = 'slot'

export interface SlotPluginConfig {
  /** 可选：注入一个既有注册表（测试用；缺省新建） */
  registry?: SlotRegistry
}

/**
 * 插槽服务插件。**必须在管理器之前注册**（见文件头说明）。
 *
 * 导出形态与仓库其它插件一致：`{ name, apply }`，`apply` 返回 disposer。
 */
export const slotPlugin = {
  name: '@geewiki/slot',
  apply(ctx: Context, config: SlotPluginConfig = {}) {
    const registry = config.registry ?? new SlotRegistry()
    const unprovide = ctx.provide(SLOT_SERVICE_NAME, registry)
    return () => {
      // 服务先撤销、再清空注册表：撤销前若有插件在途读 list()，读到的是最后一次已知状态
      // 而不是"空表"——顺序反了会短暂呈现"所有插槽都没人贡献"的假象。
      unprovide()
      registry.releaseAll()
    }
  },
}
