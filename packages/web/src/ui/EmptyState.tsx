/**
 * EmptyState —— 空态。
 *
 * 空态必须**给出下一步动作**（而不是只说"暂无数据"）：用户看到空白页时最需要的是
 * "我该做什么"。因此 `action` 是显式参数，且在本仓库的列表页里被用上（"新建页面"）。
 *
 * 无障碍：图标纯装饰（`aria-hidden`）；标题用 `<p>` 而非标题标签——空态不是章节，
 * 用标题会污染文档大纲。
 */
import type { ReactNode } from 'react'
import { cn } from './cn'

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  /** 装饰图标（lucide 组件） */
  icon?: ReactNode
  title: ReactNode
  /** 补充说明（可选） */
  hint?: ReactNode
  /** 引导动作（强烈建议提供） */
  action?: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      {icon !== undefined && (
        <span aria-hidden="true" className="mb-1 text-muted opacity-70">
          {icon}
        </span>
      )}
      <p className="m-0 text-sm font-medium text-ink">{title}</p>
      {hint !== undefined && <p className="m-0 max-w-[46ch] text-xs leading-relaxed text-muted">{hint}</p>}
      {action !== undefined && <div className="mt-2 flex items-center gap-2">{action}</div>}
    </div>
  )
}
