/**
 * 插件页面路由的**声明裁决**（F2）。
 *
 * 分工与 `slots.ts` 完全同构：
 * - {@link collectRouteDecls} 是**提取**：从已注册插件清单里把 `geewiki.routes` 摊平；
 * - {@link resolveRouteDecls} 是**纯函数**：只依赖"声明列表 + 激活顺序"，可脱离 IO 单测。
 *
 * ## 为什么路由需要"裁决"而不是简单合并
 * 路由 id 是 hash 的**首段**，落在与内置页面同一个命名空间里。若允许两个插件声明同一个 id，
 * "谁生效"就成了必须**确定且可见**的问题——静默地让后者顶替前者，症状是"我启用的插件页面
 * 变成了另一个插件的"，且没有任何提示。故这里的规则与插槽 single 裁决**同向**：
 * 激活顺序最早者胜出，其余进 `conflicts` 并被明确抑制（不是静默丢弃）。
 */

import {
  PLUGIN_ROUTE_ID,
  RESERVED_ROUTE_IDS,
  type PluginRouteDecl,
} from '@geewiki/core'

/** 一条归属明确的声明 */
export interface OwnedRouteDecl {
  readonly owner: string
  readonly route: PluginRouteDecl
}

/** 裁决后的路由（生效集合） */
export interface ResolvedRoute extends OwnedRouteDecl {}

/** 路由 id 被多个插件声明时的冲突诊断 */
export interface RouteConflict {
  readonly id: string
  readonly winner: string
  readonly suppressed: readonly string[]
}

/**
 * 从插件清单里摊平出全部路由声明。
 *
 * 只做提取与**语法校验**（非法 id 告警后丢弃）；跨插件的冲突裁决在
 * {@link resolveRouteDecls} 里做——那是纯函数，测试不需要造注册表。
 */
export function collectRouteDecls(
  registry: readonly { name: string; manifest: { geewiki: { routes?: PluginRouteDecl[] } } }[],
): OwnedRouteDecl[] {
  const out: OwnedRouteDecl[] = []
  for (const entry of registry) {
    const routes = entry.manifest.geewiki.routes
    if (routes === undefined) continue
    if (!Array.isArray(routes)) {
      console.warn(`[manager:routes] 插件 ${entry.name} 的 geewiki.routes 不是数组，已忽略`)
      continue
    }
    for (const route of routes) {
      if (typeof route !== 'object' || route === null || typeof route.id !== 'string') {
        console.warn(`[manager:routes] 插件 ${entry.name} 声明了无 id 的路由，已忽略`)
        continue
      }
      if (!PLUGIN_ROUTE_ID.test(route.id)) {
        console.warn(
          `[manager:routes] 插件 ${entry.name} 的路由 id ${JSON.stringify(route.id)} 非法：` +
            '须为小写 kebab 且不含 `/`（id 是 hash 首段，子路径请用 sub 自己解析）',
        )
        continue
      }
      out.push({ owner: entry.name, route })
    }
  }
  return out
}

/**
 * 纯函数：把"谁声明了哪些路由 id"裁决成"每个 id 谁生效"。
 *
 * 规则（与 `resolveSlots` 的 single 裁决同向）：
 * 1. **宿主保留 id 直接拒绝**（`RESERVED_ROUTE_IDS`）——不是"先到先得"而是"根本不给"：
 *    允许顶替就等于允许一个插件用 `wiki` 覆盖知识库首页，用户会以为自己在看自己的 wiki。
 * 2. 同一 id 被多方声明 ⇒ **激活顺序最早者胜出**，其余进 `conflicts`。
 * 3. 同一 owner 内部重复声明同一个 id ⇒ 只保留第一条（后一条告警）。
 *
 * 返回值里的 `routes` 按 id 字典序，保证输出稳定、与注册顺序无关。
 */
export function resolveRouteDecls(
  decls: readonly OwnedRouteDecl[],
  activationOrder: readonly string[],
): { routes: ResolvedRoute[]; conflicts: RouteConflict[] } {
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

  const reserved = new Set<string>(RESERVED_ROUTE_IDS)
  const byId = new Map<string, OwnedRouteDecl[]>()
  const seenOwnerId = new Set<string>()

  for (const decl of decls) {
    const { id } = decl.route
    if (reserved.has(id)) {
      console.warn(
        `[manager:routes] 插件 ${decl.owner} 试图声明宿主保留的路由 id ${JSON.stringify(id)}，已拒绝`,
      )
      continue
    }
    // 同一 owner 内部重复：只留第一条（`new Set` 的键是 owner+id）
    const ownerKey = `${decl.owner}\u0000${id}`
    if (seenOwnerId.has(ownerKey)) {
      console.warn(`[manager:routes] 插件 ${decl.owner} 重复声明了路由 ${JSON.stringify(id)}，已忽略后一条`)
      continue
    }
    seenOwnerId.add(ownerKey)
    const list = byId.get(id)
    if (list) list.push(decl)
    else byId.set(id, [decl])
  }

  const routes: ResolvedRoute[] = []
  const conflicts: RouteConflict[] = []
  for (const [id, list] of [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => orderOf(a.owner, b.owner))
    const winner = sorted[0] as OwnedRouteDecl
    routes.push(winner)
    if (sorted.length > 1) {
      conflicts.push({
        id,
        winner: winner.owner,
        suppressed: sorted.slice(1).map((d) => d.owner),
      })
    }
  }
  return { routes, conflicts }
}

/** 从裁决结果派生"每个 owner 生效的路由声明"（供入口表按插件写 `routes` 字段） */
export function effectiveRoutesByOwner(
  routes: readonly ResolvedRoute[],
): Map<string, PluginRouteDecl[]> {
  const byOwner = new Map<string, PluginRouteDecl[]>()
  for (const { owner, route } of routes) {
    const list = byOwner.get(owner)
    if (list) list.push(route)
    else byOwner.set(owner, [route])
  }
  return byOwner
}
