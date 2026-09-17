/**
 * 插槽贡献注册表与**基数裁决**（`ctx.get('slot')` 的实现体）。
 *
 * 分工（与 `plugin-ui.ts` 同一风格）：
 * - {@link SlotRegistry} 是**可变外壳**：登记 / 注销 / 查询，挂插件生命周期；
 * - {@link resolveSlots} 是**纯函数**：只依赖"贡献列表 + 激活顺序"，可脱离 IO 单测
 *   （基数裁决与冲突判定最容易写错，必须能单测）。
 *
 * ## 两个常被混为一谈的「放在哪」，各有各的理由（★ 优化点 2：本段曾自相矛盾）
 * 本文件只回答**注册表实现放哪**：放 manager，因为插槽贡献的归属与回收必须挂在
 * **插件生命周期**上（激活时登记、卸载时注销），而 manager 正是生命周期与
 * `UnloadPlugin` 统一出口的持有者。
 *
 * 它**不**回答**服务提供者放哪**——那一层是 `slot-plugin.ts`（`@geewiki/slot`），
 * 而且**必须**是排在管理器之前的独立插件。这两件事不能合并推理：最初正是把
 * "注册表放 manager" 误推广成 "`provide('slot')` 也写进 manager 的 apply"，结果外部插件
 * `ctx.get('slot')` 拿到 **undefined** 并静默跳过自己的运行期贡献（实测证据与机制见
 * `slot-plugin.ts` 文件头、以及 `packages/server/src/index.ts` 组合根处的注释）。
 *
 * 因此下面这句曾经的反对理由**已被推翻**、不要改回去："另起一个插件反而要……多出一个
 * 谁先谁后的启动顺序问题"。顺序问题**不是**回避独立插件的理由——它是本设计**必须**
 * 正面解决的一个真实约束：正因为"提供者先结算、管理器后 boot"这个顺序是硬要求，
 * 提供者才必须被显式排在管理器之前。
 */

import {
  PLUGIN_UI_ASSET_MAX_DEPTH,
  SLOT_NAMES,
  isBuiltinSlotName,
  isPluginSlotName,
  slotCardinalityOf,
  type SlotContribution,
  type SlotContributionMeta,
  type SlotDeclaration,
  type SlotName,
  type SlotService,
} from '@geewiki/core'

/**
 * 名字是否可接受：**内置插槽** ∪ **插件自定义扩展点**（语法见 core 的 `PLUGIN_SLOT_NAME`）。
 *
 * 注意这里**不是**"任意字符串都行"：自定义插槽名必须含 `/`，于是不含 `/` 又不在白名单里的
 * 名字（`app-headr` 这类笔误）依然被挡下并告警——这是"开放键空间"与"笔误可见"的取舍点。
 */
export function isSlotName(name: unknown): name is SlotName {
  return isBuiltinSlotName(name) || isPluginSlotName(name)
}

/** 已声明的自定义扩展点查表（`resolveSlots` 与注册表共用同一套裁决） */
function declarationIndex(
  declarations: readonly (SlotDeclaration & { readonly slot: string })[],
): Map<string, SlotDeclaration> {
  return new Map(declarations.map((d) => [d.slot, d]))
}

/**
 * 懒加载模块路径是否合法：逐段 `[A-Za-z0-9][A-Za-z0-9._-]*`，段数 ≤ {@link PLUGIN_UI_ASSET_MAX_DEPTH}。
 *
 * 刻意复用静态资源层的规则（`PLUGIN_UI_ASSET_PATH`）而不是新造一套：
 * 该路径最终就是要去 `/plugins-ui/<插件名>/<importPath>` 取文件，
 * 两处规则若不一致，就会出现"这里通过、那里 404"的分裂。
 * 段首必须是字母数字 ⇒ `..`、`.hidden`、空段、绝对路径、尾随斜杠天然非法。
 */
export function isSlotImportPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false
  const segments = path.split('/')
  if (segments.length > PLUGIN_UI_ASSET_MAX_DEPTH) return false
  return segments.every((seg) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seg))
}

/** 一个插槽的裁决结果 */
export interface SlotAssignment {
  readonly slot: SlotName
  readonly cardinality: 'single' | 'multi'
  /** **全部声明者**，按激活顺序（不在激活顺序里的排在最后，按名字典序） */
  readonly owners: readonly string[]
  /** **实际生效**的声明者：`multi` 全部生效；`single` 只取激活顺序里的第一个 */
  readonly effective: readonly string[]
  /** 被抑制的声明者（仅 `single` 且被多方声明时非空），按激活顺序 */
  readonly suppressed: readonly string[]
}

/** 冲突诊断：单占用插槽被多个插件声明（裁决仍确定，但必须**可见**） */
export interface SlotConflict {
  readonly slot: SlotName
  readonly winner: string
  readonly suppressed: readonly string[]
  readonly owners: readonly string[]
}

/**
 * 按激活顺序给 owner 排序：激活过的按激活次序，没激活过的排最后（按名字典序）。
 *
 * 为什么要顺序而不是字典序：`single` 插槽需要**确定性**的胜出者，
 * 而"谁先被启用"对用户是可理解的、也是可复现的（会话清单本身有序）；
 * 字典序虽然更"稳定"，却会让用户觉得"我后启用的那个反而不生效"莫名其妙。
 */
function orderOf(activationOrder: readonly string[]): (a: string, b: string) => number {
  const index = new Map<string, number>()
  activationOrder.forEach((name, i) => index.set(name, i))
  return (a, b) => {
    const ia = index.get(a)
    const ib = index.get(b)
    if (ia !== undefined && ib !== undefined) return ia - ib
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return a.localeCompare(b)
  }
}

/**
 * 纯函数：把"谁声明了哪些插槽"裁决成"每个插槽谁生效"。
 *
 * 裁决规则（`single` 插槽被多方声明时）：
 * **激活顺序里最早的胜出**，其余进 `suppressed` 并被记为冲突。
 *
 * 为什么是"最早"而不是"最新"：最新胜出会让后启用的插件**静默顶掉**已在工作的编辑器，
 * 用户看到的是"我的编辑器突然换了"却没有任何提示；最早胜出则保证"先来的继续工作"，
 * 后来者被明确抑制——**状态可预期，且冲突在诊断里可见**。
 * 真正的解法是让插件作者用 `conflictGroup` 声明互斥（那时第二个根本激活不了，
 * 用户会在启用时就收到明确拒绝，而不是激活后才发现没生效）。
 */
export function resolveSlots(
  contributions: readonly SlotContribution[],
  activationOrder: readonly string[],
  declarations: readonly (SlotDeclaration & { readonly slot: string })[] = [],
): SlotAssignment[] {
  const cmp = orderOf(activationOrder)
  const declared = declarationIndex(declarations)
  const out: SlotAssignment[] = []
  /*
    输出顺序 = 内置插槽（白名单顺序）→ 插件自定义插槽（字典序）。
    为什么自定义插槽用**字典序**而不是"首次贡献顺序"：`resolveSlots` 是纯函数，
    若次序取决于贡献列表的插入序，结果就会随 Map 迭代顺序漂移、也无法稳定单测。
    字典序是确定的，且"自定义插槽排在所有内置之后"让内置名的定位成本不变。
  */
  const ordered: string[] = [...SLOT_NAMES]
  const custom = new Set<string>()
  for (const c of contributions) {
    if (isBuiltinSlotName(c.slot)) continue
    custom.add(c.slot)
  }
  for (const s of [...custom].sort((a, b) => a.localeCompare(b))) ordered.push(s)

  for (const slot of ordered) {
    const owners = contributions
      .filter((c) => c.slot === slot)
      .map((c) => c.owner)
      .sort(cmp)
    if (owners.length === 0) continue
    const cardinality = slotCardinalityOf(slot, declared.get(slot))
    const effective = cardinality === 'single' ? owners.slice(0, 1) : owners
    out.push({
      slot,
      cardinality,
      owners,
      effective,
      suppressed: cardinality === 'single' ? owners.slice(1) : [],
    })
  }
  return out
}

/** 从裁决结果里取出"每个 owner 实际生效的插槽"（供入口表按插件写 `slots` 字段） */
export function effectiveSlotsByOwner(assignments: readonly SlotAssignment[]): Map<string, SlotName[]> {
  const byOwner = new Map<string, SlotName[]>()
  for (const a of assignments) {
    for (const owner of a.effective) {
      const list = byOwner.get(owner)
      if (list) list.push(a.slot)
      else byOwner.set(owner, [a.slot])
    }
  }
  return byOwner
}

/** 从裁决结果里取出冲突诊断（只保留真有多方声明的单占用插槽） */
export function conflictsOf(assignments: readonly SlotAssignment[]): SlotConflict[] {
  return assignments
    .filter((a) => a.suppressed.length > 0)
    .map((a) => ({
      slot: a.slot,
      winner: a.effective[0] as string,
      suppressed: a.suppressed,
      owners: a.owners,
    }))
}

/**
 * 有贡献者、但**无人 `define()` 声明过**的插件自定义扩展点（诊断，A1 新增）。
 *
 * ## 为什么这不是错误，却必须报出来
 * 未声明按 `multi` 处理，功能是正常的。但"没人声明"通常意味着两种事故之一：
 * ① 声明方还没迁到 `define()`——缺基数声明，**本该单占用的扩展点会同时渲染多个贡献者**；
 * ② **命名空间拼错**：`pulgin-a/toolbar` 与 `plugin-a/toolbar` 会各自成为一个扩展点，
 *    两个贡献者永远碰不到一起，而界面上**什么都不会报**（各自渲染进一个空出口）。
 *
 * ②是"开放键空间"顺带引入的新失败模式（闭合白名单时代不可能发生），
 * 所以这条诊断是放宽插槽名**必须**带上的补偿，而不是可选的好看字段。
 */
export function undeclaredSlots(
  assignments: readonly SlotAssignment[],
  declarations: readonly (SlotDeclaration & { readonly slot: string })[],
): string[] {
  const declared = new Set(declarations.map((d) => d.slot))
  return assignments
    .map((a) => a.slot)
    .filter((slot) => !isBuiltinSlotName(slot) && !declared.has(slot))
}

/* ========================= SlotRegistry（可变外壳） ========================= */

/**
 * `SlotService` 的实现。
 *
 * 内部是 `Map<owner, Map<slot, meta>>`——**按 owner 分桶**是刻意的：
 * 卸载时要"注销该插件的全部贡献"，分桶让它是一次 `delete`，
 * 而不是遍历全表挑出属于它的项（后者容易漏、也容易误伤同名子串）。
 * 这与 `HttpRouter.closeStreams(owner)` 的 `Map<owner, Set<res>>` 是同一形状。
 */
export class SlotRegistry implements SlotService {
  private readonly byOwner = new Map<string, Map<SlotName, { via: 'manifest' | 'runtime'; lazy: boolean; importPath?: string }>>()

  /**
   * 插件自定义扩展点的**声明**：slot → { 声明者, 基数 }。
   *
   * 与 `byOwner` **刻意分开存**：声明的生命周期归"开这个扩展点的插件"，
   * 而贡献可以来自任意插件。合成一张表会让"卸载某个贡献者"顺带删掉别人开的扩展点。
   */
  private readonly declared = new Map<string, SlotDeclaration>()

  /**
   * 声明一个插件自定义扩展点（`slot.define()`）。
   *
   * 拒绝三种情况（全部告警但**不抛**，与 `contribute` 同风格）：
   * 内置插槽名（基数由 core 固定）、语法非法（不含 `/` 或非小写 kebab）、已被他人声明。
   * 重复声明时**先声明者保留**——与 `single` 裁决同向：先来的有效，后来者可见地被拒，
   * 而不是静默改掉别人的基数。
   */
  define(owner: string, slot: string, meta?: Omit<SlotDeclaration, 'owner'>): () => void {
    if (isBuiltinSlotName(slot)) {
      console.warn(
        `[manager:slot] ${owner} 试图声明内置插槽 ${JSON.stringify(slot)}：内置插槽的基数由 core 固定，已忽略`,
      )
      return () => {}
    }
    if (!isPluginSlotName(slot)) {
      console.warn(
        `[manager:slot] 忽略非法的自定义插槽名 ${JSON.stringify(slot)}（声明者 ${owner}）：` +
          '必须形如 "命名空间/名字"（小写 kebab，至少含一个 `/`）',
      )
      return () => {}
    }
    if (typeof owner !== 'string' || owner.length === 0) {
      console.warn(`[manager:slot] 忽略空 owner 的插槽声明（slot=${slot}）`)
      return () => {}
    }
    const existing = this.declared.get(slot)
    if (existing && existing.owner !== owner) {
      console.warn(
        `[manager:slot] 扩展点 ${JSON.stringify(slot)} 已由 ${existing.owner} 声明，忽略 ${owner} 的重复声明`,
      )
      return () => {}
    }
    this.declared.set(slot, {
      owner,
      cardinality: meta?.cardinality ?? 'multi',
      ...(meta?.description === undefined ? {} : { description: meta.description }),
    })
    let done = false
    return () => {
      if (done) return
      done = true
      const cur = this.declared.get(slot)
      if (cur && cur.owner === owner) this.declared.delete(slot)
    }
  }

  declarations(): readonly (SlotDeclaration & { readonly slot: string })[] {
    return [...this.declared.entries()]
      .map(([slot, d]) => ({ slot, ...d }))
      .sort((a, b) => a.slot.localeCompare(b.slot))
  }

  /**
   * 登记一条贡献，返回**幂等**的注销函数。
   *
   * 同一 `(owner, slot)` 重复登记视为同一条：后登记的 `lazy`/`importPath` 覆盖先前的，
   * 但 `via` 保留**先登记**的那个（manifest 先于运行期登记，故声明式身份不会被运行期改写）。
   */
  contribute(owner: string, slot: SlotName, meta?: SlotContributionMeta): () => void {
    if (!isSlotName(slot)) {
      // 既不是内置插槽、也不是合法的自定义扩展点名：忽略 + 告警，**不抛**
      // （与前端忽略未知插槽名的既有行为一致）。
      // 这条正是"笔误可见"的落点：`app-headr` 会走到这里，而不是被当成一个新插槽静默接受。
      console.warn(
        `[manager:slot] 忽略未知插槽名 ${JSON.stringify(slot)}（贡献者 ${owner}）：` +
          `内置插槽见 SLOT_NAMES；自定义扩展点须形如 "命名空间/名字"（含 \`/\`）`,
      )
      return () => {}
    }
    if (typeof owner !== 'string' || owner.length === 0) {
      console.warn(`[manager:slot] 忽略空 owner 的插槽贡献（slot=${slot}）`)
      return () => {}
    }
    let importPath: string | undefined
    if (meta?.importPath !== undefined) {
      if (isSlotImportPath(meta.importPath)) {
        importPath = meta.importPath
      } else {
        // 非法路径会让宿主去取一个取不到（或不该取）的文件：降级为"不声明路径"
        // （回退到该插件的 client.entry），而不是让整个贡献作废。
        console.warn(
          `[manager:slot] 忽略非法 importPath ${JSON.stringify(meta.importPath)}（贡献者 ${owner}，slot=${slot}）：已回退到 client.entry`,
        )
      }
    }
    let slots = this.byOwner.get(owner)
    if (!slots) {
      slots = new Map()
      this.byOwner.set(owner, slots)
    }
    const existing = slots.get(slot)
    slots.set(slot, {
      via: existing?.via ?? 'runtime',
      lazy: meta?.lazy ?? existing?.lazy ?? false,
      importPath: importPath ?? existing?.importPath,
    })
    let done = false
    return () => {
      if (done) return
      done = true
      const bucket = this.byOwner.get(owner)
      if (!bucket) return
      bucket.delete(slot)
      if (bucket.size === 0) this.byOwner.delete(owner)
    }
  }

  /** 登记一条 **manifest 声明**的贡献（管理器在激活时调用，故 `via` 为 'manifest'） */
  contributeFromManifest(owner: string, slot: SlotName, meta?: SlotContributionMeta): void {
    if (!isSlotName(slot)) {
      console.warn(`[manager:slot] 插件 ${owner} 的 manifest 声明了未知插槽 ${JSON.stringify(slot)}（已忽略）`)
      return
    }
    // 先登记以占住 via:'manifest'，再覆盖 meta
    let bucket = this.byOwner.get(owner)
    if (!bucket) {
      bucket = new Map()
      this.byOwner.set(owner, bucket)
    }
    if (!bucket.has(slot)) bucket.set(slot, { via: 'manifest', lazy: false })
    this.contribute(owner, slot, meta)
  }

  list(slot?: SlotName): readonly SlotContribution[] {
    const out: SlotContribution[] = []
    for (const owner of [...this.byOwner.keys()].sort((a, b) => a.localeCompare(b))) {
      const bucket = this.byOwner.get(owner)
      if (!bucket) continue
      for (const [name, meta] of bucket) {
        if (slot !== undefined && name !== slot) continue
        out.push({
          slot: name,
          owner,
          via: meta.via,
          lazy: meta.lazy,
          ...(meta.importPath === undefined ? {} : { importPath: meta.importPath }),
        })
      }
    }
    // 稳定顺序：内置插槽按白名单顺序 → 自定义插槽按插槽名字典序 → owner 字典序
    // （list() 是诊断/入口表数据源，顺序必须确定）
    const slotRank = new Map<string, number>(SLOT_NAMES.map((n, i) => [n, i]))
    out.sort((a, b) => {
      const ra = slotRank.get(a.slot)
      const rb = slotRank.get(b.slot)
      const ka = ra ?? SLOT_NAMES.length
      const kb = rb ?? SLOT_NAMES.length
      if (ka !== kb) return ka - kb
      // 同属"自定义插槽"时先按插槽名分组；否则（都是同一个内置插槽）直接比 owner
      if (ra === undefined && rb === undefined) {
        const s = a.slot.localeCompare(b.slot)
        if (s !== 0) return s
      }
      return a.owner.localeCompare(b.owner)
    })
    return out
  }

  ownersOf(slot: SlotName): readonly string[] {
    return this.list(slot).map((c) => c.owner)
  }

  /** 注销某 owner 的全部贡献（卸载统一出口调用），以及它**声明**过的扩展点 */
  release(owner: string): void {
    this.byOwner.delete(owner)
    // 声明也要一并撤销：否则插件卸载后仍占着扩展点名，别的插件永远声明不进来
    for (const [slot, d] of [...this.declared]) {
      if (d.owner === owner) this.declared.delete(slot)
    }
  }

  /** 注销全部（进程关停 / disposeAll 用） */
  releaseAll(): void {
    this.byOwner.clear()
    this.declared.clear()
  }

  /** 当前贡献总数（诊断用） */
  size(): number {
    let n = 0
    for (const bucket of this.byOwner.values()) n += bucket.size
    return n
  }
}
