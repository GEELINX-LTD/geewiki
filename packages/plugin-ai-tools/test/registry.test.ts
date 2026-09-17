/**
 * `AiToolRegistry` 的行为测试。
 *
 * 这里**不碰 cordis、不碰 HTTP、不碰数据库**——注册表是纯数据结构，全部行为都能直接断言。
 * 服务是否真的被 `provide` 出去由 `plugin.test.ts` 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Principal } from '@geewiki/core'
import { AiToolRegistry, TOOL_DESCRIPTION_BUDGET, type AiToolContribution } from '../src/index.js'

const MEMBER: Principal = {
  kind: 'user',
  userId: 7,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

const ADMIN: Principal = { ...MEMBER, orgRole: 'admin' }

function tool(name: string, extra: Partial<AiToolContribution['descriptor']> = {}): AiToolContribution {
  return {
    descriptor: { name, description: `工具 ${name}`, parameters: { type: 'object', properties: {} }, side: 'server', ...extra },
    execute: async () => ({ content: `${name} 的结果` }),
  }
}

test('contribute 后可 list，且带回 owner 与 execute', () => {
  const reg = new AiToolRegistry()
  const t = tool('kb.search')
  reg.contribute('@geewiki/ai-kb', t)
  const list = reg.list(MEMBER)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.owner, '@geewiki/ai-kb')
  assert.equal(list[0]?.descriptor.name, 'kb.search')
  assert.equal(list[0]?.execute, t.execute)
})

test('重复工具名抛错，且表保持原样（不留下半条记录）', () => {
  const reg = new AiToolRegistry()
  reg.contribute('a', tool('kb.search'))
  assert.throws(
    () => reg.contribute('b', tool('kb.search')),
    /工具名 kb\.search 已被 a 占用/,
  )
  // 关键：先校验后写入。失败的那次贡献不得改变任何既有记录。
  assert.equal(reg.list(MEMBER).length, 1)
  assert.equal(reg.ownerOf('kb.search'), 'a')
  assert.equal(reg.list(MEMBER)[0]?.owner, 'a')
})

test('release(owner) 只回收该 owner 的工具，不误伤同名子串的 owner', () => {
  const reg = new AiToolRegistry()
  reg.contribute('@geewiki/ai-kb', tool('kb.search'))
  reg.contribute('@geewiki/ai-kb-extra', tool('kb.extra'))
  reg.contribute('@geewiki/ai-summary', tool('summary.get'))

  reg.release('@geewiki/ai-kb')

  assert.deepEqual(
    reg.list(MEMBER).map((t) => t.descriptor.name),
    ['kb.extra', 'summary.get'],
  )
})

test('contribute 返回的注销函数是幂等的，且不误删"已换主人"的同名工具', () => {
  const reg = new AiToolRegistry()
  const dispose = reg.contribute('a', tool('kb.search'))
  dispose()
  dispose() // 再调一次不得抛错、不得改变任何东西
  assert.equal(reg.list(MEMBER).length, 0)

  // 同名工具被另一个 owner 重新注册后，迟到的 disposer 不该把新主人的删掉
  const reg2 = new AiToolRegistry()
  const d2 = reg2.contribute('a', tool('kb.search'))
  reg2.release('a')
  reg2.contribute('b', tool('kb.search'))
  d2()
  assert.equal(reg2.ownerOf('kb.search'), 'b')
})

test('list(principal) 按 available 过滤——无权使用的工具不进工具表', () => {
  const reg = new AiToolRegistry()
  reg.contribute('kb', tool('kb.search'))
  reg.contribute(
    'admin',
    tool('admin.disable_plugin', { available: (p) => p.orgRole === 'admin' || p.orgRole === 'owner' }),
  )
  reg.contribute('nav', tool('nav.open_page', { available: () => false }))

  assert.deepEqual(
    reg.list(MEMBER).map((t) => t.descriptor.name),
    ['kb.search'],
  )
  assert.deepEqual(
    reg.list(ADMIN).map((t) => t.descriptor.name),
    ['admin.disable_plugin', 'kb.search'],
  )
})

test('排序是确定性的：owner 字典序 → 工具名字典序，与注册顺序无关', () => {
  const forward = new AiToolRegistry()
  forward.contribute('@geewiki/ai-kb', tool('kb.search'))
  forward.contribute('@geewiki/ai-kb', tool('kb.list_pages'))
  forward.contribute('@geewiki/ai-summary', tool('summary.get'))

  const backward = new AiToolRegistry()
  backward.contribute('@geewiki/ai-summary', tool('summary.get'))
  backward.contribute('@geewiki/ai-kb', tool('kb.list_pages'))
  backward.contribute('@geewiki/ai-kb', tool('kb.search'))

  const names = (r: AiToolRegistry): string[] => r.list(MEMBER).map((t) => t.descriptor.name)
  assert.deepEqual(names(forward), ['kb.list_pages', 'kb.search', 'summary.get'])
  // 两次注册顺序不同，工具表必须逐项一致——否则每轮请求前缀都变，上游缓存全失效。
  assert.deepEqual(names(backward), names(forward))
})

test('注册表自身的校验：名字/描述/参数/侧，各给一条明确的错误', () => {
  const reg = new AiToolRegistry()
  const bad = (t: AiToolContribution, re: RegExp): void => {
    assert.throws(() => reg.contribute('x', t), re)
  }

  bad(
    { ...tool('ok'), descriptor: { ...tool('ok').descriptor, name: '2bad name' } },
    /工具名 "2bad name" 非法/,
  )
  bad(
    { ...tool('ok'), descriptor: { ...tool('ok').descriptor, description: '' } },
    /缺少 description/,
  )
  bad(
    { ...tool('ok'), descriptor: { ...tool('ok').descriptor, parameters: { properties: {} } } },
    /parameters 必须是 \{ type: 'object'/,
  )
  bad(
    { ...tool('ok'), descriptor: { ...tool('ok').descriptor, side: 'browser' as 'server' } },
    /side 必须是 'server' 或 'client'/,
  )
  bad({ ...tool('ok'), execute: undefined as unknown as AiToolContribution['execute'] }, /缺少 execute/)
  assert.throws(() => reg.contribute('', tool('ok')), /owner 必须是非空字符串/)

  // 全部被拒 ⇒ 表仍然是空的
  assert.equal(reg.diagnostics().count, 0)
})

test('diagnostics 报出工具数、描述膨胀与写类名单（超预算不抛错，只登记）', () => {
  const reg = new AiToolRegistry()
  reg.contribute('kb', tool('kb.search'))
  reg.contribute('admin', tool('admin.write', { description: 'x'.repeat(TOOL_DESCRIPTION_BUDGET + 1), mutating: true }))

  const d = reg.diagnostics()
  assert.equal(d.count, 2)
  assert.deepEqual(d.overBudget, [{ owner: 'admin', name: 'admin.write', length: TOOL_DESCRIPTION_BUDGET + 1 }])
  assert.deepEqual(d.mutating, ['admin.write'])
})

test('描述超预算不阻断贡献（一条写得长的描述不该让整个工具表下线）', () => {
  const reg = new AiToolRegistry()
  const long = 'y'.repeat(TOOL_DESCRIPTION_BUDGET + 50)
  reg.contribute('kb', tool('kb.search', { description: long }))
  assert.equal(reg.list(MEMBER).length, 1)
  assert.equal(reg.list(MEMBER)[0]?.descriptor.description, long)
})

test('releaseAll 清空整张表（插件 teardown 用）', () => {
  const reg = new AiToolRegistry()
  reg.contribute('a', tool('a.one'))
  reg.contribute('b', tool('b.two'))
  reg.releaseAll()
  assert.equal(reg.diagnostics().count, 0)
  assert.equal(reg.ownerOf('a.one'), undefined)
})
