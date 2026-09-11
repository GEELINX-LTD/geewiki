/**
 * 无访问权限页（`#/denied`）。
 *
 * **为什么要有独立一页**（而不是弹个错误提示）：403 是"你已登录，但这条内容不属于你"，
 * 与 401"你还得先登录"是**完全不同的下一步**（设计文档 §2.5 ⑥ 把 401/403/503 的语义
 * 分得很清楚）。用户看到"请求未被接受"只会一头雾水；看到"没有访问权限 + 可以做什么"
 * 才知道该找谁。
 *
 * 本页**不显示条目本身的信息**：连"这个条目存在"都不该由它确认 —— 是否泄露存在性
 * 由服务端的 404/403 选择决定（匿名一律 404，见设计文档 §2.3），前端不越权替它表态。
 */
import type { ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Button, Card, CardBody, EmptyState } from '../ui'
import { useAuth } from '../lib/authStore'

export function DeniedPage(): ReactNode {
  const auth = useAuth()
  return (
    <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">没有访问权限</h1>
      <Card>
        <CardBody>
          <EmptyState
            icon={<ShieldOff className="size-6" />}
            title="你没有访问这篇内容的权限"
            hint={
              auth.user === null
                ? '请先登录；如果你认为这是误判，请联系管理员。'
                : `当前登录身份：${auth.user.displayName}。如需访问，请联系管理员为你开通权限。`
            }
            action={
              <>
                <Button variant="primary" onClick={() => (window.location.hash = '/wiki')}>
                  返回知识库
                </Button>
                {auth.user === null ? (
                  <Button onClick={() => (window.location.hash = '/login')}>去登录</Button>
                ) : (
                  <Button onClick={() => (window.location.hash = '/login')}>切换账号</Button>
                )}
              </>
            }
          />
        </CardBody>
      </Card>
    </div>
  )
}
