/**
 * VersionDiffDialog —— 版本对比弹窗（回答"**改了哪里、谁改的、什么时候**"）。
 *
 * ## 为什么是"统一视图"而不是"并排"
 * 弹窗宽度以 `min(32rem, 100vw-2rem)` 为基准（见 `ui/Dialog.tsx`），中文正文一行本就长，
 * 并排会把两侧各压到十几字，**读不出句子**，而且窄屏根本放不下（要退化成统一视图 = 两套渲染）。
 * 统一视图（`−` 旧行紧接 `+` 新行）在同样宽度下每行都能完整读，且天然适配 320px。
 *
 * ## 冗余编码（WCAG 1.4.1）
 * 增删**不能只靠颜色**：每行左侧有 `+`/`−` 符号，行首还有"新增/删除"的文字标签（在编号列）。
 *
 * ## 作者信息的降级
 * 后端正在给版本行补 `author`。字段**可能还不存在** ⇒ 这里一律按可选处理，
 * 缺失显示「未记录」——**不猜、不写"匿名"、不留空**（"匿名"会被读成"某人以匿名身份改的"，
 * 而事实是"这条记录没有作者信息"）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { api, ApiError, type VersionMeta } from '../api'
import { Button } from '../ui/Button'
import { Dialog, DialogContent } from '../ui/Dialog'
import { changedSections, diffLines, statsLabel, type DiffOp } from '../lib/textDiff'
import { absoluteTime, relativeTime } from '../lib/timePlan'
import { errorLine } from '../lib/errorText'
import { cn } from '../ui/cn'

/** 作者缺失时的**唯一**表述。不要改成"匿名"。 */
export const UNKNOWN_AUTHOR = '未记录'

export function authorText(author: { displayName?: string | null } | null | undefined): string {
  const name = author?.displayName
  return typeof name === 'string' && name.trim() !== '' ? name : UNKNOWN_AUTHOR
}

/** 版本行的展示标签。注意：**当前版本没有快照行**，`page.version` 本身是当前版本号。 */
export function versionLabelOf(page: { version: number }, index: number): number {
  return page.version - index - 1
}

interface DiffTarget {
  id: number
  /** 该快照在页面内的版本号（v1、v2 …） */
  label: number
  savedAt: string
  author: { id: number; displayName: string | null } | null
}

export function VersionDiffDialog({
  slug,
  page,
  versions,
  target,
  onClose,
  onRestore,
  restoring,
  canRestore,
}: {
  slug: string
  /** 只取需要的字段，避免与页面组件的类型耦合 */
  page: { version: number; title: string; content: string; updated_at: string }
  versions: readonly VersionMeta[]
  /** null = 关闭 */
  target: DiffTarget | null
  onClose: () => void
  onRestore: (t: DiffTarget, content: string) => void
  restoring: boolean
  /**
   * 能否恢复。传 `canManageVisibility`（**不是** `canEdit`）：恢复会改写页面状态，
   * 服务端的四位一体 restore 端点要求的正是这个能力。无此能力时**不渲染**恢复按钮 ——
   * 渲染必然失败的入口等于把权限做成猜谜。
   */
  canRestore: boolean
}): ReactNode {
  const [oldContent, setOldContent] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const open = target !== null
  const targetId = target?.id ?? null

  const load = useCallback(() => {
    if (targetId === null) return
    setOldContent(null)
    setErr('')
    api
      .version(slug, targetId)
      .then((v) => setOldContent(v.content))
      .catch((e: unknown) => {
        /*
         * 404 有两种成因（无权限 / 版本已不存在），服务端刻意不区分 —— 文案必须两种都说，
         * 并给可执行的下一步。与页面里 `showVersion` 的口径保持一致。
         */
        setErr(
          e instanceof ApiError && e.status === 404
            ? '无法读取该历史版本：可能你没有查看历史快照的权限，或该版本已不存在 —— 刷新后重试，仍失败请向管理员确认权限。'
            : errorLine(e),
        )
      })
  }, [slug, targetId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  // 弹窗关闭时清掉上一版的内容：否则下次打开会先闪一帧旧差异
  useEffect(() => {
    if (!open) {
      setOldContent(null)
      setErr('')
    }
  }, [open])

  const diff = oldContent === null ? null : diffLines(oldContent, page.content)
  const sections = diff === null ? [] : changedSections(diff.ops)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        title={target === null ? '版本对比' : `v${target.label} → 当前 v${page.version}`}
        description={
          target === null
            ? undefined
            : `v${target.label}（${absoluteTime(target.savedAt)}）与当前版本的差异`
        }
        className="w-[min(64rem,calc(100vw-2rem))]"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={onClose} disabled={restoring}>
              关闭
            </Button>
            {canRestore && (
              <Button
                variant="primary"
                size="sm"
                icon={<RotateCcw className="size-3.5" />}
                disabled={restoring || oldContent === null}
                onClick={() => {
                  if (target !== null && oldContent !== null) onRestore(target, oldContent)
                }}
              >
                恢复此版本
              </Button>
            )}
          </>
        }
      >
        {err !== '' ? (
          <p role="status" className="m-0 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-note text-danger-ink">
            {err}
          </p>
        ) : diff === null ? (
          <p role="status" className="m-0 text-note text-muted">
            正在读取 v{target?.label ?? ''} 的内容…
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 摘要行：统计 + 涉及小节 + 作者（缺失则「未记录」） */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-note text-muted">
              <span
                className="font-medium text-ink"
                role="status"
                aria-label={`差异统计：新增 ${diff.stats.added} 行，删除 ${diff.stats.removed} 行`}
              >
                {statsLabel(diff.stats)}
              </span>
              <span>v{target?.label ?? ''} 由 {authorText(target?.author)} 保存于 {relativeTime(target?.savedAt ?? '')}</span>
            </div>

            {/*
              涉及小节的措辞刻意克制：这是**按最近的 Markdown 标题推断**出来的归属，
              不是语义切分，所以只说"集中在哪"，不说"本节改了几处"。
            */}
            {sections.length > 0 && (
              <p className="m-0 text-note text-muted">
                改动集中在
                {sections.map((s, i) => (
                  <span key={s}>
                    {i > 0 ? '、' : ''}
                    《{s}》
                  </span>
                ))}
              </p>
            )}

            {diff.stats.degraded && (
              <p role="status" className="m-0 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-note text-warn-ink">
                差异过大，已退化为“整段替换”的呈现：下面把旧内容整体标为删除、新内容整体标为新增，
                不逐行配对。**这不是全部改动都换了**，只是逐行配对会超出本页的计算上限。
              </p>
            )}

            <div
              className="max-h-[52vh] overflow-auto rounded-md border border-line bg-surface"
              tabIndex={0}
              aria-label="版本差异"
            >
              <DiffView ops={diff.ops} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 差异渲染：只显示"改动行 + 少量上下文"，未改动的长段落折起来 —— 否则文档一大半是灰的，
 * 真正改动的那几行反而找不到。
 */
function DiffView({ ops }: { ops: readonly DiffOp[] }): ReactNode {
  const shown = foldContext(ops, 2)
  return (
    <table className="w-full border-collapse font-mono text-note">
      <caption className="sr-only">版本差异（− 为旧内容，+ 为新内容）</caption>
      <tbody>
        {shown.map((row, i) => {
          if (row.kind === 'gap') {
            return (
              <tr key={`gap-${i}`} className="bg-sunken">
                <td colSpan={2} className="px-3 py-1 text-center text-2xs text-muted">
                  ⋯ 此处省略 {row.hidden} 行未改动的内容 ⋯
                </td>
              </tr>
            )
          }
          const op = row.op
          const isAdd = op.type === 'add'
          const isDel = op.type === 'del'
          return (
            <tr
              key={`${op.type}-${op.aLine ?? 'x'}-${op.bLine ?? 'x'}-${i}`}
              className={cn(
                'align-top',
                isAdd && 'bg-ok-bg',
                isDel && 'bg-danger-bg',
              )}
            >
              <td
                className={cn(
                  'w-[5.5rem] shrink-0 border-r border-line px-2 py-0.5 text-2xs whitespace-nowrap',
                  isAdd && 'text-ok-ink',
                  isDel && 'text-danger-ink',
                  !isAdd && !isDel && 'text-muted',
                )}
              >
                {/* 冗余编码：颜色之外还有符号与文字（WCAG 1.4.1） */}
                {isAdd ? '+ 新增' : isDel ? '− 删除' : ' '}
                <span className="ml-1 text-muted">
                  {isAdd ? op.bLine : op.aLine}
                </span>
              </td>
              <td className="px-3 py-0.5 break-all whitespace-pre-wrap">
                <span aria-hidden="true">{isAdd ? '+ ' : isDel ? '− ' : '  '}</span>
                {op.text === '' ? '\u00a0' : op.text}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

type Row = { kind: 'gap'; hidden: number } | { kind: 'op'; op: DiffOp }

/** 只保留改动行及其上下 `context` 行；中间连续未改动的部分折成一条"省略 N 行"。 */
export function foldContext(ops: readonly DiffOp[], context: number): Row[] {
  const keep = new Set<number>()
  ops.forEach((op, i) => {
    if (op.type === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
      keep.add(k)
    }
  })
  const out: Row[] = []
  let hidden = 0
  ops.forEach((op, i) => {
    if (keep.has(i)) {
      if (hidden > 0) {
        out.push({ kind: 'gap', hidden })
        hidden = 0
      }
      out.push({ kind: 'op', op })
    } else {
      hidden++
    }
  })
  if (hidden > 0) out.push({ kind: 'gap', hidden })
  return out
}
