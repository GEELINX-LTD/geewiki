/**
 * GeeWiki 示例插件：`plugins/ui-demo/`（**不是**内置产品功能，默认不启用）。
 *
 * 它存在的唯一目的，是演示「插件自带前端 UI 产物」这条链路：
 * 1. 清单写在同目录 `package.json` 的顶层 `geewiki` 键；
 * 2. 后端入口由 `geewiki.entry` 指定（此处是 `src/index.ts`）；
 * 3. **前端入口**由 `geewiki.client` 指定（`client.js` + `client.css`），产物由
 *    `pnpm --filter @geewiki/web build:fixtures` 构建到本目录的 `dist/`；
 * 4. `dist/` 属于「插件自带产物根」，优先级高于宿主的 `<内置根>/plugins-ui/<插件名>/`
 *    （见 packages/manager/src/plugin-ui.ts 的双根解析），因此**装插件即生效、无需重建 web 包**。
 *
 * 之所以把它从 `packages/web/fixtures/` 里独立出来：以前夹具会被构建到
 * `plugins-ui/@geewiki/wiki/`，于是测试脚手架冒充成了 wiki 插件的界面，出现在产品页面上。
 * 现在它有自己的名字、自己的目录，**默认不启用**，需要看演示时再手动启用。
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

const plugin = {
  name: '@geewiki-plugin/ui-demo',

  apply(ctx: ContextLike) {
    const router = ctx.get('http') as RouterLike | undefined
    if (!router) throw new Error('@geewiki-plugin/ui-demo: http 路由服务不可用（@geewiki/http 未激活）')

    const unregister = router.register('GET', '/api/ui-demo', (h) => {
      h.json(200, {
        ok: true,
        service: '@geewiki-plugin/ui-demo',
        source: 'external',
        hint: '这是一个示例插件：它的界面出现在页头/页脚插槽里，用来演示插件自带 UI 产物',
        timestamp: new Date().toISOString(),
      })
    })

    console.log('[@geewiki-plugin/ui-demo] 已激活: GET /api/ui-demo')
    return () => {
      unregister()
      console.log('[@geewiki-plugin/ui-demo] 已卸载: GET /api/ui-demo')
    }
  },
}

export default plugin
