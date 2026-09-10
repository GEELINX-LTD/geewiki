/**
 * 面包屑单测（`lib/navTree.ts` 的 `buildBreadcrumb` / `breadcrumbTokens` / `hasSeparatorBefore`）。
 *
 * 为什么需要这一批：缺陷现场是 `知识库 › › 指南 撰写指南`——**第一个间隙两个分隔符、末项之前一个都没有**。
 * 根因不是"少写一个分隔符"，而是**同一件事有两处负责**（根项 `<li>` 尾部硬编码一个 `ChevronRight`，
 * 每个非末项又在开头再画一个）。所以这里除了钉住"项数/顺序/可点性"，还钉两件容易复发的事：
 *
 * 1. **token 序列必须严格交替**（`label (› label)*`）。
 *    ⚠️ 注意：`项数 = 分隔符数 + 1` 这个"不变量"**在缺陷版本里同样成立**（当时分隔符数也等于项数-1），
 *    所以只断言数量抓不到本缺陷——必须断言**位置**（不能出现相邻两个分隔符）。
 * 2. **组件里画分隔符的地方只能有一处**（源码级守卫，见文件末尾）。这是唯一能防住
 *    "再加一个 ChevronRight" 的断言形式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BREADCRUMB_ROOT_HREF,
  BREADCRUMB_ROOT_LABEL,
  BREADCRUMB_SEP,
  breadcrumbTokens,
  buildBreadcrumb,
  hasSeparatorBefore,
  intermediateCrumbCount,
} from '../src/lib/navTree'

/** 朴素 href 构造器：单测不 import 组件模块，只注入等价实现 */
const hrefOf = (slug: string): string => `#/wiki/${encodeURIComponent(slug)}`

/** 从 slug 列表造 `pagesBySlug`（只用到 title） */
function pageMap(entries: Array<[string, string]>): Map<string, { title: string }> {
  return new Map(entries.map(([slug, title]) => [slug, { title }]))
}

/* ------------------------- 项数与顺序 ------------------------- */

test('面包屑：顶层页面 ⇒ 知识库 + 当前页（恰好 1 个分隔符）', () => {
  const crumbs = buildBreadcrumb('standalone', '独立页面', pageMap([['standalone', '独立页面']]), hrefOf)

  assert.equal(crumbs.length, 2)
  assert.deepEqual(
    crumbs.map((c) => c.label),
    ['知识库', '独立页面'],
  )
  assert.equal(crumbs[0]?.href, BREADCRUMB_ROOT_HREF, '根项应链到列表页')
  assert.equal(crumbs[1]?.isLast, true)
  assert.equal(crumbs[1]?.href, null, '当前页不可点')

  const tokens = breadcrumbTokens(crumbs)
  assert.equal(tokens.filter((t) => t === BREADCRUMB_SEP).length, 1, '顶层页恰好 1 个分隔符')
  assert.equal(tokens.length, crumbs.length * 2 - 1, '项数 = 分隔符数 + 1')
})

test('面包屑：中间层是页面 ⇒ 三项，且中间项是可点链接', () => {
  const crumbs = buildBreadcrumb(
    'guides/authoring',
    '撰写指南',
    pageMap([
      ['guides', '指南'],
      ['guides/authoring', '撰写指南'],
    ]),
    hrefOf,
  )

  assert.equal(crumbs.length, 3, '知识库 / 指南 / 撰写指南')
  assert.deepEqual(
    crumbs.map((c) => c.label),
    ['知识库', '指南', '撰写指南'],
  )
  assert.equal(crumbs[1]?.href, hrefOf('guides'), '中间层有页面 ⇒ 可点')
  assert.equal(crumbs[1]?.hasPage, true)
  assert.equal(crumbs[2]?.href, null, '当前页不可点')
})

test('面包屑：中间层是纯分组 ⇒ 不可点（不给"到别处"的假链接）', () => {
  const crumbs = buildBreadcrumb(
    'group-only/child',
    '分组子页',
    pageMap([['group-only/child', '分组子页']]),
    hrefOf,
  )

  assert.equal(crumbs.length, 3)
  assert.equal(crumbs[1]?.path, 'group-only')
  assert.equal(crumbs[1]?.label, 'group-only', '纯分组没有页面标题，退回路径片段')
  assert.equal(crumbs[1]?.hasPage, false)
  assert.equal(crumbs[1]?.href, null, '纯分组不可点')
})

test('面包屑：深层 a/b/c/d ⇒ 项数与顺序正确（根 + 3 层中间 + 当前页）', () => {
  const crumbs = buildBreadcrumb(
    'deep/a/b/c',
    '深层页',
    pageMap([['deep/a/b/c', '深层页']]),
    hrefOf,
  )

  assert.equal(crumbs.length, 5)
  assert.deepEqual(
    crumbs.map((c) => c.label),
    ['知识库', 'deep', 'a', 'b', '深层页'],
  )
  assert.deepEqual(
    crumbs.map((c) => c.path),
    ['', 'deep', 'deep/a', 'deep/a/b', 'deep/a/b/c'],
  )
  assert.equal(crumbs[4]?.isLast, true)
  assert.equal(crumbs.slice(0, 4).every((c) => c.isLast === false), true, '只有末项 isLast')
})

test('面包屑：新建页（slug 为空）⇒ 根 + 当前页，末项不消失', () => {
  const crumbs = buildBreadcrumb('', '未命名页面', pageMap([]), hrefOf)

  assert.equal(crumbs.length, 2)
  assert.deepEqual(
    crumbs.map((c) => c.label),
    ['知识库', '未命名页面'],
  )
  assert.equal(crumbs[1]?.isLast, true)
})

test('面包屑：末项用传入的 title（详情页最新标题），中间项用清单标题', () => {
  const crumbs = buildBreadcrumb(
    'guides/authoring',
    '刚刚改过的标题',
    pageMap([
      ['guides', '指南'],
      ['guides/authoring', '清单里的旧标题'],
    ]),
    hrefOf,
  )

  assert.equal(crumbs[1]?.label, '指南', '中间项取清单标题')
  assert.equal(crumbs[2]?.label, '刚刚改过的标题', '末项取传入 title')
})

/* --------------------- 分隔符：交替性（本批核心） --------------------- */

test('分隔符：token 序列严格交替，不出现相邻的两个分隔符', () => {
  const cases: Array<[string, Array<[string, string]>]> = [
    ['standalone', [['standalone', '独立页面']]],
    [
      'guides/authoring',
      [
        ['guides', '指南'],
        ['guides/authoring', '撰写指南'],
      ],
    ],
    ['group-only/child', [['group-only/child', '分组子页']]],
    ['deep/a/b/c', [['deep/a/b/c', '深层页']]],
  ]

  for (const [slug, pages] of cases) {
    const crumbs = buildBreadcrumb(slug, '末页', pageMap(pages), hrefOf)
    const tokens = breadcrumbTokens(crumbs)

    // ① 形状：必须以 label 开头、以 label 结尾，长度恰好 2N-1
    assert.equal(tokens.length, crumbs.length * 2 - 1, `${slug}: 长度应为 2N-1`)
    assert.notEqual(tokens[0], BREADCRUMB_SEP, `${slug}: 不得以分隔符开头`)
    assert.notEqual(tokens[tokens.length - 1], BREADCRUMB_SEP, `${slug}: 不得以分隔符结尾`)

    // ② 交替：奇数位（0-based 偶数位）是 label，其余是分隔符
    tokens.forEach((tok, idx) => {
      const shouldBeSep = idx % 2 === 1
      assert.equal(
        tok === BREADCRUMB_SEP,
        shouldBeSep,
        `${slug}: 第 ${idx} 个 token 应为${shouldBeSep ? '分隔符' : '标签'}，实际为 ${JSON.stringify(tok)}`,
      )
    })

    // ③ 不存在相邻两个分隔符（这正是缺陷 `知识库 › › 指南` 的形状）
    for (let i = 1; i < tokens.length; i += 1) {
      assert.ok(
        !(tokens[i] === BREADCRUMB_SEP && tokens[i - 1] === BREADCRUMB_SEP),
        `${slug}: 第 ${i - 1}/${i} 位出现相邻分隔符：${JSON.stringify(tokens)}`,
      )
    }
  }
})

test('分隔符：规则是"除首项外每项之前恰好一个"', () => {
  assert.equal(hasSeparatorBefore(0), false, '首项之前没有分隔符')
  assert.equal(hasSeparatorBefore(1), true)
  assert.equal(hasSeparatorBefore(2), true)
  assert.equal(hasSeparatorBefore(9), true)

  // 由该规则推出的分隔符总数 = 项数 - 1
  for (const n of [2, 3, 5, 8]) {
    const count = Array.from({ length: n }, (_, i) => i).filter(hasSeparatorBefore).length
    assert.equal(count, n - 1, `${n} 项应有 ${n - 1} 个分隔符`)
  }
})

test('分隔符：缺陷版本的不变量在缺陷下也成立（故必须断言位置）', () => {
  /*
   * 这是本批的"为什么不能只数数量"的证据，钉在测试里防止后人简化断言。
   * 缺陷形态（两个来源）在 3 项时也给出 2 个分隔符 ⇒ 数量断言会通过，
   * 但 token 形状是 `知识库 › › 指南 撰写指南`（相邻分隔符 + 末项缺分隔）。
   */
  const buggy = ['知识库', BREADCRUMB_SEP, BREADCRUMB_SEP, '指南', '撰写指南']
  const labels = buggy.filter((t) => t !== BREADCRUMB_SEP).length
  const seps = buggy.filter((t) => t === BREADCRUMB_SEP).length
  assert.equal(labels, seps + 1, '缺陷形态同样满足"项数 = 分隔符数 + 1"')

  const fixed = ['知识库', BREADCRUMB_SEP, '指南', BREADCRUMB_SEP, '撰写指南']
  assert.notDeepEqual(buggy, fixed, '两者不同：只有位置断言能区分')
  const firstSepIdx = buggy.indexOf(BREADCRUMB_SEP)
  assert.equal(buggy[firstSepIdx + 1], BREADCRUMB_SEP, '缺陷特征是相邻分隔符')
})

/* --------------------------- 窄屏省略计数 --------------------------- */

test('窄屏省略计数：中间层数量 = 总数 - 根项 - 当前页', () => {
  const two = buildBreadcrumb('standalone', '独立页面', pageMap([['standalone', 'x']]), hrefOf)
  assert.equal(intermediateCrumbCount(two), 0, '顶层页没有中间层 ⇒ 不显示省略提示')

  const three = buildBreadcrumb(
    'guides/authoring',
    '撰写指南',
    pageMap([
      ['guides', '指南'],
      ['guides/authoring', '撰写指南'],
    ]),
    hrefOf,
  )
  assert.equal(intermediateCrumbCount(three), 1)

  const five = buildBreadcrumb('deep/a/b/c', '深层页', pageMap([['deep/a/b/c', '深层页']]), hrefOf)
  assert.equal(intermediateCrumbCount(five), 3, '知识库 + deep/a/b + 当前页 ⇒ 3 级中间层')
})

/* --------------------- 源码级守卫：分隔符只有一个渲染点 --------------------- */

test('源码守卫：Breadcrumb 组件里画分隔符的地方只有一处', () => {
  /*
   * 为什么需要源码级断言：单测无法覆盖"JSX 里多画了一个图标"。
   * 上一版正是根项 `<li>` 尾部硬编码一个 ChevronRight、每个非末项又画一个 ⇒ 重复分隔符。
   * 这条守卫直接数组件体内的 `<ChevronRight` 出现次数，**多一处就红**。
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'src', 'pages', 'WikiPage.tsx'), 'utf8')

  const start = src.indexOf('function Breadcrumb(')
  assert.ok(start > 0, '应能定位到 Breadcrumb 组件（若改名请同步更新本守卫）')
  const end = src.indexOf('\nfunction ', start + 1)
  const body = src.slice(start, end > 0 ? end : undefined)

  const chevrons = body.match(/<ChevronRight/g) ?? []
  assert.equal(
    chevrons.length,
    1,
    `Breadcrumb 组件里只应有 1 处分隔符渲染（实际 ${chevrons.length} 处）——` +
      '多出来的那一处会与 hasSeparatorBefore 叠加成重复的 ›',
  )

  // 且那唯一一处必须由 hasSeparatorBefore 把关（不是无条件渲染）
  assert.match(body, /hasSeparatorBefore\(i\)/, '分隔符必须由 hasSeparatorBefore 规则把关')

  // 根项不得再硬编码分隔符：根项现在由 buildBreadcrumb 产出，组件里不应出现写死的知识库链接
  assert.doesNotMatch(body, /href="#\/wiki\/list"/, '根项应由 buildBreadcrumb 产出，组件里不得硬编码')
})
