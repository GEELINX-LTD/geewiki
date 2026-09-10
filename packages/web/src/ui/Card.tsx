/**
 * Card / CardHeader / CardBody —— 内容容器原语。
 *
 * 用**语义化分区**而非一个大 div：`CardHeader` 里的标题用 `<h2>`，
 * 使文档大纲（屏幕阅读器/大纲视图）能反映页面结构。标题层级由调用方决定
 * （`as` 属性），因为同一张 Card 在不同页面可能处于不同层级。
 */
import type { ReactNode } from 'react'
import { cn } from './cn'

export function Card({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  return (
    <section
      className={cn(
        'rounded-lg border border-line bg-surface shadow-sm',
        className,
      )}
    >
      {children}
    </section>
  )
}

export function CardHeader({
  title,
  as: As = 'h2',
  description,
  actions,
  className,
}: {
  title: ReactNode
  /** 标题标签层级，默认 h2（页面主标题是 h1） */
  as?: 'h2' | 'h3'
  description?: ReactNode
  /** 右侧操作区（按钮等） */
  actions?: ReactNode
  className?: string
}): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <As className="m-0 truncate text-sm font-semibold text-ink">{title}</As>
        {description !== undefined && (
          <p className="m-0 mt-0.5 text-xs text-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  return <div className={cn('px-4 py-3', className)}>{children}</div>
}
