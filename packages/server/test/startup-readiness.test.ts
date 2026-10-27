/** 启动门禁：失败不留下监听端口，自定义注册表可显式要求服务。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, defaultRegistry } from '../src/index.js'
import { freePort } from './helpers.js'

async function withConfig(fn: (configDir: string, port: number) => Promise<void>): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), 'geewiki-readiness-'))
  const port = await freePort()
  await writeFile(join(configDir, 'plugins.base.json'), JSON.stringify({ enabled: [{ name: '@geewiki/http' }] }))
  await writeFile(join(configDir, 'plugins.session.json'), JSON.stringify({ enabled: [] }))
  try {
    await fn(configDir, port)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
}

async function assertPortReleased(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

function httpOnly(port: number) {
  return defaultRegistry(null, { port, host: '127.0.0.1' }).filter((entry) => entry.name === '@geewiki/http')
}

test('自定义注册表缺省支持局部宿主，dispose 释放端口', async () => {
  await withConfig(async (configDir, port) => {
    const running = await startServer({ configDir, registry: httpOnly(port), webDist: null, pluginsDir: null })
    try {
      assert.ok(running.app.get('http'))
    } finally {
      await running.dispose()
    }
    await assertPortReleased(port)
  })
})

test('必要服务缺失时启动失败，并清理已经监听的 HTTP', async () => {
  await withConfig(async (configDir, port) => {
    await assert.rejects(startServer({
      configDir,
      registry: httpOnly(port),
      webDist: null,
      pluginsDir: null,
      requiredServices: ['http', 'wiki-service'],
    }), /必要服务未就绪: wiki-service/)
    await assertPortReleased(port)
  })
})

test('标准部署默认检查必要服务，不允许仅 HTTP 存活', async () => {
  await withConfig(async (configDir, port) => {
    await assert.rejects(startServer({ configDir, port, host: '127.0.0.1', webDist: null, pluginsDir: null }),
      /必要服务未就绪: db, auth-service, policy-service, wiki-service/)
    await assertPortReleased(port)
  })
})
