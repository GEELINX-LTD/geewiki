/**
 * ★ F11：全路由访问等级审计。
 *
 * ## 本文件存在的理由
 * `register()` 的第 4 参可省，省略即 `access: 'public'`（匿名可调）。全仓近百个调用点
 * 于是全靠作者自觉 —— 而"**忘了写**"与"**故意公开**"在源码里长得一模一样：两种情况的
 * `access` 都是 `'public'`，**评审看不见、运行期也没有痕迹**。这正是审计报告 §3.1 里
 * 那条「中等」级问题的形态。
 *
 * 修复分两步，本文件各钉一半：
 * 1. **逐个显式化**（已有调用点）—— 于是"公开"变成作者写下来的决定；
 * 2. **全量审计**（本文件第一个用例）—— 于是**将来**新增的隐式公开路由会立刻变红，
 *    必须同时改这里或补上 `access`，一定会出现在 diff 里。
 *
 * 第二个用例组钉 `auditRouteAccess` 本身：它是**启动期**防线（严格模式直接拒启），
 * 而"审计跑了但什么都没审计到"是这类代码最容易退化成摆设的方式 —— 所以既钉
 * "有未审计路由时会报"，也钉"审计确实看到了非空路由表"。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unauditedRoutes, type HttpRouteInfo, type HttpRouterService } from '@geewiki/core'
import { auditRouteAccess, buildRegistry, startServer, STRICT_ROUTE_ACCESS_ENV } from '../src/index.js'
import { freePort, waitForHealth } from './helpers.js'

/* ==================== 1. 全量默认路由：不得有未声明的公开 ==================== */

test('★ F11：全量默认路由表的每一条都显式声明了访问等级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-route-audit-'))
  /*
   * ★ 数据目录也必须隔离到临时目录（2026-09-17 修）。
   *
   * 本文件用 `buildRegistry()` 拿的是**完整默认注册表**，里面包含 `@geewiki/db-sqlite`
   * —— 而它的缺省路径是 `<仓库根>/data/geewiki.db`（`process.env.GEEWIKI_DATA_DIR
   * ?? DEFAULT_DATA_DIR`）。于是这 3 个用例此前**每次跑测试都会打开并迁移开发者真实的
   * 数据库**：新写的迁移会被悄悄地应用在真数据上，而测试输出里只有一行不起眼的
   * `[db-sqlite] 已就绪: …/data/geewiki.db`。
   *
   * 症状是"某次 pnpm test 之后真实库的 _migrations 多了一条"——**没有任何测试失败**，
   * 所以它可以存在很久（本仓上一批 0022 迁移就是这么被发现被提前应用了的）。
   * `router.test.ts` 早就在做同样的事（设置同名环境变量 8 处），这里照做。
   */
  const previousDataDir = process.env.GEEWIKI_DATA_DIR
  process.env.GEEWIKI_DATA_DIR = join(dir, 'data')
  const port = await freePort()
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    // 用**完整默认注册表**（不是手工拼的最小集合）：审计的价值全在覆盖面
    const built = await buildRegistry(null, { port, host: '127.0.0.1' }, null, () => ({}))
    writeFileSync(
      join(dir, 'plugins.base.json'),
      `${JSON.stringify({ enabled: built.registry.map((e) => ({ name: e.name })) }, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(join(dir, 'plugins.session.json'), `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')

    handle = await startServer({
      registry: built.registry,
      port,
      host: '127.0.0.1',
      configDir: dir,
      webDist: null,
    })
    await waitForHealth(port)

    const router = handle.app.get('http') as HttpRouterService
    const routes = router.routes?.()
    assert.ok(routes, 'http 服务必须提供 routes() 枚举（否则审计无从谈起）')

    /*
     * 先断言"确实枚举到了一张真实的路由表"再断言"没有未声明的"。
     * 少了这一条，一次把枚举写坏的改动会让下面那条断言**空集通过** ——
     * 而"审计通过"与"什么都没审计"必须可区分。
     */
    assert.ok(
      routes.length >= 20,
      `枚举到的路由数只有 ${routes.length} 条，明显偏少 —— 审计可能没跑在全量路由表上`,
    )

    const offenders = unauditedRoutes(routes)
    assert.deepEqual(
      offenders.map((r) => `${r.method} ${r.path}`),
      [],
      '以下路由未显式声明访问等级（正按默认 public 匿名可调）：\n' +
        offenders.map((r) => `  ${r.method} ${r.path}`).join('\n') +
        '\n请给它们的 register() 补第 4 参：保留现状写 { access: \'public\' }，' +
        '或收紧为 { access: \'user\' } / { access: \'admin\' }。',
    )
  } finally {
    if (handle) await handle.dispose()
    // 环境变量是**进程级**的：用完必须还原，否则会漏给同一进程里的后续测试
    if (previousDataDir === undefined) delete process.env.GEEWIKI_DATA_DIR
    else process.env.GEEWIKI_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ F11：多个插件的路由都进了同一张表且顺序 = 激活顺序', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-route-audit2-'))
  /*
   * ★ 数据目录也必须隔离到临时目录（2026-09-17 修）。
   *
   * 本文件用 `buildRegistry()` 拿的是**完整默认注册表**，里面包含 `@geewiki/db-sqlite`
   * —— 而它的缺省路径是 `<仓库根>/data/geewiki.db`（`process.env.GEEWIKI_DATA_DIR
   * ?? DEFAULT_DATA_DIR`）。于是这 3 个用例此前**每次跑测试都会打开并迁移开发者真实的
   * 数据库**：新写的迁移会被悄悄地应用在真数据上，而测试输出里只有一行不起眼的
   * `[db-sqlite] 已就绪: …/data/geewiki.db`。
   *
   * 症状是"某次 pnpm test 之后真实库的 _migrations 多了一条"——**没有任何测试失败**，
   * 所以它可以存在很久（本仓上一批 0022 迁移就是这么被发现被提前应用了的）。
   * `router.test.ts` 早就在做同样的事（设置同名环境变量 8 处），这里照做。
   */
  const previousDataDir = process.env.GEEWIKI_DATA_DIR
  process.env.GEEWIKI_DATA_DIR = join(dir, 'data')
  const port = await freePort()
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const built = await buildRegistry(null, { port, host: '127.0.0.1' }, null, () => ({}))
    writeFileSync(
      join(dir, 'plugins.base.json'),
      `${JSON.stringify({ enabled: built.registry.map((e) => ({ name: e.name })) }, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(join(dir, 'plugins.session.json'), `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
    handle = await startServer({ registry: built.registry, port, host: '127.0.0.1', configDir: dir, webDist: null })
    await waitForHealth(port)
    const routes = (handle.app.get('http') as HttpRouterService).routes?.() ?? []

    // 覆盖面：至少三个不同插件贡献了路由（否则"全路由审计"名不副实）
    for (const path of ['/api/pages', '/api/auth/state', '/api/plugins']) {
      assert.ok(
        routes.some((r) => r.path === path),
        `路由表里应有 ${path}（说明该插件的路由确实被审计到了）`,
      )
    }
    // path 必须是**注册时的原始形态**（带 :param），否则审计清单没法与源码对上
    assert.ok(
      routes.some((r) => r.path.includes(':slug')),
      'path 应保留 :param 原始形态（诊断清单要能与源码逐字对照）',
    )
    // explicit 字段必须真的反映了"写没写"
    assert.ok(routes.every((r) => typeof r.explicit === 'boolean'))
  } finally {
    if (handle) await handle.dispose()
    // 环境变量是**进程级**的：用完必须还原，否则会漏给同一进程里的后续测试
    if (previousDataDir === undefined) delete process.env.GEEWIKI_DATA_DIR
    else process.env.GEEWIKI_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ==================== 2. auditRouteAccess 的行为 ==================== */

const route = (over: Partial<HttpRouteInfo> = {}): HttpRouteInfo => ({
  method: 'GET',
  path: '/api/x',
  access: 'public',
  explicit: true,
  ...over,
})

/** 只实现审计用到的 `routes()`；其余方法不会被调用 */
const fakeRouter = (routes: readonly HttpRouteInfo[]): HttpRouterService =>
  ({ routes: () => routes }) as unknown as HttpRouterService

function captureWarn<T>(run: () => T): { value: T; warned: string[] } {
  const warned: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    return { value: run(), warned }
  } finally {
    console.warn = orig
  }
}

test('auditRouteAccess：全部显式声明时完全静默（不制造噪声）', () => {
  const { warned } = captureWarn(() => auditRouteAccess(fakeRouter([route(), route({ explicit: true })]), {}))
  assert.deepEqual(warned, [], '没有问题时不该打任何日志——噪声会把告警训练成背景音')
})

test('auditRouteAccess：有未声明路由时聚合为**一条**告警并列出清单', () => {
  const { warned } = captureWarn(() =>
    auditRouteAccess(
      fakeRouter([route(), route({ path: '/api/y', explicit: false }), route({ path: '/api/z', explicit: false })]),
      {},
    ),
  )
  assert.equal(warned.length, 1, '应聚合成一条，而不是每条路由一行')
  const msg = warned[0] ?? ''
  assert.match(msg, /2\/3 条路由未显式声明/)
  assert.match(msg, /\/api\/y/)
  assert.match(msg, /\/api\/z/)
  assert.doesNotMatch(msg, /\/api\/x/, '已声明的路由不该出现在清单里')
})

test('auditRouteAccess：严格模式**拒绝启动**（抛错并带上完整清单）', () => {
  assert.throws(
    () =>
      auditRouteAccess(fakeRouter([route({ path: '/api/leak', explicit: false })]), {
        [STRICT_ROUTE_ACCESS_ENV]: '1',
      }),
    (err: unknown) => {
      const m = err instanceof Error ? err.message : String(err)
      assert.match(m, /严格模式拒绝启动/)
      assert.match(m, /\/api\/leak/)
      return true
    },
    '严格模式下必须抛错 —— 一个"带默认 public 上线的新端点"应当让进程直接起不来，而不是悄悄暴露',
  )
})

test('auditRouteAccess：严格模式在无问题时也不抛错（否则等于禁用严格模式）', () => {
  assert.doesNotThrow(() => auditRouteAccess(fakeRouter([route()]), { [STRICT_ROUTE_ACCESS_ENV]: '1' }))
})

test('auditRouteAccess：第三方实现不提供 routes() 时静默跳过（审计是增强，不是前置条件）', () => {
  const noIntrospection = {} as unknown as HttpRouterService
  const { warned } = captureWarn(() => auditRouteAccess(noIntrospection, {}))
  assert.deepEqual(warned, [])
})

after(() => {
  // 用例各自清理；这里只保留钩子以便将来加共享夹具
})

/* ==================== 3. ★ F12：按登记方归因的请求计数 ==================== */

test('★ F12：owner 请求计数可枚举，且**被闸门拒绝的请求同样计入**', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-owner-stats-'))
  /*
   * ★ 数据目录也必须隔离到临时目录（2026-09-17 修）。
   *
   * 本文件用 `buildRegistry()` 拿的是**完整默认注册表**，里面包含 `@geewiki/db-sqlite`
   * —— 而它的缺省路径是 `<仓库根>/data/geewiki.db`（`process.env.GEEWIKI_DATA_DIR
   * ?? DEFAULT_DATA_DIR`）。于是这 3 个用例此前**每次跑测试都会打开并迁移开发者真实的
   * 数据库**：新写的迁移会被悄悄地应用在真数据上，而测试输出里只有一行不起眼的
   * `[db-sqlite] 已就绪: …/data/geewiki.db`。
   *
   * 症状是"某次 pnpm test 之后真实库的 _migrations 多了一条"——**没有任何测试失败**，
   * 所以它可以存在很久（本仓上一批 0022 迁移就是这么被发现被提前应用了的）。
   * `router.test.ts` 早就在做同样的事（设置同名环境变量 8 处），这里照做。
   */
  const previousDataDir = process.env.GEEWIKI_DATA_DIR
  process.env.GEEWIKI_DATA_DIR = join(dir, 'data')
  const port = await freePort()
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const built = await buildRegistry(null, { port, host: '127.0.0.1' }, null, () => ({}))
    writeFileSync(
      join(dir, 'plugins.base.json'),
      `${JSON.stringify({ enabled: built.registry.map((e) => ({ name: e.name })) }, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(join(dir, 'plugins.session.json'), `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
    handle = await startServer({ registry: built.registry, port, host: '127.0.0.1', configDir: dir, webDist: null })
    await waitForHealth(port)

    /*
     * ★ 先**初始化实例**（创建首个账号），再断言闸门行为。
     *
     * 闸门在"库里一个可登录账号都没有"时返回 **503 bootstrap_required**（引导语义），
     * 而不是 401。本用例要在下面断言"匿名访问 admin 端点 ⇒ 401"，那需要一个**已初始化**的实例。
     *
     * ⚠️ 这条前置此前**不存在**，而断言照样通过 —— 因为它跑在开发者**真实的 data/** 上
     * （那里有账号）。也就是说这个用例不仅污染真实库，还**依赖真实库的内容**：
     * 换一台干净的机器/CI 跑，它就会以 503 失败。隔离之后必须显式建号。
     */
    const boot = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gw-csrf': '1' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'ownerpass123', displayName: 'Owner' }),
    })
    assert.equal(boot.status, 201, '前置：首个账号应能创建（否则下面那条 401 会变成 503）')

    const router = handle.app.get('http') as HttpRouterService

    // 内置 manager 的路由声明了 owner（F12 的示范用法）⇒ 未发任何请求时也应出现，且 requests=0
    const before = router.ownerStats?.() ?? []
    const mgr = before.find((o) => o.owner === '@geewiki/manager')
    assert.ok(mgr, 'manager 的路由应已登记 owner（否则整个归因能力没有示范用法）')
    assert.ok(mgr.routes > 0, 'routes 应统计该 owner 名下的路由条数')
    assert.equal(mgr.requests, 0, '还没发请求时计数应为 0（不是缺省成 1 之类的假值）')

    // `/api/plugins` 是 public ⇒ 一次普通请求即被计入
    await fetch(`http://127.0.0.1:${port}/api/plugins`)
    // `/api/plugins/health` 是 admin ⇒ 匿名会被 403；**拒绝也必须计入**（否则"被匿名打"看不见）
    const denied = await fetch(`http://127.0.0.1:${port}/api/plugins/health`)
    // admin 端点对**匿名**主体先返回 401（"你先登录"），而不是 403 —— 这是 judgeAccess 的既定顺序
    assert.equal(denied.status, 401, '前置：该端点应当是 admin 级（匿名 ⇒ 401）')

    const after = router.ownerStats?.() ?? []
    const mgrAfter = after.find((o) => o.owner === '@geewiki/manager')
    assert.equal(mgrAfter?.requests, 2, '一次放行 + 一次被拒，都应计入（计数在闸门之前）')

    /*
     * 未声明 owner 的路由**不得**被硬塞给某个插件：它们既不出现在列表里，也不会
     * 让某个无关插件的计数凭空变大。错误归因比没有归因更危险 —— 它会让运维去查错人。
     */
    const owners = after.map((o) => o.owner)
    assert.equal(new Set(owners).size, owners.length, 'owner 不得重复')
    assert.ok(!owners.includes(''), '空字符串不得成为 owner')
  } finally {
    if (handle) await handle.dispose()
    // 环境变量是**进程级**的：用完必须还原，否则会漏给同一进程里的后续测试
    if (previousDataDir === undefined) delete process.env.GEEWIKI_DATA_DIR
    else process.env.GEEWIKI_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})
