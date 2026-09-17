/**
 * Markdown → 安全 HTML 的唯一出口。
 *
 * marked 会透传正文中的原始 HTML，直接经 dangerouslySetInnerHTML 注入
 * 会形成存储型 XSS（任何能写页面的用户可在他人阅读时执行脚本）。
 * 所有渲染路径（详情 / 历史预览 / 编辑预览）必须经由本函数：
 * marked 输出先经 DOMPurify 消毒，再交给 React。
 */
import DOMPurify from 'dompurify'
import { activeMarked } from './markdownExt'
/*
 * ★ F8：显式的**副作用导入** —— 内置的 `[[wikilink]]` 扩展必须在**任何**渲染路径上已注册。
 *
 * 改造前这一步是隐式的：只有 `markdownRender.ts` 导入了 `wikilink`，于是"直接调用
 * `mdToHtml` 而不经过 markdownRender"的路径（例如将来的导出/预览功能）会**静默地**
 * 把 `[[x]]` 原样输出。现在把依赖写在这里，使"消毒出口 = 全部扩展就绪"成为结构性保证。
 */
import './wikilink'

/**
 * Markdown 正文 → 已消毒 HTML（可安全用于 dangerouslySetInnerHTML）。
 *
 * ★ F8：marked 由 `activeMarked()` 给出 —— 它按 `markdownExt` 注册表的当前版本装配
 * （内置 wikilink + 插件注册的扩展），而不是那个**只增不减**的全局单例。
 *
 * ## 这个函数是安全边界，不是"最后一站之一"
 * 它**必须**是正文 HTML 的唯一出口：插件贡献的渲染器产出再多花样的 HTML，
 * 也一律在这里被 DOMPurify 收口。任何"插件直出 HTML 挂进 DOM"的路径都绕过了
 * 链接改写、附件标注、标题锚点这一整套后处理，同时也绕过了本行。
 */
export function mdToHtml(markdown: string): string {
  const raw = activeMarked().parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(raw)
}
