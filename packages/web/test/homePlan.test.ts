/**
 * 站点主页的三态 → "渲染哪一篇"（主页批，2026-09-18）。
 *
 * ## 为什么这一个换算值得单独一批测试
 * `#/wiki` 渲染哪一篇、`#/wiki/home` 还算不算别名、列表里哪一行挂「主页」徽标、
 * AI 对话说"当前页是哪个 slug"、`#/wiki` 记进"最近访问"的是哪一篇 —— 五处消费同一份设置。
 * 只要有一处自己拼一遍，界面就会出现"侧栏高亮 A、正文是 B"这种自相矛盾，而且**不报错**。
 * 所以换算收在 `lib/homePlan.ts` 一处，并用这里的用例把三态的每一种取值钉死。
 *
 * ## 最要紧的两条
 * ① `null`（结论还没到）与 `unset`（从来没人设置过）**绝不能合流**：
 *    前者按约定 slug 渲染会在设置其实是另一篇时先显示一篇错的；后者必须回落约定 slug，
 *    否则升级上来的老站点主页会变成 404。
 * ② `hidden`（设置了但当前主体读不到）**既不能**渲染设置的那一篇（读不到），
 *    **也不能**回落约定 slug —— 那等于把无权者静默送去另一篇文章，而他以为那就是本站主页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasExplicitHome, homePageSlug, isHomeAliasNow } from '../src/lib/homePlan'
import { HOME_SLUG } from '../src/lib/wikiRoute'
import type { SiteHome } from '../src/api'

const UNSET: SiteHome = { ok: true, state: 'unset' }
const HIDDEN: SiteHome = { ok: true, state: 'hidden' }
const visible = (slug: string): SiteHome => ({ ok: true, state: 'visible', slug })

test('homePageSlug：未设置 ⇒ 回落约定 slug（升级上来的老站点行为必须逐字节不变）', () => {
  assert.equal(homePageSlug(UNSET), HOME_SLUG)
})

test('homePageSlug：设置了且读得到 ⇒ 就是那一篇（可以是分层 slug）', () => {
  assert.equal(homePageSlug(visible('guide/intro')), 'guide/intro')
  // 显式设成约定那一篇也是合法的（落点相同，但对别名判据有区别，见下一条用例）
  assert.equal(homePageSlug(visible(HOME_SLUG)), HOME_SLUG)
})

test('homePageSlug：结论还没到（null）⇒ null，**不是**约定 slug', () => {
  // 这一条防的是"闪一下换了东西"：设置其实是另一篇时，先按 `home` 渲染就是先显示一篇错的
  assert.equal(homePageSlug(null), null)
})

test('homePageSlug：设置了但读不到（hidden）⇒ null，同样**不是**约定 slug', () => {
  /*
   * 两种错法都在这里被挡住：
   *   · 渲染设置的那一篇 —— 读不到（服务端为此连 slug 都不下发）；
   *   · 回落约定 slug —— 把无权者送去另一篇文章，他会以为那就是本站主页
   *     （真实情况常常正是"主页设成了组织内页，而他是匿名访客"）。
   */
  assert.equal(homePageSlug(HIDDEN), null)
})

test('isHomeAliasNow：只有主页恰好是约定 slug 时，`#/wiki/home` 才是别名', () => {
  // 未设置 = 主页就是 `home` ⇒ 别名改写照旧（本批之前的唯一形态）
  assert.equal(isHomeAliasNow(UNSET), true)
  assert.equal(isHomeAliasNow(visible(HOME_SLUG)), true)
  // 主页换成别的 slug ⇒ `home` 退化成普通文章，它的地址必须照常能打开
  assert.equal(isHomeAliasNow(visible('guide/intro')), false)
  // 结论未到 / 读不到：一律不改写（猜"默认那一篇"会把一篇真实的 `home` 文章劫持成主页）
  assert.equal(isHomeAliasNow(null), false)
  assert.equal(isHomeAliasNow(HIDDEN), false)
})

test('hasExplicitHome：只有"确实设置过"才为真（决定要不要给「恢复默认」入口）', () => {
  assert.equal(hasExplicitHome(UNSET), false, '从未设置过：主页本来就落在约定 slug 上，"恢复默认"是个什么都不做的按钮')
  assert.equal(hasExplicitHome(null), false, '结论还没到：不能给一个可能取消掉"其实不存在"的设置的按钮')
  assert.equal(hasExplicitHome(visible('guide/intro')), true)
  assert.equal(hasExplicitHome(HIDDEN), true, 'hidden 态下这条入口是唯一的自救路径（列表里没有哪一行挂得上徽标）')
})
