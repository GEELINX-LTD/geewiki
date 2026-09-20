#!/usr/bin/env node
/**
 * 插件 UI 槽位机制的浏览器端到端验收（零依赖：Node 内置 WebSocket + 直连 CDP）。
 *
 * 用法：
 *   node scripts/acceptance/plugin-ui-cdp.mjs <页面 URL> [cdpPort] [--missing-asset=<文件路径>]
 *
 * 例：
 *   # prod：pnpm build && pnpm start 之后
 *   node scripts/acceptance/plugin-ui-cdp.mjs http://127.0.0.1:3000 9451
 *   # dev：pnpm dev 之后（必须单独跑一遍：Vite 的 ?import 改写只在 dev 出现）
 *   node scripts/acceptance/plugin-ui-cdp.mjs http://localhost:5173 9452
 *
 * 为什么要单独写这个脚本而不是并进 `pnpm test`：它需要 Chrome、一个跑起来的实例、
 * 以及构建好的插件产物，属于集成/验收层。`pnpm test` 只跑无浏览器、无网络的单测。
 *
 * 覆盖：
 *   1. 插槽渲染 + 与宿主共用同一 React 实例（点 +1 三次计数为 3）
 *   2. 入口表把未启用者列为 `skipped(inactive)`；`@geewiki/wiki` **不再**出现在 `loaded()` 里
 *      （它已不声明 `geewiki.client` —— 夹具产物早已搬到 `@geewiki-plugin/ui-demo`，
 *      原先这里断言的"wiki 的界面被加载"随那次搬运一起过时，本脚本因此陈旧了整整一批）
 *   3. 端到端核心：管理台启用 hello → 其 UI 出现；停用 → 插槽条目与 <link> 一起消失
 *   4. 产物缺失降级：把某个 client.js 改名 → 重载 → 页面不白屏、console 无 error、无 404
 *   5. 外部变更自动收敛：页面内直接调 disable（不经管理台）→ 轮询/可见性把 UI 收掉
 *   6. 幂等：连续 sync() 5 次不产生重复注册或重复 <link>
 *   7. console/网络白名单：只容忍 React Flow 授权提示与 Vite HMR 调试日志
 *
 * ## 鉴权（2026-09-21 补）
 * 启停端点（`/api/plugins/<名>/enable|disable`）要求 **admin 会话**，裸 `fetch` 会 401
 * ——脚本曾因此完全跑不动。现在经 `lib/session.mjs` 建主体（public 的 `/api/auth/setup`，
 * 仅在实例无账号时成功）或登录，然后把会话 cookie **注入浏览器**
 * （CDP `Network.setCookie`），页面内的管理 API 调用另需显式带 `x-gw-csrf: 1`
 * （CSRF 闸门见 `packages/plugin-auth/src/http.ts` 的 `checkCsrf`）。
 * 拿不到会话时，依赖鉴权的用例会**明确跳过**（打印 SKIP），绝不静默当作通过。
 *
 * 退出码：全部通过 0，否则 1（结果 JSON 同时写到 `tmp/plugin-ui-cdp.out.json`）。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ADMIN_TOKEN_ENV, cookiePair, ensureAdminSession, setPluginEnabled } from './lib/session.mjs'

const pageUrl = process.argv[2]
const cdpPort = Number(process.argv[3] ?? 9451)
const missingArg = process.argv.find((a) => a.startsWith('--missing-asset='))
const missingAsset = missingArg ? resolve(missingArg.slice('--missing-asset='.length)) : undefined

if (!pageUrl) {
  console.error('用法：node scripts/acceptance/plugin-ui-cdp.mjs <页面 URL> [cdpPort] [--missing-asset=<文件路径>]')
  process.exit(2)
}

const WIKI = '@geewiki/wiki'
const HELLO = '@geewiki-plugin/hello'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 白名单：上游许可证提示与 Vite HMR 调试日志（都不是本机制的缺陷） */
const consoleWhitelist = [
  /proOptions/,
  /React Flow/,
  /\[vite\]/,
  /Download the React DevTools/,
]

const failures = []
const results = {}

function check(name, ok, detail) {
  results[name] = { ok, detail }
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 依赖**实例状态**（鉴权凭据）的用例在拿不到凭据时明确跳过：既不算失败（那不是机制缺陷），
 * 也绝不记成通过（那会把"没验"伪装成"验过了"）。跳过的名单写进结果 JSON。
 */
const skipped = []
function skip(name) {
  skipped.push(name)
  console.log(`skip ${name}`)
}

/* ------------------------------ CDP 连接 ------------------------------ */

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('未找到 page target（Chrome 是否以 --remote-debugging-port 启动？）')
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('WebSocket 连接失败'))
})

let seq = 0
const pending = new Map()
const events = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject: rej } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) rej(new Error(JSON.stringify(msg.error)))
    else res(msg.result)
    return
  }
  switch (msg.method) {
    case 'Runtime.consoleAPICalled':
      if (['error', 'warning'].includes(msg.params.type)) {
        events.push({
          kind: 'console',
          type: msg.params.type,
          text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type ?? '').join(' '),
        })
      }
      break
    case 'Runtime.exceptionThrown':
      events.push({ kind: 'exception', text: msg.params.exceptionDetails?.text ?? 'exception' })
      break
    case 'Log.entryAdded':
      events.push({ kind: 'log', type: msg.params.entry.level, text: msg.params.entry.text })
      break
    case 'Network.responseReceived':
      if (msg.params.response.status >= 400) {
        events.push({ kind: 'http', status: msg.params.response.status, text: msg.params.response.url })
      }
      break
    case 'Network.loadingFailed':
      // 被取消的请求（如导航打断）不算失败
      if (!msg.params.canceled) events.push({ kind: 'netfail', text: msg.params.errorText ?? '' })
      break
    default:
      break
  }
}

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`evaluate 异常：${r.exceptionDetails.text}`)
  return r.result.value
}

/** 真实指针点击（不合成 JS click）：按文本找按钮 → 取中心坐标 → dispatchMouseEvent */
async function clickByText(scopeExpr, text) {
  const rect = await evaluate(`(() => {
    const scope = ${scopeExpr}
    if (!scope) return null
    const el = [...scope.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: el.textContent.trim() }
  })()`)
  if (!rect) return null
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  return rect
}

const state = () =>
  evaluate(`(() => ({
    rootText: (document.getElementById('root')?.innerText ?? '').length,
    headerSlot: !!document.querySelector('[data-slot="app-header"]'),
    headerCount: Number(document.querySelector('[data-slot="app-header"]')?.dataset.count ?? -1),
    footerCount: Number(document.querySelector('[data-slot="app-footer"]')?.dataset.count ?? -1),
    counter: document.querySelector('.gw-fixture-count')?.textContent ?? null,
    labels: [...document.querySelectorAll('.gw-fixture-label')].map((e) => e.textContent),
    loaded: window.__GEEWIKI_PLUGIN_UI__?.loaded?.() ?? [],
    revision: window.__GEEWIKI_PLUGIN_UI__?.revision?.() ?? null,
    links: [...document.querySelectorAll('link[data-plugin-ui]')].map((l) => l.dataset.pluginUi),
  }))()`)

/** 轮询直到条件成立（返回最后一次快照） */
async function waitFor(predicate, timeoutMs = 20000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  let snap = await state()
  while (Date.now() < deadline) {
    if (predicate(snap)) return snap
    await sleep(stepMs)
    snap = await state()
  }
  return snap
}

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')

/*
  鉴权夹具：先拿管理会话，再把会话 cookie **注入浏览器** —— 管理台的「启用/停用」按钮走的是
  页面自己的会话，不是脚本的。注入必须在首次导航之前完成，否则首屏是按"未登录"渲染的。
*/
const auth = await ensureAdminSession(pageUrl)
console.log(auth.ok ? `auth：${auth.note}` : `auth：SKIP —— ${auth.note}`)
/*
  浏览器内的会话只可能来自"登录 / setup 拿到 cookie"这条路径；break-glass 是显式头令牌，
  **没有 cookie** ⇒ 页面仍是匿名的。依赖"页面自己已登录"的用例（第 3 节的按钮路径）据此跳过。
*/
const browserLoggedIn = auth.ok && auth.mode === 'session'
if (browserLoggedIn) {
  const pair = cookiePair(auth.session.cookie)
  if (pair) await send('Network.setCookie', { name: pair.name, value: pair.value, url: pageUrl, httpOnly: true })
} else if (auth.ok) {
  console.log('      ℹ️ break-glass 模式：浏览器内仍是匿名 ⇒ 第 3 节（管理台按钮路径）将跳过。')
} else {
  console.log(`      ℹ️ 拿不到管理凭据 ⇒ 第 3 / 4 / 5 节跳过。解法：在无账号的实例上跑（脚本自行 setup），`)
  console.log(`         或启动实例时设 ${ADMIN_TOKEN_ENV}=<任意值> 并把同一个值导出给本脚本（break-glass）。`)
}

await send('Page.navigate', { url: pageUrl })
await sleep(2800)

/*
  ⚠️ 丢掉**重放的 console 历史**：`Runtime.enable` 会把浏览器缓冲区里已有的 console 消息重放一遍
  （DevTools 重新打开时能看到历史就是这个机制）。那是**上一次运行**留下的东西，与本段验收无关——
  实测踩过：另一个脚本（`ui-extension-cdp.mjs`）触发的两条 `[geewiki-slot]` 告警漏进来，
  把"console 零错误"这条断言弄成了假失败。清空必须发生在首次导航**之后**（导航前的消息全是历史）。
*/
events.length = 0

/* --------------------------- 1) 页面渲染 + 插槽出口存在 --------------------------- */

let snap = await state()
/*
  这里**不再**断言"夹具计数器已出现"：夹具插件（`hello` / `ui-demo`）默认**未启用**，
  而默认启用、且带前端界面的插件在当前配置里没有 —— 首屏就该是"出口在、贡献为 0"。
  React 单例与真实点击的验证搬到插件启用之后（第 5 节），那里才有计数器可点。
*/
check(
  '1. 页面渲染且 app-header 出口存在（贡献为 0 是默认态）',
  snap.rootText > 0 && snap.headerSlot === true && snap.headerCount === 0,
  `rootText=${snap.rootText} headerSlot=${snap.headerSlot} headerCount=${snap.headerCount}`,
)

/* --------------------------- 2) 入口表：未启用者可见，wiki 不再有界面 --------------------------- */

/*
  原先这里是 `loaded() 含 @geewiki/wiki` —— 那条断言随"夹具产物搬到 @geewiki-plugin/ui-demo、
  wiki 不再声明 `geewiki.client`"一起**过时**了（脚本因此陈旧了整整一批）。
  换成两条**当前为真且仍有回归价值**的断言：入口表把未启用者列为 `skipped(inactive)`
  （而不是悄悄消失），以及 wiki **不再**出现在 loaded 里（这正是那次搬运的可回归点）。
*/
const table = await evaluate(`fetch('/api/plugins/ui').then((r) => r.json())`)
const skipReasons = Object.fromEntries((table?.skipped ?? []).map((s) => [s.name, s.reason]))
check(
  '2. 入口表把未启用的插件列为 skipped(inactive)',
  table?.ok === true && skipReasons[HELLO] === 'inactive',
  `skipped=${JSON.stringify(table?.skipped)}`,
)
check(
  '2a. @geewiki/wiki 不再出现在 loaded 里（它已不声明 geewiki.client）',
  !snap.loaded.includes(WIKI),
  `loaded=${JSON.stringify(snap.loaded)}`,
)
check('2b. revision() 非空', typeof snap.revision === 'string' && snap.revision.length > 0, `revision=${snap.revision}`)

/* --------------------------- 3) 端到端：管理台按钮启用/停用（需要浏览器内会话） --------------------------- */

/*
  这一节点的是**管理台自己的按钮**，走页面自己的会话 —— 因此只有 `mode === 'session'`
  （登录或 setup 拿到了会话 cookie 并注入浏览器）时才跑。break-glass 应急通道没有 cookie，
  页面仍是匿名的，点了也只会 401：那种情况下**明确跳过**，而不是把"实例状态"记成机制缺陷。
  （API 驱动的启停由第 5 节覆盖，它不依赖浏览器会话。）
*/
if (browserLoggedIn) {
  await send('Page.navigate', { url: new URL('#/plugins', pageUrl).href })
  await sleep(2500)
  const helloRow = `[...document.querySelectorAll('table tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(HELLO)}))`
  // 行内「启用」打开配置面板，面板内的「启用 <插件名>」才是真正的启用按钮
  await clickByText(helloRow, '启用')
  await sleep(1200)
  const enabled = await clickByText('document', `启用 ${HELLO}`)
  if (enabled) {
    snap = await waitFor((s) => s.labels.includes(HELLO), 20000)
    check('3. 启用后插件 UI 出现在插槽中', snap.labels.includes(HELLO), `labels=${JSON.stringify(snap.labels)}`)
    check('3b. 该插件的 CSS <link> 已注入', snap.links.includes(HELLO), `links=${JSON.stringify(snap.links)}`)

    const countAfterEnable = snap.headerCount
    await clickByText('document', `停用`)
    snap = await waitFor((s) => !s.labels.includes(HELLO), 20000)
    check('3c. 停用后插槽条目消失', !snap.labels.includes(HELLO), `labels=${JSON.stringify(snap.labels)}`)
    check('3d. 停用后 CSS <link> 被移除', !snap.links.includes(HELLO), `links=${JSON.stringify(snap.links)}`)
    check('3e. 停用后插槽计数回落', snap.headerCount < countAfterEnable, `${countAfterEnable} → ${snap.headerCount}`)
  } else {
    check('3. 启用后插件 UI 出现在插槽中', false, '未找到「启用 @geewiki-plugin/hello」按钮（管理台结构变了？）')
  }
} else {
  skip('3. 管理台按钮路径（需要浏览器内会话；当前鉴权模式不支持）')
}

/* --------------------------- 4) 产物缺失降级 --------------------------- */

if (missingAsset && auth.ok) {
  const backup = `${missingAsset}.renamed-for-test`
  let renamed = false
  try {
    // 先把插件恢复成 active，让入口表"想要"它，同时产物不在 → 应归入 skipped: entry_missing
    await setPluginEnabled(pageUrl, auth.session, HELLO, true)
    renameSync(missingAsset, backup)
    renamed = true
    events.length = 0
    await send('Page.navigate', { url: pageUrl })
    await sleep(2800)
    snap = await state()
    const bad = events.filter((e) => !consoleWhitelist.some((re) => re.test(e.text ?? '')))
    check('4. 产物缺失时页面不白屏', snap.rootText > 0, `rootText=${snap.rootText}`)
    check('4b. 产物缺失时不产生 console error / 404', bad.length === 0, `bad=${JSON.stringify(bad)}`)
    check('4c. 产物缺失的插件不被加载', !snap.loaded.includes(HELLO), `loaded=${JSON.stringify(snap.loaded)}`)
  } finally {
    if (renamed) renameSync(backup, missingAsset)
    await setPluginEnabled(pageUrl, auth.session, HELLO, false)
  }
} else {
  console.log(
    missingAsset ? 'skip 4. 需要鉴权才能启用插件（见上面的 auth 说明）' : 'skip 4. 未提供 --missing-asset，跳过产物缺失降级用例',
  )
}

/* --------------------------- 5) 外部变更自动收敛 --------------------------- */

/*
  启停**在脚本侧**发起（不是页面内）——这比页面内发起更贴近这一节要验的东西：
  "变更发生在页面之外（CLI / 另一个标签页 / 看门狗回滚），前端靠轮询与可见性自己收敛"。
  同时它也是鉴权夹具的**端到端证明**：状态码不是 200 就说明会话 / CSRF 没生效。
*/
if (auth.ok) {
  const enableStatus = await setPluginEnabled(pageUrl, auth.session, HELLO, true)
  check(
    '5-pre. 脚本侧 enable 返回 200（鉴权夹具与 x-gw-csrf 都生效）',
    enableStatus === 200,
    `status=${enableStatus}${enableStatus === 401 || enableStatus === 403 ? '（会话/CSRF 未生效）' : ''}`,
  )
  snap = await waitFor((s) => s.labels.includes(HELLO), 25000)
  check('5. 外部启用后 UI 自动出现（轮询/可见性触发点生效）', snap.labels.includes(HELLO), `labels=${JSON.stringify(snap.labels)}`)

  /*
    React 单例 + 真实点击（原先在第 1 节，那时默认启用的夹具插件还存在；现在要等插件启用后才有
    计数器可点）。双 React 实例会直接报 `TypeError: Cannot read properties of null (reading 'useState')`，
    所以"点三次累加到 3"是这条链最直接的证据。
  */
  check('5b. 夹具与宿主共用同一 React 实例（计数器已渲染）', snap.counter !== null, `初始 counter=${snap.counter}`)
  if (snap.counter !== null) {
    const rect = await evaluate(`(() => {
      const el = document.querySelector('.gw-fixture-inc')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (rect) {
      for (let i = 0; i < 3; i++) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        }
        await sleep(150)
      }
    }
    snap = await state()
    check('5c. 计数器随真实点击递增到 3', snap.counter === '3', `counter=${snap.counter}`)
  }

  await setPluginEnabled(pageUrl, auth.session, HELLO, false)
  snap = await waitFor((s) => !s.labels.includes(HELLO), 25000)
  check('5d. 外部停用后 UI 自动消失', !snap.labels.includes(HELLO), `labels=${JSON.stringify(snap.labels)}`)
} else {
  skip('5. 外部变更自动收敛（需要鉴权才能启停插件）')
}

/* --------------------------- 6) 幂等 --------------------------- */

await evaluate(`Promise.all(Array.from({ length: 5 }, () => window.__GEEWIKI_PLUGIN_UI__.sync()))`)
await sleep(600)
const before = await state()
await evaluate(`window.__GEEWIKI_PLUGIN_UI__.sync()`)
await sleep(600)
const after = await state()
check(
  '6. 连续 sync() 幂等（loaded/计数/link 数均不变，无重复注入）',
  after.loaded.length === before.loaded.length &&
    after.headerCount === before.headerCount &&
    after.links.length === after.loaded.length,
  `before=${JSON.stringify({ loaded: before.loaded, headerCount: before.headerCount })} after=${JSON.stringify({ loaded: after.loaded, headerCount: after.headerCount, links: after.links })}`,
)

/* --------------------------- 7) console / 网络白名单 --------------------------- */

const bad = events.filter((e) => !consoleWhitelist.some((re) => re.test(e.text ?? '')))
check('7. 整段验收无 console error / exception / 4xx-5xx / loadingFailed', bad.length === 0, `bad=${JSON.stringify(bad)}`)

/* --------------------------- 收尾 --------------------------- */

// 复位：确保 hello 回到未启用（不污染后续运行）
if (auth.ok) await setPluginEnabled(pageUrl, auth.session, HELLO, false).catch(() => {})

const outFile = resolve('tmp/plugin-ui-cdp.out.json')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify({ pageUrl, auth: { ok: auth.ok, mode: auth.mode, note: auth.note }, skipped, results, failures, events }, null, 2)}\n`)

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}（结果已写入 ${outFile}）`)
ws.close()
process.exit(failures.length === 0 ? 0 : 1)
