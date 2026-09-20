/**
 * 验收脚本共用的**管理会话**夹具（零依赖：只用 Node 内置 `fetch`）。
 *
 * ## 为什么需要它
 * 插件启停端点（`POST /api/plugins/<名>/enable|disable`）要求 admin 会话，而验收脚本过去是裸
 * `fetch` 调的 —— 平台加上鉴权之后，那些调用静默变成 401，脚本里"启用后 UI 出现"的断言随之
 * 全部失真（`plugin-ui-cdp.mjs` 因此陈旧了整整一批）。修法照 `p5-nav-admin/run.ts`：
 * 建主体 → 登录 → 之后每个请求都带 `cookie` 与 `x-gw-csrf`。
 *
 * ## 建主体走 public 的 `/api/auth/setup`（不是直接写库）
 * 该端点**自守卫**：只在库里还没有任何可登录账号时成功（判定与写入在同一事务里），
 * 成功即建立会话（201 + `set-cookie`）。于是脚本不必碰数据库，也不需要在进程内 boot 应用。
 *
 * ## 三条鉴权路径（按优先级，覆盖三种实例状态）
 * 1. **`GEEWIKI_ADMIN_TOKEN` 已设置**（服务端启动时给的环境变量）⇒ 用 `x-gw-admin-token` 走
 *    **break-glass 应急通道**。适合"实例已有别人的账号、拿不到密码"的情形；该通道每次使用都留痕，
 *    且**不产生会话 cookie**（故需要浏览器内会话的用例要另行跳过）。
 * 2. **实例无账号**（`/api/auth/state` 的 `setupRequired: true`）⇒ `POST /api/auth/setup` 建首个 owner，
 *    顺带拿到会话 cookie。
 * 3. **已有账号** ⇒ 用固定验收账号登录（`ACCEPTANCE_EMAIL` / `ACCEPTANCE_PASSWORD`）；
 *    登录失败就**明确跳过**需要鉴权的用例（`ok: false` + 可读的 note），绝不静默当作通过。
 *
 * ## CSRF 的硬要求（照 `packages/plugin-auth/src/http.ts` 的 `checkCsrf`）
 * 请求**带会话 cookie** 时，状态变更类请求必须带 `x-gw-csrf: 1`；否则 403 `csrf_rejected`。
 * 浏览器内的 `fetch` 同理 —— 它自动带 cookie，但不带这个自定义头，所以**页面内的调用也要显式加**。
 * （break-glass 走的是显式头令牌，天然免疫 CSRF，但脚本仍统一带上该头，少一条分支。）
 */

/** 与 `packages/plugin-auth` 的 `CSRF_HEADER` 同名（小写：Node 的 `fetch` 会原样发送） */
export const CSRF_HEADER = 'x-gw-csrf'

/** break-glass 应急通道的请求头（`packages/server/src/index.ts` 读它，值来自环境变量） */
export const ADMIN_TOKEN_HEADER = 'x-gw-admin-token'

/** 服务端启动时给的环境变量名（同一个名字，脚本读它来决定走哪条路） */
export const ADMIN_TOKEN_ENV = 'GEEWIKI_ADMIN_TOKEN'

/** 验收专用账号：固定值，便于重复运行（首次 setup 创建，之后直接登录） */
export const ACCEPTANCE_EMAIL = 'acceptance-ui@example.com'
export const ACCEPTANCE_PASSWORD = 'acceptance-ui-password-1'

/**
 * 建立一个"记住 cookie"的调用器。返回的 `call` 会：
 * 1. 自动带上已获得的 `cookie`（若有）与 `x-gw-admin-token`（若走了应急通道）；
 * 2. 对状态变更类请求自动带 `x-gw-csrf: 1`（GET 不必带，带了也无害）；
 * 3. 捕获响应里的 `set-cookie`（登录 / setup 就是靠这一步拿到会话）。
 */
export function createSession(baseUrl, opts = {}) {
  const email = opts.email ?? ACCEPTANCE_EMAIL
  const password = opts.password ?? ACCEPTANCE_PASSWORD
  const adminToken = opts.adminToken ?? process.env[ADMIN_TOKEN_ENV]
  let cookie = ''

  const call = async (method, path, body) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cookie !== '') headers.cookie = cookie
    if (typeof adminToken === 'string' && adminToken.length > 0) headers[ADMIN_TOKEN_HEADER] = adminToken
    headers[CSRF_HEADER] = '1'
    const res = await fetch(new URL(path, baseUrl).href, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) cookie = setCookie.split(';')[0] ?? cookie
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, text, json }
  }

  return {
    email,
    password,
    adminToken,
    call,
    get cookie() {
      return cookie
    },
  }
}

/**
 * 拿到一个可用于管理 API 的会话。
 *
 * 返回 `{ ok, session, mode, note }`：`mode` 是 `'break-glass' | 'session'`。
 * `ok: false` 时调用方**必须**把依赖鉴权的用例显式跳过并打印 note（这是"明确跳过"，不是通过）。
 * 注意 `mode === 'break-glass'` 时**没有会话 cookie** ⇒ 浏览器内的会话仍然是匿名的，
 * 依赖"页面自己已登录"的用例（例如点管理台的启用按钮）必须另行跳过。
 */
export async function ensureAdminSession(baseUrl, opts = {}) {
  const session = createSession(baseUrl, opts)
  const state = await session.call('GET', '/api/auth/state')
  if (state.status !== 200) {
    return { ok: false, session, mode: 'none', note: `/api/auth/state 返回 ${state.status}（实例没起来？）` }
  }
  // ① 应急通道：有令牌就直接用（它旁路权限体系，因此能覆盖"实例已有别人的账号"这种情形）
  if (typeof session.adminToken === 'string' && session.adminToken.length > 0) {
    if (state.json?.authenticated === true) {
      return {
        ok: true,
        session,
        mode: 'break-glass',
        note: `使用 ${ADMIN_TOKEN_ENV} 走 break-glass 应急通道（**无会话 cookie**，浏览器内仍是匿名）`,
      }
    }
    return {
      ok: false,
      session,
      mode: 'break-glass',
      note: `设置了 ${ADMIN_TOKEN_ENV} 但 /api/auth/state 未认出该主体（服务端与脚本用的是同一个值吗？）`,
    }
  }
  // ② 无账号的实例：建首个 owner（顺带拿到会话 cookie）
  if (state.json?.setupRequired === true) {
    const res = await session.call('POST', '/api/auth/setup', {
      email: session.email,
      password: session.password,
      displayName: '验收主体',
    })
    return {
      ok: res.status === 201,
      session,
      mode: 'session',
      note:
        res.status === 201
          ? `本实例此前无账号，已用 /api/auth/setup 建立 owner（${session.email}）`
          : `setup 失败：${res.status} ${res.text.slice(0, 120)}`,
    }
  }
  // ③ 已有账号：用固定验收账号登录
  const res = await session.call('POST', '/api/auth/login', {
    email: session.email,
    password: session.password,
  })
  return {
    ok: res.status === 200,
    session,
    mode: res.status === 200 ? 'session' : 'none',
    note:
      res.status === 200
        ? `已用验收账号登录（${session.email}）`
        : `登录失败：${res.status}。该实例已有其它账号且没有验收账号 —— 需要鉴权的用例将跳过；` +
          `想跑通它们，请在启动实例时设 ${ADMIN_TOKEN_ENV}=<任意值> 并同样导出给本脚本（走 break-glass）。`,
  }
}

/** 把 `set-cookie` 拆成 CDP `Network.setCookie` 需要的 `{ name, value }` */
export function cookiePair(cookie) {
  const eq = cookie.indexOf('=')
  if (eq <= 0) return null
  return { name: cookie.slice(0, eq), value: cookie.slice(eq + 1) }
}

/** 启停一个插件（需要 admin 会话）；返回 HTTP 状态码，便于断言"真的生效了" */
export async function setPluginEnabled(baseUrl, session, pluginName, enabled) {
  const path = `/api/plugins/${encodeURIComponent(pluginName)}/${enabled ? 'enable' : 'disable'}`
  const res = await session.call('POST', path, {})
  return res.status
}
