/**
 * 账号页（`#/account`）：**核心只负责"本地口令"这一件属于它的事**。
 *
 * 为什么单独一页而不是塞进登录页或顶栏下拉：绑定外部身份需要"已登录的本地会话"
 * （设计文档 §7.2 禁止按 email 自动绑定），所以它天然是"登录之后"的动作。
 *
 * ★ 2026-09-16 的重划（用户指出）：这一页此前把**外部身份（SSO）的界面**也写死在宿主里
 * ——绑定确认卡片、"在登录页选择企业 SSO…"的空态、解绑列表。于是在**没装任何 SSO 提供者**的
 * 部署里，用户照样看到一个讲企业 SSO 的空态：**一个指向不存在功能的界面**。
 *
 * 现在的归属：
 * - 身份端点（`/api/auth/identities*`）由 `@geewiki/auth` 提供（机制，始终可用）；
 * - 而**界面**由"谁提供外部身份谁负责"——通过宿主插槽 `account-identities` 贡献，
 *   当前是 `@geewiki/oidc`。没装该插件 ⇒ 这里什么都不显示，页面只剩「本地口令」。
 * 宿主因此**不再认识"身份"这个概念**（连类型都不 import），这正是插槽存在的意义。
 *
 * 时间显示、绑定票据的流向（`HttpOnly` cookie，前端拿不到）、解绑的服务端兜底
 * （409 `last_credential`）都随界面一起交给插件了。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingState } from '../ui'
import { api } from '../api'
import { useAuth } from '../lib/authStore'
import { AccountIdentitiesSlotOutlet } from '../lib/slots'
import { ensureSlotLoaded } from '../lib/pluginUi'

/**
 * 从 `#/account?link=required` 取参数。
 *
 * 为什么由宿主读（而不是让插件读 `window.location`）：这个提示属于**路由**，路由归宿主；
 * 插件是独立构建的产物，守卫明令禁止它碰 `location`。宿主读、当 prop 传下去（见
 * `AccountIdentitiesSlotProps`）。
 */
function wantsLinkConfirm(): boolean {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) return false
  return new URLSearchParams(raw.slice(queryStart + 1)).get('link') === 'required'
}

/** 本页的加载状态（与 wiki 页的 `resolveAreaState` 同思路：四态互斥） */
type View = { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'ready'; hasPassword: boolean }

export function AccountPage(): ReactNode {
  const auth = useAuth()
  const [view, setView] = useState<View>({ kind: 'loading' })
  // 初值在挂载时读一次：提示属于"这次回跳"，用户点掉之后不该被渲染期的读取重新翻出来
  const [linkPending, setLinkPending] = useState(() => wantsLinkConfirm())

  // 未登录不该停在这一页：带上回跳参数去登录页
  useEffect(() => {
    if (auth.setupRequired === true) window.location.hash = '/setup'
    else if (!auth.loading && !auth.authenticated) {
      window.location.hash = '/login?redirect=%2Faccount'
    }
  }, [auth.loading, auth.authenticated, auth.setupRequired])

  /*
   * 按需加载插槽产物：账号页是**唯一**用到 `account-identities` 的视图，
   * 不该让匿名读者与其它页面为它下载一份 SSO 界面（`ON_DEMAND_SLOTS` 的口径）。
   * 失败不提示：没有提供者时"没人贡献这块界面"是正常状态，不是错误。
   */
  useEffect(() => {
    void ensureSlotLoaded('account-identities').catch(() => {})
  }, [])

  /*
   * 路由提示可能在挂载之后才到达（SSO 回跳改写 hash、或用户前进/后退）⇒ 订阅一次。
   * 只往"显示"方向同步：新 hash 里没有该参数时什么都不做，不会把用户点掉的
   * 「稍后再说」重新翻出来（"点掉"的状态在插件里，宿主看不见也不需要看见）。
   */
  useEffect(() => {
    const sync = (): void => {
      if (wantsLinkConfirm()) setLinkPending(true)
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setView({ kind: 'loading' })
    try {
      /*
       * 只取 `hasPassword`：名单留给插件自己取。同一个端点被取两次是可以接受的代价——
       * 换来的是宿主不必认识"外部身份"这个概念（见文件头）。
       */
      const r = await api.authIdentities()
      setView({ kind: 'ready', hasPassword: r.hasPassword })
    } catch (error) {
      setView({ kind: 'error', error })
    }
  }, [])

  useEffect(() => {
    if (auth.authenticated) void reload()
  }, [auth.authenticated, reload])

  if (!auth.authenticated) return <LoadingState label="正在检查登录状态…" />

  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">账号</h1>

      <Card>
        <CardHeader title="本地口令" description="用邮箱与口令登录这个账号" />
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-note text-muted">本地口令</span>
            {view.kind === 'ready' ? (
              <Badge tone={view.hasPassword ? 'ok' : 'warn'}>{view.hasPassword ? '已设置' : '未设置'}</Badge>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </div>
          {view.kind === 'loading' && <LoadingState label="正在加载登录方式…" />}
          {view.kind === 'error' && (
            <ErrorState
              title="加载登录方式失败"
              hint={
                typeof view.error === 'object' && view.error !== null && 'message' in view.error
                  ? String((view.error as { message: unknown }).message)
                  : '操作失败，请重试。'
              }
              onRetry={() => void reload()}
            />
          )}
        </CardBody>
      </Card>

      {/*
        外部身份（SSO）：**由提供者插件贡献**。没装提供者时这里没有任何输出——
        宿主不再替一个不存在的功能写介绍文案（这正是本次重划要消灭的东西）。
      */}
      <AccountIdentitiesSlotOutlet linkPending={linkPending} />
    </div>
  )
}
