#!/usr/bin/env node
/**
 * **界面扩展平台（P4–P10）的浏览器端到端验收** —— 零依赖：Node 内置 WebSocket + 直连 CDP。
 *
 * 用法：
 *   node scripts/acceptance/ui-extension-cdp.mjs <页面 URL> [cdpPort]
 *
 * 例：
 *   # prod：pnpm build && pnpm start 之后
 *   node scripts/acceptance/ui-extension-cdp.mjs http://127.0.0.1:3000 9461
 *   # dev：pnpm dev 之后（Vite 的 ?import 改写只在 dev 出现，故两处都要跑）
 *   node scripts/acceptance/ui-extension-cdp.mjs http://localhost:5173 9462
 *
 * 为什么单独写：它需要 Chrome、一个跑起来的实例与已构建的前端产物，属于验收层；
 * `pnpm test` 只跑无浏览器、无网络的单测（设计文档 §10 的纪律：涉及 UI 的批次必须有
 * 浏览器端到端验收，且 console 零错误、无失败请求）。
 *
 * ## 它验的是"只有真实浏览器才能回答"的那几条
 * 单测能钉住注册表、裁决、SSR 渲染与源码接线；**不能**回答下面这些：
 *   1. `replace` 真的换掉了宿主元素、卸载后**逐字**还原（P5/P6/P7）；
 *   2. `wrap` 的 `props.default` 在真实 DOM 里确实渲染出宿主默认元素（P4）；
 *   3. `ui-button` 在**定义处**接线 ⇒ 一次 replace 全站按钮同时改变（P7 的关键杠杆）；
 *   4. `shadow: true` 真的建了 Shadow Root、`--gw-*` **跨边界继承**、宿主 Tailwind
 *      类名**进不去**、隔离壳 `display: contents` **不参与布局**（P9）；
 *   5. 主题覆盖 `--gw-*` 后 Tailwind 工具类**跟着变**（P0 的核心断言：
 *      `@theme inline` + `var()` 让令牌穿透到工具类）；
 *   6. 全程 console 无 error、无失败请求（插件机制不能靠"忍一忍"上线）。
 *
 * 退出码：全部通过 0，否则 1（结果 JSON 同时写到 `tmp/ui-extension-cdp.out.json`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ensureAdminSession, setPluginEnabled } from './lib/session.mjs'

const pageUrl = process.argv[2]
const cdpPort = Number(process.argv[3] ?? 9461)

if (!pageUrl) {
  console.error('用法：node scripts/acceptance/ui-extension-cdp.mjs <页面 URL> [cdpPort]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 白名单：上游许可证提示、Vite HMR 调试日志、React DevTools 提示（都不是本机制的缺陷） */
/*
  P11c 场景**故意**触发两条宿主诊断（"容器节点 + shadow" 与 "shadow 内的挂载点被忽略"）；
  P13 场景也**故意**触发一条（"portal 节点不允许 wrap"）——那条告警本身就是断言对象
  （"wrap 被真的拦下"与"它告警了"是同一件事的两面）。
  它们都是正确用法提示，不是缺陷。故按**精确文案**放行——写成"放行所有 warning"会把真实告警一起吞掉。
*/
const consoleWhitelist = [
  /proOptions/,
  /React Flow/,
  /\[vite\]/,
  /Download the React DevTools/,
  /容器节点（内层出口：app-header）/,
  /内层插槽出口 "app-header" 的挂载点落在 Shadow Root 内/,
  /节点 "ui-tooltip" 不允许 wrap 模式/,
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

/* ------------------------------ 场景开始 ------------------------------ */

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')
await send('Page.navigate', { url: pageUrl })
await sleep(1200)

/*
  ⚠️ 丢掉 `Runtime.enable` **重放的历史 console 消息**（浏览器缓冲区里的旧消息，DevTools 重开时
  能看到历史就是这个机制）。那是**上一次运行**留下的，与本段验收无关；不清掉会让"console 零错误"
  在"上一次跑过另一个脚本"时变成假失败（`plugin-ui-cdp.mjs` 上实测踩过）。
*/
events.length = 0

/** 注册一个扩展贡献，返回可用于卸载的 window 上的 key（**每次都保证能卸载**，避免污染后续场景） */
async function withExtension(node, bodyExpr, optsExpr = '{}') {
  const token = `__acc_${node.replace(/[^a-z0-9]/gi, '_')}_${Math.random().toString(36).slice(2, 7)}`
  await evaluate(`(() => {
    const host = window.__GEEWIKI_HOST__
    if (!host) throw new Error('window.__GEEWIKI_HOST__ 未初始化')
    const React = host.React
    const component = ${bodyExpr}
    window['${token}'] = host.registerExtension('${node}', component, ${optsExpr})
    return true
  })()`)
  await sleep(250)
  return token
}

async function unregister(token) {
  await evaluate(`(() => { const off = window['${token}']; if (typeof off === 'function') off(); delete window['${token}']; return true })()`)
  await sleep(200)
}

/* ① P5/P8：replace 品牌字样 → 换掉；卸载 → 逐字还原 */
{
  const before = await evaluate(`document.querySelector('header .text-wordmark')?.textContent ?? null`)
  const token = await withExtension(
    'shell-brand-text',
    `(p) => React.createElement('span', { className: 'text-wordmark', 'data-acc-brand': '1' }, 'MyWiki')`,
    `{ mode: 'replace' }`,
  )
  const replaced = await evaluate(`document.querySelector('header [data-acc-brand]')?.textContent ?? null`)
  check('P5 replace shell-brand-text 生效', replaced === 'MyWiki', `实际 ${JSON.stringify(replaced)}`)

  await unregister(token)
  const restored = await evaluate(`document.querySelector('header .text-wordmark')?.textContent ?? null`)
  check(
    'P5 卸载后品牌字样逐字还原',
    restored === before && restored !== 'MyWiki',
    `before=${JSON.stringify(before)} after=${JSON.stringify(restored)}`,
  )
}

/* ② P4：wrap 的 props.default 真的渲染出宿主默认元素 */
{
  const token = await withExtension(
    'shell-brand-text',
    `(p) => React.createElement('span', { 'data-acc-wrap': '1' }, p.default)`,
    `{ mode: 'wrap' }`,
  )
  const wrapped = await evaluate(`(() => {
    const el = document.querySelector('[data-acc-wrap]')
    if (!el) return null
    return { hasDefault: !!el.querySelector('.text-wordmark'), text: el.textContent }
  })()`)
  check(
    'P4 wrap 的 default 里是宿主默认实现',
    wrapped !== null && wrapped.hasDefault === true,
    JSON.stringify(wrapped),
  )
  await unregister(token)
}

/* ③ P7：ui-button 在定义处接线 ⇒ 一次 replace 全站按钮同时改变 */
{
  const before = await evaluate(`document.querySelectorAll('button').length`)
  const token = await withExtension(
    'ui-button',
    `(p) => React.createElement('button', { 'data-acc-btn': '1', type: 'button' }, 'ACC')`,
    `{ mode: 'replace' }`,
  )
  const after = await evaluate(`document.querySelectorAll('[data-acc-btn]').length`)
  check(
    'P7 replace ui-button 全站生效（定义处接线）',
    after >= 2 && before >= after,
    `宿主 button ${before} 个，被替换 ${after} 个`,
  )
  await unregister(token)
  const gone = await evaluate(`document.querySelectorAll('[data-acc-btn]').length`)
  check('P7 卸载后按钮还原', gone === 0, `残留 ${gone} 个`)
}

/* ④ P6：页面内元素节点 extend 追加（文章页操作条） */
{
  const token = await withExtension(
    'wiki-actions',
    `(p) => React.createElement('span', { 'data-acc-meta': '1' }, '阅读时长 3 分钟')`,
    `{ mode: 'extend' }`,
  )
  const appended = await evaluate(`(() => {
    const el = document.querySelector('[data-acc-meta]')
    if (!el) return null
    return { text: el.textContent, inActions: !!el.closest('.gw-reader-actions') }
  })()`)
  check(
    'P6 extend wiki-actions 追加进文章操作条',
    appended !== null && appended.inActions === true,
    JSON.stringify(appended),
  )
  await unregister(token)
}

/* ⑤ P9：shadow: true —— 真的建了 Shadow Root，令牌穿透、宿主类名进不去、壳不参与布局 */
{
  const token = await withExtension(
    'shell-brand-text',
    `(p) => React.createElement(React.Fragment, null,
      React.createElement('span', { style: { color: 'var(--gw-accent)' }, 'data-acc-shadow-in': '1' }, 'SHADOW'),
      React.createElement('span', { className: 'font-bold', 'data-acc-shadow-cls': '1' }, 'CLASS'))`,
    `{ mode: 'replace', shadow: true }`,
  )
  const probe = await evaluate(`(() => {
    const hostEl = document.querySelector('header [data-ext-shadow]')
    if (!hostEl) return { error: '找不到隔离壳 [data-ext-shadow]' }
    const root = hostEl.shadowRoot
    if (!root) return { error: '隔离壳没有 shadowRoot' }
    const inner = root.querySelector('[data-acc-shadow-in]')
    const cls = root.querySelector('[data-acc-shadow-cls]')
    if (!inner || !cls) return { error: 'shadow 内缺少贡献元素' }

    // 对照一：宿主 DOM 里同样用 var(--gw-accent) 的元素（令牌应当与 shadow 内**同值**）
    const tokenProbe = document.createElement('span')
    tokenProbe.style.color = 'var(--gw-accent)'
    document.body.appendChild(tokenProbe)
    const tokenColor = getComputedStyle(tokenProbe).color
    tokenProbe.remove()

    // 对照二：宿主 DOM 里同样带 .font-bold 的元素（Tailwind 工具类在这里生效）。
    // ⚠️ 两点都是踩过的坑：
    // ① shadow 内那个元素**只**有类名、没有任何内联样式——否则内联在 light DOM 也会赢，
    //    这条断言就证明不了"类名进不去"；
    // ② 用 font-bold 而不是颜色类：页头那一处的**继承色恰好等于** .text-ink 的值
    //    （rgb(28,39,51)），拿颜色比对会得到"两者相同"的假失败——判据必须选一个
    //    不会被继承值撞上的属性。
    // ③ 本段是**模板字符串里的注释**：注释里出现反引号会把字面量提前闭合（本次踩过）。
    const control = document.createElement('span')
    control.className = 'font-bold'
    control.textContent = 'control'
    document.body.appendChild(control)
    const controlWeight = getComputedStyle(control).fontWeight
    control.remove()

    return {
      hostDisplay: getComputedStyle(hostEl).display,
      innerColor: getComputedStyle(inner).color,
      classWeight: getComputedStyle(cls).fontWeight,
      inheritedWeight: getComputedStyle(hostEl).fontWeight,
      controlWeight,
      tokenColor,
      innerText: root.textContent,
      lightDomLeak: !!document.querySelector('header [data-acc-shadow-in]'),
    }
  })()`)

  if (probe.error) {
    check('P9 shadow 隔离壳与 Shadow Root 建立', false, probe.error)
  } else {
    check('P9 shadow 隔离壳与 Shadow Root 建立', probe.innerText.includes('SHADOW'), JSON.stringify(probe.innerText))
    check('P9 隔离壳 display: contents（不参与布局）', probe.hostDisplay === 'contents', `实际 ${probe.hostDisplay}`)
    check(
      'P9 宿主 Tailwind 类名进不去 shadow（.font-bold 不生效，退回继承字重）',
      probe.classWeight !== probe.controlWeight && probe.classWeight === probe.inheritedWeight,
      `shadow 内 ${probe.classWeight}（继承 ${probe.inheritedWeight}）vs 宿主内 ${probe.controlWeight}`,
    )
    check(
      'P9 --gw-* 令牌跨 shadow 边界继承',
      probe.innerColor === probe.tokenColor,
      `shadow 内 ${probe.innerColor} vs 宿主内 ${probe.tokenColor}`,
    )
    check('P9 贡献没有泄漏到宿主 DOM', probe.lightDomLeak === false, 'light DOM 里出现了贡献元素')
  }
  await unregister(token)
}

/* ⑥ P11：外壳节点（shell-*）——容器节点只换**内容**，外壳元素与内层出口由宿主独占 */
{
  /* ① 空页脚不占位（`:only-child` 契约的真实浏览器证据，先立基线再谈接线） */
  const emptyFooter = await evaluate(`(() => {
    const footer = document.querySelector('footer.app-footer')
    if (!footer) return { error: '找不到 footer.app-footer' }
    return { display: getComputedStyle(footer).display, children: footer.children.length }
  })()`)
  check(
    'P11 空页脚不占位（:only-child 命中 ⇒ display:none）',
    emptyFooter.display === 'none' && emptyFooter.children === 1,
    JSON.stringify(emptyFooter),
  )

  /* ② replace shell-footer：换掉页脚**内容**；`<footer>` 与 app-footer 出口由宿主独占 */
  const offFooter = await withExtension(
    'shell-footer',
    `(p) => React.createElement('div', { 'data-acc-footer': '1' }, '插件页脚')`,
    `{ mode: 'replace' }`,
  )
  const replacedFooter = await evaluate(`(() => {
    const marker = document.querySelector('[data-acc-footer]')
    return {
      marker: !!marker,
      inFooter: marker ? !!marker.closest('footer.app-footer') : false,
      hostFooter: !!document.querySelector('footer.app-footer'),
      outlet: document.querySelectorAll('.slot-outlet[data-slot="app-footer"]').length,
    }
  })()`)
  check(
    'P11 replace shell-footer 只换内容（<footer> 与 app-footer 出口由宿主独占、恰好一份）',
    replacedFooter.marker === true &&
      replacedFooter.inFooter === true &&
      replacedFooter.hostFooter === true &&
      replacedFooter.outlet === 1,
    JSON.stringify(replacedFooter),
  )
  await unregister(offFooter)
  const restoredFooter = await evaluate(`(() => {
    const footer = document.querySelector('footer.app-footer')
    return { host: !!footer, marker: !!document.querySelector('[data-acc-footer]'), display: footer ? getComputedStyle(footer).display : null }
  })()`)
  check(
    'P11 卸载后页脚内容还原（并重新不占位）',
    restoredFooter.host === true && restoredFooter.marker === false && restoredFooter.display === 'none',
    JSON.stringify(restoredFooter),
  )

  /*
    ③ extend shell-footer：节点就在 `<footer>` **内部**，故追加的贡献落在页脚里 ⇒ 页脚显形
    （不再是 `:only-child`）。这条与①合起来说明"空则不占位"仍然成立，且**有贡献才占位**。
  */
  const offNote = await withExtension(
    'shell-footer',
    `(p) => React.createElement('span', { 'data-acc-note': '1' }, '插件加注')`,
    `{ mode: 'extend' }`,
  )
  const extendProbe = await evaluate(`(() => {
    const note = document.querySelector('[data-acc-note]')
    const footer = document.querySelector('footer.app-footer')
    return {
      note: !!note,
      insideFooter: note ? !!note.closest('footer.app-footer') : null,
      footerDisplay: footer ? getComputedStyle(footer).display : null,
    }
  })()`)
  check(
    'P11 extend shell-footer 落在 footer 之内 ⇒ 页脚因此显形',
    extendProbe.note === true && extendProbe.insideFooter === true && extendProbe.footerDisplay !== 'none',
    JSON.stringify(extendProbe),
  )
  await unregister(offNote)

  /*
    ④ replace shell-header：换掉顶栏**内容**。判据用品牌字样 `.text-wordmark`（它唯一），
    而不是"页面上还有没有 header 元素"——`<header>` 由宿主独占，**它必须还在**，
    这正是"其他插件的页头贡献不可能被删掉"的结构前提。
  */
  const brandBefore = await evaluate(`!!document.querySelector('.text-wordmark')`)
  const offHeader = await withExtension(
    'shell-header',
    `(p) => React.createElement('div', { 'data-acc-shell': '1' }, '插件外壳')`,
    `{ mode: 'replace' }`,
  )
  const shellProbe = await evaluate(`(() => ({
    marker: !!document.querySelector('[data-acc-shell]'),
    brand: !!document.querySelector('.text-wordmark'),
    hostHeader: !!document.querySelector('header'),
  }))()`)
  check(
    'P11 replace shell-header 只换内容（品牌字样让位，<header> 仍在）',
    brandBefore === true && shellProbe.marker === true && shellProbe.brand === false && shellProbe.hostHeader === true,
    JSON.stringify({ brandBefore, ...shellProbe }),
  )
  await unregister(offHeader)
  const brandAfter = await evaluate(`!!document.querySelector('.text-wordmark')`)
  check('P11 卸载后顶栏与品牌字样逐字还原', brandAfter === true, `品牌字样存在=${brandAfter}`)

  /* ⑤ wrap shell-header：`default` 里是**顶栏内容**（品牌字样仍在其内、仍处于 header 中） */
  const offWrapShell = await withExtension(
    'shell-header',
    `(p) => React.createElement('div', { 'data-acc-wrap-shell': '1' }, p.default)`,
    `{ mode: 'wrap' }`,
  )
  const wrapShellProbe = await evaluate(`(() => {
    const el = document.querySelector('[data-acc-wrap-shell]')
    if (!el) return { error: '找不到 wrap 元素' }
    const wordmark = el.querySelector('.text-wordmark')
    return { hasWordmark: !!wordmark, inHeader: wordmark ? !!wordmark.closest('header') : false }
  })()`)
  check(
    'P11 wrap shell-header 的 default 是顶栏内容（品牌字样仍在其内、仍在 <header> 中）',
    wrapShellProbe.error === undefined && wrapShellProbe.hasWordmark === true && wrapShellProbe.inHeader === true,
    JSON.stringify(wrapShellProbe),
  )
  await unregister(offWrapShell)
}

/* ⑦ P11b：容器节点 —— replace 顶栏时，其他插件的页头贡献**不可能**被删掉 */
{
  /*
    这一节是**用户当场驳回的缺陷**的端到端回归：`replace shell-header` 曾经把整个 `<header>`
    子树交给单个插件，于是它一注册，其他所有插件的页头贡献就消失了（而且没有任何报错）。
    现在出口由宿主渲染、留在节点之外，插件只能决定它落在哪（`props.slots`）。
  */
  const offCounter = await withExtension(
    'app-header',
    `(p) => React.createElement('button', { 'data-acc-counter': '1', type: 'button' }, '+1')`,
    `{ mode: 'extend' }`,
  )
  const baseline = await evaluate(`(() => {
    const el = document.querySelector('[data-acc-counter]')
    return { present: !!el, inHeader: el ? !!el.closest('header') : false }
  })()`)
  check(
    'P11b 基线：app-header 贡献在 <header> 内渲染',
    baseline.present === true && baseline.inHeader === true,
    JSON.stringify(baseline),
  )

  /* ② replace 顶栏内容，且**完全无视** props.slots ⇒ 别人的贡献照样在 */
  const offIgnore = await withExtension(
    'shell-header',
    `(p) => React.createElement('nav', { 'data-acc-nav': '1' }, 'ACC-NAV')`,
    `{ mode: 'replace' }`,
  )
  const ignored = await evaluate(`(() => {
    const counter = document.querySelector('[data-acc-counter]')
    return {
      nav: !!document.querySelector('[data-acc-nav]'),
      hostBrand: !!document.querySelector('.text-wordmark'),
      counter: !!counter,
      counterInHeader: counter ? !!counter.closest('header') : false,
    }
  })()`)
  check(
    'P11b replace shell-header 无视 props.slots 时，其他插件的页头贡献仍然渲染',
    ignored.nav === true && ignored.hostBrand === false && ignored.counter === true && ignored.counterInHeader === true,
    JSON.stringify(ignored),
  )
  await unregister(offIgnore)

  /* ③ replace 且渲染 props.slots['app-header'] ⇒ 出口被**搬进**插件的标记里（不是复制一份） */
  const offPlace = await withExtension(
    'shell-header',
    `(p) => React.createElement('nav', { 'data-acc-nav': '1' },
        React.createElement('span', null, 'L'),
        p.slots['app-header'],
        React.createElement('span', null, 'R'))`,
    `{ mode: 'replace' }`,
  )
  const placed = await evaluate(`(() => {
    const mount = document.querySelector('[data-ext-slot-mount="app-header"]')
    const counter = document.querySelector('[data-acc-counter]')
    return {
      mount: !!mount,
      mountInNav: mount ? !!mount.closest('[data-acc-nav]') : false,
      mountDisplay: mount ? getComputedStyle(mount).display : null,
      counter: !!counter,
      counterInNav: counter ? !!counter.closest('[data-acc-nav]') : false,
      // 出口必须**恰好一份**：搬运的是同一个出口，不是"宿主留一份 + 挂载点再来一份"
      outlets: document.querySelectorAll('.slot-outlet[data-slot="app-header"]').length,
    }
  })()`)
  check(
    'P11b 渲染 props.slots 后，页头贡献被搬进插件的标记里（恰好一份、壳不生成盒子）',
    placed.mount === true &&
      placed.mountInNav === true &&
      placed.mountDisplay === 'contents' &&
      placed.counter === true &&
      placed.counterInNav === true &&
      placed.outlets === 1,
    JSON.stringify(placed),
  )
  await unregister(offPlace)

  /* ④ 卸载 ⇒ 贡献回到宿主位置（挂载点随插件卸载消失，不能留下一个吞掉出口的空壳） */
  const restored = await evaluate(`(() => {
    const counter = document.querySelector('[data-acc-counter]')
    return {
      counter: !!counter,
      mount: !!document.querySelector('[data-ext-slot-mount="app-header"]'),
      counterInHeader: counter ? !!counter.closest('header') : false,
    }
  })()`)
  check(
    'P11b 卸载 replace 贡献后，页头贡献回到宿主位置',
    restored.counter === true && restored.mount === false && restored.counterInHeader === true,
    JSON.stringify(restored),
  )
  await unregister(offCounter)
}

/* ⑧ P11c：容器节点 × Shadow DOM —— 隔离根内的挂载点必须被忽略 */
{
  /*
    路径：`replace shell-header` 且 `shadow: true`，贡献者把 `props.slots['app-header']`
    渲染进自己的（隔离）标记里。挂载点登记不区分 light DOM / Shadow Root，
    于是承运者会把出口 portal 进 shadow root —— **其他插件的页头贡献被拖进隔离根、
    丢掉全部宿主 Tailwind 样式**（"宿主类名进不去 shadow"已被 P9 实证）。
    这是与"一个插件删掉别人的贡献"同一类的缺陷：单个插件在不知情中破坏别人。
    期望：落在 Shadow Root 内的挂载点被**忽略**（并告警），出口留在 light DOM 宿主位置。
  */
  const offCounter = await withExtension(
    'app-header',
    `(p) => React.createElement('span', { 'data-acc-shadow-counter': '1' }, 'CNT')`,
    `{ mode: 'extend' }`,
  )
  const offShadowShell = await withExtension(
    'shell-header',
    `(p) => React.createElement('div', { 'data-acc-shadow-shell': '1' },
        React.createElement('span', null, 'S'),
        p.slots['app-header'])`,
    `{ mode: 'replace', shadow: true }`,
  )
  const shadowProbe = await evaluate(`(() => {
    const host = document.querySelector('[data-ext-shadow]')
    const root = host ? host.shadowRoot : null
    const mount = root ? root.querySelector('[data-ext-slot-mount="app-header"]') : null
    /*
      ⚠️ 必须**两侧都查**：document.querySelector 不穿透 Shadow Root，所以"贡献被拖进隔离根"
      在宿主视角看起来与"贡献消失了"完全一样（首版探针就只查了宿主侧，得到 counter:false，
      把症状误读成"没渲染"）。另注：本段是模板字符串里的注释，**不能出现反引号**（会提前闭合字面量）。
    */
    return {
      shadowHost: !!host,
      mountInShadow: !!mount,
      counterLight: !!document.querySelector('[data-acc-shadow-counter]'),
      counterShadow: root ? !!root.querySelector('[data-acc-shadow-counter]') : false,
      outletsLight: document.querySelectorAll('.slot-outlet[data-slot="app-header"]').length,
      outletsShadow: root ? root.querySelectorAll('.slot-outlet[data-slot="app-header"]').length : 0,
    }
  })()`)
  check(
    'P11c shadow 内的挂载点被忽略：出口留在 light DOM，别人的贡献不被拖进隔离根',
    shadowProbe.shadowHost === true &&
      shadowProbe.mountInShadow === true &&
      shadowProbe.counterLight === true &&
      shadowProbe.counterShadow === false &&
      shadowProbe.outletsLight === 1 &&
      shadowProbe.outletsShadow === 0,
    JSON.stringify(shadowProbe),
  )
  await unregister(offShadowShell)
  await unregister(offCounter)
}

/* ⑨ P0：主题覆盖 --gw-* ⇒ Tailwind 工具类跟着变（这是"主题统一化"的核心断言） */
{
  const before = await evaluate(`(() => {
    const el = document.createElement('div')
    el.className = 'rounded-md'
    document.body.appendChild(el)
    const v = getComputedStyle(el).borderRadius
    el.remove()
    return v
  })()`)

  const token = `__acc_theme_${Math.random().toString(36).slice(2, 7)}`
  await evaluate(`(() => {
    const host = window.__GEEWIKI_HOST__
    window['${token}'] = host.registerTheme({ name: 'acc-theme', light: { '--gw-radius-md': '17px' } })
    return true
  })()`)
  await sleep(300)

  const after = await evaluate(`(() => {
    const el = document.createElement('div')
    el.className = 'rounded-md'
    document.body.appendChild(el)
    const v = getComputedStyle(el).borderRadius
    el.remove()
    return v
  })()`)
  check(
    'P0 registerTheme 覆盖 --gw-* 后 Tailwind 工具类跟随',
    before !== '17px' && after === '17px',
    `before=${before} after=${after}`,
  )

  await unregister(token)
  const restored = await evaluate(`(() => {
    const el = document.createElement('div')
    el.className = 'rounded-md'
    document.body.appendChild(el)
    const v = getComputedStyle(el).borderRadius
    el.remove()
    return v
  })()`)
  check('P0 卸载主题后工具类还原', restored === before, `before=${before} restored=${restored}`)
}

/* ⑩ 入口表与静态层：插件 UI 的就绪性判定（P4 之前就有的契约，本批必须没被破坏） */
{
  const table = await evaluate(`fetch('/api/plugins/ui').then((r) => r.json())`)
  const skipped = Array.isArray(table.skipped) ? table.skipped : []
  const uiDemo = skipped.find((s) => s.name === '@geewiki-plugin/ui-demo')
  check(
    '入口表：未启用的插件被列为 skipped(inactive)，而不是悄悄消失',
    table.ok === true && uiDemo !== undefined && uiDemo.reason === 'inactive',
    JSON.stringify(skipped.map((s) => `${s.name}:${s.reason}`)),
  )

  /*
    静态层按名查根**不按激活过滤**（刻意的：刚被停用的插件可能还有在途 import 要结算）。
    这里验的是"插件自带产物根"（`<插件目录>/dist`）确实被挂上了——`plugins/ui-demo/dist`
    是**仓库里真实存在**的那一份，与宿主内置根无关。
  */
  const asset = await evaluate(`fetch('/plugins-ui/@geewiki-plugin/ui-demo/client.js', { method: 'HEAD' }).then((r) => r.status)`)
  check('静态层：插件自带产物根可访问（/plugins-ui/<名>/client.js）', asset === 200, `status=${asset}`)
}

/* ⑪ P12b：插件 bundle → 受限宿主 → 带模式注册（真加载器、真浏览器、真产物） */
{
  /*
    ## 为什么这条必须存在
    前面所有场景都是**直接调 `window.__GEEWIKI_HOST__.registerExtension`** 注册的（因此不需要登录），
    于是"清单声明 `geewiki.extensions` → 后端放行 → 插件 bundle 经**受限宿主**带 mode 注册 → 渲染"
    这条链只有单测覆盖。而 P12 修的正是这条链：受限宿主原先**只有 `registerSlot`**（= 只会 extend），
    走这条正规形态的插件根本用不了 `replace`/`wrap`/`shadow`。

    这里启用真实的示例插件（`plugins/ui-demo`，其产物由 `build:fixtures` 构建到 `plugins/<名>/dist`），
    断言四件事：① 它的 `registerSlot` 贡献（页头计数器）出现；② 它的 **`wrap shell-brand-text`**
    贡献出现且**没有弄丢**宿主品牌字样（wrap 的意义）；③ **P13**：它**在模块求值期**用
    `window.__GEEWIKI_HOST__` 注册的顶层贡献（`[data-fixture="toplevel"]`）也归属到插件名；
    ④ 停用后三样都干净消失 —— 最后这条同时验证了"贡献归属到插件名 ⇒ 能按 owner 回收"
    （P13 之前顶层那条路的来源是 `'host-sdk'`，**收不回**，这个标记会残留）。
  */
  const UI_DEMO = '@geewiki-plugin/ui-demo'
  const auth = await ensureAdminSession(pageUrl)
  console.log(auth.ok ? `auth：${auth.note}` : `auth：SKIP —— ${auth.note}`)
  if (!auth.ok) {
    console.log(`skip P12b —— 启用 ${UI_DEMO} 需要 admin 会话（见上面的 auth 说明）`)
  } else {
    const enableStatus = await setPluginEnabled(pageUrl, auth.session, UI_DEMO, true)
    check('P12b 启用示例插件返回 200（鉴权 + x-gw-csrf 生效）', enableStatus === 200, `status=${enableStatus}`)
    // 让前端加载器立刻对齐（否则要等 15s 可见期轮询）；`sync()` 与轮询走的是同一入口
    await evaluate(`window.__GEEWIKI_PLUGIN_UI__.sync()`)

    const probe = `(() => {
      const counter = document.querySelector('[data-fixture="counter"]')
      const tag = document.querySelector('.gw-fixture-brand-tag')
      const wordmark = document.querySelector('.text-wordmark')
      const toplevel = document.querySelector('[data-fixture="toplevel"]')
      return {
        loaded: window.__GEEWIKI_PLUGIN_UI__.loaded(),
        counter: !!counter,
        counterInHeader: counter ? !!counter.closest('[data-slot="app-header"]') : false,
        brandTag: !!tag,
        brandTagInHeader: tag ? !!tag.closest('header') : false,
        toplevel: !!toplevel,
        toplevelInHeader: toplevel ? !!toplevel.closest('[data-slot="app-header"]') : false,
        wordmark: wordmark ? wordmark.textContent : null,
        links: [...document.querySelectorAll('link[data-plugin-ui]')].map((l) => l.dataset.pluginUi),
      }
    })()`

    let on = await evaluate(probe)
    for (let i = 0; i < 25 && !(on.counter && on.brandTag && on.toplevel); i++) {
      await sleep(400)
      on = await evaluate(probe)
    }
    check(
      'P12b 插件 bundle 的 registerSlot 贡献出现（页头计数器）',
      on.counter === true && on.counterInHeader === true,
      JSON.stringify({ counter: on.counter, counterInHeader: on.counterInHeader }),
    )
    check(
      'P12b 插件 bundle 的 registerExtension(wrap) 贡献出现（品牌字样被包一层）',
      on.brandTag === true && on.brandTagInHeader === true,
      JSON.stringify({ brandTag: on.brandTag, brandTagInHeader: on.brandTagInHeader }),
    )
    check(
      'P13 模块求值期（顶层形态）用全局 SDK 的注册归属到插件名并渲染',
      on.toplevel === true && on.toplevelInHeader === true,
      JSON.stringify({ toplevel: on.toplevel, toplevelInHeader: on.toplevelInHeader }),
    )
    check(
      'P12b wrap 没有弄丢宿主品牌字样（default 仍在）',
      on.wordmark === 'GeeWiki',
      `wordmark=${JSON.stringify(on.wordmark)}`,
    )
    check(
      'P12b 插件产物与 CSS 都被入口表驱动加载',
      on.loaded.includes(UI_DEMO) && on.links.includes(UI_DEMO),
      JSON.stringify({ loaded: on.loaded, links: on.links }),
    )

    const disableStatus = await setPluginEnabled(pageUrl, auth.session, UI_DEMO, false)
    check('P12b 停用示例插件返回 200', disableStatus === 200, `status=${disableStatus}`)
    await evaluate(`window.__GEEWIKI_PLUGIN_UI__.sync()`)
    let off = await evaluate(probe)
    for (let i = 0; i < 25 && (off.counter || off.brandTag || off.toplevel); i++) {
      await sleep(400)
      off = await evaluate(probe)
    }
    check(
      'P12b 停用后贡献被按 owner 回收（计数器与 wrap 都消失）',
      off.counter === false && off.brandTag === false,
      JSON.stringify({ counter: off.counter, brandTag: off.brandTag }),
    )
    check(
      'P13 停用后**顶层形态**的注册也被回收（修复前来源是 host-sdk，这个标记会残留）',
      off.toplevel === false,
      JSON.stringify({ toplevel: off.toplevel }),
    )
    check(
      'P12b 停用后品牌字样逐字还原、CSS <link> 被移除',
      off.wordmark === 'GeeWiki' && !off.links.includes(UI_DEMO) && !off.loaded.includes(UI_DEMO),
      JSON.stringify({ wordmark: off.wordmark, links: off.links, loaded: off.loaded }),
    )
  }
}

/* ⑫ P13：portal 类节点（extend + replace 可用，**wrap 被拒**） */
{
  /*
    ## 为什么这条必须存在
    portal 类节点（`ui-dialog-content` / `ui-dropdown-menu-content` / `ui-confirm-dialog` /
    `ui-tooltip`）的**可见内容**经 Radix `<Portal>` 渲染到 `document.body` 附近，**不在调用处的
    DOM 子树里**。目录据此给它们标了 `portal: true` 并砍掉 `wrap`（`PORTAL_UI_MODES`）：
    `wrap` 的契约是"把你的元素包在宿主默认实现外面"，而包装元素的子树**装不下 portal 的内容**
    ⇒ 样式与作用域都进不去，作者却以为包住了。静默失效，所以不提供。

    这条在真浏览器里验证两件**单测证明不了**的事：
    ① `replace` 经**定义处接线**在全站生效（`ui-tooltip` 的调用点真的被换掉）；
    ② `wrap` 在**注册路径**上被真的拦下（宿主侧模式校验 + 告警），而不是只有目录字段写着不允许。
  */
  const replacedToken = await withExtension(
    'ui-tooltip',
    `(p) => React.createElement(React.Fragment, null, p.children,
       React.createElement('span', { 'data-acc-tooltip': '1' }, 'TOOLTIP-REPLACED'))`,
    `{ mode: 'replace' }`,
  )
  const replaced = await evaluate(`document.querySelectorAll('[data-acc-tooltip]').length`)
  check('P13 portal 节点 replace 生效（ui-tooltip 的调用点被换掉）', replaced >= 1, `换掉 ${replaced} 处`)
  await unregister(replacedToken)
  const restored = await evaluate(`document.querySelectorAll('[data-acc-tooltip]').length`)
  check('P13 卸载后 portal 节点还原宿主默认实现', restored === 0, `残留 ${restored}`)

  const wrapToken = await withExtension(
    'ui-tooltip',
    `(p) => React.createElement('span', { 'data-acc-tooltip-wrap': '1' }, p.default)`,
    `{ mode: 'wrap' }`,
  )
  const wrapped = await evaluate(`document.querySelectorAll('[data-acc-tooltip-wrap]').length`)
  check(
    'P13 portal 节点拒绝 wrap（包装元素装不下 portal 内容 ⇒ 不提供这个陷阱）',
    wrapped === 0,
    `wrap 贡献渲染了 ${wrapped} 处`,
  )
  await unregister(wrapToken)
}

/* ⑬ 全程 console 零错误、无失败请求 */
{
  /*
    未登录时 SPA 自己会去打 `/api/session` 这类需要登录的端点并拿到 401 —— 那是**预期状态**，
    不是缺陷。但"容忍所有 401"会把真实的鉴权回归一起吞掉，所以这里**显式探测**当前是否
    匿名态：只有匿名态下才容忍 401，且把被容忍的行原样写进结果 JSON 供复核。
  */
  const sessionStatus = await evaluate(`fetch('/api/session').then((r) => r.status)`)
  const anonymous = sessionStatus === 401

  const bad = events.filter((e) => {
    if (e.kind === 'console') return !consoleWhitelist.some((re) => re.test(e.text))
    if (e.kind === 'log') {
      if (e.type !== 'error') return false
      return !(anonymous && /401 \(Unauthorized\)/.test(String(e.text)))
    }
    if (e.kind === 'http' && anonymous && e.status === 401) return false
    return true
  })
  check(
    `console 零错误 / 无失败请求${anonymous ? '（匿名态：已按预期容忍 401）' : ''}`,
    bad.length === 0,
    bad.map((e) => `${e.kind}:${e.type ?? ''} ${String(e.text).slice(0, 160)}`).join(' | '),
  )
  results['匿名态探测'] = { ok: true, detail: `/api/session → ${sessionStatus}（401 = 未登录，属预期）` }
}

/* ------------------------------ 收尾 ------------------------------ */

const outPath = resolve('tmp/ui-extension-cdp.out.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ pageUrl, results, events, failures }, null, 2))
console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}（读数写到 ${outPath}）`)
ws.close()
process.exit(failures.length === 0 ? 0 : 1)
