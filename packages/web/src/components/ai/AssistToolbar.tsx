/**
 * AI 辅助写作工具条（编辑态）。
 *
 * ## 三条硬规则（与后端 `packages/plugin-ai/src/assist.ts` 的文件头同源）
 *
 * 1. **AI 绝不直接落库**：产物只进编辑器缓冲区，落库仍走既有的保存路径（`save()`）。
 *    采纳必须**显式确认**（预览弹窗里的按钮），丢弃也是显式动作 —— 本仓库对
 *    "静默改数据"有明确纪律（同 `newPageGate` 的禁用+说明、`ConfirmDialog` 的确认框）。
 * 2. **上下文只来自编辑器里的文本**：请求体里的 `selection`/`before` 由本组件从**用户正在
 *    编辑的内容**里取出，服务端不做任何检索 ⇒ 用户看不到的受限段落不可能进入模型上下文。
 * 3. **没有模型就明确不可用**：`modelReady === false` 或响应 `mode: 'unavailable'` 时
 *    **不显示任何生成文本**，只给禁用按钮 + `role="status"` 的可见原因。
 *
 * ## 为什么挂在宿主的编辑面板里，而不是塞进编辑器内部
 *
 * `EditorSlotProps`（`@geewiki/core`）目前**没有**选区/插入通道，且 `editor` 是单占用插槽：
 * 把 AI 入口做进编辑器插件，会让第三方编辑器一占插槽就把宿主的 AI 能力一起带走，
 * 也会第二次加重"插槽契约缺上传/选区"这笔债。入口留在宿主 ⇒ 无论谁当编辑器，工具条都在。
 */
import { useCallback, useState, type ReactNode, type RefObject } from 'react'
import { Dialog, DialogContent } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { focusRing, touchTarget } from '../../ui/a11y'
import { errorLine } from '../../lib/errorText'
import { api, ApiError, type AiAssistAction, type AiAssistResponse } from '../../api'
import {
  ASSIST_ACTION_LABEL,
  ASSIST_ACTION_ORDER,
  appliedText,
  applyLabel,
  availableActions,
  buildAssistRequest,
  canApplyToBody,
  unavailableText,
  type AssistSelection,
} from '../../lib/assistPlan'
import type { MarkdownEditorHandle } from '../MarkdownEditor'

export interface AssistToolbarProps {
  /** 全文（用于"续写"的上下文与可用性判定） */
  docText: string
  title: string
  slug: string
  /** 编辑器上报的当前选区（`null` = 无选区） */
  selection: AssistSelection | null
  /** 编辑器插入句柄（采纳写回的唯一通路） */
  handleRef: RefObject<MarkdownEditorHandle | null>
  /** `@geewiki/ai` 是否已激活（未激活时端点 404，入口应说明而不是报错） */
  pluginActive: boolean
  /** 模型是否可用（`GET /api/ai/capabilities` 的 `available`；null = 探测中） */
  modelAvailable: boolean | null
  /** 不可用时给用户看的**可见**原因（由宿主导出，空串 = 可用） */
  modelHint: string
  /** 写回成功后的状态播报（复用编辑页既有的提示区） */
  onApplied?: (text: string) => void
}

/** 能力还在探测时的文案：宁可先禁用，也不要给一个点了必然 502 的按钮 */
const MODEL_PENDING_HINT = '正在确认模型是否就绪…'

/** 预览弹窗的状态机：`result` 非空即为"有待确认的产物" */
interface PreviewState {
  action: AiAssistAction
  result: AiAssistResponse
}

export function AssistToolbar(props: AssistToolbarProps): ReactNode {
  const [busy, setBusy] = useState<AiAssistAction | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [err, setErr] = useState('')

  const enabled = availableActions({ selection: props.selection, docText: props.docText })
  /**
   * 不可用原因只由宿主给（它才是"插件是否激活 / 模型是否就绪"的知情方）。
   * 探测中（`modelAvailable === null`）也按不可用处理：宁可先禁用，也不要给一个点了必然 502 的按钮。
   */
  const modelHint = props.modelHint !== '' ? props.modelHint : props.modelAvailable === true ? '' : MODEL_PENDING_HINT

  const run = useCallback(
    async (action: AiAssistAction): Promise<void> => {
      setErr('')
      setBusy(action)
      try {
        const body = buildAssistRequest({
          action,
          selection: props.selection,
          docText: props.docText,
          title: props.title,
          slug: props.slug,
        })
        const res = await api.aiAssist(body)
        // `mode === 'unavailable'` 也可能以 200 回来（服务端按契约优先用 502，但这里两种都兜住）
        setPreview({ action, result: res })
      } catch (e) {
        // 502 是**降级**而不是网络故障：`request()` 会抛 ApiError，但语义要按"不可用"呈现
        if (e instanceof ApiError && e.status === 502) {
          const body = (e.details ?? null) as AiAssistResponse | null
          if (body && body.mode === 'unavailable') {
            setPreview({ action, result: body })
            return
          }
        }
        setErr(errorLine(e))
      } finally {
        setBusy(null)
      }
    },
    [props.selection, props.docText, props.title, props.slug],
  )

  /** 采纳：把产物写回编辑器缓冲区（**不发任何请求**，落库仍走用户自己的保存） */
  const apply = useCallback((): void => {
    const current = preview
    if (current === null || current.result.text === null) return
    const text = current.result.text
    const handle = props.handleRef.current
    if (handle === null) {
      setErr('编辑器尚未就绪：请点一下正文区域后重试。')
      return
    }
    if (current.action === 'continue') handle.insertAtCursor(text)
    else handle.replaceSelection(text)
    props.onApplied?.(appliedText(current.action))
    setPreview(null)
  }, [preview, props])

  const unavailableInPreview =
    preview !== null && (preview.result.mode === 'unavailable' || preview.result.text === null)

  return (
    <div className="flex flex-wrap items-center gap-2" data-ai-assist="">
      <span className="text-note text-muted">AI 辅助</span>
      {ASSIST_ACTION_ORDER.map((action) => {
        const disabled = !enabled.includes(action) || busy !== null || modelHint !== ''
        return (
          <button
            key={action}
            type="button"
            disabled={disabled}
            onClick={() => void run(action)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-note text-ink',
              'transition-colors duration-150 ease-standard hover:bg-hover',
              'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface',
              focusRing,
              touchTarget,
            )}
            /* 禁用原因**同时**给可见文本（下面那条 role=status）与 title：
               只挂 title 对触屏与读屏都不可达（本仓库既有教训）。 */
            title={modelHint !== '' ? modelHint : enabled.includes(action) ? '' : '先在正文里选中一段文字'}
          >
            {busy === action ? '生成中…' : ASSIST_ACTION_LABEL[action]}
          </button>
        )
      })}
      {(modelHint !== '' || err !== '') && (
        <span className="text-note text-warn-ink" role="status">
          {err !== '' ? err : modelHint}
        </span>
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => (open ? undefined : setPreview(null))}>
        {preview !== null && (
          <DialogContent
            title={`AI ${ASSIST_ACTION_LABEL[preview.action]}`}
            description={
              unavailableInPreview
                ? '这次没有生成内容 —— 正文未被改动，可以重试或关掉。'
                : '下面是 AI 产物。确认后才会写入编辑器（⌘Z 可撤销），关掉对话框不会改动正文。'
            }
            footer={
              <>
                <Button variant="secondary" onClick={() => setPreview(null)}>
                  丢弃
                </Button>
                {!unavailableInPreview && canApplyToBody(preview.action) && (
                  <Button variant="primary" onClick={apply}>
                    {applyLabel(preview.action)}
                  </Button>
                )}
                {!unavailableInPreview && !canApplyToBody(preview.action) && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(preview.result.text ?? '')
                    }}
                  >
                    复制摘要
                  </Button>
                )}
              </>
            }
          >
            {unavailableInPreview ? (
              <p className="text-note text-warn-ink" role="status">
                {/* 运行期才发现的不可用：用响应里的 degraded.message（已由服务端脱敏）*/}
                {props.modelHint !== ''
                  ? props.modelHint
                  : unavailableText({
                      pluginActive: props.pluginActive,
                      modelAvailable: props.modelAvailable === true,
                      degraded: preview.result.degraded,
                    }) || '模型当前不可用。'}
                {preview.result.degraded?.message ? `（${preview.result.degraded.message}）` : ''}
              </p>
            ) : (
              <pre className="max-h-[50vh] overflow-auto rounded-md border border-line bg-sunken p-3 text-note whitespace-pre-wrap text-ink">
                {preview.result.text}
              </pre>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
