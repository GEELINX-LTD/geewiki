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
import { Component, lazy, Suspense, useState, type ErrorInfo, type ReactNode } from 'react'
import { Skeleton } from '../ui/Skeleton'
import { Textarea } from '../ui/Input'
import type { MarkdownEditorProps } from './MarkdownEditor'

const LazyEditor = lazy(() => import('./MarkdownEditor'))

/** 兜底 textarea：能力降级但功能完整 */
function FallbackEditor(props: MarkdownEditorProps): ReactNode {
  return (
    <Textarea
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      spellCheck={false}
      className="font-mono text-note leading-relaxed"
      style={{ minHeight: props.minHeight ?? '420px' }}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        // 降级态也要保住 ⌘/Ctrl+S 保存（否则用户会以为"按了没反应"）
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          props.onSave()
        }
      }}
    />
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
