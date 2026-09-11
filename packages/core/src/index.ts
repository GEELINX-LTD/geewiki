/**
 * @geewiki/core —— GeeWiki 共享类型与常量
 *
 * 类型定义与 docs/architecture.md 第 7 节"插件元数据规范（Manifest）"逐字段对齐。
 */

/* 引入 cordis 类型面补充（cordis-env.ts 自包含声明，见该文件头注释）。
   此 import type 仅用于让 cordis 模块进入本 program 的类型解析
   （缺少时 declare module 'cordis' 会报 TS2664 cannot be found）。 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import './cordis-env.js'

export type { FiberLike } from './cordis-env.js'

/* ============================ 配置 Schema ============================ */

/**
 * 插件配置 Schema 的类型（schemastery 实例）。
 *
 * 用 `ReturnType<typeof Schema.any<any>>` 表达"任意 schemastery Schema"：
 * object/union/array 等具体 Schema 都可赋值给它，且实例可调用（校验 + 填默认值）、
 * 可 `toJSON()` 序列化。类型参数必须用 `any`——Schema 的调用签名参数处于逆变位置，
 * 换成 `unknown` 会让所有具体 Schema 都不可赋值。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 逆变参数位必须用 any（见上方说明）
export type ConfigSchema = ReturnType<typeof Schema.any<any>>

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

/**
 * `geewiki.client`：插件**客户端 UI 入口**声明。
 *
 * 缺省 = 该插件没有前端界面，宿主不会加载它（也不会产生任何请求噪声）。
 * 与 `geewiki.entry` 的区别：后者是**后端**入口（index.ts 等），两者不可混用。
 */
export interface GeeWikiClient {
  /**
   * UI 入口**文件名**：必须单段（不含 `/`、不是 `.`/`..`），相对该插件的 UI 根。
   * 缺省 `'client.js'`（配合 `pnpm --filter @geewiki/web build:fixtures` 的产物名）。
   */
  entry?: string
  /** 可选样式**文件名**：同样单段，相对同一 UI 根；缺省 = 不注入样式 */
  css?: string
}

/** `geewiki` 命名空间：插件元数据 */
export interface GeeWikiMeta {
  /**
   * **面向人的短名称**（如「SQLite 数据库」「全文检索」）。
   *
   * 用途：管理台等界面用它替代 npm 包名展示，让非开发者也能看懂这是什么插件。
   * **缺失时的回退语义**：界面必须回退到 `name`（包名）。该字段是纯展示用的可选元数据，
   * 不参与依赖解析、冲突组或任何运行时判定，缺失不得导致报错或功能缺失。
   */
  displayName?: string
  /**
   * **一句话说明这个插件做什么**（面向用户，非开发者；如「创建、编辑与删除页面，并保留历史版本」）。
   *
   * 用途：管理台的插件说明、配置面板的引导文案。
   * **缺失时的回退语义**：界面应隐藏说明区域（或留空），**不要**拿包名或技术字段
   * （`provides` / `conflictGroup` / `layer` 等）冒充说明——那些是机器标识，对用户无意义。
   */
  description?: string
  /** 对外提供的服务/能力标识（如 "database-provider"、"ai-service"），供其他插件 requires 引用 */
  provides?: string
  /** 依赖的插件/服务标识列表（如 ["@geewiki/core"]）；加载时自动递归加载未激活的依赖项 */
  requires?: string[]
  /** 广义冲突组名：同组内全局仅允许激活一个（如 "database-provider"、"llm-provider"） */
  conflictGroup?: string
  /**
   * 迁移脚本目录（相对插件根目录，SQL/JS），插件激活前由迁移控制器执行。
   *
   * 两种写法（**向后兼容**：`string` 写法语义完全不变）：
   * - `string`：所有方言共用同一目录（等价于 `{ default: '…' }`）；
   * - `{ default?, postgres? }`：按当前数据库方言取目录；`default` 是通用回退，
   *   其余键名与 `DatabaseAdapter.dialect` 的取值对应。
   *
   * **取不到当前方言的目录时**：视为"该插件在当前数据库下没有迁移"——跳过并记警告
   * （与"声明目录不存在"的既有语义一致：表结构由插件自管，不阻断激活）。
   * 若插件在该方言下**根本无法工作**，应由插件自己在 `apply` 里显式拒绝
   * （例如 plugin-search 依赖 SQLite 专有的 FTS5）。
   */
  migrations?: string | { default?: string; postgres?: string }
  /**
   * 外部插件入口文件（相对插件目录，如 "index.ts"）。
   * 仅外部插件（<仓库根>/plugins/<name>/）使用；缺省时按
   * index.ts → index.js → src/index.ts 顺序探测。
   */
  entry?: string
  /** 运行期能力声明 */
  runtime?: GeeWikiRuntime
  /**
   * 客户端 UI 入口（见 {@link GeeWikiClient}）。
   *
   * 声明后该插件会进入宿主下发的**入口表**（`GET /api/plugins/ui`），
   * 由前端动态 import 其 bundle 并注册插槽组件；未声明则永不进入。
   */
  client?: GeeWikiClient
  /**
   * **声明本插件向哪些宿主插槽贡献界面**（见 {@link SlotName}）。
   *
   * 与 `client` 的关系：`client` 声明"我有 UI 产物"，`slots` 声明"我要占用哪些位置"。
   * 声明后管理器在**激活时自动登记**为插槽贡献（`via: 'manifest'`），
   * 于是入口表能带上"哪个插件占了哪个插槽"，宿主据此决定要加载哪些 bundle
   * （配合 `ctx.get('slot').contribute(..., { lazy: true })` 可把编辑器一类大产物推迟到需要时）。
   *
   * 未在白名单内的名字会被**忽略并告警**，不阻断激活（与前端"忽略未知插槽名"的既有行为一致）：
   * 一个笔误不该让整个插件起不来，但必须在日志里可见。
   *
   * 声明式优先：能用本字段表达的就不要用运行期 `contribute()`——
   * 前者可被静态检查、能在插件代码跑起来之前就进入入口表。
   */
  slots?: SlotName[]
  /**
   * 插件配置 Schema（schemastery 实例，如 Schema.object({ port: Schema.number().default(3000) })）。
   *
   * 驱动三件事：REST 层把配置下发/校验、管理台自动生成配置表单、配置热更新前的校验。
   * 运行期兼容：若插件给的是普通对象（旧式 JSON Schema 字面量），管理器视为"无 schema"，
   * 仅提供 JSON 原文编辑、不做校验，并打印一次告警。
   */
  configSchema?: ConfigSchema
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
 * 数据库方言标识。
 *
 * 用途有二：① `GeeWikiMeta.migrations` 的方言键（按当前适配器的方言选迁移目录）；
 * ② 插件在 `apply` 里显式判断"本插件在当前数据库下能否工作"
 * （例如依赖 SQLite 专有 FTS5 的 plugin-search 必须拒绝非 sqlite 方言）。
 */
export type DatabaseDialect = 'sqlite' | 'postgres'

/**
 * 数据库适配层接口：所有数据库插件（SQLite / PostgreSQL）实现本接口，
 * 业务代码只面向本接口编程，使数据库切换对上层透明。
 *
 * 注意本接口是**同步**形态（为 better-sqlite3 而生）。异步驱动（pg）请实现
 * {@link DatabaseAdapterAsync}；消费方若两者都要支持，用 {@link asAsync} 归一化，
 * 不要在每个调用点写 `instanceof`/分支。
 */
export interface DatabaseAdapter {
  /**
   * 方言标识。**可选**：缺省视为 `'sqlite'`（向后兼容既有实现与测试替身）。
   */
  dialect?: DatabaseDialect

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

/**
 * 事务作用域内的语句执行器。
 *
 * 为什么事务回调**必须**拿到它、而不是继续用适配器自身的 `query`/`run`：
 * 异步驱动的适配器背后是**连接池**，`pool.query()` 会把语句分派到任意一条空闲连接上。
 * 若事务里继续用适配器的方法，`BEGIN` 与后续语句很可能不在同一条连接上——
 * **事务会静默失效**（不报错，但回滚不了）。把执行器作为参数交给回调，
 * 让"用事务的连接"成为路径最短的写法。
 */
export interface DatabaseExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<RunResult>
}

/**
 * **异步**数据库适配层接口：异步驱动（如 `pg`）实现本接口。
 *
 * 为什么是"双轨"而不是把 {@link DatabaseAdapter} 整体改成异步：既有同步接口的消费点
 * 遍布业务代码，整体异步化是一次大范围破坏性改动；而驱动本身的同步/异步是**实现细节**，
 * 不应泄漏到每一个调用点。双轨 + {@link asAsync} 让"写一次代码、两种驱动都能跑"成为可能。
 *
 * 与同步版的差异**仅在于返回值是 Promise**，方法语义逐条对齐（含 `transaction` 的
 * 提交/回滚语义）。
 */
export interface DatabaseAdapterAsync extends DatabaseExecutor {
  /** 方言标识（异步适配器**必填**，供迁移目录选择与插件能力判断） */
  dialect: DatabaseDialect

  /** 判别式标记：`isAsyncAdapter` 据此做**结构化**判定（而非 `instanceof`） */
  readonly kind: 'async'

  migrate(directory?: string): Promise<void>

  listTables(): Promise<string[]>

  appliedMigrations(): Promise<string[]>

  /**
   * 事务边界：回调正常返回（resolve）则提交；回调抛错则整体回滚并向上传播异常。
   * 实现必须保证**事务内所有语句走同一条连接**（连接池下这点尤其关键）——
   * 回调**必须使用传入的 `tx`** 执行语句，用适配器自身的方法会落到别的连接上。
   */
  transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>

  close(): Promise<void>
}

/**
 * 结构化判定是否为异步适配器（**不用 `instanceof`**：跨包副本/多实例下 `instanceof`
 * 会误判，而这是插件生态里常见的情形）。
 */
export function isAsyncAdapter(value: unknown): value is DatabaseAdapterAsync {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<DatabaseAdapterAsync>
  return (
    v.kind === 'async' &&
    typeof v.query === 'function' &&
    typeof v.run === 'function' &&
    typeof v.listTables === 'function' &&
    typeof v.appliedMigrations === 'function' &&
    typeof v.transaction === 'function' &&
    typeof v.close === 'function'
  )
}

/** 已归一化为异步形态的适配器：`dialect` 必定可用 */
export type AnyDatabaseAdapter = DatabaseAdapter | DatabaseAdapterAsync

/**
 * 把任意适配器归一化为**异步**形态，使消费方只写一条代码路径。
 *
 * - 传入异步适配器：原样返回（不额外包一层，避免事务语义被二次包装）。
 * - 传入同步适配器：薄包装——查询/写入/migrate 用 `Promise.resolve` 提升；
 *   `transaction` **改为 BEGIN/COMMIT/ROLLBACK 显式事务**：better-sqlite3 的
 *   `transaction()` 只接受同步回调，若直接包一个 async 回调会在 Promise 结算前就提交，
 *   事务形同虚设。同步驱动只有一条连接，故用显式语句同样是正确的。
 */
export function asAsync(adapter: AnyDatabaseAdapter): DatabaseAdapterAsync {
  if (isAsyncAdapter(adapter)) return adapter
  const sync = adapter
  return {
    kind: 'async',
    dialect: sync.dialect ?? 'sqlite',
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> =>
      sync.query<T>(sql, params),
    run: async (sql: string, params?: unknown[]): Promise<RunResult> => sync.run(sql, params),
    migrate: async (directory?: string): Promise<void> => sync.migrate(directory),
    listTables: async (): Promise<string[]> => sync.listTables(),
    appliedMigrations: async (): Promise<string[]> => sync.appliedMigrations(),
    transaction: async <T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> => {
      // 同步驱动只有一条连接，故把门面自身当作事务执行器交给回调——
      // 与异步版"必须用 tx"的调用约定保持一致，业务代码无需分叉。
      const facade: DatabaseExecutor = {
        query: async <T2 = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T2[]> =>
          sync.query<T2>(sql, params),
        run: async (sql: string, params?: unknown[]): Promise<RunResult> => sync.run(sql, params),
      }
      sync.run('BEGIN')
      try {
        const result = await fn(facade)
        sync.run('COMMIT')
        return result
      } catch (err) {
        try {
          sync.run('ROLLBACK')
        } catch (rollbackErr) {
          // 回滚失败不得掩盖原始错误：记日志后继续抛出原始异常
          console.error('[core] 事务回滚失败（原始错误将照常抛出）:', rollbackErr)
        }
        throw err
      }
    },
    close: async (): Promise<void> => sync.close(),
  }
}

/* ================================ 常量 =================================== */

/** 默认 HTTP 端口 */
export const DEFAULT_PORT = 3000

/** 默认数据目录（相对路径，以仓库根为基准解析，见 resolveProjectPath）；SQLite 数据库文件存放于此 */
export const DEFAULT_DATA_DIR = './data'

/** 默认数据库文件名 */
export const DEFAULT_DB_FILENAME = 'geewiki.db'

/** 健康检查路径 */
export const HEALTH_PATH = '/api/health'

/** 迁移登记表名 */
export const MIGRATION_TABLE = '_migrations'

/**
 * 插件客户端 UI 资产的 URL 前缀：`<前缀>/<插件名>/<文件名单段>`。
 *
 * 插件名**保持未编码**（`@geewiki/wiki` 就是两段），编码名一律不认——编码后
 * dev 下会落 Vite 的 SPA fallback（200 + text/html）、prod 下静态层不解码必 404。
 *
 * 注意：`packages/web` 不 import 本包（core 顶层依赖 node:fs，不能进浏览器 bundle），
 * 前端在 `packages/web/src/lib/pluginUi.ts` 持有**同名副本**并互相注释指认；
 * 两侧行为由测试表的同一组用例钉住。
 */
export const PLUGIN_UI_PREFIX = '/plugins-ui'

/**
 * UI 资产**文件名**的单段校验（入口表与静态层共用同一张规则）：
 * 以字母/数字开头，其后允许字母、数字、`.`、`_`、`-`。
 *
 * 因此 `client.js`、`client.css`、`client-a1b2.js` 合法，而 `..`、`.env`、
 * `a/b.js`、`x y.js`、空串非法。无 `g` 标志，`test()` 无 lastIndex 状态。
 */
export const PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * UI 资产**相对路径**校验（`<PLUGIN_UI_PREFIX>/<插件名>/<本规则>`）：
 * 一个或多个 {@link PLUGIN_UI_FILE_SEGMENT} 形态的段，以 `/` 连接。
 *
 * 为什么需要它、而不是放宽 `PLUGIN_UI_FILE_SEGMENT`：后者是**入口表**
 * （`client.entry` / `client.css`）与静态层**共用**的"单段文件名"规则——
 * `packages/manager/src/plugin-ui.ts` 用它校验清单声明，`packages/web` 持有同名副本，
 * 两侧各有测试钉住"含 `/` 即非法"。改它的语义会让入口表也接受带斜杠的入口名
 * （那是另一件事，且是回归）。故此处**新增**一条更宽的规则，两者并存、各自表述意图。
 *
 * 安全语义（这是本规则存在的**主要**理由）：段必须以字母/数字开头，故 `..`、`.env`、
 * `.` 这类段天然非法；空段（`a//b`）、绝对路径（`/a`）、反斜杠（Windows 分隔符）、
 * 尾随斜杠、以及 `%`（任何百分号编码）也一律非法。
 * ⇒ 消费方**无需解码**即可安全使用：不解码，就没有 `%2e%2e`、`..%2f`
 * 与双重编码这一整类陷阱，也没有"先解码再校验"的顺序依赖。
 *
 * 无 `g` 标志，`test()` 无 lastIndex 状态。
 */
export const PLUGIN_UI_ASSET_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

/**
 * 资产相对路径的**最大段数**（含文件名）。纯粹是输入体积的兜底：
 * 真实产物（Vite 的 `assets/js/chunk-x.js`）远达不到这个深度。
 */
export const PLUGIN_UI_ASSET_MAX_DEPTH = 16

/**
 * 缓存清理事件名（架构 §5.7）：插件停用/卸载后，若其 manifest 声明
 * `runtime.requiresCachePurge: true`，插件管理器经 cordis 事件总线广播本事件
 * （唯一参数为插件名）；持有派生缓存（索引、渲染结果、前端资源表等）的插件
 * 或宿主监听该事件后自行清理，避免卸载后残留陈旧数据。
 */
export const CACHE_PURGE_EVENT = 'geewiki/cache-purge'

/* ==================== 路径解析（与进程工作目录无关） ==================== */

/** 仓库根识别标记：pnpm workspace 定义文件 */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

/** 向上查找的最大层级（防御性上限，避免异常路径导致长循环） */
const MAX_ROOT_LOOKUP_DEPTH = 8

/**
 * 自 `fromUrl`（调用方的 `import.meta.url`）所在目录向上查找仓库根目录。
 * 识别依据：目录中存在 {@link WORKSPACE_MARKER}。未找到返回 undefined。
 */
export function findRepoRoot(fromUrl: string): string | undefined {
  let dir: string
  try {
    dir = dirname(fileURLToPath(fromUrl))
  } catch {
    return undefined // 非 file: URL（如被打包器改写）→ 交由调用方回退
  }
  for (let depth = 0; depth < MAX_ROOT_LOOKUP_DEPTH; depth++) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 仓库根目录；不可探测时（如包被安装进 node_modules 脱离工作区）回退进程工作目录 */
export function repoRootOf(fromUrl: string): string {
  return findRepoRoot(fromUrl) ?? process.cwd()
}

/**
 * 解析项目内路径（data/、config/、前端产物等）：
 * 绝对路径原样返回；相对路径以**仓库根**为基准（无仓库根时相对进程工作目录）。
 *
 * 目的：消除进程工作目录（cwd）依赖——`pnpm dev`、`pnpm start`、
 * `node packages/server/dist/index.js`、从任意子目录启动，都指向同一份数据与配置。
 */
export function resolveProjectPath(path: string, fromUrl: string): string {
  return isAbsolute(path) ? path : resolve(repoRootOf(fromUrl), path)
}

/* ========================= HTTP 路由服务（插件间共享） ========================= */

/* -------------------- 身份主体与路由访问等级（P0 鉴权骨架） -------------------- */

/**
 * 路由的**访问等级**（粗粒度闸门）。
 *
 * 语义刻意保持"粗"：它只回答"这条路由至少需要什么身份"，
 * **不做**逐对象判定——"这个用户能不能看这一条数据"属于 policy-service 的职责。
 * 粗粒度闸门挡的是"整类端点被匿名调用"（插件启停、条目写入），
 * 它**不能替代**逐对象判定：两者是纵深防御的两层，不是二选一。
 *
 * - `public`：任何主体（含匿名）都可调用。**默认值**，保证既有调用点零改动。
 * - `user`：需要已登录用户（`principal.kind === 'user'`）或应急通道（`'break-glass'`）。
 * - `admin`：需要管理员（`orgRole` 为 `owner`/`admin`）或应急通道。
 */
export type RouteAccess = 'public' | 'user' | 'admin'

/** `register()` 的可选第 4 参；省略等价于 `{ access: 'public' }` */
export interface RouteAccessOptions {
  access?: RouteAccess
}

/**
 * 请求身份主体。
 *
 * **为什么永远返回一个对象、而不是 `undefined` 表示"没有身份"**：让下游少一个可空分支。
 * "匿名"是一种**明确的主体**，不是"缺少信息"——若用 `undefined` 表示匿名，
 * `if (principal) { 过滤 }` 这类写法会把"忘了传"误当成"匿名"、把"匿名"误当成"没传"，
 * 最终演变成静默放行。故本类型没有"空主体"，只有 `kind: 'anonymous'`。
 */
export interface Principal {
  kind: 'anonymous' | 'user' | 'break-glass'
  /** 用户 id；匿名与应急通道为 `null` */
  userId: number | null
  /** 所属组织；单组织阶段恒为 1，匿名与应急通道为 `null` */
  orgId: number | null
  /**
   * 组织角色。**只用于能力判定，不参与可见性判定**
   * （唯一例外是 owner/admin 的应急覆盖，见设计文档规则 O1）。
   * P0 阶段还没有用户表，故非应急主体恒为 `null`。
   */
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  /** 已展开的组成员 id（`subject_kind='group'` 的授权判定直接用） */
  groupIds: readonly number[]
  /** 会话 id；P0 无会话机制，恒为 `null` */
  sessionId: string | null
}

/** 匿名主体：未携带任何可用凭据（也用于"凭据来源根本不存在"的情形） */
export function anonymousPrincipal(): Principal {
  return { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }
}

/**
 * 应急（break-glass）主体：经 `GEEWIKI_ADMIN_TOKEN` 环境变量进来的运维通道。
 *
 * 它**旁路**整个权限体系（应急通道的意义就在于"身份系统本身出问题时还能进场"），
 * 因此每次使用都必须留痕。该通道在环境变量**未设置时完全禁用**——
 * 不是"默认令牌"，也不接受任何回退值。
 *
 * `orgRole` 刻意留 `null` 而不是假装成 `'owner'`：旁路能力只由 `kind === 'break-glass'`
 * 表达。这样任何"按 orgRole 授权"的下游判定对应急主体都是**默认拒绝**（失败关闭），
 * 想放行就必须显式识别 `kind` —— 而那正是要写审计的地方。
 */
export function breakGlassPrincipal(): Principal {
  return { kind: 'break-glass', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }
}

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
  /**
   * **仅记录指标、不结束响应**——长连接（SSE 等）出口专用。
   *
   * 为什么必须单独有这条通路：{@link RouteHandlerContext.json} 除了（必要时）写响应头，
   * **必然**执行 `res.end(...)`，因此对"已写出 SSE 响应头、但需要继续保持连接"的处理器
   * 完全不适用——用它会把流立即终结；而且此时 `res.headersSent` 已为 true，json 会跳过
   * writeHead 却仍然 `res.end(JSON.stringify(body))`，把 JSON 文本（如字面 `null`）
   * 追加进事件流里污染协议。
   *
   * 长连接出口的正确姿势：确定状态码时调用本方法记一次指标 → 自行持续写帧 →
   * 自行 `res.end()` 收尾。指标每个请求只记一次（{@link json} 与本法共用同一记账点）。
   *
   * 可选（`?`）以保持向后兼容：既有测试替身与只发 JSON 的实现无需立刻补齐。
   */
  noteStatus?(status: number): void
  /**
   * 本次请求的身份主体（**P0 新增；可选**）。
   *
   * 由路由服务在请求分发时填入，处理器与前置钩子都可读；钩子**可以替换**它
   * （P1 的会话解析就是给匿名主体换上真实用户，再由访问等级闸门统一裁决）。
   *
   * 可选（`?`）以保持向后兼容：既有测试替身与只关心业务逻辑的处理器无需立刻读取它。
   * **但读取方必须失败关闭**：拿不到主体时按"匿名"处理、而不是按"有权限"处理。
   */
  principal?: Principal
}

/** 路由处理器 */
export type RouteHandler = (h: RouteHandlerContext) => void | Promise<void>

/**
 * 前置钩子的裁决结果。
 *
 * **为什么把 HTTP 状态码写进类型、而不是让钩子自己写响应**：钩子是集中单点，
 * 让它们只做"判定"、由路由服务统一写响应，才能保证错误信封一致
 * （`{ ok:false, error, message, details }`）与指标记账不被绕过——
 * 这正是"只堵了详情页、旁路却还开着"这类事故的来源。
 *
 * 状态码只开放三个语义明确的值：
 * - `401`：未认证（缺凭据或凭据无效）
 * - `403`：已认证但无权限
 * - `503`：系统尚未就绪（如引导期没有任何凭据来源），**不是**"未认证"
 */
export type RequestVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string }

/**
 * 请求前置钩子：在路由匹配成功之后、处理器执行之前运行。
 *
 * 契约：
 * 1. 按注册顺序**串行**执行；任一钩子返回 `ok:false` 即短路（后续钩子与处理器都不再执行）。
 * 2. 钩子**可以**读取或替换 `h.principal`（这是 P1 会话解析的挂载点）。
 * 3. 钩子**不得**自行结束响应（不要调 `h.json` / `res.end`）：只返回裁决。
 *    否则错误信封与 `stats()` 记账会被绕过。
 * 4. 钩子抛错视同 500（由路由服务统一处理）——**不要**用抛错表达"拒绝"（那是静默失败面）。
 * 5. 只用 `ok:true` 表示"放行"；返回形态不合法（非对象、缺 `ok`）时按**拒绝**处理（失败关闭）。
 *
 * 可选实现（`HttpRouterService.use`）以保持向后兼容：既有测试替身无需提供。
 */
export type RequestHook = (h: RouteHandlerContext) => RequestVerdict | Promise<RequestVerdict>

/**
 * 请求体未读完即已应答时的连接收尾：响应刷出后关闭连接。
 *
 * 用于 413（请求体超限）等提前拒绝场景：此时剩余请求体不会被消费，
 * 若不关闭连接，客户端可能持续推送已被丢弃的数据，或该连接被误当作可复用。
 * 响应体本身仍应经 `h.json(413, …)` 写出（统一出口 → 计入 stats() 与看门狗探针）。
 */
export function closeAfterResponse(h: RouteHandlerContext): void {
  // 显式声明 Connection: close，使响应头与实际行为（随后关闭连接）一致，
  // 避免出现"头部宣称 keep-alive、连接却被销毁"的矛盾语义
  if (!h.res.headersSent) h.res.setHeader('connection', 'close')
  h.res.once('finish', () => {
    if (!h.req.readableEnded) h.req.destroy()
  })
}

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
  /**
   * 长连接可观测性（当前在流数 / 累计被拒数）。
   *
   * **可选**（`?`）以保持向后兼容：既有测试替身与第三方实现无需提供；
   * 真实路由服务（@geewiki/http）总会填上它。
   */
  streams?: HttpStreamStats
}

/** 长连接（SSE 等）的可观测性计数 */
export interface HttpStreamStats {
  /** 当前仍活跃的长连接数（已 trackStream 且尚未注销） */
  active: number
  /** 累计因并发上限被拒的长连接请求数（由持有者经 noteStreamRejected 上报） */
  rejected: number
}

/**
 * HTTP 路由服务（由 @geewiki/http 提供，经 ctx.get('http') 获取）：
 * 其他插件通过 register 挂载 JSON 路由，卸载时调用返回的注销函数。
 * path 支持 `:param` 段（如 '/api/plugins/:name/enable'），实际值经
 * RouteHandlerContext.params 获取。
 */
export interface HttpRouterService {
  /**
   * 注册路由（method 大写，path 精确或带 :param 匹配）；返回注销函数。
   *
   * `opts.access` 是**粗粒度**访问等级（默认 `'public'`，故只传 3 个实参的既有调用点
   * 行为完全不变）：它只挡"整类端点被匿名调用"，**逐对象判定必须由处理器另行完成**
   * （见 {@link RouteAccess}）。
   */
  register(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    handler: RouteHandler,
    opts?: RouteAccessOptions,
  ): () => void

  /**
   * 注册请求前置钩子；返回注销函数（**幂等**，重复调用安全）。
   *
   * 钩子的执行位置与契约见 {@link RequestHook}。它存在的意义是给"身份解析 / 全局策略"
   * 一个**不依赖具体插件**的挂载点——否则每个插件都得自己解析一遍身份。
   *
   * 可选（`?`）以保持向后兼容：既有测试替身与第三方实现无需提供。
   */
  use?(hook: RequestHook): () => void
  /** 请求统计（看门狗探针数据源） */
  stats(): HttpRouterStats
  /** 进行中的路由请求数（路由处理器尚未结算；交接给静态资源层的请求不计入） */
  inflight(): number
  /**
   * 除"调用方自身请求"外的在途请求数：在请求处理器内部调用时扣除本次请求，
   * 在请求之外（如进程关停、看门狗）调用时等同 {@link inflight}。
   * 排空日志/告警以此为准，避免把管理请求自己算成"待等待的请求"。
   */
  pending(): number
  /**
   * 优雅排空（架构 §5.1）：等待进行中的请求全部结算，最多等待 timeoutMs 毫秒。
   * 插件卸载前由管理器调用，超时则由调用方强制卸载。
   * @returns 是否在时限内排空（false = 仍有请求在执行）
   */
  drain(timeoutMs: number): Promise<boolean>
  /**
   * 登记一个长连接响应（SSE 等）；返回注销函数（**幂等**，重复调用安全）。
   *
   * 语义与为什么必须单独登记：
   * - 长连接**不计入排空**（不出现在 {@link inflight} / {@link pending}）：排空等的是
   *   "路由处理器是否结算"，而长连接的处理器应当**同步返回**（当拍结算），连接随后由
   *   持有者继续写帧。若把长连接算进在途数，卸载插件时 drain() 会一直等到连接关闭，
   *   必然空转满 drainTimeout 并打印**假的**"排空超时"告警——本仓库曾因同类归因错误
   *   在 REST 卸载路径上稳定误报（见 server 包 router.test.ts 的回归用例）。
   * - 登记的价值在于让路由服务在**自身卸载/关停**时能主动结束这些连接，
   *   否则客户端会一直挂着等一个再也不会来的字节。
   * - 持有者若要按自己的生命周期收起连接，调用返回的注销函数即可（例如某插件卸载时
   *   先结束自己开的流，再注销）。
   *
   * @param owner **谁开的这条连接**（通常是插件名）。管理器在卸载该 owner 时据此定向回收
   *   （见 {@link closeStreams}），这样"插件卸载 → 它自己开的流被收掉"由路由服务兜底，
   *   而不是只依赖插件作者记得在自己的 dispose 里收流。
   *   **契约**：未登记 owner（省略或传空串）的连接**无法被定向回收**，只能等路由服务
   *   整体关停时被统一收掉——即"逃逸定向回收"是显式后果，不是静默行为。
   *
   * 可选（`?`）以保持向后兼容：既有测试替身无需立刻提供。
   */
  trackStream?(res: import('node:http').ServerResponse, owner?: string): () => void

  /**
   * 结束长连接：不传 `owner` 关闭**全部**（路由服务卸载/关停时用），
   * 传 `owner` 只关该 owner 开的那些（管理器在**卸载单个插件**时用）。
   *
   * 为什么要在服务接口上暴露 owner 形态：卸载是**管理器**发起的（REST /disable、
   * 启停回滚、disposeAll 共用 `unloadPlugin`），而长连接只有路由服务知道。若不上接口，
   * 管理器就得自己去翻插件的内部状态——那既越权也不可靠。
   *
   * 可选（`?`）以保持向后兼容。
   */
  closeStreams?(owner?: string): void

  /**
   * 上报"一次长连接请求因并发上限被拒"（用于可观测性，见 {@link HttpStreamStats.rejected}）。
   *
   * 并发上限是**持有者的策略**（例如 @geewiki/ai 的 MAX_CONCURRENT_STREAMS），
   * 路由服务不参与判定；故由持有者在拒绝时主动上报，集中计入 stats()，
   * 让运维能从 /api/health 看出"是否有人在被拒"。
   *
   * 可选（`?`）以保持向后兼容。
   */
  noteStreamRejected?(): void
}

/* ======================= 插槽（slot）契约与编辑器数据通道 ======================= */

/**
 * 宿主暴露给插件的**具名插槽**。
 *
 * 与前端 `@geewiki/web` 的 `lib/slots.tsx` 是**同一份白名单的两处镜像**（web 不能 import 本包：
 * core 顶层 `import 'node:fs'`，进不了浏览器 bundle）。两处必须一致——
 * manager 侧有源码级守卫测试钉住这一点（同 `PLUGIN_UI_FILE_SEGMENT` 的既有做法）。
 *
 * - `app-header` / `app-footer`：**零属性**插槽，可多方贡献（多）。
 * - `editor`：**带数据的单占用**插槽（见 {@link EditorSlotProps}）。
 */
export type SlotName = 'app-header' | 'app-footer' | 'editor'

/** 插槽白名单（顺序即文档顺序）。插件传未知名会被忽略并告警，不阻断激活。 */
export const SLOT_NAMES: readonly SlotName[] = ['app-header', 'app-footer', 'editor']

/**
 * 插槽的**占用基数**：`multi` 允许多个插件同时贡献，`single` 全局同一时刻只生效一个。
 *
 * 为什么需要它：`editor` 是"同一时刻只能有一个"的资源（两个编辑器同时渲染没有意义），
 * 而 `app-header`/`app-footer` 天然可叠加（多个插件各挂一个小部件）。
 * 光靠插件级 `conflictGroup` **不足以**表达这件事：
 * - `conflictGroup` 是**整个插件**级互斥，而某插件可能只是"顺便"贡献了 editor
 *   （主体功能是别的）——此时要求它跟别的编辑器插件互斥，会连带禁掉它的主体功能；
 * - 若两个 active 插件都不在同组却都贡献 `editor`，宿主必须能**确定性地**裁决并**可见地**
 *   报告冲突，而不是静默随便挑一个。
 * 故：`conflictGroup` 是**声明式**推荐做法（把互斥意图写进 manifest），
 * 基数裁决是**兜底**（作者忘了声明时的确定性行为 + 显式诊断）。
 */
export const SLOT_CARDINALITY: Readonly<Record<SlotName, 'single' | 'multi'>> = Object.freeze({
  'app-header': 'multi',
  'app-footer': 'multi',
  editor: 'single',
})

/**
 * `editor` 插槽的 props：**宿主唯一向插件传数据的通道**。
 *
 * ## 与"宿主不向插件传数据"的隔离裁决并存
 * 零属性插槽（`app-header`/`app-footer`）刻意不传任何数据，避免跨版本契约耦合，
 * 这条裁决**未被推翻**、也不应被推翻。但编辑器场景**本质上需要数据**——
 * 没有正文与保存回调，插件无法做编辑器。
 * 因此这里采取**显式窄契约**：类型在 core 里具名声明、字段逐个人工审定，
 * 插件只能拿到下面这几个字段，**拿不到任意宿主状态**。
 *
 * ## 为什么没有 `[k: string]: unknown` 逃生口
 * 索引签名会让"加字段"绕过类型审查，契约就会在无声明的情况下悄悄漂移；
 * 未来要加字段**必须显式改这个类型**，从而必然经过一次评审与版本考量。
 *
 * ## 演进约束
 * 加字段只允许**可选**（`?`）语义，以保证既有编辑器插件不被破坏。
 */
export interface EditorSlotProps {
  /** 当前正文 Markdown 源文（受控值：由宿主持有，插件只读 + 通过 onChange 回传） */
  readonly value: string
  /** `create` = 新建页面的空编辑器；`edit` = 编辑既有页面 */
  readonly mode: 'create' | 'edit'
  /**
   * 目标页面标识。`mode === 'create'` 时可能是**空串或尚未确定**的输入值
   * （新建态允许用户先写正文再定标识），插件不得假定它一定合法或非空。
   */
  readonly slug: string
  /** 只读预览（如查看历史快照、无编辑权限）：为 true 时插件应禁用编辑并隐藏保存入口 */
  readonly readOnly?: boolean
  /** 正文变更回传（宿主据此维护草稿/脏值判定） */
  onChange(next: string): void
  /** 请求保存（宿主负责校验、冲突检测与落库；插件不直接写数据库） */
  onSave(): void
  /** 请求取消编辑（宿主负责未保存确认） */
  onCancel(): void
}

/** 贡献插槽时的可选元信息 */
export interface SlotContributionMeta {
  /**
   * 标记为**懒加载贡献**：宿主首屏不必加载该插件的 UI 产物，
   * 直到真的要渲染该插槽时才去取 {@link SlotContribution.importPath}。
   *
   * 价值：编辑器插件往往体积不小（例如 CodeMirror 一类），而绝大多数访问
   * 只看文档、不进编辑态——懒加载把这份成本推迟到真正需要时。
   */
  lazy?: boolean
  /**
   * 懒加载时要请求的模块路径（相对**插件产物根**，如 `editor.js` 或 `chunks/editor.js`）。
   * 规则与静态资源层一致（`PLUGIN_UI_ASSET_PATH`：逐段 `[A-Za-z0-9][A-Za-z0-9._-]*`，≤16 段）。
   * `lazy: true` 而未给 `importPath` 时回退到该插件的 `client.entry`。
   */
  importPath?: string
}

/** 一条插槽贡献（注册表里的记录） */
export interface SlotContribution {
  readonly slot: SlotName
  /** 贡献者（插件名）。管理器在卸载该 owner 时定向注销（见 {@link SlotService.release}） */
  readonly owner: string
  /** 来源：manifest 声明（声明式，激活时自动登记）还是运行期 `contribute()`（命令式） */
  readonly via: 'manifest' | 'runtime'
  readonly lazy: boolean
  readonly importPath?: string
}

/**
 * 插槽服务（`ctx.get('slot')`）：插件声明与查询"我贡献了哪个插槽"。
 *
 * 为什么由**管理器**提供而不是单独一个插件：插槽贡献的归属与回收必须挂在
 * **插件生命周期**上（激活时登记、卸载时注销），而管理器正是生命周期与
 * 卸载统一出口（`unloadPlugin`）的持有者；另起一个插件反而要在两者间来回同步。
 *
 * 与 `HttpRouterService.trackStream(res, owner)` 的 owner 契约**同源**：
 * owner 由调用方显式传入、管理器据此定向回收。插件平台内的插件本就能执行任意代码，
 * 故 owner 不是安全边界，而是**归属与回收的记账依据**；
 * 冒用他人 owner 只会污染自己的记账（并可被 `list()` 立刻看出来）。
 */
export interface SlotService {
  /**
   * 登记一条插槽贡献。返回**幂等的注销函数**（重复调用安全）。
   *
   * 同一 `(owner, slot)` 重复登记视为**同一条**（后者可覆盖 `lazy`/`importPath`），
   * 不会产生重复项。
   *
   * @param owner 贡献者（插件名）。管理器按此在卸载时定向注销。
   * @param slot 插槽名；未在白名单内则忽略并告警（返回一个空操作的注销函数）
   */
  contribute(owner: string, slot: SlotName, meta?: SlotContributionMeta): () => void
  /** 列出贡献；不传 `slot` 列出全部（顺序稳定：先插槽白名单顺序，再 owner 字典序） */
  list(slot?: SlotName): readonly SlotContribution[]
  /** 某插槽的全部声明者（未按基数裁决，即"谁声明了"，用于诊断） */
  ownersOf(slot: SlotName): readonly string[]
  /** 注销某 owner 的**全部**贡献（管理器卸载统一出口调用，与 `closeStreams(owner)` 同风格） */
  release(owner: string): void
}
