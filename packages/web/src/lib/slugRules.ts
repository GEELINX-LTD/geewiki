/**
 * 页面标识（slug）规则的**前端镜像**。
 *
 * 为什么需要镜像而不是直接复用后端常量：
 * - `packages/web` **不依赖** `@geewiki/wiki`（它是插件，不是前端依赖）；
 * - 也**不能**依赖 `@geewiki/core`——core 顶层 `import 'node:fs'`，进浏览器会炸。
 * 所以规则只能在这里再写一份。代价是"两边会漂移"，因此配套了
 * `packages/web/test/slugRules.test.ts` 的**对齐守卫**：
 * 它把后端源码模块真的 import 进来，逐条比对行为与常量——
 * 后端改规则而前端没跟，该测试立刻红，**不会**像过去那样沉默地绿。
 *
 * 后端单一事实来源：`packages/plugin-wiki/src/index.ts` 的
 * `SLUG_SEGMENT_RE` / `SLUG_MAX_LENGTH` / `SLUG_MAX_DEPTH` /
 * `RESERVED_FIRST_SEGMENTS` / `RESERVED_SECOND_SEGMENT` / `isValidSlug`。
 *
 * 规则（自后端支持分层起）：
 *   - 非空，总长 ≤ {@link SLUG_MAX_LENGTH}，段数 ≤ {@link SLUG_MAX_DEPTH}
 *   - 每段都满足 {@link SLUG_SEGMENT_RE}（⇒ 拒绝空段、首尾斜杠、`.`/`..`、非法字符）
 *   - 首段不在 {@link RESERVED_FIRST_SEGMENTS}（那些会被前端路由吃掉）
 *   - 第二段不是 {@link RESERVED_SECOND_SEGMENT}（那是"编辑"路由）
 */

/** 单个 slug 段的字符集：字母或数字开头，仅含 a-z A-Z 0-9 . _ - */
export const SLUG_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

/** slug 总长上限（层级路径的各段共享这一预算） */
export const SLUG_MAX_LENGTH = 80

/** 层级深度上限 */
export const SLUG_MAX_DEPTH = 8

/** 会被前端路由吃掉、从而"建得出来却打不开"的保留首段 */
export const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(['search', 'ask', 'new', 'list'])

/** 第二段为该值时是"编辑"路由（`<slug>/edit`），不能作为页面路径的第二段 */
export const RESERVED_SECOND_SEGMENT = 'edit'

/**
 * 页面标识是否合法（与后端 `isValidSlug` **行为等价**，由对齐守卫钉住）。
 */
export function isValidSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) return false
  const segs = slug.split('/')
  if (segs.length > SLUG_MAX_DEPTH) return false
  for (const seg of segs) {
    if (!SLUG_SEGMENT_RE.test(seg)) return false
  }
  if (RESERVED_FIRST_SEGMENTS.has(segs[0] as string)) return false
  if (segs.length >= 2 && segs[1] === RESERVED_SECOND_SEGMENT) return false
  return true
}

/**
 * 校验失败时给用户看的一句话。与后端 `SLUG_HINT` 同义，但**更短**——
 * 表单里字段下方的位置只适合一行；完整规则放 {@link SLUG_HELP}。
 */
export const SLUG_HINT = '标识不合法：每段以字母或数字开头，仅含 a-z 0-9 . _ -；可用 / 分层，≤80 字符'

/** 字段下方的常态说明（无错误时显示），把"能用 / 分层"这件事讲清楚 */
export const SLUG_HELP = '可只用一段（getting-started），也可用 / 分层（guide/intro）；首段不能是 search/ask/new/list'

/**
 * 把非法标识的具体原因说清楚——比一句通用提示有用得多。
 *
 * 为什么要分类：`SLUG_HINT` 把五条规则挤在一行，用户得自己对照才知道错在哪。
 * 这里按"最先违反的那条"给出针对性说明，仍是纯函数、可单测。
 */
export function explainInvalidSlug(slug: string): string {
  if (slug.length === 0) return '页面标识不能为空'
  if (slug.length > SLUG_MAX_LENGTH) return `页面标识过长（${slug.length} 字符，上限 ${SLUG_MAX_LENGTH}）`
  const segs = slug.split('/')
  if (segs.length > SLUG_MAX_DEPTH) return `层级过深（${segs.length} 层，上限 ${SLUG_MAX_DEPTH} 层）`
  for (const seg of segs) {
    if (seg === '') return '路径里不能有空段（例如开头/结尾的 / 或连续的 //）'
  }
  for (const seg of segs) {
    if (!SLUG_SEGMENT_RE.test(seg)) {
      return `「${seg}」不合法：每段须以字母或数字开头，且仅含 a-z 0-9 . _ -`
    }
  }
  if (RESERVED_FIRST_SEGMENTS.has(segs[0] as string)) {
    return `「${segs[0]}」是保留字（前端路由占用），请换一个首段`
  }
  if (segs.length >= 2 && segs[1] === RESERVED_SECOND_SEGMENT) {
    return `第二段不能是「${RESERVED_SECOND_SEGMENT}」（那是编辑路由）`
  }
  return SLUG_HINT
}
