/**
 * 权限治理面板（M1-M3 的宿主）—— 四个区块装在一个组件里，**两个入口共用同一份实现**：
 *
 * 1. `pages/AccessPage.tsx`（路由 `#/access/<slug>`）—— 独立的治理台；
 * 2. `pages/WikiPage.tsx` 详情页操作区的「权限…」按钮（Dialog 内嵌）。
 *
 * 为什么必须共用：两个入口各写一份，迟早出现"治理台能改、详情页弹窗少一个字段"这类漂移，
 * 而这类漂移的后果是**权限被改错**（用户在错误的界面上以为自己改的是别的东西）。
 *
 * ## 读不到页面时的文案（照 M3 的既有取舍写）
 *
 * 治理面板要 `api.page(slug)` 拿档位回填，而详情读路径对**无权**与**不存在**一律 404
 * （防存在性探测）⇒ 这里**无法区分**两者，文案必须坦诚这一点，**不得**写"你没有权限，请申请"
 * 这种断言（它会把"不存在"说成"无权"，也可能反过来）。
 *
 * ## 无管理权时整块不渲染
 *
 * `page.capabilities.canManageVisibility` 为假 ⇒ 只给一句说明与返回入口，
 * **不**渲染任何禁用按钮（禁用按钮本身就在暗示"这里有个你够不着的能力"）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { FileText, Lock, RefreshCw } from 'lucide-react'
import { api, type PageDetail } from '../../api'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { LoadingState } from '../../ui/LoadingState'
import { Skeleton } from '../../ui/Skeleton'
import { describeError } from '../../lib/errorText'
import { invalidatePages } from '../../lib/pagesStore'
import { GrantsSection } from './GrantsSection'
import { RequestsSection } from './RequestsSection'
import { VisibilitySection } from './VisibilitySection'

/**
 * 页面的权限面板：**页面档位 + 例外授予 + 访问申请**，三块。
 *
 * ## 为什么没有"块级"那一块
 *
 * 曾经有第四块 `BlocksSection`（逐块的档位与授权名单）。实测它是作者最用不上的一块：
 * 段落档位**就是正文里的标记**（在**编辑器**里用工具栏的锁按钮改，与正文一起保存、
 * 一起进版本历史），而"给某一段单独授权"要先把那一段标记成 `granted` 才有意义 ——
 * 那件事发生在编辑器里，不在这里。留在弹窗里只会让它更长、更不像"设置这一页对谁可见"。
 *
 * ⚠️ **界面收起、能力不删**：`components/access/BlocksSection.tsx` 仍在，服务端的
 * `GET /api/pages/:slug/blocks` 与块授权端点也仍在。要恢复这一块，把它加回下面的渲染即可。
 *
 * ## 为什么只有这一份实现
 *
 * 阅读页的「权限」对话框与旧的 `#/access/<slug>` 落点用的是**同一个组件** ——
 * 任何"另写一份治理界面"的做法都会与服务端的判据漂移，而漂移的后果是权限被改错。
 */
export function PageAccessPanel({
  slug,
  onNavigate,
}: {
  slug: string
  /** 治理台的"返回"动作（详情页弹窗内不传，那里由 Dialog 自己关闭） */
  onNavigate?: (path: string) => void
}): ReactNode {
  const [page, setPage] = useState<PageDetail | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      /*
       * 面板**自己**取一次页面详情（即使宿主 WikiPage 手里已经有一份）。
       *
       * 取舍：多一次 GET，换来的是"两个入口共用同一份实现"—— 若改成由宿主传 props，
       * 详情页那份可能是几分钟前取的（档位早已被改过），回填出旧值；而档位回填错了
       * 会让"只发改动过的字段"的部分更新发出错误的 patch。自取＋面板随弹窗卸载重建，
       * 保证每次打开看到的都是服务端当前值。
       */
      const p = await api.page(slug)
      setPage(p)
    } catch (e: unknown) {
      setErr(e)
      setPage(null)
    }
  }, [slug])

  useEffect(() => {
    void load()
  }, [load])

  /** 任何写成功都让页面列表缓存失效（档位/授权虽不改列表排序，但列表是共享缓存，别让它陈旧） */
  const afterWrite = useCallback((): void => {
    void invalidatePages()
  }, [])

  if (page === null) {
    if (err === null) {
      return (
        <LoadingState label="正在加载页面与权限信息…">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </LoadingState>
      )
    }
    const view = describeError(err)
    return (
      <Card>
        <CardHeader title="无法打开这条内容的权限设置" />
        <CardBody>
          <EmptyState
            icon={<FileText className="size-8" />}
            title={view.kind === 'notFound' ? '页面不存在，或你没有访问权限' : view.title}
            hint={
              view.kind === 'notFound'
                ? '服务端对「不存在」与「无权访问」返回同一结果，所以这里无法区分；也可能只是你没有这条内容的可见性管理权。'
                : view.hint
            }
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void load()}>
                  重试
                </Button>
                {onNavigate !== undefined && (
                  <Button variant="ghost" size="sm" onClick={() => onNavigate('access')}>
                    换个页面
                  </Button>
                )}
              </div>
            }
          />
        </CardBody>
      </Card>
    )
  }

  if (!page.capabilities.canManageVisibility) {
    return (
      <Card>
        <CardHeader title="没有可见性管理权" description={`页面：${page.title}（${page.slug}）`} />
        <CardBody>
          <EmptyState
            icon={<Lock className="size-8" />}
            title="你不能改这条内容的档位与授权"
            hint="可见性与授权的管理权与编辑权是两件事：能编辑不等于能改「谁能看」。需要时请联系本页的管理员或组织管理员。"
            action={
              onNavigate === undefined ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => onNavigate('access')}>
                  换个页面
                </Button>
              )
            }
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 text-sm text-ink">
          正在治理：<strong className="font-semibold">{page.title}</strong>
          <span className="ml-2 font-mono text-xs text-muted">{page.slug}</span>
        </p>
        <span className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="size-4" />}
            onClick={() => void load()}
          >
            刷新
          </Button>
        </span>
      </div>

      {err !== null && <ErrorNotice error={err} role="alert" />}

      <VisibilitySection
        slug={page.slug}
        current={{
          visibility: page.visibility ?? 'private',
          inherit: page.inherit ?? true,
          published: page.published === true,
        }}
        onSaved={() => afterWrite()}
      />
      <GrantsSection slug={page.slug} onChanged={afterWrite} />
      {/*
        审批区在**有能力时**才渲染（这里已经过了 canManageVisibility 判定）；
        无能力时整个面板根本走不到这一段 —— 不显示禁用按钮。
      */}
      <RequestsSection slug={page.slug} />
    </div>
  )
}
