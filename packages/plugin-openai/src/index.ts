/**
 * @geewiki/openai —— OpenAI 兼容 LLM adapter（"模型支持"，**无自己的配置**）。
 *
 * 它是**叶子插件**：只往 `llm-service` 注册一条路由，不对外提供新服务（故无 `provides`）。
 *
 * **本批的形态变化（产品裁决）**：适配器不再声明 `configSchema`，也不再读任何自己的配置
 * ——端点、密钥、模型名、超时、思考强度全部来自 `@geewiki/llm` 的统一配置，适配器在每次
 * 请求时**现读**（`llm.settings()` / `llm.resolveApiKey()`）。理由：
 * "接上一个模型"是一个功能，不是三张表单；同一个模型名写在两处必然会出现
 * "改了 A 处、B 处还是旧值"的分裂。适配器的职责收敛为**协议支持**：
 * 把统一的设置翻译成 `/chat/completions` 请求（含 `reasoning_effort` 与额外请求体透传）。
 *
 * 同时**撤掉了 `conflictGroup: 'llm-provider'`**：互斥的前提是"两家适配器抢同一个注册表键"，
 * 而现在适配器只是并列的**可选服务商**（由 `provider` 字段单选），
 * 启用多个适配器是完全正常的（用户想在 OpenAI 与自建网关之间切换）。
 *
 * 三条边界（与 `@geewiki/llm` 的既有裁决一致）：
 * 1. **缺 key 不算激活失败**：`available()` 返回 false，服务会跳过该路由，上层据此降级；
 *    密钥的形态校验（"别把密钥值填进环境变量名字段"）留在统一配置所在的 `@geewiki/llm`。
 * 2. **不做重试**（契约规定服务层不重试）。
 * 3. **不缓存凭据与设置**：`available()`/`stream()` 每次现算，使"启动后才配好密钥"
 *    与"改完配置立即生效"都无需重启。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { type GeeWikiManifest } from '@geewiki/core'
import { type LlmService } from '@geewiki/llm'
import { createOpenAiProvider } from './provider.js'

export type { OpenAiProviderOptions } from './provider.js'
export { createOpenAiProvider } from './provider.js'
export { joinUrl } from './url.js'
export { createOpenAiCompatProbe, extractModelIds, openAiCompatProbe } from './probe.js'
export { codeFromFetchError, codeFromHttpError, extractErrorSignals } from './errors.js'
export { isDoneSentinel, parseSseData } from './sse.js'

/** 本适配器注册的路由名（= 统一配置里 `provider` 字段的可选值之一） */
export const OPENAI_ROUTE = 'openai'

/**
 * 空的配置 Schema。
 *
 * **刻意声明一个"零字段"的 schema，而不是 `undefined`**：`undefined` 会让管理台退回
 * "JSON 原文编辑框"（那条通道是给未声明 schema 的插件准备的），用户会看到一个可以随便写
 * 却什么也不生效的文本框。零字段 schema 表达的是"本插件确实没有可配置项"。
 */
export const OpenAiConfigSchema = Schema.object({})

/** GeeWiki Manifest：叶子路由插件，可热插拔，无配置 */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/openai',
  version: '0.1.0',
  geewiki: {
    // ★ F10：跨界能力声明（宿主不强制，用于评审与可观测）
    permissions: ['env', 'net'],
    displayName: 'OpenAI 兼容模型',
    description: '为「模型接入」提供 OpenAI 兼容协议支持（如 DeepSeek、通义、自建网关）；本插件无需配置',
    // 无 provides：它只往 llm-service 注册路由，不对外提供新服务
    provides: undefined,
    // 按**服务 token**依赖（不是插件名）：换成别的注册表实现也无需改这里
    requires: ['llm-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 纯内存注册表 + 无状态请求：热插拔安全
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: OpenAiConfigSchema,
  },
}

/** cordis 插件本体 */
export const OpenAiPlugin = {
  name: '@geewiki/openai',
  Config: OpenAiConfigSchema,

  apply(ctx: Context) {
    // ① llm-service 不在就显式报错：静默 no-op 会让"插件显示已激活但问答永远降级"
    //    成为需要读源码才能定位的问题。
    const llm = ctx.get('llm-service') as LlmService | undefined
    if (!llm || typeof llm.register !== 'function') {
      throw new Error(
        '@geewiki/openai: llm-service 不可用（@geewiki/llm 未激活）。本插件依赖它的注册表、统一配置与终止保证。',
      )
    }

    const provider = createOpenAiProvider({
      route: OPENAI_ROUTE,
      label: 'OpenAI 兼容端点',
      description: '任何 OpenAI 兼容的 /chat/completions 端点（OpenAI、DeepSeek、通义、自建网关…）',
      defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      settings: () => llm.settings(),
      resolveApiKey: () => llm.resolveApiKey(),
    })

    // register 在重复 route 时会抛错（契约要求"不得静默覆盖"）——这里不捕获，
    // 让它以激活失败的形式暴露（同名路由通常意味着同一个插件被装配了两次）。
    const unregister = llm.register(provider)
    const current = llm.settings()

    console.log(
      `[@geewiki/openai] 已注册服务商 ${provider.descriptor.route}` +
        `（模型 ${provider.descriptor.model}，端点 ${current.baseUrl || 'https://api.openai.com/v1'}，` +
        `密钥来源 ${llm.credentialSource()}，当前${provider.descriptor.available() ? '可用' : '不可用：未配置密钥或模型'}）`,
    )

    // cordis 约定：apply 返回清理函数。
    return () => {
      unregister()
      console.log(`[@geewiki/openai] 已卸载: 服务商 ${OPENAI_ROUTE} 已注销`)
    }
  },
}
