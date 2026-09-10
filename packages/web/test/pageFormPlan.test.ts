/**
 * 页面表单校验与脏值判定单测（node:test + tsx）。
 *
 * **slug 规则不在这里测**——它已迁到 `lib/slugRules.ts`，并由 `test/slugRules.test.ts`
 * 的**对齐守卫**真的 import 后端模块逐条比对。本文件只测"表单层"的行为
 * （字段级错误、trim、非新建态不校验、脏值判定）。
 *
 * 历史教训（本文件上一版）：这里曾断言 `SLUG_RE.test('a/b') === false`，并注释
 * "与后端逐字一致"。后端支持路径式 slug 之后，该断言把**错误行为**钉成了正确，
 * 于是"用户填 `guide/intro` 被前端拒掉"这件事在全绿测试下无人发现。
 * 规则类断言从此只放在有守卫的地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { charCount, hasErrors, isDirty, validatePageForm } from '../src/lib/pageFormPlan'

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

test('validatePageForm：**分层标识被接受**（回归：上一版前端会拒掉 guide/intro）', () => {
  assert.deepEqual(validatePageForm({ isNew: true, slugInput: 'guide/intro', title: '指南' }), {})
  assert.deepEqual(validatePageForm({ isNew: true, slugInput: 'a/b/c', title: '深层' }), {})
})

test('validatePageForm：错误提示**分类**（而不是一句通用话）', () => {
  const deep = validatePageForm({ isNew: true, slugInput: 'a/'.repeat(8) + 'x', title: 't' })
  assert.match(deep.slug as string, /层级过深/)

  const reserved = validatePageForm({ isNew: true, slugInput: 'search/x', title: 't' })
  assert.match(reserved.slug as string, /保留字/)

  const second = validatePageForm({ isNew: true, slugInput: 'guide/edit', title: 't' })
  assert.match(second.slug as string, /编辑路由/)

  const empty = validatePageForm({ isNew: true, slugInput: 'a//b', title: 't' })
  assert.match(empty.slug as string, /空段/)
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
