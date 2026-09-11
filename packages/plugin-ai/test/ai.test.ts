/**
 * @geewiki/ai 的集成测试（检索-only 形态 + 降级契约）。
 *
 * **测试策略**（与 @geewiki/search 保持一致，理由相同）：真实 SQLite 临时库 + 真实迁移 +
 * 真实 `@geewiki/search` 插件 + **真实 `@geewiki/llm` 服务**（`createLlmService()`，不注册任何
 * 厂商 adapter —— 这正是生产现状），只有 HTTP 层用路由服务替身（记录 handler 并可直接调用）。
 *
 * 为什么不假 db / 假 search：本插件的行为建立在"检索命中 → 取正文 → 预算裁剪 → 拼上下文"
 * 这条真链路上，把检索替掉等于把要验证的东西全替掉。而真起 HTTP 端口只会引入端口冲突与
 * 超时抖动；真实 HTTP 链路另由隔离实例的 REST 端到端验收覆盖。
 *
 * 每个用例用自己的临时库，**绝不触碰仓库的 data/geewiki.db**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { Context as CordisContext } from 'cordis'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import { SEARCH_MIGRATIONS_DIR, SearchPlugin, type SearchService } from '@geewiki/search'
import {
  NULL_PROVIDER,
  createLlmService,
  type LlmChunk,
  type LlmProvider,
  type LlmService,
} from '@geewiki/llm'
import type { HttpRouterService, Principal, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import {
  AiPlugin,
  MAX_QUERY_LENGTH,
  buildContext,
  buildMessages,
  extractiveSummary,
  selectSources,
  type AiConfig,
  type AiService,
  type AskResponse,
  type CapabilitiesResponse,
  type ContextSource,
} from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

/**
 * ★ P2：请求主体（匿名）。
 *
 * 本插件的用例验证的是"端点与 svc 返回同一份结果"与"降级路径"，与**谁能看什么**
 * 无关 —— 可见性由策略层决定，而这里的 `search-service` 是替身。故固定用匿名主体，
 * 让主体成为夹具的一个常量而不是每个用例的变量。
 */
const TEST_PRINCIPAL: Principal = {
  kind: 'anonymous',
  userId: null,
  orgId: null,
  orgRole: null,
  groupIds: [],
  sessionId: null,
}

interface Harness {
  db: SqliteDatabase
  /** 插件的 ctx（用于断言 provide 出来的 ai-service） */
  ctx: Context
  /** 底层服务表：可被用例改写（例如替换成会抛错的 search 替身） */
  services: Map<string, unknown>
  /** 调用 POST /api/ai/ask */
  post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  /** 调用 GET /api/ai/ask?<qs> */
  get(qs: string): Promise<{ status: number; body: Record<string, unknown> }>
  /** 调用 GET /api/ai/capabilities */
  capabilities(): Promise<{ status: number; body: Record<string, unknown> }>
  putPage(slug: string, title: string, content: string, updatedAt?: string): void
  /**
   * 覆写策略层返回的可见集合（P2）。`null` = 回到默认「库里所有页面都可见」。
   * 用于验证 RAG 两条端点（`ask` 与 SSE `stream`）都不会把无权正文喂给模型。
   */
  setVisible(slugs: readonly string[] | null): void
  /** 仅卸载 AI 插件（保留 db/ctx，便于断言卸载后的服务状态） */
  unloadAi(): void
  dispose(): void
}

interface HarnessOptions {
  ai?: AiConfig
  /** 是否装载真实的 @geewiki/search（默认 true；false 用于验证检索不可用的降级） */
  withSearch?: boolean
  /** 额外的 llm provider（用于验证接线后的 rag / rag-partial 路径） */
  provider?: LlmProvider
  /** 是否注册内置兜底路由（默认 true，与生产 @geewiki/llm 的行为一致） */
  withNullProvider?: boolean
}

/**
 * 建一个隔离的问答环境：
 * 1. 真实 better-sqlite3 临时库（`SqliteDatabase.open()` 跑 db-sqlite 迁移建 pages 表）；
 * 2. 执行 @geewiki/search 自己的迁移（FTS5 索引 + 触发器）；
 * 3. 依次 apply SearchPlugin → AiPlugin（与生产里管理器按 requires 拓扑激活的顺序一致）；
 * 4. llm-service 由真实 `createLlmService()` 提供，不注册任何 adapter。
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ai-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  db.open()
  db.migrate(SEARCH_MIGRATIONS_DIR)

  const routes = new Map<string, RouteHandler>()
  const routerService: HttpRouterService = {
    register: (method, path, handler) => {
      routes.set(`${method} ${path}`, handler)
      return () => routes.delete(`${method} ${path}`)
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  }

  const llm: LlmService = createLlmService()
  if (opts.provider) llm.register(opts.provider)
  if (opts.withNullProvider ?? true) llm.register(NULL_PROVIDER)

  /*
   * ★ P2：策略层替身。**必须有** —— 本夹具用的是**真实** `SearchPlugin`，而它现在
   * 依赖 `policy-service`；策略层缺席时它会**显式抛错**（拒绝返回结果，见 §9 R2），
   * 于是所有检索都会降级成 `search_unavailable`，本文件大半用例会以"看起来像功能坏了"
   * 的方式红掉。这正是"绝不因策略层缺失而放行"在测试里的表现。
   *
   * 默认返回「库里所有页面」（`setVisible(null)`）⇒ 既有用例语义不变；
   * 需要验证 RAG 不泄漏的用例调用 `setVisible([...])` 覆写。
   */
  let visibleOverride: readonly string[] | null = null
  const policyService = {
    visibleSlugs: (_principal: Principal, _q?: { levels?: readonly string[] }): Promise<string[]> => {
      if (visibleOverride !== null) return Promise.resolve([...visibleOverride])
      return Promise.resolve(
        db.query<{ slug: string }>('SELECT slug FROM pages ORDER BY slug').map((r) => r.slug),
      )
    },
    /** ★ P3a：真实的 `@geewiki/search` 现在要这个（块级授权分支）；P3a 阶段恒空 */
    grantedBlockIds: (_principal: Principal): Promise<readonly number[]> => Promise.resolve([]),
  }

  const services = new Map<string, unknown>([
    ['db', db],
    ['http', routerService],
    ['llm-service', llm],
    ['policy-service', policyService],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => {
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context

  if (opts.withSearch ?? true) SearchPlugin.apply(ctx, { limit: 20, snippetRadius: 48 })
  // 保留 dispose 句柄：服务契约用例要验证"卸载后服务注销且旧引用显式报错"
  const aiDispose = AiPlugin.apply(ctx, opts.ai ?? {}) as () => void
  let aiUnloaded = false
  const unloadAi = (): void => {
    if (aiUnloaded) return
    aiUnloaded = true
    aiDispose()
  }

  const invoke = (
    key: 'POST /api/ai/ask' | 'GET /api/ai/ask' | 'GET /api/ai/capabilities',
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const handler = routes.get(key)
    assert.ok(handler, `应已注册路由 ${key}`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers =
      body === undefined ? {} : { 'content-length': String(chunks[0]?.length ?? 0) }
    return new Promise((resolve, reject) => {
      const h: RouteHandlerContext = {
        req,
        res: { once: () => {}, setHeader: () => {}, headersSent: false } as unknown as ServerResponse,
        url: new URL(`http://localhost${url}`),
        params: {},
        // ★ P2：路由层现在**必须**拿到主体（拿不到就 401），故夹具显式提供匿名主体。
        principal: TEST_PRINCIPAL,
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  /**
   * ★ P3a：写 `pages` 的同时维护 `blocks` 与 `blocks_fts`（与 plugin-search 的夹具同理）。
   *
   * 本夹具装配的是**真实的 `@geewiki/search`**，而它现在只读 `blocks` ——
   * `pages.content` 已从检索路径整体移除（它含未裁剪全文，是 §5.6 点名的泄漏源）。
   * 夹具若仍只写 `pages`，`retrieve()` 会恒返回 0 命中，RAG 的每条用例都会连带失败。
   *
   * 这里用"整页一个块"的最小实现，理由同 plugin-search：本包测的是 **RAG 装配与降级**，
   * 不是 Markdown 解析。
   */
  const writeBlocks = (pageId: number, content: string): void => {
    db.run('DELETE FROM blocks_fts WHERE rowid IN (SELECT id FROM blocks WHERE page_id = ?)', [pageId])
    db.run('DELETE FROM blocks WHERE page_id = ?', [pageId])
    if (content === '') return
    const at = '2024-01-01T00:00:00.000Z'
    const res = db.run(
      `INSERT INTO blocks (page_id, ordinal, kind, text, visibility, inherit, marker, content_hash, created_at, updated_at, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pageId, 0, 'paragraph', content, 'public', 1, null, createHash('sha256').update(content).digest('hex'), at, at, 0],
    )
    db.run('INSERT INTO blocks_fts (rowid, text) VALUES (?, ?)', [Number(res.lastInsertRowid), content])
  }

  const putPage = (slug: string, title: string, content: string, updatedAt = '2024-01-01T00:00:00.000Z'): void => {
    const existing = db.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug])[0]
    if (existing) {
      db.run('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?', [title, content, updatedAt, existing.id])
      writeBlocks(existing.id, content)
      return
    }
    db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      slug,
      title,
      content,
      updatedAt,
      updatedAt,
    ])
    const created = db.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug])[0]
    if (created) writeBlocks(created.id, content)
  }

  return {
    db,
    ctx,
    services,
    setVisible: (slugs) => {
      visibleOverride = slugs === null ? null : [...slugs]
    },
    post: (body) => invoke('POST /api/ai/ask', '/api/ai/ask', body),
    get: (qs) => invoke('GET /api/ai/ask', `/api/ai/ask?${qs}`),
    capabilities: () => invoke('GET /api/ai/capabilities', '/api/ai/capabilities'),
    putPage,
    unloadAi,
    dispose: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 断言 200 并返回 AskResponse */
async function askOk(p: Promise<{ status: number; body: Record<string, unknown> }>): Promise<AskResponse> {
  const res = await p
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body as unknown as AskResponse
}

const usedN = (body: AskResponse): (number | null)[] => body.sources.filter((s) => s.used).map((s) => s.n)

/* ============================ 用例：降级契约（最重要） ============================ */

test('降级契约：无可用 provider 时仍是 200，且结构完整（sources 非空 + 抽取式摘要）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '插件化知识库', '这是一个插件化的知识库系统，支持热插拔与全文检索，插件可以独立启停。')
    h.putPage('kb-2', '无关页面', '与主题无关的内容，用于验证排序与过滤。')

    const body = await askOk(h.post({ q: '插件化知识库' }))

    // ① 走的是检索-only，而不是错误
    assert.equal(body.mode, 'retrieval-only', `无 adapter 时必须降级为检索-only，实际 ${body.mode}`)
    assert.equal(body.ok, true)
    // ② 降级原因可判别（前端据此选文案，不解析 message）
    assert.equal(body.degraded?.reason, 'no_provider', `降级原因: ${JSON.stringify(body.degraded)}`)
    assert.equal(body.degraded?.code, 'NO_ADAPTER')
    // ③ **来源必须完整返回**——这是"没有 key 也完整可用"的核心
    assert.ok(body.sources.length > 0, '检索结果不得因为缺模型而丢失')
    assert.equal(body.sources[0]?.slug, 'kb-1')
    assert.equal(body.sources[0]?.used, true)
    assert.equal(body.sources[0]?.n, 1)
    // ④ 回答是零成本抽取式摘要：纯文本、≤300 字、不含 [n] 引用标记
    assert.equal(body.answerFormat, 'plain')
    assert.equal(typeof body.answer, 'string')
    const answer = body.answer as string
    assert.ok(answer.length > 0 && answer.length <= 300, `摘要长度应在 1..300，实际 ${answer.length}`)
    assert.doesNotMatch(answer, /\[\d+\]/, `抽取式摘要不得含 [n] 标记（会与真实引用语法混淆）: ${answer}`)
    assert.ok(answer.includes('插件化'), `摘要应取命中词附近的窗口: ${answer}`)
    // ⑤ 检索元信息与 usage/partial
    assert.equal(body.retrieval.mode, 'fts')
    assert.equal(body.retrieval.total, 1)
    assert.equal(body.retrieval.limit, 8)
    assert.equal(body.usage, null)
    assert.equal(body.partial, false)
    assert.ok(body.elapsedMs >= 0)
  } finally {
    h.dispose()
  }
})

test('降级契约：GET 与 POST 同语义（便于 curl 排障）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '检索设计', '全文检索是知识库的地基，短词需要 LIKE 兜底。')

    const viaGet = await askOk(h.get('q=检索设计'))
    const viaPost = await askOk(h.post({ q: '检索设计' }))

    assert.equal(viaGet.mode, viaPost.mode)
    assert.equal(viaGet.query, viaPost.query)
    assert.deepEqual(
      viaGet.sources.map((s) => s.slug),
      viaPost.sources.map((s) => s.slug),
      'GET 与 POST 必须走同一份实现',
    )
    assert.deepEqual(viaGet.retrieval, viaPost.retrieval)
  } finally {
    h.dispose()
  }
})

test('capabilities：未配置模型时如实报告降级，且列出不可用路由', async () => {
  const h = makeHarness()
  try {
    const res = await h.capabilities()
    assert.equal(res.status, 200)
    const body = res.body as unknown as CapabilitiesResponse
    assert.equal(body.ok, true)
    assert.equal(body.available, false)
    assert.equal(body.degraded, true)
    // 内置兜底路由存在但不可用：让前端能展示"为什么不可用"
    assert.ok(body.providers.length >= 1, '应列出已注册路由（含不可用者）')
    assert.ok(body.providers.every((p) => p.available === false))
    assert.match(body.message, /抽取式摘要|模型/)
  } finally {
    h.dispose()
  }
})

/* ============================ 用例：两条检索路 ============================ */

test('检索路：≥3 字符走 fts，2 字中文退回 like（trigram 硬缺口）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '检索设计', '全文检索是知识库的地基。')

    const fts = await askOk(h.post({ q: '知识库' }))
    assert.equal(fts.retrieval.mode, 'fts', '3 字查询应走 MATCH')

    const like = await askOk(h.post({ q: '检索' }))
    assert.equal(like.retrieval.mode, 'like', '2 字中文必须走 LIKE 兜底')
    assert.equal(like.retrieval.total, 1)
    assert.equal(like.sources[0]?.slug, 'kb-1')
  } finally {
    h.dispose()
  }
})

/* ============================ 用例：截断与编号 ============================ */

test('截断：maxSourcesInContext 生效，放不下的整条丢弃但仍在 sources 里', async () => {
  const h = makeHarness({ ai: { maxSourcesInContext: 2 } })
  try {
    h.putPage('kb-1', '知识库甲', '插件化知识库的第一篇内容，包含关键词插件化。')
    h.putPage('kb-2', '知识库乙', '插件化知识库的第二篇内容，包含关键词插件化。')
    h.putPage('kb-3', '知识库丙', '插件化知识库的第三篇内容，包含关键词插件化。')

    const body = await askOk(h.post({ q: '插件化知识库' }))
    assert.equal(body.sources.length, 3, '全部命中都要列出')
    assert.equal(body.sources.filter((s) => s.used).length, 2, '只有 2 条进上下文')

    // 编号只对 used:true 连续，被丢弃者 n 为 null
    assert.deepEqual(usedN(body), [1, 2])
    const dropped = body.sources.filter((s) => !s.used)
    assert.equal(dropped.length, 1)
    assert.equal(dropped[0]?.n, null, '被丢弃的条目不得占用引用编号')

    // 被丢弃的条目确实不在 prompt 文本里（用同一套 selected 语义重建上下文）
    const selected: ContextSource[] = body.sources
      .filter((s) => s.used)
      .map((s) => ({ n: s.n as number, slug: s.slug, title: s.title, text: '正文占位' }))
    const context = buildContext(selected)
    assert.match(context, /\[1\]/)
    assert.match(context, /\[2\]/)
    assert.doesNotMatch(context, /\[3\]/, '被丢弃的条目不得出现在上下文里')
    assert.doesNotMatch(context, new RegExp(dropped[0]?.slug ?? 'IMPOSSIBLE'), '被丢弃的 slug 不得进上下文')
  } finally {
    h.dispose()
  }
})

test('截断：totalContextChars 放不下就整条丢弃（不做尾部裁切）', async () => {
  // 单条上限放大，让总预算成为唯一约束：首条吃掉大部分预算，第二条整条放不下
  const h = makeHarness({ ai: { perSourceChars: 1000, totalContextChars: 120, maxSourcesInContext: 6 } })
  try {
    // 首条 100 字（正好放得下），第二条 100 字（累计 200 > 120 → 整条丢弃）
    h.putPage('kb-1', '知识库甲', `插件化${'甲'.repeat(96)}`)
    h.putPage('kb-2', '知识库乙', `插件化${'乙'.repeat(96)}`)

    const body = await askOk(h.post({ q: '插件化' }))
    assert.equal(body.sources.filter((s) => s.used).length, 1, '只应有一条进上下文')
    assert.deepEqual(usedN(body), [1])
    assert.equal(body.sources[1]?.used, false, '第二条整条丢弃（不得被截半句）')
  } finally {
    h.dispose()
  }
})

test('截断：perSourceChars 限制单条正文长度', async () => {
  const h = makeHarness({ ai: { perSourceChars: 50, totalContextChars: 6000 } })
  try {
    h.putPage('kb-1', '长文', `插件化${'长'.repeat(500)}`)

    const body = await askOk(h.post({ q: '插件化' }))
    assert.equal(body.sources[0]?.used, true)
    // 通过纯函数验证：同一命中在 50 字预算下的选中文本长度不超过 50
    // ★ P3a：命中与内容都改成了块级形态（`SearchHit.blocks` / `ContentView`）
    const longText = `插件化${'长'.repeat(500)}`
    const blocks = [{ ordinal: 0, kind: 'paragraph', text: longText }]
    const hits = [{ slug: 'kb-1', title: '长文', snippet: '', blocks, gatedCount: 0, score: 1, updated_at: 'x' }]
    const sel = selectSources(
      hits,
      new Map([['kb-1', { text: longText, blocks, gatedCount: 0, maxVisibleTier: 0 }]]),
      {
        maxSourcesInContext: 6,
        perSourceChars: 50,
        totalContextChars: 6000,
      },
    )
    assert.equal(sel.selected[0]?.text.length, 50, '单条正文应被截到 perSourceChars')
  } finally {
    h.dispose()
  }
})

/* ============================ 用例：检索不可用 ============================ */

test('search-service 缺失：降级为 search_unavailable 且不崩、仍 200', async () => {
  const h = makeHarness({ withSearch: false })
  try {
    assert.equal(h.services.get('search-service'), undefined, '前置：不应有 search-service')
    const body = await askOk(h.post({ q: '任何查询' }))
    assert.equal(body.mode, 'retrieval-only')
    assert.equal(body.degraded?.reason, 'search_unavailable')
    assert.equal(body.degraded?.code, null)
    assert.deepEqual(body.sources, [])
    assert.equal(body.answer, null)
    assert.equal(body.retrieval.total, 0)
  } finally {
    h.dispose()
  }
})

test('search-service 抛错（已卸载）：同样降级而非 500', async () => {
  const h = makeHarness()
  try {
    h.services.set('search-service', {
      search: () => {
        throw new Error('@geewiki/search: 插件已卸载，search-service 不可再调用')
      },
      contents: () => new Map(),
    })
    const body = await askOk(h.post({ q: '任何查询' }))
    assert.equal(body.degraded?.reason, 'search_unavailable')
    assert.match(body.degraded?.message ?? '', /已卸载/)
  } finally {
    h.dispose()
  }
})

/* ============================ 用例：输入校验 ============================ */

test('输入校验：空查询 400 empty_query，超长 400 too_long', async () => {
  const h = makeHarness()
  try {
    const empty = await h.post({ q: '   ' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body['error'], 'empty_query')

    const emptyGet = await h.get('q=')
    assert.equal(emptyGet.status, 400)
    assert.equal(emptyGet.body['error'], 'empty_query')

    const tooLong = await h.post({ q: '字'.repeat(MAX_QUERY_LENGTH + 1) })
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.body['error'], 'too_long')

    // 恰好到上限应放行（走正常 200 路径）
    const atLimit = await askOk(h.post({ q: '字'.repeat(MAX_QUERY_LENGTH) }))
    assert.equal(atLimit.ok, true)
  } finally {
    h.dispose()
  }
})

test('输入校验：未知字段与非法 limit 一律 400', async () => {
  const h = makeHarness()
  try {
    const unknown = await h.post({ q: '插件化', nope: 1 })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body['error'], 'invalid_body')

    const badLimit = await h.post({ q: '插件化', limit: 0 })
    assert.equal(badLimit.status, 400)
    assert.equal(badLimit.body['error'], 'invalid_limit')

    const badExtractive = await h.post({ q: '插件化', extractive: 'maybe' })
    assert.equal(badExtractive.status, 400)
    assert.equal(badExtractive.body['error'], 'invalid_extractive')
  } finally {
    h.dispose()
  }
})

test('无检索结果：仍 200，sources 为空、answer 为 null', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '无关页面', '完全不相干的内容。')
    const body = await askOk(h.post({ q: '绝对不存在的词' }))
    assert.equal(body.mode, 'retrieval-only')
    assert.deepEqual(body.sources, [])
    assert.equal(body.answer, null, '没有任何来源时不应编出摘要')
    assert.equal(body.retrieval.total, 0)
  } finally {
    h.dispose()
  }
})

test('extractive=false：降级但仍不产出摘要（answer 为 null，sources 保留）', async () => {
  const h = makeHarness({ ai: { extractive: false } })
  try {
    h.putPage('kb-1', '插件化知识库', '插件化知识库的内容，包含关键词插件化。')
    const body = await askOk(h.post({ q: '插件化知识库' }))
    assert.equal(body.answer, null)
    assert.equal(body.sources.length, 1, '关掉摘要不影响来源返回')
    assert.equal(body.degraded?.reason, 'no_provider', '仍然如实报告降级原因')
  } finally {
    h.dispose()
  }
})

/* ============================ 用例：密钥不泄漏 ============================ */

test('密钥安全：上游错误文本里的疑似密钥不得出现在响应体里', async () => {
  const h = makeHarness()
  try {
    // 上游报错常整段回显 URL / 鉴权头，这里模拟一个真实形态
    const secret = `sk-${'A'.repeat(32)}`
    h.services.set('search-service', {
      search: () => {
        throw new Error(`connect failed: https://api.example.com?authorization=Bearer ${secret}`)
      },
      contents: () => new Map(),
    })

    const res = await h.post({ q: '插件化' })
    assert.equal(res.status, 200)
    const raw = JSON.stringify(res.body)
    assert.ok(!raw.includes(secret), `响应体泄漏了密钥: ${raw}`)
    assert.ok(!raw.includes('Bearer '), '鉴权头形态也应被遮蔽')
    const body = res.body as unknown as AskResponse
    assert.equal(body.degraded?.reason, 'search_unavailable')
    assert.ok((body.degraded?.message ?? '').includes('***'), `降级说明应保留脱敏痕迹: ${body.degraded?.message}`)
  } finally {
    h.dispose()
  }
})

/* ============================ 用例：纯函数 ============================ */

test('纯函数：buildContext / buildMessages 同输入同输出且形态固定', () => {
  const sources: ContextSource[] = [
    { n: 1, slug: 'a', title: '甲', text: '正文甲' },
    { n: 2, slug: 'b', title: '乙', text: '正文乙' },
  ]
  const c1 = buildContext(sources)
  const c2 = buildContext(sources)
  assert.equal(c1, c2, 'buildContext 必须是纯函数')
  assert.equal(c1, '[1] 甲（a）\n正文甲\n\n[2] 乙（b）\n正文乙')

  const m1 = buildMessages('问题？', sources)
  const m2 = buildMessages('问题？', sources)
  assert.deepEqual(m1, m2, 'buildMessages 必须是纯函数')
  assert.equal(m1.length, 2)
  assert.equal(m1[0]?.role, 'system')
  assert.equal(m1[1]?.role, 'user')
  assert.match(m1[0]?.content ?? '', /只依据/)
  assert.match(m1[1]?.content ?? '', /\[1\] 甲/)
  assert.match(m1[1]?.content ?? '', /问题：问题？/)

  // 无资料时也必须产出合法 messages，且如实写明"没有命中"
  const empty = buildMessages('问题？', [])
  assert.equal(empty.length, 2)
  assert.match(empty[1]?.content ?? '', /没有命中任何资料/)
})

test('纯函数：extractiveSummary 取命中词窗口、限长、无 [n] 标记', () => {
  const long = `${'前言'.repeat(100)}目标词${'后文'.repeat(100)}`
  const summary = extractiveSummary('目标词', [{ slug: 'a', title: '标题', text: long }])
  assert.ok(summary.length <= 300, `摘要应 ≤300 字，实际 ${summary.length}`)
  assert.ok(summary.includes('目标词'), '摘要应围绕命中词开窗')
  assert.doesNotMatch(summary, /\[\d+\]/)

  // 命中词不在正文（例如只命中标题）→ 退回正文开头
  const fallback = extractiveSummary('缺席词', [{ slug: 'a', title: '标题', text: '正文开头的内容' }])
  assert.match(fallback, /正文开头/)

  // 空输入 → 空串（调用方据此把 answer 置 null）
  assert.equal(extractiveSummary('x', []), '')
})

/* ============================ 用例：接线点（有 provider 时） ============================ */

/** 造一个可用 provider：先产 text-delta，再产终止 chunk */
function fakeProvider(name: string, chunks: LlmChunk[]): LlmProvider {
  return {
    route: name,
    descriptor: {
      route: name,
      label: `测试路由 ${name}`,
      vendor: 'test',
      model: 'test-model',
      available: () => true,
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 契约要求 AsyncIterable
    async *stream() {
      for (const c of chunks) yield c
    },
  }
}

test('接线点：有可用 provider 时真的走模型路径，mode 为 rag 且 answer 为 markdown', async () => {
  const h = makeHarness({
    provider: fakeProvider('test-ok', [
      { type: 'text-delta', text: '依据资料，' },
      { type: 'text-delta', text: '答案是插件化 [1]。' },
      { type: 'done', provider: 'test-ok', model: 'test-model', usage: { completionTokens: 7 } },
    ]),
  })
  try {
    h.putPage('kb-1', '插件化知识库', '插件化知识库的内容，包含关键词插件化。')
    const caps = await h.capabilities()
    assert.equal((caps.body as unknown as CapabilitiesResponse).available, true, '有可用 provider 时 capabilities.available 应为 true')

    const body = await askOk(h.post({ q: '插件化知识库' }))
    assert.equal(body.mode, 'rag', '真的生成了才允许报 rag')
    assert.equal(body.degraded, null)
    assert.equal(body.answer, '依据资料，答案是插件化 [1]。')
    assert.equal(body.answerFormat, 'markdown')
    assert.equal(body.partial, false)
    assert.deepEqual(body.usage, { completionTokens: 7 })
  } finally {
    h.dispose()
  }
})

test('接线点：生成中途失败但有部分文本 → mode 为 rag-partial 且 partial 为 true', async () => {
  const h = makeHarness({
    provider: fakeProvider('test-partial', [
      { type: 'text-delta', text: '前半段' },
      { type: 'error', code: 'NETWORK' },
    ]),
  })
  try {
    h.putPage('kb-1', '插件化知识库', '插件化知识库的内容，包含关键词插件化。')
    const body = await askOk(h.post({ q: '插件化知识库' }))
    assert.equal(body.mode, 'rag-partial', '半截回答不得当完整回答')
    assert.equal(body.partial, true)
    assert.equal(body.answer, '前半段')
    assert.equal(body.degraded?.reason, 'network')
    assert.equal(body.degraded?.code, 'NETWORK')
  } finally {
    h.dispose()
  }
})

/* ========================= 用例：ai-service 服务契约 ========================= */
/*
 * 为什么必须有这几例：manifest 的 `provides: 'ai-service'` 只是**依赖图谱 token**，
 * 不会创建任何 cordis 服务。本仓库已有先例教训（search-service / wiki-service 都曾
 * "只声明不提供"），症状是消费方 `ctx.get()` 恒为 undefined 且不报错——表现为
 * "功能静默不可用"。下面第 1-3 例钉住"真的提供了、且与 REST 是同一份实现"，
 * 第 4 例钉住卸载语义，第 5 例用**真实 cordis** 证明跨插件可见性（替身 ctx 只能
 * 证明同 ctx 内的 provide→get）。
 */

test('服务契约：ai-service 真的被 provide（而非只声明 provides token）', async () => {
  const h = makeHarness()
  try {
    const svc = h.services.get('ai-service') as AiService | undefined
    assert.notEqual(svc, undefined, 'manifest 的 provides 不会建服务，必须 ctx.provide 才算数')
    assert.equal(typeof svc?.ask, 'function', 'ai-service.ask 必须是函数')
    assert.equal(typeof svc?.capabilities, 'function', 'ai-service.capabilities 必须是函数')
  } finally {
    h.dispose()
  }
})

test('服务契约：svc.ask 与 REST 端点逐字段一致（同一份实现，非平行副本）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '插件化知识库', '这是一个插件化的知识库系统，支持热插拔与全文检索。')
    h.putPage('kb-2', '无关页面', '与主题无关的内容。用于验证排序与过滤。')
    const svc = h.services.get('ai-service') as AiService

    const viaService = await svc.ask(TEST_PRINCIPAL, '插件化知识库', { limit: 2, extractive: true })
    const viaRest = await askOk(h.post({ q: '插件化知识库', limit: 2, extractive: true }))

    // 唯一会不同的字段是 elapsedMs（墙钟耗时，两次调用必然不可比），其余必须逐字段一致。
    // 只剔除该字段是**刻意的**：它也是唯一被文档标注为"计时"的字段。
    const { elapsedMs: svcMs, ...svcRest } = viaService
    const { elapsedMs: restMs, ...restRest } = viaRest
    assert.deepEqual(svcRest, restRest, 'REST 与服务必须返回同一份结果（端点只做 HTTP 层）')
    assert.ok(svcMs >= 0, 'svc.ask 的 elapsedMs 应为非负数')
    assert.ok(restMs >= 0, '端点的 elapsedMs 应为非负数')
    // 抽样式钉住几个关键字段，避免上面的 deepEqual 因字段被整体移除而失去意义
    assert.equal(viaService.mode, 'retrieval-only')
    // 语料里只有 kb-1 命中（其**标题**恰为查询串；kb-2 与查询无关）
    assert.ok(viaService.sources.length >= 1, `应至少有一条来源: ${JSON.stringify(viaService.sources)}`)
    assert.equal(viaService.sources[0]?.slug, 'kb-1')
  } finally {
    h.dispose()
  }
})

test('服务契约：svc.capabilities 与 GET /api/ai/capabilities 完全一致', async () => {
  const h = makeHarness()
  try {
    const svc = h.services.get('ai-service') as AiService
    const viaService = svc.capabilities()
    const viaRest = await h.capabilities()
    assert.equal(viaRest.status, 200)
    // capabilities 无计时字段，故这里是**全字段**深比较（端点直接返回服务返回值）
    assert.deepEqual(viaRest.body, viaService, '端点应原样返回 svc.capabilities()')
    assert.equal(viaService.ok, true)
    assert.equal(typeof viaService.message, 'string')
    assert.equal(Array.isArray(viaService.providers), true)
  } finally {
    h.dispose()
  }
})

test('服务契约：卸载后服务注销，且旧引用的调用显式报错（绝不返回空结果）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '插件化知识库', '这是一个插件化的知识库系统。')
    const svc = h.services.get('ai-service') as AiService
    // 卸载前可正常调用
    assert.equal((await svc.ask(TEST_PRINCIPAL, '插件化知识库')).ok, true)

    h.unloadAi()

    assert.equal(h.services.get('ai-service'), undefined, '卸载后 ctx.get 应回到 undefined')
    // 关键：仍持有旧引用的调用必须**显式报错**。若静默返回空结果，会被误读成
    // "知识库里没有相关内容"——正是最难定位的那类症状（口径同 @geewiki/search）。
    await assert.rejects(() => svc.ask(TEST_PRINCIPAL, '插件化知识库'), /已卸载/, '旧的 ask 引用必须显式报错')
    assert.throws(() => svc.capabilities(), /已卸载/, '旧的 capabilities 引用必须显式报错')
  } finally {
    h.dispose()
  }
})

test('真实 cordis：ai-service 对兄弟插件可见，卸载后注销', async () => {
  // 为什么单独写一例：上面的 harness 用替身 ctx，只能证明"同 ctx 内 provide→get"；
  // 而消费方会是**另一个插件**（各自跑在 ctx.plugin() 的子 fiber 里）。
  const dir = mkdtempSync(join(tmpdir(), 'gw-ai-cordis-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  db.open()
  db.migrate(SEARCH_MIGRATIONS_DIR)
  try {
    const routes = new Map<string, RouteHandler>()
    const routerService: HttpRouterService = {
      register: (method, path, handler) => {
        routes.set(`${method} ${path}`, handler)
        return () => routes.delete(`${method} ${path}`)
      },
      stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
      inflight: () => 0,
      pending: () => 0,
      drain: () => Promise.resolve(true),
    }

    const root = new CordisContext()
    root.provide('db', db)
    root.provide('http', routerService)
    root.provide('llm-service', createLlmService())

    // 生产路径：管理器就是 `await ctx.plugin(module, config)` 逐插件激活
    const fork = root.plugin(AiPlugin, {})
    await fork

    const svc = root.get('ai-service') as AiService | undefined
    assert.ok(svc, '真实 cordis 下 root.get 也应拿到 ai-service')

    // 兄弟插件：模拟后续消费方在自己的 apply 里 ctx.get('ai-service')
    let seenBySibling: unknown = 'NOT_RUN'
    const sibling = {
      name: '@geewiki-test/ai-probe-consumer',
      apply(ctx: Context) {
        seenBySibling = ctx.get('ai-service')
        return () => {}
      },
    }
    const siblingFork = root.plugin(sibling)
    // 注意：必须等提供者 **await 完成**后再装配消费者——并发加载时 cordis 的
    // provide 尚未发生，消费者会拿到 undefined（已实测的坑，见 @geewiki/search 同款用例）。
    await siblingFork
    assert.notEqual(seenBySibling, undefined, '兄弟插件必须能 ctx.get 到 ai-service')
    assert.equal(seenBySibling, svc, '兄弟插件拿到的应是同一个服务实例')

    // 卸载后对所有人注销，且路由摘除
    await siblingFork.dispose()
    await fork.dispose()
    assert.equal(root.get('ai-service'), undefined, '卸载后服务应注销')
    assert.equal(routes.has('GET /api/ai/capabilities'), false, '卸载后路由应摘除')
    assert.equal(routes.has('POST /api/ai/ask'), false, '卸载后路由应摘除')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ================= 问句检索（mode:'terms'）——RAG 检索地基的回归 ================= */

test('问句检索：自然语言问句能召回资料（修前恒为 0 命中）', async () => {
  const h = makeHarness()
  try {
    // 正文照抄真实语料形态：问句的词元都在正文里，但整句**不**连续出现
    h.putPage('kb-1', '检索设计', '本系统的检索增强问答先从知识库检索相关资料，再做抽取式摘要。')

    const body = await askOk(h.post({ q: '检索增强怎么做' }))
    assert.ok(body.retrieval.total >= 1, `问句应召回资料，实际 total=${body.retrieval.total}`)
    assert.equal(body.retrieval.mode, 'fts', '问句 ≥3 字符，词元非空 → 走 FTS')
    assert.ok(body.sources.length >= 1, `sources 应非空，实际 ${body.sources.length}`)
    assert.equal(body.sources[0]?.slug, 'kb-1')
    // 无密钥时走抽取式摘要：answer 不应为 null（有命中且有内容）
    assert.equal(body.mode, 'retrieval-only')
    assert.ok(body.answer !== null, '有命中时应给出抽取式摘要')
    assert.ok((body.answer ?? '').includes('检索'), `摘要应围绕命中位置，实际：${String(body.answer)}`)
  } finally {
    h.dispose()
  }
})

test('问句检索：检索条数与降级结构保持契约（后缀无关词不破坏召回）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '甲', '检索增强问答先从知识库检索相关资料。')
    h.putPage('kb-2', '乙', '完全不相关的另一篇内容。')

    // 问句里混入正文没有的词（「怎么」「做」）：只要还有词元命中，就应召回 kb-1
    const body = await askOk(h.post({ q: '知识库怎么检索资料' }))
    assert.ok(body.retrieval.total >= 1, `应召回 kb-1，实际 total=${body.retrieval.total}`)
    assert.ok(
      body.sources.some((s) => s.slug === 'kb-1'),
      `sources 应含 kb-1，实际 ${JSON.stringify(body.sources.map((s) => s.slug))}`,
    )
    // 与正文毫无交集的问句仍是 0 命中（不能因为词元化就"什么都命中"）
    const miss = await askOk(h.post({ q: '量子纠缠退相干实验' }))
    assert.equal(miss.retrieval.total, 0, '无交集问句必须 0 命中')
    assert.deepEqual(miss.sources, [])
    assert.equal(miss.answer, null, '无命中时 answer 为 null（与既有契约一致）')
  } finally {
    h.dispose()
  }
})
