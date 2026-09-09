/**
 * @geewiki/db-sqlite —— GeeWiki 默认数据库插件
 *
 * 以 better-sqlite3（同步 API）实现 @geewiki/core 定义的 DatabaseAdapter，
 * 并通过 cordis 服务注入机制以 `db` 服务名提供给其他插件。
 * 本插件属于 conflictGroup: "database-provider"（同组互斥，见 Manifest 元数据），
 * 上层业务只面向 DatabaseAdapter 编程，可无缝切换至 PostgreSQL 等其他实现。
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { Context } from 'cordis'
import {
  DEFAULT_DATA_DIR,
  DEFAULT_DB_FILENAME,
  MIGRATION_TABLE,
  type DatabaseAdapter,
  type RunResult,
} from '@geewiki/core'

/* ============================== 配置 ============================== */

export interface SqliteDbConfig {
  /** 数据库文件路径；缺省为 <GEEWIKI_DATA_DIR 或 ./data>/geewiki.db */
  filename?: string
}

/* =========================== 适配器实现 =========================== */

/**
 * SQLite 数据库适配器。
 * 说明：better-sqlite3 为同步 API，因此 DatabaseAdapter 的同步形态
 * 在这里自然落地（PG 等异步实现可另行封装 Promise 语义的适配接口）。
 */
export class SqliteDatabase implements DatabaseAdapter {
  private db: Database.Database | null = null

  constructor(private readonly filename: string) {}

  /** 打开数据库文件并执行未应用的迁移（幂等）。 */
  open(): void {
    mkdirSync(dirname(this.filename), { recursive: true })
    const db = new Database(this.filename)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    this.db = db
    // 确保迁移登记表存在，再执行增量迁移
    db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    this.migrate(this.defaultMigrationDir)
  }

  /** 包内置迁移脚本目录（src/migrations，随源码分发） */
  private get defaultMigrationDir(): string {
    return DB_SQLITE_MIGRATIONS_DIR
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.requireDb().prepare(sql).all(...params) as T[]
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const info = this.requireDb().prepare(sql).run(...params)
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
  }

  migrate(directory: string = this.defaultMigrationDir): void {
    const db = this.requireDb()
    const files = readdirSync(directory)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const applied = new Set(
      db.prepare(`SELECT name FROM ${MIGRATION_TABLE}`).all().map((r) => (r as { name: string }).name),
    )
    const doOne = db.transaction((name: string, sql: string) => {
      db.exec(sql)
      db.prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`).run(name, new Date().toISOString())
    })
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(join(directory, file), 'utf8')
      try {
        doOne(file, sql)
        console.log(`[db-sqlite] 迁移已应用: ${file}`)
      } catch (err) {
        // 迁移失败：整个迁移脚本所在事务已回滚，向上抛错以阻止插件激活
        console.error(`[db-sqlite] 迁移失败（已回滚）: ${file}`, err)
        throw err
      }
    }
  }

  transaction<T>(fn: () => T): T {
    return this.requireDb().transaction(fn)()
  }

  /** 已应用的迁移清单（供健康检查/管理接口展示） */
  appliedMigrations(): string[] {
    if (!this.db) return []
    return (this.db.prepare(`SELECT name FROM ${MIGRATION_TABLE} ORDER BY name`).all() as { name: string }[]).map((r) => r.name)
  }

  /** 当前库中所有用户表（供健康检查展示） */
  listTables(): string[] {
    if (!this.db) return []
    return (
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name)
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('db-sqlite: 数据库尚未打开（open() 未调用或已 close()）')
    return this.db
  }
}

/* ============================ 插件本体 ============================ */

/** 包内置迁移目录（绝对路径，供插件管理器迁移控制器读取） */
export const DB_SQLITE_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * cordis 插件：@geewiki/db-sqlite
 *
 * 激活后向 ctx 提供 `db` 服务（DatabaseAdapter）。
 * 插件卸载时自动注销服务并关闭数据库连接。
 */
export const SqliteDbPlugin = {
  name: '@geewiki/db-sqlite',

  apply(ctx: Context, config: SqliteDbConfig = {}) {
    // 数据目录优先取环境变量（与 docker-compose 约定一致），否则取进程工作目录下的 ./data
    const dataDir = process.env.GEEWIKI_DATA_DIR ?? DEFAULT_DATA_DIR
    const filename = resolve(config.filename ?? join(dataDir, DEFAULT_DB_FILENAME))
    const adapter = new SqliteDatabase(filename)
    try {
      adapter.open()
    } catch (err) {
      adapter.close()
      throw err
    }
    const unprovide = ctx.provide('db', adapter)
    console.log(`[db-sqlite] 已就绪: ${filename}`)
    return async () => {
      unprovide()
      adapter.close()
    }
  },
}

/** 本插件的 GeeWiki Manifest 元数据（供插件管理器读取；Phase 1 起由清单驱动加载） */
export const manifest = {
  name: '@geewiki/db-sqlite',
  version: '0.1.0',
  geewiki: {
    provides: 'database-provider',
    conflictGroup: 'database-provider',
    migrations: './src/migrations',
    runtime: {
      supportsHotReload: false, // 数据库驱动：冷操作，仅支持持久化安装 + 进程重启
      drainTimeout: 5,
    },
  },
}
