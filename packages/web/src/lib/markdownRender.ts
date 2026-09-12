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
import {
  MISSING_LINK_ATTR,
  MISSING_LINK_CLASS,
  normalizeSlugTarget,
  resolveBodyLink,
} from './linkPlan'
import { WIKILINK_ATTR, WIKILINK_AUTO_ATTR } from './wikilink'
import {
  ATTACHMENT_APPLY_ATTR,
  ATTACHMENT_APPLY_PENDING_TEXT,
  ATTACHMENT_APPLY_TEXT,
  ATTACHMENT_BLOCKED_ATTR,
  ATTACHMENT_BLOCKED_CLASS,
  ATTACHMENT_BLOCKED_REASON,
  ATTACHMENT_BLOCKED_TEXT,
  ATTACHMENT_MEDIA_ATTR,
  ATTACHMENT_SLUG_ATTR,
  isAttachmentUrl,
} from './attachmentPlan'

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
 * 改写正文里的链接，使其在本应用的 hash 路由下真正可用（详见 `lib/linkPlan.ts`）。
 *
 * 四类处置：
 * - **外链**（http/https）→ 原 href 不变，补 `target="_blank"` + `rel="noopener noreferrer"`；
 * - **同页锚点**（`#section`）→ 转成路由内锚点 `#/wiki/<slug>?a=<id>`，否则会把 hash
 *   换成 `#section` 而打乱路由；
 * - **站内页面**（`/architecture`、`/wiki/foo`）→ 转成 `#/wiki/<encoded>`，**不整页跳走**；
 * - **目标不存在** → 仍是站内 hash 链接（点进去是"页面不存在"空态，有返回入口），
 *   但加 `data-gw-missing` + 弱化样式 + `title` 说明。**不做成死链接**：死链接会让用户
 *   以为页面渲染坏了，而"点进去看到明确的空态"既诚实又给了下一步动作。
 *
 * `[[wikilink]]` 额外做一件事：显示文本是自动的（`[[slug]]`）且该页存在时，
 * 用**页面真实标题**替换 slug——这是 wiki 的阅读预期（`[[guides/authoring]]`
 * 不该显示成一串标识符）。
 */
function rewriteBodyLinks(
  holder: HTMLElement,
  route: string,
  pages: ReadonlyMap<string, string> | null,
): void {
  for (const a of [...holder.querySelectorAll('a[href]')]) {
    const res = resolveBodyLink(a.getAttribute('href') ?? '', { route, knownSlugs: pages })
    if (res.kind !== 'keep') {
      a.setAttribute('href', res.href)
      if (res.blank) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
      if (res.kind === 'missing') {
        a.setAttribute(MISSING_LINK_ATTR, '')
        a.classList.add(MISSING_LINK_CLASS)
        a.setAttribute('title', `目标页面不存在：${res.slug ?? ''}`)
      }
    }

    // wikilink 的自动显示文本 → 页面真实标题（仅在页面确实存在时）
    if (a.getAttribute(WIKILINK_AUTO_ATTR) === null) continue
    const target = a.getAttribute(WIKILINK_ATTR)
    if (target === null || pages === null) continue
    const title = pages.get(normalizeSlugTarget(target))
    if (title !== undefined && title !== '') a.textContent = title
  }
}

/**
 * 附件图片的后处理：加懒加载标记、以及"它属于哪个页面"（破图兜底要用）。
 *
 * 与 `rewriteBodyLinks` 并列、同样在**消毒之后**跑：这里只新增属性，不解析正文字符串。
 *
 * 三件事各自的理由：
 * - `loading="lazy"`：正文里可能嵌了很多张图，一次性下载会把首屏和带宽都拖垮
 *   （附件是**二进制**，与文本正文的量级完全不同）；
 * - `data-gw-attachment`：破图兜底只认**附件**图，不能把用户贴的外链图也替换掉
 *   （外链图挂了是另一回事，把它替换成"无权访问"是彻头彻尾的谎话）；
 * - `data-gw-attachment-slug`：附件可能"页面可读但它自己被删/被挡"，此时唯一的下一步是
 *   **申请该页面的访问权**，而申请端点按 slug 定位。slug 未知（历史预览等）就不写这个属性，
 *   占位块里也就没有申请入口 —— 宁可不给，也不给一个点了没用的按钮。
 */
export function decorateAttachmentMedia(
  holder: HTMLElement,
  opts: { applySlug?: string | null } = {},
): void {
  const slug = opts.applySlug ?? ''
  for (const img of [...holder.querySelectorAll('img')]) {
    if (!isAttachmentUrl(img.getAttribute('src'))) continue
    img.setAttribute('loading', 'lazy')
    img.setAttribute(ATTACHMENT_MEDIA_ATTR, '')
    if (slug !== '') img.setAttribute(ATTACHMENT_SLUG_ATTR, slug)
  }
}

/**
 * 破图占位块：附件图加载失败时**替换**掉那个 `<img>`（见 `MarkdownBody` 的捕获阶段监听）。
 *
 * 为什么文案必须含糊（「无权访问**或**被删除」）：浏览器对 `<img>` 的失败只给一个 `error`
 * 事件，**不带状态码** —— 而服务端对越权与不存在都回同一个 404（防存在性探测），
 * 前端因此完全同形。写成"你没有权限"是把猜测说成事实，而附件很可能只是被作者删了。
 * 这与服务端"越权一律回同一个 404"（防存在性探测）是同一条哲学：界面不能比它掌握的证据说得更硬。
 *
 * `pending` 为真表示本机记着"我已经申请过这个页面的访问权"（`lib/myAccessRequests.ts`），
 * 此时显示状态而不是再给一个必然 409 的按钮。
 */
export function buildBlockedAttachment(
  doc: Document,
  slug: string | null,
  pending: boolean,
  alt = '',
): HTMLElement {
  const box = doc.createElement('div')
  box.className = ATTACHMENT_BLOCKED_CLASS
  box.setAttribute(ATTACHMENT_BLOCKED_ATTR, '')

  const title = doc.createElement('p')
  title.className = 'gw-attachment-blocked-title'
  title.textContent = ATTACHMENT_BLOCKED_TEXT
  box.append(title)

  // 原图的 alt（通常就是文件名）留着：多图页面里，用户要知道是**哪一张**没显示出来
  if (alt !== '') {
    const name = doc.createElement('span')
    name.className = 'gw-attachment-blocked-alt'
    name.textContent = `（${alt}）`
    title.append(' ', name)
  }

  const reason = doc.createElement('p')
  reason.className = 'gw-attachment-blocked-reason'
  reason.textContent = ATTACHMENT_BLOCKED_REASON
  box.append(reason)

  if (slug !== null && slug !== '') {
    const actions = doc.createElement('div')
    actions.className = 'gw-attachment-blocked-actions'
    if (pending) {
      const state = doc.createElement('span')
      state.className = 'gw-attachment-blocked-pending'
      state.textContent = ATTACHMENT_APPLY_PENDING_TEXT
      actions.append(state)
    } else {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.className = 'gw-attachment-blocked-apply'
      btn.setAttribute(ATTACHMENT_APPLY_ATTR, '')
      btn.setAttribute(ATTACHMENT_SLUG_ATTR, slug)
      btn.textContent = ATTACHMENT_APPLY_TEXT
      actions.append(btn)
    }
    box.append(actions)
  }
  return box
}

/**
 * Markdown → 已消毒 HTML + 注入锚点与复制按钮 + 目录。
 *
 * @param markdown 原始 Markdown
 * @param opts.route     当前页面路由（形如 `wiki/<slug>`），用于拼锚点 href。
 *                       锚点不能写成 `#<id>`——本应用是 hash 路由，那会被当成新路由
 *                       （详见 `lib/hashAnchor.ts` 的说明）。
 * @param opts.withCopyButtons 是否为代码块加复制按钮（历史预览等只读小窗可以关掉）
 * @param opts.pages     已知页面（slug → 标题）。用于两件事：
 *                       ① 判定站内链接的目标是否存在（不存在则标 `data-gw-missing`）；
 *                       ② 把 `[[wikilink]]` 的自动显示文本换成**页面真实标题**。
 *                       `null`/缺省表示"尚未取到列表"——此时**不判定缺失**，
 *                       只把显式路径改写成 hash 形态（否则列表加载完成前会把全站链接
 *                       都标成"不存在"）。
 * @param opts.attachmentSlug 正文所属页面的 slug。只用于附件破图兜底：占位块里的
 *                       「申请访问」要按页面 slug 提交申请（附件没有独立申请端点）。
 *                       未知时（历史快照预览等）传 `null`/不传 ⇒ 占位块不给申请入口，
 *                       但**仍然**如实说明"无权访问或被删除"。
 */
export function renderMarkdownBody(
  markdown: string,
  opts: {
    withCopyButtons?: boolean
    route?: string
    pages?: ReadonlyMap<string, string> | null
    attachmentSlug?: string | null
  } = {},
): RenderedMarkdown {
  const withCopyButtons = opts.withCopyButtons ?? true
  const route = opts.route ?? ''
  const pages = opts.pages ?? null
  const holder = document.createElement('div')
  holder.innerHTML = mdToHtml(markdown)

  /*
   * 链接改写必须在**注入标题锚点之前**：那时 holder 里只有正文自己的 `<a>`，
   * 我们注入的 `.gw-heading-anchor` 还没出现，因而不存在"把自己刚写的锚点再改写一次"的问题。
   */
  rewriteBodyLinks(holder, route, pages)

  /*
   * 附件图片紧随其后（同样只加属性）。两处都必须在**消毒之后**：
   * `decorateAttachmentMedia` 依赖 `img[src]` 的最终形态，若在消毒前跑，
   * DOMPurify 可能把属性/节点整段摘掉，我们就白标了。
   */
  decorateAttachmentMedia(holder, { applySlug: opts.attachmentSlug ?? null })

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
