/**
 * Input —— 文本输入原语。
 *
 * 无障碍与体验要点：
 * - 始终配 `<label>`（由调用方提供 `id` + `<label htmlFor>`），或至少给 `aria-label`；
 *   本组件的 `invalid` 会同时设置 `aria-invalid`（屏幕阅读器播报"无效"）；
 * - 焦点态用 `focus-visible:border-accent` + 外发光，与 Button 的 outline 焦点环**并存**：
 *   输入框用边框变色表达聚焦（这是文本框的行业惯例，比 outline 更贴近原生观感），
 *   但仍保留 outline 以确保高对比度模式下可见；
 * - 触控目标 ≥24px（`h-8` = 32px，达标）。
 */
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { cn } from './cn'
import { focusRing } from './a11y'
import { withExt } from '../lib/slots'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 校验失败：加红边 + `aria-invalid` */
  invalid?: boolean
}

function InputBase({ className, invalid, ...rest }: InputProps): ReactNode {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        'h-8 w-full min-w-0 rounded-md border bg-surface px-3 text-sm text-ink',
        'placeholder:text-muted',
        'transition-colors duration-150 ease-standard',
        'disabled:cursor-not-allowed disabled:bg-hover disabled:text-muted',
        invalid ? 'border-danger' : 'border-line hover:border-line-strong',
        'focus:border-accent',
        focusRing,
        className,
      )}
      {...rest}
    />
  )
}

/**
 * Textarea：与 Input 同源的观感（等宽字体留给调用方用 `font-mono` 覆盖，
 * 因为只有代码/配置类输入才需要等宽）。
 *
 * 属性类型是 `TextareaHTMLAttributes`（**不是** `InputHTMLAttributes`）：
 * 后者会把 `onChange` 的 `e.target` 推断成 `HTMLInputElement`，
 * 于是调用方在文本域上写 `rows`/`onKeyDown` 时事件类型对不上
 * （本仓库接入管理台时实测报 TS2322）。
 */
function TextareaBase({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean
  /**
   * 原生 textarea 的 ref。React 19 起 `ref` 是**普通 prop**（不再需要 `forwardRef`），
   * 但它不在 `TextareaHTMLAttributes` 里，故在此显式声明 —— 降级编辑器要用它读写选区
   * （`MarkdownEditorLazy.tsx` 的 FallbackEditor：工具栏动作要落在正确的光标位置上）。
   */
  ref?: Ref<HTMLTextAreaElement>
}): ReactNode {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded-md border bg-surface px-3 py-2 text-sm leading-relaxed text-ink',
        'placeholder:text-muted resize-y',
        'transition-colors duration-150 ease-standard',
        'disabled:cursor-not-allowed disabled:bg-hover disabled:text-muted',
        invalid ? 'border-danger' : 'border-line hover:border-line-strong',
        'focus:border-accent',
        focusRing,
        className,
      )}
      {...rest}
    />
  )
}

/* ★ P7：宿主节点接线（`replace` / `wrap` / `extend`，见 docs/design/ui-extension-platform.md） */
export const Input = withExt('ui-input', InputBase)
export const Textarea = withExt('ui-textarea', TextareaBase)
