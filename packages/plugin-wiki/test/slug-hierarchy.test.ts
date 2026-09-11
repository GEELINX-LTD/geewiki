/**
 * 层级 slug（`guide/intro`）+ 列表排序稳定性 + 0002 迁移的测试。
 *
 * **本批要钉住的三件事**：
 *
 * 1. **路径式 slug 可用**。改造前 `SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/`
 *    不允许 `/`，因此无法表达层级（侧边栏页面树的前置条件）。本次先**实测**确认了
 *    路由层会把 `%2F` 解码回 `/` 并作为**单个**路径参数交给处理器
 *    （证据：`GET /api/pages/guide%2Fintro` 返回的是"路由已匹配"形态的 404
 *    `{"error":"not_found","message":"页面不存在: guide/intro"}`，而路由**未**匹配时
 *    返回的是 `{"error":"not_found","path":"/api/pages/guide/intro"}`），
 *    故只需放开服务端的校验规则。
 *
 * 2. **列表排序必须有次级键**。`updated_at` 是 ISO 秒级字符串，并列很常见。
 *    实测：同一份并列数据，无索引时单键排序得 `alpha,beta,gamma,delta,epsilon`，
 *    加上 `(updated_at DESC, id DESC)` 索引后单键排序**完全反转**为
 *    `epsilon,delta,gamma,beta,alpha` —— 也就是说"看起来稳定"的顺序会随查询计划
 *    悄悄翻转。因此 `ORDER BY` 必须显式带 `p.id DESC`（本文件用"同一并列集合
 *    连续多次读取结果一致 + 与 id 倒序一致"来钉住它）。
 *
 * 3. **0002 迁移幂等**：索引用 `IF NOT EXISTS`，且由 `db.migrate()` 包在单事务里执行。
 *
 * 测试策略沿用 `service.test.ts`：真实 SQLite（`node:sqlite`）+ 真实迁移文件 + 路由替身。
 * 只读**真实**的 SQL 文件而不抄一份 DDL，避免与生产漂移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import type {
  DatabaseAdapter,
  HttpRouterService,
  Principal,
  RouteHandler,
  RouteHandlerContext,
  RunResult,
} from '@geewiki/core'
import { MIGRATION_TABLE } from '@geewiki/core'
import { AuthzPlugin } from '@geewiki/authz'
import {
  SLUG_HINT,
  SLUG_MAX_DEPTH,
  SLUG_MAX_LENGTH,
  WikiPlugin,
  isValidSlug,
  type WikiService,
} from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

/** db-sqlite 的真实迁移目录（0001 建表、0002 建排序索引） */
/**
 * 夹具主体：**已登录的组织成员**。新建条目一律写 `visibility='org'`，匿名看不到它，
 * 用成员主体才能让"建完再读"的往返成立。
 */
const MEMBER: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')
/**
 * ★ P3a：`savePage` 会在同一事务里双写 `blocks` 与 `blocks_fts`，所以夹具也要建出块索引。
 * 它归 `@geewiki/search` 的迁移目录（FTS5 是 SQLite 专有，没有 PG 孪生文件）——
 * 与 db 目录分开列，保持"哪份迁移归哪个插件"的可读性。
 */
const SEARCH_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'plugin-search', 'migrations')

/** 按文件名序读出全部真实迁移 SQL（与 `db.migrate()` 的 `readdirSync().sort()` 同序） */
function readAllMigrations(): { name: string; sql: string }[] {
  const read = (dir: string): { name: string; sql: string }[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
  // 块表在 db 目录、块索引在 search 目录 —— 两者都要建，否则保存用例会 `no such table: blocks_fts`
  return [...read(MIGRATIONS_DIR), ...read(SEARCH_MIGRATIONS_DIR)]
}

/** `node:sqlite` 上的 DatabaseAdapter：只做同步转发，不含业务逻辑 */
class NodeSqliteAdapter implements DatabaseAdapter {
  readonly db: DatabaseSync

  constructor(filename: string, schemaSql: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec(schemaSql)
    // 迁移登记表（与 db-sqlite 建的同名同构）；schemaSql 已把 db-sqlite 的脚本内容建好，
    // 故把它们登记为"已应用"——这样 wiki 的自带迁移才会被当作**增量**应用。
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    const seed = this.db.prepare(`INSERT OR IGNORE INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
    for (const m of readAllMigrations()) seed.run(m.name, new Date().toISOString())
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const r = this.db.prepare(sql).run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint }
  }

  /**
   * 与 db-sqlite 同语义的迁移执行：按文件名序应用**未登记**的脚本，每个脚本一个事务。
   *
   * 这里不再是"显式不实现"：wiki 现在会应用**自己**的迁移（`page_links`），
   * 故夹具必须真的会迁移，否则测的就不是真实路径了。
   */
  migrate(directory?: string): void {
    if (!directory) throw new Error('本夹具需要显式迁移目录（wiki 传的是 WIKI_MIGRATIONS_DIR）')
    const applied = new Set(this.appliedMigrations())
    for (const name of readdirSync(directory)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (applied.has(name)) continue
      const sql = readFileSync(join(directory, name), 'utf8')
      this.transaction(() => {
        this.db.exec(sql)
        this.db
          .prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
          .run(name, new Date().toISOString())
      })
    }
  }

  listTables(): string[] {
    return this.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => r.name)
  }

  appliedMigrations(): string[] {
    return this.query<{ name: string }>(`SELECT name FROM ${MIGRATION_TABLE} ORDER BY name`).map((r) => r.name)
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
  ctx: Context
  call(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>
  svc(): WikiService
  dispose(): void
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-slug-'))
  const adapter = new NodeSqliteAdapter(
    join(dir, 'test.db'),
    readAllMigrations()
      .map((m) => m.sql)
      .join('\n'),
  )

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
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context
  // ★ P2：wiki 的读路径要向 policy-service 要判定，故夹具装**真实的**策略层
  // （不造假替身 —— 那会把"权限真的接线了没有"一并测掉）
  const disposeAuthz = (await (AuthzPlugin.apply as (c: Context) => Promise<unknown>)(ctx)) as () => void
  const disposeWiki = (await WikiPlugin.apply(ctx, { recentVersions: 10 })) as () => void
  const dispose = (): void => {
    disposeWiki()
    disposeAuthz()
  }

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
        // 生产里由 auth 的钩子填充；本夹具手工驱动处理器（不跑钩子），故显式给一个成员主体
        principal: MEMBER,
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  return {
    adapter,
    ctx,
    call,
    svc: () => {
      const svc = ctx.get('wiki-service') as WikiService | undefined
      assert.ok(svc, 'wiki-service 必须被 provide')
      return svc
    },
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

/** 便捷：保存一篇页面（走真实端点） */
const save = (h: Harness, slug: string, title = slug, content = 'x'): ReturnType<Harness['call']> =>
  h.call('PUT', '/api/pages/:slug', { slug }, { title, content })

/* ------------------ 1. 层级 slug：合法与非法（纯函数层） ------------------ */

test('isValidSlug：扁平 slug 的判定与改造前逐字一致（回归保护）', () => {
  for (const ok of ['a', '9', 'getting-started', 'a.b_c-d', `a${'b'.repeat(79)}`]) {
    assert.equal(isValidSlug(ok), true, `${ok} 应当合法`)
  }
  for (const bad of ['', '.a', '-a', '_a', 'a b', 'a/b/'.slice(0, 2) + ' ', 'a!b', '中文']) {
    assert.equal(isValidSlug(bad), false, `${bad} 应当非法`)
  }
  // 长度边界：≤80 合法、81 非法（既有预算不变）
  assert.equal(`a${'b'.repeat(79)}`.length, SLUG_MAX_LENGTH)
  assert.equal(isValidSlug(`a${'b'.repeat(80)}`), false)
})

test('isValidSlug：层级路径合法，且拒绝空段/前后斜杠/父目录段', () => {
  for (const ok of ['guide/intro', 'a/b/c', 'guide/intro.v2', 'docs/api/rest_v1']) {
    assert.equal(isValidSlug(ok), true, `${ok} 应当合法`)
  }
  for (const bad of [
    '/guide', // 以 / 开头 → 首段为空
    'guide/', // 以 / 结尾 → 末段为空
    'a//b', // 空段
    'guide/../etc', // `..` 段（首字符必须字母数字 ⇒ 被逐段字符集拒绝）
    '..',
    '.',
    'guide/.hidden', // 段以点开头
    'guide/-x',
  ]) {
    assert.equal(isValidSlug(bad), false, `${bad} 应当非法（路径逃逸/空段防护）`)
  }
  // 深度上限
  assert.equal(isValidSlug(Array.from({ length: SLUG_MAX_DEPTH }, () => 'a').join('/')), true)
  assert.equal(isValidSlug(Array.from({ length: SLUG_MAX_DEPTH + 1 }, () => 'a').join('/')), false)
})

test('isValidSlug：保留段被拒——首段 search/ask/new/list、第二段 edit', () => {
  // 首段保留：这些会被前端 hash 路由吃掉，建得出来也打不开
  for (const first of ['search', 'ask', 'new', 'list']) {
    assert.equal(isValidSlug(first), false, `${first} 作为首段应当非法`)
    assert.equal(isValidSlug(`${first}/child`), false, `${first}/child 应当非法`)
  }
  // 第二段保留：`<slug>/edit` 是编辑路由
  assert.equal(isValidSlug('guide/edit'), false)
  // `edit` 出现在**第二段**一律拒绝——包括更深的 `guide/edit/intro`：
  // 前端把"第二段是 edit"整体解释为编辑路由，故这种路径无法被无歧义地打开。
  assert.equal(isValidSlug('guide/edit/intro'), false, 'edit 在第二段时，无论后面还有几段都拒绝')
  // 但同名字符串出现在**其它位置**时不受限（避免过度拒绝）
  assert.equal(isValidSlug('guide/search'), true, 'search 只在首段保留')
  assert.equal(isValidSlug('edit'), true, 'edit 作为首段（单段）合法')
  assert.equal(isValidSlug('edit/intro'), true, 'edit 在首段、intro 在第二段 ⇒ 合法')
  assert.equal(isValidSlug('guide/intro/edit'), true, 'edit 在第三段不受限')
})

/* ------------------ 2. 层级 slug：端点往返（集成层） ------------------ */

test('层级 slug 的完整 CRUD 往返：PUT → GET → 列表 → 版本 → DELETE', async () => {
  const h = await makeHarness()
  try {
    // PUT 新建
    const put = await save(h, 'guide/intro', '入门', '第一版正文')
    assert.equal(put.status, 200)
    assert.equal(put.body['slug'], 'guide/intro', 'slug 必须原样往返（不被解码/截断）')
    assert.equal(put.body['outcome'], 'created')

    // GET 详情
    const got = await h.call('GET', '/api/pages/:slug', { slug: 'guide/intro' })
    assert.equal(got.status, 200)
    assert.equal(got.body['slug'], 'guide/intro')
    assert.equal(got.body['title'], '入门')
    assert.equal(got.body['content'], '第一版正文')

    // 列表里出现，且 slug 带斜杠
    const list = await h.call('GET', '/api/pages')
    const slugs = (list.body['pages'] as { slug: string }[]).map((p) => p.slug)
    assert.ok(slugs.includes('guide/intro'), `列表应含 guide/intro，实际 ${JSON.stringify(slugs)}`)

    // 更新（产生历史快照）
    const put2 = await save(h, 'guide/intro', '入门', '第二版正文')
    assert.equal(put2.body['outcome'], 'updated')
    assert.equal(put2.body['version'], 2)

    // 版本端点可用（该端点路径段更多，是 %2F 解码的额外验证点）
    // 注意：要**重新读取**详情才有更新后的历史（第一次的 got 取自更新之前）
    const afterUpdate = await h.call('GET', '/api/pages/:slug', { slug: 'guide/intro' })
    const versions = (afterUpdate.body['versions'] as { id: number }[]) ?? []
    assert.ok(versions.length >= 1, `更新后应至少有 1 条历史版本，实际 ${JSON.stringify(versions)}`)
    const vid = versions[0]!.id
    const ver = await h.call('GET', '/api/pages/:slug/versions/:id', { slug: 'guide/intro', id: String(vid) })
    assert.equal(ver.status, 200)
    assert.equal(ver.body['content'], '第一版正文')

    // DELETE
    const del = await h.call('DELETE', '/api/pages/:slug', { slug: 'guide/intro' })
    assert.equal(del.status, 200)
    assert.equal(del.body['deleted'], 'guide/intro')
    const after = await h.call('GET', '/api/pages/:slug', { slug: 'guide/intro' })
    assert.equal(after.status, 404)
  } finally {
    h.dispose()
  }
})

test('多级 slug（a/b/c）同样往返一致，且与扁平 slug 互不干扰', async () => {
  const h = await makeHarness()
  try {
    await save(h, 'a', '顶层')
    await save(h, 'a/b', '二级')
    await save(h, 'a/b/c', '三级')

    for (const slug of ['a', 'a/b', 'a/b/c']) {
      const got = await h.call('GET', '/api/pages/:slug', { slug })
      assert.equal(got.status, 200, `${slug} 应可读取`)
      assert.equal(got.body['slug'], slug)
    }
    // 不是前缀匹配语义：删 a/b 不应影响 a 与 a/b/c
    await h.call('DELETE', '/api/pages/:slug', { slug: 'a/b' })
    assert.equal((await h.call('GET', '/api/pages/:slug', { slug: 'a' })).status, 200)
    assert.equal((await h.call('GET', '/api/pages/:slug', { slug: 'a/b/c' })).status, 200)
    assert.equal((await h.call('GET', '/api/pages/:slug', { slug: 'a/b' })).status, 404)
  } finally {
    h.dispose()
  }
})

test('非法 slug 经端点仍返回 400 invalid_slug（错误语义不变）', async () => {
  const h = await makeHarness()
  try {
    for (const bad of ['search/x', 'guide/edit', 'a//b', 'guide/', 'guide/../x', 'x'.repeat(81) + '/y']) {
      const res = await save(h, bad)
      assert.equal(res.status, 400, `${bad} 应 400`)
      assert.equal(res.body['error'], 'invalid_slug', `${bad} 错误码应为 invalid_slug`)
      assert.equal(res.body['message'], SLUG_HINT, '错误文案应来自同一份 SLUG_HINT')
    }
    // 服务层同口径（消息前缀即错误码）。异步方法抛错 = rejection，故用 assert.rejects
    await assert.rejects(async () => h.svc().save('search/x', { title: 't', content: 'c' }), /^Error: invalid_slug: /)
    await assert.rejects(async () => h.svc().save('guide/../etc', { title: 't', content: 'c' }), /^Error: invalid_slug: /)
  } finally {
    h.dispose()
  }
})

/* ------------------ 3. 排序稳定性（并列 updated_at） ------------------ */

test('列表排序稳定：updated_at 全部并列时，顺序由 id DESC 决定且可重复', async () => {
  const h = await makeHarness()
  try {
    const slugs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    for (const s of slugs) await save(h, s)

    // 制造并列：把所有 updated_at 改成同一个值（模拟批量导入）
    h.adapter.db.prepare('UPDATE pages SET updated_at = ?').run('2026-01-01T00:00:00.000Z')

    const order = async (): Promise<string[]> =>
      ((await h.call('GET', '/api/pages')).body['pages'] as { slug: string }[]).map((p) => p.slug)

    const first = await order()
    // 次级键为 id DESC ⇒ 后插入的（id 更大）排前面，与插入顺序**相反**
    assert.deepEqual(first, ['epsilon', 'delta', 'gamma', 'beta', 'alpha'])

    // 连续多次读取必须完全一致（否则分页/侧边栏会漏项或重项）
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await order(), first, `第 ${i + 2} 次读取顺序应与首次一致`)
    }

    // 打破并列后仍按 updated_at 优先
    h.adapter.db.prepare('UPDATE pages SET updated_at = ? WHERE slug = ?').run('2030-01-01T00:00:00.000Z', 'alpha')
    assert.deepEqual((await order())[0], 'alpha', 'updated_at 更新者应排最前')
  } finally {
    h.dispose()
  }
})

test('列表排序：分页切片不重不漏（同一并列集合）', async () => {
  const h = await makeHarness()
  try {
    for (const s of ['p1', 'p2', 'p3', 'p4', 'p5']) await save(h, s)
    h.adapter.db.prepare('UPDATE pages SET updated_at = ?').run('2026-01-01T00:00:00.000Z')

    const all = ((await h.call('GET', '/api/pages')).body['pages'] as { slug: string }[]).map((p) => p.slug)
    // 模拟"每页 2 条"的两页拼接：顺序确定 ⇒ 拼接结果必须等于整表顺序，且无重复
    const page1 = all.slice(0, 2)
    const page2 = all.slice(2, 4)
    const merged = [...page1, ...page2]
    assert.equal(new Set(merged).size, merged.length, '分页拼接不得出现重复项')
    assert.deepEqual(merged, all.slice(0, 4), '分页拼接应等于整表的前 4 条')
  } finally {
    h.dispose()
  }
})

/* ------------------ 4. 0002 迁移 ------------------ */

test('0002 迁移：建出排序索引、可重复执行（幂等）、且与查询计划相符', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-mig-'))
  const db = new DatabaseSync(join(dir, 'm.db'))
  try {
    const migrations = readAllMigrations()
    assert.ok(
      migrations.some((m) => m.name === '0002_pages_updated_at_index.sql'),
      `迁移目录应含 0002，实际 ${JSON.stringify(migrations.map((m) => m.name))}`,
    )

    // 逐文件执行（与 db.migrate() 同序）。
    //
    // ★ 重放保证分两类，**分开断言而不是一律跳过**（P2 给 pages 加列时引入）：
    //
    //   - 只含 `CREATE ... IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 的文件，
    //     重放必须**不抛错**（原有的强断言，逐字保留）。
    //   - 含 `ALTER TABLE ... ADD COLUMN` 的文件**在 SQLite 上无法重放** ——
    //     SQLite 没有 `ADD COLUMN IF NOT EXISTS`，纯 SQL 表达不出"列不存在才加"。
    //     这不是疏忽，而是方言的能力边界：0010 当初把新列内联进新建表的
    //     CREATE TABLE 从而绕开了它，而 0012 给**既有表** pages 加列绕不开。
    //     生产幂等性由 `_migrations` 控制器提供（已应用的文件不再执行），
    //     所以这里**把这个限制钉死**：第一次必须成功，第二次必须抛
    //     `duplicate column name` —— 哪天有人误以为它能重放，这条断言会红。
    const isReplayable = (sql: string) => !/\bADD\s+COLUMN\b/i.test(sql)
    for (const m of migrations) db.exec(m.sql)

    for (const m of migrations.filter((x) => isReplayable(x.sql))) {
      db.exec(m.sql) // 重放：不得抛错
    }

    const notReplayable = migrations.filter((x) => !isReplayable(x.sql))
    assert.ok(
      notReplayable.length > 0,
      'P2 起应存在含 ADD COLUMN 的迁移（0012_page_acl.sql）；若为空说明这条断言失去了对象',
    )
    for (const m of notReplayable) {
      assert.throws(
        () => db.exec(m.sql),
        /duplicate column name/i,
        `${m.name} 含 ALTER TABLE ADD COLUMN，在 SQLite 上**应当**无法重放（已知方言边界，非缺陷）`,
      )
    }

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pages'`)
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)
    assert.ok(names.includes('idx_pages_updated_at'), `应建出 idx_pages_updated_at，实际 ${JSON.stringify(names)}`)

    // 查询计划应使用该索引（而不是临时 B 树）——这正是加索引的目的
    const plan = (
      db.prepare('EXPLAIN QUERY PLAN SELECT slug FROM pages ORDER BY updated_at DESC, id DESC').all() as {
        detail: string
      }[]
    )
      .map((r) => r.detail)
      .join(' | ')
    assert.match(plan, /idx_pages_updated_at/, `计划应走新索引，实际：${plan}`)
    assert.doesNotMatch(plan, /TEMP B-TREE/, `不应再需要临时 B 树，实际：${plan}`)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
