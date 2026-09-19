/**
 * P0 验收：**真实上游**的工具调用往返（有界智能体循环）。
 *
 * 单测用的是 mock 上游，钉的是"我以为的形状"；本脚本打的是 `config/plugins.base.json`
 * 里配置的那个真实端点（vLLM 承载的 DeepSeek V4 Flash），证的是四件事：
 *
 *   ① 工具表**真的发出去了**，且模型**真的按它产出了一次结构化工具调用**；
 *   ② 流式 `tool_calls` 分片能经 `assembleToolCalls` 拼成一份**合法 JSON** 的参数；
 *   ③ 把工具结果按契约（assistant.toolCalls + tool.toolCallId）**回灌**后，
 *      模型能继续推理 —— 即"多轮工具循环"真的闭合；
 *   ④ 循环**有界收敛**：它会在 N 轮内给出自然语言回答，而不是无限查下去。
 *
 * 为什么是"循环"而不是"两轮"：第一版脚本写死了两轮，实测**红了**——
 * 模型第一轮同时调了 list_pages 与 search_kb("新建内容")，而夹具里的字面检索
 * 对"新建内容"返回 0 命中（正文写的是"想写新内容…新建页面"），于是它**又查了一轮**。
 * 那是**正确行为**，不是缺陷：这一层的召回是字面匹配（真实系统同此，见
 * `data/verify/ai-native-probe/` 的 E2）。故验收要测的是"有界收敛"，不是"恰好两轮"。
 *
 * 用法：node --import tsx scripts/acceptance/p0-tools/run.ts
 *      （读 `config/plugins.base.json` 的 @geewiki/llm 条目 —— 本机 live 文件缺失时回退
 *        随版本发布的 `config/plugins.base.example.json`；另读 `config/secrets.json` 的密钥。
 *        没有可用密钥时**明确跳过并退出码 2**，而不是假装通过）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  assembleToolCalls,
  createLlmService,
  type LlmMessage,
  type LlmSettings,
  type LlmToolCall,
  type LlmToolCallDelta,
  type LlmToolDef,
} from '../../../packages/plugin-llm/src/index.js'
import { createOpenAiProvider } from '../../../packages/plugin-openai/src/provider.js'
import { readBaseList } from '../../lib/base-list.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

/** 循环轮数上限：真跑起来它收敛得远早于此；这个数是"卡住就承认卡住"，不是预期值 */
const MAX_ROUNDS = 5

/* ------------------------------ 读真实配置 ------------------------------ */

interface LlmEntry {
  provider?: string
  baseUrl?: string
  model?: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEffort?: string
  timeoutMs?: number
  includeUsage?: boolean
  extraBody?: string
  apiKeyEnv?: string
}

function readConfig(): { config: LlmEntry; apiKey: string } {
  // live 文件不入库，干净检出只有 example —— 回退口径见 scripts/lib/base-list.ts
  const base = readBaseList(resolve(repo, 'config'))
  const entry = (base.enabled ?? []).find((e) => e.name === '@geewiki/llm')
  if (entry === undefined) {
    throw new Error(
      '基础层清单（config/plugins.base.json，缺省时回退 config/plugins.base.example.json）里没有 @geewiki/llm 条目',
    )
  }
  const config = (entry.config ?? {}) as LlmEntry

  let apiKey = ''
  try {
    const secrets = JSON.parse(readFileSync(resolve(repo, 'config/secrets.json'), 'utf8')) as Record<
      string,
      { apiKey?: string } | undefined
    >
    apiKey = secrets['@geewiki/llm']?.apiKey ?? ''
  } catch {
    // 没有密钥文件不是错误：下面会走"明确跳过"的分支
  }
  return { config, apiKey }
}

const { config, apiKey } = readConfig()
if (apiKey === '') {
  console.log('SKIP：config/secrets.json 里没有 @geewiki/llm.apiKey，无法打真实上游。')
  console.log('     （这是一次**明确跳过**，不是通过 —— 本脚本的价值全在真实上游上。）')
  process.exit(2)
}

const settings: LlmSettings = {
  provider: config.provider ?? '',
  baseUrl: config.baseUrl ?? '',
  model: config.model ?? '',
  contextWindow: config.contextWindow ?? 128000,
  maxOutputTokens: config.maxOutputTokens ?? 4096,
  reasoningEffort: config.reasoningEffort !== undefined && config.reasoningEffort !== '' ? config.reasoningEffort : 'off',
  timeoutMs: config.timeoutMs ?? 60000,
  includeUsage: config.includeUsage ?? true,
  extraBody: config.extraBody ?? '',
  apiKeyEnv: config.apiKeyEnv ?? '',
}

const llm = createLlmService({ settings: () => settings })
llm.register(
  createOpenAiProvider({
    route: 'openai',
    label: '验收上游',
    description: 'P0 工具调用验收',
    defaults: { baseUrl: settings.baseUrl, model: settings.model },
    settings: () => settings,
    resolveApiKey: () => ({ ok: true, value: apiKey }),
  }),
)

/* ------------------------------ 工具定义 ------------------------------ */

const TOOLS: LlmToolDef[] = [
  {
    name: 'list_pages',
    description: '列出知识库中当前用户可见的全部页面标题与标识（slug）。不知道有哪些页面时先调用它。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_kb',
    description: '在知识库中做**字面**全文检索，返回命中的页面与片段。查询词必须是正文里可能逐字出现的短词。',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description: '检索词，越短越可能命中' } },
      required: ['q'],
    },
  },
  {
    name: 'read_page',
    description: '读取指定 slug 的页面全文。',
    parameters: {
      type: 'object',
      properties: { slug: { type: 'string', description: '页面标识' } },
      required: ['slug'],
    },
  },
]

const SYSTEM =
  '你是 GeeWiki 知识库的助手。需要了解知识库内容时必须调用工具，不要凭猜测回答。' +
  '字面检索经常返回空——那不代表知识库里没有，换更短、更可能逐字出现的词，或用 list_pages 看有哪些页面。' +
  '拿到足够资料后就用与提问相同的语言简洁作答，不要再无谓地查。'

/** 这一份"知识库"是脚本内的固定夹具，避免依赖某个特定库的当前内容 */
const FAKE_KB: Record<string, string> = {
  home: '主页：想写新内容，点右上角「新建页面」（需要编辑权限）。左侧栏是页面树，⌘K 打开命令面板。',
  'operations/backup': '备份：数据落在 data/geewiki.db；停服后复制该文件即可，恢复时反向覆盖。',
  'guide/intro': '入门：新建页面默认可见性是「组织」，且处于未发布状态；要让匿名可见必须同时改可见性并发布。',
}

function runTool(name: string, args: Record<string, unknown>): string {
  if (name === 'list_pages') return JSON.stringify(Object.keys(FAKE_KB))
  if (name === 'read_page') {
    const slug = String(args['slug'] ?? '')
    const text = FAKE_KB[slug]
    return text === undefined ? JSON.stringify({ error: `没有页面 ${slug}` }) : JSON.stringify({ slug, text })
  }
  if (name === 'search_kb') {
    const q = String(args['q'] ?? '')
    const hits = Object.entries(FAKE_KB)
      .filter(([, text]) => q !== '' && text.includes(q))
      .map(([slug, text]) => ({ slug, snippet: text.slice(0, 60) }))
    return JSON.stringify(hits)
  }
  return JSON.stringify({ error: `未知工具 ${name}` })
}

/* ------------------------------ 一轮 ------------------------------ */

interface TurnResult {
  text: string
  calls: readonly LlmToolCall[]
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number }
  /** 收到的 chunk 类型序列（去重相邻），用于证明流式形态确实如此 */
  shape: string[]
}

async function turn(messages: readonly LlmMessage[], label: string): Promise<TurnResult> {
  const deltas: LlmToolCallDelta[] = []
  let text = ''
  let finishReason: string | undefined
  let usage: TurnResult['usage']
  const shape: string[] = []

  for await (const chunk of llm.stream({ messages: [...messages], tools: TOOLS, maxTokens: 800 })) {
    if (chunk.type === 'status') {
      if (shape.at(-1) !== 'status') shape.push('status')
    } else if (chunk.type === 'text-delta') {
      text += chunk.text
      if (shape.at(-1) !== 'text-delta') shape.push('text-delta')
    } else if (chunk.type === 'tool-call-delta') {
      deltas.push(chunk)
      if (shape.at(-1) !== 'tool-call-delta') shape.push('tool-call-delta')
    } else if (chunk.type === 'done') {
      finishReason = chunk.finishReason
      usage = chunk.usage
    } else if (chunk.type === 'error') {
      throw new Error(`[${label}] 上游错误：${chunk.code}`)
    }
  }
  return { text, calls: assembleToolCalls(deltas), finishReason, usage, shape }
}

/* ------------------------------ 断言 ------------------------------ */

const failures: string[] = []
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

/* ------------------------------ 循环 ------------------------------ */

console.log(`上游：${settings.baseUrl}  模型：${settings.model}`)
console.log(`轮数上限：${MAX_ROUNDS}\n`)

const question = '主页上怎么新建内容？'
const messages: LlmMessage[] = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: question },
]

let totalCalls = 0
let answer = ''
let rounds = 0
let firstRound: TurnResult | undefined
const unknownTools: string[] = []
let badJson = 0

for (let round = 1; round <= MAX_ROUNDS; round++) {
  rounds = round
  const result = await turn(messages, `round-${round}`)
  firstRound ??= result

  console.log(`第 ${round} 轮  finishReason=${String(result.finishReason)}  chunk 形态=[${result.shape.join(' → ')}]`)
  if (result.text.trim() !== '') console.log(`  正文：${result.text.trim().slice(0, 160)}`)

  if (result.calls.length === 0) {
    answer = result.text.trim()
    break
  }

  const executions: string[] = []
  // assistant 那条消息带**全部**调用，只推一次（上游按一条消息里的 tool_calls 数组配对）
  messages.push({ role: 'assistant', content: result.text, toolCalls: result.calls })
  for (const call of result.calls) {
    totalCalls += 1
    if (!TOOLS.some((t) => t.name === call.name)) unknownTools.push(call.name)
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(call.arguments) as Record<string, unknown>
    } catch {
      badJson += 1
    }
    const out = runTool(call.name, parsed)
    executions.push(`  ${call.name}(${JSON.stringify(parsed)}) → ${out.slice(0, 70)}${out.length > 70 ? '…' : ''}`)
    messages.push({ role: 'tool', content: out, toolCallId: call.id })
  }
  console.log(executions.join('\n'))
  console.log('')
}

/* ------------------------------ 结论 ------------------------------ */

const first = firstRound
console.log('断言：')
check(first !== undefined && first.calls.length > 0, '模型产出了结构化工具调用（流式 tool_calls 分片收到了）')
check(first?.finishReason === 'tool_calls', 'finishReason 透传为 tool_calls', String(first?.finishReason))
check(
  first !== undefined && first.calls.every((c) => c.id !== ''),
  '每个调用都带 id（回灌时靠它配对）',
  first?.calls.map((c) => c.id).join(',') ?? '',
)
check(unknownTools.length === 0, '调用名都落在我们给出的工具表内（没有幻觉工具）', unknownTools.join(','))
check(badJson === 0, '拼装出的参数全部是合法 JSON（分片拼接正确）', `${badJson} 个坏 JSON`)
check(answer !== '', `循环在 ${MAX_ROUNDS} 轮内收敛到自然语言回答`, answer === '' ? '未收敛' : `用了 ${rounds} 轮`)
check(
  answer.includes('新建页面') || answer.includes('右上角') || answer.includes('编辑权限'),
  '回答用上了工具返回的**知识库内容**（不是凭空编的）',
  answer.slice(0, 60),
)
check(totalCalls > 0, '工具真的被执行了', `${totalCalls} 次`)

console.log(
  failures.length === 0
    ? `\nPASS：工具调用往返闭合 —— ${rounds} 个 LLM 轮次、${totalCalls} 次工具调用。`
    : `\nFAIL：${failures.length} 条未通过 —— ${failures.join('；')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
