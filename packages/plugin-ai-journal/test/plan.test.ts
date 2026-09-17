/**
 * `planRollback` / `groupByTurn` / `checkSelfLock` 的行为测试（设计文档 §4.3、§4.4）。
 *
 * 这里**不碰 cordis、不碰 HTTP、不碰数据库**——回退规划是纯函数，全部行为都能直接断言。
 * 这是刻意的分工：回退是破坏性操作，而它出错的方式很安静（少撤一条 = "AI 说改了其实没改"；
 * 多撤一条 = 把别人的编辑一起覆盖），所以判据必须住在能被逐条钉死的地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describe as describeValue,
  groupByTurn,
  planRollback,
  checkSelfLock,
  PROTECTED_AI_NODES,
} from '../src/plan.js'
import type { MutationRecord } from '../src/types.js'

let nextId = 1

function rec(partial: Partial<MutationRecord> & Pick<MutationRecord, 'target'>): MutationRecord {
  const id = nextId++
  // `target` 只在 spread 里出现一次：两边都写会触发 TS2783（"指定了多次"），
  // 而那正是"我以为自己覆盖了、其实没有"这类错误要防的形状。
  const base: Omit<MutationRecord, 'target'> = {
    id,
    conversationId: 'c1',
    turnId: 't1',
    owner: '@geewiki/ai-kb',
    tool: 'page.update',
    domain: 'page',
    before: null,
    after: null,
    at: `2026-09-14T10:00:${String(id).padStart(2, '0')}.000Z`,
    undoneAt: null,
  }
  return { ...base, ...partial }
}

/** 便捷：所有目标的当前值都等于记录的 after（即"没人动过"） */
const consistent = (record: MutationRecord): string | null => record.after

/* ============================== planRollback ============================== */

test('planRollback：当前值与 after 一致 ⇒ 进 steps，无冲突', () => {
  const records = [rec({ target: 'home', before: '旧', after: '新' })]
  const plan = planRollback(records, consistent)
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0]?.target, 'home')
  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.alreadyUndone.length, 0)
})

test('planRollback：**倒序**执行——后做的先撤', () => {
  const records = [
    rec({ target: 'a', turnId: 't1' }),
    rec({ target: 'b', turnId: 't1' }),
    rec({ target: 'c', turnId: 't1' }),
  ]
  const plan = planRollback(records, consistent)
  assert.deepEqual(
    plan.steps.map((r) => r.target),
    ['c', 'b', 'a'],
  )
})

test('planRollback：当前值被改过 ⇒ 拒绝**那一条**（不是拒绝整次回退）', () => {
  const records = [
    rec({ target: 'a', after: 'A' }),
    rec({ target: 'b', after: 'B' }),
    rec({ target: 'c', after: 'C' }),
  ]
  // b 在 AI 改完之后又被人改了
  const plan = planRollback(records, (r) => (r.target === 'b' ? '别人改的' : r.after))
  assert.deepEqual(
    plan.steps.map((r) => r.target),
    ['c', 'a'],
    'a 与 c 仍应被回退——冲突只拒绝它自己那一条',
  )
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0]?.record.target, 'b')
  assert.equal(plan.conflicts[0]?.expected, 'B')
  assert.equal(plan.conflicts[0]?.actual, '别人改的')
  assert.match(plan.conflicts[0]?.reason ?? '', /又被改动过/)
  assert.match(plan.conflicts[0]?.reason ?? '', /拒绝这一条/)
})

test('planRollback：「没提供当前值」按冲突处理，绝不按"一致"处理', () => {
  const records = [rec({ target: 'a', after: 'A' })]
  const plan = planRollback(records, () => undefined)
  assert.equal(plan.steps.length, 0, '不知道"现在是什么"时不敢撤')
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0]?.actual, undefined)
  assert.match(plan.conflicts[0]?.reason ?? '', /没有拿到 page:a 的当前值/)
})

test('planRollback：`null` 是"现在不存在"，与 undefined（"不知道"）分属两条路', () => {
  const deleted = rec({ target: 'a', before: 'x', after: null })
  // 现在确实是 null（删除状态一致）⇒ 可撤
  assert.equal(planRollback([deleted], () => null).steps.length, 1)
  // 现在是 undefined（没提供）⇒ 拒
  assert.equal(planRollback([deleted], () => undefined).conflicts.length, 1)
})

test('planRollback：已撤销的记录不再撤，进 alreadyUndone', () => {
  const records = [
    rec({ target: 'a', undoneAt: '2026-09-14T11:00:00.000Z' }),
    rec({ target: 'b' }),
  ]
  const plan = planRollback(records, consistent)
  assert.deepEqual(
    plan.steps.map((r) => r.target),
    ['b'],
  )
  assert.deepEqual(
    plan.alreadyUndone.map((r) => r.target),
    ['a'],
  )
})

test('planRollback：空输入 ⇒ 三份产物都空（不抛错）', () => {
  const plan = planRollback([], consistent)
  assert.deepEqual(plan, { steps: [], conflicts: [], alreadyUndone: [] })
})

test('planRollback：冲突与步骤互斥——同一条记录不会既撤又报冲突', () => {
  const records = [rec({ target: 'a', after: 'A' }), rec({ target: 'b', after: 'B' })]
  const plan = planRollback(records, (r) => (r.target === 'a' ? '不一致' : r.after))
  const stepIds = new Set(plan.steps.map((r) => r.id))
  for (const conflict of plan.conflicts) {
    assert.equal(stepIds.has(conflict.record.id), false, '冲突的记录不得出现在 steps 里')
  }
  for (const done of plan.alreadyUndone) {
    assert.equal(stepIds.has(done.id), false, '已撤销的记录不得出现在 steps 里')
  }
})

test('planRollback：冲突的判定逐个目标独立（一个不一致不影响另一个）', () => {
  const records = [rec({ target: 'a', after: 'A' }), rec({ target: 'b', after: 'B' })]
  const plan = planRollback(records, (r) => (r.target === 'b' ? 'x' : r.after))
  assert.deepEqual(
    plan.steps.map((r) => r.target),
    ['a'],
  )
  assert.deepEqual(
    plan.conflicts.map((c) => c.record.target),
    ['b'],
  )
})

/* ============================== describe ============================== */

test('describe：四种值各有明确的说法，长文不整段进消息', () => {
  assert.equal(describeValue(undefined), '（未提供）')
  assert.equal(describeValue(null), '（不存在）')
  assert.equal(describeValue('   '), '（空）')
  assert.equal(describeValue('短文本'), '「短文本」')
  const long = 'x'.repeat(100)
  const out = describeValue(long, 10)
  assert.match(out, /^「x{10}…」/)
  assert.match(out, /共 100 字符/)
})

test('describe：多行正文压成一行（冲突文案里换行会让消息结构散掉）', () => {
  assert.equal(describeValue('第一行\n\n第二行'), '「第一行 第二行」')
})

/* ============================== groupByTurn ============================== */

test('groupByTurn：按 turnId 分组，最近的一轮在最前', () => {
  const records = [
    rec({ turnId: 't1', target: 'a', at: '2026-09-14T10:00:00.000Z' }),
    rec({ turnId: 't2', target: 'b', at: '2026-09-14T10:05:00.000Z' }),
    rec({ turnId: 't1', target: 'c', at: '2026-09-14T10:00:01.000Z' }),
  ]
  const groups = groupByTurn(records)
  assert.deepEqual(
    groups.map((g) => g.turnId),
    ['t2', 't1'],
  )
  const t1 = groups.find((g) => g.turnId === 't1')
  assert.deepEqual(
    t1?.records.map((r) => r.target),
    ['a', 'c'],
    '组内保持发生顺序（planRollback 要靠它倒过来）',
  )
})

test('groupByTurn：pending 只数未撤销的；撤干净的一轮 pending=0', () => {
  const records = [
    rec({ turnId: 't1', target: 'a' }),
    rec({ turnId: 't1', target: 'b', undoneAt: '2026-09-14T12:00:00.000Z' }),
    rec({ turnId: 't2', target: 'c', undoneAt: '2026-09-14T12:00:00.000Z' }),
  ]
  const groups = groupByTurn(records)
  assert.equal(groups.find((g) => g.turnId === 't1')?.pending, 1)
  assert.equal(groups.find((g) => g.turnId === 't2')?.pending, 0, '撤干净的一轮（UI 据此禁用按钮）')
})

test('groupByTurn：tools 去重且按首次出现排序；at 取该轮最早一条', () => {
  const records = [
    rec({ turnId: 't1', target: 'a', tool: 'page.update', at: '2026-09-14T10:00:05.000Z' }),
    rec({ turnId: 't1', target: 'b', tool: 'editor.insert_text', at: '2026-09-14T10:00:01.000Z' }),
    rec({ turnId: 't1', target: 'c', tool: 'page.update', at: '2026-09-14T10:00:09.000Z' }),
  ]
  const group = groupByTurn(records)[0]
  assert.deepEqual(group?.tools, ['page.update', 'editor.insert_text'])
  assert.equal(group?.at, '2026-09-14T10:00:01.000Z')
})

test('groupByTurn：空输入 ⇒ 空数组', () => {
  assert.deepEqual(groupByTurn([]), [])
})

/* ============================== 自锁护栏（决策 13） ============================== */

test('checkSelfLock：四个受保护节点逐个命中', () => {
  for (const node of PROTECTED_AI_NODES) {
    const violation = checkSelfLock([node])
    assert.notEqual(violation, null, `${node} 必须被拦住`)
    assert.equal(violation?.node, node)
    assert.match(violation?.reason ?? '', /依赖链/)
  }
})

test('checkSelfLock：护栏覆盖的是整条依赖链，不只是助手自己', () => {
  // 这条用例存在的意义：只保护 @geewiki/ai-assistant 是不够的——
  // 停掉 llm 或 ai-tools，助手同样失去继续工作的能力。
  assert.notEqual(checkSelfLock(['@geewiki/llm']), null)
  assert.notEqual(checkSelfLock(['@geewiki/ai-tools']), null)
  assert.notEqual(checkSelfLock(['@geewiki/ai-journal']), null)
})

test('checkSelfLock：普通插件放行（护栏不能变成"什么都不让做"）', () => {
  assert.equal(checkSelfLock([]), null)
  assert.equal(checkSelfLock(['@geewiki/echo']), null)
  assert.equal(checkSelfLock(['@geewiki/echo', '@geewiki/ui-demo']), null)
})

test('checkSelfLock：列表里混着一个受保护节点也拦住（不是只看第一个）', () => {
  const violation = checkSelfLock(['@geewiki/echo', '@geewiki/llm', '@geewiki/wiki'])
  assert.equal(violation?.node, '@geewiki/llm')
})
