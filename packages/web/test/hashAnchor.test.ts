/**
 * 页内锚点与 hash 路由共存的单测（node:test + tsx）。
 *
 * 这组用例存在的唯一理由：本应用是 **hash 路由**，而"标题锚点"的常规写法 `#section`
 * 会被路由解析器当成一个新路由 —— **点一下目录就跳走**。下面钉住解析与拼装两侧，
 * 确保"路由只取 `?` 之前的部分"这条不变量不会被后人改坏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANCHOR_PARAM, buildHash, readHashAnchor, stripHashQuery } from '../src/lib/hashAnchor'

/* ------------------------- stripHashQuery ------------------------- */

test('stripHashQuery：剥掉锚点查询串，得到纯路由（否则 slug 会变成 `foo?a=x`）', () => {
  assert.equal(stripHashQuery('#/wiki/foo?a=usage'), 'wiki/foo')
  assert.equal(stripHashQuery('#wiki/foo?a=usage'), 'wiki/foo') // 容错：没有 `#/` 也认
})

test('stripHashQuery：没有查询串时原样返回', () => {
  assert.equal(stripHashQuery('#/wiki/foo'), 'wiki/foo')
  assert.equal(stripHashQuery('#/wiki'), 'wiki')
  assert.equal(stripHashQuery(''), '')
})

test('stripHashQuery：锚点里有 `=` 或多个参数也不影响路由', () => {
  assert.equal(stripHashQuery('#/wiki/foo?a=a%3Db'), 'wiki/foo')
  assert.equal(stripHashQuery('#/wiki/foo?a=x&b=y'), 'wiki/foo')
})

/* ------------------------- readHashAnchor ------------------------- */

test('readHashAnchor：读出锚点 id（含百分号编码的中文）', () => {
  assert.equal(readHashAnchor('#/wiki/foo?a=usage'), 'usage')
  assert.equal(readHashAnchor(`#/wiki/foo?${ANCHOR_PARAM}=${encodeURIComponent('中文小节')}`), '中文小节')
})

test('readHashAnchor：无锚点/空值 → null', () => {
  assert.equal(readHashAnchor('#/wiki/foo'), null)
  assert.equal(readHashAnchor('#/wiki/foo?a='), null)
  assert.equal(readHashAnchor('#/wiki/foo?b=other'), null)
  assert.equal(readHashAnchor(''), null)
})

test('readHashAnchor：截断的百分号编码不会抛错（地址栏是用户可手改的输入）', () => {
  // `URLSearchParams` 对非法 UTF-8 序列给出替换字符 U+FFFD，而不是抛错。
  // 这样的 id 在页面上必然找不到元素 ⇒ 滚动分支会静默跳过（不崩、不跳错位置）。
  const out = readHashAnchor('#/wiki/foo?a=%E4%B8')
  assert.equal(typeof out, 'string')
  assert.equal(out, '\uFFFD')
})

test('readHashAnchor：**不做二次解码**——锚点里含字面量 % 也要原样读出', () => {
  // 这是真实踩过的坑：`URLSearchParams` 已经解码过一次，若再 `decodeURIComponent`，
  // id 里的字面量 `%41` 会被解成 `A`，于是锚点点不动。
  assert.equal(readHashAnchor('#/wiki/foo?a=%2541'), '%41')
  assert.equal(readHashAnchor('#/wiki/foo?a=100%25-done'), '100%-done')
})

/* ------------------------- buildHash ------------------------- */

test('buildHash：带上锚点时编码，且路由段保持可读', () => {
  assert.equal(buildHash('wiki/foo', 'usage'), '#/wiki/foo?a=usage')
  assert.equal(buildHash('wiki/foo', '中文小节'), `#/wiki/foo?a=${encodeURIComponent('中文小节')}`)
})

test('buildHash：无锚点时就是普通路由（不应多出 `?`）', () => {
  assert.equal(buildHash('wiki/foo', null), '#/wiki/foo')
  assert.equal(buildHash('wiki/foo', ''), '#/wiki/foo')
})

test('buildHash：传入带前缀的路由也能规范化（idempotent，避免出现 `#/#/`）', () => {
  assert.equal(buildHash('#/wiki/foo', null), '#/wiki/foo')
  assert.equal(buildHash('/wiki/foo', 'x'), '#/wiki/foo?a=x')
})

test('往返一致：buildHash → stripHashQuery / readHashAnchor 得到原值', () => {
  const route = 'wiki/my-page'
  const anchor = '第-2-节'
  const hash = buildHash(route, anchor)
  assert.equal(stripHashQuery(hash), route)
  assert.equal(readHashAnchor(hash), anchor)
})
