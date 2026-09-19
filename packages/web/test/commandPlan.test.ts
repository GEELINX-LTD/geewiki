/**
 * `lib/commandPlan.ts` 的单测。
 *
 * 覆盖那些"不写测试就一定会写错"的地方：
 * - 模糊匹配的**不命中**必须返回 `null`（返回 0 会被当成"命中但最差"，于是全量结果都会冒出来）；
 * - 排序必须**确定**——键盘导航走的是索引，同分项在不同渲染里换位置会让"按两下下键"点到不同的东西；
 * - 「最近访问」里**已删除的页面要被丢弃**（否则出现点了打不开的死项）；
 * - `moveIndex` 的首尾环绕与"未选中时按下键"的惯例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIMIT_PER_GROUP,
  RECENT_LIMIT,
  buildPaletteGroups,
  flattenGroups,
  fuzzyScore,
  moveIndex,
  pageEntryId,
  pushRecent,
  scoreEntry,
  visitedSlugFromSub,
  type PaletteEntry,
} from '../src/lib/commandPlan'
import { HOME_SLUG } from '../src/lib/wikiRoute'

/* ------------------------------ 模糊匹配 ------------------------------ */

test('fuzzyScore：空查询返回 0（而不是 null）', () => {
  assert.equal(fuzzyScore('', '任意文本'), 0)
  assert.equal(fuzzyScore('   ', '任意文本'), 0)
})

test('fuzzyScore：子序列命中，非子序列返回 null', () => {
  assert.notEqual(fuzzyScore('gi', 'guide'), null)
  assert.notEqual(fuzzyScore('gd', 'guide'), null) // 跳字符仍算命中（g…d）
  assert.equal(fuzzyScore('xyz', 'guide'), null)
  // 关键：不命中必须是 null 而不是 0
  assert.equal(fuzzyScore('z', 'guide'), null)
})

test('fuzzyScore：大小写不敏感', () => {
  assert.notEqual(fuzzyScore('GUIDE', 'guide'), null)
  assert.notEqual(fuzzyScore('guide', 'GUIDE'), null)
  assert.equal(fuzzyScore('GUIDE', 'guide'), fuzzyScore('guide', 'guide'))
})

test('fuzzyScore：中文可命中（按码点遍历，不会拆半）', () => {
  assert.notEqual(fuzzyScore('检索', '全文检索'), null)
  assert.notEqual(fuzzyScore('全文', '全文检索'), null)
  assert.equal(fuzzyScore('不存在', '全文检索'), null)
})

test('fuzzyScore：连续命中高于跳字符命中；段首/子串命中更高', () => {
  const consecutive = fuzzyScore('gui', 'guide')
  const gapped = fuzzyScore('gde', 'guide')
  assert.notEqual(consecutive, null)
  assert.notEqual(gapped, null)
  assert.ok(
    (consecutive as number) > (gapped as number),
    `连续命中应更高：consecutive=${consecutive} gapped=${gapped}`,
  )

  // 子串命中拿额外 +50
  const substring = fuzzyScore('guide', 'guide/intro')
  const scattered = fuzzyScore('guide', 'g-u-i-d-e')
  assert.ok(
    (substring as number) > (scattered as number),
    `子串命中应高于散落命中：${substring} vs ${scattered}`,
  )
})

test('fuzzyScore：段首命中得到加成（gi 更应命中 guidex/intro 的段首）', () => {
  const atBoundary = fuzzyScore('i', 'x/i') // i 在段首
  const midWord = fuzzyScore('i', 'xix') // i 在词中
  assert.ok(
    (atBoundary as number) > (midWord as number),
    `段首应更高：${atBoundary} vs ${midWord}`,
  )
})

/* ------------------------------ 条目打分 ------------------------------ */

const entry = (over: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id: over.id ?? 'page:a',
  group: over.group ?? 'page',
  label: over.label ?? '标题',
  ...over,
})

test('scoreEntry：label 命中优先于 hint 命中（hint 有惩罚）', () => {
  const byLabel = entry({ label: 'guide', hint: 'zzz' })
  const byHint = entry({ label: 'zzz', hint: 'guide' })
  const a = scoreEntry('guide', byLabel)
  const b = scoreEntry('guide', byHint)
  assert.notEqual(a, null)
  assert.notEqual(b, null)
  assert.ok((a as number) > (b as number), `label 命中应更高：${a} vs ${b}`)
})

test('scoreEntry：keywords 也参与匹配，都不命中返回 null', () => {
  const withKeywords = entry({ label: '新建页面', keywords: 'create new page' })
  assert.notEqual(scoreEntry('create', withKeywords), null)
  assert.equal(scoreEntry('zzzz', withKeywords), null)
})

/* ------------------------------ 分组构建 ------------------------------ */

const PAGES: PaletteEntry[] = [
  { id: pageEntryId('guide/intro'), group: 'page', label: '入门指南', hint: 'guide/intro' },
  { id: pageEntryId('guide/setup'), group: 'page', label: '安装配置', hint: 'guide/setup' },
  { id: pageEntryId('standalone'), group: 'page', label: '独立页面', hint: 'standalone' },
]

const ACTIONS: PaletteEntry[] = [
  { id: 'action:new', group: 'action', label: '新建页面', keywords: 'create new' },
  { id: 'action:plugins', group: 'action', label: '打开插件管理' },
]

const ALL = [...PAGES, ...ACTIONS]

test('buildPaletteGroups：空查询只给「最近访问 + 操作」，不铺全量页面', () => {
  const groups = buildPaletteGroups({ query: '', entries: ALL, recentSlugs: ['standalone'] })
  assert.deepEqual(
    groups.map((g) => g.id),
    ['recent', 'action'],
    '空查询下不应出现 page 分组——刚打开就把所有页面倒出来既慢又无用',
  )
  const recent = groups.find((g) => g.id === 'recent')
  assert.deepEqual(recent?.items.map((i) => i.id), [pageEntryId('standalone')])
  const action = groups.find((g) => g.id === 'action')
  assert.deepEqual(action?.items.map((i) => i.id), ['action:new', 'action:plugins'], '操作保持给定顺序')
})

test('buildPaletteGroups：空查询且无最近访问时，至少还有操作（不空白）', () => {
  const groups = buildPaletteGroups({ query: '   ', entries: ALL, recentSlugs: [] })
  assert.deepEqual(groups.map((g) => g.id), ['action'])
  assert.ok(flattenGroups(groups).length > 0, '面板不应为空')
})

test('buildPaletteGroups：最近访问里已被删除的页面会被丢弃', () => {
  const groups = buildPaletteGroups({
    query: '',
    entries: ALL,
    recentSlugs: ['已被删除/的页面', 'standalone'],
  })
  const recent = groups.find((g) => g.id === 'recent')
  assert.deepEqual(
    recent?.items.map((i) => i.id),
    [pageEntryId('standalone')],
    '死链不能出现在最近访问里',
  )
})

test('buildPaletteGroups：最近访问去重且保持"越靠前越新"', () => {
  const groups = buildPaletteGroups({
    query: '',
    entries: ALL,
    recentSlugs: ['guide/setup', 'standalone', 'guide/setup'],
  })
  const recent = groups.find((g) => g.id === 'recent')
  assert.deepEqual(recent?.items.map((i) => i.id), [
    pageEntryId('guide/setup'),
    pageEntryId('standalone'),
  ])
})

test('buildPaletteGroups：非空查询给「页面 + 操作」，且不再单列最近访问（避免同一页面出现两次）', () => {
  const groups = buildPaletteGroups({
    query: 'guide',
    entries: ALL,
    recentSlugs: ['guide/intro'],
  })
  assert.deepEqual(groups.map((g) => g.id), ['page', 'action'].filter((id) => id !== 'action'))
  const pageIds = flattenGroups(groups).map((i) => i.id)
  assert.equal(
    pageIds.filter((id) => id === pageEntryId('guide/intro')).length,
    1,
    '同一页面不得重复出现',
  )
})

test('buildPaletteGroups：查询命中中文标题', () => {
  const groups = buildPaletteGroups({ query: '安装', entries: ALL, recentSlugs: [] })
  assert.deepEqual(flattenGroups(groups).map((i) => i.id), [pageEntryId('guide/setup')])
})

test('buildPaletteGroups：无任何命中时返回空数组（组件据此显示空态）', () => {
  const groups = buildPaletteGroups({ query: 'zzzzz', entries: ALL, recentSlugs: [] })
  assert.deepEqual(groups, [])
})

test('buildPaletteGroups：分组内条目数受 limit 限制', () => {
  const many: PaletteEntry[] = Array.from({ length: 20 }, (_, i) => ({
    id: pageEntryId(`p${i}`),
    group: 'page',
    label: `页面 ${i}`,
  }))
  const groups = buildPaletteGroups({ query: '页面', entries: many, recentSlugs: [], limitPerGroup: 3 })
  assert.equal(groups.find((g) => g.id === 'page')?.items.length, 3)
  assert.ok(DEFAULT_LIMIT_PER_GROUP > 3)
})

test('buildPaletteGroups：同分项按文案稳定排序（键盘导航依赖顺序确定）', () => {
  // 三条 label 对查询 'ab' 的打分完全相同 → 只能靠次级排序决定
  const tie: PaletteEntry[] = [
    { id: pageEntryId('x1'), group: 'page', label: 'ab 丙' },
    { id: pageEntryId('x2'), group: 'page', label: 'ab 甲' },
    { id: pageEntryId('x3'), group: 'page', label: 'ab 乙' },
  ]
  const first = buildPaletteGroups({ query: 'ab', entries: tie, recentSlugs: [] })
  const second = buildPaletteGroups({ query: 'ab', entries: [...tie].reverse(), recentSlugs: [] })
  assert.deepEqual(
    first.find((g) => g.id === 'page')?.items.map((i) => i.id),
    second.find((g) => g.id === 'page')?.items.map((i) => i.id),
    '入参顺序不同不应改变输出顺序',
  )
})

/* ------------------------------ 索引移动 ------------------------------ */

test('moveIndex：环绕、未选中时的惯例、空列表', () => {
  assert.equal(moveIndex(-1, 1, 3), 0, '未选中时按下键 → 第一项')
  assert.equal(moveIndex(-1, -1, 3), 2, '未选中时按上键 → 最后一项')
  assert.equal(moveIndex(0, 1, 3), 1)
  assert.equal(moveIndex(2, 1, 3), 0, '向下越界应回到开头')
  assert.equal(moveIndex(0, -1, 3), 2, '向上越界应回到末尾')
  assert.equal(moveIndex(0, 1, 0), -1, '空列表返回 -1（没有可选项）')
})

/* ------------------------------ 路由 → 访问记录 ------------------------------ */

test('visitedSlugFromSub：详情页与主页算"页面访问"，其余都不算', () => {
  assert.equal(visitedSlugFromSub('guide/intro', HOME_SLUG), 'guide/intro')
  assert.equal(visitedSlugFromSub('standalone', HOME_SLUG), 'standalone')
  /*
   * 空子路径 = 主页（`parseWikiRoute` 的 `kind: 'home'`），它**是一篇文章**：
   * 记成当前主页的 slug，"最近访问"里才会出现用户最常到的那个页面。
   * （这条断言此前写的是「列表页不算」并期望 null —— 那是"空路由=列表"时代的语义。）
   */
  assert.equal(visitedSlugFromSub('', HOME_SLUG), HOME_SLUG, '主页算一次页面访问')
  assert.equal(visitedSlugFromSub('list', HOME_SLUG), null, '列表页不算')
  assert.equal(visitedSlugFromSub('new', HOME_SLUG), null, '新建页不算')
  assert.equal(visitedSlugFromSub('search/关键词', HOME_SLUG), null, '检索页不算')
  assert.equal(visitedSlugFromSub('ask/问题', HOME_SLUG), null)
  assert.equal(visitedSlugFromSub('guide/intro/edit', HOME_SLUG), null, '编辑页不算')
})

test('visitedSlugFromSub：主页 slug 由调用方给定（主页批），结论未到时**不记**', () => {
  /*
   * 主页可被设为任何一篇，"最近访问"要记的是**实际渲染的那一篇**。
   * 记成常量 `home` 的症状很安静：最近访问里多一条点开不是主页的条目。
   */
  assert.equal(visitedSlugFromSub('', 'guide/intro'), 'guide/intro')
  /*
   * `null` = 主页结论还没到，或者主页被设置成一篇当前主体读不到的页面。
   * 两种都不许猜一个 slug 记进去 —— 那一条点开必然不是用户看到的那一篇（与 dockPlan 同一条纪律）。
   */
  assert.equal(visitedSlugFromSub('', null), null)
  // 详情页与这个入参无关：它自带 slug
  assert.equal(visitedSlugFromSub('guide/intro', null), 'guide/intro')
})

/* ------------------------------ 最近访问存储 ------------------------------ */

test('pushRecent：插到最前、去重、截断，且不改入参', () => {
  const original = ['b', 'c']
  const next = pushRecent(original, 'a')
  assert.deepEqual(next, ['a', 'b', 'c'])
  assert.deepEqual(original, ['b', 'c'], '不得修改入参数组')

  assert.deepEqual(pushRecent(['a', 'b'], 'b'), ['b', 'a'], '已存在则提到最前而不是重复')

  const long = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => `p${i}`)
  const trimmed = pushRecent(long, 'new')
  assert.equal(trimmed.length, RECENT_LIMIT, '应截断到上限')
  assert.equal(trimmed[0], 'new')
})

test('pushRecent：空 slug 是 no-op（不产生空条目）', () => {
  assert.deepEqual(pushRecent(['a'], ''), ['a'])
})
