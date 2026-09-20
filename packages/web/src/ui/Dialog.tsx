/**
 * Dialog —— 基于 Radix UI 的模态对话框。
 *
 * 为什么用 Radix 而不是自己写 `<div class="modal">`：
 * 模态对话框的无障碍要求是"**焦点陷阱 + 惰性化其余内容 + Escape 关闭 + 归还焦点**"，
 * 而且必须同时处理 `aria-modal`、背景 `inert`、滚动锁定、嵌套对话框的栈。
 * 手写几乎必然漏掉 `inert`（结果：Tab 能跑到后面的页面上，屏幕阅读器也能读到），
 * 这正是"看起来能用、但对辅助技术用户是坏的"的典型。
 *
 * 本仓库的既有确认框用 `window.confirm`（阻塞式原生弹窗）——它无障碍上是合格的
 * （浏览器实现），但**无法呈现富内容**（例如列出依赖方名单）。因此新增本组件供后续
 * 批次替换那些需要展示信息的确认场景；原生 `confirm` 仍可用于一句话确认。
 * 富内容确认现已统一由 `ui/ConfirmDialog.tsx` 承担（`useConfirm` + 本组件）。
 */
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from './cn'
import { Button } from './Button'
import { focusRing } from './a11y'
import { withExt } from '../lib/slots'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

function DialogContentBase({
  title,
  description,
  children,
  footer,
  className,
  onOpenAutoFocus,
  closeDisabled = false,
}: {
  /** 必填：Radix 要求对话框有可访问名称，缺失会在控制台告警且屏幕阅读器读不出 */
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** 底部操作区（通常放取消/确认按钮） */
  footer?: ReactNode
  className?: string
  /**
   * 打开时的焦点落点。
   *
   * 默认行为（Radix）：焦点给容器内**第一个**可 Tab 元素 —— 在本组件里那恰好是右上角的
   * 关闭按钮。这对"读一读再决定"的对话框没问题，但对**危险操作确认**是错的：
   * 键盘用户需要"一次 Enter 即生效、Esc 取消"，故调用方（见 `ConfirmDialog`）用
   * `event.preventDefault()` 接管，把焦点放到确认按钮上。
   */
  onOpenAutoFocus?: (event: Event) => void
  /**
   * 禁用右上角关闭按钮（配合 `onOpenChange` 里的拦截使用）。
   *
   * 为什么需要：请求已经发出、结果还没回来时若允许关闭，用户会得到"对话框没了，
   * 但操作可能已经生效"的不确定状态。此时关闭入口必须全部失效。
   */
  closeDisabled?: boolean
}): ReactNode {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className="fixed inset-0 z-[var(--z-overlay)] bg-overlay data-[state=open]:animate-in motion-reduce:animate-none"
      />
      <DialogPrimitive.Content
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          'fixed top-1/2 left-1/2 z-[var(--z-modal)] w-[min(32rem,calc(100vw-2rem))]',
          '-translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(100vh-4rem)] overflow-y-auto',
          'rounded-xl border border-line bg-surface p-5 shadow-xl',
          'data-[state=open]:animate-in motion-reduce:animate-none',
          className,
        )}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="m-0 text-base font-semibold text-ink">
              {title}
            </DialogPrimitive.Title>
            {description !== undefined && (
              <DialogPrimitive.Description className="m-0 mt-1 text-xs text-muted">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          {/* 关闭按钮：iconOnly 必须给 aria-label（见 Button 的约定） */}
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<X className="size-4" />}
              aria-label="关闭"
              disabled={closeDisabled}
            />
          </DialogPrimitive.Close>
        </div>

        {children !== undefined && <div className="mt-3 text-sm text-ink-soft">{children}</div>}

        {footer !== undefined && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** 供需要自定义关闭按钮的场景复用（保持与 DialogContent 一致的样式） */
export const dialogCloseClass = cn(
  'inline-flex h-8 items-center rounded-md border border-line px-3.5 text-note',
  'text-ink hover:bg-hover',
  focusRing,
)

/* ★ P13：宿主节点接线（portal 类**只开放 `replace`**，见 docs/design/ui-extension-platform.md） */
export const DialogContent = withExt('ui-dialog-content', DialogContentBase)
