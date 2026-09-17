/**
 * 旧「权限治理」路由的**去处**（`#/access` 与 `#/access/<encodeURIComponent(slug)>`）。
 * ============================================================================
 *
 * ## 为什么这一页不再存在（保留下来的只有深链兜底）
 *
 * 它此前是一个独立的治理台，但**能做的事太少**：页面档位能改，段落档位只能**看**
 * （服务端没有"改块档位"的端点 —— 块档位是从正文标记解析出来的），例外授予与访问申请
 * 又已经在阅读页的「权限…」对话框里。于是它给人的印象是"点进来什么也做不了"。
 *
 * 现在权限被拆到**动作发生的地方**：
 * - **页面档位 / 发布 / 例外授予 / 访问申请** ⇒ 页面自己的「权限…」对话框（阅读页）
 *   与**编辑页的「权限」区**（改正文的人与改档位的人通常是同一个）；
 * - **段落档位** ⇒ 写在正文里的 gated 标记（编辑器工具栏的锁按钮，或源码模式直接写），
 *   与正文同一条保存路径、同一份版本历史。
 *
 * ## 为什么仍然保留这个路由（而不是删掉）
 *
 * 1. **旧链接不能死**：`#/access/<slug>` 在文档、书签、聊天记录里都出现过。老链接打开变成
 *    「页面不存在」是最糟的处理方式 —— 用户会以为**页面**没了。
 * 2. **路由首段必须仍然被认识**：`parseWikiRoute` 只保留 `search|ask|new|list`，
 *    其余整段当 slug；`access` 不能塞进 `wiki/`（会变成"slug 叫 `access/x` 的页面"），
 *    也不能加进保留段（那是一份与后端 `RESERVED_FIRST_SEGMENTS` 对齐的约定，有守卫测试）。
 *    故这里保留首段，但把它变成一次**重定向**。
 *
 * ## 重定向到哪：阅读页的权限对话框，而不是编辑页
 *
 * 阅读页的「权限…」对话框对**所有有 `manageVisibility` 的人**都可用 —— 包括没有正文
 * 编辑权的人（只负责治理的成员）。一律送去编辑页会把这类人挡在门外（编辑页要 `canEdit`），
 * 那才是真的功能倒退。落点写进查询串（`?access=1`），由 `WikiDetail` 打开对话框：
 * 于是**重定向本身就是一条可分享的地址**，而不是一次性的跳转副作用。
 *
 * 权限判定的纪律与全仓库一致：前端隐藏**不是**安全措施，服务端对每个端点独立判定；
 * 这里只是不让界面出现点了必然 403/404 的东西。
 */
import { useEffect, type ReactNode } from 'react'
import { Lock, ShieldCheck } from 'lucide-react'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { LoadingState } from '../ui/LoadingState'
import { parseAccessRoute } from '../lib/accessPlan'
import { useAuth } from '../lib/authStore'

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
  const slug = route.kind === 'page' ? route.slug : null

  /*
   * 跳转放在 effect 里而不是渲染期直接调 `onNavigate`：渲染期改路由会在 React 提交
   * 过程中再次 setState（"Cannot update a component while rendering a different component"），
   * 而且会让下面那行"正在打开…"的可见文案根本没机会出现 —— 用户看到的是**一闪**。
   */
  useEffect(() => {
    if (slug === null) return
    onNavigate(`wiki/${encodeURIComponent(slug)}?access=1`)
  }, [slug, onNavigate])

  if (slug !== null) {
    return (
      <LoadingState label="正在打开这一页的权限设置…">
        <Card>
          <CardHeader
            title="权限设置已并入页面本身"
            description={`正在打开 ${slug} 的「权限…」对话框。`}
          />
          <CardBody>
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm text-ink-soft">
                若没有自动跳转，点下面的按钮：档位、发布、例外授予与访问申请都在那里。
              </p>
              <div>
                <Button
                  variant="primary"
                  icon={<ShieldCheck className="size-3.5" />}
                  onClick={() => onNavigate(`wiki/${encodeURIComponent(slug)}?access=1`)}
                >
                  打开 {slug} 的权限设置
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </LoadingState>
    )
  }

  /* `#/access`（无 slug）：说明搬去了哪里，并给一个明确的去处 */
  return (
    <div className="flex flex-col gap-4">
      <h1 className="m-0 text-lg font-semibold">权限设置已并入页面本身</h1>
      <Card>
        <CardHeader
          title="这里不再是一个独立的治理台"
          description="理由很直接：它在原地几乎做不了事 —— 页面档位能改，段落档位只能看（段落档位是从正文标记解析出来的），授予与申请又已经在页面自己的对话框里。"
        />
        <CardBody>
          <div className="flex flex-col gap-3 text-sm text-ink-soft">
            <p className="m-0">
              现在权限跟着**动作**走，三处入口：
            </p>
            <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5">
              <li>
                <strong className="font-semibold">页面档位、发布、例外授予、访问申请</strong>
                ：打开任意页面 → 右上角「权限…」；也可以直接在**编辑页**底部的「权限」区改。
              </li>
              <li>
                <strong className="font-semibold">段落级档位</strong>（仅组织成员 / 需单独授权）
                ：写在正文里 —— 编辑器的锁按钮，或源码模式直接写{' '}
                <code>&lt;!--gated:org--&gt;</code> / <code>&lt;!--/gated--&gt;</code>。
              </li>
              <li>
                <strong className="font-semibold">查看谁能读</strong>：编辑页的「按访客视角预览」
                会按视角把受限段落替换成占位文案。
              </li>
            </ul>
            {auth.capabilities !== null && !auth.capabilities.manageVisibility && (
              <p className="m-0 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn-ink">
                你当前没有可见性管理权，因此打开页面的「权限…」只会看到"无权管理"的说明；
                需要改档位请联系有权限的人，或在那张卡片上提交访问申请。
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={<Lock className="size-3.5" />}
                onClick={() => onNavigate('wiki')}
              >
                去知识库挑一个页面
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
