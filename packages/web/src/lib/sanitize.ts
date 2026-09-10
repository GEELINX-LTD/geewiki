/**
 * Markdown → 安全 HTML 的唯一出口。
 *
 * marked 会透传正文中的原始 HTML，直接经 dangerouslySetInnerHTML 注入
 * 会形成存储型 XSS（任何能写页面的用户可在他人阅读时执行脚本）。
 * 所有渲染路径（详情 / 历史预览 / 编辑预览）必须经由本函数：
 * marked 输出先经 DOMPurify 消毒，再交给 React。
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Markdown 正文 → 已消毒 HTML（可安全用于 dangerouslySetInnerHTML） */
export function mdToHtml(markdown: string): string {
  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(raw)
}
