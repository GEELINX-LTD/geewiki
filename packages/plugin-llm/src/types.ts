/**
 * @geewiki/llm 的类型契约（本批只交付契约 + 降级 + 密钥安全，不含任何厂商 adapter）。
 *
 * 设计要点（与后续 adapter 批次的约定）：
 * 1. **调用方按 `type`/`code` 分支，绝不按 `message` 文本分支**——message 是给人看的，
 *    可能被脱敏、也可能被上游改写；用文本做逻辑分支会在换供应商时静默失效。
 * 2. **`error` chunk 不带 message 字段**：上游报错文本里可能夹带密钥（URL query、鉴权头回显），
 *    从结构上让它无处可去，比"记得脱敏"更可靠。
 * 3. **`available()` 是降级的唯一入口**：路由是否可用只由它回答，调用方无需自己探 key。
 * 4. 本服务**绝不重试**：重试涉及退避、配额与幂等语义，属于独立层的职责；
 *    在这里偷偷重试会让上层无法判断"这次失败到底花了多少配额"。
 */

/** 统一错误码：跨 provider 可判别，不依赖各厂商的错误文本 */
export type LlmErrorCode =
  | 'NO_ADAPTER'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_CREDENTIAL'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROVIDER_ERROR'
  | 'ABORTED'

/** 路由描述（供管理台展示与降级判定；管理台据此渲染"可用/不可用"） */
export interface LlmRouteDescriptor {
  /** 稳定唯一标识；重复注册必须抛错（不得静默覆盖） */
  readonly route: string
  /** 中文可读名（管理台展示用），**不参与逻辑分支** */
  readonly label: string
  readonly vendor: string
  /** 默认模型名，仅展示 */
  readonly model: string
  /** **环境变量名**（不是值！）——配置里只允许出现名字，绝不出现密钥本身 */
  readonly apiKeyEnv?: string
  /** 降级契约的唯一入口：false 表示当前不可用（缺 key / 未就绪等） */
  available(): boolean
}

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface LlmRequest {
  /** 指定路由；缺省用服务配置的 defaultRoute，再缺省取第一个可用路由 */
  readonly route?: string
  readonly model?: string
  readonly messages: readonly LlmMessage[]
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface LlmUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
}

/**
 * 流式 chunk 联合。**调用方必须按 type/code 分支，绝不按 message 文本分支**。
 * `status` 用于"上游已连接/正在检索"之类的进度提示，可携带 message（经脱敏后输出）。
 */
export type LlmChunk =
  | {
      readonly type: 'status'
      readonly provider: string
      readonly model: string
      readonly code?: LlmErrorCode
      readonly message?: string
    }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'done'; readonly provider: string; readonly model: string; readonly usage?: LlmUsage }
  | { readonly type: 'error'; readonly code: LlmErrorCode }

export interface LlmProvider {
  readonly route: string
  readonly descriptor: LlmRouteDescriptor
  stream(req: LlmRequest, opts: { signal: AbortSignal }): AsyncIterable<LlmChunk>
}

export interface LlmService {
  /** 注册 provider；**重复 route 必须抛错**（不得静默覆盖）；返回注销函数 */
  register(provider: LlmProvider): () => void
  /** 全部已注册路由（含不可用者，便于管理台展示"为什么不可用"） */
  listProviders(): readonly LlmRouteDescriptor[]
  /** 仅 `available()` 为真者 */
  availableProviders(): readonly LlmRouteDescriptor[]
  /**
   * 流式生成。**保证终止 chunk（`done`/`error`）恰出现一次且在末位**，
   * 且**绝不抛异常**——消费方可以无判空地 `for await`。
   */
  stream(req: LlmRequest, opts?: { signal?: AbortSignal }): AsyncIterable<LlmChunk>
}
