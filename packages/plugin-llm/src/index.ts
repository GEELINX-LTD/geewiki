/**
 * @geewiki/llm —— GeeWiki LLM 契约插件。
 *
 * 本批交付的是**第一层：契约 + 降级 + 密钥安全**，有意**不含任何厂商 adapter**：
 * - 产品价值是"没有 API key 时整条链路依然完整可用"，这条契约不需要 adapter 就能验证；
 * - 流式 SSE + 宿主排空（drain）的交互是更难的一层，混批会让两类缺陷互相掩盖。
 *
 * 它**不进任何 conflictGroup**：本插件是 route→provider 的注册表，允许多家 provider 共存；
 * 互斥应由各 adapter 自己声明（例如"同一厂商的两个兼容端点"）。
 *
 * 服务经 `ctx.provide('llm-service', …)` 暴露，卸载时注销（写法对齐 db-sqlite 的 `db` 服务）。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { type GeeWikiManifest } from '@geewiki/core'
import { detectSuspiciousCredential } from './redact.js'
import { LLM_SERVICE_KEY, NULL_PROVIDER, createLlmService } from './service.js'

export type {
  LlmChunk,
  LlmErrorCode,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmRouteDescriptor,
  LlmService,
  LlmUsage,
} from './types.js'
export { MIN_REDACT_LENGTH, SENSITIVE_HEADER_NAMES, SECRET_PATTERN_SOURCES, detectSuspiciousCredential, redact } from './redact.js'
export { resolveCredential, type CredentialResult } from './credentials.js'
export { LLM_SERVICE_KEY, NULL_PROVIDER, createLlmService, type LlmServiceOptions } from './service.js'

export interface LlmConfig {
  /** 默认路由名：请求未指定 route 时使用；空 = 自动取第一个可用路由 */
  defaultRoute?: string
  /** 默认最大生成 token 数（请求未显式给出时填充） */
  maxTokens?: number
  /** 默认采样温度（请求未显式给出时填充） */
  temperature?: number
  /**
   * 默认凭据的**环境变量名**（不是密钥值！）。
   *
   * 本字段由内置兜底路由与后续 adapter 共享；填密钥值会被 `apply` 直接拒绝——
   * 理由是配置会落盘进入库的 `config/plugins.base.json`。
   */
  apiKeyEnv?: string
}

/**
 * 配置 Schema（schemastery）：驱动管理台表单，并在激活前做校验。
 * 同一实例同时用于 `manifest.geewiki.configSchema` 与模块的 `Config`。
 */
export const LlmConfigSchema = Schema.object({
  defaultRoute: Schema.string()
    .default('')
    .description('默认路由名（留空则自动选择第一个可用路由）'),
  maxTokens: Schema.number()
    .default(1024)
    .min(1)
    .max(200000)
    .description('默认最大生成 token 数'),
  temperature: Schema.number()
    .default(0.7)
    .min(0)
    .max(2)
    .description('默认采样温度'),
  apiKeyEnv: Schema.string()
    .default('')
    .description('凭据的**环境变量名**（如 DEEPSEEK_API_KEY；此处不要填密钥本身）'),
})

/** GeeWiki Manifest：提供 llm-service；无冲突组（多 provider 共存）；可热插拔 */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/llm',
  version: '0.1.0',
  geewiki: {
    provides: 'llm-service',
    requires: [],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 纯内存注册表：热插拔安全
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: LlmConfigSchema,
  },
}

/** cordis 插件本体 */
export const LlmPlugin = {
  name: '@geewiki/llm',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: LlmConfigSchema,

  apply(ctx: Context, config: LlmConfig = {}) {
    // ① 配置里出现"像密钥的值"→ 激活失败。这是**配置错误**，不是运行期故障：
    //    这里 throw（让本插件激活失败并显式报错），而**不是** process.exit(1)——
    //    后者会把一个可恢复的配置问题升级成整站不可用，且其它插件本可照常装载。
    const rawApiKeyEnv = (config.apiKeyEnv ?? '').trim()
    if (rawApiKeyEnv !== '' && detectSuspiciousCredential(rawApiKeyEnv)) {
      throw new Error(
        '@geewiki/llm: 配置项 apiKeyEnv 里填的看起来是**密钥值本身**而不是环境变量名。' +
          '请改为环境变量名（如 DEEPSEEK_API_KEY）——插件配置会落盘进入库文件，不得存放密钥。',
      )
    }

    const service = createLlmService({
      defaultRoute: config.defaultRoute,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    })

    // 内置兜底路由：永远不可用。让"没配任何 provider"也有稳定的降级出口与可展示的路由。
    const unregisterNull = service.register(NULL_PROVIDER)

    const unprovide = ctx.provide(LLM_SERVICE_KEY, service)
    const available = service.availableProviders()
    console.log(
      `[@geewiki/llm] 已就绪: ${LLM_SERVICE_KEY}（可用路由 ${available.length} 个` +
        `${available.length > 0 ? `: ${available.map((d) => d.route).join(', ')}` : '；当前为降级状态：未点名路由时流式返回 NO_ADAPTER，点名兜底路由 null 时返回 MISSING_CREDENTIAL'}）`,
    )

    return () => {
      unregisterNull()
      unprovide()
      console.log('[@geewiki/llm] 已卸载: llm-service 已注销')
    }
  },
}
