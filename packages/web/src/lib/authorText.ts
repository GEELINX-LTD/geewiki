/**
 * 作者文案的**唯一真源**。
 *
 * 这个模块只有二十几行，但**必须独立存在**：`VersionDiffDialog` 与 `lib/versionPlan.ts`
 * 都要用它，而前者需要 `versionPlan` 的版本号算法、后者需要作者文案 —— 若把 `authorText`
 * 留在 `VersionDiffDialog` 里，两者就构成循环 import（运行时靠函数声明提升能跑通，
 * 但那是巧合而非设计）。下沉到无依赖的小模块，两边都是单向依赖。
 */

/** 这条记录**没有**作者信息（0019 之前的旧行、跨插件代调用、账号已删） */
export const UNKNOWN_AUTHOR = '未记录'

/**
 * **记了是谁改的，但名字不对你显示。**
 *
 * 服务端对「其余主体」刻意只回 `author.id` 而不回真名（版本列表端点的三档规则：
 * 你自己 / owner·admin ⇒ 真名；其余 ⇒ `displayName: null`），因为 id 可枚举、
 * 一律回真名等于给普通成员开一条枚举组织成员的旁路。
 *
 * 所以这个 `null` **不等于「未记录」**：用「未记录」会把"权限上收"讲成"当时没记"，
 * 是两件完全不同的事。而 "匿名" 更不能写 —— 服务端明明记了 `saved_by`。
 * 三档措辞各说各的事实，不加修饰。
 */
export const HIDDEN_AUTHOR = '另一位成员'

/**
 * 作者展示名。
 *
 * 判据是**对象在不在**，不是名字空不空（这两件事必须分开）：
 *   - `author` 为 `null`/`undefined` ⇒ 服务端连 id 都没给 ⇒「未记录」；
 *   - `author` 有 `id`、`displayName` 为 `null`/空 ⇒ 记了人、名字被权限收走 ⇒「另一位成员」；
 *   - 有名字 ⇒ 显示名字。
 *
 * 注意服务端与本函数的口径边界：服务端在"账号已删"时回的是 `author: null`
 * （**不是** `{id, displayName: null}`），所以"有 id 但没名字"这一形态**只**来自
 * 名字可见性规则，本函数不需要再去区分第三层。
 */
export function authorText(
  author: { id?: number; displayName?: string | null } | null | undefined,
): string {
  if (author === null || author === undefined) return UNKNOWN_AUTHOR
  const name = author.displayName
  if (typeof name === 'string' && name.trim() !== '') return name
  // 有 id ⇒ 服务端记了作者；走到这里只可能是"名字未下发"
  return typeof author.id === 'number' ? HIDDEN_AUTHOR : UNKNOWN_AUTHOR
}
