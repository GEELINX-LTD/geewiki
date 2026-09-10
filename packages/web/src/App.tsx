import { useEffect, useState, type ReactNode } from 'react'
import {
  BookText,
  GitBranch,
  Menu as MenuIcon,
  MonitorSmartphone,
  Puzzle,
  Search,
} from 'lucide-react'
import { Button } from './ui/Button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './ui/DropdownMenu'
import { focusRing } from './ui/a11y'
import { ThemeToggle } from './components/ThemeToggle'
import { SystemStatusDialog } from './components/SystemStatusDialog'
import { MAIN_CONTENT_ID, SEARCH_INPUT_ID } from './lib/domIds'
import { stripHashQuery } from './lib/hashAnchor'
import { titleForRoute } from './lib/pageMeta'
import { SlotOutlet } from './lib/slots'
import { useDocumentTitle } from './lib/useDocumentTitle'
import { AdminPage } from './pages/AdminPage'
import { GraphPage } from './pages/GraphPage'
import { WikiPage } from './pages/WikiPage'
import { cn } from './ui/cn'

/**
 * 简易 hash 路由：location.hash = '#/wiki/getting-started' → route = 'wiki/getting-started'
 *
 * **必须剥掉 hash 内的查询串**：页内锚点编码为 `#/wiki/foo?a=usage`（原因见
 * `lib/hashAnchor.ts`——本应用是 hash 路由，裸 `#section` 会被当成一个新路由）。
 * 若这里不剥，`wiki/foo?a=usage` 会被解析成"slug 叫 `foo?a=usage` 的页面"，
 * 点一下目录就跳到不存在的页面。
 */
function useRoute(): string {
  const [route, setRoute] = useState(() => stripHashQuery(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(stripHashQuery(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

/**
 * 全局搜索快捷键：`⌘K` / `Ctrl+K` 与 `/`。
 *
 * 两个**必须处理**的细节（否则会惹恼用户）：
 *  1. **在输入框/文本域里不得劫持按键**——用户正打字时按 `/` 就是在输入斜杠，
 *     绝不能把焦点抢走。判据是 `event.target` 是否为可编辑元素。
 *  2. 已按下修饰键时不要重复触发（`⌘K` 命中后不再走 `/` 分支）。
 *
 * 行为：跳转到知识库列表（`#/wiki/list`）并把焦点落到搜索框。
 * 之所以先跳转再聚焦：搜索框只存在于列表页，而快捷键是全局的。
 */
function useSearchShortcut(nav: (id: string) => void): void {
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      )
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isEditable(e.target)) return
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
      if (!isCmdK && !isSlash) return
      e.preventDefault()
      nav('wiki/list')
      // 等路由渲染出列表页与搜索框后再聚焦（两帧足够；用 rAF 避免与 React 提交赛跑）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.getElementById(SEARCH_INPUT_ID)?.focus()
        })
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [nav])
}

/** 主导航项（产品主入口） */
interface NavItem {
  id: string
  label: string
  icon: ReactNode
}

const WIKI_ITEM: NavItem = { id: 'wiki', label: '知识库', icon: <BookText className="size-4" /> }
/** 运维/开发台面：收进「管理 ▾」，不与产品主入口平级 */
const ADMIN_NAV: NavItem[] = [
  { id: 'plugins', label: '插件管理', icon: <Puzzle className="size-4" /> },
  { id: 'graph', label: '依赖图', icon: <GitBranch className="size-4" /> },
]

export function App(): ReactNode {
  const route = useRoute()
  const root = route.split('/')[0] ?? 'wiki'
  const known = [WIKI_ITEM, ...ADMIN_NAV].some((t) => t.id === root)
  const active = known ? root : 'wiki'

  /** 路由级基线标题；详情页拿到页面数据后会覆盖成真实标题（见 WikiDetail） */
  useDocumentTitle(titleForRoute(route === '' ? 'wiki' : route))

  /** 统一 hash 跳转：规范化首尾斜杠，避免产生 '#/wiki/'（尾斜杠）或 '#/'（空路由）这类 URL */
  const nav = (id: string): void => {
    const clean = id.replace(/^\/+/, '').replace(/\/+$/, '')
    window.location.hash = clean ? `/${clean}` : '/wiki'
  }

  useSearchShortcut(nav)

  /**
   * 系统状态对话框的开关。提升到这里（而非让 DialogTrigger 包住菜单项）是为了
   * 避开"菜单项卸载"与"对话框打开"的竞态，见 SystemStatusDialog 的注释。
   */
  const [statusOpen, setStatusOpen] = useState(false)

  let body: ReactNode
  if (active === 'wiki')
    body = (
      <WikiPage
        sub={route.slice('wiki'.length).replace(/^\/+/, '')}
        onNavigate={(path) => nav(`wiki/${path}`)}
      />
    )
  else if (active === 'plugins') body = <AdminPage />
  else body = <GraphPage />

  const adminActive = ADMIN_NAV.some((t) => t.id === active)

  return (
    <div className="flex min-h-full flex-col bg-bg text-ink">
      {/*
        「跳到主内容」：键盘用户 Tab 的第一站。默认视觉隐藏（sr-only），
        聚焦时显形——这是"既不占版面、又必须存在"的标准做法（WCAG 2.4.1 Bypass Blocks）。
      */}
      <a
        href={`#${MAIN_CONTENT_ID}`}
        className={cn(
          'sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[var(--z-toast)]',
          'focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg',
          focusRing,
        )}
      >
        跳到主内容
      </a>

      <header
        className={cn(
          // 顶栏在两种主题下都保持深色（产品外壳的既有观感），故用 --color-header 系列
          'sticky top-0 z-[var(--z-sticky)] flex h-[var(--spacing-header)] items-center',
          'gap-3 bg-header px-[var(--spacing-gutter)] text-header-ink',
          'shadow-[0_1px_4px_rgb(0_0_0/18%)] sm:gap-6',
        )}
      >
        {/* 品牌：可点回首页。用 <a href="#/wiki"> 而非带 onClick 的 div——
            链接有原生语义（可中键新开、可被屏幕阅读器识别为链接） */}
        <a
          href="#/wiki"
          className={cn(
            // py-0.5 让点击区达到 24px 高（WCAG 2.5.8 触控目标下限）：
            // 品牌链接是独立链接、不在句子里，不适用"内联目标"豁免
            'flex shrink-0 items-baseline gap-2 rounded-sm py-0.5 no-underline',
            focusRing,
          )}
        >
          <span aria-hidden="true" className="self-center text-accent">
            <BookText className="size-5" />
          </span>
          <span className="text-[19px] leading-none font-bold tracking-[0.3px] text-white">GeeWiki</span>
          {/* 副标题在窄屏隐藏：空间不足时优先保留品牌与导航 */}
          <span className="ml-1 hidden text-[11px] text-header-mute lg:inline">
            AI-Native 插件化知识库
          </span>
        </a>

        {/* 主导航（≥md 显示）。窄屏折叠进右侧的「菜单」下拉 */}
        <nav aria-label="主导航" className="hidden flex-1 items-center gap-1 md:flex">
          <NavTab item={WIKI_ITEM} active={active === WIKI_ITEM.id} onNavigate={nav} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-4 text-sm',
                  'transition-colors duration-150 ease-standard',
                  adminActive
                    ? 'bg-white/15 font-semibold text-white'
                    : 'text-header-dim hover:bg-white/10 hover:text-white',
                  focusRing,
                )}
              >
                <MonitorSmartphone className="size-4" aria-hidden="true" />
                管理
                <span aria-hidden="true" className="text-[10px] opacity-70">
                  ▾
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>运维台面</DropdownMenuLabel>
              {ADMIN_NAV.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  active={active === item.id}
                  onSelect={() => nav(item.id)}
                >
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {/* 系统状态：取代原先头部那个指向裸 JSON 的「● 服务健康」链接 */}
              <DropdownMenuItem onSelect={() => setStatusOpen(true)}>
                <MonitorSmartphone className="size-4" aria-hidden="true" />
                系统状态
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {/* 搜索入口：窄屏也保留（它是产品主功能），并提示快捷键 */}
          <Button
            variant="ghost"
            size="sm"
            icon={<Search className="size-4" />}
            onClick={() => nav('wiki/list')}
            className="hidden text-header-dim hover:bg-white/10 hover:text-white sm:inline-flex"
            aria-label="搜索知识库（快捷键 ⌘K 或 /）"
            title="搜索知识库（⌘K 或 /）"
          >
            搜索
          </Button>
          <ThemeToggle />
          {/* 窄屏导航降级：把全部目的地收进一个菜单 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<MenuIcon className="size-4" />}
                aria-label="打开导航菜单"
                className="text-header-dim hover:bg-white/10 hover:text-white md:hidden"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem active={active === WIKI_ITEM.id} onSelect={() => nav(WIKI_ITEM.id)}>
                {WIKI_ITEM.icon}
                {WIKI_ITEM.label}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>运维台面</DropdownMenuLabel>
              {ADMIN_NAV.map((item) => (
                <DropdownMenuItem key={item.id} active={active === item.id} onSelect={() => nav(item.id)}>
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setStatusOpen(true)}>
                <MonitorSmartphone className="size-4" aria-hidden="true" />
                系统状态
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 插件插槽：已激活插件可在此贡献界面（见 lib/slots.tsx 与 lib/pluginUi.ts） */}
        <SlotOutlet name="app-header" />
      </header>

      {/* 系统状态对话框（受控，见上面的 statusOpen 注释） */}
      <SystemStatusDialog open={statusOpen} onOpenChange={setStatusOpen} />

      {/*
        主内容区：`id="main"` 是「跳到主内容」的目标；`tabIndex={-1}` 让锚点跳转后
        焦点真正落到该区域（否则链接只是滚动，焦点仍在顶栏，键盘用户要继续 Tab 一串
        导航才能到内容——这正是 2.4.1 想解决的问题）。
      */}
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className={cn(
          'mx-auto w-full max-w-[1280px] flex-1 px-[var(--spacing-gutter)] py-[var(--spacing-gutter)]',
          // 程序化聚焦容器（跳转链接的落点）不画焦点环：它没有交互语义，
          // 画环反而让用户以为"这个区域可以操作"。focus-visible 不会因脚本聚焦而匹配。
          'focus:outline-none',
        )}
      >
        {body}
      </main>

      {/*
        页脚只作为 app-footer 插槽的宿主：没有插件贡献界面时整条**不占位**。
        保留 `app-footer` 这个类名，是因为该行为由 styles.css 里的
        `.app-footer:has(> .slot-outlet[data-count='0']:only-child){display:none}` 实现
        （legacy 层），在这里重复实现会分散这条规则的所有权。
      */}
      <footer className="app-footer">
        <SlotOutlet name="app-footer" />
      </footer>
    </div>
  )
}

/** 顶部导航标签（仅桌面宽度使用；窄屏走「菜单」下拉） */
function NavTab({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate: (id: string) => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(item.id)}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-4 text-sm',
        'transition-colors duration-150 ease-standard',
        active
          ? 'bg-white/15 font-semibold text-white'
          : 'text-header-dim hover:bg-white/10 hover:text-white',
        focusRing,
      )}
    >
      {item.icon}
      {item.label}
    </button>
  )
}
