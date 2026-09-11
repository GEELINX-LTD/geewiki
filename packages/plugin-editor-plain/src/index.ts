/**
 * @geewiki/editor-plain —— 「纯文本编辑器」插件
 *
 * ## 这个插件存在的意义：证明 `editor` 插槽这条扩展点**真的可用**
 * 上一批只落地了契约与后端链（`ctx.slot`、入口表 `slots` 字段、基数裁决），但前端还没有任何
 * 消费者，也就是说"插件能替换编辑器"这件事**当时并未被任何真实插件验证过**。
 * 本插件是它的第一个真实消费者：进入编辑页时，宿主渲染它贡献的 `<textarea>` 编辑器，
 * 而不是内置的 CodeMirror。
 *
 * ## 它刻意不做什么
 * - **不直接写数据库**：保存与校验全部经宿主的 `onSave`（见 core 的 `EditorSlotProps`）。
 *   插件拿到的是受控值与回调，落库路径只有宿主那一条。
 * - **不实现草稿/冲突检测/未保存拦截**：那些是**宿主职责**，且刻意留在插槽外层
 *   （`WikiPage` 的 `WikiEdit` 继续负责）——否则"换个编辑器"就会悄悄丢掉草稿保护。
 * - **不声明 `provides`**：它没有为别的插件提供任何服务（manifest 的 provides 只是依赖图 token，
 *   谎报 token 会让依赖方以为服务可用而 `ctx.get` 恒为 undefined——`@geewiki/echo` 踩过这个坑）。
 *
 * ## 为什么 `requires: ['@geewiki/wiki']`
 * 它替换的是**知识库编辑页**的编辑器，语义上依附于 wiki 插件；同时这给出确定的激活拓扑
 * （wiki 先就绪）。注意这是**插件名**而非服务 token——本插件不消费 wiki 的任何服务，
 * 只是"没有 wiki 就没有编辑页可替换"。
 */
import type { Context } from 'cordis'
import { type GeeWikiManifest } from '@geewiki/core'

/** GeeWiki Manifest */
export const manifest: GeeWikiManifest = {
  name: '@geewiki/editor-plain',
  version: '0.1.0',
  geewiki: {
    displayName: '纯文本编辑器',
    description: '用一个朴素的纯文本框替换知识库的默认编辑器，演示插件如何接管编辑区',
    /*
     * `slots: ['editor']` 是**声明式**贡献：管理器在插件激活后自动登记（不需要运行期 contribute）。
     *
     * 这条声明同时带来两件事：
     * ① 入口表会把该插件标为 `slots: ['editor']`；
     * ② 前端据此判定"它只贡献编辑区" ⇒ **它的 client.js 推迟到进入编辑页才加载**
     *    （首屏只看文档的访问完全不会请求它）。
     */
    slots: ['editor'],
    requires: ['@geewiki/wiki'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      /*
       * 编辑器插件是**纯前端 + 无状态**的：启用/停用只影响前端插槽产物，
       * 服务端没有任何可回收资源（没有路由、没有连接、没有定时器），故可热插拔。
       */
      supportsHotReload: true,
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    // 前端产物：由 `@geewiki/web` 的 `build:fixtures` 构建到
    // `packages/web/public/plugins-ui/@geewiki/editor-plain/`（内置插件无自带产物根，
    // 见 `resolvePluginUiRoots`：内置条目的第二候选根即 <webDist>/plugins-ui/<名>）。
    client: {
      entry: 'client.js',
      css: 'client.css',
    },
  },
}

/**
 * 服务端侧：**无路由、无状态**。
 *
 * 编辑器的全部行为都在前端 bundle 里（`fixtures/editor/index.tsx`）。服务端这份 `apply`
 * 只需存在——插件平台按"有没有模块"来激活，没有服务端代码的插件无法进入注册表。
 * 它返回一个空的 disposer，语义是"卸载时无需回收任何东西"（这正是 supportsHotReload 的依据）。
 */
export const EditorPlainPlugin = {
  name: '@geewiki/editor-plain',
  apply(_ctx: Context) {
    console.log('[@geewiki/editor-plain] 已激活：编辑器插槽贡献（前端产物）')
    return () => {
      console.log('[@geewiki/editor-plain] 已卸载')
    }
  },
}

export default EditorPlainPlugin
