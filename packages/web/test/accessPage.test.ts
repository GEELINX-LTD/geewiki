/**
 * **权限治理界面的声明级不变量**（M1-M3）—— 源码级守卫 + 一条 SSR 路由守卫。
 * ============================================================================
 *
 * 为什么用源码级而不是渲染级：`AccessPage` / `PageAccessPanel` 跑起来要整套 React +
 * Radix + 路由 + fetch，而这里要钉的本质上是**声明点**问题（入口挂在哪、门控用哪个字段、
 * 用了哪些设计 token）。仓库既有先例就是这么做的（`navPlan.test.ts`、`opsPage.test.ts`、
 * `authCacheInvalidation.test.ts`）。
 *
 * ## ⚠️ 先剥注释再断言
 *
 * 与 `opsPage.test.ts` 同款：**"解释为什么不能这么写"的注释本身会含那个字面量**。
 * 本文件的负向断言（不得出现 `muted-foreground` 等）若不剥注释，会把自己的说明文字
 * 当成违规命中。
 *
 * ## 最后一条是真渲染
 *
 * "`#/access` 不会被 `known` 漏掉"这件事**只能**由真路由判定来证明：源码里出现
 * `...GOVERN_NAV` 并不等于 `known` 会对 `access` 求值为真（写错变量名、漏加数组都会
 * 让源码守卫绿而用户在浏览器里看到 404 页）。故用 `react-dom/server` 渲染整个 `App`
 * （shim 同 `navGate.test.ts`：hash 路由 + 客户端取数 ⇒ SSR 结果完全可预测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/** 剥掉块注释与行注释（见文件头） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function readSrc(...parts: string[]): { raw: string; code: string } {
  const raw = readFileSync(join(SRC, ...parts), 'utf8')
  return { raw, code: codeOnly(raw) }
}

const accessPage = readSrc('pages', 'AccessPage.tsx')
const panel = readSrc('components', 'access', 'PageAccessPanel.tsx')
const wiki = readSrc('pages', 'WikiPage.tsx')
const app = readSrc('App.tsx')
const palette = readSrc('components', 'CommandPalette.tsx')
const plan = readSrc('lib', 'accessPlan.ts')
const wikiRoute = readSrc('lib', 'wikiRoute.ts')

/* ------------------------------ 反空洞 ------------------------------ */

test('反空洞：剥注释后各文件仍能看到关键声明（防路径写错导致 0===0）', () => {
  assert.ok(accessPage.code.length > 1000, `AccessPage.tsx 读入异常（${accessPage.code.length} 字符）`)
  assert.ok(accessPage.code.includes('export function AccessPage'), '应能看到 AccessPage 定义')
  assert.ok(panel.code.includes('export function PageAccessPanel'), '应能看到 PageAccessPanel 定义')
  assert.ok(wiki.code.length > 5000, `WikiPage.tsx 读入异常（${wiki.code.length} 字符）`)
  assert.ok(app.code.includes('export function App'), '应能看到 App 定义')
  assert.ok(palette.code.includes("id: 'action:theme'"), '应能看到命令面板的动作清单')
})

/* --------------------------- 设计 token --------------------------- */

test('新界面只用已注册 token：不得出现 muted-foreground / border-border', () => {
  /*
   * `text-muted-foreground` / `border-border` 是 shadcn 默认主题的名字，**本仓库没有注册**
   * （见 `src/styles/tokens.css`：本仓用 `text-muted` / `text-ink-soft` / `border-line`）。
   * 写错的症状是"这些类被静默忽略"—— 文字照常显示成继承色、边框直接没有，
   * 在浅色主题下几乎看不出来，深色主题下才变成一片糊。
   *
   * 覆盖范围：本批新增/改动的**治理文件**。全仓（含 `WikiPage.tsx` / `App.tsx` /
   * `CommandPalette.tsx`）另有一条更宽的守卫，见 `designSystem.test.ts` 的
   * 「全仓源码不得使用未注册的 Tailwind token」。这里保留一份更窄的清单**不是冗余**：
   * 治理界面是"说错就是安全事故"的地方，它的守卫不该因为将来有人给全仓扫描加例外名单
   * （例如临时放行某个文件）而一起失效。
   *
   * 历史背景（本批 R10 校订）：本注释原先写着"`OpsPage.tsx` 里还有历史遗留的这两类写法、
   * 不在本批授权范围内"—— 那已经不成立了：`grep -rn "muted-foreground\|border-border"
   * packages/web/src` 现在 **0 命中**，OpsPage 与本清单里的文件都干净。
   */
  const files: Array<[string, string]> = [
    ['pages/AccessPage.tsx', accessPage.code],
    ['components/access/PageAccessPanel.tsx', panel.code],
  ]
  // 其余 access 组件一并纳入（它们与本文件同属一批）
  for (const name of readdirSync(join(SRC, 'components', 'access'))) {
    if (!name.endsWith('.tsx')) continue
    files.push([`components/access/${name}`, codeOnly(readFileSync(join(SRC, 'components', 'access', name), 'utf8'))])
  }
  files.push(['lib/accessPlan.ts', plan.code])

  assert.ok(files.length >= 5, `应至少扫到 5 个治理文件（实际 ${files.length}）`)
  const hits: string[] = []
  for (const [name, src] of files) {
    if (src.includes('muted-foreground')) hits.push(`${name}: text-muted-foreground（应改用 text-muted / text-ink-soft）`)
    if (/[\s"'`]border-border/.test(src)) hits.push(`${name}: border-border（应改用 border-line）`)
  }
  assert.deepEqual(hits, [], `发现未注册 token 的用法：\n  ${hits.join('\n  ')}`)
})

/* ------------------------ 详情页的权限入口（M1） ------------------------ */

test('WikiPage：权限按钮落在 canManageVisibility 门控之内（不是 canEdit，也不是无条件）', () => {
  const gate = 'page.capabilities.canManageVisibility &&'
  const at = wiki.code.indexOf(gate)
  assert.ok(at >= 0, '详情页必须有 `page.capabilities.canManageVisibility &&` 门控')
  assert.equal(wiki.code.indexOf(gate, at + 1), -1, '门控只应出现一次（否则两处判据会分叉）')

  // 取门控之后的一小段作为"被门控的 JSX 片段"：按钮与它的打开动作都必须落在其中
  const block = wiki.code.slice(at, at + 500)
  assert.match(block, /权限…/, '门控内应有「权限…」按钮')
  assert.match(block, /setAccessOpen\(true\)/, '按钮必须真的打开治理面板')
  assert.doesNotMatch(block, /canEdit/, '权限入口不得挂在 canEdit 上（能编辑 ≠ 能改谁能看）')
})

test('WikiPage：弹窗内嵌的是**同一个** PageAccessPanel（不是第二份实现）', () => {
  assert.match(
    wiki.code,
    /<PageAccessPanel slug=/,
    '详情页弹窗必须复用治理台的面板 —— 另写一份必然漂移，而漂移的后果是权限被改错',
  )
  assert.match(wiki.code, /import \{ PageAccessPanel \} from '\.\.\/components\/access\/PageAccessPanel'/)
  // 面板必须随弹窗关闭而卸载（否则会拿旧档位回填）
  assert.match(wiki.code, /\{accessOpen && <PageAccessPanel/, '面板应受 accessOpen 控制挂载')
})

/* ------------------------- 路由与导航（M1） ------------------------- */

test('App：治理入口在独立数组里，且每项都声明 manageVisibility', () => {
  const block = /const GOVERN_NAV: NavItem\[\] = \[([\s\S]*?)\n\]/.exec(app.code)?.[1] ?? ''
  assert.ok(block.length > 30, `应能抽取出 GOVERN_NAV 的数组体（实际 ${block.length} 字符）`)
  const ids = block.match(/\bid: '[a-z]+'/g) ?? []
  const requires = block.match(/requires: 'manageVisibility'/g) ?? []
  assert.ok(ids.length > 0, '反空洞：至少要抽到一个条目')
  assert.equal(requires.length, ids.length, '每个治理入口都要声明能力，否则会对所有人显示')
  assert.match(block, /id: 'access'/, '治理入口的 id 必须是路由首段 access')
})

test('App：GOVERN_NAV **不在** ADMIN_NAV 的数组体里（否则 navPlan 的计数守卫会错位）', () => {
  /*
   * `navPlan.test.ts` 从 App.tsx 抽取 `ADMIN_NAV` 的数组体，并断言
   * "条目数 == requires: 'administer' 的次数"。治理入口要的是**另一个能力**，
   * 一旦被那段正则吞进去，两个计数就都不对了 —— 这条守卫把这件事挡在前面。
   */
  const adminBlock = /const ADMIN_NAV: NavItem\[\] = \[([\s\S]*?)\n\]/.exec(app.code)?.[1] ?? ''
  assert.ok(adminBlock.length > 40, '反空洞：ADMIN_NAV 数组体应能抽出')
  assert.doesNotMatch(adminBlock, /GOVERN_NAV|id: 'access'/, 'GOVERN_NAV 必须声明在 ADMIN_NAV 之外')
})

test('App：known 判定包含 GOVERN_NAV（否则 #/access 会落到「页面不存在」）', () => {
  const at = app.code.indexOf('const known')
  assert.ok(at > 0, '应能找到 known 判定')
  // 取判定表达式所在的整段（它跨两行：`const known =` 换行后才是表达式）
  const known = app.code.slice(at, at + 300).split('\n\n')[0] ?? ''
  assert.ok(
    known.includes('...GOVERN_NAV'),
    `known 判定必须含 ...GOVERN_NAV（实际：${known.trim().slice(0, 160)}）`,
  )
  assert.match(app.code, /active === 'access'\)/, '必须有 access 路由分派')
  assert.match(app.code, /<AccessPage sub=/)
})

test('App：窄屏菜单**不复用** NavMenuItems 渲染治理入口（它会附挂「系统状态」）', () => {
  const start = app.code.indexOf('governDests.length > 0 &&')
  assert.ok(start > 0, '窄屏治理分组应以 governDests.length > 0 为条件')
  const narrow = app.code.slice(start, start + 700)
  assert.match(narrow, /<DropdownMenuItem/, '窄屏应渲染 DropdownMenuItem')
  assert.doesNotMatch(narrow, /<NavMenuItems/, '不得复用 NavMenuItems：它会顺带附挂「系统状态」')
})

test('命令面板：action:access 追加在 action:theme 之后且声明 manageVisibility', () => {
  /** 与 navPlan.test.ts 完全同款的切片（到下一个动作 id 为止） */
  const actionBlock = (id: string): string => {
    const start = palette.code.indexOf(`id: '${id}'`)
    if (start < 0) return ''
    const rest = palette.code.slice(start)
    const next = rest.indexOf("id: 'action:", 1)
    return next < 0 ? rest : rest.slice(0, next)
  }
  const access = actionBlock('action:access')
  assert.ok(access.length > 20, '应能抽取出 action:access 的声明')
  assert.match(access, /requires: 'manageVisibility'/, 'action:access 必须声明能力，否则会出现在所有人的命令面板里')
  assert.match(access, /run: \(\) => go\('access'\)/)

  /*
   * 位置守卫：`action:theme` 那一段里**不得**出现 requires（它是公开动作）。
   * 这条同时证明 action:access 确实是**追加在最后**的 —— 插在中间会让 theme 的
   * 片段吞掉别人的 requires，把 navPlan.test.ts 的公开动作守卫测红。
   */
  assert.doesNotMatch(actionBlock('action:theme'), /requires:/, 'action:theme 的片段不得含 requires')
  assert.ok(
    palette.code.indexOf("id: 'action:access'") > palette.code.indexOf("id: 'action:theme'"),
    'action:access 必须声明在 action:theme 之后',
  )
})

/* --------------------------- 路由解码复用 --------------------------- */

test('治理路由复用 wikiRoute 的解码器（两处各写一份会分叉）', () => {
  assert.match(wikiRoute.code, /export function safeDecodeSegment\(/)
  assert.match(wikiRoute.code, /safeDecodeSegment\(sub\)/, 'parseWikiRoute 内部也应改用同一个解码器')
  assert.match(
    plan.code,
    /import \{ safeDecodeSegment \} from '\.\/wikiRoute'/,
    'accessPlan 必须复用 wikiRoute 的解码器（坏转义的处理只能有一处）',
  )
})

test('审批区：文案注明"待审 / 最多 200 条"，且绝不把列表长度写成总数', () => {
  const req = codeOnly(readFileSync(join(SRC, 'components', 'access', 'RequestsSection.tsx'), 'utf8'))
  assert.match(req, /待审/, '列表只含待审申请，文案必须说明')
  assert.match(req, /200/, '必须注明服务端只回最多 200 条（否则用户以为看到了全部）')
  assert.doesNotMatch(
    req,
    /共\s*(\{)?\s*(rows|requests)\.length/,
    '服务端不回总数 —— 不得把"列表长度"说成"共 N 条"',
  )
  assert.doesNotMatch(req, /共\s*\d+\s*条/, '不得出现任何写死的"共 N 条"')
  // `request_not_pending` 的处置必须是**自动重载列表**（那条申请已被他人裁决 ⇒ 屏幕上的列表过期了）
  assert.match(req, /await load\(\)/, '裁决冲突后必须重新取一次待审列表')
  assert.match(req, /request_not_pending/, '必须识别该冲突码（未知码会走通用错误提示，用户不知道要刷新）')
  // 拒绝要确认，且确认文案说明"仍可再次提交"
  assert.match(req, /拒绝后申请人仍可再次提交申请。确定拒绝？/)
})

test('审批区：无可见性管理权时**整块面板**不渲染（不是显示禁用按钮）', () => {
  const gateAt = panel.code.indexOf('if (!page.capabilities.canManageVisibility)')
  const reqAt = panel.code.indexOf('<RequestsSection')
  assert.ok(gateAt > 0, '必须有 canManageVisibility 的早返回')
  assert.ok(reqAt > gateAt, '审批区必须排在该早返回之后 —— 无权时它根本不该挂载')
  assert.doesNotMatch(
    panel.code.slice(0, gateAt),
    /<RequestsSection|<GrantsSection|<BlocksSection|<VisibilitySection/,
    '早返回之前不得渲染任何治理区块',
  )
})

/* ------------------------------ 无障碍 ------------------------------ */
test('治理台的 slug 表单：Input 必须配 label htmlFor（与 opsPage 同款约定）', () => {
  assert.match(accessPage.code, /htmlFor="access-slug"/)
  assert.match(accessPage.code, /id="access-slug"/)
  // 申请表单的附言与角色单选也要有可访问名称
  const apply = codeOnly(readFileSync(join(SRC, 'components', 'access', 'ApplyAccessDialog.tsx'), 'utf8'))
  assert.match(apply, /htmlFor="apply-message"/)
  assert.match(apply, /id="apply-message"/)
  assert.match(apply, /n\/500|\{message\.length\}\/\{REQUEST_MESSAGE_MAX\}/, '附言要带 n/500 计数')
})

/* ============================ 真渲染：路由 ============================ */

/*
 * shim 必须在 import App **之前**装好（模块加载期会碰 window/document）。
 * 与 `navGate.test.ts` 同一套最小面。
 */
const backing: Record<string, string> = {}
;(globalThis as unknown as { window: unknown }).window = {
  location: { hash: '#/access', pathname: '/', search: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: {
    getItem: (k: string) => backing[k] ?? null,
    setItem: (k: string, v: string) => {
      backing[k] = v
    },
    removeItem: (k: string) => {
      delete backing[k]
    },
  },
}
;(globalThis as unknown as { document: unknown }).document = {
  documentElement: { classList: { add: () => {}, remove: () => {} }, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  activeElement: null,
  title: '',
}

test('SSR：#/access 命中的是治理台，而不是「页面不存在」兜底页', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { App } = await import('../src/App')
  const { __resetAuthStoreForTest } = await import('../src/lib/authStore')

  __resetAuthStoreForTest()
  const html = renderToStaticMarkup(React.createElement(App))

  assert.ok(html.length > 3000, `渲染结果应是一整个外壳（实际 ${html.length} 字符）`)
  // 能力未知（首帧）⇒ 治理台显示"正在确认你的权限…"，这证明**路由命中**了 AccessPage
  assert.ok(
    html.includes('正在确认你的权限'),
    '`#/access` 必须命中 AccessPage（未命中会落到 NotFoundPage —— 说明 known 判定漏了 GOVERN_NAV）',
  )
  assert.ok(!html.includes('这个地址没有对应的页面'), '`#/access` 不得落到 NotFoundPage 兜底文案')
  // 首帧能力未知 ⇒ 顶栏**不显示**治理入口（失败关闭，与运维入口同一策略）
  assert.equal(
    html.split('权限治理').length - 1,
    0,
    '能力未知时治理入口不得出现在导航里（失败关闭：宁可管理员晚一次请求看到入口）',
  )
})

test('SSR（反空洞）：有 manageVisibility 的成员**能看到**治理入口——判据是能力不是"登录了没"', async () => {
  /*
   * 没有这一条，上面那条对"把入口整个删掉"的实现也会通过。
   * 走真实的 `loadAuth()` → api → fetch（只把最外层 fetch 换成桩），
   * 因此同时验证了"服务端下发的 capabilities 真的被这个入口用上了"。
   *
   * 主体刻意选 `member`（`administer: false`）：管理治理入口的判据是 manageVisibility，
   * 而它对 member 也为真 —— 若有人把它误塞进只对 admin 开放的「管理 ▾」，
   * 这条会红（而那正是 M1 要防的"最常用它的人看不到入口"）。
   */
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        setupRequired: false,
        authenticated: true,
        user: {
          id: 2,
          email: 'member@example.com',
          displayName: 'Member',
          orgId: 1,
          orgRole: 'member',
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
        capabilities: { editContent: true, administer: false, manageVisibility: true },
        oidc: { available: false, reason: 'disabled' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { App } = await import('../src/App')
  const { loadAuth, __resetAuthStoreForTest } = await import('../src/lib/authStore')

  __resetAuthStoreForTest()
  await loadAuth({ force: true })
  const html = renderToStaticMarkup(React.createElement(App))

  // 顶栏标签 + 治理台页面标题（`#/access` 的首页标题）都叫「权限治理」⇒ 至少 2 次
  assert.ok(
    html.split('权限治理').length - 1 >= 2,
    '有权主体应同时看到顶栏入口与治理台页面（只出现一次说明其中一处没渲染）',
  )
  assert.equal(
    html.split('管理').length - 1,
    0,
    'member 没有 administer ⇒ 运维入口仍不出现（两个入口的判据互不干扰）',
  )
})
