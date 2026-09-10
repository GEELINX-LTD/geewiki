/**
 * 管理台展示层映射的单测。
 *
 * 重点覆盖两类容易出错的地方：
 * 1. **回退链**：`displayName` 缺失/空白时必须回退到去 scope 的短名，且不能显示空标题；
 * 2. **不在词中折行**：`labelSegments` 的切分点必须落在分隔符之后，
 *    否则 React Flow 节点又会从词中间劈开（既有缺陷，截图实测过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LAYER_HUMAN,
  LAYER_TECH,
  PERSIST_HINT,
  SESSION_LAYER_HINT,
  STATE_TEXT,
  descriptionOf,
  displayNameOf,
  estimateNodeWidth,
  labelSegments,
  plainName,
  stateTone,
} from '../src/lib/pluginDisplay'

/* ------------------------------ plainName ------------------------------ */

test('plainName：剥一层 npm scope；无 scope 原样返回', () => {
  assert.equal(plainName('@geewiki/db-sqlite'), 'db-sqlite')
  assert.equal(plainName('@geewiki-plugin/hello'), 'hello')
  assert.equal(plainName('foo'), 'foo')
  // 只剥一层：第二段里的斜杠保留
  assert.equal(plainName('@scope/a/b'), 'a/b')
  // 边界：`@` 后没有斜杠不是合法 scope，原样返回
  assert.equal(plainName('@noscopeslash'), '@noscopeslash')
  assert.equal(plainName(''), '')
})

/* --------------------------- displayNameOf ---------------------------- */

test('displayNameOf：优先 displayName，缺失/空白回退去 scope 短名', () => {
  assert.equal(displayNameOf({ name: '@geewiki/wiki', displayName: '知识库' }), '知识库')
  assert.equal(displayNameOf({ name: '@geewiki/wiki' }), 'wiki')
  // 空白视为未提供（否则会出现一个空标题，比显示短名更糟）
  assert.equal(displayNameOf({ name: '@geewiki/wiki', displayName: '   ' }), 'wiki')
  assert.equal(displayNameOf({ name: '@geewiki/wiki', displayName: '' }), 'wiki')
  // 前后空白要修掉
  assert.equal(displayNameOf({ name: 'x', displayName: '  知识库  ' }), '知识库')
})

test('descriptionOf：缺失或空白返回 undefined（调用方据此不渲染该行）', () => {
  assert.equal(descriptionOf({ name: 'x', description: '全文检索' }), '全文检索')
  assert.equal(descriptionOf({ name: 'x' }), undefined)
  assert.equal(descriptionOf({ name: 'x', description: '  ' }), undefined)
})

/* --------------------------- labelSegments ---------------------------- */

test('labelSegments：切分点必须落在分隔符之后（不得在词中折行）', () => {
  assert.deepEqual(labelSegments('@geewiki-plugin/hello'), ['@geewiki-', 'plugin/', 'hello'])
  assert.deepEqual(labelSegments('@geewiki/db-sqlite'), ['@geewiki/', 'db-', 'sqlite'])
  // 无分隔符 => 单片段（调用方给足宽度即可，不会从中间劈开）
  assert.deepEqual(labelSegments('sqlite'), ['sqlite'])
  assert.deepEqual(labelSegments(''), [])
})

test('labelSegments：拼接回去必须与原串逐字相同（不丢字符）', () => {
  for (const s of ['@geewiki-plugin/hello', 'a-b_c.d/e', 'x', '@a/b']) {
    assert.equal(labelSegments(s).join(''), s, `拼接应还原 ${s}`)
  }
})

/* -------------------------- estimateNodeWidth ------------------------- */

test('estimateNodeWidth：按最长片段给宽，且被 min/max 夹住', () => {
  // 短名取 min
  assert.equal(estimateNodeWidth('a', 150, 260), 150)
  // 超长名不超过 max（避免撑出巨宽节点）
  assert.equal(estimateNodeWidth('@' + 'x'.repeat(200), 150, 260), 260)
  // 中间值随最长片段单调不减
  const w1 = estimateNodeWidth('db-sqlite', 150, 260)
  const w2 = estimateNodeWidth('a-much-longer-plugin-name', 150, 260)
  assert.ok(w2 >= w1, `更长的名字不应更窄：${w1} vs ${w2}`)
  assert.ok(w1 >= 150 && w1 <= 260)
  assert.ok(w2 >= 150 && w2 <= 260)
})

/* ------------------------------ 映射表 -------------------------------- */

test('状态/层/来源的措辞：三态齐全，且层的人话与术语都给了', () => {
  assert.deepEqual(Object.keys(STATE_TEXT).sort(), ['active', 'error', 'inactive'])
  // 人话用于主行，术语用于详情，两者都不能漏
  assert.equal(LAYER_HUMAN.base, '随启动加载')
  assert.equal(LAYER_HUMAN.session, '临时启用')
  assert.match(LAYER_TECH.base, /基础层/)
  assert.match(LAYER_TECH.session, /会话层/)
  assert.equal(stateTone('active'), 'ok')
  assert.equal(stateTone('inactive'), 'neutral')
  assert.equal(stateTone('error'), 'warn')
})

test('会话层文案必须与 boot() 的真实行为一致（不得写成"重启即失"）', () => {
  // 读 packages/manager/src/index.ts 的 boot()：正常启动会重新装配会话层（:640），
  // 只有检测到崩溃标记时才忽略并清空（:628-637）。故文案必须区分这两种重启。
  assert.match(SESSION_LAYER_HINT, /正常重启仍会保留/)
  assert.match(SESSION_LAYER_HINT, /异常崩溃/)
  assert.doesNotMatch(SESSION_LAYER_HINT, /重启即失/)
  assert.match(PERSIST_HINT, /任何/)
})
