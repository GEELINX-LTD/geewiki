/**
 * LLM 服务契约测试（`@geewiki/llm`）。
 *
 * **测试策略**：本层几乎全部行为都是"纯内存注册表 + 流式包装"，没有 IO，故直接用真实
 * `createLlmService` 与手写 provider 替身，唯一需要"真实"的东西是 `process.env`（凭据路径）。
 * `apply` 的用例用真实 cordis `Context`（provide/dispose 语义是这一层的一部分，
 * 用替身等于把要验证的东西替掉）。
 *
 * 本批**没有厂商 adapter**，所以"真实网络流式"不在覆盖范围内——那属 adapter 批次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  FALLBACK_SETTINGS,
  LLM_SERVICE_KEY,
  LlmPlugin,
  NULL_PROVIDER,
  createLlmService,
  resolveCredential,
  type LlmChunk,
  type LlmProvider,
  type LlmRequest,
  type LlmService,
} from '../src/index.js'

/* ------------------------------ 夹具 ------------------------------ */

/**
 * cordis 的 `FiberState` 是 `const enum`（`isolatedModules` 下不能作为值导入），
 * 这里按字面量断言并注明来源：packages/../cordis/lib/fiber.d.ts:28-35。
 */
const FIBER_ACTIVE = 2

/** 造一个可控 provider：`chunks` 依次产出；`throwAfter` 命中时抛错；`hold` 时不产出任何 chunk */
function makeProvider(
  route: string,
  opts: {
    chunks?: LlmChunk[]
    throwAfter?: number
    throwWith?: unknown
    hold?: boolean
    available?: boolean
    apiKeyEnv?: string
    onReturn?: () => void
  } = {},
): LlmProvider {
  const chunks = opts.chunks ?? []
  return {
    route,
    descriptor: {
      route,
      label: `测试路由 ${route}`,
      vendor: 'test',
      model: 'test-model',
      ...(opts.apiKeyEnv !== undefined ? { apiKeyEnv: opts.apiKeyEnv } : {}),
      available: () => opts.available ?? true,
    },
    async *stream(_req: LlmRequest, _o: { signal: AbortSignal }): AsyncIterable<LlmChunk> {
      try {
        if (opts.hold) {
          await new Promise(() => {}) // 永不结算：用于验证 signal 中止
          return
        }
        for (let i = 0; i < chunks.length; i++) {
          if (opts.throwAfter !== undefined && i === opts.throwAfter) {
            throw opts.throwWith ?? new Error('provider boom')
          }
          yield chunks[i] as LlmChunk
        }
        if (opts.throwAfter !== undefined && opts.throwAfter >= chunks.length) {
          throw opts.throwWith ?? new Error('provider boom')
        }
      } finally {
        opts.onReturn?.()
      }
    },
  }
}

const request: LlmRequest = { messages: [{ role: 'user', content: '你好' }] }

/** 收集全部 chunk（消费方视角：**不做任何判空**，这正是契约要保证的） */
async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

/** 断言：终止 chunk 恰一次且在末位 */
function assertSingleTerminal(chunks: LlmChunk[], expectType: 'done' | 'error'): LlmChunk {
  const terminals = chunks.filter((c) => c.type === 'done' || c.type === 'error')
  assert.equal(terminals.length, 1, `终止 chunk 必须恰一次，实际 ${terminals.length}: ${JSON.stringify(chunks)}`)
  const last = chunks[chunks.length - 1]
  assert.equal(last, terminals[0], `终止 chunk 必须在末位: ${JSON.stringify(chunks)}`)
  assert.equal(last?.type, expectType, `终止类型应为 ${expectType}: ${JSON.stringify(last)}`)
  return last as LlmChunk
}

/* --------------------------- register 注册表 --------------------------- */

test('register：重复 route 抛错，且不污染既有注册表', async () => {
  const svc = createLlmService()
  const disposeA = svc.register(makeProvider('a', { chunks: [{ type: 'done', provider: 'a', model: 'm' }] }))
  assert.equal(svc.listProviders().length, 1)

  const before = svc.listProviders()
  assert.throws(() => svc.register(makeProvider('a')), /已被注册/, '重复 route 必须抛错（不得静默覆盖）')
  assert.deepEqual(svc.listProviders(), before, '失败的注册不得改变注册表')

  // 原 provider 仍可用（没被顶掉）
  const chunks = await collect(svc.stream({ ...request, route: 'a' }))
  assertSingleTerminal(chunks, 'done')

  disposeA()
  assert.equal(svc.listProviders().length, 0)
})

test('register：注销后同 route 可再注册；空 route 被拒绝', async () => {
  const svc = createLlmService()
  const dispose = svc.register(makeProvider('x'))
  dispose()
  const dispose2 = svc.register(makeProvider('x'))
  assert.equal(svc.listProviders().length, 1)
  dispose2()
  assert.throws(() => svc.register(makeProvider('   ')), /不能为空/)
})

test('register：注销函数只移除自己（不会误删同名的后来者）', () => {
  const svc = createLlmService()
  const disposeOld = svc.register(makeProvider('dup'))
  disposeOld()
  svc.register(makeProvider('dup'))
  disposeOld() // 过期注销函数再次调用
  assert.equal(svc.listProviders().length, 1, '过期注销函数不得删掉后来注册的同名 provider')
})

/* ------------------------ 终止保证：五条路径 ------------------------ */

test('终止保证①：正常结束 → done 恰一次且在末位', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('ok', {
      chunks: [
        { type: 'status', provider: 'ok', model: 'm' },
        { type: 'text-delta', text: '你' },
        { type: 'text-delta', text: '好' },
        { type: 'done', provider: 'ok', model: 'm', usage: { completionTokens: 2 } },
      ],
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'ok' }))
  const terminal = assertSingleTerminal(chunks, 'done')
  assert.deepEqual(
    chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text),
    ['你', '好'],
  )
  assert.deepEqual((terminal as { usage?: unknown }).usage, { completionTokens: 2 })
})

test('终止保证②：provider 抛错 → error 恰一次且在末位（且不带 message）', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('boom', {
      chunks: [{ type: 'text-delta', text: '部分' }],
      throwAfter: 1,
      throwWith: new Error('上游 401: authorization: Bearer sk-abcdefghijklmnop'),
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'boom' }))
  const terminal = assertSingleTerminal(chunks, 'error')
  assert.equal((terminal as { code: string }).code, 'PROVIDER_ERROR')
  assert.ok(!('message' in terminal), 'error chunk 不得携带 message（结构上杜绝报错文本泄漏密钥）')
  assert.ok(
    !JSON.stringify(chunks).includes('sk-abcdefghijklmnop'),
    `流内不得出现密钥原文: ${JSON.stringify(chunks)}`,
  )
})

test('终止保证②b：provider 抛带 code 的错误 → 归一化为该 code', async () => {
  const svc = createLlmService()
  const err = Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' })
  svc.register(makeProvider('rl', { chunks: [], throwAfter: 0, throwWith: err }))
  const chunks = await collect(svc.stream({ ...request, route: 'rl' }))
  assert.equal((assertSingleTerminal(chunks, 'error') as { code: string }).code, 'RATE_LIMIT')
})

test('终止保证③：signal 已 abort → error{ABORTED}，且不调用 provider', async () => {
  const svc = createLlmService()
  let called = false
  const provider = makeProvider('nope', { chunks: [{ type: 'done', provider: 'nope', model: 'm' }] })
  svc.register({ ...provider, stream: (...args) => { called = true; return provider.stream(...args) } })

  const ac = new AbortController()
  ac.abort()
  const chunks = await collect(svc.stream({ ...request, route: 'nope' }, { signal: ac.signal }))
  const terminal = assertSingleTerminal(chunks, 'error')
  assert.equal((terminal as { code: string }).code, 'ABORTED')
  assert.equal(called, false, '已 abort 时不应进入 provider')
})

test('终止保证③b：流中途 abort → error{ABORTED} 且在末位，并释放上游', async () => {
  const svc = createLlmService()
  let released = false
  const ac = new AbortController()
  // 产出若干 delta 后 abort 自己，模拟"用户点了停止"
  const provider: LlmProvider = {
    route: 'abort-mid',
    descriptor: { route: 'abort-mid', label: 'x', vendor: 'test', model: 'm', available: () => true },
    async *stream(): AsyncIterable<LlmChunk> {
      try {
        yield { type: 'text-delta', text: 'a' }
        ac.abort()
        yield { type: 'text-delta', text: 'b' }
        yield { type: 'done', provider: 'abort-mid', model: 'm' }
      } finally {
        released = true
      }
    },
  }
  svc.register(provider)
  const chunks = await collect(svc.stream({ ...request, route: 'abort-mid' }, { signal: ac.signal }))
  const terminal = assertSingleTerminal(chunks, 'error')
  assert.equal((terminal as { code: string }).code, 'ABORTED')
  assert.equal(released, true, '中止后必须关闭上游迭代器（释放连接/计时器）')
})

test('终止保证④：provider 什么都不产 → 补 error{PROVIDER_ERROR}', async () => {
  const svc = createLlmService()
  svc.register(makeProvider('silent', { chunks: [] }))
  const chunks = await collect(svc.stream({ ...request, route: 'silent' }))
  assert.equal((assertSingleTerminal(chunks, 'error') as { code: string }).code, 'PROVIDER_ERROR')
})

test('终止保证⑤：终止 chunk 之后仍产 chunk → 丢弃，终止仍在末位', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('chatty', {
      chunks: [
        { type: 'text-delta', text: '前' },
        { type: 'done', provider: 'chatty', model: 'm' },
        { type: 'text-delta', text: '不该出现' }, // 违规：终止后还产
        { type: 'error', code: 'PROVIDER_ERROR' }, // 违规：第二个终止
      ],
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'chatty' }))
  assertSingleTerminal(chunks, 'done')
  assert.equal(chunks.length, 2, `终止后的 chunk 必须被丢弃: ${JSON.stringify(chunks)}`)
  assert.ok(!JSON.stringify(chunks).includes('不该出现'))
})

test('终止保证⑥：无可用 provider → error{NO_ADAPTER}（不抛异常）', async () => {
  const svc = createLlmService()
  svc.register(makeProvider('down', { available: false }))
  const chunks = await collect(svc.stream(request))
  assert.equal((assertSingleTerminal(chunks, 'error') as { code: string }).code, 'NO_ADAPTER')
})

test('终止保证⑦：点名不存在的 route → NO_ADAPTER；点名叫 null 兜底 → MISSING_CREDENTIAL', async () => {
  const svc = createLlmService()
  svc.register(NULL_PROVIDER)
  const missing = await collect(svc.stream({ ...request, route: 'does-not-exist' }))
  assert.equal((assertSingleTerminal(missing, 'error') as { code: string }).code, 'NO_ADAPTER')

  const nullRoute = await collect(svc.stream({ ...request, route: 'null' }))
  assert.equal((assertSingleTerminal(nullRoute, 'error') as { code: string }).code, 'MISSING_CREDENTIAL')
})

/* ----------------------------- 路由选择 ----------------------------- */

test('路由选择：defaultRoute 生效；未指定时取第一个可用路由', async () => {
  const svc = createLlmService({ defaultRoute: 'b' })
  svc.register(makeProvider('a', { available: false }))
  svc.register(makeProvider('b', { chunks: [{ type: 'done', provider: 'b', model: 'm' }] }))
  const viaDefault = await collect(svc.stream(request))
  assert.equal((assertSingleTerminal(viaDefault, 'done') as { provider: string }).provider, 'b')

  const auto = createLlmService()
  auto.register(makeProvider('first-down', { available: false }))
  auto.register(makeProvider('second-up', { chunks: [{ type: 'done', provider: 'second-up', model: 'm' }] }))
  const picked = await collect(auto.stream(request))
  assert.equal((assertSingleTerminal(picked, 'done') as { provider: string }).provider, 'second-up')
})

test('服务级默认值：仅在请求未显式给出时填充 maxTokens；temperature 永不代填', async () => {
  const svc = createLlmService({ maxTokens: 128 })
  const seen: LlmRequest[] = []
  const provider: LlmProvider = {
    route: 'echo-req',
    descriptor: { route: 'echo-req', label: 'x', vendor: 'test', model: 'm', available: () => true },
    async *stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      seen.push(req)
      yield { type: 'done', provider: 'echo-req', model: 'm' }
    },
  }
  svc.register(provider)
  await collect(svc.stream(request))
  assert.equal(seen[0]?.maxTokens, 128)
  assert.equal('temperature' in (seen[0] ?? {}), false, '服务层不得替调用方补一个温度：温度由服务端默认值决定')
  await collect(svc.stream({ ...request, maxTokens: 7, temperature: 0 }))
  assert.equal(seen[1]?.maxTokens, 7, '显式值不得被覆盖')
  assert.equal(seen[1]?.temperature, 0, '调用方显式写 0 时原样透传（这是它的决定，不是我们的）')
})

test('接上统一配置后：maxTokens 来自设置，temperature 依然不出现', async () => {
  const svc = createLlmService({
    settings: () => ({ ...FALLBACK_SETTINGS, maxOutputTokens: 2048, reasoningEffort: 'high' }),
  })
  const seen: LlmRequest[] = []
  svc.register({
    route: 'echo-settings',
    descriptor: { route: 'echo-settings', label: 'x', vendor: 'test', model: 'm', available: () => true },
    async *stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      seen.push(req)
      yield { type: 'done', provider: 'echo-settings', model: 'm' }
    },
  })
  await collect(svc.stream(request))
  assert.equal(seen[0]?.maxTokens, 2048)
  assert.equal('temperature' in (seen[0] ?? {}), false, '统一配置里没有温度，这里也不该凭空长出一个')
})

test('status chunk 的 message 经脱敏；text-delta 原样透传（模型输出不得被改写）', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('sanitize', {
      chunks: [
        { type: 'status', provider: 'sanitize', model: 'm', message: '连接中 authorization: Bearer sk-abcdefghijklmnop' },
        { type: 'text-delta', text: 'sk-abcdefghijklmnop 是密钥形状，但这是模型输出' },
        { type: 'done', provider: 'sanitize', model: 'm' },
      ],
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'sanitize' }))
  const status = chunks[0] as { message?: string }
  assert.ok(!(status.message ?? '').includes('sk-abcdefghijklmnop'), `status.message 必须脱敏: ${status.message}`)
  const delta = chunks[1] as { text: string }
  assert.ok(delta.text.includes('sk-abcdefghijklmnop'), 'text-delta 是模型输出，必须原样透传')
})

test('★ reasoning-delta 必须被显式放行（白名单漏一个类型 = 静默丢帧，不报错不测试变红）', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('think', {
      chunks: [
        { type: 'reasoning-delta', text: '先想一下：sk-abcdefghijklmnop 只是形状像密钥' },
        { type: 'text-delta', text: '答案' },
        { type: 'done', provider: 'think', model: 'm' },
      ],
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'think' }))
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta')
  assert.equal(reasoning.length, 1, 'reasoning-delta 被服务层丢掉了（sanitizeNonTerminal 的白名单漏了它）')
  // 与 text-delta 同待遇：模型输出原样透传，不做脱敏改写
  assert.ok(
    reasoning[0]?.type === 'reasoning-delta' && reasoning[0].text.includes('sk-abcdefghijklmnop'),
    '思考内容也是模型输出，必须原样透传',
  )
})

test('available() 抛错视为不可用（不拖垮整个服务）', async () => {
  const svc = createLlmService()
  const provider = makeProvider('angry')
  svc.register({
    ...provider,
    descriptor: {
      ...provider.descriptor,
      available: () => {
        throw new Error('available() 自己炸了')
      },
    },
  })
  const chunks = await collect(svc.stream({ ...request, route: 'angry' }))
  assertSingleTerminal(chunks, 'error')
  assert.deepEqual(svc.availableProviders(), [])
})

/* --------------------------- 凭据与降级路径 --------------------------- */

test('resolveCredential：未配置 / 空值 / 未设变量 → MISSING_CREDENTIAL', () => {
  assert.deepEqual(resolveCredential(undefined), { ok: false, code: 'MISSING_CREDENTIAL' })
  assert.deepEqual(resolveCredential(''), { ok: false, code: 'MISSING_CREDENTIAL' })
  assert.deepEqual(resolveCredential('   '), { ok: false, code: 'MISSING_CREDENTIAL' })
  assert.deepEqual(resolveCredential('GEEWIKI_TEST_ABSENT_KEY_XYZ'), { ok: false, code: 'MISSING_CREDENTIAL' })
})

test('resolveCredential：变量已设取到值；值为空串也算缺失', () => {
  process.env['GEEWIKI_LLM_TEST_KEY'] = 'value-from-env'
  process.env['GEEWIKI_LLM_TEST_EMPTY'] = '   '
  try {
    assert.deepEqual(resolveCredential('GEEWIKI_LLM_TEST_KEY'), { ok: true, value: 'value-from-env' })
    assert.deepEqual(resolveCredential('GEEWIKI_LLM_TEST_EMPTY'), { ok: false, code: 'MISSING_CREDENTIAL' })
  } finally {
    delete process.env['GEEWIKI_LLM_TEST_KEY']
    delete process.env['GEEWIKI_LLM_TEST_EMPTY']
  }
})

test('resolveCredential：传入的是密钥值本身 → INVALID_CREDENTIAL（不去查 env）', () => {
  // 关键：不得"静默降级成没有 LLM"，那会让明文密钥留在入库配置里还不报错
  assert.deepEqual(resolveCredential('sk-abcdefghijklmnop'), { ok: false, code: 'INVALID_CREDENTIAL' })
  assert.deepEqual(resolveCredential('AIzaSyA1234567890abcdefghijklmnop'), {
    ok: false,
    code: 'INVALID_CREDENTIAL',
  })
  // 变量名形态照常放行
  assert.deepEqual(resolveCredential('OPENAI_API_KEY'), { ok: false, code: 'MISSING_CREDENTIAL' })
})

test('provider 有 apiKeyEnv 但 env 未设 → available()=false，点名它得到 MISSING_CREDENTIAL', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('needs-key', {
      available: resolveCredential('GEEWIKI_TEST_ABSENT_KEY_XYZ').ok,
      apiKeyEnv: 'GEEWIKI_TEST_ABSENT_KEY_XYZ',
      chunks: [{ type: 'done', provider: 'needs-key', model: 'm' }],
    }),
  )
  assert.deepEqual(svc.availableProviders(), [])
  const chunks = await collect(svc.stream({ ...request, route: 'needs-key' }))
  assert.equal((assertSingleTerminal(chunks, 'error') as { code: string }).code, 'MISSING_CREDENTIAL')
})

/* ------------------------- 无 key 降级端到端 ------------------------- */

test('降级端到端：完全没有 provider 时 stream() 产出单个 error{NO_ADAPTER} 且不抛异常', async () => {
  const svc: LlmService = createLlmService()
  const chunks = await collect(svc.stream(request))
  assert.deepEqual(chunks, [{ type: 'error', code: 'NO_ADAPTER' }])
})

test('降级端到端：只注册兜底 provider 时，未点名路由 → NO_ADAPTER（契约 ⑤）', async () => {
  const svc = createLlmService()
  svc.register(NULL_PROVIDER)
  assert.deepEqual(svc.availableProviders(), [], '兜底 provider 永远不可用')
  assert.equal(svc.listProviders().length, 1, '但它仍应出现在列表里（管理台可展示"未配置"）')

  // 未点名 route 且没有任何可用 provider → NO_ADAPTER（契约 ⑤：无可用 provider）
  let text = ''
  let code = ''
  for await (const c of svc.stream(request)) {
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'error') code = c.code
  }
  assert.equal(text, '', '降级路径不得产出任何文本')
  assert.equal(code, 'NO_ADAPTER')

  // 而"点名了兜底路由"时给出更具体的原因：MISSING_CREDENTIAL
  const named = await collect(svc.stream({ ...request, route: 'null' }))
  assert.equal((assertSingleTerminal(named, 'error') as { code: string }).code, 'MISSING_CREDENTIAL')
})

/* ---------------------------- 插件 apply/dispose ---------------------------- */

test('apply：config.apiKeyEnv 填了疑似密钥值 → 激活失败（抛错，不 process.exit）', async () => {
  const ctx = new Context()
  // 注意：cordis 的 apply 是**异步结算**的，错误不会从 ctx.plugin() 同步抛出，
  // 必须 await 返回的 PromiseLike 才会看到失败（类型见 FiberLike & PromiseLike<FiberLike>）
  const fork = ctx.plugin(LlmPlugin, { apiKeyEnv: 'sk-abcdefghijklmnop' })
  // 该校验现已**下沉到 Config schema**（白名单，见 credentials.ts 的 isEnvVarName），
  // 因此报错文本来自 schemastery 的 pattern 校验：只断言它指出字段名。
  // apply 自身仍有一道同规则的闸门，由 credentials.test.ts 直接调用 apply 覆盖。
  await assert.rejects(async () => await fork, /apiKeyEnv/, '明文密钥必须让插件激活失败')
  // schema 层拒绝发生在 fiber 启动**之前**，故状态停在 PENDING（0）而不是 FAILED（3）。
  // 关键语义不变：它绝不允许变成 ACTIVE（即绝不放行）。
  assert.notEqual(fork.state, FIBER_ACTIVE, 'fork 不得进入 ACTIVE 态')
  assert.ok(!ctx.get(LLM_SERVICE_KEY), '激活失败不得注册服务')

  // 报错信息本身不得回显那个密钥
  const ctx2 = new Context()
  const fork2 = ctx2.plugin(LlmPlugin, { apiKeyEnv: 'sk-abcdefghijklmnop' })
  const failure = await fork2.then(
    () => undefined,
    (err: unknown) => err as Error,
  )
  assert.ok(failure, '应当激活失败')
  assert.ok(!failure.message.includes('sk-abcdefghijklmnop'), '报错不得回显密钥原文')

  // 关键：这是**可恢复的配置错误**，不得升级成全站不可用——同一 ctx 里别的插件照常装载
  const other = ctx2.plugin({ name: 'other', apply: () => {} }, {})
  await other
  assert.equal(other.state, FIBER_ACTIVE, '其它插件必须照常激活（不许 process.exit）')
})

test('apply：正常配置提供 llm-service，dispose 后注销（含兜底路由）', async () => {
  const ctx = new Context()
  const fork = ctx.plugin(LlmPlugin, { defaultRoute: 'null', maxTokens: 64 })
  await fork
  assert.equal(fork.state, FIBER_ACTIVE)

  const svc = ctx.get(LLM_SERVICE_KEY) as LlmService | undefined
  assert.ok(svc, 'apply 后应能从 ctx 取到 llm-service')
  assert.equal(svc.listProviders().length, 1, '至少含内置兜底路由')
  assert.equal(svc.listProviders()[0]?.route, 'null')

  // 无 key 环境下仍是"可安全迭代"的降级流
  const chunks = await collect(svc.stream({ messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.length, 1)
  assert.equal((chunks[0] as { type: string; code?: string }).type, 'error')

  await fork.dispose()
  assert.equal(ctx.get(LLM_SERVICE_KEY), undefined, 'dispose 后服务应被注销')
})

/* --------------------- 工具调用：chunk 归一化必须放行 --------------------- */

test('tool-call-delta 原样透传（不被"契约外类型丢弃"那句吞掉）', async () => {
  // ★ 这是本链路最容易静默失败的一处：sanitizeNonTerminal 末尾有一句
  //   `return undefined`（丢弃契约外类型）。少写工具片段那一个分支**不会报错、
  //   不会有测试变红**，只会让模型产出的工具调用一个都到不了消费者手里。
  //   这条用例就是钉住那个分支。
  const svc = createLlmService()
  svc.register(
    makeProvider('tools', {
      chunks: [
        { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'search_kb', argumentsDelta: '' },
        { type: 'tool-call-delta', index: 0, argumentsDelta: '{"q":"新建"}' },
        { type: 'done', provider: 'tools', model: 'm' },
      ],
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'tools' }))
  assert.deepEqual(chunks, [
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'search_kb', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 0, argumentsDelta: '{"q":"新建"}' },
    { type: 'done', provider: 'tools', model: 'm' },
  ])
  assertSingleTerminal(chunks, 'done')
})

test('done.finishReason 透传；上游没给时该字段不出现', async () => {
  const svc = createLlmService()
  svc.register(makeProvider('trunc', { chunks: [{ type: 'done', provider: 'trunc', model: 'm', finishReason: 'length' }] }))
  svc.register(makeProvider('plain', { chunks: [{ type: 'done', provider: 'plain', model: 'm' }] }))

  const truncated = assertSingleTerminal(await collect(svc.stream({ ...request, route: 'trunc' })), 'done')
  assert.equal(
    (truncated as { finishReason?: string }).finishReason,
    'length',
    'finishReason=length 必须能传到调用方：它意味着工具调用参数可能是半截 JSON',
  )

  const plain = assertSingleTerminal(await collect(svc.stream({ ...request, route: 'plain' })), 'done')
  assert.equal('finishReason' in (plain as object), false, '上游没给就不该凭空出现该字段')
})

test('status.message 仍经脱敏，工具链路不影响既有脱敏出口', async () => {
  const svc = createLlmService()
  svc.register(
    makeProvider('leak', {
      chunks: [
        { type: 'status', provider: 'leak', model: 'm', message: 'trace Authorization: Bearer sk-abcdef1234567890' },
        { type: 'tool-call-delta', index: 0, id: 'c', name: 'n' },
        { type: 'done', provider: 'leak', model: 'm' },
      ],
    }),
  )
  const chunks = await collect(svc.stream({ ...request, route: 'leak' }))
  const status = chunks[0] as { type: string; message?: string }
  assert.equal(status.type, 'status')
  assert.equal(status.message?.includes('sk-abcdef1234567890'), false, '诊断文本里的密钥必须被脱敏')
})
