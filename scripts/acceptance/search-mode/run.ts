/**
 * 「检索界面的匹配方式开关」的浏览器端到端验收。
 *
 * ## 为什么必须有这一层
 *
 * 本批改动已经有 11 条单测 + 5 条源码守卫，但它们**证明不了这次要修的那个症状真的修好了**：
 * 守卫只能证明"`api.search` 被传了 `mode`"，证明不了**浏览器里点一下按钮，结果真的从 0 变出来**。
 * 而这批改动的全部价值就在那一下点击上——所以按本仓纪律（见 `docs/architecture.md:363`
 * 「验收脚本不接入 `pnpm test`」）单独写这个脚本。
 *
 * ## 它验的是什么（单测与源码守卫都测不到的那一段）
 *
 * 1. **症状确实存在于改造前的路径上**：同一句话，缺省的 `phrase` 语义 0 命中（这是要修的因）；
 * 2. **界面真的把语义传下去了**：切到「分词」后**同一句话**命中 ≥1（这是果）；
 * 3. **语义随查询串复位**：换一个短关键词，模式自己回到「精确」——不把上一次的选择带过去；
 * 4. **0 命中时只引导、不自动重试**：停 1.5 秒再读，模式仍是用户选的那个，
 *    且**没有第二个 `/api/search` 请求**带着别的 mode 发出去（静默重试会让用户以为搜的就是原串）；
 * 5. **切模式只发一次请求**：验证 `disabled={busy}` 真的挡住了并发重发；
 * 6. **控制台无 error**：React key / aria 属性 / 受控组件的警告都算失败。
 *
 * ## 隔离与用法
 *
 * 与 `scripts/acceptance/p3-editor-tools/run.ts` 同款：**复制 `config/` 与 `data/geewiki.db`
 * 到临时目录**、只装本次链路需要的插件、用随机空闲端口起独立实例，绝不碰用户的运行实例。
 * 检索端点是公开的（无需登录），故本脚本不造用户。
 *
 * ```
 * pnpm build                                  # 先构建前端（脚本读 packages/web/dist）
 * node --import tsx scripts/acceptance/search-mode/run.ts
 * ```
 *
 * 需要系统里有 Chrome（`google-chrome` / `chromium` / `$CHROME_PATH`）。
 * 找不到浏览器或构建产物时**明确跳过**（exit 2），不是通过。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { readBaseList } from '../../lib/base-list.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')

/* ------------------------------ 断言脚手架 ------------------------------ */

const failures: string[] = []
const results: Record<string, { ok: boolean; detail?: string }> = {}

function check(name: string, ok: boolean, detail?: string): void {
  results[name] = { ok, detail }
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ------------------------------ 前置：构建产物与浏览器 ------------------------------ */

const webDist = join(repo, 'packages', 'web', 'dist')
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('未找到前端构建产物 packages/web/dist/index.html —— 请先跑 `pnpm build`。')
  process.exit(2)
}

function findChrome(): string | undefined {
  const explicit = process.env['CHROME_PATH']
  if (explicit !== undefined && existsSync(explicit)) return explicit
  for (const p of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (existsSync(p)) return p
  }
  return undefined
}

const chromePath = findChrome()
if (chromePath === undefined) {
  console.error('未找到 Chrome —— 设 CHROME_PATH 或安装 google-chrome。')
  process.exit(2)
}

/* ------------------------------ 隔离环境 ------------------------------ */

const work = mkdtempSync(join(tmpdir(), 'geewiki-search-mode-'))
const configDir = join(work, 'config')
const dataDir = join(work, 'data')
mkdirSync(dataDir)

cpSync(join(repo, 'config'), configDir, { recursive: true })

const base = readBaseList(configDir)
/** 本次链路只需要：存储 → HTTP → 页面（正文进 FTS） → 检索。auth/org 也留着，避免匿名主体解析报错。 */
const NEEDED = [
  '@geewiki/db-sqlite',
  '@geewiki/http',
  '@geewiki/auth',
  '@geewiki/org',
  '@geewiki/authz',
  '@geewiki/wiki',
  '@geewiki/search',
]
for (const name of NEEDED) {
  if (!base.enabled.some((e) => e.name === name)) {
    throw new Error(
      `基础层清单里没有 ${name} —— 请确认 config/plugins.base.json（本机 live）或 config/plugins.base.example.json（随版本发布）`,
    )
  }
}
base.enabled = base.enabled.filter((e) => NEEDED.includes(e.name))
writeFileSync(join(configDir, 'plugins.base.json'), JSON.stringify(base, null, 2) + '\n')

const copied: string[] = []
for (const suffix of ['', '-wal', '-shm']) {
  const src = join(repo, 'data', 'geewiki.db' + suffix)
  if (existsSync(src)) {
    cpSync(src, join(dataDir, 'geewiki.db' + suffix))
    copied.push('geewiki.db' + suffix)
  }
}

// 必须在**导入 server 之前**设好：crashMarkerFile 在模块加载期就算出来了
process.env['GEEWIKI_DATA_DIR'] = dataDir

async function freePort(): Promise<number> {
  return await new Promise<number>((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => res(port))
    })
  })
}

const port = await freePort()
const cdpPort = await freePort()
const BASE = `http://127.0.0.1:${port}`
console.log(`隔离环境：${work}`)
console.log(`数据目录：已复制 ${copied.join(', ')}`)
console.log(`实例地址：${BASE}（CDP ${cdpPort}）\n`)

/* ------------------------------ 起实例 ------------------------------ */

const { startServer } = await import('../../../packages/server/src/index.js')

const { dispose } = await startServer({
  port,
  host: '127.0.0.1',
  configDir,
  pluginsDir: null,
  webDist,
  pluginUiDist: join(repo, 'packages', 'web', 'public'),
})

/* ------------------------------ 起浏览器 ------------------------------ */

const profileDir = join(work, 'chrome-profile')
let chrome: ChildProcess | undefined

function startChrome(): ChildProcess {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank',
  ]
  return spawn(chromePath as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
      }>
      const page = list.find((t) => t.type === 'page')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('Chrome 的 CDP 端口一直没就绪')
}

/* ------------------------------ CDP 客户端 ------------------------------ */

interface CdpEvent {
  kind: string
  text: string
  type?: string
  status?: number
}

class Cdp {
  private seq = 0
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  readonly events: CdpEvent[] = []
  /** 本次页面生命周期里发往 /api/search 的全部请求 URL（用来抓"静默重试"） */
  readonly searchRequests: string[] = []

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: unknown
        error?: unknown
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p?.rej(new Error(JSON.stringify(msg.error)))
        else p?.res(msg.result)
        return
      }
      const params = msg.params ?? {}
      switch (msg.method) {
        case 'Runtime.consoleAPICalled': {
          const type = String(params['type'])
          if (type === 'error' || type === 'warning') {
            const args = (params['args'] ?? []) as Array<{ value?: unknown; description?: string }>
            this.events.push({
              kind: 'console',
              type,
              text: args.map((a) => String(a.value ?? a.description ?? '')).join(' '),
            })
          }
          break
        }
        case 'Runtime.exceptionThrown': {
          const d = params['exceptionDetails'] as { text?: string } | undefined
          this.events.push({ kind: 'exception', text: d?.text ?? 'exception' })
          break
        }
        case 'Log.entryAdded': {
          const e = params['entry'] as { level?: string; text?: string } | undefined
          if (e?.level === 'error') this.events.push({ kind: 'log', text: e.text ?? '' })
          break
        }
        case 'Network.requestWillBeSent': {
          const req = params['request'] as { url?: string } | undefined
          if (req?.url !== undefined && req.url.includes('/api/search')) this.searchRequests.push(req.url)
          break
        }
        case 'Network.responseReceived': {
          const r = params['response'] as { status?: number; url?: string } | undefined
          if ((r?.status ?? 0) >= 400) {
            this.events.push({ kind: 'http', status: r?.status, text: r?.url ?? '' })
          }
          break
        }
        default:
          break
      }
    }
  }

  static async connect(): Promise<Cdp> {
    const url = await waitForCdp()
    const ws = new WebSocket(url)
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    return cdp
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.seq
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值一个表达式，返回 JSON 化的结果 */
  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } }
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页面求值抛错：${r.exceptionDetails.text}`)
    }
    return r.result?.value as T
  }

  /** 等到表达式返回真值为止（轮询），超时抛错 */
  async waitFor(expression: string, label: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`!!(${expression})`)) return
      await sleep(120)
    }
    throw new Error(`等待超时：${label}`)
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url })
    await sleep(400)
  }

  /**
   * 强制**新文档**地打开一个 hash 路由。
   *
   * 不能只用 `goto`：本应用是 hash 路由，若目标与当前 URL 只差（或完全不差）hash，
   * `Page.navigate` 只做同文档导航 —— 组件状态会**原样留着**（mode 还是上一次选的
   * `terms`、结果还在），于是"空状态 → 引导按钮"这条路径根本不会出现。
   * 先落到 `about:blank` 再进目标，保证拿到干净的首次挂载。
   */
  async hardGoto(url: string): Promise<void> {
    await this.send('Page.navigate', { url: 'about:blank' })
    await sleep(250)
    await this.send('Page.navigate', { url })
    await sleep(400)
  }

  /** 清掉请求记录（分段断言"这一步发了几个请求"）；**不动 events**，控制台错误要全程累积 */
  resetRequests(): void {
    this.searchRequests.length = 0
  }
}

/* ------------------------------ 页面侧选择器与读取 ------------------------------ */

/*
  选择器刻意**不依赖 CSS 类名**（`.search-mode` 是样式实现，重构时会改），而是靠
  可访问性语义与文案：`[role="group"][aria-label="查询语义"]` 内的 `aria-pressed` 按钮。
  这也顺带验证了"读屏用户能不能知道现在是哪个模式"——那正是 aria-pressed 存在的理由。
*/
const READ_MODE = `(() => {
  const g = document.querySelector('[role="group"][aria-label="查询语义"]');
  if (!g) return { present: false };
  const btns = [...g.querySelectorAll('button')];
  const on = btns.find(b => b.getAttribute('aria-pressed') === 'true');
  return {
    present: true,
    labels: btns.map(b => b.textContent.trim()),
    pressed: on ? on.textContent.trim() : null,
    meta: (document.querySelector('.search-meta') || {}).textContent || '',
  };
})()`

const READ_EMPTY = `(() => {
  const t = document.body.innerText;
  return {
    hasEmpty: t.includes('没有找到'),
    hasGuide: t.includes('改用分词匹配'),
    hitCount: document.querySelectorAll('.search-hit').length,
  };
})()`

/** 点「分词」按钮（用文案定位，不靠类名/顺序） */
const CLICK_TERMS = `(() => {
  const g = document.querySelector('[role="group"][aria-label="查询语义"]');
  const b = [...g.querySelectorAll('button')].find(x => x.textContent.includes('分词'));
  if (!b) return false;
  b.click();
  return true;
})()`

/** 点空结果里的引导按钮 */
const CLICK_GUIDE = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('改用分词匹配'));
  if (!b) return false;
  b.click();
  return true;
})()`

/**
 * 在搜索框里输入并提交 —— **应用内导航**，组件不卸载。
 *
 * 这是复位逻辑唯一会被走到的路径：`query` prop 变了而组件还挂着，effect 里
 * `lastQuery.current !== query` 才成立。用 `hardGoto` 换 URL 是**重新挂载**，
 * `useState(detectQueryMode(query))` 直接给出正确初值，**根本验不到复位那段代码**。
 * 受控 input 必须走原生 setter 再派发 input 事件，直接赋 `.value` React 看不见。
 */
const submitQuery = (q: string): string => `(() => {
  const input = document.querySelector('.search-input');
  const form = document.querySelector('.search-form');
  if (!input || !form) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(q)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`

/* ------------------------------ 跑 ------------------------------ */

let cdp: Cdp | undefined
/*
  ## 两个查询的选择（都是实测挑出来的，不是编的）

  本批有**两条**修复路径，脚本必须各覆盖一次：

  - `AUTO`（自动）：`detectQueryMode` 把它判成 `terms`，**用户一下都不用点**就该有命中。
    这正是最初那句「编辑后怎么保存」——**它含「怎么」**，所以自动路径就把它接住了。
    （脚本第一版拿它去验"手动切换"路径，结果 6 项全红；那是**测试前提写错了，不是代码错**。
    这个发现本身有价值：说明自动推导比预想的覆盖得多，手动开关是兜底而非唯一入口。）
  - `MANUAL`（手动）：短关键词，`detectQueryMode` 判 `phrase`（保持精确语义），
    但在语料里整串**逐字不连续**⇒ phrase 0 命中、terms 有命中。这才需要用户点一下。
    实测读数：`版本管理权` phrase 0 / terms 2；`编辑后怎么保存` phrase 0 / terms 1。
*/
const AUTO = '编辑后怎么保存'
const MANUAL = '版本管理权'
const SHORT = '架构' // 短关键词：判 phrase，且真有命中

try {
  chrome = startChrome()
  cdp = await Cdp.connect()

  /* ================= 路径一：自动推导（问句 → terms，零点击） ================= */

  await cdp.goto(`${BASE}/#/wiki/search/${encodeURIComponent(AUTO)}`)
  await cdp.waitFor(`document.querySelector('[role="group"][aria-label="查询语义"]')`, '匹配方式切换条出现')
  await cdp.waitFor(`document.querySelectorAll('.search-hit').length > 0`, '自动路径出现命中')
  const mAuto = await cdp.evaluate<{ labels: string[]; pressed: string | null; meta: string }>(READ_MODE)
  check('切换条存在且含两个语义选项', mAuto.labels.length === 2, `按钮=${JSON.stringify(mAuto.labels)}`)
  check(
    '问句「含怎么」被**自动**判为「分词」（零点击即有结果）',
    mAuto.pressed?.includes('分词') === true,
    `当前按下=${mAuto.pressed}`,
  )
  const eAuto = await cdp.evaluate<{ hitCount: number }>(READ_EMPTY)
  check('自动路径命中 ≥1（症状在这一条上已消失）', eAuto.hitCount >= 1, `命中 ${eAuto.hitCount} 条`)
  check('结果区标注了本轮「问法」', mAuto.meta.includes('问法'), mAuto.meta.slice(0, 70))

  /* ================= 路径二：手动切换（短关键词 → phrase 0 命中 → 点一下） ================= */

  await cdp.goto(`${BASE}/#/wiki/search/${encodeURIComponent(MANUAL)}`)
  await cdp.waitFor(`document.querySelector('[role="group"][aria-label="查询语义"]')`, '手动路径切换条出现')
  await cdp.waitFor(`document.querySelector('.search-meta')`, '手动路径 meta 出现')
  await sleep(400)

  const m0 = await cdp.evaluate<{ pressed: string | null }>(READ_MODE)
  check(
    '短关键词「版本管理权」判为「精确」（短词的精确语义不被本批改宽）',
    m0.pressed?.includes('精确') === true,
    `当前按下=${m0.pressed}`,
  )
  const e0 = await cdp.evaluate<{ hasEmpty: boolean; hasGuide: boolean; hitCount: number }>(READ_EMPTY)
  check('精确语义下该串 0 命中（这就是手动路径要修的症状）', e0.hitCount === 0 && e0.hasEmpty, `命中 ${e0.hitCount} 条`)
  check('0 命中时出现「改用分词匹配」引导', e0.hasGuide, `hasGuide=${e0.hasGuide}`)

  /* --- 只引导、不自动重试：静置后模式不变，且没有第二个请求 --- */
  cdp.resetRequests()
  await sleep(1500)
  const mStill = await cdp.evaluate<{ pressed: string | null }>(READ_MODE)
  check(
    '0 命中后静置 1.5s：模式仍是「精确」（没有静默换语义重搜）',
    mStill.pressed?.includes('精确') === true,
    `当前按下=${mStill.pressed}`,
  )
  check(
    '0 命中后没有自动发出第二个 /api/search',
    cdp.searchRequests.length === 0,
    `期间请求数=${cdp.searchRequests.length}`,
  )

  /* --- 用户点击 → 同一句话命中 ≥1（手动路径的核心价值） --- */
  cdp.resetRequests()
  const clicked = await cdp.evaluate<boolean>(CLICK_TERMS)
  check('点得到「分词」按钮', clicked === true)
  await cdp.waitFor(`document.querySelectorAll('.search-hit').length > 0`, '分词后出现命中')
  const e1 = await cdp.evaluate<{ hasGuide: boolean; hitCount: number }>(READ_EMPTY)
  check('切「分词」后**同一句话**命中 ≥1（症状已修）', e1.hitCount >= 1, `命中 ${e1.hitCount} 条`)
  check('有命中时不再显示引导按钮', !e1.hasGuide, `hasGuide=${e1.hasGuide}`)
  const m1 = await cdp.evaluate<{ pressed: string | null; meta: string }>(READ_MODE)
  check(
    '模式切到「分词」并回显在结果区',
    m1.pressed?.includes('分词') === true && m1.meta.includes('分词'),
    `meta=${m1.meta.slice(0, 90)}`,
  )
  check(
    '点一次只发一个 /api/search（disabled={busy} 挡住了并发重发）',
    cdp.searchRequests.length === 1,
    `请求数=${cdp.searchRequests.length}：${JSON.stringify(cdp.searchRequests.map((u) => u.replace(BASE, '')))}`,
  )
  check(
    '该请求真的带上了 mode=terms（不是只改了界面状态）',
    cdp.searchRequests[0]?.includes('mode=terms') === true,
    cdp.searchRequests[0]?.replace(BASE, '') ?? '(无)',
  )

  /* --- 引导按钮路径：点它也能换语义 --- */
  await cdp.hardGoto(`${BASE}/#/wiki/search/${encodeURIComponent(MANUAL)}`)
  await cdp.waitFor(`document.body.innerText.includes('改用分词匹配')`, '引导按钮出现')
  await cdp.evaluate<boolean>(CLICK_GUIDE)
  await cdp.waitFor(`document.querySelectorAll('.search-hit').length > 0`, '引导按钮点击后出现命中')
  const e2 = await cdp.evaluate<{ hitCount: number }>(READ_EMPTY)
  check('空结果里的引导按钮点了也有效（用户主动换语义）', e2.hitCount >= 1, `命中 ${e2.hitCount} 条`)

  /* ================= 语义随查询串复位（应用内导航，组件不卸载） ================= */

  /*
    必须先**手动切到「分词」**再换查询串，否则"复位"无从谈起：若本来就该是 phrase，
    复位与不复位看不出区别。下面先切到 terms（与 derive 出的缺省相反），再提交一个
    短关键词，断言它回到 phrase —— 这才真的走到了 effect 里那段复位分支。
  */
  await cdp.hardGoto(`${BASE}/#/wiki/search/${encodeURIComponent(AUTO)}`)
  await cdp.waitFor(`document.querySelector('[role="group"][aria-label="查询语义"]')`, '复位用例页就绪')
  await cdp.waitFor(`document.querySelector('.search-meta')`, '复位用例 meta 就绪')
  const before = await cdp.evaluate<{ pressed: string | null }>(READ_MODE)
  check('复位用例起点：自动判为「分词」', before.pressed?.includes('分词') === true, `当前=${before.pressed}`)

  const submitted = await cdp.evaluate<boolean>(submitQuery(SHORT))
  check('能在应用内提交新查询（组件不卸载）', submitted === true)
  await cdp.waitFor(`document.querySelector('.search-meta') && document.querySelector('.search-meta').textContent.includes('${SHORT}')`, '新查询结果就绪')
  const m2 = await cdp.evaluate<{ pressed: string | null }>(READ_MODE)
  check(
    '应用内换查询串后语义复位为「精确」（不带上一次的「分词」）',
    m2.pressed?.includes('精确') === true,
    `当前按下=${m2.pressed}`,
  )
  const e3 = await cdp.evaluate<{ hitCount: number }>(READ_EMPTY)
  check('短关键词「架构」在精确语义下有命中', e3.hitCount >= 1, `命中 ${e3.hitCount} 条`)

  /* --- 6. 控制台/网络白名单 --- */
  const bad = cdp.events.filter((e) => {
    if (e.kind === 'http') return true
    if (e.text.includes('Download the React DevTools')) return false
    if (e.text.includes('proOptions') || e.text.includes('React Flow')) return false
    return true
  })
  check(
    '全程无 console error / 异常 / 4xx',
    bad.length === 0,
    bad.length === 0 ? '' : JSON.stringify(bad.slice(0, 4)),
  )
} catch (err) {
  check('脚本自身跑完', false, err instanceof Error ? err.message : String(err))
} finally {
  try {
    cdp?.send('Browser.close')
  } catch {
    /* 已关 */
  }
  await sleep(300)
  chrome?.kill('SIGKILL')
  try {
    await dispose()
  } catch {
    /* 已关 */
  }
  if (process.env['GEEWIKI_KEEP_TMP'] === '1') {
    console.log(`\n（临时目录已保留：${work}）`)
  } else {
    rmSync(work, { recursive: true, force: true })
  }
}

/* ------------------------------ 汇总 ------------------------------ */

const out = join(repo, 'tmp', 'search-mode-acceptance.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ results, failures }, null, 2) + '\n')

const total = Object.keys(results).length
const passed = total - failures.length
console.log(`\n${passed}/${total} 通过${failures.length === 0 ? ' ✓' : ''}`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log(`读数已写入 ${out}`)
process.exit(failures.length === 0 ? 0 : 1)
