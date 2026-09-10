// GeeWiki 宿主 SDK 的 ESM 入口（供 import map 指向）。
//
// 插件客户端 bundle 把 `react` 声明为 external，浏览器按 import map 把裸说明符解析到这里，
// 于是插件与宿主共用同一个 React 实例（避免双实例导致 hooks 失效）。
//
// 注意：ESM 无法动态转发具名导出（Proxy 只能代理 default），因此这里必须**逐条枚举**具名导出。
// 本文件在模块求值期读取 globalThis.__GEEWIKI_HOST__，宿主必须在动态 import 任何插件 bundle
// 之前先完成挂载（见 packages/web/src/lib/hostSdk.ts）。
const H = globalThis.__GEEWIKI_HOST__;
if (!H || !H.React) {
  throw new Error('[geewiki-host-sdk] window.__GEEWIKI_HOST__ 未初始化');
}
const R = H.React;

export default R;
export const Children = R.Children;
export const Component = R.Component;
export const Fragment = R.Fragment;
export const Profiler = R.Profiler;
export const PureComponent = R.PureComponent;
export const StrictMode = R.StrictMode;
export const Suspense = R.Suspense;
export const cloneElement = R.cloneElement;
export const createContext = R.createContext;
export const createElement = R.createElement;
export const createRef = R.createRef;
export const forwardRef = R.forwardRef;
export const isValidElement = R.isValidElement;
export const lazy = R.lazy;
export const memo = R.memo;
export const startTransition = R.startTransition;
export const use = R.use;
export const useActionState = R.useActionState;
export const useCallback = R.useCallback;
export const useContext = R.useContext;
export const useDebugValue = R.useDebugValue;
export const useDeferredValue = R.useDeferredValue;
export const useEffect = R.useEffect;
export const useId = R.useId;
export const useImperativeHandle = R.useImperativeHandle;
export const useInsertionEffect = R.useInsertionEffect;
export const useLayoutEffect = R.useLayoutEffect;
export const useMemo = R.useMemo;
export const useOptimistic = R.useOptimistic;
export const useReducer = R.useReducer;
export const useRef = R.useRef;
export const useState = R.useState;
export const useSyncExternalStore = R.useSyncExternalStore;
export const useTransition = R.useTransition;
export const version = R.version;
