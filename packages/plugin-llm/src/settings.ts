/**
 * **统一模型接入设置**：配置 → 运行时设置的解析与规范化（纯函数）。
 *
 * 本模块是"一处配置"的落点。用户只在 `@geewiki/llm` 的表单里填一次
 * （服务商 / 端点 / 密钥 / 模型 / 上下文长度 / 最长输出 / 思考强度），
 * 适配器插件（`@geewiki/openai` 等）**不再持有任何自己的配置**，
 * 而是在每次请求时经 `llm-service.settings()` 现读同一份值。
 *
 * 四条边界：
 * 1. **密钥值绝不进 `plugins.*.json`**：`apiKey` 在配置系统里是 `role: 'secret'` 字段，
 *    由管理器单独落盘到 gitignored 的密钥文件（见 `@geewiki/manager` 的 `secrets.ts`）；
 *    本模块只负责"界面填的优先、环境变量兜底"这条取值顺序。
 * 2. **`extraBody` 必须是合法 JSON 对象**：非法即拒绝激活，而不是静默忽略 ——
 *    否则用户会以为私有参数已生效，而实际请求里什么都没有。
 * 3. **空串一律表示"用适配器的默认值"**，不在这一层写死任何厂商事实
 *    （`baseUrl` / `model` 的兜底属于适配器，见 {@link LlmRouteDescriptor.defaults}）。
 * 4. **没有采样温度**：各家服务端的默认温度不同，客户端补一个默认值等于替服务端做决定，
 *    所以配置与请求里都不出现 `temperature`（要覆盖只能在 `extraBody` 里显式写）。
 */
import { type CredentialResult, resolveCredential } from './credentials.js'
import type { LlmCredentialSource, LlmReasoningEffort, LlmSettings } from './types.js'

/**
 * 思考强度的**建议档位**（下拉里展示的候选，**不是白名单**）。
 *
 * 该字段实际接受任意文本：各家网关的写法比这四档多（`minimal`、`extra-high`、`enabled` …），
 * 收死成枚举会让"用自家网关的私有档位"变成一件要改代码的事。
 */
export const REASONING_EFFORT_PRESETS: readonly string[] = ['off', 'low', 'medium', 'high']

/** 上下文窗口默认值（token）：128K 是当代主流模型的常见档位 */
export const DEFAULT_CONTEXT_WINDOW = 128000
/** 最长输出默认值（token） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096
/** 单次请求总超时默认值（毫秒） */
export const DEFAULT_TIMEOUT_MS = 60000
/**
 * 连通性探测的超时上限（毫秒）。
 *
 * 探测发生在设置页：用户点一下就要看到结果，等 60 秒只会让人以为页面挂了。
 * 因此取 `min(配置 timeoutMs, 本值)`；对话探测的首 token 延迟可能到几秒，20s 足够。
 */
export const PROBE_TIMEOUT_MS = 20000
/** `extraBody` 的字符上限：请求体透传口，给一个上限免得配置里塞进一整篇文档 */
export const MAX_EXTRA_BODY_CHARS = 4096

/**
 * 收纳进表单「高级选项」的配置项。
 *
 * 它们都是**可选的调优/兜底**项，日常配置用不到，所以不占主表单的视线；
 * 运行时形状仍是扁平的（见 {@link LlmSettings}），且**旧配置写在顶层也能读**
 * ——见 {@link deriveSettings} 里的取值顺序。
 */
export interface LlmAdvancedConfig {
  /** 密钥的兜底来源：环境变量名（界面填写的密钥优先） */
  apiKeyEnv?: string
  /** 单次请求总超时（毫秒） */
  timeoutMs?: number
  /** 是否请求上游附带 token 用量 */
  includeUsage?: boolean
  /** 额外请求体（JSON 对象文本，透传给上游） */
  extraBody?: string
}

/**
 * `@geewiki/llm` 的配置形状 = **统一模型接入设置**（密钥为写一次、不可回读的字段）。
 */
export interface LlmConfig extends LlmAdvancedConfig {
  /** 服务商 = 适配器注册的路由名；空 = 自动取第一个可用服务商 */
  provider?: string
  /** 端点根地址；空 = 适配器默认值 */
  baseUrl?: string
  /** API 密钥（`role: 'secret'`：保存后不再回显，留空 = 不修改） */
  apiKey?: string
  /** 模型名；空 = 适配器默认值 */
  model?: string
  /** 上下文窗口（token） */
  contextWindow?: number
  /**
   * 当前模型是否支持图像输入（多模态）。**缺省 false（从严）**。
   *
   * 为什么必须由人显式声明：OpenAI 兼容协议里没有能问出这件事的字段，
   * 而猜错的代价不对称（详见 `LlmSettings.supportsVision` 的注释）。
   */
  supportsVision?: boolean
  /** 最长输出（token） */
  maxOutputTokens?: number
  /** 思考强度；`'off'` = 不下发该参数（自由文本，见 {@link REASONING_EFFORT_PRESETS}） */
  reasoningEffort?: LlmReasoningEffort
  /** 单次请求总超时（毫秒）〔表单里属「高级选项」〕 */
  timeoutMs?: number
  /** 是否请求上游附带 token 用量〔表单里属「高级选项」〕 */
  includeUsage?: boolean
  /** 额外请求体（JSON 对象文本，透传给上游）〔表单里属「高级选项」〕 */
  extraBody?: string
}

/**
 * 规范化思考强度：去空白、空串归一为 `'off'`，`'OFF'`/`' Off '` 也归一为 `'off'`。
 *
 * 其余取值**原样保留**（不 lowercase）：网关私有档位可能大小写敏感，
 * 在这一层"顺手规范一下"会把一个能用的值改坏。
 */
export function normalizeReasoningEffort(value: unknown): LlmReasoningEffort {
  if (typeof value !== 'string') return 'off'
  const trimmed = value.trim()
  if (trimmed === '') return 'off'
  return trimmed.toLowerCase() === 'off' ? 'off' : trimmed
}

/**
 * 解析 `extraBody`：空串 = 无额外参数；其余必须是**JSON 对象**（不是数组/标量）。
 *
 * 成功时返回**规范化后的文本**（`JSON.stringify` 的紧凑形态），使"同一份配置的两次解析"
 * 逐字节相等 —— 会话层叠加的 `isDeepStrictEqual` 比较依赖这条性质，否则
 * "用户重排了键顺序"会被当成一次真实的配置变更，白做一次 dispose + apply。
 */
export function parseExtraBody(
  text: string | undefined,
): { ok: true; value: string } | { ok: false; message: string } {
  const raw = (text ?? '').trim()
  if (raw === '') return { ok: true, value: '' }
  if (raw.length > MAX_EXTRA_BODY_CHARS) {
    return { ok: false, message: `extraBody 过长（${raw.length} 字符，上限 ${MAX_EXTRA_BODY_CHARS}）` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // 只回报解析器的位置信息，不回显原文：这段文本可能被误贴进密钥
    return { ok: false, message: `extraBody 不是合法 JSON：${(err as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'extraBody 必须是 JSON **对象**（如 {"thinking":{"type":"enabled"}}）' }
  }
  return { ok: true, value: JSON.stringify(parsed) }
}

/**
 * 把配置解析为运行时设置（补齐默认值；`extraBody` 已假定通过 {@link parseExtraBody}）。
 *
 */
export function deriveSettings(config: LlmConfig): LlmSettings {
  const apiKeyEnv = (config.apiKeyEnv ?? '').trim()
  const extra = parseExtraBody(config.extraBody)
  return {
    provider: (config.provider ?? '').trim(),
    baseUrl: (config.baseUrl ?? '').trim(),
    model: (config.model ?? '').trim(),
    contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    includeUsage: config.includeUsage ?? true,
    extraBody: extra.ok ? extra.value : '',
    apiKeyEnv,
    /*
     * 缺省 **false**（从严）：见 `LlmSettings.supportsVision` 的注释——
     * 猜"支持"而实际不支持的代价是上游 400、整轮失败，方向不对称。
     */
    supportsVision: config.supportsVision === true,
  }
}

/**
 * 密钥解析器：**界面填写的密钥优先**，其次是 `apiKeyEnv` 指向的环境变量。
 *
 * 为什么保留环境变量这条兜底：容器/编排部署下密钥常由 secret 注入，那是比
 * "把密钥写进挂载卷里的文件"更强的运维姿态；但它不再是**唯一**的方式
 * （此前"必须先 export 再重启"正是本次要消掉的复杂度）。
 */
export function createApiKeyResolver(config: LlmConfig): {
  resolve: () => CredentialResult
  source: () => LlmCredentialSource
} {
  const inline = (config.apiKey ?? '').trim()
  const envName = (config.apiKeyEnv ?? '').trim()
  return {
    resolve: () => (inline !== '' ? { ok: true, value: inline } : resolveCredential(envName)),
    source: () => {
      if (inline !== '') return 'inline'
      return resolveCredential(envName).ok ? 'env' : 'none'
    },
  }
}
