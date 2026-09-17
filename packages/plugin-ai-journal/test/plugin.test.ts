/**
 * `@geewiki/ai-journal` 的插件级行为测试。
 *
 * **测试策略**：真实 cordis `Context` + **真实 better-sqlite3 临时库**（迁移真跑，
 * 故 `migrations/0001_ai_mutations.sql` 的语法与部分索引都被真的验过），只把
 * `http` 换成**记录路由的替身**。理由：本插件的行为全在"记了什么、回退时撤了什么、
 * 冲突时**没撤**什么"上——最后一条尤其只能靠"替身调用次数为 0"来证明。
 *
 * 这里刻意**不用**内存假数据库：那样等于拿我自己的 mock 去验我自己的 SQL，
 * 而迁移与查询恰恰是最容易写错、又最不会在假实现上暴露的部分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { HttpRouterService, Principal, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import {
  AiJournalPlugin,
  JOURNAL_RECORD_PATH,
  JOURNAL_UNDO_PATH,
  manifest,
  parseMutationInput,
  SelfLockError,
} from '../src/index.js'
import { AI_JOURNAL_SERVICE_NAME, type AiJournalService, type MutationRecord } from '../src/types.js'

const USER: Principal = { kind: 'user', userId: 7, orgId: 1, orgRole: 'member', groupIds: [], sessionId: null }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

/* ------------------------------ 夹具 ------------------------------ */

interface Harness {
  ctx: Context
  db: SqliteDatabase
  service: AiJournalService
  call(method: string, path: string, opts?: { body?: unknown; principal?: Principal; query?: string }): Promise<{ status: number; body: Record<string, unknown> }>
  undoCount(): number
  dispose(): Promise<void>
}

/** 记录每条变更的撤销执行体被调了几次——"冲突时一次都没调"是本文件的核心断言 */
function undoerSpy(log: MutationRecord[], result: { ok: boolean; detail: string } = { ok: true, detail: '已还原' }) {
  return async (record: MutationRecord, principal: Principal) => {
    log.push(record)
    // 撤销执行体必须拿到"现在是谁在回退"——权限判在它这一侧
    assert.equal(principal.kind, 'user', '撤销执行体拿到的必须是调用方的主体，不是空主体')
    assert.equal(principal.userId, 7)
    return result
  }
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ai-journal-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  db.open()

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
  const fork = await ctx.plugin(AiJournalPlugin)

  const service = ctx.get(AI_JOURNAL_SERVICE_NAME) as AiJournalService | undefined
  assert.notEqual(service, undefined, 'ai-journal-service 必须被 provide 出去')

  const calls: { status: number; body: Record<string, unknown> }[] = []
  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; principal?: Principal; query?: string } = {},
  ) => {
    const handler = routes.get(`${method} ${path}`)
    assert.notEqual(handler, undefined, `路由 ${method} ${path} 必须已注册`)
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {}
    const req = {
      on(event: string, fn: (arg?: unknown) => void) {
        ;(listeners[event] ??= []).push(fn)
        return req
      },
      pause() {},
    }
    const h = {
      req,
      res: {} as never,
      url: new URL(`http://x${path}${opts.query ?? ''}`),
      params: {},
      principal: opts.principal ?? USER,
      json(status: number, body: unknown) {
        record.status = status
        record.body = body as Record<string, unknown>
      },
    }
    const record = { status: 0, body: {} as Record<string, unknown> }
    const promise = Promise.resolve(handler?.(h as unknown as RouteHandlerContext))
    const text = opts.body === undefined ? '' : JSON.stringify(opts.body)
    if (text !== '') for (const fn of listeners['data'] ?? []) fn(Buffer.from(text))
    for (const fn of listeners['end'] ?? []) fn()
    await promise
    calls.push(record)
    return record
  }

  return {
    ctx,
    db,
    service: service as AiJournalService,
    call,
    undoCount: () => calls.length * 0, // 占位：真正的计数在各自的 spy 里
    dispose: async () => {
      await fork.dispose()
      db.close()
    },
  }
}

const input = (over: Record<string, unknown> = {}) => ({
  conversationId: 'c1',
  turnId: 't1',
  owner: '@geewiki/ai-writing',
  tool: 'editor.insert_text',
  domain: 'editor',
  target: 'doc-1',
  before: '旧',
  after: '新',
  ...over,
})

/* ============================== 装配 ============================== */

test('缺 http 服务 ⇒ apply 抛错（不是静默不注册路由）', async () => {
  const ctx = new Context()
  ctx.provide('db', {})
  await assert.rejects(async () => {
    await ctx.plugin(AiJournalPlugin)
  }, /http 服务不可用/)
})

test('缺数据库 ⇒ apply 抛错', async () => {
  const ctx = new Context()
  ctx.provide('http', {})
  await assert.rejects(async () => {
    await ctx.plugin(AiJournalPlugin)
  }, /db 服务不可用/)
})

test('manifest：provides 服务标识，且不依赖 llm / ai-tools（否则与调用方成环）', () => {
  assert.equal(manifest.geewiki?.provides, AI_JOURNAL_SERVICE_NAME)
  assert.deepEqual(manifest.geewiki?.requires, ['http-service', 'database-provider'])
})

test('apply 后服务可用；dispose 后服务变回 undefined（卸载即不可用）', async () => {
  const h = await makeHarness()
  assert.notEqual(h.ctx.get(AI_JOURNAL_SERVICE_NAME), undefined)
  await h.dispose()
  assert.equal(h.ctx.get(AI_JOURNAL_SERVICE_NAME), undefined)
})

/* ============================== 记录与查询 ============================== */

test('record → list：逐字段往返（含 before/after 的 null）', async () => {
  const h = await makeHarness()
  const id = await h.service.record({ ...input(), before: null, after: '新增的' })
  assert.ok(id > 0)
  const [row] = await h.service.list({ conversationId: 'c1' })
  assert.equal(row?.before, null, 'null 必须往返成 null，不能变成空串')
  assert.equal(row?.after, '新增的')
  assert.equal(row?.owner, '@geewiki/ai-writing')
  assert.equal(row?.undoneAt, null)
  await h.dispose()
})

test('list：按会话过滤；pendingOnly 排除已撤销的', async () => {
  const h = await makeHarness()
  await h.service.record(input({ conversationId: 'c1', target: 'a' }))
  await h.service.record(input({ conversationId: 'c2', target: 'b' }))
  const c1 = await h.service.list({ conversationId: 'c1' })
  assert.deepEqual(
    c1.map((r) => r.target),
    ['a'],
  )
  await h.service.markUndone([c1[0]?.id ?? 0], '测试')
  assert.equal((await h.service.list({ conversationId: 'c1' })).length, 1, '不带 pendingOnly 时已撤销的仍在')
  assert.equal((await h.service.list({ conversationId: 'c1', pendingOnly: true })).length, 0)
  await h.dispose()
})

test('turns：按轮分组交给服务（粒度是"一次提问"，不是 HTTP 回合）', async () => {
  const h = await makeHarness()
  await h.service.record(input({ turnId: 't1', target: 'a' }))
  await h.service.record(input({ turnId: 't2', target: 'b' }))
  await h.service.record(input({ turnId: 't1', target: 'c' }))
  const turns = await h.service.turns('c1')
  assert.deepEqual(
    turns.map((t) => t.turnId),
    ['t2', 't1'],
  )
  assert.deepEqual(
    turns.find((t) => t.turnId === 't1')?.records.map((r) => r.target),
    ['a', 'c'],
  )
  /*
   * 这条断言是**真缺陷回归**：三条记录落在同一毫秒时，只按 `at` 排序会打平，
   * "最近的一轮"就可能排到下面去——而"回退到最近一轮之前"正是它最主要的用法。
   * `seq`（该轮**最早**一条记录的 id，AUTOINCREMENT 单调）是唯一可靠的决胜键；
   * 它必须与 `at` 同语义（"这一轮什么时候开始的"），取最大 id 会给出相反答案。
   */
  assert.ok((turns[0]?.seq ?? 0) > (turns[1]?.seq ?? 0), '最近的一轮必须靠 seq 稳定排在前面')
  await h.dispose()
})

/* ============================== 回退 ============================== */

test('rollbackTo：有服务端执行体的域**真的执行**撤销并标记已撤销', async () => {
  const h = await makeHarness()
  const log: MutationRecord[] = []
  h.service.registerUndoer(manifest.name, 'editor', undoerSpy(log))
  await h.service.record(input({ target: 'doc-1' }))

  const report = await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  assert.equal(log.length, 1, '撤销执行体必须被调用')
  assert.equal(report.undone.length, 1)
  assert.equal(report.clientSteps.length, 0)
  assert.equal(report.conflicts.length, 0)

  const rows = await h.service.list({ conversationId: 'c1' })
  assert.notEqual(rows[0]?.undoneAt, null, '执行成功必须落 undone_at')
  await h.dispose()
})

test('rollbackTo：**没有**服务端执行体的域作为 clientSteps 返回，且不标记已撤销', async () => {
  const h = await makeHarness()
  // 刻意不注册 editor 域的撤销执行体（草稿在浏览器里，本来就不该有服务端执行体）
  await h.service.record(input({ target: 'doc-1' }))
  const report = await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  assert.equal(report.clientSteps.length, 1)
  assert.equal(report.clientSteps[0]?.record.target, 'doc-1')
  assert.equal(report.undone.length, 0)
  assert.equal(report.failed.length, 0, '"交给客户端"不是失败')
  const rows = await h.service.list({ conversationId: 'c1' })
  assert.equal(rows[0]?.undoneAt, null, '**还没撤**就不能说撤了——报告说谎比回退失败更糟')
  await h.dispose()
})

test('rollbackTo：冲突时撤销执行体**一次都没被调用**（这是决策 11 的判据）', async () => {
  const h = await makeHarness()
  const log: MutationRecord[] = []
  h.service.registerUndoer(manifest.name, 'editor', undoerSpy(log))
  await h.service.record(input({ target: 'doc-1', after: 'AI 写的' }))

  // 有人在这之后又改了它
  const report = await h.service.rollbackTo(USER, 'c1', 't1', () => '别人改的')
  assert.equal(log.length, 0, '有冲突就绝不能碰它——"先撤再报冲突"等于已经覆盖了别人的编辑')
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.undone.length, 0)
  const rows = await h.service.list({ conversationId: 'c1' })
  assert.equal(rows[0]?.undoneAt, null)
  await h.dispose()
})

test('rollbackTo：**幂等**——回退两次，撤销执行体只跑一次', async () => {
  const h = await makeHarness()
  const log: MutationRecord[] = []
  h.service.registerUndoer(manifest.name, 'editor', undoerSpy(log))
  await h.service.record(input({ target: 'doc-1' }))

  const first = await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  const second = await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  assert.equal(first.undone.length, 1)
  assert.equal(second.undone.length, 0)
  assert.equal(second.alreadyUndone.length, 1)
  assert.equal(log.length, 1, '第二次回退不得把逆操作再执行一遍（对"删除刚建的东西"就是灾难）')
  await h.dispose()
})

test('rollbackTo：撤销执行体报失败 ⇒ 进 failed，**不**标记已撤销（可再试）', async () => {
  const h = await makeHarness()
  h.service.registerUndoer(manifest.name, 'editor', undoerSpy([], { ok: false, detail: '目标已被删除' }))
  await h.service.record(input({ target: 'doc-1' }))
  const report = await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  assert.equal(report.failed.length, 1)
  assert.equal(report.failed[0]?.detail, '目标已被删除')
  const rows = await h.service.list({ conversationId: 'c1' })
  assert.equal(rows[0]?.undoneAt, null, '失败不能标记已撤销，否则用户永远重试不了')
  await h.dispose()
})

test('rollbackTo：撤销执行体抛异常 ⇒ 进 failed（不能把整次回退带崩）', async () => {
  const h = await makeHarness()
  h.service.registerUndoer(manifest.name, 'editor', () => {
    throw new Error('数据库锁住了')
  })
  await h.service.record(input({ target: 'doc-1' }))
  const report = await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  assert.equal(report.failed.length, 1)
  assert.match(report.failed[0]?.detail ?? '', /数据库锁住了/)
  await h.dispose()
})

test('rollbackTo：倒序撤销（后做的先撤）', async () => {
  const h = await makeHarness()
  const order: string[] = []
  h.service.registerUndoer(manifest.name, 'editor', async (r, _p) => {
    order.push(r.target)
    return { ok: true, detail: 'ok' }
  })
  await h.service.record(input({ target: 'a' }))
  await h.service.record(input({ target: 'b' }))
  await h.service.record(input({ target: 'c' }))
  await h.service.rollbackTo(USER, 'c1', 't1', (r) => r.after)
  assert.deepEqual(order, ['c', 'b', 'a'])
  await h.dispose()
})

test('registerUndoer：同一域重复注册**抛错**（两份撤销实现时"改回去"没有确定答案）', async () => {
  const h = await makeHarness()
  h.service.registerUndoer('@geewiki/a', 'page', async () => ({ ok: true, detail: '' }))
  assert.throws(() => h.service.registerUndoer('@geewiki/b', 'page', async () => ({ ok: true, detail: '' })), /已有撤销执行体/)
  await h.dispose()
})

test('registerUndoer：注销后可换人注册（disposer 释放干净）', async () => {
  const h = await makeHarness()
  const off = h.service.registerUndoer('@geewiki/a', 'page', async () => ({ ok: true, detail: '' }))
  off()
  h.service.registerUndoer('@geewiki/b', 'page', async () => ({ ok: true, detail: '' }))
  await h.dispose()
})

test('markUndone：返回真正改动的行数（重复 ack 第二次是 0）', async () => {
  const h = await makeHarness()
  const id = await h.service.record(input())
  assert.equal(await h.service.markUndone([id], 'ok'), 1)
  assert.equal(await h.service.markUndone([id], 'ok'), 0, '已经撤销过的再 ack 不应再改一次')
  await h.dispose()
})

/* ============================== 解析与自锁护栏 ============================== */

test('parseMutationInput：未知字段一律拒绝（静默忽略会让契约悄悄漂移）', () => {
  assert.throws(() => parseMutationInput({ ...input(), extra: 1 }), /未知字段: extra/)
})

test('parseMutationInput：必填字段缺失/类型不对/超长各自报错', () => {
  assert.throws(() => parseMutationInput({ ...input(), conversationId: '' }), /conversationId 不得为空/)
  assert.throws(() => parseMutationInput({ ...input(), target: 42 }), /target 必须是字符串/)
  assert.throws(() => parseMutationInput({ ...input(), before: 5 }), /before 必须是字符串或 null/)
  assert.throws(() => parseMutationInput({ ...input(), target: 'x'.repeat(600) }), /target 过长/)
  assert.throws(() => parseMutationInput('不是对象'), /必须是 JSON 对象/)
})

test('parseMutationInput：踩到自锁红线抛 SelfLockError（与格式问题分开）', () => {
  assert.throws(() => parseMutationInput(input({ target: '@geewiki/llm' })), SelfLockError)
  assert.throws(() => parseMutationInput(input({ target: '@geewiki/ai-journal' })), SelfLockError)
  // 普通插件名照常通过
  assert.equal(parseMutationInput(input({ target: '@geewiki/echo' })).target, '@geewiki/echo')
})

/* ============================== 端点 ============================== */

test('POST /api/ai/journal：200 落库；未知字段 400；受保护节点 **403**（不是 400）', async () => {
  const h = await makeHarness()
  const ok = await h.call('POST', JOURNAL_RECORD_PATH, { body: input() })
  assert.equal(ok.status, 200)
  assert.equal(ok.body['ok'], true)
  assert.ok(Number(ok.body['id']) > 0)

  const bad = await h.call('POST', JOURNAL_RECORD_PATH, { body: { ...input(), extra: 1 } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body['error'], 'invalid_body')

  const forbidden = await h.call('POST', JOURNAL_RECORD_PATH, { body: input({ target: '@geewiki/llm' }) })
  assert.equal(forbidden.status, 403, '这是"不允许"，不是"格式不对"——两者该做的事相反')
  assert.equal(forbidden.body['error'], 'protected_node')

  const rows = await h.service.list({ conversationId: 'c1' })
  assert.equal(rows.length, 1, '被拒的两条都不该落库')
  await h.dispose()
})

test('端点一律要求登录主体：匿名 ⇒ 401（四个端点逐个验）', async () => {
  const h = await makeHarness()
  const cases: [string, string][] = [
    ['POST', JOURNAL_RECORD_PATH],
    ['GET', JOURNAL_RECORD_PATH],
    ['POST', JOURNAL_UNDO_PATH],
    ['POST', `${JOURNAL_UNDO_PATH}/ack`],
  ]
  for (const [method, path] of cases) {
    const res = await h.call(method, path, { principal: ANON, body: {} })
    assert.equal(res.status, 401, `${method} ${path} 对匿名必须是 401`)
    assert.equal(res.body['error'], 'unauthorized')
  }
  await h.dispose()
})

test('GET /api/ai/journal：缺 conversationId ⇒ 400；给了 ⇒ 200 且带 turns', async () => {
  const h = await makeHarness()
  await h.service.record(input({ target: 'a' }))
  const missing = await h.call('GET', JOURNAL_RECORD_PATH)
  assert.equal(missing.status, 400)
  assert.equal(missing.body['error'], 'missing_conversation')

  const ok = await h.call('GET', JOURNAL_RECORD_PATH, { query: '?conversationId=c1' })
  assert.equal(ok.status, 200)
  const turns = ok.body['turns'] as { turnId: string; records: unknown[] }[]
  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.records.length, 1)
  await h.dispose()
})

test('POST /api/ai/journal/undo：服务器执行 + 客户端步骤一起返回，并带上冲突', async () => {
  const h = await makeHarness()
  const log: MutationRecord[] = []
  h.service.registerUndoer(manifest.name, 'page', undoerSpy(log))
  await h.service.record(input({ domain: 'page', target: 'home', after: 'AI 版' }))
  await h.service.record(input({ domain: 'editor', target: 'doc-1', after: 'AI 草稿' }))
  await h.service.record(input({ domain: 'editor', target: 'doc-2', after: '被改过的' }))

  const res = await h.call('POST', JOURNAL_UNDO_PATH, {
    body: {
      conversationId: 'c1',
      turnId: 't1',
      snapshots: { 'page:home': 'AI 版', 'editor:doc-1': 'AI 草稿', 'editor:doc-2': '别人改的' },
    },
  })
  assert.equal(res.status, 200)
  const undone = res.body['undone'] as unknown[]
  const clientSteps = res.body['clientSteps'] as { record: MutationRecord }[]
  const conflicts = res.body['conflicts'] as unknown[]
  assert.equal(undone.length, 1, 'page 域有执行体，服务端直接撤')
  assert.equal(log.length, 1)
  assert.equal(clientSteps.length, 1, 'editor 域没有执行体 ⇒ 交给客户端')
  assert.equal(clientSteps[0]?.record.target, 'doc-1')
  assert.equal(conflicts.length, 1, 'doc-2 被人改过 ⇒ 冲突')
  await h.dispose()
})

test('rollbackTo：撤销执行体拿到的是**调用方**的主体（不是空主体、不是记录里的 owner）', async () => {
  const h = await makeHarness()
  const seen: Principal[] = []
  h.service.registerUndoer(manifest.name, 'editor', async (_r, principal) => {
    seen.push(principal)
    return { ok: true, detail: 'ok' }
  })
  await h.service.record(input({ target: 'doc-1' }))
  const other: Principal = { ...USER, userId: 99 }
  await h.service.rollbackTo(other, 'c1', 't1', (r) => r.after)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.userId, 99, '能回退的前提是"他现在有写权限"，所以必须是他的主体')
  await h.dispose()
})

test('POST /api/ai/journal/undo：**没给** snapshots 的目标按冲突处理，不猜"一致"', async () => {
  const h = await makeHarness()
  const log: MutationRecord[] = []
  h.service.registerUndoer(manifest.name, 'page', undoerSpy(log))
  await h.service.record(input({ domain: 'page', target: 'home', after: 'AI 版' }))
  // snapshots 里刻意不含 page:home
  const res = await h.call('POST', JOURNAL_UNDO_PATH, { body: { conversationId: 'c1', turnId: 't1', snapshots: {} } })
  assert.equal(res.status, 200)
  assert.equal((res.body['conflicts'] as unknown[]).length, 1)
  assert.equal(log.length, 0, '不知道"现在是什么"时一次都不能碰')
  await h.dispose()
})

test('POST /api/ai/journal/undo：snapshots 形状不对 ⇒ 400（不是静默当空对象）', async () => {
  const h = await makeHarness()
  const res = await h.call('POST', JOURNAL_UNDO_PATH, {
    body: { conversationId: 'c1', turnId: 't1', snapshots: [1, 2] },
  })
  assert.equal(res.status, 400)
  assert.match(String(res.body['message']), /snapshots 必须是对象/)
  await h.dispose()
})

test('POST …/undo/ack：客户端执行完回报后真的标记已撤销', async () => {
  const h = await makeHarness()
  const id = await h.service.record(input({ domain: 'editor', target: 'doc-1' }))
  const ack = await h.call('POST', `${JOURNAL_UNDO_PATH}/ack`, { body: { ids: [id], detail: '浏览器已还原' } })
  assert.equal(ack.status, 200)
  assert.equal(ack.body['changed'], 1)
  const rows = await h.service.list({ conversationId: 'c1' })
  assert.notEqual(rows[0]?.undoneAt, null)
  await h.dispose()
})

test('POST …/undo/ack：ids 为空/非数组 ⇒ 400', async () => {
  const h = await makeHarness()
  for (const ids of [[], 'x', undefined]) {
    const res = await h.call('POST', `${JOURNAL_UNDO_PATH}/ack`, { body: { ids } })
    assert.equal(res.status, 400)
  }
  await h.dispose()
})

test('端点返回的消息里不含守卫文案以外的内部细节（失败原因只在 failed/conflicts 里）', async () => {
  const h = await makeHarness()
  await h.service.record(input({ target: 'doc-1', after: 'A' }))
  const res = await h.call('POST', JOURNAL_UNDO_PATH, {
    body: { conversationId: 'c1', turnId: 't1', snapshots: { 'editor:doc-1': 'B' } },
  })
  const conflicts = res.body['conflicts'] as { reason: string }[]
  assert.match(conflicts[0]?.reason ?? '', /editor:doc-1/)
  assert.equal(res.body['ok'], true, '有冲突时 ok 仍为 true——冲突是"拒了那一条"，不是整次失败')
  await h.dispose()
})
