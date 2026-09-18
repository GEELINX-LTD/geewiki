/**
 * 端到端验收：**AI 拆分为「AI 辅助写作」+「AI 问答」两个插件**后的真实行为。
 *
 * 与 `data/verify/openai-e2e/run.mjs` 同一套隔离手法（独立 config/data 目录 + 本地 mock
 * 上游扮演 OpenAI 兼容端点）：走真实的 HTTP / SSE / 配置 / 管理器激活路径，只有"模型本身"
 * 是假的。用 mock 而不是真密钥，是因为本批要断言的是**状态码与帧序列**这些必须在缺模型 /
 * 限流 / 无资料三种条件下可复现的东西 —— 真实上游给不给 429 是不可控的。
 *
 * 本脚本刻意覆盖"没有模型"这前半段：那正是本批改动的核心（旧形态在这里返回抽取式摘要，
 * 新形态必须**显式不可用**）。
 *
 * 注意：隔离实例用 instance/ 子目录（不能用脚本自身目录——收尾清理会连带删除它）。
 */
import { spawn } from 'node:child_process'
import { startMockUpstream, ANSWER } from './mock-upstream.mjs'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根从脚本自身位置推出：写死绝对路径的脚本换一台机器只会报"启动失败"
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const PORT = 3433
const MOCK_PORT = 3457
const ROOT = join(REPO, 'data/verify/ai-split-e2e/instance')
const ENV_NAME = 'GEEWIKI_E2E_SPLIT_KEY'
const ENV_VALUE = 'sk-e2e-split-0123456789abcdef'
// 上游模型走**共享**的确定性假实现（`mock-upstream.mjs`）——两个验收脚本必须用同一份，
// 否则"后端契约绿、浏览器侧红"这类差异根本分不清是被测方还是夹具的锅。
const mock = await startMockUpstream(MOCK_PORT)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = 'http://127.0.0.1:' + PORT

let cookie = ''
/** 管理员动作（启用插件）走应急通道头；内容动作走会话 cookie */
const ADMIN_TOKEN = 'e2e-split-break-glass-token'
function headersFor(write) {
  const h = {}
  if (write) h['content-type'] = 'application/json'
  if (cookie !== '') {
    h.cookie = cookie
    // 同源写路径的 CSRF 约定（见 plugin-auth）：已带会话时缺这个头会被拒
    if (write) h['x-gw-csrf'] = '1'
  }
  return h
}

async function j(method, path, body, extraHeaders) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...headersFor(body !== undefined), ...(extraHeaders ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text.slice(0, 240)
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: parsed }
}

/** 读整条 SSE 响应，返回按到达顺序排列的帧（断言"status 必为首帧、终止帧恰一帧且在末位"） */
async function sse(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: headersFor(true),
    body: JSON.stringify(body),
  })
  const ctype = res.headers.get('content-type') ?? ''
  if (!ctype.includes('text/event-stream')) {
    return { status: res.status, contentType: ctype, frames: null, text: await res.text() }
  }
  const raw = await res.text()
  const frames = []
  for (const block of raw.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.*)$/m.exec(block)?.[1]
    if (!name) continue
    let parsed
    try {
      parsed = JSON.parse(data ?? 'null')
    } catch {
      parsed = data
    }
    frames.push({ event: name, data: parsed })
  }
  return { status: res.status, contentType: ctype, frames }
}

const out = {}
let server
try {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'config'), { recursive: true })
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  writeFileSync(
    join(ROOT, 'config/plugins.base.json'),
    JSON.stringify(
      {
        // 与真实基础层同构：**必须**带 auth/org/authz。
        // 少了 authz 就没有 `policy-service`，辅助写作会**按设计失败关闭**（403）——
        // 那是正确行为，不是本脚本想测的东西（它测的是"有没有模型"这条线）。
        enabled: [
          { name: '@geewiki/db-sqlite' },
          { name: '@geewiki/http' },
          { name: '@geewiki/auth' },
          { name: '@geewiki/org' },
          { name: '@geewiki/authz' },
          { name: '@geewiki/wiki' },
          { name: '@geewiki/search' },
          /*
           * 模型侧**刻意不配密钥**：本脚本的前半段就是要在"路由已注册但没有凭据"的条件下跑
           * （那正是缺模型时最容易骗人的那条路径）。密钥在阶段 B 用
           * `PUT /api/plugins/@geewiki/llm/config` 现补，与用户在「模型接入」里填密钥同一路径。
           */
          {
            name: '@geewiki/llm',
            config: {
              provider: 'openai',
              baseUrl: 'http://127.0.0.1:' + MOCK_PORT + '/v1',
              apiKey: '',
              model: 'mock-model',
              apiKeyEnv: '',
              reasoningEffort: '',
              contextWindow: 32000,
              maxOutputTokens: 1024,
              timeoutMs: 15000,
              includeUsage: true,
              extraBody: '',
            },
          },
          { name: '@geewiki/openai' },
          { name: '@geewiki/ai-assist' },
          { name: '@geewiki/ai-qa' },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(ROOT, 'config/plugins.session.json'), JSON.stringify({ enabled: [] }, null, 2) + '\n')

  server = spawn('node', ['--import', 'tsx', 'packages/server/src/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      GEEWIKI_PORT: String(PORT),
      GEEWIKI_CONFIG_DIR: join(ROOT, 'config'),
      GEEWIKI_DATA_DIR: join(ROOT, 'data'),
      GEEWIKI_PLUGINS_DIR: join(ROOT, 'plugins'),
      GEEWIKI_PLUGIN_UI_DIST: join(REPO, 'packages/web/public'),
      GEEWIKI_ADMIN_TOKEN: ADMIN_TOKEN,
      [ENV_NAME]: ENV_VALUE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  server.stdout.on('data', (d) => logs.push(String(d)))
  server.stderr.on('data', (d) => logs.push(String(d)))

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(BASE + '/api/health')
      if (res.ok) break
    } catch {
      /* 未就绪 */
    }
    await sleep(300)
  }
  out.health = (await j('GET', '/api/health')).status
  out.plugins = (await j('GET', '/api/plugins')).body.plugins
    .filter((p) => /@geewiki\/(ai|llm|search)/.test(p.name))
    .map((p) => p.name + ':' + p.state)

  /* ---- 建立主体：owner 首启 + 登录（辅助写作要求 `kind==='user'` 的编辑权，应急主体不算） ---- */
  out.setup = (
    await j('POST', '/api/auth/setup', { email: 'owner@e2e.test', password: 'E2e-Owner-2026-pw', displayName: 'E2E Owner' })
  ).status
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@e2e.test', password: 'E2e-Owner-2026-pw' }),
  })
  const setCookie = loginRes.headers.get('set-cookie')
  cookie = (setCookie ?? '').split(';')[0]
  out.login = { status: loginRes.status, hasCookie: cookie !== '' }

  out.putPage = (
    await j('PUT', '/api/pages/rag-e2e', {
      title: '检索增强问答',
      content: '检索增强问答先用全文检索召回相关片段，再交给大模型生成带引用的答案。检索增强怎么做？这是常见问题。',
    })
  ).status

  /* ================= 阶段 A：**没有模型**（本批的核心改动） ================= */

  out.A_capsQa = await j('GET', '/api/ai/capabilities')
  out.A_capsAssist = await j('GET', '/api/ai/assist/capabilities')
  /*
   * 期望值写在这里，让输出**自带对照**（本仓库的验收脚本都要能被别人复跑并逐字段核对）：
   * **503 = 前置条件不满足**（根本没调用模型），**502 = 上游真的失败**。
   */
  const askNoModel = await j('POST', '/api/ai/ask', { q: '检索增强怎么做' })
  out.A_ask = {
    status: askNoModel.status,
    expectStatus: 503,
    error: askNoModel.body?.error,
    hasDegraded: !!askNoModel.body?.degraded,
    hasAnswerField: 'answer' in (askNoModel.body ?? {}),
    messageLeaksKey: String(askNoModel.body?.message ?? '').includes(ENV_VALUE),
  }
  const streamNoModel = await sse('/api/ai/stream', { q: '检索增强怎么做' })
  out.A_stream = {
    status: streamNoModel.status,
    expectStatus: 503,
    contentType: streamNoModel.contentType.split(';')[0],
    // 必须是**普通 JSON**：绝不允许先写 SSE 头再用事件表达"根本没开始"
    isEventStream: streamNoModel.contentType.includes('text/event-stream'),
    frames: streamNoModel.frames,
  }
  const assistNoModel = await j('POST', '/api/ai/assist', {
    action: 'continue',
    before: '这一节先介绍背景。',
    title: '检索增强问答',
  })
  out.A_assist = {
    status: assistNoModel.status,
    expectStatus: 503,
    mode: assistNoModel.body?.mode,
    text: assistNoModel.body?.text,
    hasDegraded: !!assistNoModel.body?.degraded,
  }
  // **一次上游调用都没有**：缺模型时不该白跑检索与生成（旧形态会先跑检索再拼摘要）
  out.A_mockCalls = mock.state.requests.length

  /* ================= 阶段 B：启用 adapter（mock 上游） ================= */

  /*
   * 补上密钥 —— 走的是管理台保存配置那同一个端点（`PUT /api/plugins/:name/config`），
   * 密钥由管理器落进隔离目录里的 `config/secrets.json`，**不进入库的配置**。
   */
  out.setApiKey = await j(
    'PUT',
    '/api/plugins/' + encodeURIComponent('@geewiki/llm') + '/config',
    /*
     * 必须**整份**提交：`PUT /api/plugins/:name/config` 是**替换**语义（实测只发 apiKey 会把
     * baseUrl/model 抹成 schema 默认值 ⇒ 适配器回落到自己的默认端点 ⇒ NETWORK）。
     * 管理台表单之所以能只发改动项，是因为它总是先读回现值再整份提交。
     */
    {
      config: {
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:' + MOCK_PORT + '/v1',
        apiKey: ENV_VALUE,
        model: 'mock-model',
        apiKeyEnv: '',
        reasoningEffort: '',
        contextWindow: 32000,
        maxOutputTokens: 1024,
        timeoutMs: 15000,
        includeUsage: true,
        extraBody: '',
      },
    },
    { 'x-gw-admin-token': ADMIN_TOKEN },
  )
  out.llmConfigEcho = (() => {
    const cfg = out.setApiKey.body?.plugin?.config ?? out.setApiKey.body?.config ?? {}
    return { apiKeyEchoed: cfg.apiKey !== '' && cfg.apiKey !== undefined, baseUrl: cfg.baseUrl, model: cfg.model }
  })()
  out.B_capsQa = await j('GET', '/api/ai/capabilities')
  out.B_capsAssist = await j('GET', '/api/ai/assist/capabilities')

  const ask = await j('POST', '/api/ai/ask', { q: '检索增强怎么做' })
  out.B_ask = {
    status: ask.status,
    mode: ask.body?.mode,
    answer: ask.body?.answer,
    answerIsModelOutput: ask.body?.answer === ANSWER,
    degraded: ask.body?.degraded ?? null,
    partial: ask.body?.partial,
    usage: ask.body?.usage,
    retrieval: ask.body?.retrieval,
    sources: (ask.body?.sources ?? []).map((s) => `n=${s.n} ${s.slug} used=${s.used}`),
  }
  out.B_prompt = (() => {
    const raw = mock.state.requests.at(-1)
    if (!raw) return null
    const p = JSON.parse(raw)
    const system = p.messages?.[0]?.content ?? ''
    const user = p.messages?.[1]?.content ?? ''
    return {
      stream: p.stream,
      hasCitationRule: system.includes('[n]'),
      forbidsFabrication: system.includes('不要编造'),
      requiresAdmittingGap: system.includes('资料不足'),
      userHasContextMarker: user.includes('资料：'),
      userHasSlug: user.includes('rag-e2e'),
      userHasCitedNumber: /\[1\]/.test(user),
    }
  })()

  /* ---- 限流：一个 token 都没有 ⇒ 502 generation_failed（旧形态会冒充答案） ---- */
  await fetch('http://127.0.0.1:' + MOCK_PORT + '/__mode?m=429')
  const ask429 = await j('POST', '/api/ai/ask', { q: '检索增强怎么做' })
  out.B_ask429 = {
    status: ask429.status,
    error: ask429.body?.error,
    degradedCode: ask429.body?.degraded?.code ?? null,
    degradedReason: ask429.body?.degraded?.reason ?? null,
    hasAnswerField: 'answer' in (ask429.body ?? {}),
    messageLeaksKey: String(ask429.body?.message ?? '').includes(ENV_VALUE),
  }

  /* ---- 上游"成功但空输出" ⇒ 同样是 502，不是 200 + null ---- */
  await fetch('http://127.0.0.1:' + MOCK_PORT + '/__mode?m=empty')
  const askEmpty = await j('POST', '/api/ai/ask', { q: '检索增强怎么做' })
  out.B_askEmpty = { status: askEmpty.status, error: askEmpty.body?.error, degradedCode: askEmpty.body?.degraded?.code ?? null }
  await fetch('http://127.0.0.1:' + MOCK_PORT + '/__mode?m=ok')

  /* ---- 检索 0 命中 ⇒ 200 no-context，且**不调用模型** ---- */
  const callsBefore = mock.state.requests.length
  const askMiss = await j('POST', '/api/ai/ask', { q: ' zzqqxx 完全不存在的词组 kwerty ' })
  out.B_askNoContext = {
    status: askMiss.status,
    mode: askMiss.body?.mode,
    answer: askMiss.body?.answer,
    sourcesCount: (askMiss.body?.sources ?? []).length,
    retrievalTotal: askMiss.body?.retrieval?.total,
    modelCalled: mock.state.requests.length > callsBefore,
  }

  /* ---- 流式：帧序列不变量 ---- */
  const stream = await sse('/api/ai/stream', { q: '检索增强怎么做' })
  const events = (stream.frames ?? []).map((f) => f.event)
  out.B_stream = {
    status: stream.status,
    contentType: stream.contentType.split(';')[0],
    events,
    firstIsStatus: events[0] === 'status',
    terminalCount: events.filter((e) => e === 'done' || e === 'error').length,
    terminalIsLast: ['done', 'error'].includes(events.at(-1) ?? ''),
    doneMode: stream.frames?.find((f) => f.event === 'done')?.data?.mode,
    statusMode: stream.frames?.find((f) => f.event === 'status')?.data?.mode,
    statusSourceCount: (stream.frames?.find((f) => f.event === 'status')?.data?.sources ?? []).length,
    deltas: stream.frames?.filter((f) => f.event === 'delta').length,
  }

  /* ---- 流式的缺资料路径：status{no-context} + done{answer:null}，且不调用模型 ---- */
  const callsBefore2 = mock.state.requests.length
  const streamMiss = await sse('/api/ai/stream', { q: ' zzqqxx 完全不存在的词组 kwerty ' })
  out.B_streamNoContext = {
    status: streamMiss.status,
    events: (streamMiss.frames ?? []).map((f) => f.event),
    statusMode: streamMiss.frames?.find((f) => f.event === 'status')?.data?.mode,
    doneAnswer: streamMiss.frames?.find((f) => f.event === 'done')?.data?.answer,
    modelCalled: mock.state.requests.length > callsBefore2,
  }

  /* ---- 流式的失败路径：终止帧是 error，不是 done ---- */
  await fetch('http://127.0.0.1:' + MOCK_PORT + '/__mode?m=429')
  const streamFail = await sse('/api/ai/stream', { q: '检索增强怎么做' })
  out.B_streamErrorFrame = {
    status: streamFail.status,
    events: (streamFail.frames ?? []).map((f) => f.event),
    lastFrame: streamFail.frames?.at(-1)?.data,
  }
  await fetch('http://127.0.0.1:' + MOCK_PORT + '/__mode?m=ok')

  /* ---- 参数校验与取消面（400 一律普通 JSON，绝不进入 SSE） ---- */
  out.B_streamEmptyQuery = await sse('/api/ai/stream', { q: '   ' })
  out.B_streamUnknownField = await sse('/api/ai/stream', { q: 'x', foo: 1 })

  /* ---- 辅助写作 ---- */
  const assist = await j('POST', '/api/ai/assist', {
    action: 'continue',
    before: '检索增强问答先用全文检索召回相关片段，',
    title: '检索增强问答',
  })
  out.B_assist = {
    status: assist.status,
    mode: assist.body?.mode,
    action: assist.body?.action,
    textIsModelOutput: assist.body?.text === ANSWER,
    degraded: assist.body?.degraded ?? null,
  }
  out.B_assistNeedsSelection = await j('POST', '/api/ai/assist', { action: 'polish', title: 'x' })
  out.B_assistTooLong = await j('POST', '/api/ai/assist', { action: 'continue', before: '字'.repeat(4001) })

  /* ================= 阶段 C：前端贡献（插槽与入口表） ================= */
  const uiTable = await j('GET', '/api/plugins/ui')
  out.C_uiTableRaw = {
    status: uiTable.status,
    keys: Object.keys(uiTable.body ?? {}).slice(0, 8),
    sample: JSON.stringify(uiTable.body).slice(0, 300),
  }
  // 入口表是**按插件名索引的对象**（`{plugins: {'@geewiki/ai-qa': {entry, css, rev, slots}}}`）
  const uiEntries = Object.entries(uiTable.body?.plugins ?? {}).map(([name, meta]) => ({ name, ...meta }))
  out.C_uiTable = uiEntries
    .filter((e) => /@geewiki\/ai/.test(String(e.name)))
    .map((e) => ({ name: e.name, slots: e.slots, rev: String(e.rev ?? '').slice(0, 8), entry: e.entry }))
  out.C_uiSkipped = (Array.isArray(uiTable.body?.skipped) ? uiTable.body.skipped : []).filter((x) =>
    /@geewiki\/ai/.test(String(x.name ?? x)),
  )

  const slotTable = await j('GET', '/api/plugins/slots')
  out.C_slotsRaw = { status: slotTable.status, sample: JSON.stringify(slotTable.body).slice(0, 300) }
  const assignments = Array.isArray(slotTable.body?.slots) ? slotTable.body.slots : []
  out.C_slots = assignments
    .filter((a) => ['wiki-ask', 'editor-toolbar'].includes(a.slot))
    .map((a) => `${a.slot}:${a.cardinality}:effective=${JSON.stringify(a.effective)}`)
  out.C_uiBundlesBuilt = {
    assist: existsSync(join(REPO, 'packages/web/public/plugins-ui/@geewiki/ai-assist/client.js')),
    qa: existsSync(join(REPO, 'packages/web/public/plugins-ui/@geewiki/ai-qa/client.js')),
  }
  out.C_assets = out.C_uiBundlesBuilt.qa
    ? {
        js: (await fetch(BASE + '/plugins-ui/@geewiki/ai-qa/client.js')).status,
        jsType: (await fetch(BASE + '/plugins-ui/@geewiki/ai-qa/client.js')).headers.get('content-type'),
      }
    : null

  out.keyLeakedInLogs = logs.join('').includes(ENV_VALUE)
  out.aiLogLines = logs.join('').split('\n').filter((l) => l.includes('ai-qa') || l.includes('ai-assist')).slice(0, 6)
} catch (err) {
  out.error = String(err?.stack ?? err)
} finally {
  if (server) server.kill('SIGKILL')
  mock.server.close()
  await sleep(200)
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(JSON.stringify(out, null, 2))
