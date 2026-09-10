/**
 * AI 问答面板（检索增强问答的检索-only 形态也走这里）。
 *
 * 三条产品承诺决定了本组件的形状：
 * 1. **没有模型密钥时也完整可用**——后端在这种情况下仍返回 200，只是 `mode: 'retrieval-only'`
 *    且 `degraded` 非空。因此这里把降级渲染成**信息性提示条 + 完整的结果列表**，
 *    **绝不是错误页**（这是最容易做错、也最伤产品承诺的地方）。
 * 2. **`snippet` 按 HTML 渲染**（服务端已转义、只含 `<mark>`），经 `snippetToHtml` 白名单
 *    消毒后注入；**`answer` 在 `answerFormat === 'markdown'` 时经 `mdToHtml` 消毒**。
 *    两者走**不同的**消毒路径，不可互换。
 * 3. **后端插件未启用时端点 404**——调用方据此隐藏入口，**不得产生 console error**。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type AskResponse, type AskSource } from '../api'
import { mdToHtml } from '../lib/sanitize'
import { answerRenderer, checkQuery, degradedNotice, snippetToHtml } from '../lib/searchPlan'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

/** 一条来源：标题（可点）+ 高亮片段 + 引用状态 */
function SourceItem(props: { source: AskSource; onOpen: (slug: string) => void }): ReactNode {
  const { source, onOpen } = props
  return (
    <li className={`ask-source${source.used ? '' : ' ask-source-unused'}`}>
      <div className="ask-source-head">
        <button className="ask-source-title" onClick={() => onOpen(source.slug)} title={`打开 ${source.slug}`}>
          {source.title}
        </button>
        <code className="chip">{source.slug}</code>
        {source.used ? (
          source.n !== null && <span className="badge badge-active">[{source.n}] 已引用</span>
        ) : (
          <span className="badge badge-inactive" title="该来源未进入模型上下文（被截断策略丢弃）">
            未引用
          </span>
        )}
      </div>
      {/* 服务端已转义、只含 <mark>：这里必须按 HTML 注入才能显示高亮（不得二次转义） */}
      <p className="ask-snippet" dangerouslySetInnerHTML={{ __html: snippetToHtml(source.snippet) }} />
      <div className="muted small">{fmtTime(source.updated_at)}</div>
    </li>
  )
}

export function AskPanel(props: { initialQuery?: string; onOpenPage: (slug: string) => void }): ReactNode {
  const { initialQuery = '', onOpenPage } = props
  const [input, setInput] = useState(initialQuery)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState<AskResponse | null>(null)

  const submit = (raw: string): void => {
    const checked = checkQuery(raw)
    if (!checked.ok) {
      setNotice(checked.message)
      return
    }
    setNotice('')
    setBusy(true)
    api
      .aiAsk(checked.value)
      .then((r) => setResult(r))
      .catch((err: unknown) => {
        // 400 是输入问题；404 说明 @geewiki/ai 未启用（本面板本不该出现，防御性处理）
        if (err instanceof ApiError) {
          setNotice(
            err.code === 'empty_query'
              ? '请输入查询内容'
              : err.code === 'too_long'
                ? '查询过长，请缩短后重试'
                : err.status === 404
                  ? '问答服务未启用（请先在插件管理中启用 @geewiki/ai）'
                  : `问答失败：${err.message}`,
          )
        } else {
          setNotice(err instanceof Error ? err.message : String(err))
        }
        setResult(null)
      })
      .finally(() => setBusy(false))
  }

  // 带初始查询进入时自动问一次（支持可分享链接）
  useEffect(() => {
    if (initialQuery.trim() !== '') submit(initialQuery)
    // 仅在初始查询变化时触发（submit 为每次渲染新建，故意不入依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery])

  const degraded = degradedNotice(result?.degraded)
  const sources = result?.sources ?? []

  return (
    <section className="card ask-card">
      <div className="ask-head">
        <h2>AI 问答</h2>
        <span className="muted small">基于知识库检索；未配置模型密钥时提供检索结果与抽取式摘要</span>
      </div>

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <input
          className="ask-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="就知识库内容提问，例如：检索增强是怎么实现的？"
          aria-label="问答查询"
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '检索中…' : '提问'}
        </button>
      </form>

      {notice && <p className="notice err">{notice}</p>}

      {/* 降级提示条：信息性，不是错误（不用 error 样式淹没结果） */}
      {degraded && (
        <div className={`ask-degraded ask-degraded-${degraded.level}`}>
          <strong>{degraded.title}</strong>
          {degraded.detail && <span className="muted small"> {degraded.detail}</span>}
        </div>
      )}

      {result && (
        <>
          <div className="ask-meta muted small">
            模式 {result.mode}
            {result.partial ? '（回答被中断）' : ''} · 检索 {result.retrieval.mode} · 命中{' '}
            {result.retrieval.total} 条 · 耗时 {result.elapsedMs}ms
          </div>

          {result.answer !== null && result.answer.trim() !== '' ? (
            answerRenderer(result.answerFormat) === 'markdown' ? (
              // markdown 回答：必须经 mdToHtml 消毒后注入
              <div className="ask-answer md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(result.answer) }} />
            ) : (
              // 抽取式摘要是纯文本：按纯文本渲染（换行靠 CSS 保留），不经 HTML 注入
              <div className="ask-answer ask-answer-plain">{result.answer}</div>
            )
          ) : (
            sources.length === 0 && <p className="empty">未找到相关内容 —— 换个说法或先写入相关页面</p>
          )}

          {sources.length > 0 && (
            <div className="ask-sources">
              <h3>
                来源（{sources.length}
                {sources.some((s) => !s.used) ? `，其中 ${sources.filter((s) => !s.used).length} 条未引用` : ''}）
              </h3>
              <ul className="ask-source-list">
                {sources.map((s) => (
                  <SourceItem key={`${s.slug}-${s.n ?? 'unused'}`} source={s} onOpen={onOpenPage} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
