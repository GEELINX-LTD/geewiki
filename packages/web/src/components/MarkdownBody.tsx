/**
 * Markdown 正文渲染器：消毒后的 HTML + 锚点 + 代码块复制按钮。
 *
 * 本文件分成两半，职责边界很清楚：
 * - `useRenderedMarkdown()` —— **计算**：Markdown → { html, toc }（含消毒与后处理）；
 * - `MarkdownBody`         —— **呈现**：把已算好的 html 注入，并处理复制按钮的点击。
 *
 * 为什么必须分开：详情页同时需要目录（`toc`）与正文（`html`）。若让"呈现组件"自己再算一遍，
 * 同一份文档就要跑两次 `marked` + `DOMPurify` + DOM 遍历（长文档上是可观的浪费），
 * 而且两次渲染出的 id 也是各自独立算的——虽然纯函数保证结果一致，但没必要冒这个险。
 * 现在由父组件调一次 hook，把同一份产物分别给目录和正文。
 *
 * ## 为什么复制按钮走**事件委托**而不是 React 组件
 * 按钮是 `renderMarkdownBody()` 在**已消毒的 HTML 字符串**里注入的，随后整体交给
 * `dangerouslySetInnerHTML`。React 不管理这棵子树——若为按钮另建 React 组件，
 * 就得把 HTML 拆成片段再逐段 render，等于把"单一消毒出口"拆散（本批明确禁止）。
 * 因此：**一个容器上的 onClick 委托**处理全部按钮，用 `data-gw-copy` 定位。
 *
 * ## 按钮的反馈是**命令式**的，这是有意的
 * 复制成功与否是瞬时的、纯视觉的（1 秒后自动还原）。若放进 React state，每次点击都要
 * 重渲染整个正文容器；而重渲染 `dangerouslySetInnerHTML` 会**重建整棵子树**，
 * 把用户刚建立的选区与滚动锚点弄丢。故直接改按钮自身的文本与类名。
 *
 * ## 复制失败不留假象
 * `copyText()` 返回 `'manual'` 时（非安全上下文且 `execCommand` 也失败），按钮显示
 * "请按 ⌘C"并**保持 3 秒**，同时把代码块文本选中，让用户直接按键即可——而不是假装成功。
 * （`http://127.0.0.1` 属 "potentially trustworthy origin"，`navigator.clipboard` 可用；
 * 真正会走到 manual 的是 `http://<局域网 IP>` 这类场景。）
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { copyText } from '../lib/clipboard'
import { COPY_BUTTON_ATTR, codeTextFromButton, renderMarkdownBody } from '../lib/markdownRender'

/** 反馈停留时长：成功 1s（与 Docusaurus 的 1000ms 一致），失败 3s（够用户读完并按键） */
const OK_MS = 1000
const MANUAL_MS = 3000

/** 计算 Markdown 的渲染产物（消毒 + 锚点 + 复制按钮 + 目录 + 链接改写） */
export function useRenderedMarkdown(
  markdown: string,
  opts: {
    withCopyButtons?: boolean
    route?: string
    /** 已知页面（slug → 标题）：判定站内链接是否存在、并给 `[[wikilink]]` 回填标题 */
    pages?: ReadonlyMap<string, string> | null
  } = {},
): ReturnType<typeof renderMarkdownBody> {
  const withCopyButtons = opts.withCopyButtons ?? true
  const route = opts.route ?? ''
  /*
   * `pages` 必须进依赖数组：它是惰性取的（页面列表可能晚于正文到达），
   * 到货后需要重算一次，否则链接会一直停在"未判定"的形态（不显示页面标题、
   * 也不标"不存在"）。
   */
  const pages = opts.pages ?? null
  return useMemo(
    () => renderMarkdownBody(markdown, { withCopyButtons, route, pages }),
    [markdown, withCopyButtons, route, pages],
  )
}

/** 选中代码块文本（manual 分支用；让用户直接按 ⌘/Ctrl+C） */
function selectCodeText(btn: Element): void {
  const wrap = btn.closest('.gw-code')
  const code = wrap?.querySelector('code')
  if (code === null || code === undefined) return
  const range = document.createRange()
  range.selectNodeContents(code)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export function MarkdownBody({
  html,
  className,
}: {
  /** 来自 `useRenderedMarkdown()` 的已消毒 HTML */
  html: string
  className?: string
}): ReactNode {
  const timers = useRef(new Map<HTMLElement, number>())
  const hostRef = useRef<HTMLDivElement | null>(null)
  const injected = useRef<string | null>(null)

  /*
   * **命令式注入，而不是 `dangerouslySetInnerHTML`**（这是本批踩到的一个真坑）。
   *
   * 原因：`dangerouslySetInnerHTML` 在 React 的更新路径里**不比较 `__html`**（实测在
   * react-dom 19 的生产包里，只有初次挂载会按 `__html` 赋值；更新路径没有对应的 diff）。
   * 结果是重新渲染时整棵子树可能被**重新解析**——而 `innerHTML = ...` 无论内容是否相同，
   * 都会销毁旧节点、创建新节点。两个可见后果：
   * 1. `IntersectionObserver` 观察的标题节点变成**脱离文档**的孤儿（`isConnected === false`），
   *    其 `getBoundingClientRect()` 恒为 0 ⇒ 目录高亮错乱（详见 `useActiveHeading` 的说明）；
   * 2. 代码块复制按钮在点击后立刻被换成新节点 ⇒ "已复制"的反馈一闪即逝（甚至看不到）。
   *
   * 因此这里只在 **HTML 真的变化时**才写 `innerHTML`（按字符串比较），并保留节点身份。
   * 安全性不变：写入的字符串仍然只来自 `mdToHtml()` 这一个消毒出口。
   */
  useEffect(() => {
    const el = hostRef.current
    if (el === null) return
    if (injected.current === html) return // 同一份 HTML：不碰 DOM（节点身份、选区、滚动锚点全部保住）
    el.innerHTML = html
    injected.current = html
  }, [html])

  // 卸载时清掉待还原的定时器，避免对已移除的节点写文本
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) window.clearTimeout(t)
      map.clear()
    }
  }, [])

  const onCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target
    if (!(target instanceof Element)) return
    const btn = target.closest(`[${COPY_BUTTON_ATTR}]`)
    if (!(btn instanceof HTMLElement)) return
    const text = codeTextFromButton(btn)
    if (text === null) return

    void copyText(text).then((outcome) => {
      const prev = timers.current.get(btn)
      if (prev !== undefined) window.clearTimeout(prev)
      const revert = (delay: number, cls: string): void => {
        timers.current.set(
          btn,
          window.setTimeout(() => {
            btn.textContent = '复制'
            btn.classList.remove(cls)
            timers.current.delete(btn)
          }, delay),
        )
      }
      if (outcome === 'ok') {
        btn.textContent = '已复制'
        btn.classList.add('is-copied')
        revert(OK_MS, 'is-copied')
      } else {
        selectCodeText(btn)
        btn.textContent = '请按 ⌘C'
        btn.classList.add('is-manual')
        revert(MANUAL_MS, 'is-manual')
      }
    })
  }, [])

  return <div ref={hostRef} className={className} onClick={onCopyClick} />
}
