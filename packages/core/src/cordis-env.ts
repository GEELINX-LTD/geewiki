/**
 * cordis 类型面补充（全仓统一入口：@geewiki/core 被所有包依赖，其模块图
 * 使本增强在所有包的类型检查中生效）。
 *
 * 背景：cordis@4.0.0-rc.10 的 lib/index.d.ts 以 `export *` 链暴露类型，
 * reflect/registry/fiber/events 等模块通过 `declare module './context'`
 * 为 Context 接口补充 provide/get/plugin 等方法；外部消费时该链呈惰性
 * 解析，增强可能不生效（Context 缺方法、class 值不可见）。
 * 本文件以自包含的模块增强补齐本项目实际使用的 API 面。
 *
 * 约束：本文件不得 import cordis 的任何类型（避免声明合并的解析竞态）。
 * 需要 Context 类型的源文件只需 import @geewiki/core（任意符号）。
 */
import type { DatabaseAdapter } from './index.js'

/** 最小 Fiber 句柄（cordis 运行期插件实例）：await ctx.plugin() 后获得，可 dispose 卸载 */
export interface FiberLike {
  dispose(): Promise<void>
  uid: number | null
  state: number
}

declare module 'cordis' {
  interface Context {
    /** `db` 服务：由 @geewiki/db-sqlite 提供；消费方插件需声明 inject: ['db'] */
    db: DatabaseAdapter

    /* ---- cordis 类型发布缺失面的补充（签名与其内部 d.ts 一致） ---- */

    /** 提供服务（返回注销函数）。与 ctx.get 配对。 */
    provide(name: string, value?: unknown, check?: () => boolean): () => void
    /** 读取服务。strict 时服务缺失抛错。 */
    get(name: 'db'): DatabaseAdapter
    get(name: string, strict?: boolean): unknown
    /** 运行时加载插件，await 后获得 Fiber 句柄（可 dispose 动态卸载）。 */
    plugin(plugin: unknown, config?: unknown): FiberLike & PromiseLike<FiberLike>
    /** 注册事件监听，返回解绑函数。 */
    on(name: string, listener: (...args: any[]) => any): () => boolean
    /** 同步派发事件。 */
    emit(name: string, ...args: unknown[]): void
  }

  /** Context 构造器类型补充（真实值来自 cordis 包，类型发布缺失故在此补齐） */
  interface ContextConstructor {
    new (): Context
  }
  /** 运行时构造器 */
  const Context: ContextConstructor
}

export {}
