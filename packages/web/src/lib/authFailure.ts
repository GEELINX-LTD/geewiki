/**
 * 认证类失败的**统一出口决策**（纯函数，便于单测）。
 *
 * 为什么单独成文件：401 / 403 / 503 的处置分散在各调用点必然漂移——某一处忘了跳登录，
 * 用户就会看到一句"请求未被接受"而不是登录页。把"该不该跳、跳到哪"收敛成一个纯函数，
 * 副作用（改 hash、清缓存）留给 `authStore` 与 `api.ts`。
 *
 * 三类语义**互不相同**，不能合并（设计文档 §2.5 ⑥）：
 * - `401 unauthorized`：缺凭据或凭据失效 ⇒ 去登录。**不弹错误提示** —— 用户没做错事，
 *   弹一个红色 toast 再跳走只会让人以为系统坏了。
 * - `403 forbidden`：已认证但权限不足 ⇒ 去"无访问权限"页（说明清楚 + 给出下一步）。
 * - `503 bootstrap_required`：系统根本还没初始化（库里没有可登录账号）⇒ 去初始化向导。
 *   它**不是**"请登录"：引导期没有可登录的东西，显示登录页会让用户在那儿死循环。
 */

export type AuthFailureAction =
  | { kind: 'login'; redirect: string }
  | { kind: 'denied' }
  | { kind: 'setup' }
  | null

/**
 * 判断一个 HTTP 失败是否属于"认证/授权"类，并给出应去的页面。
 *
 * @param status HTTP 状态码
 * @param code   后端错误信封里的机器码（`error` 字段）
 * @param currentHash 当前 hash（登录后回跳用）
 */
export function authFailureAction(
  status: number,
  code: string | undefined,
  currentHash: string,
): AuthFailureAction {
  if (status === 401) return { kind: 'login', redirect: normalizeRedirect(currentHash) }
  if (status === 503 && code === 'bootstrap_required') return { kind: 'setup' }
  /*
   * 只有 `forbidden` 才跳"无权限"页。
   *
   * ⚠️ **`csrf_rejected` 刻意排除**：它意味着"这个客户端没按约定带 CSRF 头"，
   * 是本机代码/脚本的问题，不是权限问题 —— 把它显示成"你无权访问"会指向完全错误的排查方向
   * （用户会去找管理员要权限，而真正该看的是请求构造）。
   */
  if (status === 403 && (code === 'forbidden' || code === 'hook_invalid_verdict')) return { kind: 'denied' }
  return null
}

/**
 * 从任意 thrown 值里取出决策。
 *
 * **刻意不 import `ApiError`**：`api.ts` 会 import 本模块（用它做统一出口），
 * 若这里再反向 import `ApiError`，就形成 `api → authFailure → api` 的循环。
 * 循环在 ESM 下多数时候能跑（只在函数里用到类，不触 TDZ），但那属于"靠加载顺序侥幸",
 * 一旦将来有人在模块顶层用到 `ApiError` 就会炸。改用**结构化判定**（有 `status` 数字即认），
 * 依赖方向就变成单向的。
 */
export function authFailureFromError(err: unknown, currentHash: string): AuthFailureAction {
  if (typeof err !== 'object' || err === null) return null
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return null
  const code = (err as { code?: unknown }).code
  return authFailureAction(status, typeof code === 'string' ? code : undefined, currentHash)
}

/**
 * 回跳地址规范化：只接受站内 hash 路由。
 *
 * **安全**：这个值会被写回 `window.location.hash`，因此必须挡住 `//evil.com`、
 * `javascript:` 这类"看起来像路径的外部地址"。判据是"必须以 `/` 开头且不以 `//` 开头"
 * —— 只允许站内 hash 路由，其它一律退回知识库首页。
 *
 * 入参可为空（查询串里根本没有 `redirect` 时就是 `null`）—— 边界函数必须容忍缺失值，
 * 而不是把"没传"变成一次崩溃。
 */
export function normalizeRedirect(hash: string | null | undefined): string {
  const raw = (hash ?? '').startsWith('#') ? (hash ?? '').slice(1) : (hash ?? '')
  if (!raw.startsWith('/')) return '/wiki'
  if (raw.startsWith('//')) return '/wiki'
  // 登录页/初始化页自身不能作为回跳目标（否则登录成功后又跳回登录页）
  if (raw === '/login' || raw === '/setup' || raw.startsWith('/login?') || raw.startsWith('/setup?')) {
    return '/wiki'
  }
  return raw
}
