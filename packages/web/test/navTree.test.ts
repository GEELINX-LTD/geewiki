/**
 * `lib/navTree.ts` 的单测。
 *
 * 覆盖那些"不启动浏览器就会写错"的边界：乱序输入、中间层无页面（只有 a/b/c）、
 * `guide` 自身是页面（类目落地页）、空列表、重复 slug、深层祖先链。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestorPaths,
  buildNavTree,
  compareSegment,
  containsSlug,
  countPages,
  type NavNode,
  type NavPage,
} from '../src/lib/navTree'

function pg(slug: string, title = slug, updated = '2026-01-01T00:00:00.000Z'): NavPage {
  return { slug, title, updated_at: updated, version: 1 }
}

/**
 * 把树压成易断言的形状：`分组(组)/子…`。
 *
 * 注意 `(组)` 只标在**节点自身的标签**上，不进前缀——否则子节点读起来像 `api(组)/rest`，
 * 会掩盖"是子节点的名字还是父节点的标记"这件事（本文件第一版正是这么写错的）。
 */
function shape(nodes: readonly NavNode[]): string[] {
  const out: string[] = []
  const walk = (ns: readonly NavNode[], prefix: string): void => {
    for (const n of ns) {
      const label = `${n.segment}${n.page !== null ? '' : '(组)'}`
      out.push(`${prefix}${label}`)
      walk(n.children, `${prefix}${n.segment}/`)
    }
  }
  walk(nodes, '')
  return out
}

test('buildNavTree：扁平页面 → 同一层的叶子，无分组', () => {
  const tree = buildNavTree([pg('b'), pg('a')])
  assert.deepEqual(shape(tree), ['a', 'b']) // 字典序，而不是输入顺序
})

test('buildNavTree：乱序输入也必须得到同一棵树（确定性）', () => {
  const input = [pg('guide/setup'), pg('guide/intro'), pg('api/rest'), pg('intro')]
  const a = buildNavTree(input)
  const b = buildNavTree([...input].reverse())
  assert.deepEqual(shape(a), shape(b))
  assert.deepEqual(shape(a), ['api(组)', 'api/rest', 'guide(组)', 'guide/intro', 'guide/setup', 'intro'])
})

test('buildNavTree：只有 a/b/c 而没有 a、b 时，中间层是"纯分组"（page 为 null）', () => {
  const tree = buildNavTree([pg('a/b/c')])
  assert.deepEqual(shape(tree), ['a(组)', 'a/b(组)', 'a/b/c'])
  const a = tree[0] as NavNode
  assert.equal(a.page, null)
  assert.equal(a.children[0]?.page, null)
  assert.equal(a.children[0]?.children[0]?.page?.slug, 'a/b/c')
})

test('buildNavTree：guide 自身是页面时充当类目落地页（page !== null 且有子节点）', () => {
  const tree = buildNavTree([pg('guide'), pg('guide/intro')])
  assert.deepEqual(shape(tree), ['guide', 'guide/intro'])
  const g = tree[0] as NavNode
  assert.equal(g.page?.slug, 'guide', '分组自身应带页面（可点击打开）')
  assert.equal(g.children.length, 1)
})

test('buildNavTree：空列表 → 空树', () => {
  assert.deepEqual(buildNavTree([]), [])
})

test('buildNavTree：重复 slug 保留第一个（防御性；后端 slug 唯一）', () => {
  const tree = buildNavTree([pg('dup', '第一个'), pg('dup', '第二个')])
  assert.equal(tree.length, 1)
  assert.equal(tree[0]?.page?.title, '第一个')
})

test('buildNavTree：空段被忽略（不会造出空分组）', () => {
  const tree = buildNavTree([pg('a//b')])
  assert.deepEqual(shape(tree), ['a(组)', 'a/b'])
})

test('buildNavTree：排序是字典序且稳定（同级内不会因输入顺序变化）', () => {
  const tree = buildNavTree([pg('z'), pg('a'), pg('m')])
  assert.deepEqual(
    tree.map((n) => n.segment),
    ['a', 'm', 'z'],
  )
})

test('compareSegment：数字按数值序（release-2 在 release-10 之前）', () => {
  assert.ok(compareSegment('release-2', 'release-10') < 0, 'numeric: true 应让 2 < 10')
})

test('ancestorPaths：从根到叶的累积前缀（含自身）', () => {
  assert.deepEqual(ancestorPaths('guide/setup/install'), ['guide', 'guide/setup', 'guide/setup/install'])
  assert.deepEqual(ancestorPaths('flat'), ['flat'])
  assert.deepEqual(ancestorPaths(''), [])
})

test('containsSlug：自身与后代都算在内，兄弟不算', () => {
  const tree = buildNavTree([pg('guide'), pg('guide/intro'), pg('other')])
  const guide = tree.find((n) => n.segment === 'guide') as NavNode
  assert.equal(containsSlug(guide, 'guide'), true)
  assert.equal(containsSlug(guide, 'guide/intro'), true)
  assert.equal(containsSlug(guide, 'guideX'), false, '前缀相同但不是子路径')
  assert.equal(containsSlug(guide, 'other'), false)
})

test('countPages：统计有页面的节点（纯分组不计）', () => {
  const tree = buildNavTree([pg('a/b/c'), pg('a/b'), pg('x')])
  assert.equal(countPages(tree), 3)
})
