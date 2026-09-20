/**
 * LoadingState —— 加载态的统一外壳（骨架屏 + 可播报的状态文本 + 慢请求提示）。
 *
 * 为什么需要一层外壳，而不是各处直接用 `<Skeleton>`：
 * 1. **对屏幕阅读器**：骨架屏本身是噪声（已 `aria-hidden`），必须另有**真实文本**告知
 *    "正在加载"。这里用 `role="status"` + `aria-live="polite"`——依据 W3C WAI-ARIA APG 的
 *    status 角色用法（https://www.w3.org/WAI/ARIA/apg/patterns/status/ ）：它是**礼貌**播报的
 *    状态消息，适合"加载中"这类不该打断用户的内容（对比 `alert` 的立即打断）。
 *    同时给容器 `aria-busy="true"`，表示该区域的更新尚未完成
 *    （https://www.w3.org/TR/wai-aria-1.2/#aria-busy ）。
 * 2. **慢请求**：超过阈值仍未返回时，把状态文本从"正在加载…"换成"仍在加载…"，让用户知道
 *    **没有卡死**。这是纯文案层面的反馈，刻意不引入进度条/取消等复杂状态机。
 *
 * 状态文本**始终在 DOM 里**（不是只在慢请求时才插入）：读屏用户需要一开始就被告知正在加载；
 * 只在慢时才插文本反而会漏掉播报。
 */
import type { ReactNode } from 'react'
import { cn } from './cn'
import { withExt } from '../lib/slots'

function LoadingStateBase({
  /** 无障碍播报文本，也作为骨架屏的可见说明（sr-only 之外也显示，便于所有人） */
  label = '正在加载…',
  /** 慢请求：文案换成"仍在加载…"（由 `useSlowHint` 提供） */
  slow = false,
  /** 骨架屏本体（`Skeleton` / `SkeletonTable` 等） */
  children,
  className,
}: {
  label?: string
  slow?: boolean
  children?: ReactNode
  className?: string
}): ReactNode {
  const text = slow ? '仍在加载…' : label
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn('flex flex-col gap-3', className)}
    >
      {children}
      <p className="m-0 px-4 text-xs text-muted">{text}</p>
    </div>
  )
}

/* ★ P7：宿主节点接线（`replace` / `wrap` / `extend`，见 docs/design/ui-extension-platform.md） */
export const LoadingState = withExt('ui-loading-state', LoadingStateBase)
