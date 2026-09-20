/**
 * 统一模型接入配置（"一处配置"）的解析测试。
 *
 * 这组用例守的是**用户只填一次**这件事的三条前提：
 * 1. 密钥字段是 `role: 'secret'`、服务商字段是 `role: 'llm-provider'`
 *    （前者决定"不回显"，后者决定"下拉来自运行期注册的适配器"）；
 * 2. 空串一律表示"用适配器默认值 / 不修改"，不在这一层写死任何厂商事实；
 * 3. 界面填写的密钥优先于环境变量（环境变量是兜底，不再是唯一入口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  LLM_PROVIDERS_PATH,
  LLM_SERVICE_KEY,
  LlmConfigSchema,
  LlmPlugin,
  REASONING_EFFORT_PRESETS,
  createApiKeyResolver,
  deriveSettings,
  normalizeReasoningEffort,
  parseExtraBody,
  parseProbeRequest,
  type LlmRouteDescriptor,
  type LlmService,
} from '../src/index.js'

/** 解析结果里实际出现的键（缺省字段被 schemastery 略去，不留 undefined 占位） */
function parsedKeysOf(parsed: unknown): string[] {
  return Object.keys((parsed ?? {}) as Record<string, unknown>)
}

/** schemastery 实例的字段表（与 `@geewiki/manager` 的 secretFieldNames 同一条路径） */
function dictOf(schema: unknown): Record<string, { meta?: { role?: string } }> {
  return (schema as { dict: Record<string, { meta?: { role?: string } }> }).dict
}

/* ------------------------------ schema 角色 ------------------------------ */

test('schema：apiKey 是 role=secret（写一次、不可回读），provider 是 role=llm-provider（动态下拉）', () => {
  const dict = dictOf(LlmConfigSchema)
  assert.equal(dict['apiKey']?.meta?.role, 'secret', '必须是 secret：否则密钥会明文回显在管理台')
  assert.equal(dict['provider']?.meta?.role, 'llm-provider', '必须是 llm-provider：选项来自运行期注册的适配器')
  assert.deepEqual(
    Object.keys(dict).slice(0, 8),
    ['provider', 'baseUrl', 'apiKey', 'model', 'supportsVision', 'reasoningEffort', 'contextWindow', 'maxOutputTokens'],
    '前 8 项就是"接上一个模型 + 声明它收不收图"的全部必要信息，顺序即填写顺序',
  )
  assert.equal(dict['model']?.meta?.role, 'llm-model', '模型名要能被表单渲染成「清单下拉 + 手填」组合框')
  assert.equal(dict['reasoningEffort']?.meta?.role, 'llm-effort', '思考强度给候选档位，但字段本身是自由文本')
})

test('schema：调优四项只是被折叠，键仍在顶层', () => {
  const dict = dictOf(LlmConfigSchema)
  assert.deepEqual(
    Object.keys(dict),
    [
      'provider',
      'baseUrl',
      'apiKey',
      'model',
      // 能力声明紧跟模型名：它是对**这个模型**的声明，换模型后就该重新确认
      'supportsVision',
      'reasoningEffort',
      'contextWindow',
      'maxOutputTokens',
      // 四项调优/兜底：键**必须留在顶层**。嵌进对象会让 cordis 把存量配置里的同名键裁掉，
      // 用户看到的症状是"密钥环境变量突然不生效了"——分组是渲染期的事，不该动数据形状。
      'timeoutMs',
      'includeUsage',
      'extraBody',
      'apiKeyEnv',
    ],
    '顺序即填写顺序：前 7 项是"接上一个模型"的全部必要信息，后 4 项折叠进高级选项',
  )
  const meta = dict as unknown as Record<string, { meta?: { collapse?: boolean; hidden?: boolean } }>
  for (const key of ['timeoutMs', 'includeUsage', 'extraBody', 'apiKeyEnv']) {
    assert.equal(meta[key]?.meta?.collapse, true, `${key} 必须带 collapse：管理台据此收进「高级选项」`)
    assert.notEqual(meta[key]?.meta?.hidden, true, `${key} 不能是 hidden：折叠区里还得能改`)
  }
  for (const key of ['provider', 'baseUrl', 'apiKey', 'model', 'reasoningEffort', 'contextWindow', 'maxOutputTokens']) {
    assert.equal(meta[key]?.meta?.collapse, undefined, `${key} 是主表单字段，不得被折起来`)
  }
})

test('schema：没有采样温度字段（温度以服务端为准，客户端不替它做决定）', () => {
  const dict = dictOf(LlmConfigSchema)
  assert.equal(dict['temperature'], undefined, '顶层不得有 temperature')
  assert.equal(parsedKeysOf(new LlmConfigSchema({})).includes('temperature'), false, '解析结果里也不该出现')
})

test('schema：默认值与字段语义（空串 = 用适配器默认值，不写死厂商事实）', () => {
  const parsed = new LlmConfigSchema({}) as Record<string, unknown>
  assert.equal(parsed['provider'], '', '默认不指定服务商（自动取第一个可用）')
  assert.equal(parsed['baseUrl'], '', '默认端点由适配器提供（换服务商不必改存量配置）')
  assert.equal(parsed['model'], '', '默认模型同上')
  assert.equal(parsed['apiKey'], '', '密钥默认空（写一次、不可回读）')
  assert.equal(parsed['reasoningEffort'], '', '默认不下发思考参数（解析期归一为 off）')
  assert.equal(parsed['contextWindow'], 128000)
  assert.equal(parsed['maxOutputTokens'], 4096)
  assert.equal(parsed['timeoutMs'], 60000)
  assert.equal(parsed['includeUsage'], true)
  assert.equal(parsed['extraBody'], '')
  assert.equal(parsed['apiKeyEnv'], '', '环境变量兜底默认关闭')
})

test('schema：apiKeyEnv 的白名单闸门原样有效（密钥形态必须被拒）', () => {
  assert.throws(
    () => new LlmConfigSchema({ apiKeyEnv: 'sk-abcdefghij1234567890' }),
    '折叠只是不显示，闸门一丝都不能松：这是阻止密钥落盘进库文件的主闸门',
  )
  assert.equal(new LlmConfigSchema({ apiKeyEnv: 'DEEPSEEK_API_KEY' })['apiKeyEnv'], 'DEEPSEEK_API_KEY')
})

test('思考强度：四档只是建议，任意自定义值都必须活着到请求里', () => {
  assert.deepEqual(REASONING_EFFORT_PRESETS, ['off', 'low', 'medium', 'high'], '下拉给的建议档位')
  assert.equal(normalizeReasoningEffort('minimal'), 'minimal', '网关私有档位原样保留')
  assert.equal(normalizeReasoningEffort(' Extra-High '), 'Extra-High', '只裁空白，不 lowercase（网关可能大小写敏感）')
  assert.equal(normalizeReasoningEffort('off'), 'off')
  assert.equal(normalizeReasoningEffort('OFF'), 'off', '大小写不敏感的只有 off 本身')
  assert.equal(normalizeReasoningEffort(''), 'off')
  assert.equal(normalizeReasoningEffort(undefined), 'off')
  assert.equal(normalizeReasoningEffort(42), 'off', '非字符串不得让配置带着怪值跑')
})

/* ------------------------------ extraBody ------------------------------ */

test('parseExtraBody：空串 = 无额外参数；合法对象被规范化为紧凑 JSON', () => {
  assert.deepEqual(parseExtraBody(''), { ok: true, value: '' })
  assert.deepEqual(parseExtraBody('   '), { ok: true, value: '' })
  const parsed = parseExtraBody('{ "thinking": { "type": "enabled" } }')
  assert.deepEqual(parsed, { ok: true, value: '{"thinking":{"type":"enabled"}}' }, '规范化让等值配置逐字节相等')
})

test('parseExtraBody：非法形态一律拒绝，且不回显原文（可能被误贴进密钥）', () => {
  for (const [label, value] of [
    ['不是 JSON', '{坏'],
    ['数组', '[1,2]'],
    ['标量', '"sk-should-not-be-echoed"'],
    ['null', 'null'],
  ] as const) {
    const res = parseExtraBody(value)
    assert.equal(res.ok, false, `${label} 必须被拒绝`)
    if (!res.ok) assert.equal(res.message.includes(value), false, `${label}：报错不得回显原文`)
  }
  const tooLong = parseExtraBody(`{"a":"${'x'.repeat(5000)}"}`)
  assert.equal(tooLong.ok, false, '超长必须被拒绝（配置里不该塞进一整篇文档）')
})

/* ------------------------------ deriveSettings ------------------------------ */

test('deriveSettings：补齐默认值、裁掉两侧空白、自定义思考强度原样保留', () => {
  const settings = deriveSettings({
    provider: '  openai ',
    baseUrl: ' https://api.deepseek.com/v1 ',
    model: ' deepseek-chat ',
    apiKeyEnv: ' DEEPSEEK_API_KEY ',
    reasoningEffort: 'minimal',
  })
  assert.equal(settings.provider, 'openai')
  assert.equal(settings.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(settings.model, 'deepseek-chat')
  assert.equal(settings.apiKeyEnv, 'DEEPSEEK_API_KEY', '改造前存进配置的顶层 apiKeyEnv 必须继续生效')
  assert.equal(settings.reasoningEffort, 'minimal')
  assert.equal(settings.contextWindow, 128000)
  assert.equal('temperature' in settings, false, '运行时设置里也不该有采样温度')
})

test('deriveSettings：四个调优项照常生效（它们只是折叠了，不是没了）', () => {
  const tuned = deriveSettings({
    timeoutMs: 9000,
    includeUsage: false,
    extraBody: '{ "b" : 2 }',
    apiKeyEnv: 'MY_KEY',
  })
  assert.equal(tuned.timeoutMs, 9000)
  assert.equal(tuned.includeUsage, false)
  assert.equal(tuned.extraBody, '{"b":2}', 'extraBody 规范化为紧凑 JSON')
  assert.equal(tuned.apiKeyEnv, 'MY_KEY')
})

test('parseProbeRequest：只认四个键，其余丢弃；非对象当空请求', () => {
  assert.deepEqual(
    parseProbeRequest({ provider: ' openai ', baseUrl: 'https://x.test/v1', apiKey: 'sk-x', model: 'm', evil: 1 }),
    { provider: 'openai', baseUrl: 'https://x.test/v1', apiKey: 'sk-x', model: 'm' },
    '探测值会被拿去打外部请求（带密钥），未声明的键绝不能透传',
  )
  assert.deepEqual(parseProbeRequest({ provider: '   ' }), {}, '纯空白 = 未提供（回落已保存配置）')
  for (const bad of [null, undefined, [], 'x', 42]) assert.deepEqual(parseProbeRequest(bad), {})
})

/* ------------------------------ 密钥解析顺序 ------------------------------ */

test('密钥解析：界面填写的密钥优先于环境变量；都没有 → MISSING_CREDENTIAL', () => {
  const name = 'GEEWIKI_TEST_SETTINGS_KEY'
  process.env[name] = 'sk-from-env'
  try {
    const both = createApiKeyResolver({ apiKey: 'sk-inline', apiKeyEnv: name })
    assert.deepEqual(both.resolve(), { ok: true, value: 'sk-inline' })
    assert.equal(both.source(), 'inline')

    const envOnly = createApiKeyResolver({ apiKey: '', apiKeyEnv: name })
    assert.deepEqual(envOnly.resolve(), { ok: true, value: 'sk-from-env' })
    assert.equal(envOnly.source(), 'env')

    const none = createApiKeyResolver({})
    assert.deepEqual(none.resolve(), { ok: false, code: 'MISSING_CREDENTIAL' })
    assert.equal(none.source(), 'none')

    const blank = createApiKeyResolver({ apiKey: '   ' })
    assert.deepEqual(blank.resolve(), { ok: false, code: 'MISSING_CREDENTIAL' }, '纯空白 = 未配置')
  } finally {
    delete process.env[name]
  }
})

/* ------------------------------ 插件装配 ------------------------------ */

interface FakeRouter {
  routes: { method: string; path: string; handler: (h: unknown) => void; opts?: { access?: string } }[]
  service: unknown
}

function makeRouter(): FakeRouter {
  const routes: FakeRouter['routes'] = []
  const service = {
    register(method: string, path: string, handler: (h: unknown) => void, opts?: { access?: string }) {
      routes.push({ method, path, handler, ...(opts ? { opts } : {}) })
      return () => undefined
    },
  }
  return { routes, service }
}

/** 最小 RouteHandlerContext 替身：只实现被用到的 json() */
function makeHandlerCtx(): { status: number; body: unknown; json(s: number, b: unknown): void } {
  const ctx = {
    status: 0,
    body: undefined as unknown,
    json(s: number, b: unknown) {
      ctx.status = s
      ctx.body = b
    },
  }
  return ctx
}

async function setupWithRouter(): Promise<{ root: Context; router: FakeRouter }> {
  const root = new Context()
  const router = makeRouter()
  root.provide('http', router.service)
  return { root, router }
}

test(`插件挂载 ${LLM_PROVIDERS_PATH}（admin 级）：只报来源与默认值，绝不回显密钥`, async () => {
  const { root, router } = await setupWithRouter()
  const fork = root.plugin(LlmPlugin, { apiKey: 'sk-must-not-leak', model: 'x-model' })
  await fork
  // 适配器替身：注册一条路由，让下拉有内容
  const service = root.get(LLM_SERVICE_KEY) as LlmService
  const descriptor: LlmRouteDescriptor = {
    route: 'fake-vendor',
    label: '假服务商',
    vendor: 'fake',
    model: 'fake-model',
    description: '测试用',
    defaults: { baseUrl: 'https://fake.test/v1', model: 'fake-model' },
    available: () => true,
  }
  service.register({
    route: descriptor.route,
    descriptor,
    // 契约要求 AsyncIterable
    async *stream() {
      yield { type: 'error' as const, code: 'NO_ADAPTER' as const }
    },
  })

  const route = router.routes.find((r) => r.path === LLM_PROVIDERS_PATH)
  assert.ok(route, '端点必须挂载（配置表单的服务商下拉靠它）')
  assert.equal(route.method, 'GET')
  assert.equal(route.opts?.access, 'admin', '配置读取是 admin 级，列表也必须同级')

  const h = makeHandlerCtx()
  route.handler(h)
  assert.equal(h.status, 200)
  const body = h.body as {
    ok: boolean
    providers: { id: string; available: boolean; defaults: { baseUrl?: string } }[]
    selected: string
    credential: { source: string; configured: boolean }
    settings: { apiKey?: string }
  }
  assert.equal(body.ok, true)
  assert.deepEqual(body.providers.map((p) => p.id), ['fake-vendor'], '内置兜底路由（vendor=none）不得出现在下拉里')
  assert.equal(body.providers[0]?.available, true)
  assert.equal(body.providers[0]?.defaults.baseUrl, 'https://fake.test/v1', '带出适配器默认值供表单提示')
  assert.equal(body.credential.source, 'inline', '只报来源')
  assert.equal(body.credential.configured, true)
  assert.equal('apiKey' in body.settings, false, '设置快照里不得出现密钥字段')
  assert.equal(JSON.stringify(h.body).includes('sk-must-not-leak'), false, '整份响应不得含密钥明文')

  await fork.dispose()
})

test('extraBody 非法 → 激活失败并给出可读原因（而不是静默忽略）', async () => {
  const root = new Context()
  const fork = root.plugin(LlmPlugin, { extraBody: '{坏 JSON' })
  await assert.rejects(
    async () => {
      await fork
    },
    /extraBody 非法/,
  )
})

test('apiKey 字段原样交给插件（写一次字段由管理器注水，插件侧不做二次校验）', async () => {
  const root = new Context()
  const fork = root.plugin(LlmPlugin, { apiKey: 'sk-direct-construction' })
  await fork
  const service = root.get(LLM_SERVICE_KEY) as LlmService
  assert.deepEqual(service.resolveApiKey(), { ok: true, value: 'sk-direct-construction' })
  assert.equal(service.credentialSource(), 'inline')
  await fork.dispose()
})
