/**
 * @geewiki/wiki 的 `wiki-service` 服务契约测试。
 *
 * **本批要钉住的核心问题**：manifest 的 `geewiki.provides` 只是**依赖图 token**，
 * 不会创建 cordis 服务。此前的缺陷是本插件声明了 `provides: 'wiki-service'`
 * 却从未 `ctx.provide` —— 于是任何按 `requires: ['wiki-service']` 依赖本插件的消费方
 * `ctx.get('wiki-service')` 都会拿到 `undefined`，症状是"永远拿不到数据"这类极难定位的
 * 表现（与 `search-service` 曾经的问题同型）。
 *
 * **测试策略**（与 @geewiki/search 的集成测试同思路：真实数据库 + 真实 SQL，只有 HTTP 层用替身）：
 * - 用 Node 22 内置的 `node:sqlite` 驱动**真实 SQLite**，并直接执行 db-sqlite 的
 *   `src/migrations/0001_init.sql`（**读真实文件，不抄一份 DDL**，避免表结构漂移）；
 *   之所以不用 `@geewiki/db-sqlite`：本包未声明该依赖，而本批不允许改 pnpm-lock.yaml。
 *   适配器只做"同步 API 转发"，不含业务逻辑，故不会把要验证的东西替掉。
 * - 服务方法与四个端点**共用同一份内部实现**，故本文件同时断言两者的结果逐字段一致
 *   （这正是"单一实现"的可执行证据）。
 * - 跨插件可见性单独用**真实 cordis + 真实 ctx.plugin()** 覆盖（替身 ctx 只能证明同 ctx 内）。
 *
 * 每个用例在自己的临时库上跑，绝不触碰仓库的 data/geewiki.db。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import { Context as CordisContext } from 'cordis'
import type { DatabaseAdapter, HttpRouterService, RouteHandler, RouteHandlerContext, RunResult } from '@geewiki/core'
import { SLUG_HINT, WikiPlugin, manifest, type WikiService } from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

/** db-sqlite 的真实初始迁移（wiki 的 pages / page_versions 表由它建立） */
const INIT_SQL_PATH = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations', '0001_init.sql')

/**
 * `node:sqlite`（Node 内置）上的 DatabaseAdapter 实现。
 *
 * 只做同步转发：`query`/`run` 把参数按顺序绑定，`transaction` 用 BEGIN/COMMIT/ROLLBACK。
 * 不含任何业务逻辑——被验证的 SQL 与事务语义仍是插件自己的。
 */
class NodeSqliteAdapter implements DatabaseAdapter {
  private readonly db: DatabaseSync

  constructor(filename: string, schemaSql: string) {
    this.db = new DatabaseSync(filename)
    // 真实迁移脚本（多语句）一次执行；表结构与生产完全一致
    this.db.exec(schemaSql)
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const r = this.db.prepare(sql).run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint }
  }

  /** wiki 插件不调用迁移控制器（表由 db-sqlite 建立），故显式不实现而非伪装成功 */
  migrate(): void {
    throw new Error('本夹具不实现 migrate（@geewiki/wiki 不调用它）')
  }

  listTables(): string[] {
    return this.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => r.name)
  }

  appliedMigrations(): string[] {
    return []
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}

interface Harness {
  adapter: NodeSqliteAdapter
  /** 插件的 ctx（用于断言 provide 出来的 wiki-service） */
  ctx: Context
  /** 底层服务表：db/http 由夹具预置，wiki-service 由插件 provide 进去 */
  services: Map<string, unknown>
  /** 调用某个已注册端点（path 形如 '/api/pages'，params 为路径参数） */
  call(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>
  /** 直接取服务（顺带断言它确实被 provide 出来了） */
  svc(): WikiService
  /** 路由是否仍注册（卸载后应为 false） */
  hasRoute(method: string, path: string): boolean
  unload(): void
  dispose(): void
}

/**
 * 建一个隔离的 wiki 环境：真实 SQLite + 真实初始迁移 + 路由服务替身。
 * `provide` 按 cordis 的**同 ctx** 语义实现（provide→get 立即可见、注销后回到 undefined）。
 */
function makeHarness(config: { recentVersions?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-'))
  const adapter = new NodeSqliteAdapter(join(dir, 'test.db'), readFileSync(INIT_SQL_PATH, 'utf8'))

  const routes = new Map<string, RouteHandler>()
  const routerService: HttpRouterService = {
    register: (method, path, handler) => {
      routes.set(`${method} ${path}`, handler)
      return () => routes.delete(`${method} ${path}`)
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  }
  const services = new Map<string, unknown>([
    ['db', adapter],
    ['http', routerService],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => {
        // 与 cordis 一致：注销把名字摘掉，后续 get 回到 undefined
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context
  const dispose = WikiPlugin.apply(ctx, { recentVersions: 10, ...config }) as () => void

  const call = (
    method: string,
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const handler = routes.get(`${method} ${path}`)
    assert.ok(handler, `应已注册路由 ${method} ${path}`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers =
      body === undefined ? {} : { 'content-length': String(chunks[0]?.length ?? 0) }
    return new Promise((resolve, reject) => {
      const h: RouteHandlerContext = {
        req,
        res: { once: () => {} } as unknown as ServerResponse,
        url: new URL(`http://localhost${path}`),
        params,
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  return {
    adapter,
    ctx,
    services,
    call,
    svc: () => {
      const svc = ctx.get('wiki-service') as WikiService | undefined
      assert.ok(svc, 'wiki-service 必须被 provide（manifest 的 provides 只是依赖图 token，不建服务）')
      return svc
    },
    hasRoute: (method, path) => routes.has(`${method} ${path}`),
    unload: () => dispose(),
    dispose: () => {
      try {
        dispose()
      } finally {
        adapter.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

/* ------------------ 1. 服务存在性与契约（本批核心） ------------------ */

test('wiki-service：apply 后 ctx.get 拿得到，四个方法与 manifest 的 provides 一致', () => {
  const h = makeHarness()
  try {
    // 探针反证：manifest 声明的 provides 不会自己变成 cordis 服务——
    // 若插件里漏掉 ctx.provide，这里拿到的是 undefined（这正是本批要修的症状）
    assert.equal(manifest.geewiki.provides, 'wiki-service', '前置：manifest 声明的 token 名')
    assert.ok(h.services.has('wiki-service'), 'provide 应把服务登记进 ctx')
    const svc = h.svc()
    for (const m of ['list', 'get', 'save', 'remove'] as const) {
      assert.equal(typeof svc[m], 'function', `wiki-service.${m} 应是函数`)
    }
    assert.deepEqual(svc.list(), [], '空库应返回空列表')
    assert.equal(svc.get('nope'), undefined, '不存在的 slug 返回 undefined（对应端点 404）')
  } finally {
    h.dispose()
  }
})

test('wiki-service：save 新建 → 读取 → 列表；内容未变时 outcome=unchanged 且不写历史', () => {
  const h = makeHarness()
  try {
    const svc = h.svc()

    // 新建
    assert.deepEqual(svc.save('getting-started', { title: '入门', content: '第一版' }), {
      outcome: 'created',
      version: 1,
    })
    const created = svc.get('getting-started')
    assert.ok(created, 'save 后应能读到')
    assert.equal(created.title, '入门')
    assert.equal(created.content, '第一版')
    assert.equal(created.version, 1, '新建页面版本号为 1')
    assert.deepEqual(created.versions, [], '新建不产生历史')

    // 幂等：标题与正文都没变 → unchanged，且不新增历史、版本号不变
    assert.deepEqual(svc.save('getting-started', { title: '入门', content: '第一版' }), {
      outcome: 'unchanged',
      version: 1,
    })
    const afterNoop = svc.get('getting-started')
    assert.equal(afterNoop?.version, 1, 'unchanged 不应推进版本号')
    assert.deepEqual(afterNoop?.versions, [], 'unchanged 不应写历史快照')
    assert.equal(afterNoop?.updated_at, created.updated_at, 'unchanged 不应改 updated_at')

    // 更新：旧正文进历史，版本号 +1
    assert.deepEqual(svc.save('getting-started', { title: '入门', content: '第二版' }), {
      outcome: 'updated',
      version: 2,
    })
    const updated = svc.get('getting-started')
    assert.equal(updated?.content, '第二版')
    assert.equal(updated?.version, 2)
    assert.equal(updated?.versions.length, 1, '更新应留下一条历史')
    // 历史里存的是**旧**正文（版本即历史）
    const versionId = updated?.versions[0]?.id
    assert.equal(
      h.adapter.query<{ content: string }>('SELECT content FROM page_versions WHERE id = ?', [versionId])[0]?.content,
      '第一版',
      '历史快照应是更新前的旧正文',
    )

    // 列表：摘要字段与排序（单条时只校验字段形状）
    assert.deepEqual(svc.list(), [
      {
        slug: 'getting-started',
        title: '入门',
        updated_at: updated?.updated_at,
        version: 2,
      },
    ])

    // 标题变化也应记为更新（即使正文相同）
    assert.equal(svc.save('getting-started', { title: '入门（改名）', content: '第二版' }).outcome, 'updated')
  } finally {
    h.dispose()
  }
})

test('wiki-service：remove 删除页面与历史；不存在的 slug 返回 false', () => {
  const h = makeHarness()
  try {
    const svc = h.svc()
    svc.save('temp', { title: '临时', content: 'a' })
    svc.save('temp', { title: '临时', content: 'b' }) // 产生一条历史
    assert.equal(h.adapter.query('SELECT id FROM page_versions').length, 1, '前置：应有一条历史')

    assert.equal(svc.remove('temp'), true, '删除存在的页面应返回 true')
    assert.equal(svc.get('temp'), undefined, '删除后 get 应返回 undefined')
    assert.deepEqual(svc.list(), [], '删除后列表应为空')
    assert.equal(h.adapter.query('SELECT id FROM page_versions').length, 0, '版本历史应一并清除')

    assert.equal(svc.remove('temp'), false, '删除不存在的页面应返回 false（对应端点 404）')
  } finally {
    h.dispose()
  }
})

test('wiki-service：非法入参抛错，消息前缀与端点的错误码同源', () => {
  const h = makeHarness()
  try {
    const svc = h.svc()
    // 非法 slug
    assert.throws(() => svc.save('bad slug!', { title: 't', content: 'c' }), /^Error: invalid_slug: /)
    // 空标题（含仅空白）
    assert.throws(() => svc.save('ok-slug', { title: '   ', content: 'c' }), /^Error: invalid_title: /)
    // 标题过长
    assert.throws(() => svc.save('ok-slug', { title: 'x'.repeat(201), content: 'c' }), /^Error: invalid_title: /)
    // 正文过长（与端点同为 500KB 上限）
    assert.throws(
      () => svc.save('ok-slug', { title: 't', content: 'y'.repeat(500_001) }),
      /^Error: content_too_large: /,
    )
    // 非法 remove 入参同样拒绝
    assert.throws(() => svc.remove('../etc'), /^Error: invalid_slug: /)
    assert.deepEqual(svc.list(), [], '校验失败不得留下任何落库副作用')
  } finally {
    h.dispose()
  }
})

/* ---------- 2. 服务与端点同源（单一实现的可执行证据） ---------- */

test('wiki-service 与 REST 端点结果逐字段一致（服务只是把同一实现包成 HTTP）', async () => {
  const h = makeHarness()
  try {
    const svc = h.svc()

    // 经端点写入 → 服务读取
    const put = await h.call('PUT', '/api/pages/:slug', { slug: 'via-http' }, { title: 'HTTP 写入', content: 'v1' })
    assert.equal(put.status, 200)
    assert.equal(put.body['outcome'], 'created')
    assert.deepEqual(
      svc.get('via-http'),
      {
        slug: 'via-http',
        title: 'HTTP 写入',
        content: 'v1',
        created_at: svc.get('via-http')?.created_at,
        updated_at: svc.get('via-http')?.updated_at,
        version: 1,
        versions: [],
      },
      '端点写入的内容，服务应逐字段读到',
    )

    // 经服务写入 → 端点读取（同一实现，两条路径必须等价）
    svc.save('via-svc', { title: '服务写入', content: 'v1' })
    const detail = await h.call('GET', '/api/pages/:slug', { slug: 'via-svc' })
    assert.equal(detail.status, 200)
    assert.deepEqual(Object.keys(detail.body).sort(), [
      'content',
      'created_at',
      'slug',
      'title',
      'updated_at',
      'version',
      'versions',
    ])
    assert.equal(detail.body['content'], 'v1')
    assert.equal(detail.body['version'], 1)

    // 列表：服务的 list() 与端点 pages 数组逐字段一致（含顺序）
    const list = await h.call('GET', '/api/pages')
    assert.deepEqual(list.body['pages'], svc.list())

    // 幂等语义在两条路径上一致：端点 unchanged ⇔ 服务 unchanged
    const putSame = await h.call('PUT', '/api/pages/:slug', { slug: 'via-svc' }, { title: '服务写入', content: 'v1' })
    assert.equal(putSame.body['outcome'], 'unchanged')
    assert.equal(svc.save('via-svc', { title: '服务写入', content: 'v1' }).outcome, 'unchanged')

    // 删除：端点在服务删除后应 404（两条路径共享同一状态）
    assert.equal(svc.remove('via-http'), true)
    const gone = await h.call('GET', '/api/pages/:slug', { slug: 'via-http' })
    assert.equal(gone.status, 404)
    assert.equal(gone.body['error'], 'not_found')
  } finally {
    h.dispose()
  }
})

test('端点既有错误语义未被本次重构改变（invalid_slug 400 / 未知字段 400 / 正文超限 413）', async () => {
  const h = makeHarness()
  try {
    const badSlug = await h.call('PUT', '/api/pages/:slug', { slug: '../etc/passwd' }, { title: 't', content: 'c' })
    assert.equal(badSlug.status, 400)
    assert.equal(badSlug.body['error'], 'invalid_slug')
    // 断言与端点共用同一份 SLUG_HINT（不再硬编码文案：规则升级文案必然变化，
    // 硬编码会让"文案改了"被误报成"语义坏了"。本用例要守的是状态码+错误码+文案同源）
    assert.equal(badSlug.body['message'], SLUG_HINT)

    const unknownField = await h.call('PUT', '/api/pages/:slug', { slug: 'ok' }, { title: 't', content: 'c', nope: 1 })
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.body['error'], 'invalid_body')

    const tooLong = await h.call('PUT', '/api/pages/:slug', { slug: 'ok' }, { title: 't', content: 'y'.repeat(500_001) })
    assert.equal(tooLong.status, 413)
    assert.equal(tooLong.body['error'], 'content_too_large')

    const notFound = await h.call('DELETE', '/api/pages/:slug', { slug: 'missing' })
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body['error'], 'not_found')
  } finally {
    h.dispose()
  }
})

/* ------------------ 3. 卸载语义（不留"仍可调用但已失效"） ------------------ */

test('wiki-service：卸载后 ctx.get 回到 undefined、路由摘除、旧引用调用显式报错', () => {
  const h = makeHarness()
  try {
    const svc = h.svc() // 卸载前先拿到引用（模拟"消费方仍持有旧引用"）
    svc.save('p', { title: 't', content: 'c' })
    assert.equal(h.hasRoute('GET', '/api/pages'), true, '前置：卸载前路由已注册')

    h.unload()

    assert.equal(h.ctx.get('wiki-service'), undefined, '卸载后服务应注销')
    assert.equal(h.hasRoute('GET', '/api/pages'), false, '卸载后路由应摘除')
    assert.equal(h.hasRoute('PUT', '/api/pages/:slug'), false, '卸载后写路由也应摘除')
    assert.equal(h.adapter.query('SELECT id FROM pages').length, 1, '数据仍在（卸载不删数据）')

    // 旧引用不得静默返回空结果，而应显式报错
    assert.throws(() => svc.list(), /插件已卸载，wiki-service 不可再调用/)
    assert.throws(() => svc.get('p'), /插件已卸载，wiki-service 不可再调用/)
    assert.throws(() => svc.save('p', { title: 't', content: 'c' }), /插件已卸载，wiki-service 不可再调用/)
    assert.throws(() => svc.remove('p'), /插件已卸载，wiki-service 不可再调用/)
  } finally {
    h.dispose()
  }
})

test('真实 cordis：wiki-service 对兄弟插件可见，卸载后注销', async () => {
  // 为什么单独写一例：上面的 harness 用替身 ctx，只能证明"同 ctx 内 provide→get"。
  // 而消费方会是**另一个插件**（各自跑在 ctx.plugin() 的子 fiber 里）。
  // 这里用真实 cordis + 真实 ctx.plugin() 装配，证明跨插件可见性在生产路径上成立。
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-cordis-'))
  const adapter = new NodeSqliteAdapter(join(dir, 'test.db'), readFileSync(INIT_SQL_PATH, 'utf8'))
  try {
    const routes = new Map<string, RouteHandler>()
    const routerService: HttpRouterService = {
      register: (method, path, handler) => {
        routes.set(`${method} ${path}`, handler)
        return () => routes.delete(`${method} ${path}`)
      },
      stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
      inflight: () => 0,
      pending: () => 0,
      drain: () => Promise.resolve(true),
    }

    const root = new CordisContext()
    root.provide('db', adapter)
    root.provide('http', routerService)

    // 生产路径：管理器就是 `await ctx.plugin(module, config)` 逐插件激活
    const fork = root.plugin(WikiPlugin, { recentVersions: 10 })
    await fork

    const svc = root.get('wiki-service') as WikiService | undefined
    assert.ok(svc, '真实 cordis 下 root.get 也应拿到 wiki-service')

    // 兄弟插件：模拟未来的消费方在自己的 apply 里 ctx.get('wiki-service')
    let seenBySibling: unknown = 'NOT_RUN'
    const sibling = {
      name: '@geewiki-test/wiki-consumer',
      apply(ctx: Context) {
        seenBySibling = ctx.get('wiki-service')
        return () => {}
      },
    }
    const siblingFork = root.plugin(sibling)
    await siblingFork // 生产里依赖插件先激活，故这里也 await 完成后再看
    assert.notEqual(seenBySibling, undefined, '兄弟插件必须能 ctx.get 到 wiki-service')
    assert.equal(seenBySibling, svc, '兄弟插件拿到的应是同一个服务实例')

    // 兄弟插件经服务写入，宿主侧端点能读到（跨插件经服务操作同一份数据）
    svc.save('cross-plugin', { title: '跨插件', content: '正文' })
    assert.equal(adapter.query('SELECT COUNT(*) AS n FROM pages')[0]?.['n'], 1)

    // 卸载后对所有人注销
    await siblingFork.dispose()
    await fork.dispose()
    assert.equal(root.get('wiki-service'), undefined, '卸载后服务应注销')
    assert.equal(routes.has('GET /api/pages'), false, '卸载后路由应摘除')
  } finally {
    adapter.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------------- 能力边界：异步数据库必须显式拒绝 ---------------------- */

/**
 * 为什么值得单测：wiki 的 ~15 处 db 调用是**同步**写法。若拿异步适配器（PostgreSQL）
 * 静默放行，插件会正常启动、但每个接口都读不到数据 —— "能启动但全是空的"是最难排查的
 * 一类故障。故这里钉住"必须抛错、且错误里要给出可执行指引"。
 */
test('异步数据库适配器：wiki 显式拒绝并给出指引（不静默坏掉）', () => {
  const services = new Map<string, unknown>([
    [
      'db',
      {
        kind: 'async',
        dialect: 'postgres',
        query: async () => [],
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        migrate: async () => undefined,
        listTables: async () => [],
        appliedMigrations: async () => [],
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
        close: async () => undefined,
      },
    ],
  ])
  const ctx = { get: (n: string) => services.get(n) } as unknown as Context
  assert.throws(
    () => WikiPlugin.apply(ctx, {}),
    (err: Error) => {
      assert.match(err.message, /异步适配器（postgres）/, '错误里必须点明方言')
      assert.match(err.message, /db-sqlite/, '错误里必须给出可执行的替代方案')
      return true
    },
  )
})
