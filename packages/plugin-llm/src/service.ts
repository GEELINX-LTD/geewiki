/**
 * LLM 路由注册表 + 流式包装器。
 *
 * 本文件只做三件事，**不含任何厂商协议细节**（adapter 是后续批次的事）：
 * 1. 维护 `route → provider` 注册表（重复 route 抛错，不得静默覆盖）；
 * 2. 路由选择与降级（`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`）；
 * 3. **终止保证**：把任意"不太听话"的 provider 包装成"消费方可以无判空 `for await`"的流。
 *
 * 终止保证是这一层的核心价值。没有它，每个调用方都要自己写：
 * "provider 抛错怎么办""它忘了产 done 怎么办""它在 done 之后又产了一个 delta 怎么办"。
 * 把这件事收敛到一处，上层代码才敢只按 `type`/`code` 分支。
 */
import { resolveCredential } from './credentials.js'
import { redact } from './redact.js'
import type { LlmChunk, LlmErrorCode, LlmProvider, LlmRequest, LlmRouteDescriptor, LlmService } from './types.js'

/** ctx 服务名（`ctx.get('llm-service')`） */
export const LLM_SERVICE_KEY = 'llm-service'

/** 契约内的全部错误码；provider 产出的未知码一律归一化为 PROVIDER_ERROR */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<LlmErrorCode>([
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'RATE_LIMIT',
  'CONTEXT_WINDOW_EXCEEDED',
  'TIMEOUT',
  'NETWORK',
  'PROVIDER_ERROR',
  'ABORTED',
])

export interface LlmServiceOptions {
  /** 请求未指定 route 时使用的路由名（空 = 取第一个可用路由） */
  defaultRoute?: string
  /** 请求未显式给出 maxTokens 时填充的默认值 */
  maxTokens?: number
  /** 请求未显式给出 temperature 时填充的默认值 */
  temperature?: number
}

/**
 * 内置兜底 provider：**永远不可用**，被显式点名时产出单个 `error{MISSING_CREDENTIAL}`。
 *
 * 存在意义：让"降级"也有一个稳定的、可被管理台展示的路由，而不是让调用方面对
 * "查不到任何 provider"这种需要额外判断的局面。
 */
export const NULL_PROVIDER: LlmProvider = {
  route: 'null',
  descriptor: {
    route: 'null',
    label: '未配置（降级占位）',
    vendor: 'none',
    model: 'n/a',
    available: () => false,
  },
  // eslint-disable-next-line @typescript-eslint/require-await -- 契约要求 AsyncIterable，此处只有一个同步产出的终止 chunk
  async *stream(): AsyncIterable<LlmChunk> {
    yield { type: 'error', code: 'MISSING_CREDENTIAL' }
  },
}

/** 把任意值归一化为契约内错误码（不认识的码 → PROVIDER_ERROR） */
function normalizeCode(code: unknown): LlmErrorCode {
  return typeof code === 'string' && KNOWN_ERROR_CODES.has(code) ? (code as LlmErrorCode) : 'PROVIDER_ERROR'
}

/** 从抛出的异常/中止信号推导错误码（不读取异常文本，避免把上游报错内容带出去） */
function errorCodeOf(err: unknown, signal?: AbortSignal): LlmErrorCode {
  if (signal?.aborted) return 'ABORTED'
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'ABORTED'
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) return code as LlmErrorCode
  }
  return 'PROVIDER_ERROR'
}

/** 终止 chunk 重建：**丢掉 message 等一切额外字段**，从结构上杜绝上游文本泄漏密钥 */
function sanitizeTerminal(chunk: Extract<LlmChunk, { type: 'done' | 'error' }>): LlmChunk {
  if (chunk.type === 'error') return { type: 'error', code: normalizeCode(chunk.code) }
  return {
    type: 'done',
    provider: chunk.provider,
    model: chunk.model,
    ...(chunk.usage ? { usage: chunk.usage } : {}),
  }
}

/**
 * 非终止 chunk 归一化：
 * - `status` 的 message 经 {@link redact} 脱敏（诊断文本最可能夹带上游回显的凭据）；
 * - `text-delta` **原样透传**（那是模型输出，脱敏会篡改内容）；
 * - 契约外的 type 丢弃（保证消费方只见契约内的 chunk）。
 */
function sanitizeNonTerminal(chunk: LlmChunk): LlmChunk | undefined {
  if (chunk.type === 'status') {
    return {
      type: 'status',
      provider: chunk.provider,
      model: chunk.model,
      ...(chunk.code ? { code: normalizeCode(chunk.code) } : {}),
      ...(chunk.message !== undefined ? { message: redact(chunk.message) } : {}),
    }
  }
  if (chunk.type === 'text-delta') return chunk
  return undefined // done/error 不会走到这里（调用方先判终止）；其它类型属契约外
}

/** 创建 LLM 服务（纯内存注册表；生命周期由插件 apply/dispose 控制） */
export function createLlmService(options: LlmServiceOptions = {}): LlmService {
  const providers = new Map<string, LlmProvider>()
  const defaultRoute = options.defaultRoute?.trim() ?? ''
  const defaultMaxTokens = options.maxTokens
  const defaultTemperature = options.temperature

  /** available() 抛错不应拖垮整个服务：视为不可用 */
  const isAvailable = (p: LlmProvider): boolean => {
    try {
      return p.descriptor.available() === true
    } catch {
      return false
    }
  }

  /** provider 存在但不可用时，尽量给出具体原因（缺 key / 密钥形态非法），否则 NO_ADAPTER */
  const unavailableCode = (p: LlmProvider): LlmErrorCode => {
    const cred = resolveCredential(p.descriptor.apiKeyEnv)
    return cred.ok ? 'NO_ADAPTER' : cred.code
  }

  const select = (req: LlmRequest): { provider: LlmProvider } | { code: LlmErrorCode } => {
    const requested = req.route?.trim() || defaultRoute
    if (requested !== '') {
      const p = providers.get(requested)
      if (!p) return { code: 'NO_ADAPTER' } // 点名了不存在的路由
      if (!isAvailable(p)) return { code: unavailableCode(p) }
      return { provider: p }
    }
    const first = [...providers.values()].find(isAvailable)
    return first ? { provider: first } : { code: 'NO_ADAPTER' }
  }

  /**
   * 流式实现（终止保证的唯一实现处）。
   *
   * 五条路径都被钉死：① provider 抛错 → `error`；② signal 已/中途 abort → `error{ABORTED}`；
   * ③ 终止之后仍产 chunk → 不再消费（丢弃）并关闭上游；④ 未产终止就结束 → `error{PROVIDER_ERROR}`；
   * ⑤ 无可用 provider → `error{NO_ADAPTER}`。
   *
   * **本服务绝不重试**：重试涉及退避/配额/幂等，属独立层职责；在这里偷偷重试会让上层
   * 无法判断一次失败究竟消耗了多少配额。
   */
  async function* stream(req: LlmRequest, opts: { signal?: AbortSignal } = {}): AsyncGenerator<LlmChunk> {
    const signal = opts.signal
    if (signal?.aborted) {
      yield { type: 'error', code: 'ABORTED' }
      return
    }

    const picked = select(req)
    if (!('provider' in picked)) {
      yield { type: 'error', code: picked.code }
      return
    }
    const provider = picked.provider

    // 补齐服务级默认值（仅在请求未显式给出时）
    const effective: LlmRequest = {
      ...req,
      ...(req.maxTokens === undefined && defaultMaxTokens !== undefined ? { maxTokens: defaultMaxTokens } : {}),
      ...(req.temperature === undefined && defaultTemperature !== undefined
        ? { temperature: defaultTemperature }
        : {}),
    }

    let terminated = false
    let iterator: AsyncIterator<LlmChunk> | undefined
    try {
      iterator = provider.stream(effective, { signal: signal ?? new AbortController().signal })[Symbol.asyncIterator]()
      while (!terminated) {
        if (signal?.aborted) {
          terminated = true
          yield { type: 'error', code: 'ABORTED' }
          break
        }
        const step = await iterator.next()
        if (step.done) break
        const chunk = step.value
        if (chunk.type === 'done' || chunk.type === 'error') {
          terminated = true
          yield sanitizeTerminal(chunk)
          break // 终止后仍在上游排队的内容不再消费（并借 finally 关闭上游）
        }
        const normal = sanitizeNonTerminal(chunk)
        if (normal) yield normal
      }
    } catch (err) {
      if (!terminated) {
        terminated = true
        const code = errorCodeOf(err, signal)
        if (code !== 'ABORTED') {
          // 日志必须脱敏：上游报错文本经常整段回显 URL / 鉴权头
          console.warn(`[@geewiki/llm] 路由 ${provider.route} 流式失败（已脱敏）: ${redact(err instanceof Error ? err.message : err)}`)
        }
        yield { type: 'error', code }
      } else {
        console.warn(
          `[@geewiki/llm] 路由 ${provider.route} 在终止 chunk 之后抛错（已忽略，已脱敏）: ${redact(err instanceof Error ? err.message : err)}`,
        )
      }
    } finally {
      // 主动关闭上游迭代器：触发其 finally 释放连接/计时器（也覆盖 break 出来的路径）
      if (iterator?.return) {
        try {
          await iterator.return(undefined)
        } catch {
          /* 释放失败不得掩盖已经发生的流式结果 */
        }
      }
    }

    if (!terminated) {
      // ④ 上游没给终止 chunk 就结束了：补一个，保证消费方永远能拿到终止信号
      yield { type: 'error', code: 'PROVIDER_ERROR' }
    }
  }

  return {
    register(provider: LlmProvider): () => void {
      const route = provider.route
      if (route.trim() === '') throw new Error('@geewiki/llm: provider.route 不能为空')
      if (providers.has(route)) {
        // 静默覆盖会让"同组两个 provider 抢同一路由"变成随机行为，必须在注册时就炸
        throw new Error(`@geewiki/llm: 路由 "${route}" 已被注册，重复注册被拒绝（请先注销旧 provider）`)
      }
      providers.set(route, provider)
      return () => {
        // 只注销"仍是自己"的条目：避免注销函数误删同名的后来者
        if (providers.get(route) === provider) providers.delete(route)
      }
    },
    listProviders(): readonly LlmRouteDescriptor[] {
      return [...providers.values()].map((p) => p.descriptor)
    },
    availableProviders(): readonly LlmRouteDescriptor[] {
      return [...providers.values()].filter(isAvailable).map((p) => p.descriptor)
    },
    stream,
  }
}
