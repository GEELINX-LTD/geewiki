/**
 * 申请访问（M3）—— 弹出表单 + 「已提交，可撤回」两态。
 * ============================================================================
 *
 * ## 为什么入口必须挂在"拒绝态"而不是等读路径给 403
 *
 * 详情读路径对**所有**主体一律返回 404（防存在性探测：区分 403/404 就等于提供了一个
 * "这个页面存不存在"的探测接口）。代价是用户拿到 404 时分不清"无权"与"不存在" ——
 * 所以申请入口只能由前端在**已知 slug 的拒绝态**上提供（见 `WikiPage` 的 404 分支）。
 * 也因此，本组件**不**试图判断"页面是否存在"：它只提交一次申请，把结果交给服务端回答。
 *
 * ## 两态与撤回句柄
 *
 * 撤回端点按 **id** 定位，而服务端没有"查我的待审申请"的端点（那个 `GET` 是审批人视角、
 * 需要可见性管理权）。所以提交成功后必须把 id 记在本地（`lib/myAccessRequests.ts`），
 * 否则用户刷新一次就再也撤不回 —— "你可以撤回"会变成空头支票。
 * 本地存储不可用时（隐私模式）静默降级：只是少一个撤回按钮，提交本身照常成功。
 *
 * ## 提示条为什么必须**两态共用**（本批 R1 修掉的真实缺陷）
 *
 * 提示条原先只渲染在「已提交」那一态里，而**撤回失败**会把界面切回表单态
 * （服务端说"这条申请已不再是待审"⇒ 本机那条句柄作废，只能退回表单）——
 * 于是提示条正好在需要它的那一刻消失，用户看到界面"静默地"变回表单，会以为撤回成功了。
 * 现在提示条提到两态之外共用渲染，且带 `tone`：`ok`（真的成功了）与 `warn`（冲突/没成功）
 * 用不同配色。**撤销类动作绝不能用成功配色**，否则"没撤成"会被读成"撤成了"。
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Send, Undo2 } from 'lucide-react'
import { ApiError, api, type GrantRole } from '../../api'
import { Button } from '../../ui/Button'
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '../../ui/Dialog'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { Textarea } from '../../ui/Input'
import { focusRing, touchTarget } from '../../ui/a11y'
import { cn } from '../../ui/cn'
import { REQUEST_MESSAGE_MAX, conflictText } from '../../lib/accessPlan'
import { forgetRequest, recallRequest, rememberRequest } from '../../lib/myAccessRequests'

/** 提示条的两种口气：`ok` = 动作真的成功了；`warn` = 冲突/没成功（不得用成功配色） */
type NoticeTone = 'ok' | 'warn'

const ROLE_CHOICES: ReadonlyArray<{ id: GrantRole; label: string; hint: string }> = [
  { id: 'viewer', label: '只想读（viewer）', hint: '能读这一条内容，不能改' },
  { id: 'editor', label: '我想参与编辑', hint: '需要动手改这一条内容时选它；是否批准由管理员决定' },
]

/**
 * 申请访问。
 *
 * ## 两种用法（默认那种一行没改）
 *
 * 1. **自带触发器**（`WikiPage` 的拒绝态）：不传 `open`，组件自己管开关，
 *    渲染一个「申请访问」按钮；
 * 2. **受控**（M4 的附件破图占位块，见 `components/MarkdownBody.tsx`）：入口是**运行时注入
 *    进正文的按钮**（React 不管理那棵子树），只能由外部 `open`/`onOpenChange` 控制，
 *    并用 `withTrigger={false}` 关掉自带按钮 —— 否则页面里会凭空多出一个没人点的按钮。
 *
 * 两种用法共用同一个状态机（提交 / 冲突 / 撤回）：这是本组件存在的理由，
 * 也是**不允许**在调用方另抄一份表单的原因。
 */
export function ApplyAccessDialog({
  slug,
  open: openProp,
  onOpenChange,
  withTrigger = true,
}: {
  slug: string
  /** 受控打开态；不传则由组件内部状态驱动（自带触发器那一路） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 是否渲染自带的「申请访问」按钮 */
  withTrigger?: boolean
}): ReactNode {
  const [innerOpen, setInnerOpen] = useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : innerOpen
  const setOpen = useCallback(
    (next: boolean): void => {
      if (!controlled) setInnerOpen(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )
  const [message, setMessage] = useState('')
  const [role, setRole] = useState<GrantRole>('viewer')
  /*
   * 两态分开存：
   * - `submitted`：**服务端认为你有一条待审申请**（本机记下的，或提交时撞上 409）；
   * - `pendingId`：撤回所需的句柄 —— 本机没记下时可以是 `null`（换设备 / 清了存储），
   *   此时界面照实说"这里无法撤回"，而不是把用户留在"再点一次还是 409"的表单上。
   *
   * 刻意**不**用提示文案判断当前处于哪一态：那会让状态机与一句文案耦合，
   * 改一句措辞就可能换错分支（本仓库对"按 message 文本分支"有明确禁令）。
   */
  const [pendingId, setPendingId] = useState<number | null>(() => recallRequest(slug))
  const [submitted, setSubmitted] = useState<boolean>(() => recallRequest(slug) !== null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  /** 提示条（两态共用，见文件头）：撤回失败的说明必须留在屏幕上，不能被状态切换吃掉 */
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null)

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      const trimmed = message.trim()
      const r = await api.requestAccess(slug, {
        ...(trimmed === '' ? {} : { message: trimmed }),
        role,
      })
      setPendingId(r.id)
      setSubmitted(true)
      rememberRequest(slug, r.id)
      setNotice({ tone: 'ok', text: '申请已提交，等待处理。你可以撤回。' })
    } catch (e: unknown) {
      /*
       * `already_requested` 意味着"服务端认为你有一条待审申请" —— 这正是"已提交"那一态，
       * 只是本机没记下 id（换了设备/清了存储）。此时把界面切到同一态并说明原因，
       * 而不是把用户留在一个"再点一次还是 409"的表单上。
       */
      const code = e instanceof ApiError ? e.code : ''
      if (code === 'already_requested') {
        setPendingId(recallRequest(slug))
        setSubmitted(true)
        // 冲突不是成功：用 warn 口气（`already_requested` 的下一步是"等处理/去撤回"）
        setNotice({
          tone: 'warn',
          // 语境 `apply`：404 在这个端点上指**页面**不存在（见 accessPlan.conflictText）
          text: conflictText(code, 'apply') ?? '你已经提交过申请了，请等待处理。',
        })
        return
      }
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [slug, message, role])

  const withdraw = useCallback(async (): Promise<void> => {
    if (pendingId === null) return
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      await api.withdrawAccessRequest(slug, pendingId)
      forgetRequest(slug)
      setPendingId(null)
      setSubmitted(false)
      setNotice({ tone: 'ok', text: '已撤回申请。你可以再次提交。' })
    } catch (e: unknown) {
      const code = e instanceof ApiError ? e.code : ''
      if (code === 'request_not_pending' || code === 'not_found') {
        // 已被裁决（批准/拒绝）或已撤回：本机那条句柄作废，别再留着骗用户
        forgetRequest(slug)
        setPendingId(null)
        setSubmitted(false)
        /*
         * 退回表单态，但**必须**把"这次没撤成"留在屏幕上（本批 R1）：提示条现在两态共用，
         * 所以它不会随 `setSubmitted(false)` 一起消失。
         * 语境 `request`：这里的 404 是**这条申请**不存在，而不是页面不存在 ——
         * 同一句"这条内容不存在，无法申请"放在撤回上会把动作和对象都说错（本批 R2）。
         */
        setNotice({
          tone: 'warn',
          text: conflictText(code, 'request') ?? '这条申请已被处理，无法再撤回。',
        })
        return
      }
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [slug, pendingId])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setErr(null)
      }}
    >
      {withTrigger && (
        <DialogTrigger asChild>
          <Button variant="primary" size="sm" icon={<Send className="size-3.5" />}>
            申请访问
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        title="申请访问这条内容"
        description="申请会提交给这条内容的管理员审核。你可以随时撤回自己的申请。"
      >
        {/*
          提示条**两态共用**（本批 R1）：撤回失败会把界面切回表单态，
          若提示条只长在「已提交」那一态里，它就正好在需要它的那一刻消失。
        */}
        {notice !== null && (
          <p
            role="status"
            className={cn(
              'm-0 mb-3 rounded-md border px-3 py-1.5 text-note leading-relaxed',
              notice.tone === 'warn'
                ? 'border-warn-line bg-warn-bg text-warn-ink'
                : 'border-ok-line bg-ok-bg text-ok-ink',
            )}
          >
            {notice.text}
          </p>
        )}
        {submitted ? (
          <div className="flex flex-col gap-3">
            {/* 没有提示条时说明"已提交"这一态本身（重新打开弹窗、本机记着 id 的情形） */}
            {notice === null && (
              <p role="status" className="m-0 text-sm leading-relaxed text-ok-ink">
                申请已提交，等待处理。你可以撤回。
              </p>
            )}
            {pendingId !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Undo2 className="size-3.5" />}
                  loading={busy}
                  onClick={() => void withdraw()}
                >
                  撤回申请
                </Button>
                <span className="text-xs text-muted">撤回后可以再次提交。</span>
              </div>
            ) : (
              <p className="m-0 text-xs leading-relaxed text-muted">
                本机没有记下这条申请的编号（换了设备或清理过浏览器数据），因此这里无法撤回；
                如需撤回请联系管理员，或等它被裁决后重新申请。
              </p>
            )}
            {err !== null && <ErrorNotice error={err} role="alert" />}
            <div className="flex justify-end">
              <DialogClose asChild>
                <Button variant="secondary" size="sm">
                  关闭
                </Button>
              </DialogClose>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="apply-message" className="text-xs font-medium text-ink-soft">
                附言（可选，最多 {REQUEST_MESSAGE_MAX} 字）
              </label>
              <Textarea
                id="apply-message"
                rows={3}
                maxLength={REQUEST_MESSAGE_MAX}
                value={message}
                disabled={busy}
                placeholder="说明你为什么需要访问（管理员据此判断）"
                onChange={(e) => setMessage(e.target.value)}
              />
              <span className="self-end text-xs text-muted">
                {message.length}/{REQUEST_MESSAGE_MAX}
              </span>
            </div>

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1 p-0 text-xs font-medium text-ink-soft">希望获得的角色</legend>
              {ROLE_CHOICES.map((c) => (
                <label
                  key={c.id}
                  className={cn('flex cursor-pointer items-start gap-2 text-sm text-ink', touchTarget)}
                >
                  <input
                    type="radio"
                    name="apply-role"
                    className={cn('mt-0.5', focusRing)}
                    value={c.id}
                    checked={role === c.id}
                    disabled={busy}
                    onChange={() => setRole(c.id)}
                  />
                  <span>
                    {c.label}
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">{c.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {err !== null && <ErrorNotice error={err} role="alert" />}

            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="secondary" size="sm" type="button" disabled={busy}>
                  取消
                </Button>
              </DialogClose>
              <Button variant="primary" size="sm" type="submit" loading={busy} icon={<Send className="size-3.5" />}>
                提交申请
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
