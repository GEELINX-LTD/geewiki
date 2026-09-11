/**
 * **运维入口的能力门** —— SSR 集成测试（无浏览器）。
 * ============================================================================
 *
 * 本文件补的是 `navPlan.test.ts` 覆盖不到的那一半：那里的断言全是**纯函数**层面的
 * （"给定 caps 与目的地，该不该显示"），但没有证明**组件真的把这道门装上了**。
 * 一个只在纯函数里正确、渲染时忘了调用的门，等于没有门。
 *
 * 做法：用 `react-dom/server` 把整个 `App` 渲染成静态 HTML，直接对输出断言。
 * 之所以可行：本应用是 **hash 路由 + 客户端取数**，`useEffect` 在 SSR 下不执行，
 * 于是渲染结果完全由**模块 store 的当前快照**决定 —— 正好可以精确控制"我是谁"。
 *
 * ## 两个方向都必须验（否则测试是空转的）
 *
 * - **匿名/加载中 ⇒ 触发器不出现**：这是本任务要修的缺陷方向。
 * - **`administer: true` ⇒ 触发器出现**：这条是**反空洞**的关键。只断言"不出现"
 *   的话，把整个「管理」菜单删掉、或把 `adminDeps` 算成恒空数组，测试照样全绿 ——
 *   而那显然不是我们要的行为。
 *
 * ## 为什么断言 `管理` / `▾` 这两个字面量是安全的
 *
 * Radix 的下拉**内容在未展开时不渲染**，所以「插件管理」「依赖图」这些字面量
 * 无论有没有这道门都不会出现在 SSR 输出里 —— 拿它们当断言点是空转的（实测：
 * 匿名渲染下 `插件管理` 本就是 0 次）。真正随门变化的只有**触发器按钮**，
 * 它的文本就是 `管理`，右侧那个 `▾` 是它独有的记号。
 * 实测对照：匿名 0 次 / 管理员 1 次。
 *
 * ## shim 说明
 *
 * `App` 的模块图在加载期会碰 `window` / `document`（`useRoute` 读 `location.hash`、
 * `theme` 读 localStorage）。这些 shim 只提供 SSR 路径真正会用到的最小面。
 * `node --test` 每个测试文件独立进程，因此模块级 store 的改动不会外溢到别的文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/* ------------------------- 环境 shim（必须在 import App 之前） ------------------------- */

const localStorageBacking: Record<string, string> = {}

;(globalThis as unknown as { window: unknown }).window = {
  location: { hash: '', pathname: '/', search: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: {
    getItem: (k: string) => localStorageBacking[k] ?? null,
    setItem: (k: string, v: string) => {
      localStorageBacking[k] = v
    },
    removeItem: (k: string) => {
      delete localStorageBacking[k]
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

const { renderToStaticMarkup } = await import('react-dom/server')
const React = await import('react')
const { App } = await import('../src/App')
const { loadAuth, __resetAuthStoreForTest } = await import('../src/lib/authStore')

/* ------------------------------------ 工具 ------------------------------------ */

function renderApp(): string {
  return renderToStaticMarkup(React.createElement(App))
}

/** 出现次数（比 `includes` 更有信息量：能区分"没有"与"有两个"） */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** 这个主体在顶栏能看到「管理」入口吗（看的是**触发器**，不是下拉内容） */
function adminTriggerCount(html: string): number {
  return count(html, '管理')
}

/**
 * 把 `/api/auth/state` 的回答换成指定主体。
 * `loadAuth()` 是导出的，它会走真实的 `api.authState()` → `fetch`，
 * 所以这里替换的是**最外层**的 fetch，而不是绕过 api 层做桩。
 */
function stubAuthState(user: unknown, capabilities: Record<string, boolean>): void {
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        setupRequired: false,
        authenticated: user !== null,
        user,
        capabilities,
        oidc: { available: false, reason: 'disabled' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

const OWNER = {
  id: 1,
  email: 'owner@example.com',
  displayName: 'Owner',
  orgId: 1,
  orgRole: 'owner',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: null,
}

/* ----------------------------------- 用例 ----------------------------------- */

test('SSR 基线：导航确实渲染出来了（防"渲染失败但断言碰巧通过"）', () => {
  __resetAuthStoreForTest()
  const html = renderApp()
  assert.ok(html.length > 3000, `渲染结果应是一整个外壳（实际 ${html.length} 字符）`)
  assert.match(html, /aria-label="主导航"/, '主导航容器必须存在，否则下面的"没有管理入口"是空转的')
  assert.ok(count(html, '知识库') > 0, '公开入口「知识库」必须在，证明导航渲染到了')
})

test('匿名/加载中：顶栏**不出现**运维入口触发器', () => {
  /*
   * 加载中（capabilities === null）与匿名（capabilities 全 false）在本应用里
   * 都走"不显示"这一支 —— 见 lib/navPlan.ts 的失败关闭说明。
   * 这条正是修复前会红的用例：那时「管理 ▾」无条件渲染。
   */
  __resetAuthStoreForTest()
  const html = renderApp()
  assert.equal(
    adminTriggerCount(html),
    0,
    '无权主体不该看到「管理」触发器：置灰或空下拉同样在泄露"这里有个进不去的运维面"',
  )
  assert.equal(count(html, '▾'), 0, '触发器右侧的记号也不该出现')
  assert.equal(count(html, '运维台面'), 0)
  assert.equal(count(html, '系统状态'), 0)
})

test('管理员（administer: true）：运维入口触发器**必须回来**（反空洞）', async () => {
  /*
   * 没有这条，上面那条测试对"把菜单整个删掉"的实现也会通过。
   * 走真实的 loadAuth() → api → fetch（只把 fetch 换成桩），因此这条同时验证了
   * "服务端下发的 capabilities 真的被前端用上了"这整条链路。
   */
  __resetAuthStoreForTest()
  stubAuthState(OWNER, { editContent: true, administer: true, manageVisibility: true })
  await loadAuth({ force: true })
  const html = renderApp()
  assert.equal(adminTriggerCount(html), 1, 'owner 应看到恰好一个「管理」触发器')
  assert.equal(count(html, '▾'), 1)
  assert.ok(count(html, 'Owner') > 0, '身份区应显示当前身份，证明 store 真的被喂进去了')
})

test('已登录但无 administer（member）：运维入口仍然不出现（判据是能力，不是"登录了没"）', async () => {
  /*
   * 这条防的是另一种退化：把判据写成"已登录就给看"。
   * member 的 capabilities 是 `administer: false`（见
   * packages/plugin-auth/src/index.ts:456-462 的角色映射）。
   */
  __resetAuthStoreForTest()
  stubAuthState(
    { ...OWNER, orgRole: 'member', displayName: 'Member' },
    { editContent: true, administer: false, manageVisibility: true },
  )
  await loadAuth({ force: true })
  const html = renderApp()
  assert.equal(adminTriggerCount(html), 0, 'member 没有 administer，不该看到运维入口')
  assert.ok(count(html, 'Member') > 0, '但他仍是已登录状态（身份区显示自己）——证明不是"整块没渲染"')
})
