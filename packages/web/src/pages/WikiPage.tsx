import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseWikiRoute } from '../lib/wikiRoute'
import { invalidatePages, usePages } from '../lib/pagesStore'
import { Sidebar, SidebarDrawer, wikiHref } from '../components/Sidebar'
import { ChevronLeft, ChevronRight, FileText, History, MessageSquareText, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, SearchX, Trash2 } from 'lucide-react'
import { api, type PageDetail, type PageSummary } from '../api'
import { AskPanel } from '../components/AskPanel'
import { MarkdownBody, useRenderedMarkdown } from '../components/MarkdownBody'
import { MarkdownEditorLazy } from '../components/MarkdownEditorLazy'
import { EditorSlotOutlet, useEditorSlot } from '../lib/slots'
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
import { projectForAudience, type PreviewAudience } from '../lib/gatedPreview'
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
  hasSeparatorBefore,
  intermediateCrumbCount,
  neighborsOf,
} from '../lib/navTree'
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
  CardBody,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Skeleton,
  SkeletonTable,
} from '../ui'
import { cn } from '../ui/cn'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
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

/** hash 段里的查询串解码（用户可能在地址栏手输，容错返回原文） */
/**
 * Wiki 页：sub 为 hash 中 'wiki/' 之后的子路径。
 * 保留段：'' | 'list'（列表）、'new'（新建）、'search/<q>'（检索）、'ask[/<q>]'（问答）、
 * `<slug>[/edit]`（详情/编辑）。**检索与问答是宿主原生 UI**（见 lib/slots.tsx 的冻结裁决：
 * 插件组件不接收 props），因此不走 Slot，而是这里自己的路由。
 */
export function WikiPage(props: { sub: string; onNavigate: (path: string) => void }): ReactNode {
  const { sub, onNavigate } = props
  // 路由解析抽到 lib/wikiRoute.ts（纯函数 + 单测）：它修掉了"分层 slug 打不开"
  // 这个只在真实浏览器里才暴露的缺陷（未编码路径被当成未知深层跳回列表、
  // 编码路径被双重编码成 404）。
  const route = parseWikiRoute(sub)
  const activeSlug =
    route.kind === 'detail' ? route.slug : route.kind === 'edit' ? route.slug : null
  const pages = usePages()

  if (route.kind === 'list') {
    return (
      <WikiShell activeSlug={null} pages={pages} onNavigate={onNavigate}>
        <WikiList
          onOpen={(slug) => onNavigate(slug)}
          onNew={() => onNavigate('new')}
          onSearch={(q) => onNavigate(`search/${encodeURIComponent(q)}`)}
          onAsk={(q) => onNavigate(q === '' ? 'ask' : `ask/${encodeURIComponent(q)}`)}
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
  if (route.kind === 'ask') {
    return (
      <WikiShell activeSlug={null} pages={pages} onNavigate={onNavigate}>
        <div className="page">
          <div className="page-head">
            <h1>问答</h1>
            <div className="page-actions">
              <Button onClick={() => onNavigate('')}>返回列表</Button>
            </div>
          </div>
          <AskPanel key={route.q} initialQuery={route.q} onOpenPage={(slug) => onNavigate(slug)} />
        </div>
      </WikiShell>
    )
  }
  if (route.kind === 'new') {
    return (
      <WikiShell activeSlug={null} pages={pages} onNavigate={onNavigate}>
        <WikiEdit slug="" onDone={(slug) => onNavigate(slug)} onCancel={() => onNavigate('')} />
      </WikiShell>
    )
  }
  if (route.kind === 'detail') {
    return (
      <WikiShell activeSlug={activeSlug} pages={pages} onNavigate={onNavigate}>
        <WikiDetail
          key={route.slug}
          slug={route.slug}
          onEdit={() => onNavigate(`${route.slug}/edit`)}
          onDeleted={() => onNavigate('')}
          onNavigate={onNavigate}
        />
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
function WikiShell(props: {
  activeSlug: string | null
  pages: ReturnType<typeof usePages>
  onNavigate: (path: string) => void
  children: ReactNode
}): ReactNode {
  const { activeSlug, pages, onNavigate, children } = props
  const navProps = {
    pages: pages.pages,
    error: pages.error,
    activeSlug,
    onOpen: (slug: string) => onNavigate(slug),
    onNavigate,
  }
  return (
    <div className="flex items-start gap-[var(--spacing-gutter)]">
      <Sidebar {...navProps} />
      <div className="min-w-0 flex-1">
        {/* 窄屏的目录入口与"全部页面"并列在内容顶部，避免挤占标题行 */}
        <div className="mb-2 lg:hidden">
          <SidebarDrawer {...navProps} />
        </div>
        {children}
      </div>
    </div>
  )
}

/* ============================ 列表 ============================ */

function WikiList(props: {
  onOpen: (slug: string) => void
  onNew: () => void
  onSearch: (q: string) => void
  onAsk: (q: string) => void
}): ReactNode {
  const { onOpen, onNew, onSearch, onAsk } = props
  // 列表数据来自共享 store（与侧边栏、详情页的上一篇/下一篇同源）
  const pagesState = usePages()
  const pages = pagesState.pages
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
   * 检索/问答插件**可能未启用**（默认部署下 `@geewiki/search` 与 `@geewiki/ai` 都不在基础层
   * 清单里，它们的端点会 404）。探测用**两路**：
   * 1. `GET /api/plugins`（恒可用）——插件是否 active，这是权威判据，**不产生 404**；
   * 2. `GET /api/ai/capabilities`（按契约要求调用）——用于拿到"模型是否就绪"的说明；
   *    若插件未启用它会 404，这里**静默**降级（只 console.debug）。
   * 三态：null=探测中、true=可用、false=不可用（隐藏入口）。
   */
  const [searchReady, setSearchReady] = useState<boolean | null>(null)
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  /** 模型是否就绪（来自 capabilities）；null = 未知（未启用或探测失败） */
  const [modelReady, setModelReady] = useState<boolean | null>(null)

  const load = (): void => {
    pagesState.reload()
  }
  const slowList = useSlowHint(pages === null && pagesState.error === null)

  useEffect(() => {
    api
      .plugins()
      .then((r) => {
        const stateOf = (name: string): string | undefined => r.plugins.find((p) => p.name === name)?.state
        setSearchReady(stateOf('@geewiki/search') === 'active')
        setAiReady(stateOf('@geewiki/ai') === 'active')
      })
      .catch((e: unknown) => {
        // 列表本身失败：不阻塞页面，入口按"不可用"处理（用户仍能正常读写页面）
        console.debug('[geewiki-wiki] 插件列表不可用，隐藏检索/问答入口：', e instanceof Error ? e.message : e)
        setSearchReady(false)
        setAiReady(false)
      })
  }, [])

  /**
   * 能力探测：**只在问答插件确实激活时才调用** `/api/ai/capabilities`。
   *
   * 为什么不无条件探测：未启用 `@geewiki/ai` 时该端点返回 404，虽然代码里已静默
   * 降级（只 console.debug），但**浏览器自身**会把 404 响应记为 error 级网络日志
   * （"Failed to load resource: 404"）——用户看到的是控制台一片红。既然后端
   * `/api/plugins` 已经给出了权威的"是否激活"，就没有必要再去撞一次 404。
   */
  useEffect(() => {
    if (aiReady !== true) return
    api
      .aiCapabilities()
      .then((c) => setModelReady(c.available))
      .catch((e: unknown) => {
        console.debug('[geewiki-wiki] 问答能力探测跳过：', e instanceof Error ? e.message : e)
        setModelReady(null)
      })
  }, [aiReady])

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
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={onNew}>
            新建页面
          </Button>
        </div>
      </div>

      {/* 检索与问答入口（宿主原生 UI；插件未启用时隐藏/禁用对应入口） */}
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

        {aiReady === true && (
          <Button
            icon={<MessageSquareText className="size-3.5" />}
            onClick={() => onAsk('')}
            title={
              modelReady === false
                ? '未配置模型密钥：问答将以检索结果与抽取式摘要形式提供'
                : '基于知识库检索的问答'
            }
          >
            AI 问答
            {modelReady === false && <span className="text-xs text-muted">（无模型）</span>}
          </Button>
        )}
        {aiReady === false && (
          <span
            className="text-xs text-muted"
            title="问答插件 @geewiki/ai 未激活（端点 /api/ai/ask 会 404）"
          >
            问答插件未启用
          </span>
        )}
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
          可滚动区域的键盘可达性：`tabIndex={0}` 让键盘用户能把焦点落到表格上，
          随后用方向键滚动（否则横向溢出时键盘用户看不到右侧列）。
          这是 WCAG 2.1.1（键盘）在"可滚动区域"上的具体要求，VitePress 等实现亦如此。
          `aria-label` 给这个可聚焦区域一个名字（否则屏幕阅读器只念"表格"）。
        */}
        {/*
          正文与头部**读同一个 `listState`**（互斥四态），因此不可能再出现
          "头部说加载中、正文说出错"。优先级由 `resolveAreaState` 承担并有单测
          （错误 > 加载 > 空 > 就绪）。
          注意：这里是**唯一**的错误呈现点与**唯一**的重试入口（页头那个 chip 已删除）。
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
              <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={onNew}>
                新建页面
              </Button>
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
          <div className="overflow-x-auto">
            <table
              tabIndex={0}
              aria-label="知识库页面列表"
              className="w-full border-collapse text-sm"
            >
              <thead>
                <tr>
                  {['标题', '页面标识', '版本', '最近更新'].map((h) => (
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
                {filtered.map((p) => (
                  /*
                    行的可访问性语义选择：**标题单元格内放真正的 <a>**，而不是
                    给 <tr> 加 tabIndex + role="link"。
                    理由：<tr> 一旦改成 role="link" 就破坏了表格语义（屏幕阅读器不再
                    播报行列关系），而表格的语义价值正是"这是列表、有几列"。
                    放链接则两全：链接是原生可聚焦元素（Tab 可达、可中键新开、
                    可被读作"链接"），表格结构完好。整行点击仅作为**鼠标便利**保留，
                    且不承担键盘可达性职责。
                  */
                  <tr
                    key={p.slug}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-hover"
                    onClick={() => onOpen(p.slug)}
                  >
                    <td className="border-b border-line px-3 py-2.5 align-top font-semibold">
                      {/*
                        链接的"可辨识性"与正文链接（`.md-body a`）**保持一致**：常驻细下划线、
                        悬停加粗。理由（实测 + 规范，不是主观偏好）：
                        - WCAG 2.2 · 1.4.1「不能只靠颜色」的**充分技术 G183**（
                          https://www.w3.org/WAI/WCAG21/Techniques/general/G183 ）规定：链接若
                          **仅靠颜色**与周围文字区分，则链接文字与周围文字的对比度须 ≥3:1。
                          实测本项目 `--gw-accent`(#2563eb) 对正文色 `--gw-ink`(#1c2733)
                          = **2.93:1**，**低于**该门槛；而 Wikipedia 的链接蓝(#3366cc)刻意调成
                          3.01:1 正是为了卡这条线。既然我们的链接色达不到 3:1，就**必须**给出
                          非颜色的线索——下划线是最直接的（G183 也把下划线列为推荐做法）。
                        - 同一产品里正文链接有下划线、列表标题没有，会让用户学不到统一的规则
                          （目标里的"视觉系统与一致性"）。
                        - 噪声顾虑（表格里全是下划线会吵）用**行级悬停**缓解：`tr` 是 `group`，
                          鼠标落在行内任意位置都会加强下划线，让"整行可点"的暗示浮现出来。
                      */}
                      <a
                        href={`#/wiki/${encodeURIComponent(p.slug)}`}
                        className="gw-focus-ring rounded-sm py-1 text-accent underline decoration-1 underline-offset-2 hover:text-accent-hover hover:decoration-2 group-hover:decoration-2"
                      >
                        {p.title}
                      </a>
                    </td>
                    <td className="border-b border-line px-3 py-2.5 align-top">
                      <code className="rounded-sm bg-hover px-1.5 py-0.5 font-mono text-2xs text-ink-soft">
                        {p.slug}
                      </code>
                    </td>
                    <td className="border-b border-line px-3 py-2.5 align-top text-muted">
                      v{p.version}
                    </td>
                    <td className="border-b border-line px-3 py-2.5 align-top text-muted">
                      {fmtTime(p.updated_at)}
                    </td>
                  </tr>
                ))}
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
  onEdit: () => void
  onDeleted: () => void
  onNavigate: (path: string) => void
}): ReactNode {
  const { slug, onEdit, onDeleted, onNavigate } = props
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
  const neighbors = useMemo(() => {
    if (siblings === null) return { prev: undefined, next: undefined }
    return neighborsOf(buildNavTree(siblings), slug)
  }, [siblings, slug])
  const prev = neighbors.prev
  const next = neighbors.next
  // versionContent: id=快照主键（API 定位用）；label=per-page 版本号（展示/恢复提示用）
  const [versionContent, setVersionContent] = useState<{
    id: number
    saved_at: string
    content: string
    label: number
  } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const anchor = useHashAnchor()

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
  const rendered = useRenderedMarkdown(bodyMarkdown, { route, pages: pageTitles })
  const tocIds = useMemo(() => rendered.toc.map((t) => t.id), [rendered.toc])
  const activeId = useActiveHeading(tocIds)

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
    if (!window.confirm(`确定删除页面「${page?.title ?? slug}」？版本历史将一并清除。`)) return
    api
      .deletePage(slug)
      .then(() => {
        // 列表/侧边栏必须立刻反映删除（否则会出现"点得到但打不开"的幽灵条目）
        void invalidatePages()
        onDeleted()
      })
      .catch((e: unknown) => setErr(errorLine(e)))
  }

  const showVersion = (id: number, savedAt: string, label: number): void => {
    setVersionContent(null)
    setErr('')
    api
      .version(slug, id)
      .then((v) => setVersionContent({ id, saved_at: v.saved_at, content: v.content, label }))
      .catch((e: unknown) => setErr(errorLine(e)))
  }

  const restore = (): void => {
    if (!versionContent || !page) return
    if (!window.confirm(`将 v${versionContent.label} 的内容保存为最新版本？当前正文将先写入历史。`)) return
    setRestoring(true)
    api
      .savePage(slug, { title: page.title, content: versionContent.content })
      .then((r) => {
        setNotice(`已恢复 v${versionContent.label} 内容（当前 v${r.version}）`)
        setVersionContent(null)
        load()
        void invalidatePages() // 版本变了 ⇒ 列表里的"版本"列与排序都要更新
      })
      .catch((e: unknown) => setErr(errorLine(e)))
      .finally(() => setRestoring(false))
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
    慢请求提示与列表/管理台/依赖图同款，避免同一个产品里两种加载反馈。
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
          <EmptyState
            icon={<FileText className="size-8" />}
            title="页面不存在"
            hint="它可能已被删除，或者链接里的标识有误。"
            action={<Button onClick={() => onNavigate('list')}>返回列表</Button>}
          />
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
      与列表页/管理台/依赖图一致；此前这里是裸 `aria-busy` + 一个多余的 Spinner。
    */
    return (
      <LoadingState slow={slowDetail} label="正在加载页面…">
        {/* 面包屑：`知识库 › 标题` */}
        <Skeleton className="h-4 w-48" />

        {/* 操作条：左侧「版本 vN」徽标 + 更新时间，右侧编辑/删除按钮 */}
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-40" />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>

        {/* 正文卡片：标题 + 若干**不等宽**段落行 + 一个代码块占位 */}
        <div className="rounded-lg border border-line bg-surface px-6 py-6 shadow-sm sm:px-8">
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
      </LoadingState>
    )
  }

  const versionHtml = versionContent
    ? // 与正文同款处理：历史快照也可能以 `# 标题` 开头，直接渲染会出现重复标题
      renderMarkdownBodyForPreview(
        stripDuplicateLeadingTitle(versionContent.content, page.title),
        route,
        pageTitles,
      )
    : ''

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb slug={slug} title={page.title} pages={siblings} />

      {/* 操作条：默认操作（编辑）在最右，破坏性操作（删除）用 danger 变体且与主操作隔开 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Badge tone="neutral">版本 v{page.version}</Badge>
          <span>更新于 {fmtTime(page.updated_at)}</span>
        </div>
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
          {/*
            ★ P2：按钮按**服务端下发的能力**条件渲染。
            这里隐藏只是体验，安全判定在服务端（写路径另有强制）—— 把隐藏当判定
            是本设计通篇点名的反模式。
          */}
          {page.capabilities.canDelete && (
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="size-3.5" />}
              onClick={remove}
              disabled={restoring}
            >
              删除
            </Button>
          )}
          {page.capabilities.canEdit && (
            <Button variant="primary" size="sm" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
              编辑
            </Button>
          )}
        </div>
      </div>

      {/*
        两栏：正文（含历史）在左，目录在右。
        `xl`（1280px）以下回落成单栏，目录改为正文上方的可折叠块（两份 TOC 由组件内部
        用 `xl:hidden` / `hidden xl:block` 互斥显示，因此任何时刻只有一份出现在无障碍树里）。
      */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <TableOfContents entries={rendered.toc} activeId={activeId} route={route} variant="inline" />

          <article className="rounded-lg border border-line bg-surface px-6 py-6 shadow-sm sm:px-8">
            <h1 className="mt-0 mb-3 text-2xl leading-tight font-bold text-ink">{page.title}</h1>
            {page.content.trim() === '' ? (
              <p className="text-sm text-muted">（空白页面 —— 点击「编辑」写入内容）</p>
            ) : (
              <MarkdownBody html={rendered.html} className="md-body" />
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

          <Card>
            <CardHeader
              title="版本历史"
              description={
                page.versions.length === 0
                  ? '暂无历史版本 —— 每次保存正文变化都会在此留档'
                  : `当前为 v${page.version}（上方正文）；以下是 ${page.versions.length} 个历史快照，查看快照不会改动当前内容`
              }
              actions={<History className="size-4 text-muted" aria-hidden="true" />}
            />
            {page.versions.length === 0 ? null : (
              <div className="overflow-x-auto">
                <table
                  tabIndex={0}
                  aria-label="版本历史"
                  className="w-full border-collapse text-sm"
                >
                  <thead>
                    <tr>
                      {['版本', '保存时间', '操作'].map((h) => (
                        <th
                          key={h}
                          scope="col"
                          className="border-b border-line px-4 py-2 text-left text-xs font-semibold whitespace-nowrap text-muted"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.versions.map((v, i) => {
                      const label = page.version - i - 1
                      const selected = versionContent?.id === v.id
                      return (
                        <tr key={v.id} className={cn('transition-colors', selected && 'bg-accent-soft')}>
                          <td className="border-b border-line px-4 py-2.5 align-top font-medium">
                            v{label}
                          </td>
                          <td className="border-b border-line px-4 py-2.5 align-top text-muted">
                            {fmtTime(v.saved_at)}
                          </td>
                          <td className="border-b border-line px-4 py-2.5 align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => showVersion(v.id, v.saved_at, label)}
                                aria-expanded={selected}
                              >
                                {selected ? '收起内容' : '查看内容'}
                              </Button>
                              {selected && (
                                <Button
                                  size="sm"
                                  loading={restoring}
                                  icon={<RotateCcw className="size-3.5" />}
                                  onClick={restore}
                                >
                                  恢复此版本
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {versionContent && (
              <CardBody className="border-t border-line bg-sunken">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="m-0 text-note font-medium text-ink">
                    v{versionContent.label} 快照预览
                    <span className="ml-2 font-normal text-muted">{fmtTime(versionContent.saved_at)}</span>
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => setVersionContent(null)}>
                    关闭预览
                  </Button>
                </div>
                <div className="max-h-[360px] overflow-auto rounded-md border border-line bg-surface px-5 py-4">
                  <MarkdownBody html={versionHtml} className="md-body" />
                </div>
              </CardBody>
            )}
          </Card>
        </div>

        <TableOfContents entries={rendered.toc} activeId={activeId} route={route} variant="sidebar" />
      </div>
    </div>
  )
}

/** 历史快照预览：只要 HTML，不要复制按钮（只读小窗里按钮是噪声） */
function renderMarkdownBodyForPreview(
  markdown: string,
  route: string,
  pages: ReadonlyMap<string, string> | null,
): string {
  return renderMarkdownBody(markdown, { withCopyButtons: false, route, pages }).html
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

function writeDraft(slug: string, draft: DraftRecord): void {
  try {
    window.localStorage.setItem(draftKey(slug), serializeDraft(draft))
  } catch {
    /* 配额满/被禁用：放弃这次草稿，不影响编辑 */
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
}): ReactNode {
  const { slug, onDone, onCancel } = props
  const isNew = slug === ''
  /** 本编辑页自身的 hash（未保存离开后要退回它） */
  const selfHash = isNew ? '#/wiki/new' : `#/wiki/${slug}/edit`
  const route = isNew ? 'wiki/new' : `wiki/${slug}/edit`

  const [slugInput, setSlugInput] = useState(slug)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [fieldErrors, setFieldErrors] = useState<PageFormErrors>({})
  /** 待用户决定的草稿（进入编辑页时读到的） */
  const [pendingDraft, setPendingDraft] = useState<DraftRecord | null>(null)
  /** 草稿最近一次落盘时间（0 = 尚未写过），给用户"到底存没存"的确定性 */
  const [draftSavedAt, setDraftSavedAt] = useState(0)
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
  }, [])

  const load = useCallback((): void => {
    setErr('')
    setFieldErrors({})
    if (isNew) {
      const base: PageDraft = { title: '', content: '', slugInput: '' }
      setOriginal(base)
      setLoading(false)
      const d = readDraft('')
      if (d !== null && !isDraftExpired(d, Date.now())) setPendingDraft(d)
      return
    }
    api
      .page(slug)
      .then((p) => {
        setTitle(p.title)
        setContent(p.content)
        setOrigSlug(p.slug)
        serverUpdatedAt.current = p.updated_at
        setOriginal({ title: p.title, content: p.content, slugInput: slug })
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
  }, [slug, isNew])

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
      writeDraft(isNew ? '' : slug, {
        title,
        content,
        savedAt: Date.now(),
        baseUpdatedAt: serverUpdatedAt.current,
      })
      setDraftSavedAt(Date.now())
    }, DRAFT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [title, content, slugInput, dirty, loading, isNew, slug])

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
  })

  const save = useCallback(
    async (opts: { force?: boolean } = {}): Promise<void> => {
      const target = isNew ? slugInput.trim() : slug
      const errors = validatePageForm({ isNew, slugInput, title })
      setFieldErrors(errors)
      if (hasErrors(errors)) {
        // 顶部给一句汇总（屏幕阅读器/长页面用户可能看不到字段旁的红字），字段旁给具体原因
        setErr('请先修正下面标出的问题')
        return
      }
      setErr('')

      /*
       * 冲突检测（仅编辑既有页面）：保存前取一次服务端状态，比对 `updated_at`。
       *
       * 目的：**不静默覆盖别人更新的内容**。若期间有人（或另一个标签页）保存过，
       * 就先让用户知道，由他决定是否覆盖——而不是无声地把对方的工作顶掉。
       * 代价是每次保存多一次 GET；对本应用的数据规模（单页几百 KB 以内）可接受，
       * 换来的是"丢内容"这种不可逆事故的避免。
       */
      if (!isNew && opts.force !== true) {
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
        if (isNew) removeDraft('')
        // 列表/侧边栏立刻反映新页面（新建）或新标题（改名）——否则要手动刷新才看得到
        void invalidatePages()
        onDone(isNew ? r.slug : slug)
      } catch (e) {
        setErr(errorLine(e))
        setSaving(false)
      }
    },
    [content, isNew, slug, slugInput, title, onDone],
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
    removeDraft(isNew ? '' : slug)
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

        {/* 编辑面板：宽屏左编辑/右预览两栏（与真实分屏同一断点） */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-[420px] w-full" />
          <Skeleton className="hidden h-[420px] w-full lg:block" />
        </div>
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

  const editSlug = isNew ? '' : origSlug !== '' ? origSlug : slug

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb slug={editSlug} title={isNew ? '新建页面' : editSlug} pages={editPages} />

      {/* 操作条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="m-0 text-xl font-semibold">{isNew ? '新建页面' : '编辑页面'}</h1>
        {dirty && (
          <span className="text-xs text-muted" role="status">
            {draftSavedAt > 0
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
          {isNew && (
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

      {/* 编辑 / 预览：宽屏分屏，窄屏 Tab 切换（同一份状态，两种呈现） */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-line bg-surface p-0.5 xl:hidden">
          <Button
            size="sm"
            variant={pane === 'edit' ? 'primary' : 'ghost'}
            onClick={() => setPane('edit')}
            aria-pressed={pane === 'edit'}
          >
            编辑
          </Button>
          <Button
            size="sm"
            variant={pane === 'preview' ? 'primary' : 'ghost'}
            onClick={() => setPane('preview')}
            aria-pressed={pane === 'preview'}
          >
            预览
          </Button>
        </div>
        <span className="text-xs text-muted">
          {charCount(content)} 字符 · 支持 Markdown
          <span className="hidden xl:inline"> · ⌘/Ctrl+S 保存 · ⌘/Ctrl+B 加粗 · Tab 缩进</span>
          <span className="xl:hidden"> · ⌘/Ctrl+S 保存</span>
        </span>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {/*
          两个面板都做成**可命名区域**（`<section aria-labelledby>`）而不是裸 div + span：
          按 HTML-AAM，`<section>` 只有具备可访问名称时才映射为 `region` 地标，否则是
          `generic`（等于白写）。命名后屏幕阅读器可以把「正文」与「预览」当作两个区域来
          跳转，而不是在一条无结构的文本流里摸索。

          这里**刻意不做**的事（重要）：
          - 不把预览里的 `h1` 降级、也不加 `aria-hidden`。用户正文自带的一级标题**就是内容
            结构**，而预览是"Markdown 渲染成什么样"的唯一凭据——对非视觉用户藏掉是净损失。
            故编辑页出现 2 个 h1 是**合法的**（axe 的 page-has-heading-one 只要求 ≥1，
            实测也不报此项）。
        */}
        <section
          aria-labelledby={EDITOR_PANE_LABEL_ID}
          className={cn('gw-split-pane flex flex-col gap-1.5', pane === 'preview' && 'hidden xl:flex')}
        >
          <span id={EDITOR_PANE_LABEL_ID} className="text-xs font-semibold text-ink-soft">
            正文（Markdown）{editorSlot ? ` · 由 ${editorSlot.source} 提供` : ''}
          </span>
          {editorSlot ? (
            /*
             * 插件编辑器路径：宿主把受控值与保存/取消回调交出去，插件只负责"编辑区"。
             * 草稿、脏值、冲突检测、未保存拦截仍由本组件的既有逻辑承担（见上面的 hook 注释）。
             * `onSave` 指向同一个 `save()`——不存在第二套保存实现。
             */
            <EditorSlotOutlet
              value={content}
              mode={isNew ? 'create' : 'edit'}
              slug={slugInput}
              readOnly={saving}
              onChange={setContent}
              onSave={() => void save()}
              onCancel={onCancel}
            />
          ) : (
            <MarkdownEditorLazy
              value={content}
              onChange={setContent}
              onSave={() => void save()}
              disabled={saving}
              ariaLabel="Markdown 正文编辑器"
              minHeight="480px"
              placeholder={'支持 Markdown：标题、列表、代码块、表格、链接…\n\n## 示例小节\n\n- 条目一\n- 条目二\n\n```ts\nconsole.log("hello")\n```'}
            />
          )}
        </section>

        <section
          aria-labelledby={PREVIEW_PANE_LABEL_ID}
          className={cn('gw-split-pane flex flex-col gap-1.5', pane === 'edit' && 'hidden xl:flex')}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span id={PREVIEW_PANE_LABEL_ID} className="text-xs font-semibold text-ink-soft">
              预览（本地实时渲染，非最终发布稿）
            </span>
            {/* ★ P3d：视角切换。见 PREVIEW_AUDIENCES 的说明 —— 作者自己看得到全部，所以必须有这个开关 */}
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
            标记不合法 ⇒ **保存时会被服务端拒绝**（400）。在这里就地提示，别让作者写完一大段
            才发现。服务端对废弃标记是**显式拒绝**而不是静默忽略 —— 静默忽略会让作者以为
            收紧了，实际按 public 暴露。
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
          <div className="min-h-[480px] overflow-auto rounded-md border border-line bg-surface px-5 py-4">
            {previewEmpty ? (
              <p className="m-0 text-sm text-muted">（空白）</p>
            ) : (
              <MarkdownBody html={previewRendered.html} className="md-body" />
            )}
          </div>
        </section>
      </div>

      <p className="m-0 text-xs text-muted">
        保存会把当前正文快照进版本历史（内容未变化则不产生新版本）。
        {origSlug !== '' && origSlug !== slug && ` 提示：原标识 ${origSlug} 的内容已迁移到新标识。`}
      </p>

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
