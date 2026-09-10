/**
 * 系统状态面板（把原先头部的「● 服务健康」裸 JSON 链接产品化）。
 *
 * 背景：迁移前顶栏有一个 `<a href="/api/health" target="_blank">● 服务健康</a>`，
 * 点开是**原始 JSON**。这对产品用户是无意义的开发痕迹（上一批被迫保留，并在注释里
 * 点名留给设计系统批处理）。这里给出成熟做法：
 *
 *  1. 不再外链 JSON，而是**在应用内**用对话框呈现；
 *  2. 呈现的是**人话的状态**（服务正常/数据库已就绪 + 运行时长），原始字段降级为
 *     次要信息（表名、迁移记录），需要排查时才看；
 *  3. 入口收进「管理 ▾」菜单，不再占据顶栏的一等位置——它属于运维台面；
 *  4. 状态点用**颜色 + 文字**双重表达（不能只靠颜色，1.4.1）。
 *
 * 无障碍：状态点 `aria-hidden`，语义由紧随其后的文字承担；对话框用 Radix Dialog
 * （焦点陷阱 + Escape + 归还焦点）。
 */
import { errorLine } from '../lib/errorText'
import { useEffect, useState, type ReactNode } from 'react'
import { Activity, Database, RefreshCw } from 'lucide-react'
import { api, type HealthResponse } from '../api'
import { Button } from '../ui/Button'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Badge } from '../ui/Badge'
import { Skeleton } from '../ui/Skeleton'
import { formatUptime } from '../lib/format'

function StatusRow({
  icon,
  label,
  value,
  tone,
  detail,
}: {
  icon: ReactNode
  label: string
  value: string
  tone: 'ok' | 'warn'
  detail?: ReactNode
}): ReactNode {
  return (
    <div className="flex items-start gap-3 border-b border-line py-3 last:border-b-0">
      <span aria-hidden="true" className="mt-0.5 text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink">{label}</span>
          <Badge tone={tone}>{value}</Badge>
        </div>
        {detail !== undefined && <div className="mt-1 text-xs break-words text-muted">{detail}</div>}
      </div>
    </div>
  )
}

function StatusBody(): ReactNode {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [err, setErr] = useState('')

  const load = (): void => {
    setErr('')
    api
      .health()
      .then(setData)
      .catch((e: unknown) => setErr(errorLine(e)))
  }
  // Dialog 内容只在打开时挂载（Radix 默认行为），故这里在挂载时拉一次即可
  useEffect(load, [])

  if (err !== '') {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-danger-ink">无法获取服务状态：{err}</span>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={load}>
          重试
        </Button>
      </div>
    )
  }
  if (data === null) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
    )
  }

  const db = data.db
  return (
    <div>
      <StatusRow
        icon={<Activity className="size-4" />}
        label="服务"
        value="运行正常"
        tone="ok"
        detail={`已持续运行 ${formatUptime(data.uptime)}`}
      />
      <StatusRow
        icon={<Database className="size-4" />}
        label="数据库"
        value={db.present ? '已就绪' : '不可用'}
        tone={db.present ? 'ok' : 'warn'}
        detail={
          db.present ? (
            <>
              {db.tables !== undefined && <div>数据表：{db.tables.join('、')}</div>}
              {db.migrations !== undefined && db.migrations.length > 0 && (
                <div>已应用迁移：{db.migrations.join('、')}</div>
              )}
            </>
          ) : (
            '数据目录不可写或数据库文件缺失，页面读写会失败'
          )
        }
      />
    </div>
  )
}

/**
 * 受控版：由调用方持有 `open`。
 *
 * 为什么**不用** `<Dialog><DialogTrigger asChild><DropdownMenuItem/></DialogTrigger></Dialog>`：
 * 下拉菜单项在选中后会关闭并**卸载**，而 DialogTrigger 的挂载/卸载与 Dialog 的 open
 * 状态存在竞态（表现为对话框一闪而过或焦点回到错误的位置）。把 open 提升到调用方、
 * 由菜单项的 `onSelect` 置位，就完全避开这个竞态——菜单可以安心卸载。
 */
export function SystemStatusDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="系统状态"
        description="服务与数据库的当前状况。排查问题时才需要看下面这些信息。"
      >
        <StatusBody />
      </DialogContent>
    </Dialog>
  )
}
