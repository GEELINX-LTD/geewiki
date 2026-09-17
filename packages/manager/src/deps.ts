/**
 * 插件依赖图与约束系统的纯函数实现（与 IO 解耦，便于单元测试）。
 *
 * 依赖语义（与 docs/architecture.md 5.2/5.4 对齐）：
 * - manifest.geewiki.requires 列表项既可按"插件名"匹配，也可按"服务标识
 *   （provides）"匹配；管理器统一解析为具体插件。
 * - 激活顺序遵循依赖拓扑（被依赖者先激活）。
 * - 广义冲突组：同组内全局仅允许激活一个插件。
 */
import type { GeeWikiManifest, PluginHealth } from '@geewiki/core'

/** 已注册插件（registry 条目：插件模块 + Manifest + 迁移目录解析器） */
export interface RegisteredPlugin {
  name: string
  manifest: GeeWikiManifest
  /** cordis 插件模块（对象形态 { name, apply }；可选 Config schema 由 cordis 自动校验） */
  module: {
    name: string
    apply: (ctx: any, config?: any) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any -- cordis 插件形态多样，registry 统一收纳
    Config?: unknown
    /**
     * ★ F12：可选的**健康探针**。
     *
     * 为什么挂在模块上、而不是再开一个服务：插件模块对象本来就被管理器持有
     * （`entry.module`），而健康检查是**拉取式**的、由 REST 请求触发 ——
     * 于是它天然不需要任何"注册期可见性"，也就绕开了 `slot-plugin.ts` 文件头记录的
     * 那个陷阱（在插件 apply 期 `ctx.get` 拿不到尚未结算的服务）。
     * 再开一个 `health-service` 只会**为了对称**而引入一处必然踩坑的注册时序。
     *
     * 契约与超时语义见 `pluginHealth()`：探针抛错/超时由宿主判定，与插件自报的
     * `ok:false` 严格区分（前者是"没问到"，后者是"问到且它说坏了"）。
     */
    health?: () => PluginHealth | Promise<PluginHealth>
  }
  /**
   * 迁移脚本目录：**按方言**解析后的绝对路径表（激活前由迁移控制器执行；缺省则插件自管）。
   *
   * 键为方言名（`'sqlite'` / `'postgres'`）或通用回退键 `'default'`。
   * 管理器激活插件时按当前适配器的 `dialect` 取用：先精确匹配方言键，再回退 `'default'`，
   * 两者都没有 ⇒ 视为"该插件在当前数据库下没有迁移"，跳过并记警告（不阻断激活）。
   */
  migrationsDirs?: Readonly<Record<string, string>>
  /** 来源：内置（组合根静态登记）或外部（<仓库根>/plugins/ 目录发现） */
  source?: 'builtin' | 'external'
  /** 外部插件的目录绝对路径（内置插件无此字段） */
  dir?: string
}

/**
 * 把 requires 列表项解析为具体插件：先按插件名、再按 provides 服务标识。
 *
 * ★ 同一声明可能被**多个插件**满足（最典型的是 `database-provider`：`@geewiki/db-sqlite`
 * 与 `@geewiki/postgres` 都提供它，而它们互斥、同时只会启用一个）。此时"第一个注册的"
 * 并不是正确答案 —— 它可能是**没启用的那一个**。
 *
 * 这个坑真实发生过（P2 在 PostgreSQL 上验收时炸出来）：PG 部署下 `directDependencies`
 * 把 `database-provider` 解析成排在 registry 前面的 `@geewiki/db-sqlite`，而它并未启用
 * ⇒ `topologicalOrder` 里 `present.has(dep)` 为假 ⇒ **auth 与 postgres 之间根本没有排序
 * 约束**，两者退化成按字母序激活。于是 `@geewiki/auth`（a 在 p 前）先于
 * `@geewiki/postgres` 激活，`ctx.get('db')` 拿到 undefined，插件激活失败并只留下一句
 * 含糊的"数据库服务不可用"；而 `@geewiki/wiki` 因为 w 排在 p 之后侥幸躲过。
 * 这类"靠字母序碰巧正确"的缺陷极难定位，所以修在根上：
 * **优先取真正在（启用/激活）集合里的那个 provider**。
 *
 * @param prefer 可选的"候选集合"（已启用或已激活的插件名）。命中时优先返回集合内的匹配项；
 *               集合内无匹配则退回原来的"第一个匹配"，使单 provider 场景的行为逐字不变。
 */
export function resolveDependency(
  registry: readonly RegisteredPlugin[],
  dep: string,
  prefer?: ReadonlySet<string>,
): RegisteredPlugin | undefined {
  const byName = registry.find((p) => p.name === dep)
  if (byName) return byName
  const providers = registry.filter((p) => p.manifest.geewiki.provides === dep)
  if (prefer) {
    const enabled = providers.find((p) => prefer.has(p.name))
    if (enabled) return enabled
  }
  return providers[0]
}

/** 插件直接依赖的插件名列表（经 requires 解析） */
export function directDependencies(
  registry: readonly RegisteredPlugin[],
  name: string,
  prefer?: ReadonlySet<string>,
): string[] {
  const entry = registry.find((p) => p.name === name)
  if (!entry) return []
  return (entry.manifest.geewiki.requires ?? [])
    .map((dep) => resolveDependency(registry, dep, prefer)?.name)
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
    for (const dep of directDependencies(registry, name, present)) {
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
    if (directDependencies(registry, other, activeNames).includes(name)) dependents.push(other)
  }
  return dependents.sort()
}

/**
 * 收集依赖闭包：返回 `names` 的全部（传递）依赖方插件名，不含 `names` 自身。
 *
 * 供冲突组替换（replace）计算"必须连带卸载再恢复"的插件集合：要卸载旧插件，
 * 就得先卸掉它的全部依赖方（无论层级多深）。遍历覆盖**整个注册表**（不限于活动
 * 插件）——中间节点即便当前未激活也继续向上传播，取的是安全超集；调用方按当前
 * 活动集合取交集即可。BFS + visited 保证环安全（每个节点最多入队一次）。
 */
export function collectDependentsClosure(
  registry: readonly RegisteredPlugin[],
  names: readonly string[],
): string[] {
  const seen = new Set<string>(names)
  const out: string[] = []
  const queue: string[] = [...seen]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const other of registry) {
      if (seen.has(other.name)) continue
      if (directDependencies(registry, other.name).includes(current)) {
        seen.add(other.name)
        out.push(other.name)
        queue.push(other.name)
      }
    }
  }
  return out.sort()
}

/**
 * 冲突组替换的"提供者覆盖"校验（纯函数）：找出 `names` 中**原本依赖被顶替者 `replaced`、
 * 但目标 `target` 无法承接该依赖边**的条目。
 *
 * 判定：对某个插件的每个 `requires` token `t`，若 `resolveDependency(registry, t)?.name === replaced`
 * （即这条边当前指向被顶替者），则要求目标能承接该 token —— 按插件名命中（`target === t`）
 * 或按服务标识命中（目标的 `provides === t`）；都不满足即违规。
 *
 * **刻意取舍（宁可拒绝，也不假报成功）**：依赖方**按具体插件名**依赖被顶替者时必然违规——
 * 按名的边无法由新插件承接，正解是依赖方改为依赖服务标识（provides token，本仓库推荐用法）。
 * 否则替换会返回 200，而依赖方依赖的服务已无人提供。
 */
export function findUncoveredRequires(
  registry: readonly RegisteredPlugin[],
  replaced: string,
  target: string,
  names: readonly string[],
): { plugin: string; token: string }[] {
  const targetEntry = registry.find((p) => p.name === target)
  const out: { plugin: string; token: string }[] = []
  for (const name of names) {
    const entry = registry.find((p) => p.name === name)
    if (!entry) continue
    for (const token of entry.manifest.geewiki.requires ?? []) {
      if (resolveDependency(registry, token)?.name !== replaced) continue // 这条边不指向被顶替者
      if (target === token) continue // 目标按插件名承接
      if (targetEntry?.manifest.geewiki.provides === token) continue // 目标按服务标识承接
      out.push({ plugin: name, token })
    }
  }
  return out
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
