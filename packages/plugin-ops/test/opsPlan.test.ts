/**
 * `ui/plan.ts` 的纯判据测试。
 *
 * 为什么这些判据值得一条条测：它们**就是这一轮"功能性优化"的全部内容**。
 * 原来的页面把端点返回直接铺成几行裸文本（`mismatched=0 unparseable=0 …`），
 * 运维得自己记住每个字段的正常值 —— 而记错的表现是"看着挺正常"。
 * 现在"什么算异常"是一段有名字、可测的代码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actorLabel,
  AUDIT_PAGE_SIZE,
  auditQuery,
  blocksVerifyVerdict,
  cacheVerdict,
  changedFields,
  clampPage,
  formatTime,
  hasAuditFilters,
  pageCount,
  searchVerifyVerdict,
  sectionById,
  shortValue,
  sitemapVerdict,
  type BlocksVerifyResponse,
  type CachePlanResponse,
  type SearchVerifyResponse,
  type SitemapAuditResponse,
} from '../ui/plan.js'

/* ============================== 查询串 ============================== */

test('auditQuery：view 恒在，筛选值去空白，空值不写进查询串', () => {
  const q = new URLSearchParams(auditQuery('security', { action: '  page.visibility  ', targetKind: '', since: '', until: '' }, 0))
  assert.equal(q.get('view'), 'security')
  assert.equal(q.get('action'), 'page.visibility', '首尾空白必须去掉：带空白的动作名在服务端是精确匹配，会恒不命中')
  assert.equal(q.has('targetKind'), false, '空筛选不得写进查询串（服务端会把它当成一个真的筛选条件）')
  assert.equal(q.get('limit'), String(AUDIT_PAGE_SIZE))
  assert.equal(q.get('offset'), '0')
})

test('auditQuery：offset 不接受负数', () => {
  const q = new URLSearchParams(auditQuery('acl', { action: '', targetKind: '', since: '', until: '' }, -5))
  assert.equal(q.get('offset'), '0')
})

test('hasAuditFilters：只有空白也算没有筛选', () => {
  assert.equal(hasAuditFilters({ action: '   ', targetKind: '', since: '', until: '' }), false)
  assert.equal(hasAuditFilters({ action: '', targetKind: 'page', since: '', until: '' }), true)
})

test('分页：pageCount 至少 1 页；clampPage 把越界页码夹回来', () => {
  assert.equal(pageCount(0, 50), 1, '0 条也是 1 页 —— 报 0 页会让"第 1 / 0 页"这种读法出现')
  assert.equal(pageCount(50, 50), 1)
  assert.equal(pageCount(51, 50), 2)
  // 改筛选后页码越界：后端返回空数组而不报错，看起来像"没有记录" ⇒ 必须夹回来
  assert.equal(clampPage(9, 10, 50), 1)
  assert.equal(clampPage(0, 120, 50), 1)
  assert.equal(clampPage(2, 120, 50), 2)
  assert.equal(clampPage(Number.NaN, 120, 50), 1)
})

/* ============================== 变更明细 ============================== */

test('changedFields：只列真的变了的键（这是"改成了什么"的唯一来源）', () => {
  const diff = changedFields(
    { visibility: 'private', inherit: true, title: '旧' },
    { visibility: 'org', inherit: true, title: '旧' },
  )
  assert.deepEqual(diff, [{ key: 'visibility', before: 'private', after: 'org' }])
})

test('changedFields：只在一边出现的键也算变更（新增/删除字段本身是一次变更）', () => {
  const added = changedFields({ a: 1 }, { a: 1, b: 2 })
  assert.deepEqual(added, [{ key: 'b', before: '（无）', after: '2' }])
  const removed = changedFields({ a: 1, b: 2 }, { a: 1 })
  assert.deepEqual(removed, [{ key: 'b', before: '2', after: '（无）' }])
})

test('changedFields：非对象（null / 数组 / 标量）不炸，返回空', () => {
  assert.deepEqual(changedFields(null, null), [])
  assert.deepEqual(changedFields(undefined, undefined), [])
  assert.deepEqual(changedFields([1, 2], [1, 3]), [], '数组不是记录，不当作字段表来比')
})

test('changedFields：嵌套对象按值比较（改了一个字段就是一次变更）', () => {
  const diff = changedFields({ g: { a: 1, b: 2 } }, { g: { a: 1, b: 3 } })
  assert.equal(diff.length, 1)
  assert.equal(diff[0]?.key, 'g')
})

test('shortValue：超长值截断（变更记录里塞整篇正文是常态）', () => {
  assert.equal(shortValue(undefined), '（无）')
  assert.equal(shortValue(null), 'null')
  assert.equal(shortValue('abc'), 'abc')
  const long = 'x'.repeat(500)
  const out = shortValue(long)
  assert.ok(out.length <= 120, `截断后应不超过 120 字符，实得 ${out.length}`)
  assert.ok(out.endsWith('…'))
})

/* ============================== 呈现辅助 ============================== */

test('formatTime：空值与非法值都显示「—」而不是 Invalid Date 或空白', () => {
  assert.equal(formatTime(null), '—')
  assert.equal(formatTime(''), '—')
  assert.equal(formatTime('不是时间'), '—')
  assert.notEqual(formatTime('2026-09-17T10:00:00Z'), '—')
})

test('actorLabel：没有用户名就如实显示 id，绝不伪装成人名', () => {
  assert.equal(actorLabel(null), '（匿名）')
  assert.equal(actorLabel(12), '#12')
})

test('sectionById：非法/缺失的分区 id 落到默认分区（深链被改坏时不白屏）', () => {
  assert.equal(sectionById('sessions').id, 'sessions')
  assert.equal(sectionById('不存在的分区').id, 'security')
  assert.equal(sectionById('').id, 'security')
})

/* ============================== 结论判据 ============================== */

const searchBase: SearchVerifyResponse = {
  ok: true,
  index: 'present',
  blocks: 100,
  missing: 0,
  extra: 0,
  tier_null: 5,
  granted: 5,
  tier_mismatch: false,
  sampled: 20,
  sample_misses: 0,
  miss_samples: [],
}

test('搜索索引：一切正常 ⇒ ok', () => {
  const v = searchVerifyVerdict(searchBase)
  assert.equal(v.level, 'ok')
  assert.ok(v.lines.some((l) => l.includes('100')), '结论里要带上块数，否则"一致"没有量级')
})

test('搜索索引：索引不存在 ⇒ bad（检索整体失效）', () => {
  const v = searchVerifyVerdict({ ...searchBase, index: 'absent' })
  assert.equal(v.level, 'bad')
  assert.ok(v.headline.includes('不存在'))
})

test('搜索索引：missing > 0 ⇒ bad（有内容搜不到）', () => {
  const v = searchVerifyVerdict({ ...searchBase, missing: 7 })
  assert.equal(v.level, 'bad')
  assert.ok(v.lines.some((l) => l.includes('7')))
})

test('搜索索引：tier 不一致 ⇒ bad（这是越权可搜方向，不只是"不一致"）', () => {
  const v = searchVerifyVerdict({ ...searchBase, tier_null: 9, granted: 5, tier_mismatch: true })
  assert.equal(v.level, 'bad')
  assert.ok(v.lines.some((l) => l.includes('越权')))
})

test('搜索索引：抽样未命中 ⇒ bad（索引与查询口径不一致，比计数不一致更隐蔽）', () => {
  const v = searchVerifyVerdict({ ...searchBase, sample_misses: 2, miss_samples: [3, 9] })
  assert.equal(v.level, 'bad')
  assert.ok(v.lines.some((l) => l.includes('3') && l.includes('9')), '未命中的块 id 要列出来')
})

test('搜索索引：只有 extra > 0 ⇒ warn（只占体积，不影响检索）', () => {
  const v = searchVerifyVerdict({ ...searchBase, extra: 4 })
  assert.equal(v.level, 'warn')
})

const blocksBase: BlocksVerifyResponse = {
  ok: true,
  checked: 10,
  mismatched: 0,
  unparseable: 0,
  tier_checked: 10,
  tier_mismatched: 0,
  tier_check_skipped: false,
  samples: [],
  tier_samples: [],
}

test('块级核对：全一致 ⇒ ok', () => {
  assert.equal(blocksVerifyVerdict(blocksBase).level, 'ok')
})

test('块级核对：mismatched 与 tier_mismatched 是两类，必须分别出现在结论里', () => {
  const v = blocksVerifyVerdict({ ...blocksBase, mismatched: 2, tier_mismatched: 3 })
  assert.equal(v.level, 'bad')
  assert.ok(v.lines.some((l) => l.includes('漂移')), '"块 ↔ 正文"漂移')
  assert.ok(v.lines.some((l) => l.includes('tier')), '"tier ↔ 档位"不符 —— 两类混成一个数就看不出该修哪类')
})

test('块级核对：tier 未检查 ⇒ warn，且**不能**说成"检查通过"', () => {
  const v = blocksVerifyVerdict({ ...blocksBase, tier_check_skipped: true })
  assert.equal(v.level, 'warn')
  assert.ok(
    v.lines.some((l) => l.includes('没有检查')),
    '策略服务缺席时跳过 tier 检查，这必须如实说出来 —— 把"算不了"报成"没问题"是失败开放方向',
  )
})

test('sitemap：泄漏方向非空 ⇒ bad；一致性方向非空 ⇒ warn；都空 ⇒ ok', () => {
  const base: SitemapAuditResponse = { ok: true, sameSource: true, advertisedCount: 3, unreadable: [], omitted: [], consistent: true }
  assert.equal(sitemapVerdict(base).level, 'ok')
  assert.equal(sitemapVerdict({ ...base, omitted: ['a/b'] }).level, 'warn')
  const leaked = sitemapVerdict({ ...base, unreadable: [{ slug: 'a/b', reason: 'private' }] })
  assert.equal(leaked.level, 'bad')
  assert.ok(leaked.lines.some((l) => l.includes('a/b')), '泄漏的 slug 必须点名')
})

test('清缓存指引：建议清 ⇒ warn；否则 ok', () => {
  const base: CachePlanResponse = {
    ok: true,
    since: '2026-09-17T00:00:00Z',
    events: [{ action: 'page.visibility', count: 2 }],
    eventCount: 2,
    purgeRecommended: false,
    sharedCacheable: [{ path: '/api/wiki/x', cacheControl: 'private' }],
    notSharedCacheable: [],
    targets: [],
    note: '说明',
  }
  assert.equal(cacheVerdict(base).level, 'ok')
  const rec = cacheVerdict({ ...base, purgeRecommended: true, targets: ['/api/wiki/*'] })
  assert.equal(rec.level, 'warn')
  assert.ok(rec.lines.some((l) => l.includes('/api/wiki/*')))
})