/**
 * UI 原语统一出口。
 *
 * 这是 shadcn/ui 的"源码入库"模式：组件**代码在本仓库**（`src/ui/`），不是黑盒依赖。
 * 好处是样式与行为都能按产品需要改，且升级 Radix 时不会被组件库的抽象层挡住；
 * 代价是要自己维护这层封装——因此每个组件都写清了"为什么这样封装"。
 */
export { cn } from './cn'
export { focusRing, touchTarget } from './a11y'
export {
  Button,
  buttonClassName,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button'
export { Spinner } from './Spinner'
export { Input, Textarea, type InputProps } from './Input'
export { Card, CardHeader, CardBody } from './Card'
export { Badge, type BadgeTone } from './Badge'
export { Skeleton, SkeletonTable } from './Skeleton'
export { LoadingState } from './LoadingState'
export { ErrorState } from './ErrorState'
export { ErrorNotice } from './ErrorNotice'
export { EmptyState } from './EmptyState'
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './DropdownMenu'
export { Dialog, DialogTrigger, DialogClose, DialogContent } from './Dialog'
export { Tooltip, TooltipProvider, TooltipRoot, type TooltipProps } from './Tooltip'
