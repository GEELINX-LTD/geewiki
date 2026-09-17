/**
 * 依赖图布局与高亮计划的单测。
 *
 * 这些用例对着的是**用户描述的问题**，而不是实现细节：
 *   · "很多线交织在一起" → 交叉数必须下降（构造一张必然交叉的图，断言排序后为 0）；
 *   · "只向前高亮，不向后高亮" → 下游节点（依赖它的）绝不出现在高亮集合里；
 *   · 布局必须**确定**（同一份数据两次规划结果相同），否则截图与回归都会飘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanEdges,
  computeLevels,
  countCrossings,
  countVisibleCrossings,
  isDimmed,
  isEdgeDimmed,
  planGraph,
  orderColumns,
  refineBySwaps,
  transitiveReduction,
  upstreamClosure,
} from '../src/lib/pluginGraphPlan'

/** 便捷构造：`e('a','b')` = "b 依赖 a"（箭头 a → b） */
const e = (source: string, target: string) => ({ id: `${source}->${target}`, source, target })

test('cleanEdges：丢掉悬空端点与自环（自环画出来是一条没有意义的回头线）', () => {
  const edges = [e('a', 'b'), e('b', 'ghost'), e('gone', 'a'), e('a', 'a')]
  assert.deepEqual(
    cleanEdges(['a', 'b'], edges).map((x) => x.id),
    ['a->b'],
  )
})

test('computeLevels：被依赖方在左、链越长越靠右；含环也能终止', () => {
  const ids = ['a', 'b', 'c']
  const level = computeLevels(ids, [e('a', 'b'), e('b', 'c')])
  assert.deepEqual([level.get('a'), level.get('b'), level.get('c')], [0, 1, 2])

  // 环：不应死循环（上界是 ids.length 遍），也不应抛错
  const cyc = computeLevels(['x', 'y'], [e('x', 'y'), e('y', 'x')])
  assert.ok((cyc.get('x') ?? 0) > 0 && (cyc.get('y') ?? 0) > 0)
})

test('countCrossings：端点顺序相反才算交叉（同层重叠不计）', () => {
  // 层0: [a, b]，层1: [c, d]；b→c 与 a→d 必然交叉
  const columns = [
    ['a', 'b'],
    ['c', 'd'],
  ]
  assert.equal(countCrossings(columns, [e('a', 'd'), e('b', 'c')]), 1)
  // 换成 a→c、b→d 就不交叉
  assert.equal(countCrossings(columns, [e('a', 'c'), e('b', 'd')]), 0)
})

test('层内排序：必然交叉的图被排成零交叉（这就是"线不再交织"）', () => {
  // 层0: a, b；层1: c, d（按注册表顺序 c 在前）。a→d、b→c ⇒ 交叉 1 对
  const ids = ['a', 'b', 'c', 'd']
  const edges = [e('a', 'd'), e('b', 'c')]
  const before = [
    ['a', 'b'],
    ['c', 'd'],
  ]
  assert.equal(countCrossings(before, edges), 1, '前提：按注册表顺序确实交叉')

  const planned = planGraph({ ids, edges })
  assert.equal(planned.crossings, 0, '重心法排序后交叉数必须归零')
  assert.deepEqual(planned.columns[1], ['d', 'c'], 'd 的依赖是 a（更靠前），故 d 应排到 c 前面')
})

test('传递归约：经由上游可到达的重复依赖不再连线（用户口径："前置依赖已经依赖了，就不要连这条线"）', () => {
  // c→b、b→x、c→x：x 依赖 c 这件事已由 c→b→x 表达 ⇒ c→x 冗余
  const edges = [e('c', 'b'), e('b', 'x'), e('c', 'x')]
  const kept = transitiveReduction(['b', 'c', 'x'], edges)
  assert.deepEqual(kept.map((x) => x.id), ['c->b', 'b->x'], '直达的冗余线要被删掉')
})

test('传递归约：只删"还能绕到"的，直接依赖一个都不能少', () => {
  // 菱形：a→b、a→c、b→d、c→d（a 到 d 有两条路，但没有任何一条是"冗余直达"）
  const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')]
  assert.equal(transitiveReduction(['a', 'b', 'c', 'd'], edges).length, 4, '菱形里的四条边都不可省')
  // 叶子依赖：a→b、a→c，b 不依赖 c ⇒ 两条都留
  assert.equal(transitiveReduction(['a', 'b', 'c'], [e('a', 'b'), e('a', 'c')]).length, 2)
})

test('传递归约：可达性必须完全不变（这是它"只影响观感"的判据）', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const edges = [e('a', 'b'), e('b', 'c'), e('a', 'c'), e('c', 'd'), e('a', 'd'), e('b', 'd'), e('d', 'e')]
  const closure = (list: { source: string; target: string }[], from: string): string[] => {
    const adj = new Map<string, string[]>()
    for (const x of list) adj.set(x.source, [...(adj.get(x.source) ?? []), x.target])
    const seen = new Set<string>([from])
    const st = [from]
    while (st.length) {
      const c = st.pop() as string
      for (const n of adj.get(c) ?? []) if (!seen.has(n)) { seen.add(n); st.push(n) }
    }
    return [...seen].sort()
  }
  const kept = transitiveReduction(ids, edges)
  assert.ok(kept.length < edges.length, `应当确实删掉了冗余边（${kept.length} < ${edges.length}）`)
  for (const id of ids) {
    assert.deepEqual(closure(kept, id), closure(edges, id), `${id} 的可达集合不得变化`)
  }
})

test('传递归约：平行边与环都不得被误删', () => {
  // 同一对节点两条边（不同 id）：长度必须 ≥2 才算冗余 ⇒ 两条都留
  const parallel = [
    { id: 'a->b#1', source: 'a', target: 'b' },
    { id: 'a->b#2', source: 'a', target: 'b' },
  ]
  assert.equal(transitiveReduction(['a', 'b'], parallel).length, 2, '平行边不得互相判成冗余')
  // 纯环：没有任何冗余边，且不得死循环
  const cyc = [e('x', 'y'), e('y', 'z'), e('z', 'x')]
  assert.equal(transitiveReduction(['x', 'y', 'z'], cyc).length, 3)
})

test('可见交叉：横向区间不重叠的边对一律不算（否则会拿"看不见的交叉"当优化目标）', () => {
  /*
   * 四列、每列两个节点：col0=[a,b]、col1=[c,d]、col2=[e,f]、col3=[g,h]。
   * 列内下标即比较用的"序号"。
   */
  const cols = [
    ['a', 'b'],
    ['c', 'd'],
    ['e', 'f'],
    ['g', 'h'],
  ]
  // a(col0,0) → c(col1,0)：区间 [0,1]；f(col2,1) → g(col3,0)：区间 [2,3] ⇒ 横向不重叠，永不计数
  const disjoint = [e('a', 'c'), e('f', 'g')]
  assert.equal(countVisibleCrossings(cols, disjoint), 0, 'x 区间不相交 ⇒ 不可能有可见交点')
  // a(col0,0) → h(col3,1) 与 b(col1,1) → g(col2,0)：区间 [0,3] 与 [1,2] 重叠且序号相反 ⇒ 1
  const overlap = [e('a', 'h'), e('b', 'g')]
  assert.equal(countVisibleCrossings(cols, overlap), 1)
})

test('局部精修：只会让可见交叉更少（单调不劣），且对已最优的图不动', () => {
  const cols = [
    ['a', 'b'],
    ['c', 'd'],
  ]
  const crossed = [e('a', 'd'), e('b', 'c')]
  assert.equal(countVisibleCrossings(cols, crossed), 1, '前提：这一版确实有 1 对可见交叉')
  const fixed = refineBySwaps(cols, crossed)
  assert.equal(fixed.crossings, 0, '精修应把这对交叉换掉')
  const already = [
    ['a', 'b'],
    ['c', 'd'],
  ]
  const clean = [e('a', 'c'), e('b', 'd')]
  assert.equal(refineBySwaps(already, clean).crossings, 0, '本来就没有交叉的图不该被排坏')
})

test('planGraph 汇报的口径是**可见交叉**（真实规模下降的正是这个数）', () => {
  const ids = ['a', 'b', 'c', 'd']
  const edges = [e('a', 'd'), e('b', 'c')]
  const planned = planGraph({ ids, edges })
  assert.equal(planned.crossings, countVisibleCrossings(planned.columns, edges))
})

test('层内排序：单调不劣——初始已最优时不会被排坏', () => {
  const ids = ['a', 'b', 'c', 'd']
  const edges = [e('a', 'c'), e('b', 'd')]
  const { crossings } = orderColumns(ids, edges)
  assert.equal(crossings, 0, '本来零交叉，排完仍须零交叉（只保留最优那一版）')
})

test('层内排序：确定性——同一份数据两次规划结果逐字相同', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const edges = [e('a', 'd'), e('b', 'd'), e('c', 'e'), e('a', 'e'), e('b', 'f'), e('c', 'f')]
  const first = planGraph({ ids, edges })
  const second = planGraph({ ids, edges })
  assert.deepEqual(first.columns, second.columns)
  assert.equal(first.crossings, second.crossings)
})

test('上游链：只向"我依赖谁"扩散，绝不带上依赖它的插件（只向前，不向后）', () => {
  // d → a → b → c，另有 a → c（跨层边）与 c → e（下游，必须排除）
  const edges = [e('d', 'a'), e('a', 'b'), e('b', 'c'), e('a', 'c'), e('c', 'e')]
  const chain = upstreamClosure('c', edges)
  assert.deepEqual([...chain.nodes].sort(), ['a', 'b', 'c', 'd'], '传递依赖全部纳入，含跨层边的另一条路径')
  assert.equal(chain.nodes.has('e'), false, '下游（依赖 c 的 e）绝不能被高亮——那是"影响面"，不是依赖链')
  assert.deepEqual([...chain.edges].sort(), ['a->b', 'a->c', 'b->c', 'd->a'], '链内的边都要高亮')
  assert.equal(chain.edges.has('c->e'), false)
})

test('上游链：叶子节点只有它自己；环不会导致死循环', () => {
  const leaf = upstreamClosure('a', [e('a', 'b')])
  assert.deepEqual([...leaf.nodes], ['a'], '没有人被它依赖时，链里只有它自己')
  assert.equal(leaf.edges.size, 0)

  const cyc = upstreamClosure('x', [e('x', 'y'), e('y', 'x')])
  assert.deepEqual([...cyc.nodes].sort(), ['x', 'y'])
})

test('压暗判定：未悬停时一切都不压暗；悬停时链外节点与边被压暗', () => {
  const edges = [e('a', 'b'), e('b', 'c'), e('c', 'd')]
  const chain = upstreamClosure('c', edges)
  // 未悬停
  assert.equal(isDimmed(null, null, 'a'), false)
  assert.equal(isEdgeDimmed(null, null, edges[0] as { source: string; target: string }), false)
  // 悬停 c：a、b、c 亮着，d 暗
  assert.equal(isDimmed('c', chain, 'a'), false)
  assert.equal(isDimmed('c', chain, 'd'), true, '下游 d 必须被压暗')
  assert.equal(isEdgeDimmed('c', chain, { source: 'a', target: 'b' }), false)
  assert.equal(isEdgeDimmed('c', chain, { source: 'c', target: 'd' }), true)
})
