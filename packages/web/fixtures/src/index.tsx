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

/** 宿主加载器调用约定：bundle 导出 register(host)，可返回清理函数 */
export function register(host: PluginUiHost): () => void {
  const disposers = [
    host.registerSlot('app-header', () => <CounterWidget label={host.pluginName} />),
    host.registerSlot('app-footer', () => <ThrowerWidget label={host.pluginName} />),
  ]
  return () => {
    for (const off of disposers) off()
  }
}
