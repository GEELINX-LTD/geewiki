/**
 * 订阅当前 URL 里的**页内锚点**（`#/wiki/foo?a=usage` 的 `usage`）。
 *
 * 与 `App.tsx` 的 `useRoute()` 是两条独立的订阅，这是刻意的：
 * - `useRoute` 只关心 `?` **之前**的路由，锚点变化时它算出的路由**不变**，
 *   React 因此不会重渲染页面（大文档下这是明显的好处）；
 * - 锚点需要单独驱动"滚动到位置"这个副作用，故自己订阅 `hashchange`。
 *
 * 另外在组件挂载时读一次：从别处（消息、笔记）点开一个带 `?a=` 的链接进来时，
 * 首次渲染就要滚到对应小节（此时内容刚渲染完，`useEffect` 能拿到元素）。
 */
import { useEffect, useState } from 'react'
import { readHashAnchor } from './hashAnchor'

export function useHashAnchor(): string | null {
  const [anchor, setAnchor] = useState<string | null>(() => readHashAnchor(window.location.hash))

  useEffect(() => {
    const onChange = (): void => setAnchor(readHashAnchor(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return anchor
}
