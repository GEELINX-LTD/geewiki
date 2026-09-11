/**
 * 登录页（`#/login`）。
 *
 * 三个必须处理好的点：
 * 1. **`redirect` 参数**：从哪被踢出来的就回哪去。参数来源是 `#/login?redirect=%2Fwiki%2Ffoo`
 *    ——hash 路由的查询串在 `App.tsx` 的 `useRoute()` 里被剥掉，所以这里直接解析
 *    `window.location.hash`。取值必须过 `normalizeRedirect()`（挡 `//evil.com` 这类外部地址）。
 * 2. **没有初始化时不该停在这一页**：库里还没有账号时登录必然失败，页面直接引导去 `#/setup`。
 *    这正是 503 `bootstrap_required` 与 401 必须分开的原因（见 `lib/authFailure.ts`）。
 * 3. **口令错误的提示来自本次提交**，而不是全局 401 出口 —— 全局出口会把
 *    "口令错"误当成"会话失效"再跳一次登录页，用户会看到页面刷新而错误消失。
 *    故 `api.ts` 对 `/api/auth/login` 这类"提交凭据"的端点**不触发**全局出口。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound } from 'lucide-react'
import { Button, Card, CardBody, CardHeader, ErrorNotice, Input, LoadingState } from '../ui'
import { login, useAuth } from '../lib/authStore'
import { normalizeRedirect } from '../lib/authFailure'

/** 从 `#/login?redirect=%2Fwiki` 里取回跳目标 */
function redirectTarget(): string {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const queryStart = raw.indexOf('?')
  const query = queryStart < 0 ? '' : raw.slice(queryStart + 1)
  const value = new URLSearchParams(query).get('redirect')
  return normalizeRedirect(value ?? '/wiki')
}

export function LoginPage(): ReactNode {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  // 已有会话就直接放行：用户点了一个需要登录的链接、但 cookie 其实还有效
  useEffect(() => {
    if (auth.authenticated) window.location.hash = redirectTarget()
  }, [auth.authenticated])

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
      window.location.hash = redirectTarget()
    } catch (err) {
      setFailure(err)
    } finally {
      setSubmitting(false)
    }
  }

  if (auth.loading && auth.setupRequired === null) return <LoadingState label="正在检查登录状态…" />

  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">登录</h1>
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
              口令
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
      {/*
        连不上服务时给出可操作的信息（`describeError` 分级），而不是只显示表单让用户干试。
        这不是错误提示的重复：网络不可达与口令错误是**完全不同的下一步**。
      */}
      {auth.error !== null && <ErrorNotice error={auth.errorValue} />}
    </div>
  )
}
