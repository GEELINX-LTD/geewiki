/**
 * `flattenPages` / `neighborsOf` 的单测：**上一篇/下一篇必须按层级树顺序**。
 *
 * 为什么值得单独一批测试：这两个函数修的是一个用户可见的错误顺序——沿用列表页的
 * `updated_at DESC` 时，"下一篇"会从「指南」组跳到「运维手册」组，与侧边栏层次脱节。
 * 顺序这种东西"看起来对"很容易（随便造两条数据都能过），故这里刻意覆盖：
 * 乱序输入、含纯分组、深层 `a/b/c`、只有分组没有页面、单页、空列表、以及"分组必须被跳过"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNavTree, flattenPages, neighborsOf, type NavPage } from '../src/lib/navTree'

function page(slug: string, title = slug): NavPage {
  return { slug, title, updated_at: '2026-01-01T00:00:00.000Z', version: 1 }
}

/** 与用户实测场景同构：guides 组 + operations 组，且 guides 自身也是一个页面 */
const scenario = [
  page('guides', '指南'),
  page('guides/authoring', '撰写指南'),
  page('guides/plugins', '插件开发'),
  page('operations', '运维手册'),
  page('operations/backup', '备份与恢复'),
]

test('flattenPages：按展示顺序展平（先节点自身，再其子节点）', () => {
  const flat = flattenPages(buildNavTree(scenario)).map((p) => p.slug)
  assert.deepEqual(flat, [
    'guides',
    'guides/authoring',
    'guides/plugins',
    'operations',
    'operations/backup',
  ])
})

test('flattenPages：输入乱序也得到同一顺序（顺序由树决定，与入参顺序无关）', () => {
  const shuffled = [scenario[4], scenario[1], scenario[3], scenario[0], scenario[2]] as NavPage[]
  assert.deepEqual(
    flattenPages(buildNavTree(shuffled)).map((p) => p.slug),
    flattenPages(buildNavTree(scenario)).map((p) => p.slug),
  )
})

test('flattenPages：纯分组（没有对应页面）被跳过，不占翻页的一步', () => {
  // 只有 a/b/c，没有 a、也没有 a/b ⇒ 中间两层都是纯分组
  const flat = flattenPages(buildNavTree([page('a/b/c', '深层页')])).map((p) => p.slug)
  assert.deepEqual(flat, ['a/b/c'], '分组 a、a/b 不该出现在序列里')
})

test('neighborsOf：相邻项是树中的前后项（与侧边栏一致）', () => {
  const tree = buildNavTree(scenario)
  // 「撰写指南」的前后：前=指南（父分组的落地页），后=插件开发（同组下一个）
  const mid = neighborsOf(tree, 'guides/authoring')
  assert.equal(mid.prev?.slug, 'guides', '上一篇应是同组的前一项，而不是"最近修改的其它页"')
  assert.equal(mid.next?.slug, 'guides/plugins', '下一篇应是同组的下一个，不该跳到「运维手册」')
  assert.equal(mid.index, 1)
})

test('neighborsOf：跨越分组时按深度优先顺序（组末页 → 下一组首页）', () => {
  const tree = buildNavTree(scenario)
  const last = neighborsOf(tree, 'guides/plugins')
  assert.equal(last.prev?.slug, 'guides/authoring')
  assert.equal(last.next?.slug, 'operations', '组末的下一个是下一组的落地页')
})

test('neighborsOf：第一项无上一篇、最后一项无下一篇', () => {
  const tree = buildNavTree(scenario)
  const first = neighborsOf(tree, 'guides')
  assert.equal(first.prev, undefined, '第一项不应有上一篇')
  assert.equal(first.next?.slug, 'guides/authoring')
  const last = neighborsOf(tree, 'operations/backup')
  assert.equal(last.next, undefined, '最后一项不应有下一篇')
  assert.equal(last.prev?.slug, 'operations')
})

test('neighborsOf：单页时两个邻居都不存在（UI 据此不渲染翻页条）', () => {
  const only = neighborsOf(buildNavTree([page('solo', '唯一一页')]), 'solo')
  assert.equal(only.prev, undefined)
  assert.equal(only.next, undefined)
  assert.equal(only.index, 0)
})

test('neighborsOf：空树 / 找不到该 slug 时返回 index=-1 且无邻居', () => {
  assert.deepEqual(neighborsOf(buildNavTree([]), 'whatever'), {
    prev: undefined,
    next: undefined,
    index: -1,
  })
  assert.deepEqual(neighborsOf(buildNavTree(scenario), 'nope/nope'), {
    prev: undefined,
    next: undefined,
    index: -1,
  })
})

test('neighborsOf：纯分组场景下，相邻项直接连到可打开的页面', () => {
  // a/b/c 与 a/b/d 都存在、但 a、a/b 没有页面 ⇒ 两页互为邻居，中间不夹分组
  const tree = buildNavTree([page('a/b/c', 'C'), page('a/b/d', 'D')])
  const c = neighborsOf(tree, 'a/b/c')
  assert.equal(c.prev, undefined, '前面不该是分组 a 或 a/b')
  assert.equal(c.next?.slug, 'a/b/d')
  const d = neighborsOf(tree, 'a/b/d')
  assert.equal(d.prev?.slug, 'a/b/c')
  assert.equal(d.next, undefined)
})

test('flattenPages：页面的 title 被原样带出（翻页条要显示人读标题）', () => {
  const flat = flattenPages(buildNavTree(scenario))
  assert.equal(flat.find((p) => p.slug === 'guides/authoring')?.title, '撰写指南')
})

test('顺序由层级决定，**与 updated_at 无关**（旧实现按"最近修改优先"排，正是缺陷根因）', () => {
  /*
   * 刻意把 `operations/backup` 设成"最近修改"，再让 `guides/authoring` 成为最旧的页。
   * 旧实现（列表页的 `ORDER BY updated_at DESC`）会把 backup 排到最前，于是
   * 「撰写指南」的"下一篇"会变成 backup（跨组跳转）——这就是用户截图里看到的症状。
   * 树顺序下两者互不相邻，且结果不随 updated_at 变化。
   */
  const biased: NavPage[] = [
    { slug: 'guides', title: '指南', updated_at: '2026-01-02T00:00:00.000Z', version: 1 },
    { slug: 'guides/authoring', title: '撰写指南', updated_at: '2026-01-01T00:00:00.000Z', version: 1 },
    { slug: 'guides/plugins', title: '插件开发', updated_at: '2026-01-03T00:00:00.000Z', version: 1 },
    { slug: 'operations', title: '运维手册', updated_at: '2026-01-04T00:00:00.000Z', version: 1 },
    { slug: 'operations/backup', title: '备份与恢复', updated_at: '2026-01-09T00:00:00.000Z', version: 1 },
  ]
  const tree = buildNavTree(biased)
  const mid = neighborsOf(tree, 'guides/authoring')
  assert.equal(mid.prev?.slug, 'guides')
  assert.equal(mid.next?.slug, 'guides/plugins', '不得因为 backup 最近修改就把它当"下一篇"')
  assert.deepEqual(
    flattenPages(tree).map((p) => p.slug),
    ['guides', 'guides/authoring', 'guides/plugins', 'operations', 'operations/backup'],
    '整体顺序应与 updated_at 无关',
  )
})

test('红-绿：把"先自身再子节点"改成"先子节点再自身"会让顺序测试变红（判别力自检）', () => {
  /*
   * 这条不测产品代码，而是**证明上面的顺序断言不是空转**：手工构造"子节点优先"的展平结果，
   * 断言它与 `flattenPages` 的输出**不同**。若哪天有人把实现改成子节点优先而测试仍全绿，
   * 说明断言写错了——这里把这个前提显式钉住。
   */
  const tree = buildNavTree(scenario)
  const actual = flattenPages(tree).map((p) => p.slug)
  const childFirst: string[] = []
  const walkChildFirst = (nodes: ReturnType<typeof buildNavTree>): void => {
    for (const n of nodes) {
      walkChildFirst(n.children)
      if (n.page !== null) childFirst.push(n.page.slug)
    }
  }
  walkChildFirst(tree)
  assert.notDeepEqual(actual, childFirst, '两种遍历顺序必须可区分，否则顺序断言是空转的')
})
