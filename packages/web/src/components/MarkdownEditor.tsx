/**
 * Markdown 编辑器（CodeMirror 6）——**本模块被懒加载**，见 `MarkdownEditorLazy.tsx`。
 *
 * ## 为什么用 CodeMirror 6 而不是继续用 `<textarea>`
 * 裸 textarea 没有任何编辑辅助：没有语法高亮、没有行号、Tab 会跳出输入框、列表回车不续行、
 * 没有撤销栈之外的任何能力。这是"开发味/无法实用"最集中的地方。
 *
 * 选型与许可证（**已核实**）：CodeMirror 6 全家桶均为 **MIT**，与本项目一致。
 * 明确排除：Outline（**BSL-1.1，非开源**）、Wiki.js / Docmost（**AGPL-3.0**）——
 * 那三者只能读设计，一行代码都不能抄。
 *
 * ## 关于体积：为什么不把它打进主包
 * 它只在"编辑页"用到，而绝大多数访问是**阅读**。打进主包会让每个读者都下载一份编辑器。
 * 因此经 `React.lazy` + 动态 `import()` 拆成独立 chunk（实测增量见汇报）。
 *
 * ## 主题：用我们自己的 token，不引第三方主题包
 * 所有颜色都写成 `var(--gw-…)`，于是**深浅色自动跟随**（token 本身随 `.dark` 切换），
 * 不需要为两套主题各写一份，也不需要监听主题变化去 reconfigure。
 * `EditorView.theme` 的 `dark` 标志在此**不是必需的**：它主要用于 CodeMirror 内建样式的
 * 明暗分支，而我们把相关样式全部用变量覆盖了；`color-scheme` 由 `theme.ts` 设在
 * `<html>` 上，编辑器从根继承（原生滚动条/选区随之正确）。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { markdown, markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'

/**
 * 语法高亮：颜色全部取自设计 token（于是自动适配深浅色）。
 *
 * `tags` 来自 `@lezer/highlight`——它是 CodeMirror 语言层的**标准入口**
 * （`@codemirror/language` 并不再导出 `tags`），因此这里把它列为**直接依赖**：
 * pnpm 的严格 node_modules 布局下，靠传递依赖 import 会直接解析失败（实测确认），
 * 而这正是我们想要的——依赖必须显式声明，不能靠"碰巧被装上了"。
 */
import { tags as t } from '@lezer/highlight'

const highlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--gw-ink)' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700', color: 'var(--gw-ink)' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '600', color: 'var(--gw-ink)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--gw-ink-soft)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--gw-ink)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--gw-ink-muted)' },
  { tag: [t.link, t.url], color: 'var(--gw-accent)', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'var(--gw-font-mono)', color: 'var(--gw-accent-soft-ink)' },
  { tag: t.quote, color: 'var(--gw-ink-muted)', fontStyle: 'italic' },
  { tag: [t.list, t.contentSeparator], color: 'var(--gw-ink-soft)' },
  { tag: t.processingInstruction, color: 'var(--gw-ink-muted)' },
  { tag: t.meta, color: 'var(--gw-ink-muted)' },
])

/** 编辑器外观（用 token，自动适配深色） */
const baseTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    border: '1px solid var(--gw-line)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--gw-surface)',
    color: 'var(--gw-ink)',
  },
  '&.cm-focused': {
    outline: '2px solid var(--gw-focus-ring)',
    outlineOffset: '2px',
    borderColor: 'var(--gw-accent)',
  },
  '.cm-content': {
    fontFamily: 'var(--gw-font-mono)',
    padding: '10px 0',
    caretColor: 'var(--gw-accent)',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--gw-surface-sunken)',
    color: 'var(--gw-ink-muted)',
    border: 'none',
    borderRight: '1px solid var(--gw-line)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--gw-surface-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--gw-surface-hover)', color: 'var(--gw-ink-soft)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--gw-accent-soft)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--gw-accent-soft)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--gw-accent)' },
  '.cm-placeholder': { color: 'var(--gw-ink-muted)', fontStyle: 'normal' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--gw-font-mono)' },
  '.cm-panels': {
    backgroundColor: 'var(--gw-surface-sunken)',
    color: 'var(--gw-ink)',
    borderColor: 'var(--gw-line)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--gw-warn-bg)', outline: '1px solid var(--gw-warn-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--gw-accent-soft)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--gw-accent-soft)', outline: '1px solid var(--gw-accent-soft-line)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--gw-surface)',
    border: '1px solid var(--gw-line)',
    color: 'var(--gw-ink)',
  },
})

/**
 * 加粗：把选区包进 `**`。
 *
 * 自己写而不是找现成命令：CodeMirror 没有内建的"切换加粗"（那是 Markdown 编辑器层面的
 * 业务动作）。做法与常见编辑器一致：
 * - 有选区 ⇒ 包住选区；若两侧已有 `**` 则**去掉**（再按一次取消，符合直觉）；
 * - 无选区 ⇒ 插入 `****` 并把光标放中间，用户直接打字即为粗体。
 *
 * 用 `changeByRange` 而不是拼接字符串：它由 CodeMirror 统一处理多光标/多选区，
 * 且返回的 `selection` 会被正确映射（否则多光标下选区会错位）。
 */
function toggleBold(view: EditorView): boolean {
  const { state } = view
  const changes = state.changeByRange((range) => {
    const before = state.sliceDoc(Math.max(0, range.from - 2), range.from)
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + 2))
    // 情况一：选区外已有 `**…**` ⇒ 取消加粗
    if (before === '**' && after === '**' && range.from !== range.to) {
      return {
        changes: [
          { from: range.from - 2, to: range.from },
          { from: range.to, to: range.to + 2 },
        ],
        range: EditorSelection.range(range.from - 2, range.to - 2),
      }
    }
    // 情况二：选中的文本自身以 `**` 开头结尾 ⇒ 去掉标记
    const text = state.sliceDoc(range.from, range.to)
    if (range.from !== range.to && text.startsWith('**') && text.endsWith('**') && text.length >= 4) {
      const inner = text.slice(2, -2)
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      }
    }
    // 情况三：普通包裹
    return {
      changes: { from: range.from, to: range.to, insert: `**${text}**` },
      range:
        range.from === range.to
          ? EditorSelection.range(range.from + 2, range.from + 2)
          : EditorSelection.range(range.from, range.to + 4),
    }
  })
  view.dispatch(changes, { scrollIntoView: true, userEvent: 'input' })
  return true
}

export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  /** ⌘/Ctrl+S：由父组件执行**既有**保存路径（本组件绝不自己发请求） */
  onSave: () => void
  placeholder?: string
  disabled?: boolean
  /** 供 `<label>`/屏幕阅读器使用的可访问名称 */
  ariaLabel: string
  minHeight?: string
}

export default function MarkdownEditor(props: MarkdownEditorProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  /** 用 ref 持有回调：keymap 在创建时闭包捕获，若直接捕获 props 就会永远用第一版回调 */
  const onChangeRef = useRef(props.onChange)
  const onSaveRef = useRef(props.onSave)
  const editable = new Compartment()

  onChangeRef.current = props.onChange
  onSaveRef.current = props.onSave

  useEffect(() => {
    const parent = host.current
    if (parent === null) return

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlightStyle),
      markdown({ base: markdownLanguage, addKeymap: false }),
      cmPlaceholder(props.placeholder ?? ''),
      baseTheme,
      EditorView.lineWrapping,
      editable.of(EditorView.editable.of(!props.disabled)),
      keymap.of([
        // 保存：拦截浏览器默认（否则会弹"保存网页"）——真正落盘由父组件负责
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current()
            return true
          },
        },
        { key: 'Mod-b', preventDefault: true, run: toggleBold },
        // 列表/引用里回车自动续行，退格跨过标记——Markdown 编辑最常用的两个动作
        { key: 'Enter', run: insertNewlineContinueMarkup },
        { key: 'Backspace', run: deleteMarkupBackward },
        // 查找面板（⌘F）也要能用，否则大文档里找一段很难
        { key: 'Mod-f', preventDefault: true, run: openSearchPanel },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab, // Tab 缩进（而不是把焦点移走）
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
      }),
    ]

    const instance = new EditorView({
      state: EditorState.create({ doc: props.value, extensions }),
      parent,
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // 仅创建一次：后续的 value/disabled 变化由下面的 effect 处理，
    // 若把 props 放进依赖列表，每次按键都会重建编辑器（光标与撤销栈全丢）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部 value 变化（例如"恢复草稿"/切换页面）→ 同步进文档
  useEffect(() => {
    const instance = view.current
    if (instance === null) return
    const current = instance.state.doc.toString()
    if (current === props.value) return
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: props.value },
      // 外部整体替换不进入撤销栈的历史语义吗？——进入，用户应能撤销"恢复草稿"
      userEvent: 'input',
    })
  }, [props.value])

  useEffect(() => {
    const instance = view.current
    if (instance === null) return
    instance.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!props.disabled)) })
  }, [props.disabled, editable])

  return (
    <div
      ref={host}
      className="overflow-hidden rounded-md"
      style={{ minHeight: props.minHeight ?? '420px' }}
      aria-label={props.ariaLabel}
      role="group"
    />
  )
}
