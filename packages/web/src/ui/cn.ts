/**
 * 类名合并工具（shadcn/ui 的既有约定）。
 *
 * `clsx` 负责条件拼接（对象/数组/假值过滤），`tailwind-merge` 负责**消解 Tailwind
 * 工具类冲突**：后写的同类工具覆盖先写的（`cn('px-2', 'px-4')` → `px-4`）。
 * 没有它，组件默认样式与调用方传入的 `className` 就会互相打架，且胜负取决于
 * CSS 里的声明顺序（不可预测）。
 *
 * 注意：tailwind-merge 只理解**工具类**。本仓库同时保留了 `@layer legacy` 里的旧类
 * （`.btn` / `.card` …），两者不在同一个命名空间，因此 `cn('btn', 'px-4')` 的合并
 * 结果仍然正确——旧类与工具类的优先级由 `src/styles/index.css` 的层序决定
 * （utilities 在 legacy 之后，故工具类赢）。
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
