/**
 * OpenAI 兼容 `/chat/completions` 的流式 provider。
 *
 * 设计约束（三条都是刻意的）：
 * 1. **零新增依赖**：用 Node 22 全局 `fetch` + 手写 SSE 切帧（见 `sse.ts`）。
 * 2. **绝不重试**：重试涉及退避/配额/幂等，属独立层职责（`@geewiki/llm` 契约明文规定）。
 *    在这里偷偷重试会让上层无法判断一次失败到底消耗了多少配额。
 * 3. **密钥绝不进日志**：任何要落地到日志的上游文本先过 `redact`；本模块也不把密钥
 *    放进请求之外的任何字符串（URL 里没有 key，只有 header）。
 */
import type { LlmChunk, LlmProvider, LlmRequest, LlmRouteDescriptor, LlmUsage } from '@geewiki/llm'
import { redact, resolveCredential } from '@geewiki/llm'
import { codeFromFetchError, codeFromHttpError } from './errors.js'
import { isDoneSentinel, parseSseData } from './sse.js'

/** provider 的可调参数（由插件配置提供，已带默认值） */
export interface OpenAiProviderOptions {
  /** 路由名（注册表键；重复注册会被 llm-service 拒绝） */
  route: string
  /** 中文可读名（管理台展示用） */
  label: string
  /** 端点根地址，如 `https://api.openai.com/v1` 或本地 mock */
  baseUrl: string
  /** 默认模型名 */
  model: string
  /** 凭据的**环境变量名**（不是密钥值） */
  apiKeyEnv: string
  /** 单次请求总超时（毫秒） */
  timeoutMs: number
  /**
   * 是否请求上游在流末尾附带 token 用量。
   *
   * OpenAI 需要显式 `stream_options.include_usage` 才会在流式响应里带 `usage`；
   * 但个别"兼容"端点不认这个字段会直接 400，故做成可关的开关。
   */
  includeUsage: boolean
}

/** 把端点根地址与路径拼起来（容忍尾斜杠） */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return `${base}${path}`
}

/** 把 web ReadableStream 读成字节块；结束时取消上游（消费方 break 时也要能及时断开连接） */
async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let finished = false
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) {
        finished = true
        return
      }
      if (step.value) yield step.value
    }
  } finally {
    if (!finished) {
      // 提前退出（消费方 break / 异常 / abort）：主动取消，避免连接悬挂到超时
      try {
        await reader.cancel()
      } catch {
        /* 取消失败不得掩盖已产出的内容 */
      }
    }
  }
}

/** 安全解析一帧 JSON：解析失败返回 undefined（调用方忽略该帧，绝不让坏帧中断整条流） */
function safeParseJson(data: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 从一帧里取正文增量（兼容 `choices[0].delta.content` 与旧式 `choices[0].text`） */
function deltaOf(frame: Record<string, unknown>): string | undefined {
  const choices = frame['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const choice = first as Record<string, unknown>
  const delta = choice['delta']
  if (delta !== null && typeof delta === 'object') {
    const content = (delta as Record<string, unknown>)['content']
    if (typeof content === 'string' && content !== '') return content
  }
  const text = choice['text']
  return typeof text === 'string' && text !== '' ? text : undefined
}

/** 从一帧里取 token 用量（流式响应里通常只在最后一帧出现） */
function usageOf(frame: Record<string, unknown>): LlmUsage | undefined {
  const usage = frame['usage']
  if (usage === null || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const prompt = record['prompt_tokens']
  const completion = record['completion_tokens']
  const out: LlmUsage = {
    ...(typeof prompt === 'number' ? { promptTokens: prompt } : {}),
    ...(typeof completion === 'number' ? { completionTokens: completion } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 创建 provider。
 *
 * `available()` **每次调用都重新解析凭据**（不缓存）：密钥常在进程启动后才被设置，
 * 缓存会让"配好 key 但界面一直显示不可用"成为需要重启才能恢复的怪状态。
 */
export function createOpenAiProvider(options: OpenAiProviderOptions): LlmProvider {
  const descriptor: LlmRouteDescriptor = {
    route: options.route,
    label: options.label,
    vendor: 'openai',
    model: options.model,
    apiKeyEnv: options.apiKeyEnv,
    available: () => resolveCredential(options.apiKeyEnv).ok,
  }

  async function* stream(req: LlmRequest, opts: { signal: AbortSignal }): AsyncGenerator<LlmChunk> {
    const credential = resolveCredential(options.apiKeyEnv)
    if (!credential.ok) {
      // 缺 key 不是异常状态：产出终止 chunk 即可，上层据此走降级路径
      yield { type: 'error', code: credential.code }
      return
    }

    const model = req.model?.trim() !== undefined && req.model.trim() !== '' ? req.model.trim() : options.model
    const payload: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
    }

    // 双信号合并：调用方取消（ABORTED）与自身总超时（TIMEOUT）需要能被区分开，
    // 故两个信号都留着，判定时先看是谁中止的（见 codeFromFetchError）。
    const timeoutSignal = AbortSignal.timeout(Math.max(1, options.timeoutMs))
    const combined = AbortSignal.any([opts.signal, timeoutSignal])

    let response: Response
    try {
      response = await fetch(joinUrl(options.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          // 密钥只出现在这里，绝不进入 URL / 日志 / 错误信息
          authorization: `Bearer ${credential.value}`,
        },
        body: JSON.stringify(payload),
        signal: combined,
      })
    } catch (err) {
      yield { type: 'error', code: codeFromFetchError(err, opts.signal, timeoutSignal) }
      return
    }

    if (!response.ok) {
      // 错误体只在脱敏后进日志；错误码一律由状态码 + 结构化字段决定
      let rawBody = ''
      try {
        rawBody = await response.text()
      } catch {
        /* 读不到错误体不影响归一化（状态码已足够） */
      }
      let body: unknown = rawBody
      const parsedBody = rawBody === '' ? undefined : safeParseJson(rawBody)
      if (parsedBody !== undefined) body = parsedBody
      if (configLogEnabled()) {
        console.warn(
          `[@geewiki/openai] 路由 ${options.route} 上游返回 ${response.status}（已脱敏）: ${redact(rawBody.slice(0, 500))}`,
        )
      }
      yield { type: 'error', code: codeFromHttpError(response.status, body) }
      return
    }

    if (response.body === null) {
      yield { type: 'error', code: 'PROVIDER_ERROR' }
      return
    }

    // 先报"已连上"，让调用方能区分"连不上"与"连上但没内容"
    yield { type: 'status', provider: options.route, model }

    let usage: LlmUsage | undefined
    try {
      for await (const data of parseSseData(readChunks(response.body))) {
        if (isDoneSentinel(data)) break
        const frame = safeParseJson(data)
        if (frame === undefined) continue // 坏帧/非 JSON：忽略单帧，继续消费
        const usageInFrame = usageOf(frame)
        if (usageInFrame !== undefined) usage = usageInFrame
        const delta = deltaOf(frame)
        if (delta !== undefined) yield { type: 'text-delta', text: delta } // 边收边吐，绝不攒完再发
      }
    } catch (err) {
      yield { type: 'error', code: codeFromFetchError(err, opts.signal, timeoutSignal) }
      return
    }

    // 流正常结束（收到 [DONE] 或上游干净关闭）。**不重试、不补内容**。
    yield { type: 'done', provider: options.route, model, ...(usage !== undefined ? { usage } : {}) }
  }

  return { route: options.route, descriptor, stream }
}

/** 上游错误的诊断日志开关（默认开；设 GEEWIKI_OPENAI_DEBUG=0 可关闭） */
function configLogEnabled(): boolean {
  return process.env['GEEWIKI_OPENAI_DEBUG'] !== '0'
}
