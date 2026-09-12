/**
 * 页级例外授予（M2）—— `GET/POST /api/pages/:slug/grants` 与 `DELETE …/grants/:id`。
 * ============================================================================
 *
 * ## 两个刻意的界面决定
 *
 * 1. **授权对象是自由文本输入，不做成员/组选择器。** 「好选」的代价是去调成员列表端点，
 *    而那个端点要 org admin（普通成员 403）—— 为了一个下拉框让页面为大多数管理者报一次
 *    403 是不划算的；而且真正的授权对象可能包含尚未入伙的用户 id。故这里只收 id，
 *    并在表单旁写清格式（用户填用户 id、用户组填组 id）。
 * 2. **不提供 `org_role` 选项。** 角色不是授权对象（后端 D13 明确拒绝 `org_role`，
 *    回 400 `invalid_subject_kind`）：角色决定的是**能力**（能不能编辑/管理），
 *    而授予决定的是**这一条内容对谁可见**。把两者混在一个下拉里会让管理者以为
 *    "给 editor 角色的人就自动能看这条"。
 *
 * ⚠️ 列表字段是 **snake_case**（`subject_kind` / `granted_at` / `expires_at`）——
 * 服务端直接回表列名，与块级授权（camelCase）不同，见 `api.ts` 的 `PageGrantRow` 注释。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Trash2, UserPlus } from 'lucide-react'
import { api, type GrantRole, type PageGrantRow, type SubjectKind } from '../../api'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { Input } from '../../ui/Input'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { cn } from '../../ui/cn'
import {
  GRANT_ROLE_OPTIONS,
  SUBJECT_KIND_OPTIONS,
  expiryLabel,
  expiresAtFromLocal,
  subjectIdError,
} from '../../lib/accessPlan'
import { errorLine } from '../../lib/errorText'

export function GrantsSection({
  slug,
  onChanged,
}: {
  slug: string
  /** 授权变动后的通知（宿主可据此重取；档位变更不改自己的能力，**不要**借此 `loadAuth()`） */
  onChanged?: () => void
}): ReactNode {
  const [rows, setRows] = useState<PageGrantRow[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const [subjectKind, setSubjectKind] = useState<SubjectKind>('user')
  const [subjectId, setSubjectId] = useState('')
  const [role, setRole] = useState<GrantRole>('viewer')
  const [expiresLocal, setExpiresLocal] = useState('')
  const [formErr, setFormErr] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      const r = await api.pageGrants(slug)
      setRows(r.grants)
    } catch (e: unknown) {
      setErr(e)
      setRows(null)
    }
  }, [slug])

  useEffect(() => {
    void load()
  }, [load])

  const submit = useCallback(async (): Promise<void> => {
    const idErr = subjectIdError(subjectId)
    if (idErr !== null) {
      setFormErr(idErr)
      return
    }
    const expiry = expiresAtFromLocal(expiresLocal)
    if (!expiry.ok) {
      // 非法时间**不得**当成"不过期"提交：那会把限时授权悄悄变成永久授权（放宽方向）
      setFormErr('到期时间格式不正确，请重新选择（留空表示不过期）')
      return
    }
    setFormErr(null)
    setBusy(true)
    setErr(null)
    setNotice('')
    try {
      await api.addPageGrant(slug, {
        subjectKind,
        subjectId: subjectId.trim(),
        role,
        expiresAt: expiry.iso,
      })
      setNotice(
        `已授予：${labelOfSubjectKind(subjectKind)} ${subjectId.trim()} → ${role}（${
          expiry.iso === null ? '不过期' : `到期 ${expiry.iso}`
        }）`,
      )
      setSubjectId('')
      setExpiresLocal('')
      await load()
      onChanged?.()
    } catch (e: unknown) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [slug, subjectKind, subjectId, role, expiresLocal, load, onChanged])

  const remove = useCallback(
    async (row: PageGrantRow): Promise<void> => {
      const ok = window.confirm(
        `撤销对「${labelOfSubjectKind(row.subject_kind)} ${row.subject_id}」的授权？\n` +
          '撤销后对方立刻失去由这条授权带来的访问权（判定每次现查库，没有缓存窗口）。',
      )
      if (!ok) return
      setBusy(true)
      setErr(null)
      setNotice('')
      try {
        await api.removePageGrant(slug, row.id)
        setNotice(`已撤销授权 #${row.id}`)
        await load()
        onChanged?.()
      } catch (e: unknown) {
        setErr(e)
      } finally {
        setBusy(false)
      }
    },
    [slug, load, onChanged],
  )

  return (
    <Card>
      <CardHeader
        title="例外授予（页级）"
        description="档位之外的单独放行：被授予的人即使档位读不到也能读（档位仍是最外层上限）。"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RefreshCw className="size-4" />}
            aria-label="刷新授权列表"
            disabled={busy}
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        {/* 新增表单 */}
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="grant-subject-kind" className="text-xs font-medium text-ink-soft">
                授权对象类别
              </label>
              <select
                id="grant-subject-kind"
                className={cn(
                  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
                  'focus:border-accent',
                )}
                value={subjectKind}
                disabled={busy}
                onChange={(e) => setSubjectKind(e.target.value === 'group' ? 'group' : 'user')}
              >
                {SUBJECT_KIND_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">
                只有「用户」与「用户组」两类；角色不是授权对象 —— 角色决定能力，授权决定这一条对谁可见。
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="grant-subject-id" className="text-xs font-medium text-ink-soft">
                对象 id
              </label>
              <Input
                id="grant-subject-id"
                value={subjectId}
                disabled={busy}
                invalid={formErr !== null}
                placeholder={subjectKind === 'user' ? '用户 id（数字）' : '用户组 id（数字）'}
                onChange={(e) => setSubjectId(e.target.value)}
              />
              <span className="text-xs text-muted">
                直接填 id：成员/组列表需要组织管理员权限，本页不拉取它（普通成员会被拒）。
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="grant-role" className="text-xs font-medium text-ink-soft">
                授予角色
              </label>
              <select
                id="grant-role"
                className={cn(
                  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
                  'focus:border-accent',
                )}
                value={role}
                disabled={busy}
                onChange={(e) => setRole(e.target.value === 'editor' ? 'editor' : 'viewer')}
              >
                {GRANT_ROLE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="grant-expires" className="text-xs font-medium text-ink-soft">
                到期时间（留空 = 不过期）
              </label>
              <Input
                id="grant-expires"
                type="datetime-local"
                value={expiresLocal}
                disabled={busy}
                onChange={(e) => setExpiresLocal(e.target.value)}
              />
              <span className="text-xs text-muted">过期在判定时即失效，不依赖任何清理任务。</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<UserPlus className="size-3.5" />}
              loading={busy}
              onClick={() => void submit()}
            >
              添加授权
            </Button>
            {formErr !== null && <span className="text-note text-danger-ink">{formErr}</span>}
          </div>
        </div>

        {notice !== '' && (
          <p role="status" className="m-0 mt-3 rounded-md border border-ok-line bg-ok-bg px-3 py-1.5 text-note text-ok-ink">
            {notice}
          </p>
        )}
        {err !== null && (
          <div className="mt-3">
            <ErrorNotice error={err} role="alert" />
          </div>
        )}

        {/* 列表 */}
        <div className="mt-4">
          {rows === null && err === null ? (
            <LoadingState label="正在加载授权列表…">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </LoadingState>
          ) : rows !== null && rows.length === 0 ? (
            <EmptyState
              title="还没有例外授予"
              hint="这一页目前只按档位判定谁能读。需要给某个人或某个用户组单独放行时，用上面的表单添加一条。"
            />
          ) : rows !== null ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label="页级例外授予">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">类别</th>
                    <th scope="col" className="py-1 pr-3 font-medium">对象 id</th>
                    <th scope="col" className="py-1 pr-3 font-medium">角色</th>
                    <th scope="col" className="py-1 pr-3 font-medium">授予时间</th>
                    <th scope="col" className="py-1 pr-3 font-medium">到期</th>
                    <th scope="col" className="py-1 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="py-1.5 pr-3">{labelOfSubjectKind(r.subject_kind)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{r.subject_id}</td>
                      <td className="py-1.5 pr-3">{r.role}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{fmtTime(r.granted_at)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{expiryLabel(r.expires_at)}</td>
                      <td className="py-1.5">
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Trash2 className="size-3.5" />}
                          disabled={busy}
                          onClick={() => void remove(r)}
                        >
                          撤销
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            // rows === null 且 err !== null：错误已在上方渲染，这里只留一行可读的说明
            <p className="m-0 text-sm text-muted">{errorLine(err)}</p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function labelOfSubjectKind(kind: SubjectKind): string {
  return kind === 'group' ? '用户组' : '用户'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
