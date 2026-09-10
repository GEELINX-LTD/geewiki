/**
 * `useSlowHint` —— 加载"慢"的提示（纯计时，无依赖）。
 *
 * 行为：组件挂载（或 `active` 变 true）后开始计时，超过 `delayMs` 仍未结束则返回 `true`。
 * 用于把加载文案从"正在加载…"换成"仍在加载…"，让用户知道没有卡死。
 *
 * 为什么**不用**进度条/取消按钮：进度需要后端上报进度（我们没有），取消需要可中断的请求
 * 编排（本仓库的 `fetch` 未接 AbortSignal 的通用通道）。给一个做不到的 UI 比不给更糟——
 * 用户会以为能取消。等真有需求再补。
 *
 * 计时器在卸载/结束时**必须清掉**：否则快速切换路由会留下僵尸定时器（React 会在已卸载
 * 组件上 setState，虽然 18+ 不再警告，但仍是泄漏）。
 */
import { useEffect, useState } from 'react'

export function useSlowHint(active: boolean, delayMs = 4000): boolean {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), delayMs)
    return () => clearTimeout(t)
  }, [active, delayMs])

  return slow
}
