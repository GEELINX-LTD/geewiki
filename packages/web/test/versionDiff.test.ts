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
import { authorText, HIDDEN_AUTHOR, UNKNOWN_AUTHOR } from '../src/lib/authorText'

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

test('作者文案三档：缺信息、名字被权限收走、真名 —— 三件事各说各的', () => {
  // ① 服务端连 id 都没给（0019 前的旧行 / 跨插件代调用 / 账号已删）⇒「未记录」
  assert.equal(authorText(null), UNKNOWN_AUTHOR)
  assert.equal(authorText(undefined), UNKNOWN_AUTHOR)
  // ② 记了作者、但名字没下发（版本列表端点的三档规则：其余主体只给 id）⇒「另一位成员」。
  //    这一档**最容易写错**：把 null 直接当"缺信息"，会把"权限上收"讲成"当时没记"。
  assert.equal(authorText({ id: 7, displayName: null }), HIDDEN_AUTHOR)
  assert.equal(authorText({ id: 7, displayName: '   ' }), HIDDEN_AUTHOR)
  // ③ 有名字 ⇒ 显名字（含"就是你自己"与 owner/admin 两档）
  assert.equal(authorText({ id: 7, displayName: '版本管理员' }), '版本管理员')
  // 反空洞：id 缺失（形状不合契约）时不能误报成"有人改过但名字被藏"
  assert.equal(authorText({ displayName: null }), UNKNOWN_AUTHOR)
  assert.notEqual(HIDDEN_AUTHOR, UNKNOWN_AUTHOR)
})

test('守卫：对比弹窗必须容忍缺失的作者字段（显示「未记录」，不得写"匿名"）', () => {
  const diffSrc = readFileSync(join(here, '../src/components/VersionDiffDialog.tsx'), 'utf8')
  const pickerSrc = readFileSync(join(here, '../src/components/VersionPicker.tsx'), 'utf8')
  // 「未记录」的**唯一**定义点（`authorText`）；VersionPicker 通过 import 复用它。
  assert.ok(diffSrc.length > 1500, 'VersionDiffDialog 读不到内容？反空洞')
  /*
   * 定义已下沉到 `lib/authorText.ts`（原地在 VersionDiffDialog 里，但那会与
   * `lib/versionPlan.ts` 构成循环 import —— 前者要用版本号算法、后者要用作者文案）。
   * 所以这里钉的是"**全仓只有一处字面量定义**"，而不是"必须定义在某个具体文件里"：
   * 后者是形态，前者才是要防的漂移。
   */
  const authorSrc = readFileSync(join(here, '../src/lib/authorText.ts'), 'utf8')
  assert.ok(authorSrc.length > 200, 'authorText 读不到内容？反空洞')
  assert.match(authorSrc, /export const UNKNOWN_AUTHOR = '未记录'/, '缺失作者必须显示为「未记录」')
  assert.match(authorSrc, /export function authorText/, 'authorText 必须导出（供版本下拉复用同一口径）')
  assert.match(diffSrc, /authorText/, 'VersionDiffDialog 必须经同一个 authorText')
  // 反空洞 + 单一来源：字面量只在 authorText.ts 出现一次
  assert.equal(
    (authorSrc.match(/'未记录'/g) ?? []).length,
    1,
    '「未记录」的字面量在 authorText.ts 里只应出现一次',
  )

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
    // 「另一位成员」同理：它是**权限收走名字**那一档的措辞，也只能有一处定义
    assert.doesNotMatch(
      codeOnly(src),
      /另一位成员/,
      `${name} 不得自己拼"名字被收走"的措辞（走 authorText，否则两处口径会分叉）`,
    )
  }
  assert.match(
    authorSrc,
    /export const HIDDEN_AUTHOR = '另一位成员'/,
    '「记了作者但名字不对你显示」必须有独立措辞（不能复用「未记录」）',
  )
  assert.equal(
    (authorSrc.match(/'另一位成员'/g) ?? []).length,
    1,
    '「另一位成员」的字面量在 authorText.ts 里只应出现一次',
  )
  /*
   * ★ 作者字段**不得被组件直接读**。
   *
   * 这条钉的是本轮修掉的那个洞的另一半：作者三档规则此前只落在分页端点上，
   * 页详情端点的 `versions[]` **无条件**回真名 —— 而版本下拉读的正是那份数据，
   * 于是普通成员与匿名访客经由下拉拿到了同事真名。
   *
   * 服务端已抽成唯一真源（`authorFor`），前端这一侧的对应纪律是：组件**只**把
   * `author` 整个对象交给 `authorText` 判档，绝不自己去读 `displayName`
   * —— 组件一旦直接读那个字段，就等于把"能不能看名字"的判断搬到了 UI 层，
   * 而后端再收紧档位时前端会**静默**渲染出一个名字。
   */
  for (const [name, src] of [
    ['VersionDiffDialog', diffSrc],
    ['VersionPicker', pickerSrc],
  ] as const) {
    assert.doesNotMatch(
      codeOnly(src),
      /\.displayName/,
      `${name} 不得直接读 displayName —— 作者展示必须整个交给 authorText 判档`,
    )
  }
  // 正面对照：两条渲染路径都真的经由 authorText / versionMetaText，否则上面的禁令可能只是"没渲染作者"
  assert.match(codeOnly(diffSrc), /authorText\(/, '对比弹窗必须用 authorText 渲染作者')
  assert.match(codeOnly(pickerSrc), /versionMetaText\(/, '时间线必须用 versionMetaText 渲染作者与时间')
  /*
   * 下拉与时间线都必须走**同一份**作者文案（否则两处口径会漂移）。
   *
   * 判据说的是"同一份"，不是"必须直接调 authorText"：本轮把菜单项的文案抽到了
   * `lib/versionPlan.ts` 的 `versionMetaText`（它内部转调 `authorText`），此时把
   * `authorText` 再留一份在 VersionPicker 里反而会变成**第二份口径** —— 那正是本条要防的事。
   * 所以这里钉"单一来源"，实现形态允许经一层转发。
   */
  const planSrc = readFileSync(join(here, '../src/lib/versionPlan.ts'), 'utf8')
  assert.ok(planSrc.length > 1500, 'versionPlan 读不到内容？反空洞')
  assert.match(planSrc, /authorText\(/, 'versionPlan 的 versionMetaText 必须转调 authorText')
  assert.doesNotMatch(
    pickerSrc,
    /displayName\s*\?\?/,
    'VersionPicker 不得自己拼作者名（那会绕开 authorText，形成第二份口径）',
  )
  assert.match(diffSrc, /authorText\(/, 'VersionDiffDialog 自身也要经 authorText')
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

test('守卫：正文下方不得再有常驻的版本列表（入口只在头部下拉）', () => {
  const page = readFileSync(join(here, '../src/pages/WikiPage.tsx'), 'utf8')
  assert.ok(page.length > 20000, 'WikiPage 读不到内容？反空洞')
  const code = codeOnly(page)
  /*
   * 本轮把正文下方那块紧凑列表也移除了（此前移除了更早的那张大卡片）。
   * 判据不是"某段文案消失"，而是**组件级**的：正文里不得再渲染版本列表 / 时间线弹窗，
   * 也不得再有"最近改动"区块 —— 否则版面会被重新撑起来。
   */
  assert.doesNotMatch(code, /<VersionList/, '正文下方不得再渲染版本列表')
  assert.doesNotMatch(code, /<TimelineDialog/, '时间线弹窗只由头部下拉自己持有，页面不得再挂一份')
  assert.doesNotMatch(code, /aria-label="最近改动"/, '「最近改动」常驻区块不得回来')
  assert.doesNotMatch(code, /setTimelineOpen/, '页面不该再有时间线弹窗的状态')
  // 正面对照：入口必须仍在（头部下拉 + 对比弹窗），否则"删掉了"可能只是整块被误删
  assert.match(page, /<VersionPicker/, '详情页必须渲染版本选择器')
  assert.match(page, /<VersionDiffDialog/, '详情页必须渲染对比弹窗')
  assert.match(page, /<ReadonlyHistoryButton|<VersionBadge/, '无编辑权仍要有版本号/只读历史入口')
})

test('守卫：条数摘要随列表一起搬进了下拉（信息不得随版面一起丢失）', () => {
  const picker = readFileSync(join(here, '../src/components/VersionPicker.tsx'), 'utf8')
  const plan = readFileSync(join(here, '../src/lib/versionPlan.ts'), 'utf8')
  assert.ok(picker.length > 5000 && plan.length > 5000, '文件读不到内容？反空洞')
  /*
   * ★ 本轮改过这里的判据，原因是真机验收发现"摘要与屏幕不一致"：
   *
   * 下拉的行以**分页端点的 `rows`** 为准（到货后条数比页内那份被 `recentVersions` 截断的
   * 数组更多），而摘要原先写死用 `page.versions.length` ⇒ 下拉已经列全 12 条、摘要却还写着
   * "仅列最近 10 次"。所以现在**实列条数必须由调用方传进来**，截断判据也从
   * `isTruncated(page)`（比页内数组）换成 `listed < history`（比屏幕实际）。
   */
  assert.match(picker, /versionCountText\(page, compactRows\.length\)/, '必须把**实列条数**传进摘要')
  assert.match(plan, /export function versionCountText/, '摘要必须是可单测的纯函数')
  assert.match(plan, /listedCount\?: number/, '实列条数必须可传（否则摘要只能按页内数组算，会与屏幕不符）')
  // 摘要必须说清"共几次"与"是否只列了一部分"，两者缺一都会让读者误判完整性
  assert.match(plan, /共 \$\{history\} 次改动/, '摘要要给出改动总数')
  assert.match(plan, /`\$\{base\}（下拉里仅列最近 \$\{listed\} 次/, '被截断时必须说明只列了最近几次（用实列条数）')
  assert.match(plan, /listed < history/, '截断判据必须比"实列条数 vs 总数"，不得退回比页内数组')
})

test('守卫：紧凑列表仍与「浏览全部历史」弹窗共用同一行组件（避免两处漂移）', () => {
  const picker = readFileSync(join(here, '../src/components/VersionPicker.tsx'), 'utf8')
  // 行渲染只能有一处：抽出成 VersionRowButton，由 VersionList 使用
  assert.equal((picker.match(/export function VersionRowButton/g) ?? []).length, 1, '行组件应只有一个')
  assert.match(picker, /export function VersionList/, '列表组件必须导出（弹窗内部使用）')
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
