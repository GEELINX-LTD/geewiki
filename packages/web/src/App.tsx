import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BookText,
  GitBranch,
  LogIn,
  Menu as MenuIcon,
  MonitorSmartphone,
  Puzzle,
  Search,
  UserRound,
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
import { CommandPalette } from './components/CommandPalette'
import { ThemeToggle } from './components/ThemeToggle'
import { SystemStatusDialog } from './components/SystemStatusDialog'
import { MAIN_CONTENT_ID } from './lib/domIds'
import { stripHashQuery } from './lib/hashAnchor'
import { recordRecentPage, visitedSlugFromSub } from './lib/commandPlan'
import { titleForRoute } from './lib/pageMeta'
import { visibleDests, type NavDest } from './lib/navPlan'
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, type ThemeChoice } from './lib/theme'
import { SlotOutlet } from './lib/slots'
import { useDocumentTitle } from './lib/useDocumentTitle'
import { AdminPage } from './pages/AdminPage'
import { AccountPage } from './pages/AccountPage'
import { DeniedPage } from './pages/DeniedPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { GraphPage } from './pages/GraphPage'
import { LoginPage } from './pages/LoginPage'
import { SetupPage } from './pages/SetupPage'
import { WikiPage } from './pages/WikiPage'
import { logout, useAuth } from './lib/authStore'
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
 * 命令面板快捷键：`⌘K` / `Ctrl+K` 与 `/`。
 *
 * 两个**必须处理**的细节（否则会惹恼用户）：
 *  1. **在输入框/文本域里不得劫持按键**——用户正打字时按 `/` 就是在输入斜杠，
 *     绝不能把焦点抢走。判据是 `event.target` 是否为可编辑元素。
 *     （`⌘K` 不在此限：带修饰键的组合键在任何地方都应可用，这也是业界惯例。）
 *  2. 已按下修饰键时不要重复触发（`⌘K` 命中后不再走 `/` 分支）。
 *
 * 行为变更（本批）：以前是"跳到列表页再把焦点送进搜索框"，现在**直接打开命令面板**。
 * 理由是搜索框只能检索**当前列表**，而 ⌘K 的预期是"跳转到任意页面、或执行任意动作"——
 * 列表页那个输入框仍保留（在列表内部即时过滤），两者职责不同、并列存在。
 */
function useCommandPaletteShortcut(onOpen: () => void): void {
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
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      if (isCmdK) {
        e.preventDefault()
        onOpen()
        return
      }
      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
      if (!isSlash) return
      if (isEditable(e.target)) return
      e.preventDefault()
      onOpen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpen])
}

/**
 * 主导航项。
 *
 * `requires`（P2-M5）是**该入口需要的能力**，缺省 = 对所有访问者可见（含未登录）。
 * 判据与过滤逻辑在 `lib/navPlan.ts`，这里只是数据 —— 顶栏的三处渲染点与命令面板
 * **共用同一个 `visibleDests()`**，避免出现"桌面看不到、窄屏却看得到"这类
 * 只在某个宽度下复现的漂移。
 */
interface NavItem extends NavDest {
  icon: ReactNode
}

const WIKI_ITEM: NavItem = { id: 'wiki', label: '知识库', icon: <BookText className="size-4" /> }
/**
 * 运维/开发台面：收进「管理 ▾」，不与产品主入口平级。
 *
 * **两项都要求 `administer`**（= 组织角色 owner / admin，见
 * `packages/plugin-auth/src/index.ts:457-461`）⇒ 普通成员与匿名访客**完全看不到
 * 这个下拉**，而不是看到一个置灰项。这是刻意的：置灰或加锁图标本身就在泄露
 * "这里有个你够不着的运维面"，而"无权的分区完全不出现"才是设计要的形态。
 *
 * ⚠️ 连带后果（有意为之）：「系统状态」对话框与这两项同处一个下拉，因此它
 * **也随之下沉为管理员可见**。它是运维台面（服务健康、DB 方言、表清单），
 * 与「运维台面」这个分组标签一致；若将来需要让所有人都能看到服务健康，
 * 正确做法是把它**移出这个分组**，而不是给它单开一个能力字段。
 */
const ADMIN_NAV: NavItem[] = [
  { id: 'plugins', label: '插件管理', icon: <Puzzle className="size-4" />, requires: 'administer' },
  { id: 'graph', label: '依赖图', icon: <GitBranch className="size-4" />, requires: 'administer' },
]
/**
 * 身份相关路由（P1）。它们**不进导航菜单** —— 由"需要登录"的实际动作把用户带到那里
 * （或顶栏的身份区），列在这里只是为了路由分派与文档标题。
 */
const AUTH_ROUTES = ['login', 'setup', 'denied', 'account'] as const

function isAuthRoute(id: string): boolean {
  return (AUTH_ROUTES as readonly string[]).includes(id)
}

export function App(): ReactNode {
  const route = useRoute()
  const root = route.split('/')[0] ?? 'wiki'
  const known = [WIKI_ITEM, ...ADMIN_NAV].some((t) => t.id === root) || isAuthRoute(root)
  /*
   * ★ P2：未知路由不再**静默回落**到知识库。
   *
   * 静默回落的坏处不是"少一个页面"，而是掩盖了越权访问与拼错路由：访问 `#/typo`
   * 会看到一个正常的知识库首页，用户永远不知道自己走错了；排障时也无法区分
   * "访问不到"与"不存在"。空路由（`#/`）仍按知识库处理 —— 那是产品的根入口。
   */
  const active = known ? root : route === '' ? 'wiki' : 'notfound'

  /** 路由级基线标题；详情页拿到页面数据后会覆盖成真实标题（见 WikiDetail） */
  useDocumentTitle(titleForRoute(route === '' ? 'wiki' : route))

  /** 统一 hash 跳转：规范化首尾斜杠，避免产生 '#/wiki/'（尾斜杠）或 '#/'（空路由）这类 URL */
  const nav = useCallback((id: string): void => {
    const clean = id.replace(/^\/+/, '').replace(/\/+$/, '')
    window.location.hash = clean ? `/${clean}` : '/wiki'
  }, [])

  /**
   * 命令面板的开关状态。提升到 App 层是因为**触发点有两个**：
   * 全局快捷键（⌘K / `/`）与顶栏的搜索按钮——后者原先只是"跳到列表页并聚焦搜索框"。
   */
  const [paletteOpen, setPaletteOpen] = useState(false)
  /**
   * 打开面板**之前**焦点在哪。用于关闭时归还焦点——本面板是受控对话框、没有
   * `Dialog.Trigger`，Radix 自己只能退回 body（见 CommandPalette 的 restoreFocusTo 注释）。
   */
  const paletteReturnFocus = useRef<HTMLElement | null>(null)
  const openPalette = useCallback(() => {
    paletteReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPaletteOpen(true)
  }, [])
  useCommandPaletteShortcut(openPalette)

  /**
   * 主题 epoch：palette 里的"切换外观"动作**绕过** `useTheme()` 直接读写 localStorage
   * （`readStoredTheme` / `storeTheme` / `applyTheme`）——因为 `ThemeToggle` 内部自持一份
   * `useTheme()` 状态，两个实例之间没有同步通道。
   * 改完 `key` 让 `ThemeToggle` 重新挂载，它就会重新读取当前值、图标不再滞后。
   * （不去改 `ThemeToggle`/`theme.ts`：前者不在本批授权范围，后者的存储键与
   *  `index.html` 的内联脚本共用、改动风险外溢。）
   */
  const [themeEpoch, setThemeEpoch] = useState(0)
  const toggleTheme = useCallback(() => {
    const next: ThemeChoice = resolveTheme(readStoredTheme()) === 'dark' ? 'light' : 'dark'
    storeTheme(next)
    applyTheme(next)
    setThemeEpoch((n) => n + 1)
  }, [])

  /**
   * 记录"最近访问"。只在**详情页**记（`visitedSlugFromSub` 用 `parseWikiRoute` 判断，
   * 保留段与 `/edit` 后缀都不算），这样"最近访问"里不会混进列表页/检索页/编辑页。
   */
  const wikiSub = route === 'wiki' ? '' : route.startsWith('wiki/') ? route.slice('wiki/'.length) : null
  useEffect(() => {
    if (wikiSub === null) return
    const slug = visitedSlugFromSub(wikiSub)
    if (slug !== null) recordRecentPage(slug)
  }, [wikiSub])

  /**
   * 系统状态对话框的开关。提升到这里（而非让 DialogTrigger 包住菜单项）是为了
   * 避开"菜单项卸载"与"对话框打开"的竞态，见 SystemStatusDialog 的注释。
   */
  const [statusOpen, setStatusOpen] = useState(false)

  /**
   * 登录态。**在 App 层订阅**（而不是只让登录页订阅）：顶栏的身份区需要它，
   * 且它承担"应用启动时问一次我是谁"的职责 —— 放在叶子组件里，
   * 未挂载那些组件时就不会发起检查，顶栏会一直显示成未登录。
   */
  const auth = useAuth()

  /**
   * 按能力过滤后的运维台面入口。**必须在 `auth` 之后算**（依赖 `auth.capabilities`）。
   *
   * 空数组 ⇒ 桌面端整个「管理 ▾」**不渲染**（不是渲染一个空下拉、也不是置灰）。
   * 加载中（`capabilities === null`）同样为空 —— 见 `lib/navPlan.ts` 里
   * 关于"失败关闭"的说明：宁可让管理员晚一次请求看到入口，也不让匿名访客先看到再收回。
   */
  const adminDests = visibleDests(ADMIN_NAV, auth.capabilities)

  let body: ReactNode
  if (active === 'wiki')
    body = (
      <WikiPage
        sub={route.slice('wiki'.length).replace(/^\/+/, '')}
        onNavigate={(path) => nav(`wiki/${path}`)}
      />
    )
  else if (active === 'plugins') body = <AdminPage />
  else if (active === 'login') body = <LoginPage />
  else if (active === 'setup') body = <SetupPage />
  else if (active === 'denied') body = <DeniedPage />
  else if (active === 'account') body = <AccountPage />
  else if (active === 'notfound') body = <NotFoundPage />
  else body = <GraphPage />

  const adminActive = adminDests.some((t) => t.id === active)

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
          <span className="text-wordmark leading-none font-bold tracking-[0.3px] text-white">GeeWiki</span>
          {/* 副标题在窄屏隐藏：空间不足时优先保留品牌与导航 */}
          <span className="ml-1 hidden text-2xs text-header-mute lg:inline">
            AI-Native 插件化知识库
          </span>
        </a>

        {/* 主导航（≥md 显示）。窄屏折叠进右侧的「菜单」下拉 */}
        <nav aria-label="主导航" className="hidden flex-1 items-center gap-1 md:flex">
          <NavTab item={WIKI_ITEM} active={active === WIKI_ITEM.id} onNavigate={nav} />

          {/*
            运维台面入口。**`adminDests` 为空时整个下拉不渲染** —— 这正是本次要修的
            缺陷："无权的「管理 ▾」仍会渲染"。空下拉比不渲染更坏：它在告诉访客
            "这里有个你进不去的运维面"。
          */}
          {adminDests.length > 0 && (
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
                  <span aria-hidden="true" className="text-3xs opacity-70">
                    ▾
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>运维台面</DropdownMenuLabel>
                <NavMenuItems
                  dests={adminDests}
                  active={active}
                  nav={nav}
                  onOpenStatus={() => setStatusOpen(true)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {/* 搜索入口：窄屏也保留（它是产品主功能），并提示快捷键。
              点击 = 打开命令面板（与 ⌘K 同一入口），而不是"跳到列表页再聚焦搜索框" */}
          <Button
            variant="ghost"
            size="sm"
            icon={<Search className="size-4" />}
            onClick={openPalette}
            className="hidden text-header-dim hover:bg-white/10 hover:text-white sm:inline-flex"
            aria-label="打开命令面板（快捷键 ⌘K 或 /）"
            aria-haspopup="dialog"
            title="搜索页面或执行命令（⌘K 或 /）"
          >
            搜索
          </Button>
          <ThemeToggle key={themeEpoch} />
          {/* 身份区（P1）：登录入口 / 当前身份与登出 */}
          <AuthArea auth={auth} active={active} nav={nav} />
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
              {/*
                与桌面端**同一判据**（同一个 `adminDests`）：无可见的运维目的地时，
                连分组标题与「系统状态」都不出现。窄屏曾经是这段清单的**复制粘贴**，
                两处各自演化正是"桌面看不到、窄屏却看得到"的来源 —— 现在两处都走
                `NavMenuItems` 这一个渲染函数。
              */}
              {adminDests.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>运维台面</DropdownMenuLabel>
                  <NavMenuItems
                    dests={adminDests}
                    active={active}
                    nav={nav}
                    onOpenStatus={() => setStatusOpen(true)}
                  />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 插件插槽：已激活插件可在此贡献界面（见 lib/slots.tsx 与 lib/pluginUi.ts） */}
        <SlotOutlet name="app-header" />
      </header>

      {/* 系统状态对话框（受控，见上面的 statusOpen 注释） */}
      <SystemStatusDialog open={statusOpen} onOpenChange={setStatusOpen} />

      {/* 命令面板（受控）：⌘K / Ctrl+K / `/` 或点击顶栏「搜索」打开 */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={nav}
        onToggleTheme={toggleTheme}
        restoreFocusTo={paletteReturnFocus}
      />

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

/**
 * 顶栏身份区（P1）。
 *
 * 三态，**每一态都给一个明确的下一步**：
 * - 已登录 ⇒ 显示身份 + 登出（`登出` 会先让服务端吊销会话，见 authStore.logout）；
 * - 未初始化 ⇒ 「初始化」（去 `#/setup`）。这与「登录」**不是同一个入口**：
 *   库里还没有账号时，登录页只会让人白试一遍（设计文档 §2.5 ⑥ 把 503 与 401 分开的
 *   产品理由就在这儿）。
 * - 未登录 ⇒ 「登录」。
 *
 * 加载中**渲染占位而不是空白**：否则顶栏会在首帧后突然多出一个按钮，
 * 造成布局跳动（CLS），而 `authState` 是很快的一次请求。
 */
function AuthArea({
  auth,
  active,
  nav,
}: {
  auth: ReturnType<typeof useAuth>
  /** 当前激活的路由 id（用于给「账号」项标记 `aria-current`） */
  active: string
  nav: (id: string) => void
}): ReactNode {
  if (auth.user !== null) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            icon={<UserRound className="size-4" />}
            className="text-header-dim hover:bg-white/10 hover:text-white"
            aria-label={`账号菜单（当前身份：${auth.user.displayName}）`}
          >
            <span className="hidden max-w-[12ch] truncate sm:inline">{auth.user.displayName}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{auth.user.email}</DropdownMenuLabel>
          {/*
            「账号」是绑定/解绑外部身份（SSO）的**唯一入口**：绑定要求"已登录的本地会话"
            （设计文档 §7.2 禁止按 email 自动绑定），所以它只能出现在已登录的身份区里。
          */}
          <DropdownMenuItem
            active={active === 'account'}
            onSelect={() => nav('account')}
          >
            <UserRound className="size-4" />
            账号
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void logout()}>登出</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  if (auth.loading) {
    // 占位保持宽度稳定；`aria-hidden` 是因为它没有语义（读屏不该播报一个空按钮）
    return <span aria-hidden="true" className="inline-block h-8 w-16 rounded-md bg-white/10" />
  }
  const needsSetup = auth.setupRequired === true
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<LogIn className="size-4" />}
      onClick={() => (window.location.hash = needsSetup ? '/setup' : '/login')}
      className="text-header-dim hover:bg-white/10 hover:text-white"
    >
      {needsSetup ? '初始化' : '登录'}
    </Button>
  )
}

/**
 * **导航菜单项的唯一渲染点**（桌面「管理 ▾」与窄屏「菜单」下拉共用）。
 *
 * 在此之前这段清单在 App 里出现两次（两处 `ADMIN_NAV.map` + 两处「系统状态」），
 * 改一处必须记得同步另一处 —— 这正是原缺陷里"三处重复渲染"的后两处。
 * 收成一个组件后，增删一个目的地或调整顺序都只改一个地方。
 *
 * `dests` 必须是**已经按能力过滤过**的列表（调用方用 `visibleDests()` 算好）。
 * 本组件**刻意不自己判断能力**：判据只该有一处（`lib/navPlan.ts`），
 * 否则又会退化成"某个渲染点漏判"。
 */
function NavMenuItems({
  dests,
  active,
  nav,
  onOpenStatus,
}: {
  dests: readonly NavItem[]
  active: string
  nav: (id: string) => void
  onOpenStatus: () => void
}): ReactNode {
  return (
    <>
      {dests.map((item) => (
        <DropdownMenuItem key={item.id} active={active === item.id} onSelect={() => nav(item.id)}>
          {item.icon}
          {item.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      {/* 系统状态：取代原先头部那个指向裸 JSON 的「● 服务健康」链接 */}
      <DropdownMenuItem onSelect={onOpenStatus}>
        <MonitorSmartphone className="size-4" aria-hidden="true" />
        系统状态
      </DropdownMenuItem>
    </>
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
