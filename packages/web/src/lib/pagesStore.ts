/**
 * **页面列表的共享缓存**（模块级 store + `useSyncExternalStore` 订阅）。
 *
 * 为什么需要它（本文件存在的直接动因）：
 * 详情页为了算"上一篇/下一篇"会自己去 `GET /api/pages`，侧边栏要画树也得有同一份列表——
 * 于是"每打开一页就重拉一次整张表"，且两处各拿一份、可能不一致。页面越多越浪费，
 * 而这个数据**变更频率极低**（只有保存/删除/改标识才会变），是典型的"该缓存"。
 *
 * 为什么不用 react-query / SWR：本仓库有"零 UI 框架依赖"的基调，且这里的需求只有
 * "一次取、多订阅、显式失效"三件事——一个 60 行的 store 就够，引入运行时依赖不值。
 *
 * 设计要点：
 * - **并发去重**：同时挂载侧边栏与详情页只会发一次请求（第二个调用复用同一个 in-flight Promise）。
 * - **显式失效**：`invalidatePages()` 清缓存并**立即重取**；写操作（保存/删除/恢复版本）后调用。
 * - **失败不缓存**：请求失败不写入缓存，下次调用会重试；订阅者收到 `error` 以便显示。
 * - **卸载安全**：`useSyncExternalStore` 的订阅在组件卸载时自动退订，不会对已卸载组件 setState。
 */
import { errorLine } from './errorText'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type NavOrderGroup, type PageSummary } from '../api'

export interface PagesState {
  pages: PageSummary[] | null
  /**
   * 同级顺序（父级 → item 列表）。与 `pages` 同一次请求下发、同一份缓存：
   * 侧栏与「全部页面」必须按同一个顺序渲染，分两次取会出现"顺序是旧的、隐藏是新的"。
   */
  navOrder: readonly NavOrderGroup[]
  error: string | null
  /**
   * 原始错误值（未经加工的 thrown 值）。`error` 是给人看的字符串，而**分类**（连不上服务/
   * 不存在/服务出错）需要看 `status` 或是否 `TypeError`，那些信息在字符串里已经丢了——
   * 故额外保留原始值供 `lib/errorText.ts` 的 `describeError()` 使用。
   * 可选字段，向后兼容（既有消费者只读 `error`）。
   */
  errorValue?: unknown
  /** 首次加载中（`pages === null && error === null`）*/
  loading: boolean
}

const EMPTY: PagesState = { pages: null, navOrder: [], error: null, errorValue: null, loading: true }

let state: PagesState = EMPTY
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function setState(next: PagesState): void {
  state = next
  emit()
}

/**
 * 拉取（或复用进行中的）页面列表。
 *
 * 返回的 Promise 在**本次请求结算**后 resolve（无论成功失败），调用方可 `await` 它来
 * 保证"写完再读"的顺序；失败信息通过 {@link PagesState.error} 暴露而非 reject，
 * 因为调用方（侧边栏 / 上一篇下一篇）都只想"尽力显示"，不该为此中断整页渲染。
 */
export function loadPages(options: { force?: boolean } = {}): Promise<void> {
  if (inflight !== null) return inflight
  if (options.force !== true && state.pages !== null) return Promise.resolve()

  if (state.pages === null) {
    // 首次加载显示 loading；已有数据时的静默刷新不闪骨架屏
    setState({ pages: null, navOrder: [], error: null, errorValue: null, loading: true })
  }

  inflight = api
    .pages()
    .then((r) => {
      setState({ pages: r.pages, navOrder: r.nav_order, error: null, errorValue: null, loading: false })
    })
    .catch((e: unknown) => {
      /*
        `error` 存的是**人话**（`errorLine`），不是原始 message——因为它是"是否失败"的
        信号 + 曾经被下游直接插进 JSX 的显示文本。原始值另存 `errorValue`，供
        `describeError` 分级（404 / 5xx / 连不上）与排障使用。
        这是整条泄漏链的源头：这里若存原文，侧栏与页头就会把它原样印出来。
      */
      const human = errorLine(e)
      console.debug('[geewiki-pages] 页面列表加载失败：', e instanceof Error ? e.message : e)
      // 失败时**不保留旧数据也不写缓存**：让 UI 能显示错误并允许重试
      setState({ pages: null, navOrder: [], error: human, errorValue: e, loading: false })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/**
 * 使缓存失效并立即重取。**所有写操作后都应调用**（保存、删除、恢复版本、改标识）。
 *
 * 单独暴露 `invalidate` 而不是让调用方传 force：调用点读起来是"我改了数据"，
 * 而不是"我要求刷新"——前者才是真正的意图。
 */
export function invalidatePages(): Promise<void> {
  return loadPages({ force: true })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PagesState {
  return state
}

/**
 * 订阅页面列表。**首次挂载会自动触发一次加载**（若尚无数据或上次失败）。
 *
 * 注意这里必须用 `useEffect` 而不是在 render 期调用：render 期发请求会在
 * StrictMode 的双次渲染下打两次（虽然 `inflight` 去重能兜住，但"在 render 里产生副作用"
 * 本身就是错的）。依赖数组为空——加载只与"缓存是否已有数据"有关，与组件无关；
 * 缓存已有数据时 `loadPages()` 内部会直接返回，不会重复请求。
 */
export function usePages(): PagesState & { reload: () => void } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    // 失败时不自动重试（避免失败风暴）；重试由用户显式 `reload()` 触发。
    // 判据用 ref 之外的状态：`state.pages === null && state.error === null` 即"从未成功且未失败"。
    if (state.pages === null && state.error === null) void loadPages()
  }, [snap.pages, snap.error])
  const reload = useCallback(() => {
    void invalidatePages()
  }, [])
  return { ...snap, reload }
}

/**
 * 仅供测试：把 store 复位到初始态（清缓存、清订阅者之外的内部状态）。
 * 生产代码**不要**调用——它会丢掉别人的 in-flight 结果。
 */
export function __resetPagesStoreForTest(): void {
  state = EMPTY
  inflight = null
  listeners.clear()
}
