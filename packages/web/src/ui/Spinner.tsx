/**
 * Spinner —— 加载指示器。
 *
 * 无障碍：容器带 `role="status"` + `aria-label`，屏幕阅读器会播报"加载中"；
 * 纯装饰场合（按钮内已有 aria-busy）用 `<Spinner />` 默认的 `aria-hidden` 分支即可
 * ——因此这里给一个 `label` 属性：传了才成为可播报的状态节点，不传就是纯装饰。
 *
 * 动效：尊重 `prefers-reduced-motion`（旋转停止，改为静态圆环）——不是为了好看，
 * 而是前庭失调用户的硬需求（WCAG 2.3.3）。
 */
import type { ReactNode } from 'react'
import { cn } from './cn'
import { withExt } from '../lib/slots'

function SpinnerBase({ className, label }: { className?: string; label?: string }): ReactNode {
  const ring = (
    <span
      className={cn(
        'block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        'motion-reduce:animate-none',
        className,
      )}
    />
  )
  if (label === undefined) return <span aria-hidden="true">{ring}</span>
  return (
    <span role="status" aria-label={label} className="inline-flex items-center">
      {ring}
    </span>
  )
}

/* ★ P7：宿主节点接线（`replace` / `wrap` / `extend`，见 docs/design/ui-extension-platform.md） */
export const Spinner = withExt('ui-spinner', SpinnerBase)
