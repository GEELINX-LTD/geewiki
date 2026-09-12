/**
 * 块级授权（M2）—— `GET /api/pages/:slug/blocks` 与块的 `POST/DELETE …/grants`。
 * ============================================================================
 *
 * ## 这个端点**刻意不含正文**，界面也必须说清
 *
 * `GET /api/pages/:slug/blocks` 只回结构与授权（`id/ordinal/kind/visibility/inherit/marker/tier/grants`），
 * **没有 `text`**：受限块的正文按定义不该出现在治理列表里 —— 一旦带上，这个端点立刻变成
 * "只要可见性管理权就能读到所有 `granted` 块正文"的旁路，而 `granted` 档的语义恰恰是
 * "默认谁都不能看"。所以这里在列表上方**显式声明**这一事实，免得管理员以为"看不到正文是加载失败"。
 *
 * ## 为什么没有"改块档位"的控件
 *
 * 块档位由作者在 Markdown 里用 `<!--gated:org-->` / `<!--gated:granted-->` 声明，保存正文时
 * 解析入库；**后端没有改块档位的端点**。凭空造一个按钮（或造一个改不动的下拉）比不提供更坏：
 * 前者点了必然 404，后者让人以为自己改成功了。这里只**只读地**展示声明档位、`tier` 的含义，
 * 以及"本页档位下允许的块档位集合"（`blockVisibilityOptions()` 的收敛结果）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { api, type BlockRow, type GrantRole, type SubjectKind } from '../../api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { Input } from '../../ui/Input'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { cn } from '../../ui/cn'
import {
  BLOCK_VISIBILITIES,
  GRANT_ROLE_OPTIONS,
  SUBJECT_KIND_OPTIONS,
  blockVisibilityOptions,
  expiresAtFromLocal,
  expiryLabel,
  narrowingHint,
  subjectIdError,
  visibilityLabel,
} from '../../lib/accessPlan'
import { errorLine } from '../../lib/errorText'

/** 每块的表单状态（只保存正在编辑的那一块，避免几十块时 state 爆炸） */
interface Draft {
  blockId: number
  subjectKind: SubjectKind
  subjectId: string
  role: GrantRole
  expiresLocal: string
  error: string | null
}

export function BlocksSection({
  slug,
  pageVisibility,
  onChanged,
}: {
  slug: string
  /** 该页**当前**档位（来自宿主已取的页面详情）—— 块的档位选项必须按它收敛 */
  pageVisibility: string
  onChanged?: () => void
}): ReactNode {
  const [blocks, setBlocks] = useState<BlockRow[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      const r = await api.blocks(slug)
      setBlocks(r.blocks)
    } catch (e: unknown) {
      setErr(e)
      setBlocks(null)
    }
  }, [slug])

  useEffect(() => {
    void load()
  }, [load])

  const allowed = blockVisibilityOptions(pageVisibility, BLOCK_VISIBILITIES)

  const openDraft = (blockId: number): void =>
    setDraft({ blockId, subjectKind: 'user', subjectId: '', role: 'viewer', expiresLocal: '', error: null })

  const submit = useCallback(
    async (block: BlockRow): Promise<void> => {
      if (draft === null || draft.blockId !== block.id) return
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
         * 所以当块比页面宽时，这条授权并不会突破页面上限 —— 必须说出来，
         * 否则用户会以为"授权没生效"（或者更糟：以为页面已经放宽）。
         */
        setNotice(
          `已在第 ${block.ordinal} 块添加授权：${draft.subjectKind === 'group' ? '用户组' : '用户'} ` +
            `${draft.subjectId.trim()} → ${draft.role}。` +
            `该块自身档位为「${visibilityLabel(r.block_visibility)}」。` +
            `${narrowingHint({ visibility: r.block_visibility, tier: block.tier }, pageVisibility)}`,
        )
        setDraft(null)
        await load()
        onChanged?.()
      } catch (e: unknown) {
        setErr(e)
      } finally {
        setBusy(false)
      }
    },
    [slug, draft, pageVisibility, load, onChanged],
  )

  const remove = useCallback(
    async (block: BlockRow, grantId: number, subjectId: string): Promise<void> => {
      const ok = window.confirm(`撤销第 ${block.ordinal} 块对「${subjectId}」的授权？撤销后对方立刻失去该块的访问权。`)
      if (!ok) return
      setBusy(true)
      setErr(null)
      setNotice('')
      try {
        await api.removeBlockGrant(slug, block.id, grantId)
        setNotice(`已撤销第 ${block.ordinal} 块的授权 #${grantId}`)
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
        title="块级授权"
        description="按段落/代码块单独收紧或放行的内容。此列表只含结构与授权，不含正文（受限块的正文不在这里下发）。"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RefreshCw className="size-4" />}
            aria-label="刷新块列表"
            disabled={busy}
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        <p className="m-0 text-xs leading-relaxed text-muted">
          块的档位由作者在正文里用 <code className="font-mono">{'<!--gated:org-->'}</code> /{' '}
          <code className="font-mono">{'<!--gated:granted-->'}</code> 标记声明（保存正文时解析入库），
          本界面不提供改块档位的按钮 —— 后端没有这个端点。块只能比页面更窄（规则 B1）：
          本页档位为「{visibilityLabel(pageVisibility)}」，因此块档位只能取
          {allowed.length === 0
            ? '（没有可比页面更窄的档位）'
            : `「${allowed.map((v) => visibilityLabel(v)).join('」「')}」`}
          。
        </p>

        {notice !== '' && (
          <p
            role="status"
            className="m-0 mt-3 rounded-md border border-ok-line bg-ok-bg px-3 py-1.5 text-note leading-relaxed text-ok-ink"
          >
            {notice}
          </p>
        )}
        {err !== null && (
          <div className="mt-3">
            <ErrorNotice error={err} role="alert" />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3">
          {blocks === null && err === null ? (
            <LoadingState label="正在加载块列表…">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </LoadingState>
          ) : blocks !== null && blocks.length === 0 ? (
            <EmptyState
              title="这一页还没有解析出的块"
              /*
                归因必须有后端依据（本批 R9）。旧文案说"检索插件尚未安装 ⇒ 块列表可能为空"是**错的**：
                没装 `@geewiki/search` 时 `blocks_fts` 这张表不存在，索引同步只是"尽力而为"并告警一次，
                `blocks` 行照常写入（`packages/plugin-wiki/src/blocks.ts`）。
                真正会让块模型整体不可用的是**后端不是 SQLite**：`blocks_fts` 是 SQLite 专有的 FTS5
                对象，PG 上块写入路径不成立 —— "整个块模型在 PG 上不可用"
                （`packages/plugin-wiki/src/index.ts` 的 `blocksIndexSupported = db.dialect === 'sqlite'`）。
              */
              hint="块在保存正文时解析生成：这一页从未保存过正文，块列表就是空的。若保存过仍为空，则可能是后端不是 SQLite —— 块索引用的 FTS5 是 SQLite 专有对象，PostgreSQL 上整个块模型不可用。"
            />
          ) : blocks !== null ? (
            blocks.map((b) => (
              <div key={b.id} className="rounded-md border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">#{b.ordinal}</Badge>
                  <span className="font-mono text-xs text-muted">{b.kind}</span>
                  <Badge tone={b.tier === null ? 'warn' : 'neutral'}>{visibilityLabel(b.visibility)}</Badge>
                  {b.marker !== null && (
                    <span className="text-xs text-muted">
                      标记 <code className="font-mono">{`<!--gated:${b.marker}-->`}</code>
                    </span>
                  )}
                  {b.inherit && <span className="text-xs text-muted">继承页面档位</span>}
                  <span className="ml-auto">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<KeyRound className="size-3.5" />}
                      disabled={busy}
                      onClick={() => openDraft(b.id)}
                    >
                      添加授权
                    </Button>
                  </span>
                </div>

                <p className="m-0 mt-2 text-xs leading-relaxed text-muted">{narrowingHint(b, pageVisibility)}</p>
                <p className="m-0 mt-1 text-xs text-muted">
                  检索等级（tier）：
                  {b.tier === null ? '无（不属于任何读者等级）' : b.tier}
                  {'　'}已授予 {b.grants.length} 个对象
                </p>

                {b.grants.length > 0 && (
                  <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                    {b.grants.map((g) => (
                      <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <ShieldCheck aria-hidden="true" className="size-3.5 text-ok-ink" />
                        <span>{g.subjectKind === 'group' ? '用户组' : '用户'}</span>
                        <span className="font-mono">{g.subjectId}</span>
                        <span className="text-muted">{g.role}</span>
                        <span className="text-muted">到期 {expiryLabel(g.expiresAt)}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Trash2 className="size-3.5" />}
                          disabled={busy}
                          onClick={() => void remove(b, g.id, g.subjectId)}
                        >
                          撤销
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {draft !== null && draft.blockId === b.id && (
                  <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`block-kind-${b.id}`} className="text-xs font-medium text-ink-soft">
                        授权对象类别
                      </label>
                      <select
                        id={`block-kind-${b.id}`}
                        className={cn(
                          'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
                          'focus:border-accent',
                        )}
                        value={draft.subjectKind}
                        disabled={busy}
                        onChange={(e) =>
                          setDraft({ ...draft, subjectKind: e.target.value === 'group' ? 'group' : 'user' })
                        }
                      >
                        {SUBJECT_KIND_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`block-subject-${b.id}`} className="text-xs font-medium text-ink-soft">
                        对象 id
                      </label>
                      <Input
                        id={`block-subject-${b.id}`}
                        value={draft.subjectId}
                        disabled={busy}
                        invalid={draft.error !== null}
                        onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`block-role-${b.id}`} className="text-xs font-medium text-ink-soft">
                        授予角色
                      </label>
                      <select
                        id={`block-role-${b.id}`}
                        className={cn(
                          'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink',
                          'focus:border-accent',
                        )}
                        value={draft.role}
                        disabled={busy}
                        onChange={(e) => setDraft({ ...draft, role: e.target.value === 'editor' ? 'editor' : 'viewer' })}
                      >
                        {GRANT_ROLE_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`block-expires-${b.id}`} className="text-xs font-medium text-ink-soft">
                        到期时间（留空 = 不过期）
                      </label>
                      <Input
                        id={`block-expires-${b.id}`}
                        type="datetime-local"
                        value={draft.expiresLocal}
                        disabled={busy}
                        onChange={(e) => setDraft({ ...draft, expiresLocal: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                      <Button variant="primary" size="sm" loading={busy} onClick={() => void submit(b)}>
                        确认添加
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                        取消
                      </Button>
                      {draft.error !== null && <span className="text-note text-danger-ink">{draft.error}</span>}
                    </div>
                  </div>
                )}
              </div>
            ))
          ) : (
            <p className="m-0 text-sm text-muted">{errorLine(err)}</p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
