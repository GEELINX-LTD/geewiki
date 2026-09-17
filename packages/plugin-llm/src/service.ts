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
import { type CredentialResult, resolveCredential } from './credentials.js'
/** 采样温度**不在**本层决定：配置里没有 temperature，这里也不注入默认值 */
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from './settings.js'
import { redact } from './redact.js'
import type {
  LlmChunk,
  LlmConnectionTestResult,
  LlmCredentialSource,
  LlmErrorCode,
  LlmModelListResult,
  LlmProbeCapability,
  LlmProbeFailure,
  LlmProbeOutcome,
  LlmProbeRequest,
  LlmProbeTarget,
  LlmProvider,
  LlmRequest,
  LlmRouteDescriptor,
  LlmService,
  LlmSettings,
} from './types.js'

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
  /** 请求未指定 route 时使用的路由名（空 = 回落 {@link LlmServiceOptions.settings} 的 provider，再空则取第一个可用路由） */
  defaultRoute?: string
  /** 请求未显式给出 maxTokens 时填充的默认值（空 = 回落设置的 maxOutputTokens） */
  maxTokens?: number
  // 刻意**没有** `temperature` 选项：见文件头——采样温度一律由服务端决定
  /**
   * 统一接入设置（**现读函数**，不是快照）：适配器与路由选择都经它取当前值。
   * 缺省（不传）时回落为"全默认"的 {@link FALLBACK_SETTINGS} —— 这是"以代码直接构造服务"
   * （测试、程序化装配）的路径，不要让缺省变成 undefined 而在各处写判空。
   */
  settings?: () => LlmSettings
  /**
   * 服务级密钥解析（统一配置：界面填写的密钥优先，环境变量兜底）。
   * 缺省时回落到"按 provider 自己声明的 `apiKeyEnv` 查环境变量"——
   * 与本次改动前行为一致，供不接统一配置的装配路径使用。
   */
  resolveApiKey?: () => CredentialResult
  /** 密钥来源（仅展示用；缺省恒报 `none`） */
  credentialSource?: () => LlmCredentialSource
}

/**
 * 未接入统一配置时的设置快照：取**中性默认值**，不含任何厂商事实
 * （端点与模型名的兜底属于适配器，见 `LlmRouteDescriptor.defaults`）。
 */
export const FALLBACK_SETTINGS: LlmSettings = {
  provider: '',
  baseUrl: '',
  model: '',
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  reasoningEffort: 'off',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  includeUsage: true,
  extraBody: '',
  apiKeyEnv: '',
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
    // finishReason 是**结构化**的上游字段（不是自由文本），原样透传：
    // 调用方靠它区分"答完了"与"被长度截断了"（后者会让工具调用参数变成半截 JSON）。
    ...(chunk.finishReason !== undefined ? { finishReason: chunk.finishReason } : {}),
  }
}

/**
 * 非终止 chunk 归一化：
 * - `status` 的 message 经 {@link redact} 脱敏（诊断文本最可能夹带上游回显的凭据）；
 * - `text-delta` / `tool-call-delta` **原样透传**（那是模型输出，脱敏会篡改内容）；
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
  // ★ 工具片段必须显式放行：下面那句 `return undefined` 会把"契约外类型"丢掉。
  //   少写这一行不会报错、不会有测试变红，只会让工具调用**静默地一个都收不到**。
  if (chunk.type === 'tool-call-delta') return chunk
  return undefined // done/error 不会走到这里（调用方先判终止）；其它类型属契约外
}

/**
 * 探测目标的解析结果。
 *
 * `ok:false` 时 `route` / `baseUrl` 尽量回填（用户要能在报错里看到"我到底测的是哪个"），
 * 真正的结论在 `failure` 里。
 */
type ProbePlan =
  | {
      readonly ok: true
      readonly route: string
      readonly baseUrl: string
      /** 解析出的模型名；空串 = 未指定（对话探测会改用清单首个） */
      readonly model: string
      readonly target: LlmProbeTarget
      readonly probe?: LlmProbeCapability
    }
  | {
      readonly ok: false
      readonly route: string
      readonly baseUrl: string
      readonly failure: LlmProbeFailure
    }

/**
 * 把探测结果里的一切文本再脱敏一遍。
 *
 * 适配器已经脱过一次，这里是**纵深防御**：上游报错经常整段回显鉴权头与 URL query，
 * 而这些文本最终会显示在管理台上（任何登录用户看得到 = 必须假定它会外流）。
 * 除通用规则外，还把**本次探测用的密钥字面量**替换掉——各家密钥形态不一，
 * 只有调用方确定知道该屏蔽哪一串。
 */
function scrubFailure(failure: LlmProbeFailure, secret: string): LlmProbeFailure {
  const scrub = (text: string): string =>
    secret.length >= 6 ? redact(text).split(secret).join('***') : redact(text)
  return {
    ...failure,
    message: scrub(failure.message),
    ...(failure.detail !== undefined ? { detail: scrub(failure.detail) } : {}),
  }
}

/** 兜住适配器探测实现的异常：探测页绝不允许因为一个 adapter 的 bug 变成 500 */
async function safeProbe<T extends object>(
  run: () => Promise<LlmProbeOutcome<T>>,
): Promise<LlmProbeOutcome<T>> {
  try {
    return await run()
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      message: '探测过程异常中止（服务商适配器内部错误）',
      detail: redact(err instanceof Error ? err.message : String(err)),
    }
  }
}

/** 创建 LLM 服务（纯内存注册表；生命周期由插件 apply/dispose 控制） */
export function createLlmService(options: LlmServiceOptions = {}): LlmService {
  const providers = new Map<string, LlmProvider>()
  const explicitRoute = options.defaultRoute?.trim() ?? ''
  /** 现读设置：**每次调用都重新取值**，使配置热更新立即生效（不得缓存进闭包） */
  const settings = (): LlmSettings => options.settings?.() ?? FALLBACK_SETTINGS
  const resolveApiKey = (): CredentialResult =>
    options.resolveApiKey ? options.resolveApiKey() : { ok: false, code: 'MISSING_CREDENTIAL' }

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
    // 统一配置（服务级解析器）优先；未接入时回落到该 provider 自己声明的环境变量名
    const cred = options.resolveApiKey ? options.resolveApiKey() : resolveCredential(p.descriptor.apiKeyEnv)
    return cred.ok ? 'NO_ADAPTER' : cred.code
  }

  const select = (req: LlmRequest): { provider: LlmProvider } | { code: LlmErrorCode } => {
    const requested = req.route?.trim() || explicitRoute || settings().provider
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

    // 补齐服务级默认值（仅在请求未显式给出时）。默认值来源优先级：
    // 显式选项（测试/程序化装配）> 统一设置（用户配置）> 不填（由 provider 自行决定）。
    // `hasSettings` 判据不可省：不接统一配置的装配路径（裸 createLlmService()）必须保持
    // "请求里不带 maxTokens"，否则会给所有存量调用方凭空加上一个上限。
    // temperature 不在这里出现——**服务端默认值优先于客户端猜测**。
    const hasSettings = options.settings !== undefined
    const current = settings()
    const defaultMaxTokens = options.maxTokens ?? (hasSettings ? current.maxOutputTokens : undefined)
    const effective: LlmRequest = {
      ...req,
      ...(req.maxTokens === undefined && defaultMaxTokens !== undefined ? { maxTokens: defaultMaxTokens } : {}),
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

  /**
   * 解析一次探测要打的**目标**（服务商 / 端点 / 密钥 / 模型）。
   *
   * 取值顺序是 表单草稿 > 已存配置 > 适配器默认：设置页因此可以"改一半就测"，
   * 不必先保存再测（保存失败与端点不通是两类问题，混在一起测就分不清了）。
   *
   * `apiKey` 留空的含义是**用已保存的密钥**，不是"没有密钥"——密钥不回显，
   * 把空串当清除会让每次探测都报"缺 key"。
   */
  const resolveProbe = (req: LlmProbeRequest): ProbePlan => {
    const current = settings()
    const requested = req.provider?.trim() || current.provider
    let provider: LlmProvider | undefined
    if (requested !== '') {
      provider = providers.get(requested)
      if (!provider) {
        return {
          ok: false,
          route: requested,
          baseUrl: '',
          failure: { code: 'no_provider', message: `没有名为 "${requested}" 的已注册服务商（对应插件可能未启用）` },
        }
      }
    } else {
      // 没点名就用"第一个可用的"；一个都不剩时退回第一个已注册的——这样报错说的是
      // "缺密钥"（可修），而不是含糊的"没有服务商"（用户会以为插件没装）
      provider = [...providers.values()].find(isAvailable) ?? [...providers.values()][0]
      if (!provider) {
        return {
          ok: false,
          route: '',
          baseUrl: '',
          failure: { code: 'no_provider', message: '尚未注册任何模型服务商：请先启用「OpenAI 兼容端点」适配器' },
        }
      }
    }

    const route = provider.route
    const baseUrl = (req.baseUrl?.trim() || current.baseUrl || provider.descriptor.defaults?.baseUrl || '').trim()
    if (baseUrl === '') {
      return {
        ok: false,
        route,
        baseUrl: '',
        failure: { code: 'invalid_input', message: '端点地址为空，且该服务商没有默认端点：请填写 Base URL' },
      }
    }
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch (err) {
      return {
        ok: false,
        route,
        baseUrl,
        failure: {
                    code: 'invalid_input',
          message: `端点地址不是合法 URL：${baseUrl}`,
          detail: redact(err instanceof Error ? err.message : String(err)),
        },
      }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        route,
        baseUrl,
        failure: { code: 'invalid_input', message: `端点地址必须是 http/https，收到的是 ${parsed.protocol}` },
      }
    }

    const inlineKey = req.apiKey?.trim() ?? ''
    const credential = inlineKey !== '' ? ({ ok: true, value: inlineKey } as const) : resolveApiKey()
    if (!credential.ok) {
      return {
        ok: false,
        route,
        baseUrl,
        failure: {
                    code: 'no_credential',
          message: '没有可用的 API Key：请在设置里填写（或配置密钥环境变量）后再测试',
        },
      }
    }

    const model = (req.model?.trim() || current.model || provider.descriptor.defaults?.model || '').trim()
    return {
      ok: true,
      route,
      baseUrl,
      model,
      ...(provider.descriptor.probe ? { probe: provider.descriptor.probe } : {}),
      target: {
        baseUrl,
        apiKey: credential.value,
        ...(model !== '' ? { model } : {}),
        // 探测发生在设置页：用配置值与 PROBE_TIMEOUT_MS 的较小者，点一下就要有回音
        timeoutMs: Math.max(1, Math.min(current.timeoutMs, PROBE_TIMEOUT_MS)),
      },
    }
  }

  /** 服务商的人话名字（报错文本里要让它可辨认） */
  const labelOf = (route: string): string => providers.get(route)?.descriptor.label ?? route

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
    settings,
    resolveApiKey,
    credentialSource(): LlmCredentialSource {
      return options.credentialSource ? options.credentialSource() : 'none'
    },
    stream,
    async listModels(req: LlmProbeRequest = {}): Promise<LlmModelListResult> {
      const plan = resolveProbe(req)
      if (!plan.ok) {
        return { ok: false, provider: plan.route, baseUrl: plan.baseUrl, models: [], error: plan.failure }
      }
      const { route, baseUrl, target } = plan
      const probe = plan.probe
      if (!probe) {
        return {
          ok: false,
          provider: route,
          baseUrl,
          models: [],
          error: { code: 'unsupported', message: `「${labelOf(route)}」不支持模型清单查询` },
        }
      }
      const outcome = await safeProbe(() => probe.listModels(target))
      if (!outcome.ok) {
        return { ok: false, provider: route, baseUrl, models: [], error: scrubFailure(outcome, target.apiKey) }
      }
      return { ok: true, provider: route, baseUrl, models: outcome.models }
    },

    async testConnection(req: LlmProbeRequest = {}): Promise<LlmConnectionTestResult> {
      const plan = resolveProbe(req)
      if (!plan.ok) {
        return { ok: false, provider: plan.route, baseUrl: plan.baseUrl, error: plan.failure }
      }
      const { route, baseUrl, target } = plan
      const probe = plan.probe
      if (!probe) {
        return {
          ok: false,
          provider: route,
          baseUrl,
          error: { code: 'unsupported', message: `「${labelOf(route)}」不支持连接测试` },
        }
      }

      // 第一步：模型清单。失败**不**判整体失败——不少网关不实现 /models 却能正常对话，
      // 把它算成失败会让人对着一个能用的端点反复排查。
      const listed = await safeProbe(() => probe.listModels(target))
      const models = listed.ok ? [...listed.models] : []

      // 第二步：一次最小对话。没填模型就借清单首个（"我配好了但没填模型"是最常见的一种未完成状态）
      const model = plan.model !== '' ? plan.model : (models[0] ?? '')
      const answered = await safeProbe(() => probe.chat({ ...target, ...(model !== '' ? { model } : {}) }))

      // 展示用的模型名：上游有时会回显一个更具体的名字（带版本/量化后缀），以它为准
      const testedModel = answered.ok && answered.model !== undefined && answered.model !== '' ? answered.model : model

      return {
        // ok 只看对话：它才是"能不能用"的证据
        ok: answered.ok,
        provider: route,
        baseUrl,
        ...(testedModel !== '' ? { model: testedModel } : {}),
        models: {
          ok: listed.ok,
          models,
          ...(listed.ok ? {} : { error: scrubFailure(listed, target.apiKey) }),
        },
        chat: answered.ok
          ? {
              ok: true,
              ...(answered.model !== undefined ? { model: answered.model } : {}),
              reply: answered.reply,
              latencyMs: answered.latencyMs,
            }
          : { ok: false, error: scrubFailure(answered, target.apiKey) },
      }
    },
  }
}
