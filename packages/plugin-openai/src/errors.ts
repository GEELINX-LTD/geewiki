/**
 * 上游错误 → 契约错误码归一化。
 *
 * 原则（与 `@geewiki/llm` 的契约一致）：**判定必须基于 HTTP 状态码与错误体的结构化字段**，
 * 不能靠 message 文本模糊匹配——文本会被供应商改写、本地化，用它做分支会在换端点后静默失效。
 * 仅当结构化字段缺失时，才对"上下文超限"这一项退化为文本兜底（该场景文本极其稳定，
 * 且误判代价只是错误码不够精确，不会造成错误行为）。
 */
import type { LlmErrorCode } from '@geewiki/llm'

/** 从错误体里抽出的结构化信号（全部转小写，便于比对） */
export interface ErrorSignals {
  codes: string[]
  types: string[]
  /** 仅供"上下文超限"兜底判定使用 */
  messages: string[]
}

/** 上下文超限的文本兜底特征（只在结构化字段缺失时使用） */
const CONTEXT_TEXT_HINTS: readonly string[] = ['maximum context length', 'context length', 'too many tokens']

/**
 * 尽力从任意形状的错误体里抽取结构化字段。
 *
 * 兼容多种形状：`{error:{code,type,message}}`（OpenAI）、`{code,type,message}`（部分网关）、
 * `{error:{...}, message}`，以及纯文本体。
 */
export function extractErrorSignals(body: unknown): ErrorSignals {
  const codes: string[] = []
  const types: string[] = []
  const messages: string[] = []

  const pushString = (target: string[], value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') target.push(value.trim().toLowerCase())
  }

  const walk = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    pushString(codes, record['code'])
    pushString(types, record['type'])
    pushString(messages, record['message'])
    walk(record['error'], depth + 1)
  }

  if (typeof body === 'string') {
    pushString(messages, body)
  } else {
    walk(body, 0)
  }
  return { codes, types, messages }
}

/** 结构化字段是否表明"凭据无效"（区别于权限不足的 AUTH） */
function looksLikeInvalidCredential(signals: ErrorSignals): boolean {
  const invalidCodeHints = ['invalid_api_key', 'invalid_credential', 'incorrect_api_key', 'invalid_token']
  if (signals.codes.some((c) => invalidCodeHints.includes(c))) return true
  // 文本兜底仅限这一项：OpenAI 的 "Incorrect API key provided" 极稳定
  return signals.messages.some((m) => m.includes('incorrect api key') || m.includes('invalid api key'))
}

/** 结构化字段是否表明"上下文超限" */
function looksLikeContextOverflow(signals: ErrorSignals): boolean {
  if (signals.codes.includes('context_length_exceeded')) return true
  if (signals.types.some((t) => t.includes('context_length'))) return true
  return signals.messages.some((m) => CONTEXT_TEXT_HINTS.some((hint) => m.includes(hint)))
}

/**
 * HTTP 状态码 + 错误体 → 契约错误码。
 *
 * 映射表：
 * - `401`/`403`：凭据无效 → `INVALID_CREDENTIAL`；否则 `AUTH`
 * - `429` → `RATE_LIMIT`
 * - `400`/`422` 且表明上下文超限 → `CONTEXT_WINDOW_EXCEEDED`（否则 `PROVIDER_ERROR`）
 * - 其余非 2xx → `PROVIDER_ERROR`
 */
export function codeFromHttpError(status: number, body: unknown): LlmErrorCode {
  const signals = extractErrorSignals(body)
  if (status === 401 || status === 403) {
    return looksLikeInvalidCredential(signals) ? 'INVALID_CREDENTIAL' : 'AUTH'
  }
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 422) {
    return looksLikeContextOverflow(signals) ? 'CONTEXT_WINDOW_EXCEEDED' : 'PROVIDER_ERROR'
  }
  return 'PROVIDER_ERROR'
}

/**
 * `fetch` 抛出的异常 → 契约错误码。
 *
 * 判定顺序很重要：**先看两个信号源是否真的中止**（这能区分"我们自己超时"与"调用方取消"），
 * 再看异常本身的形态（`TimeoutError`）。仅当都不是时才归 `NETWORK`——连接被拒/重置、
 * DNS 失败、TLS 失败都走这一条。
 */
export function codeFromFetchError(
  err: unknown,
  externalSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): LlmErrorCode {
  if (externalSignal.aborted) return 'ABORTED'
  if (timeoutSignal.aborted) return 'TIMEOUT'
  if (err instanceof Error && err.name === 'TimeoutError') return 'TIMEOUT'
  return 'NETWORK'
}
