/**
 * **「授权给谁 / 什么角色 / 到什么时候」这组字段的唯一实现**。
 * ============================================================================
 *
 * ## 为什么这四格必须只有一份（一次真实的漂移）
 *
 * 同一件事（添加一条例外授予）发生在两个地方：
 * 1. **段落**授权：编辑器工具栏的锁菜单 →「授权给谁…」（`BlockGrantsDialog` → `BlockGrantEditor`）；
 * 2. **页面**授权：页面「权限」对话框 →「例外授予（页级）」（`GrantsSection`）。
 *
 * 名单端点 `GET /api/org/members|groups` 按作者要求放宽为"任何登录用户可读"之后，
 * 第 1 处改成了**下拉选成员**，第 2 处却仍是**手填「对象 id」**，旁边还留着放宽之前的理由
 * （"列表需要组织管理员权限，本页不拉取它"）—— 作者的真实反馈正是这一条：
 * "权限按钮进去那个页面的还不能下拉选择用户"。**同一个问题在两处各修一遍，必然再漂一次**，
 * 所以字段本体只留这一份，两处都从这里取。
 *
 * ## 三态（判据在 `lib/subjectDirectory.ts`，这里只负责画）
 *
 * 能列名单 ⇒ 下拉选择（`姓名 —— 邮箱` / `组名 —— N 名成员`）；确知被拒、或读取失败 ⇒
 * 手填 id，并**如实**说明原因（说不出原因就别编一个）。有名单时也保留"改用手填 id"的出口：
 * 要授权的人可能不在名单里（账号刚建、名单因分页没列到他）。
 */
import type { ReactNode } from 'react'
import { Input } from '../../ui/Input'
import { cn } from '../../ui/cn'
import type { GrantRole, SubjectKind } from '../../api'
import { GRANT_ROLE_OPTIONS, SUBJECT_ID_MAX, SUBJECT_KIND_OPTIONS } from '../../lib/accessPlan'
import { directoryUnavailableHint, type SubjectDirectory, type SubjectOption } from '../../lib/subjectDirectory'

/** 一条待提交的授予（页面级与段落级共用同一组字段） */
export interface GrantTargetDraft {
  subjectKind: SubjectKind
  subjectId: string
  role: GrantRole
  expiresLocal: string
}

const SELECT_CLASS = cn(
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
  'focus:border-accent',
)

export function GrantTargetFields({
  idPrefix,
  draft,
  onDraftChange,
  directory,
  manualId,
  onManualIdChange,
  busy,
  invalid = false,
}: {
  /**
   * 表单控件 id 的前缀。`<label htmlFor>` 是全文档唯一的 —— 一个页面里可能同时挂着
   * 段落授权与页面授权两套字段，不加前缀就会出现两处同 id，点第二个 label 把焦点送到第一个输入框。
   */
  idPrefix: string
  draft: GrantTargetDraft
  onDraftChange: (next: GrantTargetDraft) => void
  /**
   * 授权对象的"通讯录"：`null` = 还没读到；`available` ⇒ 下拉；`forbidden` / `failed` ⇒ 手填 + 说明。
   */
  directory: SubjectDirectory | null
  /** 手填 id 模式（有名单时也允许切换 —— 要授权的人可能不在名单里） */
  manualId: boolean
  onManualIdChange: (next: boolean) => void
  busy: boolean
  /** 校验失败时把对象输入框标红（错误文案由宿主渲染在提交按钮旁） */
  invalid?: boolean
}): ReactNode {
  const pickable = directory !== null && directory.kind === 'available'
  const unavailableHint = directoryUnavailableHint(directory)
  // 走 `kind === 'available'` 这一步是必须的：`SubjectDirectory` 是三态联合，只有这一支才有名单
  const options: SubjectOption[] =
    directory !== null && directory.kind === 'available'
      ? draft.subjectKind === 'group'
        ? directory.groups
        : directory.users
      : []

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-kind`} className="text-xs font-medium text-ink-soft">
          授权对象类别
        </label>
        <select
          id={`${idPrefix}-kind`}
          className={SELECT_CLASS}
          value={draft.subjectKind}
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, subjectKind: e.target.value === 'group' ? 'group' : 'user' })}
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
        <label htmlFor={`${idPrefix}-subject`} className="text-xs font-medium text-ink-soft">
          {draft.subjectKind === 'group' ? '授权给哪个用户组' : '授权给谁'}
        </label>
        {/*
          ★ 有名单就给选择、没名单才手填。
          "对象 id"曾是一个纯文本框，作者无从知道那个数字是什么（真实反馈："授权时，所谓的 id 是什么"）。
          名单来自 `GET /api/org/members|groups`（本批放宽为任何登录用户可读）；未登录、或运维把端点
          改回 admin 时仍会落到手填那一支 —— 此时必须把"id 是什么、去哪儿看"写在旁边，而不是留空框让人猜。
        */}
        {pickable && !manualId ? (
          <select
            id={`${idPrefix}-subject`}
            className={SELECT_CLASS}
            value={draft.subjectId}
            disabled={busy}
            onChange={(e) => onDraftChange({ ...draft, subjectId: e.target.value })}
          >
            <option value="">（请选择）</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} —— {o.hint}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id={`${idPrefix}-subject`}
            value={draft.subjectId}
            disabled={busy}
            maxLength={SUBJECT_ID_MAX}
            invalid={invalid}
            placeholder={draft.subjectKind === 'group' ? '用户组 id（数字）' : '用户 id（数字）'}
            onChange={(e) => onDraftChange({ ...draft, subjectId: e.target.value })}
          />
        )}
        {/* 手填时把"去哪儿看 id"或"为什么列不出名单"就地写清楚 */}
        {!pickable && unavailableHint !== null && <span className="text-xs text-muted">{unavailableHint}</span>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-role`} className="text-xs font-medium text-ink-soft">
          授予角色
        </label>
        <select
          id={`${idPrefix}-role`}
          className={SELECT_CLASS}
          value={draft.role}
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, role: e.target.value === 'editor' ? 'editor' : 'viewer' })}
        >
          {GRANT_ROLE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-expires`} className="text-xs font-medium text-ink-soft">
          到期时间（留空 = 不过期）
        </label>
        <Input
          id={`${idPrefix}-expires`}
          type="datetime-local"
          value={draft.expiresLocal}
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, expiresLocal: e.target.value })}
        />
        <span className="text-xs text-muted">过期在判定时即失效，不依赖任何清理任务。</span>
      </div>

      {/*
        手填 / 选择的切换。两个方向都要给：有名单时也可能要授权给名单外的人；
        没名单时（未登录、或端点被改回 admin）根本没有选择的余地，那就不放这个开关。
      */}
      {pickable && (
        <p className="m-0 text-xs text-muted sm:col-span-2">
          {manualId ? (
            <button type="button" className="underline" onClick={() => onManualIdChange(false)}>
              从成员名单里选
            </button>
          ) : (
            <button type="button" className="underline" onClick={() => onManualIdChange(true)}>
              要授权的人不在名单里？改用手填 id
            </button>
          )}
        </p>
      )}
    </div>
  )
}
