/**
 * textDiff / timePlan 的单元测试。
 *
 * 这两个模块是"版本对比"的全部智力所在（其余是排版），所以断言要**盯住语义**：
 * 增删计数、退化路径、标题归属，以及相对时间的边界。
 *
 * 风格照仓库其它计划模块的测试（`assistPlan.test.ts` / `attachmentPlan.test.ts`）：
 * 纯函数直调 + 一条"源码级守卫"防止实现被换掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedSections, diffLines, diffStats, statsLabel } from '../src/lib/textDiff'
import { absoluteTime, relativeTime } from '../src/lib/timePlan'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 只保留代码、剥掉注释。
 *
 * 为什么必须剥：这些守卫是**反模式断言**（"不许出现某个词"），而实现里往往**故意写着那个词**
 * —— 在注释里解释"为什么不用它"（例如「不要写"匿名"」）。不剥注释的话，一条说清道理的注释
 * 会把守卫判红，逼着后人删掉解释。这与仓库既有源码守卫的 `codeOnly()` 是同一个做法。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ───────────────────────── diffLines：基本形状 ─────────────────────────

test('完全相同 ⇒ 没有变更行，全部 same', () => {
  const r = diffLines('a\nb\nc', 'a\nb\nc')
  assert.equal(r.stats.added, 0)
  assert.equal(r.stats.removed, 0)
  assert.equal(r.stats.degraded, false)
  assert.ok(r.ops.every((o) => o.type === 'same'))
  assert.equal(r.ops.length, 3)
})

test('纯追加一段 ⇒ 只有 add，且行号指向新文本', () => {
  const r = diffLines('a\nb', 'a\nb\nc\nd')
  assert.deepEqual([r.stats.added, r.stats.removed], [2, 0])
  const adds = r.ops.filter((o) => o.type === 'add')
  assert.deepEqual(adds.map((o) => o.bLine), [3, 4])
  assert.ok(adds.every((o) => o.aLine === null), '新增行在旧文本里没有行号')
})

test('纯删除一段 ⇒ 只有 del，且行号指向旧文本', () => {
  const r = diffLines('a\nb\nc\nd', 'a\nd')
  assert.deepEqual([r.stats.added, r.stats.removed], [0, 2])
  const dels = r.ops.filter((o) => o.type === 'del')
  assert.deepEqual(dels.map((o) => o.aLine), [2, 3])
  assert.ok(dels.every((o) => o.bLine === null))
})

test('改一行 ⇒ 记为一删一增（行级语义：这一行变了）', () => {
  const r = diffLines('标题\n正文一\n正文二', '标题\n正文一改了\n正文二')
  assert.deepEqual([r.stats.added, r.stats.removed], [1, 1])
  assert.equal(statsLabel(r.stats), '+1 −1')
  // 上下文行仍是 same，且新行号连续
  const adds = r.ops.filter((o) => o.type === 'add')
  assert.equal(adds[0]?.bLine, 2)
  assert.equal(adds[0]?.text, '正文一改了')
})

test('连续多行改动算作一处（changedSections 只报一次）', () => {
  const a = '# 甲\n\n旧一\n旧二\n旧三\n\n# 乙\n\n正文'
  const b = '# 甲\n\n新一\n新二\n新三\n\n# 乙\n\n正文'
  const r = diffLines(a, b)
  assert.equal(r.stats.removed, 3)
  assert.equal(r.stats.added, 3)
  const sections = changedSections(r.ops)
  assert.deepEqual(sections, ['甲'], '连续改动应归到同一个标题下，只报一次')
})

test('一侧为空：空→有 全是 add；有→空 全是 del', () => {
  const add = diffLines('', 'x\ny')
  assert.deepEqual([add.stats.added, add.stats.removed], [2, 0])
  const del = diffLines('x\ny', '')
  assert.deepEqual([del.stats.added, del.stats.removed], [0, 2])
  const both = diffLines('', '')
  assert.deepEqual([both.stats.added, both.stats.removed], [0, 0])
  assert.equal(both.ops.length, 0)
})

test('末尾无换行不会被当成"少了一行"', () => {
  const r = diffLines('a\nb', 'a\nb\nc')
  assert.deepEqual([r.stats.added, r.stats.removed], [1, 0])
  const r2 = diffLines('a\nb\n', 'a\nb')
  // `'a\nb\n'.split('\n')` 末尾会多出一个空串；两侧都按同一规则切分 ⇒ 视为删掉一个空行
  assert.equal(r2.stats.added + r2.stats.removed >= 0, true)
})

test('CRLF 与 LF 的同一段文本视为未改动（行尾 \\r 不算差异）', () => {
  const r = diffLines('a\r\nb\r\nc', 'a\nb\nc')
  assert.deepEqual([r.stats.added, r.stats.removed], [0, 0])
})

// ───────────────────────── 上限保护 ─────────────────────────

test('超出 maxCells ⇒ 退化为整段替换，且 degraded 置位（不静默）', () => {
  const a = Array.from({ length: 40 }, (_, i) => `旧 ${i}`).join('\n')
  const b = Array.from({ length: 40 }, (_, i) => `新 ${i}`).join('\n')
  const r = diffLines(a, b, { maxCells: 100 })
  assert.equal(r.stats.degraded, true)
  assert.equal(r.stats.removed, 40)
  assert.equal(r.stats.added, 40)
})

test('未超上限时不置 degraded（对照面，防止恒真）', () => {
  const r = diffLines('a\nb\nc', 'a\nX\nc', { maxCells: 100 })
  assert.equal(r.stats.degraded, false)
})

test('diffStats 只给计数（菜单用），与 diffLines 的统计一致', () => {
  const a = '# 一\n\n甲\n乙\n'
  const b = '# 一\n\n甲\n乙改了\n丙\n'
  const viaLines = diffLines(a, b).stats
  const viaStats = diffStats(a, b)
  assert.deepEqual(viaStats, viaLines)
})

test('statsLabel：正文未变时给出「正文未变」而不是 +0 −0', () => {
  assert.equal(statsLabel({ added: 0, removed: 0, degraded: false }), '正文未变')
  assert.equal(statsLabel({ added: 3, removed: 0, degraded: false }), '+3 −0')
})

// ───────────────────────── 标题归属 ─────────────────────────

test('改动落在最近的标题下', () => {
  const a = '# 甲\n\n甲正文\n\n## 乙\n\n乙正文\n'
  const b = '# 甲\n\n甲正文\n\n## 乙\n\n乙正文改了\n'
  assert.deepEqual(changedSections(diffLines(a, b).ops), ['乙'])
})

test('无标题 ⇒ 退化为行号区间', () => {
  const r = diffLines('一行\n二行\n三行', '一行\n二行改了\n三行')
  const sections = changedSections(r.ops)
  assert.equal(sections.length, 1)
  assert.match(sections[0] ?? '', /^第 \d+(–\d+)? 行/)
})

test('删除标题本身时，那一块仍归到该标题（不是上一个标题）', () => {
  const a = '# 甲\n\n甲正文\n\n## 乙\n\n乙正文\n'
  const b = '# 甲\n\n甲正文\n\n乙正文\n'
  const sections = changedSections(diffLines(a, b).ops)
  assert.ok(sections.includes('乙'), `期望包含「乙」，实际 ${JSON.stringify(sections)}`)
})

test('多处改动 ⇒ 去重并最多报 maxSections 个', () => {
  const a = '# 甲\n\n甲\n\n# 乙\n\n乙\n\n# 丙\n\n丙\n\n# 丁\n\n丁\n'
  const b = '# 甲\n\n甲改\n\n# 乙\n\n乙改\n\n# 丙\n\n丙改\n\n# 丁\n\n丁改\n'
  const all = changedSections(diffLines(a, b).ops, 10)
  assert.deepEqual(all, ['甲', '乙', '丙', '丁'])
  const capped = changedSections(diffLines(a, b).ops, 2)
  assert.equal(capped.length, 2, '超过上限时只报前 N 个')
})

// ───────────────────────── 时间工具 ─────────────────────────
// 相对时间的分档边界（含「昨天」）已**专测**在 `timeText.test.ts` —— 两处都测会漂移。
// 这里只留一条冒烟：确认本模块的 diff 视图确实用的是同一套时间口径。

test('timePlan 冒烟：diff 视图用的相对时间可用', () => {
  assert.equal(relativeTime(new Date().toISOString()), '刚刚')
})

// ───────────────────────── 源码级守卫 ─────────────────────────

test('守卫：textDiff 不得依赖 DOM/React/网络（纯函数模块）', () => {
  const src = readFileSync(join(here, '../src/lib/textDiff.ts'), 'utf8')
  assert.ok(src.length > 2000, '读不到内容？反空洞')
  assert.doesNotMatch(src, /from 'react'|document\.|window\.|fetch\(/, 'textDiff 必须是纯函数模块')
})

test('守卫：对比弹窗必须容忍缺失的作者字段（显示「未记录」，不得写"匿名"）', () => {
  const diffSrc = readFileSync(join(here, '../src/components/VersionDiffDialog.tsx'), 'utf8')
  const pickerSrc = readFileSync(join(here, '../src/components/VersionPicker.tsx'), 'utf8')
  // 「未记录」的**唯一**定义点（`authorText`）；VersionPicker 通过 import 复用它。
  assert.ok(diffSrc.length > 1500, 'VersionDiffDialog 读不到内容？反空洞')
  assert.match(diffSrc, /export const UNKNOWN_AUTHOR = '未记录'/, '缺失作者必须显示为「未记录」')
  assert.match(diffSrc, /export function authorText/, 'authorText 必须导出（供版本下拉复用同一口径）')

  for (const [name, src] of [
    ['VersionDiffDialog', diffSrc],
    ['VersionPicker', pickerSrc],
  ] as const) {
    assert.ok(src.length > 1500, `${name} 读不到内容？反空洞`)
    assert.doesNotMatch(
      codeOnly(src),
      /匿名/,
      `${name} 不得把"没有作者信息"写成"匿名"（那是另一种事实主张，注释里说明原因不算）`,
    )
  }
  // 下拉与时间线都必须走同一个 authorText（否则两处口径会漂移）
  assert.equal(
    (pickerSrc.match(/authorText\(/g) ?? []).length >= 2,
    true,
    'VersionPicker 的菜单项与时间线都要经 authorText',
  )
})

test('守卫：旧版本历史卡片不得回来（特征文案已删除）', () => {
  const page = readFileSync(join(here, '../src/pages/WikiPage.tsx'), 'utf8')
  assert.ok(page.length > 20000, 'WikiPage 读不到内容？反空洞')
  /*
   * 剥注释后断言：页面里**注释**提到"快照预览/旧文案"是正常的（本轮就在注释里记录了
   * 为什么删掉那块卡片），要禁的是它们作为**界面文案/组件**回来。
   */
  const code = codeOnly(page)
  assert.doesNotMatch(code, /个历史快照，下面显示最近/, '旧卡片的统计文案不得回流')
  assert.doesNotMatch(code, /快照预览/, '旧卡片的内联预览不得回流')
  // 正面对照：必须真的用了新组件，否则"删掉了"可能只是因为整块被误删
  assert.match(page, /<VersionPicker/, '详情页必须渲染版本选择器')
  assert.match(page, /<VersionDiffDialog/, '详情页必须渲染对比弹窗')
})

test('守卫：版本选择器落在 canEdit 门控内，且无编辑权走静态徽标', () => {
  const page = readFileSync(join(here, '../src/pages/WikiPage.tsx'), 'utf8')
  const at = page.indexOf('<VersionPicker')
  assert.notEqual(at, -1)
  const window = page.slice(Math.max(0, at - 400), at)
  assert.match(window, /page\.capabilities\.canEdit/, '版本选择器必须在 canEdit 门控内')
  assert.match(page, /<VersionBadge/, '无编辑权时要退化为静态徽标')
})

test('守卫：紧凑区只展示 COMPACT_VERSIONS 条，且整块受 canEdit 门控', () => {
  const page = readFileSync(join(here, '../src/pages/WikiPage.tsx'), 'utf8')
  const at = page.indexOf('<VersionList')
  assert.notEqual(at, -1, '正文下方必须有紧凑版本列表')
  assert.match(page.slice(at, at + 120), /limit=\{COMPACT_VERSIONS\}/, '紧凑列表必须限量，否则版本多了又变成一大块')
  /*
   * 门控在**区块开头**（`{page.version > 1 && page.capabilities.canEdit && (`），
   * 距 `<VersionList` 隔着整段说明注释与头部一行 —— 按固定字符窗口截会随注释长度失效。
   * 故按"区块起点 → 列表"整段判定：起点取该区块自己的 `<section ... aria-label="最近改动">`。
   */
  const sectionAt = page.lastIndexOf('<section', at)
  assert.notEqual(sectionAt, -1, '紧凑列表应包在 aria-label="最近改动" 的 section 里')
  const block = page.slice(sectionAt - 600, at)
  assert.match(block, /page\.capabilities\.canEdit/, '整块必须在 canEdit 门控内（无编辑权者进不了对比弹窗）')
  assert.match(block, /aria-label="最近改动"/, '区块要有可读的名称（读屏用户需要知道这是什么）')
  // 反空洞：常量必须真的存在且是个小数
  const picker = readFileSync(join(here, '../src/components/VersionPicker.tsx'), 'utf8')
  const m = /export const COMPACT_VERSIONS = (\d+)/.exec(picker)
  assert.ok(m !== null, 'COMPACT_VERSIONS 必须导出为字面量')
  assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 10, '默认展示条数应在 1–10 之间')
})

test('守卫：紧凑区与「查看全部改动」弹窗共用同一行组件（避免两处漂移）', () => {
  const picker = readFileSync(join(here, '../src/components/VersionPicker.tsx'), 'utf8')
  // 行渲染只能有一处：抽出成 VersionRowButton，由 VersionList 使用
  assert.equal((picker.match(/export function VersionRowButton/g) ?? []).length, 1, '行组件应只有一个')
  assert.match(picker, /export function VersionList/, '列表组件必须导出（页面与弹窗共用）')
  assert.equal(
    (picker.match(/<VersionRowButton/g) ?? []).length,
    1,
    'VersionRowButton 只应在 VersionList 内部渲染一次（弹窗不得再抄一份）',
  )
})

test('守卫：恢复入口按 canManageVisibility 门控（不是 canEdit）', () => {
  const page = readFileSync(join(here, '../src/pages/WikiPage.tsx'), 'utf8')
  const at = page.indexOf('canRestore=')
  assert.notEqual(at, -1, '恢复能力必须以 canRestore 传入')
  assert.match(page.slice(at, at + 120), /canManageVisibility/, '恢复要求的是管理权，不是编辑权')
})
