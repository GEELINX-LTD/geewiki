/**
 * 跨组件共享的 DOM id。
 *
 * 为什么单独一个模块而不是从 `App.tsx` 导出：`App` 已经 import 各页面，
 * 若页面再反过来 import `App`，就形成循环依赖。ESM 能容忍它，但**初始化顺序**
 * 会变得依赖求值时机（在热更新下尤其容易出现"某个导出还是 undefined"的怪象）。
 * 共享常量放在叶子模块里，依赖图保持单向。
 */

/** 列表页搜索框的 id：全局搜索快捷键（⌘K 或 /）把焦点送到这里 */
export const SEARCH_INPUT_ID = 'wiki-search-input'

/** 主内容区的 id：「跳到主内容」链接的目标（也是 `main` 元素的 id） */
export const MAIN_CONTENT_ID = 'main'

/** 列表页"在当前列表中过滤"输入框的 id（与 label 的 htmlFor 配对） */
export const FILTER_INPUT_ID = 'gw-page-filter'
/** 过滤结果计数的 id（供 aria-describedby 关联） */
export const FILTER_HINT_ID = 'gw-page-filter-hint'

/**
 * 编辑页左侧「正文（Markdown）」面板标注的 id。
 *
 * 用途：`<section aria-labelledby>` 的可访问名称来源。**必须**有名字——按 HTML-AAM，
 * `<section>` **只有具备可访问名称时**才映射为 `region` 地标，否则退化为 `generic`
 * （那样写 `<section>` 等于白写）。见 https://w3c.github.io/html-aam/ 的 section 行：
 * "region role if the section element has an accessible name. Otherwise, the generic role."
 */
export const EDITOR_PANE_LABEL_ID = 'gw-editor-pane-label'

/**
 * 编辑页右侧「预览」面板标注的 id（同上，供 `aria-labelledby` 使用）。
 *
 * 为什么预览要成为**可命名区域**：它是"Markdown 渲染成什么样"的唯一凭据。此前它只由一个
 * **无 id 的 `<span>`** 标注、外层是**裸 `<div>`** ⇒ 屏幕阅读器无法把它识别为一个区域、
 * 更无法按区域跳转。依据 W3C WAI《Headings》教程：
 * "Headings are useful for labeling page regions. Use aria-labelledby to associate headings
 *  with their page region… If the headings are visible, the regions are easy to identify for
 *  all users." （https://www.w3.org/WAI/tutorials/page-structure/headings/）
 */
export const PREVIEW_PANE_LABEL_ID = 'gw-preview-pane-label'
