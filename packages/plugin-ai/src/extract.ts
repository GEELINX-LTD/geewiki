/**
 * 零成本抽取式摘要（**纯函数**）——"没有 API key 时也完整可用"的产品承诺就落在这里。
 *
 * 目标不是"像模型一样回答"，而是**用零成本的方式解释"为什么这几条被检索到"**：
 * 因此窗口取"首个命中词附近"而不是正文开头——后者在长文档里经常是目录/标题，
 * 看完仍然不知道这条为什么相关。
 *
 * 刻意**不加 `[n]` 标记**：`[n]` 是引用语法，留给真正的模型回答；摘要里出现同形标记
 * 会让用户以为可以按编号核对，而摘要本身并不保证与 sources 的编号一一对应。
 */

/** 单条窗口的两侧字符数 */
export const EXTRACT_RADIUS = 80
/** 摘要最多取几条来源 */
export const EXTRACT_MAX_SOURCES = 3
/** 摘要总长度上限（字符） */
export const EXTRACT_MAX_CHARS = 300

export interface ExtractInput {
  slug: string
  title: string
  /** 整页正文（未截断）——命中词可能落在 perSourceChars 之外，故用原文定位 */
  text: string
}

/** 折叠空白：换行与连续空格会让摘要显得很长且难读 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 取"首个命中词附近"的窗口；命中词不在正文里（例如只命中标题）时退回正文开头。
 * 两侧被截断时补省略号，让读者知道这不是完整段落。
 */
function windowOf(text: string, query: string): string {
  const flat = collapse(text)
  if (flat === '') return ''
  const idx = query === '' ? -1 : flat.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) {
    const head = flat.slice(0, EXTRACT_RADIUS * 2)
    return head === flat ? head : `${head}…`
  }
  const start = Math.max(0, idx - EXTRACT_RADIUS)
  const end = Math.min(flat.length, idx + query.length + EXTRACT_RADIUS)
  const lead = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return `${lead}${flat.slice(start, end)}${tail}`
}

/**
 * 生成抽取式摘要。只吃"已进上下文"的来源（由调用方筛好），拼成 ≤{@link EXTRACT_MAX_CHARS} 字的纯文本。
 *
 * 空输入返回空串（调用方据此把 `answer` 置为 null——"没有任何命中"与"有命中但摘要为空"
 * 是两种不同状态，前者应显式表达为 null）。
 */
export function extractiveSummary(query: string, sources: readonly ExtractInput[]): string {
  const parts: string[] = []
  let total = 0
  for (const s of sources.slice(0, EXTRACT_MAX_SOURCES)) {
    const win = windowOf(s.text, query)
    // 正文为空时退化为标题（至少让用户知道命中了什么）
    const piece = win === '' ? collapse(s.title) : `${collapse(s.title)}：${win}`
    if (piece === '') continue
    // 预留连接符的长度，避免拼完再截断
    const joiner = parts.length === 0 ? '' : ' … '
    if (total + joiner.length + piece.length > EXTRACT_MAX_CHARS) {
      const room = EXTRACT_MAX_CHARS - total - joiner.length
      // 单条就超预算：截断这一条并收尾（摘要不是上下文，允许截断）
      if (room > 1) {
        parts.push(`${piece.slice(0, room - 1)}…`)
        total = EXTRACT_MAX_CHARS
      }
      break
    }
    parts.push(piece)
    total += joiner.length + piece.length
  }
  return parts.join(' … ')
}
