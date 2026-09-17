/**
 * `@geewiki/ai-tools` 作为 **cordis 插件**的行为：服务真的被 provide 出去了吗？
 *
 * 注册表自身的逻辑由 `registry.test.ts` 覆盖；这里只回答"接线对不对"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  AI_TOOL_SERVICE_NAME,
  AiToolRegistry,
  AiToolsPlugin,
  manifest,
  type AiToolService,
} from '../src/index.js'

test('manifest 声明 provides: ai-tool-service（依赖图靠它解析，改错则消费者拿不到服务）', () => {
  assert.equal(manifest.name, '@geewiki/ai-tools')
  assert.equal(manifest.geewiki.provides, AI_TOOL_SERVICE_NAME)
  // 无依赖：它是依赖图的根之一，必须能被最先激活的那批插件接纳
  assert.equal(manifest.geewiki.requires, undefined)
  // 它**不贡献任何插槽**，也不带前端产物——纯注册表
  assert.equal(manifest.geewiki.slots, undefined)
  assert.equal(manifest.geewiki.client, undefined)
})

test('apply 之后服务可经 ctx.get 取到，且就是注入的那个注册表实例', async () => {
  const app = new Context()
  const registry = new AiToolRegistry()
  const fork = await app.plugin(AiToolsPlugin, { registry })

  assert.equal(app.get(AI_TOOL_SERVICE_NAME), registry)
  await fork.dispose()
})

test('后装载的插件能拿到服务（提供者的 apply 已结算——这正是它必须独立成插件的原因）', async () => {
  const app = new Context()
  await app.plugin(AiToolsPlugin)

  let seen: unknown
  const consumer = {
    name: 'test-consumer',
    apply(ctx: Context) {
      seen = ctx.get(AI_TOOL_SERVICE_NAME)
    },
  }
  await app.plugin(consumer)

  assert.ok(seen instanceof AiToolRegistry, '后装载的插件应拿到同一个注册表实例')
})

test('dispose 先撤销服务、再清空注册表——两者都不能剩', async () => {
  const app = new Context()
  const registry = new AiToolRegistry()
  const fork = await app.plugin(AiToolsPlugin, { registry })
  registry.contribute('some-plugin', {
    descriptor: {
      name: 'kb.search',
      description: '检索',
      parameters: { type: 'object', properties: {} },
      side: 'server',
    },
    execute: async () => ({ content: 'x' }),
  })
  assert.equal(registry.diagnostics().count, 1)

  await fork.dispose()

  // 顺序判据：服务必须先消失。若只清表而不撤销服务，在途调用会拿到**空工具表**，
  // 而在会话核心那边"空工具表"的含义是"这个 AI 什么都不会做"——一个看起来正常的错误结果。
  assert.equal(app.get(AI_TOOL_SERVICE_NAME), undefined)
  assert.equal(registry.diagnostics().count, 0)
})

test('服务契约经 ctx.get 取出后形状完整（list/contribute/release/ownerOf/diagnostics 都在）', async () => {
  const app = new Context()
  const fork = await app.plugin(AiToolsPlugin)
  const svc = app.get(AI_TOOL_SERVICE_NAME) as AiToolService

  for (const method of ['contribute', 'list', 'ownerOf', 'release', 'diagnostics'] as const) {
    assert.equal(typeof svc[method], 'function', `AiToolService 缺 ${method}`)
  }
  // 空表也要能正常回答（不是抛错、不是 undefined）
  assert.deepEqual(svc.diagnostics(), { count: 0, overBudget: [], mutating: [] })
  await fork.dispose()
})
