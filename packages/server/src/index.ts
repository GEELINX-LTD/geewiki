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
  normalizeRuntime,
  resolveProjectPath,
  type AnyDatabaseAdapter,
  type GeeWikiManifest,
  type HttpRouterService,
  type HttpRouterStats,
  type RouteHandler,
  type RouteHandlerContext,
} from '@geewiki/core'
import { DB_SQLITE_MIGRATIONS_DIR, SqliteDbPlugin, manifest as dbSqliteManifest } from '@geewiki/db-sqlite'
import { AiPlugin, manifest as aiManifest } from '@geewiki/ai'
import { EchoPlugin, manifest as echoManifest } from '@geewiki/echo'
import { EditorPlainPlugin, manifest as editorPlainManifest } from '@geewiki/editor-plain'
import { LlmPlugin, manifest as llmManifest } from '@geewiki/llm'
import { OpenAiPlugin, manifest as openAiManifest } from '@geewiki/openai'
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

    // 内置健康检查（路由表之外常驻，保证看门狗探针永不因插件卸载而缺失）
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
      const h: RouteHandlerContext = { req, res, url, params, json, noteStatus }
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
    })

    const server: Server = createServer((req, res) => {
      if (!router.dispatch(req, res)) {
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
    { name: '@geewiki/echo', manifest: echoManifest as GeeWikiManifest, module: EchoPlugin, source: 'builtin' },
    // 纯文本编辑器：`editor` 插槽的第一个真实消费者（证明"插件可替换编辑器"这条扩展点可用）。
    // **只登记、不写进基础清单**——它替换的是默认编辑器，是否替换应由使用者显式决定；
    // 未启用时编辑页走内置 CodeMirror（回落路径已端到端覆盖）。
    // 它的前端产物在 <webDist>/plugins-ui/@geewiki/editor-plain/（内置插件无自带产物根，
    // 见 resolvePluginUiRoots 的第二候选根），由 `pnpm --filter @geewiki/web build:fixtures` 生成。
    {
      name: '@geewiki/editor-plain',
      manifest: editorPlainManifest,
      module: EditorPlainPlugin,
      source: 'builtin',
    },
    // LLM 契约插件：提供 llm-service（route→provider 注册表 + 终止保证 + 无 key 降级）。
    // **不声明 requires**：它自身零依赖，没有 provider 时也能装载并给出可迭代的降级流；
    // **不进 conflictGroup**：它是注册表而非某个厂商的实现，多家 provider 应共存。
    // 与 @geewiki/echo 同形态：**只登记、不写进默认基础层清单**，即"已注册但未启用"，
    // 由使用者在管理台按需热启用（需要 LLM 的插件应在自己的 requires 里点名它）。
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
    // AI 问答（检索增强问答的检索-only 形态）：提供 ai-service。
    // requires 点名 search-service 与 llm-service 两个**服务**（不是插件名），故管理器会保证
    // 检索与模型契约层先激活；**没有模型也能用**——无 provider 时降级为检索结果 + 抽取式摘要，
    // 这正是产品承诺"没有 API key 时也完整可用"的落点。
    // 与 @geewiki/echo / @geewiki/llm 同形态：**只登记、不写进默认基础层清单**（已注册未启用），
    // 由使用者在管理台按需热启用；是否默认启用见 docs 的部署建议。
    { name: '@geewiki/ai', manifest: aiManifest as GeeWikiManifest, module: AiPlugin, source: 'builtin' },
    // OpenAI 兼容 adapter（第一个真实 provider）：只往 llm-service 注册一条路由，故**无 provides**；
    // requires 点名 llm-service（服务 token，不是插件名），由管理器保证注册表先就绪。
    // conflictGroup 'llm-provider'：与将来的其它厂商 adapter 同组互斥——这正是该冲突组的用途。
    // 与 @geewiki/llm / @geewiki/ai 同形态：**只登记、不写进默认基础层清单**（已注册未启用）——
    // 它需要外部提供凭据才有意义，且与其它 provider 互斥，属于"按需显式启用"的插件。
    { name: '@geewiki/openai', manifest: openAiManifest as GeeWikiManifest, module: OpenAiPlugin, source: 'builtin' },
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

  const managerFiber = await app.plugin(PluginManagerPlugin, {
    registry: built.registry,
    // 发现期问题（跳过的插件目录等）透出到 GET /api/plugins 的 issues 字段
    discoveryIssues: built.issues,
    // 清单路径以仓库根为基准（与进程工作目录无关，见 resolveProjectPath）
    baseFile: resolveProjectPath(join(configDir, 'plugins.base.json'), import.meta.url),
    sessionFile: resolveProjectPath(join(configDir, 'plugins.session.json'), import.meta.url),
    crashMarkerFile,
    // 入口表的第二候选根（<pluginUiDist>/plugins-ui/<名>）；第一候选根是插件自带的 <dir>/dist
    webDist,
    pluginUiDist,
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
