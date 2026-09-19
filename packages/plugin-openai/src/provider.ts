/**
 * OpenAI 兼容 `/chat/completions` 的流式 provider。
 *
 * 设计约束（四条都是刻意的）：
 * 1. **零新增依赖**：用 Node 22 全局 `fetch` + 手写 SSE 切帧（见 `sse.ts`）。
 * 2. **绝不重试**：重试涉及退避/配额/幂等，属独立层职责（`@geewiki/llm` 契约明文规定）。
 *    在这里偷偷重试会让上层无法判断一次失败到底消耗了多少配额。
 * 3. **密钥绝不进日志**：任何要落地到日志的上游文本先过 `redact`；本模块也不把密钥
 *    放进请求之外的任何字符串（URL 里没有 key，只有 header）。
 * 4. **本适配器不持有任何配置**（本批的产品裁决）：端点、模型、超时、思考强度等
 *    一律在每次请求时经 `settings()` **现读** `llm-service` 的统一配置。
 *    由此"改配置 → 立即生效"不需要重启，也不需要适配器参与热更新。
 */
import type {
  LlmChunk,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmRouteDescriptor,
  LlmSettings,
  LlmToolCallDelta,
  LlmToolChoice,
  LlmToolDef,
  LlmUsage,
} from '@geewiki/llm'
import { type CredentialResult, redact } from '@geewiki/llm'
import { codeFromFetchError, codeFromHttpError } from './errors.js'
import { isDoneSentinel, parseSseData } from './sse.js'
import { joinUrl } from './url.js'
import { openAiCompatProbe } from './probe.js'

/**
 * provider 的构造参数：**只有身份与"怎么读设置"，没有一项是配置值**。
 *
 * 这是"配置集中在 `@geewiki/llm`"的落点——适配器不再有自己的 configSchema，
 * 因而也不可能与统一配置产生第二份真相。
 */
export interface OpenAiProviderOptions {
  /** 路由名（= 服务商 id；`@geewiki/llm` 的 provider 字段按它选中本适配器） */
  route: string
  /** 中文可读名（管理台展示用） */
  label: string
  /** 一句话说明（管理台在下拉项里展示） */
  description: string
  /**
   * 用户未填 `baseUrl` / `model` 时的兜底值。
   *
   * 这是**适配器自己的事实**（"OpenAI 兼容端点通常长这样"），不写进用户配置：
   * 写进配置就会在换服务商时变成一份需要手工清理的残留。
   */
  defaults: { baseUrl: string; model: string }
  /** 现读统一设置（每次请求都取当前值，绝不缓存） */
  settings(): LlmSettings
  /** 现读当前生效的密钥（界面填写优先、环境变量兜底） */
  resolveApiKey(): CredentialResult
}

/**
 * 解析"额外请求体"（配置已在 `@geewiki/llm` 激活时校验过一次；这里再兜一层：
 * 坏值按"没有额外参数"处理，绝不因为一个透传字段让整次请求失败）。
 */
function extraBodyOf(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
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

/**
 * 从一帧里取**思考内容**增量。
 *
 * 字段名各家不一，与探测路径的 `reasoningOf`（`probe.ts`）认同一组：
 * DeepSeek 系是 `reasoning_content`，另一些网关只叫 `reasoning`。
 * 两个都读、各取第一个非空串——**不合并**：同一帧里同时出现两种是网关在回显，
 * 拼起来会把同一段思考显示两遍。
 *
 * 与 {@link deltaOf} 一样只在**非空字符串**时返回：流式中间帧常带
 * `"reasoning_content": null`（不是空思考，是"这一段没有思考"）。
 */
function reasoningOf(frame: Record<string, unknown>): string | undefined {
  const choices = frame['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const delta = (first as Record<string, unknown>)['delta']
  if (delta === null || typeof delta !== 'object') return undefined
  const record = delta as Record<string, unknown>
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
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

/* ============================ 工具调用（function calling） ============================ */

/**
 * 把契约面的消息折成上游形态。
 *
 * **只在有值时加键**：`tool_calls` / `tool_call_id` 是"存在即出现"的字段——
 * 给一条普通 user 消息挂上 `"tool_calls": undefined` 会被 `JSON.stringify` 丢掉，
 * 但显式写 `"tool_call_id": ""` 就会被上游当成一条畸形的工具结果而 400。
 * 存量调用方（问答 / 辅助写作）的消息因此逐字节不变。
 */
function serializeMessage(m: LlmMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls !== undefined && m.toolCalls.length > 0
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : {}),
    ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
  }
}

/** 工具定义 → 上游 `tools[]`（`{type:'function', function:{…}}` 这层包装是适配器的职责） */
function serializeTool(t: LlmToolDef): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
}

/** 工具选择策略 → 上游 `tool_choice`（字符串三档原样下发；指名形态要包装成 function 对象） */
function serializeToolChoice(choice: LlmToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } }
}

/**
 * 从一帧里取**工具调用片段**（`choices[0].delta.tool_calls[]`）。
 *
 * 上游形态（OpenAI 规范）：首帧给 `id` + `function.name`（`arguments` 常是空串），
 * 后续帧只给 `function.arguments` 的分片，靠 `index` 归组。
 *
 * **缺 `index` 时按 0 处理**：规范里它是必填，但见过省略它的兼容端点；
 * 省略时按 0 至少能让"只有一个工具调用"这条最常见的路径正常工作，
 * 而不会因为一个缺字段把整轮工具调用丢掉。多个调用且都缺 index 的形态无法还原——
 * 那是上游不合规，本层不猜（都归到 index 0 会拼成一段坏 JSON，调用方的解析会失败并暴露问题）。
 *
 * 返回空数组表示这一帧没有工具内容（绝大多数帧都是这样），**不是错误**。
 */
function toolCallDeltasOf(frame: Record<string, unknown>): readonly LlmToolCallDelta[] {
  const choices = frame['choices']
  if (!Array.isArray(choices) || choices.length === 0) return []
  const first = choices[0]
  if (first === null || typeof first !== 'object') return []
  const delta = (first as Record<string, unknown>)['delta']
  if (delta === null || typeof delta !== 'object') return []
  const raw = (delta as Record<string, unknown>)['tool_calls']
  if (!Array.isArray(raw)) return []
  const out: LlmToolCallDelta[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const call = item as Record<string, unknown>
    const rawIndex = call['index']
    const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0
    const id = typeof call['id'] === 'string' && call['id'] !== '' ? call['id'] : undefined
    const fn = call['function']
    const record = fn !== null && typeof fn === 'object' ? (fn as Record<string, unknown>) : undefined
    const name = typeof record?.['name'] === 'string' && record['name'] !== '' ? record['name'] : undefined
    const args = record?.['arguments']
    const argumentsDelta = typeof args === 'string' ? args : undefined
    // 三样都没有的片段没有任何信息（有些端点会发一个空壳 `{index:0}`）：丢掉，不产生噪声 chunk
    if (id === undefined && name === undefined && argumentsDelta === undefined) continue
    out.push({
      index,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(argumentsDelta !== undefined ? { argumentsDelta } : {}),
    })
  }
  return out
}

/**
 * 从一帧里取结束原因（`choices[0].finish_reason`）。
 *
 * 只在**非空字符串**时返回：上游在流式中间帧会把它写成 `null`，
 * 那不是"结束了"，而是"还没结束"。
 */
function finishReasonOf(frame: Record<string, unknown>): string | undefined {
  const choices = frame['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const reason = (first as Record<string, unknown>)['finish_reason']
  return typeof reason === 'string' && reason !== '' ? reason : undefined
}

/**
 * 创建 provider。
 *
 * `available()` **每次调用都重新解析凭据**（不缓存）：密钥常在进程启动后才被设置，
 * 缓存会让"配好 key 但界面一直显示不可用"成为需要重启才能恢复的怪状态。
 */
export function createOpenAiProvider(options: OpenAiProviderOptions): LlmProvider {
  const effectiveBaseUrl = (s: LlmSettings): string => (s.baseUrl !== '' ? s.baseUrl : options.defaults.baseUrl)
  const effectiveModel = (s: LlmSettings): string => (s.model !== '' ? s.model : options.defaults.model)

  const descriptor: LlmRouteDescriptor = {
    route: options.route,
    label: options.label,
    vendor: 'openai',
    description: options.description,
    defaults: options.defaults,
    // 模型名/端点都能被热更新，故这里用 getter **现读**，而不是把构造那一刻的值钉死：
    // 否则管理台会显示一个"改了配置却不变"的旧模型名。
    get model() {
      return effectiveModel(options.settings())
    },
    get apiKeyEnv() {
      const name = options.settings().apiKeyEnv
      return name === '' ? undefined : name
    },
    // 模型清单 / 连接测试的能力：无状态实现，模块级共享一份
    probe: openAiCompatProbe,
    available: () => options.resolveApiKey().ok,
  }

  async function* stream(req: LlmRequest, opts: { signal: AbortSignal }): AsyncGenerator<LlmChunk> {
    const credential = options.resolveApiKey()
    if (!credential.ok) {
      // 缺 key 不是异常状态：产出终止 chunk 即可，上层据此走降级路径
      yield { type: 'error', code: credential.code }
      return
    }

    const settings = options.settings()
    const model = req.model?.trim() !== undefined && req.model.trim() !== '' ? req.model.trim() : effectiveModel(settings)
    const extra = extraBodyOf(settings.extraBody)
    const payload: Record<string, unknown> = {
      model,
      messages: req.messages.map(serializeMessage),
      stream: true,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      // 采样温度**只在调用方显式给出时**才发：配置里没有这一项，
      // 客户端替服务端补一个默认温度，等于覆盖掉各家服务端自己调过的值。
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      // 工具表：**不填（或空）= 键根本不出现**（不是发 `[]`）。存量调用方的请求逐字节不变。
      ...(req.tools !== undefined && req.tools.length > 0 ? { tools: req.tools.map(serializeTool) } : {}),
      // 同上口径：不给 `tools` 时也绝不补 `tool_choice`——补一个就等于替服务端决定"默认是什么"。
      ...(req.toolChoice !== undefined ? { tool_choice: serializeToolChoice(req.toolChoice) } : {}),
      // 思考强度：`off` = **不发**该参数（各网关对"关闭"的写法并不一致，见 LlmReasoningEffort）
      ...(settings.reasoningEffort !== 'off' ? { reasoning_effort: settings.reasoningEffort } : {}),
      ...(settings.includeUsage ? { stream_options: { include_usage: true } } : {}),
      // 额外请求体放**最后**：它是"网关私有参数"的逃生口，同名键由它覆盖
      // （如 DeepSeek 的 {"thinking":{"type":"enabled"}}、Qwen 的 {"enable_thinking":true}）
      ...(extra ?? {}),
    }

    // 双信号合并：调用方取消（ABORTED）与自身总超时（TIMEOUT）需要能被区分开，
    // 故两个信号都留着，判定时先看是谁中止的（见 codeFromFetchError）。
    const timeoutSignal = AbortSignal.timeout(Math.max(1, settings.timeoutMs))
    const combined = AbortSignal.any([opts.signal, timeoutSignal])

    let response: Response
    try {
      response = await fetch(joinUrl(effectiveBaseUrl(settings), '/chat/completions'), {
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
    let finishReason: string | undefined
    try {
      for await (const data of parseSseData(readChunks(response.body))) {
        if (isDoneSentinel(data)) break
        const frame = safeParseJson(data)
        if (frame === undefined) continue // 坏帧/非 JSON：忽略单帧，继续消费
        const usageInFrame = usageOf(frame)
        if (usageInFrame !== undefined) usage = usageInFrame
        const reasonInFrame = finishReasonOf(frame)
        if (reasonInFrame !== undefined) finishReason = reasonInFrame
        // 工具片段**先于正文**处理：同一帧理论上只会带其中一种，但先判工具能让
        // "只调工具、不说话"的帧（content 为 null）不被 deltaOf 的空判断吞掉。
        for (const call of toolCallDeltasOf(frame)) {
          yield { type: 'tool-call-delta', ...call }
        }
        // 思考**先于正文**：推理型模型一定是先吐完 reasoning_content 再吐 content，
        // 按到达顺序发出去，界面才能"先看到思考、再看到答案"。
        const reasoning = reasoningOf(frame)
        if (reasoning !== undefined) yield { type: 'reasoning-delta', text: reasoning }
        const delta = deltaOf(frame)
        if (delta !== undefined) yield { type: 'text-delta', text: delta } // 边收边吐，绝不攒完再发
      }
    } catch (err) {
      yield { type: 'error', code: codeFromFetchError(err, opts.signal, timeoutSignal) }
      return
    }

    // 流正常结束（收到 [DONE] 或上游干净关闭）。**不重试、不补内容**。
    yield {
      type: 'done',
      provider: options.route,
      model,
      ...(usage !== undefined ? { usage } : {}),
      // 透传给调用方：`'length'` 意味着工具调用参数可能是半截 JSON（见 LlmChunk 的 done 注释）
      ...(finishReason !== undefined ? { finishReason } : {}),
    }
  }

  return { route: options.route, descriptor, stream }
}

/** 上游错误的诊断日志开关（默认开；设 GEEWIKI_OPENAI_DEBUG=0 可关闭） */
function configLogEnabled(): boolean {
  return process.env['GEEWIKI_OPENAI_DEBUG'] !== '0'
}
