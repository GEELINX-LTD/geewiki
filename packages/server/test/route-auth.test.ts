/**
 * P0 路由鉴权骨架回归测试：访问等级闸门（`public` / `user` / `admin`）、应急令牌通道、
 * 前置钩子链（`HttpRouterService.use`）。node:test + tsx + 真实 HTTP server + 真实 cordis 装配。
 * 运行：pnpm --filter @geewiki/server test（根 pnpm test 一并执行）
 *
 * 为什么必须有本文件：P0 之前这些端点**匿名可调**（其中插件 disable 能热卸载数据库插件）。
 * 本文件把"拒绝"这件事钉成断言，重点是三类**失败关闭**语义——它们都是"漏了就等于没做"的地方：
 * 1. 未配置凭据来源 ⇒ 503 `bootstrap_required`，且**带任意令牌头也必须仍然 503**（不得因为
 *    "没配令牌"而滑进放行分支）；
 * 2. 已配置但未带/带错令牌 ⇒ 401（而不是 403，也不是放过）；
 * 3. 钩子返回值形态不合法 ⇒ 按**拒绝**处理（插件写错不等于全放行）。
 *
 * 与 `router.test.ts` 的分工：那个文件验证排空/统计等**既有**契约不受 P0 改动影响；
 * 本文件只验证 P0 新增的闸门与钩子语义。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import {
  breakGlassPrincipal,
  type GeeWikiManifest,
  type HttpRouterService,
  type RouteHandlerContext,
} from '@geewiki/core'
import type { RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, startServer } from '../src/index.js'
import { ADMIN_TOKEN, adminHeaders, freePort, waitForHealth } from './helpers.js'

const ENV_KEY = 'GEEWIKI_ADMIN_TOKEN'

/* ------------------------------ 夹具 ------------------------------ */

/** 被调用次数：用于断言"钩子拒绝时处理器根本没跑" */
let handlerCalls = 0

function testPlugin(name: string, apply: (ctx: Context, router: HttpRouterService) => void): RegisteredPlugin {
  const manifest: GeeWikiManifest = {
    name,
    version: '1.0.0',
    geewiki: { requires: ['http-service'], runtime: { supportsHotReload: true, drainTimeout: 5 } },
  }
  return {
    name,
    manifest,
    module: {
      name,
      apply(ctx: Context) {
        apply(ctx, ctx.get('http') as HttpRouterService)
      },
    },
  }
}

interface Harness {
  port: number
  router: HttpRouterService
  dispose(): Promise<void>
}

/** 三条不同访问等级的探针路由：默认（public）/ user / admin */
function probePlugin(): RegisteredPlugin {
  return testPlugin('@t/auth-probe', (_ctx, router) => {
    router.register('GET', '/api/t/public', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true, scope: 'public', principal: h.principal?.kind ?? null })
    })
    router.register('GET', '/api/t/user', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true, scope: 'user', principal: h.principal?.kind ?? null })
    }, { access: 'user' })
    router.register('POST', '/api/t/admin', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true, scope: 'admin', principal: h.principal?.kind ?? null })
    }, { access: 'admin' })
    // 声明了 access 但处理器从不执行：用于断言"闸门在处理器之前"
    router.register('GET', '/api/t/user-never', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true })
    }, { access: 'user' })
  })
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-route-auth-'))
  const port = await freePort()
  let router: HttpRouterService | undefined
  const capture = testPlugin('@t/auth-capture', (_ctx, r) => {
    router = r
  })
  const registry: RegisteredPlugin[] = [httpRegistryEntry(null, { port, host: '127.0.0.1' }), capture, probePlugin()]
  writeFileSync(
    join(dir, 'plugins.base.json'),
    `${JSON.stringify({ enabled: registry.map((e) => ({ name: e.name })) }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'plugins.session.json'), `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
  const handle = await startServer({ registry, port, host: '127.0.0.1', configDir: dir, webDist: null })
  await waitForHealth(port)
  assert.ok(router, '测试插件应已捕获 http 路由服务')
  return {
    port,
    router,
    dispose: async () => {
      await handle.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let harness: Harness | undefined
async function server(): Promise<Harness> {
  harness ??= await startHarness()
  return harness
}
const base = (p: Harness, path: string): string => `http://127.0.0.1:${p.port}${path}`

/** 在指定"环境变量是否配置"的前提下执行，结束后还原（避免用例之间互相污染） */
async function withEnvToken<T>(token: string | null, run: () => Promise<T>): Promise<T> {
  const previous = process.env[ENV_KEY]
  if (token === null) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = token
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = previous
  }
}

after(async () => {
  if (harness) await harness.dispose()
})

/* --------------------- 1. 未配置凭据来源：503 引导期 --------------------- */

test('未配置 GEEWIKI_ADMIN_TOKEN：受保护端点一律 503 bootstrap_required（不是 401）', async () => {
  const h = await server()
  handlerCalls = 0
  await withEnvToken(null, async () => {
    for (const [method, path] of [
      ['GET', '/api/t/user'],
      ['GET', '/api/t/user-never'],
      ['POST', '/api/t/admin'],
    ] as const) {
      const res = await fetch(base(h, path), { method })
      assert.equal(res.status, 503, `${method} ${path} 应为 503（引导期没有可登录的东西）`)
      const body = (await res.json()) as { ok: boolean; error: string; details?: { access?: string } }
      assert.equal(body.ok, false)
      assert.equal(body.error, 'bootstrap_required')
      assert.ok(body.details?.access, '错误信封应带上被拒的访问等级，便于前端给出准确文案')
    }
  })
  assert.equal(handlerCalls, 0, '被拒的请求不得进入处理器')
})

test('未配置令牌时，带任意令牌头**仍然** 503 —— 绝不因为"没配令牌"而放行（P0-5）', async () => {
  const h = await server()
  handlerCalls = 0
  await withEnvToken(null, async () => {
    const byCustomHeader = await fetch(base(h, '/api/t/admin'), {
      method: 'POST',
      headers: { 'x-gw-admin-token': ADMIN_TOKEN },
    })
    assert.equal(byCustomHeader.status, 503)
    assert.equal(((await byCustomHeader.json()) as { error: string }).error, 'bootstrap_required')

    const byBearer = await fetch(base(h, '/api/t/admin'), {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    assert.equal(byBearer.status, 503)
    assert.equal(((await byBearer.json()) as { error: string }).error, 'bootstrap_required')
  })
  assert.equal(handlerCalls, 0, '通道禁用时任何令牌都不得进入处理器')
})

/* --------------------- 2. 已配置：令牌是唯一通行证 --------------------- */

test('已配置令牌：带正确令牌放行，不带或带错一律 401 unauthorized', async () => {
  const h = await server()
  handlerCalls = 0
  await withEnvToken(ADMIN_TOKEN, async () => {
    const ok = await fetch(base(h, '/api/t/admin'), { method: 'POST', headers: adminHeaders() })
    assert.equal(ok.status, 200, '应急通道应放行 admin 级端点')
    const okBody = (await ok.json()) as { principal: string | null }
    assert.equal(okBody.principal, 'break-glass', '主体应被识别为 break-glass 而非匿名')

    const missing = await fetch(base(h, '/api/t/admin'), { method: 'POST' })
    assert.equal(missing.status, 401)
    assert.equal(((await missing.json()) as { error: string }).error, 'unauthorized')

    const wrong = await fetch(base(h, '/api/t/admin'), {
      method: 'POST',
      headers: { 'x-gw-admin-token': 'not-the-token' },
    })
    assert.equal(wrong.status, 401, '错误令牌是"未认证"，不是"无权限"')
  })
  assert.equal(handlerCalls, 1, '三次请求里只有"带正确令牌"的那次应进入处理器，两次拒绝不得触达处理器')
})

test('两种令牌形态都识别：X-GW-Admin-Token 与 Authorization: Bearer', async () => {
  const h = await server()
  await withEnvToken(ADMIN_TOKEN, async () => {
    const viaBearer = await fetch(base(h, '/api/t/user'), {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    assert.equal(viaBearer.status, 200)
    assert.equal(((await viaBearer.json()) as { principal: string }).principal, 'break-glass')

    // Bearer 前缀大小写不敏感（脚本里写成 bearer 很常见）
    const lower = await fetch(base(h, '/api/t/user'), {
      headers: { authorization: `bearer ${ADMIN_TOKEN}` },
    })
    assert.equal(lower.status, 200)
  })
})

/* --------------------- 3. public 端点零回归 --------------------- */

test('未声明 access 的端点默认 public：未配置令牌、未带令牌也照常工作', async () => {
  const h = await server()
  await withEnvToken(null, async () => {
    const res = await fetch(base(h, '/api/t/public'))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { scope: string; principal: string | null }
    assert.equal(body.scope, 'public')
    assert.equal(body.principal, 'anonymous', 'public 端点也应拿到明确的匿名主体，而不是 undefined')
  })
})

/* --------------------- 4. 前置钩子链 --------------------- */

test('use()：钩子拒绝即短路（处理器不执行），注销后恢复', async () => {
  const h = await server()
  handlerCalls = 0
  const off = h.router.use?.(() => ({ ok: false, status: 403, code: 'forbidden', message: '被钩子拒绝' }))
  assert.ok(off, '真实路由服务必须实现 use()')
  try {
    const denied = await fetch(base(h, '/api/t/public'))
    assert.equal(denied.status, 403)
    const body = (await denied.json()) as { ok: boolean; error: string; message: string }
    assert.equal(body.ok, false)
    assert.equal(body.error, 'forbidden')
    assert.equal(body.message, '被钩子拒绝')
  } finally {
    off()
    off() // 幂等：重复注销不抛错
  }
  assert.equal(handlerCalls, 0, '钩子拒绝时处理器不得执行')
  const restored = await fetch(base(h, '/api/t/public'))
  assert.equal(restored.status, 200, '注销钩子后应恢复')
  assert.equal(handlerCalls, 1)
})

test('use()：异步钩子生效，且按注册顺序串行执行（先注册的先跑）', async () => {
  const h = await server()
  const order: string[] = []
  const offFirst = h.router.use?.(async () => {
    await new Promise((r) => setTimeout(r, 5))
    order.push('first')
    return { ok: true }
  })
  const offSecond = h.router.use?.(() => {
    order.push('second')
    return { ok: true }
  })
  try {
    const res = await fetch(base(h, '/api/t/public'))
    assert.equal(res.status, 200)
    assert.deepEqual(order, ['first', 'second'], '串行且保序')
  } finally {
    offFirst?.()
    offSecond?.()
  }
})

test('use()：返回值形态不合法 ⇒ 按拒绝处理（失败关闭），而不是放行', async () => {
  const h = await server()
  handlerCalls = 0
  // 故意返回垃圾：插件写错不应该等于"全部放行"
  const off = h.router.use?.(() => undefined as never)
  try {
    const res = await fetch(base(h, '/api/t/public'))
    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { error: string }).error, 'hook_invalid_verdict')
  } finally {
    off?.()
  }
  assert.equal(handlerCalls, 0, '不合法的裁决不得放进处理器')
})

test('use()：钩子抛错 ⇒ 500，且不静默放行', async () => {
  const h = await server()
  handlerCalls = 0
  const off = h.router.use?.(() => {
    throw new Error('钩子内部炸了')
  })
  try {
    const res = await fetch(base(h, '/api/t/public'))
    assert.equal(res.status, 500)
    assert.equal(((await res.json()) as { error: string }).error, 'internal')
  } finally {
    off?.()
  }
  assert.equal(handlerCalls, 0)
})

test('use()：钩子可以替换 principal —— 闸门读的是 h.principal（P1 会话解析的挂载点）', async () => {
  const h = await server()
  handlerCalls = 0
  await withEnvToken(null, async () => {
    // 注意：此用例刻意**不配置** GEEWIKI_ADMIN_TOKEN，也没有任何令牌头。
    // 若闸门在钩子之前执行（或读的是局部变量），这里必然 503 —— 用例会红。
    const off = h.router.use?.((h2) => {
      h2.principal = breakGlassPrincipal()
      return { ok: true }
    })
    try {
      const res = await fetch(base(h, '/api/t/admin'), { method: 'POST' })
      assert.equal(res.status, 200, '钩子替换后的主体必须在闸门处生效')
      assert.equal(((await res.json()) as { principal: string }).principal, 'break-glass')
    } finally {
      off?.()
    }
  })
  assert.equal(handlerCalls, 1)
})

/* --------------------- 5. 静态层交接不受钩子影响 --------------------- */

test('注册钩子后：路由匹配与静态层交接的行为逐字不变', async () => {
  const h = await server()

  // 对照：未注册钩子时的两个响应（非 /api 路径交给静态层；/api 未匹配走路由的 API 404）
  const staticBefore = await fetch(base(h, '/some/static/path'))
  const staticBodyBefore = await staticBefore.text()
  const apiBefore = await fetch(base(h, '/api/nope'))

  const off = h.router.use?.(() => ({ ok: true }))
  assert.ok(off, '真实路由服务必须实现 use()')
  try {
    const staticAfter = await fetch(base(h, '/some/static/path'))
    assert.equal(staticAfter.status, staticBefore.status, '静态层交接不得因钩子而改变')
    assert.equal(await staticAfter.text(), staticBodyBefore, '静态层响应体应逐字一致')

    const apiAfter = await fetch(base(h, '/api/nope'))
    assert.equal(apiAfter.status, 404, '未匹配的 /api 路径仍应是路由的 API 404')
    assert.deepEqual(await apiAfter.json(), await apiBefore.json())
  } finally {
    off()
  }
})
