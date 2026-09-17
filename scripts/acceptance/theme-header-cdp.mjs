#!/usr/bin/env node
/**
 * 顶栏主题跟随的浏览器端到端验收（零依赖：Node 内置 WebSocket + 直连 CDP）。
 *
 * 用法：
 *   node scripts/acceptance/theme-header-cdp.mjs <页面 URL> [cdpPort]
 *
 * 例：
 *   # 隔离实例：GEEWIKI_PORT=3399 GEEWIKI_CONFIG_DIR=… GEEWIKI_DATA_DIR=… pnpm start
 *   node scripts/acceptance/theme-header-cdp.mjs http://127.0.0.1:3399 9460
 *
 * 为什么要单独写这个脚本而不是并进 `pnpm test`：顶栏配色是**只在真浏览器 + 只在浅色主题下**
 * 才看得见的缺陷（`text-white` 压白底不会让构建或单测报任何错）。`pnpm test` 里那条
 * `designSystem.test.ts` 的源码守卫只能证明"没有写死 text-white"，证明不了
 * "浅色主题下顶栏真的是白底深字、且对比度达标"——那需要计算样式与 WCAG 相对亮度。
 *
 * 覆盖：
 *   1. 顶栏底色跟随主题：`light` / `dark` / `system(偏好浅色)` / `system(偏好深色)` 四态；
 *   2. 顶栏前景（品牌字、导航项）与底色的 WCAG 1.4.3 对比度 ≥ 4.5:1（半透明底先合成再算）；
 *   3. 回归：代码块底色**不随主题变白**（它与顶栏曾共用 `--gw-header-*`，解耦后必须仍是深底）。
 *
 * 退出码：全部断言通过 0，否则 1（结果 JSON 与截图同时写到 `tmp/theme-header-cdp/`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const pageUrl = process.argv[2]
const cdpPort = Number(process.argv[3] ?? 9460)
if (!pageUrl) {
  console.error('用法：node scripts/acceptance/theme-header-cdp.mjs <页面 URL> [cdpPort]')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT_DIR = 'tmp/theme-header-cdp'

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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject: rej } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

const failures = []
const results = {}
function check(name, ok, detail) {
  results[name] = { ok, detail }
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

await send('Page.enable')
await send('Runtime.enable')
// 必须先导航到目标源：`about:blank` 的原点是不透明的，读 localStorage 会抛 SecurityError
await send('Page.navigate', { url: pageUrl })
await sleep(2000)

/* ------------------------------ 页面内探针 ------------------------------ */

/**
 * 读顶栏/代码块的**计算样式**，并在页面内算 WCAG 对比度。
 *
 * 两个刻意的写法：
 *  · `parseRgb` 只认 `rgb()/rgba()`（getComputedStyle 的规范输出）；取不到就返回 null 让断言失败，
 *    **不静默当成黑色**——否则"读不到颜色"会伪装成"对比度达标"。
 *  · 半透明前景/底色先**合成到不透明底**再算比值（顶栏的 hover/选中底就是半透明的）。
 */
const PROBE = `(() => {
  const parseRgb = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s)
    if (!m) return null
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number)
    if (p.length < 3 || p.slice(0, 3).some((n) => !Number.isFinite(n))) return null
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))) }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

  const header = document.querySelector('header')
  if (!header) return { error: '页面里没有 <header>' }
  const hs = getComputedStyle(header)
  const bg = parseRgb(hs.backgroundColor)
  if (!bg) return { error: '顶栏底色不是 rgb()/rgba()：' + hs.backgroundColor }
  const out = { themeClass: document.documentElement.className, headerBg: hs.backgroundColor, bg }
  const wordmark = [...header.querySelectorAll('span')].find((s) => s.textContent === 'GeeWiki')
  const nav = header.querySelector('nav button')
  if (wordmark) out.wordmarkRatio = ratio(over(parseRgb(getComputedStyle(wordmark).color), bg), bg)
  if (nav) {
    const ns = getComputedStyle(nav)
    const navBg = parseRgb(ns.backgroundColor)
    const base = navBg && navBg[3] > 0 ? over(navBg, bg) : bg
    out.navRatio = ratio(over(parseRgb(ns.color), base), base)
    out.navText = nav.textContent.trim()
  }
  // 代码块：注入与真实渲染同构的 DOM（styles.css 的规则选择器就是 .md-body pre）
  const old = document.getElementById('gw-probe')
  if (old) old.remove()
  const box = document.createElement('div')
  box.id = 'gw-probe'
  box.className = 'md-body'
  box.innerHTML = '<pre>probe</pre>'
  document.body.appendChild(box)
  const pre = getComputedStyle(box.querySelector('pre'))
  out.codeBg = pre.backgroundColor
  box.remove()
  return out
})()`

async function applyTheme(choice, systemPref) {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: systemPref }],
  })
  // 存储键必须与 `packages/web/src/lib/theme.ts` 的 THEME_STORAGE_KEY 一致
  await evaluate(`localStorage.setItem('geewiki-theme', ${JSON.stringify(choice)})`)
  await send('Page.reload', { ignoreCache: true })
  await sleep(1800)
}

mkdirSync(OUT_DIR, { recursive: true })

/* ------------------------------ 四态断言 ------------------------------ */

const STATES = [
  { label: 'light（显式浅色）', choice: 'light', pref: 'light', light: true },
  { label: 'dark（显式深色）', choice: 'dark', pref: 'light', light: false },
  { label: 'system（系统偏好=浅色）', choice: 'system', pref: 'light', light: true },
  { label: 'system（系统偏好=深色）', choice: 'system', pref: 'dark', light: false },
]

for (const state of STATES) {
  await applyTheme(state.choice, state.pref)
  const probe = await evaluate(PROBE)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const png = `${OUT_DIR}/${state.choice}-${state.pref}.png`
  writeFileSync(png, Buffer.from(shot.data, 'base64'))
  results[state.label] = probe

  const isWhite = probe.bg && probe.bg[0] > 250 && probe.bg[1] > 250 && probe.bg[2] > 250
  const isDark = probe.bg && probe.bg[0] < 40 && probe.bg[2] < 60
  check(
    `${state.label}：顶栏底色${state.light ? '为浅色（白）' : '为深色'}`,
    probe.error ? false : state.light ? isWhite : isDark,
    probe.error ?? `${probe.headerBg}（theme 类="${probe.themeClass || '无'}"，截图 ${png}）`,
  )
  if (probe.error) continue
  check(`${state.label}：品牌字对比度 ≥ 4.5`, probe.wordmarkRatio >= 4.5, `${probe.wordmarkRatio?.toFixed(2)}:1`)
  check(`${state.label}：导航项对比度 ≥ 4.5`, probe.navRatio >= 4.5, `${probe.navRatio?.toFixed(2)}:1（${probe.navText}）`)
  // 代码块在**两种**主题下都必须是深底：顶栏跟随主题后它最容易跟着变白
  check(
    `${state.label}：代码块底色仍为深色`,
    probe.codeBg === 'rgb(15, 26, 40)',
    probe.codeBg,
  )
}

writeFileSync(`${OUT_DIR}/out.json`, JSON.stringify({ results, failures }, null, 2) + '\n')
console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}（明细 ${OUT_DIR}/out.json）`)
ws.close()
process.exit(failures.length === 0 ? 0 : 1)
