/**
 * provider 的集成测试：用**本地 mock HTTP 服务**扮演上游（`node:http`，随机端口）。
 *
 * 为什么不用假 fetch：本批的核心风险是**真实的 HTTP/流式行为**——分帧、连接中断、
 * 超时、abort 传播、错误体读取。替身 fetch 会把这些全部替换成"我以为的样子"，
 * 恰好绕开要验证的东西。mock 服务是本机回环，不产生外网依赖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolveCredential, type LlmChunk, type LlmProvider, type LlmRequest, type LlmSettings } from '@geewiki/llm'
import { createOpenAiProvider } from '../src/provider.js'

/* ------------------------------ mock 上游 ------------------------------ */

interface MockOptions {
  status?: number
  /** 非流式响应体（错误场景用） */
  body?: string
  /** 逐帧下发；每帧之间等待 delayMs */
  frames?: string[]
  delayMs?: number
  /** 收到请求后直接销毁 socket（模拟连接被重置） */
  destroy?: boolean
  /** 永不响应（用于超时测试） */
  hang?: boolean
}

interface Mock {
  baseUrl: string
  /** 收到的请求体原文（用于断言发出去的 payload） */
  requests: string[]
  close: () => Promise<void>
}

async function startMock(options: MockOptions = {}): Promise<Mock> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      raw += c
    })
    req.on('end', () => {
      requests.push(raw)
      if (options.destroy === true) {
        req.socket.destroy()
        return
      }
      if (options.hang === true) return
      const status = options.status ?? 200
      if (options.frames !== undefined) {
        res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        let index = 0
        const tick = (): void => {
          if (index >= options.frames!.length) {
            res.end()
            return
          }
          res.write(options.frames![index++])
          setTimeout(tick, options.delayMs ?? 0)
        }
        tick()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(options.body ?? '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/* ------------------------------ 夹具 ------------------------------ */

/** 每个用例用独立环境变量名，避免用例间互相污染 */
let envCounter = 0
function freshEnvName(): string {
  envCounter += 1
  return `GEEWIKI_TEST_OPENAI_KEY_${envCounter}`
}

/**
 * 一份"统一接入设置"夹具。
 *
 * 本批起适配器**不再持有配置**：端点、模型、超时、思考强度都从 `settings()` 现读
 * （见 `../src/index.ts` 的文件头）。故测试夹具也从"构造参数"变成"设置对象"。
 */
function settingsFixture(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    provider: '',
    baseUrl: '',
    model: '',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    reasoningEffort: 'off',
    timeoutMs: 5000,
    includeUsage: true,
    extraBody: '',
    apiKeyEnv: 'GEEWIKI_TEST_UNSET_KEY',
    ...overrides,
  }
}

/**
 * 可变的设置对象（契约里的 `LlmSettings` 字段是 `readonly`——它描述的是"某一刻的值"）。
 * 测"配置热更新后适配器现读新值"时必须能改它，故这里显式去掉只读修饰。
 */
type MutableSettings = { -readonly [K in keyof LlmSettings]: LlmSettings[K] }

function makeProvider(
  baseUrl: string,
  overrides: Partial<{ apiKeyEnv: string; timeoutMs: number; model: string; includeUsage: boolean; reasoningEffort: LlmSettings['reasoningEffort']; extraBody: string }> = {},
): LlmProvider {
  const apiKeyEnv = overrides.apiKeyEnv ?? 'GEEWIKI_TEST_UNSET_KEY'
  return createOpenAiProvider({
    route: 'openai-test',
    label: '测试端点',
    description: '测试用 OpenAI 兼容端点',
    // 用户没填 baseUrl / model 时的兜底属于**适配器**（见 OpenAiProviderOptions.defaults）
    defaults: { baseUrl, model: overrides.model ?? 'test-model' },
    settings: () =>
      settingsFixture({
        apiKeyEnv,
        timeoutMs: overrides.timeoutMs ?? 5000,
        includeUsage: overrides.includeUsage ?? true,
        ...(overrides.reasoningEffort !== undefined ? { reasoningEffort: overrides.reasoningEffort } : {}),
        ...(overrides.extraBody !== undefined ? { extraBody: overrides.extraBody } : {}),
      }),
    resolveApiKey: () => resolveCredential(apiKeyEnv),
  })
}

async function collect(
  provider: LlmProvider,
  req: Partial<LlmRequest> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = []
  for await (const chunk of provider.stream({ messages: [{ role: 'user', content: '你好' }], ...req }, { signal })) {
    chunks.push(chunk)
  }
  return chunks
}

/** OpenAI 兼容的一帧正文增量 */
function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

const DONE = 'data: [DONE]\n\n'

/* ------------------------------ 用例 ------------------------------ */

test('available()：未设环境变量 → false 且不抛错；设了 → true', () => {
  const name = freshEnvName()
  const provider = makeProvider('http://127.0.0.1:1/v1', { apiKeyEnv: name })
  assert.equal(provider.descriptor.available(), false)
  assert.equal(provider.descriptor.apiKeyEnv, name, 'descriptor 里暴露的是变量名而非值')
  process.env[name] = 'sk-test-value-1234567890'
  try {
    assert.equal(provider.descriptor.available(), true)
  } finally {
    delete process.env[name]
  }
  assert.equal(provider.descriptor.available(), false, '删除后应回到不可用')
})

test('available() 是动态的：先构建 provider，之后再设环境变量也能变为可用', async () => {
  // 这是刻意不缓存凭据的回归测试。缓存会导致"启动后才配好 key"必须重启才生效。
  const name = freshEnvName()
  const provider = makeProvider('http://127.0.0.1:1/v1', { apiKeyEnv: name })
  assert.equal(provider.descriptor.available(), false, '构建时未设置')
  process.env[name] = 'sk-later-1234567890'
  try {
    assert.equal(provider.descriptor.available(), true, '进程运行期设置后应立即生效（证明未缓存）')
  } finally {
    delete process.env[name]
  }
})

test('缺凭据时产出单个 error{MISSING_CREDENTIAL}，且不发任何请求', async () => {
  const mock = await startMock({ frames: [frame('x'), DONE] })
  try {
    const provider = makeProvider(mock.baseUrl, { apiKeyEnv: freshEnvName() })
    const chunks = await collect(provider)
    assert.deepEqual(chunks, [{ type: 'error', code: 'MISSING_CREDENTIAL' }])
    assert.equal(mock.requests.length, 0, '缺凭据不该发出网络请求')
  } finally {
    await mock.close()
  }
})

test('正常流式：status → 多个 text-delta（与上游帧一一对应）→ done（带 usage）', async () => {
  const name = freshEnvName()
  const usageFrame = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`
  const mock = await startMock({ frames: [frame('你好'), frame('，'), frame('世界'), usageFrame, DONE] })
  process.env[name] = 'sk-test-1234567890'
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))

    assert.equal(chunks[0]?.type, 'status', '首个 chunk 是 status（用于区分"连不上"与"连上没内容"）')
    const deltas = chunks.filter((c) => c.type === 'text-delta')
    // 一一对应 ⇒ 证明是增量产出而非攒完一次性发出
    assert.deepEqual(deltas.map((c) => (c.type === 'text-delta' ? c.text : '')), ['你好', '，', '世界'])
    const last = chunks.at(-1)
    assert.equal(last?.type, 'done')
    assert.deepEqual(last?.type === 'done' ? last.usage : undefined, { promptTokens: 11, completionTokens: 7 })

    // 请求侧断言：stream:true、模型、以及 include_usage 开关
    const sent = JSON.parse(mock.requests[0] ?? '{}') as Record<string, unknown>
    assert.equal(sent['stream'], true)
    assert.equal(sent['model'], 'test-model')
    assert.deepEqual(sent['stream_options'], { include_usage: true })
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('增量性是真实的：首帧 delta 在上游发完所有帧之前就已到达消费方', async () => {
  // 直接证据而非推断：mock 在首帧后等待 200ms 才发第二帧；
  // 若 provider 攒完整响应再产出，首个 delta 的到达耗时必然 > 200ms。
  const name = freshEnvName()
  const mock = await startMock({ frames: [frame('第一段'), frame('第二段'), DONE], delayMs: 200 })
  process.env[name] = 'sk-test-1234567890'
  try {
    const provider = makeProvider(mock.baseUrl, { apiKeyEnv: name })
    const started = Date.now()
    let firstDeltaMs = -1
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal })) {
      if (chunk.type === 'text-delta' && firstDeltaMs < 0) {
        firstDeltaMs = Date.now() - started
        break // 拿到首帧就退出：prove 它是"边收边吐"
      }
    }
    assert.ok(firstDeltaMs >= 0, '必须能收到 text-delta')
    assert.ok(firstDeltaMs < 200, `首帧应在 200ms 内到达（实测 ${firstDeltaMs}ms），否则说明是攒完再发`)
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('model 可被单次请求覆盖', async () => {
  const name = freshEnvName()
  const mock = await startMock({ frames: [frame('x'), DONE] })
  process.env[name] = 'sk-test-1234567890'
  try {
    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }), { model: 'override-model' })
    const sent = JSON.parse(mock.requests[0] ?? '{}') as Record<string, unknown>
    assert.equal(sent['model'], 'override-model')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('includeUsage=false 时不发送 stream_options（兼容不认该字段的端点）', async () => {
  const name = freshEnvName()
  const mock = await startMock({ frames: [frame('x'), DONE] })
  process.env[name] = 'sk-test-1234567890'
  try {
    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name, includeUsage: false }))
    const sent = JSON.parse(mock.requests[0] ?? '{}') as Record<string, unknown>
    assert.equal(sent['stream_options'], undefined)
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('错误码归一：401 → AUTH / INVALID_CREDENTIAL', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-bad-1234567890'
  const generic = await startMock({ status: 401, body: JSON.stringify({ error: { message: 'Unauthorized' } }) })
  const specific = await startMock({
    status: 401,
    body: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }),
  })
  try {
    assert.deepEqual(await collect(makeProvider(generic.baseUrl, { apiKeyEnv: name })), [{ type: 'error', code: 'AUTH' }])
    assert.deepEqual(await collect(makeProvider(specific.baseUrl, { apiKeyEnv: name })), [
      { type: 'error', code: 'INVALID_CREDENTIAL' },
    ])
  } finally {
    delete process.env[name]
    await generic.close()
    await specific.close()
  }
})

test('错误码归一：429 → RATE_LIMIT', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({ status: 429, body: JSON.stringify({ error: { type: 'rate_limit_exceeded' } }) })
  try {
    assert.deepEqual(await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name })), [{ type: 'error', code: 'RATE_LIMIT' }])
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('错误码归一：400 + context_length_exceeded → CONTEXT_WINDOW_EXCEEDED', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({
    status: 400,
    body: JSON.stringify({ error: { code: 'context_length_exceeded', message: "This model's maximum context length is 8192 tokens" } }),
  })
  try {
    assert.deepEqual(await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name })), [
      { type: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
    ])
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('错误码归一：连接被重置 → NETWORK', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({ destroy: true })
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]?.type, 'error')
    assert.equal(chunks[0]?.type === 'error' ? chunks[0].code : '', 'NETWORK')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('错误码归一：上游不响应直到超时 → TIMEOUT', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({ hang: true })
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name, timeoutMs: 150 }))
    assert.deepEqual(chunks, [{ type: 'error', code: 'TIMEOUT' }])
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('错误码归一：外部 signal 取消 → ABORTED（与 TIMEOUT 区分开）', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({ hang: true })
  try {
    const controller = new AbortController()
    const provider = makeProvider(mock.baseUrl, { apiKeyEnv: name, timeoutMs: 30000 })
    const pending = collect(provider, {}, controller.signal)
    setTimeout(() => controller.abort(), 100)
    assert.deepEqual(await pending, [{ type: 'error', code: 'ABORTED' }])
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('坏帧容忍：非 JSON、注释、非 data 字段混入仍能产出可解析内容', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({
    frames: [
      ': keep-alive\n\n',
      'event: message\nid: 1\ndata: {broken json\n\n',
      'data: not-json-at-all\n\n',
      frame('有效内容'),
      'data: [DONE]\n\n',
    ],
  })
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    const deltas = chunks.filter((c) => c.type === 'text-delta')
    assert.deepEqual(deltas.map((c) => (c.type === 'text-delta' ? c.text : '')), ['有效内容'])
    assert.equal(chunks.at(-1)?.type, 'done', '坏帧不得中断整条流')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('密钥不泄漏：上游在错误体里回显密钥时，chunk 与日志都不得出现该串', async () => {
  const name = freshEnvName()
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX'
  process.env[name] = secret
  // 上游把收到的 Authorization 原样回显进错误体（真实网关的常见行为）
  const mock = await startMock({
    status: 500,
    body: JSON.stringify({ error: { message: `upstream failure, authorization: Bearer ${secret}` } }),
  })

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    const serialized = JSON.stringify(chunks)
    assert.equal(serialized.includes(secret), false, 'chunk 里不得出现密钥')
    assert.equal(warnings.join('\n').includes(secret), false, '日志里不得出现密钥')
    // error chunk 结构上就没有 message 字段，从源头杜绝上游文本外泄
    for (const chunk of chunks) {
      if (chunk.type === 'error') assert.equal('message' in chunk, false, 'error chunk 不得携带 message')
    }
    assert.ok(warnings.length > 0, '应记录了脱敏后的诊断日志（证明这条路径真的被走到）')
  } finally {
    console.warn = originalWarn
    delete process.env[name]
    await mock.close()
  }
})

test('401 时错误体不可读也不影响归一化（状态码已足够判码）', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-1234567890'
  const mock = await startMock({ destroy: true })
  try {
    // 连接被重置：应归 NETWORK 而不是崩在"读错误体"上
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]?.type, 'error')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

/* ------------------- 统一配置：现读、思考强度、额外请求体 ------------------- */

test('现读设置：改 baseUrl / model 后下一次请求就用新值（无需重建 provider）', async () => {
  const first = await startMock({ frames: [frame('甲'), DONE] })
  const second = await startMock({ frames: [frame('乙'), DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  const settings: MutableSettings = { ...settingsFixture({ apiKeyEnv: name }) }
  const provider = createOpenAiProvider({
    route: 'openai-test',
    label: '测试端点',
    description: '测试',
    defaults: { baseUrl: first.baseUrl, model: 'fallback-model' },
    settings: () => settings,
    resolveApiKey: () => resolveCredential(name),
  })
  try {
    await collect(provider)
    assert.equal(JSON.parse(first.requests[0]!).model, 'fallback-model', '未配置时回落适配器默认模型')

    // 模拟"用户在「模型接入」里改了端点与模型"：设置对象变了，provider 不用重建
    settings.baseUrl = second.baseUrl
    settings.model = 'new-model'
    await collect(provider)
    assert.equal(second.requests.length, 1, '第二次请求必须打到新端点')
    assert.equal(JSON.parse(second.requests[0]!).model, 'new-model')
    assert.equal(provider.descriptor.model, 'new-model', 'descriptor 也必须现读（管理台显示不得滞后）')
  } finally {
    delete process.env[name]
    await first.close()
    await second.close()
  }
})

test('思考强度：off 不发 reasoning_effort；high 发 reasoning_effort=high；自定义档位原样发', async () => {
  const off = await startMock({ frames: [DONE] })
  const high = await startMock({ frames: [DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    await collect(makeProvider(off.baseUrl, { apiKeyEnv: name, reasoningEffort: 'off' }))
    const offBody = JSON.parse(off.requests[0]!) as Record<string, unknown>
    assert.equal('reasoning_effort' in offBody, false, 'off = 不发该参数（各家对"关闭"的写法并不一致）')

    await collect(makeProvider(high.baseUrl, { apiKeyEnv: name, reasoningEffort: 'high' }))
    const highBody = JSON.parse(high.requests[0]!) as Record<string, unknown>
    assert.equal(highBody['reasoning_effort'], 'high')

    // 自定义档位（各家网关不统一：Qwen 用 minimal 之类）必须原样到达上游
    await collect(makeProvider(high.baseUrl, { apiKeyEnv: name, reasoningEffort: 'minimal' }))
    const customBody = JSON.parse(high.requests[1]!) as Record<string, unknown>
    assert.equal(customBody['reasoning_effort'], 'minimal', '配置里的自定义值不得被白名单吃掉')
  } finally {
    delete process.env[name]
    await off.close()
    await high.close()
  }
})

test('采样温度：请求不给就不发（由服务端定），给了才原样带上', async () => {
  const mock = await startMock({ frames: [DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    const silent = JSON.parse(mock.requests[0]!) as Record<string, unknown>
    assert.equal('temperature' in silent, false, '配置里没有温度，请求里也不该长出一个——那会覆盖服务端的默认值')

    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }), { temperature: 0 })
    const explicit = JSON.parse(mock.requests[1]!) as Record<string, unknown>
    assert.equal(explicit['temperature'], 0, '调用方显式给 0 是它的决定，必须透传')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('额外请求体：并入 payload，且同名键由它覆盖（网关私有参数的逃生口）', async () => {
  const mock = await startMock({ frames: [DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    await collect(
      makeProvider(mock.baseUrl, {
        apiKeyEnv: name,
        extraBody: '{"thinking":{"type":"enabled"},"temperature":0.9}',
      }),
      { temperature: 0.3 },
    )
    const body = JSON.parse(mock.requests[0]!) as Record<string, unknown>
    assert.deepEqual(body['thinking'], { type: 'enabled' }, '网关私有形态原样透传')
    assert.equal(body['temperature'], 0.9, '同名键由额外请求体覆盖（它排在 payload 最后）')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('额外请求体损坏时按"没有额外参数"处理（绝不让透传字段毁掉整次请求）', async () => {
  const mock = await startMock({ frames: [frame('好'), DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name, extraBody: '{坏 JSON' }))
    assert.deepEqual(
      chunks.filter((c) => c.type === 'text-delta'),
      [{ type: 'text-delta', text: '好' }],
      '坏透传值不得影响正常流式内容',
    )
    assert.equal(chunks.at(-1)?.type, 'done', '仍以终止 chunk 收尾')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

/* ============================ 工具调用（function calling） ============================ */

/** 一帧工具调用片段（上游按 index 分片：首帧给 id/name，后续帧给 arguments 分片） */
function toolFrame(part: Record<string, unknown>, finishReason?: string): string {
  const delta: Record<string, unknown> = { tool_calls: [part] }
  const choice: Record<string, unknown> = { delta }
  if (finishReason !== undefined) choice['finish_reason'] = finishReason
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`
}

test('不发 tools 时请求体里**没有** tools / tool_choice 键（存量调用方逐字节不变）', async () => {
  const mock = await startMock({ frames: [frame('好'), DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    const body = JSON.parse(mock.requests[0]!) as Record<string, unknown>
    assert.equal('tools' in body, false, '不填就是键根本不出现，不是发一个空数组')
    assert.equal('tool_choice' in body, false, '给了 tools 才谈 tool_choice；这里两个都不该有')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('toolChoice 不填时绝不下发 tool_choice（不替服务端补默认值）', async () => {
  // 与 temperature 同一条理由：各家网关对"默认"的写法与含义并不一致，
  // 客户端补一个默认值等于替服务端做决定。
  const mock = await startMock({ frames: [frame('好'), DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }), {
      tools: [{ name: 'search_kb', description: '检索知识库', parameters: { type: 'object' } }],
    })
    const body = JSON.parse(mock.requests[0]!) as Record<string, unknown>
    assert.equal(Array.isArray(body['tools']), true, '给了 tools 就要发')
    assert.equal('tool_choice' in body, false, '没给 toolChoice 就不发该键')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('tools 折成上游 {type:function, function:{…}} 形态；三档策略与指名形态各自正确', async () => {
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  const tool = { name: 'search_kb', description: '检索知识库', parameters: { type: 'object', properties: {} } }
  const cases: { choice: LlmRequest['toolChoice']; expected: unknown }[] = [
    { choice: 'auto', expected: 'auto' },
    { choice: 'none', expected: 'none' },
    { choice: 'required', expected: 'required' },
    { choice: { name: 'search_kb' }, expected: { type: 'function', function: { name: 'search_kb' } } },
  ]
  for (const c of cases) {
    const mock = await startMock({ frames: [DONE] })
    try {
      await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }), { tools: [tool], toolChoice: c.choice })
      const body = JSON.parse(mock.requests[0]!) as Record<string, unknown>
      assert.deepEqual(body['tools'], [{ type: 'function', function: tool }], `tools 形态（choice=${JSON.stringify(c.choice)}）`)
      assert.deepEqual(body['tool_choice'], c.expected, `tool_choice 形态（choice=${JSON.stringify(c.choice)}）`)
    } finally {
      await mock.close()
    }
  }
  delete process.env[name]
})

test('messages 折成上游形态：assistant 带 tool_calls、tool 带 tool_call_id；普通消息不多任何键', async () => {
  const mock = await startMock({ frames: [DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }), {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '主页怎么新建内容' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'search_kb', arguments: '{"q":"新建"}' }],
        },
        { role: 'tool', content: '["命中 1 条"]', toolCallId: 'call_1' },
      ],
    })
    const body = JSON.parse(mock.requests[0]!) as Record<string, unknown>
    assert.deepEqual(body['messages'], [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '主页怎么新建内容' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_kb', arguments: '{"q":"新建"}' } }],
      },
      { role: 'tool', content: '["命中 1 条"]', tool_call_id: 'call_1' },
    ])
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('流式工具片段逐个透传为 tool-call-delta（id/name 首帧、arguments 分片）', async () => {
  const mock = await startMock({
    frames: [
      toolFrame({ index: 0, id: 'call_1', type: 'function', function: { name: 'search_kb', arguments: '' } }),
      toolFrame({ index: 0, function: { arguments: '{"q":' } }),
      toolFrame({ index: 0, function: { arguments: '"麒麟"}' } }),
      toolFrame({ index: 0 }, 'tool_calls'),
      DONE,
    ],
  })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }), {
      tools: [{ name: 'search_kb', description: 'd', parameters: { type: 'object' } }],
    })
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    assert.deepEqual(deltas, [
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'search_kb', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '{"q":' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '"麒麟"}' },
    ])
    const tail = chunks.at(-1)
    assert.equal(tail?.type, 'done', '仍以终止 chunk 收尾')
    assert.equal(tail?.type === 'done' ? tail.finishReason : undefined, 'tool_calls', 'finish_reason 透传到 done')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('finish_reason 只在非空时透传：中间帧的 null 不算"结束了"', async () => {
  const mock = await startMock({
    frames: [`data: ${JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: null }] })}\n\n`, DONE],
  })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    const tail = chunks.at(-1)
    assert.equal(tail?.type, 'done')
    assert.equal(tail?.type === 'done' ? 'finishReason' in tail : true, false, 'null 不该变成字段')
  } finally {
    delete process.env[name]
    await mock.close()
  }
})

test('空壳工具片段（上游发 {index:0} 不带任何字段）不产生噪声 chunk', async () => {
  const mock = await startMock({ frames: [toolFrame({ index: 0 }), frame('好'), DONE] })
  const name = freshEnvName()
  process.env[name] = 'sk-test-value-1234567890'
  try {
    const chunks = await collect(makeProvider(mock.baseUrl, { apiKeyEnv: name }))
    assert.deepEqual(
      chunks.filter((c) => c.type === 'tool-call-delta'),
      [],
      '没有 id/name/arguments 的片段没有信息量',
    )
    assert.deepEqual(
      chunks.filter((c) => c.type === 'text-delta'),
      [{ type: 'text-delta', text: '好' }],
      '同一条流里的正文不受影响',
    )
  } finally {
    delete process.env[name]
    await mock.close()
  }
})
