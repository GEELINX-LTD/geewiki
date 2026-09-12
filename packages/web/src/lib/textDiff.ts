/**
 * textDiff —— **按行的差异计算**（纯函数：无 DOM、无 React、无网络、无依赖）。
 *
 * 用途：版本对比弹窗要回答"**改了哪里**"。为此需要三样东西：
 *   1. 行级操作序列（same / add / del）—— 决定怎么渲染；
 *   2. 增删计数 `+N / −M` —— 决定菜单与标题里的摘要；
 *   3. 「改动落在哪个小节」—— 见 `changedSections()`。
 *
 * ## 算法
 * 先剥掉**公共前缀与公共后缀**行，只对中间那段做 LCS 动态规划。理由是实测的常见形状：
 * 追加一段（前缀全同、后缀为空）、改一行（前后缀都很长）、删一段 —— 这三种在剥掉前后缀后
 * 中间段都极小，代价从 O(总行数²) 降到 O(改动量²)。真正需要完整 LCS 的是"大段重排"。
 *
 * ## 为什么只做行级、不做句级
 * Markdown 的语义单位就是行（标题、列表项、表格行、围栏代码）。中文长段落通常是**一整行**，
 * 改一个字就会被标成"这一行变了" —— 这是**诚实**的答案（用户要的是"改了哪里"，
 * 不是"改了几个字"）。再按句切一次会把一处小改碎成十几行，**更难读**，而且那是美化。
 *
 * ## 上限保护（**不静默截断**）
 * 中间段太大时（`maxCells`）退化为"整段替换"，并在 `stats.degraded` 里置位。
 * 界面必须把 `degraded` **显式说出来** —— 悄悄少显示几行差异比不显示更坏。
 */

/** 一行差异操作。`aLine`/`bLine` 是**旧/新文本里的行号（从 1 起）**；不适用的一侧为 `null`。 */
export interface DiffOp {
  type: 'same' | 'add' | 'del'
  aLine: number | null
  bLine: number | null
  text: string
}

export interface DiffStats {
  added: number
  removed: number
  /** true = 因超出上限而退化（差异视图只说"整段替换"，界面必须如实告知） */
  degraded: boolean
}

export interface DiffResult {
  ops: DiffOp[]
  stats: DiffStats
}

/**
 * 中间段 LCS 的单元上限（`n × m`）。`1_000_000` 约等于两侧各 1000 行时的规模，
 * 在现代浏览器里是几十毫秒量级；再大就该退化了。
 */
export const DEFAULT_MAX_CELLS = 1_000_000

/**
 * 读数组元素。
 *
 * 本包开了 `noUncheckedIndexedAccess`（索引访问按 `T | undefined` 处理）—— 那是**好事**，
 * 但它对"我刚用 `i < arr.length` 判过界"的循环帮不上忙。这里的 `?? ''` 不是兜底逻辑，
 * 而是把那个已被证明的不变量写给类型系统看：越界只可能发生在代码出错时，
 * 此时给空串比抛异常好（差异视图不该因为一个越界就整页崩）。
 */
function at(arr: readonly string[], i: number): string {
  return arr[i] ?? ''
}

/** `Int32Array` 的越界读同理（DP 表里所有下标都落在 `0..(n+1)*(m+1)` 内）。 */
function dv(table: Int32Array, i: number): number {
  return table[i] ?? 0
}

/** 按行切分：统一处理 `\r\n`（否则行尾的 `\r` 会让"完全相同"的两行被判为不同）。 */
function splitLines(s: string): string[] {
  if (s === '') return []
  return s.replace(/\r\n?/g, '\n').split('\n')
}

/**
 * 行级差异。
 *
 * @param a 旧文本（对比弹窗里是**较旧**的那一版）
 * @param b 新文本（较新的一版；对比"快照 → 当前"时就是页面当前正文）
 */
export function diffLines(
  a: string,
  b: string,
  opts: { maxCells?: number } = {},
): DiffResult {
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS
  const A = splitLines(a)
  const B = splitLines(b)

  // ① 剥公共前缀
  let start = 0
  while (start < A.length && start < B.length && at(A, start) === at(B, start)) start++
  // ② 剥公共后缀（不能与前缀重叠）
  let endA = A.length
  let endB = B.length
  while (endA > start && endB > start && at(A, endA - 1) === at(B, endB - 1)) {
    endA--
    endB--
  }

  const ops: DiffOp[] = []
  for (let i = 0; i < start; i++) {
    ops.push({ type: 'same', aLine: i + 1, bLine: i + 1, text: at(A, i) })
  }

  const midA = A.slice(start, endA)
  const midB = B.slice(start, endB)
  let degraded = false

  if (midA.length === 0) {
    // 纯新增
    for (let j = 0; j < midB.length; j++) {
      ops.push({ type: 'add', aLine: null, bLine: start + j + 1, text: at(midB, j) })
    }
  } else if (midB.length === 0) {
    // 纯删除
    for (let i = 0; i < midA.length; i++) {
      ops.push({ type: 'del', aLine: start + i + 1, bLine: null, text: at(midA, i) })
    }
  } else if (midA.length * midB.length > maxCells) {
    degraded = true
    for (let i = 0; i < midA.length; i++) {
      ops.push({ type: 'del', aLine: start + i + 1, bLine: null, text: at(midA, i) })
    }
    for (let j = 0; j < midB.length; j++) {
      ops.push({ type: 'add', aLine: null, bLine: start + j + 1, text: at(midB, j) })
    }
  } else {
    ops.push(...lcsOps(midA, midB, start))
  }

  for (let k = endA; k < A.length; k++) {
    ops.push({ type: 'same', aLine: k + 1, bLine: endB + (k - endA) + 1, text: at(A, k) })
  }

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'add') added++
    else if (op.type === 'del') removed++
  }
  return { ops, stats: { added, removed, degraded } }
}

/**
 * 中段的 LCS 回溯（`midA`/`midB` 是各自原文里从 `offset` 行开始的那一段）。
 *
 * 用**长度表 + 回溯**而不是递归：递归在千行级输入上会爆栈。
 * 表用 `Int32Array` 展平（`(n+1) × (m+1)`），避免二维数组的分配开销。
 */
function lcsOps(midA: readonly string[], midB: readonly string[], offset: number): DiffOp[] {
  const n = midA.length
  const m = midB.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      /*
       * 两侧取行都经 `at()`：本包开了 `noUncheckedIndexedAccess`，而下标由
       * `i < n` / `j < m` 保证合法 —— `at()` 把这个已证明的不变量写给类型系统看。
       */
      dp[i * w + j] =
        at(midA, i) === at(midB, j)
          ? dv(dp, (i + 1) * w + (j + 1)) + 1
          : Math.max(dv(dp, (i + 1) * w + j), dv(dp, i * w + (j + 1)))
    }
  }
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (at(midA, i) === at(midB, j)) {
      out.push({ type: 'same', aLine: offset + i + 1, bLine: offset + j + 1, text: at(midA, i) })
      i++
      j++
    } else if (dv(dp, (i + 1) * w + j) >= dv(dp, i * w + (j + 1))) {
      out.push({ type: 'del', aLine: offset + i + 1, bLine: null, text: at(midA, i) })
      i++
    } else {
      out.push({ type: 'add', aLine: null, bLine: offset + j + 1, text: at(midB, j) })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', aLine: offset + i + 1, bLine: null, text: at(midA, i) })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', aLine: null, bLine: offset + j + 1, text: at(midB, j) })
    j++
  }
  return out
}

/** 只要摘要（菜单与时间线用）。等价于 `diffLines(a, b).stats`，语义上更明确。 */
export function diffStats(a: string, b: string, opts: { maxCells?: number } = {}): DiffStats {
  return diffLines(a, b, opts).stats
}

/** `+12 −3`（两个数都为 0 时给"仅权限/元数据变更"，见下）。 */
export function statsLabel(stats: DiffStats): string {
  if (stats.added === 0 && stats.removed === 0) return '正文未变'
  return `+${stats.added} −${stats.removed}`
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** 取标题文本（捕获组 2 一定存在，因为正则要求至少一个非空字符）。 */
function headingOf(line: string): string | null {
  const m = HEADING_RE.exec(line)
  return m === null ? null : (m[2] ?? line)
}

/**
 * 改动落在哪些小节。
 *
 * 做法：把变更行按"连续块"分组，每块**向上回溯最近的 Markdown 标题**（沿 `ops` 找该行之前
 * 最后一条 `same`/`del` 里的标题 —— `del` 也要看，否则"删掉标题本身"这一块会失去归属）。
 *
 * ★ 文案纪律：这是**按最近标题推断**，不是语义切分。所以返回值只用来写
 *   「改动集中在《小节名》」，**不写**"本节修改了 3 处"这类更像事实的断言。
 *   推不出标题（文档开头就没有标题、或那一块在第一个标题之前）⇒ 退化为行号区间。
 */
export function changedSections(ops: readonly DiffOp[], maxSections = 3): string[] {
  /*
   * 单遍扫描同时做三件事：① 维护"当前所处标题"的前缀状态；② 把连续的 add/del 分组；
   * ③ 记录每组的首行与它所属的标题。**不要**对每组再回头 `indexOf` 找首行 ——
   * 那是 O(块数 × 总行数)，在几千行的文档上会退化成肉眼可见的卡顿。
   */
  const found: string[] = []
  let heading: string | null = null
  let blockFirstLine = 0
  let blockLines: number[] = []

  const flush = (): void => {
    if (blockLines.length === 0) return
    const label = heading ?? rangeLabel(blockLines, blockFirstLine)
    if (!found.includes(label)) found.push(label)
    blockLines = []
  }

  for (const op of ops) {
    if (op.type === 'same') {
      flush()
      heading = headingOf(op.text) ?? heading
      continue
    }
    if (blockLines.length === 0) blockFirstLine = op.bLine ?? op.aLine ?? 0
    const line = op.bLine ?? op.aLine
    if (line !== null) blockLines.push(line)
    // 删除的标题也要更新归属：否则"连标题一起删掉"的那一块会算到上一个标题名下
    if (op.type === 'del') heading = headingOf(op.text) ?? heading
    if (found.length >= maxSections) return found
  }
  flush()
  return found.slice(0, maxSections)
}

/** 无标题时的退化表述：行号区间（新文本优先，因为它才是"现在能看见的"那份）。 */
function rangeLabel(lines: readonly number[], fallbackLine: number): string {
  if (lines.length === 0) return `第 ${fallbackLine} 行附近`
  const lo = Math.min(...lines)
  const hi = Math.max(...lines)
  return lo === hi ? `第 ${lo} 行` : `第 ${lo}–${hi} 行`
}
