/**
 * 页内锚点与 hash 路由的共存方案。
 *
 * ## 问题
 * 本应用用 **hash 路由**（`#/wiki/foo`）。而"标题锚点"的常规做法是 `href="#section"`——
 * 这会把 hash 换成 `#section`，于是路由解析器读到 `section` 这个"路由"，
 * 结果是**点一下目录就跳到别的页面**（或 404）。VitePress/Docusaurus 用路径路由，
 * 天然没这个问题（`/docs/page#section`）；hash 路由必须自己解决。
 *
 * ## 方案：把锚点放进 hash 内部的查询串
 * 形如 `#/wiki/foo?a=usage`：
 * - 路由解析只取 `?` **之前**的部分（`wiki/foo`），完全不受锚点影响；
 * - 锚点仍然在 URL 里 ⇒ **可分享、可刷新、可后退**；
 * - 保持"真链接"语义：浏览器原生支持中键新开、右键复制链接，无需 `preventDefault` 假链接
 *   （这一点很重要：假链接会丢掉"复制链接地址"这类用户预期行为）。
 *
 * 为什么用 `?a=` 而不是再塞一个路径段（`#/wiki/foo/usage`）：路径段会被现有的
 * "未知深层路径 → 回列表"逻辑吃掉，且会与真正的保留段（`edit`）打架。
 *
 * ## 为什么更新锚点不触发重新渲染
 * 见 `settleHashAnchor()`：内容是"已有的"，滚动后若再让路由状态变化一次，
 * React 会重渲染整篇正文（大文档下明显卡顿），而且会把滚动位置重置。故锚点态
 * 单独用一个订阅（`useHashAnchor`），路由态只解析 `?` 之前的部分。
 */

/** hash 内承载锚点的查询参数名（`?a=<domId>`） */
export const ANCHOR_PARAM = 'a'

/** 从整串 hash 里剥掉锚点查询串，得到"纯路由"（供 `useRoute` 使用） */
export function stripHashQuery(hash: string): string {
  const withoutPrefix = hash.replace(/^#\/?/, '')
  const q = withoutPrefix.indexOf('?')
  return q === -1 ? withoutPrefix : withoutPrefix.slice(0, q)
}

/** 从整串 hash 里读出锚点 id（无则 null） */
export function readHashAnchor(hash: string): string | null {
  const q = hash.indexOf('?')
  if (q === -1) return null
  // `URLSearchParams` **已经做过一次百分号解码**，这里绝不能再 `decodeURIComponent`：
  // 二次解码会把字面量 `%41` 变成 `A`（锚点里含 `%` 时 id 就对不上了）。
  const raw = new URLSearchParams(hash.slice(q + 1)).get(ANCHOR_PARAM)
  return raw === null || raw === '' ? null : raw
}

/** 组合"路由 + 锚点"为可直接放进 `href` 的 hash 串 */
export function buildHash(route: string, anchor: string | null): string {
  // 先剥 `#` 再剥 `/`（两步独立）：`/wiki/foo`、`#/wiki/foo`、`wiki/foo` 都归一化成 `wiki/foo`，
  // 否则会出现 `#//wiki/foo` 这种畸形 URL（路由解析会把它当成空路由段）
  const clean = route.replace(/^#/, '').replace(/^\//, '')
  if (anchor === null || anchor === '') return `#/${clean}`
  return `#/${clean}?${ANCHOR_PARAM}=${encodeURIComponent(anchor)}`
}

/**
 * 把当前 URL 的锚点替换为 `id`（`replaceState`：不新增历史条目、不触发 `hashchange`）。
 *
 * `replaceState` 而非改 `location.hash`：后者会入栈，用户按"后退"要按很多次才能离开这一页。
 * 锚点属于"页面内的位置"，不该污染历史（与浏览器原生 `#fragment` 的行为差异在此，
 * 但原生行为在本应用里会导致路由误判，故取"可分享 + 不污染历史"）。
 */
export function settleHashAnchor(id: string): void {
  const { pathname, search, hash } = window.location
  window.history.replaceState(null, '', `${pathname}${search}${buildHash(stripHashQuery(hash), id)}`)
}

/**
 * 滚动到指定 id 的元素并给出可见的焦点（无障碍）。
 *
 * 为什么不用 `location.hash = id`：见文件头——会触发路由误判。
 * `scrollIntoView` 用 `block: 'start'`，配合 CSS 的 `scroll-margin-top`
 * （`.md-body :is(h1..h6)` 已设）避开 sticky 顶栏遮挡（WCAG 2.4.11）。
 */
export function scrollToAnchor(id: string): boolean {
  const el = document.getElementById(id)
  if (el === null) return false
  el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  return true
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
