/**
 * 正文渲染的**后处理**：给标题注入锚点 id、加锚点链接、给代码块加复制按钮。
 *
 * ## 为什么是"消毒之后再注入"（本批最关键的顺序决策）
 *
 * 消毒链路是 `mdToHtml`（`marked` → `DOMPurify.sanitize`），它是**唯一出口**，本批一行未改。
 * 那 id 能不能在消毒时保留？分两种情况（都在 DOMPurify 3.4.15 源码里核实过）：
 *
 * 1. `id` **在**默认属性白名单里（`html` allowlist 含 `'id'`），所以一般情况下能保留；
 * 2. **但** `SANITIZE_DOM`（默认 `true`）会剥掉"值与 `document` 属性同名"的 id/name：
 *    ```js
 *    if (SANITIZE_DOM && (lcName === 'id' || lcName === 'name') &&
 *        (value in document || value in formElement)) return false;
 *    ```
 *    于是 `## Title` 生成的 `id="title"`、`## Body` 生成的 `id="body"` 会被**静默删除**
 *    —— 中文文档不易踩到，英文文档里 `title` / `body` / `location` / `forms` / `images`
 *    都是很常见的标题。锚点会莫名其妙地点不动，而且**没有任何报错**。
 *
 * 结论：**在消毒之后、注入之前做后处理**，而不是去放宽 allowlist：
 * - 不必改消毒链路（本批硬约束），也就不用担心"为了加 id 而削弱消毒"；
 * - 绕开上面那条 DOM clobbering 规则，标题 id 100% 可用；
 * - 安全性不降级：后处理只**新增** id 与我们自己构造的 `<a>`/`<button>`，
 *   从不解析、也不重新解释正文里的任何标记（所有内容都已过 DOMPurify）。
 *
 * ## 为什么可以对这个字符串用 innerHTML
 *
 * `renderMarkdownBody()` 的输入是**已经消毒过**的 HTML（`mdToHtml` 的返回值），
 * 随后只是把它放进一个游离的 `<div>` 里遍历。这**不是**注入点：
 * 浏览器解析它时，里面所有危险构造都已被 DOMPurify 摘掉。真正的注入点仍然只有
 * `dangerouslySetInnerHTML` 一处，而喂给它的是本函数产出的、只多不少地"更安全"的字符串。
 * 序列化用 `innerHTML`，同理不引入新内容。
 */
import { mdToHtml } from './sanitize'
import { buildHash } from './hashAnchor'
import { anchorLabel, assignHeadingIds, tocEntries, type HeadingEntry } from './headingPlan'

/** 复制按钮的标记（事件委托靠它定位；见 `MarkdownBody`） */
export const COPY_BUTTON_ATTR = 'data-gw-copy'

/** 代码块外层容器（按钮的定位上下文） */
export const CODE_WRAP_CLASS = 'gw-code'

export interface RenderedMarkdown {
  /** 可直接交给 `dangerouslySetInnerHTML` 的 HTML */
  html: string
  /** 页内目录（仅 h2–h3） */
  toc: HeadingEntry[]
}

/** 收集标题时需要跳过的容器：历史版本预览与 TOC 自身不该被当成正文标题 */
const SKIP_SELECTOR = '[data-gw-no-toc]'

/**
 * Markdown → 已消毒 HTML + 注入锚点与复制按钮 + 目录。
 *
 * @param markdown 原始 Markdown
 * @param opts.route     当前页面路由（形如 `wiki/<slug>`），用于拼锚点 href。
 *                       锚点不能写成 `#<id>`——本应用是 hash 路由，那会被当成新路由
 *                       （详见 `lib/hashAnchor.ts` 的说明）。
 * @param opts.withCopyButtons 是否为代码块加复制按钮（历史预览等只读小窗可以关掉）
 */
export function renderMarkdownBody(
  markdown: string,
  opts: { withCopyButtons?: boolean; route?: string } = {},
): RenderedMarkdown {
  const withCopyButtons = opts.withCopyButtons ?? true
  const route = opts.route ?? ''
  const holder = document.createElement('div')
  holder.innerHTML = mdToHtml(markdown)

  const headingEls = [...holder.querySelectorAll('h2, h3')].filter(
    (el) => el.closest(SKIP_SELECTOR) === null,
  )
  const entries = assignHeadingIds(
    headingEls.map((el) => ({ level: Number(el.tagName.slice(1)), text: el.textContent ?? '' })),
  )
  entries.forEach((entry, i) => {
    const el = headingEls[i]
    if (el === undefined) return
    el.id = entry.id
    // H1 不加锚点（Docusaurus 同款决策：H1 是页面标题，不属于可分享的小节）
    const a = document.createElement('a')
    a.className = 'gw-heading-anchor'
    // 真链接 + 路由化锚点：可中键新开、可右键复制链接，且刷新后仍能回到同一小节
    a.href = route === '' ? `#${entry.id}` : buildHash(route, entry.id)
    a.setAttribute('aria-label', anchorLabel(entry.text))
    // 零宽字符提供"可点区域"而不污染标题排版（Docusaurus 的 hash-link 同做法）
    a.textContent = '\u200B'
    el.appendChild(a)
  })

  if (withCopyButtons) {
    for (const pre of [...holder.querySelectorAll('pre')]) {
      const code = pre.querySelector('code')
      if (code === null) continue
      const wrap = document.createElement('div')
      wrap.className = CODE_WRAP_CLASS
      pre.replaceWith(wrap)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'gw-copy-btn'
      btn.setAttribute(COPY_BUTTON_ATTR, '')
      btn.setAttribute('aria-label', '复制代码')
      btn.textContent = '复制'
      wrap.append(btn, pre)
    }
  }

  return { html: holder.innerHTML, toc: tocEntries(entries) }
}

/**
 * 从代码块容器里取出待复制的文本。
 *
 * 单独成函数是为了让事件委托的处理逻辑保持一行：按钮 → 最近的 `.gw-code` → 其中的 `code`。
 * 返回 null 表示结构不符（理论上不会发生，但事件委托收到的是"当时的 DOM"，
 * 用户脚本/插件可能已经改动过它，故按"取不到就不复制"处理，而不是抛错）。
 */
export function codeTextFromButton(btn: Element): string | null {
  const wrap = btn.closest(`.${CODE_WRAP_CLASS}`)
  const code = wrap?.querySelector('code')
  return code === null || code === undefined ? null : (code.textContent ?? '')
}
