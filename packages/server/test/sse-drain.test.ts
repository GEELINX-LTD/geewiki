/**
 * 长连接（SSE）与优雅排空（drain）契约的共处测试：node:test + tsx + 真实 HTTP server + 真实 cordis 装配。
 * 运行：pnpm --filter @geewiki/server test（根 pnpm test 一并执行）
 *
 * 为什么必须有本文件：给后续 LLM 流式输出铺地基。长连接会把"处理器是否结算"这一
 * 排空判据彻底搅乱——若长连接的处理器返回一个 pending 的 Promise（或有人想当然地
 * 把连接算进在途数），卸载插件时 drain() 就会一直等到连接关闭，必然空转满
 * drainTimeout 并打印**假的**"排空超时"告警。用例 5 是负对照，专门证明那条错误路径
 * 确实会红，从而证明用例 2 不是空转通过的。
 *
 * 覆盖：
 * 1. SSE 长连接可用：处理器同步返回 + noteStatus 记指标 + trackStream 登记，客户端持续收帧；
 * 2. 核心断言：长连接活跃期间 REST 卸载不产生假排空告警（耗时 < drainTimeout、无"排空超时"、
 *    且持有者按自身生命周期收流后客户端读到结束）；
 * 3. 路由服务关停时主动收掉"无持有者清理"的长连接（验证 teardown 里 closeStreams 的接线）；
 * 4. noteStatus 恰好记一次指标，且响应体**不含**字面 null（回归"json() 终结 SSE 流"的坑）；
 * 5. trackStream 注销幂等：重复调用不抛错、集合不残留（用 end 探针观测）；
 * 6. 负对照：处理器返回永不 resolve 的 thenable → 排空确实等待、确实超时、确实打印告警。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import {
  type GeeWikiManifest,
  type HttpRouterService,
  type RouteHandlerContext,
} from '@geewiki/core'
import type { RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, startServer } from '../src/index.js'
import { freePort, sleep, waitForHealth, ADMIN_TOKEN, adminHeaders } from './helpers.js'

/**
 * P0：本文件多处通过真实 HTTP 调管理端点（插件 enable/disable）来制造"卸载长连接持有者"
 * 的场景。这些端点在 P0 被收进访问等级闸门（`admin`），故显式启用应急令牌并带上令牌头。
 * **既有断言一字未改**——改的只是请求身份。
 */
process.env['GEEWIKI_ADMIN_TOKEN'] = ADMIN_TOKEN

/* ------------------------------ 夹具 ------------------------------ */

interface TestPluginSpec {
  name: string
  requires?: string[]
  drainTimeout?: number
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

interface Harness {
  port: number
  router: HttpRouterService
  app: Context
  dispose(): Promise<void>
}

/** 启动真实服务：http 插件（显式端口 + 关闭静态服务）+ 传入的测试插件。
 *  base 层清单 = 未被 opts.session 点名的插件；session 层清单 = opts.session（可被 REST 停用）。 */
async function startHarness(entries: RegisteredPlugin[], opts: { session?: string[] } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-sse-'))
  const port = await freePort()
  let router: HttpRouterService | undefined
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

type StreamReader = ReadableStreamDefaultReader<Uint8Array>

/** 开一个 SSE 长连接并读到首帧（证明处理器已执行、连接已建立），返回可继续消费的 reader */
async function openStream(
  url: string,
): Promise<{ reader: StreamReader; first: string; close: () => void }> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  assert.equal(res.status, 200, 'SSE 应返回 200')
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = res.body?.getReader()
  assert.ok(reader, 'SSE 响应应有可读流')
  const firstChunk = await reader.read()
  const first = firstChunk.value ? new TextDecoder().decode(firstChunk.value) : ''
  return { reader, first, close: () => controller.abort() }
}

/** 把**已有** reader 读到结束或超时（不新开连接）：用于断言"连接是否被收掉" */
async function readAllUntilClose(
  reader: StreamReader,
  timeoutMs: number,
): Promise<{ text: string; closed: boolean }> {
  const deadline = Date.now() + timeoutMs
  let text = ''
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { text, closed: false }
    const chunk = await Promise.race([reader.read(), sleep(remaining).then(() => 'timeout' as const)])
    if (chunk === 'timeout') return { text, closed: false }
    if (chunk.done) return { text, closed: true }
    text += new TextDecoder().decode(chunk.value)
  }
}

/** 开 SSE 长连接的插件（**无**持有者清理：只依赖路由服务关停时的 closeStreams） */
function ssePlugin(name = '@t/sse'): RegisteredPlugin {
  return testPlugin({
    name,
    apply: (_ctx, router) => {
      router.register('GET', '/api/t/stream', (h: RouteHandlerContext) => {
        h.res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        // 只记指标、不结束响应——这正是 noteStatus 存在的理由
        h.noteStatus?.(200)
        h.res.write('event: status\ndata: {"type":"status"}\n\n')
        // 登记长连接：路由服务卸载/关停时会被主动收掉（trackStream 在**路由服务**上，不在 h 上）
        router.trackStream?.(h.res)
        // 关键：处理器**不**返回 thenable（否则会占在途数、排空会空转）
      })
    },
  })
}

/** 开 SSE 长连接、并在自身 dispose 时收掉自己流的插件（文档约定的"持有者负责"用法） */
function sseOwnerPlugin(name = '@t/sse-owner'): RegisteredPlugin {
  return testPlugin({
    name,
    apply: (_ctx, router) => {
      const own = new Set<ServerResponse>()
      router.register('GET', '/api/t/stream', (h: RouteHandlerContext) => {
        h.res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        h.noteStatus?.(200)
        h.res.write('event: status\ndata: {"type":"status"}\n\n')
        router.trackStream?.(h.res)
        own.add(h.res)
      })
      // 持有者按自身生命周期收流：插件卸载时结束自己开的连接
      return () => {
        for (const res of own) {
          try {
            res.end()
          } catch {
            /* 对端可能已断开：收尾失败不影响卸载 */
          }
        }
        own.clear()
      }
    },
  })
}

/* ------------------- 1. SSE 长连接可用（基础能力） ------------------- */

test('SSE：处理器同步返回即可建立长连接，客户端可持续收帧', async () => {
  const h = await startHarness([ssePlugin()])
  try {
    const opened = await openStream(base(h, '/api/t/stream'))
    assert.match(opened.first, /event: status/, '首帧应到达客户端')
    assert.ok(h.router.stats().total >= 1, 'SSE 请求应计入 stats 总数')
    opened.close()
  } finally {
    await h.dispose()
  }
})

/* --------- 2. 核心断言：长连接活跃期间卸载不产生假排空告警 --------- */

test('SSE：长连接活跃期间 REST 卸载不空转、无假"排空超时"告警，持有者收流后客户端读到结束', async () => {
  // 卸载目标在会话层（可被 REST 停用）；它自己持有长连接并在 dispose 时收流
  const h = await startHarness([sseOwnerPlugin('@t/sse-owner')], { session: ['@t/sse-owner'] })
  try {
    const pluginPath = encodeURIComponent('@t/sse-owner')
    const enabled = await fetch(base(h, `/api/plugins/${pluginPath}/enable`), {
      method: 'POST',
      headers: adminHeaders(),
    })
    assert.equal(enabled.status, 200, '会话层热启用应成功')
    await enabled.arrayBuffer()

    // 开一条长连接并读到首帧（此时连接活跃、且处理器已结算）
    const opened = await openStream(base(h, '/api/t/stream'))
    assert.match(opened.first, /event: status/)

    const { warns } = await captureConsole(async () => {
      const startedAt = Date.now()
      const res = await fetch(base(h, `/api/plugins/${pluginPath}/disable`), {
        method: 'POST',
        headers: adminHeaders(),
      })
      const elapsed = Date.now() - startedAt
      assert.equal(res.status, 200, '停用应成功')
      await res.arrayBuffer()
      // (a) 不得空转满 drainTimeout（该插件 drainTimeout=5s）
      assert.ok(elapsed < 1000, `长连接不得阻塞排空（实际 ${elapsed}ms）`)
    })
    // (b) 不得打印假的排空超时告警
    assert.equal(
      warns.some((line) => line.includes('排空超时')),
      false,
      `长连接不应触发假的超时告警，实际告警: ${warns.join(' | ')}`,
    )
    // (c) 持有者在 dispose 里收流 → 客户端读到流结束
    const rest = await readAllUntilClose(opened.reader, 2000)
    assert.equal(rest.closed, true, '插件卸载后其长连接应被结束（客户端读到流结束）')
  } finally {
    await h.dispose()
  }
})

/* ------- 3. 路由服务关停时主动收掉"无持有者清理"的长连接 ------- */

test('SSE：路由服务关停时主动收掉仍活跃的长连接（teardown 里 closeStreams 的接线）', async () => {
  // 用**无**持有者清理的插件：唯一能收掉这条流的就是路由服务自己的 teardown
  const h = await startHarness([ssePlugin()])
  let disposed = false
  try {
    const opened = await openStream(base(h, '/api/t/stream'))
    assert.match(opened.first, /event: status/)

    const disposePromise = h.dispose()
    disposed = true
    const rest = await readAllUntilClose(opened.reader, 3000)
    assert.equal(rest.closed, true, '路由服务关停应结束长连接（客户端读到流结束）')
    await disposePromise
  } finally {
    if (!disposed) await h.dispose()
  }
})

/* --------- 4. noteStatus 恰好记一次指标，且不污染 SSE 流 --------- */

test('SSE：noteStatus 恰好记一次指标，响应体不得出现字面 null（回归 json() 终结流的坑）', async () => {
  const h = await startHarness([ssePlugin()])
  try {
    const before = h.router.stats()
    const opened = await openStream(base(h, '/api/t/stream'))
    assert.match(opened.first, /event: status/)
    const after = h.router.stats()
    // 每个请求恰好记一次：total +1，ok +1（结算增量与总数增量一致）
    assert.equal(after.total - before.total, 1, 'SSE 请求应恰好计入一次总数')
    const settledDelta = after.ok - before.ok + (after.fail - before.fail)
    assert.equal(settledDelta, 1, `noteStatus 应恰好结算一次（ok+fail=${settledDelta}）`)
    // 关键回归：若误用 h.json 收尾，会把 JSON 文本追加进事件流（历史上实测为字面 "null"）
    assert.equal(opened.first.includes('null'), false, `SSE 首帧不得含字面 null：${opened.first}`)
    opened.close()
  } finally {
    await h.dispose()
  }
})

/* ------------------- 5. trackStream 注销幂等 ------------------- */

test('SSE：trackStream 注销幂等，重复调用不抛错且集合不残留', async () => {
  const h = await startHarness([ssePlugin()])
  try {
    // 结构面访问（closeStreams 是 HttpRouter 的实现细节，不在服务接口上）：
    // 用带 end 探针的假响应观测"登记者是否还在集合里"
    const internals = h.router as unknown as {
      trackStream(res: ServerResponse): () => void
      closeStreams(): void
    }
    assert.equal(typeof internals.trackStream, 'function', '真实路由服务应实现 trackStream')
    assert.equal(typeof internals.closeStreams, 'function', '真实路由服务应实现 closeStreams')

    const ended: string[] = []
    const fake = (tag: string): ServerResponse =>
      ({ end: () => void ended.push(tag) }) as unknown as ServerResponse

    const released = fake('released')
    const kept = fake('kept')
    const release = internals.trackStream(released)
    internals.trackStream(kept)
    // 幂等：重复注销不抛错
    release()
    release()
    release()

    internals.closeStreams()
    assert.deepEqual(
      ended,
      ['kept'],
      `已注销的不得再被收（集合不残留），仍登记的必须被收；实际收到: ${ended.join(',')}`,
    )
    // 收尾后再调一次也不得抛错（集合已清空）
    internals.closeStreams()
  } finally {
    await h.dispose()
  }
})

/* ------- 6. 负对照：异步长连接处理器会真的占在途 → 排空超时并告警 ------- */

test('负对照：处理器返回永不 resolve 的 thenable → 排空确实等待、超时并打印告警（证明用例 2 有判别力）', async () => {
  // 模拟"忘了同步返回"的 SSE 处理器：返回一个永不结算的 thenable
  const hanging = testPlugin({
    name: '@t/hanging',
    drainTimeout: 1, // 1s：给超时判定留出余量
    apply: (_ctx, router) => {
      router.register('GET', '/api/t/hanging', (h: RouteHandlerContext) => {
        h.res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
        })
        h.noteStatus?.(200)
        h.res.write('event: open\ndata: {}\n\n')
        // 故意返回 pending 的 thenable：分发器会把 exitHandler 挂到它的结算上 → 在途数不减
        return new Promise<void>(() => {})
      })
    },
  })
  const h = await startHarness([hanging], { session: ['@t/hanging'] })
  try {
    const pluginPath = encodeURIComponent('@t/hanging')
    const enabled = await fetch(base(h, `/api/plugins/${pluginPath}/enable`), {
      method: 'POST',
      headers: adminHeaders(),
    })
    await enabled.arrayBuffer()

    // 先确认在途请求**确实已受理**（读到首帧即证明处理器已执行、exitHandler 挂在 pending 上），
    // 否则会与"请求还没到达服务端"赛跑，得到"排空立即返回"的假结论
    const opened = await openStream(base(h, '/api/t/hanging'))
    assert.match(opened.first, /event: open/)

    const { warns } = await captureConsole(async () => {
      const startedAt = Date.now()
      const res = await fetch(base(h, `/api/plugins/${pluginPath}/disable`), {
        method: 'POST',
        headers: adminHeaders(),
      })
      const elapsed = Date.now() - startedAt
      await res.arrayBuffer()
      // 反面：这里**应当**等到超时（drainTimeout=1s），与用例 2 的 <1000ms 形成对照
      assert.ok(elapsed >= 900, `未结算的在途请求应让排空等到超时（实际 ${elapsed}ms）`)
    })
    assert.equal(
      warns.some((line) => line.includes('排空超时')),
      true,
      `未结算的在途请求应触发真超时告警，实际告警: ${warns.join(' | ')}`,
    )
    opened.close()
    await sleep(50)
  } finally {
    await h.dispose()
  }
})

/* ============ 7. owner 级长连接回收（插件卸载时定向收掉自己的流） ============
 *
 * 背景（外部审查 C-1）：长连接不计入排空，因此 drain() 不会等它们；而 closeStreams()
 * 原先**只在 @geewiki/http 自身 teardown 时调用**，插件级 /disable 既不退在途也不收流
 * ⇒ 客户端**静默悬空**（"把噪声故障换成了沉默故障"）。
 * 本组用例钉住新语义：**登记 owner 的连接，由管理器在卸载该插件时定向回收**，
 * 不再只依赖"插件作者记得在自己的 dispose 里收流"。
 */

/** 开 SSE 长连接、**登记 owner**、但自己**不做任何清理**的插件。
 *  唯一能收掉它的就是 owner 级回收——因此这条用例能真正判别该机制是否存在。 */
function sseOwnedNoCleanupPlugin(name: string, path: string): RegisteredPlugin {
  return testPlugin({
    name,
    apply: (_ctx, router) => {
      router.register('GET', path, (h: RouteHandlerContext) => {
        h.res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        h.noteStatus?.(200)
        h.res.write('event: status\ndata: {"type":"status"}\n\n')
        // 只登记 owner（第二个参数），**不**在自己的 dispose 里收流
        router.trackStream?.(h.res, name)
      })
    },
  })
}

test('SSE：owner 级回收只收该 owner 的流，其它 owner 的连接不受影响', async () => {
  const h = await startHarness([
    sseOwnedNoCleanupPlugin('@t/owner-a', '/api/t/stream-a'),
    sseOwnedNoCleanupPlugin('@t/owner-b', '/api/t/stream-b'),
  ])
  try {
    const a = await openStream(base(h, '/api/t/stream-a'))
    const b = await openStream(base(h, '/api/t/stream-b'))
    assert.match(a.first, /event: status/)
    assert.match(b.first, /event: status/)

    // 两条流都在册
    assert.equal(h.router.stats().streams?.active, 2, '两条长连接都应登记在册')

    // 只回收 owner A（管理器卸载单个插件时就是这么调的）
    h.router.closeStreams?.('@t/owner-a')

    const aRest = await readAllUntilClose(a.reader, 2000)
    assert.equal(aRest.closed, true, '被回收的 owner 的连接应结束（客户端读到流结束）')

    // 关键断言：B 必须**仍然存活**——否则"定向回收"就退化成了"全量关闭"
    const bRest = await readAllUntilClose(b.reader, 400)
    assert.equal(bRest.closed, false, '未回收的 owner 的连接不得被误关')
    assert.equal(h.router.stats().streams?.active, 1, '回收后应只剩 1 条在册')

    b.close()
    await sleep(50)
  } finally {
    await h.dispose()
  }
})

test('SSE：插件卸载时由管理器定向回收其长连接（插件自身不做清理也能收掉）', async () => {
  const pluginName = '@t/owned-noclean'
  const h = await startHarness([sseOwnedNoCleanupPlugin(pluginName, '/api/t/owned')], {
    session: [pluginName],
  })
  try {
    const pluginPath = encodeURIComponent(pluginName)
    const enabled = await fetch(base(h, `/api/plugins/${pluginPath}/enable`), {
      method: 'POST',
      headers: adminHeaders(),
    })
    assert.equal(enabled.status, 200, '会话层热启用应成功')
    await enabled.arrayBuffer()

    const opened = await openStream(base(h, '/api/t/owned'))
    assert.match(opened.first, /event: status/)
    assert.equal(h.router.stats().streams?.active, 1, '流应已登记')

    const { warns } = await captureConsole(async () => {
      const startedAt = Date.now()
      const res = await fetch(base(h, `/api/plugins/${pluginPath}/disable`), {
        method: 'POST',
        headers: adminHeaders(),
      })
      const elapsed = Date.now() - startedAt
      assert.equal(res.status, 200, '停用应成功')
      await res.arrayBuffer()
      // (a) 长连接不得阻塞排空（该插件 drainTimeout=5s）
      assert.ok(elapsed < 1000, `长连接不得阻塞排空（实际 ${elapsed}ms）`)
    })
    // (b) 不得产生假的排空超时告警（排空语义与告警文案一字未改）
    assert.equal(
      warns.some((line) => line.includes('排空超时')),
      false,
      `owner 级回收不应触发超时告警，实际告警: ${warns.join(' | ')}`,
    )
    // (c) 插件自己没做清理，但连接仍被收掉 → 客户端读到流结束（这正是本批新增的能力）
    const rest = await readAllUntilClose(opened.reader, 2000)
    assert.equal(rest.closed, true, '插件卸载后其长连接应被管理器定向收掉')
    // (d) 在册数归零
    await sleep(50)
    assert.equal(h.router.stats().streams?.active, 0, '卸载后不应残留登记的流')
  } finally {
    await h.dispose()
  }
})

test('SSE：未登记 owner 的连接无法被定向回收（显式契约，非静默行为）', async () => {
  // ssePlugin() 就是"登记但不带 owner"的形态：closeStreams(owner) 不应收掉它
  const h = await startHarness([ssePlugin('@t/no-owner')])
  try {
    const opened = await openStream(base(h, '/api/t/stream'))
    assert.match(opened.first, /event: status/)

    h.router.closeStreams?.('@t/no-owner')
    const stillOpen = await readAllUntilClose(opened.reader, 400)
    assert.equal(
      stillOpen.closed,
      false,
      '未登记 owner 的连接不该被 owner 级回收关掉（它只能等整体关停）',
    )

    // 对照：整体关停仍能收掉它（既有语义未变）
    const disposePromise = h.dispose()
    const afterDispose = await readAllUntilClose(opened.reader, 3000)
    assert.equal(afterDispose.closed, true, '整体关停仍应收掉未登记 owner 的连接')
    await disposePromise
  } finally {
    await h.dispose()
  }
})

/* ============ 8. 长连接可观测性（stats / health） ============ */

/** 生产形态的持有者：登记 owner，并在客户端断开时**注销**（@geewiki/ai 在 finally 里做同样的事）。
 *  用它才能断言 active 计数随真实生命周期归零——ssePlugin() 刻意不注销（见用例 5 的契约）。 */
function sseObservedPlugin(name: string, path: string): RegisteredPlugin {
  return testPlugin({
    name,
    apply: (_ctx, router) => {
      router.register('GET', path, (h: RouteHandlerContext) => {
        h.res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        h.noteStatus?.(200)
        h.res.write('event: status\ndata: {"type":"status"}\n\n')
        const untrack = router.trackStream?.(h.res, name)
        // 客户端断开（或服务端收流）→ 注销登记，避免登记表里留下已死的连接
        h.res.on('close', () => untrack?.())
      })
    },
  })
}

test('SSE：stats() 保留既有字段并新增 streams 计数，随流的开闭与拒流变化', async () => {
  const h = await startHarness([sseObservedPlugin('@t/obs', '/api/t/obs')])
  try {
    const before = h.router.stats()
    // 既有字段一个都不能少（看门狗与既有断言依赖它们）
    for (const key of ['total', 'ok', 'fail', 'consecutiveFailures', 'lastMs', 'avgMs'] as const) {
      assert.equal(typeof before[key], 'number', `stats() 应保留既有字段 ${key}`)
    }
    assert.ok(before.streams, 'stats() 应新增 streams 计数')
    assert.equal(before.streams?.active, 0, '未开流时 active 应为 0')
    const rejectedBefore = before.streams?.rejected ?? 0

    const opened = await openStream(base(h, '/api/t/obs'))
    assert.equal(h.router.stats().streams?.active, 1, '开流后 active 应为 1')

    // 被拒计数由持有者上报（并发上限是持有者策略，路由服务不参与判定）
    h.router.noteStreamRejected?.()
    assert.equal(h.router.stats().streams?.rejected, rejectedBefore + 1, '上报后 rejected 应 +1')

    opened.close()
    // 客户端断开 → 处理器 finally 里 untrack，active 应回到 0（轮询给注销留出时间）
    for (let i = 0; i < 40 && h.router.stats().streams?.active !== 0; i++) await sleep(50)
    assert.equal(h.router.stats().streams?.active, 0, '客户端断开并注销后 active 应回到 0')
  } finally {
    await h.dispose()
  }
})

test('SSE：/api/health 带 streams 计数，且既有判据字段（ok / db.present）不变', async () => {
  const h = await startHarness([ssePlugin('@t/health')])
  try {
    const body = (await (await fetch(base(h, '/api/health'))).json()) as {
      ok?: unknown
      db?: { present?: unknown }
      streams?: { active?: unknown; rejected?: unknown }
    }
    // Dockerfile 的 HEALTHCHECK 判据是 `j.ok===true && j.db && j.db.present===true`：
    // 既有字段的形状与语义必须一字不变，否则容器会误判为不健康。
    assert.equal(body.ok, true, 'health 的 ok 必须仍为 true')
    assert.equal(typeof body.db, 'object', 'health 必须仍带 db 对象')
    assert.equal(typeof body.db?.present, 'boolean', 'db.present 必须仍是布尔')
    // 新增的可观测字段
    assert.equal(typeof body.streams?.active, 'number', 'health 应带 streams.active')
    assert.equal(typeof body.streams?.rejected, 'number', 'health 应带 streams.rejected')
  } finally {
    await h.dispose()
  }
})
