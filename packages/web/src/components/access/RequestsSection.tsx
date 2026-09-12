/**
 * 访问申请审批（M3）—— `GET /api/pages/:slug/access-requests` 与 approve / deny。
 * ============================================================================
 *
 * ## 三条必须写对的文案/行为
 *
 * 1. **只列待审，且服务端最多 200 条、不回总数。** 所以文案**不能**写"共 N 条申请"
 *    （那是假的：它既不含已裁决的，也不代表总数）。界面只说"待审申请"并注明上限。
 * 2. **`request_not_pending` 的处置是"重新取一次列表"**，不是弹一个错误就完事：
 *    它的含义是"这条申请的状态在你打开页面之后被别人改过了"，此时屏幕上那份列表
 *    **已经过期**，重载才是用户需要的动作（文案也照此写，见 `accessPlan.conflictText`，
 *    语境传 `request`：这里的 404 指**这条申请**已不存在，不是页面不存在）。
 *    这条说明**必须用 warn 配色**：这次裁决并没有成功，用成功配色会被读成"已批准/已拒绝"。
 * 3. **`deny` 需要确认**：拒绝是可恢复的（申请人可以再次提交），但对方看不到任何理由，
 *    误点一次就会让人白等一轮。确认文案同时说明"仍可再次申请"，避免管理者以为自己
 *    在"永久拉黑"。
 *
 * ⚠️ 本组件**只在有可见性管理权时**才被渲染（宿主 `PageAccessPanel` 负责判据）：
 * 无权限时整个面板不出现，而不是显示一堆点了必然 403 的按钮。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import { ApiError, api, type AccessRequestRow, type GrantRole } from '../../api'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { Input } from '../../ui/Input'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { cn } from '../../ui/cn'
import { GRANT_ROLE_OPTIONS, conflictText, expiresAtFromLocal } from '../../lib/accessPlan'
import { errorLine } from '../../lib/errorText'

/** 正在裁决的那一条（role 默认 viewer；过期留空 = 不过期） */
interface Draft {
  requestId: number
  role: GrantRole
  expiresLocal: string
  error: string | null
}

export function RequestsSection({ slug }: { slug: string }): ReactNode {
  const [rows, setRows] = useState<AccessRequestRow[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 结果提示条。**带口气**（本批 R8 修掉的真实缺陷）：原先只有一个字符串，而渲染处写死了
   * `border-ok-line bg-ok-bg text-ok-ink`（成功配色）—— 于是"这次裁决**没成功**"的冲突说明
   * 被印成了绿色的成功提示，与它下面那份**已经刷新过的**列表一起读，像是"操作成功了"。
   */
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      const r = await api.accessRequests(slug)
      setRows(r.requests)
    } catch (e: unknown) {
      setErr(e)
      setRows(null)
    }
  }, [slug])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 裁决失败的统一处置。
   *
   * `request_not_pending`（以及"这条申请已经不存在了"的 `not_found`）意味着**屏幕上的列表过期了**：
   * 先把 `conflictText` 的说明显示出来，再自动重取 —— 用户不必自己找刷新按钮。
   * 其它错误（网络/权限/参数）照常走 `ErrorNotice`。
   *
   * ⚠️ 这里的两条文案一律用 `warn` 口气：**这次裁决没有成功**。用成功配色是安全事故级的
   * 误读（管理员会以为已经批准/拒绝了）。语境传 `request`：这两个端点上的 404 指的是
   * **这条申请**不存在，不是"页面不存在"（见 `accessPlan.ConflictContext`）。
   */
  const handleFailure = useCallback(
    async (e: unknown): Promise<void> => {
      const code = e instanceof ApiError ? e.code : ''
      if (code === 'request_not_pending' || code === 'not_found') {
        setNotice({
          tone: 'warn',
          text: conflictText(code, 'request') ?? '这条申请已被处理，列表已刷新。',
        })
        await load()
        return
      }
      setErr(e)
    },
    [load],
  )

  const approve = useCallback(
    async (row: AccessRequestRow, d: Draft): Promise<void> => {
      const expiry = expiresAtFromLocal(d.expiresLocal)
      if (!expiry.ok) {
        setDraft({ ...d, error: '到期时间格式不正确，请重新选择（留空表示不过期）' })
        return
      }
      setBusy(true)
      setErr(null)
      setNotice(null)
      try {
        const r = await api.approveAccessRequest(slug, row.id, { role: d.role, expiresAt: expiry.iso })
        setNotice({
          tone: 'ok',
          text:
            `已批准申请 #${row.id}（用户 #${r.userId}）：${r.role}` +
            `${expiry.iso === null ? '，不过期' : `，到期 ${expiry.iso}`}。` +
            '对方无需重新登录即可访问（判定每次现查库，没有缓存窗口）。',
        })
        setDraft(null)
        await load()
      } catch (e: unknown) {
        await handleFailure(e)
      } finally {
        setBusy(false)
      }
    },
    [slug, load, handleFailure],
  )

  const deny = useCallback(
    async (row: AccessRequestRow): Promise<void> => {
      const ok = window.confirm('拒绝后申请人仍可再次提交申请。确定拒绝？')
      if (!ok) return
      setBusy(true)
      setErr(null)
      setNotice(null)
      try {
        await api.denyAccessRequest(slug, row.id)
        setNotice({ tone: 'ok', text: `已拒绝申请 #${row.id}。申请人仍可再次提交。` })
        setDraft(null)
        await load()
      } catch (e: unknown) {
        await handleFailure(e)
      } finally {
        setBusy(false)
      }
    },
    [slug, load, handleFailure],
  )

  return (
    <Card>
      <CardHeader
        title="访问申请（待审）"
        description="这里是待审申请，服务端最多返回 200 条、且不含总数；已批准/已拒绝/已撤回的不在此列。"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RefreshCw className="size-4" />}
            aria-label="刷新待审申请"
            disabled={busy}
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        {notice !== null && (
          <p
            role="status"
            className={cn(
              'm-0 mb-3 rounded-md border px-3 py-1.5 text-note leading-relaxed',
              // 成功与"没成功"必须一眼分得开：冲突说明用 warn，不用 ok（本批 R8）
              notice.tone === 'warn'
                ? 'border-warn-line bg-warn-bg text-warn-ink'
                : 'border-ok-line bg-ok-bg text-ok-ink',
            )}
          >
            {notice.text}
          </p>
        )}
        {err !== null && (
          <div className="mb-3">
            <ErrorNotice error={err} role="alert" />
          </div>
        )}

        {rows === null && err === null ? (
          <LoadingState label="正在加载待审申请…">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </LoadingState>
        ) : rows !== null && rows.length === 0 ? (
          <EmptyState
            title="没有待审的申请"
            hint="有人申请这一页的访问权限时会出现在这里。列表只含待审项，已裁决的不会留下。"
          />
        ) : rows !== null ? (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {rows.map((r) => (
              <li key={r.id} className="rounded-md border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-muted">#{r.id}</span>
                  <span>用户 #{r.userId}</span>
                  <span className="text-xs text-muted">提交于 {fmtTime(r.createdAt)}</span>
                </div>
                {r.message !== null && r.message !== '' && (
                  // 自由文本经 React 转义后渲染（服务端已限长 500，且不截断）
                  <p className="m-0 mt-2 rounded-md border border-line bg-hover px-2.5 py-1.5 text-note whitespace-pre-wrap text-ink-soft">
                    {r.message}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Check className="size-3.5" />}
                    disabled={busy}
                    onClick={() => setDraft({ requestId: r.id, role: 'viewer', expiresLocal: '', error: null })}
                  >
                    批准…
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<X className="size-3.5" />}
                    disabled={busy}
                    onClick={() => void deny(r)}
                  >
                    拒绝
                  </Button>
                </div>

                {draft !== null && draft.requestId === r.id && (
                  <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`req-role-${r.id}`} className="text-xs font-medium text-ink-soft">
                        授予角色（默认只读）
                      </label>
                      <select
                        id={`req-role-${r.id}`}
                        className={cn(
                          'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
                          'focus:border-accent',
                        )}
                        value={draft.role}
                        disabled={busy}
                        onChange={(e) =>
                          setDraft({ ...draft, role: e.target.value === 'editor' ? 'editor' : 'viewer' })
                        }
                      >
                        {GRANT_ROLE_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`req-expires-${r.id}`} className="text-xs font-medium text-ink-soft">
                        到期时间（留空 = 不过期）
                      </label>
                      <Input
                        id={`req-expires-${r.id}`}
                        type="datetime-local"
                        value={draft.expiresLocal}
                        disabled={busy}
                        onChange={(e) => setDraft({ ...draft, expiresLocal: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                      <Button variant="primary" size="sm" loading={busy} onClick={() => void approve(r, draft)}>
                        批准并授权
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                        取消
                      </Button>
                      {draft.error !== null && <span className="text-note text-danger-ink">{draft.error}</span>}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">{errorLine(err)}</p>
        )}
      </CardBody>
    </Card>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
