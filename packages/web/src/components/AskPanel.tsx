/**
 * AI 问答面板（**流式**：模型 token 逐个出现；检索-only 降级形态也走这里）。
 *
 * 四条产品承诺决定了本组件的形状：
 * 1. **没有模型密钥时也完整可用**——后端在这种情况下仍返回正常响应，只是 `mode: 'retrieval-only'`
 *    且 `degraded` 非空。因此这里把降级渲染成**信息性提示条 + 完整的结果列表**，
 *    **绝不是错误页**（这是最容易做错、也最伤产品承诺的地方）。
 * 2. **先给来源、再给答案**：`status` 帧一到就渲染来源列表与降级提示条，用户不必等 token
 *    才知道"检索到了什么"。
 * 3. **`snippet` 按 HTML 渲染**（服务端已转义、只含 `<mark>`），经 `snippetToHtml` 白名单
 *    消毒后注入；**`answer` 在 `answerFormat === 'markdown'` 时经 `mdToHtml` 消毒**。
 *    两者走**不同的**消毒路径，不可互换。流式过程中**按纯文本渲染累积值**（每帧跑 markdown
 *    消毒既慢又会在半截表格/代码块上抖动），到 `done` 再用权威文本走正式渲染。
 * 4. **后端插件未启用时端点 404**——先**静默回退**到一次性端点 `POST /api/ai/ask`（旧版本/
 *    未启用都能工作）；回退也 404 才提示"未启用"。全程**不得产生 console error**。
 *
 * 取消：组件卸载、路由切换、再次提交都会 `abort()`，**取消不渲染成错误**。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, api, type AskResponse, type AskSource } from '../api'
import { mdToHtml } from '../lib/sanitize'
import { answerRenderer, checkQuery, degradedNotice, snippetToHtml } from '../lib/searchPlan'
import { streamErrorText, cleanHint, errorLine } from '../lib/errorText'
import { Button, EmptyState, ErrorState } from '../ui'
import { SearchX } from 'lucide-react'
import {
  applyAiStreamEvent,
  applyLocalFailure,
  initialAiStreamState,
  markAiStreamStarted,
  visibleAnswer,
  type AiStreamState,
} from '../lib/aiStreamPlan'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

/** 把一次性端点（回退路径）的响应装进同一套流式状态，使渲染分支只有一条 */
function fromAskResponse(r: AskResponse): AiStreamState {
  return {
    ...initialAiStreamState(),
    phase: 'done',
    mode: r.mode,
    retrieval: r.retrieval,
    sources: r.sources,
    degraded: r.degraded,
    answer: r.answer,
    answerFormat: r.answerFormat,
    usage: r.usage,
    partial: r.partial,
    elapsedMs: r.elapsedMs,
  }
}

/** 流开始前失败的提示文案（输入问题 / 未启用 / 并发超限 / 其它） */
function preStreamNotice(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'empty_query') return '请输入查询内容'
    if (err.code === 'too_long') return '查询过长，请缩短后重试'
    if (err.code === 'too_many_streams') return '同时进行的问答过多，请稍候再试'
    if (err.code === 'invalid_extractive' || err.code === 'invalid_limit') {
      // 这两类是**我们自己的**参数校验（提问参数由前端组装），文案已经是中文且可读；
      // 仍走 cleanHint 保证不会把技术串带出来。
      return cleanHint(err.message) === '' ? '请求参数不合法' : `请求参数不合法：${cleanHint(err.message)}`
    }
    if (err.status === 404) return '问答服务未启用（请先在插件管理中启用 @geewiki/ai）'
    // 其它情况**绝不回显原始 message**（可能带 API 路径/英文）——统一走人话映射。
    return errorLine(err)
  }
  return errorLine(err)
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
  const [notice, setNotice] = useState('')
  const [state, setState] = useState<AiStreamState>(() => initialAiStreamState())
  /** 在途请求的取消句柄：卸载/切换/再次提交都要 abort，避免连接泄漏 */
  const abortRef = useRef<AbortController | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const submit = useCallback((raw: string): void => {
    const checked = checkQuery(raw)
    if (!checked.ok) {
      setNotice(checked.message)
      return
    }
    setNotice('')
    // 重新提交：先取消上一次在途的流
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setState(markAiStreamStarted(initialAiStreamState()))

    const onEvent = (ev: Parameters<typeof applyAiStreamEvent>[1]): void => {
      if (ac.signal.aborted || !aliveRef.current) return
      setState((s) => applyAiStreamEvent(s, ev))
    }

    void (async () => {
      try {
        await api.aiAskStream(checked.value, { signal: ac.signal, onEvent })
      } catch (err) {
        if (ac.signal.aborted || !aliveRef.current) return // 取消：不当作失败
        // 404 = 端点不存在（插件未启用 / 版本较旧）→ 静默回退到一次性端点
        if (err instanceof ApiError && err.status === 404) {
          try {
            const r = await api.aiAsk(checked.value)
            if (ac.signal.aborted || !aliveRef.current) return
            setState(fromAskResponse(r))
          } catch (fallbackErr) {
            if (ac.signal.aborted || !aliveRef.current) return
            setNotice(preStreamNotice(fallbackErr))
          }
          return
        }
        // 流开始前的 4xx 多为输入问题，用顶部提示更清楚
        if (err instanceof ApiError && err.status < 500) {
          setNotice(preStreamNotice(err))
          setState((s) => (s.phase === 'streaming' ? { ...s, phase: 'idle' } : s))
          return
        }
        // 网络中断等：落在答案区，**保留已渲染的来源**
        setState((s) => applyLocalFailure(s, 'stream_failed', errorLine(err)))
      }
    })()
  }, [])

  // 带初始查询进入时自动问一次（支持可分享链接）
  useEffect(() => {
    if (initialQuery.trim() !== '') submit(initialQuery)
    // 仅在初始查询变化时触发（submit 已在 useCallback 里固定）
  }, [initialQuery, submit])

  const degraded = degradedNotice(state.degraded)
  const sources = state.sources
  const streaming = state.phase === 'streaming'
  const answer = visibleAnswer(state)
  const hasAnswer = answer.text.trim() !== ''

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
        <button className="btn primary" type="submit" disabled={streaming}>
          {streaming ? '生成中…' : '提问'}
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

      {(state.phase !== 'idle' || state.mode !== null) && (
        <>
          {state.mode !== null && (
            <div className="ask-meta muted small">
              模式 {state.mode}
              {/*
                `status.mode` 是**生成前的意图**（后端契约如此：有可用 provider 就说 'rag'）。
                因此当流结束、答案其实是抽取式摘要（plain）却一帧增量都没收到时，
                要如实标注，不能让用户以为这是模型回答。
              */}
              {state.phase === 'done' && state.deltaCount === 0 && state.answer !== null && (
                <> （未收到模型增量，答案为抽取式摘要）</>
              )}
              {state.partial ? '（回答被中断）' : ''}
              {state.retrieval && (
                <>
                  {' '}
                  · 检索 {state.retrieval.mode} · 命中 {state.retrieval.total} 条
                </>
              )}
              {state.phase === 'done' && <> · 耗时 {state.elapsedMs}ms</>}
              {streaming && <> · 生成中…</>}
            </div>
          )}

          {/* 答案区：流式期间纯文本 + 光标；`done` 后按 answerFormat 正式渲染 */}
          {state.error ? (
            /*
              修掉一处"开发味"：原实现把 `{state.error.code}` 直接印给用户（RATE_LIMIT /
              TIMEOUT / PROVIDER_ERROR 这类**内部错误码**），普通用户读不懂，且不该知道。
              现在按 code 映射成人话 + 给出该做什么；code 本身只在 title 里留作排障线索。
              同时补上「重试」（此前的错误态是死路，用户只能手工重打一遍问题）。
            */
            /*
              外层的 `role="alert"` 已删除：`ErrorState` 自身就是 `role="alert"`，
              再包一层会造成**嵌套的两个 alert 区域**，读屏可能把同一件事播报两次。
              错误码只在 `title` 里留作排障线索，不印在界面上。
            */
            <div className="ask-answer ask-answer-error" title={state.error.code}>
              <ErrorState
                className="border-0 bg-transparent px-0 py-2"
                title={streamErrorText(state.error.code).title}
                hint={
                  sources.length > 0
                    ? `${streamErrorText(state.error.code).hint}（已检索到的来源仍列在下方）`
                    : streamErrorText(state.error.code).hint
                }
                onRetry={() => submit(input)}
              />
            </div>
          ) : hasAnswer ? (
            answer.authoritative && answerRenderer(answer.format) === 'markdown' ? (
              // markdown 回答：必须经 mdToHtml 消毒后注入
              <div className="ask-answer md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(answer.text) }} />
            ) : (
              // 流式中的累积文本、以及抽取式摘要：纯文本渲染（换行靠 CSS 保留）
              <div className={`ask-answer ask-answer-plain${streaming ? ' ask-answer-streaming' : ''}`}>
                {answer.text}
                {streaming && <span className="ask-cursor" aria-hidden="true" />}
              </div>
            )
          ) : streaming ? (
            <div className="ask-answer ask-answer-plain ask-answer-streaming">
              <span className="ask-cursor" aria-hidden="true" />
            </div>
          ) : (
            state.phase === 'done' &&
            sources.length === 0 && (
              <EmptyState
                icon={<SearchX className="size-8" />}
                title="没有找到能回答这个问题的资料"
                hint="换个说法，或先把相关主题写进知识库——问答只在已有页面里找依据，不会凭空作答。"
                action={
                  <Button variant="secondary" size="sm" onClick={() => onOpenPage('')}>
                    去知识库看看
                  </Button>
                }
              />
            )
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
