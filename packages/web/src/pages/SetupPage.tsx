/**
 * 首次初始化向导（`#/setup`）。
 *
 * **只在"库里还没有任何可登录账号"时可达**：创建成功后立刻跳转；若已被别人初始化过
 * （或用户手输这个 hash），则引回登录页 —— 服务端 `POST /api/auth/setup` 也会
 * 在已有账号时返回 409 `setup_already_done`（自守卫），前端这层只是不让用户白填一遍表单。
 *
 * 与登录页一样：密码错误/校验失败是**本次提交**的结果，显示在表单内。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button, Card, CardBody, CardHeader, ErrorNotice, Input, LoadingState } from '../ui'
import { setup, useAuth } from '../lib/authStore'

/** 后端 `PASSWORD_MIN`：密码长度下限（前后端各持一份，改后端时必须同步） */
const PASSWORD_MIN = 8

export function SetupPage(): ReactNode {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  // 已初始化过 ⇒ 这里没有可做的事，去登录
  useEffect(() => {
    if (auth.setupRequired === false && !auth.authenticated) window.location.hash = '/login'
  }, [auth.setupRequired, auth.authenticated])

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setFailure(null)
    if (password !== confirm) {
      // 本地先挡一道：密码不一致是纯客户端可判定的事实，没必要打一次网络往返
      setFailure(new Error('两次输入的密码不一致'))
      return
    }
    setSubmitting(true)
    try {
      await setup(email.trim(), password, displayName.trim())
      window.location.hash = '/wiki'
    } catch (err) {
      setFailure(err)
    } finally {
      setSubmitting(false)
    }
  }

  if (auth.loading && auth.setupRequired === null) return <LoadingState label="正在检查初始化状态…" />

  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">初始化</h1>
      <Card>
        <CardHeader
          title="创建第一个账号"
          description="本实例还没有任何账号。创建后即可登录并编辑知识库。"
        />
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
              显示名（可选）
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
              icon={<ShieldCheck className="size-4" />}
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
