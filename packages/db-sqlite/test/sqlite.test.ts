/**
 * @geewiki/db-sqlite —— 默认数据库后端的单测。
 *
 * ## 为什么这个文件此前不存在，以及为什么它必须有
 * `db-sqlite` 是**默认后端**（`config/plugins.base.json` 里人人都在用），
 * 却曾是唯一**没有 `test` 脚本**的运行时关键包；而**延期**的 `db-postgres`
 * 反而有 400 行测试。这是覆盖分布与风险分布刚好相反的一种状态：
 * 出问题时影响面最大的那个组件，是没人替它检查的那个。
 *
 * ## 本文件钉住的四类不变量
 * 1. **迁移是真跑了的**：`appliedMigrations()` 的条数等于随包分发的 `.sql` 文件数
 *    （动态比对，故新增迁移文件不会让这条断言失效，会让它**有意义**）；
 * 2. **迁移登记与迁移本身同事务**：失败的迁移既不留表、也不留登记行——
 *    否则下一次启动会跳过它，得到一个**永远缺一张表**的库（最难查的一类故障）；
 * 3. **未 open / 已 close 的调用必须是明确报错**，不是静默返回空结果
 *    （静默的空结果会被上层当成"这张表是空的"，从而走进完全错误的业务分支）；
 * 4. **插件 `apply()` 失败时不得留下半注册的 `db` 服务**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { MIGRATION_TABLE } from '@geewiki/core'
import { DB_SQLITE_MIGRATIONS_DIR, SqliteDatabase, SqliteDbPlugin } from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

interface Env {
  dir: string
  file: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-sqlite-'))
  return {
    dir,
    file: join(dir, 'geewiki.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 随包分发的迁移脚本（测试用它作基准，而不是写死一份会过期的名单） */
const bundledMigrations = (): string[] =>
  readdirSync(DB_SQLITE_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

const withDb = <T>(env: Env, fn: (db: SqliteDatabase) => T): T => {
  const db = new SqliteDatabase(env.file)
  try {
    db.open()
    return fn(db)
  } finally {
    db.close()
  }
}

/* ------------------------------ 打开与迁移 ------------------------------ */

test('★ 优化点 7：open() 应用全部随包迁移，并开启 WAL 与外键约束', () => {
  const env = makeEnv()
  try {
    withDb(env, (db) => {
      const expected = bundledMigrations()
      assert.ok(expected.length > 0, '随包迁移不应为空')
      assert.deepEqual(db.appliedMigrations(), expected)

      // WAL：并发读 + 单写的基本前提；外键：块级授权/版本引用的完整性依赖它
      assert.equal(db.query<{ journal_mode: string }>('PRAGMA journal_mode')[0]?.journal_mode, 'wal')
      assert.equal(db.query<{ foreign_keys: number }>('PRAGMA foreign_keys')[0]?.foreign_keys, 1)

      // 业务表真的建出来了（不是只写了登记行）
      const tables = db.listTables()
      assert.ok(tables.includes('pages'), `应有 pages 表，实测: ${tables.join(', ')}`)
      assert.ok(tables.includes(MIGRATION_TABLE), '迁移登记表本身应是用户表')
    })
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 7：迁移幂等——重复 open()/migrate() 不重复应用、不报错', () => {
  const env = makeEnv()
  try {
    const first = withDb(env, (db) => db.appliedMigrations())
    // 第二次打开同一个文件：登记表已在，全部跳过
    const second = withDb(env, (db) => {
      db.migrate() // 显式再来一次
      return db.appliedMigrations()
    })
    assert.deepEqual(second, first)
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 7：失败的迁移【不留表也不留登记行】—— 否则永远缺一张表', () => {
  const env = makeEnv()
  const migDir = join(env.dir, 'external-migrations')
  mkdirSync(migDir)
  try {
    writeFileSync(join(migDir, '9001_ok.sql'), 'CREATE TABLE ext_ok (id INTEGER PRIMARY KEY);\n', 'utf8')
    writeFileSync(
      join(migDir, '9002_bad.sql'),
      'CREATE TABLE ext_bad (id INTEGER);\nINSERT INTO no_such_table VALUES (1);\n',
      'utf8',
    )

    withDb(env, (db) => {
      assert.throws(() => db.migrate(migDir), /no_such_table/)

      const applied = db.appliedMigrations()
      // 失败的那一条**没有**被登记：内存里那段 SQL 已被事务回滚
      assert.ok(!applied.includes('9002_bad.sql'), `失败的迁移不得登记: ${applied.join(', ')}`)
      // 它的建表语句同样被回滚（关键：不能留下"有表但没登记"或"登记了但没表"）
      assert.ok(!db.listTables().includes('ext_bad'), '失败迁移的建表语句必须一并回滚')
      // 它之前的成功迁移**保留**（迁移是增量叠加，失败不该回退已有的）
      assert.ok(applied.includes('9001_ok.sql'), '失败前的迁移应保留')
      assert.ok(db.listTables().includes('ext_ok'))

      // 修好之后可以继续推进（失败不是"卡死"，重跑即可）
      writeFileSync(
        join(migDir, '9002_bad.sql'),
        'CREATE TABLE ext_bad (id INTEGER);\n',
        'utf8',
      )
      db.migrate(migDir)
      assert.ok(db.appliedMigrations().includes('9002_bad.sql'))
      assert.ok(db.listTables().includes('ext_bad'))
    })
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 未就绪语义 ------------------------------ */

test('★ 优化点 7：未 open() / 已 close() 一律明确报错，绝不静默返回空结果', () => {
  const env = makeEnv()
  try {
    const db = new SqliteDatabase(env.file)
    // 未 open：任何需要连接的操作都必须抛错（静默空数组会被上层当成"表是空的"）
    assert.throws(() => db.query('SELECT 1'), /尚未打开/)
    assert.throws(() => db.run('SELECT 1'), /尚未打开/)
    assert.throws(() => db.transaction(() => 1), /尚未打开/)
    assert.throws(() => db.migrate(), /尚未打开/)
    // 但"清单类"查询是**可安全降级**的：返回空数组（供健康检查在未就绪时调用）
    assert.deepEqual(db.appliedMigrations(), [])
    assert.deepEqual(db.listTables(), [])

    db.open()
    assert.equal(db.query<{ '1': number }>('SELECT 1 AS "1"')[0]?.['1'], 1)
    db.close()
    assert.throws(() => db.query('SELECT 1'), /尚未打开/)
    assert.deepEqual(db.appliedMigrations(), [], 'close() 后清单降级为空而不是抛错')
    // close() 幂等
    db.close()
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 查询与事务 ------------------------------ */

test('★ 优化点 7：query/run 参数绑定与 RunResult 语义', () => {
  const env = makeEnv()
  try {
    withDb(env, (db) => {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      const inserted = db.run('INSERT INTO t (name) VALUES (?)', ['甲'])
      assert.equal(inserted.changes, 1)
      assert.ok(inserted.lastInsertRowid > 0)

      db.run('INSERT INTO t (name) VALUES (?)', ['乙'])
      assert.deepEqual(db.query<{ name: string }>('SELECT name FROM t ORDER BY id').map((r) => r.name), ['甲', '乙'])
      // 无匹配行时 changes 为 0（而不是抛错）
      assert.equal(db.run('UPDATE t SET name = ? WHERE id = ?', ['丙', 999]).changes, 0)
    })
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 7：transaction() 抛错时整体回滚', () => {
  const env = makeEnv()
  try {
    withDb(env, (db) => {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      assert.throws(
        () =>
          db.transaction(() => {
            db.run('INSERT INTO t (name) VALUES (?)', ['要回滚的'])
            throw new Error('故意失败')
          }),
        /故意失败/,
      )
      assert.equal(db.query('SELECT * FROM t').length, 0, '事务内的写入必须整体回滚')

      // 正常路径返回回调的返回值
      const out = db.transaction(() => {
        db.run('INSERT INTO t (name) VALUES (?)', ['留下的'])
        return 'ok'
      })
      assert.equal(out, 'ok')
      assert.equal(db.query('SELECT * FROM t').length, 1)
    })
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 7：listTables() 排除 sqlite 内部表', () => {
  const env = makeEnv()
  try {
    withDb(env, (db) => {
      const tables = db.listTables()
      assert.ok(tables.length > 0)
      assert.ok(
        tables.every((t) => !t.startsWith('sqlite_')),
        `不应出现 sqlite_* 内部表: ${tables.filter((t) => t.startsWith('sqlite_')).join(', ')}`,
      )
    })
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 插件本体 ------------------------------ */

test('★ 优化点 7：插件 apply() 提供 db 服务，disposer 同时注销服务并关闭连接', async () => {
  const env = makeEnv()
  try {
    const ctx = new Context()
    const fiber = await ctx.plugin(SqliteDbPlugin as never, { filename: env.file })
    const adapter = ctx.get('db') as SqliteDatabase
    assert.ok(adapter, 'apply 之后 ctx.db 应可用')
    assert.equal(adapter.dialect, 'sqlite')
    assert.ok(adapter.listTables().includes('pages'))

    await fiber.dispose()
    // 服务已注销 + 连接已关闭：两者缺一都会留下"看似可用、一用就炸"的句柄
    assert.equal(ctx.get('db'), undefined, '卸载后 db 服务必须注销')
    assert.throws(() => adapter.query('SELECT 1'), /尚未打开/)
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 7：apply() 打开失败时不留下半注册的 db 服务', async () => {
  const env = makeEnv()
  try {
    // 用一个**文件**挡住目录位置 ⇒ mkdirSync 必然失败
    writeFileSync(join(env.dir, 'blocker'), 'not a directory\n', 'utf8')
    const ctx = new Context()
    // 注意：`ctx.plugin()` **同步**返回 Fiber（thenable），apply 的异常要 await 才浮出来
    await assert.rejects(async () => {
      await ctx.plugin(SqliteDbPlugin as never, { filename: join(env.dir, 'blocker', 'x.db') })
    })
    // 关键不变量：激活失败必须**干净**——否则管理器回滚后，其它插件仍会拿到一个坏掉的 db
    assert.equal(ctx.get('db'), undefined, 'apply 失败不得留下 db 服务')
  } finally {
    env.cleanup()
  }
})
