/**
 * 插件装配测试：**用真实 cordis**（`Context` + `ctx.plugin()`），不用替身 ctx。
 *
 * 为什么：本批要证明的正是"跨插件的服务可见性与注销"——adapter 经 `ctx.get('llm-service')`
 * 拿注册表、并把自己的路由注册进去。替身 ctx 只能证明同 ctx 内的 get/provide，
 * 而真实生产路径是**两个插件各自跑在 ctx.plugin() 的子 fiber 里**（`@geewiki/wiki` 的
 * service 测试已确立这一范式：必须先 `await` 提供者，消费者才可见）。
 *
 * 本批的口径变化（见 `../src/index.ts` 的文件头）：
 * - 适配器**没有自己的配置**（`configSchema` 是零字段 schema），端点/密钥/模型
 *   全部来自 `@geewiki/llm` 的统一配置；
 * - 路由名是**固定的** `openai`（不再从配置里取）——它是"服务商 id"，
 *   统一配置的 `provider` 字段按它选中本适配器；
 * - 因此**撤掉了 `conflictGroup`**：多个适配器并存是正常需求（在 OpenAI 与自建网关间切换）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  LLM_SERVICE_KEY,
  LlmPlugin,
  createApiKeyResolver,
  createLlmService,
  deriveSettings,
  type LlmService,
} from '@geewiki/llm'
import { OPENAI_ROUTE, OpenAiConfigSchema, OpenAiPlugin, manifest } from '../src/index.js'

/**
 * 装配：真实 cordis + 真实 llm-service（**接上统一配置**，与生产装配同形）。
 *
 * 不接统一配置的裸 `createLlmService()` 只是一条兼容路径（测试/程序化装配），
 * 用它来测本插件会漏掉"设置与密钥从哪里来"这一层。
 */
async function setup(config: Record<string, unknown> = {}): Promise<{ root: Context; service: LlmService }> {
  const root = new Context()
  const settings = deriveSettings(config)
  const apiKey = createApiKeyResolver(config)
  const service = createLlmService({
    settings: () => settings,
    resolveApiKey: apiKey.resolve,
    credentialSource: apiKey.source,
  })
  root.provide(LLM_SERVICE_KEY, service)
  return { root, service }
}

test('manifest：按服务 token 依赖 llm-service，不声明 provides，也不再进冲突组', () => {
  assert.deepEqual(manifest.geewiki.requires, ['llm-service'], '必须按**服务标识**依赖（不是插件名）')
  assert.equal(
    manifest.geewiki.conflictGroup,
    undefined,
    '适配器是并列的"可选服务商"（由统一配置的 provider 单选），并存不是冲突',
  )
  assert.equal(manifest.geewiki.provides, undefined, '叶子插件：只注册路由，不对外提供新服务')
  assert.equal(manifest.geewiki.runtime?.supportsHotReload, true)
  assert.ok(manifest.geewiki.configSchema, '零字段 schema 也要声明：否则管理台会退回"JSON 原文"编辑框')
})

test('配置 schema：零字段（本插件确实没有可配置项）', () => {
  const parsed = new OpenAiConfigSchema({}) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed), [], '不得有任何字段：配置一律在 @geewiki/llm')
})

test('apply 把固定路由 openai 注册进 llm-service；dispose 后注销', async () => {
  const { root, service } = await setup()
  const fork = root.plugin(OpenAiPlugin)
  await fork

  assert.deepEqual(
    service.listProviders().map((d) => d.route),
    [OPENAI_ROUTE],
    'apply 后注册表应含固定路由 openai',
  )
  assert.equal(service.listProviders()[0]?.vendor, 'openai')

  await fork.dispose()
  assert.deepEqual(service.listProviders(), [], 'dispose 后应注销（否则热重载会撞"重复 route"）')
})

test('热重载语义：注销后可再次注册同一路由（否则第二次启用必然失败）', async () => {
  const { root, service } = await setup()
  const first = root.plugin(OpenAiPlugin)
  await first
  await first.dispose()
  const second = root.plugin(OpenAiPlugin)
  await second
  assert.deepEqual(service.listProviders().map((d) => d.route), [OPENAI_ROUTE])
  await second.dispose()
})

test('重复装配被拒绝（不得静默覆盖别人）', async () => {
  const { root } = await setup()
  const first = root.plugin(OpenAiPlugin)
  await first
  const second = root.plugin(OpenAiPlugin)
  await assert.rejects(
    async () => {
      await second
    },
    /已被注册/,
  )
  await first.dispose()
})

test('缺少 llm-service 时 apply 显式报错（不静默 no-op）', async () => {
  // 静默 no-op 会让"插件显示已激活但问答永远降级"成为要读源码才能定位的问题
  const root = new Context()
  const fork = root.plugin(OpenAiPlugin)
  await assert.rejects(
    async () => {
      await fork
    },
    /llm-service 不可用/,
  )
})

test('缺密钥不算激活失败：插件正常装载，仅 available() 为 false 且流产出 MISSING_CREDENTIAL', async () => {
  const { root, service } = await setup({ model: 'test-model' })
  const fork = root.plugin(OpenAiPlugin)
  await fork // 不抛错：缺凭据是"降级"而不是"装配失败"

  const descriptor = service.listProviders().find((d) => d.route === OPENAI_ROUTE)
  assert.ok(descriptor)
  assert.equal(descriptor.available(), false)
  assert.deepEqual(service.availableProviders(), [], '不可用路由不参与自动选路')

  const chunks = []
  for await (const chunk of service.stream({ route: OPENAI_ROUTE, messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [{ type: 'error', code: 'MISSING_CREDENTIAL' }])
  await fork.dispose()
})

test('统一配置里的密钥让路由变为可用（无需环境变量、无需重启）', async () => {
  const { root, service } = await setup({ apiKey: 'sk-inline-test-value', model: 'test-model' })
  const fork = root.plugin(OpenAiPlugin)
  await fork
  assert.equal(service.listProviders()[0]?.available(), true, '界面填写的密钥应让路由可用')
  assert.equal(service.credentialSource(), 'inline', '密钥来源只报"来源"，不报值')
  await fork.dispose()
})

test('descriptor 现读统一配置：模型名随设置变化（管理台显示不得滞后），并带出适配器默认值', async () => {
  const { root, service } = await setup({ model: 'first-model', apiKey: 'sk-inline-test-value' })
  const fork = root.plugin(OpenAiPlugin)
  await fork
  assert.equal(service.listProviders()[0]?.model, 'first-model')
  assert.deepEqual(service.listProviders()[0]?.defaults, {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  })
  await fork.dispose()
})

test('未配置模型时 descriptor 回落适配器默认模型（用户不填也能看见"将用什么"）', async () => {
  const { root, service } = await setup({})
  const fork = root.plugin(OpenAiPlugin)
  await fork
  assert.equal(service.listProviders()[0]?.model, 'gpt-4o-mini')
  await fork.dispose()
})

/* ---------- 配置热更新（管理台"保存配置"走的路径）的回归 ---------- */

test('llm 配置热更新（fork.update）后适配器路由仍在，且读到的是新配置', async () => {
  // 这是一个**实测出来的真实缺陷**的回归：cordis 的 fork.update = dispose + 重新 apply。
  // 若 `@geewiki/llm` 每次 apply 都新建注册表，改一次模型配置就会把适配器的路由丢掉
  // （适配器插件不会被连带重启），表现为"插件都 active、服务商列表却空了"。
  // 修法见 packages/plugin-llm/src/state.ts（注册表每 ctx 单例，只就地更新设置引用）。
  const root = new Context()
  const llmFork = root.plugin(LlmPlugin, { provider: 'openai', apiKey: 'sk-first-key-value', model: 'first-model' })
  await llmFork
  const openaiFork = root.plugin(OpenAiPlugin)
  await openaiFork

  const before = root.get(LLM_SERVICE_KEY) as LlmService
  assert.deepEqual(
    before.listProviders().map((d) => d.route).sort(),
    ['null', OPENAI_ROUTE],
    '前置：兜底路由 + 适配器路由都在',
  )
  assert.equal(before.listProviders().find((d) => d.route === OPENAI_ROUTE)?.model, 'first-model')

  // 用户在「插件管理」里改了配置（走的正是 fork.update）
  if (!llmFork.update) throw new Error('前置：该 fiber 不支持热更新')
  await llmFork.update({ provider: 'openai', apiKey: 'sk-second-key-value', model: 'second-model' })

  const after = root.get(LLM_SERVICE_KEY) as LlmService
  assert.deepEqual(
    after.listProviders().map((d) => d.route).sort(),
    ['null', OPENAI_ROUTE],
    '热更新后适配器路由**必须仍在**（不得把注册表换掉）',
  )
  assert.equal(
    after.listProviders().find((d) => d.route === OPENAI_ROUTE)?.model,
    'second-model',
    '适配器现读到的是新配置（descriptor 不得滞后）',
  )
  assert.equal(after.listProviders().find((d) => d.route === OPENAI_ROUTE)?.available(), true, '新密钥生效')
  assert.equal(after.credentialSource(), 'inline')

  await openaiFork.dispose()
  await llmFork.dispose()
})

test('llm 插件卸载后注册表干净（兜底路由已注销），重新启用不撞"重复 route"', async () => {
  const root = new Context()
  const first = root.plugin(LlmPlugin, {})
  await first
  // 先抓住实例：卸载后服务已注销（`root.get` 变 undefined），要查"注册表是否干净"
  // 只能看这个仍然活着的对象
  const service = root.get(LLM_SERVICE_KEY) as LlmService
  const adapter = root.plugin(OpenAiPlugin)
  await adapter
  await adapter.dispose()
  await first.dispose()
  assert.equal(root.get(LLM_SERVICE_KEY), undefined, '卸载后服务应已注销')
  assert.deepEqual(service.listProviders(), [], '卸载后不得残留路由')

  const second = root.plugin(LlmPlugin, {})
  await second
  assert.deepEqual(
    (root.get(LLM_SERVICE_KEY) as LlmService).listProviders().map((d) => d.route),
    ['null'],
    '重新启用：兜底路由可再次注册',
  )
  await second.dispose()
})
