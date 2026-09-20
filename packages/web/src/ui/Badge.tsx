/**
 * Badge —— 状态/标签徽章。
 *
 * `tone` 是**语义**（ok / warn / danger / accent / neutral / session / suspended），不是颜色——
 * 调用方说"这是成功状态"，而不是"这是绿色的"，颜色随主题自动切换。
 *
 * 无障碍：徽章是**文本**，不是唯一的状态载体（永远与文字说明并存），
 * 因此不需要 `role="status"`；但用 `title` 提供补充说明时应确保该说明不是唯一信息源。
 */
import type { ReactNode } from 'react'
import { cn } from './cn'
import { withExt } from '../lib/slots'

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'session' | 'suspended'

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-hover text-muted border-line',
  accent: 'bg-accent-soft text-accent-soft-ink border-accent-soft-line',
  ok: 'bg-ok-bg text-ok-ink border-ok-line',
  warn: 'bg-warn-bg text-warn-ink border-warn-line',
  danger: 'bg-danger-bg text-danger-ink border-danger-line',
  // 插件状态：会话层（临时启用）与临时停用。语义与 ok/warn/danger 同级，故不走 accent/neutral 借用
  session: 'bg-session-bg text-session-ink border-session-line',
  suspended: 'bg-suspended-bg text-suspended-ink border-suspended-line',
}

function BadgeBase({
  tone = 'neutral',
  className,
  title,
  children,
}: {
  tone?: BadgeTone
  className?: string
  title?: string
  children: ReactNode
}): ReactNode {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        'text-2xs leading-4 font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ★ P7：宿主节点接线（`replace` / `wrap` / `extend`，见 docs/design/ui-extension-platform.md） */
export const Badge = withExt('ui-badge', BadgeBase)
