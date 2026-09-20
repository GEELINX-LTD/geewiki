/**
 * `@geewiki/ai-kb` —— 知识库工具提供者：`list_pages` / `search_kb` / `read_page`。
 *
 * 这三个工具是**检索地基**（`@geewiki/search`）与**页面读路径**（`@geewiki/wiki`）的
 * 工具化外壳。它们本身不含检索算法，也不碰数据库——只把既有的、**已按主体裁剪**的
 * 两个服务包装成模型可调用的动作。
 *
 * ## 为什么第一个工具是 `list_pages`（实测得出的次序）
 * `data/verify/ai-native-probe/agent-loop.mjs` 的基线读数：只给一个字面检索工具时，
 * 模型问「怎么新建内容」花了 **5 个 LLM 轮次、15 次检索**才上岸——第 2 轮它连猜 5 次
 * 全部 0 命中，因为**它不知道语料里用的是哪些词**。真正让它脱困的是第 3 轮偶然命中了
 * 一篇页面，从而拿到词汇反馈。
 *
 * 加上 `list_pages` 之后，P0 验收的同一问题变成 **3 轮、3 次调用**（
 * `scripts/acceptance/p0-tools/run.ts`）：模型第一轮就同时拿到"有哪些页面"。
 * 所以这不是"多给一个便利工具"，而是**成本结构上最重要的一件事**——
 * 它把"盲猜措辞"换成"先看地图"。
 *
 * 一条随之而来的边界：`list_pages` **不返回正文**，只返回 slug 与标题。
 * 地图工具一旦开始返回内容，它就会变成"一次性把所有内容塞进上下文"的入口。
 *
 * ## 权限：三道，一道都不能少
 * 1. **编译期**——handler 的第一个参数是必填的 `Principal`（`@geewiki/ai-tools` 的契约）；
 * 2. **工具表**——`available` 为假的工具不进模型看到的工具表（缺服务时连能力都不暴露）；
 * 3. **服务层**——`wiki-service.get(slug, principal)` 与 `search-service.search(principal, …)`
 *    自己会在返回任何正文之前按主体裁剪。本插件**不自己判权限**：
 *    自己再写一份判据就是第四份会漂移的实现（`packages/plugin-wiki/src/index.ts` 记过这条：
 *    "正文里看不到、附件却能下载"正是两份判据漂移的表现，且不会报错）。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import type { GeeWikiManifest, LlmService, Principal } from '@geewiki/core'
import {
  AI_TOOL_IMAGE_MAX_BYTES,
  AI_TOOL_IMAGE_MIME_WHITELIST,
  AI_TOOL_SERVICE_NAME,
  type AiToolContext,
  type AiToolImage,
  type AiToolResult,
  type AiToolService,
} from '@geewiki/ai-tools'
import { MAX_QUERY_LENGTH, type SearchService } from '@geewiki/search'
import type { WikiService } from '@geewiki/wiki'

/* ============================== 配置 ============================== */

export interface AiKbConfig {
  /** `search_kb` 单次返回的命中条数 */
  searchLimit?: number
  /** `read_page` 返回正文的字符上限 */
  maxPageChars?: number
  /** `list_pages` 单次返回的页面条数上限 */
  listLimit?: number
}

export const AiKbConfigSchema = Schema.object({
  searchLimit: Schema.number()
    .default(8)
    .min(1)
    .max(50)
    .description('search_kb 单次返回的命中条数（命中页太多会淹没模型，8 条通常够用）'),
  maxPageChars: Schema.number()
    .default(20000)
    .min(500)
    .max(200000)
    .description('read_page 返回正文的字符上限；超出会截断并在结果里明确写出'),
  listLimit: Schema.number()
    .default(200)
    .min(1)
    .max(2000)
    .description('list_pages 单次返回的页面条数上限（超出会只给前 N 条并报出总数）'),
})

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai-kb',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 知识库工具',
    description: '把「列出页面 / 检索正文 / 读取页面」三个知识库动作作为工具提供给 AI 助手',
    // 本插件**不 provide 任何服务**：它是纯粹的贡献者，产物是三条工具注册。
    provides: undefined,
    // 依赖以服务标识声明（非插件名）。`ai-tool-service` 排第一是因为它必须在
    // 本插件的 apply 里可解析——管理器按 requires 解析依赖边并保证激活顺序。
    requires: ['ai-tool-service', 'wiki-service', 'search-service'],
    conflictGroup: undefined,
    migrations: undefined,
    runtime: {
      supportsHotReload: true, // 无进程内状态：全部产物是注册表里的三条记录
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: AiKbConfigSchema,
  },
}

/* ============================== 纯函数（可单测） ============================== */

/**
 * 把 `search-service` 的 `snippet` 从 **HTML 片段**降级成**纯文本**。
 *
 * `snippet` 是给前端 `dangerouslySetInnerHTML` 用的：正文做过 HTML 转义，
 * 命中词两侧包着 `<mark>`。而工具结果要进**模型的上下文**，那里没有 DOM——
 * 留着 `<mark>` 只是噪声，留着 `&amp;` 这类实体会让模型读到错的字面。
 *
 * **两步的顺序是有讲究的，反过来就错**：
 * 1. **先剥标签、后解实体**。若先解实体，正文里字面出现的 `<mark>`（转义后是
 *    `&lt;mark&gt;`）会先还原成 `<mark>`，紧接着被当成标签**误删**——用户正文被静默改写。
 * 2. **`&amp;` 放最后**。它要留到其余实体都解完再解，否则字面的 `&lt;`（转义后是
 *    `&amp;lt;`）会被解成 `<`——一次把"用户写的字面文本"变成"HTML 语法"的失真。
 *
 * 这两条不是理论风险：`escapeHtml`（`packages/plugin-search/src/index.ts:275`）
 * 转义的正是这五个字符，所以页面正文里出现它们的转义形式完全正常。
 */
export function plainSnippet(snippet: string): string {
  return snippet
    .replace(/<\/?mark>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 工具结果里的"这不算成功"形态：**不抛错**，而是让模型读到一条可据以改主意的说明。 */
function toolError(message: string): AiToolResult {
  return { content: JSON.stringify({ error: message }) }
}

/**
 * 把模型给的参数当作**不可信输入**取字段。
 *
 * `AiToolHandler` 的 `args` 声明是 `unknown`，不是某个具体类型——因为它的来源是模型，
 * 也就是外部输入。**多给的键一律忽略**（模型经常顺手多塞一个字段，为此拒绝一次
 * 本来能成功的调用毫无收益），但**该有的键缺失或类型不符就明确报错**。
 */
function readArgs(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  return args as Record<string, unknown>
}

function readString(args: unknown, key: string): string | null {
  const raw = readArgs(args)[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/** 取一个**正整数**参数（附件 id）。模型常把数字写成字符串，故两边都收，其余一律拒绝 */
function readPositiveInt(args: unknown, key: string): number | null {
  const raw = readArgs(args)[key]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n >= 1 ? n : null
}

/**
 * 当前模型收不收图 —— 由 LLM 设置里的 `supportsVision` 决定（**缺省 false，从严**）。
 *
 * ## 为什么工具表要跟着它变
 * 模型看不到图时把 `read_image` 摆在工具表里，它会调、会拿到一张自己读不懂的图，
 * 然后**凭文件名编内容**——这条链路上没有任何一处会报错。本仓在 `page.update` 上
 * 已经定过同一条判据："这个能力不存在"比"调了才发现做不到"诚实得多。
 *
 * ## 为什么走 `ctx.get` 而不是 `requires`
 * `llm-service` 对本插件是**可选**的：三条文本工具（`list_pages` / `search_kb` /
 * `read_page`）一个都不需要它。写进 `requires` 会让"没配模型"变成"知识库工具全没了"，
 * 那是把一个能力面收窄成了一次激活失败。`search_kb` 对 `search-service` 也是这么处理的。
 */
function visionEnabled(ctx: Context): boolean {
  const llm = ctx.get('llm-service') as LlmService | undefined
  return llm?.settings().supportsVision === true
}

/* ============================== 正文里的图片 ============================== */

/**
 * 从正文里按**出现顺序**抽出附件引用（`/api/attachments/<数字>`），去重。
 *
 * 三条判据：
 * 1. **只认数字 id。** `guide/markdown-demo` 那篇"讲解 Markdown 语法"的页面里写着
 *    `![站内附件](/api/attachments/<附件 id>)` 这种示例文字，把它当成真附件去取
 *    只会白跑一趟。
 * 2. **只认出现过的。** 附件面板里存着、正文却没引用的附件**不算**——本仓的可见性
 *    判据是"出现在你看得见的正文段落里"，工具若自作主张把整页附件都捞出来，
 *    就造出了第二套判据（下载端点那边判 404 的，这里却给模型看了）。
 * 3. **顺序即文档顺序。** "前面几张"对模型与用户都才是有意义的说法。
 *
 * 为什么在**文本**上找而不是解析 Markdown：本仓的正文模型就是"Markdown 文本 + 块级投影"，
 * 不存在一棵两边共用的 AST（编辑器与渲染器各自解析一次）。附件 URL 是上传时由编辑器
 * **逐字写进正文**的固定形态，所以匹配到的就是真引用；而且**漏掉一张**的代价只是
 * 模型少看一张图，**多认一张**的代价只是一次取不到就跳过的查询。两个方向都不危险。
 */
export function attachmentIdsIn(content: string): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const re = /\/api\/attachments\/(\d+)/g
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const id = Number(m[1] ?? '')
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/* ============================== 插件 ============================== */

export const AiKbPlugin = {
  name: '@geewiki/ai-kb',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: AiKbConfigSchema,

  apply(ctx: Context, config: AiKbConfig = {}) {
    /*
     * 服务缺失时**明确抛错**，不静默跳过。
     *
     * 这条是插槽那批的实测教训（`packages/manager/src/slot-plugin.ts` 文件头）：
     * 手动 `ctx.get()` + `if (!slot) return` 会让插件"看起来激活成功、实际什么都没贡献"，
     * 而服务端查不到任何痕迹，与"这个插件本来就没贡献"完全无法区分。
     * 既然 manifest 已经声明了 requires，拿不到服务就是**不该发生**的事——
     * 该发生的是启动失败，而不是一个安静的空插件。
     */
    const tools = ctx.get(AI_TOOL_SERVICE_NAME) as AiToolService | undefined
    if (!tools) {
      throw new Error('@geewiki/ai-kb: ai-tool-service 不可用（@geewiki/ai-tools 未激活）')
    }

    /**
     * 服务**逐次活查询**，不在 apply 时快照。
     *
     * 理由与 `@geewiki/search` 的 `policy()` 相同：快照会让"依赖方被卸载后本插件仍握着
     * 旧引用"变成可能，而那种调用的表现是"读到一个已经不该用的东西"，不是报错。
     * 另外 `available` 也要用它做判据，那更是每次 `list()` 都要现算的。
     */
    const wiki = (): WikiService => {
      const svc = ctx.get('wiki-service') as WikiService | undefined
      if (!svc) throw new Error('@geewiki/ai-kb: wiki-service 不可用（@geewiki/wiki 未激活）')
      return svc
    }
    const search = (): SearchService => {
      const svc = ctx.get('search-service') as SearchService | undefined
      if (!svc) throw new Error('@geewiki/ai-kb: search-service 不可用（@geewiki/search 未激活）')
      return svc
    }

    /** 配置快照：写入时已由 schema 填好默认值，这里再兜一层以防直接调用 apply 的测试 */
    const cfg = {
      searchLimit: config.searchLimit ?? 8,
      maxPageChars: config.maxPageChars ?? 20000,
      listLimit: config.listLimit ?? 200,
    }

    /* ---------------------------- list_pages ---------------------------- */

    tools.contribute('@geewiki/ai-kb', {
      descriptor: {
        name: 'list_pages',
        description:
          '列出知识库中当前用户可见的全部页面（slug 与标题）。不知道有哪些页面时先调用它：它给出 read_page 需要的 slug，' +
          '也让你看到知识库实际使用的措辞，避免检索时凭空猜词。它不返回正文。',
        parameters: { type: 'object', properties: {}, required: [] },
        side: 'server',
        // 缺 wiki-service 时**连能力都不暴露**：模型不会去调一个注定失败的工具
        available: (): boolean => ctx.get('wiki-service') !== undefined,
      },
      execute: async (principal: Principal, _args: unknown, _context: AiToolContext): Promise<AiToolResult> => {
        const pages = await wiki().list(principal)
        const shown = pages.slice(0, cfg.listLimit)
        return {
          content: JSON.stringify({
            total: pages.length,
            pages: shown.map((p) => ({ slug: p.slug, title: p.title, updated_at: p.updated_at })),
            ...(shown.length < pages.length
              ? { truncated: true, note: `共 ${pages.length} 个页面，此处只列出前 ${shown.length} 个` }
              : {}),
          }),
          data: { total: pages.length },
          /*
           * ★ **地图不算依据**（刻意不声明 `grounding`）。
           *
           * `list_pages` 返回的是 slug 与标题。它足以让模型说"知识库里确实有一个叫
           * 『安装部署』的页面"——但那是**目录信息**，不是能回答问题的资料。
           * 若把它算成依据，模型只要先列一次页面，接下来凭空写的答案就会被判成
           * "引用了知识库"——恰好是需求 ⑥ 要消灭的那种冒充。
           */
        }
      },
    })

    /* ---------------------------- search_kb ---------------------------- */

    tools.contribute('@geewiki/ai-kb', {
      descriptor: {
        name: 'search_kb',
        description:
          '在知识库正文里做字面全文检索，返回命中的页面与片段。查询词必须是正文里可能逐字出现的短词（中文三个字以上）。' +
          '0 命中通常只是措辞不匹配，不代表知识库里没有——换更短的词，或先用 list_pages 看有哪些页面。',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: '检索词。越短、越常见，越可能命中；不要用整句提问。' },
          },
          required: ['q'],
        },
        side: 'server',
        available: (): boolean => ctx.get('search-service') !== undefined,
      },
      execute: async (principal: Principal, args: unknown, _context: AiToolContext): Promise<AiToolResult> => {
        const q = readString(args, 'q')
        if (q === null) return toolError('缺少参数 q（检索词，非空字符串）')
        if (q.length > MAX_QUERY_LENGTH) {
          return toolError(`检索词过长（${q.length} 字符，上限 ${MAX_QUERY_LENGTH} 字符）`)
        }

        /*
         * `mode: 'terms'`（词元 OR），**不是**默认的 `'phrase'`。
         *
         * 默认档把整串当 FTS5 字面短语（搜索框语义），而自然语言问句几乎不可能
         * 逐字连续出现在正文里 ⇒ **恒为 0 命中**。这是检索地基曾经的已知缺陷，
         * 修法就是问答侧一律走 terms（`04c45c3`；现状见
         * `packages/plugin-ai-qa/src/index.ts:431` 的同一处调用）。
         */
        const result = await search().search(principal, q, { limit: cfg.searchLimit, mode: 'terms' })
        const hits = result.hits.map((h) => ({
          slug: h.slug,
          title: h.title,
          snippet: plainSnippet(h.snippet),
        }))
        return {
          content: JSON.stringify({
            query: q,
            total: result.total,
            hits,
            /*
             * 0 命中时给一句**可据以改主意**的话，而不是一个空数组。
             * 空数组对模型的含义是"知识库里没有"——而真实含义是"这几个字没有连续出现"。
             * 差别很大：前者会让它直接放弃，后者会让它换个词再试。
             */
            ...(hits.length === 0
              ? {
                  hint:
                    '没有命中。字面检索对措辞敏感：换一个更短、更常见、更可能在正文里逐字出现的词再试，' +
                    '或先用 list_pages 看看知识库里有哪些页面。这不代表知识库中没有相关内容。',
                }
              : {}),
          }),
          data: { total: result.total, mode: result.mode },
          /*
           * ★ 命中了才算依据。
           *
           * 这是"逐次结果"而非"逐条描述符"的全部理由：0 命中时 `search_kb` 确实跑了，
           * 但一个字的资料都没给模型。若按描述符声明，这一轮会被判成"有知识库依据"，
           * 于是模型凭先验知识写出的答案**不带任何标注**地显示给用户——
           * 而这正是最像答案、也最不该被相信的一种。
           */
          ...(hits.length > 0 ? { grounding: 'kb' as const } : {}),
        }
      },
    })

    /* ---------------------------- read_page ---------------------------- */

    tools.contribute('@geewiki/ai-kb', {
      descriptor: {
        name: 'read_page',
        description:
          '按 slug 读取页面全文（已按当前用户权限裁剪）。slug 从 list_pages 或 search_kb 的结果里取。' +
          '正文过长会被截断，截断时结果里会明确写出，此时不要断言"资料里没有"。',
        parameters: {
          type: 'object',
          properties: { slug: { type: 'string', description: '页面标识，例如 home 或 guide/intro' } },
          required: ['slug'],
        },
        side: 'server',
        available: (): boolean => ctx.get('wiki-service') !== undefined,
      },
      execute: async (principal: Principal, args: unknown, _context: AiToolContext): Promise<AiToolResult> => {
        const slug = readString(args, 'slug')
        if (slug === null) return toolError('缺少参数 slug（页面标识，非空字符串）')

        /*
         * ★ 请求**原文口径**（`rawContent`），让"AI 读到的正文"与"AI 写回去的正文"是同一份。
         *
         * `wiki-service.get()` 自己强制 `canEdit`：够得着就给含 `<!--gated:…-->` 标记的原文，
         * 够不着就**退回投影口径**（受限段落变成占位），响应里以 `contentMode: 'raw'` 自述。
         * 本插件因此不需要自己去问 `policy-service` —— 判据只有一处，问第二次就是第二份判据。
         *
         * 为什么这不是"为了读全而放宽权限"：拿不到原文的人仍然拿不到（服务里判），
         * 而能编辑这一页的人本来就能从版本快照端点读到含标记的原文。
         * 反过来，若在这里读投影正文，`page.update` 会把占位符当成正文写回去 ——
         * 受限区段**连标记一起消失**，静默变成公开块。那不是"读得不全"，那是改坏了权限。
         */
        const page = await wiki().get(slug, principal, { rawContent: true })
        if (!page) {
          // 不存在与无权**给同一个回答**（与详情端点的 404 同口径）：区分开就等于
          // 提供了一个"这个 slug 存不存在"的探测接口。
          return toolError(`没有找到页面 ${slug}（也可能存在但当前用户无权查看）`)
        }

        const full = page.content
        const truncated = full.length > cfg.maxPageChars
        const text = truncated ? full.slice(0, cfg.maxPageChars) : full
        const raw = page.contentMode === 'raw'

        /*
         * 正文里引用了多少张图 —— **只数不取**（2026-09-20）。
         *
         * 第一版在这里直接把字节取出来随结果交给模型。那有两个问题：① "读一页"变成一次
         * **不可预期**的开销（一页可能引用十张图，每张一千多 token）；② 剥夺了模型
         * "这张图我到底要不要看"的选择权。现在这里只说**有几张、怎么取**，
         * 真正读字节的是模型自己调用的 `read_image`。
         *
         * 分工照搬 DSH：`read_file` 给文本、`read_image` 给图，由模型按需选择。
         */
        const refIds = attachmentIdsIn(text)
        const canSee = visionEnabled(ctx)
        const imagesNote =
          refIds.length === 0
            ? null
            : canSee
              ? `正文里引用了 ${refIds.length} 张图片（形如 \`![说明](/api/attachments/<id>)\`）。` +
                '要**看**其中某一张，用 read_image 传它的 id —— 本次没有把图片交给你。'
              : /*
                 * 模型看不到图时**必须说出来**，而且不能说"用 read_image"——
                 * 那条工具此刻根本不在工具表里（见 `visionEnabled`）。
                 * 不说的后果是模型凭 `![部署拓扑]` 这样的替代文字编出图的内容，
                 * 而回答读起来与真看过一模一样。
                 */
                `正文里引用了 ${refIds.length} 张图片，但**当前模型没有声明支持看图**` +
                '（管理员可在 LLM 设置里打开「支持图像输入」），所以图片内容你读不到。' +
                '**不要**根据替代文字或文件名臆测图片内容；如实告诉用户这一点。'
        return {
          content: JSON.stringify({
            slug: page.slug,
            title: page.title,
            text,
            /*
             * 口径必须**自述**。两种正文长得几乎一样（都是一段 Markdown），而拿错口径的
             * 后果不对称：把投影结果当原文写回去会毁掉段落权限标记。自述字段让模型
             * 知道"改动时要不要保住那些标记"，也让拿不到标记时**不必猜**。
             */
            contentMode: raw ? 'raw' : 'projected',
            ...(raw
              ? {}
              : {
                  contentModeHint:
                    '这是按当前用户权限投影后的正文：受限段落已被替换成「🔒 此处有 N 段内容」占位、' +
                    '权限标记已被消费。**不得**把它当作原文整篇写回（那会让受限段落静默变成公开），' +
                    '也不要据此断言资料里没有那些内容。',
                }),
            ...(truncated
              ? {
                  truncated: true,
                  totalChars: full.length,
                  /*
                   * 截断必须**说出来**。
                   *
                   * 实测踩过（`data/verify/ai-native-probe/` 的 E4）：一页 6437 字符，
                   * 结论在最后一段；旧实现静默地只把前 1200 字符喂进 prompt，
                   * 模型于是回答"知识库资料不足，无法回答"——**它不知道自己没读全**。
                   * 静默截断把"我没看到"伪装成了"资料里没有"，这是这个工具里最危险的一种沉默。
                   */
                  note:
                    `正文共 ${full.length} 字符，此处只含前 ${cfg.maxPageChars} 字符。` +
                    '**不要**据此断言"资料里没有相关内容"——请用 search_kb 定位未被包含的段落。',
                }
              : {}),
            ...(imagesNote !== null ? { imagesNote } : {}),
          }),
          data: { slug: page.slug, title: page.title, truncated, totalChars: full.length, pageImages: refIds.length },
          // 逐字读到的正文，是本仓最强的一种依据（即便口径是投影，它仍是知识库内容）
          grounding: 'kb',
        }
      },
    })

    /* ---------------------------- read_image ---------------------------- */

    /*
     * ## 为什么是一条**独立的**工具，而不是让 `read_page` 顺手把图带上（2026-09-20 定）
     *
     * 第一版是后者：读一页就把正文里引用的图全部取出来随结果交给模型。两个问题——
     * ① 开销**不可预期**：一页引用十张图就是十张图进上下文，而用户可能只问了一句
     *    "这页讲了什么"；② 剥夺了模型的选择权：它没法说"这张图我不用看"。
     *
     * 现在照 DSH 的分工（`read_file` 给文本、`read_image` 给图）：`read_page` 只说
     * "正文引用了 N 张图、id 是多少"，**要不要看、看哪张，由模型自己调这条工具**。
     * 顺带的好处是这条工具的参数与 `read_page` 完全同构（都是"从正文里读到的那个标识"），
     * 模型在正文里看到的 `![说明](/api/attachments/42)` 直接就是调用凭据。
     *
     * ## 权限：一条都不自己判
     * 取字节走 `wiki-service.readAttachment`，判据（页面级 + 块级投影）与
     * `GET /api/attachments/:id` 是**同一份实现**。本插件连"这个 id 存不存在"都不区分——
     * 服务层一律回 `undefined`，正是为了不让这里变成一个存在性探测接口。
     */
    tools.contribute('@geewiki/ai-kb', {
      descriptor: {
        name: 'read_image',
        description:
          '把知识库页面正文里引用的一张图片**读出来看**（图片本身会随结果交给你）。' +
          'id 取自 read_page 结果里的 `![说明](/api/attachments/<id>)`。' +
          '只支持 PNG/JPEG/WebP/GIF，且**要求当前模型支持图像输入**；' +
          '读不到时不要臆测图片内容，如实告诉用户你看不到它。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '附件 id —— 正文里 `/api/attachments/` 后面那个数字' },
          },
          required: ['id'],
        },
        side: 'server',
        /*
         * **不支持看图时这条工具根本不出现**（不是"调了才发现做不到"）：
         * 与 `page.update` 缺 mutation journal 时不注册是同一条判据。
         */
        available: (): boolean => ctx.get('wiki-service') !== undefined && visionEnabled(ctx),
      },
      execute: async (principal: Principal, args: unknown, _context: AiToolContext): Promise<AiToolResult> => {
        const id = readPositiveInt(args, 'id')
        if (id === null) return toolError('缺少参数 id（附件 id，正整数）')

        /*
         * `maxBytes` 在**打开流之前**判（服务层的语义）：一张 25 MB 的附件读进内存
         * 再判"太大"是纯粹的浪费。取值见 `AI_TOOL_IMAGE_MAX_BYTES`——
         * 它保证按本值挑出来的图一定过得了会话核心那道 base64 长度闸。
         */
        const att = await wiki().readAttachment(principal, id, { maxBytes: AI_TOOL_IMAGE_MAX_BYTES })
        if (att === undefined) {
          /*
           * 五类拒绝（不存在 / 页面无权 / 只出现在你看不到的段落里 / 文件缺失 / 超过体积上限）
           * **回同一句话**。区分开就等于提供了一个存在性探测接口——附件 id 是连续整数、可枚举，
           * 而下载端点当初把 403 改成 404 正是为了这件事。这句话把可能的原因列全，
           * 是为了让模型能给出**可执行的**下一步（换一张、或告诉用户你看不到）。
           */
          return toolError(
            `读不到附件 ${id}。可能的原因：它不存在、它只出现在你看不到的受限段落里、` +
              '它不是图片、字节缺失，或体积超过上限。**不要臆测它的内容**——如实告诉用户你看不到它。',
          )
        }
        if (!AI_TOOL_IMAGE_MIME_WHITELIST.includes(att.mime)) {
          return toolError(
            `附件 ${id}（${att.name}）不是能交给模型看的图片格式：${att.mime}。` +
              `只支持 ${AI_TOOL_IMAGE_MIME_WHITELIST.join(' / ')}。`,
          )
        }
        return {
          content: JSON.stringify({
            id: att.id,
            name: att.name,
            mime: att.mime,
            bytes: att.byteSize,
            /*
             * 自述**必须**有：线上那条 flush 出来的 user 消息只有一句固定的引导语，
             * 图本身不带任何文字。少了这句，模型分不清"图没给我"与"这就是全部"。
             */
            note: '图片本身已随本条结果一并提供（见紧随其后的那条图片消息）。',
          }),
          data: { attachmentId: att.id, mime: att.mime, bytes: att.byteSize },
          // 逐字读到的知识库内容（只是形态是图），与 read_page 同一条判据
          grounding: 'kb',
          // 图片挂在**工具结果**上；chat-completions 表达不了它，由适配器 flush 成 user 消息
          images: [{ mime: att.mime, data: Buffer.from(att.bytes).toString('base64') }],
        }
      },
    })

    return () => {
      /*
       * 按 owner 定向回收，而不是逐个调用 `contribute` 返回的 disposer。
       *
       * 两者都可用（disposer 是幂等的），但 owner 回收是**权威**的那一条：
       * 它与管理器卸载插件时走的路径一致（`release(owner)`），且不依赖
       * "每加一条工具都记得把 disposer 收进数组"这个纪律——漏收一条就会留一条
       * 指向已卸载插件的工具在表里，而那种工具被调用时会去取一个已经没了的服务。
       */
      tools.release('@geewiki/ai-kb')
    }
  },
}
