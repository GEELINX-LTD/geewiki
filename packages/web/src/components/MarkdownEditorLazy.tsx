/**
 * Markdown 编辑器的**懒加载包装**。
 *
 * 为什么单独一个文件：`React.lazy` 的工厂函数里做动态 `import()`，把 CodeMirror
 * （6 个包）整块拆成独立 chunk。读者（占绝大多数访问）永远不会下载它，
 * 只有真正进编辑页时才拉取（实测增量见汇报）。
 *
 * 加载期间显示骨架屏而不是"加载中…"：编辑器高度固定，骨架能占住同样的空间，
 * 避免"加载完成后整页跳一下"（CLS）。
 *
 * 加载失败（离线、chunk 404、部署时漏拷 assets）必须有兜底：**退回原生 `<textarea>`**。
 * 编辑器是增强，不是功能本身——拉不到 chunk 的用户仍然应该能改文档。
 */
import { Component, lazy, Suspense, useCallback, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { Skeleton } from '../ui/Skeleton'
import { Textarea } from '../ui/Input'
import { EditorToolbar } from './editor/EditorToolbar'
import { applyFormatAction, detectActiveFormats, type FormatAction } from '../lib/markdownActions'
import type { MarkdownEditorProps } from './MarkdownEditor'

const LazyEditor = lazy(() => import('./MarkdownEditor'))

/**
 * 兜底 textarea：**能力降级但工具栏仍在**。
 *
 * 三个刻意的取舍：
 * 1. **工具栏照常渲染**，且用的是与 CodeMirror 路径**同一份** `lib/markdownActions.ts`：
 *    "拉不到 chunk 就连加粗都没有"是净损失。撤销/重做交给浏览器原生（`document.execCommand`
 *    已废弃，不引第三方，故这两个按钮在降级态**不渲染**——不做一个点了没反应的按钮）。
 * 2. **模式切换与段落权限不渲染**：就地渲染需要语法树、块档位控件需要正文模型，
 *    在纯 textarea 上做不到。此时给一行**明确说明**（"已降级为纯文本编辑…"），
 *    而不是留两个点了没反应的按钮。
 * 3. `⌘/Ctrl+S`、`⌘/Ctrl+B` 等快捷键照旧（用户肌肉记忆不该因为一次 chunk 404 就失效）。
 */
function FallbackEditor(props: MarkdownEditorProps): ReactNode {
  const area = useRef<HTMLTextAreaElement | null>(null)
  const [active, setActive] = useState<ReadonlySet<FormatAction>>(() => new Set<FormatAction>())

  const sync = useCallback((): void => {
    const el = area.current
    if (el === null) return
    setActive(detectActiveFormats({ text: el.value, from: el.selectionStart, to: el.selectionEnd }))
  }, [])

  const run = useCallback(
    (action: FormatAction): void => {
      const el = area.current
      if (el === null) return
      const res = applyFormatAction(
        { text: el.value, from: el.selectionStart, to: el.selectionEnd },
        action,
      )
      props.onChange(res.text)
      // 选区要在 React 重渲染之后设，否则会被受控 value 覆盖回旧位置
      requestAnimationFrame(() => {
        const node = area.current
        if (node === null) return
        node.focus()
        node.setSelectionRange(res.from, res.to)
        sync()
      })
    },
    [props, sync],
  )

  return (
    <div className="flex flex-col gap-1.5">
      <EditorToolbar
        /*
          降级态没有"模式"这回事：`degraded` 让模式切换/撤销重做/段落权限**整组不渲染**，
          故这里给一个固定值（纯文本编辑本来就是源码形态）。
        */
        degraded
        mode="source"
        onModeChange={() => undefined}
        active={active}
        onAction={run}
        canUndo={false}
        canRedo={false}
        onUndo={() => undefined}
        onRedo={() => undefined}
        tier={null}
        onTierChange={() => undefined}
        // 降级态没有正文模型（拿不到"当前是哪一段"），故不提供授予入口 —— 不做一个点了没反应的按钮
        onManageBlockGrants={null}
        onPickFiles={null}
        disabled={props.disabled === true}
      />
      <p className="m-0 text-xs text-warn-ink" role="status">
        编辑器增强组件没有加载成功，已降级为纯文本编辑：正文、保存、⌘/Ctrl+S 都照常可用，
        但没有实时渲染、段落权限控件与撤销按钮。刷新页面可以再试一次。
      </p>
      <Textarea
        ref={area}
        aria-label={props.ariaLabel}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        spellCheck={false}
        className="font-mono text-note leading-relaxed"
        style={{ minHeight: props.minHeight ?? '420px' }}
        onChange={(e) => {
          props.onChange(e.target.value)
          sync()
        }}
        onSelect={sync}
        onKeyUp={sync}
        onClick={sync}
        onKeyDown={(e) => {
          // 降级态也要保住 ⌘/Ctrl+S 保存（否则用户会以为"按了没反应"）
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            props.onSave()
            return
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
            e.preventDefault()
            run('bold')
            return
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
            e.preventDefault()
            run('italic')
            return
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault()
            run('link')
          }
        }}
      />
    </div>
  )
}

/**
 * 最小错误边界：懒加载 chunk 取不到时 `React.lazy` 会抛错，边界捕获后切到降级编辑器。
 * 不用 `getDerivedStateFromError` 之外的花样——这里只需要"坏了就换一条路"。
 */
class EditorErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { broken: boolean }
> {
  override state = { broken: false }

  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只记录，不弹窗：用户此刻需要的是"还能编辑"，不是一堆堆栈
    console.warn(
      '[geewiki-wiki] Markdown 编辑器加载失败，已降级为纯文本编辑：',
      error,
      info.componentStack,
    )
    this.props.onError()
  }

  override render(): ReactNode {
    return this.state.broken ? null : this.props.children
  }
}

export function MarkdownEditorLazy(props: MarkdownEditorProps): ReactNode {
  const [failed, setFailed] = useState(false)
  const height = props.minHeight ?? '420px'

  if (failed) return <FallbackEditor {...props} minHeight={height} />

  return (
    <Suspense
      fallback={
        <div style={{ height }} className="w-full">
          <Skeleton className="h-full w-full rounded-md" />
        </div>
      }
    >
      <EditorErrorBoundary onError={() => setFailed(true)}>
        <LazyEditor {...props} minHeight={height} />
      </EditorErrorBoundary>
    </Suspense>
  )
}
