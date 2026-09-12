/**
 * 作者缺失时的唯一表述。
 *
 * 这个模块只有十几行，但**必须独立存在**：`VersionDiffDialog` 与 `lib/versionPlan.ts`
 * 都要用它，而前者需要 `versionPlan` 的版本号算法、后者需要作者文案 —— 若把 `authorText`
 * 留在 `VersionDiffDialog` 里，两者就构成循环 import（运行时靠函数声明提升能跑通，
 * 但那是巧合而非设计）。下沉到无依赖的小模块，两边都是单向依赖。
 */
export const UNKNOWN_AUTHOR = '未记录'

/**
 * 作者展示名。
 *
 * `null` / 不存在的字段 / 空字符串 / 纯空白一律显示「未记录」：
 * **不猜、不写"匿名"、不留空** —— "匿名"会被读成"某人以匿名身份改的"，
 * 而事实是"这条记录没有作者信息"。
 */
export function authorText(author: { displayName?: string | null } | null | undefined): string {
  const name = author?.displayName
  return typeof name === 'string' && name.trim() !== '' ? name : UNKNOWN_AUTHOR
}
