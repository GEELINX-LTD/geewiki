/**
 * 页内目录（TOC）—— 桌面端 sticky 侧栏 / 窄屏可折叠。
 *
 * 交互与无障碍决策（对齐 Docusaurus / VitePress 的成熟做法）：
 * - **只列 h2–h3**（Docusaurus 默认；VitePress 的 `outline.level` 默认值就是 2）；
 * - 桌面端（Tailwind `xl`，即 ≥1280px）在右侧 **sticky**，`top` 用顶栏高度 + 余量，
 *   与 `focus.css` 的 `scroll-margin-top` 同源（`--spacing-header`）；
 * - 窄屏改为 `<details>` 折叠（Docusaurus 在 ≤996px 也这样做）；
 * - 高亮用 `aria-current="location"`（"当前位置"的标准表达，屏幕阅读器会播报），
 *   视觉上同时用**左侧竖条 + 加粗**——不只靠颜色（WCAG 1.4.1）。
 *
 * 组件是**受控**的（`activeId` 由父组件传入）：同一页面会渲染两份 TOC（窄屏折叠 + 桌面侧栏），
 * 两份必须高亮同一项。把状态提到父级，`useActiveHeading` 就只跑一次
 * （两份各跑一个 IntersectionObserver 纯属浪费，还会互相竞争）。
 *
 * ## 链接地址为什么不是 `#<id>`
 * 本应用是 hash 路由，`href="#usage"` 会被路由解析器当成一个新路由，**点一下就跳走**。
 * 因此锚点编码进 hash 的查询串：`#/wiki/<slug>?a=<id>`（可分享、可刷新、可后退，
 * 且保持真链接语义）。详见 `lib/hashAnchor.ts`。
 */
import type { ReactNode } from 'react'
import { ListTree } from 'lucide-react'
import type { HeadingEntry } from '../lib/headingPlan'
import { buildHash } from '../lib/hashAnchor'
import { cn } from '../ui/cn'
import { focusRing } from '../ui/a11y'

/** 目录条目少于这个数就不显示（一两个小节的"目录"只是噪声） */
const MIN_ENTRIES = 2

interface TocNavProps {
  entries: readonly HeadingEntry[]
  activeId: string | null
  /** 当前页面路由（用于拼锚点 href），形如 `wiki/<slug>` */
  route: string
}

/** 目录列表本体（两种容器共用） */
function TocNav({ entries, activeId, route }: TocNavProps): ReactNode {
  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {entries.map((e) => {
        const active = e.id === activeId
        return (
          <li key={e.id} className={cn(e.level === 3 && 'pl-3')}>
            <a
              href={buildHash(route, e.id)}
              aria-current={active ? 'location' : undefined}
              className={cn(
                'block border-l-2 py-1 pr-2 pl-2.5 leading-snug transition-colors duration-150',
                e.level === 3 ? 'text-xs' : 'text-[13px]',
                active
                  ? 'border-accent font-semibold text-accent'
                  : 'border-line text-muted hover:border-line-strong hover:text-ink',
                focusRing,
              )}
            >
              {e.text}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

export function TableOfContents({
  entries,
  activeId,
  route,
  variant,
}: {
  entries: readonly HeadingEntry[]
  activeId: string | null
  route: string
  /** `inline` = 正文上方的可折叠块（窄屏用）；`sidebar` = 右侧 sticky 栏（宽屏用） */
  variant: 'inline' | 'sidebar'
}): ReactNode {
  if (entries.length < MIN_ENTRIES) return null

  if (variant === 'inline') {
    return (
      <details className="rounded-lg border border-line bg-surface xl:hidden" data-gw-no-toc>
        <summary
          className={cn(
            'flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium text-ink',
            focusRing,
          )}
        >
          <ListTree className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
          页内目录（{entries.length} 节）
        </summary>
        <nav aria-label="页内目录" className="border-t border-line px-2 py-2">
          <TocNav entries={entries} activeId={activeId} route={route} />
        </nav>
      </details>
    )
  }

  return (
    <aside className="hidden xl:block" data-gw-no-toc>
      <nav
        aria-label="页内目录"
        className="sticky top-[calc(var(--spacing-header)+16px)] max-h-[calc(100vh-var(--spacing-header)-32px)] overflow-y-auto"
      >
        <p className="mt-0 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">本页目录</p>
        <TocNav entries={entries} activeId={activeId} route={route} />
      </nav>
    </aside>
  )
}
