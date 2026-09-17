/**
 * `@geewiki/ai-summary` 的插件级行为测试。
 *
 * **测试策略**：真实 cordis `Context` + **真实 better-sqlite3 临时库**（迁移真跑，
 * 故 `migrations/0001_page_summaries.sql` 的语法、`ON CONFLICT(page_id)` 与
 * `ON DELETE CASCADE` 都被真的验过），只把 `http` / `wiki-service` / `policy-service` /
 * `llm-service` / `ai-tool-service` 换成替身。
 *
 * 与 `@geewiki/ai-journal` 的测试同一条理由：这里最该验的是**没发生什么**
 * （没有模型时一次都没调上游、读不到的人拿不到摘要、匿名看不到组织内摘要），
 * 而这类断言只能靠"替身被调用了几次"来证明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { PAGE_SAVED_EVENT, type HttpRouterService, type Principal, type RouteHandler, type RouteHandlerContext } from '@geewiki/core'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import { AiSummaryPlugin, SUMMARY_MIGRATIONS_DIR, manifest } from '../src/index.js'
import {
  SUMMARY_CAPABILITIES_PATH,
  SUMMARY_PATH,
  SUMMARY_SEARCH_PATH,
  SUMMARY_TOOL_NAMES,
} from '../src/types.js'

const USER: Principal = { kind: 'user', userId: 7, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

/* ------------------------------ 夹具 ------------------------------ */

interface Page {
  slug: string
  title: string
  /** 各档投影下的正文。缺省 = 三档相同（没有受限段落） */
  content: string
  publicContent?: string
  orgContent?: string
}

interface Harness {
  ctx: Context
  db: SqliteDatabase
  /** 当前这一页对匿名 / 组织成员 / 该主体分别能读到什么 */
  setPages(pages: Page[]): void
  /** 每页对当前主体的可读等级与编辑权（`resolvePage` 的替身数据） */
  access: Map<string, { level: 'none' | 'summary' | 'full'; canEdit: boolean }>
  /** 每次 `wiki.get` 收到的 (slug, 主体种类) —— 用来证明"按哪一档投影" */
  getCalls: { slug: string; reader: string }[]
  /** `llm.stream` 被调了几次——"没有模型时一次都没调上游"靠它证明 */
  llmCalls(): number
  setModelReady(ready: boolean): void
  call(
    method: string,
    path: string,
    opts?: { body?: unknown; principal?: Principal; query?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>
  saved(slug: string, title?: string): void
  /** 跑掉所有待触发的去抖回调，并等它们的异步生成结算 */
  flush(): Promise<void>
  tools: Map<string, { descriptor: { name: string; side: string; mutating?: boolean }; execute: (p: unknown, a: unknown) => Promise<{ content: string; grounding?: string }> }>
  dispose(): Promise<void>
}

async function makeHarness(opts: { modelReady?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ai-summary-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  db.open()
  /*
   * `pages` / `orgs` 由 `SqliteDatabase` 打开时的默认迁移建好（真源表**不归本插件**：
   * 本插件的迁移只建 `page_summaries`，而后者有指向 `pages(id)` 的外键）。
   * 这同时钉住了"摘要表不是真源"这个设计——它随时可以被删掉重算。
   */
  if (db.query('SELECT id FROM orgs LIMIT 1').length === 0) db.run('INSERT INTO orgs (id) VALUES (1)')

  const pages = new Map<string, Page>()
  const access = new Map<string, { level: 'none' | 'summary' | 'full'; canEdit: boolean }>()
  const getCalls: { slug: string; reader: string }[] = []
  let modelReady = opts.modelReady ?? true
  let llmCalls = 0
  const tools = new Map<string, never>()

  const upsertPage = (page: Page): void => {
    db.run(
      `INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = excluded.updated_at`,
      [page.slug, page.title, page.content, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    )
  }

  const wikiService = {
    async get(slug: string, principal: Principal) {
      const page = pages.get(slug)
      if (!page) return undefined
      const reader =
        principal.kind === 'anonymous' ? 'anon' : principal.kind === 'break-glass' ? 'break-glass' : `user:${principal.userId}`
      getCalls.push({ slug, reader })
      /*
       * 投影：按主体种类选正文。这样测试就能断言"生成摘要时用的是哪一档"——
       * 而那正是本插件最容易搞错、且**搞错了不会报错**的地方（拿组织投影给匿名看）。
       */
      const content =
        principal.kind === 'anonymous'
          ? (page.publicContent ?? page.content)
          : principal.userId === 0
            ? (page.orgContent ?? page.content)
            : page.content
      return { slug, title: page.title, content, updated_at: '2026-01-01T00:00:00.000Z' }
    },
  }

  const policyService = {
    async resolvePage(_principal: Principal, slug: string) {
      const a = access.get(slug)
      if (!a) return { slug, level: 'none' as const, canEdit: false }
      return { slug, level: a.level, canEdit: a.canEdit }
    },
    async resolvePages(_principal: Principal, slugs: readonly string[]) {
      const out = new Map<string, { level: 'none' | 'summary' | 'full'; canEdit: boolean }>()
      for (const slug of slugs) {
        const a = access.get(slug)
        out.set(slug, a ?? { level: 'none', canEdit: false })
      }
      return out
    },
    /** 与主体无关的档位：0 = 匿名可见 / 1 = 组织内可见 / null = 没有通用主体能看 */
    async effectiveIndexLevel(slug: string): Promise<0 | 1 | null> {
      const page = pages.get(slug)
      if (!page) return null
      return page.publicContent !== undefined ? 0 : page.orgContent !== undefined ? 1 : 0
    },
  }

  const llmService = {
    availableProviders: () => (modelReady ? [{ route: 'fake' }] : []),
    listProviders: () => (modelReady ? [{ route: 'fake', label: '假模型', vendor: 'fake', model: 'fake-1', available: () => true }] : []),
    async *stream() {
      llmCalls++
      yield { type: 'status', provider: 'fake', model: 'fake-1' }
      yield { type: 'text-delta', text: '摘要：这一页讲怎么新建内容。' }
      yield { type: 'done', provider: 'fake', model: 'fake-1' }
    },
  }

  const toolService = {
    contribute(_owner: string, tool: { descriptor: { name: string } }) {
      tools.set(tool.descriptor.name, tool as never)
      return () => tools.delete(tool.descriptor.name)
    },
    list: () => [...tools.values()],
    ownerOf: () => '@geewiki/ai-summary',
    release: () => {},
    diagnostics: () => ({ count: tools.size, overBudget: [], mutating: [] }),
  }

  const routes = new Map<string, RouteHandler>()
  const routerService = {
    register: (method: string, path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler)
      return () => routes.delete(`${method} ${path}`)
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  } as unknown as HttpRouterService

  const ctx = new Context()
  ctx.provide('http', routerService)
  ctx.provide('db', db)
  ctx.provide('wiki-service', wikiService)
  ctx.provide('policy-service', policyService)
  ctx.provide('llm-service', llmService)
  ctx.provide('ai-tool-service', toolService)
  /*
   * 去抖定时器换成"手动触发"：真等 2 秒会让每个用例都慢，而**等多久**不是这里要验的东西
   * （要验的是"保存之后摘要会跟上"与"连写十段只花一次"）。`debounceMs` 归 0
   * 只能测到"立刻生成"，测不到"合并"。
   */
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  /*
   * **直接调 `apply`**，不用 `ctx.plugin`：cordis 的 `ctx.plugin(plugin, config)`
   * 只把第二个参数交给 `apply`，第三个及以后的会被丢掉——那样 `options.timers`
   * 恒为 `undefined`，夹具会静默退回真定时器，于是"保存后摘要会跟上"这条断言
   * 永远等不到（而它看起来只是"还没生成"）。`@geewiki/ai-qa` 的测试也是这么做的。
   */
  // ★ F19：`apply` 现在是 async（激活期要 await 迁移与现取查询），故这里 await 它
  const disposePlugin = (await AiSummaryPlugin.apply(ctx, {}, {
    timers: {
      set: (fn: () => void) => {
        const id = nextTimer++
        timers.set(id, fn)
        return id
      },
      clear: (handle: unknown) => {
        timers.delete(handle as number)
      },
    },
  })) as () => void

  const call = async (
    method: string,
    path: string,
    callOpts: { body?: unknown; principal?: Principal; query?: string } = {},
  ) => {
    const handler = routes.get(`${method} ${path}`)
    assert.notEqual(handler, undefined, `路由 ${method} ${path} 必须已注册`)
    if (!handler) throw new Error(`路由 ${method} ${path} 未注册`)
    const url = new URL(`http://x${path}${callOpts.query === undefined ? '' : `?${callOpts.query}`}`)
    let captured: { status: number; body: Record<string, unknown> } | null = null
    const h = {
      url,
      principal: callOpts.principal ?? ANON,
      json(status: number, body: unknown) {
        captured = { status, body: body as Record<string, unknown> }
      },
    } as unknown as RouteHandlerContext
    if (method === 'POST') {
      const text = JSON.stringify(callOpts.body ?? {})
      const req = {
        on(event: string, fn: (arg?: unknown) => void) {
          if (event === 'data') fn(Buffer.from(text))
          else if (event === 'end') fn()
          return req
        },
        pause() {},
        destroy() {},
      }
      ;(h as unknown as { req: unknown }).req = req
    }
    await handler(h)
    assert.notEqual(captured, null, `${method} ${path} 必须写出响应`)
    const out = captured as unknown as { status: number; body: Record<string, unknown> }
    // 请求体读完后要清掉
    void callOpts
    return out
  }

  return {
    ctx,
    db,
    access,
    getCalls,
    llmCalls: () => llmCalls,
    setModelReady: (ready: boolean) => {
      modelReady = ready
    },
    setPages(list: Page[]) {
      pages.clear()
      access.clear()
      for (const page of list) {
        pages.set(page.slug, page)
        upsertPage(page)
        access.set(page.slug, { level: 'full', canEdit: true })
      }
    },
    call,
    async flush() {
      const cbs = [...timers.values()]
      timers.clear()
      for (const cb of cbs) cb()
      // 生成是异步的（for await 上游流）：多转几轮微任务与宏任务让它结算
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    },
    saved(slug: string, title = slug) {
      ctx.emit(PAGE_SAVED_EVENT, {
        slug,
        title,
        updatedAt: new Date().toISOString(),
        outcome: 'updated',
        actorId: 7,
      })
    },
    tools: tools as never,
    async dispose() {
      disposePlugin()
      db.close()
    },
  }
}

/* ============================== 迁移与 manifest ============================== */

test('迁移真的建出了 page_summaries（含 page_id 主键与 slug 索引）', async () => {
  const h = await makeHarness()
  try {
    const tables = h.db.listTables()
    assert.ok(tables.includes('page_summaries'), `缺表：${tables.join(',')}`)
    const indexes = h.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'page_summaries'",
    )
    assert.ok(indexes.some((i) => i.name === 'idx_page_summaries_slug'))
  } finally {
    await h.dispose()
  }
})

test('manifest 声明了 article-summary 插槽与前端产物，且迁移目录存在', () => {
  assert.deepEqual(manifest.geewiki?.slots, ['article-summary'])
  assert.deepEqual(manifest.geewiki?.client, { entry: 'client.js', css: 'client.css' })
  assert.ok(SUMMARY_MIGRATIONS_DIR.endsWith('migrations'), SUMMARY_MIGRATIONS_DIR)
})

/* ============================== 没有模型 ============================== */

test('没有可用模型：capabilities 报不可用，且 GET 的 available=false（卡片据此整张不渲染）', async () => {
  const h = await makeHarness({ modelReady: false })
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '怎么新建内容' }])
    const caps = await h.call('GET', SUMMARY_CAPABILITIES_PATH)
    assert.equal(caps.body['available'], false)

    const view = await h.call('GET', SUMMARY_PATH, { query: 'slug=home' })
    assert.equal(view.status, 200)
    assert.equal(view.body['available'], false)
    assert.equal(view.body['summary'], null)
    assert.equal(view.body['canRegenerate'], false)
    assert.equal(typeof view.body['reason'], 'string')
  } finally {
    await h.dispose()
  }
})

test('没有模型时：POST /api/ai/summary 明确 503，且一次上游都没调', async () => {
  const h = await makeHarness({ modelReady: false })
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '正文' }])
    const res = await h.call('POST', SUMMARY_PATH, { body: { slug: 'home' }, principal: USER })
    assert.equal(res.status, 503)
    assert.equal(res.body['error'], 'model_unavailable')
    assert.equal(h.llmCalls(), 0, '判定在调用模型之前，故一次都不该调')
  } finally {
    await h.dispose()
  }
})

/* ============================== 生成（保存事件驱动） ============================== */

test('保存 ⇒ 去抖后生成 ⇒ 落库 ⇒ GET 返回它且 stale=false', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '怎么新建内容' }])
    h.saved('home')
    await h.flush()
    const stored = h.db.query<{ summary: string; audience: string; model: string }>(
      'SELECT summary, audience, model FROM page_summaries',
    )
    assert.equal(stored.length, 1, '保存事件之后摘要必须落库')
    assert.equal(stored[0]?.summary, '这一页讲怎么新建内容。')
    assert.equal(stored[0]?.audience, 'public')
    assert.equal(stored[0]?.model, 'fake-1')

    const view = await h.call('GET', SUMMARY_PATH, { query: 'slug=home' })
    assert.equal(view.body['summary'], '这一页讲怎么新建内容。')
    assert.equal(view.body['stale'], false)
    assert.equal(view.body['available'], true)
  } finally {
    await h.dispose()
  }
})

test('同一页连写多次只花一次模型调用（去抖合并）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '正文' }])
    for (let i = 0; i < 5; i++) h.saved('home')
    await h.flush()
    assert.ok(h.llmCalls() <= 1, `连写 5 次最多一次上游，实际 ${h.llmCalls()} 次`)
  } finally {
    await h.dispose()
  }
})

test('正文变了 ⇒ stale=true（哈希判过期，不用时间戳）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '第一版正文' }])
    h.saved('home')
    await h.flush()
    assert.equal(h.db.query('SELECT 1 FROM page_summaries').length, 1, '未落库')

    // 直接改库里的正文（相当于有人编辑了这一页，但事件还没到）
    h.db.run('UPDATE pages SET content = ? WHERE slug = ?', ['第二版正文', 'home'])
    h.setPages([{ slug: 'home', title: '主页', content: '第二版正文' }])
    const view = await h.call('GET', SUMMARY_PATH, { query: 'slug=home' })
    assert.equal(view.body['stale'], true)
  } finally {
    await h.dispose()
  }
})

/* ============================== 投影档位 ============================== */

test('公开页：生成时用的是**匿名投影**（摘要里不会有组织内才看得到的内容）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([
      {
        slug: 'mixed',
        title: '混合可见性',
        content: '公开部分 + 机密部分',
        publicContent: '公开部分',
        orgContent: '公开部分 + 机密部分',
      },
    ])
    h.saved('mixed')
    await h.flush()
    const rows = h.db.query<{ audience: string }>('SELECT audience FROM page_summaries')
    assert.equal(rows.length, 1, '未落库')
    assert.equal(rows[0]?.audience, 'public')
    const reads = h.getCalls.filter((c) => c.slug === 'mixed')
    assert.ok(reads.some((c) => c.reader === 'anon'), `必须用匿名主体投影，实际：${JSON.stringify(reads)}`)
  } finally {
    await h.dispose()
  }
})

test('组织内页：用**最小权限的组织成员**投影（userId=0，不是某个真实用户）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([
      { slug: 'internal', title: '组织内', content: '组织内正文', orgContent: '组织内正文' },
    ])
    h.saved('internal')
    await h.flush()
    const rows = h.db.query<{ audience: string }>('SELECT audience FROM page_summaries')
    assert.equal(rows.length, 1, '未落库')
    assert.equal(rows[0]?.audience, 'org')
    assert.ok(h.getCalls.some((c) => c.slug === 'internal' && c.reader === 'user:0'), JSON.stringify(h.getCalls))
  } finally {
    await h.dispose()
  }
})

/* ============================== 权限红线 ============================== */

test('读不到这一页的人拿不到摘要（404，不泄露存在性）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'secret', title: '机密', content: '正文' }])
    h.saved('secret')
    await h.flush()
    h.access.set('secret', { level: 'none', canEdit: false })
    const view = await h.call('GET', SUMMARY_PATH, { query: 'slug=secret' })
    assert.equal(view.status, 404)
    assert.equal(view.body['ok'], false)
  } finally {
    await h.dispose()
  }
})

test('匿名不能触发生成（401）；登录但无编辑权给 403；两者都先于模型判定', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '正文' }])
    const anon = await h.call('POST', SUMMARY_PATH, { body: { slug: 'home' }, principal: ANON })
    assert.equal(anon.status, 401)

    h.access.set('home', { level: 'full', canEdit: false })
    const noEdit = await h.call('POST', SUMMARY_PATH, { body: { slug: 'home' }, principal: USER })
    assert.equal(noEdit.status, 403)
    assert.equal(h.llmCalls(), 0, '权限判定必须在模型判定之前：否则响应差异成了一条权限探测通道')
  } finally {
    await h.dispose()
  }
})

test('有编辑权的人可以显式重算，写回库里', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '正文' }])
    const res = await h.call('POST', SUMMARY_PATH, { body: { slug: 'home' }, principal: USER })
    assert.equal(res.status, 200)
    assert.equal(res.body['summary'], '这一页讲怎么新建内容。')
    assert.equal(h.llmCalls(), 1)
  } finally {
    await h.dispose()
  }
})

/* ============================== 按摘要检索 ============================== */

test('按摘要检索：自然语言问句能命中（正文里没有这些字也一样）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([
      { slug: 'home', title: '主页', content: '右上角【新建页面】' },
      { slug: 'other', title: '其它', content: '毫不相关的内容' },
    ])
    // 直接灌一条"像提问"的摘要，模拟生成结果
    h.db.run(
      `INSERT INTO page_summaries (page_id, slug, summary, audience, model, source_hash, generated_at)
       SELECT id, slug, ?, 'public', 'fake-1', 'x', '2026-01-01T00:00:00.000Z' FROM pages WHERE slug = 'home'`,
      ['这一页说明怎么创建内容、新建文章与发布内容的步骤。'],
    )
    const res = await h.call('GET', SUMMARY_SEARCH_PATH, { query: 'q=怎么新建内容' })
    assert.equal(res.status, 200)
    const hits = res.body['hits'] as { slug: string; score: number }[]
    assert.equal(hits.length, 1, JSON.stringify(res.body))
    assert.equal(hits[0]?.slug, 'home')
    assert.ok((hits[0]?.score ?? 0) > 0)
  } finally {
    await h.dispose()
  }
})

test('按摘要检索：结果逐条按可见性过滤（匿名搜不到组织内页面的摘要）', async () => {
  const h = await makeHarness()
  try {
    h.setPages([
      { slug: 'pub', title: '公开', content: 'x' },
      { slug: 'org', title: '组织内', content: 'x' },
    ])
    for (const slug of ['pub', 'org']) {
      h.db.run(
        `INSERT INTO page_summaries (page_id, slug, summary, audience, model, source_hash, generated_at)
         SELECT id, slug, '关于检索的说明', 'public', 'fake-1', 'x', '2026-01-01T00:00:00.000Z' FROM pages WHERE slug = ?`,
        [slug],
      )
    }
    // 匿名：组织内那一页的 access 是 none
    h.access.set('org', { level: 'none', canEdit: false })
    const res = await h.call('GET', SUMMARY_SEARCH_PATH, { query: 'q=检索' })
    const hits = res.body['hits'] as { slug: string }[]
    assert.deepEqual(
      hits.map((x) => x.slug),
      ['pub'],
      `匿名不该看到 org 的摘要：${JSON.stringify(res.body)}`,
    )
  } finally {
    await h.dispose()
  }
})

test('按摘要检索：切不出片段时退化成整串 LIKE，**不是**返回全表', async () => {
  const h = await makeHarness()
  try {
    h.setPages([
      { slug: 'a', title: 'A', content: 'x' },
      { slug: 'b', title: 'B', content: 'x' },
    ])
    for (const slug of ['a', 'b']) {
      h.db.run(
        `INSERT INTO page_summaries (page_id, slug, summary, audience, model, source_hash, generated_at)
         SELECT id, slug, '关于检索的说明', 'public', 'fake-1', 'x', '2026-01-01T00:00:00.000Z' FROM pages WHERE slug = ?`,
        [slug],
      )
    }
    // 单字「关」切不出 bigram（见 plan.ts 的 MIN_GRAM）⇒ 走整串兜底
    const res = await h.call('GET', SUMMARY_SEARCH_PATH, { query: 'q=关' })
    const hits = res.body['hits'] as { slug: string }[]
    assert.equal(hits.length, 2, '整串兜底应当命中两条')
    const none = await h.call('GET', SUMMARY_SEARCH_PATH, { query: 'q=龙' })
    assert.equal((none.body['hits'] as unknown[]).length, 0, '兜底命中不到就该是 0，而不是全表')
  } finally {
    await h.dispose()
  }
})

test('按摘要检索：参数护栏（空 q 400、超长 400、limit 越界 400）', async () => {
  const h = await makeHarness()
  try {
    assert.equal((await h.call('GET', SUMMARY_SEARCH_PATH, { query: '' })).status, 400)
    assert.equal((await h.call('GET', SUMMARY_SEARCH_PATH, { query: `q=${'甲'.repeat(400)}` })).status, 400)
    assert.equal((await h.call('GET', SUMMARY_SEARCH_PATH, { query: 'q=检索&limit=0' })).status, 400)
    assert.equal((await h.call('GET', SUMMARY_SEARCH_PATH, { query: 'q=检索&limit=999' })).status, 400)
  } finally {
    await h.dispose()
  }
})

/* ============================== 工具 ============================== */

test('贡献两条服务端工具，名字与常量一致且都不是 mutating', async () => {
  const h = await makeHarness()
  try {
    const names = [...h.tools.keys()].sort()
    assert.deepEqual(names, [...SUMMARY_TOOL_NAMES].sort())
    for (const tool of h.tools.values()) {
      assert.equal(tool.descriptor.side, 'server')
      assert.notEqual(tool.descriptor.mutating, true, '摘要不改数据，不该标 mutating')
    }
  } finally {
    await h.dispose()
  }
})

test('get_summary：有摘要时带 grounding=kb；没摘要时说清下一步', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '正文' }])
    const missing = await h.tools.get('get_summary')!.execute(USER, { slug: 'home' })
    assert.equal(missing.grounding, undefined, '没摘要就不算"有依据"')
    assert.ok(missing.content.includes('read_page'), missing.content)

    h.db.run(
      `INSERT INTO page_summaries (page_id, slug, summary, audience, model, source_hash, generated_at)
       SELECT id, slug, '这一页讲新建内容。', 'public', 'fake-1', 'x', '2026-01-01T00:00:00.000Z' FROM pages WHERE slug = 'home'`,
    )
    const hit = await h.tools.get('get_summary')!.execute(USER, { slug: 'home' })
    assert.equal(hit.grounding, 'kb')
    assert.ok(hit.content.includes('这一页讲新建内容。'))
  } finally {
    await h.dispose()
  }
})

test('search_summaries：0 命中时给出**可据以改主意**的提示，而不是一句"没有"', async () => {
  const h = await makeHarness()
  try {
    h.setPages([{ slug: 'home', title: '主页', content: '正文' }])
    const res = await h.tools.get('search_summaries')!.execute(USER, { q: '完全不相关的问法' })
    assert.equal(res.grounding, undefined)
    assert.ok(res.content.includes('search_kb'), '空结果必须指出另一条路')
    assert.ok(res.content.includes('list_pages'), '空结果必须指出另一条路')
  } finally {
    await h.dispose()
  }
})
