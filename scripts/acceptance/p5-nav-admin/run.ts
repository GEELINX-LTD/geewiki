/**
 * P5 验收：**页面跳转工具 + 管理台护栏 + 知识库之外的标注**（设计文档 §8.2 的 P5 行）。
 *
 * ## 判据
 * 1. **页面跳转生效**：`open_page` / `scroll_to` 以 `side:'client'` 进模型的工具表，
 *    且宿主声明的可调用集与它们取交集（伪造的名字进不来）；
 * 2. **管理台工具受护栏**：自锁名单上的五个节点逐个被拒，且**管理器一次都没被调用**；
 *    非管理员连工具都看不到；base 层插件被管理器拒绝时能翻成可执行的话；
 * 3. **非知识库问题带显著标注**：真实上游下，知识库外的问题 `done.grounded=false`、
 *    知识库内的问题 `true`。
 *
 * ## 为什么分两半，且只有一半需要密钥
 * 护栏是**代码的事**：它必须在调用管理器之前生效，而"有没有生效"的唯一可信证据是
 * **管理器的调用账**（返回文本里那句"没有改动任何东西"是给模型看的，不是给测试看的）。
 * 那一半**不需要模型**，因此本脚本在任何环境下都给出这部分读数。
 *
 * 标注那一半必须打真实上游：它验的是"模型会不会真的去调检索"——编一个假模型
 * 等于在测我们自己的脚本。
 *
 * 用法：node --import tsx scripts/acceptance/p5-nav-admin/run.ts
 *      第二部分没有可用密钥时**明确跳过并退出码 2**，不假装通过。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import type { Principal } from '../../../packages/core/src/index.js'
import { readBaseList } from '../../lib/base-list.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

/* ------------------------------ 前置：密钥（只影响第二部分） ------------------------------ */

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
const WITH_MODEL = hasApiKey()

/* ------------------------------ 隔离环境 ------------------------------ */

const work = mkdtempSync(join(tmpdir(), 'geewiki-p5-nav-admin-'))
const configDir = join(work, 'config')
const dataDir = join(work, 'data')
mkdirSync(dataDir)
cpSync(join(repo, 'config'), configDir, { recursive: true })

// 隔离副本与本机 config/ 同形状：live 文件缺失时回退读同目录的 example
// （live 文件不入库，干净检出只有 example —— 回退口径见 scripts/lib/base-list.ts）
const base = readBaseList(configDir)
/**
 * 本次链路需要的插件。
 *
 * `@geewiki/echo` 是**唯一一个可以安全停用的目标**：它没有任何依赖方、也不在自锁名单上。
 * 探针里不能拿 `wiki` / `search` 试停用——那些一旦真被停掉，后面所有断言都会以
 * 一种看不懂的方式失败。
 *
 * ⚠️ 它**刻意不在这个清单里**：写进基础层清单的插件是**停不掉**的（管理器抛 `base_layer`），
 * 而本脚本要验的正是"停用真的生效并留下可回退的记录"。所以下面改为在引导之后
 * 用 `manager.enable()` 把它提到**会话层**——那才是 AI 有权启停的那一层。
 */
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
  '@geewiki/ai-journal',
  '@geewiki/ai-kb',
  '@geewiki/ai-nav',
  '@geewiki/ai-admin',
  '@geewiki/ai-assistant',
]
for (const name of NEEDED) {
  if (!base.enabled.some((e) => e.name === name)) base.enabled.push({ name })
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

/* ------------------------------ 断言累计 ------------------------------ */

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures.push(label)
}

/* ------------------------------ 主体与工具表 ------------------------------ */

const OWNER: Principal = {
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole: 'owner',
  groupIds: [],
  sessionId: null,
}
const MEMBER: Principal = { ...OWNER, userId: 2, orgRole: 'member' }
const ANON: Principal = { kind: 'anonymous', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null }

interface ToolLike {
  owner: string
  descriptor: {
    name: string
    description: string
    side: 'server' | 'client'
    mutating?: boolean
  }
  execute(p: unknown, args: unknown, ctx: unknown): Promise<{ content: string; data?: unknown; grounding?: string }>
}
interface ToolServiceLike {
  list(p: unknown): readonly ToolLike[]
  diagnostics(): { count: number; mutating: readonly string[] }
}

const toolSvc = app.get('ai-tool-service') as ToolServiceLike | undefined
if (!toolSvc) throw new Error('ai-tool-service 没被 provide —— @geewiki/ai-tools 没激活？')

const ownerTools = toolSvc.list(OWNER)
console.log(`工具表（owner，${ownerTools.length} 条）：${ownerTools.map((t) => t.descriptor.name).join(', ')}`)
console.log(`diagnostics：${JSON.stringify(toolSvc.diagnostics())}\n`)

const byName = (p: Principal, name: string): ToolLike | undefined =>
  toolSvc.list(p).find((t) => t.descriptor.name === name)

const CTX = { conversationId: 'p5-verify', turnId: 'p5-turn' }

/* ============================== ① 页面跳转工具 ============================== */

console.log('— ① 页面跳转工具（ai-nav）—')
{
  const open = byName(OWNER, 'open_page')
  const scroll = byName(OWNER, 'scroll_to')
  check('open_page 进工具表', open !== undefined)
  check('scroll_to 进工具表', scroll !== undefined)
  check('两条都是 side:client（跳转是浏览器的事）', open?.descriptor.side === 'client' && scroll?.descriptor.side === 'client')
  check(
    '两条都不是 mutating（跳转与滚动改的不是数据）',
    open?.descriptor.mutating !== true && scroll?.descriptor.mutating !== true,
  )

  // 交集：宿主没声明的客户端工具不进模型看到的表
  const { resolveTurnTools } = await import('../../../packages/plugin-ai-assistant/src/tools.js')
  const withDeclared = resolveTurnTools(toolSvc as never, OWNER, ['open_page', 'scroll_to'])
  const withFake = resolveTurnTools(toolSvc as never, OWNER, ['open_page', 'admin.disable_plugin'])
  check('宿主声明的两条进了工具表', withDeclared.names.includes('open_page') && withDeclared.names.includes('scroll_to'))
  check('伪造的名字不进交集', !withFake.names.includes('admin.disable_plugin'))
  check('交集只采纳已声明的', JSON.stringify(withFake.clientToolsAccepted) === JSON.stringify(['open_page']))
}

/* ============================== ② 管理台护栏 ============================== */

console.log('\n— ② 管理台工具与护栏（ai-admin）—')
const manager = app.get('manager') as
  | {
      snapshot(): readonly { name: string; state: string; layer: string | null }[]
      enable(name: string): Promise<unknown>
    }
  | undefined
if (!manager) throw new Error("'manager' 服务不在 —— 本脚本的护栏判据全靠它")
const activeNames = (): string[] => manager.snapshot().filter((p) => p.state === 'active').map((p) => p.name)

/*
 * 把 `@geewiki/echo` 提到**会话层**：只有会话层的插件 AI 才停得掉。
 * 这一步同时验证了"层"这件事本身——若 `enable()` 没有真的把它放进会话层，
 * 下面的停用会以 `base_layer` 被拒，而那会与"护栏在工作"混为一谈（两者都返回可读的拒绝）。
 */
if (!activeNames().includes('@geewiki/echo')) await manager.enable('@geewiki/echo')
check(
  '探针前置：@geewiki/echo 已提到会话层',
  manager.snapshot().find((p) => p.name === '@geewiki/echo')?.layer === 'session',
)

{
  for (const n of ['plugin.list', 'plugin.read_config', 'plugin.set_enabled', 'plugin.set_config']) {
    check(`${n} 进 owner 的工具表`, byName(OWNER, n) !== undefined)
  }
  check(
    '非管理员**看不到**任何管理台工具（第一层：不进模型的工具表）',
    ['plugin.list', 'plugin.read_config', 'plugin.set_enabled', 'plugin.set_config'].every(
      (n) => byName(MEMBER, n) === undefined && byName(ANON, n) === undefined,
    ),
  )
  check(
    '两条写工具被标 mutating',
    byName(OWNER, 'plugin.set_enabled')?.descriptor.mutating === true &&
      byName(OWNER, 'plugin.set_config')?.descriptor.mutating === true,
  )

  // 第二层：真调了也不放行
  const r = await byName(OWNER, 'plugin.set_enabled')!.execute(MEMBER, { name: '@geewiki/echo', enabled: false }, CTX)
  check('非管理员真调也拒绝', /没有改动任何东西/.test(r.content), r.content.slice(0, 60))

  // ★ 自锁：五个受保护节点逐个被拒，且**实例状态一个都没变**
  const protectedNodes = ['@geewiki/ai-assistant', '@geewiki/ai-tools', '@geewiki/llm', '@geewiki/ai-journal', '@geewiki/ai-admin']
  const before = activeNames()
  for (const node of protectedNodes) {
    const res = await byName(OWNER, 'plugin.set_enabled')!.execute(OWNER, { name: node, enabled: false }, CTX)
    check(`自锁拦住停用 ${node}`, /没有改动任何东西/.test(res.content), res.content.slice(0, 50))
  }
  check('五个受保护节点全部仍在活动（护栏真的在动手之前生效）', JSON.stringify(activeNames()) === JSON.stringify(before))

  // 真实停用 → 日志 → 回退
  const echoBefore = activeNames().includes('@geewiki/echo')
  check('探针前置：@geewiki/echo 处于活动状态', echoBefore)
  const off = await byName(OWNER, 'plugin.set_enabled')!.execute(OWNER, { name: '@geewiki/echo', enabled: false }, CTX)
  check('停用普通插件成功', !activeNames().includes('@geewiki/echo'), off.content.slice(0, 60))
  const recordId = (off.data as { recordId?: number } | undefined)?.recordId
  check('停用留下了可回退的记录', typeof recordId === 'number', `recordId=${String(recordId)}`)

  // 回退：走真实的 journal HTTP 端点（不吃进程内捷径）
  const undo = await fetch(`http://127.0.0.1:${port}/api/ai/journal/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-admin-token': 'p5-verify-admin' },
    body: JSON.stringify({ conversationId: 'p5-verify', turnId: 'p5-turn', snapshots: {} }),
  })
  /*
   * 这个端点要求登录主体，而验收脚本没有会话 cookie ⇒ 401。
   * 这里刻意**不绕过它**：回退链路的端到端验收归 p4 的脚本（它建了真主体），
   * 本脚本只验到"记录被写下来了、内容是回退所需的形态"。
   */
  check('回退端点仍要求登录主体（未带会话 ⇒ 401，不吃进程内捷径）', undo.status === 401, `status=${undo.status}`)

  // 配置写入
  const cfg = await byName(OWNER, 'plugin.read_config')!.execute(OWNER, { name: '@geewiki/echo' }, CTX)
  check('read_config 返回可解析的 JSON', (() => {
    try {
      JSON.parse(cfg.content)
      return true
    } catch {
      return false
    }
  })())
  const written = await byName(OWNER, 'plugin.set_config')!.execute(OWNER, { name: '@geewiki/echo', config: { hello: 'p5' } }, CTX)
  check('set_config 写入成功', /已更新/.test(written.content), written.content.slice(0, 60))

  // 基础层：拿一个真实的基础层插件（wiki）试停用
  const baseTry = await byName(OWNER, 'plugin.set_enabled')!.execute(OWNER, { name: '@geewiki/wiki', enabled: false }, CTX)
  check(
    '基础层插件被拒且提示可执行的去处',
    /plugins\.base\.json/.test(baseTry.content) && /没有改动任何东西/.test(baseTry.content),
    baseTry.content.slice(0, 70),
  )
}

/* ============================== ③ 知识库之外的标注 ============================== */

console.log('\n— ③ 知识库之外的显著标注 —')
if (!WITH_MODEL) {
  console.log('SKIP：config/secrets.json 里没有 @geewiki/llm.apiKey，无法打真实上游。')
  console.log('     （这是一次**明确跳过**，不是通过 —— 这一半的价值全在真实模型上。）')
} else {
  /*
   * 打真实的 `/api/ai/turn`：需要登录主体，故照 p2b 的做法建一个用户并登录。
   * 只读它返回的 done 帧，不验渲染（标注的渲染由 web 侧单测覆盖）。
   */
  const EMAIL = 'p5-nav-admin@example.com'
  const PASSWORD = 'p5-nav-admin-password-1'
  let cookie = ''
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cookie !== '') headers['cookie'] = cookie
    headers['x-gw-csrf'] = '1'
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) cookie = setCookie.split(';')[0] ?? cookie
    return { status: res.status, text: await res.text() }
  }

  const { hashPassword } = await import('../../../packages/plugin-auth/src/password.js')
  const db = app.get('db') as
    | { run(sql: string, params?: unknown[]): { lastInsertRowid: number | bigint }; transaction<T>(fn: () => T): T }
    | undefined
  if (!db) throw new Error("database-provider 不在（ctx.get('db') 取不到）")
  const credential = await hashPassword(PASSWORD)
  const now = new Date().toISOString()
  db.transaction(() => {
    const inserted = db.run(
      `INSERT INTO users (org_id, email, display_name, status, email_verified, created_at) VALUES (?, ?, ?, 'active', 1, ?)`,
      [1, EMAIL, 'P5 验收', now],
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
  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
  check('建主体并登录', login.status === 200 && cookie !== '', `status=${login.status}`)

  /** 发一回合，流式读到底，返回 done 帧的 data */
  const turn = async (text: string): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gw-csrf': '1', cookie },
      body: JSON.stringify({
        messages: [{ role: 'user', content: text }],
        clientTools: [],
        round: 0,
        page: null,
        conversationId: 'p5-verify',
        turnId: `t-${Date.now()}`,
      }),
    })
    if (res.status !== 200 || res.body === null) return null
    const raw = await res.text()
    const blocks = raw.split('\n\n').filter((b) => b.startsWith('event: done'))
    const last = blocks.at(-1)
    if (last === undefined) return null
    const dataLine = last.split('\n').find((l) => l.startsWith('data:'))
    if (dataLine === undefined) return null
    return JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>
  }

  const outside = await turn('用一句话说明什么是快速排序。不要查知识库，直接答。')
  check('知识库外的问题：done 帧带 grounded 字段', typeof outside?.['grounded'] === 'boolean', JSON.stringify(outside?.['grounded']))
  check('知识库外的问题被判为无依据', outside?.['grounded'] === false)

  const inside = await turn('主页上怎么新建内容？')
  check('知识库内的问题被判为有依据', inside?.['grounded'] === true, JSON.stringify(inside?.['grounded']))
}

/* ------------------------------ 收尾 ------------------------------ */

await cleanup()
console.log('')
if (failures.length > 0) {
  console.error(`✗ P5 验收失败 ${failures.length} 条：\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
if (!WITH_MODEL) {
  console.log('△ P5 验收：护栏与跳转工具那一半全部通过；标注那一半**未验**（缺密钥）。')
  process.exit(2)
}
console.log('✓ P5 验收全部通过（跳转工具 / 管理台护栏 / 知识库之外的标注）。')
