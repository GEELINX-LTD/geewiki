/**
 * `POST /api/ai/stream` 的真 HTTP 集成测试。
 *
 * **测试策略**：真 `node:http` 端口 + 真 SSE 字节 + 真 `@geewiki/search`（真 SQLite/FTS5）+
 * 真 `@geewiki/llm` 服务（只有 provider 是脚本化的 mock）。
 *
 * 关于路由层的说明（必须如实记录的限制）：本仓库的 `HttpRouter` 类**未导出**，
 * 而 `@geewiki/server` 既不在本包依赖里、加进来还会形成依赖环（server 依赖 plugin-ai），
 * 因此这里用一个**忠实实现 `HttpRouterService` 契约**的测试内路由（含 `noteStatus`、
 * `trackStream`、在途计数与 `drain` 语义）。也就是说：本文件验证的是"本插件是否正确
 * 使用了契约"，而**生产 server 自身**的排空/关停行为由 `packages/server/test/sse-drain.test.ts`
 * 与 `router.test.ts` 覆盖，真实生产链路由隔离实例的 `curl -N` 端到端覆盖。
 *
 * 绝不触碰仓库的 `data/geewiki.db`：每个用例用自己的临时库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { SqliteDatabase } from '@geewiki/db-sqlite'
import { SEARCH_MIGRATIONS_DIR, SearchPlugin } from '@geewiki/search'
import { createLlmService, type LlmChunk, type LlmProvider, type LlmService } from '@geewiki/llm'
import type { HttpRouterService, Principal, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import {
  AiPlugin,
  MAX_CONCURRENT_STREAMS,
  SSE_EVENT_DELTA,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  SSE_EVENT_STATUS,
  validateFrameSequence,
  type AiConfig,
  type AiStreamEvent,
  type StreamDeltaData,
  type StreamDoneData,
  type StreamErrorData,
  type StreamStatusData,
} from '../src/index.js'

/* ============================ 测试内路由 ============================ */

/**
 * ★ P2：请求主体（匿名）。
 *
 * `handleStream` 在**写任何 SSE 帧之前**先取 `h.principal`，取不到就返 401 —— 因为
 * 一旦写了 SSE 头，状态码就定型为 200，调用方再也无法从协议层看出这次是被拒的。
 * 故本文件的测试内路由必须像生产路由那样挂上主体，否则所有流式用例都会拿到 401。
 */
const TEST_PRINCIPAL: Principal = {
  kind: 'anonymous',
  userId: null,
  orgId: null,
  orgRole: null,
  groupIds: [],
  sessionId: null,
}

interface TestRouter {
  service: HttpRouterService
  /** 请求分发入口（挂到真实 node:http 服务上） */
  handle(req: IncomingMessage, res: ServerResponse): void
  /** 结束全部长连接（模拟生产 `HttpRouter.closeStreams()`） */
  closeStreams(): void
  /** 当前在途处理器数 */
  inflight(): number
  /** trackStream 收到的 owner 列表（按调用顺序；用于断言"插件登记的 owner 是自己的名字"） */
  trackedOwners(): string[]
  /** noteStreamRejected 被调用的次数（用于断言并发上限被拒时确实上报了） */
  rejectedCount(): number
}

/**
 * 忠实实现 `HttpRouterService` 契约的路由。
 *
 * 关键语义（与 `packages/server/src/index.ts` 的 dispatch 一致，本批依赖它）：
 * - 处理器**同步返回**（非 thenable）⇒ 当拍结算在途；
 * - 返回 thenable ⇒ 结算挂到 Promise 上（长连接若这样写就会占住排空）。
 */
function makeTestRouter(opts: { drainTimeoutMs?: number } = {}): TestRouter {
  const routes: { method: string; segments: string[]; handler: RouteHandler }[] = []
  const activeStreams = new Set<ServerResponse>()
  const owners: string[] = []
  let rejected = 0
  let inFlight = 0
  const isThenable = (v: unknown): v is PromiseLike<unknown> =>
    typeof (v as { then?: unknown } | null)?.then === 'function'

  const service: HttpRouterService = {
    register: (method, path, handler) => {
      const entry = { method, segments: path.split('/').filter(Boolean), handler }
      routes.push(entry)
      return () => {
        const i = routes.indexOf(entry)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
    inflight: () => inFlight,
    pending: () => inFlight,
    drain: (timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        if (inFlight === 0) {
          resolve(true)
          return
        }
        const started = Date.now()
        const timer = setInterval(() => {
          if (inFlight === 0) {
            clearInterval(timer)
            resolve(true)
          } else if (Date.now() - started >= timeoutMs) {
            clearInterval(timer)
            // 与生产同款告警文案（本批要证明的就是"这条路不会被 SSE 触发"）
            console.warn(`[@geewiki/http] 排空超时（${timeoutMs}ms，仍有 ${inFlight} 个请求在途），强制关闭监听`)
            resolve(false)
          }
        }, 2)
      }),
    trackStream: (res: ServerResponse, owner?: string) => {
      owners.push(owner ?? '')
      activeStreams.add(res)
      let released = false
      return () => {
        if (released) return
        released = true
        activeStreams.delete(res)
      }
    },
    noteStreamRejected: () => {
      rejected++
    },
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean)
    const json = (status: number, body: unknown): void => {
      if (res.writableEnded || res.destroyed) return
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const noteStatus = (): void => {
      /* 指标非本文件关注点（生产实现见 server 包） */
    }
    for (const route of routes) {
      if (route.method !== req.method || route.segments.length !== segments.length) continue
      if (route.segments.some((seg, i) => seg !== segments[i])) continue
      const h: RouteHandlerContext = {
        req,
        res,
        url,
        params: {},
        json,
        noteStatus,
        // ★ P2：主体必须挂上（见文件头 TEST_PRINCIPAL 的说明）
        principal: TEST_PRINCIPAL,
      }
      inFlight++
      try {
        const result: unknown = route.handler(h)
        if (isThenable(result)) {
          void Promise.resolve(result).then(
            () => inFlight--,
            () => inFlight--,
          )
        } else {
          inFlight--
        }
      } catch {
        json(500, { ok: false, error: 'internal' })
        inFlight--
      }
      return
    }
    json(404, { ok: false, error: 'not_found' })
  }

  return {
    service,
    handle,
    inflight: () => inFlight,
    trackedOwners: () => [...owners],
    rejectedCount: () => rejected,
    closeStreams: () => {
      for (const res of [...activeStreams]) {
        try {
          res.end()
        } catch {
          /* 已断开 */
        }
      }
      activeStreams.clear()
    },
  }
}

/* ============================ mock provider ============================ */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 可中止的等待：abort 时立刻抛出 AbortError（与真实 fetch 的行为一致） */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

type Step = LlmChunk | number // number = 先等这么多毫秒

interface ScriptedProviderOptions {
  route?: string
  label?: string
  /** 脚本步骤：数字=延时，其它=直接产出的 chunk */
  steps: readonly Step[]
  available?: boolean
  /** 观察到 abort 时回调（用于断言"客户端断连 → 上游被取消"） */
  onAbort?: () => void
  /** 生成器结束时回调 */
  onFinish?: () => void
}

function scriptedProvider(o: ScriptedProviderOptions): LlmProvider {
  const route = o.route ?? 'mock'
  return {
    route,
    descriptor: {
      route,
      label: o.label ?? 'Mock 模型',
      vendor: 'mock',
      model: 'mock-1',
      available: () => o.available ?? true,
    },
    async *stream(_req, { signal }) {
      try {
        for (const step of o.steps) {
          if (signal.aborted) throw abortError()
          if (typeof step === 'number') {
            await abortableSleep(step, signal)
            continue
          }
          yield step
        }
      } catch (err) {
        if (signal.aborted || (err as Error).name === 'AbortError') {
          o.onAbort?.()
        }
        throw err
      } finally {
        o.onFinish?.()
      }
    },
  }
}

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/** 一份"生成成功"的脚本：两段增量 + done */
const OK_STEPS: readonly Step[] = [
  { type: 'status', provider: 'mock', model: 'mock-1' },
  60,
  { type: 'text-delta', text: '根据资料，' },
  60,
  { type: 'text-delta', text: '答案是 42。' },
  { type: 'done', provider: 'mock', model: 'mock-1', usage: { promptTokens: 7, completionTokens: 5 } },
]

/* ============================ harness ============================ */

interface Harness {
  port: number
  db: SqliteDatabase
  disposePlugin(): void
  /** 结束全部长连接（模拟 http 插件自身 teardown） */
  closeStreams(): void
  inflight(): number
  /** trackStream 收到的 owner 列表 */
  trackedOwners(): string[]
  /** noteStreamRejected 的调用次数 */
  rejectedCount(): number
  putPage(slug: string, title: string, content: string): void
  close(): Promise<void>
}

async function makeHarness(
  opts: { ai?: AiConfig; provider?: LlmProvider; withSearch?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ai-stream-'))
  const db = new SqliteDatabase(join(dir, 'test.db'))
  db.open()
  db.migrate(SEARCH_MIGRATIONS_DIR)

  const router = makeTestRouter()
  const llm: LlmService = createLlmService()
  if (opts.provider) llm.register(opts.provider)

  /*
   * ★ P2：策略层替身。本夹具用**真实** `SearchPlugin`，它现在依赖 `policy-service`；
   * 缺席时它会显式抛错（拒绝返回结果），于是检索全部降级、流式用例会以
   * "看起来像功能坏了"的方式红掉。默认"库里所有页面可见"，与 P2 之前语义一致。
   */
  const policyService = {
    visibleSlugs: (_principal: Principal, _q?: { levels?: readonly string[] }): Promise<string[]> =>
      Promise.resolve(db.query<{ slug: string }>('SELECT slug FROM pages ORDER BY slug').map((r) => r.slug)),
  }

  const services = new Map<string, unknown>([
    ['db', db],
    ['http', router.service],
    ['llm-service', llm],
    ['policy-service', policyService],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => {
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as Context

  if (opts.withSearch ?? true) SearchPlugin.apply(ctx, { limit: 20, snippetRadius: 48 })
  const disposePlugin = AiPlugin.apply(ctx, opts.ai ?? {}) as () => void

  const server: Server = createServer((req, res) => router.handle(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    db,
    disposePlugin,
    closeStreams: router.closeStreams,
    inflight: router.inflight,
    trackedOwners: router.trackedOwners,
    rejectedCount: router.rejectedCount,
    putPage: (slug, title, content) => {
      db.run('INSERT INTO pages (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        slug,
        title,
        content,
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      ])
    },
    close: async () => {
      router.closeStreams()
      await new Promise<void>((r) => server.close(() => r()))
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/* ============================ SSE 客户端 ============================ */

interface ParsedFrame {
  event: string
  data: Record<string, unknown>
  at: number
}

interface StreamOutcome {
  status: number
  contentType: string | undefined
  raw: string
  frames: ParsedFrame[]
  /** 每帧到达的相对时间（毫秒，相对请求发起） */
  timeline: { status?: number; firstDelta?: number; done?: number; error?: number }
  /** 客户端是否**自己**放弃了请求（用于区分"服务端收拢了连接"与"客户端等不下去"） */
  aborted: boolean
  /** 响应真正结束的时刻（相对请求发起）；客户端放弃时为 undefined */
  endedAt?: number
}

/**
 * 发一个流式请求并**逐块**解析帧（而不是等整个响应体），这样才能取证"增量性"：
 * 我们要证明的是"done 到达之前就已经收到了 delta"，而不是"响应体里有 delta"。
 */
function postStream(
  port: number,
  body: unknown,
  opts: { destroyAfterFirstDelta?: boolean; destroyAfterStatus?: boolean; bailMs?: number } = {},
): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let settled = false
    const settle = (out: StreamOutcome): void => {
      if (settled) return
      settled = true
      resolve(out)
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/ai/stream',
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (res) => {
        const out: StreamOutcome = {
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'],
          raw: '',
          frames: [],
          timeline: {},
          aborted: false,
        }
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          out.raw += chunk
          buffer += chunk
          let idx = buffer.indexOf('\n\n')
          while (idx >= 0) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const evLine = block.split('\n').find((l) => l.startsWith('event: '))
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
            if (evLine && dataLine) {
              const event = evLine.slice('event: '.length).trim()
              const at = Date.now() - started
              let data: Record<string, unknown> = {}
              try {
                data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>
              } catch {
                data = { __unparsable: dataLine }
              }
              out.frames.push({ event, data, at })
              if (event === SSE_EVENT_STATUS && out.timeline.status === undefined) out.timeline.status = at
              if (event === SSE_EVENT_DELTA && out.timeline.firstDelta === undefined) {
                out.timeline.firstDelta = at
                // 断连用例：收到首个增量后立刻掐断 socket
                if (opts.destroyAfterFirstDelta) {
                  out.aborted = true
                  req.destroy()
                }
              }
              if (event === SSE_EVENT_DONE) out.timeline.done = at
              if (event === SSE_EVENT_ERROR) out.timeline.error = at
            }
            idx = buffer.indexOf('\n\n')
          }
          if (opts.destroyAfterStatus && out.timeline.status !== undefined && !out.aborted) {
            out.aborted = true
            req.destroy()
          }
        })
        // 服务端正常收尾：记录结束时刻（这是"连接被服务端收拢"的可观测证据）
        res.on('end', () => {
          out.endedAt = Date.now() - started
          settle(out)
        })
        // 连接被中断（服务端 destroy 或客户端主动断）：标记 aborted
        res.on('aborted', () => {
          out.aborted = true
        })
        res.on('error', () => {
          out.aborted = true
          settle(out)
        })
      },
    )
    req.on('error', () => {
      /* 断连用例会主动 destroy：错误不是失败 */
    })
    req.end(payload)
    setTimeout(() => {
      // 兜底：挂起时不要把测试拖死。**必须标记 aborted**——否则"客户端等不下去"
      // 会被误读成"服务端正常收尾收尾"，本批确实因此写出过一条空转断言（变异实验抓出来的）。
      if (!settled) {
        const stub: StreamOutcome = {
          status: 0,
          contentType: undefined,
          raw: '',
          frames: [],
          timeline: {},
          aborted: true,
        }
        stub.aborted = true
        req.destroy()
        settle(stub)
      }
    }, opts.bailMs ?? 8_000).unref()
  })
}

/** 断言帧序列合法并返回事件数组 */
function toEvents(out: StreamOutcome): AiStreamEvent[] {
  const events = out.frames.map((f) => ({ event: f.event, data: f.data }) as unknown as AiStreamEvent)
  const violation = validateFrameSequence(events)
  assert.equal(violation, null, `帧序列违反协议不变量: ${violation}\n帧: ${JSON.stringify(out.frames)}`)
  return events
}

/*
 * 类型安全的取值器：`AiStreamEvent` 是可判别联合，直接 `as` 某个分支会被 TS 拒绝
 * （也确实该拒绝——断言失败时我们要的是清晰的错误信息，而不是一个错误的强制转换）。
 * 每个取值器都先断言事件名，再返回**已收窄**的 data。
 */
function statusOf(events: readonly AiStreamEvent[]): StreamStatusData {
  const first = events[0]
  assert.equal(first?.event, SSE_EVENT_STATUS, `首帧必须是 status，实际 ${String(first?.event)}`)
  return (first as { data: StreamStatusData }).data
}

function doneOf(events: readonly AiStreamEvent[]): StreamDoneData {
  const last = events[events.length - 1]
  assert.equal(last?.event, SSE_EVENT_DONE, `末帧必须是 done，实际 ${String(last?.event)}`)
  return (last as { data: StreamDoneData }).data
}

function errorOf(events: readonly AiStreamEvent[]): StreamErrorData {
  const last = events[events.length - 1]
  assert.equal(last?.event, SSE_EVENT_ERROR, `末帧必须是 error，实际 ${String(last?.event)}`)
  return (last as { data: StreamErrorData }).data
}

function deltasOf(events: readonly AiStreamEvent[]): string[] {
  return events
    .filter((e) => e.event === SSE_EVENT_DELTA)
    .map((e) => (e as { data: StreamDeltaData }).data.text)
}

/* ============================ 用例 ============================ */

test('增量性（核心）：done 到达之前就收到了 delta —— 流式真的成立，而非攒完再发', async () => {
  const h = await makeHarness({
    provider: scriptedProvider({ steps: OK_STEPS }),
  })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料，再做抽取式摘要。')
    const out = await postStream(h.port, { q: '检索增强怎么做' })
    assert.equal(out.status, 200)
    assert.match(out.contentType ?? '', /^text\/event-stream/, '必须是事件流而非 JSON')

    const events = toEvents(out)
    assert.equal(events[0]?.event, SSE_EVENT_STATUS, 'status 必须是第一帧')
    const deltas = deltasOf(events)
    assert.ok(deltas.length >= 2, `应收到多个增量帧，实际 ${deltas.length}`)
    assert.equal(events[events.length - 1]?.event, SSE_EVENT_DONE)

    // **增量性证据**：首个 delta 的到达时刻严格早于 done
    assert.ok(out.timeline.firstDelta !== undefined, '必须收到 delta')
    assert.ok(out.timeline.done !== undefined, '必须收到 done')
    assert.ok(
      out.timeline.firstDelta! < out.timeline.done!,
      `首个 delta(${out.timeline.firstDelta}ms) 必须早于 done(${out.timeline.done}ms)`,
    )
    // 两个增量之间有 60ms 延时：若实现是"攒完再发"，两个 delta 会与 done 同一时刻到达
    const deltaTimes = out.frames.filter((f) => f.event === SSE_EVENT_DELTA).map((f) => f.at)
    assert.ok(
      deltaTimes[deltaTimes.length - 1]! - deltaTimes[0]! >= 40,
      `多个 delta 应分散在不同时刻（证明边收边发），实际 ${JSON.stringify(deltaTimes)}`,
    )
    // 拼接后的文本应等于 provider 产出的全文
    assert.equal(deltas.join(''), '根据资料，答案是 42。')
    const done = doneOf(events)
    assert.equal(done.answer, '根据资料，答案是 42。')
    assert.deepEqual(done.usage, { promptTokens: 7, completionTokens: 5 })
    assert.equal(done.partial, false)
  } finally {
    await h.close()
  }
})

test('无密钥降级：走同一契约（status 带 degraded、mode=retrieval-only，done 给抽取式摘要，HTTP 200）', async () => {
  // 不注册任何 provider：`@geewiki/llm` 内部只有 NULL_PROVIDER ⇒ 恒不可用
  const h = await makeHarness()
  try {
    h.putPage('kb-1', '插件化知识库', '这是一个插件化的知识库系统，支持热插拔与全文检索。')
    const out = await postStream(h.port, { q: '插件化知识库' })
    assert.equal(out.status, 200, '没有 key 绝不能用 4xx 表达')

    const events = toEvents(out)
    const status = statusOf(events)
    // 降级必须在**第一帧**就告诉前端，用户才知道为什么没有 token
    assert.equal(status.mode, 'retrieval-only')
    assert.ok(status.degraded, 'status 必须带降级说明')
    assert.equal(status.degraded?.reason, 'no_provider')
    assert.equal(status.degraded?.code, 'NO_ADAPTER')
    assert.ok(status.sources.length > 0, '来源不得因为缺模型而丢失')

    // 降级不是失败：终结帧是 done 而不是 error
    assert.equal(
      events[events.length - 1]!.event,
      SSE_EVENT_DONE,
      '设计内降级必须以 done 收尾（用 error 表达"没有 key"就违背核心承诺）',
    )
    const done = doneOf(events)
    assert.ok(done.answer, 'done 必须带抽取式摘要')
    assert.equal(done.answerFormat, 'plain')
    assert.equal(done.partial, false)
    assert.equal(events.filter((e) => e.event === SSE_EVENT_DELTA).length, 0, '无 provider 时不应有 delta')
  } finally {
    await h.close()
  }
})

test('生成失败（provider 可用但上游报错）→ error 帧；与"设计内降级"明确区分', async () => {
  // provider 存在且 available ✅，但上游返回 AUTH 错误 ⇒ 这是**失败**，不是降级
  const h = await makeHarness({
    provider: scriptedProvider({
      steps: [{ type: 'status', provider: 'mock', model: 'mock-1' }, { type: 'error', code: 'AUTH' }],
    }),
  })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    const out = await postStream(h.port, { q: '检索增强' })
    assert.equal(out.status, 200)
    const events = toEvents(out)

    // status 帧宣告"将尝试生成"（有可用 provider）
    const status = statusOf(events)
    assert.equal(status.mode, 'rag')
    assert.equal(status.degraded, null, '开流时有可用 provider，故 status 不应带降级')

    const err = errorOf(events)
    assert.equal(err.code, 'AUTH', 'code 必须可判别（调用方按 code 分支）')
    assert.ok(err.message.length > 0)
  } finally {
    await h.close()
  }
})

test('error 帧的 message 已脱敏：上游回显的疑似密钥不得进入事件流', async () => {
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const h = await makeHarness({
    // 把疑似密钥放进路由 label：它会被拼进降级说明（真实上游报错也会这样回显）
    provider: scriptedProvider({
      route: 'leaky',
      label: `泄漏路由 ${secret}`,
      steps: [{ type: 'error', code: 'AUTH' }],
    }),
  })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    const out = await postStream(h.port, { q: '检索增强' })
    const events = toEvents(out)
    assert.equal(events[events.length - 1]!.event, SSE_EVENT_ERROR)
    errorOf(events)
    // 关键断言：整个事件流（含所有帧）里都不得出现密钥
    assert.equal(out.raw.includes(secret), false, `疑似密钥泄漏进了事件流: ${out.raw}`)
    assert.ok(out.raw.includes('***'), '应看到脱敏标记，证明确实经过了 redact')
  } finally {
    await h.close()
  }
})

test('超时：上游卡死 → error{TIMEOUT} 帧（用注入的极小超时在真链路验证）', async () => {
  const h = await makeHarness({
    ai: { streamIdleTimeoutMs: 80, streamHardTimeoutMs: 5_000 },
    // 只有一段超长延时：永远等不到数据 ⇒ 必然触发空闲超时
    provider: scriptedProvider({ steps: [10_000] }),
  })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    const out = await postStream(h.port, { q: '检索增强' })
    const events = toEvents(out)
    const err = errorOf(events)
    assert.equal(err.code, 'TIMEOUT')
    assert.match(err.message, /超时/)
  } finally {
    await h.close()
  }
})

test('客户端断连 → 立刻取消上游，且并发计数归还（可再开满额流）', async () => {
  let aborted = 0
  const h = await makeHarness({
    provider: scriptedProvider({
      steps: [
        { type: 'status', provider: 'mock', model: 'mock-1' },
        40,
        { type: 'text-delta', text: '第一段' },
        3_000, // 之后长时间挂住，等客户端断连
        { type: 'text-delta', text: '永远不该到达' },
        { type: 'done', provider: 'mock', model: 'mock-1' },
      ],
      onAbort: () => {
        aborted++
      },
    }),
  })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    const out = await postStream(h.port, { q: '检索增强' }, { destroyAfterFirstDelta: true })
    assert.ok(out.timeline.firstDelta !== undefined, '断连前应已收到首个增量')
    // 等待 abort 传到上游
    for (let i = 0; i < 40 && aborted === 0; i++) await sleep(25)
    assert.equal(aborted, 1, '客户端断连必须让上游观察到取消（否则白烧配额）')

    // 并发计数归还：能连续开满 MAX_CONCURRENT_STREAMS 条新流（泄漏的话最后一条会 429）
    const outs = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_STREAMS }, () => postStream(h.port, { q: '检索增强' })),
    )
    for (const o of outs) {
      assert.match(
        o.contentType ?? '',
        /^text\/event-stream/,
        `断连后应能重新开满并发流，实际拿到 ${o.status} ${o.contentType}`,
      )
    }
  } finally {
    await h.close()
  }
})

test('并发上限：第 cap+1 条返回 429（普通 JSON，且未写 SSE 头）', async () => {
  const h = await makeHarness({
    // 每条流都挂住，以便占满并发额度
    provider: scriptedProvider({
      steps: [{ type: 'status', provider: 'mock', model: 'mock-1' }, 10_000],
    }),
    ai: { streamIdleTimeoutMs: 20_000, streamHardTimeoutMs: 20_000 },
  })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    // 先占满
    const held = Array.from({ length: MAX_CONCURRENT_STREAMS }, () => postStream(h.port, { q: '检索增强' }))
    // 等到第 cap 条也真正建立（收到 status 帧即证明已登记）
    await sleep(120)
    const overflow = await postStream(h.port, { q: '检索增强' })
    assert.equal(overflow.status, 429, `超限必须 429，实际 ${overflow.status}`)
    assert.match(overflow.contentType ?? '', /application\/json/, '超限必须是普通 JSON')
    assert.equal(overflow.raw.includes('event:'), false, '超限时绝不能已写出 SSE 头/帧')
    const body = JSON.parse(overflow.raw) as { error: string }
    assert.equal(body.error, 'too_many_streams')
    await Promise.all(held)
  } finally {
    await h.close()
  }
})

test('卸载自清：流活跃时卸载插件 → 迅速收拢、无假"排空超时"告警、客户端收到流终止', async () => {
  const h = await makeHarness({
    provider: scriptedProvider({
      steps: [{ type: 'status', provider: 'mock', model: 'mock-1' }, 40, { type: 'text-delta', text: '部分' }, 10_000],
    }),
    ai: { streamIdleTimeoutMs: 20_000, streamHardTimeoutMs: 20_000 },
  })
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    // bailMs 设短：若插件**没有**收拢连接，客户端会在 1.5s 自己放弃并被标记 aborted
    const pending = postStream(h.port, { q: '检索增强' }, { bailMs: 1_500 })
    // 等流真正建立（收到 status + 首个 delta）
    await sleep(200)

    // 卸载 = 插件级 disable 的等价物（**不会**触发 http 插件的 closeStreams）
    const t0 = Date.now()
    h.disposePlugin()
    const disposeMs = Date.now() - t0
    assert.ok(disposeMs < 1_000, `卸载不得空转（实测 ${disposeMs}ms）`)
    assert.equal(
      warnings.some((w) => w.includes('排空超时')),
      false,
      `不得打印假的排空超时告警，实际: ${JSON.stringify(warnings)}`,
    )

    const out = await pending
    /*
     * 判别力所在（这三条断言是**变异实验**逼出来的）：
     * 本用例最初只断言"没有终止帧"，而那是**空转**的——客户端 8s 兜底自己 destroy 之后
     * 同样没有终止帧，于是"忘了收流"的变异体照样通过（我实测确认，见汇报）。
     * 真正的证据是：连接由**服务端**收拢 ⇒ 客户端看到响应正常结束（endedAt 有值、
     * aborted 为 false），而不是等不下去自己放弃（aborted 为 true）。
     */
    assert.equal(
      out.aborted,
      false,
      '客户端不应需要自己放弃连接——连接必须由插件在卸载时收拢（aborted=true 说明没收）',
    )
    assert.ok(out.endedAt !== undefined, '卸载后响应必须结束（客户端应看到 response end）')
    // endedAt 是相对"请求发起"的毫秒数；客户端兜底放弃在 1500ms，
    // 因此"在兜底之前就结束"即证明结束来自服务端收拢而非客户端放弃。
    assert.ok(
      out.endedAt! < 1_500,
      `响应应在卸载后立即结束，实际 ${out.endedAt}ms（达到 1500ms 兜底说明是客户端自己放弃的）`,
    )
    assert.ok(out.timeline.done === undefined && out.timeline.error === undefined,
      '卸载时直接收连接，不补终止帧（客户端靠连接结束感知）')
  } finally {
    console.warn = originalWarn
    await h.close()
  }
})

test('协议卫生：事件流中不得出现字面 null 污染、不得是 application/json', async () => {
  const h = await makeHarness({ provider: scriptedProvider({ steps: OK_STEPS }) })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料。')
    const out = await postStream(h.port, { q: '检索增强' })
    assert.doesNotMatch(out.contentType ?? '', /application\/json/, '内容类型必须是事件流')
    // 回归"json() 会 res.end 且追加字面 null"那个坑：事件流里不应出现裸 null 尾缀
    assert.equal(/\nnull$/.test(out.raw), false, `事件流被污染: ${JSON.stringify(out.raw.slice(-40))}`)
    assert.equal(out.raw.trimEnd().endsWith('null'), false, '事件流不得以字面 null 收尾')
    // 所有物理行都必须是合法的 SSE 行
    for (const line of out.raw.split('\n')) {
      if (line === '') continue
      assert.ok(
        line.startsWith('event: ') || line.startsWith('data: '),
        `非法 SSE 行: ${JSON.stringify(line)}`,
      )
    }
    toEvents(out) // 帧序列仍须合法
  } finally {
    await h.close()
  }
})

test('参数校验：空查询/超长/非法 limit/未知字段/畸形 JSON 一律 400 JSON（不写 SSE 头）', async () => {
  const h = await makeHarness({ provider: scriptedProvider({ steps: OK_STEPS }) })
  try {
    const cases: { body: unknown; error: string }[] = [
      { body: { q: '   ' }, error: 'empty_query' },
      { body: { q: 'x'.repeat(501) }, error: 'too_long' },
      { body: { q: '检索', limit: 0 }, error: 'invalid_limit' },
      { body: { q: '检索', limit: 999 }, error: 'invalid_limit' },
      { body: { q: '检索', extractive: 'maybe' }, error: 'invalid_extractive' },
      { body: { q: '检索', nope: 1 }, error: 'invalid_body' },
      { body: [1, 2], error: 'invalid_body' },
    ]
    for (const c of cases) {
      const out = await postStream(h.port, c.body)
      assert.equal(out.status, 400, `${JSON.stringify(c.body)} 应 400，实际 ${out.status}: ${out.raw}`)
      assert.match(out.contentType ?? '', /application\/json/, '参数错误必须是普通 JSON')
      assert.equal(out.raw.includes('event:'), false, '参数错误不得写 SSE 帧')
      const parsed = JSON.parse(out.raw) as { error: string }
      assert.equal(parsed.error, c.error, `${JSON.stringify(c.body)} 的错误码`)
    }
  } finally {
    await h.close()
  }
})

test('畸形 JSON 请求体 → 400 invalid_json（复用与 /api/ai/ask 同一套读体逻辑）', async () => {
  const h = await makeHarness({ provider: scriptedProvider({ steps: OK_STEPS }) })
  try {
    const status = await new Promise<{ code: number; body: string; ct: string | undefined }>((resolve, reject) => {
      const raw = '{ this is not json'
      const req = request(
        {
          host: '127.0.0.1',
          port: h.port,
          method: 'POST',
          path: '/api/ai/stream',
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) },
        },
        (res) => {
          let b = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => (b += c))
          res.on('end', () => resolve({ code: res.statusCode ?? 0, body: b, ct: res.headers['content-type'] }))
        },
      )
      req.on('error', reject)
      req.end(raw)
    })
    assert.equal(status.code, 400, `畸形 JSON 应 400，实际 ${status.code}: ${status.body}`)
    assert.match(status.ct ?? '', /application\/json/)
    assert.equal(status.body.includes('event:'), false, '不得写出 SSE 帧')
    assert.equal((JSON.parse(status.body) as { error: string }).error, 'invalid_json')
  } finally {
    await h.close()
  }
})

test('流式与一次性问答口径一致：同一问题下 sources 相同（证明共用检索实现）', async () => {
  const h = await makeHarness({ provider: scriptedProvider({ steps: OK_STEPS }) })
  try {
    h.putPage('kb-1', '检索增强', '检索增强问答先从知识库检索相关资料，再做抽取式摘要。')
    h.putPage('kb-2', '检索评估', '检索质量决定问答质量，需要评估检索增强的效果。')
    const streamed = await postStream(h.port, { q: '检索增强怎么做' })
    const events = toEvents(streamed)
    const statusSources = statusOf(events).sources.map((s) => ({ slug: s.slug, n: s.n, used: s.used }))

    // 同一问题上 /api/ai/ask 的结果
    const askRaw = await new Promise<string>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ q: '检索增强怎么做' }), 'utf8')
      const req = request(
        {
          host: '127.0.0.1',
          port: h.port,
          method: 'POST',
          path: '/api/ai/ask',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
        },
        (res) => {
          let b = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => (b += c))
          res.on('end', () => resolve(b))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
    const askBody = JSON.parse(askRaw) as { sources: { slug: string; n: number | null; used: boolean }[] }
    assert.deepEqual(
      statusSources,
      askBody.sources.map((s) => ({ slug: s.slug, n: s.n, used: s.used })),
      '流式与一次性问答必须得到同一份来源（共用 retrieve/selectFrom）',
    )
  } finally {
    await h.close()
  }
})

/* ============ owner 登记 / 拒流上报 / failFromError 脱敏（本批收敛的 advisory） ============ */

test('owner：流式登记时带上本插件名（供管理器在卸载本插件时定向回收）', async () => {
  const h = await makeHarness()
  try {
    h.putPage('owner-doc', '所有者', '这是用于 owner 断言的内容。')
    const out = await postStream(h.port, { q: 'owner' })
    assert.equal(out.status, 200)
    assert.deepEqual(
      h.trackedOwners(),
      ['@geewiki/ai'],
      'trackStream 必须收到本插件名作为 owner，否则管理器无法定向回收（会退化成静默悬空）',
    )
  } finally {
    await h.close()
  }
})

test('可观测性：并发超限时上报被拒计数（noteStreamRejected），让运维能从 health 看出被拒', async () => {
  // 每条流都挂住（provider 发完 status 后长时间不结束），否则降级路径会立即完成、占不住额度
  const h = await makeHarness({
    provider: scriptedProvider({
      steps: [{ type: 'status', provider: 'mock', model: 'mock-1' }, 10_000],
    }),
    ai: { streamIdleTimeoutMs: 20_000, streamHardTimeoutMs: 20_000 },
  })
  try {
    h.putPage('cap-doc', '并发', '并发上限相关的内容。')
    // 占满并发额度（不 await：让它们保持挂住）
    const held = Array.from({ length: MAX_CONCURRENT_STREAMS }, () => postStream(h.port, { q: '并发' }))
    // 等到最后一条也真正建立（收到 status 帧即证明已登记）
    await sleep(150)
    assert.equal(h.rejectedCount(), 0, '未超限时不应有被拒记录')

    // 第 cap+1 条：应 429，且**必须**上报被拒计数
    const over = await postStream(h.port, { q: '并发' })
    assert.equal(over.status, 429, `超出并发上限应返回 429，实际 ${over.status}`)
    assert.equal(h.rejectedCount(), 1, '超限被拒必须上报一次（否则 stats.streams.rejected 永远是 0）')
    await Promise.all(held)
  } finally {
    await h.close()
  }
})

test('failFromError：参数校验错误里回显的用户输入也经 redact 脱敏（密钥形态不得进响应体）', async () => {
  const h = await makeHarness()
  try {
    h.putPage('redact-doc', '脱敏', '用于脱敏断言的内容。')
    // 把形如密钥的串当作 limit 传入：错误信息会把它回显（`实际 ${String(raw)}`），
    // 这正是 failFromError 未过 redact 时会把密钥写进响应体的通路。
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '脱敏', limit: secret }),
    })
    const body = await res.text()
    assert.equal(res.status, 400, '非法 limit 应返回 400')
    assert.equal(body.includes(secret), false, `响应体不得回显密钥形态的输入：${body}`)
    assert.match(body, /invalid_limit/, '错误码应仍可读（脱敏不得吞掉可诊断性）')

    // 对照：正常的可读校验信息逐字不变（脱敏只遮蔽"像密钥的长串"）
    const okRes = await fetch(`http://127.0.0.1:${h.port}/api/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '脱敏', limit: 0 }),
    })
    const okBody = await okRes.text()
    assert.equal(okRes.status, 400)
    assert.match(okBody, /limit 须为 1\.\./, `我们自己的校验文案应保持可读，实际: ${okBody}`)
  } finally {
    await h.close()
  }
})
