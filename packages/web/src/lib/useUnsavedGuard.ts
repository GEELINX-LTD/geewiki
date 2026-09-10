/**
 * 未保存离开拦截。
 *
 * 覆盖四条真实路径（缺一条，用户就会丢掉工作）：
 * 1. **刷新 / 关闭标签页 / 输入新地址** ⇒ `beforeunload`（浏览器原生确认框，无法自定义文案）；
 * 2. **点击站内链接**（顶栏导航、面包屑、列表页链接）⇒ 捕获阶段拦截 `a[href^="#/"]`；
 * 3. **浏览器前进/后退、手改地址栏 hash** ⇒ `hashchange` 后确认；用户选择"留下"就把
 *    hash 改回编辑页（用 `replaceState`，避免再叠一条历史）；
 * 4. **组件内的"取消"按钮** ⇒ 由调用方调用返回的 `confirmLeave()`。
 *
 * 为什么用 `window.confirm` 而不是自绘 Dialog：本条路径可能在**任意时刻**被触发
 * （包括 `hashchange` 回调里，一个非 React 事件流），而 `window.confirm` 是阻塞式、
 * 不会与 React 的渲染时序打架；它同时是**原生可访问**的（屏幕阅读器、键盘都天然可用）。
 * 需要展示富内容（例如列出依赖方、显示冲突差异）的场景另用 `ui/Dialog`——
 * WikiEdit 里的"服务端已更新"冲突提示就是那样做的，因为那里需要呈现信息而不只是问一句。
 *
 * 已知局限（如实记录）：`beforeunload` 的文案由浏览器决定，不能定制；
 * 且若用户禁用"离开前确认"，这些拦截会全部失效——这是浏览器行为，不是本实现能绕过的。
 */
import { useEffect } from 'react'

export interface UnsavedGuardOptions {
  /** 当前是否有未保存改动 */
  dirty: boolean
  /** 确认文案（站内跳转与 hash 变化共用） */
  message: string
  /** 编辑页自身的 hash（被拒绝离开时要退回到它），形如 `#/wiki/foo/edit` */
  selfHash: string
}

export function useUnsavedGuard(opts: UnsavedGuardOptions): { confirmLeave: () => boolean } {
  const { dirty, message, selfHash } = opts

  // 1. 刷新 / 关闭
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      // 规范要求设置 returnValue 才会弹确认（现代浏览器忽略具体文案）
      e.returnValue = message
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, message])

  // 2. 站内链接点击（捕获阶段：先于 React 的 onClick 与浏览器默认跳转）
  useEffect(() => {
    if (!dirty) return
    const onClick = (e: MouseEvent): void => {
      if (e.defaultPrevented) return
      // 只拦"普通左键点击"：中键/⌘点击是"新标签打开"，不该拦
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const target = e.target
      if (!(target instanceof Element)) return
      const a = target.closest('a[href]')
      if (a === null) return
      const href = a.getAttribute('href') ?? ''
      if (!href.startsWith('#/')) return // 外部链接/锚点不拦（锚点是页内移动，不算离开）
      if (href === selfHash) return
      if (!window.confirm(message)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // 捕获阶段：必须早于 React 的冒泡阶段 onClick（否则已经导航了）
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty, message, selfHash])

  // 3. hash 变化（后退/前进、手改地址栏）
  useEffect(() => {
    if (!dirty) return
    let bypass = false
    const onHashChange = (): void => {
      if (bypass) {
        bypass = false
        return
      }
      const current = window.location.hash === '' ? '#/' : `#${window.location.hash.replace(/^#\/?/, '/')}`
      // 仍在编辑页（例如只是锚点变化）⇒ 不算离开
      if (current === selfHash || window.location.hash.startsWith(`${selfHash}?`)) return
      if (window.confirm(message)) return
      // 用户选择留下：把 hash 改回去。用 replaceState 而非赋值，避免再压一条历史
      bypass = true
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${selfHash}`)
      // replaceState 不触发 hashchange，故 bypass 会在下一次真实 hashchange 时被消费掉；
      // 若一直没来，它也不会造成问题（只是多跳过一次）
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [dirty, message, selfHash])

  return {
    confirmLeave: (): boolean => !dirty || window.confirm(message),
  }
}
