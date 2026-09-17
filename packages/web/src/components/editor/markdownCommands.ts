/**
 * 工具栏动作的 **CodeMirror 落地层**：把 `lib/markdownActions.ts` 的纯变换包成事务。
 * ============================================================================
 *
 * 这一层刻意**薄**：所有"改什么"的判断都在纯函数里（那里有单测、也被降级 textarea 复用），
 * 这里只做三件事：
 * 1. 把当前 `EditorState` 的主选区与正文交给纯函数；
 * 2. 用 `minimalEdit` 把结果收缩成**一处**改动（而不是整篇替换）——
 *    否则每次加粗都会让 CodeMirror 重解析整篇文档、撤销栈里也是一大块；
 * 3. 派发事务，`userEvent: 'input'` ⇒ **⌘Z 一次撤销**（与附件上传、AI 采纳同一约定）。
 *
 * 只作用于**主选区**：多光标下工具栏按钮是"鼠标明确指向一处"的交互，把其余光标合并掉
 * 比给每个光标各算一次更符合预期（该限制写在 `markdownActions.ts` 的文件头）。
 */
import { redo, undo, redoDepth, undoDepth } from '@codemirror/commands'
import { EditorSelection, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { applyFormatAction, detectActiveFormats, minimalEdit, type FormatAction } from '../../lib/markdownActions'

/**
 * 执行一个格式化动作。文本没变时返回 `false`（调用方据此不发空事务、也不谎报成功）。
 *
 * 用 `changeByRange` 而不是"只处理主选区"：**多光标**下每个选区各自包一次标记，
 * 这是 CodeMirror 的既有约定（原 `toggleBold` 就是 `changeByRange` 实现，行为不能回退）。
 * 每个选区把纯函数算出的整篇结果用 `minimalEdit` 收缩成一处改动 —— 仍然是**文档坐标**，
 * 正好是 `changeByRange` 要求的形状。
 */
export function runFormatAction(view: EditorView, action: FormatAction): boolean {
  const { state } = view
  const before = state.doc.toString()
  let touched = false
  const spec = state.changeByRange((range) => {
    const result = applyFormatAction({ text: before, from: range.from, to: range.to }, action)
    const diff = minimalEdit(before, result.text)
    if (diff === null) return { range }
    touched = true
    return { changes: diff, range: EditorSelection.range(result.from, result.to) }
  })
  if (!touched) return false
  view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' })
  return true
}

/** 当前选区已经处于哪些结构（工具栏 `aria-pressed` 用） */
export function activeFormats(view: EditorView): Set<FormatAction> {
  const sel = view.state.selection.main
  return detectActiveFormats({ text: view.state.doc.toString(), from: sel.from, to: sel.to })
}

/** 撤销/重做：直接复用 `@codemirror/commands`，不自己实现历史 */
export function runUndo(view: EditorView): boolean {
  return undo(view)
}

export function runRedo(view: EditorView): boolean {
  return redo(view)
}

/** 历史深度（工具栏据此如实呈现"能不能撤销"，而不是给一个点了没反应的按钮） */
export function historyDepth(state: EditorState): { undo: number; redo: number } {
  return { undo: undoDepth(state), redo: redoDepth(state) }
}
