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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  HEALTH_PATH,
  normalizeRuntime,
  resolveProjectPath,
  type GeeWikiManifest,
  type HttpRouterService,
  type HttpRouterStats,
  type RouteHandler,
  type RouteHandlerContext,
} from '@geewiki/core'
import { DB_SQLITE_MIGRATIONS_DIR, SqliteDbPlugin, manifest as dbSqliteManifest } from '@geewiki/db-sqlite'
import { EchoPlugin, manifest as echoManifest } from '@geewiki/echo'
import { WikiPlugin, manifest as wikiManifest } from '@geewiki/wiki'
import { PluginManagerPlugin, removeCrashMarker, writeCrashMarker, type RegisteredPlugin } from '@geewiki/manager'

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
    provides: 'http-service',
    requires: [],
    runtime: {
      supportsHotReload: false, // 核心通信层：冷操作，仅支持持久化安装 + 进程重启
      drainTimeout: 5,
    },
  },
}

interface RouteEntry {
  method: string
  /** 路径段：':xxx' 开头为参数段 */
  segments: string[]
  handler: RouteHandler
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

class HttpRouter implements HttpRouterService {
  private readonly routes: RouteEntry[] = []
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

  constructor(private readonly healthHandler: RouteHandler) {}

  register(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    handler: RouteHandler,
  ): () => void {
    const entry: RouteEntry = { method, segments: path.split('/').filter(Boolean), handler }
    this.routes.push(entry)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const idx = this.routes.indexOf(entry)
      if (idx >= 0) this.routes.splice(idx, 1)
    }
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
    }
  }

  inflight(): number {
    return this.inFlight
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
      let timer: NodeJS.Timeout | undefined
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
      timer = setTimeout(() => waiter.finish(false), timeoutMs)
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

  /** 请求分发入口（node:http server 回调）。返回 true 表示已接管响应（含 API 404），
   *  false 表示无匹配路由且非 /api 前缀（静态资源层可尝试兜底）。 */
  dispatch(req: IncomingMessage, res: ServerResponse): boolean {
    const started = Date.now()
    this.counters.total++
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = req.method ?? 'GET'
    const finish = (status: number): void => {
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

    // 内置健康检查（路由表之外常驻，保证看门狗探针永不因插件卸载而缺失）
    if (method === 'GET' && url.pathname === HEALTH_PATH) {
      const state: RequestState = { active: false }
      this.enterHandler(state)
      // 同步处理器：仍置于请求上下文中，保证下游（探针触发的卸载）视角一致
      this.requestScope.run(state, () => {
        try {
          this.healthHandler({ req, res, url, params: {}, json })
        } catch (err) {
          console.error('[http] 健康检查异常:', err)
          json(500, { ok: false, error: 'health_check_failed' })
        } finally {
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
    for (const route of this.routes) {
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
      const h: RouteHandlerContext = { req, res, url, params, json }
      // 在途登记：插件卸载前的优雅排空以"处理器是否结算"为准（同步处理器即刻结算）
      const state: RequestState = { active: false }
      this.enterHandler(state)
      // 处理器在请求上下文中执行：管理器于处理器内部调用 drain() 时才能排除自身
      this.requestScope.run(state, () => {
        try {
          const result: unknown = route.handler(h)
          if (isThenable(result)) {
            // Promise.resolve 兜住非原生 thenable（自定义 then）：结算时机正确，且 rejection 有人接管
            void Promise.resolve(result).then(
              () => this.exitHandler(state),
              (err: unknown) => {
                console.error(`[http] 路由 ${method} ${url.pathname} 异常:`, err)
                json(500, { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
                this.exitHandler(state)
              },
            )
          } else {
            this.exitHandler(state)
          }
        } catch (err) {
          console.error(`[http] 路由 ${method} ${url.pathname} 异常:`, err)
          json(500, { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
          this.exitHandler(state)
        }
      })
      return true
    }

    // 无路由匹配：/api 前缀按 API 404 处理；其余交给静态资源层（SPA fallback）
    if (url.pathname.startsWith('/api/')) {
      json(404, { ok: false, error: 'not_found', path: url.pathname })
      return true
    }
    return false
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
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

/**
 * 静态文件服务：优先精确文件；未命中且路径无扩展名时回退 index.html（SPA）。
 * 仅由 dispatch 返回 false 的请求进入（/api/* 已被路由层接管）。
 */
async function serveStatic(root: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const notFound = (): void => {
    if (res.headersSent) return
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'not_found' }))
  }
  if (!root || (req.method !== 'GET' && req.method !== 'HEAD')) {
    notFound()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  // 路径穿越防护：规范化后必须仍位于静态根内
  const file = isAbsolute(rel) ? '' : resolve(root, rel)
  if (!file || !file.startsWith(resolve(root))) {
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
    const router = new HttpRouter((h) => {
      const db = ctx.get('db')
      h.json(200, {
        ok: true,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
        db: db
          ? { present: true, tables: db.listTables(), migrations: db.appliedMigrations() }
          : { present: false },
      })
    })

    const server: Server = createServer((req, res) => {
      if (!router.dispatch(req, res)) {
        void serveStatic(config.webDist ?? null, req, res)
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
        // 优雅排空（架构 §5.1）：先等在途 API 请求结算，再关闭监听（超时强制关闭）
        const drainTimeoutMs = (config.drainTimeout ?? HTTP_DRAIN_TIMEOUT_SECONDS) * 1000
        void router
          .drain(drainTimeoutMs)
          .then((drained) => {
            if (!drained) {
              console.warn(
                `[@geewiki/http] 排空超时（${drainTimeoutMs}ms，仍有 ${router.inflight()} 个请求在途），强制关闭监听`,
              )
            }
            server.close(() => resolveClose())
          })
          .catch((err: unknown) => {
            console.error('[@geewiki/http] 排空异常:', err)
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
  registry?: RegisteredPlugin[]
}

/** startServer 传给 http 插件的启动期默认值（清单内未显式配置端口/地址时生效） */
export interface HttpEntryDefaults {
  port?: number
  host?: string
}

/**
 * 构造 `@geewiki/http` 的注册表条目：绑定静态根（webDist 经此处注入，避免进入持久化清单），
 * 并把启动期默认端口/地址带入插件配置。自定义注册表可复用它以获得同样的绑定行为。
 *
 * 优先级：清单（持久化）配置里的显式 `port`/`host` > 本处默认值（来自 startServer 的
 * `options ?? env ?? 内置默认`）> 插件内的环境变量兜底。
 */
export function httpRegistryEntry(webDist: string | null, defaults: HttpEntryDefaults = {}): RegisteredPlugin {
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
        })
      },
    },
  }
}

/** 内置插件注册表（default registry：服务器引导时注册的全部可管插件） */
export function defaultRegistry(webDist: string | null, defaults: HttpEntryDefaults = {}): RegisteredPlugin[] {
  return [
    {
      name: '@geewiki/db-sqlite',
      manifest: dbSqliteManifest as GeeWikiManifest,
      module: SqliteDbPlugin,
      migrationsDir: DB_SQLITE_MIGRATIONS_DIR,
    },
    httpRegistryEntry(webDist, defaults),
    { name: '@geewiki/echo', manifest: echoManifest as GeeWikiManifest, module: EchoPlugin },
    { name: '@geewiki/wiki', manifest: wikiManifest as GeeWikiManifest, module: WikiPlugin },
  ]
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

  const managerFiber = await app.plugin(PluginManagerPlugin, {
    registry: options.registry ?? defaultRegistry(webDist, { port, host }),
    // 清单路径以仓库根为基准（与进程工作目录无关，见 resolveProjectPath）
    baseFile: resolveProjectPath(join(configDir, 'plugins.base.json'), import.meta.url),
    sessionFile: resolveProjectPath(join(configDir, 'plugins.session.json'), import.meta.url),
    crashMarkerFile,
  })

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
