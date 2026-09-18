/**
 * @geewiki/server —— GeeWiki 组合根（应用宿主）
 *
 * 职责：
 * 1. 创建 cordis 应用并引导插件管理器（@geewiki/manager）；
 * 2. 内置插件注册表：@geewiki/db-sqlite / @geewiki/http / @geewiki/echo；
 *    激活与否由 plugins.base.json + plugins.session.json 双层清单决定
 *    （默认 config/ 目录，可用 GEEWIKI_CONFIG_DIR 覆盖）；
 * 3. HTTP 服务（@geewiki/http）：路由注册服务（其他插件经 ctx.get('http')
 *    挂载 JSON 路由）+ 健康检查端点 + 请求统计（看门狗数据源）；
 * 4. SIGINT/SIGTERM 优雅退出：逆序卸载全部插件后退出。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  HEALTH_PATH,
  PLUGIN_UI_ASSET_MAX_DEPTH,
  PLUGIN_UI_ASSET_PATH,
  PLUGIN_UI_PREFIX,
  asAsync,
  anonymousPrincipal,
  auditIpHash,
  breakGlassPrincipal,
  normalizeRuntime,
  resolveProjectPath,
  writeAuditLog,
  type AnyDatabaseAdapter,
  type GeeWikiManifest,
  type HttpRouterService,
  type HttpRouterStats,
  type Principal,
  type RequestHook,
  type CapabilityName,
  type HttpRouteInfo,
  type RouteOwnerStats,
  type HttpRouterService as HttpRouterServiceType,
  type RouteAccess,
  type RouteAccessOptions,
  unauditedRoutes,
  type RouteHandler,
  type RouteHandlerContext,
} from '@geewiki/core'
import { DB_SQLITE_MIGRATIONS_DIR, SqliteDbPlugin, manifest as dbSqliteManifest } from '@geewiki/db-sqlite'
import { AiAdminPlugin, manifest as aiAdminManifest } from '@geewiki/ai-admin'
import { AiAssistantPlugin, manifest as aiAssistantManifest } from '@geewiki/ai-assistant'
import { AiWritingPlugin, manifest as aiWritingManifest } from '@geewiki/ai-writing'
import { AiKbPlugin, manifest as aiKbManifest } from '@geewiki/ai-kb'
import { AiWebSearchPlugin, manifest as aiWebSearchManifest } from '@geewiki/ai-web-search'
import { AiSummaryPlugin, SUMMARY_MIGRATIONS_DIR, manifest as aiSummaryManifest } from '@geewiki/ai-summary'
import { AiNavPlugin, manifest as aiNavManifest } from '@geewiki/ai-nav'
import { AiPagesPlugin, manifest as aiPagesManifest } from '@geewiki/ai-pages'
import { AiToolsPlugin, manifest as aiToolsManifest } from '@geewiki/ai-tools'
import { AiJournalPlugin, JOURNAL_MIGRATIONS_DIR, manifest as aiJournalManifest } from '@geewiki/ai-journal'
import { AuthPlugin, manifest as authManifest } from '@geewiki/auth'
import { AuthzPlugin, manifest as authzManifest } from '@geewiki/authz'
import { BuiltinDocsPlugin, DOCS_MIGRATIONS_DIR, manifest as builtinDocsManifest } from '@geewiki/builtin-docs'
import { EchoPlugin, manifest as echoManifest } from '@geewiki/echo'
import { EditorPlainPlugin, manifest as editorPlainManifest } from '@geewiki/editor-plain'
import { OpsPlugin, manifest as opsManifest } from '@geewiki/ops'
import { LlmPlugin, manifest as llmManifest } from '@geewiki/llm'
import { OidcPlugin, manifest as oidcManifest } from '@geewiki/oidc'
import { OpenAiPlugin, manifest as openAiManifest } from '@geewiki/openai'
import { OrgPlugin, manifest as orgManifest } from '@geewiki/org'
import { SEARCH_MIGRATIONS_DIR, SearchPlugin, manifest as searchManifest } from '@geewiki/search'
import { POSTGRES_MIGRATIONS_DIR, PostgresPlugin, manifest as postgresManifest } from '@geewiki/postgres'
import { WikiPlugin, WIKI_MIGRATIONS_DIR, manifest as wikiManifest } from '@geewiki/wiki'
import {
  PluginManagerPlugin,
  loadExternalPlugins,
  pluginUiNameFromSegments,
  pluginUiRootsFor,
  removeCrashMarker,
  resolveMigrationsDirs,
  slotPlugin,
  capabilityPlugin,
  writeCrashMarker,
  type DiscoveryIssue,
  type RegisteredPlugin,
} from '@geewiki/manager'

/**
 * 崩溃标记路径：与数据库文件同目录（<GEEWIKI_DATA_DIR 或 ./data>），随 data/ 一起被 gitignore。
 * 相对路径以仓库根为基准（与进程工作目录无关，见 resolveProjectPath）。
 */
const crashMarkerFile = resolveProjectPath(
  join(process.env.GEEWIKI_DATA_DIR ?? DEFAULT_DATA_DIR, 'crash.marker'),
  import.meta.url,
)

/* =========================== HTTP 路由服务 =========================== */

/** @geewiki/http 的 Manifest（提供 http-service 路由服务，核心冷插件） */
export const httpManifest: GeeWikiManifest = {
  name: '@geewiki/http',
  version: '0.1.0',
  geewiki: {
    displayName: 'Web 服务',
    description: '提供网页访问与 REST 接口，并托管前端静态资源',
    provides: 'http-service',
    requires: [],
    // ★ F10：监听端口 + 托管静态资源 + 读环境变量（端口/主机/静态根都从 env 来）
    permissions: ['fs:read', 'fs:write', 'env', 'net'],
    runtime: {
      supportsHotReload: false, // 核心通信层：冷操作，仅支持持久化安装 + 进程重启
      drainTimeout: 5,
    },
  },
}

interface RouteEntry {
  method: string
  /** 注册时的原始路径（诊断/审计要用它，`segments` 是匹配用的派生形态） */
  path: string
  /** 路径段：':xxx' 开头为参数段 */
  segments: string[]
  handler: RouteHandler
  /** 粗粒度访问等级（默认 `'public'`；见 @geewiki/core 的 RouteAccess） */
  access: RouteAccess
  /** ★ F9：该路由还要求的能力（`access` 通过后仍需满足）；缺省表示不额外要求 */
  capability?: CapabilityName
  /** ★ F12：登记方（可观测性用；见 `RouteAccessOptions.owner`）。缺省 = 不归因 */
  owner?: string
  /**
   * ★ F11：调用方是否**显式**给了 `access`。
   *
   * 与 `access` 分开存，因为两者信息量不同：`access: 'public'` 可能是"作者写了 public"，
   * 也可能是"作者什么都没写、吃了默认值"。审计要区分的就是这两者（见 `HttpRouteInfo`）。
   */
  explicit: boolean
}

/**
 * 单次请求的执行状态：经 AsyncLocalStorage 承载（跨 await 传播），
 * 供 {@link HttpRouter.drain} 识别"发起排空的那次请求"自身并将其排除。
 */
interface RequestState {
  /** 该请求的路由处理器是否仍在途（结算后置 false，重复结算无副作用） */
  active: boolean
}

/** 排空等待者：在途数变化时按各自的视角判定（不同等待者的调用来源不同） */
interface DrainWaiter {
  /** 该等待者视角下是否已无待等待的请求（已排除它自己发起的那次请求） */
  check(): boolean
  /** 结算该等待（drained=true 已排空 / false 超时） */
  finish(drained: boolean): void
}

/** 是否为 thenable（原生 Promise 或自定义 then 的对象）：不能用 instanceof Promise 判定 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' && typeof value !== 'function') return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/* ======================= 请求鉴权骨架（P0） ======================= */

/**
 * 应急（break-glass）令牌的环境变量名。
 *
 * **未设置该变量 = 整条通道禁用**（不是"默认令牌"、也没有回退值）。
 * 理由：应急通道的代价是"旁路整个权限体系"，长期开启等于权限体系不存在。
 */
const ADMIN_TOKEN_ENV = 'GEEWIKI_ADMIN_TOKEN'

/** 读取应急令牌；未设置或为空串都视为"通道未启用"（空串是配置事故，不能当有效令牌） */
function envAdminToken(): string | null {
  const raw = process.env[ADMIN_TOKEN_ENV]
  return raw !== undefined && raw.length > 0 ? raw : null
}

/**
 * 从请求头取出调用方声称的令牌。
 *
 * 支持两种形态：`X-GW-Admin-Token: <token>`（脚本/CI 友好）与
 * `Authorization: Bearer <token>`（通用惯例）。两者都没有则返回 `null`。
 */
function presentedAdminToken(req: IncomingMessage): string | null {
  const direct = req.headers['x-gw-admin-token']
  if (typeof direct === 'string' && direct.length > 0) return direct
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const matched = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
    if (matched?.[1]) return matched[1]
  }
  return null
}

/**
 * 定长比较：先各自 sha256 再 `timingSafeEqual`。
 *
 * 为什么不直接 `===`：字符串比较会在首个不同字符处短路，逐字节的耗时差异足以在
 * 大量请求下逐位试出令牌（时序侧信道）。哈希后长度固定，`timingSafeEqual` 才是恒时的。
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * 应急通道使用留痕。
 *
 * **两级留痕**：
 * 1. stdout 结构化行（P0 起就有）—— 容器日志被采集时它是第一手证据，**永远保留**；
 * 2. `audit_log` 表（P1 建表后）—— 经 {@link RouterIdentityDeps.onBreakGlassUse}
 *    由组合根接上，落库可查询、可长期留存。
 *
 * 为什么要两级：stdout **只活在容器日志里** ⇒ 日志轮转或容器重建之后，
 * "谁用应急令牌做了什么"就不可追责了（设计文档 §8.2 P0-6 明确记录了这个取舍与风险）。
 * 落库补齐的正是这一环。
 */
function auditBreakGlassUse(req: IncomingMessage): void {
  console.log(
    `[audit] action=access.break_glass actor=break-glass ` +
      `method=${req.method ?? 'GET'} path=${req.url ?? '/'} ` +
      `remote=${req.socket.remoteAddress ?? '-'} at=${new Date().toISOString()}`,
  )
}

/** 访问等级闸门的拒绝结论（状态码 + 机器码 + 人读消息） */
interface AccessDenial {
  status: 401 | 403 | 503
  code: string
  message: string
}

/**
 * 路由服务的身份注入点（P1 新增；全部可选）。
 *
 * 存在的意义是**把 server 与具体身份实现解耦**：P0 的凭据来源只有环境变量令牌，
 * P1 起还要算上"库里有没有可登录的账号"（由 @geewiki/auth 提供），
 * 而 server 不该 import auth 的实现细节 —— 它只拿到两个回调。
 */
export interface RouterIdentityDeps {
  /**
   * "当前是否存在任何可用的凭据来源"的**同步**探针。
   *
   * 必须是同步的：消费方 `judgeAccess` 是纯函数、在请求热路径上被同步调用。
   * 它决定未认证请求收到的是 503 `bootstrap_required`（根本没东西可登录）
   * 还是 401 `unauthorized`（请去登录）—— 混为一谈会让前端在登录页与初始化向导之间死循环。
   */
  credentialSourceProbe?: () => boolean
  /**
   * 应急通道（break-glass）**认证通过**时的回调，用于把使用记录写进 `audit_log`。
   *
   * P0 只在 stdout 留痕（当时还没有审计表）；P1 建表后由组合根接上这个回调，
   * stdout 那一行**保留**作为冗余（容器日志被采集时它是第一手证据）。
   */
  onBreakGlassUse?: (req: IncomingMessage) => void
  /**
   * ★ F9：能力探针 —— 问"这个主体具不具备这个能力"。
   *
   * 与 `credentialSourceProbe` 同一套路：由组合根接上，server **不 import 任何能力实现**。
   * 必须是**同步**的（消费方在请求热路径上被同步调用）；由 `capability-service` 的
   * `snapshot()` 提供，而它本身被设计成同步纯函数（见 core 的 `CapabilityResolver`）。
   *
   * 缺省（未接线）时：**带 `capability` 的路由一律拒绝**（失败关闭）——
   * 未接线意味着"没人能判定"，此时放行等于把闸门直接拆掉。
   */
  capabilityProbe?: (name: CapabilityName, principal: Principal) => boolean
}

/** ★ F11：严格模式的开关环境变量。设为 `1` 时，存在未显式声明访问等级的路由即**拒绝启动**。 */
export const STRICT_ROUTE_ACCESS_ENV = 'GEEWIKI_STRICT_ROUTE_ACCESS'

/**
 * ★ F11：启动期**全路由访问等级审计**。
 *
 * ## 审计的是"有没有人做过这个决定"，不是"公开对不对"
 * `register()` 的第 4 参可省，省略即 `access: 'public'`（匿名可调）。于是全仓几十个调用点
 * 全靠作者自觉 —— 而"**忘了写**"与"**故意公开**"在源码里长得一模一样：两种情况的 `access`
 * 都是 `'public'`，运行期也毫无痕迹。评审看不见风险，出事也追不到"这是谁定的"。
 *
 * 所以这里点名的是 `explicit === false` 的那些，也就是"**没人明确负责**的公开"。
 * 公开本身不是问题（登录、健康检查、匿名可读的接口都该公开），**没被声明过**才是。
 *
 * ## 两种模式
 * - 默认：把清单聚合成**一条**告警（不是每条一行 —— 噪声会把告警训练成背景音）。
 * - `GEEWIKI_STRICT_ROUTE_ACCESS=1`：**拒绝启动**。给"不受信插件/合规环境"用：
 *   一个带着默认 public 上线的新端点会让进程直接起不来，而不是悄悄暴露。
 *
 * `router.routes` 是可选方法（第三方实现可以不提供），拿不到就静默跳过 ——
 * 审计是增强，不该让不提供它的实现无法工作。
 */
export function auditRouteAccess(router: HttpRouterServiceType, env: NodeJS.ProcessEnv = process.env): void {
  const routes = router.routes?.()
  if (routes === undefined) return
  const unaudited = unauditedRoutes(routes)
  if (unaudited.length === 0) return
  const list = unaudited.map((r) => `    ${r.method.padEnd(6)} ${r.path}`).join('\n')
  const head = `[geewiki] ${unaudited.length}/${routes.length} 条路由未显式声明访问等级，正按默认 'public'（匿名可调）运行：`
  const tail =
    `  这些路由的公开是"默认值"而不是"决定"。给它们的 register() 补上第 4 参` +
    `（例如 { access: 'public' }）即视为已评审的决定；收紧为 'user'/'admin' 则更安全。`
  if (env[STRICT_ROUTE_ACCESS_ENV] === '1') {
    throw new Error(
      `${head}\n${list}\n\n[${STRICT_ROUTE_ACCESS_ENV}=1] 严格模式拒绝启动。${tail}`,
    )
  }
  console.warn(`${head}\n${list}\n${tail}`)
}

/**
 * 粗粒度访问等级闸门（纯函数，便于单测）。
 *
 * 判定顺序即优先级，**每一步都是失败关闭**：
 * 1. `public` ⇒ 放行（与 P0 之前的行为完全一致）；
 * 2. 应急主体 ⇒ 放行（旁路；留痕在前一步的解析里已完成）；
 * 3. **没有任何凭据来源** ⇒ 503 `bootstrap_required`。
 *    为什么不是 401：401 的语义是"你去登录"，但引导期**根本没有可登录的东西**。
 *    把它与"未登录"混为一谈，会让前端把运维问题显示成"请重新登录"，并在登录页里死循环。
 *    **判据由调用方给出**（`credentialSourceAvailable`）：P0 恒为"配没配
 *    `GEEWIKI_ADMIN_TOKEN`"；P1 起还必须算上 {@link RouterIdentityDeps.credentialSourceProbe}
 *    —— 即"库里有没有可登录的账号"。漏掉后者会让正常的未登录请求拿到 503，
 *    前端于是永远跳去初始化向导（这正是 P1 必须改掉的一处）。
 * 4. 匿名 ⇒ 401（此时确实存在凭据来源，只是没带或带错）；
 * 5. `user` ⇒ 放行（已认证即可）；
 * 6. 组织角色为 owner/admin ⇒ 放行；
 * 7. 其余 ⇒ 403（已认证但权限不足）。
 *
 * 第 3 步必须放在第 4 步**之前**：未配置令牌时带着任意令牌头发请求，必须得到 503，
 * 绝不能因为"没配令牌"而滑进某个放行分支。
 */
function judgeAccess(access: RouteAccess, principal: Principal, credentialSourceAvailable: boolean): AccessDenial | null {
  if (access === 'public') return null
  if (principal.kind === 'break-glass') return null
  if (!credentialSourceAvailable) {
    return {
      status: 503,
      code: 'bootstrap_required',
      message: `尚未初始化任何凭据来源（未配置 ${ADMIN_TOKEN_ENV}）`,
    }
  }
  if (principal.kind === 'anonymous') {
    return { status: 401, code: 'unauthorized', message: '需要登录' }
  }
  if (access === 'user') return null
  if (principal.orgRole === 'owner' || principal.orgRole === 'admin') return null
  return { status: 403, code: 'forbidden', message: '需要管理员权限' }
}

/**
 * 把钩子的返回值规约为裁决；返回 `null` 表示放行。
 *
 * **失败关闭**：只有显式 `{ ok: true }` 才放行。返回值形态不合法（非对象、缺 `ok`、
 * 状态码不在白名单内）一律按拒绝处理——钩子是插件代码，把它写错不应该等于"全部放行"。
 *
 * 不合法形态返回 403 而不是 500：500 会被看门狗计入"服务连续失败"并可能在阈值处
 * 触发熔断，而这是某个插件的编程错误、不是服务不可用。机器码固定为
 * `hook_invalid_verdict` 以便日志与告警精确匹配。
 */
function verdictDenial(raw: unknown): AccessDenial | null {
  if (typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true) return null
  const shape = raw as { status?: unknown; code?: unknown; message?: unknown } | null
  const code = typeof shape?.code === 'string' ? shape.code : 'hook_invalid_verdict'
  const message = typeof shape?.message === 'string' ? shape.message : '前置钩子返回了不合法的裁决（已按拒绝处理）'
  const status = shape?.status
  if (status === 401 || status === 403 || status === 503) return { status, code, message }
  return { status: 403, code, message }
}

class HttpRouter implements HttpRouterService {
  /** 已注册路由表。字段名刻意与 `routes()` 方法区分：后者是给审计用的**快照**。 */
  private readonly routeTable: RouteEntry[] = []
  /** ★ F12：owner → 命中其路由的请求数（进程内累计，不落盘、重启即清零） */
  private readonly ownerRequests = new Map<string, number>()
  /**
   * 请求前置钩子（按注册顺序串行执行）。
   *
   * 默认**为空**是有意义的：没有钩子时 dispatch 走全同步路径，
   * 既有的"同步返回 boolean"语义逐字不变；只有注册了钩子才会转异步续段。
   */
  private readonly hooks: RequestHook[] = []
  private readonly counters = { total: 0, ok: 0, fail: 0, consecutiveFailures: 0 }
  private msHistory: number[] = []
  private lastMs = 0
  /** 进行中的路由处理器数（优雅排空的等待对象；含发起排空的那次管理请求自身） */
  private inFlight = 0
  /** 排空等待者：在途数变化时按各自视角判定是否完成 */
  private readonly drainWaiters = new Set<DrainWaiter>()
  /**
   * 请求执行上下文（AsyncLocalStorage）：排空时据此排除"发起排空的那次请求"自身。
   * 管理面请求（如 REST 卸载插件）本身也计入在途数，若不排除就会等自己——
   * 结果必然是空转到 drainTimeout 并打印假的超时告警。
   */
  private readonly requestScope = new AsyncLocalStorage<RequestState>()
  /**
   * 活跃长连接响应（SSE 等）：**刻意不计入 inFlight**，按 **owner** 分组。
   *
   * 长连接的处理器同步返回（当拍结算），连接本身随后由持有者持续写帧；把它算进在途数
   * 会让 drain() 一直等到连接关闭 → 空转满 drainTimeout → 打印假的"排空超时"告警。
   * 这个集合用于两件事：
   * 1. 路由服务**自身**卸载/关停时收掉全部连接；
   * 2. **单个插件卸载**时只收掉该插件（owner）开的连接 —— 否则插件级 /disable 既不退在途
   *    （它本来就不占），也不收流，客户端会**静默悬空**（外层表现为"没有报错但也没结束"）。
   *
   * owner 为空串表示"未登记 owner"：这类连接无法被定向回收，只能等整体关停。
   */
  private readonly activeStreams = new Map<string, Set<ServerResponse>>()
  /** 累计被拒的长连接请求数（持有者经 noteStreamRejected 上报；见 HttpStreamStats） */
  private streamsRejected = 0

  constructor(
    private readonly healthHandler: RouteHandler,
    /**
     * 身份相关的注入点（P1 新增）。**全部可选**，省略时行为与 P0 完全一致 ——
     * 既有测试直接 `new HttpRouter(handler)` 构造的用法不受影响。
     */
    private readonly identity: RouterIdentityDeps = {},
  ) {}

  register(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    handler: RouteHandler,
    opts?: RouteAccessOptions,
  ): () => void {
    const entry: RouteEntry = {
      method,
      path,
      segments: path.split('/').filter(Boolean),
      handler,
      // 默认 public：只传 3 个实参的既有调用点（以及全部现存插件）行为完全不变
      access: opts?.access ?? 'public',
      // ★ F11：记下"这是显式声明的还是吃了默认值"
      explicit: opts?.access !== undefined,
      // ★ F9：缺省即"不额外要求能力"——既有调用点行为完全不变
      ...(opts?.capability === undefined ? {} : { capability: opts.capability }),
      // ★ F12：缺省即"不归因"——既有调用点行为完全不变
      ...(opts?.owner === undefined ? {} : { owner: opts.owner }),
    }
    this.routeTable.push(entry)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const idx = this.routeTable.indexOf(entry)
      if (idx >= 0) this.routeTable.splice(idx, 1)
    }
  }

  /** 注册请求前置钩子；返回注销函数（幂等）。契约见 @geewiki/core 的 RequestHook。 */
  use(hook: RequestHook): () => void {
    this.hooks.push(hook)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const idx = this.hooks.indexOf(hook)
      if (idx >= 0) this.hooks.splice(idx, 1)
    }
  }

  /**
   * ★ F11：已注册路由的只读快照（**不含处理器**）。
   *
   * 顺序 = 注册顺序（即"谁先激活谁在前"），不做排序：审计与排障时"注册顺序"
   * 本身是有用信息（它反映了依赖图的解析结果）。
   */
  routes(): readonly HttpRouteInfo[] {
    return this.routeTable.map((r) => ({
      method: r.method,
      path: r.path,
      access: r.access,
      explicit: r.explicit,
      ...(r.capability === undefined ? {} : { capability: r.capability }),
      ...(r.owner === undefined ? {} : { owner: r.owner }),
    }))
  }

  /**
   * ★ F12：按登记方聚合的请求计数。
   *
   * 计数在**闸门之前**发生（见 `gateThenInvoke`）：被 401/403 拒绝的请求同样计入 ——
   * "某个插件的端点正被大量匿名请求打"恰恰是最该被看见的形态之一，
   * 只统计成功请求会把它藏起来。
   */
  ownerStats(): readonly RouteOwnerStats[] {
    const routeCount = new Map<string, number>()
    for (const r of this.routeTable) {
      if (r.owner === undefined) continue
      routeCount.set(r.owner, (routeCount.get(r.owner) ?? 0) + 1)
    }
    const owners = new Set<string>([...routeCount.keys(), ...this.ownerRequests.keys()])
    return [...owners]
      .sort((a, b) => a.localeCompare(b))
      .map((owner) => ({
        owner,
        routes: routeCount.get(owner) ?? 0,
        requests: this.ownerRequests.get(owner) ?? 0,
      }))
  }

  stats(): HttpRouterStats {
    const avgMs = this.msHistory.length
      ? this.msHistory.reduce((a, b) => a + b, 0) / this.msHistory.length
      : 0
    return {
      total: this.counters.total,
      ok: this.counters.ok,
      fail: this.counters.fail,
      consecutiveFailures: this.counters.consecutiveFailures,
      lastMs: this.lastMs,
      avgMs: Math.round(avgMs * 10) / 10,
      streams: { active: this.streamCount(), rejected: this.streamsRejected },
    }
  }

  /** 当前活跃长连接总数（遍历各 owner 集合求和；连接数在个位量级，无需额外计数器） */
  private streamCount(): number {
    let n = 0
    for (const set of this.activeStreams.values()) n += set.size
    return n
  }

  inflight(): number {
    return this.inFlight
  }

  /**
   * 登记长连接响应（见 HttpRouterService.trackStream 的语义说明）。
   * 返回**幂等**的注销函数：重复调用只生效一次，集合不会残留（该 owner 空集时一并删除，
   * 避免 Map 里堆积空 Set）。
   */
  trackStream(res: ServerResponse, owner = ''): () => void {
    let set = this.activeStreams.get(owner)
    if (!set) {
      set = new Set<ServerResponse>()
      this.activeStreams.set(owner, set)
    }
    set.add(res)
    const ownerKey = owner
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.activeStreams.get(ownerKey)
      if (!current) return
      current.delete(res)
      if (current.size === 0) this.activeStreams.delete(ownerKey)
    }
  }

  /**
   * 结束长连接：不传 owner 关闭全部（路由服务卸载/关停时调用），传 owner 只关该 owner 的。
   *
   * 为什么需要主动收：长连接不计入排空，因此 drain() 不会等它们——若不在这里结束，
   * 客户端会一直挂着；同时逐个 try/catch，单个连接的异常不得阻断其它连接的收尾。
   */
  closeStreams(owner?: string): void {
    if (owner === undefined) {
      for (const [key, set] of [...this.activeStreams]) {
        this.endStreamSet(key, set)
        this.activeStreams.delete(key)
      }
      return
    }
    const set = this.activeStreams.get(owner)
    if (!set) return
    this.endStreamSet(owner, set)
    this.activeStreams.delete(owner)
  }

  /** 结束一个 owner 名下的全部连接（失败只记日志：收尾失败不应让卸载失败） */
  private endStreamSet(owner: string, set: Set<ServerResponse>): void {
    for (const res of [...set]) {
      try {
        // 已结束/已销毁的连接不再 end：避免对已关闭的 socket 写入（Node 下虽多为 no-op，
        // 但对 destroyed socket 调 end() 可能触发 'error' 事件）
        if (res.writableEnded !== true && res.destroyed !== true) res.end()
      } catch (err) {
        // 连接可能已被对端断开：收尾失败不影响其它连接，也不应让卸载失败
        console.warn(`[@geewiki/http] 结束长连接失败（owner=${owner || '未登记'}）:`, err)
      }
    }
  }

  /** 上报一次"因并发上限被拒"的长连接请求（持有者调用；见 HttpRouterService 的说明） */
  noteStreamRejected(): void {
    this.streamsRejected++
  }

  /** 除调用方自身请求外的在途数（请求之外调用时等同 inflight()） */
  pending(): number {
    return this.pendingExcluding(this.requestScope.getStore())
  }

  /** 指定请求视角下的待等待数：扣除该请求自身（若它仍在途） */
  private pendingExcluding(own: RequestState | undefined): number {
    return this.inFlight - (own?.active ? 1 : 0)
  }

  /**
   * 优雅排空（架构 §5.1）：等待"调用时刻已受理"的路由处理器全部结算，
   * 超时即返回 false，由调用方决定是否强制卸载。
   *
   * 语义（务必与实现保持一致）：
   * - 等待的是**全站**在途请求，**不含发起排空的那次请求本身**——管理面请求
   *   （如 REST 卸载插件）自身也在在途数里，不自排除就会等自己、必然空转超时；
   * - 按插件（owner）粒度排空属于后续工作：当前不做请求来源归属，
   *   一次卸载会等待所有插件的在途请求；
   * - 排空期间新到的请求照常受理（本方法只等服务，不阻断入站流量）。
   */
  drain(timeoutMs: number): Promise<boolean> {
    // 在调用时刻捕获调用方的请求上下文：等待期间在途数由他人变化，
    // 若在 check 时重新读取 ALS 会读到"当时正在结算的那个请求"的上下文，判定就会错。
    const own = this.requestScope.getStore()
    const pending = (): number => this.pendingExcluding(own)
    if (pending() <= 0) return Promise.resolve(true)
    if (!(timeoutMs > 0)) return Promise.resolve(false)
    return new Promise<boolean>((resolveDrain) => {
      let settled = false
      const waiter: DrainWaiter = {
        check: () => pending() <= 0,
        finish: (drained: boolean): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          this.drainWaiters.delete(waiter)
          resolveDrain(drained)
        },
      }
      const timer = setTimeout(() => waiter.finish(false), timeoutMs)
      timer.unref()
      this.drainWaiters.add(waiter)
    })
  }

  /** 登记一段在途路由处理（与 exitHandler 配对） */
  private enterHandler(state: RequestState): void {
    state.active = true
    this.inFlight++
  }

  /** 结束一段在途路由处理；在途数变化后唤醒已排空的等待者 */
  private exitHandler(state: RequestState): void {
    if (!state.active) return // 已结算（同步抛错 + then 回调双路径）不重复扣减
    state.active = false
    if (this.inFlight > 0) this.inFlight--
    if (this.drainWaiters.size === 0) return
    for (const waiter of [...this.drainWaiters]) {
      if (waiter.check()) waiter.finish(true)
    }
  }

  /**
   * 请求分发入口（node:http server 回调）。
   *
   * 返回 `true` 表示已接管响应（含 API 404），`false` 表示无匹配路由且非 /api 前缀
   * （静态资源层可尝试兜底）。
   *
   * **`Promise<boolean>` 的由来（P0）**：注册了前置钩子时，钩子可以是异步的
   * （P1 的会话解析要查库），此时无法在当拍给出结论。返回类型因此放宽为
   * `boolean | Promise<boolean>`，**语义不变**：调用方一律等它结算后再决定是否交给静态层。
   * 未注册钩子时（默认）仍是**同步**返回，既有调用路径与测试行为逐字不变。
   */
  dispatch(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean> {
    const started = Date.now()
    this.counters.total++
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = req.method ?? 'GET'
    // 指标记账点：json() 与 noteStatus() 共用，**每个请求只记一次**。
    // 幂等是必要的：长连接先 noteStatus(200) 记状态码、随后（如异常收尾路径）仍可能经
    // json() 再走一次；重复记账会让 stats() 的总数虚高、看门狗连续失败计数被放大。
    let settledStats = false
    const finish = (status: number): void => {
      if (settledStats) return
      settledStats = true
      const ms = Date.now() - started
      this.lastMs = ms
      this.msHistory.push(ms)
      if (this.msHistory.length > 100) this.msHistory.shift()
      if (status >= 500) {
        this.counters.fail++
        this.counters.consecutiveFailures++
      } else {
        this.counters.ok++
        this.counters.consecutiveFailures = 0
      }
    }

    // 长连接出口的记账通路：只记指标、绝不碰响应（json() 会 res.end，故不能用于此）
    const noteStatus = (status: number): void => {
      finish(status)
    }

    const json = (status: number, body: unknown): void => {
      // write-after-end 防护：响应已结束（前置处理器已应答/连接已断）时静默忽略
      if (res.writableEnded || res.destroyed) return
      finish(status)
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      }
      // 204/304 规范禁止响应体
      if (status === 204 || status === 304) {
        res.end()
      } else {
        res.end(JSON.stringify(body))
      }
    }

    // 内置健康检查（路由表之外常驻，保证看门狗探针永不因插件卸载而缺失）。
    // **刻意在鉴权骨架之外**：它不属于路由表，且看门狗/容器编排必须在"身份系统尚未就绪"
    // 时也能探活——把它收进闸门会让"权限没配好"表现为"服务不可用"，反而更难排障。
    if (method === 'GET' && url.pathname === HEALTH_PATH) {
      const state: RequestState = { active: false }
      this.enterHandler(state)
      // 处理器可以是同步的，也可以是 thenable（异步数据库适配器需要 await 取表清单）。
      // 与路由分支同样的契约：**同步返回就在本拍结算，返回 thenable 则挂到结算上**——
      // 否则排空计数会提前归零（健康检查被算作已完成，而响应还没写完）。
      this.requestScope.run(state, () => {
        let result: unknown
        try {
          result = this.healthHandler({ req, res, url, params: {}, json, noteStatus })
        } catch (err) {
          console.error('[http] 健康检查异常:', err)
          json(500, { ok: false, error: 'health_check_failed' })
          this.exitHandler(state)
          return
        }
        if (isThenable(result)) {
          void Promise.resolve(result).then(
            () => this.exitHandler(state),
            (err: unknown) => {
              console.error('[http] 健康检查异常:', err)
              json(500, { ok: false, error: 'health_check_failed' })
              this.exitHandler(state)
            },
          )
        } else {
          this.exitHandler(state)
        }
      })
      return true
    }

    // 路径段按 URL 解码（pathname 保留百分号编码，如 %2F 需还原为 '/'）后再与路由模式匹配
    const rawSegments = url.pathname.split('/').filter(Boolean)
    const segments = rawSegments.map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s // 非法编码序列按原样参与匹配（最终落入 404）
      }
    })
    for (const route of this.routeTable) {
      if (route.method !== method || route.segments.length !== segments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < segments.length; i++) {
        const pattern = route.segments[i]
        const actual = segments[i]
        if (pattern?.startsWith(':')) {
          params[pattern.slice(1)] = actual ?? ''
        } else if (pattern !== actual) {
          matched = false
          break
        }
      }
      if (!matched) continue
      // 身份解析：每请求一次。P0 只有应急令牌一种凭据来源（用户会话属 P1），故此步同步。
      const principal = this.resolvePrincipal(req)
      const h: RouteHandlerContext = { req, res, url, params, json, noteStatus, principal }
      // 在途登记：插件卸载前的优雅排空以"处理器是否结算"为准（同步处理器即刻结算）
      const state: RequestState = { active: false }
      this.enterHandler(state)
      // 处理器在请求上下文中执行：管理器于处理器内部调用 drain() 时才能排除自身
      return this.requestScope.run(state, () => {
        // 无钩子（默认）⇒ 全同步路径：既有的"同步返回 boolean"语义逐字不变
        if (this.hooks.length === 0) {
          this.gateThenInvoke(route, h, state, method, url.pathname)
          return true
        }
        // 有钩子 ⇒ 异步续段（钩子允许返回 Promise）
        return this.runHooks(route, h, state, method, url.pathname)
      })
    }

    // 无路由匹配：/api 前缀按 API 404 处理；其余交给静态资源层（SPA fallback）
    if (url.pathname.startsWith('/api/')) {
      json(404, { ok: false, error: 'not_found', path: url.pathname })
      return true
    }
    return false
  }

  /**
   * 解析请求身份（P0：只有应急令牌这一种凭据；用户会话属 P1）。
   *
   * 未配置令牌 ⇒ **直接匿名，即使请求带了令牌头也一样**——
   * 这是"未设置环境变量即整条通道禁用"的落点，也是 P0-5 的验收点。
   *
   * **P1 决议：本方法保持同步，会话解析不走这里。**
   *
   * P0 留的 `TODO(p1)` 曾设想"接入会话查询后把本方法改为异步"。P1 实际选了另一条路：
   * 会话解析由 @geewiki/auth 经 `router.use?.(hook)` 挂载（设计文档 §2.5 ③ 契约第 3 条
   * 明确把钩子点名为"P1 会话解析的挂载点"）。权衡如下：
   *
   * - 本方法在 `dispatch` 里是**无条件**调用的（在 `hooks.length === 0` 分支**之外**），
   *   一旦异步化，**默认（无钩子）路径也会变成异步**，那条"全同步、语义逐字不变"的
   *   快路径承诺就得一并作废；而钩子通路本来就是 async，把 IO 放进去**零代价**。
   * - 本方法的职责因此收敛为"**只解应急令牌**"：读环境变量 + 常量时间比较，没有任何
   *   跨 IO 查询 ⇒ 同步是它最自然的形态；且它在钩子之前执行，保证 `h.principal`
   *   进钩子时已经反映了应急通道（钩子据此决定是否覆盖）。
   *
   * 若将来确有必要在这里做 IO（例如给非 HTTP 入口解析身份），再按原 TODO 的两条
   * 连带影响改造：异步化 + 重做全同步快路径。
   */
  private resolvePrincipal(req: IncomingMessage): Principal {
    const expected = envAdminToken()
    if (expected === null) return anonymousPrincipal()
    const presented = presentedAdminToken(req)
    if (presented === null || !secretsMatch(presented, expected)) return anonymousPrincipal()
    // 通过应急通道认证即留痕（不区分端点等级：令牌本身的"使用"就要可追责）
    auditBreakGlassUse(req)
    this.identity.onBreakGlassUse?.(req)
    return breakGlassPrincipal()
  }

  /**
   * 串行执行前置钩子；全部放行后再过访问等级闸门与处理器。
   *
   * 只在注册过钩子时被调用（否则 dispatch 走全同步路径）。
   */
  private async runHooks(
    route: RouteEntry,
    h: RouteHandlerContext,
    state: RequestState,
    method: string,
    pathname: string,
  ): Promise<boolean> {
    for (const hook of this.hooks) {
      let raw: unknown
      try {
        raw = await hook(h)
      } catch (err) {
        console.error(`[http] 路由 ${method} ${pathname} 前置钩子异常:`, err)
        h.json(500, { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
        this.exitHandler(state)
        return true
      }
      const denial = verdictDenial(raw)
      if (denial) {
        /*
         * ★ 拒绝响应一律 `no-store` **+ `nosniff`**（T6 / X3）。**为什么在这里设**：
         * 附件能力的 401/403 是在 `gateThenInvoke` 里发出的 —— 那时**插件的处理器还没跑**，
         * 插件在自己的处理器入口设的响应头根本轮不到。错误响应的语义是"此刻的状态不允许"，
         * 它不可复用；缺了 `no-store`，浏览器可以启发式缓存 401/403（拿到授权后仍复用旧拒绝，
         * 表现为"登录了还是被挡"）。
         *
         * `nosniff` 同理必须补：**拒绝响应同样是响应**，不能少这一层。网关拒绝的信封里
         * 含**调用方可控**的字符串（`denial.message` 与 `details.access` 取自路由/主体），
         * 一旦某个中间层丢掉或改写了 `content-type`，浏览器就可能把这段 JSON 文本
         * **猜**成 HTML 去执行。`h.json` 只写 `content-type`、**不带** nosniff
         * （实现见本文件 `json()` 的响应体路径），所以每个绕过插件处理器的出口
         * 都要自己补上——这里正是其中一个。
         * 成功响应不受影响：这条路径只走拒绝分支。
         */
        h.res.setHeader('cache-control', 'no-store')
        h.res.setHeader('x-content-type-options', 'nosniff')
        // 错误信封与 gateThenInvoke 的拒绝**保持同一形状**（含 details.access）：
        // 同为"拒绝"，两处形状不一致会让前端文案与告警匹配规则产生漂移。
        h.json(denial.status, {
          ok: false,
          error: denial.code,
          message: denial.message,
          details: { access: route.access },
        })
        this.exitHandler(state)
        return true
      }
    }
    this.gateThenInvoke(route, h, state, method, pathname)
    return true
  }

  /**
   * 访问等级闸门 → 调用处理器。
   *
   * 闸门读 `h.principal` 而**不是**某个局部变量：钩子替换过的主体必须在此生效。
   * `h.principal` 缺失时按**匿名**处理——失败关闭，绝不"没身份就放行"。
   */
  private gateThenInvoke(
    route: RouteEntry,
    h: RouteHandlerContext,
    state: RequestState,
    method: string,
    pathname: string,
  ): void {
    const credentialSource = envAdminToken() !== null || this.identity.credentialSourceProbe?.() === true
    const principal = h.principal ?? anonymousPrincipal()
    // ★ F12：计数放在**闸门之前** —— 被拒的请求同样要可见（"端点正被大量匿名请求打"最该被看到）
    if (route.owner !== undefined) {
      this.ownerRequests.set(route.owner, (this.ownerRequests.get(route.owner) ?? 0) + 1)
    }
    const denial = judgeAccess(route.access, principal, credentialSource)
    if (denial) {
      /*
       * ★ 同上（T6 / X3）：网关层的拒绝（401 `unauthorized` / 403 `forbidden`）也必须是
       * `no-store` **+ `nosniff`** —— 这里发响应时**插件的处理器一行都没跑**，
       * 插件在自己入口设的那两个头轮不到，所以本层必须自己补全（理由详见 runHooks 里
       * 同一段注释）。四个附件端点虽然都在处理器入口设了 `nosniff`，但匿名 PUT / 缺 CSRF
       * 的拒绝发生在**进入处理器之前**：实测正是这两个响应此前缺 `nosniff`
       * （`x-content-type-options: null`），本条注释就是那次实测的落点。
       */
      h.res.setHeader('cache-control', 'no-store')
      h.res.setHeader('x-content-type-options', 'nosniff')
      h.json(denial.status, {
        ok: false,
        error: denial.code,
        message: denial.message,
        details: { access: route.access },
      })
      this.exitHandler(state)
      return
    }
    /*
     * ★ F9：**能力闸门**（第二层，`access` 通过之后才轮到它）。
     *
     * 为什么与 `access` 分开而不是塞进 `RouteAccess` 联合里：两者回答的是不同问题，
     * 且**判定归属不同** —— `access` 的规则（匿名/已登录/管理员）由宿主拥有，
     * `capability` 的规则由**注册它的插件**拥有。混成一个联合会让人以为
     * "写个字符串就行"，而实际语义是"某个插件承诺会算这个值"。
     *
     * **失败关闭**：探针没接线（`undefined`）时一律拒绝。未接线意味着"没人能判定"，
     * 此时放行等于把闸门直接拆掉 —— 而 `capability` 是插件显式要求的，不是默认行为。
     */
    if (route.capability !== undefined) {
      const granted = this.identity.capabilityProbe?.(route.capability, principal) === true
      if (!granted) {
        h.res.setHeader('cache-control', 'no-store')
        h.res.setHeader('x-content-type-options', 'nosniff')
        h.json(403, {
          ok: false,
          error: 'capability_required',
          message: `需要能力 ${route.capability}`,
          details: { access: route.access, capability: route.capability },
        })
        this.exitHandler(state)
        return
      }
    }
    this.invokeHandler(route.handler, h, state, method, pathname)
  }

  /** 调用处理器并按结算时机收尾（同步 / thenable 两条通路，语义与 P0 之前完全一致） */
  private invokeHandler(
    handler: RouteHandler,
    h: RouteHandlerContext,
    state: RequestState,
    method: string,
    pathname: string,
  ): void {
    try {
      const result: unknown = handler(h)
      if (isThenable(result)) {
        // Promise.resolve 兜住非原生 thenable（自定义 then）：结算时机正确，且 rejection 有人接管
        void Promise.resolve(result).then(
          () => this.exitHandler(state),
          (err: unknown) => {
            console.error(`[http] 路由 ${method} ${pathname} 异常:`, err)
            h.json(500, { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
            this.exitHandler(state)
          },
        )
      } else {
        this.exitHandler(state)
      }
    } catch (err) {
      console.error(`[http] 路由 ${method} ${pathname} 异常:`, err)
      h.json(500, { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
      this.exitHandler(state)
    }
  }
}

/* =========================== 静态资源服务 =========================== */

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

/** 静态资源的根集合：web 产物 + 插件 UI 的"按名查根"表 */
interface StaticRoots {
  /** 前端静态产物目录；null = 不启用 web 产物托管 */
  webDist: string | null
  /**
   * 插件 UI 根表（**懒求值**，`{ [插件名]: 命中根绝对路径 }`）：由管理器的
   * `pluginUiRootsFor(registry, webDist)` 产出。用函数而非快照是**必要**的——
   * `httpRegistryEntry` 在 `defaultRegistry()` 内创建时外部插件尚未发现（注册顺序陷阱）。
   */
  pluginUiRoots?: () => Record<string, string>
}

/** 统一 404（JSON，与静态层既有格式一致） */
function sendNotFound(res: ServerResponse): void {
  if (res.headersSent) return
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: 'not_found' }))
}

/**
 * 带内容指纹的产物文件名（Vite 等打包器的 `name-<hash>.js` / `logo-D3f4G5.svg`）。
 * 命中即可给「长缓存 + immutable」：文件名一变就是新 URL，旧 URL 的内容永不改变。
 */
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/

/**
 * 插件 UI 资产：`<PLUGIN_UI_PREFIX>/<插件名>/<相对路径>`（插件名 1 段或 2 段 scope 形态，
 * 相对路径可含子目录，例如 `assets/logo.svg`、`js/chunk-2.js`）。
 *
 * 安全模型（四层，任一层不过即 404）：
 * 1. **先按段还原插件名，再在根表里精确查名**——查不到直接 404，因此不存在由不可信输入
 *    拼出的路径。**插件名与资产路径都不解码**：`%40geewiki` 查不到表 → 404
 *    （编码名一律不认，与前端约定一致）；也正因不解码，`%2e%2e` / `..%2f` / 双重编码
 *    这一整类陷阱不存在（{@link PLUGIN_UI_ASSET_PATH} 直接拒掉含 `%` 的输入）。
 * 2. **相对路径形态校验**：段必须以字母/数字开头，故 `..`、`.env`、空段、绝对路径、
 *    反斜杠、尾随斜杠一律非法；另有段数上限。
 * 3. **词法包含**：`relative(root, file)` 不得以 `..` 开头或为绝对路径。
 *    刻意**不用 `startsWith`**——那是前缀字符串比较，`/a/b-evil` 会通过 `/a/b` 的检查。
 * 4. **真实路径包含**：`realpath` 之后再比一次，挡住**符号链接逃逸**
 *    （产物目录里指向根外的软链）。
 *
 * 名字/路径的切分歧义：`/plugins-ui/@a/b/c.js` 既可读作「插件 `@a/b` + 路径 `c.js`」，
 * 也可读作「插件 `@a` + 路径 `b/c.js`」。规则是**两段（scope）名优先**，且只在根表里
 * **确实存在**该名时才选定——与 npm 的 `@scope/pkg` 规范形态一致，且结果确定。
 *
 * 与普通静态资源的关键差别：**绝不回退 index.html**。缺失即 404，否则会被 SPA fallback
 * 掩盖成 200 `text/html`，浏览器加载插件 bundle 时报 MIME 错误、且快照里看不出真因。
 */
async function servePluginUiAsset(
  roots: StaticRoots,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = pathname.slice(PLUGIN_UI_PREFIX.length)
  // 严格：**不折叠空段**。`a//b` 与尾随 `/` 直接 404，使「请求路径 == 生效路径」，
  // 审阅者无需推理规范化差异（若在此 filter 掉空段，`assets//logo.svg` 会静默变成
  // `assets/logo.svg` 并 200——虽无害，但会让"URL 与实际取到的文件"不再一一对应）。
  if (raw.includes('//') || raw.endsWith('/')) {
    sendNotFound(res)
    return
  }
  const segments = raw.split('/').filter((s) => s !== '')
  // 名字候选：2 段（scope）优先，其次 1 段；各自都要满足插件名规则
  const candidates: { name: string; asset: string }[] = []
  if (segments.length >= 3) {
    const name = pluginUiNameFromSegments(segments.slice(0, 2))
    if (name) candidates.push({ name, asset: segments.slice(2).join('/') })
  }
  if (segments.length >= 2) {
    const name = pluginUiNameFromSegments(segments.slice(0, 1))
    if (name) candidates.push({ name, asset: segments.slice(1).join('/') })
  }
  const table = roots.pluginUiRoots?.() ?? {}
  // 取**第一个在根表里存在**的名字候选；其后的候选不再考虑（切分必须是确定的）
  const hit = candidates.find((c) => table[c.name] !== undefined)
  if (!hit) {
    sendNotFound(res)
    return
  }
  const asset = hit.asset
  const root = table[hit.name] as string
  if (!PLUGIN_UI_ASSET_PATH.test(asset) || asset.split('/').length > PLUGIN_UI_ASSET_MAX_DEPTH) {
    sendNotFound(res)
    return
  }
  const rootAbs = resolve(root)
  const file = resolve(rootAbs, asset)
  // 词法包含（纵深防御：形态校验已排除 `..` 与绝对路径，这里独立再验一次）
  if (!isContained(rootAbs, file)) {
    sendNotFound(res)
    return
  }
  const dot = asset.lastIndexOf('.')
  const ext = dot < 0 ? '' : asset.slice(dot).toLowerCase()
  try {
    // 真实路径包含：挡住符号链接逃逸（realpath 在文件不存在时抛错 → 404，正合语义）
    if (!isContained(await realpath(rootAbs), await realpath(file))) {
      sendNotFound(res)
      return
    }
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    const data = await readFile(file)
    // 弱校验器：由 size + mtime 派生，足以做 revalidate（不读内容算哈希，避免大资产开销）
    const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
    // 带内容指纹的文件名（`name-<hash>.js`）可长缓存：文件名一变即新 URL，旧 URL 内容永不变。
    // 无指纹的（`client.js`）沿用既有 `no-cache`：浏览器每次回来校验，不会长期缓存旧产物。
    // 刻意**不**依赖 `?v=<rev>` 之类的 query 做缓存击穿：该方案已实测证伪——给**根相对** URL 加 query
    // 会被 dev 下的 Vite 改写成 `?import&v=…` → 必然 500；改用同源绝对 URL 虽能绕开改写，但 `rev`
    // 一变就产生**新模块实例**，而 ESM 无法从模块图卸载 → 插槽条目翻倍。`rev` 只作**变更检测**，
    // 真正换代码的路径是 unload → load（同 URL 命中模块缓存，新产物需整页刷新才生效）。
    // 详细实测记录见 `packages/web/src/lib/pluginUiPlan.ts` 文件头。
    const cacheControl = HASHED_ASSET_NAME.test(asset) ? 'public, max-age=31536000, immutable' : 'no-cache'
    // 条件请求命中即 304（无响应体；规范禁止在 304 上带 content-length）。
    // 与入口表 revision/304 是**两套独立机制**：那条是 JSON 入口表的 ETag，这条是资产字节的 ETag。
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControl })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': STATIC_MIME[ext] ?? 'application/octet-stream',
      'cache-control': cacheControl,
      etag,
      'content-length': data.length,
    })
    res.end(req.method === 'HEAD' ? undefined : data)
  } catch {
    sendNotFound(res)
  }
}

/**
 * 词法包含判定：`child` 是否位于 `parent` 之内（按**路径段**比较，而非前缀字符串）。
 * 为什么必须是段比较：`startsWith` 会让 `/a/b-evil` 通过 `/a/b` 的检查。
 */
function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 静态文件服务：优先精确文件；未命中且路径无扩展名时回退 index.html（SPA）。
 * 仅由 dispatch 返回 false 的请求进入（/api/* 已被路由层接管）。
 */
async function serveStatic(roots: StaticRoots, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const notFound = (): void => sendNotFound(res)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    notFound()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  // 插件 UI 资产走独立分支（可有独立资产根，且不做 SPA fallback）
  if (pathname === PLUGIN_UI_PREFIX || pathname.startsWith(`${PLUGIN_UI_PREFIX}/`)) {
    await servePluginUiAsset(roots, pathname, req, res)
    return
  }
  const root = roots.webDist
  if (!root) {
    notFound()
    return
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  // 路径穿越防护：规范化后必须仍位于静态根内
  const file = isAbsolute(rel) ? '' : resolve(root, rel)
  if (!file || !isContained(resolve(root), file)) {
    notFound()
    return
  }
  const dot = file.lastIndexOf('.')
  const ext = dot < 0 ? '' : file.slice(dot).toLowerCase()
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    const data = await readFile(file)
    const contentType = STATIC_MIME[ext] ?? 'application/octet-stream'
    const isHashedAsset = pathname.startsWith('/assets/')
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': data.length,
    })
    res.end(req.method === 'HEAD' ? undefined : data)
  } catch {
    // 文件不存在 → SPA fallback（仅对无扩展名的导航路径），且 web 产物存在时兜底 index.html
    if (ext === '' || pathname.endsWith('/')) {
      const fallback = resolve(root, 'index.html')
      try {
        const data = await readFile(fallback)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(req.method === 'HEAD' ? undefined : data)
        return
      } catch {
        /* 静态根缺失或未构建：fallback 不存在 → 落入 404 提示 */
      }
    }
    notFound()
  }
}

export interface HttpConfig {
  port: number
  host?: string
  /** 前端静态产物目录；null = 不启用静态服务 */
  webDist?: string | null
  /**
   * 插件 UI 的"按插件名查根"表（`{ [插件名]: 命中根绝对路径 }`），**懒求值**。
   *
   * 必须是函数：本插件的注册表条目由 `defaultRegistry()`/`httpRegistryEntry()` 创建，
   * 那一刻外部插件**尚未被发现**（`buildRegistry()` 之后才合并进注册表），快照必然是空的。
   * 与 `webDist` 同机制——由组合根注入、**不进入持久化清单**。
   */
  pluginUiRoots?: () => Record<string, string>
  /** 关停前等待在途 API 请求结算的上限（秒）；缺省取 httpManifest.runtime.drainTimeout（5） */
  drainTimeout?: number
}

/** 本插件声明的排空等待上限（秒，架构 §5.1）：卸载前等待进行中请求完成 */
const HTTP_DRAIN_TIMEOUT_SECONDS = normalizeRuntime(httpManifest.geewiki.runtime).drainTimeout

/** HTTP 服务插件：提供 http 路由服务（ctx.get('http')），常驻内核插件 */
export const HttpPlugin = {
  name: '@geewiki/http',

  apply(ctx: Context, config: Partial<HttpConfig> = {}) {
    // 端口来源优先级：清单配置 > GEEWIKI_PORT 环境变量 > 默认 3000
    const port = config.port ?? Number(process.env.GEEWIKI_PORT ?? DEFAULT_PORT)
    const host = config.host ?? '0.0.0.0'
    const startedAt = Date.now()
    // 插件 UI 根表：**每次静态请求现算，禁止缓存**。
    //
    // 入口表 `GET /api/plugins/ui`（管理器的 `uiTable()`）是每次请求现算的，而根表若只求值
    // 一次并永久缓存，两者寿命就不同 → 会出现「入口表说该插件就绪（并给出 rev），静态层却
    // 从已消失的根取文件 → 404」，而前端还会照入口表的值去 import 那个 404 的资产。
    // 触发条件很具体：同名入口文件在两个候选根都存在（`<pluginDir>/dist` 与
    // `webDist/plugins-ui/<名>`），随后高优先级那个根消失——`resolvePluginUiHit` 会回退到
    // 次优先根并在表里继续列出该插件，而缓存仍指着已消失的高优先级根。
    //
    // 代价可控：`pluginUiRootsFor()` 只对"声明了 client 的插件"做几次 stat，注册表只有几条。
    // 注意这里保留"函数"形态（而非快照对象）是**另一件事**——它解开的是"http 条目早于外部
    // 插件发现"的注册顺序陷阱，与缓存无关，不要改回快照。
    const pluginUiRoots = (): Record<string, string> => config.pluginUiRoots?.() ?? {}
    const router = new HttpRouter((h) => {
      const rawDb = ctx.get('db') as AnyDatabaseAdapter | undefined
      // **归一化为异步**：同步（sqlite）与异步（pg）两种驱动走同一条代码路径，
      // 不必在健康检查里写 `instanceof` 分支。
      const db = rawDb ? asAsync(rawDb) : undefined
      // 长连接可观测性：让运维能从健康检查看出"是否有流卡住 / 是否有人在被拒"。
      // **只新增字段**：既有 ok/uptime/timestamp/db 的形状与语义一字未改 ——
      // Dockerfile 的 HEALTHCHECK 判据是 `j.ok===true && j.db && j.db.present===true`。
      const { streams } = router.stats()
      // 异步处理器：返回 Promise，由 dispatch 的 thenable 分支负责结算
      return (async () => {
        let dbPart: Record<string, unknown>
        if (!db) {
          dbPart = { present: false }
        } else {
          try {
            dbPart = {
              present: true,
              dialect: db.dialect,
              tables: await db.listTables(),
              migrations: await db.appliedMigrations(),
            }
          } catch (err) {
            // 数据库已不可用（连接断开等）：如实报告 present:false 且带上原因，
            // 而不是让健康检查整体 500 —— 容器编排据此重启，但运维仍能看到原因。
            dbPart = { present: false, dialect: db.dialect, error: (err as Error).message }
          }
        }
        h.json(200, {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
          db: dbPart,
          ...(streams ? { streams } : {}),
        })
      })()
    }, {
      /*
       * **身份注入点（P1）**。路由服务**不 import 任何身份实现**，只拿两个回调：
       *
       * 1. `credentialSourceProbe` —— 问"现在有没有可登录的账号"。
       *    每次请求现算（`ctx.get` 是活查询）：@geewiki/auth 在本插件**之后**才激活，
       *    构造期快照必然是 undefined，与 `pluginUiRoots` 是同一类注册顺序陷阱。
       * 2. `onBreakGlassUse` —— 应急令牌认证通过时落库留痕。
       *    审计写入是**旁路**：失败只记日志，绝不让"审计表写不进去"变成"应急通道不可用"
       *    （应急通道的意义正是身份系统出问题时还能进场）。
       */
      credentialSourceProbe: () => {
        const auth = ctx.get('auth-service') as { hasCredentialSource?: () => boolean } | undefined
        return auth?.hasCredentialSource?.() === true
      },
      /*
       * ★ F9：能力探针。与 `credentialSourceProbe` 同样**逐请求现取**服务 ——
       * `capability-service` 由 manager 提供，而它可能晚于本插件激活（也有热替换路径），
       * 构造期快照必然是 undefined。
       *
       * 拿不到服务 ⇒ 返回 `false`（失败关闭）⇒ 带 `capability` 的路由拒绝。
       * 方向是刻意的：服务不可用时应表现为"入口暂时不可用"，而不是"闸门消失"。
       */
      capabilityProbe: (name, principal) => {
        const svc = ctx.get('capability-service') as
          | { snapshot: (p: typeof principal) => Record<string, boolean> }
          | undefined
        if (!svc) return false
        return svc.snapshot(principal)[name] === true
      },
      onBreakGlassUse: (req) => {
        const rawDb = ctx.get('db') as AnyDatabaseAdapter | undefined
        if (!rawDb) return
        void writeAuditLog(asAsync(rawDb), {
          action: 'access.break_glass',
          targetKind: 'session',
          targetId: 'break-glass',
          actorId: null,
          actorIpHash: auditIpHash(req.socket.remoteAddress),
          after: { method: req.method ?? 'GET', path: req.url ?? '/' },
        }).catch((err: unknown) => {
          console.error('[http] 应急通道审计写入失败（stdout 留痕仍在）:', err)
        })
      },
    })

    const server: Server = createServer((req, res) => {
      const handled = router.dispatch(req, res)
      // 注册了前置钩子时 dispatch 转入异步续段（P0）：此时无法当拍判断是否交给静态层。
      // 未注册钩子时仍是同步 boolean —— 既有路径逐字不变。
      if (isThenable(handled)) {
        void Promise.resolve(handled).then(
          (taken) => {
            if (!taken) void serveStatic({ webDist: config.webDist ?? null, pluginUiRoots }, req, res)
          },
          (err: unknown) => {
            // 分发本身抛错必须显式收尾，否则客户端会一直挂着一个不会再有字节的连接
            console.error('[@geewiki/http] 请求分发异常:', err)
            if (res.writableEnded) return
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'internal', message: '请求分发异常' }))
            } else {
              res.end()
            }
          },
        )
        return
      }
      if (!handled) {
        void serveStatic({ webDist: config.webDist ?? null, pluginUiRoots }, req, res)
      }
    })
    server.on('error', (err) => {
      console.error('[@geewiki/http] 监听失败:', err)
      // 假活防护：端口被占/地址非法时进程无法服务，直接失败退出（容器 restart 策略负责恢复）
      process.exit(1)
    })
    server.listen(port, host, () => {
      const shown = host === '0.0.0.0' ? '127.0.0.1' : host
      console.log(`[@geewiki/http] 服务已启动: http://${shown}:${port}`)
      // 打印已解析的静态根（相对路径以仓库根为基准，见 resolveProjectPath）：便于核对 env 是否生效
      if (config.webDist) console.log(`[@geewiki/http] 静态资源目录: ${config.webDist}`)
    })

    const unprovide = ctx.provide('http', router)
    return () =>
      new Promise<void>((resolveClose) => {
        unprovide()
        // 1) 先主动结束全部长连接（SSE 等）：它们不计入排空，drain() 不会等它们，
        //    不收掉的话客户端会一直挂着等一个再也不会来的字节
        router.closeStreams()
        // 2) 优雅排空（架构 §5.1）：先等在途 API 请求结算，再关闭监听（超时强制关闭）。
        //    长连接不占在途，故这里应**立即**返回；若有真实在途请求，告警照常打印。
        const drainTimeoutMs = (config.drainTimeout ?? HTTP_DRAIN_TIMEOUT_SECONDS) * 1000
        void router
          .drain(drainTimeoutMs)
          .then((drained) => {
            if (!drained) {
              console.warn(
                `[@geewiki/http] 排空超时（${drainTimeoutMs}ms，仍有 ${router.inflight()} 个请求在途），强制关闭监听`,
              )
            }
            // 3) 关掉空闲 keep-alive 连接（只关空闲、保留在途）；不用 closeAllConnections()：
            //    那会连测试里 undici 连接池的复用连接一并掐断，代价大于收益
            server.closeIdleConnections?.()
            server.close(() => resolveClose())
          })
          .catch((err: unknown) => {
            console.error('[@geewiki/http] 排空异常:', err)
            server.closeIdleConnections?.()
            server.close(() => resolveClose())
          })
      })
  },
}

/* ============================ 组合根 ============================= */

export interface ServerOptions {
  /** 监听端口（优先于 GEEWIKI_PORT 与内置默认 3000；仅默认注册表生效，见 httpRegistryEntry） */
  port?: number
  /** 监听地址（优先于 GEEWIKI_HOST 与内置默认 0.0.0.0；同上） */
  host?: string
  /** 插件清单目录（默认取 GEEWIKI_CONFIG_DIR 或仓库根下 config/；相对路径以仓库根为基准） */
  configDir?: string
  /** 前端静态产物目录（默认 GEEWIKI_WEB_DIST 或仓库根下 packages/web/dist；相对路径以仓库根为基准） */
  webDist?: string | null
  /**
   * 内置插件 UI 资产根（默认 GEEWIKI_PLUGIN_UI_DIST，**缺省回落 `webDist`**；相对路径以仓库根为基准）。
   *
   * 与 `webDist` 分开是因为两者职责不同：`webDist` 供 app shell 与 `/assets/*`，
   * 而插件 UI 资产（`plugins-ui/<插件名>/`）可能有独立来源——dev 下即
   * `packages/web/public/plugins-ui/**`，无需前端构建。null = 不使用内置根（只看插件自带产物）。
   */
  pluginUiDist?: string | null
  /** 外部插件目录（默认 GEEWIKI_PLUGINS_DIR 或仓库根下 plugins/；null = 不启用外部插件发现） */
  pluginsDir?: string | null
  registry?: RegisteredPlugin[]
}

/** startServer 传给 http 插件的启动期默认值（清单内未显式配置端口/地址时生效） */
export interface HttpEntryDefaults {
  port?: number
  host?: string
}

/** buildRegistry 的结果：registry 供管理器装配，issues 透出到 `GET /api/plugins` */
export interface RegistryBuildResult {
  registry: RegisteredPlugin[]
  issues: DiscoveryIssue[]
}

/**
 * 构造 `@geewiki/http` 的注册表条目：绑定静态根（webDist 经此处注入，避免进入持久化清单），
 * 并把启动期默认端口/地址带入插件配置。自定义注册表可复用它以获得同样的绑定行为。
 *
 * 优先级：清单（持久化）配置里的显式 `port`/`host` > 本处默认值（来自 startServer 的
 * `options ?? env ?? 内置默认`）> 插件内的环境变量兜底。
 */
export function httpRegistryEntry(
  webDist: string | null,
  defaults: HttpEntryDefaults = {},
  pluginUiRoots?: () => Record<string, string>,
): RegisteredPlugin {
  return {
    name: '@geewiki/http',
    manifest: httpManifest,
    module: {
      name: '@geewiki/http',
      apply(ctx: Context, config: Partial<HttpConfig> = {}) {
        return HttpPlugin.apply(ctx, {
          ...config,
          ...(config.port === undefined && defaults.port !== undefined ? { port: defaults.port } : {}),
          ...(config.host === undefined && defaults.host !== undefined ? { host: defaults.host } : {}),
          webDist,
          // 懒求值闭包：清单里不可能有这个函数，故无条件覆盖（与 webDist 同机制）
          ...(pluginUiRoots ? { pluginUiRoots } : {}),
        })
      },
    },
  }
}

/**
 * 从绝对迁移目录**向上**找到所属插件包的根（以 `package.json` 的 `name` 与清单名一致为准）。
 *
 * 为什么不用 `require.resolve('@geewiki/<pkg>/package.json')`：四个插件包的 `exports` 都只映射
 * `'.'`，实测该写法与裸 specifier 解析**均 MODULE_NOT_FOUND**（ESM-only 的 `.ts` 入口也无法经
 * CJS 解析）。向上走查是纯文件系统操作，不依赖解析器，且**不依赖仓库目录布局**。
 *
 * @returns 包根绝对路径；找不到匹配的 package.json 时 `undefined`
 */
export function packageRootOf(dir: string, expectedName: string): string | undefined {
  let cur = resolve(dir)
  for (let i = 0; i < 6; i++) {
    const pkgFile = join(cur, 'package.json')
    if (existsSync(pkgFile)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: unknown }
        if (parsed.name === expectedName) return cur
      } catch {
        // package.json 不可解析：继续向上找，不因它中断启动
      }
    }
    const up = resolve(cur, '..')
    if (up === cur) break
    cur = up
  }
  return undefined
}

/**
 * 求得一个内建插件条目的迁移目录表——**与外部插件同一套解析规则**：
 *
 * 1. 先从插件包导出的绝对目录向上定位**包根**；
 * 2. 用 `resolveMigrationsDirs` 解析 `manifest.geewiki.migrations`（相对包根的路径）——
 *    **manifest 是声明的真源**，解析结果即注册表使用的值；
 * 3. 仅当 manifest 尚未声明该字段时，才回退到调用方给出的绝对目录（注册表**补充**缺口）。
 *
 * 于是"manifest 写的 migrations 对内建插件不生效"这一缺陷被消除；两处不一致不会再被静默容忍
 * ——`test/builtin-migrations.test.ts` 用真实磁盘上的包根交叉核对，并钉住回退清单。
 *
 * @param manifest 插件清单（声明来源）
 * @param fallback 回退的绝对目录（仅 manifest 未声明时使用）
 */
export function builtinMigrations(
  manifest: GeeWikiManifest,
  fallback: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const dirs = Object.values(fallback)
  const root = dirs.length === 1 ? packageRootOf(dirs[0] as string, manifest.name) : undefined
  const declared = root ? resolveMigrationsDirs(manifest, root, { warn: (m) => console.warn(m) }) : undefined
  return declared ?? fallback
}

/** 内置插件注册表（default registry：服务器引导时注册的全部可管插件） */
export function defaultRegistry(
  webDist: string | null,
  defaults: HttpEntryDefaults = {},
  pluginUiRoots?: () => Record<string, string>,
): RegisteredPlugin[] {
  return [
    {
      name: '@geewiki/db-sqlite',
      manifest: dbSqliteManifest as GeeWikiManifest,
      module: SqliteDbPlugin,
      // 声明在 manifest.geewiki.migrations（'./src/migrations'）；此处给出的绝对目录仅作回退
      migrationsDirs: builtinMigrations(dbSqliteManifest as GeeWikiManifest, { sqlite: DB_SQLITE_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    // PostgreSQL：与 sqlite 同属 database-provider 冲突组 ⇒ 同组互斥自动生效。
    // **不加入 config/plugins.base.json**（默认仍是 SQLite；切库是显式决策）。
    {
      name: '@geewiki/postgres',
      manifest: postgresManifest,
      module: PostgresPlugin,
      // 该包的 manifest 尚未声明 migrations ⇒ 这里给出绝对目录作为回退（测试会钉住这份清单）
      migrationsDirs: builtinMigrations(postgresManifest, { postgres: POSTGRES_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    { ...httpRegistryEntry(webDist, defaults, pluginUiRoots), source: 'builtin' },
    // 身份与登录（P1）：提供 auth-service。**默认启用**（写进 config/plugins.base.json）——
    // 它不是一个"可选功能"，而是 P1 起所有 `access:'user'` 端点的凭据来源：
    // 不启用则登录不可用、写入只能靠应急令牌。
    // **无自带迁移**：users/sessions/audit_log 等表由 db 插件的 0010/0013 建立
    // （它们属核心基础设施，不属于某个业务插件）。
    // runtime.supportsHotReload=false：热卸载会让所有会话的解析通道瞬间消失，
    // 而"谁登录了"没有安全的即时降级方式。
    { name: '@geewiki/auth', manifest: authManifest as GeeWikiManifest, module: AuthPlugin, source: 'builtin' },
    // 组织与团队（P2）：提供 org-service。
    // **默认启用**（写进 config/plugins.base.json）—— 与 auth 同理：`orgRole` 的存储
    // 就是 0011 迁移建的 `org_members`；不启用则所有主体的 orgRole 恒为 null（= guest），
    // 于是 `access:'admin'` 的端点在浏览器里永久不可用，条目可见性也没有"组织内"这一档。
    // **无自带迁移**：org_* 表由 db 插件的 0011 建立（核心基础设施，不属于业务插件）。
    // runtime.supportsHotReload=false：热卸载会让"谁是 owner"瞬间无人可答。
    { name: '@geewiki/org', manifest: orgManifest as GeeWikiManifest, module: OrgPlugin, source: 'builtin' },
    // 授权策略（P2）：提供 policy-service，是**可见性判定的唯一真源**。
    // 默认启用 —— 不启用则所有读路径拿不到策略服务（消费方必须显式失败而不是放行）。
    // runtime.supportsHotReload=true：策略层不持有状态，卸载后消费方在 ctx.get 处显式失败。
    { name: '@geewiki/authz', manifest: authzManifest as GeeWikiManifest, module: AuthzPlugin, source: 'builtin' },
    { name: '@geewiki/echo', manifest: echoManifest as GeeWikiManifest, module: EchoPlugin, source: 'builtin' },
    // 纯文本编辑器：`editor` 插槽的第一个真实消费者（证明"插件可替换编辑器"这条扩展点可用）。
    // **只登记、不写进基础清单**——它替换的是默认编辑器，是否替换应由使用者显式决定；
    // 未启用时编辑页走内置 CodeMirror（回落路径已端到端覆盖）。
    //
    // ★★ **出厂配置下不得默认启用它**（X1，真机实测的教训）：
    // **内置编辑器是唯一支持附件拖拽/粘贴上传的编辑器**——上传通道走宿主的
    // `MarkdownEditor` 的 `onUploadFiles`（`packages/web/src/pages/WikiPage.tsx`），
    // 而 `editor` 插槽的契约 `EditorSlotProps`（`packages/core/src/index.ts` 的权威副本 +
    // `packages/web/src/lib/slots.tsx` 的镜像）**不含任何上传字段**。
    // 由于 `editor` 是**单占用**插槽（`SINGLE_OCCUPANCY_SLOTS`），插件一旦占住它，
    // 内置编辑器就**根本不渲染** ⇒ 用户拖入文件时 0 个请求、无占位、无提示，
    // 而且浏览器默认动作会把窗口导航到被拖入的文件（未保存的正文一起丢）。
    // ⇒ **第三方/插件编辑器插槽在补上上传能力（契约加字段 + 两端镜像 + 守卫测试）之前，
    // 不得默认占用 `editor` 插槽**。本条目只登记、默认不启用，这条纪律靠本注释与
    // `EditorSlotOutlet` 里的兜底（阻止默认拖放 + `role="status"` 可见提示）双向兜住。
    //
    // 它的前端产物在 <webDist>/plugins-ui/@geewiki/editor-plain/（内置插件无自带产物根，
    // 见 resolvePluginUiRoots 的第二候选根），由 `pnpm --filter @geewiki/web build:fixtures` 生成。
    {
      name: '@geewiki/editor-plain',
      manifest: editorPlainManifest,
      module: EditorPlainPlugin,
      source: 'builtin',
    },
    // 「审计与运维」台面（2026-09-17 从宿主页面 `packages/web/src/pages/OpsPage.tsx` 搬来）。
    //
    // 它**不提供任何服务、不注册任何服务端路由** —— 台面上那 8 个端点分属 auth / authz / org，
    // 本插件只贡献一个前端页面（清单里的 `routes: [{ id: 'audit', … }]`）。
    // 这与 `@geewiki/editor-plain` 同形：服务端只有一个空 `apply`，故 supportsHotReload 为真。
    //
    // ⚠️ 搬迁时**两边必须同时改**：这里登记 + 基础层清单启用 + `audit` 从 RESERVED_ROUTE_IDS 移出。
    // 只改一边的两种后果都是静默的（要么声明被按"保留 id"整条拒绝，要么宿主旧分支永远赢），
    // 故 `packages/web/test/opsOwnership.test.ts` 把这三种残留逐条钉住。
    {
      name: '@geewiki/ops',
      manifest: opsManifest as GeeWikiManifest,
      module: OpsPlugin,
      source: 'builtin',
    },
    // LLM 契约插件：提供 llm-service（route→provider 注册表 + 终止保证 + 无 key 降级），
    // **并且是"模型接入"的唯一配置面**（服务商/端点/密钥/模型/上下文长度/最长输出/思考强度）。
    // requires 只点名 http-service（配置表单的服务商下拉走 `GET /api/llm/providers`）；
    // **不进 conflictGroup**：它是注册表而非某个厂商的实现，多家 provider 应共存。
    // **本批起写进默认基础层清单**：出厂即让用户在「插件管理 → 模型接入」里填一次就能接上模型
    // （不填密钥时问答与辅助写作**明确报不可用**——`retrieval-only` 抽取式摘要那条冒充答案的路已随本批删除，见 `docs/design/ai-plugin-architecture.md`）；需要 LLM 的插件仍应在 requires 里点名它。
    { name: '@geewiki/llm', manifest: llmManifest as GeeWikiManifest, module: LlmPlugin, source: 'builtin' },
    // 全文检索：索引表由插件自带迁移建立（按方言声明——只有 SQLite 有 FTS5；
    // 该插件在其它方言下会在 apply 里显式拒绝，见其源码的能力守卫）。
    // 注册表数组序不影响激活顺序——管理器按 requires 拓扑排序激活（database-provider /
    // http-service 必先于本插件），故这里只需登记 + 声明迁移目录。
    {
      name: '@geewiki/search',
      manifest: searchManifest as GeeWikiManifest,
      module: SearchPlugin,
      // 声明在 manifest.geewiki.migrations（'./migrations'）；此处给出的绝对目录仅作回退
      migrationsDirs: builtinMigrations(searchManifest as GeeWikiManifest, { sqlite: SEARCH_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    {
      name: '@geewiki/wiki',
      manifest: wikiManifest as GeeWikiManifest,
      module: WikiPlugin,
      // 该包的 manifest 显式写了 `migrations: undefined`（它原本在 apply() 里自行 migrate）；
      // 这里由**管理器代迁**：两者幂等共存（db.migrate() 以 _migrations 去重、逐脚本单事务）。
      // 插件侧自调的移除留待后续批次（本批不可改 plugin-wiki）。
      migrationsDirs: builtinMigrations(wikiManifest as GeeWikiManifest, { sqlite: WIKI_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    // 内置文档：把"关于本项目自身"的文章（架构/功能/Markdown/特殊结构）作为**真实
    // wiki 页面**在首次部署时生成。三条设计红线见 `packages/plugin-builtin-docs/src/index.ts`
    // 文件头；**只读与隐藏的判据不在本包也不在 wiki，在 policy-service**（授权判据
    // 唯一出口，`buildAccess` 每次判定现取 `builtin-docs-service`）——所以这里没有
    // "锁页"逻辑，wiki 也不知道有这回事。requires 只有 database-provider 与
    // wiki-service：**没有端点、没有前端**，文档的读写走 wiki 自己的路由。
    {
      name: '@geewiki/builtin-docs',
      manifest: builtinDocsManifest as GeeWikiManifest,
      module: BuiltinDocsPlugin,
      // 迁移是方言中立的键值表（builtin_docs_state），manifest 的 './migrations' 对所有
      // dialect 生效；此处同样给一份 sqlite 回退（registry 与 manifest 双真源钉住的纪律）。
      migrationsDirs: builtinMigrations(builtinDocsManifest as GeeWikiManifest, { sqlite: DOCS_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    // AI 工具总线（L0）：提供 ai-tool-service，**纯注册表、不含任何具体工具**。
    // 它必须能被最先激活——工具提供者（ai-kb 等）按 `requires: ['ai-tool-service']`
    // 依赖它，而依赖边由 deps.ts 解析并保证激活顺序。
    // 为什么不塞进会话核心：见 packages/plugin-ai-tools/src/index.ts 文件头（三条理由，
    // 第一条就是插槽那批的实测教训——提供者必须先结算，否则子插件 ctx.get() 拿到 undefined
    // 并**静默跳过**自己的贡献）。
    {
      name: '@geewiki/ai-tools',
      manifest: aiToolsManifest as GeeWikiManifest,
      module: AiToolsPlugin,
      source: 'builtin',
    },
    // AI 变更日志（P4，L0 平台能力）：提供 ai-journal-service。
    // 记下 AI 的每一次写操作（工具 + 目标 + 改变前后的文本快照），并按"轮"回退。
    //
    // 为什么它是**独立插件**而不是塞进 ai-tools 或 ai-assistant：写操作横跨多个域
    // （页面正文、编辑器草稿、插件启停、插件配置），而"哪个域怎么改回去"必须由**各域自己**
    // 提供撤销执行体（`registerUndoer`）——journal 一旦认识业务域，它就变成第二个 wiki，
    // 两份判据必然漂移（本仓为这条付过代价：正文里看不到、附件却能下载）。
    //
    // requires 只有 http-service 与 database-provider，**不依赖 llm / ai-tools**：
    // 它是被工具调用的下游，反过来依赖调用方会成环。
    {
      name: '@geewiki/ai-journal',
      manifest: aiJournalManifest as GeeWikiManifest,
      module: AiJournalPlugin,
      // 只登记 sqlite：这条迁移用了 AUTOINCREMENT 与部分索引（`WHERE undone_at IS NULL`），
      // 是 SQLite 方言。给它编一份 PG 目录等于凭空多一个没人验过的真源。
      // 整条 AI 链路本来就是 SQLite-only（`@geewiki/search` 在非 sqlite 方言下直接抛错）。
      migrationsDirs: builtinMigrations(aiJournalManifest as GeeWikiManifest, { sqlite: JOURNAL_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    // AI 知识库工具（L2 工具提供者）：把 list_pages / search_kb / read_page 三条工具
    // 注册进工具总线。**不含检索算法、不碰数据库**——只包装 search-service 与 wiki-service
    // 这两个已经按主体裁剪过的服务。三者都是只读工具（无 mutating 标记），
    // 故不受 P4 的 mutation journal 与自锁护栏约束。
    {
      name: '@geewiki/ai-kb',
      manifest: aiKbManifest as GeeWikiManifest,
      module: AiKbPlugin,
      source: 'builtin',
    },
    // AI 联网搜索（L2 工具提供者）：把 `web_search` 注册进工具总线，默认经 AnySearch 检索。
    //
    // 它不做权限判定、不碰数据库、不落任何状态——**唯一的行为就是一次出站 HTTP**，
    // 故没有迁移目录。与 ai-kb 的三条工具并列：那三条查站内，这一条查站外，
    // 差别在**每个结果声明的依据不同**（`grounding: 'kb'` vs `'web'`），
    // 界面据此给出不同措辞的标注（见 packages/plugin-ai-tools/src/types.ts 的 AiToolGrounding）。
    //
    // 未配置 API 密钥时走 AnySearch 的**匿名额度**（按来源 IP 计），所以"能装就能用"，
    // 不把密钥作为启用前提：密钥只是把额度从匿名提到账号（每天 1000 次）。
    {
      name: '@geewiki/ai-web-search',
      manifest: aiWebSearchManifest as GeeWikiManifest,
      module: AiWebSearchPlugin,
      source: 'builtin',
    },
    // AI 摘要（P6，需求 ③④）：跟着正文自动生成每页摘要、按摘要检索，并贡献
    // `article-summary` 插槽的那张折叠卡。
    //
    // 它是**第一个订阅 PAGE_SAVED_EVENT 的插件**——那条事件的契约（同步广播、不等待、
    // 订阅者自己吞异常）就是为它这类"保存后顺手做点别的"的消费者定的。
    // 六条 requires 里两条值得说明：
    // - `wiki-service`：读正文只能经它（带主体）。摘要**不碰数据库里的正文列**，
    //   否则就等于开出一条绕过可见性投影的读路径——而那正是 P4 尾刚补上的那条红线。
    // - `policy-service`：要问"这一页对谁可见"（`effectiveIndexLevel`）才知道该按哪一档
    //   投影来写摘要。拿不到判据就不该激活：那不是"少个功能"，是**摘要内容可能超出该页的可见范围**。
    {
      name: '@geewiki/ai-summary',
      manifest: aiSummaryManifest as GeeWikiManifest,
      module: AiSummaryPlugin,
      // 只登记 sqlite：`page_summaries` 用了 `ON DELETE CASCADE` 与 SQLite 的
      // ON CONFLICT(page_id) 写法（PG 也支持后者，但这份迁移从未在 PG 上跑过）。
      // 编一份没人验过的 PG 目录比不编更糟——`@geewiki/search` 的先例是**显式拒绝**。
      migrationsDirs: builtinMigrations(aiSummaryManifest as GeeWikiManifest, { sqlite: SUMMARY_MIGRATIONS_DIR }),
      source: 'builtin',
    },
    // AI 页面写工具（P4）：贡献 page.update —— **本仓第一条 mutating 工具**。
    // 它是"变更日志真的有人往里记"的那一半：没有写工具，journal 永远是一张空表。
    //
    // 四条 requires 都是必需的，其中两条是刻意的：
    // - `policy-service`：`wiki-service.save()` **不带主体**（授权发生在 HTTP 处理器里），
    //   所以工具必须自己向策略层要一次 `canEdit`。拿不到判据就不该能激活——
    //   否则"没有权限判据"会退化成"没有权限检查"。
    // - `ai-journal-service`：**记不下来就别改**（决策 3）。日志缺席时这条工具不注册，
    //   而不是照改然后留下一批不可回退的改动。
    {
      name: '@geewiki/ai-pages',
      manifest: aiPagesManifest as GeeWikiManifest,
      module: AiPagesPlugin,
      source: 'builtin',
    },
    // AI 编辑框工具（P3）：贡献 editor.read_doc / read_selection / insert_text /
    // replace_selection 四条 **side:'client'** 描述符。**它原先叫 @geewiki/ai-assist**，
    // 自带续写/改写/润色/摘要四个按钮与 `editor-toolbar` 插槽的前端；决策 18 把那套 UI
    // 连同 POST /api/ai/assist 端点整份删除（同一件事有两条界面路径时，两条都会漂移）。
    //
    // 现在它是**纯贡献者**：不 provide 服务、没有 HTTP 端点、没有前端产物，只声明四条工具名。
    // 执行体在浏览器（宿主 `lib/editorTools.ts` 登记）——工具本来就是"服务端说它存在、
    // 浏览器说它怎么跑"两半，故 requires 只有 ai-tool-service。
    {
      name: '@geewiki/ai-writing',
      manifest: aiWritingManifest as GeeWikiManifest,
      module: AiWritingPlugin,
      source: 'builtin',
    },
    // AI 页面跳转工具（P5）：贡献 open_page / scroll_to 两条 **side:'client'** 描述符，
    // 处理器由宿主在 `packages/web/src/lib/navTools.ts` 登记（同 ai-writing 的"两半"形态）。
    // 它们回答需求 ② 的后半句「也能自行找其他页」——`search_kb` 只能给出 slug，用户还停在原地。
    // **不是 mutating**：跳转与滚动改的不是数据，刷新即回原位，也不需要"撤销"
    // （标了会让回退 UI 上多出两条点了没反应的条目）。
    // AI 管理台工具（P5）：让助手在**护栏**约束下启停插件、读写插件配置。
    // 它是 `checkSelfLock` 的第一个真实消费者——P4 的注释里就写着"启停工具本身要到 P5
    // 才存在，届时 targetsOf(args) 由那个工具交出目标名"。
    //
    // requires 里**刻意没有 manager**：管理器是引导期直接 app.plugin() 装载的，
    // 不在注册表里、也就没有 provides 可供依赖解析匹配；声明它只会让本插件因
    // "依赖无法解析"而激活失败。真正的取用发生在执行期（那时 'manager' 早已 provide）。
    {
      name: '@geewiki/ai-admin',
      manifest: aiAdminManifest as GeeWikiManifest,
      module: AiAdminPlugin,
      source: 'builtin',
    },
    {
      name: '@geewiki/ai-nav',
      manifest: aiNavManifest as GeeWikiManifest,
      module: AiNavPlugin,
      source: 'builtin',
    },
    // AI 助手会话核心（L1）：agent loop + 系统提示 + 预算，**本身不含任何检索逻辑**——
    // 它只按名字调用工具总线里的工具（ai-kb 的三条即由此进来）。
    // requires 点名三个**服务 token**：http（端点）、llm（模型）、ai-tool-service（工具总线）。
    // 工具总线缺席时它会退化成普通聊天，但那是**降级**而非设计形态，故仍声明依赖，
    // 让卸载 ai-tools 时被依赖图拦住，而不是留下一个"看起来还在、其实查不了"的助手。
    // 自带 `app-dock` 插槽的前端（底部常驻输入条），且该插槽必须归按需加载——
    // 否则匿名读者也会下载整套对话 bundle（见设计文档 §3.4.1 第 ② 条）。
    {
      name: '@geewiki/ai-assistant',
      manifest: aiAssistantManifest as GeeWikiManifest,
      module: AiAssistantPlugin,
      source: 'builtin',
    },
    // OpenAI 兼容 adapter（第一个真实 provider）：只往 llm-service 注册一条路由，故**无 provides**；
    // requires 点名 llm-service（服务 token，不是插件名），由管理器保证注册表先就绪。
    // **本批起无自己的配置**（configSchema 是零字段 schema）：端点/密钥/模型/上下文长度都在
    // @geewiki/llm 的统一配置里；也**撤掉了 conflictGroup 'llm-provider'**——多个适配器现在是
    // 并列的可选服务商（由 provider 字段单选），同时启用是正常需求而非冲突。
    // **本批起写进默认基础层清单**：没有密钥时它只是注册一条不可用的路由（问答照旧降级），
    // 而默认启用意味着用户在「模型接入」里选服务商时下拉里已经有它。
    { name: '@geewiki/openai', manifest: openAiManifest as GeeWikiManifest, module: OpenAiPlugin, source: 'builtin' },
    // OIDC / 企业 SSO adapter：只往 auth-service 注册一条 provider 并把 /api/auth/oidc/* 两条
    // 路由挂上，故**无 provides**；requires 点名 auth-service（账号策略与 provider 注册表都在那里）、
    // http-service、database-provider（协议环节的失败要落 audit_log）。
    // conflictGroup 'oidc-provider'：与将来的第二个 IdP adapter 同组互斥。
    // 与 @geewiki/echo / @geewiki/editor-plain 同形态：**只登记、不写进默认基础层清单**
    // （已注册但未启用）—— 它需要外部 IdP 才有意义。未启用时 /api/auth/oidc/* 根本不存在（404），
    // 本地密码通道完全不受影响（这是"无外部依赖 / 离线可用"承诺的落点）。
    { name: '@geewiki/oidc', manifest: oidcManifest as GeeWikiManifest, module: OidcPlugin, source: 'builtin' },
  ]
}

/**
 * 内置注册表 + 外部插件目录发现（架构 §4）：外部插件来自 `<仓库根>/plugins/<name>/`，
 * 加载失败/清单缺失/重名/路径越界只记为 issue 并跳过，绝不阻断宿主启动。
 * 外部插件不得与内置插件重名（重名者跳过并告警）。
 *
 * 返回 `{ registry, issues }`：issues 不是被丢弃的副产品，它会经 ManagerConfig 透出到
 * `GET /api/plugins` 的 `issues` 字段，让"目录里躺着但没被加载"的插件在管理台可见。
 */
export async function buildRegistry(
  webDist: string | null,
  defaults: HttpEntryDefaults = {},
  pluginsRoot: string | null = null,
  pluginUiRoots?: () => Record<string, string>,
): Promise<RegistryBuildResult> {
  const builtin = defaultRegistry(webDist, defaults, pluginUiRoots)
  if (!pluginsRoot) return { registry: builtin, issues: [] }
  const discovered = await loadExternalPlugins({
    root: pluginsRoot,
    builtinNames: builtin.map((p) => p.name),
  })
  return { registry: [...builtin, ...discovered.plugins], issues: discovered.issues }
}

/** 启动应用宿主：引导插件管理器（管理器按双层清单激活全部插件）。返回清理句柄。 */
export async function startServer(options: ServerOptions = {}): Promise<{ app: Context; dispose: () => Promise<void> }> {
  const app = new Context()
  // 监听地址来源优先级：options > GEEWIKI_PORT/GEEWIKI_HOST 环境变量 > 内置默认（3000 / 0.0.0.0）
  const port = options.port ?? Number(process.env.GEEWIKI_PORT ?? DEFAULT_PORT)
  const host = options.host ?? process.env.GEEWIKI_HOST ?? '0.0.0.0'
  const configDir = options.configDir ?? process.env.GEEWIKI_CONFIG_DIR ?? 'config'
  // 静态产物目录：options > GEEWIKI_WEB_DIST > 默认（仓库根 packages/web/dist）；
  // 相对路径一律以仓库根为基准（绝对路径原样透传），null 表示不启用静态服务
  let webDist: string | null
  if (options.webDist !== undefined) {
    webDist = options.webDist === null ? null : resolveProjectPath(options.webDist, import.meta.url)
  } else if (process.env.GEEWIKI_WEB_DIST) {
    webDist = resolveProjectPath(process.env.GEEWIKI_WEB_DIST, import.meta.url)
  } else {
    webDist = resolveProjectPath('packages/web/dist', import.meta.url)
  }
  // 插件 UI 内置资产根：options > GEEWIKI_PLUGIN_UI_DIST > **缺省回落 webDist**（与拆分前行为一致）。
  // 拆成独立配置项是为了解除 webDist 的职责过载：dev 曾把 webDist 指向 packages/web/public
  // 以让插件 UI 免构建可用，但那里没有 index.html → app shell 的 SPA fallback 失败、首页 404。
  let pluginUiDist: string | null
  if (options.pluginUiDist !== undefined) {
    pluginUiDist =
      options.pluginUiDist === null ? null : resolveProjectPath(options.pluginUiDist, import.meta.url)
  } else if (process.env.GEEWIKI_PLUGIN_UI_DIST) {
    pluginUiDist = resolveProjectPath(process.env.GEEWIKI_PLUGIN_UI_DIST, import.meta.url)
  } else {
    pluginUiDist = webDist
  }
  // 外部插件目录：options > GEEWIKI_PLUGINS_DIR > 仓库根下 plugins/；
  // null 表示不做外部插件发现（测试与最小部署可用）
  const pluginsRoot =
    options.pluginsDir === null
      ? null
      : resolveProjectPath(options.pluginsDir ?? process.env.GEEWIKI_PLUGINS_DIR ?? 'plugins', import.meta.url)
  if (pluginsRoot) console.log(`[server] 外部插件目录: ${pluginsRoot}`)
  // 便于排障：内置插件 UI 根与静态产物根常不同（dev 就是这种形态），分开打印
  if (pluginUiDist) {
    console.log(
      `[server] 插件 UI 内置资产根: ${pluginUiDist}${pluginUiDist === webDist ? '（同静态产物根）' : ''}`,
    )
  }

  // 注册表来源：显式传入的 registry 优先（issues 为空），否则内置 + 外部插件发现。
  //
  // 插件 UI 根表存在"先后依赖"：它要读**已完成**的注册表（外部插件的 dir 来自发现阶段），
  // 而它的闭包又必须在此之前交给 http 条目。因此用可变持有者打破循环——闭包在
  // http 插件首次处理 `/plugins-ui` 请求时求值，那时 builtRef 必定已赋值。
  let builtRef: RegistryBuildResult | null = null
  const pluginUiRoots = (): Record<string, string> =>
    pluginUiRootsFor(builtRef?.registry ?? [], pluginUiDist)
  const built: RegistryBuildResult = options.registry
    ? { registry: options.registry, issues: [] }
    : await buildRegistry(webDist, { port, host }, pluginsRoot, pluginUiRoots)
  builtRef = built

  // 插槽服务插件**必须先于管理器装载**。
  //
  // 理由是实测出来的：最初把 `provide('slot', …)` 放在管理器的 apply 开头、再 boot()，
  // 结果插件 apply 里 `ctx.get('slot')` 是 **undefined**，它的运行期贡献被静默跳过
  // ——**在一个插件 apply 尚未结算时 provide 的服务，对它在此期间创建的子插件不可见**，
  // 而 boot() 恰恰是在管理器的 apply 内部激活插件。前移为独立插件后它的 apply 先结算，
  // 服务即对管理器及其 boot 出来的插件可见（与 db-sqlite / http 作为兄弟插件同理）。
  await app.plugin(slotPlugin)

  // ★ F9：能力服务插件**同样必须先于管理器装载**（理由与上一段逐字相同，实测同源）：
  // 若由管理器在自己 apply 里 provide，插件 apply 期的 `ctx.get('capability-service')`
  // 是 undefined，它的能力注册会被**静默跳过** —— 那是一道永远 403 的闸门 + 干净得可疑的日志。
  await app.plugin(capabilityPlugin)

  const managerFiber = await app.plugin(PluginManagerPlugin, {
    registry: built.registry,
    // 发现期问题（跳过的插件目录等）透出到 GET /api/plugins 的 issues 字段
    discoveryIssues: built.issues,
    // ★ F17：插件目录的解析规则在这里有唯一实现，故由组合根传给管理器（供完整性校验用）
    pluginsDir: pluginsRoot,
    // 清单路径以仓库根为基准（与进程工作目录无关，见 resolveProjectPath）
    baseFile: resolveProjectPath(join(configDir, 'plugins.base.json'), import.meta.url),
    sessionFile: resolveProjectPath(join(configDir, 'plugins.session.json'), import.meta.url),
    // `role: 'secret'` 字段（如模型 API 密钥）的落盘位置：与清单同目录，已被 .gitignore 忽略，
    // 绝不写进入库的 plugins.*.json（见 packages/manager/src/secrets.ts 的文件头）
    secretsFile: resolveProjectPath(join(configDir, 'secrets.json'), import.meta.url),
    crashMarkerFile,
    // 入口表的第二候选根（<pluginUiDist>/plugins-ui/<名>）；第一候选根是插件自带的 <dir>/dist
    webDist,
    pluginUiDist,
  })

  /*
   * ★ F11：**全路由审计**必须在管理器结算之后跑 —— 路由是在各插件的 `apply` 里注册的，
   * 而插件由管理器在这一步之前 boot 出来。放在更早的位置会审计到一张空表，
   * 于是"审计通过"与"什么都没审计"变得无法区分（这正是审计类代码最容易变成摆设的方式）。
   */
  const routerForAudit = app.get('http') as HttpRouterServiceType | undefined
  if (routerForAudit) auditRouteAccess(routerForAudit)

  return {
    app,
    dispose: async () => {
      await managerFiber.dispose()
    },
  }
}

/* =========================== 入口（直接运行） =========================== */

async function main(): Promise<void> {
  // 崩溃自愈（架构 §5.3）：致命异常 → 记录崩溃标记后退出（退出码 1）。
  // 下次启动 manager boot 检测到标记即忽略会话层（Session），回滚至基础层，
  // 防止"会话插件导致崩溃 → 重启 crash-loop"。优雅退出（disposeAll 成功）会删除标记。
  const fatal = (kind: string) => (err: unknown): void => {
    console.error(`[server] ${kind}:`, err)
    try {
      writeCrashMarker(crashMarkerFile, `${kind}: ${err instanceof Error ? err.message : String(err)}`)
    } catch (markerErr) {
      console.error('[server] 写崩溃标记失败:', markerErr)
    }
    process.exit(1)
  }
  process.on('uncaughtException', fatal('uncaughtException'))
  process.on('unhandledRejection', fatal('unhandledRejection'))

  let handle: { dispose: () => Promise<void> }
  try {
    handle = await startServer()
  } catch (err) {
    console.error('[server] 启动失败:', err)
    try {
      writeCrashMarker(crashMarkerFile, `startup: ${err instanceof Error ? err.message : String(err)}`)
    } catch {
      /* 标记写入失败不阻断退出 */
    }
    process.exit(1)
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] 收到 ${signal}，正在优雅退出...`)
    try {
      await handle.dispose()
      removeCrashMarker(crashMarkerFile)
      console.log('[server] 已清理全部插件，退出')
      process.exit(0)
    } catch (err) {
      console.error('[server] 退出清理失败', err)
      process.exit(1)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 仅当本文件作为入口被执行时启动（被 import 时不自动启动，便于测试）
const entry = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : null
if (entry && entry === fileURLToPath(import.meta.url)) {
  main()
}
