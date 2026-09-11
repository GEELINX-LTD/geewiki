/**
 * 插槽贡献注册表与**基数裁决**（`ctx.get('slot')` 的实现）。
 *
 * 分工（与 `plugin-ui.ts` 同一风格）：
 * - {@link SlotRegistry} 是**可变外壳**：登记 / 注销 / 查询，挂插件生命周期；
 * - {@link resolveSlots} 是**纯函数**：只依赖"贡献列表 + 激活顺序"，可脱离 IO 单测
 *   （基数裁决与冲突判定最容易写错，必须能单测）。
 *
 * 为什么放在 manager 而不是单独一个插件：插槽贡献的归属与回收必须挂在**插件生命周期**上
 * （激活时登记、卸载时注销），而 manager 正是生命周期与 UnloadPlugin 统一出口的持有者。
 * 另起一个插件反而要在两者间来回同步、并多出一个"谁先谁后"的启动顺序问题。
 */

import {
  PLUGIN_UI_ASSET_MAX_DEPTH,
  SLOT_CARDINALITY,
  SLOT_NAMES,
  type SlotContribution,
  type SlotContributionMeta,
  type SlotName,
  type SlotService,
} from '@geewiki/core'

/** 名字是否在白名单内（插槽名是编译期联合类型，运行期仍需校验外部输入） */
export function isSlotName(name: unknown): name is SlotName {
  return typeof name === 'string' && (SLOT_NAMES as readonly string[]).includes(name)
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
): SlotAssignment[] {
  const cmp = orderOf(activationOrder)
  const out: SlotAssignment[] = []
  // 按白名单顺序输出，保证结果稳定（与注册表的插入顺序无关）
  for (const slot of SLOT_NAMES) {
    const owners = contributions
      .filter((c) => c.slot === slot)
      .map((c) => c.owner)
      .sort(cmp)
    if (owners.length === 0) continue
    const cardinality = SLOT_CARDINALITY[slot]
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
   * 登记一条贡献，返回**幂等**的注销函数。
   *
   * 同一 `(owner, slot)` 重复登记视为同一条：后登记的 `lazy`/`importPath` 覆盖先前的，
   * 但 `via` 保留**先登记**的那个（manifest 先于运行期登记，故声明式身份不会被运行期改写）。
   */
  contribute(owner: string, slot: SlotName, meta?: SlotContributionMeta): () => void {
    if (!isSlotName(slot)) {
      // 未在白名单内：忽略 + 告警，**不抛**（与前端忽略未知插槽名的既有行为一致）
      console.warn(`[manager:slot] 忽略未知插槽名 ${JSON.stringify(slot)}（贡献者 ${owner}）`)
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
    // 稳定顺序：先按插槽白名单顺序，再按 owner 字典序（list() 是诊断/入口表数据源，顺序必须确定）
    const slotRank = new Map(SLOT_NAMES.map((n, i) => [n, i]))
    out.sort((a, b) => {
      const ra = slotRank.get(a.slot) ?? SLOT_NAMES.length
      const rb = slotRank.get(b.slot) ?? SLOT_NAMES.length
      if (ra !== rb) return ra - rb
      return a.owner.localeCompare(b.owner)
    })
    return out
  }

  ownersOf(slot: SlotName): readonly string[] {
    return this.list(slot).map((c) => c.owner)
  }

  /** 注销某 owner 的全部贡献（卸载统一出口调用） */
  release(owner: string): void {
    this.byOwner.delete(owner)
  }

  /** 注销全部（进程关停 / disposeAll 用） */
  releaseAll(): void {
    this.byOwner.clear()
  }

  /** 当前贡献总数（诊断用） */
  size(): number {
    let n = 0
    for (const bucket of this.byOwner.values()) n += bucket.size
    return n
  }
}
