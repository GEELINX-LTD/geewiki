/**
 * 插件页面路由**声明裁决**的单元测试（F2）。
 *
 * 这些用例钉住的都是"静默失效"类缺陷：路由 id 冲突若被静默顶替、宿主保留 id 若被放行，
 * 症状都是"用户访问到一个他不认识、但看起来正常的页面"——没有任何报错可循。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESERVED_ROUTE_IDS, type PluginRouteDecl } from '@geewiki/core'
import {
  collectRouteDecls,
  effectiveRoutesByOwner,
  resolveRouteDecls,
  type OwnedRouteDecl,
} from '../src/routes.js'

const decl = (owner: string, id: string, extra: Partial<PluginRouteDecl> = {}): OwnedRouteDecl => ({
  owner,
  route: { id, ...extra },
})

test('resolveRouteDecls：单一声明生效，无冲突', () => {
  const { routes, conflicts } = resolveRouteDecls([decl('p', 'board')], ['p'])
  assert.deepEqual(routes.map((r) => r.route.id), ['board'])
  assert.deepEqual(conflicts, [])
})

test('resolveRouteDecls：宿主保留 id 一律拒绝（不是先到先得，是根本不给）', () => {
  for (const id of ['wiki', 'graph', 'org', 'login', 'notfound']) {
    assert.ok(RESERVED_ROUTE_IDS.includes(id), `${id} 应当仍在保留清单里`)
    const { routes, conflicts } = resolveRouteDecls([decl('p', id)], ['p'])
    assert.deepEqual(routes, [], `插件不得声明保留路由 ${id}——否则它能覆盖内置页面`)
    assert.deepEqual(conflicts, [], '被拒绝的保留 id 不计入冲突（它压根没进裁决）')
  }
})

test('resolveRouteDecls：同一 id 被两方声明 ⇒ 激活顺序最早者胜出，后者可见地被抑制', () => {
  const { routes, conflicts } = resolveRouteDecls([decl('later', 'board'), decl('earlier', 'board')], [
    'earlier',
    'later',
  ])
  assert.equal(routes.length, 1, '同一个 id 只允许一个生效')
  assert.equal(routes[0]!.owner, 'earlier', '激活顺序最早者胜出（不是字典序、也不是先到先得）')
  assert.deepEqual(conflicts, [{ id: 'board', winner: 'earlier', suppressed: ['later'] }])
})

test('resolveRouteDecls：不在激活顺序里的 owner 排最后，且有顺序时不会顶掉已激活者', () => {
  const { routes } = resolveRouteDecls([decl('ghost', 'board'), decl('real', 'board')], ['real'])
  assert.equal(routes[0]!.owner, 'real')
})

test('resolveRouteDecls：同一 owner 重复声明同一 id ⇒ 只留第一条', () => {
  const { routes, conflicts } = resolveRouteDecls(
    [decl('p', 'board', { label: '第一个' }), decl('p', 'board', { label: '第二个' })],
    ['p'],
  )
  assert.equal(routes.length, 1)
  assert.equal(routes[0]!.route.label, '第一个')
  assert.deepEqual(conflicts, [], '同一 owner 内部重复不算跨插件冲突')
})

test('resolveRouteDecls：同一 owner 的不同 id 全部保留', () => {
  const { routes } = resolveRouteDecls([decl('p', 'board'), decl('p', 'report')], ['p'])
  assert.deepEqual(routes.map((r) => r.owner), ['p', 'p'])
  assert.deepEqual(routes.map((r) => r.route.id), ['board', 'report'])
})

test('resolveRouteDecls：输出按 id 字典序（与声明顺序无关，结果可复现）', () => {
  const a = resolveRouteDecls([decl('p', 'zzz'), decl('p', 'aaa')], ['p'])
  const b = resolveRouteDecls([decl('p', 'aaa'), decl('p', 'zzz')], ['p'])
  assert.deepEqual(a.routes.map((r) => r.route.id), ['aaa', 'zzz'])
  assert.deepEqual(
    a.routes.map((r) => r.route.id),
    b.routes.map((r) => r.route.id),
  )
})

test('collectRouteDecls：摊平清单声明，丢弃非法 id 与无 id 项', () => {
  const registry = [
    {
      name: 'ok',
      manifest: { geewiki: { routes: [{ id: 'board', label: '看板', group: 'main' as const }] } },
    },
    // id 含 `/`：它是 hash 首段，不允许
    { name: 'bad-slash', manifest: { geewiki: { routes: [{ id: 'a/b' }] } } },
    // 大写：语法非法
    { name: 'bad-case', manifest: { geewiki: { routes: [{ id: 'Board' }] } } },
    // 无 id
    { name: 'no-id', manifest: { geewiki: { routes: [{} as PluginRouteDecl] } } },
    // 未声明 routes
    { name: 'none', manifest: { geewiki: {} } },
  ]
  const out = collectRouteDecls(registry)
  assert.deepEqual(out.map((d) => `${d.owner}:${d.route.id}`), ['ok:board'])
})

test('effectiveRoutesByOwner：按 owner 分桶（入口表按插件写 routes 字段的数据源）', () => {
  const { routes } = resolveRouteDecls([decl('p', 'board'), decl('p', 'report'), decl('q', 'canvas')], [
    'p',
    'q',
  ])
  const byOwner = effectiveRoutesByOwner(routes)
  assert.deepEqual(byOwner.get('p')?.map((r) => r.id), ['board', 'report'])
  assert.deepEqual(byOwner.get('q')?.map((r) => r.id), ['canvas'])
  assert.equal(byOwner.get('nobody'), undefined)
})
