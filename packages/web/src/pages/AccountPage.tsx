/**
 * 账号页（`#/account`）：外部身份（SSO）的绑定与解绑。
 *
 * 为什么单独一页而不是塞进登录页或顶栏下拉：
 * 1. **绑定需要"已登录的本地会话"**（设计文档 §7.2 禁止按 email 自动绑定），
 *    所以它天然是"登录之后"的动作，与登录页的职责不同；
 * 2. SSO 回跳带来的 `#/login?link=required` 只是**提示**，真正需要用户决策与确认的
 *    是这一页 —— 把二者混在一页会让登录表单与绑定确认抢同一块注意力。
 *
 * 三条界面约定：
 * - **票据从不经过前端**：`api.authLinkIdentity()` 不带参数，票据在 `HttpOnly` cookie 里；
 *   因此本页无法"提前知道"有没有待绑定票据，只能由 URL 上的 `link=required` 触发展示。
 * - **解绑入口在服务端也会兜底**：没有口令且只剩一个身份时服务端返回 409 `last_credential`，
 *   前端据此提前禁用按钮，但服务端判定才是权威（前端隐藏不是安全措施）。
 * - 时间一律走 `toLocaleString()`（本页只展示"何时绑的"，不需要相对时间那套复杂度）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link2, ShieldCheck, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../ui'
import { api, type AuthIdentity } from '../api'
import { useAuth } from '../lib/authStore'

/** 本页的加载状态（与 wiki 页的 `resolveAreaState` 同思路：四态互斥） */
type View =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  | { kind: 'ready'; hasPassword: boolean; identities: AuthIdentity[] }

/** 从 `#/account?link=required` 取参数 */
function wantsLinkConfirm(): boolean {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) return false
  return new URLSearchParams(raw.slice(queryStart + 1)).get('link') === 'required'
}

function fmtTime(iso: string | null): string {
  if (iso === null) return '—'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso
}

export function AccountPage(): ReactNode {
  const auth = useAuth()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [linkPending, setLinkPending] = useState(() => wantsLinkConfirm())

  // 未登录不该停在这一页：带上回跳参数去登录页
  useEffect(() => {
    if (auth.setupRequired === true) window.location.hash = '/setup'
    else if (!auth.loading && !auth.authenticated) {
      window.location.hash = '/login?redirect=%2Faccount'
    }
  }, [auth.loading, auth.authenticated, auth.setupRequired])

  const reload = useCallback(async (): Promise<void> => {
    setView({ kind: 'loading' })
    try {
      const r = await api.authIdentities()
      setView({ kind: 'ready', hasPassword: r.hasPassword, identities: r.identities })
    } catch (error) {
      setView({ kind: 'error', error })
    }
  }, [])

  useEffect(() => {
    if (auth.authenticated) void reload()
  }, [auth.authenticated, reload])

  const onConfirmLink = async (): Promise<void> => {
    setConfirming(true)
    setNotice(null)
    try {
      const r = await api.authLinkIdentity()
      setNotice({
        kind: 'ok',
        text: r.alreadyLinked ? '该外部身份此前已绑定到当前账号。' : '绑定成功，下次可直接用 SSO 登录。',
      })
      setLinkPending(false)
      await reload()
    } catch (err) {
      setNotice({ kind: 'err', text: errText(err) })
    } finally {
      setConfirming(false)
    }
  }

  const onUnlink = async (identity: AuthIdentity): Promise<void> => {
    setNotice(null)
    try {
      await api.authUnlinkIdentity(identity.id)
      setNotice({ kind: 'ok', text: '已解绑。' })
      await reload()
    } catch (err) {
      setNotice({ kind: 'err', text: errText(err) })
    }
  }

  if (!auth.authenticated) return <LoadingState label="正在检查登录状态…" />

  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">账号</h1>

      {linkPending && (
        <Card>
          <CardHeader
            title="确认绑定外部身份"
            description="系统不会按邮箱自动合并账号 —— 需要你在这里显式确认"
          />
          <CardBody>
            <p className="m-0 text-note text-muted">
              你刚刚通过 SSO 验证了身份，但该邮箱已有一个本地账号。确认后，这个外部身份会绑定到**当前登录的账号**上，之后可以直接用 SSO 登录。
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                loading={confirming}
                icon={<Link2 className="size-4" />}
                onClick={() => void onConfirmLink()}
              >
                确认绑定
              </Button>
              <Button variant="ghost" onClick={() => setLinkPending(false)}>
                稍后再说
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {notice !== null && (
        <p
          role={notice.kind === 'err' ? 'alert' : 'status'}
          className={
            notice.kind === 'err' ? 'm-0 text-note text-danger-ink' : 'm-0 text-note text-ok-ink'
          }
        >
          {notice.text}
        </p>
      )}

      <Card>
        <CardHeader title="登录方式" description="口令与外部身份（SSO）" />
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-note text-muted">本地口令</span>
            {view.kind === 'ready' ? (
              <Badge tone={view.hasPassword ? 'ok' : 'warn'}>
                {view.hasPassword ? '已设置' : '未设置'}
              </Badge>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </div>

          {view.kind === 'loading' && <LoadingState label="正在加载绑定的身份…" />}
          {view.kind === 'error' && (
            <ErrorState
              title="加载登录方式失败"
              hint={errText(view.error)}
              onRetry={() => void reload()}
            />
          )}
          {view.kind === 'ready' && view.identities.length === 0 && (
            <EmptyState
              icon={<ShieldCheck className="size-5" />}
              title="还没有绑定外部身份"
              hint={
                view.hasPassword
                  ? '在登录页选择企业 SSO 完成一次登录后，这里会出现可绑定的身份。'
                  : '当前账号只能通过外部身份登录，建议设置一个本地口令作为备用。'
              }
            />
          )}
          {view.kind === 'ready' &&
            view.identities.map((id) => {
              // 服务端是权威判据（409 last_credential）；这里只避免用户白点一次
              const isLastCredential = !view.hasPassword && view.identities.length <= 1
              return (
                <div
                  key={id.id}
                  className="flex items-center justify-between gap-3 border-t border-line pt-3"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-note text-ink">{id.emailAtLink ?? id.subject}</span>
                    <span className="truncate text-xs text-muted" title={id.issuer}>
                      {id.issuer}
                    </span>
                    <span className="text-xs text-muted">
                      绑定于 {fmtTime(id.linkedAt)} · 最近登录 {fmtTime(id.lastLoginAt)}
                    </span>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="size-3.5" />}
                    disabled={isLastCredential}
                    title={isLastCredential ? '这是最后一个登录方式，无法解绑' : undefined}
                    onClick={() => void onUnlink(id)}
                  >
                    解绑
                  </Button>
                </div>
              )
            })}
        </CardBody>
      </Card>
    </div>
  )
}

/** 从错误里取一句人话（服务端的机器码优先，其次 message） */
function errText(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; message?: unknown }
    if (typeof e.message === 'string' && e.message.length > 0) return e.message
    if (typeof e.code === 'string' && e.code.length > 0) return e.code
  }
  return '操作失败，请重试。'
}
