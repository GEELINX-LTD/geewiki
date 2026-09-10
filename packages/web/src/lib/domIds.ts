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
