/**
 * `[[wikilink]]` 语法支持（wiki 的标志性能力）。
 *
 * ## 为什么用 marked 的扩展 API，而不是对原文做字符串替换
 *
 * 直觉做法是 `markdown.replace(/\[\[(.+?)\]\]/g, ...)`——**这是错的**：它分不清
 * "正文"与"代码"。`[[not-a-link]]` 出现在围栏代码块或行内代码里时是**示例文本**，
 * 字符串替换会把它改成链接，等于篡改用户内容（文档站里这种例子极常见）。
 *
 * marked 的 inline tokenizer 只在**行内文本**阶段被调用，代码块与行内代码已经被
 * 更高优先级的规则吃掉，因此天然不会误伤（实测确认，见 `test/wikilink.test.ts`：
 * ```\n[[x]]\n``` 与 `` `[[x]]` `` 都保持字面量）。
 *
 * ## 为什么在这里 `marked.use()` 而不改 `lib/sanitize.ts`
 *
 * `marked.use()` 是**在共享的 marked 单例上注册扩展**，因此可以从任意模块调用，
 * 不需要动消毒链路（`mdToHtml` 仍是唯一出口，仍是那个文件里的一行）。
 * 注册是幂等的（模块级 flag 兜底，避免重复 push 同名扩展）。
 *
 * ## 链接怎么落地
 *
 * 这里只产出 **href 已是站内 hash 形态**的 `<a>`，并带 `data-gw-wikilink="<slug>"`。
 * "目标是否存在"由随后的后处理层（`markdownRender.ts`）判定——因为 marked 阶段
 * 拿不到页面列表。显示文本若**未显式给出**（`[[slug]]` 而非 `[[slug|文本]]`），
 * 后处理层会用该页面的**真实标题**替换掉 slug（这才是 wiki 该有的样子）。
 *
 * 安全：产出仍会整体经过 DOMPurify（`mdToHtml`），且本模块自己对文本做转义
 * （纵深防御：万一将来有人把 `mdToHtml` 换掉，这里也不会因为未转义而变成注入口）。
 */
import { marked } from 'marked'
import { normalizeSlugTarget, pageHash } from './linkPlan'

/** 标记属性：后处理层靠它识别"这是 wikilink"，并据此回填页面标题 */
export const WIKILINK_ATTR = 'data-gw-wikilink'

/** 显示文本是"自动"的（`[[slug]]`）——只有这种才允许被标题替换；显式文本不覆盖 */
export const WIKILINK_AUTO_ATTR = 'data-gw-wikilink-auto'

interface WikilinkToken {
  type: 'wikilink'
  raw: string
  target: string
  text: string
  hasExplicitText: boolean
}

/*
 * 目标里**不允许**出现 `[`、`]`、`|`、换行：
 * - 不允许 `]`/`[`：否则 `[[a]b]]` 这类畸形输入会被跨过去匹配到很远的 `]]`，
 *   把中间的整段正文吃成目标（实测过：`[[unclosed and [[a|b]]` 会产出
 *   `unclosed and [[a` 这种荒唐目标）；
 * - 不允许 `|`：它是"目标|显示文本"的分隔符；
 * - 不允许换行：wikilink 不应跨行。
 */
const WIKILINK_RE = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

let registered = false

/** 注册 `[[wikilink]]` 扩展（幂等；模块加载时自动调用一次） */
export function registerWikilink(): void {
  if (registered) return
  registered = true

  marked.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        /** 告诉 marked 下一个可能的起点，避免逐字符试探 */
        start(src: string): number | undefined {
          const i = src.indexOf('[[')
          return i === -1 ? undefined : i
        },
        tokenizer(src: string): WikilinkToken | undefined {
          const m = WIKILINK_RE.exec(src)
          if (m === null) return undefined
          const rawTarget = m[1] ?? ''
          const target = normalizeSlugTarget(rawTarget)
          if (target === '') return undefined // `[[|x]]` / `[[   ]]`：不是链接
          const explicit = m[2]
          return {
            type: 'wikilink',
            raw: m[0],
            target,
            text: explicit === undefined ? rawTarget.trim() : explicit.trim(),
            hasExplicitText: explicit !== undefined,
          }
        },
        renderer(token): string {
          const t = token as unknown as WikilinkToken
          const auto = t.hasExplicitText ? '' : ` ${WIKILINK_AUTO_ATTR}="1"`
          return (
            `<a href="${escapeHtml(pageHash(t.target))}"` +
            ` ${WIKILINK_ATTR}="${escapeHtml(t.target)}"${auto}>` +
            `${escapeHtml(t.text)}</a>`
          )
        },
      },
    ],
  })
}

// 模块加载即注册：`markdownRender.ts` 导入本模块，因此**任何渲染路径之前**都已生效
registerWikilink()
