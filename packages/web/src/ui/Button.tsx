/**
 * Button —— 全站按钮原语（shadcn/ui 模式的源码内置版）。
 *
 * 设计要点：
 * - `variant` 表达语义（primary/secondary/ghost/danger），`size` 表达密度；
 * - `loading` 时**保持宽度不变**（spinner 绝对定位在内容之上，文字 `opacity-0`），
 *   避免"点一下按钮就变窄"造成布局跳动；
 * - `loading`/`disabled` 都走原生 `disabled` ⇒ 键盘/屏幕阅读器自动获得"不可用"语义，
 *   无需手写 `aria-disabled`（手写反而容易出现"看起来禁用但仍能被 Tab 到并触发"）；
 * - 触控目标 ≥24×24（见 a11y.ts 的 `touchTarget`），焦点环统一走 `focusRing`；
 * - 不依赖任何业务概念，图标由调用方以 children 传入（`lucide-react`）。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'
import { focusRing, touchTarget } from './a11y'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink border border-accent hover:bg-accent-hover hover:border-accent-hover',
  secondary:
    'bg-surface text-ink border border-line hover:bg-hover hover:border-line-strong',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-hover hover:text-ink',
  danger:
    'bg-surface text-danger-ink border border-danger-line hover:bg-danger-bg',
}

/**
 * 尺寸：`md` 是默认（高 32px、字号 13px），`sm` 用于表格行内等密集场景。
 * `min-h-6` = 24px 是 WCAG 2.5.8 的下限，任何尺寸都不得低于它。
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-sm',
  md: 'h-8 px-3.5 text-note gap-1.5 rounded-md',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 进行中：显示 spinner、禁用交互、宽度保持不变 */
  loading?: boolean
  /** 图标（通常来自 lucide-react）；`iconOnly` 时它是唯一内容 */
  icon?: ReactNode
  /** 只要图标：此时必须提供 `aria-label`（否则屏幕阅读器读不出用途） */
  iconOnly?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconOnly = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): ReactNode {
  const isDisabled = disabled === true || loading

  return (
    <button
      type="button"
      // 原生的 disabled 已经传达了语义；loading 时也置 disabled，
      // 但额外用 aria-busy 告诉辅助技术"是忙，不是坏了"。
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center font-medium',
        'transition-colors duration-150 ease-standard select-none',
        'disabled:cursor-not-allowed disabled:opacity-55',
        touchTarget,
        SIZE[size],
        VARIANT[variant],
        // 只要图标时给正方形尺寸，否则图标会被文字宽度撑开而显得偏左
        iconOnly && (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0'),
        focusRing,
        className,
      )}
      {...rest}
    >
      {/* loading 时把内容隐藏但**保留占位**（宽度不变） */}
      <span className={cn('inline-flex items-center gap-1.5', loading && 'invisible')}>
        {icon}
        {!iconOnly && children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-3.5" />
        </span>
      )}
    </button>
  )
}
