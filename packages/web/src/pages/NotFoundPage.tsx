/**
 * 路由不存在页（兜底）。
 *
 * **为什么必须有**：此前前端对未知路由是**静默回落知识库列表**（`App.tsx` 里
 * `const active = known ? root : 'wiki'`）。静默回落的坏处不是"少一个页面"，
 * 而是**掩盖了越权访问与拼错路由**：用户访问 `#/typo` 会看到一个正常的知识库首页，
 * 于是永远不知道自己走错了；而"访问不到"与"不存在"在界面上被压成同一件事之后，
 * 排障时无法区分。
 *
 * 与「无权访问」（`#/denied`）的分工：
 * - 本页 = **路由本身不认识**（客户端就知道的事，不需要请求服务端）；
 * - `#/denied` = 服务端明确回了 403；
 * - 条目不存在的 404 由详情页自己呈现（它拿得到 slug，能给出更贴切的文案）。
 *
 * 本页不猜测用户原本想访问什么，也不显示任何条目信息。
 */
import type { ReactNode } from 'react'
import { Compass } from 'lucide-react'
import { Button, Card, CardBody, EmptyState } from '../ui'
import { t } from '../lib/i18n'

export function NotFoundPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-4 py-6">
      <h1 className="m-0 text-lg font-semibold text-ink">{t('host.notfound.title')}</h1>
      <Card>
        <CardBody>
          <EmptyState
            icon={<Compass className="size-6" />}
            title={t('host.notfound.empty.title')}
            hint={t('host.notfound.empty.hint')}
            action={
              <Button variant="primary" onClick={() => (window.location.hash = '/wiki')}>
                {t('host.notfound.back')}
              </Button>
            }
          />
        </CardBody>
      </Card>
    </div>
  )
}
