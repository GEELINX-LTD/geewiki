/**
 * 工具表的**收窄**（安全红线：客户端上报的能力只能收窄，绝不能扩权）。
 *
 * 这一组用例的价值全在"负例"上：正例（服务端工具照常进表）几乎不可能写错，
 * 而"客户端声明了一个没注册的名字，它却进了表"是一类**不会报错**的错误——
 * 它表现为模型突然能调一个不该存在的东西，而没有任何一行日志异样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Principal } from '@geewiki/core'
import type { AiToolService, ResolvedTool } from '@geewiki/ai-tools'
import { resolveTurnTools } from '../src/tools.js'

const principal: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

function tool(name: string, side: 'server' | 'client', owner = 'owner-a'): ResolvedTool {
  return {
    owner,
    descriptor: { name, description: `${name} 的说明`, parameters: { type: 'object' }, side },
    execute: async () => ({ content: '{}' }),
  }
}

/** 只实现 `list` 的最小替身：本函数只用这一个方法 */
function service(tools: readonly ResolvedTool[]): AiToolService {
  return { list: () => tools } as unknown as AiToolService
}

test('resolveTurnTools：服务端工具无条件进表（客户端不必声明它们）', () => {
  const table = resolveTurnTools(service([tool('search_kb', 'server'), tool('read_page', 'server')]), principal, [])
  assert.deepEqual(table.names, ['search_kb', 'read_page'])
})

test('resolveTurnTools：客户端工具**没被声明就不进表**（模型不会去调一个没人能执行的工具）', () => {
  const table = resolveTurnTools(service([tool('editor.replace', 'client')]), principal, [])
  assert.deepEqual(table.names, [])
  assert.deepEqual(table.clientToolsAccepted, [])
})

test('resolveTurnTools：客户端工具被声明后进表，并被记录为"已采纳"', () => {
  const table = resolveTurnTools(service([tool('editor.replace', 'client')]), principal, ['editor.replace'])
  assert.deepEqual(table.names, ['editor.replace'])
  assert.deepEqual(table.clientToolsAccepted, ['editor.replace'])
})

test('★ 红线：声明一个**没注册**的名字，不会让它进表（交集之外一律不认）', () => {
  const table = resolveTurnTools(service([tool('search_kb', 'server')]), principal, [
    'editor.replace', // 没注册
    'wiki.delete_everything', // 没注册
    'search_kb', // 注册了，但它是 server 侧 —— 声明它不产生任何额外效果
  ])
  assert.deepEqual(table.names, ['search_kb'])
  assert.deepEqual(table.clientToolsAccepted, [], '只有 side=client 且被声明的才算"采纳"')
})

test('★ 红线：声明的名字大小写/前缀不同也不算命中（不做任何模糊匹配）', () => {
  const table = resolveTurnTools(service([tool('search_kb', 'client')]), principal, [
    'SEARCH_KB',
    'search_kb ',
    ' search_kb',
    '@geewiki/ai-kb.search_kb',
  ])
  assert.deepEqual(table.names, [], '名字是模型的唯一凭据，模糊匹配会让"想调的那个"没有确定答案')
})

test('resolveTurnTools：工具总线缺席时返回空表而不是抛错（会话核心退化成普通聊天）', () => {
  const table = resolveTurnTools(undefined, principal, ['editor.replace'])
  assert.deepEqual(table.names, [])
  assert.deepEqual(table.clientToolsAccepted, [])
})

test('resolveTurnTools：顺序**原样**来自注册表（不能在这里重排，否则前缀缓存会失效）', () => {
  const table = resolveTurnTools(
    service([tool('b', 'server'), tool('a-client', 'client'), tool('a', 'server')]),
    principal,
    ['a-client'],
  )
  assert.deepEqual(table.names, ['b', 'a-client', 'a'])
})

test('resolveTurnTools：list() 收到的就是传入的那个主体对象（不在这一层伪造主体）', () => {
  let seen: Principal | undefined
  const svc = {
    list: (p: Principal) => {
      seen = p
      return []
    },
  } as unknown as AiToolService
  resolveTurnTools(svc, principal, [])
  assert.equal(seen, principal)
})

test('resolveTurnTools：offered 与 names 一一对应（同一份事实不做两次过滤）', () => {
  const tools = [tool('x', 'server'), tool('y', 'client')]
  const table = resolveTurnTools(service(tools), principal, ['y'])
  assert.deepEqual(
    table.offered.map((t) => t.descriptor.name),
    [...table.names],
  )
})
