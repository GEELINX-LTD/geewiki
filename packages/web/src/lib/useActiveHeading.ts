/**
 * 滚动时高亮当前小节 —— 基于 `IntersectionObserver`。
 *
 * 为什么不用 `scroll` 事件 + `getBoundingClientRect`：
 * - scroll 回调在滚动期间**每帧都可能触发**（即使加了 rAF 节流，也仍然在做布局读取）；
 * - IntersectionObserver 由浏览器在合成阶段批量通知，**不阻塞滚动**，且在"快速滚动到
 *   底/锚点跳转/程序化滚动"等场景同样可靠。
 *
 * ## 这里踩过的坑（务必保留这段说明）
 * 第一版把 `document.getElementById(id)` 的结果**存在闭包里**，只在 effect 建立时查一次。
 * 实测（headless Chrome + 真实 CDP）第二个 IO 回调里这些节点**已全部脱离文档**
 * （`isConnected === false`、`getClientRects().length === 0`）——正文是经
 * `dangerouslySetInnerHTML` 注入的，React 在后续渲染中会**替换掉这些节点**。
 * 而脱离文档的节点，`getBoundingClientRect()` **一律返回 0**，于是"每个标题的 top 都是 0"
 * ⇒ 判定逻辑认为"所有标题都在判定线之上" ⇒ 高亮**永远停在最后一个标题**
 * （实测现象：无论怎么滚动都高亮「结语」，而页内复算同一条判定却给出「快速开始」）。
 *
 * 因此本 Hook 有四条硬约束：
 * 1. **每次重算都重新查询节点**（`getElementById` 拿到的永远是当前那一份）；
 * 2. **过滤掉未连接 / 未渲染的节点**（`isConnected` 与 `getClientRects().length`），
 *    避免用一堆 0 去参与判定；
 * 3. **改观察新节点**：节点被替换后旧的观察对象已无意义，必须换成新的
 *    （只 observe "新出现的"，不会造成 observe→callback→observe 的无限循环）；
 * 4. **一个可用节点都没有时保持上一次的值**（正文还没渲染），不要用无效测量覆盖它。
 */
import { useEffect, useState } from 'react'
import { pickActiveHeading } from './headingPlan'

/** 顶栏高度（与 tokens 的 `--spacing-header` 一致）+ 余量：判定"已越过"的线 */
const HEADER_OFFSET = 56 + 24

/** 元素是否"真的在页面上"（已连接且至少有一个盒）——脱离文档或 display:none 都会是 0 尺寸 */
function isRenderable(el: HTMLElement | null): el is HTMLElement {
  return el !== null && el.isConnected && el.getClientRects().length > 0
}

export function useActiveHeading(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  // 用字符串当依赖：数组每次渲染都是新引用，直接放进依赖会导致无限重订阅
  const fingerprint = ids.join('\u0000')

  useEffect(() => {
    const idList = fingerprint === '' ? [] : fingerprint.split('\u0000')
    if (idList.length === 0) {
      setActive(null)
      return
    }

    /** 当前正在被观察的节点（节点可能被 React 替换，故需要同步） */
    const observed = new Set<HTMLElement>()

    const currentElements = (): HTMLElement[] =>
      idList.map((id) => document.getElementById(id)).filter(isRenderable)

    const syncObserved = (els: readonly HTMLElement[]): void => {
      const next = new Set(els)
      for (const el of observed) {
        if (!next.has(el)) {
          observer.unobserve(el)
          observed.delete(el)
        }
      }
      for (const el of next) {
        if (!observed.has(el)) {
          observer.observe(el)
          observed.add(el)
        }
      }
    }

    const recompute = (): void => {
      const els = currentElements()
      if (els.length === 0) return // 正文尚未渲染：保留上一次的值，别用无效测量覆盖
      syncObserved(els)
      // `els` 本身就是按 idList（文档顺序）映射出来的，顺序天然正确
      const positions = els.map((el) => ({ id: el.id, top: el.getBoundingClientRect().top }))
      setActive(pickActiveHeading(positions, HEADER_OFFSET))
    }

    const observer = new IntersectionObserver(recompute, {
      rootMargin: `-${HEADER_OFFSET}px 0px -65% 0px`,
      threshold: [0, 1],
    })
    recompute() // 首帧先算一次，避免"未滚动时不高亮"

    return () => {
      observer.disconnect()
      observed.clear()
    }
  }, [fingerprint])

  return active
}
