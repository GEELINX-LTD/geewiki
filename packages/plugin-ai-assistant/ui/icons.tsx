/**
 * dock 头部的三个图标（历史 / 新对话 / 收起）。
 *
 * ## 为什么自己画、不用 `lucide-react`
 * 宿主界面用 lucide（`packages/web/src/pages/*.tsx`），但插件界面的构建把**只有 react 系
 * 说明符**外置（`packages/web/fixtures/vite.config.ts:111`），所以插件里 `import` lucide
 * 的后果是**把一份图标实现打进插件自己的 bundle**，并且让插件包的依赖清单多一条真实边
 * （本仓的插件质量门会查"用了没声明的依赖"）。三个图标不值得这条边，故按 lucide 的几何
 * （24 网格、2px 描边、圆头圆角）手写一份，观感与宿主图标一致。
 *
 * ## 无障碍：这些 SVG **永远只是装饰**
 * 可访问名由按钮自己的 `aria-label` 提供——图标按钮没有可见文字，`aria-label` 是**唯一**
 * 的来源，缺了它读屏只会念"按钮"。故每个 svg 都 `aria-hidden="true"`，免得与 `aria-label`
 * 叠成"历史（3）图形"这种重复朗读。`focusable="false"` 是老 Edge/IE 的包袱，
 * 留着不影响任何现代浏览器（本仓 host 的 `Dialog.tsx` 也依赖 `inert` 这类现代特性）。
 */
import type { SVGProps } from 'react'

const BASE: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
}

/** 历史对话：时钟 + 回拨箭头（lucide `history`） */
export function HistoryIcon() {
  return (
    <svg {...BASE}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

/** 新对话：对话气泡 + 加号（lucide `message-square-plus`） */
export function NewChatIcon() {
  return (
    <svg {...BASE}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  )
}

/**
 * 工具摘要行的展开指示（lucide `chevron-right`）。
 *
 * 画成**向右**、由 CSS 在展开时转 90°，而不是准备两个图标：两个图标会有两处几何要同步改，
 * 而旋转只是一个 transform（对应选择器已登记进 `prefers-reduced-motion`，见 style.css）。
 */
export function ChevronIcon() {
  return (
    <svg {...BASE}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** 收起：向下折角（lucide `chevron-down`）——面板是向下收回输入条的，箭头朝下 */
export function CollapseIcon() {
  return (
    <svg {...BASE}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/**
 * 添加图片（lucide `image`）：画框 + 山 + 太阳。
 *
 * 与头部那三个图标同一条几何（24 网格 / 2px 描边 / 圆头圆角），故并排放在输入行里
 * 不会显得是两套东西。
 */
export function ImageIcon() {
  return (
    <svg {...BASE}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  )
}

/** 移除一张待发图片：叉（lucide `x`）。做成**独立图标**而不是字符 `×`，字号/基线才与其它图标一致 */
export function RemoveIcon() {
  return (
    <svg {...BASE} width={12} height={12}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
