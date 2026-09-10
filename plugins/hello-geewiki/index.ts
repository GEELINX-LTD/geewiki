/**
 * GeeWiki 外部插件示例（<仓库根>/plugins/hello-geewiki/）。
 *
 * 演示外部插件的最小约定：
 * 1. 清单写在同目录 package.json 的顶层 `geewiki` 键（也可改用独立的 geewiki.manifest.json）；
 * 2. 入口由清单的 `geewiki.entry` 指定（缺省按 index.ts → index.js → src/index.ts 探测）；
 * 3. 模块默认导出 cordis 插件对象 `{ name, apply }`，apply 返回卸载函数；
 * 4. 零依赖：只经 ctx 使用宿主提供的服务（此处是 http 路由服务），不 import 任何包；
 * 5. `runtime.supportsHotReload: true` 声明可热插拔（会话层 enable/disable 即时生效）。
 *
 * 本文件不在任何 workspace 包内，由宿主进程的 tsx 直接执行（TypeScript 类型仅作注释）。
 */

/** 宿主注入的 HTTP 路由服务（@geewiki/http 经 ctx.provide('http', …) 提供） */
interface RouterLike {
  register(method: string, path: string, handler: (h: RouteContextLike) => void): () => void
}

interface RouteContextLike {
  json(status: number, body: unknown): void
}

interface ContextLike {
  get(name: string): unknown
}

interface HelloConfig {
  greeting?: string
  uppercase?: boolean
}

const plugin = {
  name: '@geewiki-plugin/hello',

  apply(ctx: ContextLike, config: HelloConfig = {}) {
    const router = ctx.get('http') as RouterLike | undefined
    if (!router) throw new Error('@geewiki-plugin/hello: http 路由服务不可用（@geewiki/http 未激活）')

    const unregister = router.register('GET', '/api/hello', (h) => {
      const greeting = config.greeting ?? 'hello from external plugin'
      h.json(200, {
        service: '@geewiki-plugin/hello',
        source: 'external',
        greeting: config.uppercase ? greeting.toUpperCase() : greeting,
        config,
        timestamp: new Date().toISOString(),
      })
    })

    console.log('[@geewiki-plugin/hello] 已激活: GET /api/hello')
    return () => {
      unregister()
      console.log('[@geewiki-plugin/hello] 已卸载: GET /api/hello')
    }
  },
}

export default plugin
