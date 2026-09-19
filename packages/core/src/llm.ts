/**
 * **LLM 契约面**（★ F3：原 `@geewiki/plugin-llm` 的 `types.ts` + `tools.ts` 类型 + `credentials.ts` 的
 * `CredentialResult`，搬到这里成为单一真源）。
 *
 * 为什么搬：LLM 契约原先声明在**实现它的包**里。想换掉 LLM 路由实现的插件，
 * 必须为了拿接口类型而依赖它要替换的那个包 —— 语义倒挂。契约放 core 后，
 * 适配器与替换实现都只依赖 `@geewiki/core`。
 *
 * 留在 `@geewiki/plugin-llm` 的是**运行期**部分：`resolveCredential`（读环境变量）、
 * `assembleToolCalls`（流式增量拼装）、服务实现本身。类型与实现分离正是本文件的目的。
 */

/**
 * @geewiki/llm 的类型契约（统一配置 + 降级 + 密钥安全 + 探测，不含任何厂商 adapter）。
 *
 * 设计要点（与后续 adapter 批次的约定）：
 * 1. **调用方按 `type`/`code` 分支，绝不按 `message` 文本分支**——message 是给人看的，
 *    可能被脱敏、也可能被上游改写；用文本做逻辑分支会在换供应商时静默失效。
 * 2. **`error` chunk 不带 message 字段**：上游报错文本里可能夹带密钥（URL query、鉴权头回显），
 *    从结构上让它无处可去，比"记得脱敏"更可靠。
 * 3. **`available()` 是降级的唯一入口**：路由是否可用只由它回答，调用方无需自己探 key。
 * 4. 本服务**绝不重试**：重试涉及退避、配额与幂等语义，属于独立层的职责；
 *    在这里偷偷重试会让上层无法判断"这次失败到底花了多少配额"。
 * 5. **采样温度不由本层决定**：设置里没有 temperature，请求也不下发——
 *    各家服务端默认值不同，客户端猜一个只会覆盖掉它调好的值。
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
  /** 当前生效的模型名（未配置时回落到适配器默认值），仅展示 */
  readonly model: string
  /**
   * **环境变量名**（不是值！）——统一配置里可选的一项兜底来源。
   *
   * 界面直接填写的密钥（`config/secrets.json`，见 `@geewiki/llm` 的 `apiKey` 字段）
   * 优先于本项；两者都没有才是 `MISSING_CREDENTIAL`。
   */
  readonly apiKeyEnv?: string
  /**
   * 适配器在用户未填 `baseUrl` / `model` 时使用的兜底默认值。
   *
   * 存在的意义是**让表单能就地给提示**（下拉切换服务商时展示"该服务商的默认端点/模型"），
   * 而不是让每个适配器把自己的默认值写死进用户配置——用户没填就是没填，
   * 由适配器在请求时兜底，换服务商不需要改任何存量配置。
   */
  readonly defaults?: { readonly baseUrl?: string; readonly model?: string }
  /** 一句话说明（管理台在下拉项与状态里展示），**不参与逻辑分支** */
  readonly description?: string
  /**
   * 可选的**探测能力**（模型清单 + 一次最小对话）：设置页的「获取模型」「测试连接」走它。
   *
   * 未声明 = 该服务商不支持这两项，设置页会明确说明原因，而不是静默显示成功。
   */
  readonly probe?: LlmProbeCapability
  /** 降级契约的唯一入口：false 表示当前不可用（缺 key / 未就绪等） */
  available(): boolean
}

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /**
   * `role:'assistant'` 时：本轮请求的工具调用。
   *
   * 这里是**完整调用**（不是流式片段）——它只在"把模型上一轮产出过的东西回灌给它"
   * 时使用，故由 {@link assembleToolCalls} 拼好后再填进来。
   */
  readonly toolCalls?: readonly LlmToolCall[]
  /**
   * `role:'tool'` 时：这是**哪一个**调用的结果（对应 {@link LlmToolCall.id}，原样往返）。
   *
   * 缺了它上游无法把结果配回调用；多数网关会直接 400，而不是忽略这条消息。
   */
  readonly toolCallId?: string
}

export interface LlmRequest {
  /** 指定路由；缺省用服务配置的 defaultRoute，再缺省取第一个可用路由 */
  readonly route?: string
  readonly model?: string
  readonly messages: readonly LlmMessage[]
  readonly maxTokens?: number
  /**
   * 采样温度：**默认不填**。留空即不下发 `temperature`，由服务端按它自己的默认值采样。
   *
   * 统一配置里**刻意没有**这一项（见本文件头第 5 条）；只有确有需求的调用方才显式给值。
   */
  readonly temperature?: number
  /**
   * 本轮可用的工具。
   *
   * **不填（或空数组）= 请求体里不出现 `tools` 键**——不是发一个空数组。
   * 存量调用方（问答 / 辅助写作）的请求因此逐字节不变，这条是有测试钉住的。
   */
  readonly tools?: readonly LlmToolDef[]
  /**
   * 工具选择策略。**不填 = 不下发 `tool_choice`**，由服务端用它自己的默认值
   * （OpenAI 兼容形态下"给了 tools 就是 auto"）。
   *
   * 为什么不替服务端补一个 `'auto'`：与 `temperature` 同一条理由——
   * 各家网关对"默认"的写法与含义并不一致，客户端补一个默认值等于替服务端做决定；
   * 而且补了之后，"这一轮只准聊、不准动手"就变成一个必须显式写 `'none'` 才能表达的事。
   */
  readonly toolChoice?: LlmToolChoice
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
  /**
   * 推理型模型的**思考内容**增量（DeepSeek 的 `reasoning_content`、部分网关的 `reasoning`）。
   *
   * 为什么**不复用 `text-delta`**：思考与正文是两种东西，混成一条流会同时坏两处——
   * ① **历史**：正文要进 `LlmMessage[]` 回传给上游，思考**不该**进（多数网关拒收带
   * `reasoning_content` 的 assistant 消息，个别会把上一轮的思考当成新指令）；
   * ② **界面**：思考要折起来、正文要摊开，一条流里分不出种类就只能二选一。
   *
   * 消费者**可以完全忽略它**（不做这个分支就是忽略）：它只决定"看不看得见思考"，
   * 不影响任何一轮对话的正确性。
   */
  | { readonly type: 'reasoning-delta'; readonly text: string }
  /**
   * 工具调用的一个流式片段。**消费者必须自己累加**（与 `text-delta` 对称），
   * 拼装请用 {@link assembleToolCalls}——不要在各插件里各写一遍。
   *
   * 何时"这一轮是工具轮"由消费者判断：累加到了任何工具片段就是。
   */
  | ({ readonly type: 'tool-call-delta' } & LlmToolCallDelta)
  | {
      readonly type: 'done'
      readonly provider: string
      readonly model: string
      readonly usage?: LlmUsage
      /**
       * 上游的结束原因（原样透传，不解释成枚举——各家取值不完全一致）。
       *
       * 调用方真正要关心的是 **`'length'`**：输出被长度上限截断。
       * 此时拼出来的工具调用参数可能是**半截 JSON**，拿去执行会 JSON.parse 失败，
       * 更糟的是可能"恰好是合法 JSON 但少了后半段"——写操作的参数被截断是危险事，
       * 所以这个信号必须能传到调用方，而不是让它只看见一次莫名的解析失败。
       */
      readonly finishReason?: string
    }
  | { readonly type: 'error'; readonly code: LlmErrorCode }

export interface LlmProvider {
  readonly route: string
  readonly descriptor: LlmRouteDescriptor
  stream(req: LlmRequest, opts: { signal: AbortSignal }): AsyncIterable<LlmChunk>
}

/**
 * 思考强度（统一切面）。
 *
 * `'off'` = **不发任何思考相关参数**（不是发一个"关闭"值）—— 各家网关对"关闭"的写法
 * 并不一致（OpenAI 没有该参数、DeepSeek 是 `thinking.type='disabled'`、Qwen 是
 * `enable_thinking=false`），发一个猜的参数比不发更容易让上游 400。
 *
 * 除 `'off'` 外**取值不设白名单**：`low` / `medium` / `high` 只是 OpenAI 标准的常见档位，
 * 各家网关还有自己的写法（`minimal`、`extra-high`、`enabled` …），所以它是**自由文本**：
 * 填什么就按 `reasoning_effort` 原样下发什么。网关私有形态（DeepSeek 的 `thinking`、
 * Qwen 的 `enable_thinking`）走 `extraBody` 透传。
 */
export type LlmReasoningEffort = 'off' | (string & {})

/** 密钥来源：界面填写的密钥 / 环境变量 / 未配置（只报"来源"，绝不回显值） */
export type LlmCredentialSource = 'inline' | 'env' | 'none'

/**
 * 一次连通性探测的**目标**（服务商适配器拿到的有效端点 / 密钥 / 模型）。
 *
 * apiKey 是明文，只能用于构造鉴权头：既不进日志，也不进响应体
 * （`@geewiki/llm` 的 `/api/llm/*` 探测端点在出响应前统一 {@link redact} 脱敏）。
 */
export interface LlmProbeTarget {
  /** 端点根地址（已按 表单草稿 > 已存配置 > 适配器默认 解析完毕） */
  readonly baseUrl: string
  readonly apiKey: string
  /** 想试的模型；省略时由适配器自行选择（清单探测用不上，对话探测取清单首个） */
  readonly model?: string
  /** 探测总超时（毫秒）：到点 abort，避免设置页被一个死端点卡住 */
  readonly timeoutMs: number
}

/** 探测失败的可读描述（`code` 供分支，`message` / `detail` 供展示，均已脱敏） */
export interface LlmProbeFailure {
  /** 失败类别；`unsupported` = 该服务商没有实现这项探测能力 */
  readonly code:
    | 'network'
    | 'timeout'
    | 'auth'
    | 'not_found'
    | 'rate_limit'
    | 'http'
    | 'bad_response'
    | 'unsupported'
    | 'no_provider'
    | 'no_credential'
    | 'invalid_input'
  /** 上游 HTTP 状态码（网络层失败时没有） */
  readonly status?: number
  /** 一句话结论（中文，展示用） */
  readonly message: string
  /** 上游原文 / 异常详情（已脱敏、已截断）；没有则省略 */
  readonly detail?: string
}

/** 探测结果：成功带数据，失败带 {@link LlmProbeFailure} */
export type LlmProbeOutcome<T extends object> =
  | ({ readonly ok: true } & T)
  | ({ readonly ok: false } & LlmProbeFailure)

/**
 * 服务商的**探测能力**（可选）：模型清单 + 一次最小对话。
 *
 * 为什么放在适配器上而不是统一实现：URL 形态与错误体各家不同
 * （`data[].id` vs `models[].id`、`{error:{message}}` vs 纯文本），只有适配器知道自己
 * 该怎么问。探测**不消耗**对话配额之外的任何东西，且实现方必须自带超时。
 */
export interface LlmProbeCapability {
  /** 列出该端点支持的模型 id（OpenAI 兼容形态是 `GET {baseUrl}/models`） */
  listModels(
    target: LlmProbeTarget,
  ): Promise<LlmProbeOutcome<{ readonly models: readonly string[] }>>
  /** 一次最小对话补全（非流式），验证"密钥能用、模型能答" */
  chat(
    target: LlmProbeTarget,
  ): Promise<
    LlmProbeOutcome<{ readonly model?: string; readonly reply: string; readonly latencyMs: number }>
  >
}

/**
 * 探测请求（设置页的**表单草稿**可覆盖已保存配置：改一半就能测，不必先保存）。
 *
 * `apiKey` 省略 = 用已保存的密钥（界面不回显密钥，所以"留空"绝不能理解为"没有密钥"）。
 */
export interface LlmProbeRequest {
  /** 服务商路由 id；省略 = 配置里选的 provider，再省略 = 首个可用适配器 */
  readonly provider?: string
  /** 端点根地址；省略 = 配置值，再省略 = 适配器默认端点 */
  readonly baseUrl?: string
  /** 密钥明文；省略 = 已保存的密钥 */
  readonly apiKey?: string
  /** 想试的模型；省略 = 配置值，再省略 = 清单首个 */
  readonly model?: string
}

/** 模型清单探测的结果（`ok:false` 时 `models` 为空数组，原因在 `error`） */
export interface LlmModelListResult {
  readonly ok: boolean
  /** 实际探测的服务商 / 端点，便于用户确认"我测的到底是哪一个" */
  readonly provider: string
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly error?: LlmProbeFailure
}

/** 连接测试的汇总结果：两步探测各自独立呈现 */
export interface LlmConnectionTestResult {
  /**
   * 以**对话探测**为准：有些网关不支持 `/models` 却能正常对话，
   * 把 models 失败算成整体失败会让人对着一个能用的端点反复排查。
   */
  readonly ok: boolean
  readonly provider: string
  readonly baseUrl: string
  /** 实际测试的模型；目标解析失败时省略 */
  readonly model?: string
  /** 目标解析失败（没有可用服务商 / 没有密钥 / baseUrl 非法）：此时两步都未执行 */
  readonly error?: LlmProbeFailure
  readonly models?: { readonly ok: boolean; readonly models: readonly string[]; readonly error?: LlmProbeFailure }
  readonly chat?: {
    readonly ok: boolean
    readonly model?: string
    readonly reply?: string
    readonly latencyMs?: number
    readonly error?: LlmProbeFailure
  }
}

/**
 * **统一模型接入设置**（不含密钥）。这是"一处配置"的运行时形态：
 * 用户只在 `@geewiki/llm` 的表单里填一次，所有适配器经 {@link LlmService.settings}
 * **现读**同一份值 —— 适配器因此不再持有任何自己的配置。
 *
 * 注意：这里是**扁平**的运行时形状；配置里的 `advanced` 分组只是表单收纳，
 * 读取时两种写法都支持（见 `settings.ts` 的 {@link deriveSettings}）。
 */
export interface LlmSettings {
  /** 选定的服务商（= 适配器注册的路由名）；空 = 自动使用第一个可用服务商 */
  readonly provider: string
  /** 端点根地址；空 = 用适配器的默认端点 */
  readonly baseUrl: string
  /** 模型名；空 = 用适配器的默认模型 */
  readonly model: string
  /** 模型上下文窗口（token）：上层据此裁剪检索上下文 */
  readonly contextWindow: number
  /** 单次回答的最长输出（token）：请求未显式给出 maxTokens 时的默认值 */
  readonly maxOutputTokens: number
  /** 思考强度（见 {@link LlmReasoningEffort}）；`'off'` = 不下发该参数 */
  readonly reasoningEffort: LlmReasoningEffort
  /** 单次请求总超时（毫秒） */
  readonly timeoutMs: number
  /** 是否请求上游附带 token 用量 */
  readonly includeUsage: boolean
  /** 额外请求体（**规范化后的 JSON 对象文本**，空串 = 无）：原样并入上游请求体 */
  readonly extraBody: string
  /**
   * 密钥的**环境变量名**（不是值！空串 = 未配置这条兜底路径）。
   *
   * 它是"名字"，可以安全展示（适配器把它填进 `descriptor.apiKeyEnv` 供管理台显示）；
   * 密钥值本身只能经 {@link LlmService.resolveApiKey} 取，且绝不进响应体。
   */
  readonly apiKeyEnv: string
}

export interface LlmService {
  /** 注册 provider；**重复 route 必须抛错**（不得静默覆盖）；返回注销函数 */
  register(provider: LlmProvider): () => void
  /** 全部已注册路由（含不可用者，便于管理台展示"为什么不可用"） */
  listProviders(): readonly LlmRouteDescriptor[]
  /** 仅 `available()` 为真者 */
  availableProviders(): readonly LlmRouteDescriptor[]
  /**
   * 统一接入设置（**现读**，每次调用返回当前值）。
   *
   * 适配器必须经这里取值，而**不得**把设置缓存进自己的闭包：配置热更新后
   * 缓存会让"界面已改、请求还用旧端点"成为需要重启才能恢复的问题。
   */
  settings(): LlmSettings
  /**
   * 解析当前生效的密钥。返回值**含密钥明文**，只允许用于构造上游鉴权头 ——
   * 绝不进日志、响应体或错误信息（`descriptor` 只暴露来源，不暴露值）。
   */
  resolveApiKey(): CredentialResult
  /** 密钥来源（`inline` / `env` / `none`），可安全对外展示 */
  credentialSource(): LlmCredentialSource
  /**
   * 流式生成。**保证终止 chunk（`done`/`error`）恰出现一次且在末位**，
   * 且**绝不抛异常**——消费方可以无判空地 `for await`。
   */
  stream(req: LlmRequest, opts?: { signal?: AbortSignal }): AsyncIterable<LlmChunk>
  /**
   * 读取服务商支持的模型清单（设置页的模型下拉）。
   *
   * **不抛异常**：任何失败都折算成 `{ ok:false, error }`，且 `error.detail` 已脱敏。
   */
  listModels(req?: LlmProbeRequest): Promise<LlmModelListResult>
  /**
   * 连通性测试（模型清单 + 一次最小对话）。同样**不抛异常**、结果已脱敏。
   *
   * 它只是一次旁路验证：不进对话链路、不参与降级判定（可用性判定只看 `available()`）。
   */
  testConnection(req?: LlmProbeRequest): Promise<LlmConnectionTestResult>
}

/* ============================ 工具调用（function calling）============================ */

/**
 * 工具定义。字段名与 OpenAI 兼容形态**不同构**（上游是 `{type:'function', function:{…}}`），
 * 这一层包装由适配器负责：契约面只描述"有一个什么工具"，不描述某一家怎么拼请求。
 */
export interface LlmToolDef {
  /** 进模型工具表的名字；由工具注册表保证全局唯一（重复必须抛错，不得静默覆盖） */
  readonly name: string
  /** 给模型看的一句话说明。它直接吃上下文预算，且**准确度决定模型会不会用对** */
  readonly description: string
  /** JSON Schema（object 根） */
  readonly parameters: Record<string, unknown>
}

/**
 * 工具选择策略。
 *
 * - `'auto'`：模型自己决定调不调（多数网关给了 tools 就是这个默认值）；
 * - `'none'`：禁用（用来表达"这一轮只准聊，不准动手"）；
 * - `'required'`：至少调一个；
 * - `{name}`：强制调指定的那一个。
 */
export type LlmToolChoice = 'auto' | 'none' | 'required' | { readonly name: string }

/**
 * 一个**完整的**工具调用。
 *
 * `id` 是把结果回灌给上游时的配对键（`LlmMessage.toolCallId`），必须原样往返。
 * 合规上游一定会给；**空串表示上游没给**（不合规），此时把它回灌会失败——
 * 调用方应视为不可执行，而不是拿空 id 去试。
 */
export interface LlmToolCall {
  readonly id: string
  readonly name: string
  /** 模型产出的**原样** arguments JSON 文本（可能是空串、坏 JSON 或被截断的半截） */
  readonly arguments: string
}

/**
 * 工具调用的一个**流式片段**。
 *
 * 上游按 `index` 分片：首个片段给 `id` 与 `name`（arguments 常是空串），
 * 后续片段只给 `argumentsDelta`。**同一 index 的片段必须按到达顺序拼接**；
 * 不同 index 之间没有顺序保证，故拼装时按 index 排序（见 {@link assembleToolCalls}）。
 */
export interface LlmToolCallDelta {
  /** 同一轮内第几个调用（0 起）。上游给非法值（负数 / 非整数）时按 0 处理 */
  readonly index: number
  /** 只在首个片段出现 */
  readonly id?: string
  /** 只在首个片段出现 */
  readonly name?: string
  /** arguments 的 JSON 文本片段 */
  readonly argumentsDelta?: string
}

/* ============================ 凭据 ============================ */

/** 凭据解析结果（不抛异常：调用方多半处在"降级"语境里） */
export type CredentialResult =
  | { ok: true; value: string }
  | { ok: false; code: 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' }
