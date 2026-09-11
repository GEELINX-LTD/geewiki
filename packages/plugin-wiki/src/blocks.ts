/**
 * `@geewiki/wiki` 的块模型：解析、tier 计算、**唯一的块写入路径**。
 *
 * 见 docs/design/access-control.md §4.1（作者格式）、§4.2（块身份与授权保留）、
 * §4.3（分层 FTS 与 tier）。
 *
 * ## 这一层要解决什么
 *
 * `pages.content` 是**作者源快照**（Markdown 原文，含 `<!--gated:*-->` 标记）；
 * `blocks` 是**解析出的结构化真源**。两者**同一事务双写**，并由一致性探针
 * （`GET /api/admin/blocks/verify`）比对"重新解析 pages.content 得到的块序列"与
 * 库里的 `blocks` 行。
 *
 * 为什么 `blocks` 不是可有可无的缓存：**块级授权必须钉在稳定的块身份上**，
 * 不能钉在一次解析结果上（§3.6）。
 *
 * ## 单一写入路径（§9 R12）
 *
 * 所有块写入都必须经 {@link syncBlocksForPage}。绕过它直接 `INSERT INTO blocks`
 * 会让 `blocks_fts` 与 `blocks` 漂移，而 **contentless FTS 表没有触发器兜底**
 * （tier 重算是业务逻辑，不是纯 SQL 能表达的，见 0002_blocks_fts.sql 的说明）。
 * 有源码级守卫测试钉住这一点。
 */

import { createHash } from 'node:crypto'

/** 块级可见性三档（§2.2）。**不含"仅编辑者"** —— 那一档在 v4 已被 `granted` 取代。 */
export type BlockVisibility = 'public' | 'org' | 'granted'

/** 块的语法类别。解析期判定，用于保守重解析时按 `kind` 序列对齐块身份。 */
export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'list'
  | 'list_item'
  | 'quote'
  | 'table'
  | 'html'
  | 'gated'

export interface ParsedBlock {
  ordinal: number
  kind: BlockKind
  /** 该块的 Markdown 源（**不含** gated 标记本身；标记是区段分隔符，不是内容） */
  text: string
  visibility: BlockVisibility
  inherit: boolean
  /** 来源标记原文（`'org'` / `'granted'`），`null` = 未标记。仅用于治理界面展示，**不参与判定**。 */
  marker: string | null
  /** sha256(text)：检测"文本变了但 ordinal 没变" */
  contentHash: string
}

/**
 * 检索用的密级等级。域严格是 `{0, 1}`；`null` 表示**该块不属于任何读者等级**
 * （`granted` 档，或页面本身没有任何等级能看）⇒ 只能靠授权分支命中（§4.3）。
 */
export type BlockTier = 0 | 1 | null

/** 解析失败。`code` 用作错误码（沿用仓库"消息前缀即错误码"的约定）。 */
export class BlockParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'BlockParseError'
  }
}

const OPEN_RE = /^<!--\s*gated\s*:\s*([^>]*?)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/gated\s*-->\s*$/
const KNOWN_MARKERS = new Set<string>(['org', 'granted'])
const FENCE_RE = /^\s*(```|~~~)/

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 解析 Markdown 为块序列（纯函数，无 IO）。
 *
 * **同一个函数被服务端写入路径与前端预览共用** —— 前端持镜像副本（见 §9 R3：
 * `packages/core` 不能进浏览器包），两侧一致性由源码级守卫测试钉住。
 *
 * 规则（§4.1 / §4.2）：
 * - 块边界 = 空行。**围栏代码块内部不切**（否则 ``` 之间的空行会把代码块切碎）。
 * - `<!--gated:org-->` … `<!--/gated-->` 圈定一个区段，区段内**每个块**都取其可见性。
 * - 标记本身**不属于任何块**（它是区段分隔符，不是内容）——这样公共视图渲染时不会
 *   因为块文本里含标记而泄露"这里有个受限区段"。
 * - **旧标记 `role=*` 以及旧档位 `private` 必须显式拒绝**，不能静默忽略：
 *   静默忽略会让作者以为收紧了，实际内容按 `public` 暴露（§4.1 的 v4 说明）。
 */
export function parseBlocks(content: string): ParsedBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const out: ParsedBlock[] = []

  let region: { visibility: BlockVisibility; marker: string } | null = null
  let buf: string[] = []
  let bufRegion: { visibility: BlockVisibility; marker: string } | null = null
  let inFence = false

  const flush = (): void => {
    if (buf.length === 0) return
    const text = buf.join('\n')
    // 纯空白不构成块（作者多敲几个空行不该产生块）
    if (text.trim() !== '') {
      out.push({
        ordinal: out.length,
        kind: inFence ? 'code' : kindOf(text),
        text,
        visibility: bufRegion ? bufRegion.visibility : 'public',
        inherit: true,
        marker: bufRegion ? bufRegion.marker : null,
        contentHash: sha256Hex(text),
      })
    }
    buf = []
    bufRegion = null
  }

  for (const line of lines) {
    const open = OPEN_RE.exec(line)
    if (open) {
      if (inFence) {
        buf.push(line)
        continue
      }
      flush()
      if (region) {
        throw new BlockParseError('gated_nested', '不允许嵌套的 gated 区段（先闭合上一个 <!--/gated-->）')
      }
      const spec = (open[1] ?? '').trim()
      /*
       * ★ 旧标记的显式拒绝（§4.1）。
       *   v2/v3 的语法是 `<!--gated:role=editor-->` ⇒ `visibility='private'`，
       *   v4 已把该语法与语义一并废弃。**必须报错而不是忽略**：老文档里若留着它，
       *   静默忽略 = 作者以为收紧了、实际按 public 暴露。
       */
      if (/^role\s*[=:]/i.test(spec) || spec === 'private') {
        throw new BlockParseError(
          'gated_marker_removed',
          `已废弃的 gated 标记 "${spec}"：v4 起改用 <!--gated:org--> 或 <!--gated:granted-->` +
            '（原 role=* 语义已删除，不会按"仅编辑者"处理）',
        )
      }
      if (!KNOWN_MARKERS.has(spec)) {
        throw new BlockParseError(
          'gated_marker_unknown',
          `不认识的 gated 标记 "${spec}"：只接受 org 与 granted`,
        )
      }
      region = { visibility: spec as BlockVisibility, marker: spec }
      continue
    }

    if (CLOSE_RE.test(line) && !inFence) {
      flush()
      if (!region) {
        throw new BlockParseError('gated_close_without_open', '出现 <!--/gated--> 但没有对应的 <!--gated:…-->')
      }
      region = null
      continue
    }

    if (FENCE_RE.test(line)) {
      // 围栏的开/闭行本身属于代码块
      if (buf.length === 0) bufRegion = region
      buf.push(line)
      inFence = !inFence
      continue
    }

    if (!inFence && line.trim() === '') {
      flush()
      continue
    }

    if (buf.length === 0) bufRegion = region
    buf.push(line)
  }

  if (inFence) throw new BlockParseError('code_fence_unclosed', '代码围栏没有闭合（缺少结尾的 ```）')
  flush()
  if (region) {
    throw new BlockParseError('gated_unclosed', 'gated 区段没有闭合（缺少 <!--/gated-->）')
  }
  return out
}

/** 按首个非空行的形态判定块类别。仅用于保守重解析的 `kind` 对齐，不参与渲染。 */
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
 * 页面有效档位 —— **与主体无关**（索引是全体共用的，不能按人算）。
 * `0` = 有效公开、`1` = 有效组织内、`null` = 没有任何等级能看。
 */
export type PageLevel = 0 | 1 | null

/** 单块自身要求的等级；`granted` 不属于任何等级。 */
export function blockLevelOf(visibility: BlockVisibility): BlockTier {
  if (visibility === 'granted') return null
  return visibility === 'public' ? 0 : 1
}

/**
 * 计算写入 `blocks.tier` 的检索等级。
 *
 * ## 为什么这里是 `max` 而不是文档写的 `min`
 *
 * §2.3 的规则 B1 写的是 `effectiveBlockTier = min(block.visibility, pageEffectiveRank)`，
 * 那句话里的 `visibility` / `rank` 是**宽松度**刻度（越大越宽松），所以"取更严的一方"
 * 表现为 `min`。而 `tier` 这一列的语义是**限制等级**（`b.tier <= :readerTier`，
 * 越小越公开），刻度方向相反 ⇒ 同一个语义在这里是 **`max`**：
 *
 * - 页面 public(0) + 块 public(0) ⇒ 0（匿名可搜到）
 * - 页面 public(0) + 块 org(1)    ⇒ 1（仅组织成员）
 * - 页面 org(1)    + 块 public(0) ⇒ 1（页面本身就把匿名挡住了）
 * - 任一侧无等级（`null`）        ⇒ `null`（等级分支永不命中，只能靠授权分支）
 *
 * 这不是两种规则，**是同一条"只能更窄"的两种刻度**。写反方向会让"页面 org + 块 public"
 * 的块拿到 tier 0 ⇒ 匿名在搜索里找得到它 ⇒ **泄漏**。
 */
export function tierFor(pageLevel: PageLevel, blockVisibility: BlockVisibility): BlockTier {
  const bl = blockLevelOf(blockVisibility)
  if (pageLevel === null || bl === null) return null
  return (pageLevel > bl ? pageLevel : bl) as BlockTier
}

/**
 * ★ **唯一的块与块索引写入路径**（§9 R12）。
 *
 * 做四件事，全部在**调用方的事务里**（`tx` 必须传进来 —— 用适配器自身方法会让事务
 * 静默失效，见 core 的注释）：
 *   1. 删掉该页的旧块
 *   2. 按解析结果插入新块（含 `tier`）
 *   3. 删掉该页在 `blocks_fts` 里的旧行、再逐块写入
 *   4. `pages.content_hash` 由调用方一并更新（本函数只管块与索引）
 *
 * **为什么块索引要在这里手工维护**：`blocks_fts` 是 contentless 表，且写进去之前要算
 * `tier` —— 那依赖页面的**有效档位**（含祖先交集与发布闸门），是 `policy-service` 的
 * 业务逻辑，**不是触发器能表达的 SQL**。代价是同步保证从"数据库触发器"变成了"应用层
 * 纪律"，所以有 `GET /api/admin/search/verify` 这条一致性探针兜底。
 */
export async function syncBlocksForPage(
  tx: BlockWriter,
  args: {
    pageId: number
    content: string
    /** 页面有效档位（由调用方从 policy-service 取；取不到时传 `null` = 失败关闭） */
    pageLevel: PageLevel
    now: string
    /** 注入以便测试；默认用 {@link parseBlocks} */
    parse?: (content: string) => ParsedBlock[]
  },
): Promise<ParsedBlock[]> {
  const { pageId, content, pageLevel, now } = args
  const parse = args.parse ?? parseBlocks
  const parsed = parse(content)

  /*
   * ★ 顺序不能换：**先清索引、再删块行**。
   *
   * `blocks_fts` 按 `rowid = blocks.id` 对齐，清它靠的是
   * `rowid IN (SELECT id FROM blocks WHERE page_id = ?)` —— 这条子查询必须在
   * `blocks` 行**还在**的时候执行。反过来先删 blocks，子查询就永远返回空集，
   * 旧文本会**静默留在 contentless 索引里**成为孤儿（检索查询 JOIN blocks 所以不会
   * 产出命中，但正文还在索引文件里，且 verify 探针的 `extra` 会非零）。
   */
  /*
   * ★ P3a：`blocks_fts` 由 **`@geewiki/search` 的迁移**建立，而**搜索是可选插件** ——
   * 没装它时这张表根本不存在。块写入**不能**因此失败：那会让"保存一个页面"依赖
   * "装了检索插件"，是荒谬的耦合（server 的路由用例正是这么把它暴露出来的：
   * 保存返 500 `no such table: blocks_fts`）。
   *
   * 故索引同步是**尽力而为**：表在就同步，不在就跳过并**告警一次**。
   * 这只影响检索召回，不影响正确性 —— `blocks` 与 `pages.content` 才是真源，
   * 索引任何时候都能从 `blocks` 重建，差异由 `GET /api/admin/search/verify` 显式报出。
   */
  let indexEnabled = true
  try {
    await tx.run('DELETE FROM blocks_fts WHERE rowid IN (SELECT id FROM blocks WHERE page_id = ?)', [pageId])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 只吞"表不存在"这一种；其它错误照抛（别把真故障伪装成"搜索没装"）
    if (!/no such table: blocks_fts/.test(msg)) throw err
    indexEnabled = false
    warnBlocksIndexMissingOnce()
  }
  await tx.run('DELETE FROM blocks WHERE page_id = ?', [pageId])

  for (const b of parsed) {
    const res = await tx.run(
      `INSERT INTO blocks (page_id, ordinal, kind, text, visibility, inherit, marker, content_hash, created_at, updated_at, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pageId,
        b.ordinal,
        b.kind,
        b.text,
        b.visibility,
        b.inherit ? 1 : 0,
        b.marker,
        b.contentHash,
        now,
        now,
        tierFor(pageLevel, b.visibility),
      ],
    )
    const blockId = Number(res.lastInsertRowid)
    if (!Number.isFinite(blockId) || blockId <= 0) {
      throw new Error('blocks_writer_no_rowid: 插入块后拿不到 rowid，无法对齐 blocks_fts')
    }
    if (indexEnabled) await tx.run('INSERT INTO blocks_fts (rowid, text) VALUES (?, ?)', [blockId, b.text])
  }
  return parsed
}

/* ------------------------------ 服务端正文投影 ------------------------------ */

/**
 * 读者等级 —— 与 {@link BlockTier} **同刻度**（`0` = 匿名读者，`1` = 组织成员）。
 *
 * 与 `BlockTier` 的区别只是语义方向：那个描述"这个块要求谁"，这个描述"你是哪一档"。
 * 两者**必须同刻度**，否则 `<=` 比较会静默反向（把"更严"读成"更宽松"）。
 */
export type ReaderTier = 0 | 1

/** 投影的输入：块的最小形状（`ParsedBlock` 与 `blocks` 表的行都满足）。 */
export interface ProjectableBlock {
  ordinal: number
  text: string
  visibility: BlockVisibility
}

export interface ProjectedContent {
  /** 该读者可见的正文；受限块被替换为**显式占位**（不是删掉，也不是留下原文） */
  text: string
  /** 被裁剪掉的块数。**仅计数**，不含任何内容、标题或字数 */
  gatedCount: number
}

/**
 * ★ P3a 的**服务端正文投影**：把块序列按读者等级拼回 Markdown。
 *
 * ## 为什么必须在服务端做（§2.4 约束 1、§5）
 *
 * 数据一旦进入响应体，"前端隐藏"就只是装饰 —— DevTools、`curl`、SSR 载荷、CDN 缓存、
 * 访问日志任一条路都能拿到原文。所以受限块的 `text` 必须**在序列化之前就不存在**，
 * 客户端拿到的只有占位。这是"服务端裁剪"与"前端隐藏"的分界，也是本函数的全部意义。
 *
 * ## 与检索的关系
 *
 * `blocks.tier` 那一列管"**搜不搜得到**"，本函数管"**读不读得到**"。两者必须用同一条
 * 判据（{@link blockLevelOf}）—— 否则会出现"搜不到但读得到"（读路径漏过滤）或
 * "读得到但搜不到"（索引算错），前者是泄漏、后者是体验缺陷。
 *
 * ## 判据只看块自身的 `visibility`
 *
 * 页面级可见性由 `policy-service.resolvePage` 在此之前判定完毕（`level === 'none'`
 * 早已 404）。所以到这里只需问"**这个块**对**这个读者**是否可见"。
 * `granted` 档的 `blockLevelOf` 返回 `null` ⇒ 等级分支**永不命中**，只能靠授权分支
 * （`block_grants`，属 P3b）。P3a 阶段还没有授权表，故 `granted` 块对所有人不可见 ——
 * 这是**失败关闭**，方向正确（宁可少给，不可多给）。
 */
export function projectBlocks(
  blocks: readonly ProjectableBlock[],
  reader: { tier: ReaderTier; anonymous: boolean },
): ProjectedContent {
  const out: string[] = []
  let gatedRun = 0
  let gatedCount = 0

  /*
   * 连续受限块**合并成一个占位**。
   *
   * 为什么不是每块一个：那样"这里有 5 段受限内容"会渲染成 5 行重复文案，噪音大；
   * 更要紧的是**行数会随作者的分段方式变化**，而分段方式是结构信息 —— 占位不该泄露它。
   * 合并之后，占位只泄露"这里有一段（若干块）受限内容"这一个事实。
   */
  const flushGated = (): void => {
    if (gatedRun === 0) return
    // 措辞按**读者**而非**内容**选择：匿名读者给可行动的"需登录"，
    // 已登录读者给"需更高权限"。这样既不泄露受限内容的档位（org 还是 granted），
    // 又让匿名访客知道该做什么。
    const suffix = reader.anonymous ? '需登录查看' : '需更高权限查看'
    out.push(`> 🔒 此处有 ${gatedRun} 段内容${suffix}`)
    gatedRun = 0
  }

  for (const b of blocks) {
    const level = blockLevelOf(b.visibility)
    if (level !== null && level <= reader.tier) {
      flushGated()
      out.push(b.text)
    } else {
      gatedRun += 1
      gatedCount += 1
    }
  }
  flushGated()

  return { text: out.join('\n\n'), gatedCount }
}

/** 本模块需要的执行器形状（`DatabaseExecutor` 的结构子集，便于测试替身）。 */
export interface BlockWriter {
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>
}

/**
 * ★ P3a：`blocks_fts` 缺席时**只告警一次**。
 *
 * 为什么是"一次"：这条路径在每次保存时都会走。逐次打印会把日志淹掉，而这件事
 * 本身不是错误（搜索是可选插件），只是"检索索引未启用"的运维事实。
 */
let warnedMissingBlocksIndex = false
function warnBlocksIndexMissingOnce(): void {
  if (warnedMissingBlocksIndex) return
  warnedMissingBlocksIndex = true
  console.warn(
    '[@geewiki/wiki] 未找到 blocks_fts（@geewiki/search 未安装或未激活）⇒ 跳过块索引同步。' +
      '块与页面正文照常写入，检索索引可在装上搜索插件后从 blocks 重建。',
  )
}
