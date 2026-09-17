/**
 * OpenAI 兼容探测实现的测试（本地 mock 上游，`node:http`，随机端口）。
 *
 * 与 provider 的测试同一个理由：要验的是**真实 HTTP 行为**（状态码、错误体、超时、
 * 连接被重置），替身 fetch 会把这些恰好绕开。
 *
 * 这里最要紧的一条是**报错可读 + 不泄密**：探测详情是要原样显示在管理台上的，
 * 上游把鉴权头回显进错误体是常见行为，所以密钥必须被屏蔽掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LlmProbeTarget } from '@geewiki/llm'
import { createOpenAiCompatProbe, extractModelIds } from '../src/probe.js'

/* ------------------------------ mock 上游 ------------------------------ */

interface MockHandlers {
  /** GET /models 的响应 */
  models?: { status?: number; body?: string }
  /** POST /chat/completions 的响应 */
  chat?: { status?: number; body?: string }
  /** 收到请求后直接销毁 socket */
  destroy?: boolean
  /** 接受请求但永不响应（超时用例） */
  hang?: boolean
}

interface Mock {
  baseUrl: string
  /** 收到的请求：路径 + authorization 头 + 请求体 */
  seen: { method: string; url: string; auth: string; body: string }[]
  close: () => Promise<void>
}

async function startMock(handlers: MockHandlers = {}): Promise<Mock> {
  const seen: Mock['seen'] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      raw += c
    })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers['authorization'] ?? ''), body: raw })
      if (handlers.destroy === true) {
        req.socket.destroy()
        return
      }
      if (handlers.hang === true) return
      const spec = (req.url ?? '').includes('/models') ? handlers.models : handlers.chat
      res.writeHead(spec?.status ?? 200, { 'content-type': 'application/json' })
      res.end(spec?.body ?? '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function target(baseUrl: string, patch: Partial<LlmProbeTarget> = {}): LlmProbeTarget {
  return { baseUrl, apiKey: 'sk-probe-key-abcdefghij', timeoutMs: 4000, ...patch }
}

/* ------------------------------ 模型清单 ------------------------------ */

test('extractModelIds：三种上游形态都认；一条都取不到时返回 undefined（不返回空列表）', () => {
  assert.deepEqual(extractModelIds({ data: [{ id: 'b' }, { id: 'a' }] }), ['b', 'a'])
  assert.deepEqual(extractModelIds({ models: ['a', { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(extractModelIds(['a', 'b']), ['a', 'b'])
  assert.equal(extractModelIds({ data: [] }), undefined, '空清单 = 没读懂，不是"这个端点没有模型"')
  assert.equal(extractModelIds({ foo: 1 }), undefined)
  assert.equal(extractModelIds('<html>502 Bad Gateway</html>'), undefined, '网关返回 HTML 时也必须判失败')
})

test('listModels：GET /models 带 Bearer 头，返回去重并排序的清单', async () => {
  const mock = await startMock({ models: { body: JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }] }) } })
  try {
    const res = await createOpenAiCompatProbe().listModels(target(mock.baseUrl))
    assert.equal(res.ok, true)
    if (res.ok) assert.deepEqual(res.models, ['alpha', 'zeta'], '去重 + 排序：长清单要能用')
    assert.equal(mock.seen[0]?.method, 'GET')
    assert.equal(mock.seen[0]?.url, '/v1/models', '路径挂在 baseUrl 之下（尾斜杠由 joinUrl 处理）')
    assert.equal(mock.seen[0]?.auth, 'Bearer sk-probe-key-abcdefghij')
  } finally {
    await mock.close()
  }
})

test('listModels：baseUrl 带尾斜杠也能拼对', async () => {
  const mock = await startMock({ models: { body: '{"data":[{"id":"m"}]}' } })
  try {
    await createOpenAiCompatProbe().listModels(target(`${mock.baseUrl}/`))
    assert.equal(mock.seen[0]?.url, '/v1/models')
  } finally {
    await mock.close()
  }
})

test('listModels：401 报 auth 并把上游原文带回来，同时屏蔽本次用的密钥', async () => {
  const mock = await startMock({
    models: {
      status: 401,
      body: JSON.stringify({
        error: {
          message: 'Incorrect API key provided: sk-probe-key-abcdefghij. You can find your API key at ...',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    },
  })
  try {
    const res = await createOpenAiCompatProbe().listModels(target(mock.baseUrl))
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, 'auth')
    assert.equal(res.status, 401, '状态码要留给前端显示——它是用户自查的第一线索')
    assert.match(res.detail ?? '', /Incorrect API key/, '上游原文要可见，否则只能猜')
    assert.equal(JSON.stringify(res).includes('sk-probe-key-abcdefghij'), false, '错误体里回显的密钥必须被屏蔽')
  } finally {
    await mock.close()
  }
})

test('listModels：404 报 not_found 并提示"是不是没填版本段"', async () => {
  const mock = await startMock({ models: { status: 404, body: '{"error":{"message":"not found"}}' } })
  try {
    const res = await createOpenAiCompatProbe().listModels(target(mock.baseUrl))
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, 'not_found')
    assert.match(res.message, /Base URL|版本段/, '这个坑的常见原因就是 baseUrl 少写了 /v1')
  } finally {
    await mock.close()
  }
})

test('listModels：200 但看不懂 → bad_response（比假装"没有模型"有用）', async () => {
  const mock = await startMock({ models: { body: '<html><body>proxy error</body></html>' } })
  try {
    const res = await createOpenAiCompatProbe().listModels(target(mock.baseUrl))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'bad_response')
    assert.match(res.detail ?? '', /proxy error/)
  } finally {
    await mock.close()
  }
})

test('listModels：连接被重置报 network，挂住不响应报 timeout（探测必须自己收口）', async () => {
  const dead = await startMock({ destroy: true })
  try {
    const res = await createOpenAiCompatProbe().listModels(target(dead.baseUrl))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'network')
  } finally {
    await dead.close()
  }

  const stuck = await startMock({ hang: true })
  try {
    const startedAt = Date.now()
    const res = await createOpenAiCompatProbe().listModels(target(stuck.baseUrl, { timeoutMs: 300 }))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'timeout')
    assert.ok(Date.now() - startedAt < 2000, '超时上限必须生效，否则设置页会一直转圈')
  } finally {
    await stuck.close()
  }
})

/* ------------------------------ 对话探测 ------------------------------ */

test('chat：非流式、max_tokens 极小、不下发 temperature，并回报延迟与上游回显的模型名', async () => {
  const mock = await startMock({ chat: { body: JSON.stringify({ model: 'qwen-3.8-flash', choices: [{ message: { content: '好的' } }] }) } })
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl, { model: 'qwen' }))
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.reply, '好的')
    assert.equal(res.model, 'qwen-3.8-flash', '上游回显的名字更具体，展示以它为准')
    assert.ok(res.latencyMs >= 0)

    const body = JSON.parse(mock.seen[0]?.body ?? '{}') as Record<string, unknown>
    assert.equal(body['stream'], false, '探测不需要流')
    assert.ok(
      typeof body['max_tokens'] === 'number' && (body['max_tokens'] as number) <= 64,
      '只要证明能出字（64 是上限：够推理型模型挤出第一个字，又不至于等太久）',
    )
    assert.equal('temperature' in body, false, '探测同样不碰采样温度')
    assert.equal(body['model'], 'qwen')
  } finally {
    await mock.close()
  }
})

test('chat：推理型模型把预算烧在思考上（正文为空）也算连通，并把原因写进回复', async () => {
  // 真实形态：vLLM 的推理模型在极小 max_tokens 下会 finish_reason=length、content=null、只有 reasoning_content
  const mock = await startMock({
    chat: {
      body: JSON.stringify({
        model: 'DeepSeek V4 Flash',
        choices: [
          {
            finish_reason: 'length',
            message: { role: 'assistant', content: null, reasoning_content: '用户要求只回复两个字：好的。我需要完全遵循这个限制，不能……' },
          },
        ],
      }),
    },
  })
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl, { model: 'DeepSeek V4 Flash' }))
    assert.equal(res.ok, true, '鉴权过了、模型能访问、上游真的开始生成了——这就是"通"，判失败只会逼人查不存在的问题')
    if (!res.ok) return
    assert.match(res.reply, /已连通/)
    assert.match(res.reply, /思考内容/)
    assert.equal(res.model, 'DeepSeek V4 Flash')
  } finally {
    await mock.close()
  }
})

test('chat：200、无正文、也没有思考痕迹 → 仍判 bad_response（不能把什么都算成功）', async () => {
  const mock = await startMock({
    chat: { body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] }) },
  })
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl, { model: 'm' }))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'bad_response')
  } finally {
    await mock.close()
  }
})

test('chat：内容块数组形态也能读出正文', async () => {
  const mock = await startMock({
    chat: { body: JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '好' }, { type: 'text', text: '的' }] } }] }) },
  })
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl, { model: 'm' }))
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.reply, '好的')
  } finally {
    await mock.close()
  }
})

test('chat：没给模型名直接报错，且告诉用户下一步做什么', async () => {
  const mock = await startMock({})
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'invalid_input')
    assert.match(res.message, /获取模型清单|手动填/, '报错要给出下一步：先去拿清单或自己填一个')
    assert.equal(mock.seen.length, 0, '不该白打一次上游')
  } finally {
    await mock.close()
  }
})

test('chat：400 时把 error.message 提出来当详情（模型名不存在这类问题靠它定位）', async () => {
  const mock = await startMock({
    chat: { status: 400, body: JSON.stringify({ error: { message: "The model 'nope' does not exist" } }) },
  })
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl, { model: 'nope' }))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'http')
    assert.equal(res.status, 400)
    assert.match(res.detail ?? '', /does not exist/)
  } finally {
    await mock.close()
  }
})

test('chat：200 但没有正文 → bad_response，并保留原文片段', async () => {
  const mock = await startMock({ chat: { body: '{"choices":[]}' } })
  try {
    const res = await createOpenAiCompatProbe().chat(target(mock.baseUrl, { model: 'm' }))
    if (res.ok) throw new Error('应当判失败')
    assert.equal(res.code, 'bad_response')
    assert.match(res.detail ?? '', /choices/)
  } finally {
    await mock.close()
  }
})
