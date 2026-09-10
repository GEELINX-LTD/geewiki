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
 * 覆盖（对应批次验收清单 L3）：
 *   1. 插槽渲染 + 与宿主共用同一 React 实例（点 +1 三次计数为 3）
 *   2. `loaded()` 含 @geewiki/wiki
 *   3. 端到端核心：管理台启用 hello → 其 UI 出现；停用 → 插槽条目与 <link> 一起消失
 *   4. 产物缺失降级：把某个 client.js 改名 → 重载 → 页面不白屏、console 无 error、无 404
 *   5. 外部变更自动收敛：页面内直接调 disable（不经管理台）→ 轮询/可见性把 UI 收掉
 *   6. 幂等：连续 sync() 5 次不产生重复注册或重复 <link>
 *   7. console/网络白名单：只容忍 React Flow 授权提示与 Vite HMR 调试日志
 *
 * 退出码：全部通过 0，否则 1（结果 JSON 同时写到 `tmp/plugin-ui-cdp.out.json`）。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
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
await send('Page.navigate', { url: pageUrl })
await sleep(2800)

/* --------------------------- 1) 插槽渲染 + React 单例 --------------------------- */

let snap = await state()
check('1. 页面渲染且插槽存在', snap.rootText > 0 && snap.headerCount >= 1, `rootText=${snap.rootText} headerCount=${snap.headerCount}`)
check('1b. 夹具与宿主共用同一 React 实例（点 +1 三次 → 3）', snap.counter !== null, `初始 counter=${snap.counter}`)
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
  check('1c. 计数器随真实点击递增到 3', snap.counter === '3', `counter=${snap.counter}（双 React 实例会直接报 useState 为 null）`)
}

/* --------------------------- 2) loaded() 含 wiki --------------------------- */

check('2. loaded() 含 @geewiki/wiki', snap.loaded.includes(WIKI), `loaded=${JSON.stringify(snap.loaded)}`)
check('2b. revision() 非空', typeof snap.revision === 'string' && snap.revision.length > 0, `revision=${snap.revision}`)

/* --------------------------- 3) 端到端：管理台启用/停用 --------------------------- */

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

/* --------------------------- 4) 产物缺失降级 --------------------------- */

if (missingAsset) {
  const backup = `${missingAsset}.renamed-for-test`
  let renamed = false
  try {
    // 先把插件恢复成 active，让入口表"想要"它，同时产物不在 → 应归入 skipped: entry_missing
    await evaluate(`fetch('/api/plugins/${encodeURIComponent(HELLO)}/enable', { method: 'POST' }).then((r) => r.status)`)
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
    await evaluate(`fetch('/api/plugins/${encodeURIComponent(HELLO)}/disable', { method: 'POST' }).then((r) => r.status)`)
  }
} else {
  console.log('skip 4. 未提供 --missing-asset，跳过产物缺失降级用例')
}

/* --------------------------- 5) 外部变更自动收敛 --------------------------- */

// 不经管理台直接 enable（模拟 CLI / 其它标签页 / 看门狗回滚后的状态）
await evaluate(`fetch('/api/plugins/${encodeURIComponent(HELLO)}/enable', { method: 'POST' }).then((r) => r.status)`)
snap = await waitFor((s) => s.labels.includes(HELLO), 25000)
check('5. 外部启用后 UI 自动出现（轮询/可见性触发点生效）', snap.labels.includes(HELLO), `labels=${JSON.stringify(snap.labels)}`)

await evaluate(`fetch('/api/plugins/${encodeURIComponent(HELLO)}/disable', { method: 'POST' }).then((r) => r.status)`)
snap = await waitFor((s) => !s.labels.includes(HELLO), 25000)
check('5b. 外部停用后 UI 自动消失', !snap.labels.includes(HELLO), `labels=${JSON.stringify(snap.labels)}`)

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
await evaluate(`fetch('/api/plugins/${encodeURIComponent(HELLO)}/disable', { method: 'POST' }).then((r) => r.status)`).catch(() => {})

const outFile = resolve('tmp/plugin-ui-cdp.out.json')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify({ pageUrl, results, failures, events }, null, 2)}\n`)

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}（结果已写入 ${outFile}）`)
ws.close()
process.exit(failures.length === 0 ? 0 : 1)
