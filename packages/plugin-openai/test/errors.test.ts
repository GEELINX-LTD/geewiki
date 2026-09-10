/**
 * 错误码归一化测试（纯逻辑）。
 *
 * 核心不变式：**判定基于 HTTP 状态码与错误体的结构化字段，绝不靠 message 文本模糊匹配**。
 * 因此这里专门写了一条"反例"用例：错误体文本里写着"rate limit"，但状态码是 401 ——
 * 必须判 `AUTH` 而不是 `RATE_LIMIT`，否则供应商改一次文案就会让分支静默走错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeFromFetchError, codeFromHttpError, extractErrorSignals } from '../src/errors.js'

test('状态码 401/403 → AUTH；结构化字段表明凭据无效 → INVALID_CREDENTIAL', () => {
  assert.equal(codeFromHttpError(401, { error: { message: 'Unauthorized' } }), 'AUTH')
  assert.equal(codeFromHttpError(403, {}), 'AUTH')
  // OpenAI 的 code 字段
  assert.equal(codeFromHttpError(401, { error: { code: 'invalid_api_key' } }), 'INVALID_CREDENTIAL')
  assert.equal(codeFromHttpError(401, { error: { code: 'invalid_credential' } }), 'INVALID_CREDENTIAL')
  // 常见文本兜底（仅此项退化为文本判定：这句话极其稳定）
  assert.equal(
    codeFromHttpError(401, { error: { message: 'Incorrect API key provided: sk-***' } }),
    'INVALID_CREDENTIAL',
  )
})

test('状态码 429 → RATE_LIMIT（即使体里没有结构化字段）', () => {
  assert.equal(codeFromHttpError(429, {}), 'RATE_LIMIT')
  assert.equal(codeFromHttpError(429, { error: { type: 'rate_limit_exceeded' } }), 'RATE_LIMIT')
})

test('400/422 且表明上下文超限 → CONTEXT_WINDOW_EXCEEDED；否则 PROVIDER_ERROR', () => {
  assert.equal(
    codeFromHttpError(400, { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 8192 tokens" } }),
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(
    codeFromHttpError(400, { error: { message: 'This model\u2019s maximum context length is 128000 tokens' } }),
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(codeFromHttpError(400, { error: { message: 'invalid request: missing field model' } }), 'PROVIDER_ERROR')
  assert.equal(codeFromHttpError(422, { error: { code: 'unprocessable' } }), 'PROVIDER_ERROR')
})

test('其它非 2xx → PROVIDER_ERROR', () => {
  assert.equal(codeFromHttpError(500, { error: { message: 'internal error' } }), 'PROVIDER_ERROR')
  assert.equal(codeFromHttpError(502, 'Bad Gateway'), 'PROVIDER_ERROR')
  assert.equal(codeFromHttpError(404, {}), 'PROVIDER_ERROR')
})

test('反例：状态码优先于 message 文本（文本里写 rate limit 但状态码 401 → AUTH）', () => {
  // 若实现改成"先看 message 里有没有 rate limit 字样"，这条会失败——正是要钉住的点。
  assert.equal(
    codeFromHttpError(401, { error: { message: 'Rate limit exceeded for this key (unauthorized)' } }),
    'AUTH',
  )
})

test('extractErrorSignals：兼容嵌套与扁平两种错误体形状', () => {
  const nested = extractErrorSignals({ error: { code: 'X', type: 'Y', message: 'Z' } })
  assert.deepEqual(nested.codes, ['x'])
  assert.deepEqual(nested.types, ['y'])
  assert.deepEqual(nested.messages, ['z'])

  const flat = extractErrorSignals({ code: 'A', message: 'B' })
  assert.deepEqual(flat.codes, ['a'])
  assert.deepEqual(flat.messages, ['b'])

  // 纯文本体
  assert.deepEqual(extractErrorSignals('boom').messages, ['boom'])
  // 非字符串/空值不产出信号，且不抛错
  assert.deepEqual(extractErrorSignals(null), { codes: [], types: [], messages: [] })
  assert.deepEqual(extractErrorSignals({ error: { code: 42, message: '   ' } }), { codes: [], types: [], messages: [] })
})

test('fetch 异常归一：外部取消 → ABORTED，超时 → TIMEOUT，其余 → NETWORK（顺序敏感）', () => {
  const live = new AbortController()
  const external = new AbortController()
  const timeout = new AbortController()

  // 都不是中止态 → 按异常形态判定
  assert.equal(codeFromFetchError(new TypeError('fetch failed'), live.signal, timeout.signal), 'NETWORK')
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  assert.equal(codeFromFetchError(timeoutErr, live.signal, timeout.signal), 'TIMEOUT')

  // 超时信号已中止 → TIMEOUT（即使异常形态不明确）
  const t = new AbortController()
  t.abort()
  assert.equal(codeFromFetchError(new TypeError('fetch failed'), live.signal, t.signal), 'TIMEOUT')

  // **两个信号都中止时，外部取消优先**：调用方主动取消不应被报成"超时"，
  // 否则上层会把用户取消当失败计入指标。
  external.abort()
  const both = new AbortController()
  both.abort()
  assert.equal(codeFromFetchError(new TypeError('fetch failed'), external.signal, both.signal), 'ABORTED')
})
