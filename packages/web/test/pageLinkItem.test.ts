/**
 * **链接项三态渲染** —— SSR 集成测试（无浏览器）。
 * ============================================================================
 *
 * `pageLinksPlan.test.ts` 覆盖的是**判断**（"这个 ref 算哪一态"），本文件补的是另一半：
 * **组件真的按那一态渲染了吗**。一个只在纯函数里正确、渲染时忘了分支的判断，等于没有判断。
 *
 * 做法与 `navGate.test.ts` 一致：`react-dom/server` 渲染成静态 HTML 后直接断言输出。
 * 这里比它更简单 —— `PageLinkItem` 是**纯展示**的（不取数、不读 store），所以不需要 shim
 * `window`/`document`，模块图里也只有 `react` 与两个纯函数模块。
 *
 * ## 为什么 `'hidden'` 那条断言是"一个 `<a>` 都不能有"
 *
 * 「存在但你看不到」的正确渲染是**不可点的文本**。若渲染成 `<a>`，用户点下去必然 404；
 * 若渲染成**红链**，用户会去**创建一个已经存在的页面** ⇒ 脏数据 + 错误引导（§5.5）。
 * 所以这条不能只断言"没有 `data-gw-missing`"，必须断言**根本没有链接**——后者才是"点不了"的证据。
 *
 * ## 反空洞
 *
 * 只断言"hidden 没有 a"是不够的：把整个组件改成永远返回空 `<li>`，测试也会全绿。
 * 所以每一态都同时断言**它该有的东西在**（红链有创建入口、正常态有 href）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import type { PageLinkRef } from '../src/api'
import { PageLinkItem } from '../src/components/PageLinkItem'

function render(item: PageLinkRef): string {
  return renderToStaticMarkup(React.createElement('ul', null, React.createElement(PageLinkItem, { item })))
}

/** 出现次数（比 `includes` 有信息量：能区分"没有"与"有两个"） */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/* ------------------------------- ① 正常：存在且可见 ------------------------------- */

test('exists === true → 正常链接，无红链标记、无创建入口', () => {
  const html = render({ slug: 'guides/authoring', title: '写作指南', exists: true })
  assert.equal(count(html, '<a '), 1, html)
  assert.ok(html.includes('href="#/wiki/guides%2Fauthoring"'), html)
  assert.ok(html.includes('写作指南'), html)
  assert.equal(count(html, 'data-gw-missing'), 0, html)
  assert.equal(count(html, 'data-gw-hidden'), 0, html)
  assert.equal(count(html, '新建该页'), 0, html)
})

/* --------------------------- ② 红链：确实不存在，可创建 --------------------------- */

test('exists === false → 红链：弱化标记 + 说明 + 「新建该页」入口', () => {
  const html = render({ slug: 'ghost-page', title: null, exists: false })
  assert.equal(count(html, 'data-gw-missing'), 1, html)
  assert.equal(count(html, 'data-gw-hidden'), 0, html)
  assert.ok(html.includes('（目标页面不存在）'), html)
  assert.equal(count(html, '新建该页'), 1, html)
  assert.ok(html.includes('href="#/wiki/new"'), html)
  // 标题为空时退化为 slug，列表项不会看起来像坏了。
  assert.ok(html.includes('ghost-page'), html)
})

/* ------------------ ③ 存在但看不到：**既不是链接、也不是红链** ------------------ */

test('exists === \'hidden\' → 文本而非链接，且**绝无**创建入口', () => {
  const html = render({ slug: 'secret-page', title: null, exists: 'hidden' })
  // 核心断言：一个 <a> 都不能有 —— "点不了"要靠这个证明，不能只看没有红链标记。
  assert.equal(count(html, '<a '), 0, html)
  assert.equal(count(html, 'data-gw-hidden'), 1, html)
  // 归错成红链的后果正是这两条：用户被引导去创建一个已存在的页。
  assert.equal(count(html, 'data-gw-missing'), 0, html)
  assert.equal(count(html, '新建该页'), 0, html)
  assert.equal(count(html, 'href='), 0, html)
  // 反空洞：这一态必须**确有内容**（否则组件恒返回空 <li> 也能通过上面所有断言）。
  assert.ok(html.includes('（存在但无权查看）'), html)
  assert.ok(html.includes('secret-page'), html)
  assert.ok(html.includes('已存在'), html) // hiddenHint 里的措辞：告诉用户别去新建
})

/* --------------------- ④ 未知：兼容旧后端，**保守到不提供创建** --------------------- */

test('exists 缺失 → 正常链接，但**不提供**创建入口', () => {
  const html = render({ slug: 'legacy', title: '旧后端返回' })
  assert.equal(count(html, 'data-gw-missing'), 0, html)
  assert.equal(count(html, 'data-gw-hidden'), 0, html)
  assert.equal(count(html, '新建该页'), 0, html)
  assert.ok(html.includes('href="#/wiki/legacy"'), html)
})

test('exists 缺失且 title 为 null → **仍不**提供创建入口（"不知道"不等于"不存在"）', () => {
  /*
    这是本文件最容易被写错的一条：`title === null` 看起来就像"目标不存在"，
    于是很自然地想把它当成红链。但那只是 LEFT JOIN 的副产物；`exists` 缺失说明
    **后端没告诉我们**，而把"不知道"当"不存在"就会给出一个可能建出重复页的入口。
    反向链接走的正是这一态（服务端已按可见性过滤过），所以它必须安静地渲染成普通链接。
  */
  const html = render({ slug: 'maybe', title: null })
  assert.equal(count(html, 'data-gw-missing'), 0, html)
  assert.equal(count(html, '新建该页'), 0, html)
  assert.ok(html.includes('href="#/wiki/maybe"'), html)
  assert.ok(html.includes('maybe'), html)
})
