/**
 * `lib/blockMetaPlan.ts` —— 阅读页**块级归属**的计划层守卫（纯逻辑，无 DOM）。
 *
 * ## 这里守的是什么
 *
 * 块级归属的全部风险集中在**对齐**上：区间对错了，标签就会挂到隔壁段落上，
 * 而它**不会报错、也不会崩**——页面照样显示，只是说了一句假话。
 * 所以本文件逐条钉住 `alignBlockSegments` 的三种结局：
 *
 *   1. **对得上** ⇒ 返回的每个区间切出来的就是那一段，且拼回去逐字等于渲染文本；
 *   2. **少了一段（标题被剥掉）** ⇒ 那一段被丢掉，其余段整体平移且仍然拼得回去；
 *   3. **对不上**（不是"删掉一段"、或区间与文本不是同一份） ⇒ 返回 `null`
 *      ⇒ 调用方**整页不显示归属**。少给可以，给错不行。
 *
 * ## 为什么用真实的 `stripDuplicateLeadingTitle`
 *
 * `shown` 不是凭空构造的：调用方（`pages/WikiPage.tsx`）就是拿
 * `stripDuplicateLeadingTitle(page.content, page.title)` 的结果去渲染的。
 * 测试里自己"手写一个少一段的字符串"会让守卫与真实调用链脱钩 —— 哪天那个函数改成
 * 删两段、或改成重排，测试仍然全绿。故这里**调真函数**生成 `shown`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  alignBlockSegments,
  blockMetaText,
  blockMetaTitle,
  MAX_ATTRIBUTED_SEGMENTS,
  planBlockGroups,
  type BlockUnit,
} from '../src/lib/blockMetaPlan'
import { stripDuplicateLeadingTitle } from '../src/lib/pageMeta'
import { relativeTime } from '../src/lib/timePlan'
import { activeMarked } from '../src/lib/markdownExt'

/**
 * 按**服务端的口径**造一份"块 + 投影文本"：块文本用 `'\n\n'` 拼起来就是 `content`
 * （`plugin-wiki` 的 `projectBlocks` 就是这么拼的）。
 *
 * 作者与时间默认给"无法归属"（`null`）—— 需要归属的用例自己覆盖，
 * 这样"忘了给归属"不会伪装成一个通过的用例。
 */
function project(blocks: Array<Partial<BlockUnit> & { text: string }>): {
  content: string
  units: BlockUnit[]
} {
  let len = 0
  const units: BlockUnit[] = blocks.map((b, i) => {
    const start = i === 0 ? 0 : len + 2
    const end = start + b.text.length
    len = end
    return {
      start,
      end,
      gated: b.gated ?? false,
      updatedAt: b.updatedAt ?? null,
      author: b.author ?? null,
    }
  })
  return { content: blocks.map((b) => b.text).join('\n\n'), units }
}

/** 断言：这些区间切出来的片段按 `'\n\n'` 拼回去，逐字等于渲染文本（地基恒等式） */
function assertTiles(shown: string, segments: { start: number; end: number }[]): void {
  assert.equal(segments.map((s) => shown.slice(s.start, s.end)).join('\n\n'), shown)
}

test('没有段（或空数组）⇒ 不给归属（返回 null，而不是"全篇一个空标签"）', () => {
  assert.equal(alignBlockSegments('abc', 'abc', []), null)
})

test('原文与渲染文本一致：区间原样保留，且拼回去逐字等于正文', () => {
  const { content, units } = project([
    { text: '# 标题' },
    { text: '第一段' },
    { text: '- 甲\n- 乙' },
  ])
  const segments = alignBlockSegments(content, content, units)
  assert.notEqual(segments, null)
  assert.deepEqual(
    segments?.map((s) => content.slice(s.start, s.end)),
    ['# 标题', '第一段', '- 甲\n- 乙'],
  )
  assertTiles(content, segments as BlockUnit[])
})

test('★ 标题被剥掉（真函数）：那一段被丢弃，其余段平移后仍然拼得回去', () => {
  const title = '样式指南'
  const { content, units } = project([
    { text: `# ${title}` },
    { text: '正文第一段' },
    { text: '正文第二段' },
  ])
  const shown = stripDuplicateLeadingTitle(content, title)
  assert.notEqual(shown, content, '反空洞：这一份正文确实被剥掉了开头那一段')

  const segments = alignBlockSegments(content, shown, units)
  assert.notEqual(segments, null)
  // 被剥掉的那一段（与标题重复的 H1）**不该**出现在结果里：它已经不在渲染文本里了
  assert.deepEqual(
    segments?.map((s) => shown.slice(s.start, s.end)),
    ['正文第一段', '正文第二段'],
  )
  assertTiles(shown, segments as BlockUnit[])
  // 归属跟着段走：第二段（内容上）仍然带着自己的作者
  assert.equal(segments?.[1]?.start, '正文第一段\n\n'.length)
})

test('标题没被剥掉（标题与 H1 不同）⇒ 走恒等分支，区间一律不动', () => {
  const { content, units } = project([{ text: '# 另一个标题' }, { text: '正文' }])
  const shown = stripDuplicateLeadingTitle(content, '样式指南')
  assert.equal(shown, content)
  const segments = alignBlockSegments(content, shown, units)
  assert.deepEqual(
    segments?.map((s) => [s.start, s.end]),
    units.map((u) => [u.start, u.end]),
  )
})

test('★ 对不齐就整页放弃：两处删除（不是"删掉一段"）⇒ null', () => {
  const full = '甲\n\n乙\n\n丙\n\n丁'
  // 删了两处 ⇒ 公共前缀/后缀量出来的"一段"还原不出 shown
  const shown = '乙\n\n丁'
  const units: BlockUnit[] = [
    { start: 0, end: 1, gated: false, updatedAt: null, author: null },
    { start: 3, end: 4, gated: false, updatedAt: null, author: null },
    { start: 6, end: 7, gated: false, updatedAt: null, author: null },
    { start: 9, end: 10, gated: false, updatedAt: null, author: null },
  ]
  assert.equal(alignBlockSegments(full, shown, units), null)
})

test('★ 区间与文本不是同一份（造出来的错区间）⇒ null，而不是错位显示', () => {
  const { content, units } = project([{ text: '第一段' }, { text: '第二段' }])
  // 把第二段整体往前挪一格：切出来的片段拼不回原文
  const tampered = units.map((u, i) => (i === 0 ? u : { ...u, start: u.start - 1, end: u.end - 1 }))
  assert.equal(alignBlockSegments(content, content, tampered), null)
})

test('渲染文本比原文长 ⇒ null（本函数只认识"删掉一段"这一种形态）', () => {
  const units: BlockUnit[] = [{ start: 0, end: 3, gated: false, updatedAt: null, author: null }]
  assert.equal(alignBlockSegments('abc', 'abcd', units), null)
})

test('受限占位段照样占一个单元，但**没有归属**（作者与时间都是 null）', () => {
  const { content, units } = project([
    { text: '公开段' },
    { text: '> 🔒 此处有 2 段内容需登录查看', gated: true },
    { text: '另一段', updatedAt: '2026-09-20T00:00:00.000Z', author: { id: 7, displayName: '爱丽丝' } },
  ])
  const segments = alignBlockSegments(content, content, units)
  assert.notEqual(segments, null)
  assertTiles(content, segments as BlockUnit[])
  assert.equal(blockMetaText((segments as BlockUnit[])[1] as never), null, '占位段不得显示归属')
  const now = new Date('2026-09-23T00:00:00.000Z')
  assert.equal(
    blockMetaText((segments as BlockUnit[])[2] as never, now),
    // 句子骨架由本模块决定；「3天前」那一半由 `timePlan` 负责（它有自己的用例），
    // 这里调它来拼期望值，免得把一个 ICU 的空格差异当成功能坏了
    `最后由 爱丽丝 编辑 · ${relativeTime('2026-09-20T00:00:00.000Z', now)}`,
  )
})

/* ------------------------------ 文案 ------------------------------ */

const at = (iso: string): BlockUnit => ({
  start: 0,
  end: 1,
  gated: false,
  updatedAt: iso,
  author: { id: 3, displayName: '爱丽丝' },
})

test('文案：真名 + 相对时间', () => {
  const iso = '2026-09-20T00:00:00.000Z'
  const justNow = new Date('2026-09-20T00:00:30.000Z')
  assert.equal(blockMetaText(at(iso), justNow), `最后由 爱丽丝 编辑 · ${relativeTime(iso, justNow)}`)
  assert.equal(blockMetaText(at(iso), justNow), '最后由 爱丽丝 编辑 · 刚刚')
  const later = new Date('2026-09-20T05:00:00.000Z')
  assert.equal(blockMetaText(at(iso), later), `最后由 爱丽丝 编辑 · ${relativeTime(iso, later)}`)
})

test('★ 名字被权限收走（displayName 为 null，但记了 id）⇒「另一位成员」，不是「未记录」', () => {
  assert.equal(
    blockMetaText(
      { ...at('2026-09-20T00:00:00.000Z'), author: { id: 9, displayName: null } },
      new Date('2026-09-20T05:00:00.000Z'),
    ),
    `最后由 另一位成员 编辑 · ${relativeTime('2026-09-20T00:00:00.000Z', new Date('2026-09-20T05:00:00.000Z'))}`,
  )
})

test('★ 无法归属（author 为 null）⇒ 没有文案（不是「未记录」）', () => {
  assert.equal(blockMetaText({ ...at('2026-09-20T00:00:00.000Z'), author: null }), null)
  assert.equal(blockMetaTitle({ ...at('2026-09-20T00:00:00.000Z'), author: null }), null)
})

test('★ 不知道时间（updatedAt 为 null，0024 之前写入的块）⇒ 没有文案', () => {
  assert.equal(blockMetaText({ ...at('2026-09-20T00:00:00.000Z'), updatedAt: null }), null)
})

test('悬停的 title 给绝对时间（相对时间读不出"具体哪一天"）', () => {
  assert.equal(
    blockMetaTitle(at('2026-09-20T03:04:05.000Z')),
    `爱丽丝 · ${new Date('2026-09-20T03:04:05.000Z').toLocaleString('zh-CN', { hour12: false })}`,
  )
})

test('段数上限是个正数常量（渲染层据此放弃逐段包裹，而不是卡住整页）', () => {
  assert.ok(Number.isInteger(MAX_ATTRIBUTED_SEGMENTS) && MAX_ATTRIBUTED_SEGMENTS > 0)
})

/* =====================================================================
 * 分组计划（`planBlockGroups`）：跨段续行与"渲染为空"的段
 *
 * 这一组用**真实的 marked**（`activeMarked().parse`）当渲染器 —— 无 DOM 也能跑，
 * 而"松列表会不会变成一个 `<ul>`"这件事**只由 marked 决定**，自己写个假渲染器
 * 等于把要验的东西替掉。DOMPurify 那一步不影响边界（它只删危险节点/属性），
 * 真机上由 `pnpm build` 后的浏览器端到端验收覆盖。
 * ===================================================================== */

/** 以真实 marked 为渲染器跑一遍分组（与服务端投影同款：`'\n\n'` 拼块） */
function groupsOf(units: Array<Partial<BlockUnit> & { text: string }>) {
  const { content, units: segs } = project(units)
  const render = (src: string): string => activeMarked().parse(src, { async: false }) as string
  return { content, segments: segs, groups: planBlockGroups(content, segs, render, render(content)) }
}

test('分组：普通段落各自成组（一组一段，边界就是块的边界）', () => {
  const { groups } = groupsOf([{ text: '甲' }, { text: '乙' }, { text: '丙' }])
  assert.equal(groups?.length, 3)
  assert.deepEqual(groups?.map((g) => g.segmentCount), [1, 1, 1])
  // 每组的边界首尾相接、且覆盖整份渲染（地基）
  assert.equal(groups?.[0]?.htmlStart, 0)
  assert.equal(groups?.[1]?.htmlStart, groups?.[0]?.htmlEnd)
})

test('★ 分组：松列表（空行分隔的列表项）合成**一组**，且切分仍覆盖整份 HTML', () => {
  const { content, groups } = groupsOf([{ text: '- 甲' }, { text: '- 乙' }])
  const whole = activeMarked().parse(content, { async: false }) as string
  // 反空洞：这一份 Markdown 真的被渲染成一个**松列表**（两块一个节点）
  assert.equal((whole.match(/<ul>/g) ?? []).length, 1)
  assert.notEqual(groups, null)
  assert.deepEqual(groups?.map((g) => g.segmentCount), [2], '两块必须合成一组（否则标签会指错）')
  assert.equal(groups?.[0]?.htmlStart, 0)
  assert.equal(groups?.[0]?.htmlEnd, whole.length, '切分必须覆盖整份 HTML')
})

test('★ 分组：链接引用定义单独成段 ⇒ 自己不成组，但**带着**给消费段用', () => {
  const { groups } = groupsOf([{ text: '[x]: /wiki/target' }, { text: '见 [x] 一文' }, { text: '末段' }])
  assert.notEqual(groups, null, '引用定义不得让整页失去归属')
  assert.deepEqual(
    groups?.map((g) => g.segmentCount),
    [1, 1],
    '定义段自己渲染成空串（没有节点），不该凭空占一个包裹层；消费段与末段各成一组',
  )
})

test('★ 分组：定义段自己的归属**不参与**它后面那一组的文案（它没有 DOM 节点）', () => {
  const { groups } = groupsOf([
    { text: '[x]: /wiki/target', updatedAt: 't1', author: { id: 1, displayName: '甲' } },
    { text: '见 [x] 一文', updatedAt: 't2', author: { id: 2, displayName: '乙' } },
  ])
  assert.equal(groups?.length, 1)
  assert.equal(groups?.[0]?.segmentCount, 1, '只有消费段占组')
  assert.equal(
    groups?.[0]?.label?.author?.displayName,
    '乙',
    '文案说的是**这一段**（渲染出来的那个节点）的作者，不是定义段的',
  )
})

test('★ 分组：定义段与消费段归属相同 ⇒ 照常显示归属（带着走不影响判据）', () => {
  const same = { updatedAt: '2026-09-20T00:00:00.000Z', author: { id: 1, displayName: '甲' } }
  const { groups } = groupsOf([{ text: '[x]: /wiki/target', ...same }, { text: '见 [x] 一文', ...same }])
  assert.equal(groups?.[0]?.segmentCount, 1)
  const now = new Date('2026-09-21T00:00:00.000Z')
  assert.equal(
    blockMetaText(groups?.[0]?.label as never, now),
    `最后由 甲 编辑 · ${relativeTime('2026-09-20T00:00:00.000Z', now)}`,
  )
})

test('分组：文末只渲染出空串的段（没被引用的定义）不占组，也不影响其余段', () => {
  const { groups } = groupsOf([{ text: '正文甲' }, { text: '[y]: /wiki/never-used' }])
  assert.notEqual(groups, null)
  assert.equal(groups?.length, 1, '没有 DOM 节点的段不该凭空占一个包裹层')
  assert.equal(groups?.[0]?.segmentCount, 1)
})

test('★ 分组：定义段在中间、被**后面**的段消费 ⇒ 定义必须一直带着走（浏览器验收抓出的缺陷）', () => {
  /*
   * 这一条对应真机上的失败形态（第一版实现整页没有标签，而页面看上去完全正常）：
   *   第 2 段是定义、第 4~5 段是它消费方。定义是**文档作用域**的，
   *   只在"第一个渲染出非空的组"里带上它是不够的 —— 后面每一组都得带上。
   */
  const { content, groups } = groupsOf([
    { text: '引用式链接在下面定义。' },
    { text: '[ref]: /wiki/guide/architecture' },
    { text: '- 列表项甲' },
    { text: '- 列表项乙' },
    { text: '使用 [ref] 的段落。' },
  ])
  assert.notEqual(groups, null, '定义在中间不得让整页失去归属')
  assert.deepEqual(
    groups?.map((g) => g.segmentCount),
    [1, 2, 1],
    '定义段自己不成组；两个松列表项合成一组；消费段单独一组',
  )
  const whole = activeMarked().parse(content, { async: false }) as string
  assert.equal(groups?.[groups.length - 1]?.htmlEnd, whole.length, '切分必须覆盖整份 HTML')
  const last = whole.slice(groups?.[2]?.htmlStart ?? 0, groups?.[2]?.htmlEnd ?? 0)
  assert.ok(last.includes('<a href="/wiki/guide/architecture">'), `消费段应渲染出真链接，实际 ${last}`)
})

test('★ 分组：连到文末都对不上 ⇒ null（调用方整份放弃归属，正文照常显示）', () => {
  // 把两段的区间**对调**：渲染顺序与 HTML 顺序不符 ⇒ 第一组就不是 HTML 的前缀
  const { content, segments } = groupsOf([{ text: '甲' }, { text: '乙' }])
  const swapped = [
    { ...(segments[0] as BlockUnit), start: segments[1]!.start, end: segments[1]!.end },
    { ...(segments[1] as BlockUnit), start: segments[0]!.start, end: segments[0]!.end },
  ]
  const render = (src: string): string => activeMarked().parse(src, { async: false }) as string
  assert.equal(
    planBlockGroups(content, swapped, render, render(content)),
    null,
    '切分对不上必须返回 null —— 那时任何归属都是猜的',
  )
})

test('分组：空 HTML（空页面）⇒ null（没有任何东西可包裹）', () => {
  assert.equal(planBlockGroups('', [], () => '', ''), null)
})

/* =====================================================================
 * 样式侧的两条硬要求（源码级守卫）
 *
 * 本仓的 node 测试环境没有 DOM，样式只能做源码级断言 —— 而这两条**正是**
 * 单测与验收脚本都容易漏掉的：它们只在"某一个媒体分支"或"某一层包裹"下成立，
 * 删掉之后页面看上去毫无异常。
 * ===================================================================== */

const markdownCss = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'markdown.css'), 'utf8')

test('样式：标签默认不可见（只有悬停/聚焦才出现），且包裹层不占位', () => {
  const chip = /\.gw-block-meta\s*\{([^}]*)\}/.exec(markdownCss)?.[1] ?? ''
  assert.ok(chip.length > 0, '反空洞：应能定位到 .gw-block-meta 规则')
  assert.match(chip, /visibility:\s*hidden/, '默认必须不可见 —— 否则每一段都顶着一行标签')
  /*
   * 必须是 `visibility: hidden` 而**不是**只给 `opacity: 0`：后者仍吃鼠标事件
   * （正文右上角的链接点不动），屏幕阅读器也仍会念出来。
   */
  assert.doesNotMatch(chip, /visibility:\s*visible/)
  const wrap = /\.gw-block\s*\{([^}]*)\}/.exec(markdownCss)?.[1] ?? ''
  assert.ok(wrap.length > 0, '反空洞：应能定位到 .gw-block 规则')
  for (const forbidden of ['margin', 'padding', 'border']) {
    assert.ok(
      !new RegExp(`(^|[;{\\s])${forbidden}\\s*:`).test(wrap),
      `包裹层不得设 ${forbidden} —— 它会改变正文排版（子元素的外边距本来要"穿过去"）`,
    )
  }
  assert.match(wrap, /position:\s*relative/, '标签要相对本段定位')
})

test('★ 样式：没有悬停能力的设备上标签常显（否则这个功能永远够不到）', () => {
  /*
   * 触屏分支：`@media (hover: none)` 里必须把 `.gw-block-meta` 显出来。
   * 逐块扫（**不能只取第一个匹配**）：文件里已经有一个 `hover: none` 分支
   * （标题锚点的常显），按"第一个匹配"取会量到那一个，这条守卫就退化成恒假。
   */
  const branches = [...markdownCss.matchAll(/@media\s*\(hover:\s*none\)\s*\{([\s\S]*?)\n {2}\}/g)].map(
    (m) => m[1] ?? '',
  )
  const media = branches.find((b) => b.includes('gw-block-meta')) ?? ''
  assert.ok(media.length > 0, `反空洞：应存在针对 .gw-block-meta 的 hover:none 分支（实到 ${branches.length} 个分支）`)
  assert.match(media, /visibility:\s*visible/, '触屏上必须常显')
  assert.match(media, /opacity:\s*1/)
})
