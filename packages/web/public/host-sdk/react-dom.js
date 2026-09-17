// GeeWiki 宿主 SDK 的 react-dom ESM 入口（供 import map 指向）。
//
// ## 为什么现在映射它（F6）
// 在此之前 import map 只映射 `react` / `react/jsx-runtime`，理由是"插件不得自带框架"。
// 那条裁决**仍然成立**——本文件正是它的延伸，不是推翻：插件**不打包** react-dom，
// 而是共用**宿主这一个实例**。缺了它，插件无法 `createPortal`（做全屏模态/浮层）、
// 也无法在自有 DOM 节点上 `createRoot`（做样式隔离：把界面挂进 shadow DOM）。
//
// ## 为什么必须共用同一个实例（而不是让插件自己装一份）
// React 的 hooks 依赖"当前渲染器"这一模块级状态；两份 react-dom 会让插件 portal 到宿主树时
// 事件系统与 context 断裂（症状是"点击没反应 / context 读到默认值"，且不报错）。
// 这与 `react.js` 必须共用同一个 React 实例是同一条理由。
//
// 注意：ESM 无法动态转发具名导出（Proxy 只能代理 default），因此这里**逐条枚举**。
// 新增导出时同步改 `packages/web/src/lib/hostSdk.ts` 的 `ReactDOM` 与
// `packages/web/test/hostSdkSurface.test.ts` 的清单守卫——漏改的症状是
// 插件 `import { 某函数 } from 'react-dom'` 拿到 undefined 并在调用时才炸。
const H = globalThis.__GEEWIKI_HOST__;
if (!H || !H.ReactDOM) {
  throw new Error('[geewiki-host-sdk] window.__GEEWIKI_HOST__.ReactDOM 未初始化');
}
const D = H.ReactDOM;

export default D;
export const createPortal = D.createPortal;
export const flushSync = D.flushSync;
export const preload = D.preload;
export const preinit = D.preinit;
export const preconnect = D.preconnect;
export const prefetchDNS = D.prefetchDNS;
export const unstable_batchedUpdates = D.unstable_batchedUpdates;
export const version = D.version;
