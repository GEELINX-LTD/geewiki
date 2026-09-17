/**
 * 邀请码开户页（`#/invite/<token>`）—— **新用户唯一的入口**。
 *
 * ## 为什么这一页必须存在（它补的是一个真实的断链）
 *
 * 在它出现之前，服务端有 `POST /api/org/invitations/redeem`（匿名可调、凭 256 位熵的
 * 令牌开户），而**界面上没有任何地方消费那个令牌**：管理员签发邀请后，界面把它显示成
 * 「邀请链接」并给一个「复制链接」按钮 —— 但那个"链接"没有任何路由会处理它，
 * 全仓 grep 不到 `#/invite`、`invite=`、`redeemInvitation`。结果是：**要开一个本地账号，
 * 被邀请人必须自己发一个 HTTP 请求**（`scripts/seed-demo.sh` 与四个 e2e 脚本就是这么做的）。
 * 这是"端点能用、界面进不去"的典型——与本轮审计页那四个端点同一类问题。
 *
 * ## 两条路径，按"有没有登录"分
 *
 * - **未登录** ⇒ 这是绝大多数情况（被邀请人此刻还没有账号）。填邮箱 / 用户名 / 密码，
 *   走 `redeem` 开户，然后**自动登录**并进知识库。
 * - **已登录** ⇒ 他已有账号，凭同一个码**入伙**（`accept`），不再开户。
 *   这条分支不能省：管理员把码发给一个已有账号的同事是完全正常的用法，
 *   而让他在已登录状态下再走一次"注册"会撞 `email_taken`。
 *
 * ## 开户后为什么要自动登录
 *
 * `redeem` **刻意不建会话**（会话的建立属于身份域，绕开 `login` 去手搓 cookie 等于把
 * 会话令牌的纪律复制到第二个地方）。所以这里紧接着调一次 `login` —— 用的是用户**刚设的**
 * 那对邮箱密码，走的是与登录页**完全同一条**路径。这比让用户"注册成功后再去登录页输一遍"
 * 少一次往返，且不会让任何一处绕过身份域。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Mail } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorNotice,
  Input,
  LoadingState,
} from '../ui'
import { api } from '../api'
import { login, useAuth } from '../lib/authStore'
import { emailError } from '../lib/orgPlan'

/** 后端 `PASSWORD_MIN`（`packages/plugin-auth/src/index.ts`）：前后端各持一份，改后端时必须同步 */
const PASSWORD_MIN = 8

export function InvitePage(props: { readonly token: string }): ReactNode {
  const auth = useAuth()
  const token = props.token.trim()

  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [doing, setDoing] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [joined, setJoined] = useState(false)

  // 还没初始化过 ⇒ 先去 setup：那时库里一个账号都没有，邀请码无从谈起
  useEffect(() => {
    if (auth.setupRequired === true) window.location.hash = '/setup'
  }, [auth.setupRequired])

  const onRedeem = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setFailure(null)
    /*
     * 两道纯客户端可判定的校验先挡在本地：不该为"两次密码不一致"打一次网络往返。
     * 邮箱格式用 `emailError`（与邀请签发同一份规则），只换掉"空值"那句文案 ——
     * 这里填的是**自己的**邮箱，不是"受邀人的"。
     */
    const emailProblem = emailError(email, '请填写邮箱')
    if (emailProblem !== null) {
      setFailure(new Error(emailProblem))
      return
    }
    if (password !== confirm) {
      setFailure(new Error('两次输入的密码不一致'))
      return
    }
    setSubmitting(true)
    try {
      const trimmedEmail = email.trim()
      await api.redeemInvitation({
        token,
        email: trimmedEmail,
        password,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      })
      // 用刚设的那对邮箱密码登录 —— 与登录页走同一条路（见文件头最后一段）
      await login(trimmedEmail, password)
      window.location.hash = '/wiki'
    } catch (err) {
      setFailure(err)
    } finally {
      setSubmitting(false)
    }
  }

  const onAccept = async (): Promise<void> => {
    setFailure(null)
    setDoing(true)
    try {
      await api.acceptInvitation(token)
      setJoined(true)
    } catch (err) {
      setFailure(err)
    } finally {
      setDoing(false)
    }
  }

  if (auth.loading && auth.setupRequired === null) return <LoadingState label="正在检查登录状态…" />

  if (token === '') {
    return (
      <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-4 py-6">
        <h1 className="m-0 text-lg font-semibold text-ink">邀请码</h1>
        <Card>
          <CardHeader title="这个地址缺少邀请码" description="邀请码在链接的末尾" />
          <CardBody>
            <p className="m-0 text-note text-muted">
              请使用管理员给你的**完整链接**（形如 <code className="text-xs">#/invite/……</code>）。
              如果链接是从聊天工具里复制的，注意它可能被截断。
            </p>
          </CardBody>
        </Card>
      </div>
    )
  }

  /* ---------------- 已登录：凭码入伙（不再开户） ---------------- */
  if (auth.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-4 py-6">
        <h1 className="m-0 text-lg font-semibold text-ink">加入组织</h1>
        <Card>
          <CardHeader
            title="你已登录"
            description={auth.user === null ? '' : `当前账号：${auth.user.email}`}
          />
          <CardBody className="flex flex-col gap-3">
            {joined ? (
              <>
                <p className="m-0 flex items-center gap-2 text-note">
                  <Badge tone="ok">已加入</Badge>
                  邀请码已使用，组织身份已生效。
                </p>
                <Button variant="primary" onClick={() => (window.location.hash = '/wiki')}>
                  去知识库
                </Button>
              </>
            ) : (
              <>
                <p className="m-0 text-note text-muted">
                  用这个邀请码把当前账号加入组织。若你其实是想**新建一个账号**，
                  请先退出登录，再用同一个链接打开本页。
                </p>
                <ErrorNotice error={failure} role="alert" />
                <Button variant="primary" loading={doing} onClick={() => void onAccept()}>
                  用当前账号加入
                </Button>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    )
  }

  /* ---------------- 未登录：凭码开户 ---------------- */
  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">邀请注册</h1>
      <Card>
        <CardHeader
          title="创建你的账号"
          description="你收到了一个邀请码。填好下面三项即可开始使用 —— 邮箱、用户名与密码之后都能在「账号」页修改。"
        />
        <CardBody>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onRedeem(e)}>
            <label className="flex flex-col gap-1 text-xs text-muted">
              邮箱（登录用）
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
              用户名（可选）
              <Input
                type="text"
                name="displayName"
                autoComplete="nickname"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="留空则用邮箱前缀"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              密码（至少 {PASSWORD_MIN} 位）
              <Input
                type="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={failure !== null}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              再输一次
              <Input
                type="password"
                name="confirm"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                invalid={failure !== null}
              />
            </label>
            <ErrorNotice error={failure} role="alert" />
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              icon={<Mail className="size-4" />}
              disabled={email === '' || password === '' || confirm === ''}
            >
              创建并登录
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  )
}