/**
 * @geewiki/ai —— GeeWiki AI 问答插件（**检索增强问答的检索-only 形态**）
 *
 * 产品承诺：**没有 API key 时也完整可用**。因此本插件把"检索"与"生成"彻底解耦：
 * 检索永远执行、来源永远返回；只有"回答"这一步会因缺模型而降级为**零成本抽取式摘要**。
 * 有没有 key，响应**结构完全相同**（见 `./types.ts` 的 AskResponse），差别只在
 * `mode` / `degraded` / `answer` 三个字段——前端不必为降级写一套平行的错误分支。
 *
 * 挂载路由（经 @geewiki/http 路由服务）：
 *   POST /api/ai/ask            body { q, limit?, extractive? }
 *   GET  /api/ai/ask?q=&limit=  同语义（便于 curl 排障与可分享链接）
 *   GET  /api/ai/capabilities   前端据此决定是否显示"未配置模型"提示
 *
 * 三个刻意的不做（都有理由，不是遗漏）：
 * 1. **不做流式**：SSE 出口与宿主的排空（drain）契约耦合，必须一起设计（见
 *    docs 的 L-1 排空语义）。本批一次成型返回。
 * 2. **不直连 wiki 的 pages 表**：正文一律经 `search-service.contents()` 取，
 *    否则 wiki 的表结构会变成跨包隐式契约，将来换库/改表要同时改多个包。
 * 3. **不进任何 conflictGroup**：本插件可组合任意 LLM provider，互斥应由 adapter 自己声明。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  closeAfterResponse,
  type GeeWikiManifest,
  type HttpRouterService,
  type RouteHandlerContext,
} from '@geewiki/core'
import { redact, type LlmErrorCode, type LlmService, type LlmUsage } from '@geewiki/llm'
import type { SearchHit, SearchService } from '@geewiki/search'
import { extractiveSummary, type ExtractInput } from './extract.js'
import { buildMessages } from './prompt.js'
import { selectSources } from './select.js'
import { degradedFromCode, makeDegraded } from './degrade.js'
import type { AskResponse, AskSource, CapabilitiesResponse, Degraded } from './types.js'

export type { AskResponse, AskSource, CapabilitiesResponse, Degraded, DegradedReason } from './types.js'
export { buildContext, buildMessages, SYSTEM_PROMPT, type ContextSource } from './prompt.js'
export { selectSources, type Selection, type SelectionOptions } from './select.js'
export { extractiveSummary, EXTRACT_MAX_CHARS, EXTRACT_MAX_SOURCES, type ExtractInput } from './extract.js'
export { CODE_TO_REASON, degradedFromCode, makeDegraded } from './degrade.js'

/* ============================== 配置 ============================== */

export interface AiConfig {
  /** 单次检索取多少条候选（进上下文的条数另由 maxSourcesInContext 限制） */
  retrievalLimit?: number
  maxSourcesInContext?: number
  perSourceChars?: number
  totalContextChars?: number
  maxAnswerTokens?: number
  temperature?: number
  /** 无可用模型时，是否用零成本抽取式摘要作为 answer（关掉则 answer 为 null） */
  extractive?: boolean
}

/**
 * 配置 Schema（schemastery）：驱动管理台表单并在激活/热更新前校验。
 * 同一实例同时用于 `manifest.geewiki.configSchema` 与模块的 `Config`。
 */
export const AiConfigSchema = Schema.object({
  retrievalLimit: Schema.number()
    .default(8)
    .min(1)
    .max(50)
    .description('单次检索取多少条候选（进上下文的条数另由 maxSourcesInContext 限制）'),
  maxSourcesInContext: Schema.number()
    .default(6)
    .min(1)
    .max(20)
    .description('最多几条来源进入模型上下文'),
  perSourceChars: Schema.number()
    .default(1200)
    .min(100)
    .max(10000)
    .description('单条来源正文的字符上限'),
  totalContextChars: Schema.number()
    .default(6000)
    .min(500)
    .max(60000)
    .description('全部来源正文的字符总预算'),
  maxAnswerTokens: Schema.number()
    .default(1024)
    .min(64)
    .max(20000)
    .description('生成回答的最大 token 数'),
  temperature: Schema.number()
    .default(0.2)
    .min(0)
    .max(2)
    .description('采样温度（问答场景宜低，减少自由发挥）'),
  extractive: Schema.boolean()
    .default(true)
    .description('无可用模型时，用零成本抽取式摘要作为回答（关掉则 answer 为 null）'),
})

/** 查询串长度上限：超长查询对检索无益，且会拖长错误信息与日志 */
export const MAX_QUERY_LENGTH = 500

/** 检索条数的硬上限（与 search-service 的契约一致） */
const MAX_LIMIT = 100

export const manifest: GeeWikiManifest = {
  name: '@geewiki/ai',
  version: '0.1.0',
  geewiki: {
    provides: 'ai-service',
    // 一律按**服务标识**依赖（非插件名）：数据库/检索/模型都可整体替换而对本插件透明。
    // 四个依赖也正好是"没有 key 也完整可用"的最小闭环：http + db + search 已足够出结果。
    requires: ['http-service', 'database-provider', 'search-service', 'llm-service'],
    conflictGroup: undefined, // 可组合任意 llm provider
    migrations: undefined, // 无自有表：检索索引归 @geewiki/search
    runtime: {
      supportsHotReload: true, // 无进程内状态
      requiresCachePurge: false,
      drainTimeout: 5,
    },
    configSchema: AiConfigSchema,
  },
}

/* ============================ 服务契约 ============================ */

/** 一条模型路由的对外描述（与 `capabilities()` / `GET /api/ai/capabilities` 里的元素逐字段一致） */
export type AiProviderInfo = CapabilitiesResponse['providers'][number]

/**
 * `ai-service` 服务契约（本插件经 `ctx.provide('ai-service', svc)` 提供）。
 *
 * **为什么必须有这个服务**：manifest 的 `provides: 'ai-service'` 只是依赖图谱里的一个
 * token，**不会创建任何 cordis 服务**。本仓库已有先例教训（`search-service` 与
 * `wiki-service` 都曾"只声明不提供"），症状是消费方 `ctx.get('ai-service')` 恒为
 * `undefined`，且不报错——最终表现为"功能静默不可用"，是最难定位的那类问题。
 *
 * 两个方法都是**端点正在使用的那份实现**（不是平行副本）：端点只做 HTTP 层
 * （读 body、参数校验、状态码翻译），业务一律回到这里，故 REST 与服务的输出**逐字段一致**。
 */
export interface AiService {
  /**
   * 检索增强问答。与 `POST/GET /api/ai/ask` 是**同一份实现**。
   *
   * 与端点一致的语义边界（端点负责把 HTTP 输入转成 `(q, opts)` 并把异常翻成状态码）：
   * - 空查询 / 超长查询**不在这里拦**（那是 HTTP 语义）。直接的空白查询在这里会照常
   *   走完检索并返回 200 + 空结果——调用方应先自行 trim 并判空；
   * - `opts.limit` 非法时抛错（与端点的 400 `invalid_limit` 对应）；
   * - 插件卸载后再调用**显式抛错**（见 `apply` 里的 `assertLive`），绝不返回空结果。
   */
  ask(q: string, opts?: { limit?: number; extractive?: boolean }): Promise<AskResponse>

  /**
   * 能力查询：模型是否可用、为何不可用。与 `GET /api/ai/capabilities` **同一份返回值**
   * （含同样的 `ok: true` 信封，消费方可直接复用，不必自己拼）。
   */
  capabilities(): CapabilitiesResponse
}

/* ============================ 请求体读取 ============================ */

/**
 * 读取 JSON 请求体（1MB 上限）。与 @geewiki/wiki 的同名实现保持一致的**契约**：
 * - 超限：以 `payload_too_large:` 前缀错误拒绝，响应由调用方经统一出口 `h.json(413, …)`
 *   写出（保证计入 stats() 与看门狗探针），随后关闭连接；
 * - 畸形 JSON：`invalid_json:` 前缀（→ 400）。
 */
function readBody(h: RouteHandlerContext, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let rejected = false
    const chunks: Buffer[] = []
    h.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        if (rejected) return
        rejected = true
        h.req.pause() // 不再消费剩余请求体：由调用方写出 413 后关闭连接
        rejectBody(new Error(`payload_too_large: 请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    h.req.on('end', () => {
      if (rejected) return
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        rejectBody(new Error(`invalid_json: ${(err as Error).message}`))
      }
    })
    h.req.on('error', (err) => {
      if (!rejected) rejectBody(err)
    })
  })
}

/* ============================ 插件本体 ============================ */

/** 解析 limit 参数（未给则用默认值）；非法即抛，由调用方转 400 */
function parseLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new Error(`invalid_limit: limit 须为 1..${MAX_LIMIT} 的整数，实际 ${String(raw)}`)
  }
  return n
}

function parseExtractive(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  const s = String(raw).toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  throw new Error(`invalid_extractive: extractive 须为布尔值，实际 ${String(raw)}`)
}

export const AiPlugin = {
  name: '@geewiki/ai',
  /** cordis 约定：声明 Config 后由 cordis 负责校验与默认值填充 */
  Config: AiConfigSchema,

  apply(ctx: Context, config: AiConfig = {}) {
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) throw new Error('@geewiki/ai: http 路由服务不可用（@geewiki/http 未激活）')

    /** 配置快照：写入时已由 schema 填好默认值，这里再兜一层以防直接调用 apply 的测试 */
    const cfg = {
      retrievalLimit: config.retrievalLimit ?? 8,
      maxSourcesInContext: config.maxSourcesInContext ?? 6,
      perSourceChars: config.perSourceChars ?? 1200,
      totalContextChars: config.totalContextChars ?? 6000,
      maxAnswerTokens: config.maxAnswerTokens ?? 1024,
      temperature: config.temperature ?? 0.2,
      extractive: config.extractive ?? true,
    }

    /**
     * 卸载标志：正常路径下卸载会把路由摘掉，但**已经进入处理器**的调用仍会继续跑完。
     * 那种调用必须显式失败，而不是返回一个"看起来正常的空结果"——后者会被误读成
     * "知识库里没有相关内容"，正是最难定位的那类症状（口径同 @geewiki/search）。
     */
    let disposed = false
    /** 卸载后再调用一律显式报错：静默返回空结果会被误读成"知识库里没有相关内容" */
    const assertLive = (): void => {
      if (disposed) {
        throw new Error('@geewiki/ai: 插件已卸载，ai-service 不可再调用（重新激活插件后再用）')
      }
    }
    const cleanups: (() => void)[] = []

    /**
     * 模型生成（**唯一的有意未接线点**）。
     *
     * 本批交付的是"检索-only"形态：没有厂商 adapter，故 `availableProviders()` 为空，
     * 这里必然走降级分支 —— 返回 `text: null` + 降级原因，由调用方改用抽取式摘要。
     *
     * 接线位置就是**这一个函数**：将来 adapter 批次只需在下面的 `for await` 里补齐
     * "按需中断/超时、token 计量口径、SSE 增量外发"这三件事，其余代码无需改动。
     * 现在的实现已经按 `@geewiki/llm` 的终止保证消费整条流（终止 chunk 恰一次且在末位），
     * 因此 `mode` 的语义是诚实的：真的生成了才算 `rag`，中途失败且有部分文本才算 `rag-partial`。
     */
    const generate = async (
      messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[],
    ): Promise<{ text: string; degraded: Degraded | null; usage: LlmUsage | null; partial: boolean }> => {
      const llm = ctx.get('llm-service') as LlmService | undefined
      if (!llm) {
        // requires 里有 llm-service，正常情况下管理器已保证它先激活；这里是防御性分支
        return {
          text: '',
          degraded: makeDegraded('no_provider', null, 'llm-service 不可用（@geewiki/llm 未激活），已降级为检索结果'),
          usage: null,
          partial: false,
        }
      }

      let text = ''
      let usage: LlmUsage | null = null
      let errorCode: LlmErrorCode | null = null
      try {
        for await (const chunk of llm.stream({
          messages,
          maxTokens: cfg.maxAnswerTokens,
          temperature: cfg.temperature,
        })) {
          if (chunk.type === 'text-delta') {
            text += chunk.text
          } else if (chunk.type === 'done') {
            usage = chunk.usage ?? null
            break
          } else if (chunk.type === 'error') {
            errorCode = chunk.code
            break
          }
        }
      } catch (err) {
        // 契约保证 stream 不抛异常；真抛了说明上游违约，按 provider_error 降级而不是让 500
        errorCode = 'PROVIDER_ERROR'
        console.warn(`[@geewiki/ai] llm.stream 意外抛错（已脱敏）: ${redact(err instanceof Error ? err.message : err)}`)
      }

      if (errorCode === null) {
        return { text, degraded: null, usage, partial: false }
      }
      // 有部分文本 = 生成中途失败：如实标注 rag-partial，不要把半截回答当完整回答
      const routes = llm.listProviders()
      const hint =
        routes.length === 0
          ? '当前没有已注册的模型路由'
          : `已注册 ${routes.length} 个路由但均不可用：${routes.map((r) => `${r.label}(${r.route})`).join('、')}`
      return {
        text,
        degraded: degradedFromCode(errorCode, `模型不可用（${errorCode}）：${hint}。检索结果不受影响。`),
        usage,
        partial: text !== '',
      }
    }

    /**
     * 问答主体（**单一实现**）：POST 与 GET 两个端点都走这里。
     * 端点只负责把 HTTP 参数解析成 `(q, opts)` 并把结果包成响应体。
     */
    const ask = async (
      rawQuery: string,
      // `opts` 必须有默认值：AiService 的契约里它是可选的，`svc.ask(q)` 是合法调用。
      // 缺了 `= {}` 会让省略第二参的调用在 `opts.limit` 处抛 TypeError（实测过），
      // 而 TypeError 既不是"已卸载"也不是参数错误，会误导调用方。
      opts: { limit?: number; extractive?: boolean } = {},
    ): Promise<AskResponse> => {
      assertLive()
      const started = Date.now()
      const query = (rawQuery ?? '').trim()
      const limit = opts.limit ?? cfg.retrievalLimit
      const useExtractive = opts.extractive ?? cfg.extractive
      const search = ctx.get('search-service') as SearchService | undefined

      // 检索不可用：仍然返回 200 + 同一结构（前端只有一套渲染路径）
      if (!search) {
        return {
          ok: true,
          query,
          mode: 'retrieval-only',
          degraded: makeDegraded('search_unavailable', null, '检索服务不可用（@geewiki/search 未激活），无法检索知识库'),
          answer: null,
          answerFormat: 'plain',
          sources: [],
          retrieval: { mode: 'like', total: 0, limit },
          usage: null,
          elapsedMs: Date.now() - started,
          partial: false,
        }
      }

      let hits: readonly SearchHit[]
      let retrievalMode: 'fts' | 'like'
      let total: number
      let contents: ReadonlyMap<string, string>
      try {
        const result = search.search(query, { limit })
        hits = result.hits
        retrievalMode = result.mode
        total = result.total
        contents = search.contents(hits.map((h) => h.slug))
      } catch (err) {
        // 服务已被卸载（search 的 assertLive 会显式抛错）或库出问题：同样降级而非 500
        return {
          ok: true,
          query,
          mode: 'retrieval-only',
          degraded: makeDegraded('search_unavailable', null, `检索失败：${(err as Error).message}`),
          answer: null,
          answerFormat: 'plain',
          sources: [],
          retrieval: { mode: 'like', total: 0, limit },
          usage: null,
          elapsedMs: Date.now() - started,
          partial: false,
        }
      }

      const selection = selectSources(hits, contents, {
        maxSourcesInContext: cfg.maxSourcesInContext,
        perSourceChars: cfg.perSourceChars,
        totalContextChars: cfg.totalContextChars,
      })

      // 抽取式摘要用**未截断**的原文定位命中词（命中点可能落在 perSourceChars 之外）
      const extractInputs: ExtractInput[] = selection.selected.map((s) => ({
        slug: s.slug,
        title: s.title,
        text: contents.get(s.slug) ?? '',
      }))

      const model = await generate(buildMessages(query, selection.selected))

      if (model.text !== '') {
        return {
          ok: true,
          query,
          mode: model.partial ? 'rag-partial' : 'rag',
          degraded: model.degraded,
          answer: model.text,
          answerFormat: 'markdown',
          sources: selection.sources,
          retrieval: { mode: retrievalMode, total, limit },
          usage: model.usage,
          elapsedMs: Date.now() - started,
          partial: model.partial,
        }
      }

      const summary = useExtractive ? extractiveSummary(query, extractInputs) : ''
      return {
        ok: true,
        query,
        mode: 'retrieval-only',
        degraded: model.degraded,
        answer: summary === '' ? null : summary,
        answerFormat: 'plain',
        sources: selection.sources,
        retrieval: { mode: retrievalMode, total, limit },
        usage: model.usage,
        elapsedMs: Date.now() - started,
        partial: false,
      }
    }

    /**
     * 能力查询（**单一实现**）：`GET /api/ai/capabilities` 与 `ai-service.capabilities()`
     * 都返回这里的值——端点不再自己拼一份，否则两处迟早漂移。
     */
    const capabilities = (): CapabilitiesResponse => {
      assertLive()
      const llm = ctx.get('llm-service') as LlmService | undefined
      const providers = (llm?.listProviders() ?? []).map((d) => ({
        route: d.route,
        label: d.label,
        vendor: d.vendor,
        model: d.model,
        available: safeAvailable(d.available),
      }))
      const available = providers.some((p) => p.available)
      return {
        ok: true,
        available,
        degraded: !available,
        providers,
        message: available
          ? '模型已就绪，问答将基于知识库检索结果生成回答'
          : redact(
              providers.length === 0
                ? '未注册任何模型路由，问答将以检索结果与抽取式摘要形式提供（不影响可用性）'
                : `未配置可用的模型凭据，问答将以检索结果与抽取式摘要形式提供（已注册路由 ${providers.length} 个，均不可用）`,
            ),
      }
    }

    /** 服务实例：契约见 {@link AiService} */
    const svc: AiService = { ask, capabilities }

    /** 统一的 400/413 出口（错误码与 @geewiki/wiki 的 readBody 前缀约定一致） */
    const failFromError = (h: RouteHandlerContext, err: unknown): void => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('payload_too_large:')) {
        // 剩余请求体未消费：响应刷出后关闭连接（413 仍走统一出口，计入 stats）
        h.json(413, { ok: false, error: 'payload_too_large', message: msg.slice('payload_too_large:'.length).trim() })
        closeAfterResponse(h)
        return
      }
      if (msg.startsWith('invalid_json:')) {
        h.json(400, { ok: false, error: 'invalid_json', message: '请求体不是合法 JSON' })
        return
      }
      const code = msg.split(':')[0] ?? 'invalid_request'
      h.json(400, { ok: false, error: code, message: msg.slice(code.length + 1).trim() || msg })
    }

    /** 参数校验后的公共出口：空查询/超长一律 400，**绝不用 4xx 表达"没有 key"** */
    const handleAsk = async (
      h: RouteHandlerContext,
      params: { q: string; limit?: unknown; extractive?: unknown },
    ): Promise<void> => {
      const q = (params.q ?? '').trim()
      if (q === '') {
        h.json(400, { ok: false, error: 'empty_query', message: '查询串不能为空（请提供 q，且不能只有空白字符）' })
        return
      }
      if (q.length > MAX_QUERY_LENGTH) {
        h.json(400, {
          ok: false,
          error: 'too_long',
          message: `查询串过长（${q.length} 字符，上限 ${MAX_QUERY_LENGTH}）`,
        })
        return
      }
      try {
        const limit = parseLimit(params.limit, cfg.retrievalLimit)
        const extractive = parseExtractive(params.extractive, cfg.extractive)
        // 查询本体完全交给 svc.ask()（单一实现）；端点只管 HTTP 层
        h.json(200, await svc.ask(q, { limit, extractive }))
      } catch (err) {
        failFromError(h, err)
      }
    }

    cleanups.push(
      router.register('POST', '/api/ai/ask', async (h: RouteHandlerContext) => {
        try {
          const body = (await readBody(h)) as Record<string, unknown>
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            h.json(400, { ok: false, error: 'invalid_body', message: '请求体须为 JSON 对象' })
            return
          }
          const unknownKeys = Object.keys(body).filter((k) => k !== 'q' && k !== 'limit' && k !== 'extractive')
          if (unknownKeys.length > 0) {
            h.json(400, { ok: false, error: 'invalid_body', message: `未知字段: ${unknownKeys.join(', ')}` })
            return
          }
          if (typeof body['q'] !== 'string') {
            h.json(400, { ok: false, error: 'empty_query', message: '请求体缺少字符串字段 q' })
            return
          }
          await handleAsk(h, { q: body['q'], limit: body['limit'], extractive: body['extractive'] })
        } catch (err) {
          failFromError(h, err)
        }
      }),
    )

    cleanups.push(
      router.register('GET', '/api/ai/ask', async (h: RouteHandlerContext) => {
        await handleAsk(h, {
          q: h.url.searchParams.get('q') ?? '',
          limit: h.url.searchParams.get('limit') ?? undefined,
          extractive: h.url.searchParams.get('extractive') ?? undefined,
        })
      }),
    )

    cleanups.push(
      router.register('GET', '/api/ai/capabilities', (h: RouteHandlerContext) => {
        try {
          // 与 ai-service.capabilities() 同一份返回值（含 ok 信封），端点不另拼一份
          h.json(200, svc.capabilities())
        } catch (err) {
          failFromError(h, err)
        }
      }),
    )

    // 真正创建 cordis 服务：manifest 的 provides 只是依赖图 token，不会建服务。
    // 两者名字**必须一致**（'ai-service'），否则消费方 ctx.get 拿到 undefined，
    // 表现为"AI 功能静默不可用"这类极难定位的症状（同 @geewiki/search 的教训）。
    const unprovide = ctx.provide('ai-service', svc)

    console.log(
      '[@geewiki/ai] 已激活: POST/GET /api/ai/ask、GET /api/ai/capabilities、ai-service 服务（检索-only 降级可用）',
    )
    return () => {
      // 先立"已卸载"标志：此后任何仍持有 svc 引用的调用都会显式报错而非返回空结果
      disposed = true
      cleanups.forEach((fn) => fn())
      cleanups.length = 0
      unprovide()
      console.log('[@geewiki/ai] 已卸载: REST 路由已摘除，ai-service 已注销')
    }
  },
}

/** `available()` 抛错不应拖垮能力查询：视为不可用（与 llm-service 内部口径一致） */
function safeAvailable(fn: () => boolean): boolean {
  try {
    return fn() === true
  } catch {
    return false
  }
}
