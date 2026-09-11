/**
 * **登录态的共享 store**（模块级 store + `useSyncExternalStore` 订阅）。
 *
 * 形态**刻意照抄 `lib/pagesStore.ts`**：同样的"一次取、多订阅、显式失效"三件事，
 * 同样不引入 react-query / SWR（本仓库"零 UI 框架依赖"的基调，见该文件头部说明）。
 * 两个 store 的差异只有一点：本 store 的失效**必须连带清掉页面列表缓存** —— 见下。
 *
 * **为什么登录/登出后必须 `invalidatePages()`**（设计文档 §9 R5）：
 * `pagesStore` 是**模块级全局缓存**，它缓存的是"上一个身份能看到的页面列表"。
 * 登录后不失效 ⇒ 新身份可能复用匿名时的列表；登出后不失效 ⇒ 下一个使用者
 * 可能看到上一个身份的列表。这是前端侧最严重的越权残留，且**没有任何报错**。
 *
 * 数据源只有一个：`GET /api/auth/state`（公共端点，未登录时正常返回 `user: null`）。
 * 之所以不额外调 `GET /api/auth/me`：后者是 `access:'user'`，匿名必然 401，
 * 而 401 会被统一出口当成"会话失效"处理 ⇒ 每个匿名访客冷启动都会触发一次无谓跳转。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, setAuthFailureHandler, type AuthCapabilities, type AuthUser } from '../api'
import { errorLine } from './errorText'
import { invalidatePages } from './pagesStore'

export type { AuthCapabilities, AuthUser }

export interface AuthState {
  user: AuthUser | null
  capabilities: AuthCapabilities | null
  /** `null` = 尚未知（首帧）；`true` = 库里还没有任何可登录账号，应去 #/setup */
  setupRequired: boolean | null
  authenticated: boolean
  loading: boolean
  /** 人话错误（已清洗），供界面直接显示 */
  error: string | null
  /** 原始错误值，供 `describeError()` 分级（连不上 / 5xx / …） */
  errorValue?: unknown
}

const EMPTY: AuthState = {
  user: null,
  capabilities: null,
  setupRequired: null,
  authenticated: false,
  loading: true,
  error: null,
  errorValue: null,
}

let state: AuthState = EMPTY
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function setState(next: AuthState): void {
  state = next
  emit()
}

/** 把 store 复位成"匿名且未知"（登出、401 后调用）。**不清 `setupRequired`** —— 那是环境事实，与身份无关。 */
function resetToAnonymous(keepSetupFlag = true): void {
  setState({
    ...EMPTY,
    setupRequired: keepSetupFlag ? state.setupRequired : null,
    loading: false,
  })
}

/* --------------------------- 跳转副作用 --------------------------- */

function navigate(hash: string): void {
  // 已经在该路由上就不要重复赋值：赋同名 hash 不触发 hashchange，但会污染历史栈判断
  if (window.location.hash !== `#${hash}`) window.location.hash = hash
}

/**
 * 注册全局认证失败出口。
 *
 * **在模块加载时注册一次**（不是组件里）：`request()` 可能在任意页面被调用，
 * 而"401 该跳登录"这件事与"当前挂载了哪个组件"无关。
 * 注册点是 `authStore` 而不是 `api.ts` 自身，是为了避免 `api → store → api` 的循环依赖：
 * `api.ts` 只暴露一个可注册的回调，谁想处理谁注册。
 */
setAuthFailureHandler((action) => {
  if (action.kind === 'login') {
    // 先清身份缓存再跳：否则登录页首帧会短暂显示"已登录"的旧身份
    resetToAnonymous()
    navigate(`/login?redirect=${encodeURIComponent(action.redirect)}`)
    return
  }
  if (action.kind === 'denied') {
    navigate('/denied')
    return
  }
  if (action.kind === 'setup') {
    setState({ ...state, setupRequired: true, loading: false })
    navigate('/setup')
  }
})

/* ----------------------------- 读取 ----------------------------- */

/**
 * 拉取（或复用进行中的）登录态。
 *
 * 与 `pagesStore.loadPages` 同构：并发去重、失败不缓存、失败不自动重试。
 * `force` 用于登录/登出/初始化之后——那几处**必须**拿到最新身份。
 */
export function loadAuth(options: { force?: boolean } = {}): Promise<void> {
  if (inflight !== null) return inflight
  if (options.force !== true && state.setupRequired !== null) return Promise.resolve()

  if (state.setupRequired === null) {
    setState({ ...EMPTY, loading: true })
  }

  inflight = api
    .authState()
    .then((r) => {
      setState({
        user: r.user,
        capabilities: r.capabilities,
        setupRequired: r.setupRequired,
        authenticated: r.authenticated,
        loading: false,
        error: null,
        errorValue: null,
      })
    })
    .catch((e: unknown) => {
      const human = errorLine(e)
      console.debug('[geewiki-auth] 登录态加载失败：', e instanceof Error ? e.message : e)
      setState({ ...EMPTY, setupRequired: null, loading: false, error: human, errorValue: e })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** 使登录态失效并立即重取 */
export function invalidateAuth(): Promise<void> {
  return loadAuth({ force: true })
}

/* ----------------------------- 写入 ----------------------------- */

/**
 * 登录。成功后：
 * 1. 强制重取登录态（不信任本地推断的"应该有身份了"）；
 * 2. **`invalidatePages()`** —— 匿名时的页面列表缓存必须作废（见文件头）。
 */
export async function login(email: string, password: string): Promise<void> {
  await api.authLogin(email, password)
  await loadAuth({ force: true })
  await invalidatePages()
}

/** 首次初始化：创建首个账号并自动登录 */
export async function setup(email: string, password: string, displayName?: string): Promise<void> {
  await api.authSetup(email, password, displayName)
  await loadAuth({ force: true })
  await invalidatePages()
}

/**
 * 登出。**先服务端吊销、再清本地** —— 顺序不能反：
 * 反了的话，若吊销请求失败，本地已经忘了自己是谁，用户会以为登出了而服务端会话仍然有效。
 */
export async function logout(): Promise<void> {
  try {
    await api.authLogout()
  } finally {
    resetToAnonymous()
    // 登出后必须清页面列表缓存：否则下一个人（或匿名）会看到上一个身份的列表
    await invalidatePages()
  }
}

/* ----------------------------- 订阅 ----------------------------- */

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): AuthState {
  return state
}

/** 订阅登录态。首次挂载会自动加载一次（若尚未知）。 */
export function useAuth(): AuthState & { reload: () => void } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    if (state.setupRequired === null && state.error === null) void loadAuth()
  }, [snap.setupRequired, snap.error])
  const reload = useCallback(() => {
    void invalidateAuth()
  }, [])
  return { ...snap, reload }
}

/** 仅供测试：复位到初始态。生产代码不要调用。 */
export function __resetAuthStoreForTest(): void {
  state = EMPTY
  inflight = null
  listeners.clear()
}
