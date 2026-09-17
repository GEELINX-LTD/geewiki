/**
 * P2b 验收：**真实 HTTP 端点 + 真实会话 cookie + 真实工具表 + 真实上游**。
 *
 * 与 P0 / P1 验收的分工：
 * - P0（`scripts/acceptance/p0-tools/run.ts`）用手写工具表，证的是"工具调用契约通不通"；
 * - P1（`scripts/acceptance/p1-tools/run.ts`）在**进程内**直接喂 `llm.stream()`，
 *   证的是"总线 → 提供者 → 会话循环 → 检索地基 → 权限裁剪"这条链；
 * - 本脚本打的是 **`POST /api/ai/turn`** 这唯一的真实入口：会话解析、CSRF、SSE 帧、
 *   工具执行、转录回填全部走生产路径。**它是 P2b 唯一"整条在跑"的证据**——
 *   单测把每一段都钉住了，但没有任何一条单测能证明这些段接得上。
 *
 * ## 验收判据（设计文档 §8.2 的 P2 行 + 决策 5）
 * 1. **匿名 401**（决策 5：对话框只对登录用户渲染）——且必须是**未写 SSE 头之前的普通 JSON**，
 *    否则前端拿到的是"200 的空流"，看起来像模型没说话。
 * 2. 帧序合法：`status` 必为第一帧，**恰好一个**终止帧且在最末位。
 * 3. 真实模型在真实知识库上收敛，且答案用上了库里的内容（不是凭空编的）。
 * 4. `done.messages` 是**权威转录**：每个带 `toolCalls` 的助手消息，都有按 `toolCallId`
 *    配对的工具结果——孤儿调用会让下一回合被上游 400，而报错点离病因很远。
 *
 * ## 为什么用真数据
 * 语料词汇是这条读数的自变量（见 §8.4）。这里把 `data/geewiki.db` **复制**一份到临时目录
 * 再跑：原库只读，一个字节都不改。
 *
 * 用法：node --import tsx scripts/acceptance/p2b-turn/run.ts
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

const work = mkdtempSync(join(tmpdir(), 'geewiki-p2b-turn-'))
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
 * 口令我们不知道。所以这里直接往副本里插一个口令已知的主体。
 *
 * **为什么必须是 `user` 而不是 `break-glass`**：本仓的实测发现（探针 E5）——
 * break-glass 的 `orgRole` 是 null，而策略层判"组织级可见"要求
 * `kind === 'user' && orgRole !== null`，于是同一条限制内容在"页面读"路径上 404、
 * 在"检索"路径上却命中。用它验收会得到一份**不可信**的读数。
 * 所以 org_members 那一行不是装饰，它决定了这个主体能不能看见 org 档页面。
 */
const EMAIL = 'p2b-turn@example.com'
const PASSWORD = 'p2b-turn-password-1'

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
    [1, EMAIL, 'P2B 验收', now],
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

/* ------------------------------ A. 匿名必须 401（决策 5） ------------------------------ */

const anonymousTurn = await call(
  'POST',
  '/api/ai/turn',
  { messages: [{ role: 'user', content: '你好' }] },
  false,
)
const anonymousBody = jsonOf(anonymousTurn)
console.log('A. 匿名访问')
check(anonymousTurn.status === 401, '匿名 POST /api/ai/turn 得到 401', `实际 ${anonymousTurn.status}`)
check(
  !(anonymousTurn.headers.get('content-type') ?? '').includes('text/event-stream'),
  '被拒时返回的是普通 JSON，**不是** SSE 流（前端不会拿到"200 的空流"）',
  anonymousTurn.headers.get('content-type') ?? '(无 content-type)',
)
check(
  typeof anonymousBody['error'] === 'string',
  '响应体带稳定错误码（前端按 code 分支，不按 message）',
  String(anonymousBody['error']),
)
console.log('')

/* ------------------------------ B. 未知字段必须 400 ------------------------------ */

const unknownField = await call('POST', '/api/ai/turn', {
  messages: [{ role: 'user', content: '你好' }],
  nonsense: 1,
})
const unknownBody = jsonOf(unknownField)
console.log('B. 契约收紧')
check(unknownField.status === 400, '带未知字段得到 400', `实际 ${unknownField.status}`)
check(
  unknownBody['error'] === 'invalid_body' && String(unknownBody['message'] ?? '').includes('nonsense'),
  '错误码是 invalid_body 且点名了那个字段',
  String(unknownBody['message'] ?? ''),
)
const badPage = await call('POST', '/api/ai/turn', {
  messages: [{ role: 'user', content: '你好' }],
  page: 'not-an-object',
})
check(
  badPage.status !== 400,
  '非法 page 折算成 null 而**不是** 400（它是附加线索，不是必要输入）',
  `实际 ${badPage.status}`,
)
console.log('')

/* ------------------------------ C. 真实回合 ------------------------------ */

const QUESTION = '主页上怎么新建内容？'
console.log(`C. 真实回合：${QUESTION}`)
const turnReply = await call('POST', '/api/ai/turn', {
  messages: [{ role: 'user', content: QUESTION }],
  clientTools: [],
  round: 1,
  page: { slug: 'home', title: '首页' },
})
console.log(`   HTTP ${turnReply.status}  content-type=${turnReply.headers.get('content-type') ?? '(无)'}`)

const frames = parseFrames(turnReply.text)
const names = frames.map((f) => f.event)
const terminal = frames.filter((f) => f.event === 'done' || f.event === 'error')
const done = frames.find((f) => f.event === 'done')
const toolFrames = frames.filter((f) => f.event === 'tool')
const answer = typeof done?.data['answer'] === 'string' ? (done.data['answer'] as string) : ''

console.log(`   帧序：${names.join(' → ')}`)
for (const frame of toolFrames) {
  const d = frame.data
  console.log(`   tool ${String(d['name'])}(${String(d['arguments']).slice(0, 60)}) ok=${String(d['ok'])}`)
}
console.log(`   回答：${answer.replace(/\n+/g, ' ').slice(0, 120)}\n`)

check(turnReply.status === 200, '真实回合 HTTP 200', `实际 ${turnReply.status}`)
check(
  (turnReply.headers.get('content-type') ?? '').includes('text/event-stream'),
  '成功路径确实是 SSE',
  turnReply.headers.get('content-type') ?? '(无)',
)
check(frames.length > 0, '至少收到一帧', `${frames.length} 帧`)
check(names[0] === 'status', '首帧必为 status', names[0] ?? '(无)')
check(
  terminal.length === 1 && names[names.length - 1] === terminal[0]?.event,
  '恰好一个终止帧且在最末位',
  names.join(','),
)
check(done !== undefined, '正常收敛为 done（不是 error）', terminal[0]?.event ?? '(无终止帧)')
check(toolFrames.length >= 1, '模型真的调了工具（不是凭先验知识硬答）', `${toolFrames.length} 条 tool 帧`)

const statusFrame = frames.find((f) => f.event === 'status')
const offered = (statusFrame?.data['tools'] ?? []) as readonly string[]
check(
  Array.isArray(offered) && offered.includes('read_page') && offered.includes('list_pages'),
  'status 帧首帧就告诉界面"这一轮有哪些工具"',
  offered.join(', '),
)

/* 转录完整性：每个 toolCall 都要有配对结果 */
interface TranscriptMessage {
  role: string
  toolCalls?: readonly { id: string; name: string }[]
  toolCallId?: string
  content: string
}
const transcript = (done?.data['messages'] ?? []) as readonly TranscriptMessage[]
const orphan: string[] = []
for (const message of transcript) {
  for (const call of message.toolCalls ?? []) {
    if (!transcript.some((m) => m.role === 'tool' && m.toolCallId === call.id)) orphan.push(call.id)
  }
}
check(transcript.length > 0, 'done.messages 带回权威转录', `${transcript.length} 条消息`)
check(orphan.length === 0, '每个 toolCall 都有配对结果（孤儿调用会让下一回合被上游 400）', orphan.join(', ') || '无孤儿')
check(
  transcript[0]?.role === 'user' && transcript[transcript.length - 1]?.role === 'assistant',
  '转录以 user 开头、以 assistant 收尾（可直接作为下一回合的输入）',
  `${transcript[0]?.role ?? '?'} … ${transcript[transcript.length - 1]?.role ?? '?'}`,
)
check(
  /新建页面|右上角|编辑权限|新建/.test(answer),
  '回答用上了知识库内容（不是凭空编的）',
  answer.replace(/\n+/g, ' ').slice(0, 60),
)
check(done?.data['partial'] === false, '这一轮不是"半截回答"', `partial=${String(done?.data['partial'])}`)
console.log('')

/* ------------------------------ D. capabilities ------------------------------ */

const caps = await call('GET', '/api/ai/assistant/capabilities')
const capsBody = jsonOf(caps)
console.log('D. capabilities')
check(caps.status === 200, 'GET /api/ai/assistant/capabilities 200', `实际 ${caps.status}`)
check(capsBody['available'] === true, 'available=true（模型与工具总线都在位）', JSON.stringify(capsBody).slice(0, 120))
console.log('')

/* ------------------------------ 收尾 ------------------------------ */

const rounds = typeof done?.data['rounds'] === 'number' ? (done.data['rounds'] as number) : 0
console.log(`读数：LLM 轮次 ${rounds}  工具调用 ${toolFrames.length}  帧数 ${frames.length}  回答 ${answer.length} 字`)

await cleanup()

if (failures.length > 0) {
  console.log(`\nFAIL：${failures.length} 条断言未通过`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\nPASS：P2b 真实链路（HTTP → 会话 → SSE → 工具总线 → 真实模型）全部判据通过')
