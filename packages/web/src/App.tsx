import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BookText,
  GitBranch,
  LogIn,
  Menu as MenuIcon,
  MonitorSmartphone,
  Puzzle,
  ScrollText,
  Search,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react'
import { Button } from './ui/Button'
import { ErrorState, SkeletonTable } from './ui'
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
import { parseWikiRoute } from './lib/wikiRoute'
import { recordRecentPage, visitedSlugFromSub } from './lib/commandPlan'
import { titleForRoute } from './lib/pageMeta'
import { visibleDests, type NavDest } from './lib/navPlan'
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, type ThemeChoice } from './lib/theme'
import { SlotOutlet } from './lib/slots'
import { useDocumentTitle } from './lib/useDocumentTitle'
import { AdminPage } from './pages/AdminPage'
import { AccessPage } from './pages/AccessPage'
import { OpsPage } from './pages/OpsPage'
import { OrgPage } from './pages/OrgPage'
import { AccountPage } from './pages/AccountPage'
import { DeniedPage } from './pages/DeniedPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { LoginPage } from './pages/LoginPage'
import { SetupPage } from './pages/SetupPage'
import { WikiPage } from './pages/WikiPage'
import { logout, refreshCapabilitiesIfVisible, useAuth } from './lib/authStore'
import { cn } from './ui/cn'

/**
 * 依赖图页面**懒加载**（本批 T7）。
 *
 * 为什么必须懒：`pages/GraphPage.tsx` 静态 import 了 `@xyflow/react`（React Flow 全家桶），
 * 静态 import 会把它打进**主包** —— 于是每一个匿名读者（只想看文档）也要先下载这一大块
 * 与管理台页面无关的代码。改为动态 `import()` 后它成为独立 chunk，只有真的进
 * `#/graph` 时才拉取。
 *
 * 与 `components/MarkdownEditorLazy.tsx` 同一套形态：`lazy` + `Suspense` 骨架 +
 * 最小错误边界（chunk 取不到时给 `ErrorState`，而不是白屏）。
 */
const LazyGraphPage = lazy(() => import('./pages/GraphPage').then((m) => ({ default: m.GraphPage })))

/**
 * 依赖图懒加载的**最小错误边界**：chunk 404（离线 / 部署漏拷 assets）时 `React.lazy`
 * 会抛错，接不住就是整页白屏 —— 而这是一个运维台面页面，不该让读者因此失去整个应用。
 * 只在 `getDerivedStateFromError` 里切一条路，与 `MarkdownEditorLazy` 的边界同款。
 */
class GraphBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  override state = { broken: false }

  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true }
  }

  override componentDidCatch(error: Error): void {
    console.warn('[geewiki-graph] 依赖图页面加载失败：', error)
  }

  override render(): ReactNode {
    if (!this.state.broken) return this.props.children
    return (
      <ErrorState
        title="依赖图加载失败"
        hint="页面资源可能没有取到。刷新页面可重试；若一直失败，请联系管理员。"
      />
    )
  }
}

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
 * 本次 hash 的**查询串**（`?` 之后的部分，无则空串），随 `hashchange` 更新。
 *
 * 为什么需要它：`useRoute` 返回的路径是**已剥掉查询串**的，于是"路径不变、只有查询串变"
 * 的那种导航（`#/wiki/new?create=home` → `#/wiki/new`）不会引发任何重渲染 ——
 * 组件在渲染期读 `window.location.hash` 拿到的值就永远停在第一次渲染时的那一刻。
 * 实测症状：从创建主页入口离开到普通新建页，标题与预填 slug 仍是"创建主页"。
 *
 * 与 `useRoute` 并列成两个 `useState`（而不是合成一个对象或 `useSyncExternalStore`）：
 * 钩子名与调用顺序都不变，`useEffect` 依赖数组也保持 `[]` ——
 * 本仓库的 `authCacheInvalidation.test.ts` 会**按源码断言"不得出现 setInterval"**
 * 之类的接线特征，合成快照最容易踩到那类守卫；两个独立 state 是最小改动。
 */
function useRouteQuery(): string {
  const [query, setQuery] = useState(() => hashQueryOf(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setQuery(hashQueryOf(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return query
}

/** 取 hash 里 `?` 之后的部分（含 `?`，便于直接交给解析器）；无查询串返回空串 */
function hashQueryOf(hash: string): string {
  const q = hash.indexOf('?')
  return q === -1 ? '' : hash.slice(q)
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
  /*
   * 审计与运维（P4）。能力键用既有的 `administer`（`AuthCapabilities` 只有
   * editContent / administer / manageVisibility 三个），不新开字段 —— 它对应的
   * 后端端点全部标了 `access: 'admin'`，判据与其余运维入口一致。
   *
   * ⚠️ 本注释刻意**不写出那个键的完整字面量**：`packages/web/test/navPlan.test.ts`
   * 用文本正则统计"声明了几个能力"，注释里出现同样的字面量会让它多数出一个。
   */
  { id: 'audit', label: '审计与运维', icon: <ScrollText className="size-4" />, requires: 'administer' },
  /*
   * 组织与邀请管理（P5-B M4/M5）。判据与其余运维入口一致（`administer`）：
   * 成员、用户组、邀请这 12 个端点里除 `GET /api/org` 外全部要 `admin+`
   * （见 `packages/plugin-org/src/index.ts:277`），所以它属于「管理 ▾」而不是
   * 与「知识库」平级的产品入口（对比 `GOVERN_NAV` 的 `manageVisibility`，那一个
   * 普通成员也有）。这里的 `id` 就是路由首段：`#/org`。
   */
  { id: 'org', label: '组织', icon: <Users className="size-4" />, requires: 'administer' },
]
/**
 * 权限治理入口（M1）。
 *
 * **刻意独立于 `ADMIN_NAV`，也不与「管理 ▾」合并**，两个理由：
 *
 * 1. **判据不同**：运维台面要 `administer`（= owner / admin），而改档位与授权是
 *    "对自己有编辑权的条目"就能做的事 —— 组织角色 `member` 也**有**这个能力
 *    （`packages/plugin-auth/src/index.ts` 的 `capabilitiesOf`：`manageVisibility`
 *    对 admin 与 member 都为真）。把它塞进只对 admin 开放的「管理 ▾」，等于让
 *    最常用它的人看不到入口。
 * 2. **入口语义不同**：这一项**不是**运维台面，而是产品功能（每一条内容都可能有
 *    自己的档位与授权）。混进运维下拉会让人以为它只有管理员才用得上。
 *
 * 与其它入口**同一套判据**：能力为 `null`（首帧）× 无能力 ⇒ 整个入口不渲染
 * （`visibleDests()` 的失败关闭，见 `lib/navPlan.ts`），而不是置灰。
 *
 * ⚠️ `packages/web/test/navPlan.test.ts` 从 `App.tsx` 抽取 `ADMIN_NAV` 的数组体并统计
 * "条目数 == 声明能力的次数"。本数组**必须声明在这个数组之外**（放在它之前或之后的
 * 行首 `]` 之外），否则会被那段正则吞进去，两个计数都会错位。
 */
const GOVERN_NAV: NavItem[] = [
  { id: 'access', label: '权限治理', icon: <ShieldCheck className="size-4" />, requires: 'manageVisibility' },
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
  /*
   * 查询串单独成为**响应式**值（见 `useRouteQuery`）：`#/wiki/new?create=home` 这类
   * "路径不变、只有查询串变"的导航不会改变 `route`，若组件在渲染期直接读 `window.location.hash`，
   * 拿到的就永远是第一次渲染时的值（实测症状：从创建主页入口走到普通新建页，标题与预填 slug 不变）。
   */
  const routeQuery = useRouteQuery()
  const root = route.split('/')[0] ?? 'wiki'
  const known =
    [WIKI_ITEM, ...ADMIN_NAV, ...GOVERN_NAV].some((t) => t.id === root) || isAuthRoute(root)
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
   * 角色能力**随角色变化重取**（本批 T5 的触发点①）。
   *
   * 缺陷：`capabilities` 只在 `loadAuth()`（首帧 / 登录登出）时写过一次，于是**标签页一直开着**
   * 的用户被管理员降级后，运维入口仍留在顶栏 —— 点进去必然失败（服务端仍会兜底拒绝，
   * 不是越权，但对用户是"看得见、点不动"）。
   *
   * 为什么是 `visibilitychange` 而不是定时器：用户回到这个标签页时，正是"我在别处可能被改了
   * 角色"这件事最可能已经发生的时刻；定时轮询要为一次几乎不发生的事件持续发请求，
   * 而这条零成本（切回来才问一次，且 `refreshCapabilitiesIfVisible` 内部还有可见性判据）。
   *
   * ⚠️ 本 effect **刻意放在 `ADMIN_NAV` 数组之外**（数组内的 `id:` 字面量被
   * `test/navPlan.test.ts` 计数，写进去会让"条目数 == 能力声明数"错位）。
   */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refreshCapabilitiesIfVisible()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  /**
   * 按能力过滤后的运维台面入口。**必须在 `auth` 之后算**（依赖 `auth.capabilities`）。
   *
   * 空数组 ⇒ 桌面端整个「管理 ▾」**不渲染**（不是渲染一个空下拉、也不是置灰）。
   * 加载中（`capabilities === null`）同样为空 —— 见 `lib/navPlan.ts` 里
   * 关于"失败关闭"的说明：宁可让管理员晚一次请求看到入口，也不让匿名访客先看到再收回。
   */
  const adminDests = visibleDests(ADMIN_NAV, auth.capabilities)

  /**
   * 权限治理入口（同一判据、同一来源）。空数组 ⇒ 桌面端不渲染任何治理标签、
   * 窄屏菜单里也不出现这一组（同样不是置灰）。
   */
  const governDests = visibleDests(GOVERN_NAV, auth.capabilities)

  /*
   * 外壳宽度分档（**按内容类型**，不是按页面）：
   *   - 阅读态（知识库详情/主页/版本预览）：保持 1280px。长文的可读性由正文的
   *     `--spacing-measure`（中文 35~45 字/行）把关，外壳再宽只是徒增两侧空白。
   *   - 扫描态（列表/检索/问答/管理台面）：放宽到 `--spacing-wide`（1552px）。这些页面是
   *     表格与多列信息，宽度直接等于"一屏能看多少"。
   * 2026-09-12 实测（修复前）：1920 视口下 `main` 恒为 1280px，左右各 320px 空白，
   * 列表表格只占视口 50.6%。
   *
   * 用内联 `style.maxWidth` 而不是 `max-w-[var(--spacing-wide)]`：Tailwind 对
   * "任意值里再嵌 var()" 的写法不生成工具类（实测产物 CSS 命中 0 次），静默失效比写死更危险。
   * `data-shell` 属性同时给出 CSS 侧的稳定挂钩（见 styles.css），供后续按档位加规则。
   */
  /*
   * ⚠️ 变量名不能叫 `wikiSub`：上面（记录"最近访问"那段）已有同名变量，
   * 同作用域重复声明会让整包 `tsc` 报 TS2451、**类型检查直接不过**。
   */
  const wikiSubForShell = route.slice('wiki'.length).replace(/^\/+/, '')
  /*
   * 分档的判据是**解析出来的路由种类**，不是路径前缀的 `startsWith`：
   * `searchfoo`、`ask-me` 都是**合法 slug**（首段只要不是保留段就当页面），
   * 用前缀匹配会把它们误分档成扫描态（正文被拉到 1552px 外壳里）。
   * `parseWikiRoute` 是同一份纯函数，路由怎么解析、外壳就怎么分档，不存在第二种口径。
   *
   * ⚠️ 空子路径（`#/`、`#/wiki`）是**主页面**，它渲染的是一篇长文 ⇒ **阅读态**，
   * 与详情页、版本预览同档（`kind === 'home'` 不在下面的扫描态集合里）。
   * 此前把它也算进 wide，导致主页在 1920 视口下拿到 1552px 外壳，而正文卡片只有 630px
   * ⇒ 左右各空出近一半，正是"两边空得太多"最刺眼的一处。
   * 扫描态只留真正列扫描型内容的三个去处：列表、检索、问答。
   */
  const shellRoute = parseWikiRoute(wikiSubForShell)
  const wideShell =
    active !== 'wiki' ||
    shellRoute.kind === 'list' ||
    shellRoute.kind === 'search' ||
    shellRoute.kind === 'ask'
  /** 与 tokens.css 的 `--spacing-wide` 同值。写具体值而不是 var()：`@theme` 里的自定义
   *  尺寸变量只在被工具类引用时才输出到 `:root`，内联 var() 引用可能落空（静默失效）。 */
  const WIDE_MAX_WIDTH = '1552px'

  let body: ReactNode
  if (active === 'wiki')
    body = (
      <WikiPage
        sub={route.slice('wiki'.length).replace(/^\/+/, '')}
        /* 查询串**原样**交给 WikiPage：它自己决定哪个参数对它有意义（如 `?create=home`） */
        query={routeQuery}
        onNavigate={(path) => nav(`wiki/${path}`)}
      />
    )
  else if (active === 'access')
    // 治理路由是**独立首段**（`#/access` 与 `#/access/<slug>`）：塞进 `wiki/` 会被
    // `parseWikiRoute` 当成 slug 的一部分，见 lib/accessPlan.ts 的 parseAccessRoute
    body = <AccessPage sub={route.slice('access'.length).replace(/^\/+/, '')} onNavigate={nav} />
  else if (active === 'plugins') body = <AdminPage />
  else if (active === 'audit') body = <OpsPage />
  // 组织与邀请管理（P5-B M4/M5）：独立首段 `#/org`，页面自己按 `administer` 门控
  else if (active === 'org') body = <OrgPage onNavigate={nav} />
  else if (active === 'login') body = <LoginPage />
  else if (active === 'setup') body = <SetupPage />
  else if (active === 'denied') body = <DeniedPage />
  else if (active === 'account') body = <AccountPage />
  else if (active === 'notfound') body = <NotFoundPage />
  else
    body = (
      /*
        依赖图（懒加载）：`Suspense` 的兜底用骨架表而不是"加载中…"——
        `SkeletonTable` 与本应用其它加载态**同一套反馈**，且能占住相近的高度，减少布局跳动。
        外层错误边界负责"chunk 没取到"这条路径（见 GraphBoundary）。
      */
      <GraphBoundary>
        <Suspense fallback={<SkeletonTable rows={6} />}>
          <LazyGraphPage />
        </Suspense>
      </GraphBoundary>
    )

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
        </a>

        {/* 主导航（≥md 显示）。窄屏折叠进右侧的「菜单」下拉 */}
        <nav aria-label="主导航" className="hidden flex-1 items-center gap-1 md:flex">
          <NavTab item={WIKI_ITEM} active={active === WIKI_ITEM.id} onNavigate={nav} />

          {/*
            权限治理入口（M1）：与「知识库」平级的**产品入口**，不是运维台面 ——
            判据是 manageVisibility（member 也有），见 GOVERN_NAV 的注释。
            与「管理 ▾」同一个失败关闭策略：无能力 ⇒ 一个标签都不渲染。
          */}
          {governDests.map((item) => (
            <NavTab key={item.id} item={item} active={active === item.id} onNavigate={nav} />
          ))}

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
                权限治理（窄屏）。**刻意不复用 `NavMenuItems`** —— 那个渲染函数会顺带
                附挂「系统状态」（运维台面的东西），挂在这里会让普通成员看到一个服务健康
                入口。两处渲染的是同一个 `governDests`，所以判据不会分叉。
              */}
              {governDests.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>权限治理</DropdownMenuLabel>
                  {governDests.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      active={active === item.id}
                      onSelect={() => nav(item.id)}
                    >
                      {item.icon}
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
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
        data-shell={wideShell ? 'wide' : 'read'}
        style={wideShell ? { maxWidth: WIDE_MAX_WIDTH } : undefined}
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
