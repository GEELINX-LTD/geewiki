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
import type { SearchHit } from '@geewiki/search'
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
}

/**
 * 按预算挑选进上下文的资料。
 *
 * @param hits     检索命中（顺序即展示顺序）
 * @param contents slug → 整页正文（来自 `search-service.contents()`；查不到的键不出现）
 * @param opts     三个预算常量
 */
export function selectSources(
  hits: readonly SearchHit[],
  contents: ReadonlyMap<string, string>,
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

  for (const hit of ordered) {
    const raw = contents.get(hit.slug)
    // 页面在"检索命中"与"取正文"之间被删除（竞态）：无法进上下文。
    // 注意区分"页面不存在"（undefined）与"页面正文为空串"——后者仍可只靠标题入上下文。
    const usable = raw !== undefined && selected.length < opts.maxSourcesInContext
    const text = usable ? raw.slice(0, opts.perSourceChars) : ''
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

  return { sources, selected, dropped }
}
