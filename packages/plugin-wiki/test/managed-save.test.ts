/**
 * `wiki-service` 系统写方面扩展的行为测试：
 *
 *   1. `save(input.visibility / published)` —— 仅创建分支生效、档位/发布**原子**落库，
 *      且块的 `tier` 按**新档位**算（这是 `pageLevelOf` 的 self 三元组必须跟着 input 走
 *      的原因：留一档错算 = 检索与读路径当场漂移）；
 *   2. 缺省形态零回归（不传 ⇒ 仍 'org' + 未发布，既有 D8 语义）；
 *   3. 更新分支**忽略**这两个字段（改档位的正道是带 `canManageVisibility` 的专用端点）；
 *   4. 脏值当场抛错（`invalid_visibility` / `invalid_published`），不会以"未知档位"
 *      的形态静默入库；
 *   5. `exists(slug)` —— 与可见性无关的存在性探测（契约里唯一的"端点外"方法，
 *      判据注释见 `WikiService.exists`）；
 *   6. **HTTP 面钉死**：PUT 请求体带 `visibility` 仍回 400（`parseSaveBody` 白名单），
 *      新字段是服务路径专属——用户改档位依旧只有专用端点一条路。
 *
 * 夹具沿用 `slug-hierarchy.test.ts`：真迁移 + 真策略层（判据不造假）+ 路由替身。
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
import { WikiPlugin, type WikiService } from '../src/index.js'

const MEMBER: Principal = { kind: 'user', userId: 1, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

/* ------------------------------ 夹具 ------------------------------ */

const DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')
const SEARCH_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'plugin-search', 'migrations')

function readAllMigrations(): { name: string; sql: string }[] {
  const read = (dir: string): { name: string; sql: string }[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
  return [...read(DB_MIGRATIONS_DIR), ...read(SEARCH_MIGRATIONS_DIR)]
}

class NodeSqliteAdapter implements DatabaseAdapter {
  readonly db: DatabaseSync

  constructor(filename: string, schemaSql: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec(schemaSql)
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

  migrate(directory?: string): void {
    if (!directory) throw new Error('本夹具需要显式迁移目录')
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

  appliedMigrations(): string[] {
    return this.query<{ name: string }>(`SELECT name FROM ${MIGRATION_TABLE} ORDER BY name`).map((r) => r.name)
  }

  listTables(): string[] {
    return this.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => r.name)
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

interface PolicyLike {
  resolvePage(p: Principal, slug: string): Promise<{ level: string; canEdit: boolean }>
}

interface Harness {
  adapter: NodeSqliteAdapter
  ctx: Context
  svc(): WikiService
  policy(): PolicyLike
  call(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>
  dispose(): void
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiki-managed-'))
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
    emit: () => {},
  } as unknown as Context
  const disposeAuthz = (await (AuthzPlugin.apply as (c: Context) => Promise<unknown>)(ctx)) as () => void
  const disposeWiki = (await WikiPlugin.apply(ctx, { recentVersions: 10 })) as () => void

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
        principal: MEMBER,
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  return {
    adapter,
    ctx,
    svc: () => ctx.get('wiki-service') as WikiService,
    policy: () => ctx.get('policy-service') as PolicyLike,
    call,
    dispose: () => {
      disposeWiki()
      disposeAuthz()
      adapter.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const pageRow = (
  h: Harness,
  slug: string,
): { visibility: string; published_at: string | null; content: string } => {
  const rows = h.adapter.query<{ visibility: string; published_at: string | null; content: string }>(
    'SELECT visibility, published_at, content FROM pages WHERE slug = ?',
    [slug],
  )
  assert.equal(rows.length, 1, `页面 ${slug} 应存在`)
  return rows[0]!
}

/** 该页全部块的 (visibility → tier) 映射——tier 是按页算的，用它反推档位有没有算错 */
const tiersOf = (h: Harness, slug: string): Record<string, number | null> => {
  const rows = h.adapter.query<{ visibility: string; tier: number | null }>(
    `SELECT b.visibility, b.tier FROM blocks b JOIN pages p ON p.id = b.page_id WHERE p.slug = ? ORDER BY b.ordinal`,
    [slug],
  )
  assert.ok(rows.length > 0, `${slug} 应有块行`)
  const out: Record<string, number | null> = {}
  for (const r of rows) out[r.visibility] = r.tier
  return out
}

/* ============================== 1. 缺省形态零回归 ============================== */

test('不传新字段 ⇒ 创建分支维持既有默认：org、未发布、块 tier=1（D8 语义回归保护）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const res = await h.svc().save('plain-page', { title: '普通页', content: '普通正文' })
  assert.equal(res.outcome, 'created')
  const row = pageRow(h, 'plain-page')
  assert.equal(row.visibility, 'org')
  assert.equal(row.published_at, null)
  assert.deepEqual(tiersOf(h, 'plain-page'), { public: 1 }, 'org 页的 public 块 tier 应为 1（页面档位封顶）')
  assert.equal((await h.policy().resolvePage(ANON, 'plain-page')).level, 'none')
})

/* ============================== 2. public + published 原子建档 ============================== */

test('visibility=public + published=true ⇒ 匿名立即可读，块 tier 按新档位算（0），不会留错算窗口', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.svc().save('pub-doc', {
    title: '公开文档',
    content: '公开段落。\n\n<!--gated:org-->\n成员专属段落。\n<!--/gated-->',
    visibility: 'public',
    published: true,
  })
  const row = pageRow(h, 'pub-doc')
  assert.equal(row.visibility, 'public')
  assert.notEqual(row.published_at, null, 'published:true 必须当场打 published_at（发布闸门）')
  const anon = await h.policy().resolvePage(ANON, 'pub-doc')
  assert.equal(anon.level, 'full', 'public+published ⇒ 匿名 full（缺任何一个都会是 none）')
  assert.equal(anon.canEdit, false, '匿名 public 也只有读权')
  assert.deepEqual(tiersOf(h, 'pub-doc'), { public: 0, org: 1 }, '块 tier：public 块 0、org 块 1——若 pageLevelOf 仍收硬编码 org，public 块会错算成 1')
})

test('只给 visibility=public 不给 published ⇒ 创建成功但对所有人不可见（发布闸门的反例钉住）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.svc().save('unpub-doc', { title: '未发布', content: '内容', visibility: 'public' })
  assert.equal(pageRow(h, 'unpub-doc').published_at, null)
  assert.equal((await h.policy().resolvePage(ANON, 'unpub-doc')).level, 'none')
  assert.equal((await h.policy().resolvePage(MEMBER, 'unpub-doc')).level, 'none', '未发布的 public 连成员也读不到——这是既有闸门语义，不是 bug')
})

/* ============================== 3. 更新分支忽略新字段 ============================== */

test('更新分支忽略 visibility/published：档位变更仍只有专用端点一条路', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.svc().save('keep-vis', { title: 'A', content: '一', visibility: 'public', published: true })
  await h.svc().save('keep-vis', { title: 'A', content: '二', visibility: 'org', published: false })
  const row = pageRow(h, 'keep-vis')
  assert.equal(row.content, '二', '正文正常更新')
  assert.equal(row.visibility, 'public', '更新分支不得碰档位列（见 WikiSaveInput 的 JSDoc）')
  assert.notEqual(row.published_at, null)
})

/* ============================== 4. 脏值当场抛 ============================== */

test('脏值当场抛错且不留半成品页（invalid_visibility / invalid_published / invalid_slug）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await assert.rejects(
    () => h.svc().save('bad-vis', { title: 'x', content: 'y', visibility: 'secret' as 'public' }),
    /invalid_visibility/,
  )
  await assert.rejects(
    () => h.svc().save('bad-pub', { title: 'x', content: 'y', published: 'yes' as unknown as boolean }),
    /invalid_published/,
  )
  assert.equal(await h.svc().exists('bad-vis'), false)
  assert.equal(await h.svc().exists('bad-pub'), false)
  await assert.rejects(() => h.svc().exists('坏 slug!'), /invalid_slug/)
})

/* ============================== 5. exists 与可见性无关 ============================== */

test('exists：不存在的页 false；private 页照样 true（get 对看不见的页回 undefined，接管护栏必须问 exists）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  assert.equal(await h.svc().exists('nothing-here'), false)
  await h.svc().save('secret-page', { title: '私有', content: 'z', visibility: 'private' })
  assert.equal(await h.svc().exists('secret-page'), true)
  assert.equal(await h.svc().get('secret-page', ANON), undefined, '同一页：get 看不见、exists 知道——两者的分工')
})

/* ============================== 6. HTTP 面白名单 ============================== */

test('PUT /api/pages/:slug 带 visibility 字段 ⇒ 400 invalid_body（新字段是服务路径专属）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const res = await h.call('PUT', '/api/pages/:slug', { slug: 'http-vis' }, {
    title: '用户想偷偷公开',
    content: '正文',
    visibility: 'public',
  })
  assert.equal(res.status, 400)
  assert.equal(res.body['error'], 'invalid_body')
  assert.equal(await h.svc().exists('http-vis'), false, '被拒的请求不得留下页面')
})
