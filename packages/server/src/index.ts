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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  HEALTH_PATH,
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

/** 崩溃标记路径：与数据库文件同目录（<GEEWIKI_DATA_DIR 或 ./data>），随 data/ 一起被 gitignore */
const crashMarkerFile = resolve(process.env.GEEWIKI_DATA_DIR ?? DEFAULT_DATA_DIR, 'crash.marker')

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

class HttpRouter implements HttpRouterService {
  private readonly routes: RouteEntry[] = []
  private readonly counters = { total: 0, ok: 0, fail: 0, consecutiveFailures: 0 }
  private msHistory: number[] = []
  private lastMs = 0

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
      try {
        this.healthHandler({ req, res, url, params: {}, json })
      } catch (err) {
        console.error('[http] 健康检查异常:', err)
        json(500, { ok: false, error: 'health_check_failed' })
      }
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
      try {
        const result = route.handler(h)
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`[http] 路由 ${method} ${url.pathname} 异常:`, err)
            json(500, { ok: false, error: 'internal', message: (err as Error).message })
          })
        }
      } catch (err) {
        console.error(`[http] 路由 ${method} ${url.pathname} 异常:`, err)
        json(500, { ok: false, error: 'internal', message: (err as Error).message })
      }
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
}

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
    })

    const unprovide = ctx.provide('http', router)
    return () =>
      new Promise<void>((resolveClose) => {
        unprovide()
        server.close(() => resolveClose())
      })
  },
}

/* ============================ 组合根 ============================= */

export interface ServerOptions {
  port?: number
  host?: string
  /** 插件清单目录（默认取 GEEWIKI_CONFIG_DIR 或 ./config） */
  configDir?: string
  /** 前端静态产物目录（默认 GEEWIKI_WEB_DIST 或仓库根 packages/web/dist） */
  webDist?: string | null
  registry?: RegisteredPlugin[]
}

/** 绑定静态根后的 http 插件模块（webDist 经注册表注入，避免进入持久化清单） */
function httpModuleWith(webDist: string | null): { name: string; apply: (ctx: Context, config?: Partial<HttpConfig>) => unknown } {
  return {
    name: '@geewiki/http',
    apply(ctx: Context, config: Partial<HttpConfig> = {}) {
      return HttpPlugin.apply(ctx, { ...config, webDist })
    },
  }
}

/** 内置插件注册表（default registry：服务器引导时注册的全部可管插件） */
export function defaultRegistry(webDist: string | null): RegisteredPlugin[] {
  return [
    {
      name: '@geewiki/db-sqlite',
      manifest: dbSqliteManifest as GeeWikiManifest,
      module: SqliteDbPlugin,
      migrationsDir: DB_SQLITE_MIGRATIONS_DIR,
    },
    { name: '@geewiki/http', manifest: httpManifest, module: httpModuleWith(webDist) },
    { name: '@geewiki/echo', manifest: echoManifest as GeeWikiManifest, module: EchoPlugin },
    { name: '@geewiki/wiki', manifest: wikiManifest as GeeWikiManifest, module: WikiPlugin },
  ]
}

/** 启动应用宿主：引导插件管理器（管理器按双层清单激活全部插件）。返回清理句柄。 */
export async function startServer(options: ServerOptions = {}): Promise<{ app: Context; dispose: () => Promise<void> }> {
  const app = new Context()
  const port = options.port ?? Number(process.env.GEEWIKI_PORT ?? DEFAULT_PORT)
  const host = options.host ?? '0.0.0.0'
  const configDir = options.configDir ?? process.env.GEEWIKI_CONFIG_DIR ?? 'config'
  const webDist = options.webDist !== undefined
    ? options.webDist
    : (process.env.GEEWIKI_WEB_DIST ?? resolve('packages/web/dist'))

  const managerFiber = await app.plugin(PluginManagerPlugin, {
    registry: options.registry ?? defaultRegistry(webDist),
    baseFile: resolve(configDir, 'plugins.base.json'),
    sessionFile: resolve(configDir, 'plugins.session.json'),
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
