/**
 * SSE（Server-Sent Events）帧编码与长连接生命周期辅助（**尽量做成纯逻辑，便于单测**）。
 *
 * 为什么把这些单独放一层：
 * 1. 帧编码与"帧序列不变量"是可以纯函数化的——把它们抽出来就能脱离 HTTP 端口测，
 *    而真实 HTTP 链路的抖动不该影响这些断言的稳定性；
 * 2. 本插件是**唯一**该知道"AI 事件流长什么样"的地方，前端与 CLI 都按这里的
 *    {@link AiStreamEvent} 契约解析。
 *
 * 三条不可动摇的协议纪律（端点与测试都以此为准）：
 * - **`status` 必为第一帧**：前端要先把"来源与降级提示"渲染出来，再等 token；
 * - **`done` 或 `error` 恰一帧且在最后**：之后不得再有任何帧，并关闭响应；
 * - **绝不把 JSON 写进事件流**：`RouteHandlerContext.json()` 会 `res.end()`，
 *   对已写出 SSE 头的响应会追加字面文本并立即终结流（本仓库已实测过该坑），
 *   因此长连接出口只能用 `noteStatus()` 记指标 + 自己写帧 + 自己 `end()`。
 */
import type { ServerResponse } from 'node:http'
import type { LlmUsage } from '@geewiki/llm'
import type { AnswerFormat, AskSource, Degraded } from './types.js'

/* ============================ 常量 ============================ */

/**
 * 单条流的**硬超时**：无论上游多慢，到这个时间必须结束。
 *
 * 存在的意义不是性能，而是**让流必然终止**——没有它，一个不响应的上游会让连接
 * 无限挂着，而长连接不计入排空（见 core 的 `trackStream` 契约），卸载时不会被
 * 排空等待兜住，只能靠进程退出。
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
 * 进程内并发流上限。超限在**写任何 SSE 头之前**返回 429（普通 JSON）。
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

/* ============================ 事件契约 ============================ */

/** `status`：检索已完成、生成尚未开始（或已确定降级）时的首帧 */
export interface StreamStatusData {
  /**
   * **生成前投影**：有可用 provider 时为 `'rag'`（表示"本条流将尝试模型生成"），
   * 否则为 `'retrieval-only'`。生成的实际结果由 `done.partial` / `error` 帧决定——
   * 首帧无法预知生成是否成功，故这里刻意只表达"意图"，不虚报结果。
   */
  mode: 'rag' | 'retrieval-only'
  retrieval: { mode: 'fts' | 'like'; total: number; limit: number }
  sources: readonly AskSource[]
  degraded: Degraded | null
}

/** `delta`：增量文本片段（客户端按到达顺序拼接） */
export interface StreamDeltaData {
  text: string
}

/** `done`：正常或部分完成的终结帧 */
export interface StreamDoneData {
  answer: string | null
  answerFormat: AnswerFormat
  usage: LlmUsage | null
  /** true = 生成中途中断，`answer` 只是已生成的部分（客户端的增量缓冲与之一致） */
  partial: boolean
  elapsedMs: number
}

/** `error`：失败终结帧（`message` **必须已脱敏**） */
export interface StreamErrorData {
  code: string
  message: string
}

export type AiStreamEvent =
  | { event: typeof SSE_EVENT_STATUS; data: StreamStatusData }
  | { event: typeof SSE_EVENT_DELTA; data: StreamDeltaData }
  | { event: typeof SSE_EVENT_DONE; data: StreamDoneData }
  | { event: typeof SSE_EVENT_ERROR; data: StreamErrorData }

/** 终结帧判定（`done` / `error`） */
export function isTerminalEvent(ev: AiStreamEvent): boolean {
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
 * 序列）断言这条不变量——上游的终止保证属于另一个包的契约，本插件不应盲信。
 *
 * 三条不变量：首帧为 status；终止帧（done/error）**恰一帧**；且该帧**位于末位**。
 * "终止帧之后不再有帧"不需要单独判断——"恰一帧 + 位于末位"已经蕴含它
 * （多一帧就必然违反前两条之一）。
 */
export function validateFrameSequence(events: readonly AiStreamEvent[]): string | null {
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

export interface FrameWriter {
  /** 写一帧；返回是否真的写出（终止后/连接已断时为 false） */
  write(ev: AiStreamEvent): boolean
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
export function createFrameWriter(res: ServerResponse): FrameWriter {
  let terminated = false
  return {
    get terminated(): boolean {
      return terminated
    },
    write(ev: AiStreamEvent): boolean {
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
 * 空闲 + 硬超时看门狗。触发时调用 `onTimeout()`（调用方据此 abort 上游）。
 *
 * 两个计时器都 `unref()`：它们只是"兜底终止"，不该成为阻止进程退出的理由
 * （生产里 HTTP 服务本身撑着事件循环；测试里则避免用例结束后进程挂着）。
 */
export function createIdleWatchdog(opts: { idleMs: number; hardMs: number; onTimeout: () => void }): Watchdog {
  let timedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const trigger = (): void => {
    timedOut = true
    opts.onTimeout()
  }
  const hardTimer = setTimeout(trigger, opts.hardMs)
  hardTimer.unref?.()
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(trigger, opts.idleMs)
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
