/**
 * **站点主页的共享缓存**（模块级 store + `useSyncExternalStore` 订阅）。
 *
 * ## 为什么需要它（本文件存在的直接动因）
 * "本站主页是哪一篇"在主页批之前是**编译期常量**（`wikiRoute.ts` 的 `HOME_SLUG`），
 * 现在变成一处站点设置，于是它同时被这些人需要：
 *   · `WikiPage` 的主页路由 —— 决定 `#/wiki` 渲染哪一篇；
 *   · `WikiPage` 的「全部页面」—— 决定哪一行挂「主页」徽标、哪个按钮显示为已设；
 *   · `AppDock`（AI 对话）—— 决定告诉模型"当前页是 `<slug>`"时用哪个 slug；
 *   · `App.tsx` 的"最近访问" —— 决定 `#/wiki` 该记成哪一篇。
 * 四处各发一次请求、各存一份，就是 `pagesStore` 头注里记过的那类缺陷（不一致 + 重复请求），
 * 故与页面列表一样收进一个模块级 store。
 *
 * ## 为什么**不**并进 `pagesStore`
 * 两者是**不同来源、不同生命周期**的东西：页面列表是"整站可见页面"的大响应，主页是
 * 单行设置。`AppDock` 只想知道主页 slug，却会因此背上一份整站页面列表的请求
 * （它在**所有已登录页面**上常驻，包括 `#/plugins`、`#/org` 这些与 wiki 无关的台面页）。
 *
 * ## 与 `pagesStore` 同一套设计要点
 * - **并发去重**：同时挂载的若干个订阅者只发一次请求（复用同一个 in-flight Promise）；
 * - **显式失效**：`invalidateHome()` 清缓存并立即重取，写完主页后调用；
 * - **失败不缓存**：失败不写入 `home`，只置 `error`，订阅者据此显示并可重试；
 * - **卸载安全**：订阅随组件卸载自动退订，不会对已卸载组件 setState。
 *
 * ## 一个已知代价（如实记录）
 * `#/wiki` 冷加载时，"渲染哪一篇"依赖本 store 的结论，于是正文请求要**等它一次**
 * （此前 slug 是常量，正文请求立刻就能发）。它是一次单行读、且与 `App` 的鉴权请求
 * 并发，实测不额外多一个串行往返；换来的是"站点主页可换"这件事在四个消费点上
 * 只有一个真源。若日后要为此优化，正确的方向是把主页 slug 搭在启动引导的响应里，
 * 而不是让各消费点各猜一个默认值。
 *
 * ## 旧后端（没有这个端点）的兜底
 * 见 `loadHome` 的 catch：**只**把 404 当成"未设置"（那正是本批之前的行为），
 * 其余失败照旧呈现为错误。老前端 + 新后端、新前端 + 老后端两种混跑都不会白屏。
 */
import { errorLine } from './errorText'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, ApiError, type SiteHome } from '../api'

export interface HomeState {
  /**
   * 服务端的三态；`null` 表示**还没有结论**（首次加载中，或上次请求失败）。
   *
   * ⚠️ 消费方**不得**把 `null` 当成"未设置"：那等于在还没问到答案时按约定 slug 渲染，
   * 一旦设置的是另一篇，就会先显示一篇错的、再换成对的（正是本仓拒绝的"闪一下换了东西"）。
   */
  home: SiteHome | null
  /** 给人看的错误行（`errorLine`），未失败时为 null */
  error: string | null
  /**
   * 原始错误值（未经加工）。分类（连不上服务 / 服务出错）要看 `status` 或是否 `TypeError`，
   * 那些信息在 `error` 字符串里已经丢了，故与 `pagesStore` 一样另存一份供 `describeError()`。
   */
  errorValue?: unknown
  /** 首次加载中（`home === null && error === null`） */
  loading: boolean
}

const EMPTY: HomeState = { home: null, error: null, errorValue: null, loading: true }

let state: HomeState = EMPTY
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function setState(next: HomeState): void {
  state = next
  emit()
}

/**
 * 拉取（或复用进行中的）站点主页设置。
 *
 * 返回的 Promise 在**本次请求结算**后 resolve（无论成功失败），调用方可 `await` 它来保证
 * "写完再读"的顺序；失败信息通过 {@link HomeState.error} 暴露而非 reject ——
 * 消费方都只想"把主页渲染出来"，不该为一次设置读取中断整页渲染。
 */
export function loadHome(options: { force?: boolean } = {}): Promise<void> {
  if (inflight !== null) return inflight
  if (options.force !== true && state.home !== null) return Promise.resolve()

  if (state.home === null) {
    // 首次加载显示 loading；已有结论时的静默刷新不闪骨架屏
    setState({ home: null, error: null, errorValue: null, loading: true })
  }

  inflight = api
    .siteHome()
    .then((r) => {
      setState({ home: r, error: null, errorValue: null, loading: false })
    })
    .catch((e: unknown) => {
      /*
       * ★ **旧后端的兼容口径**：`GET /api/site/home` 在**本批之前的后端**上根本不存在，
       * 请求会拿到 404（`{ok:false,error:'not_found',path:…}`）。那**不是**失败，
       * 而是"这个后端还没有主页设置" ⇒ 按 `unset` 处理，落点回落约定 slug `home`，
       * 与本批之前**逐字节一致**。
       *
       * 为什么必须这样：前端产物与后端在开发形态下是两个进程（Vite 热更新 + 需要重启的
       * 后端），在生产形态下也可能被分开部署。若把 404 当错误，`#/wiki`——**全站默认落点**——
       * 会直接变成一块"内容不存在或已被删除 / 请求失败 (404)"，而真正的原因只是
       * "一个新端点还没上线"。这与仓里既有做法一致（如 `runtimeDisabled?` 的
       * "旧版本后端不返回该字段，消费处一律兜底"）。
       *
       * 只对 **404** 兜底：其它状态码（5xx、网络不可达）是真失败，照旧按错误呈现 ——
       * 把它们也吞成"未设置"才是真的在撒谎（那会让主页静默指向约定 slug）。
       */
      if (e instanceof ApiError && e.status === 404) {
        console.debug('[geewiki-home] 后端没有 /api/site/home（旧版本），按"未设置主页"处理')
        setState({ home: { ok: true, state: 'unset' }, error: null, errorValue: null, loading: false })
        return
      }
      // 与 pagesStore 同一条口径：`error` 存人话（它会被插进 JSX），原始值另存
      const human = errorLine(e)
      console.debug('[geewiki-home] 站点主页设置加载失败：', e instanceof Error ? e.message : e)
      // 失败不保留旧结论：宁可显示"重试"，也不要拿过期的 slug 渲染一篇可能已经换掉的主页
      setState({ home: null, error: human, errorValue: e, loading: false })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/**
 * 使缓存失效并立即重取。**写完主页设置后必须调用**（否则徽标与 `#/wiki` 的落点会停在旧值）。
 *
 * 与 `pagesStore.invalidatePages()` 同一条命名理由：调用点读起来是"我改了数据"，
 * 而不是"我要求刷新"。
 */
export function invalidateHome(): Promise<void> {
  return loadHome({ force: true })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): HomeState {
  return state
}

/**
 * 订阅站点主页设置。**首次挂载会自动触发一次加载**（若尚无结论或上次失败）。
 *
 * 与 `usePages()` 一样用 `useEffect` 而不是在 render 期调用：render 期发请求会在
 * StrictMode 的双次渲染下打两次（`inflight` 去重能兜住，但"在 render 里产生副作用"
 * 本身就是错的）。依赖数组为空——加载只与"缓存是否已有结论"有关。
 */
export function useHome(): HomeState & { reload: () => void } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    // 失败时不自动重试（避免失败风暴）；重试由用户显式 `reload()` 触发。
    if (state.home === null && state.error === null) void loadHome()
  }, [snap.home, snap.error])
  const reload = useCallback(() => {
    void invalidateHome()
  }, [])
  return { ...snap, reload }
}

/**
 * 仅供测试：读当前快照（生产代码请用 `useHome()` 订阅 —— 直接读 state 不会重渲染）。
 */
export function __homeStateForTest(): HomeState {
  return state
}

/**
 * 仅供测试：把 store 复位到初始态。
 * 生产代码**不要**调用——它会丢掉别人的 in-flight 结果。
 */
export function __resetHomeStoreForTest(): void {
  state = EMPTY
  inflight = null
  listeners.clear()
}
