/**
 * 「审计与运维」的**纯判据层**：数据形状、查询串构造、分页、以及把端点返回的裸 JSON
 * 判成一句人话。
 *
 * ## 为什么单独一个模块
 *
 * 三条理由，缺一条都足以让它独立：
 *
 * 1. **可在 node 里直测**。本文件零 import（不碰 DOM、不碰 fetch、不碰 React），
 *    于是 `test/opsPlan.test.ts` 能用真实数据把每一条判据都跑一遍 ——
 *    而这些判据正是这一轮"功能性优化"的全部内容（原来的页面把端点返回直接铺成几行
 *    裸文本，用户看不出"这算正常还是不正常"）。
 * 2. **判据与渲染分开**。渲染层（`index.tsx`）只负责把 `Verdict` 画出来；
 *    要改"什么算异常"只改这里，不必进 JSX。
 * 3. **避免"把 JSON 抄一遍"**。原来的页面把 `sitemap.unreadable.map(...)` 之类的
 *    表达式直接写在 JSX 里，于是"泄漏方向必须为空"这条**语义**只存在于那一行 JSX 里，
 *    既测不到也读不出。现在它是一条有名字的判据。
 *
 * ## 数据形状为什么定义在这里而不是 `api.ts`
 *
 * 它们是**端点契约**（`packages/plugin-search|wiki|authz|auth` 的 `h.json(200, …)`），
 * 不是 I/O 细节。放在纯模块里，`api.ts` 只做"发请求 + 断言形状"，判据层与测试都能用。
 */

/* ============================== 数据形状（端点契约） ============================== */

/** 一条审计记录（`GET /api/admin/audit`）。`before`/`after` 是**未定形**的 JSON */
export interface AuditEntry {
  readonly id: number
  readonly at: string
  readonly actorId: number | null
  readonly actorIpHash: string | null
  readonly action: string
  readonly targetKind: string
  readonly targetId: string
  readonly before?: unknown
  readonly after?: unknown
  readonly requestId?: string | null
}

export interface AuditResponse {
  readonly ok: true
  readonly view: 'all' | 'acl' | 'security'
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly entries: readonly AuditEntry[]
}

export interface SessionEntry {
  readonly id: string
  readonly userId: number | null
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly expiresAt: string
  readonly idleExpiresAt: string | null
  readonly revokedAt: string | null
  readonly userAgent: string | null
  /** **哈希**，不是 IP 原文 */
  readonly ipHash: string | null
  readonly status: string
}

export interface SessionsResponse {
  readonly ok: true
  readonly total: number
  readonly limit: number
  readonly entries: readonly SessionEntry[]
}

export interface RevokeSessionsResponse {
  readonly ok: true
  readonly userId: number
  readonly revokedCount: number
  readonly revokedAt: string
}

export interface AccessExplainResponse {
  readonly ok: true
  readonly slug: string
  readonly positionalRank: number
  readonly reach: { readonly anonymous: boolean; readonly anonymousReason: string; readonly orgMember: boolean }
  readonly sources: {
    readonly grants: {
      readonly pages: readonly unknown[]
      readonly blocks: readonly unknown[]
      readonly effective: boolean
      readonly blockGrantsAvailable: boolean
    }
    readonly ancestors: readonly {
      readonly slug: string
      readonly effect: string
      readonly visibility?: string | null
      readonly inherit?: boolean
      readonly reason?: string | null
    }[]
    readonly orgRole: { readonly rule: string; readonly effective: boolean; readonly relevant: boolean }
    readonly adminOverride: { readonly rule: string; readonly effective: boolean; readonly relevant: boolean }
  }
}

export interface SitemapAuditResponse {
  readonly ok: true
  readonly sameSource: true
  readonly advertisedCount: number
  readonly unreadable: readonly { readonly slug: string; readonly reason: string }[]
  readonly omitted: readonly string[]
  readonly consistent: boolean
}

export interface CachePlanResponse {
  readonly ok: true
  readonly since: string
  readonly events: readonly { readonly action: string; readonly count: number }[]
  readonly eventCount: number
  readonly purgeRecommended: boolean
  readonly sharedCacheable: readonly { readonly path: string; readonly cacheControl: string }[]
  readonly notSharedCacheable: readonly { readonly path: string; readonly cacheControl: string }[]
  readonly targets: readonly string[]
  readonly note: string
}

/** `GET /api/admin/search/verify` —— 搜索索引（`blocks_fts`）核对 */
export interface SearchVerifyResponse {
  readonly ok: true
  readonly index: 'present' | 'absent'
  readonly blocks: number
  readonly missing: number | null
  readonly extra: number | null
  readonly tier_null: number
  readonly granted: number
  readonly tier_mismatch: boolean
  readonly sampled: number
  readonly sample_misses: number
  readonly miss_samples: readonly number[]
}

/** `GET /api/admin/blocks/verify` —— 块 ↔ 正文、tier ↔ 有效档位 核对 */
export interface BlocksVerifyResponse {
  readonly ok: true
  readonly checked: number
  readonly mismatched: number
  readonly unparseable: number
  readonly tier_checked: number
  readonly tier_mismatched: number
  readonly tier_check_skipped: boolean
  readonly samples: readonly { readonly slug: string; readonly reason: string }[]
  readonly tier_samples: readonly { readonly slug: string; readonly reason: string }[]
}

/** `POST /api/admin/blocks/resync?prefix=…` —— tier 重算（修复入口） */
export interface BlocksResyncResponse {
  readonly ok: true
  readonly subtree: string | null
  readonly pages: number
  readonly blocks: number
  readonly failed: number
  readonly samples: readonly { readonly slug: string; readonly reason: string }[]
}

/** 回收类动作的统一回执（过期条目授权 / 过期邀请） */
export interface PurgeResponse {
  readonly ok: true
  readonly expired: number
  readonly remaining: number
  readonly at: string
}

/* ============================== 判据：Verdict ============================== */

/**
 * 一条可读的结论。
 *
 * 为什么要有 `level` 而不只是一段文字：这些核对的价值全在"**要不要处理**"。
 * 原来把 `mismatched=0 unparseable=0 …` 铺成一行裸文本，运维得自己记住每个字段
 * 的正常值 —— 而记错的表现是"看着挺正常"。
 */
export interface Verdict {
  readonly level: 'ok' | 'warn' | 'bad'
  readonly headline: string
  readonly lines: readonly string[]
}

const ok = (headline: string, lines: readonly string[] = []): Verdict => ({ level: 'ok', headline, lines })
const warn = (headline: string, lines: readonly string[] = []): Verdict => ({ level: 'warn', headline, lines })
const bad = (headline: string, lines: readonly string[] = []): Verdict => ({ level: 'bad', headline, lines })

/**
 * 搜索索引核对。
 *
 * 判据的顺序是**危害从大到小**：索引缺失 ⇒ 检索整体失效；`missing` ⇒ 有内容搜不到；
 * `tier_mismatch` ⇒ 越权可搜（这是安全问题，不只是不一致）；`extra` ⇒ 垃圾条目（只影响
 * 体积）；抽样未命中 ⇒ 索引与查询口径不一致（比计数不一致更隐蔽）。
 */
export function searchVerifyVerdict(r: SearchVerifyResponse): Verdict {
  if (r.index === 'absent') {
    return bad('blocks_fts 索引不存在', ['检索会整体失效（或退化为全表扫描）。需要在插件管理里重启用 @geewiki/search。'])
  }
  const lines: string[] = [`块表 ${r.blocks} 条，抽样 ${r.sampled} 次`]
  const problems: string[] = []
  if ((r.missing ?? 0) > 0) problems.push(`${r.missing} 个块**没有被索引**（这些内容搜不到）`)
  if (r.tier_mismatch) {
    problems.push(`tier 为空的块 ${r.tier_null} 条 ≠ 档位为 granted 的块 ${r.granted} 条（**越权可搜**方向）`)
  }
  if (r.sample_misses > 0) {
    problems.push(`抽样查询有 ${r.sample_misses} 次没命中自己的块（id ${r.miss_samples.join('、')}）—— 索引与查询口径不一致`)
  }
  if ((r.extra ?? 0) > 0) problems.push(`索引里有 ${r.extra} 条指向已不存在的块（只占体积）`)
  if (problems.length === 0) return ok('索引与块表一致', lines)
  const level = (r.missing ?? 0) > 0 || r.tier_mismatch || r.sample_misses > 0 ? 'bad' : 'warn'
  return level === 'bad' ? bad(`发现 ${problems.length} 类问题`, [...lines, ...problems]) : warn(`发现 ${problems.length} 类问题`, [...lines, ...problems])
}

/**
 * 块级授权核对。
 *
 * `mismatched` 与 `tier_mismatched` 是**互不包含**的两类：前者是"块与正文漂移"
 * （正文改了、块没重解析），后者是"tier 算错"。混成一个数就看不出该修哪一类 ——
 * 所以这里也分成两行，并且**两者的修复入口不同**（前者只能靠重存页面，后者可以重算）。
 */
export function blocksVerifyVerdict(r: BlocksVerifyResponse): Verdict {
  const lines = [`核对 ${r.checked} 页，tier 核对 ${r.tier_checked} 页`]
  const problems: string[] = []
  if (r.mismatched > 0) problems.push(`块与正文漂移 ${r.mismatched} 页（正文改了但块没重解析）`)
  if (r.tier_mismatched > 0) problems.push(`tier 与有效档位不符 ${r.tier_mismatched} 页（可用下面的「重算 tier」修复）`)
  if (r.unparseable > 0) problems.push(`${r.unparseable} 页的正文解析不出块（不影响阅读，只影响按段授权与检索）`)
  if (r.tier_check_skipped) lines.push('tier 这一项**没有检查**：policy-service 不可用（这不是"检查通过"）')
  if (problems.length === 0 && !r.tier_check_skipped) return ok('块与正文、tier 与档位都一致', lines)
  if (problems.length === 0) return warn('块与正文一致，但 tier 未检查', lines)
  const level = r.mismatched > 0 || r.tier_mismatched > 0 ? 'bad' : 'warn'
  return level === 'bad' ? bad(`发现 ${problems.length} 类问题`, [...lines, ...problems]) : warn(`发现 ${problems.length} 类问题`, [...lines, ...problems])
}

/**
 * sitemap 核对。
 *
 * ⚠️ 判据刻意**不看"广告集合与匿名可见集合的差"**：两者同源（同一个出口），
 * 那个差恒为空、没有信息量。有信息量的是两个**方向**：
 * 「被广告却匿名读不到」是泄漏方向（必须为空），「匿名读得到却未被广告」是一致性方向。
 */
export function sitemapVerdict(r: SitemapAuditResponse): Verdict {
  const lines = [`广告 ${r.advertisedCount} 条`]
  if (r.unreadable.length > 0) {
    return bad('有页面被 sitemap 广告，但匿名读不到', [
      ...lines,
      ...r.unreadable.map((u) => `${u.slug}（${u.reason}）`),
    ])
  }
  if (r.omitted.length > 0) {
    return warn('有页面匿名读得到，但没进 sitemap', [...lines, ...r.omitted])
  }
  return ok('两个方向都为空', lines)
}

/** 清缓存指引 */
export function cacheVerdict(r: CachePlanResponse): Verdict {
  const lines = [
    `窗口起点 ${formatTime(r.since)}，窗口内 ACL 变更 ${r.eventCount} 条`,
    ...r.events.map((e) => `${e.action} × ${e.count}`),
    r.note,
  ]
  if (r.purgeRecommended) return warn('建议清一次共享缓存', [...lines, `需清理：${r.targets.join('、') || '（无）'}`])
  return ok('窗口内没有需要清缓存的权限变更', lines)
}

/* ============================== 查询串与分页 ============================== */

export interface AuditFilters {
  readonly action: string
  readonly targetKind: string
  readonly since: string
  readonly until: string
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = { action: '', targetKind: '', since: '', until: '' }

/** 每页条数。50 与后端 `limit` 的缺省口径一致 */
export const AUDIT_PAGE_SIZE = 50

export function hasAuditFilters(f: AuditFilters): boolean {
  return f.action.trim() !== '' || f.targetKind.trim() !== '' || f.since !== '' || f.until !== ''
}

/**
 * 构造 `/api/admin/audit` 的查询串。
 *
 * `view` **必须**由调用方显式给出且只允许 security / acl —— 服务端用显式白名单把两类
 * 记录分开（`SECURITY_ACTIONS` / `ACL_ACTIONS`），前端取 `all` 再自己分类等于把那套
 * 白名单抄了第二份，而抄的那份迟早与真源漂移（且漂移是静默的：只是某类事件不再告警）。
 */
export function auditQuery(
  view: 'security' | 'acl',
  filters: AuditFilters,
  offset: number,
  limit = AUDIT_PAGE_SIZE,
): string {
  const q = new URLSearchParams()
  q.set('view', view)
  for (const key of ['action', 'targetKind', 'since', 'until'] as const) {
    const v = filters[key].trim()
    if (v !== '') q.set(key, v)
  }
  q.set('limit', String(limit))
  q.set('offset', String(Math.max(0, offset)))
  return q.toString()
}

export function pageCount(total: number, limit: number): number {
  if (limit <= 0) return 1
  return Math.max(1, Math.ceil(total / limit))
}

/** 把页码夹到有效范围（改筛选条件后页码可能越界 —— 越界时后端返回空数组而不是报错，看起来像"没有记录"） */
export function clampPage(page: number, total: number, limit: number): number {
  const last = pageCount(total, limit)
  if (!Number.isFinite(page)) return 1
  return Math.min(Math.max(1, Math.trunc(page)), last)
}

/* ============================== 呈现辅助 ============================== */

/** 时间：空值显示 `—`（不是 `Invalid Date`，也不是空白 —— 空白会被读成"刚发生"） */
export function formatTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN')
}

/**
 * 操作者标签。
 *
 * ⚠️ 这里只能拿到 `actorId`（数字），**没有用户名** —— 端点的响应里就没有它。
 * 显示 `#12` 是如实呈现，不是偷懒；要做成"张三"得先让 auth 端点带上用户名。
 * 刻意**不**把 id 渲染成看起来像人名的东西（那会让运维以为已经解析过了）。
 */
export function actorLabel(actorId: number | null): string {
  return actorId === null ? '（匿名）' : `#${actorId}`
}

/**
 * 展开 `before` / `after` 的**差异字段**。
 *
 * 这是这一轮补上的最大一处功能缺口：`AuditEntry.before` / `.after` 一直有数据，
 * 而界面从来没渲染过 —— 于是「谁在什么时候改了哪条可见性」这张表**答不出"改成了什么"**，
 * 而那正是合规记录的全部意义。
 *
 * 只列**真的变了**的键：两边都有的键取差集；只在一边出现的键也算变化
 * （新增/删除字段本身就是一次变更）。
 */
export function changedFields(
  before: unknown,
  after: unknown,
): readonly { readonly key: string; readonly before: string; readonly after: string }[] {
  const b = asRecord(before)
  const a = asRecord(after)
  if (b === null && a === null) return []
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort()
  const out: { key: string; before: string; after: string }[] = []
  for (const key of keys) {
    const bv = b?.[key]
    const av = a?.[key]
    if (sameValue(bv, av)) continue
    out.push({ key, before: shortValue(bv), after: shortValue(av) })
  }
  return out
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/** 把一个 JSON 值压成一行可读文本（超长截断 —— 变更记录里塞整篇正文是常态） */
export function shortValue(v: unknown): string {
  if (v === undefined) return '（无）'
  if (v === null) return 'null'
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

/* ============================== 页面分区模型 ============================== */

/**
 * 台面的分区。
 *
 * 原来这五块是**纵向堆叠的五张卡片**，一屏看不完、也没有"我在看哪一块"这回事；
 * 更要命的是"越权尝试"与"权限变更"必须**默认就分开**（服务端的白名单就是这个判据），
 * 而堆叠式布局里它们只是上下两张长得一样的表。
 *
 * 分区之后每一块都是**一个明确的意图**：出了安全事件看「安全事件」，要查某人会话看
 * 「会话」，要排障看「排障」，要动手维护看「维护」。
 */
export const SECTIONS = [
  { id: 'security', label: '安全事件', hint: '越权尝试：有人在探测权限边界。要告警' },
  { id: 'acl', label: '权限变更', hint: '谁在什么时候改了哪条可见性。要留存' },
  { id: 'sessions', label: '会话', hint: '登录中的会话、按用户批量吊销' },
  { id: 'diagnose', label: '排障', hint: '反向展开「谁能看这条」、sitemap 核对、清缓存指引' },
  { id: 'maintain', label: '维护', hint: '空间回收、搜索索引核对、块级授权核对与重算' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

export const DEFAULT_SECTION: SectionId = 'security'

export function sectionById(id: string): (typeof SECTIONS)[number] {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]
}