/**
 * Skeleton / SkeletonTable —— 加载占位。
 *
 * 为什么用骨架屏而不是"加载中…"文字：
 * 骨架屏**保留了最终布局的尺寸**，因此数据到达时不会发生布局跳动（CLS），
 * 视觉上也更连续。代价是必须让骨架与真实内容**同尺寸**，否则跳动照旧——
 * 这是使用本组件时最需要注意的一点（`SkeletonTable` 的列宽刻意与列表页一致）。
 *
 * 无障碍：骨架屏对屏幕阅读器是**噪声**（它没有信息量），故整体 `aria-hidden`，
 * 由调用方用真实的状态文本（`aria-live` 或 `role="status"`）播报"正在加载"。
 * 动效尊重 `prefers-reduced-motion`（不闪烁）。
 */
import type { ReactNode } from 'react'
import { cn } from './cn'

export function Skeleton({ className }: { className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block animate-pulse rounded-sm bg-hover',
        'motion-reduce:animate-none',
        className,
      )}
    />
  )
}

/**
 * 表格骨架：`rows` 行 × `cols` 列，与列表页的表格结构对齐。
 * 包在 `<tbody aria-hidden>` 里由调用方使用（见 WikiList）。
 */
export function SkeletonTable({ rows = 4, cols = 4 }: { rows?: number; cols?: number }): ReactNode {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 p-4">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton
              key={c}
              // 首列是标题（宽），其余按内容比例给宽，模拟真实密度
              className={cn('h-4', c === 0 ? 'flex-[3]' : c === cols - 1 ? 'flex-1' : 'flex-[2]')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
