/**
 * 依赖图/冲突组/热授权链纯函数单元测试（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/manager test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkHotChain,
  collectDependents,
  collectDependentsClosure,
  directDependencies,
  findConflict,
  findUncoveredRequires,
  resolveDependency,
  topologicalOrder,
  type RegisteredPlugin,
} from '../src/deps.js'

function plugin(name: string, partial: Partial<RegisteredPlugin['manifest']> = {}): RegisteredPlugin {
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: {
        provides: partial.geewiki?.provides,
        requires: partial.geewiki?.requires ?? [],
        conflictGroup: partial.geewiki?.conflictGroup,
        migrations: partial.geewiki?.migrations,
        runtime: {
          supportsHotReload: partial.geewiki?.runtime?.supportsHotReload ?? false,
          requiresCachePurge: false,
          drainTimeout: 5,
        },
      },
    },
    module: { name, apply: () => undefined },
  }
}

const registry: RegisteredPlugin[] = [
  plugin('@gw/db', { geewiki: { provides: 'database-provider', conflictGroup: 'database-provider' } }),
  plugin('@gw/http', { geewiki: { provides: 'http-service' } }),
  plugin('@gw/wiki', {
    geewiki: {
      requires: ['@gw/db', '@gw/http'],
      conflictGroup: 'wiki-engine',
      runtime: { supportsHotReload: true },
    },
  }),
  plugin('@gw/editor-hot', {
    geewiki: { requires: ['@gw/wiki'], runtime: { supportsHotReload: true } },
  }),
  plugin('@gw/pg', { geewiki: { provides: 'database-provider', conflictGroup: 'database-provider' } }),
  // 环：a -> b -> a
  plugin('@gw/cycle-a', { geewiki: { requires: ['@gw/cycle-b'] } }),
  plugin('@gw/cycle-b', { geewiki: { requires: ['@gw/cycle-a'] } }),
]

test('resolveDependency：按插件名与服务标识解析', () => {
  assert.equal(resolveDependency(registry, '@gw/db')?.name, '@gw/db')
  assert.equal(resolveDependency(registry, 'database-provider')?.name, '@gw/db')
  assert.equal(resolveDependency(registry, '不存在'), undefined)
})

test('directDependencies：requires 解析为具体插件名', () => {
  assert.deepEqual(directDependencies(registry, '@gw/wiki'), ['@gw/db', '@gw/http'])
  assert.deepEqual(directDependencies(registry, '@gw/db'), [])
})

test('topologicalOrder：被依赖者先于依赖者，无关插件按字母序', () => {
  const order = topologicalOrder(registry, ['@gw/editor-hot', '@gw/wiki', '@gw/http', '@gw/db'])
  const pos = (n: string): number => order.indexOf(n)
  assert.ok(pos('@gw/db') < pos('@gw/wiki'), 'db 应先于 wiki')
  assert.ok(pos('@gw/http') < pos('@gw/wiki'), 'http 应先于 wiki')
  assert.ok(pos('@gw/wiki') < pos('@gw/editor-hot'), 'wiki 应先于 editor-hot')
  assert.equal(order.length, 4)
})

test('topologicalOrder：忽略未启用与未注册插件', () => {
  assert.deepEqual(topologicalOrder(registry, ['@gw/db', 'ghost']), ['@gw/db'])
  assert.deepEqual(topologicalOrder(registry, []), [])
})

test('topologicalOrder：检测依赖环并给出环路径', () => {
  assert.throws(() => topologicalOrder(registry, ['@gw/cycle-a', '@gw/cycle-b']), /依赖环检测/)
})

test('collectDependents：反向依赖（卸载拦截依据）', () => {
  const active = new Set(['@gw/db', '@gw/http', '@gw/wiki', '@gw/editor-hot'])
  assert.deepEqual(collectDependents(registry, active, '@gw/db'), ['@gw/wiki'])
  assert.deepEqual(collectDependents(registry, active, '@gw/wiki'), ['@gw/editor-hot'])
  assert.deepEqual(collectDependents(registry, active, '@gw/editor-hot'), [])
})

test('findConflict：同冲突组互斥，异组/无组不冲突', () => {
  assert.equal(findConflict(registry, new Set(['@gw/db']), '@gw/pg'), '@gw/db')
  assert.equal(findConflict(registry, new Set(['@gw/db']), '@gw/wiki'), undefined)
  assert.equal(findConflict(registry, new Set(), '@gw/pg'), undefined)
})

test('collectDependentsClosure：传递依赖方闭包（冲突组替换的卸载集合依据）', () => {
  // @gw/db ← @gw/wiki ← @gw/editor-hot（多级）
  assert.deepEqual(collectDependentsClosure(registry, ['@gw/db']), ['@gw/editor-hot', '@gw/wiki'])
  // 中间层单独作为根：只闭包到它的依赖方
  assert.deepEqual(collectDependentsClosure(registry, ['@gw/wiki']), ['@gw/editor-hot'])
  // 叶子：无依赖方
  assert.deepEqual(collectDependentsClosure(registry, ['@gw/editor-hot']), [])
  // 空输入
  assert.deepEqual(collectDependentsClosure(registry, []), [])
  // 多根合并去重（@gw/http 同时被 wiki 依赖，与 db 同根时只应出现一次）
  assert.deepEqual(collectDependentsClosure(registry, ['@gw/db', '@gw/http']), ['@gw/editor-hot', '@gw/wiki'])
  // 环安全：a ↔ b 互相依赖，不会死循环且互为依赖方
  assert.deepEqual(collectDependentsClosure(registry, ['@gw/cycle-a']), ['@gw/cycle-b'])
})

test('checkHotChain：热加载链上未激活冷依赖被拦截；已激活冷依赖放行', () => {
  // editor-hot(热) 依赖 wiki(热)；wiki 依赖 db/http（均冷）。全冷未激活 → 两条违规链
  const cold = checkHotChain(registry, new Set(), '@gw/editor-hot')
  assert.equal(cold.length, 2)
  assert.ok(cold.some((p) => p.endsWith('@gw/db')), `应含 db 链: ${cold.join('; ')}`)
  assert.ok(cold.some((p) => p.endsWith('@gw/http')), `应含 http 链: ${cold.join('; ')}`)
  // db/http 均已激活（base 冷驻）→ 热链通过
  const warm = checkHotChain(registry, new Set(['@gw/db', '@gw/http']), '@gw/editor-hot')
  assert.deepEqual(warm, [])
  // 冷插件自身禁热
  assert.equal(checkHotChain(registry, new Set(), '@gw/http').length, 1)
})

test('findUncoveredRequires：指向被顶替者的依赖边必须能被目标承接（按 provides 可承接，按名不可）', () => {
  // 注意：共享夹具里 @gw/wiki 是**按插件名** require '@gw/db'（不是按 provides），
  // 所以即便目标 provides 同名服务，这条按名的边也无法被承接 —— 这正是本函数的严格语义。
  assert.deepEqual(findUncoveredRequires(registry, '@gw/db', '@gw/pg', ['@gw/wiki']), [
    { plugin: '@gw/wiki', token: '@gw/db' },
  ])
  // 与本次替换无关的边（@gw/editor-hot 按名依赖 @gw/wiki，不指向被顶替者）→ 不算违规
  assert.deepEqual(findUncoveredRequires(registry, '@gw/db', '@gw/http', ['@gw/editor-hot']), [])
  // 被顶替者自身没有 requires → 无违规
  assert.deepEqual(findUncoveredRequires(registry, '@gw/db', '@gw/pg', ['@gw/db']), [])
  // 空集合
  assert.deepEqual(findUncoveredRequires(registry, '@gw/db', '@gw/pg', []), [])

  // 局部夹具：依赖方分别按 provides token / 按插件名依赖被顶替者
  const byProvides: RegisteredPlugin[] = [
    plugin('@t/old', { geewiki: { provides: 'db-provider' } }),
    plugin('@t/new', { geewiki: { provides: 'db-provider' } }),
    plugin('@t/app', { geewiki: { requires: ['db-provider'] } }),
  ]
  // 目标提供同一 token → 可承接，放行
  assert.deepEqual(findUncoveredRequires(byProvides, '@t/old', '@t/new', ['@t/app']), [])
  // 目标不提供该 token → 违规
  assert.deepEqual(findUncoveredRequires(byProvides, '@t/old', '@gw/http', ['@t/app']), [
    { plugin: '@t/app', token: 'db-provider' },
  ])
  // 目标与被顶替者同名（实际不会发生：同组互斥且新旧不同名，但分支语义要正确）：
  // 目标 provides 同一 token → 可承接 → 放行
  assert.deepEqual(findUncoveredRequires(byProvides, '@t/old', '@t/old', ['@t/app']), [])

  const byName: RegisteredPlugin[] = [
    plugin('@t/old2', { geewiki: { provides: 'db-provider' } }),
    plugin('@t/new2', { geewiki: { provides: 'db-provider' } }),
    plugin('@t/app2', { geewiki: { requires: ['@t/old2'] } }),
  ]
  // 按**具体插件名**依赖：即使目标 provides 同名 token 也承接不了这条按名的边 → 违规
  assert.deepEqual(findUncoveredRequires(byName, '@t/old2', '@t/new2', ['@t/app2']), [
    { plugin: '@t/app2', token: '@t/old2' },
  ])
  // 若目标的名字恰好等于该 token（按名承接），则放行
  assert.deepEqual(findUncoveredRequires(byName, '@t/old2', '@t/old2', ['@t/app2']), [])
})
