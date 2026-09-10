import { useEffect, useState, type ReactNode } from 'react'
import { api, type PageDetail, type PageSummary } from '../api'
import { mdToHtml } from '../lib/sanitize'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

function slugOk(slug: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(slug)
}

/** Wiki 页：sub 为 hash 中 'wiki/' 之后的子路径（'' = 列表，'new' = 新建，slug = 详情） */
export function WikiPage(props: { sub: string; onNavigate: (path: string) => void }): ReactNode {
  const { sub, onNavigate } = props
  const seg = sub.split('/').filter(Boolean)
  // 未知深层路径 → 导航副作用收敛到 useEffect（不在 render 期改 location）
  const unknownDeep = seg.length >= 2 && seg[1] !== 'edit'
  useEffect(() => {
    if (unknownDeep) onNavigate('')
  }, [unknownDeep, onNavigate])
  if (unknownDeep) return null
  if (seg.length === 0 || seg[0] === 'list') return <WikiList onOpen={(slug) => onNavigate(slug)} onNew={() => onNavigate('new')} />
  if (seg[0] === 'new') return <WikiEdit slug="" onDone={(slug) => onNavigate(slug)} onCancel={() => onNavigate('')} />
  // 20 行起 seg.length ≥ 1 且首段非 list/new：非空 slug
  const slug = seg[0] ?? ''
  if (seg.length === 1) return <WikiDetail key={slug} slug={slug} onEdit={() => onNavigate(`${slug}/edit`)} onDeleted={() => onNavigate('')} onNavigate={onNavigate} />
  if (seg[1] === 'edit') return <WikiEdit key={slug} slug={slug} onDone={() => onNavigate(slug)} onCancel={() => onNavigate(slug)} />
  return null
}

/* ============================ 列表 ============================ */

function WikiList(props: { onOpen: (slug: string) => void; onNew: () => void }): ReactNode {
  const { onOpen, onNew } = props
  const [pages, setPages] = useState<PageSummary[] | null>(null)
  const [err, setErr] = useState('')

  const load = (): void => {
    setErr('')
    api
      .pages()
      .then((r) => setPages(r.pages))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

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
