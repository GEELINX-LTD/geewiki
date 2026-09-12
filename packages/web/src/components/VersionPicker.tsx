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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { History, RotateCcw } from 'lucide-react'
import { api, type PageDetail, type VersionMeta, type VersionPageItem } from '../api'
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
import { Spinner } from '../ui/Spinner'
import { absoluteTime, relativeTime } from '../lib/timePlan'
import { pickerTriggerText, versionChangeSummary, versionCountText, versionMetaText, versionNumberOf } from '../lib/versionPlan'
import { authorText } from './VersionDiffDialog'
import { cn } from '../ui/cn'
import { focusRing } from '../ui/a11y'

/**
 * 紧凑区默认展示几条。
 *
 * 3 是"够看出最近在动什么"与"不占版面"的折中：1 条看不出节奏，10 条就接近原来那张卡片了。
 */
export const COMPACT_VERSIONS = 3

/**
 * 标签：历史条目按倒序数下来是 `v{总数 - i}`。
 *
 * ⚠️ 实现已挪到 `lib/versionPlan.ts` 的 `versionNumberOf`（**从总数往下数**）：
 * 旧写法 `version - i - 1` 在快照被 `recentVersions` 截断时会整体偏移，
 * 把"最近的一条历史"标成更低的号。这里保留同名导出只为兼容既有调用，语义以 versionPlan 为准。
 */
export function versionLabel(page: { version: number }, index: number): number {
  return versionNumberOf(page, index)
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
  slug,
  page,
  previewNumber,
  onPreview,
  onCompare,
}: {
  /** 用于拉分页版本列表（改动摘要与更早的版本只有那个端点有） */
  slug: string
  /** 只要版本号与版本列表 —— 避免与 `PageDetail` 的其它字段耦合 */
  page: Pick<PageDetail, 'version' | 'versions'>
  /** 正在预览的历史版本号；`null` = 看的是最新版 */
  previewNumber: number | null
  /** 选中某一版 ⇒ **进预览态**（写进 URL，可分享）。参数是快照 id 与它的版本号 */
  onPreview: (id: number, label: number) => void
  /** 打开对比弹窗（在同一版上"看差异"）。与预览是两件事：预览改 URL，对比不改 */
  onCompare: (version: VersionMeta, label: number) => void
}): ReactNode {
  const [timelineOpen, setTimelineOpen] = useState(false)
  const versions = page.versions
  /*
   * 改动摘要与"更早的版本"都只有 `GET …/versions`（分页端点）有：
   * 页内 `versions[]` 只给最近的 N 条、且不含 `change`。
   *
   * **按需拉取**（菜单打开时）而不是随页面一起拉：摘要要服务端为每条算一次差值，
   * 而多数访问根本不点开这个菜单。拉不到就**不显示摘要** —— 见 `versionChangeSummary`。
   */
  const [rows, setRows] = useState<VersionPageItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadPage = useCallback(
    async (before?: number): Promise<void> => {
      setLoadingMore(true)
      try {
        const r = await api.versions(slug, before === undefined ? undefined : { before })
        setRows((prev) => (before === undefined ? r.versions : [...prev, ...r.versions]))
        setHasMore(r.hasMore)
      } catch {
        /* 降级：保留已有的行，摘要不显示。这里刻意不弹错误 —— 看版本不该被摘要拖累 */
      } finally {
        setLoadingMore(false)
      }
    },
    [slug],
  )

  /*
   * 摘要/额外行按 id 索引。**以 `rows` 为准**（它带服务端算好的版本号与 `change`），
   * 页内 `versions[]` 只在 `rows` 还没到货时兜底 —— 两条来源同时用会让"版本号"出现两套说法。
   */
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  const missing = rows.length === 0
  const lastLoadedNumber = rows.length === 0 ? null : rows[rows.length - 1]!.number

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open && rows.length === 0) void loadPage() }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`版本选择，${previewNumber === null ? `当前 v${page.version}` : `正在预览 v${previewNumber}`}`}
            className={cn(
              focusRing,
              'inline-flex min-h-6 min-w-6 cursor-pointer items-center rounded-md border border-line bg-surface px-2 py-0.5 text-2xs font-medium text-ink hover:bg-hover',
              previewNumber !== null && 'border-warn-line bg-warn-bg text-warn-ink',
            )}
          >
            {pickerTriggerText(page.version, previewNumber)}
          </button>
        </DropdownMenuTrigger>
        {/*
          长列表可滚：`recentVersions` 最多 100 条，不设上限会把菜单撑出视口。
          `24rem` 是"能看清十来条"与"不遮住页面"的折中。
        */}
        <DropdownMenuContent align="start" className="max-h-[min(24rem,60vh)] overflow-y-auto">
          <DropdownMenuLabel>版本</DropdownMenuLabel>
          {/* 「最新」固定在顶部：它是"退出预览"的出口，不该被历史列表挤走 */}
          <DropdownMenuItem active={previewNumber === null} onSelect={() => onPreview(0, -1)}>
            v{page.version}
            <span className="ml-auto pl-3 text-2xs text-muted">最新{previewNumber === null ? ' · 正在查看' : ''}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {versions.length === 0 ? (
            <p className="m-0 px-2.5 py-1.5 text-2xs text-muted">暂无历史版本</p>
          ) : (
            versions.map((v, i) => {
              const label = versionNumberOf(page, i)
              const active = previewNumber === label
              const summary = versionChangeSummary(rowById.get(v.id)?.change)
              return (
                <DropdownMenuItem key={v.id} active={active} onSelect={() => onPreview(v.id, label)}>
                  v{label}
                  {active && <span className="ml-1 text-2xs text-accent">正在预览</span>}
                  <span className="ml-auto flex items-center gap-2 pl-3">
                    {/* 摘要拉不到就不显示 —— 编一句"0 段改动"比不显示更糟 */}
                    {summary !== null && <span className="text-2xs text-muted">{summary}</span>}
                    <span className="text-2xs text-muted" title={absoluteTime(v.saved_at)}>
                      {versionMetaText(v.saved_at, v.author)}
                    </span>
                  </span>
                </DropdownMenuItem>
              )
            })
          )}
          <DropdownMenuSeparator />
          {/*
            「加载更早的版本」用**游标**（`before` = 已加载的最后一条 id）而不是 offset：
            并发保存时 offset 会跳条/重复。
          */}
          {hasMore ? (
            <DropdownMenuItem
              disabled={loadingMore}
              /*
               * 就地加载下一页：Radix 默认"选中即关菜单"，而这里希望用户留在列表里
               * —— 所以不用 `onSelect`（它会关），改用 `onClick` 直接触发。
               */
              onClick={() => {
                if (loadingMore || lastLoadedNumber === null) return
                void loadPage(rows[rows.length - 1]!.id)
              }}
            >
              {loadingMore && <Spinner label="正在加载更早的版本" />}
              {loadingMore ? '正在加载…' : '加载更早的版本…'}
            </DropdownMenuItem>
          ) : (
            rows.length > 0 &&
            missing === false && (
              <p className="m-0 px-2.5 py-1.5 text-2xs text-muted">已到最早版本（v1）</p>
            )
          )}
          <DropdownMenuSeparator />
          {/*
            条数摘要：**从正文下方那块常驻列表搬过来的**（原处有一行"当前 vN · 共 N 次改动
            （列出最近 M 次，更早的未列出）"）。搬进下拉而不是删掉，是因为"这一页一共改过几次、
            这里列的是不是全部"属于**诚实的边界信息** —— 少了它，用户会把"下拉里就这几条"
            误当成"这一页只改过这几次"。

            措辞刻意与分页状态解耦：`rows` 是异步按需拉的（拉不到就不显示），
            而这行只依赖页面详情里已经有的 `page.version` 与 `versions.length`。
          */}
          <p className="m-0 px-2.5 py-1.5 text-2xs text-muted">
            {versionCountText(page)}
          </p>
          <DropdownMenuItem onSelect={() => setTimelineOpen(true)}>
            <History className="size-3.5" />
            浏览全部历史…
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
  slug,
  open,
  onOpenChange,
  page,
  onPick,
}: {
  /** 拉全量历史（分页端点）；给了才能在弹窗里看到**更早的**改动，而不只是最近 N 条 */
  slug?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  page: Pick<PageDetail, 'version' | 'versions'>
  onPick: (version: VersionMeta, label: number) => void
}): ReactNode {
  const versions = page.versions
  const total = page.version - 1
  const truncated = total > versions.length
  /*
   * 弹窗是"我主动翻历史"的场景 ⇒ 这里**值得**拉全量（含更早的条目）。拉不到就退回页内
   * 那 N 条，并在下方如实说明"更早的未列出"——现状文案已经这么写了，不额外编造。
   */
  const [rows, setRows] = useState<VersionPageItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || slug === undefined || rows.length > 0) return
    let cancelled = false
    setLoading(true)
    api
      .versions(slug, { limit: 100 })
      .then((r) => {
        if (!cancelled) setRows(r.versions)
      })
      .catch(() => {
        /* 降级：用页内那份，不弹错 */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, slug, rows.length])

  const listed = rows.length > 0 ? rows.length : versions.length
  const stillTruncated = total > listed

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="改动记录"
        description={
          /* 诚实性要求不变，但比旧卡片那句短得多：把"总数"与"已列出"分开说 */
          total === 0
            ? '暂无历史版本 —— 每次保存正文变化都会在此留档。'
            : `共 ${total} 次改动，列出 ${listed} 次${stillTruncated ? '（更早的未列出）' : ''}。`
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
        ) : rows.length > 0 ? (
          /*
           * 有服务端行就用它：**版本号来自 `ROW_NUMBER()`**（翻页/截断都对），
           * 且带 `change` 摘要。最后一条（最早那版）没有对照对象 ⇒ 它的 `change` 为 null，
           * 摘要自然不显示 —— 不是"什么都没改"。
           */
          <ServerVersionList
            rows={rows}
            canCompare
            onPick={(r) => onPick({ id: r.id, saved_at: r.saved_at, title: r.title, author: r.author }, r.number)}
          />
        ) : (
          /* 降级：分页端点还没到货（或失败）时，退回页内那 N 条 */
          <VersionList page={page} onPick={onPick} />
        )}
        {loading && (
          <p className="m-0 mt-3 flex items-center gap-2 text-2xs text-muted">
            <Spinner label="正在加载更早的改动" />
            正在加载更早的改动…
          </p>
        )}
        {stillTruncated && (
          <p className="m-0 mt-3 text-2xs text-muted">
            更早的改动未列出（这一屏最多取 100 条）—— 这不代表它们不存在，只是这一屏没取。
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

/**
 * 改动时间线的行列表 —— 数据来自**分页端点**（`VersionPageItem`），不是页内那 N 条。
 *
 * 为什么不复用 `VersionList`：后者按 `page.version - i` 从**下标**推版本号，只能画页内
 * `versions[]`（最多 `recentVersions` 条）。要列"更早的"，版本号必须用服务端算好的
 * `number`（`ROW_NUMBER()`）—— 翻页之后下标与版本号不再对应，这正是 `versionPlan.ts`
 * 反复强调的那条。
 */
function ServerVersionList({
  rows,
  onPick,
  canCompare,
}: {
  rows: readonly VersionPageItem[]
  onPick: (row: VersionPageItem) => void
  /** 只读视角下不给"看差异"入口：快照端点要求 `canEdit`，给了也必然 404 */
  canCompare: boolean
}): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((r) => {
        /* 摘要拉不到就整段不显示 —— 编一句"0 段改动"比不显示更糟 */
        const summary = versionChangeSummary(r.change)
        const meta = versionMetaText(r.saved_at, r.author)
        const inner = (
          <>
            <span className="font-medium text-ink">v{r.number}</span>
            {summary !== null && <span className="text-2xs text-muted">{summary}</span>}
            <span className="ml-auto text-2xs text-muted" title={absoluteTime(r.saved_at)}>
              {meta}
            </span>
          </>
        )
        return (
          <li key={r.id} className="m-0">
            {canCompare ? (
              <button
                type="button"
                onClick={() => onPick(r)}
                className={cn(
                  focusRing,
                  'flex w-full cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-left text-sm hover:bg-hover',
                )}
              >
                {inner}
              </button>
            ) : (
              /* 只读：**纯文本行**而不是禁用按钮 —— 禁用按钮仍在暗示"这里有个能力" */
              <span className="flex w-full items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm">
                {inner}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 只读用户的版本信息入口。
 *
 * 给到**存在性**为止：复用改动记录弹窗列出「版本 / 时间 / 谁」，但**没有**快照正文入口
 * （服务端在快照端点上对非 `canEdit` 一律 404，给出入口就是给出必然失败的按钮），
 * 也**没有**恢复入口（那要 `canManageVisibility`）。
 *
 * 为什么仍然要给：只读视角下头部此前只有一枚 `版本 vN` 徽标 —— 读者看得见"这是第几版"，
 * 却完全不知道"这一页改过几次、最近什么时候动的"。那属于**不敏感的存在性信息**，
 * 不给反而让人以为页面从未被改动过。
 *
 * 为什么复用 `TimelineDialog` 而不另写：那个弹窗已经在列「版本 / 时间 / 谁」，
 * 再写一份必然漂移（两份"改动记录"迟早对不上）。传 `onPick` 为空操作 ⇒ 只读用户
 * 点行不会打开任何对比弹窗。
 */
export function ReadonlyHistoryButton({
  slug,
  page,
}: {
  slug: string
  page: Pick<PageDetail, 'version' | 'versions'>
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          focusRing,
          'inline-flex min-h-6 min-w-6 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-medium text-muted hover:bg-hover hover:text-ink',
        )}
      >
        <History className="size-3" aria-hidden="true" />
        历史
      </button>
      <TimelineDialog
        slug={slug}
        open={open}
        onOpenChange={setOpen}
        page={page}
        onPick={() => setOpen(false)}
      />
    </>
  )
}
