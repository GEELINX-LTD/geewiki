/**
 * 模型清单 / 连接测试的编排测试（`@geewiki/llm`）。
 *
 * 这一层的价值全在**编排**上，协议细节归适配器（那边有自己的测试）。所以这里用
 * 手写的 `probe` 替身，只验四件事：
 * 1. 目标解析：表单草稿 > 已存配置 > 适配器默认；
 * 2. 失败归类：没服务商 / 没密钥 / baseUrl 非法 / 服务商不支持，各报各的，绝不抛；
 * 3. 汇总口径：`ok` 只看对话探测，模型清单失败只是附带信息；
 * 4. 出响应前再脱敏一次（纵深防御——探测详情是要显示在管理台上的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context } from 'cordis'
import {
  LLM_MODELS_PATH,
  LLM_TEST_PATH,
  LlmPlugin,
  createLlmService,
  type LlmConnectionTestResult,
  type LlmModelListResult,
  type LlmProbeCapability,
  type LlmProbeFailure,
  type LlmProbeTarget,
  type LlmService,
  type LlmSettings,
} from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

/** 只改少数几项的设置夹具 */
function settingsWith(patch: Partial<LlmSettings>): () => LlmSettings {
  const base: LlmSettings = {
    provider: 'fake',
    baseUrl: 'https://cfg.test/v1',
    model: 'cfg-model',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    reasoningEffort: 'off',
    timeoutMs: 60000,
    includeUsage: true,
    extraBody: '',
    apiKeyEnv: '',
  }
  return () => ({ ...base, ...patch })
}

/** 探测替身可注入的结果（失败分支直接用契约里的形状，避免测试自创一套词汇） */
interface ProbeStubOptions {
  models?: string[]
  listFailure?: Omit<LlmProbeFailure, 'ok'>
  chatOk?: boolean
  chatReply?: string
  /** 上游在响应里回显的模型名（可能与请求里的不同，展示以它为准） */
  chatModel?: string
  chatFailure?: Omit<LlmProbeFailure, 'ok'>
}

/** 探测替身：按用例给定返回值，并记下每次调用拿到的 target（用于断言解析结果） */
function makeProbe(options: ProbeStubOptions = {}): LlmProbeCapability & { calls: LlmProbeTarget[] } {
  const calls: LlmProbeTarget[] = []
  return {
    calls,
    async listModels(target) {
      calls.push(target)
      if (options.listFailure) return { ok: false, ...options.listFailure }
      return { ok: true, models: options.models ?? ['a-model', 'b-model'] }
    },
    async chat(target) {
      calls.push(target)
      if (options.chatFailure) return { ok: false, ...options.chatFailure }
      if (options.chatOk === false) return { ok: false, code: 'http', message: '上游炸了' }
      return {
        ok: true,
        reply: options.chatReply ?? '好的',
        latencyMs: 42,
        ...(options.chatModel !== undefined ? { model: options.chatModel } : {}),
      }
    },
  }
}

/** 注册一个带（或不带）探测能力的假服务商 */
function registerVendor(
  svc: LlmService,
  route: string,
  opts: { available?: boolean; defaults?: { baseUrl?: string; model?: string }; probe?: LlmProbeCapability } = {},
): void {
  svc.register({
    route,
    descriptor: {
      route,
      label: `${route} 服务商`,
      vendor: 'fake',
      model: opts.defaults?.model ?? 'default-model',
      defaults: opts.defaults,
      ...(opts.probe ? { probe: opts.probe } : {}),
      available: () => opts.available ?? true,
    },
    // 契约要求 AsyncIterable
    async *stream() {
      yield { type: 'error' as const, code: 'NO_ADAPTER' as const }
    },
  })
}

/** 接上统一配置与密钥的服务实例（与生产装配同形） */
function serviceWith(opts: {
  settings?: Partial<LlmSettings>
  apiKey?: string
}): { svc: LlmService; key: string } {
  const key = opts.apiKey ?? 'sk-cfg-key-must-not-leak'
  const svc = createLlmService({
    settings: settingsWith(opts.settings ?? {}),
    resolveApiKey: () => ({ ok: true as const, value: key }),
    credentialSource: () => 'inline' as const,
  })
  return { svc, key }
}

/* ------------------------------ 目标解析 ------------------------------ */

test('listModels：表单草稿优先于已存配置与适配器默认', async () => {
  const { svc } = serviceWith({ settings: { baseUrl: 'https://cfg.test/v1' } })
  const probe = makeProbe({ models: ['m1'] })
  registerVendor(svc, 'fake', { defaults: { baseUrl: 'https://vendor.test/v1', model: 'vendor-model' } , probe })

  const res: LlmModelListResult = await svc.listModels({ baseUrl: 'https://draft.test/v1/', model: ' draft-model ' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.models, ['m1'])
  assert.equal(res.baseUrl, 'https://draft.test/v1/', '草稿里刚改的端点要立刻能测（不必先保存）')
  assert.equal(probe.calls[0]?.baseUrl, 'https://draft.test/v1/')
  assert.equal(probe.calls[0]?.model, 'draft-model', '模型同样取草稿值，且裁掉空白')
  assert.ok(probe.calls[0]!.timeoutMs <= 20000, '探测必须有比对话请求更短的超时上限')
})

test('listModels：草稿省略时回落 配置 > 适配器默认；密钥取已保存的那份', async () => {
  const { svc, key } = serviceWith({ settings: { baseUrl: 'https://cfg.test/v1', model: '' } })
  const probe = makeProbe({ models: ['m1'] })
  registerVendor(svc, 'fake', { defaults: { baseUrl: 'https://vendor.test/v1', model: 'vendor-model' }, probe })

  await svc.listModels({})
  assert.equal(probe.calls[0]?.baseUrl, 'https://cfg.test/v1', '配置里填的端点优先于适配器默认')
  assert.equal(probe.calls[0]?.model, 'vendor-model', '配置里模型留空 → 用适配器默认模型')
  assert.equal(probe.calls[0]?.apiKey, key, 'apiKey 留空 = 用已保存密钥（密钥不回显，空串绝不是"没有密钥"）')
})

test('listModels：点名不存在的服务商 / 一个服务商都没有，报错要能指向下一步', async () => {
  const { svc } = serviceWith({})
  registerVendor(svc, 'fake', { probe: makeProbe({}) })
  const unknown = await svc.listModels({ provider: 'ghost' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error?.code, 'no_provider')
  assert.match(unknown.error?.message ?? '', /ghost/, '报错里要带上用户点名的那个 id，否则不知道哪儿写错了')

  const empty = createLlmService({ resolveApiKey: () => ({ ok: true, value: 'sk-x' }) })
  const none = await empty.listModels({})
  assert.equal(none.error?.code, 'no_provider')
  assert.match(none.error?.message ?? '', /启用/, '一个服务商都没有时，指引是"去启用适配器插件"')
})

test('listModels：没有密钥时报 no_credential，且绝不回显密钥', async () => {
  const svc = createLlmService({
    settings: settingsWith({}),
    resolveApiKey: () => ({ ok: false, code: 'MISSING_CREDENTIAL' }),
  })
  registerVendor(svc, 'fake', { probe: makeProbe({}) })
  const res = await svc.listModels({})
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'no_credential')
  assert.match(res.error?.message ?? '', /API Key/)
})

test('listModels：baseUrl 非法要报 invalid_input（含原值，端点地址不是敏感信息）', async () => {
  const { svc } = serviceWith({})
  registerVendor(svc, 'fake', { probe: makeProbe({}) })
  const notUrl = await svc.listModels({ baseUrl: 'not a url' })
  assert.equal(notUrl.error?.code, 'invalid_input')
  assert.match(notUrl.error?.message ?? '', /not a url/)

  const wrongScheme = await svc.listModels({ baseUrl: 'ftp://x.test/v1' })
  assert.equal(wrongScheme.error?.code, 'invalid_input')
  assert.match(wrongScheme.error?.message ?? '', /ftp:/, '协议不对要说清收到的是什么')

  const noBase = createLlmService({ settings: settingsWith({ baseUrl: '' }), resolveApiKey: () => ({ ok: true, value: 'sk-x' }) })
  registerVendor(noBase, 'fake', { probe: makeProbe({}) })
  const empty = await noBase.listModels({ baseUrl: '' })
  assert.equal(empty.error?.code, 'invalid_input')
  assert.match(empty.error?.message ?? '', /Base URL/)
})

test('服务商未实现探测能力：明确报 unsupported，而不是假装成功', async () => {
  const { svc } = serviceWith({})
  registerVendor(svc, 'fake', {})
  const listed = await svc.listModels({})
  assert.equal(listed.ok, false)
  assert.equal(listed.error?.code, 'unsupported')
  assert.match(listed.error?.message ?? '', /fake 服务商/, '要说是谁不支持——用户以为是自己配错了')
  const tested = await svc.testConnection({})
  assert.equal(tested.ok, false)
  assert.equal(tested.error?.code, 'unsupported')
})

/* ------------------------------ 连接测试汇总 ------------------------------ */

test('testConnection：两步都成 → ok；模型清单与对话各自独立呈现', async () => {
  const { svc } = serviceWith({ settings: { model: 'my-model' } })
  const probe = makeProbe({ models: ['my-model', 'other'], chatModel: 'my-model-v2' })
  registerVendor(svc, 'fake', { probe })
  const res: LlmConnectionTestResult = await svc.testConnection({})
  assert.equal(res.ok, true)
  assert.equal(res.model, 'my-model-v2', '上游回显的模型名更具体，展示以它为准')
  assert.equal(res.models?.ok, true)
  assert.deepEqual(res.models?.models, ['my-model', 'other'])
  assert.equal(res.chat?.ok, true)
  assert.equal(res.chat?.reply, '好的')
  assert.equal(res.chat?.latencyMs, 42)
})

test('testConnection：模型清单失败不算整体失败（不少网关不实现 /models 却能对话）', async () => {
  const { svc } = serviceWith({ settings: { model: 'my-model' } })
  const probe = makeProbe({ listFailure: { code: 'not_found', status: 404, message: '端点不支持该请求（HTTP 404）' } })
  registerVendor(svc, 'fake', { probe })
  const res = await svc.testConnection({})
  assert.equal(res.ok, true, '对话通了就是通了')
  assert.equal(res.models?.ok, false)
  assert.equal(res.models?.error?.status, 404, '但清单失败的原因要如实给出，不能只留一个空列表')
})

test('testConnection：对话失败 → 整体失败，且带上游原文（脱敏后）', async () => {
  const { svc, key } = serviceWith({ settings: { model: 'my-model' } })
  const probe = makeProbe({
    models: ['my-model'],
    chatFailure: {
      code: 'auth',
      status: 401,
      message: '鉴权失败（HTTP 401）',
      detail: `Authorization: Bearer ${key}; error: incorrect api key provided: ${key}`,
    },
  })
  registerVendor(svc, 'fake', { probe })
  const res = await svc.testConnection({})
  assert.equal(res.ok, false)
  assert.equal(res.chat?.error?.status, 401, '状态码要留着——用户靠它区分"密钥错"和"没网"')
  const detail = res.chat?.error?.detail ?? ''
  assert.match(detail, /HTTP 401|incorrect api key/, '原文要能看见，否则用户只能猜')
  assert.equal(JSON.stringify(res).includes(key), false, '密钥明文绝不能出现在响应里（本次探测用的那把也要屏蔽）')
})

test('testConnection：模型名两处都没有 → 借用清单首个，仍失败时给出可操作说明', async () => {
  const svc = createLlmService({
    settings: settingsWith({ model: '', baseUrl: 'https://cfg.test/v1' }),
    resolveApiKey: () => ({ ok: true, value: 'sk-x' }),
  })
  const probe = makeProbe({ models: ['first', 'second'] })
  registerVendor(svc, 'fake', { defaults: { model: '' }, probe })
  await svc.testConnection({})
  const chatCall = probe.calls[probe.calls.length - 1]
  assert.equal(chatCall?.model, 'first', '没填模型时用清单首个去试')

  // 清单也拿不到时不猜模型：让适配器的 invalid_input 说明浮上来
  const blind = createLlmService({
    settings: settingsWith({ model: '', baseUrl: 'https://cfg.test/v1' }),
    resolveApiKey: () => ({ ok: true, value: 'sk-x' }),
  })
  registerVendor(blind, 'fake', {
    defaults: { model: '' },
    probe: {
      async listModels() {
        return { ok: false, code: 'not_found', status: 404, message: '不支持' }
      },
      async chat(t) {
        return t.model === undefined
          ? { ok: false, code: 'invalid_input', message: '未填写模型名，无法测试对话' }
          : { ok: true, reply: '好的', latencyMs: 1 }
      },
    },
  })
  const res = await blind.testConnection({})
  assert.equal(res.ok, false)
  assert.match(res.chat?.error?.message ?? '', /模型名/)
})

test('适配器探测实现抛错不得冒成 500（折算成 network 失败）', async () => {
  const { svc } = serviceWith({ settings: { model: 'm' } })
  registerVendor(svc, 'fake', {
    probe: {
      async listModels() {
        throw new Error(`adapter blew up with key sk-boom-boom-boom-123`)
      },
      async chat() {
        throw new Error('boom')
      },
    },
  })
  const listed = await svc.listModels({})
  assert.equal(listed.ok, false)
  assert.equal(listed.error?.code, 'network')
  assert.equal(JSON.stringify(listed).includes('sk-boom-boom-boom-123'), false, '异常文本同样要脱敏')
  const tested = await svc.testConnection({})
  assert.equal(tested.ok, false)
})

/* ------------------------------ 端点装配 ------------------------------ */

interface FakeRouter {
  routes: { method: string; path: string; handler: (h: unknown) => Promise<void> | void; opts?: { access?: string } }[]
  service: unknown
}

function makeRouter(): FakeRouter {
  const routes: FakeRouter['routes'] = []
  return {
    routes,
    service: {
      register(method: string, path: string, handler: (h: unknown) => void, opts?: { access?: string }) {
        routes.push({ method, path, handler, ...(opts ? { opts } : {}) })
        return () => undefined
      },
    },
  }
}

/**
 * 跑一条路由并返回它的响应。
 *
 * `req` 是个可 emit 的 EventEmitter —— `readJsonBody` 只依赖 `data` / `end` / `error`
 * 三个事件，不需要真的流。顺序是**这里唯一的小坑**：处理器先同步注册监听、再 await 请求体，
 * 所以必须"先起处理器 → 再喂 body → 最后 await 处理器"，反过来的话它俩会互相等死。
 * 空 body 只发 `end`（真实 HTTP 上空体不会产生 data 事件，readJsonBody 据此解析成 `{}`）。
 */
async function runRoute(
  route: { handler: (h: unknown) => void | Promise<void> },
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = new EventEmitter()
  const ctx = {
    req,
    status: 0,
    body: undefined as unknown,
    json(status: number, payload: unknown): void {
      ctx.status = status
      ctx.body = payload
    },
  }
  const pending = Promise.resolve(route.handler(ctx))
  await new Promise((r) => setImmediate(r))
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  if (text !== '') req.emit('data', Buffer.from(text))
  req.emit('end')
  await pending
  return ctx
}

test('端点：POST /api/llm/models 与 /api/llm/test 都是 admin 级，且探测失败也返回 200', async () => {
  const root = new Context()
  const router = makeRouter()
  root.provide('http', router.service)
  await root.plugin(LlmPlugin, { apiKey: 'sk-endpoint-key-abcdefgh' })
  const svc = root.get('llm-service') as LlmService
  registerVendor(svc, 'fake', {
    defaults: { baseUrl: 'https://fake.test/v1' },
    probe: makeProbe({ models: ['m'], chatFailure: { code: 'auth', status: 401, message: '鉴权失败' } }),
  })

  for (const [path, method] of [
    [LLM_MODELS_PATH, 'POST'],
    [LLM_TEST_PATH, 'POST'],
  ] as const) {
    const route = router.routes.find((r) => r.path === path)
    assert.ok(route, `${path} 必须挂载`)
    assert.equal(route.method, method, '探测参数含表单草稿里的密钥，不能走 query')
    assert.equal(route.opts?.access, 'admin')
  }

  const h = await runRoute(router.routes.find((r) => r.path === LLM_TEST_PATH)!, { model: 'm' })
  assert.equal(h.status, 200, '上游 401 是**有用的诊断**，不该被 HTTP 错误外壳吃掉')
  const body = h.body as LlmConnectionTestResult
  assert.equal(body.ok, false)
  assert.equal(body.chat?.error?.status, 401)
  assert.equal(JSON.stringify(h.body).includes('sk-endpoint-key-abcdefgh'), false)
})

test('端点：请求体不是合法 JSON → 400（这是协议错误，与探测结论无关）', async () => {
  const root = new Context()
  const router = makeRouter()
  root.provide('http', router.service)
  await root.plugin(LlmPlugin, { apiKey: 'sk-x' })
  const svc = root.get('llm-service') as LlmService
  registerVendor(svc, 'fake', { defaults: { baseUrl: 'https://fake.test/v1' }, probe: makeProbe({}) })

  const h = await runRoute(router.routes.find((r) => r.path === LLM_MODELS_PATH)!, '{不是 json')
  assert.equal(h.status, 400)
  assert.equal((h.body as { error: string }).error, 'invalid_json')
})

test('端点：空 body 是合法调用（= 用已保存的配置探测）', async () => {
  const root = new Context()
  const router = makeRouter()
  root.provide('http', router.service)
  await root.plugin(LlmPlugin, { apiKey: 'sk-x', model: 'saved-model' })
  const svc = root.get('llm-service') as LlmService
  const probe = makeProbe({ models: ['m'] })
  registerVendor(svc, 'fake', { defaults: { baseUrl: 'https://fake.test/v1' }, probe })

  const h = await runRoute(router.routes.find((r) => r.path === LLM_MODELS_PATH)!, '')
  assert.equal(h.status, 200)
  assert.equal((h.body as LlmModelListResult).ok, true)
  assert.equal(probe.calls[0]?.model, 'saved-model', '没传 model 就用已保存的配置')
})
