/**
 * 站点主页（2026-09-18，主页批）的**服务层**行为：
 *
 *   ① `setHomeSlug` / `homeSlug` —— 单行表的读写：设置、换一篇（覆盖，不是追加）、
 *      清除（`null` ⇒ 删行 ⇒ 回读为 `null`）；
 *   ② 拒绝与不留痕 —— 页面不存在时返回 `false` **且不写行**（悬挂设置会让日后同 slug
 *      新建的页面"继承"一条没人做过的设置）；slug 形状非法时抛 `invalid_slug`；
 *   ③ 删除页面时**同事务**清掉指向它的主页设置，而删除别的页面、或删除失败（页面不存在）
 *      都不许动这条设置；
 *   ④ 落在库里：重开实例（重新 apply）后设置仍在 —— 它是"站点级"，不是进程内状态。
 *
 * HTTP 面的准入（`GET` 公开、`POST` 只要站点管理员、三态各自长什么样）由真服务器验收
 * 覆盖：夹具里没有真实会话、也没有策略层的可见性数据，用它断言"谁能设"只会测出替身的行为。
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
import { WikiPlugin, type WikiService } from '../src/index.js'

const MEMBER: Principal = { kind: 'user', userId: 1, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }

const DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db-sqlite', 'src', 'migrations')
const WIKI_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

const SITE_HOME_MIGRATION = '0004_site_home.sql'

/** 与 nav.test.ts 同款**同步**适配器（接口允许同步实现，管理器会用 `asAsync` 包一层） */
class NodeSqliteAdapter implements DatabaseAdapter {
  readonly db: DatabaseSync

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
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

  /** 与真实适配器同契约：收一个目录，自己读里面的 .sql 并登记文件名 */
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
        this.db.prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`).run(name, new Date().toISOString())
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

interface Booted {
  svc: WikiService
  db: NodeSqliteAdapter
  dispose: () => void
}

/** 与 nav.test.ts 同款最小实例：真迁移 + 真策略层 + 真 wiki 插件（路由替身原样收下处理器） */
async function bootWith(db: NodeSqliteAdapter): Promise<Booted> {
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

  // 建表迁移（db-sqlite 的那批）；wiki 自己的 0001~0004 由插件的 apply 负责跑
  await db.migrate(DB_MIGRATIONS_DIR)
  provided.set('http', { register: () => () => undefined })

  const authzDispose = (await AuthzPlugin.apply(ctx)) as unknown as (() => void) | undefined
  if (typeof authzDispose === 'function') disposers.push(authzDispose)
  const wikiDispose = (await WikiPlugin.apply(ctx, {})) as unknown as (() => void) | undefined
  if (typeof wikiDispose === 'function') disposers.push(wikiDispose)

  return {
    svc: provided.get('wiki-service') as WikiService,
    db,
    dispose: () => {
      for (const d of disposers.reverse()) d()
    },
  }
}

async function boot(): Promise<Booted & { dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-home-'))
  const db = new NodeSqliteAdapter(join(dir, 'home.db'))
  const h = await bootWith(db)
  return {
    ...h,
    dir,
    dispose: () => {
      h.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('前置：迁移目录里有站点主页表（方言中立，不依赖 pages 的列）', () => {
  const names = readdirSync(WIKI_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  assert.ok(names.includes(SITE_HOME_MIGRATION), `wiki 迁移里应有站点主页表（当前：${names.join(', ')}）`)
})

test('homeSlug/setHomeSlug：默认未设置 ⇒ null；设置、换一篇、清除都要落库且只有一行', async () => {
  const h = await boot()
  try {
    await h.svc.save('home', { title: '主页', content: 'x' })
    await h.svc.save('guide/intro', { title: '入门', content: 'y' })

    // 未设置：回 null（**不是空串**——空串会让路由层去读一个 slug 为空的页面）
    assert.equal(await h.svc.homeSlug(), null)

    assert.equal(await h.svc.setHomeSlug('guide/intro'), true)
    assert.equal(await h.svc.homeSlug(), 'guide/intro')
    // 幂等：重复写同一值不报错
    assert.equal(await h.svc.setHomeSlug('guide/intro'), true)

    // 换一篇 = **覆盖**那一行，不是追加（单行表的意义）
    assert.equal(await h.svc.setHomeSlug('home'), true)
    assert.equal(await h.svc.homeSlug(), 'home')
    const rows = await h.db.query<{ id: number; slug: string }>('SELECT id, slug FROM site_home')
    assert.equal(rows.length, 1, '单行表：换一篇不得留下第二行')
    assert.equal(rows[0]?.id, 1)

    // 清除：删行 ⇒ 回读 null（回落约定 slug 由调用方决定，本服务不猜）
    assert.equal(await h.svc.setHomeSlug(null), true)
    assert.equal(await h.svc.homeSlug(), null)
    const after = await h.db.query<{ id: number }>('SELECT id FROM site_home')
    assert.equal(after.length, 0, '清除必须是删行，而不是写空串/写 null')
  } finally {
    h.dispose()
  }
})

test('setHomeSlug：页面不存在 ⇒ false 且**不写行**；slug 形状非法 ⇒ 抛 invalid_slug', async () => {
  const h = await boot()
  try {
    await h.svc.save('home', { title: '主页', content: '' })

    assert.equal(await h.svc.setHomeSlug('nope'), false, '不存在的页面不能成为主页')
    assert.equal(await h.svc.homeSlug(), null, '被拒绝的写法不得留下悬挂设置')

    await assert.rejects(async () => h.svc.setHomeSlug('a//b'), /invalid_slug/)
    await assert.rejects(async () => h.svc.setHomeSlug('search'), /invalid_slug/)
    assert.equal(await h.svc.homeSlug(), null)
  } finally {
    h.dispose()
  }
})

test('删除页面：删的正是主页 ⇒ 同事务清掉设置；删别的、删不存在的都不许动它', async () => {
  const h = await boot()
  try {
    await h.svc.save('home', { title: '主页', content: '' })
    await h.svc.save('other', { title: '别的', content: '' })

    await h.svc.setHomeSlug('home')
    // 删一个不存在的 slug（remove 返回 false）**不得**误清设置
    assert.equal(await h.svc.remove('nope'), false)
    assert.equal(await h.svc.homeSlug(), 'home', '删除失败时设置必须原样还在')

    // 删一个不是主页的页面：设置不动
    assert.equal(await h.svc.remove('other'), true)
    assert.equal(await h.svc.homeSlug(), 'home')

    // 删的正是主页：设置被清掉（否则就是指向不存在 slug 的悬挂设置）
    assert.equal(await h.svc.remove('home'), true)
    assert.equal(await h.svc.homeSlug(), null)
    const rows = await h.db.query<{ id: number }>('SELECT id FROM site_home')
    assert.equal(rows.length, 0)
  } finally {
    h.dispose()
  }
})

test('主页设置落在库里：重开实例（重新 apply）后仍在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-home2-'))
  const file = join(dir, 'home.db')
  try {
    const db1 = new NodeSqliteAdapter(file)
    const h1 = await bootWith(db1)
    await h1.svc.save('guide/intro', { title: '入门', content: '' })
    await h1.svc.setHomeSlug('guide/intro')
    h1.dispose()

    // 第二次：同一个库、重新 apply ⇒ 设置仍在（"站点级"而不是进程内状态）
    const db2 = new NodeSqliteAdapter(file)
    const h2 = await bootWith(db2)
    try {
      assert.equal(await h2.svc.homeSlug(), 'guide/intro')
    } finally {
      h2.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('主页设置与导航状态互不干扰：设主页不改 hidden/order，反之亦然', async () => {
  const h = await boot()
  try {
    await h.svc.save('home', { title: '主页', content: '' })
    await h.svc.setNavHidden('home', true)
    await h.svc.setNavOrder(null, ['home'])

    await h.svc.setHomeSlug('home')
    const list = await h.svc.list(MEMBER)
    assert.equal(list.find((p) => p.slug === 'home')?.nav_hidden, true, '设主页不得顺手取消隐藏')

    // 反向：清掉主页设置不得动顺序
    await h.svc.setHomeSlug(null)
    const rows = await h.db.query<{ item: string }>('SELECT item FROM page_nav_order')
    assert.deepEqual(rows.map((r) => r.item), ['home'])
  } finally {
    h.dispose()
  }
})
