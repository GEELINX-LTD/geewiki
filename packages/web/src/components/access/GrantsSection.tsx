/**
 * 页级例外授予（M2）—— `GET/POST /api/pages/:slug/grants` 与 `DELETE …/grants/:id`。
 * ============================================================================
 *
 * ## 两个刻意的界面决定
 *
 * 1. **授权对象走 `GrantTargetFields`（与段落授权**同一份**字段）：能列名单就下拉选，列不了才手填。**
 *    这里曾经只收 id，旁边写着"成员/组列表需要组织管理员权限，本页不拉取它"—— 那条理由在
 *    `GET /api/org/members|groups` 放宽为"任何登录用户可读"之后就**过期**了，于是编辑器里能下拉选人、
 *    这一页却还得手输一个数字 id（作者反馈："权限按钮进去那个页面的还不能下拉选择用户"）。
 *    名单的三态判据在 `lib/subjectDirectory.ts`；**两处授权共用 `GrantTargetFields`，不要再各画一份**。
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
import { api, type PageGrantRow, type SubjectKind } from '../../api'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { GRANT_ROLE_OPTIONS, expiryLabel, expiresAtFromLocal, subjectIdError } from '../../lib/accessPlan'
import { describeSubject, loadSubjectDirectory, type SubjectDirectory } from '../../lib/subjectDirectory'
import { GrantTargetFields, type GrantTargetDraft } from './GrantTargetFields'
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

  /**
   * 授权对象名单（成员 / 用户组）。三态：能列名单 ⇒ 下拉选择；确知被拒 ⇒ 手填并说明"你没有管理员权限"；
   * 读取失败 ⇒ 手填 + 如实报错（**不谎称没权限**）。判据全在 `lib/subjectDirectory.ts`。
   */
  const [directory, setDirectory] = useState<SubjectDirectory | null>(null)
  /** 手填 id 模式（有名单时也留这个出口：要授权的人可能不在名单里） */
  const [manualId, setManualId] = useState(false)
  const [draft, setDraft] = useState<GrantTargetDraft>({
    subjectKind: 'user',
    subjectId: '',
    role: 'viewer',
    expiresLocal: '',
  })
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

  /*
   * 名单只取一次（不在每次提交或刷新列表时重复拉）。`alive` 防卸载后 setState。
   * 这条请求**失败也不影响授权**（授权只要 `manageVisibility`）—— 失败只是让表单退回手填，
   * 所以它不参与 `load()` 的错误态，也不阻塞表单渲染。
   */
  useEffect(() => {
    let alive = true
    void loadSubjectDirectory().then((d) => {
      if (alive) setDirectory(d)
    })
    return () => {
      alive = false
    }
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    const idErr = subjectIdError(draft.subjectId)
    if (idErr !== null) {
      setFormErr(idErr)
      return
    }
    const expiry = expiresAtFromLocal(draft.expiresLocal)
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
        subjectKind: draft.subjectKind,
        subjectId: draft.subjectId.trim(),
        role: draft.role,
        expiresAt: expiry.iso,
      })
      /*
       * 回执里用**名字**而不是 id（名单可见时）—— 刚点完"添加授权"的人要能一眼确认加对了人。
       * 名单不可见时 `describeSubject` 退化成"用户 id 42"，不编造。
       */
      setNotice(
        `已授予：${describeSubject(draft.subjectKind, draft.subjectId.trim(), directory)} → ${
          GRANT_ROLE_OPTIONS.find((o) => o.id === draft.role)?.label ?? draft.role
        }（${expiry.iso === null ? '不过期' : `到期 ${expiry.iso}`}）`,
      )
      setDraft({ ...draft, subjectId: '', expiresLocal: '' })
      await load()
      onChanged?.()
    } catch (e: unknown) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [slug, draft, directory, load, onChanged])

  const remove = useCallback(
    async (row: PageGrantRow): Promise<void> => {
      const ok = window.confirm(
        `撤销对「${describeSubject(row.subject_kind, row.subject_id, directory)}」的授权？\n` +
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
    [slug, load, onChanged, directory],
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
          {/*
            字段本体来自 `GrantTargetFields`（与段落授权**同一份实现**）：
            有名单就是「授权给谁」的下拉选择，没名单才退回手填 id 并说明原因。
          */}
          <GrantTargetFields
            idPrefix="page-grant"
            draft={draft}
            onDraftChange={setDraft}
            directory={directory}
            manualId={manualId}
            onManualIdChange={setManualId}
            busy={busy}
            invalid={formErr !== null}
          />
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
                    <th scope="col" className="py-1 pr-3 font-medium">授权对象</th>
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
                      <td className="py-1.5 pr-3">
                        {/* id → 名字（名单不可见时退化成「用户 id 42」，不编造）；原始 id 留在后面便于核对 */}
                        {describeSubject(r.subject_kind, r.subject_id, directory)}{' '}
                        <span className="font-mono text-xs text-muted">#{r.subject_id}</span>
                      </td>
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
