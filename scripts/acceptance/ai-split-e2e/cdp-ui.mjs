/**
 * AI 拆分验收（**UI 侧**）：验证「AI 界面是插件插入的」这件事在**真浏览器**里成立。
 *
 * 与同目录 `run.mjs` 的分工：`run.mjs` 验后端契约（502/503、SSE 帧、提示词、权限），
 * 本脚本验**只有浏览器能证的东西**：
 *   1. 问答面板的 DOM **来自插件 bundle**（`[data-slot="wiki-ask"]` 里有 `.ask-card`），
 *      宿主自己的代码里一个 `.ask-*` 节点都不产（本批把面板从 web 删掉了）；
 *   2. **入口按钮的可见性判据是"声明 + 仲裁"，不是"组件已加载"** ——
 *      懒加载插槽下用后者判会自锁（按钮永远不出现，除非它已经出现过）。本脚本先确认
 *      按钮存在时 `client.js` **还没被请求过**，再确认进入视图后它才出现；
 *   3. 首屏**零 AI bundle 请求**，编辑页/问答页才加载（懒加载真的生效）；
 *   4. 工具条在编辑页渲染，写回按钮真的写进正文（跨边界回调）。宿主自带编辑器是
 *      **CodeMirror 6**，正文在 `.cm-content`（contenteditable）里 —— **全仓没有 `<textarea>`**，
 *      按 textarea 找会得到"编辑器没内容"这种假产品缺陷；
 *   5. **停用插件不需要重建 web**：入口消失 + 宿主中性占位（无 AI 文案、不点名插件）。
 *      注意**不能**用 `POST /api/plugins/:name/disable` 验这条：内置插件在基础层清单里，
 *      disable 返回 **409 `base_layer`**（会话层才是热层）。本脚本改为**改清单 + 重启进程**，
 *      并比对**产物指纹**（`web/dist/index.html` 与两个插件 bundle 的 SHA-256 前 12 位）——
 *      要证的是"产物与宿主代码一个字都没变"，重启与这个断言无关。
 *
 * 用法：CHROME=/usr/bin/google-chrome node scripts/acceptance/ai-split-e2e/cdp-ui.mjs
 *      （`CHROME` 缺省指向 `/usr/bin/chromium`，本机没有就显式指定；也可用
 *        `AI_SPLIT_UI_PORT` / `AI_SPLIT_UI_CDP_PORT` / `AI_SPLIT_UI_MOCK_PORT` 换端口）
 * 前置：**必须先 `pnpm --filter @geewiki/web build`**（`packages/web/dist` 是上一版时，
 *      测的是旧宿主 —— 症状是"没有 `[data-slot="wiki-ask"]`"）；插件产物见 `build:plugin-ui`。
 * 落地：实例与数据在 `os.tmpdir()` 下的临时目录里（跑完即删），Chrome profile 落在
 *      `data/verify/ai-split-e2e/chrome-profile-ui`（`data/` 已 gitignore）。
 * 输出：stdout 一份 JSON（19 条 checks + notes）；退出码 0 = 全部通过。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { startMockUpstream, ANSWER as MOCK_ANSWER } from './mock-upstream.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const PORT = Number(process.env.AI_SPLIT_UI_PORT ?? 3435)
const CDP_PORT = Number(process.env.AI_SPLIT_UI_CDP_PORT ?? 9540)
const CHROME = process.env.CHROME ?? '/usr/bin/chromium'
const PROFILE = join(REPO, 'data/verify/ai-split-e2e/chrome-profile-ui')
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'e2e-ui-break-glass-token'
const EMAIL = 'owner@e2e-ui.test'
const PASSWORD = 'E2e-Owner-2026-pw'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const out = { checks: [], notes: {} }
function check(name, ok, detail) {
  out.checks.push({ name, ok: ok === true, detail: detail === undefined ? undefined : String(detail).slice(0, 400) })
}

/** 产物指纹：证明"入口消失"不是重建 web 换来的 */
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
const WEB_INDEX = join(REPO, 'packages/web/dist/index.html')
const QA_BUNDLE = join(REPO, 'packages/web/public/plugins-ui/@geewiki/ai-qa/client.js')
const ASSIST_BUNDLE = join(REPO, 'packages/web/public/plugins-ui/@geewiki/ai-assist/client.js')

const MOCK_PORT = Number(process.env.AI_SPLIT_UI_MOCK_PORT ?? 3467)
const mock = await startMockUpstream(MOCK_PORT)

const root = mkdtempSync(join(tmpdir(), 'geewiki-ai-ui-'))
// 隔离实例的清单要写进 <root>/config/ —— 该目录不存在时 writeFileSync 直接 ENOENT
mkdirSync(join(root, 'config'), { recursive: true })
writeFileSync(
  join(root, 'config/plugins.base.json'),
  JSON.stringify(
    {
      enabled: [
        { name: '@geewiki/db-sqlite' },
        { name: '@geewiki/http' },
        { name: '@geewiki/auth' },
        { name: '@geewiki/org' },
        { name: '@geewiki/authz' },
        { name: '@geewiki/wiki' },
        { name: '@geewiki/search' },
        { name: '@geewiki/llm' },
        { name: '@geewiki/openai' },
        { name: '@geewiki/ai-assist' },
        { name: '@geewiki/ai-qa' },
      ],
    },
    null,
    2,
  ),
)

// 本仓库没有"先 build 再跑 dist"这一步：服务端从 src 直接经 tsx 起（与 run.mjs 一致）
const SERVER_ENV = {
  ...process.env,
  GEEWIKI_CONFIG_DIR: join(root, 'config'),
  GEEWIKI_DATA_DIR: join(root, 'data'),
  // 端口变量名是 GEEWIKI_PORT（不是 PORT）——写错的后果不是"端口不对"，而是
  // 它去抢默认端口 3000（那里有个不属于本脚本的实例）⇒ EADDRINUSE ⇒ 启动失败
  GEEWIKI_PORT: String(PORT),
  // 外部插件目录指向空目录：注册表里只留内置插件，读数才可复现
  GEEWIKI_PLUGINS_DIR: join(root, 'plugins'),
  GEEWIKI_PLUGIN_UI_DIST: join(REPO, 'packages/web/public'),
  GEEWIKI_ADMIN_TOKEN: ADMIN_TOKEN,
}
let server = spawn('node', ['--import', 'tsx', 'packages/server/src/index.ts'], {
  cwd: REPO,
  env: SERVER_ENV,
  stdio: ['ignore', 'pipe', 'pipe'],
})
mkdirSync(join(root, 'plugins'), { recursive: true })
const serverLog = []
server.stdout.on('data', (c) => serverLog.push(String(c)))
server.stderr.on('data', (c) => serverLog.push(String(c)))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,1100',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws = null
let reported = false
async function shutdown(code) {
  // 无论走到哪一步，都把已经攒下的 checks/notes 打出来 —— 半途退出时这份 JSON 就是唯一的线索
  if (!reported) {
    reported = true
    console.log(JSON.stringify(out, null, 2))
  }
  try {
    ws?.close()
  } catch {}
  server.kill('SIGTERM')
  mock.server.close()
  chrome.kill('SIGTERM')
  await sleep(600)
  server.kill(9)
  chrome.kill(9)
  rmSync(root, { recursive: true, force: true })
  try {
    rmSync(PROFILE, { recursive: true, force: true })
  } catch {}
  process.exit(code)
}
process.on('uncaughtException', (e) => {
  out.error = String(e?.stack ?? e)
  shutdown(1)
})
process.on('unhandledRejection', (e) => {
  out.error = String(e?.stack ?? e)
  shutdown(1)
})

/* ---- 等待服务与 CDP ---- */
async function waitForServer(timeoutMs = 40_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/api/health`)).status === 200) return true
    } catch {}
    await sleep(300)
  }
  return false
}
async function waitForCdp(timeoutMs = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(300)
  }
  return null
}

const serverUp = await waitForServer()
out.notes.serverUp = serverUp
if (!serverUp) {
  out.notes.serverLog = serverLog.join('').slice(-1500)
  shutdown(1)
}
const wsUrl = await waitForCdp()
out.notes.cdp = wsUrl !== null
if (!wsUrl) {
  out.notes.chromeHint = `找不到 CDP（${CDP_PORT}）。CHROME=${CHROME} 存在=${existsSync(CHROME)}`
  shutdown(1)
}

/* ---- CDP 客户端 ---- */
ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws error'))
})
let seq = 0
const pending = new Map()
const consoleErrs = []
const network = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrs.push(`exception: ${String(m.params.exceptionDetails?.text ?? '').slice(0, 160)}`)
  }
  if (m.method === 'Network.requestWillBeSent') {
    network.push(String(m.params.request.url ?? ''))
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`evaluate 异常: ${r.exceptionDetails.text}`)
  return r.result.value
}
/** 轮询直到表达式为真（或超时）—— 比固定 sleep 稳，且快得多 */
async function until(expr, timeoutMs = 15_000) {
  const t0 = Date.now()
  for (;;) {
    const v = await evaluate(expr)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(200)
  }
}

/*
 * 两条"看起来是产品缺陷、其实是浏览器语义"的坑，都在这段准备里：
 * ① SPA 的会话态是**开机时**探测一次（`/api/session`）——在页面里 fetch 登录之后不重载，
 *    界面仍是匿名（编辑视图会显示"需要先登录"，工具条自然也无从挂起）；
 * ② 基础层插件不能热停用（见上面清单的注释）。
 */
/* ---- 准备：登录 + 一篇可问答/可编辑的页面 ---- */
out.notes.login = await j('POST', '/api/auth/setup', { email: EMAIL, password: PASSWORD, displayName: 'E2E UI' })
async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-gw-admin-token': ADMIN_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
// 用**浏览器自己的会话**写页面（宿主与插件都只看 cookie）
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${BASE}/#/wiki` })
await sleep(2_000)
out.notes.setupInPage = await evaluate(`(async () => {
  const s = await fetch('/api/auth/setup', { method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)}, displayName: 'E2E UI' }) })
  const l = await fetch('/api/auth/login', { method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} }) })
  const p = await fetch('/api/pages/ui-e2e', { method: 'PUT', headers: {'content-type':'application/json','x-gw-csrf':'1'},
    body: JSON.stringify({ title: '检索增强问答', content: '检索增强问答先用全文检索召回相关片段，再交给模型生成带 [1] 引用的答案。本段用于浏览器侧验收。' }) })
  return { setup: s.status, login: l.status, page: p.status }
})()`)
// 配好模型密钥（写进隔离 data 目录的 secrets.json）
out.notes.setKey = (
  await j('PUT', '/api/plugins/' + encodeURIComponent('@geewiki/llm') + '/config', {
    config: {
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      apiKey: 'sk-e2e-ui-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      model: 'mock-model',
      apiKeyEnv: '',
      reasoningEffort: '',
      contextWindow: 32000,
      maxOutputTokens: 1024,
      timeoutMs: 15000,
      includeUsage: true,
      extraBody: '',
    },
  })
).status

/* 会话层启用问答插件（真实用户就是走这条：管理台里点启用，不重启进程） */
out.notes.enableQa = await j('POST', '/api/plugins/' + encodeURIComponent('@geewiki/ai-qa') + '/enable', {})
/* 带上会话与新的入口表**重载一次**（SPA 的会话态与入口表都是开机时取的） */
await send('Page.navigate', { url: `${BASE}/#/wiki/list` })
await send('Page.reload', { ignoreCache: true })
await sleep(3_500)

/* ================= 1) 问答入口：声明可见性 + 懒加载 ================= */
network.length = 0
await send('Page.navigate', { url: `${BASE}/#/wiki/list` })
const ASK_BTN = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'AI 问答')`
await until(`!!${ASK_BTN}`, 12_000)
const listFacts = await evaluate(`(() => {
  const btn = ${ASK_BTN}
  const spans = [...document.querySelectorAll('span, small, .muted')].map((n) => n.textContent.trim())
  return {
    askBtnExists: !!btn,
    askBtnTitle: btn?.getAttribute('title') ?? null,
    neutralHint: spans.find((t) => t.includes('问答功能未启用')) ?? null,
    // 宿主此刻**不该**自己画任何问答 DOM（面板已随本批迁入插件）
    hostAskNodes: document.querySelectorAll('.ask-card, .ask-form').length,
  }
})()`)
check('1a 列表页出现「AI 问答」入口（判据是入口表的**声明**+仲裁，不是硬编码插件名）', listFacts.askBtnExists === true, JSON.stringify(listFacts))
check('1b 入口存在时插件 bundle **尚未**被请求（懒加载 + 声明判据，不自锁）',
  network.filter((u) => u.includes('plugins-ui/')).length === 0,
  JSON.stringify(network.filter((u) => u.includes('plugins-ui/'))))
check('1c 宿主不自行渲染问答面板（.ask-card/.ask-form 数量为 0）', listFacts.hostAskNodes === 0, JSON.stringify(listFacts))

/* ================= 2) 问答视图：面板由插件渲染 ================= */
await evaluate(`(() => { const b = ${ASK_BTN}; b?.click(); return !!b })()`)
await sleep(1_200)
out.notes.hashAfterClick = await evaluate(`location.hash`)
await send('Page.navigate', { url: `${BASE}/#/wiki/ask/检索增强` })
const outletOk = await until(
  `(() => { const o = document.querySelector('[data-slot="wiki-ask"]'); return o && o.querySelector('.ask-card') ? true : false })()`,
  20_000,
)
const askFacts = await evaluate(`(() => {
  const o = document.querySelector('[data-slot="wiki-ask"]')
  const input = o?.querySelector('.ask-input')
  return {
    outletExists: !!o,
    outletCount: o?.getAttribute('data-count') ?? null,
    hasCard: !!o?.querySelector('.ask-card'),
    hasInput: !!input,
    inputValue: input?.value ?? null,
    cssLoaded: [...document.styleSheets].some((s) => (s.href ?? '').includes('plugins-ui/@geewiki/ai-qa/client.css')),
    placeholderText: o?.textContent?.trim().slice(0, 60) ?? null,
    // 宿主里是否残留旧的 AI 模块（不该有）
    hasHostAskMarkup: !!document.querySelector('.ask-answer'),
  }
})()`)
check('2a 进入问答视图后 outlet 内出现插件面板（.ask-card 在 [data-slot=wiki-ask] 内）', outletOk === true, JSON.stringify(askFacts))
check('2b 面板的 css 作为独立样式表加载', askFacts.cssLoaded === true, JSON.stringify(askFacts))
check('2c 懒加载：bundle 是**进入视图后**才被请求的', network.some((u) => u.includes('plugins-ui/@geewiki/ai-qa/client.js')) === true, JSON.stringify(network.filter((u) => u.includes('plugins-ui/')).slice(0, 4)))
out.notes.askFacts = askFacts
/*
 * 诊断快照（本脚本第一次跑就是靠它定位到"驱动的是过期的 web 产物"）：
 * 入口表、outlet、以及 main 里的可见文本一起看，才能区分
 * "插件没渲染" / "宿主没给位置" / "浏览器里跑的根本是上一版构建"。
 */
out.notes.askDiag = await evaluate(`(() => {
  const main = document.querySelector('main') ?? document.body
  return {
    hash: location.hash,
    slots: [...document.querySelectorAll('[data-slot]')].map((n) => n.getAttribute('data-slot') + ':' + n.getAttribute('data-count')),
    mainText: main.textContent.replace(/\\s+/g, ' ').trim().slice(0, 180),
    uiTable: null,
  }
})()`)
const tbl = await j('GET', '/api/plugins/ui')
out.notes.askDiag.uiTable = JSON.stringify(tbl.body?.plugins ?? tbl.body).slice(0, 300)

/* ================= 3) 真点一次问答（走 SSE + host.renderMarkdown） ================= */
const submitted = await evaluate(`(() => {
  const o = document.querySelector('[data-slot="wiki-ask"]')
  if (!o) return { error: 'outlet 不存在（步骤 2 之后面板消失了）' }
  const input = o.querySelector('.ask-input')
  if (!input) return { error: '面板里没有 .ask-input' }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '什么是检索增强问答？')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const btn = [...o.querySelectorAll('button')].find((b) => b.type === 'submit' || /提问|提问|搜索|问/.test(b.textContent))
  if (!btn) return { error: '找不到提交按钮' }
  btn.click()
  return { clicked: btn.textContent.trim() }
})()`)
out.notes.submitted = submitted
/*
 * 等的是**流结束**，不是"界面上出现了字"：面板在生成中就有占位文本与"生成中…"标记，
 * 用长度判据会在半截答案上就返回，后面的 markdown 断言于是随机看到残缺 DOM。
 */
const answered = await until(
  `(() => {
    const o = document.querySelector('[data-slot="wiki-ask"]')
    if (!o) return false
    const t = o.textContent ?? ''
    return t.includes(${JSON.stringify(MOCK_ANSWER.slice(0, 18))}) && !t.includes('生成中')
  })()`,
  25_000,
)
const answerFacts = await evaluate(`(() => {
  const o = document.querySelector('[data-slot="wiki-ask"]')
  if (!o) return { missing: true, text: 'outlet 不存在', hasBlockMarkdown: false, hasCitationText: false, sourceLink: null, leakedKey: false }
  const html = o.innerHTML
  return {
    text: o.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260),
    // 回答是否走了 markdown 渲染（宿主 host.renderMarkdown 的证据）：
    // 纯文本兜底只会得到一个文本节点，而 marked 会产出 p 等块级元素
    hasBlockMarkdown: !!o.querySelector('.ask-answer p, .ask-md p, .ask-answer ul, .ask-md ul'),
    hasCitationText: /\[1\]/.test(o.textContent ?? ''),
    // 参考资料：标题是真链接（由宿主 navigate 接管 hash 跳转）
    sourceLink: o.querySelector('.ask-source-title')?.getAttribute('href') ?? o.querySelector('a[href^="#/wiki/"]')?.getAttribute('href') ?? null,
    leakedKey: /sk-e2e-ui-key|sk-proj/.test(html),
  }
})()`)
check('3a 提问后渲染出回答（流式增量落到面板里）', answered === true, answerFacts.text)
check('3b 回答经 markdown 渲染（出现块级元素），且引用标记 [1] 原样可见', answerFacts.hasBlockMarkdown === true && answerFacts.hasCitationText === true, JSON.stringify(answerFacts).slice(0, 300))
/*
 * 参考资料**由宿主导航**（`host.navigate`）：插件不碰 `location`/hash（那会让路由出现两个主人）。
 * 所以这里不能用"有没有 href"判 —— 要点一下，看**宿主**的路由是否接住了这一跳。
 */
const hashBefore = await evaluate(`location.hash`)
await evaluate(`(() => {
  const o = document.querySelector('[data-slot="wiki-ask"]')
  const t = o?.querySelector('.ask-source-title')
  if (!t) return false
  t.click()
  return true
})()`)
await sleep(1_500)
const hashAfterSource = await evaluate(`location.hash`)
check(
  '3c 点参考资料由**宿主**导航到该页（插件不自己改 location）',
  hashAfterSource === '#/wiki/ui-e2e',
  `before=${hashBefore} after=${hashAfterSource} markup=${answerFacts.sourceLink}`,
)
check('3d 页面未泄漏密钥', answerFacts.leakedKey === false)

/* ================= 4) 编辑页：工具条由插件渲染 + 采纳写回宿主 ================= */
/*
 * 宿主自带的编辑器是 **CodeMirror 6**（不是 textarea，见 `components/MarkdownEditor.tsx`），
 * 正文住在 `.cm-content`（contenteditable，role=textbox）里。写回是否生效只能读那里。
 */
await send('Page.navigate', { url: `${BASE}/#/wiki/ui-e2e/edit` })
const editorReady = await until(`!!document.querySelector('.cm-content')`, 20_000)
const toolbarOk = await until(
  `(() => { const o = document.querySelector('[data-slot="editor-toolbar"]'); return !!o && o.children.length > 0 })()`,
  20_000,
)
const toolbarFacts = await evaluate(`(() => {
  const o = document.querySelector('[data-slot="editor-toolbar"]')
  const cm = document.querySelector('.cm-content')
  return {
    outletExists: !!o,
    buttons: o ? [...o.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled })) : [],
    cssLoaded: [...document.styleSheets].some((s) => (s.href ?? '').includes('plugins-ui/@geewiki/ai-assist/client.css')),
    docLength: (cm?.innerText ?? '').trim().length,
    hash: location.hash,
  }
})()`)
out.notes.toolbarFacts = toolbarFacts
out.notes.editorReady = editorReady
out.notes.editDiag = await evaluate(`(() => {
  const main = document.querySelector('main') ?? document.body
  return {
    hash: location.hash,
    text: (main.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 260),
    cm: !!document.querySelector('.cm-content'),
    textarea: !!document.querySelector('textarea'),
    slots: [...document.querySelectorAll('[data-slot]')].map((n) => n.getAttribute('data-slot') + ':' + n.getAttribute('data-count')),
    buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => t !== '').slice(0, 18),
  }
})()`)
check('4a 编辑页出现插件工具条（editor-toolbar 插槽出口里有插件自己的 DOM）', toolbarOk === true, JSON.stringify(toolbarFacts).slice(0, 300))
/*
 * 预览打开**之前**的正确形状：四个动作都在，且**没有选区时"改写选中/润色"必须禁用**
 * （它们没有输入可作用；留着可点的按钮点下去只会得到一句"请先选中"，那是把校验推给用户）。
 * "采纳"此刻**不该存在** —— 它属于预览态，提前出现等于让用户采纳一个还不存在的结果。
 */
check(
  '4b 工具条含四个动作，无选区时改写/润色禁用，且预览前不出现"采纳"',
  ['续写', '改写选中', '润色', '摘要'].every((t) => toolbarFacts.buttons.some((b) => b.t.includes(t))) &&
    toolbarFacts.buttons.filter((b) => b.t.includes('改写') || b.t.includes('润色')).every((b) => b.disabled === true) &&
    toolbarFacts.buttons.some((b) => /插入到光标处|替换选中|采纳/.test(b.t)) === false,
  JSON.stringify(toolbarFacts.buttons),
)

if (toolbarOk) {
  await evaluate(`(() => {
    const o = document.querySelector('[data-slot="editor-toolbar"]')
    const btn = [...o.querySelectorAll('button')].find((b) => b.textContent.includes('续写'))
    if (btn) btn.click()
    return !!btn
  })()`)
  /*
   * 预览用**原生 <dialog> + showModal()**：它画在 top layer 上，节点位置未必在插槽出口子树里，
   * 所以按钮一律按**整个文档**找（按 outlet 找会得到"按钮不存在"这种假阴性）。
   */
  /*
   * 写回按钮的**真实文案**是「插入到光标处」（有选区时「替换选中」），不是"采纳" ——
   * 用产品文案判据才不会误判（本脚本第一版就是按"采纳"找，得到假阴性）。
   */
  const APPLY_JS = `[...document.querySelectorAll('dialog button, button')].find((b) => /插入到光标处|替换选中|采纳/.test(b.textContent) && b.disabled === false)`
  const previewed = await until(`(() => !!${APPLY_JS})()`, 25_000)
  out.notes.previewDiag = await evaluate(`(() => {
    const dlg = document.querySelector('dialog')
    const all = [...document.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), d: b.disabled }))
    return {
      dialogOpen: !!dlg && dlg.open === true,
      dialogText: (dlg?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      applyButtons: all.filter((b) => /插入到光标处|替换选中|采纳/.test(b.t)),
      outletText: (document.querySelector('[data-slot="editor-toolbar"]')?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 160),
    }
  })()`)
  const before = await evaluate(`(document.querySelector('.cm-content')?.innerText ?? '').trim()`)
  out.notes.applyClicked = await evaluate(`(() => {
    const apply = ${APPLY_JS}
    if (apply) apply.click()
    return apply?.textContent.trim() ?? null
  })()`)
  await sleep(800)
  const after = await evaluate(`(document.querySelector('.cm-content')?.innerText ?? '').trim()`)
  check('4c 生成后弹出预览对话框且写回按钮可用', previewed === true, JSON.stringify(out.notes.previewDiag).slice(0, 260))
  check(
    '4d 写回按钮经宿主回调真的写进编辑器缓冲区（跨边界写回，且不发保存请求）',
    after.length > before.length && after.includes(MOCK_ANSWER.slice(0, 12)),
    `before=${before.length} after=${after.length}`,
  )
}

/* ================= 5) 停用插件不需要重建 web（改清单 + 重启进程） ================= */
/*
 * 为什么不走 `POST /api/plugins/:name/disable`：内置插件在基础层清单里，disable 会返回
 * **409 `base_layer`「请编辑 plugins.base.json 后重启」**（会话层才是热层，而这条守卫是刻意
 * 的 —— 卸载走的是绕过 disable() 的 deactivateCore，让基础层成员进卸载集合会把它静默改成
 * 会话层条目）。所以"停用不重建前端"这条只能这样证：
 * **改清单 + 重启进程**，而 web 与插件产物的指纹**逐字节不变**。
 */
const webBefore = { index: sha(WEB_INDEX), qa: sha(QA_BUNDLE), assist: sha(ASSIST_BUNDLE) }
out.notes.webBefore = webBefore
const cfgPath = join(root, 'config/plugins.base.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
cfg.enabled = (cfg.enabled ?? []).filter((e) => e.name !== '@geewiki/ai-qa')
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
// 会话层覆盖条目也要一起清掉（步骤 0 里用 API 启用过一次，它可能落在这里）
const sessPath = join(root, 'config/plugins.session.json')
if (existsSync(sessPath)) {
  const sess = JSON.parse(readFileSync(sessPath, 'utf8'))
  sess.enabled = (sess.enabled ?? []).filter((e) => e.name !== '@geewiki/ai-qa')
  writeFileSync(sessPath, JSON.stringify(sess, null, 2))
}
server.kill('SIGTERM')
await sleep(1_500)
server.kill(9)
await sleep(300)
out.notes.restarted = await new Promise((resolve) => {
  const next = spawn('node', ['--import', 'tsx', 'packages/server/src/index.ts'], {
    cwd: REPO,
    env: SERVER_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  next.stdout.on('data', (c) => serverLog.push(String(c)))
  next.stderr.on('data', (c) => serverLog.push(String(c)))
  server = next
  void waitForServer().then(resolve)
})
out.notes.webAfter = { index: sha(WEB_INDEX), qa: sha(QA_BUNDLE), assist: sha(ASSIST_BUNDLE) }
check('5a 重启后问答插件不再激活（入口表里没有它）', (await j('GET', '/api/plugins/ui')).body?.plugins?.['@geewiki/ai-qa'] === undefined)
check(
  '5a2 全程没有重建任何前端产物（web 与两个插件 bundle 的指纹逐字节不变）',
  out.notes.webAfter.index === webBefore.index &&
    out.notes.webAfter.qa === webBefore.qa &&
    out.notes.webAfter.assist === webBefore.assist,
  JSON.stringify({ before: webBefore, after: out.notes.webAfter }),
)
await send('Page.navigate', { url: `${BASE}/#/wiki/list` })
await send('Page.reload', { ignoreCache: true })
await sleep(3_500)
const disabledFacts = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'AI 问答')
  const hint = [...document.querySelectorAll('span,small,p')].find((n) => (n.textContent ?? '').includes('问答功能未启用'))
  return { askBtn: !!btn, neutralHint: !!hint }
})()`)
check(
  '5b 停用后入口消失并显示宿主中性提示（"问答功能未启用"）',
  disabledFacts.askBtn === false && disabledFacts.neutralHint === true,
  JSON.stringify(disabledFacts),
)
await send('Page.navigate', { url: `${BASE}/#/wiki/ask/x` })
await sleep(2_000)
const placeholder = await evaluate(`(() => {
  const main = document.querySelector('main') ?? document.body
  const t = (main.textContent ?? '').replace(/\\s+/g, ' ').trim()
  return { text: t.slice(0, 240), hasAskCard: !!document.querySelector('.ask-card'), mentionsPluginName: /ai-qa|@geewiki/.test(t) }
})()`)
check(
  '5c 停用后问答视图是宿主的中性占位（无插件面板、不点名任何插件）',
  placeholder.hasAskCard === false && placeholder.mentionsPluginName === false,
  placeholder.text,
)

check('5c 全程无 console error', consoleErrs.length === 0, consoleErrs.slice(0, 3).join(' | '))

out.passed = out.checks.filter((c) => c.ok).length
out.total = out.checks.length
reported = true
console.log(JSON.stringify(out, null, 2))
await shutdown(out.checks.every((c) => c.ok) ? 0 : 1)
