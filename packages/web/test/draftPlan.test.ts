/**
 * 草稿逻辑单测（node:test + tsx）。
 *
 * 重点钉住"最坏情况"下的行为：草稿是**防丢失**的最后一道防线，
 * 它自己坏掉（解析失败、误判为可安全恢复）比没有它更糟——用户会以为已保住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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

/* ---------- 源码守卫：写盘失败不得谎报"草稿已自动保存" ---------- */

/** 剥掉块注释与行注释（注释里会引用被禁的写法，会让负向/位置断言假阳性） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/*
 * 为什么这条必须做成源码级：`localStorage.setItem` 在**配额满或隐私模式**下会抛异常，
 * 而"草稿已自动保存"是用户判断"能不能放心关掉页面"的唯一依据。谎报的代价是丢内容，
 * 且它在开发机上**永远复现不出来**（写盘一直是成功的）。所以只能靠结构断言钉住两件事：
 *  1. 调用点必须真的接住返回值（`const ok = writeDraft(`）；
 *  2. 渲染"已保存"时间戳的 `setDraftSavedAt(...)` 必须紧跟 `if (ok)` —— 判断一旦被拆掉，
 *     最近的 `if (ok)` 就会离它远超过 200 字符，测试立刻变红。
 */
test('源码守卫：WikiPage 只在草稿真的落盘后才显示「已保存」', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(join(here, '..', 'src', 'pages', 'WikiPage.tsx'), 'utf8')
  const src = codeOnly(raw)
  // 反空洞：读空了（路径改动）会让下面"每次出现都在 if (ok) 之后"恒真
  assert.ok(src.length > 5000, `WikiPage.tsx 读入异常（仅 ${src.length} 字符），路径可能不对`)

  assert.match(src, /const ok = writeDraft\(/, '写草稿的返回值必须被接住（writeDraft 返回 boolean）')

  const marks = [...src.matchAll(/setDraftSavedAt\(/g)].map((m) => m.index ?? -1)
  assert.ok(marks.length >= 1, '应至少有一处 setDraftSavedAt，否则时间戳根本不会更新')
  for (const at of marks) {
    assert.ok(at > 0, '无法定位 setDraftSavedAt 的偏移')
    const before = src.slice(Math.max(0, at - 200), at)
    assert.match(
      before,
      /if \(ok\)/,
      `setDraftSavedAt 未受 if (ok) 守卫（前后文：${src.slice(Math.max(0, at - 60), at + 30)}）`,
    )
  }
})
