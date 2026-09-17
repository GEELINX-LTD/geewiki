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
 * ## 为什么这里没有"改块档位"的控件（但编辑页有）
 *
 * 块档位由作者在 Markdown 里用 `<!--gated:org-->` / `<!--gated:granted-->` 声明，保存正文时
 * 解析入库；**后端没有改块档位的端点**，因为这个档位**就是正文的一部分**。
 * 故"改块档位"不是一次 PUT，而是**改正文**：编辑页里用工具栏的锁按钮（或源码模式直接写标记），
 * 与正文一起保存、一起进版本历史。在这里凭一个按钮去改写正文会绕开草稿、冲突检测与版本校验，
 * 那才是真的危险。
 * 所以本组件只**只读地**展示解析结果（含 `tier` 的含义）、"本页档位下允许的块档位集合"
 * （`blockVisibilityOptions()` 的收敛结果）与**逐块的授权名单**（那部分是真有端点的写操作）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, type BlockRow } from '../../api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { BlockGrantEditor } from './BlockGrantEditor'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { BLOCK_VISIBILITIES, blockVisibilityOptions, narrowingHint, visibilityLabel } from '../../lib/accessPlan'
import { errorLine } from '../../lib/errorText'
import { loadSubjectDirectory, type SubjectDirectory } from '../../lib/subjectDirectory'

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

  /*
   * ⚠️ 列表的**刷新**由本组件负责（它是数据的主人）；而**添加/撤销**授权由
   * `BlockGrantEditor` 负责 —— 那份表单与对话框（编辑器的「授权给谁…」）**共用同一份实现**，
   * 两份必然漂移，而漂移的后果是"两处授权结果不一样"。
   */
  const refresh = useCallback((): void => {
    void load()
    onChanged?.()
  }, [load, onChanged])

  /** 本页档位下允许的块档位（规则 B1：块只能更窄）—— 只用于说明文案 */
  const allowed = blockVisibilityOptions(pageVisibility, BLOCK_VISIBILITIES)

  /*
   * 授权对象的名单**取一次、传给每一块**（不是每块各拉一次）：几十块时那样会打出几十个请求，
   * 而且它们的结果必然相同。名单端点本批放宽为"任何登录用户可读"，但未登录 / 被改回 admin /
   * 读取失败时会拿到 `forbidden` / `failed`（见 subjectDirectory.ts）—— 那时退回手填。
   */
  const [directory, setDirectory] = useState<SubjectDirectory | null>(null)
  useEffect(() => {
    let alive = true
    void loadSubjectDirectory().then((d) => {
      if (alive) setDirectory(d)
    })
    return () => {
      alive = false
    }
  }, [])

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
            onClick={() => void load()}
          />
        }
      />
      <CardBody>
        <p className="m-0 text-xs leading-relaxed text-muted">
          段落档位由作者在正文里用 <code className="font-mono">{'<!--gated:org-->'}</code> /{' '}
          <code className="font-mono">{'<!--gated:granted-->'}</code> 标记声明（保存正文时解析入库），
          <strong className="font-semibold">改它要改正文</strong> —— 在**编辑页**里改：
          把光标放到某一段，用编辑器工具栏的锁按钮切档位（源码模式下也可以直接写标记）。
          这里只读展示解析结果与逐块的授权名单，是因为权限面板不能凭一个按钮就改写正文
          （那会与服务端的版本校验、草稿、冲突检测各自为政）。块只能比页面更窄（规则 B1）：
          本页档位为「{visibilityLabel(pageVisibility)}」，因此块档位只能取
          {allowed.length === 0
            ? '（没有可比页面更窄的档位）'
            : `「${allowed.map((v) => visibilityLabel(v)).join('」「')}」`}
          。
        </p>

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
                </div>

                <p className="m-0 mt-2 text-xs leading-relaxed text-muted">{narrowingHint(b, pageVisibility)}</p>
                <p className="m-0 mt-1 text-xs text-muted">
                  检索等级（tier）：
                  {b.tier === null ? '无（不属于任何读者等级）' : b.tier}
                </p>

                <div className="mt-2">
                  <BlockGrantEditor
                    slug={slug}
                    block={b}
                    pageVisibility={pageVisibility}
                    idPrefix={`blocks-section-${b.id}`}
                    directory={directory}
                    onChanged={refresh}
                  />
                </div>
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
