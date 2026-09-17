/**
 * 实时渲染的**块级渲染判定**（纯逻辑：无 React、无 DOM、无 CodeMirror）。
 * ============================================================================
 *
 * ## 它解决的问题
 *
 * 实时渲染原先只藏**行内**标记（`#`/`**`/`[]()`），表格、多行代码块、原始 HTML 一律
 * 按源码显示 —— 作者的反馈是「部分无法渲染」（`#/wiki/home/edit`，本批）。现在这几类
 * 整块**换成渲染后的样子**（见 `components/editor/liveRender.ts` 的块装饰），
 * 本模块负责其中**可以脱离 DOM 与语法树单独判定**的那部分规则：
 * 哪些节点整块渲染、块的字符范围怎么对齐、哪些标记该被换掉。
 *
 * ## 为什么单独成模块（而不是全写在 liveRender.ts 里）
 *
 * `liveRender.ts` 依赖 CodeMirror 的视图层与 `document`，在 Node 里跑不起来；
 * 而"范围对齐对不对、`-` 该换成什么、反引号该不该藏"这类**判据**恰恰最容易写错，
 * 也最需要一个**能跑的**测试（`test/liveRenderPlan.test.ts`）。故按本仓既有约定
 * （`*Plan.ts` 放纯逻辑 + 同名单测）把判据抽出来，组件只负责把它接到装饰上。
 *
 * ## 一条硬约束（写错就直接抛异常，不是"显示不好看"）
 *
 * 块装饰的替换范围**必须与行边界对齐**，且**不能跨行**：CodeMirror 对
 * "范围跨行"的替换装饰会抛 `RangeError`（插件路径下更严：连块装饰都不许有）。
 * 故 `alignToLines()` 是块渲染的**唯一入口**，它要么给出一个整行范围，要么给 `null`
 * —— 绝不返回一个"差不多"的范围让调用方自己去试。
 */

/**
 * 语法树节点名 → 块级渲染类别。
 *
 * 名字取自 `@codemirror/lang-markdown`（GFM）的语法树，都是**实测得到**的节点名，
 * 不是猜的（`node --import tsx` 直接打印过：`Table` / `FencedCode` / `CodeBlock` /
 * `HTMLBlock` / `HorizontalRule`）。未列出的名字**不做**块级渲染。
 *
 * 刻意**不含** `HTMLTag`：段落**内部**的行内 HTML 标签是分开的节点，把它们逐个换成
 * widget 会连标签之间的内容一起丢掉（`<span class="x">文</span>` 的语义在"两个空 widget"
 * 里根本表达不出来），那是比"露出标签"更坏的失真。行内 HTML 保持源码显示，
 * 整块的 HTML（`HTMLBlock`）才渲染。
 */
export const LIVE_BLOCK_NODES: Readonly<Record<string, LiveBlockKind>> = {
  Table: 'table',
  FencedCode: 'code',
  CodeBlock: 'code',
  HTMLBlock: 'html',
  HorizontalRule: 'rule',
}

export type LiveBlockKind = 'table' | 'code' | 'html' | 'rule'

/** 节点名 → 渲染类别；不是可整块渲染的节点则 `null` */
export function liveBlockKindOf(nodeName: string): LiveBlockKind | null {
  return LIVE_BLOCK_NODES[nodeName] ?? null
}

/**
 * 每一行的起始偏移。
 *
 * 与 `lib/editorBlocks.ts` 的 `splitLines()` 用**同一套换行约定**（`\n` / `\r\n` / `\r`
 * 都算一次换行，末尾换行产生一个空行）：两处若不一致，块装饰就会与 gated 区段的
 * 行判定错位一格。CodeMirror 的文档内部只有 `\n`，但本函数被单测直接喂字符串，
 * 故 `\r` 一并处理。
 */
export function lineStarts(text: string): number[] {
  const out: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      out.push(i + 1)
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        out.push(i + 2)
        i++
      } else {
        out.push(i + 1)
      }
    }
  }
  return out
}

/** 最后一个 `<= pos` 的行起始下标（`lineStarts` 必须非空） */
function lineIndexFor(starts: readonly number[], pos: number): number {
  let idx = 0
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    if (start === undefined) break
    if (start > pos) break
    idx = i
  }
  return idx
}

/** 某偏移所在行的**行尾**（不含换行符）：即下一个 `\n` 的位置（`\r\n` 时扣掉 `\r`）或文末 */
export function lineEndAt(text: string, pos: number): number {
  const starts = lineStarts(text)
  const start = starts[lineIndexFor(starts, pos)] ?? 0
  const nl = text.indexOf('\n', start)
  if (nl === -1) return text.length
  return nl > start && text[nl - 1] === '\r' ? nl - 1 : nl
}

/**
 * 把一个字符范围扩到**整行**（块装饰的前置条件，见文件头）。
 *
 * 返回 `null` 的情形都是"这个范围不能拿来当块装饰"：
 * - 越界 / 非整数 / `from > to`；
 * - 扩完是**空行**（`from === to`）—— 空范围没有可替换的内容，CodeMirror 会当成
 *   零宽块，视觉上凭空多出一块高度；
 * - `from > to` 这种反向范围。
 *
 * **不返回"就近的合法范围"**：要么整行，要么不渲染。块装饰一旦与行边界错开，
 * 后果是"明明只是画个表格，却把相邻的正文吃掉半行"。
 */
export function alignToLines(text: string, from: number, to: number): { from: number; to: number } | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < from || to > text.length) return null
  const starts = lineStarts(text)
  const start = starts[lineIndexFor(starts, from)]
  if (start === undefined || start > from) return null
  const end = lineEndAt(text, to)
  if (end <= start) return null
  return { from: start, to: end }
}

/**
 * 节点的范围是否**正好占满整行**。
 *
 * 用在 `HorizontalRule` 上：`---` 是分隔线，但 `> ---` 只是引用里的一行 ——
 * 后者被整块换掉会把引用符号一起吃掉（变成一段孤立的 `<hr>`），故只在前者渲染。
 */
export function isWholeLine(text: string, from: number, to: number): boolean {
  const span = alignToLines(text, from, to)
  return span !== null && span.from === from && span.to === to
}

/**
 * 无序列表标记 → 项目符号。
 *
 * **有序列表刻意返回 `null`**：`1.` / `2.` 就是渲染后的样子（阅读页显示的就是数字），
 * 换成别的字形反而是失真。只有无序列表的 `-` / `*` / `+` 在成品里是「•」。
 */
export function bulletForListMark(mark: string): string | null {
  return mark === '-' || mark === '*' || mark === '+' ? '•' : null
}

/**
 * 任务列表标记 → 复选框字形。
 *
 * `[ ]` → `☐`、`[x]` / `[X]` → `☑`；认不出来（语法树给了别的东西）返回 `null`，
 * 调用方保持原样 —— 不认识就**不动**，不猜。
 */
export function taskGlyph(marker: string): string | null {
  const m = marker.trim()
  if (m === '[ ]') return '☐'
  if (m === '[x]' || m === '[X]') return '☑'
  return null
}

/**
 * 反引号要不要藏。
 *
 * **只有行内代码的**（父节点是 `InlineCode`）。围栏代码块的 ``` 属于代码块自身：
 * 它整块由块装饰渲染，这里若一并藏掉，源码模式与"光标进入该块"时就会出现
 * "有代码内容、没有围栏"的假象。
 */
export function hideInlineCodeMark(parentName: string | null | undefined): boolean {
  return parentName === 'InlineCode'
}

/** 两个半开区间是否相交（块装饰的"已覆盖"判定） */
export function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo
}
