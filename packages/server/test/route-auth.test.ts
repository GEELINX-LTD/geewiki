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
  type Principal,
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

    /* ★ F9：能力闸门。同一处理器、三种声明，用来断言"读的是能力表"而不是某种内建规则 */
    router.register('GET', '/api/t/cap-granted', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true, scope: 'cap-granted' })
    }, { capability: 'test/granted' })
    router.register('GET', '/api/t/cap-denied', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true, scope: 'cap-denied' })
    }, { capability: 'test/denied' })
    // access 与 capability 是**两层**：匿名的 401 必须先于能力的 403 出现
    router.register('GET', '/api/t/cap-user', (h: RouteHandlerContext) => {
      handlerCalls++
      h.json(200, { ok: true, scope: 'cap-user' })
    }, { access: 'user', capability: 'test/granted' })
  })
}

/**
 * ★ F9：用**真实路径**注册两个能力 —— 经 manager 提供的 `capability-service` 注册求解器，
 * 而不是在测试里再造一个服务提供者。
 *
 * 为什么不造假服务：`capability-service` 由 manager 自己 `ctx.provide`，再造一个会
 * 直接撞上 cordis 的"服务重复注册"错误（实测）。更重要的是：走真实注册路径才能顺带
 * 覆盖"插件怎么把自己的能力接进闸门"这件事 —— 那正是 F9 要交付的能力。
 *
 * 两个能力刻意取相反的值，用来断言闸门读的是**能力表**而非某种内建规则。
 */
function capabilityPlugin(): RegisteredPlugin {
  const name = '@t/capability'
  const manifest: GeeWikiManifest = {
    name,
    version: '1.0.0',
    geewiki: {
      requires: ['http-service'],
      // ★ F9 清单声明：让 manager 的诊断端点能看见"谁引入了哪些能力"。
      // 声明与求解器是两件事 —— 少了下面 apply 里的 provide，该能力会恒为 false，
      // 而这个字段存在的意义正是让那种情况**可见**（见 manager 的 unresolvedCapabilities）。
      capabilities: [
        { name: 'test/granted', label: '测试：放行' },
        { name: 'test/denied', label: '测试：拒绝' },
      ],
      runtime: { supportsHotReload: true, drainTimeout: 5 },
    },
  }
  return {
    name,
    manifest,
    module: {
      name,
      apply(ctx: Context) {
        const svc = ctx.get('capability-service') as
          | { provide(owner: string, n: string, r: (p: Principal) => boolean): () => void }
          | undefined
        assert.ok(svc, 'manager 应已 provide capability-service（F9）')
        const undoGranted = svc.provide(name, 'test/granted', () => true)
        const undoDenied = svc.provide(name, 'test/denied', () => false)
        return () => {
          undoGranted()
          undoDenied()
        }
      },
    },
  }
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-route-auth-'))
  const port = await freePort()
  let router: HttpRouterService | undefined
  const capture = testPlugin('@t/auth-capture', (_ctx, r) => {
    router = r
  })
  const registry: RegisteredPlugin[] = [
    httpRegistryEntry(null, { port, host: '127.0.0.1' }),
    capabilityPlugin(),
    capture,
    probePlugin(),
  ]
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
    /*
     * ★ X3：网关层的拒绝（这里是 `gateThenInvoke` 的 401）**也是响应**，两个安全头一个都不能少。
     * 附件能力的 401/403 正是在这里发出的 —— 那时插件的处理器还没跑，插件在自己入口设的
     * `nosniff` / `no-store` 根本轮不到（真机实测修复前 `x-content-type-options` 为 null）。
     * 这里直接断言响应头，而不是只断言状态码：状态码对而头缺失是**静默**的。
     */
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff', '网关拒绝也必须带 nosniff')
    assert.equal(missing.headers.get('cache-control'), 'no-store', '网关拒绝也不可被启发式缓存')

    const wrong = await fetch(base(h, '/api/t/admin'), {
      method: 'POST',
      headers: { 'x-gw-admin-token': 'not-the-token' },
    })
    assert.equal(wrong.status, 401, '错误令牌是"未认证"，不是"无权限"')
    assert.equal(wrong.headers.get('x-content-type-options'), 'nosniff')
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
    const body = (await denied.json()) as {
      ok: boolean
      error: string
      message: string
      details?: { access?: string }
    }
    assert.equal(body.ok, false)
    assert.equal(body.error, 'forbidden')
    assert.equal(body.message, '被钩子拒绝')
    // 信封形状必须与闸门的拒绝一致（**含 `details.access`**）：同类失败两种形状会让前端
    // 文案与告警匹配规则漂移。这条断言覆盖的是 **runHooks 的拒绝路径** ——
    // 与下面那个走 gateThenInvoke 的 403 用例是**两条不同的代码路径**，不能互相替代。
    assert.equal(body.details?.access, 'public', '钩子拒绝的信封应与闸门拒绝同形（含 details.access）')
    /*
     * ★ X3：这条走的是 **runHooks 的拒绝路径**（缺 CSRF 的 403 就是从这里出去的），
     * 与上面 401 用例走的是另一条代码路径 —— 两条都得带 nosniff，缺哪条都会漏。
     */
    assert.equal(denied.headers.get('x-content-type-options'), 'nosniff', '钩子拒绝也必须带 nosniff')
    assert.equal(denied.headers.get('cache-control'), 'no-store')
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

test("use()：kind:'user' 但角色不足 ⇒ 403 forbidden（P1 首个真实 403 的回归保护）", async () => {
  const h = await server()
  handlerCalls = 0
  // 为什么这里**必须**配置令牌（与本文件其余用例相反）：judgeAccess 里
  // "没有凭据来源 ⇒ 503" 的检查排在匿名/角色检查**之前**，所以未配置令牌时
  // 任何非 public 端点都先撞上 503，403 分支根本走不到。配置令牌才是 403 的适用前提。
  await withEnvToken(ADMIN_TOKEN, async () => {
    // 动机：P0 阶段 src/ 里不存在 kind:'user' 的主体（用户表属 P1），
    // 于是 judgeAccess 的 403 分支既不可达、也零覆盖。这里经 use() 钩子造出一个
    // "已认证但权限不足"的主体，把该分支钉成断言，P1 接真实会话时就有回归保护。
    const viewer: Principal = {
      kind: 'user',
      userId: 7,
      orgId: 1,
      orgRole: 'viewer',
      groupIds: [],
      sessionId: 'test-session',
    }
    const off = h.router.use?.((h2) => {
      h2.principal = viewer
      return { ok: true }
    })
    try {
      // 对照：同一主体在 user 级端点上**应当放行** ⇒ 证明下面的 403 来自"角色不足"，
      // 而不是"user 主体一律被拒"（否则这个用例对 403 分支其实没有区分力）。
      const userLevel = await fetch(base(h, '/api/t/user'))
      assert.equal(userLevel.status, 200, 'user 级端点：已认证即可，不看角色')
      assert.equal(((await userLevel.json()) as { principal: string }).principal, 'user')

      const res = await fetch(base(h, '/api/t/admin'), { method: 'POST' })
      assert.equal(res.status, 403, '已认证但角色不足应是 403（不是 401，也不是 503）')
      const body = (await res.json()) as {
        ok: boolean
        error: string
        message: string
        details?: { access?: string }
      }
      assert.equal(body.ok, false)
      assert.equal(body.error, 'forbidden')
      assert.equal(body.details?.access, 'admin', '错误信封形状应与闸门的拒绝一致（含 details.access）')
    } finally {
      off?.()
    }
  })
  assert.equal(handlerCalls, 1, '只有 user 级那次应进入处理器；403 那次不得触达处理器')
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

/* --------------------- ★ F9：能力闸门（第二层，access 之后） --------------------- */

test('★ F9 能力闸门：具备能力放行，不具备 ⇒ 403 capability_required 且处理器未执行', async () => {
  const h = await server()
  await withEnvToken(ADMIN_TOKEN, async () => {
    handlerCalls = 0
    const granted = await fetch(base(h, '/api/t/cap-granted'), { headers: adminHeaders() })
    assert.equal(granted.status, 200, '能力表中为 true ⇒ 放行')

    const denied = await fetch(base(h, '/api/t/cap-denied'), { headers: adminHeaders() })
    assert.equal(denied.status, 403, '能力表中为 false ⇒ 403（即使 access 已通过）')
    const body = (await denied.json()) as { ok: boolean; error: string; details?: { capability?: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error, 'capability_required')
    assert.equal(body.details?.capability, 'test/denied', '错误信封应带上被拒的能力名，便于定位是哪个插件的能力')

    // 关键断言：被拒的那次**没有进入处理器**（否则"闸门"只是装饰）
    assert.equal(handlerCalls, 1, `只有放行的那次应执行处理器，实际执行了 ${handlerCalls} 次`)
  })
})

test('★ F9 能力闸门：access 与 capability 是两层，匿名的 401 先于能力的 403', async () => {
  const h = await server()
  await withEnvToken(ADMIN_TOKEN, async () => {
    handlerCalls = 0
    /*
     * 该路由同时声明 `access:'user'` 与 `capability:'test/granted'`。
     * 匿名请求必须拿到 **401**（"你先登录"），而不是 403 capability_required ——
     * 顺序反了会把"没登录"报成"能力不足"，用户于是永远不知道该去登录。
     */
    const res = await fetch(base(h, '/api/t/cap-user'))
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error: string }
    assert.equal(body.error, 'unauthorized')
    assert.equal(handlerCalls, 0)

    // 带上管理员令牌后两层都满足 ⇒ 放行
    const ok = await fetch(base(h, '/api/t/cap-user'), { headers: adminHeaders() })
    assert.equal(ok.status, 200)
  })
})
