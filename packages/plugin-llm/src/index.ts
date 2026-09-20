/**
 * @geewiki/llm —— GeeWiki LLM 契约插件 + **统一模型接入配置**（"一处配置"）。
 *
 * 本插件承担两件事：
 * 1. **契约层**：route→provider 注册表、终止保证、无 key 降级、密钥脱敏；
 * 2. **配置层**：用户只在这里填一次（服务商 / 端点 / 密钥 / 模型 / 上下文长度 /
 *    最长输出 / 思考强度），适配器插件**不再持有任何自己的配置**。
 *
 * 配置项刻意保持稀少：**采样温度不在这里**。各家服务端的默认温度不同，客户端补一个
 * 默认值等于替服务端做决定；要覆盖只能在高级项的「额外请求体」里显式写。
 *
 * 为什么把配置收在这一层（本批的产品裁决）：
 * 此前"接上真实模型"要在三个插件里各填一遍（`@geewiki/llm` 的 route/maxTokens、
 * `@geewiki/openai` 的 baseUrl/model/apiKeyEnv、原 `@geewiki/ai`（现 `@geewiki/ai-qa` /
 * `@geewiki/ai-qa`）的 maxAnswerTokens/
 * temperature），同一个模型名要写两处、密钥还得先 export 再重启。配置项分散在
 * 不同插件里时，用户看到的不是一个功能，而是三个插件的表单。
 *
 * 本插件**不进任何 conflictGroup**：它是 route→provider 的注册表，允许多家 provider 共存；
 * 互斥应由各 adapter 自己声明（本批起适配器不再互斥：它们只是"可选的服务商"，
 * 由 `provider` 字段单选，而不是同时抢注册表）。
 *
 * 服务经 `ctx.provide('llm-service', …)` 暴露，卸载时注销（写法对齐 db-sqlite 的 `db` 服务）。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { type GeeWikiManifest, type HttpRouterService, type RouteHandlerContext } from '@geewiki/core'
import { ENV_VAR_NAME_FIELD_RE, isEnvVarName } from './credentials.js'
import { createApiKeyResolver, deriveSettings, parseExtraBody, REASONING_EFFORT_PRESETS, type LlmConfig } from './settings.js'
import { redact } from './redact.js'
import type { LlmProbeRequest } from './types.js'
import { LLM_SERVICE_KEY, NULL_PROVIDER } from './service.js'
import { ensureLlmState, type LlmState } from './state.js'

export type {
  LlmChunk,
  LlmConnectionTestResult,
  LlmCredentialSource,
  LlmErrorCode,
  LlmImagePart,
  LlmMessage,
  LlmModelListResult,
  LlmProbeCapability,
  LlmProbeFailure,
  LlmProbeOutcome,
  LlmProbeRequest,
  LlmProbeTarget,
  LlmProvider,
  LlmReasoningEffort,
  LlmRequest,
  LlmRouteDescriptor,
  LlmService,
  LlmSettings,
  LlmUsage,
} from './types.js'
/**
 * 工具调用（function calling）。**`assembleToolCalls` 是拼装逻辑的唯一实现**——
 * 各插件自己写一遍 `acc[index].args += …` 时，"首帧的 id/name 要不要覆盖后续帧"
 * 这类细节必然漂移，而漂移的表现是"偶尔把工具结果配错调用"：不报错，只是答案变怪。
 */
export type { LlmToolCall, LlmToolCallDelta, LlmToolChoice, LlmToolDef } from './tools.js'
export { assembleToolCalls } from './tools.js'
export { MIN_REDACT_LENGTH, SENSITIVE_HEADER_NAMES, SECRET_PATTERN_SOURCES, detectSuspiciousCredential, redact } from './redact.js'
/**
 * 降级投影：`LlmErrorCode` → 对外 `DegradedReason` + **脱敏唯一出口**。
 * 用模型的插件（`@geewiki/ai-qa` / `@geewiki/ai-assistant`）都从这里取——映射表只该有一份，
 * 而它的前提交替本包拥有 `LlmErrorCode` 与 `redact`（见 `./degrade.ts` 文件头）。
 */
export { CODE_TO_REASON, degradedFromCode, makeDegraded, type Degraded, type DegradedReason } from './degrade.js'
/**
 * 模型可用性的统一投影（`available()` 抛错不拖垮状态投影 + 生成前的必然降级判定）。
 * 各 AI 插件的 `capabilities` 端点与生成前判定都走这里，保证"有没有模型"只有一个答案。
 */
export {
  hasAvailableModel,
  listRouteInfos,
  noModelDegraded,
  safeAvailable,
  type ModelRouteInfo,
} from './availability.js'
export {
  ENV_VAR_NAME_CONVENTION_RE,
  ENV_VAR_NAME_FIELD_RE,
  ENV_VAR_NAME_RE,
  isEnvVarName,
  resolveCredential,
  type CredentialResult,
} from './credentials.js'
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_EXTRA_BODY_CHARS,
  PROBE_TIMEOUT_MS,
  REASONING_EFFORT_PRESETS,
  createApiKeyResolver,
  deriveSettings,
  normalizeReasoningEffort,
  parseExtraBody,
  type LlmConfig,
} from './settings.js'
export {
  FALLBACK_SETTINGS,
  LLM_SERVICE_KEY,
  NULL_PROVIDER,
  createLlmService,
  type LlmServiceOptions,
} from './service.js'
export { ensureLlmState, type ApiKeyResolver, type LlmState } from './state.js'

/** 服务商下拉与状态查询的端点（配置表单用它填充下拉项） */
export const LLM_PROVIDERS_PATH = '/api/llm/providers'
/**
 * 模型清单探测端点（POST）：配置表单的「获取模型」按钮打这里。
 *
 * 用 POST 而不是 GET：探测参数里含**表单草稿**（未保存的 baseUrl / apiKey），
 * 走 query 会把它写进访问日志。
 */
export const LLM_MODELS_PATH = '/api/llm/models'
/** 连接测试端点（POST）：模型清单 + 一次最小对话，报错原文（脱敏后）一并回给前端 */
export const LLM_TEST_PATH = '/api/llm/test'

/**
 * 配置 Schema（schemastery）：驱动管理台表单，并在激活前做校验。
 * 同一实例同时用于 `manifest.geewiki.configSchema` 与模块的 `Config`。
 *
 * 字段顺序 = **填写顺序**：前 7 项是"接上一个模型"的全部必要信息，
 * 其余（温度 / 超时 / 用量 / 额外请求体 / 环境变量兜底）是可选的高级项。
 */
export const LlmConfigSchema = Schema.object({
  provider: Schema.string()
    .default('')
    .role('llm-provider')
    .description('模型服务商（选项来自已启用的适配器插件；留空 = 自动使用第一个可用的）'),
  baseUrl: Schema.string()
    .default('')
    .description('端点根地址，填到版本段为止，如 https://api.deepseek.com/v1（留空 = 用服务商默认值）'),
  /**
   * **写一次、不可回读**的密钥字段（`role: 'secret'`）。
   *
   * 它是本次改动的核心：值由管理器落盘到 **gitignored** 的密钥文件
   * （`config/secrets.json`，0600），**绝不写进入库的 `config/plugins.*.json`**，
   * 且任何 HTTP 响应都不回显（`GET /config` 只把该字段回成空串 + `secrets.apiKey: true`）。
   * 留空 = 不修改；填新值 = 替换。
   */
  apiKey: Schema.string()
    .default('')
    .role('secret')
    .description('API 密钥（保存后不再回显；留空 = 不修改，填新值即替换）'),
  /**
   * 模型名。`role: 'llm-model'` 让表单把它渲染成**可下拉可手填**的组合框：
   * 下拉项来自 `POST /api/llm/models`（读端点自己的清单），清单里没有的
   * （灰度模型、私有别名）照样能手打。
   */
  model: Schema.string().default('').role('llm-model').description('模型名（可点「获取模型」从端点读取清单后选择，也可直接手填）'),
  /**
   * **当前模型是否支持图像输入**（多模态）。
   *
   * 为什么必须由人显式声明：OpenAI 兼容协议里**没有**任何字段能问出这件事
   * （`/models` 只回 id 列表），而猜错的代价不对称——猜"支持"而实际不支持是
   * 上游 400、整轮失败；猜"不支持"只是少一个能力，且这里就写着怎么打开。
   * 故缺省 `false`（从严）。
   *
   * 它一处开关、三处生效：
   * ① 输入条的图片按钮（不支持时不出现，免得用户贴了图才发现发不出去）；
   * ② `read_image` 工具（不支持时**不进模型的工具表**——"这个能力不存在"比
   *    "调了才发现做不到"诚实，本仓在 `page.update` 上已经定过这条）；
   * ③ 回合端点（客户端仍塞了图时明确 400，而不是把它转给上游换一个难懂的报错）。
   *
   * **换模型后请重新确认这一项**：它是人对模型的声明，本仓不替你重新探测。
   */
  supportsVision: Schema.boolean()
    .default(false)
    .description('当前模型支持图像输入（多模态）：决定输入条能否发图、AI 能否用 read_image 看文章里的图'),
  /**
   * 思考强度：**自由文本**（`role: 'llm-effort'` 让表单额外给出常见档位候选）。
   *
   * 为什么不收成四档枚举：各家网关的档位名不统一（`minimal` / `extra-high` / `enabled` …），
   * 收成枚举等于把"用自家网关的私有档位"变成一件要改代码的事。
   * 留空或 `off` = **不下发该参数**；其余值原样作为 `reasoning_effort` 发出。
   */
  reasoningEffort: Schema.string()
    .default('')
    .role('llm-effort')
    .description('思考强度：留空或 off = 不下发该参数；也可填服务商自己的档位（如 minimal），按 reasoning_effort 原样下发'),
  contextWindow: Schema.number()
    .default(128000)
    .min(1000)
    .max(10000000)
    .description('模型上下文窗口（token）：决定一次问答最多塞入多少检索正文'),
  maxOutputTokens: Schema.number().default(4096).min(1).max(200000).description('单次回答的最长输出（token）'),
  /**
   * 下面四项都是"默认值就对"的调优/兜底项：用 `.collapse()` 让表单把它们收进
   * 折叠的「高级选项」区，**但键仍在顶层**——嵌进嵌套对象会让 cordis 把存量配置里的
   * 同名键裁掉（分组是渲染期的事，不该改数据形状）。
   */
  timeoutMs: Schema.number()
    .default(60000)
    .min(1000)
    .max(600000)
    .collapse()
    .description('单次请求总超时（毫秒）'),
  includeUsage: Schema.boolean()
    .default(true)
    .collapse()
    .description('请求上游在流末尾附带 token 用量（个别兼容端点不认此字段时请关闭）'),
  extraBody: Schema.string()
    .default('')
    .role('textarea')
    .collapse()
    .description('额外请求体 JSON，原样透传给上游，如 {"thinking":{"type":"enabled"}}'),
  /**
   * **白名单**：只接受惯例形态的环境变量名（全大写 + 至少一个下划线）。
   *
   * 这条 pattern 是阻止密钥落盘的**主闸门**（对"走环境变量"这条路径而言）：
   * `Manager.updateConfig` 与激活前校验都走 `validateConfig(schema, …)`，因此
   * **启动与热更新两条路径**都在 schema 层被拦下，不会走到 `persistConfig`
   * 写进 `config/plugins.base.json`（本机清单，见 manager 的 `readBaseList`）。
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
    .collapse()
    .description('改用环境变量提供密钥（界面填写的密钥优先于此项）'),
})

/** GeeWiki Manifest：提供 llm-service；无冲突组（适配器是"可选服务商"而非互斥实现）；可热插拔 */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/llm',
  version: '0.1.0',
  geewiki: {
    // ★ F10：跨界能力声明（宿主不强制，用于评审与可观测）
    permissions: ['env'],
    displayName: '模型接入',
    description: '统一配置模型端点、密钥、模型名与上下文长度；适配器插件只提供各厂商协议支持',
    provides: 'llm-service',
    // http-service：仅用于 `GET /api/llm/providers`（配置表单的服务商下拉）。
    // 按**服务 token**依赖，而非插件名 —— 换成别的 HTTP 实现同样成立。
    requires: ['http-service'],
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
          '要直接填密钥请用 apiKey 字段（它由管理器单独存到 gitignored 的密钥文件、且不回显）。',
      )
    }

    // ② extraBody 必须是合法 JSON 对象：非法即拒绝激活（而不是静默忽略）——
    //    "以为私有参数生效了、其实请求里什么都没有"是最难定位的一类症状。
    const extra = parseExtraBody(config.extraBody)
    if (!extra.ok) {
      throw new Error(`@geewiki/llm: 配置项 extraBody 非法 —— ${extra.message}`)
    }

    const settings = deriveSettings(config)
    const apiKey = createApiKeyResolver(config)

    // 注册表实例**每 ctx 一个**、跨 `fork.update` 存活（否则改一次配置就把适配器路由全丢掉，
    // 见 state.ts 的文件头）。这里只就地更新"现读引用"。
    const state: LlmState = ensureLlmState(ctx)
    state.settingsRef.current = settings
    state.apiKeyRef.current = apiKey
    const service = state.service

    // 内置兜底路由：永远不可用。让"没配任何 provider"也有稳定的降级出口与可展示的路由。
    // 只在缺失时注册：`fork.update` 会先 dispose 一次（那时已注销），这里再补回来；
    // 而无条件注册会撞上"重复 route 必须抛错"的契约。
    if (!state.nullRouteUnregister) {
      state.nullRouteUnregister = service.register(NULL_PROVIDER)
    }

    const unprovide = ctx.provide(LLM_SERVICE_KEY, service)

    // ③ 服务商下拉的数据源。这是**配置表单的一部分**，不是业务接口：
    //    只报"有哪些适配器、默认端点/模型是什么、当前可不可用、密钥来自哪里"，
    //    绝不回显密钥值（`credentialSource()` 只有 inline/env/none 三种取值）。
    const cleanups: (() => void)[] = []
    const router = ctx.get('http') as HttpRouterService | undefined
    if (router && typeof router.register === 'function') {
      cleanups.push(
        router.register(
          'GET',
          LLM_PROVIDERS_PATH,
          (h: RouteHandlerContext) => {
            try {
              const current = service.settings()
              h.json(200, {
                ok: true,
                providers: service
                  .listProviders()
                  // 内置兜底路由不是"可选服务商"：它永远不可用，列进下拉只会让人误选
                  .filter((d) => d.vendor !== 'none')
                  .map((d) => ({
                    id: d.route,
                    label: d.label,
                    vendor: d.vendor,
                    model: d.model,
                    description: d.description ?? '',
                    available: safeAvailable(d),
                    defaults: d.defaults ?? {},
                  })),
                selected: current.provider,
                // 思考强度的候选档位：**由服务端给**，前端不再抄一份清单（否则两处会漂移）。
                // 它只是建议值，不是白名单——字段本身接受自由文本。
                effortPresets: REASONING_EFFORT_PRESETS,
                credential: { source: service.credentialSource(), configured: service.credentialSource() !== 'none' },
                settings: current,
              })
            } catch (err) {
              h.json(500, {
                ok: false,
                error: 'internal_error',
                message: (err as Error).message,
              })
            }
          },
          { access: 'admin' },
        ),
      )
      // ④ 模型清单 / 连接测试。这两个端点也是**配置表单的一部分**：
      //    请求体带的是**表单草稿**（改一半就能测，不必先保存），密钥留空 = 用已保存的密钥。
      //    状态码语义：只有"请求体不是合法 JSON"才是 4xx；探测本身的失败一律 200 +
      //    `ok:false` —— 否则"上游 401"这种**有用的诊断**会被 HTTP 错误外壳吃掉。
      const probeEndpoint = (
        path: string,
        run: (req: LlmProbeRequest) => Promise<unknown>,
        what: string,
      ): void => {
        cleanups.push(
          router.register(
            'POST',
            path,
            async (h: RouteHandlerContext) => {
              let body: unknown
              try {
                body = await readJsonBody(h)
              } catch (err) {
                h.json(400, { ok: false, error: 'invalid_json', message: redact((err as Error).message) })
                return
              }
              try {
                h.json(200, await run(parseProbeRequest(body)))
              } catch (err) {
                // 契约上 service 的探测方法不抛；真抛了 = 编程错误，报 500 且文本脱敏
                h.json(500, {
                  ok: false,
                  error: 'internal_error',
                  message: redact(`${what}失败：${err instanceof Error ? err.message : String(err)}`),
                })
              }
            },
            { access: 'admin' },
          ),
        )
      }
      probeEndpoint(LLM_MODELS_PATH, (req) => service.listModels(req), '读取模型清单')
      probeEndpoint(LLM_TEST_PATH, (req) => service.testConnection(req), '连接测试')
    } else {
      console.warn(
        `[@geewiki/llm] http 服务不可用：${LLM_PROVIDERS_PATH} 未挂载，配置表单的服务商下拉将退化为纯文本输入`
        + `，${LLM_MODELS_PATH} / ${LLM_TEST_PATH} 也不会挂载（模型下拉与连接测试不可用）`,
      )
    }

    const available = service.availableProviders()
    console.log(
      `[@geewiki/llm] 已就绪: ${LLM_SERVICE_KEY}（服务商 ${settings.provider || '(自动)'}，` +
        `密钥来源 ${apiKey.source()}，可用路由 ${available.length} 个` +
        `${available.length > 0 ? `: ${available.map((d) => d.route).join(', ')}` : '；当前为降级状态：未点名路由时流式返回 NO_ADAPTER，点名兜底路由 null 时返回 MISSING_CREDENTIAL'}）`,
    )

    return () => {
      for (const cleanup of cleanups) cleanup()
      // 只注销"自己这次注册的"兜底路由：注册表实例是共享的，适配器的路由归各自的 disposer 管
      state.nullRouteUnregister?.()
      state.nullRouteUnregister = null
      unprovide()
      console.log('[@geewiki/llm] 已卸载: llm-service 已注销')
    }
  },
}

/** `available()` 抛错不得拖垮整个下拉（与 service 内的判定口径一致：视为不可用） */
function safeAvailable(descriptor: { available(): boolean }): boolean {
  try {
    return descriptor.available() === true
  } catch {
    return false
  }
}

/* ============================ 探测端点的请求体 ============================ */

/** 探测请求体的大小上限（表单草稿最多几 KB；给 64KB 足够宽，同时挡住灌包） */
const PROBE_BODY_LIMIT = 64 * 1024

/**
 * 读取 JSON 请求体（上限 {@link PROBE_BODY_LIMIT}）。
 *
 * 与 `@geewiki/ai-qa` / `@geewiki/wiki` 的同名实现同契约，但**更严**：这两个端点是管理台专用，
 * 正常请求体只有几 KB，超限直接拒绝即可，不必先写出 413 再关连接那么讲究。
 */
function readJsonBody(h: RouteHandlerContext, limit = PROBE_BODY_LIMIT): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let rejected = false
    const chunks: Buffer[] = []
    h.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        if (rejected) return
        rejected = true
        h.req.pause()
        rejectBody(new Error(`请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    h.req.on('end', () => {
      if (rejected) return
      try {
        resolveBody(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        rejectBody(new Error(`不是合法 JSON：${(err as Error).message}`))
      }
    })
    h.req.on('error', (err) => {
      if (!rejected) rejectBody(err)
    })
  })
}

/** 只取字符串字段（非字符串 / 空白一律忽略；未声明的键一律丢弃） */
function pickString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把请求体折算成 {@link LlmProbeRequest}。
 *
 * 白名单解析：只认 provider / baseUrl / apiKey / model 四个键。
 * 探测会**拿这些值去打外部 HTTP 请求**（带密钥），所以绝不能把任意字段透传下去。
 * 非对象/数组一律当空请求（= 全部按已保存配置探测），而不是报错——
 * 空 body 的语义是"就用现在存的这套配置测"，这是合理调用。
 */
export function parseProbeRequest(raw: unknown): LlmProbeRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const provider = pickString(source, 'provider')
  const baseUrl = pickString(source, 'baseUrl')
  const apiKey = pickString(source, 'apiKey')
  const model = pickString(source, 'model')
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(model !== undefined ? { model } : {}),
  }
}

