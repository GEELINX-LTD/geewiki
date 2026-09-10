/**
 * ErrorState —— 错误态（请求失败时**可重试**的统一呈现）。
 *
 * 与 `EmptyState` 的分工（这是本仓库刻意区分的两种"没有内容"）：
 * - **空态**＝请求成功，但**确实没有数据**（甚至用户还没建过页面）⇒ 引导下一步动作；
 * - **错误态**＝请求**没成功**，我们**不知道**有没有数据 ⇒ 说明原因 + 重试。
 * 两者混用会让用户以为是"没有数据"而放弃，或以为是"出错"而反复重试——所以分开。
 *
 * 无障碍（依据 W3C WAI-ARIA APG · Alert Pattern，
 * https://www.w3.org/WAI/ARIA/apg/patterns/alert/ ）：
 * - 容器 `role="alert"`：这是**由脚本动态插入**的错误提示，读屏应当在它出现时**立即播报**。
 *   APG 对 alert 的用法是"内容被插入时触发播报"，正合此场景；
 * - 图标 `aria-hidden`：装饰，标题文本已表达语义，不必重复播报；
 * - 「重试」是真 `<button>`（键盘可达、有焦点环），而不是一个可点的 `<span>`。
 *
 * 为什么不展示原始错误对象/堆栈：界面上出现堆栈对用户毫无用处，还可能泄漏内部路径。
 * 文案的人话化在 `lib/errorText.ts` 的 `describeError()` 里完成（纯函数、可单测）。
 */
import type { ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { cn } from './cn'
import { Button } from './Button'

export function ErrorState({
  title,
  hint,
  onRetry,
  retryLabel = '重试',
  retrying = false,
  icon,
  className,
}: {
  title: ReactNode
  /** 具体原因（可选）。**不要**传原始错误对象/堆栈，传人话。 */
  hint?: ReactNode
  /** 重试回调；**不传则不渲染重试按钮**（参数类错误重试无意义） */
  onRetry?: () => void
  retryLabel?: string
  /** 重试进行中：按钮进入 loading 且不可重复点 */
  retrying?: boolean
  /** 自定义图标（默认警示三角） */
  icon?: ReactNode
  className?: string
}): ReactNode {
  return (
    <div
      role="alert"
      className={cn(
        // 用 border-dashed + 中性底：错误**不等于**危险操作（那是 danger 按钮的语义），
        // 但要比空态更醒目，故用边框与图标区分，而不是整块红底（红底会淹没内容区的信息层级）
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-sunken px-6 py-10 text-center',
        className,
      )}
    >
      <span aria-hidden="true" className="mb-1 text-warn opacity-80">
        {icon ?? <AlertTriangle className="size-5" />}
      </span>
      <p className="m-0 text-sm font-medium text-ink">{title}</p>
      {hint !== undefined && hint !== '' && (
        <p className="m-0 max-w-[52ch] text-xs leading-relaxed text-muted">{hint}</p>
      )}
      {onRetry !== undefined && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          disabled={retrying}
          onClick={onRetry}
        >
          <RotateCw className={cn('size-3.5', retrying && 'animate-spin')} aria-hidden="true" />
          {retrying ? '重试中…' : retryLabel}
        </Button>
      )}
    </div>
  )
}
