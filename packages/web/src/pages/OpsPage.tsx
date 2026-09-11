import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, ShieldAlert, Trash2, ScrollText, LogOut } from 'lucide-react'
import {
  api,
  type AuditEntry,
  type CachePlanResponse,
  type SessionEntry,
  type SitemapAuditResponse,
} from '../api'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { describeError, type ErrorView } from '../lib/errorText'

/**
 * 审计与运维台面（P4）。
 * ============================================================================
 *
 * ## 为什么「越权告警」与「权限变更」在界面上也必须是两张表
 *
 * 服务端用显式白名单把审计分成了 `security`（安全事件，要告警）与 `acl`
 * （权限变更，要留存）——理由写在 `packages/plugin-authz/src/index.ts` 的
 * `SECURITY_ACTIONS` / `ACL_ACTIONS` 上方：混在一起，"有人在探测权限边界"
 * 会被"某人改了可见性"稀释掉，而两者的处置完全不同。
 *
 * 那条理由**在界面上同样成立**，所以这里刻意渲染成两个独立区块、各自带计数，
 * 而不是"一个列表 + 一个筛选器"。筛选器只是让人手动分开；分区块是默认就分开。
 *
 * ## 为什么"回收"按钮的文案不能说成"让过期授权失效"
 *
 * 过期失效在**判定时**就已经发生（判定层比较 `expires_at`）。这两个按钮只做
 * **空间回收**。若文案写成"清理失效授权"，运维就会形成"不点它 ⇒ 过期授权仍然有效"
 * 的错误心智模型 —— 而那是**失败开放**方向。文案按事实写。
 *
 * ⚠️ 前端隐藏/展示**不是安全措施**（设计文档 §9 R10 反模式第 5 条）：服务端对
 * 这些端点独立判 `admin`，这里只是不显示点了必然失败的入口。本页面的入口由
 * `ADMIN_NAV` 的 `requires: 'administer'` 把关（失败关闭：能力未知时不显示）。
 */
export function OpsPage(): ReactNode {
  const [security, setSecurity] = useState<AuditEntry[] | null>(null)
  const [acl, setAcl] = useState<AuditEntry[] | null>(null)
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null)
  const [sitemap, setSitemap] = useState<SitemapAuditResponse | null>(null)
  const [cachePlan, setCachePlan] = useState<CachePlanResponse | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState<ErrorView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setErr(null)
    try {
      // 两类分开取：这正是服务端的判据，不在这里自行改判
      const [sec, chg, sess] = await Promise.all([
        api.auditLog({ view: 'security', limit: 50 }),
        api.auditLog({ view: 'acl', limit: 50 }),
        api.sessions(),
      ])
      setSecurity(sec.entries)
      setAcl(chg.entries)
      setSessions(sess.entries)
    } catch (e: unknown) {
      setErr(describeError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (key: string, fn: () => Promise<string>): Promise<void> => {
      setBusy(key)
      setErr(null)
      setNotice(null)
      try {
        setNotice(await fn())
        await load()
      } catch (e: unknown) {
        setErr(describeError(e))
      } finally {
        setBusy('')
      }
    },
    [load],
  )

  const fmt = (iso: string | null): string =>
    iso === null || iso === '' ? '—' : new Date(iso).toLocaleString('zh-CN')

  const auditTable = (title: string, hint: string, rows: AuditEntry[] | null): ReactNode => (
    <Card>
      <CardHeader
        title={title}
        description={`${hint}　${rows === null ? '加载中…' : `${rows.length} 条`}`}
      />
      <CardBody>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无记录。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">时间</th>
                  <th className="py-1 pr-3 font-medium">动作</th>
                  <th className="py-1 pr-3 font-medium">目标</th>
                  <th className="py-1 pr-3 font-medium">操作者</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border/60">
                    <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">{fmt(r.at)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{r.action}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      {r.targetKind}:{r.targetId}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      {r.actorId === null ? '（匿名）' : `#${r.actorId}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">审计与运维</h1>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== ''}
          onClick={() => void run('refresh', async () => '已刷新')}
        >
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>

      {err !== null && (
        <p className="text-sm text-destructive" role="alert">
          {err.title}
          {err.hint === '' ? '' : ` —— ${err.hint}`}
        </p>
      )}
      {notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}

      {/* 两张表**刻意分开**：见文件头的说明 */}
      {auditTable(
        '越权尝试（安全事件）',
        '要告警：有人在探测权限边界。匿名请求受限页按设计返回 404，故这里只记「页存在但无权看」',
        security,
      )}
      {auditTable('权限变更（合规记录）', '要留存：谁在什么时候改了哪条可见性', acl)}

      <Card>
        <CardHeader
          title="会话"
          description={`${sessions === null ? '加载中…' : `${sessions.length} 条`}　ip 列是哈希不是原文，不应当作 IP 使用`}
        />
        <CardBody>
          {sessions === null ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无会话。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">用户</th>
                    <th className="py-1 pr-3 font-medium">状态</th>
                    <th className="py-1 pr-3 font-medium">最后使用</th>
                    <th className="py-1 pr-3 font-medium">到期</th>
                    <th className="py-1 pr-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-t border-border/60">
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {s.userId === null ? '—' : `#${s.userId}`}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Badge>{s.status}</Badge>
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">
                        {fmt(s.lastUsedAt)}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">
                        {fmt(s.expiresAt)}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busy !== '' || s.revokedAt !== null}
                          onClick={() =>
                            void run(`revoke:${s.id}`, async () => {
                              const r = await api.revokeSession(s.id)
                              return r.revoked ? '已吊销该会话' : '该会话此前已失效'
                            })
                          }
                        >
                          <LogOut className="size-4" />
                          吊销
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="运维动作"
          description="下面两个「回收」只做空间回收 —— 过期失效在判定时就已经发生"
        />
        <CardBody>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== ''}
              onClick={() =>
                void run('purgeGrants', async () => {
                  const r = await api.purgeGrants()
                  return `条目授权：回收 ${r.expired} 条，表内剩 ${r.remaining} 条`
                })
              }
            >
              <Trash2 className="size-4" />
              回收过期条目授权
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== ''}
              onClick={() =>
                void run('purgeInvitations', async () => {
                  const r = await api.purgeInvitations()
                  return `邀请：回收 ${r.expired} 条，表内剩 ${r.remaining} 条`
                })
              }
            >
              <Trash2 className="size-4" />
              回收过期邀请
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== ''}
              onClick={() =>
                void run('sitemap', async () => {
                  const r = await api.sitemapAudit()
                  setSitemap(r)
                  return `sitemap 核对完成：广告 ${r.advertisedCount} 条`
                })
              }
            >
              <ShieldAlert className="size-4" />
              核对 sitemap
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== ''}
              onClick={() =>
                void run('cachePlan', async () => {
                  const r = await api.cachePlan()
                  setCachePlan(r)
                  return `清缓存指引：窗口内有 ${r.eventCount} 条 ACL 变更`
                })
              }
            >
              <ScrollText className="size-4" />
              清缓存指引
            </Button>
          </div>

          {sitemap !== null && (
            <div className="mt-3 text-sm">
              {/*
                ⚠️ 文案刻意**不**说"发现 N 处泄漏"：广告集合与匿名可见集合**同源**，
                两者的集合差恒空、无信息量。有信息量的是下面两个方向。
              */}
              <p className="text-muted-foreground">
                广告集合与匿名可见集合**同源**（同一个出口），故两者的集合差恒为空、不构成检查；
                下面是与**读路径判定**的交叉核对：
              </p>
              <p className="mt-1">
                被广告却匿名读不到（**泄漏方向，必须为空**）：
                {sitemap.unreadable.length === 0 ? (
                  <Badge>0 条</Badge>
                ) : (
                  <span className="font-mono text-xs">
                    {sitemap.unreadable.map((u) => `${u.slug}(${u.reason})`).join('、')}
                  </span>
                )}
              </p>
              <p className="mt-1">
                匿名读得到却未被广告（一致性方向）：
                <span className="font-mono text-xs">
                  {sitemap.omitted.length === 0 ? '0 条' : sitemap.omitted.join('、')}
                </span>
              </p>
            </div>
          )}

          {cachePlan !== null && (
            <div className="mt-3 text-sm">
              <p className="text-muted-foreground">{cachePlan.note}</p>
              <p className="mt-1">
                需清理：<span className="font-mono text-xs">{cachePlan.targets.join('、')}</span>
                （共享缓存串 <span className="font-mono text-xs">{cachePlan.sharedCacheable[0]?.cacheControl ?? '—'}</span>
                ）
              </p>
              <p className="mt-1">
                无需清理：
                <span className="font-mono text-xs">
                  {cachePlan.notSharedCacheable.map((x) => x.path).join('、')}
                </span>
              </p>
              {cachePlan.events.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  窗口内 ACL 变更：
                  {cachePlan.events.map((e) => `${e.action}×${e.count}`).join('、')}
                </p>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
