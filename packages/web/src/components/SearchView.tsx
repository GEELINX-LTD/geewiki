/**
 * 检索结果视图（宿主原生 UI，走 `#/wiki/search/<q>` 子路由，可分享、刷新不丢）。
 *
 * 与 `AskPanel` 同样的三条纪律：
 * - `snippet` 是服务端已转义、只含 `<mark>` 的 HTML → 经 `snippetToHtml` 白名单消毒后注入，
 *   **不得二次转义**（否则高亮变成字面 `&lt;mark&gt;`）；
 * - 空/超长查询本地先拦一次并给明确提示，同时仍容忍后端 400；
 * - 检索插件未启用时端点 404 → 不报 error，只在结果区给出"未启用"提示。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type SearchResponse } from '../api'
import { checkQuery, snippetToHtml } from '../lib/searchPlan'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

export function SearchView(props: {
  query: string
  onOpen: (slug: string) => void
  onSearch: (q: string) => void
}): ReactNode {
  const { query, onOpen, onSearch } = props
  const [input, setInput] = useState(query)
  const [data, setData] = useState<SearchResponse | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setInput(query)
    const checked = checkQuery(query)
    if (!checked.ok) {
      setErr(checked.message)
      setData(null)
      return
    }
    setErr('')
    setBusy(true)
    api
      .search(checked.value)
      .then((r) => setData(r))
      .catch((e: unknown) => {
        setData(null)
        if (e instanceof ApiError) {
          setErr(
            e.status === 404
              ? '检索服务未启用（请先在插件管理中启用 @geewiki/search）'
              : e.code === 'invalid_query'
                ? '请输入查询内容'
                : e.code === 'invalid_limit'
                  ? '结果条数超出允许范围'
                  : `检索失败：${e.message}`,
          )
        } else {
          setErr(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => setBusy(false))
  }, [query])

  const submit = (): void => {
    const checked = checkQuery(input)
    if (!checked.ok) {
      setErr(checked.message)
      return
    }
    onSearch(checked.value)
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>检索</h1>
        <div className="page-actions">
          <button className="btn" onClick={() => onOpen('')}>← 返回列表</button>
        </div>
      </div>

      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          className="search-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="检索知识库内容…"
          aria-label="检索查询"
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '检索中…' : '搜索'}
        </button>
      </form>

      {err && <p className="notice err">{err}</p>}

      {data && (
        <>
          <div className="search-meta muted small">
            查询「{data.query}」· 命中 {data.total} 条 · 路径 {data.mode}
            {data.mode === 'like' ? '（短查询兜底）' : ''}
            {data.total > data.hits.length ? ` · 仅显示前 ${data.hits.length} 条` : ''}
          </div>

          {data.hits.length === 0 ? (
            <div className="empty">未找到相关内容 —— 换个关键词，或先写入相关页面</div>
          ) : (
            <section className="card">
              <ul className="search-hit-list">
                {data.hits.map((hit) => (
                  <li key={hit.slug} className="search-hit">
                    <div className="search-hit-head">
                      <button className="search-hit-title" onClick={() => onOpen(hit.slug)} title={`打开 ${hit.slug}`}>
                        {hit.title}
                      </button>
                      <code className="chip">{hit.slug}</code>
                      <span className="muted small">{fmtTime(hit.updated_at)}</span>
                      {hit.score !== 0 && (
                        <span className="badge badge-base" title="取负后的 BM25，仅同一次查询内可比">
                          {hit.score.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {/* 服务端已转义 + 只含 <mark>：按 HTML 注入以显示高亮 */}
                    <p className="search-snippet" dangerouslySetInnerHTML={{ __html: snippetToHtml(hit.snippet) }} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
