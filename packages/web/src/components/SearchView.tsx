/**
 * 检索结果视图（宿主原生 UI，走 `#/wiki/search/<q>` 子路由，可分享、刷新不丢）。
 *
 * 与 `AskPanel` 同样的三条纪律：
 * - `snippet` 是服务端已转义、只含 `<mark>` 的 HTML → 经 `snippetToHtml` 白名单消毒后注入，
 *   **不得二次转义**（否则高亮变成字面 `&lt;mark&gt;`）；
 * - 空/超长查询本地先拦一次并给明确提示，同时仍容忍后端 400；
 * - 检索插件未启用时端点 404 → 不报 error，只在结果区给出"未启用"提示。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api, type SearchResponse } from '../api'
import { checkQuery, scoreBadges, snippetToHtml } from '../lib/searchPlan'
import { SearchX } from 'lucide-react'
import { describeError } from '../lib/errorText'
import { Button, EmptyState, ErrorState } from '../ui'

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
  /** 真失败的原始错误（404「未启用」不算）；非 null 时渲染可重试的错误态 */
  const [errValue, setErrValue] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  /** 重试信号：查询串本身没变，靠它让下面的 effect 重新跑一次（比手动调函数更可靠，
   *  因为校验、清错、busy 全在那条路径上） */
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    setInput(query)
    const checked = checkQuery(query)
    if (!checked.ok) {
      setErr(checked.message)
      setData(null)
      return
    }
    setErr('')
    setErrValue(null)
    setBusy(true)
    api
      .search(checked.value)
      .then((r) => setData(r))
      .catch((e: unknown) => {
        setData(null)
        // 404 是"插件没启用"，属于**环境未就绪**而不是"请求失败"：它不可重试，
        // 也不该用错误态吓人，故只记 err 文本、不记 errValue。
        setErrValue(e instanceof ApiError && e.status === 404 ? null : e)
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
  }, [query, retryNonce])

  const submit = (): void => {
    const checked = checkQuery(input)
    if (!checked.ok) {
      setErr(checked.message)
      return
    }
    onSearch(checked.value)
  }

  // 相关度徽标：后端给的是绝对量级不定的 BM25（实测 1e-6 量级，直接 toFixed(2) 恒为 0.00），
  // 故只呈现**本次查询内的相对值**；纯逻辑在 lib/searchPlan.ts 的 scoreBadges 里并有单测。
  // 输入框打字会触发重渲染，故这里 memo 一次，避免每次都重算。
  const badges = useMemo(() => scoreBadges(data?.hits ?? []), [data])

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

      {errValue !== null ? (
        <ErrorState
          title={describeError(errValue).title}
          hint={describeError(errValue).hint}
          onRetry={describeError(errValue).retryable ? () => setRetryNonce((n) => n + 1) : undefined}
          retrying={busy}
        />
      ) : (
        err !== '' && <p className="notice">{err}</p>
      )}

      {data && (
        <>
          <div className="search-meta muted small">
            查询「{data.query}」· 命中 {data.total} 条 · 路径 {data.mode}
            {data.mode === 'like' ? '（短查询兜底）' : ''}
            {data.total > data.hits.length ? ` · 仅显示前 ${data.hits.length} 条` : ''}
            {data.mode === 'fts' ? ' · 相关度为本次查询内的相对值' : ''}
          </div>

          {data.hits.length === 0 ? (
            <EmptyState
              icon={<SearchX className="size-8" />}
              title={`没有找到与「${data.query}」相关的内容`}
              hint="换个关键词试试，或者先把这个主题写进知识库。"
              action={
                onSearch !== undefined ? (
                  <Button variant="secondary" size="sm" onClick={() => onSearch('')}>
                    返回全部页面
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <section className="card">
              <ul className="search-hit-list">
                {data.hits.map((hit, i) => {
                  const badge = badges[i]
                  return (
                    <li key={hit.slug} className="search-hit">
                      <div className="search-hit-head">
                        <button className="search-hit-title" onClick={() => onOpen(hit.slug)} title={`打开 ${hit.slug}`}>
                          {hit.title}
                        </button>
                        <code className="chip">{hit.slug}</code>
                        <span className="muted small">{fmtTime(hit.updated_at)}</span>
                        {badge && (
                          // 只呈现相对值（后端 score 是绝对量级不定的 BM25，见 lib/searchPlan.ts）
                          <span className={`badge ${badge.top ? 'badge-base' : 'badge-cold'}`} title={badge.title}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                      {/* 服务端已转义 + 只含 <mark>：按 HTML 注入以显示高亮 */}
                      <p className="search-snippet" dangerouslySetInnerHTML={{ __html: snippetToHtml(hit.snippet) }} />
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
