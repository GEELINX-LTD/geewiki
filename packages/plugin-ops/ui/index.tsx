/**
 * `@geewiki/ops` 的客户端界面：**「审计与运维」台面**（宿主路由 `audit`）。
 * ============================================================================
 *
 * ## 这一版改了什么（相对搬过来之前那张 536 行的宿主页面）
 *
 * 用户的原话是「功能性和表现形式上都很差」。查下来根因是**分层错位**：功能（8 个端点）
 * 全部来自插件，表现形式却锁死在宿主里，于是插件已经实现好的能力**在界面上没有入口**。
 * 搬到插件之后，这一版补的是两类东西：
 *
 * ### 功能性
 * 1. **四个端点此前零入口**，现在都有了：搜索索引核对、块级授权核对、tier 重算、
 *    按用户批量吊销会话。（`GET /api/admin/search/verify`、`GET /api/admin/blocks/verify`、
 *    `POST /api/admin/blocks/resync`、`POST /api/admin/users/:userId/sessions/revoke`）
 * 2. **审计表渲染 `before` → `after`**。这两个字段一直有数据，界面从来没显示过 ——
 *    于是「谁在什么时候改了哪条可见性」这张表**答不出"改成了什么"**，而那正是合规
 *    记录的全部意义。
 * 3. **审计查询真的用上了后端的筛选与分页**（`action` / `targetKind` / `since` / `until` /
 *    `limit` / `offset`）。此前是写死的 `limit: 50`，一页到底、无法按时间或动作收窄 ——
 *    而"上周谁动过权限"这种问题在大库上根本答不出来。
 * 4. **会话表补上 `createdAt` / `userAgent` / `ipHash`**（排障时最需要的那几列），
 *    并给出**按用户批量吊销**的入口（此前只能一条一条点）。
 *
 * ### 表现形式
 * 5. 五张卡片**纵向堆叠** ⇒ 五个**分区**（安全事件 / 权限变更 / 会话 / 排障 / 维护），
 *    分区进 URL（`#/audit/sessions`），可分享、可回退。
 * 6. 端点返回的裸 JSON ⇒ 有名字的**结论块**（`plan.ts` 的 `Verdict`：正常/注意/有问题
 *    三档 + 一句人话 + 要处理的行）。原来 `mismatched=0 unparseable=0 …` 铺成一行文本，
 *    运维得自己记住每个字段的正常值，而记错的表现是"看着挺正常"。
 * 7. `busy` 从**全局单键**改为**按动作的键**：此前任何一个动作在跑，页面上**所有**按钮
 *    都禁用（一次 30 秒的重算会冻住整页）。
 *
 * ## 三条不能违反的既有语义（搬过来时逐条保住的）
 *
 * 1. **两类审计必须默认就分开**。服务端用显式白名单把 `security`（要告警）与 `acl`
 *    （要留存）分开，理由是"有人在探测权限边界"会被"某人改了可见性"稀释掉，而两者的
 *    处置完全不同。故这里**分区**而不是"一张表 + 一个筛选器"——筛选器只是让人手动分开。
 *    同理**不得**取 `view: 'all'` 再在前端分类：那等于把服务端白名单抄了第二份。
 * 2. **「回收」不能写成"让过期授权失效"**。过期失效在**判定时**就已经发生
 *    （判定层比较 `expires_at`），这两个按钮只做**空间回收**。写成"清理失效授权"会让
 *    运维形成"不点它 ⇒ 过期授权仍然有效"的错误心智模型 —— 那是**失败开放**方向。
 * 3. **`ipHash` 是哈希不是 IP 原文**，界面上必须写明，否则运维会把它当 IP 使用。
 *
 * ## 它**不**做宿主的安全判定
 *
 * 前端隐藏/展示**不是安全措施**：服务端对这些端点独立判 `admin`。这里只是不显示
 * "点了必然失败"的入口。路由本身的可见性由清单的 `requires: 'administer'` 把关
 * （失败关闭：能力未知即不显示），见 `src/index.ts` 的 `routes` 声明。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import './style.css'
import {
  actorLabel,
  AUDIT_PAGE_SIZE,
  blocksVerifyVerdict,
  cacheVerdict,
  changedFields,
  clampPage,
  DEFAULT_SECTION,
  EMPTY_AUDIT_FILTERS,
  formatTime,
  hasAuditFilters,
  pageCount,
  searchVerifyVerdict,
  sectionById,
  SECTIONS,
  sitemapVerdict,
  type AccessExplainResponse,
  type AuditFilters,
  type BlocksResyncResponse,
  type BlocksVerifyResponse,
  type CachePlanResponse,
  type SearchVerifyResponse,
  type SessionEntry,
  type SitemapAuditResponse,
  type Verdict,
  type SectionId,
} from './plan.js'
import {
  describeOpsError,
  fetchAccessExplain,
  fetchAudit,
  fetchCachePlan,
  fetchSessions,
  fetchSitemapAudit,
  purgeGrants,
  purgeInvitations,
  resyncBlocks,
  revokeSession,
  revokeUserSessions,
  verifyBlocks,
  verifySearchIndex,
  type OpsErrorView,
} from './api.js'

/* ============================== 宿主 SDK 契约 ============================== */

/**
 * 宿主注入的路由 props（`packages/web/src/lib/routes.tsx` 的 `PluginRouteProps` **镜像**）。
 *
 * 浏览器侧不能 import 宿主模块（插件产物是独立构建的，`react` 系是唯一 external），
 * 故这里逐字段抄一份。漂移的症状是"宿主不传该字段、插件读到 undefined 且不报错"。
 */
interface PluginRouteProps {
  /** hash 首段之后的部分（已去掉前导 `/`）：`#/audit/sessions` → `'sessions'` */
  readonly sub: string
  /** 原始查询串（含 `?`，无则为空串） */
  readonly query: string
  /** 统一 hash 跳转（宿主保证首尾斜杠规范化） */
  readonly onNavigate: (path: string) => void
}

/** 宿主 SDK 里本插件用到的那一面 */
interface PluginUiHost {
  readonly pluginName: string
  readonly version?: string
  registerRoute(id: string, component: (props: PluginRouteProps) => ReactNode): () => void
}

/* ============================== 小部件 ============================== */

function Badge(props: { readonly level?: 'ok' | 'warn' | 'bad'; readonly children: ReactNode }): ReactNode {
  const cls = props.level === undefined ? 'gw-ops-badge' : `gw-ops-badge gw-ops-badge-${props.level}`
  return <span className={cls}>{props.children}</span>
}

/** 结论块：把端点的裸 JSON 变成"要不要处理" */
function VerdictBlock(props: { readonly verdict: Verdict }): ReactNode {
  return (
    <div className={`gw-ops-verdict gw-ops-verdict-${props.verdict.level}`} role="status">
      <span className="gw-ops-verdict-head">{props.verdict.headline}</span>
      {props.verdict.lines.map((line) => (
        <span className="gw-ops-verdict-line" key={line}>
          {line}
        </span>
      ))}
    </div>
  )
}

/**
 * 危险操作的确认条（**就地**，不是模态）。
 *
 * 为什么不用模态：模态会盖住被操作的那一行（用户看不见自己要吊销的是哪一条），
 * 而本页面的破坏性动作全部是"针对某个具体对象"的。就地确认把**对象标识**留在视野里，
 * 顺便省掉一个焦点陷阱。
 *
 * 与旧页面同款的三条内容纪律：标题带对象标识、正文说清后果、说清可否撤销。
 */
interface ConfirmRequest {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly danger: boolean
  readonly run: () => void
}

function ConfirmBar(props: {
  readonly request: ConfirmRequest | null
  readonly onCancel: () => void
}): ReactNode {
  if (props.request === null) return null
  const r = props.request
  return (
    <div className={r.danger ? 'gw-ops-error' : 'gw-ops-verdict'} role="alertdialog" aria-label={r.title}>
      <div style={{ fontWeight: 600 }}>{r.title}</div>
      <div className="gw-ops-verdict-line">{r.body}</div>
      <div className="gw-ops-actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className={r.danger ? 'gw-ops-btn gw-ops-btn-danger' : 'gw-ops-btn gw-ops-btn-primary'}
          onClick={r.run}
        >
          {r.confirmLabel}
        </button>
        <button type="button" className="gw-ops-btn" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

/* ============================== 分区一/二：审计 ============================== */

/**
 * 审计分区（`security` 与 `acl` 共用一个组件，只有 `view` 与文案不同）。
 *
 * 为什么不合并成"一张表 + 一个 view 切换"：那正是"筛选器"思路 —— 默认混在一起、
 * 要人手动分开。而这两类记录的**处置完全不同**，默认就必须分开（见文件头第 1 条）。
 */
function AuditSection(props: {
  readonly view: 'security' | 'acl'
  readonly reloadToken: number
  readonly busy: string
  readonly run: (key: string, fn: () => Promise<string>) => Promise<void>
  readonly onError: (e: unknown) => void
}): ReactNode {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  /** 已提交的筛选（与输入框里的草稿分开：输入过程不该每敲一个字就发请求） */
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<readonly import('./plan.js').AuditEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const offset = (page - 1) * AUDIT_PAGE_SIZE

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchAudit(props.view, applied, offset)
      .then((r) => {
        if (!alive) return
        setRows(r.entries)
        setTotal(r.total)
        // 筛选变化后页码可能越界 —— 越界时后端返回空数组而不是报错，看起来像"没有记录"
        setPage((p) => clampPage(p, r.total, AUDIT_PAGE_SIZE))
      })
      .catch((e: unknown) => {
        if (alive) props.onError(e)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.view, applied, offset, props.reloadToken, props.onError])

  const last = pageCount(total, AUDIT_PAGE_SIZE)
  const reload = `audit:${props.view}`

  return (
    <div className="gw-ops-card">
      <div className="gw-ops-card-head">
        <h2 className="gw-ops-card-title">{props.view === 'security' ? '越权尝试' : '权限变更'}</h2>
        <span className="gw-ops-card-desc">
          {props.view === 'security'
            ? '要告警：有人在探测权限边界。匿名请求受限页按设计返回 404，故这里只记「页存在但无权看」'
            : '要留存：谁在什么时候改了哪条可见性'}
        </span>
        <span className="gw-ops-spacer" />
        <span className="gw-ops-card-desc">{loading ? '加载中…' : `共 ${total} 条`}</span>
      </div>
      <div className="gw-ops-card-body">
        <form
          className="gw-ops-filters"
          onSubmit={(e) => {
            e.preventDefault()
            setApplied(filters)
            setPage(1)
          }}
        >
          <div className="gw-ops-field gw-ops-field-grow">
            <label className="gw-ops-label" htmlFor={`ops-${props.view}-action`}>
              动作（精确匹配，如 page.visibility）
            </label>
            <input
              id={`ops-${props.view}-action`}
              className="gw-ops-input"
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            />
          </div>
          <div className="gw-ops-field">
            <label className="gw-ops-label" htmlFor={`ops-${props.view}-kind`}>
              目标类型
            </label>
            <input
              id={`ops-${props.view}-kind`}
              className="gw-ops-input"
              value={filters.targetKind}
              onChange={(e) => setFilters({ ...filters, targetKind: e.target.value })}
            />
          </div>
          <div className="gw-ops-field">
            <label className="gw-ops-label" htmlFor={`ops-${props.view}-since`}>
              起始时间
            </label>
            <input
              id={`ops-${props.view}-since`}
              className="gw-ops-input"
              type="datetime-local"
              value={filters.since}
              onChange={(e) => setFilters({ ...filters, since: e.target.value })}
            />
          </div>
          <div className="gw-ops-field">
            <label className="gw-ops-label" htmlFor={`ops-${props.view}-until`}>
              截止时间
            </label>
            <input
              id={`ops-${props.view}-until`}
              className="gw-ops-input"
              type="datetime-local"
              value={filters.until}
              onChange={(e) => setFilters({ ...filters, until: e.target.value })}
            />
          </div>
          <button type="submit" className="gw-ops-btn gw-ops-btn-primary">
            筛选
          </button>
          <button
            type="button"
            className="gw-ops-btn"
            disabled={!hasAuditFilters(applied) && !hasAuditFilters(filters)}
            onClick={() => {
              setFilters(EMPTY_AUDIT_FILTERS)
              setApplied(EMPTY_AUDIT_FILTERS)
              setPage(1)
            }}
          >
            清除
          </button>
        </form>

        {rows === null ? (
          <p className="gw-ops-empty">正在加载审计记录…</p>
        ) : rows.length === 0 ? (
          <p className="gw-ops-empty">
            {hasAuditFilters(applied) ? '该筛选条件下没有记录。' : '该类目下还没有事件。'}
          </p>
        ) : (
          <>
            <div className="gw-ops-scroll">
              <table className="gw-ops-table">
                <caption className="gw-ops-dim">
                  {props.view === 'security' ? '越权尝试（安全事件）' : '权限变更（合规记录）'}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">时间</th>
                    <th scope="col">动作</th>
                    <th scope="col">目标</th>
                    <th scope="col">操作者</th>
                    <th scope="col">变更（改成了什么）</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const diff = changedFields(r.before, r.after)
                    return (
                      <tr key={r.id}>
                        <td className="gw-ops-mono gw-ops-nowrap">{formatTime(r.at)}</td>
                        <td className="gw-ops-mono">{r.action}</td>
                        <td className="gw-ops-mono">
                          {r.targetKind}:{r.targetId}
                        </td>
                        <td className="gw-ops-mono">{actorLabel(r.actorId)}</td>
                        <td>
                          {diff.length === 0 ? (
                            <span className="gw-ops-dim">—</span>
                          ) : (
                            <div className="gw-ops-diff">
                              {diff.slice(0, 4).map((d) => (
                                <div className="gw-ops-diff-row" key={d.key}>
                                  <span className="gw-ops-mono gw-ops-dim">{d.key}</span>
                                  <span className="gw-ops-mono gw-ops-diff-before">{d.before}</span>
                                  <span className="gw-ops-dim">→</span>
                                  <span className="gw-ops-mono gw-ops-diff-after">{d.after}</span>
                                </div>
                              ))}
                              {diff.length > 4 && (
                                <span className="gw-ops-dim">还有 {diff.length - 4} 项变更</span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="gw-ops-pager">
              <button
                type="button"
                className="gw-ops-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span>
                第 {page} / {last} 页
              </span>
              <button
                type="button"
                className="gw-ops-btn"
                disabled={page >= last}
                onClick={() => setPage((p) => Math.min(last, p + 1))}
              >
                下一页
              </button>
            </div>
          </>
        )}
        {props.busy === reload && <p className="gw-ops-status">正在执行…</p>}
      </div>
    </div>
  )
}

/* ============================== 分区三：会话 ============================== */

function SessionsSection(props: {
  readonly reloadToken: number
  readonly run: (key: string, fn: () => Promise<string>) => Promise<void>
  readonly confirm: (r: ConfirmRequest) => void
  readonly onError: (e: unknown) => void
}): ReactNode {
  const [rows, setRows] = useState<readonly SessionEntry[] | null>(null)

  useEffect(() => {
    let alive = true
    fetchSessions()
      .then((r) => {
        if (alive) setRows(r.entries)
      })
      .catch((e: unknown) => {
        if (alive) props.onError(e)
      })
    return () => {
      alive = false
    }
  }, [props.reloadToken, props.onError])

  /** 该用户还有几条**活着**的会话（批量吊销只对活的有意义） */
  const activeOf = (userId: number): number =>
    (rows ?? []).filter((s) => s.userId === userId && s.revokedAt === null && s.status === 'active').length

  return (
    <div className="gw-ops-card">
      <div className="gw-ops-card-head">
        <h2 className="gw-ops-card-title">会话</h2>
        <span className="gw-ops-card-desc">
          {rows === null ? '加载中…' : `${rows.length} 条`}　ip 列是**哈希**不是原文，不应当作 IP 使用
        </span>
      </div>
      <div className="gw-ops-card-body">
        {rows === null ? (
          <p className="gw-ops-empty">正在加载会话…</p>
        ) : rows.length === 0 ? (
          <p className="gw-ops-empty">当前没有会话。</p>
        ) : (
          <div className="gw-ops-scroll">
            <table className="gw-ops-table">
              <caption className="gw-ops-dim">会话列表</caption>
              <thead>
                <tr>
                  <th scope="col">用户</th>
                  <th scope="col">状态</th>
                  <th scope="col">创建</th>
                  <th scope="col">最后使用</th>
                  <th scope="col">到期</th>
                  <th scope="col">客户端</th>
                  <th scope="col">IP（哈希）</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  /*
                   * `userId` 先收成局部 const 再用：TS **不会**把 `s.userId !== null` 的窄化
                   * 带进 `onClick` 那类回调里（属性访问的窄化在闭包内失效），
                   * 于是回调里要 `as number` 才能过编译 —— 而强转正是"我保证它非空"的空头承诺。
                   * 收成 const 之后窄化跟着值走，回调里就是真的 number。
                   */
                  const userId = s.userId
                  const activeCount = userId === null ? 0 : activeOf(userId)
                  return (
                  <tr key={s.id}>
                    <td className="gw-ops-mono">{actorLabel(userId)}</td>
                    <td>
                      <Badge level={s.revokedAt === null && s.status === 'active' ? 'ok' : undefined}>
                        {s.status}
                      </Badge>
                    </td>
                    <td className="gw-ops-mono gw-ops-nowrap">{formatTime(s.createdAt)}</td>
                    <td className="gw-ops-mono gw-ops-nowrap">{formatTime(s.lastUsedAt)}</td>
                    <td className="gw-ops-mono gw-ops-nowrap">{formatTime(s.expiresAt)}</td>
                    <td className="gw-ops-mono" style={{ maxWidth: 220 }}>
                      {s.userAgent === null || s.userAgent === '' ? (
                        <span className="gw-ops-dim">—</span>
                      ) : (
                        s.userAgent
                      )}
                    </td>
                    <td className="gw-ops-mono">{s.ipHash === null ? '—' : s.ipHash.slice(0, 12)}</td>
                    <td>
                      <div className="gw-ops-actions">
                        <button
                          type="button"
                          className="gw-ops-btn gw-ops-btn-danger"
                          disabled={s.revokedAt !== null}
                          onClick={() =>
                            props.confirm({
                              /*
                               * 确认条必须自带**对象标识**：会话 id + 用户 id + 最后使用时间。
                               * 只写"确定要吊销吗"等于让用户在不知道对象的情况下点确认。
                               */
                              title: `吊销会话 ${s.id}？`,
                              body:
                                `${s.userId === null ? '该会话的用户未知' : `属于用户 #${s.userId}`}，` +
                                `最后使用 ${formatTime(s.lastUsedAt)}。这次登录会立即失效，该用户需要重新登录。` +
                                '此操作不可撤销。',
                              confirmLabel: '吊销会话',
                              danger: true,
                              run: () =>
                                void props.run(`revoke:${s.id}`, async () => {
                                  const r = await revokeSession(s.id)
                                  return r.revoked ? '已吊销该会话' : '该会话此前已失效'
                                }),
                            })
                          }
                        >
                          吊销
                        </button>
                        {userId !== null && (
                          <button
                            type="button"
                            className="gw-ops-btn"
                            disabled={activeCount === 0}
                            title="吊销该用户的全部有效会话（把这个人踢下线）"
                            onClick={() =>
                              props.confirm({
                                title: `吊销用户 #${s.userId} 的全部会话？`,
                                body:
                                  `该用户当前有 ${activeCount} 条有效会话，全部会立即失效，` +
                                  '需要重新登录。此操作不可撤销。',
                                confirmLabel: '全部吊销',
                                danger: true,
                                run: () =>
                                  void props.run(`revokeUser:${userId}`, async () => {
                                    const r = await revokeUserSessions(userId)
                                    return `已吊销 ${r.revokedCount} 条会话`
                                  }),
                              })
                            }
                          >
                            全部吊销
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================== 分区四：排障 ============================== */

function DiagnoseSection(props: {
  readonly run: (key: string, fn: () => Promise<string>) => Promise<void>
  readonly onError: (e: unknown) => void
}): ReactNode {
  const [slug, setSlug] = useState('')
  const [explain, setExplain] = useState<AccessExplainResponse | null>(null)
  const [sitemap, setSitemap] = useState<SitemapAuditResponse | null>(null)
  const [cache, setCache] = useState<CachePlanResponse | null>(null)

  return (
    <>
      <div className="gw-ops-card">
        <div className="gw-ops-card-head">
          <h2 className="gw-ops-card-title">反向展开「谁能看这条」</h2>
          <span className="gw-ops-card-desc">列出来源，并标注哪条**真的在起作用**。不做递归，响应也不含正文</span>
        </div>
        <div className="gw-ops-card-body">
          <form
            className="gw-ops-filters"
            onSubmit={(e) => {
              e.preventDefault()
              void props.run('explain', async () => {
                const r = await fetchAccessExplain(slug.trim())
                setExplain(r)
                return `已展开 ${r.slug}`
              })
            }}
          >
            <div className="gw-ops-field gw-ops-field-grow">
              <label className="gw-ops-label" htmlFor="ops-explain-slug">
                条目 slug
              </label>
              <input
                id="ops-explain-slug"
                className="gw-ops-input"
                value={slug}
                placeholder="例如 a/b"
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <button type="submit" className="gw-ops-btn gw-ops-btn-primary" disabled={slug.trim() === ''}>
              展开
            </button>
          </form>

          {explain === null ? (
            <p className="gw-ops-dim">输入一个 slug 后展开。</p>
          ) : (
            <>
              <div className="gw-ops-reach">
                <span className="gw-ops-reach-item">
                  <span className="gw-ops-dim">有效档位</span>
                  <Badge>{`rank=${explain.positionalRank}`}</Badge>
                </span>
                <span className="gw-ops-reach-item">
                  <span className="gw-ops-dim">匿名</span>
                  <Badge level={explain.reach.anonymous ? 'warn' : 'ok'}>
                    {explain.reach.anonymous ? '可读' : '不可读'}
                  </Badge>
                  <span className="gw-ops-dim">{explain.reach.anonymousReason}</span>
                </span>
                <span className="gw-ops-reach-item">
                  <span className="gw-ops-dim">组织成员</span>
                  <Badge level={explain.reach.orgMember ? 'warn' : 'ok'}>
                    {explain.reach.orgMember ? '可读' : '不可读'}
                  </Badge>
                </span>
              </div>
              <div className="gw-ops-scroll">
                <table className="gw-ops-table">
                  <caption className="gw-ops-dim">权限来源</caption>
                  <thead>
                    <tr>
                      <th scope="col">来源</th>
                      <th scope="col">对象</th>
                      <th scope="col">生效/相关</th>
                      <th scope="col">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>直接授予</td>
                      <td className="gw-ops-mono">
                        页 {explain.sources.grants.pages.length} / 块 {explain.sources.grants.blocks.length}
                      </td>
                      <td className="gw-ops-mono">{String(explain.sources.grants.effective)}</td>
                      <td className="gw-ops-dim">
                        {explain.sources.grants.blockGrantsAvailable ? '块级授权表可用' : '块级授权表不可用'}
                      </td>
                    </tr>
                    {explain.sources.ancestors.map((a) => (
                      <tr key={a.slug}>
                        <td>祖先链</td>
                        <td className="gw-ops-mono">{a.slug}</td>
                        <td className="gw-ops-mono">{a.effect}</td>
                        <td className="gw-ops-dim">
                          {a.reason ?? `${a.visibility ?? ''}${a.inherit === false ? '（断链）' : ''}`}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>组织角色</td>
                      <td className="gw-ops-dim">{explain.sources.orgRole.rule}</td>
                      <td className="gw-ops-mono">
                        {String(explain.sources.orgRole.effective)}/{String(explain.sources.orgRole.relevant)}
                      </td>
                      <td className="gw-ops-dim">生效与否取决于看的人，故只标相关</td>
                    </tr>
                    <tr>
                      <td>应急覆盖</td>
                      <td className="gw-ops-dim">{explain.sources.adminOverride.rule}</td>
                      <td className="gw-ops-mono">
                        {String(explain.sources.adminOverride.effective)}/
                        {String(explain.sources.adminOverride.relevant)}
                      </td>
                      <td className="gw-ops-dim">owner/admin 恒可看，同样只标相关</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="gw-ops-card">
        <div className="gw-ops-card-head">
          <h2 className="gw-ops-card-title">sitemap 核对</h2>
          <span className="gw-ops-card-desc">交叉核对「广告集合」与「匿名读路径判定」</span>
        </div>
        <div className="gw-ops-card-body">
          <div className="gw-ops-actions">
            <button
              type="button"
              className="gw-ops-btn"
              onClick={() =>
                void props.run('sitemap', async () => {
                  const r = await fetchSitemapAudit()
                  setSitemap(r)
                  return 'sitemap 核对完成'
                })
              }
            >
              核对 sitemap
            </button>
          </div>
          {sitemap !== null && <VerdictBlock verdict={sitemapVerdict(sitemap)} />}
        </div>
      </div>

      <div className="gw-ops-card">
        <div className="gw-ops-card-head">
          <h2 className="gw-ops-card-title">清缓存指引</h2>
          <span className="gw-ops-card-desc">看窗口内有没有改过权限：改过才需要清共享缓存</span>
        </div>
        <div className="gw-ops-card-body">
          <div className="gw-ops-actions">
            <button
              type="button"
              className="gw-ops-btn"
              onClick={() =>
                void props.run('cachePlan', async () => {
                  const r = await fetchCachePlan()
                  setCache(r)
                  return '清缓存指引已生成'
                })
              }
            >
              生成指引
            </button>
          </div>
          {cache !== null && <VerdictBlock verdict={cacheVerdict(cache)} />}
        </div>
      </div>
    </>
  )
}

/* ============================== 分区五：维护 ============================== */

function MaintainSection(props: {
  readonly run: (key: string, fn: () => Promise<string>) => Promise<void>
  readonly confirm: (r: ConfirmRequest) => void
}): ReactNode {
  const [search, setSearch] = useState<SearchVerifyResponse | null>(null)
  const [blocks, setBlocks] = useState<BlocksVerifyResponse | null>(null)
  const [resync, setResync] = useState<BlocksResyncResponse | null>(null)
  const [prefix, setPrefix] = useState('')

  return (
    <>
      <div className="gw-ops-card">
        <div className="gw-ops-card-head">
          <h2 className="gw-ops-card-title">空间回收</h2>
          <span className="gw-ops-card-desc">
            只做空间回收 —— 过期失效在**判定时**就已经发生（不点它，过期授权也不会继续有效）
          </span>
        </div>
        <div className="gw-ops-card-body">
          <div className="gw-ops-actions">
            <button
              type="button"
              className="gw-ops-btn"
              onClick={() =>
                props.confirm({
                  title: '回收过期的条目授权？',
                  body: '只做空间回收 —— 过期授权在判定时就已失效，不回收也不会继续有效。',
                  confirmLabel: '回收',
                  danger: false,
                  run: () =>
                    void props.run('purgeGrants', async () => {
                      const r = await purgeGrants()
                      return `条目授权：回收 ${r.expired} 条，表内剩 ${r.remaining} 条`
                    }),
                })
              }
            >
              回收过期条目授权
            </button>
            <button
              type="button"
              className="gw-ops-btn"
              onClick={() =>
                props.confirm({
                  title: '回收过期的邀请？',
                  body: '只做空间回收 —— 过期邀请在判定时就已失效，不回收也不会继续有效。',
                  confirmLabel: '回收',
                  danger: false,
                  run: () =>
                    void props.run('purgeInvitations', async () => {
                      const r = await purgeInvitations()
                      return `邀请：回收 ${r.expired} 条，表内剩 ${r.remaining} 条`
                    }),
                })
              }
            >
              回收过期邀请
            </button>
          </div>
        </div>
      </div>

      <div className="gw-ops-card">
        <div className="gw-ops-card-head">
          <h2 className="gw-ops-card-title">搜索索引核对</h2>
          <span className="gw-ops-card-desc">
            核对 `blocks` 与全文索引 `blocks_fts`（此前这个端点**界面上没有入口**）
          </span>
        </div>
        <div className="gw-ops-card-body">
          <div className="gw-ops-actions">
            <button
              type="button"
              className="gw-ops-btn"
              onClick={() =>
                void props.run('verifySearch', async () => {
                  const r = await verifySearchIndex()
                  setSearch(r)
                  return '搜索索引核对完成'
                })
              }
            >
              核对索引
            </button>
          </div>
          {search !== null && <VerdictBlock verdict={searchVerifyVerdict(search)} />}
        </div>
      </div>

      <div className="gw-ops-card">
        <div className="gw-ops-card-head">
          <h2 className="gw-ops-card-title">块级授权核对与重算</h2>
          <span className="gw-ops-card-desc">
            核对「块 ↔ 正文」与「tier ↔ 有效档位」（此前这两个端点**界面上没有入口**）
          </span>
        </div>
        <div className="gw-ops-card-body">
          <div className="gw-ops-actions">
            <button
              type="button"
              className="gw-ops-btn"
              onClick={() =>
                void props.run('verifyBlocks', async () => {
                  const r = await verifyBlocks()
                  setBlocks(r)
                  return '块级授权核对完成'
                })
              }
            >
              核对
            </button>
          </div>
          {blocks !== null && <VerdictBlock verdict={blocksVerifyVerdict(blocks)} />}

          <div className="gw-ops-filters">
            <div className="gw-ops-field gw-ops-field-grow">
              <label className="gw-ops-label" htmlFor="ops-resync-prefix">
                重算范围（slug 前缀，留空 = **全库**）
              </label>
              <input
                id="ops-resync-prefix"
                className="gw-ops-input"
                value={prefix}
                placeholder="例如 team/ 或留空全库"
                onChange={(e) => setPrefix(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="gw-ops-btn gw-ops-btn-danger"
              onClick={() =>
                props.confirm({
                  /*
                   * 全库重算是重活，且它**会改数据**（tier 是授权判定的一部分）——
                   * 故确认文案必须说清范围，并在留空时显式警告"全库"。
                   */
                  title: prefix.trim() === '' ? '重算**全库**的 tier？' : `重算 ${prefix.trim()} 子树的 tier？`,
                  body:
                    '按当前页面有效档位重算块级 tier。这是修复入口，但会写库：' +
                    '大库上耗时较长，且执行期间建议不要同时改页面权限。',
                  confirmLabel: '开始重算',
                  danger: true,
                  run: () =>
                    void props.run('resync', async () => {
                      const r = await resyncBlocks(prefix)
                      setResync(r)
                      return `重算完成：${r.pages} 页 / ${r.blocks} 块，失败 ${r.failed}`
                    }),
                })
              }
            >
              重算 tier
            </button>
          </div>
          {resync !== null && (
            <VerdictBlock
              verdict={
                resync.failed > 0
                  ? { level: 'warn', headline: `重算完成，但有 ${resync.failed} 处失败`, lines: resync.samples.map((s) => `${s.slug}（${s.reason}）`) }
                  : {
                      level: 'ok',
                      headline: `重算完成：${resync.pages} 页 / ${resync.blocks} 块`,
                      lines: [resync.subtree === null ? '范围：全库' : `范围：${resync.subtree} 子树`],
                    }
              }
            />
          )}
        </div>
      </div>
    </>
  )
}

/* ============================== 台面 ============================== */

export function OpsRoute(props: PluginRouteProps): ReactNode {
  /*
   * 分区进 URL：`#/audit/sessions`。宿主把首段之后的部分作为 `sub` 交过来，
   * 故深链是**双向**的 —— 点标签改 URL（可分享、可回退），直接开链接也能落到对应分区。
   * 非法/缺失的 `sub` 落到默认分区（`sectionById` 负责兜底）。
   */
  const section = useMemo<SectionId>(() => {
    const raw = props.sub.trim().replace(/\/+$/, '')
    if (raw === '') return DEFAULT_SECTION
    return sectionById(raw).id
  }, [props.sub])

  const [busy, setBusy] = useState('')
  const [err, setErr] = useState<OpsErrorView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  /** 刷新令牌：点「刷新」时自增，当前分区据此重取（分区组件内部各自持有数据） */
  const [reloadToken, setReloadToken] = useState(0)

  const onError = useCallback((e: unknown) => {
    setErr(describeOpsError(e))
  }, [])

  const run = useCallback(async (key: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(key)
    setErr(null)
    setNotice(null)
    try {
      setNotice(await fn())
      setReloadToken((t) => t + 1)
    } catch (e: unknown) {
      setErr(describeOpsError(e))
    } finally {
      setBusy('')
    }
  }, [])

  const requestConfirm = useCallback((r: ConfirmRequest) => {
    /*
     * 危险动作一律**先确认再执行**：确认请求进 state，真正的 api 调用留在 `run` 里。
     * 顺序不能倒过来 —— 把 `api.revokeSession(...)` 直接写进 onClick 里，
     * 类型检查、构建、甚至多数手工点击都不会报错，只是危险操作少了一次确认。
     */
    setConfirm(r)
  }, [])

  const current = sectionById(section)

  return (
    <div className="gw-ops">
      <div className="gw-ops-head">
        <h1 className="gw-ops-title">审计与运维</h1>
        <button
          type="button"
          className="gw-ops-btn"
          disabled={busy !== ''}
          onClick={() => {
            setNotice('已刷新')
            setErr(null)
            setReloadToken((t) => t + 1)
          }}
        >
          刷新
        </button>
        {/*
          执行中的可见反馈：`busy` 里存的是 `revoke:3` 这类内部键（用于禁用按钮），
          它**不出现在界面上** —— 用户只需要知道"正在执行"，不需要读内部标识。
        */}
        {busy !== '' && (
          <span className="gw-ops-status" role="status">
            正在执行…
          </span>
        )}
        <span className="gw-ops-spacer" />
        <span className="gw-ops-sub">{current.hint}</span>
      </div>

      {err !== null && (
        <p className="gw-ops-error" role="alert">
          {err.title}
          {err.hint === '' ? '' : ` —— ${err.hint}`}
        </p>
      )}
      {notice !== null && (
        <p className="gw-ops-status" role="status">
          {notice}
        </p>
      )}

      <div className="gw-ops-tabs" role="tablist" aria-label="审计与运维分区">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === section}
            className={s.id === section ? 'gw-ops-tab gw-ops-tab-on' : 'gw-ops-tab'}
            onClick={() => props.onNavigate(`audit/${s.id}`)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <ConfirmBar request={confirm} onCancel={() => setConfirm(null)} />

      {section === 'security' && (
        <AuditSection
          view="security"
          reloadToken={reloadToken}
          busy={busy}
          run={run}
          onError={onError}
        />
      )}
      {section === 'acl' && (
        <AuditSection view="acl" reloadToken={reloadToken} busy={busy} run={run} onError={onError} />
      )}
      {section === 'sessions' && (
        <SessionsSection
          reloadToken={reloadToken}
          run={run}
          confirm={requestConfirm}
          onError={onError}
        />
      )}
      {section === 'diagnose' && <DiagnoseSection run={run} onError={onError} />}
      {section === 'maintain' && <MaintainSection run={run} confirm={requestConfirm} />}
    </div>
  )
}

/* ============================== 注册 ============================== */

/**
 * 插件入口：把本页面注册到宿主路由 `audit`。
 *
 * 路由 id 必须与清单 `routes[0].id` **逐字一致** —— 不一致的症状是"导航项在（它来自入口表，
 * 不需要 bundle），点进去一片空白、console 里连一条错误都没有"。
 * `packages/plugin-ops/test/opsUi.test.ts` 用源码级断言钉住这一致性。
 */
export function register(host: PluginUiHost): () => void {
  return host.registerRoute('audit', OpsRoute)
}

export default register