/**
 * @geewiki/core —— GeeWiki 共享类型与常量
 *
 * 类型定义与 docs/architecture.md 第 7 节"插件元数据规范（Manifest）"逐字段对齐。
 */

/* 引入 cordis 类型面补充（cordis-env.ts 自包含声明，见该文件头注释）。
   此 import type 仅用于让 cordis 模块进入本 program 的类型解析
   （缺少时 declare module 'cordis' 会报 TS2664 cannot be found）。 */
import type { Context } from 'cordis'
import './cordis-env.js'

export type { FiberLike } from './cordis-env.js'

/* ============================== 插件 Manifest ============================== */

/** `geewiki.runtime`：运行期能力声明 */
export interface GeeWikiRuntime {
  /**
   * 是否支持热加载（临时加载/卸载）。
   * 安全原则：默认不支持热加载（false），仅显式声明 true 才允许热操作。
   */
  supportsHotReload?: boolean
  /** 热操作/配置热更新后是否要求清理运行时缓存 */
  requiresCachePurge?: boolean
  /** 卸载前等待进行中任务完成的秒数，默认 5 */
  drainTimeout?: number
}

/** `geewiki` 命名空间：插件元数据 */
export interface GeeWikiMeta {
  /** 对外提供的服务/能力标识（如 "database-provider"、"ai-service"），供其他插件 requires 引用 */
  provides?: string
  /** 依赖的插件/服务标识列表（如 ["@geewiki/core"]）；加载时自动递归加载未激活的依赖项 */
  requires?: string[]
  /** 广义冲突组名：同组内全局仅允许激活一个（如 "database-provider"、"llm-provider"） */
  conflictGroup?: string
  /** 迁移脚本目录（相对插件根目录，SQL/JS），插件激活前由迁移控制器执行 */
  migrations?: string
  /** 运行期能力声明 */
  runtime?: GeeWikiRuntime
  /**
   * JSON Schema 格式的配置定义与校验
   * （如 { apiKey: { type: 'string', format: 'password' } }），驱动管理界面自动生成配置表单。
   */
  configSchema?: Record<string, unknown>
}

/**
 * 插件 Manifest。
 * 来源二选一：扩展 package.json（元数据嵌套于顶层 `geewiki` 键）/ 独立 geewiki.manifest.json。
 */
export interface GeeWikiManifest {
  /** 插件名称（npm 风格，如 "@geewiki/ai-assistant"），依赖图与冲突组以此作为标识 */
  name: string
  /** 插件版本号（语义化版本） */
  version: string
  /** 插件元数据命名空间 */
  geewiki: GeeWikiMeta
}

/** 填充默认值后的运行期配置（供插件管理器使用） */
export interface NormalizedRuntime {
  supportsHotReload: boolean
  requiresCachePurge: boolean
  drainTimeout: number
}

/** 由原始（可能缺省）运行期声明规范化：supportsHotReload 默认 false、drainTimeout 默认 5 秒 */
export function normalizeRuntime(runtime?: GeeWikiRuntime): NormalizedRuntime {
  return {
    supportsHotReload: runtime?.supportsHotReload ?? false,
    requiresCachePurge: runtime?.requiresCachePurge ?? false,
    drainTimeout: runtime?.drainTimeout ?? 5,
  }
}

/* ============================ DatabaseAdapter ============================ */

/** 写操作结果（对齐 better-sqlite3 的 run() 语义） */
export interface RunResult {
  /** 受影响的行数 */
  changes: number
  /** 自增主键的最近插入 id（无自增主键时可为 0） */
  lastInsertRowid: number | bigint
}

/**
 * 数据库适配层接口：所有数据库插件（SQLite / PostgreSQL）实现本接口，
 * 业务代码只面向本接口编程，使数据库切换对上层透明。
 */
export interface DatabaseAdapter {
  /**
   * 执行查询（SELECT 等），返回全部结果行。
   * @param sql    参数化 SQL（? 占位符；PG 方言差异由实现屏蔽）
   * @param params 绑定参数
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]

  /**
   * 执行写入/DDL（INSERT / UPDATE / DELETE / CREATE 等）。
   * @param sql    参数化 SQL
   * @param params 绑定参数
   */
  run(sql: string, params?: unknown[]): RunResult

  /**
   * 执行迁移：按文件名顺序应用 `directory` 下的 SQL 迁移脚本，
   * 每个脚本在独立事务中执行并登记到迁移记录表，失败即回滚并抛错。
   * @param directory 迁移脚本目录（省略时由实现决定默认目录）
   */
  migrate(directory?: string): void

  /** 当前库中全部用户表名（供健康检查/管理界面展示） */
  listTables(): string[]

  /** 已应用的迁移文件名清单（按应用顺序，供健康检查/管理界面展示） */
  appliedMigrations(): string[]

  /**
   * 事务边界：回调正常返回则提交；回调抛错则整体回滚并向上传播异常。
   */
  transaction<T>(fn: () => T): T

  /** 释放底层连接资源（进程退出/插件卸载时调用） */
  close(): void
}

/* ================================ 常量 =================================== */

/** 默认 HTTP 端口 */
export const DEFAULT_PORT = 3000

/** 默认数据目录（相对进程工作目录）；SQLite 数据库文件存放于此 */
export const DEFAULT_DATA_DIR = './data'

/** 默认数据库文件名 */
export const DEFAULT_DB_FILENAME = 'geewiki.db'

/** 健康检查路径 */
export const HEALTH_PATH = '/api/health'

/** 迁移登记表名 */
export const MIGRATION_TABLE = '_migrations'

/* ========================= HTTP 路由服务（插件间共享） ========================= */

/**
 * HTTP 路由处理器上下文：由 @geewiki/http 路由服务构造后交给已注册的路由。
 * 处理器可同步返回或返回 Promise（异步错误统一转 500）。
 */
export interface RouteHandlerContext {
  /** 原始请求（node:http IncomingMessage） */
  req: import('node:http').IncomingMessage
  /** 响应对象（node:http ServerResponse） */
  res: import('node:http').ServerResponse
  /** 已解析的请求 URL（含 query） */
  url: URL
  /** 路径参数（注册路径中的 :param 段 → 实际值） */
  params: Record<string, string>
  /** 发送 JSON 响应并结束 */
  json(status: number, body: unknown): void
}

/** 路由处理器 */
export type RouteHandler = (h: RouteHandlerContext) => void | Promise<void>

/** 路由服务统计（供看门狗健康监测使用） */
export interface HttpRouterStats {
  total: number
  ok: number
  fail: number
  /** 连续失败次数（看门狗熔断依据） */
  consecutiveFailures: number
  /** 最近一次请求耗时（毫秒） */
  lastMs: number
  /** 平均请求耗时（毫秒） */
  avgMs: number
}

/**
 * HTTP 路由服务（由 @geewiki/http 提供，经 ctx.get('http') 获取）：
 * 其他插件通过 register 挂载 JSON 路由，卸载时调用返回的注销函数。
 * path 支持 `:param` 段（如 '/api/plugins/:name/enable'），实际值经
 * RouteHandlerContext.params 获取。
 */
export interface HttpRouterService {
  /** 注册路由（method 大写，path 精确或带 :param 匹配）；返回注销函数 */
  register(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, handler: RouteHandler): () => void
  /** 请求统计（看门狗探针数据源） */
  stats(): HttpRouterStats
}
