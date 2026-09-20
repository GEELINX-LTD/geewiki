import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HOME_SLUG, isWikiHomeAlias, parseWikiRoute } from '../lib/wikiRoute'
import { homePageSlug, hasExplicitHome, isHomeAliasNow } from '../lib/homePlan'
import { invalidateHome, useHome } from '../lib/homeStore'
import { hashQueryOf } from '../lib/hashAnchor'
import { invalidatePages, usePages } from '../lib/pagesStore'
import { onContentChanged } from '../lib/contentEvents'
import { Sidebar, SidebarDrawer, wikiHref } from '../components/Sidebar'
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Eye, FileText, GripVertical, House, List as ListIcon, LogIn, Pencil, RefreshCw, RotateCcw, Save, Search, SearchX, ShieldCheck, Trash2 } from 'lucide-react'
/*
 * 相对/绝对时间的唯一真源（`lib/timePlan.ts`）：右栏「本页信息」与版本下拉共用同一套口径，
 * 避免"11小时前"与"2026/9/12 15:56:59"两种写法在同一个页面里各说各的。
 */
import { api, ApiError, uploadAttachment, type PageDetail, type PageSummary, type PageVisibility, type VersionMeta } from '../api'
import { ApplyAccessDialog } from '../components/access/ApplyAccessDialog'
import { BlockGrantsDialog } from '../components/access/BlockGrantsDialog'
import { PageAccessPanel } from '../components/access/PageAccessPanel'
import { refreshCapabilitiesIfVisible, useAuth } from '../lib/authStore'
import {
  NewPageAction,
  createParam,
  loginForEditPage,
  loginForNewPage,
  loginForWikiPath,
  newPageEntry,
  type NewPageEntry,
} from '../lib/newPageGate'
import {
  PREVIEW_ATTACHMENT_NOTE,
  PREVIEW_INVALID_TEXT,
  canRestoreVersion,
  parsePreviewParam,
  previewBarText,
  previewRoute,
  restoreConfirmBody,
  restoreDoneText,
  restoreErrorText,
  versionNumberOf,
} from '../lib/versionPlan'
import { MarkdownBody, useRenderedMarkdown } from '../components/MarkdownBody'
import { MarkdownEditorLazy } from '../components/MarkdownEditorLazy'
import { DEFAULT_EDITOR_MIN_HEIGHT } from '../lib/editorHeightPlan'
import { ArticleSummarySlotOutlet, EditorSlotOutlet, EditorToolbarSlotOutlet, Ext, type EditorHandle, type EditorToolbarSelection, useEditorSlot } from '../lib/slots'
import {
  ReadonlyHistoryButton,
  VersionBadge,
  VersionPicker,
} from '../components/VersionPicker'
import { VersionDiffDialog } from '../components/VersionDiffDialog'
import type { MarkdownEditorHandle } from '../components/MarkdownEditor'
import { ensureSlotLoaded } from '../lib/pluginUi'
import { SearchView } from '../components/SearchView'
import { TableOfContents } from '../components/TableOfContents'
import { PageLinks } from '../components/PageLinks'
import {
  EDITOR_PANE_LABEL_ID,
  FILTER_HINT_ID,
  FILTER_INPUT_ID,
  PREVIEW_PANE_LABEL_ID,
  SEARCH_INPUT_ID,
} from '../lib/domIds'
import {
  decideDraftRestore,
  draftKey,
  formatDraftAge,
  isDraftExpired,
  parseDraft,
  serializeDraft,
  type DraftRecord,
} from '../lib/draftPlan'
import { scrollToAnchor, settleHashAnchor } from '../lib/hashAnchor'
import { renderMarkdownBody } from '../lib/markdownRender'
import { looksProjected, projectForAudience, type PreviewAudience } from '../lib/gatedPreview'
import {
  charCount,
  hasErrors,
  isDirty,
  validatePageForm,
  type PageDraft,
  type PageFormErrors,
} from '../lib/pageFormPlan'
import { stripDuplicateLeadingTitle, titleForRoute } from '../lib/pageMeta'
import {
  buildBreadcrumb,
  buildNavTree,
  moveWithinSiblings,
  navOrderMap,
  navRows,
  type NavNode,
  type NavRow,
  hasSeparatorBefore,
  intermediateCrumbCount,
  neighborsOf,
} from '../lib/navTree'
import { attachmentMarkdown } from '../lib/attachmentPlan'
import { registerEditorTools, type EditorCapability } from '../lib/editorTools'
import { describeError, errorLine } from '../lib/errorText'
import { resolveAreaState } from '../lib/areaState'
import { useSlowHint } from '../lib/useSlowHint'
import { checkQuery } from '../lib/searchPlan'
import { useActiveHeading } from '../lib/useActiveHeading'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useHashAnchor } from '../lib/useHashAnchor'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Skeleton,
  SkeletonTable,
  focusRing,
  useConfirm,
} from '../ui'
import { cn } from '../ui/cn'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

/** 要对比的历史版本。`author` 缺失 ⇒ 弹窗显示「未记录」（**不猜**、不写"匿名"）。 */
interface CompareTarget {
  id: number
  label: number
  savedAt: string
  author: { id: number; displayName: string | null } | null
}

/** 预览渲染的防抖时长（见 WikiEdit 的说明） */
const PREVIEW_DEBOUNCE_MS = 200

/**
 * ★ P3d：编辑器预览的**视角**。
 *
 * 为什么需要它：作者对自己的页有编辑权 ⇒ 他在预览里**看得到全部** gated 段落。
 * 于是"我预览里能看到"完全不能说明别人能不能看到，而块级可见性恰恰最容易判断错
 * （页面档位会向下压制块）。这个开关让作者能直接看到"匿名访客/组织成员看到的版本"。
 */
const PREVIEW_AUDIENCES: ReadonlyArray<{ id: PreviewAudience; label: string; hint: string }> = [
  { id: 'all', label: '我的视角', hint: '与你现在实际会看到的一致（含全部受限段落）' },
  { id: 'org', label: '组织成员', hint: '登录且属于本组织的人看到的版本' },
  { id: 'anonymous', label: '匿名访客', hint: '未登录访客看到的版本（受限段落会变成占位文案）' },
]

/** 草稿写入 localStorage 的防抖时长：比预览更长——写盘是"防丢失"，不必跟手 */
const DRAFT_DEBOUNCE_MS = 900

/* ===================== 写入口的门控（R11 建立，G1 补齐侧栏与编辑路由） ===================== */

/*
 * 三态判据（`newPageEntry`）与按钮实现（`NewPageAction`）都抽到 `lib/newPageGate.tsx` ——
 * **列表页页头、列表页空态、侧栏空态（含窄屏抽屉）、两个路由兜底（`#/wiki/new` 与
 * `#/wiki/<slug>/edit`）共用同一份**。放在一处是因为分散判定必然漂移：侧栏空态那个
 * 按钮就曾是漏网的一处（匿名点进去照样拿到完整编辑器，填完一屏、保存才 401）。
 */

/** hash 段里的查询串解码（用户可能在地址栏手输，容错返回原文） */
/**
 * Wiki 页：sub 为 hash 中 'wiki/' 之后的子路径。
 * 保留段：'' | 'list'（列表）、'new'（新建）、'search/<q>'（检索）、`<slug>[/edit]`（详情/编辑）。
 *
 * **`ask` 已不再是本组件的视图**（P8，决策 17）：`#/wiki/ask/<q>` 与 `wiki-ask` 插槽一起拆除，
 * AI 对话的唯一入口是常驻的 `app-dock`（渲染点在 `App.tsx` 的 `<main>` 之外，切页不重挂）。
 * 拆它的理由正是原先那段注释想解决而没解决好的问题：同一个功能有两条界面路径时，两条都会漂移
 * ——dock 与问答页各有一套输入、各自维护会话，"我刚问的那个去哪了"两处都答不上来。
 * `'ask'` 仍留在 `WIKI_RESERVED_FIRST_SEGMENTS` 里（理由见 lib/wikiRoute.ts）。
 *
 * 检索仍是宿主原生 UI（检索不是对话，没有"会话要去哪"的问题）。
 */
export function WikiPage(props: {
  sub: string
  /**
   * 本次 hash 的查询串（`?…`，无则空串），由 `App.tsx` 的 `useRouteQuery` 提供。
   * **必须是 props 而不是渲染期读 `window.location.hash`**：路径不变、只有查询串变时
   * 外层不会重渲染，直读会拿到陈旧值（`createHome` 就是靠它判定的，见下）。
   */
  query: string
  onNavigate: (path: string) => void
}): ReactNode {
  const { sub, query, onNavigate } = props
  // 路由解析抽到 lib/wikiRoute.ts（纯函数 + 单测）：它修掉了"分层 slug 打不开"
  // 这个只在真实浏览器里才暴露的缺陷（未编码路径被当成未知深层跳回列表、
  // 编码路径被双重编码成 404）。
  const route = parseWikiRoute(sub)
  /*
   * 站点主页是**哪一篇**（`lib/homeStore.ts` 的共享缓存 + `lib/homePlan.ts` 的纯换算）。
   *
   * ⚠️ `homeSlug === null` 的含义是"**现在没有可渲染的一篇**"（还没有结论，或者已设置
   * 但按当前主体的权限读不到），**不是**"没人设置过"——后者由 `homePageSlug()` 换算成
   * 约定 slug `home`。两者混为一谈会让"主页不给你看"被静默换成一篇文章。
   */
  const home = useHome()
  const homeSlug = homePageSlug(home.home)
  /*
   * 侧栏高亮用的 slug：详情/编辑路由就是它自己那一篇。其余路由不用这个量——
   * 主页（`kind === 'home'` 及其别名）高亮的是**当前主页那一篇**，由下面的主页分支
   * 直接用 `homeSlug` 传给 `WikiShell`（走 `activeSlug` 反而要多绕一次换算）。
   */
  const activeSlug = route.kind === 'detail' || route.kind === 'edit' ? route.slug : null
  const pages = usePages()
  /*
   * 登录态与能力（本批 R11）：`useAuth()` 必须在**任何 early return 之前**调用
   * （hook 顺序不能随分支改变，否则 React 抛 #310）。
   */
  const auth = useAuth()
  /** 「新建页面」的入口门控（见 `newPageEntry`）：列表页按钮与 `#/wiki/new` 路由共用同一判据 */
  const newEntry = newPageEntry(auth.user, auth.capabilities)
  /**
   * 主页设置的加载是否已经"慢到该给个说法"（与列表页的 `slowList` 同一套提示机制）。
   *
   * 必须在**任何 early return 之前**求值：hook 顺序不能随分支改变（React 抛 #310）。
   */
  const slowHome = useSlowHint(home.home === null && home.error === null)

  /*
   * `#/wiki/home` 是主页的**另一个写法**（当主页恰好是约定 slug `home` 那一篇时），
   * 不是第二个页面：改写成规范地址 `#/wiki`。
   *
   * 为什么重定向而不是两个 URL 渲染同一篇：两套 URL 会让"复制链接/浏览器历史/面包屑"
   * 出现两种形态，而且选中态、返回行为都会分叉。用 `replace: true`（改写历史而不是压栈）
   * 是为了不让"后退"把用户卡在 `/wiki/home` ↔ `/wiki` 之间来回弹。
   *
   * ⚠️ **必须带上查询串**（形如 `?v=68`，**含 `?`**）：漏掉它会把 `#/wiki/home?v=68`（历史快照预览）
   * 变成 `#/wiki` —— 页面照常显示最新版，用户却以为自己给的链接坏了。
   * 主页是默认落点，所以这个丢参数的机会比别的 slug 高得多（实测踩到过）。
   *
   * ⚠️⚠️ 光"带上查询串"还不够：这个查询串**必须从当前 URL 现读**，不能取 `props.query`
   * （它由另一个 `hashchange` 订阅者维护，可能比 `route` 落后一拍）。详见下面 effect 里的长注释 ——
   * 点击版本下拉时丢 `?v=` 的根因就在这里。
   *
   * ★ 主页批（2026-09-18）：判据不再只看 slug 叫什么，还要看**当前主页是不是这一篇**
   * （`isHomeAliasNow` → `isWikiHomeAlias(hash, homeSlug)`）。管理员把主页设成别的 slug 之后，
   * `home` 退化成一篇普通文章，`#/wiki/home` 必须照常打开它——它的地址仍然对外分享着。
   */
  /*
   * 别名**不止裸 slug 一种写法**：`#/wiki/home/`（尾斜杠）、`#/wiki/home?v=68`（历史快照）、
   * `#/wiki/home?a=usage`（页内锚点）都是主页。
   *
   * ⚠️ 实测缺陷（2026-09-14，3100 上跑的产物）：`#/wiki/home/`（**尾斜杠**）冷加载**永久空白**。
   * 逐形态实测（每个用例一个全新浏览器进程、首个导航就是目标地址）：
   *   `#/wiki`            → 正常
   *   `#/wiki/home`       → 正常（重写到 `#/wiki`）
   *   `#/wiki/home/`      → **空白**：`#root` 只剩 5903 字节空壳、`main` 文本长度 0
   *   `#/wiki/home?v=3`   → 正常（重写到 `#/wiki?v=3`，快照提示如实出现）
   *   `#/wiki/home?a=…`   → 正常（重写到 `#/wiki?a=…`）
   *
   * 根因是 effect 里的守卫写成**字符串全等**（`stripHashQuery(hash) !== 'wiki/home'`），
   * 而 `#/wiki/home/` 剥掉前缀后是 `wiki/home/`（带尾斜杠）⇒ 串不等 ⇒ 守卫 `return`，
   * 既不重写 URL；同时 `parseWikiRoute('home/')` 得到的是 `detail + home` ⇒ 组件不渲染主页
   * ⇒ 两者叠加就是"**既不重写、也不渲染**"的夹缝：页面停在空白，而且不像未知 slug 那样给
   * "页面不存在"提示 —— 这就是"打开别名地址没有内容"的真身。
   * 地址栏自动补全、从别处粘贴、IM 自动加链接都可能产出这条尾斜杠，命中概率不低。
   *
   * 判据因此不再拼字符串，而是**复用唯一的路由解析器** `isWikiHomeAlias`（见
   * `lib/wikiRoute.ts`：它剥掉 `#` 与查询串后，把 `wiki/` 之后的部分交给 `parseWikiRoute`
   * ——与 `App.tsx` 传 `sub` 同一个口径，解析成 `detail + home` 就是别名）。
   * 判据本身带单测（`test/wikiRoute.test.ts`），尾斜杠、`?…`、`homework`、`home/edit`
   * 这些形态都被钉死，不会再有第二套判定在组件里悄悄漂移。
   * ⚠️ 它收的是**整串 `window.location.hash`**（不是 `props.sub`），因为本 effect 要判的
   * 正是"**当前 URL** 是不是别名"，而不是"这次渲染的 route 是什么"。
   */
  useEffect(() => {
    /*
     * 依赖是 `[homeSlug]`（而不是 `[]`）：判据里多了一个**异步**得到的量 ——
     * "主页是哪一篇"。它在加载完成前后会从 `null` 变成具体 slug，那一刻必须重跑一次
     * （否则 `#/wiki/home` 这条别名会在"结论还没到"时被错过，之后再也没有机会改写）。
     * 依赖里**没有** `route` / `query`：判据完全是"**当前 URL** 是不是别名"
     * （直接读 `window.location.hash`），与这两个 state 谁先落地无关，因此没有需要跟着变的依赖。
     * 本函数是幂等的：规范地址下判据为 false，不做任何事，也不会与路由自身的 hash 变更互相激发。
     */
    /*
     * ⚠️ 查询串**从当前 URL 现读**，不用 `props.query`。这不是风格偏好，是本页最容易复发的缺陷：
     *
     * `route` 与 `query` 是 `App.tsx` 里**两个各自订阅 `hashchange` 的 state**。而 React 可能
     * 在**第一个订阅者**（`useRoute`）把 `route` 换掉之后就提交一次渲染、并在提交后跑本 effect
     * ——此时 `query` 还是上一个 URL 的值（实测：`#/wiki/home?v=68` 下 `props.query === ''`，
     * 于是 `replace('#/wiki' + '')` 把 `?v=68` 抹掉 ⇒ 预览态永远进不去，且不再重试）。
     *
     * 本 effect 是**URL 级规范化**，输入就该是 URL 本身：读当前 hash ⇒ 与触发本次渲染的地址同源，
     * 于是与"两个 state 谁先落地"彻底无关（顺序再变，改写结果都一样）。这也保证了深链
     * `#/wiki/home?v=68`、点击路径、以及"只有查询串变"的同文档导航三条入口行为一致。
     */
    const normalize = (): void => {
      const hash = window.location.hash
      /*
       * 再用同一判据复核一次：本函数可能在**又发生了一次导航之后**才被冲刷，
       * 那时当前 URL 已经不是别名了 —— 这种过期调用必须什么都不做，绝不能把新地址劫持回主页。
       * 复用解析器也保证了 `wiki/homework`、`wiki/home/edit`、`wiki/guide%2Fhome` 这类只是
       * "名字里带 home"的地址不会被误判；带上 `homeSlug` 则保证了主页换掉之后
       * `#/wiki/home` 不再被当成别名（那时它是一篇普通文章的真实地址）。
       */
      if (!isWikiHomeAlias(hash, homeSlug)) return
      /*
       * 查询串**必须原样带过去**（`?v=68` 是历史快照、`?a=usage` 是页内锚点）：漏掉它，
       * 用户拿到的是一条"看起来打开了、其实静默降级成最新版 + 无锚点"的地址。
       * 只搬 hash 内的查询串：本应用的查询串都写在 hash 里（`App.tsx` 的 `useRouteQuery` 用
       * `hashQueryOf` 取值），hash 外的 `location.search` 没有任何读取方，拼进来只会造出
       * `#/wiki?v=3?x=1` 这种畸形地址。
       */
      window.location.replace(`#/wiki${hashQueryOf(hash)}`)
    }
    // 挂载时先跑一次：**深链/刷新**（`#/wiki/home` 直接冷加载）走的是这条路。
    normalize()
    /*
     * 再订阅 `hashchange`：**文档内导航**（已经在 wiki 里，地址被改成 `#/wiki/home`）不会让
     * 本组件重新挂载，只靠挂载那一次会漏掉，地址停在别名。
     */
    window.addEventListener('hashchange', normalize)
    return () => window.removeEventListener('hashchange', normalize)
  }, [homeSlug])

  /*
   * 本次渲染要不要走「主页」分支。
   *
   * 两个入口：规范地址 `#/wiki`（`route.kind === 'home'`），以及**当主页正是约定那一篇时**
   * 的别名地址 `#/wiki/home…`（`kind === 'detail'` + slug 恰为 `home` + 它确实是当前主页）。
   *
   * ★ 别名也走同一个分支（而不是像以前那样 `return null`、等 effect 把地址改写掉）是**刻意的**：
   * 那种"先什么都不渲染"的写法正是 2026-09-14 那个永久空白缺陷的一半成因；而本批之后
   * `homeSlug` 是**异步**得到的，判据会在结论到达前后翻面 —— 那一刻的 `return null`
   * 就是一次货真价实的白屏。两个入口渲染同一个 `<WikiDetail>` 之后，URL 改写退化成纯粹的
   * 地址栏整理：改写失败、慢一拍、被拦截，用户看到的都还是正确的内容。
   */
  const homeAliasRoute = route.kind === 'detail' && route.slug === HOME_SLUG && isHomeAliasNow(home.home)
  const homeRoute = route.kind === 'home' || homeAliasRoute

  /*
   * ★「创建主页」= **`#/wiki/new?create=home`**（本轮修正）。
   *
   * 此前用的是 `#/wiki/home/new`，它有一个会伤到真实用户的缺陷：`home/new` 是**合法 slug**
   * （`SLUG_SEGMENT_RE` 允许，首段 `home` 不在保留段里），却同时被这里当成"创建主页"入口
   * ⇒ 前端路由先匹配就赢，把一个真实可建的页面从用户手里抢走：**建得出来、打不开**
   * （`#/wiki/home%2Fnew` 也救不回来 —— 解析器先整体解码再切分，两种写法归一成同一个 slug）。
   * 这正是 `lib/wikiRoute.ts:8-13` 与 `lib/slugRules.ts:32` 头注里记录过的同一类缺陷。
   *
   * 查询参数不在 slug 形状里，因此不占用任何标识，也无需改动前后端镜像的保留段集合
   * （动那个要同步 `packages/plugin-wiki/src/index.ts` 的校验，两处都有守卫测试钉住）。
   *
   * ⚠️ 查询串来自 **props**（`App.tsx` 的 `useRouteQuery`，随 `hashchange` 更新），
   * 不是渲染期读 `window.location.hash`：`#/wiki/new?create=home` → `#/wiki/new` 这种
   * "路径不变、只有查询串变"的导航不会让外层重渲染，直读会拿到陈旧值
   * （实测症状：离开创建主页入口后，普通新建页仍显示"创建主页"、slug 仍预填 `home`）。
   * 因此 `createHome` 还必须同时要求 `route.kind === 'new'`：查询串属于哪条路由由**路径**决定。
   */
  const create = createParam(query)
  /** 是否走「创建主页」语义：只在 `new` 路由上成立，其余路由下这个参数无意义（忽略） */
  const createHome = route.kind === 'new' && create === HOME_SLUG

  if (homeRoute) {
    /*
     * 主页 = **一篇文章**，复用详情页的阅读态能力（标题/正文/版本/权限入口/上下篇之外的一切），
     * 而不是"所有页面的管理表格"。列表页退居次要入口：`#/wiki/list` 保持原样，
     * 并由侧栏的「全部页面」链接抵达（此前唯一入口是命令面板，等于藏起来了）。
     *
     * ★ 主页批：这里渲染的是**服务端设置的**那一篇（`homeSlug`），不再写死约定 slug。
     * `homeSlug === null` 有两种来源，必须分开处理 —— 这正是 `SiteHome` 三态存在的理由：
     *   · 结论还没到（加载中 / 上次请求失败）⇒ 骨架屏 / 错误态，**绝不**先渲染约定 slug：
     *     若设置的其实是另一篇，那会先显示一篇错的再换掉（"闪一下换了东西"）；
     *   · 设置了，但当前主体读不到（`hidden`）⇒ 明确告知"主页不给你看"，
     *     同样**不**退回约定 slug —— 那等于把无权者静默送去另一篇文章，而他会以为
     *     那就是本站主页（真实情况可能是：主页设成了组织内页，而他是匿名访客）。
     */
    if (homeSlug === null) {
      const d = describeError(home.errorValue)
      let body: ReactNode
      if (home.home === null && home.error !== null) {
        body = (
          <ErrorState
            title={d.title}
            hint={d.hint}
            onRetry={d.retryable ? home.reload : undefined}
            retrying={home.loading}
          />
        )
      } else if (home.home === null) {
        body = (
          <LoadingState slow={slowHome}>
            <SkeletonTable rows={4} cols={1} />
          </LoadingState>
        )
      } else {
        body = (
          <EmptyState
            icon={<House className="size-8" />}
            title="主页当前不可访问"
            hint="本站的主页被设置成了某一篇文章，但你的账号读不到它。它可能尚未发布、只对特定范围开放，或者已经被删除。"
            action={
              <div className="flex flex-wrap items-center gap-2">
                {newEntry.kind === 'login' && (
                  <Button variant="primary" icon={<LogIn className="size-3.5" />} onClick={() => loginForWikiPath('/wiki')}>
                    去登录
                  </Button>
                )}
                <Button variant="secondary" onClick={() => onNavigate('list')}>
                  全部页面
                </Button>
                <Button variant="ghost" onClick={home.reload}>
                  重试
                </Button>
              </div>
            }
          />
        )
      }
      return (
        <WikiShell activeSlug={null} pages={pages} onNavigate={onNavigate}>
          <div className="page">{body}</div>
        </WikiShell>
      )
    }
    return (
      <WikiShell activeSlug={homeSlug} pages={pages} onNavigate={onNavigate}>
        <WikiDetail
          // `key` 用实际 slug：主页被换成另一篇时（同一会话里改了设置）必须**重挂载**，
          // 否则 `WikiDetail` 会把上一篇的正文/版本/目录原样展示在新 slug 的地址上
          key={homeSlug}
          slug={homeSlug}
          query={query}
          homeMode
          onEdit={() => onNavigate(`${homeSlug}/edit`)}
          onDeleted={() => onNavigate('list')}
          onNavigate={onNavigate}
        />
      </WikiShell>
    )
  }
  if (route.kind === 'list') {
    return (
      <WikiShell activeSlug={null} pages={pages} onNavigate={onNavigate}>
        <WikiList
          newEntry={newEntry}
          onOpen={(slug) => onNavigate(slug)}
          onNew={() => onNavigate('new')}
          onSearch={(q) => onNavigate(`search/${encodeURIComponent(q)}`)}
        />
      </WikiShell>
    )
  }
  if (route.kind === 'search') {
    return (
      <WikiShell activeSlug={null} pages={pages} onNavigate={onNavigate}>
        <SearchView
          key={route.q}
          query={route.q}
          onOpen={(slug) => onNavigate(slug)}
          onSearch={(next) => onNavigate(`search/${encodeURIComponent(next)}`)}
        />
      </WikiShell>
    )
  }
  if (route.kind === 'new') {

    /*
     * 路由级门控（本批 R11）—— 这一道才是真正的兜底：列表页按钮、侧栏空态按钮、
     * 命令面板、别人贴过来的 `#/wiki/new` 链接都汇到这里。没有它，匿名用户（以及
     * 没有编辑权的 viewer）会拿到一个**完整可用**的编辑器，填完点保存才被 401/403
     * 弹走。这里不给编辑器挂"禁用"状态，而是根本不渲染它 —— 半禁用的编辑器仍然会
     * 让人以为"再试试就能保存"。
     */
    if (newEntry.kind !== 'ready') {
      const needLogin = newEntry.kind === 'login'
      return (
        <WikiShell activeSlug={createHome ? HOME_SLUG : null} pages={pages} onNavigate={onNavigate}>
          <div className="page">
            <div className="page-head">
              <h1>{createHome ? '创建主页' : '新建页面'}</h1>
            </div>
            <EmptyState
              icon={needLogin ? <LogIn className="size-8" /> : <ShieldCheck className="size-8" />}
              title={
                needLogin
                  ? createHome
                    ? '创建主页需要先登录'
                    : '新建页面需要先登录'
                  : createHome
                    ? '你暂时不能创建主页'
                    : '你暂时不能新建页面'
              }
              hint={
                needLogin
                  ? createHome
                    ? '匿名访客可以浏览知识库，但创建主页需要一个账号。去登录，登录成功后会自动回到创建主页的入口。'
                    : '匿名访客可以浏览知识库，但保存新页面需要一个账号。去登录，登录成功后会自动回到这个新建页 —— 现在写的内容还不会丢在编辑器里。'
                  : newEntry.reason
              }
              action={
                <div className="flex flex-wrap items-center gap-2">
                  {needLogin && (
                    <Button
                      variant="primary"
                      icon={<LogIn className="size-3.5" />}
                      onClick={() => loginForNewPage(createHome)}
                    >
                      去登录
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => onNavigate(createHome ? 'home' : 'list')}>
                    {createHome ? '回到主页' : '返回列表'}
                  </Button>
                </div>
              }
            />
          </div>
        </WikiShell>
      )
    }
    return (
      <WikiShell activeSlug={createHome ? HOME_SLUG : null} pages={pages} onNavigate={onNavigate}>
        <WikiEdit
          key={createHome ? `${HOME_SLUG}/new` : 'new'}
          slug=""
          /*
           * 「创建主页」= 同一个新建编辑器 + 预填约定 slug。`prefillSlug` 是这条路径的
           * **唯一标识**：`WikiEdit` 里 `newMode = slug === '' || prefillSlug !== undefined`，
           * 因此它既决定"新建"语义，也决定 slug 框预填 `home`。
           */
          prefillSlug={createHome ? HOME_SLUG : undefined}
          onDone={(slug) => onNavigate(slug)}
          onCancel={() => onNavigate(createHome ? 'home' : 'list')}
        />
      </WikiShell>
    )
  }
  if (route.kind === 'detail') {
    return (
      <WikiShell activeSlug={activeSlug} pages={pages} onNavigate={onNavigate}>
        <WikiDetail
          key={route.slug}
          slug={route.slug}
          query={query}
          onEdit={() => onNavigate(`${route.slug}/edit`)}
          onDeleted={() => onNavigate('list')}
          onNavigate={onNavigate}
        />
      </WikiShell>
    )
  }
  /*
   * 路由级门控（G1，与 `#/wiki/new` **同一道门、同一判据**）：`route.kind === 'edit'`
   * 此前对匿名（以及无编辑权的角色）同样会渲染出**完整可用**的编辑器 —— 填完一屏、
   * 点保存才被 401/403 弹走。这里直接不渲染编辑器，而不是给它挂"禁用"：
   * 半禁用的编辑器仍会让人以为"再试试就能保存"。
   *
   * 与 `new` 的两点差别仅在文案：动作名是"编辑"，"返回"回本页详情（而不是回列表）。
   */
  const editEntry = newPageEntry(auth.user, auth.capabilities, 'edit')
  if (editEntry.kind !== 'ready') {
    const needLogin = editEntry.kind === 'login'
    return (
      <WikiShell activeSlug={activeSlug} pages={pages} onNavigate={onNavigate}>
        <div className="page">
          <div className="page-head">
            <h1>编辑页面</h1>
          </div>
          <EmptyState
            icon={needLogin ? <LogIn className="size-8" /> : <ShieldCheck className="size-8" />}
            title={needLogin ? '编辑页面需要先登录' : '你暂时不能编辑这个页面'}
            hint={
              needLogin
                ? '匿名访客可以浏览知识库，但保存改动需要一个账号。去登录，登录成功后会自动回到这个编辑页 —— 现在写的内容还不会丢在编辑器里。'
                : editEntry.reason
            }
            action={
              <div className="flex flex-wrap items-center gap-2">
                {needLogin && (
                  <Button
                    variant="primary"
                    icon={<LogIn className="size-3.5" />}
                    onClick={() => loginForEditPage(route.slug)}
                  >
                    去登录
                  </Button>
                )}
                <Button variant="secondary" onClick={() => onNavigate(route.slug)}>
                  返回页面
                </Button>
              </div>
            }
          />
        </div>
      </WikiShell>
    )
  }
  return (
    <WikiShell activeSlug={activeSlug} pages={pages} onNavigate={onNavigate}>
      <WikiEdit
        key={route.slug}
        slug={route.slug}
        onDone={() => onNavigate(route.slug)}
        onCancel={() => onNavigate(route.slug)}
      />
    </WikiShell>
  )
}

/**
 * 知识库的双栏外壳：左侧导航树 + 右侧内容。
 *
 * 信息架构依据（研究员引 NN/g）：**面包屑不能替代本地导航**，所以先有侧边栏；
 * 详情页原有的"← 返回列表"只解决了"回退"，没有解决"逛"。
 *
 * 响应式：桌面常驻、窄屏收起为抽屉（由 `SidebarDrawer` 承担，复用 Radix Dialog
 * 以获得焦点陷阱 / Escape / aria-modal）。
 */
/**
 * 侧栏顶部的「全部页面」入口。
 *
 * 为什么必须有：列表页（`#/wiki/list`）此前**唯一**的入口是命令面板里的「浏览全部页面」，
 * 等于把它藏起来了——主页改成文章之后，没有这个链接就再没有"看得见的"路径去管理所有页面。
 *
 * 放在 `Sidebar` 的 `header` 槽（现有契约，零改动）：桌面常驻侧栏与窄屏抽屉共用同一份，
 * 因此两处都会出现，不需要各写一遍。
 */
function SidebarAllPagesLink(props: { onNavigate: (path: string) => void }): ReactNode {
  return (
    <a
      href="#/wiki/list"
      aria-label="全部页面（列表与检索）"
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-note text-muted',
        'transition-colors duration-150 ease-standard hover:bg-hover hover:text-ink',
        focusRing,
      )}
      onClick={(e) => {
        // 修饰键放行交给浏览器（中键/⌘ 点击可新开标签页），普通左键走 SPA 路由
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        props.onNavigate('list')
      }}
    >
      <ListIcon className="size-3.5 shrink-0" aria-hidden="true" />
      全部页面
    </a>
  )
}

/**
 * 主页右栏的次要区块（`xl` 以上真有右栏 —— 由 `hasRightRail` 计入主页后成立；
 * 此前主页恒为单栏，它实际被排到正文下方整宽，与本节标题和主页正文的"右侧"说法都不符）。
 *
 * ⚠️ 块内左内边距与阅读卡片的 `px-6 sm:px-8` 对齐：数字不同时"最近更新"标题与正文标题
 * 会差几个像素，看起来像没对齐（栅格保证的是**列**对齐，列内还要各自对齐）。
 *
 * 它是**导航辅助**，不是列表页的复制：只给"最近更新"的几条 + 回列表的入口。
 * 刻意不在这里放检索框/过滤框/新建按钮——那些属于列表页（"管理"语义），
 * 主页要回答的是"这里有什么、从哪开始读"。
 *
 * 数据来自**共享 store**（`usePages()`），不额外发请求：侧栏用的是同一份。
 */
function HomeAside(props: { pages: PageSummary[] | null; onNavigate: (path: string) => void }): ReactNode {
  const { pages, onNavigate } = props
  /*
   * 最近更新 = 列表顺序（后端 `ORDER BY updated_at DESC, id DESC`）的前 5 条。
   * `pages` 为 null（还在加载或加载失败）时**整块不渲染**：主页正文不受影响，
   * 没必要为一个"辅助导航"显示骨架或错误——这正是它作为次要区块该有的失败姿态。
   */
  const recent = pages === null ? [] : pages.slice(0, 5)
  if (recent.length === 0) return null
  return (
    <aside aria-label="最近更新" className="flex flex-col gap-2 px-6 sm:px-8">
      <h2 className="m-0 text-sm font-semibold text-ink">最近更新</h2>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {recent.map((p) => (
          <li key={p.slug} className="min-w-0">
            <a
              href={wikiHref(p.slug)}
              title={p.title}
              className={cn(
                'block truncate rounded-md px-2 py-1.5 -ml-2 text-note text-ink-soft',
                'transition-colors duration-150 ease-standard hover:bg-hover hover:text-ink',
                focusRing,
              )}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                onNavigate(p.slug)
              }}
            >
              {p.title}
            </a>
          </li>
        ))}
      </ul>
      <a
        href="#/wiki/list"
        className={cn(
          /*
            ⚠️ 这里原先是 `text-accent-ink` —— **错配**，而且是本仓已经记档过的那个坑
            （见 components/Sidebar.tsx 的同名注释）：`--gw-accent-ink` 是"**实心** accent
            底上的字色"，浅色下是白、深色下是近黑，配 `bg-accent` 才对（ui/Button.tsx）。
            这一处**连 accent 底都没有**，于是浅色下白字压 #f5f7fa = **1.07:1**、
            深色下近黑压 #0b131d ≈ **1:1** —— 两种主题下这个链接都等于看不见
            （2026-09-15 深色模式排查时由 axe 在浅色侧扫出；深色侧肉眼可见它整条消失）。
            没有底色时该用的是 accent 本身，不是它的 ink。
          */
          'inline-block rounded-md px-2 py-1.5 -ml-2 text-note text-accent',
          'transition-colors duration-150 ease-standard hover:bg-hover',
          focusRing,
        )}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          onNavigate('list')
        }}
      >
        全部页面 →
      </a>
    </aside>
  )
}


function WikiShell(props: {
  activeSlug: string | null
  pages: ReturnType<typeof usePages>
  onNavigate: (path: string) => void
  children: ReactNode
}): ReactNode {
  const { activeSlug, pages, onNavigate, children } = props
  const navProps = {
    pages: pages.pages,
    // 同级顺序与 `pages` 同一次请求下发：侧栏、「全部页面」、上一篇/下一篇必须用同一份
    navOrder: pages.navOrder,
    error: pages.error,
    activeSlug,
    onOpen: (slug: string) => onNavigate(slug),
    onNavigate,
  }
  return (
    <div className="flex items-start gap-[var(--spacing-gutter)]">
      <Sidebar {...navProps} header={<SidebarAllPagesLink onNavigate={onNavigate} />} />
      <div className="min-w-0 flex-1">
        {/* 窄屏的目录入口与"全部页面"并列在内容顶部，避免挤占标题行 */}
        <div className="mb-2 lg:hidden">
          <SidebarDrawer {...navProps} header={<SidebarAllPagesLink onNavigate={onNavigate} />} />
        </div>
        {children}
      </div>
    </div>
  )
}

/* ============================ 列表 ============================ */

function WikiList(props: {
  /** 「新建页面」入口的门控结果（由 `WikiPage` 统一算好，本组件不再自己判一遍） */
  newEntry: NewPageEntry
  onOpen: (slug: string) => void
  onNew: () => void
  onSearch: (q: string) => void
}): ReactNode {
  const { newEntry, onOpen, onNew, onSearch } = props
  // 列表数据来自共享 store（与侧边栏、详情页的上一篇/下一篇同源）
  const pagesState = usePages()
  const pages = pagesState.pages
  /*
   * 站点主页（`lib/homeStore.ts`）：本页要回答两个问题——
   *   · 哪一行挂「主页」徽标（= 当前实际渲染的那一篇）；
   *   · 要不要给「设为主页 / 恢复默认」按钮（只有**站点管理员**有这门权限，见下）。
   * 判据与 `#/wiki` 的落点、AI 对话的"当前页"共用同一个换算（`homePageSlug`），
   * 不在这里自己拼一套（那会让"列表说 A 是主页、点开却是 B"）。
   */
  const home = useHome()
  const homeSlug = homePageSlug(home.home)
  /*
   * 站点主页的设置门是**站点管理员**（后端 `access: 'admin'`），
   * 刻意比同列的「隐藏 / 排序」（只要对该页 canEdit）严一档：那两者改的是导航列表的呈现，
   * 而主页是所有访客（含匿名）打开本站看到的第一屏。
   *
   * 前端据此**不渲染**那个注定 403 的按钮（与 `newPageGate` 同一条理由：把用户引进死路
   * 是纯浪费）；判定的真源仍在服务端，被拒时把服务端的原话显示在行内。
   */
  const auth = useAuth()
  /**
   * ⚠️ `capabilities` 可能是 `null`（还在确认）。用 `?.` 而不是 `!`：**未知即不给入口**
   * （与 `newPageGate` 的失败关闭同一条策略）——先亮一个点了必然 403 的按钮，
   * 比晚一帧看到它更糟。
   */
  const canAdminister = auth.capabilities?.administer === true
  /*
    列表区域的四态（**互斥**）：error / loading / empty / ready。
    判据来自状态本身，**不是**从"数据是否存在"反推——请求失败时 `pages` 同样是 null，
    用 `pages === null` 当"正在加载"会让头部说「正在加载…」而正文说「出错了」
    （这是已修正的真实缺陷：同一屏上两种状态同时成立）。
  */
  /** 已加载的页面数（`pages` 在加载中/失败时为 null，故显式兜底，不靠状态分支去"保证"它非空） */
  const pageCount = pages?.length ?? 0
  const listState = resolveAreaState({
    loading: pagesState.loading,
    hasError: pagesState.error !== null,
    // `pages` 在加载中/失败时是 null ⇒ 必须显式判空，否则 `pages.length` 会抛 TypeError。
    // 这也再次说明"用数据形状反推状态"有多脆：空数组与"还没有数据"根本不是一个意思。
    isEmpty: pages !== null && pages.length === 0,
  })
  const [q, setQ] = useState('')
  /**
   * **即时过滤**（纯客户端）——与上方"检索"是两件事，刻意分开：
   * - 这里的 `filter` 只筛当前已加载的列表（输入即生效、零请求），解决"页多了找不到"；
   * - 上方的"搜索"走服务端全文检索（`@geewiki/search`，支持中文分词与相关度排序）。
   * 合成一个控件会逼用户猜"我这次敲的是哪种"——所以并列存在，各自有标签。
   */
  const [filter, setFilter] = useState('')
  const [queryNotice, setQueryNotice] = useState('')
  /**
   * 检索插件**可能未启用**（不在基础层清单里时它的端点会 404）。判据用
   * `GET /api/plugins`（恒可用）里该插件是否 active —— 这是权威判据且**不产生 404**：
   * 直接去探 `/api/search` 会让浏览器把 404 记成 error 级网络日志，用户看到控制台一片红。
   * 三态：null=探测中、true=可用、false=不可用（禁用检索入口）。
   *
   */
  const [searchReady, setSearchReady] = useState<boolean | null>(null)
  const load = (): void => {
    pagesState.reload()
  }

  /*
   * ══════════════ 页面树 · 在侧栏隐藏 · 同层排序（2026-09-16 导航批） ══════════════
   *
   * 三件事共用**一棵未剪枝的树**：
   *   · 树：`buildNavTree` 的层级来自 slug（`guide/architecture` 的父级是 `guide`），
   *     同级顺序来自 `nav_order`（与服务端下发的同一份）；
   *   · 隐藏：**不剪枝**——被隐藏的页面在这一页要以灰色**显示出来**（用户要能看见并取消它），
   *     剪枝只发生在侧栏（`Sidebar` 里的 `pruneHidden`）与"上一篇/下一篇"里；
   *   · 排序：只在**同一层内**，提交的是这一层的完整新顺序（`items` 可以是页面 slug，
   *     也可以是 `guide` 这种没有页面的分组路径）。拖动**永远不改变层级**——
   *     层级就是 url 里的 `/`，改层级等于改地址，那是"移动页面"而不是排序。
   */
  const navOrder = useMemo(() => navOrderMap(pagesState.navOrder), [pagesState.navOrder])
  const tree = useMemo(() => buildNavTree(pages ?? [], navOrder), [pages, navOrder])
  /** 折叠的分组（path 集合）；默认全展开——地图是给人看的，默认藏起来等于没有 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo(() => navRows(tree, collapsed), [tree, collapsed])
  /** 正在提交的行（path 或 `__root__`）——提交期间禁用控件，避免连点产生两次顺序写入 */
  const [navBusy, setNavBusy] = useState<string | null>(null)
  const [_navNotice, setNavNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /**
   * 「设为主页 / 恢复默认主页」的**提交中**标记与反馈位。
   *
   * 为什么反馈位单独一个 state、不复用上面那个 `_navNotice`：后者（排序 / 隐藏的提示）
   * 在本页**没有任何渲染点**，挂上去等于这个新动作永远静默；而主页动作失败必须让人看见 ——
   * 403（你不是站点管理员）与 404（页面刚被别人删掉）的处理方式完全不同，
   * 静默失败只会让人以为"点了没反应"。
   */
  const [homeBusy, setHomeBusy] = useState(false)
  const [homeNotice, setHomeNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** 拖动中的行（含它所在的层，用于判"只能同层"） */
  const [drag, setDrag] = useState<{ path: string; parent: string } | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)

  const submitOrder = async (parent: string, items: readonly string[]): Promise<void> => {
    setNavBusy(parent === '' ? '__root__' : parent)
    setNavNotice(null)
    try {
      await api.setNavOrder(parent === '' ? null : parent, items)
      pagesState.reload()
      setNavNotice({ kind: 'ok', text: '顺序已保存（所有人看到的导航都已更新）' })
    } catch (e) {
      /*
       * 失败**不假装成功**：把服务端的原话显示出来。排序要求"这一层里每一篇你都能编辑"
       * （导航是共享内容），少了权限就会拿到 403 —— 用户要知道是权限问题还是别的问题。
       */
      setNavNotice({ kind: 'error', text: `顺序没有保存：${errorLine(e)}` })
    } finally {
      setNavBusy(null)
    }
  }

  const moveRow = (row: NavRow, delta: number): void => {
    const ids = row.siblings.map((n) => n.path)
    const next = moveWithinSiblings(ids, row.index, row.index + delta)
    if (next.join('\u0000') === ids.join('\u0000')) return
    void submitOrder(row.parent, next)
  }

  const toggleHidden = async (row: NavRow): Promise<void> => {
    const slug = row.node.path
    const own = row.node.page?.nav_hidden === true
    setNavBusy(slug)
    setNavNotice(null)
    try {
      await api.setNavHidden(slug, !own)
      pagesState.reload()
      setNavNotice({
        kind: 'ok',
        text: !own ? `「${slug}」已从左侧边栏隐藏（它仍可被直链与检索访问）` : `「${slug}」已恢复显示`,
      })
    } catch (e) {
      setNavNotice({ kind: 'error', text: `「${slug}」的隐藏设置没有保存：${errorLine(e)}` })
    } finally {
      setNavBusy(null)
    }
  }

  /**
   * 把某一篇设为站点主页（`slug`），或清除这项设置（`null`）。
   *
   * `null` = **恢复默认**：主页回落约定 slug `home`（与从未设置过完全等价，见 homeStore）。
   * 为什么不做成"删除那一行设置"之外的语义：主页必须**总有**一个落点，
   * "没有主页"不是一种可用状态（`#/wiki` 会变成 404）。
   */
  const setHomePage = async (slug: string | null): Promise<void> => {
    setHomeBusy(true)
    setHomeNotice(null)
    try {
      await api.setSiteHome(slug)
      /*
       * 必须**重取**而不是本地改状态：服务端才是"设置成了什么"的真源
       * （它还要在写入时校验页面是否存在），而本页与主页分支、AI 对话共用这份缓存。
       * 重取而不是乐观更新，也是为了让"设完之后 `#/wiki` 打开的是哪一篇"当场可见。
       */
      await invalidateHome()
      setHomeNotice({
        kind: 'ok',
        text:
          slug === null
            ? '已恢复默认主页：打开本站将显示约定页面 home（若它还不存在，首页会给创建引导）'
            : `「${slug}」已设为站点主页：所有访客打开本站都会先看到这一篇`,
      })
    } catch (e) {
      setHomeNotice({ kind: 'error', text: `主页设置没有保存：${errorLine(e)}` })
    } finally {
      setHomeBusy(false)
    }
  }

  const onDropRow = (row: NavRow): void => {
    const from = drag
    setDrag(null)
    setDropAt(null)
    if (from === null || from.parent !== row.parent || from.path === row.node.path) return
    const ids = row.siblings.map((n) => n.path)
    const fromIndex = ids.indexOf(from.path)
    if (fromIndex < 0) return
    const next = moveWithinSiblings(ids, fromIndex, row.index)
    if (next.join('\u0000') === ids.join('\u0000')) return
    void submitOrder(row.parent, next)
  }
  const slowList = useSlowHint(pages === null && pagesState.error === null)

  useEffect(() => {
    api
      .plugins()
      .then((r) => {
        const stateOf = (name: string): string | undefined => r.plugins.find((p) => p.name === name)?.state
        setSearchReady(stateOf('@geewiki/search') === 'active')
      })
      .catch((e: unknown) => {
        // 列表本身失败：不阻塞页面，入口按"不可用"处理（用户仍能正常读写页面）
        console.debug('[geewiki-wiki] 插件列表不可用，隐藏检索/问答入口：', e instanceof Error ? e.message : e)
        /*
          日志还不够（本批 T4）：入口消失是**用户可见的变化** —— 检索框变灰，
          而此前界面上一个字都不说，用户只会以为"这版没有这个功能"或"我的权限没了"。
          这里复用既有的 `queryNotice` 提示位（就在入口那一行里，不是弹窗）说明原因。
        */
        setQueryNotice('检索功能当前不可用（插件列表读取失败），检索入口已禁用')
        setSearchReady(false)
      })
  }, [])

  /**
   * 即时过滤结果。匹配**标题或标识**（标识常是英文、标题是中文，两者都查才实用），
   * 大小写不敏感（`toLowerCase` 而非 locale 相关比较：这两个字段是标识性文本，
   * 用户不会期望"İ/i"这类语言特例在这里起作用）。
   */
  const filtered = useMemo(() => {
    const list = pages ?? []
    const needle = filter.trim().toLowerCase()
    if (needle === '') return list
    return list.filter(
      (p) => p.title.toLowerCase().includes(needle) || p.slug.toLowerCase().includes(needle),
    )
  }, [pages, filter])

  /** path → 节点（筛选时要把平铺的页面映射回树上的节点，才能拿到正确的隐藏状态） */
  const nodeByPath = useMemo(() => {
    const m = new Map<string, NavNode>()
    const walk = (list: readonly NavNode[]): void => {
      for (const n of list) {
        m.set(n.path, n)
        walk(n.children)
      }
    }
    walk(tree)
    return m
  }, [tree])

  /**
   * 实际渲染的行序列。
   *
   * 筛选态**平铺**（不显示层级、不给排序控件）：筛选是"找某一页"的动作，此时缩进只会让结果跳来跳去；
   * 隐藏状态仍然取自树上的节点，所以"父级隐藏 ⇒ 子级灰"在筛选结果里也成立。
   */
  const view: NavRow[] = useMemo(() => {
    if (filter.trim() === '') return rows
    return filtered.map((p, i) => {
      const node = nodeByPath.get(p.slug)
      return node === undefined
        ? { node: { segment: p.slug, path: p.slug, page: p, children: [], hidden: p.nav_hidden }, depth: 0, siblings: [], index: i, parent: '' }
        : { node, depth: 0, siblings: [], index: i, parent: '' }
    })
  }, [filter, rows, filtered, nodeByPath])


  const submitSearch = (): void => {
    // 与检索视图共用同一套校验（空串 / 超长），这样超长查询在**原地**就给出提示、不必先跳转
    const checked = checkQuery(q)
    if (!checked.ok) {
      setQueryNotice(checked.message)
      return
    }
    setQueryNotice('')
    onSearch(checked.value)
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-xl font-semibold">知识库</h1>
        {/* 动作条（权限/删除/编辑）与下方右栏**同宽同右缘**：右栏在 styles.css 里固定
            240px，这里用同一个值，避免两处各写一个数而漂移（右栏宽度变化时两处一起改）。 */}
        <div className="ml-auto flex w-[240px] flex-wrap items-center justify-end gap-2">
          {/*
            这里**不再**挂"失败 chip"。原因（真实缺陷）：
            1. 它会直接渲染原始 message（泄漏内部错误串）；
            2. 它与下方列表区域的 ErrorState 是**同一个失败的两处呈现**，一屏两遍；
            3. 它与「刷新」按钮并列时像"两个重试入口"，层级不清。
            失败只在**它自己的归属区域**（列表卡片）里说一次，重试入口也只在那一处。
          */}
          <Button icon={<RefreshCw className="size-3.5" />} onClick={load}>
            刷新
          </Button>
          {/* 新建入口按登录态/能力三态渲染（本批 R11）：匿名时它是"去登录"的入口 */}
          <NewPageAction entry={newEntry} onNew={onNew} />
        </div>
      </div>

      {/* 检索与问答入口：检索按插件激活态禁用，问答按插槽贡献显隐（两套判据各自的真源） */}
      <div className="flex flex-wrap items-center gap-2.5">
        <form
          className="flex min-w-[260px] flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            submitSearch()
          }}
        >
          <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
            检索知识库
          </label>
          <Input
            id={SEARCH_INPUT_ID}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchReady === false ? '检索插件未启用' : '检索知识库内容…（⌘K 或 / 聚焦此处）'}
            disabled={searchReady === false}
            className="flex-1"
          />
          <Button
            variant="primary"
            type="submit"
            icon={<Search className="size-3.5" />}
            disabled={searchReady === false}
          >
            搜索
          </Button>
        </form>

        {queryNotice !== '' && (
          <span className="rounded-md border border-danger-line bg-danger-bg px-3 py-1 text-note text-danger-ink">
            {queryNotice}
          </span>
        )}
      </div>

      {/* 即时过滤：只筛已加载的列表，零请求（与上方服务端检索是两件事） */}
      {pages !== null && pages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={FILTER_INPUT_ID} className="sr-only">
            在当前列表中过滤
          </label>
          <Input
            id={FILTER_INPUT_ID}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="在当前列表中过滤标题或标识…"
            className="max-w-sm"
            aria-describedby={filter !== '' ? FILTER_HINT_ID : undefined}
          />
          {filter !== '' && (
            <span id={FILTER_HINT_ID} className="text-xs text-muted" role="status">
              {filtered.length} / {pages.length} 条匹配
              <button
                type="button"
                onClick={() => setFilter('')}
                className="gw-focus-ring ml-2 rounded-sm text-accent hover:underline"
              >
                清除
              </button>
            </span>
          )}
        </div>
      )}

      <Card>
        <CardHeader
          title="全部页面"
          /*
            状态文本由 `listState` 决定，与下方正文**同源**——这是"头部说加载中、正文说出错"
            那个矛盾的根治办法：两处都读同一个互斥状态，不可能各说一套。
            注意 error 分支下**不写"正在加载…"**：失败是已确定的事实，继续宣称在加载会让人白等。
          */
          description={
            listState === 'error'
              ? '加载失败'
              : listState === 'loading'
                ? '正在加载…'
                : listState === 'empty'
                  ? '还没有内容'
                  : `共 ${pageCount} 个页面`
          }
          actions={
            <span className="text-xs text-muted">
              按标题打开页面；也可用上方检索
            </span>
          }
        />
        {/*
          主页动作（设为主页 / 恢复默认）的反馈位。
          失败**必须可见**：403（不是站点管理员）与 404（页面刚被别人删掉）的处理方式
          完全不同，静默失败只会让人以为"点了没反应"——那正是本仓在写路径上一贯拒绝的姿态。
        */}
        {homeNotice !== null && (
          <div
            role={homeNotice.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'border-b border-line px-4 py-2 text-note',
              homeNotice.kind === 'error' ? 'bg-danger-bg text-danger-ink' : 'bg-bg text-ink-soft',
            )}
          >
            {homeNotice.text}
          </div>
        )}
        {/*
          主页设置指向一篇**当前主体读不到**的页面（服务端为此不下发 slug，见 `SiteHome` 的
          `hidden` 态）时，这里是**唯一**能自救的地方：这一态下没有任何一行能挂「主页」徽标，
          于是"恢复默认"只可能出现在这条横条上；否则管理员会卡在"设置里明明有一项、
          界面上却找不到"。只有站点管理员看得到它（按钮点了必然 403 的人不该看到入口）。
        */}
        {canAdminister && home.home?.state === 'hidden' && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg px-4 py-2 text-note text-muted">
            <span>站点主页当前指向一篇你看不到（或已被删除）的页面。</span>
            <Button size="sm" variant="secondary" disabled={homeBusy} onClick={() => void setHomePage(null)}>
              恢复默认主页
            </Button>
          </div>
        )}
        {/*
          可滚动区域的键盘可达性：`tabIndex={0}` 让键盘用户能把焦点落到表格上，
          随后用方向键滚动（容器现在**双向**可滚：横向溢出看右侧列，纵向溢出看下面的行）。
          这是 WCAG 2.1.1（键盘）在"可滚动区域"上的具体要求，VitePress 等实现亦如此。
          `aria-label` 给这个可聚焦区域一个名字（否则屏幕阅读器只念"表格"）。
          焦点必须**可见**（2.4.7）：故同时给 `focusRing`，不能只靠浏览器默认轮廓。
        */}
        {/*
          正文与头部**读同一个 `listState`**（互斥四态），因此不可能再出现
          "头部说加载中、正文说出错"。优先级由 `resolveAreaState` 承担并有单测
          （错误 > 加载 > 空 > 就绪）。
          注意：这里是**唯一**的错误呈现点与**唯一**的重试入口（页头那个 chip 已删除）。
        */}
        {/*
          就绪分支的表格包裹层**必须自己纵向可滚动**，粘性表头才会真的吸附。

          ⚠️ 这是本页最容易被"看起来对、其实没生效"骗到的一处，两件事必须同时成立：
          ① `sticky` 的吸附参照系是**最近的滚动容器**（CSS 规范：一轴非 `visible` 会让
             另一轴的 `visible` 计算为 `auto`）。所以仅写 `overflow-x-auto` 就足以让它
             成为参照系 —— 吸附位置从此不再相对视口；
          ② 但若只写横向、不给高度上限，该容器 `clientHeight == scrollHeight`，纵向
             **永远不滚** ⇒ 表头随页面一起滚走，`sticky` 形同虚设。
             2026-09-12 实测（1440×600）：页面滚 300 时表头矩形 top = -20，滚满 362 时
             top = -82，**完全滚出视口**。
             故给 `max-h` + `overflow-auto`：容器真能滚，表头吸附在**容器顶部**。此时
             `top-0` 是正确写法（容器顶就在顶栏之下）；写成 `top-[var(--spacing-header)]`
             反而会把表头往表格内部推进 56px 压住首行。
          ⚠️ 表头背景必须**不透明**：悬停时它盖住行文字，半透明会让下面的字透出来形成
             "字叠字"。2026-09-12 实测计算值：`bg-surface` = `rgb(255, 255, 255)`、
             `bg-bg` = `rgb(245, 247, 250)`，两者**都完全不透明**（此前注释称 `bg-surface`
             是 85% 不透明，属未经验证的错误依据，已按实测改正）。这里仍显式给 `bg-bg`
             以取页面底色、与行底色区分开。
        */}
        {listState === 'error' ? (
          <ErrorState
            title={describeError(pagesState.errorValue).title}
            hint={describeError(pagesState.errorValue).hint}
            onRetry={describeError(pagesState.errorValue).retryable ? load : undefined}
            retrying={pagesState.loading}
          />
        ) : listState === 'loading' ? (
          <LoadingState slow={slowList}>
            <SkeletonTable rows={4} cols={4} />
          </LoadingState>
        ) : listState === 'empty' ? (
          <EmptyState
            icon={<FileText className="size-8" />}
            title="还没有任何页面"
            hint="知识库是空的。创建第一个页面来记录团队知识——保存后会自动生成版本历史，随时可以回溯。"
            action={
              /* 空态里的新建入口与页头用**同一个**动作组件（同一份门控，不会一处理一处漏） */
              <NewPageAction entry={newEntry} onNew={onNew} />
            }
          />
        ) : filtered.length === 0 ? (
          /*
            "过滤后无匹配"与"一个页面都没有"是**两种不同的空**，文案必须不同：
            前者要用"清除筛选"（数据其实在），后者要引导"新建"（数据确实没有）。
            混用会让用户以为自己的数据不见了。
          */
          <EmptyState
            icon={<SearchX className="size-8" />}
            title={`没有匹配「${filter.trim()}」的页面`}
            hint={`共 ${pageCount} 个页面，但标题与标识都不含这个关键词。换个词，或清除筛选看全部。`}
            action={
              <Button variant="secondary" onClick={() => setFilter('')}>
                清除筛选
              </Button>
            }
          />
        ) : (
          <div className="max-h-[calc(100vh-12rem)] overflow-auto rounded-md">
            <table
              tabIndex={0}
              aria-label="知识库页面列表"
              className={cn('w-full border-collapse text-sm', focusRing)}
            >
              <thead className="sticky top-0 z-10 bg-bg">
                <tr>
                  {/*
                    「导航」列同时承载**站点主页**的入口（主页批）。它不是一个纯导航属性，
                    但它是"这一页在全站里被摆在哪"这一类站点级设置，与隐藏/排序同族，
                    故沿用同一列而不再加第六列（多一列会让表格在窄屏下更早横向溢出）。
                  */}
                  {['标题', '页面标识', '版本', '最近更新', '导航 / 主页'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-line px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-muted"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.map((row) => {
                  const { node, depth } = row
                  const page = node.page
                  const hasChildren = node.children.length > 0
                  const isCollapsed = collapsed.has(node.path)
                  const ownHidden = page?.nav_hidden === true
                  /* 有效隐藏但自己没有开关 ⇒ 是被祖先带下来的（文案要区分，否则用户找不到那个开关） */
                  const inheritedHidden = node.hidden && !ownHidden
                  const canReorder = row.siblings.length > 1
                  const busy = navBusy !== null
                  /*
                   * 这一行**就是当前站点主页**吗。
                   *
                   * 判据用 `homeSlug`（与 `#/wiki` 渲染哪一篇、AI 对话说"当前页是哪个 slug"
                   * 同一个换算）：`homeSlug` 为 `null` 时（结论未到，或主页被设置成一篇
                   * 当前主体读不到的页面）**没有任何一行**是主页 —— 这正是"不泄露存在性"
                   * 与"不假装知道"的必然结果，而不是没算出来。
                   */
                  const isSiteHome = homeSlug !== null && page !== null && page.slug === homeSlug
                  return (
                    <tr
                      key={node.path}
                      /*
                        可拖动 = 这一行参与同层排序。**纯分组也能拖**（`items` 里就是它的路径）——
                        否则 `guide`、`demo` 这些没有页面的目录永远排不了序。
                        筛选态 `siblings` 为空 ⇒ 不给排序控件与拖动（那时顺序的"这一层"不完整）。
                      */
                      draggable={canReorder && !busy}
                      onDragStart={() => setDrag({ path: node.path, parent: row.parent })}
                      onDragOver={(e) => {
                        if (drag === null || drag.parent !== row.parent || drag.path === node.path) return
                        e.preventDefault()
                        setDropAt(node.path)
                      }}
                      onDragLeave={() => setDropAt((prev) => (prev === node.path ? null : prev))}
                      onDrop={(e) => {
                        e.preventDefault()
                        onDropRow(row)
                      }}
                      onDragEnd={() => {
                        setDrag(null)
                        setDropAt(null)
                      }}
                      className={cn(
                        'group cursor-pointer transition-colors duration-150 hover:bg-hover',
                        node.hidden && 'text-muted',
                        dropAt === node.path && 'outline outline-2 -outline-offset-2 outline-accent',
                      )}
                      onClick={() => {
                        if (page !== null) onOpen(page.slug)
                      }}
                    >
                      <td
                        className={cn('border-b border-line px-3 py-2.5 align-top font-semibold', node.hidden && 'opacity-60')}
                        style={{ paddingLeft: `${12 + depth * 18}px` }}
                      >
                        <span className="flex items-center gap-1">
                          {hasChildren ? (
                            <button
                              type="button"
                              aria-expanded={!isCollapsed}
                              aria-label={`${isCollapsed ? '展开' : '折叠'}「${page?.title ?? node.segment}」`}
                              className={cn('rounded-sm p-0.5 text-muted hover:bg-hover', focusRing)}
                              onClick={(e) => {
                                e.stopPropagation()
                                setCollapsed((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(node.path)) next.delete(node.path)
                                  else next.add(node.path)
                                  return next
                                })
                              }}
                            >
                              {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                            </button>
                          ) : (
                            <span aria-hidden="true" className="inline-block size-4" />
                          )}
                          {page !== null ? (
                            <a
                              href={`#/wiki/${encodeURIComponent(page.slug)}`}
                              className="gw-focus-ring rounded-sm py-1 text-accent underline decoration-1 underline-offset-2 hover:text-accent-hover hover:decoration-2 group-hover:decoration-2"
                            >
                              {page.title}
                            </a>
                          ) : (
                            <span className="font-mono text-2xs text-muted" title="只有路径段、没有页面（纯分组）">
                              {node.segment}
                            </span>
                          )}
                          {isSiteHome && (
                            /*
                              徽标对**所有能看到列表的人**都显示（不只管理员）："打开本站先看到哪一篇"
                              是所有人都该知道的事实，藏起来只会让人以为主页是另一篇。
                              `title` 只是补充说明，不是唯一信息源（文字"主页"本身就在）。
                            */
                            <Badge tone="accent" title="站点主页：打开本站（#/wiki）时默认显示这一篇">
                              主页
                            </Badge>
                          )}
                          {node.hidden && (
                            <span
                              className="rounded-sm bg-hover px-1.5 py-0.5 text-2xs text-muted"
                              title={inheritedHidden ? '父级（或更上层）被隐藏，因此这一篇也不在侧栏里' : '已从左侧边栏隐藏'}
                            >
                              {inheritedHidden ? '随父级隐藏' : '已隐藏'}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={cn('border-b border-line px-3 py-2.5 align-top', node.hidden && 'opacity-60')}>
                        {page !== null ? (
                          <code className="rounded-sm bg-hover px-1.5 py-0.5 font-mono text-2xs text-ink-soft">{page.slug}</code>
                        ) : (
                          <span className="text-muted">分组</span>
                        )}
                      </td>
                      <td className={cn('border-b border-line px-3 py-2.5 align-top text-muted', node.hidden && 'opacity-60')}>
                        {page !== null ? `v${page.version}` : '—'}
                      </td>
                      <td className={cn('border-b border-line px-3 py-2.5 align-top text-muted', node.hidden && 'opacity-60')}>
                        {page !== null ? fmtTime(page.updated_at) : '—'}
                      </td>
                      <td className="border-b border-line px-3 py-2.5 align-top whitespace-nowrap">
                        <span className="flex items-center gap-1">
                          {canReorder && (
                            <span className="text-muted" title="拖动可调整同一层内的顺序（不会改变层级）" aria-hidden="true">
                              <GripVertical className="size-3.5" />
                            </span>
                          )}
                          {/*
                            ⚠️ 被父级带下来隐藏的行**不给开关**：它已经不在侧栏里了，再放一个"隐藏"
                            按钮只会让人以为"点一下才有用"，而它的状态完全由父级决定。
                            要让它出现，得去父级取消隐藏（badge 的 title 已经写明了这一点）。
                          */}
                          {page !== null && !inheritedHidden && (
                            <button
                              type="button"
                              aria-pressed={ownHidden}
                              disabled={busy}
                              title={
                                ownHidden
                                  ? '取消隐藏：恢复出现在左侧边栏'
                                  : '在左侧边栏隐藏（这一页仍可被直链与检索访问；其子级也会一起不显示）'
                              }
                              className={cn('rounded-sm px-1.5 py-0.5 text-2xs text-muted hover:bg-hover disabled:opacity-40', focusRing)}
                              onClick={(e) => {
                                e.stopPropagation()
                                void toggleHidden(row)
                              }}
                            >
                              {ownHidden ? '取消隐藏' : '隐藏'}
                            </button>
                          )}
                          {canReorder && (
                            <>
                              <button
                                type="button"
                                aria-label={`上移「${page?.title ?? node.segment}」`}
                                disabled={busy || row.index === 0}
                                className={cn('rounded-sm p-0.5 text-muted hover:bg-hover disabled:opacity-30', focusRing)}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  moveRow(row, -1)
                                }}
                              >
                                <ArrowUp className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`下移「${page?.title ?? node.segment}」`}
                                disabled={busy || row.index === row.siblings.length - 1}
                                className={cn('rounded-sm p-0.5 text-muted hover:bg-hover disabled:opacity-30', focusRing)}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  moveRow(row, 1)
                                }}
                              >
                                <ArrowDown className="size-3.5" />
                              </button>
                            </>
                          )}
                          {/*
                            「设为主页 / 恢复默认」——主页批。
                            门是**站点管理员**（后端 `access: 'admin'`）：比同列的隐藏/排序严一档
                            （那两者只要对该页 `canEdit`），因为主页是所有访客（含匿名）看到的
                            第一屏。前端据此**不渲染**注定 403 的按钮，判定真源仍在服务端 ——
                            被拒时把服务端的原话显示在上方横条里，不假装成功。
                          */}
                          {canAdminister && page !== null && !isSiteHome && (
                            <button
                              type="button"
                              disabled={busy || homeBusy}
                              title="设为站点主页：所有访客打开本站（#/wiki）都会先看到这一篇"
                              className={cn('rounded-sm px-1.5 py-0.5 text-2xs text-muted hover:bg-hover disabled:opacity-40', focusRing)}
                              onClick={(e) => {
                                e.stopPropagation()
                                void setHomePage(page.slug)
                              }}
                            >
                              设为主页
                            </button>
                          )}
                          {/*
                            「恢复默认」只出现在**本身就是主页**的那一行，且只在设置确实存在时
                            （`hasExplicitHome`）：从未设置过时主页已经落在约定 slug `home` 上，
                            再放一个"恢复默认"是个什么都不做的按钮。
                          */}
                          {canAdminister && isSiteHome && hasExplicitHome(home.home) && (
                            <button
                              type="button"
                              disabled={busy || homeBusy}
                              title="清除主页设置：打开本站回到约定页面 home（若它还不存在，首页会给创建引导）"
                              className={cn('rounded-sm px-1.5 py-0.5 text-2xs text-muted hover:bg-hover disabled:opacity-40', focusRing)}
                              onClick={(e) => {
                                e.stopPropagation()
                                void setHomePage(null)
                              }}
                            >
                              恢复默认
                            </button>
                          )}
                          {!canReorder && page === null && <span className="text-2xs text-muted">—</span>}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

/* ============================ 详情 ============================ */

/**
 * 面包屑：`知识库 / 指南 / 撰写指南`——**完整层级**，不再是"知识库 / 当前页"两段。
 *
 * 为什么需要知道"哪些前缀真的有页面"：层级 slug 里中间层**可能是页面**（`guides` 存在 ⇒ 可打开），
 * 也**可能只是分组**（只有 `guides/authoring` 时 `guides` 没有页面）。两种情况的处理不同：
 * - 有页面 ⇒ 渲染成链接指向该页（可中键新开、可复制）；
 * - 无页面 ⇒ **不可点**（渲染为文本 + `title` 说明它是分组）。
 *   **刻意不链到列表页**：那会给出一个"看起来能到、实际到别处"的假链接；
 *   而新增一条"按前缀过滤"的路由需要改 `App.tsx`（本次不得触碰）。可访问性上用 `aria-current`
 *   之外不加链接语义，读屏不会把它当可导航项。
 *
 * 语义用 `<nav aria-label>` + `<ol>`（面包屑的标准形态：有序、层级即顺序）。
 *
 * 窄屏策略：只保留"第一段 + 最后一段"，中间层折叠为 `…`（CSS 控制，`sm` 以上全展开）。
 * 用 CSS 而非 JS 是因为它不依赖测量、不会在 resize 时抖动；完整层级仍在无障碍树里。
 */
function Breadcrumb({
  slug,
  title,
  pages,
}: {
  slug: string
  title: string
  pages: readonly PageSummary[] | null
}): ReactNode {
  const bySlug = useMemo(() => new Map((pages ?? []).map((p) => [p.slug, p])), [pages])

  /*
   * 面包屑的全部项（含根项与当前页）由 `buildBreadcrumb` 产出——**唯一来源**。
   * 这里不再自己拼「知识库」根项、也不再在根项尾部画分隔符：那曾经与"每项开头的分隔符"
   * 叠加成 `知识库 › › 指南`。详见 `navTree.ts` 的 `BreadcrumbItem` 注释。
   */
  const crumbs = useMemo(() => buildBreadcrumb(slug, title, bySlug, wikiHref), [slug, title, bySlug])
  const intermediate = intermediateCrumbCount(crumbs)

  return (
    <nav aria-label="面包屑" className="min-w-0 text-note">
      <ol className="m-0 flex list-none flex-wrap items-center gap-x-1.5 gap-y-1 p-0">
        {crumbs.map((c, i) => (
          <li
            key={`${i}:${c.path}`}
            className={cn(
              'min-w-0 items-center gap-1.5',
              /*
               * 中间层在窄屏收起（只留首段与末段），靠下面的省略提示告诉用户还有层级。
               *
               * ⚠️ **不能**同时写 `flex` 与 `hidden`：两者都是 display 工具类，谁生效取决于
               * 生成的 CSS 顺序而非 class 属性顺序（实测 `hidden` 被 `flex` 盖掉，窄屏收起失效）。
               * 正确写法是"基础态 `hidden` + 断点态 `sm:flex`"。
               */
              i > 0 && !c.isLast ? 'hidden sm:flex' : 'flex',
            )}
          >
            {/*
              分隔符的**唯一渲染点**：规则来自 `hasSeparatorBefore`（除首项外每项之前恰好一个）。
              它**不加响应式类**是刻意的：中间层 `<li>` 在窄屏整体隐藏，会连带隐藏它自己的分隔符；
              而末项这个始终可见，于是窄屏恰好剩下 `知识库 › 当前页`。
              若把它写成 `hidden sm:inline`，窄屏就会变成 `知识库 当前页`（丢了分隔）。
            */}
            {hasSeparatorBefore(i) && (
              <ChevronRight className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
            )}
            {c.isLast ? (
              <span aria-current="page" className="truncate font-medium text-ink" title={title}>
                {title}
              </span>
            ) : c.href !== null ? (
              /*
                只用 `href`，**不叠 onClick**：应用监听 `hashchange` 完成导航，
                而"有未保存改动时的确认"由 `useUnsavedGuard` 在**捕获阶段**统一拦截。
                若这里再加一次 `confirmLeave()`，同一次点击就会问两遍，故直接避免重复。
              */
              <a
                href={c.href}
                className="gw-focus-ring shrink-0 rounded-sm text-accent hover:underline"
                title={c.path === '' ? undefined : c.path}
              >
                {c.label}
              </a>
            ) : (
              // 纯分组：不可导航，但仍要能"看见层级"。
              // 标签种类为 'segment' 时说明它**没有**同名页面，只能退回路径段——
              // 故用等宽字体明示"这是标识符"，与侧栏保持同一套呈现规则（同一个 navLabelOf）。
              <span
                className={cn('shrink-0 text-muted', c.labelKind === 'segment' && 'font-mono text-xs')}
                title={`${c.path}（分组，没有对应页面）`}
              >
                {c.label}
              </span>
            )}
          </li>
        ))}

        {/*
          窄屏省略提示：中间层数量 = 总数 - 根项 - 当前页。
          用 `sm:hidden` 与上面中间层的 `hidden sm:flex` 互补——宽屏看全层级，窄屏看省略提示。
        */}
        {intermediate > 0 && (
          <li className="flex items-center text-muted sm:hidden" aria-hidden="true">
            前面还有 {intermediate} 级…
          </li>
        )}
      </ol>
    </nav>
  )
}

function WikiDetail(props: {
  slug: string
  /**
   * 本次 hash 的裸查询串（`?` 之后的部分，无则空串）。由 `App.tsx` 的 `useRouteQuery` 提供。
   *
   * 用于 `?v=<版本 id>` 的历史快照预览：放进 URL 而不是组件 state，因为"你看这一版"
   * 是一个**要发给别人的状态**（可分享、可刷新、可前进后退）。
   */
  query: string
  onEdit: () => void
  onDeleted: () => void
  onNavigate: (path: string) => void
  /**
   * 主页模式（`#/wiki` 空路由）。
   *
   * 存在的唯一理由是**404 那一支**：普通页读不到时说"页面不存在，或你没有访问权限"是对的，
   * 但主页读不到时这句话毫无用处——用户既没输错地址，也无从知道"这个站点还没有主页"。
   * 主页模式改成给出可执行的下一步：有编辑权就给「创建主页」，否则给中性面板 + 去哪。
   *
   * 为什么不做成"另一个组件"：正文卡片、版本历史、目录、权限入口这些必须与普通页**逐字一致**
   * （一致才不会漂移）；复制一份出来，两边的正文渲染迟早会分叉。
   */
  homeMode?: boolean
}): ReactNode {
  const { slug, query, onEdit, onDeleted, onNavigate, homeMode = false } = props
  // 当前页路由（锚点 href 要用它拼 `#/wiki/<slug>?a=<id>`，见 lib/hashAnchor.ts）
  const route = `wiki/${slug}`

  const [page, setPage] = useState<PageDetail | null>(null)
  const [err, setErr] = useState('')
  /*
    保留**错误原值**（不只是人话字符串）：详情页的失败要分两种处理——
    404 是"服务明确说没有"，其它是"我们不知道"。此前两者都渲染成「页面不存在」，
    把"不知道"说成了"不存在"，而且没有重试入口。
  */
  const [loadError, setLoadError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  // ══════════ M1：权限治理弹窗（独立代码块，可整段摘除） ══════════
  /**
   * 详情页的「权限」入口。面板本体与 `#/access/<slug>` 治理台**共用同一个组件**
   * （`PageAccessPanel`）—— 两处各写一份必然漂移，而漂移的后果是权限被改错。
   *
   * 状态放在这里（而不是让面板自己带触发器）是为了让 `Dialog` 成为受控组件：
   * 关闭后 Radix 会卸载内容，面板随之下车，下次打开时重新取数（不会看到过期的档位）。
   */
  const [accessOpen, setAccessOpen] = useState(false)
  /*
   * `?access=1`：旧「权限治理」深链（`#/access/<slug>`）的落点。
   *
   * 为什么重定向到**本页的权限对话框**而不是编辑页：这个对话框对**所有有
   * `manageVisibility` 的人**都可用 —— 包括没有正文编辑权的人（只负责治理的成员）。
   * 一律送去编辑页会把这类人挡在门外（编辑页要 `canEdit`），那才是真的功能倒退。
   * 无权限时不自动弹：弹出来只会是一张"没有可见性管理权"的卡片，不如让用户正常阅读。
   */
  const wantAccess = useMemo(() => new URLSearchParams(query).get('access') === '1', [query])
  useEffect(() => {
    if (!wantAccess || page === null) return
    if (!page.capabilities.canManageVisibility) return
    setAccessOpen(true)
  }, [wantAccess, page])
  /** 只用来判「登录了没」（申请入口对匿名不显示）；**能力判据仍以 page.capabilities 为准** */
  const auth = useAuth()
  /**
   * 主页缺失时「创建主页」引导的门控（与列表页/`#/wiki/new` **同一判据**，见 `newPageEntry`）。
   * 复用它而不是在这里另写一份 `auth.capabilities.editContent === true`：两处判据一旦分叉，
   * 就会出现"引导说有编辑权、点进编辑器又被路由门禁拦下"的自相矛盾。
   */
  const newEntry = newPageEntry(auth.user, auth.capabilities)
  // ══════════════════════════════════════════════════════════════
  /*
   * 同级页面列表（用于"上一篇/下一篇"）：来自**共享 store**，不再是本组件自己的请求。
   *
   * 改动前这里是独立的 `api.pages()` + 独立 state，于是"每打开一页就重拉一次整张表"，
   * 而侧边栏也要同一份数据 ⇒ 同一份列表被反复取。现在一次取、多订阅，并在写操作后显式失效。
   * 失败不阻塞阅读：`pages.pages` 为 null 时等价于"没有上下篇"。
   */
  const pagesState = usePages()
  const siblings = pagesState.pages

  /*
   * 上一篇/下一篇：**按层级树的展示顺序**，与侧边栏完全一致。
   *
   * 改动前用的是列表页顺序（后端 `ORDER BY p.updated_at DESC, p.id DESC`），即"最近修改优先"。
   * 那个顺序对"阅读"没有意义（"下一篇"应该是"下一章"，不是"第二近修改的页"），而且与用户
   * 眼前的侧边栏层次**脱节**——实测症状：侧栏里「撰写指南」的父分组是「指南」、兄弟是「插件开发」，
   * 但"下一篇"直接跳到另一个组的「运维手册」。
   *
   * 现在用 `neighborsOf(buildNavTree(pages), slug)`：深度优先、与侧栏同一套比较器，
   * 因此"下一篇"必然是侧栏里紧邻的下一项。中间层若没有页面（纯分组）不会被计入——
   * 它不可打开，不当占一步。
   *
   * 降级：页面列表还没取到时（`pages` 为 null）两个邻居都是 undefined ⇒ 不渲染翻页条，
   * 而不是回退到"最近修改"那套错误顺序。
   *
   * ⚠️ 这个 `useMemo` **必须在下面的任何 early return 之前**：本组件有 `if (err && !page)`
   * 与 `if (!page)` 两个提前返回，把 hook 放到它们之后会让两次渲染的 hook 数量不同，
   * React 直接抛 #310（"Rendered more hooks than during the previous render"）并白屏。
   */
  const navOrder = useMemo(() => navOrderMap(pagesState.navOrder), [pagesState.navOrder])
  const neighbors = useMemo(() => {
    if (siblings === null) return { prev: undefined, next: undefined }
    /*
     * 与侧栏**同一棵树**、同一份同级顺序：`flattenPages` 会跳过被隐藏的页面与子树
     * （导航批：隐藏的页不参与"上一篇/下一篇"，否则会出现"点下一篇跳到一篇看不见的页"）。
     */
    return neighborsOf(buildNavTree(siblings, navOrder), slug)
  }, [siblings, slug, navOrder])
  const prev = neighbors.prev
  const next = neighbors.next
  /*
   * 版本对比：只记"要对比哪一版"（`id` 用来拉快照，`label` 用来显示 vN）。
   * 内容不再存于页面 —— `VersionDiffDialog` 自己拉、自己算差异，页面不参与。
   */
  const [compareTarget, setCompareTarget] = useState<CompareTarget | null>(null)
  const [restoring, setRestoring] = useState(false)
  const anchor = useHashAnchor()
  /*
   * 危险操作（删除页面 / 恢复历史版本）走统一的确认框：请求先进 state，
   * 真正的 api 调用留在 `onConfirm` 里 —— "先确认、后执行"的先后顺序
   * 在源码里也是这么排的。⚠️ 必须在下面的任何 early return 之前（React #310）。
   */
  const { request, confirm, close } = useConfirm()

  // 详情页标题需要页面数据（异步）：拿到后覆盖 App 设的路由级基线标题
  useDocumentTitle(titleForRoute(route, page?.title ?? null))

  const load = useCallback((): void => {
    setErr('')
    setLoadError(null)
    api
      .page(slug)
      .then((r) => setPage(r))
      .catch((e: unknown) => {
        setLoadError(e)
        setErr(errorLine(e))
      })
  }, [slug])

  useEffect(load, [load])

  /*
   * ---------- 别人改了正文 ⇒ 当前页自动失效（2026-09-16） ----------
   *
   * 用户报的缺陷：让 AI 助手改当前这篇文章，AI 的 `page.update` 在服务端跑完、库里已经变了，
   * 但这一页是组件 state 里那份 `api.page(slug)` 的结果，没人告诉它过期了 ⇒ 用户看到旧正文。
   *
   * 为什么这里**可以**直接重取、不必担心冲掉正在编辑的草稿：
   * 编辑路由（`route.kind === 'edit'`）根本不渲染 `WikiDetail`（它渲染编辑器）⇒
   * 本 effect 在编辑态下压根没挂载。所以这不是"忽略了编辑态"，而是那一支不存在。
   *
   * 别人改的是**别的页**时只失效列表缓存（版本号/标题列会变），不动当前正文——
   * 无谓地重取当前页会让阅读位置与滚动跳动。
   */
  useEffect(() => {
    return onContentChanged((detail) => {
      const mine = detail.slugs.length === 0 || detail.slugs.includes(slug)
      if (mine) {
        load()
        setNotice('这一页刚刚被修改，正文已自动刷新')
      }
      // 无论改的是不是这一页，列表里的标题/版本/更新时间都可能变了
      void invalidatePages()
      console.debug('[geewiki] 内容变更广播：', detail.source, detail.slugs)
    })
  }, [slug, load])

  /*
   * 文章顶部的摘要卡是**按需加载**的（`ON_DEMAND_SLOTS` 里那一份）。
   *
   * 这一步不能省：不调它，`article-summary` 插槽的贡献者永远不会被取回来，
   * 而 `ArticleSummarySlotOutlet` 在"没有贡献者"时**故意什么都不渲染**——
   * 于是症状是"摘要功能装了但页面上什么都没有"，且不报错、console 也干净。
   *
   * 放在读完页面之后（而不是模块初始化或 App 顶层）：宿主此时才**知道**自己要不要它。
   * 这正是 `ON_DEMAND_SLOTS` 的判据——"宿主是否掌握『现在要不要它』"，
   * 而不是"它是不是首屏位置"。列表页、图谱页、管理台都不该为它下载任何东西。
   */
  useEffect(() => {
    void ensureSlotLoaded('article-summary').catch(() => {})
  }, [slug])

  /*
   * 这里原来有一段"为上一篇/下一篇单独拉一次全表"的 useEffect。
   * 已删除：那份数据现在由 `usePages()` 的共享 store 提供（侧边栏也用同一份），
   * 于是打开一页不再额外产生一次 `GET /api/pages`。
   */

  /*
   * 正文渲染：先剥掉与页面标题重复的首个一级标题（既有行为），再一次性得到
   * { html, toc }。TOC 与正文**必须同源**——分开渲染会让两边各自生成 id，
   * 一旦算法有差异就会"目录点不动"。
   */
  const bodyMarkdown = useMemo(
    () => (page === null ? '' : stripDuplicateLeadingTitle(page.content, page.title)),
    [page],
  )

  /*
   * ══════ 历史快照预览（`?v=<版本 id>`，可分享的 URL）══════
   *
   * 为什么把"预览哪一版"放进 URL 而不是组件 state：这是**可分享的状态**
   * ——"你看这一版"得把链接发给别人。放进 state 就只能靠嘴描述版本号。
   * `query` 由 `App.tsx` 的 `useRouteQuery` 随 hashchange 更新（同 `create=home` 的做法）。
   */
  const previewParam = useMemo(() => parsePreviewParam(query), [query])
  /** 预览中的快照；`null` = 正在看最新版 */
  const [preview, setPreview] = useState<{ id: number; number: number; savedAt: string; content: string } | null>(
    null,
  )
  const [previewLoading, setPreviewLoading] = useState(false)
  /*
   * 非法/无权 `?v=` 的提示。**单独一个 state**，不借用列表视图的 `queryNotice`：
   * 那个提示位只在列表分支渲染，而这里要提示的是**详情页**上的失败 —— 塞进看不见的地方
   * 等于没有反馈（实测踩到过：URL 清干净了，用户却完全不知道刚发生了什么）。
   */
  const [previewNotice, setPreviewNotice] = useState('')

  useEffect(() => {
    if (page === null) return
    if (previewParam.kind !== 'ok') {
      setPreview(null)
      /*
       * ★ 参数**根本不成形**（`?v=abc` / `?v=-3` / `?v=0` / `?v=`）时也要清 URL 并说明。
       *
       * 此前这里只是 `setPreview(null); return` —— 于是坏链接**既不清 URL、也没有任何提示**，
       * 用户从聊天记录里粘一个残缺的 `?v=abc` 进来，看到的是一篇正常的最新版页面，
       * 完全不知道自己的链接没生效（而 `parsePreviewParam` 的注释明写"静默回到最新 +
       * 从 URL 清掉 `?v=`" —— 注释与实现不一致）。
       *
       * 两种非法要分开处理（`kind` 已经分好了）：
       *   - `invalid`：格式就不对（不是正整数）⇒ 提示 + 清 URL；
       *   - `absent`：压根没带 `?v=` ⇒ 正常阅读，什么都不做。
       */
      if (previewParam.kind === 'invalid') {
        onNavigate(homeMode ? '' : slug)
        setPreviewNotice(PREVIEW_INVALID_TEXT)
      }
      return
    }
    const wantId = previewParam.id
    let cancelled = false
    setPreviewLoading(true)
    api
      .version(slug, wantId)
      .then((r) => {
        if (cancelled) return
        /*
         * 版本号优先按 `versions[]` 里的名次算（`versionNumberOf` 从**总数**往下数，
         * 截断时也对，见 `lib/versionPlan.ts`）；目标不在最近 N 条里时退回
         * `page.version - total`（`total` 是快照总数，差值就是它的号）。
         */
        const idx = page.versions.findIndex((v) => v.id === wantId)
        const number = idx >= 0 ? versionNumberOf(page, idx) : Math.max(1, page.version - page.versions.length)
        setPreview({ id: wantId, number, savedAt: r.saved_at, content: r.content })
        setPreviewNotice('')
      })
      .catch(() => {
        if (cancelled) return
        /*
         * 非法 / 无权 / 已删除的快照都落这里。服务端对"不存在"与"无权"刻意回同一个 404，
         * 故文案**必须同时说出两种可能**（与仓库"404 不区分成因"的既有一致），
         * 并**从 URL 清掉 `?v=`** —— 否则用户每次刷新都要再吃一遍同样的回落。
         */
        setPreview(null)
        /*
         * 清掉 `?v=`，但**必须留在当前这一页**：
         *
         * - 主页（`homeMode`）：`onNavigate('')` 得到规范地址 `#/wiki`（而不是 `#/wiki/home`
         *   —— 那会被主页规范化再改写一次，且 `WikiDetail` 会卸载重挂、连上面那条提示一起丢）。
         * - 其它 slug：用**它自己的 slug**（`#/wiki/<slug>`）。此前这里一律用 `''`，于是
         *   `#/wiki/getting-started?v=999999` 会把读者**甩到主页**；又因为 slug 变了、
         *   `key={slug}` 变了，`WikiDetail` 重挂，`previewNotice`（组件 state）一并消失 ——
         *   用户既丢了正在读的那一页，也拿不到任何解释（实测：hash=`#/wiki`、h1=`主页`、
         *   `[role=status]` 为空）。同 slug 导航不重挂，提示因此留得住。
         */
        onNavigate(homeMode ? '' : slug)
        setPreviewNotice(PREVIEW_INVALID_TEXT)
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [previewParam, page, slug, onNavigate, homeMode])

  const previewing = preview !== null
  /*
   * slug → 标题。给正文链接改写用：判定站内链接目标是否存在（不存在则弱化标注），
   * 并把 `[[wikilink]]` 的自动显示文本换成页面真实标题。
   *
   * 必须在**任何 early return 之前**（hook 顺序不能随分支改变，否则 React 抛 #310）。
   * `pagesState.pages` 为 null 时传 null——渲染层据此**不判定"缺失"**，
   * 免得列表还没到货就把全站链接都标成"不存在"。
   */
  const pageTitles = useMemo(
    () =>
      pagesState.pages === null
        ? null
        : new Map(pagesState.pages.map((p) => [p.slug, p.title] as const)),
    [pagesState.pages],
  )
  const rendered = useRenderedMarkdown(bodyMarkdown, {
    route,
    pages: pageTitles,
    // 附件破图占位里的「申请访问」按**页面**提交（附件没有独立申请端点）
    attachmentSlug: slug,
  })
  /*
   * 预览态的正文**走同一条渲染管线**（同一个 `useRenderedMarkdown`）：它顺带给出 TOC 与
   * 站内链接改写。另起一条渲染路径，两边的 id 生成一旦有差异就会"目录点不动"。
   */
  const snapshotMarkdown = useMemo(
    () => (page === null || preview === null ? '' : stripDuplicateLeadingTitle(preview.content, page.title)),
    [page, preview],
  )
  const renderedSnapshot = useRenderedMarkdown(snapshotMarkdown, {
    route,
    pages: pageTitles,
    attachmentSlug: slug,
  })
  /** 正文卡片实际渲染哪一份：预览态用快照，否则用当前正文 */
  const shown = previewing ? renderedSnapshot : rendered
  /*
   * 目录必须跟着**正在显示的那一份**走，不能固定用当前正文的 `rendered.toc`。
   *
   * ⚠️ 2026-09-13 实测的缺陷（`#/wiki/getting-started?v=6`）：快照正文里的小节是
   * 「安装 / 特性」，而右栏目录列的却是当前版的「安装 / 下一步」—— 目录里点得到的小节
   * 在快照里**不存在**（滚不动），快照里真有的一节又不在目录里。
   * 两份文件同源（`useRenderedMarkdown` 同一个 hook），只是取的变量取错了。
   */
  const shownToc = previewing ? renderedSnapshot.toc : rendered.toc
  const tocIds = useMemo(() => shownToc.map((t) => t.id), [shownToc])
  const activeId = useActiveHeading(tocIds)

  /*
   * 右栏开不开：**只在真有内容时开**（目录 ≥2 条，或主页的「最近更新」非空）。
   *
   * 与两处组件的返回条件对齐（它们各自"没内容就返回 null"，所以不会留下空轨道）：
   *   - `TableOfContents`：`entries.length < MIN_ENTRIES(=2)` 时返回 null（TableOfContents.tsx:29,79）
   *   - `HomeAside`：最近更新为空时返回 null
   *
   * ⚠️ 2026-09-13 一度改为**恒为真**（当时右栏放了「本页信息」，它对每篇页面都有内容）。
   * 用户随后明确要求删掉「本页信息」（"那个本页信息没用"），故判据回到这里 ——
   * 没有两级标题的普通页（`welcome`）右栏整条消失、正文列独自吃满阅读区（左对齐），这是**期望**行为。
   *
   * ⚠️ 判据用 `shownToc`（预览态即快照的目录）而不是当前正文的目录：右栏列的就是
   * "你正在读的这一份"的目录。代价是**打开一个标题数不足两条的历史版本时右栏会收起**
   * （正文列随之变宽）—— 这是正确性优先的取舍：留一条空轨道比布局微动更糟。
   */
  const hasRightRail = shownToc.length >= 2 || (homeMode && siblings !== null && siblings.length > 0)

  /*
   * 锚点滚动：URL 带 `?a=<id>` 时滚到该小节。
   *
   * 依赖 `rendered.html`：首次进入（或刷新带锚点的链接）时正文刚注入 DOM，
   * 必须等它到位才能查到元素。`requestAnimationFrame` 再让一帧，避免与 React 提交赛跑。
   */
  useEffect(() => {
    if (anchor === null) return
    const raf = requestAnimationFrame(() => {
      if (scrollToAnchor(anchor)) settleHashAnchor(anchor)
    })
    return () => cancelAnimationFrame(raf)
  }, [anchor, rendered.html])

  const remove = (): void => {
    /*
     * 删除是**不可恢复**的，所以确认框里必须说清"会连带清掉多少个历史快照" ——
     * 这正是原生 `window.confirm` 表达不了的信息。
     *
     * 版本数语义已核对（`packages/plugin-wiki/src/index.ts`）：`version = COUNT(page_versions) + 1`，
     * 即当前版本号；故历史快照数 = `version - 1`（不是 `versions.length` —— 那个数组有 LIMIT，
     * 且受限主体拿到的是空数组）。
     */
    const historyCount = page === null ? 0 : page.version - 1
    confirm({
      title: `删除页面「${page?.title ?? slug}」？`,
      body: `该页面与其全部版本历史（共 ${historyCount} 条）将被永久清除，无法恢复。`,
      confirmLabel: '删除页面',
      danger: true,
      onConfirm: () =>
        api
          .deletePage(slug)
          .then(() => {
            // 列表/侧边栏必须立刻反映删除（否则会出现"点得到但打不开"的幽灵条目）
            void invalidatePages()
            /*
              写操作之后**顺带重取一次能力**（本批 T5）：角色/权限可能刚被改过（自己删了页、
              或管理员在别的标签页降了你的档），而旧入口残留会让用户"点得动、点了必然失败"。
              完整理由见 `lib/authStore.ts` 的 `refreshCapabilitiesIfVisible`。
            */
            void refreshCapabilitiesIfVisible()
            onDeleted()
          })
          .catch((e: unknown) => setErr(errorLine(e))),
    })
  }

  /**
   * 打开某一版的**对比弹窗**（`VersionDiffDialog` 自己负责拉取快照内容与算差异）。
   *
   * 为什么不在页面里存快照内容了：旧实现把"拉取 → 内联渲染在正文下方"绑成一件事，
   * 那正是卡片占一大块的来源。现在内容由弹窗持有，页面只记"要对比哪一版"。
   */
  const startCompare = (v: VersionMeta, label: number): void => {
    setCompareTarget({ id: v.id, label, savedAt: v.saved_at, author: v.author ?? null })
  }

  /**
   * 恢复某一版 —— **四位一体**（正文 + 块级权限 + 页面档位 + 发布状态）。
   *
   * ⚠️ 这里必须调服务端的恢复端点 `api.restoreVersion`，**不能**用 `api.savePage` 拿旧正文覆盖：
   * 后者只动正文，会把"恢复"做成半截动作 —— 用户以为回到了那一版，而那一版的**权限与发布态
   * 并没有回来**，于是本不该可见的内容继续可见（或反之）。这是**静默的权限不一致**，
   * 比报错严重得多。
   *
   * 代价：端点要求 `canManageVisibility`（比 `canEdit` 严，因为它在改权限），
   * 故入口门控必须与之对齐（见 `VersionDiffDialog` 的 `canRestore` 与
   * `lib/versionPlan.ts` 的 `canRestoreVersion`）；门控不齐会给用户一个点了必然 403 的按钮。
   *
   * 恢复**不原地覆盖**，而是追加一个新版本 ⇒ 老编号不会回来。确认框里如实写明。
   */
  const restore = (target: CompareTarget): void => {
    if (page === null) return
    /*
     * 确认框会盖住页面 —— 用户看不见自己选的是哪一版。
     * 故正文逐条说清三件事：覆盖谁、会新生成版本、老快照只能恢复正文。
     */
    confirm({
      title: `恢复到 v${target.label}？`,
      body: restoreConfirmBody(target.label, page.version, target.savedAt),
      confirmLabel: '恢复此版本',
      danger: false,
      onConfirm: () => {
        setRestoring(true)
        return api
          .restoreVersion(slug, target.id)
          .then((r) => {
            setNotice(restoreDoneText(r.warnings))
            setCompareTarget(null)
            setPreview(null)
            load()
            void invalidatePages() // 版本变了 ⇒ 列表里的"版本"列与排序都要更新
            void refreshCapabilitiesIfVisible() // 写操作后能力可能已变（见 remove() 的说明）
          })
          .catch((e: unknown) => {
            // 块级可见性不足时服务端会回 403 + details.blockedOrdinals：翻成人话再显示
            const blocked = restoreErrorText(e as { details?: unknown })
            setErr(blocked ?? errorLine(e))
          })
          .finally(() => setRestoring(false))
      },
    })
  }

  /*
    载入阶段的三态（互斥，由 `resolveAreaState` 判定）：错误 > 加载 > 就绪。
    `isEmpty` 恒为 false——"页面不存在"不是"空列表"，它是 404 这一**错误类别**，
    故在错误分支里按 `kind` 再分。
  */
  const detailState = resolveAreaState({
    loading: page === null && loadError === null,
    hasError: loadError !== null,
    isEmpty: false,
  })
  /*
    ⚠️ 必须在下面的任何 early return 之前调用（hook 顺序不能随分支改变，否则 React 抛 #310）。
    慢请求提示与列表/管理台/插件管理同款，避免同一个产品里两种加载反馈。
  */
  const slowDetail = useSlowHint(detailState === 'loading')
  if (detailState === 'error') {
    const view = describeError(loadError)
    const crumbs = <Breadcrumb slug={slug} title={slug} pages={siblings} />
    // 404：服务明确说没有 ⇒ 空态；重试同样的 slug 也不会变出来，故不给"重试"
    if (view.kind === 'notFound') {
      return (
        <div className="flex flex-col gap-3.5">
          {crumbs}
          {/*
            ══════ 主页缺失（homeMode 专属，独立代码块，可整段摘除） ══════
            为什么这里**必须**与普通页不同：读路径对「不存在」与「无权访问」一律 404
            （防存在性探测），普通页只能说"无法区分"；但主页是**默认落点**——用户没输错
            任何地址，却拿到一句"页面不存在，或你没有访问权限"就彻底卡住了。
            所以主页模式把"可执行的下一步"补上：有编辑权 ⇒ 几乎必然是还没创建（创建是本
            组织内的正常操作），给「创建主页」引导；否则给中性面板（不猜是哪一种原因）。
            ⚠️ 不新增"只回布尔的存在性端点"来精确区分：那会泄露"本站是否存在名为 home 的页"，
            与仓库"置灰即泄露"的既有立场冲突。
          */}
          {homeMode ? (
            newEntry.kind === 'ready' ? (
              <EmptyState
                icon={<FileText className="size-8" />}
                title="这里还没有可读的主页"
                hint="主页就是一篇普通文章（slug 为 home）：它可以编辑、有版本历史，也受页面权限管辖。建议先在编辑器里写好草稿，再决定它对谁可见、要不要发布。"
                action={
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* `new?create=home`：复用新建编辑器并预填约定 slug（理由见本文件顶部的路由注释） */}
                      <Button variant="primary" onClick={() => onNavigate('new?create=home')}>
                        创建主页
                      </Button>
                      <Button variant="secondary" onClick={() => onNavigate('list')}>
                        先去全部页面
                      </Button>
                    </div>
                    {/*
                      「创建主页」走的是 `PUT /api/pages/home`，而它是 **upsert**：页面已存在时
                      会用你写的内容覆盖它，并把被覆盖的那一版留成历史快照。
                      读路径对「不存在」与「无权访问」一律 404（防存在性探测），所以这里**无法排除**
                      "主页其实存在、只是没对当前的你开放"——那种情况下这一按就是覆盖别人的正文。
                      因此这句话必须留下（与保存时的冲突提示同一口气：说清后果，让用户自己决定）。
                    */}
                    <p className="text-note text-muted" role="status">
                      若主页其实已存在、只是没对当前的你开放，保存会覆盖它的正文；被覆盖的那一版会作为历史快照保留在版本历史里。
                    </p>
                  </div>
                }
              />
            ) : (
              <EmptyState
                icon={<FileText className="size-8" />}
                title="主页当前不可访问"
                hint="可能是这个站点还没有主页，也可能是它没有对当前的你开放。两者在服务端返回同一个结果，所以这里无法区分。"
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {newEntry.kind === 'login' && (
                      <Button variant="primary" onClick={() => loginForNewPage(true)}>
                        去登录
                      </Button>
                    )}
                    <Button variant="secondary" onClick={() => onNavigate('list')}>
                      全部页面
                    </Button>
                    <Button variant="ghost" onClick={load}>
                      重试
                    </Button>
                  </div>
                }
              />
            )
          ) : (
            /*
              ══════ M3：访问申请入口（独立代码块，可整段摘除） ══════
              为什么挂在这里：读路径对「不存在」与「无权访问」一律 404（防存在性探测），
              所以这里是"用户明确知道 slug、却读不到"的唯一落点。文案必须**坦诚无法区分**
              —— 写"你没有权限，请申请"就是把"不存在"说成了"无权"（服务端刻意不给这个信息，
              前端不许猜）。匿名不显示申请入口：该端点要求已登录（401）。
            */
            <EmptyState
              icon={<FileText className="size-8" />}
              title="页面不存在，或你没有访问权限"
              hint="服务端对「不存在」与「无权访问」返回同一结果，所以这里无法区分。若你确认它存在，可以提交一次访问申请。"
              action={
                <>
                  <Button onClick={() => onNavigate('list')}>返回列表</Button>
                  {auth.user !== null && <ApplyAccessDialog slug={slug} />}
                </>
              }
            />
          )}
        </div>
      )
    }
    // 其它失败（网络/服务端）：我们**不知道**它是否存在 ⇒ 错误态 + 重试
    return (
      <div className="flex flex-col gap-3.5">
        {crumbs}
        <ErrorState
          title={view.title}
          hint={view.hint}
          onRetry={view.retryable ? load : undefined}
        />
      </div>
    )
  }
  /*
    写成 `page === null` 而不是 `detailState === 'loading'`：两者在此**等价**
    （error 分支已提前返回），但前者能让 TypeScript 收窄 `page` 的类型，
    从而不必在下面十几处用非空断言。
  */
  if (page === null) {
    /*
      骨架与真实详情页**同构**（面包屑行 → 元信息 + 操作按钮行 → 正文卡片 → 上/下一篇），
      而不是一叠等高条。理由见 `ui/Skeleton.tsx` 的注释：骨架必须与最终尺寸一致，
      否则数据到达时照样布局跳动（CLS），骨架屏就白做了。
      加载反馈统一走 `LoadingState`（role="status" + aria-live + aria-busy + 慢请求文案），
      与列表页/管理台/插件管理一致；此前这里是裸 `aria-busy` + 一个多余的 Spinner。
    */
    return (
      <LoadingState slow={slowDetail} label="正在加载页面…">
        {/*
          骨架必须与真实阅读页**同构**，而且是**同一套 `.gw-reader-grid` 类**。

          ⚠️ 2026-09-13 第二版修的就是这里：此前骨架是一叠**整宽**的 `flex flex-col` 方块，
          而真实页面是栅格（面包屑/正文在正文列、右栏在第 2 列）⇒ 每次切文章都要先闪一屏
          整宽方块、再整体右移约 165px 并收窄，用户原话"切换文章时闪烁"。
          实测（1920，人为把接口延迟 2500ms）：加载态面包屑 x=324、宽 734 的正文块，
          加载完成后面包屑 x=193、正文列 489..1431 —— 一整屏的位移。
          骨架一律按"有右栏"渲染：编辑权/目录条数都要等页面数据到了才知道，
          而绝大多数页面有右栏；真有例外时（目录不足两条）也只差右栏那一列。

          ⚠️ 正文那一段**不要再套卡片**（border/bg/shadow/padding）：真实正文早已去掉卡片外观
          （用户原话"那个本页信息没用，去掉"那一轮同时去掉了卡片），套上去等于先闪一张卡片再消失。
        */}
        <div className="gw-reader-grid has-rail">
          {/* 面包屑：`知识库 › 标题`（第 1 列，与正文同左缘） */}
          <Skeleton className="h-4 w-48" />

          {/* 操作条：左侧「版本 vN」徽标 + 更新时间，右侧编辑/删除按钮 */}
          <div className="gw-reader-actions flex flex-wrap items-center gap-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-4 w-40" />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-20" />
            </div>
          </div>

          {/* 正文（第 1 列）：标题 + 若干**不等宽**段落行 + 一个代码块占位 */}
          <div className="gw-reader-main flex min-w-0 flex-col gap-4">
            <div>
              <Skeleton className="h-7 w-1/2" />
              <div className="mt-6 flex flex-col gap-2.5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="mt-3 h-16 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>

            {/* 上一篇 / 下一篇：窄屏堆叠、宽屏两列（与真实布局同一断点） */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>

          {/* 右栏（第 2 列）：目录占位，窄屏与真实右栏同一断点隐藏 */}
          <div className="gw-reader-rail hidden min-w-0 flex-col gap-2.5 xl:flex">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-36" />
          </div>
        </div>
      </LoadingState>
    )
  }


  return (
    /*
      阅读页的整体栅格（2026-09-13 第二版定稿）。
      **两列**：`[正文列 minmax(0,1fr)] [右栏 240px]`，列里从上到下是
      面包屑 / 动作条 /（预览条）/ 正文，右栏是页内目录；左缘全部对齐正文。
      · 正文列 = 阅读区里除右栏外的**全部**宽度（用户选定"正文列吃满中间、行宽上限同步放宽"）；
      · 右栏与动作条上的按钮组**同右缘**（`本页目录的宽度与上面那三个按钮整体同宽`）；
      · 没有右栏时（目录不足两条且非主页）退化成单列：正文按 `--spacing-measure` 封顶，
        但**左缘与有右栏时相同**（否则"从有目录的文章切到没目录的文章"会整块左右跳）。
      · 第一版那条"左侧留白 + `translateX(-131px)` 整页居中"已删除：它既留下 187px 的
        空白带（用户圈出的"空得太多了"），又让栅格盒子压住侧栏右半边、把侧栏链接点掉了，
        还把面包屑推进了那一列（"面包屑的位置奇怪"）。缘起与实测写在 styles.css 的
        `.gw-reader-grid` 那段注释里。
    */
    <div
      className={cn(
        'gw-reader-grid',
        hasRightRail && 'has-rail',
      )}
    >
      <Breadcrumb slug={slug} title={page.title} pages={siblings} />

      {/* 操作条：默认操作（编辑）在最右，破坏性操作（删除）用 danger 变体且与主操作隔开 */}
      <div className="gw-reader-actions flex flex-wrap items-center gap-2">
        {/*
          ★ P6：元信息行是一个宿主节点（`wiki-meta`）。
          三种模式都开：插件可以只加一条（extend，如"阅读时长"）、可以加壳（wrap）、
          也可以整块换成自己的元信息条（replace）。无贡献时 `<Ext>` 直接返回 children，
          DOM 与接线前**逐字一致**（栅格列由 `.gw-reader-actions` 的类名决定，不受影响）。
        */}
        <Ext id="wiki-meta">
        <div className="flex items-center gap-1.5 text-xs text-muted">
          {/*
            有编辑权 ⇒ 可下拉选版本；无编辑权 ⇒ **纯文本徽标**（不是禁用态按钮）。
            理由见 `VersionPicker` 文件头：置灰本身就在暗示"这里有个你够不着的能力"，
            而版本内容对只读者本来就不该开放（快照端点非 canEdit 一律 404）。
          */}
          {page.capabilities.canEdit ? (
            <VersionPicker
              slug={slug}
              page={page}
              previewNumber={preview?.number ?? null}
              onPreview={(id, label) => {
                /*
                 * `id === 0` 是下拉顶部那条「最新」的约定值 —— 它代表**退出预览**
                 * （回到不带 `?v=` 的地址），而不是"预览第 0 版"。
                 */
                void label
                onNavigate(id === 0 ? slug : previewRoute(slug, id))
              }}
              onCompare={startCompare}
            />
          ) : (
            <>
              {/*
                只读视角：静态徽标 + 一个「历史」入口。给的是**存在性信息**（改过几次、
                什么时候动的），不给快照正文与恢复 —— 那两个能力服务端都不放行，
                给出入口就是给出必然失败的按钮（理由见 `ReadonlyHistoryButton` 的文件头）。
              */}
              <VersionBadge version={page.version} />
              <ReadonlyHistoryButton slug={slug} page={page} />
            </>
          )}
          <span>更新于 {fmtTime(page.updated_at)}</span>
          {/* 快照在途：给一句可见反馈，免得"点了没反应"被当成坏了 */}
          {previewLoading && <span className="text-2xs text-muted" role="status">正在加载该版本…</span>}
        </div>
        </Ext>
        {/* ★ P6：操作按钮组是另一个宿主节点（`wiki-actions`）——与元信息行分开 */}
        <Ext id="wiki-actions">
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {notice !== '' && (
            <span className="rounded-md border border-ok-line bg-ok-bg px-3 py-1 text-note text-ok-ink">
              {notice}
            </span>
          )}
          {err !== '' && (
            <span className="rounded-md border border-danger-line bg-danger-bg px-3 py-1 text-note text-danger-ink">
              {err}
            </span>
          )}
          {previewNotice !== '' && (
            <span role="status" className="rounded-md border border-warn-line bg-warn-bg px-3 py-1 text-note text-warn-ink">
              {previewNotice}
            </span>
          )}
          {/*
            ★ P2：按钮按**服务端下发的能力**条件渲染。
            这里隐藏只是体验，安全判定在服务端（写路径另有强制）—— 把隐藏当判定
            是本设计通篇点名的反模式。
          */}
          {/* ══════ M1：权限治理入口（独立代码块，可整段摘除） ══════ */}
          {/*
            门控 `canManageVisibility`（**不是** canEdit）：能编辑不等于能改"谁能看"，
            两者是服务端下发的两个字段。无权限时**不渲染**（不是置灰 —— 置灰本身
            就在暗示"这里有个你够不着的能力"）。

            ⚠️ 预览历史版本时**同样整块不渲染**：那是只读态，此时改档位/删除/编辑都要么
            语义错乱（改的是"当前版"而用户看的是旧版正文）、要么必然失败。这里刻意不用
            `disabled + title` —— 置灰按钮仍然在暗示"够得着"，而且 `title` 对触屏与读屏
            都不可达（本仓库既有纪律）。**出口是预览条上的「返回最新」**，它自己会说明。
          */}
          {page.capabilities.canManageVisibility && !previewing && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldCheck className="size-3.5" />}
              onClick={() => setAccessOpen(true)}
            >
              权限
            </Button>
          )}
          {/* ══════════════════════════════════════════════════════ */}
          {page.capabilities.canDelete && !previewing && (
            <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={remove} disabled={restoring}>
              删除
            </Button>
          )}
          {page.capabilities.canEdit && !previewing && (
            <Button
              variant="primary"
              size="sm"
              icon={<Pencil className="size-3.5" />}
              onClick={onEdit}
            >
              编辑
            </Button>
          )}
        </div>
        </Ext>
      </div>

      {/*
        预览态状态条：说清"你在看的是哪一版、它是只读的、以及附件的判定口径与正文不同"。
        附件那句不是免责声明而是**真会发生的差异**：快照正文按保存时显示，而附件下载
        按**当前**正文的引用判定（见后端下载端点），所以历史里的图片可能打不开。

        ⚠️ `gw-reader-preview` 不是装饰：栅格里必须显式声明它落在第 1 列（正文列）。
        此前它没有任何列号，自动放置把它丢进**右侧那一列**（当时是正文列/留白列），
        实测宽 240px、与侧栏在横向重叠，整块栅格还跟着回流 —— 打开历史版本时的
        "样子不对"就是它（见 styles.css 的 `.gw-reader-grid` 注释）。
      */}
      {preview !== null && (
        <div
          role="status"
          className="gw-reader-preview flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-note text-warn-ink"
        >
          <span>{previewBarText(preview.number, preview.savedAt)}</span>
          <span className="text-2xs opacity-80">{PREVIEW_ATTACHMENT_NOTE}</span>
          {/*
            预览态下「编辑 / 权限 / 删除」被禁用（不是隐藏）。这里用**可见文字**说明原因而不是
            只挂 Tooltip：Tooltip 在禁用按钮上根本触发不了（禁用元素不派发指针事件、也不可聚焦），
            触屏与读屏用户更拿不到 —— 那等于把唯一的解释挂在了够不着的地方。
          */}
          <span className="text-2xs">历史快照是只读的：要编辑请先返回最新版本。</span>
          <span className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => onNavigate(slug)}>
              返回最新
            </Button>
            {canRestoreVersion(page) && (
              <Button
                variant="primary"
                size="sm"
                icon={<RotateCcw className="size-3.5" />}
                disabled={restoring}
                onClick={() =>
                  restore({ id: preview.id, label: preview.number, savedAt: preview.savedAt, author: null })
                }
              >
                恢复此版本
              </Button>
            )}
          </span>
        </div>
      )}

      {/*
        两栏：正文（含历史）在左，目录/最近更新在右。
        `xl`（1280px）以下回落成单栏，目录改为正文上方的可折叠块（两份 TOC 由组件内部
        用 `xl:hidden` / `hidden xl:block` 互斥显示，因此任何时刻只有一份出现在无障碍树里）。
      */}
      {/*
        右栏**只在真的有东西时**才开：`TableOfContents` 在标题数不足 2 时返回 `null`，
        `HomeAside` 在列表为空时也返回 `null`。没有内容时回落单栏 —— 单栏分支**同样**
        把列宽封在 `--spacing-measure`（见下面栅格上的注释），所以"没有右栏"不等于
        "正文列被拉满整屏"，两件事必须分开处理。

        ⚠️ 主页必须**单独计入**：主页正文通常没有 2 个以上标题（`rendered.toc` 为空），
        于是此前主页永远是单栏 ⇒ 「最近更新」被排到正文**下方整宽**，实测 1440 视口下
        它落在 y=1017.8（首屏 900 之外），而主页正文却写着"或右侧「最近更新」里的入口"
        —— 指引指向的位置根本不在首屏、也不在右侧。计入后主页在 xl 以上得到真正的右栏，
        指引与实际渲染一致（正文文案同时已订正为"右侧栏"）。
      */}
      {/*
        正文与右栏都直接挂在**外层** `.gw-reader-grid` 上（本块此前是一层多余的
        `div.grid`）：列宽、块宽、行宽三件事统一归 styles.css 的 `.gw-reader-grid`，
        这里不再有第二套栅格。各子项的 `grid-column` 也全部由那里声明
        （面包屑/预览条/正文在第 1 列，动作条占满整行、按钮与右栏同右缘）。

        ⚠️ 两个必须保留的既有结论：
          · 双栏只在 `xl`（1280px）以上生效 —— `md`~`xl` 之间用两列会把正文列挤到 177px；
          · 不要再给卡片加 `width`/`margin-inline`（历史上"卡片限宽 + 居中"造成过 86px 阶梯）。
      */}
        <div className="gw-reader-main flex min-w-0 flex-col gap-4">
          {/*
            ★ P6：目录是一个宿主节点（`wiki-toc`），**两处渲染点共用同一个 id**：
            窄屏这里是正文上方的折叠块，`xl` 以上是右栏那份。
            共用 id 是刻意的——插件说的是"文章页的目录"，不是"某一个断点下的目录"；
            分两个 id 会让插件作者被迫为同一件事声明两次（且很容易漏掉窄屏那份）。
          */}
          <Ext id="wiki-toc">
            <TableOfContents entries={shownToc} activeId={activeId} route={route} variant="inline" />
          </Ext>

          {/*
            阅读卡片：宽度**跟着栅格列走**，自己不设宽（口径见 styles.css 那段长注释）。
            卡片与同列的「上一篇/下一篇」「相关页面」共用同一个栅格列 ⇒ 左缘天然一致；
            正文 `.md-body` 另有 `--spacing-measure` 封顶（`min(84rem, 92em)`，14px 下 1288px），
            它只在**没有右栏的单列页**上真正生效 —— 有右栏时正文列本身就只有 1278px，
            所以列里不会出现"卡片很宽、正文很窄"的空洞。
          */}
          {/*
            ⚠️ 这里**刻意没有卡片外观**（无 bg/border/shadow/padding，2026-09-13 用户反馈）：
            此前是 `rounded-lg border border-line bg-surface px-6 py-6 shadow-sm sm:px-8`，
            卡片左右各吃 32px 内边距 ⇒ 在一张 824px 的卡片里正文只有 760px，
            正文右侧留着一条肉眼可见的空白带（用户原话："正文那里…红色框住的那部分空白"）。
            去掉卡片后正文左缘 = 栅格列左缘、右缘 = 列右缘，不再有卡内空白；
            列宽也就等于正文宽（不再需要"列宽 = 正文 + 2×内边距"的换算）。
          */}
          <article className="gw-reader">
            <h1 className="mt-0 mb-3 text-2xl leading-tight font-bold text-ink">{page.title}</h1>
            {/*
              ★ 折叠摘要卡：渲染在 `<h1>` **之后**、正文之前（2026-09-17 用户要求调整位置）。

              本插槽刚落地时它渲染在标题**之前**（"文章最上方"的字面要求，旧注释曾写下一版
              理由：折叠态是一行高的横条，出现在标题之前读起来是"这一页的入口"）。用户看过
              之后要求挪到**标题下面**：标题先立住"这一页是什么"，摘要再作为它的补充跟在
              后面。代价是它不再是最先被看到的那一行，换来的是**标题始终是文章的第一行**。

              没有贡献者时这个组件返回 `null`（不留占位）：文章页没有摘要本来就是常态，
              补一句"暂无摘要"只会让每一篇文章顶部多一行噪音。
            */}
            <ArticleSummarySlotOutlet slug={page.slug} title={page.title} />
            {shown.html === '' ? (
              <p className="text-sm text-muted">（空白页面 —— 点击「编辑」写入内容）</p>
            ) : (
              <MarkdownBody html={shown.html} className="md-body" />
            )}
          </article>

          {(prev !== undefined || next !== undefined) && (
            <nav aria-label="相邻页面" className="grid gap-3 sm:grid-cols-2">
              <SiblingLink
                kind="prev"
                page={prev}
                onNavigate={onNavigate}
              />
              <SiblingLink
                kind="next"
                page={next}
                onNavigate={onNavigate}
              />
            </nav>
          )}

          <PageLinks slug={page.slug} />

          {/*
            改动记录**不再常驻正文下方**（这里原来有一块紧凑列表，再往前是一整张「版本历史」卡片）。
            为什么彻底移走：正文下方任何常驻的版本列表都是"与正文争版面"的东西 —— 用户的原话是
            "放在下面占这么大块位置不合适"。现在改动的入口只有一个：**头部左上角的版本下拉**
            （`<VersionPicker>`），它把"当前版本 + 最近改动 + 更早的版本 + 改动摘要"收在一个
            按需展开的浮层里；需要铺开看时走它内部的「浏览全部历史…」弹窗 ——
            **用户主动打开的弹窗占版面是合理的，常驻的列表不是**。

            信息没有丢：条数摘要（共 N 次改动 / 更早的未列出）在下拉的底部一行，见
            `VersionPicker` 的 `versionCountText`；无编辑权者仍能在头部看到静态版本号徽标。
          */}
        </div>

        {/*
          右栏：主页的「最近更新」（若有）+ 页内目录。**两块都是"没有内容就自己返回 null"**
          （TOC 在标题数不足 `MIN_ENTRIES` 时、HomeAside 在列表为空时）⇒ 不会留下空轨道。

          ⚠️ 2026-09-13：这里的「本页信息」（`PageInfoAside`）**已按用户要求删除**
          （原话："那个本页信息没用，去掉"），`hasRightRail` 的判据也随之回到"真有内容才开"。

          ⚠️ `xl:flex` 不是装饰：栅格在 **1280px 以下**是单列（`.gw-reader-grid` 的双栏
          规则带 `@media (min-width: 1280px)` 门槛），若这里不隐藏，右栏三块会作为**第二行**
          落在正文下方 —— 实测 1024 档「本页信息」被摊成整宽 703px，栅格高度凭空多出一截，
          且该行的 x 变成父容器的 x（与正文列不再对齐）。隐藏后窄屏回到"纯单栏"，与改动前一致。
        */}
        <div className="gw-reader-rail hidden min-w-0 flex-col gap-4 xl:flex">
          {homeMode && <HomeAside pages={siblings} onNavigate={onNavigate} />}
          <Ext id="wiki-toc">
            <TableOfContents entries={shownToc} activeId={activeId} route={route} variant="sidebar" />
          </Ext>
        </div>

      {/*
        版本对比弹窗。`canRestore` 传的是 `canManageVisibility` 而不是 `canEdit`：
        恢复会改写页面状态（而服务端的四位一体 restore 端点正是要求这个能力），
        让只有编辑权的人看到"恢复"按钮会给出一个点了必然失败的入口。
      */}
      <VersionDiffDialog
        slug={slug}
        page={page}
        versions={page.versions}
        target={compareTarget}
        onClose={() => setCompareTarget(null)}
        onRestore={restore}
        restoring={restoring}
        canRestore={page.capabilities.canManageVisibility}
      />

      {/* 危险操作确认（删除页面 / 恢复历史版本）：确认之后才真的调 api */}
      <ConfirmDialog
        request={request}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      />

      {/* ══════ M1：权限治理弹窗（独立代码块，可整段摘除） ══════ */}
      {/*
        与 `#/access/<slug>` 治理台**同一个面板**。这里不传 `onNavigate`：
        弹窗内的"返回入口"没有意义（关掉弹窗就回到了详情页）。
      */}
      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        <DialogContent
          title="权限设置"
          /*
            描述只列**这个弹窗里真的有**的三件事。曾经写着"块级授权"，而块级分区后来按作者要求
            从面板移除了 —— 文案比界面多承诺一件事，用户就会在里面找一个不存在的控件。
            段落档位不在这里：它在**编辑器**里（工具栏的锁按钮 / 源码模式写标记）。
          */
          description="页面档位、例外授予与访问申请。段落级档位在编辑器的正文里改（工具栏最右的锁按钮）。"
          className="w-[min(48rem,calc(100vw-2rem))]"
        >
          {accessOpen && <PageAccessPanel slug={slug} />}
        </DialogContent>
      </Dialog>
      {/* ══════════════════════════════════════════════════════ */}
    </div>
  )
}

/** 历史快照预览：只要 HTML，不要复制按钮（只读小窗里按钮是噪声） */
function _renderMarkdownBodyForPreview(
  markdown: string,
  route: string,
  pages: ReadonlyMap<string, string> | null,
  attachmentSlug: string | null,
): string {
  return renderMarkdownBody(markdown, {
    withCopyButtons: false,
    route,
    pages,
    attachmentSlug,
  }).html
}

function SiblingLink({
  kind,
  page,
  onNavigate,
}: {
  kind: 'prev' | 'next'
  page: PageSummary | undefined
  onNavigate: (path: string) => void
}): ReactNode {
  const isPrev = kind === 'prev'
  // 空位也渲染占位，保持两列对齐（只有一个相邻页时不会一边塌陷）
  if (page === undefined) return <span aria-hidden="true" />
  return (
    <a
      href={`#/wiki/${encodeURIComponent(page.slug)}`}
      onClick={() => onNavigate(page.slug)}
      className={cn(
        'gw-focus-ring group flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong hover:bg-hover',
        !isPrev && 'sm:text-right',
      )}
    >
      <span className="flex items-center gap-1 text-xs text-muted">
        {isPrev ? (
          <>
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            上一篇
          </>
        ) : (
          <>
            下一篇
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </>
        )}
      </span>
      <span className="truncate text-sm font-medium text-accent group-hover:underline">
        {page.title}
      </span>
    </a>
  )
}

/* ============================ 编辑 / 新建 ============================ */

/**
 * 草稿的 localStorage 读写（薄封装）。
 *
 * 与 `draftPlan.ts` 分开：那里是**纯逻辑**（可在 node 里单测），这里碰浏览器 API。
 * 全部 try/catch：隐私模式下 localStorage 会**抛异常**，草稿功能不能因此让编辑页打不开。
 */
function readDraft(slug: string): DraftRecord | null {
  try {
    return parseDraft(window.localStorage.getItem(draftKey(slug)))
  } catch {
    return null
  }
}

/**
 * 写草稿。**返回是否真的写进去了**。
 *
 * 为什么必须返回布尔：`localStorage.setItem` 在配额满或隐私模式下会**抛异常**。
 * 早先这里吞掉异常、调用方照样显示"草稿已自动保存"——那是最坏的一种谎报：
 * 用户据此认为改动已经保住，然后放心关掉页面，改动就真的没了。
 * 现在失败会被如实报出来（见 WikiEdit 的 `draftFailed`）。
 */
function writeDraft(slug: string, draft: DraftRecord): boolean {
  try {
    window.localStorage.setItem(draftKey(slug), serializeDraft(draft))
    return true
  } catch {
    /* 配额满/被禁用：放弃这次草稿，不影响编辑（由调用方提示用户手动保存） */
    return false
  }
}

function removeDraft(slug: string): void {
  try {
    window.localStorage.removeItem(draftKey(slug))
  } catch {
    /* 同上 */
  }
}

function WikiEdit(props: {
  slug: string
  onDone: (slug: string) => void
  onCancel: () => void
  /**
   * 「以新建的方式编辑这个 slug」——目前唯一的调用方是主页的**创建引导**。
   *
   * 为什么需要它：新建与编辑的判据是 `slug === ''`，而主页有**约定 slug**（`home`），
   * 于是"创建主页"会被当成"编辑一个不存在的页"，加载必然失败、编辑器根本出不来。
   * 预填 slug + 跳过加载，就得到"我已经知道要叫什么，只差写内容"的正确语义。
   *
   * 只影响这一支：不传时行为与改动前逐字一致。
   */
  prefillSlug?: string
}): ReactNode {
  const { slug, onDone, onCancel, prefillSlug } = props
  /** 新建语义 = 空 slug（`#/wiki/new`）或"预填 slug 的创建"（主页引导） */
  const newMode = slug === '' || prefillSlug !== undefined
  const isNew = slug === ''
  /*
    「创建主页」与「新建页面」走的是**同一个**新建编辑器，但它们是两件事：
    前者有约定 slug（`prefillSlug === HOME_SLUG`），标题与面包屑必须说"创建主页"——
    否则用户在主页缺省面板点「创建主页」，进来看到的却是"新建页面"，会以为自己点错了。
    ⚠️ 必须声明在 `save()` 之前：`save()` 要用它决定"建完主页之后留不留在本页"，
    而它只依赖 `prefillSlug`（无需等任何 state/effect），所以这里就能定下来。
  */
  const createHomeMode = prefillSlug === HOME_SLUG
  /** 本编辑页自身的 hash（未保存离开后要退回它） */
  const selfHash = isNew ? '#/wiki/new' : `#/wiki/${slug}/edit`
  const route = isNew ? 'wiki/new' : `wiki/${slug}/edit`

  const [slugInput, setSlugInput] = useState(prefillSlug ?? slug)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  /** 「按访客视角预览」对话框：原先是与编辑区并排的第二个面板，现改为按需打开（编辑区独享整宽） */
  const [previewOpen, setPreviewOpen] = useState(false)
  /**
   * 「授权给谁…」的目标段落（编辑器的锁菜单打开它）。
   *
   * 编辑器只交出 `{ ordinal, excerpt }`：它不认服务端的块 id（那块是保存时解析出来的），
   * 换算是 `BlockGrantsDialog` 的职责（按 ordinal 在 `GET /api/pages/:slug/blocks` 里找）。
   */
  const [grantBlock, setGrantBlock] = useState<{ ordinal: number; excerpt: string } | null>(null)
  /**
   * 页面档位（M1）——**只读**，用于编辑器里"块档位不能宽过页面档位"的提示。
   *
   * 为什么编辑页不再放档位设置：页面档位属于"这条目对谁可见"的治理动作，它的入口在
   * 页面自己的「权限」对话框（阅读页）里 —— 那里同时有例外授予与访问申请，是**一处完整**的
   * 治理界面。编辑页放第二份会出现两个可编辑的档位控件（本地状态各自为政、"只发改动过的
   * 字段"的部分更新还会拿旧基线发反向 patch）。编辑页只保留**段落档位**（写在正文里，
   * 用编辑器工具栏的锁按钮改）与这份只读的页面档位。
   */
  const [pagePerm, setPagePerm] = useState<{
    visibility: PageVisibility
    inherit: boolean
    published: boolean
  } | null>(null)
  /**
   * 「正文里有服务端占位文案」的保存拦截。
   *
   * 来路：旧客户端写下的草稿（当年存的是**投影后**的正文）或用户粘贴了带占位的文本。
   * 直接保存会把占位写进正文，并**丢掉段落权限标记** ⇒ 受限段落静默变成公开。
   * 故保存前拦一次、把两条路都摆出来（重新加载原文 / 仍然保存），而不是默默替他决定。
   */
  const [projectedGuard, setProjectedGuard] = useState(false)
  const [loading, setLoading] = useState(!newMode)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [fieldErrors, setFieldErrors] = useState<PageFormErrors>({})
  /** 待用户决定的草稿（进入编辑页时读到的） */
  const [pendingDraft, setPendingDraft] = useState<DraftRecord | null>(null)
  /** 草稿最近一次落盘时间（0 = 尚未写过），给用户"到底存没存"的确定性 */
  const [draftSavedAt, setDraftSavedAt] = useState(0)
  /** 最近一次草稿落盘**失败**（localStorage 不可用/配额满）—— 必须如实告知，不能显示成"已保存" */
  const [draftFailed, setDraftFailed] = useState(false)
  /*
   * 面包屑要展示完整层级，这需要"哪些前缀真的有页面"。编辑页同样从**共享 store** 取，
   * 不额外发请求（与侧栏、详情页同一份数据）。
   * ⚠️ 必须在下面的 early return 之前调用（hook 顺序不能随分支改变，否则 React 抛 #310）。
   */
  const editPages = usePages().pages
  /*
   * slug → 标题（预览面板的链接改写用，与详情页同一套语义）。
   * 与详情页一样必须在任何 early return 之前调用。
   */
  const editPageTitles = useMemo(
    () => (editPages === null ? null : new Map(editPages.map((p) => [p.slug, p.title] as const))),
    [editPages],
  )
  /** 保存冲突：服务端的 updated_at 与本页加载时不同 */
  const [conflictAt, setConflictAt] = useState<string | null>(null)
  const [origSlug, setOrigSlug] = useState('')
  /**
   * 附件上传的可见提示（M4）。
   *
   * 为什么**不复用** `err`（保存失败那条）：`save()` 一开始就 `setErr('')`，一次保存会把
   * 上传的失败原因顺手抹掉；而"请先修正下面标出的问题"与"这个文件太大"是两件事，
   * 挤在同一行会互相盖掉。故另起一格，但**沿用同一套配色与语义**：
   * `err` 用 `role="alert"` + 危险色，成功用 `role="status"` + 成功色。
   * 静默是绝对不允许的 —— 拖进来一个文件然后什么都没发生，用户只会以为功能坏了。
   */
  const [uploadNotice, setUploadNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  /**
   * 「主页刚创建」的**常驻**提示（仅创建主页这一条路径、且仅 `outcome === 'created'`）。
   *
   * 为什么必须常驻而不能像别处那样"提示完就跳走"：新页面的默认档位是 **`org` 且未发布**
   * （见 `packages/plugin-wiki/src/index.ts:1141-1142` 的 `VALUES (…'org', 1, 0, ?)` 与
   * `:2133-2135` 的"`public` 档必须同时发布才对匿名可见"）。主页是**默认落点**——
   * 建完却不对匿名开放，访客打开站点只会看到"主页当前不可访问"的中性面板，而**没人会告诉他
   * 这是档位问题**。所以这一条要给的是"下一步动作"：去页面上的「权限」把档位设为公开并
   * 打开「已发布」。
   *
   * 为什么 `outcome === 'updated'` 时**不显示**：那种情况是**覆盖了已存在的页面**，
   * 提示的口径完全不同（"主页已存在，你覆盖了它的正文"），且保存前的引导里已经讲过后果。
   * 两条挤在一起会互相盖掉，也会把"新建"说成"覆盖"——那是本仓库最忌讳的说错话。
   *
   * 与 `uploadNotice` 分开一格的理由同上：一次保存会 `setErr('')`，且上传反馈与创建反馈
   * 可能同屏发生，共用一个槽位必然互相抹掉。
   */
  const [homeCreatedNotice, setHomeCreatedNotice] = useState<string | null>(null)

  /*
    AI 辅助写作（编辑器内）：选区由编辑器上报，采纳写回走编辑器的插入句柄。
    工具条本体在**插件**里（`editor-toolbar` 插槽），故这里没有"插件是否激活 / 模型是否就绪"
    的探测 —— 那两件事由插件自己的 capabilities 端点回答给自己的界面。宿主只负责把
    "此刻编辑器里发生了什么"如实交出去：选区、正文、以及两条写回通道。
  */
  const [editorSelection, setEditorSelection] = useState<EditorToolbarSelection | null>(null)
  /*
   * ★ F5：插件编辑器的两条回传通道（都与内置编辑器路径**并存但互斥**）：
   * - `pluginEditorHandle`：插件交出的命令式句柄，供 `editor-toolbar` 写回；
   * - `pluginEditorSelection`：插件上报的选区，供工具栏点亮依赖选区的动作。
   *
   * 两者独立：插件只报选区而不给句柄时，工具栏仍应把"采纳"类动作保持禁用
   * （只知道光标在哪、没有办法写回去）。
   */
  const [pluginEditorHandle, setPluginEditorHandle] = useState<EditorHandle | null>(null)
  const [pluginEditorSelection, setPluginEditorSelection] = useState<EditorToolbarSelection | null>(null)
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null)

  /** 加载时的基线（脏值比较用 state 而非 ref：比较结果要参与渲染） */
  const [original, setOriginal] = useState<PageDraft>({ title: '', content: '', slugInput: slug })
  /** 本页加载时服务端的 updated_at；保存前用它检测"别人改过了" */
  const serverUpdatedAt = useRef<string | null>(null)

  const dirty = isDirty(original, { title, content, slugInput })
  /*
   * `editor` 插槽：有插件贡献时用它替代内置 CodeMirror。
   *
   * ⚠️ 这两个 hook 必须在下面的任何 early return 之前（React #310：hook 顺序不能随分支改变）。
   *
   * **宿主职责刻意留在插槽外面**：草稿落盘、脏值判定、未保存离开拦截、保存冲突检测、
   * 字段校验全部由本组件继续负责（下面这些既有逻辑一行未改），插件只拿到
   * `value` / `onChange` / `onSave` / `onCancel` 几个出口。
   * 这样两条路径（插件编辑器 / 内置编辑器）在宿主侧的语义是**同一套代码**——
   * 换编辑器不会丢掉草稿保护、冲突检测或未保存拦截。
   */
  const editorSlot = useEditorSlot()
  useEffect(() => {
    // 懒加载：只贡献 editor 的插件，其 client.js 推迟到真正进入编辑视图才请求。
    // 失败不阻塞编辑（回落内置编辑器），故只 catch 不弹错。
    void ensureSlotLoaded('editor').catch(() => {})
    // 工具条插槽同样按需在进入编辑视图时加载（`editor-toolbar` 也在 ON_DEMAND_SLOTS 里）。
    // 漏掉这一句的后果很隐蔽：辅助写作插件的入口表条目是"生效"的（管理台看着一切正常），
    // 但组件永不注册 ⇒ 工具条区域**静默空白**，与"该插件没提供界面"长得一模一样。
    void ensureSlotLoaded('editor-toolbar').catch(() => {})
  }, [])

  /*
    `editor.*` 客户端工具（P3）：**宿主**登记处理器，`@geewiki/ai-writing` 在服务端声明同名
    描述符（工具就是这两半，见 `lib/editorTools.ts` 文件头）。为什么处理器在宿主：编辑框句柄
    与"此刻能不能写回"只有宿主知道。

    值经 ref 传递、注册只做一次 —— 不能把 `content` / `editorSelection` 放进 effect 依赖：
    那会让**每敲一个字**都注销再重登记一遍工具，而工具名单要经轮次协议上送服务端参与构成
    发给模型的工具表，名单每帧都变 ⇒ 每轮请求前缀都变 ⇒ 上游前缀缓存全失效。
    （同样的"最新值 ref"写法见 `components/MarkdownEditor.tsx:462`。）
  */
  const editorToolLiveRef = useRef<EditorCapability>({
    slug: newMode ? '' : slug,
    readOnly: saving,
    docText: () => content,
    selection: editorSlot ? null : () => editorSelection,
  })
  editorToolLiveRef.current = {
    slug: newMode ? '' : slug,
    readOnly: saving,
    docText: () => content,
    /*
      ★ F5：插件编辑器占住 `editor` 插槽时，选区改由**插件上报**（`onSelectionChange`）。
      宿主现在**总是**提供这条通道，故这里不再无条件返回 `null` ——
      插件没上报过就是"当前无选区"，与内置编辑器下没有选区的语义一致。
    */
    selection: editorSlot ? () => pluginEditorSelection : () => editorSelection,
    /*
      ★ F5：写回通道跟着**句柄**走，不跟着"谁占着插槽"走。
      插件交了句柄 ⇒ 三条工具照常登记（`setDoc` 缺省时不登记"回退"，那正是"能力不存在"）。
      插件没交句柄 ⇒ 留空，`registerEditorTools` 干脆不登记那三条工具 ⇒ 它们既不在
      `clientTools` 名单里、也不进模型看到的工具表 —— 这正是"用可选字段表达'能力不存在'，
      比塞一个什么都不做的假函数诚实"。
    */
    ...(editorSlot
      ? pluginEditorHandle === null
        ? {}
        : {
            insertAtCursor: (text: string): void => pluginEditorHandle.insertAtCursor(text),
            replaceSelection: (text: string): boolean => pluginEditorHandle.replaceSelection(text),
            ...(pluginEditorHandle.setDoc === undefined
              ? {}
              : { setDoc: (text: string): void => pluginEditorHandle.setDoc?.(text) }),
          }
      : {
          insertAtCursor: (text: string): void => editorHandleRef.current?.insertAtCursor(text),
          replaceSelection: (text: string): boolean => editorHandleRef.current?.replaceSelection(text) ?? false,
          // AI 回退用：把草稿整篇设回某轮之前的样子（同样只在有句柄时存在）
          setDoc: (text: string): void => editorHandleRef.current?.setDoc(text),
        }),
  }

  useEffect(() => {
    const shape = editorToolLiveRef.current
    /*
      代理一层：注册**一次**，而每次调用都读当时的 `editorToolLiveRef.current`。
      直接 register 上面那个对象是不行的 —— 那是"本次渲染的闭包"，
      而工具的调用发生在之后（可能隔很多次渲染）。
    */
    const proxy: EditorCapability = {
      get slug() {
        return editorToolLiveRef.current.slug
      },
      get readOnly() {
        return editorToolLiveRef.current.readOnly
      },
      docText: () => editorToolLiveRef.current.docText(),
      selection: shape.selection === null ? null : () => editorToolLiveRef.current.selection?.() ?? null,
      ...(shape.insertAtCursor
        ? { insertAtCursor: (text: string): void => editorToolLiveRef.current.insertAtCursor?.(text) }
        : {}),
      ...(shape.replaceSelection
        ? {
            replaceSelection: (text: string): boolean =>
              editorToolLiveRef.current.replaceSelection?.(text) ?? false,
          }
        : {}),
      ...(shape.setDoc ? { setDoc: (text: string): void => editorToolLiveRef.current.setDoc?.(text) } : {}),
    }
    return registerEditorTools(proxy)
  }, [editorSlot])

  const load = useCallback((): void => {
    setErr('')
    setFieldErrors({})
    if (newMode) {
      // 预填 slug 时基线里的 slugInput 用预填值：否则 slug 一进页面就被判成"有改动"
      const base: PageDraft = { title: '', content: '', slugInput: prefillSlug ?? '' }
      setOriginal(base)
      setLoading(false)
      const d = readDraft(prefillSlug ?? '')
      if (d !== null && !isDraftExpired(d, Date.now())) setPendingDraft(d)
      return
    }
    /*
     * ⚠️ **必须请求原文**（`?content=raw`）：默认的详情接口返回的是**按读者投影后**的正文
     * —— 受限段落被换成占位文案、`<!--gated:org-->` 标记被消费掉。把那份正文当原文编辑并
     * 保存回去，会**毁掉段落权限标记**：实测复现过"公开页 + 组织内受限段落，编辑者只改了一个
     * 标点，保存后匿名访客即可读到该受限段落"。原文只对 `canEdit` 的主体下发（服务端强制）。
     */
    api
      .page(slug, { raw: true })
      .then((p) => {
        setTitle(p.title)
        setContent(p.content)
        setOrigSlug(p.slug)
        serverUpdatedAt.current = p.updated_at
        setOriginal({ title: p.title, content: p.content, slugInput: slug })
        /*
          档位**用这一次响应**填上，不额外发请求 —— 它只用于编辑器里"块档位不能比页面更宽"
          的提示（没有管理权时服务端不下发档位字段，那时提示按"未知"处理，见 `blockTiers`）。
        */
        setPagePerm({
          visibility: p.visibility ?? 'private',
          inherit: p.inherit ?? true,
          published: p.published === true,
        })
        setLoading(false)
        // 草稿：只有"确实有改动"或"服务端已变"时才打扰用户，内容一致的残留草稿直接清掉
        const d = readDraft(slug)
        if (d === null || isDraftExpired(d, Date.now())) {
          if (d !== null) removeDraft(slug)
          return
        }
        const decision = decideDraftRestore(d, {
          title: p.title,
          content: p.content,
          updatedAt: p.updated_at,
        })
        if (decision === 'restore' || decision === 'restore-stale') setPendingDraft(d)
        else if (decision === 'discard') removeDraft(slug)
      })
      .catch((e: unknown) => {
        setErr(errorLine(e))
        setLoading(false)
      })
  }, [slug, newMode, prefillSlug])

  useEffect(load, [load])

  /*
   * 草稿自动保存（防抖 900ms）。
   *
   * 为什么比预览防抖（200ms）长得多：预览是"跟手"的体验，草稿是"防丢失"，两者目标不同。
   * 900ms 的取值依据：连续打字时每秒可能产生多次改动，若每次都写 localStorage，
   * 大文档下会与输入竞争主线程（localStorage 是同步 API，会阻塞渲染）；
   * 900ms 足够让"打一个词/一句话"合并成一次写盘，同时用户几乎不可能在 900ms 内
   * 关掉页面还指望草稿生效（真那样也还有 beforeunload 拦截兜底）。
   */
  useEffect(() => {
    if (loading || !dirty) return
    const t = window.setTimeout(() => {
      const ok = writeDraft(isNew ? (prefillSlug ?? '') : slug, {
        title,
        content,
        savedAt: Date.now(),
        baseUpdatedAt: serverUpdatedAt.current,
      })
      /*
       * 只有 `ok` 为真才算"已保存"：写盘失败（配额满/隐私模式）时若照样显示时间戳，
       * 用户会以为改动保住了 —— 于是放心离开，改动就丢了。
       */
      if (ok) {
        setDraftSavedAt(Date.now())
        setDraftFailed(false)
      } else {
        setDraftFailed(true)
      }
    }, DRAFT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [title, content, slugInput, dirty, loading, isNew, slug, prefillSlug])

  /**
   * 预览防抖。
   *
   * 为什么必须防抖：预览每次都要跑 `marked` + `DOMPurify`（一次完整消毒）。
   * 若跟随每次按键，用户每敲一个字符就消毒一遍全文——在几千字的文档上是可感的卡顿。
   * 200ms 的取值依据：低于 ~100ms 对"连续输入"几乎没有合并效果（打字间隔常在 80–150ms），
   * 高于 ~300ms 用户会明显觉得"预览落后于输入"。200ms 落在两者之间。
   * （实测成本见汇报：一次完整消毒在本仓库的真实文档上约数毫秒，因此 200ms 足够宽裕。）
   */
  const [previewSource, setPreviewSource] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setPreviewSource(content), PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [content])
  /*
   * ★ P3d：**预览为别的视角** —— 块级模型唯一的可用性救生圈。
   *
   * 为什么必须有它：`<!--gated:org-->` / `<!--gated:granted-->` 圈起来的段落，
   * 作者自己是**看得到**的（他对自己的页有编辑权），所以"我预览里能看到"这件事
   * 完全不能说明别人能不能看到。没有这个开关，作者只能靠脑内模拟来判断谁看得到什么 ——
   * 而块级可见性恰恰是最容易判断错的一层（页面档位会向下压制块）。
   */
  const [previewAs, setPreviewAs] = useState<PreviewAudience>('all')
  const projected = useMemo(() => projectForAudience(previewSource, previewAs), [previewSource, previewAs])
  const previewRendered = useRenderedMarkdown(projected.markdown, {
    withCopyButtons: false,
    route,
    pages: editPageTitles,
    // 新建页面还没有 slug：此时不给「申请访问」入口（占位块仍如实说明破图原因）
    attachmentSlug: newMode ? null : slug,
  })

  /**
   * 附件上传（M4）：编辑器只把 `File` 交过来，网络、错误与人话提示都在这里。
   *
   * ## 为什么"新建页面"不自动保存再上传
   *
   * 上传端点是 `PUT /api/attachments/:slug` —— 挂在一个**已存在**的页面上。而本组件的
   * `save()` 成功后会 `onDone(r.slug)` **导航离开编辑态**（详情页），编辑器组件随之卸载，
   * 这次拖放会半途而废（占位与结果都写进了即将被丢弃的文档）；要改成"保存后留在原地继续编辑"
   * 属于改保存语义，超出本批范围。因此这里给一句**可执行**的提示，而不是自作聪明地存盘。
   *
   * ## 返回值契约
   *
   * 与入参**一一对应**的 Markdown 文本（`![名](url)` / `[名](url)`）；抛错即"这个文件没上去"，
   * 由编辑器把该文件那一行占位替换成失败说明并保留 File 供重试。
   */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<string[]> => {
      if (isNew) {
        setUploadNotice({
          tone: 'err',
          text: '请先保存页面，再插入附件（附件必须挂在一个已存在的页面上）',
        })
        // 用 ApiError 而不是裸 Error：`errorLine` 对它的处置是稳定的（不会退化成"出了点问题"）
        throw new ApiError(409, 'page_not_saved', '请先保存页面，再插入附件')
      }
      setUploadNotice({
        tone: 'ok',
        text: files.length === 1 ? '正在上传 1 个附件…' : `正在上传 ${files.length} 个附件…`,
      })
      try {
        const out: string[] = []
        for (const file of files) {
          const r = await uploadAttachment(slug, file)
          /*
            插入的是后端返回的**相对路径**（`/api/attachments/<id>`）：同源 cookie 自动带，
            前端不拼绝对地址、不携带任何 token（详见 `api.ts` 的 uploadAttachment 说明）。
          */
          out.push(attachmentMarkdown(file.name, r.url))
        }
        setUploadNotice({
          tone: 'ok',
          text: `已插入 ${files.length} 个附件（保存页面后其他人才能看到）`,
        })
        return out
      } catch (e: unknown) {
        // 失败必须落到屏幕上：拖进来一个文件然后什么都没发生，用户只会以为功能坏了
        setUploadNotice({ tone: 'err', text: `附件上传失败：${errorLine(e)}` })
        throw e
      }
    },
    [isNew, slug],
  )

  const save = useCallback(
    async (opts: { force?: boolean; allowProjected?: boolean } = {}): Promise<void> => {
      const target = newMode ? slugInput.trim() : slug
      const errors = validatePageForm({ isNew: newMode, slugInput, title })
      setFieldErrors(errors)
      if (hasErrors(errors)) {
        // 顶部给一句汇总（屏幕阅读器/长页面用户可能看不到字段旁的红字），字段旁给具体原因
        setErr('请先修正下面标出的问题')
        return
      }
      setErr('')

      /*
       * ★ 占位文案拦截（见 `projectedGuard` 的说明）：正文里出现服务端生成的占位，
       * 说明手上这份**不是原文** —— 保存会毁掉段落权限标记。先让用户选。
       * `allowProjected` 由对话框里那个「仍然保存」传进来（与冲突覆盖的 `force` 分开：
       * 两件事的后果不同，共用一个开关会让文案说不清到底在确认什么）。
       */
      if (opts.allowProjected !== true && looksProjected(content)) {
        setProjectedGuard(true)
        return
      }

      /*
       * 冲突检测（仅编辑既有页面）：保存前取一次服务端状态，比对 `updated_at`。
       *
       * 目的：**不静默覆盖别人更新的内容**。若期间有人（或另一个标签页）保存过，
       * 就先让用户知道，由他决定是否覆盖——而不是无声地把对方的工作顶掉。
       * 代价是每次保存多一次 GET；对本应用的数据规模（单页几百 KB 以内）可接受，
       * 换来的是"丢内容"这种不可逆事故的避免。
       */
      if (!newMode && opts.force !== true) {
        try {
          const fresh = await api.page(slug)
          if (serverUpdatedAt.current !== null && fresh.updated_at !== serverUpdatedAt.current) {
            setConflictAt(fresh.updated_at)
            return
          }
        } catch (e) {
          // 拿不到最新状态时**不阻塞保存**：网络抖动不该让用户存不了东西
          console.debug('[geewiki-wiki] 保存前冲突检测跳过：', e instanceof Error ? e.message : e)
        }
      }

      setSaving(true)
      try {
        const r = await api.savePage(target, { title: title.trim(), content })
        // 保存成功 ⇒ 草稿使命结束（连同新建页的哨兵键一起清）
        removeDraft(slug)
        if (newMode) removeDraft(prefillSlug ?? '')
        // 列表/侧边栏立刻反映新页面（新建）或新标题（改名）——否则要手动刷新才看得到
        void invalidatePages()
        void refreshCapabilitiesIfVisible() // 新建的页可能带来新的编辑权（见 remove() 的说明）
        /*
          ══════ 主页首次创建：留下常驻提示，**不跳走** ══════
          判据用服务端返回的 `outcome`（`api.ts:414` 的 `'created' | 'updated' | 'unchanged'`），
          而不是前端自己猜"这是不是第一次" —— 服务端的 upsert 结果是唯一权威。
          `outcome === 'updated'` 走原来的跳转：那是"覆盖了已存在的页"，另有口径。
        */
        if (createHomeMode && r.outcome === 'created') {
          setHomeCreatedNotice(
            '主页已创建。它当前只对组织内可见 —— 匿名访客打开站点会看不到主页。要对外公开，请用页面上的「权限」入口把档位设为公开并打开「已发布」。',
          )
          // 保持 `saving`（按钮 loading）：此时编辑器源文与已入库的正文一致、没什么可再存的；
          // 让用户用下面那条提示里的动作离场，避免"再点一次保存"。
          return
        }
        onDone(newMode ? r.slug : slug)
      } catch (e) {
        setErr(errorLine(e))
        setSaving(false)
      }
    },
    [content, createHomeMode, newMode, slug, slugInput, title, onDone, prefillSlug],
  )

  /** ⌘/Ctrl+S 全局保存：焦点可能在标题输入框，不能只靠编辑器的 keymap */
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const { confirmLeave } = useUnsavedGuard({
    dirty,
    message: '有未保存的改动，确定离开吗？未保存的内容可在下次进入编辑页时恢复。',
    selfHash,
  })

  const applyDraft = (): void => {
    if (pendingDraft === null) return
    setTitle(pendingDraft.title)
    setContent(pendingDraft.content)
    setPendingDraft(null)
  }

  const discardDraft = (): void => {
    removeDraft(isNew ? (prefillSlug ?? '') : slug)
    setPendingDraft(null)
  }

  /*
    ⚠️ 必须在下面的任何 early return 之前调用（hook 顺序不能随分支改变，否则 React 抛 #310）。
  */
  const slowEdit = useSlowHint(loading)

  if (loading) {
    /*
      与详情页同款：骨架与真实编辑页同构（面包屑 → 标题 + 操作按钮 → 字段 → 编辑面板），
      而不是一叠等高条；加载反馈统一走 `LoadingState`。
    */
    return (
      <LoadingState slow={slowEdit} label="正在加载页面…">
        {/* 面包屑 */}
        <Skeleton className="h-4 w-48" />

        {/* 操作条：左侧「编辑页面」标题，右侧保存/取消 */}
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-7 w-32" />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>

        {/* 标题字段：标签 + 输入框 */}
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-10 w-full" />
        </div>

        {/* 编辑面板：**单栏**（与真实布局一致：模式切换在编辑器内部） */}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          {/*
            编辑区骨架：高度必须与**真实编辑面**一致，否则数据到达时整页跳一下（CLS）——
            而这里曾经是 `h-[420px]`、真编辑器却是 480px，两边各自写死。
            现在两者都取 `DEFAULT_EDITOR_MIN_HEIGHT`（`Skeleton` 只收 className，
            故用一层定高 div 包住，与 `MarkdownEditorLazy` 的 Suspense 骨架同款）。
          */}
          <div style={{ height: DEFAULT_EDITOR_MIN_HEIGHT }} className="w-full">
            <Skeleton className="h-full w-full" />
          </div>
        </div>
        {/* 权限区：档位卡片 + 段落档位说明 */}
        <Skeleton className="h-32 w-full" />
      </LoadingState>
    )
  }

  const slugError = fieldErrors.slug
  const titleError = fieldErrors.title
  /*
   * 空态按**投影后**的正文判断：一个只由 `granted` 区段组成的页面，在"匿名视角"下
   * 的可读正文是空的 —— 此时该显示"（空白）"，而不是渲染出一段其实没人看得到的正文。
   */
  const previewEmpty = projected.markdown.trim() === ''

  const editSlug = newMode ? '' : origSlug !== '' ? origSlug : slug
  /*
   * 「创建主页」与「新建页面」走的是**同一个**新建编辑器，但它们是两件事：
   * 前者有约定 slug（`prefillSlug === HOME_SLUG`），标题与面包屑必须说"创建主页"——
   * 否则用户在主页缺省面板点「创建主页」，进来看到的却是"新建页面"，会以为自己点错了。
   *
   * ⚠️ `createHomeMode` 本身声明在组件顶部（`save()` 也要用它，见那里的说明）。
   */
  const newTitle = createHomeMode ? '创建主页' : '新建页面'

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb slug={editSlug} title={newMode ? newTitle : editSlug} pages={editPages} />

      {/* 操作条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="m-0 text-xl font-semibold">{newMode ? newTitle : '编辑页面'}</h1>
        {dirty && (
          /*
           * 三态，优先级：失败 > 已保存 > 有改动。
           * 失败态用 `text-danger-ink`：它是"你的改动**没有**被保住"的告警，
           * 不能让它在视觉上跟"已保存"长得一样。
           */
          <span
            className={cn('text-xs', draftFailed ? 'text-danger-ink' : 'text-muted')}
            role="status"
          >
            {draftFailed
              ? '草稿无法自动保存（浏览器存储不可用或已满）—— 请手动保存，离开本页会丢失改动'
              : draftSavedAt > 0
                ? `草稿已自动保存（${new Date(draftSavedAt).toLocaleTimeString('zh-CN', { hour12: false })}）`
                : '有未保存的改动'}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {err !== '' && (
            <span
              role="alert"
              className="rounded-md border border-danger-line bg-danger-bg px-3 py-1 text-note text-danger-ink"
            >
              {err}
            </span>
          )}
          <Button
            disabled={saving}
            onClick={() => {
              if (confirmLeave()) onCancel()
            }}
          >
            取消
          </Button>
          <Button
            variant="primary"
            loading={saving}
            /* 主页已创建 ⇒ 不提供第二次保存：目标页已存在，再存一次会覆盖刚写的那一版 */
            disabled={homeCreatedNotice !== null}
            icon={<Save className="size-3.5" />}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      </div>

      {/* 字段：错误就地显示（`aria-describedby` 把错误与控件关联，屏幕阅读器才能读到） */}
      <div className="rounded-lg border border-line bg-surface px-5 py-4 shadow-sm">
        <div className="flex flex-col gap-4">
          {newMode && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="gw-page-slug" className="text-xs font-semibold text-ink-soft">
                页面标识（URL 里的路径，如 getting-started）
              </label>
              <Input
                id="gw-page-slug"
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value.trim())}
                placeholder="my-page"
                spellCheck={false}
                invalid={slugError !== undefined}
                aria-describedby={slugError !== undefined ? 'gw-page-slug-error' : undefined}
                className="font-mono sm:max-w-md"
              />
              {slugError !== undefined ? (
                <p id="gw-page-slug-error" className="m-0 text-xs text-danger-ink">
                  {slugError}
                </p>
              ) : (
                <p className="m-0 text-xs text-muted">仅小写字母、数字与 . _ -（≤80 字符）</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="gw-page-title" className="text-xs font-semibold text-ink-soft">
              标题
            </label>
            <Input
              id="gw-page-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="页面标题"
              invalid={titleError !== undefined}
              aria-describedby={titleError !== undefined ? 'gw-page-title-error' : undefined}
            />
            {titleError !== undefined && (
              <p id="gw-page-title-error" className="m-0 text-xs text-danger-ink">
                {titleError}
              </p>
            )}
          </div>
        </div>
      </div>

      {/*
        编辑区（**单栏**）。
        两种模式（源码 / 实时渲染）与排版工具栏都在编辑器**内部**（见 `MarkdownEditor.tsx`）：
        它们只影响"编辑区怎么画"，不影响正文、草稿与保存。原先的左右分屏被去掉 ——
        写的地方窄、看的地方也窄，而且两边来回找同一段是纯粹的浪费；要看成品效果，
        用下面的「按访客视角预览」（那是**真的**投影后的 HTML，含可见性判定）。
      */}
      <section aria-labelledby={EDITOR_PANE_LABEL_ID} className="gw-editor-pane flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span id={EDITOR_PANE_LABEL_ID} className="text-xs font-semibold text-ink-soft">
            正文（Markdown）{editorSlot ? ` · 由 ${editorSlot.source} 提供` : ''}
          </span>
          <span className="text-xs text-muted">
            {charCount(content)} 字符 · ⌘/Ctrl+S 保存 · ⌘/Ctrl+B 加粗 · Tab 缩进
          </span>
          {/*
            视角预览的入口放在这里（而不是常驻一个面板）：它是**按需**动作，
            而"作者自己永远看得到全部"这件事必须有一个开关才能看穿（见 PREVIEW_AUDIENCES）。
            插件编辑器路径下不显示：那条路径的正文不在本组件手里，投影出来的东西不是他正在编的稿。
          */}
          {/*
            ⚠️ 判据是**假值**而不是 `=== null`：`useEditorSlot()` 无插件时返回的是
            `undefined`（见 `lib/slots.tsx:282`），写成 `=== null` 会让这个按钮**永远不渲染**
            ——而工具栏照常出现（它判的是 `editorSlot ? … : …`），于是"按钮不见了"看起来
            像是布局问题，实则是判据写错了值。
          */}
          {!editorSlot && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Eye className="size-3.5" />}
              className="ml-auto"
              onClick={() => setPreviewOpen(true)}
            >
              按访客视角预览
            </Button>
          )}
        </div>
        {editorSlot ? (
          /*
           * 插件编辑器路径：宿主把受控值与保存/取消回调交出去，插件只负责"编辑区"。
           * 草稿、脏值、冲突检测、未保存拦截仍由本组件的既有逻辑承担（见上面的 hook 注释）。
           * `onSave` 指向同一个 `save()`——不存在第二套保存实现。
           *
           * ★ F5：这里**不再是二等公民**。附件上传、段落档位、段落授权、选区上报与
           * 命令式写回句柄都按"宿主提供 ⇒ 插件可用"的既有口径交出去（全部可选）。
           * 交给插件的仍是**宿主编排的通道**：真发请求/鉴权/错误文案都在宿主，
           * 插件只负责自己的光标与 UI 语义（`onUploadFiles` 返回的是可直接插入的 Markdown 片段）。
           */
          <EditorSlotOutlet
            value={content}
            mode={newMode ? 'create' : 'edit'}
            slug={slugInput}
            readOnly={saving}
            onChange={setContent}
            onSave={() => void save()}
            onCancel={onCancel}
            /*
              附件上传：与内置编辑器路径**同一个** `uploadFiles`（不存在第二套上传实现，
              也就不会出现"插件编辑器能传但没走限流/审计"这类分叉）。
            */
            onUploadFiles={uploadFiles}
            /* 段落档位：与内置编辑器路径同一个事实源（`pagePerm`），只是交出去让插件自己渲染提示 */
            blockTiers={{ pageVisibility: pagePerm?.visibility ?? null }}
            onManageBlockGrants={setGrantBlock}
            onSelectionChange={setPluginEditorSelection}
            onEditorHandle={setPluginEditorHandle}
          />
        ) : (
          <MarkdownEditorLazy
            value={content}
            onChange={setContent}
            onSave={() => void save()}
            disabled={saving}
            ariaLabel="Markdown 正文编辑器"
            /*
              刻意**不传** `minHeight`：默认值（`lib/editorHeightPlan.ts`）就是页面编辑器的下限，
              传一遍等于把同一个数值写第二处 —— 上面那个骨架屏刚刚才因为这样而漂移过。
            */
            /*
              附件上传（M4）：粘贴截图 / 拖入文件都由编辑器接住，这里只负责"真发请求"。
              ★ F5：插槽路径（上面的 `EditorSlotOutlet`）现在拿到的是**同一个** `uploadFiles`——
              曾经这里写的是"插件编辑区不含上传，是本批明确的边界"，那个边界已按审计 B3 消除。
              两条路径共用一份上传实现，故限流/审计/错误文案不会分叉。
            */
            onUploadFiles={uploadFiles}
            onSelectionChange={setEditorSelection}
            handleRef={editorHandleRef}
            /*
              段落级阅读权限（写的是正文里的 gated 标记）。
              对**新建页面**也给：标记是正文的一部分，作者完全可以先写好受限段落再保存；
              页面档位此时未知（`pageVisibility: null`），界面上会照实说"保存后才判定"。
            */
            blockTiers={{ pageVisibility: pagePerm?.visibility ?? null }}
            /*
              段落级的「授权给谁」：`granted`（需单独授权）档**只有这里**能指定谁读得到 ——
              缺了它，作者把一段设成"需单独授权"之后就再没有任何界面能放人进来。
            */
            onManageBlockGrants={setGrantBlock}
            placeholder={'支持 Markdown：标题、列表、代码块、表格、链接…\n\n## 示例小节\n\n- 条目一\n- 条目二\n\n```ts\nconsole.log("hello")\n```'}
          />
        )}
        {/*
          AI 辅助写作工具条由**插件**渲染（`editor-toolbar` 插槽，多占用：多个插件可各自加一组
          按钮）。宿主只交事实：模式、slug、正文、选区、以及两条写回通道。

          ★ F5：插件编辑器路径（`editorSlot` 为真）下，这两条通道改由**插件自己**提供 ——
          `onSelectionChange` 报选区、`onEditorHandle` 交句柄（见上面的 `EditorSlotOutlet`）。
          仍是"能力不存在就不给"的那条口径：插件**没**给句柄时这里依然留空，
          **不用假函数**充数 —— 假函数会让按钮看起来能用、点下去静默无效，
          而那正是本仓库反复记档的那类缺陷（"看起来正常，其实错位"）。
          插件据此把"采纳"禁用并说明原因，其余动作（如摘要）照常可用。
        */}
        <EditorToolbarSlotOutlet
          mode={newMode ? 'create' : 'edit'}
          slug={newMode ? '' : slug}
          docText={content}
          /* 插件编辑器上报了选区就照用；没上报则保持 `null` —— "选区未知"是诚实的事实，不是错误 */
          selection={editorSlot ? pluginEditorSelection : editorSelection}
          readOnly={saving}
          {...(editorSlot
            ? pluginEditorHandle === null
              ? {}
              : {
                  insertAtCursor: (text: string): void => pluginEditorHandle.insertAtCursor(text),
                  replaceSelection: (text: string): boolean => pluginEditorHandle.replaceSelection(text),
                }
            : {
                insertAtCursor: (text: string): void => editorHandleRef.current?.insertAtCursor(text),
                replaceSelection: (text: string): boolean => editorHandleRef.current?.replaceSelection(text) ?? false,
              })}
        />
        {/*
          附件上传的可见提示（M4）。放在编辑区**下方**而不是页头：动作发生在这里，
          反馈就该在这里（页头那条 `err` 是保存错误的固定位置，两者互不覆盖）。
          `role`：失败 = `alert`（用户必须有感知），进行中/成功 = `status`（礼貌播报）。
        */}
        {uploadNotice !== null && (
          <p
            role={uploadNotice.tone === 'err' ? 'alert' : 'status'}
            className={cn(
              'm-0 rounded-md border px-3 py-1.5 text-note',
              uploadNotice.tone === 'err'
                ? 'border-danger-line bg-danger-bg text-danger-ink'
                : 'border-ok-line bg-ok-bg text-ok-ink',
            )}
          >
            {uploadNotice.text}
          </p>
        )}
        {/*
          「主页已创建」的常驻提示（独立代码块，可整段摘除）。
          与上面那条的区别：这不是"某个动作的即时反馈"，而是一条**待办**（去把档位改成公开），
          所以用 `warn` 配色而不是成功绿 —— 绿色读起来像"一切都好了"，而匿名访客此刻打不开主页。
          离场动作给「前往主页」：主页**已经建好了**，留在这张"新建页面"表单上没有意义。
        */}
        {homeCreatedNotice !== null && (
          <div
            role="status"
            className="m-0 flex flex-col gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-note text-warn-ink"
          >
            <span>{homeCreatedNotice}</span>
            <div>
              <Button size="sm" variant="secondary" onClick={() => onDone(HOME_SLUG)}>
                前往主页
              </Button>
            </div>
          </div>
        )}
        {/*
          ★ 手上不是原文（含服务端占位文案）⇒ **保存会毁掉段落权限标记**。
          这一条与"标记不合法"不同：那一条服务端会拒，而这一条服务端**照单全收**
          （从它的角度看，作者就是删掉了标记）—— 后果是受限段落静默变公开，
          所以必须在这里、在保存之前说出来。
        */}
        {looksProjected(content) && (
          <p
            role="alert"
            className="m-0 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-xs text-danger-ink"
          >
            正文里有服务端生成的占位文案（形如「🔒 此处有 N 段内容需…查看」）——
            说明你现在看到的是<strong className="font-semibold">投影后</strong>的内容，段落级的权限标记已经不在里面了。
            直接保存会把这段占位写进正文，并丢掉段落权限标记（受限段落会因此变成公开）。
            请先「重新加载原文」；确实要这么存的话，保存时会再确认一次。
          </p>
        )}
        {/*
          标记不合法 ⇒ **保存时会被服务端拒绝**（400）。就地提示，别让作者写完一大段才发现。
          服务端对废弃标记是**显式拒绝**而不是静默忽略 —— 静默忽略会让作者以为收紧了、
          实际按 public 暴露。这一条从原来的预览面板搬到这里：它与"有没有打开预览"无关，
          而是**保存阻断项**，必须常驻可见。
        */}
        {projected.invalidMarkers.length > 0 && (
          <p
            role="alert"
            className="m-0 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn-ink"
          >
            正文里有 {projected.invalidMarkers.length} 处 gated 标记不合法（
            {projected.invalidMarkers.join('、')}）—— **保存会被服务端拒绝**。只接受
            {' '}<code>&lt;!--gated:org--&gt;</code> 与 <code>&lt;!--gated:granted--&gt;</code>，
            且必须成对、不得嵌套。
          </p>
        )}
      </section>

      <p className="m-0 text-xs text-muted">
        保存会把当前正文快照进版本历史（内容未变化则不产生新版本）。
        {origSlug !== '' && origSlug !== slug && ` 提示：原标识 ${origSlug} 的内容已迁移到新标识。`}
      </p>

      {/*
        「授权给谁…」（编辑器的锁菜单打开）。宿主执行网络请求：编辑器有"绝不发请求"的约定，
        它只交出光标所在段的 `ordinal` 与摘要。
      */}
      <BlockGrantsDialog
        open={grantBlock !== null}
        onOpenChange={(open) => !open && setGrantBlock(null)}
        slug={slug}
        ordinal={grantBlock?.ordinal ?? 0}
        excerpt={grantBlock?.excerpt ?? ''}
        pageVisibility={pagePerm?.visibility ?? null}
        /* 「先保存正文，再继续授权」：块是保存时解析出来的，没保存就没有块 id 可授权 */
        onSaveFirst={async () => {
          await save()
        }}
      />

      {/*
        「按访客视角预览」（★ P3d）：块级模型唯一的可用性救生圈。
        作者对自己的页有编辑权，因此**他总能看到全部受限段落** —— "我预览里看得到"完全不能
        说明别人能不能看到。故这里给出视角切换，并把"该视角下遮蔽了几段"写在旁边。
      */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          title="按访客视角预览"
          description="本地渲染的当前正文（未保存的改动也在内），非最终发布稿。"
          footer={
            <DialogClose asChild>
              <Button>关闭</Button>
            </DialogClose>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span id={PREVIEW_PANE_LABEL_ID} className="text-xs font-semibold text-ink-soft">
                预览（本地实时渲染，非最终发布稿）
              </span>
              <div role="group" aria-label="预览视角" className="flex items-center gap-1">
                {PREVIEW_AUDIENCES.map((a) => (
                  <Button
                    key={a.id}
                    size="sm"
                    variant={previewAs === a.id ? 'primary' : 'ghost'}
                    aria-pressed={previewAs === a.id}
                    title={a.hint}
                    onClick={() => setPreviewAs(a.id)}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
              {previewAs !== 'all' && (
                <span className="text-xs text-ink-soft">
                  {projected.gatedCount > 0
                    ? `该视角下 ${projected.gatedCount} 段内容被遮蔽`
                    : '该视角下没有任何内容被遮蔽'}
                </span>
              )}
            </div>
            {/*
              「我的视角」不是"预览"：它显示的是作者自己能看到的一切（含全部受限段落）。
              这句话必须写出来，否则用户会把这个标签页当成"访客看到的样子"。
            */}
            {previewAs === 'all' && (
              <p className="m-0 text-xs text-muted">
                「我的视角」显示的是**你**能读到的全部内容（含受限段落），不代表别人看到的样子；
                想看访客看到什么，请选「组织成员」或「匿名访客」。
              </p>
            )}
            <div
              /*
                `role="region"` 是必须的：`aria-labelledby` 在**没有角色**的元素上会被忽略
                （generic 元素不接受可访问名称），那样这个滚动区就成了一个匿名容器。
                加 role 后它才真的按名字可跳转（"预览"成为一个区域地标）。
              */
              role="region"
              aria-labelledby={PREVIEW_PANE_LABEL_ID}
              className="max-h-[55vh] min-h-[8rem] overflow-auto rounded-md border border-line bg-surface px-5 py-4"
            >
              {previewEmpty ? (
                <p className="m-0 text-sm text-muted">（空白）</p>
              ) : (
                <MarkdownBody html={previewRendered.html} className="md-body" />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/*
        占位文案的保存拦截（见 `projectedGuard`）。两个动作都给出来，且**说清各自后果**：
        「重新加载原文」会丢掉当前编辑区里的改动（那是投影结果，本来就该丢）；
        「仍然保存」会把占位当正文写进去 —— 只有用户明确要这样才能做。
        ⚠️ 这个对话框是**唯一**的出口：保存拦截会把 save() 直接 return 掉，
        少了它用户就卡在"点了保存什么都不发生"上（实测漏删过一次，故这里留一句提醒）。
      */}
      <Dialog open={projectedGuard} onOpenChange={(open) => !open && setProjectedGuard(false)}>
        <DialogContent
          title="正文里含服务端占位文案"
          description="你现在看到的不是原文，而是按读者投影后的内容。"
          footer={
            <>
              <DialogClose asChild>
                <Button onClick={() => setProjectedGuard(false)}>先不保存</Button>
              </DialogClose>
              <Button
                variant="secondary"
                onClick={() => {
                  setProjectedGuard(false)
                  // 丢弃手上的（投影）正文，重新取一次原文；草稿一并清掉，免得又被恢复回来
                  removeDraft(slug)
                  removeDraft(prefillSlug ?? '')
                  load()
                }}
              >
                重新加载原文
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setProjectedGuard(false)
                  void save({ force: true, allowProjected: true })
                }}
              >
                仍然保存
              </Button>
            </>
          }
        >
          <p className="m-0">
            保存会把「🔒 此处有 N 段内容需…查看」这行占位写进正文，并且丢掉
            <code className="font-mono">{'<!--gated:…-->'}</code> 标记 ——
            被标记圈起来的段落会因此变成任何人都能读到的普通段落。
          </p>
          <p className="m-0 mt-2">
            要保住段落权限，请选「重新加载原文」（会用服务端原文覆盖编辑区，未保存的改动会丢失）；
            若你确实要删掉这些段落权限，选「仍然保存」。
          </p>
        </DialogContent>
      </Dialog>

      {/* 草稿恢复：用 Dialog 而不是 confirm —— 需要呈现"多久以前""服务端已更新"等信息 */}
      <Dialog open={pendingDraft !== null} onOpenChange={(open) => !open && discardDraft()}>
        <DialogContent
          title="发现未保存的草稿"
          description={
            pendingDraft === null
              ? undefined
              : `保存于 ${formatDraftAge(pendingDraft.savedAt, Date.now())}${
                  draftIsStale(pendingDraft, serverUpdatedAt.current) ? '；期间服务端内容已被更新' : ''
                }。`
          }
          footer={
            <>
              <DialogClose asChild>
                <Button onClick={discardDraft}>丢弃草稿</Button>
              </DialogClose>
              <Button variant="primary" onClick={applyDraft}>
                恢复草稿
              </Button>
            </>
          }
        >
          {draftIsStale(pendingDraft, serverUpdatedAt.current) ? (
            <p className="m-0">
              服务端版本比这份草稿新。恢复并保存后，你的内容会覆盖服务端最新的改动
              （保存时会再确认一次）；若不确定，建议先「丢弃草稿」查看当前线上内容，
              再从版本历史对照。
            </p>
          ) : (
            <p className="m-0">恢复后可以继续编辑；不恢复则丢弃这份草稿。</p>
          )}
        </DialogContent>
      </Dialog>

      {/* 保存冲突：服务端已更新 */}
      <Dialog open={conflictAt !== null} onOpenChange={(open) => !open && setConflictAt(null)}>
        <DialogContent
          title="服务端内容已被更新"
          description={conflictAt === null ? undefined : `服务端最近更新于 ${fmtTime(conflictAt)}。`}
          footer={
            <>
              <DialogClose asChild>
                <Button>先不保存</Button>
              </DialogClose>
              <Button
                variant="danger"
                onClick={() => {
                  setConflictAt(null)
                  // 用户明确选择覆盖：跳过冲突检测再存一次
                  void save({ force: true })
                }}
              >
                仍然覆盖保存
              </Button>
            </>
          }
        >
          <p className="m-0">
            你打开这一页之后，服务端的内容被改过（可能是另一个标签页或其他人）。
            继续保存会覆盖那些改动；被你覆盖掉的那一版会作为历史快照保留在版本历史里，
            因此事后仍可从历史里找回。
          </p>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 草稿是否基于较旧的服务端版本（用于提示语气） */
function draftIsStale(draft: DraftRecord | null, serverUpdatedAt: string | null): boolean {
  if (draft === null || serverUpdatedAt === null) return false
  return draft.baseUpdatedAt !== null && draft.baseUpdatedAt !== serverUpdatedAt
}
