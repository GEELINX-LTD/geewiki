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
import { ENV_VAR_NAME_FIELD_RE, isEnvVarName } from './credentials.js'
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
export {
  ENV_VAR_NAME_CONVENTION_RE,
  ENV_VAR_NAME_FIELD_RE,
  ENV_VAR_NAME_RE,
  isEnvVarName,
  resolveCredential,
  type CredentialResult,
} from './credentials.js'
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
   * 本字段由内置兜底路由与后续 adapter 共享。**只接受惯例形态的环境变量名**
   * （全大写 + 至少一个下划线，如 `DEEPSEEK_API_KEY`；空串 = 未配置），
   * 因为配置会落盘进入库的 `config/plugins.base.json`——填密钥值等于把密钥提交进 git。
   * 校验同时挂在 `LlmConfigSchema`（schema 层，覆盖激活与热更新两条路径）与 `apply` 上。
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
  /**
   * **白名单**：只接受惯例形态的环境变量名（全大写 + 至少一个下划线）。
   *
   * 这条 pattern 是阻止密钥落盘的**主闸门**：`Manager.updateConfig` 与激活前校验都走
   * `validateConfig(schema, …)`，因此**启动与热更新两条路径**都在 schema 层被拦下，
   * 不会走到 `persistConfig` 写进入库的 `config/plugins.base.json`。
   *
   * 为什么是白名单而非"像不像密钥"的黑名单：`a1b2c3…`（32 位 hex）、
   * `ABCDEF1234…`（全大写 32 位）、`Xk9mQ2pL7vR4tN8w`（16 字符混合）在语法上都是
   * 合法标识符，黑名单拦不住，而它们恰是随机密钥最常见的形态。
   *
   * 注意 pattern 必须**显式允许空串**（`^$|…`）：schemastery 会对 `default('')` 一并校验，
   * 写成"不接受空串"会让默认配置直接抛错、插件无法激活。
   */
  apiKeyEnv: Schema.string()
    .default('')
    .pattern(ENV_VAR_NAME_FIELD_RE)
    .description('凭据的**环境变量名**（全大写 + 下划线，如 DEEPSEEK_API_KEY；此处不要填密钥本身）'),
})

/** GeeWiki Manifest：提供 llm-service；无冲突组（多 provider 共存）；可热插拔 */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/llm',
  version: '0.1.0',
  geewiki: {
    displayName: '模型接入',
    description: '为大模型服务商提供统一的接入契约；本身不含任何模型实现',
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
    // ① 配置里填的不是环境变量名 → 激活失败。这是**配置错误**，不是运行期故障：
    //    这里 throw（让本插件激活失败并显式报错），而**不是** process.exit(1)——
    //    后者会把一个可恢复的配置问题升级成整站不可用，且其它插件本可照常装载。
    //    这条是 schema pattern 之外的**第二道闸门**：schema 覆盖配置读写路径，这里覆盖
    //    "直接以代码构造 config 调 ctx.plugin()"（测试、程序化装配）的路径。
    //    报错信息**不回显**该值——它可能就是密钥本身。
    const rawApiKeyEnv = (config.apiKeyEnv ?? '').trim()
    if (!isEnvVarName(rawApiKeyEnv)) {
      throw new Error(
        '@geewiki/llm: 配置项 apiKeyEnv 必须是**环境变量名**（全大写 + 下划线，如 DEEPSEEK_API_KEY），' +
          '当前值不是该形态。插件配置会落盘进入库文件，不得存放密钥；' +
          '密钥请放在该环境变量里，配置里只写变量名。',
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
