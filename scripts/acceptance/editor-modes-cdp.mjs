#!/usr/bin/env node
/**
 * 编辑器「两种模式 + 工具栏 + 块级权限」的浏览器端到端验收（零依赖：Node 内置 WebSocket + 直连 CDP）。
 *
 * 用法：
 *   # dev：pnpm dev 之后（后端 3000 / Vite 5173）
 *   node scripts/acceptance/editor-modes-cdp.mjs http://127.0.0.1:5173 [cdpPort] [--slug=mixed-visibility]
 *
 * 前置：
 *   1. 一个跑起来的实例（`pnpm dev` 或 `pnpm build && pnpm start`）；
 *   2. 演示数据（`bash scripts/seed-demo.sh`）—— 它会建出 `mixed-visibility`：
 *      一个「公开 + 已发布」但正文里含 `<!--gated:org-->` 与 `<!--gated:granted-->` 的页面；
 *   3. Chrome 以 `--remote-debugging-port=<cdpPort>` 启动（headless 亦可）。
 *
 * 为什么与 `plugin-ui-cdp.mjs` 一样**不并进 `pnpm test`**：它需要浏览器、运行中的实例与演示数据，
 * 属于集成/验收层；`pnpm test` 只跑无浏览器、无网络的单测。
 *
 * 覆盖（每条都以"作者实际会做的动作"为单位，而不是以函数为单位）：
 *   A 登录（演示管理员）                 B 编辑页与编辑器就绪
 *   C 工具栏存在且按钮齐全               D 默认模式是「实时渲染」
 *   E 实时渲染：非活动段落的 `#` 标记不可见（活动段落仍显示源码）
 *   F 受限区段画成带锁的区段（`.gw-live-gate` + 底色行）
 *   G 光标进入某段 ⇒ 锁按钮报出这一段的档位
 *   H 通过锁菜单改档位 ⇒ 正文里的标记被改写、状态行如实说明、**⌘Z 一次可撤销**
 *   I 工具栏格式动作（加粗）真的改了正文       J 源码模式显示标记
 *   K 编辑页含「权限」区（页面档位就地可改）   L 「按访客视角预览」按视角遮蔽受限段落
 *   M 旧深链 `#/access/<slug>` 跳到该页的权限对话框（`?access=1`）
 *   P 实时渲染的**块级渲染**：围栏代码块整块画成 `pre>code`、表格整块画成真 `<table>`（围栏/管道不再露出）、
 *     受限区段里的渲染块**带上区段底纹**、点它即回源码、⌘Z 一次撤回且撤销栈干净
 *   N 全程无控制台 error、无 4xx/5xx（Vite HMR 等白名单除外）
 *
 * 退出码：全部通过 0，否则 1（结果 JSON 写到 `data/verify/editor-modes-cdp.out.json`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const pageUrl = process.argv[2] ?? 'http://127.0.0.1:5173'
const cdpPort = Number(process.argv[3] ?? 9455)
const slugArg = process.argv.find((a) => a.startsWith('--slug='))
const slug = slugArg ? slugArg.slice('--slug='.length) : 'mixed-visibility'
const EMAIL = process.env['GW_EMAIL'] ?? 'admin@example.com'
const PASSWORD = process.env['GW_PASSWORD'] ?? 'Demo-Admin-2026'
const OUT_DIR = 'data/verify'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const failures = []

function check(name, ok, detail) {
  results[name] = { ok, detail }
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ------------------------------ 1. 打开 Chrome 的调试口 ------------------------------ */

/*
 * ⚠️ **自己新建一个页面 target**，不复用 Chrome 里已有的那个。
 *
 * 为什么：一个 page target 同时只接受一条 CDP 会话。上一次运行如果没干净收尾
 * （抛错、被 kill、超时），那条会话会让 `new WebSocket(...)` 永远停在 CONNECTING
 * ——现象是脚本**一个字都不打印就挂住**，而 `curl /json/list` 一切正常，极难定位（实测踩到）。
 * 用浏览器级端点 `Target.createTarget` 拿一个干净页面，并在收尾时关掉它。
 */
let browserWs
try {
  const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
  browserWs = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    browserWs.onopen = res
    browserWs.onerror = () => rej(new Error('浏览器级 CDP 连接失败'))
  })
} catch (e) {
  console.error(`连不上 CDP（http://127.0.0.1:${cdpPort}）：Chrome 是否以 --remote-debugging-port=${cdpPort} 启动？`)
  console.error(String(e))
  process.exit(2)
}

let browserSeq = 0
const browserPending = new Map()
browserWs.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && browserPending.has(msg.id)) {
    browserPending.get(msg.id)(msg)
    browserPending.delete(msg.id)
  }
}
const browserSend = (method, params = {}) =>
  new Promise((res) => {
    const id = ++browserSeq
    browserPending.set(id, res)
    browserWs.send(JSON.stringify({ id, method, params }))
  })

const created = await browserSend('Target.createTarget', { url: 'about:blank' })
const targetId = created.result?.targetId
if (!targetId) {
  console.error('Target.createTarget 未返回 targetId')
  process.exit(2)
}
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const target = targets.find((t) => t.id === targetId)
if (!target) {
  console.error('新建的 target 未出现在 /json/list 里')
  process.exit(2)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
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
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    events.push({
      kind: 'console',
      type: msg.params.type,
      text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type ?? '').join(' '),
    })
  } else if (msg.method === 'Runtime.exceptionThrown') {
    events.push({ kind: 'exception', text: msg.params.exceptionDetails?.text ?? 'exception' })
  } else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
    events.push({ kind: 'http', status: msg.params.response.status, text: msg.params.response.url })
  } else if (msg.method === 'Page.javascriptDialogOpening') {
    /*
     * ★ 编辑页有「未保存就离开」的原生确认（`useUnsavedGuard` 的 beforeunload）。
     * 脚本改完正文再导航时，Chrome 会弹这个确认并**把 `Page.navigate` 挂住** ——
     * 不处理它，脚本会在下一次导航处静默超时（实测：改过正文之后的那次 goto 再无输出）。
     * 验收脚本的立场是"用户确认离开"，故自动接受。
     */
    events.push({ kind: 'dialog', text: msg.params.message })
    void send('Page.handleJavaScriptDialog', { accept: true })
  }
}

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })

/** 在页面里求值（等 Promise、按值返回） */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    throw new Error(`页面求值抛错：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

const consoleWhitelist = [/\[vite\]/, /Download the React DevTools/, /proOptions/, /React Flow/]

/**
 * 导航到一个 hash，并**强制整篇重新加载**。
 *
 * 为什么必须强制：登录是在页面里 `fetch` 完成的，而应用的能力状态由 `authStore` 在
 * **文档加载时**读取 —— 只改 hash 的导航不触发文档重载（只发 hashchange），
 * 于是应用仍以为自己未登录，编辑页会渲染成"需要先登录"（实测踩到过）。
 * 加一个一次性查询串即可强制重载，也让 `?access=1` 这类查询串判定在真实加载路径下被验证。
 */
let nonce = 0
async function goto(hash, waitMs = 2500) {
  await send('Page.navigate', { url: `${pageUrl}/?gw=${++nonce}${hash}` })
  await sleep(waitMs)
}

/**
 * 兜底：若「发现未保存的草稿」对话框仍然出现（例如上一次运行刚写过草稿），就丢弃它。
 * 不这么做的话，模态遮罩会让后续点击全部落空，而失败点离原因很远。
 */
async function dismissDraftDialog() {
  const has = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    return d !== null && (d.textContent ?? '').includes('发现未保存的草稿')
  })()`)
  if (has === true) {
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '丢弃草稿')
      b?.click()
      return true
    })()`)
    await sleep(500)
  }
}

/**
 * 只在**对话框内部**按名称点按钮。
 *
 * 为什么不能用 `clickButton`：它会匹配全文档第一个同名按钮，而页面本身的「取消」在 DOM 里
 * 排在（portal 出来的）对话框之前 —— 于是"取消表单填写"会变成"退出编辑页"，对话框随之消失，
 * 下一步报"找不到按钮：关闭"（实测踩到，报错点离原因很远）。
 */
async function clickDialogButton(label) {
  const box = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    if (d === null) return null
    const b = [...d.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? x.textContent ?? '').includes(${JSON.stringify(label)}))
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (box === null) throw new Error(`对话框内找不到按钮：${label}`)
  await clickAt(box.x, box.y)
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(`${OUT_DIR}/shots`, { recursive: true })
  writeFileSync(`${OUT_DIR}/shots/${name}.png`, Buffer.from(r.data, 'base64'))
}

/**
 * 按可访问名称点按钮。
 *
 * ⚠️ **先 `scrollIntoView` 再量坐标**：编辑页比一屏高，量到的 y 可能是负数（目标在视口上方），
 * 于是合成点击落在窗口之外 —— 表现为"按钮明明在，点了没反应"，而失败点离原因很远
 * （实测：模式切换与预览入口一起失败，原因是前一步把某段滚动到了视口中央）。
 */
async function clickButton(label, nth = 0) {
  const box = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].filter((x) => (x.getAttribute('aria-label') ?? x.textContent ?? '').includes(${JSON.stringify(label)}))[${nth}]
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, y0: r.y }
  })()`)
  if (box === null) throw new Error(`找不到按钮：${label}`)
  if (box.y < 0 || box.y > 1000) throw new Error(`按钮不在视口内（${label} y=${Math.round(box.y)}）——scrollIntoView 之后仍是如此`)
  await clickAt(box.x, box.y)
}

async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(200)
}

/**
 * 某段文字当前处在哪个受限区段里（`'none'` = 没有标记）。
 *
 * 为什么用它而不是数 `.gw-live-gate` 的个数：**"只改这一段"会把一个区段拆成两半**
 * （兄弟段落各自保留自己的档位），此时开放标记的数量可以不变 —— 数个数会把正确行为
 * 判成失败（实测踩到）。真正要断言的是"我选的那段出来了、旁边的段落还在里面"。
 */
function regionOfIn(content, needle) {
  let region = 'none'
  // ⚠️ 逐行 `trim()`：`.cm-content` 的 innerText 每行**带前导空白**（实测标题行是
  // `" 混合可见性演示"`），不加这一步，锚定在行首的标记正则永远匹配不上。
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    const open = /^<!--\s*gated\s*:\s*(org|granted)\s*-->\s*$/.exec(line)
    if (open) {
      region = open[1]
      continue
    }
    if (/^<!--\s*\/gated\s*-->\s*$/.test(line)) {
      region = 'none'
      continue
    }
    if (line.includes(needle)) return region
  }
  return 'none'
}

/** 把光标移到正文末尾（用键盘而不是点击：最后一行常在可视区之外，点击会落空 —— 实测踩到过） */
async function caretToDocEnd() {
  await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}).focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
  await sleep(300)
}

/** 读编辑区**真实正文**（切到源码模式读，避免装饰把标记藏掉/替换掉） */
async function readSourceText() {
  await clickButton('源码')
  await sleep(500)
  const text = await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText`)
  await clickButton('实时渲染')
  await sleep(400)
  return text
}

/**
 * 把光标放进含某段文字的正文行。
 *
 * 两处必须这么写（都踩过）：
 * 1. **先 `scrollIntoView` 再重新量坐标**：目标行可能在可视区之外，量到的 y 落在窗口外，
 *    点击就等于什么都没点（而脚本会继续往下跑，失败点离原因很远）；
 * 2. **点完校验**：用调用方给的判据（锁按钮文案）确认光标真的进去了，否则重试一次。
 */
async function clickLine(matchText, verify) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = await evaluate(`(() => {
      const lines = [...document.querySelectorAll('.cm-line')]
      const line = lines.find((l) => (l.textContent ?? '').includes(${JSON.stringify(matchText)}))
      if (!line) return null
      line.scrollIntoView({ block: 'center' })
      const r = line.getBoundingClientRect()
      return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }
    })()`)
    if (box === null) throw new Error(`找不到含「${matchText}」的正文行`)
    await clickAt(box.x, box.y)
    await sleep(250)
    if (verify === undefined) return
    if ((await evaluate(verify)) === true) return
  }
}

/**
 * 选中锁菜单里的一项。
 *
 * 为什么把"找 + 点"放在**一次**求值里：Radix 菜单会因为失焦/滚动而关闭，分成两次
 * `evaluate` 时中间那一小段时间足够它关掉 —— 上一次运行就栽在这里（第二次求值里
 * `menuitem` 已经没了，报 `Cannot read properties of undefined`）。
 * 失败时重新打开菜单再试（最多两次）。
 */
async function pickMenuItem(matchText, attempt = 0) {
  const ok = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((i) => (i.textContent ?? '').includes(${JSON.stringify(matchText)}))
    if (!item) return false
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    item.click()
    return true
  })()`)
  if (ok === true || attempt >= 2) return ok === true
  await clickButton('段落权限')
  await sleep(500)
  return pickMenuItem(matchText, attempt + 1)
}

const EDITOR_SEL = '.cm-content[aria-label="Markdown 正文编辑器"]'

/*
 * 清掉本源的 localStorage。
 *
 * 为什么必须：编辑页会在改动后把**草稿**写进 localStorage（900ms 防抖），下一次运行
 * 打开同一页时就会弹出「发现未保存的草稿」这个**模态**对话框 —— 之后所有鼠标点击都落在
 * 遮罩上，表现为"按钮明明在，点了没反应"（实测连续两次运行踩到：G/H1/L 一起失败，
 * 只在第二次运行出现）。验收要的是**干净的加载路径**，故先清空。
 * （顺带把编辑器模式偏好复位成默认值 —— 本脚本正是要断言默认是「实时渲染」。）
 */
await goto('#/wiki')
await evaluate('localStorage.clear()')

/* ------------------------------ A. 登录 ------------------------------ */
await goto('#/wiki')
const login = await evaluate(`(async () => {
  const r = await fetch('/api/auth/login', {
    method: 'POST',
    // 已带会话 cookie 时服务端要求 CSRF 头（同源写路径的既有约定）；首次登录时它是多余的
    headers: { 'content-type': 'application/json', 'x-gw-csrf': '1' },
    body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} }),
  })
  const me = await fetch('/api/auth/me').then((x) => x.json())
  return { status: r.status, caps: me.capabilities ?? null }
})()`)
check('A 演示管理员登录成功且有 manageVisibility', login.status === 200 && login.caps?.manageVisibility === true, JSON.stringify(login))

/* ------------------------------ B/C/D. 编辑页与工具栏 ------------------------------ */
await goto(`#/wiki/${slug}/edit`, 3500)
await dismissDraftDialog()
const ready = await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}) !== null`)
check('B 编辑页加载出编辑器（CodeMirror 已挂载）', ready === true)

const toolbar = await evaluate(`(() => {
  const bar = document.querySelector('[role="group"][aria-label="排版工具栏"]')
  if (!bar) return null
  const labels = [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim())
  const mode = document.querySelector('[role="group"][aria-label="编辑模式"]')
  const modeButtons = mode ? [...mode.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') })) : []
  return { labels, modeButtons }
})()`)
const need = ['加粗', '斜体', '链接', '表格', '段落权限', '撤销']
check(
  'C 工具栏含格式按钮 + 撤销 + 段落权限',
  toolbar !== null && need.every((n) => toolbar.labels.some((l) => l.includes(n))),
  toolbar === null ? '未找到工具栏' : toolbar.labels.join('/'),
)
const livePressed = toolbar?.modeButtons.find((m) => m.t === '实时渲染')?.pressed
const sourcePressed = toolbar?.modeButtons.find((m) => m.t === '源码')?.pressed
check('D 默认模式是「实时渲染」', livePressed === 'true' && sourcePressed === 'false', JSON.stringify(toolbar?.modeButtons))

/* ------------------------------ E/F. 实时渲染的效果 ------------------------------ */

// 先把光标放到**文末**（那时前面的标题/受限段落都处于"渲染态"）
await caretToDocEnd()
// 光标落点校验：文末那一块是活动块 ⇒ 标题行不该是活动块
const caretAtEnd = await evaluate(`(() => {
  const lines = [...document.querySelectorAll('.cm-line')]
  return document.activeElement?.classList.contains('cm-content') === true && lines.length > 0
})()`)
check('E0 光标可以移到正文末尾（前置）', caretAtEnd === true)

const headingVisible = await evaluate(`(() => {
  const line = [...document.querySelectorAll('.cm-line')].find((l) => (l.textContent ?? '').includes('混合可见性演示'))
  return line ? line.textContent : null
})()`)
check(
  'E 实时渲染下非活动段落的 `#` 标记不可见',
  headingVisible !== null && !headingVisible.includes('#') && headingVisible.includes('混合可见性演示'),
  JSON.stringify(headingVisible),
)

const gateInfo = await evaluate(`(() => ({
  gates: [...document.querySelectorAll('.gw-live-gate')].map((g) => g.textContent),
  gatedLines: document.querySelectorAll('.gw-live-gated-line').length,
  endLines: document.querySelectorAll('.gw-live-gated-end').length,
  // 实时渲染下**任何** gated 标记都不该以字面量出现在正文里（开标记与闭标记都一样）
  // 统计"看起来像标记字面量"的行：含尖括号且含 gated。
  // 为什么不写正则：本脚本是 ESM，源码里出现 HTML 注释起始符（哪怕在正则里）会被 Node
  // 直接拒绝加载；而这段表达式本身又是模板字符串，反斜杠转义会被那一层吃掉。
  // 故用两个字符判据 + fromCharCode，把三个坑一起绕开（实测每一种都踩过一次）。
  leakedMarkers: document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText
    .split(String.fromCharCode(10))
    .filter(function (l) { return l.indexOf('gated') >= 0 && l.indexOf('<') >= 0 }).length,
}))()`)
check(
  'F 受限区段画成带锁的区段（锁标记 + 底色行 + 结束边，且**不残留任何标记字面量**）',
  gateInfo.gates.length >= 1 &&
    gateInfo.gatedLines >= 1 &&
    gateInfo.endLines >= 1 &&
    gateInfo.leakedMarkers === 0 &&
    gateInfo.gates.some((t) => t.includes('仅组织成员')),
  JSON.stringify(gateInfo),
)
await shot('01-live-mode')

/* ------------------------------ G/H. 块级权限：报档位 + 改档位 + 撤销 ------------------------------ */

// 光标进入「仅组织内」那一段 ⇒ 锁按钮报出该段档位（clickLine 会用这个判据自校验）
const tierProbe = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('段落权限：'))
  return b?.getAttribute('aria-label') === '段落权限：仅组织成员'
})()`
await clickLine('ORGSEG7788', tierProbe)
const tierLabel = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('段落权限：'))
  return b ? b.getAttribute('aria-label') : null
})()`)
check('G 光标进入受限段落后，锁按钮报出这一段档位', tierLabel === '段落权限：仅组织成员', JSON.stringify(tierLabel))
// 基准正文（源码口径）——必须在打开锁菜单之前读，理由见下面那段注释
const beforeSrc = await readSourceText()

// 打开锁菜单改档位：改为「跟随页面档位」
await clickButton('段落权限')
await sleep(400)
const menuItems = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)`)
check('H0 锁菜单列出三档（跟随页面 / 仅组织成员 / 需单独授权）', menuItems.length >= 3 && menuItems.some((t) => t.includes('跟随页面档位')), JSON.stringify(menuItems.slice(0, 4)))

/*
 * ⚠️ 基准正文必须在**菜单打开之前**读：Radix 菜单是模态浮层，开着的期间工具栏按钮的
 * 点击会被它吞掉 —— 于是 `readSourceText()` 里的"切到源码"落空，读到的是**渲染后**的文本
 * （标记被隐藏 ⇒ 区段判定全成 'none'），后面的比对全部失真（实测踩到）。
 */
const beforeRegion = regionOfIn(beforeSrc, 'ORGSEG7788')
check('H0b 前置：选中的那一段此刻属于 org 区段', beforeRegion === 'org', beforeRegion)
const picked = await pickMenuItem('跟随页面档位')
check('H1a 能从锁菜单里选中「跟随页面档位」', picked === true)
await sleep(700)
const afterChange = await evaluate(`(() => ({
  gateCount: document.querySelectorAll('.gw-live-gate').length,
  status: [...document.querySelectorAll('[role="status"], [role="alert"]')].map((p) => p.textContent).join(' | '),
}))()`)
check(
  'H1 状态行如实说明改动',
  afterChange.status.includes('已把这一段改为'),
  JSON.stringify(afterChange),
)
/*
 * 正文（源码口径）必须真的变了，而且**只动标记、不动内容**：
 * 选中的那段脱离区段，**兄弟段落仍在区段里**（这正是"只改这一段"的语义），
 * 另一处 granted 区段一字未动，正文本身（两段受限文字与结尾）原样都在。
 */
const afterSrc = await readSourceText()
const afterRegion = regionOfIn(afterSrc, 'ORGSEG7788')
const siblingRegion = regionOfIn(afterSrc, '仅组织内可见')
const grantedKept = regionOfIn(afterSrc, 'GRANTSEG9900') === 'granted'
const contentKept = afterSrc.includes('ORGSEG7788') && afterSrc.includes('结尾同样是公开的。')
check(
  'H1b 只改了这一段的标记：它脱离区段、兄弟段落仍在区段里、granted 段与正文一字未动',
  afterRegion === 'none' && siblingRegion === 'org' && grantedKept && contentKept,
  JSON.stringify({ beforeRegion, afterRegion, siblingRegion, grantedKept, contentKept, lenBefore: beforeSrc.length, lenAfter: afterSrc.length }),
)

// 撤销：必须一次 ⌘Z 就能还原（userEvent: 'input' 的约定）
await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}).focus()`)
/*
 * ⚠️ 这里用 **Ctrl**（CDP modifiers 的 2），不是 Meta（4）：CodeMirror 的 `Mod-` 在
 * 非 macOS 平台就是 Ctrl，界面上写的也是「⌘/Ctrl+Z」。用 Meta 发过去在 Linux 上什么都不会发生
 * ——而且**看起来像通过**：正文没变，若判据是"撤销后与撤销前相同"就会假绿（实测踩到过）。
 */
await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
await sleep(700)
const afterUndo = await readSourceText()
const undoRegion = regionOfIn(afterUndo, 'ORGSEG7788')
check(
  'H2 ⌘Z 一次撤销即还原（标记回到原样）',
  undoRegion === 'org' && afterUndo === beforeSrc,
  JSON.stringify({ undoRegion, same: afterUndo === beforeSrc, lenBefore: beforeSrc.length, lenAfter: afterUndo.length }),
)
await shot('02-after-undo')

/* ------------------------------ I/J. 工具栏动作与源码模式 ------------------------------ */

/*
 * 选中一个词再加粗（**双击选词**）。
 *
 * 为什么不 Ctrl+A：那会把整篇文档包进一对 `**`，正文被改得面目全非，
 * 后续步骤的对比也跟着失真（实测：源码文本变成 `**# 混合可见性演示…**`）。
 * 双击是用户真的会做的动作，且断言可以精确到"那个词被包起来了"。
 */
const wordBox = await evaluate(`(() => {
  const line = [...document.querySelectorAll('.cm-line')].find((l) => (l.textContent ?? '').includes('结尾同样是公开的'))
  if (!line) return null
  line.scrollIntoView({ block: 'center' })
  const r = line.getBoundingClientRect()
  return { x: r.x + 12, y: r.y + r.height / 2 }
})()`)
if (wordBox === null) throw new Error('找不到「结尾同样是公开的」那一行')
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: wordBox.x, y: wordBox.y, button: 'left', clickCount: 2 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: wordBox.x, y: wordBox.y, button: 'left', clickCount: 2 })
await sleep(300)
await clickButton('加粗')
await sleep(600)
const bolded = await readSourceText()
check(
  'I 工具栏「加粗」把选中的词包进了 `**`（只动选区，不动全文）',
  /\*\*[^*\n]+\*\*/.test(bolded) && bolded.includes('结尾同样是公开的'),
  JSON.stringify(bolded.match(/\*\*[^*\n]+\*\*/g)?.slice(0, 3) ?? null),
)
await shot('03-bold')

// 切到源码模式：标记必须可见
await clickButton('源码')
await sleep(700)
const sourceText = await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText`)
check('J 切到源码模式后 `#` 与 gated 标记可见', sourceText.includes('#') && sourceText.includes('<!--gated:'), JSON.stringify(sourceText.slice(0, 80)))
await shot('04-source-mode')

// 切回实时渲染（确认模式可来回切且不重建编辑器）
await clickButton('实时渲染')
await sleep(600)
const backToLive = await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText`)
check('J2 切回实时渲染仍然生效（标记再次隐藏）', !backToLive.includes('<!--gated:'), JSON.stringify(backToLive.slice(0, 60)))

/* ------------------------------ K. 编辑页**没有**权限区 ------------------------------ */

/*
 * 作者要求：编辑页底部的「权限」区去掉（页面档位属于"这条目对谁可见"的治理动作，
 * 入口在页面自己的「权限」对话框里 —— 那里同时有例外授予与访问申请，是一处完整的界面）。
 * 因此这一条是**反向**断言：编辑页不得出现档位控件，且段落权限仍可用（下一条 G 已证明）。
 */
const perm = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
  return {
    section: document.querySelector('section[aria-labelledby="gw-permission-section-label"]') !== null,
    // 档位控件的"保存档位"按钮（VisibilitySection 独有）——不要把工具栏锁按钮的
    // 「这一段：跟随页面档位」算进来，那句是**编辑器**自己的文案，出现是对的
    hasTierSaveButton: buttons.includes('保存档位'),
    hasGrantsButton: buttons.includes('例外授予与访问申请'),
  }
})()`)
check(
  'K 编辑页底部**没有**权限区（不出档位控件、不出授予入口）',
  perm.section === false && perm.hasTierSaveButton === false && perm.hasGrantsButton === false,
  JSON.stringify(perm),
)
await shot('05-no-permission-section')

/* --------------------- L0. 段落授权：编辑器的「授权给谁…」（★ 本批补的缺口） --------------------- */

/*
 * 背景：块档位第三档「需单独授权」= 默认谁都读不到，靠例外授予放人。
 * 曾经"授权名单"只在权限面板里；那一块移除后 granted 成了**设得出来却没人能授权**的死档。
 * 这一条走的是真链路：光标放进受限段 → 锁菜单 →「授权给谁…」→ 对话框列出该段与它的授权名单。
 */
await goto(`#/wiki/${slug}/edit`, 3000)
await dismissDraftDialog()
const grantProbe = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('段落权限：'))
  return b?.getAttribute('aria-label') === '段落权限：需单独授权'
})()`
await clickLine('GRANTSEG9900', grantProbe)
check('L0a 光标落在「需单独授权」那一段（锁按钮报出该档位）', (await evaluate(grantProbe)) === true)
await clickButton('段落权限')
await sleep(400)
const grantEntry = await evaluate(
  `[...document.querySelectorAll('[role="menuitem"]')].some((i) => (i.textContent ?? '').includes('授权给谁'))`,
)
check('L0b 锁菜单里有「授权给谁…」入口', grantEntry === true)
if (grantEntry === true) {
  await pickMenuItem('授权给谁')
  await sleep(1500)
  const grantDialog = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    if (d === null) return null
    const t = d.innerText ?? ''
    return {
      title: t.includes('授权给谁'),
      // 段落摘要是"我在给哪一段授权"的第一凭据
      excerpt: t.includes('GRANTSEG9900'),
      hasAddButton: [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === '添加授权对象'),
      // 种子数据给这一段授了 alice（见 scripts/seed-demo.sh）
      listsGrant: t.includes('用户') && (t.includes('alice') || /\bid\b/.test(t)),
      hasForm: d.querySelector('#block-grant-kind') !== null || d.querySelector('select') !== null,
    }
  })()`)
  check(
    'L0c 对话框打开且显示**这一段**（摘要 + 授权名单 + 添加入口）',
    grantDialog !== null && grantDialog.title && grantDialog.excerpt && grantDialog.hasAddButton,
    JSON.stringify(grantDialog),
  )
  // 真打开一次表单：这是"能选择授权给谁"的可见凭据（字段齐 + 有可访问名称）
  await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '添加授权对象')
    b?.click()
    return true
  })()`)
  await sleep(400)
  const form = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const labels = [...d.querySelectorAll('label')].map((l) => l.textContent.trim())
    // 表单 id 带块 id 前缀 ⇒ 按后缀找（别写死某一个块的 id，也别在这层模板串里用反引号）
    const subject = [...d.querySelectorAll('select')].find((x) => x.id.endsWith('-subject')) ?? null
    return {
      labels,
      selects: d.querySelectorAll('select').length,
      inputs: d.querySelectorAll('input').length,
      confirm: [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === '确认添加'),
      // 「授权给谁」到底是选择还是手填：演示管理员**能**列名单 ⇒ 必须是选择，且列出真实的人
      subjectIsSelect: subject !== null,
      subjectOptions: subject ? [...subject.options].map((o) => o.textContent.trim()) : [],
      explainsId: (d.innerText ?? '').includes('users.id') || (d.innerText ?? '').includes('账号 id'),
    }
  })()`)
  check(
    'L0e 管理员看到的是**成员选择**（不是让人猜数字 id），且页面解释了 id 是什么',
    form.subjectIsSelect === true && form.subjectOptions.length >= 2 && form.explainsId === true,
    JSON.stringify({ isSelect: form.subjectIsSelect, options: form.subjectOptions.slice(0, 6), explainsId: form.explainsId }),
  )
  check(
    'L0d 「添加授权对象」表单字段齐备（类别 / 授权对象 / 角色 / 到期 + 确认）',
    form.confirm &&
      // 三个 select（类别 / 授权对象 / 角色）+ 至少一个 input（到期时间）；
      // 授权对象在**有名单时是 select**、没名单时才是 input —— 两种情况都算齐备
      form.selects >= 2 &&
      form.inputs >= 1 &&
      (form.subjectIsSelect || form.inputs >= 2) &&
      form.labels.some((l) => l.includes('授权对象类别')) &&
      form.labels.some((l) => l.includes('授权给谁') || l.includes('授权给哪个用户组')) &&
      form.labels.some((l) => l.includes('授予角色')) &&
      form.labels.some((l) => l.includes('到期时间')),
    JSON.stringify(form),
  )
  await shot('06b-block-grants')
  await clickDialogButton('取消')
  await sleep(300)
  await clickDialogButton('关闭')
  await sleep(500)
}

/* ------------------------------ L. 按访客视角预览 ------------------------------ */
// 先重新加载一次：本段只关心"预览对话框本身"，不该受前面几步在编辑区留下的改动影响
await goto(`#/wiki/${slug}/edit`, 3000)
await dismissDraftDialog()
await clickButton('按访客视角预览')
await sleep(700)
const dialog = await evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  return d ? { text: d.textContent.slice(0, 200), hasAudience: !!d.querySelector('[aria-label="预览视角"]') } : null
})()`)
check('L1 「按访客视角预览」对话框打开且含视角切换', dialog !== null && dialog.hasAudience === true, JSON.stringify(dialog?.text?.slice(0, 80)))
await clickButton('匿名访客')
await sleep(800)
const masked = await evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  return d ? {
    text: d.textContent,
    placeholder: d.innerHTML.includes('🔒'),
    leaked: d.innerHTML.includes('ORGSEG7788'),
  } : null
})()`)
check(
  'L2 匿名视角下受限段落变成占位文案，且受限内容不出现在对话框里',
  masked !== null && masked.placeholder === true && masked.leaked === false && masked.text.includes('段内容被遮蔽'),
  JSON.stringify(masked === null ? null : { placeholder: masked.placeholder, leaked: masked.leaked }),
)
await shot('06-audience-anonymous')
await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭'); c?.click(); return true })()`)
await sleep(400)

/* ------------------------------ M. 旧深链 ------------------------------ */
await goto('#/access/mixed-visibility', 3000)
await dismissDraftDialog()
const legacy = await evaluate(`(() => ({
  hash: location.hash,
  dialog: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 120) ?? null,
}))()`)
check(
  'M 旧深链 #/access/<slug> 跳到该页的权限对话框（?access=1）',
  legacy.hash.includes(`/wiki/${slug}`) && legacy.hash.includes('access=1') && (legacy.dialog ?? '').includes('权限'),
  JSON.stringify(legacy),
)

/*
 * ★ 作者要求：权限对话框里**去掉块级授权**。段落档位就是正文里的标记（在编辑器里改），
 * 逐块授权名单要先把某段标成 granted 才有意义，留在弹窗里只会让它更长。
 * 这里断言弹窗内容里既没有"内容块"分区，也没有块级授权的标题。
 */
const dialogSections = await evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const t = d ? (d.innerText ?? '') : ''
  const buttons = d ? [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) : []
  return {
    // 判据用**面板里真的有哪几块**：档位卡的「保存档位」、授权区、申请区
    hasTier: buttons.includes('保存档位') || t.includes('页面档位'),
    hasGrants: t.includes('例外授予') || t.includes('授权名单') || t.includes('授权'),
    hasRequests: t.includes('申请'),
    // 块级分区独有：内容块清单的标题与"逐块授权"的说明
    hasBlocks: t.includes('内容块') || t.includes('逐块') || t.includes('块级授权'),
  }
})()`)
check(
  'M2 权限对话框 = 档位 + 授予 + 申请，**没有**块级授权',
  dialogSections.hasTier && dialogSections.hasGrants && dialogSections.hasRequests && dialogSections.hasBlocks === false,
  JSON.stringify(dialogSections),
)
await shot('07-legacy-deeplink')

/* --------------------- M3–M5. 页面级例外授予：**能下拉选人**（★ 作者反馈） --------------------- */

/*
 * ★ 作者反馈："权限按钮进去那个页面的还不能下拉选择用户"。
 *
 * 名单端点 `GET /api/org/members|groups` 放宽为"任何登录用户可读"之后，**编辑器**那一份
 * 授权表单改成了下拉选人，而**页面「权限」对话框**里的「例外授予（页级）」还是手填「对象 id」，
 * 旁边甚至留着放宽之前的理由（"成员/组列表需要组织管理员权限，本页不拉取它"）—— 这条理由已过期。
 * 现在两处共用同一份字段（`components/access/GrantTargetFields.tsx`），所以这一节验的正是
 * "同一个问题不会只修一处"。放在 M 之后是因为此刻对话框已经开着（省一次导航，也顺带证明
 * 深链进来就是这条路）。
 *
 * ⚠️ 别在这里点「添加授权」：那是**提交**按钮（`GrantsSection` 的表单是常驻的，没有"展开"这一步），
 * 点下去会拿空 id 提交并留下一条校验错误 —— 本节只读，不写任何数据。
 */
const pageGrantForm = await evaluate(`(() => {
  const subject = document.querySelector('#page-grant-subject')
  const label = document.querySelector('label[for="page-grant-subject"]')?.textContent ?? null
  const dialogText = document.querySelector('[role="dialog"]')?.innerText ?? ''
  return {
    label,
    tag: subject === null ? null : subject.tagName,
    options: subject !== null && subject.tagName === 'SELECT' ? [...subject.options].map((o) => o.textContent) : null,
    // 手填那一支的特征：一个输入框（放宽之后**不该**再是它）
    plainInput: subject !== null && subject.tagName === 'INPUT',
    // 放宽之前的那条理由：一个字都不该再出现在界面里
    staleReason:
      dialogText.includes('本页不拉取它') ||
      dialogText.includes('成员/组列表需要组织管理员权限') ||
      dialogText.includes('列表需要组织管理员权限'),
  }
})()`)
check(
  'M3 页面级「例外授予」的授权对象是**成员下拉**（不是让人手输 id）',
  pageGrantForm.tag === 'SELECT' &&
    pageGrantForm.plainInput === false &&
    Array.isArray(pageGrantForm.options) &&
    pageGrantForm.options.some((o) => o.includes('——')) &&
    pageGrantForm.options.some((o) => o.includes('admin@example.com')),
  JSON.stringify(pageGrantForm),
)
check(
  'M4 字段标签是「授权给谁」，且"本页不拉取名单"那条过期理由不再出现',
  pageGrantForm.label === '授权给谁' && pageGrantForm.staleReason === false,
  JSON.stringify({ label: pageGrantForm.label, staleReason: pageGrantForm.staleReason }),
)
const pageGrantPicked = await evaluate(`(() => {
  const subject = document.querySelector('#page-grant-subject')
  if (subject === null || subject.tagName !== 'SELECT') return null
  const opt = [...subject.options].find((o) => o.value !== '')
  if (opt === undefined) return null
  subject.value = opt.value
  subject.dispatchEvent(new Event('change', { bubbles: true }))
  return { value: subject.value, text: opt.textContent }
})()`)
check(
  'M5 选中成员后控件值是数字 id（判定侧逐字比对的就是它，名字只是标签）',
  pageGrantPicked !== null && /^[0-9]+$/.test(pageGrantPicked.value),
  JSON.stringify(pageGrantPicked),
)
await shot('08-page-grant-dropdown')

/* ---------- P. 实时渲染的**块级渲染**（表格 / 代码块 / 整块 HTML / 分隔线） ---------- */

/*
 * ★ 作者反馈：「当前实时预览部分无法渲染」（`#/wiki/home/edit`）。
 *
 * 此前实时渲染只藏行内标记，表格、围栏代码块、整块 HTML 一律按源码显示（只给底色）。
 * 现在这几类整块画成成品的样子（`.gw-live-block`，内容走阅读页同一条 `mdToHtml` 管线）。
 *
 * 为什么在这一节里**亲手打一个代码块 + 一张表格**、而不是读现成的演示页：
 * ① 演示页里没有任何一个代码块落在受限区段内，而"整块被 widget 替换后权限底纹跟着丢"
 * 正是最该钉住的一条 —— 丢了就是**静默的权限提示消失**（比不渲染危险得多）；
 * ② 表格是作者这次点名的第一样东西，而它只有在**别的页面**（`architecture`）里才有，
 * 验收脚本不该依赖第二个 slug，索性打一张进去。
 * 打完验完再用 ⌘Z 撤回，演示数据一字不动（顺带证明：装饰与点击都**没有**往撤销栈里塞东西）。
 */
await goto(`#/wiki/${slug}/edit`, 3200)
await dismissDraftDialog()
await caretToDocEnd()
const blockP0 = await evaluate(`(() => ({
  blocks: document.querySelectorAll('[data-gw-live-block]').length,
  dirty: (document.body.innerText ?? '').includes('有未保存的改动'),
}))()`)
check('P0 前置：这一页本身不含渲染块，且此刻没有未保存改动', blockP0.blocks === 0 && blockP0.dirty === false, JSON.stringify(blockP0))

// 把光标放到「仅组织成员」区段的**最后一行**（该段唯一标记 ORGSEG7788 所在行），在区段内插入代码块 + 表格
await clickLine('ORGSEG7788')
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
await sleep(200)
await send('Input.insertText', {
  text: '\n\n```ts\nconst gated = 1\n```\n\n| 层 | 职责 |\n| --- | --- |\n| core | 类型与契约 |\n| manager | 插件生命周期 |',
})
await sleep(600)
await caretToDocEnd()

const blockProbe = await evaluate(`(() => {
  const el = document.querySelector('[data-gw-live-block="code"]')
  if (el === null) return null
  const code = el.querySelector('pre code')
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return {
    kind: el.dataset.gwLiveBlock,
    className: el.className,
    code: code === null ? null : code.textContent,
    lang: code === null ? null : code.className,
    gated: el.classList.contains('gw-live-gated-line'),
    fenceLeaked: (document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText ?? '').includes('\`\`\`'),
    x: r.x + Math.min(40, r.width / 2),
    y: r.y + Math.min(16, r.height / 2),
  }
})()`)
check(
  'P1 围栏代码块整块画成渲染块（pre>code + 语言类名，正文里不再有 ``` 围栏）',
  blockProbe !== null && blockProbe.kind === 'code' && blockProbe.code === 'const gated = 1\n' && String(blockProbe.lang).includes('language-ts') && blockProbe.fenceLeaked === false,
  JSON.stringify(blockProbe),
)
check(
  'P2 渲染块带上了所在受限区段的底纹类名（整块被替换 ≠ 权限提示消失）',
  blockProbe !== null && blockProbe.gated === true,
  JSON.stringify(blockProbe === null ? null : { className: blockProbe.className }),
)

// 表格：画成真 `<table>`（表头 + 数据行都在），且不再有 `| --- |` 这类源码
const tableProbe = await evaluate(`(() => {
  const el = document.querySelector('[data-gw-live-block="table"]')
  if (el === null) return null
  const t = el.querySelector('table')
  return {
    rows: t === null ? 0 : t.querySelectorAll('tr').length,
    th: t === null ? 0 : t.querySelectorAll('th').length,
    firstCell: t === null ? null : (t.querySelector('th')?.textContent ?? null),
    inMdBody: el.classList.contains('md-body'),
    pipeLeaked: (document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText ?? '').includes('| --- |'),
  }
})()`)
check(
  'P2b 表格整块画成真 <table>（3 行 / 2 表头，源码里的 | --- | 不再出现）',
  tableProbe !== null && tableProbe.rows === 3 && tableProbe.th === 2 && tableProbe.firstCell === '层' && tableProbe.inMdBody === true && tableProbe.pipeLeaked === false,
  JSON.stringify(tableProbe),
)
await shot('09-block-render-gated')

// 点渲染块 ⇒ 回到源码
await clickAt(blockProbe.x, blockProbe.y)
const afterBlockClick = await evaluate(`(() => ({
  // 判据是**被点的那一块**的 widget 消失（不是"整页一个 widget 都不剩"：
  // 这一节里同时插了代码块与表格，点代码块时表格仍该是渲染态）
  codeWidget: document.querySelector('[data-gw-live-block="code"]') !== null,
  tableWidget: document.querySelector('[data-gw-live-block="table"]') !== null,
  source: (document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText ?? '').includes('const gated = 1'),
}))()`)
check(
  'P3 点击渲染块 ⇒ 只有它回到源码（代码块 widget 消失、源码可见；表格仍是渲染态）',
  afterBlockClick.codeWidget === false && afterBlockClick.source === true && afterBlockClick.tableWidget === true,
  JSON.stringify(afterBlockClick),
)

// 撤销一次即撤回插入 ⇒ 正文里不该再有任何探针内容
await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}).focus()`)
/*
 * ⚠️ 用 **Ctrl**（CDP modifiers 的 2），不是 Meta（4）—— 理由与后果见 H2 上方那段注释：
 * Linux 上 Meta+Z 什么都不会发生，而"撤销后正文还带着探针"能被误读成"符合预期"。
 *
 * 判据也**不能**用状态行的「有未保存的改动」：草稿自动保存（900ms 防抖）之后那句话会被
 * 换成「草稿已自动保存（…）」，于是"脏"与"已保存"在文本上不可区分（本批实测踩到）。
 * 这里改成**看正文**：一次撤销之后探针字符串必须整段消失，区段原文必须回来。
 */
await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
await sleep(1000)
const afterBlockUndo = await evaluate(`(() => {
  const text = document.querySelector(${JSON.stringify(EDITOR_SEL)}).innerText ?? ''
  return {
    hasProbe: text.includes('const gated = 1') || text.includes('| --- |'),
    regionIntact: text.includes('ORGSEG7788') && text.includes('这一段是仅组织内可见的'),
  }
})()`)
check(
  'P4 ⌘Z 一次撤回插入（装饰与点击都没往撤销栈里塞东西）',
  afterBlockUndo.hasProbe === false && afterBlockUndo.regionIntact === true,
  JSON.stringify(afterBlockUndo),
)

/* ------------------------------ N. 控制台/网络 ------------------------------ */
const bad = events.filter((e) => {
  const text = e.text ?? ''
  if (consoleWhitelist.some((re) => re.test(text))) return false
  // `dialog` 是本脚本**自己接受**的「未保存就离开」确认（见 javascriptDialogOpening 分支），
  // 它证明那道防线在起作用，不算缺陷
  if (e.kind === 'dialog') return false
  return true
})
const dialogs = events.filter((e) => e.kind === 'dialog').length
check(
  'N 全程无控制台 error / 无 4xx-5xx',
  bad.length === 0,
  bad.map((b) => `${b.kind}${b.status ? `:${b.status}` : ''}:${(b.text ?? '').slice(0, 120)}`).join(' ; ') ||
    `（另有 ${dialogs} 次「未保存就离开」确认，已按用户意图接受）`,
)

/* ------------- O. 普通成员（非管理员）也能看到名单并选择授权对象 ------------- */

/*
 * 作者要求："让登录用户都可以看到名单"。
 *
 * 这一条是**非管理员**视角的真验证：以演示成员 alice 登录（她对该公开页有 canEdit），
 * 打开同一段落的「授权给谁…」，断言选择框里真的列出了成员 —— 若名单仍是 admin-only，
 * 这里会退化成"手填 id"的输入框，本条就会红。
 *
 * 放在最后：前面的步骤都按管理员身份跑，登录态在这里才切换。
 */
const eventsBeforeMember = events.length
await evaluate(`(async () => {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-gw-csrf': '1' } })
  return true
})()`)
await sleep(400)
const memberLogin = await evaluate(`(async () => {
  const r = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-csrf': '1' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'Demo-Member-2026' }),
  })
  const body = await r.json().catch(() => null)
  return { status: r.status, email: body?.user?.email ?? null, orgRole: body?.user?.orgRole ?? null }
})()`)
check(
  'O1 以普通成员（非管理员）登录成功',
  memberLogin.status === 200 && memberLogin.orgRole === 'member',
  JSON.stringify(memberLogin),
)
await goto(`#/wiki/${slug}/edit`, 3500)
await dismissDraftDialog()
const memberCanEdit = await evaluate(`document.querySelector(${JSON.stringify(EDITOR_SEL)}) !== null`)
check('O2 普通成员可以打开这一页的编辑器（公开+已发布 ⇒ 登录用户可编辑）', memberCanEdit === true)
if (memberCanEdit === true) {
  const probe = `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('段落权限：'))
    return b?.getAttribute('aria-label') === '段落权限：需单独授权'
  })()`
  await clickLine('GRANTSEG9900', probe)
  await clickButton('段落权限')
  await sleep(400)
  await pickMenuItem('授权给谁')
  await sleep(1500)
  await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '添加授权对象')
    b?.click()
    return true
  })()`)
  await sleep(500)
  const memberView = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    if (d === null) return null
    const subject = [...d.querySelectorAll('select')].find((x) => x.id.endsWith('-subject')) ?? null
    const t = d.innerText ?? ''
    return {
      isSelect: subject !== null,
      options: subject ? [...subject.options].map((o) => o.textContent.trim()) : [],
      // 没权限时的降级文案不得出现（出现了说明名单仍被挡住）
      saysForbidden: t.includes('没有组织管理员权限'),
    }
  })()`)
  check(
    'O3 普通成员看到的是成员名单选择（不是手填 id）',
    memberView !== null && memberView.isSelect === true && memberView.options.length >= 3 && memberView.saysForbidden === false,
    JSON.stringify(memberView),
  )
  await shot('08-member-grants')
  await clickDialogButton('取消')
  await sleep(200)
  await clickDialogButton('关闭')
  await sleep(300)
  const memberEvents = events.slice(eventsBeforeMember).filter((e) => e.kind !== 'dialog')
  check(
    'O4 成员视角这一段没有新的控制台 error / 4xx',
    memberEvents.length === 0,
    memberEvents.map((e) => `${e.kind}${e.status ? `:${e.status}` : ''}:${(e.text ?? '').slice(0, 100)}`).join(' ; '),
  )
}

/* ------------------------------ 汇总 ------------------------------ */
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(`${OUT_DIR}/editor-modes-cdp.out.json`, JSON.stringify({ pageUrl, slug, results, events }, null, 2))
console.log(`\n结果：${Object.keys(results).length - failures.length}/${Object.keys(results).length} 通过`)
console.log(`截图：${OUT_DIR}/shots/  明细：${OUT_DIR}/editor-modes-cdp.out.json`)
// 收尾：关掉本次新建的页面（不给下一次运行留一条占住 target 的会话）
await browserSend('Target.closeTarget', { targetId })
ws.close()
browserWs.close()
process.exit(failures.length === 0 ? 0 : 1)
