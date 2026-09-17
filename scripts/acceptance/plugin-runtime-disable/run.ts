/**
 * 端到端验收：**真·临时停用**（进程内停用基础层插件）。
 *
 * 与前缀单测的分工：`packages/manager/test/runtime-disable.test.ts` 用测试替身钉住语义
 * （不落盘、激活即清登记、持久化即移除、依赖方守卫）。这里跑**真实进程 + 真实插件注册表 +
 * 真实 HTTP**，验的是单测结构上够不到的两件事：
 *   1. 清单文件真的**一个字节都没变**（"不落盘"这句话的最硬证据）；
 *   2. **重启**（新进程）之后插件真的按基础清单回来了。
 *
 * 隔离纪律：`GEEWIKI_CONFIG_DIR` 指向临时副本 ⇒ 即使跑"应用并持久化"也只改副本，
 * 绝不碰仓库里的 `config/plugins.base.json`（那是用户实际在用的配置）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const TOKEN = 'acceptance-token-runtime-disable'
const PORT = Number(process.env.GW_PORT ?? 3316)
const BASE = `http://127.0.0.1:${PORT}`

const work = mkdtempSync(join(tmpdir(), 'gw-runtime-disable-'))
const configDir = join(work, 'config')
const dataDir = join(work, 'data')
cpSync(join(REPO, 'config'), configDir, { recursive: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let child: ChildProcess | null = null
async function startServer(): Promise<void> {
  child = spawn('pnpm', ['--filter', '@geewiki/server', 'start'], {
    cwd: REPO,
    env: {
      ...process.env,
      GEEWIKI_DATA_DIR: dataDir,
      GEEWIKI_CONFIG_DIR: configDir,
      GEEWIKI_PORT: String(PORT),
      GEEWIKI_ADMIN_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // 自成进程组：`pnpm` 只是包装，真正跑服务的是它的子进程；只 kill(pnpm) 会留下
    // 仍在监听端口的孙进程，于是"重启"变成"同一个进程继续服务"（本脚本真踩过：
    // 重启后仍报 runtimeDisabled=true，看起来像后端不落盘失效，其实是没重启）。
    detached: true,
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/plugins/graph`, { headers: { 'x-gw-admin-token': TOKEN } })
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('服务在 90 秒内没有就绪')
}

async function stopServer(): Promise<void> {
  if (!child) return
  const c = child
  child = null
  const pid = c.pid
  const killGroup = (sig: NodeJS.Signals): void => {
    if (pid === undefined) return
    try {
      process.kill(-pid, sig) // 负号 = 整个进程组（含 pnpm 下方的 tsx/服务进程）
    } catch {
      try {
        c.kill(sig)
      } catch {
        /* 已经退出 */
      }
    }
  }
  killGroup('SIGTERM')
  await sleep(1500)
  killGroup('SIGKILL')
  await sleep(700)
  // 反空洞：确认端口真的放开了，否则后面的"重启"会连到旧进程上（假绿）
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/plugins/graph`, { headers: { 'x-gw-admin-token': TOKEN } })
      await sleep(300)
    } catch {
      return
    }
  }
  throw new Error('旧实例没有被关掉（端口仍在响应）')
}

interface Node {
  id: string
  layer: string | null
  state: string
  runtimeDisabled: boolean
}
const graphOf = async (): Promise<{ nodes: Node[]; edges: { source: string; target: string }[] }> => {
  const r = await fetch(`${BASE}/api/plugins/graph`, { headers: { 'x-gw-admin-token': TOKEN } })
  return (await r.json()).graph
}
const disable = async (name: string): Promise<{ status: number; body: unknown }> => {
  const r = await fetch(`${BASE}/api/plugins/${encodeURIComponent(name)}/disable`, {
    method: 'POST',
    headers: { 'x-gw-admin-token': TOKEN },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const persist = async (): Promise<unknown> => {
  const r = await fetch(`${BASE}/api/session/persist`, { method: 'POST', headers: { 'x-gw-admin-token': TOKEN } })
  return r.json()
}

const baseFile = join(configDir, 'plugins.base.json')
const sessionFile = join(configDir, 'plugins.session.json')
const snapshot = (): string => readFileSync(baseFile, 'utf8') + '\u0000' + readFileSync(sessionFile, 'utf8')
const nodeOf = async (name: string): Promise<Node | undefined> => (await graphOf()).nodes.find((n) => n.id === name)

try {
  await startServer()
  const g = await graphOf()
  const activeIds = new Set(g.nodes.filter((n) => n.state === 'active').map((n) => n.id))
  /* 挑一个"基础层、在跑、且没有活跃依赖方"的插件——有依赖方的会被守卫拦住（下面单独验） */
  const target = g.nodes.find(
    (n) =>
      n.layer === 'base' &&
      n.state === 'active' &&
      !g.edges.some((e) => e.source === n.id && activeIds.has(e.target)),
  )
  check('拓扑里存在符合条件的靶插件（基础层 + 在跑 + 无活跃依赖方）', target !== undefined, target?.id ?? '找不到')
  if (!target) throw new Error('无法继续')

  const before = snapshot()
  const res = await disable(target.id)
  check('停用基础层插件不再被拒（此前是 base_layer 错误）', res.status === 200, `HTTP ${res.status}`)

  const after = await nodeOf(target.id)
  check('停用后状态为未启用', after?.state === 'inactive', `state=${after?.state}`)
  check('停用后带上"临时停用"标记', after?.runtimeDisabled === true, `runtimeDisabled=${after?.runtimeDisabled}`)
  check(
    '两个清单文件逐字节未变（"不落盘"的硬证据）',
    snapshot() === before,
    snapshot() === before ? '' : '清单被改写了',
  )

  /* 依赖方守卫：挑一个有活跃依赖方的插件，必须 409 且**不得已经被卸掉** */
  const guarded = g.nodes.find(
    (n) => n.state === 'active' && g.edges.some((e) => e.source === n.id && activeIds.has(e.target)),
  )
  if (guarded) {
    const blocked = await disable(guarded.id)
    const still = await nodeOf(guarded.id)
    check(
      '有活跃依赖方时拒绝停用（409 has_dependents）且未被卸掉',
      blocked.status === 409 && still?.state === 'active',
      `HTTP ${blocked.status}，之后 state=${still?.state}`,
    )
  } else {
    check('有活跃依赖方时拒绝停用（409 has_dependents）且未被卸掉', true, '本注册表没有这种插件，跳过')
  }

  /* 重启：临时停用不落盘 ⇒ 必须按基础清单回来 */
  await stopServer()
  await startServer()
  const restored = await nodeOf(target.id)
  check('重启后照基础清单恢复运行', restored?.state === 'active', `state=${restored?.state}`)
  check('重启后不残留"临时停用"标记', restored?.runtimeDisabled === false, `runtimeDisabled=${restored?.runtimeDisabled}`)

  /* 应用并持久化：把停用写进基础清单 ⇒ 此后重启也不再加载 */
  await disable(target.id)
  const persisted = (await persist()) as { disabled?: string[] }
  check(
    '应用并持久化时报告了被永久停用的插件',
    Array.isArray(persisted.disabled) && persisted.disabled.includes(target.id),
    JSON.stringify(persisted.disabled ?? null),
  )
  check(
    '基础清单里该条目已被移除',
    !readFileSync(baseFile, 'utf8').includes(target.id),
    '',
  )
  await stopServer()
  await startServer()
  const gone = await nodeOf(target.id)
  check('持久化停用后重启不再加载', gone?.state === 'inactive', `state=${gone?.state}`)
} catch (err) {
  check('验收脚本执行完成', false, err instanceof Error ? err.message : String(err))
} finally {
  await stopServer()
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
