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
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { Context as CordisContext } from 'cordis'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import type { HttpRouterService, Principal, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import {
  MAX_QUERY_LENGTH,
  MIN_TRIGRAM_LENGTH,
  SEARCH_MIGRATIONS_DIR,
  SearchPlugin,
  buildSnippet,
  buildTermQuery,
  modesConverge,
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
  /** 调用 `GET /api/search` 时挂在 `h.principal` 上的主体（默认匿名） */
  principal: Principal
  /**
   * 覆写策略层返回的可见集合（P2）。
   * `null` = 回到默认行为「库里所有页面都可见」—— 既有用例因此语义不变。
   */
  setVisible(slugs: readonly string[] | null): void
  /** ★ P3a：切换请求主体（匿名的读者等级 0 / 组织成员的 1） */
  setPrincipal(who: 'anonymous' | 'member'): void
  /** ★ P3a：设置某一页全部块的档位（`null` = granted 档，只有显式授权才可见） */
  setBlockTier(slug: string, tier: 0 | 1 | null, visibility: 'public' | 'org' | 'granted'): void
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
  /*
   * ★ P2：策略层替身。
   *
   * 默认返回「库里所有页面」（`setVisible(null)`）—— 这样既有用例的行为与 P2 之前
   * 完全一致（它们本来就不涉及可见性），不会因为引入策略层而整批改语义。
   * 需要验证裁剪的用例调用 `setVisible([...])` 覆写成指定集合。
   *
   * 用真实 SQL 读 pages 而不是硬编码列表：让"可见集合"与库内容保持一致，
   * 避免夹具自己成为第二个真源。
   */
  let visibleOverride: readonly string[] | null = null
  const policyService = {
    visibleSlugs: (_principal: Principal, _q?: { levels?: readonly string[] }): Promise<string[]> => {
      if (visibleOverride !== null) return Promise.resolve([...visibleOverride])
      return Promise.resolve(
        db.query<{ slug: string }>('SELECT slug FROM pages ORDER BY slug').map((r) => r.slug),
      )
    },
    /*
     * ★ P3a：检索现在**不再**走 `visibleSlugs` 下推，而走 `blocks.tier` 的等级分支 +
     * 这个授权分支。夹具必须提供它，否则第一次检索就抛
     * "policy(...).grantedBlockIds is not a function"。默认空集合 = 没有任何块级授权，
     * 与 P3a 阶段的真实实现一致（`block_grants` 表属 P3b）。
     */
    grantedBlockIds: (_principal: Principal): Promise<readonly number[]> => Promise.resolve([]),
  }
  const services = new Map<string, unknown>([
    ['db', db],
    ['http', routerService],
    ['policy-service', policyService],
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

  /*
   * ★ P2：请求主体。默认匿名。
   *
   * ★ P3a：检索的可见性判定**不再依赖策略层的可见集合**，而是由 `blocks.tier`
   * （等级分支）与 `grantedBlockIds`（授权分支）在 SQL 里决定 ⇒ **主体本身参与了判定**
   * （匿名 → 读者等级 0；有 `orgRole` 的组织成员 → 1）。故它必须可变，用例才能
   * 用同一个库演示"同一条命中，匿名搜不到、成员搜得到"。
   */
  let principal: Principal = {
    kind: 'anonymous',
    userId: null,
    orgId: null,
    orgRole: null,
    groupIds: [],
    sessionId: null,
  }

  /** 切换主体：`'anonymous'` 或 `'member'`（有组织角色 = 读者等级 1） */
  const setPrincipal = (who: 'anonymous' | 'member'): void => {
    principal =
      who === 'anonymous'
        ? { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }
        : { kind: 'user', userId: 1, orgId: 1, orgRole: 'member', groupIds: [], sessionId: 's1' }
  }

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
        principal,
        json: (status, payload) => resolve({ status, body: payload as Record<string, unknown> }),
      }
      void Promise.resolve(handler(h)).catch(reject)
    })
  }

  /**
   * ★ P3a：写 `pages` 的同时维护 `blocks` 与 `blocks_fts`。
   *
   * **为什么夹具必须自己做这件事**：检索现在只读 `blocks` —— `pages.content` 已从
   * 检索路径彻底移除（它含未裁剪全文，是 §5.6 点名的泄漏源）。夹具若仍只写 `pages`，
   * 任何一条用例都搜不到东西。
   *
   * **为什么用"整页一个块"的最小实现、而不复刻 plugin-wiki 的 `parseBlocks`**：
   * 本包测的是**检索**（匹配、高亮、可见性过滤、分页），不是解析。在夹具里复刻解析器
   * 会让两处实现漂移，并把 wiki 的解析规则变成检索测试的隐式依赖。解析与块身份的正确性
   * 由 `plugin-wiki` 自己的单测 + P3a 端到端脚本覆盖。
   */
  const writeBlocks = (pageId: number, content: string): void => {
    // 顺序不可换：清索引的子查询依赖 blocks 行还在 —— 先删块会让子查询恒空，
    // 旧文本会静默留在 contentless 索引里成为孤儿（这条坑由 P3a 的单测抓出过）
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

  /**
   * ★ P3a：把某一页的**全部块**设成指定档位 —— 用来演示"同一条命中，不同读者等级
   * 搜到的结果不同"。
   *
   * `tier` 的语义（§4.3）：`0` = 匿名可见、`1` = 仅组织成员、`null` = 只有被显式授权的
   * 块能看（`granted` 档，P3a 阶段没有授权表 ⇒ 谁都搜不到）。
   */
  const setBlockTier = (slug: string, tier: 0 | 1 | null, visibility: 'public' | 'org' | 'granted'): void => {
    db.run(
      'UPDATE blocks SET tier = ?, visibility = ? WHERE page_id = (SELECT id FROM pages WHERE slug = ?)',
      [tier, visibility, slug],
    )
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
    /** 用 getter 而不是快照：`setPrincipal()` 之后 `h.principal` 必须立刻反映新主体 */
    get principal(): Principal {
      return principal
    },
    setPrincipal,
    setBlockTier,
    setVisible: (slugs) => {
      visibleOverride = slugs === null ? null : [...slugs]
    },
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

test('存量页面不进块索引：本插件只建表，块的回填归 plugin-wiki（不解析 Markdown）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-search-upgrade-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  const count = (table: string): number =>
    Number(db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0)
  try {
    db.open() // 只跑 db-sqlite 的迁移
    db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      'legacy',
      '存量标题',
      '这篇是安装检索插件之前就存在的页面，含存量独特词西格玛。',
      '2023-01-01T00:00:00.000Z',
      '2023-01-01T00:00:00.000Z',
    ])

    db.migrate(SEARCH_MIGRATIONS_DIR)

    /*
     * ★ P3a 的语义变化（这一条是**刻意的显式化**，不是"测试被放宽"）：
     *
     * 检索只读 `blocks`（`pages.content` 已从检索路径整体移除）。而 `blocks` 是
     * **解析 Markdown 的产物**，解析器 `parseBlocks` 归 `@geewiki/wiki` ——
     * 本插件既不拥有它，也不该在迁移里凭空造块。
     *
     * 于是：**存量页面的块回填由 `@geewiki/wiki` 在激活时完成**（与它的"反向链接
     * 回填"同款做法）。本用例把这条契约钉在这里 —— 断言"表建好了、但仍是空的"，
     * 免得将来有人把"存量搜不到"当成索引 bug 去修。
     */
    assert.equal(count('blocks'), 0, '本插件不解析 Markdown ⇒ 不会凭空造块')
    assert.equal(count('blocks_fts'), 0, '块索引随块一起为空')

    // 迁移可重放（幂等）：再跑一次不应抛错
    assert.doesNotThrow(() => db.migrate(SEARCH_MIGRATIONS_DIR))
    assert.equal(count('blocks'), 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LIKE 兜底不依赖块索引：索引缺失时短查询仍给出正确结果（且长查询显式报错）', async () => {
  // 兜底路径扫 `blocks`（普通表），故索引漂移/缺失不会让短查询静默漏行。
  const h = makeHarness()
  try {
    h.putPage('p1', '标题甲', '正文含两字词检索，用于验证兜底路径的独立性。')

    // 走一遍正常路径，确认基线
    assert.equal((await searchAs(h, 'q=检索', 'like')).total, 1)

    // 制造"索引缺失"：把块索引表整个删掉（模拟迁移未跑全 / 索引被误删）
    h.db.run('DROP TABLE blocks_fts')

    // 短查询（LIKE 路）仍应正确返回 —— 它读的是 `blocks`，不碰索引
    const fallback = await searchAs(h, 'q=兜底', 'like')
    assert.equal(fallback.total, 1, '索引缺失时短查询仍须命中（LIKE 扫 blocks 表）')
    assert.deepEqual(fallback.hits.map((x) => x.slug), ['p1'])
    // 长查询无法回避索引：应显式抛错（宁可响，不可静默返回空结果）
    await assert.rejects(
      () => h.search('q=验证兜底'),
      (err: unknown) => /no such table: blocks_fts/.test((err as Error).message),
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

test('snippet：截断补省略号；★ P3a 标题不再参与 FTS 匹配（只索引块文本）', async () => {
  const h = makeHarness()
  try {
    /*
     * ★ P3a 的行为变化（**显式化，不是放宽**）：`blocks_fts` 只索引**块文本**，
     * `p.title` 不在其中 ⇒ "只命中标题"在 FTS 路上不再成立。这是设计文档 §4.3 的
     * SQL 形态的直接后果（它 MATCH 的是 `blocks_fts`，只 SELECT `p.title`）。
     *
     * 把这条断言留在测试里是为了**让回归可见**：将来若把标题重新纳入索引
     * （例如写入端额外造一个 heading 块），这里会立刻变红，而不是悄无声息地改行为。
     *
     * 短查询的 LIKE 路**仍然匹配标题**（`p.title LIKE ?`），故"按标题搜"并未整体失效。
     */
    h.putPage('p1', '标题含独特词艾普西龙', '正文里完全没有那个词。')
    assert.equal(
      (await searchAs(h, 'q=独特词艾普西龙', 'fts')).total,
      0,
      '块索引不含标题 ⇒ FTS 路搜不到"只出现在标题里"的词',
    )
    // 反向：LIKE 路仍能按标题命中，且片段退回标题
    const likeBody = await searchAs(h, 'q=艾普', 'like')
    assert.equal(likeBody.total, 1, '短查询的 LIKE 路仍按标题匹配')
    assert.ok(
      (likeBody.hits[0]?.snippet ?? '').includes('<mark>艾普</mark>'),
      `应退回标题片段: ${likeBody.hits[0]?.snippet}`,
    )

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
    assert.equal((await svc.search(h.principal, '插件化')).total, 0, '空库检索应为 0 命中而非抛错')
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
    const ftsSvc = await svc.search(h.principal, '共同词奥米克戎', { limit: 2 })
    assert.equal(ftsRes.body['mode'], ftsSvc.mode)
    assert.equal(ftsRes.body['total'], ftsSvc.total)
    assert.deepEqual(ftsRes.body['hits'], [...ftsSvc.hits], 'FTS 路：端点与服务的 hits 必须逐字段一致')

    // LIKE 路（<3 字符）
    const likeRes = await h.search('q=共同&limit=1')
    const likeSvc = await svc.search(h.principal, '共同', { limit: 1 })
    assert.equal(likeRes.body['mode'], 'like')
    assert.equal(likeRes.body['mode'], likeSvc.mode)
    assert.equal(likeRes.body['total'], likeSvc.total)
    assert.deepEqual(likeRes.body['hits'], [...likeSvc.hits], 'LIKE 路：端点与服务的 hits 必须逐字段一致')

    // 默认 limit 也必须一致（端点不传 limit ↔ 服务不传 opts）
    const defRes = await h.search('q=共同词奥米克戎')
    const defSvc = await svc.search(h.principal, '共同词奥米克戎')
    assert.deepEqual(defRes.body['hits'], [...defSvc.hits])
    assert.equal(defSvc.hits.length, 4, '默认 limit 20 应返回全部 4 条')

    // 空查询：服务层返回空结果（端点层另用 400 invalid_query 表达 HTTP 语义）
    assert.deepEqual(await svc.search(h.principal, '   '), {
      mode: 'like',
      total: 0,
      modesConverge: true,
      hits: [],
    })
    // 非法 limit：服务层抛错（与端点的 400 对应）。
    // ★ P2：`search` 改为异步后，同步抛错变成**拒绝的 Promise**，故必须用 `assert.rejects`
    // 而不是 `assert.throws` —— 用错会让这条断言恒真（`assert.throws` 对返回 Promise 的
    // 函数不会捕获其中的异步抛出，于是"没抛"也通过），等于悄悄丢掉这个保护。
    await assert.rejects(() => svc.search(h.principal, '共同', { limit: 0 }), RangeError)
    await assert.rejects(() => svc.search(h.principal, '共同', { limit: 101 }), RangeError)
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

    assert.equal((await svc.contents(h.principal, [])).size, 0, '空数组直接返回空 Map')

    const single = await svc.contents(h.principal, ['a'])
    assert.equal(single.size, 1)
    // ★ P3a：value 由"整页正文串"改为 `ContentView`（可见块投影）
    assert.equal(single.get('a')?.text, '甲的完整正文，含独特词阿尔法。', 'text 必须是可见块拼接后的文本')
    assert.deepEqual(
      single.get('a')?.blocks.map((b) => b.ordinal),
      [0],
      'blocks 给出可见块的 ordinal（供 sources 帧做块级引用定位）',
    )
    assert.equal(single.get('a')?.gatedCount, 0, '没有受限块时 gatedCount 为 0')

    const both = await svc.contents(h.principal, ['a', 'b'])
    assert.equal(both.size, 2)
    assert.equal(both.get('b')?.text, '乙的完整正文，含独特词贝塔。')

    // 查不到的 slug 不进 Map（消费方据此区分"页面不存在"与"正文为空串"）
    const mixed = await svc.contents(h.principal, ['a', '不存在的slug', 'b'])
    assert.equal(mixed.size, 2)
    assert.equal(mixed.has('不存在的slug'), false)
    assert.deepEqual([...mixed.keys()].sort(), ['a', 'b'])

    // 一次 IN 查询能跨越多个 slug（多于 1 个占位符时的正确性）
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => s)
    for (const s of ['c', 'd', 'e', 'f']) h.putPage(s, s, `正文-${s}`)
    assert.equal((await svc.contents(h.principal, many)).size, 6)

    // 顺序无关
    assert.deepEqual([...(await svc.contents(h.principal, ['b', 'a'])).keys()].sort(), ['a', 'b'])

    /*
     * ★ P3a：**看不见的块取不到**。
     * 这一条是 P2 引入、P3a 换机制的核心不变式：`contents` 是 RAG 的正文入口，
     * 原先它对任意 slug 都原样返回正文（"给什么吐什么"的裸接口）；P2 靠"先取可见集合
     * 求交集"挡住，P3a 改为**在 SQL 里按 `blocks.tier` 过滤**（页面级与块级一起）。
     * 注意断言的是"正文取不到"，不是"报错"——不可见与不存在在**这一层**同构，
     * 存在性差异由 HTTP 层统一翻成 404（见 wiki 的读端点）。
     */
    h.setBlockTier('b', 1, 'org')
    const gated = await svc.contents(h.principal, ['a', 'b'])
    assert.equal(gated.size, 1, '只有可见块所在的 slug 才应取到正文（此处主体是匿名）')
    assert.equal(gated.has('b'), false, '受限块所在的 slug 绝不能出现在结果里')

    // 反向：同一个库、换成组织成员 ⇒ 立刻取得到（证明挡住它的是**读者等级**而非别的）
    h.setPrincipal('member')
    const asMember = await svc.contents(h.principal, ['a', 'b'])
    assert.equal(asMember.size, 2, '组织成员应能取到 org 档块的正文')
    h.setPrincipal('anonymous')
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
      // 敌意输入不得抛错（抛错说明 slug 进了 SQL 语法位置），也不得返回任何行
      const result = await svc.contents(h.principal, [slug])
      assert.equal(result.size, 0, `slug=${JSON.stringify(slug)} 必须按字面匹配（注入成功会返回全表）`)
    }

    // 混合敌意输入与真实 slug：只应返回真实那个，且表完好
    const mixed = await svc.contents(h.principal, ["' OR 1=1 --", 'p1'])
    assert.equal(mixed.size, 1)
    assert.deepEqual([...mixed.keys()], ['p1'])

    // 反证表还在（DROP 类注入若得逞，这里会抛 no such table）
    assert.equal(Number(h.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM pages')[0]?.n ?? 0), 1)
  } finally {
    h.dispose()
  }
})

test('★ P3a 权限：org 档的块匿名搜不到、组织成员搜得到 —— FTS 路与短查询 LIKE 路分别验证', async () => {
  const h = makeHarness()
  try {
    h.putPage('公开页', '公开标题', '正文含公开词阿尔法。')
    h.putPage('受限页', '受限标题', '正文含机密词奥米克戎。')
    // 受限页的块标成 org 档（tier=1）：组织成员够得着，匿名够不着
    h.setBlockTier('受限页', 1, 'org')

    // 前置：**成员身份下能搜到** —— 证明下面的 0 是等级过滤造成的，不是本来就搜不到
    h.setPrincipal('member')
    assert.equal((await h.search('q=机密词奥米克戎')).body['total'], 1, '前置：成员应有 1 条命中')

    h.setPrincipal('anonymous')

    // ① FTS 路（查询串 ≥3 字符 → blocks_fts MATCH）
    const fts = await h.search('q=机密词奥米克戎')
    assert.equal(fts.status, 200)
    assert.equal(fts.body['total'], 0, 'FTS 路：tier=1 的块对匿名必须 0 命中')
    assert.deepEqual(fts.body['hits'], [], 'FTS 路：受限块不得出现在 hits 里')

    // ② 短查询 LIKE 路 —— **独立的另一条 SQL**，最容易被漏改（2 字元中文低于 trigram 门槛）
    const like = await h.search('q=机密')
    assert.equal(like.body['mode'], 'like', '前置：2 字元查询应走 LIKE 路（否则本用例没测到想测的东西）')
    assert.equal(like.body['total'], 0, 'LIKE 路：同样必须 0 命中（括号没加会让可见性只作用于一半条件）')
    assert.deepEqual(like.body['hits'], [], 'LIKE 路：受限块不得出现在 hits 里')

    // ③ 反向：公开块（tier=0）照常命中 —— 证明过滤没有把整条路一起堵死
    assert.equal((await h.search('q=公开词阿尔法')).body['total'], 1, 'FTS 路：公开块必须照常命中')
    assert.equal((await h.search('q=公开')).body['total'], 1, 'LIKE 路：公开块必须照常命中')
  } finally {
    h.dispose()
  }
})

test('★ P3a 权限：granted 档（tier 为 NULL）谁都搜不到，且 mode 仍如实上报', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题', '正文含独特词伽马。')
    // granted 档：tier 写 NULL ⇒ 等级分支的 `NULL <= ?` 恒不成立 ⇒ 永不命中。
    // 它只能靠**授权分支**放行，而块级授权表属 P3b ⇒ P3a 阶段谁都搜不到。
    // 方向是刻意的失败关闭：写错的后果是"搜不到"，不是"泄漏"。
    h.setBlockTier('p1', null, 'granted')

    const fts = await h.search('q=独特词伽马')
    assert.equal(fts.status, 200)
    assert.equal(fts.body['total'], 0, 'granted 档在 P3a 没有授权来源 ⇒ 必须 0 命中')
    assert.deepEqual(fts.body['hits'], [])
    // mode 按"本来会走哪条路"上报，不据结果反推"这个人有没有可见内容"
    assert.equal(fts.body['mode'], 'fts')

    const like = await h.search('q=独特')
    assert.equal(like.body['total'], 0)
    assert.equal(like.body['mode'], 'like')

    // 反向：改回 public 后**立刻**能搜到 —— 证明上面的 0 是档位造成的，不是索引坏了
    h.setBlockTier('p1', 0, 'public')
    assert.equal((await h.search('q=独特词伽马')).body['total'], 1, '改档后必须立刻可检索')
  } finally {
    h.dispose()
  }
})

test('search-service：卸载后服务注销、路由摘除（不留"仍可调用但已失效"的语义）', async () => {
  const h = makeHarness()
  try {
    const svc = serviceOf(h)
    h.putPage('p1', '标题', '正文含独特词伽马。')
    assert.equal((await svc.search(h.principal, '独特词伽马')).total, 1, '前置：卸载前服务可用')

    h.unload()

    assert.equal(h.ctx.get('search-service'), undefined, '卸载后 ctx.get 必须回到 undefined（消费者会改走缺失分支）')
    // 路由同步摘除：search() 在路由不存在时同步抛断言失败
    assert.throws(() => h.search('q=插件化'), /应已注册路由/)
    // 注销不抛错且幂等
    assert.doesNotThrow(() => h.unload())

    // **已持有 svc 引用**的消费方再调用：必须显式报错，而不是静默返回空结果
    // （静默空结果会被误读成"库里没有匹配内容"，是本批要消灭的那类难定位症状）
    await assert.rejects(
      () => svc.search(h.principal, '独特词伽马'),
      /已卸载/,
      '卸载后 svc.search 必须显式报错',
    )
    await assert.rejects(
      () => svc.contents(h.principal, ['p1']),
      /已卸载/,
      '卸载后 svc.contents 必须显式报错',
    )
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

/* ================= 词元检索（mode:'terms'）——RAG 问句的检索路 ================= */

/*
 * 背景（本组用例钉住的缺陷）：`toFtsPhrase` 把**整个查询串**包成一个 FTS5 短语，
 * 于是自然语言问句（「检索增强怎么做」）要求正文里**连续出现该整串**才命中——
 * 而问句几乎不可能逐字出现在正文里，于是 /api/ai/ask 的检索地基恒为 0 命中。
 * 防注入（整体当字面短语）是对的，错的是"把整句当一个短语"。
 * 修法：新增 mode:'terms'，把查询切成可检索词元后各自加引号（仍字面、仍防注入）以 OR 连接。
 */

test('词元检索：问句能召回（短语路 0 命中，词元路 ≥1）——核心回归', async () => {
  const h = makeHarness()
  try {
    // 正文照抄真实语料形态：问句的每个词元都在正文里，但整句**不**连续出现
    h.putPage('kb-1', '检索设计', '本系统的检索增强问答先从知识库检索相关资料，再做抽取式摘要。')
    const q = '检索增强怎么做'

    // 对照：短语语义下 0 命中——这正是缺陷现场
    const phrase = await searchAs(h, `q=${encodeURIComponent(q)}`, 'fts')
    assert.equal(phrase.total, 0, '整句作为一个短语时必然 0 命中（本用例的前置事实）')

    // 修好后：词元语义下必须召回
    const terms = await searchAs(h, `q=${encodeURIComponent(q)}&mode=terms`, 'fts')
    assert.ok(terms.total >= 1, `词元检索应召回该页，实际 total=${terms.total}`)
    assert.deepEqual(slugs(terms), ['kb-1'])
    assert.equal((terms.hits[0]?.score ?? 0) > 0, true, 'FTS 路的 score 应 > 0（BM25 取负）')
  } finally {
    h.dispose()
  }
})

test('词元检索：total 是 distinct 行数（一行命中多个词元不重复计数）', async () => {
  const h = makeHarness()
  try {
    // p1 同时命中「检索增」「索增强」「知识库」等词元；p2 只命中「知识库」
    h.putPage('p1', '甲', '检索增强知识库')
    h.putPage('p2', '乙', '知识库')
    const body = await searchAs(h, `q=${encodeURIComponent('检索增强知识库')}&mode=terms`, 'fts')
    assert.equal(body.total, 2, `应为 distinct 行数 2（若按词元命中次数累加会得到 >2），实际 ${body.total}`)
    assert.equal(body.hits.length, 2)
    // 命中词元更多的行 BM25 更相关 → 排在前（OR + ORDER BY rank 的天然效果）
    assert.deepEqual(slugs(body), ['p1', 'p2'], '多词元命中者应排在前面')
  } finally {
    h.dispose()
  }
})

test('词元检索：词元全空时回退 LIKE（短查询/纯标点不构造空 MATCH）', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '检索设计', '全文检索是知识库的地基。')
    // 2 字中文：切不出 3-gram → 词元为空 → 必须回退 LIKE（与 <3 字符的短语路径一致）
    const short = await searchAs(h, `q=${encodeURIComponent('检索')}&mode=terms`, 'like')
    assert.equal(short.total, 1)
    assert.deepEqual(slugs(short), ['kb-1'])
    // 纯标点：同样回退且不抛（若构造出 `MATCH ''` 会抛 fts5: syntax error）
    const punct = await searchAs(h, `q=${encodeURIComponent('。。')}&mode=terms`, 'like')
    assert.equal(punct.total, 0)
  } finally {
    h.dispose()
  }
})

test('词元检索：注入安全——敌意输入仍按字面词元处理，不改变语义', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '标题', '正文里字面含有 a OR b 这个串，也含有星号*与引号"。')
    const hostile = [
      '"',
      '*',
      '***',
      'a OR b',
      'a AND b',
      'NOT x',
      'NEAR(',
      'NEAR(a b, 2)',
      '^x',
      'x:y',
      '{a}',
      '(a)',
      '中文"引号',
      '\\',
      'a-b_c',
      'OR',
      '知识库" OR "x',
      '检索"*)',
    ]
    for (const q of hostile) {
      const res = await h.search(`q=${encodeURIComponent(q)}&mode=terms`)
      assert.equal(res.status, 200, `q=${JSON.stringify(q)} 不应报错: ${JSON.stringify(res.body)}`)
      assert.equal(res.body['ok'], true)
    }

    // 语义：`a OR b` 的 ASCII 词元都短于 3 字符被剔除 → 词元为空 → 回退 LIKE → 字面匹配
    const literal = await searchAs(h, `q=${encodeURIComponent('a OR b')}&mode=terms`, 'like')
    assert.equal(literal.total, 1, 'ASCII 短词元被剔除后走 LIKE，仍是字面匹配')
    assert.deepEqual(slugs(literal), ['p1'])

    // 长 ASCII 词元：OR 必须是连接符，不得被当布尔语法（否则"缺席词贝塔"会去匹配别的行）
    h.putPage('p2', '标题2', '正文含有唯一词阿尔法。')
    const longAscii = await searchAs(h, `q=${encodeURIComponent('唯一词阿尔法 OR 缺席词贝塔')}&mode=terms`, 'fts')
    assert.deepEqual(slugs(longAscii), ['p2'], 'OR 只作连接符；缺席词元不应命中任何行')
  } finally {
    h.dispose()
  }
})

test('词元检索：与短语路语义确实不同（同一查询两条路可同时成立）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '甲', '检索增强问答先从知识库检索相关资料。')
    // 既含整串（短语命中）又含各词元（词元命中）
    const phrase = await searchAs(h, `q=${encodeURIComponent('检索增强问答')}`, 'fts')
    const terms = await searchAs(h, `q=${encodeURIComponent('检索增强问答')}&mode=terms`, 'fts')
    assert.equal(phrase.total, 1, '整串连续出现 → 短语路命中')
    assert.ok(terms.total >= 1, '词元路同样命中')
    assert.deepEqual(slugs(phrase), slugs(terms))
  } finally {
    h.dispose()
  }
})

test('词元检索：REST 端点的 mode 参数校验与默认值', async () => {
  const h = makeHarness()
  try {
    h.putPage('kb-1', '甲', '检索增强问答先从知识库检索相关资料。')
    // 默认（不传 mode）= phrase：整句不连续出现 → 0
    const dflt = await searchAs(h, `q=${encodeURIComponent('检索增强怎么做')}`, 'fts')
    assert.equal(dflt.total, 0, '不传 mode 时保持既有短语语义（向后兼容）')
    // 显式 mode=phrase 与默认一致
    const explicit = await searchAs(h, `q=${encodeURIComponent('检索增强怎么做')}&mode=phrase`, 'fts')
    assert.equal(explicit.total, 0)
    // 非法 mode → 400（不静默降级成某个模式）
    const bad = await h.search(`q=${encodeURIComponent('检索增强')}&mode=nope`)
    assert.equal(bad.status, 400, `非法 mode 应 400，实际 ${bad.status}`)
    assert.equal(bad.body['error'], 'invalid_mode')
  } finally {
    h.dispose()
  }
})

test('纯函数：buildTermQuery（CJK 3-gram / ASCII 切词 / 去重 / 空输入）', () => {
  // CJK：长度 ≥3 的滑窗 3-gram，保持出现顺序
  assert.deepEqual(buildTermQuery('检索增强怎么做'), ['检索增', '索增强', '增强怎', '强怎么', '怎么做'])
  // 恰好 3 字 → 单个词元
  assert.deepEqual(buildTermQuery('知识库'), ['知识库'])
  // 2 字中文切不出 3-gram → 空（交由调用方回退 LIKE）
  assert.deepEqual(buildTermQuery('检索'), [])
  // ASCII：按空白与常见标点切词，只保留长度 ≥3
  assert.deepEqual(buildTermQuery('full text search'), ['full', 'text', 'search'])
  assert.deepEqual(buildTermQuery('a, ab, abc, abcd'), ['abc', 'abcd'])
  // 数字按字面保留（≥3 字符才可能在 trigram 下命中；2 位数字如 "42" 在 MATCH 下恒为空）
  assert.deepEqual(buildTermQuery('2024 报表'), ['2024'], '2 字 CJK 片段切不出 3-gram')
  assert.deepEqual(buildTermQuery('2024 报表系统'), ['2024', '报表系', '表系统'])
  // 去重：重复词元只留一次
  assert.deepEqual(buildTermQuery('知识库 知识库'), ['知识库'])
  // 中英混排：各自切分且顺序不乱
  assert.deepEqual(buildTermQuery('知识库 FTS5 index'), ['知识库', 'FTS5', 'index'])
  // 空/纯标点/纯空白 → 空数组
  assert.deepEqual(buildTermQuery(''), [])
  assert.deepEqual(buildTermQuery('。。！？'), [])
  assert.deepEqual(buildTermQuery('   '), [])
  assert.deepEqual(buildTermQuery('a b c'), [], '全部短于 3 字符 → 空')
  // 边界：MIN_TRIGRAM_LENGTH 是切分依据（<3 的词元在 MATCH 下恒为空）
  assert.equal(MIN_TRIGRAM_LENGTH, 3)
  // 每个词元都能被 toFtsPhrase 安全转义（含引号）
  for (const t of buildTermQuery('知识库"OR"x')) {
    assert.match(toFtsPhrase(t), /^".*"$/, `词元应被包成字面短语: ${t}`)
  }
})

/* ============ 两种查询语义是否同路（界面「改用分词匹配」按钮的死路防线） ============ */

/*
  这组钉住的是一个**界面缺陷的服务端判据**：短查询下 phrase 与 terms 会落到同一条
  检索路径（都回退 LIKE，或 MATCH 表达式字面一致），此时界面那个「改用分词匹配」按钮
  点了等于重新问一遍同一个问题，却拿回一模一样的 0 命中且不作解释。

  判据必须与真实检索路径共用原语（buildTermQuery / MIN_TRIGRAM_LENGTH），故这里
  同时断言"同路"与"分叉"两侧——只测一侧的话，把函数写成 `return true` 也能过。
*/
test('纯函数：modesConverge（短查询/单表达式同路 → true）', () => {
  // <3 字符：useFts 在两个分支下同为 false ⇒ 两条路都是同一段 LIKE SQL
  assert.equal(modesConverge('检索'), true, '2 字中文：两种模式都回退 LIKE')
  assert.equal(modesConverge('架'), true, '1 字')
  assert.equal(modesConverge('ab'), true, '2 字符 ASCII')
  // 恰好 3 字且无空白：buildTermQuery 只切出原串本身 ⇒ MATCH 表达式字面一致
  assert.equal(modesConverge('知识库'), true, '3 字：terms=[原串]，与 phrase 同表达式')
  assert.equal(modesConverge('2024'), true, '4 字符 ASCII 单词：单 token')
  assert.equal(modesConverge('markdown'), true, '单个英文词：terms=[原串]')
  // 切不出词元 ⇒ terms 也回退 LIKE（纯标点）
  assert.equal(modesConverge('。。。'), true, '纯标点切不出词元')
})

test('纯函数：modesConverge（多词元/含空白 → false，换过去真的不同）', () => {
  // ≥4 字中文：滑窗切出多个 3-gram ⇒ OR 表达式 ≠ 整串短语
  assert.equal(modesConverge('版本管理权'), false, '5 字：多个 3-gram')
  assert.equal(modesConverge('段落级阅读权限'), false)
  // 含空白：splitCjkRuns 切成多段/多词
  assert.equal(modesConverge('OIDC 配置'), false, '含空白 ⇒ 多词元')
  assert.equal(modesConverge('版本 管理权'), false)
  // 长英文多词
  assert.equal(modesConverge('full text search'), false)
})

test('modesConverge 与 buildTermQuery 同源：判据不是另写一份切词规则', () => {
  // 这正是"同路"的定义：恰好一个词元且等于原串（或切不出词元）
  for (const q of ['知识库', 'markdown', '2024', '检索', '版本管理权', 'full text search', 'OIDC 配置']) {
    const terms = buildTermQuery(q)
    const sameExpr = terms.length === 0 || (terms.length === 1 && terms[0] === q)
    const shortLike = q.length < MIN_TRIGRAM_LENGTH
    assert.equal(
      modesConverge(q),
      shortLike || sameExpr,
      `判据必须等于 useFts 的实际分叉条件：${q}（terms=${JSON.stringify(terms)}）`,
    )
  }
})

test('modesConverge：端点把该字段回传给界面（界面不得自己推导）', async () => {
  const h = makeHarness()
  try {
    h.putPage('p1', '知识库', '知识库的正文内容足够长以便命中检索')
    // 短查询：同路 → true
    const short = await h.search('q=知识库')
    assert.equal(short.body['modesConverge'], true, '3 字查询：按钮是死路')
    // 长查询：分叉 → false
    const long = await h.search('q=知识库的正文内容')
    assert.equal(long.body['modesConverge'], false, '长查询：换分词真的会不同')
    // 服务层与端点必须一致（单一实现）
    const svc = h.ctx.get('search-service') as SearchService
    assert.equal((await svc.search(h.principal, '知识库')).modesConverge, true)
  } finally {
    h.dispose()
  }
})

/* ================= 非汉字 CJK 与查询护栏（外部审查报出的两处） ================= */

test('buildTermQuery：假名/谚文必须按 3-gram 切分（它们不属于 Han，曾被整串当一个词元）', () => {
  // 缺陷现场：假名与谚文都是 \p{L}，落在"非 CJK 分支"时会被 \p{L}+ 当成**一个整词**，
  // 于是整句成一个 15 字词元 → 短语匹配 → 恒 0 命中（等于把已修的中文缺陷搬到日文）。
  const kana = buildTermQuery('けんさくかくちょうせいせいとは何か')
  assert.ok(kana.length > 1, `假名长句必须切出多个词元，实际 ${JSON.stringify(kana)}`)
  assert.ok(
    kana.every((t) => [...t].length === MIN_TRIGRAM_LENGTH),
    `假名词元应都是 3 字：${JSON.stringify(kana)}`,
  )
  assert.equal(kana[0], 'けんさ', '首个词元应是前 3 字')
  // 谚文（韩文音节）
  const hangul = buildTermQuery('한국어검색시스템')
  assert.ok(hangul.length > 1, `谚文长句必须切出多个词元，实际 ${JSON.stringify(hangul)}`)
  assert.equal(hangul[0], '한국어')
  // 片假名
  const katakana = buildTermQuery('カタカナテスト')
  assert.equal(katakana[0], 'カタカ')
})

test('buildTermQuery：BMP 外的 CJK 扩展字按码点切分（不得把代理对拆成半个字符）', () => {
  // 𠀀 等扩展 B 区字是代理对：若用 seg[i] 按下标取，切出的 3-gram 永远不可能命中索引
  const terms = buildTermQuery('𠀀𠀁𠀂𠀃')
  assert.equal(terms.length, 2, `4 个字应切出 2 个 3-gram，实际 ${JSON.stringify(terms)}`)
  assert.deepEqual(terms, ['𠀀𠀁𠀂', '𠀁𠀂𠀃'])
  assert.ok(terms.every((t) => [...t].length === MIN_TRIGRAM_LENGTH), '每个词元应是 3 个码点')
})

test('端到端：日文长问句能召回（缺陷回归）', async () => {
  const h = makeHarness()
  try {
    h.putPage('ja1', '検索の設計', 'けんさくかくちょうせいせい とは、まず資料を探すことです。')
    h.putPage('ja2', '無関係', '全く別の内容。')
    // 短语语义（搜索框）对整句问句恒 0 命中——这正是原缺陷
    const phrase = await searchAs(h, `q=${encodeURIComponent('けんさくかくちょうせいせいとは何か')}`, 'fts')
    assert.equal(phrase.total, 0, '前置：整句按短语匹配命中 0（缺陷现场）')
    // terms 语义（问句）应能召回
    const terms = await searchAs(
      h,
      `q=${encodeURIComponent('けんさくかくちょうせいせいとは何か')}&mode=terms`,
      'fts',
    )
    assert.equal(terms.total, 1, '词元检索必须召回该页')
    assert.deepEqual(slugs(terms), ['ja1'])
  } finally {
    h.dispose()
  }
})

test('buildTermQuery：去重改为 Set（长查询不退化，且结果与去重语义一致）', () => {
  // 行为不变式：重复片段只出现一次、顺序稳定
  assert.deepEqual(buildTermQuery('检索检索检索'), ['检索检', '索检索'])
  // 长输入：词元数应线性增长而非爆炸（O(n²) 的 includes 在 1800 字时已可观测）
  const long = '检索增强生成'.repeat(150) // 900 字
  const started = process.hrtime.bigint()
  const terms = buildTermQuery(long)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  // 「检索增强生成」的 6 个字只有 6 种跨复读边界的 3-gram（4 个内部 + 2 个跨重复处）：
  // 检索增 / 索增强 / 增强生 / 强生成 / 成检索 / 生成检 —— 重复片段全部被去重。
  assert.equal(terms.length, 6, `期望 6 种去重后的 3-gram，实际 ${terms.length}`)
  assert.ok(ms < 200, `900 字查询切词耗时应远小于 200ms，实际 ${ms.toFixed(1)}ms`)
})

test('search-service：超长查询抛错而不是静默截断（消费方不受 REST 请求行上限保护）', async () => {
  const h = makeHarness()
  try {
    const svc = h.ctx.get('search-service') as SearchService
    const long = '检'.repeat(MAX_QUERY_LENGTH + 1)
    // ★ P2：`search` 改为异步 ⇒ 必须用 `assert.rejects`。用 `assert.throws` 会是**恒真**断言
    // （它对返回 Promise 的函数捕获不到其中的异步抛出），等于把这条保护悄悄丢掉。
    await assert.rejects(
      () => svc.search(h.principal, long),
      /过长/,
      '超长查询必须显式报错（截断会给出"看起来正常但只搜了一部分"的结果）',
    )
    // 边界内应放行
    await assert.doesNotReject(() => svc.search(h.principal, '检'.repeat(MAX_QUERY_LENGTH)))
  } finally {
    h.dispose()
  }
})

test('REST：超长查询 → 400 too_long（与 /api/ai/ask 同口径），而非 500', async () => {
  const h = makeHarness()
  try {
    const res = await h.search(`q=${encodeURIComponent('检'.repeat(MAX_QUERY_LENGTH + 1))}`)
    assert.equal(res.status, 400, `必须是 400（500 会被误读成服务器故障）: ${JSON.stringify(res.body)}`)
    assert.equal(res.body['error'], 'too_long')
    assert.match(String(res.body['message']), /过长/)
    // 边界值放行
    const okRes = await h.search(`q=${encodeURIComponent('检'.repeat(MAX_QUERY_LENGTH))}`)
    assert.equal(okRes.status, 200, '恰好 MAX_QUERY_LENGTH 应放行')
  } finally {
    h.dispose()
  }
})

test('语义记录：混排里的 <3 字符片段不参与 FTS 召回（既有取舍，此处钉住行为）', () => {
  // 「检索 ab」：ab 只有 2 字符，切不出词元（trigram 下 MATCH 恒为空），故被丢弃；
  // 保留的是「检索」切出的 3-gram？——「检索」本身只有 2 字，也切不出。
  // 因此整串只有 ASCII 侧的 ab 与中文侧的 检索 都不足 3 → 无词元。
  assert.deepEqual(buildTermQuery('检索 ab'), [], '中文 2 字 + 英文 2 字母都不足 3 字符 → 无词元')
  // 但一旦有一侧够长，就只召回那一侧（短片段不参与）——这是有意的取舍，避免合并
  // FTS 与 LIKE 两路结果带来的 mode 语义变化。
  const mixed = buildTermQuery('检索增强 ab')
  assert.ok(mixed.length > 0, '中文侧够长时应切出词元')
  assert.ok(mixed.every((t) => !t.includes('ab')), '过短的 ASCII 片段不产生词元')
})

/* ---------------------- 能力边界：非 sqlite 方言必须显式拒绝 ---------------------- */

/**
 * 本插件的全文索引建立在 SQLite 专有的 **FTS5**（`tokenize='trigram'`）之上，
 * PostgreSQL 没有 FTS5。若静默放行，会先炸在迁移脚本语法上、或更糟：
 * 启动成功但检索恒为空。故钉住"必须抛错、且说明原因与替代方案"。
 */
test('非 sqlite 方言：search 显式拒绝并说明 FTS5 依赖（不静默失效）', () => {
  const services = new Map<string, unknown>([
    [
      'db',
      {
        kind: 'async',
        dialect: 'postgres',
        query: async () => [],
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        migrate: async () => undefined,
        listTables: async () => [],
        appliedMigrations: async () => [],
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
        close: async () => undefined,
      },
    ],
  ])
  const ctx = { get: (n: string) => services.get(n) } as unknown as Context
  assert.throws(
    () => SearchPlugin.apply(ctx, {}),
    (err: Error) => {
      assert.match(err.message, /postgres/, '错误里必须点明方言')
      assert.match(err.message, /FTS5/, '错误里必须说明真实原因（FTS5 是 SQLite 专有）')
      assert.match(err.message, /db-sqlite/, '错误里必须给出可执行的替代方案')
      return true
    },
  )
})
