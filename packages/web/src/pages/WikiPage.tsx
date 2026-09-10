import { useEffect, useState, type ReactNode } from 'react'
import { FileText, MessageSquareText, Plus, RefreshCw, Search } from 'lucide-react'
import { ApiError, api, type PageDetail, type PageSummary } from '../api'
import { AskPanel } from '../components/AskPanel'
import { SearchView } from '../components/SearchView'
import { SEARCH_INPUT_ID } from '../lib/domIds'
import { stripDuplicateLeadingTitle, titleForRoute } from '../lib/pageMeta'
import { mdToHtml } from '../lib/sanitize'
import { checkQuery } from '../lib/searchPlan'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { Button, Card, CardBody, CardHeader, EmptyState, Input, SkeletonTable } from '../ui'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

function slugOk(slug: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(slug)
}

/** hash 段里的查询串解码（用户可能在地址栏手输，容错返回原文） */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Wiki 页：sub 为 hash 中 'wiki/' 之后的子路径。
 * 保留段：'' | 'list'（列表）、'new'（新建）、'search/<q>'（检索）、'ask[/<q>]'（问答）、
 * `<slug>[/edit]`（详情/编辑）。**检索与问答是宿主原生 UI**（见 lib/slots.tsx 的冻结裁决：
 * 插件组件不接收 props），因此不走 Slot，而是这里自己的路由。
 */
export function WikiPage(props: { sub: string; onNavigate: (path: string) => void }): ReactNode {
  const { sub, onNavigate } = props
  const seg = sub.split('/').filter(Boolean)
  const first = seg[0] ?? ''
  // 允许作为第二段的保留字（其余深层路径视为未知 → 回列表）
  const allowedSecond = seg[1] === 'edit' || first === 'search' || first === 'ask'
  const unknownDeep = seg.length >= 2 && !allowedSecond
  // 未知深层路径 → 导航副作用收敛到 useEffect（不在 render 期改 location）
  useEffect(() => {
    if (unknownDeep) onNavigate('')
  }, [unknownDeep, onNavigate])
  if (unknownDeep) return null

  if (seg.length === 0 || first === 'list') {
    return <WikiList onOpen={(slug) => onNavigate(slug)} onNew={() => onNavigate('new')} onSearch={(q) => onNavigate(`search/${encodeURIComponent(q)}`)} onAsk={(q) => onNavigate(q === '' ? 'ask' : `ask/${encodeURIComponent(q)}`)} />
  }
  if (first === 'search') {
    const q = decodeSegment(seg[1] ?? '')
    return <SearchView key={q} query={q} onOpen={(slug) => onNavigate(slug)} onSearch={(next) => onNavigate(`search/${encodeURIComponent(next)}`)} />
  }
  if (first === 'ask') {
    const q = decodeSegment(seg[1] ?? '')
    return (
      <div className="page">
        <div className="page-head">
          <h1>问答</h1>
          <div className="page-actions">
            <button className="btn" onClick={() => onNavigate('')}>← 返回列表</button>
          </div>
        </div>
        <AskPanel key={q} initialQuery={q} onOpenPage={(slug) => onNavigate(slug)} />
      </div>
    )
  }
  if (first === 'new') return <WikiEdit slug="" onDone={(slug) => onNavigate(slug)} onCancel={() => onNavigate('')} />
  // 到这里 seg.length ≥ 1 且首段非保留字：非空 slug
  const slug = first
  if (seg.length === 1) return <WikiDetail key={slug} slug={slug} onEdit={() => onNavigate(`${slug}/edit`)} onDeleted={() => onNavigate('')} onNavigate={onNavigate} />
  if (seg[1] === 'edit') return <WikiEdit key={slug} slug={slug} onDone={() => onNavigate(slug)} onCancel={() => onNavigate(slug)} />
  return null
}

/* ============================ 列表 ============================ */

function WikiList(props: {
  onOpen: (slug: string) => void
  onNew: () => void
  onSearch: (q: string) => void
  onAsk: (q: string) => void
}): ReactNode {
  const { onOpen, onNew, onSearch, onAsk } = props
  const [pages, setPages] = useState<PageSummary[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
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
    setErr('')
    api
      .pages()
      .then((r) => setPages(r.pages))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

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
          {err !== '' && (
            <span className="rounded-md border border-danger-line bg-danger-bg px-3 py-1 text-[13px] text-danger-ink">
              {err}
            </span>
          )}
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
          <span className="rounded-md border border-danger-line bg-danger-bg px-3 py-1 text-[13px] text-danger-ink">
            {queryNotice}
          </span>
        )}
      </div>

      <Card>
        <CardHeader
          title="全部页面"
          description={
            pages === null
              ? '正在加载…'
              : pages.length === 0
                ? '还没有内容'
                : `共 ${pages.length} 个页面`
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
        {pages === null ? (
          <SkeletonTable rows={4} cols={4} />
        ) : pages.length === 0 ? (
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
                {pages.map((p) => (
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
                    className="cursor-pointer transition-colors duration-150 hover:bg-hover"
                    onClick={() => onOpen(p.slug)}
                  >
                    <td className="border-b border-line px-3 py-2.5 align-top font-semibold">
                      <a
                        href={`#/wiki/${encodeURIComponent(p.slug)}`}
                        className="gw-focus-ring rounded-sm py-1 text-accent hover:underline"
                      >
                        {p.title}
                      </a>
                    </td>
                    <td className="border-b border-line px-3 py-2.5 align-top">
                      <code className="rounded-sm bg-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
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

function WikiDetail(props: {
  slug: string
  onEdit: () => void
  onDeleted: () => void
  onNavigate: (path: string) => void
}): ReactNode {
  const { slug, onEdit, onDeleted } = props
  const [page, setPage] = useState<PageDetail | null>(null)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  // versionContent: id=快照主键（API 定位用）；label=per-page 版本号（展示/恢复提示用，与历史行一致）
  const [versionContent, setVersionContent] = useState<{
    id: number
    saved_at: string
    content: string
    label: number
  } | null>(null)
  const [restoring, setRestoring] = useState(false)

  // 详情页标题需要页面数据（异步）：拿到后覆盖 App 设的路由级基线标题；
  // 拿不到时 titleForRoute 会退化为「知识库 · GeeWiki」，不会显示 slug。
  useDocumentTitle(titleForRoute(`wiki/${slug}`, page?.title ?? null))

  const load = (): void => {
    setErr('')
    api
      .page(slug)
      .then((r) => setPage(r))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [slug])

  const remove = (): void => {
    if (!window.confirm(`确定删除页面「${page?.title ?? slug}」？版本历史将一并清除。`)) return
    api
      .deletePage(slug)
      .then(() => onDeleted())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }

  const showVersion = (id: number, savedAt: string, label: number): void => {
    setVersionContent(null)
    setErr('')
    api
      .version(slug, id)
      .then((v) => setVersionContent({ id, saved_at: v.saved_at, content: v.content, label }))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
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
        void load()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setRestoring(false))
  }

  if (err && !page) {
    return (
      <div className="page">
        <div className="page-head"><h1>页面不存在</h1></div>
        <div className="empty err-text">{err}</div>
        <button className="btn" onClick={() => window.history.back()}>← 返回</button>
      </div>
    )
  }
  if (!page) return <div className="page"><div className="empty">加载中…</div></div>

  // 页面标题单独渲染一次（下面的 h1），若正文自己又以 `# 同名标题` 开头就会重复出现，
  // 故渲染前把重复的首个一级标题剥掉（纯字符串操作，正文仍照常经 mdToHtml 消毒）。
  const html = mdToHtml(stripDuplicateLeadingTitle(page.content, page.title))
  const htmlVersion = versionContent ? mdToHtml(versionContent.content) : ''

  return (
    <div className="page page-detail">
      <div className="detail-top">
        <button className="btn small ghost" onClick={() => window.history.back()}>← 返回列表</button>
        {notice && <span className="notice ok">{notice}</span>}
        {err && <span className="notice err">{err}</span>}
        <div className="spacer" />
        <span className="muted small">版本 v{page.version} · 更新于 {fmtTime(page.updated_at)}</span>
        <button className="btn small" onClick={remove}>删除</button>
        <button className="btn small primary" onClick={onEdit}>✎ 编辑</button>
      </div>

      <article className="md-body">
        <h1 className="md-title">{page.title}</h1>
        {page.content.trim() === '' ? (
          <p className="empty">（空白页面 —— 点击「编辑」写入内容）</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </article>

      <section className="card history-card">
        <h2>版本历史</h2>
        {page.versions.length === 0 ? (
          <p className="empty">暂无历史版本 —— 每次保存正文变化都会在此留档</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>版本</th>
                <th>保存时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {page.versions.map((v, i) => (
                <tr key={v.id}>
                  <td>v{page.version - i - 1}</td>
                  <td className="muted">{fmtTime(v.saved_at)}</td>
                  <td>
                    <button className="btn small ghost" onClick={() => showVersion(v.id, v.saved_at, page.version - i - 1)}>查看内容</button>
                    {versionContent?.id === v.id && (
                      <button className="btn small" disabled={restoring} onClick={restore}>
                        {restoring ? '恢复中…' : '↺ 恢复此版本'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {versionContent && (
          <div className="version-preview">
            <div className="version-preview-head">
              <strong>v{versionContent.label} 快照（{fmtTime(versionContent.saved_at)}）预览</strong>
              <button className="btn small ghost" onClick={() => setVersionContent(null)}>✕ 关闭</button>
            </div>
            <div className="md-body" dangerouslySetInnerHTML={{ __html: htmlVersion }} />
          </div>
        )}
      </section>
    </div>
  )
}

/* ============================ 编辑 / 新建 ============================ */

function WikiEdit(props: { slug: string; onDone: (slug: string) => void; onCancel: () => void }): ReactNode {
  const { slug, onDone, onCancel } = props
  const isNew = slug === ''
  const [slugInput, setSlugInput] = useState(slug)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [origSlug, setOrigSlug] = useState('')

  useEffect(() => {
    if (isNew) {
      setLoading(false)
      return
    }
    setErr('')
    api
      .page(slug)
      .then((p) => {
        setTitle(p.title)
        setContent(p.content)
        setOrigSlug(p.slug)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [slug, isNew])

  const save = (): void => {
    const target = isNew ? slugInput.trim() : slug
    if (isNew && !slugOk(target)) {
      setErr('页面标识需以字母或数字开头，仅含 a-z 0-9 . _ -，≤80 字符')
      return
    }
    if (!title.trim()) {
      setErr('标题不能为空')
      return
    }
    setSaving(true)
    setErr('')
    api
      .savePage(target, { title: title.trim(), content })
      .then((r) => {
        // 新建时 slug 可能规范化，统一跳转到服务端确认的 slug
        onDone(isNew ? r.slug : slug)
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e))
        setSaving(false)
      })
  }

  if (loading) return <div className="page"><div className="empty">加载中…</div></div>

  const previewHtml = mdToHtml(content)

  return (
    <div className="page page-edit">
      <div className="detail-top">
        <button className="btn small ghost" onClick={onCancel} disabled={saving}>← 取消</button>
        {err && <span className="notice err">{err}</span>}
        <div className="spacer" />
        <button className="btn small" disabled={saving} onClick={() => setTab(tab === 'edit' ? 'preview' : 'edit')}>
          {tab === 'edit' ? '👁 预览' : '✎ 继续编辑'}
        </button>
        <button className="btn small primary" disabled={saving || loading} onClick={save}>
          {saving ? '保存中…' : '💾 保存'}
        </button>
      </div>

      <div className="edit-form">
        {isNew && (
          <label className="field">
            <span>页面标识（URL 中的路径，如 getting-started）</span>
            <input value={slugInput} onChange={(e) => setSlugInput(e.target.value.trim())} placeholder="my-page" spellCheck={false} />
          </label>
        )}
        <label className="field">
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="页面标题" />
        </label>
        {tab === 'edit' ? (
          <label className="field grow">
            <span>正文（Markdown）</span>
            <textarea
              className="md-editor"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={'支持 Markdown：标题、列表、代码块、链接…\n\n# 示例\n\n- 条目一\n- 条目二\n\n```ts\nconsole.log("hello")\n```'}
              spellCheck={false}
            />
          </label>
        ) : (
          <div className="field grow">
            <span>预览（保存前本地渲染）</span>
            <div className="md-body preview-box">
              {content.trim() === '' ? <p className="empty">（空白）</p> : <div dangerouslySetInnerHTML={{ __html: previewHtml }} />}
            </div>
          </div>
        )}
      </div>
      {origSlug && origSlug !== slug && <p className="muted small">提示：原标识 {origSlug} 的内容已迁移到新标识</p>}
      <div className="edit-footer muted">保存会把当前正文快照进版本历史（内容未变化则不产生新版本）。</div>
    </div>
  )
}
