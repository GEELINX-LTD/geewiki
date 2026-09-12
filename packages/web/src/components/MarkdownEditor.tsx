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
 *
 * ## 附件上传（M4）：粘贴与拖入文件
 *
 * 编辑器**不做任何网络请求**（与 `onSave` 同一约定）：它只负责"把文件交给父组件、
 * 把结果写回正文"。父组件（`pages/WikiPage.tsx`）用 `uploadAttachment()` 真正上传。
 *
 * 三条硬约束（都有真机教训，别改回去）：
 * 1. **drop 必须 `preventDefault()`**：浏览器对"把文件拖进页面"的默认动作是**导航到该文件**
 *    —— 用户丢掉的是整页编辑内容。粘贴同理（默认会把图片以 data URI 形式塞进文档，
 *    等于把二进制内容写进页面正文，保存后体积爆炸）。
 * 2. **先插占位、后按文本替换**：上传是异步的，这期间用户会继续打字，任何"记住的偏移量"
 *    都会失效。占位文本带单调序号，替换时**重新查找**（见 `lib/attachmentPlan.ts`）。
 * 3. **失败必须留在正文里**：写成 `> ⚠️ 上传失败：…` 而不是只弹一条提示——用户可能同时
 *    拖了 5 个文件，只有"失败的那一行"能说清是哪一个没上去。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { Button } from '../ui/Button'
import { errorLine } from '../lib/errorText'
import { useSlowHint } from '../lib/useSlowHint'
import {
  findUploadPlaceholder,
  uploadFailureMarkdown,
  uploadPlaceholder,
  uploadSummaryText,
} from '../lib/attachmentPlan'

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

export interface MarkdownEditorHandle {
  /** 在光标处插入（有选区时**替换**选区 —— 与 CodeMirror 的 `replaceSelection` 同语义） */
  insertAtCursor(text: string): void
  /** 只替换当前选区；无选区时不动作并返回 `false`（调用方据此提示而不是静默） */
  replaceSelection(text: string): boolean
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
  /**
   * 粘贴/拖入文件时的上传入口：返回**与入参一一对应**的 Markdown 文本（父组件负责网络、
   * 权限与"新页面还没保存"这类业务判断）。不传 = 本场景不支持上传：此时仍然拦掉浏览器
   * 默认动作（导航走 / 塞 data URI），只在状态行里说明，绝不让用户以为"什么都没发生"。
   */
  onUploadFiles?: (files: File[]) => Promise<string[]>
  /**
   * 选区变化回调（供**宿主**的 AI 辅助写作判断"此刻能做什么"）。
   *
   * 为什么由宿主驱动而不是编辑器内建：AI 辅助的入口在编辑面板（宿主 UI），
   * 且第三方编辑器插件占用 `editor` 插槽时宿主仍要可用 —— 选区上报做成**可选**能力，
   * 不提供时宿主的动作按"无选区"降级，不会因为缺少这一路而失效。
   *
   * 回调参数：`null` = 无选区（光标态）；否则给出 `from`/`to` 与选中文本。
   */
  onSelectionChange?: (sel: { from: number; to: number; text: string } | null) => void
  /**
   * 宿主可调用的插入句柄（AI 辅助"采纳"用）。
   *
   * 三种落点：`replace` = 替换当前选区；`insert` = 在光标处插入；`clear` = 清空文档后写入。
   * 全部走 `userEvent: 'input'` 事务 ⇒ **⌘Z 一次即可撤销**（AI 产物绝不进"不可撤销"的路径）。
   */
  handleRef?: React.RefObject<MarkdownEditorHandle | null>
}

/* ------------------------- 附件上传：可复用的纯函数 ------------------------- */

/** 从 DataTransfer 取出文件（过滤掉目录：目录在 `files` 里 name 为空串） */
function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (dt === null) return []
  const out: File[] = []
  for (const f of Array.from(dt.files ?? [])) {
    if (f.name !== '') out.push(f)
  }
  return out
}

/**
 * 在视图里插入一段文本。
 * `pos === null`（粘贴）⇒ 走**当前选区**；给了坐标（拖放）⇒ 插到落点。
 * 两种都带 `userEvent: 'input'`：上传占位与最终结果都必须能被 ⌘Z 撤销。
 */
function insertIntoView(instance: EditorView, text: string, pos: number | null): void {
  if (pos === null) {
    instance.dispatch(instance.state.replaceSelection(text), {
      userEvent: 'input',
      scrollIntoView: true,
    })
    return
  }
  instance.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input',
    scrollIntoView: true,
  })
}

/**
 * 把文档里的**占位文本**替换成最终结果；占位已不存在时返回 `false`（不往别处插）。
 * 详见 `lib/attachmentPlan.ts` 里"为什么按文本查找"的说明。
 */
function replacePlaceholderInView(instance: EditorView, placeholder: string, insert: string): boolean {
  const range = findUploadPlaceholder(instance.state.doc.toString(), placeholder)
  if (range === null) return false
  instance.dispatch({ changes: { from: range.from, to: range.to, insert }, userEvent: 'input' })
  return true
}

/** 一次上传批次里，某个 File 与其在正文中的落点（首次是"上传中"占位，重试时是失败说明） */
interface UploadSlot {
  file: File
  placeholder: string
}

export default function MarkdownEditor(props: MarkdownEditorProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  /** 用 ref 持有回调：keymap 在创建时闭包捕获，若直接捕获 props 就会永远用第一版回调 */
  const onChangeRef = useRef(props.onChange)
  const onSaveRef = useRef(props.onSave)
  const onUploadRef = useRef(props.onUploadFiles)
  /**
   * `disabled` 也要用 ref 读：DOM handler 建在依赖为空的 effect 里，直接闭包捕获会永远是
   * 第一版取值。保存进行中（`disabled`）时若还接受上传，插入的正文会落在"已经发出去的
   * 那次保存"之后 —— 保存成功随即导航离开，这段刚插入的内容就**静默丢失**了。
   */
  const disabledRef = useRef(props.disabled)
  /** 选区回调也用 ref：updateListener 只在创建时挂一次，直接闭包捕获会永远是第一版 */
  const onSelectionRef = useRef(props.onSelectionChange)
  /**
   * 上一次上报给宿主的选区键（`from:to`）。
   *
   * 为什么需要它：CodeMirror 的 update 会在**每次按键**触发，而选区绝大多数时候没变。
   * 不比对就上报会让宿主每敲一个字就重渲染一次工具条（还会打断输入法组合）。
   */
  const lastSelectionRef = useRef<string>('')
  const editable = new Compartment()
  /** 占位序号：同一次会话内单调递增，保证多文件同时上传时占位互不冲突 */
  const seqRef = useRef(0)
  /** 在飞的上传数量（驱动"仍在上传…"的慢提示） */
  const [uploading, setUploading] = useState(0)
  /** 状态行文案（成功/失败各一条，用 `role="status"` 礼貌播报） */
  const [uploadNote, setUploadNote] = useState('')
  /** 失败待重试的文件（连同它们在正文里的失败说明，重试成功后按文本替换掉） */
  const [failures, setFailures] = useState<UploadSlot[]>([])
  const slow = useSlowHint(uploading > 0)

  onChangeRef.current = props.onChange
  onSaveRef.current = props.onSave
  onUploadRef.current = props.onUploadFiles
  disabledRef.current = props.disabled
  onSelectionRef.current = props.onSelectionChange

  /**
   * 上报选区（带去重）。`instance` 由调用方给出：初始挂载时 `view.current` 还没赋值，
   * 而 updateListener 的第一次回调就发生在构造过程中。
   */
  const reportSelection = useCallback((instance: EditorView): void => {
    const cb = onSelectionRef.current
    if (!cb) return
    const range = instance.state.selection.main
    const key = `${range.from}:${range.to}`
    if (key === lastSelectionRef.current) return
    lastSelectionRef.current = key
    if (range.empty) cb(null)
    else cb({ from: range.from, to: range.to, text: instance.state.sliceDoc(range.from, range.to) })
  }, [])

  // 把插入句柄交给宿主（AI 辅助"采纳"用）。依赖数组里带上句柄对象本身：
  // 宿主传 `undefined` 时也要把上一次挂上的清掉，避免"页面切走了句柄还指着旧编辑器"。
  useEffect(() => {
    const target = props.handleRef
    if (!target) return
    target.current = {
      insertAtCursor: (text: string) => {
        const instance = view.current
        if (instance === null) return
        insertIntoView(instance, text, null)
      },
      replaceSelection: (text: string) => {
        const instance = view.current
        if (instance === null) return false
        if (instance.state.selection.main.empty) return false
        insertIntoView(instance, text, null)
        return true
      },
    }
    return () => {
      target.current = null
    }
  }, [props.handleRef])

  /**
   * 跑一批上传：`slots` 里的 `placeholder` 是**替换锚点**——首次上传时是"上传中…"占位，
   * 重试时是那条失败说明本身（两者都靠文本查找定位，见 `lib/attachmentPlan.ts`）。
   *
   * 每个文件**单独**调用 `upload`：一次拖 5 个文件时，一个 413 不该让另外 4 个也失败。
   */
  const startBatch = useCallback(
    (
      slots: UploadSlot[],
      anchor: EditorView,
      upload: (files: File[]) => Promise<string[]>,
    ): void => {
      let settled = 0
      let inserted = 0
      let missing = 0
      const failed: UploadSlot[] = []
      setUploading((n) => n + slots.length)
      setUploadNote(slots.length === 1 ? '正在上传 1 个附件…' : `正在上传 ${slots.length} 个附件…`)

      for (const slot of slots) {
        void upload([slot.file])
          .then((out) => {
            const text = (out[0] ?? '').trim()
            if (text === '') {
              // 契约是"与入参一一对应"。返回空串 = 父组件没给出可插入的正文，**不能静默**
              const marker = uploadFailureMarkdown('上传完成，但没有拿到可插入的正文内容')
              replacePlaceholderInView(anchor, slot.placeholder, marker)
              failed.push({ file: slot.file, placeholder: marker })
              return
            }
            if (replacePlaceholderInView(anchor, slot.placeholder, text)) inserted++
            // 占位已不在文档里（用户上传期间删了它）：尊重这个意图，不插入、也不提供重试
            else missing++
          })
          .catch((e: unknown) => {
            // 原因经 `errorLine` 清洗：界面（含正文）不得出现原始 message / API 路径
            const marker = uploadFailureMarkdown(errorLine(e))
            replacePlaceholderInView(anchor, slot.placeholder, marker)
            failed.push({ file: slot.file, placeholder: marker })
          })
          .finally(() => {
            settled++
            if (settled < slots.length) return
            setUploading((n) => Math.max(0, n - slots.length))
            setFailures((prev) => [...prev, ...failed])
            setUploadNote(uploadSummaryText(inserted, failed.length, missing))
          })
      }
    },
    [],
  )

  /** 粘贴/拖入文件的总入口（DOM handler 经 ref 调它，避免闭包捕获第一版 props） */
  const runUploads = useCallback(
    (files: File[], pos: number | null): void => {
      const instance = view.current
      if (instance === null || files.length === 0) return
      if (disabledRef.current) {
        // 只读/保存中：浏览器默认动作已由 DOM handler 拦下，这里**一个占位也不插**
        setUploadNote('正在保存，附件上传已暂停；请等保存完成后再试')
        return
      }
      const upload = onUploadRef.current
      if (upload === undefined) {
        // 没有上传能力时**不插占位**：正文里不能留下一个永远替换不掉的"上传中…"
        setUploadNote('当前场景未启用附件上传（已拦下浏览器默认动作，正文未被改动）')
        return
      }
      const slots: UploadSlot[] = files.map((file) => ({
        file,
        placeholder: uploadPlaceholder(++seqRef.current),
      }))
      /*
        多个占位之间留一个空行：紧挨着的 `![](a)![](b)` 会被 Markdown 当成同一段落里
        连续两张图片；其中一个失败时替换出来的引用块会与相邻图片粘在一行，读起来像胡话。
      */
      insertIntoView(instance, slots.map((s) => s.placeholder).join('\n\n'), pos)
      startBatch(slots, instance, upload)
    },
    [startBatch],
  )

  /** DOM handler 创建于 effect（依赖为空），故用 ref 拿最新实现 */
  const runUploadsRef = useRef(runUploads)
  runUploadsRef.current = runUploads

  /**
   * 重试失败的上传。
   * **重试的是同一个 `File` 对象**（保存在 `failures` 里）：裸 body PUT 只要 File 还在内存里
   * 就能原样重发，不需要用户重新选一次文件——这正是"失败也要把 File 留着"的用处。
   */
  const retryUploads = useCallback((): void => {
    const instance = view.current
    const upload = onUploadRef.current
    if (instance === null || upload === undefined || failures.length === 0) return
    const pending = failures
    // 先移出待重试项（失败时 `startBatch` 会把它们重新加回来），避免列表里出现两份
    setFailures([])
    startBatch(pending, instance, upload)
  }, [failures, startBatch])

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
      /*
        可访问名称必须落在**真正可聚焦的那个元素**上：CodeMirror 给 `.cm-content`
        （contenteditable）加了 `role="textbox"`，而外层包裹元素上的 `aria-label`
        **不会**成为它的名称——读屏用户 Tab 进来只会听到一个**无名文本框**。
        （axe 规则 `aria-input-field-name` 正是这样命名的：它查的就是 role=textbox 自身。）
        故用 CodeMirror 官方的 `contentAttributes` 把名称交给它自己。
        注：本 effect 的依赖数组刻意为空（见下方注释），故 `ariaLabel` 只在创建时读取一次；
        调用点传的是字面量（`packages/web/src/pages/WikiPage.tsx` 的「Markdown 正文编辑器」），
        不是会变化的运行期值。
      */
      EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel }),
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
        // 选区变化也要上报：宿主据此决定"改写选中"能不能点
        if (u.selectionSet || u.docChanged || u.focusChanged) reportSelection(u.view)
      }),
      /*
        附件：粘贴 / 拖入文件。两个 handler 都**自己 preventDefault**（理由见文件头）：
        浏览器的默认动作分别是"把 data URI 塞进文档"与"整页导航到该文件"，
        两者都会造成不可逆的损失，因此即使本场景没接上传（onUploadFiles 缺省）也要拦。
      */
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = filesFromDataTransfer(event.clipboardData)
          if (files.length === 0) return false // 普通文本粘贴：交回 CodeMirror 的默认行为
          event.preventDefault()
          runUploadsRef.current(files, null)
          return true
        },
        drop: (event, instance) => {
          const files = filesFromDataTransfer(event.dataTransfer)
          if (files.length === 0) return false
          /*
            落点必须在 `preventDefault()` 之前取：`posAtCoords` 读的是当前布局，拦下默认
            行为之后浏览器不会再给第二次机会，而且**只能在这里**拿到拖放的坐标。
          */
          const pos = instance.posAtCoords({ x: event.clientX, y: event.clientY })
          event.preventDefault()
          runUploadsRef.current(files, pos)
          return true
        },
      }),
    ]

    const instance = new EditorView({
      state: EditorState.create({ doc: props.value, extensions }),
      parent,
    })
    view.current = instance
    // 首次上报：宿主可能在挂载前就渲染了工具条，不报一次会让"有选区/无选区"停在初始态
    reportSelection(instance)
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
    <div className="flex flex-col gap-1.5">
      <div
        ref={host}
        className="overflow-hidden rounded-md"
        style={{ minHeight: props.minHeight ?? '420px' }}
        /*
          这里**刻意不加** `role="group"` / `aria-label`：可访问名称已由上面的
          `contentAttributes` 交给 `.cm-content`（真正的 role="textbox"）。
          若外层再挂一个同名 label，读屏会先念一遍组名、再念一遍文本框名，**重复播报**。
          一个没有语义的纯容器 div 不该带 ARIA——"no ARIA is better than bad ARIA"。
        */
      />
      {/*
        上传状态行：`role="status"`（礼貌播报）而不是 `alert` —— 上传结果不该打断用户
        正在进行的输入；但它**必须**存在，否则键盘/读屏用户粘贴截图后完全不知道发生了什么
        （占位在文档里，可它是"上传中…"这几个字，成功与否只有这条状态说得出）。
        `failures.length > 0` 时给出重试入口：File 还在内存里，重发不需要用户再选一次。
      */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <p role="status" className="m-0">
          {uploading > 0 && slow ? '网络较慢，仍在进行…' : uploadNote}
        </p>
        {failures.length > 0 && (
          <Button size="sm" variant="secondary" onClick={retryUploads}>
            重试上传（{failures.length}）
          </Button>
        )}
      </div>
    </div>
  )
}
