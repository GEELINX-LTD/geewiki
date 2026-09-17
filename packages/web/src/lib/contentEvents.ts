/**
 * **内容变更**的跨插件广播：让"别人改了正文"这件事能被当前打开的页面知道。
 *
 * ## 为什么需要它（用户报的真实缺陷）
 * 用户让 AI 助手改当前这篇文章，AI 的 `page.update` 在**服务端**跑完、库里已经变了，
 * 但浏览器里那一页是 `WikiDetail` 自己 `api.page(slug)` 取来放在组件 state 里的
 * ——没有任何人告诉它"你手上这份过期了"，于是用户看到的是旧正文，得手动刷新。
 *
 * ## 为什么是 window 上的 DOM 事件（而不是共享 store / 回调注册表）
 * 插件 UI 是**独立构建**的产物（`packages/web/public/plugins-ui/<插件>/client.js`，
 * 外部化只有 react 系）：它 import 不到宿主模块，宿主也不该认识具体插件。
 * 事件名 + `detail` 形状就是这**唯一**的契约，两侧各写一份字面量，
 * 由守卫逐字比对（`packages/plugin-ai-assistant/test/uiDockContent.test.ts` ↔ 本文件）。
 * 这也让任何**将来的**写工具（不只 AI 助手）都能用同一条缝隙。
 *
 * ## 语义
 * - `slugs`：这次改动影响的页面。**空数组表示"改了东西但不知道是哪一页"**
 *   （调用方解析不出 slug 时的保守形态）——宿主对它的处理与"包含当前页"相同：
 *   重取正文。宁可多刷一次，也不要让用户盯着过期正文。
 * - `source`：谁改的，**只用于诊断**（进 `console.debug`），不参与判定、不进用户文案
 *   —— 宿主不认识任何具体插件，不该把包名印到界面上。
 */
export const CONTENT_CHANGED_EVENT = 'geewiki:content-changed'

export interface ContentChangedDetail {
  slugs: readonly string[]
  source: string
}

/**
 * 广播一次内容变更（宿主内部写路径、以及任何受信脚本都可以调）。
 *
 * 事件**不冒泡**（`bubbles: false`）：它挂在 `window` 上，冒泡没有意义，
 * 还能少一次无谓的传播。
 */
export function notifyContentChanged(detail: ContentChangedDetail): void {
  window.dispatchEvent(new CustomEvent<ContentChangedDetail>(CONTENT_CHANGED_EVENT, { detail }))
}

/**
 * 解析事件（**防御式**，形状不对返回 `null` 而不是抛）。
 *
 * 为什么这么谨慎：这个事件来自**别人**（插件、扩展、任何脚本），
 * 一个畸形 detail 不应该把详情页打崩——`null` 让调用方直接忽略它。
 * `slugs` 里的非字符串项会被丢掉（而不是整条作废）：能用的信息就留着。
 */
export function parseContentChanged(event: Event): ContentChangedDetail | null {
  const detail = (event as CustomEvent<unknown>).detail
  if (typeof detail !== 'object' || detail === null) return null
  const raw = detail as { slugs?: unknown; source?: unknown }
  if (!Array.isArray(raw.slugs)) return null
  const slugs = raw.slugs.filter((s): s is string => typeof s === 'string' && s !== '')
  const source = typeof raw.source === 'string' ? raw.source : 'unknown'
  return { slugs, source }
}

/**
 * 订阅内容变更，返回退订函数。
 *
 * 监听器包了一层 `parseContentChanged`：**畸形事件在门口就被丢掉**，
 * 业务代码只会收到形状正确的 `ContentChangedDetail`（不必每处都判一遍）。
 */
export function onContentChanged(handler: (detail: ContentChangedDetail) => void): () => void {
  const listener = (event: Event): void => {
    const detail = parseContentChanged(event)
    if (detail === null) {
      // 静默忽略：这不是错误路径，只是别人发了个我们不认得的形状
      console.debug('[geewiki] 忽略了形状不正确的内容变更事件：', event)
      return
    }
    handler(detail)
  }
  window.addEventListener(CONTENT_CHANGED_EVENT, listener)
  return () => window.removeEventListener(CONTENT_CHANGED_EVENT, listener)
}
