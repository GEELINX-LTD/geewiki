/**
 * `@geewiki/ai-writing` 的工具贡献测试。
 *
 * **测试策略**：真实的 `AiToolRegistry` + 真实的 cordis `Context`（与 `@geewiki/ai-kb`
 * 同一套夹具形态），因为本插件的行为全部落在"往总线上贡献了什么"上。
 *
 * 这里最要紧的两条不是"贡献了四条"，而是：
 * 1. **`side: 'client'` 的工具在服务端执行必须抛错**——如果它悄悄返回一个字符串，
 *    模型会以为编辑框被改了，而实际上什么都没发生（本仓反复记档的那类
 *    "看起来正常、其实错位"的缺陷）；
 * 2. **参数 schema 必须能让模型填对**（`insert_text` / `replace_selection` 的 `text`
 *    是 required）——漏了 required，模型会不带参数地调用，然后在浏览器侧得到一条
 *    "参数 text 必须是字符串"的报错，而那本是可以在工具表里避免的一次往返。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { FiberLike, Principal } from '@geewiki/core'
import { AiToolRegistry, AiToolsPlugin } from '@geewiki/ai-tools'
import { AiWritingPlugin, EDITOR_TOOL_NAMES, manifest } from '../src/index.js'

const MEMBER: Principal = {
  kind: 'user',
  userId: 7,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}

/**
 * 起一个真实的插件上下文（工具总线在前，本插件在后——顺序与生产一致）。
 *
 * **卸载走 `fork.dispose()` 而不是 `ctx.dispose()`**：`Context` 上没有 `dispose` 这个方法，
 * 而且 `ctx.plugin()` 返回的是 thenable 的 `Fiber`（不是 `Promise`）——`assert.rejects`
 * 不认它，必须包一层 `async () => { await ctx.plugin(…) }`。
 * 这两条都是 `@geewiki/ai-kb` 的测试里已经踩过的，夹具形态直接照抄它。
 */
async function boot(): Promise<{ ctx: Context; registry: AiToolRegistry; dispose: () => Promise<void> }> {
  const registry = new AiToolRegistry()
  const ctx = new Context()
  await ctx.plugin(AiToolsPlugin, { registry })
  const fork = (await ctx.plugin(AiWritingPlugin)) as unknown as FiberLike
  return {
    ctx,
    registry,
    dispose: async () => {
      await fork.dispose()
    },
  }
}

test('贡献四条工具，名字与声明一致', async () => {
  const { registry, dispose } = await boot()
  const names = registry.list(MEMBER).map((t) => t.descriptor.name)
  assert.deepEqual(names, [...EDITOR_TOOL_NAMES])
  await dispose()
})

test('四条全部是 side:client —— 它们在浏览器里跑，服务端没有执行体', async () => {
  const { registry, dispose } = await boot()
  for (const tool of registry.list(MEMBER)) {
    assert.equal(tool.descriptor.side, 'client', `${tool.descriptor.name} 必须是客户端工具`)
  }
  await dispose()
})

test('两条写工具标了 mutating，两条读工具没有', async () => {
  const { registry, dispose } = await boot()
  const mutating = registry.list(MEMBER).filter((t) => t.descriptor.mutating === true)
  assert.deepEqual(
    mutating.map((t) => t.descriptor.name).sort(),
    ['editor.insert_text', 'editor.replace_selection'],
    '写工具必须标 mutating：自锁护栏与回退 UI 都看这份名单',
  )
  await dispose()
})

/*
 * 服务端**执行**客户端工具是代码错，不是用户输入错。这里钉住它抛错而不是返回一句
 * "未实现"——后者会被当成成功的工具结果回灌进模型上下文。
 */
test('在服务端执行客户端工具会抛错，不谎报成功', async () => {
  const { registry, dispose } = await boot()
  const tool = registry.list(MEMBER).find((t) => t.descriptor.name === 'editor.insert_text')
  assert.ok(tool)
  await assert.rejects(
    // 第三参是轮次上下文（P4 新增）；本用例只关心"服务端执行客户端工具必须抛错"
    async () => tool.execute(MEMBER, { text: 'x' }, { conversationId: 'c', turnId: 't' }),
    /执行体在浏览器/,
  )
  await dispose()
})

test('写工具的 text 是 required，且禁止额外字段', async () => {
  const { registry, dispose } = await boot()
  for (const name of ['editor.insert_text', 'editor.replace_selection']) {
    const tool = registry.list(MEMBER).find((t) => t.descriptor.name === name)
    assert.ok(tool)
    const params = tool.descriptor.parameters as {
      type: string
      required?: string[]
      additionalProperties?: boolean
    }
    assert.equal(params.type, 'object', 'OpenAI 工具协议要求 parameters 是 object')
    assert.deepEqual(params.required, ['text'], `${name} 的 text 必须是 required`)
    assert.equal(params.additionalProperties, false)
  }
  await dispose()
})

/*
 * 描述符进的是**模型的注意力预算**（`TOOL_DESCRIPTION_BUDGET = 200`，超了只告警不抛错）。
 * 这里不当硬门禁，只钉住"超预算的条数不能悄悄变多"——真超了应当在诊断里看得见。
 */
test('描述文本不超注意力预算（超了要能在诊断里看见，而不是无声膨胀）', async () => {
  const { registry, dispose } = await boot()
  const over = registry.diagnostics().overBudget
  assert.deepEqual(over.map((e) => e.name), [], `以下工具的描述超过了 200 字符预算：${JSON.stringify(over)}`)
  await dispose()
})

test('每个工具都必须能回答"什么时候该调用我"——描述里点出与 search_kb 的分工', async () => {
  const { registry, dispose } = await boot()
  const readDoc = registry.list(MEMBER).find((t) => t.descriptor.name === 'editor.read_doc')
  assert.ok(readDoc)
  assert.match(
    readDoc.descriptor.description,
    /search_kb/,
    '不写清"草稿不在知识库里"，模型会去检索知识库然后回"没找到"',
  )
  await dispose()
})

test('卸载时按 owner 回收全部四条，不留指向已卸载插件的工具', async () => {
  const { registry, dispose } = await boot()
  assert.equal(registry.list(MEMBER).length, 4)
  await dispose()
  assert.deepEqual(
    registry.list(MEMBER).map((t) => t.descriptor.name),
    [],
    '漏回收会留下一条被调用时去取已消失服务的工具',
  )
})

test('ai-tool-service 缺席时明确抛错，不做安静的空插件', async () => {
  const ctx = new Context()
  // ctx.plugin() 返回的是 thenable 的 Fiber（不是 Promise），assert.rejects 不认它
  await assert.rejects(
    async () => {
      await ctx.plugin(AiWritingPlugin)
    },
    /ai-tool-service 不可用/,
    '静默跳过会让"插件激活了但没贡献"与"它本来就没贡献"无法区分',
  )
})

test('manifest 不再声明任何插槽与前端产物（决策 18：旧 UI 已拆）', () => {
  assert.equal(manifest.geewiki?.slots, undefined)
  assert.equal(manifest.geewiki?.client, undefined)
  assert.equal(manifest.geewiki?.provides, undefined, '纯贡献者：不 provide 任何服务')
  assert.deepEqual(manifest.geewiki?.requires, ['ai-tool-service'])
})
