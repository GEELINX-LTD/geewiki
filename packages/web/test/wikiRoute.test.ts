/**
 * `lib/wikiRoute.ts` 的单测。
 *
 * 这个文件的存在本身就是为了防止"分层 slug 打不开"再回来——那个缺陷在组件里
 * 没有任何测试能碰到（只在真浏览器里表现为闪回列表 / 404）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOME_SLUG,
  parseWikiRoute,
  WIKI_RESERVED_FIRST_SEGMENTS,
  wikiRouteHash,
} from '../src/lib/wikiRoute'

test('parseWikiRoute：空 / → 主页（默认落点），list → 列表', () => {
  // 空路由是**主页**而不是列表：主页是一篇文章，列表退居「全部页面」（`#/wiki/list`）
  assert.deepEqual(parseWikiRoute(''), { kind: 'home' })
  assert.deepEqual(parseWikiRoute('/'), { kind: 'home' })
  assert.deepEqual(parseWikiRoute('list'), { kind: 'list' })
})

test('HOME_SLUG：约定 slug 不得落在保留段里（否则主页会被自己的解析器吃掉）', () => {
  assert.equal(WIKI_RESERVED_FIRST_SEGMENTS.includes(HOME_SLUG), false)
  // 反空洞：保留段集合本身还在（防止上面的断言因集合变空而恒真）
  assert.ok(WIKI_RESERVED_FIRST_SEGMENTS.length >= 4)
  // `home` 仍能作为普通详情 slug 解析（重定向到 `#/wiki` 由组件负责）
  assert.deepEqual(parseWikiRoute(HOME_SLUG), { kind: 'detail', slug: 'home' })
})

test('parseWikiRoute：保留段 new / search / ask', () => {
  assert.deepEqual(parseWikiRoute('new'), { kind: 'new' })
  assert.deepEqual(parseWikiRoute('search'), { kind: 'search', q: '' })
  assert.deepEqual(parseWikiRoute('search/hello'), { kind: 'search', q: 'hello' })
  assert.deepEqual(parseWikiRoute('ask'), { kind: 'ask', q: '' })
  assert.deepEqual(parseWikiRoute('ask/what%20is%20x'), { kind: 'ask', q: 'what is x' })
})

test('parseWikiRoute：检索词的 `/` 被保留（不被当成路径段）', () => {
  // 查询串本身含斜杠（编码后）——取首段之后的全部再拼回
  assert.deepEqual(parseWikiRoute('search/a%2Fb'), { kind: 'search', q: 'a/b' })
})

test('parseWikiRoute：**编码的分层 slug** → 详情页且 slug 已解码（回归：双重编码 404）', () => {
  assert.deepEqual(parseWikiRoute('guide%2Fintro'), { kind: 'detail', slug: 'guide/intro' })
})

test('parseWikiRoute：**未编码的分层 slug** → 详情页（回归：曾被当成未知深层跳回列表）', () => {
  assert.deepEqual(parseWikiRoute('guide/intro'), { kind: 'detail', slug: 'guide/intro' })
  assert.deepEqual(parseWikiRoute('a/b/c'), { kind: 'detail', slug: 'a/b/c' })
})

test('parseWikiRoute：两种写法归一为同一个 slug', () => {
  assert.deepEqual(parseWikiRoute('guide%2Fintro'), parseWikiRoute('guide/intro'))
})

test('parseWikiRoute：单段 slug 仍然是详情页（既有行为不变）', () => {
  assert.deepEqual(parseWikiRoute('getting-started'), { kind: 'detail', slug: 'getting-started' })
})

test('parseWikiRoute：末尾 edit → 编辑路由，且 slug 不含 edit', () => {
  assert.deepEqual(parseWikiRoute('getting-started/edit'), { kind: 'edit', slug: 'getting-started' })
  assert.deepEqual(parseWikiRoute('guide%2Fintro/edit'), { kind: 'edit', slug: 'guide/intro' })
  assert.deepEqual(parseWikiRoute('a/b/edit'), { kind: 'edit', slug: 'a/b' })
})

test('parseWikiRoute：名字就叫 edit 的页面仍可打开（单段 edit 不是编辑路由）', () => {
  assert.deepEqual(parseWikiRoute('edit'), { kind: 'detail', slug: 'edit' })
})

test('parseWikiRoute：坏转义不抛错（退回原串，避免整页白屏）', () => {
  assert.deepEqual(parseWikiRoute('a%'), { kind: 'detail', slug: 'a%' })
  assert.deepEqual(parseWikiRoute('%E0%A4%A'), { kind: 'detail', slug: '%E0%A4%A' })
})

test('parseWikiRoute：多余斜杠被忽略（不会产生空段 slug）', () => {
  assert.deepEqual(parseWikiRoute('/guide//intro/'), { kind: 'detail', slug: 'guide/intro' })
})

test('wikiRouteHash：slug 被编码（`/` 变 %2F），且未编码的斜杠不会漏出去', () => {
  assert.equal(wikiRouteHash('getting-started'), '#/wiki/getting-started')
  assert.equal(wikiRouteHash('guide/intro'), '#/wiki/guide%2Fintro')
  assert.ok(!wikiRouteHash('guide/intro').slice('#/wiki/'.length).includes('/'))
})

test('保留段清单与后端一致（顺序无关，集合相同）', () => {
  assert.deepEqual([...WIKI_RESERVED_FIRST_SEGMENTS].sort(), ['ask', 'list', 'new', 'search'])
})
