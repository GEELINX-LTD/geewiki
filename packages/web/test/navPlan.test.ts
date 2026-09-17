/**
 * **导航与命令面板的按能力过滤** —— 纯函数单测 + 源码级守卫。
 * ============================================================================
 *
 * 背景（P2-M5）：顶栏的「管理 ▾」（插件管理 / 依赖图）与命令面板里的同名动作
 * 原先**无条件渲染**，于是未登录访客与普通成员都能看到一个自己点进去必然失败的
 * 运维入口。设计要的形态是"**无权的分区完全不出现**"——不是置灰、不是加锁图标，
 * 因为那两种做法本身就在泄露"这里有个你够不着的地方"。
 *
 * 本文件两段：
 * 1. `visibleDests` 的**运行时**单测（它是纯函数，直接测）；
 * 2. **源码级守卫**：钉住"每个运维入口都声明了能力"与"渲染点已经合并"。
 *    为什么不只用运行时断言：`App.tsx` / `CommandPalette.tsx` 是组件，跑起来要
 *    整套 React + Radix + 路由，而这两个不变量本质上是**声明点**问题 ——
 *    仓库既有先例就是这么做的（`authCacheInvalidation.test.ts`、
 *    `pluginUiPlan.test.ts`、`breadcrumb.test.ts` 的"单一渲染点"守卫）。
 *
 * 守卫如何避免"空洞通过"：每段正则都配一条**反空洞断言**（先证明抽取到了东西、
 * 再断言内容），正则写坏会立刻变红而不是静默通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { visibleDests, pluginNavDests, NAV_CAPABILITIES, type NavDest } from '../src/lib/navPlan'
import { BUILTIN_CAPABILITIES } from '@geewiki/core/domain'
import type { AuthCapabilities } from '../src/api'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const appSource = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8')
const paletteSource = readFileSync(join(SRC_DIR, 'components', 'CommandPalette.tsx'), 'utf8')

/* ============================ 一、纯函数 ============================ */

const ALL_FALSE: AuthCapabilities = {
  editContent: false,
  administer: false,
  manageVisibility: false,
}
const ALL_TRUE: AuthCapabilities = {
  editContent: true,
  administer: true,
  manageVisibility: true,
}

const PUBLIC: NavDest = { id: 'wiki', label: '知识库' }
const ADMIN: NavDest = { id: 'plugins', label: '插件管理', requires: 'administer' }
const EDIT: NavDest = { id: 'new', label: '新建页面', requires: 'editContent' }
const LIST = [PUBLIC, ADMIN, EDIT]

test('visibleDests：无 requires 的项对任何人都可见（含匿名与加载中）', () => {
  for (const caps of [null, ALL_FALSE, ALL_TRUE]) {
    assert.deepEqual(
      visibleDests([PUBLIC], caps).map((d) => d.id),
      ['wiki'],
      `无 requires 的项不该因能力被过滤（caps=${JSON.stringify(caps)}）`,
    )
  }
})

test('visibleDests：能力为 true 才显示', () => {
  assert.deepEqual(visibleDests([ADMIN], ALL_TRUE).map((d) => d.id), ['plugins'])
  assert.deepEqual(visibleDests([ADMIN], ALL_FALSE).map((d) => d.id), [])
})

test('visibleDests：**失败关闭** —— caps 为 null（首帧加载中）时不显示需要能力的项', () => {
  /*
   * 这是本模块最重要的一条判据。加载中若按"显示"处理，管理员菜单会先出现再收回，
   * 那一次闪烁本身就等于告诉匿名访客"这里有个运维入口"。
   * 反过来，管理员多等一次 `/api/auth/state` 是没有代价的。
   */
  assert.deepEqual(visibleDests([ADMIN, EDIT], null).map((d) => d.id), [])
  assert.deepEqual(visibleDests(LIST, null).map((d) => d.id), ['wiki'])
})

test('visibleDests：能力键缺失（服务端改名/漏发）也按不可见处理', () => {
  // 结构上缺字段：这里刻意用不完整的对象模拟"服务端换了一套能力名"
  const partial = { editContent: true } as AuthCapabilities
  assert.deepEqual(visibleDests([ADMIN], partial).map((d) => d.id), [], '缺键必须当作无权')
  assert.deepEqual(visibleDests([EDIT], partial).map((d) => d.id), ['new'], '有键且有值才显示')
})

test('visibleDests：保持入参顺序（导航顺序是产品契约，不在这里重排）', () => {
  assert.deepEqual(
    visibleDests(LIST, ALL_TRUE).map((d) => d.id),
    ['wiki', 'plugins', 'new'],
  )
  assert.deepEqual(visibleDests([...LIST].reverse(), ALL_TRUE).map((d) => d.id), ['new', 'plugins', 'wiki'])
})

test('visibleDests：不修改入参（返回新数组）', () => {
  const input = [PUBLIC, ADMIN]
  visibleDests(input, ALL_FALSE)
  assert.equal(input.length, 2, '过滤不该就地改调用方的数组')
})

test('红-绿：把判据写成 `!== false` 会在 caps 为 null 时误放行（判别力自检）', () => {
  /*
   * 这条不测产品代码，而是**证明上面那条"失败关闭"的断言不是空转**：
   * 手工实现一个"只要不是明确的 false 就放行"的版本，断言它与 `visibleDests` 的
   * 结果**不同**。若哪天有人把实现改成 `!== false` 而测试仍全绿，说明断言写错了。
   */
  const wrong = (dests: readonly NavDest[], caps: AuthCapabilities | null): NavDest[] =>
    dests.filter((d) => d.requires === undefined || caps?.[d.requires] !== false)
  assert.deepEqual(wrong([ADMIN], null).map((d) => d.id), ['plugins'], '错误版本在加载中会放行')
  assert.notDeepEqual(
    visibleDests([ADMIN], null).map((d) => d.id),
    wrong([ADMIN], null).map((d) => d.id),
    '两种实现必须在"加载中"这一情形上可区分，否则失败关闭的断言是空转的',
  )
})

/* ======================= 二、导航的声明点守卫 ======================= */

/** 抽取 `const ADMIN_NAV: NavItem[] = [ ... ]` 的数组体 */
function adminNavBlock(): string {
  const m = /const ADMIN_NAV: NavItem\[\] = \[([\s\S]*?)\n\]/.exec(appSource)
  return m?.[1] ?? ''
}

test('App：确有效果物 —— ADMIN_NAV 数组体能被抽取出来（防正则写坏导致 0===0）', () => {
  const block = adminNavBlock()
  assert.ok(block.length > 40, `应能抽取出 ADMIN_NAV 的数组体（实际 ${block.length} 字符）`)
  // 合并后管理面只剩这一项（原「插件管理」的表格已并入该页）；
  // 它**后来还改了 id**：显示名与路由 id 一起从「依赖图」/`graph` 改为「插件管理」/`plugins`
  assert.ok(block.includes("id: 'plugins'"), 'ADMIN_NAV 里应含插件管理（其唯一入口，id 为 plugins）')
})

test('App：ADMIN_NAV 的**每一项**都必须声明 requires: administer', () => {
  const block = adminNavBlock()
  const ids = block.match(/\bid: '[a-z]+'/g) ?? []
  const requires = block.match(/requires: 'administer'/g) ?? []
  assert.ok(ids.length > 0, '反空洞：至少要抽到一个条目')
  assert.equal(
    requires.length,
    ids.length,
    `每个运维入口都要声明能力，否则它会对所有人显示（条目 ${ids.length} 个，声明 ${requires.length} 个）`,
  )
})

test('App：管理下拉以「有可见项」为渲染条件（不是无条件渲染）', () => {
  assert.match(
    appSource,
    /visibleDests\(ADMIN_NAV/,
    '必须用 visibleDests() 过滤 ADMIN_NAV —— 这是本模块判据的唯一入口',
  )
  assert.match(
    appSource,
    /adminDests\.length > 0 &&/,
    '管理下拉必须以 adminDests.length > 0 为条件：空下拉比不渲染更坏（它在提示存在一个进不去的运维面）',
  )
})

test('App：**重复渲染已合并** —— 不得再出现 ADMIN_NAV.map（那是复制粘贴的复发）', () => {
  /*
   * 原先桌面「管理 ▾」与窄屏「菜单」各自写了一份 `ADMIN_NAV.map(...)` 与
   * 「系统状态」菜单项，两处各自演化正是"桌面看不到、窄屏却看得到"的来源。
   * 这条守卫钉住"只有一处渲染"：有人再把 map 抄回去就会红。
   */
  assert.doesNotMatch(
    appSource,
    /ADMIN_NAV\.map\(/,
    '不得再直接 map ADMIN_NAV：菜单项必须走 NavMenuItems 这一个渲染点',
  )
  const rendered = appSource.match(/<NavMenuItems/g) ?? []
  assert.ok(
    rendered.length >= 2,
    `NavMenuItems 应被桌面与窄屏两处复用（实际 ${rendered.length} 处）`,
  )
})

/* ===================== 三、命令面板的声明点守卫 ===================== */

/** 取某个动作的声明片段（到下一个动作 id 为止） */
function actionBlock(id: string): string {
  const start = paletteSource.indexOf(`id: '${id}'`)
  if (start < 0) return ''
  const rest = paletteSource.slice(start)
  const next = rest.indexOf("id: 'action:", 1)
  return next < 0 ? rest : rest.slice(0, next)
}

test('命令面板：确有效果物 —— 动作片段能被抽取出来（防正则写坏导致 0===0）', () => {
  for (const id of ['action:new', 'action:list', 'action:graph', 'action:theme']) {
    assert.ok(actionBlock(id).length > 20, `应能抽取出 ${id} 的声明（实际 ${actionBlock(id).length} 字符）`)
  }
})

test('命令面板：管理动作必须要求 administer（与顶栏同一判据、同一来源）', () => {
  /*
   * 命令面板是顶栏之外的第二条入口。若只藏顶栏而漏了这里，用户按 ⌘K
   * 仍能搜到并跳进插件管理 —— 那正是"藏了个寂寞"。
   * 合并后管理面只剩这一条（原 `action:plugins` 已并入它），故这里只钉它：
   * 少掉的那个 id 不是放宽了守卫，而是入口真的只剩一个。
   */
  for (const id of ['action:graph']) {
    assert.match(
      actionBlock(id),
      /requires: 'administer'/,
      `${id} 必须声明 requires: 'administer'，否则它会出现在所有人的命令面板里`,
    )
  }
})

test('命令面板：「新建页面」要求 editContent（匿名与 viewer 不该看到写入口）', () => {
  assert.match(
    actionBlock('action:new'),
    /requires: 'editContent'/,
    '未登录时点「新建页面」写一屏、保存才拿到 401，是纯浪费',
  )
})

test('命令面板：公开动作**不得**加能力限制（浏览列表 / 切换外观与身份无关）', () => {
  for (const id of ['action:list', 'action:theme']) {
    assert.doesNotMatch(
      actionBlock(id),
      /requires:/,
      `${id} 是公开动作，加上能力限制会把正常访客挡在外面`,
    )
  }
})

test('命令面板：动作清单确实经过 visibleDests 过滤（而不是声明了 requires 却没人看）', () => {
  assert.match(
    paletteSource,
    /visibleDests\(all, auth\.capabilities\)/,
    '声明了 requires 却不过滤等于没写：必须真的过一遍 visibleDests()',
  )
  assert.match(
    paletteSource,
    /from '\.\.\/lib\/navPlan'/,
    '判据只能来自 lib/navPlan —— 各渲染点自己写一套判断就会分叉',
  )
})

/* ==================== F2：插件声明路由 → 导航项 ==================== */

test('pluginNavDests：缺 label 或 group 的路由不进导航（只可被链接访问）', () => {
  const dests = pluginNavDests([
    { id: 'a', label: '看板', group: 'main' as const },
    { id: 'b', group: 'main' as const }, // 无 label
    { id: 'c', label: '报表' }, // 无 group
    { id: 'd' }, // 两者都无
  ])
  assert.deepEqual(dests.map((d) => d.id), ['a'])
})

test('pluginNavDests：能力键缺省 = 所有人可见；给出则必须是已知能力键', () => {
  const dests = pluginNavDests([
    { id: 'public', label: '公开页', group: 'main' as const },
    { id: 'admin', label: '台面页', group: 'admin' as const, requires: 'administer' },
  ])
  assert.equal(dests[0]!.requires, undefined)
  assert.equal(dests[1]!.requires, 'administer')

  // 缺省（无 requires）⇒ 匿名也可见；要求 administer ⇒ 匿名看不到。判据与内置项同一条。
  const caps = { editContent: false, administer: false, manageVisibility: false } as AuthCapabilities
  assert.deepEqual(visibleDests(dests, caps).map((d) => d.id), ['public'])
  const admin = { editContent: true, administer: true, manageVisibility: true } as AuthCapabilities
  assert.deepEqual(visibleDests(dests, admin).map((d) => d.id), ['public', 'admin'])
})

test('pluginNavDests：**未知**能力键 ⇒ 丢弃并告警，绝不放行（失败关闭）', () => {
  /*
   * ★ 这条是最重要的一条。若把未知能力键当作"无要求"放行，一个把 `administer`
   *   拼成 `adminster` 的插件页面就会**对所有匿名访客可见**。服务端仍会拦（前端隐藏
   *   不是安全措施），但用户会看到一个点进去必然失败的入口——正是 P2-M5 修掉的那个形态。
   */
  const dests = pluginNavDests([
    { id: 'typo', label: '台面页', group: 'admin' as const, requires: 'adminster' },
    { id: 'ok', label: '真台面', group: 'admin' as const, requires: 'administer' },
  ])
  assert.deepEqual(dests.map((d) => d.id), ['ok'], '未知能力键的项必须被丢弃')
})

test('NAV_CAPABILITIES 与 AuthCapabilities 一致（运行期清单不得漂移）', () => {
  // ★ F9：真源已归一到 `@geewiki/core/domain`，这里断言转出的就是 core 的那一份
  // （**同一个对象**，不是"内容相等"——副本无法伪装成同一个数组）
  assert.equal(NAV_CAPABILITIES, BUILTIN_CAPABILITIES)
  assert.deepEqual([...NAV_CAPABILITIES].sort(), ['administer', 'editContent', 'manageVisibility'])
})

test('★ F9：插件命名空间的能力键被接受（此前插件根本没法要求一个新能力）', () => {
  /*
   * F9 之前 `navPlan` 的判据是"必须命中内置三键"，于是插件声明 `review/approve`
   * 时会被当成**非法键丢弃** —— 那个导航项永远不出现。现在它必须被接受，
   * 且取值仍然走同一条 `=== true` 失败关闭判据。
   */
  const dests = pluginNavDests([
    { id: 'review', label: '待审', group: 'main' as const, requires: 'review/approve' },
  ])
  assert.deepEqual(dests.map((d) => d.id), ['review'])
  assert.equal(dests[0]!.requires, 'review/approve')

  // 服务端没发这个键 ⇒ 不显示（失败关闭）；发了 true 才显示
  const without = { editContent: true, administer: true, manageVisibility: true } as AuthCapabilities
  assert.deepEqual(visibleDests(dests, without).map((d) => d.id), [])
  const withCap = { ...without, 'review/approve': true } as AuthCapabilities
  assert.deepEqual(visibleDests(dests, withCap).map((d) => d.id), ['review'])
})

test('★ F9：放宽键空间**没有**牺牲拼写错误的可见性', () => {
  /*
   * 这是 F9 最需要被钉住的一条：`isCapabilityName` 放宽为"内置 ∪ 含 `/` 的插件名"。
   * 若有人图省事把它改成"任意字符串都算合法"，下面第一条就会**静默放行** ——
   * 一次拼写错误于是变成一次越权（前端显示一个点进去必然失败的入口）。
   * 斜杠把两个命名空间切开，正是为了保住这条可见性。
   */
  const dests = pluginNavDests([
    { id: 'typo', label: '台面页', group: 'admin' as const, requires: 'adminster' },
    { id: 'slashless', label: '缺斜杠', group: 'admin' as const, requires: 'reviewapprove' },
    { id: 'ok', label: '真台面', group: 'admin' as const, requires: 'administer' },
    { id: 'custom', label: '自定义', group: 'admin' as const, requires: 'review/approve' },
  ])
  assert.deepEqual(dests.map((d) => d.id), ['ok', 'custom'], '拼错的内置名与缺斜杠的名字都必须被丢弃')
})

test('App.tsx 守卫：插件路由已接入「已知路由」判定与页面分派（不是只声明不接线）', () => {
  assert.match(
    appSource,
    /declaredRoutes\.some\(\(r\) => r\.id === root\)/,
    '插件路由必须参与「已知路由」判定，否则访问它会落 notfound',
  )
  assert.match(
    appSource,
    /registeredRoute\(active\)/,
    '插件路由必须查注册表取组件，否则永远渲染占位',
  )
  assert.match(
    appSource,
    /<PluginRoutePendingPage id=\{active\} \/>/,
    '"已声明未注册"必须有独立占位（不得落 notfound：那会把插件故障误导成地址不存在）',
  )
  // 反空洞：确认抽取到的是真的 App 源码
  assert.ok(appSource.includes('WIKI_ITEM'), '未读到 App.tsx（守卫会空洞通过）')
})
