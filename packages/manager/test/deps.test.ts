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
