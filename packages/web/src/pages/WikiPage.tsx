import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type PageDetail, type PageSummary } from '../api'
import { AskPanel } from '../components/AskPanel'
import { SearchView } from '../components/SearchView'
import { mdToHtml } from '../lib/sanitize'
import { checkQuery } from '../lib/searchPlan'

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
    // 能力探测：未启用 @geewiki/ai 时该端点 404 —— 按契约静默降级，绝不产生 console error
    api
      .aiCapabilities()
      .then((c) => setModelReady(c.available))
      .catch((e: unknown) => {
        console.debug('[geewiki-wiki] 问答能力探测跳过：', e instanceof Error ? e.message : e)
        setModelReady(null)
      })
  }, [])

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
    <div className="page">
      <div className="page-head">
        <h1>知识库</h1>
        <div className="page-actions">
          {err && <span className="notice err">{err}</span>}
          <button className="btn" onClick={load}>↻ 刷新</button>
          <button className="btn primary" onClick={onNew}>＋ 新建页面</button>
        </div>
      </div>

      {/* 检索与问答入口（宿主原生 UI；插件未启用时隐藏对应入口） */}
      <div className="wiki-tools">
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault()
            submitSearch()
          }}
        >
          <input
            className="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchReady === false ? '检索插件未启用' : '检索知识库内容…'}
            aria-label="检索知识库"
            disabled={searchReady === false}
          />
          <button className="btn primary" type="submit" disabled={searchReady === false}>
            搜索
          </button>
        </form>
        {aiReady === true && (
          <button
            className="btn"
            onClick={() => onAsk('')}
            title={
              modelReady === false
                ? '未配置模型密钥：问答将以检索结果与抽取式摘要形式提供'
                : '基于知识库检索的问答'
            }
          >
            💬 AI 问答
            {modelReady === false && <span className="muted small">（无模型）</span>}
          </button>
        )}
        {aiReady === false && (
          <span className="muted small" title="问答插件 @geewiki/ai 未激活（端点 /api/ai/ask 会 404）">
            问答插件未启用
          </span>
        )}
        {queryNotice && <span className="notice err">{queryNotice}</span>}
      </div>

      <section className="card">
        <table className="table">
          <thead>
            <tr>
              <th>标题</th>
              <th>页面标识</th>
              <th>版本</th>
              <th>最近更新</th>
            </tr>
          </thead>
          <tbody>
            {pages === null && (
              <tr>
                <td colSpan={4} className="empty">加载中…</td>
              </tr>
            )}
            {pages?.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">还没有页面 —— 点击右上角「新建页面」开始记录</td>
              </tr>
            )}
            {pages?.map((p) => (
              <tr key={p.slug} className="clickable" onClick={() => onOpen(p.slug)}>
                <td className="title-cell">{p.title}</td>
                <td><code className="chip">{p.slug}</code></td>
                <td>v{p.version}</td>
                <td className="muted">{fmtTime(p.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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

  const html = mdToHtml(page.content)
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
