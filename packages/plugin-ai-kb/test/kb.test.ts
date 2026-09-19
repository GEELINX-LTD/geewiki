/**
 * `@geewiki/ai-kb` 的工具行为测试。
 *
 * **测试策略**：真实的 `AiToolRegistry` + 真实的 cordis `Context`，只把
 * `wiki-service` / `search-service` 换成**记录调用的替身**。理由是本插件的行为
 * 几乎全在"怎么调这两个服务、怎么包装它们的返回"上——那正是替身要记录的东西。
 * 真起数据库与 HTTP 只会引入抖动，真正的端到端由验收脚本覆盖。
 *
 * 替身刻意**记下每次调用的入参**：本层最容易犯的错误不是"结果不对"，而是
 * "把 `mode` 传成默认的 `phrase`"或"漏传主体"——两者都会让检索**恒为 0 命中**，
 * 而 0 命中看起来就像一个正常答案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { FiberLike, Principal } from '@geewiki/core'
import { AiToolRegistry, AiToolsPlugin, type AiToolResult, type ResolvedTool } from '@geewiki/ai-tools'
import type { SearchHit, SearchService } from '@geewiki/search'
import type { WikiPageDetail, WikiPageSummary, WikiService } from '@geewiki/wiki'
import { AiKbPlugin, plainSnippet, type AiKbConfig } from '../src/index.js'

const MEMBER: Principal = {
  kind: 'user',
  userId: 7,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

/* ------------------------------ 替身 ------------------------------ */

interface SearchCall {
  principal: Principal
  q: string
  opts: { limit?: number; mode?: string } | undefined
}

function detail(slug: string, title: string, content: string): WikiPageDetail {
  return {
    slug,
    title,
    content,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    version: 2,
    versions: [],
    capabilities: { canEdit: true, canDelete: false, canManageVisibility: false },
  }
}

function wikiStub(pages: Record<string, { title: string; content: string }>): {
  svc: WikiService
  listCalls: Principal[]
  getCalls: { slug: string; principal: Principal }[]
} {
  const listCalls: Principal[] = []
  const getCalls: { slug: string; principal: Principal }[] = []
  const svc: WikiService = {
    list: async (principal) => {
      listCalls.push(principal)
      return Object.entries(pages).map(
        ([slug, p], i): WikiPageSummary => ({
          slug,
          title: p.title,
          updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
          version: 1,
          // 导航批新增字段：替身里一律"未隐藏"（同级顺序不走摘要，见 GET /api/pages 的 nav_order）
          nav_hidden: false,
        }),
      )
    },
    get: async (slug, principal) => {
      getCalls.push({ slug, principal })
      const p = pages[slug]
      return p === undefined ? undefined : detail(slug, p.title, p.content)
    },
    save: async () => {
      throw new Error('本测试不该调到 save')
    },
    remove: async () => false,
    backlinks: async () => undefined,
    links: async () => undefined,
    // `exists` 是系统写方（@geewiki/builtin-docs 的接管护栏）用的读方法，本测试不调它，
    // 但替身按全量 WikiService 标注就得实现它——诚实实现，别 throw（契约注释见其声明处）
    exists: async (slug) => Object.prototype.hasOwnProperty.call(pages, slug),
    // 同上：系统写方刷 tier 用的方法，本测试不调它，但全量替身就得诚实实现
    resyncTiers: async () => 0,
    // 导航批（2026-09-16）：侧栏隐藏与同层排序。同样不调，但全量替身要诚实实现
    setNavHidden: async (slug, hidden) => Object.prototype.hasOwnProperty.call(pages, slug) && hidden !== undefined,
    setNavOrder: async (_parent, slugs) => slugs.length,
    /*
     * 主页批（2026-09-18）：站点主页设置。本测试不调它们，但全量替身就得诚实实现 ——
     * 替身里"从未设置过主页"（`homeSlug` 回 null），正是升级上来的老站点的形态。
     */
    homeSlug: async () => null,
    setHomeSlug: async (slug) => slug === null || Object.prototype.hasOwnProperty.call(pages, slug),
  }
  return { svc, listCalls, getCalls }
}

function searchStub(result: { hits?: SearchHit[]; total?: number; mode?: 'fts' | 'like' }): {
  svc: SearchService
  calls: SearchCall[]
} {
  const calls: SearchCall[] = []
  const svc: SearchService = {
    search: async (principal, q, opts) => {
      calls.push({ principal, q, opts })
      return { mode: result.mode ?? 'fts', total: result.total ?? (result.hits ?? []).length, hits: result.hits ?? [] }
    },
    contents: async () => new Map(),
  }
  return { svc, calls }
}

function hit(slug: string, title: string, snippet: string): SearchHit {
  return { slug, title, snippet, score: 1.5, gatedCount: 0, updated_at: '2026-01-01T00:00:00.000Z', blocks: [] }
}

/* ------------------------------ 夹具 ------------------------------ */

interface Harness {
  ctx: Context
  registry: AiToolRegistry
  fork: FiberLike
  tools: ResolvedTool[]
  byName(name: string): ResolvedTool
  dispose(): Promise<void>
}

async function mount(
  opts: { wiki?: WikiService | null; search?: SearchService | null; config?: AiKbConfig } = {},
): Promise<Harness> {
  const ctx = new Context()
  const registry = new AiToolRegistry()
  await ctx.plugin(AiToolsPlugin, { registry })
  // 替身服务在装载 ai-kb **之前** provide：这正是"提供者的 apply 先结算"的形态
  if (opts.wiki) ctx.provide('wiki-service', opts.wiki)
  if (opts.search) ctx.provide('search-service', opts.search)
  const fork = await ctx.plugin(AiKbPlugin, opts.config ?? {})

  const tools = [...registry.list(MEMBER)]
  return {
    ctx,
    registry,
    fork,
    tools,
    byName(name) {
      const t = tools.find((x) => x.descriptor.name === name)
      if (!t) throw new Error(`夹具里没有工具 ${name}（现有：${tools.map((x) => x.descriptor.name).join(', ')}）`)
      return t
    },
    async dispose() {
      await fork.dispose()
    },
  }
}

/** 跑一次工具并把它的 content 解析成 JSON——本文件里绝大多数断言都用它 */
async function runJson<T = Record<string, unknown>>(
  tool: ResolvedTool,
  args: unknown,
  principal: Principal = MEMBER,
): Promise<T> {
  /*
   * 第三参是**轮次上下文**（P4 新增）。这三条是只读工具，用不到它——
   * 但契约要求它们显式接住并忽略，故这里给一个明确的 null 上下文，
   * 而不是让测试替它们"悄悄少传一个参数"。
   */
  const result = await tool.execute(principal, args, { conversationId: null, turnId: null })
  return JSON.parse(result.content) as T
}

/* ============================== plainSnippet ============================== */

test('plainSnippet：剥掉 <mark>、解回实体', () => {
  assert.equal(plainSnippet('a<mark>命中</mark>b'), 'a命中b')
  assert.equal(plainSnippet('&lt;div&gt; &amp; &quot;q&quot; &#39;s&#39;'), '<div> & "q" \'s\'')
})

test('plainSnippet：正文里**字面**出现的 <mark> 不能被当成标签删掉（先剥标签、后解实体）', () => {
  // 页面正文写的是字面文本 `<mark>`，escapeHtml 后成为 `&lt;mark&gt;`。
  // 若先解实体再剥标签，它会被误判成高亮标签而**静默删除**——用户正文被改写。
  assert.equal(plainSnippet('&lt;mark&gt;'), '<mark>')
})

test('plainSnippet：字面的 &lt; 不能被解成 <（&amp; 必须最后解）', () => {
  // 页面正文写的是字面文本 `&lt;`，escapeHtml 后是 `&amp;lt;`。
  // 若先解 &amp;，会得到 `&lt;` 再被解成 `<`——把字面文本变成了 HTML 语法。
  assert.equal(plainSnippet('&amp;lt;'), '&lt;')
})

/* ============================== 注册 ============================== */

test('装载后贡献三条工具，owner 都是本插件，且都是只读的 server 工具', async () => {
  const h = await mount({ wiki: wikiStub({}).svc, search: searchStub({}).svc })
  assert.deepEqual(
    h.tools.map((t) => t.descriptor.name).sort(),
    ['list_pages', 'read_page', 'search_kb'],
  )
  for (const t of h.tools) {
    assert.equal(t.owner, '@geewiki/ai-kb')
    assert.equal(t.descriptor.side, 'server')
    // 只读：没有 mutating 标记 ⇒ 不受 P4 的 mutation journal 与自锁护栏约束
    assert.equal(t.descriptor.mutating, undefined)
    assert.equal(t.descriptor.parameters['type'], 'object')
  }
  await h.dispose()
})

test('缺 ai-tool-service 时**明确抛错**，不静默变成一个空插件', async () => {
  const ctx = new Context()
  // ctx.plugin() 返回的是 thenable 的 Fiber（不是 Promise），assert.rejects 不认它
  await assert.rejects(
    async () => {
      await ctx.plugin(AiKbPlugin, {})
    },
    /ai-tool-service 不可用/,
  )
})

test('dispose 后三条工具全部回收（按 owner 定向回收）', async () => {
  const h = await mount({ wiki: wikiStub({}).svc, search: searchStub({}).svc })
  assert.equal(h.registry.diagnostics().count, 3)
  await h.dispose()
  assert.equal(h.registry.diagnostics().count, 0)
  assert.equal(h.registry.ownerOf('search_kb'), undefined)
})

test('依赖服务缺失时对应工具**不进工具表**（连能力都不暴露）', async () => {
  const h = await mount({ search: searchStub({}).svc }) // 没有 wiki-service
  assert.deepEqual(
    h.tools.map((t) => t.descriptor.name),
    ['search_kb'],
  )
  await h.dispose()

  const h2 = await mount({ wiki: wikiStub({}).svc }) // 没有 search-service
  assert.deepEqual(
    h2.tools.map((t) => t.descriptor.name).sort(),
    ['list_pages', 'read_page'],
  )
  await h2.dispose()
})

/* ============================== list_pages ============================== */

test('list_pages：返回 slug 与标题，且**不返回正文**（地图工具不该变成内容入口）', async () => {
  const wiki = wikiStub({
    home: { title: '主页', content: '这是很长的正文，绝不该出现在地图工具的结果里' },
    'guide/intro': { title: '入门', content: '正文二' },
  })
  const h = await mount({ wiki: wiki.svc, search: searchStub({}).svc })

  const r = await runJson(h.byName('list_pages'), {})
  assert.equal(r['total'], 2)
  const pages = r['pages'] as { slug: string; title: string }[]
  assert.deepEqual(pages.map((p) => p.slug), ['home', 'guide/intro'])
  assert.deepEqual(pages.map((p) => p.title), ['主页', '入门'])
  assert.equal(JSON.stringify(r).includes('绝不该出现'), false, 'list_pages 的结果里不得带正文')
  // 主体确实被传下去了
  assert.deepEqual(wiki.listCalls, [MEMBER])
  await h.dispose()
})

test('list_pages：超过 listLimit 时只给前 N 条，并报出总数与截断标记', async () => {
  const pages: Record<string, { title: string; content: string }> = {}
  for (let i = 0; i < 5; i++) pages[`p${i}`] = { title: `页 ${i}`, content: 'x' }
  const h = await mount({ wiki: wikiStub(pages).svc, search: searchStub({}).svc, config: { listLimit: 2 } })

  const r = await runJson(h.byName('list_pages'), {})
  assert.equal(r['total'], 5)
  assert.equal((r['pages'] as unknown[]).length, 2)
  assert.equal(r['truncated'], true)
  assert.match(String(r['note']), /共 5 个页面，此处只列出前 2 个/)
  await h.dispose()
})

/* ============================== search_kb ============================== */

test('search_kb：**必须**走 mode=terms（默认的 phrase 对问句恒为 0 命中）', async () => {
  const search = searchStub({ hits: [hit('home', '主页', '想写新<mark>内容</mark>')] })
  const h = await mount({ wiki: wikiStub({}).svc, search: search.svc })

  await h.byName('search_kb').execute(MEMBER, { q: '新建内容' }, { conversationId: null, turnId: null })

  assert.equal(search.calls.length, 1)
  assert.equal(search.calls[0]?.opts?.mode, 'terms', 'search_kb 漏了 mode=terms 就会恒为 0 命中')
  assert.equal(search.calls[0]?.q, '新建内容')
  assert.deepEqual(search.calls[0]?.principal, MEMBER, '主体必须原样传下去（服务层靠它裁剪权限）')
  assert.equal(search.calls[0]?.opts?.limit, 8)
  await h.dispose()
})

test('search_kb：命中片段被降级成纯文本（<mark> 与实体都清掉）', async () => {
  const search = searchStub({
    hits: [hit('home', '主页', '点右上角「<mark>新建页面</mark>」&amp; 完成')],
  })
  const h = await mount({ wiki: wikiStub({}).svc, search: search.svc })

  const r = await runJson(h.byName('search_kb'), { q: '新建页面' })
  const hits = r['hits'] as { snippet: string }[]
  assert.equal(hits[0]?.snippet, '点右上角「新建页面」& 完成')
  assert.equal(JSON.stringify(r).includes('<mark>'), false)
  assert.equal(JSON.stringify(r).includes('&amp;'), false)
  await h.dispose()
})

test('search_kb：0 命中时给"换词再试"的提示，而不是一个空数组', async () => {
  const search = searchStub({ hits: [], total: 0 })
  const h = await mount({ wiki: wikiStub({}).svc, search: search.svc })

  const r = await runJson(h.byName('search_kb'), { q: '怎么新建内容' })
  assert.equal(r['total'], 0)
  assert.deepEqual(r['hits'], [])
  const hint = String(r['hint'])
  assert.match(hint, /换一个更短/)
  assert.match(hint, /这不代表知识库中没有相关内容/)
  await h.dispose()
})

test('search_kb：0 命中的提示只在 0 命中时出现（有命中就不啰嗦）', async () => {
  const search = searchStub({ hits: [hit('home', '主页', 'x')] })
  const h = await mount({ wiki: wikiStub({}).svc, search: search.svc })
  const r = await runJson(h.byName('search_kb'), { q: 'x' })
  assert.equal(r['hint'], undefined)
  await h.dispose()
})

test('search_kb：参数缺失/类型不符/过长都返回可读的错误结果（不抛错炸掉这一轮）', async () => {
  const search = searchStub({})
  const h = await mount({ wiki: wikiStub({}).svc, search: search.svc })
  const run = (args: unknown): Promise<Record<string, unknown>> => runJson(h.byName('search_kb'), args)

  assert.match((await run({}))['error'] as string, /缺少参数 q/)
  assert.match((await run({ q: 42 }))['error'] as string, /缺少参数 q/)
  assert.match((await run({ q: '   ' }))['error'] as string, /缺少参数 q/)
  assert.match((await run(null))['error'] as string, /缺少参数 q/)
  assert.match((await run({ q: 'x'.repeat(501) }))['error'] as string, /检索词过长（501 字符，上限 500 字符）/)

  // 上面每一次都不该真的打到检索服务
  assert.equal(search.calls.length, 0)
  await h.dispose()
})

test('search_kb：多给的键一律忽略（模型经常顺手多塞字段）', async () => {
  const search = searchStub({})
  const h = await mount({ wiki: wikiStub({}).svc, search: search.svc })
  await h.byName('search_kb').execute(MEMBER, { q: 'ok', limit: 100, mode: 'phrase', extra: true }, { conversationId: null, turnId: null })
  assert.equal(search.calls[0]?.opts?.mode, 'terms', '模型给的 mode 不得覆盖本层的 terms')
  assert.equal(search.calls[0]?.opts?.limit, 8, '模型给的 limit 不得覆盖配置')
  await h.dispose()
})

/* ============================== read_page ============================== */

test('read_page：返回标题与正文，主体原样传给 wiki-service', async () => {
  const wiki = wikiStub({ home: { title: '主页', content: '正文内容' } })
  const h = await mount({ wiki: wiki.svc, search: searchStub({}).svc })

  const r = await runJson(h.byName('read_page'), { slug: 'home' })
  assert.equal(r['slug'], 'home')
  assert.equal(r['title'], '主页')
  assert.equal(r['text'], '正文内容')
  assert.equal(r['truncated'], undefined)
  assert.deepEqual(wiki.getCalls, [{ slug: 'home', principal: MEMBER }])
  await h.dispose()
})

test('read_page：页面不存在/无权时给同一条回答（不透露 slug 是否存在）', async () => {
  const h = await mount({ wiki: wikiStub({}).svc, search: searchStub({}).svc })
  const r = await runJson(h.byName('read_page'), { slug: 'secret' })
  const err = String(r['error'])
  assert.match(err, /没有找到页面 secret/)
  assert.match(err, /也可能存在但当前用户无权查看/)
  await h.dispose()
})

test('read_page：正文超长时截断，并**明确说出**被截断了（不得静默截断）', async () => {
  const long = 'a'.repeat(1000)
  const wiki = wikiStub({ big: { title: '长页', content: long } })
  // maxPageChars 的 schema 下界是 500（配置校验真实生效），故用 500
  const h = await mount({ wiki: wiki.svc, search: searchStub({}).svc, config: { maxPageChars: 500 } })

  const r = await runJson(h.byName('read_page'), { slug: 'big' })
  assert.equal((r['text'] as string).length, 500)
  assert.equal(r['truncated'], true)
  assert.equal(r['totalChars'], 1000)
  // 这条 note 就是 E4 的修复：静默截断会把"我没看到"伪装成"资料里没有"
  assert.match(String(r['note']), /正文共 1000 字符，此处只含前 500 字符/)
  assert.match(String(r['note']), /不要.*断言/)
  assert.match(String(r['note']), /search_kb/)
  await h.dispose()
})

test('read_page：恰好等于上限时不标截断（边界不多报）', async () => {
  const wiki = wikiStub({ exact: { title: '恰好', content: 'b'.repeat(500) } })
  const h = await mount({ wiki: wiki.svc, search: searchStub({}).svc, config: { maxPageChars: 500 } })
  const r = await runJson(h.byName('read_page'), { slug: 'exact' })
  assert.equal(r['truncated'], undefined)
  assert.equal((r['text'] as string).length, 500)
  await h.dispose()
})

test('read_page：参数缺失返回错误结果', async () => {
  const h = await mount({ wiki: wikiStub({}).svc, search: searchStub({}).svc })
  assert.match(
    (await runJson(h.byName('read_page'), {}))['error'] as string,
    /缺少参数 slug/,
  )
  await h.dispose()
})

/* ==================== 需求 ⑥：这条结果算不算知识库依据 ==================== */

/** 直接拿工具结果本体（要断言的是 `grounding`，它**不进** content 的 JSON） */
async function rawResult(tool: ResolvedTool, args: unknown): Promise<AiToolResult> {
  return tool.execute(MEMBER, args, { conversationId: null, turnId: null })
}

test('★ grounding：read_page 逐字读到正文 ⇒ 声明 kb（本仓最强的一种依据）', async () => {
  const h = await mount({ wiki: wikiStub({ home: { title: '主页', content: '正文' } }).svc })
  const r = await rawResult(h.byName('read_page'), { slug: 'home' })
  assert.equal(r.grounding, 'kb')
  await h.dispose()
})

test('★ grounding：search_kb 命中 ⇒ kb；命中 0 条 ⇒ **不声明**（跑了但一个字的资料都没给模型）', async () => {
  const withHit = await mount({ search: searchStub({ hits: [hit('home', '主页', '新建页面')], total: 1 }).svc })
  const one = await rawResult(withHit.byName('search_kb'), { q: '新建' })
  assert.equal(one.grounding, 'kb')
  await withHit.dispose()

  const noHit = await mount({ search: searchStub({ hits: [], total: 0 }).svc })
  const zero = await rawResult(noHit.byName('search_kb'), { q: '新建' })
  assert.equal(zero.grounding, undefined, '0 命中若算依据，模型凭空写的答案就会不带任何标注地显示出来')
  await noHit.dispose()
})

test('★ grounding：list_pages 不声明依据（目录信息不是能回答问题的资料）', async () => {
  /*
   * 若把地图算成依据，模型只要先列一次页面，接下来凭空写的答案就会被判成
   * "引用了知识库"——恰好是需求 ⑥ 要消灭的那种冒充。
   */
  const h = await mount({ wiki: wikiStub({ home: { title: '主页', content: '正文' } }).svc })
  const r = await rawResult(h.byName('list_pages'), {})
  assert.equal(r.grounding, undefined)
  await h.dispose()
})
