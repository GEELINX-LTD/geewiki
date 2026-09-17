/**
 * 插件依赖图的**布局与高亮计划**（纯函数，无 React / React Flow 依赖，便于单测）。
 *
 * 为什么要抽出来：原先分层布局、节点排序、边筛选全写死在 `pages/GraphPage.tsx` 里，
 * 而"图看不清"这件事恰恰是**排序**问题（见下），不是样式问题——既然它是算法，
 * 就该能被单测钉住：给定一张必然交叉的图，排序后交叉数必须下降。
 *
 * 背景（用户反馈："当前的插件依赖图难以看出依赖关系，很多线交织在一起"）：
 * 分层只解决了"被依赖方在左"，**层内顺序**原先直接沿用注册表顺序（`g.nodes` 的先后），
 * 于是同一层里 A 的依赖方排在了 B 的依赖方前面，两条边必然交叉。经典解法是 Sugiyama
 * 框架里的**重心法（barycenter）**：按"邻居在相邻层的平均位置"排序，左右各扫几遍，
 * 每遍算一次交叉数、只保留最好的那次（所以它是**单调不劣**的，不会越排越乱）。
 *
 * 高亮的判据同样在这里：`upstreamClosure` 只沿**依赖方向**（`target → source`，
 * 即"我依赖谁"）传递，**绝不向依赖方（下游）扩散**——用户明确要求"只向前高亮，
 * 不向后高亮"，且这里的"向前"指图上的左侧（依赖面）。反向扩散会把"谁受影响"
 * 混进来，那就不是同一条链了。
 */

/** 依赖图的一条边：`source` 被 `target` 依赖（箭头由 source 指向 target，与后端一致） */
export interface GraphEdgeLike {
  id: string
  source: string
  target: string
}

export interface GraphPlanInput {
  /** 全部节点 id（顺序即"原始顺序"，排序的初始状态与并列时的兜底都由它决定） */
  ids: readonly string[]
  edges: readonly GraphEdgeLike[]
}

export interface GraphPlan {
  /** 每个节点的层号（0 = 不依赖任何插件，越大越靠右） */
  level: Map<string, number>
  /** 每层的节点顺序（已做交叉削减），下标 = 层号 */
  columns: string[][]
  /** 规划后的**可见交叉对数**（横向区间不重叠的边对不计，见 {@link countVisibleCrossings}） */
  crossings: number
}

/** 清理脏边：两端都要存在、且不是自环（自环画出来是一条看不懂的回头线，且会干扰分层） */
export function cleanEdges(ids: readonly string[], edges: readonly GraphEdgeLike[]): GraphEdgeLike[] {
  const idSet = new Set(ids)
  return edges.filter((e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target)
}

/**
 * 分层：`level[target] = max(level[source] + 1)`，反复推进到稳定。
 *
 * 循环推进的写法（而不是按拓扑序一次算完）是为了**含环也能收敛**：真实注册表里
 * 不应有环，但依赖图是会被人盯着的界面，一个环不该让整页崩掉或死循环。最多推
 * `ids.length` 遍——没有环时早就稳定退出，有环时这个上界保证必然终止。
 */
export function computeLevels(ids: readonly string[], edges: readonly GraphEdgeLike[]): Map<string, number> {
  const level = new Map<string, number>(ids.map((id) => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of edges) {
      const want = (level.get(e.source) ?? 0) + 1
      if (want > (level.get(e.target) ?? 0)) {
        level.set(e.target, want)
        changed = true
      }
    }
    if (!changed) break
  }
  return level
}

/**
 * 交叉对数：两条边 `(u1→v1)`、`(u2→v2)` 交叉 ⟺ 它们端点的**层内顺序相反**。
 *
 * 这是标准判据（忽略折线与虚节点）：若 u1 在 u2 左边，而 v1 在 v2 右边，两条线必然相交。
 * 用**顺序号**而不是坐标，是因为布局尚未发生——排序优化只需要序关系，不需要像素。
 * 同一对节点之间的重复边（多重边）会让判据退化，故先按 `节点对` 去重。
 */
export function countCrossings(columns: readonly (readonly string[])[], edges: readonly GraphEdgeLike[]): number {
  const pos = new Map<string, number>()
  columns.forEach((col) =>
    col.forEach((id, i) => {
      // 同一节点只应出现在一层里；万一脏数据让它出现多次，取第一次的位置为准
      if (!pos.has(id)) pos.set(id, i)
    }),
  )
  const seen = new Set<string>()
  const list: { u: number; v: number }[] = []
  for (const e of edges) {
    const u = pos.get(e.source)
    const v = pos.get(e.target)
    if (u === undefined || v === undefined) continue
    const key = `${e.source}\u0000${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ u, v })
  }
  let crossings = 0
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] as { u: number; v: number }
      const b = list[j] as { u: number; v: number }
      if ((a.u - b.u) * (a.v - b.v) < 0) crossings++
    }
  }
  return crossings
}

/**
 * **可见交叉**对数：只统计横向区间有重叠的边对。
 *
 * 为什么不直接用 {@link countCrossings}：它只比较两端在各自列内的序号，不看 x 区间——
 * 一条 `0→3` 的边与一条 `1→2` 的边在序号上"反向"时也会被计一次，可它们在横向上根本不重叠，
 * 肉眼永远看不到交点。实测真实注册表（26 节点 / 47 边 / 4 列）：全部对 220→181，
 * 而**可见对** 151→105 —— 差出来的那几十对是判据的噪声，拿它当优化目标会把力气花在
 * 看不见的地方（本批确实先踩了这个坑：只按全部对优化，怎么调都是 181）。
 *
 * 优化目标与汇报口径都用这个数：它才是用户说的"线交织"。
 */
export function countVisibleCrossings(
  columns: readonly (readonly string[])[],
  edges: readonly GraphEdgeLike[],
): number {
  const pos = new Map<string, number>()
  const col = new Map<string, number>()
  columns.forEach((c, ci) =>
    c.forEach((id, i) => {
      if (!pos.has(id)) {
        pos.set(id, i)
        col.set(id, ci)
      }
    }),
  )
  const seen = new Set<string>()
  const list: { s: number; t: number; u: number; v: number }[] = []
  for (const e of edges) {
    const cs = col.get(e.source)
    const ct = col.get(e.target)
    const u = pos.get(e.source)
    const v = pos.get(e.target)
    if (cs === undefined || ct === undefined || u === undefined || v === undefined) continue
    const key = `${e.source}\u0000${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ s: cs, t: ct, u, v })
  }
  let n = 0
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] as { s: number; t: number; u: number; v: number }
      const b = list[j] as { s: number; t: number; u: number; v: number }
      // 横向区间不重叠 ⇒ 不可能有可见交点（这一条是把噪声滤掉的关键）
      if (Math.max(a.s, a.t) <= Math.min(b.s, b.t) || Math.max(b.s, b.t) <= Math.min(a.s, a.t)) continue
      if ((a.u - b.u) * (a.v - b.v) < 0) n++
    }
  }
  return n
}

/**
 * 局部精修：交换同列**相邻**两个节点，只要可见交叉变少就保留。
 *
 * 为什么重心法之后还要这一步：重心法是启发式，收尾时常留几处"只差一次交换"的逆序。
 * 实测真实注册表：重心法 105 → 加精修 **77**（原注册表顺序 151）。而单独用精修（不先跑
 * 重心法）只有 80 —— 两步是互补的，不是重复劳动。
 *
 * 复杂度与兜底：每轮对每列每个相邻对试一次，每次算一遍可见交叉（O(E²)）。真实规模
 * （几十个插件）完全够用；为防外部插件把注册表撑到几百个，边数超过 {@link REFINE_MAX_EDGES}
 * 直接跳过精修（只有重心法的结果，仍然比原始顺序好），并且最多 {@link REFINE_ROUNDS} 轮、
 * 一旦某轮没有改进就停。
 */
const REFINE_MAX_EDGES = 400
const REFINE_ROUNDS = 3

export function refineBySwaps(
  columns: readonly (readonly string[])[],
  edges: readonly GraphEdgeLike[],
): { columns: string[][]; crossings: number } {
  let cols: string[][] = columns.map((c) => [...c])
  let best = countVisibleCrossings(cols, edges)
  if (edges.length > REFINE_MAX_EDGES) return { columns: cols, crossings: best }
  for (let round = 0; round < REFINE_ROUNDS; round++) {
    let improved = false
    for (let ci = 0; ci < cols.length; ci++) {
      for (let i = 0; i + 1 < (cols[ci] as string[]).length; i++) {
        const next = cols.map((c) => [...c])
        const cur = next[ci] as string[]
        const tmp = cur[i] as string
        cur[i] = cur[i + 1] as string
        cur[i + 1] = tmp
        const crossings = countVisibleCrossings(next, edges)
        if (crossings < best) {
          cols = next
          best = crossings
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return { columns: cols, crossings: best }
}

/**
 * **传递归约**（transitive reduction）：删掉"能经由别的路径到达"的重复连线。
 *
 * 判据（对每条边 `u→v` 独立判断，故与边的排列顺序无关）：**绕开它自身**，`v` 还能从 `u`
 * 沿着别的路径（长度 ≥ 2）走到吗？能 ⇒ 这条线是重复的。
 * 例：`c→b`、`b→x`、`c→x` 同时存在时，`c→x` 可以直接删——`x` 依赖 `c` 这件事已经由
 * `c→b→x` 这条路径表达了，再画一条直达线只是让图更乱。
 *
 * 三条边界：
 *   · **只用于画线**。详情弹窗里的"它依赖"仍列**全部直接依赖**——那是契约数据，不是观感；
 *     删边只影响这张图，不影响任何判定（可达性完全不变）。
 *   · **路径长度必须 ≥2**：起点侧先排除掉"直接指向 v"的那一步，否则两条平行边（同一对
 *     节点、不同 id）会互相把对方判成冗余而全部消失。
 *   · **含环也安全**：纯环（`u→v→w→u`）里没有任何冗余边，逐边判据也不会死循环。
 */
export function transitiveReduction(
  ids: readonly string[],
  edges: readonly GraphEdgeLike[],
): GraphEdgeLike[] {
  const clean = cleanEdges(ids, edges)
  // 按"节点对"去重的后继表：平行边不参与可达性判断（见上面第二条边界）
  const adj = new Map<string, string[]>()
  for (const e of clean) {
    const list = adj.get(e.source)
    if (!list) adj.set(e.source, [e.target])
    else if (!list.includes(e.target)) list.push(e.target)
  }
  const redundant = (edge: GraphEdgeLike): boolean => {
    const first = (adj.get(edge.source) ?? []).filter((t) => t !== edge.target)
    if (first.length === 0) return false
    const seen = new Set<string>(first)
    const stack = [...first]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (cur === edge.target) return true
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    return false
  }
  return clean.filter((e) => !redundant(e))
}

/** 相邻列之间的"可优化区间"：一条边的两端层号之差的绝对值（用于只对相邻层做重心排序） */
function neighborsOf(edges: readonly GraphEdgeLike[], side: 'up' | 'down'): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const e of edges) {
    const from = side === 'up' ? e.target : e.source
    const to = side === 'up' ? e.source : e.target
    const list = map.get(from)
    if (list) list.push(to)
    else map.set(from, [to])
  }
  return map
}

/**
 * 层内排序：按邻居的**平均位置**（重心）升序，左右交替扫描 `sweeps` 轮。
 *
 * 细节与理由：
 *   · **邻居位置取"当前列序里的下标"**，而不是坐标：布局阶段只有序关系可用，且下标
 *     与坐标单调一致，等价。
 *   · **没有邻居的节点**（如第 0 层的插件）重心取 -1：排在同层最前。它们没有约束，
 *     摆在顶部比随机插在中间更能让边少绕路。
 *   · **并列时保持原顺序**（稳定排序 + 以 id 兜底）：没有这一条，同一份数据两次渲染
 *     可能给出不同布局，截图与回归对不上，用户也会觉得"图怎么又变了"。
 *   · **每轮都算交叉数，只保留最好的一版**：重心法是启发式，偶尔会排得更差；
 *     保留最优使其**单调不劣**（这一点有单测钉住）。
 */
export function orderColumns(
  ids: readonly string[],
  edges: readonly GraphEdgeLike[],
  sweeps = 4,
): { columns: string[][]; crossings: number } {
  const level = computeLevels(ids, edges)
  const levelCount = Math.max(0, ...ids.map((id) => (level.get(id) ?? 0) + 1))
  let columns: string[][] = Array.from({ length: levelCount }, () => [])
  for (const id of ids) {
    const l = level.get(id) ?? 0
    ;(columns[l] as string[]).push(id)
  }
  let best = columns.map((c) => [...c])
  let bestCrossings = countVisibleCrossings(best, edges)

  const up = neighborsOf(edges, 'up')
  const down = neighborsOf(edges, 'down')
  const indexOf = (cols: string[][]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const col of cols) col.forEach((id, i) => m.set(id, i))
    return m
  }

  for (let sweep = 0; sweep < sweeps; sweep++) {
    const towardRight = sweep % 2 === 0
    const order = towardRight
      ? columns.map((_, i) => i) // 从左到右：用左邻（依赖）定序
      : columns.map((_, i) => i).reverse() // 从右到左：用右邻（依赖方）定序
    const posBefore = indexOf(columns)
    const next = columns.map((c) => [...c])
    for (const li of order) {
      const col = next[li] as string[]
      const neigh = towardRight ? up : down
      const base = towardRight ? li - 1 : li + 1
      // 只看"紧邻的那一列"的位置：跨层边（跳过中间层）在重心法里没有对应位置，
      // 硬取会引入与当前列不可比的量；这也正是布局只优化相邻层交叉的原因。
      const scored = col.map((id, i) => {
        const list = neigh.get(id) ?? []
        const positions = list.map((n) => posBefore.get(n)).filter((v): v is number => v !== undefined)
        const bary = positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : -1
        return { id, bary, i }
      })
      scored.sort((a, b) => a.bary - b.bary || a.i - b.i || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      next[li] = scored.map((s) => s.id)
      // 供后续列使用的位置表按**最新**列序刷新（就地优化，不整轮重算）
      for (const [i, id] of (next[li] as string[]).entries()) posBefore.set(id, i)
      // 右向扫描时，`base` 只是语义提示（邻居列在左边）；位置表本身已足够
      void base
    }
    columns = next
    const crossings = countVisibleCrossings(columns, edges)
    if (crossings < bestCrossings) {
      bestCrossings = crossings
      best = columns.map((c) => [...c])
    }
  }
  // 重心法之后再走一遍局部精修（两步互补，见 refineBySwaps 的注释）
  return refineBySwaps(best, edges)
}

/** 一次算完：分层 + 层内排序 */
export function planGraph(input: GraphPlanInput): GraphPlan {
  const edges = cleanEdges(input.ids, input.edges)
  const { columns, crossings } = orderColumns(input.ids, edges)
  return { level: computeLevels(input.ids, edges), columns, crossings }
}

export interface UpstreamChain {
  /** 高亮集合：起点自身 + 它（传递）依赖的全部插件 */
  nodes: Set<string>
  /** 高亮集合内部的边（只含"依赖方向"上的边） */
  edges: Set<string>
}

/**
 * 从 `start` 出发沿**依赖方向**收集整条上游链（起点自身包含在内）。
 *
 * 方向约定（与后端 `graph()` 的边一致）：边 `source → target` 读作"target 依赖 source"。
 * 因此"我依赖谁"是**逆向**走边（target → source）——图上表现为向左。
 * 用户原话："高亮一整条依赖链，只向前高亮，不向后高亮"，此处"向前"即向左侧的依赖面；
 * **下游（依赖它的插件）绝不纳入**，那是另一个问题（"停用它会影响谁"）。
 *
 * 用显式栈而不是递归：链深在真实数据里只有个位数，但显式栈同样短，且不用给
 * 递归深度兜底。`visited` 同时兼任**环兜底**：注册表里出现环时不会死循环。
 */
export function upstreamClosure(start: string, edges: readonly GraphEdgeLike[]): UpstreamChain {
  const incoming = new Map<string, GraphEdgeLike[]>()
  for (const e of edges) {
    const list = incoming.get(e.target)
    if (list) list.push(e)
    else incoming.set(e.target, [e])
  }
  const nodes = new Set<string>([start])
  const picked = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    for (const e of incoming.get(cur) ?? []) {
      picked.add(e.id)
      if (!nodes.has(e.source)) {
        nodes.add(e.source)
        stack.push(e.source)
      }
    }
  }
  return { nodes, edges: picked }
}

/** 命中判定的可读封装：`null` 表示"当前没有高亮"（未悬停），此时一切都不该被压暗 */
export function isDimmed(hovered: string | null, chain: UpstreamChain | null, id: string): boolean {
  if (hovered === null || chain === null) return false
  return !chain.nodes.has(id)
}

/** 边的压暗判定：两端都在链上才算"这条边属于这条链" */
export function isEdgeDimmed(
  hovered: string | null,
  chain: UpstreamChain | null,
  edge: { source: string; target: string },
): boolean {
  if (hovered === null || chain === null) return false
  return !(chain.nodes.has(edge.source) && chain.nodes.has(edge.target))
}
