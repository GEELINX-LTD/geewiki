import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HttpRouterService } from '@geewiki/core'
import { resolveDependency } from '../../manager/src/deps.js'
import { writeScaffold } from '../../manager/src/scaffold.js'
import { buildRegistry, startServer, STRICT_ROUTE_ACCESS_ENV } from '../src/index.js'
import { freePort } from './helpers.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('插件模板与官方示例：依赖声明真实，公开路由可通过严格审计并归因', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-scaffold-audit-'))
  const pluginsRoot = join(dir, 'plugins')
  const previousStrict = process.env[STRICT_ROUTE_ACCESS_ENV]
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    writeScaffold(pluginsRoot, {
      name: 'scaffold-demo', displayName: '脚手架回归', description: '真实发现与路由审计',
      withUi: false, hotReload: true,
    })
    for (const [name, entry] of [['hello-geewiki', 'index.ts'], ['ui-demo', 'src/index.ts']] as const) {
      const target = join(pluginsRoot, name)
      mkdirSync(dirname(join(target, entry)), { recursive: true })
      copyFileSync(join(repoRoot, 'plugins', name, 'package.json'), join(target, 'package.json'))
      copyFileSync(join(repoRoot, 'plugins', name, entry), join(target, entry))
    }
    const port = await freePort()
    const built = await buildRegistry(null, { port, host: '127.0.0.1' }, pluginsRoot, () => ({}))
    assert.deepEqual(built.issues, [])
    const cases = [
      { name: '@geewiki-plugin/scaffold-demo', path: '/api/scaffold-demo', token: 'scaffold-demo-service' },
      { name: '@geewiki-plugin/hello', path: '/api/hello', token: 'hello-service' },
      { name: '@geewiki-plugin/ui-demo', path: '/api/ui-demo', token: 'ui-demo-service' },
    ]
    await t.test('依赖方不会将仅注册路由的插件解析为服务提供者', () => {
      for (const item of cases) {
        assert.ok(resolveDependency(built.registry, item.name), '插件名仍可作为依赖')
        assert.equal(resolveDependency(built.registry, item.token), undefined, `${item.token} 没有真实提供者`)
      }
    })
    await t.test('严格模式启动后匿名可访问示例，每条路由显式公开且归属正确', async () => {
      writeFileSync(join(dir, 'plugins.base.json'), JSON.stringify({
        enabled: [{ name: '@geewiki/http' }, ...cases.map(({ name }) => ({ name }))],
      }))
      process.env[STRICT_ROUTE_ACCESS_ENV] = '1'
      handle = await startServer({
        registry: built.registry, configDir: dir, port, host: '127.0.0.1',
        requiredServices: ['http'], webDist: null,
      })
      const router = handle.app.get('http') as HttpRouterService
      for (const item of cases) {
        const route = router.routes?.().find((r) => r.path === item.path)
        assert.ok(route, `${item.path} 必须真实注册`)
        assert.equal(route.explicit, true)
        assert.equal(route.access, 'public')
        assert.equal(route.owner, item.name)
        const response = await fetch(`http://127.0.0.1:${port}${item.path}`)
        assert.equal(response.status, 200)
        assert.equal((await response.json() as { service: string }).service, item.name)
        assert.equal(router.ownerStats?.().find((s) => s.owner === item.name)?.requests, 1)
      }
    })
  } finally {
    if (handle) await handle.dispose()
    if (previousStrict === undefined) delete process.env[STRICT_ROUTE_ACCESS_ENV]
    else process.env[STRICT_ROUTE_ACCESS_ENV] = previousStrict
    rmSync(dir, { recursive: true, force: true })
  }
})
