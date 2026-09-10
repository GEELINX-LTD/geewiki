/**
 * 插件装配测试：**用真实 cordis**（`Context` + `ctx.plugin()`），不用替身 ctx。
 *
 * 为什么：本批要证明的正是"跨插件的服务可见性与注销"——adapter 经 `ctx.get('llm-service')`
 * 拿注册表、并把自己的路由注册进去。替身 ctx 只能证明同 ctx 内的 get/provide，
 * 而真实生产路径是**两个插件各自跑在 ctx.plugin() 的子 fiber 里**（`@geewiki/wiki` 的
 * service 测试已确立这一范式：必须先 `await` 提供者，消费者才可见）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { LLM_SERVICE_KEY, createLlmService, type LlmService } from '@geewiki/llm'
import { OpenAiPlugin, manifest } from '../src/index.js'

/** 装配：真实 cordis + 真实 llm-service（不注册任何 provider） */
async function setup(): Promise<{ root: Context; service: LlmService }> {
  const root = new Context()
  const service = createLlmService()
  root.provide(LLM_SERVICE_KEY, service)
  return { root, service }
}

test('manifest：按服务 token 依赖 llm-service，进 llm-provider 冲突组，不声明 provides', () => {
  assert.deepEqual(manifest.geewiki.requires, ['llm-service'], '必须按**服务标识**依赖（不是插件名）')
  assert.equal(manifest.geewiki.conflictGroup, 'llm-provider', '与其它 provider 同组互斥')
  assert.equal(manifest.geewiki.provides, undefined, '叶子插件：只注册路由，不对外提供新服务')
  assert.equal(manifest.geewiki.runtime?.supportsHotReload, true)
})

test('apply 把路由注册进 llm-service；dispose 后注销', async () => {
  const { root, service } = await setup()
  const fork = root.plugin(OpenAiPlugin, { route: 'openai-a', apiKeyEnv: 'GEEWIKI_TEST_PLUGIN_KEY' })
  await fork

  assert.deepEqual(
    service.listProviders().map((d) => d.route),
    ['openai-a'],
    'apply 后注册表应含该路由',
  )

  await fork.dispose()
  assert.deepEqual(service.listProviders(), [], 'dispose 后应注销（否则热重载会撞"重复 route"）')
})

test('热重载语义：注销后可再次注册同一路由（否则第二次启用必然失败）', async () => {
  const { root, service } = await setup()
  const first = root.plugin(OpenAiPlugin, { route: 'openai-reload' })
  await first
  await first.dispose()
  const second = root.plugin(OpenAiPlugin, { route: 'openai-reload' })
  await second
  assert.deepEqual(service.listProviders().map((d) => d.route), ['openai-reload'])
  await second.dispose()
})

test('重复 route 注册被拒绝（不得静默覆盖别人）', async () => {
  const { root, service } = await setup()
  const first = root.plugin(OpenAiPlugin, { route: 'dup' })
  await first
  const second = root.plugin(OpenAiPlugin, { route: 'dup' })
  await assert.rejects(
    async () => {
      await second
    },
    /已被注册/,
    '同组两个 adapter 抢同一路由名必须显式失败',
  )
  // 先来的仍完好
  assert.deepEqual(service.listProviders().map((d) => d.route), ['dup'])
  await first.dispose()
})

test('缺少 llm-service 时 apply 显式报错（不静默 no-op）', async () => {
  // 静默 no-op 会让"插件显示已激活但问答永远降级"成为要读源码才能定位的问题
  const root = new Context()
  const fork = root.plugin(OpenAiPlugin, { route: 'no-service' })
  await assert.rejects(
    async () => {
      await fork
    },
    /llm-service 不可用/,
  )
})

test('配置里填密钥值本身 → 拒绝激活并指出去处', async () => {
  const { root } = await setup()
  const fork = root.plugin(OpenAiPlugin, { route: 'leak', apiKeyEnv: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV' })
  // 拒绝发生在 **schema 层**（cordis 的 resolveConfig → validateConfig），因为它覆盖了
  // 激活与热更新两条路径，比 apply 层更早也更全。apply 层的第二道闸门见
  // credential-guard.test.ts（那里直接调 apply 覆盖"绕过 schema 的程序化装配"）。
  await assert.rejects(
    async () => {
      await fork
    },
    /match regexp|看起来是\*\*密钥值本身\*\*而不是环境变量名/,
    '密钥形态的值必须被拒绝激活（schemastery 的 pattern 报 match regexp，apply 层报中文说明）',
  )
})

test('缺 key 不算激活失败：插件正常装载，仅 available() 为 false 且流产出 MISSING_CREDENTIAL', async () => {
  const { root, service } = await setup()
  const fork = root.plugin(OpenAiPlugin, { route: 'no-key', apiKeyEnv: 'GEEWIKI_TEST_DEFINITELY_UNSET' })
  await fork // 不抛错：缺凭据是"降级"而不是"装配失败"

  const descriptor = service.listProviders().find((d) => d.route === 'no-key')
  assert.ok(descriptor)
  assert.equal(descriptor.available(), false)
  assert.deepEqual(service.availableProviders(), [], '不可用路由不参与自动选路')

  const chunks = []
  for await (const chunk of service.stream({ route: 'no-key', messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [{ type: 'error', code: 'MISSING_CREDENTIAL' }])
  await fork.dispose()
})

test('默认配置：schema 填出默认值，路由名为 openai、凭据变量名为 OPENAI_API_KEY', async () => {
  const { root, service } = await setup()
  const fork = root.plugin(OpenAiPlugin, {})
  await fork
  const descriptor = service.listProviders()[0]
  assert.equal(descriptor?.route, 'openai', 'schemastery 默认值应被填充')
  assert.equal(descriptor?.apiKeyEnv, 'OPENAI_API_KEY')
  assert.equal(descriptor?.vendor, 'openai')
  await fork.dispose()
})
