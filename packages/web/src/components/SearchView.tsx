/**
 * 检索结果视图（宿主原生 UI，走 `#/wiki/search/<q>` 子路由，可分享、刷新不丢）。
 *
 * 与 `AskPanel` 同样的三条纪律：
 * - `snippet` 是服务端已转义、只含 `<mark>` 的 HTML → 经 `snippetToHtml` 白名单消毒后注入，
 *   **不得二次转义**（否则高亮变成字面 `&lt;mark&gt;`）；
 * - 空/超长查询本地先拦一次并给明确提示，同时仍容忍后端 400；
 * - 检索插件未启用时端点 404 → 不报 error，只在结果区给出"未启用"提示。
 *
 * ## 查询语义（`mode`）为什么必须在界面上可见
 *
 * 后端有两种问法（`packages/plugin-search/src/index.ts`）：`phrase` 要求整串**逐字连续**出现，
 * `terms` 切词元后 OR。此前界面上**没有**这个开关，宿主永远用缺省的 `phrase` —— 于是出现一个
 * 反直觉的现象：**同一句话，AI 助手能搜到，人在搜索框里敲却恒为 0 命中**（AI 那条路径显式传了
 * `mode: 'terms'`，见 `packages/plugin-ai-kb/src/index.ts`）。本组件把语义做成可见、可切换的一等
 * 公民，并在"精确匹配 0 命中"时**只引导不自动重试**（静默换模式会让用户以为自己搜的就是原串）。
 *
 * 注意与响应里的 `data.mode`（`fts`/`like`，服务端最终走了哪条路）区分：那是"服务端怎么答的"，
 * 这里是"我们怎么问的"，两者会在结果区同时出现，措辞刻意不同。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, api, type SearchResponse } from '../api'
import {
  QUERY_MODE_OPTIONS,
  checkQuery,
  detectQueryMode,
  emptySearchHint,
  emptySearchPlan,
  queryModeNote,
  queryModeOption,
  scoreBadges,
  snippetToHtml,
  type SearchQueryMode,
} from '../lib/searchPlan'
import { SearchX } from 'lucide-react'
import { describeError, errorLine } from '../lib/errorText'
import { Button, EmptyState, ErrorState } from '../ui'

/** 首屏条数（与后端默认一致）、每次「加载更多」的增量、以及后端 `MAX_LIMIT`（超过会被判 invalid_limit） */
const PAGE_FIRST = 20
const PAGE_STEP = 40
const PAGE_MAX = 100

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
  /**
   * 本轮查询请求的条数上限（初始 = 后端默认 20）。
   *
   * 服务端一次最多给 100 条（`packages/plugin-search/src/index.ts` 的 MAX_LIMIT），
   * 所以这里按 20 → 60 → 100 递增，**不做真正的翻页**：后端按相关度整体排序，
   * offset 分页在"边搜边改"的场景下会让用户看到重复/漏掉的条目，而 100 条以内
   * 直接放大 limit 更简单也更可预期。
   */
  const [limit, setLimit] = useState(PAGE_FIRST)
  /**
   * 本轮查询语义（`phrase` / `terms`）。
   *
   * **随查询串重置**：`route.q` 变化意味着用户提交了一次新检索，此时按新串重新猜一个缺省
   * （见下面 effect 里的 `lastQuery` 分支）。用户在同一串上手动切过的选择只对那一串有效——
   * 把上一次的偏好带到下一次查询，会让"为什么这次又是分词"变得无法解释。
   */
  const [mode, setMode] = useState<SearchQueryMode>(() => detectQueryMode(query))
  /** 上一次发起取数的查询串：用来识别"查询变了 ⇒ limit 与 mode 都必须复位"，见下面的 effect */
  const lastQuery = useRef<string | null>(null)

  useEffect(() => {
    setInput(query)
    const checked = checkQuery(query)
    if (!checked.ok) {
      setErr(checked.message)
      setData(null)
      return
    }
    /*
      查询串变了 ⇒ **分页与查询语义都复位**（否则新关键词会直接带着上一轮的 limit 去取，
      首屏就变成"已显示 100 / N"，既慢又把"这只是第一屏"这件事藏了起来）。
      实现上提前 return 一次、由 `setLimit` / `setMode` 触发本 effect 再跑一遍：这样同一轮里
      只会发**一次**请求（若在这里直接继续，旧 limit 与新 limit 两次请求会并发，
      先到的那次可能覆盖后到的）。
    */
    if (lastQuery.current !== query) {
      lastQuery.current = query
      const next = detectQueryMode(query)
      // 只在真的不同时才 set：无谓的 set 会多触发一轮 effect（值相同 React 会跳过，
      // 但"值相同"这件事在这里依赖 React 的比较，显式判一次更不容易踩坑）
      if (limit !== PAGE_FIRST || mode !== next) {
        setLimit(PAGE_FIRST)
        setMode(next)
        return
      }
    }
    setErr('')
    setErrValue(null)
    setBusy(true)
    api
      .search(checked.value, { limit, mode })
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
                  : errorLine(e),
          )
        } else {
          setErr(errorLine(e))
        }
      })
      .finally(() => setBusy(false))
  }, [query, retryNonce, limit, mode])

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

  /*
   * 空结果区的按钮与文案**同源**：都从这一个 plan 派生。
   * 先前是两处各判一次（hint 与按钮分别调 suggestTermsOnEmpty），一旦判据变化就会
   * 出现"给了按钮却说了反话"这类自相矛盾的界面。
   *
   * `modesConverge` 缺省按 `false` 兜底（老响应/异常形状）：宁可多给一个按钮，
   * 也不要在能换的时候把入口藏掉。
   */
  const emptyPlan = emptySearchPlan(mode, data?.total ?? 0, data?.modesConverge ?? false)

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

      {/*
        查询语义切换。放在表单**下方**而不是塞进输入行：它与"搜什么"正交，是"怎么搜"。
        用 aria-pressed 的切换按钮而非 Tabs —— 两个模式是**同一次检索**的两种问法，
        面板是同一个（与 `components/editor/EditorToolbar.tsx` 的模式切换同款理由）。

        `disabled={busy}`：切换会立即重发请求，而 in-flight 时放开会产生两个并发请求，
        先到的那个可能覆盖后到的（与上面 effect 里 limit 复位的注释同一个理由）。
        详细说明走 `title`，行内只放短标注——那段 hint 有两行，铺在行内会压过输入框。
      */}
      <div className="search-mode" role="group" aria-label="查询语义">
        <span className="muted small">匹配方式</span>
        {QUERY_MODE_OPTIONS.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant={mode === o.id ? 'primary' : 'ghost'}
            aria-pressed={mode === o.id}
            title={o.hint}
            disabled={busy || query.trim() === ''}
            onClick={() => setMode(o.id)}
          >
            {o.label}
          </Button>
        ))}
        <span className="muted small" title={queryModeOption(mode).hint}>
          {queryModeNote(mode)}
        </span>
      </div>

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
            查询「{data.query}」· 命中 {data.total} 条 · 问法 {queryModeNote(mode)}
            {data.mode === 'like' ? ' · 服务端走 LIKE 短查询兜底' : ''}
            {data.total > data.hits.length ? ` · 仅显示前 ${data.hits.length} 条` : ''}
            {data.mode === 'fts' ? ' · 相关度为本次查询内的相对值' : ''}
          </div>

          {data.hits.length === 0 ? (
            <EmptyState
              icon={<SearchX className="size-8" />}
              title={`没有找到与「${data.query}」相关的内容`}
              hint={emptySearchHint(emptyPlan, mode)}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  {emptyPlan === 'switch-terms' && (
                    <Button variant="primary" size="sm" onClick={() => setMode('terms')}>
                      改用分词匹配
                    </Button>
                  )}
                  {onSearch !== undefined ? (
                    <Button variant="secondary" size="sm" onClick={() => onSearch('')}>
                      返回全部页面
                    </Button>
                  ) : null}
                </div>
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
                        {/*
                          结果是**真链接**（`<a href="#/wiki/<slug>">`）而不是 `<button onClick>`：
                          按钮无法中键新开、无法右键复制链接、也无法被读屏当链接播报。
                          普通左键点击仍走宿主路由（`onOpen`）——`preventDefault` 只拦这一种，
                          带修饰键的点击（⌘/Ctrl/Shift）与中键一律放行给浏览器原生行为。
                          Tab 可达性与焦点环由 `.search-hit-title` 的样式负责（见 styles.css）。
                        */}
                        <a
                          className="search-hit-title"
                          href={`#/wiki/${encodeURIComponent(hit.slug)}`}
                          title={`打开 ${hit.slug}`}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                            e.preventDefault()
                            onOpen(hit.slug)
                          }}
                        >
                          {hit.title}
                        </a>
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

          {/*
            分页（本批 T2）：「加载更多」每次 +40、上限 100（后端 MAX_LIMIT）。
            两种情况各有**不同**的下一步：
            - 还有更多 ⇒ 给按钮，并把"已显示/总命中"如实写在按钮上；
            - 已经到 100 条上限 ⇒ 不给按钮（点了也不会更多），改为引导缩小关键词 ——
              否则用户会以为"结果就这些"，而实际上是上限截断。
          */}
          {data.hits.length > 0 &&
            (data.hits.length < data.total && data.hits.length < PAGE_MAX ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() => setLimit((n) => Math.min(n + PAGE_STEP, PAGE_MAX))}
                >
                  {`加载更多（已显示 ${data.hits.length} / ${data.total}）`}
                </Button>
              </div>
            ) : data.hits.length < data.total ? (
              <p className="notice">{`命中 ${data.total} 条，已达上限 ${PAGE_MAX} 条 —— 请用更具体的关键词缩小范围。`}</p>
            ) : null)}
        </>
      )}
    </div>
  )
}
