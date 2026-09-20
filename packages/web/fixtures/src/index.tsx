/**
 * 夹具插件界面（demonstration fixture）。
 *
 * 用途：在「插件自带客户端构建链」尚未落地前，验证宿主侧插槽基础设施真的可用：
 * - `CounterWidget`：用 useState/useEffect 证明插件 bundle 与宿主**共用同一个 React 实例**
 *   （双实例会直接报 `TypeError: Cannot read properties of null (reading 'useState')`）；
 * - `ThrowerWidget`：点击后在下一次渲染故意抛错，证明单个插件 UI 抛错被错误边界隔离，
 *   不会影响其它插槽与宿主。
 *
 * 构建：`pnpm --filter @geewiki/web build:fixtures`
 * 产物：`packages/web/public/plugins-ui/<插件名>/client.{js,css}`
 * 详见同目录 README.md。
 */
import { useEffect, useState, type ReactNode } from 'react'
import './style.css'

/** 与宿主 `packages/web/src/lib/pluginUi.ts` 的 PluginUiHost 对应（夹具自带最小声明，不依赖宿主源码路径） */
interface PluginUiHost {
  readonly pluginName: string
  registerSlot(name: string, component: () => unknown): () => void
  /**
   * **带模式**的注册（P12）。与全局 SDK 上的同名方法语义一致，但它挂在**受限宿主**上：
   * 贡献归属到本插件名（插件停用即被回收），并且受宿主的两道越权闸门约束
   * （被抑制 / 未在清单里声明过的节点会被告警拦下）。
   *
   * 声明为**可选**并特性探测：宿主版本较旧时没有这个方法，插件不该因此整个加载失败
   * （SDK 的纪律是"探测能力，而不是比版本号"）。
   */
  registerExtension?(
    node: string,
    component: (props: Record<string, unknown>) => unknown,
    opts?: { mode?: 'extend' | 'wrap' | 'replace'; shadow?: boolean },
  ): () => void
}

function CounterWidget({ label }: { label: string }): ReactNode {
  const [count, setCount] = useState(0)
  useEffect(() => {
    console.debug(`[geewiki-fixture] ${label} 的界面已挂载`)
  }, [label])
  return (
    <span className="gw-fixture-widget" data-fixture="counter" data-label={label}>
      <button type="button" className="gw-fixture-inc" onClick={() => setCount((value) => value + 1)}>
        +1
      </button>
      <span className="gw-fixture-count">{count}</span>
      <span className="gw-fixture-label">{label}</span>
    </span>
  )
}

function ThrowerWidget({ label }: { label: string }): ReactNode {
  const [boom, setBoom] = useState(false)
  if (boom) throw new Error(`夹具故意抛错（${label}）：用于验证错误边界`)
  return (
    <span className="gw-fixture-widget" data-fixture="thrower" data-label={label}>
      <button type="button" className="gw-fixture-throw" onClick={() => setBoom(true)}>
        触发错误
      </button>
      <span className="gw-fixture-label">{label}</span>
    </span>
  )
}

/**
 * `wrap` 演示件（P12）：把宿主的品牌字样包一层并加一个 `demo` 角标。
 *
 * 为什么用 `wrap` 而不是 `replace`：`wrap` 拿到宿主默认元素（`props.default`），
 * **不可能弄丢控件**——这正是"只想加个角标"的插件该用的模式。
 */
function BrandBadge({ default: fallback }: { default?: unknown }): ReactNode {
  return (
    <span className="gw-fixture-brand" data-fixture="brand-wrap">
      {fallback as ReactNode}
      <span className="gw-fixture-brand-tag">demo</span>
    </span>
  )
}

/** 宿主加载器调用约定：bundle 导出 register(host)，可返回清理函数 */
export function register(host: PluginUiHost): () => void {
  const disposers = [
    host.registerSlot('app-header', () => <CounterWidget label={host.pluginName} />),
    host.registerSlot('app-footer', () => <ThrowerWidget label={host.pluginName} />),
  ]
  /*
    P12 演示：**带模式**的注册走受限宿主。它比"用全局 SDK 直接注册"多两件事：
    ① 归属到本插件名 ⇒ 插件停用/重载时贡献被一起回收（全局 SDK 的来源是 host-sdk，回收不了）；
    ② 受越权闸门约束 ⇒ 未在 `package.json#geewiki.extensions` 里声明的节点会被拦下并告警。
    因此 `plugins/ui-demo/package.json` 里必须同时声明这个节点，否则这里会被静默拦掉。
  */
  const wrapBrand = host.registerExtension?.('shell-brand-text', BrandBadge, { mode: 'wrap' })
  if (wrapBrand) disposers.push(wrapBrand)
  return () => {
    for (const off of disposers) off()
  }
}
