/**
 * @geewiki/openai —— OpenAI 兼容 LLM adapter。
 *
 * 它是**叶子插件**：只往 `llm-service` 注册一条路由，不对外提供新服务（故无 `provides`）。
 * 声明 `conflictGroup: 'llm-provider'`：同组互斥，使"OpenAI 与将来的 Anthropic adapter
 * 不能同时启用"这件事由既有的冲突组机制保证，而不是靠约定。
 *
 * 三条边界（与 `@geewiki/llm` 的既有裁决一致）：
 * 1. **缺 key 不算激活失败**：`available()` 返回 false，服务会跳过该路由，上层据此降级；
 *    只有"配置本身写错"（把密钥值填进 `apiKeyEnv`）才让激活失败并显式报错。
 * 2. **不做重试**（契约规定服务层不重试）。
 * 3. **不缓存凭据**：`available()` 每次现算，使"启动后才设好环境变量"无需重启即可生效。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { type GeeWikiManifest } from '@geewiki/core'
import { type LlmProvider, type LlmService, detectSuspiciousCredential } from '@geewiki/llm'
import { createOpenAiProvider } from './provider.js'

export type { OpenAiProviderOptions } from './provider.js'
export { createOpenAiProvider, joinUrl } from './provider.js'
export { codeFromFetchError, codeFromHttpError, extractErrorSignals } from './errors.js'
export { isDoneSentinel, parseSseData } from './sse.js'

export interface OpenAiConfig {
  /** 路由名（llm-service 注册表键） */
  route?: string
  /** 中文可读名（管理台展示） */
  label?: string
  /** 端点根地址（OpenAI 兼容；可指向自建网关或本地 mock） */
  baseUrl?: string
  /** 默认模型名（请求未显式给出时使用） */
  model?: string
  /** 凭据的**环境变量名**（不是密钥值） */
  apiKeyEnv?: string
  /** 单次请求总超时（毫秒） */
  timeoutMs?: number
  /** 是否请求上游附带 token 用量（个别兼容端点不支持此字段时可关） */
  includeUsage?: boolean
}

/** 配置 Schema：驱动管理台表单，并在激活前校验 */
export const OpenAiConfigSchema = Schema.object({
  route: Schema.string().default('openai').description('路由名（同组内唯一；llm-service 注册表键）'),
  label: Schema.string().default('OpenAI 兼容端点').description('管理台展示用的中文名'),
  baseUrl: Schema.string()
    .default('https://api.openai.com/v1')
    .description('端点根地址（OpenAI 兼容；自建网关或本地 mock 也可）'),
  model: Schema.string().default('gpt-4o-mini').description('默认模型名'),
  apiKeyEnv: Schema.string()
    .default('OPENAI_API_KEY')
    .description('凭据的**环境变量名**（如 OPENAI_API_KEY；此处不要填密钥本身）'),
  timeoutMs: Schema.number().default(60000).min(1000).max(600000).description('单次请求总超时（毫秒）'),
  includeUsage: Schema.boolean()
    .default(true)
    .description('请求上游在流末尾附带 token 用量（个别兼容端点不认此字段时请关闭）'),
})

/** GeeWiki Manifest：叶子路由插件，与其它 llm-provider 互斥，可热插拔 */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/openai',
  version: '0.1.0',
  geewiki: {
    // 无 provides：它只往 llm-service 注册路由，不对外提供新服务
    provides: undefined,
    // 按**服务 token**依赖（不是插件名）：换成别的注册表实现也无需改这里
    requires: ['llm-service'],
    conflictGroup: 'llm-provider',
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

  apply(ctx: Context, config: OpenAiConfig = {}) {
    // ① 配置里出现"像密钥的值"→ 激活失败。这是**配置错误**而非运行期故障：
    //    `apiKeyEnv` 会落盘进入库的 config/plugins.*.json，填密钥等于把密钥提交进 git。
    //    这里 throw 让本插件激活失败并显式报错，而**不是** process.exit——
    //    后者会把可恢复的配置问题升级成整站不可用（其它插件本可照常装载）。
    const apiKeyEnv = (config.apiKeyEnv ?? '').trim()
    if (apiKeyEnv !== '' && detectSuspiciousCredential(apiKeyEnv)) {
      throw new Error(
        '@geewiki/openai: 配置项 apiKeyEnv 里填的看起来是**密钥值本身**而不是环境变量名。' +
          '请改为环境变量名（如 OPENAI_API_KEY）——插件配置会落盘进入库文件，不得存放密钥。',
      )
    }

    // ② llm-service 不在就显式报错：静默 no-op 会让"插件显示已激活但问答永远降级"
    //    成为需要读源码才能定位的问题。
    const llm = ctx.get('llm-service') as LlmService | undefined
    if (!llm || typeof llm.register !== 'function') {
      throw new Error(
        '@geewiki/openai: llm-service 不可用（@geewiki/llm 未激活）。本插件依赖它的注册表与终止保证。',
      )
    }

    const provider: LlmProvider = createOpenAiProvider({
      route: (config.route ?? 'openai').trim() || 'openai',
      label: (config.label ?? 'OpenAI 兼容端点').trim() || 'OpenAI 兼容端点',
      baseUrl: (config.baseUrl ?? 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
      model: (config.model ?? 'gpt-4o-mini').trim() || 'gpt-4o-mini',
      apiKeyEnv,
      timeoutMs: config.timeoutMs ?? 60000,
      includeUsage: config.includeUsage ?? true,
    })

    // register 在重复 route 时会抛错（契约要求"不得静默覆盖"）——这里不捕获，
    // 让它以激活失败的形式暴露（同组两个 adapter 抢同一路由名正是需要被看见的配置冲突）。
    const unregister = llm.register(provider)

    console.log(
      `[@geewiki/openai] 已注册路由 ${provider.descriptor.route}` +
        `（模型 ${provider.descriptor.model}，端点 ${config.baseUrl ?? 'https://api.openai.com/v1'}，` +
        `凭据环境变量名 ${apiKeyEnv || '(未配置)'}，当前${provider.descriptor.available() ? '可用' : '不可用：缺少该环境变量'}）`,
    )

    // cordis 约定：apply 返回清理函数。两个 disposer 都要跑，且一个失败不能让另一个漏掉。
    return () => {
      unregister()
      console.log(`[@geewiki/openai] 已卸载: 路由 ${provider.descriptor.route} 已注销`)
    }
  },
}
