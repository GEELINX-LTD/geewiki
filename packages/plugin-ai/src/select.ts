/**
 * 上下文选择与截断（**纯函数**）。
 *
 * 这一层要把三个预算常量真正消化掉（`maxSourcesInContext` / `perSourceChars` /
 * `totalContextChars`），并回答一个问题：**哪些命中真的进了上下文**。
 * 答案必须精确回传到响应的 `sources[].used` 与 `n` 上——否则前端会展示一批
 * "看起来被引用了、实际没进 prompt"的来源，用户按 [n] 去核对时对不上。
 *
 * 两条刻意的取舍：
 * 1. **放不下就整条丢弃，绝不做尾部裁切**。半句话会诱导模型顺着编下去，
 *    而"少一条来源"只是信息量略低。
 * 2. **`like` 模式下 score 全为 0**，排序必须保持检索服务给的顺序（updated_at DESC）。
 *    `Array.prototype.sort` 在现代 V8 是稳定的，故按 score 降序排序不会打乱它。
 */
import type { ContentView, SearchHit } from '@geewiki/search'
import type { AskSource } from './types.js'
import type { ContextSource } from './prompt.js'

export interface SelectionOptions {
  /** 最多几条进上下文 */
  maxSourcesInContext: number
  /** 单条正文的字符上限 */
  perSourceChars: number
  /** 全部资料正文的字符总预算 */
  totalContextChars: number
}

export interface Selection {
  /** 全部命中（含被丢弃者），已填好 `n` 与 `used`，顺序与展示顺序一致 */
  sources: readonly AskSource[]
  /** 真正进上下文的那批，`n` 从 1 连续 */
  selected: readonly ContextSource[]
  /** 被丢弃的 slug（观测/测试用，不进响应体） */
  dropped: readonly string[]
  /**
   * ★ P3a：本次命中里**被裁剪掉**（当前主体看不到）的块数合计（仅计数，不含内容）。
   *
   * **对匿名主体恒为 0** —— `search-service.contents()` 对匿名返回的 `gatedCount`
   * 本身就是 0（§4.5 第 3 条：匿名下 `> 0` 等于确认"存在你看不到的内容"）。
   * 已登录但权限不足的主体可据此得到一句"需要更高权限"的高层提示。
   */
  gatedTotal: number
}

/**
 * ★ P3a：把一页的**可见块**按整块累积到 `budget`，**绝不从块中间截断**。
 *
 * 为什么强调"块对齐"：`perSourceChars` 原先是对整页正文做 `slice`（尾部截断）。
 * 块级模型下若仍按字符切，就可能把**相邻但可见性不同**的块切进同一个片段 ——
 * 那正是设计文档 §4.5 第 2 条点名的、块级引入的**新泄漏面**。
 *
 * 本实现里可见性已在 SQL 层（`search-service.contents()` 的可见性谓词）裁完，
 * 返回的块**全部**是该主体可见的，故按整块累积即安全；仍然保留"不跨块截断"
 * 是为了让这条性质**不依赖上游是否裁干净** —— 上游一旦漏裁，这里也不会把它拼进上下文。
 *
 * 单块就超预算时退化为对该块截断：仍在同一可见性内，且比"这一页给出空上下文"好。
 */
function accumulateBlocks(view: ContentView, budget: number): string {
  const parts: string[] = []
  let used = 0
  for (const block of view.blocks) {
    const cost = parts.length === 0 ? block.text.length : block.text.length + 2 // 块间 '\n\n'
    if (used + cost > budget) break
    parts.push(block.text)
    used += cost
  }
  if (parts.length > 0) return parts.join('\n\n')
  const first = view.blocks[0]
  return first === undefined ? '' : first.text.slice(0, budget)
}

/**
 * 按预算挑选进上下文的资料。
 *
 * @param hits     检索命中（顺序即展示顺序）
 * @param contents slug → **可见块投影**（来自 `search-service.contents()`；查不到的键不出现）
 * @param opts     三个预算常量
 */
export function selectSources(
  hits: readonly SearchHit[],
  contents: ReadonlyMap<string, ContentView>,
  opts: SelectionOptions,
): Selection {
  // score 的可比范围很窄：FTS 路是 BM25 **取负**（不是归一化——值域无界，量级随语料规模
  // 与查询词变化），故**只在同一次查询的结果内部可比**。一次 search 调用只可能产出一个
  // mode，这里按 score 降序即可；跨查询 / 跨 mode 比大小是消费方不该做的事
  // （契约见 @geewiki/search 的 `SearchHit.score` 注释）。
  const ordered = [...hits].sort((a, b) => b.score - a.score)

  const sources: AskSource[] = []
  const selected: ContextSource[] = []
  const dropped: string[] = []
  let usedChars = 0
  let gatedTotal = 0

  for (const hit of ordered) {
    const view = contents.get(hit.slug)
    if (view !== undefined) gatedTotal += view.gatedCount
    // 页面在"检索命中"与"取正文"之间被删除（竞态）、或**该主体一个可见块都没有**：
    // 两者的表现一致（`contents()` 都不返回该 slug），都无法进上下文。
    const usable = view !== undefined && selected.length < opts.maxSourcesInContext
    const text = usable && view !== undefined ? accumulateBlocks(view, opts.perSourceChars) : ''
    const fits = usable && usedChars + text.length <= opts.totalContextChars

    if (!fits) {
      dropped.push(hit.slug)
      sources.push({ n: null, slug: hit.slug, title: hit.title, snippet: hit.snippet, score: hit.score, updated_at: hit.updated_at, used: false })
      continue
    }

    const n = selected.length + 1
    usedChars += text.length
    selected.push({ n, slug: hit.slug, title: hit.title, text })
    sources.push({ n, slug: hit.slug, title: hit.title, snippet: hit.snippet, score: hit.score, updated_at: hit.updated_at, used: true })
  }

  return { sources, selected, dropped, gatedTotal }
}
