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
  isUnreachableSlug,
  isWikiHomeAlias,
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

test('parseWikiRoute：保留段 new / search', () => {
  assert.deepEqual(parseWikiRoute('new'), { kind: 'new' })
  assert.deepEqual(parseWikiRoute('search'), { kind: 'search', q: '' })
  assert.deepEqual(parseWikiRoute('search/hello'), { kind: 'search', q: 'hello' })
})

test('parseWikiRoute：`ask` 已不再是视图，但仍被后端拒为 slug 首段（P8 / 决策 17）', () => {
  /*
   * 这条钉的是"拆了视图、没解禁保留段"这个**刻意的不对称**。
   *
   * 拆掉解析分支后 `#/wiki/ask` 会落到详情页分支（`detail + slug='ask'`）——但那个页面
   * **不可能存在**：`'ask'` 仍在后端 `RESERVED_FIRST_SEGMENTS` 里，`ask` 这个 slug 建不出来。
   * 于是这个分支实际只会渲染"页面不存在"，而这正是想要的：既有的 `#/wiki/ask` 分享链接
   * 打开后是缺省提示，不会**静默变成一个页面**（解禁才会，且解禁是单向不可回收的）。
   */
  assert.ok(WIKI_RESERVED_FIRST_SEGMENTS.includes('ask'), '`ask` 必须留在保留段里（解禁是单向的）')
  assert.deepEqual(parseWikiRoute('ask'), { kind: 'detail', slug: 'ask' })
})

test('isUnreachableSlug：保留段开头的 slug 结构上不可能存在（后端拒建）', () => {
  /*
   * 这条钉的是 P8 暴露出来的那个"自洽但危险"的中间状态：拆了 `ask` 的视图分支之后，
   * `#/wiki/ask/foo` 会解析成 `detail + slug='ask/foo'`，而两个下游会把 detail 当成
   * "用户正看着一篇真实存在的文章"（dock 告诉模型"当前页是它"、命令面板把它记进最近访问）。
   * 判据收在 wikiRoute 一处，这两个下游共用。
   */
  for (const slug of ['ask', 'ask/foo', 'search/x', 'new', 'list']) {
    assert.equal(isUnreachableSlug(slug), true, `${slug} 不该被当成可访问的页面 slug`)
  }
  for (const slug of ['home', 'guide/intro', 'asking', 'listing', 'a/ask']) {
    assert.equal(isUnreachableSlug(slug), false, `${slug} 不是保留段开头，必须放行`)
  }
  // 反空洞：判据必须真的来自保留段集合，而不是一张写死的表
  assert.ok(WIKI_RESERVED_FIRST_SEGMENTS.length >= 4)
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

/*
 * 主页别名判据（`isWikiHomeAlias`）。
 *
 * 下面第一条用例是**回归测试**，对应 2026-09-14 在 3100 上实测到的缺陷：
 * `#/wiki/home/`（尾斜杠）冷加载**永久空白** —— 组件里的字符串全等守卫
 * （`stripHashQuery(hash) !== 'wiki/home'`）判 false ⇒ 不重写 URL；而 `parseWikiRoute` 把
 * `home/` 解析成 `detail + home` ⇒ 组件 `return null`。两者叠加就是"既不重写也不渲染"。
 * 判据收进本文件后，组件不再自己拼字符串，这类漂移没有第二个落点。
 *
 * ★ 主页批（2026-09-18）：判据多了一个参数 —— **当前主页实际渲染的那一篇**
 * （`lib/homePlan.ts` 的 `homePageSlug()`）。下面这一批用例全部按"主页就是约定那一篇"
 * （`DEFAULT_HOME`，也就是本批之前唯一的形态）运行，行为必须逐条不变；
 * 文末新增的一批钉住"主页换成别的 slug 之后 `#/wiki/home` 不再是别名"。
 */
/** 主页就是约定 slug 那一篇 = 从未设置过主页时的形态（本批之前的唯一形态） */
const DEFAULT_HOME = HOME_SLUG
/** 主页被管理员设成了另一篇（`home` 因此退化成一篇普通文章） */
const OTHER_HOME = 'guide/intro'
test('isWikiHomeAlias：`#/wiki/home/` 尾斜杠也算别名（回归：曾永久空白）', () => {
  assert.equal(isWikiHomeAlias('#/wiki/home/', DEFAULT_HOME), true)
  // 多一条尾斜杠同样归一（`parseWikiRoute` 本来就忽略空段）
  assert.equal(isWikiHomeAlias('#/wiki/home//', DEFAULT_HOME), true)
})

test('isWikiHomeAlias：四种写法都算别名（裸 / 尾斜杠 / ?v= / ?a=）', () => {
  assert.equal(isWikiHomeAlias('#/wiki/home', DEFAULT_HOME), true)
  assert.equal(isWikiHomeAlias('#/wiki/home/', DEFAULT_HOME), true)
  assert.equal(isWikiHomeAlias('#/wiki/home?v=68', DEFAULT_HOME), true)
  assert.equal(isWikiHomeAlias('#/wiki/home?a=usage', DEFAULT_HOME), true)
  // 空查询串（复制的地址常带一个孤零零的 `?`）同样算
  assert.equal(isWikiHomeAlias('#/wiki/home?', DEFAULT_HOME), true)
  // 没有 `#` 前缀的写法也要认（`location.hash` 一定有，但函数不该依赖它）
  assert.equal(isWikiHomeAlias('wiki/home', DEFAULT_HOME), true)
  // 编码过的尾斜杠归一为 `home/`，与上一条同一形态
  assert.equal(isWikiHomeAlias('#/wiki/home%2F', DEFAULT_HOME), true)
})

test('isWikiHomeAlias：规范地址 `#/wiki` **不是**别名（否则会被反复重写）', () => {
  // `#/wiki` 解析为 `{kind:'home'}`，是规范落点；把它当别名会造成自我重写
  assert.equal(isWikiHomeAlias('#/wiki', DEFAULT_HOME), false)
  assert.equal(isWikiHomeAlias('#/wiki/', DEFAULT_HOME), false)
  assert.equal(isWikiHomeAlias('#/', DEFAULT_HOME), false)
  assert.equal(isWikiHomeAlias('', DEFAULT_HOME), false)
})

test('isWikiHomeAlias：只是"名字里带 home"的地址不得被误判（反例）', () => {
  assert.equal(isWikiHomeAlias('#/wiki/home/edit', DEFAULT_HOME), false) // 编辑主页
  assert.equal(isWikiHomeAlias('#/wiki/homework', DEFAULT_HOME), false) // 另一个页面
  assert.equal(isWikiHomeAlias('#/wiki/guide%2Fhome', DEFAULT_HOME), false) // 分层 slug 的第二段
  assert.equal(isWikiHomeAlias('#/wiki/HOME', DEFAULT_HOME), false) // slug 大小写敏感
  assert.equal(isWikiHomeAlias('#/access/home', DEFAULT_HOME), false) // 另一个命名空间
  assert.equal(isWikiHomeAlias('#/wiki/list', DEFAULT_HOME), false)
})

test('isWikiHomeAlias：坏转义不抛错（调用方在 effect 里跑，抛出去就是整页空白）', () => {
  assert.equal(isWikiHomeAlias('#/wiki/%E0%A4%A', DEFAULT_HOME), false)
  assert.equal(isWikiHomeAlias('#/wiki/home%', DEFAULT_HOME), false)
})

/*
 * ══════ 本批（主页批）新增：别名判据是"当前主页"的函数 ══════
 *
 * 主页可被设成任何一篇之后，`#/wiki/home` 的**含义取决于设置**：
 *   · 主页是 `home` 那一篇（含未设置）⇒ 它仍是别名，改写成 `#/wiki`（上面那批用例）；
 *   · 主页是别的 slug ⇒ `home` 只是一篇普通文章，它的地址必须照常打开它。
 * 后者若漏掉，症状是"一篇真实存在的文章打不开"，而它的链接还对外分享着 ——
 * 正是本仓反复记档的那类安静错误。
 */
test('isWikiHomeAlias：主页换成别的 slug 之后，`#/wiki/home` **不再是**别名', () => {
  assert.equal(isWikiHomeAlias('#/wiki/home', OTHER_HOME), false)
  assert.equal(isWikiHomeAlias('#/wiki/home/', OTHER_HOME), false)
  // 历史快照 / 页内锚点两种形态同样不该被劫持：它们指向的是 `home` 这篇文章的某一版
  assert.equal(isWikiHomeAlias('#/wiki/home?v=68', OTHER_HOME), false)
  assert.equal(isWikiHomeAlias('#/wiki/home?a=usage', OTHER_HOME), false)
})

test('isWikiHomeAlias：主页结论还没到时（null）不改写 —— 猜"默认那一篇"会劫持一篇真实文章', () => {
  // `homePageSlug()` 对"加载中/上次失败"与"设置了但读不到"都返回 null。
  // 两种情况都**不能**按约定 slug 猜：前者会把 `home` 文章劫持成主页，
  // 后者等于把无权者静默送去另一篇文章。宁可这次不改写（地址栏停在别名，内容正确）。
  assert.equal(isWikiHomeAlias('#/wiki/home', null), false)
  assert.equal(isWikiHomeAlias('#/wiki/home/', null), false)
})

test('isWikiHomeAlias：显式把主页设成 `home` 那一篇时，别名照旧成立', () => {
  // "设置过"与"没设置过"在这一判据上是同一结果 —— 因为落点确实是同一篇，
  // 别名改写（`#/wiki/home` → `#/wiki`）也就同样成立
  assert.equal(isWikiHomeAlias('#/wiki/home', HOME_SLUG), true)
})
