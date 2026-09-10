/**
 * @geewiki/http 路由服务（真实实现）回归测试：node:test + tsx + 真实 HTTP server + 真实 cordis 装配。
 * 运行：pnpm --filter @geewiki/server test（根 pnpm test 一并执行）
 *
 * 为什么必须有本文件：此前"治理批"的排空契约只用 HttpRouterService 替身（stub）断言，
 * 真实实现里的缺陷因此逃过测试——REST 卸载插件时，**管理面请求自身也在 inFlight 里**，
 * 排空于是等自己、必然空转满 drainTimeout，并打印假的"排空超时"告警。
 *
 * 覆盖：
 * 1. drain 排除调用方自身请求（回归用例，修复前必然失败）；
 * 2. 空闲立即返回 true；有真实在途请求时等待其结算后返回 true；
 * 3. 超时返回 false、不等价于"未结算"（在途请求仍正常完成）、等待者无残留；
 * 4. 多个并发等待者都被唤醒；drainTimeout<=0 不等待；
 * 5. 同步处理器 / 异步处理器 / 非原生 thenable 都正确结算 inflight()；
 * 6. 未匹配路由（API 404）与交接给静态资源层的请求不计入在途数；
 * 7. 端到端：REST 卸载不空转（假超时告警消失）、有真实在途请求时等待并打印"排空完成：耗时 Xms"；
 * 8. ServerOptions.port/host 真的生效（默认端口不再是唯一去处）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import {
  type GeeWikiManifest,
  type HttpRouterService,
  type RouteHandlerContext,
} from '@geewiki/core'
import type { RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, defaultRegistry, startServer } from '../src/index.js'

/* ------------------------------ helpers ------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** 取一个空闲端口（listen 0 后立即释放）：测试内固定端口易与他人的 3000/5173 冲突 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.on('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      if (!port) {
        rejectPort(new Error('无法获取空闲端口'))
        return
      }
      probe.close(() => resolvePort(port))
    })
  })
}

interface TestPluginSpec {
  name: string
  /** 依赖声明（默认 http-service，保证装配顺序在 http 之后） */
  requires?: string[]
  /** manifest.runtime.drainTimeout（秒） */
  drainTimeout?: number
  /** apply 内注册路由；router 由 harness 注入 */
  apply?: (ctx: Context, router: HttpRouterService) => void | (() => void)
}

function testPlugin(spec: TestPluginSpec): RegisteredPlugin {
  const manifest: GeeWikiManifest = {
    name: spec.name,
    version: '1.0.0',
    geewiki: {
      requires: spec.requires ?? ['http-service'],
      runtime: {
        supportsHotReload: true,
        requiresCachePurge: false,
        drainTimeout: spec.drainTimeout ?? 5,
      },
    },
  }
  return {
    name: spec.name,
    manifest,
    module: {
      name: spec.name,
      apply(ctx: Context) {
        const router = ctx.get('http') as HttpRouterService
        return spec.apply?.(ctx, router)
      },
    },
  }
}

/** 慢路由：GET /api/t/slow?ms=<延迟>，用于制造确定的在途请求 */
function slowPlugin(name = '@t/slow', drainTimeout?: number): RegisteredPlugin {
  return testPlugin({
    name,
    drainTimeout,
    apply: (_ctx, router) => {
      router.register('GET', '/api/t/slow', async (h: RouteHandlerContext) => {
        const ms = Number(h.url.searchParams.get('ms') ?? 200)
        await sleep(Number.isFinite(ms) ? ms : 200)
        h.json(200, { ok: true, ms })
      })
    },
  })
}

interface Harness {
  port: number
  router: HttpRouterService
  app: Context
  dispose(): Promise<void>
}

/** 启动真实服务：http 插件（显式端口 + 关闭静态服务）+ 传入的测试插件。
 *  base 层清单 = 未被 opts.session 点名的插件；session 层清单 = opts.session（可被 REST 停用）。 */
async function startHarness(entries: RegisteredPlugin[], opts: { session?: string[] } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-router-'))
  const port = await freePort()
  let router: HttpRouterService | undefined
  // 捕获 router：经插件 apply 内 ctx.get('http')，与真实插件消费路径完全一致
  const capture = testPlugin({
    name: '@t/capture',
    apply: (_ctx, r) => {
      router = r
    },
  })
  const registry: RegisteredPlugin[] = [httpRegistryEntry(null, { port, host: '127.0.0.1' }), capture, ...entries]
  const sessionNames = opts.session ?? []
  writeFileSync(
    join(dir, 'plugins.base.json'),
    `${JSON.stringify(
      { enabled: registry.filter((e) => !sessionNames.includes(e.name)).map((e) => ({ name: e.name })) },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'plugins.session.json'),
    `${JSON.stringify({ enabled: sessionNames.map((name) => ({ name })) }, null, 2)}\n`,
    'utf8',
  )
  const handle = await startServer({ registry, port, host: '127.0.0.1', configDir: dir, webDist: null })
  await waitForHealth(port)
  assert.ok(router, '测试插件应已捕获 http 路由服务')
  return {
    port,
    router,
    app: handle.app,
    dispose: async () => {
      await handle.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      await res.arrayBuffer() // 消费响应体，避免 undici 连接悬挂
      if (res.status === 200) return
    } catch (err) {
      lastError = err
    }
    await sleep(25)
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪: ${String(lastError)}`)
}

const base = (h: Harness, path: string): string => `http://127.0.0.1:${h.port}${path}`

/** 临时接管 console 输出，用于断言日志语义（排空完成 / 排空超时） */
function captureConsole(run: () => Promise<void>): Promise<{ logs: string[]; warns: string[] }> {
  const logs: string[] = []
  const warns: string[] = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '))
  return run()
    .then(() => ({ logs, warns }))
    .finally(() => {
      console.log = originalLog
      console.warn = originalWarn
    })
}

/* --------------------- 1. drain 基本语义（§5.1） --------------------- */

test('drain：空闲时立即返回 true（不等待、不使用完整超时）', async () => {
  const h = await startHarness([])
  try {
    assert.equal(h.router.inflight(), 0, '空闲时应无在途请求')
    const startedAt = Date.now()
    assert.equal(await h.router.drain(2000), true)
    assert.ok(Date.now() - startedAt < 100, '空闲排空应即刻返回')
  } finally {
    await h.dispose()
  }
})

test('drain：有在途请求时等待其结算后返回 true（在途请求不受影响）', async () => {
  const h = await startHarness([slowPlugin()])
  try {
    const pending = fetch(base(h, '/api/t/slow?ms=300'))
    await sleep(60)
    assert.equal(h.router.inflight(), 1, '慢请求应处于在途状态')

    const startedAt = Date.now()
    assert.equal(await h.router.drain(2000), true, '应等到在途请求结算')
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 200, `必须真的等待在途请求（实际 ${elapsed}ms）`)

    const res = await pending
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, ms: 300 })
    assert.equal(h.router.inflight(), 0, '结算后在途数应归零')
  } finally {
    await h.dispose()
  }
})

test('drain：超时返回 false，但在途请求仍正常完成且不留等待者', async () => {
  const h = await startHarness([slowPlugin()])
  try {
    const pending = fetch(base(h, '/api/t/slow?ms=400'))
    await sleep(60)
    assert.equal(await h.router.drain(100), false, '超时应返回 false（调用方决定是否强制卸载）')

    // 超时不等价于"请求被丢弃"：在途请求必须能跑完
    const res = await pending
    assert.equal(res.status, 200)
    await sleep(30)
    assert.equal(h.router.inflight(), 0)

    // 无残留：超时后的新等待者仍能正常排空（旧等待者已结算，不再干扰）
    const startedAt = Date.now()
    assert.equal(await h.router.drain(2000), true)
    assert.ok(Date.now() - startedAt < 100, '已无在途请求 → 新排空应即刻返回')
  } finally {
    await h.dispose()
  }
})

test('drain：多个并发等待者都被唤醒；drainTimeout<=0 不等待', async () => {
  const h = await startHarness([slowPlugin()])
  try {
    const pending = fetch(base(h, '/api/t/slow?ms=250'))
    await sleep(40)
    const nonBlocking = await h.router.drain(0)
    assert.equal(nonBlocking, false, 'timeout<=0 表示不等待，直接返回 false')

    const startedAt = Date.now()
    const [first, second] = await Promise.all([h.router.drain(2000), h.router.drain(2000)])
    assert.equal(first, true, '等待者 1 应被唤醒')
    assert.equal(second, true, '等待者 2 应被唤醒')
    assert.ok(Date.now() - startedAt >= 100, '两个等待者都应等满在途请求')
    assert.equal((await pending).status, 200)
  } finally {
    await h.dispose()
  }
})

/* ---------------- 2. 回归：drain 排除调用方自身请求 ---------------- */

test('回归：请求处理器内部调用 drain 不会把自己算作待排空请求（修复前空转满超时）', async () => {
  const selfDrain = testPlugin({
    name: '@t/self-drain',
    apply: (_ctx, router) => {
      router.register('GET', '/api/t/self-drain', async (h: RouteHandlerContext) => {
        const startedAt = Date.now()
        // 与 REST 卸载同构：管理面请求自身也在 inFlight 中，必须被排除
        const drained = await router.drain(5000)
        h.json(200, { drained, ms: Date.now() - startedAt })
      })
    },
  })
  const h = await startHarness([selfDrain])
  try {
    const res = await fetch(base(h, '/api/t/self-drain'))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { drained: boolean; ms: number }
    assert.equal(body.drained, true, '调用方自身不计入待排空请求 → 应立即排空')
    assert.ok(body.ms < 1000, `不得空转满 drainTimeout（实际 ${body.ms}ms）`)
    assert.equal(h.router.inflight(), 0)
  } finally {
    await h.dispose()
  }
})

/* --------------------- 3. 在途计数的结算完整性 --------------------- */

test('inflight：同步处理器、异步处理器与非原生 thenable 都正确结算', async () => {
  const counting = testPlugin({
    name: '@t/counting',
    apply: (_ctx, router) => {
      router.register('GET', '/api/t/sync', (h: RouteHandlerContext) => {
        h.json(200, { ok: true, kind: 'sync' })
      })
      router.register('GET', '/api/t/async', async (h: RouteHandlerContext) => {
        await sleep(150)
        h.json(200, { ok: true, kind: 'async' })
      })
      router.register('GET', '/api/t/thenable', (h: RouteHandlerContext) => {
        // 非原生 thenable（instanceof Promise 为 false）：必须同样被登记与结算
        return {
          then: (resolveThen: (value: unknown) => void) => {
            setTimeout(() => {
              h.json(200, { ok: true, kind: 'thenable' })
              resolveThen(undefined)
            }, 150)
          },
        } as unknown as Promise<void>
      })
    },
  })
  const h = await startHarness([counting])
  try {
    const sync = await fetch(base(h, '/api/t/sync'))
    assert.equal(sync.status, 200)
    assert.equal(h.router.inflight(), 0, '同步处理器返回即结算')

    const asyncPending = fetch(base(h, '/api/t/async'))
    const thenablePending = fetch(base(h, '/api/t/thenable'))
    await sleep(60)
    assert.equal(h.router.inflight(), 2, '两个异步处理器都应登记为在途')
    assert.equal((await asyncPending).status, 200)
    assert.equal((await thenablePending).status, 200)
    await sleep(30)
    assert.equal(h.router.inflight(), 0, '异步/thenable 处理器结算后在途数应归零')
  } finally {
    await h.dispose()
  }
})

test('inflight：API 404 与交接给静态资源层的请求不计入在途数', async () => {
  const h = await startHarness([])
  try {
    // (a) 未匹配的 /api/* → 路由层直接 404，不进入任何处理器
    const api404 = await fetch(base(h, '/api/nope'))
    assert.equal(api404.status, 404)
    assert.equal(((await api404.json()) as { error: string }).error, 'not_found')
    assert.equal(h.router.inflight(), 0, 'API 404 不进入处理器 → 不计入在途')

    // (b) 非 /api 路径 → dispatch 返回 false 交给静态资源层（本 harness 关闭静态服务 → 404）
    const staticPath = await fetch(base(h, '/some/static/path'))
    assert.equal(staticPath.status, 404)
    await staticPath.arrayBuffer()
    assert.equal(h.router.inflight(), 0, '交接给静态资源层的请求不计入在途')

    // (c) 健康检查（内置常驻路由）计入并即时结算
    const health = await fetch(base(h, '/api/health'))
    assert.equal(health.status, 200)
    await health.arrayBuffer()
    assert.equal(h.router.inflight(), 0)
  } finally {
    await h.dispose()
  }
})

/* --------------- 4. 端到端：REST 卸载（真实管理器 + 真实路由器） --------------- */

test('REST 卸载：空闲时立即完成，不再打印假的排空超时告警', async () => {
  const h = await startHarness([testPlugin({ name: '@t/idle', drainTimeout: 5 })], { session: ['@t/idle'] })
  try {
    const pluginPath = encodeURIComponent('@t/idle')
    const enabled = await fetch(base(h, `/api/plugins/${pluginPath}/enable`), { method: 'POST' })
    assert.equal(enabled.status, 200, '会话层热启用应成功')
    await enabled.arrayBuffer()

    const { logs, warns } = await captureConsole(async () => {
      const startedAt = Date.now()
      const res = await fetch(base(h, `/api/plugins/${pluginPath}/disable`), { method: 'POST' })
      const elapsed = Date.now() - startedAt
      assert.equal(res.status, 200, '停用应成功')
      await res.arrayBuffer()
      assert.ok(elapsed < 1000, `REST 卸载不得空转满 drainTimeout（实际 ${elapsed}ms）`)
    })
    assert.equal(
      warns.some((line) => line.includes('排空超时')),
      false,
      `管理请求自身不应触发假的超时告警，实际告警: ${warns.join(' | ')}`,
    )
    assert.equal(
      logs.some((line) => line.includes('排空完成')),
      false,
      '无真实在途请求时不应记录排空耗时',
    )
  } finally {
    await h.dispose()
  }
})

test('REST 卸载：有真实在途请求时等待其结算并打印"排空完成：耗时 Xms"', async () => {
  // 在途请求由另一个常驻插件产生，卸载目标是它自己 → 排空必须真的等
  const h = await startHarness([slowPlugin('@t/pending-owner'), testPlugin({ name: '@t/target' })], {
    session: ['@t/target'],
  })
  try {
    const targetPath = encodeURIComponent('@t/target')
    const enabled = await fetch(base(h, `/api/plugins/${targetPath}/enable`), { method: 'POST' })
    assert.equal(enabled.status, 200)
    await enabled.arrayBuffer()

    const pending = fetch(base(h, '/api/t/slow?ms=400'))
    await sleep(60)
    assert.equal(h.router.inflight(), 1, '慢请求应在途')

    const startedAt = Date.now()
    const { logs } = await captureConsole(async () => {
      const res = await fetch(base(h, `/api/plugins/${targetPath}/disable`), { method: 'POST' })
      assert.equal(res.status, 200)
      await res.arrayBuffer()
    })
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 200, `REST 卸载应等待在途请求结算（实际 ${elapsed}ms）`)
    assert.ok(
      logs.some((line) => line.includes('排空完成：耗时')),
      `应记录排空耗时日志，实际日志: ${logs.join(' | ')}`,
    )
    assert.equal((await pending).status, 200, '在途请求应正常完成')
  } finally {
    await h.dispose()
  }
})

/* ------------- 6. plugin-wiki 413 必须经统一出口（stats 可见） ------------- */

test('plugin-wiki：超限请求体返回 413 且计入 stats()（修复前绕过统一出口 → 差值非 0）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-wiki-data-'))
  const previousDataDir = process.env.GEEWIKI_DATA_DIR
  process.env.GEEWIKI_DATA_DIR = dataDir
  const builtin = defaultRegistry(null)
  const dbEntry = builtin.find((e) => e.name === '@geewiki/db-sqlite')
  const wikiEntry = builtin.find((e) => e.name === '@geewiki/wiki')
  assert.ok(dbEntry && wikiEntry, '默认注册表应含 db-sqlite 与 wiki')
  let h: Harness | undefined
  try {
    h = await startHarness([dbEntry, wikiEntry])

    // (a) 请求体 >1MB → payload_too_large，且必须经 h.json 统一出口
    //     （绕过统一出口时 total 会 +1 而 ok/fail 不动 → 差值 = 1，看门狗探针看不到）
    const before = h.router.stats()
    const tooBig = await fetch(base(h, '/api/pages/probe-413'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'probe', content: 'x'.repeat(1_100_000) }),
    })
    assert.equal(tooBig.status, 413)
    assert.equal(((await tooBig.json()) as { error: string }).error, 'payload_too_large')
    const after = h.router.stats()
    const totalDelta = after.total - before.total
    const settledDelta = after.ok - before.ok + (after.fail - before.fail)
    assert.equal(totalDelta - settledDelta, 0, `413 必须结算进 stats（total=${totalDelta}, ok+fail=${settledDelta}）`)

    // (b) 正文 >500KB 但请求体 <1MB → content_too_large（与"请求体过大"分流，调用方可区分）
    const contentTooBig = await fetch(base(h, '/api/pages/probe-content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'probe', content: 'y'.repeat(600_000) }),
    })
    assert.equal(contentTooBig.status, 413)
    assert.equal(((await contentTooBig.json()) as { error: string }).error, 'content_too_large')

    // (c) 限额内写入仍然成功（确认 413 只针对超限，未误伤正常请求）
    const accepted = await fetch(base(h, '/api/pages/probe-ok'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '正常页面', content: 'hello' }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(((await accepted.json()) as { outcome: string }).outcome, 'created')
  } finally {
    if (h) await h.dispose()
    if (previousDataDir === undefined) delete process.env.GEEWIKI_DATA_DIR
    else process.env.GEEWIKI_DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  }
})

/* ------------------- 5. ServerOptions.port/host 接线 ------------------- */

test('ServerOptions.port/host：默认注册表按启动选项绑定端口（不再固定 3000/0.0.0.0）', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'gw-port-cfg-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-port-data-'))
  const previousDataDir = process.env.GEEWIKI_DATA_DIR
  process.env.GEEWIKI_DATA_DIR = dataDir
  const port = await freePort()
  let handle: { dispose: () => Promise<void> } | undefined
  try {
    // 基础层清单列出默认注册表全部插件（清单内不写 port/host → 启动选项生效）
    writeFileSync(
      join(configDir, 'plugins.base.json'),
      `${JSON.stringify(
        { enabled: ['@geewiki/db-sqlite', '@geewiki/http', '@geewiki/echo', '@geewiki/wiki'].map((name) => ({ name })) },
        null,
        2,
      )}\n`,
      'utf8',
    )
    handle = await startServer({ port, host: '127.0.0.1', configDir, webDist: null })
    await waitForHealth(port)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(res.status, 200, `启动选项指定的端口 ${port} 应真的在服务`)
    await res.arrayBuffer()
  } finally {
    if (handle) await handle.dispose()
    if (previousDataDir === undefined) delete process.env.GEEWIKI_DATA_DIR
    else process.env.GEEWIKI_DATA_DIR = previousDataDir
    rmSync(configDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})
