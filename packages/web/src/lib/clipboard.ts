/**
 * 复制到剪贴板 —— **带非安全上下文降级**。
 *
 * ## 为什么要自己写（而不是用 `copy-text-to-clipboard` 之类）
 * 逻辑只有二十行，且降级路径必须自己掌控（见下）；为此多一个依赖不划算。
 *
 * ## 关键事实：`navigator.clipboard` 的可用性取决于**安全上下文**
 * - `https://` 与 `localhost` / `127.0.0.1`（"potentially trustworthy origin"）⇒ 可用；
 * - 局域网 IP（`http://192.168.x.x`）、纯 `http://` 域名 ⇒ **`navigator.clipboard` 为
 *   undefined**。这正是 Docusaurus 会为 `copy-text-to-clipboard` 保留一个
 *   `document.execCommand` 兜底的原因（其注释原文就是 "for non-secure contexts
 *   (e.g. HTTP on a local network)"）。
 *
 * 因此本模块**先探测再兜底**，并把结果如实回传给调用方：
 * - `'ok'`     —— 已写入剪贴板；
 * - `'manual'` —— 两条路都不行，调用方应提示用户手动复制（我们会顺手把文本选中，
 *                 这样用户按 ⌘/Ctrl+C 就能拿到，不必自己拖选）。
 *
 * 不做"假装成功"：复制失败却显示"已复制"是最糟的交互——用户会去粘贴一段旧内容。
 */

export type CopyOutcome = 'ok' | 'manual'

/** 当前是否具备异步剪贴板 API（供 UI 决定要不要说明"按 ⌘C"） */
export function hasAsyncClipboard(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
}

/**
 * 兜底：临时 `<textarea>` + `execCommand('copy')`。
 *
 * 几个必须做对的细节（否则在真实浏览器里会静默失败）：
 * - textarea 必须在**视口内**且可聚焦：`position: fixed; opacity: 0` 且 `top: 0`，
 *   用 `left: -9999px` 移出屏幕在部分浏览器上会导致选区失效；用 `opacity: 0` 兼顾
 *   "不可见"与"可被选中"。
 * - 要 `readOnly`，否则移动端会弹键盘。
 * - 必须**保留并恢复**原有焦点与选区：用户在编辑器里选了一段文字，点复制按钮后
 *   选区不该被毁掉（尤其对 CodeMirror，选区即编辑器状态）。
 */
function execCommandCopy(text: string): boolean {
  const active = document.activeElement
  const selection = document.getSelection()
  const savedRanges: Range[] = []
  if (selection !== null) {
    for (let i = 0; i < selection.rangeCount; i++) {
      const r = selection.getRangeAt(i)
      savedRanges.push(r.cloneRange())
    }
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0'
  document.body.appendChild(ta)

  let ok: boolean
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    ta.remove()
    // 恢复选区与焦点：失败也没关系（`execCommand` 不支持时本来就没得救）
    if (selection !== null) {
      selection.removeAllRanges()
      for (const r of savedRanges) selection.addRange(r)
    }
    if (active instanceof HTMLElement) active.focus()
  }
  return ok
}

/**
 * 复制文本。**绝不抛错**——调用方拿到 `'manual'` 时给用户一个可操作的提示即可。
 */
export async function copyText(text: string): Promise<CopyOutcome> {
  if (hasAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(text)
      return 'ok'
    } catch {
      // 权限被拒 / 文档失焦（例如 DevTools 打开、Promise 未在用户手势内结算）：
      // 继续走兜底，而不是直接报失败
    }
  }
  return execCommandCopy(text) ? 'ok' : 'manual'
}
