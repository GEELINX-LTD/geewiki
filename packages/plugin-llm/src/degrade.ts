/**
 * 模型不可用的**降级投影**（对外 message 的唯一出口）。
 *
 * ## 为什么这一层在 `@geewiki/llm`，而不在某个用模型的插件里
 * 本包已经拥有这条词汇表的两个前提：`LlmErrorCode`（错误码枚举）与 `redact`（脱敏）。
 * 「码 → 对外原因」的映射表只要出现在第二个地方就是两份真源——AI 侧此前正是这样：
 * `@geewiki/ai` 里一份 `degrade.ts`，而它同时服务问答与辅助写作两条线。本批把那条线
 * 拆成 `@geewiki/ai-qa` 与 `@geewiki/ai-writing`（原 `ai-assist`）后，这份映射只有一个合理的家。
 *
 * 两条纪律（沿用旧实现）：
 * 1. **按 code 映射，绝不按 message 文本分支**（`LlmChunk` 的 `error` 分支结构上就没有
 *    message 字段，按文本分支迟早失配）。
 * 2. 任何要外发的 message 都必须经过这里的 {@link makeDegraded}——它是 `redact` 在
 *    这条链路上的**唯一调用点**，避免以后有人新增一条降级路径却忘了脱敏。
 *    上游报错文本经常整段回显请求 URL 与鉴权头，一个漏点就等于把密钥发给浏览器。
 *
 * ## 为什么这里**没有** `search_unavailable` / `tools_unavailable`
 * 它们不是"模型降级原因"，而是"这个功能没有资料地基"。消费方用自己的错误码表达它们
 * （`search_unavailable` 曾属 `@geewiki/ai-qa` 的 `AskErrorCode`，随 P8 拆除；
 * 同一件事现在叫 **`tools_unavailable`**，属 `@geewiki/ai-assistant`——检索变成
 * 贡献工具之后，缺的不再是一个检索服务，而是**必需的那几条工具**）。
 * 别把功能缺失混进模型降级词汇表——混进去的代价是前端要为一条永远不会由模型产生的原因
 * 写模型侧文案。
 */
import { redact } from './redact.js'
import type { LlmErrorCode } from './types.js'

/**
 * 对外可判别的降级原因（前端据此选文案，**不要按 message 分支**）。
 *
 * 每一个成员都必须由 {@link CODE_TO_REASON} 的某个码映射而来——可达性由
 * `packages/plugin-llm/test/degrade.test.ts` 与 `packages/plugin-ai-qa/test/*` 钉住。
 * 注意与 **HTTP 错误码**的区别：`empty_query` / `too_long` 是 400 的错误码，
 * **不是**降级原因（空查询不可能"降级后仍给出答案"）。
 */
export type DegradedReason =
  | 'no_provider'
  | 'missing_credential'
  | 'invalid_credential'
  | 'rate_limit'
  | 'timeout'
  | 'context_window_exceeded'
  | 'network'
  | 'provider_error'

/** 降级说明：`message` **必须**经 {@link makeDegraded} 产出（内部即 `redact` 出口） */
export interface Degraded {
  reason: DegradedReason
  /** 上游错误码；本侧自身原因产生的降级为 null */
  code: LlmErrorCode | null
  message: string
}

/** `LlmErrorCode` → `DegradedReason` 的一一映射（唯一真源） */
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
 * @param reason  降级原因
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
