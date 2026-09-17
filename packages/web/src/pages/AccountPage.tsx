/**
 * 账号页（`#/account`）：**本地凭据这一侧归宿主**（邮箱 / 用户名 / 密码），
 * **外部身份那一侧归提供者插件**（`account-identities` 插槽）。
 *
 * ## 2026-09-17 的补齐（本页此前只有"状态"，没有"操作"）
 *
 * 本页原先是：一张「本地密码」卡片只显示 `已设置 / 未设置` 徽标，外加 SSO 插槽。
 * 也就是说 **`POST /api/auth/password` 与后来新增的 `POST /api/auth/profile`
 * 两个端点都没有任何界面入口** —— 用户根本无法在这里改密码（`api.authChangePassword`
 * 在全仓的调用者数量是 **0**）。这与"审计页那四个端点"是同一类问题：
 * 后端能力齐了、前端没接上，而它**不会报错**，只是"这个功能不存在"。
 *
 * 现在补成两张卡片：
 * 1. **资料** —— 邮箱（登录标识符）与用户名，改它们必须**验当前密码**；
 * 2. **本地密码** —— 改密码（原端点，现在真的接上了）。
 *
 * ## 为什么"改资料"要单独输一次密码，而不是复用登录态
 *
 * 邮箱是**登录标识符**：只凭一个会话 cookie 就能改它的话，一个被盗的会话
 * （或一台没锁屏的机器）等于账号接管 —— 攻击者把邮箱改成自己的就完成了。
 * 要求当前密码把这一步重新绑回"知道凭据的人"。理由与判据在服务端那份
 * （`packages/plugin-auth/src/index.ts` 的 `POST /api/auth/profile`）写得更全。
 *
 * ## 归属（2026-09-16 的重划，仍然有效）
 *
 * 身份端点（`/api/auth/identities*`）由 `@geewiki/auth` 提供（机制，始终可用）；
 * 而**界面**由"谁提供外部身份谁负责" —— 通过宿主插槽 `account-identities` 贡献，
 * 当前是 `@geewiki/oidc`。没装该插件 ⇒ 这里什么都不显示。
 * 宿主因此**不再认识"身份"这个概念**（连类型都不 import）。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, ErrorNotice, ErrorState, Input, LoadingState } from '../ui'
import { api } from '../api'
import { useAuth } from '../lib/authStore'
import { AccountIdentitiesSlotOutlet } from '../lib/slots'
import { ensureSlotLoaded } from '../lib/pluginUi'

/** 后端 `PASSWORD_MIN`（`packages/plugin-auth/src/index.ts`）：前后端各持一份，改后端时必须同步 */
const PASSWORD_MIN = 8

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

  // 资料表单（初值来自 store，加载完成后同步一次 —— 见下面的 useEffect）
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [profilePassword, setProfilePassword] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileErr, setProfileErr] = useState<unknown>(null)
  const [profileNotice, setProfileNotice] = useState('')

  // 改密码表单
  const [curPwd, setCurPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdBusy, setPwdBusy] = useState(false)
  const [pwdErr, setPwdErr] = useState<unknown>(null)
  const [pwdNotice, setPwdNotice] = useState('')

  // 未登录不该停在这一页：带上回跳参数去登录页
  useEffect(() => {
    if (auth.setupRequired === true) window.location.hash = '/setup'
    else if (!auth.loading && !auth.authenticated) {
      window.location.hash = '/login?redirect=%2Faccount'
    }
  }, [auth.loading, auth.authenticated, auth.setupRequired])

  /*
   * 把 store 里的身份同步进表单。
   *
   * 依赖的是 `auth.user` **本身**而不是它的字段：store 刷新会换一个新对象，
   * 而"改完资料后表单要显示新值"正是靠这一次同步落地的（服务端返回的也是新值，
   * 但我们以 store 为唯一真源 —— 否则会出现"表单显示 A、顶栏显示 B"）。
   */
  useEffect(() => {
    if (auth.user === null) return
    setEmail(auth.user.email)
    setDisplayName(auth.user.displayName)
  }, [auth.user])

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

  const onProfile = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setProfileErr(null)
    setProfileNotice('')
    /*
     * 服务端把**空串**解释成"这一项不改"，所以这里必须先挡住"清空后提交"：
     * 否则用户会以为自己成功删掉了用户名，实际什么都没发生（静默无操作是最坏的一种反馈）。
     */
    if (email.trim() === '') {
      setProfileErr(new Error('邮箱不能为空'))
      return
    }
    if (displayName.trim() === '') {
      setProfileErr(new Error('用户名不能为空'))
      return
    }
    setProfileBusy(true)
    try {
      const r = await api.authProfile({
        currentPassword: profilePassword,
        email: email.trim(),
        displayName: displayName.trim(),
      })
      setProfilePassword('')
      // 以 store 为唯一真源：重载后顶栏与表单会一起变成新值
      await auth.reload()
      setProfileNotice(r.changed ? '已保存。' : '没有需要修改的内容。')
    } catch (err) {
      setProfileErr(err)
    } finally {
      setProfileBusy(false)
    }
  }

  const onPassword = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setPwdErr(null)
    setPwdNotice('')
    if (newPwd !== confirmPwd) {
      // 本地先挡一道：两次不一致是纯客户端可判定的事实，没必要打一次网络往返
      setPwdErr(new Error('两次输入的新密码不一致'))
      return
    }
    setPwdBusy(true)
    try {
      await api.authChangePassword(curPwd, newPwd)
      setCurPwd('')
      setNewPwd('')
      setConfirmPwd('')
      /*
       * 服务端会吊销**除当前会话外**的全部会话。如实说出来 —— 用户若在别的设备上还开着，
       * 那些会话此刻已经掉了，他有权知道原因。
       */
      setPwdNotice('密码已更新。其它设备上的登录已失效，需要重新登录。')
    } catch (err) {
      setPwdErr(err)
    } finally {
      setPwdBusy(false)
    }
  }

  if (!auth.authenticated) return <LoadingState label="正在检查登录状态…" />

  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">账号</h1>

      <Card>
        <CardHeader
          title="资料"
          description="邮箱是登录用的标识符；用户名只是显示名（可以重名，也不能用来登录）"
        />
        <CardBody>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onProfile(e)}>
            <label className="flex flex-col gap-1 text-xs text-muted">
              邮箱
              <Input
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={profileErr !== null}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              用户名
              <Input
                type="text"
                name="displayName"
                autoComplete="nickname"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                invalid={profileErr !== null}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              当前密码（确认是你本人在改）
              <Input
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                required
                value={profilePassword}
                onChange={(e) => setProfilePassword(e.target.value)}
                invalid={profileErr !== null}
              />
            </label>
            <ErrorNotice error={profileErr} role="alert" />
            {profileNotice !== '' && (
              <p role="status" className="m-0 text-note text-muted">
                {profileNotice}
              </p>
            )}
            <div>
              <Button
                type="submit"
                variant="primary"
                loading={profileBusy}
                disabled={email.trim() === '' || displayName.trim() === '' || profilePassword === ''}
              >
                保存资料
              </Button>
            </div>
            <p className="m-0 text-xs leading-relaxed text-muted">
改邮箱会让**下一次登录**用新邮箱；已经登录的会话不受影响。
            </p>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="本地密码" description="用邮箱与密码登录这个账号" />
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-note text-muted">本地密码</span>
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
          {/*
            只有**已经有本地密码**的账号才显示改密码表单：没有密码的账号（SSO 开户）
            点了会得到 401「当前密码不正确」—— 那是一个"看起来坏了"的正常结果，
            不该出现在界面上。
          */}
          {view.kind === 'ready' && view.hasPassword && (
            <form className="flex flex-col gap-3" onSubmit={(e) => void onPassword(e)}>
              <label className="flex flex-col gap-1 text-xs text-muted">
                当前密码
                <Input
                  type="password"
                  name="currentPassword"
                  autoComplete="current-password"
                  required
                  value={curPwd}
                  onChange={(e) => setCurPwd(e.target.value)}
                  invalid={pwdErr !== null}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                新密码（至少 {PASSWORD_MIN} 位）
                <Input
                  type="password"
                  name="newPassword"
                  autoComplete="new-password"
                  required
                  minLength={PASSWORD_MIN}
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  invalid={pwdErr !== null}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                再输一次新密码
                <Input
                  type="password"
                  name="confirmPassword"
                  autoComplete="new-password"
                  required
                  minLength={PASSWORD_MIN}
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  invalid={pwdErr !== null}
                />
              </label>
              <ErrorNotice error={pwdErr} role="alert" />
              {pwdNotice !== '' && (
                <p role="status" className="m-0 text-note text-muted">
                  {pwdNotice}
                </p>
              )}
              <div>
                <Button
                  type="submit"
                  variant="secondary"
                  loading={pwdBusy}
                  disabled={curPwd === '' || newPwd === '' || confirmPwd === ''}
                >
                  修改密码
                </Button>
              </div>
            </form>
          )}
        </CardBody>
      </Card>

      {/*
        外部身份（SSO）：**由提供者插件贡献**。没装提供者时这里没有任何输出——
        宿主不再替一个不存在的功能写介绍文案（这正是那次重划要消灭的东西）。
      */}
      <AccountIdentitiesSlotOutlet linkPending={linkPending} />
    </div>
  )
}