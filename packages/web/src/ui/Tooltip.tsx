/**
 * Tooltip —— 基于 Radix UI 的提示气泡。
 *
 * 设计纪律（这条比组件本身更重要）：**Tooltip 不能承载唯一信息**。
 * 它只在鼠标悬停/键盘聚焦时出现，触屏设备上根本没有 hover 概念，屏幕阅读器用户
 * 也常常不播报它。因此：
 * - 它只用于**补充**已经用文字表达过的信息（例如给"无模型"标签换个更长的解释，
 *   而标签本身就说明了状态）；
 * - 当提示内容含**交互元素**或较长文本时，应改用 Dialog/Popover，而不是 Tooltip。
 *
 * 无障碍：Radix 会把 Trigger 与内容通过 `aria-describedby` 关联，
 * 并在 Escape 时关闭、移出后延迟关闭（避免鼠标路径抖动导致闪烁）。
 */
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import { cn } from './cn'

export const TooltipProvider = TooltipPrimitive.Provider
export const TooltipRoot = TooltipPrimitive.Root

export interface TooltipProps {
  /** 提示内容（纯文本/短内容） */
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function Tooltip({ content, children, side = 'bottom' }: TooltipProps): ReactNode {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-[var(--z-toast)] max-w-[min(22rem,80vw)] rounded-md border border-line',
            'bg-surface px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-lg',
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-[var(--gw-line)]" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
