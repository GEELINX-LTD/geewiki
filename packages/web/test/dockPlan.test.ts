/**
 * `app-dock` 的宿主侧纯逻辑测试：路由 → 页面上下文。
 *
 * 这条翻译错起来**很安静**：把列表页翻译成"当前页 = 上一篇"不会报错、不会告警，
 * 只会让模型对着旧上下文回答，而用户看不出答案为什么不对。所以每个"没有当前页"的
 * 视图都要有一条断言钉住它必须返回 `null`。
 *
 * ★ 主页批（2026-09-18）：`#/wiki` 的"当前页"由**站点设置**决定，故判据多了一个入参
 * （`homeSlug`）。下面用例里的 `DEFAULT_HOME` 是"主页就是约定那一篇"——本批之前的唯一形态，
 * 行为必须逐条不变；文末新增的一批钉住"主页被设成别的 slug"与"结论还没到"两种新形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageContextOf } from '../src/lib/dockPlan'

/** 主页 = 约定 slug 那一篇（未设置过时的默认形态） */
const DEFAULT_HOME = 'home'

test('主页：`wiki` 解析成 home 文章的阅读态（不是 null）', () => {
  assert.deepEqual(pageContextOf('wiki', DEFAULT_HOME), { slug: 'home', kind: 'view' })
})

test('主页被设成别的 slug 时：`wiki` 的当前页就是那一篇（不再写死 home）', () => {
  // 漏掉这一条的症状：用户在主页上问"总结这一页"，模型去读了 `home`——
  // 一篇可能根本不存在、或者完全不相干的文章，而答案看起来很正常。
  assert.deepEqual(pageContextOf('wiki', 'guide/intro'), { slug: 'guide/intro', kind: 'view' })
  // 详情路由不受影响：`wiki/home` 打开的就是 `home` 这篇文章本身
  assert.deepEqual(pageContextOf('wiki/home', 'guide/intro'), { slug: 'home', kind: 'view' })
})

test('主页结论还没到 / 读不到（null）时：`wiki` 宁可没有当前页，也不许猜一个 slug', () => {
  // 与本文件头注同一条纪律：猜出来的上下文比没有上下文更糟（错得安静）。
  assert.equal(pageContextOf('wiki', null), null)
  // 其余路由与这个入参无关，不受影响
  assert.deepEqual(pageContextOf('wiki/guide%2Fintro', null), { slug: 'guide/intro', kind: 'view' })
})

test('详情页：分层 slug 原样带出，kind=view', () => {
  assert.deepEqual(pageContextOf('wiki/guides/intro', DEFAULT_HOME), { slug: 'guides/intro', kind: 'view' })
  assert.deepEqual(pageContextOf('wiki/home', DEFAULT_HOME), { slug: 'home', kind: 'view' })
})

test('编辑页：同一 slug 下 kind 变成 edit（编辑态才有选区可改）', () => {
  assert.deepEqual(pageContextOf('wiki/guides/intro/edit', DEFAULT_HOME), { slug: 'guides/intro', kind: 'edit' })
  // 阅读态与编辑态的 slug 相同、kind 不同——插件靠 kind 区分"能问"与"能改"
  assert.notDeepEqual(pageContextOf('wiki/guides/intro', DEFAULT_HOME), pageContextOf('wiki/guides/intro/edit', DEFAULT_HOME))
})

test('**没有当前页**的视图一律 null：列表 / 新建 / 检索 / 问答', () => {
  for (const route of ['wiki/list', 'wiki/new', 'wiki/search/foo', 'wiki/ask/foo']) {
    assert.equal(pageContextOf(route, DEFAULT_HOME), null, `${route} 不该有"当前页"`)
  }
})

test('非 wiki 路由一律 null：图谱 / 管理台 / 未知段 / 空路由', () => {
  for (const route of ['graph', 'plugins', 'notfound', '', 'access']) {
    assert.equal(pageContextOf(route, DEFAULT_HOME), null, `${route} 不该有"当前页"`)
  }
})

test('形近但不同前缀的段不得被误判成 wiki 子路由', () => {
  // `wikiX` 不是 `wiki/...`：用 startsWith('wiki') 判会把它当详情页，slug 变成垃圾
  assert.equal(pageContextOf('wikiX/foo', DEFAULT_HOME), null)
  assert.equal(pageContextOf('wikis', DEFAULT_HOME), null)
})

test('从"有当前页"回到"没有当前页"必须如实返回 null（不得回落到上一篇）', () => {
  // 这条是纯函数天然成立的，写成用例是为了把**契约**记下来：
  // 调用方（AppDock）不得在 null 时补一个缓存里的 slug。补了就会在列表页上
  // 回答"关于上一篇"的问题——比没有上下文更糟。
  assert.deepEqual(pageContextOf('wiki/guides/intro', DEFAULT_HOME), { slug: 'guides/intro', kind: 'view' })
  assert.equal(pageContextOf('wiki/list', DEFAULT_HOME), null)
})
