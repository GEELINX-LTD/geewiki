/**
 * 邀请（M4）—— `GET/POST /api/org/invitations` 与 `DELETE /api/org/invitations/:id`。
 * ============================================================================
 *
 * ## ★ 一次性令牌的呈现纪律（本文件最要紧的部分）
 *
 * `POST /api/org/invitations` 的响应里带一个 `token`，而**库里只有它的 sha256**：
 * 这是它唯一一次出现在世界里。因此界面必须把它当成"一次性凭据"而不是普通字段：
 *
 * 1. **只在"刚创建成功"的分支里渲染**（`created !== null`），进列表、刷新、切换页面
 *    都拿不到它 —— 列表端点根本没有这个字段（这是服务端的保证，不是前端的自觉）；
 * 2. **关闭即清空**（`setCreated(null)`），不留在 DOM 里，也不进浏览器历史；
 * 3. **不得写入 URL / 本地存储 / 控制台**：写进去等于把一次性凭据变成长期凭据
 *    （URL 进历史与 Referer、本地存储被 XSS 读走、控制台被排障者顺手复制）。
 *    本文件因此**一行**相关调用都没有 —— 有源码守卫钉住这一点（`test/orgPage.test.ts`）。
 *
 * ## Guest 通道 ≠ viewer
 *
 * `orgRole: null` 是"入伙但**不给**组织角色"：他不会出现在成员列表里，只能靠单条授权
 * 或页面授权访问。把它渲染成 `viewer`（或"最低档角色"）会让管理员按错误的假设发邀请，
 * 所以下拉里它是一个**显式选项**、有独立文案，且**不是默认值**（默认落在最窄的具名角色）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Copy, MailPlus, RefreshCw, Trash2 } from 'lucide-react'
import { api, type OrgGroup, type OrgInvitationView } from '../../api'
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
import { copyText } from '../../lib/clipboard'
import {
  INVITATION_ROLE_OPTIONS,
  INVITATION_STATE_LABEL,
  INVITATION_GUEST_VALUE,
  ORG_ROLE_LABEL,
  emailError,
  invitationRoleValue,
  invitationState,
  orgConflictOf,
} from '../../lib/orgPlan'
import { errorLine } from '../../lib/errorText'

const SELECT_CLASS = cn(
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
  'focus:border-accent',
)

/** 表单里"不入组"的取值（`<option value="">`），提交时映射成 `groupId: null` */
const NO_GROUP_VALUE = ''

export function InvitationsCard(): ReactNode {
  const [rows, setRows] = useState<OrgInvitationView[] | null>(null)
  const [groups, setGroups] = useState<OrgGroup[]>([])
  const [err, setErr] = useState<unknown>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const { request, confirm, close } = useConfirm()

  const [email, setEmail] = useState('')
  /** 默认 `viewer`（最窄的**具名**角色）—— Guest 通道必须被显式选中，不能是默认态 */
  const [roleValue, setRoleValue] = useState<string>('viewer')
  const [groupValue, setGroupValue] = useState<string>(NO_GROUP_VALUE)
  const [formErr, setFormErr] = useState<string | null>(null)

  /**
   * 刚签发的**一次性令牌**。只存令牌与邮箱（不存整条邀请）：少存一份就少一处被顺手回显的机会。
   * 关闭（关闭按钮 / 重新签发）即置 `null`。
   */
/**
   * `email === null` ⇒ **通用码**（不绑定邮箱）。
   * `link` 在**创建那一刻**就拼好（见 `submit`），于是渲染期不碰 `location` ——
   * 该拼一次的东西拼一次，也让"复制的是链接"这件事只有一个真源。
   */
  const [created, setCreated] = useState<{
    token: string
    email: string | null
    link: string
  } | null>(null)
  const [copyHint, setCopyHint] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      // 组列表只为下拉与"这条邀请入了哪个组"的名称解析，故与邀请列表一起取
      const [inv, g] = await Promise.all([api.orgInvitations(), api.orgGroups()])
      setRows(inv.invitations)
      setGroups(g.groups)
    } catch (e: unknown) {
      setErr(e)
      setRows(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const groupName = useCallback(
    (groupId: number | null): string => {
      if (groupId === null) return '—'
      const g = groups.find((x) => x.id === groupId)
      return g === undefined ? `#${groupId}` : g.name
    },
    [groups],
  )

  const submit = useCallback(async (): Promise<void> => {
    /*
     * 邮箱**可选**（2026-09-17 起）：留空 ⇒ 签发**通用码**，持码者注册时自填邮箱。
     * 填了 ⇒ 定向码，注册邮箱必须与它一致。
     *
     * 注意"可选"不等于"不校验"：一旦填了，格式仍然要走同一份规则（`emailError`）——
     * 否则一个拼错的邮箱会签发出一条**永远无法兑换**的定向码，而管理员看不出来
     * （他以为只是"发给了那个人"）。
     */
    const typed = email.trim()
    if (typed !== '') {
      const bad = emailError(email)
      if (bad !== null) {
        setFormErr(bad)
        return
      }
    }
    setFormErr(null)
    setBusy(true)
    setErr(null)
    setConflict(null)
    setNotice('')
    setCopyHint('')
    /*
     * 重新签发即**作废上一个令牌的展示**（它仍然有效，但已经从屏幕上撤下）：
     * 同一屏上出现两个一次性令牌，多半会复制错一个。
     */
    setCreated(null)
    try {
      const r = await api.createInvitation({
        // 留空即不传：服务端据此落成 NULL（通用码）
        ...(typed === '' ? {} : { email: typed.toLowerCase() }),
        orgRole: invitationRoleValue(roleValue),
        groupId: groupValue === NO_GROUP_VALUE ? null : Number(groupValue),
      })
      /*
       * ★ 邀请链接在**这里**拼：`#/invite/<token>`（哈希路由，见 `pages/InvitePage.tsx`）。
       *
       * 选哈希而不是查询串是刻意的：**URL 片段不会发给服务端** —— 它不进访问日志、
       * 也不随 Referer 外泄（`?token=` 两样都会）。唯一残留是**被邀请人自己**的浏览器历史，
       * 而那是"点链接加入"这种形态无法避免的（也是业界标准做法）。
       *
       * 本文件从头到尾**只读** `location.origin`，绝不写 location / history —— 有守卫钉住。
       */
      const link = `${window.location.origin}/#/invite/${r.token}`
      setCreated({ token: r.token, email: r.invitation.email, link })
      setEmail('')
      await load()
    } catch (e: unknown) {
      setErr(e)
      setConflict(orgConflictOf(e))
    } finally {
      setBusy(false)
    }
  }, [email, roleValue, groupValue, load])

  const copyToken = useCallback(async (): Promise<void> => {
    if (created === null) return
    const outcome = await copyText(created.link)
    setCopyHint(
      outcome === 'ok'
        ? '已复制到剪贴板。'
        : '当前环境不允许自动复制，请手动选中上面的链接后按 ⌘/Ctrl+C。',
    )
  }, [created])

  const revoke = useCallback(
    (inv: OrgInvitationView): void => {
      const accepted = inv.acceptedAt !== null
      confirm({
        title: `撤销${inv.email === null ? '这个通用邀请码' : `发给 ${inv.email} 的邀请`}？`,
        body: (
          <>
            <p className="m-0 text-sm leading-relaxed text-ink-soft">
              撤销后该令牌立即失效，对方点链接将无法加入。确定撤销？
            </p>
            {accepted && (
              /*
               * 服务端对"已接受"的邀请同样是无条件删行（不区分状态），而成员身份在接受时就
               * 已写入 org_members ⇒ 撤销**不会**把人踢出去。不说清这一点，管理员会以为
               * 撤销 = 移除成员，于是用错工具、或者不敢点。
               */
              <p className="m-0 mt-2 text-sm leading-relaxed text-warn-ink">
                这条邀请已被接受：撤销只删除这条记录，已入伙的成员身份与其所在的用户组不受影响。
                要移除该成员，请到上方「成员」卡片操作。
              </p>
            )}
          </>
        ),
        confirmLabel: '撤销邀请',
        danger: true,
        onConfirm: async (): Promise<void> => {
          setBusy(true)
          setErr(null)
          setConflict(null)
          setNotice('')
          try {
            await api.revokeInvitation(inv.id)
            setNotice(`已撤销${inv.email === null ? '该通用邀请码' : `发给 ${inv.email} 的邀请`}`)
            await load()
          } catch (e: unknown) {
            // 失败原因写在卡片上（确认框照常关闭），不让用户隔着遮罩猜
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
        title="邀请"
        description="签发邀请令牌，对方凭它入伙；令牌只显示一次，库里只存哈希。"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RefreshCw className="size-4" />}
            aria-label="刷新邀请列表"
            disabled={busy}
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        {/* 签发表单 */}
        <form
          className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="invite-email" className="text-xs font-medium text-ink-soft">
                受邀人邮箱（可选）
              </label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                invalid={formErr !== null}
                disabled={busy}
                placeholder="someone@example.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="invite-role" className="text-xs font-medium text-ink-soft">
                组织角色
              </label>
              <select
                id="invite-role"
                className={SELECT_CLASS}
                value={roleValue}
                disabled={busy}
                onChange={(e) => setRoleValue(e.target.value)}
              >
                {INVITATION_ROLE_OPTIONS.map((o) => (
                  <option key={o.id ?? INVITATION_GUEST_VALUE} value={o.id ?? INVITATION_GUEST_VALUE}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="invite-group" className="text-xs font-medium text-ink-soft">
                入伙时加入的用户组（可不选）
              </label>
              <select
                id="invite-group"
                className={SELECT_CLASS}
                value={groupValue}
                disabled={busy}
                onChange={(e) => setGroupValue(e.target.value)}
              >
                <option value={NO_GROUP_VALUE}>不加入任何用户组</option>
                {groups.map((g) => (
                  <option key={g.id} value={String(g.id)}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" type="submit" icon={<MailPlus className="size-3.5" />} loading={busy}>
              签发邀请
            </Button>
            {formErr !== null && <span className="text-note text-danger-ink">{formErr}</span>}
          </div>

          <p className="m-0 text-xs leading-relaxed text-muted">
            Guest（无组织角色）不会出现在成员列表里，只能通过单条授权或页面授权获得访问。
            它**不是**"最低档角色"：`viewer` 是组织成员、能按组织档位读到组织内容，Guest 不能。
          </p>
        </form>

        {/*
          ★ 一次性令牌：**只在刚创建成功时渲染**。这里没有"再来一次"的入口，
          关闭即 setCreated(null)，列表里也永远不会有它。
        */}
        {created !== null && (
          <div className="mt-3 rounded-md border border-ok-line bg-ok-bg p-3">
            <p role="status" className="m-0 text-note text-ok-ink">
              {created.email === null
                ? '已签发一个通用邀请码（不限定邮箱）。'
                : `已为 ${created.email} 签发邀请。`}
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="flex min-w-[18rem] flex-1 flex-col gap-1">
                <label htmlFor="invite-token" className="text-xs font-medium text-ink-soft">
                  邀请链接（只显示一次）
                </label>
                <Input
                  id="invite-token"
                  readOnly
                  value={created.link}
                  aria-label="邀请链接（只显示一次）"
                  className="font-mono text-xs"
                  // 聚焦即全选：用户按 ⌘/Ctrl+C 就能拿到，不必自己拖选（剪贴板降级路径要用到）
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                icon={<Copy className="size-3.5" />}
                onClick={() => void copyToken()}
              >
                复制链接
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                我知道了，关闭
              </Button>
            </div>
            <p className="m-0 mt-2 text-xs leading-relaxed text-ink-soft">
              这条链接只显示一次，关闭后无法再次查看 —— 请立即复制并发给受邀人。
            </p>
            <p className="m-0 mt-1 break-all font-mono text-xs leading-relaxed text-muted">
              邀请码原文：{created.token}
            </p>
            <p className="m-0 mt-1 text-xs leading-relaxed text-muted">
              对方点开链接即进入注册页：未登录就可以填**自己的**邮箱、用户名与口令开户；
              若他已有账号，则会用当前账号直接入伙。两种都走同一个邀请码，且只能用一次。
            </p>
            {copyHint !== '' && (
              <p role="status" className="m-0 mt-1 text-xs text-ink-soft">
                {copyHint}
              </p>
            )}
          </div>
        )}

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

        {/* 列表 */}
        <div className="mt-4">
          {rows === null && err === null ? (
            <LoadingState label="正在加载邀请列表…">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </LoadingState>
          ) : rows !== null && rows.length === 0 ? (
            <EmptyState
              title="还没有邀请"
              hint="用上面的表单签发一条 —— 令牌只显示一次，签发后请立即复制并发给受邀人。"
            />
          ) : rows !== null ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label="邀请列表">
                <caption className="sr-only">
                  邀请列表：邮箱、授予的组织角色、入伙时加入的用户组、过期时间与状态。
                </caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">邮箱</th>
                    <th scope="col" className="py-1 pr-3 font-medium">组织角色</th>
                    <th scope="col" className="py-1 pr-3 font-medium">用户组</th>
                    <th scope="col" className="py-1 pr-3 font-medium">过期时间</th>
                    <th scope="col" className="py-1 pr-3 font-medium">状态</th>
                    <th scope="col" className="py-1 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((inv) => {
                    const state = invitationState(inv)
                    return (
                      <tr key={inv.id} className="border-t border-line">
                        <td className="py-1.5 pr-3 font-mono text-xs">
                          {inv.email === null ? (
                            <span className="text-muted">通用码（不限定邮箱）</span>
                          ) : (
                            inv.email
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          {inv.orgRole === null ? (
                            /*
                             * Guest 通道**必须与 viewer 长得不一样**：它是"没有角色"，
                             * 不是"角色很窄"。用 Badge 而不是普通文本，正是为了让它
                             * 在一列角色里一眼可辨。
                             */
                            <Badge tone="neutral">Guest 通道</Badge>
                          ) : (
                            ORG_ROLE_LABEL[inv.orgRole]
                          )}
                        </td>
                        <td className="py-1.5 pr-3">{groupName(inv.groupId)}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{fmtTime(inv.expiresAt)}</td>
                        <td className="py-1.5 pr-3">
                          <Badge tone={STATE_TONE[state]}>{INVITATION_STATE_LABEL[state]}</Badge>
                        </td>
                        <td className="py-1.5">
                          <Button
                            variant="danger"
                            size="sm"
                            icon={<Trash2 className="size-3.5" />}
                            disabled={busy}
                            onClick={() => revoke(inv)}
                          >
                            撤销
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
        </div>

        <p className="m-0 mt-3 text-xs leading-relaxed text-muted">
          服务端只回最多 200 条邀请，且**不回 token 字段** —— 令牌只在签发那一次出现。
          已过期但未接受的邀请可以用「审计与运维」里的回收动作清理；已接受的是入伙记录，不会被回收。
        </p>
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

/** 邀请状态 → Badge 语义色（不引颜色，只说"这是什么状态"） */
const STATE_TONE = {
  accepted: 'ok',
  expired: 'warn',
  pending: 'accent',
} as const

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
