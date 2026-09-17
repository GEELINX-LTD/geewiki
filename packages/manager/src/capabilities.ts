/**
 * 插件能力的**声明裁决**（纯函数）与**运行期注册表**（★ F9）。
 *
 * 分工与 `routes.ts` / `slots.ts` 完全同构：
 * - {@link collectCapabilityDecls} 是**提取**：从已注册插件清单里摊平 `geewiki.capabilities`；
 * - {@link resolveCapabilityDecls} 是**纯函数**：只依赖"声明列表 + 激活顺序"，可脱离 IO 单测；
 * - {@link CapabilityRegistry} 是**运行期**：承载求解器，并合成某主体的能力快照。
 *
 * ## 为什么能力名也要"裁决"
 * 能力名会出现在**插件的导航/路由声明**里（`requires: 'review/approve'`）。若两个插件
 * 各自声明同一个名字，那两处入口就都挂到了同一个布尔值上 —— "我启用的插件入口跟着别人的
 * 权限走"。与路由 id 一样，这必须是**确定且可见**的，故沿用同一条规则：
 * **激活顺序最早者胜出**，其余进 `conflicts` 并被明确抑制（不是静默丢弃）。
 */

import {
  builtinCapabilitiesOf,
  BUILTIN_CAPABILITIES,
  isBuiltinCapability,
  isPluginCapability,
  type CapabilityDecl,
  type CapabilityName,
  type CapabilityResolver,
  type CapabilityService,
  type CapabilitySet,
  type Principal,
} from '@geewiki/core'

/** 一条归属明确的能力声明 */
export interface OwnedCapabilityDecl {
  readonly owner: string
  readonly decl: CapabilityDecl
}

/** 裁决后的能力（生效集合） */
export interface ResolvedCapability extends OwnedCapabilityDecl {}

/** 能力名被多个插件声明时的冲突诊断 */
export interface CapabilityConflict {
  readonly name: string
  readonly winner: string
  readonly suppressed: readonly string[]
}

/** 注册表能读到的插件形状（只取需要的字段，测试无需造完整清单） */
export interface CapabilityDeclSource {
  readonly name: string
  readonly manifest: { readonly geewiki: { readonly capabilities?: CapabilityDecl[] } }
}

/**
 * 从插件清单里摊平出全部能力声明。
 *
 * 只做提取与**语法校验**（非法名告警后丢弃）；跨插件冲突裁决在
 * {@link resolveCapabilityDecls} 里做 —— 那是纯函数，测试不需要造注册表。
 *
 * **内置名被拒绝**：插件声明 `administer` 会让"内置角色的语义"与"某个插件的求解器"
 * 争夺同一个键 —— 这属于命名空间越界，不是冲突（没有赢家，直接不给）。
 */
export function collectCapabilityDecls(registry: readonly CapabilityDeclSource[]): OwnedCapabilityDecl[] {
  const out: OwnedCapabilityDecl[] = []
  for (const entry of registry) {
    const decls = entry.manifest.geewiki.capabilities
    if (decls === undefined) continue
    if (!Array.isArray(decls)) {
      console.warn(`[manager:capabilities] 插件 ${entry.name} 的 geewiki.capabilities 不是数组，已忽略`)
      continue
    }
    for (const decl of decls) {
      if (typeof decl !== 'object' || decl === null || typeof decl.name !== 'string') {
        console.warn(`[manager:capabilities] 插件 ${entry.name} 声明了无 name 的能力，已忽略`)
        continue
      }
      if (isBuiltinCapability(decl.name)) {
        console.warn(
          `[manager:capabilities] 插件 ${entry.name} 试图声明内置能力 ${JSON.stringify(decl.name)}，已拒绝：` +
            '内置能力由组织角色推导，插件只能声明自己命名空间（含 `/`）下的能力',
        )
        continue
      }
      if (!isPluginCapability(decl.name)) {
        console.warn(
          `[manager:capabilities] 插件 ${entry.name} 的能力名 ${JSON.stringify(decl.name)} 非法：` +
            '须为小写 kebab 且**至少含一个 `/`**（与内置名切开命名空间）',
        )
        continue
      }
      out.push({ owner: entry.name, decl })
    }
  }
  return out
}

/**
 * 纯函数：把"谁声明了哪些能力名"裁决成"每个名字谁生效"。
 *
 * 规则（与 `resolveRouteDecls` 同向）：
 * 1. 同一名字被多方声明 ⇒ **激活顺序最早者胜出**，其余进 `conflicts`。
 * 2. 同一 owner 内部重复声明同名 ⇒ 只保留第一条（后一条告警）。
 *
 * 返回值里的 `capabilities` 按名字字典序，保证输出稳定、与注册顺序无关。
 */
export function resolveCapabilityDecls(
  decls: readonly OwnedCapabilityDecl[],
  activationOrder: readonly string[],
): { capabilities: ResolvedCapability[]; conflicts: CapabilityConflict[] } {
  const rank = new Map<string, number>()
  activationOrder.forEach((name, i) => rank.set(name, i))
  const orderOf = (a: string, b: string): number => {
    const ia = rank.get(a)
    const ib = rank.get(b)
    if (ia !== undefined && ib !== undefined) return ia - ib
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return a.localeCompare(b)
  }

  const byName = new Map<string, OwnedCapabilityDecl[]>()
  const seenOwnerName = new Set<string>()
  for (const decl of decls) {
    const { name } = decl.decl
    const ownerKey = `${decl.owner}\u0000${name}`
    if (seenOwnerName.has(ownerKey)) {
      console.warn(`[manager:capabilities] 插件 ${decl.owner} 重复声明了能力 ${JSON.stringify(name)}，已忽略后一条`)
      continue
    }
    seenOwnerName.add(ownerKey)
    const list = byName.get(name)
    if (list) list.push(decl)
    else byName.set(name, [decl])
  }

  const capabilities: ResolvedCapability[] = []
  const conflicts: CapabilityConflict[] = []
  for (const [name, list] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => orderOf(a.owner, b.owner))
    const winner = sorted[0] as OwnedCapabilityDecl
    capabilities.push(winner)
    if (sorted.length > 1) {
      conflicts.push({ name, winner: winner.owner, suppressed: sorted.slice(1).map((d) => d.owner) })
    }
  }
  return { capabilities, conflicts }
}

/** 一条已生效的求解器 */
interface RegisteredResolver {
  readonly owner: string
  readonly resolve: CapabilityResolver
  readonly meta?: { label?: string; description?: string }
}

/**
 * 运行期能力注册表 —— `CapabilityService` 的实现（manager 持有并 `ctx.provide`）。
 *
 * ## 两条不可静默失守的性质
 *
 * 1. **失败关闭**：求解器抛错时该能力判 `false` 并告警，**绝不放行**。求解器是插件代码，
 *    把它写错不应该等于"这个能力发给所有人"。这与 server 对前置钩子裁决的处理同向
 *    （`verdictDenial`：形态不合法一律按拒绝）。反过来，若这里 `catch` 后判 `true`，
 *    一次插件异常就变成一次越权，且没有任何症状。
 * 2. **内置名不可被顶替**（`provide()` 拒绝 `editContent` / `administer` / `manageVisibility`）：
 *    否则插件可以用一个恒 `true` 的求解器重定义"管理员"，而前端会照常显示管理入口。
 *    内置能力只有一个来源 —— {@link builtinCapabilitiesOf} 的角色推导。
 */
export class CapabilityRegistry implements CapabilityService {
  private readonly resolvers = new Map<CapabilityName, RegisteredResolver>()

  /**
   * 注册一个插件能力名及其求解器。
   *
   * **同名先到先得**（与插槽/路由的裁决同向）：后来者被告警并忽略，其撤销函数是空操作。
   * 这样"谁生效"是确定且可见的，而不是由激活顺序悄悄决定。
   */
  provide(
    owner: string,
    name: CapabilityName,
    resolve: CapabilityResolver,
    meta?: { label?: string; description?: string },
  ): () => void {
    if (isBuiltinCapability(name)) {
      console.warn(
        `[manager:capabilities] 插件 ${owner} 试图注册内置能力 ${JSON.stringify(name)}，已拒绝：` +
          '内置能力由组织角色推导，插件不得顶替',
      )
      return () => {}
    }
    if (!isPluginCapability(name)) {
      console.warn(
        `[manager:capabilities] 插件 ${owner} 注册的能力名 ${JSON.stringify(name)} 非法，已拒绝：` +
          '须为小写 kebab 且至少含一个 `/`（与内置名切开命名空间）',
      )
      return () => {}
    }
    const existing = this.resolvers.get(name)
    if (existing) {
      console.warn(
        `[manager:capabilities] 能力 ${JSON.stringify(name)} 已被插件 ${existing.owner} 注册，` +
          `忽略 ${owner} 的重复注册（先注册者生效）`,
      )
      return () => {}
    }
    this.resolvers.set(name, { owner, resolve, meta })
    return () => {
      // 只有"当前这条仍是自己的"才撤销：避免先到者被卸载后后来者接管造成顺序错乱
      if (this.resolvers.get(name) === undefined) return
      if (this.resolvers.get(name)?.owner !== owner) return
      this.resolvers.delete(name)
    }
  }

  /** 卸载一个 owner 的全部求解器 */
  release(owner: string): void {
    for (const [name, r] of [...this.resolvers.entries()]) {
      if (r.owner === owner) this.resolvers.delete(name)
    }
  }

  /** 撤销**全部**求解器。服务卸载时调用（对称于 `SlotRegistry.releaseAll`）。 */
  releaseAll(): void {
    this.resolvers.clear()
  }

  /** 已注册求解器的能力名（诊断用） */
  registered(): readonly CapabilityName[] {
    return [...this.resolvers.keys()].sort((a, b) => a.localeCompare(b))
  }

  /** 已知能力声明：内置的三个在前（固定顺序），其后是插件声明的（按名字字典序）。 */
  declarations(): readonly { owner: string; name: CapabilityName; label?: string; description?: string }[] {
    const builtin = BUILTIN_CAPABILITIES.map((name) => ({
      owner: '<builtin>',
      name: name as CapabilityName,
      label: name,
      description: '由组织角色推导的内置能力',
    }))
    const plugin = [...this.resolvers.entries()]
      .map(([name, r]) => ({ owner: r.owner, name, label: r.meta?.label, description: r.meta?.description }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return [...builtin, ...plugin]
  }

  /**
   * 某主体的能力快照 = 内置（角色推导） ∪ 全部已注册求解器。
   *
   * **求解器逐个 try/catch，失败即该能力为 `false`**（失败关闭，见类文档）。
   * 一个求解器抛错不会影响其它能力，也不会让快照整体失败 —— 否则"某个插件的能力算不出来"
   * 会升级成"所有人都拿不到能力表"，前端于是藏起全部入口。
   */
  snapshot(principal: Principal | undefined): CapabilitySet {
    /*
     * `undefined` = 完全没有主体信息（认证中间件还没跑完的那条路径）。
     *
     * ★ **刻意不调用任何求解器**：`Principal` 的设计原则是"没有空主体，只有
     * `kind:'anonymous'`"（见 core 的 `Principal` 文档）。把 `undefined` 透传给插件求解器，
     * 等于要求每个作者都处理一个**设计上不存在**的输入 —— 而作者漏处理时的默认分支
     * 往往是"不是已知用户就返回 true"，那是一次越权。这里直接判否，把边界收在宿主侧。
     *
     * 注意这**不是**"匿名判否"：真正的匿名主体是一个合法的 `Principal`
     * （`kind:'anonymous'`），会正常走下面的求解器路径，由插件自己决定要不要给它能力。
     */
    if (principal === undefined) {
      const out: Record<string, boolean> = { ...builtinCapabilitiesOf(undefined) }
      for (const name of this.resolvers.keys()) out[name] = false
      return out
    }
    const out: Record<string, boolean> = { ...builtinCapabilitiesOf(principal) }
    for (const [name, r] of this.resolvers) {
      try {
        out[name] = r.resolve(principal) === true
      } catch (err) {
        console.warn(`[manager:capabilities] 能力 ${JSON.stringify(name)} 的求解器（${r.owner}）抛错，判为不具备:`, err)
        out[name] = false
      }
    }
    return out
  }
}

/**
 * 纯函数：**声明了却没有求解器**的能力名 —— 一个真实且完全静默的失效形态。
 *
 * 声明只说"我引入了这个名字"，值要靠 `provide()`。漏了后者时该能力对所有主体恒为 `false`，
 * 依赖它的导航项/路由**永远不出现、且没有任何报错**：插件作者会去查"注册为什么没生效"，
 * 而真正的问题是"能力算不出来"。这里把它变成一条可在 `GET /api/plugins/capabilities` 里
 * 看见、并在激活后被告警的清单。
 *
 * @param declared 已生效的声明（`resolveCapabilityDecls` 的产物）
 * @param registered 已注册求解器的能力名（`CapabilityRegistry.registered()`）
 */
export function unresolvedCapabilities(
  declared: readonly CapabilityName[],
  registered: readonly CapabilityName[],
): string[] {
  const have = new Set(registered)
  return declared.filter((name) => !have.has(name)).sort()
}
