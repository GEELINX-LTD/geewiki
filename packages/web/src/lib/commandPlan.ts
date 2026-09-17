/**
 * 命令面板的**纯逻辑**（无 DOM、无 React、可单测）。
 * ============================================================================
 *
 * 为什么把这些从组件里抽出来：命令面板真正容易写错的是**匹配与排序**——
 * "输入 `gz`，为什么 `guide/intro` 会排在 `配置说明` 前面"这类问题只能靠
 * 确定性打分解释，靠肉眼看界面调试不出来。抽成纯函数后，命中/不命中/大小写/
 * 中文/空查询/并列排序这些边界都能用单测钉死（见 test/commandPlan.test.ts）。
 *
 * 组件（`components/CommandPalette.tsx`）只负责：把数据接进来、把 `run` 挂上去、
 * 渲染与键盘/ARIA 接线。
 */
import { HOME_SLUG, isUnreachableSlug, parseWikiRoute } from './wikiRoute'

/** 分组 id（顺序即展示顺序的语义，具体顺序由 {@link buildPaletteGroups} 决定） */
export type PaletteGroupId = 'recent' | 'page' | 'action'

export const GROUP_LABEL: Record<PaletteGroupId, string> = {
  recent: '最近访问',
  page: '页面',
  action: '操作',
}

/**
 * 一条可被执行的项。
 *
 * **刻意不带 `run`**：纯模块不该持有副作用，动作由组件用 `id → run` 的映射挂载。
 * 这样同一份条目数据可以在测试里被反复构造、比对，而不会牵动 React。
 */
export interface PaletteEntry {
  id: string
  group: PaletteGroupId
  /** 主文案（页面的标题 / 动作名） */
  label: string
  /** 次文案（页面的 slug / 动作说明）；也参与匹配，但权重低于 label */
  hint?: string
  /** 额外的可搜索词（同义词等），不显示 */
  keywords?: string
}

export interface PaletteGroup {
  id: PaletteGroupId
  label: string
  items: PaletteEntry[]
}

/** 页面条目的 id 约定（纯模块与组件共用，避免两处各写一遍拼串） */
export function pageEntryId(slug: string): string {
  return `page:${slug}`
}

/** 每个分组最多展示多少条（避免长列表把面板撑到屏幕外） */
export const DEFAULT_LIMIT_PER_GROUP = 8

/** 最近访问最多记多少条（与 `recentSlugs` 的展示上限无关，这是存储上限） */
export const RECENT_LIMIT = 8

/** localStorage 键名。**必须与主题的 `geewiki-theme` 不同**（后者由 index.html 内联脚本共用） */
export const RECENT_STORAGE_KEY = 'geewiki-recent-pages'

/** 判断某个字符是否是"词/段边界"——边界上的命中更可能是用户想要的 */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true
  return ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '.' || ch === '（' || ch === '('
}

/**
 * 子序列模糊匹配打分。**不命中返回 `null`**（而不是 0——0 会被误当成"命中了但分数最低"）。
 *
 * 打分规则（全部是整数运算，避免浮点比较带来的不确定性）：
 * - 命中连续字符 `+8`（`gz` 匹配 `guide` 的 `g` 与 `z` 不连续，匹配 `g…z` 连续则更高）；
 * - 命中位于词/段首 `+12`（`gi` 更应命中 `guide/intro` 的段首）；
 * - 每跳过一个字符 `-1`；
 * - 整串包含查询串（子串命中）额外 `+50`——"我就是要找这个名字"应当压倒一切。
 *
 * 用 `for…of` 遍历查询串（按**码点**而非 UTF-16 码元），中文与 emoji 都不会被拆半。
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()

  let score = 0
  let cursor = 0
  let prevMatch = -2

  for (const ch of q) {
    const found = t.indexOf(ch, cursor)
    if (found === -1) return null
    if (found === prevMatch + 1) score += 8
    if (found === 0 || isBoundary(t[found - 1])) score += 12
    score -= found - cursor
    prevMatch = found
    cursor = found + 1
  }

  if (t.includes(q)) score += 50
  return score
}

/**
 * 对一条目打分：取 label / hint / keywords 中**最高**的一个，但 label 命中额外加权。
 *
 * 加权理由：`hint` 里含匹配串（例如 slug 命中）远不如标题命中重要，
 * 否则输入 `guide` 会让所有 `guide/*` 的子页压过标题就叫「Guide」的页面。
 */
const HINT_PENALTY = 10

export function scoreEntry(query: string, entry: PaletteEntry): number | null {
  const candidates: number[] = []
  const byLabel = fuzzyScore(query, entry.label)
  if (byLabel !== null) candidates.push(byLabel)
  if (entry.hint !== undefined && entry.hint !== '') {
    const s = fuzzyScore(query, entry.hint)
    if (s !== null) candidates.push(s - HINT_PENALTY)
  }
  if (entry.keywords !== undefined && entry.keywords !== '') {
    const s = fuzzyScore(query, entry.keywords)
    if (s !== null) candidates.push(s - HINT_PENALTY)
  }
  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

export interface BuildGroupsOptions {
  query: string
  /** 全部候选（页面 + 动作），顺序无关——排序由本函数决定 */
  entries: readonly PaletteEntry[]
  /** 最近访问的 slug（越靠前越新） */
  recentSlugs: readonly string[]
  limitPerGroup?: number
}

/**
 * 由「查询 + 候选 + 最近访问」算出**分组结果**。
 *
 * 两种模式，刻意不同：
 * - **空查询**：只给「最近访问 + 操作」，**不铺全量页面**——面板刚打开时把几百个页面
 *   倒出来既慢又无用；用户此时要么想继续上次的页面，要么想执行一个动作。
 * - **非空查询**：给「页面 + 操作」的匹配结果（最近访问不再单列——它本来就是页面，
 *   再列一遍会出现同一页面出现两次）。页面的 slug 已被"最近访问"覆盖的场景由打分处理。
 *
 * 「最近访问」里**已被删除的页面会被丢弃**（只在现存条目里解析），否则会出现点了打不开的死项。
 */
export function buildPaletteGroups(options: BuildGroupsOptions): PaletteGroup[] {
  const { query, entries, recentSlugs } = options
  const limit = options.limitPerGroup ?? DEFAULT_LIMIT_PER_GROUP
  const trimmed = query.trim()

  const pages = entries.filter((e) => e.group === 'page')
  const actions = entries.filter((e) => e.group === 'action')

  if (trimmed === '') {
    const byId = new Map(pages.map((p) => [p.id, p]))
    const recentItems: PaletteEntry[] = []
    const seen = new Set<string>()
    for (const slug of recentSlugs) {
      const id = pageEntryId(slug)
      const hit = byId.get(id)
      if (hit === undefined || seen.has(id)) continue
      seen.add(id)
      recentItems.push(hit)
      if (recentItems.length >= limit) break
    }

    const groups: PaletteGroup[] = []
    if (recentItems.length > 0) {
      groups.push({ id: 'recent', label: GROUP_LABEL.recent, items: recentItems })
    }
    if (actions.length > 0) {
      groups.push({ id: 'action', label: GROUP_LABEL.action, items: actions.slice(0, limit) })
    }
    return groups
  }

  const rank = (list: readonly PaletteEntry[]): PaletteEntry[] => {
    const scored: { entry: PaletteEntry; score: number }[] = []
    for (const entry of list) {
      const score = scoreEntry(trimmed, entry)
      if (score !== null) scored.push({ entry, score })
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        // 并列时用文案做稳定的次级排序：否则同一查询在不同渲染里可能给出不同顺序，
        // 而键盘导航依赖"顺序稳定"（上下键走的是索引）
        a.entry.label.localeCompare(b.entry.label, 'zh'),
    )
    return scored.slice(0, limit).map((s) => s.entry)
  }

  const groups: PaletteGroup[] = []
  const pageHits = rank(pages)
  if (pageHits.length > 0) groups.push({ id: 'page', label: GROUP_LABEL.page, items: pageHits })
  const actionHits = rank(actions)
  if (actionHits.length > 0) groups.push({ id: 'action', label: GROUP_LABEL.action, items: actionHits })
  return groups
}

/** 把分组拍平成一维——键盘导航是在这个一维序列上移动索引的 */
export function flattenGroups(groups: readonly PaletteGroup[]): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const g of groups) out.push(...g.items)
  return out
}

/**
 * 在一维列表里移动索引，**首尾环绕**。
 *
 * `current === -1`（尚未选中）时：向下从头开始、向上从尾开始——这是命令面板的惯例，
 * 让"打开后直接按上键"跳到末尾而不是原地不动。
 */
export function moveIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : total - 1
  return (current + delta + total) % total
}

/**
 * 从 `wiki/` 之后的子路径判断这是否是一次"页面访问"，是则返回 slug。
 *
 * 用 `parseWikiRoute` 而不是自己写一遍判断：保留段（`search`/`ask`/`new`/`list`）
 * 与 `/edit` 后缀的语义只该有一处定义，否则迟早与路由解析漂移
 * （`lib/wikiRoute.ts` 的注释记录了这类漂移已经造成过一次真缺陷）。
 *
 * **主页也算一次页面访问**（`kind === 'home'` ⇒ 约定 slug `home`）：它就是一篇文章，
 * 而且是默认落点 —— 不记的话，"最近访问"里永远不会出现用户最常到的那个页面。
 */
export function visitedSlugFromSub(sub: string): string | null {
  const route = parseWikiRoute(sub)
  if (route.kind === 'home') return HOME_SLUG
  if (route.kind !== 'detail') return null
  /*
   * 保留段开头的 slug 结构上不可能存在（后端拒建），不该进"最近访问"。
   * P8 拆掉 `#/wiki/ask/<q>` 之前这条走不到——那时 `ask` 有自己的 kind；
   * 现在它会落到 detail，于是判据必须显式挡一道，否则一次误点就会把一个
   * 永远打不开的 slug 写进最近访问，而且点它还会再写一次。
   */
  return isUnreachableSlug(route.slug) ? null : route.slug
}

/* ------------------------------- 最近访问 ------------------------------- */

/** localStorage 可能不可用（Node 测试环境、Safari 隐私模式）——一律容错为空 */
export function readRecents(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 逐项校验：localStorage 里可能是旧版本/被手改过的脏数据，
    // 一个非字符串元素会让 `.slice(0, limit)` 之后的下游全部炸掉
    return parsed.filter((x): x is string => typeof x === 'string' && x !== '')
  } catch {
    return []
  }
}

/** 纯函数：把 slug 插到最前、去重、截断。**返回新数组，不改入参** */
export function pushRecent(current: readonly string[], slug: string): string[] {
  if (slug === '') return [...current]
  return [slug, ...current.filter((s) => s !== slug)].slice(0, RECENT_LIMIT)
}

export function storeRecents(list: readonly string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 存不下就算了：本次会话内面板仍可用，只是刷新后没有"最近访问" */
  }
}

/** 记录一次页面访问（读 → 纯函数处理 → 写） */
export function recordRecentPage(slug: string): void {
  if (slug === '') return
  storeRecents(pushRecent(readRecents(), slug))
}
