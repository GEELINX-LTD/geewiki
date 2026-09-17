/**
 * `@geewiki/ai-admin` 的判据（P5）。
 *
 * 这一组用例的共同点是：**它们都在验"没改任何东西"**。管理台工具是本轮唯一一类
 * 能削弱 AI 自身能力的工具（停掉 `ai-tools` 等于把工具总线拆了，停掉 `llm` 等于让它失语），
 * 而它出错的方式全部是**静默生效**——护栏没拦住的那一次，插件当场就没了，
 * 没有异常、没有测试失败，只有用户发现助手变哑了。
 *
 * 因此这里最重要的断言不是"返回了什么"，而是**管理器有没有被调用过**。
 * 那个替身专门记了一本调用账，`assert.deepEqual(mgr.calls, [])` 才是"没有改动任何东西"
 * 唯一可信的证据（返回文本里的那句"没有改动任何东西"是给模型看的，不是给测试看的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { Principal, GeeWikiManifest } from '@geewiki/core'
import { AiToolRegistry, AiToolsPlugin, type AiToolContext, type AiToolResult, type ResolvedTool } from '@geewiki/ai-tools'
import { PROTECTED_AI_NODES, type AiJournalService, type MutationInput } from '@geewiki/ai-journal'
import { AiAdminPlugin, manifest, ADMIN_TOOL_NAMES, type ManagerLike } from '../src/index.js'

/* ============================== 夹具 ============================== */

const OWNER: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'owner',
  groupIds: [],
  sessionId: null,
}

const MEMBER: Principal = { ...OWNER, userId: 2, orgRole: 'member' }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

interface FakeManager extends ManagerLike {
  readonly calls: string[]
  readonly states: Map<string, 'active' | 'inactive' | 'error'>
  readonly configs: Map<string, Record<string, unknown>>
}

function fakeManager(over: {
  rows?: readonly { name: string; state?: 'active' | 'inactive' | 'error'; layer?: 'base' | 'session' | null }[]
  failWith?: { code: string; message: string; on: string }
} = {}): FakeManager {
  const calls: string[] = []
  const states = new Map<string, 'active' | 'inactive' | 'error'>()
  const configs = new Map<string, Record<string, unknown>>()
  const rows = over.rows ?? [
    { name: '@geewiki/echo', state: 'inactive' as const, layer: null },
    { name: '@geewiki/llm', state: 'active' as const, layer: 'base' as const },
  ]
  for (const r of rows) {
    states.set(r.name, r.state ?? 'inactive')
    configs.set(r.name, { size: 1 })
  }
  const maybeFail = (op: string, name: string): void => {
    if (over.failWith !== undefined && over.failWith.on === op) {
      const err = new Error(over.failWith.message) as Error & { code: string }
      err.code = over.failWith.code
      throw err
    }
    void name
  }
  return {
    calls,
    states,
    configs,
    snapshot: () =>
      rows.map((r) => ({
        name: r.name,
        state: states.get(r.name) ?? 'inactive',
        layer: r.layer ?? null,
        requires: [] as string[],
        configurable: true,
      })),
    enable: async (name) => {
      maybeFail('enable', name)
      calls.push(`enable:${name}`)
      states.set(name, 'active')
      return {}
    },
    disable: async (name) => {
      maybeFail('disable', name)
      calls.push(`disable:${name}`)
      states.set(name, 'inactive')
    },
    configOf: (name) => ({
      config: configs.get(name) ?? {},
      layer: 'session' as const,
      activeLayer: 'session' as const,
      secrets: {},
    }),
    updateConfig: async (name, raw) => {
      maybeFail('updateConfig', name)
      calls.push(`updateConfig:${name}`)
      configs.set(name, raw as Record<string, unknown>)
      return { config: raw as Record<string, unknown> }
    },
  }
}

interface FakeJournal extends AiJournalService {
  readonly records: MutationInput[]
  readonly undoers: Map<string, (r: never, p: Principal) => Promise<unknown>>
  readonly probes: Map<string, (r: never, p: Principal) => Promise<unknown>>
}

function fakeJournal(): FakeJournal {
  const records: MutationInput[] = []
  const undoers = new Map<string, (r: never, p: Principal) => Promise<unknown>>()
  const probes = new Map<string, (r: never, p: Principal) => Promise<unknown>>()
  return {
    records,
    undoers,
    probes,
    record: async (input: MutationInput) => {
      records.push(input)
      return records.length
    },
    list: async () => [],
    turns: async () => [],
    registerUndoer: (owner: string, domain: string, handler: never) => {
      const key = `${owner}:${domain}`
      undoers.set(key, handler)
      return () => undoers.delete(key)
    },
    registerProbe: (owner: string, domain: string, handler: never) => {
      const key = `${owner}:${domain}`
      probes.set(key, handler)
      return () => probes.delete(key)
    },
    rollbackTo: async () => ({}) as never,
    markUndone: async () => 0,
  } as unknown as FakeJournal
}

interface Harness {
  readonly registry: AiToolRegistry
  readonly mgr: FakeManager
  readonly journal: FakeJournal
  byName(name: string): ResolvedTool
  dispose(): Promise<void>
}

async function mount(over: Parameters<typeof fakeManager>[0] = {}, withManager = true): Promise<Harness> {
  const ctx = new Context()
  const registry = new AiToolRegistry()
  await ctx.plugin(AiToolsPlugin, { registry })
  const mgr = fakeManager(over)
  const journal = fakeJournal()
  if (withManager) ctx.provide('manager', mgr)
  ctx.provide('ai-journal-service', journal)
  const fork = await ctx.plugin(AiAdminPlugin, {})
  const tools = [...registry.list(OWNER)]
  return {
    registry,
    mgr,
    journal,
    byName(name) {
      const t = tools.find((x) => x.descriptor.name === name)
      if (t === undefined) throw new Error(`夹具里没有工具 ${name}（现有：${tools.map((x) => x.descriptor.name).join(', ')}）`)
      return t
    },
    async dispose() {
      await fork.dispose()
    },
  }
}

function call(
  tool: ResolvedTool,
  args: unknown,
  principal: Principal = OWNER,
  context: AiToolContext = { conversationId: 'c1', turnId: 't1' },
): Promise<AiToolResult> {
  return tool.execute(principal, args, context)
}

const dataOf = (r: AiToolResult): Record<string, unknown> => (r.data ?? {}) as Record<string, unknown>

/* ============================== 装载 ============================== */

test('装载后贡献四条工具，owner 都是本插件，且写类被标了 mutating', async () => {
  const h = await mount()
  const names = [...h.registry.list(OWNER)].map((t) => t.descriptor.name)
  assert.deepEqual(names, [...ADMIN_TOOL_NAMES])
  for (const t of h.registry.list(OWNER)) assert.equal(t.owner, manifest.name)
  const mutating = h.registry.diagnostics().mutating.filter((n) => n.startsWith('plugin.'))
  assert.deepEqual([...mutating].sort(), ['plugin.set_config', 'plugin.set_enabled'])
  await h.dispose()
})

test('缺 ai-tool-service 或 ai-journal-service 时**明确抛错**，不静默变成一个空插件', async () => {
  const ctx = new Context()
  ctx.provide('ai-journal-service', fakeJournal())
  await assert.rejects(async () => {
    await ctx.plugin(AiAdminPlugin, {})
  }, /ai-tool-service/)
})

test('dispose 后四条工具全部回收（按 owner 定向回收）', async () => {
  const h = await mount()
  await h.dispose()
  assert.deepEqual([...h.registry.list(OWNER)], [])
})

/* ============================== 权限（两层） ============================== */

test('★ 权限第一层：非所有者/管理员**连工具都看不到**（不进模型的工具表）', async () => {
  const h = await mount()
  for (const p of [MEMBER, ANON]) {
    const names = [...h.registry.list(p)].map((t) => t.descriptor.name)
    assert.deepEqual(names, [], `${p.orgRole ?? p.kind} 不该看到管理台工具`)
  }
  // 所有者看得见
  assert.equal(h.registry.list(OWNER).length, 4)
  await h.dispose()
})

test('★ 权限第二层：真调了也不放行，且**管理器一次都没被调用**', async () => {
  const h = await mount()
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true }, MEMBER)
  assert.equal(dataOf(r)['error'], 'forbidden')
  assert.deepEqual(h.mgr.calls, [], '"没有改动任何东西"的唯一可信证据是管理器没被调用过')
  await h.dispose()
})

test('break-glass 应急通道放行（它本就能做一切）', async () => {
  const h = await mount()
  const bg: Principal = { kind: 'break-glass', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true }, bg)
  assert.equal(dataOf(r)['target'], '@geewiki/echo')
  assert.deepEqual(h.mgr.calls, ['enable:@geewiki/echo'])
  await h.dispose()
})

/* ============================== 自锁护栏（决策 13） ============================== */

test('★ 自锁：五个受保护节点逐个被拒，且**在调用管理器之前**就拒了', async () => {
  /*
   * 顺序是本插件里最容易写错、也最贵的一处：`page.update` 可以"先写后记"
   * （因为回退是幂等的整篇正文），但**停用一个插件不是**——它当场生效且没有逆操作。
   * 等 `journal.record()` 来拦就晚了：它只会拒绝**记录**，不会把已经停掉的插件开回来。
   */
  const h = await mount({
    rows: PROTECTED_AI_NODES.map((name) => ({ name, state: 'active' as const, layer: 'session' as const })),
  })
  for (const node of PROTECTED_AI_NODES) {
    const r = await call(h.byName('plugin.set_enabled'), { name: node, enabled: false })
    assert.equal(dataOf(r)['error'], 'self_lock', `${node} 应当被自锁护栏拦住`)
    assert.match(r.content, /没有改动任何东西/)
  }
  assert.deepEqual(h.mgr.calls, [], '护栏必须在动手之前生效')
  assert.deepEqual(h.journal.records, [], '被拦下的变更连记都不该记')
  await h.dispose()
})

test('★ 自锁名单含 @geewiki/ai-admin 本身（P5 补的第五个：没了它，AI 再也不能把任何插件开回来）', () => {
  assert.ok(
    PROTECTED_AI_NODES.includes('@geewiki/ai-admin'),
    '它不在助手的依赖链上，但停了它 AI 就失去了纠错能力——那正是这份名单要保护的东西',
  )
})

test('自锁不误伤普通插件（护栏不能变成"什么都不让做"）', async () => {
  const h = await mount()
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true })
  assert.equal(dataOf(r)['target'], '@geewiki/echo')
  await h.dispose()
})

/* ============================== 参数校验 ============================== */

test('★ enabled 必须显式给：省略时拒绝（替它猜"启用"或"停用"都可能猜错）', async () => {
  const h = await mount()
  for (const args of [{ name: '@geewiki/echo' }, { name: '@geewiki/echo', enabled: 'true' }, { name: '@geewiki/echo', enabled: 1 }]) {
    const r = await call(h.byName('plugin.set_enabled'), args)
    assert.equal(dataOf(r)['error'], 'invalid_arguments')
  }
  assert.deepEqual(h.mgr.calls, [])
  await h.dispose()
})

test('set_config：config 必须是对象（数组/字符串/省略都拒绝）', async () => {
  const h = await mount()
  for (const args of [{ name: '@geewiki/echo' }, { name: '@geewiki/echo', config: [] }, { name: '@geewiki/echo', config: 'x' }]) {
    const r = await call(h.byName('plugin.set_config'), args)
    assert.equal(dataOf(r)['error'], 'invalid_arguments')
  }
  assert.deepEqual(h.mgr.calls, [])
  await h.dispose()
})

test('未知插件名：拒绝并指向 plugin.list（而不是让管理器抛一个内部错）', async () => {
  const h = await mount()
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/nope', enabled: true })
  assert.equal(dataOf(r)['error'], 'not_found')
  assert.match(r.content, /plugin\.list/)
  assert.deepEqual(h.mgr.calls, [])
  await h.dispose()
})

/* ============================== 不可回退就不动手 ============================== */

test('★ 缺轮次标识 ⇒ 拒绝动手（一个不报错的不可逆操作是最坏的一类缺陷）', async () => {
  const h = await mount()
  /*
   * `conversationId: null` 是**客户端没带会话标识**这一真实情形的表达，
   * 而 `AiToolContext` 的两个字段都声明为 `string | null`——这里显式构造它，
   * 不用 `as` 抹掉类型（抹掉之后就测不到"null 也必须被拒绝"了）。
   */
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true }, OWNER, {
    conversationId: null,
    turnId: 't1',
  })
  assert.equal(dataOf(r)['refused'], 'missing_turn_context')
  assert.deepEqual(h.mgr.calls, [])
  assert.deepEqual(h.journal.records, [])
  await h.dispose()
})

test('幂等：状态没变就不动手、也不记日志（记一条"点了没反应"的记录会污染回退入口）', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/echo', state: 'active', layer: 'session' }] })
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true })
  assert.equal(dataOf(r)['unchanged'], true)
  assert.deepEqual(h.mgr.calls, [])
  assert.deepEqual(h.journal.records, [])
  await h.dispose()
})

/* ============================== 成功路径 + 日志 ============================== */

test('★ 停用成功：管理器被调用、日志记下"启用→停用"的可回退快照', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/echo', state: 'active', layer: 'session' }] })
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: false })
  assert.deepEqual(h.mgr.calls, ['disable:@geewiki/echo'])
  assert.equal(h.journal.records.length, 1)
  const rec = h.journal.records[0]!
  assert.equal(rec.domain, 'plugin')
  assert.equal(rec.target, '@geewiki/echo')
  assert.equal(rec.tool, 'plugin.set_enabled')
  assert.equal(rec.before, JSON.stringify({ kind: 'enabled', value: true }))
  assert.equal(rec.after, JSON.stringify({ kind: 'enabled', value: false }))
  assert.equal(rec.conversationId, 'c1')
  assert.equal(rec.turnId, 't1')
  assert.match(r.content, /可以在对话里要求回退/)
  await h.dispose()
})

test('★ 写配置：整份替换，日志记下旧配置（回退的基准是**当前生效**的那份）', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/search', state: 'active', layer: 'session' }] })
  h.mgr.configs.set('@geewiki/search', { limit: 8 })
  const r = await call(h.byName('plugin.set_config'), { name: '@geewiki/search', config: { limit: 20 } })
  assert.deepEqual(h.mgr.calls, ['updateConfig:@geewiki/search'])
  const rec = h.journal.records[0]!
  assert.equal(rec.before, JSON.stringify({ kind: 'config', value: { limit: 8 } }))
  assert.equal(rec.after, JSON.stringify({ kind: 'config', value: { limit: 20 } }))
  assert.equal(dataOf(r)['target'], '@geewiki/search')
  await h.dispose()
})

test('配置没变 ⇒ 不写、不记', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/search', state: 'active', layer: 'session' }] })
  h.mgr.configs.set('@geewiki/search', { limit: 8 })
  const r = await call(h.byName('plugin.set_config'), { name: '@geewiki/search', config: { limit: 8 } })
  assert.equal(dataOf(r)['unchanged'], true)
  assert.deepEqual(h.mgr.calls, [])
  await h.dispose()
})

/* ============================== 管理器错误的翻译 ============================== */

test('★ base_layer：翻成"该去改基础层清单并重启"，且**没有改动任何东西**', async () => {
  const h = await mount({
    // 用 `echo` 而不是 `llm`：后者会先被自锁护栏拦下，测不到 base_layer 这条翻译
    rows: [{ name: '@geewiki/echo', state: 'active', layer: 'base' }],
    failWith: { code: 'base_layer', message: '请编辑基础层清单', on: 'disable' },
  })
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: false })
  assert.equal(dataOf(r)['error'], 'base_layer')
  assert.match(r.content, /plugins\.base\.json/)
  assert.match(r.content, /没有改动任何东西/)
  await h.dispose()
})

test('has_dependents：明确说出"有插件在依赖它"，并说明本次没有改动', async () => {
  const h = await mount({
    rows: [{ name: '@geewiki/echo', state: 'active', layer: 'session' }],
    failWith: { code: 'has_dependents', message: '存在依赖方', on: 'disable' },
  })
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: false })
  assert.equal(dataOf(r)['error'], 'has_dependents')
  assert.match(r.content, /依赖/)
  assert.deepEqual(h.journal.records, [], '没生效就不该留下一条声称改过的记录')
  await h.dispose()
})

test('config 校验失败：说出原因、不改动、不记录', async () => {
  const h = await mount({
    rows: [{ name: '@geewiki/search', state: 'active', layer: 'session' }],
    failWith: { code: 'invalid_config', message: 'limit 必须是 1..50', on: 'updateConfig' },
  })
  const r = await call(h.byName('plugin.set_config'), { name: '@geewiki/search', config: { limit: 999 } })
  assert.equal(dataOf(r)['error'], 'invalid_config')
  assert.match(r.content, /limit 必须是 1\.\.50/)
  assert.deepEqual(h.journal.records, [])
  await h.dispose()
})

test('认不出的错误码**原样透出**（编一个"友好的"说法会让真正的故障不可诊断）', async () => {
  const h = await mount({
    rows: [{ name: '@geewiki/echo', state: 'inactive', layer: null }],
    failWith: { code: 'weird_new_code', message: '某种新故障', on: 'enable' },
  })
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true })
  assert.match(r.content, /weird_new_code/)
  assert.match(r.content, /某种新故障/)
  await h.dispose()
})

test('管理器服务不可用：明确拒绝，不抛错炸掉整轮', async () => {
  const h = await mount({}, false)
  const r = await call(h.byName('plugin.set_enabled'), { name: '@geewiki/echo', enabled: true })
  assert.equal(dataOf(r)['error'], 'no_manager')
  assert.match(r.content, /管理器服务不可用/)
  await h.dispose()
})

/* ============================== 只读工具 ============================== */

test('plugin.list：给出包名/状态/层/依赖，并提醒 base 层的限制', async () => {
  const h = await mount()
  const r = await call(h.byName('plugin.list'), {})
  const parsed = JSON.parse(r.content) as { total: number; plugins: readonly { name: string }[]; note: string }
  assert.equal(parsed.total, 2)
  assert.match(parsed.note, /base/)
  await h.dispose()
})

test('plugin.read_config：密钥只报有无、绝不返回原值', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/llm', state: 'active', layer: 'base' }] })
  const r = await call(h.byName('plugin.read_config'), { name: '@geewiki/llm' })
  const parsed = JSON.parse(r.content) as {
    secrets: Record<string, boolean>
    config: Record<string, unknown>
    note: string
  }
  assert.deepEqual(parsed.secrets, {})
  // 结果里绝不能出现任何密钥形态的字段值
  assert.doesNotMatch(r.content, /sk-/)
  assert.match(parsed.note, /完整/)
  await h.dispose()
})

test('plugin.read_config：缺 name 时拒绝', async () => {
  const h = await mount()
  const r = await call(h.byName('plugin.read_config'), {})
  assert.equal(dataOf(r)['error'], 'invalid_arguments')
  await h.dispose()
})

/* ============================== 回退执行体与探针 ============================== */

test('★ 回退执行体：按 before 把插件变回去（停用过的重新启用）', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/echo', state: 'active', layer: 'session' }] })
  const undo = h.journal.undoers.get(`${manifest.name}:plugin`)
  assert.ok(undo !== undefined, '撤销执行体必须按 (owner, domain) 注册')
  const record = {
    id: 1,
    at: '2026-01-01T00:00:00.000Z',
    undoneAt: null,
    conversationId: 'c1',
    turnId: 't1',
    owner: manifest.name,
    tool: 'plugin.set_enabled',
    domain: 'plugin',
    target: '@geewiki/echo',
    before: JSON.stringify({ kind: 'enabled', value: true }),
    after: JSON.stringify({ kind: 'enabled', value: false }),
  }
  const outcome = (await undo(record as never, OWNER)) as { ok: boolean; detail: string }
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.mgr.calls, ['enable:@geewiki/echo'])
  await h.dispose()
})

test('★ 回退执行体也过自锁：历史记录不能成为绕过当前红线的通行证', async () => {
  /*
   * 这条不是对称美学。名单会扩容（`@geewiki/ai-admin` 就是 P5 才加进去的第五个），
   * 于是数据库里可能存在一条**在它进名单之前**写下的"停用 ai-admin"记录。
   * 那条记录若能被回退执行体照做，护栏就被一条历史数据绕过了。
   */
  const h = await mount({ rows: [{ name: '@geewiki/ai-admin', state: 'inactive', layer: null }] })
  const undo = h.journal.undoers.get(`${manifest.name}:plugin`)!
  const outcome = (await undo(
    {
      id: 1,
      at: '2026-01-01T00:00:00.000Z',
      undoneAt: null,
      conversationId: 'c1',
      turnId: 't1',
      owner: manifest.name,
      tool: 'plugin.set_enabled',
      domain: 'plugin',
      target: '@geewiki/ai-admin',
      before: JSON.stringify({ kind: 'enabled', value: true }),
      after: JSON.stringify({ kind: 'enabled', value: false }),
    } as never,
    OWNER,
  )) as { ok: boolean; detail: string }
  assert.equal(outcome.ok, false)
  assert.match(outcome.detail, /自锁|依赖链|纠错/)
  assert.deepEqual(h.mgr.calls, [])
  await h.dispose()
})

test('★ 回退执行体：非管理员拒绝（能回退的前提是"他现在有写权限"，不是"他曾经有"）', async () => {
  const h = await mount()
  const undo = h.journal.undoers.get(`${manifest.name}:plugin`)!
  const outcome = (await undo({ target: '@geewiki/echo', before: '{}' } as never, MEMBER)) as { ok: boolean }
  assert.equal(outcome.ok, false)
  assert.deepEqual(h.mgr.calls, [])
  await h.dispose()
})

test('★ 探针与写入用**同一个**编码（否则冲突检测会恒报冲突，"总是拒绝回退"和"从不检查"一样糟）', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/echo', state: 'inactive', layer: null }] })
  const probe = h.journal.probes.get(`${manifest.name}:plugin`)!
  const after = JSON.stringify({ kind: 'enabled', value: false })
  const out = (await probe(
    { target: '@geewiki/echo', after, before: JSON.stringify({ kind: 'enabled', value: true }) } as never,
    OWNER,
  )) as { value?: string }
  assert.equal(out.value, after, '没人动过 ⇒ 探针的值必须与 after 逐字相同')
  await h.dispose()
})

test('探针：别人改过之后返回值与 after 不同（回退据此拒绝那一条）', async () => {
  const h = await mount({ rows: [{ name: '@geewiki/echo', state: 'active', layer: null }] })
  const probe = h.journal.probes.get(`${manifest.name}:plugin`)!
  const out = (await probe(
    { target: '@geewiki/echo', after: JSON.stringify({ kind: 'enabled', value: false }) } as never,
    OWNER,
  )) as { value?: string }
  assert.equal(out.value, JSON.stringify({ kind: 'enabled', value: true }))
  await h.dispose()
})

test('探针：认不出的记录内容给一个**可读的原因**，而不是静默返回 null', async () => {
  const h = await mount()
  const probe = h.journal.probes.get(`${manifest.name}:plugin`)!
  const out = (await probe({ target: '@geewiki/echo', after: '不是 JSON' } as never, OWNER)) as { reason?: string }
  assert.match(String(out.reason), /认不出来/)
  await h.dispose()
})

test('探针：目标已从注册表消失时给出原因（无法确认 ⇒ 按冲突处理）', async () => {
  const h = await mount()
  const probe = h.journal.probes.get(`${manifest.name}:plugin`)!
  const out = (await probe(
    { target: '@geewiki/gone', after: JSON.stringify({ kind: 'enabled', value: false }) } as never,
    OWNER,
  )) as { reason?: string }
  assert.match(String(out.reason), /不在插件注册表/)
  await h.dispose()
})

/* ============================== manifest ============================== */

test('manifest：纯贡献者（不 provide 服务、无 slots、无 client、无 migrations）', () => {
  const meta = (manifest as unknown as { geewiki: GeeWikiManifest['geewiki'] }).geewiki
  assert.equal(meta.provides, undefined)
  assert.equal(meta.slots, undefined)
  assert.equal(meta.client, undefined)
  assert.equal(meta.migrations, undefined)
  assert.deepEqual(meta.requires, ['ai-tool-service', 'ai-journal-service'])
})
