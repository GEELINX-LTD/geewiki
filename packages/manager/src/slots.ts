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
  EXT_MODES,
  HOST_NODE_NAMES,
  PLUGIN_UI_ASSET_MAX_DEPTH,
  SLOT_NAMES,
  extModesOf,
  extendCardinalityOf,
  hostNodeSpec,
  isBuiltinSlotName,
  isExtName,
  isHostNodeName,
  isPluginSlotName,
  supportsExtMode,
  type ExtMode,
  type HostNodeKind,
  type SlotContribution,
  type SlotContributionMeta,
  type SlotDeclaration,
  type SlotName,
  type SlotService,
} from '@geewiki/core'

/**
 * 名字是否可接受：**宿主节点**（`@geewiki/core/extensions` 的目录）∪
 * **插件自定义扩展点**（语法见 core 的 `PLUGIN_SLOT_NAME`）。
 *
 * 判据由 core 的 `isExtName` 提供——目录从"7 个插槽"扩为"宿主节点目录"之后，
 * 白名单不再住在本文件里（否则就又成了一份会漂移的镜像）。
 *
 * 注意这里**不是**"任意字符串都行"：自定义插槽名必须含 `/`，于是不含 `/` 又不在目录里的
 * 名字（`app-headr` 这类笔误）依然被挡下并告警——这是"开放键空间"与"笔误可见"的取舍点。
 */
export function isSlotName(name: unknown): name is SlotName {
  return isExtName(name)
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

/* ===================== 界面扩展平台：模式化裁决（P3） ===================== */

/** 一条**生效**的扩展贡献（前端据此决定调用哪个组件的哪种模式） */
export interface ExtEffectiveContribution {
  readonly owner: string
  readonly mode: ExtMode
  readonly via: 'manifest' | 'runtime'
  readonly lazy: boolean
  readonly importPath?: string
}

/** 一条被抑制的贡献：它撞上了谁（诊断要点名"被谁顶掉"） */
export interface ExtSuppressedContribution {
  readonly owner: string
  readonly mode: ExtMode
  readonly winner: string
}

/**
 * 一个节点的扩展裁决结果。
 *
 * 与 {@link SlotAssignment} 的关系：后者是"只有追加语义"的**旧视图**（形状是已发布契约，
 * 保留），本结构是它的超集，额外回答"**以哪种模式**生效"。两者由同一个
 * {@link resolveExtensions} 产出，不存在两套裁决。
 */
export interface ExtNodeAssignment {
  readonly node: SlotName
  /** 宿主节点分组；`'custom'` = 插件自定义扩展点（未在目录里登记） */
  readonly kind: HostNodeKind | 'custom'
  /** `extend` 的占用基数（与 {@link SlotAssignment.cardinality} 同义） */
  readonly cardinality: 'single' | 'multi'
  /** 该节点允许的模式；自定义扩展点一律 `['extend']` */
  readonly modes: readonly ExtMode[]
  /** props 契约版本（非宿主节点为 1） */
  readonly propsVersion: number
  /** **全部贡献者**，按激活顺序（不在激活顺序里的排在最后，按名字典序） */
  readonly owners: readonly string[]
  /** **实际生效**的贡献，顺序 = 应用顺序（replace → wrap → extend） */
  readonly effective: readonly ExtEffectiveContribution[]
  /** 被抑制的贡献者（按激活顺序） */
  readonly suppressed: readonly string[]
  /** 按模式分桶的生效者：前端拿它直接组装（`replace`/`wrap` 至多一个） */
  readonly byMode: {
    readonly replace?: string
    readonly wrap?: string
    readonly extend: readonly string[]
  }
  /** 被抑制的明细（谁、以什么模式、被谁顶掉）——诊断与管理台告警用 */
  readonly suppressedDetail: readonly ExtSuppressedContribution[]
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
 * 纯函数：把"谁声明了哪些扩展点"裁决成"每个节点谁生效"（**界面扩展平台的主裁决器**）。
 *
 * ## 裁决规则
 * - `replace` / `wrap`：**恒为单占用**（模式定义的一部分，不是可配置项）——
 *   多方声明时**激活顺序最早者胜出**，其余进 `suppressed` 并被记为冲突。
 * - `extend`：占用基数由节点决定（内置插槽取 `SLOT_CARDINALITY`，其余默认 `multi`）。
 *
 * 为什么是"最早"而不是"最新"：最新胜出会让后启用的插件**静默顶掉**已在工作的编辑器，
 * 用户看到的是"我的编辑器突然换了"却没有任何提示；最早胜出则保证"先来的继续工作"，
 * 后来者被明确抑制——**状态可预期，且冲突在诊断里可见**。
 * 真正的解法是让插件作者用 `conflictGroup` 声明互斥（那时第二个根本激活不了，
 * 用户会在启用时就收到明确拒绝，而不是激活后才发现没生效）。
 *
 * ## `effective` 的顺序 = 应用顺序
 * `replace → wrap → extend`（见 `EXT_MODES` 的定义顺序）：先确定"渲染什么"，
 * 再"包一层"，最后"追加"。前端据此顺序组装即可，不需要自己再排一遍。
 */
export function resolveExtensions(
  contributions: readonly SlotContribution[],
  activationOrder: readonly string[],
  declarations: readonly (SlotDeclaration & { readonly slot: string })[] = [],
): ExtNodeAssignment[] {
  const cmp = orderOf(activationOrder)
  const declared = declarationIndex(declarations)
  const present = new Set<string>(contributions.map((c) => c.slot as string))

  /*
    输出顺序 = 内置插槽（白名单顺序）→ 其它宿主节点（目录顺序）→ 插件自定义扩展点（字典序）。
    为什么自定义扩展点用**字典序**而不是"首次贡献顺序"：本函数是纯函数，
    若次序取决于贡献列表的插入序，结果就会随 Map 迭代顺序漂移、也无法稳定单测。
    字典序是确定的，且"自定义排在所有宿主节点之后"让内置名的定位成本不变。
  */
  const ordered: string[] = []
  for (const s of SLOT_NAMES) if (present.has(s)) ordered.push(s)
  for (const s of HOST_NODE_NAMES) if (!isBuiltinSlotName(s) && present.has(s)) ordered.push(s)
  for (const s of [...present].filter((n) => !isBuiltinSlotName(n) && !isHostNodeName(n)).sort((a, b) => a.localeCompare(b))) {
    ordered.push(s)
  }

  const out: ExtNodeAssignment[] = []
  for (const node of ordered) {
    /*
      同一 `(owner, node)` 只保留一条贡献：注册表以它为键（后登记覆盖模式），
      故 `list()` 里不会出现同键两条；这里的 Map 只是让"万一出现"也有确定结果。
    */
    const byOwner = new Map<string, SlotContribution>()
    for (const c of contributions) {
      if (c.slot !== node) continue
      if (!byOwner.has(c.owner)) byOwner.set(c.owner, c)
    }
    if (byOwner.size === 0) continue
    const owners = [...byOwner.keys()].sort(cmp)

    const spec = hostNodeSpec(node)
    // 内置插槽的基数真源是 SLOT_CARDINALITY（`extendCardinalityOf` 内部读它）；
    // 自定义扩展点取 `define()` 的声明，未声明默认 multi。
    const cardinality = spec ? extendCardinalityOf(node) : (declared.get(node)?.cardinality ?? 'multi')
    const modes = spec ? extModesOf(node) : (['extend'] as readonly ExtMode[])
    const propsVersion = spec?.propsVersion ?? 1

    const effective: ExtEffectiveContribution[] = []
    const suppressed: string[] = []
    const suppressedDetail: ExtSuppressedContribution[] = []

    // EXT_MODES 的顺序就是应用顺序（replace → wrap → extend），循环直接复用它
    for (const mode of EXT_MODES) {
      const candidates = owners.filter((o) => (byOwner.get(o)?.mode ?? 'extend') === mode)
      if (candidates.length === 0) continue
      const winners =
        mode === 'extend'
          ? cardinality === 'single'
            ? candidates.slice(0, 1)
            : candidates
          : candidates.slice(0, 1)
      const winnerSet = new Set(winners)
      for (const w of winners) {
        const c = byOwner.get(w) as SlotContribution
        effective.push({
          owner: w,
          mode,
          via: c.via,
          lazy: c.lazy,
          ...(c.importPath === undefined ? {} : { importPath: c.importPath }),
        })
      }
      for (const loser of candidates.filter((o) => !winnerSet.has(o))) {
        suppressed.push(loser)
        suppressedDetail.push({ owner: loser, mode, winner: winners[0] as string })
      }
    }

    const replaceWinner = effective.find((e) => e.mode === 'replace')?.owner
    const wrapWinner = effective.find((e) => e.mode === 'wrap')?.owner
    out.push({
      node: node as SlotName,
      kind: spec?.kind ?? 'custom',
      cardinality,
      modes,
      propsVersion,
      owners,
      effective,
      suppressed,
      byMode: {
        ...(replaceWinner === undefined ? {} : { replace: replaceWinner }),
        ...(wrapWinner === undefined ? {} : { wrap: wrapWinner }),
        extend: effective.filter((e) => e.mode === 'extend').map((e) => e.owner),
      },
      suppressedDetail,
    })
  }
  return out
}

/**
 * 旧视图：只有"追加"语义的插槽裁决（**兼容外壳**，不是第二套实现）。
 *
 * 为什么保留：`SlotAssignment` 的形状是**已发布的契约**（入口表的按插件 `slots` 字段、
 * `GET /api/plugins/slots` 的既有字段、`effectiveSlotsByOwner` / `conflictsOf` /
 * `undeclaredSlots` 三个消费者，以及它们的守卫测试）。这里**只做投影**，
 * 不重写裁决——否则"同一事实两处裁决"必然漂移，而漂移的表现是
 * "诊断端点说 A 生效、界面渲染 B"。
 */
export function resolveSlots(
  contributions: readonly SlotContribution[],
  activationOrder: readonly string[],
  declarations: readonly (SlotDeclaration & { readonly slot: string })[] = [],
): SlotAssignment[] {
  return resolveExtensions(contributions, activationOrder, declarations).map((a) => ({
    slot: a.node,
    cardinality: a.cardinality,
    owners: a.owners,
    // 逐字保留旧公式（而不是取 byMode.extend）：旧视图的读者不知道"模式"，
    // 用新概念去改写旧语义会让既有诊断结果悄悄变化。
    effective: a.cardinality === 'single' ? a.owners.slice(0, 1) : a.owners,
    suppressed: a.cardinality === 'single' ? a.owners.slice(1) : [],
  }))
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
  private readonly byOwner = new Map<string, Map<SlotName, { via: 'manifest' | 'runtime'; lazy: boolean; importPath?: string; mode: ExtMode }>>()

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
   * 登记一条贡献（`mode: 'extend'` 的简写），返回**幂等**的注销函数。
   *
   * 同一 `(owner, node)` 重复登记视为同一条：后登记的 `lazy`/`importPath`/`mode` 覆盖先前的，
   * 但 `via` 保留**先登记**的那个（manifest 先于运行期登记，故声明式身份不会被运行期改写）。
   */
  contribute(owner: string, slot: SlotName, meta?: SlotContributionMeta): () => void {
    return this.extend(owner, slot, 'extend', meta)
  }

  /**
   * 登记一条**指定模式**的扩展贡献（界面扩展平台，P3）。
   *
   * 与 `contribute` 的唯一区别是模式，外加两条"宿主才知道"的拒绝规则：
   * - 节点不允许该模式（如对 `app-header` 声明 `replace`）⇒ 忽略并告警；
   * - 插件自定义扩展点上的 `replace` / `wrap` ⇒ 忽略并告警（别的插件的扩展点契约由它自己定义）。
   *
   * 两条都**不抛**：插件作者拿不到目录，猜错是常态；但**绝不能静默**——
   * 静默的后果是"插件声明了 replace、界面上什么都没变"，且日志干净。
   */
  extend(owner: string, slot: SlotName, mode: ExtMode, meta?: SlotContributionMeta): () => void {
    return this.register(owner, slot, mode, 'runtime', meta)
  }

  /**
   * 全部登记的**唯一实现**（`extend` 与 `contributeFromManifest` 都走这里）。
   *
   * ## 为什么必须合成一个方法（踩过）
   * 最初的写法是"`contributeFromManifest` 先往表里塞一条占住 `via:'manifest'`，再调
   * `extend()` 覆盖 meta"。于是**被拒绝的声明会留在表里**：`app-header` 不允许 `replace`，
   * `extend()` 拒绝并告警，但那条预塞的占位记录没人清——表现为"清单里声明了、诊断端点里
   * 却出现一条谁也不认识的贡献"，而且 `resolveExtensions` 会把它算进 `owners`。
   * 正确形状：**先校验、后落表**，中间没有"半成品状态"。
   *
   * @param via 贡献来源；已存在的同键记录保留**先登记的** `via`
   *   （manifest 先于运行期登记，故声明式身份不会被运行期改写）
   */
  private register(
    owner: string,
    slot: SlotName,
    mode: ExtMode,
    via: 'manifest' | 'runtime',
    meta?: SlotContributionMeta,
  ): () => void {
    if (!isSlotName(slot)) {
      // 既不是宿主节点、也不是合法的自定义扩展点名：忽略 + 告警，**不抛**
      // （与前端忽略未知插槽名的既有行为一致）。
      // 这条正是"笔误可见"的落点：`app-headr` 会走到这里，而不是被当成一个新节点静默接受。
      console.warn(
        `[manager:slot] 忽略未知扩展点 ${JSON.stringify(slot)}（贡献者 ${owner}）：` +
          `宿主节点见 @geewiki/core/extensions 的目录；自定义扩展点须形如 "命名空间/名字"（含 \`/\`）`,
      )
      return () => {}
    }
    if (typeof owner !== 'string' || owner.length === 0) {
      console.warn(`[manager:slot] 忽略空 owner 的插槽贡献（slot=${slot}）`)
      return () => {}
    }
    if (!EXT_MODES.includes(mode)) {
      console.warn(`[manager:slot] 忽略未知模式 ${JSON.stringify(mode)}（贡献者 ${owner}，node=${slot}）`)
      return () => {}
    }
    if (!supportsExtMode(slot, mode)) {
      console.warn(
        `[manager:slot] 忽略 ${owner} 对 ${JSON.stringify(slot)} 的 ${mode} 声明：` +
          `该节点只允许 ${JSON.stringify(extModesOf(slot))}（宿主节点目录是唯一判据）`,
      )
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
    /*
      同一 (owner, node) 只有一条贡献，模式是它的属性：改了模式要**告警**而不是静默覆盖。
      理由：`replace` 会让宿主默认实现整个不渲染（无障碍与键盘可达的责任转移），
      一次静默的模式变化足以解释"我的编辑器昨天还在、今天没了"，而日志里什么都不该少。
    */
    if (existing && existing.mode !== mode) {
      console.warn(
        `[manager:slot] ${owner} 把 ${JSON.stringify(slot)} 的模式由 ${existing.mode} 改为 ${mode}（同一 (owner, node) 只保留一条贡献）`,
      )
    }
    slots.set(slot, {
      via: existing?.via ?? via,
      lazy: meta?.lazy ?? existing?.lazy ?? false,
      importPath: importPath ?? existing?.importPath,
      mode,
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
  contributeFromManifest(owner: string, slot: SlotName, meta?: SlotContributionMeta, mode: ExtMode = 'extend'): void {
    // 校验与落表都在 register 里一次完成：**不得**先塞占位再校验（踩过：被拒的声明会留在表里）
    this.register(owner, slot, mode, 'manifest', meta)
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
          mode: meta.mode,
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
