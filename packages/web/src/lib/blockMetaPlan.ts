/**
 * `blockMetaPlan.ts` —— 阅读页**块级归属**的纯计划层（无 DOM、无 React、无网络）。
 *
 * ## 这个模块回答两个问题
 *
 * 1. **对齐**：服务端下发的块区间是相对 `GET /api/pages/:slug` 的 `content` 的，
 *    而阅读页真正渲染的那份 Markdown 是 `stripDuplicateLeadingTitle(content, title)`
 *    的结果 —— 两者**少了一段**（与标题重复的首个一级标题）⇒ 区间必须先映射过去，
 *    并且要能证明映射是对的（`alignBlockSegments` 的末尾那条恒等式）。
 * 2. **文案**：把归属压成一句「最后由 X 编辑 · 3 天前」（`blockMetaText`）。
 *
 * ## 为什么必须是纯函数
 *
 * 本仓的 node 测试环境**没有 DOM**（web 的用例都是纯逻辑），而渲染那一半
 * （`markdownRender.ts`）需要 `document` 与 DOMPurify。于是"哪些段该带哪句文案"这件事
 * 必须能在这里被逐条钉住 —— 否则它就只能在真机上靠肉眼验收（本仓已有前车之鉴：
 * 区间算错的表现是"标签挂到了隔壁段落上"，既不报错也不容易被看见）。
 *
 * ## 三条边界，写在这里比写在注释里更可靠
 *
 *   - **不知道就不显示**：`author === null`（跨插件代调用 / 存量回填 / 账号已删）或
 *     `updatedAt === null` ⇒ 这一段的文案是 `null`，界面**不渲染任何标签**。
 *     绝不拿页面级的 `updated_at`（"这一页被保存过"）顶替块级的"这一段被改过"。
 *   - **占位段没有归属**：`gated` 段是受限块合并成的一行占位，它不是任何人的作品。
 *   - **对不齐就不显示**：`alignBlockSegments` 返回 `null` 时，调用方必须放弃**整页**的
 *     归属（而不是"尽力而为地错位显示"）。少给可以，给错不行。
 */
import { authorText } from './authorText'
import { absoluteTime, relativeTime } from './timePlan'

/**
 * 服务端下发的一个块单元（`WikiPageDetail.blocks` 的一项）。
 *
 * 字段名与 `packages/core/src/services.ts` 的 `WikiPageDetail.blocks` **逐字对应**，
 * 不要在这里改名。
 */
export interface BlockUnit {
  /** 该段在 `content` 里的字符区间 `[start, end)` */
  start: number
  end: number
  /** `true` = 受限块合并成的占位（没有可归属的块） */
  gated: boolean
  /** 文本最后一次被改动的时刻；`null` = 不知道 */
  updatedAt: string | null
  /** 做出那次改动的人；`null` = 无法归属（**与 `{ id, displayName: null }` 不是一回事**） */
  author: { id: number; displayName: string | null } | null
}

/** 对齐到**实际渲染的那份 Markdown** 之后的段（区间是渲染文本上的区间） */
export interface BlockSegment extends BlockUnit {}

/**
 * 渲染分组：一组共用**一个（或一串连续）DOM 节点**，因此只能说一句归属。
 *
 * `htmlStart`/`htmlEnd` 是这一组在**整份 HTML** 里的区间（由 `planBlockGroups` 验证得到，
 * 于是"把 HTML 按这些边界切开"是逐字无损的）。
 */
export interface BlockGroup {
  /** 该组在整份 HTML 里的区间 `[htmlStart, htmlEnd)` */
  htmlStart: number
  htmlEnd: number
  /** 组内全部段一致时的代表段（用于取文案）；不一致/占位 ⇒ `null` ⇒ 不显示标签 */
  label: BlockSegment | null
  /** 该组覆盖了几段（1 = 没有跨段续行；诊断与测试用） */
  segmentCount: number
}

/**
 * 把服务端的块区间对齐到**实际渲染的 Markdown**（`shown` 是 `full` 删掉一段后的结果）。
 *
 * ## 已经确认的调用前提
 *
 * `full` = 接口返回的 `content`，`shown` = 页面实际渲染的那份（当前实现里是
 * `stripDuplicateLeadingTitle(full, title)` 的产物）。为了让本函数**不绑死**在那个具体
 * 变换上，这里不 import `pageMeta`，而是**量出来**：先算公共前缀与公共后缀，
 * 得到"被删掉的那一段"，再验证 `full.slice(0, from) + full.slice(to) === shown`。
 * 验证不过 ⇒ 返回 `null`（宁可没有归属，也不要错位）。
 *
 * ## 末尾那条恒等式是整个功能的地基
 *
 * 服务端的投影是把块文本用 `'\n\n'` 拼起来的（`projectBlocks`），所以
 * `segments.map(s => shown.slice(s.start, s.end)).join('\n\n') === shown`
 * **必须**成立 —— 它一旦不成立，就说明区间与渲染文本不是同一份东西，
 * 此时任何"逐段归属"都是猜的。猜错的表现是**标签挂到了隔壁段落**（不报错），
 * 故这里宁可返回 `null`（整页不显示归属）。
 */
export function alignBlockSegments(
  full: string,
  shown: string,
  units: readonly BlockUnit[],
): BlockSegment[] | null {
  if (units.length === 0) return null

  /** 被删掉的那一段 `[from, to)`；`full === shown` 时是空区间（`from === to`） */
  let from = 0
  let to = 0
  if (full !== shown) {
    const removed = full.length - shown.length
    // 渲染文本比原文**长**（或等长却不同）⇒ 不是"删掉一段"这种形态，本函数不认识它
    if (removed <= 0) return null
    const max = Math.min(full.length, shown.length)
    while (from < max && full[from] === shown[from]) from += 1
    let suffix = 0
    while (suffix < max - from && full[full.length - 1 - suffix] === shown[shown.length - 1 - suffix]) suffix += 1
    to = full.length - suffix
    // 删掉的长度必须与两串长度差**恰好**相等，且删完能逐字还原 —— 两条都过才算"就是删了一段"
    if (to - from !== removed) return null
    if (full.slice(0, from) + full.slice(to) !== shown) return null
  }

  const shift = to - from
  const segments: BlockSegment[] = []
  for (const u of units) {
    if (u.end <= u.start) continue // 空区间：不该出现，出现了就当它不存在
    /*
     * 与删除区间**相交**的段：它的文本已经有一部分不在渲染文本里了。
     * 丢掉整段（而不是裁剪）—— 裁剪出来的区间不再落在块边界上，末端的恒等式会立刻失败，
     * 那等于把"这里对不齐"翻译成一次静默的错位显示。
     *
     * 这就是标题那一段的处置：`stripDuplicateLeadingTitle` 删掉的正是与页面标题重复的
     * 首个一级标题（连同它后面的一个空行）⇒ 那一段本来也不该有「最后由谁编辑」。
     */
    if (to > from && u.start < to && u.end > from) continue
    const start = shift > 0 && u.start >= to ? u.start - shift : u.start
    const end = shift > 0 && u.end >= to ? u.end - shift : u.end
    if (start < 0 || end > shown.length || end <= start) return null
    segments.push({ ...u, start, end })
  }
  if (segments.length === 0) return null

  // ★ 地基：区间切出来的片段，用 `'\n\n'` 拼回去必须**逐字等于**渲染文本
  if (segments.map((s) => shown.slice(s.start, s.end)).join('\n\n') !== shown) return null
  return segments
}

/**
 * ★ **逐段渲染的分组计划**：找出"哪几个块在渲染后共用同一个 DOM 节点"。
 *
 * ## 为什么不能简单地"一块一段"
 *
 * 服务端的块是**空行分隔**的（`parseBlocks`），而 Markdown 的渲染并不总是一块一个节点：
 *   - **松列表**（`- 甲` / 空行 / `- 乙`）在 CommonMark 里是**一个** `<ul>`（带 `<p>` 的
 *     loose list），分成两块渲染却会变成**两个** `<ul>`；
 *   - **链接引用定义**（`[x]: /wiki/y` 单独占一段）自己渲染成**空串**，而 `[x]` 的解析
 *     要用到它 —— 它必须跟着后面那段一起渲染才对得上。
 * 这两种情况下"每块一份 HTML 拼起来 = 整份 HTML"不成立，于是**怎么切都切错了**。
 *
 * ## 做法：从左到右**贪心合并**，每一组都用"是不是整份 HTML 的下一段"来验证
 *
 * 记 `pos` = 已经确认过的 HTML 前缀长度。对从第 `i` 段开始的候选组 `[i..j]`：
 * 把这几段的 Markdown 用 `'\n\n'` 拼起来渲染，若它的 HTML 正好出现在 `html` 的 `pos`
 * 处，就**确认**这一组（边界就是真的）；否则把 `j` 往后扩一段再试。
 * 全部组确认完、且 `pos` 恰好走到 `html` 末尾 ⇒ 这份切分是**被证明过的**
 * （`html` 被逐字切成了这些组的 HTML）。
 *
 * 代价：**常见情况每组一次渲染**（`j = i` 就命中）；只有真的存在跨段续行时才多渲染几次，
 * 而总次数被 `段数 × 2` 量级封顶 —— 失败（连到文末都对不上）会**立刻**整份放弃。
 *
 * ## 渲染为空的组（引用定义）：不能自己成组，必须并进下一组
 *
 * 空串是**任何**字符串的前缀 ⇒ 若允许"空组"提交，`pos` 会不动、组会越切越碎，
 * 而且那个定义再也不会参与后面的渲染（`[x]` 解析不出来 ⇒ 整组对不上 ⇒ 整份放弃）。
 * 故这里的规则是：**渲染为空就继续往后扩**，直到这一组渲染出非空 HTML 为止。
 *
 * ## 一组的归属：组内**全部段一致**才显示
 *
 * 一组共用一个 DOM 节点 ⇒ 只能给出一句文案。组内几段的作者/时间只要有一处不同，
 * 就**不给标签**（标签贴在合并后的节点上、说成其中某一段的归属，就是错位的那种假话）。
 * 判据见 {@link sharedSegment}。
 *
 * @param markdown 实际渲染的那份 Markdown（区间都相对它）
 * @param segments 已对齐的段（`alignBlockSegments` 的产物）
 * @param renderText 把一段 Markdown 渲染成**已消毒 HTML**（真实调用方传 `mdToHtml`）
 * @param html `renderText(markdown)` 的结果（整份渲染，用于验证切分）
 * @returns 分组计划；`null` = 分不出来（调用方必须**整份放弃**归属，正文照常显示）
 */
export function planBlockGroups(
  markdown: string,
  segments: readonly BlockSegment[],
  renderText: (source: string) => string,
  html: string,
): BlockGroup[] | null {
  if (segments.length === 0 || html === '') return null
  const textOf = (s: BlockSegment): string => markdown.slice(s.start, s.end)
  /** 组的原始区间（归属在最后统一算：尾部可能还要并入只渲染出空串的段） */
  const spans: Array<{ from: number; to: number; htmlStart: number; htmlEnd: number }> = []
  /**
   * **带着走的上下文**：自己渲染为空串的段（链接引用定义、HTML 注释）。
   *
   * ★ 这一条是浏览器验收抓出来的真缺陷（单测当时用的是"定义紧跟消费段"的理想形态）：
   * 引用定义是**文档作用域**的 —— `[ref]: /wiki/x` 可以定义在第 2 段，而被第 9 段消费。
   * 第一版把定义"并进第一个渲染出非空 HTML 的组"就完事，于是第 9 段单独渲染时
   * `[ref]` 解析不出来 ⇒ 整份对不上 ⇒ **整页没有任何标签**（页面看上去完全正常）。
   * 正确做法是把这些段当成**所有后续组的渲染前缀**：它们贡献的 HTML 是空串，
   * 所以既不会改变任何一组的边界，也不该被算进任何一组的归属（它们没有 DOM 节点）。
   */
  const context: string[] = []
  let pos = 0
  let i = 0
  while (i < segments.length) {
    const solo = textOf(segments[i] as BlockSegment)
    // 自己渲染为空 ⇒ 它不产生任何节点 ⇒ 收进上下文，不占组（也就没有归属可言）
    if (renderText(solo) === '') {
      context.push(solo)
      i += 1
      continue
    }
    let matched = -1
    for (let j = i; j < segments.length; j += 1) {
      /*
       * 组内区间连续且有序：`[...context, 本组各段]` 用 `'\n\n'` 拼 ——
       * 与服务端投影的口径一致，也正是"整份 Markdown"的构造方式。
       */
      const source = [
        ...context,
        ...segments
          .slice(i, j + 1)
          .map(textOf),
      ].join('\n\n')
      const part = renderText(source)
      if (part === '') continue
      if (html.startsWith(part, pos)) {
        spans.push({ from: i, to: j, htmlStart: pos, htmlEnd: pos + part.length })
        pos += part.length
        matched = j
        break
      }
      /*
       * 渲染出来了但不在当前位置 ⇒ 这一组与后面的段**连在一起**（松列表、被引用的
       * 那段…），把 j 往后扩一段再试。注意这里**不**放弃：放弃的判据是"连到文末
       * 都对不上"。
       */
    }
    if (matched < 0) return null
    i = matched + 1
  }
  // ★ 地基：切分必须**恰好覆盖整份 HTML**（少一截多一截都说明边界是猜的）
  if (pos !== html.length) return null

  return spans.map((s) => {
    const group = segments.slice(s.from, s.to + 1)
    const label = sharedSegment(group)
    return { htmlStart: s.htmlStart, htmlEnd: s.htmlEnd, label, segmentCount: group.length }
  })
}

/**
 * 组内**全部段一致**时的代表段；不一致（或组内有占位段）⇒ `null`（不显示标签）。
 *
 * 比较的是四项：`gated`、`updatedAt`、作者 id、作者展示名。**展示名也要比**，
 * 因为 `{ id: 2, displayName: null }`（名字被权限收走 ⇒「另一位成员」）与
 * `{ id: 2, displayName: '爱丽丝' }` 会渲染出**不同的话**，混在一组里就没有正确答案。
 */
function sharedSegment(group: readonly BlockSegment[]): BlockSegment | null {
  const first = group[0]
  if (first === undefined) return null
  for (const s of group) {
    if (s.gated !== first.gated) return null
    if (s.updatedAt !== first.updatedAt) return null
    if ((s.author?.id ?? null) !== (first.author?.id ?? null)) return null
    if ((s.author?.displayName ?? null) !== (first.author?.displayName ?? null)) return null
  }
  return first
}

/**
 * 一段的归属文案（`null` = 这一段**不显示任何标签**）。
 *
 * 措辞与版本列表的 `versionMetaText`（"3 天前 · 爱丽丝"）**刻意不同**：
 * 版本菜单里的主语是"这一版"，句子里能省掉动词；而块标签是贴在正文旁边的
 * 一句独立的话，必须自己说清"这是谁干的、干了什么"。两处都经 `authorText` 取作者文案，
 * 所以「另一位成员」这个措辞全站仍然只有一处定义。
 *
 * `now` 由调用方传入（默认 `new Date()`）—— 与 `relativeTime` 同款约定，单测不依赖真实时钟。
 */
export function blockMetaText(segment: BlockSegment, now: Date = new Date()): string | null {
  if (segment.gated) return null
  if (segment.author === null) return null
  if (segment.updatedAt === null || segment.updatedAt === '') return null
  return `最后由 ${authorText(segment.author)} 编辑 · ${relativeTime(segment.updatedAt, now)}`
}

/** 标签 `title` 里的绝对时间（悬停显示）；没有归属时返回 `null` */
export function blockMetaTitle(segment: BlockSegment): string | null {
  if (segment.gated) return null
  if (segment.author === null) return null
  if (segment.updatedAt === null || segment.updatedAt === '') return null
  return `${authorText(segment.author)} · ${absoluteTime(segment.updatedAt)}`
}

/**
 * 逐段归属一次渲染的最多段数。
 *
 * 为什么要有它：为了让"逐段包裹"**不改变任何排版**，渲染层会把每个片段单独渲染一次
 * 再校验拼接结果与原样渲染**逐字相同**（见 `markdownRender.ts`），代价是每段一次
 * `marked` + `DOMPurify`。普通页面（几十段）完全无感，但一段上万段的畸形页面会把它变成
 * 一次明显的卡顿 —— 那时**放弃归属**（正文照常显示）比卡住整个阅读页要好。
 */
export const MAX_ATTRIBUTED_SEGMENTS = 400

/**
 * 包裹每一段的类名（样式在 `styles/markdown.css`）。
 *
 * 为什么用一个**无语义的 div** 而不是给块本身加属性：块的 HTML 形态由 `marked` 决定且
 * 随块类型变化（`<p>` / `<ul>` / `<pre>` / `<table>` 外面的滚动层…），有的块（HTML 块）
 * 还会渲染出**多个**顶层节点 —— 包一层是唯一不挑块类型的做法。
 * 包裹层不设 margin/padding（见样式注释），故**排版与不包裹时逐像素相同**。
 */
export const BLOCK_WRAP_CLASS = 'gw-block'

/** 「最后由 X 编辑 · 3 天前」标签自身的类名；只在悬停/聚焦该段时可见 */
export const BLOCK_META_CLASS = 'gw-block-meta'
