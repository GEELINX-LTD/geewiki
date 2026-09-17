/**
 * `@geewiki/ai-summary` —— 每篇文章的自动摘要（用户需求 ③④）。
 *
 * ## 它做三件事
 * 1. **跟着正文走**：订阅 `PAGE_SAVED_EVENT`，去抖后重新生成那一页的摘要；
 * 2. **能被检索**：把摘要文本按片段打分检索，并把它作为两条工具
 *    （`get_summary` / `search_summaries`）交给 AI 助手；
 * 3. **供界面显示**：`GET /api/ai/summary?slug=…` 是 `article-summary` 插槽那张
 *    折叠卡的唯一数据源。
 *
 * ## 三条必须记住的裁决
 *
 * **① 摘要是从"这一页最宽的那档读者"的投影生成的，而且只对 public/org 两档生成。**
 * 见 {@link projectedFor}。用一个通用主体去投影，而不是用"某个真实用户"的身份 —
 * 后者会让摘要的保密性完全依赖读路径将来不放宽，而那是一条**迟早会松**的依赖。
 * 没有任何通用主体能读的页面（`visibility='private'`、仅靠逐人授权可见）**不生成摘要**：
 * 卡片显示"暂不支持"，而不是显示一份可能含有他人可见内容的概述。
 *
 * **② 过期用内容哈希判，不用时间戳。** 见 `plan.ts` 的 `isStale`。
 *
 * **③ 没有可用模型时整张卡片不渲染。** `available: false` 与 `summary: null` 是两件事：
 * 前者是"这个功能此刻不存在"，后者是"这一页还没生成"。把它们混成一种表现，
 * 读者会在一张永远转不出结果的卡片上学会不再看摘要——连带真正有摘要的页面一起被忽略。
 *
 * ## 为什么检索不走 FTS5
 * 摘要一页一条、默认上限 300 字符，于是"按摘要检索"是一条覆盖全表的 LIKE 扫描。
 * 它比维护第二份 FTS 索引更便宜，而且**方言中立**（PG 上照样工作，
 * 不需要 `@geewiki/search` 那种"非 sqlite 直接抛错"的守卫）。
 * 代价记在 `migrations/0001_page_summaries.sql` 里：条目到十万量级要换真索引。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asAsync } from '@geewiki/core'
import type { Context } from 'cordis'
import {
  anonymousPrincipal,
  PAGE_SAVED_EVENT,
  type DatabaseAdapter,
  type GeeWikiManifest,
  type HttpRouterService,
  type PageSavedEvent,
  type Principal,
  type RouteHandlerContext,
} from '@geewiki/core'
import { noModelDegraded, type LlmService } from '@geewiki/llm'
import type { AiToolResult, AiToolService } from '@geewiki/ai-tools'
import {
  buildSummaryMessages,
  cleanSummary,
  hashOf,
  isStale,
  likePatternsOf,
  MAX_CANDIDATES,
  queryGrams,
  scoreSummary,
} from './plan.js'
import {
  AiSummaryConfigSchema,
  DEFAULT_SEARCH_LIMIT,
  MAX_QUERY_CHARS,
  MAX_SEARCH_LIMIT,
  MAX_SLUG_CHARS,
  PLUGIN_NAME,
  SUMMARY_CAPABILITIES_PATH,
  SUMMARY_PATH,
  SUMMARY_SEARCH_PATH,
  type SummaryAudience,
  type SummaryHit,
  type SummaryView,
} from './types.js'

export const SUMMARY_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/* ============================== 结构型依赖（照 WikiServiceLike 的先例，测试可注入替身） ============================== */

interface WikiPageLike {
  slug: string
  title: string
  content: string
  updated_at: string
}
interface WikiServiceLike {
  get(slug: string, principal: Principal, opts?: { rawContent?: boolean }): Promise<WikiPageLike | undefined>
}
interface PageAccessLike {
  level: 'none' | 'summary' | 'full'
  canEdit: boolean
}
interface PolicyServiceLike {
  resolvePage(principal: Principal, slug: string): Promise<PageAccessLike>
  resolvePages(principal: Principal, slugs: readonly string[]): Promise<Map<string, PageAccessLike>>
  /** 与主体无关的页面档位：0 = 匿名可见 / 1 = 组织内可见 / null = 没有通用主体能看 */
  effectiveIndexLevel(slug: string): Promise<0 | 1 | null>
}

/* ============================== 存储行 ============================== */

interface SummaryRow {
  page_id: number
  slug: string
  summary: string
  audience: string
  model: string
  source_hash: string
  generated_at: string
}

/* ============================== 主体构造 ============================== */

/**
 * 组织成员的**投影主体**。
 *
 * ⚠️ 这里在造一个 `userId: 0` 的主体，看起来像伪造身份。它不是：
 * 我们要问的问题是"**组织里的一个普通成员在这一页上看到什么**"，而这个问题
 * 只有主体能问（`wiki-service` 的读路径一律要求主体，这是刻意的设计——
 * "忘了传"会静默退化成"不过滤"）。
 *
 * 三处刻意的取值：
 * - `userId: 0` 而**不是**某个真实用户的 id —— 用一个真实用户的身份去读，
 *   读到的可能是**那个人额外被授权**的块，而摘要会被所有组织成员看到。
 * - `orgRole: 'member'` 而**不是** `'owner'` —— 取该组织里**权限最小**的那种成员：
 *   owner/admin 有应急覆盖（设计规则 O1），那会读到更多。
 * - `sessionId: null` —— 会话不参与可见性判定。
 */
function orgMemberPrincipal(orgId: number): Principal {
  return { kind: 'user', userId: 0, orgId, orgRole: 'member', groupIds: [], sessionId: null }
}

/* ============================== 插件 ============================== */

export interface AiSummaryPluginOptions {
  /**
   * 测试专用：覆盖去抖定时器（`setTimeout` / `clearTimeout`）。
   *
   * 与 `@geewiki/ai-qa` 的超时常量同一条约定：**不进 `configSchema`**。
   * 它不是给运维调的参数，而是给测试的注入口——暴露出去只会让人以为"调它有用"。
   */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
}

export const AiSummaryPlugin = {
  name: PLUGIN_NAME,
  /** ★ F19：改为 async —— apply 里要 await 迁移与若干现取查询（PG 驱动本质异步）。 */
  async apply(ctx: Context, rawConfig: unknown = {}, options: AiSummaryPluginOptions = {}) {
    const config = AiSummaryConfigSchema(rawConfig ?? {})
    const timers = options.timers ?? {
      set: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }

    const db = ctx.get('db') as DatabaseAdapter | undefined
    if (!db) {
      throw new Error(`${PLUGIN_NAME}: database-provider 不在（requires 已声明，正常不会发生）`)
    }
    // ★ F19：PG 适配器的 migrate 返回 Promise；不 await 就是"迁移还在跑、路由已挂上"的竞态
    await asAsync(db).migrate(SUMMARY_MIGRATIONS_DIR)

    const cleanups: (() => void)[] = []
    const wiki = (): WikiServiceLike | undefined => ctx.get('wiki-service') as WikiServiceLike | undefined
    const policy = (): PolicyServiceLike | undefined => ctx.get('policy-service') as PolicyServiceLike | undefined
    const tools = (): AiToolService | undefined => ctx.get('ai-tool-service') as AiToolService | undefined
    const llm = (): LlmService | undefined => ctx.get('llm-service') as LlmService | undefined

    /** 卸载后任何仍持有引用的调用都要显式报错，而不是返回空结果（与 wiki-service 同口径） */
    let disposed = false
    const assertLive = (): void => {
      if (disposed) throw new Error(`${PLUGIN_NAME}: 插件已卸载，ai-summary 不可再调用`)
    }

    /* ------------------------------ 投影 ------------------------------ */

    /**
     * 生成摘要时应当依据的**正文投影**（见文件头裁决 ①）。
     *
     * 返回值里的 `audience` 会写进库里，因为它是**审计信息**：
     * 事后要能回答"这份摘要是照着谁看得见的那一份写的"。
     */
    const projectedFor = async (
      slug: string,
    ): Promise<{ page: WikiPageLike; content: string; audience: SummaryAudience; orgId: number | null } | null> => {
      const p = policy()
      const w = wiki()
      if (!p || !w) return null
      const level = await p.effectiveIndexLevel(slug)
      if (level === null) return null // 没有通用主体能读 ⇒ 不生成（见文件头裁决 ①）
      let audience: SummaryAudience
      let reader: Principal
      let orgId: number | null = null
      if (level === 0) {
        audience = 'public'
        reader = anonymousPrincipal()
      } else {
        audience = 'org'
        /*
         * 单组织部署（`Principal.orgId` 的注释：单组织阶段恒为 1），故取库里第一个组织。
         * 查不到组织 ⇒ 组织档的投影**问不出来** ⇒ 不生成。这里刻意不回落成匿名：
         * 那会拿"公开可见的那一部分"去给一篇组织内文章写摘要，读者看到的是**残缺的概述**，
         * 而残缺的概述比没有概述更容易让人以为这一页就讲了这么多。
         */
        const org = (await db.query<{ id: number }>('SELECT id FROM orgs ORDER BY id LIMIT 1'))[0]
        if (!org) return null
        orgId = org.id
        reader = orgMemberPrincipal(org.id)
      }
      const page = await w.get(slug, reader)
      if (!page) return null
      return { page, content: page.content, audience, orgId }
    }

    /* ------------------------------ 存储 ------------------------------ */

    // ★ F19：async —— `db.query` 在 PG 上返回 Promise（同步签名只对 SQLite 成立）
    const readStored = async (slug: string): Promise<SummaryRow | undefined> =>
      (await db.query<SummaryRow>('SELECT * FROM page_summaries WHERE slug = ?', [slug]))[0]

    /**
     * 写入（重算走 UPDATE 而不是 INSERT 第二行）。
     *
     * `page_id` 由 slug 现查：**摘要不属于"这一页曾经是那个 id"**，而属于现在这一页。
     * 用 `INSERT ... ON CONFLICT(page_id)` 语义（SQLite 与 PG 都支持 `ON CONFLICT DO UPDATE`，
     * 且这里的 `?` 占位符由各自方言适配层处理）。
     */
    // ★ F19：async（同上：两条语句都要 await）
    const store = async (
      slug: string,
      row: { summary: string; audience: SummaryAudience; model: string; sourceHash: string },
    ): Promise<void> => {
      const page = (await db.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]))[0]
      if (!page) return
      await db.run(
        `INSERT INTO page_summaries (page_id, slug, summary, audience, model, source_hash, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           slug = excluded.slug,
           summary = excluded.summary,
           audience = excluded.audience,
           model = excluded.model,
           source_hash = excluded.source_hash,
           generated_at = excluded.generated_at`,
        [page.id, slug, row.summary, row.audience, row.model, row.sourceHash, new Date().toISOString()],
      )
    }

    /* ------------------------------ 生成 ------------------------------ */

    /**
     * 生成一页的摘要并落库。返回一句话结果，供端点与队列分别处理。
     *
     * **它不判权限**：调用方判（端点判编辑权、事件队列信任"保存已经通过了写路径"）。
     * 在这里再判一次需要主体，而队列这一路没有主体——硬造一个只会让"到底谁有权"
     * 这件事在两个地方各有一套答案。
     */
    const generate = async (
      slug: string,
    ): Promise<{ ok: true; summary: string } | { ok: false; error: string; message: string }> => {
      assertLive()
      const pre = noModelDegraded(llm(), '。AI 摘要需要可用的模型')
      if (pre !== null) return { ok: false, error: 'model_unavailable', message: pre.message }
      const projected = await projectedFor(slug)
      if (!projected) return { ok: false, error: 'not_projectable', message: '这一页没有可依据的读者投影（不存在或不可见）' }
      const { page, content, audience } = projected
      const service = llm()
      if (!service) return { ok: false, error: 'model_unavailable', message: 'llm-service 不可用' }

      const messages = buildSummaryMessages(page.title, content, config.maxSourceChars)
      let raw = ''
      let model = ''
      let failed: string | null = null
      for await (const chunk of service.stream({ messages })) {
        if (chunk.type === 'status') model = chunk.model
        else if (chunk.type === 'text-delta') raw += chunk.text
        else if (chunk.type === 'done') {
          model = chunk.model
          break
        } else if (chunk.type === 'error') {
          failed = chunk.code
          break
        }
      }
      if (failed !== null) return { ok: false, error: 'generation_failed', message: `模型调用失败（${failed}）` }
      const summary = cleanSummary(raw, config.maxSummaryChars)
      /*
       * 空摘要**不落库**，而是明确失败。理由与 `@geewiki/ai-qa` 删掉 `retrieval-only`
       * 那一次完全相同：一张空白卡片会被读成"这一页没内容"，而真相是"这次生成没成功"。
       * 库里留下上一次的摘要（如果有）比覆盖成空更有用——它至少是真的。
       */
      if (summary === '') return { ok: false, error: 'empty_summary', message: '模型没有给出可用的摘要（输出为空）' }
      await store(slug, { summary, audience, model: model || 'unknown', sourceHash: hashOf(content) })
      return { ok: true, summary }
    }

    /* ------------------------------ 队列（保存 ⇒ 重算） ------------------------------ */

    /** 每个 slug 一个待办定时器；同页连续保存合并成一次生成 */
    const pending = new Map<string, unknown>()
    /** 正在生成的 slug：同一页不并发生成两次（第二次的输入与第一次相同，纯浪费） */
    const running = new Set<string>()
    /** 生成中被再次排队的 slug：跑完再补一次（否则中间那次保存的内容永远不会被摘要） */
    const requeued = new Set<string>()

    const runOne = async (slug: string): Promise<void> => {
      if (running.has(slug)) {
        requeued.add(slug)
        return
      }
      running.add(slug)
      try {
        const result = await generate(slug)
        if (!result.ok) {
          // 生成失败**不是异常路径**：没有模型是常态（默认部署就没有密钥）。
          // 用 warn 而不是 error，且不抛出——队列里的异常会变成未处理的 rejection。
          console.warn(`[${PLUGIN_NAME}] ${slug} 的摘要未能生成：${result.error} — ${result.message}`)
        }
      } catch (err) {
        console.warn(`[${PLUGIN_NAME}] ${slug} 的摘要生成抛错（已忽略）:`, err)
      } finally {
        running.delete(slug)
        if (requeued.delete(slug)) void runOne(slug)
      }
    }

    const schedule = (slug: string): void => {
      if (disposed) return
      const existing = pending.get(slug)
      if (existing !== undefined) timers.clear(existing)
      pending.set(
        slug,
        timers.set(() => {
          pending.delete(slug)
          void runOne(slug)
        }, config.debounceMs),
      )
    }

    /**
     * 订阅保存事件。
     *
     * **整个处理器同步返回、异常全部吞掉**：`ctx.emit` 是同步广播（见 core 里该常量的注释），
     * 订阅者抛错会冒回**保存端点**——一次已经写进库的保存会因此返回 500，
     * 调用方重试就写两遍。这里是本插件唯一能造成那种后果的地方，故 `schedule` 之外不做事。
     */
    const onSaved = (event: unknown): void => {
      try {
        if (!config.autoGenerate) return
        const e = event as Partial<PageSavedEvent> | undefined
        const slug = typeof e?.slug === 'string' ? e.slug : ''
        if (slug === '' || slug.length > MAX_SLUG_CHARS) return
        schedule(slug)
      } catch (err) {
        console.warn(`[${PLUGIN_NAME}] 处理 ${PAGE_SAVED_EVENT} 时抛错（已忽略，保存本身不受影响）:`, err)
      }
    }
    /*
     * 监听器的注销**必须进 cleanups**：热重载下插件会被卸载再装回来，
     * 而没摘掉的监听器会在下一次保存时对着一个已经 disposed 的实例调 schedule ——
     * 表现是"重载后每保存一次就多一条警告"，或者更糟：旧实例抢在新实例之前写库。
     * 这个洞是写测试时发现的（当时 `apply` 被直接调用，没有任何东西替我收尾）。
     */
    cleanups.push(ctx.on(PAGE_SAVED_EVENT, onSaved))

    /* ------------------------------ 端点 ------------------------------ */

    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error(`${PLUGIN_NAME}: http-service 不在`)

    const json = (h: RouteHandlerContext, status: number, body: unknown): void => h.json(status, body)

    /** 读一个查询参数（`RouteHandlerContext` 上没有 `h.query`，只有 `h.url`——本仓踩过） */
    const param = (h: RouteHandlerContext, name: string): string => h.url.searchParams.get(name) ?? ''

    const modelReady = (): boolean => noModelDegraded(llm(), '') === null

    /**
     * `GET /api/ai/summary?slug=…` —— **卡片唯一的数据源**。
     *
     * 访问级别保持 `public`：匿名读者看得见的公开页面，其摘要也该看得见
     * （需求 ④ 没有"仅登录用户"这个限定）。能读到什么由下面两次判定决定：
     * ① 这一页对**当前主体**可不可读；② 摘要本身是按哪一档投影生成的（生成时已定）。
     */
    cleanups.push(
      router.register('GET', SUMMARY_PATH, async (h) => {
        const slug = param(h, 'slug').trim()
        if (slug === '' || slug.length > MAX_SLUG_CHARS) {
          return json(h, 400, { ok: false, error: 'invalid_slug', message: 'slug 必填且不超过 512 字符' })
        }
        const p = policy()
        if (!p) return json(h, 503, { ok: false, error: 'policy_unavailable', message: '策略层不可用' })
        const principal = h.principal ?? anonymousPrincipal()
        const access = await p.resolvePage(principal, slug)
        /*
         * 读不到就 404（不是 403）：这与 `wiki-service.get` 的既有口径一致——
         * "不存在"与"无权"给同一个回答，不泄露存在性。
         */
        if (access.level === 'none') {
          return json(h, 404, { ok: false, error: 'not_found', message: '条目不存在或无权访问' })
        }

        const available = modelReady()
        const stored = await readStored(slug)
        /*
         * 过期判定要拿**当前**投影再算一次哈希。这里刻意用与生成时**同一档**的投影
         * （而不是当前读者看得见的那一份）：否则一个能看见更多块的读者会把它判成"没过期"，
         * 而一个看得更少的读者会把它判成"过期"——同一份摘要，两个人看到两种状态。
         */
        const projected = await projectedFor(slug)
        const currentHash = projected ? hashOf(projected.content) : null
        const stale = stored !== undefined && currentHash !== null && isStale(stored.source_hash, currentHash)

        const canRegenerate = available && access.canEdit && projected !== null
        const view: SummaryView = {
          ok: true,
          available,
          slug,
          title: projected?.page.title ?? null,
          summary: stored?.summary ?? null,
          stale,
          generatedAt: stored?.generated_at ?? null,
          model: stored?.model ?? null,
          audience: (stored?.audience as SummaryAudience | undefined) ?? null,
          canRegenerate,
          ...(available
            ? canRegenerate
              ? {}
              : { reason: projected === null ? '这一页不支持自动摘要（没有可依据的读者投影）' : '需要有这一页的编辑权限才能重新生成' }
            : { reason: '当前没有可用的模型，摘要功能不可用' }),
        }
        json(h, 200, view)
      }, { access: 'public' }),
    )

    /**
     * `POST /api/ai/summary` body `{slug}` —— **显式**重算（卡片上的「重新生成」）。
     *
     * 与自动生成的权限判据**不同**：自动那一半由保存路径授权（能保存的人本来就有写权），
     * 而这里必须**自己判编辑权**——否则任何人都能用一次点击让别人花钱。
     *
     * 顺序即语义：先校验输入 → 再判权限 → 再看模型 → 最后才调模型。
     * 反过来会让"没配密钥"变成一条**权限探测通道**（无编辑权的人也能从响应差异里
     * 分辨出这一页存不存在、自己能不能改）——这条纪律在 `@geewiki/ai-assist` 的文件头
     * 记过一次，此处照办。
     */
    cleanups.push(
      router.register('POST', SUMMARY_PATH, async (h) => {
        let body: unknown
        try {
          body = await readBody(h)
        } catch (err) {
          return json(h, 400, { ok: false, error: 'invalid_body', message: err instanceof Error ? err.message : '' })
        }
        const slug = typeof (body as { slug?: unknown } | null)?.slug === 'string' ? (body as { slug: string }).slug.trim() : ''
        if (slug === '' || slug.length > MAX_SLUG_CHARS) {
          return json(h, 400, { ok: false, error: 'invalid_slug', message: 'slug 必填且不超过 512 字符' })
        }
        const p = policy()
        if (!p) return json(h, 503, { ok: false, error: 'policy_unavailable', message: '策略层不可用' })
        const principal = h.principal ?? anonymousPrincipal()
        if (principal.kind === 'anonymous') {
          return json(h, 401, { ok: false, error: 'unauthorized', message: '需要登录后操作' })
        }
        const access = await p.resolvePage(principal, slug)
        // 匿名与"登录了但读不到"给同一个 404；读得到但不能编辑给 403
        if (access.level === 'none') return json(h, 404, { ok: false, error: 'not_found', message: '条目不存在或无权访问' })
        if (!access.canEdit) {
          return json(h, 403, { ok: false, error: 'forbidden', message: '没有编辑这一页的权限，无法重新生成摘要' })
        }
        if (!modelReady()) {
          return json(h, 503, { ok: false, error: 'model_unavailable', message: '当前没有可用的模型，无法生成摘要' })
        }
        const result = await generate(slug)
        if (!result.ok) {
          // 502 = 调用了模型但它失败了；其余（不可投影）是前置条件不满足 ⇒ 503
          const status = result.error === 'generation_failed' || result.error === 'empty_summary' ? 502 : 503
          return json(h, status, { ok: false, error: result.error, message: result.message })
        }
        const stored = await readStored(slug)
        json(h, 200, {
          ok: true,
          slug,
          summary: result.summary,
          generatedAt: stored?.generated_at ?? null,
          model: stored?.model ?? null,
          audience: (stored?.audience as SummaryAudience | undefined) ?? null,
        })
      }, { access: 'public' }),
    )

    /**
     * `GET /api/ai/summary/search?q=&limit=` —— 按摘要检索。
     *
     * 它**不是**给模型专用的接口：需求 ③ 说的"按摘要检索"是一种能力，
     * 人应该也能用（也正因为它存在，验收脚本才能直接断言召回，而不必绕一圈模型）。
     * 访问级别 `public`，但结果**逐条按可见性过滤**——公开页面谁都能搜到，
     * 组织内页面只有成员搜得到。
     */
    cleanups.push(
      router.register('GET', SUMMARY_SEARCH_PATH, async (h) => {
        const q = param(h, 'q').trim()
        if (q === '') return json(h, 400, { ok: false, error: 'invalid_query', message: 'q 必填' })
        if (q.length > MAX_QUERY_CHARS) {
          return json(h, 400, { ok: false, error: 'invalid_query', message: `q 不超过 ${MAX_QUERY_CHARS} 字符` })
        }
        const rawLimit = param(h, 'limit')
        const limit = rawLimit === '' ? DEFAULT_SEARCH_LIMIT : Number(rawLimit)
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
          return json(h, 400, { ok: false, error: 'invalid_limit', message: `limit 必须是 1..${MAX_SEARCH_LIMIT} 的整数` })
        }
        const p = policy()
        if (!p) return json(h, 503, { ok: false, error: 'policy_unavailable', message: '策略层不可用' })
        const principal = h.principal ?? anonymousPrincipal()
        const hits = await searchSummaries(principal, q, limit)
        json(h, 200, { ok: true, query: q, total: hits.length, hits })
      }, { access: 'public' }),
    )

    /**
     * `GET /api/ai/summary/capabilities` —— 只回答一件事：有没有能写摘要的模型。
     *
     * 与两个 AI 插件各自拥有 capabilities 的口径一致：**界面只问自己所属的插件**。
     */
    cleanups.push(
      router.register('GET', SUMMARY_CAPABILITIES_PATH, (h) => {
        const pre = noModelDegraded(llm(), '。AI 摘要需要可用的模型')
        json(h, 200, {
          ok: true,
          available: pre === null,
          degraded: pre,
          autoGenerate: config.autoGenerate,
        })
      }, { access: 'public' }),
    )

    /* ------------------------------ 检索 ------------------------------ */

    /**
     * 按摘要检索：**SQL 粗筛 + JS 精排**。
     *
     * 分两步的理由：SQL 那侧的 `LIKE` 只回答"这个片段在不在"，
     * 而排序要的是"命中了几个不同片段"。把排序交给 SQL 需要一串 `CASE WHEN`
     * （每个片段一条），那既难读又随片段数膨胀；取回至多 {@link MAX_CANDIDATES} 行
     * 在内存里打分是可控的。
     *
     * **可见性过滤必须逐条做**：先按 `policy.resolvePages` 一次性问出当前主体
     * 对这 N 个 slug 的等级，再丢掉 `level === 'none'` 的。不要试图在 SQL 里过滤——
     * 可见性判定是策略层的事，在 SQL 里重写一遍就是第二份判据（本仓反复记过这条）。
     */
    const searchSummaries = async (principal: Principal, query: string, limit: number): Promise<SummaryHit[]> => {
      assertLive()
      const p = policy()
      if (!p) return []
      const grams = queryGrams(query)
      const patterns = likePatternsOf(query)
      /*
       * 切不出片段（例如查询是一个单字）时退化成"整串 LIKE"：
       * 空 patterns 会让 SQL 变成 `WHERE 1=1`（返回全表），那比返回空更糟——
       * 用户搜「的」会得到全部摘要，看起来像检索坏了。
       */
      const effective = patterns.length > 0 ? patterns : [`%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`]
      const where = effective.map(() => `summary LIKE ? ESCAPE '\\'`).join(' OR ')
      const rows = db.query<SummaryRow & { title: string | null }>(
        `SELECT s.*, p.title AS title
           FROM page_summaries s
           LEFT JOIN pages p ON p.id = s.page_id
          WHERE ${where}
          LIMIT ?`,
        [...effective, MAX_CANDIDATES],
      )
      if (rows.length === 0) return []
      const access = await p.resolvePages(
        principal,
        rows.map((r) => r.slug),
      )
      const hits: SummaryHit[] = []
      for (const row of rows) {
        const a = access.get(row.slug)
        if (!a || a.level === 'none') continue
        hits.push({
          slug: row.slug,
          title: row.title ?? row.slug,
          summary: row.summary,
          score: scoreSummary(grams, row.summary),
          generatedAt: row.generated_at,
        })
      }
      // 分数相同时按 slug 稳定排序：顺序不稳会让"同一次查询两次结果不同"，也让前缀缓存失效
      hits.sort((a, b) => (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      return hits.slice(0, limit)
    }

    /* ------------------------------ 工具 ------------------------------ */

    const aiTools = tools()
    if (!aiTools) throw new Error(`${PLUGIN_NAME}: ai-tool-service 不在`)

    const contribute = (tool: Parameters<AiToolService['contribute']>[1]): void => {
      cleanups.push(aiTools.contribute(PLUGIN_NAME, tool))
    }

    contribute({
      descriptor: {
        name: 'get_summary',
        description:
          '取某一页的摘要（一段话的概述）。想知道某个 slug 讲了什么、又不想读全文时用它，比 read_page 便宜得多。' +
          '摘要可能还没生成（返回里会说明），那就改用 read_page。',
        parameters: {
          type: 'object',
          properties: { slug: { type: 'string', description: '页面的 slug，例如 getting-started' } },
          required: ['slug'],
          additionalProperties: false,
        },
        side: 'server',
        available: (principal: Principal) => principal.kind !== 'anonymous',
      },
      execute: async (principal, args): Promise<AiToolResult> => {
        const slug = typeof (args as { slug?: unknown } | null)?.slug === 'string' ? (args as { slug: string }).slug.trim() : ''
        if (slug === '') return { content: '需要给 slug。可以用 list_pages 找到 slug。' }
        const p = policy()
        if (!p || !wiki()) return { content: '摘要服务当前不可用（策略层或知识库服务不在）。' }
        const access = await p.resolvePage(principal, slug)
        if (access.level === 'none') return { content: `找不到 ${slug}，或者你没有权限看它。` }
        const stored = await readStored(slug)
        if (!stored) {
          return {
            content:
              `《${slug}》还没有生成摘要。` +
              '可以直接用 read_page 读它，或者用 search_summaries 找找别的地方有没有讲这件事。',
          }
        }
        const projected = await projectedFor(slug)
        const stale = projected !== null && isStale(stored.source_hash, hashOf(projected.content))
        return {
          content:
            `《${projected?.page.title ?? slug}》（${slug}）的摘要` +
            (stale ? '（注意：正文在这份摘要之后改过，摘要可能已经过时）' : '') +
            `：\n${stored.summary}`,
          // 摘要是知识库自己的内容 ⇒ 算有依据（需求 ⑥ 的标注据此不打）
          grounding: 'kb',
        }
      },
    })

    contribute({
      descriptor: {
        name: 'search_summaries',
        description:
          '用**自然语言的问法**在全部页面摘要里检索，返回最相关的几页。' +
          '问"怎么做某件事"、用词与正文不一致时，它比 search_kb 更容易命中——' +
          '摘要是用自然语言写的，正文里往往是术语和按钮名。' +
          '拿到 slug 后可以用 read_page 读全文。',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: '自然语言的问句或几个关键词' },
            limit: { type: 'number', description: `返回几条，1..${MAX_SEARCH_LIMIT}，默认 ${DEFAULT_SEARCH_LIMIT}` },
          },
          required: ['q'],
          additionalProperties: false,
        },
        side: 'server',
        available: (principal: Principal) => principal.kind !== 'anonymous',
      },
      execute: async (principal, args): Promise<AiToolResult> => {
        const q = typeof (args as { q?: unknown } | null)?.q === 'string' ? (args as { q: string }).q.trim() : ''
        if (q === '') return { content: '需要给 q（要检索的问句或关键词）。' }
        const rawLimit = (args as { limit?: unknown } | null)?.limit
        const limit =
          typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_SEARCH_LIMIT
            ? rawLimit
            : DEFAULT_SEARCH_LIMIT
        const hits = await searchSummaries(principal, q, limit)
        if (hits.length === 0) {
          return {
            content:
              `摘要检索没有命中（query=${q}）。` +
              '可以换更通用的说法再试；也可以用 list_pages 看目录、或用 search_kb 按正文里的原词检索。',
          }
        }
        const body = hits.map((hit, i) => `[${i + 1}] ${hit.title}（${hit.slug}）\n${hit.summary}`).join('\n\n')
        return { content: `摘要检索命中 ${hits.length} 条：\n\n${body}`, grounding: 'kb' }
      },
    })

    /* ------------------------------ 卸载 ------------------------------ */

    return () => {
      disposed = true
      for (const handle of pending.values()) timers.clear(handle)
      pending.clear()
      /*
       * **不等待正在跑的生成**：它会自己跑完（`llm.stream` 有上游超时），
       * 而在这里 await 会把卸载卡在最长 120 秒的网络等待上。
       * 代价是一次"已卸载插件仍写了一次库"——那张表是本插件自己的，没有别人会读到坏状态。
       */
      for (const fn of cleanups.splice(0)) {
        try {
          fn()
        } catch (err) {
          console.warn(`[${PLUGIN_NAME}] 卸载清理抛错（已忽略）:`, err)
        }
      }
    }
  },
}

/**
 * 读取 JSON 请求体（上限 64KB，与仓库其它插件的同名函数同范式）。
 *
 * 摘要的请求体只有一个 slug，64KB 是"绝无可能不够、也绝无可能被用来打内存"的量级。
 */
function readBody(h: RouteHandlerContext, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks: Buffer[] = []
    h.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        h.req.pause()
        rejectBody(new Error(`请求体超过 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    })
    h.req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolveBody({})
      try {
        resolveBody(JSON.parse(text))
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'))
      }
    })
    h.req.on('error', (err) => rejectBody(err))
  })
}

export const manifest: GeeWikiManifest = {
  /*
   * 字面量而**不是** `PLUGIN_NAME`：本仓的守卫测试直接读源码比对插件名与目录名
   * （`packages/web/test/pluginUi.test.ts` 第一条），写成常量会让那条守卫认不出来
   * —— 而"守卫认不出来"的表现是它**保持绿色**，这比红更糟。
   * `PLUGIN_NAME` 仍用于工具总线的 owner 与日志前缀。
   */
  name: '@geewiki/ai-summary',
  version: '0.1.0',
  geewiki: {
    displayName: 'AI 摘要',
    description: '为每篇文章自动生成摘要、按摘要检索，并在文章顶部以折叠卡显示',
    // 刻意**不 provide 任何服务**：当前零消费方，为不存在的消费方设计接口
    // 等于凭空造一份没有测试的契约（同 `@geewiki/ai-assistant` / `@geewiki/ai-kb` 的口径）。
    provides: undefined,
    requires: ['http-service', 'database-provider', 'wiki-service', 'policy-service', 'llm-service', 'ai-tool-service'],
    conflictGroup: undefined,
    // 自己的迁移（`page_summaries`）。内置插件的迁移目录在组合根硬编码，
    // manifest 该字段对外部插件生效；故 registry 里要给它 `migrationsDirs`。
    migrations: './migrations',
    runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 5 },
    configSchema: AiSummaryConfigSchema,
    client: { entry: 'client.js', css: 'client.css' },
    slots: ['article-summary'],
  },
}
