/**
 * **实时渲染模式**的 CodeMirror 扩展（Typora 式**就地渲染**）。
 * ============================================================================
 *
 * ## 它做什么
 *
 * 光标所在的块**保持 Markdown 源码**（要编辑就得看得见标记），**其它块按渲染后的样子显示**：
 * 隐藏 `#`/`**`/`[]()`/反引号等标记、渲染图片、把受限区段画成带锁的区段，
 * 并把**表格 / 多行代码块 / 整块原始 HTML / 分隔线**换成一个**渲染块**（点击即回到源码）。
 *
 * ## 为什么是"就地"而不是分屏预览
 *
 * 分屏把屏幕切成两半：写的地方窄、看的地方也窄，而且**两边要来回找同一段**。
 * 就地渲染只有一份正文、一个撤销栈、一套附件上传与 AI 选区通道（分屏的预览是另一份
 * 渲染结果，改起来只能回到左边）。这也是作者要的形态（"Typora 那样"）。
 *
 * ## 边界（诚实说明，界面上也写了）
 *
 * - 能渲染的：**行内标记与图片**，以及 `表格 / 围栏与缩进代码块 / 整块 HTML / 分隔线`；
 * - **不**渲染的：段落**内部**的行内 HTML 标签（`<span class="x">文</span>` 这类）。
 *   它们被逐个换成 widget 会连标签之间的内容一起丢掉，比"露出标签"更失真 ——
 *   故只渲染 `HTMLBlock`（整块 HTML），行内标签保持源码；
 * - 渲染块是**投影**：它按阅读页同一套管线（`mdToHtml` = marked + DOMPurify）画出来，
 *   但**不接受编辑** —— 点它即把光标放进源码，改完再点别处，它自己会重新画。
 *
 * ## 四条实现约束
 *
 * 1. **只对非活动块做替换**：活动块里隐藏标记会让光标"看不见自己插进去的字符"
 *    ——用户敲了 `**`，屏幕上却没变化，这是最让人慌乱的一类编辑体验。
 * 2. **装饰不是内容**：所有隐藏/替换都是 `Decoration`，**不改文档**。因此撤销栈、
 *    块身份（服务端 `contentHash`）、保存内容都不会因为切换模式而变化。
 * 3. **解析不确定时少做**：正文里的 gated 标记不合法（服务端会 400）时**不做任何装饰** ——
 *    那时的区间不可信，藏错地方的正文比不藏坏得多。作者此刻该看到的是标记报错。
 * 4. **必须是 `StateField`，不能是 `ViewPlugin`**（本批踩过的那条硬约束）：
 *    CodeMirror 只允许**静态**装饰带块效果，插件路径上连 `block: true` 都不许用
 *    （`@codemirror/view` 的 `emit()`：`if (disallowBlockEffectsFor[index]) throw new
 *    RangeError("Block decorations may not be specified via plugins")`；判据是
 *    `typeof d === "function"`）。`StateField` + `EditorView.decorations.from(field)`
 *    给 facet 的是一个**值**，故合法。**不要把这里改回 `ViewPlugin.fromClass`** ——
 *    改了会在渲染表格时直接抛异常，而不是"渲染不出来"。
 */
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import {
  blockAtOffset,
  parseSourceDoc,
  regionOfBlock,
  type GatedMarker,
  type SourceBlock,
  type SourceDoc,
} from '../../lib/editorBlocks'
import {
  alignToLines,
  bulletForListMark,
  hideInlineCodeMark,
  isWholeLine,
  liveBlockKindOf,
  overlaps,
  taskGlyph,
  type LiveBlockKind,
} from '../../lib/liveRenderPlan'
import { mdToHtml } from '../../lib/sanitize'

/** 需要抹掉字面量的标记节点（标记是语法，不是内容） */
const HIDDEN_MARKS = new Set([
  'HeaderMark', // # / ##
  'EmphasisMark', // * / _ / **
  'StrikethroughMark', // ~~
  'QuoteMark', // >
])

/** 行级结构 → 行装饰类名（底色/左边框等交给样式表） */
function blockLineClass(kind: SourceBlock['kind']): string | null {
  if (kind === 'code') return 'gw-live-code-line'
  if (kind === 'quote') return 'gw-live-quote-line'
  if (kind === 'table') return 'gw-live-table-line'
  if (kind === 'html') return 'gw-live-html-line'
  return null
}

/** 图片：把 `![alt](url)` 换成真的 `<img>` */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  override toDOM(): HTMLElement {
    const figure = document.createElement('figure')
    figure.className = 'gw-live-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    /*
     * 加载失败时**回退成源码文本**而不是留一个破图标：附件可能已被删除、或 URL 指向站外，
     * 作者需要看到原文才能判断该怎么办（"图裂了但不知道原文是什么"没法修）。
     */
    img.addEventListener('error', () => {
      figure.textContent = `![${this.alt}](${this.src})`
      figure.classList.add('gw-live-image-failed')
    })
    if (this.alt === '') {
      figure.append(img)
    } else {
      const cap = document.createElement('figcaption')
      cap.textContent = this.alt
      figure.append(img, cap)
    }
    return figure
  }

  /** 图片是"看得见摸不着"的装饰：点它应该把光标落到源码上，故不让编辑器忽略事件 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 受限区段起点的锁标记（替代 `<!--gated:org-->` 这一行） */
class GateWidget extends WidgetType {
  constructor(readonly marker: GatedMarker) {
    super()
  }

  override eq(other: GateWidget): boolean {
    return other.marker === this.marker
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'gw-live-gate'
    span.dataset.marker = this.marker
    span.textContent = this.marker === 'org' ? '🔒 以下内容仅组织成员可见' : '🔒 以下内容需单独授权'
    return span
  }
}

/**
 * **渲染块**：把表格 / 代码块 / 整块 HTML / 分隔线画成成品的样子。
 *
 * 内容用 `mdToHtml()`（与阅读页**同一条**消毒出口）渲染 —— 不是"另写一套表格渲染"：
 * 两条路径若各画各的，实时渲染里看到的就不是发布后的样子，那正是这个模式要解决的问题。
 *
 * `eq()` 只比**块的源码与附加类名**：源码没变的块，CodeMirror 会复用已有 DOM，
 * 于是每次敲键都不会重新跑一遍 marked + DOMPurify（本地实测：块内改动才重渲染）。
 */
class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly kind: LiveBlockKind,
    readonly source: string,
    readonly extraClass: string,
  ) {
    super()
  }

  override eq(other: RenderedBlockWidget): boolean {
    return other.kind === this.kind && other.source === this.source && other.extraClass === this.extraClass
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = `gw-live-block md-body gw-live-block-${this.kind}${this.extraClass}`
    wrap.dataset.gwLiveBlock = this.kind
    // 说清"这里为什么不能直接打字"：点一下就会变回源码
    wrap.title = '点击这里改源码'
    wrap.innerHTML = mdToHtml(this.source)
    return wrap
  }

  /** 同上：要收得到点击，才能把光标送进源码（见 `liveRender()` 的 mousedown 处理） */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 单字形 widget（无序列表的项目符号、任务列表的复选框） */
class GlyphWidget extends WidgetType {
  constructor(
    readonly glyph: string,
    readonly className: string,
  ) {
    super()
  }

  override eq(other: GlyphWidget): boolean {
    return other.glyph === this.glyph && other.className === this.className
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.className
    span.textContent = this.glyph
    return span
  }
}

export interface LiveRenderOptions {
  /** 隐藏行内标记（`#`、`**`、`[]()`、行内代码的反引号…） */
  hideMarks: boolean
  /** 渲染图片 */
  renderImages: boolean
  /** 整块渲染表格 / 代码块 / 整块 HTML / 分隔线 */
  renderBlocks: boolean
}

/**
 * 光标所在的块。**活动块不做任何隐藏**（见文件头约束 1）。
 * 光标落在块之间的空行/标记行上时返回 `null` —— 此时全篇按渲染显示，
 * 这符合直觉："光标不在任何一段里"。
 */
function activeBlockOf(state: EditorState, blocks: readonly SourceBlock[]): SourceBlock | null {
  const sel = state.selection.main
  for (const b of blocks) {
    if (sel.from <= b.to && sel.to >= b.from) return b
  }
  return null
}

/** 一行要挂的类名（同一行可能既是引用又在受限区段里，合并成**一个**行装饰） */
type LineClasses = Map<number, string[]>

function addLineClass(map: LineClasses, pos: number, cls: string): void {
  const cur = map.get(pos)
  if (cur === undefined) map.set(pos, [cls])
  else if (!cur.includes(cls)) cur.push(cls)
}

/** 区间内每一行的起始偏移 */
function lineStartsIn(text: string, from: number, to: number): number[] {
  const out: number[] = []
  let pos = from
  while (pos <= to) {
    out.push(pos)
    const nl = text.indexOf('\n', pos)
    if (nl === -1 || nl >= to) break
    pos = nl + 1
  }
  return out
}

/**
 * 渲染块要带上的受限区段类名。
 *
 * 为什么必须补这一手：区段的底纹与左侧竖线是**行装饰**，而整块被 widget 替换掉的行
 * 根本没有行 DOM —— 不补的话，"受限区段里恰好放了一张表格"会变成一块**没有权限提示**的
 * 表格，读者（作者自己）会以为那一段是公开的。
 */
function gatedClassesOf(doc: SourceDoc, from: number): string {
  const block = blockAtOffset(doc, from)
  if (block === null || block.marker === null) return ''
  const region = regionOfBlock(doc, block.ordinal)
  const isLast = region !== null && region.blocks[region.blocks.length - 1] === block.ordinal
  return isLast ? ' gw-live-gated-line gw-live-gated-end' : ' gw-live-gated-line'
}

function buildDecorations(state: EditorState, opts: LiveRenderOptions): DecorationSet {
  const text = state.doc.toString()
  const doc = parseSourceDoc(text)
  /*
   * 正文有解析问题（标记不合法）时**不做块级装饰**：那时间隔不可信，
   * 藏错地方的正文比不藏坏得多。作者此刻该看到的是宿主的"标记有问题"告警。
   */
  if (doc.issues.length > 0) return Decoration.none

  const active = activeBlockOf(state, doc.blocks)
  const ranges: Range<Decoration>[] = []
  const lines: LineClasses = new Map()
  /** 已被整块替换掉的字符范围（行样式与行内标记都要避开，否则装饰落在看不见的正文上） */
  const covered: { from: number; to: number }[] = []
  const isCovered = (from: number, to: number): boolean => covered.some((c) => overlaps(from, to, c.from, c.to))
  /**
   * 是否**整个**落在某个渲染块里 —— 与 `isCovered`（相交）**不是**一回事，别合并：
   * 遍历里 `return false` 的含义是"不再往下走"，而**根节点与任何渲染块都相交**
   * （`Document` 包着全部内容）⇒ 用相交判据会在根节点上直接返回 false，整棵树一个节点都走不到。
   * 本批实测踩到：只要文里有一个渲染块，行内标记就全部不再隐藏（`#`/`**`/反引号满屏），
   * 而块本身照常渲染 —— 表现得像"另一套装饰坏了"，其实是这里把遍历截断了。
   */
  const isInsideCovered = (from: number, to: number): boolean =>
    covered.some((c) => from >= c.from && to <= c.to)

  /*
   * ---------------------- 一、块级渲染（必须**最先**跑） ----------------------
   *
   * 顺序不是风格问题：`covered` 是后面三趟"要不要跳过这一段"的判据，而它只在这一趟里产生。
   * 若先跑行样式再跑这里，行装饰就会落在**已经被 widget 替换掉**的行上 —— 它们没有行 DOM、
   * 挂上去看不见，但那是"碰巧没事"，不是对的。
   */
  const tree = syntaxTree(state)
  if (opts.renderBlocks) {
    tree.iterate({
      enter: (node) => {
        const blockKind = liveBlockKindOf(node.name)
        if (blockKind === null) return
        // `---` 只有独占整行时才是分隔线（`> ---` 只是引用里的一行）
        if (blockKind === 'rule' && !isWholeLine(text, node.from, node.to)) return false
        const span = alignToLines(text, node.from, node.to)
        if (span === null) return false
        /*
         * 活动块**不换**（文件头约束 1）：光标在表格里时看到的就是源码，这也是"点一下就能改"
         * 的实现方式 —— 点击把光标放进这一块（见 `liveRender()` 的 mousedown），
         * 它于是立刻从渲染块变回源码。
         */
        if (active !== null && overlaps(span.from, span.to, active.from, active.to)) return false
        if (isCovered(span.from, span.to)) return false
        covered.push(span)
        const widget = new RenderedBlockWidget(blockKind, text.slice(span.from, span.to), gatedClassesOf(doc, span.from))
        ranges.push(Decoration.replace({ widget, block: true }).range(span.from, span.to))
        return false
      },
    })
  }

  /* ---------------------- 二、行样式（按块类别 + 是否受限） ---------------------- */

  for (const block of doc.blocks) {
    if (block === active) continue
    const cls = blockLineClass(block.kind)
    if (cls === null) continue
    for (const start of lineStartsIn(text, block.from, block.to)) {
      if (isCovered(start, start + 1)) continue
      addLineClass(lines, start, cls)
    }
  }

  /* ---------------------- 三、受限区段：锁标记 + 区段底色 ---------------------- */

  /*
   * 光标**正停在标记行上**时，那一行露出源码（其余照旧渲染）。
   *
   * 为什么需要：标记行渲染后是一行"空白"（开标记变成锁徽标，闭标记整行被替换掉），
   * 想手改标记的人会点上去 —— 而"点了却看不见要改的东西"没法编辑。判据就是光标所在行的
   * 起始偏移等于该标记行的起始偏移。
   */
  const caretLineFrom = state.doc.lineAt(state.selection.main.head).from

  for (const region of doc.regions) {
    if (region.openFrom !== caretLineFrom) {
      ranges.push(Decoration.replace({ widget: new GateWidget(region.marker) }).range(region.openFrom, region.openTo))
    }
    /*
     * 闭标记（`<!--/gated-->`）也要藏起来。
     *
     * 它此前是**唯一**漏网的字面量：作者在实时渲染里会看到一行 `<!--/gated-->` 夹在正文中间
     * （实测截图里就是如此），既难看又让人以为这段是坏掉的。区段的**边界**改由底色与
     * 末行的下边框表达（见 `gw-live-gated-end`）——比一行裸注释更准确，也更不打扰。
     */
    if (region.closeFrom !== null && region.closeTo !== null && region.closeFrom !== caretLineFrom) {
      ranges.push(Decoration.replace({}).range(region.closeFrom, region.closeTo))
    }
    /*
     * 区段内每一行都加底色：光有开头那个锁，看不出"到哪一行为止"。
     * 末行（闭标记**之前**那一行）额外加一个类，用来画结束边。
     *
     * 整块被 widget 替换掉的行跳过 —— 它们没有行 DOM，类名挂上去也看不见；
     * 这些块的权限提示改由 `gatedClassesOf()` 挂到 widget 本身上。
     */
    const bodyEnd = region.to ?? text.length
    const bodyStarts = lineStartsIn(text, region.from, bodyEnd).filter((p) => region.to === null || p < region.to)
    bodyStarts.forEach((start, i) => {
      if (isCovered(start, start + 1)) return
      addLineClass(lines, start, 'gw-live-gated-line')
      if (i === bodyStarts.length - 1) addLineClass(lines, start, 'gw-live-gated-end')
    })
  }

  /* ---------------------- 四、行内标记与图片（块级渲染已在第一趟处理） ---------------------- */

  tree.iterate({
    enter: (node) => {
      const name = node.name

      // 已经**整个**落在某个渲染块里（或活动块里）：整块跳过，不再往下走
      if (isInsideCovered(node.from, node.to)) return false
      if (active !== null && node.from >= active.from && node.to <= active.to) return false

      if (name === 'Image') {
        if (!opts.renderImages) return false
        const src = text.slice(node.from, node.to)
        const m = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(src)
        if (m === null) return false
        ranges.push(Decoration.replace({ widget: new ImageWidget(m[2] ?? '', m[1] ?? '') }).range(node.from, node.to))
        return false
      }

      if (name === 'Link') {
        if (!opts.hideMarks) return false
        /*
         * 链接：只留可见文字，把 `[` 与 `](url)` 都藏掉（与渲染结果一致）。
         * 用子节点的位置定位文字边界，而不是自己数方括号 —— 链接文字里可能有 `]`。
         */
        const marks: { from: number; to: number }[] = []
        for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
          if (child.name === 'LinkMark') marks.push({ from: child.from, to: child.to })
        }
        const open = marks[0]
        const close = marks[1]
        if (open === undefined) return false
        ranges.push(Decoration.replace({}).range(open.from, open.to))
        if (close !== undefined) ranges.push(Decoration.replace({}).range(close.from, node.to))
        return false
      }

      /*
       * 无序列表的 `-` / `*` / `+` 换成「•」，任务列表的 `[ ]` / `[x]` 换成复选框。
       * 有序列表的 `1.` **不动**：它就是渲染后的样子（见 `lib/liveRenderPlan.ts`）。
       */
      if (name === 'ListMark') {
        if (!opts.hideMarks) return false
        const glyph = bulletForListMark(text.slice(node.from, node.to))
        if (glyph === null) return false
        ranges.push(Decoration.replace({ widget: new GlyphWidget(glyph, 'gw-live-bullet') }).range(node.from, node.to))
        return false
      }

      if (name === 'TaskMarker') {
        if (!opts.hideMarks) return false
        const glyph = taskGlyph(text.slice(node.from, node.to))
        if (glyph === null) return false
        ranges.push(Decoration.replace({ widget: new GlyphWidget(glyph, 'gw-live-task') }).range(node.from, node.to))
        return false
      }

      // 反引号：只藏行内代码的（围栏属于代码块自身，见 liveRenderPlan 的说明）
      if (name === 'CodeMark') {
        if (!opts.hideMarks) return false
        if (!hideInlineCodeMark(node.node.parent?.name)) return false
        ranges.push(Decoration.replace({}).range(node.from, node.to))
        return false
      }

      if (!HIDDEN_MARKS.has(name)) return
      if (!opts.hideMarks) return false

      /*
       * ★ 标题的 `#` **连同其后的空格**一起吃掉。
       *
       * Lezer 的 `HeaderMark` 只覆盖 `#` / `##` 本身，**不含后面那个空格**（实测：
       * `# 标题` ⇒ `HeaderMark [0,1]`；`## 二级` ⇒ `[10,12]`）。只藏标记就会把空格
       * 留在文档里 ⇒ 标题文本比正文右移一个空格宽，而标题字号更大、偏移更显眼 ——
       * 用户报的「正文和标题的缩进不一样」就是它。
       *
       * 只吃空格与制表符（不含换行）：空标题 `##` 后面直接是换行，吃进去就会把行并掉。
       */
      if (name === 'HeaderMark') {
        const isBlank = (i: number): boolean => {
          const ch = state.doc.sliceString(i, i + 1)
          return ch === ' ' || ch === '\t'
        }
        let to = node.to
        while (to < state.doc.length && isBlank(to)) to += 1
        ranges.push(Decoration.replace({}).range(node.from, to))
        return false
      }

      ranges.push(Decoration.replace({}).range(node.from, node.to))
      return false
    },
  })

  /* ---------------------- 五、合并（行装饰 + 行内/块装饰，统一排序） ---------------------- */

  for (const [pos, classes] of lines) {
    ranges.push(Decoration.line({ class: classes.join(' ') }).range(pos))
  }
  // `sort: true`：RangeSet 要求有序，而上面五趟各有各的顺序，交给它统一排序
  return Decoration.set(ranges, true)
}

/**
 * 点击渲染块 ⇒ 把光标送进这一块的源码。
 *
 * 为什么不能只靠浏览器的默认行为：渲染块是**替换装饰**，默认的点击会把光标放到
 * 替换范围的边界上（DOM 里根本没有对应的文字），作者"点了却没反应"。这里显式地
 * 按块把光标落到块首，下一次重算（`tr.selection`）就会把这一块从渲染块换回源码。
 *
 * 顺带挡住渲染内容里的链接跳转：整块 HTML 里可能有 `<a href>`，在编辑器里点它
 * 不该把作者带走（那是一次整页导航，未保存的改动会丢）。
 */
function enterBlockOnClick(event: MouseEvent, view: EditorView): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  const el = target.closest('.gw-live-block')
  if (el === null) return false
  const block = blockAtOffset(parseSourceDoc(view.state.doc.toString()), view.posAtDOM(el))
  if (block === null) return false
  view.dispatch({ selection: { anchor: block.from } })
  view.focus()
  event.preventDefault()
  return true
}

/**
 * 实时渲染扩展。
 *
 * 选项通过 `Compartment` 重配置（模式切换、只读态）：字段随扩展一起重建，
 * 装饰随之重算 —— 不需要手写失效逻辑。
 */
export function liveRender(options: LiveRenderOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, options),
    update: (deco, tr) => {
      /*
       * 重算的三类触发（少一类就会出现"装饰停在旧文档上"）：
       * - `docChanged`：正文变了；
       * - `selection !== undefined`：活动块换了 ⇒ 该露出的源码与该藏起来的标记都变了；
       * - **语法树换了**：Markdown 的解析在大文档上是**异步**的，解析完成时派发的事务
       *   不改文档也不改选区 —— 不认这一条，长文档里的表格会一直停在"没渲染"的样子。
       */
      if (tr.docChanged || tr.selection !== undefined || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return buildDecorations(tr.state, options)
      }
      return deco
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  return [field, EditorView.domEventHandlers({ mousedown: enterBlockOnClick })]
}
