/**
 * `@geewiki/postgres` —— PostgreSQL 数据库插件（异步适配器）。
 *
 * 设计要点（与 `@geewiki/db-sqlite` 对照阅读）：
 * 1. **实现 `DatabaseAdapterAsync`（全 Promise）**，而不是同步的 `DatabaseAdapter`：
 *    `pg` 是异步驱动，把异步硬掰成同步只会在运行时炸。消费方用 core 的 `asAsync()`
 *    归一到同一条代码路径（见 packages/server 的 health 与 packages/manager 的迁移控制器）。
 * 2. **同属 `conflictGroup: 'database-provider'`** ⇒ 与 SQLite 天然互斥，无需新增机制。
 * 3. **不热插拔**（`supportsHotReload: false`，与 SQLite 一致）：切换数据库是冷操作，
 *    运行中换掉连接池会让在途查询失去归宿。
 * 4. **密钥纪律**：密码**不写进配置文件**。本适配器只接受 `connectionStringEnv` 与
 *    `passwordEnv`——两者都是环境变量**名**（不是值），**不提供任何明文字段**。
 *
 *    为什么连"仅本地开发"的明文字段都不给：`config/plugins.*.json` 是**被 git 跟踪**的
 *    文件，而 `PUT /api/plugins/:name/config` + `POST /api/session/persist` 会把配置原样
 *    落盘。任何**能被填进表单的密钥字段**，都等于给"把密钥提交进版本库"开了一个入口——
 *    这与 `@geewiki/llm` / `@geewiki/openai` 的 `apiKeyEnv` 纪律（只接受变量名）直接冲突。
 *    "文档里写一句警告"不足以阻止落盘，故在**契约层**去掉该字段。
 *
 *    两道闸门（与 openai 同款，见 `packages/plugin-openai/src/index.ts:68`）：
 *    - schema 的 `.pattern()` 覆盖**配置读写路径**（非法值在 PUT 时即被拒，**不会落盘**）；
 *    - {@link assertEnvNameLooksLikeName} 覆盖**以代码直接构造 config 调 `ctx.plugin()`**
 *      的路径（测试、程序化装配）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { Pool } from 'pg'
import {
  MIGRATION_TABLE,
  type DatabaseAdapterAsync,
  type DatabaseExecutor,
  type GeeWikiManifest,
  type RunResult,
} from '@geewiki/core'

/* ============================== 配置 ============================== */

/**
 * 环境变量名白名单：全大写 + **必须含至少一个下划线**。
 *
 * 「必须含下划线」不是洁癖，而是把"32 位 hex / 全大写随机串"这类**密码形态**挡在外面——
 * `@geewiki/llm` 早先的黑名单方案正是漏在这三种形态上（见该包的 apiKeyEnv 教训）。
 */
const ENV_VAR_NAME_RE = /^(?=[A-Z0-9_]*_)[A-Z_][A-Z0-9_]{0,127}$/

/**
 * 环境变量名**字段**白名单：与 {@link ENV_VAR_NAME_RE} 的唯一区别是**允许空串**（= 未配置）。
 *
 * 为什么单独一条：schema 的 `.pattern()` 必须能接受默认值 `''`，否则空配置本身就校验失败。
 * 语义上与 `@geewiki/llm` 的 `ENV_VAR_NAME_FIELD_RE`（`/^$|^(?=[A-Z0-9_]*_)[A-Z_][A-Z0-9_]{0,127}$/`）
 * **逐字等价**；本包刻意不 import 它——让**数据库**插件依赖 **LLM** 插件是错误的耦合方向。
 * 两处的等价性由 `test/secret-discipline.test.ts` 的**源码级对齐守卫**钉住（照
 * `packages/plugin-ai/test/queryLengthGuard.test.ts` 处理同类"跨包同义常量"的先例）。
 */
const EMPTY_OR_ENV_VAR_NAME_RE = /^$|^(?=[A-Z0-9_]*_)[A-Z_][A-Z0-9_]{0,127}$/

export const PostgresConfigSchema = Schema.object({
  connectionStringEnv: Schema.string()
    .default('')
    .pattern(EMPTY_OR_ENV_VAR_NAME_RE)
    .description('存放连接串的环境变量名（推荐；留空则用下面的分项配置）。例如 GEEWIKI_DATABASE_URL'),
  host: Schema.string().default('127.0.0.1').description('数据库主机'),
  port: Schema.number().default(5432).min(1).max(65535).description('端口'),
  database: Schema.string().default('geewiki').description('库名'),
  user: Schema.string().default('geewiki').description('用户名'),
  passwordEnv: Schema.string()
    .default('')
    .pattern(EMPTY_OR_ENV_VAR_NAME_RE)
    .description('存放密码的环境变量名（留空表示无密码）。例如 GEEWIKI_DB_PASSWORD'),
  max: Schema.number().default(10).min(1).max(100).description('连接池上限'),
  connectionTimeoutMillis: Schema.number().default(10_000).min(0).description('建立连接超时（毫秒）'),
  idleTimeoutMillis: Schema.number().default(30_000).min(0).description('空闲连接回收（毫秒）'),
  ssl: Schema.boolean().default(false).description('是否使用 SSL'),
})

/** 配置类型：由 schema 形状手工推出（schemastery 的默认导出没有 `Type` 命名空间） */
export interface PostgresConfig {
  connectionStringEnv?: string
  host?: string
  port?: number
  database?: string
  user?: string
  passwordEnv?: string
  max?: number
  connectionTimeoutMillis?: number
  idleTimeoutMillis?: number
  ssl?: boolean
}

/** 解析后的连接参数（**不含**任何明文密码，密码单列以便日志脱敏） */
export interface ResolvedConnection {
  host: string
  port: number
  database: string
  user: string
  password: string
  max: number
  connectionTimeoutMillis: number
  idleTimeoutMillis: number
  ssl: boolean
}

/**
 * 校验"配置里填的是环境变量名，而不是密钥值本身"。
 *
 * 为什么必须有这道闸：`config/plugins.*.json` 是**被 git 跟踪**的文件，把真密码填进
 * `passwordEnv` 会静默落盘、随后完全静默地连不上库（密码被当成变量名去查 → undefined）。
 * 宁可激活失败并说清原因，也不要"看起来配好了其实没配"。
 */
export function assertEnvNameLooksLikeName(field: string, value: string): void {
  if (value === '') return // 空 = 未配置
  if (ENV_VAR_NAME_RE.test(value)) return
  throw new Error(
    `@geewiki/postgres: 配置项 ${field} 必须是**环境变量名**（全大写 + 下划线，如 GEEWIKI_DB_PASSWORD），` +
      `但收到的值不符合该形态。该字段会被写入入库的配置文件，故不接受直接填密码值。`,
  )
}

/** 由配置解析出连接参数（密码从环境变量取；缺环境变量按空串处理=无密码） */
export function resolveConnection(config: PostgresConfig, env: NodeJS.ProcessEnv = process.env): ResolvedConnection {
  assertEnvNameLooksLikeName('connectionStringEnv', config.connectionStringEnv ?? '')
  assertEnvNameLooksLikeName('passwordEnv', config.passwordEnv ?? '')
  // 密码**只能**来自环境变量：配置里不存在明文字段，故这里没有回退分支。
  // 环境变量未设 → 空串 = 无密码（与"未配置"同义，避免把 undefined 塞给驱动）。
  const password = config.passwordEnv ? (env[config.passwordEnv] ?? '') : ''
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 5432,
    database: config.database ?? 'geewiki',
    user: config.user ?? 'geewiki',
    password,
    max: config.max ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    ssl: config.ssl ?? false,
  }
}

/* ============================== 适配器 ============================== */

/** 迁移目录：本包自带 migrations/（按方言声明在 server 注册表里，此处用于自测/直连场景） */
export const POSTGRES_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/* ---- 连接池抽象：真实实现是 pg 的 Pool；测试可注入替身（无需真库即可验证行为） ---- */

export interface QueryResultLike {
  rows: Record<string, unknown>[]
  rowCount: number | null
}

export interface ClientLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>
  release(): void
}

export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>
  connect(): Promise<ClientLike>
  end(): Promise<void>
  /** 空闲连接出错时的回调注册（node-postgres 的 'error' 事件） */
  on(event: 'error', listener: (err: Error) => void): unknown
}

export type PoolFactory = (config: Record<string, unknown>) => PoolLike

/** 占位符风格：把消费方写的 `?` 统一转成 PG 的 `$1..$n` */
function toPositional(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

/**
 * PostgreSQL 异步适配器。
 *
 * 与 sqlite 版的**语义对齐点**：
 * - `migrate()`：按文件名字典序、每个脚本**独立事务**、成功后登记到 `_migrations`、失败回滚并抛错；
 * - `transaction()`：**同一连接**执行事务内全部语句（连接池下这是正确性的前提）；
 * - `run()` 返回 `{ changes, lastInsertRowid }`（`lastInsertRowid` 从 `RETURNING id` 或 rowCount 取）。
 */
export class PostgresDatabase implements DatabaseAdapterAsync {
  readonly dialect = 'postgres' as const
  readonly kind = 'async' as const

  private pool: PoolLike | null = null

  constructor(
    private readonly connection: ResolvedConnection,
    /** 迁移记录表在首次 migrate 时按需创建（与 sqlite 版在 open() 里建表等价） */
    private readonly ensureMigrationsTable = true,
    /**
     * 连接池工厂（可注入，供单测用替身验证"占位符转换/事务用同一连接/错误监听"等行为，
     * 无需真实数据库）。生产不传，用 pg 的 `Pool`。
     */
    private readonly createPool: PoolFactory = (cfg) => new Pool(cfg as never) as unknown as PoolLike,
  ) {}

  /** 惰性建立连接池，并挂上空闲连接的错误处理 */
  private requirePool(): PoolLike {
    if (this.pool) return this.pool
    const pool = this.createPool({
      host: this.connection.host,
      port: this.connection.port,
      database: this.connection.database,
      user: this.connection.user,
      password: this.connection.password,
      max: this.connection.max,
      connectionTimeoutMillis: this.connection.connectionTimeoutMillis,
      idleTimeoutMillis: this.connection.idleTimeoutMillis,
      ssl: this.connection.ssl ? { rejectUnauthorized: false } : undefined,
    })
    // **必须有**：空闲连接被服务端断开（重启/超时/网络抖动）时 node-postgres 会在 pool 上
    // 触发 'error'；不监听就是**未捕获异常**，在 Node 里会直接打挂进程。
    pool.on('error', (err) => {
      console.error('[db-postgres] 空闲连接出错（已由连接池接管，不影响后续查询）:', err.message)
    })
    this.pool = pool
    return pool
  }

  /** 打开连接并跑一次迁移（幂等）；激活时调用，失败即抛错阻止插件激活 */
  async open(directory: string = POSTGRES_MIGRATIONS_DIR): Promise<void> {
    this.requirePool()
    await this.migrate(directory)
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const res = await this.requirePool().query(toPositional(sql), params as unknown[])
    return res.rows as T[]
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const res = await this.requirePool().query(toPositional(sql), params as unknown[])
    // RETURNING id 时取首行的 id（PG 无"隐式 last insert id"概念）；
    // 否则退回 0——调用方在 PG 下若要拿新 id，应在 SQL 里写 RETURNING id。
    const first = res.rows[0] as { id?: number | bigint } | undefined
    return { changes: res.rowCount ?? 0, lastInsertRowid: first?.id ?? 0 }
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    )
    return rows.map((r) => r.table_name)
  }

  async appliedMigrations(): Promise<string[]> {
    try {
      const rows = await this.query<{ name: string }>(
        `SELECT name FROM ${MIGRATION_TABLE} ORDER BY name`,
      )
      return rows.map((r) => r.name)
    } catch (err) {
      // 表还没建（从未跑过迁移）：视为"没有已应用迁移"，而不是让健康检查炸掉
      if (isUndefinedTable(err)) return []
      throw err
    }
  }

  /**
   * 迁移控制器（与 sqlite 版语义对齐）：
   * 按文件名序、**逐文件独立事务**、成功后登记、失败回滚并抛错（阻止插件激活）。
   *
   * 与 sqlite 的差异：SQL 里不该再写 `BEGIN`/`COMMIT`（事务由这里负责），
   * 且 `?` 占位符会被转成 `$n` —— 迁移脚本本身用的是纯 DDL，通常不受影响。
   */
  async migrate(directory: string): Promise<void> {
    const pool = this.requirePool()
    if (this.ensureMigrationsTable) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
           name TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
      )
    }
    const files = readdirSync(directory)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const applied = new Set(await this.appliedMigrations())
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(join(directory, file), 'utf8')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES ($1, $2)`, [
          file,
          new Date().toISOString(),
        ])
        await client.query('COMMIT')
        console.log(`[db-postgres] 迁移已应用: ${file}`)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        console.error(`[db-postgres] 迁移失败（已回滚）: ${file}`, err)
        throw err
      } finally {
        client.release()
      }
    }
  }

  /**
   * 事务边界：**从池里取一条连接并在其上执行全部语句**（含 BEGIN/COMMIT/ROLLBACK）。
   *
   * 为什么不能用 `pool.query('BEGIN')`：池会把每条语句分派到**任意**空闲连接，
   * BEGIN 与后续语句很可能不在同一条连接上 ⇒ 事务根本没生效（且不会报错）。
   */
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    const client: ClientLike = await this.requirePool().connect()
    // 事务作用域的执行器：**所有语句都走这条 client**。回调若改用 this.query，
    // 语句会被池分派到别的连接上，事务静默失效——故这里只交出 tx，不鼓励那样写。
    const tx: DatabaseExecutor = {
      query: async <T2 = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T2[]> => {
        const res = await client.query(toPositional(sql), params as unknown[])
        return res.rows as T2[]
      },
      run: async (sql: string, params?: unknown[]): Promise<RunResult> => {
        const res = await client.query(toPositional(sql), params as unknown[])
        const first = res.rows[0] as { id?: number | bigint } | undefined
        return { changes: res.rowCount ?? 0, lastInsertRowid: first?.id ?? 0 }
      },
    }
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        console.error('[db-postgres] 事务回滚失败（原始错误将照常抛出）:', rollbackErr)
      }
      throw err
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return
    const pool = this.pool
    this.pool = null
    await pool.end()
  }
}

/** PG 错误码 42P01 = undefined_table（迁移记录表尚未建立） */
function isUndefinedTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01'
}

/* ============================== 插件 ============================== */

export const manifest: GeeWikiManifest = {
  name: '@geewiki/postgres',
  version: '0.1.0',
  geewiki: {
    // ★ F10：跨界能力声明（宿主不强制，用于评审与可观测）
    permissions: ['fs:read', 'env', 'net'],
    displayName: 'PostgreSQL 数据库',
    description: '把页面与版本历史保存在 PostgreSQL 服务里，适合多人协作与集中运维',
    provides: 'database-provider',
    // 与 @geewiki/db-sqlite 同组 ⇒ 同组互斥自动生效，无需新增机制
    conflictGroup: 'database-provider',
    requires: [],
    runtime: {
      supportsHotReload: false, // 数据库驱动：冷操作，仅支持持久化安装 + 进程重启（与 sqlite 一致）
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: PostgresConfigSchema,
  },
}

/**
 * cordis 插件：建立连接池 → 跑迁移 → 以 `db` 服务名提供。
 *
 * **`apply` 是 async 的，且顺序与 `@geewiki/db-sqlite` 严格一致**（open → provide → 返回清理函数）：
 * 管理器用 `await ctx.plugin(module, config)` 加载，故 activation 结算时 `db` 服务**一定已就绪**。
 * 若改成"先 provide、再异步 open"，依赖 `db` 的插件会在表建好之前就开始查询——
 * 这类竞态只在慢库上偶发，极难排查。
 */
export const PostgresPlugin = {
  name: '@geewiki/postgres',

  async apply(ctx: Context, config: PostgresConfig = {}) {
    const connection = resolveConnection(config)
    const adapter = new PostgresDatabase(connection)
    try {
      await adapter.open()
    } catch (err) {
      // 初始化失败（连不上库/迁移失败）：先收掉连接池再抛，避免留下悬空句柄
      await adapter.close().catch(() => undefined)
      throw err
    }
    const unprovide = ctx.provide('db', adapter)
    console.log(
      `[db-postgres] 已就绪: postgres://${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
    )
    return async () => {
      unprovide()
      await adapter.close()
      console.log('[db-postgres] 连接池已关闭')
    }
  },
}
