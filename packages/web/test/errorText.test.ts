/**
 * 错误文案纯函数测试（`lib/errorText.ts`）。
 *
 * 这层是"界面不出现技术细节"的**唯一执行点**，所以测试的重点不是"文案好看"，而是
 * **不变量**：无论如何输入，输出都不含 API 路径、不含英文堆栈、不超长；
 * 且**分类正确**（连不上服务 ≠ 服务出错 ≠ 请求被拒），因为分类决定了要不要给"重试"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/api'
import { cleanHint, describeError, streamErrorText } from '../src/lib/errorText'

test('cleanHint：剥掉 API 路径与英文堆栈，并截断', () => {
  // 纯技术串（无中文）一律不展示 —— 这对用户零信息量
  assert.equal(cleanHint('not_found: /api/pages/foo'), '')
  assert.equal(cleanHint('TypeError: Failed to fetch'), '')
  // 含中文的说明保留，但里面的 URL / 路径被剥掉
  assert.equal(cleanHint('见 https://example.com/x 的说明'), '见 的说明')
  assert.equal(cleanHint('页面不存在: /api/pages/x'), '页面不存在')
  assert.ok(cleanHint('あ'.repeat(500)).length <= 140, '超长必须截断')
  assert.equal(cleanHint(undefined), '')
  assert.equal(cleanHint(123), '')
})

test('describeError：连不上服务（TypeError）优先于一切，且可重试', () => {
  const v = describeError(new TypeError('Failed to fetch'))
  assert.equal(v.kind, 'unreachable')
  assert.equal(v.retryable, true)
  assert.match(v.title, /连不上服务/)
  // 关键：标题里不能出现原文
  assert.ok(!v.title.includes('fetch'))
})

test('describeError：404 归"不存在"，5xx 归"服务暂时出错"，二者都可重试', () => {
  const nf = describeError(new ApiError(404, 'not_found', '页面不存在: /api/pages/x'))
  assert.equal(nf.kind, 'notFound')
  assert.equal(nf.retryable, true)
  assert.ok(!nf.hint.includes('/api/'), 'hint 不得含 API 路径')

  const sv = describeError(new ApiError(500, 'internal', '服务器内部错误'))
  assert.equal(sv.kind, 'server')
  assert.equal(sv.retryable, true)
})

test('describeError：4xx 参数类错误**不给重试**（重试同样会失败，给了是误导）', () => {
  const v = describeError(new ApiError(400, 'invalid_config', '配置校验失败'))
  assert.equal(v.kind, 'client')
  assert.equal(v.retryable, false)
})

test('describeError：非 Error 的抛出值也不会把原始值泄漏到标题', () => {
  const v = describeError('boom /api/secret')
  assert.equal(v.kind, 'unknown')
  assert.ok(!v.title.includes('/api/'))
  assert.ok(!v.hint.includes('/api/'))
})

test('streamErrorText：已知码给人话，未知码有兜底且**不回显内部码**', () => {
  const rate = streamErrorText('RATE_LIMIT')
  assert.match(rate.title, /限流/)
  assert.ok(!rate.title.includes('RATE_LIMIT'), '内部错误码不得出现在标题里')

  const unknown = streamErrorText('SOMETHING_NEW')
  assert.ok(unknown.title.length > 0)
  assert.ok(!unknown.title.includes('SOMETHING_NEW'))
  // 每个分支都必须有"怎么办"
  for (const code of ['RATE_LIMIT', 'TIMEOUT', 'AUTH', 'NETWORK', 'ABORTED', 'NOPE']) {
    assert.ok(streamErrorText(code).hint.length > 0, `${code} 必须有 hint`)
  }
})
