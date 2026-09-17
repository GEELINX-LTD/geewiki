/**
 * @geewiki/ops —— 「审计与运维」台面
 * ============================================================================
 *
 * ## 为什么它现在是**插件**（2026-09-17 改造）
 *
 * 这个页面前身是宿主页面 `packages/web/src/pages/OpsPage.tsx`（536 行），路由 id `audit`
 * 写死在 `App.tsx` 的 `ADMIN_NAV` 与 `RESERVED_ROUTE_IDS` 里。用户的原话是
 * 「当前的审计与运维功能性和表现形式上都很差」。
 *
 * 查下来根因是**分层错位**，而不是"功能没写"：
 *   · **功能**（数据与动作）**全部来自插件** —— 页面调的 8 个端点分属
 *     `@geewiki/auth`（会话列表/吊销）、`@geewiki/authz`（审计查询/授权回收/反向展开/
 *     sitemap 核对/清缓存指引）、`@geewiki/org`（邀请回收）；
 *   · **表现形式**却锁死在宿主里，于是插件已经实现好的能力（搜索索引核对、块级授权
 *     核对与重同步、按用户批量吊销会话）**在界面上一个入口都没有** ——
 *     端点能用、界面进不去，等价于这些能力对运维不存在。
 *
 * 搬成插件后这两层重新对齐：能力属于谁、界面就跟着谁走。
 *
 * ## 它**不提供**任何服务，也不注册任何服务端路由
 *
 * 数据全部经**其它插件**已有的 HTTP 端点取得（上面那三个）。本插件的服务端部分因此
 * 与 `@geewiki/editor-plain` 同形：一个空的 `apply`，语义是"卸载时无需回收任何东西"
 * （这正是 `supportsHotReload: true` 的依据）。
 *
 * ⚠️ **刻意不声明 `provides`**：它没有为别的插件提供任何服务，而 manifest 的 `provides`
 * 只是依赖图 token —— 谎报 token 会让依赖方以为服务可用而 `ctx.get` 恒为 undefined
 * （`@geewiki/echo` 踩过这个坑，见 `plugin-editor-plain` 的同款说明）。
 *
 * ## 为什么 `requires` 那三个插件
 *
 * 本台面的每一块数据都来自它们，没有它们就没有可运维的东西；`requires` 给出确定的激活
 * 拓扑（auth/authz/org 先就绪）。注意这是**插件名**而非服务 token —— 本插件不消费它们的
 * 任何 cordis 服务，只调它们的 HTTP 端点（`ctx.get('http')` 都不需要，路由由宿主挂）。
 */
import type { Context } from 'cordis'
import { type GeeWikiManifest } from '@geewiki/core'

/** GeeWiki Manifest */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/ops',
  version: '0.1.0',
  geewiki: {
    displayName: '审计与运维',
    description: '越权告警、权限变更、会话管理、权限反向展开与运维动作（sitemap 核对、清缓存指引、索引核对）',
    /*
     * `routes` 是**声明式**的页面贡献（F2）：管理器在插件激活后解析它，入口表据此
     * ① 把该插件的产物标为**不可推迟**（否则"只贡献一个页面"的插件会被整个推迟，
     * 用户点导航项会看到空白页且 console 里连一条错误都没有）；
     * ② 让宿主渲染出导航项。
     *
     * `id: 'audit'` 此前是宿主的**保留 id**（`RESERVED_ROUTE_IDS`）—— 本轮把它从保留清单里
     * 移出，因为这一页的所有权本来就该在这里。移出的同时宿主侧的 `ADMIN_NAV` 条目与
     * 页面分派分支也一并删除，否则会出现"两个东西都声称拥有 `audit`"。
     *
     * `requires: 'administer'` 与其余运维入口**同一判据**（`AuthCapabilities` 只有
     * editContent / administer / manageVisibility 三个键，不新开字段）；它对应的后端端点
     * 全部标了 `access: 'admin'`。宿主按它过滤导航项与路由，失败关闭（能力未知即不显示）。
     */
    routes: [
      {
        id: 'audit',
        label: '审计与运维',
        requires: 'administer',
        group: 'admin',
      },
    ],
    requires: ['@geewiki/auth', '@geewiki/authz', '@geewiki/org'],
    runtime: {
      /*
       * 纯前端 + 无状态：启用/停用只影响前端产物，服务端没有任何可回收资源
       * （没有路由、没有连接、没有定时器），故可热插拔。
       */
      supportsHotReload: true,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    /*
     * 前端产物由 `@geewiki/web` 的 `build:plugin-ui` 构建到
     * `packages/web/public/plugins-ui/@geewiki/ops/`（内置插件没有自带产物根，
     * 见 `packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiRoots`：
     * 内置条目的第二候选根即 `<webDist>/plugins-ui/<名>`）。
     */
    client: {
      entry: 'client.js',
      css: 'client.css',
    },
  },
}

/**
 * 服务端侧：**无路由、无状态**。
 *
 * 全部行为都在前端 bundle 里（`ui/index.tsx`）。这份 `apply` 只需存在 ——
 * 插件平台按"有没有模块"来激活，没有服务端代码的插件无法进入注册表。
 */
export const OpsPlugin = {
  name: '@geewiki/ops',
  apply(_ctx: Context) {
    console.log('[@geewiki/ops] 已激活：审计与运维台面（前端产物，经页面路由 audit 接入）')
    return () => {
      console.log('[@geewiki/ops] 已卸载')
    }
  },
}

export default OpsPlugin