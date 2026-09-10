/**
 * 密钥形态识别与脱敏的单元测试。
 *
 * 重点在**反例**：误伤 `OPENAI_API_KEY` 这类变量名会让插件无法激活（配置其实是对的），
 * 比漏判一处日志危险得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_REDACT_LENGTH,
  SENSITIVE_HEADER_NAMES,
  detectSuspiciousCredential as detect,
  redact,
} from '../src/index.js'

/* ------------------------- detectSuspiciousCredential ------------------------- */

test('detectSuspiciousCredential：命中常见厂商前缀与高熵形态', () => {
  const positives = [
    'sk-abcdefghijklmnop', // OpenAI 风格
    'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'rk-abcdefghijklmnop',
    'xai-abcdefghijklmnop',
    'gsk-abcdefghijklmnop',
    'hf-abcdefghijklmnop',
    'pk-abcdefghijklmnop',
    'AIzaSyA1234567890abcdefghijklmnop',
    'ya29.abcdefghijklmnopqrstuvwx',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'abcdef0123456789abcdef0123456789abcdef01', // 长度 ≥40 的混合大小写字母数字
  ]
  for (const v of positives) {
    assert.equal(detect(v), true, `应判为可疑: ${v}`)
  }
})

test('detectSuspiciousCredential：反例不得误伤（变量名/URL/模型名/短串）', () => {
  const negatives = [
    'DEEPSEEK_API_KEY', // 全大写 SNAKE：最常见且必须放行
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEEWIKI_LLM_KEY_2',
    'http://127.0.0.1:8080/v1',
    'https://api.deepseek.com/v1/chat/completions',
    'gpt-4o-mini',
    'deepseek-chat',
    'claude-3-5-sonnet-20241022',
    'sk-1', // 短串：不可能是真密钥
    '',
    '   ',
    'hello world',
    'a b c d e f g h i j k l m n o p q r s t u v w x y z',
  ]
  for (const v of negatives) {
    assert.equal(detect(v), false, `不得判为可疑: ${JSON.stringify(v)}`)
  }
})

test('detectSuspiciousCredential：全大写 SNAKE 一律放行（含长度很长的）', () => {
  assert.equal(detect('A'.repeat(60)), false, '纯大写 60 位：按变量名处理（保守优先）')
  assert.equal(detect('MY_VERY_LONG_API_KEY_NAME_FOR_TESTING_PURPOSES_ONLY'), false)
})

/* ------------------------------------ redact ----------------------------------- */

test('redact：命中片段被替换，且只替换 ≥ MIN_REDACT_LENGTH 的片段', () => {
  assert.equal(MIN_REDACT_LENGTH, 16)
  const long = 'sk-abcdefghijklmnop'
  assert.equal(redact(`请求失败: key=${long}`), '请求失败: key=***')
  // 短串不替换：否则日志会被 *** 淹没
  assert.equal(redact('key=sk-1'), 'key=sk-1')
})

test('redact：遮蔽敏感头名后面的值（无论像不像密钥）', () => {
  for (const name of SENSITIVE_HEADER_NAMES) {
    const out = redact(`${name}: Bearer abcdefg`)
    assert.ok(out.includes('***'), `${name} 的值应被遮蔽: ${out}`)
    assert.ok(!out.includes('abcdefg'), `${name} 的原值不应残留: ${out}`)
  }
})

test('redact：头名的多种书写形态都能遮蔽值', () => {
  const cases = [
    'Authorization: Bearer tokenvalue123',
    'authorization=tokenvalue123',
    '"x-api-key":"tokenvalue123"',
    "{'api-key': 'tokenvalue123'}",
    'proxy-authorization: Basic dXNlcjpwYXNz',
  ]
  for (const c of cases) {
    const out = redact(c)
    assert.ok(out.includes('***'), `应遮蔽: ${c} → ${out}`)
    assert.ok(!out.includes('tokenvalue123') && !out.includes('dXNlcjpwYXNz'), `原值不应残留: ${out}`)
  }
})

test('redact：多处命中全部替换，且可重复调用（全局正则 lastIndex 不残留）', () => {
  const text = `a=sk-aaaaaaaaaaaaaaaa b=AIzaSyA1234567890abcdefghijklmnop c=sk-bbbbbbbbbbbbbbbb`
  const once = redact(text)
  assert.equal((once.match(/\*\*\*/g) ?? []).length, 3, once)
  assert.equal(redact(text), once, '同样输入应得同样输出（正则状态未泄漏）')
})

test('redact：JSON 往返后仍无泄漏（防"结构化日志把密钥带出去"）', () => {
  const payload = { error: 'boom', authorization: 'Bearer sk-abcdefghijklmnop', nested: { key: 'sk-zzzzzzzzzzzzzzzz' } }
  const line = JSON.stringify({ ...payload, error: redact(payload.error) })
  const safe = redact(line)
  assert.ok(!safe.includes('sk-abcdefghijklmnop'), safe)
  assert.ok(!safe.includes('sk-zzzzzzzzzzzzzzzz'), safe)
  assert.ok(!JSON.parse(safe).authorization.includes('sk-abcdefghijklmnop'), safe)
})

test('redact：非字符串输入被安全归一化（不抛异常）', () => {
  assert.equal(typeof redact(undefined), 'string')
  assert.equal(typeof redact(new Error('sk-abcdefghijklmnop')), 'string')
  assert.ok(!redact(new Error('key sk-abcdefghijklmnop')).includes('sk-abcdefghijklmnop'))
})
