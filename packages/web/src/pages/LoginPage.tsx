/**
 * 登录页（`#/login`）。
 *
 * 四个必须处理好的点：
 * 1. **`redirect` 参数**：从哪被踢出来的就回哪去。参数来源是 `#/login?redirect=%2Fwiki%2Ffoo`
 *    ——hash 路由的查询串在 `App.tsx` 的 `useRoute()` 里被剥掉，所以这里直接解析
 *    `window.location.hash`。取值必须过 `normalizeRedirect()`（挡 `//evil.com` 这类外部地址）。
 * 2. **没有初始化时不该停在这一页**：库里还没有账号时登录必然失败，页面直接引导去 `#/setup`。
 *    这正是 503 `bootstrap_required` 与 401 必须分开的原因（见 `lib/authFailure.ts`）。
 * 3. **密码错误的提示来自本次提交**，而不是全局 401 出口 —— 全局出口会把
 *    "密码错"误当成"会话失效"再跳一次登录页，用户会看到页面刷新而错误消失。
 *    故 `api.ts` 对 `/api/auth/login` 这类"提交凭据"的端点**不触发**全局出口。
 * 4. **SSO（P1.5）是真实链接而不是按钮点击处理**：`<a href="/api/auth/oidc/start?…">`
 *    走完整导航，IdP 回跳才能落回本站；用 fetch 会因为跨站与 cookie 语义而失败。
 *    按钮**只在 `capabilities.oidc.available` 为真时出现** —— 未启用 OIDC 插件时
 *    `/api/auth/oidc/*` 根本不存在，渲染一个点了 404 的按钮比不渲染更糟。
 * 5. **SSO 不可用时【什么都不渲染】—— 包括"它为什么不可用"**。这里曾经有一条
 *    「SSO 不可用：已配置的单点登录当前无法连接（unreachable）」的告警，已删除。
 *    理由三条，缺一条都不足以删除它：
 *      a. **登录页面向的是匿名访客**。"你的 IdP 连不上"对他没有任何可操作性 ——
 *         他既不能修，也不知道那是什么；它只是把一次困惑换成了另一次困惑。
 *      b. **它向未认证的人暴露了内部配置状态**（"本站配了 SSO"本身就是一条信息），
 *         而这与账号页已经确立的原则冲突：那块界面已归还给提供者插件，
 *         "宿主连'外面有 SSO 这回事'都不再提"。
 *      c. **真正需要这条信息的人有别的入口**：管理员看 `GET /api/plugins` 的插件状态与
 *         `@geewiki/oidc` 自己的探测结论；点 SSO 入口也会拿到 503 `oidc_unavailable`
 *         并带上原因。告警留在**可操作的人能看到的地方**，而不是留在匿名页面上。
 *    守卫见 `packages/web/test/loginSso.test.ts`（源码级钉住"不可用分支不得再出现"）。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import {
  Button,
  buttonClassName,
  Card,
  CardBody,
  CardHeader,
  ErrorNotice,
  Input,
  LoadingState,
} from '../ui'
import { login, useAuth } from '../lib/authStore'
import { normalizeRedirect } from '../lib/authFailure'

interface LoginQuery {
  /** 回跳目标（已规范化） */
  redirect: string
  /** `link=required` ⇒ 本次 SSO 已验证成功，但该邮箱已有本地账号，需要确认绑定 */
  linkRequired: boolean
  /** SSO 回跳带回来的错误码（`oidc_error=…`） */
  oidcError: string | null
}

/** 从 `#/login?redirect=%2Fwiki&link=required` 里取参数 */
function parseLoginQuery(): LoginQuery {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const queryStart = raw.indexOf('?')
  const query = queryStart < 0 ? '' : raw.slice(queryStart + 1)
  const params = new URLSearchParams(query)
  return {
    redirect: normalizeRedirect(params.get('redirect') ?? '/wiki'),
    linkRequired: params.get('link') === 'required',
    oidcError: params.get('oidc_error'),
  }
}

/**
 * SSO 错误码 → 人话。
 *
 * **刻意不暴露内部细节**：`iss_mismatch` / `bad_signature` 这类对用户没有可操作性，
 * 但也不能吞掉——它们的共同指向是"找管理员"，所以统一成一句话。
 * 未列出的码一律落到兜底文案（新增错误码不会漏显示）。
 */
function oidcErrorText(code: string): string {
  switch (code) {
    case 'no_invitation':
      return '该邮箱没有待接受的邀请，请联系管理员开通账号。'
    case 'provisioning_off':
      return '本实例未开放通过 SSO 创建账号，请联系管理员。'
    case 'idp_error':
      return '身份提供方拒绝了本次登录（可能已取消授权）。'
    case 'state_invalid':
      return '登录会话已失效，请重新发起 SSO 登录。'
    case 'iss_mismatch':
    case 'aud_mismatch':
    case 'alg_not_allowed':
    case 'bad_signature':
    case 'nonce_mismatch':
    case 'token_expired':
    case 'discovery_failed':
      return '身份校验未通过，请联系管理员检查 SSO 配置。'
    default:
      return 'SSO 登录未完成，请重试或改用本地账号登录。'
  }
}

export function LoginPage(): ReactNode {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [query] = useState<LoginQuery>(() => parseLoginQuery())

  // 已有会话就直接放行：用户点了一个需要登录的链接、但 cookie 其实还有效。
  // **但 `link=required` 时要留在本页** —— 那正是"已登录但身份没绑上"的状态，
  // 直接跳走会让绑定提示一闪过而永远看不到。
  useEffect(() => {
    if (auth.authenticated && !query.linkRequired) window.location.hash = query.redirect
  }, [auth.authenticated, query.linkRequired, query.redirect])

  // 尚未初始化：登录必然失败，直接引导去初始化向导（不要让人在这儿白试一遍）
  useEffect(() => {
    if (auth.setupRequired === true) window.location.hash = '/setup'
  }, [auth.setupRequired])

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setFailure(null)
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      // 绑定时先把用户带到账号页确认，否则才回跳原目标
      /*
       * ⚠️ 必须带上 `?link=required`：账号页/插件据此才显示"确认绑定"卡片。
       * 此前写的是 `'/account'`（把参数丢了），于是 SSO 回跳后**确认卡片永远不出现**——
       * 用户被带到账号页却没有任何可确认的东西，身份绑定这条流程实际是断的
       * （2026-09-16，由插件侧的子任务在核对"提示从哪来"时发现）。
       */
      window.location.hash = query.linkRequired ? '/account?link=required' : query.redirect
    } catch (err) {
      setFailure(err)
    } finally {
      setSubmitting(false)
    }
  }

  if (auth.loading && auth.setupRequired === null) return <LoadingState label="正在检查登录状态…" />

  const oidc = auth.oidc
  const ssoHref =
    oidc?.available === true
      ? `${oidc.startPath}?redirect=${encodeURIComponent(query.redirect)}`
      : null

  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">登录</h1>

      {query.oidcError !== null && (
        <Card>
          <CardBody>
            {/* `role="alert"`：SSO 失败是"刚发生的事"，可以打断播报 */}
            <p role="alert" className="m-0 text-note text-danger-ink">
              {oidcErrorText(query.oidcError)}
            </p>
          </CardBody>
        </Card>
      )}

      {query.linkRequired && (
        <Card>
          <CardHeader
            title="需要确认绑定"
            description="该邮箱已有一个本地账号，系统不会自动把 SSO 身份合并进去"
          />
          <CardBody>
            <p className="m-0 text-note text-muted">
              {auth.authenticated
                ? '你已登录。请到账号页确认把这次登录的 SSO 身份绑定到当前账号。'
                : '请先用该邮箱的本地密码登录，然后到账号页确认绑定。'}
            </p>
            {auth.authenticated && (
              <div className="mt-3">
                <a className={buttonClassName({ variant: 'primary' })} href="#/account">
                  去账号页确认绑定
                </a>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="使用账号登录" description="登录后可编辑知识库内容" />
        <CardBody>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
            <label className="flex flex-col gap-1 text-xs text-muted">
              邮箱
              <Input
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={failure !== null}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              密码
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={failure !== null}
              />
            </label>
            {/* `role="alert"`：本页只有这一处错误出口，可以打断播报 */}
            <ErrorNotice error={failure} role="alert" />
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              icon={<KeyRound className="size-4" />}
              disabled={email === '' || password === ''}
            >
              登录
            </Button>
          </form>
        </CardBody>
      </Card>

      {ssoHref !== null && oidc?.available === true && (
        <Card>
          <CardHeader title="企业 SSO" description="使用组织身份源登录（与本地账号并存）" />
          <CardBody>
            {/*
              真实链接（不是 onClick 跳转）：完整导航才能走完 IdP 的授权码往返。
              `rel="nofollow"` 无 SEO 含义，这里只用于表明它是应用内部入口。
            */}
            <a
              className={buttonClassName({ variant: 'secondary', className: 'w-full' })}
              href={ssoHref}
            >
              <ShieldCheck className="size-4" />
              {oidc.label}
            </a>
          </CardBody>
        </Card>
      )}

      {/*
        连不上服务时给出可操作的信息（`describeError` 分级），而不是只显示表单让用户干试。
        这不是错误提示的重复：网络不可达与密码错误是**完全不同的下一步**。
      */}
      {auth.error !== null && <ErrorNotice error={auth.errorValue} />}
    </div>
  )
}
