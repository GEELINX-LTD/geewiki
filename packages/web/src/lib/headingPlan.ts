/**
 * 标题锚点与页内目录（TOC）的**纯逻辑**——不接触 DOM，可直接用 `node:test` 单测。
 *
 * 为什么拆出来：`id` 生成是"可判定的字符串逻辑"，而它又决定了 TOC 链接、锚点跳转、
 * 以及"重复标题"这种必须加序号才能不出错的边界。放在组件里就只能靠浏览器肉眼验证。
 *
 * 参考实现的成熟基线（本仓库照做，不做发明）：
 * - Docusaurus 的 `Heading` 给 h2/h3 加 id 与 `<a class="hash-link">`，且 **h1 故意不给
 *   id**（理由：H1 是页面标题，不出现在 TOC 里）；其 TOC **默认只列 h2–h3**。
 * - VitePress 的 `outline.level` 默认值就是 `2`（即 h2–h3；`'deep'` 才是 [2,6]）。
 * 两者一致，故这里也只把 **h2–h3** 收进 TOC。
 */

/** 收进 TOC 的标题层级（h2–h3；与 Docusaurus / VitePress 的默认口径一致） */
export const TOC_LEVELS: readonly number[] = [2, 3]

/** 目录里最多列多少条——超长文档的 TOC 会变成一堵墙，超出部分不再展示 */
export const MAX_TOC_ENTRIES = 80

export interface HeadingInput {
  level: number
  text: string
}

export interface HeadingEntry {
  /** 稳定的锚点 id（重复标题带 `-1`/`-2` 序号） */
  id: string
  level: number
  text: string
}

/**
 * 标题文本 → 锚点 slug。
 *
 * 规则（与 github-slugger / Docusaurus 的行为保持一致的**可读子集**）：
 * - 小写化（只影响拉丁字母；中文无大小写，天然不受影响）；
 * - 空白（含全角空格 U+3000）折叠为单个 `-`；
 * - 丢掉标点、emoji、括号等一切非「字母/数字/下划线/连字符/点」字符
 *   —— 用 `\p{L}\p{N}` 而不是 `[a-z0-9]`，否则**中文标题会被清空**；
 * - 折叠连续 `-`，去掉首尾 `-`。
 *
 * 返回空串表示"这个标题没有任何可用的字符"（例如 `### !!!`），由调用方回退成 `section`。
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // 空白（含全角空格）→ 连字符
    .replace(/[\s\u3000]+/g, '-')
    // 保留：Unicode 字母、数字、下划线、连字符、点；其余（标点/emoji/引号…）丢弃
    .replace(/[^\p{L}\p{N}_.-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * 给标题序列分配稳定 id。
 *
 * **重复标题必须能区分**：同名的两个 `## 用法` 若共用 `usage`，第二个锚点就永远点不到
 * （浏览器只认第一个）。因此按出现顺序加 `-1`、`-2` 后缀——与 github-slugger 同策略。
 *
 * 纯函数：同一输入必得同一输出（TOC 与锚点两处分别调用也不会漂移）。
 */
export function assignHeadingIds(headings: readonly HeadingInput[]): HeadingEntry[] {
  const seen = new Map<string, number>()
  return headings.map((h) => {
    const base = slugifyHeading(h.text) || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { id: n === 0 ? base : `${base}-${n}`, level: h.level, text: h.text }
  })
}

/** 从标题序列里挑出 TOC 条目（h2–h3，最多 {@link MAX_TOC_ENTRIES} 条） */
export function tocEntries(headings: readonly HeadingEntry[]): HeadingEntry[] {
  return headings.filter((h) => TOC_LEVELS.includes(h.level)).slice(0, MAX_TOC_ENTRIES)
}

/** 锚点链接的无障碍名称（屏幕阅读器会读出来，因此必须带上标题文本） */
export function anchorLabel(text: string): string {
  const t = text.trim()
  return t === '' ? '本节链接' : `链接到「${t}」`
}

/**
 * 高亮判定：给定各标题当前的视口位置，选出"当前所在小节"。
 *
 * 抽成纯函数是为了能单测——`IntersectionObserver` 的回调无法在 node 里复现，
 * 但"该高亮谁"这个决策完全可以（也最容易写错：滚动到两节之间、滚到页面底部、
 * 顶部还没到第一个标题，都是边界）。
 *
 * @param positions 标题 id → 距视口顶部的像素（负数=已在视口上方）；顺序按文档顺序
 * @param threshold 判定为"已越过"的线（通常是顶栏高度 + 余量）
 * @returns 应当高亮的 id；没有任何标题越过该线时返回第一个（读文档开头时高亮首节）
 */
export function pickActiveHeading(
  positions: readonly { id: string; top: number }[],
  threshold: number,
): string | null {
  if (positions.length === 0) return null
  let active: string | null = null
  for (const p of positions) {
    // 允许 1px 容差：亚像素滚动时 `top` 可能正好等于 threshold，不该闪烁
    if (p.top <= threshold + 1) active = p.id
    else break
  }
  return active ?? (positions[0]?.id ?? null)
}
