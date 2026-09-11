/**
 * 测试共用 helper（server 包）。
 *
 * 与 `router.test.ts` 内的同名实现**刻意重复**：那个文件的断言与夹具已经稳定，
 * 抽取会碰到它、风险大于收益（本次改动的纪律是"不得改动既有断言"）。
 * 新用例从这里取 helper。
 */
import { createServer } from 'node:net'

export const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** 取一个空闲端口（listen 0 后立即释放）：测试内固定端口易与他人的 3000/5173 冲突 */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.on('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      if (!port) {
        rejectPort(new Error('无法获取空闲端口'))
        return
      }
      probe.close(() => resolvePort(port))
    })
  })
}

/** 轮询 /api/health 直至就绪（避免测试与启动竞争） */
export async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      await res.arrayBuffer() // 消费响应体，避免 undici 连接悬挂
      if (res.status === 200) return
    } catch (err) {
      lastError = err
    }
    await sleep(25)
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪: ${String(lastError)}`)
}

/* ------------------------------ P0：应急通道 ------------------------------ */

/**
 * 测试用应急令牌。
 *
 * 为什么需要它：P0 把管理端点与条目写端点收进了访问等级闸门（`admin` / `user`），
 * 而 P0 **唯一**的凭据来源就是环境变量 `GEEWIKI_ADMIN_TOKEN`（用户会话属 P1）。
 * 测试若要调用这些端点，就必须显式扮演应急通道——即"设置环境变量 + 带令牌头"两步。
 *
 * 这两步**刻意不放进本模块顶层**：那会给所有 import 本文件的测试隐式开启应急通道，
 * 让"未配置令牌时必须 503"这类用例静默变成假通过。
 */
export const ADMIN_TOKEN = 'p0-test-break-glass-token'

/** 构造带应急令牌头的请求头（须与已设置的 `GEEWIKI_ADMIN_TOKEN` 配套使用） */
export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-gw-admin-token': ADMIN_TOKEN, ...extra }
}
