/**
 * 插件依赖图与约束系统的纯函数实现（与 IO 解耦，便于单元测试）。
 *
 * 依赖语义（与 docs/architecture.md 5.2/5.4 对齐）：
 * - manifest.geewiki.requires 列表项既可按"插件名"匹配，也可按"服务标识
 *   （provides）"匹配；管理器统一解析为具体插件。
 * - 激活顺序遵循依赖拓扑（被依赖者先激活）。
 * - 广义冲突组：同组内全局仅允许激活一个插件。
 */
import type { GeeWikiManifest } from '@geewiki/core'

/** 已注册插件（registry 条目：插件模块 + Manifest + 迁移目录解析器） */
export interface RegisteredPlugin {
  name: string
  manifest: GeeWikiManifest
  /** cordis 插件模块（对象形态 { name, apply }） */
  module: { name: string; apply: (ctx: any, config?: any) => unknown } // eslint-disable-line @typescript-eslint/no-explicit-any -- cordis 插件形态多样，registry 统一收纳
  /** 迁移脚本目录绝对路径（激活前由迁移控制器执行；缺省则插件自管） */
  migrationsDir?: string
}

/** 把 requires 列表项解析为具体插件：先按插件名、再按 provides 服务标识 */
export function resolveDependency(registry: readonly RegisteredPlugin[], dep: string): RegisteredPlugin | undefined {
  return registry.find((p) => p.name === dep) ?? registry.find((p) => p.manifest.geewiki.provides === dep)
}

/** 插件直接依赖的插件名列表（经 requires 解析） */
export function directDependencies(registry: readonly RegisteredPlugin[], name: string): string[] {
  const entry = registry.find((p) => p.name === name)
  if (!entry) return []
  return (entry.manifest.geewiki.requires ?? [])
    .map((dep) => resolveDependency(registry, dep)?.name)
    .filter((n): n is string => !!n)
}

/**
 * 按依赖拓扑排序（被依赖者在前）。
 * 未启用/未注册的名字忽略；检测到循环依赖时抛错并给出环路径。
 */
export function topologicalOrder(registry: readonly RegisteredPlugin[], enabled: readonly string[]): string[] {
  const present = new Set(enabled.filter((n) => registry.some((p) => p.name === n)))
  const visited = new Map<string, number>() // 0=visiting, 1=done
  const order: string[] = []
  const stack: string[] = []

  const visit = (name: string): void => {
    const mark = visited.get(name)
    if (mark === 1) return
    if (mark === 0) {
      throw new Error(`依赖环检测: ${[...stack, name].join(' → ')}`)
    }
    visited.set(name, 0)
    stack.push(name)
    for (const dep of directDependencies(registry, name)) {
      if (present.has(dep)) visit(dep)
    }
    stack.pop()
    visited.set(name, 1)
    order.push(name)
  }

  for (const name of [...present].sort()) visit(name)
  return order
}

/**
 * 收集依赖 `name` 的全部活动插件（反向依赖，供卸载拦截）。
 * activeNames 为当前活动插件集合。
 */
export function collectDependents(
  registry: readonly RegisteredPlugin[],
  activeNames: ReadonlySet<string>,
  name: string,
): string[] {
  const dependents: string[] = []
  for (const other of activeNames) {
    if (other === name) continue
    if (directDependencies(registry, other).includes(name)) dependents.push(other)
  }
  return dependents.sort()
}

/**
 * 热授权链检查：会话层激活（热加载）插件 X 时，X 及其"需要随热加载的
 * 未激活依赖"都必须 supportsHotReload: true。
 * @param registry 注册表
 * @param activeNames 已激活插件（其中的依赖无需热加载，不参与检查）
 * @param name 待热加载插件名
 * @returns 违规的热加载路径；为空数组则通过
 */
export function checkHotChain(
  registry: readonly RegisteredPlugin[],
  activeNames: ReadonlySet<string>,
  name: string,
): string[] {
  const violations: string[] = []
  const seen = new Set<string>()
  const walk = (current: string, path: string[]): void => {
    if (seen.has(current)) return
    seen.add(current)
    const entry = registry.find((p) => p.name === current)
    const hot = entry?.manifest.geewiki.runtime?.supportsHotReload === true
    const nextPath = [...path, current]
    if (!hot) {
      violations.push(nextPath.join(' → '))
      return // 冷节点之下无需继续展开（已违规）
    }
    for (const dep of directDependencies(registry, current)) {
      if (!activeNames.has(dep)) walk(dep, nextPath)
    }
  }
  walk(name, [])
  return violations
}

/** 冲突组检查：`name` 所在组内是否已有其他活动插件；返回冲突方插件名（无则 undefined） */
export function findConflict(
  registry: readonly RegisteredPlugin[],
  activeNames: ReadonlySet<string>,
  name: string,
): string | undefined {
  const entry = registry.find((p) => p.name === name)
  const group = entry?.manifest.geewiki.conflictGroup
  if (!group) return undefined
  for (const other of activeNames) {
    if (other === name) continue
    const otherEntry = registry.find((p) => p.name === other)
    if (otherEntry?.manifest.geewiki.conflictGroup === group) return other
  }
  return undefined
}
