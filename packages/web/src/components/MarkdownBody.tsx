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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { copyText } from '../lib/clipboard'
import {
  ATTACHMENT_APPLY_ATTR,
  ATTACHMENT_BLOCKED_ATTR,
  ATTACHMENT_MEDIA_ATTR,
  ATTACHMENT_SLUG_ATTR,
} from '../lib/attachmentPlan'
import { recallRequest } from '../lib/myAccessRequests'
import {
  COPY_BUTTON_ATTR,
  buildBlockedAttachment,
  codeTextFromButton,
  renderMarkdownBody,
} from '../lib/markdownRender'
import type { BlockSegment } from '../lib/blockMetaPlan'
import { ApplyAccessDialog } from './access/ApplyAccessDialog'

/** 反馈停留时长：成功 1s（与 Docusaurus 的 1000ms 一致），失败 3s（够用户读完并按键） */
const OK_MS = 1000
const MANUAL_MS = 3000

/** 计算 Markdown 的渲染产物（消毒 + 锚点 + 复制按钮 + 目录 + 链接改写 + 附件标记） */
export function useRenderedMarkdown(
  markdown: string,
  opts: {
    withCopyButtons?: boolean
    route?: string
    /** 已知页面（slug → 标题）：判定站内链接是否存在、并给 `[[wikilink]]` 回填标题 */
    pages?: ReadonlyMap<string, string> | null
    /** 正文所属页面（附件破图占位块的「申请访问」按它提交申请）；未知时不传 */
    attachmentSlug?: string | null
    /**
     * ★ 0024：块级归属（已对齐到**本函数收到的这份** Markdown，见 `lib/blockMetaPlan.ts`）。
     * `null`/缺省 ⇒ 不做逐段包裹（历史快照预览、"按访客视角预览"等一律不传：
     * 那两份正文与接口下发的区间不是同一份，硬传只会错位）。
     */
    segments?: readonly BlockSegment[] | null
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
  const attachmentSlug = opts.attachmentSlug ?? null
  const segments = opts.segments ?? null
  /*
   * ══════ 无 DOM 环境（SSR / 单测的 renderToString）══════
   *
   * 渲染流水线要用 `document.createElement` 造一个游离节点，**且消毒出口 DOMPurify 也是 DOM 实现**，
   * 在 Node 的 SSR 里两者都没有。此前这条路径从未被走到（默认落点是列表页，列表页不渲染正文），
   * 主页成为默认落点后必然被走到。
   *
   * 处置：服务端**返回空**，正文留给客户端挂载后的 `useEffect`（`MarkdownBody` 本来就是
   * "命令式注入 + 只在 HTML 变化时写 DOM"，因此"服务端空、客户端填"正是它天然的形状）。
   * 为什么不在服务端用"正则 + 字符串拼接"凑一份：那等于**绕开消毒出口**（`mdToHtml` 是
   * 全仓唯一的消毒点），为了 SSR 好看而复制一条未经消毒的渲染路径，是不可接受的交易。
   *
   * ⚠️ 这个判断写在 `useMemo` **回调内部**，不能写成提前 return：提前 return 会让本次渲染的
   * hook 数量变少，React 直接抛 #310（"Rendered fewer hooks than expected"）。
   */
  const canRender = typeof document !== 'undefined' && typeof document.createElement === 'function'
  return useMemo(
    () =>
      canRender
        ? renderMarkdownBody(markdown, { withCopyButtons, route, pages, attachmentSlug, segments })
        : { html: '', toc: [] },
    [canRender, markdown, withCopyButtons, route, pages, attachmentSlug, segments],
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
  /** 需要打开「申请访问」对话框的页面 slug（占位块里的按钮点出来的） */
  const [applySlug, setApplySlug] = useState<string | null>(null)

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

  /*
   * 附件破图兜底：**捕获阶段**监听 `error`。
   *
   * 为什么必须挂在 `window` 且 `capture: true`：资源加载失败的事件**不冒泡**
   * （直接在目标上派发，`bubbles: false`），React 的合成事件（挂在容器上、冒泡阶段）
   * 收不到它；只有捕获阶段能从上往下拿到。
   *
   * 为什么只认带 `data-gw-attachment` 的图：外链图挂掉是另一回事，把它替换成
   * "无权访问或被删除"是彻头彻尾的谎话（`decorateAttachmentMedia` 只标附件图）。
   *
   * 替换是**一次性**的（`data-gw-attachment-blocked` 标记）：某些浏览器在图片被重新
   * 挂载/重试时会重复派发 error，没有这个标记就会重复替换、占位块里再套占位块。
   */
  useEffect(() => {
    const onError = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLImageElement)) return
      if (target.getAttribute(ATTACHMENT_MEDIA_ATTR) === null) return
      if (target.getAttribute(ATTACHMENT_BLOCKED_ATTR) !== null) return
      target.setAttribute(ATTACHMENT_BLOCKED_ATTR, '')
      const slug = target.getAttribute(ATTACHMENT_SLUG_ATTR)
      /*
       * `recallRequest` 读的是**本机**记下的待审申请（服务端没有"查我的申请"端点）。
       * 有 ⇒ 显示状态而不是再给一个必然 409 的按钮。读不到（隐私模式/换设备）时
       * 一律当"没申请过"：多给一个按钮比给一句不实的"已提交"要好。
       */
      const pending = slug !== null && recallRequest(slug) !== null
      target.replaceWith(buildBlockedAttachment(document, slug, pending, target.alt))
    }
    window.addEventListener('error', onError, true)
    return () => window.removeEventListener('error', onError, true)
  }, [])

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

    /*
     * 破图占位块里的「申请访问」也走同一个委托（按钮同样是命令式注入的 DOM，
     * React 不管这棵子树）。命中它时**立即返回**，不要继续当成复制按钮处理。
     */
    const apply = target.closest(`[${ATTACHMENT_APPLY_ATTR}]`)
    if (apply !== null) {
      const slug = apply.getAttribute(ATTACHMENT_SLUG_ATTR)
      if (slug !== null && slug !== '') setApplySlug(slug)
      return
    }

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

  return (
    <>
      <div ref={hostRef} className={className} onClick={onCopyClick} />
      {/*
        「申请访问」对话框：**受控打开且不带自带触发器**（入口就是占位块里的按钮）。
        复用既有的 `ApplyAccessDialog`（M3）而不是另写一份表单 —— 提交/冲突/撤回的
        状态机在这个仓库里只应有一份。它渲染进 Portal，因此不会破坏 `.page-detail > .md-body`
        这类"直接子元素"选择器（Fragment 本身不产生 DOM 节点）。
      */}
      {applySlug !== null && (
        <ApplyAccessDialog
          slug={applySlug}
          open
          withTrigger={false}
          onOpenChange={(next) => {
            if (!next) setApplySlug(null)
          }}
        />
      )}
    </>
  )
}
