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

/* 审计日志写入设施（`audit_log` 表，见 docs/design/access-control.md §3.4）。
   放在 core 是因为该表由 db 插件的迁移建立、属核心基础设施，而写入方横跨
   server（access.break_glass）与 plugin-auth（login.* / 口令变更）两个包。
   注意：`core` 顶层 `import 'node:fs'`，**本模块不得被前端包引入**（见 §9 R3）。 */
export {
  auditIpHash,
  redactForAudit,
  writeAuditLog,
  type AuditEntry,
  type AuditExecutor,
} from './audit.js'

/* SSE 帧协议与长连接生命周期（`./sse.ts`）。
   放在 core 的理由同 `./audit.ts`：**写入方横跨多个包**——本批起 `@geewiki/ai-qa`
   与 `@geewiki/ai-assistant` 都要写事件流，而终止闩锁 / 写前存活检查 / 双超时
   这几件事各写一份必然漂移，漂移的表现是**偶发挂死的连接**。
   本模块只 import type `node:http`，与 core 顶层一样**不得被前端包引入**。 */
export {
  createFrameWriter,
  createIdleWatchdog,
  encodeSseFrame,
  isTerminalEvent,
  validateFrameSequence,
  writeSseHead,
  MAX_CONCURRENT_STREAMS,
  SSE_EVENT_DELTA,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  SSE_EVENT_STATUS,
  STREAM_HARD_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  type FrameWriter,
  type SseFrame,
  type Watchdog,
} from './sse.js'

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
  /**
   * ★ F14：`apply()` 的结算上限（秒），默认 30；`<= 0` 表示**不超时**（逃生口）。
   *
   * 为什么需要一个上限：`apply` 是插件自己的代码，一个死循环或一个永不 settle 的
   * `await` 会让 `ctx.plugin()` **永远不返回**——而激活发生在**进程启动路径**上，
   * 后果是「进程既没起来、也没报错、也不退出」，日志停在上一个插件。
   * 这是最难远程诊断的一类故障：**没有任何错误可以看**。
   *
   * 与 `drainTimeout` 的区别：后者约束**卸载**（等在途请求结算），本项约束**加载**（等 apply 结算）。
   */
  applyTimeout?: number
}

/**
 * `geewiki.client`：插件**客户端 UI 入口**声明。
 *
 * 缺省 = 该插件没有前端界面，宿主不会加载它（也不会产生任何请求噪声）。
 * 与 `geewiki.entry` 的区别：后者是**后端**入口（index.ts 等），两者不可混用。
 */
export interface GeeWikiClient {
  /**
   * UI 入口的**相对路径**，相对该插件的 UI 根。缺省 `'client.js'`。
   *
   * ★ F13：可以是单段文件名（`client.js`）**或分层路径**（`ui/index.js`）。
   * 每一段必须以字母数字开头，故 `..` / 绝对路径 / 空段一律被拒（整体视为未声明 → 不加载）。
   * 判据见 {@link isPluginUiEntryPath}。
   */
  entry?: string
  /** 可选样式的相对路径（同 {@link GeeWikiClient.entry} 的规则）；缺省 = 不注入样式 */
  css?: string

  /**
   * ★ F13：补充说明 —— 入口同目录（及其子目录）下的其它资源**无需声明**即可被服务：
   * `/plugins-ui/<插件名>/<相对路径>` 直接映射到 UI 根，字体 / 图片 / wasm / sourcemap
   * 都走同一条通道（MIME 表已覆盖 `woff/woff2/wasm/map`，未知扩展名给
   * `application/octet-stream` 而**绝不**回退 `text/html`）。
   *
   * 所以这里**没有** `assets` 字段：声明一个"资源根"是多余的 ——
   * 资源根就是 UI 根本身，多一个字段只会多一处可以与实际产物不一致的地方。
   */
  // （无 assets 字段：见上）
}

/**
 * 插件页面路由 id 的语法（A2/F2）：小写 kebab，**不含 `/`**。
 *
 * 为什么不含 `/`：`id` 就是 hash 的**首段**（`#/<id>` 或 `#/<id>/<sub>`），
 * 与内置路由（`wiki` / `graph` / `org` …）落在同一个命名空间里，必须同构。
 * 子路径通过 `sub` 传给插件页面自己解析，不由 id 承载。
 */
export const PLUGIN_ROUTE_ID = /^[a-z][a-z0-9-]*$/

/**
 * **宿主保留**的路由首段（内置页面 + 旧路由 + 身份路由）。
 *
 * 插件**不得**声明这些 id：不是"先到先得"，而是**直接拒绝**——
 * 若允许顶替，一个插件就能用 `wiki` 覆盖知识库首页，那是最坏的一类事故
 * （用户以为自己在看自己的 wiki，实际是插件页面），且没有任何提示。
 * 这条与插槽的"自定义名必须含 `/`"是同一个思路：把宿主的命名空间与插件的切开。
 */
export const RESERVED_ROUTE_IDS: readonly string[] = [
  'wiki',
  'plugins', // 旧链接，在路由解析处改写成 graph
  'graph',
  'access', // 旧的权限治理路由（现为占位重定向页）
  'audit',
  'org',
  'login',
  'setup',
  'denied',
  'account',
  'notfound',
]

/**
 * 插件**声明式**的页面路由（manifest 的 `geewiki.routes`，F2 新增）。
 *
 * ## 为什么路由必须**声明在 manifest**，而不能只在客户端 bundle 里注册
 * 入口表靠"该插件有没有按需插槽"决定**要不要推迟加载它的产物**（见 `isLazyOnlyEntry`）。
 * 若路由只存在于 bundle 内部，宿主就无从知道"这个包的产物里有页面"，
 * 于是一个"只贡献了 `editor` 插槽 + 一个页面"的插件会被整个推迟——
 * **用户点它的导航项，页面是空的，且没有任何报错**（bundle 压根没加载过）。
 * 声明在 manifest 里，入口表就能据此把该插件标为"不可推迟"。
 *
 * ## 声明与注册的分工
 * - **声明**（本类型，manifest）：`id` / 导航元信息 / **是否存在路由**——宿主据此决定加载与导航；
 * - **注册**（客户端 `host.registerRoute(id, Component)`）：真实的页面组件。
 *
 * 两者由 `id` 对上。只声明不注册 ⇒ 该路由渲染成"插件页面未就绪"占位并告警，
 * **不会**变成 `notfound`（那会把"插件坏了"误导成"这个地址不存在"）。
 */
export interface PluginRouteDecl {
  /** 路由首段：{@link PLUGIN_ROUTE_ID}，且不得落在 {@link RESERVED_ROUTE_IDS}（或其它插件的声明）里 */
  readonly id: string
  /** 导航标签；不填则该路由**不进任何导航**（仍可被链接/书签访问） */
  readonly label?: string
  /**
   * 需要的能力键（与 `NavCapability` 同源，见 web 的 `lib/navPlan.ts`）。
   * 不填 = 对所有访问者可见（含未登录）。宿主按它过滤导航项与路由。
   */
  readonly requires?: string
  /**
   * 导航分组：`'main'` 与「知识库」平级；`'admin'` 收进「管理 ▾」。
   * 不填 = 不进导航（与不填 `label` 同效，两个字段必须同时给出才有导航项）。
   */
  readonly group?: 'main' | 'admin'
  /** 同组内排序权重（越小越前；缺省 100，排在宿主内置项之后） */
  readonly order?: number
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
   * ★ F15：**文案目录声明**（语言 → 相对插件目录的 JSON 文件路径）。
   *
   * 例：`{ "zh-CN": "locales/zh-CN.json", "en": "locales/en.json" }`。
   *
   * 为什么声明式而不是约定目录：宿主与插件**共用同一套键空间**（`host.*` / `plugin.<短名>.*`），
   * 而"哪些语言有译文"必须是可枚举的事实（`GET /api/i18n` 要据此列出可选语言）。
   * 约定一个 `locales/` 目录看着省事，但"有文件"与"声明了"在打包/换目录时会漂移，
   * 且发现流程要反推语言码（`zh-CN.json` 的文件名解析）。
   *
   * 路径必须落在插件目录内（`../` 会被拒绝）；文件内容必须是 `{键: 文案}` 的 JSON。
   */
  locales?: Record<string, string>
  /**
   * **声明本插件向哪些插槽贡献界面**（见 {@link SlotName}）。
   *
   * 与 `client` 的关系：`client` 声明"我有 UI 产物"，`slots` 声明"我要占用哪些位置"。
   * 声明后管理器在**激活时自动登记**为插槽贡献（`via: 'manifest'`），
   * 于是入口表能带上"哪个插件占了哪个插槽"，宿主据此决定要加载哪些 bundle
   * （配合 `ctx.get('slot').contribute(..., { lazy: true })` 可把编辑器一类大产物推迟到需要时）。
   *
   * ## 两种合法名字（A1 起）
   * - **内置插槽**（{@link BuiltinSlotName}，7 个，不含 `/`）：宿主的固定渲染点；
   * - **插件自定义扩展点**（含 `/`，语法见 {@link PLUGIN_SLOT_NAME}）：由某个插件用
   *   `ctx.get('slot').define()` 开的扩展点——本插件只是**往别人的扩展点里贡献**，
   *   不需要（也不应该）自己去 `define` 它。
   *
   * 两者都不是的名字会被**忽略并告警**，不阻断激活。注意这条**不是**"任意字符串都行"：
   * `app-headr` 这类内置名笔误会走到告警分支——放宽键空间没有牺牲拼写错误的可见性。
   *
   * 声明式优先：能用本字段表达的就不要用运行期 `contribute()`——
   * 前者可被静态检查、能在插件代码跑起来之前就进入入口表。
   */
  slots?: SlotName[]
  /**
   * **声明本插件提供的页面路由**（F2 新增，见 {@link PluginRouteDecl}）。
   *
   * 为什么必须声明在清单里：入口表据此把该插件的产物标为**不可推迟**——
   * 否则"只贡献按需插槽 + 一个页面"的插件会被整个推迟，用户点它的导航项会看到空白页
   * 且没有任何报错（详见 {@link PluginRouteDecl} 的说明）。
   *
   * `id` 不得落在 {@link RESERVED_ROUTE_IDS}，也不得与其它插件重复：冲突时**先激活者胜出**，
   * 后者整条声明被忽略并在 `GET /api/plugins/slots` 一类的诊断端点里可见（不静默顶替）。
   */
  routes?: PluginRouteDecl[]

  /**
   * ★ F9：本插件**声明**的能力名（`a/b` 命名空间，必须含 `/`）。
   *
   * 声明只是"我引入了这个名字"，**它的值由运行期 `capability-service.provide()` 注册的
   * 求解器给出**。声明了却没有注册求解器的插件会在激活后被 manager 告警 ——
   * 那是一个静默失效形态：该能力恒为 `false`，于是依赖它的导航项永远不出现、没有报错。
   *
   * 为什么不学 `slots` 那样让清单承担全部定义：能力的**值**必须是一个能看见
   * `Principal` 的同步函数，而清单是 JSON（外部插件的 `package.json#geewiki`）。
   * 把函数塞进清单不可能，硬凑（例如"角色名单"）会把判定逻辑变成一份配置副本。
   */
  capabilities?: CapabilityDecl[]

  /**
   * ★ F10：本插件声明会用到的**跨界能力**（文件系统 / 环境变量 / 外网 / 进程 / 密钥）。
   *
   * 宿主**不做强制**（同进程、同权限，见 `PluginPermission` 的说明）—— 它是**声明**：
   * 让"装这个插件前该看什么"变得可读、可查、可回归。值必须是
   * `PLUGIN_PERMISSIONS` 里的一项，未知取值会被**拒绝并告警**（不阻断激活）——
   * 静默接受未知串会让 `fs:raed` 这类拼写错误看起来像"声明过了"。
   *
   * 服务依赖（数据库/HTTP/LLM…）**不写在这里**：那些由 `requires` 表达。
   */
  permissions?: PluginPermission[]
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
  applyTimeout: number
}

/**
 * `apply()` 超时的缺省值（秒）。
 *
 * 30 秒是**刻意宽松**的：正常的 `apply` 只做「注册服务 + 挂路由」，量级是毫秒；
 * 迁移另有独立路径（`geewiki.migrations`，在 apply **之前**执行，不受本超时约束）。
 * 所以只有真正卡死的插件才会撞上这个上限——调小缺省值只会误伤冷启动抖动。
 */
export const DEFAULT_APPLY_TIMEOUT_SECONDS = 30

/** 由原始（可能缺省）运行期声明规范化：supportsHotReload 默认 false、drainTimeout 默认 5 秒、applyTimeout 默认 30 秒 */
export function normalizeRuntime(runtime?: GeeWikiRuntime): NormalizedRuntime {
  return {
    supportsHotReload: runtime?.supportsHotReload ?? false,
    requiresCachePurge: runtime?.requiresCachePurge ?? false,
    drainTimeout: runtime?.drainTimeout ?? 5,
    applyTimeout: runtime?.applyTimeout ?? DEFAULT_APPLY_TIMEOUT_SECONDS,
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

/*
 * ★ F13：UI 资产的路径规则（前缀 / 单段文件名 / 相对路径 / 入口路径 / 深度上限）
 * **已移到 `./domain.js`** —— 因为 `packages/web` 需要它们，而本模块顶层
 * `import 'node:fs'` **进不了浏览器 bundle**。
 *
 * 原先 web 侧的 `pluginUiPlan.ts` 自带 `PLUGIN_UI_FILE_SEGMENT` 与 `PLUGIN_UI_PREFIX`
 * 的**同名副本**，靠测试的同一张输入表钉住一致性 —— 那正是 `core/src/slots.ts` 文件头
 * 点名过的镜像问题（副本无法伪装成同一个对象，而"内容相等"在刚抄完时是通过的）。
 * F13 放宽入口路径时顺手把这几条规则归一到浏览器安全模块，副本一并删除。
 *
 * 这里**转出**以保持既有 `import { PLUGIN_UI_ASSET_PATH } from '@geewiki/core'` 可用。
 */
export {
  PLUGIN_UI_PREFIX,
  PLUGIN_UI_FILE_SEGMENT,
  PLUGIN_UI_ASSET_PATH,
  PLUGIN_UI_ASSET_MAX_DEPTH,
  isPluginUiEntryPath,
} from './domain.js'

/**
 * 缓存清理事件名（架构 §5.7）：插件停用/卸载后，若其 manifest 声明
 * `runtime.requiresCachePurge: true`，插件管理器经 cordis 事件总线广播本事件
 * （唯一参数为插件名）；持有派生缓存（索引、渲染结果、前端资源表等）的插件
 * 或宿主监听该事件后自行清理，避免卸载后残留陈旧数据。
 */
export const CACHE_PURGE_EVENT = 'geewiki/cache-purge'

/**
 * 页面保存事件名：`@geewiki/wiki` 在**一次真的写入了内容**之后广播。
 *
 * ## 契约（订阅者必须照办，否则会拖垮保存路径）
 * - **同步广播、不等待订阅者**（`ctx.emit`，不是 `ctx.parallel`）。理由与
 *   {@link CACHE_PURGE_EVENT} 恰好相反：缓存清理是"不等待就等于没清"，
 *   而"保存后顺手做点别的"（生成摘要、重建派生索引）**绝不能**让 `PUT /api/pages/:slug`
 *   的响应时间取决于一个模型调用有多慢。**保存的成败与快慢不得受订阅者影响**。
 * - 因此订阅者**必须自己吞掉全部异常**并自行安排异步工作（`void (async () => …)()`）。
 *   订阅者抛错会顺着 `ctx.emit` 冒回**保存端点**——一次成功的保存因此变成 500，
 *   而内容其实已经写进库了：这是最坏的一种失败（调用方重试，于是写两遍）。
 * - 同一个 slug 的**连续保存**可能密集发生（编辑器自动保存）。订阅者要自己合并，
 *   平台不做去抖——去抖策略是业务（等 500ms 还是 5s，取决于生成一次要多少钱）。
 *
 * ## 为什么这个事件不叫 `page-saved` 而带上仓库前缀
 * 与 {@link CACHE_PURGE_EVENT} 同因：cordis 事件总线是**全局**的，
 * 第三方插件也可能在同一个 `Context` 上监听。名字带 `geewiki/` 前缀是命名空间。
 */
export const PAGE_SAVED_EVENT = 'geewiki/page-saved'

/**
 * {@link PAGE_SAVED_EVENT} 的负载。
 *
 * **刻意不含正文**：正文体积大且属于"要经过权限判定才能读"的东西，
 * 而事件是**广播**——所有订阅者都会收到，包括那些本不该看到这一页正文的插件。
 * 需要正文的订阅者应当拿 `slug` 经 `wiki-service` 带主体去读（读路径只有一条）。
 *
 * `outcome` 里**没有 `'unchanged'`**：内容与标题都没变时不会广播。
 * 这不是优化，是语义——"保存了但什么都没变"不该触发一次摘要重算（那要花钱）。
 */
export interface PageSavedEvent {
  readonly slug: string
  /** 保存**之后**的标题 */
  readonly title: string
  /** 保存**之后**的 `updated_at`（订阅者用它判"我手上那份是不是这一版的"） */
  readonly updatedAt: string
  /** 保存的类别；`unchanged` 不会出现在这里（见上） */
  readonly outcome: 'created' | 'updated'
  /** 触发者 userId；跨插件调用或导入脚本为 `null`（与 `page_versions.author_id` 同口径） */
  readonly actorId: number | null
}

/* ==================== F7：平台事件契约 ==================== */
/*
 * ## 为什么要有这一节（而不是让每个插件自己约定事件名）
 * cordis 的事件总线**早就在用**（`ctx.on` / `ctx.emit` / `ctx.parallel`），缺的从来不是机制，
 * 而是**契约**：在此之前全仓只有两个平台事件（缓存清理、页面保存），于是插件想响应
 * "页面被删了""有人登录了"只能去轮询或改宿主源码。这一节把那些**本来就需要**的钩子
 * 定义成公共契约。
 *
 * ## 三条对**所有**订阅者都成立的规则（每条都有对应的既有事故）
 *
 * ① **一律 `ctx.emit` 同步广播，不等待订阅者**（`ctx.parallel` 只用于缓存清理）。
 *    理由：这些事件的发射点全在**用户操作的同步路径**上（保存、登录、搜索）。
 *    让响应时间取决于某个订阅者有多慢（甚至一次模型调用），
 *    等于让"保存页面"的延迟由第三方插件的实现质量决定。
 *
 * ② **订阅者必须自己吞掉全部异常**，并自行安排异步工作（`void (async () => …)()`）。
 *    订阅者抛错会顺着 `ctx.emit` 冒回**发起端点**——一次成功的保存因此变成 500，
 *    而内容其实已经写进库了：调用方重试 ⇒ 写两遍。这是最坏的一种失败，
 *    所以"吞异常"是订阅者的**义务**，不是风格建议。
 *
 * ③ **负载里不放正文/凭据**。事件是**广播**：所有订阅者都会收到，包括本不该看到
 *    这一页内容的插件。需要正文的订阅者应当拿 `slug` 经 `wiki-service` **带主体**去读
 *    （读路径只有一条，权限判定也只在一处）。
 *
 * ## 命名空间
 * 全部带 `geewiki/` 前缀：cordis 总线是**全局**的，第三方插件可能挂在同一个 `Context` 上。
 */

/**
 * 页面**新建**（`PageSavedEvent` 的 `outcome === 'created'` 是"保存并创建"，
 * 本事件是它更窄、更明确的形态，供只关心"新页面出现"的订阅者使用）。
 * 负载与 {@link PAGE_SAVED_EVENT} 同形（复用 {@link PageSavedEvent}）。
 */
export const PAGE_CREATED_EVENT = 'geewiki/page-created'

/**
 * 页面**删除**。负载**只有标识**——被删页面的正文已经不存在，订阅者若缓存过它需据此失效。
 */
export const PAGE_DELETED_EVENT = 'geewiki/page-deleted'

/*
 * ## 刻意**没有** `page-renamed`
 *
 * 契约里曾经起草过它，但落地时发现：**wiki 根本没有"重命名页面"这个操作**
 * （slug 是页面身份，改名通过"另存为新页 + 删旧页"完成，那会分别触发 created 与 deleted）。
 *
 * 定义一个没有任何发射点的事件，正是本仓库在别处已经记过的那条教训——"**谎报的 token**"：
 * 订阅者会照它写代码、测试会通过、线上永远不触发，而作者以为功能已经接上。
 * 所以宁可现在不提供：等真的有了重命名流程再加，届时它才是可信的。
 */

/**
 * 用户**登录成功**（本地口令或 SSO 都走这一个）。
 *
 * ⚠️ 负载**不含任何凭据**（口令、会话 id、token 一律没有）：事件是广播的。
 * `method` 只说"走的是哪条路"，用于审计与差异化提示，不能用来做安全判定。
 */
export const USER_LOGIN_EVENT = 'geewiki/user-login'

/** 一次**检索被真正执行**（用于使用统计/热词；不含结果集，避免订阅者误把广播当缓存） */
export const SEARCH_PERFORMED_EVENT = 'geewiki/search-performed'

/** 附件**上传完成**（用于派生索引/缩略图/病毒扫描一类后处理） */
export const ATTACHMENT_UPLOADED_EVENT = 'geewiki/attachment-uploaded'

/**
 * 插件**激活完成**（诊断与"依赖我的人该醒了"）。
 *
 * ⚠️ 发射时机是"该插件的 `apply` 已结算"——正是 `provide` 可见性陷阱（core 的 `SlotService`
 * 注释里有实测记录）被解开的那一刻。**在此之前**订阅者去 `ctx.get()` 该插件提供的服务
 * 仍会拿到 `undefined`，所以本事件也是"依赖方延迟绑定"的正规触发点。
 */
export const PLUGIN_ACTIVATED_EVENT = 'geewiki/plugin-activated'

/** 插件**停用完成**（其贡献与长连接已回收）；订阅者据此清理自己缓存的该插件数据 */
export const PLUGIN_DEACTIVATED_EVENT = 'geewiki/plugin-deactivated'

/** {@link PAGE_DELETED_EVENT} 的负载 */
export interface PageDeletedEvent {
  readonly slug: string
  /** 触发者 userId；系统/脚本为 `null` */
  readonly actorId: number | null
}

/** {@link USER_LOGIN_EVENT} 的负载。**不含凭据、也不含会话标识**（见事件本身的说明）。 */
export interface UserLoginEvent {
  readonly userId: number
  /** 登录通道；`method` 只用于审计与提示，**不得**用于安全判定 */
  readonly method: 'password' | 'oidc' | 'session'
}

/** {@link SEARCH_PERFORMED_EVENT} 的负载 */
export interface SearchPerformedEvent {
  readonly query: string
  /** 命中数。**不放结果集**：它是广播，订阅者不该把它当缓存用 */
  readonly hits: number
  readonly actorId: number | null
}

/** {@link ATTACHMENT_UPLOADED_EVENT} 的负载 */
export interface AttachmentUploadedEvent {
  /** 内容寻址的附件 id（sha256 十六进制） */
  readonly id: string
  readonly slug: string
  /** 原始文件名（仅用于展示/派生，不得用于拼路径） */
  readonly name: string
  readonly size: number
  readonly mime: string
  readonly actorId: number | null
}

/** {@link PLUGIN_ACTIVATED_EVENT} / {@link PLUGIN_DEACTIVATED_EVENT} 的负载 */
export interface PluginLifecycleEvent {
  readonly name: string
  /** 该插件声明的能力 token 集合（`provides`），订阅者据此判断"我要的那个服务是不是来了" */
  readonly provides: readonly string[]
  /** 激活/停用是否成功（失败时 `error` 给出摘要；成功为 undefined） */
  readonly error?: string
}


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
  /**
   * ★ F9：这条路由还要求某个**能力**（内置的或插件声明的）。
   *
   * 与 `access` 是**两层**，不是二选一：`access` 回答"至少是什么身份"（匿名/已登录/管理员），
   * `capability` 回答"具备不具备这个具体能力"。两者都通过才放行。
   *
   * 用途：插件为自己的 API 端点声明一个自定义能力（例如 `review/approve`），
   * 而**判定权仍在它自己手里** —— 它通过 `capability-service.provide()` 注册求解器
   * 决定"谁算有"。宿主只负责在进入处理器**之前**拦下不具备的主体。
   *
   * ⚠️ 与 `access` 一样，这是**粗粒度**闸门，**不能替代**逐对象判定
   * （"这个人能不能改这一条"仍归 policy-service）。
   */
  capability?: CapabilityName
  /**
   * ★ F12：**登记方**（通常就是插件名）。可选，缺省 = 不做归因。
   *
   * 存在的理由：`router.register()` 由各插件在自己的 `apply` 里直接调用，而路由服务
   * 拿不到"当前是谁在注册"（`ctx.get('http')` 对所有调用方返回同一个对象）。
   * 于是按插件归因请求量只能靠**自觉声明**。
   *
   * ⚠️ 它是**可观测性**字段，不是安全边界：插件可以填别人的名字。宿主用它做
   * 计数与排障，**不用它做任何判定**。
   */
  owner?: string
}

/**
 * ★ F11：一条已注册路由的只读快照（`HttpRouterService.routes()` 的元素）。
 *
 * 刻意**不含处理器**：它是给审计与诊断用的，不该成为"能拿到别的插件的处理器"的入口。
 */
export interface HttpRouteInfo {
  readonly method: string
  /** 注册时的原始路径（含 `:param` 段），与调用点逐字一致 */
  readonly path: string
  readonly access: RouteAccess
  readonly capability?: CapabilityName
  /**
   * 调用方是否**显式**给了 `access`（哪怕给的就是 `'public'`）。
   *
   * 这是审计的判据：`access: 'public'` + `explicit: false` = "作者没想过这件事"，
   * 需要被点名；`explicit: true` = "作者明确选择了公开"，属已评审的决定。
   */
  readonly explicit: boolean
  /** ★ F12：登记方（见 `RouteAccessOptions.owner`）；未声明时缺省 */
  readonly owner?: string
}

/** ★ F12：按登记方聚合的请求计数（用于发现"哪个插件在被打"） */
export interface RouteOwnerStats {
  readonly owner: string
  /** 该 owner 名下**已注册路由**的条数（不是历史上注册过的条数） */
  readonly routes: number
  /** 命中该 owner 名下路由的请求数（含被闸门拒绝的） */
  readonly requests: number
}

/**
 * ★ F11：从路由快照里挑出**没有显式声明访问等级**的那些 —— 纯函数，便于单测。
 *
 * 为什么"没写"值得单独拎出来：省略第 4 参与写 `{ access: 'public' }` 在运行期**完全等价**，
 * 但在意图上完全不同 —— 前者多半是"作者没想过"，后者是"作者决定了公开"。
 * 默认值把这两者抹平成同一个东西，于是评审看不见风险，运行期也没有痕迹。
 *
 * 注意这里**不**把公开路由判为错误：公开本身是很多端点的正确选择（登录、健康检查、
 * 匿名可见的读接口）。它判的是"**未经声明**的公开"，也就是"没人明确负责的那部分"。
 */
export function unauditedRoutes(routes: readonly HttpRouteInfo[]): readonly HttpRouteInfo[] {
  return routes.filter((r) => !r.explicit)
}

/**
 * ★ F12：一条**插件健康探针**的结论。
 *
 * 为什么需要它：插件"激活成功"只说明 `apply()` 没抛错，**不说明它现在是好的** ——
 * 模型供应商连不上、迁移漏了一张表、外部 API 挂了，这些都发生在激活之后。
 * 没有探针时，运维只能从用户的报错里反推是哪个插件坏了。
 *
 * `ok: false` 表示**该插件自认降级**（而不是"探测失败"）：探测本身失败/超时是宿主
 * 填的结论（见 `PluginHealthReport.timedOut` / `.error`），两者必须可区分 ——
 * "插件说它坏了"与"我们没能问到它"指向完全不同的处置动作。
 */
export interface PluginHealth {
  readonly ok: boolean
  /** 面向人的一句话说明；`ok: false` 时**应当**给出，否则运维拿不到下一步线索 */
  readonly detail?: string
  /** 可选的机器可读细节（版本、上游地址、缺失项…）。**不要放凭据**——它会进 REST 响应 */
  readonly info?: Readonly<Record<string, unknown>>
}

/** ★ F12：聚合后的单插件健康结论（宿主在探针结论之上补齐的字段） */
export interface PluginHealthReport {
  readonly name: string
  /** 插件的运行态（只有 `active` 的插件才会被探测） */
  readonly state: 'active' | 'inactive' | 'error'
  /** 探针结论；未提供探针时为 `undefined`（**不等于不健康** —— 见下） */
  readonly health?: PluginHealth
  /** 探针超时（宿主判定，与插件自报的 `ok:false` 是两件事） */
  readonly timedOut?: boolean
  /** 探针抛错或返回形态非法（宿主判定）；`ok:false` 由插件自报，两者不混用 */
  readonly error?: string
  /** 探测耗时（毫秒）。用于发现"能返回但慢得离谱"的探针 */
  readonly durationMs?: number
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
 * 6. **适用边界：只对"匹配到的路由"执行。** 未匹配的 `/api/*` 路径（走路由的 API 404）、
 *    静态资源与 SPA fallback **完全不经钩子**——它们在 dispatch 里同步返回、根本不进入钩子链。
 *    这是刻意的（静态层不该被身份系统拖住），但意味着**钩子不构成"全局鉴权"**：
 *    在此注册会话解析时，别以为"所有请求都已经过这里"。
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
   * ⚠️ **它不是"全局中间件"**：钩子只对**匹配到的路由**执行，未匹配的路径、静态资源与
   * SPA fallback 都不过钩子（详见 {@link RequestHook} 第 6 条）。把会话解析挂在这里时，
   * 别把"过了钩子"当成"整站已鉴权"。
   *
   * 可选（`?`）以保持向后兼容：既有测试替身与第三方实现无需提供。
   */
  use?(hook: RequestHook): () => void
  /**
   * ★ F11：**枚举当前已注册的全部路由及其访问等级**（只读快照，诊断用）。
   *
   * 存在的理由是一个**默认值太宽松**的问题：`register()` 的第 4 参可省，省略即
   * `access: 'public'`（匿名可调）。全仓几十个调用点于是全靠作者自觉 —— 而"忘了写"
   * 与"故意公开"在源码里长得一模一样，**评审时看不出来**，运行期也毫无痕迹。
   *
   * 有了这个枚举，就有两件事可做（都已在实现里落地）：
   * 1. 启动时把**未显式声明**的路由聚合成一条告警（`GEEWIKI_STRICT_ROUTE_ACCESS=1` 时直接拒启）；
   * 2. 测试里对**全量默认路由**做审计，把"哪些路由是公开的"变成一份**显式、可评审的清单**
   *    —— 新增一条公开路由必须同时改那份清单，于是它一定会出现在 diff 里。
   *
   * `explicit` 是这里的关键字段：它区分"作者写了 `{ access: 'public' }`"与"作者什么都没写"。
   * 没有它，审计就无从谈起 —— 两种情况的 `access` 都是 `'public'`。
   *
   * 可选（`?`）以保持向后兼容：既有测试替身与第三方实现无需提供。
   */
  routes?(): readonly HttpRouteInfo[]
  /**
   * ★ F12：按登记方（`RouteAccessOptions.owner`）聚合的请求计数。
   *
   * 只统计**声明了 `owner`** 的路由 —— 未声明的一律归入不出现的"未归因"桶，
   * 而不是硬塞给某个插件。这一点是刻意的：错误归因比没有归因更危险
   * （会让运维去查一个根本无关的插件）。
   *
   * 可选（`?`）以保持向后兼容。
   */
  ownerStats?(): readonly RouteOwnerStats[]
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
   * 并发上限是**持有者的策略**（例如 @geewiki/ai-qa 的 MAX_CONCURRENT_STREAMS），
   * 路由服务不参与判定；故由持有者在拒绝时主动上报，集中计入 stats()，
   * 让运维能从 /api/health 看出"是否有人在被拒"。
   *
   * 可选（`?`）以保持向后兼容。
   */
  noteStreamRejected?(): void
}

/* ======================= 插槽（slot）契约 ======================= */

/**
 * 插槽白名单的**单一真源**在 `./slots.ts`。
 *
 * 为什么单独一个文件：它要同时被后端（manager 登记/裁决）与**浏览器**（web 渲染
 * `<SlotOutlet>`）消费，而本文件顶层 `import 'node:fs'` 进不了浏览器 bundle。
 * 改造前前端为此手抄了三份镜像（`web/src/lib/slots.tsx`、`pluginUiPlan.ts`、
 * `SINGLE_OCCUPANCY_SLOTS`），靠两处源码级正则守卫钉住；现在前端直接
 * `import from '@geewiki/core/slots'`（见 `packages/core/package.json` 的 `exports`）。
 *
 * 这里保留 `export *` 转出，使既有的 `import { SLOT_NAMES } from '@geewiki/core'`
 * 调用点（manager 等）行为完全不变。
 *
 * `SlotName` / `SlotDeclaration` 另被本文件下方的 `GeeWikiManifest` 与 `SlotService`
 * 直接用到，故必须再以 `import type` 引入**本地作用域**——`export *` 只转出、
 * 不会把名字带进本文件作用域。
 */
import type { CapabilityDecl, CapabilityName, PageVisibility, PluginPermission } from './domain.js'
import type { SlotDeclaration, SlotName } from './slots.js'

export * from './slots.js'
export * from './services.js'
export * from './llm.js'
export * from './domain.js'


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

  /*
   * ★ F5：以下五个是**可选**能力，把原先"只有内置编辑器才有"的四项补齐，
   * 使插件编辑器替换内置编辑器时**不再静默丢功能**（审计报告 B3）。
   *
   * 三条设计口径：
   * 1. **全部可选且宿主编排**：插件负责交互，网络请求/鉴权/缓存/错误文案仍在宿主
   *    （与 `editor-toolbar` 的既有分工一致）。缺省即"宿主此刻没提供这项"，插件据此
   *    隐藏对应入口 —— 而不是拿到一个什么都不做的假函数（那类"看起来能点、点下去没反应"
   *    的错位正是本仓库反复记档的缺陷）。
   * 2. **能力缺失用 `undefined` 表达，不用空实现**：与 `EditorToolbarSlotProps.insertAtCursor`
   *    同一裁决。
   * 3. **不引入第二套保存路径**：这些都不碰正文落库，`onSave` 仍是唯一保存入口。
   */
  /**
   * 上传附件（粘贴截图 / 拖入文件由插件的编辑区接住，真发请求的是宿主）。
   * 返回**可直接插入正文的 Markdown 片段**（宿主已按附件规则拼好），插件按自己的光标语义插入。
   *
   * 页面尚未保存等前置不满足时宿主**抛错**（而非静默返回空数组）——
   * 静默会让"粘贴了截图但什么都没发生"变成无解释的失败。
   */
  onUploadFiles?(files: File[]): Promise<string[]>
  /**
   * 段落档位上下文：当前页面档位，供编辑器提示"块档位**不能宽过**页面档位"。
   *
   * `pageVisibility` 为 `null` 表示"此刻还不知道"（如新建页面尚未保存），
   * 与"页面是 public"是两回事，插件不得把 `null` 当作最宽松档。
   */
  blockTiers?: { readonly pageVisibility: PageVisibility | null } | null
  /**
   * 「授权给谁…」：把**光标所在的那一段**交给宿主去管理例外授予。
   *
   * 为什么由宿主执行而不是插件自己发请求：鉴权/缓存/错误文案都在宿主；
   * 插件交出去的 `{ ordinal, excerpt }` 里 `ordinal` 与服务端 `parseBlocks` 同序（有镜像守卫），
   * 宿主据此换到服务端的块 id。
   *
   * 缺了它，作者把一段设成"需单独授权"之后**再没有任何界面能放人进来**（B3 点名的静默丢功能）。
   */
  onManageBlockGrants?(block: { readonly ordinal: number; readonly excerpt: string }): void
  /**
   * 选区变化上报（**可选**：插件编辑器愿意报就报，不报则宿主认为"选区未知"）。
   *
   * 宿主订阅它的唯一目的是**点亮 `editor-toolbar` 里依赖选区的动作**；
   * 即使上报了，写回通道仍由 {@link EditorSlotProps.onEditorHandle} 决定，
   * 两者独立 —— 只知道选区而无法写回时，工具栏应把"采纳"类动作保持禁用。
   */
  onSelectionChange?(selection: EditorToolbarSelection | null): void
  /**
   * 交出编辑器**命令式句柄**，让宿主把它转给 `editor-toolbar` 插槽的写回通道。
   *
   * 这是"插件编辑器能被其它插件的工具栏写入"的唯一路径：宿主自己不知道插件编辑器的
   * 光标在哪，只有插件能实现它。传 `null` = 撤销（卸载/切换时）。
   *
   * **不实现它不构成缺陷**：此时工具栏拿到的 `insertAtCursor`/`replaceSelection` 是
   * `undefined`，插件按既有约定禁用写回并说明原因（诚实留空，优于假函数）。
   */
  onEditorHandle?(handle: EditorHandle | null): void
}

/**
 * ★ F5：编辑器**命令式写回**的最小契约（{@link EditorSlotProps.onEditorHandle} 的形状）。
 *
 * 刻意只有两个方法：它们正是 `editor-toolbar` 插槽已经在消费的两个写回通道，
 * 多一个都是没有消费方的新接口。语义与内置编辑器（CodeMirror）对齐：
 * - `insertAtCursor` 有选区时**替换**选区（与 `replaceSelection` 同语义）；
 * - 两者都必须走编辑器自己的输入事务，从而**一次撤销**可回退（不得直接改 DOM）。
 */
export interface EditorHandle {
  /** 在光标处插入（有选区时替换选区） */
  insertAtCursor(text: string): void
  /** 替换当前选区；返回是否确实替换（无选区/只读时返回 false，而不是静默无效） */
  replaceSelection(text: string): boolean
  /**
   * **整篇替换**文档内容（AI 回退用：把草稿还原到某一轮之前）。
   *
   * 为什么必须是"整篇"而不是"再插一段"：回退的语义是**回到那个状态**，而两次 AI 写入之间的
   * 草稿差异不是一段可插入的文本（模型可能删、可能改、可能重排）。用插入去模拟回退只会让草稿
   * 越来越长、且永远回不到原样。
   *
   * **可选**：插件编辑器可以不实现 —— 此时 AI 回退在该编辑器上**不可用**，
   * `registerEditorTools` 相应地不登记那条工具（能力不存在就不登记，仍优于给一个无效实现）。
   * 实现了就必须走编辑器自己的输入事务，让"回退"本身也可一次撤销。
   */
  setDoc?(text: string): void
}

/** 编辑页选区（{@link EditorToolbarSlotProps.selection}）：`from`/`to` 是文档内 0 基字符偏移 */
export interface EditorToolbarSelection {
  readonly text: string
  readonly from: number
  readonly to: number
}

/**
 * `editor-toolbar` 插槽的 props。
 *
 * ## 为什么不塞进 `EditorSlotProps`
 * `editor` 是**单占用替换位**（插件编辑器与内置编辑器二选一），而工具条是**叠加位**：
 * 内置编辑器在场时它必须能用，插件编辑器在场时它也必须还在（能力降级但要可见）。
 * 两种占用形态混在一个 props 里，编辑器插件就会被迫处理与它无关的字段。
 *
 * ## 写回通道的"有无"就是能力声明本身
 * `insertAtCursor` / `replaceSelection` **刻意做成可选**：`editor` 插槽被插件编辑器占住时，
 * 宿主**没有**写回通道（`EditorSlotProps` 里没有插入语义，见其"演进约束"），此时这两个字段
 * 是 `undefined` 而不是"一个骗人的空函数"——插件据此禁用写回按钮并说明原因。
 * 用可选字段表达"能力不存在"，比另加一个 `canInsert: boolean` 再加一对永远存在的函数更诚实。
 */
export interface EditorToolbarSlotProps {
  /** 与 {@link EditorSlotProps.mode} 同义：`create` = 新建态，`edit` = 编辑既有页面 */
  readonly mode: 'create' | 'edit'
  /** 目标页面标识；`create` 态可能为空串，插件不得假定它合法 */
  readonly slug: string
  /** 当前正文全文（`summarize` 一类动作需要整篇；随每次键入更新） */
  readonly docText: string
  /** 无选区时为 `null`（多数动作此时应回退到"作用于全文/光标前文本"，由插件自己定策略） */
  readonly selection: EditorToolbarSelection | null
  /** 宿主正在保存等：为 true 时插件应禁用会产生写回的动作 */
  readonly readOnly?: boolean
  /** 在光标处插入；**无写回通道时不存在**（见类型级说明） */
  insertAtCursor?(text: string): void
  /** 替换当前选区；**无写回通道时不存在** */
  replaceSelection?(text: string): void
}

/**
 * `app-dock` 插槽的 props：**常驻底部输入条**（决策 1 / 17）。
 *
 * ## 为什么它需要 `page` 上下文（这是用户需求 ② 的落点）
 * 需求原文是"**既能针对当前页面内容回答，也能自行找其他页面**"。前者要求模型知道
 * "当前是哪一页"——而路由真源在宿主，插件拿不到，所以必须由宿主传。
 *
 * 注意 `page` 是 **`null` 合法的**：列表页、图谱页、管理台都不对应某一篇文章。
 * 插件**不得**把 `null` 当成错误，也不得回落到"上一次的 slug"——那是把陈旧上下文
 * 当成当前上下文，比没有上下文更糟。
 *
 * ## 为什么不给它 `query` / `onAsk`（原先的 `wiki-ask` 有这两样）
 * 被拆掉的 `wiki-ask` 挂在一条路由上，`query` 从 hash 来；`app-dock` **不挂路由**，
 * 渲染点在 `App.tsx` 的 `<main>` 之外 ⇒ **切页不重挂**，会话状态天然存活（决策 9）。
 * 这正是不给它 `query` / `onAsk` 的原因：对话的"当前问题"是组件内部状态，不是路由状态。
 * - 会话历史归插件（决策 12：浏览器本地存近 10 段），宿主一概不管。
 *
 * ## 为什么 `invokeTool` 的权限判据在宿主而不在插件
 * 客户端工具（`editor.*` 一类）要在浏览器里执行，但**"哪些工具可调用"不能由调用方说了算**。
 * 宿主登记的才是可调用的：`invokeTool` 对未登记的名字**必须拒绝**。这条与
 * `pluginUi.ts` 的宿主包装拒绝注册未生效插槽是同一条规则（见设计文档 §3.3 的安全红线）。
 */
export interface AppDockSlotProps {
  /**
   * 当前页面上下文；`null` = 当前视图不对应某一篇文章（列表 / 图谱 / 管理台）。
   *
   * `kind` 让插件能区分"正在读"与"正在编辑"——两者的合理动作不同
   * （编辑态才有选区可改，阅读态才有正文可问）。
   */
  readonly page: {
    readonly slug: string
    /*
     * ★ 只有两种取值（对设计文档 §3.4 草图的收窄，P3 补齐）。
     *
     * 草图写的是 `'view' | 'edit' | 'list' | 'search' | 'graph' | 'admin'` 六个值，而
     * **宿主实际只产出这两种**（`packages/web/src/lib/dockPlan.ts` 的 `pageContextOf`，
     * 该文件头记着收窄的理由）：非页面视图一律给 `page: null`。
     *
     * 这里曾经留着六个值 —— 那不是"为将来预留"，而是**契约比实现对得宽**：
     * 插件会为永不出现的 kind 写分支，而那些分支没有任何办法被测到。
     * 同一份事实在 `packages/web/src/lib/slots.tsx` 有镜像，逐字段比对由
     * `packages/web/test/slotPropsMirror.test.ts` 钉住 —— 两侧必须一起改。
     *
     * 为什么列表页不能给 `'list'`：它没有"当前页"，只能填一个空 slug，而插件
     * **无法区分那个空 slug 与"宿主把 page 传丢了"**。`null` 是唯一诚实的表达。
     */
    readonly kind: 'view' | 'edit'
  } | null
  /**
   * 当前**可**调用的客户端工具名（宿主收集自插件经 `registerTool` 的登记）。
   *
   * 为什么要把这份名单下发给插件：无状态轮次协议里，客户端要告诉服务端"我这边有哪些工具"
   * （见设计文档 §3.3），而那份名单必须来自宿主登记，不能由插件自己拼——
   * 否则"伪造一个未声明的客户端工具名"就成了一条扩权路径。
   */
  readonly clientTools: readonly string[]
  /**
   * 当前登录用户的 id；`null` = 未登录（此时宿主**不会**渲染本插槽）。
   *
   * 为什么身份要由宿主下发、而不是让插件自己去问 `GET /api/auth/me`：
   * 插件据此给**本地会话存储**分键（设计文档 §0.3/决策 12：按用户隔离，
   * 共享浏览器上 A 的对话不该被 B 读到）。若让插件自己查，它就得在挂载时多发一次请求，
   * 且那份身份与宿主渲染它时的身份**可以不一致**（换账号的瞬间）——
   * 而"不一致"在这里的表现是**把上一个用户的对话写到新用户键下**，没有任何报错。
   *
   * 类型是 `number | null` 而不是可选：`null` 明确表示"没有身份"，
   * 字段缺失则表示"宿主忘了传"——后者必须由类型挡住（插件无从区分二者）。
   */
  readonly userId: number | null
  /** 打开某个页面（宿主路由；插件不拼 hash 字符串） */
  openPage(slug: string): void
  /**
   * 执行一个**宿主已登记**的客户端工具。未登记的名字必须拒绝（返回 rejected 的 Promise）。
   *
   * 返回 `unknown` 而不是泛型：调用方是持有字符串名字的插件，能拿到的只有"某个结果"。
   */
  invokeTool(name: string, args: unknown): Promise<unknown>
}

/**
 * `article-summary` 插槽的 props：**文章顶部的折叠摘要位**（用户需求 ④）。
 *
 * ## 为什么只有两个字段
 * 摘要的**内容、生成时间、是否过期、可不可用**全部由插件的服务端回答——
 * 宿主一个都不知道，也不该知道。宿主掌握的只有两件事实：**这是哪一页**、**它叫什么**。
 *
 * 这与 `AppDockSlotProps` 的分工完全一致：宿主给**它自己才有的事实**（路由、身份、
 * 已登记的客户端工具），插件给自己领域内的事实。若在这里塞一个 `summary` 字段，
 * 就等于把"取摘要"这件事从插件搬到宿主，而这个插槽的整个意义是**摘要归插件**。
 *
 * ## `slug` 为什么不能省
 * 插件要靠它去问自己的端点"这一页的摘要是什么"。让插件自己从 `location.hash` 解析
 * 是被**守卫测试明确禁止**的（`packages/web/test/pluginUi.test.ts` 扫产物字节）：
 * 路由表是宿主资产，插件解析 hash 会在路由规则变化时静默失效（解析不出 slug 时
 * 最自然的写法是"当作没有当前页"⇒ 摘要在所有页面上都不出现，且没有报错）。
 *
 * ## `title` 为什么也传（虽然插件能从正文里取）
 * 折叠态要显示的不只是"摘要"两个字——一个只有图标和"摘要"二字的折叠条，
 * 读者无法判断值不值得展开。给标题是为了让折叠态**自己说清这是谁的摘要**，
 * 而标题的权威来源是宿主正在渲染的那一份（可能与库里最新的一版不同：编辑预览态）。
 */
export interface ArticleSummarySlotProps {
  /** 当前文章 slug（宿主路由的真源；插件不得自行解析 hash） */
  readonly slug: string
  /** 当前文章的标题（宿主此刻渲染的那一份） */
  readonly title: string
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
 * **归属曾经写错过，别再改回去**：这里原先记的是"由管理器在自己的 `apply` 里 provide，
 * 因为管理器是生命周期与卸载统一出口的持有者"。**那个推理是错的**——在一个插件 `apply`
 * 尚未结算时 `provide` 的服务，对它在此期间创建的子插件不可见，而 `boot()` 恰好在管理器的
 * `apply` 内部激活各插件，于是外部插件 `ctx.get('slot')` 拿到 **undefined** 并**静默跳过**自己的
 * 运行期贡献（与"本来就没贡献"完全无法区分）。现在提供者是**独立插件**且排在管理器之前
 * （`packages/manager/src/slot-plugin.ts`，那里记着实测证据与机制）；管理器只保留生命周期语义
 * （按 manifest 登记、按 owner 回收）。注册表仍**全进程一份**。
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
   * @param slot 插槽名：内置插槽（{@link BuiltinSlotName}）**或**插件自定义扩展点
   *   （语法见 {@link PLUGIN_SLOT_NAME}，**必须含 `/`**）。
   *   两者都不满足 ⇒ 忽略并告警（返回空操作注销函数）：这保住了"宿主插槽名写错有反馈"。
   */
  contribute(owner: string, slot: SlotName, meta?: SlotContributionMeta): () => void
  /**
   * **声明一个插件自定义扩展点**（插件把自己的界面开放给别的插件扩展）。
   *
   * 为什么需要显式声明而不是"贡献即声明"：基数是裁决规则（`single` 会抑制后来者），
   * 而它无法从名字推断。默认 `multi`；声明 `single` 才会走到"最早激活者胜出"那条路径。
   *
   * 调用方**不需要**先声明才能贡献——未声明的自定义插槽按 `multi` 处理，且会在
   * {@link SlotService.declarations} 里以"未声明"的形态暴露给诊断（不静默丢失）。
   *
   * @param owner 声明者（插件名）；内置插槽名不接受声明（返回空操作函数并告警）。
   * @returns 幂等的撤销函数（插件卸载时按 owner 一并回收）。
   */
  define(owner: string, slot: string, meta?: Omit<SlotDeclaration, 'owner'>): () => void
  /** 当前**已声明**的插件自定义扩展点（按字典序）。诊断/管理台用。 */
  declarations(): readonly (SlotDeclaration & { readonly slot: string })[]
  /** 列出贡献；不传 `slot` 列出全部（顺序稳定：先内置插槽顺序，再自定义插槽字典序，最后 owner 字典序） */
  list(slot?: SlotName): readonly SlotContribution[]
  /** 某插槽的全部声明者（未按基数裁决，即"谁声明了"，用于诊断） */
  ownersOf(slot: SlotName): readonly string[]
  /** 注销某 owner 的**全部**贡献（管理器卸载统一出口调用，与 `closeStreams(owner)` 同风格） */
  release(owner: string): void
}
