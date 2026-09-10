/**
 * 把标题写进 `document.title` 的唯一副作用点。
 *
 * 与 `pageMeta.ts`（纯函数）分开，是为了让标题映射逻辑能在 node 里单测、不必引入 DOM。
 *
 * 多个组件同时使用本 hook 是**有意设计**：`App` 按路由设一个基线标题，详情页在
 * 页面数据取回后再覆盖成真实标题（异步，因此必然晚于 App 的基线设置）。
 * 卸载时**不**恢复：路由变化会由 App 的 effect 立刻写入新标题，无需额外状态。
 */
import { useEffect } from 'react'

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title
  }, [title])
}
