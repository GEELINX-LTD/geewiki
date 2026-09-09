/**
 * @geewiki/server —— GeeWiki 组合根（应用宿主）
 *
 * 职责：
 * 1. 创建 cordis 应用（Context）并装配基础插件（当前为 @geewiki/db-sqlite）；
 * 2. 提供 HTTP 服务（node:http 极简 JSON 路由）与健康检查端点；
 * 3. 处理 SIGINT/SIGTERM 优雅退出（先关 HTTP，再按逆序卸载插件 fiber）。
 *
 * Phase 1 起，装配将演进为"按插件清单（Base/Session 双层状态）驱动"，
 * 由插件管理器接管本文件中的装配职责。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { SqliteDbPlugin, type FiberLike } from '@geewiki/db-sqlite'
import { DEFAULT_PORT, HEALTH_PATH } from '@geewiki/core'

/* ============================== 工具 ============================== */

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/* =========================== HTTP 服务 ============================ */

export interface HttpConfig {
  port: number
  host?: string
}

/**
 * HTTP 服务插件：注册极简 JSON 路由表。
 * 不声明 inject: ['db']——健康检查需容忍 db 缺失（降级报告而非启动失败）。
 */
export const HttpPlugin = {
  name: '@geewiki/http',

  apply(ctx: Context, config: HttpConfig) {
    const startedAt = Date.now()
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const method = req.method ?? 'GET'

      // GET /api/health —— 看门狗探针端点：报告进程与数据库健康度
      if (method === 'GET' && url.pathname === HEALTH_PATH) {
        const db = ctx.get('db')
        const health = {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
          db: db
            ? { present: true, tables: db.listTables(), migrations: db.appliedMigrations() }
            : { present: false },
        }
        json(res, 200, health)
        return
      }

      json(res, 404, { error: 'not_found', path: url.pathname })
    })

    server.on('error', (err) => {
      console.error('[@geewiki/http] 监听失败:', err)
    })

    server.listen(config.port, config.host, () => {
      const shown = config.host === '0.0.0.0' ? '127.0.0.1' : (config.host ?? '127.0.0.1')
      console.log(`[@geewiki/http] 服务已启动: http://${shown}:${config.port}`)
    })

    return () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
  },
}

/* ============================ 组合根 ============================= */

export interface ServerOptions {
  port?: number
  host?: string
}

/** 启动应用宿主：装配插件并监听端口。返回清理句柄。 */
export async function startServer(options: ServerOptions = {}): Promise<{ app: Context; dispose: () => Promise<void> }> {
  const app = new Context()
  const port = options.port ?? Number(process.env.GEEWIKI_PORT ?? DEFAULT_PORT)
  const host = options.host ?? '0.0.0.0'

  // 装配顺序：db-sqlite 在前（无依赖），HTTP 在后
  const fibers: FiberLike[] = []
  fibers.push(await app.plugin(SqliteDbPlugin))
  fibers.push(await app.plugin(HttpPlugin, { port, host }))

  return {
    app,
    dispose: async () => {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
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
