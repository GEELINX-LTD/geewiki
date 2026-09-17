/**
 * 导航批（2026-09-16）的**服务层**行为：
 *
 *   ① `setNavHidden` —— 幂等 upsert、**页面不存在时不写**（否则会留下悬挂状态行，
 *      同名页面日后被新建时会"继承"一条没人做过的隐藏设置）；
 *   ② `setNavOrder` —— 按父级整组重写位次、**item 可以是没有页面的分组路径**
 *      （`guide`/`demo` 这类目录必须能排序），以及三种拒绝（空列表、重复、跨层级）；
 *   ③ 隐藏与顺序都**落在库里**（重新 apply 后仍在，即"站点级"而不是进程内状态）。
 *
 * HTTP 面的准入（401/403/400、分组项不参与逐页权限判定）由真服务器验收覆盖：
 * `scripts/acceptance/...` 之外的那份 `data/verify/nav-tree/run.mjs` 直接打真端点，
 * 比夹具替身更能说明问题（夹具里没有真实会话与策略层数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import type { DatabaseAdapter, Principal, RunResult } from '@geewiki/core'
import { MIGRATION_TABLE } from '@geewiki/core'
import { AuthzPlugin } from '@geewiki/authz'
import { WikiPlugin, parentOf, type WikiService } from '../src/index.js'

const MEMBER: Principal = { kind: 'user', userId: 1, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }

const DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')
const WIKI_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

/*
 * 与既有夹具同款**同步**适配器（`DatabaseAdapter` 允许同步实现，管理器会用 `asAsync` 包一层）。
 * 第一版写成 `async`（返回 `Promise`）⇒ 类型与接口不兼容，9 个 `TS2416`——
 * 接口声明的是"值或 Promise"，而显式 `Promise<T>` 与它的泛型默认值对不上。
 */
class NodeSqliteAdapter implements DatabaseAdapter {
  readonly db: DatabaseSync

  constructor(filename: string, schemaSql: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec(schemaSql)
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const r = this.db.prepare(sql).run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint }
  }

  /**
   * 与真实适配器同契约：**收一个目录**，自己读里面的 .sql 并登记文件名。
   *
   * 夹具第一版把它写成"收 `{name, sql}[]`"，而插件传的是目录字符串 ⇒ `m.name` 是 undefined
   * ⇒ 绑参时抛 `Provided value cannot be bound to SQLite parameter 1`（报错点离原因很远）。
   */
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

  /** 接口要求（既有夹具同款）：关掉底层连接 */
  close(): void {
    this.db.close()
  }
}

function readMigrations(dir: string): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

/** 起一个最小实例：真迁移 + 真策略层 + 真 wiki 插件（与既有夹具同款，只是不需要路由） */
async function boot(): Promise<{ svc: WikiService; ctx: Context; dispose: () => void; db: NodeSqliteAdapter }> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-nav-'))
  const db = new NodeSqliteAdapter(join(dir, 'nav.db'), '')
  const provided = new Map<string, unknown>()
  const disposers: (() => void)[] = []
  const ctx = {
    get: (name: string) => (name === 'db' ? db : provided.get(name)),
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      const undo = (): void => {
        provided.delete(name)
      }
      disposers.push(undo)
      return undo
    },
    emit: () => undefined,
    plugin: async (plugin: { apply: (c: unknown, cfg: unknown) => unknown }) => {
      const d = await plugin.apply(ctx, {})
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  } as unknown as Context

  /*
   * 迁移必须先跑：真实实例里由管理器收集各插件的 migrations 目录后统一执行
   * （db-sqlite 的建表 + wiki 自己的 0001~0003）。夹具里少这一步的症状是
   * `@geewiki/authz: pages 缺少 P2 的可见性列`——报错点在策略层，离"夹具没跑迁移"很远。
   */
  // 建表迁移（db-sqlite 的那批）；wiki 自己的 0001~0003 由插件的 apply 负责跑
  await db.migrate(DB_MIGRATIONS_DIR)

  /*
   * 路由替身：@geewiki/wiki 的 apply 要求 `http` 服务存在（它要注册端点），
   * 但本文件只测服务层，不需要真的跑 HTTP —— 注册进来的处理器原样收下、不调用。
   */
  provided.set('http', { register: () => () => undefined })

  const authzDispose = (await AuthzPlugin.apply(ctx)) as unknown as (() => void) | undefined
  if (typeof authzDispose === 'function') disposers.push(authzDispose)
  const wikiDispose = (await WikiPlugin.apply(ctx, {})) as unknown as (() => void) | undefined
  if (typeof wikiDispose === 'function') disposers.push(wikiDispose)

  const svc = provided.get('wiki-service') as WikiService
  return {
    svc,
    ctx,
    db,
    dispose: () => {
      for (const d of disposers.reverse()) d()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 迁移文件由插件自己跑（`migrations` 在 manifest 里）；这里只把目录一起交给它 */
test('前置：迁移目录里有导航状态表', () => {
  const names = readMigrations(WIKI_MIGRATIONS_DIR).map((m) => m.name)
  assert.ok(
    names.includes('0003_page_nav_state.sql'),
    `wiki 迁移里应有导航状态表（当前：${names.join(', ')}）`,
  )
})

test('setNavHidden：写入 / 幂等 / 不改可见性；页面不存在时**不写**（返回 false）', async () => {
  const h = await boot()
  try {
    await h.svc.save('guides', { title: '指南', content: 'x' })
    await h.svc.save('guides/intro', { title: '入门', content: 'y' })

    assert.equal(await h.svc.setNavHidden('guides', true), true)
    // 幂等：重复写同一状态不报错，且状态不变
    assert.equal(await h.svc.setNavHidden('guides', true), true)

    const list = await h.svc.list(MEMBER)
    assert.equal(list.find((p) => p.slug === 'guides')?.nav_hidden, true, '隐藏状态随列表下发')
    assert.equal(list.find((p) => p.slug === 'guides/intro')?.nav_hidden, false, '子级**不**被级联写（继承是读时推导）')

    // 页面不存在：不写悬挂行（日后同 slug 新建不会"继承"一条没人做过的设置）
    assert.equal(await h.svc.setNavHidden('nope', true), false)
    const rows = await h.db.query<{ slug: string }>('SELECT slug FROM page_nav_state')
    assert.deepEqual(rows.map((r) => r.slug), ['guides'])

    // 隐藏**不影响可见性**：这一页照样能读（档位与发布状态都没动）
    assert.ok(await h.svc.get('guides', MEMBER), '隐藏后仍然可读')
  } finally {
    h.dispose()
  }
})

test('setNavOrder：按父级整组重写位次；item 可以是**没有页面的分组路径**', async () => {
  const h = await boot()
  try {
    await h.svc.save('a', { title: 'A', content: '' })
    await h.svc.save('b', { title: 'B', content: '' })
    await h.svc.save('guide/x', { title: 'X', content: '' })

    // `guide` 本身没有页面，但它必须能被排序（这正是"按父级存一整个列表"的理由）
    assert.equal(await h.svc.setNavOrder(null, ['guide', 'b', 'a']), 3)
    const rows = await h.db.query<{ parent: string; item: string; position: number }>(
      'SELECT parent, item, position FROM page_nav_order ORDER BY parent, position',
    )
    /*
     * 比字符串而不是对象：`node:sqlite` 返回的是 **null 原型对象**，
     * `assert.deepEqual` 会把它与对象字面量判为不等（差异只在原型上，读起来像"字段都一样却失败"）。
     */
    assert.deepEqual(
      rows.map((r) => `${r.parent}|${r.item}|${r.position}`),
      ['|guide|0', '|b|1', '|a|2'],
    )

    // 再写一次：**整组重写**而不是追加（否则会留下两条同位）
    await h.svc.setNavOrder(null, ['a', 'b'])
    const after = await h.db.query<{ item: string; position: number }>('SELECT item, position FROM page_nav_order ORDER BY position')
    assert.deepEqual(
      after.map((r) => `${r.item}|${r.position}`),
      ['a|0', 'b|1'],
    )

    // 层内排序互不影响：guide 这一层单独写
    assert.equal(await h.svc.setNavOrder('guide', ['guide/x']), 1)
    const guides = await h.db.query<{ item: string }>("SELECT item FROM page_nav_order WHERE parent = 'guide'")
    assert.deepEqual(guides.map((r) => r.item), ['guide/x'])
  } finally {
    h.dispose()
  }
})

test('setNavOrder：三种拒绝（空列表 / 重复 / 跨层级），且拒绝时**不改动**已有顺序', async () => {
  const h = await boot()
  try {
    await h.svc.save('a', { title: 'A', content: '' })
    await h.svc.save('a/b', { title: 'B', content: '' })
    await h.svc.save('c', { title: 'C', content: '' })
    await h.svc.setNavOrder(null, ['a', 'c'])

    await assert.rejects(async () => h.svc.setNavOrder(null, []), /nav_order_rejected: empty/)
    await assert.rejects(async () => h.svc.setNavOrder(null, ['a', 'a']), /nav_order_rejected: duplicate/)
    // `a/b` 的父级是 `a`，放进顶层就是"跨层级"——那是移动页面（改 slug），不是排序
    await assert.rejects(async () => h.svc.setNavOrder(null, ['a', 'a/b']), /nav_order_rejected: not_a_sibling/)

    const rows = await h.db.query<{ item: string }>('SELECT item FROM page_nav_order ORDER BY position')
    assert.deepEqual(rows.map((r) => r.item), ['a', 'c'], '被拒绝的请求不得留下半套顺序')
  } finally {
    h.dispose()
  }
})

test('parentOf：层级由 slug 决定（顶层为 null），排序的"同层"判据就是它', () => {
  assert.equal(parentOf('home'), null)
  assert.equal(parentOf('a'), null)
  assert.equal(parentOf('a/b'), 'a')
  assert.equal(parentOf('a/b/c'), 'a/b')
})

test('隐藏与顺序都落在库里：重开实例（重新 apply）后仍在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-nav2-'))
  const file = join(dir, 'nav.db')
  try {
    // 第一次：写状态
    const db1 = new NodeSqliteAdapter(file, '')
    const ctx1 = await bootWith(db1)
    await ctx1.svc.save('p', { title: 'P', content: '' })
    await ctx1.svc.setNavHidden('p', true)
    await ctx1.svc.setNavOrder(null, ['p'])
    ctx1.dispose()

    // 第二次：同一个库、重新 apply ⇒ 状态仍在（"站点级"的证据）
    const db2 = new NodeSqliteAdapter(file, '')
    const h2 = await bootWith(db2)
    try {
      const list = await h2.svc.list(MEMBER)
      assert.equal(list.find((x) => x.slug === 'p')?.nav_hidden, true)
      const rows = await h2.db.query<{ item: string; position: number }>('SELECT item, position FROM page_nav_order')
      assert.deepEqual(
        rows.map((r) => `${r.item}|${r.position}`),
        ['p|0'],
      )
    } finally {
      h2.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 与 `boot()` 同一套装配，但接受一个已存在的适配器（用于"重开实例"那条用例） */
async function bootWith(db: NodeSqliteAdapter): Promise<{ svc: WikiService; db: NodeSqliteAdapter; dispose: () => void }> {
  const provided = new Map<string, unknown>()
  const disposers: (() => void)[] = []
  const ctx = {
    get: (name: string) => (name === 'db' ? db : provided.get(name)),
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      const undo = (): void => {
        provided.delete(name)
      }
      disposers.push(undo)
      return undo
    },
    emit: () => undefined,
    plugin: async () => undefined,
  } as unknown as Context
  // 建表迁移（db-sqlite 的那批）；wiki 自己的 0001~0003 由插件的 apply 负责跑
  await db.migrate(DB_MIGRATIONS_DIR)

  /*
   * 路由替身：@geewiki/wiki 的 apply 要求 `http` 服务存在（它要注册端点），
   * 但本文件只测服务层，不需要真的跑 HTTP —— 注册进来的处理器原样收下、不调用。
   */
  provided.set('http', { register: () => () => undefined })
  const a = (await AuthzPlugin.apply(ctx)) as unknown as (() => void) | undefined
  if (typeof a === 'function') disposers.push(a)
  const w = (await WikiPlugin.apply(ctx, {})) as unknown as (() => void) | undefined
  if (typeof w === 'function') disposers.push(w)
  return {
    svc: provided.get('wiki-service') as WikiService,
    db,
    dispose: () => {
      for (const d of disposers.reverse()) d()
    },
  }
}
