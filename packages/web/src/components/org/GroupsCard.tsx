/**
 * 用户组（M4）—— `GET/POST /api/org/groups`、`DELETE /api/org/groups/:id` 与
 * `PUT/DELETE /api/org/groups/:id/members/:userId`。
 * ============================================================================
 *
 * ## 删组是**收紧**方向的操作，确认文案必须说清
 *
 * 级联已核实（`packages/plugin-org/src/index.ts:641`）：删组只删 `groups` 行，
 * `group_members` 靠 `ON DELETE CASCADE` 清掉；而 `page_grants` / `block_grants` 里
 * `subject_kind='group'` 的行**仍然留在库里**，只是判定时展开的 `groupIds` 不再包含它
 * ⇒ 该组带来的授权**实际失效**。所以"删了就删了"是错的：相关页面可能突然变得不可读
 * （授权记录还在，只是不再生效）。这既是确认文案的依据，也是审核只记组名的原因。
 *
 * ## 成员下拉为什么可以直接用 `orgMembers()`
 *
 * 授权界面的对象选择器刻意用自由文本输入（那里普通成员也会进，而成员列表端点要 `admin`）。
 * 本页不同：**整页按 `administer` 门控**，进得来就一定能拉成员列表 —— 于是这里可以用
 * 下拉选人，而不是让管理员去背用户 id。服务端仍会兜底：把非组织成员加进组 ⇒
 * 409 `not_org_member`（防"组里有个人但不在组织里"的幽灵成员）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Trash2, UserPlus, X } from 'lucide-react'
import { api, type OrgGroup, type OrgMember } from '../../api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { ConfirmDialog, useConfirm } from '../../ui/ConfirmDialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { Input } from '../../ui/Input'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { cn } from '../../ui/cn'
import { GROUP_NAME_MAX, groupNameError, orgConflictOf } from '../../lib/orgPlan'
import { errorLine } from '../../lib/errorText'

const SELECT_CLASS = cn(
  'h-8 min-w-[12rem] rounded-md border border-line bg-surface px-2 text-sm text-ink',
  'focus:border-accent',
)

export function GroupsCard(): ReactNode {
  const [groups, setGroups] = useState<OrgGroup[] | null>(null)
  const [members, setMembers] = useState<OrgMember[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  /** 每个组的下拉里当前选中的成员 id（字符串，`''` = 未选） */
  const [pick, setPick] = useState<Record<number, string>>({})
  const [name, setName] = useState('')
  const [formErr, setFormErr] = useState<string | null>(null)
  const { request, confirm, close } = useConfirm()

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      /*
       * 两个端点一起取：组列表只回 `memberIds`（没有邮箱/昵称），而下拉与成员标签
       * 都要显示人名 —— 逐个组去问一次成员列表是 N+1，直接复用同一份成员列表即可。
       */
      const [g, m] = await Promise.all([api.orgGroups(), api.orgMembers()])
      setGroups(g.groups)
      setMembers(m.members)
    } catch (e: unknown) {
      setErr(e)
      setGroups(null)
      setMembers(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const nameOf = useCallback(
    (userId: number): string => {
      const m = members?.find((x) => x.userId === userId)
      return m === undefined ? `#${userId}` : m.displayName
    },
    [members],
  )

  const createGroup = useCallback(async (): Promise<void> => {
    const bad = groupNameError(name)
    if (bad !== null) {
      setFormErr(bad)
      return
    }
    setFormErr(null)
    setBusy(true)
    setErr(null)
    setConflict(null)
    setNotice('')
    try {
      await api.createOrgGroup(name.trim())
      setNotice(`已创建用户组「${name.trim()}」`)
      setName('')
      await load()
    } catch (e: unknown) {
      setErr(e)
      setConflict(orgConflictOf(e))
    } finally {
      setBusy(false)
    }
  }, [name, load])

  const addMember = useCallback(
    async (g: OrgGroup): Promise<void> => {
      const raw = pick[g.id] ?? ''
      if (raw === '') {
        setConflict('请先在下拉里选择一位组织成员')
        return
      }
      setBusy(true)
      setErr(null)
      setConflict(null)
      setNotice('')
      try {
        await api.addGroupMember(g.id, Number(raw))
        setNotice(`已把 ${nameOf(Number(raw))} 加入用户组「${g.name}」`)
        setPick((p) => ({ ...p, [g.id]: '' }))
        await load()
      } catch (e: unknown) {
        setErr(e)
        setConflict(orgConflictOf(e))
        // 409 not_org_member 的常见来源是"成员列表已过期"（他刚被移出组织）⇒ 重取一次
        await load()
      } finally {
        setBusy(false)
      }
    },
    [pick, nameOf, load],
  )

  const removeMember = useCallback(
    async (g: OrgGroup, userId: number): Promise<void> => {
      setBusy(true)
      setErr(null)
      setConflict(null)
      setNotice('')
      try {
        await api.removeGroupMember(g.id, userId)
        setNotice(`已把 ${nameOf(userId)} 移出用户组「${g.name}」`)
        await load()
      } catch (e: unknown) {
        setErr(e)
        setConflict(orgConflictOf(e))
      } finally {
        setBusy(false)
      }
    },
    [nameOf, load],
  )

  const deleteGroup = useCallback(
    (g: OrgGroup): void => {
      confirm({
        title: `删除用户组「${g.name}」？`,
        description: `组内有 ${g.memberIds.length} 位成员（成员账号本身不受影响）`,
        body: (
          <p className="m-0 text-sm leading-relaxed text-ink-soft">
            删除用户组不会删除成员账号。该组在页面上的授权会一并失效（授权记录保留但不再生效）—— 组授权是收紧方向，删除后相关页面可能变得不可读。确定删除？
          </p>
        ),
        confirmLabel: '删除用户组',
        danger: true,
        onConfirm: async (): Promise<void> => {
          setBusy(true)
          setErr(null)
          setConflict(null)
          setNotice('')
          try {
            await api.deleteOrgGroup(g.id)
            setNotice(`已删除用户组「${g.name}」`)
            await load()
          } catch (e: unknown) {
            // 与成员移除同理：失败原因写在卡片上（确认框照常关闭），不让用户隔着遮罩猜
            setErr(e)
            setConflict(orgConflictOf(e))
          } finally {
            setBusy(false)
          }
        },
      })
    },
    [confirm, load],
  )

  return (
    <Card>
      <CardHeader
        title="用户组"
        description="把成员归组后，授权可以按组下发 —— 加人即获得该组的全部授权，移出即失去。"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RefreshCw className="size-4" />}
            aria-label="刷新用户组列表"
            disabled={busy}
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        {/* 建组 */}
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void createGroup()
          }}
        >
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <label htmlFor="org-group-name" className="text-xs font-medium text-ink-soft">
              新建用户组名称
            </label>
            <Input
              id="org-group-name"
              value={name}
              invalid={formErr !== null}
              disabled={busy}
              maxLength={GROUP_NAME_MAX}
              placeholder={`1–${GROUP_NAME_MAX} 个字符，例如「编辑部」`}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button variant="primary" size="sm" type="submit" icon={<UserPlus className="size-3.5" />} loading={busy}>
            创建用户组
          </Button>
          {formErr !== null && <span className="text-note text-danger-ink">{formErr}</span>}
        </form>
        <p className="m-0 mt-2 text-xs leading-relaxed text-muted">
          组名在组织内唯一；同名会撞唯一约束（服务端 409）。**没有改名端点** —— 名字写错了只能删掉重建，
          而重建会连带丢失该组的成员与授权关系。
        </p>

        {notice !== '' && (
          <p role="status" className="m-0 mt-3 rounded-md border border-ok-line bg-ok-bg px-3 py-1.5 text-note text-ok-ink">
            {notice}
          </p>
        )}
        {conflict !== null && (
          <p role="alert" className="m-0 mt-3 rounded-md border border-warn-line bg-warn-bg px-3 py-1.5 text-note text-warn-ink">
            {conflict}
          </p>
        )}
        {err !== null && (
          <div className="mt-3">
            <ErrorNotice error={err} role="alert" />
          </div>
        )}

        <div className="mt-4">
          {groups === null && err === null ? (
            <LoadingState label="正在加载用户组…">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </LoadingState>
          ) : groups !== null && groups.length === 0 ? (
            <EmptyState
              title="还没有用户组"
              hint="用上面的表单建一个组，再把成员加进去 —— 之后在权限治理里就能按组授权。"
            />
          ) : groups !== null ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {groups.map((g) => {
                const inGroup = new Set(g.memberIds)
                const candidates = (members ?? []).filter((m) => !inGroup.has(m.userId))
                return (
                  <li key={g.id} className="rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{g.name}</span>
                      <Badge tone="neutral">{g.memberIds.length} 位成员</Badge>
                      <span className="text-xs text-muted">创建于 {fmtTime(g.createdAt)}</span>
                      <Button
                        className="ml-auto"
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="size-3.5" />}
                        disabled={busy}
                        onClick={() => deleteGroup(g)}
                      >
                        删除用户组
                      </Button>
                    </div>

                    {/* 组内成员：标签 + 单个移出（移出即失去该组带来的授权，不做二次确认） */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {g.memberIds.length === 0 ? (
                        <span className="text-xs text-muted">组里还没有成员</span>
                      ) : (
                        g.memberIds.map((id) => (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-ink-soft"
                          >
                            {nameOf(id)}
                            <button
                              type="button"
                              aria-label={`把 ${nameOf(id)} 移出用户组 ${g.name}`}
                              disabled={busy}
                              onClick={() => void removeMember(g, id)}
                              className={cn(
                                'inline-flex size-4 items-center justify-center rounded-full',
                                'text-muted hover:bg-hover hover:text-danger-ink',
                                'disabled:cursor-not-allowed disabled:opacity-55',
                              )}
                            >
                              <X aria-hidden="true" className="size-3" />
                            </button>
                          </span>
                        ))
                      )}
                    </div>

                    {/* 加成员：成员下拉（本页仅管理员可见，故可以直接拉 orgMembers） */}
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`org-group-add-${g.id}`} className="text-xs font-medium text-ink-soft">
                          向「{g.name}」添加成员
                        </label>
                        <select
                          id={`org-group-add-${g.id}`}
                          className={SELECT_CLASS}
                          value={pick[g.id] ?? ''}
                          disabled={busy || candidates.length === 0}
                          onChange={(e) => setPick((p) => ({ ...p, [g.id]: e.target.value }))}
                        >
                          <option value="">
                            {candidates.length === 0 ? '（组织成员都已在组里）' : '选择成员…'}
                          </option>
                          {candidates.map((m) => (
                            <option key={m.userId} value={String(m.userId)}>
                              {m.displayName}（{m.email}）
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<UserPlus className="size-3.5" />}
                        disabled={busy || (pick[g.id] ?? '') === ''}
                        onClick={() => void addMember(g)}
                      >
                        加入用户组
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="m-0 text-sm text-muted">{errorLine(err)}</p>
          )}
        </div>
      </CardBody>

      <ConfirmDialog
        request={request}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      />
    </Card>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
