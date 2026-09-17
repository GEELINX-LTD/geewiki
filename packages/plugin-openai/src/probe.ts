/**
 * OpenAI 兼容端点的**探测能力**：模型清单 + 一次最小对话。
 *
 * 它服务于设置页的两件事——「这个端点有哪些模型」与「这套配置能不能真跑通」，
 * 因此报错必须**可读**：状态码、上游原文（脱敏 + 截断）都要留给用户自己看，
 * 而不是像对话链路那样只回一个错误码（那条链路上错误文本可能夹带密钥，且没人照着它排查）。
 *
 * 三条约定：
 * 1. **绝不抛异常**：任何失败都折算成 `LlmProbeFailure`，调用方（`llm-service`）只做汇总；
 * 2. **自带超时**：`target.timeoutMs` 到点即中止，设置页不会被一个死端点挂住；
 * 3. **不下发 temperature**：与正常请求同口径——采样温度由服务端决定。
 */
import {
  redact,
  type LlmProbeCapability,
  type LlmProbeFailure,
  type LlmProbeOutcome,
  type LlmProbeTarget,
} from '@geewiki/llm'

/** 探测结果的失败分支（`LlmProbeFailure` + 判别字段）；几个失败工厂函数共用 */
type Failure = { readonly ok: false } & LlmProbeFailure
import { joinUrl } from './url.js'

/** 上游原文的展示上限（字符）：足够看清 `error.message`，又不会把整页 HTML 塞进响应 */
const MAX_DETAIL_CHARS = 800
/** 对话探测的回复展示上限（字符） */
const MAX_REPLY_CHARS = 200
/**
 * 对话探测的最长输出：只要证明"能出字"，不必让人等一篇作文。
 *
 * 给到 64 而不是 16：推理型模型（返回 `reasoning_content`）会先烧掉一小段预算，
 * 16 个 token 有时连第一个正文字都挤不出来，一次**明明通得了**的连接会被误判成失败。
 */
const PROBE_MAX_TOKENS = 64
/** 对话探测的提示词：极短、无信息量要求，任何能用的模型都能照做 */
const PROBE_PROMPT = '只回复两个字：好的'

/** 上游 HTTP 状态码 → 探测失败类别（比对话链路的错误码更细，便于设置页给针对性指引） */
function failureCodeOf(status: number): LlmProbeFailure['code'] {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404 || status === 405) return 'not_found'
  if (status === 429) return 'rate_limit'
  return 'http'
}

/** 状态码对应的一句人话结论 */
function failureMessageOf(status: number): string {
  switch (failureCodeOf(status)) {
    case 'auth':
      return `鉴权失败（HTTP ${status}）：API Key 无效或没有该端点的访问权限`
    case 'not_found':
      return `端点不支持该请求（HTTP ${status}）：请检查 Base URL 是否填到了版本段（如 …/v1）`
    case 'rate_limit':
      return `被限流（HTTP ${status}）：稍后再试，或检查配额`
    default:
      return `上游返回 HTTP ${status}`
  }
}

/** 尽力从错误体里取一句人能看的说明（OpenAI 形态是 `error.message`） */
function upstreamMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() === '' ? undefined : body.trim()
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  const inner = record['error']
  if (typeof inner === 'string' && inner.trim() !== '') return inner.trim()
  if (inner !== null && typeof inner === 'object') {
    const msg = (inner as Record<string, unknown>)['message']
    if (typeof msg === 'string' && msg.trim() !== '') return msg.trim()
  }
  const top = record['message']
  return typeof top === 'string' && top.trim() !== '' ? top.trim() : undefined
}

/** 脱敏 + 截断：上游原文里可能夹带密钥（鉴权头回显、URL query） */
function toDetail(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const clipped = text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…（已截断）` : text
  return redact(clipped)
}

/** 读文本响应（读失败不影响归一化——状态码本身已经够定性） */
async function readBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** 安全解析 JSON：非对象/解析失败返回 undefined */
function parseJsonObject(raw: string): unknown {
  if (raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 从模型清单响应里取 id 列表。
 *
 * 兼容三种形态：`{data:[{id}]}`（OpenAI）、`{models:[{id}|"…"]}`（部分网关）、
 * `["…"]`（少数极简网关）。取不到就算失败——**宁可报错也不显示一个空列表**，
 * 空列表会被读成"这个端点没有模型"，而真实原因多半是"我们没看懂它的响应"。
 */
export function extractModelIds(body: unknown): string[] | undefined {
  const collect = (items: unknown): string[] | undefined => {
    if (!Array.isArray(items)) return undefined
    const ids: string[] = []
    for (const item of items) {
      if (typeof item === 'string' && item.trim() !== '') ids.push(item.trim())
      else if (item !== null && typeof item === 'object') {
        const id = (item as Record<string, unknown>)['id']
        if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim())
      }
    }
    return ids.length > 0 ? ids : undefined
  }
  if (Array.isArray(body)) return collect(body)
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  return collect(record['data']) ?? collect(record['models'])
}

/** 安全地把 fetch 异常折算成失败（超时 vs 网络层问题） */
function failureFromFetchError(err: unknown, timeoutSignal: AbortSignal): Failure {
  const timedOut = timeoutSignal.aborted || (err instanceof Error && err.name === 'TimeoutError')
  return {
    ok: false,
    code: timedOut ? 'timeout' : 'network',
    message: timedOut ? '连接超时：请检查端点地址与网络连通性' : '无法连接端点：地址不可达、DNS 失败或 TLS 出错',
    detail: err instanceof Error ? toDetail(err.message) : toDetail(String(err)),
  }
}

/**
 * 创建 OpenAI 兼容探测实现。
 *
 * 它与 provider 共享 `baseUrl` / 密钥的解析结果（由 `llm-service` 传进 `target`），
 * 自己**不读任何配置**：探测的是"用户此刻表单里那套值"，不是"上次保存的那套"。
 */
export function createOpenAiCompatProbe(): LlmProbeCapability {
  async function listModels(target: LlmProbeTarget): Promise<LlmProbeOutcome<{ readonly models: readonly string[] }>> {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, target.timeoutMs))
    let response: Response
    try {
      response = await fetch(joinUrl(target.baseUrl, '/models'), {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${target.apiKey}` },
        signal: timeoutSignal,
      })
    } catch (err) {
      return failureFromFetchError(err, timeoutSignal)
    }

    const raw = await readBody(response)
    if (!response.ok) {
      return {
        ok: false,
        code: failureCodeOf(response.status),
        status: response.status,
        message: failureMessageOf(response.status),
        detail: toDetail(raw),
      }
    }

    const models = extractModelIds(parseJsonObject(raw))
    if (models === undefined) {
      return {
        ok: false,
        code: 'bad_response',
        status: response.status,
        message: '端点返回了无法识别的模型清单（既没有 data[] 也没有 models[]）',
        detail: toDetail(raw),
      }
    }
    // 去重 + 排序：网关常把同名模型挂在多个别名下，未排序的长列表没法用
    const unique = [...new Set(models)].sort((a, b) => a.localeCompare(b))
    return { ok: true, models: unique }
  }

  async function chat(
    target: LlmProbeTarget,
  ): Promise<LlmProbeOutcome<{ readonly model?: string; readonly reply: string; readonly latencyMs: number }>> {
    const model = target.model?.trim() ?? ''
    if (model === '') {
      return {
        ok: false,
        code: 'invalid_input',
        message: '未填写模型名，无法测试对话（可先获取模型清单，或手动填一个模型）',
      } as const
    }

    const timeoutSignal = AbortSignal.timeout(Math.max(1, target.timeoutMs))
    const startedAt = Date.now()
    let response: Response
    try {
      response = await fetch(joinUrl(target.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${target.apiKey}`,
        },
        // 非流式 + 极短输出：一次请求就能判定"密钥能用、模型能答"。
        // 刻意不带 extraBody / reasoning_effort：探测要回答的是"通不通"，
        // 私有参数是否被接受属于另一件事（真跑一次问答才看得出来）。
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: PROBE_PROMPT }],
          stream: false,
          max_tokens: PROBE_MAX_TOKENS,
        }),
        signal: timeoutSignal,
      })
    } catch (err) {
      return failureFromFetchError(err, timeoutSignal)
    }

    const raw = await readBody(response)
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      return {
        ok: false,
        code: failureCodeOf(response.status),
        status: response.status,
        message: failureMessageOf(response.status),
        detail: toDetail(upstreamMessage(parseJsonObject(raw)) ?? raw),
      }
    }

    const body = parseJsonObject(raw)
    const reply = contentOf(body)
    if (reply === undefined) {
      /**
       * **推理型模型**会先产 `reasoning_content` 再产 `content`。我们只给了几十 token 的预算，
       * 于是常见结果是"预算全花在思考上、正文为空、`finish_reason: length`"。
       *
       * 这**不是失败**：鉴权过了、模型有权访问、上游真的开始生成了——连接测试要回答的
       * 三件事全都有了证据。判成失败会逼用户去查一个根本不存在的问题，
       * 所以这里报成功，并把"正文为什么是空的"如实写进 reply。
       */
      const thinking = reasoningOf(body)
      const truncated = finishReasonOf(body) === 'length'
      const echoedThinking = echoedModel(body)
      if (thinking !== undefined || truncated) {
        const note = `已连通（上游开始生成，但 ${PROBE_MAX_TOKENS} token 预算内只产出了思考内容，正文为空）`
        const shown = thinking !== undefined ? `${note}：${thinking.slice(0, 60)}…` : note
        return {
          ok: true,
          ...(echoedThinking !== undefined ? { model: echoedThinking } : {}),
          reply: redact(shown),
          latencyMs,
        }
      }
      return {
        ok: false,
        code: 'bad_response',
        status: response.status,
        message: '端点返回 200，但响应里没有可阅读的正文（choices[0].message.content 缺失）',
        detail: toDetail(raw),
      }
    }
    const echoed = echoedModel(body)
    const clipped = reply.length > MAX_REPLY_CHARS ? `${reply.slice(0, MAX_REPLY_CHARS)}…（已截断）` : reply
    return { ok: true, ...(echoed !== undefined ? { model: echoed } : {}), reply: redact(clipped), latencyMs }
  }

  return { listModels, chat }
}

/** 上游回显的模型名（可能比请求里的更具体，展示以它为准） */
function echoedModel(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const model = (body as Record<string, unknown>)['model']
  return typeof model === 'string' && model.trim() !== '' ? model : undefined
}

/** `choices[0].finish_reason` */
function finishReasonOf(body: unknown): string | undefined {
  const first = firstChoice(body)
  if (first === undefined) return undefined
  const reason = first['finish_reason']
  return typeof reason === 'string' ? reason : undefined
}

/** 推理型模型的思考内容（各家字段名不一：`reasoning_content` / `reasoning`） */
function reasoningOf(body: unknown): string | undefined {
  const message = messageOf(body)
  if (message === undefined) return undefined
  for (const key of ['reasoning_content', 'reasoning']) {
    const value = message[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** `choices[0]` */
function firstChoice(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const choices = (body as Record<string, unknown>)['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  return first !== null && typeof first === 'object' ? (first as Record<string, unknown>) : undefined
}

/** `choices[0].message` */
function messageOf(body: unknown): Record<string, unknown> | undefined {
  const first = firstChoice(body)
  if (first === undefined) return undefined
  const message = first['message']
  return message !== null && typeof message === 'object' ? (message as Record<string, unknown>) : undefined
}

/** 取非流式响应正文（兼容 `message.content` 为字符串与内容块数组两种形态） */
function contentOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const choices = (body as Record<string, unknown>)['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const message = (first as Record<string, unknown>)['message']
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as Record<string, unknown>)['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // 少数网关返回内容块数组：把 text 片段拼起来
    const text = content
      .map((block) =>
        block !== null && typeof block === 'object' && typeof (block as Record<string, unknown>)['text'] === 'string'
          ? ((block as Record<string, unknown>)['text'] as string)
          : '',
      )
      .join('')
      .trim()
    return text === '' ? undefined : text
  }
  return undefined
}

/**
 * 模块级单例：探测实现无状态（目标端点/密钥都由调用方每次传入），
 * 所以适配器可以只创建一个实例挂到 descriptor 上。
 */
export const openAiCompatProbe: LlmProbeCapability = createOpenAiCompatProbe()
