/**
 * 页面表单的**校验与脏值判定**（纯函数，可 `node:test` 单测）。
 *
 * 为什么从组件里抽出来：原来的 `WikiEdit` 把校验塞在 `save()` 里，错误统一扔到顶部
 * 一个 notice——用户看到"标题不能为空"却不知道是哪个字段（只有一个字段时才勉强能猜）。
 * 拆成"输入 → 逐字段错误"的纯映射后：
 * - 可以在**字段旁**就地显示错误（本批的目标）；
 * - 可以在保存前就把所有问题一次列全，而不是"改一个再报下一个"；
 * - 边界（超长 slug、以点开头、空白标题、非新建页不该校验 slug）都能用单测钉住。
 */

/** 页面标识（URL 路径段）允许的形态——**与后端 `SLUG_RE` 逐字一致**（单一事实来源在后端，此处是它的镜像） */
export const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

export const SLUG_HINT = '页面标识需以字母或数字开头，仅含 a-z 0-9 . _ -，≤80 字符'
export const TITLE_REQUIRED_HINT = '标题不能为空'

export interface PageFormInput {
  /** 新建态才允许编辑标识；编辑既有页面时标识不可改（改的是别的页面的 URL） */
  isNew: boolean
  slugInput: string
  title: string
}

export interface PageFormErrors {
  slug?: string
  title?: string
}

/**
 * 逐字段校验。返回空对象表示通过。
 *
 * 细节：`title` 用 `trim()` 后判空——全是空格的标题在列表里是"看不见的行"，
 * 与空标题一样不可接受（后端也会拒，但前端先拦住能少一次往返）。
 */
export function validatePageForm(input: PageFormInput): PageFormErrors {
  const errors: PageFormErrors = {}
  if (input.isNew && !SLUG_RE.test(input.slugInput.trim())) errors.slug = SLUG_HINT
  if (input.title.trim() === '') errors.title = TITLE_REQUIRED_HINT
  return errors
}

/** 是否存在任何字段级错误 */
export function hasErrors(errors: PageFormErrors): boolean {
  return errors.slug !== undefined || errors.title !== undefined
}

export interface PageDraft {
  title: string
  content: string
  /** 标识也是可编辑字段（仅新建态），故一并纳入脏值比较 */
  slugInput: string
}

/**
 * 是否有未保存改动。
 *
 * 注意**比较前不 trim**：用户只是多打了一个空格也算改动——若这里"贴心"地忽略空格，
 * 用户就会遇到"我明明改了，离开时却不提醒"的诡异行为。是否 trim 属于**保存时**的规范化。
 */
export function isDirty(original: PageDraft, current: PageDraft): boolean {
  return (
    original.title !== current.title ||
    original.content !== current.content ||
    original.slugInput !== current.slugInput
  )
}

/** 字符计数展示（正文用；`length` 对中文按字符算，符合用户直觉） */
export function charCount(text: string): number {
  return [...text].length
}
