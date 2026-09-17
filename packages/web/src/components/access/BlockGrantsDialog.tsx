/**
 * 「授权给谁…」对话框 —— 编辑器里为**当前这一段**管理例外授予。
 * ============================================================================
 *
 * ## 为什么入口在编辑器里
 *
 * 段落档位的第三档 `granted`（需单独授权）的含义是"**默认谁都读不到，靠名单放人**"。
 * 那么"谁来放人"这件事就必须与"选档位"在同一个地方 —— 否则就会出现本仓库真实发生过的
 * 功能缺口：段落能设成"需单独授权"，却**没有任何界面**能指定授权给谁，于是那一档设下去
 * 等于把内容锁死（连作者想给的同事都读不到）。
 *
 * ## 为什么这里要处理"块不存在"
 *
 * 授权是按**块 id**（`block_grants.block_id`）存的，而块是**保存正文时**解析生成的。
 * 所以：作者刚写好一段、标成 `granted`、还没保存时，服务端**没有这一块**，也就无从授权。
 * 这不是错误，是契约顺序，故界面给出的是**一条可执行的出路**（"先保存，然后重试"），
 * 而不是一个必然 404 的按钮或一句"未找到"。
 *
 * ## 与 `ordinal` 的关系（为什么按序号找块是安全的）
 *
 * 编辑器只认正文（它不碰网络），服务端只认 `blocks.id`。两者的稳定纽带是 **`ordinal`**：
 * 服务端 `parseBlocks()` 与前端 `lib/editorBlocks.ts` 的 `parseSourceDoc()` 是同一套规则
 * （有逐字镜像守卫），同一个正文解析出的块序号一致。故：编辑器把**光标所在块的 ordinal**
 * 交上来，这里用 `blocks.find(b => b.ordinal === ordinal)` 换到 `id`。
 *
 * ⚠️ 由此得到一个必须说清的后果：**手上未保存的改动会让序号错位**（服务端那份是上次保存的
 * 正文）。所以对话框顶部永远显示这一段的**摘要**，让作者一眼确认"要授权的就是这一段"。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, type BlockRow } from '../../api'
import { Button } from '../../ui/Button'
import { Dialog, DialogClose, DialogContent } from '../../ui/Dialog'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { BlockGrantEditor } from './BlockGrantEditor'
import {
  directoryUnavailableHint,
  loadSubjectDirectory,
  type SubjectDirectory,
} from '../../lib/subjectDirectory'

export function BlockGrantsDialog({
  open,
  onOpenChange,
  slug,
  ordinal,
  excerpt,
  pageVisibility,
  onSaveFirst,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 页面标识；空串 = 新页面还没保存（此时不改请求，直接说明） */
  slug: string
  /** 光标所在块的序号（与 `parseSourceBlock` 同序） */
  ordinal: number
  /** 该段的摘要（第一行，已截断）—— 让作者确认"要授权的就是这一段" */
  excerpt: string
  /** 页面当前档位；`null` = 未知 */
  pageVisibility: string | null
  /** "先保存正文"这条路（宿主执行既有保存路径）——保存成功后本对话框重新取块 */
  onSaveFirst: () => Promise<void>
}): ReactNode {
  const [blocks, setBlocks] = useState<BlockRow[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  /** 成员/用户组名单（本批放宽为登录即可读；拿不到就手填 id，并说明原因） */
  const [directory, setDirectory] = useState<SubjectDirectory | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (slug === '') {
      setBlocks([])
      return
    }
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
    if (!open) return
    setBlocks(null)
    void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    let alive = true
    void loadSubjectDirectory().then((d) => {
      if (alive) setDirectory(d)
    })
    return () => {
      alive = false
    }
  }, [open])

  const block = blocks?.find((b) => b.ordinal === ordinal) ?? null

  /** 保存正文 → 服务端重新解析块 → 再取一次列表（这一段就存在了，可以授权了） */
  const saveThenReload = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await onSaveFirst()
      await load()
    } catch (e: unknown) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [onSaveFirst, load])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="授权给谁"
        description="例外授予是放宽方向：被授予的人即使档位更窄也能读到这一段。"
        className="w-[min(44rem,calc(100vw-2rem))]"
        footer={
          <DialogClose asChild>
            <Button>关闭</Button>
          </DialogClose>
        }
      >
        <div className="flex flex-col gap-4">
          {/* 段落摘要：永远是判断"我在给哪一段授权"的第一凭据 */}
          <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
            <p className="m-0 text-xs font-medium text-ink-soft">
              第 {ordinal} 段{block !== null ? `（服务端 id ${block.id}）` : ''}
            </p>
            <p className="m-0 mt-1 line-clamp-3 font-mono text-xs leading-relaxed text-ink">
              {excerpt === '' ? '（空段）' : excerpt}
            </p>
            {block !== null && (
              <p className="m-0 mt-1 text-xs text-muted">
                自身档位：{block.visibility === 'granted' ? '需单独授权' : block.marker ?? '跟随页面'}
                {'　'}已授予 {block.grants.length} 个对象
              </p>
            )}
          </div>

          {/*
            "所谓的 id 是什么" —— 这个问题的答案必须写在**问它的地方**（不是文档里）：
            它就是账号/用户组在数据库里的 id；能列名单时下面直接给选择，列不了时说明去哪儿看。
          */}
          {slug !== '' && (
            <p className="m-0 text-xs leading-relaxed text-muted">
              授权对象是<strong className="font-semibold">账号</strong>（数据库里的 <code className="font-mono">users.id</code>
              ）或<strong className="font-semibold">用户组</strong>（<code className="font-mono">groups.id</code>）：
              {directory !== null && directory.kind === 'available'
                ? '下面直接从成员名单里选，不用记 id。'
                : `下面只能手填数字 id —— ${directoryUnavailableHint(directory) ?? '名单正在读取…'}`}
            </p>
          )}

          {slug === '' ? (
            <p className="m-0 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn-ink">
              页面还没保存，因此还没有块可以授权。先保存这条目，再回到这一段用锁按钮里的「授权给谁…」。
            </p>
          ) : blocks === null && err === null ? (
            <LoadingState label="正在读取这一段的授权名单…">
              <Skeleton className="h-16 w-full" />
            </LoadingState>
          ) : block !== null ? (
            <BlockGrantEditor
              slug={slug}
              block={block}
              pageVisibility={pageVisibility}
              idPrefix={`block-grant-${block.id}`}
              directory={directory}
              onChanged={() => {
                void load()
              }}
            />
          ) : err !== null ? (
            <ErrorNotice error={err} role="alert" />
          ) : (
            /*
             * 服务端没有这个序号的块。**两种真实原因**，文案必须都覆盖到（说错归因比不说更坏）：
             * ① 这一段是刚写/刚改的，还没保存（最常见）；
             * ② 手上的未保存改动让序号与上一次保存的正文错位了。
             */
            <div className="flex flex-col gap-3 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn-ink">
              <p className="m-0">
                服务端现在没有第 {ordinal} 段 —— 块是保存正文时解析生成的，所以刚写好、
                还没保存的段落还不能授权（也可能是未保存的改动让段落序号与上次保存的正文错位了）。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" loading={busy} onClick={() => void saveThenReload()}>
                  先保存正文，再继续授权
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
                  重新读取
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
