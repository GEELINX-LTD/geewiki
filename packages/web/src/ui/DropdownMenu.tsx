/**
 * DropdownMenu —— 基于 Radix UI 的下拉菜单（替换手写的 `components/MoreMenu.tsx`）。
 *
 * 为什么换成 Radix：手写菜单要实现的是 **APG（ARIA Authoring Practices）的 menu 组合模式**，
 * 涉及 roving tabindex、ArrowUp/Down 环绕、Home/End、typeahead（键入首字母跳转）、
 * 打开时焦点管理、Escape 归还焦点、外部点击与滚动时的关闭策略……每一处都容易漏，
 * 而漏掉的往往是**只有键盘/屏幕阅读器用户才会遇到**的问题。Radix 把这些实现过一遍
 * 并被广泛使用，因此这里只负责**外观**，行为交给它。
 *
 * 保留的既有行为（迁移前手写版就有，不能回退）：
 * - 触发按钮是原生 button，Tab 可达，Enter/Space 打开；
 * - 打开后方向键在菜单项间移动；
 * - Escape 关闭并把焦点**还给触发按钮**；
 * - 点击外部关闭；
 * - `aria-haspopup` / `aria-expanded`（由 Radix 自动加）。
 * 另外**深链能力不变**：菜单项仍通过调用方的 `onSelect` 走 hash 跳转，
 * `#/plugins`、`#/graph` 这类地址仍可直接粘贴进入。
 */
import * as Menu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { cn } from './cn'
import { focusRing, touchTarget } from './a11y'

export const DropdownMenu = Menu.Root
export const DropdownMenuTrigger = Menu.Trigger

export function DropdownMenuContent({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}): ReactNode {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={6}
        className={cn(
          // z-index 走 token（--z-dropdown），与 sticky 顶栏（--z-sticky）分层明确
          'z-[var(--z-dropdown)] min-w-[11rem] rounded-lg border border-line bg-surface p-1.5',
          'shadow-lg',
          // Radix 提供入场/退场动画的 data 属性钩子；尊重 reduce-motion
          'data-[state=open]:animate-in motion-reduce:animate-none',
          className,
        )}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  )
}

export function DropdownMenuItem({
  children,
  onSelect,
  onClick,
  active = false,
  disabled = false,
  className,
}: {
  children: ReactNode
  onSelect?: () => void
  /** 当前路由所在项：加高亮（视觉），同时用 aria-current 传达给辅助技术 */
  active?: boolean
  /**
   * 禁用该项（不派发 `onSelect`、不可键盘提交）。
   *
   * 用途是**就地加载**这类"占位项"（例如版本列表底部的「加载更早的版本…」正在请求时）：
   * 它需要在菜单**保持打开**的同时不可再次触发。
   */
  disabled?: boolean
  /**
   * 点击时触发（**不改菜单开合**）。用于"就地加载下一页"这类不需要关闭菜单的动作 ——
   * Radix 的 `Item` 在指针按下时就会关菜单，若走 `onSelect` 就来不及看到加载结果。
   * 需要"选中即关"的普通项仍用 `onSelect`。
   */
  onClick?: () => void
  className?: string
}): ReactNode {
  return (
    <Menu.Item
      disabled={disabled}
      onClick={onClick}
      onSelect={onSelect === undefined ? undefined : () => onSelect()}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm',
        'text-ink select-none',
        'data-[highlighted]:bg-hover',
        // 禁用项不该有 pointer 光标：否则读起来像"能点，只是点不动"
        disabled && 'cursor-default text-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-60',
        active && 'bg-accent-soft font-semibold text-accent-soft-ink data-[highlighted]:bg-accent-soft',
        focusRing,
        touchTarget,
        className,
      )}
    >
      {children}
    </Menu.Item>
  )
}

export function DropdownMenuSeparator({ className }: { className?: string }): ReactNode {
  return <Menu.Separator className={cn('my-1 h-px bg-line', className)} />
}

export function DropdownMenuLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <Menu.Label className="px-2.5 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-muted uppercase">
      {children}
    </Menu.Label>
  )
}
