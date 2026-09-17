/**
 * **单个块的例外授予编辑区**：列出这一块已有的授权 + 添加 / 撤销。
 * ============================================================================
 *
 * ## 它为什么必须存在（一次真实的功能缺口）
 *
 * 块档位的第三档是 **`granted`（需单独授权）**：标记成这一档的段落**默认谁都读不到**，
 * 只能靠例外授予放人进来（`block_grants`）。曾经这份名单只长在权限对话框的「块级授权」
 * 分区里；那一块按作者要求从对话框移除之后，`granted` 档就变成了**设得出来、却没人能授权**
 * 的死档 —— 作者把一段设成"需单独授权"，然后**没有任何界面**能指定授权给谁。
 *
 * 结论：**授予与档位必须在同一个地方**。档位在编辑器里选（工具栏锁按钮），授予也就该在那里。
 * 本组件同时被两处使用，确保只有一份实现：
 * 1. `BlockGrantsDialog.tsx`（编辑器的锁菜单 →「授权给谁…」，**主路径**）；
 * 2. `BlocksSection.tsx`（只读的段落总览，目前无界面渲染它，保留以便随时恢复）。
 *
 * ## 两条硬约束（来自服务端契约）
 *
 * 1. **授予是"放宽"方向**（设计文档 §2.2）：在 `granted` 档里它是唯一入口；在 `org`/`public`
 *    档里它把组织外的人放进来。所以任何档位下添加授予都是有意义的，界面不按档位禁用。
 * 2. **块 id 只有保存后才有**：`block_grants.block_id` 指向 `blocks.id`，而块是**保存正文时**
 *    解析生成的。因此对"刚写好、还没保存"的段落，本组件（经由 `BlockGrantsDialog`）会明确
 *    说明"先保存才能授权"，而不是给一个点了必然 404 的按钮。
 */
import { useCallback, useState, type ReactNode } from 'react'
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { api, type BlockRow } from '../../api'
import { Button } from '../../ui/Button'
import { describeSubject, type SubjectDirectory } from '../../lib/subjectDirectory'
import { ErrorNotice } from '../../ui/ErrorNotice'
import {
  GRANT_ROLE_OPTIONS,
  expiresAtFromLocal,
  expiryLabel,
  narrowingHint,
  subjectIdError,
  visibilityLabel,
} from '../../lib/accessPlan'
import { GrantTargetFields, type GrantTargetDraft } from './GrantTargetFields'

/**
 * 草稿 = 一组授权字段 + 本表单自己的校验文案。
 * 字段本体（类别/对象/角色/到期）来自 `GrantTargetFields` —— **页面级授权用的是同一份**，
 * 两处各画一遍就会漂（"权限"对话框那一版曾经还在让人手填 id）。
 */
interface Draft extends GrantTargetDraft {
  error: string | null
}

export function BlockGrantEditor({
  slug,
  block,
  pageVisibility,
  onChanged,
  idPrefix,
  directory,
}: {
  slug: string
  /** 服务端下发的这一块（`id` 是授权的键；`grants` 是当前名单） */
  block: BlockRow
  /** 页面当前档位；`null` = 未知（此时不显示"块不能宽过页面"的推导，而不是编一个） */
  pageVisibility: string | null
  /** 写成功后通知宿主（宿主负责重新取块列表 / 让页面缓存失效） */
  onChanged?: () => void
  /**
   * 表单控件 id 的前缀。同一页可能有多个块（`BlocksSection` 的总览），
   * 而 `<label htmlFor>` 是全文档唯一的 —— 不加前缀就会出现两处同 id、
   * 点第二个 label 把焦点送到第一个输入框。
   */
  idPrefix: string
  /**
   * 授权对象的"通讯录"（成员 / 用户组）。
   *
   * `null` = 还没读到（或本场景不需要）；`{kind:'available'}` ⇒ 给下拉选择；
   * `{kind:'forbidden'}` ⇒ 只能手填，并说明"你没有管理员权限"；
   * `{kind:'failed'}` ⇒ 只能手填，并如实报错（**不谎称没权限**）。
   * 详见 `lib/subjectDirectory.ts` 的文件头：名单端点本批已放宽为"任何登录用户可读"，
   * 但未登录 / 端点被改回 admin / 读取失败时仍会落到手填那一支 —— 三态不能塌成两态。
   */
  directory: SubjectDirectory | null
}): ReactNode {
  const [draft, setDraft] = useState<Draft | null>(null)
  /**
   * 手填 id 模式。默认：**有名单就选择、没名单就手填**；名单可用时也留一个"手填"出口
   * （要授权的人可能不在名单里 —— 例如账号刚建、或名单因分页/筛选没列出他）。
   */
  const [manualId, setManualId] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const [notice, setNotice] = useState('')

  const submit = useCallback(async (): Promise<void> => {
    if (draft === null) return
    const idErr = subjectIdError(draft.subjectId)
    if (idErr !== null) {
      setDraft({ ...draft, error: idErr })
      return
    }
    const expiry = expiresAtFromLocal(draft.expiresLocal)
    if (!expiry.ok) {
      setDraft({ ...draft, error: '到期时间格式不正确，请重新选择（留空表示不过期）' })
      return
    }
    setBusy(true)
    setErr(null)
    setNotice('')
    try {
      const r = await api.addBlockGrant(slug, block.id, {
        subjectKind: draft.subjectKind,
        subjectId: draft.subjectId.trim(),
        role: draft.role,
        expiresAt: expiry.iso,
      })
      /*
       * 响应里的 `block_visibility` 是**该块自身声明**的档位。规则 B1 让"块只能更窄"，
       * 所以当块比页面宽时这条授权并不会突破页面上限 —— 必须说出来，否则用户会以为
       * "授权没生效"（或者更糟：以为页面已经放宽了）。
       */
      // 反馈里用**名字**而不是 id（名单可见时）—— 刚点完"确认添加"的人要能一眼确认加对了人
      const who = describeSubject(draft.subjectKind, draft.subjectId.trim(), directory)
      const tail =
        pageVisibility === null
          ? ''
          : narrowingHint({ visibility: r.block_visibility, tier: block.tier }, pageVisibility)
      setNotice(
        `已添加授权：${who} → ${GRANT_ROLE_OPTIONS.find((o) => o.id === r.role)?.label ?? r.role}。` +
          `该段自身档位为「${visibilityLabel(r.block_visibility)}」。${tail}`,
      )
      setDraft(null)
      onChanged?.()
    } catch (e: unknown) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [slug, draft, block.id, block.tier, pageVisibility, directory, onChanged])

  const remove = useCallback(
    async (grantId: number, subjectId: string): Promise<void> => {
      const ok = window.confirm(`撤销对「${subjectId}」的这段授权？撤销后对方立刻失去这一段的访问权。`)
      if (!ok) return
      setBusy(true)
      setErr(null)
      setNotice('')
      try {
        await api.removeBlockGrant(slug, block.id, grantId)
        setNotice(`已撤销对「${subjectId}」的授权`)
        onChanged?.()
      } catch (e: unknown) {
        setErr(e)
      } finally {
        setBusy(false)
      }
    },
    [slug, block.id, onChanged],
  )

  return (
    <div className="flex flex-col gap-2">
      {block.grants.length === 0 ? (
        <p className="m-0 text-xs text-muted">
          这一段还没有任何例外授予
          {block.visibility === 'granted'
            ? ' —— 它现在是「需单独授权」档，现在没有人能读到它，直到你在下面添加授权对象。'
            : '。'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {block.grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
              <ShieldCheck aria-hidden="true" className="size-3.5 text-ok-ink" />
              {/* id → 名字（名单不可见时退化成 `用户 id 42`，不编造） */}
              <span>{describeSubject(g.subjectKind, g.subjectId, directory)}</span>
              <span className="text-muted">{GRANT_ROLE_OPTIONS.find((o) => o.id === g.role)?.label ?? g.role}</span>
              <span className="text-muted">到期 {expiryLabel(g.expiresAt)}</span>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 className="size-3.5" />}
                disabled={busy}
                onClick={() => void remove(g.id, g.subjectId)}
              >
                撤销
              </Button>
            </li>
          ))}
        </ul>
      )}

      {draft === null ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<KeyRound className="size-3.5" />}
            disabled={busy}
            onClick={() => {
              setManualId(directory === null || directory.kind !== 'available')
              setDraft({ subjectKind: 'user', subjectId: '', role: 'viewer', expiresLocal: '', error: null })
            }}
          >
            添加授权对象
          </Button>
        </div>
      ) : (
        <div className="border-t border-line pt-3">
          <GrantTargetFields
            idPrefix={idPrefix}
            draft={draft}
            onDraftChange={(next) => setDraft({ ...next, error: draft.error })}
            directory={directory}
            manualId={manualId}
            onManualIdChange={setManualId}
            busy={busy}
            invalid={draft.error !== null}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" loading={busy} onClick={() => void submit()}>
              确认添加
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
              取消
            </Button>
            {draft.error !== null && <span className="text-note text-danger-ink">{draft.error}</span>}
          </div>
        </div>
      )}

      {/*
        结果反馈：成功与失败都**就地**说出来（`role="status"` / `alert`）。
        授权是"谁能看到什么"的操作，静默成功与静默失败都不可接受。
      */}
      {notice !== '' && (
        <p role="status" className="m-0 rounded-md border border-ok-line bg-ok-bg px-2 py-1 text-xs text-ok-ink">
          {notice}
        </p>
      )}
      {/* 失败走房子的 `ErrorNotice`（它已带 `role="alert"`，并会按错误码给出可执行的下一步） */}
      {err !== null && <ErrorNotice error={err} role="alert" />}
    </div>
  )
}
