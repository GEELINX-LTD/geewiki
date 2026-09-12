/**
 * 权限治理台（M1）—— 路由 `#/access` 与 `#/access/<encodeURIComponent(slug)>`。
 * ============================================================================
 *
 * ## 为什么是一个**独立路由**，而不是 `#/wiki/<slug>/access`
 *
 * `lib/wikiRoute.ts` 的 `parseWikiRoute` 只保留首段 `search|ask|new|list`，其余整段
 * 都当 slug —— `#/wiki/foo/access` 会被解析成"slug 叫 `foo/access` 的页面"（404），
 * 而 `access` 又**不能**加进保留段：后端 `RESERVED_FIRST_SEGMENTS` 与前端保留段是一份
 * 对齐约定（有守卫测试），加一段就意味着后端也不许有叫 `access` 的顶层页面。
 * 于是治理拥有自己的首段：`#/access`（入口/换页）与 `#/access/<slug>`（某条内容的治理）。
 *
 * ## 访问控制
 *
 * 入口在顶栏由 `GOVERN_NAV` 的 `requires: 'manageVisibility'` 把关（失败关闭：
 * 能力未知时不显示）。但**路由本身可以被直接输入**，所以这里仍要自己判一次：
 * 没有能力 ⇒ 说明 + 返回入口，不渲染任何治理控件（**前端隐藏不是安全措施**，
 * 服务端对每个端点独立判定，这里只是不让界面出现点了必然 403/404 的按钮）。
 */
import { useCallback, useState, type ReactNode } from 'react'
import { KeyRound, Lock, Search } from 'lucide-react'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { Input } from '../ui/Input'
import { LoadingState } from '../ui/LoadingState'
import { Skeleton } from '../ui/Skeleton'
import { PageAccessPanel } from '../components/access/PageAccessPanel'
import { parseAccessRoute } from '../lib/accessPlan'
import { useAuth } from '../lib/authStore'
import { isValidSlug, SLUG_HINT } from '../lib/slugRules'

export function AccessPage({
  sub,
  onNavigate,
}: {
  /** hash 中 `access/` 之后的子路径（与 `WikiPage` 的 `sub` 同款） */
  sub: string
  onNavigate: (path: string) => void
}): ReactNode {
  const route = parseAccessRoute(sub)
  const auth = useAuth()

  if (route.kind === 'page') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">权限治理</h1>
        <PageAccessPanel slug={route.slug} onNavigate={onNavigate} />
      </div>
    )
  }

  /*
   * 首页（`#/access`）：让用户填一条 slug 进来。
   *
   * 为什么不是"我能管理的页面列表"：服务端**没有**这个端点（`GET /api/pages` 只回
   * 当前主体读得到的页面，不含"能不能管理"），凭空拼一个列表要么不完整、要么泄露
   * 它本不该知道的条目。填 slug 是最诚实也最省事的入口。
   */
  if (auth.capabilities === null) {
    return (
      <LoadingState label="正在确认你的权限…">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </LoadingState>
    )
  }

  if (!auth.capabilities.manageVisibility) {
    return (
      <EmptyState
        icon={<Lock className="size-8" />}
        title="你需要可见性管理能力才能进入权限治理"
        hint="该能力对本组织成员开放（对自己有编辑权的条目改档位与授权）。若你确认应该拥有它，请联系组织管理员。"
        action={
          <Button variant="secondary" size="sm" onClick={() => onNavigate('wiki/list')}>
            返回知识库
          </Button>
        }
      />
    )
  }

  return <AccessHome onNavigate={onNavigate} />
}

function AccessHome({ onNavigate }: { onNavigate: (path: string) => void }): ReactNode {
  const [slug, setSlug] = useState('')
  const [err, setErr] = useState('')

  const submit = useCallback((): void => {
    const v = slug.trim()
    if (v === '') {
      setErr('请填写页面标识（slug）')
      return
    }
    if (!isValidSlug(v)) {
      setErr(SLUG_HINT)
      return
    }
    setErr('')
    onNavigate(`access/${encodeURIComponent(v)}`)
  }, [slug, onNavigate])

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">权限治理</h1>

      <Card>
        <CardHeader
          title="选择要治理的页面"
          description="填入页面标识（slug），进入它的档位、授权与访问申请设置。"
        />
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
              <label htmlFor="access-slug" className="text-xs font-medium text-ink-soft">
                页面标识（slug）
              </label>
              <Input
                id="access-slug"
                value={slug}
                invalid={err !== ''}
                placeholder="例如 guide/authoring"
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <Button variant="primary" size="sm" type="submit" icon={<Search className="size-3.5" />}>
              打开治理
            </Button>
          </form>
          {err !== '' && <p className="m-0 mt-2 text-note text-danger-ink">{err}</p>}
          <p className="m-0 mt-3 text-xs leading-relaxed text-muted">
            提示：详情页操作区的「权限…」按钮会直接打开同一条内容的治理面板；
            这里适合"按标识直达"，或处理别人发给你的链接。
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="这里能做什么" />
        <CardBody>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm text-ink-soft">
            <li className="flex gap-2">
              <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span>
                <strong className="font-semibold text-ink">页面档位</strong>
                ：私有 / 组织内 / 公开三档，加「继承祖先档位」与「已发布」两个开关。
              </span>
            </li>
            <li className="flex gap-2">
              <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span>
                <strong className="font-semibold text-ink">例外授予</strong>
                ：给某个用户或用户组单独放行（档位读不到也仍可读），可设到期时间。
              </span>
            </li>
            <li className="flex gap-2">
              <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span>
                <strong className="font-semibold text-ink">块级授权</strong>
                ：按段落/代码块单独授权。该列表只含结构与授权，不含正文。
              </span>
            </li>
            <li className="flex gap-2">
              <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span>
                <strong className="font-semibold text-ink">访问申请</strong>
                ：审批待审申请（最多 200 条），批准即落一条授予。
              </span>
            </li>
          </ul>
          <p className="m-0 mt-3 text-xs leading-relaxed text-muted">
            读路径对「页面不存在」与「你无权访问」一律返回 404（防存在性探测），
            因此打开某个标识失败时无法区分这两种情况 —— 界面会照实说明，不会替你猜。
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
