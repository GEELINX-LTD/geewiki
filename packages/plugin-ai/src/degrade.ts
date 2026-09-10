/**
 * 降级原因映射与安全外发（**所有对外 message 的唯一出口**）。
 *
 * 两条纪律：
 * 1. **按 code 映射，绝不按 message 文本分支**（`@geewiki/llm` 的契约要求）。
 * 2. 任何要外发的 message 都必须经过这里的 {@link makeDegraded}——它是 `redact` 的
 *    唯一调用点，避免以后有人新增一条降级路径却忘了脱敏。上游报错文本经常整段回显
 *    请求 URL 与鉴权头，一个漏点就等于把密钥发给浏览器。
 */
import { redact, type LlmErrorCode } from '@geewiki/llm'
import type { Degraded, DegradedReason } from './types.js'

/** LlmErrorCode → DegradedReason 的一一映射（types.ts 已声明这条对应关系） */
export const CODE_TO_REASON: Readonly<Record<LlmErrorCode, DegradedReason>> = {
  NO_ADAPTER: 'no_provider',
  MISSING_CREDENTIAL: 'missing_credential',
  INVALID_CREDENTIAL: 'invalid_credential',
  AUTH: 'invalid_credential',
  RATE_LIMIT: 'rate_limit',
  CONTEXT_WINDOW_EXCEEDED: 'context_window_exceeded',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  PROVIDER_ERROR: 'provider_error',
  ABORTED: 'provider_error',
}

/**
 * 构造对外降级信息：**message 必经脱敏**。
 * @param reason  降级原因（本插件自身原因时 code 传 null）
 * @param code    上游错误码（无上游参与时为 null）
 * @param message 人类可读说明（可含上游文本，出口处统一脱敏）
 */
export function makeDegraded(reason: DegradedReason, code: LlmErrorCode | null, message: string): Degraded {
  return { reason, code, message: redact(message) }
}

/** 由上游错误码构造降级信息（reason 按 {@link CODE_TO_REASON} 推导） */
export function degradedFromCode(code: LlmErrorCode, message: string): Degraded {
  return makeDegraded(CODE_TO_REASON[code], code, message)
}
