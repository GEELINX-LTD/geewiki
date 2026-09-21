#!/usr/bin/env node
/**
 * **块级归属（0024）的浏览器端到端验收** —— 零依赖：Node 内置 WebSocket + 直连 CDP。
 *
 * 用法：
 *   node scripts/acceptance/block-attribution-cdp.mjs <实例 URL> [cdpPort]
 *
 * 例：
 *   # 隔离实例（别拿仓库里那份 data/ 做验收）
 *   GEEWIKI_PORT=3111 GEEWIKI_DATA_DIR=tmp/verify-block-attr/data pnpm start
 *   node scripts/acceptance/block-attribution-cdp.mjs http://127.0.0.1:3111 9470
 *
 * ## 为什么必须有一层浏览器验收（`pnpm test` 覆盖不到的那几条）
 *
 * 单测钉住的是**纯逻辑**（区间对齐、分组计划、文案），而下面这三件事只有真浏览器能回答：
 *   1. **逐段包裹真的发生了**。渲染层要求"按块的边界切开 HTML"是**被证明过的**：
 *      每一组的 HTML 必须正好是整份 HTML 的下一段（`planBlockGroups`）。
 *      证明不通过时会**整份回退**（正文照常、只是没有标签）—— 那是静默的，
 *      单测看不见（它们用的是 marked，没有 DOMPurify、也没有 `.md-body` 这层 DOM）。
 *      断言口径：`.md-body` 的**每个直接子元素**都是 `.gw-block`。
 *   2. **消毒之后拼接依然成立**。单测里的渲染器是 marked；真机上还多一道 DOMPurify。
 *      它若让"逐段渲染拼起来 ≠ 整份渲染"，上面那条回退就会被触发 —— 而页面看上去
 *      毫无异常（正是最难发现的那类失效）。
 *   3. **排版没有被动过**。包裹层是新增的一层 DOM，本仓的正文排版靠 CSS 后代选择器，
 *      多一层会不会把间距/表格滚动/复制按钮弄坏，只有量真实盒模型才算数。
 *
 * 覆盖的场景（每条都对应一个真实的 Markdown 形态）：
 *   - A 三段正文、**两次保存**：只改第三段 ⇒ 前两段的标签文案与绝对时间**一个字都不变**
 *     （0024 把 `updated_at` 的语义收紧成"这个块的文本真的变了"，这条是它的端到端证据）；
 *   - B **松列表 + 链接引用定义**：这两种形态会让"一块一个 DOM 节点"不成立，
 *     分组必须把它们合成一组 —— 否则标签会挂错段落（或整页没有标签）；
 *   - C **正文开头是与标题重复的一级标题**：阅读页会剥掉它（`stripDuplicateLeadingTitle`），
 *     块区间必须跟着平移，剥掉的那一段不给标签、其余段照常。
 *
 * 退出码：全部断言通过 0，否则 1（结果 JSON 写到 `tmp/block-attribution-cdp/result.json`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { ensureAdminSession } from './lib/session.mjs'

const baseUrl = process.argv[2]
const cdpPort = Number(process.argv[3] ?? 9470)
if (!baseUrl) {
  console.error('用法：node scripts/acceptance/block-attribution-cdp.mjs <实例 URL> [cdpPort]')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT_DIR = 'tmp/block-attribution-cdp'

/* ------------------------------ 断言与结果 ------------------------------ */

const failures = []
const results = {}
function check(name, ok, detail) {
  results[name] = { ok, detail }
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function skip(name, note) {
  results[name] = { skipped: true, note }
  console.log(`skip ${name} — ${note}`)
}

/* ------------------------------ 1. 播种数据（走真实 API） ------------------------------ */

const auth = await ensureAdminSession(baseUrl)
if (!auth.ok) {
  console.error(`拿不到管理会话：${auth.note}`)
  process.exit(2)
}
console.log(`# 会话：${auth.mode} —— ${auth.note}`)
const api = auth.session

/** 保存一页（返回响应体）；`note` 用于失败时能看懂是哪一步 */
async function save(slug, title, content) {
  const res = await api.call('PUT', `/api/pages/${encodeURIComponent(slug)}`, { title, content })
  if (res.status !== 200) throw new Error(`保存 ${slug} 失败：${res.status} ${res.text.slice(0, 200)}`)
  return res.json
}
/** 读详情（含 `blocks` 归属数组） */
async function detail(slug) {
  const res = await api.call('GET', `/api/pages/${encodeURIComponent(slug)}`)
  if (res.status !== 200) throw new Error(`读取 ${slug} 失败：${res.status}`)
  return res.json
}

const PAGE_A = 'attr-a'
const PAGE_B = 'attr-b'
const PAGE_C = 'attr-c'

// A：三段。第一次保存三段的归属相同；第二次只改第三段。
await save(PAGE_A, '归属甲', ['第一段。', '', '第二段。', '', '第三段。'].join('\n'))
const aFirst = await detail(PAGE_A)
await save(PAGE_A, '归属甲', ['第一段。', '', '第二段。', '', '第三段（改过）。'].join('\n'))
const aSecond = await detail(PAGE_A)

// B：松列表（空行分隔的列表项）+ 链接引用定义 + 使用它的段落
await save(
  PAGE_B,
  '归属乙',
  [
    '引用式链接在下面定义。',
    '',
    '[ref]: /wiki/guide/architecture',
    '',
    '- 列表项甲',
    '',
    '- 列表项乙',
    '',
    '使用 [ref] 的段落。',
  ].join('\n'),
)
const bDetail = await detail(PAGE_B)

// C：正文以与标题重复的一级标题开头（阅读页会剥掉它）
await save(PAGE_C, '归属丙', ['# 归属丙', '', '丙的第一段。', '', '丙的第二段。'].join('\n'))
const cDetail = await detail(PAGE_C)

/** 该页每个可见段（`gated: false`）的 `(updatedAt, author名)` */
const stampsOf = (d) =>
  (d.blocks ?? [])
    .filter((b) => b.gated === false)
    .map((b) => `${b.updatedAt}|${b.author === null ? '-' : (b.author.displayName ?? '另一位成员')}`)

/* 先做两条**接口层**的断言：它们是后面浏览器断言的前提（数据都没对，页面更不可能对） */
const a1 = stampsOf(aFirst)
const a2 = stampsOf(aSecond)
check(
  'A：两次保存后，只有被改动的那一段换了归属',
  a2.length === 3 && a2[0] === a1[0] && a2[1] === a1[1] && a2[2] !== a1[2],
  `第一次=${JSON.stringify(a1)} 第二次=${JSON.stringify(a2)}`,
)
check(
  'A/B/C：每段的区间切出来就是该段文本（区间与正文同源）',
  [aSecond, bDetail, cDetail].every((d) =>
    (d.blocks ?? []).every((b) => typeof d.content.slice(b.start, b.end) === 'string' && b.end > b.start),
  ),
  `A=${aSecond.blocks?.length} 段 / B=${bDetail.blocks?.length} 段 / C=${cDetail.blocks?.length} 段`,
)

/* ------------------------------ 2. 连上 Chrome ------------------------------ */

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) {
  console.error('未找到 page target（Chrome 是否以 --remote-debugging-port 启动？）')
  process.exit(2)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('WebSocket 连接失败'))
})
let seq = 0
const pending = new Map()
/** console 错误与失败请求（"插件机制不能靠忍一忍上线"的同款纪律：这一批也不许有） */
const consoleErrors = []
const failedRequests = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject: rej } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) rej(new Error(JSON.stringify(msg.error)))
    else res(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params?.exceptionDetails?.text ?? 'exception')
  }
  if (msg.method === 'Network.loadingFailed') {
    failedRequests.push(`${msg.params?.type} ${msg.params?.errorText}`)
  }
  if (msg.method === 'Network.responseReceived' && Number(msg.params?.response?.status) >= 400) {
    failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`)
  }
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
/*
 * ★ 本脚本要求浏览器**有悬停能力**（`(hover: hover)`）。
 *
 * headless Chrome 默认匹配 `@media (hover: none)`（容器里没有指点设备），而标签样式正是
 * 按这一档分叉的：触屏常显、桌面悬停才显示。踩过的两个坑都记在这里：
 *   1. `Emulation.setEmulatedMedia({features:[{name:'hover',value:'hover'}]})` **不生效**
 *      （实测 `matchMedia('(hover: none)').matches` 仍是 `true`，设了 `media` 也一样）
 *      ⇒ 只能靠启动参数，见下；
 *   2. 于是必须用 Blink 的指针设置启动 Chrome：
 *      `--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=1,availablePointerTypes=1`
 * 触屏那一支改由**源码级守卫**覆盖（`packages/web/test/blockMetaPlan.test.ts`：
 * `@media (hover: none)` 分支里 `.gw-block-meta` 必须常显）——它不需要浏览器就能钉住。
 */
const hoverCapable = await evaluate(`matchMedia('(hover: hover)').matches`)
if (!hoverCapable) {
  console.error(
    '本脚本要求浏览器匹配 (hover: hover)。请用下列参数启动 Chrome：\n' +
      '  google-chrome --headless=new --no-sandbox --remote-debugging-port=' +
      cdpPort +
      ' --blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=1,availablePointerTypes=1 about:blank',
  )
  process.exit(2)
}

/* ------------------------------ 3. 浏览器内登录 ------------------------------ */

if (auth.mode === 'session') {
  /*
   * 必须先导航到实例上：`about:blank` 里 `fetch('/api/...')` 连相对地址都解析不了
   * （实测报 `Failed to parse URL from /api/auth/login`）。登录成功后 cookie 属于这个源，
   * 后续 `#/wiki/<slug>` 的 hash 导航会带着它。
   */
  await send('Page.navigate', { url: `${baseUrl}/` })
  await sleep(1200)
  // 页面内 fetch 会自动带 cookie，但状态变更请求必须显式带 CSRF 头（与 session.mjs 同款）
  const login = await evaluate(`(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gw-csrf': '1' },
      body: JSON.stringify({ email: ${JSON.stringify(api.email)}, password: ${JSON.stringify(api.password)} }),
    })
    const state = await (await fetch('/api/auth/state')).json()
    return { status: r.status, authenticated: state.authenticated === true }
  })()`)
  check(
    '浏览器内已登录（否则归属只显示「另一位成员」，真名那一档就验不到）',
    login.status === 200 && login.authenticated === true,
    JSON.stringify(login),
  )
} else {
  skip('浏览器内登录', '走的是 break-glass 应急通道（没有会话 cookie）⇒ 真名那一档改由接口断言覆盖')
}

/* ------------------------------ 4. 打开页面并读 DOM ------------------------------ */

/** 打开 `#/wiki/<slug>`，等正文渲染出来（`.md-body` 有子节点），再返回探针结果 */
async function openAndProbe(slug, extraWait = 0) {
  await send('Page.navigate', { url: `${baseUrl}/#/wiki/${slug}` })
  await sleep(900 + extraWait)
  // hash 变化不触发新导航时，强制重载一次（脚本可能连着跑过同一条路由）
  await evaluate(`location.reload()`)
  await sleep(1400 + extraWait)
  return evaluate(`(() => {
    const bodies = [...document.querySelectorAll('.md-body')]
    const body = bodies.find((b) => b.children.length > 0) ?? null
    if (body === null) return { found: false, bodies: bodies.length }
    const children = [...body.children]
    const chips = children.map((c) => c.querySelector(':scope > .gw-block-meta'))
    const visible = (el) => el === null ? null : getComputedStyle(el).visibility
    return {
      found: true,
      className: body.className,
      childCount: children.length,
      wrapped: children.map((c) => c.className),
      // 结构断言看**整份 HTML**（子元素自己的 innerHTML 不含它自己的标签）
      bodyHtml: body.innerHTML.slice(0, 4000),
      html: children.map((c) => c.innerHTML.replace(/<span class="gw-block-meta"[^>]*>[^<]*<\\/span>/, '')).join(''),
      chips: chips.map((c) => (c === null ? null : { text: c.textContent, title: c.getAttribute('title'), visibility: visible(c) })),
      // 正文自检：包裹层不应改变可见文本（去掉标签后与接口下发的正文块拼接比较由调用方做）
      text: body.textContent.trim().slice(0, 200),
    }
  })()`)
}

/** 悬停第 i 个 `.gw-block`（真鼠标事件，才能触发 CSS `:hover`） */
async function hoverBlock(slug, index) {
  await evaluate(`location.hash = '#/wiki/${slug}'`)
  await sleep(1200)
  const box = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.md-body .gw-block')][${index}]
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(12, r.height / 2)) }
  })()`)
  if (box === null) return null
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
  await sleep(320)
  return evaluate(`(() => {
    const b = [...document.querySelectorAll('.md-body .gw-block')][${index}]
    const c = b?.querySelector(':scope > .gw-block-meta') ?? null
    return c === null ? null : { visibility: getComputedStyle(c).visibility, opacity: getComputedStyle(c).opacity }
  })()`)
}

/* ---- A：三段，前两段的标签必须与第一次保存时逐字相同 ---- */
const a = await openAndProbe(PAGE_A)
check('A：正文渲染出来了', a.found === true, JSON.stringify(a).slice(0, 200))
check('A：三段都被包进 .gw-block（证明逐段切分真的成立，而不是整份回退）',
  a.found === true && a.childCount === 3 && a.wrapped.every((c) => c.split(' ').includes('gw-block')),
  `children=${JSON.stringify(a.wrapped)}`)
check('A：三段各有一句「最后由 X 编辑 · 时间」',
  Array.isArray(a.chips) && a.chips.length === 3 && a.chips.every((c) => /^最后由 .+ 编辑 · /.test(c?.text ?? '')),
  JSON.stringify(a.chips))
check('A：被改过的第三段与未改动的第一段**时间不同**（未改动的块不被刷新）',
  a.chips?.[0]?.title !== a.chips?.[2]?.title,
  `chip1=${a.chips?.[0]?.title} chip3=${a.chips?.[2]?.title}`)
check('A：标签默认不可见（悬停才出现，否则每段都被顶着一行标签）—— 见下文对触屏分支的说明',
  a.chips?.every((c) => c?.visibility === 'hidden'),
  JSON.stringify((a.chips ?? []).map((c) => c?.visibility)))

const hovered = await hoverBlock(PAGE_A, 0)
check('A：鼠标移到某一段上时，那一段的标签出现（真 CSS :hover）',
  hovered?.visibility === 'visible' && Number(hovered.opacity) > 0.5,
  JSON.stringify(hovered))

if (auth.mode === 'session') {
  check('A：登录主体看到的是**真名**（不是「另一位成员」）',
    (a.chips ?? []).every((c) => (c?.text ?? '').includes('验收主体')),
    JSON.stringify((a.chips ?? []).map((c) => c?.text)))
}

/* ---- B：松列表 + 引用定义（跨段续行）---- */
const b = await openAndProbe(PAGE_B)
check('B：正文渲染出来了', b.found === true, b.found === false ? JSON.stringify(b).slice(0, 200) : undefined)
check('B：松列表与引用定义都没有让归属失效（三组都包了、且都有标签）',
  b.found === true &&
    b.childCount === 3 &&
    Array.isArray(b.chips) &&
    b.chips.filter((c) => c !== null).length === 3 &&
    b.wrapped.every((c) => c.split(' ').includes('gw-block')),
  `children=${JSON.stringify(b.wrapped)} chips=${JSON.stringify((b.chips ?? []).map((c) => c?.text))}`)
check('B：链接引用定义被正确消费（正文里渲染成了真链接）',
  // 站内链接会被改写成 hash 路由（`#/wiki/<slug 转义>`），故断言的是"真的成了 <a>"
  b.bodyHtml?.includes('<a href="#/wiki/guide%2Farchitecture">') === true,
  (b.bodyHtml ?? '').slice(0, 240))
check('B：松列表仍是**一个** <ul>（包裹层没有把跨段续行切断）',
  (b.bodyHtml?.match(/<ul/g) ?? []).length === 1,
  `ul 数量=${(b.bodyHtml?.match(/<ul/g) ?? []).length}`)

/* ---- C：开头的一级标题被剥掉（区间必须跟着平移）---- */
const c = await openAndProbe(PAGE_C)
check('C：正文渲染出来了', c.found === true, c.found === false ? JSON.stringify(c).slice(0, 200) : undefined)
check('C：剥掉重复标题段之后，**剩下两段**仍有标签（区间跟着平移而不是整页放弃）',
  c.found === true && c.childCount === 2 && (c.chips ?? []).every((x) => /^最后由 .+ 编辑 · /.test(x?.text ?? '')),
  `children=${c.childCount} chips=${JSON.stringify((c.chips ?? []).map((x) => x?.text))}`)
check('C：被剥掉的那一段没有留下空包裹层', c.childCount === 2, `childCount=${c.childCount}`)

/* ------------------------------ 5. console 与失败请求 ------------------------------ */

check('全程 console 无 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
/*
 * `net::ERR_ABORTED` 是**脚本自己**造成的：本脚本为了强制重渲染会 `location.reload()`，
 * 那会把页面上正在飞的请求掐掉。产品缺陷的形态是"4xx/5xx 或真的连不上"，
 * 故这里把 abort 排除（并且不排除 404 —— 页面上的 404 是要修的）。
 */
const realFailures = failedRequests.filter((r) => !r.includes('favicon') && !r.includes('ERR_ABORTED'))
check('全程无失败请求（404 与连接失败都算失败）', realFailures.length === 0, realFailures.slice(0, 3).join(' | '))

/* ------------------------------ 收尾 ------------------------------ */

mkdirSync(OUT_DIR, { recursive: true })
const out = { baseUrl, cdpPort, auth: auth.mode, results, failures, consoleErrors, failedRequests }
writeFileSync(`${OUT_DIR}/result.json`, `${JSON.stringify(out, null, 2)}\n`)
console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 条失败`}（结果写到 ${OUT_DIR}/result.json）`)
ws.close()
process.exit(failures.length === 0 ? 0 : 1)
