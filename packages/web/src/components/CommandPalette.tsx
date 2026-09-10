/**
 * 命令面板（Command palette）—— `⌘K` / `Ctrl+K` / `/`
 * ============================================================================
 *
 * 为什么自己写而不是引 `cmdk`：仓库 `docs/roadmap.md` 有「零 UI 框架依赖」的基调
 * （尽管 Radix 原语与 React Flow 在场，那些是"无样式原语"而非组件框架）。
 * 代价是**无障碍得自己做对**——这正是本文件里注释最密的地方。
 *
 * ## ARIA 模式：combobox + listbox（**不是** roving tabindex）
 *
 * 按 WAI-ARIA APG 的 combobox 模式：
 * - **DOM 焦点始终留在输入框**（`<input role="combobox">`），当前项用
 *   `aria-activedescendant` 指向某个 `role="option"` 的 `id`；
 * - 因此 **option 不能加 `tabIndex`**。给每个 option 做 roving tabindex 是 **listbox
 *   模式**的做法（焦点真的在 option 上），与 combobox 组合会互相打架：屏幕阅读器会同时
 *   听到"组合框"与"列表项"两套语义，而 Tab 键的落点也变得不可预测。
 * - 分组的标题不是选项，必须 `role="presentation"`——`listbox` 的直接子元素只允许
 *   `option` 或 `group`，混入普通 div 会让部分屏幕阅读器读不出项数。
 * - 没有结果时**不渲染 listbox**（`aria-expanded=false`、`aria-controls` 置空），
 *   改用一个 `aria-live="polite"` 的状态文本——否则会出现"宣称展开了、里面却没有选项"。
 *
 * ## 焦点归还
 * 关闭后焦点回到触发元素，由 Radix Dialog 负责（`onCloseAutoFocus` 默认行为）。
 *
 * ## 空查询的取舍
 * 刚打开时只给「最近访问 + 操作」，不铺全量页面（见 `lib/commandPlan.ts` 的说明）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  CornerDownLeft,
  FilePlus,
  GitBranch,
  List,
  Puzzle,
  SunMoon,
} from 'lucide-react'
import { cn } from '../ui/cn'
import { focusRing } from '../ui/a11y'
import { usePages } from '../lib/pagesStore'
import { wikiRouteHash } from '../lib/wikiRoute'
import {
  buildPaletteGroups,
  flattenGroups,
  moveIndex,
  pageEntryId,
  readRecents,
  type PaletteEntry,
} from '../lib/commandPlan'

/** listbox 的 id（`aria-controls` 与 `aria-activedescendant` 都要用到） */
const LISTBOX_ID = 'gw-command-listbox'

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 跳转。参数是**不带 `#` 的 hash 目标**（如 `wiki/new`、`wiki/guide%2Fintro`）——
   * 由 `App` 的 `nav()` 统一规范化与赋值，组件不直接碰 `location`。
   */
  onNavigate: (target: string) => void
  /** 切换浅/深外观（由 App 提供，见 App 里关于主题实例同步的注释） */
  onToggleTheme: () => void
  /**
   * 关闭后要把焦点交还给谁。
   *
   * **为什么需要它**：Radix 默认把焦点还给 `Dialog.Trigger`，而本面板是**受控**对话框、
   * 由全局快捷键（⌘K）与顶栏按钮两个入口打开，**没有 Trigger**——于是 Radix 只能退回到
   * `<body>`，键盘用户按 Escape 后会丢失位置（要重新从页首 Tab 一遍）。
   * 实测证据：点击顶栏「搜索」打开 → Escape → `document.activeElement` 是 `BODY`。
   * 由 App 在打开前记下当时的 `activeElement` 并传进来，这里显式归还。
   */
  restoreFocusTo?: { readonly current: HTMLElement | null }
}

interface ActionDef {
  id: string
  label: string
  hint: string
  keywords?: string
  icon: ReactNode
  run: () => void
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onToggleTheme,
  restoreFocusTo,
}: CommandPaletteProps): ReactNode {
  const { pages } = usePages()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  /**
   * 最近访问：**只在打开时读一次**。
   * 放在 render 里读会让每次输入都打一次 localStorage（同步、会阻塞输入）。
   */
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setRecents(readRecents())
    setQuery('')
  }, [open])

  /* ------------------------------ 数据 ------------------------------ */

  const go = useCallback(
    (target: string): void => {
      onNavigate(target)
    },
    [onNavigate],
  )

  /** 页面条目：来自共享的 `pagesStore`（**不再自己发请求**，见该模块的注释） */
  const pageEntries = useMemo<PaletteEntry[]>(
    () =>
      (pages ?? []).map((p) => ({
        id: pageEntryId(p.slug),
        group: 'page' as const,
        label: p.title,
        hint: p.slug,
      })),
    [pages],
  )

  const actions = useMemo<ActionDef[]>(
    () => [
      {
        id: 'action:new',
        label: '新建页面',
        hint: '创建一个新的知识库页面',
        keywords: 'create new page',
        icon: <FilePlus className="size-4" aria-hidden="true" />,
        run: () => go('wiki/new'),
      },
      {
        id: 'action:list',
        label: '浏览全部页面',
        hint: '回到知识库列表',
        keywords: 'list all pages',
        icon: <List className="size-4" aria-hidden="true" />,
        run: () => go('wiki/list'),
      },
      {
        id: 'action:plugins',
        label: '插件管理',
        hint: '启用、停用插件与调整配置',
        keywords: 'plugins admin',
        icon: <Puzzle className="size-4" aria-hidden="true" />,
        run: () => go('plugins'),
      },
      {
        id: 'action:graph',
        label: '依赖图',
        hint: '查看插件之间的依赖关系',
        keywords: 'graph dependencies',
        icon: <GitBranch className="size-4" aria-hidden="true" />,
        run: () => go('graph'),
      },
      {
        id: 'action:theme',
        label: '切换浅色 / 深色外观',
        hint: '在浅色与深色之间切换',
        keywords: 'theme dark light',
        icon: <SunMoon className="size-4" aria-hidden="true" />,
        run: onToggleTheme,
      },
    ],
    [go, onToggleTheme],
  )

  const entryIcon = useMemo(() => {
    const m = new Map<string, ReactNode>()
    for (const a of actions) m.set(a.id, a.icon)
    return m
  }, [actions])

  const runs = useMemo(() => {
    const m = new Map<string, () => void>()
    for (const a of actions) m.set(a.id, a.run)
    for (const p of pages ?? []) {
      m.set(pageEntryId(p.slug), () => {
        // 复用 `wikiRouteHash` 的编码约定（slug 必须 encodeURIComponent），
        // 只剥掉它开头的 `#`——`nav()` 期望的是不带 `#` 的目标
        go(wikiRouteHash(p.slug).replace(/^#/, ''))
      })
    }
    return m
  }, [actions, pages, go])

  const actionEntries = useMemo<PaletteEntry[]>(
    () =>
      actions.map((a) => ({
        id: a.id,
        group: 'action' as const,
        label: a.label,
        hint: a.hint,
        keywords: a.keywords,
      })),
    [actions],
  )

  const groups = useMemo(
    () =>
      buildPaletteGroups({
        query,
        entries: [...pageEntries, ...actionEntries],
        recentSlugs: recents,
      }),
    [query, pageEntries, actionEntries, recents],
  )

  const flat = useMemo(() => flattenGroups(groups), [groups])
  const activeId = activeIndex >= 0 ? (flat[activeIndex]?.id ?? null) : null

  /* --------------------------- 选中项的维护 --------------------------- */

  // 输入变化 → 回到第一项（否则"改了查询却还停在第 5 项"会让人莫名）
  useEffect(() => {
    setActiveIndex(flat.length > 0 ? 0 : -1)
    // 只依赖 query：flat 变化由下面那个 effect 负责夹住索引
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // 结果集变化（例如页面列表异步到达）→ 把索引夹在合法范围内
  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? -1 : Math.min(Math.max(i, 0), flat.length - 1)))
  }, [flat.length])

  // 当前项滚进视野。`block:'nearest'` 是必须的——默认的 'start' 会把列表
  // 每次都拽到顶部，方向键向下时视觉上"跳一下"。
  useEffect(() => {
    if (activeId === null) return
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  /* ------------------------------ 交互 ------------------------------ */

  const runEntry = useCallback(
    (id: string | null): void => {
      if (id === null) return
      const fn = runs.get(id)
      if (fn === undefined) return
      // 先关闭再执行：关闭会让 Radix 归还焦点，随后路由变更接管；
      // 顺序反过来的话，焦点归还会与"新页面已渲染"竞争，偶尔落到错误元素上。
      onOpenChange(false)
      fn()
    },
    [runs, onOpenChange],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => moveIndex(i, 1, flat.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => moveIndex(i, -1, flat.length))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setActiveIndex(flat.length > 0 ? 0 : -1)
      } else if (e.key === 'End') {
        e.preventDefault()
        setActiveIndex(flat.length - 1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        runEntry(activeId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
      }
    },
    [flat.length, activeId, runEntry, onOpenChange],
  )

  const hasItems = flat.length > 0

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-overlay data-[state=open]:animate-in motion-reduce:animate-none" />
        {/*
          面板**顶部对齐**（top-[12vh]）而不是居中：命令面板是"从上方拉下来的"，
          居中会随结果条数变化而上下跳动，视线要重新找位置。
        */}
        <DialogPrimitive.Content
          // 命令面板没有需要朗读的描述文本（输入框自身的 aria-label 已说明用途），
          // 显式置 undefined 以免 Radix 报"缺少 Description"的告警
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // 见 restoreFocusTo 的注释：没有 Trigger 时 Radix 会把焦点丢给 body，
            // 这里显式还给它（元素已不在文档里就保持默认行为）
            const el = restoreFocusTo?.current
            if (el !== null && el !== undefined && document.contains(el)) {
              e.preventDefault()
              el.focus()
            }
          }}
          className={cn(
            'fixed left-1/2 top-[12vh] z-[var(--z-modal)] -translate-x-1/2',
            'w-[min(40rem,calc(100vw-2rem))] overflow-hidden',
            'rounded-xl border border-line bg-surface shadow-xl',
            'data-[state=open]:animate-in motion-reduce:animate-none',
          )}
        >
          {/* 必填：Radix 要求对话框有可访问名称（缺失会告警且屏幕阅读器读不出） */}
          <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-line px-3">
            <input
              // APG combobox 模式：焦点留在这里，当前项由 aria-activedescendant 指示
              role="combobox"
              aria-expanded={hasItems}
              aria-controls={hasItems ? LISTBOX_ID : undefined}
              aria-activedescendant={activeId ?? undefined}
              aria-autocomplete="list"
              aria-label="搜索页面或命令"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="搜索页面，或输入命令…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'w-full border-0 bg-transparent py-3.5 text-sm text-ink',
                // 输入框自己不该画焦点环：整个面板就是它的延伸，
                // 在输入框上再套一圈会让"面板已聚焦"这件事出现两个视觉指示
                'outline-none placeholder:text-muted',
              )}
            />
          </div>

          {hasItems ? (
            <div
              id={LISTBOX_ID}
              role="listbox"
              aria-label="命令与页面"
              className="max-h-[min(24rem,55vh)] overflow-y-auto py-1.5"
            >
              {groups.map((group) => (
                <div role="group" aria-label={group.label} key={group.id}>
                  {/* 分组标题不是选项：listbox 的直接子元素只允许 option/group */}
                  <div
                    role="presentation"
                    className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted"
                  >
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const selected = item.id === activeId
                    return (
                      <div
                        // 无 tabIndex：见文件头关于 combobox vs roving tabindex 的说明
                        role="option"
                        id={item.id}
                        key={item.id}
                        aria-selected={selected}
                        onClick={() => runEntry(item.id)}
                        className={cn(
                          'mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2',
                          'text-sm text-ink',
                          selected ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-hover',
                        )}
                      >
                        <span
                          className={cn(
                            'shrink-0',
                            selected ? 'text-accent-soft-ink' : 'text-muted',
                          )}
                        >
                          {entryIcon.get(item.id) ?? (
                            // 页面项没有专属图标：用一个弱的文档点占位，保持左侧对齐
                            <span aria-hidden="true" className="block size-4 text-center text-muted">
                              ·
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint !== undefined && item.hint !== '' && (
                          <span className="shrink-0 truncate text-xs text-muted">{item.hint}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          ) : (
            // 没有结果时不渲染 listbox（见文件头），改用 live region 朗读
            <div aria-live="polite" className="px-4 py-6 text-center text-sm text-muted">
              {pages === null ? '正在载入页面…' : `没有匹配「${query.trim()}」的页面或命令`}
            </div>
          )}

          {/* 快捷键提示：命令面板的惯例，也让"上下键可用"这件事被发现 */}
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-muted">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              选择
            </span>
            <span className="flex items-center gap-1">
              <Kbd>
                <CornerDownLeft className="size-3" aria-hidden="true" />
              </Kbd>
              打开
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              关闭
            </span>
            <span className="ml-auto hidden sm:inline">
              {hasItems ? `${flat.length} 项结果` : ''}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** 键帽样式的小包装（只在本文件用，故不提升到 ui/） */
function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-line',
        'bg-sunken px-1 font-sans text-[10px] leading-none text-muted',
      )}
    >
      {children}
    </kbd>
  )
}
