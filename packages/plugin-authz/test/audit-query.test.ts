/**
 * `/api/admin/audit` 的查询语义测试。
 *
 * 见 `src/audit-query.ts` 文件头：这段逻辑的风险不在"能不能查"，而在三种**静默**错法
 * （参数顺序错位、匿名的 NULL、非法值静默忽略）—— 三者的症状都是"返回空集"，
 * 而空集在这里读起来就是"没有这类事件"。所以下面每一条 `?` 都必须有对应的参数，
 * 且参数的值必须落在它该在的位置上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_PAGE_MAX, planAuditQuery, type AuditQueryResult } from '../src/audit-query.js'

const ACL = ['page.visibility', 'page.grant'] as const
const SECURITY = ['acl.denied', 'page.read_denied'] as const

const plan = (query: string): AuditQueryResult =>
  planAuditQuery({
    q: new URLSearchParams(query),
    aclActions: ACL,
    securityActions: SECURITY,
  })

/** 取出成功结果，顺带断言"占位符个数 == 参数个数" */
function ok(result: AuditQueryResult): {
  view: string
  where: string
  params: unknown[]
  limit: number
  offset: number
} {
  assert.equal(result.ok, true, `期望成功，实际失败：${result.ok ? '' : result.message}`)
  if (!result.ok) throw new Error('unreachable')
  const p = result.plan
  /*
   * ★ 这条断言值得对**每个**用例都跑：WHERE 与 params 是两条平行列表，靠 push 的先后
   * 对齐。中间插一个条件而忘了同步插参数，SQL **不会报错** —— 它会把 since 的值拿去比
   * action，然后安静地返回空集。占位符数与参数数一致是这里唯一能自动发现它的判据。
   */
  assert.equal(
    (p.where.match(/\?/g) ?? []).length,
    p.params.length,
    `占位符与参数数量不一致：where=${p.where} params=${JSON.stringify(p.params)}`,
  )
  return { view: p.view, where: p.where, params: p.params, limit: p.limit, offset: p.offset }
}

test('view 非法 ⇒ 显式失败（不静默当成 all）', () => {
  const r = plan('view=everything')
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'invalid_view')
})

test('view 缺省 = all，且不加动作白名单', () => {
  const p = ok(plan(''))
  assert.equal(p.view, 'all')
  assert.equal(p.where, '', '无条件时 where 必须是空串（调用方拼的是 FROM audit_log${where}）')
  assert.deepEqual(p.params, [])
})

test('view=acl / security 各自套自己的白名单，参数顺序与白名单一致', () => {
  const acl = ok(plan('view=acl'))
  assert.match(acl.where, /action IN \(\?, \?\)/)
  assert.deepEqual(acl.params, [...ACL], 'acl 视图必须绑 acl 白名单')

  const sec = ok(plan('view=security'))
  assert.deepEqual(sec.params, [...SECURITY], 'security 视图必须绑 security 白名单 —— 绑错了两类记录就混了')
})

test('action / targetKind / targetId 三个精确过滤，空值不写进子句', () => {
  const p = ok(plan('action=page.visibility&targetKind=page&targetId=a%2Fb'))
  assert.match(p.where, /action = \? AND target_kind = \? AND target_id = \?/)
  assert.deepEqual(p.params, ['page.visibility', 'page', 'a/b'])

  const blank = ok(plan('action=&targetKind=&targetId='))
  assert.equal(blank.where, '', '空串不是筛选条件（写进去会恒不命中）')
})

test('since / until 生成范围条件，且**排在**精确过滤之后（参数顺序即语义）', () => {
  const p = ok(plan('action=page.visibility&since=2026-09-01&until=2026-09-30'))
  assert.match(p.where, /action = \? AND at >= \? AND at <= \?/)
  assert.deepEqual(p.params, ['page.visibility', '2026-09-01', '2026-09-30'])
})

test('★ actorId=数字 ⇒ actor_id = ?，且参数落在正确位置', () => {
  const p = ok(plan('since=2026-09-01&actorId=12&until=2026-09-30'))
  assert.match(p.where, /at >= \? AND at <= \? AND actor_id = \?/, 'actorId 排在时间范围之后')
  assert.deepEqual(p.params, ['2026-09-01', '2026-09-30', 12])
  assert.equal(typeof p.params[2], 'number', '必须是数字而不是字符串 —— 绑字符串在部分驱动上会静默不命中')
})

test('★ actorId=anonymous ⇒ `IS NULL`，且**不占参数位**', () => {
  const p = ok(plan('actorId=anonymous'))
  assert.equal(p.where, ' WHERE actor_id IS NULL')
  assert.deepEqual(p.params, [], 'IS NULL 没有占位符，塞一个参数进去会让整条语句错位')
})

test('★ 匿名不能用 `= 0` 冒充（SQL 三值逻辑下恒不命中，看起来像"这个人没做过任何事"）', () => {
  const anon = ok(plan('actorId=anonymous'))
  const zero = ok(plan('actorId=0'))
  assert.notEqual(anon.where, zero.where, '两种意图必须生成不同的 SQL')
  assert.match(zero.where, /actor_id = \?/)
  assert.deepEqual(zero.params, [0], '0 是一个合法的用户 id 写法（虽然现实中不会是），要照常当具体的人')
})

test('★ actorId 非法 ⇒ 显式失败，绝不静默忽略', () => {
  for (const bad of ['abc', '1.5', '-1', 'null', 'NaN', ' ']) {
    if (bad === ' ') continue // 纯空白会被当成"没传"，见下一条
    const r = plan(`actorId=${encodeURIComponent(bad)}`)
    assert.equal(r.ok, false, `actorId=${bad} 应当被拒绝`)
    if (!r.ok) assert.equal(r.code, 'invalid_actor_id')
  }
})

test('actorId 空串 = 不限（与"筛选条被清空"同义）', () => {
  const p = ok(plan('actorId='))
  assert.equal(p.where, '')
  assert.deepEqual(p.params, [])
})

test('limit / offset 夹到合法范围，不报错（与既有语义一致）', () => {
  assert.equal(ok(plan('')).limit, AUDIT_PAGE_MAX, '缺省 = 上限')
  assert.equal(ok(plan('limit=10')).limit, 10)
  assert.equal(ok(plan('limit=99999')).limit, AUDIT_PAGE_MAX, '超过上限夹住')
  assert.equal(ok(plan('limit=0')).limit, 1, '至少 1 条')
  assert.equal(ok(plan('limit=-5')).limit, 1)
  assert.equal(ok(plan('limit=abc')).limit, AUDIT_PAGE_MAX, '非数字退回缺省')
  assert.equal(ok(plan('offset=-5')).offset, 0, '负 offset 归零')
  assert.equal(ok(plan('offset=abc')).offset, 0)
})

test('组合：白名单 + 精确过滤 + 时间范围 + 操作者，四段顺序固定且参数一一对应', () => {
  const p = ok(plan('view=security&targetKind=page&since=2026-09-01&actorId=anonymous&limit=20&offset=40'))
  assert.match(
    p.where,
    /^ WHERE action IN \(\?, \?\) AND target_kind = \? AND at >= \? AND actor_id IS NULL$/,
    '段序：白名单 → 精确匹配 → 时间范围 → 操作者（换序不报错，但会让"排障时对着 SQL 读"失去意义）',
  )
  assert.deepEqual(p.params, [...SECURITY, 'page', '2026-09-01'])
  assert.equal(p.limit, 20)
  assert.equal(p.offset, 40)
})