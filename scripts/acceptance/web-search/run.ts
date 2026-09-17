/**
 * 联网搜索（`@geewiki/ai-web-search`）的验收脚本。
 *
 * ## 它验的是什么（单测验不到的那一段）
 *
 * 单测能证明"工具注册对了、参数校验对了、结果 JSON 形状对了"，但证明不了**这条工具
 * 真的会被模型用上**——那取决于工具描述写得好不好（模型的选择准确率）、工具表里
 * 它有没有出现、以及一次真回合里 `done` 帧到底报了什么出处。本脚本把这几件事接起来跑：
 *
 * 1. **能力表**：真实主体调 `GET /api/ai/assistant/capabilities`，`tools` 里必须有 `web_search`
 *    （工具在注册表里 ≠ 在模型看到的工具表里——后者还过一层主体过滤）；
 * 2. **真回合（联网）**：向生产端点 `POST /api/ai/turn` 提一个只有联网才知道的问题，
 *    断言模型真的调了 `web_search`、`done.grounded === false` 且
 *    `done.groundingSources` 含 `'web'`、回答里带可点的来源链接；
 * 3. **契约不变量**：两回合都断言 `grounded === groundingSources.includes('kb')`
 *    ——这是"kb 档"与"全部出处"两条判据的分工，漂了就会把"依据公开网络"渲染成
 *    "有知识库依据"（或反过来把联网答案说成"来自模型自身的知识"）。
 *
 * ## 隔离与主体
 *
 * 与 p3 验收同款：**复制 `config/` 与 `data/geewiki.db` 到临时目录**、用裁剪过的
 * 基础层清单起独立实例，绝不碰用户的运行实例。主体必须是一个真的 `user`（带
 * `org_members` 行）——break-glass 的 `orgRole` 是 null，用它验收会得到不可信的读数
 * （见 `scripts/acceptance/p3-editor-tools/run.ts` 里那段说明）。
 *
 * 无 `config/secrets.json` 里的 llm 密钥时**明确跳过**（exit 2），不是通过。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/* ------------------------------ 前置：真上游 ------------------------------ */

function hasApiKey(): boolean {
  try {
    const secrets = JSON.parse(readFileSync(join(repo, 'config', 'secrets.json'), 'utf8')) as Record<
      string,
      { apiKey?: string }
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

const work = mkdtempSync(join(tmpdir(), 'geewiki-web-search-'))
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
  '@geewiki/ai-web-search',
  '@geewiki/ai-assistant',
]
for (const name of NEEDED) {
  if (!base.enabled.some((e) => e.name === name)) {
    throw new Error(`基础层清单里没有 ${name} —— 请先确认 config/plugins.base.json`)
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
  pluginsDir: null, // 不发现外部插件
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
  text: string
}

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  // 会话 cookie + CSRF 头一起上：带会话 cookie 的写请求少了 CSRF 头会得到 csrf_rejected
  if (cookie !== '') headers['cookie'] = cookie
  headers['x-gw-csrf'] = '1'
  headers['origin'] = BASE
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie !== null) cookie = setCookie.split(';')[0] ?? cookie
  return { status: res.status, text: await res.text() }
}

function jsonOf(reply: Reply): Record<string, unknown> {
  try {
    return JSON.parse(reply.text) as Record<string, unknown>
  } catch {
    return {}
  }
}

interface Frame {
  event: string
  data: Record<string, unknown>
}

/** 极简 SSE 解码：本脚本只面对自己人对自己的输出 */
function parseFrames(text: string): Frame[] {
  const frames: Frame[] = []
  for (const block of text.split('\n\n')) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
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
 * 数据目录是 `data/geewiki.db` 的副本，里面已有账号而口令未知，故直接插一个口令已知的主体。
 * `org_members` 那一行不是装饰：它决定这个主体能不能看见 org 档页面（见 p3 脚本的说明）。
 */
const EMAIL = 'web-search@example.com'
const PASSWORD = 'web-search-password-1'

const { hashPassword } = await import('../../../packages/plugin-auth/src/password.js')
const db = app.get('db') as
  | {
      run(sql: string, params?: unknown[]): { lastInsertRowid: number | bigint }
      transaction<T>(fn: () => T): T
    }
  | undefined
if (!db) throw new Error("database-provider 不在（ctx.get('db') 取不到）")

const credential = await hashPassword(PASSWORD)
const now = new Date().toISOString()
const seededUserId = db.transaction(() => {
  const inserted = db.run(
    `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at)
     VALUES (?, ?, ?, 'active', 1, ?)`,
    [1, EMAIL, '联网搜索验收', now],
  )
  const userId = Number(inserted.lastInsertRowid)
  db.run(
    `INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, credential.algo, credential.params, credential.salt, credential.hash, now],
  )
  db.run(`INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, [1, userId, now])
  return userId
})

const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
if (login.status !== 200) {
  console.error(`登录失败（${login.status}）：${login.text}`)
  await cleanup()
  process.exit(1)
}
console.log(`建主体：userId=${seededUserId}  login=${login.status}\n`)

/* ------------------------------ 断言累计 ------------------------------ */

const failures: string[] = []
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

interface TurnResult {
  frames: Frame[]
  tools: string[]
  answer: string
  grounded: boolean | undefined
  sources: string[]
}

/**
 * 发一个真回合，抽出本次关心的四件事。
 *
 * 工具名单取**两处的并集**：SSE 的 `tool` 帧（执行期间逐条推）与 `done.toolResults`
 * （服务端对"这一回合执行过什么"的权威清单）。只看帧的话，某一帧被 SSE 分块切开
 * 就会漏掉一个已执行的调用——那是脚本的解析问题，不该被读成"模型没调工具"。
 */
async function turn(prompt: string): Promise<TurnResult> {
  const reply = await call('POST', '/api/ai/turn', { messages: [{ role: 'user', content: prompt }] })
  if (reply.status !== 200) throw new Error(`turn 非 200（${reply.status}）：${reply.text.slice(0, 300)}`)
  const frames = parseFrames(reply.text)
  const done = frames.filter((f) => f.event === 'done').at(-1)?.data
  const fromFrames = frames.filter((f) => f.event === 'tool').map((f) => String(f.data['name']))
  const results = Array.isArray(done?.['toolResults']) ? (done['toolResults'] as { name?: unknown }[]) : []
  const fromDone = results.map((r) => String(r.name))
  const tools = [...new Set([...fromFrames, ...fromDone])]
  const deltas = frames
    .filter((f) => f.event === 'delta')
    .map((f) => String(f.data['text'] ?? ''))
    .join('')
  const answer = deltas === '' ? String(done?.['answer'] ?? '') : deltas
  const sources = Array.isArray(done?.['groundingSources']) ? (done?.['groundingSources'] as string[]) : []
  return {
    frames,
    tools,
    answer,
    grounded: typeof done?.['grounded'] === 'boolean' ? (done['grounded'] as boolean) : undefined,
    sources,
  }
}

/* ============================== A. 能力表 ============================== */

console.log('A. 能力表（工具在注册表里 ≠ 在模型看到的工具表里）')
const capabilities = jsonOf(await call('GET', '/api/ai/assistant/capabilities'))
const capTools = Array.isArray(capabilities['tools']) ? (capabilities['tools'] as string[]) : []
check(capTools.includes('web_search'), '能力表里有 web_search', `tools=${capTools.join(', ')}`)
check(
  capabilities['available'] === true,
  '助手可用（缺模型或缺必需工具都会让它变 false）',
  `missing=${JSON.stringify(capabilities['missing'] ?? [])}`,
)

/* ============================== B. 真回合：联网 ============================== */

console.log('\nB. 真回合：只有联网才知道的问题')
const online = await turn('帮我上网查一下 AnySearch（anysearch.com）是做什么的？把来源链接给我。')
console.log(`  模型调用的工具：${online.tools.join(', ') || '(无)'}`)
console.log(`  grounded=${String(online.grounded)}  groundingSources=${JSON.stringify(online.sources)}`)
check(online.tools.includes('web_search'), '模型真的调用了 web_search（描述写得能被选中）')
check(
  online.sources.includes('web'),
  "done 帧的 groundingSources 含 'web'",
  JSON.stringify(online.sources),
)
check(
  online.grounded === false,
  'grounded 仍为 false —— 联网检索**不是**知识库依据',
  `grounded=${String(online.grounded)}`,
)
check(
  online.grounded === online.sources.includes('kb'),
  '不变量：grounded === groundingSources.includes("kb")',
  `grounded=${String(online.grounded)} sources=${JSON.stringify(online.sources)}`,
)
check(/https?:\/\//u.test(online.answer), '回答里给出了可点的来源链接', online.answer.slice(0, 120).replace(/\n/gu, ' '))

/* ============================== C. 真回合：知识库内 ============================== */

console.log('\nC. 真回合：知识库内的问题（kb 档不受影响）')
const internal = await turn('知识库里有哪些页面？只列 slug 和标题。')
console.log(`  模型调用的工具：${internal.tools.join(', ') || '(无)'}`)
console.log(`  grounded=${String(internal.grounded)}  groundingSources=${JSON.stringify(internal.sources)}`)
check(
  internal.grounded === internal.sources.includes('kb'),
  '不变量在知识库回合同样成立',
  `grounded=${String(internal.grounded)} sources=${JSON.stringify(internal.sources)}`,
)
check(internal.tools.includes('list_pages'), '知识库工具照常可用（模型调了 list_pages）', internal.tools.join(', ') || '(无)')
check(
  internal.sources.includes('web') === false,
  '只是列页面（list_pages）不该产生任何联网依据',
  JSON.stringify(internal.sources),
)

/* ============================== 收尾 ============================== */

await cleanup()
console.log('')
if (failures.length === 0) {
  console.log('PASS：联网搜索工具在真实链路上可用，且依据分档正确。')
  process.exit(0)
}
console.log(`FAIL（${failures.length}）：`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
