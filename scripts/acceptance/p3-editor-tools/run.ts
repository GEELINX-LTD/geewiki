/**
 * P3 验收：**编辑框工具的两半必须真的接得上**。
 *
 * ## 判据（设计文档 §8.2 的 P3 行）
 * 1. **模型能读/改编辑框**；
 * 2. **伪造未声明的客户端工具名不进交集**；
 * 3. 轮次上限生效（本脚本只做旁证，主证在 `plugin-ai-assistant` 的单测里）。
 *
 * ## 这个脚本为什么必须存在（它要证的是别的东西证不了的那一条）
 * `editor.*` 是**两半点名同一个名字**的工具：
 * - 服务端 `@geewiki/ai-writing` 声明四条 `side:'client'` 描述符；
 * - 浏览器 `packages/web/src/lib/editorTools.ts` 登记四个同名处理器。
 *
 * 两侧各自都有单测全绿，`toolNames.test.ts` 也钉住了名字逐字相等——**但没有任何一条单测
 * 证明"服务端的声明经真实 HTTP 传到浏览器、浏览器执行完再回灌进模型"这条链是通的**。
 * 本脚本把这两半真的接起来跑：服务端是生产的 `POST /api/ai/turn`，浏览器那一半直接
 * import **真实的** `packages/web/src/lib/editorTools.ts`（它只依赖 `clientTools.ts`，
 * 没有 DOM 假设，所以能在 node 里跑）——**执行的是生产代码，不是替身**。
 *
 * ## 为什么"伪造名字"这一条要用真实端点打
 * `clientTools` 是**客户端上报**的输入，也就是攻击面：一个被改过的浏览器可以声明任意工具名。
 * 收窄发生在服务端（`resolveTurnTools` 取"服务端声明的 side:'client' ∩ 客户端上报的"），
 * 所以只有打真实端点才能证明"上报一个不存在的名字不会让它进模型看到的工具表"。
 *
 * 用法：node --import tsx scripts/acceptance/p3-editor-tools/run.ts
 *      没有可用密钥时**明确跳过并退出码 2**，不假装通过。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

/* ------------------------------ 前置：密钥 ------------------------------ */

function hasApiKey(): boolean {
  try {
    const secrets = JSON.parse(readFileSync(join(repo, 'config/secrets.json'), 'utf8')) as Record<
      string,
      { apiKey?: string } | undefined
    >
    return (secrets['@geewiki/llm']?.apiKey ?? '') !== ''
  } catch {
    return false
  }
}

if (!hasApiKey()) {
  console.log('SKIP：config/secrets.json 里没有 @geewiki/llm.apiKey，无法打真实上游。')
  console.log('     （这是一次**明确跳过**，不是通过 —— 本脚本的价值全在真实链路上。）')
  process.exit(2)
}

/* ------------------------------ 隔离环境 ------------------------------ */

const work = mkdtempSync(join(tmpdir(), 'geewiki-p3-editor-'))
const configDir = join(work, 'config')
const dataDir = join(work, 'data')
mkdirSync(dataDir)

cpSync(join(repo, 'config'), configDir, { recursive: true })
const base = JSON.parse(readFileSync(join(configDir, 'plugins.base.json'), 'utf8')) as {
  enabled: { name: string; config?: unknown }[]
}
/** 本次链路需要的插件：存储 → 策略 → 页面 → 检索 → 模型 → 工具总线 → 工具提供者 → 助手 */
const NEEDED = [
  '@geewiki/db-sqlite',
  '@geewiki/http',
  '@geewiki/auth',
  '@geewiki/org',
  '@geewiki/authz',
  '@geewiki/wiki',
  '@geewiki/search',
  '@geewiki/llm',
  '@geewiki/openai',
  '@geewiki/ai-tools',
  '@geewiki/ai-kb',
  '@geewiki/ai-writing',
  '@geewiki/ai-assistant',
]
for (const name of NEEDED) {
  if (!base.enabled.some((e) => e.name === name)) {
    throw new Error(`基础层清单里没有 ${name} —— 本脚本的隔离清单需要它，请先确认 config/plugins.base.json`)
  }
}
base.enabled = base.enabled.filter((e) => NEEDED.includes(e.name))
writeFileSync(join(configDir, 'plugins.base.json'), JSON.stringify(base, null, 2) + '\n')

const copied: string[] = []
for (const suffix of ['', '-wal', '-shm']) {
  const src = join(repo, 'data/geewiki.db' + suffix)
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
const BASE = `http://127.0.0.1:${port}`
console.log(`隔离环境：${work}`)
console.log(`数据目录：已复制 ${copied.join(', ')}`)
console.log(`实例地址：${BASE}\n`)

/* ------------------------------ 起实例 ------------------------------ */

const { startServer } = await import('../../../packages/server/src/index.js')

const { app, dispose } = await startServer({
  port,
  host: '127.0.0.1',
  configDir,
  pluginsDir: null, // 不发现外部插件：本次链路与本仓库自带的插件无关
  webDist: null, // 不起静态服务
})

async function cleanup(): Promise<void> {
  try {
    await dispose()
  } catch {
    /* 已卸载 */
  }
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

/* ------------------------------ HTTP 帮手 ------------------------------ */

let cookie = ''

interface Reply {
  status: number
  headers: Headers
  text: string
}

async function call(method: string, path: string, body?: unknown, withSession = true): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (withSession) {
    // 会话 cookie + CSRF 头一起上：`checkCsrf` 里"有会话 cookie 就必须带 CSRF 头"，
    // 少了它得到的是 csrf_rejected，看起来会像"接口 403"而不是"脚本漏了一步"。
    if (cookie !== '') headers['cookie'] = cookie
    headers['x-gw-csrf'] = '1'
  }
  // Origin 显式给出：CSRF 校验对带 Origin 的请求要求它与 Host 同源。
  headers['origin'] = BASE
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie !== null) cookie = setCookie.split(';')[0] ?? cookie
  return { status: res.status, headers: res.headers, text: await res.text() }
}

function jsonOf(reply: Reply): Record<string, unknown> {
  try {
    return JSON.parse(reply.text) as Record<string, unknown>
  } catch {
    return {}
  }
}

/* ------------------------------ SSE 解析 ------------------------------ */

interface Frame {
  event: string
  data: Record<string, unknown>
}

/** 极简 SSE 解码：本脚本只面对自己人对自己的输出，不需要处理注释行与重连语义 */
function parseFrames(text: string): Frame[] {
  const frames: Frame[] = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n')
    let event = ''
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (event === '' || data === '') continue
    try {
      frames.push({ event, data: JSON.parse(data) as Record<string, unknown> })
    } catch {
      frames.push({ event, data: { __unparsable: data } })
    }
  }
  return frames
}

/* ------------------------------ 造一个登录主体 ------------------------------ */

/*
 * **为什么不用 `POST /api/auth/setup`**：数据目录是 `data/geewiki.db` 的副本，
 * 里面**已经有账号**，setup 会（正确地）返回 409 `setup_already_done`；而那个账号的
 * 密码我们不知道。所以这里直接往副本里插一个密码已知的主体。
 *
 * **为什么必须是 `user` 而不是 `break-glass`**：本仓的实测发现（探针 E5）——
 * break-glass 的 `orgRole` 是 null，而策略层判"组织级可见"要求
 * `kind === 'user' && orgRole !== null`，于是同一条限制内容在"页面读"路径上 404、
 * 在"检索"路径上却命中。用它验收会得到一份**不可信**的读数。
 * 所以 org_members 那一行不是装饰，它决定了这个主体能不能看见 org 档页面。
 */
const EMAIL = 'p3-editor@example.com'
const PASSWORD = 'p3-editor-password-1'

const { hashPassword } = await import('../../../packages/plugin-auth/src/password.js')
// 服务标识是 `'db'`，不是 manifest 里那个 `provides: 'database-provider'` ——
// `provides` 是**依赖解析用的 token 名**（`deps.ts` 按它连边），`ctx.provide()` 用的
// 是另一个字面量。这一条是读 `packages/db-sqlite/src/index.ts:163` 才确认的。
const db = app.get('db') as
  | {
      query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
      run(sql: string, params?: unknown[]): { lastInsertRowid: number | bigint }
      transaction<T>(fn: () => T): T
    }
  | undefined
if (!db) throw new Error("database-provider 不在（ctx.get('db') 取不到）—— @geewiki/db-sqlite 没激活？")

const credential = await hashPassword(PASSWORD)
const now = new Date().toISOString()
const seededUserId = db.transaction(() => {
  // 不用 `RETURNING id`：适配器的 `run()` 走 better-sqlite3 的 `.run()`，它不取回行，
  // 拿插入 id 的正确途径是 `lastInsertRowid`（`packages/db-sqlite/src/index.ts:72`）。
  const inserted = db.run(
    `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at)
     VALUES (?, ?, ?, 'active', 1, ?)`,
    [1, EMAIL, 'P3 验收', now],
  )
  const userId = Number(inserted.lastInsertRowid)
  db.run(
    `INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, credential.algo, credential.params, credential.salt, credential.hash, now],
  )
  db.run(`INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, [
    1,
    userId,
    now,
  ])
  return userId
})

const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
if (login.status !== 200) {
  console.error(`登录失败（${login.status}）：${login.text}`)
  await cleanup()
  process.exit(1)
}
const me = jsonOf(await call('GET', '/api/auth/me'))
console.log(`建主体：userId=${seededUserId}  login=${login.status}  cookie=${cookie === '' ? '(无)' : '已取得'}`)
console.log(`主体核对：${JSON.stringify(me).slice(0, 200)}\n`)

const llm = app.get('llm-service') as
  | { availableProviders(): readonly { route: string; model: string }[]; settings(): { model: string; baseUrl: string } }
  | undefined
if (!llm) throw new Error('llm-service 不在 —— @geewiki/llm 没激活？')
const usable = llm.availableProviders()
if (usable.length === 0) throw new Error('llm-service 没有可用路由 —— 检查 config/plugins.base.json 与 secrets.json')
console.log(`上游：${llm.settings().baseUrl}  模型：${llm.settings().model}\n`)

/* ------------------------------ 断言累计 ------------------------------ */

const failures: string[] = []
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

/* ============================== P3：编辑框工具 ============================== */

/*
 * 浏览器那一半用**生产代码**，不是替身。
 *
 * `packages/web/src/lib/editorTools.ts` 只依赖 `./clientTools`（一张 Map），没有 DOM 假设，
 * 所以能在 node 里直接跑。这很重要：如果用替身，本脚本证明的就只是"我自己写的假处理器能跑"。
 */
const { EDITOR_TOOL_NAMES, registerEditorTools } = (await import(
  '../../../packages/web/src/lib/editorTools.js'
)) as typeof import('../../../packages/web/src/lib/editorTools.js')
const { clientToolNames, invokeClientTool } = (await import(
  '../../../packages/web/src/lib/clientTools.js'
)) as typeof import('../../../packages/web/src/lib/clientTools.js')

/** 一个真的会被改动的"编辑框"：正文 + 选区，都按宿主的 `EditorCapability` 契约接进来 */
const editor = {
  slug: 'home',
  text: '第一行\n第二行\n',
  selection: null as { text: string; from: number; to: number } | null,
  readOnly: false,
}
const disposeEditorTools = registerEditorTools({
  get slug() {
    return editor.slug
  },
  get readOnly() {
    return editor.readOnly
  },
  docText: () => editor.text,
  selection: () => editor.selection,
  insertAtCursor: (text) => {
    editor.text += text
  },
  replaceSelection: (text) => {
    if (editor.selection === null) return false
    editor.text = editor.text.replace(editor.selection.text, text)
    return true
  },
})

const ourToolNames = EDITOR_TOOL_NAMES.filter((n) => clientToolNames().includes(n))
console.log(`浏览器侧登记：${clientToolNames().join(', ')}`)
console.log(`其中属于 editor.*：${ourToolNames.join(', ')}\n`)

/** 发一个回合，返回帧列表 */
async function turn(body: Record<string, unknown>): Promise<Frame[]> {
  const reply = await call('POST', '/api/ai/turn', body)
  if (reply.status !== 200) throw new Error(`turn 非 200（${reply.status}）：${reply.text.slice(0, 300)}`)
  return parseFrames(reply.text)
}

function statusOf(frames: Frame[]): Record<string, unknown> {
  return frames.find((f) => f.event === 'status')?.data ?? {}
}

function doneOf(frames: Frame[]): Record<string, unknown> {
  return frames.find((f) => f.event === 'done')?.data ?? {}
}

interface Message {
  role: string
  content?: string | null
  toolCalls?: { id: string; name: string; arguments: string }[]
  toolCallId?: string
  name?: string
}

/**
 * 跑到模型不再请求**客户端**工具为止 —— 这就是浏览器那一半要做的事。
 *
 * ## 为什么必须由脚本自己循环（无状态轮次协议）
 * 服务端**只执行 `side:'server'` 的工具**；`side:'client'` 的调用它原样交回来，
 * 回合以 `finishReason: 'tool_calls'` 收尾。浏览器执行完、把结果作为 `role:'tool'`
 * 追加进转录，**再发一个新回合**。所以"一次提问"在协议上是**多个 HTTP 回合**。
 *
 * 这是 P2b 的验收脚本没有覆盖的形态：那一次模型只用了服务端工具，一个回合就跑完了。
 * 首轮实测（本脚本的第一版）正是栽在这里——它只发了一个回合，于是看到
 * `status → done`、模型"什么都没调"，而真相是它在等客户端执行。
 *
 * 上限 `MAX_CLIENT_ROUNDS = 8` 与 `ui/dockPlan.ts:37` 同值：没有它，一个持续请求
 * 客户端工具的模型会让浏览器无限发请求，而**每一轮都真的花钱**。
 */
async function runUntilSettled(initial: Message[], clientTools: readonly string[]): Promise<{
  frames: Frame[]
  messages: Message[]
  rounds: number
  executed: string[]
}> {
  let messages = initial
  const allFrames: Frame[] = []
  const executed: string[] = []
  let rounds = 0

  for (let i = 0; i < 8; i++) {
    rounds += 1
    const frames = await turn({
      messages,
      clientTools: [...clientTools],
      page: { slug: 'home', kind: 'edit' },
    })
    allFrames.push(...frames)
    const done = doneOf(frames)
    messages = (done['messages'] as Message[] | undefined) ?? messages
    if (done['finishReason'] !== 'tool_calls') break

    // 转录末尾那条助手消息带着待执行的客户端调用
    const last = messages[messages.length - 1]
    const calls = last?.toolCalls ?? []
    if (calls.length === 0) break

    const results: Message[] = []
    for (const call of calls) {
      if (!call.name.startsWith('editor.')) {
        results.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: 'not_a_client_tool', message: `${call.name} 不归浏览器执行` }),
        })
        continue
      }
      let args: unknown = {}
      try {
        args = call.arguments === '' ? {} : (JSON.parse(call.arguments) as unknown)
      } catch {
        results.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: 'bad_arguments', raw: call.arguments }),
        })
        continue
      }
      try {
        const value = await invokeClientTool(call.name, args)
        executed.push(call.name)
        results.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(value) })
      } catch (err) {
        results.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: 'client_tool_failed', message: err instanceof Error ? err.message : String(err) }),
        })
      }
    }
    /*
     * **每个 toolCall 都必须留下配对结果**（含失败与"不归我执行"的）：
     * 孤儿调用会让上游 400，而报错点离病因很远。
     */
    messages = [...messages, ...results]
  }

  return { frames: allFrames, messages, rounds, executed }
}

/* ---------- B. 服务端确实声明了四条（能力表来自工具总线，不是硬编码） ---------- */

const caps = jsonOf(await call('GET', '/api/ai/assistant/capabilities'))
const capTools = (caps['tools'] as string[] | undefined) ?? []
console.log('B. 能力表（capabilities）')
check(caps['available'] === true, '模型可用', JSON.stringify(caps).slice(0, 120))
check(
  capTools.includes('list_pages') && capTools.includes('search_kb') && capTools.includes('read_page'),
  '知识库三条在能力表里（服务端工具是这台服务器确定能做的）',
  `能力表：${capTools.join(', ')}`,
)
/*
 * ⚠️ **能力表刻意不含 `editor.*`，这不是缺陷。**
 *
 * `/api/ai/assistant/capabilities` 调的是 `resolveTurnTools(tools, principal, [])`
 * （`packages/plugin-ai-assistant/src/index.ts:204`）——第三个参数是**客户端上报的名单**，
 * 而能力探测时服务器根本不知道是哪个浏览器在问、它注册了哪些处理器。
 * 交集与空集相交必然为空，于是客户端工具**不进**这张表。
 *
 * 它们真正出现在哪里：**每一个回合的 `status` 帧**（那个请求带着 `clientTools`）。
 * 下一条断言钉的就是这一点——"能力表里没有"与"模型看不到"是两件事。
 */
check(
  !capTools.some((n) => n.startsWith('editor.')),
  '能力表里没有 editor.*（探测时没有客户端名单可交，交集必然为空——这是设计，不是漏）',
  `能力表：${capTools.join(', ')}`,
)

/* ---------- C. 交集：客户端只上报一条 ⇒ 只有一条进模型看到的工具表 ---------- */

console.log('\nC. 交集（收窄是安全属性）')
const narrow = await turn({
  messages: [{ role: 'user', content: '看一下我正在写什么' }],
  clientTools: ['editor.read_doc'],
  page: { slug: 'home', kind: 'edit' },
})
const narrowStatus = statusOf(narrow)
const narrowTools = (narrowStatus['tools'] as string[] | undefined) ?? []
const narrowAccepted = (narrowStatus['clientToolsAccepted'] as string[] | undefined) ?? []
check(
  narrowTools.includes('editor.read_doc') && !narrowTools.includes('editor.insert_text'),
  '只上报 read_doc 时，写工具**不在**模型看到的工具表里',
  `tools=${narrowTools.join(', ')}`,
)
check(
  narrowAccepted.length === 1 && narrowAccepted[0] === 'editor.read_doc',
  'status 帧如实报出"采纳了几个客户端工具"（收窄可见）',
  `accepted=${narrowAccepted.join(', ')}`,
)

/* ---------- D. 伪造：上报一个服务端没声明的名字，必须被丢掉 ---------- */

const forged = await turn({
  messages: [{ role: 'user', content: '你好' }],
  /*
   * 一个被改过的浏览器能声明任意名字。这不是假想：`clientTools` 是请求体里的**输入**，
   * 而它是"模型看到的工具表"的两项输入之一。
   */
  clientTools: ['editor.read_doc', 'admin.disable_plugin', '@geewiki/llm.rotate_key'],
})
const forgedStatus = statusOf(forged)
const forgedTools = (forgedStatus['tools'] as string[] | undefined) ?? []
const forgedAccepted = (forgedStatus['clientToolsAccepted'] as string[] | undefined) ?? []
console.log('D. 伪造未声明的客户端工具名')
check(
  !forgedTools.includes('admin.disable_plugin') && !forgedTools.includes('@geewiki/llm.rotate_key'),
  '未声明的名字**不进**模型看到的工具表',
  `tools=${forgedTools.join(', ')}`,
)
check(
  forgedAccepted.length === 1 && forgedAccepted[0] === 'editor.read_doc',
  'accepted 里也只有真正被采纳的那一条',
  `accepted=${forgedAccepted.join(', ')}`,
)

/* ---------- E. 真实回合：模型读草稿并写回（两半接起来的证据） ---------- */

console.log('\nE. 真实回合：让模型改编辑框')
editor.text = '# 草稿\n\n这里只有半句话'
editor.selection = null

const settled = await runUntilSettled(
  [
    {
      role: 'user',
      content:
        '我正在编辑一篇文章。请先读一下编辑框里现在的内容，然后用 editor.insert_text 把「—— 到此为止。」追加到光标处。',
    },
  ],
  clientToolNames(),
)

console.log(`   帧序：${settled.frames.map((f) => f.event).join(' → ').slice(0, 260)}`)
for (const f of settled.frames.filter((f) => f.event === 'tool')) {
  const mark = f.data['ok'] === null ? '▶' : f.data['ok'] === true ? '✓' : '✗'
  console.log(`   ${mark} ${String(f.data['name'])}(${String(f.data['arguments'])})`)
}
console.log(`   HTTP 回合数：${settled.rounds}   浏览器执行：${settled.executed.join(', ') || '(无)'}`)

check(
  settled.executed.includes('editor.read_doc'),
  '模型调了 editor.read_doc（先读再改）',
  settled.executed.join(', '),
)
check(
  settled.executed.includes('editor.insert_text'),
  '模型调了 editor.insert_text',
  settled.executed.join(', '),
)
check(
  settled.rounds >= 2,
  '这次提问用了**多个** HTTP 回合（客户端工具必须由浏览器执行后回灌）',
  `${settled.rounds} 个回合`,
)
check(
  settled.frames.filter((f) => f.event === 'done' || f.event === 'error').length === settled.rounds,
  '每个回合恰好一个终止帧',
  `${settled.rounds} 个回合 / ${settled.frames.filter((f) => f.event === 'done').length} 个 done`,
)
console.log(`   编辑框现状：${JSON.stringify(editor.text)}`)

check(
  editor.text.includes('到此为止'),
  '**编辑框真的被改了**（P3 的核心判据：模型 → SSE → 浏览器处理器 → 编辑框）',
  JSON.stringify(editor.text),
)

/*
 * 最后一轮的转录必须**没有孤儿 toolCall**：每个 `toolCalls[i].id` 都要有配对的
 * `role:'tool'` 结果。这是无状态协议里最容易漏、且报错点离病因最远的一条。
 */
const finalMessages = settled.messages
const callIds = finalMessages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id))
const resultIds = finalMessages.filter((m) => m.role === 'tool').map((m) => m.toolCallId ?? '')
check(
  callIds.every((id) => resultIds.includes(id)),
  '转录里没有孤儿 toolCall（每个调用都有配对结果）',
  `${callIds.length} 个调用 / ${resultIds.length} 个结果`,
)

disposeEditorTools()
check(clientToolNames().length === 0, '注销后工具全部从宿主名单消失（不留给下一个用户）')

/* ------------------------------ 汇总 ------------------------------ */

console.log(`\n读数：HTTP 回合 ${settled.rounds}  帧数 ${settled.frames.length}  浏览器执行 ${settled.executed.length} 次  编辑框 ${editor.text.length} 字`)

await cleanup()
if (failures.length > 0) {
  console.error(`\nFAIL：${failures.length} 条判据未过\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nPASS：P3 编辑框工具（服务端声明 ↔ 浏览器处理器，经真实 HTTP + 真实模型）全部判据通过')
