/**
 * P4 验收：**回退到某一轮之前**（设计文档 §8.2 的 P4 行）。
 *
 * ## 判据
 * 1. **回退到某轮之前**：一轮里改过一页 ⇒ 撤销后正文逐字回到改之前，且记录被标记已撤销；
 * 2. **他人改过即拒绝**：目标在 AI 改完之后又被（别人）改过 ⇒ 拒绝那一条，别人的版本一个字符不动；
 * 3. **客户端自报骗不过探针**：请求里带一份谎报"没变过"的 `snapshots`，仍然拒绝；
 * 4. **没有编辑权 ⇒ 拒绝**（不是"静默成功"，也不是"执行体失败"）；
 * 5. **重复回退不重复执行**（幂等：已撤销的记录进 `alreadyUndone`）；
 * 6. **浏览器域的步骤交回浏览器**（`clientSteps`）+ `ack` 单独一趟；
 * 7. **自锁护栏**拦住 `ai-assistant` / `ai-tools` / `llm` / `ai-journal`。
 *
 * ## 为什么这个脚本不需要模型密钥（与 p0/p1/p2b/p3 都不同）
 * 回退是**存储与事务**的事，不是模型的事：记录由工具写入、撤销由执行体完成，
 * 两条链路上都没有 LLM。本脚本因此**不做 SKIP**——它在任何环境下都必须给出读数。
 * （模型那一环由 p3 的脚本覆盖；本脚本刻意不重复它，也不假装验过它。）
 *
 * ## 为什么必须有这个脚本（单测证不了的那一条）
 * `@geewiki/ai-journal` 单测走的是**服务级** `rollbackTo(…)`；而线上路径是
 * `POST /api/ai/journal/undo` → 读体 → 解析 `snapshots` → `rollbackTo`。
 * P4 尾巴上就踩过一次这个形状的坑：探针起初只接在 HTTP 端点里，
 * 于是服务级调用**完全绕过它**，而两侧单测全绿。本脚本只打真实 HTTP。
 *
 * 用法：node --import tsx scripts/acceptance/p4-undo/run.ts
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import type { Principal } from '../../../packages/core/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

/* ------------------------------ 隔离环境 ------------------------------ */

const work = mkdtempSync(join(tmpdir(), 'geewiki-p4-undo-'))
const configDir = join(work, 'config')
const dataDir = join(work, 'data')
mkdirSync(dataDir)
cpSync(join(repo, 'config'), configDir, { recursive: true })

const base = JSON.parse(readFileSync(join(configDir, 'plugins.base.json'), 'utf8')) as {
  enabled: { name: string; config?: unknown }[]
}
const NEEDED = [
  '@geewiki/db-sqlite',
  '@geewiki/http',
  '@geewiki/auth',
  '@geewiki/org',
  '@geewiki/authz',
  '@geewiki/wiki',
  '@geewiki/llm',
  '@geewiki/openai',
  '@geewiki/ai-tools',
  '@geewiki/ai-journal',
  '@geewiki/ai-pages',
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
  pluginsDir: null,
  webDist: null,
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
  if (cookie !== '') headers['cookie'] = cookie
  // 会话 cookie + CSRF 头必须成对出现（`checkCsrf`），少了它得到的是 csrf_rejected，
  // 看起来像"接口 403"而不像"脚本漏了一步"。
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

/* ------------------------------ 造主体 ------------------------------ */

const db = app.get('db') as
  | {
      query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
      run(sql: string, params?: unknown[]): { lastInsertRowid: number | bigint }
      transaction<T>(fn: () => T): T
    }
  | undefined
if (!db) throw new Error("database-provider 不在（ctx.get('db') 取不到）—— @geewiki/db-sqlite 没激活？")

const { hashPassword } = await import('../../../packages/plugin-auth/src/password.js')

/** 造一个登录主体：`owner` 能编辑一切；`viewer` 只有读权限（判据 4 需要它） */
async function seedUser(email: string, role: 'owner' | 'viewer'): Promise<number> {
  const password = `${email}-password-1`
  const credential = await hashPassword(password)
  const now = new Date().toISOString()
  return db!.transaction(() => {
    const inserted = db!.run(
      `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at)
       VALUES (?, ?, ?, 'active', 1, ?)`,
      [1, email, `P4 ${role}`, now],
    )
    const userId = Number(inserted.lastInsertRowid)
    db!.run(
      `INSERT INTO user_credentials (user_id, algo, params, salt, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, credential.algo, credential.params, credential.salt, credential.hash, now],
    )
    db!.run(`INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`, [1, userId, role, now])
    return userId
  })
}

const OWNER_EMAIL = 'p4-owner@example.com'
const VIEWER_EMAIL = 'p4-viewer@example.com'
const ownerId = await seedUser(OWNER_EMAIL, 'owner')
await seedUser(VIEWER_EMAIL, 'viewer')

/*
 * 服务端工具执行需要一个 `Principal` 对象。**不用 break-glass**：它的 `orgRole` 是 null，
 * 而策略层判"组织级可见"要求 `kind === 'user' && orgRole !== null`，
 * 用它验收会得到一份**不可信**的读数（本仓已记档的探针 E5）。
 */
const asOwner: Principal = {
  kind: 'user',
  userId: ownerId,
  orgId: 1,
  orgRole: 'owner',
  groupIds: [],
  sessionId: null,
}

async function loginAs(email: string, password: string): Promise<boolean> {
  cookie = ''
  const res = await call('POST', '/api/auth/login', { email, password })
  return res.status === 200
}

if (!(await loginAs(OWNER_EMAIL, `${OWNER_EMAIL}-password-1`))) {
  console.error('登录失败 —— 无法继续')
  await cleanup()
  process.exit(1)
}
console.log(`建主体：owner=${ownerId}（${OWNER_EMAIL}）、viewer（${VIEWER_EMAIL}），已登录 owner\n`)

/* ------------------------------ 断言累计 ------------------------------ */

const failures: string[] = []
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

/* ------------------------------ 工具与页面帮手 ------------------------------ */

const tools = app.get('ai-tool-service') as
  | { list(p: Principal): readonly { descriptor: { name: string }; execute(p: Principal, args: unknown, ctx: unknown): Promise<{ content: string; data?: unknown }> }[] }
  | undefined
if (!tools) throw new Error('ai-tool-service 不在 —— @geewiki/ai-tools 没激活？')

const wiki = app.get('wiki-service') as
  | {
      get(slug: string, p: Principal): Promise<{ title: string; content: string } | undefined>
      save(slug: string, input: { title: string; content: string }): Promise<unknown>
    }
  | undefined
if (!wiki) throw new Error('wiki-service 不在 —— @geewiki/wiki 没激活？')

const SLUG = 'home'
const ORIGINAL = '原始正文'
const AI_TEXT = 'AI 改过之后的正文'
const HUMAN_TEXT = '之后由人改过的正文'

/** 直接调真实的 `page.update`（模型那一环不是本脚本的判据，见文件头） */
async function updatePage(content: string, conversationId: string, turnId: string): Promise<void> {
  const tool = tools!.list(asOwner).find((t) => t.descriptor.name === 'page.update')
  if (tool === undefined) throw new Error('page.update 不在工具表里 —— @geewiki/ai-pages 没激活？')
  const out = await tool.execute(asOwner, { slug: SLUG, content }, { conversationId, turnId })
  if (!/已更新/.test(out.content)) throw new Error(`page.update 没成功：${out.content}`)
}

/**
 * 把页面写回一个已知状态 —— **走真实的保存路径**（模拟"别人又改了一次"）。
 *
 * ⚠️ 不能图省事用 `UPDATE pages SET content = ?`：读者的正文来自 **`blocks` 表**
 * （`projectPageContentFor` 优先用块，只有在**该页一块都没有**时才回落到解析
 * `pages.content`），而 `blocks` 只由 `wiki.save` 经 `syncBlocksForPage` 重建。
 * 直接写 `pages.content` 的后果是"**库里变了、读者看不到**"——本脚本第一版就踩了它，
 * 表现是"别人的版本一个字符都没动"这条判据假红（诊断打出来的库值与读值不一致）。
 */
async function setPage(content: string): Promise<void> {
  const page = await wiki!.get(SLUG, asOwner)
  await wiki!.save(SLUG, { title: page?.title ?? '主页', content })
}

async function readPage(): Promise<string> {
  const page = await wiki!.get(SLUG, asOwner)
  return page?.content ?? ''
}

interface TurnGroupView {
  turnId: string
  /** ★ 是**条数**不是数组（服务端 `TurnGroup` 的形状：UI 据此禁用按钮） */
  pending: number
  records: unknown[]
  tools: string[]
}

async function journalTurns(conversationId: string): Promise<TurnGroupView[]> {
  const res = await call('GET', `/api/ai/journal?conversationId=${encodeURIComponent(conversationId)}`)
  const body = jsonOf(res) as { turns?: TurnGroupView[] }
  return body.turns ?? []
}

/* ============================== 判据 1：回退到某轮之前 ============================== */

console.log('判据 1：回退到某一轮之前')

const C1 = 'p4-c1'
await setPage(ORIGINAL)
await updatePage(AI_TEXT, C1, 't1')

check((await readPage()) === AI_TEXT, 'AI 改过之后正文确实变了', JSON.stringify(await readPage()))

const turns1 = await journalTurns(C1)
check(
  turns1.length === 1 && turns1[0]?.pending === 1,
  '日志里出现一轮、一条待撤记录',
  JSON.stringify(turns1.map((t) => [t.turnId, t.pending])),
)
check((turns1[0]?.tools ?? []).includes('page.update'), '轮次里记得住工具名', JSON.stringify(turns1[0]?.tools))

const undo1 = await call('POST', '/api/ai/journal/undo', { conversationId: C1, turnId: 't1' })
const report1 = jsonOf(undo1)
check(undo1.status === 200, '回退端点返回 200', String(undo1.status))
check(Array.isArray(report1['undone']) && (report1['undone'] as unknown[]).length === 1, '服务端撤销了一条', JSON.stringify(report1['undone']))
check(Array.isArray(report1['failed']) && (report1['failed'] as unknown[]).length === 0, '没有失败项', JSON.stringify(report1['failed']))
check((await readPage()) === ORIGINAL, '**正文逐字回到改之前**（这条才是判据 1 的核心）', JSON.stringify(await readPage()))

const after1 = await journalTurns(C1)
check((after1[0]?.pending ?? -1) === 0, '撤销后这一轮不再有待撤记录（界面上的回退入口该消失）', JSON.stringify(after1[0]?.pending))

/* ============================== 判据 5：重复回退幂等 ============================== */

console.log('\n判据 5：重复回退不重复执行')

const undoAgain = await call('POST', '/api/ai/journal/undo', { conversationId: C1, turnId: 't1' })
const reportAgain = jsonOf(undoAgain)
check(
  Array.isArray(reportAgain['alreadyUndone']) && (reportAgain['alreadyUndone'] as unknown[]).length === 1,
  '第二次回退进 alreadyUndone（不是再执行一遍逆操作）',
  JSON.stringify(reportAgain['alreadyUndone']),
)
check((await readPage()) === ORIGINAL, '正文没有因为重复回退而变化')

/* ============================== 判据 2 + 3：他人改过即拒绝、探针优先 ============================== */

console.log('\n判据 2 / 3：他人改过即拒绝，且客户端自报骗不过探针')

const C2 = 'p4-c2'
await setPage(ORIGINAL)
await updatePage(AI_TEXT, C2, 't1')
// "别人"又改了一次（直接写库，绕过 AI 记录）
await setPage(HUMAN_TEXT)
/*
 * 顺带钉一条**踩过的坑**：读者的正文来自 `blocks` 表，不是 `pages.content`。
 * 走了真实保存路径时两者必须一致；不一致就说明块没同步 —— 那种状态下
 * "AI 说改了"与"用户看到什么"会分叉，而两边都不报错。
 */
{
  const row = (app.get('db') as unknown as { query<T>(sql: string, p?: unknown[]): T[] }).query<{ content: string }>(
    'SELECT content FROM pages WHERE slug = ?',
    [SLUG],
  )[0]
  check(row?.content === HUMAN_TEXT, '保存后 `pages.content` 与预期一致', JSON.stringify(row?.content))
}

const lying = await call('POST', '/api/ai/journal/undo', {
  conversationId: C2,
  turnId: 't1',
  // ★ 谎报"现在还是 AI 改过的那一份"（等价于一份过期的浏览器快照）
  snapshots: { [`page:${SLUG}`]: AI_TEXT },
})
const reportLying = jsonOf(lying)
check(
  Array.isArray(reportLying['undone']) && (reportLying['undone'] as unknown[]).length === 0,
  '**一条都没撤**（客户端说"没变过"不算数）',
  JSON.stringify(reportLying['undone']),
)
check(
  Array.isArray(reportLying['conflicts']) && (reportLying['conflicts'] as unknown[]).length === 1,
  '进了 conflicts 而不是 failed（根本没进执行体）',
  JSON.stringify(reportLying['conflicts']).slice(0, 240),
)
check((await readPage()) === HUMAN_TEXT, '**别人的版本一个字符都没动**（读者看到的也一致：块已同步）', JSON.stringify(await readPage()))

// 反向对照：真的一致时必须能撤（否则"总是拒绝"也会让上面三条全绿）
const C2B = 'p4-c2b'
await setPage(ORIGINAL)
await updatePage(AI_TEXT, C2B, 't1')
const okUndo = jsonOf(await call('POST', '/api/ai/journal/undo', { conversationId: C2B, turnId: 't1' }))
check(
  Array.isArray(okUndo['undone']) && (okUndo['undone'] as unknown[]).length === 1,
  '对照：目标确实没被改过时**能撤**（证明上面不是"一律拒绝"）',
  JSON.stringify(okUndo['undone']),
)

/* ============================== 判据 4：没有编辑权 ⇒ 拒绝 ============================== */

console.log('\n判据 4：没有编辑权 ⇒ 拒绝（不是静默成功）')

const C3 = 'p4-c3'
await setPage(ORIGINAL)
await updatePage(AI_TEXT, C3, 't1')

/*
 * ★ 判据 4 需要一个"**能读但不能编辑**"的目标。
 * 直接把页面设成 `private` 不行：那会让 viewer 连读都读不到，落进探针的另一条分支
 * （"已不存在或你看不到它"）。正解是**页面级 viewer 授予**（`page_grants.role='viewer'`）
 * —— 它给 `level:'full'` 但 `canEdit:false`（`plugin-authz` 的 grant 分支），
 * 恰好是"读得到原文以外的一切，但拿不到原文"这一档。
 * 顺带它也验证了一件事：**公开页对任何登录用户都可编辑**（`canEdit: p.kind==='user'`），
 * 所以"随便找个 viewer 角色的人"并不构成"没有编辑权"。
 */
const dbh = app.get('db') as { run(sql: string, params?: unknown[]): unknown }
dbh.run("UPDATE pages SET visibility = 'private' WHERE slug = ?", [SLUG])
const viewerId = Number(
  (dbh as unknown as { query<T>(sql: string, p?: unknown[]): T[] }).query<{ id: number }>(
    'SELECT id FROM users WHERE email = ?',
    [VIEWER_EMAIL],
  )[0]?.id ?? 0,
)
dbh.run(
  `INSERT OR REPLACE INTO page_grants (page_slug, subject_kind, subject_id, role, granted_by, granted_at, expires_at)
   VALUES (?, 'user', ?, 'viewer', ?, ?, NULL)`,
  [SLUG, String(viewerId), ownerId, new Date().toISOString()],
)

if (!(await loginAs(VIEWER_EMAIL, `${VIEWER_EMAIL}-password-1`))) {
  check(false, 'viewer 登录成功（判据 4 的前置）')
} else {
  const asViewer = await call('POST', '/api/ai/journal/undo', { conversationId: C3, turnId: 't1' })
  const reportViewer = jsonOf(asViewer)
  check(asViewer.status === 200, 'viewer 能打这个端点（记录不属于某个用户，权限判据在目标上）', String(asViewer.status))
  check(
    Array.isArray(reportViewer['undone']) && (reportViewer['undone'] as unknown[]).length === 0,
    'viewer 一条都没撤成',
    JSON.stringify(reportViewer['undone']),
  )
  const reasons = JSON.stringify(reportViewer['conflicts'])
  check(/权限/.test(reasons), '拒绝理由说的是**权限**，不是"目标被改动过"', reasons.slice(0, 240))
  check((await readPage()) === AI_TEXT, '正文保持 AI 那一版（viewer 没能覆盖）')
  await loginAs(OWNER_EMAIL, `${OWNER_EMAIL}-password-1`)
  dbh.run("DELETE FROM page_grants WHERE page_slug = ? AND subject_id = ?", [SLUG, String(viewerId)])
  dbh.run("UPDATE pages SET visibility = 'public' WHERE slug = ?", [SLUG])
  // 换回 owner 之后同一条必须能撤 —— 证明上一条拒绝的成因确实是权限
  const asOwnerUndo = jsonOf(await call('POST', '/api/ai/journal/undo', { conversationId: C3, turnId: 't1' }))
  check(
    Array.isArray(asOwnerUndo['undone']) && (asOwnerUndo['undone'] as unknown[]).length === 1,
    '换成有编辑权的主体后同一条能撤（证明上一条的成因是权限）',
    JSON.stringify(asOwnerUndo['undone']),
  )
  check((await readPage()) === ORIGINAL, '正文回到原始内容')
}

/* ============================== 判据 6：浏览器域的步骤交回浏览器 ============================== */

console.log('\n判据 6：浏览器域（编辑框草稿）的撤销交给客户端 + ack 单独一趟')

const C4 = 'p4-c4'
const RECORD = await call('POST', '/api/ai/journal', {
  conversationId: C4,
  turnId: 't1',
  // `owner` 必填（服务端按它做归属与回收）；漏了它得到 400 invalid_body
  owner: '@geewiki/web',
  tool: 'editor.insert_text',
  domain: 'editor',
  target: SLUG,
  before: '旧草稿',
  after: '旧草稿 + 新内容',
})
check(RECORD.status === 200, '记一条 editor 域的变更', RECORD.text.slice(0, 120))

/*
 * ★ `editor` 域**必须由调用方自报当前值**：服务端没有它的读路径（草稿在浏览器里）。
 * 这正是"探针优先、自报兜底"的另一半——没有探针的域，自报是唯一来源；
 * 不自报的后果是"没有拿到 editor:home 的当前值"，按冲突处理（拒绝，不猜）。
 */
const undoEditor = jsonOf(
  await call('POST', '/api/ai/journal/undo', {
    conversationId: C4,
    turnId: 't1',
    snapshots: { [`editor:${SLUG}`]: '旧草稿 + 新内容' },
  }),
)
const steps = (undoEditor['clientSteps'] ?? []) as { record: { id: number; before: string | null }; expected: string | null }[]
check(steps.length === 1, 'editor 域进 clientSteps（服务端没有它的读路径与执行体）', JSON.stringify(steps).slice(0, 200))
check(steps[0]?.record.before === '旧草稿', '步骤带回了 `before`（浏览器据此还原）', JSON.stringify(steps[0]?.record.before))
check((undoEditor['undone'] as unknown[]).length === 0, '服务端没有假装撤了它', JSON.stringify(undoEditor['undone']))

const ack = await call('POST', '/api/ai/journal/undo/ack', { ids: steps.map((s) => s.record.id), detail: '已由浏览器把编辑框草稿还原' })
check(jsonOf(ack)['changed'] === 1, 'ack 把它标成已撤销（少了这一趟，再点一次会重复执行）', ack.text.slice(0, 120))
const afterC4 = await journalTurns(C4)
check((afterC4[0]?.pending ?? -1) === 0, 'ack 之后这一轮不再有待撤记录', JSON.stringify(afterC4[0]?.pending))

/* ============================== 判据 7：自锁护栏 ============================== */

console.log('\n判据 7：自锁护栏（AI 不得停掉自己依赖链上的节点）')

const journal = await import('../../../packages/plugin-ai-journal/src/plan.js')
check(
  journal.PROTECTED_AI_NODES.includes('@geewiki/llm') &&
    journal.PROTECTED_AI_NODES.includes('@geewiki/ai-tools') &&
    journal.PROTECTED_AI_NODES.includes('@geewiki/ai-assistant') &&
    journal.PROTECTED_AI_NODES.includes('@geewiki/ai-journal'),
  '受保护节点包含 llm / ai-tools / ai-assistant / ai-journal',
  journal.PROTECTED_AI_NODES.join(', '),
)
check(journal.checkSelfLock(['@geewiki/llm']) !== null, '停用 llm 被拦住（停掉它 = 助手从此不能说话）')
check(journal.checkSelfLock(['@geewiki/ai-tools']) !== null, '停用 ai-tools 被拦住')
check(journal.checkSelfLock(['@geewiki/ai-assistant']) !== null, '停用助手自己 被拦住')
check(journal.checkSelfLock(['@geewiki/echo', '@geewiki/llm']).node === '@geewiki/llm', '混在一批目标里也拦得住')
check(journal.checkSelfLock(['@geewiki/echo']) === null, '无关插件放行（护栏不能变成"什么都不许做"）')

/* ------------------------------ 汇总 ------------------------------ */

await cleanup()
if (failures.length > 0) {
  console.error(`\nFAIL：${failures.length} 条判据未过\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nPASS：P4 回退（真实 HTTP + 真实执行体；他人改过即拒绝；探针优先于客户端自报；自锁护栏）')
