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

/**
 * **顶层注册演示件**（P13）：证明加载期间的全局 SDK 归属于本插件。
 *
 * 下面那段代码在**模块求值期**执行（宿主还没调到 `register(host)`），它只能通过
 * `window.__GEEWIKI_HOST__` 拿宿主 —— 这就是"顶层形态"的 bundle。P13 之前这条路的来源恒为
 * `'host-sdk'`：插件停用后这个标记**不会消失**（`unloadPluginUi` 只执行自己的 disposer），
 * 且完全不经过两道越权闸门。现在它与 `register(host)` 形态拿到的是同一个对象。
 */
function TopLevelMarker(): ReactNode {
  return (
    <span className="gw-fixture-widget" data-fixture="toplevel">
      顶层注册
    </span>
  )
}

/*
  只在 `@geewiki-plugin/ui-demo` 名下注册：同一份夹具会被构建到另外几个产物里
  （`@geewiki-plugin/hello`、`@geewiki/editor-plain`），不加这个判断会连带污染它们。
  判据用 `pluginName`——它是**作用域宿主独有**的字段，顺带证明它在模块求值期就可用
  （宿主装上作用域之后才 `import()` 本模块，见 `pluginUi.ts` 的 `installPluginScope`）。
*/
const hostAtEval = (globalThis as { __GEEWIKI_HOST__?: PluginUiHost }).__GEEWIKI_HOST__
if (hostAtEval?.pluginName === '@geewiki-plugin/ui-demo') {
  hostAtEval.registerSlot('app-header', TopLevelMarker)
}

/** 宿主加载器调用约定：bundle 导出 register(host)，可返回清理函数 */
export function register(host: PluginUiHost): () => void {
  const disposers = [
    host.registerSlot('app-header', () => <CounterWidget label={host.pluginName} />),
    host.registerSlot('app-footer', () => <ThrowerWidget label={host.pluginName} />),
  ]
  /*
    P12 演示：**带模式**的注册走受限宿主（`registerExtension` 的 `mode`）。
    注（P13）：曾经这里还有第二层理由——"用全局 SDK 直接注册的来源是 `host-sdk`，收不回"。
    现在加载期间的全局对象**就是**这个宿主，两种形态归属一致，区别只剩作者写了哪一种。
  */
  const wrapBrand = host.registerExtension?.('shell-brand-text', BrandBadge, { mode: 'wrap' })
  if (wrapBrand) disposers.push(wrapBrand)
  return () => {
    for (const off of disposers) off()
  }
}
