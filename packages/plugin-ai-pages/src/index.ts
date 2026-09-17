/**
 * `@geewiki/ai-pages` —— AI 的**页面写工具**（P4 起步，决策 2 的"页面管理"档）。
 *
 * ## 为什么这个包必须存在，而不是把写工具塞进 `ai-kb`
 * `ai-kb` 的文件头写着它的三条工具**全是只读**，"故不受 mutation journal 与自锁护栏约束"。
 * 往那里加一条写工具会让那句注释当场变成谎话，而这类"注释与代码不一致"正是本仓
 * 反复记档的坑（`packages/plugin-ai-tools/src/index.ts` 与 `slot-plugin.ts` 的注释互相矛盾）。
 * 读与写对"能不能回退""要不要记日志"的要求本来就不同，用两个包把它们分开是诚实的。
 *
 * ## 写工具的三条硬纪律
 * 1. **必须记日志**（决策 3）：所以 `requires` 里有 `ai-journal-service`。
 *    日志缺席时不注册这条工具——一条不能被回退的写操作，是"AI 可以随便改你的东西"。
 * 2. **必须自己判权限**。这是本包最关键、也最容易写错的一点，见下。
 * 3. **必须报出"改之前是什么"**：`before` 是回退的全部依据，拿不到它就不能改。
 *
 * ## ⚠️ 权限：`wiki-service.save()` **没有 principal 参数**
 * `WikiService` 的四个读方法都显式要求主体（P2 的刻意设计），但 `save(slug, input)`
 * 不带主体——授权发生在 HTTP 处理器里（`packages/plugin-wiki/src/index.ts:4082`
 * 用 `policy-service` 的 `access.canEdit` 判定）。
 *
 * 于是**直接调 `save()` 等于绕过整个权限体系**。本包的做法是：改之前先向
 * `policy-service` 要一次 `resolvePage(principal, slug).canEdit` —— 注意这不是
 * "又写了一份判据"，`policy-service` 就是那份判据的**唯一出口**，HTTP 路径用的是同一个它。
 * 本包之所以必须 `requires: ['policy-service']`，就是为了让"拿不到判据"变成启动失败，
 * 而不是一次静默的无授权写入。
 *
 * **仍存在的结构性风险（记档，未修）**：判据与写入是两个先后调用，中间存在竞态窗口
 * （判完到写完之间权限被收回）。彻底修法是给 `wiki-service` 加一个接主体的写方法
 * （`saveAs(principal, slug, input)`），让授权与写入在同一个服务调用里。
 * 那是一次触及 wiki 核心的契约变更，不属于本批；此处不做，但**必须写下来**，
 * 否则下一个人会以为"这里已经安全了"。
 */
import type { Context } from 'cordis'
import type { GeeWikiManifest, Principal } from '@geewiki/core'
import { AI_TOOL_SERVICE_NAME, type AiToolContext, type AiToolResult, type AiToolService } from '@geewiki/ai-tools'
import {
  AI_JOURNAL_SERVICE_NAME,
  type AiJournalService,
  type MutationRecord,
  type ProbeOutcome,
  type UndoOutcome,
} from '@geewiki/ai-journal'

/** 域标识：撤销执行体按它挑选（页面正文） */
export const PAGE_DOMAIN = 'page'

/** 工具名（写工具）。读工具在 `ai-kb`，此处只放写。 */
export const PAGE_TOOL_NAMES = ['page.update'] as const

/** 撤销执行体需要的服务面（只声明用到的部分，避免把整包类型拖进来） */
interface PolicyServiceLike {
  resolvePage(p: Principal, slug: string): Promise<{ level: string; canEdit: boolean }>
}
interface WikiServiceLike {
  get(
    slug: string,
    principal: Principal,
    opts?: { rawContent?: boolean },
  ): Promise<{ title: string; content: string; contentMode?: 'raw' } | undefined>
  save(slug: string, input: { title: string; content: string }): Promise<unknown>
}

const MAX_CONTENT_CHARS = 200_000

/* ============================ 可见性结构的护栏 ============================ */

/**
 * 一段正文里的 gated 区段形态。
 *
 * `markers` 是**顺序敏感**的规格序列（`org` / `granted` / …）。
 * `broken` 表示**护栏无法确认这份正文的 gated 结构**——闭合不成对、嵌套，
 * 或出现了 `<!--gated` 痕迹但形态不在已知的两种里。落进 `broken` 的一律**拒绝改写**。
 *
 * ⚠️ `broken` **比解析器严格**，有两处是刻意的保守：
 *   1. 解析器在**代码围栏内**忽略标记（`blocks.ts:132`），护栏不跟踪围栏——
 *      一篇"讲解 gated 语法"的文档会被判成 broken，于是 AI 改不了它；
 *   2. 解析器把**写在段落中间**的 `<!--gated:org-->` 当普通文字，护栏把它算作"认不出的痕迹"。
 * 两处都朝"多拦一次"偏。方向是刻意选的：漏一次的代价是受限段落静默变公开，
 * 多拦一次的代价是让用户去编辑页手动改一次。
 */
export interface GatedShape {
  readonly markers: readonly string[]
  readonly broken: boolean
}

/*
 * 这两个正则**必须与 `packages/plugin-wiki/src/blocks.ts:78-79` 的 `OPEN_RE` / `CLOSE_RE`
 * 保持一致** —— 那份是解析器、这份是护栏，两份对"什么算标记"的看法一旦分叉，
 * 护栏就会在解析器认得、而它认不得的形态上**静默放行**（比误报更糟，因为看起来还在检查）。
 * 守卫测试 `test/gatedGuard.test.ts` 直接读 `blocks.ts` 的源码比对这两行字面量。
 */
const GATED_OPEN_RE = /^<!--\s*gated\s*:\s*([^>]*?)\s*-->\s*$/
const GATED_CLOSE_RE = /^<!--\s*\/gated\s*-->\s*$/
/** 任何看起来像 gated 标记的痕迹（含写坏的形态）——用来把"不认识"变成"拒绝" */
const GATED_TRACE_RE = /<!--\s*\/?\s*gated\b/

/**
 * 抽出正文的 gated 区段形态。纯函数，逐行扫（与 `parseBlocks` 同粒度：标记必须独占一行）。
 *
 * 为什么要按行而不是全文正则：`<!--gated:org-->` 写在段落中间时**根本不是标记**，
 * 解析器就是这么看的（`OPEN_RE` 带 `^…$`）。护栏必须与解析器同口径，
 * 否则它会在"解析器不认、它却认"的位置报出一个不存在的差异。
 */
export function gatedShapeOf(content: string): GatedShape {
  const markers: string[] = []
  let depth = 0
  let broken = false
  for (const line of content.split('\n')) {
    const open = GATED_OPEN_RE.exec(line)
    if (open !== null) {
      if (depth > 0) broken = true // 不允许嵌套（解析器同样拒绝）
      markers.push(open[1] ?? '')
      depth += 1
      continue
    }
    if (GATED_CLOSE_RE.test(line)) {
      depth -= 1
      if (depth < 0) broken = true
      continue
    }
    // 有 gated 痕迹、但形态不是上面两种 ⇒ 认不出 ⇒ 当作坏
    if (GATED_TRACE_RE.test(line)) broken = true
  }
  if (depth !== 0) broken = true
  return { markers, broken }
}

/**
 * 判定"这次改写会不会改动可见性结构"，返回拒绝理由（`null` = 可以改）。
 *
 * 为什么需要这道闸：`page.update` 的契约是**整篇替换**。只要模型在改写时少写一个
 * `<!--/gated-->`、或漏掉一个 `<!--gated:org-->`，`blocks.tier` 就会从新正文重算，
 * 受限段落**静默变成公开** —— 没有报错，没有日志，只有内容多露了一段。
 * 提示词里写"请保住标记"不算护栏（`docs/design/ai-plugin-architecture.md` 的原话：
 * "提示里写'请不要停用 llm'不算护栏，模型可以不听"）。
 *
 * 判据刻意**只比结构、不比内容**：允许 AI 改区段里的文字（可见性没变），
 * 只拒绝会改变"哪些内容受哪种限制"的改写。
 */
export function gatedRewriteRefusal(before: string, after: string): string | null {
  const b = gatedShapeOf(before)
  const a = gatedShapeOf(after)
  if (b.broken || a.broken) {
    return (
      '这一页的正文里有无法解析的受限区段标记（`<!--gated:…-->` 不成对或形态不认识），' +
      '无法确认这次改写会不会改变段落权限，因此**没有修改任何内容**。请到编辑页手动处理。'
    )
  }
  if (b.markers.length === 0 && a.markers.length === 0) return null
  const same = b.markers.length === a.markers.length && b.markers.every((m, i) => m === a.markers[i])
  if (same) return null
  return (
    `这一页含 ${b.markers.length} 个受限区段（${b.markers.join(' / ') || '无'}），` +
    `而给定的新正文里有 ${a.markers.length} 个（${a.markers.join(' / ') || '无'}）。` +
    '改这个会改变"哪些内容谁能看"，**不由 AI 决定**，因此没有修改任何内容。' +
    '如果确实要调整段落权限，请到编辑页手动改。'
  )
}

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-pages',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 页面写工具',
    description: '让 AI 能修改页面正文（每次改动都记入变更日志，可一键回退）',
    // 纯贡献者：不 provide 服务、没有端点、没有前端产物
    provides: undefined,
    /*
     * 四个依赖都是**服务标识**：
     * - `ai-tool-service`：往工具总线上挂工具；
     * - `wiki-service`：读旧正文 + 写入；
     * - `policy-service`：**授权判据的唯一出口**（见文件头）；
     * - `ai-journal-service`：记日志。**它不是可选的**——见文件头纪律 1。
     */
    requires: ['ai-tool-service', 'wiki-service', 'policy-service', 'ai-journal-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 5 },
    configSchema: undefined,
    slots: undefined,
  },
}

export const AiPagesPlugin = {
  name: '@geewiki/ai-pages',

  apply(ctx: Context): () => void {
    const tools = ctx.get(AI_TOOL_SERVICE_NAME) as AiToolService | undefined
    if (!tools) throw new Error('@geewiki/ai-pages: ai-tool-service 不可用（@geewiki/ai-tools 未激活）')
    const journal = ctx.get(AI_JOURNAL_SERVICE_NAME) as AiJournalService | undefined
    if (!journal) throw new Error('@geewiki/ai-pages: ai-journal-service 不可用（@geewiki/ai-journal 未激活）')

    // 逐次活查询（同 ai-kb 的理由：快照会让"依赖方已卸载"变成读到旧引用而非报错）
    const wiki = (): WikiServiceLike => {
      const svc = ctx.get('wiki-service') as WikiServiceLike | undefined
      if (!svc) throw new Error('@geewiki/ai-pages: wiki-service 不可用')
      return svc
    }
    const policy = (): PolicyServiceLike => {
      const svc = ctx.get('policy-service') as PolicyServiceLike | undefined
      if (!svc) throw new Error('@geewiki/ai-pages: policy-service 不可用')
      return svc
    }

    /* ------------------------------ 撤销执行体 ------------------------------ */

    /**
     * 页面正文的"改回去"：把 `before` 写回该页。
     *
     * 三条判据（缺一条都会变成"回退把别人东西弄坏了"）：
     * 1. **现在有写权限才能回退**（`principal` 由 journal 传进来，是**点回退的那个人**）。
     *    被吊权的用户点回退应当失败——那不是 bug，是权限在起作用。
     * 2. **先把当前值读出来**：页面已被删除时明确失败（不是静默成功）。
     * 3. `before === null` 的记录（当初是"新建"）**不在这里处理**：撤销一次新建意味着删除页面，
     *    而删除是另一个动作、另一套权限。本批没有新建工具，故这种情况根本不该出现——
     *    真出现了就明确拒绝，不去猜。
     */
    const undoPage = async (record: MutationRecord, principal: Principal): Promise<UndoOutcome> => {
      if (record.before === null) {
        return {
          ok: false,
          detail: `${record.target} 的这条记录记的是"新建"，撤销它等于删除页面——删除不在本批写工具的范围内，请到编辑页手动处理`,
        }
      }
      const access = await policy().resolvePage(principal, record.target)
      if (access.level === 'none') return { ok: false, detail: `页面 ${record.target} 已不存在或你看不到它` }
      if (!access.canEdit) return { ok: false, detail: `你没有编辑 ${record.target} 的权限，无法回退它` }
      const current = await wiki().get(record.target, principal)
      if (current === undefined) return { ok: false, detail: `读取 ${record.target} 失败（可能已被删除）` }
      await wiki().save(record.target, { title: current.title, content: record.before })
      return { ok: true, detail: `已把 ${record.target} 的正文还原到这一轮之前的样子` }
    }

    const releaseUndoer = journal.registerUndoer(manifest.name, PAGE_DOMAIN, undoPage)

    /**
     * 页面的"现在实际是什么"探针（冲突检测的输入，设计文档 §4.3）。
     *
     * 走的是**能拿到原文的那条读路径**（`rawContent`）——它自己带权限判据，
     * 所以"读不到"天然分成三种可执行的情况，而这三种**不该都说成"目标被改动过"**：
     * 页面没了、你看不到它、你没有编辑权。用户要据此决定下一步做什么。
     *
     * 注意 `value` 与 `reason` **二选一**：给了值就按值比对（哪怕值恰好等于 `after`），
     * 说不出值才用 `reason`。用一个空串去顶替"不知道"是这里最容易犯的错——
     * 空串是**一个值**，它会让"读不到"看起来像"现在是空的"。
     */
    const probePage = async (record: MutationRecord, principal: Principal): Promise<ProbeOutcome> => {
      const access = await policy().resolvePage(principal, record.target)
      if (access.level === 'none') {
        return {
          reason: `${record.target} 已不存在，或你看不到它——无法确认它现在的正文，故不能回退这一条`,
        }
      }
      const page = await wiki().get(record.target, principal, { rawContent: true })
      if (page === undefined) {
        return { reason: `读取 ${record.target} 失败（可能刚被删除）——无法确认它的当前正文` }
      }
      if (page.contentMode !== 'raw') {
        return {
          reason: `你没有编辑 ${record.target} 的权限，读不到含权限标记的原文——无法确认它的当前正文，故不能回退这一条`,
        }
      }
      return { value: page.content }
    }

    const releaseProbe = journal.registerProbe(manifest.name, PAGE_DOMAIN, probePage)

    /* ------------------------------ page.update ------------------------------ */

    /** 出参解析：工具参数来自模型，形状不对必须拒绝（不猜、不兜底） */
    function parseUpdateArgs(args: unknown): { slug: string; content: string } | string {
      if (typeof args !== 'object' || args === null) return '参数必须是对象 { slug, content }'
      const raw = args as Record<string, unknown>
      const slug = raw['slug']
      const content = raw['content']
      if (typeof slug !== 'string' || slug.trim() === '') return 'slug 必须是非空字符串'
      if (slug.length > 512) return 'slug 过长'
      if (typeof content !== 'string') return 'content 必须是字符串（整篇正文，不是片段）'
      if (content.length > MAX_CONTENT_CHARS) return `content 过长（${content.length} > ${MAX_CONTENT_CHARS}）`
      return { slug: slug.trim(), content }
    }

    const releaseTool = tools.contribute(manifest.name, {
      descriptor: {
        name: 'page.update',
        description:
          '把某一页的正文**整篇替换**为给定内容（不是追加、不是局部替换）。' +
          '调用前必须先用 read_page 看清现有内容，并已获得用户对这次修改的明确同意；' +
          '只改用户要求改的部分，不要顺手重写其它段落。它会覆盖原正文，但每次修改都会记录在案、可以回退。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: '要修改的页面 slug（先用 list_pages / read_page 拿到）' },
            content: { type: 'string', description: '替换后的**完整**正文（Markdown），不是片段' },
          },
          required: ['slug', 'content'],
          additionalProperties: false,
        },
        side: 'server',
        // 有副作用，且逆操作由本包注册的 undoPage 提供（mutation journal），故标 mutating
        mutating: true,
        // 匿名主体没有编辑能力；把它挡在工具表之外，模型就不会去调一个注定失败的写工具
        available: (principal: Principal): boolean => principal.kind !== 'anonymous',
      },

      execute: async (principal: Principal, args: unknown, context: AiToolContext): Promise<AiToolResult> => {
        const parsed = parseUpdateArgs(args)
        if (typeof parsed === 'string') return { content: `参数不合法：${parsed}。请修正后重试。` }
        const { slug, content } = parsed

        /*
         * ★ **记不下来就别改**（决策 3 的直接推论）。
         *
         * 没有轮次标识时这次改动会变成"改了但说不清是哪一轮改的"，也就是**不可回退**。
         * 那正是决策 3 要消灭的东西——"AI 能改你的页面、但你没法让它改回去"。
         * 所以这里选择**拒绝动手**，而不是照改然后把记录塞进一个"未知轮次"：
         * 后者在用户点回退之前完全不报错，而不报错的不可逆操作是最坏的一类缺陷。
         *
         * 不返回 `ok:false` 之类的东西：工具结果只有文本与 data，模型读到的就是这句话。
         */
        if (context.turnId === null || context.conversationId === null) {
          return {
            content:
              '这次请求没有带上会话/轮次标识，无法记录一条可回退的变更，因此**没有修改任何内容**。' +
              '请让用户从页面底部的助手输入条重新发起这次修改（那里会自动带上标识）。',
            data: { refused: 'missing_turn_context' },
          }
        }

        /*
         * ★ 顺序是有意义的：**先读现状、再判权限、最后才写**。
         *
         * 为什么"读现状"排在权限之前：`get()` 自己也按主体过滤（读方法都带 principal），
         * 无权时它返回 `undefined`——于是"页面不存在"与"你看不到"在这里是同一个结果，
         * 而这正是我们要的（不泄露存在性）。真正的 403 判据由紧随其后的 policy 给出，
         * 它只对"确实存在且可见"的页面补上"你能不能改"这一层。
         */
        const current = await wiki().get(slug, principal)
        if (current === undefined) {
          return { content: `没有找到页面 ${slug}（可能不存在，或你没有查看它的权限）。请先用 list_pages 确认 slug。` }
        }
        const access = await policy().resolvePage(principal, slug)
        if (!access.canEdit) {
          return { content: `你没有编辑 ${slug} 的权限，这次修改没有执行。请让有权限的同事来改，或先申请权限。` }
        }

        /*
         * ★ **原文口径**，且必须是原文。
         *
         * `before` 是回退的全部依据，而回退是把 `before` **原样写回**。若这里读的是投影正文
         * （受限段落已变成占位），那么"回退"会把占位符写成正文 —— 受限内容再也回不来，
         * 而这一页看起来还"回退成功"了。
         *
         * 上面那次不带选项的 `get()` 只用来判"存在且可见"（它的语义是"不存在与无权同一个答案"），
         * 真正的读写基准是这一次。`canEdit` 已在上一步确认，服务会照给原文；
         * 万一没给（判据不一致），**宁可不动手**。
         */
        const source = await wiki().get(slug, principal, { rawContent: true })
        if (source === undefined || source.contentMode !== 'raw') {
          return {
            content:
              `读不到 ${slug} 的原文（含段落权限标记的那一份），因此**没有修改任何内容**。` +
              '整篇替换必须建立在原文之上，否则会把受限段落连标记一起改写掉。请到编辑页手动处理。',
            data: { refused: 'raw_content_unavailable' },
          }
        }

        // ★ 不得改动可见性结构（见 gatedRewriteRefusal 的长注释）
        const refusal = gatedRewriteRefusal(source.content, content)
        if (refusal !== null) {
          return { content: refusal, data: { refused: 'gated_structure_change' } }
        }

        if (source.content === content) {
          /* 幂等：内容没变就不写、也不记日志。记一条"改了跟没改一样"的记录，
             只会让用户看到一条点了没反应的"可回退"条目。 */
          return { content: `${slug} 的正文与给定内容一致，无需修改（未写入、未记录）。` }
        }

        await wiki().save(slug, { title: source.title, content })

        /*
         * 日志在**写入成功之后**记。反过来（先记后写）会在写入失败时留下一条
         * 声称改过的记录，而回退它会把页面"还原"成一个它从未变成的样子。
         */
        const recordId = await journal.record({
          // 来自请求、经会话核心透传——**不是**自造的 id
          conversationId: context.conversationId,
          turnId: context.turnId,
          owner: manifest.name,
          tool: 'page.update',
          domain: PAGE_DOMAIN,
          target: slug,
          before: source.content,
          after: content,
        })

        return {
          content:
            `已更新 ${slug} 的正文（${source.content.length} → ${content.length} 字符，变更 #{${recordId}}）。` +
            '这次修改已记录，用户可以在对话里要求回退。',
          data: { slug, recordId, beforeChars: source.content.length, afterChars: content.length },
        }
      },
    })

    return () => {
      releaseTool()
      releaseUndoer()
      releaseProbe()
    }
  },
}

export type { MutationRecord, UndoOutcome }
