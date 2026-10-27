/** 浏览器验收的隔离实例：临时数据库/配置/插件、独立端口及可回收的服务/Vite/Chrome。 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export async function runBrowserFlow({ name, script, prepare }) {
  const temporary = await mkdtemp(join(tmpdir(), `geewiki-${name}-`))
  const dev = process.argv.includes('--dev')
  const output = join(root, 'data/verify', `${name}-${dev ? 'dev' : 'prod'}`)
  const children = []
  const logs = []
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    for (const child of children) {
      if (child.exitCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出 */ }
      }
    }
  }
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)

  async function freePort() {
    const probe = createServer()
    await new Promise((res, rej) => { probe.once('error', rej); probe.listen(0, '127.0.0.1', res) })
    const port = probe.address().port
    await new Promise((res, rej) => probe.close((err) => err ? rej(err) : res()))
    return port
  }

  async function start(label, command, args, env, cwd = root) {
    if (interrupted) throw new Error('验收已中断')
    const log = await open(join(output, `${label}.log`), 'w')
    logs.push(log)
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] })
    children.push(child)
    child.on('error', (error) => { child.startError = error })
    return child
  }

  async function waitFor(url, child) {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('验收已中断')
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
    await rm(output, { recursive: true, force: true })
    await mkdir(output, { recursive: true })
    const fixture = await prepare?.(temporary) ?? {}
    const serverPort = await freePort()
    const cdpPort = await freePort()
    const configDir = join(temporary, 'config')
    await mkdir(configDir)
    await writeFile(join(configDir, 'plugins.base.json'), JSON.stringify({ enabled: [
      { name: '@geewiki/db-sqlite', config: { filename: join(temporary, 'data/wiki.db') } },
      { name: '@geewiki/http' }, { name: '@geewiki/auth' }, { name: '@geewiki/org' },
      { name: '@geewiki/authz' }, { name: '@geewiki/wiki' },
      ...(fixture.enabled ?? []),
    ] }))
    await writeFile(join(configDir, 'plugins.session.json'), JSON.stringify({ enabled: [] }))
    const env = { ...process.env, ...fixture.env,
      GEEWIKI_DATA_DIR: join(temporary, 'data'), GEEWIKI_CONFIG_DIR: configDir,
      GEEWIKI_PORT: String(serverPort), GEEWIKI_HOST: '127.0.0.1', GEEWIKI_PLUGINS_DIR: join(temporary, 'plugins') }
    delete env.GEEWIKI_ADMIN_TOKEN
    const backendUrl = `http://127.0.0.1:${serverPort}`
    const server = await start('server', process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], env)
    await waitFor(`${backendUrl}/api/auth/state`, server)
    let pageUrl = backendUrl
    if (dev) {
      const vitePort = await freePort()
      const webRoot = join(root, 'packages/web')
      const requireWeb = createRequire(join(webRoot, 'package.json'))
      const viteEntry = join(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js')
      // 执行 dev 脚本使用的本地 Vite，工作目录和配置解析与包内执行一致。
      const vite = await start('vite', process.execPath, [viteEntry], {
        ...env, GEEWIKI_DEV_API: backendUrl, GEEWIKI_DEV_PORT: String(vitePort),
      }, webRoot)
      pageUrl = `http://127.0.0.1:${vitePort}`
      await waitFor(pageUrl, vite)
    }
    const chrome = await start('chrome', process.env.CHROME_BIN ?? 'google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--password-store=basic', '--use-mock-keychain',
      `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(temporary, 'chrome')}`, 'about:blank',
    ], env)
    await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, chrome)
    const test = await start('acceptance', process.execPath,
      [`scripts/acceptance/${script}`, pageUrl, String(cdpPort), output], env)
    const code = await new Promise((res, rej) => { test.once('error', rej); test.once('exit', res) })
    if (code !== 0) throw new Error(`${name} 验收失败：${code}；日志 ${output}`)
    console.log(`${name} ${dev ? 'dev' : 'prod'} 验收通过；日志 ${output}`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    process.off('SIGTERM', interrupt)
    process.off('SIGINT', interrupt)
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
}
