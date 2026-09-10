/**
 * 页面表单校验与脏值判定单测（node:test + tsx）。
 *
 * 与后端 `SLUG_RE` 的一致性由本文件钉住：前端若比后端**宽**，用户会白填一遍再被 400 拒；
 * 若比后端**严**，则会出现"后端明明接受、前端不让存"。两者的字符集必须逐字一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLUG_RE,
  charCount,
  hasErrors,
  isDirty,
  validatePageForm,
} from '../src/lib/pageFormPlan'

/* ------------------------- 字段级校验 ------------------------- */

test('validatePageForm：新建页缺标题 → 只有 title 报错（字段级，不糊成一团）', () => {
  const errors = validatePageForm({ isNew: true, slugInput: 'ok-slug', title: '  ' })
  assert.deepEqual(Object.keys(errors), ['title'])
})

test('validatePageForm：新建页标识非法 → slug 报错且带明确提示', () => {
  const errors = validatePageForm({ isNew: true, slugInput: '中文标识', title: '标题' })
  assert.ok(errors.slug !== undefined)
  assert.match(errors.slug as string, /字母或数字开头/)
})

test('validatePageForm：两个字段都错时一次报全（而不是改一个再报下一个）', () => {
  const errors = validatePageForm({ isNew: true, slugInput: '-bad', title: '' })
  assert.deepEqual(Object.keys(errors).sort(), ['slug', 'title'])
  assert.equal(hasErrors(errors), true)
})

test('validatePageForm：编辑既有页面**不校验标识**（标识不可改，用户也无从填错）', () => {
  const errors = validatePageForm({ isNew: false, slugInput: '完全不合法!!', title: '标题' })
  assert.deepEqual(errors, {})
})

test('validatePageForm：合法输入无错误', () => {
  assert.deepEqual(validatePageForm({ isNew: true, slugInput: 'getting-started', title: '快速开始' }), {})
})

test('SLUG_RE：与后端同口径的边界（首字符必须是字母数字；总长 ≤80）', () => {
  assert.equal(SLUG_RE.test('a'), true)
  assert.equal(SLUG_RE.test('9'), true)
  assert.equal(SLUG_RE.test('a.b_c-d'), true)
  assert.equal(SLUG_RE.test('.a'), false) // 以点开头
  assert.equal(SLUG_RE.test('-a'), false)
  assert.equal(SLUG_RE.test('a b'), false)
  assert.equal(SLUG_RE.test('a/b'), false)
  assert.equal(SLUG_RE.test(`a${'b'.repeat(79)}`), true) // 80 字符
  assert.equal(SLUG_RE.test(`a${'b'.repeat(80)}`), false) // 81 字符
})

test('validatePageForm：标识首尾空白由调用方 trim 后判定（全空白视为非法）', () => {
  assert.equal(hasErrors(validatePageForm({ isNew: true, slugInput: '   ', title: 't' })), true)
  assert.equal(hasErrors(validatePageForm({ isNew: true, slugInput: ' ok ', title: 't' })), false)
})

/* ------------------------- 脏值判定 ------------------------- */

test('isDirty：内容一致 → false', () => {
  const base = { title: 't', content: 'c', slugInput: 's' }
  assert.equal(isDirty(base, { ...base }), false)
})

test('isDirty：任一字段变化 → true（标题/正文/标识都算）', () => {
  const base = { title: 't', content: 'c', slugInput: 's' }
  assert.equal(isDirty(base, { ...base, title: 't2' }), true)
  assert.equal(isDirty(base, { ...base, content: 'c2' }), true)
  assert.equal(isDirty(base, { ...base, slugInput: 's2' }), true)
})

test('isDirty：只差空白也算改动（否则用户会遇到"改了却不提醒离开"）', () => {
  const base = { title: 't', content: 'c', slugInput: 's' }
  assert.equal(isDirty(base, { ...base, content: 'c ' }), true)
})

/* ------------------------- 字符计数 ------------------------- */

test('charCount：按字符计（中文一个字算一个，符合直觉）', () => {
  assert.equal(charCount('中文abc'), 5)
  assert.equal(charCount(''), 0)
})

test('charCount：代理对（emoji）算一个字符，而不是 2（否则计数会虚高）', () => {
  assert.equal(charCount('🎉'), 1)
  assert.equal(charCount('a🎉b'), 3)
})
