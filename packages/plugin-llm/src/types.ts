/**
 * ★ F3：本文件的契约已**下沉到 `@geewiki/core`**（真源 `packages/core/src/llm.ts`）。
 *
 * 这里只做**转出**，保证既有 `import { ... } from './types.js'` 与
 * `import { ... } from '@geewiki/llm'` 都不破。
 * 但**新的消费方与替换实现请直接从 `@geewiki/core` 取** —— 换掉 LLM 路由实现的插件
 * 不该为了拿接口类型而依赖它要替换的那个包（语义倒挂，F3 消掉的正是它）。
 */
export type {
  LlmErrorCode,
  LlmRouteDescriptor,
  LlmImagePart,
  LlmMessage,
  LlmRequest,
  LlmUsage,
  LlmChunk,
  LlmProvider,
  LlmReasoningEffort,
  LlmCredentialSource,
  LlmProbeTarget,
  LlmProbeFailure,
  LlmProbeOutcome,
  LlmProbeCapability,
  LlmProbeRequest,
  LlmModelListResult,
  LlmConnectionTestResult,
  LlmSettings,
  LlmService,
} from '@geewiki/core'
