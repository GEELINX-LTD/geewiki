/**
 * @geewiki/search 全文检索插件的集成测试。
 *
 * **测试策略**：真实 SQLite（临时目录的库文件）+ 真实迁移 + 真实触发器，只有 HTTP 层
 * 用路由服务替身（记录 handler 并可直接调用、取回状态码与响应体）。
 * 理由：本插件的行为几乎全部落在 SQL 上（trigram 分词、external content 触发器一致性、
 * LIKE 转义、BM25 排序），用假 db 替身等于把要验证的东西全替掉；而真起一个 HTTP 端口
 * 只会引入端口冲突与超时抖动，真实的 HTTP 链路另由隔离实例的 REST 端到端验收覆盖。
 *
 * 每个用例都在自己的临时库上跑，绝不触碰仓库的 data/geewiki.db。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { Context as CordisContext } from 'cordis'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import type { HttpRouterService, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import {
  SEARCH_MIGRATIONS_DIR,
  SearchPlugin,
  buildSnippet,
  escapeHtml,
  escapeLike,
  toFtsPhrase,
  type SearchService,
} from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

interface SearchResponse {
  ok: true
  query: string
  mode: 'fts' | 'like'
  total: number
  hits: { slug: string; title: string; snippet: string; score: number; updated_at: string }[]
}

interface Harness {
  db: SqliteDatabase
  /** 插件的 ctx（用于断言 provide 出来的 search-service） */
  ctx: Context
  /** 底层服务表：db/http 由夹具预置，search-service 由插件 provide 进去 */
  services: Map<string, unknown>
  /** 调用 GET /api/search（queryString 形如 'q=插件化&limit=1'） */
  search(queryString: string): Promise<{ status: number; body: Record<string, unknown> }>
  /** 直接写 pages 表（触发器会把变更同步进 FTS 索引） */
  putPage(slug: string, title: string, content: string, updatedAt?: string): void
  /** 仅卸载插件（保留 db 与 ctx，便于断言卸载后的服务状态） */
  unload(): void
  dispose(): void
}

/**
 * 建一个隔离的检索环境：
 * 1. 真实 better-sqlite3 临时库，`SqliteDatabase.open()` 会先跑 db-sqlite 自己的迁移（建 pages 表）；
 * 2. 再按管理器迁移控制器的做法执行**本插件自己的迁移**（建 FTS 索引与触发器）；
 * 3. 以路由服务替身驱动插件的 apply()，dispose 走插件返回的清理函数。
 */
function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gw-search-'))
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
  // 插件只经 ctx 取 db / http 两个服务，故这里给最小替身；类型由 Context 约束住。
  // `provide` 按 cordis 的**同 ctx** 语义实现（实测：直接 apply 到 root ctx 时
  // provide→get 立即可见、注销后回到 undefined），故 harness 能忠实断言
  // `ctx.get('search-service')`；真实 cordis 下的**跨插件**可见性另由
  // "真实 cordis：search-service 对兄弟插件可见"一例覆盖。
  const services = new Map<string, unknown>([
    ['db', db],
    ['http', routerService],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => {
        // 与 cordis 一致：注销把名字摘掉，后续 get 回到 undefined
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context
  const dispose = SearchPlugin.apply(ctx, { limit: 20, snippetRadius: 48 }) as () => void

  const search = (queryString: string) => {
    const handler = routes.get('GET /api/search')
    assert.ok(handler, '应已注册路由 GET /api/search')
    const url = new URL(`http://localhost/api/search?${queryString}`)
    const req = Readable.from([]) as unknown as IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers = {}
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const h: RouteHandlerContext = {
        req,
        res: { once: () => {} } as unknown as ServerResponse,
        url,
        params: {},
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  const putPage = (slug: string, title: string, content: string, updatedAt = '2024-01-01T00:00:00.000Z'): void => {
    const existing = db.query<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug])[0]
    if (existing) {
      db.run('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?', [title, content, updatedAt, existing.id])
      return
    }
    db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      slug,
      title,
      content,
      updatedAt,
      updatedAt,
    ])
  }

  let unloaded = false
  const unload = (): void => {
    if (unloaded) return
    unloaded = true
    dispose()
  }

  return {
    db,
    ctx,
    services,
    search,
    putPage,
    unload,
    dispose: () => {
      unload()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 断言某次检索走了指定路径并返回 SearchResponse */
async function searchAs(h: Harness, queryString: string, expectedMode: 'fts' | 'like'): Promise<SearchResponse> {
  const res = await h.search(queryString)
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}: ${JSON.stringify(res.body)}`)
  const body = res.body as unknown as SearchResponse
  assert.equal(body.mode, expectedMode, `期望走 ${expectedMode} 路径，实际 ${body.mode}`)
  return body
}

const slugs = (body: SearchResponse): string[] => body.hits.map((hit) => hit.slug)

/* ------------------------------ 用例 ------------------------------ */

test('中文 3 字子串命中（trigram / MATCH 路径）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '插件化知识库', '这是一个插件化的知识库系统，支持热插拔与全文检索。')
    h.putPage('p2', '无关页面', '与主题无关的内容。')

    const body = await searchAs(h, 'q=插件化', 'fts')
    assert.equal(body.total, 1)
    assert.deepEqual(slugs(body), ['p1'])
    // BM25 归一化后应为"越大越相关"的正数
    assert.ok((body.hits[0]?.score ?? 0) > 0, `score 应归一化为正数，实际 ${body.hits[0]?.score}`)
  } finally {
    h.dispose()
  }
})

test('中文 2 字查询走 LIKE 兜底并命中（trigram 的硬缺口）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '检索设计', '全文检索是知识库的地基。')
    h.putPage('p2', '别的页面', '没有那两个字。')

    // 同样的词在 MATCH 下是空结果（trigram 切不出 2 字片段），故必须走 LIKE
    const ftsProbe = h.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?', ['"检索"'])
    assert.equal(Number(ftsProbe[0]?.n ?? 0), 0, '前置：MATCH 对 2 字中文查不到（这正是要兜底的原因）')

    const body = await searchAs(h, 'q=检索', 'like')
    assert.equal(body.total, 1)
    assert.deepEqual(slugs(body), ['p1'])
    assert.ok(body.hits[0]?.snippet.includes('<mark>检索</mark>'), `片段应高亮命中词: ${body.hits[0]?.snippet}`)
  } finally {
    h.dispose()
  }
})

test('英文单词命中（≥3 字符走 MATCH，大小写不敏感）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', 'GeeWiki docs', 'GeeWiki is an AI-native knowledge base with plugins.')
    h.putPage('p2', '其他', '无关内容。')

    const body = await searchAs(h, 'q=GeeWi', 'fts')
    assert.deepEqual(slugs(body), ['p1'])
    const lower = await searchAs(h, 'q=geewiki', 'fts')
    assert.deepEqual(slugs(lower), ['p1'], 'trigram 对英文大小写不敏感')
  } finally {
    h.dispose()
  }
})

test('不存在的词返回 0（两条路径都是空结果）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题', '这里没有那个词。')
    // 两条路径分别验证：≥3 字符走 fts，<3 字符走 like
    assert.equal((await searchAs(h, 'q=完全不存在的词组', 'fts')).total, 0)
    assert.equal((await searchAs(h, 'q=缺词', 'like')).total, 0)
    assert.deepEqual((await searchAs(h, 'q=缺词', 'like')).hits, [])
  } finally {
    h.dispose()
  }
})

test('一致性：插入页面后能搜到', async () => {
  const h = makeHarness()
  try {
    assert.equal((await searchAs(h, 'q=新增独特词', 'fts')).total, 0, '前置：插入前搜不到')
    h.putPage('p1', '新页面', '这段正文含新增独特词，用来验证触发器的插入同步。')
    const body = await searchAs(h, 'q=新增独特词', 'fts')
    assert.equal(body.total, 1)
    assert.deepEqual(slugs(body), ['p1'])
  } finally {
    h.dispose()
  }
})

test('一致性：更新页面后旧词搜不到、新词搜得到（AFTER UPDATE 触发器）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题甲', '正文里有旧词阿尔法，只出现这一次。')
    assert.equal((await searchAs(h, 'q=旧词阿尔法', 'fts')).total, 1)

    h.putPage('p1', '标题甲', '换成了新词贝塔，内容完全不同。')
    assert.equal((await searchAs(h, 'q=旧词阿尔法', 'fts')).total, 0, '旧词必须从索引里消失（触发器只 delete 不 insert 就会残留）')
    assert.equal((await searchAs(h, 'q=新词贝塔', 'fts')).total, 1, '新词必须可检索')
    // LIKE 路径读的是 pages 表本身，也应为最新内容
    assert.equal((await searchAs(h, 'q=旧词', 'like')).total, 0)
    assert.equal((await searchAs(h, 'q=贝塔', 'like')).total, 1)
  } finally {
    h.dispose()
  }
})

test('一致性：删除页面后搜不到（AFTER DELETE 触发器）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '待删除', '正文含独特词伽马，用来验证删除同步。')
    assert.equal((await searchAs(h, 'q=独特词伽马', 'fts')).total, 1)

    h.db.run('DELETE FROM pages WHERE slug = ?', ['p1'])
    assert.equal((await searchAs(h, 'q=独特词伽马', 'fts')).total, 0, '删除后索引里的行必须一并移除')
    assert.equal((await searchAs(h, 'q=伽马', 'like')).total, 0, 'LIKE 读 pages 表，同样不应命中已删除行')
  } finally {
    h.dispose()
  }
})

test('存量数据回填：迁移应用前已存在的页面也能被检索到（rebuild 路径）', async () => {
  // 这是真实的升级路径：用户先有 wiki 数据，之后才装上检索插件。
  // 触发器只对"此后发生的"变更生效，存量行必须靠迁移末尾的 rebuild 回填。
  const dir = mkdtempSync(join(tmpdir(), 'gw-search-upgrade-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  try {
    db.open() // 只跑 db-sqlite 的迁移：此时还没有 pages_fts
    db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      'legacy',
      '存量标题',
      '这篇是安装检索插件之前就存在的页面，含存量独特词西格玛。',
      '2023-01-01T00:00:00.000Z',
      '2023-01-01T00:00:00.000Z',
    ])
    assert.equal(
      db.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pages_fts'")[0]?.n,
      0,
      '前置：此时索引尚不存在',
    )

    // 安装检索插件：迁移控制器执行本插件迁移（建索引 + 触发器 + rebuild 回填）
    db.migrate(SEARCH_MIGRATIONS_DIR)
    assert.equal(
      Number(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?', ['"存量独特词西格玛"'])[0]?.n ?? 0),
      1,
      'rebuild 必须把存量行回填进索引',
    )

    // 回填之后，触发器对新变更同样生效
    db.run("UPDATE pages SET content = ?, updated_at = ? WHERE slug = 'legacy'", ['改成了新词陶，旧词不再出现。', '2024-01-01T00:00:00.000Z'])
    assert.equal(
      Number(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?', ['"存量独特词西格玛"'])[0]?.n ?? 0),
      0,
      '回填后触发器仍须与内容表同步',
    )
    assert.equal(
      Number(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?', ['"新词陶"'])[0]?.n ?? 0),
      1,
    )

    // 迁移可重放（幂等）：再跑一次不应抛错，也不应把索引搞乱
    assert.doesNotThrow(() => db.migrate(SEARCH_MIGRATIONS_DIR))
    assert.equal(
      Number(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?', ['"新词陶"'])[0]?.n ?? 0),
      1,
      '重放迁移（含 rebuild）后索引内容不变',
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LIKE 兜底不依赖 FTS 索引：索引缺失时短查询仍给出正确结果（且长查询显式报错）', async () => {
  // 兜底路径直接扫 pages 表，故索引漂移/缺失不会让短查询静默漏行。
  const h = makeHarness()
  try {
    h.putPage('p1', '标题甲', '正文含两字词检索，用于验证兜底路径的独立性。')

    // 走一遍正常路径，确认基线
    assert.equal((await searchAs(h, 'q=检索', 'like')).total, 1)

    // 制造"索引缺失"：把 FTS 表整个删掉（模拟迁移未跑全 / 索引被误删）
    h.db.run('DROP TABLE pages_fts')

    // 短查询（LIKE 路）仍应正确返回——它读的是真源
    const fallback = await searchAs(h, 'q=兜底', 'like')
    assert.equal(fallback.total, 1, '索引缺失时短查询仍须命中（LIKE 扫 pages 表）')
    assert.deepEqual(fallback.hits.map((x) => x.slug), ['p1'])
    // 长查询无法回避索引：应显式抛错（宁可响，不可静默返回空结果）
    await assert.rejects(
      () => h.search('q=验证兜底'),
      (err: unknown) => /no such table: pages_fts/.test((err as Error).message),
      '≥3 字符查询在索引缺失时必须显式失败，而不是静默返回空',
    )
  } finally {
    h.dispose()
  }
})

test('索引与 pages 表一致（FTS5 integrity-check）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '甲', '内容甲含词汇一。')
    h.putPage('p2', '乙', '内容乙含词汇二。')
    h.putPage('p1', '甲', '内容甲改成了词汇三。')
    h.db.run('DELETE FROM pages WHERE slug = ?', ['p2'])
    // external content 表的自检：索引与内容表不一致时会抛错
    assert.doesNotThrow(() => h.db.run("INSERT INTO pages_fts(pages_fts) VALUES('integrity-check')"))
  } finally {
    h.dispose()
  }
})

test('空查询 → 400 invalid_query（绝不把空串传给 MATCH）', async () => {
  const h = makeHarness()
  try {
    for (const qs of ['', 'q=', 'q=%20%20', 'q=%09']) {
      const res = await h.search(qs)
      assert.equal(res.status, 400, `queryString=${JSON.stringify(qs)} 应 400`)
      assert.equal(res.body['error'], 'invalid_query')
    }
    // 缺少 q 参数同样按空查询处理
    const missing = await h.search('limit=5')
    assert.equal(missing.status, 400)
    assert.equal(missing.body['error'], 'invalid_query')
    // 前置对照：空串直接交给 MATCH 会抛 fts5 syntax error（这正是必须拦在入口的原因）
    assert.throws(
      () => h.db.query('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?', ['']),
      /fts5: syntax error/,
    )
  } finally {
    h.dispose()
  }
})

test('FTS5 查询语法注入：敌意输入不报错且按字面短语处理', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题', '正文里字面含有 a OR b 这个串，也含有星号*与引号"。')

    const hostile = [
      '"', // 未闭合引号
      '*', // 特殊查询前缀
      '***',
      'a OR b', // 布尔语法
      'a AND b',
      'NOT x',
      'NEAR(', // 语法错误
      'NEAR(a b, 2)',
      '^x', // 列过滤前缀
      'x:y',
      '{a}',
      '(a)',
      '中文"引号',
      '"',
      '\\',
      'a-b_c',
      'OR',
    ]
    for (const q of hostile) {
      const res = await h.search(`q=${encodeURIComponent(q)}`)
      assert.equal(res.status, 200, `q=${JSON.stringify(q)} 不应报错: ${JSON.stringify(res.body)}`)
      assert.equal(res.body['ok'], true)
    }

    // 语义：a OR b 作为**字面短语**只匹配真的含有该串的页面
    const literal = await searchAs(h, `q=${encodeURIComponent('a OR b')}`, 'fts')
    assert.equal(literal.total, 1, '应作为字面串匹配（若被当成布尔语法，会变成匹配 a 或 b，命中面更大）')
    assert.deepEqual(slugs(literal), ['p1'])
  } finally {
    h.dispose()
  }
})

test('snippet：HTML 转义 + <mark> 高亮（正文是用户内容，不能变成 XSS 向量）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题', '前面有 <script>alert("xss")</script> 后面跟着命中词独特词德尔塔。')

    const body = await searchAs(h, 'q=独特词德尔塔', 'fts')
    const snippet = body.hits[0]?.snippet ?? ''
    assert.ok(snippet.includes('<mark>独特词德尔塔</mark>'), `应高亮命中词: ${snippet}`)
    assert.ok(!snippet.includes('<script>'), `原始 <script> 必须被转义: ${snippet}`)
    assert.ok(snippet.includes('&lt;script&gt;'), `应出现转义后的实体: ${snippet}`)
    assert.ok(snippet.includes('&quot;xss&quot;'), `双引号必须被转义: ${snippet}`)
    // 除 <mark> 外不应有其它真标签
    assert.equal(snippet.replace(/<\/?mark>/g, '').includes('<'), false, `不应残留其它标签: ${snippet}`)
  } finally {
    h.dispose()
  }
})

test('snippet：只命中标题时退回标题片段；截断处补省略号', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题含独特词艾普西龙', '正文里完全没有那个词。')
    const body = await searchAs(h, 'q=独特词艾普西龙', 'fts')
    assert.equal(body.total, 1)
    assert.ok(body.hits[0]?.snippet.includes('<mark>独特词艾普西龙</mark>'), `应退回标题片段: ${body.hits[0]?.snippet}`)

    // 长正文：片段应被截断并带省略号
    const long = `${'铺垫'.repeat(80)}命中词泽塔${'收尾'.repeat(80)}`
    h.putPage('p2', '长文', long)
    const longBody = await searchAs(h, 'q=命中词泽塔', 'fts')
    const snippet = longBody.hits[0]?.snippet ?? ''
    assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), `两侧截断应补省略号: ${snippet}`)
    assert.ok(snippet.length < long.length, '片段必须比正文短')
  } finally {
    h.dispose()
  }
})

test('limit 生效且 total 不受 limit 影响', async () => {
  const h = makeHarness()
  try {
    for (let i = 0; i < 5; i++) h.putPage(`p${i}`, `标题${i}`, `这段正文都含共同词奥米克戎，编号 ${i}。`)
    // 序号越大 updated_at 越新，用于验证 LIKE 路的排序
    for (let i = 0; i < 5; i++) h.putPage(`q${i}`, `标题${i}`, `这段正文都含共同词奥米克戎，编号 ${i}。`, `2024-01-0${i + 1}T00:00:00.000Z`)

    const all = await searchAs(h, 'q=共同词奥米克戎', 'fts')
    assert.equal(all.total, 10, 'total 应为全量命中数')
    assert.equal(all.hits.length, 10, '未传 limit 时用默认值 20，故全部返回')

    const limited = await searchAs(h, 'q=共同词奥米克戎&limit=3', 'fts')
    assert.equal(limited.hits.length, 3, 'limit=3 应只返回 3 条')
    assert.equal(limited.total, 10, 'total 不受 limit 限制')

    // LIKE 路同样：total 全量、hits 受限，且按 updated_at DESC
    const likeLimited = await searchAs(h, 'q=共同&limit=2', 'like')
    assert.equal(likeLimited.hits.length, 2)
    assert.equal(likeLimited.total, 10)
    const dates = likeLimited.hits.map((hit) => hit.updated_at)
    assert.deepEqual(dates, [...dates].sort().reverse(), `LIKE 路应按 updated_at 倒序: ${JSON.stringify(dates)}`)
  } finally {
    h.dispose()
  }
})

test('limit 非法值 → 400 invalid_limit', async () => {
  const h = makeHarness()
  try {
    for (const bad of ['0', '-1', 'abc', '1.5', '101', '999999']) {
      const res = await h.search(`q=插件化&limit=${bad}`)
      assert.equal(res.status, 400, `limit=${bad} 应 400`)
      assert.equal(res.body['error'], 'invalid_limit')
    }
  } finally {
    h.dispose()
  }
})

test('LIKE 路径：%、_ 与转义符按字面匹配（不转义会变成通配符）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '进度', '完成了 100% 的进度_校验步骤。')
    h.putPage('p2', '其它', '完全不同的内容。')

    // LIKE 路只服务 <3 字符的查询，故这里用 2 字符样例：
    // 若 % / _ 未被转义，它们会退化成通配符（`0%` 命中"以 0 开头的一切"、`%_` 命中任意两字符）
    assert.equal((await searchAs(h, `q=${encodeURIComponent('0%')}`, 'like')).total, 1, '% 应按字面匹配')
    assert.equal((await searchAs(h, `q=${encodeURIComponent('%_')}`, 'like')).total, 0, '_ 与 % 都应按字面匹配（正文里没有这两个字符相邻）')
    assert.equal((await searchAs(h, `q=${encodeURIComponent('校验')}`, 'like')).total, 1, '对照：正文里真实存在的两字词命中')
    assert.equal((await searchAs(h, `q=${encodeURIComponent('删除')}`, 'like')).total, 0, '对照：正文里不存在的两字词不命中')
  } finally {
    h.dispose()
  }
})

test('卸载后路由注销（apply 返回的清理函数生效）', async () => {
  const h = makeHarness()
  try {
    h.dispose()
    const res = await h.search('q=插件化')
    assert.equal(res.status, undefined, '卸载后不应再能调用该路由')
  } catch (err) {
    // search() 在路由不存在时以断言失败结束，这正是"已注销"的证据
    assert.match((err as Error).message, /应已注册路由/)
  }
})

/* ------------- search-service 服务契约（AI/RAG 批次的前置项） ------------- */

/** 取 search-service，顺带断言它确实被 provide 出来了 */
function serviceOf(h: Harness): SearchService {
  const svc = h.ctx.get('search-service') as SearchService | undefined
  // 用 assert.ok 而非 notEqual：它带 assertion signature，能把类型收窄成 SearchService
  assert.ok(svc, 'search-service 必须被 provide（manifest 的 provides 只是依赖图 token，不建服务）')
  assert.equal(typeof svc.search, 'function', 'svc.search 必须是函数')
  assert.equal(typeof svc.contents, 'function', 'svc.contents 必须是函数')
  return svc
}

test('search-service：apply 后 ctx.get 拿得到，且 search/contents 都是函数', async () => {
  const h = makeHarness()
  try {
    const svc = serviceOf(h)
    // 探针反证：manifest 声明的 provides 不会自己变成 cordis 服务——
    // 若插件里漏掉 ctx.provide，这里拿到的是 undefined（这正是本批要修的症状）
    assert.ok(h.services.has('search-service'), 'provide 应把服务登记进 ctx')
    assert.equal(svc.search('插件化').total, 0, '空库检索应为 0 命中而非抛错')
  } finally {
    h.dispose()
  }
})

test('search-service：svc.search 与 REST 端点结果逐字段一致（单一实现）', async () => {
  const h = makeHarness()
  try {
    const svc = serviceOf(h)
    for (let i = 0; i < 4; i++) h.putPage(`p${i}`, `标题${i}`, `正文都含共同词奥米克戎，编号 ${i}。`)

    // FTS 路（≥3 字符）
    const ftsRes = await h.search('q=共同词奥米克戎&limit=2')
    const ftsSvc = svc.search('共同词奥米克戎', { limit: 2 })
    assert.equal(ftsRes.body['mode'], ftsSvc.mode)
    assert.equal(ftsRes.body['total'], ftsSvc.total)
    assert.deepEqual(ftsRes.body['hits'], [...ftsSvc.hits], 'FTS 路：端点与服务的 hits 必须逐字段一致')

    // LIKE 路（<3 字符）
    const likeRes = await h.search('q=共同&limit=1')
    const likeSvc = svc.search('共同', { limit: 1 })
    assert.equal(likeRes.body['mode'], 'like')
    assert.equal(likeRes.body['mode'], likeSvc.mode)
    assert.equal(likeRes.body['total'], likeSvc.total)
    assert.deepEqual(likeRes.body['hits'], [...likeSvc.hits], 'LIKE 路：端点与服务的 hits 必须逐字段一致')

    // 默认 limit 也必须一致（端点不传 limit ↔ 服务不传 opts）
    const defRes = await h.search('q=共同词奥米克戎')
    const defSvc = svc.search('共同词奥米克戎')
    assert.deepEqual(defRes.body['hits'], [...defSvc.hits])
    assert.equal(defSvc.hits.length, 4, '默认 limit 20 应返回全部 4 条')

    // 空查询：服务层返回空结果（端点层另用 400 invalid_query 表达 HTTP 语义）
    assert.deepEqual(svc.search('   '), { mode: 'like', total: 0, hits: [] })
    // 非法 limit：服务层抛错（与端点的 400 对应）
    assert.throws(() => svc.search('共同', { limit: 0 }), RangeError)
    assert.throws(() => svc.search('共同', { limit: 101 }), RangeError)
  } finally {
    h.dispose()
  }
})

test('search-service.contents：批量取正文，只含存在的 slug（供 RAG 拼上下文）', async () => {
  const h = makeHarness()
  try {
    const svc = serviceOf(h)
    h.putPage('a', '甲', '甲的完整正文，含独特词阿尔法。')
    h.putPage('b', '乙', '乙的完整正文，含独特词贝塔。')

    assert.equal(svc.contents([]).size, 0, '空数组直接返回空 Map')

    const single = svc.contents(['a'])
    assert.equal(single.size, 1)
    assert.equal(single.get('a'), '甲的完整正文，含独特词阿尔法。', 'value 必须是该页完整正文（逐字一致）')

    const both = svc.contents(['a', 'b'])
    assert.equal(both.size, 2)
    assert.equal(both.get('b'), '乙的完整正文，含独特词贝塔。')

    // 查不到的 slug 不进 Map（消费方据此区分"页面不存在"与"正文为空串"）
    const mixed = svc.contents(['a', '不存在的slug', 'b'])
    assert.equal(mixed.size, 2)
    assert.equal(mixed.has('不存在的slug'), false)
    assert.deepEqual([...mixed.keys()].sort(), ['a', 'b'])

    // 一次 IN 查询能跨越多个 slug（多于 1 个占位符时的正确性）
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => s)
    for (const s of ['c', 'd', 'e', 'f']) h.putPage(s, s, `正文-${s}`)
    assert.equal(svc.contents(many).size, 6)

    // 顺序无关
    assert.deepEqual([...svc.contents(['b', 'a']).keys()].sort(), ['a', 'b'])
  } finally {
    h.dispose()
  }
})

test('search-service.contents：SQL 注入防护——slug 走参数绑定，绝不拼进 SQL', async () => {
  const h = makeHarness()
  try {
    const svc = serviceOf(h)
    h.putPage('p1', '标题', '正文含独特词伽马。')

    // 敌意输入：若实现把 slug 字符串拼进 SQL，这些会让 IN 条件恒真 → 返回全表
    const hostile = ["' OR 1=1 --", "p1' OR '1'='1", "x'); DROP TABLE pages; --", '%', '_', '"', '\\']
    for (const slug of hostile) {
      let result: ReadonlyMap<string, string>
      assert.doesNotThrow(() => {
        result = svc.contents([slug])
      }, `slug=${JSON.stringify(slug)} 不应抛错`)
      assert.equal(result!.size, 0, `slug=${JSON.stringify(slug)} 必须按字面匹配（注入成功会返回全表）`)
    }

    // 混合敌意输入与真实 slug：只应返回真实那个，且表完好
    const mixed = svc.contents(["' OR 1=1 --", 'p1'])
    assert.equal(mixed.size, 1)
    assert.deepEqual([...mixed.keys()], ['p1'])

    // 反证表还在（DROP 类注入若得逞，这里会抛 no such table）
    assert.equal(Number(h.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages')[0]?.n ?? 0), 1)
  } finally {
    h.dispose()
  }
})

test('search-service：卸载后服务注销、路由摘除（不留"仍可调用但已失效"的语义）', async () => {
  const h = makeHarness()
  try {
    const svc = serviceOf(h)
    h.putPage('p1', '标题', '正文含独特词伽马。')
    assert.equal(svc.search('独特词伽马').total, 1, '前置：卸载前服务可用')

    h.unload()

    assert.equal(h.ctx.get('search-service'), undefined, '卸载后 ctx.get 必须回到 undefined（消费者会改走缺失分支）')
    // 路由同步摘除：search() 在路由不存在时同步抛断言失败
    assert.throws(() => h.search('q=插件化'), /应已注册路由/)
    // 注销不抛错且幂等
    assert.doesNotThrow(() => h.unload())

    // **已持有 svc 引用**的消费方再调用：必须显式报错，而不是静默返回空结果
    // （静默空结果会被误读成"库里没有匹配内容"，是本批要消灭的那类难定位症状）
    assert.throws(() => svc.search('独特词伽马'), /已卸载/, '卸载后 svc.search 必须显式报错')
    assert.throws(() => svc.contents(['p1']), /已卸载/, '卸载后 svc.contents 必须显式报错')
  } finally {
    h.dispose()
  }
})

test('真实 cordis：search-service 对兄弟插件（未来的 AI/RAG 批次）可见，卸载后注销', async () => {
  // 为什么单独写一例：上面的 harness 用替身 ctx，只能证明"同 ctx 内 provide→get"。
  // 而消费方会是**另一个插件**（各自跑在 ctx.plugin() 的子 fiber 里）。
  // 这里用真实 cordis + 真实 ctx.plugin() 装配，证明跨插件可见性在生产路径上成立。
  const dir = mkdtempSync(join(tmpdir(), 'gw-search-cordis-'))
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

    // 生产路径：管理器就是 `await ctx.plugin(module, config)` 逐插件激活
    const fork = root.plugin(SearchPlugin, { limit: 20, snippetRadius: 48 })
    await fork

    const svc = root.get('search-service') as SearchService | undefined
    assert.ok(svc, '真实 cordis 下 root.get 也应拿到 search-service')

    // 兄弟插件：模拟 AI/RAG 批次在自己的 apply 里 ctx.get('search-service')
    let seenBySibling: unknown = 'NOT_RUN'
    const sibling = {
      name: '@geewiki-test/probe-consumer',
      apply(ctx: Context) {
        seenBySibling = ctx.get('search-service')
        return () => {}
      },
    }
    const siblingFork = root.plugin(sibling)
    await siblingFork // 生产里依赖插件先激活，故这里也 await 完成后再看
    assert.notEqual(seenBySibling, undefined, '兄弟插件必须能 ctx.get 到 search-service')
    assert.equal(seenBySibling, svc, '兄弟插件拿到的应是同一个服务实例')

    // 卸载后对所有人注销
    await siblingFork.dispose()
    await fork.dispose()
    assert.equal(root.get('search-service'), undefined, '卸载后服务应注销')
    assert.equal(routes.has('GET /api/search'), false, '卸载后路由应摘除')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('纯函数：转义与短语构造', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  assert.equal(escapeLike('100%_\\'), '100\\%\\_\\\\')
  assert.equal(toFtsPhrase('a OR b'), '"a OR b"')
  assert.equal(toFtsPhrase('引号"x'), '"引号""x"')
  // 命中词在文本中不存在时返回 null（调用方据此退回标题）
  assert.equal(buildSnippet('无关内容', '缺席词', 10), null)
  assert.equal(buildSnippet('', 'x', 10), null)
})
