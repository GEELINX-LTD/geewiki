/**
 * ErrorNotice —— **行内**错误提示（区别于整块的 `ErrorState`）。
 *
 * 分工：
 * - `ErrorState`＝某个**区域**的内容加载失败（卡片/页面主体），块级、`role="alert"`、可带重试；
 * - `ErrorNotice`＝**动作**失败的行内提示（保存失败、删除失败、刷新失败…），
 *   它出现时页面其它内容往往仍然有效，不该顶掉整块内容，也不该再给一个重试按钮
 *   （重试入口**只应有一个**，属于区域级 `ErrorState`）。
 *
 * ## 两条硬约束（都在这里强制，避免各页面各写一遍再写歪）
 *
 * 1. **绝不渲染原始 `Error.message`**。传入的是**错误值**而非字符串，内部一律经
 *    `errorLine()` 转人话；原始文案只作为 `title` 属性里的排障线索，且同样经
 *    `cleanHint()` 清洗与截断（去 API 路径、去英文堆栈形态）。
 *    这是刻意的：只要接口收的是 `unknown` 而不是 `string`，调用方就没有机会把
 *    未清洗的串塞进来。
 * 2. **默认不用 `role="alert"`**。同一屏上如果区域级 `ErrorState` 已经在播报，
 *    再来一个 alert 会重复打断读屏。行内提示默认 `role="status"`（礼貌播报）；
 *    仅当它是该页**唯一**的错误出口时，调用方才显式传 `role="alert"`。
 */
import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { cn } from './cn'
import { cleanHint, errorLine } from '../lib/errorText'

export function ErrorNotice({
  error,
  role = 'status',
  className,
}: {
  /** **错误值本身**（不是字符串）。传字符串会被当成 unknown 走 unknown 分支，故调用方应传 throw 出来的原值。 */
  error: unknown
  /** 仅当本提示是该页唯一的错误出口时才传 'alert' */
  role?: 'alert' | 'status'
  className?: string
}): ReactNode {
  if (error === null || error === undefined || error === '') return null
  // 排障线索：清洗后的原始文案（可能为空 ⇒ 不设 title，避免出现空 tooltip）
  const raw = cleanHint(error instanceof Error ? error.message : error)
  return (
    <span
      role={role}
      title={raw === '' ? undefined : raw}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-danger-line bg-danger-bg px-3 py-1 text-note text-danger-ink',
        className,
      )}
    >
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {errorLine(error)}
    </span>
  )
}
