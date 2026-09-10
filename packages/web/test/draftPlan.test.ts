/**
 * 草稿逻辑单测（node:test + tsx）。
 *
 * 重点钉住"最坏情况"下的行为：草稿是**防丢失**的最后一道防线，
 * 它自己坏掉（解析失败、误判为可安全恢复）比没有它更糟——用户会以为已保住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_KEY_PREFIX,
  DRAFT_MAX_AGE_MS,
  NEW_PAGE_SENTINEL,
  decideDraftRestore,
  draftKey,
  formatDraftAge,
  isDraftExpired,
  parseDraft,
  serializeDraft,
  type DraftRecord,
} from '../src/lib/draftPlan'

const NOW = 1_700_000_000_000

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return { title: '标题', content: '正文', savedAt: NOW - 60_000, baseUpdatedAt: '2026-01-01T00:00:00.000Z', ...over }
}

/* ------------------------- 键名 ------------------------- */

test('draftKey：按 slug 隔离，不同页面不会互相覆盖', () => {
  assert.notEqual(draftKey('page-a'), draftKey('page-b'))
  assert.ok(draftKey('page-a').startsWith(DRAFT_KEY_PREFIX))
})

test('draftKey：新建页（无 slug）用固定哨兵键', () => {
  assert.equal(draftKey(''), DRAFT_KEY_PREFIX + NEW_PAGE_SENTINEL)
  // 哨兵不能与真实 slug 冲突：slug 允许的字符里没有 `:`
  assert.ok(!NEW_PAGE_SENTINEL.includes(':'))
})

/* ------------------------- 解析容错 ------------------------- */

test('parseDraft：坏 JSON / 非对象 / 缺字段一律返回 null（绝不让编辑页打不开）', () => {
  assert.equal(parseDraft(null), null)
  assert.equal(parseDraft(undefined), null)
  assert.equal(parseDraft(''), null)
  assert.equal(parseDraft('{ 坏 json'), null)
  assert.equal(parseDraft('null'), null)
  assert.equal(parseDraft('123'), null)
  assert.equal(parseDraft('"字符串"'), null)
  assert.equal(parseDraft('{"title":"只有标题"}'), null) // 缺 content
  assert.equal(parseDraft('{"title":1,"content":2}'), null) // 类型不对
})

test('parseDraft：合法记录可往返（serialize → parse 等价）', () => {
  const d = draft()
  assert.deepEqual(parseDraft(serializeDraft(d)), d)
})

test('parseDraft：baseUpdatedAt 缺失/类型不对时退化为 null（而不是丢掉整条草稿）', () => {
  const out = parseDraft('{"title":"t","content":"c","savedAt":123,"baseUpdatedAt":42}')
  assert.deepEqual(out, { title: 't', content: 'c', savedAt: 123, baseUpdatedAt: null })
})

test('parseDraft：savedAt 缺失记为 0（会被判为陈旧，从而不会永久堆积）', () => {
  const out = parseDraft('{"title":"t","content":"c"}')
  assert.equal(out?.savedAt, 0)
  assert.equal(isDraftExpired(out as DraftRecord, NOW), true)
})

/* ------------------------- 陈旧判定 ------------------------- */

test('isDraftExpired：超过上限算陈旧；边界内不算', () => {
  assert.equal(isDraftExpired(draft({ savedAt: NOW - DRAFT_MAX_AGE_MS + 1000 }), NOW), false)
  assert.equal(isDraftExpired(draft({ savedAt: NOW - DRAFT_MAX_AGE_MS - 1000 }), NOW), true)
})

/* ------------------------- 恢复决策（本模块最重要的部分） ------------------------- */

test('decideDraftRestore：没有草稿 → none', () => {
  assert.equal(decideDraftRestore(null, { title: 't', content: 'c', updatedAt: 'v1' }), 'none')
})

test('decideDraftRestore：服务端状态未知（尚未加载完）→ none（不拿未知状态做判断）', () => {
  assert.equal(decideDraftRestore(draft(), null), 'none')
})

test('decideDraftRestore：草稿与服务端内容完全一致 → discard（保存成功后的残留）', () => {
  const d = draft({ title: '同', content: '一样' })
  assert.equal(decideDraftRestore(d, { title: '同', content: '一样', updatedAt: 'v9' }), 'discard')
})

test('decideDraftRestore：服务端自草稿以来未变 → restore（可安全恢复）', () => {
  const d = draft({ updatedAt: 'x', baseUpdatedAt: 'rev-1' } as Partial<DraftRecord>)
  const server = { title: '旧', content: '旧正文', updatedAt: 'rev-1' }
  assert.equal(decideDraftRestore({ ...d, title: '新', content: '新正文' }, server), 'restore')
})

test('decideDraftRestore：服务端已更新 → restore-stale（必须问用户，不能静默覆盖）', () => {
  const d = draft({ baseUpdatedAt: 'rev-1', title: '新', content: '新正文' })
  const server = { title: '别人的', content: '别人的正文', updatedAt: 'rev-2' }
  assert.equal(decideDraftRestore(d, server), 'restore-stale')
})

test('decideDraftRestore：baseUpdatedAt 为 null（旧格式草稿）→ 保守判为 stale', () => {
  const d = draft({ baseUpdatedAt: null, title: 'x', content: 'y' })
  assert.equal(decideDraftRestore(d, { title: 'a', content: 'b', updatedAt: 'rev-9' }), 'restore-stale')
})

/* ------------------------- 时长展示 ------------------------- */

test('formatDraftAge：分钟/小时/天的粗粒度展示', () => {
  assert.equal(formatDraftAge(NOW - 30_000, NOW), '刚刚')
  assert.equal(formatDraftAge(NOW - 5 * 60_000, NOW), '5 分钟前')
  assert.equal(formatDraftAge(NOW - 3 * 3600_000, NOW), '3 小时前')
  assert.equal(formatDraftAge(NOW - 2 * 86400_000, NOW), '2 天前')
})

test('formatDraftAge：时钟回拨（savedAt 在未来）不产出负数', () => {
  assert.equal(formatDraftAge(NOW + 60_000, NOW), '刚刚')
})

test('formatDraftAge：非法/缺失时间给"未知时间"（不显示 NaN）', () => {
  assert.equal(formatDraftAge(0, NOW), '未知时间')
  assert.equal(formatDraftAge(Number.NaN, NOW), '未知时间')
})
