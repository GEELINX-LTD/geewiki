/**
 * 编辑页的**块模型**：服务端 `packages/plugin-wiki/src/blocks.ts` 的 `parseBlocks()` 前端镜像，
 * 额外带**字符位置**（`from`/`to`/行号），因为编辑页要拿它去改正文。
 * ============================================================================
 *
 * ## 为什么需要这一层（而不是复用 `lib/gatedPreview.ts`）
 *
 * `gatedPreview.ts` 回答的是"**某个视角下能看到什么**"，它输出的是**投影后的 Markdown 文本**，
 * 位置信息在投影过程中就丢了。而"在编辑器里按块改档位"要的是另一样东西：
 * **这一段在源文档里的哪个位置、它现在处于哪个区段、改完标记后正文长什么样**。
 * 两件事共用同一套标记语法（正则逐字一致），但产物不同，故分成两个模块。
 *
 * ## 与服务端的契约（改一侧必须改另一侧）
 *
 * - 标记正则、已知档位、块切分规则（空行切块、**围栏内不切**、标记行是区段分隔符而非内容）
 *   与 `blocks.ts` 完全一致；`test/editorBlocks.test.ts` 有**源码级逐字守卫**。
 * - 服务端解析失败是**抛错中止**（`BlockParseError`）。这里记录问题后**继续解析** ——
 *   编辑页还要把已解析出来的部分画出来给作者看。但**只要有任一问题，档位改写一律拒绝**：
 *   绝不基于一份自己都解析不了的正文去动标记（那正是"以为收紧了、实际放开了"的来源）。
 *
 * ## 为什么改写走"整篇重建"而不是"局部插入"
 *
 * 标记的合法性是**全局**的：嵌套、未闭合、多余闭合都会被服务端 400 拒绝。局部插入要在
 * 每种邻接情形下各自证明合法性（夹在两个区段之间？区段里只有这一块？标记就是唯一的分隔符？），
 * 而整篇重建把合法性收敛成**一个**自检：写完重新解析一遍，块数与每块档位对不上就放弃改动。
 * 正文逐行原样搬运，标记按目标档位重新生成 —— 作者的手写换行不会被吃掉。
 */
import type { BlockVisibility } from '../api'

/*
 * ⚠️ 以下四行是 `packages/plugin-wiki/src/blocks.ts:76-79` 的**手抄镜像**。
 * web 不能 import 后端包（`packages/core` 不进浏览器包），故靠源码级守卫测试钉住逐字一致：
 * 改服务端正则而忘了这里 ⇒ `test/editorBlocks.test.ts` 变红。
 */
const OPEN_RE = /^<!--\s*gated\s*:\s*([^>]*?)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/gated\s*-->\s*$/
const KNOWN_MARKERS: readonly string[] = ['org', 'granted']
const FENCE_RE = /^\s*(```|~~~)/

/** 区段标记的两种取值（`'public'` **不是**标记，它表示"没有标记"） */
export type GatedMarker = 'org' | 'granted'

/** 块的语法类别。取值域是服务端 `kindOf()` 的**像**（它不产生 `list_item` / `gated`） */
export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'quote'
  | 'table'
  | 'html'
  | 'list'

export interface SourceBlock {
  /** 在解析序列里的下标（与服务端 `ParsedBlock.ordinal` 同序） */
  ordinal: number
  kind: BlockKind
  /** 块正文在文档中的起止（半开区间，字符偏移） */
  from: number
  to: number
  /** 块正文所在行（0-based，闭区间） */
  startLine: number
  endLine: number
  /** 块正文（**不含**标记行） */
  text: string
  /** 所在区段的标记；`null` = 未标记（跟随页面档位） */
  marker: GatedMarker | null
}

export interface SourceRegion {
  marker: GatedMarker
  /** 开标记所在行（0-based） */
  openLine: number
  openFrom: number
  openTo: number
  /** 闭标记所在行；`null` = 未闭合（此时 `issues` 里必有 `gated_unclosed`） */
  closeLine: number | null
  closeFrom: number | null
  closeTo: number | null
  /** 区段内正文的字符范围；未闭合时 `to === null` */
  from: number
  to: number | null
  /** 区段覆盖的块序号 */
  blocks: number[]
}

export interface SourceDoc {
  blocks: SourceBlock[]
  regions: SourceRegion[]
  /**
   * 解析问题（用**服务端的错误码**，便于两侧文案对齐）。非空 ⇒ 服务端保存时会 400，
   * 且本模块的档位改写会被拒绝。
   */
  issues: string[]
}

/** 块档位的三档（与服务端 `BlockVisibility` 同域：块**没有** `private`） */
export const BLOCK_TIER_VALUES: readonly BlockVisibility[] = ['public', 'org', 'granted']

/**
 * 块档位的选项文案。
 *
 * ⚠️ 未标记那档**不能**叫「公开」：服务端 `ParsedBlock.visibility` 对未标记块回的是
 * `'public'`，但它的语义是"这一块**自身**不额外收紧"，有效档位还要与页面档位取更严的一方
 * （`tierFor` 的 `max`）。写成「公开」会让作者以为"这块匿名能看到"——在 `org` 页面上这是
 * **错的**。故这里叫「跟随页面档位」。
 */
export const BLOCK_TIER_OPTIONS: ReadonlyArray<{
  id: BlockVisibility
  label: string
  hint: string
  /** 是否需要写标记（`public` = 不写，即"跟随页面"） */
  marker: GatedMarker | null
}> = [
  {
    id: 'public',
    label: '跟随页面档位',
    hint: '不写标记：这一块自身不额外收紧，页面是什么档就按什么档判定（页面更窄时以页面为准）。',
    marker: null,
  },
  {
    id: 'org',
    label: '仅组织成员',
    hint: '写入 <!--gated:org-->：只有登录且属于本组织的成员能读到这一段；匿名访客读到的是占位文案。',
    marker: 'org',
  },
  {
    id: 'granted',
    label: '需单独授权',
    hint: '写入 <!--gated:granted-->：组织成员也读不到，只有拿到本块（或本页）例外授予的人能读。档位最窄的一档。',
    marker: 'granted',
  },
]

/** 某一块的**自身**档位：有标记按标记，无标记即"跟随页面" */
export function blockTierOf(block: SourceBlock): BlockVisibility {
  return block.marker ?? 'public'
}

interface SourceLine {
  start: number
  end: number
  /** 行尾换行符长度（0 = 末行且无换行；CRLF 记 2） */
  eol: number
  text: string
}

/**
 * 按行切开并**记录每行的字符位置**。
 *
 * 与服务端的 `content.replace(/\r\n?/g, '\n').split('\n')` 等价（CRLF/CR 都当一次换行），
 * 区别只是这里保留位置。**末尾的换行会产生一个空行**（`'a\n'` ⇒ `['a', '']`）——与服务端
 * `split('\n')` 的行为一致，空行参与"空行切块"的判定，不能少这一个。
 */
function splitLines(text: string): SourceLine[] {
  const out: SourceLine[] = []
  let i = 0
  while (i <= text.length) {
    let j = i
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++
    const eol = j >= text.length ? 0 : text[j] === '\r' && text[j + 1] === '\n' ? 2 : 1
    out.push({ start: i, end: j, eol, text: text.slice(i, j) })
    if (j >= text.length) break
    i = j + eol
  }
  return out
}

/** 按首个非空行的形态判定块类别（服务端 `kindOf()` 的镜像） */
function kindOf(text: string): BlockKind {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const t = first.trimStart()
  if (t.startsWith('#')) return 'heading'
  if (t.startsWith('```') || t.startsWith('~~~')) return 'code'
  if (t.startsWith('>')) return 'quote'
  if (t.startsWith('|')) return 'table'
  if (t.startsWith('<')) return 'html'
  if (/^([-*+]|\d+[.)])\s/.test(t)) return 'list'
  return 'paragraph'
}

/**
 * 解析正文为块序列（带位置）。
 *
 * 规则与服务端 `parseBlocks()` 逐条对齐，详见该函数上方注释；这里只强调两条容易写错的：
 * 1. **围栏的开/闭行本身属于代码块**，且围栏内的空行不切块；
 * 2. **标记行不属于任何块**（它是区段分隔符）——所以 `blocks[].text` 里绝不会出现标记，
 *    这也正是公共视图不会因为块文本里含标记而泄露"这里有个受限区段"的原因。
 */
export function parseSourceDoc(content: string): SourceDoc {
  const lines = splitLines(content)
  const blocks: SourceBlock[] = []
  const issues: string[] = []
  const regions: SourceRegion[] = []

  /** 当前行所属区段（开标记 → 闭标记之间） */
  let region: SourceRegion | null = null
  /** 正在累积的块：行下标 + 该块第一行时的区段（块的档位**只看首行**所在区段） */
  let buf: number[] = []
  let bufMarker: GatedMarker | null = null
  let inFence = false

  const addIssue = (code: string): void => {
    if (!issues.includes(code)) issues.push(code)
  }

  const flush = (): void => {
    if (buf.length === 0) return
    const first = buf[0] ?? 0
    const last = buf[buf.length - 1] ?? 0
    const text = buf.map((n) => lines[n]?.text ?? '').join('\n')
    // 纯空白不构成块（作者多敲几个空行不该产生块）——与服务端一致
    if (text.trim() !== '') {
      const block: SourceBlock = {
        ordinal: blocks.length,
        kind: inFence ? 'code' : kindOf(text),
        from: lines[first]?.start ?? 0,
        to: lines[last]?.end ?? 0,
        startLine: first,
        endLine: last,
        text,
        marker: bufMarker,
      }
      blocks.push(block)
      if (region !== null) region.blocks.push(block.ordinal)
    }
    buf = []
    bufMarker = null
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (line === undefined) break
    const open = OPEN_RE.exec(line.text)
    if (open) {
      if (inFence) {
        // 围栏里的标记是**内容**，不是标记（与服务端一致）
        if (buf.length === 0) bufMarker = region === null ? null : region.marker
        buf.push(n)
        continue
      }
      flush()
      if (region !== null) {
        // 服务端在这里抛 gated_nested 中止。这里记下来并**保留外层区段**（内层标记当无效标记）
        addIssue('gated_nested')
        continue
      }
      const spec = (open[1] ?? '').trim()
      if (/^role\s*[=:]/i.test(spec) || spec === 'private') {
        addIssue('gated_marker_removed')
        continue
      }
      if (!KNOWN_MARKERS.includes(spec)) {
        addIssue('gated_marker_unknown')
        continue
      }
      region = {
        marker: spec as GatedMarker,
        openLine: n,
        openFrom: line.start,
        openTo: line.end,
        closeLine: null,
        closeFrom: null,
        closeTo: null,
        from: line.end + line.eol,
        to: null,
        blocks: [],
      }
      regions.push(region)
      continue
    }

    if (CLOSE_RE.test(line.text) && !inFence) {
      flush()
      if (region === null) {
        addIssue('gated_close_without_open')
        continue
      }
      region.closeLine = n
      region.closeFrom = line.start
      region.closeTo = line.end
      region.to = line.start
      region = null
      continue
    }

    if (FENCE_RE.test(line.text)) {
      // 围栏的开/闭行本身属于代码块
      if (buf.length === 0) bufMarker = region === null ? null : region.marker
      buf.push(n)
      inFence = !inFence
      continue
    }

    if (!inFence && line.text.trim() === '') {
      flush()
      continue
    }

    if (buf.length === 0) bufMarker = region === null ? null : region.marker
    buf.push(n)
  }

  if (inFence) addIssue('code_fence_unclosed')
  flush()
  if (region !== null) {
    addIssue('gated_unclosed')
    region.to = content.length
  }
  return { blocks, regions, issues }
}

/** 找到包含该偏移的块；落在块之间的空行/标记行上返回 `null` */
export function blockAtOffset(doc: SourceDoc, offset: number): SourceBlock | null {
  for (const b of doc.blocks) {
    if (offset >= b.from && offset <= b.to) return b
  }
  return null
}

/** 找到包含该块的区段；未标记块返回 `null` */
export function regionOfBlock(doc: SourceDoc, ordinal: number): SourceRegion | null {
  for (const r of doc.regions) {
    if (r.blocks.includes(ordinal)) return r
  }
  return null
}

export type TierRewrite =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: string }

/** 解析问题 → 给作者看的一句话（错误码要露出来，便于对着服务端日志排查） */
export function issuesText(issues: readonly string[]): string {
  return issues.join('、')
}

/**
 * 按"目标档位表"重写正文里的 gated 标记。
 *
 * `edits` 只写要改的块（ordinal → 目标档位），没提到的块保持原状。
 *
 * 成功时保证：① 正文能重新解析且**问题为空**；② 块数与每块文本**一字不变**；
 * ③ 每块的档位等于目标值。任一条不成立 ⇒ 返回 `error` 且**不改正文**
 * （宁可不改，也不留一份自己都不确定的标记结构给服务端）。
 */
export function applyBlockTiers(content: string, edits: ReadonlyMap<number, BlockVisibility>): TierRewrite {
  const doc = parseSourceDoc(content)
  if (doc.issues.length > 0) {
    return {
      ok: false,
      error: `正文里的 gated 标记当前不合法（${issuesText(doc.issues)}），保存也会被服务端拒绝；请先修好标记再改块档位`,
    }
  }
  const empty = doc.regions.filter((r) => r.blocks.length === 0)
  if (empty.length > 0) {
    return {
      ok: false,
      error:
        '正文里有**空的**受限区段（标记之间没有任何内容）。为避免改写时把它静默吃掉，请先给它补上内容、或删掉这对标记。',
    }
  }
  if (doc.blocks.length === 0) return { ok: true, text: content, changed: false }

  const desired = (ordinal: number): BlockVisibility => {
    const edited = edits.get(ordinal)
    if (edited !== undefined) return edited
    const block = doc.blocks[ordinal]
    return block === undefined ? 'public' : blockTierOf(block)
  }

  const changed = doc.blocks.some((b) => desired(b.ordinal) !== blockTierOf(b))
  if (!changed) return { ok: true, text: content, changed: false }

  /*
   * 重建。正文行**原样搬运**，只有"块之间"的部分重新生成：
   * 空行数量按原文保留（作者的空行是排版意图），标记行按目标档位重新写出。
   */
  const lines = splitLines(content)
  /**
   * 两块之间（或文首/文末）的**作者空行数**：标记行要扣掉。
   *
   * 标记按排版约定各占掉一行空行当补白（`<!--gated:org-->` 两侧各留一行），而重建时每个标记
   * 又会各补一行。若把标记的补白也算成作者的空行，每改一次档位就凭空多出一行空行 ——
   * 来回切换「仅组织成员 / 需单独授权」会让正文无限长高，作者看到的是"我什么都没改，行数却变了"。
   */
  const authorBlanks = (fromLine: number, toLine: number): number => {
    let blanks = 0
    let markers = 0
    for (let i = fromLine; i < toLine; i++) {
      const text = lines[i]?.text ?? ''
      if (text.trim() === '') blanks++
      else if (OPEN_RE.test(text) || CLOSE_RE.test(text)) markers++
    }
    return Math.max(0, blanks - markers)
  }
  const blockLines = (b: SourceBlock): string[] => {
    const out: string[] = []
    for (let i = b.startLine; i <= b.endLine; i++) out.push(lines[i]?.text ?? '')
    return out
  }

  const out: string[] = []
  const blank = (n: number): void => {
    for (let i = 0; i < n; i++) out.push('')
  }

  // 文首：原样保留空行（标记行属于区段，下面按目标档位重写）
  blank(doc.blocks[0] === undefined ? 0 : authorBlanks(0, doc.blocks[0].startLine))
  if (desired(0) !== 'public') {
    out.push(`<!--gated:${desired(0)}-->`)
    out.push('')
  }

  for (let i = 0; i < doc.blocks.length; i++) {
    const block = doc.blocks[i]
    if (block === undefined) break
    if (i > 0) {
      const prev = desired(i - 1)
      const cur = desired(i)
      // 块之间的空行：原文几行就几行；一行都没有时**必须**补一行 ——
      // 标记本身可以当分隔符，标记被移除后两块会粘成一块（块身份就变了）
      const gaps = authorBlanks((doc.blocks[i - 1]?.endLine ?? 0) + 1, block.startLine)
      blank(Math.max(1, gaps))
      if (prev !== 'public' && cur !== prev) {
        out.push('<!--/gated-->')
        out.push('')
      }
      if (cur !== 'public' && cur !== prev) {
        out.push(`<!--gated:${cur}-->`)
        out.push('')
      }
    }
    out.push(...blockLines(block))
  }

  const lastOrdinal = doc.blocks.length - 1
  if (desired(lastOrdinal) !== 'public') {
    out.push('')
    out.push('<!--/gated-->')
  }
  const lastBlock = doc.blocks[lastOrdinal]
  blank(authorBlanks((lastBlock?.endLine ?? 0) + 1, lines.length))

  const next = out.join('\n')

  /* ------------------------------ 自检 ------------------------------ */
  const check = parseSourceDoc(next)
  if (check.issues.length > 0) {
    return { ok: false, error: `内部错误：重写后的标记不合法（${issuesText(check.issues)}），已放弃改动` }
  }
  if (check.blocks.length !== doc.blocks.length) {
    return {
      ok: false,
      error: `内部错误：重写后段落数从 ${doc.blocks.length} 变成 ${check.blocks.length}，已放弃改动`,
    }
  }
  for (let i = 0; i < doc.blocks.length; i++) {
    const before = doc.blocks[i]
    const after = check.blocks[i]
    if (before === undefined || after === undefined) break
    const same = before.text.replace(/\r\n?/g, '\n') === after.text.replace(/\r\n?/g, '\n')
    if (!same) return { ok: false, error: '内部错误：重写改动了段落正文，已放弃改动' }
    if (blockTierOf(after) !== desired(i)) {
      return { ok: false, error: '内部错误：重写后的档位与目标不一致，已放弃改动' }
    }
  }
  return { ok: true, text: next, changed: true }
}

/** 改**单块**档位（编辑器里的块档位控件走这条） */
export function setBlockTier(content: string, ordinal: number, tier: BlockVisibility): TierRewrite {
  return applyBlockTiers(content, new Map([[ordinal, tier]]))
}

/** 改**整个区段**（含该块所在的全部邻接同档块）的档位 */
export function setRegionTier(content: string, ordinal: number, tier: BlockVisibility): TierRewrite {
  const doc = parseSourceDoc(content)
  const region = regionOfBlock(doc, ordinal)
  if (region === null) return setBlockTier(content, ordinal, tier)
  return applyBlockTiers(content, new Map(region.blocks.map((o) => [o, tier])))
}
