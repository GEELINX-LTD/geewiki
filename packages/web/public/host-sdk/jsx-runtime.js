// GeeWiki 宿主 SDK 的 jsx-runtime ESM 入口（供 import map 指向）。
//
// 必须返回**宿主真实的** jsx/jsxs 实现，不能用 createElement 伪造：
// React 19 下 key 不再被展开进 props，伪造实现会产生错误的语义与告警。
const H = globalThis.__GEEWIKI_HOST__;
if (!H || !H.jsxRuntime) {
  throw new Error('[geewiki-host-sdk] window.__GEEWIKI_HOST__.jsxRuntime 未初始化');
}
const J = H.jsxRuntime;

export const jsx = J.jsx;
export const jsxs = J.jsxs;
export const Fragment = J.Fragment;
export default J;
