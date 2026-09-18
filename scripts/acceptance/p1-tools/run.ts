/**
 * P1 验收：**真实实例 + 真实工具表 + 真实上游**。
 *
 * 与 P0 验收（`scripts/acceptance/p0-tools/run.ts`）的分工：
 * - P0 用手写的三工具表，证的是"工具调用契约通不通"；
 * - 本脚本起一个**真实例**（`startServer`，隔离端口/数据目录/清单目录），
 *   从 `ai-tool-service` 取**真实注册出来的工具表**（`@geewiki/ai-kb` 贡献的三条），
 *   把它们交给真模型，工具执行打的是**真的 `search-service` / `wiki-service`**。
 *
 * 因此它证的是整合：总线 → 提供者 → 会话循环 → 检索地基 → 权限裁剪，整条链。
 *
 * ## 验收判据（文档 §8.2 的 P1 行）
 * 「怎么新建内容」的**检索次数 ≤ 3**（对照 `data/verify/ai-native-probe/agent-loop.mjs`
 * 的实测基线：**5 轮 / 15 次检索**）。基线之所以那么贵，是因为模型不知道语料里用的是
 * 哪些词，只能反复盲猜——`list_pages` 这类"地图工具"正是冲着这一点去的。
 *
 * ## 为什么用真数据
 * 语料词汇是这条读数的自变量。用编造的夹具测"检索次数"等于测夹具，
 * 所以这里把 `data/geewiki.db` **复制**一份到临时目录再跑（原库只读，一个字节都不改）。
 *
 * 用法：node --import tsx scripts/acceptance/p1-tools/run.ts
 *      没有可用密钥时**明确跳过并退出码 2**，不假装通过。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
// 静态导入这两个是安全的：它们不依赖 GEEWIKI_DATA_DIR，也没有模块加载期副作用。
// 只有 @geewiki/server 必须延迟导入——它的 crashMarkerFile 在加载期就算出来了。
import { anonymousPrincipal } from '../../../packages/core/src/index.js'
import { assembleToolCalls, type LlmToolCallDelta } from '../../../packages/plugin-llm/src/index.js'

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

const work = mkdtempSync(join(tmpdir(), 'geewiki-p1-tools-'))
const configDir = join(work, 'config')
const dataDir = join(work, 'data')
mkdirSync(dataDir)

// 清单目录整份拷过来（含 secrets.json），只把基础层的启用集合改成本次需要的子集
cpSync(join(repo, 'config'), configDir, { recursive: true })
const base = JSON.parse(readFileSync(join(configDir, 'plugins.base.json'), 'utf8')) as {
  enabled: { name: string; config?: unknown }[]
}
/** 本次链路需要的插件：存储 → 策略 → 页面 → 检索 → 模型 → 工具总线 → 工具提供者 */
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
]
for (const name of NEEDED) {
  if (!base.enabled.some((e) => e.name === name)) {
    throw new Error(`基础层清单里没有 ${name} —— 本脚本的隔离清单需要它，请先确认 config/plugins.base.json`)
  }
}
base.enabled = base.enabled.filter((e) => NEEDED.includes(e.name))
writeFileSync(join(configDir, 'plugins.base.json'), JSON.stringify(base, null, 2) + '\n')

// 数据目录：复制真库（含 WAL/SHM），**绝不改动 data/geewiki.db**
const copied: string[] = []
for (const suffix of ['', '-wal', '-shm']) {
  const src = join(repo, 'data/geewiki.db' + suffix)
  if (existsSync(src)) {
    cpSync(src, join(dataDir, 'geewiki.db' + suffix))
    copied.push('geewiki.db' + suffix)
  }
}
console.log(`隔离环境：${work}`)
console.log(`数据目录：已复制 ${copied.join(', ')}\n`)

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

/* ------------------------------ 取真实工具表 ------------------------------ */

/*
 * 主体：已登录的组织成员（决策 5：只有登录用户会看到 AI 对话框）。
 *
 * `orgRole` 必须非 null —— 策略层对"组织级可见"的判据是
 * `kind === 'user' && orgRole !== null`（`packages/plugin-authz/src/index.ts:1093` 附近），
 * 少这一项会让所有 org 档页面变成不可见，而表现是"检索什么都 0 命中"。
 */
const PRINCIPAL = {
  kind: 'user' as const,
  userId: 1,
  orgId: 1,
  orgRole: 'owner' as const,
  groupIds: [] as number[],
  sessionId: null,
}

interface ToolLike {
  descriptor: { name: string; description: string; parameters: Record<string, unknown> }
  execute(principal: unknown, args: unknown): Promise<{ content: string }>
}

const toolSvc = app.get('ai-tool-service') as
  | { list(p: unknown): readonly ToolLike[]; diagnostics(): { count: number; mutating: readonly string[] } }
  | undefined
if (!toolSvc) throw new Error('ai-tool-service 没被 provide —— @geewiki/ai-tools 没激活？')

const tools = toolSvc.list(PRINCIPAL)
console.log(`工具表（${tools.length} 条）：${tools.map((t) => t.descriptor.name).join(', ')}`)
console.log(`diagnostics：${JSON.stringify(toolSvc.diagnostics())}\n`)

const llm = app.get('llm-service') as {
  availableProviders(): readonly { route: string; model: string }[]
  settings(): { model: string; baseUrl: string; provider: string }
  stream(req: unknown, opts?: unknown): AsyncIterable<{ type: string; text?: string; code?: string }>
}
// `LlmService` 上**没有** `available()` —— 可用性由 `availableProviders()` 回答
// （`available()` 在 `LlmProvider` 描述符上，是另一个层级的东西）。
const usable = llm.availableProviders()
if (usable.length === 0) {
  throw new Error('llm-service 没有可用路由 —— 检查 config/plugins.base.json 的 @geewiki/llm 与 secrets.json')
}
console.log(`可用路由：${usable.map((r) => `${r.route}(${r.model})`).join(', ')}\n`)

/* ------------------------------ 会话循环 ------------------------------ */

const SYSTEM =
  '你是 GeeWiki 知识库的助手。需要了解知识库内容时必须调用工具，不要凭猜测回答。' +
  '拿到足够资料后就用与提问相同的语言简洁作答。'

const QUESTION = '主页上怎么新建内容？'

const messages: {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: readonly { id: string; name: string; arguments: string }[]
  toolCallId?: string
}[] = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: QUESTION },
]

const MAX_ROUNDS = 6
const registryTools = tools.map((t) => t.descriptor)
let searchCalls = 0
let totalCalls = 0
let rounds = 0
let answer = ''
const trace: string[] = []

console.log(`上游：${llm.settings().baseUrl}  模型：${llm.settings().model}`)
console.log(`问题：${QUESTION}\n`)

for (let round = 1; round <= MAX_ROUNDS; round++) {
  rounds = round
  const deltas: LlmToolCallDelta[] = []
  let text = ''
  let finish: string | undefined
  for await (const chunk of llm.stream({ messages: [...messages], tools: registryTools, maxTokens: 800 })) {
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk.type === 'tool-call-delta') deltas.push(chunk as LlmToolCallDelta)
    else if (chunk.type === 'done') finish = (chunk as { finishReason?: string }).finishReason
    else if (chunk.type === 'error') throw new Error(`上游错误：${chunk.code}`)
  }
  const calls = assembleToolCalls(deltas)
  console.log(`第 ${round} 轮  finishReason=${String(finish)}  工具调用=${calls.length}`)

  if (calls.length === 0) {
    answer = text.trim()
    break
  }

  messages.push({ role: 'assistant', content: text, toolCalls: calls })
  for (const call of calls) {
    totalCalls += 1
    if (call.name === 'search_kb') searchCalls += 1
    const tool = tools.find((t) => t.descriptor.name === call.name)
    if (!tool) {
      const out = JSON.stringify({ error: `未知工具 ${call.name}` })
      trace.push(`${call.name} → 未知工具`)
      messages.push({ role: 'tool', content: out, toolCallId: call.id })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments)
    } catch {
      /* 坏 JSON 原样给 handler，由它报"缺少参数" */
      parsed = call.arguments
    }
    const result = await tool.execute(PRINCIPAL, parsed)
    const short = result.content.length > 90 ? result.content.slice(0, 90) + '…' : result.content
    trace.push(`  ${call.name}(${JSON.stringify(parsed)}) → ${short}`)
    messages.push({ role: 'tool', content: result.content, toolCallId: call.id })
  }
  console.log(trace.slice(-calls.length).join('\n'))
  console.log('')
}

/* ------------------------------ search_kb 的真实链路 ------------------------------ */

/*
 * 上面那一轮里模型**一次 `search_kb` 都没调**（`list_pages` + `read_page` 就够了）。
 * 但"模型这次没用它"绝不等于"它不通"——所以这里绕过模型，直接拿真工具打真索引，
 * 把 `search_kb` 的链路单独钉住。要钉两件事：它真的能命中，且命中片段是纯文本。
 */
const searchTool = tools.find((t) => t.descriptor.name === 'search_kb')
const probeHit = JSON.parse((await searchTool!.execute(PRINCIPAL, { q: '新建页面' })).content) as {
  total: number
  hits: { slug: string; snippet: string }[]
}
const probeMiss = JSON.parse((await searchTool!.execute(PRINCIPAL, { q: '怎么新建内容' })).content) as {
  total: number
  hits: unknown[]
  hint?: string
}
console.log(
  `\nsearch_kb 直查（绕过模型）：「新建页面」→ total=${probeHit.total}；「怎么新建内容」→ total=${probeMiss.total}`,
)

/* ------------------------------ 断言 ------------------------------ */

const failures: string[] = []
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

console.log('断言：')
check(tools.length === 3, '真实工具表里有 3 条工具', tools.map((t) => t.descriptor.name).join(', '))
check(
  ['list_pages', 'read_page', 'search_kb'].every((n) => tools.some((t) => t.descriptor.name === n)),
  'list_pages / search_kb / read_page 三条都在（真实注册，不是夹具）',
)
check(searchCalls <= 3, '检索次数 ≤ 3（基线 15）', `${searchCalls} 次`)
check(totalCalls <= 5, '工具调用总数 ≤ 5', `${totalCalls} 次`)
check(answer !== '', `循环在 ${MAX_ROUNDS} 轮内收敛`, answer === '' ? '未收敛' : `${rounds} 轮`)
check(
  /新建页面|右上角|编辑权限/.test(answer),
  '回答用上了知识库内容（不是凭空编的）',
  answer.slice(0, 70),
)
check(anonymousPrincipal().kind === 'anonymous', '匿名主体构造可用（权限链路的对照基准）')

// search_kb 的真实链路（绕过模型直接打索引）
check(probeHit.total >= 1, 'search_kb 在真实索引上命中（mode=terms 的链路通）', `total=${probeHit.total}`)
check(
  probeHit.hits.length > 0 && !/<mark>|&amp;|&lt;/.test(probeHit.hits[0]?.snippet ?? ''),
  '命中片段已降级成纯文本（无 <mark> 与 HTML 实体）',
  probeHit.hits[0]?.snippet?.slice(0, 50) ?? '(无命中)',
)
check(
  probeMiss.total > 0 || typeof probeMiss.hint === 'string',
  '0 命中时带回"换词再试"的提示（而不是让模型以为知识库里没有）',
  `total=${probeMiss.total} hint=${probeMiss.hint === undefined ? '无' : '有'}`,
)
check(
  probeHit.hits.every((h) => typeof h.slug === 'string'),
  ' 命中带 slug（模型能据此调 read_page）',
)

console.log(`\n工具轨迹：`)
for (const line of trace) console.log(line)
console.log(
  failures.length === 0
    ? `\nPASS：真实实例上 ${rounds} 轮 / ${totalCalls} 次工具调用（其中检索 ${searchCalls} 次）。`
    : `\nFAIL：${failures.length} 条未通过 —— ${failures.join('；')}`,
)

await cleanup()
process.exit(failures.length === 0 ? 0 : 1)
