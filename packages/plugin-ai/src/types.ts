/**
 * @geewiki/ai 的对外响应契约（跨包稳定面：前端、CLI、测试都依赖这里）。
 *
 * **核心不变式：有没有 API key，响应是同一个结构。**
 * 差别只体现在 `mode` / `degraded` / `answer` 三个字段上，**绝不**用 4xx/5xx 表达
 * "没有配置模型"——那会让前端不得不为"降级"写一套与"成功"平行的错误分支，
 * 而产品承诺恰恰是"没有 key 时也完整可用"。状态码只表达：200 正常（含降级、含空结果）、
 * 400 调用方输入问题、500 我们自己的代码炸了。
 */
import type { LlmErrorCode, LlmUsage } from '@geewiki/llm'

/**
 * 降级原因（**跨 provider 可判别**，前端据此选文案，不要按 message 分支）。
 *
 * 前 8 个与 `LlmErrorCode` 一一对应（映射见 `./degrade.ts`），后 2 个是本插件自身
 * 产生的原因：检索服务不可用、查询为空。
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
  | 'search_unavailable'
  | 'empty_query'

/** 降级说明：`message` **必须**经 `@geewiki/llm` 的 `redact` 处理后才可外发 */
export interface Degraded {
  reason: DegradedReason
  /** 上游错误码（本插件自身原因产生的降级为 null，如 search_unavailable） */
  code: LlmErrorCode | null
  message: string
}

/**
 * 一条来源。
 *
 * `snippet` 来自 `search-service`，是**服务端已 HTML 转义**的 HTML（只含 `<mark>`）——
 * 消费方**不得二次转义**（会显示成字面 `&lt;mark&gt;`），也**不得**当纯文本插入页面。
 */
export interface AskSource {
  /** 引用编号：从 1 起，**只对 `used:true` 的条目连续编号**（与 prompt 里的 [n] 严格一致） */
  n: number | null
  slug: string
  title: string
  snippet: string
  /**
   * 相关度（原样透传 `search-service` 的 `score`）：越大越相关。
   *
   * **仅在同一次查询的结果内部可比**——FTS 路是 BM25 取负（非归一化，值域无界），
   * LIKE 路恒为 0；跨查询、跨 mode 比大小无意义（契约见 `@geewiki/search`）。
   */
  score: number
  updated_at: string
  /** 是否真的进了上下文（被截断策略丢弃的仍会列出，但为 false 且 n 为 null） */
  used: boolean
}

/** 回答的呈现格式：检索-only 的抽取式摘要是纯文本；模型输出按 markdown 呈现 */
export type AnswerFormat = 'markdown' | 'plain'

/**
 * `POST /api/ai/ask` 与 `GET /api/ai/ask` 的响应体。
 *
 * `mode` 语义（**诚实反映实际发生了什么**，不要为了好看而虚报）：
 * - `retrieval-only`：没有可用 provider，只返回检索结果 + 零成本抽取式摘要；
 * - `rag`：模型确实生成了回答（本批尚未接线，见 `generate()`）；
 * - `rag-partial`：模型生成了部分回答后中断（本批尚未接线）。
 */
export interface AskResponse {
  ok: true
  query: string
  mode: 'retrieval-only' | 'rag' | 'rag-partial'
  degraded: Degraded | null
  /** 无模型时为抽取式摘要；模型不可用且无来源时为 null */
  answer: string | null
  answerFormat: AnswerFormat
  sources: readonly AskSource[]
  retrieval: {
    mode: 'fts' | 'like'
    /** 全量命中数（不受 limit 影响，与 search-service 一致） */
    total: number
    /** 本次实际请求的条数上限 */
    limit: number
  }
  usage: LlmUsage | null
  elapsedMs: number
  /** 回答是否被中断/截断（本批恒 false；接线后由模型路径决定） */
  partial: boolean
}

/** `GET /api/ai/capabilities` 的响应体：前端据此决定是否显示"未配置模型"提示 */
export interface CapabilitiesResponse {
  ok: true
  /** 是否存在可用的 LLM provider（本批恒 false：尚无 adapter） */
  available: boolean
  /** 是否处于降级（= !available，显式给出以免前端做双重否定） */
  degraded: boolean
  /** 全部已注册路由（含不可用者，便于展示"为什么不可用"） */
  providers: readonly {
    route: string
    label: string
    vendor: string
    model: string
    available: boolean
  }[]
  /** 降级时的人类可读说明（已脱敏） */
  message: string
}
