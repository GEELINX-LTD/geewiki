/**
 * **我提交过的访问申请**（slug → 申请 id）—— 只存这一件事。
 * ============================================================================
 *
 * ## 为什么需要它
 *
 * 撤回端点按 `id` 定位（`POST /api/pages/:slug/access-requests/:id/withdraw`），
 * 而服务端**没有**"查我的待审申请"的端点：`GET …/access-requests` 是**审批人视角**
 * 的待审列表（需要可见性管理权，普通申请人会被 403/404）。于是申请人刷新页面后
 * 就再也拿不到那个 id ⇒ "你可以撤回"这句话变成空头支票。
 *
 * 存本地是**唯一可行**的落点（也是刻意的：申请本身在服务端有记录，这里只是句柄缓存）。
 *
 * ## 硬约束
 *
 * 1. **只存 `{slug: id}`**，不存申请正文、不存角色 —— 本地存储是最容易被旁观者看到的地方
 *    （共用电脑、浏览器同步），而"申请了哪个页面"本身已属敏感信息，能少存就少存。
 * 2. **全部 try/catch**：Safari 隐私模式、浏览器禁用存储、配额满都会抛。
 *    这里任何一次抛错都不得影响页面功能（静默降级为"记不住"），
 *    所以**没有**任何 `throw` 路径，也没有 `console.error` 噪声。
 * 3. 读到的脏数据（旧版本、被手改、类型不对）一律当"没有" —— 一个非数字 id 传进
 *    撤回端点会变成一个无意义的 400，比"按钮不出现"更坏。
 */

/** localStorage 键名（带版本后缀：将来形状变了可以直接换 key，不必写迁移） */
export const MY_ACCESS_REQUESTS_KEY = 'gw.access-requests.v1'

/** localStorage 的最小形状（便于测试注入 stub；浏览器 `Storage` 天然满足） */
interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 取本地存储。**访问 `window.localStorage` 这个属性本身就可能抛**
 * （Safari 隐私模式），故连取值都在 try 里。
 */
function storage(): MinimalStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return (window as unknown as { localStorage?: MinimalStorage }).localStorage ?? null
  } catch {
    return null
  }
}

/** 读出全部记录；任何异常/脏数据都退化成空表 */
function readAll(): Record<string, number> {
  const s = storage()
  if (s === null) return {}
  try {
    const raw = s.getItem(MY_ACCESS_REQUESTS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [slug, id] of Object.entries(parsed as Record<string, unknown>)) {
      // 只接受正整数 id：0/负数/字符串都不可能是服务端给的申请 id
      if (typeof id === 'number' && Number.isInteger(id) && id > 0 && slug !== '') out[slug] = id
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, number>): void {
  const s = storage()
  if (s === null) return
  try {
    s.setItem(MY_ACCESS_REQUESTS_KEY, JSON.stringify(map))
  } catch {
    /* 存不下就算了：本次会话内按钮仍可用，只是刷新后拿不回撤回句柄 */
  }
}

/** 记下"我在这条内容上提交过申请"，拿到 id 之后立刻调用 */
export function rememberRequest(slug: string, id: number): void {
  if (slug === '' || !Number.isInteger(id) || id <= 0) return
  const map = readAll()
  map[slug] = id
  writeAll(map)
}

/** 取回本机记下的申请 id；没有/已损坏/存储不可用 ⇒ `null` */
export function recallRequest(slug: string): number | null {
  if (slug === '') return null
  return readAll()[slug] ?? null
}

/** 忘掉一条（撤回成功、或被裁决之后调用） */
export function forgetRequest(slug: string): void {
  if (slug === '') return
  const map = readAll()
  if (!Object.prototype.hasOwnProperty.call(map, slug)) return
  delete map[slug]
  writeAll(map)
}
