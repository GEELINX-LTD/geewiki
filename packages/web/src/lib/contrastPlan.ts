/**
 * WCAG 对比度计算与**设计 token 的对比度守卫**（纯函数，可单测）。
 *
 * 为什么要有这个文件：无障碍审计（axe-core）在本仓库浅色主题下命中的**全部**严重违规
 * 都收敛到同一个根因——正文次要文字用的 `--gw-ink-muted`。这类"一个 token 决定成百个
 * 节点是否达标"的问题，靠逐个页面肉眼检查抓不住，必须把不变量写成可执行的断言。
 *
 * 规范依据（用户要求不得主观臆断）：
 * - **WCAG 2.2 SC 1.4.3 Contrast (Minimum) AA**：正文文字与背景对比度 **≥4.5:1**。
 *   https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 * - 相对亮度公式见 **WCAG 2.2** 的定义（sRGB 线性化后按 0.2126/0.7152/0.0722 加权）：
 *   https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html#dfn-relative-luminance
 */

/** sRGB 通道（0..1）线性化——WCAG 相对亮度的第一步。 */
function linearize(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** `#rrggbb` → WCAG 相对亮度（0..1）。非法输入返回 NaN，由调用方判定。 */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return Number.NaN
  const v = m[1] as string
  const [r, g, b] = [0, 2, 4].map((i) => linearize(Number.parseInt(v.slice(i, i + 2), 16) / 255)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * 两色的 WCAG 对比度（1..21）。**与顺序无关**（内部按亮度排序）。
 * 任一色非法时返回 NaN——调用方应当把它当作**失败**而非"通过"。
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (Number.isNaN(la) || Number.isNaN(lb)) return Number.NaN
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 正文文字的最低对比度（WCAG 2.2 SC 1.4.3 AA）。 */
export const AA_TEXT_MIN = 4.5

/**
 * **已知低于 AA、但不属于本模块修复范围**的文字 token。
 *
 * 约定仿照仓库既有的 `PENDING_WEB_SYNC`（`packages/manager/test/slots.test.ts`）：
 * **这个清单只允许变短**。修好某一个就把对应项删掉——守卫测试会因此变红并提示移除，
 * 从而保证"债"不会被悄悄留在代码里。
 *
 * 当前唯一一项的处置建议（已由 axe 审计实测确认，命中 283 个节点）：
 * - `--gw-ink-muted` 现取 `--gw-gray-500`（`#6b7a8c`），对 `#ffffff` 仅 **4.39:1**、
 *   对 `#eef2f7` 仅 **3.90:1**，均低于 4.5:1。
 * - 改为 `--gw-gray-600`（`#55637a`）后对白底 **6.08:1**、对最深的浅色底 `#eef2f7`
 *   **5.41:1**，全背景达标且仍明显弱于正文 `--gw-ink`（13.46:1），语义不变。
 * - 该 token 定义在 `packages/web/src/styles/tokens.css`，**不在本批的可改边界内**，
 *   故只记录、不修改。
 */
export const KNOWN_FAILING_TEXT_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  // 目前为空：审计发现的 `--gw-ink-muted`（当时为 gray-500 #6b7a8c，对白底仅 4.39:1）
  // 已改为 gray-600 #55637a（对白底 6.08:1、对最浅底 #eef2f7 5.41:1），全部达标。
  // 该修复落在 `styles/tokens.css`，由并行的样式批次完成，非本审计批次的改动。
})

/** 浅色主题下正文文字可能落在其上的背景色（来自 tokens.css 的 surface/panel/sunken）。 */
export const LIGHT_TEXT_BACKGROUNDS: readonly string[] = ['#ffffff', '#f5f7fa', '#eef2f7']
