/**
 * 次级菜单：把"运维/开发向"的入口（插件管理、依赖图）收进一个下拉，
 * 让「知识库」保持为产品主入口（此前三者是平级 tab，产品与运维台混在一起）。
 *
 * 无障碍与交互（本批的硬要求）：
 * - 触发按钮是原生 `<button>`：Tab 可达，Enter / Space 打开；
 * - 打开后 `ArrowDown` 把焦点移入首个菜单项，菜单项也是原生 button，Tab/Enter 可用；
 * - `Escape` 关闭并把焦点**还给触发按钮**；
 * - 点击菜单外部关闭；
 * - `aria-haspopup` / `aria-expanded` / `role="menu"` + `role="menuitem"` 标注语义。
 *
 * 不引入路由库：菜单项仍通过 `onNavigate(id)` 走宿主的 hash 跳转，
 * 因此 `#/plugins`、`#/graph` 这些深链**照旧可直接粘贴 URL 进入**。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  id: string
  label: string
  icon: string
}

export function MoreMenu(props: {
  items: readonly MenuItem[]
  active: string
  onNavigate: (id: string) => void
  label: string
  icon: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const isActive = props.items.some((item) => item.id === props.active)

  // 打开期间才挂全局监听：点击外部 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const focusFirstItem = (): void => {
    // 等 React 提交后再找节点，避免在面板尚未挂载时查询
    requestAnimationFrame(() => {
      panelRef.current?.querySelector('button')?.focus()
    })
  }

  return (
    <div className="more-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`tab${isActive ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            focusFirstItem()
          }
        }}
      >
        <span className="tab-icon" aria-hidden="true">{props.icon}</span>
        {props.label}
        <span className="more-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="more-panel" role="menu" ref={panelRef}>
          {props.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`more-item${props.active === item.id ? ' active' : ''}`}
              onClick={() => {
                setOpen(false)
                props.onNavigate(item.id)
              }}
            >
              <span className="tab-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
