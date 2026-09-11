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
 * 库里已有的块 —— **保守重解析的输入**。
 *
 * `grantCount` 决定这个块"能不能被删/能不能参与合并"：有授权的块一旦被静默删除，
 * 授权会被外键 CASCADE 一起清掉，而用户看不到任何提示（§4.2 的"审计断裂"）。
 */
export interface ExistingBlock {
  id: number
  ordinal: number
  kind: string
  contentHash: string
  visibility: string
  /** 该块上的 `block_grants` 行数（0 = 没有授权） */
  grantCount: number
}

/** 保守重解析的冲突。`code` 用作错误码（沿用"消息前缀即错误码"的约定），路由映射成 409 */
export class BlockSyncError extends Error {
  constructor(
    readonly code: 'block_merge_conflict' | 'block_grant_orphan',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'BlockSyncError'
  }
}

/**
 * 读该页已有块 + 每块的授权计数。
 *
 * 授权计数**一次查回**（`GROUP BY`），不逐块查 —— 一页几十块时逐块查会变成几十次往返。
 * 计数只用于**决策**（能不能删/能不能合并），不参与任何内容判断，因此把数字带出来
 * 不构成泄漏面。
 */
export async function readExistingBlocks(
  db: { query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> },
  pageId: number,
): Promise<ExistingBlock[]> {
  const rows = await db.query<{
    id: number
    ordinal: number
    kind: string
    content_hash: string
    visibility: string
  }>('SELECT id, ordinal, kind, content_hash, visibility FROM blocks WHERE page_id = ? ORDER BY ordinal', [pageId])
  if (rows.length === 0) return []
  const grants = await db.query<{ block_id: number; n: number }>(
    `SELECT g.block_id AS block_id, COUNT(*) AS n
       FROM block_grants g JOIN blocks b ON b.id = g.block_id
      WHERE b.page_id = ?
      GROUP BY g.block_id`,
    [pageId],
  )
  const countById = new Map<number, number>()
  for (const g of grants) countById.set(Number(g.block_id), Number(g.n))
  return rows.map((r) => ({
    id: Number(r.id),
    ordinal: Number(r.ordinal),
    kind: r.kind,
    contentHash: r.content_hash,
    visibility: r.visibility,
    grantCount: countById.get(Number(r.id)) ?? 0,
  }))
}

/** 一个同步计划：新块各自复用哪个旧 id（`null` = 新插入）、要删哪些旧块、要从谁复制授权 */
interface SyncPlan {
  reuse: Array<number | null>
  toDelete: number[]
  copyGrantsFrom: Array<{ from: number; toIndexes: number[] }>
}

/** 最长公共子序列（按 `kind + contentHash` 匹配）—— 用来找出"原样保留"的块 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

/**
 * 保守重解析（§4.2）。
 *
 * **问题**：块的身份若只用 `ordinal`，在文档开头插一段就会让所有 ordinal 后移 ⇒
 * 所有块级授权指向错误的块。这种"静默错配"比丢失更危险。
 *
 * **解法**：先用 `(kind, contentHash)` 做最长公共子序列，把**原样保留**的块钉住；
 * 剩下的"缺口"（连续未匹配的旧块段与新块段）按下面的规则成对：
 *
 * | 缺口形状 | 处理 |
 * |---|---|
 * | 旧 0 个 | 全部新插入 |
 * | 新 0 个 | 全部删除；**其中有任一有授权 ⇒ 409 `block_grant_orphan`** |
 * | 等长 | 按位置成对（即"纯文本编辑"，保留块 id） |
 * | 旧 1 → 新 k>1 | **拆分**：首块复用旧 id，其余新插入，**并把旧块授权复制给它们**（安全方向） |
 * | 旧 m>1 → 新 1 | **合并**：任一旧块有授权、或旧块之间可见性不同 ⇒ 409 `block_merge_conflict` |
 * | 其它 | 无法可靠对齐 ⇒ 有授权则 409 `block_grant_orphan`，否则全删全插 |
 *
 * **等长缺口的成对为什么允许 `kind` 变化**：`kind` 相同才配对是设计文档的判据，
 * 但严格照做会让"把一个段落改成标题"无法保存。等长成对意味着**块的数量与顺序都没变**，
 * 这已是"纯文本编辑"的强特征。**但有一条例外**：若旧块**有授权**，则要求 `kind` 必须
 * 相同 —— 授权在身时宁可让用户多确认一次，也不接受"授权被安到一段语义不同的内容上"。
 *
 * 所有拒绝都发生在**任何写入之前**（调用方拿到异常时库还没被改），
 * 这正是"授权丢失与授权误施都要显式化"的落点。
 */
export function planBlockSync(
  olds: readonly ExistingBlock[],
  news: readonly ParsedBlock[],
  opts: { restructure?: boolean } = {},
): SyncPlan {
  /*
   * ★ `restructure`：**仅"恢复版本"路径使用**（P3c）。
   *
   * 为什么需要它：下面的三道守卫是为**编辑**事故设计的 —— 用户改了一段正文，
   * 而我们无法可靠地把旧块与新块对上时，宁可拒绝保存，也不接受"授权被安到
   * 语义不同的内容上"或"授权被静默清掉"。但**恢复版本**是另一回事：
   * 用户显式要求回到那个状态，其中包括它当时的**块结构**；而块级授权会由
   * 快照整体重建（不是"丢了"，是"被替换成那一刻的样子"）。
   * 于是三道守卫在恢复路径上都不适用 —— 若仍然拦截，**恢复旧版本会被永久拒绝**。
   *
   * 注意它只影响"能不能改块结构"，不影响可见性判定的任何地方。
   */
  const restructure = opts.restructure === true
  const plan: SyncPlan = { reuse: new Array<number | null>(news.length).fill(null), toDelete: [], copyGrantsFrom: [] }
  const keyOf = (kind: string, hash: string): string => `${kind}\u0000${hash}`
  const pairs = lcsPairs(
    olds.map((o) => keyOf(o.kind, o.contentHash)),
    news.map((n) => keyOf(n.kind, n.contentHash)),
  )

  /** 处理一段缺口：`oldFrom..oldTo`（不含）与 `newIdxs`（升序、不含） */
  const pairGap = (oldFrom: number, oldTo: number, newIdxs: readonly number[]): void => {
    const gapOlds = olds.slice(oldFrom, oldTo)
    const k = gapOlds.length
    const q = newIdxs.length
    const grantedOlds = gapOlds.filter((o) => o.grantCount > 0)

    if (k === 0) return // 全是新插入，reuse 保持 null
    if (q === 0) {
      if (grantedOlds.length > 0 && !restructure) {
        throw new BlockSyncError(
          'block_grant_orphan',
          `不能删除已有块级授权的块（ordinal ${grantedOlds.map((o) => o.ordinal).join(', ')}）—— ` +
            '请先撤销这些块的授权，再删除它们。静默删除会连授权一起清掉，且不留痕迹。',
        )
      }
      for (const o of gapOlds) plan.toDelete.push(o.id)
      return
    }
    if (k === q) {
      // 等长 ⇒ 纯文本编辑，按位置成对
      for (let t = 0; t < k; t += 1) {
        const o = gapOlds[t] as ExistingBlock
        const nIdx = newIdxs[t] as number
        const n = news[nIdx] as ParsedBlock
        if (o.grantCount > 0 && o.kind !== n.kind && !restructure) {
          throw new BlockSyncError(
            'block_grant_orphan',
            `已授权的块（ordinal ${o.ordinal}）被改成了另一种块类型（${o.kind} → ${n.kind}）；` +
              '无法确认它仍是同一个块，因此拒绝保存。请先撤销该块的授权再改。',
          )
        }
        plan.reuse[nIdx] = o.id
      }
      return
    }
    if (k === 1 && q > 1) {
      // 拆分：授权向两块扩散（安全方向）
      const o = gapOlds[0] as ExistingBlock
      plan.reuse[newIdxs[0] as number] = o.id
      if (o.grantCount > 0) {
        plan.copyGrantsFrom.push({ from: o.id, toIndexes: newIdxs.slice(1) })
      }
      return
    }
    if (k > 1 && q === 1) {
      // 合并
      const vis = new Set(gapOlds.map((o) => o.visibility))
      if (!restructure && (grantedOlds.length > 0 || vis.size > 1)) {
        throw new BlockSyncError(
          'block_merge_conflict',
          `不能把 ${k} 个块合并成一个：` +
            (grantedOlds.length > 0
              ? `其中 ordinal ${grantedOlds.map((o) => o.ordinal).join(', ')} 有块级授权，`
              : '') +
            (vis.size > 1 ? `它们的可见性不同（${[...vis].join(' / ')}），` : '') +
            '合并会静默丢掉授权或改写可见性。请先撤销授权 / 统一可见性，再合并。',
        )
      }
      plan.reuse[newIdxs[0] as number] = gapOlds[0]!.id
      for (let t = 1; t < k; t += 1) plan.toDelete.push((gapOlds[t] as ExistingBlock).id)
      return
    }
    // 形状无法可靠对齐
    if (grantedOlds.length > 0 && !restructure) {
      throw new BlockSyncError(
        'block_grant_orphan',
        `这次的改动让 ${k} 个旧块变成了 ${q} 个新块，无法确认哪一块对应哪一块，` +
          `而其中 ordinal ${grantedOlds.map((o) => o.ordinal).join(', ')} 有块级授权。` +
          '为避免授权被安到错误的内容上，拒绝保存。请先撤销这些块的授权。',
      )
    }
    for (const o of gapOlds) plan.toDelete.push(o.id)
  }

  let prevOld = -1
  let prevNew = -1
  for (const [oi, ni] of pairs) {
    pairGap(prevOld + 1, oi, rangeOf(prevNew + 1, ni))
    plan.reuse[ni] = (olds[oi] as ExistingBlock).id
    prevOld = oi
    prevNew = ni
  }
  pairGap(prevOld + 1, olds.length, rangeOf(prevNew + 1, news.length))
  return plan
}

function rangeOf(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i < to; i += 1) out.push(i)
  return out
}

/**
 * ★ **唯一的块与块索引写入路径**（§9 R12）。
 *
 * 做五件事，全部在**调用方的事务里**（`tx` 必须传进来 —— 用适配器自身方法会让事务
 * 静默失效，见 core 的注释）：
 *   1. 删掉该页在 `blocks_fts` 里的旧行
 *   2. **保守重解析**（`planBlockSync`）—— 决定哪些块复用旧 id、哪些删除、哪些新插
 *   3. 复用旧 id 的块走 `UPDATE`，其余走 `INSERT`
 *   4. 拆分母块的授权复制给新同胞块
 *   5. 逐块重建 `blocks_fts`
 *
 * ⚠️ **为什么不能再用"删光重建"**（P3a 的写法）：`block_grants.block_id` 是
 * `ON DELETE CASCADE`，删光重建会让块 id 全变、**授权被静默清空**。这是 P3b 必须
 * 改掉它的唯一原因，也是"块身份必须稳定"这条设计要求的落地处（§4.2）。
 */
export async function syncBlocksForPage(
  tx: BlockWriter,
  args: {
    pageId: number
    content: string
    /** 页面有效档位（由调用方从 policy-service 取；取不到时传 `null` = 失败关闭） */
    pageLevel: PageLevel
    now: string
    /**
     * 该页**已有**的块（含授权计数）。**必填** —— 它是保守重解析的输入，
     * 省略就等于"我不知道有没有授权"，那只能退化成删光重建 ⇒ 静默丢授权。
     * 所以这里是强制参数，而不是"可选 + 默认空数组"。
     */
    existing: readonly ExistingBlock[]
    /** 注入以便测试；默认用 {@link parseBlocks} */
    parse?: (content: string) => ParsedBlock[]
    /**
     * 是否同步 `blocks_fts`。**必填，由调用方按方言显式传入**（本仓惯例是传
     * `blocksIndexSupported = db.dialect === 'sqlite'`）。
     *
     * ⚠️ **刻意不给默认值**：它原先默认 `true`，于是"新增调用点时忘了传"会在 PostgreSQL 上
     * 让**整个写块事务失败**（`blocks_fts` 在那边永远不存在）—— 一个只在某一种方言上炸、
     * 且炸在事务里的默认值，是最难排查的那类缺陷。改成必填后，漏传在**编译期**就报错。
     *
     * ★ **PostgreSQL 下必须传 `false`**，理由不是"省一步"，而是**不能靠捕获异常来跳过**：
     *
     *   1. `blocks_fts` 是 FTS5 表，由 `@geewiki/search` 的**SQLite 专有**迁移建立
     *      （设计文档 §4.3 ★v7）⇒ PG 上它**永远不存在**；
     *   2. PG 的错误文案是 `relation "blocks_fts" does not exist`，与 SQLite 的
     *      `no such table: blocks_fts` **不同** —— 只匹配后者会让错误被重新抛出，
     *      于是一次 `DELETE` 失败就毁掉整个写块事务（**实测：PG 下 `blocks` 恒为 0 条，
     *      整个块模型不可用**）；
     *   3. 就算把两种文案都匹配上，**PG 也不行**：任一语句报错后事务进入 aborted 状态，
     *      后续语句一律失败 ⇒ "捕获后继续"这条路径在 PG 上根本不成立。
     *
     * 所以判据必须**在事务之外按方言得出**（调用方从适配器拿 `dialect`），而不是试错。
     * 该标志只影响**检索召回**：`blocks` 与 `pages.content` 才是真源，索引随时可从
     * `blocks` 重建（PG 下本就没有索引，检索功能整体不提供 —— 由 §4.3 的方言守卫显式拒绝）。
     */
    // ★ 必填（P3a 修复轮定的）：默认值会让"新增调用点忘了传"只在 PostgreSQL 上、
    //   且在事务内部炸（`blocks_fts` 在那边永远不存在）—— 这是最难排查的一类缺陷。
    //   漏传现在会在**编译期**报错。（P3c 分支上原为 `syncIndex?: boolean`，是 P3a 修复
    //   之前的旧形态；rebase 时按语义合并为必填，**未回退** P3a 的意图。）
    syncIndex: boolean
    /**
     * ★ **仅"恢复版本"路径使用**（P3c）：允许本次同步改变**块结构**
     * （合并块、删除已有授权的块）。编辑路径**绝不要**传它 ——
     * `planBlockSync` 里那三道守卫正是用来防编辑事故的。
     */
    restructure?: boolean
  },
): Promise<ParsedBlock[]> {
  const { pageId, content, pageLevel, now, existing } = args
  const parse = args.parse ?? parseBlocks
  const parsed = parse(content)
  /*
   * **先算计划再动任何一行。** 计划阶段可能抛 `BlockSyncError`（合并/删除已授权块），
   * 此时库里还没有任何改动 —— 调用方拿到 409 时数据是干净的。
   */
  const plan = planBlockSync(existing, parsed, { restructure: args.restructure === true })

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
   * ★ `blocks_fts` 由 **`@geewiki/search` 的迁移**建立，而**搜索是可选插件** ——
   * 没装它时这张表根本不存在。块写入**不能**因此失败：那会让"保存一个页面"依赖
   * "装了检索插件"，是荒谬的耦合（server 的路由用例正是这么把它暴露出来的：
   * 保存返 500 `no such table: blocks_fts`）。
   *
   * 故索引同步是**尽力而为**：表在就同步，不在就跳过并**告警一次**。
   * 这只影响检索召回，不影响正确性 —— `blocks` 与 `pages.content` 才是真源，
   * 索引任何时候都能从 `blocks` 重建，差异由 `GET /api/admin/search/verify` 显式报出。
   */
  let indexEnabled = args.syncIndex
  if (indexEnabled) {
    try {
      await tx.run('DELETE FROM blocks_fts WHERE rowid IN (SELECT id FROM blocks WHERE page_id = ?)', [pageId])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 只吞"表不存在"这一种；其它错误照抛（别把真故障伪装成"搜索没装"）。
      // 注意这条路径**只对 SQLite 有意义**：PG 下 `syncIndex` 应为 false，
      // 因为那边的事务一旦报错就 aborted，"捕获后继续"不成立（见参数说明）。
      if (!/no such table:\s*blocks_fts/i.test(msg)) throw err
      indexEnabled = false
      warnBlocksIndexMissingOnce()
    }
  }

  /** 最终块的 id 与文本，供最后重建索引 */
  const finals: Array<{ id: number; text: string }> = []
  const newIds: Array<number | null> = new Array<number | null>(parsed.length).fill(null)

  for (let i = 0; i < parsed.length; i += 1) {
    const b = parsed[i] as ParsedBlock
    const reuseId = plan.reuse[i] ?? null
    if (reuseId !== null) {
      /*
       * **复用旧 id** —— 这一行是"块身份稳定"的落点：`block_grants.block_id` 不变，
       * 授权因此跨编辑存活。`tier` 一并重算（页面档位可能变了）。
       */
      await tx.run(
        `UPDATE blocks
            SET ordinal = ?, kind = ?, text = ?, visibility = ?, inherit = ?, marker = ?,
                content_hash = ?, updated_at = ?, tier = ?
          WHERE id = ?`,
        [
          b.ordinal,
          b.kind,
          b.text,
          b.visibility,
          b.inherit ? 1 : 0,
          b.marker,
          b.contentHash,
          now,
          tierFor(pageLevel, b.visibility),
          reuseId,
        ],
      )
      newIds[i] = reuseId
      finals.push({ id: reuseId, text: b.text })
      continue
    }
    const res = await tx.run(
      /*
       * ★ `RETURNING id` 不是可选的：SQLite 有隐式 rowid，**PostgreSQL 没有** ——
       * PG 适配器的 `lastInsertRowid` 只在 SQL 里写了 `RETURNING id` 时才非 0，
       * 否则恒为 0（见 `packages/db-postgres/src/index.ts:237-238` 的注释）。
       * 少了它，块会以 `page_id = 0` 插入 ⇒ 外键直接报
       * `insert or update on table "blocks" violates foreign key constraint "blocks_page_id_fkey"`
       * ⇒ **PG 上每一个新建/保存页面的请求都 500**（实测如此）。
       * 本仓既有插件（plugin-auth / plugin-org）都遵守这条约定。
       */
      `INSERT INTO blocks (page_id, ordinal, kind, text, visibility, inherit, marker, content_hash, created_at, updated_at, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
    newIds[i] = blockId
    finals.push({ id: blockId, text: b.text })
  }

  /*
   * 拆分产生的同胞块**继承母块的授权**（§4.2 的"安全方向"）。
   * 放在插入之后：那时新块 id 才存在。`page_slug` 从母块行原样带过来。
   */
  for (const copy of plan.copyGrantsFrom) {
    for (const idx of copy.toIndexes) {
      const target = newIds[idx]
      if (target === null || target === undefined) continue
      await tx.run(
        `INSERT INTO block_grants (block_id, page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
         SELECT ?, page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at
           FROM block_grants WHERE block_id = ?`,
        [target, copy.from],
      )
    }
  }

  /* 删除未保留的旧块（授权检查已在计划阶段做过，走到这里说明它们都没有授权） */
  for (const id of plan.toDelete) await tx.run('DELETE FROM blocks WHERE id = ?', [id])

  if (indexEnabled) {
    for (const f of finals) await tx.run('INSERT INTO blocks_fts (rowid, text) VALUES (?, ?)', [f.id, f.text])
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
  /**
   * 块 id。**只有来自 `blocks` 表的行才有** —— 现场解析 `pages.content` 得到的结果
   * （P3a 之前保存的历史页面）没有 id，因而**不可能**命中授权分支。
   *
   * 这是刻意的：授权钉在稳定块身份上（§4.2），而"现场解析"的 ordinal 会随编辑漂移，
   * 拿它去对授权就是拿一个不稳定的键去查权限表。宁可少给（无 id ⇒ 只能走等级分支），
   * 不可多给。
   */
  id?: number
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
 * ## 判据只看块自身的 `visibility` + 该主体的块级授予
 *
 * 页面级可见性由 `policy-service.resolvePage` 在此之前判定完毕（`level === 'none'`
 * 早已 404）。所以到这里只需问"**这个块**对**这个读者**是否可见"，两条分支：
 *
 * - **等级分支**：`blockLevelOf(visibility) <= reader.tier` —— 块要求的等级，读者够得着。
 * - **授权分支**（★ P3b）：该块的 id 在 `grantedBlockIds` 里 —— **放宽方向**。
 *   被显式授予的块对**任何**足额主体可见（匿名不可能有授予，`policy-service` 对匿名
 *   直接返回空集）。`granted` 档的块 `blockLevelOf` 返回 `null` ⇒ 等级分支永不命中，
 *   **只能**靠授权分支放行 —— 这是它存在的全部意义。
 *
 * 两条分支**必须用同一条判据**（{@link blockLevelOf}）与同一份授权集合，否则会出现
 * "搜得到但读不到"或"读得到但搜不到"；后者（读得到但搜不到）只是体验缺陷，
 * **前者（搜得到但读不到）是泄漏**。
 */
export function projectBlocks(
  blocks: readonly ProjectableBlock[],
  reader: { tier: ReaderTier; anonymous: boolean; grantedBlockIds?: readonly number[] },
): ProjectedContent {
  const out: string[] = []
  let gatedRun = 0
  let gatedCount = 0
  /*
   * 集合化一次，避免逐块 `includes` 退化成 O(块数 × 授权数)。
   * 空集合走 `null` 分支：省掉每块的 Set 查询，也让"没有授权"这条最常见路径零开销。
   */
  const granted =
    reader.grantedBlockIds !== undefined && reader.grantedBlockIds.length > 0
      ? new Set(reader.grantedBlockIds)
      : null

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
    const byTier = level !== null && level <= reader.tier
    const byGrant = granted !== null && b.id !== undefined && granted.has(b.id)
    if (byTier || byGrant) {
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

/** 只读侧的最小形状（`readExistingBlocks` 的入参；事务执行器与适配器都满足） */
export interface BlockReader {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
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
