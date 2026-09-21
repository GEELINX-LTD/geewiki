/**
 * 站内链接抽取（纯函数，无 IO）——反向链接（backlinks）的地基。
 *
 * 职责只有一个：**从 Markdown 正文里找出它指向了哪些站内页面**。
 * 存进 `page_links` 后即可反查"谁链接了本页"。
 *
 * ## 为什么必须跳过代码
 * 正文里的 ``` 围栏、缩进代码块、行内 `code` 里经常出现形如 `[x](y)` 或 `[[z]]` 的
 * **示例文本**（本仓库的文档就大量如此）。若把它们当成真实链接抽取，反向链接里会混进
 * 一堆并不存在的页面——这是本模块最容易做错的地方，故先做一遍"遮罩"再抽取。
 *
 * ## 支持的写法（其余一律忽略）
 * | 写法 | 说明 |
 * | --- | --- |
 * | `[文本](/wiki/<slug>)` | 前端站内路由形态（推荐） |
 * | `[文本](#/wiki/<slug>)` | hash 路由形态（同样接受） |
 * | `[文本](/<slug>)` | 以 `/` 开头的绝对路径 |
 * | `[文本](<slug>)` | 裸 slug |
 * | `[文本](<...>)` | CommonMark 的尖括号目标 |
 * | `[[slug]]` | wikilink |
 * | `[[slug\|显示文本]]` | wikilink 带显示文本 |
 *
 * ## 明确**不**算页面链接：图片（`![替文本](目标)`）
 * 图片的目标是**资源**，不是页面。最常见的形态恰恰就是附件 URL
 * `/api/attachments/<id>`（宿主推荐写法，见 `docs/design/attachments.md` §4.7；
 * `@geewiki/ai-assistant` 的 `imageMarkdown()` 插进正文的也是它）。
 * 若把图片当链接抽取，`/api/attachments/123` 会被归一化成 `api/attachments/123`——
 * 一个**形状完全合法**的 slug——于是页面上每张图都在"本页引用了"里变成一条红链
 * 加一个"新建该页"按钮。一本配图几百张的书会被刷屏。
 * 故 `MD_LINK_RE` 用 `(?<!!)` 排除 `!` 前缀。
 *
 * ## 归一化规则（`normalizeLinkTarget`）
 * 去首尾空白 → 去 `<>` → 丢弃纯锚点与绝对 URI → 去 `?查询`/`#锚点` →
 * 百分号解码（`%2F` → `/`）→ 去前导 `/` → 去**仅在带前导斜杠时**的 `wiki/` 前缀。
 *
 * ⚠️ 已知歧义（刻意取舍，见 `normalizeLinkTarget` 注释）：
 * `/wiki/foo` 与裸写 `wiki/foo` 解释不同——前者是"路由形态"指向 `foo`，
 * 后者是"页面 slug 就叫 wiki/foo"。这是唯一能同时支持两种写法的代价。
 */

/** 校验器由调用方注入：避免本模块 import `./index.js` 造成循环依赖，也便于单测换桩。 */
export type SlugValidator = (slug: unknown) => boolean

/** `[[slug]]` / `[[slug|显示文本]]`；不跨行、不允许嵌套方括号 */
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g

/**
 * `[文本](目标)`：只取 `](` 之后的目标部分。
 * - **`!` 前缀的图片不算**（`(?<!!)`）——图片目标是资源不是页面，理由见文件头；
 * - 允许目标两侧空白；
 * - 允许 CommonMark 的尖括号目标 `<...>`（可含空格，故单独一支）；
 * - 忽略可选的 `"标题"` —— 目标本身以 `[^)\s]+` 截断，标题自然被排除。
 *
 * `(?<!!)` 用零宽后顾而不捕获 `!`：捕获组序号一变，下面 `matchAll` 取 `m[1]` 的代码
 * 就会静默错位（拿到 `!` 或 `undefined`），那是比本缺陷更难查的故障。
 */
const MD_LINK_RE = /(?<!!)\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)/g

/**
 * 把代码区域替换为空格，返回等长（按行）的"遮罩文本"。
 *
 * 处理三类：围栏代码块（``` / ~~~，含未闭合时到文末）、缩进代码块（4 空格或 Tab，
 * **且前一行为空行或同为缩进块**——沿用 CommonMark 的"缩进代码不能打断段落"语义）、
 * 行内代码（按反引号串长度配对，未闭合则其后视作普通文本，与 CommonMark 一致）。
 */
export function maskCode(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: { char: string; len: number } | null = null
  // 文档开头视作"前一行为空"，故首行若缩进 4 格即为缩进代码块
  let prevBlank = true
  let prevIndented = false

  for (const line of lines) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line)

    if (fence !== null) {
      out.push(' '.repeat(line.length))
      // 闭合围栏：同种字符、长度不小于开启者
      if (fenceMark && fenceMark[1]?.[0] === fence.char && fenceMark[1].length >= fence.len) fence = null
      prevBlank = false
      prevIndented = false
      continue
    }
    if (fenceMark) {
      fence = { char: fenceMark[1]![0]!, len: fenceMark[1]!.length }
      out.push(' '.repeat(line.length))
      prevBlank = false
      prevIndented = false
      continue
    }

    const isIndented = /^(?: {4,}|\t)/.test(line)
    if (isIndented && (prevBlank || prevIndented)) {
      out.push(' '.repeat(line.length))
      prevBlank = false
      prevIndented = true
      continue
    }

    out.push(maskInlineCode(line))
    prevBlank = line.trim() === ''
    prevIndented = false
  }
  return out.join('\n')
}

/** 行内代码遮罩：按反引号串长度配对（`a` 与 ``a`` 不是一对） */
function maskInlineCode(line: string): string {
  const chars = [...line]
  const out = [...chars]
  let i = 0
  while (i < chars.length) {
    if (chars[i] !== '`') {
      i++
      continue
    }
    let openRun = 0
    while (i + openRun < chars.length && chars[i + openRun] === '`') openRun++

    // 找长度**恰好相等**的下一个反引号串
    let j = i + openRun
    let closeAt = -1
    while (j < chars.length) {
      if (chars[j] === '`') {
        let run = 0
        while (j + run < chars.length && chars[j + run] === '`') run++
        if (run === openRun) {
          closeAt = j
          break
        }
        j += run
        continue
      }
      j++
    }
    // 未闭合：CommonMark 亦把其后的反引号当普通文本，故到此为止
    if (closeAt === -1) break
    for (let k = i; k < closeAt + openRun; k++) out[k] = ' '
    i = closeAt + openRun
  }
  return out.join('')
}

/**
 * 归一化单个链接目标；返回 `null` 表示"不是站内页面链接"。
 *
 * 丢弃的情形：空、纯锚点（`#foo`）、绝对 URI（`http:` / `mailto:` 等）。
 * 保留的情形见文件头表格。
 */
export function normalizeLinkTarget(raw: string): string | null {
  let s = raw.trim()
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim()
  if (s === '') return null

  if (s.startsWith('#')) {
    // `#/wiki/<slug>` 是站内路由（hash 形态）；纯 `#锚点` 不是页面链接
    if (!s.startsWith('#/')) return null
    s = s.slice(1)
  }
  // 带协议前缀的一律不是站内链接（含 mailto:、tel:、http(s):）
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null

  // 先切查询与锚点，再解码：`%3F`/`%23` 属于 slug 字面量而非分隔符
  const cut = s.search(/[?#]/)
  if (cut >= 0) s = s.slice(0, cut)

  try {
    s = decodeURIComponent(s)
  } catch {
    // 非法百分号编码（如 `%zz`）：按原样处理，交给 isValidSlug 判定
  }

  const hadLeadingSlash = /^\//.test(s)
  s = s.replace(/^\/+/, '')
  // **仅当原本带前导斜杠**才剥 `wiki/`：这样 `/wiki/foo` → `foo`（路由形态），
  // 而裸写 `wiki/foo` 仍是合法 slug（页面就叫 wiki/foo）。二者无法同时区分，
  // 这是支持两种写法的唯一代价，已在文件头登记。
  if (hadLeadingSlash && s.startsWith('wiki/')) s = s.slice('wiki/'.length)
  s = s.replace(/^(?:\.\/)+/, '')
  s = s.replace(/^\/+/, '').trim()

  return s === '' ? null : s
}

/**
 * 从 Markdown 抽取站内链接目标。
 *
 * 返回**已归一化、已去重、保持首次出现顺序**的 slug 数组；
 * 非法 slug（由注入的 `isValid` 判定）一律丢弃。
 */
export function extractLinkTargets(markdown: string, isValid: SlugValidator): string[] {
  const masked = maskCode(markdown)
  const candidates: string[] = []

  for (const m of masked.matchAll(WIKILINK_RE)) {
    // `[[slug|显示文本]]`：`|` 之后是显示文本
    const body = m[1] ?? ''
    const bar = body.indexOf('|')
    candidates.push(bar >= 0 ? body.slice(0, bar) : body)
  }
  for (const m of masked.matchAll(MD_LINK_RE)) {
    candidates.push(m[1] ?? '')
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    const slug = normalizeLinkTarget(raw)
    if (slug === null || !isValid(slug)) continue
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out
}
