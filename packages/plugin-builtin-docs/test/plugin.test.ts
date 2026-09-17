/**
 * `@geewiki/builtin-docs` 的插件级行为测试。
 *
 * **测试策略**：沿用 `plugin-wiki/test/slug-hierarchy.test.ts` 的夹具——手工组装的
 * cordis `Context`（get/provide 落到一个 Map）+ `node:sqlite` 真库 + 真迁移文件 +
 * **真实的 `@geewiki/authz` 与 `@geewiki/wiki`**（不造假判据：本包的全部价值就是
 * "策略层按记账页收敛能力"，判据换成替身就等于没测）。只把 `http` 换成路由替身。
 *
 * 这个选择同时兑现了另一条纪律：`@geewiki/authz` 自己**没有**行为测试基建（只有
 * 源码守卫），内置文档的只读/隐藏规则在那里实现、在这里被真跑——测试与实现分居
 * 两包但共用一个策略层实例，正是生产形态。
 *
 * 本文件钉住的核心不变量（按测试顺序）：
 *   1. 首启建档：5 篇全部就位，public + 已发布（发布闸门），记账齐；
 *   2. **全员可读、无人可写**：匿名能读（public+published），owner 也没有编辑权；
 *   3. 隐藏对所有主体生效（含 owner，隐藏 ≠ 覆盖式访问），且判据随卸载**整体消失**；
 *   4. 版本戳不等 ⇒ 覆盖被改坏的正文 + 清掉目录里已删的记账页；
 *   5. 版本戳相等 ⇒ 零写入（被手改的正文也**不会**被修复——同步是版本键控的，不是巡检）；
 *   6. 接管护栏：slug 撞名时跳过并盖章，用户的同名页不受锁、不受隐藏；
 *   7. 卸载只撤判据，**不删页面**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import {
  MIGRATION_TABLE,
  type DatabaseAdapter,
  type HttpRouterService,
  type Principal,
  type RouteHandler,
  type RunResult,
} from '@geewiki/core'
import { AuthzPlugin } from '@geewiki/authz'
import { WikiPlugin, type WikiService } from '@geewiki/wiki'
import { BuiltinDocsPlugin } from '../src/index.js'
import { BUILTIN_DOCS } from '../src/catalog.js'
import { DOCS_VERSION, type BuiltinDocsService } from '../src/types.js'

/* ------------------------------ 主体 ------------------------------ */

const MEMBER: Principal = { kind: 'user', userId: 1, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }
const OWNER: Principal = { kind: 'user', userId: 2, orgId: 1, orgRole: 'owner', groupIds: [], sessionId: null }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

/* ------------------------------ 夹具（自包含，抄 slug-hierarchy） ------------------------------ */

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

/** 策略层的消费面（结构化，与本包在 authz 里的消费口径一致） */
interface PolicyLike {
  resolvePage(p: Principal, slug: string): Promise<{
    level: string
    canEdit: boolean
    canDelete: boolean
    canManageVisibility: boolean
    reason: string
  }>
  visibleSlugs(p: Principal, q?: { prefix?: string; levels?: readonly string[] }): Promise<string[]>
}

interface Harness {
  adapter: NodeSqliteAdapter
  ctx: Context
  wiki(): WikiService
  policy(): PolicyLike
  docs(): BuiltinDocsService
  /** 应用内置文档插件（返回它的 dispose）；重复调用前须先 dispose 上一次 */
  applyDocs(config?: { hidden?: boolean }): Promise<() => void>
  dispose(): void
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-builtin-docs-'))
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
  void routes // 路由本身不是本文件的测试对象（wiki/authz 自己的测试管这个）

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
    // 本夹具没有事件消费者（ai-summary 才有），wiki 的 page-saved 广播落空即可——
    // 给个空实现只为不淹没 stderr（真 cordis 恒有此方法）
    emit: () => {},
  } as unknown as Context

  const disposeAuthz = (await (AuthzPlugin.apply as (c: Context) => Promise<unknown>)(ctx)) as () => void
  const disposeWiki = (await WikiPlugin.apply(ctx, { recentVersions: 10 })) as () => void

  const requireSvc = <T>(name: string): T => {
    const svc = ctx.get(name) as T | undefined
    assert.ok(svc, `${name} 必须被 provide`)
    return svc
  }

  let disposeDocs: (() => void) | null = null
  return {
    adapter,
    ctx,
    wiki: () => requireSvc<WikiService>('wiki-service'),
    policy: () => requireSvc<PolicyLike>('policy-service'),
    docs: () => requireSvc<BuiltinDocsService>('builtin-docs-service'),
    async applyDocs(config = {}) {
      assert.equal(disposeDocs, null, '同一夹具不要叠两个 docs 实例：先 dispose 上一次')
      const dispose = (await BuiltinDocsPlugin.apply(ctx, config)) as () => void
      disposeDocs = () => {
        dispose()
        disposeDocs = null
      }
      return disposeDocs
    },
    dispose: () => {
      disposeDocs?.()
      disposeWiki()
      disposeAuthz()
      adapter.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const stateValue = (h: Harness, key: string): string | undefined =>
  h.adapter.query<{ value: string }>('SELECT value FROM builtin_docs_state WHERE key = ?', [key])[0]?.value

const pageRow = (h: Harness, slug: string): { title: string; content: string; visibility: string; published_at: string | null } => {
  const rows = h.adapter.query<{ title: string; content: string; visibility: string; published_at: string | null }>(
    'SELECT title, content, visibility, published_at FROM pages WHERE slug = ?',
    [slug],
  )
  assert.equal(rows.length, 1, `页面 ${slug} 应存在`)
  return rows[0]!
}

/* ============================== 1. 首启建档 ============================== */

test('首次部署：目录里的 5 篇全部建档，public + 已发布，记账齐、服务判据就位', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.applyDocs()

  for (const doc of BUILTIN_DOCS) {
    const row = pageRow(h, doc.slug)
    assert.equal(row.title, doc.title)
    assert.equal(row.content, doc.content, `${doc.slug} 的正文应与目录逐字节一致`)
    // 发布闸门只约束 public 档：创建为 public 而不发布 = 对所有人不可见，所以必须同时发布
    assert.equal(row.visibility, 'public')
    assert.notEqual(row.published_at, null, `${doc.slug} 必须已发布（否则 public 等于没建）`)
    assert.equal(stateValue(h, `page:${doc.slug}`) !== undefined, true, `${doc.slug} 应有记账行`)
  }
  assert.equal(stateValue(h, 'docs_version'), String(DOCS_VERSION))
  assert.equal(h.docs().isManagedPage('home'), true)
  assert.equal(h.docs().isManagedPage('someone/else/page'), false)
})

/* ============================== 2. 全员可读、无人可写 ============================== */

test('只读语义：匿名可读（public+已发布），但 owner/member/anon 一律无编辑、无删除、无改权限', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.applyDocs()

  for (const [label, principal, expectReadable] of [
    ['anon', ANON, true], // public + published ⇒ 匿名 full；这正是产品文档该有的形态
    ['member', MEMBER, true],
    ['owner', OWNER, true],
  ] as const) {
    const access = await h.policy().resolvePage(principal, 'guide/architecture')
    assert.equal(access.level, expectReadable ? 'full' : 'none', `${label} 应${expectReadable ? '读得到' : '读不到'}`)
    assert.equal(access.canEdit, false, `${label} 不得有编辑权（内置文档只读）`)
    assert.equal(access.canDelete, false, `${label} 不得有删除权`)
    assert.equal(access.canManageVisibility, false, `${label} 不得能改可见性`)
  }

  // 列表与检索按同一判据收敛（都经 visibleSlugs ⇒ buildAccess 单点覆盖生效）
  const visible = await h.policy().visibleSlugs(MEMBER)
  for (const doc of BUILTIN_DOCS) assert.ok(visible.includes(doc.slug), `${doc.slug} 应出现在可见集里`)
  const listed = await h.wiki().list(MEMBER)
  assert.equal(listed.length, BUILTIN_DOCS.length)
})

/* ============================== 3. 隐藏 ============================== */

test('hidden=true：对所有主体（含 owner）视同不存在；卸载判据后一切恢复可见', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const dispose = await h.applyDocs({ hidden: true })

  for (const principal of [ANON, MEMBER, OWNER]) {
    const access = await h.policy().resolvePage(principal, 'home')
    assert.equal(access.level, 'none', `隐藏对 ${principal.kind}/${principal.orgRole} 也必须成立（隐藏 ≠ 覆盖式访问）`)
    assert.equal(access.canEdit, false)
  }
  const visible = await h.policy().visibleSlugs(MEMBER)
  for (const doc of BUILTIN_DOCS) assert.ok(!visible.includes(doc.slug), `${doc.slug} 不得出现在可见集里`)
  assert.equal((await h.wiki().list(MEMBER)).length, 0)
  assert.equal(await h.wiki().get('home', MEMBER), undefined, '阅读页口径同样 404（不泄露"存在但隐藏"）')

  // 页面本体从未被删——隐藏是判据，不是数据操作
  assert.equal(pageRow(h, 'home').content.length > 0, true)

  dispose()
  const after = await h.policy().resolvePage(OWNER, 'home')
  assert.equal(after.level, 'full', '判据随卸载消失 ⇒ 页面回到普通页面的形态')
})

/* ============================== 4. 版本同步与孤儿清理 ============================== */

test('版本戳不等 ⇒ 被改坏的正文刷回目录版；记账孤儿随同步删除；戳盖新', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.applyDocs()

  // 模拟"旧部署 + 上一版目录里有、这一版删掉的文档"
  h.adapter.run(`UPDATE pages SET content = ? WHERE slug = 'home'`, ['旧版本的正文'])
  h.adapter.run(`UPDATE builtin_docs_state SET value = '1' WHERE key = 'docs_version'`)
  await h.wiki().save('guide/legacy', { title: '旧目录里的文档', content: '历史版本存在过' })
  h.adapter.run(`INSERT INTO builtin_docs_state (key, value) VALUES ('page:guide/legacy', 'x')`)

  const dispose = (await BuiltinDocsPlugin.apply(h.ctx, {})) as () => void
  assert.equal(pageRow(h, 'home').content, BUILTIN_DOCS.find((d) => d.slug === 'home')!.content, '被改坏的正文应刷回目录版')
  assert.equal(await h.wiki().exists('guide/legacy'), false, '目录已删的记账页应被清理')
  assert.equal(stateValue(h, 'page:guide/legacy'), undefined, '记账行同步删除')
  assert.equal(stateValue(h, 'docs_version'), String(DOCS_VERSION))
  dispose()
})

/* ============================== 5. 快路径：戳相等 ⇒ 零写入 ============================== */

test('版本戳相等 ⇒ 零写入：连被手改的正文都不修复（同步是版本键控的，不是内容巡检）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const dispose1 = await h.applyDocs()
  h.adapter.run(`UPDATE pages SET content = '外部改动', updated_at = '2020-01-01T00:00:00.000Z' WHERE slug = 'home'`)
  const versionsBefore = h.adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions')[0]!.n
  dispose1()

  await h.applyDocs() // 同一 DOCS_VERSION ⇒ 快路径
  assert.equal(pageRow(h, 'home').content, '外部改动', '戳相等时一个字都不该写（改内容必须 bump DOCS_VERSION）')
  const versionsAfter = h.adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions')[0]!.n
  assert.equal(versionsAfter, versionsBefore, '快路径不得产生版本快照')
})

/* ============================== 6. 接管护栏 ============================== */

test('slug 撞名：用户先建了 home ⇒ 跳过且盖章（不每轮重试），用户页不受锁、不受隐藏', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  await h.wiki().save('home', { title: '团队首页', content: '用户自己的内容' })

  await h.applyDocs({ hidden: true })

  const row = pageRow(h, 'home')
  assert.equal(row.content, '用户自己的内容', '用户内容不可被接管改写')
  assert.equal(row.visibility, 'org', '用户页的档位不受内置文档影响')
  assert.equal(stateValue(h, 'page:home'), undefined, '未接管的 slug 不得记账')
  assert.equal(h.docs().isManagedPage('home'), false, '接管判据是记账行，不是目录清单')
  assert.equal(stateValue(h, 'docs_version'), String(DOCS_VERSION), 'skipped 也算已处理（同版本戳内不重试）')

  // 隐藏只罩记账页：用户的 home 照常可读、可编辑
  const access = await h.policy().resolvePage(MEMBER, 'home')
  assert.equal(access.level, 'full')
  assert.equal(access.canEdit, true)
  // 其余四篇正常隐藏
  assert.equal((await h.policy().resolvePage(MEMBER, 'guide/features')).level, 'none')
})

/* ============================== 7. 卸载只撤判据 ============================== */

test('卸载：判据撤除、页面不删——重装后按戳续同步', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const dispose = await h.applyDocs()
  dispose()

  assert.equal(ctxHas(h, 'builtin-docs-service'), false, '服务须注销（authz 现取会拿到 undefined ⇒ 无覆盖）')
  const access = await h.policy().resolvePage(MEMBER, 'guide/features')
  assert.equal(access.level, 'full', '页面仍在且可见')
  assert.equal(access.canEdit, true, '判据撤除后它是普通页面——**卸载内置文档插件**是唯一的逃生门，不是隐藏')

  await h.applyDocs() // 重装：戳相等 ⇒ 不重写正文，但记账页重新被锁上
  assert.equal((await h.policy().resolvePage(MEMBER, 'guide/features')).canEdit, false)
})

/* ============================== 8. tier 物化（检索命中层） ============================== */

test('hidden 翻动即时物化到 blocks.tier——检索只看这一列，读路径收紧而检索漏 = 泄漏级漂移', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const homeTiers = (): (number | null)[] =>
    h.adapter
      .query<{ tier: number | null }>(
        `SELECT tier FROM blocks WHERE page_id = (SELECT id FROM pages WHERE slug = 'home')`,
      )
      .map((r) => r.tier)

  const d1 = await h.applyDocs()
  await tick() // tier 重同步刻意排在 setImmediate（见 index.ts 的 provide 提交时序注释）
  assert.ok(homeTiers().length > 0, 'home 应有块')
  assert.ok(homeTiers().every((x) => x === 0), '常态：tier 0（匿名可检索——文档就是给所有人看的）')
  d1()

  // 配置热更新的真实形态 = 同库重新 activate（fork.update）。版本戳相等 ⇒ 正文零写，
  // 但激活尾部排队的 resyncTiers 必须把 hidden 刷进 tier——这正是本测试钉住的行为。
  const d2 = await h.applyDocs({ hidden: true })
  await tick()
  assert.ok(homeTiers().every((x) => x === null), '隐藏后：全部块 tier 为 NULL（检索命中层不可见）')
  d2()

  const d3 = await h.applyDocs()
  await tick()
  assert.ok(homeTiers().every((x) => x === 0), '切回可见：tier 刷回 0（重算幂等，无残留）')
  d3()
})

/** 等一个宏任务轮次：让 apply 里 setImmediate 排队的 tier 重同步真实落地 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/* ============================== 9. 卸载补刷 ============================== */

test('卸载后补刷 tier：判据撤除 ⇒ 页面变回普通页，tier 也必须回到 0（否则能读却搜不到）', async (t) => {
  const h = await makeHarness()
  t.after(() => h.dispose())
  const homeTiers = (): (number | null)[] =>
    h.adapter
      .query<{ tier: number | null }>(
        `SELECT tier FROM blocks WHERE page_id = (SELECT id FROM pages WHERE slug = 'home')`,
      )
      .map((r) => r.tier)

  const dispose = await h.applyDocs({ hidden: true })
  await tick()
  assert.ok(homeTiers().every((x) => x === null), '隐藏期间：tier 为 NULL')

  dispose()
  await tick()
  assert.ok(
    homeTiers().every((x) => x === 0),
    '卸载后：判据消失 ⇒ tier 必须被补刷回"无覆盖"的档位（否则页面能读、检索却搜不到）',
  )
})

function ctxHas(h: Harness, name: string): boolean {
  return h.ctx.get(name) !== undefined
}
