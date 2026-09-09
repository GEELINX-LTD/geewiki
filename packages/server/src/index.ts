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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import {
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
import { PluginManagerPlugin, type RegisteredPlugin } from '@geewiki/manager'

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

  /** 请求分发入口（node:http server 回调） */
  dispatch(req: IncomingMessage, res: ServerResponse): void {
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
      finish(status)
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      }
      res.end(JSON.stringify(body))
    }

    // 内置健康检查（路由表之外常驻，保证看门狗探针永不因插件卸载而缺失）
    if (method === 'GET' && url.pathname === HEALTH_PATH) {
      try {
        this.healthHandler({ req, res, url, params: {}, json })
      } catch (err) {
        console.error('[http] 健康检查异常:', err)
        json(500, { ok: false, error: 'health_check_failed' })
      }
      return
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
      return
    }

    json(404, { ok: false, error: 'not_found', path: url.pathname })
  }
}

export interface HttpConfig {
  port: number
  host?: string
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

    const server: Server = createServer((req, res) => router.dispatch(req, res))
    server.on('error', (err) => {
      console.error('[@geewiki/http] 监听失败:', err)
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
  registry?: RegisteredPlugin[]
}

/** 内置插件注册表（default registry：服务器引导时注册的全部可管插件） */
export function defaultRegistry(): RegisteredPlugin[] {
  return [
    {
      name: '@geewiki/db-sqlite',
      manifest: dbSqliteManifest as GeeWikiManifest,
      module: SqliteDbPlugin,
      migrationsDir: DB_SQLITE_MIGRATIONS_DIR,
    },
    { name: '@geewiki/http', manifest: httpManifest, module: HttpPlugin },
    { name: '@geewiki/echo', manifest: echoManifest as GeeWikiManifest, module: EchoPlugin },
  ]
}

/** 启动应用宿主：引导插件管理器（管理器按双层清单激活全部插件）。返回清理句柄。 */
export async function startServer(options: ServerOptions = {}): Promise<{ app: Context; dispose: () => Promise<void> }> {
  const app = new Context()
  const port = options.port ?? Number(process.env.GEEWIKI_PORT ?? DEFAULT_PORT)
  const host = options.host ?? '0.0.0.0'
  const configDir = options.configDir ?? process.env.GEEWIKI_CONFIG_DIR ?? 'config'

  const managerFiber = await app.plugin(PluginManagerPlugin, {
    registry: options.registry ?? defaultRegistry(),
    baseFile: resolve(configDir, 'plugins.base.json'),
    sessionFile: resolve(configDir, 'plugins.session.json'),
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
  const { dispose } = await startServer()

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] 收到 ${signal}，正在优雅退出...`)
    try {
      await dispose()
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
  main().catch((err) => {
    console.error('[server] 启动失败:', err)
    process.exitCode = 1
  })
}
