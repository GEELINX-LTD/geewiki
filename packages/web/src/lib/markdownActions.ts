/**
 * 工具栏动作的**纯实现**：`(正文, 选区) → (新正文, 新选区)`，不碰 CodeMirror、不碰 DOM。
 * ============================================================================
 *
 * ## 为什么是纯函数
 *
 * 同一套动作有**两条**落地路径：
 * 1. 正常路径 —— CodeMirror 编辑器（`components/editor/markdownCommands.ts` 把它转成事务）；
 * 2. 降级路径 —— 懒加载 chunk 取不到时的 `<textarea>` 兜底（`MarkdownEditorLazy.tsx`）。
 *
 * 若把逻辑写进 CodeMirror 命令里，降级态就只能**没有工具栏**（"打不开 chunk 就没有加粗"），
 * 或者再抄一份（两份必然漂移）。纯函数让两条路径共用同一份行为，也让这些边界情形
 * 可以用 `node:test` 钉住：空选区、跨行选区、已经加粗过、列表加序号、围栏里不切…
 *
 * ## 一个刻意的限制
 *
 * 动作只作用于**主选区**。多光标下 CodeMirror 的 `changeByRange` 能给每个选区各自算一次，
 * 但那要求把逻辑写回 CM 侧（正是上面说的重复），而工具栏按钮是**鼠标/键盘明确指向一处**的
 * 交互。故：多光标时其余光标会被合并，这是已知且写在帮助文案里的行为。
 */

/** 工具栏动作的取值域 */
export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'codeblock'
  | 'table'
  | 'hr'

export interface EditTarget {
  text: string
  /** 选区起点（== 终点即光标态） */
  from: number
  to: number
}

export interface EditResult {
  text: string
  /** 动作完成后的选区（给用户"接着打字"的落点） */
  from: number
  to: number
}

/** 行内包裹类动作的标记 */
const WRAP_MARKS: Partial<Record<FormatAction, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
}

/** 行前缀类动作的写法（`ordered` 的序号在下面单独生成） */
const LINE_PREFIX: Partial<Record<FormatAction, string>> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  quote: '> ',
  bullet: '- ',
  task: '- [ ] ',
}

/**
 * "这一行已经是该结构了吗"的判据（toggle 的另一半）。
 *
 * ⚠️ **不能**用 `line.startsWith(prefix)` 近似：
 * - `'## 标题'.startsWith('# ')` 是 false，但 `'## 标题'.startsWith('#')` 是 true —— 用后者会把
 *   "给 h2 套 h1"误判成"取消 h1"，点一下反而把标题变成正文；
 * - `'- [ ] 待办'.startsWith('-')` 是 true —— 用后者会把任务列表误判成普通列表。
 * 故每个动作一个正则，各认各的写法（`bullet` 还要排除任务列表）。
 */
const LINE_DETECT: Partial<Record<FormatAction, RegExp>> = {
  h1: /^#{1}\s/,
  h2: /^#{2}\s/,
  h3: /^#{3}\s/,
  quote: /^>\s?/,
  bullet: /^[-*+]\s+(?!\[[ xX]\])/,
  task: /^[-*+]\s+\[[ xX]\]\s+/,
  ordered: /^\d+[.)]\s+/,
}

/** 各类行前缀的识别正则（用于 toggle：先剥掉旧的，再决定加不加） */
const STRIP_RES: readonly RegExp[] = [
  /^#{1,6}\s+/,
  /^>\s?/,
  /^[-*+]\s+\[[ xX]\]\s+/,
  /^[-*+]\s+/,
  /^\d+[.)]\s+/,
]

/** 剥掉行首的 Markdown 结构标记，保留缩进 */
function stripLinePrefix(line: string): { indent: string; rest: string } {
  const m = /^(\s*)(.*)$/.exec(line)
  const indent = m?.[1] ?? ''
  let rest = m?.[2] ?? ''
  // 反复剥：`> - [ ] x` 这类叠加写法要一次清干净，否则切换类型会留下残渣
  for (let i = 0; i < 4; i++) {
    let hit = false
    for (const re of STRIP_RES) {
      const mm = re.exec(rest)
      if (mm !== null && mm[0] !== '') {
        rest = rest.slice(mm[0].length)
        hit = true
        break
      }
    }
    if (!hit) break
  }
  return { indent, rest }
}

/** 选中行范围（含首尾整行） */
function lineRange(text: string, from: number, to: number): { start: number; end: number } {
  /*
   * `from === 0` 不能走 `lastIndexOf('\n', from - 1)`：文首的换行会被当成"上一行的结尾"，
   * 于是 start(=1) 落到 end(=0) **后面**，切片为空、正文被复制一遍
   * （'\nabc' 上点 h1 得到 '\n# \nabc'）。起点在文首时行首就是 0。
   */
  const start = from === 0 ? 0 : text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const nl = text.indexOf('\n', to)
  return { start, end: nl === -1 ? text.length : nl }
}

/** 行内包裹（加粗/斜体/删除线/行内代码）：再按一次取消 */
function toggleWrap(target: EditTarget, mark: string): EditResult {
  const { text, from, to } = target
  const len = mark.length
  const before = text.slice(Math.max(0, from - len), from)
  const after = text.slice(to, Math.min(text.length, to + len))

  if (before === mark && after === mark) {
    /*
     * 选区外已有标记 ⇒ 取消。**光标态也走这条**：光标夹在 `**|**` 中间时，
     * `detectActiveFormats` 报的是"已加粗"（按钮 aria-pressed=true），若这里还插入新标记，
     * 按钮就成了"显示已加粗、点下去变八个星号"，而"点两下取消"是工具栏最基本的预期。
     */
    return { text: text.slice(0, from - len) + text.slice(from, to) + text.slice(to + len), from: from - len, to: to - len }
  }

  if (from !== to) {
    const sel = text.slice(from, to)
    // 选中的文本自身已带标记 ⇒ 去掉
    if (sel.length >= len * 2 && sel.startsWith(mark) && sel.endsWith(mark)) {
      const inner = sel.slice(len, -len)
      return { text: text.slice(0, from) + inner + text.slice(to), from, to: from + inner.length }
    }
    return { text: text.slice(0, from) + mark + sel + mark + text.slice(to), from: from + len, to: to + len }
  }

  // 光标态：插入一对标记并把光标放在中间，直接打字即为该样式
  const insert = mark + mark
  return {
    text: text.slice(0, from) + insert + text.slice(to),
    from: from + len,
    to: from + len,
  }
}

/** 行前缀动作（标题/引用/列表/任务列表）：再按一次取消 */
function toggleLinePrefix(target: EditTarget, action: FormatAction): EditResult {
  const { text } = target
  const { start, end } = lineRange(text, target.from, target.to)
  const lines = text.slice(start, end).split('\n')
  const prefix = LINE_PREFIX[action] ?? ''

  if (action === 'ordered') {
    // 有序列表：给每行重新编号（1. 2. 3.）——复制粘贴来的段落常带着重复的 "1."
    const already = lines.every((l) => (LINE_DETECT.ordered ?? /$^/).test(l.trimStart()))
    const next = lines.map((line, i) => {
      const { indent, rest } = stripLinePrefix(line)
      return already ? indent + rest : `${indent}${i + 1}. ${rest}`
    })
    const joined = next.join('\n')
    return { text: text.slice(0, start) + joined + text.slice(end), from: start, to: start + joined.length }
  }

  const detect = LINE_DETECT[action] ?? /$^/
  // toggle：**所有**行都已经是这个结构 ⇒ 去掉（只取消其中一部分会让"再按一次"变得不可预期）
  const already = lines.every((l) => detect.test(l.trimStart()))
  const next = lines.map((line) => {
    const { indent, rest } = stripLinePrefix(line)
    return already ? indent + rest : `${indent}${prefix}${rest}`
  })
  const joined = next.join('\n')
  return { text: text.slice(0, start) + joined + text.slice(end), from: start, to: start + joined.length }
}

/**
 * 独立块的**前后补白**：`lead`/`tail` 是要补的换行。
 *
 * 紧贴着段落的 `| a | b |` 不会被解析成表格（CommonMark 要求表格前有空行边界），
 * 而"点一下表格却出来一段普通文本"是最典型的"按钮坏了"体验。
 */
function blockPadding(before: string, after: string): { lead: string; tail: string } {
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const tail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  return { lead, tail }
}

/** 链接：选中文本 ⇒ `[文本](url)`；选中本身就是 URL ⇒ `[链接文字](url)`；光标态 ⇒ 空链接 */
function makeLink(target: EditTarget): EditResult {
  const { text, from, to } = target
  const sel = text.slice(from, to)
  if (/^https?:\/\/\S+$/i.test(sel.trim())) {
    const url = sel.trim()
    const insert = `[链接文字](${url})`
    const urlStart = from + '[链接文字]('.length
    return { text: text.slice(0, from) + insert + text.slice(to), from: urlStart, to: urlStart + url.length }
  }
  const label = sel === '' ? '链接文字' : sel
  const insert = `[${label}](https://)`
  const urlStart = from + 1 + label.length + 2
  return { text: text.slice(0, from) + insert + text.slice(to), from: urlStart, to: urlStart + 'https://'.length }
}

/** 执行一个工具栏动作。返回新的正文与选区；不改变文档时也返回原值（调用方比对文本） */
export function applyFormatAction(target: EditTarget, action: FormatAction): EditResult {
  const wrapMark = WRAP_MARKS[action]
  if (wrapMark !== undefined) return toggleWrap(target, wrapMark)
  if (action === 'link') return makeLink(target)
  if (action === 'h1' || action === 'h2' || action === 'h3' || action === 'quote' || action === 'bullet' || action === 'ordered' || action === 'task') {
    return toggleLinePrefix(target, action)
  }
  if (action === 'codeblock') {
    const { text, from, to } = target
    const before = text.slice(0, from)
    const after = text.slice(to)
    const { lead, tail } = blockPadding(before, after)
    const sel = text.slice(from, to)
    const block = `\`\`\`\n${sel}\n\`\`\``
    const insert = lead + block + tail
    const cursor = from + lead.length + 4 // '```\n' 之后即为代码内容
    return {
      text: before + insert + after,
      from: sel === '' ? cursor : from + lead.length,
      to: sel === '' ? cursor : from + lead.length + block.length,
    }
  }
  if (action === 'table') {
    const before = target.text.slice(0, target.from)
    const after = target.text.slice(target.to)
    const { lead, tail } = blockPadding(before, after)
    const block = ['| 列一 | 列二 | 列三 |', '| --- | --- | --- |', '|  |  |  |'].join('\n')
    const cursor = target.from + lead.length + block.length
    return { text: before + lead + block + tail + after, from: cursor, to: cursor }
  }
  if (action === 'hr') {
    const before = target.text.slice(0, target.from)
    const after = target.text.slice(target.to)
    const { lead, tail } = blockPadding(before, after)
    const block = '---'
    const cursor = target.from + lead.length + block.length
    return { text: before + lead + block + tail + after, from: cursor, to: cursor }
  }
  return { text: target.text, from: target.from, to: target.to }
}

/**
 * 判断当前选区/光标处**已经处于**哪些结构。
 *
 * 用途：工具栏按钮的 `aria-pressed`。这不是装饰 —— 一个"看起来能点但点下去是把加粗**取消**"
 * 的按钮，在非 Markdown 用户手里就是"按钮把我的字弄乱了"。让它如实反映状态，
 * 用户才敢点第二次。
 *
 * 判定口径（与 `applyFormatAction` 的 toggle 判据**共用同一批正则**，不能各写一份）：
 * - 行级：选中的**所有行**都满足该结构才算（只满足一半时按"未处于"呈现 —— 点一下会套上，
 *   与动作的 `every` 语义一致）；
 * - 行内：选区整体被标记包住（或光标紧邻标记两侧）。
 */
export function detectActiveFormats(target: EditTarget): Set<FormatAction> {
  const { text, from, to } = target
  const out = new Set<FormatAction>()
  const { start, end } = lineRange(text, from, to)
  const lines = text
    .slice(start, end)
    .split('\n')
    .filter((l) => l.trim() !== '')
  if (lines.length > 0) {
    const all = (re: RegExp): boolean => lines.every((l) => re.test(l.trimStart()))
    if (all(/^#\s/)) out.add('h1')
    else if (all(/^##\s/)) out.add('h2')
    else if (all(/^###\s/)) out.add('h3')
    if (all(/^>\s?/)) out.add('quote')
    if (all(/^\d+[.)]\s+/)) out.add('ordered')
    if (all(/^[-*+]\s+\[[ xX]\]\s+/)) out.add('task')
    else if (all(/^[-*+]\s+/)) out.add('bullet')
  }

  const sel = text.slice(from, to)
  const wrapped = (mark: string): boolean => {
    if (from !== to) {
      if (text.slice(Math.max(0, from - mark.length), from) === mark && text.slice(to, to + mark.length) === mark) {
        return true
      }
      return sel.length >= mark.length * 2 && sel.startsWith(mark) && sel.endsWith(mark)
    }
    return text.slice(Math.max(0, from - mark.length), from) === mark && text.slice(to, to + mark.length) === mark
  }
  if (wrapped('**')) out.add('bold')
  // 斜体判据要在加粗之后：`**x**` 也满足 `*x*` 的两侧紧邻判据，否则会把粗体读成"粗体+斜体"
  else if (wrapped('*')) out.add('italic')
  if (wrapped('~~')) out.add('strike')
  if (wrapped('`')) out.add('code')
  return out
}

/**
 * 把"整篇替换"收缩成**一处最小改动**。
 *
 * 为什么需要：CodeMirror 的事务如果是"整篇替换"，就会重新解析整篇文档、撤销栈里也是一大块，
 * 而且选区/滚动位置会跳动。裁剪公共前后缀后，一次加粗只改 `**` 那两处（两个字符），
 * 事务、撤销、重解析都回到应有的大小。
 *
 * 返回 `null` = 文本没变（调用方据此"什么都不做"，不要发空事务）。
 */
export function minimalEdit(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null
  let p = 0
  const max = Math.min(before.length, after.length)
  while (p < max && before[p] === after[p]) p++
  let s = 0
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  return { from: p, to: before.length - s, insert: after.slice(p, after.length - s) }
}
