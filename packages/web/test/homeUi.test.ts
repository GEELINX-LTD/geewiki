/**
 * 「设为主页」的界面不变量（主页批，2026-09-18）——源码级守卫。
 *
 * 与 `navListUi.test.ts` 同一条理由：下面每一条都是"改起来很容易顺手破坏、跑起来又不报错"的
 * 类型。行为本身由纯函数单测（`homePlan.test.ts`、`wikiRoute.test.ts`、
 * `dockPlan.test.ts`、`commandPlan.test.ts`）与服务端测试覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const wikiPage = readFileSync(join(SRC, 'pages', 'WikiPage.tsx'), 'utf8')

/** `WikiList` 的源码段（去掉注释后比对，避免命中"解释这条规则"的注释本身） */
function listCode(): string {
  const start = wikiPage.indexOf('function WikiList(')
  const end = wikiPage.indexOf('function ', start + 10)
  return wikiPage.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, '')
}

test('「主页」徽标挂在**当前主页**那一行，判据来自共享换算（不是写死的 slug）', () => {
  const code = listCode()
  assert.match(code, /const home = useHome\(\)/, '列表要订阅站点主页设置（与 #/wiki 的落点同源）')
  assert.match(code, /const homeSlug = homePageSlug\(home\.home\)/, '换算必须走 lib/homePlan（唯一出口）')
  assert.match(code, /page\.slug === homeSlug/, '"哪一行是主页"必须与 homeSlug 比对')
  // 反例：写死约定 slug 会在管理员换过主页之后，给一篇已经不是主页的文章挂上徽标
  assert.ok(!/page\.slug === HOME_SLUG/.test(code), '不得用编译期常量判"这一行是主页"')
})

test('「设为主页 / 恢复默认」只对**站点管理员**渲染，且提交到 /api/site/home', () => {
  const code = listCode()
  assert.match(code, /auth\.capabilities\?\.administer === true/, '门控读的是 administer 能力（与后端 access:admin 同级）')
  // 每一个主页动作按钮都必须在 canAdminister 之后出现
  const gates = code.split('canAdminister &&')
  assert.ok(gates.length >= 4, `主页动作按钮应不少于两处（找到 ${gates.length - 1} 处 canAdminister 闸门）`)
  assert.match(code, /setHomePage\(page\.slug\)/, '"设为主页"提交的是这一行的 slug')
  assert.match(code, /setHomePage\(null\)/, '必须另有"恢复默认"通道（清除设置 → 回落约定 slug）')
  // 真正的写口只有一个：两个按钮都走 `setHomePage`，它内部提交到 `/api/site/home`
  assert.match(wikiPage, /await api\.setSiteHome\(slug\)/, '写口必须是 api.setSiteHome（POST /api/site/home）')
  assert.match(wikiPage, /await invalidateHome\(\)/, '写完之后必须让主页缓存失效，否则徽标与 #/wiki 的落点停在旧值')
})

test('主页动作的失败**必须可见**（不能挂到没人渲染的提示位上）', () => {
  const code = listCode()
  assert.match(code, /const \[homeNotice, setHomeNotice\]/, '主页动作要有自己的反馈位')
  assert.match(code, /setHomeNotice\(\{ kind: 'error'/, '失败要写成 error 提示')
  assert.match(wikiPage, /role=\{homeNotice\.kind === 'error' \? 'alert' : 'status'\}/, '反馈位必须真的渲染出来（带 alert/status 角色）')
})

test('`#/wiki` 渲染的是**设置的那一篇**，且别名地址不再走"先返回 null"的空白路径', () => {
  // 渲染的是 homeSlug（服务端设置），不是常量 HOME_SLUG
  assert.match(wikiPage, /key=\{homeSlug\}/, '主页正文要以实际 slug 为 key（换主页时必须重挂载）')
  assert.match(wikiPage, /slug=\{homeSlug\}/, '主页正文渲染的是设置的那一篇')
  // 别名地址也走主页分支渲染同一个 WikiDetail，而不是 return null 等 URL 被改写：
  // 后者在 homeSlug 异步到达前后会翻面，翻面那一刻就是一次白屏（2026-09-14 那个缺陷的同族）
  assert.match(wikiPage, /const homeRoute = route\.kind === 'home' \|\| homeAliasRoute/, '别名地址与规范地址共用一条渲染分支')
  assert.match(wikiPage, /if \(homeRoute\) \{/, '主页分支的判据是 homeRoute')
  assert.ok(!/if \(normalizeHome\) return null/.test(wikiPage), '不得再有"判据翻面时返回 null"的空白路径')
})

test('别名改写带上"当前主页"这一入参（主页换掉后 `#/wiki/home` 不再是别名）', () => {
  assert.match(
    wikiPage,
    /if \(!isWikiHomeAlias\(hash, homeSlug\)\) return/,
    '改写前必须用同一判据复核当前 URL **且**当前主页 —— 否则会把一篇真实文章劫持成主页',
  )
  assert.match(wikiPage, /\}, \[homeSlug\]\)/, 'homeSlug 是异步得到的，必须进依赖数组（否则错过唯一一次改写机会）')
})

test('主页设置只有一处真源：消费点都走 homeStore + homePlan', () => {
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
  const dock = readFileSync(join(SRC, 'components', 'AppDock.tsx'), 'utf8')
  assert.match(app, /visitedSlugFromSub\(wikiSub, homeSlug\)/, 'App 的"最近访问"要用设置的主页 slug')
  assert.match(app, /const homeSlug = homePageSlug\(home\.home\)/, 'App 也要走同一换算')
  assert.match(dock, /pageContextOf\(props\.route, homePageSlug\(home\.home\)\)/, 'dock 的"当前页"要用设置的主页 slug')
  // 反例：谁自己 `api.siteHome()`，谁就会与这份缓存分叉（两处各拿一份、可能不一致）
  assert.ok(!/api\.siteHome\(\)/.test(app + dock), '消费点只读共享缓存，不各自发请求')
})
