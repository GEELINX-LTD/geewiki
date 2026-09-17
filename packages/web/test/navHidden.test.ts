/**
 * 导航批（2026-09-16）的三条新行为，全部在纯函数层钉住：
 *
 *   ① 自定义顺序（拖动排序落库后的 `nav_order`）如何影响同一层级的排列；
 *   ② "在左侧边栏隐藏"的**继承**：父级隐藏 ⇒ 整棵子树有效隐藏；子级隐藏只影响自己；
 *   ③ 隐藏项在侧栏树（`pruneHidden`）、"N 个页面"（`countPages`）与
 *      上一篇/下一篇（`flattenPages` / `neighborsOf`）里一致地不出现。
 *
 * 为什么值得单独一批：这三件事都是"看起来对"很容易、错起来很难查的类型
 * （顺序错一位、隐藏了却还能被"下一篇"翻到），而且它们必须**只有一处实现**——
 * 侧栏、列表页、翻页三处共用这里的函数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNavTree,
  countPages,
  flattenPages,
  moveWithinSiblings,
  neighborsOf,
  pruneHidden,
  type NavNode,
  type NavOrderMap,
  type NavPage,
} from '../src/lib/navTree'

function page(slug: string, extra: { hidden?: boolean } = {}): NavPage {
  return {
    slug,
    title: slug,
    updated_at: '2026-01-01T00:00:00.000Z',
    version: 1,
    nav_hidden: extra.hidden ?? false,
  }
}

/** 同级顺序（父级 → item 列表）；顺序不进页面对象，见 `NavOrderMap` 的注释 */
function order(entries: Record<string, string[]>): NavOrderMap {
  return new Map(Object.entries(entries))
}

const slugsOf = (nodes: readonly NavNode[]): string[] => flattenPages(nodes).map((p) => p.slug)

test('自定义顺序：顺序表里的按位次在前，没记录的按段名字典序排在后面', () => {
  const tree = buildNavTree([page('b'), page('a'), page('c'), page('d')], order({ '': ['c', 'd'] }))
  assert.deepEqual(slugsOf(tree), ['c', 'd', 'a', 'b'])
})

test('顺序按父级各自生效：不同层级的列表互不影响', () => {
  const tree = buildNavTree(
    [page('g1/x'), page('g1/y'), page('g2/x'), page('g2/y')],
    order({ '': ['g2', 'g1'], g1: ['g1/y', 'g1/x'], g2: ['g2/y', 'g2/x'] }),
  )
  // `g1`/`g2` 自身没有页面（纯分组）⇒ 不进展平序列，但它们**能**被排序（item 就是分组路径）
  assert.deepEqual(slugsOf(tree), ['g2/y', 'g2/x', 'g1/y', 'g1/x'])
})

test('顺序表里的 item 可以是**没有页面的分组路径**（否则 guide/demo 这类目录永远排不了）', () => {
  const tree = buildNavTree([page('a'), page('g/x')], order({ '': ['g', 'a'] }))
  assert.deepEqual(
    tree.map((n) => n.segment),
    ['g', 'a'],
    '分组 g 排在页面 a 前面——顺序表里的 item 就是它的路径',
  )
})

test('隐藏继承：父级隐藏 ⇒ 子级（含未标隐藏的子级）**有效隐藏**', () => {
  const tree = buildNavTree([page('guides', { hidden: true }), page('guides/intro'), page('other')])
  const guides = tree.find((n) => n.segment === 'guides') as NavNode
  assert.equal(guides.hidden, true, '父级自身隐藏')
  assert.equal((guides.children[0] as NavNode).hidden, true, '子级没有自己的开关，但继承了父级的隐藏')
})

test('隐藏继承是**只读推导**：不级联写子级，取消父级隐藏后子级自动恢复', () => {
  // 同一份子页面数据：父级隐藏时不可见，父级取消隐藏后立刻可见（没有任何"恢复"逻辑）
  const child = page('guides/intro')
  const hiddenParent = buildNavTree([page('guides', { hidden: true }), child])
  assert.equal((hiddenParent[0] as NavNode).children[0]?.hidden, true)
  const shownParent = buildNavTree([page('guides'), child])
  assert.equal((shownParent[0] as NavNode).children[0]?.hidden, false)
  assert.equal(child.nav_hidden, false, '推导过程不得改写页面数据本身')
})

test('pruneHidden：父级隐藏时整棵子树都消失；只隐藏子级时父级仍在', () => {
  const pages = [page('guides'), page('guides/intro', { hidden: true }), page('guides/plugins'), page('ops')]
  const tree = buildNavTree(pages)
  const pruned = pruneHidden(tree)
  assert.deepEqual(slugsOf(pruned), ['guides', 'guides/plugins', 'ops'], '隐藏的叶子被剪掉，兄弟保留')

  const parentHidden = pruneHidden(buildNavTree([page('guides', { hidden: true }), page('guides/intro'), page('guides/plugins'), page('ops')]))
  assert.deepEqual(slugsOf(parentHidden), ['ops'], '父级隐藏 ⇒ 整棵子树都不出现')
})

test('pruneHidden：纯分组（自身无页面）不因剪枝而消失，只要还有可见的后代', () => {
  // 只有 a/b/c 而没有 a、b ⇒ a、b 是纯分组；隐藏 c 之后它们都没有可见后代，应当一起消失
  const tree = buildNavTree([page('a/b/c')])
  assert.equal(tree[0]?.segment, 'a')
  // 纯分组只存在于树里（`flattenPages` 只收有页面的节点，见 navOrder.test.ts 的同一约定）；
  // 这里同时钉住"树还在"与"序列里只有真正的页面"
  const kept = pruneHidden(buildNavTree([page('a/b/c'), page('a/b/d')]))
  assert.equal(kept[0]?.segment, 'a', '纯分组仍在树上')
  assert.equal(kept[0]?.children[0]?.segment, 'b')
  assert.deepEqual(slugsOf(kept), ['a/b/c', 'a/b/d'], '两个叶子按段名字典序')
  assert.deepEqual(pruneHidden(buildNavTree([page('a/b/c', { hidden: true })])), [])
})

test('flattenPages / neighborsOf：隐藏项（及其子树）不参与上一篇下一篇', () => {
  const pages = [page('a'), page('b', { hidden: true }), page('c')]
  const tree = buildNavTree(pages)
  assert.deepEqual(slugsOf(tree), ['a', 'c'], '隐藏的 b 不在序列里')
  const n = neighborsOf(tree, 'a')
  assert.equal(n.next?.slug, 'c', 'a 的下一篇必须跳过隐藏的 b')
  // 隐藏页自己也不该拿到"上一篇/下一篇"（它在可见序列里根本不存在）
  assert.equal(neighborsOf(tree, 'b').index, -1)
})

test('flattenPages：父级隐藏时整棵子树都不进序列', () => {
  const tree = buildNavTree([page('a'), page('g', { hidden: true }), page('g/x'), page('g/y'), page('z')])
  assert.deepEqual(slugsOf(tree), ['a', 'z'])
})

test('countPages：隐藏的不计入"N 个页面"', () => {
  const tree = buildNavTree([page('a'), page('g', { hidden: true }), page('g/x'), page('b')])
  assert.equal(countPages(tree), 2, 'a 与 b 两个（g 与 g/x 都隐藏）')
  assert.equal(countPages(pruneHidden(tree)), 2, '剪过的树上同一个数——两条路径不能给出两个答案')
})

test('moveWithinSiblings：同层重排的边界（首尾 / 越界 / 同位 / 不改原数组）', () => {
  const input = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveWithinSiblings(input, 0, 2), ['b', 'c', 'a', 'd'], '把第一个拖到第三位')
  assert.deepEqual(moveWithinSiblings(input, 3, 0), ['d', 'a', 'b', 'c'], '把最后一个拖到最前')
  assert.deepEqual(moveWithinSiblings(input, 1, 1), input, '同位 ⇒ 原样')
  assert.deepEqual(moveWithinSiblings(input, 9, 0), input, '越界的 from ⇒ 原样')
  assert.deepEqual(moveWithinSiblings(input, 0, 99), ['b', 'c', 'd', 'a'], 'to 超界被夹到末尾')
  assert.deepEqual(input, ['a', 'b', 'c', 'd'], '不得原地修改入参（调用方会拿它当"当前顺序"）')
})

test('顺序与隐藏能同时生效，且互不干扰', () => {
  const tree = buildNavTree(
    [page('x'), page('h', { hidden: true }), page('y')],
    order({ '': ['h', 'y', 'x'] }),
  )
  assert.deepEqual(slugsOf(tree), ['y', 'x'], '按顺序表排（h 排在最前但被隐藏，剪掉后不占位）')
  assert.deepEqual(slugsOf(pruneHidden(tree)), ['y', 'x'])
})
