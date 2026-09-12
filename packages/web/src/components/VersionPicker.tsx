/**
 * VersionPicker —— 头部的**版本下拉**（替代底部那张占一大块的「版本历史」卡片）。
 *
 * ## 交互契约
 * - **无编辑权时不渲染下拉**，退化为纯文本徽标（`<span>`）。为什么不是"置灰 + title"：
 *   置灰本身就在暗示"这里有个你够不着的能力"，而本仓库的立场是——**只读入口不应存在**
 *   （服务端在快照端点上另有强制，前端隐藏只是体验）。
 * - 菜单项是「当前（vN）」+ 最近的历史版本；底部一项打开**改动时间线**。
 * - 选中历史版本 **不**把内容插到正文下面，而是交给 `VersionDiffDialog` —— 对比是"看一眼"
 *   的动作，不该改变页面布局。
 *
 * ## 为什么紧凑区默认只展示最近 3 条
 * 版本多起来（`recentVersions` 最多 100）时，"每次改动都列出来"就又把版面撑回原样了 ——
 * 那正是用户抱怨的问题。所以紧凑区**只列最近 `COMPACT_VERSIONS` 条**，其余走
 * 「查看全部改动…」弹窗（弹窗是用户主动打开的，占版面是合理的）。两条路径**共用同一行组件**
 * （`VersionRowButton`），避免"列表里长这样、弹窗里长那样"的漂移。
 *
 * ## 为什么时间线里不默认算 `+N / −M`
 * 算一次差异要读两份全文（当前正文 + 该快照），10 条就是 10 次拉取 + 10 次 diff。
 * 大文档上这是开菜单就卡一下的来源。所以：时间线只给"何时 / 谁"（本地已有数据），
 * **行数统计在打开对比弹窗时才算**（那时只需要相邻两版）。
 */
import { useState, type ReactNode } from 'react'
import { History, RotateCcw } from 'lucide-react'
import { api, type PageDetail, type VersionMeta } from '../api'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu'
import { Dialog, DialogContent } from '../ui/Dialog'
import { absoluteTime, relativeTime } from '../lib/timePlan'
import { authorText } from './VersionDiffDialog'
import { cn } from '../ui/cn'
import { focusRing } from '../ui/a11y'

/**
 * 紧凑区默认展示几条。
 *
 * 3 是"够看出最近在动什么"与"不占版面"的折中：1 条看不出节奏，10 条就接近原来那张卡片了。
 */
export const COMPACT_VERSIONS = 3

/** 标签：`page.version` 是**当前**版本号，历史条目按倒序数下来是 `version - index - 1`。 */
export function versionLabel(page: { version: number }, index: number): number {
  return page.version - index - 1
}

/**
 * 一行版本记录 —— 紧凑区与「查看全部改动」弹窗**共用**，保证两处观感与信息完全一致。
 *
 * 统计 `+N / −M` 不在这里算：算差异要拉两份全文，逐行算会把开菜单/滚列表变成卡顿源
 * （详见文件头）。要看行数就点进对比弹窗 —— 那时只需要相邻两版。
 */
export function VersionRowButton({
  version,
  label,
  onPick,
}: {
  version: VersionMeta
  label: number
  onPick: (version: VersionMeta, label: number) => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onPick(version, label)}
      className={cn(
        focusRing,
        'flex w-full cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-1.5 text-left text-note hover:bg-hover',
      )}
    >
      <Badge tone="neutral">v{label}</Badge>
      <span className="text-ink" title={absoluteTime(version.saved_at)}>
        {relativeTime(version.saved_at)}
      </span>
      <span className="text-muted">{authorText(version.author)}</span>
      {version.title != null && version.title !== '' && (
        <span className="min-w-0 flex-1 truncate text-muted" title={version.title}>
          {version.title}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1 text-accent">
        <RotateCcw className="size-3" aria-hidden="true" />
        对比
      </span>
    </button>
  )
}

/**
 * 版本列表（紧凑区与弹窗共用）：`limit` 省略即全列。
 *
 * `limit` 只截**展示**，不改变数据；被截掉多少由调用方的文案如实说明，**不假装完整**。
 */
export function VersionList({
  page,
  onPick,
  limit,
}: {
  page: Pick<PageDetail, 'version' | 'versions'>
  onPick: (version: VersionMeta, label: number) => void
  limit?: number
}): ReactNode {
  const shown = limit === undefined ? page.versions : page.versions.slice(0, limit)
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {shown.map((v, i) => (
        <li key={v.id}>
          <VersionRowButton version={v} label={versionLabel(page, i)} onPick={onPick} />
        </li>
      ))}
    </ul>
  )
}

export function VersionPicker({
  page,
  onCompare,
}: {
  /** 只要版本号与版本列表 —— 避免与 `PageDetail` 的其它字段耦合 */
  page: Pick<PageDetail, 'version' | 'versions'>
  onCompare: (version: VersionMeta, label: number) => void
}): ReactNode {
  const [timelineOpen, setTimelineOpen] = useState(false)
  const versions = page.versions

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`版本选择，当前 v${page.version}`}
            className={cn(
              focusRing,
              'inline-flex min-h-6 min-w-6 cursor-pointer items-center rounded-md border border-line bg-surface px-2 py-0.5 text-2xs font-medium text-ink hover:bg-hover',
            )}
          >
            版本 v{page.version}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60vh] overflow-y-auto">
          <DropdownMenuLabel>版本</DropdownMenuLabel>
          <DropdownMenuItem active>
            当前（v{page.version}）
            <span className="ml-auto text-2xs text-muted">{relativeTime(new Date().toISOString())}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {versions.length === 0 ? (
            <p className="m-0 px-2.5 py-1.5 text-2xs text-muted">暂无历史版本</p>
          ) : (
            versions.map((v, i) => {
              const label = versionLabel(page, i)
              return (
                <DropdownMenuItem key={v.id} onSelect={() => onCompare(v, label)}>
                  v{label}
                  <span className="ml-auto pl-3 text-2xs text-muted" title={absoluteTime(v.saved_at)}>
                    {relativeTime(v.saved_at)} · {authorText(v.author)}
                  </span>
                </DropdownMenuItem>
              )
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setTimelineOpen(true)}>
            <History className="size-3.5" />
            查看全部改动…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TimelineDialog
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        page={page}
        onPick={(v, label) => {
          setTimelineOpen(false)
          onCompare(v, label)
        }}
      />
    </>
  )
}

/**
 * 改动时间线：紧凑到"一行一次改动"，只在需要时打开。
 *
 * 与旧卡片的关键差别：**没有内联的快照正文预览**（那正是它占一大块的原因），
 * 也**不算行数**（见文件头注释）。要看内容就点进去，对比弹窗里同时给差异与恢复。
 */
export function TimelineDialog({
  open,
  onOpenChange,
  page,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  page: Pick<PageDetail, 'version' | 'versions'>
  onPick: (version: VersionMeta, label: number) => void
}): ReactNode {
  const versions = page.versions
  const total = page.version - 1
  const truncated = total > versions.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="改动记录"
        description={
          /* 诚实性要求不变，但比旧卡片那句短得多：把"总数"与"已列出"分开说 */
          total === 0
            ? '暂无历史版本 —— 每次保存正文变化都会在此留档。'
            : `共 ${total} 次改动，列出最近 ${versions.length} 次${truncated ? '（更早的未列出）' : ''}。`
        }
        className="w-[min(44rem,calc(100vw-2rem))]"
        footer={
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        }
      >
        {versions.length === 0 ? (
          <p className="m-0 text-note text-muted">还没有可对比的历史版本。</p>
        ) : (
          /* 与紧凑区共用同一行组件（`VersionList`）：两处观感与信息必须逐字一致 */
          <VersionList page={page} onPick={onPick} />
        )}
        {truncated && (
          <p className="m-0 mt-3 text-2xs text-muted">
            更早的改动未列出（一次只取最近 {versions.length} 条）——
            这不代表它们不存在，只是这一屏没取。
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 只读徽标：无编辑权时的版本显示（**不是**禁用态按钮）。 */
export function VersionBadge({ version }: { version: number }): ReactNode {
  return <Badge tone="neutral">版本 v{version}</Badge>
}
