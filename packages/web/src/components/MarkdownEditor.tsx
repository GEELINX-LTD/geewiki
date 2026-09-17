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
import { EditorState, Compartment, type Extension } from '@codemirror/state'
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
import { cn } from '../ui/cn'
import { errorLine } from '../lib/errorText'
import { useSlowHint } from '../lib/useSlowHint'
import {
  findUploadPlaceholder,
  uploadFailureMarkdown,
  uploadPlaceholder,
  uploadSummaryText,
} from '../lib/attachmentPlan'
import { EditorToolbar, type BlockTierControl } from './editor/EditorToolbar'
import { activeFormats, historyDepth, runFormatAction, runRedo, runUndo } from './editor/markdownCommands'
import { liveRender } from './editor/liveRender'
import {
  BLOCK_TIER_OPTIONS,
  parseSourceDoc,
  blockAtOffset,
  regionOfBlock,
  setBlockTier,
  setRegionTier,
} from '../lib/editorBlocks'
import { readStoredMode, storeMode, type EditorMode } from '../lib/editorModePlan'
import { minimalEdit, type FormatAction } from '../lib/markdownActions'
import type { BlockVisibility, PageVisibility } from '../api'

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
    /*
     * ★ 水平内边距**不能是 0**。
     *
     * 这里曾是 `padding: '10px 0'`，看着没事是因为**源码模式有行号栏**
     * （`lineNumbers()` 只在 source 模式加载，见下方 modeExtensions）—— 行号栏
     * 顺带充当了左边距。而**实时渲染模式没有行号栏**，于是正文直接贴住编辑器边框，
     * 且从源码切过去时整块向左跳了整整一个行号栏的宽度。用户报的"缩进很奇怪"就是它。
     *
     * 给一个**两种模式都有**的基础内缩，右边距同时解决"正文贴住右边框"。
     */
    padding: '10px 16px',
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
  /*
   * ★ 选区用**中间调**的 `--gw-accent-soft-line`，不是 `--gw-accent-soft`。
   *
   * 后者是给"淡色底"（chip / 提示块）设计的 token：浅色模式 `#eff6ff`、深色模式 `#10203a`，
   * 与编辑区表面的**亮度几乎一致** ⇒ 选中一片文字在屏幕上**看不出来**（用户报的
   * 「选中文本不会表现出来」）。选区要的是"与底色明确可分辨"，而不是"含蓄的强调底"。
   *
   * `--gw-accent-soft-line` 在两种模式下都是中间调（浅色 `--gw-blue-200` /
   * 深色 `--gw-dk-blue-line`），故不需要为深色模式再写一份。
   */
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--gw-accent-soft-line)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--gw-accent-soft-line)' },
  // 高亮"与选区相同的其它匹配"（`highlightSelectionMatches`）——比选区更轻一档，故意不同
  '.cm-selectionMatch': { backgroundColor: 'var(--gw-accent-soft)' },
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
 * 加粗（⌘/Ctrl+B）走**工具栏同一份实现**（`components/editor/markdownCommands.ts`）。
 *
 * 这里刻意不留第二份"加粗"代码：原先它自成一个 `toggleBold`（当时只有快捷键一条路径），
 * 现在工具栏按钮也要加粗 —— 两份实现必然漂移，而"按钮和快捷键做出来的东西不一样"
 * 是最难被发现的一类 bug。共用后多光标行为也保持不变（`runFormatAction` 内部是
 * `changeByRange`），且新增能力（斜体/链接/表格/权限菜单）与降级 textarea 一并共享。
 */

export interface MarkdownEditorHandle {
  /** 在光标处插入（有选区时**替换**选区 —— 与 CodeMirror 的 `replaceSelection` 同语义） */
  insertAtCursor(text: string): void
  /** 只替换当前选区；无选区时不动作并返回 `false`（调用方据此提示而不是静默） */
  replaceSelection(text: string): boolean
  /**
   * **整篇替换**文档内容（AI 回退用：把草稿还原到某一轮之前）。
   *
   * 为什么必须是"整篇"而不是"再插一段"：回退的语义是**回到那个状态**，而两次 AI 写入
   * 之间的草稿差异不是一段可插入的文本（模型可能删、可能改、可能重排）。用插入去模拟回退
   * 只会让草稿越来越长、且永远回不到原样。
   *
   * 与 `insertAtCursor` 一样走 `userEvent: 'input'` 事务 ⇒ **⌘Z 一次即可撤销**，
   * 即"回退"本身也是可撤销的（否则用户点错一次「回退」就再也回不来了）。
   */
  setDoc(text: string): void
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
  /**
   * **块级阅读权限**的编辑能力（工具栏最右那个锁按钮）。
   *
   * `null`/不传 = 本场景不提供：第三方编辑器插件占用 `editor` 插槽时它拿不到正文模型，
   * 没有 `manageVisibility` 权限的用户也不该看到这个入口（**不渲染**而不是渲染成灰按钮，
   * 见仓库的"能力不存在就不要给一个点不动的按钮"约定）。
   *
   * 这里改的是**正文里的 gated 标记**（`<!--gated:org-->` 这类），不是新的后端端点：
   * 服务端在保存时重新解析，故"改档位"与"改正文"是同一条保存路径、同一个版本历史。
   * `pageVisibility` 只用于提示"块档位不能宽过页面档位"。
   */
  blockTiers?: { pageVisibility: PageVisibility | null } | null
  /**
   * 「授权给谁…」：把**光标所在的那一段**交给宿主去管理例外授予。
   *
   * 为什么由宿主执行而不是编辑器自己发请求：编辑器有"绝不发网络请求"的既有约定
   * （它只负责编辑区，鉴权/缓存/错误文案都在宿主）。编辑器交出去的是
   * `{ ordinal, excerpt }` —— `ordinal` 与服务端 `parseBlocks` 同序（有镜像守卫），
   * 宿主据此换到服务端的块 id（见 `components/access/BlockGrantsDialog.tsx`）。
   */
  onManageBlockGrants?: (block: { ordinal: number; excerpt: string }) => void
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
  /** 工具栏"上传附件"按钮触发的隐藏文件选择器 */
  const fileInputRef = useRef<HTMLInputElement | null>(null)
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
  /*
   * Compartment 必须放在 **ref** 里，不能在组件体里 `new Compartment()`：
   * 后者每次渲染都造一个新实例，而"重建配置"要用**同一个**实例才生效
   * （`Compartment.reconfigure` 是按实例查表的）。放 body 里会让重配置静默失效 ——
   * 这正是本文件此前 `editable` 的隐患（`disabled` 变化后编辑器仍可输入），一并修掉。
   */
  const editable = useRef(new Compartment())
  /** 模式相关扩展（实时渲染 / 行号）在它里面，切模式=重配置，不重建编辑器 */
  const modeSlot = useRef(new Compartment())
  /** 占位序号：同一次会话内单调递增，保证多文件同时上传时占位互不冲突 */
  const seqRef = useRef(0)
  /** 在飞的上传数量（驱动"仍在上传…"的慢提示） */
  const [uploading, setUploading] = useState(0)
  /** 状态行文案（成功/失败各一条，用 `role="status"` 礼貌播报） */
  const [uploadNote, setUploadNote] = useState('')
  /** 失败待重试的文件（连同它们在正文里的失败说明，重试成功后按文本替换掉） */
  const [failures, setFailures] = useState<UploadSlot[]>([])
  const slow = useSlowHint(uploading > 0)

  /* ------------------------- 工具栏：模式 / 状态 / 块权限 ------------------------- */

  /**
   * 编辑模式。**由编辑器自己持有**：它纯粹是"编辑区怎么画"，宿主的保存路径、
   * 草稿、冲突检测完全不受影响；持久化在 localStorage（见 `lib/editorModePlan.ts`）。
   */
  const [mode, setMode] = useState<EditorMode>(() => readStoredMode())
  /** 当前选区已处于哪些结构（工具栏 aria-pressed）。用 key 去重，避免每次按键都重渲染工具栏 */
  const [active, setActive] = useState<ReadonlySet<FormatAction>>(() => new Set<FormatAction>())
  const activeKeyRef = useRef('')
  /**
   * 撤销/重做深度（如实呈现"能不能撤销"）。
   * 变量名**不能**叫 `history`：那会遮蔽 `@codemirror/commands` 的 `history()` 扩展
   * （TypeScript 会报"这个表达式不可调用"，而真正的原因在几十行之外的扩展列表里）。
   */
  const [hist, setHist] = useState({ undo: 0, redo: 0 })
  const historyKeyRef = useRef('0:0')
  /** 光标所在块的权限状态（工具栏的锁按钮） */
  const [tier, setTier] = useState<BlockTierControl | null>(null)
  const tierKeyRef = useRef('')
  /** 块权限改动的结果说明（成功/被拒绝的原因都走这里，绝不静默） */
  const [tierNote, setTierNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  /**
   * `blockTiers` 的 ref：`syncToolbar` 与 DOM handler 都建在空依赖的闭包里，
   * 直接捕获 props 会永远读到第一版（"新页面保存后仍然没有权限入口"这类 bug 的来源）。
   */
  const tiersRef = useRef(props.blockTiers ?? null)
  tiersRef.current = props.blockTiers ?? null

  /**
   * 把编辑器的实时状态同步给工具栏（选区结构 / 历史深度 / 当前块档位）。
   *
   * 每次 update 都算一遍，但**只在真的变化时** setState：否则每敲一个字都会重渲染
   * 整个工具栏（十几个按钮 + Radix 菜单），输入法组合期间还会被打断。
   */
  const syncToolbar = useCallback((instance: EditorView): void => {
    const act = activeFormats(instance)
    const actKey = [...act].sort().join(',')
    if (actKey !== activeKeyRef.current) {
      activeKeyRef.current = actKey
      setActive(act)
    }
    const depth = historyDepth(instance.state)
    const depthKey = `${depth.undo}:${depth.redo}`
    if (depthKey !== historyKeyRef.current) {
      historyKeyRef.current = depthKey
      setHist(depth)
    }
    // 没有权限编辑能力时不必解析正文（这一步是 O(文档长度)）
    if (tiersRef.current === null) {
      if (tierKeyRef.current !== '') {
        tierKeyRef.current = ''
        setTier(null)
      }
      return
    }
    const doc = parseSourceDoc(instance.state.doc.toString())
    const block = blockAtOffset(doc, instance.state.selection.main.head)
    const region = block === null ? null : regionOfBlock(doc, block.ordinal)
    const next: BlockTierControl | null =
      block === null
        ? null
        : {
            current: block.marker ?? 'public',
            regionBlocks: region?.blocks.length ?? 1,
            pageVisibility: tiersRef.current.pageVisibility,
          }
    const nextKey =
      next === null ? 'none' : `${next.current}:${next.regionBlocks}:${next.pageVisibility ?? ''}`
    if (nextKey !== tierKeyRef.current) {
      tierKeyRef.current = nextKey
      setTier(next)
    }
  }, [])
  const syncRef = useRef(syncToolbar)
  syncRef.current = syncToolbar

  /**
   * 打开「授权给谁…」（交给宿主）。段落档位设成「需单独授权」之后，**只有这里**能指定
   * 谁被允许读这一段 —— 缺了它那一档就是"设得出来、没人能看"的死档。
   */
  const manageGrants = useCallback((): void => {
    const instance = view.current
    if (instance === null) return
    const doc = parseSourceDoc(instance.state.doc.toString())
    const block = blockAtOffset(doc, instance.state.selection.main.head)
    if (block === null) {
      setTierNote({ tone: 'err', text: '把光标放到要授权的那一段里，再打开「授权给谁…」' })
      return
    }
    // 摘要取首行并截断：对话框里用它让作者确认"要授权的就是这一段"
    const firstLine = block.text.split('\n')[0] ?? ''
    onManageGrantsRef.current?.({ ordinal: block.ordinal, excerpt: firstLine.slice(0, 160) })
  }, [])
  /** `onManageBlockGrants` 的 ref（空依赖的 DOM handler / 工具栏回调里读最新实现） */
  const onManageGrantsRef = useRef(props.onManageBlockGrants)
  onManageGrantsRef.current = props.onManageBlockGrants

  /**
   * 改当前块的档位。**改的是正文里的 gated 标记**：
   * `lib/editorBlocks.ts` 负责重写并自检（块数/正文/档位三项对不上就放弃改动），
   * 这里只把结果派发成一处最小改动 —— 于是它与手打标记走**完全同一条**保存路径。
   */
  const applyTier = useCallback((target: BlockVisibility, whole: boolean): void => {
    const instance = view.current
    if (instance === null) return
    const text = instance.state.doc.toString()
    const doc = parseSourceDoc(text)
    const block = blockAtOffset(doc, instance.state.selection.main.head)
    if (block === null) {
      setTierNote({ tone: 'err', text: '把光标放到要改的那一段里，才能改它的阅读权限' })
      return
    }
    const res = whole ? setRegionTier(text, block.ordinal, target) : setBlockTier(text, block.ordinal, target)
    if (!res.ok) {
      setTierNote({ tone: 'err', text: res.error })
      return
    }
    const label = BLOCK_TIER_OPTIONS.find((o) => o.id === target)?.label ?? target
    if (!res.changed) {
      setTierNote({ tone: 'ok', text: `这一段已经是「${label}」，正文没有改动` })
      return
    }
    const diff = minimalEdit(text, res.text)
    if (diff !== null) {
      // userEvent: 'input' ⇒ ⌘Z 一次撤销（与附件上传、AI 采纳同一约定）
      instance.dispatch({ changes: diff, userEvent: 'input' })
    }
    setTierNote({
      tone: 'ok',
      text: `已把${whole ? '整个受限区段' : '这一段'}改为「${label}」——标记写进了正文，保存后对访客生效`,
    })
  }, [])

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
      setDoc: (text: string) => {
        const instance = view.current
        if (instance === null) return
        const doc = instance.state.doc
        /* 内容已经相同就不派发事务：派发一次"没有变化"的替换会把光标弹到文首，
           而用户看到的是一次莫名其妙的跳转。 */
        if (doc.toString() === text) return
        instance.dispatch({
          changes: { from: 0, to: doc.length, insert: text },
          selection: { anchor: Math.min(instance.state.selection.main.anchor, text.length) },
          userEvent: 'input',
          scrollIntoView: true,
        })
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

  /**
   * 模式相关的扩展集合。**切模式 = 重配置这一个 compartment**，
   * 编辑器实例、撤销栈、滚动位置、附件上传的占位都原样保留
   * （重建编辑器会把这些全丢掉，而这正是"切个模式内容没了"的事故形态）。
   */
  const modeExtensions = useCallback((m: EditorMode): Extension => {
    return [
      // 行号只在源码模式显示（理由见创建 effect 里的注释）
      ...(m === 'source' ? [lineNumbers(), highlightActiveLineGutter()] : []),
      highlightActiveLine(),
      // 实时渲染：只对"非活动块"做装饰，且都是 Decoration（不改文档）
      ...(m === 'live' ? [liveRender({ hideMarks: true, renderImages: true, renderBlocks: true })] : []),
    ]
  }, [])

  useEffect(() => {
    const parent = host.current
    if (parent === null) return

    const extensions: Extension[] = [
      /*
        行号与"当前行高亮"放进 `modeSlot`：**实时渲染模式下不显示行号**。
        理由是它们会撒谎：排版后的段落是一"行"，但软换行让它占了好几屏，
        行号却只递增一次；作者会据此判断"文档有多长/我在第几行"，而那是错的。
        源码模式下两者都保留（那才是行号真正有用的场景：定位、报错行）。
      */
      modeSlot.current.of(modeExtensions(mode)),
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
      editable.current.of(EditorView.editable.of(!props.disabled)),
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
        // 格式快捷键与工具栏走**同一份实现**（`runFormatAction`），不存在"按钮和快捷键不一样"
        { key: 'Mod-b', preventDefault: true, run: (v) => runFormatAction(v, 'bold') },
        { key: 'Mod-i', preventDefault: true, run: (v) => runFormatAction(v, 'italic') },
        { key: 'Mod-k', preventDefault: true, run: (v) => runFormatAction(v, 'link') },
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
        // 工具栏状态（结构高亮 / 撤销深度 / 当前块档位）随文档与选区变化重算
        if (u.selectionSet || u.docChanged) syncRef.current(u.view)
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
    // 工具栏的初始状态也要报一次（否则第一次点按钮前它显示的是"未处于任何结构"）
    syncRef.current(instance)
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
    // 宿主改了正文（草稿恢复、"权限"卡片改了块档位）⇒ 工具栏的当前块档位也可能变了
    syncRef.current(instance)
  }, [props.value])

  useEffect(() => {
    const instance = view.current
    if (instance === null) return
    instance.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!props.disabled)) })
  }, [props.disabled])

  /*
   * 切模式：重配置 `modeSlot`。**不重建编辑器**（撤销栈、滚动位置、未保存内容全保留），
   * 也不碰正文 —— 模式只影响"怎么画"。
   */
  useEffect(() => {
    const instance = view.current
    if (instance === null) return
    instance.dispatch({ effects: modeSlot.current.reconfigure(modeExtensions(mode)) })
  }, [mode, modeExtensions])

  return (
    <div className="flex flex-col gap-1.5">
      {/*
        工具栏在编辑区**上方**（不是在底部）：它对应的动作发生在光标处，
        而光标通常在视线上方；放底部会让"点按钮 → 找光标"变成一次来回。
      */}
      <EditorToolbar
        mode={mode}
        onModeChange={(next) => {
          setMode(next)
          // 记住选择：只影响"编辑区怎么画"，不影响正文/保存（见 editorModePlan.ts）
          storeMode(next)
        }}
        active={active}
        onAction={(action) => {
          const instance = view.current
          if (instance === null) return
          runFormatAction(instance, action)
          syncToolbar(instance)
        }}
        canUndo={hist.undo > 0}
        canRedo={hist.redo > 0}
        onUndo={() => {
          const instance = view.current
          if (instance === null) return
          runUndo(instance)
          syncToolbar(instance)
        }}
        onRedo={() => {
          const instance = view.current
          if (instance === null) return
          runRedo(instance)
          syncToolbar(instance)
        }}
        /*
          块权限入口：只有宿主明确给了 `blockTiers` 才渲染（没有 manageVisibility 权限、
          或编辑器插槽被第三方占用时不渲染 —— 能力不存在就不给一个点不动的按钮）。
        */
        tier={props.blockTiers == null ? null : tier}
        onTierChange={applyTier}
        onManageBlockGrants={props.onManageBlockGrants === undefined ? null : manageGrants}
        onPickFiles={props.onUploadFiles === undefined ? null : () => fileInputRef.current?.click()}
        disabled={props.disabled === true}
      />
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
        附件选择器：工具栏的"上传附件"按钮点它。
        为什么工具栏也要有一个入口：粘贴/拖入是**知道这个功能的人**才会做的动作，
        而"点回形针"是所有人都会试的第一件事（隐藏的原生 input + 按钮触发，是无障碍的
        标准做法：input 有可访问名称、按钮是真的按钮）。
      */}
      {props.onUploadFiles !== undefined && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="选择要上传的附件"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            // 清空 value：同一个文件连选两次也要能触发 change（否则第二次什么都不发生）
            e.target.value = ''
            if (files.length > 0) runUploadsRef.current(files, null)
          }}
        />
      )}
      {/*
        状态行：`role="status"`（礼貌播报）而不是 `alert` —— 上传/权限改动的结果不该打断用户
        正在进行的输入；但它**必须**存在，否则键盘/读屏用户粘贴截图后完全不知道发生了什么
        （占位在文档里，可它是"上传中…"这几个字，成功与否只有这条状态说得出）。
        权限改动被拒绝时用 `alert`：那意味着"你以为收紧了，其实没有"，必须打断。
      */}
      <div className="flex flex-col gap-1 text-xs text-muted">
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="m-0">
            {uploading > 0 && slow ? '网络较慢，仍在进行…' : uploadNote}
          </p>
          {failures.length > 0 && (
            <Button size="sm" variant="secondary" onClick={retryUploads}>
              重试上传（{failures.length}）
            </Button>
          )}
        </div>
        {tierNote !== null && (
          <p
            role={tierNote.tone === 'err' ? 'alert' : 'status'}
            className={cn(
              'm-0 rounded-md border px-2 py-1',
              tierNote.tone === 'err'
                ? 'border-danger-line bg-danger-bg text-danger-ink'
                : 'border-line text-ink-soft',
            )}
          >
            {tierNote.text}
          </p>
        )}
      </div>
    </div>
  )
}
