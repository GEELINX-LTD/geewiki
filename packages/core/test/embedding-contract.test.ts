/**
 * ★ F18：`EmbeddingProvider` 契约与 `assertEmbeddingResult()` 的守卫。
 *
 * ## 为什么一个"纯接口"也值得单测
 * 本项唯一可执行的代码是校验器 `assertEmbeddingResult()` —— 而它恰好是整个语义检索
 * 里**最不能出错**的一环：提供方返回的向量会直接进索引，**写入那一刻不会报任何错**。
 * 一旦 `NaN` 混进去，之后每次相似度计算都是 `NaN`，排序还会安静地退化成"原序"
 * （JS 里 `NaN` 参与的比较恒为 false，`sort` 于是保持原样，看起来像"结果没被改动"）。
 * 那是最坏的一类故障：**没有错误、没有日志、结果只是"看起来有点怪"**。
 *
 * 所以这里逐条钉住四种偏差，并断言它们都变成**可读的**错误（消息里要有能定位的坐标）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMBEDDING_SERVICE_NAME,
  EmbeddingServiceError,
  assertEmbeddingResult,
  probeEmbeddingProvider,
} from '../src/services.js'

/** 断言抛的是带指定 code 的 EmbeddingServiceError，并返回它（供进一步检查消息） */
function expectMalformed(fn: () => unknown): EmbeddingServiceError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof EmbeddingServiceError, `应抛 EmbeddingServiceError，实测 ${String(err)}`)
    assert.equal(err.code, 'provider_malformed')
    return err
  }
  throw new Error('预期抛错，但没有抛')
}

test('★ F18：服务名常量与 core 会话约定一致', () => {
  assert.equal(EMBEDDING_SERVICE_NAME, 'embedding-service')
})

test('★ F18：合法结果原样通过，且保持与入参同序', () => {
  const out = assertEmbeddingResult(['甲', '乙'], {
    vectors: [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ],
    dim: 3,
    model: 'text-embedding-test',
  })
  assert.equal(out.dim, 3)
  assert.equal(out.model, 'text-embedding-test')
  assert.deepEqual(out.vectors, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ])
  // 负值/零值都是合法的向量分量（余弦相似度里常见）
  assert.doesNotThrow(() =>
    assertEmbeddingResult(['x'], { vectors: [[-1, 0, 1]], model: 'm' }),
  )
})

test('★ F18：条数与入参不符即拒，且消息里带两个数字（否则无法定位是哪一侧错了）', () => {
  const err = expectMalformed(() =>
    assertEmbeddingResult(['甲', '乙', '丙'], { vectors: [[0.1]], model: 'm' }),
  )
  assert.match(err.message, /1/)
  assert.match(err.message, /3/)
})

test('★ F18：维度不齐即拒，且报出第几条与基准条', () => {
  const err = expectMalformed(() =>
    assertEmbeddingResult(['甲', '乙'], {
      vectors: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5],
      ],
      model: 'm',
    }),
  )
  assert.match(err.message, /维度不齐/)
  assert.match(err.message, /1/) // 第 1 条
  assert.match(err.message, /3/) // 基准 3 维
})

test('★ F18：含非有限数即拒 —— NaN/Infinity 会静默流过排序，是最坏的一种偏差', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expectMalformed(() => assertEmbeddingResult(['甲'], { vectors: [[0.1, bad]], model: 'm' }))
  }
  // 非 number 类型（字符串数字、null）同样要拒：它们会经隐式转换混进数组
  for (const bad of ['0.1', null, undefined, {}, true]) {
    expectMalformed(() =>
      assertEmbeddingResult(['甲'], { vectors: [[0.1, bad as unknown as number]], model: 'm' }),
    )
  }
})

test('★ F18：空批量是合法调用，但必须显式给出正整数 dim', () => {
  // 空入参本身不是错误（批量接口的合法边界），但 dim 无从得出
  expectMalformed(() => assertEmbeddingResult([], { vectors: [], model: 'm' }))
  expectMalformed(() => assertEmbeddingResult([], { vectors: [], dim: 0, model: 'm' }))
  expectMalformed(() => assertEmbeddingResult([], { vectors: [], dim: -1, model: 'm' }))
  expectMalformed(() => assertEmbeddingResult([], { vectors: [], dim: 1.5, model: 'm' }))
  const ok = assertEmbeddingResult([], { vectors: [], dim: 1536, model: 'm' })
  assert.deepEqual(ok.vectors, [])
  assert.equal(ok.dim, 1536)
})

test('★ F18：声明的 dim 与实际长度不符即拒（声明值会进存储，错存比不存更坏）', () => {
  const err = expectMalformed(() =>
    assertEmbeddingResult(['甲'], { vectors: [[0.1, 0.2]], dim: 3, model: 'm' }),
  )
  assert.match(err.message, /3/)
  assert.match(err.message, /2/)
  // 声明值与实际一致时通过
  assert.doesNotThrow(() => assertEmbeddingResult(['甲'], { vectors: [[0.1, 0.2]], dim: 2, model: 'm' }))
})

test('★ F18：缺 model 标识即拒（换模型会换维度，排障必须能看出来）', () => {
  expectMalformed(() => assertEmbeddingResult(['甲'], { vectors: [[0.1]] }))
  expectMalformed(() => assertEmbeddingResult(['甲'], { vectors: [[0.1]], model: '' }))
  expectMalformed(() => assertEmbeddingResult(['甲'], { vectors: [[0.1]], model: 123 }))
})

test('★ F18：形态离谱的返回值一律是 provider_malformed，绝不抛 TypeError/静默通过', () => {
  for (const bad of [null, undefined, 'x', 42, [], { vectors: 'nope' }, { vectors: [1] }, { vectors: [null] }]) {
    expectMalformed(() => assertEmbeddingResult(['甲'], bad))
  }
})

test('★ F18：错误类可被消费方用 instanceof 识别，code 足以决定 HTTP 状态', () => {
  /*
   * 这条钉的是 F4 的同一条教训：错误类必须与消费方**共用同一个类对象**。
   * 若哪天有人把它"就近"定义到某个 provider 包里，`instanceof` 会静默失配，
   * 于是 provider_malformed 被降级成 500 —— 而 500 会计进看门狗的连续失败计数。
   */
  const err = new EmbeddingServiceError('provider_unavailable', '没有提供者')
  assert.ok(err instanceof EmbeddingServiceError)
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'EmbeddingServiceError')
  assert.equal(err.code, 'provider_unavailable')
  assert.match(err.message, /^provider_unavailable: /)
})

/* ------------------------------ 可用性探针 ------------------------------ */

test('★ F18：探针对"没提供者"这类正常状态返回 available:false，而不是抛错/500', async () => {
  for (const absent of [undefined, null]) {
    const r = await probeEmbeddingProvider(absent)
    assert.equal(r.available, false)
    assert.ok(!r.available && r.reason.length > 0)
  }
})

test('★ F18：探针接住 ready() 抛错（远程提供者探活失败不得升级成 500）', async () => {
  const r = await probeEmbeddingProvider({
    model: 'm',
    dim: 3,
    embed: async () => ({ vectors: [], dim: 3, model: 'm' }),
    ready: async () => {
      throw new Error('连接被拒绝')
    },
  })
  assert.equal(r.available, false)
  assert.ok(!r.available && r.reason.includes('连接被拒绝'), `原因应带出原始错误: ${JSON.stringify(r)}`)
})

test('★ F18：探针拒绝形态不全的提供者（缺方法 / dim 非法），绝不抛错', async () => {
  const base = { model: 'm', dim: 3, embed: async () => ({ vectors: [], dim: 3, model: 'm' }) }
  const bad = [
    'not-an-object',
    42,
    {}, // 缺 ready/embed
    { ready: async () => {}, embed: async () => ({}) }, // 缺 dim
    { ready: async () => {}, embed: async () => ({}), dim: 0, model: 'm' },
    { ready: async () => {}, embed: async () => ({}), dim: -1, model: 'm' },
    { ready: async () => {}, embed: async () => ({}), dim: 1.5, model: 'm' },
    { ready: 'nope', embed: async () => ({}), dim: 3, model: 'm' },
    { ready: async () => {}, embed: 'nope', dim: 3, model: 'm' },
  ]
  for (const p of bad) {
    const r = await probeEmbeddingProvider(p)
    assert.equal(r.available, false, `应判为不可用: ${JSON.stringify(p)}`)
    assert.ok(!r.available && r.reason.length > 0)
  }
  // 缺 model 不算不可用（只是显示名缺失），但必须有正向的占位说明
  const okNoModel = await probeEmbeddingProvider({ ready: async () => {}, embed: async () => ({}), dim: 3 })
  assert.equal(okNoModel.available, true)
  assert.ok(okNoModel.available && okNoModel.model.includes('未声明'))
  void base
})

test('★ F18：探针在可用时给出 model 与 dim（消费方据此持久化维度）', async () => {
  const r = await probeEmbeddingProvider({
    model: 'text-embedding-3-small',
    dim: 1536,
    ready: async () => {},
    // 参数类型必须显式标注：`probeEmbeddingProvider` 的入参是 `unknown`（它要兜住插件传来的
    // 任意东西），故这里没有上下文类型可推断 —— 靠 `tsc` 抓出来的隐含 any，tsx 不会报。
    embed: async (texts: readonly string[]) => ({
      vectors: texts.map(() => [0]),
      dim: 1,
      model: 'text-embedding-3-small',
    }),
  })
  assert.equal(r.available, true)
  assert.ok(r.available && r.model === 'text-embedding-3-small')
  assert.ok(r.available && r.dim === 1536)
})
