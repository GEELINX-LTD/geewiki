/**
 * SSE（Server-Sent Events）**帧协议与长连接生命周期**的平台级辅助。
 *
 * ## 为什么在 core 而不在某个插件里
 * 与 `./audit.ts` 同一条理由：**写入方横跨多个包**。本批起至少有两个插件要写 SSE
 * （`@geewiki/ai-qa` 的问答流、`@geewiki/ai-assistant` 的轮次流），而这段逻辑里
 * 每一行都在防一个**已经实测踩过或明确预见**的坑：
 *
 * - 终止闩锁（终止帧之后再写会破坏协议，而客户端已经收摊）；
 * - 写前存活检查（客户端随时可能断开，`res.write` 会抛错或静默失败）；
 * - 空闲超时与硬超时**两个**计时器（一个管"上游不发数据了"，一个管"整条流总时长"）；
 * - `data` 字段按规范逐行拆分（否则内容里的裸换行会打乱帧边界）。
 *
 * 两份实现必然漂移，而漂移的表现是**偶发的挂死连接**——最难复现的那一类。
 * 这也顺手补上了 README「已知限制 ⑦」里点名的缺口：宿主层原先没有任何通用的
 * 长连接治理，每个要写流的插件都得自己重写一遍这一套。
 *
 * ## 明确**不**在这里的东西
 * 「什么时候该写哪一帧」是各插件的业务语义——本模块只管**帧怎么编码、写到哪算完、
 * 卡住了怎么断**。事件名与每一帧的 `data` 形状由调用方定义（见
 * {@link SseFrame}），因此两个插件的流契约可以完全不同而共用这一层。
 *
 * ⚠️ 本模块 `import type { ServerResponse } from 'node:http'`，因此与 `core` 顶层一样
 * **不得被前端包引入**（见架构 §9 R3）。
 */
import type { ServerResponse } from 'node:http'

/* ============================ 常量 ============================ */

/**
 * 单条流的**硬超时**：无论上游多慢，到这个时间必须结束。
 *
 * 存在的意义不是性能，而是**让流必然终止**——没有它，一个不响应的上游会让连接
 * 无限挂着，而长连接不计入排空（见 `HttpRouterService.trackStream` 的契约），
 * 卸载时不会被排空等待兜住，只能靠进程退出。
 */
export const STREAM_HARD_TIMEOUT_MS = 120_000

/**
 * **空闲超时**：两次增量之间超过这个时间即判定上游卡死。
 *
 * 与硬超时是两个不同的问题：硬超时管"整条流总时长"，空闲超时管"上游不发数据了"。
 * 一个每秒吐一个 token 的合法长回答会被硬超时打断（若超出），但绝不会触发空闲超时。
 */
export const STREAM_IDLE_TIMEOUT_MS = 30_000

/**
 * 进程内并发流上限。超限应在**写任何 SSE 头之前**返回 429（普通 JSON）。
 *
 * 为什么要有上限：长连接不占排空计数，因而也无法被排空"自然收敛"——
 * 无上限时一个刷屏的客户端就能把文件描述符与上游配额一起吃光。
 */
export const MAX_CONCURRENT_STREAMS = 4

/** SSE 事件名（跨进程稳定面：前端按这些字符串分支） */
export const SSE_EVENT_STATUS = 'status'
export const SSE_EVENT_DELTA = 'delta'
export const SSE_EVENT_DONE = 'done'
export const SSE_EVENT_ERROR = 'error'

/* ============================ 帧的形状 ============================ */

/**
 * 一帧的最小结构约束。
 *
 * 刻意**只有这两个字段**：`event` 是客户端分支的稳定面，`data` 是载荷。
 * 各插件把自己的判别联合（`AiStreamEvent` 等）定义成它的子类型即可——
 * 结构类型让本模块无需知道任何业务语义。
 */
export interface SseFrame {
  readonly event: string
  readonly data: unknown
}

/**
 * 终结帧判定（`done` / `error`）。
 *
 * 参数写成**泛型** `E extends { event: string }` 而不是 `Pick<SseFrame, 'event'>`：
 * 后者的**多余属性检查**会拒绝 `isTerminalEvent({ event: 'done', data: … })` 这种
 * 字面量调用（这是最自然的调用形式），而泛型从字面量推断 `E`，不触发该检查。
 * 调用方既可以只传 `{ event }`，也可以把整帧传进来。
 */
export function isTerminalEvent<E extends { readonly event: string }>(ev: E): boolean {
  return ev.event === SSE_EVENT_DONE || ev.event === SSE_EVENT_ERROR
}

/* ============================ 帧编码 ============================ */

/**
 * 编码一个 SSE 帧：`event: <名>\n` + 一到多行 `data: <JSON>` + 空行收尾。
 *
 * 关于换行：SSE 规范要求 `data` 字段里的换行拆成多条 `data:` 行，否则会破坏帧边界。
 * `JSON.stringify` 会把内容里的换行转义成 `\n` 两个字符，因此正常路径恒为单行；
 * 这里仍按规范逐行拆分，是为了让"将来有人传进含裸换行的字符串"也不会打乱协议。
 */
export function encodeSseFrame(event: string, data: unknown): string {
  const json = JSON.stringify(data ?? null)
  const lines = json.split(/\r\n|\r|\n/).map((line) => `data: ${line}`)
  return `event: ${event}\n${lines.join('\n')}\n\n`
}

/**
 * 校验帧序列是否满足协议不变量；返回首个违规的描述，全部满足则返回 `null`。
 *
 * 做成纯函数而不是只在写帧时隐式保证，是为了能对**任意** chunk 序列（含上游违约的
 * 序列）断言这条不变量——上游的终止保证属于另一个包的契约，消费方不应盲信。
 *
 * 三条不变量：首帧为 status；终止帧（done/error）**恰一帧**；且该帧**位于末位**。
 * "终止帧之后不再有帧"不需要单独判断——"恰一帧 + 位于末位"已经蕴含它
 * （多一帧就必然违反前两条之一）。
 */
export function validateFrameSequence(events: readonly SseFrame[]): string | null {
  const first = events[0]
  if (!first) return '帧序列不得为空'
  if (first.event !== SSE_EVENT_STATUS) return `首帧必须是 ${SSE_EVENT_STATUS}，实际 ${first.event}`
  const terminalIndexes = events.map((ev, i) => (isTerminalEvent(ev) ? i : -1)).filter((i) => i >= 0)
  if (terminalIndexes.length !== 1) return `终止帧必须恰一帧，实际 ${terminalIndexes.length} 帧`
  const idx = terminalIndexes[0] as number
  if (idx !== events.length - 1) return `终止帧必须位于末位（实际在 #${idx}，共 ${events.length} 帧）`
  return null
}

/* ============================ 帧写入 ============================ */

export interface FrameWriter<E extends SseFrame = SseFrame> {
  /** 写一帧；返回是否真的写出（终止后/连接已断时为 false） */
  write(ev: E): boolean
  /** 结束响应（幂等；连接已断时静默） */
  end(): void
  /** 是否已写过终止帧（终止闩锁：之后一律不再写） */
  readonly terminated: boolean
}

/**
 * 写 SSE 响应头。**必须在对任何输入校验通过之后调用**——400/429 要在写头之前
 * 以普通 JSON 返回，否则就成了"用 SSE 表达参数错误"，客户端分流会乱。
 */
export function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no', // 防 nginx 之类中间层把事件流缓冲成一次性响应
  })
  // 立即刷头：让客户端（以及 curl -N）能马上看到 status 帧，而不是等第一段正文
  res.flushHeaders?.()
}

/**
 * 建立一个带**终止闩锁**与写前存活检查的帧写入器。
 *
 * 两个防护都必要：
 * - 闩锁：终止帧之后再写任何东西都会违反协议（客户端已经收摊），直接丢弃；
 * - 存活检查：客户端可能随时断开，此时 `res.write` 会抛错或静默失败，
 *   因此每次写前看 `writableEnded`/`destroyed`，并兜住异常——断连不该把流处理
 *   逻辑带崩（后续的清理与计数仍必须照常执行）。
 */
export function createFrameWriter<E extends SseFrame = SseFrame>(res: ServerResponse): FrameWriter<E> {
  let terminated = false
  return {
    get terminated(): boolean {
      return terminated
    },
    write(ev: E): boolean {
      if (terminated) return false
      if (res.writableEnded || res.destroyed) return false
      try {
        res.write(encodeSseFrame(ev.event, ev.data))
      } catch {
        return false // 连接已断：写入失败不是错误，交由调用方走统一清理
      }
      if (isTerminalEvent(ev)) terminated = true
      return true
    },
    end(): void {
      if (res.writableEnded || res.destroyed) return
      try {
        res.end()
      } catch {
        /* 连接已断：无需处理 */
      }
    },
  }
}

/* ============================ 超时看门狗 ============================ */

export interface Watchdog {
  /** 收到一个增量即调用：重置空闲计时 */
  kick(): void
  /** 停止两个计时器（流结束时必须调用，否则定时器泄漏） */
  clear(): void
  /** 是否因超时而触发（用于把上游的 ABORTED 归一成 TIMEOUT 报给客户端） */
  readonly timedOut: boolean
}

/**
 * 空闲 + 硬超时看门狗。触发时调用 `onTimeout(kind)`（调用方据此 abort 上游）。
 *
 * `kind` 是后加的（2026-09-16）：两种超时对用户是**完全不同的处境**——
 * "上游一直没有产出"（空闲）与"这一轮就是太长了"（硬限）需要给出不同的下一步建议，
 * 而在此之前调用方拿不到这个信息，只能写一句"超时或断开"的模糊话。
 * 老调用方忽略这个参数即可（`() => …` 仍然合法）。
 *
 * 两个计时器都 `unref()`：它们只是"兜底终止"，不该成为阻止进程退出的理由
 * （生产里 HTTP 服务本身撑着事件循环；测试里则避免用例结束后进程挂着）。
 */
export function createIdleWatchdog(opts: {
  idleMs: number
  hardMs: number
  onTimeout: (kind: 'idle' | 'hard') => void
}): Watchdog {
  let timedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const trigger = (kind: 'idle' | 'hard'): void => {
    timedOut = true
    opts.onTimeout(kind)
  }
  const hardTimer = setTimeout(() => trigger('hard'), opts.hardMs)
  hardTimer.unref?.()
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => trigger('idle'), opts.idleMs)
    idleTimer.unref?.()
  }
  armIdle()
  return {
    get timedOut(): boolean {
      return timedOut
    },
    kick(): void {
      if (!timedOut) armIdle()
    },
    clear(): void {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      clearTimeout(hardTimer)
    },
  }
}
