// GeeWiki 宿主 SDK 的 react-dom/client ESM 入口（供 import map 指向）。
//
// ## 它解决什么问题
// 插件此前只能在宿主给的那块插槽区域里渲染。有了 `createRoot`，插件可以在**自己拥有的
// DOM 节点**上建独立根 —— 最重要的一种用法是 **shadow DOM 样式隔离**：
//
//   const hostEl = document.createElement('div')
//   const shadow = hostEl.attachShadow({ mode: 'open' })
//   const mount = document.createElement('div')
//   shadow.append(mount, styleEl)
//   createRoot(mount).render(<MyPage />)
//
// 这直接绕开了既有的"插件 CSS 全局注入、只靠 `.gw-fixture-*` 前缀约定"这条限制
// （见 `docs/plugin-platform.md` 的"有意不做：样式隔离"）。
//
// ## 边界（如实记录）
// 宿主**不会**替你管这个根的生命周期：插件必须在自己被卸载时 `root.unmount()`
// （在 `register(host)` 返回的清理函数里做）。否则 React 会留住那棵树的引用，
// 与宿主"ESM 模块实例不可回收"的既有边界叠加，形成一处看不见的内存滞留。
const H = globalThis.__GEEWIKI_HOST__;
if (!H || !H.ReactDOMClient) {
  throw new Error('[geewiki-host-sdk] window.__GEEWIKI_HOST__.ReactDOMClient 未初始化');
}
const C = H.ReactDOMClient;

export default C;
export const createRoot = C.createRoot;
export const hydrateRoot = C.hydrateRoot;
export const version = C.version;
