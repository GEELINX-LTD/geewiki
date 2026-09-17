/**
 * `/api/admin/audit` 的**查询语义**：把查询串翻译成 WHERE 子句、绑定参数与分页。
 *
 * ## 为什么从处理函数里抽出来
 *
 * 这段逻辑的风险**不在"能不能查"，而在三个静默的错法**：
 *
 * 1. **参数顺序**。WHERE 子句与 `params` 数组是**两条平行列表**，靠 push 的先后对齐；
 *    中间插一个条件而忘了同步插参数，SQL 不会报错 —— 它会把 `since` 的值拿去比 `action`，
 *    然后**返回空集**。而"空集"在这里读起来就是"没有这类事件"。
 * 2. **匿名的 NULL**。`actor_id = 0` 在 SQL 三值逻辑下匹配不到任何行，所以"只看匿名"
 *    必须生成 `IS NULL` 而不是 `= ?`；写错的表现同样是"这个人没做过任何事"。
 * 3. **非法值静默忽略**。用户筛了、结果没变，会被读成"这个人做了这么多事"——
 *    一个**错误结论**，而不是"少了过滤"。故非法 `actorId` 显式报错。
 *
 * 抽成纯函数之后，这三条都能在 node 里逐条断言（`test/audit-query.test.ts`），
 * 而不必起数据库、造会话、发 HTTP —— 这份插件此前没有任何集成测试基建
 * （`test/audit-appendonly.test.ts` 是源码级守卫）。
 *
 * ## 它刻意不认识 `ACL_ACTIONS` / `SECURITY_ACTIONS`
 *
 * 那两张白名单声明在插件的 `apply` 里（与审计写入路径同处），由调用方**传值**进来。
 * 这样本模块不 import 插件的任何东西，既不制造循环依赖，也让它保持可独立测试。
 */

/** 一页最多返回多少条（超过就夹到上限，而不是报错 —— 与既有的 limit 语义一致） */
export const AUDIT_PAGE_MAX = 200

export interface AuditQueryPlan {
  readonly view: 'all' | 'acl' | 'security'
  /** 已含前导 ` WHERE `，或空串（无条件）。**与 `params` 严格一一对应** */
  readonly where: string
  /** 绑定参数。属性只读，但**内容是可变数组** —— 驱动签名要 `unknown[]`，且它只读不改写 */
  readonly params: unknown[]
  readonly limit: number
  readonly offset: number
}

export type AuditQueryResult =
  | { readonly ok: true; readonly plan: AuditQueryPlan }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface AuditQueryInput {
  readonly q: URLSearchParams
  /** `view=acl` 时使用的动作白名单 */
  readonly aclActions: readonly string[]
  /** `view=security` 时使用的动作白名单 */
  readonly securityActions: readonly string[]
  readonly maxLimit?: number
}

/**
 * 把查询串翻成可执行的计划。
 *
 * 失败**不抛异常**而是返回 `{ok:false}`：调用方要把它翻成 HTTP 400 + 一个错误码，
 * 而这正是"非法值必须显式报错"那条纪律的落点（见文件头第 3 条）。
 */
export function planAuditQuery(input: AuditQueryInput): AuditQueryResult {
  const q = input.q
  const view = q.get('view') ?? 'all'
  if (view !== 'all' && view !== 'acl' && view !== 'security') {
    return { ok: false, code: 'invalid_view', message: 'view 须为 all | acl | security 之一' }
  }

  const where: string[] = []
  const params: unknown[] = []

  /*
   * 两类记录在白名单层面就分开（`security` 要告警、`acl` 要留存），
   * 而不是查出来再在前端分 —— 理由见 audit_log 写入侧对两张白名单的说明。
   */
  if (view === 'acl' || view === 'security') {
    const names = [...(view === 'acl' ? input.aclActions : input.securityActions)]
    where.push(`action IN (${names.map(() => '?').join(', ')})`)
    params.push(...names)
  }

  for (const [key, column] of [
    ['action', 'action'],
    ['targetKind', 'target_kind'],
    ['targetId', 'target_id'],
  ] as const) {
    const v = q.get(key)
    if (v !== null && v !== '') {
      where.push(`${column} = ?`)
      params.push(v)
    }
  }

  const since = q.get('since')
  if (since !== null && since !== '') {
    where.push('at >= ?')
    params.push(since)
  }
  const until = q.get('until')
  if (until !== null && until !== '') {
    where.push('at <= ?')
    params.push(until)
  }

  /*
   * `actorId`：按操作者收窄（「看某个人做过什么」）。
   *
   * 两种形态，且**都**是真实存在的排查需求：
   *   · 一个非负整数 ⇒ `actor_id = ?`（某个具体的人）；
   *   · 字面量 `anonymous` ⇒ `actor_id IS NULL`（**匿名**的那一批）。
   * 后者不能靠"传一个不存在的 id"代替：匿名行的 `actor_id` 是 NULL，
   * `actor_id = 0` 在 SQL 三值逻辑下匹配不到任何行 —— 那看起来像"这个人没做过任何事"。
   *
   * 非法值**显式报错**，不静默忽略：静默忽略会让"我筛了但结果还是全部"
   * 被读成"这个人做了这么多事"，而那是**错误结论**而不是少了过滤。
   */
  const actorRaw = q.get('actorId')
  if (actorRaw !== null && actorRaw !== '') {
    if (actorRaw === 'anonymous') {
      where.push('actor_id IS NULL')
    } else {
      const actorId = Number(actorRaw)
      if (!Number.isInteger(actorId) || actorId < 0) {
        return {
          ok: false,
          code: 'invalid_actor_id',
          message: 'actorId 须为非负整数，或字面量 anonymous（表示只看匿名操作）',
        }
      }
      where.push('actor_id = ?')
      params.push(actorId)
    }
  }

  const max = input.maxLimit ?? AUDIT_PAGE_MAX
  const rawLimit = Number(q.get('limit') ?? max)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), max) : max
  const rawOffset = Number(q.get('offset') ?? 0)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0

  return {
    ok: true,
    plan: { view, where: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '', params, limit, offset },
  }
}
