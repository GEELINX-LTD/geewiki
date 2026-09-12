/**
 * 组织成员（M4）—— `GET /api/org/members` 与 `PUT / DELETE /api/org/members/:userId`。
 * ============================================================================
 *
 * ## 为什么成员列表是本页的核心
 *
 * 12 个组织端点里只有 `GET /api/org` 对普通成员开放，其余全部要 `admin+`
 * （owner / admin）—— 因此这一批界面整页按 `administer` 门控（见 `pages/OrgPage.tsx`），
 * 而成员表就是"谁能进来、谁是什么角色"的唯一可视面。
 *
 * ## 两条界面规则必须在**选项层面**收敛，而不是等 403/409
 *
 * 1. **涉及 owner 的变更仅 owner 可做**（后端 `touchesOwner` 判据）；
 * 2. **自己不能改自己**（把自己降级会立刻让自己进不来这一页）。
 *
 * 两条都由 `lib/orgPlan.ts` 的 `roleChangeOptions()` 表达：无权时返回空数组，
 * 这里就把该行渲染成**只读文本 + 原因**，而不是一个空下拉或点了必然失败的选项。
 * 即便真撞上服务端（409 `last_owner` / `cannot_remove_self`），也走
 * `orgConflictText()` 给可见提示 —— 前端收敛是体验，服务端判定才是安全。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { api, type OrgMember, type OrgRole } from '../../api'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { ConfirmDialog, useConfirm } from '../../ui/ConfirmDialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { cn } from '../../ui/cn'
import { ORG_ROLE_LABEL, orgConflictOf, roleChangeOptions } from '../../lib/orgPlan'
import { refreshCapabilitiesIfVisible } from '../../lib/authStore'
import { errorLine } from '../../lib/errorText'

const SELECT_CLASS = cn(
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
  'focus:border-accent',
)

export function MembersCard({
  selfUserId,
  actorRole,
}: {
  /** 当前登录用户的 id（`null` = 未知，此时"自己"那一行不会被认为是可以改的） */
  selfUserId: number | null
  /** 当前登录用户的组织角色 —— 与 `capabilities.administer` 同源，用于收敛角色选项 */
  actorRole: OrgRole
}): ReactNode {
  const [rows, setRows] = useState<OrgMember[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const { request, confirm, close } = useConfirm()

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      const r = await api.orgMembers()
      setRows(r.members)
    } catch (e: unknown) {
      setErr(e)
      setRows(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const changeRole = useCallback(
    async (m: OrgMember, next: OrgRole): Promise<void> => {
      setBusyId(m.userId)
      setErr(null)
      setConflict(null)
      setNotice('')
      try {
        await api.setOrgMemberRole(m.userId, next)
        setNotice(`已把 ${m.displayName} 的角色改为「${ORG_ROLE_LABEL[next]}」`)
        await load()
        /*
         * 失效策略：**只有改到自己头上时**才重取能力。角色一变，`capabilities.administer`
         * 就可能跟着变（降级后本页与运维入口都该消失）；改别人不影响"我能做什么"，
         * 白白多发一次 `/api/auth/state` 没有意义。
         *
         * 走 `refreshCapabilitiesIfVisible()` 而不是 `loadAuth()`：后者会把整个身份
         * （含页面列表缓存）翻新一遍，而这里只是"我的能力可能变了"这一条增强；
         * 该函数本身还会判可见性、失败静默（见 authStore 的注释）。
         */
        if (selfUserId !== null && m.userId === selfUserId) await refreshCapabilitiesIfVisible()
      } catch (e: unknown) {
        setErr(e)
        setConflict(orgConflictOf(e))
        // 冲突（409/403）说明**操作没发生** ⇒ 列表可能已被他人改动，重取一次再让用户重试
        await load()
      } finally {
        setBusyId(null)
      }
    },
    [load, selfUserId],
  )

  const removeMember = useCallback(
    (m: OrgMember): void => {
      confirm({
        title: `移除成员「${m.displayName}」？`,
        description: m.email,
        body: (
          <p className="m-0 text-sm leading-relaxed text-ink-soft">
            移除后该用户立即失去组织内一切访问权限（含其所在的用户组）；其访问申请与授权记录保留。确定移除？
          </p>
        ),
        confirmLabel: '移除成员',
        danger: true,
        onConfirm: async (): Promise<void> => {
          setBusyId(m.userId)
          setErr(null)
          setConflict(null)
          setNotice('')
          try {
            await api.removeOrgMember(m.userId)
            setNotice(`已移除成员 ${m.displayName}`)
            await load()
            if (selfUserId !== null && m.userId === selfUserId) {
              await refreshCapabilitiesIfVisible()
            }
          } catch (e: unknown) {
            /*
             * 这里**吞掉异常而不是往上抛**：`ConfirmDialog` 的约定是 reject ⇒ 不关闭对话框
             * （把失败留在屏幕上）。而 409 `cannot_remove_self` / `last_owner` 是
             * "操作根本没发生"的确定性失败，原因写在卡片上比压在遮罩后面更清楚 ——
             * 确认框照常关闭，用户马上读到该怎么做（这两条的下一步动作都不是"重试"）。
             */
            setErr(e)
            setConflict(orgConflictOf(e))
          } finally {
            setBusyId(null)
          }
        },
      })
    },
    [confirm, load, selfUserId],
  )

  return (
    <Card>
      <CardHeader
        title="成员"
        description="组织成员与角色。角色决定能力（能否管理），与「某条内容对谁可见」是两件事。"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RefreshCw className="size-4" />}
            aria-label="刷新成员列表"
            disabled={busyId !== null}
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        {notice !== '' && (
          <p role="status" className="m-0 mb-3 rounded-md border border-ok-line bg-ok-bg px-3 py-1.5 text-note text-ok-ink">
            {notice}
          </p>
        )}
        {conflict !== null && (
          <p role="alert" className="m-0 mb-3 rounded-md border border-warn-line bg-warn-bg px-3 py-1.5 text-note text-warn-ink">
            {conflict}
          </p>
        )}
        {err !== null && (
          <div className="mb-3">
            <ErrorNotice error={err} role="alert" />
          </div>
        )}

        {rows === null && err === null ? (
          <LoadingState label="正在加载成员列表…">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </LoadingState>
        ) : rows !== null && rows.length === 0 ? (
          <EmptyState
            title="组织里还没有成员"
            hint="这通常意味着数据尚未初始化。组织成员在有人接受邀请后出现。"
          />
        ) : rows !== null ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-label="组织成员">
              {/* 表格有可见标题（CardHeader），caption 用 sr-only 补一句读屏用的说明 */}
              <caption className="sr-only">
                组织成员列表：邮箱、昵称、角色与加入时间。拥有者可改角色、管理员可移除成员。
              </caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">邮箱</th>
                  <th scope="col" className="py-1 pr-3 font-medium">昵称</th>
                  <th scope="col" className="py-1 pr-3 font-medium">角色</th>
                  <th scope="col" className="py-1 pr-3 font-medium">加入时间</th>
                  <th scope="col" className="py-1 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const isSelf = selfUserId !== null && m.userId === selfUserId
                  // `selfUserId ?? -1`：身份未知（首帧）时用一个**不可能是合法 userId** 的哨兵，
                  // 免得把"未知"当成"就是自己"而误关掉所有人的角色下拉。
                  const options = roleChangeOptions(actorRole, m.role, selfUserId ?? -1, m.userId)
                  return (
                    <tr key={m.userId} className="border-t border-line">
                      <td className="py-1.5 pr-3 font-mono text-xs">{m.email}</td>
                      <td className="py-1.5 pr-3">
                        {m.displayName}
                        {isSelf && <span className="ml-1 text-xs text-muted">（你）</span>}
                      </td>
                      <td className="py-1.5 pr-3">
                        {options.length === 0 ? (
                          /*
                           * 无可选项 ⇒ **只读文本 + 原因**，不渲染空下拉：
                           * 一个点了没有任何选项、或注定 403 的下拉，比不能改更让人困惑。
                           */
                          <span className="inline-flex flex-wrap items-center gap-1.5 text-ink-soft">
                            {ORG_ROLE_LABEL[m.role]}
                            <span className="text-xs text-muted">
                              {isSelf ? '（不能修改自己的角色）' : '（涉及拥有者的变更需要拥有者操作）'}
                            </span>
                          </span>
                        ) : (
                          <select
                            aria-label={`修改 ${m.displayName} 的角色`}
                            className={SELECT_CLASS}
                            value={m.role}
                            disabled={busyId !== null}
                            onChange={(e) => void changeRole(m, e.target.value as OrgRole)}
                          >
                            {options.map((r) => (
                              <option key={r} value={r}>
                                {ORG_ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{fmtTime(m.joinedAt)}</td>
                      <td className="py-1.5">
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Trash2 className="size-3.5" />}
                          disabled={busyId !== null}
                          onClick={() => removeMember(m)}
                        >
                          移除
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-sm text-muted">{errorLine(err)}</p>
        )}
      </CardBody>

      {/* 危险操作确认：全站统一组件，不用浏览器原生弹窗（见 ui/ConfirmDialog.tsx） */}
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
