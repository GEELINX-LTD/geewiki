import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Context } from 'cordis'
import type { HttpRouterService, RouteHandlerContext } from '@geewiki/core'
import type { GeeWikiManager, RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, startServer, STRICT_ROUTE_ACCESS_ENV } from '../src/index.js'
import { freePort } from './helpers.js'

// 模拟未经过 TypeScript 检查的外部 JavaScript 调用。
function registerRaw(router: HttpRouterService, path: string, options?: unknown): () => void {
  const handler = (h: RouteHandlerContext): void => h.json(200, { ok: true })
  const args: unknown[] = ['GET', path, handler]
  if (options !== undefined) args.push(options)
  return Reflect.apply(router.register, router, args) as () => void
}

function plugin(name: string, path: string, options?: unknown): RegisteredPlugin {
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: {
        requires: ['http-service'],
        runtime: { supportsHotReload: true, drainTimeout: 1 },
      },
    },
    module: {
      name,
      apply(ctx: Context) {
        return registerRaw(ctx.get('http') as HttpRouterService, path, options)
      },
    },
  }
}

async function fixture(t: TestContext, mode: string | undefined, plugins: RegisteredPlugin[], boot: string[] = []) {
  const previous = process.env[STRICT_ROUTE_ACCESS_ENV]
  if (mode === undefined) delete process.env[STRICT_ROUTE_ACCESS_ENV]
  else process.env[STRICT_ROUTE_ACCESS_ENV] = mode
  const dir = mkdtempSync(join(tmpdir(), 'gw-access-registration-'))
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  t.after(async () => {
    try {
      await handle?.dispose()
    } finally {
      if (previous === undefined) delete process.env[STRICT_ROUTE_ACCESS_ENV]
      else process.env[STRICT_ROUTE_ACCESS_ENV] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const port = await freePort()
  writeFileSync(join(dir, 'plugins.base.json'), JSON.stringify({
    enabled: ['@geewiki/http', ...boot].map((name) => ({ name })),
  }))
  writeFileSync(join(dir, 'plugins.session.json'), JSON.stringify({ enabled: [] }))
  return {
    port,
    start: async () => {
      handle = await startServer({
        registry: [httpRegistryEntry(null, { port, host: '127.0.0.1' }), ...plugins],
        configDir: dir,
        pluginsDir: null,
        webDist: null,
        requiredServices: ['http'],
      })
      return {
        router: handle.app.get('http') as HttpRouterService,
        manager: handle.app.get('manager') as GeeWikiManager,
      }
    },
    status: async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      await response.arrayBuffer()
      return response.status
    },
  }
}

test('严格模式：启动期的注册失败不能被空路由表掩盖，失败后释放监听端口', async (t) => {
  const bad = plugin('@t/access-boot', '/api/t/boot-implicit')
  const env = await fixture(t, '1', [bad], [bad.name])
  await assert.rejects(env.start(), /GET \/api\/t\/boot-implicit 未显式声明 access/)
  await new Promise<void>((resolveListen, rejectListen) => {
    const probe = createServer()
    probe.once('error', rejectListen)
    probe.listen(env.port, '127.0.0.1', () => probe.close((error) => {
      if (error) rejectListen(error)
      else resolveListen()
    }))
  })
})

test('严格模式：热启用遗漏 access 的插件失败，路由始终未注册，合法插件仍可启停', async (t) => {
  const bad = plugin('@t/access-hot-bad', '/api/t/hot-implicit', {})
  const good = plugin('@t/access-hot-good', '/api/t/hot-public', { access: 'public', owner: '@t/access-hot-good' })
  const env = await fixture(t, '1', [bad, good])
  const { router, manager } = await env.start()
  // 运行模式在路由器创建时固定，后续环境变化不撤掉已开启的约束。
  process.env[STRICT_ROUTE_ACCESS_ENV] = '0'
  await assert.rejects(manager.enable(bad.name), /未显式声明 access/)
  assert.equal(router.routes?.().some((route) => route.path === '/api/t/hot-implicit'), false)
  assert.equal(await env.status('/api/t/hot-implicit'), 404)
  await manager.enable(good.name)
  assert.equal(await env.status('/api/t/hot-public'), 200)
  await manager.disable(good.name)
  assert.equal(await env.status('/api/t/hot-public'), 404)
})

test('非严格兼容：旧 JavaScript 热启用仍可省略声明，非字面量 1 不开启严格模式', async (t) => {
  for (const mode of [undefined, 'true', '0']) {
    await t.test(`mode=${String(mode)}`, async (child) => {
      const legacy = plugin('@t/access-legacy', '/api/t/legacy')
      const env = await fixture(child, mode, [legacy])
      const { router, manager } = await env.start()
      await manager.enable(legacy.name)
      assert.equal(await env.status('/api/t/legacy'), 200)
      assert.equal(router.routes?.().find((route) => route.path === '/api/t/legacy')?.explicit, false)
    })
  }
})

test('所有模式：非法访问等级在注册前失败，null 不会降级为默认公开', async (t) => {
  for (const mode of [undefined, '1']) {
    await t.test(`mode=${String(mode)}`, async (child) => {
      const env = await fixture(child, mode, [])
      const { router } = await env.start()
      const before = router.routes?.().length
      for (const access of [null, '', 'publc', 1, false, {}]) {
        assert.throws(() => registerRaw(router, '/api/t/invalid', { access }), /access 必须为 public、user 或 admin/)
      }
      assert.equal(router.routes?.().length, before)
      assert.equal(await env.status('/api/t/invalid'), 404)
    })
  }
})
