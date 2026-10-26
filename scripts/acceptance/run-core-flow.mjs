#!/usr/bin/env node
/** 在临时数据库、配置和自动分配的端口上运行核心流程；--dev 验证 Vite 路径。 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temporary = await mkdtemp(join(tmpdir(), 'geewiki-core-flow-'))
const dev = process.argv.includes('--dev')
const mode = dev ? 'dev' : 'prod'
const output = join(root, 'data/verify', `core-flow-${mode}`)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const children = []
const logs = []

async function freePort() {
  const probe = createServer()
  await new Promise((res, rej) => { probe.once('error', rej); probe.listen(0, '127.0.0.1', res) })
  const port = probe.address().port
  await new Promise((res, rej) => probe.close((err) => err ? rej(err) : res()))
  return port
}

async function start(name, command, args, env) {
  const log = await open(join(output, `${name}.log`), 'w')
  logs.push(log)
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] })
  children.push(child)
  child.on('error', (error) => { child.startError = error })
  return child
}

async function waitFor(url, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.startError) throw child.startError
    if (child.exitCode !== null) throw new Error(`${url} 的进程提前退出：${child.exitCode}；日志 ${output}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      await response.arrayBuffer()
      if (response.ok) return
    } catch { /* 进程正在监听前重试 */ }
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error(`等待 ${url} 超时；日志 ${output}`)
}

try {
  const serverPort = await freePort()
  const cdpPort = await freePort()
  const configDir = join(temporary, 'config')
  await mkdir(configDir)
  await writeFile(join(configDir, 'plugins.base.json'), JSON.stringify({ enabled: [
    { name: '@geewiki/db-sqlite', config: { filename: join(temporary, 'data/wiki.db') } },
    { name: '@geewiki/http' }, { name: '@geewiki/auth' }, { name: '@geewiki/org' },
    { name: '@geewiki/authz' }, { name: '@geewiki/wiki' },
  ] }))
  await writeFile(join(configDir, 'plugins.session.json'), JSON.stringify({ enabled: [] }))
  const env = { ...process.env, GEEWIKI_DATA_DIR: join(temporary, 'data'), GEEWIKI_CONFIG_DIR: configDir,
    GEEWIKI_PORT: String(serverPort), GEEWIKI_HOST: '127.0.0.1', GEEWIKI_PLUGINS_DIR: join(temporary, 'plugins') }
  delete env.GEEWIKI_ADMIN_TOKEN
  const backendUrl = `http://127.0.0.1:${serverPort}`
  const server = await start('server', process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], env)
  await waitFor(`${backendUrl}/api/auth/state`, server)
  let pageUrl = backendUrl
  if (dev) {
    const vitePort = await freePort()
    const vite = await start('vite', 'pnpm', ['--filter', '@geewiki/web', 'dev'], {
      ...env, GEEWIKI_DEV_API: backendUrl, GEEWIKI_DEV_PORT: String(vitePort),
    })
    pageUrl = `http://127.0.0.1:${vitePort}`
    await waitFor(pageUrl, vite)
  }
  const chrome = await start('chrome', process.env.CHROME_BIN ?? 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--password-store=basic', '--use-mock-keychain',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(temporary, 'chrome')}`, 'about:blank',
  ], env)
  await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, chrome)
  const test = spawn(process.execPath, ['scripts/acceptance/core-flow-cdp.mjs', pageUrl, String(cdpPort), output],
    { cwd: root, env, stdio: 'inherit' })
  const code = await new Promise((res, rej) => { test.once('error', rej); test.once('exit', res) })
  if (code !== 0) throw new Error(`核心流程验收失败：${code}；日志 ${output}`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue
    try { process.kill(-child.pid, 'SIGTERM') } catch { continue }
    let timer
    await Promise.race([
      new Promise((res) => child.once('exit', res)),
      new Promise((res) => { timer = setTimeout(res, 4000) }),
    ])
    clearTimeout(timer)
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }
  await Promise.all(logs.map((log) => log.close()))
  await rm(temporary, { recursive: true, force: true })
}
