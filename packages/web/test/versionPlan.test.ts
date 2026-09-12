/**
 * `versionPlan` 的单测。
 *
 * 为什么值得单独一个文件：这里的每个函数都在**替用户读历史**，说错话的代价是
 * "把 v14 显示成 v4"或"把无权说成不存在"这类**看起来对但其实在撒谎**的缺陷。
 *
 * 重点钉住两处：
 * 1. **截断场景的版本号**：`recentVersions` 默认 10，历史多于 10 条时数组只给最近 10 条
 *    ⇒ 用 `version - index - 1` 数下标会整体偏移；正确算法从总数往下数（见 `versionNumberOf`）。
 * 2. **`?v=` 的解析**：非法值必须归 `invalid`（界面据此回落并提示），不能静默当成"没有预览"，
 *    否则用户从别处粘来的坏链接会毫无反馈地显示成最新版。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PREVIEW_ATTACHMENT_NOTE,
  PREVIEW_INVALID_TEXT,
  canPickVersion,
  canRestoreVersion,
  isTruncated,
  parsePreviewParam,
  pickerTriggerText,
  previewBarText,
  previewRoute,
  restoreConfirmBody,
  restoreDoneText,
  restoreErrorText,
  versionChangeSummary,
  versionMetaText,
  versionNumberOf,
  versionOptions,
} from '../src/lib/versionPlan'

const page = (version: number, count: number) => ({
  version,
  versions: Array.from({ length: count }, (_, i) => ({
    id: 100 - i,
    saved_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    title: null,
    author: null,
  })),
})

/* ------------------------------ 版本号 ------------------------------ */

test('版本号：未截断时第 0 项 = 当前版本号 - 1', () => {
  const p = page(5, 4) // 当前 v5，历史 4 条（v1..v4）
  assert.equal(versionNumberOf(p, 0), 4)
  assert.equal(versionNumberOf(p, 3), 1)
})

test('★ 版本号：截断时必须按总数算，不能按数组下标推', () => {
  /*
   * 当前 v15 ⇒ 历史共 14 条（v1..v14），但接口只给最近 10 条。
   * 数组第 0 项仍然是**最近的一条历史**，即 v14 —— 不是 v5、更不是 v4。
   */
  const p = page(15, 10)
  assert.equal(versionNumberOf(p, 0), 14, '截断时第 0 项应是 v14')
  assert.equal(versionNumberOf(p, 9), 5, '第 9 项（最后一条）是 v5')
  // 反空洞：确认这个 fixture 真的是截断场景，否则断言无意义
  assert.ok(isTruncated(p), 'fixture 必须处于截断状态')
  assert.equal(p.version - 1, 14, '历史总数应为 14')
})

test('版本号：截断场景下不得出现 0 或负值（那是数据事故，不能掩盖）', () => {
  const p = page(3, 2)
  assert.ok(versionNumberOf(p, 1) >= 1)
  const truncated = page(30, 10)
  assert.ok(versionNumberOf(truncated, 9) >= 1)
})

test('isTruncated：只有历史总数超过数组长度时为真', () => {
  assert.equal(isTruncated(page(5, 4)), false)
  assert.equal(isTruncated(page(15, 10)), true)
  assert.equal(isTruncated(page(1, 0)), false, '零历史不算截断')
})

test('versionOptions：顺序与接口一致（新 → 旧），标签从总数往下数', () => {
  const opts = versionOptions(page(15, 10))
  assert.equal(opts.length, 10)
  assert.equal(opts[0]!.number, 14)
  assert.equal(opts[0]!.id, 100)
  assert.equal(opts[9]!.number, 5)
  assert.equal(opts[9]!.id, 91)
  // 每项都带 isCurrent 字段且恒为 false（当前版本没有快照行）
  assert.ok(opts.every((o) => o.isCurrent === false))
})

/* ------------------------------ 判据 ------------------------------ */

test('canPickVersion：四象限', () => {
  const cap = (canEdit: boolean, canManageVisibility: boolean, canDelete = false) => ({
    capabilities: { canEdit, canDelete, canManageVisibility },
  })
  assert.equal(canPickVersion(cap(true, false)), true, '可编辑 ⇒ 有下拉')
  assert.equal(canPickVersion(cap(true, true)), true)
  assert.equal(canPickVersion(cap(false, true)), false, '只有管理权没有编辑权 ⇒ 无下拉（快照端点要 canEdit）')
  assert.equal(canPickVersion(cap(false, false)), false, '只读 ⇒ 无下拉')
  assert.equal(canPickVersion(null), false, '页面未加载 ⇒ 无下拉（失败关闭）')
})

test('canRestoreVersion：判据是管理权，不是编辑权', () => {
  const cap = (canEdit: boolean, canManageVisibility: boolean) => ({
    capabilities: { canEdit, canDelete: false, canManageVisibility },
  })
  assert.equal(canRestoreVersion(cap(true, false)), false, '只有编辑权 ⇒ 不给恢复入口（服务端会 403）')
  assert.equal(canRestoreVersion(cap(true, true)), true)
  assert.equal(canRestoreVersion(cap(false, true)), true)
  assert.equal(canRestoreVersion(null), false)
})

/* ------------------------------ ?v= 解析 ------------------------------ */

test('parsePreviewParam：正常与边界', () => {
  assert.deepEqual(parsePreviewParam(''), { kind: 'none' })
  assert.deepEqual(parsePreviewParam('foo=1'), { kind: 'none' })
  assert.deepEqual(parsePreviewParam('v=123'), { kind: 'ok', id: 123 })
  assert.deepEqual(parsePreviewParam('a=1&v=7&b=2'), { kind: 'ok', id: 7 })
  assert.deepEqual(parsePreviewParam('v=%20123%20'), { kind: 'ok', id: 123 }, '前后空白应被容忍')
  assert.deepEqual(parsePreviewParam('v=0007'), { kind: 'ok', id: 7 }, '前导零是同一个 id')
})

test('parsePreviewParam：非法值一律归 invalid（界面据此回落并提示）', () => {
  for (const q of ['v=', 'v=abc', 'v=-1', 'v=0', 'v=1.5', 'v=1e3', 'v=99999999999999999999', 'v=%20']) {
    assert.deepEqual(parsePreviewParam(q), { kind: 'invalid' }, `应判为非法: ${q}`)
  }
})

test('parsePreviewParam：非空但坏掉的查询串不抛异常', () => {
  assert.doesNotThrow(() => parsePreviewParam('%%%'))
  assert.doesNotThrow(() => parsePreviewParam('v=%E4%B8%AD'))
})

test('previewRoute：slug 必须编码（分层 slug 否则会被当成多段）', () => {
  assert.equal(previewRoute('guide/intro', 7), 'guide%2Fintro?v=7')
  assert.equal(previewRoute('home', 3), 'home?v=3')
})

/* ------------------------------ 文案 ------------------------------ */

test('pickerTriggerText：最新态与预览态可区分', () => {
  assert.equal(pickerTriggerText(12, null), 'v12 · 最新')
  assert.equal(pickerTriggerText(12, 9), 'v9 · 历史 · 只读')
})

test('previewBarText：含版本号与绝对时间（分享出去的链接要能被别人读懂）', () => {
  const text = previewBarText(9, '2026-01-02T03:04:05.000Z')
  assert.match(text, /^正在查看 v9（保存于 /)
  assert.match(text, /· 只读$/)
})

test('预览附注说清附件的判定口径与正文不同', () => {
  assert.match(PREVIEW_ATTACHMENT_NOTE, /当前/)
  assert.match(PREVIEW_ATTACHMENT_NOTE, /附件/)
})

test('versionMetaText：无作者信息「未记录」、名字被收走「另一位成员」、有名字显示名字', () => {
  const iso = new Date(Date.now() - 5 * 60_000).toISOString()
  assert.match(versionMetaText(iso, null), /未记录$/)
  // 有 id、没名字 = 服务端记了作者但没对**你**下发（版本列表三档规则）—— 不能写成「未记录」，
  // 那会把"权限上收"讲成"当时没记"。措辞由 `lib/authorText.ts` 单点定义。
  assert.match(versionMetaText(iso, { id: 7, displayName: null }), /另一位成员$/)
  assert.match(versionMetaText(iso, { id: 7, displayName: '   ' }), /另一位成员$/, '空白名字也算"没下发"')
  assert.match(versionMetaText(iso, { id: 7, displayName: '爱丽丝' }), /爱丽丝$/)
})

test('versionChangeSummary：三种形态与降级', () => {
  assert.equal(versionChangeSummary({ contentChanged: true, blocksDelta: 0, grantsDelta: 0 }), '正文已改')
  assert.equal(versionChangeSummary({ contentChanged: true, blocksDelta: 3, grantsDelta: 0 }), '+3 段')
  assert.equal(versionChangeSummary({ contentChanged: true, blocksDelta: -2, grantsDelta: 0 }), '−2 段')
  assert.equal(
    versionChangeSummary({ contentChanged: true, blocksDelta: 2, grantsDelta: -1 }),
    '+2 段 · −1 条授权',
  )
  assert.equal(
    versionChangeSummary({ contentChanged: false, blocksDelta: 0, grantsDelta: 0 }),
    '仅标题或权限变更',
  )
  assert.equal(versionChangeSummary({ contentChanged: false, blocksDelta: 0, grantsDelta: 2 }), '+2 条授权')
})

test('★ versionChangeSummary：契约未就绪或字段缺失时返回 null（不编数字）', () => {
  assert.equal(versionChangeSummary(null), null)
  assert.equal(versionChangeSummary(undefined), null)
  assert.equal(versionChangeSummary({}), null, '缺 contentChanged ⇒ 不猜')
  assert.equal(versionChangeSummary({ blocksDelta: 3 }), null, '只有块差、没有内容标志 ⇒ 不猜')
})

test('restoreConfirmBody：三行必须都在，且说清"新生成版本"与"老快照只恢复正文"', () => {
  const body = restoreConfirmBody(4, 9, '2026-01-02T03:04:05.000Z')
  const lines = body.split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /v9/)
  assert.match(lines[0]!, /v4/)
  assert.match(lines[0]!, /新生成一个版本/)
  assert.match(lines[0]!, /不会回到旧编号/)
  assert.match(lines[1]!, /一并回滚/)
  assert.match(lines[2]!, /只恢复正文/)
})

test('restoreDoneText：无警告时说明四位一体都已回滚', () => {
  assert.match(restoreDoneText([]), /已恢复/)
  assert.match(restoreDoneText(undefined), /已恢复/)
  // 不编版本号：服务端恢复响应里没有新版本号
  assert.doesNotMatch(restoreDoneText([]), /v\d/)
})

test('★ restoreDoneText：警告必须翻译成中文，不能吞掉', () => {
  const text = restoreDoneText(['block_acls_not_restored'])
  assert.match(text, /块级权限未回滚/)
  assert.match(text, /只恢复了正文/)
  // 未知警告也不能丢：宁可原文带出，也不要假装没有
  assert.match(restoreDoneText(['something_new']), /something_new/)
})

test('restoreErrorText：从 blockedOrdinals 生成可读提示，无该字段时返回 null', () => {
  assert.equal(restoreErrorText(null), null)
  assert.equal(restoreErrorText({}), null)
  assert.equal(restoreErrorText({ details: {} }), null)
  assert.equal(restoreErrorText({ details: { blockedOrdinals: [] } }), null, '空数组不算被拒')
  const text = restoreErrorText({ details: { blockedOrdinals: [3, 7] } })
  assert.match(text!, /2 个/)
  assert.match(text!, /无权查看/)
})

test('PREVIEW_INVALID_TEXT 同时说出两种可能（与"404 不区分成因"的纪律一致）', () => {
  assert.match(PREVIEW_INVALID_TEXT, /不存在/)
  assert.match(PREVIEW_INVALID_TEXT, /无权/)
})

/* ------------------------------ 源码守卫 ------------------------------ */

/**
 * 这几条是**防回归**的源码级断言：本轮的改动各自都能被一个"看起来对"的写法悄悄改回去，
 * 而那些改法都不会让上面任何一条纯逻辑用例变红。
 */
const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/**
 * 剥掉注释再断言 —— 本轮的注释里**故意**引用了被禁的旧写法（"旧写法 `version - i - 1`
 * 在截断时会偏移"），不剥的话守卫会因为注释而红，那就成了"注释不能提旧代码"的荒谬约束。
 * 与仓库既有的 `codeOnly` 同款实现。
 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('★ 守卫：恢复必须调四位一体的 restoreVersion，不得退回 savePage', () => {
  const src = read('../src/pages/WikiPage.tsx')
  assert.ok(src.length > 20000, 'WikiPage 读不到内容？反空洞')
  assert.match(src, /api\s*\.\s*restoreVersion\(/, '恢复必须调 api.restoreVersion')
  /*
   * `savePage` 仍然存在（保存正文要用），所以不能断言"文件里没有 savePage"。
   * 要钉的是**恢复路径**不经过它：恢复分支里若又出现 `savePage`，说明有人把
   * "只回正文"的旧实现拿回来了 —— 那会让恢复变成静默的半截动作（权限不回滚）。
   */
  const restoreBlock = src.slice(src.indexOf('const restore = ('))
  const restoreBody = restoreBlock.slice(0, restoreBlock.indexOf('\n  }'))
  assert.ok(restoreBody.length > 200, '恢复分支切片过短？反空洞')
  assert.doesNotMatch(restoreBody, /api\s*\.\s*savePage\(/, '恢复分支不得再走 savePage（只回正文）')
})

test('守卫：?v= 预览态存在，且非法值会清掉 URL', () => {
  const src = read('../src/pages/WikiPage.tsx')
  assert.match(src, /parsePreviewParam\(query\)/, '必须从 query prop 解析 ?v=')
  assert.match(src, /previewRoute\(slug, id\)/, '选择历史版本必须写进 URL（可分享）')
  assert.match(src, /PREVIEW_INVALID_TEXT/, '非法/无权时必须有提示')
  assert.match(src, /onNavigate\(slug\)/, '非法 ?v= 必须把 URL 清回不带参数')
  // 预览态禁用写操作入口
  assert.match(src, /disabled=\{previewing\}/, '预览态下编辑/权限/删除必须禁用')
})

test('守卫：只读视角不给可编辑的版本下拉', () => {
  const picker = read('../src/components/VersionPicker.tsx')
  assert.ok(picker.length > 3000, 'VersionPicker 读不到内容？反空洞')
  assert.match(picker, /export function ReadonlyHistoryButton/, '只读视角需要「历史」入口')
  const page = read('../src/pages/WikiPage.tsx')
  // 静态徽标 + 只读历史入口，都在 canEdit 为假的分支里
  assert.match(page, /<VersionBadge version=\{page\.version\} \/>/, '只读时保留静态徽标')
  assert.match(page, /<ReadonlyHistoryButton/, '只读时给「历史」入口')
})

test('守卫：版本号算法全站只有一处实现（不许再出现 version - index - 1）', () => {
  for (const rel of [
    '../src/components/VersionPicker.tsx',
    '../src/components/VersionDiffDialog.tsx',
    '../src/pages/WikiPage.tsx',
  ]) {
    const src = codeOnly(read(rel))
    assert.ok(src.length > 1000, `${rel} 读不到内容？反空洞`)
    assert.doesNotMatch(
      src,
      /version\s*-\s*(?:index|i)\s*-\s*1/,
      `${rel} 不得再自己推版本号（截断时会整体偏移）—— 用 versionNumberOf`,
    )
  }
})
