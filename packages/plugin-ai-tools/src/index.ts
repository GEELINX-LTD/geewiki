/**
 * `@geewiki/ai-tools` —— AI 工具总线（**纯注册表，不含任何具体工具**）。
 *
 * ## 为什么工具总线要独立成一个插件（设计文档 §1 / 决策 7）
 * 工具提供者（`ai-kb` / `ai-summary` / `ai-writing` / …）各自 `requires: ['ai-tool-service']`，
 * 由管理器按服务标识解析依赖边。把总线做成独立插件而不是塞进会话核心，
 * 有三个具体好处，每个都对应一条会真实发生的事：
 *
 * 1. **提供者必须排在消费者之前结算。** 插槽那批的实测教训（见 `src/types.ts` 文件头）：
 *    在一个插件 `apply` 尚未结算时 `provide` 的服务，对它在此期间创建的子插件不可见，
 *    子插件会 `ctx.get()` 拿到 `undefined` 并**静默跳过**自己的贡献。独立成插件后，
 *    管理器的 `requires` 依赖边保证它先激活、先结算（与 `@geewiki/search` → `ai-qa` 同理）。
 * 2. **`ai-websearch` 这类纯提供者不必为了声明一个能力而依赖会话插件。**
 *    否则"我只是想提供一个工具"要连带拉起 SSE、预算、系统提示一整套。
 * 3. **卸载回收有明确归属。** 管理器是"卸载统一出口"的持有者，它按 owner 调 `release()`；
 *    注册表实例经 `ctx.get('ai-tool-service')` 取用，故**全进程只有一份**。
 *
 * ## 本插件只持有并暴露注册表
 * 生命周期语义（谁在什么时候 contribute / release）归贡献者自己与管理器，
 * 本插件不替它们做决定——与 `@geewiki/slot` 的分工完全一致。
 *
 * ## 关于热插拔
 * `supportsHotReload: true`：本插件**无进程内状态**（注册表内容全部来自别人的贡献），
 * 重跑 `apply` 是安全的。但有一条依赖边上的护栏在兜底：它的消费者（`ai-kb` 等）
 * `requires: ['ai-tool-service']`，故停用本插件会被管理器的 `has_dependents` 检查拒绝
 * （`packages/manager/src/index.ts:1184`）——不会出现"总线没了、工具还在、
 * 但没人登记"这种半死状态。
 */
import type { Context } from 'cordis'
import type { GeeWikiManifest } from '@geewiki/core'
import { AiToolRegistry } from './registry.js'
import { AI_TOOL_SERVICE_NAME } from './types.js'

export * from './types.js'
export { AiToolRegistry } from './registry.js'

export interface AiToolsPluginConfig {
  /** 可选：注入一个既有注册表（测试用；缺省新建） */
  registry?: AiToolRegistry
}

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-tools',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 工具总线',
    description: '把「AI 能做的动作」做成可贡献的注册表，供各 AI 插件登记工具',
    provides: 'ai-tool-service',
    // 无依赖：它是依赖图的根之一，故必须能被**最先**激活的插件集合接纳
    requires: undefined,
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无进程内状态：内容全部来自别人的贡献
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: undefined,
  },
}

/**
 * 工具总线插件。导出形态与仓库其它插件一致：`{ name, apply }`，`apply` 返回 disposer。
 */
export const AiToolsPlugin = {
  name: '@geewiki/ai-tools',
  apply(ctx: Context, config: AiToolsPluginConfig = {}) {
    const registry = config.registry ?? new AiToolRegistry()
    const unprovide = ctx.provide(AI_TOOL_SERVICE_NAME, registry)
    return () => {
      /*
       * 顺序有讲究：**先撤销服务、再清空注册表**。
       *
       * 反过来（先 clear 再 unprovide）会有一个窗口：注册表已空但服务仍可查，
       * 此时若有插件在途调 `list()`，它拿到的是**空工具表**——而"空工具表"在会话核心
       * 那边的含义是"这个 AI 什么都不会做"，不是"服务正在关闭"。先撤销服务则那种调用
       * 会明确失败（`ctx.get()` 返回 undefined），而不是返回一个看起来正常的结果。
       * 这与 `@geewiki/slot` 的 `unprovide()` → `releaseAll()` 是同一条取舍。
       */
      unprovide()
      registry.releaseAll()
    }
  },
}
