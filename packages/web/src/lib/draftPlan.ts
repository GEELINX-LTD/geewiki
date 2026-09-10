/**
 * 编辑草稿（localStorage）的**纯逻辑**——不接触 DOM，可直接 `node:test` 单测。
 *
 * 要解决的现实问题：用户在编辑页写了半小时，误关标签页 / 刷新 / 浏览器崩溃 ⇒ 内容全丢。
 * 浏览器没有内建的"编辑器草稿"，必须自己做。
 *
 * 三个必须想清楚的点（都在这里以纯函数表达，故可测）：
 *
 * 1. **按 slug 隔离**：不同页面的草稿不能互相覆盖；新建页（slug 为空）用固定的哨兵键，
 *    因为它在保存前根本没有 slug。
 *
 * 2. **不能静默覆盖服务端更新的内容**：草稿里记录"它基于服务端哪个版本"
 *    （`baseUpdatedAt` = 当时拿到的 `updated_at`）。恢复时比对：
 *    - 服务端 `updated_at` 未变 ⇒ 草稿就是最新基础，安全恢复；
 *    - 已变 ⇒ **提示用户**"服务端已有更新的版本"，由用户决定（`restore-stale`）。
 *    这比"直接覆盖"或"直接丢弃"都更诚实：两者都可能毁掉用户的劳动。
 *
 * 3. **陈旧草稿要能自动清理**：否则 localStorage 会无限堆积（配额满后写入静默失败，
 *    反而让草稿功能悄悄失效）。
 */

/** 草稿在 localStorage 里的键前缀 */
export const DRAFT_KEY_PREFIX = 'geewiki:draft:'

/** 新建页面（尚无 slug）用的哨兵键——不可能与真实 slug 冲突（slug 不允许 `:`） */
export const NEW_PAGE_SENTINEL = '__new__'

/** 超过这个时长的草稿视为陈旧，读取时直接忽略（并清掉） */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 天

export interface DraftRecord {
  title: string
  content: string
  /** 写入时间（epoch ms），用于陈旧判定与"多久以前"的提示 */
  savedAt: number
  /** 草稿所基于的服务端 `updated_at`；新建页或未加载完成时为 null */
  baseUpdatedAt: string | null
}

/** 服务端当前状态（比对基准） */
export interface ServerSnapshot {
  title: string
  content: string
  updatedAt: string
}

export type DraftDecision =
  /** 没有草稿 */
  | 'none'
  /** 草稿与服务端内容完全一致（例如上次保存成功后残留）——丢掉即可 */
  | 'discard'
  /** 服务端自草稿以来未变：可安全恢复 */
  | 'restore'
  /** 服务端已更新：恢复会覆盖较新的内容，必须先问用户 */
  | 'restore-stale'

export function draftKey(slug: string): string {
  return DRAFT_KEY_PREFIX + (slug === '' ? NEW_PAGE_SENTINEL : slug)
}

export function serializeDraft(draft: DraftRecord): string {
  return JSON.stringify(draft)
}

/**
 * 解析草稿：**容错优先**。
 * 任何异常（JSON 坏、字段缺失、类型不对、version 变更）都返回 null 而不是抛错——
 * 草稿是"锦上添花"的功能，绝不能因为一条坏数据让编辑页打不开。
 */
export function parseDraft(raw: string | null | undefined): DraftRecord | null {
  if (raw === null || raw === undefined || raw === '') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['title'] !== 'string' || typeof v['content'] !== 'string') return null
  const savedAt = typeof v['savedAt'] === 'number' && Number.isFinite(v['savedAt']) ? v['savedAt'] : 0
  const base = v['baseUpdatedAt']
  return {
    title: v['title'],
    content: v['content'],
    savedAt,
    baseUpdatedAt: typeof base === 'string' ? base : null,
  }
}

/** 草稿是否已陈旧（超过 {@link DRAFT_MAX_AGE_MS}） */
export function isDraftExpired(draft: DraftRecord, now: number): boolean {
  // savedAt 为 0 表示"写入时间缺失"（旧格式/坏数据）：按陈旧处理，避免永久堆积
  if (draft.savedAt <= 0) return true
  return now - draft.savedAt > DRAFT_MAX_AGE_MS
}

/**
 * 决定进入编辑页时如何处理草稿（见文件头第 2 点）。
 *
 * 注意"内容完全相同"要在**服务端状态已知**时才判定；调用方若还没加载完页面，
 * 应传 `server: null`，此时一律 `'none'`（宁可稍后再问，也不要拿未知状态做判断）。
 */
export function decideDraftRestore(
  draft: DraftRecord | null,
  server: ServerSnapshot | null,
): DraftDecision {
  if (draft === null) return 'none'
  if (server === null) return 'none'
  if (draft.title === server.title && draft.content === server.content) return 'discard'
  if (draft.baseUpdatedAt !== null && draft.baseUpdatedAt === server.updatedAt) return 'restore'
  return 'restore-stale'
}

/** 人类可读的"多久以前"（用于"恢复 3 分钟前的草稿"这类提示；纯函数便于单测） */
export function formatDraftAge(savedAt: number, now: number): string {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return '未知时间'
  const ms = now - savedAt
  if (ms < 0) return '刚刚'
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  return `${day} 天前`
}
