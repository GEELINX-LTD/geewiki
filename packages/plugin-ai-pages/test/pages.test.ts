/**
 * `@geewiki/ai-pages` 的行为测试。
 *
 * **测试策略**：真实 `AiToolRegistry` + 真实 cordis `Context` + 真实 `@geewiki/ai-journal`
 * 插件（跑真 SQLite 临时库），只把 `wiki-service` / `policy-service` 换成替身。
 *
 * 为什么日志那条路径要起**真**的 journal：本包最容易写错的地方不是"内容改没改"，
 * 而是"日志记了没有、记的是不是那一轮的 before/after"。用替身记日志等于把这条
 * 断言换成"我调了我自己写的桩"——而那正是出问题的那一环。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { HttpRouterService, Principal, RouteHandler } from '@geewiki/core'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import { AiToolsPlugin, type ResolvedTool } from '@geewiki/ai-tools'
import { AiJournalPlugin } from '@geewiki/ai-journal'
import { AI_JOURNAL_SERVICE_NAME, type AiJournalService } from '@geewiki/ai-journal'
import { AiPagesPlugin, manifest, PAGE_DOMAIN } from '../src/index.js'

const MEMBER: Principal = { kind: 'user', userId: 7, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }
const CTX = { conversationId: 'c1', turnId: 't1' }

interface Harness {
  tool(name: string): ResolvedTool
  tools(principal: Principal): readonly ResolvedTool[]
  pages: Map<string, { title: string; content: string }>
  saveCalls: { slug: string; title: string; content: string }[]
  canEdit: boolean
  level: string
  /** 服务端能否给出**原文**（`contentMode:'raw'`）。false = 模拟契约漂移（判据不一致） */
  rawAvailable: boolean
  journal: AiJournalService
  dispose(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ai-pages-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  db.open()

  const routes = new Map<string, RouteHandler>()
  const router = {
    register: (method: string, path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler)
      return () => routes.delete(`${method} ${path}`)
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => 0,
    pending: () => 0,
    drain: () => Promise.resolve(true),
  } as unknown as HttpRouterService

  const pages = new Map([['home', { title: '主页', content: '原始正文' }]])
  const saveCalls: { slug: string; title: string; content: string }[] = []
  const state = { canEdit: true, level: 'public', rawAvailable: true }

  const ctx = new Context()
  ctx.provide('http', router)
  ctx.provide('db', db)
  ctx.provide('wiki-service', {
    // 读方法按主体过滤：无权时返回 undefined（与真实实现同语义——不泄露存在性）
    get: (slug: string, principal: Principal, opts?: { rawContent?: boolean }) => {
      if (principal.kind === 'anonymous') return Promise.resolve(undefined)
      const page = pages.get(slug)
      if (page === undefined) return Promise.resolve(undefined)
      /*
       * ★ 替身必须**照真实服务的口径**回答 `rawContent`：真实实现（P4 修复后）自己强制
       * `canEdit`，够得着才回原文、并带 `contentMode: 'raw'` 自述。
       * 替身若忽略这个参数，`page.update` 的"拿不到原文就不动手"那条分支就永远测不到——
       * 而那正是这次修复的核心。
       */
      return Promise.resolve(
        opts?.rawContent === true && state.canEdit && state.rawAvailable
          ? { ...page, contentMode: 'raw' as const }
          : { ...page },
      )
    },
    save: (slug: string, input: { title: string; content: string }) => {
      saveCalls.push({ slug, ...input })
      pages.set(slug, input)
      return Promise.resolve({ outcome: 'saved' })
    },
  })
  ctx.provide('policy-service', {
    resolvePage: (_p: Principal, slug: string) =>
      Promise.resolve({ level: pages.has(slug) ? state.level : 'none', canEdit: state.canEdit }),
  })

  const forks = [await ctx.plugin(AiToolsPlugin), await ctx.plugin(AiJournalPlugin), await ctx.plugin(AiPagesPlugin)]
  const journal = ctx.get(AI_JOURNAL_SERVICE_NAME) as AiJournalService
  const registry = ctx.get('ai-tool-service') as { list(p: Principal): ResolvedTool[] }

  return {
    tool: (name) => {
      const found = registry.list(MEMBER).find((t) => t.descriptor.name === name)
      assert.notEqual(found, undefined, `工具 ${name} 必须已注册`)
      return found as ResolvedTool
    },
    tools: (principal) => registry.list(principal),
    pages,
    saveCalls,
    get canEdit() {
      return state.canEdit
    },
    set canEdit(v: boolean) {
      state.canEdit = v
    },
    get level() {
      return state.level
    },
    set level(v: string) {
      state.level = v
    },
    /** 模拟"判据说能编辑、服务却没给原文"的契约漂移（真实实现里不该发生，但必须有兜底） */
    set rawAvailable(v: boolean) {
      state.rawAvailable = v
    },
    journal,
    dispose: async () => {
      for (const fork of forks) await fork.dispose()
      db.close()
    },
  }
}

/* ============================== 装配与描述符 ============================== */

test('manifest：写工具包必须同时依赖 journal 与 policy（缺一个就不该激活）', () => {
  assert.deepEqual(manifest.geewiki?.requires, [
    'ai-tool-service',
    'wiki-service',
    'policy-service',
    'ai-journal-service',
  ])
  assert.equal(manifest.geewiki?.provides, undefined, '纯贡献者：不 provide 服务')
})

test('page.update 是 mutating 工具（回退与自锁护栏据此生效）', async () => {
  const h = await makeHarness()
  const tool = h.tool('page.update')
  assert.equal(tool.descriptor.mutating, true)
  assert.equal(tool.descriptor.side, 'server')
  assert.equal(tool.descriptor.parameters?.['type'], 'object')
  await h.dispose()
})

test('匿名主体下 page.update **不进工具表**（模型不会去调一个注定失败的写工具）', async () => {
  const h = await makeHarness()
  const names = h.tools(ANON).map((t) => t.descriptor.name)
  assert.equal(names.includes('page.update'), false)
  assert.equal(h.tools(MEMBER).some((t) => t.descriptor.name === 'page.update'), true)
  await h.dispose()
})

test('缺 journal 服务 ⇒ apply 抛错（不是"能改但记不下来"）', async () => {
  const ctx = new Context()
  ctx.provide('ai-tool-service', { contribute: () => () => {}, list: () => [], ownerOf: () => undefined, release: () => {}, diagnostics: () => ({ count: 0, overBudget: [], mutating: 0 }) })
  await assert.rejects(async () => {
    await ctx.plugin(AiPagesPlugin)
  }, /ai-journal-service 不可用/)
})

/* ============================== 正常写入 ============================== */

test('page.update：改正文并把 before/after 记进当轮日志', async () => {
  const h = await makeHarness()
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'home', content: '新的正文' }, CTX)
  assert.match(result.content, /已更新 home/)
  assert.equal(h.pages.get('home')?.content, '新的正文')
  assert.equal(h.saveCalls.length, 1)
  assert.equal(h.saveCalls[0]?.title, '主页', 'save 是整篇替换，标题必须原样带上，不能被抹掉')

  const rows = await h.journal.list({ conversationId: 'c1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.before, '原始正文', 'before 必须是**改之前**的正文——它是回退的唯一依据')
  assert.equal(rows[0]?.after, '新的正文')
  assert.equal(rows[0]?.turnId, 't1')
  assert.equal(rows[0]?.domain, PAGE_DOMAIN)
  assert.equal(rows[0]?.tool, 'page.update')
  await h.dispose()
})

test('page.update：内容没变 ⇒ 不写、也不记日志（不留一条点了没反应的可回退条目）', async () => {
  const h = await makeHarness()
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'home', content: '原始正文' }, CTX)
  assert.match(result.content, /无需修改/)
  assert.equal(h.saveCalls.length, 0)
  assert.equal((await h.journal.list({ conversationId: 'c1' })).length, 0)
  await h.dispose()
})

/* ============================== 拒绝路径 ============================== */

test('page.update：没有轮次标识 ⇒ **拒绝动手**（记不下来就别改）', async () => {
  const h = await makeHarness()
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'home', content: '新的正文' }, {
    conversationId: null,
    turnId: null,
  })
  assert.equal(h.saveCalls.length, 0, '不可回退的写操作一次都不能发生')
  assert.equal(h.pages.get('home')?.content, '原始正文')
  assert.equal((await h.journal.list({ conversationId: 'c1' })).length, 0)
  assert.match(result.content, /没有修改任何内容/)
  await h.dispose()
})

test('page.update：只有 conversationId 也不行（回退粒度是轮，不是会话）', async () => {
  const h = await makeHarness()
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'home', content: 'x' }, {
    conversationId: 'c1',
    turnId: null,
  })
  assert.equal(h.saveCalls.length, 0)
  assert.match(result.content, /没有修改任何内容/)
  await h.dispose()
})

test('page.update：无编辑权 ⇒ 拒绝，且**不写、不记日志**', async () => {
  const h = await makeHarness()
  h.canEdit = false
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'home', content: '越权内容' }, CTX)
  assert.match(result.content, /没有编辑 home 的权限/)
  assert.equal(h.saveCalls.length, 0)
  assert.equal(h.pages.get('home')?.content, '原始正文')
  assert.equal((await h.journal.list({ conversationId: 'c1' })).length, 0, '没发生的事不该留下日志')
  await h.dispose()
})

test('page.update：页面不存在 ⇒ 明确报"没找到"，不泄露"存在但你看不到"', async () => {
  const h = await makeHarness()
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'nope', content: 'x' }, CTX)
  assert.match(result.content, /没有找到页面 nope/)
  assert.match(result.content, /可能不存在，或你没有查看它的权限/)
  assert.equal(h.saveCalls.length, 0)
  await h.dispose()
})

test('page.update：参数不合法各自报错且**不写**', async () => {
  const h = await makeHarness()
  const tool = h.tool('page.update')
  const cases: unknown[] = [
    'not-an-object',
    {},
    { slug: '', content: 'x' },
    { slug: 'home' },
    { slug: 'home', content: 123 },
    { slug: 'home', content: 'x'.repeat(200_001) },
  ]
  for (const args of cases) {
    const result = await tool.execute(MEMBER, args, CTX)
    assert.match(result.content, /参数不合法/, `args=${JSON.stringify(args).slice(0, 40)} 必须被拒`)
  }
  assert.equal(h.saveCalls.length, 0)
  assert.equal((await h.journal.list({ conversationId: 'c1' })).length, 0)
  await h.dispose()
})

/* ============================== 回退闭环 ============================== */

test('回退闭环：改 → 回退 → 正文回到改之前，且记录被标记已撤销', async () => {
  const h = await makeHarness()
  await h.tool('page.update').execute(MEMBER, { slug: 'home', content: 'AI 改过的正文' }, CTX)
  assert.equal(h.pages.get('home')?.content, 'AI 改过的正文')

  const report = await h.journal.rollbackTo(MEMBER, 'c1', 't1', () => 'AI 改过的正文')
  assert.equal(report.undone.length, 1, '撤销执行体由本包注册，服务端应直接执行')
  assert.equal(report.conflicts.length, 0)
  assert.equal(h.pages.get('home')?.content, '原始正文', '正文必须回到 AI 动手之前的样子')

  const rows = await h.journal.list({ conversationId: 'c1' })
  assert.notEqual(rows[0]?.undoneAt, null)
  await h.dispose()
})

test('回退闭环：**他人改过即拒绝**——正文保持别人的版本，一个字符都不动', async () => {
  const h = await makeHarness()
  await h.tool('page.update').execute(MEMBER, { slug: 'home', content: 'AI 改过的正文' }, CTX)
  // 另一个人随后改了它
  h.pages.set('home', { title: '主页', content: '同事改过的正文' })

  const report = await h.journal.rollbackTo(MEMBER, 'c1', 't1', () => '同事改过的正文')
  assert.equal(report.undone.length, 0)
  assert.equal(report.conflicts.length, 1)
  assert.match(report.conflicts[0]?.reason ?? '', /又被改动过/)
  assert.equal(h.pages.get('home')?.content, '同事改过的正文', '冲突时绝不能覆盖别人的编辑')
  await h.dispose()
})

test('回退闭环：回退时**没有编辑权** ⇒ 拒绝并说明原因（能回退的前提是"他现在能改"）', async () => {
  const h = await makeHarness()
  await h.tool('page.update').execute(MEMBER, { slug: 'home', content: 'AI 改过的正文' }, CTX)
  h.canEdit = false
  /*
   * 落点是 `conflicts` 而不是 `failed`：探针在读原文这一步就够不着（`rawContent` 自己带
   * 编辑权判据），于是**根本没有进入撤销执行体**。这不是文案问题——它决定了"谁被问责"：
   * `failed` 意味着执行体试过并失败，而这里压根没试。
   */
  const report = await h.journal.rollbackTo(MEMBER, 'c1', 't1', () => 'AI 改过的正文')
  assert.equal(report.undone.length, 0)
  assert.equal(report.failed.length, 0)
  assert.equal(report.conflicts.length, 1)
  assert.match(report.conflicts[0]?.reason ?? '', /没有编辑 home 的权限/)
  assert.equal(h.pages.get('home')?.content, 'AI 改过的正文', '正文一个字都没动')
  await h.dispose()
})

test('回退闭环：页面已被删除 ⇒ 拒绝并说明原因，不是静默成功', async () => {
  const h = await makeHarness()
  await h.tool('page.update').execute(MEMBER, { slug: 'home', content: 'AI 改过的正文' }, CTX)
  h.pages.delete('home')
  const report = await h.journal.rollbackTo(MEMBER, 'c1', 't1', () => 'AI 改过的正文')
  assert.equal(report.undone.length, 0)
  assert.equal(report.conflicts.length, 1)
  assert.match(report.conflicts[0]?.reason ?? '', /已不存在|已被删除/)
  await h.dispose()
})

/*
 * 这条是探针存在的**全部理由**：冲突检测的输入不能由被检测的一方提供。
 * 回退请求来自浏览器，而"现在是什么"若也来自浏览器，那么一个过期的页面（或者一个
 * 存心的客户端）只要报"没变过"，就能把别人的编辑静默覆盖掉——而覆盖是不可逆的。
 */
test('冲突检测以**服务端探针**为准：客户端自报"没变过"骗不过它', async () => {
  const h = await makeHarness()
  await h.tool('page.update').execute(MEMBER, { slug: 'home', content: 'AI 改过的正文' }, CTX)
  // 之后别人又改了一次
  h.pages.set('home', { title: '主页', content: '人改过的正文' })
  // 客户端谎报"现在还是 AI 改过的那一份"（等价于：它拿着一份过期的快照）
  const report = await h.journal.rollbackTo(MEMBER, 'c1', 't1', () => 'AI 改过的正文')
  assert.equal(report.undone.length, 0, '不能撤')
  assert.equal(report.conflicts.length, 1)
  assert.match(report.conflicts[0]?.reason ?? '', /又被改动过/)
  assert.equal(h.pages.get('home')?.content, '人改过的正文', '别人的编辑必须原封不动')
  await h.dispose()
})

test('同一域不会被两个探针占用（第二家注册必须抛错，不许静默覆盖）', async () => {
  const h = await makeHarness()
  assert.throws(
    () => h.journal.registerProbe('@geewiki/other', PAGE_DOMAIN, async () => ({ value: '' })),
    /已有当前值探针/,
    '两家都说得出"现在是什么"时，冲突检测的结论取决于谁先注册——那是不可接受的不确定性',
  )
  await h.dispose()
})

test('同一域不会被两个撤销执行体占用（第二家注册必须抛错，不许静默覆盖）', async () => {
  const h = await makeHarness()
  assert.throws(
    () => h.journal.registerUndoer('@geewiki/other', PAGE_DOMAIN, async () => ({ ok: true, detail: '' })),
    /已有撤销执行体/,
    '两家都能"把页面改回去"时，改回去的结果取决于谁先注册——那是不可接受的不确定性',
  )
  await h.dispose()
})

/* ============ 可见性结构护栏（P4 权限红线；纯函数用例见 gatedGuard.test.ts） ============ */

test('page.update：改写会动到 gated 结构 ⇒ 拒绝，且**一个字都没写、一条日志都没记**', async () => {
  const h = await makeHarness()
  const before = ['公开开头', '<!--gated:org-->', '只给同事看的内容', '<!--/gated-->'].join('\n')
  h.pages.set('secret', { title: '含受限段落的页', content: before })

  // 模型只看到了投影正文（受限段落被换成占位），于是把投影结果当正文写回
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'secret', content: '公开开头\n> 🔒 此处有 1 段内容' }, CTX)

  assert.match(result.content, /受限区段/)
  assert.equal(h.pages.get('secret')?.content, before, '正文必须**逐字不动**——拒绝不是"改一半"')
  assert.equal(h.saveCalls.length, 0, '拒绝的路径上不应产生任何 save 调用')
  const rows = await h.journal.list({ conversationId: 'c1' })
  assert.equal(rows.length, 0, '没有改动就不该有日志：留一条"可回退"记录会让用户以为改过了')
  await h.dispose()
})

test('page.update：保住 gated 结构（只改区段里的文字）⇒ 放行', async () => {
  const h = await makeHarness()
  h.pages.set('secret', {
    title: '含受限段落的页',
    content: ['公开开头', '<!--gated:org-->', '旧内容', '<!--/gated-->'].join('\n'),
  })
  const result = await h.tool('page.update').execute(
    MEMBER,
    { slug: 'secret', content: ['公开开头改了', '<!--gated:org-->', '新内容', '<!--/gated-->'].join('\n') },
    CTX,
  )
  assert.match(result.content, /已更新 secret/)
  assert.match(h.pages.get('secret')?.content ?? '', /<!--gated:org-->/)
  await h.dispose()
})

test('page.update：拿不到原文（契约漂移）⇒ 拒绝动手，而不是拿投影正文去写', async () => {
  const h = await makeHarness()
  h.rawAvailable = false
  const result = await h.tool('page.update').execute(MEMBER, { slug: 'home', content: '新正文' }, CTX)
  assert.match(result.content, /读不到 home 的原文/)
  assert.match(result.content, /没有修改任何内容/)
  assert.equal(h.pages.get('home')?.content, '原始正文')
  assert.equal(h.saveCalls.length, 0)
  await h.dispose()
})

test('page.update：日志里的 before 必须是**原文**（回退要原样写回，占位符回不去）', async () => {
  const h = await makeHarness()
  const before = ['开头', '<!--gated:granted-->', '机密', '<!--/gated-->', '结尾'].join('\n')
  h.pages.set('secret', { title: '受限页', content: before })
  await h.tool('page.update').execute(
    MEMBER,
    { slug: 'secret', content: ['开头', '<!--gated:granted-->', '机密改了', '<!--/gated-->', '结尾'].join('\n') },
    CTX,
  )
  const rows = await h.journal.list({ conversationId: 'c1' })
  assert.equal(rows[0]?.before, before, 'before 不是原文的话，"回退"会把占位符写成正文')
  assert.match(rows[0]?.before ?? '', /<!--gated:granted-->/)
  await h.dispose()
})
