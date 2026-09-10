/**
 * @geewiki/echo —— GeeWiki 示例插件
 *
 * 无状态、显式声明 supportsHotReload: true 的热插拔插件，用于演示
 * 会话层（Session Layer）热操作：enable 后挂载 GET /api/echo，
 * disable 后路由自动摘除，全程无需重启进程。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { type GeeWikiManifest, type HttpRouterService, type RouteHandlerContext } from '@geewiki/core'

export interface EchoConfig {
  /** 返回的消息内容（可经 configSchema 配置，缺省 "hello from @geewiki/echo"） */
  message?: string
}

/**
 * 配置 Schema（schemastery）：驱动管理台自动生成表单，并在配置热更新前做校验。
 * 同一实例同时用于 manifest.geewiki.configSchema 与插件模块的 Config
 * （后者让 cordis 在 ctx.plugin(plugin, raw) 时自动校验并填默认值）。
 */
export const EchoConfigSchema = Schema.object({
  message: Schema.string()
    .default('hello from @geewiki/echo')
    .description('GET /api/echo 返回的消息内容'),
})

/** GeeWiki Manifest：声明服务标识与热加载授权（示例插件无状态、可热插拔） */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/echo',
  version: '0.1.0',
  geewiki: {
    provides: 'echo-service',
    requires: ['@geewiki/http'], // 依赖 http 路由服务（激活拓扑：http 先于 echo）
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无状态示例插件：显式授权热插拔
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: EchoConfigSchema,
  },
}

/** cordis 插件本体 */
export const EchoPlugin = {
  name: '@geewiki/echo',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: EchoConfigSchema,

  apply(ctx: Context, config: EchoConfig = {}) {
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/echo: http 路由服务不可用（@geewiki/http 未激活）')

    const handle = (h: RouteHandlerContext): void => {
      h.json(200, {
        service: '@geewiki/echo',
        message: config.message ?? 'hello from @geewiki/echo',
        timestamp: new Date().toISOString(),
      })
    }

    const unregister = router.register('GET', '/api/echo', handle)
    console.log('[@geewiki/echo] 已激活: GET /api/echo')
    return () => {
      unregister()
      console.log('[@geewiki/echo] 已卸载: GET /api/echo')
    }
  },
}
