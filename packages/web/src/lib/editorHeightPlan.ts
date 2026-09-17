/**
 * 编辑器**最小高度**的唯一真源。
 *
 * 为什么单独一个模块：这个值有三个消费方，而它们**必须一致** ——
 *   1. `components/MarkdownEditor.tsx`（真正的编辑面）；
 *   2. `components/MarkdownEditorLazy.tsx`（Suspense 骨架 + 降级 textarea）；
 *   3. `pages/WikiPage.tsx`（页面加载骨架）。
 * 三者不一致的后果正是骨架屏最忌讳的 CLS：占位与实际不同尺寸，数据到达时整页跳一下。
 *
 * 而且它们**曾经**就不一致：WikiPage 给编辑器传 `480px`，同一页的加载骨架却是 `h-[420px]`，
 * 组件默认值又是第三个 `420px`。故这里收成一个常量（与 `lib/navPlan.ts` /
 * `lib/liveRenderPlan.ts` 同一约定：纯数据、无依赖、可被 node 测试直接 import）。
 *
 * 取值理由：240px 在 13px 字号 / 1.6 行高下约合 11 行正文，够写一小段；
 * 而它**只是下限** —— 编辑面会随内容长高，不会把长文档截断。
 *
 * 曾经是 420 / 480px。那不只是"偏高"：编辑面（`.cm-editor`）当时**不跟随**这个容器高度，
 * 于是短文档（如首页）下方会留一大片空白 —— 它既不在编辑器边框内、点了也没有反应，
 * 看起来像布局坏了。两件事都已在 `MarkdownEditor.tsx` 里修掉。
 */
export const DEFAULT_EDITOR_MIN_HEIGHT = '240px'