/**
 * `POST /api/ai/turn` 的**真 HTTP** 集成测试。
 *
 * ## 为什么值得再写一遍（而不是只留 loop 的单测）
 * loop 的单测证明"决策正确"，但它**证明不了阶段划分**——而本仓库最贵的一类
 * 历史缺陷恰好全在阶段划分上：状态码一旦写成 200 就永远改不回来，
 * 于是"根本没开始"被编码成了一条看起来正常的流（旧问答实现用
 * `status{mode:'retrieval-only'}` 干过这件事，本批才删掉）。
 * 只有真的起一个端口、真的读字节，才能断言"401/400/429/503 时**没有** SSE 头"。
 *
 * ## 夹具为什么比问答那套小得多
 * 本插件**不碰数据库、不做检索**（设计文档 §1：会话核心不含任何检索逻辑）。
 * 因此这里不需要 SQLite、不需要迁移、不需要策略层替身——只有：一个忠实实现
 * `HttpRouterService` 契约的测试内路由、一个脚本化的 provider、一个内存工具注册表。
 * 检索那半边由 `@geewiki/ai-kb` 自己的测试与 P1 验收脚本覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from 'cordis'
import type { HttpRouterService, Principal, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import { validateFrameSequence, type SseFrame } from '@geewiki/core'
import type { AiToolService, ResolvedTool } from '@geewiki/ai-tools'
import type { LlmChunk, LlmProvider, LlmService } from '@geewiki/llm'
import { createLlmService } from '@geewiki/llm'
import {
  AiAssistantPlugin,
  ASSISTANT_CAPABILITIES_PATH,
  TURN_PATH,
  type AiAssistantPluginOptions,
} from '../src/index.js'
import { SSE_EVENT_TOOL } from '../src/sse.js'

/* ============================ 测试内路由 ============================ */

interface TestRouter {
  readonly service: HttpRouterService
  /** 被 `closeStreams(owner)` 收掉的连接数（按 owner 记账） */
  readonly closed: string[]
  readonly rejected: number
  handle(req: IncomingMessage, res: ServerResponse): void
}

/**
 * 忠实实现插件用到的那几条契约：`register` / `noteStreamRejected` / `trackStream` /
 * `closeStreams`。其余方法（`drain` / `stats` …）在本文件里用不到，给最小可用的替身。
 *
 * ⚠️ 如实记录的限制：**生产 server 自身**的排空/关停行为不在这里验证
 * （那由 `packages/server/test/sse-drain.test.ts` 覆盖）。本文件验证的是
 * "本插件是否正确使用了契约"。
 */
function makeTestRouter(opts: { principal: Principal }): TestRouter {
  const routes: Array<{ method: string; path: string; handler: RouteHandler }> = []
  const streams = new Set<ServerResponse>()
  const closed: string[] = []
  const state = { rejected: 0 }

  const service = {
    register(method: string, path: string, handler: RouteHandler) {
      const entry = { method, path, handler }
      routes.push(entry)
      return () => {
        const i = routes.indexOf(entry)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    noteStreamRejected() {
      state.rejected++
    },
    trackStream(res: ServerResponse, owner?: string) {
      streams.add(res)
      void owner
      return () => streams.delete(res)
    },
    closeStreams(owner?: string) {
      closed.push(owner ?? '')
      for (const res of [...streams]) {
        if (!res.writableEnded) res.end()
      }
      streams.clear()
    },
    stats: () => ({ requests: 0, inflight: 0, streams: { active: streams.size, rejected: state.rejected } }),
    inflight: () => 0,
    pending: () => 0,
    drain: async () => true,
  } as unknown as HttpRouterService

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname)
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false}')
      return
    }
    let sent = false
    const h: RouteHandlerContext = {
      req,
      res,
      url,
      params: {},
      principal: opts.principal,
      json(status, body) {
        if (sent) return
        sent = true
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      },
      noteStatus() {
        /* 只记指标：本夹具不计 */
      },
    }
    route.handler(h)
  }

  return { service, closed, get rejected() { return state.rejected }, handle }
}

/* ============================ provider ============================ */

type Script = readonly ScriptRound[]
interface ScriptRound {
  readonly text?: string
  /** 推理型模型的思考内容（先于 `text` 产出，与真实上游同序） */
  readonly reasoning?: string
  readonly calls?: readonly { id: string; name: string; arguments: string }[]
  /** 收到请求后挂住不返回（用来测并发上限与断连取消） */
  readonly hang?: boolean
  readonly errorCode?: string
}

/**
 * 脚本化 provider。**直接注册进真实的 `createLlmService()`**——这样走的是真的
 * 注册表、真的 `available()` 判定与真的 chunk 归一，只有上游字节是假的。
 */
function scriptedProvider(scripts: Script, counter: { calls: number }): LlmProvider {
  let round = 0
  return {
    route: 'scripted',
    descriptor: {
      route: 'scripted',
      label: '脚本化上游',
      vendor: 'test',
      model: 'scripted-model',
      available: () => true,
    },
    stream(_req, o): AsyncIterable<LlmChunk> {
      const script = scripts[Math.min(round, scripts.length - 1)] ?? {}
      round++
      counter.calls++
      return (async function* generate(): AsyncGenerator<LlmChunk> {
        yield { type: 'status', provider: 'scripted', model: 'scripted-model' }
        if (script.hang === true) {
          await new Promise<void>((resolve) => {
            if (o.signal.aborted) return resolve()
            o.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          yield { type: 'error', code: 'ABORTED' }
          return
        }
        if (script.reasoning !== undefined && script.reasoning !== '') {
          yield { type: 'reasoning-delta', text: script.reasoning }
        }
        if (script.text !== undefined && script.text !== '') {
          yield { type: 'text-delta', text: script.text }
        }
        for (const [index, call] of (script.calls ?? []).entries()) {
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: '' }
          if (call.arguments !== '') yield { type: 'tool-call-delta', index, argumentsDelta: call.arguments }
        }
        if (script.errorCode !== undefined) {
          yield { type: 'error', code: script.errorCode as LlmChunk extends { code: infer C } ? C : never }
          return
        }
        yield {
          type: 'done',
          provider: 'scripted',
          model: 'scripted-model',
          finishReason: (script.calls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
        }
      })()
    },
  }
}

/* ============================ 工具替身 ============================ */

function memoryTools(tools: readonly ResolvedTool[]): AiToolService {
  return {
    list: () => tools,
    ownerOf: (name: string) => tools.find((t) => t.descriptor.name === name)?.owner,
  } as unknown as AiToolService
}

/**
 * 补上必需工具集（`search_kb`）。已有时原样返回，不重复添加。
 *
 * 与 `packages/plugin-ai-assistant/src/index.ts` 的 `REQUIRED_TOOL_NAMES` 是同一份事实——
 * 这里**刻意不 import 它**：夹具要能独立于实现表达"一个完整工具表长什么样"，
 * 否则实现把 `search_kb` 改名时，夹具会跟着一起改，而那条"必需工具集缺席要拒绝"的
 * 行为就没人再验了。
 */
function withRequiredTools(tools: readonly ResolvedTool[]): ResolvedTool[] {
  if (tools.some((t) => t.descriptor.name === 'search_kb')) return [...tools]
  return [fakeTool('search_kb', 'server'), ...tools]
}

function fakeTool(
  name: string,
  side: 'server' | 'client',
  content = '{"ok":true}',
): ResolvedTool {
  return {
    owner: 'test-owner',
    descriptor: { name, description: `${name} 的说明`, parameters: { type: 'object' }, side },
    execute: async () => ({ content }),
  }
}

/* ============================ 夹具 ============================ */

interface Harness {
  readonly port: number
  readonly calls: { calls: number }
  readonly router: TestRouter
  readonly dispose: () => void
  close(): Promise<void>
}

const USER: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'member',
  groupIds: [],
  sessionId: null,
}
const ANONYMOUS: Principal = {
  kind: 'anonymous',
  userId: null,
  orgId: null,
  orgRole: null,
  groupIds: [],
  sessionId: null,
}

async function makeHarness(
  opts: {
    script?: Script
    tools?: readonly ResolvedTool[]
    withLlm?: boolean
    withToolService?: boolean
    /** 刻意不补必需工具集——只有验"缺席即明确拒绝"的那条用例该用它 */
    omitRequiredTools?: boolean
    withHttp?: boolean
    principal?: Principal
    pluginOptions?: AiAssistantPluginOptions
  } = {},
): Promise<Harness> {
  const router = makeTestRouter({ principal: opts.principal ?? USER })
  const calls = { calls: 0 }
  const llm: LlmService = createLlmService()
  if (opts.withLlm ?? true) llm.register(scriptedProvider(opts.script ?? [{ text: '好。' }], calls))

  const services = new Map<string, unknown>()
  if (opts.withHttp ?? true) services.set('http', router.service)
  if (opts.withLlm ?? true) services.set('llm-service', llm)
  /*
   * 工具表**总是含 `search_kb`**（除显式要求省略时）。
   *
   * 它是本插件的必需工具集（决策 8 / 设计文档 §0.2）：缺席时 `/api/ai/turn` 会以
   * 503 `tools_unavailable` 明确拒绝。若夹具不补上它，**每一个**流式用例都会撞上那条拒绝，
   * 于是它们测的东西全部变成"必需工具集缺席"，而失败信息指向帧序列，离病因很远。
   * 补在这里而不是逐个用例加，是因为"有哪些工具"通常是这些用例的**背景**而不是被测对象。
   */
  if (opts.withToolService ?? true) {
    const listed = opts.tools ?? []
    const tools = opts.omitRequiredTools === true ? listed : withRequiredTools(listed)
    services.set('ai-tool-service', memoryTools(tools))
  }

  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => services.delete(name)
    },
  } as unknown as Context

  const dispose = AiAssistantPlugin.apply(ctx, {}, opts.pluginOptions ?? {}) as () => void
  const server: Server = createServer((req, res) => router.handle(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    calls,
    router,
    dispose,
    close: () =>
      new Promise<void>((resolve) => {
        dispose()
        server.close(() => resolve())
      }),
  }
}

/**
 * 用**给定的服务实例**（而不是由夹具新建）搭一个 harness。
 *
 * 存在的理由只有一个：制造"`llm-service` 在、但一条可用路由都没有"这个状态——
 * 它是 `NO_ADAPTER` 与 `code:null` 的分界，而两种"没有模型"该做的事相反。
 */
async function makeHarnessWithService(
  name: 'llm-service',
  value: unknown,
): Promise<{ port: number; close: () => Promise<void>; dispose: () => void }> {
  const router = makeTestRouter({ principal: USER })
  const services = new Map<string, unknown>([
    ['http', router.service],
    [name, value],
    ['ai-tool-service', memoryTools([fakeTool('search_kb', 'server')])],
  ])
  const ctx = {
    get: (n: string) => services.get(n),
    provide: (n: string, v: unknown) => {
      services.set(n, v)
      return () => services.delete(n)
    },
  } as unknown as Context
  const dispose = AiAssistantPlugin.apply(ctx, {}, {}) as () => void
  const server: Server = createServer((req, res) => router.handle(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    dispose,
    close: () =>
      new Promise<void>((resolve) => {
        dispose()
        server.close(() => resolve())
      }),
  }
}

/* ============================ HTTP 客户端 ============================ */

interface RawResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly text: string
}

function post(port: number, path: string, body: unknown, raw = false): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = raw ? (body as string) : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function get(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

/** 把 SSE 原始字节解析成帧（与客户端解码器同一套规范：`event:` 行 + 一到多行 `data:`） */
function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l !== '')
    if (lines.length === 0) continue
    const eventLine = lines.find((l) => l.startsWith('event: '))
    if (!eventLine) continue
    const data = lines
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice('data: '.length))
      .join('\n')
    frames.push({ event: eventLine.slice('event: '.length), data: JSON.parse(data) as unknown })
  }
  return frames
}

const isStream = (r: RawResponse): boolean =>
  String(r.headers['content-type'] ?? '').startsWith('text/event-stream')

const messages = [{ role: 'user', content: '主页上怎么新建内容？' }]

/* ============================ 阶段划分：前置判定必须是普通 JSON ============================ */

test('★ 匿名被拒：401 + **没有** SSE 头（界面不渲染拦不住任何东西，服务端这道才是真的）', async () => {
  const h = await makeHarness({ principal: ANONYMOUS })
  try {
    const r = await post(h.port, TURN_PATH, { messages })
    assert.equal(r.status, 401)
    assert.equal(isStream(r), false, '一旦写了 SSE 头，状态码就永远是 200，失败分流就没了依据')
    assert.equal(JSON.parse(r.text).error, 'unauthorized')
    assert.equal(h.calls.calls, 0, '被拒的请求不该花任何上游配额')
  } finally {
    await h.close()
  }
})

test('★ 非法请求体：400 + 没有 SSE 头，且不调用模型', async () => {
  const h = await makeHarness({})
  try {
    for (const body of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { msgs: [] }]) {
      const r = await post(h.port, TURN_PATH, body)
      assert.equal(r.status, 400, `${JSON.stringify(body)} 应 400`)
      assert.equal(isStream(r), false)
      assert.equal(JSON.parse(r.text).error, 'invalid_body')
    }
    assert.equal(h.calls.calls, 0)
  } finally {
    await h.close()
  }
})

test('畸形 JSON：400 invalid_json（而不是把异常冒成 500）', async () => {
  const h = await makeHarness({})
  try {
    const r = await post(h.port, TURN_PATH, '{"messages":', true)
    assert.equal(r.status, 400)
    assert.equal(JSON.parse(r.text).error, 'invalid_json')
  } finally {
    await h.close()
  }
})

test('★ 没有可用模型：503 + 没有 SSE 头（503 = 前置条件不满足，我们根本没调用过模型）', async () => {
  /*
   * 两种"没有模型"必须给**不同的 code**（照 `@geewiki/ai-qa` 的口径）：
   * - `llm-service` 整个不在 ⇒ `code: null`（这是**插件没激活**，不是"没有适配器"）；
   * - 服务在、但一条可用路由都没有 ⇒ `code: 'NO_ADAPTER'`（这才是"去查模型接入配置"）。
   * 把前者也说成 NO_ADAPTER，会让运维去翻一个根本没坏的地方。
   */
  const missingService = await makeHarness({ withLlm: false })
  try {
    const r = await post(missingService.port, TURN_PATH, { messages })
    assert.equal(r.status, 503)
    assert.equal(isStream(r), false)
    const body = JSON.parse(r.text) as { error: string; degraded: { code: string | null; message: string } }
    assert.equal(body.error, 'model_unavailable')
    assert.equal(body.degraded.code, null)
    assert.match(body.degraded.message, /llm-service 不可用/)
  } finally {
    await missingService.close()
  }

})

test('★ 有 llm-service 但一条可用路由都没有：503 且 code=NO_ADAPTER（指向"去查模型接入"）', async () => {
  // 手动塞一个**空的** llm 服务：服务在、注册表空 —— 这是 NO_ADAPTER 与 code:null 的分界
  const h = await makeHarnessWithService('llm-service', createLlmService())
  try {
    const r = await post(h.port, TURN_PATH, { messages })
    assert.equal(r.status, 503)
    assert.equal(isStream(r), false)
    const body = JSON.parse(r.text) as { error: string; degraded: { code: string | null } }
    assert.equal(body.error, 'model_unavailable')
    assert.equal(body.degraded.code, 'NO_ADAPTER')
  } finally {
    await h.close()
  }
})

/* ============================ 正常流 ============================ */

test('★ 正常一回合：帧序列合法（status → delta* → done），且 done 里带权威转录', async () => {
  const h = await makeHarness({ script: [{ text: '在首页右上角点「新建页面」。' }] })
  try {
    const r = await post(h.port, TURN_PATH, { messages, round: 0 })
    assert.equal(r.status, 200)
    assert.equal(isStream(r), true)
    assert.match(String(r.headers['content-type']), /text\/event-stream/)
    assert.equal(r.headers['x-accel-buffering'], 'no', '没有这个头，nginx 之类会把事件流攒成一次性响应')

    const frames = parseFrames(r.text)
    assert.equal(validateFrameSequence(frames), null, '帧序列必须满足平台不变量')
    assert.equal(frames[0]?.event, 'status')
    const delta = frames.find((f) => f.event === 'delta')
    assert.equal((delta?.data as { text: string }).text, '在首页右上角点「新建页面」。')
    const done = frames.at(-1)?.data as {
      answer: string
      finishReason: string
      messages: readonly { role: string }[]
      partial: boolean
      rounds: number
    }
    assert.equal(done.answer, '在首页右上角点「新建页面」。')
    assert.equal(done.finishReason, 'stop')
    assert.equal(done.partial, false)
    assert.equal(done.rounds, 1)
    assert.deepEqual(done.messages.map((m) => m.role), ['user', 'assistant'])
  } finally {
    await h.close()
  }
})

test('★ 思考帧：thinking 在 delta 之前，且不进 done.messages（老界面按未知帧静默忽略）', async () => {
  const h = await makeHarness({ script: [{ reasoning: '先想一下……', text: '答案。' }] })
  try {
    const r = await post(h.port, TURN_PATH, { messages, round: 0 })
    const frames = parseFrames(r.text)
    // thinking 是**中间帧**：平台的序列不变量对它不作名字约束（这正是它不必进 core 的原因）
    assert.equal(validateFrameSequence(frames), null)
    assert.deepEqual(frames.map((f) => f.event), ['status', 'thinking', 'delta', 'done'])
    assert.equal((frames[1]?.data as { text: string }).text, '先想一下……')
    const done = frames.at(-1)?.data as {
      answer: string
      messages: readonly { content: string }[]
    }
    assert.equal(done.answer, '答案。')
    assert.equal(
      done.messages.some((m) => m.content.includes('先想一下')),
      false,
      '思考内容不得进 done.messages（那份转录会被原样回传给上游）',
    )
  } finally {
    await h.close()
  }
})

test('status 帧带上本回合的工具表（界面据此说明"AI 现在能做哪些事"）', async () => {
  const h = await makeHarness({
    tools: [fakeTool('list_pages', 'server'), fakeTool('search_kb', 'server')],
    script: [{ text: 'ok' }],
  })
  try {
    const frames = parseFrames((await post(h.port, TURN_PATH, { messages })).text)
    const status = frames[0]?.data as { tools: readonly string[]; round: number; clientToolsAccepted: readonly string[] }
    assert.deepEqual(status.tools, ['list_pages', 'search_kb'])
    assert.equal(status.round, 0)
    assert.deepEqual(status.clientToolsAccepted, [])
  } finally {
    await h.close()
  }
})

test('★ 服务端工具在 HTTP 层真的被执行：中间有 tool 帧，done.toolResults 有记录', async () => {
  const h = await makeHarness({
    tools: [fakeTool('search_kb', 'server', '{"total":1}')],
    script: [
      { calls: [{ id: 'c1', name: 'search_kb', arguments: '{"q":"新建"}' }] },
      { text: '查到了。' },
    ],
  })
  try {
    const frames = parseFrames((await post(h.port, TURN_PATH, { messages })).text)
    assert.equal(validateFrameSequence(frames), null)
    const toolFrames = frames.filter((f) => f.event === SSE_EVENT_TOOL)
    assert.equal(toolFrames.length, 2, '一条 tool-start（ok:null）+ 一条 tool-end（ok:true）')
    assert.equal((toolFrames[0]?.data as { ok: boolean | null }).ok, null)
    assert.equal((toolFrames[1]?.data as { ok: boolean }).ok, true)
    const done = frames.at(-1)?.data as { toolResults: readonly { name: string; ok: boolean }[]; rounds: number }
    assert.equal(done.toolResults.length, 1)
    assert.equal(done.toolResults[0]?.name, 'search_kb')
    assert.equal(done.rounds, 2)
  } finally {
    await h.close()
  }
})

test('★ 收窄在 HTTP 层生效：客户端声明未注册的名字，不进 status.tools 也不被采纳', async () => {
  const h = await makeHarness({
    tools: [fakeTool('search_kb', 'server'), fakeTool('editor.replace', 'client')],
    script: [{ text: 'ok' }],
  })
  try {
    const frames = parseFrames(
      (await post(h.port, TURN_PATH, { messages, clientTools: ['editor.replace', 'evil.exfiltrate'] })).text,
    )
    const status = frames[0]?.data as { tools: readonly string[]; clientToolsAccepted: readonly string[] }
    assert.deepEqual(status.tools, ['search_kb', 'editor.replace'])
    assert.deepEqual(status.clientToolsAccepted, ['editor.replace'], '只有注册过的才算被采纳')
  } finally {
    await h.close()
  }
})

test('★ 客户端工具：done.finishReason=tool_calls + done.toolCalls，answer 为 null', async () => {
  const h = await makeHarness({
    tools: [fakeTool('editor.replace', 'client')],
    script: [{ calls: [{ id: 'k1', name: 'editor.replace', arguments: '{"text":"x"}' }] }],
  })
  try {
    const frames = parseFrames(
      (await post(h.port, TURN_PATH, { messages, clientTools: ['editor.replace'] })).text,
    )
    assert.equal(validateFrameSequence(frames), null)
    const done = frames.at(-1)?.data as {
      answer: null
      finishReason: string
      toolCalls: readonly { id: string; name: string }[]
    }
    assert.equal(done.finishReason, 'tool_calls')
    assert.equal(done.answer, null)
    assert.deepEqual(done.toolCalls.map((c) => c.id), ['k1'])
  } finally {
    await h.close()
  }
})

test('上游报错：以 error 帧收尾（流已经开始，就不能再改状态码了）', async () => {
  const h = await makeHarness({ script: [{ errorCode: 'RATE_LIMIT' }] })
  try {
    const r = await post(h.port, TURN_PATH, { messages })
    assert.equal(r.status, 200, '头已经写过了，状态码只能是 200；失败由流内的 error 帧表达')
    const frames = parseFrames(r.text)
    assert.equal(validateFrameSequence(frames), null)
    assert.equal(frames.at(-1)?.event, 'error')
    const data = frames.at(-1)?.data as { code: string; message: string }
    assert.equal(data.code, 'RATE_LIMIT')
    assert.match(data.message, /是它拒绝了或没能及时返回/)
  } finally {
    await h.close()
  }
})

test('★ 一个回合的帧序列对**每条**路径都满足平台不变量（终止帧恰一帧且在末位）', async () => {
  const cases: Script[] = [
    [{ text: '直接答' }],
    [{ text: '' }],
    [{ calls: [{ id: 'c1', name: 't', arguments: '{}' }] }, { text: '答' }],
    [{ calls: [{ id: 'c1', name: '不存在', arguments: '{}' }] }, { text: '答' }],
    [{ errorCode: 'TIMEOUT' }],
  ]
  for (const script of cases) {
    const h = await makeHarness({ tools: [fakeTool('t', 'server')], script })
    try {
      const frames = parseFrames((await post(h.port, TURN_PATH, { messages })).text)
      assert.equal(validateFrameSequence(frames), null, `脚本 ${JSON.stringify(script)} 的帧序列违规`)
    } finally {
      await h.close()
    }
  }
})

/* ============================ 生命周期 ============================ */

test('★ 并发上限：占满之后新连接得 429（且普通 JSON，不是一条"看起来开始了"的流）', async () => {
  const h = await makeHarness({
    script: [{ hang: true }],
    pluginOptions: { maxConcurrentStreams: 1 },
  })
  try {
    const first = post(h.port, TURN_PATH, { messages })
    // 等第一个流真正占住名额（它挂在 hang 上不会自己结束）
    await new Promise((r) => setTimeout(r, 120))
    const second = await post(h.port, TURN_PATH, { messages })
    assert.equal(second.status, 429)
    assert.equal(isStream(second), false)
    assert.equal(JSON.parse(second.text).error, 'too_many_streams')
    assert.equal(h.router.rejected, 1, '被拒必须上报，否则 /api/health 看不见有人在被拒')
    const r1 = await first
    assert.equal(r1.status, 200)
  } finally {
    await h.close()
  }
})

test('★ 卸载插件：按 owner 定向收连接，挂住的流被收掉（不是等它自己超时）', async () => {
  const h = await makeHarness({
    script: [{ hang: true }],
    pluginOptions: { maxConcurrentStreams: 4 },
  })
  const pending = post(h.port, TURN_PATH, { messages })
  // 等第一个流真正占住名额（它挂在 hang 上不会自己结束）
  await new Promise((r) => setTimeout(r, 120))
  h.dispose()
  const r = await pending
  assert.ok(r.status === 200 || r.status === 0, '连接被收掉，但已写出的帧仍然是完整的')
  assert.deepEqual(h.router.closed, ['@geewiki/ai-assistant'], 'closeStreams 必须按 owner 定向回收')
  h.dispose() // 幂等
  // 必须关掉监听句柄：node --test 会等事件循环排空，一个还listen着的服务器会让整轮挂到超时
  await h.close()
})

test('★ 卸载发生在"读完请求体之前"：该请求必须以 503 显式拒绝（disposed 分支的真实可达路径）', async () => {
  /*
   * `handleTurn` 在读完 body 之后**再判一次** `disposed`。这条判定不是死代码，
   * 但它的可达窗口很窄：卸载会同步注销路由，所以**新**请求根本进不来（404）。
   * 唯一能走进来的，是那些"已经进了处理函数、正卡在 `await readBody` 上"的请求——
   * 若没有这道判定，它们会给一个已卸载的插件登记长连接，而 teardown 的
   * `closeStreams(owner)` 已经跑过了 ⇒ 连接悬着直到超时。
   *
   * 故这里刻意**分两段发 body**：发一半 → 卸载 → 再发另一半，把请求精确地卡在那个窗口里。
   */
  const h = await makeHarness({ script: [{ text: 'x' }] })
  const payload = JSON.stringify({ messages })
  const result = await new Promise<RawResponse>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: h.port,
        method: 'POST',
        path: TURN_PATH,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.write(payload.slice(0, 10))
    setTimeout(() => {
      h.dispose() // ← 请求此刻正卡在 readBody 上
      req.end(payload.slice(10))
    }, 60)
  })
  assert.equal(result.status, 503)
  assert.equal(isStream(result), false)
  assert.equal(JSON.parse(result.text).error, 'unavailable')
  await h.close()
})

test('卸载之后**新**请求拿 404（路由已注销）——这不是缺陷，是"必须失败关闭"的另一种表现', async () => {
  const h = await makeHarness({ script: [{ text: 'x' }] })
  h.dispose()
  const r = await post(h.port, TURN_PATH, { messages })
  assert.equal(r.status, 404, '路由已随插件卸载注销；绝不能出现"端点还在、只是少给内容"')
  await h.close()
})

test('缺少 http-service 时 apply 直接抛错（不静默激活一个没有任何端点的插件）', async () => {
  await assert.rejects(
    () => makeHarness({ withHttp: false }),
    /http-service 不可用/,
  )
})

/* ============================ 能力探测 ============================ */

test('capabilities：模型可用 + 工具表按主体给出', async () => {
  const h = await makeHarness({ tools: [fakeTool('search_kb', 'server'), fakeTool('editor.replace', 'client')] })
  try {
    const r = await get(h.port, ASSISTANT_CAPABILITIES_PATH)
    assert.equal(r.status, 200)
    const body = JSON.parse(r.text) as { available: boolean; tools: readonly string[]; missing: readonly string[] }
    assert.equal(body.available, true)
    assert.deepEqual(body.tools, ['search_kb'], '未被声明的客户端工具不进能力表')
    assert.deepEqual(body.missing, [])
  } finally {
    await h.close()
  }
})

test('capabilities：没有模型时 available=false 且 missing 点名是哪一半缺了', async () => {
  const h = await makeHarness({ withLlm: false })
  try {
    const body = JSON.parse((await get(h.port, ASSISTANT_CAPABILITIES_PATH)).text) as {
      available: boolean
      missing: readonly string[]
    }
    assert.equal(body.available, false)
    assert.ok(body.missing.includes('llm-service'))
  } finally {
    await h.close()
  }
})

test('capabilities：匿名主体拿到空工具表（不泄露当前主体看不见的工具名）', async () => {
  const h = await makeHarness({ principal: ANONYMOUS, tools: [fakeTool('search_kb', 'server')] })
  try {
    const body = JSON.parse((await get(h.port, ASSISTANT_CAPABILITIES_PATH)).text) as { tools: readonly string[] }
    assert.deepEqual(body.tools, [])
  } finally {
    await h.close()
  }
})

/* ==================== 决策 8：必需工具集缺席 ⇒ 明确不可用，不偷偷降级 ==================== */

test('★ 必需工具集缺席：capabilities 的 available 必须是 false，并点名缺哪一条', async () => {
  /*
   * 只看模型的话，停掉 `@geewiki/ai-kb` 之后这个端点照样回答 `available: true`，
   * 而助手已经静默退化成一个通用聊天机器人了——用户从响应里看不出任何区别。
   * 这正是旧版 `mode:'retrieval-only'` 被删掉时反对的那件事，只是换了个位置发生。
   */
  const h = await makeHarness({ omitRequiredTools: true, tools: [] })
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}${ASSISTANT_CAPABILITIES_PATH}`)
    const body = (await res.json()) as { available: boolean; missing: readonly string[] }
    assert.equal(body.available, false, '没有知识库工具就不是知识库助手')
    assert.ok(body.missing.includes('tool:search_kb'), `missing 应点名缺哪一条，实际 ${JSON.stringify(body.missing)}`)
  } finally {
    await h.close()
  }
})

test('★ 必需工具集缺席：/api/ai/turn 以 503 tools_unavailable 拒绝，且**没有 SSE 头**', async () => {
  const h = await makeHarness({ omitRequiredTools: true, tools: [] })
  try {
    const res = await post(h.port, TURN_PATH, { messages })
    assert.equal(res.status, 503)
    assert.equal(res.headers['content-type']?.includes('text/event-stream') ?? false, false, '前置条件不满足绝不能用 SSE 表达')
    const body = JSON.parse(res.text) as { error: string; missing: readonly string[] }
    assert.equal(body.error, 'tools_unavailable')
    assert.deepEqual(body.missing, ['search_kb'])
    // 一次上游调用都不该发生（判据在写头之前，模型没被调用过）
    assert.equal(h.calls.calls, 0)
  } finally {
    await h.close()
  }
})

test('必需工具集在位时一切照常（确认上一条拒绝的是"缺席"，不是别的）', async () => {
  const h = await makeHarness({ tools: [], script: [{ text: '好。' }] })
  try {
    const res = await post(h.port, TURN_PATH, { messages })
    assert.equal(res.status, 200)
    assert.match(res.text, /event: done/)
  } finally {
    await h.close()
  }
})
