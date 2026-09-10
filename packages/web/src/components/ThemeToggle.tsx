/**
 * 主题切换：浅色 / 深色 / 跟随系统（三态）。
 *
 * 为什么用下拉而不是"点一下循环切换"的按钮：
 * 三态循环按钮的问题是**用户无法知道当前是哪一态、下一次会切到什么**（尤其是
 * "跟随系统"这一态在图标上无法表达）。下拉把三个选项一次性摊开，当前项有明确的
 * 选中标记，且用 `role="menuitemradio"` 语义（Radix 的 RadioGroup 项）让屏幕阅读器
 * 播报"已选中"——循环按钮做不到这点。
 *
 * 图标语义：太阳=浅色、月亮=深色、显示器=跟随系统；触发按钮的图标反映**当前生效**
 * 的外观，`aria-label` + Tooltip 补出完整文字说明（Tooltip 只作补充，见 Tooltip.tsx
 * 的纪律：不能承载唯一信息——所以 aria-label 已经说明了状态）。
 */
import type { ReactNode } from 'react'
import { Monitor, Moon, Sun, Check } from 'lucide-react'
import { Button } from '../ui/Button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../ui/DropdownMenu'
import { Tooltip, TooltipProvider } from '../ui/Tooltip'
import { useTheme, type ThemeChoice } from '../lib/theme'

const LABEL: Record<ThemeChoice, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

function ChoiceIcon({ choice }: { choice: ThemeChoice }): ReactNode {
  const cls = 'size-4'
  if (choice === 'light') return <Sun className={cls} />
  if (choice === 'dark') return <Moon className={cls} />
  return <Monitor className={cls} />
}

export function ThemeToggle(): ReactNode {
  const { choice, resolved, setChoice } = useTheme()
  const triggerText = `外观：${LABEL[choice]}${choice === 'system' ? `（当前${LABEL[resolved]}）` : ''}`

  return (
    <TooltipProvider delayDuration={400}>
      <DropdownMenu>
        <Tooltip content={triggerText}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<ChoiceIcon choice={choice === 'system' ? resolved : choice} />}
              aria-label={triggerText}
              // 顶栏是深色，ghost 变体的默认色（--muted）在上面对比度不足，
              // 故这里覆盖为顶栏专用前景色（两者都是为深底设计的令牌）
              className="text-header-dim hover:bg-white/10 hover:text-white"
            />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>外观</DropdownMenuLabel>
          {(Object.keys(LABEL) as ThemeChoice[]).map((key) => (
            <DropdownMenuItem key={key} active={choice === key} onSelect={() => setChoice(key)}>
              <ChoiceIcon choice={key} />
              <span className="flex-1">{LABEL[key]}</span>
              {choice === key && <Check className="size-3.5" aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}
