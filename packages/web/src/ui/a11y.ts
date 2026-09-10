/**
 * 焦点环（focus ring）——**全站唯一的焦点样式来源**。
 *
 * 无障碍硬指标（WCAG 2.2）：
 * - **1.4.11 非文本对比度 ≥3:1**：焦点指示器与相邻背景的对比度必须达到 3:1。
 *   本仓库用 `--gw-focus-ring`（浅色=blue-600 #2563eb，深色=blue-300 #93c5fd），
 *   对各自主题的面板底色均在 5:1 以上，留足余量。
 * - **2.4.11 焦点不被遮挡**：顶栏是 `position: sticky`，锚点滚动时可能盖住聚焦元素。
 *   故用 `scroll-mb-header` 给被聚焦/被锚定的元素留出顶栏高度（见 tokens 的
 *   `--spacing-header`）。
 *
 * 为什么用 `:focus-visible` 而不是 `:focus`：鼠标点击按钮不该出现焦点环（那是
 * 视觉噪声），而键盘 Tab 到时**必须**出现。`:focus-visible` 正是这个语义，且被
 * 所有目标浏览器支持（Chrome 86+ / Safari 15.4+ / Firefox 85+）。
 *
 * 用 `outline` 而非 `box-shadow`/`border`：outline 不参与布局（不会引起跳动），
 * 在 Windows 高对比度模式下也能保留。
 *
 * **实现放在 CSS 里**（`src/styles/focus.css` 的 `.gw-focus-ring`），而不是 Tailwind
 * 的 outline 工具类。原因见该文件头部：v4 的 `outline-none` 会把
 * `--tw-outline-style` 设为 none，导致 `focus-visible:outline-2` 的 computed
 * `outline-style` 仍是 none —— 焦点环"写了却看不见"（已实测）。
 */
export const focusRing = 'gw-focus-ring'

/**
 * 触控目标最小尺寸（WCAG 2.2 **2.5.8 Target Size (Minimum) AA = 24×24 CSS px**）。
 *
 * 用 `min-h-6 min-w-6`（24px）保证**图标按钮**达标；带文字的按钮天然更高，
 * 但 `min-h` 仍然有用（避免 `size="sm"` 被压到 24px 以下）。
 * 注意这是"最低"而非"目标"——主要操作用默认尺寸（32px 高），更易点。
 */
export const touchTarget = 'min-h-6 min-w-6'
