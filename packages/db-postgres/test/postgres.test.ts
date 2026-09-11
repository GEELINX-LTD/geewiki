/**
 * `@geewiki/postgres` 单元测试。
 *
 * 策略：**连接池用替身注入**（`PostgresDatabase` 的第三个构造参数），因此这些用例
 * 不需要真实数据库就能验证"适配器怎么用驱动"——占位符转换、参数是否真的作为参数传递、
 * 事务是否走同一条连接、空闲连接错误是否被监听。
 * 真实数据库的行为由 E2E（真 PG 容器）覆盖，两者互补。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAsyncAdapter } from '@geewiki/core'
import {
  PostgresDatabase,
  assertEnvNameLooksLikeName,
  resolveConnection,
  type ClientLike,
  type PoolLike,
  type PostgresConfig,
  type QueryResultLike,
} from '../src/index.js'

/* ------------------------------ 替身 ------------------------------ */

interface Recorder {
  /** 所有经过连接池/连接发出的语句（按顺序） */
  sql: string[]
  /** 每条语句携带的参数 */
  params: unknown[][]
  /** pool.connect() 被调用了几次（事务"用同一连接"的判据） */
  connects: number
}

function fakePool(opts: { rows?: Record<string, unknown>[]; rowCount?: number | null; failOn?: RegExp } = {}): {
  pool: PoolLike
  rec: Recorder
  emitError: (err: Error) => void
  errorListeners: number
} {
  const rec: Recorder = { sql: [], params: [], connects: 0 }
  const listeners: ((err: Error) => void)[] = []
  const result = (): Promise<QueryResultLike> =>
    Promise.resolve({ rows: opts.rows ?? [], rowCount: opts.rowCount ?? 0 })

  const client: ClientLike = {
    query(sql, params) {
      rec.sql.push(sql)
      rec.params.push(params ?? [])
      if (opts.failOn?.test(sql)) return Promise.reject(new Error(`模拟失败: ${sql}`))
      return result()
    },
    release() {
      /* noop */
    },
  }

  const pool: PoolLike = {
    query(sql, params) {
      rec.sql.push(sql)
      rec.params.push(params ?? [])
      if (opts.failOn?.test(sql)) return Promise.reject(new Error(`模拟失败: ${sql}`))
      return result()
    },
    connect() {
      rec.connects++
      return Promise.resolve(client)
    },
    end: () => Promise.resolve(),
    on(event, listener) {
      if (event === 'error') listeners.push(listener)
      return pool
    },
  }
  return {
    pool,
    rec,
    emitError: (err) => listeners.forEach((l) => l(err)),
    get errorListeners() {
      return listeners.length
    },
  }
}

const CONN = {
  host: 'h',
  port: 5432,
  database: 'd',
  user: 'u',
  password: 'p',
  max: 5,
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 1000,
  ssl: false,
}

/* ------------------------------ 契约判定 ------------------------------ */

test('PostgresDatabase 实现 DatabaseAdapterAsync：structural 判定为真且方言正确', () => {
  const { pool } = fakePool()
  const db = new PostgresDatabase(CONN, true, () => pool)
  assert.equal(db.kind, 'async')
  assert.equal(db.dialect, 'postgres')
  assert.equal(isAsyncAdapter(db), true, 'isAsyncAdapter 必须结构化判定为真（不用 instanceof）')
  // 反向：同步形态的适配器不得被判为异步
  assert.equal(isAsyncAdapter({ dialect: 'sqlite', query: () => [], run: () => ({}) }), false)
  assert.equal(isAsyncAdapter(null), false)
  assert.equal(isAsyncAdapter(undefined), false)
})

/* ------------------------------ 参数化查询 ------------------------------ */

test('query：`?` 占位符按出现顺序转成 `$1..$n`（不改动参数个数）', async () => {
  const { pool, rec } = fakePool({ rows: [{ a: 1 }] })
  const db = new PostgresDatabase(CONN, true, () => pool)
  const rows = await db.query('SELECT * FROM t WHERE a = ? AND b = ? AND a <> ?', ['x', 2, 'y'])
  assert.deepEqual(rows, [{ a: 1 }])
  assert.equal(rec.sql[0], 'SELECT * FROM t WHERE a = $1 AND b = $2 AND a <> $3')
  assert.deepEqual(rec.params[0], ['x', 2, 'y'], '参数必须作为独立参数传递')
})

test('query：注入式取值作为**参数**而非拼接（含引号/分号/注释符）', async () => {
  const { pool, rec } = fakePool()
  const db = new PostgresDatabase(CONN, true, () => pool)
  const evil = "' OR 1=1; DROP TABLE pages; --"
  await db.query('SELECT * FROM pages WHERE slug = ?', [evil])
  const [, params] = [rec.sql[0], rec.params[0] ?? []]
  assert.deepEqual(params, [evil], '恶意值必须原样作为参数，绝不能进入 SQL 文本')
  assert.ok(!rec.sql[0]?.includes('OR 1=1'), `SQL 文本不得包含用户值: ${String(rec.sql[0])}`)
  assert.ok(!rec.sql[0]?.includes('DROP'), `SQL 文本不得包含用户值: ${String(rec.sql[0])}`)
})

test('run：返回 changes 与 RETURNING id 推出的 lastInsertRowid', async () => {
  const { pool } = fakePool({ rows: [{ id: 42 }], rowCount: 1 })
  const db = new PostgresDatabase(CONN, true, () => pool)
  const res = await db.run('INSERT INTO t(a) VALUES (?) RETURNING id', ['v'])
  assert.equal(res.changes, 1)
  assert.equal(res.lastInsertRowid, 42)
})

test('run：无 RETURNING 时 lastInsertRowid 退回 0（PG 无隐式 last id）', async () => {
  const { pool } = fakePool({ rows: [], rowCount: 3 })
  const db = new PostgresDatabase(CONN, true, () => pool)
  const res = await db.run('UPDATE t SET a = ?', [1])
  assert.equal(res.changes, 3)
  assert.equal(res.lastInsertRowid, 0)
})

/* ------------------------------ 事务 ------------------------------ */

test('transaction：**从池里取一条连接**并在其上执行 BEGIN/COMMIT（池分派会让事务失效）', async () => {
  const { pool, rec } = fakePool()
  const db = new PostgresDatabase(CONN, true, () => pool)
  const out = await db.transaction(async (tx) => {
    // **必须用 tx**：用 db.query 会被池分派到另一条连接，事务就白开了
    await tx.query('SELECT 1')
    await tx.run('UPDATE t SET a = ? WHERE id = ?', [1, 2])
    return 'done'
  })
  assert.equal(out, 'done')
  assert.equal(rec.connects, 1, '事务必须取一条专用连接')
  assert.deepEqual(
    rec.sql,
    ['BEGIN', 'SELECT 1', 'UPDATE t SET a = $1 WHERE id = $2', 'COMMIT'],
    '事务内所有语句必须在同一条连接上、且位于 BEGIN/COMMIT 之间',
  )
})

test('transaction：回调抛错 → ROLLBACK 且原始错误向上传播', async () => {
  const { pool, rec } = fakePool()
  const db = new PostgresDatabase(CONN, true, () => pool)
  await assert.rejects(
    () =>
      db.transaction(async () => {
        throw new Error('业务失败')
      }),
    /业务失败/,
  )
  assert.deepEqual(rec.sql, ['BEGIN', 'ROLLBACK'])
})

test('transaction：回滚本身失败时**不得掩盖原始错误**', async () => {
  const { pool, rec } = fakePool({ failOn: /^ROLLBACK$/ })
  const db = new PostgresDatabase(CONN, true, () => pool)
  await assert.rejects(
    () =>
      db.transaction(async () => {
        throw new Error('原始错误')
      }),
    /原始错误/,
    '回滚失败也必须抛出原始错误',
  )
  assert.ok(rec.sql.includes('ROLLBACK'))
})

/* ------------------------------ 连接池生命周期 ------------------------------ */

test('空闲连接错误被监听（不监听 = Node 未捕获异常打挂进程）', () => {
  const fake = fakePool()
  const db = new PostgresDatabase(CONN, true, () => fake.pool)
  // 触发惰性建池
  void db.query('SELECT 1')
  assert.equal(fake.errorListeners, 1, "必须注册恰好一个 'error' 监听")
  // 触发监听器：只应记日志，不得抛出
  assert.doesNotThrow(() => fake.emitError(new Error('连接被服务端断开')))
})

test('close：释放连接池且可重复调用（幂等）', async () => {
  let ended = 0
  const fake = fakePool()
  const pooled = { ...fake.pool, end: () => { ended++; return Promise.resolve() } }
  const db = new PostgresDatabase(CONN, true, () => pooled)
  await db.query('SELECT 1')
  await db.close()
  await db.close()
  assert.equal(ended, 1, '重复 close 不应重复释放')
})

test('appliedMigrations：迁移表尚未建立（42P01）时视为空清单，而不是炸掉健康检查', async () => {
  const { pool } = fakePool()
  const boom = {
    ...pool,
    query: () => {
      const err = new Error('relation "_migrations" does not exist') as Error & { code?: string }
      err.code = '42P01'
      return Promise.reject(err)
    },
  }
  const db = new PostgresDatabase(CONN, true, () => boom)
  assert.deepEqual(await db.appliedMigrations(), [])
})

/* ------------------------------ 配置与密钥纪律 ------------------------------ */

test('resolveConnection：密码取自 passwordEnv 指向的环境变量', () => {
  const cfg: PostgresConfig = { host: 'db', port: 5433, database: 'g', user: 'u', passwordEnv: 'GEEWIKI_DB_PASSWORD' }
  const conn = resolveConnection(cfg, { GEEWIKI_DB_PASSWORD: '来自环境变量' } as NodeJS.ProcessEnv)
  assert.equal(conn.password, '来自环境变量')
  assert.equal(conn.host, 'db')
  assert.equal(conn.port, 5433)
})

test('resolveConnection：环境变量缺失 → 空串（**没有**明文回退路径）', () => {
  // 配置里已不存在明文 password 字段（见 secret-discipline 守卫），故此处只能得到空串。
  // 这条断言的意义：若将来有人把明文字段加回来并接上回退分支，它会立刻变红。
  const conn = resolveConnection({ passwordEnv: 'MISSING_VAR' }, {} as NodeJS.ProcessEnv)
  assert.equal(conn.password, '', '缺环境变量就是无密码，不得从配置里取明文')
})

test('密钥纪律：passwordEnv 只接受**环境变量名**，填密码值本身必须被拒绝', () => {
  // 这三类正是 @geewiki/llm 那次漏判的形态（32 位 hex / 全大写无下划线 / 短随机）
  for (const bad of ['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'ABCDEF1234567890', 'Xk9mQpL7vR4']) {
    assert.throws(
      () => assertEnvNameLooksLikeName('passwordEnv', bad),
      /必须是\*\*环境变量名\*\*/,
      `应拒绝疑似密码值: ${bad}`,
    )
  }
  // 合法形态与环境变量名的既有约定一致（全大写 + 下划线）
  assert.doesNotThrow(() => assertEnvNameLooksLikeName('passwordEnv', 'GEEWIKI_DB_PASSWORD'))
  assert.doesNotThrow(() => assertEnvNameLooksLikeName('passwordEnv', ''), '空 = 未配置，放行')
})

test('resolveConnection：把密码值填进 passwordEnv 时**拒绝**（配置会落盘进入库文件）', () => {
  assert.throws(
    () => resolveConnection({ passwordEnv: 'deadbeefdeadbeefdeadbeefdeadbeef' }, {} as NodeJS.ProcessEnv),
    /环境变量名/,
  )
})
