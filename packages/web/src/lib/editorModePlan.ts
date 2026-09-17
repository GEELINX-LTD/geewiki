/**
 * 编辑器的**两种模式**（源码 / 实时渲染）与它们的持久化。
 * ============================================================================
 *
 * ## 为什么默认是「实时渲染」
 *
 * 本项目的编辑页主要给**写文档的人**用，而其中相当一部分不是 Markdown 用户：
 * 让他们面对满屏 `**`、`|---|`、`<!--gated:org-->` 就是"这编辑器太素/不会用"的根源。
 * 实时渲染把标记藏起来、把图片画出来，**默认**落在这一档；需要看/改标记的人切到源码模式，
 * 选择记在 localStorage 里（下次进编辑页还是他习惯的那一档）。
 *
 * ## 为什么是"两个模式"而不是"三个"或"一个开关"
 *
 * - 一个开关（"显示标记"）表达不了"我要用工具栏的权限菜单、但不想看标记"这类组合；
 * - 三个模式会多出"哪个是只读预览"的问题，而**只读预览已经是另一条路径**：
 *   阅读页渲染、以及编辑页的「按访客视角预览」对话框（那是**真的**投影后的 HTML，
 *   与这里的就地渲染不是一回事 —— 后者不会替你算可见性，只是把标记画出来）。
 *
 * 故：模式只影响**编辑区怎么画**，不影响正文内容、不影响保存结果。
 */

/** localStorage 键名（带版本后缀：将来形状变了可直接换 key，不必写迁移） */
export const EDITOR_MODE_KEY = 'gw.editor-mode.v1'

export type EditorMode = 'source' | 'live'

export const EDITOR_MODE_OPTIONS: ReadonlyArray<{ id: EditorMode; label: string; hint: string }> = [
  {
    id: 'live',
    label: '实时渲染',
    hint: '当前段落显示 Markdown 源码，其余段落按渲染后的样子显示（图片直接画出来，标题变大，标记隐藏，表格/代码块/整块 HTML/分隔线画成成品；点这些块即可改源码）。适合日常撰写。',
  },
  {
    id: 'source',
    label: '源码',
    hint: '全文显示 Markdown 源码，含 <!--gated:org--> 这类权限标记。适合精确控制排版与权限区段。',
  },
]

export function isEditorMode(value: unknown): value is EditorMode {
  return value === 'source' || value === 'live'
}

/** localStorage 的最小形状（便于测试注入 stub；浏览器 `Storage` 天然满足） */
interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 取本地存储。**访问 `window.localStorage` 这个属性本身就可能抛**
 * （Safari 隐私模式），故连取值都在 try 里 —— 与 `lib/myAccessRequests.ts` 同款。
 */
function storage(): MinimalStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return (window as unknown as { localStorage?: MinimalStorage }).localStorage ?? null
  } catch {
    return null
  }
}

/** 读出用户选择；读不到/脏数据/隐私模式 ⇒ 默认「实时渲染」 */
export function readStoredMode(): EditorMode {
  const s = storage()
  if (s === null) return 'live'
  try {
    const raw = s.getItem(EDITOR_MODE_KEY)
    return isEditorMode(raw) ? raw : 'live'
  } catch {
    return 'live'
  }
}

/** 记住用户选择。存不下不影响本次会话（只是刷新后回到默认） */
export function storeMode(mode: EditorMode): void {
  const s = storage()
  if (s === null) return
  try {
    s.setItem(EDITOR_MODE_KEY, mode)
  } catch {
    /* 存不下就算了 */
  }
}

/** 模式的短名（界面上要显示"现在在哪一档"） */
export function editorModeLabel(mode: EditorMode): string {
  return EDITOR_MODE_OPTIONS.find((o) => o.id === mode)?.label ?? mode
}
