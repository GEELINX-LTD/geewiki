/**
 * `@geewiki/editor-plain` 的客户端界面：一个朴素的 `<textarea>` 编辑器。
 *
 * ## 它证明什么
 * `editor` 插槽是**带数据的单占用**插槽（见 `packages/web/src/lib/slots.tsx` 的 `EditorSlotProps`）。
 * 本文件是该契约的**第一个真实消费者**：宿主把受控正文、保存/取消回调交进来，插件只负责编辑区。
 *
 * ## 职责边界（刻意如此）
 * - 本组件**只读写宿主给的值**（`value` + `onChange`），不碰 localStorage、不发请求、不落库。
 * - 草稿、冲突检测、未保存离开拦截、字段校验全在宿主的 `WikiEdit` 里——它们**在插槽外层**，
 *   所以换成这个编辑器不会丢掉那些保护。
 * - 保存走宿主的 `onSave`（`⌘/Ctrl+S` 由本组件捕获后转交，与内置编辑器行为一致）。
 *
 * ## 为什么是 textarea 而不是再包一层 CodeMirror
 * 内置编辑器已经是 CodeMirror。"纯文本"是一个**真实可用的替代品**（例如低配设备、
 * 或用户就想要无高亮的纯文本），这让"两个编辑器插件二选一"这件事有实际意义，
 * 而不是造一个内置编辑器的劣化复制品。
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import './style.css'

/** `EditorSlotProps` 的前端形态（本 bundle 不引宿主源码，故自带最小声明） */
interface EditorSlotProps {
  readonly value: string
  readonly mode: 'create' | 'edit'
  readonly slug: string
  readonly readOnly?: boolean
  onChange(next: string): void
  onSave(): void
  onCancel(): void
}

/** 宿主加载器调用约定：bundle 导出 register(host)，可返回清理函数 */
interface PluginUiHost {
  readonly pluginName: string
  registerSlot(name: string, component: (props: EditorSlotProps) => unknown): () => void
}

/** 字符数（按码点计，避免 emoji 被算成两个） */
function charCount(text: string): number {
  return [...text].length
}

function PlainTextEditor({ value, mode, slug, readOnly, onChange, onSave, onCancel }: EditorSlotProps): ReactNode {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const lines = useMemo(() => value.split('\n').length, [value])

  /*
   * `⌘/Ctrl+S` 保存。挂在**元素自身**而不是 window 上：焦点不在编辑器里时不该劫持快捷键
   * （宿主/浏览器自己的行为优先），这与内置编辑器的语义一致。
   */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const isSave = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's'
      if (!isSave) return
      event.preventDefault() // 拦掉浏览器"保存网页"
      onSave()
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [onSave])

  /** Tab 插入两个空格而不是跳走焦点（纯文本编辑器的既定行为） */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Tab' || readOnly === true) return
    event.preventDefault()
    const el = event.currentTarget
    const { selectionStart, selectionEnd } = el
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
    onChange(next)
    // 光标落到插入点之后（受控组件重渲染后仍需恢复）
    requestAnimationFrame(() => {
      el.selectionStart = selectionStart + 2
      el.selectionEnd = selectionStart + 2
    })
  }

  return (
    <div className="gw-plain-editor" data-editor="plain" data-mode={mode} data-slug={slug}>
      <textarea
        ref={ref}
        className="gw-plain-editor-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        readOnly={readOnly === true}
        spellCheck={false}
        aria-label="Markdown 正文编辑器（纯文本）"
        placeholder={'支持 Markdown：标题、列表、代码块、表格、链接…'}
      />
      <div className="gw-plain-editor-foot">
        <span className="gw-plain-editor-stat" data-stat="chars">
          {charCount(value)} 字符
        </span>
        <span className="gw-plain-editor-stat" data-stat="lines">
          {lines} 行
        </span>
        <span className="gw-plain-editor-hint">⌘/Ctrl+S 保存 · Tab 缩进</span>
        {readOnly === true ? (
          <span className="gw-plain-editor-stat" data-stat="readonly">
            只读
          </span>
        ) : (
          <button type="button" className="gw-plain-editor-cancel" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  )
}

export function register(host: PluginUiHost): () => void {
  return host.registerSlot('editor', PlainTextEditor)
}
