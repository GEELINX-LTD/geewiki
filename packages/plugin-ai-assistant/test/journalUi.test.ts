/**
 * 回退 UI 的纯逻辑测试（P4：mutation journal 的浏览器一侧）。
 *
 * 这一组用例覆盖的东西有一个共同点：**它们出错时都不会崩**。
 * 日志解析漏了一条 ⇒ 少一个回退入口；冲突原因没说清 ⇒ 用户以为按钮坏了；
 * 客户端步骤算成功 ⇒ 用户以为草稿撤了、其实没动。全部是"安静地不对"，
 * 所以每一条都要在这里钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  ackRestored,
  collectSnapshots,
  JOURNAL_ACK_PATH,
  JOURNAL_PATH,
  JOURNAL_UNDO_PATH,
  EDITOR_DOMAIN,
  EDITOR_DOMAIN_OWNER,
  mutatingCalls,
  parseJournalTurns,
  parseUndoReport,
  readDocText,
  readJournal,
  recordClientMutation,
  runRestoreSteps,
  undoHeadline,
  undoTurn,
  type JournalTransport,
  type TurnToolCallView,
} from '../ui/dockPlan.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 记录调用并按脚本作答的假传输 */
function fakeTransport(
  replies: { ok: boolean; status: number; body: unknown }[],
): { transport: JournalTransport; seen: { method: string; path: string; body: unknown }[] } {
  const seen: { method: string; path: string; body: unknown }[] = []
  let i = 0
  const transport: JournalTransport = (method, path, body) => {
    seen.push({ method, path, body })
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    return Promise.resolve(reply ?? { ok: true, status: 200, body: null })
  }
  return { transport, seen }
}

const call = (name: string, args = '{}'): TurnToolCallView => ({ id: `id-${name}`, name, arguments: args })

/* ============================== 日志解析 ============================== */

test('parseJournalTurns：`pending` 是**条数**、条目在 `records` 里（服务端 `TurnGroup` 的形状）', () => {
  /*
   * 这条用例钉的是一个真踩过的坑：P4 初版把 `pending` 写成了数组，
   * 于是 `pending.length` 恒为 `undefined`，**回退入口一个都不显示，且不报错**。
   */
  const turns = parseJournalTurns({
    ok: true,
    turns: [
      {
        turnId: 't1',
        at: '2026-01-01T00:00:00Z',
        tools: ['page.update'],
        pending: 1,
        records: [{ id: 7, turnId: 't1', tool: 'page.update', domain: 'page', target: 'home', before: 'a', after: 'b', undoneAt: null }],
      },
      { turnId: '', pending: 0, records: [] }, // 没 id ⇒ 没法定位回退目标，丢掉
      null,
      '垃圾',
      {
        turnId: 't2',
        pending: 1,
        records: [{ id: '不是数字' }, { id: 9, domain: 'editor', target: '', before: null, after: 'x' }],
      },
    ],
  })
  assert.equal(turns.length, 2, '只有两条能认出 turnId')
  assert.equal(turns[0]?.pending, 1)
  assert.equal(turns[0]?.records.length, 1)
  assert.equal(turns[0]?.records[0]?.id, 7)
  assert.equal(turns[1]?.records.length, 1, '坏记录被丢掉，好记录留下')
  assert.equal(turns[1]?.records[0]?.before, null, 'null 是"当时不存在"，不能被读成空串')
  assert.equal(turns[1]?.pending, 1, '服务端给的计数原样保留')
})

test('parseJournalTurns：服务端没给 `pending` 计数时**从记录现算**（猜 0 会让入口消失）', () => {
  const turns = parseJournalTurns({
    turns: [
      {
        turnId: 't1',
        records: [
          { id: 1, undoneAt: null },
          { id: 2, undoneAt: '2026-01-01T00:00:00Z' },
        ],
      },
    ],
  })
  assert.equal(turns[0]?.pending, 1, '已撤销的那条不算待撤')
})

test('parseJournalTurns：整个响应不是对象 ⇒ 空列表（界面只是少一块，不是崩）', () => {
  assert.deepEqual(parseJournalTurns(null), [])
  assert.deepEqual(parseJournalTurns({ turns: 'nope' }), [])
})

test('readJournal：GET 到正确的路径，非 2xx 时返回空列表而不是半份数据', async () => {
  const { transport, seen } = fakeTransport([{ ok: false, status: 401, body: { error: 'unauthorized' } }])
  assert.deepEqual(await readJournal(transport, 'c 1'), [], '拿不到就不显示回退入口')
  assert.equal(seen[0]?.method, 'GET')
  assert.match(seen[0]?.path ?? '', /^\/api\/ai\/journal\?conversationId=c%201$/, '会话 id 必须转义')
})

/* ============================== 收窄：哪些调用是写操作 ============================== */

test('mutatingCalls：判定权在服务端，客户端只按名单过滤', () => {
  const calls = [call('editor.read_doc'), call('editor.insert_text'), call('editor.replace_selection')]
  assert.deepEqual(
    mutatingCalls(calls, ['editor.insert_text']).map((c) => c.name),
    ['editor.insert_text'],
  )
  assert.deepEqual(mutatingCalls(calls, ['editor.insert_text', 'editor.replace_selection']).map((c) => c.name), [
    'editor.insert_text',
    'editor.replace_selection',
  ])
})

test('mutatingCalls：服务端没给名单（旧的 done 帧）⇒ 一律不当写操作', () => {
  const calls = [call('editor.insert_text')]
  assert.deepEqual(mutatingCalls(calls, undefined), [], '不知道是不是写操作时，宁可不记也不乱记')
  assert.deepEqual(mutatingCalls(calls, []), [])
})

/* ============================== 回退报告 ============================== */

test('parseUndoReport：三条结果分别解析，冲突取 reason、失败取 detail', () => {
  const report = parseUndoReport({
    undone: [{ detail: '已把 home 的正文还原' }],
    failed: [{ detail: '页面已被删除' }],
    conflicts: [{ expected: 'x', actual: 'y', reason: 'home 在 AI 改完之后又被改动过' }],
    clientSteps: [{ record: { id: 3, domain: 'editor', target: 'home', before: '旧草稿', after: '新草稿', undoneAt: null }, expected: '新草稿' }],
  })
  assert.deepEqual(report.undone, ['已把 home 的正文还原'])
  assert.deepEqual(report.failed, ['页面已被删除'])
  assert.deepEqual(report.conflicts, ['home 在 AI 改完之后又被改动过'])
  assert.equal(report.clientSteps.length, 1)
  assert.equal(report.clientSteps[0]?.record.before, '旧草稿')
})

test('undoHeadline：**没撤的必须说出来**（只报成功的界面等于说谎）', () => {
  assert.equal(undoHeadline({ undone: ['a', 'b'], failed: [], conflicts: [], clientSteps: [] }), '已撤销 2 处改动。')
  const mixed = undoHeadline({ undone: ['a'], failed: ['x'], conflicts: ['y'], clientSteps: [] })
  assert.match(mixed, /已撤销 1 处改动/)
  assert.match(mixed, /1 处没能撤销/)
  assert.match(mixed, /1 处被拒绝/)
  assert.equal(
    undoHeadline({ undone: [], failed: [], conflicts: [], clientSteps: [] }),
    '这一轮没有需要撤销的改动。',
  )
})

test('undoTurn：POST 到回退端点；默认**不替页面自报**当前值（服务端有探针）', async () => {
  const { transport, seen } = fakeTransport([{ ok: true, status: 200, body: { undone: ['ok'] } }])
  await undoTurn(transport, 'c1', 't1')
  assert.equal(seen[0]?.method, 'POST')
  assert.equal(seen[0]?.path, JOURNAL_UNDO_PATH)
  const body = seen[0]?.body as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), ['conversationId', 'snapshots', 'turnId'])
  assert.deepEqual(body['snapshots'], {}, '默认空快照：页面域由服务端探针说了算')
})

test('undoTurn：`editor` 域必须自报当前值（服务端没有它的读路径）', async () => {
  const { transport, seen } = fakeTransport([{ ok: true, status: 200, body: {} }])
  await undoTurn(transport, 'c1', 't1', { 'editor:home': '当前草稿' })
  assert.deepEqual((seen[0]?.body as Record<string, unknown>)['snapshots'], { 'editor:home': '当前草稿' })
})

test('collectSnapshots：读得到草稿就报，读不到就**不报**（不拿空串顶替）', async () => {
  const records = [
    { id: 1, turnId: 't1', tool: 'editor.insert_text', domain: 'editor', target: 'home', before: 'a', after: 'b', undoneAt: null },
    { id: 2, turnId: 't1', tool: 'page.update', domain: 'page', target: 'home', before: 'a', after: 'b', undoneAt: null },
    { id: 3, turnId: 't1', tool: 'editor.insert_text', domain: 'editor', target: 'home', before: 'a', after: 'b', undoneAt: '2026-01-01T00:00:00Z' },
  ]
  assert.deepEqual(
    await collectSnapshots(records, () => Promise.resolve({ text: '当前草稿' })),
    { 'editor:home': '当前草稿' },
    '只报 editor 域、只报还没撤的；页面域交给服务端探针',
  )
  assert.deepEqual(
    await collectSnapshots(records, () => Promise.reject(new Error('没有编辑框'))),
    {},
    '读不到就不报：那一条会进 conflicts 并说明原因，而不是拿空串冒险',
  )
})

/* ============================== 记录客户端写操作 ============================== */

test('recordClientMutation：写进 `editor` 域，前后两份草稿都在', async () => {
  const { transport, seen } = fakeTransport([{ ok: true, status: 200, body: { id: 1 } }])
  const ok = await recordClientMutation(transport, {
    conversationId: 'c1',
    turnId: 't1',
    tool: 'editor.insert_text',
    target: 'home',
    before: '旧草稿',
    after: '旧草稿 + 新内容',
  })
  assert.equal(ok, true)
  assert.equal(seen[0]?.path, JOURNAL_PATH)
  assert.deepEqual(seen[0]?.body, {
    conversationId: 'c1',
    turnId: 't1',
    // ★ `owner` 必填：漏了它服务端回 `400 owner 必须是字符串`，
    // 而表现是"编辑框的改动没进日志"，一个只会静默少东西的失败
    owner: EDITOR_DOMAIN_OWNER,
    tool: 'editor.insert_text',
    domain: EDITOR_DOMAIN,
    target: 'home',
    before: '旧草稿',
    after: '旧草稿 + 新内容',
  })
})

test('readDocText：没有编辑框时返回 null（不是抛错，也不是空串）', async () => {
  assert.equal(await readDocText(() => Promise.reject(new Error('editor.read_doc 未登记'))), null)
  assert.equal(await readDocText(() => Promise.resolve({ slug: 'home' })), null, '没有 text 字段 ⇒ 说不出来')
  assert.equal(await readDocText(() => Promise.resolve({ text: '' })), '', '空草稿是一个**值**，与"说不出来"不同')
})

/* ============================== 客户端步骤（草稿还原） ============================== */

test('runRestoreSteps：用 before 调 `editor.restore_doc`，并回收成功的 id', async () => {
  const calls: { name: string; args: unknown }[] = []
  const invoke = (name: string, args: unknown): Promise<unknown> => {
    calls.push({ name, args })
    return Promise.resolve({ ok: true })
  }
  const out = await runRestoreSteps(
    [{ record: { id: 5, turnId: 't1', tool: 'editor.insert_text', domain: 'editor', target: 'home', before: '旧草稿', after: '新草稿', undoneAt: null }, expected: '新草稿' }],
    invoke,
  )
  assert.deepEqual(out.restored, [5])
  assert.deepEqual(out.failed, [])
  assert.equal(calls[0]?.name, 'editor.restore_doc')
  assert.deepEqual(calls[0]?.args, { text: '旧草稿' }, '必须还原到 before，不是 expected')
})

test('runRestoreSteps：执行失败 ⇒ 进 failed，**不算已还原**（否则 ack 会把没动过的记成撤了）', async () => {
  const out = await runRestoreSteps(
    [{ record: { id: 5, turnId: 't1', tool: 'editor.insert_text', domain: 'editor', target: 'home', before: '旧草稿', after: '新草稿', undoneAt: null }, expected: '新草稿' }],
    () => Promise.reject(new Error('当前不在编辑页，没有编辑框')),
  )
  assert.deepEqual(out.restored, [])
  assert.equal(out.failed.length, 1)
  assert.match(out.failed[0] ?? '', /当前不在编辑页/)
})

test('runRestoreSteps：`before` 为 null（新建）⇒ 明确说不出为什么，不猜', async () => {
  const out = await runRestoreSteps(
    [{ record: { id: 6, turnId: 't1', tool: 'x', domain: 'editor', target: 'home', before: null, after: '新草稿', undoneAt: null }, expected: '新草稿' }],
    () => Promise.resolve({}),
  )
  assert.deepEqual(out.restored, [])
  assert.match(out.failed[0] ?? '', /新建/)
})

test('ackRestored：空名单不发请求（免得每轮都打一个什么都不做的 POST）', async () => {
  const { transport, seen } = fakeTransport([{ ok: true, status: 200, body: {} }])
  await ackRestored(transport, [])
  assert.equal(seen.length, 0)
  await ackRestored(transport, [3, 4])
  assert.equal(seen[0]?.path, JOURNAL_ACK_PATH)
  assert.deepEqual((seen[0]?.body as Record<string, unknown>)['ids'], [3, 4])
})

/* ============================== 源码守卫 ============================== */

test('源码守卫：会话核心仍然不得自己拼路由（回退按钮也不许）', () => {
  const src = readFileSync(join(HERE, '../ui/index.tsx'), 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/location\.hash|window\.location/.test(stripped), false, '路由真源在宿主：插件只能经 openPage / onAsk')
})

test('源码守卫：变更日志的三个端点名必须与服务端逐字相同', () => {
  const server = readFileSync(join(HERE, '../src/index.ts'), 'utf8')
  // 端点在 journal 插件里定义，本包只是消费方；断言的是"这两个常量没被改写"
  assert.equal(JOURNAL_PATH, '/api/ai/journal')
  assert.equal(JOURNAL_UNDO_PATH, '/api/ai/journal/undo')
  assert.equal(JOURNAL_ACK_PATH, '/api/ai/journal/undo/ack')
  // 服务端（Journal 插件）里的字面量同源；这里顺带确认会话核心没有二次定义端点
  assert.equal(/api\/ai\/journal/.test(server), false, 'ai-assistant 的服务端不认识日志端点——回退是浏览器与 journal 之间的事')
})
