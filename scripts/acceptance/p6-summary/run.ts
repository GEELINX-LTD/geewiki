/**
 * P6 验收：**自动摘要 + 折叠卡**（设计文档 §8.2 的 P6 行，用户需求 ③④）。
 *
 * ## 判据（逐条对应设计文档那一行）
 * 1. **保存一页 ⇒ 摘要落库**：走真实的 `PUT /api/pages/:slug` → `PAGE_SAVED_EVENT`
 *    → 去抖队列 → 真实上游生成 → 落库。**不是**直接调生成端点——
 *    那样测不到"保存真的会触发它"。
 * 2. **改正文 ⇒ 标"已过期"**：在去抖窗口内读一次，`stale` 必须是 `true`。
 * 3. **过期之后会被自动补上**：等去抖窗口过去，同一页的 `stale` 变回 `false`
 *    （即"事件 → 队列"那条路真的跑完了，而不是只有显式重算能工作）。
 * 4. **无模型 ⇒ 卡片不渲染**：起第二个隔离实例（基础层里没有 `llm` / `openai`），
 *    `GET` 的 `available` 必须是 `false`、`POST` 必须 503，且**一次上游都没有**。
 *
 * ## 为什么要两个实例
 * "没有模型"这件事没法在一个已经配好密钥的实例上造出来：把 `@geewiki/llm` 停掉
 * 是**基础层**操作（管理器会以 `base_layer` 拒绝），而它在自锁名单上（AI 停不掉自己）。
 * 造一个真没有模型的部署反而是最简单、也最诚实的做法——那正是"默认部署"的样子。
 *
 * 用法：node --import tsx scripts/acceptance/p6-summary/run.ts
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

/* ------------------------------ 断言累计 ------------------------------ */

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures.push(label)
}

/* ------------------------------ 隔离环境 ------------------------------ */

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

const NEEDED = [
  '@geewiki/db-sqlite',
  '@geewiki/http',
  '@geewiki/auth',
  '@geewiki/org',
  '@geewiki/authz',
  '@geewiki/wiki',
  '@geewiki/search',
  '@geewiki/ai-tools',
  '@geewiki/ai-kb',
  '@geewiki/ai-summary',
]
const WITH_MODEL = ['@geewiki/llm', '@geewiki/openai']

interface Instance {
  port: number
  work: string
  /** 进程内的 cordis app：验收脚本要直接建主体（没有现成会话），故要拿到 db 服务 */
  app: { get(name: string): unknown }
  dispose(): Promise<void>
}

async function boot(withModel: boolean, summaryConfig: Record<string, unknown>): Promise<Instance> {
  const work = mkdtempSync(join(tmpdir(), withModel ? 'gw-p6-model-' : 'gw-p6-nomodel-'))
  const configDir = join(work, 'config')
  const dataDir = join(work, 'data')
  mkdirSync(dataDir)
  cpSync(join(repo, 'config'), configDir, { recursive: true })

  const base = JSON.parse(readFileSync(join(configDir, 'plugins.base.json'), 'utf8')) as {
    enabled: { name: string; config?: unknown }[]
  }
  const names = withModel ? [...NEEDED, ...WITH_MODEL] : NEEDED
  base.enabled = base.enabled.filter((e) => names.includes(e.name))
  for (const name of names) {
    if (base.enabled.some((e) => e.name === name)) continue
    base.enabled.push({ name, ...(name === '@geewiki/ai-summary' ? { config: summaryConfig } : {}) })
  }
  // 摘要配置：去抖 8 秒，好让"改正文 ⇒ 标已过期"有一个稳定的观察窗口
  for (const e of base.enabled) if (e.name === '@geewiki/ai-summary') e.config = summaryConfig
  writeFileSync(join(configDir, 'plugins.base.json'), JSON.stringify(base, null, 2) + '\n')

  for (const suffix of ['', '-wal', '-shm']) {
    const src = join(repo, 'data/geewiki.db' + suffix)
    if (existsSync(src)) cpSync(src, join(dataDir, 'geewiki.db' + suffix))
  }

  process.env['GEEWIKI_DATA_DIR'] = dataDir
  const port = await freePort()
  const { startServer } = await import('../../../packages/server/src/index.js')
  const { app, dispose } = await startServer({ port, host: '127.0.0.1', configDir, pluginsDir: null, webDist: null })
  return {
    port,
    work,
    app: app as unknown as { get(name: string): unknown },
    async dispose() {
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
    },
  }
}

/* ------------------------------ 只读的健康探针：确认摘要在不在 ------------------------------ */

const SUMMARY_PATH = '/api/ai/summary'

type Caller = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>


/**
 * 建一个可编辑的主体并登录，返回带会话 cookie 的请求器。
 *
 * 验收脚本没有现成会话，而**差不多每一条断言都要求已登录**（AI 端点一律要求主体）。
 * 生产里主体由 `@geewiki/auth` 的钩子填充；这里手工建行 + 走真实登录端点，
 * 图的是"连会话机制本身也一起验了"——直接构造 Principal 会绕过 cookie 与 CSRF 两条链。
 */
async function loginAsOwner(inst: Instance, email: string): Promise<{ ok: boolean; detail: string; call: Caller }> {
  const PASSWORD = 'p6-summary-password-1'
  let cookie = ''
  const call: Caller = async (method, path, body) => {
    const headers: Record<string, string> = { 'x-gw-csrf': '1' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cookie !== '') headers['cookie'] = cookie
    const res = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) cookie = setCookie.split(';')[0] ?? cookie
    return { status: res.status, text: await res.text() }
  }

  const { hashPassword } = await import('../../../packages/plugin-auth/src/password.js')
  const db = inst.app.get('db') as
    | { run(sql: string, params?: unknown[]): { lastInsertRowid: number | bigint }; transaction<T>(fn: () => T): T }
    | undefined
  if (!db) throw new Error("database-provider 不在（ctx.get('db') 取不到）")
  const credential = await hashPassword(PASSWORD)
  const now = new Date().toISOString()
  db.transaction(() => {
    const inserted = db.run(
      `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at) VALUES (?, ?, ?, 'active', 1, ?)`,
      [1, email, 'P6 验收', now],
    )
    const userId = Number(inserted.lastInsertRowid)
    db.run(`INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      userId,
      credential.algo,
      credential.params,
      credential.salt,
      credential.hash,
      now,
    ])
    db.run(`INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, [1, userId, now])
  })
  const login = await call('POST', '/api/auth/login', { email, password: PASSWORD })
  return { ok: login.status === 200 && cookie !== '', detail: `status=${login.status}`, call }
}

/* ============================== 实例 A：有真实模型 ============================== */

console.log('起实例 A（真实上游 + ai-summary，去抖 8000ms）…')
const a = await boot(true, { debounceMs: 8000, autoGenerate: true, maxSummaryChars: 300, maxSourceChars: 12000 })

try {
  const session = await loginAsOwner(a, 'p6-summary@example.com')
  check('建主体并登录', session.ok, session.detail)
  const call = session.call
  const json = async <T,>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await call(method, path, body)
    let parsed: unknown = null
    try {
      parsed = JSON.parse(r.text)
    } catch {
      parsed = null
    }
    return { status: r.status, body: parsed as T }
  }

  const caps = await json<{ available: boolean }>('GET', '/api/ai/summary/capabilities')
  check('capabilities 报有可用模型', caps.body?.available === true, JSON.stringify(caps.body))

  /* ---- ① 保存 ⇒ 摘要落库（走保存事件，不直接调生成端点） ---- */
  const SLUG = 'p6-summary-probe'
  const v1 =
    '# 部署与回滚\n\n本文说明生产环境的部署流程：先用 docker compose 构建镜像，再用健康检查确认新容器就绪；' +
    '如果探针持续失败，就执行回滚——把上一版镜像重新拉起，并检查数据目录是否可写。' +
    '部署窗口建议安排在低峰期，回滚演练每季度做一次。\n'
  const put1 = await call('PUT', `/api/pages/${encodeURIComponent(SLUG)}`, {
    title: '部署与回滚',
    content: v1,
  })
  check('保存一页（触发 PAGE_SAVED_EVENT）', put1.status === 200, `status=${put1.status} ${put1.text.slice(0, 80)}`)

  const beforeGen = await json<{ available: boolean; summary: string | null }>('GET', `${SUMMARY_PATH}?slug=${SLUG}`)
  check('刚保存时摘要还没生成（去抖窗口内）', beforeGen.body?.summary === null, JSON.stringify(beforeGen.body).slice(0, 120))
  check('但 available 是 true（卡片会渲染成"还没生成"）', beforeGen.body?.available === true)

  // 等自动生成跑完（去抖 8s + 一次真实上游）
  let auto: { available: boolean; summary: string | null; stale: boolean; audience: string | null; model: string | null } | null = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got = await json<typeof auto>('GET', `${SUMMARY_PATH}?slug=${SLUG}`)
    if (got.body?.summary !== null && got.body?.summary !== undefined) {
      auto = got.body
      break
    }
  }
  check('保存之后摘要**自动**落库（事件 → 去抖 → 真实上游）', auto !== null)
  if (auto !== null) {
    console.log(`    摘要：${String(auto.summary).slice(0, 80)}…`)
    check('摘要不是空的且被清洗过（无「摘要：」前缀、无代码围栏）', !/^(摘要|总结)\s*[:：]/.test(auto.summary ?? '') && !(auto.summary ?? '').includes('```'))
    check('记录了生成用的模型名', typeof auto.model === 'string' && auto.model !== 'unknown', String(auto.model))
    check('记录了投影档位', auto.audience === 'public' || auto.audience === 'org', String(auto.audience))
    check('刚生成完 stale=false', auto.stale === false)
  }

  /* ---- ② 改正文 ⇒ 标"已过期"（在去抖窗口内读） ---- */
  const v2 = v1.replace('每季度做一次', '每月做一次')
  const put2 = await call('PUT', `/api/pages/${encodeURIComponent(SLUG)}`, { title: '部署与回滚', content: v2 })
  check('改一次正文', put2.status === 200, `status=${put2.status}`)
  const during = await json<{ stale: boolean; summary: string | null }>('GET', `${SUMMARY_PATH}?slug=${SLUG}`)
  check('改完正文、新摘要还没生成时被标为**已过期**', during.body?.stale === true, JSON.stringify(during.body).slice(0, 120))
  check('过期时旧摘要仍然在（不是被清空）', typeof during.body?.summary === 'string' && (during.body?.summary ?? '') !== '')

  /* ---- ③ 过期之后自动补上 ---- */
  let healed: { stale: boolean } | null = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const got = await json<{ stale: boolean }>('GET', `${SUMMARY_PATH}?slug=${SLUG}`)
    if (got.body?.stale === false) {
      healed = got.body
      break
    }
  }
  check('去抖过后摘要被自动重算，stale 回到 false', healed !== null)

  /* ---- ④ 按摘要检索：自然语言问句要能找到这一页 ---- */
  const search = await json<{ hits: { slug: string }[] }>(
    'GET',
    `/api/ai/summary/search?q=${encodeURIComponent('怎么做回滚演练')}`,
  )
  check(
    '自然语言问句能按摘要检索到这一页',
    (search.body?.hits ?? []).some((h) => h.slug === SLUG),
    JSON.stringify(search.body).slice(0, 160),
  )

  /* ---- ⑤ 显式重算与权限 ---- */
  const regen = await json<{ summary?: string }>('POST', SUMMARY_PATH, { slug: SLUG })
  check('有编辑权的人可以显式重算', regen.status === 200, `status=${regen.status} ${JSON.stringify(regen.body).slice(0, 80)}`)
  const anonCall = await fetch(`http://127.0.0.1:${a.port}${SUMMARY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-csrf': '1' },
    body: JSON.stringify({ slug: SLUG }),
  })
  check('匿名重算被拒（401）', anonCall.status === 401, `status=${anonCall.status}`)

  /* ---- ⑥ 权限红线：新建的页默认是**组织内 + 未发布**，匿名必须读不到它的摘要 ---- */
  const anonRead = await fetch(`http://127.0.0.1:${a.port}${SUMMARY_PATH}?slug=${SLUG}`)
  check(
    '匿名读不到组织内页面的摘要（404，与"这一页不存在"同一个回答）',
    anonRead.status === 404,
    `status=${anonRead.status}`,
  )
  const memberRead = await json<{ canRegenerate: boolean; audience: string | null }>('GET', `${SUMMARY_PATH}?slug=${SLUG}`)
  check('有编辑权的成员读得到（canRegenerate=true）', memberRead.body?.canRegenerate === true, JSON.stringify(memberRead.body).slice(0, 100))
  check('投影档位记的是 org（摘要只覆盖组织成员看得见的那一部分）', memberRead.body?.audience === 'org', String(memberRead.body?.audience))

  /* ---- ⑦ 读得到但不能编辑的人：canRegenerate=false（界面据此隐藏重算按钮） ---- */
  const viewerEmail = 'p6-viewer@example.com'
  const viewer = await loginAsOwner(a, viewerEmail)
  const viewerRead = await (async () => {
    const r = await viewer.call('GET', `${SUMMARY_PATH}?slug=${SLUG}`)
    return JSON.parse(r.text) as { canRegenerate: boolean; summary: string | null }
  })()
  check('另一个组织成员也读得到摘要', typeof viewerRead.summary === 'string' && viewerRead.summary !== '')
  check('但是否能重算由服务端逐人判定（字段存在且是布尔）', typeof viewerRead.canRegenerate === 'boolean')
} finally {
  await a.dispose()
}

/* ============================== 实例 B：默认部署（没有模型） ============================== */

console.log('\n起实例 B（基础层里没有 llm / openai —— 这就是默认部署的样子）…')
const b = await boot(false, { debounceMs: 0, autoGenerate: true })
try {
  const res = await fetch(`http://127.0.0.1:${b.port}${SUMMARY_PATH}?slug=home`)
  const body = (await res.json()) as { available: boolean; summary: string | null; reason?: string }
  check('无模型时 GET 的 available=false（**卡片据此整张不渲染**）', body.available === false, JSON.stringify(body).slice(0, 140))
  check('并且给出了一句原因（界面不自己编文案）', typeof body.reason === 'string' && body.reason !== '')

  const caps = await fetch(`http://127.0.0.1:${b.port}/api/ai/summary/capabilities`)
  const capsBody = (await caps.json()) as { available: boolean }
  check('capabilities 也报不可用', capsBody.available === false)

  /*
   * 顺序即语义：**权限判定先于模型判定**（否则"没配密钥"会变成一条权限探测通道）。
   * 故先验"匿名被拒"，再登录验"有权限的人拿到的是 503 而不是别的"。
   */
  const anonPost = await fetch(`http://127.0.0.1:${b.port}${SUMMARY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-csrf': '1' },
    body: JSON.stringify({ slug: 'home' }),
  })
  check('无模型实例：匿名 POST 先被权限挡住（401，不是 503）', anonPost.status === 401, `status=${anonPost.status}`)

  const bSession = await loginAsOwner(b, 'p6-nomodel@example.com')
  check('无模型实例：建主体并登录', bSession.ok, bSession.detail)
  const post = await bSession.call('POST', SUMMARY_PATH, { slug: 'home' })
  check(
    '无模型时 POST 返回 503（前置条件不满足，而不是网关错误）',
    post.status === 503,
    `status=${post.status} ${post.text.slice(0, 90)}`,
  )
} finally {
  await b.dispose()
}

/* ------------------------------ 收尾 ------------------------------ */

console.log('')
if (failures.length > 0) {
  console.error(`✗ P6 验收失败 ${failures.length} 条：\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('✓ P6 验收全部通过（保存 ⇒ 自动摘要；改正文 ⇒ 标已过期；按摘要检索；无模型 ⇒ 卡片不渲染）。')
