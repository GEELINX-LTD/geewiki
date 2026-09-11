import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { registerSlotByName, unregisterSlot, type AnySlotComponent } from './slots'

/**
 * 宿主 SDK：插件客户端 bundle 与宿主之间唯一的进程内契约。
 *
 * 必须在**任何插件 bundle 被动态 import 之前**完成挂载：
 * `public/host-sdk/*.js`（import map 的目标）在模块求值期就读取 `globalThis.__GEEWIKI_HOST__`，
 * 未挂载时会直接抛 `[geewiki-host-sdk] window.__GEEWIKI_HOST__ 未初始化`。
 * 因此 `main.tsx` 的第一行就是这个模块的副作用导入。
 *
 * `React` 取 `react` 包本身（不是 react-dom/client）：插件只需要组件与 hooks；
 * `jsxRuntime` 取宿主真实的 `react/jsx-runtime`，插件用 automatic JSX 时由它产出元素。
 */
export const HOST_SDK_VERSION = '0.1.0'

export interface GeeWikiHostSdk {
  readonly React: typeof React
  readonly jsxRuntime: { jsx: unknown; jsxs: unknown; Fragment: unknown }
  /**
   * 注册插槽组件，返回幂等的注销函数。
   *
   * 名称是**运行期字符串**（插件 bundle 不参与本仓库的类型检查），由
   * `registerSlotByName` 做运行期校验；组件类型是零属性与 editor（带数据）两种形态的联合。
   */
  registerSlot(name: string, component: AnySlotComponent): () => void
  /** 传入 token 只注销一条；不传则清空该插槽 */
  unregisterSlot(name: string, token?: unknown): void
  readonly version: string
}

declare global {
  interface Window {
    __GEEWIKI_HOST__?: GeeWikiHostSdk
  }
}

const sdk: GeeWikiHostSdk = {
  React,
  jsxRuntime: {
    jsx: jsxRuntime.jsx,
    jsxs: jsxRuntime.jsxs,
    Fragment: jsxRuntime.Fragment,
  },
  registerSlot: (name, component) => registerSlotByName(name, component, 'host-sdk'),
  unregisterSlot,
  version: HOST_SDK_VERSION,
}

if (!window.__GEEWIKI_HOST__) {
  window.__GEEWIKI_HOST__ = sdk
}

export function hostSdk(): GeeWikiHostSdk | undefined {
  return window.__GEEWIKI_HOST__
}
