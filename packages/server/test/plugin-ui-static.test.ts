/**
 * 插件 UI 资产的**静态层**端到端测试（真实 HTTP，非替身）。
 *
 * 覆盖三件容易出错、且出错时"看起来不像错误"的事：
 * 1. `/plugins-ui/<名>/<文件>` 能从**插件自带产物根**（`<dir>/dist`，外部插件在 Docker 里
 *    是 bind mount，这是"装插件即生效"的路径）取到文件，且 MIME 正确；
 * 2. 未知插件、路径穿越、目录式请求一律 **404**，尤其**不得落进 SPA fallback**
 *    （否则会变成 200 + text/html，浏览器加载 bundle 时报 MIME 错误、快照里看不出真因）；
 * 3. 编码名（`%40geewiki`）不被接受——插件名一律不编码，这是与前端写死的约定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { GeeWikiManifest } from '@geewiki/core'
import { pluginUiRootsFor, type RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, startServer } from '../src/index.js'
import { freePort, waitForHealth } from './helpers.js'

/* ------------------------------ 夹具 ------------------------------ */

interface UiFixture {
  port: number
  webDist: string
  pluginDir: string
  cleanup: () => Promise<void>
}

function externalUiPlugin(name: string, dir: string): RegisteredPlugin {
  const manifest: GeeWikiManifest = {
    name,
    version: '1.0.0',
    geewiki: {
      provides: 'ui-fixture',
      requires: [],
      runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
      client: { entry: 'client.js', css: 'client.css' },
    },
  }
  return {
    name,
    manifest,
    module: {
      name,
      apply: (_ctx: Context) => () => undefined,
    },
    dir,
    source: 'external',
  }
}

/**
 * 起一个隔离实例：外部插件自带产物（`<dir>/dist`）+ webDist 里的第二根，
 * registry 直接交给 startServer（跳过外部发现，夹具更可控）。
 */
async function startUiFixture(): Promise<UiFixture> {
  const root = mkdtempSync(join(tmpdir(), 'gw-ui-static-'))
  const pluginDir = join(root, 'hello-ext')
  const webDist = join(root, 'web')
  const configDir = join(root, 'config')
  // 外部插件自带产物根
  mkdirSync(join(pluginDir, 'dist'), { recursive: true })
  writeFileSync(join(pluginDir, 'dist', 'client.js'), 'export const register = () => {}\n', 'utf8')
  writeFileSync(join(pluginDir, 'dist', 'client.css'), '.gw-ext { color: blue; }\n', 'utf8')
  // webDist 第二根（宿主产物约定位置）：@t/web-ui 只有这一处产物
  mkdirSync(join(webDist, 'plugins-ui', '@t', 'web-ui'), { recursive: true })
  writeFileSync(join(webDist, 'plugins-ui', '@t', 'web-ui', 'client.js'), 'export const register = () => {}\n', 'utf8')
  mkdirSync(configDir, { recursive: true })

  const ext = externalUiPlugin('@ext/hello', pluginDir)
  const webOnly = externalUiPlugin('@t/web-ui', join(root, 'no-such-dir'))
  const registry = [ext, webOnly]
  const port = await freePort()
  // 关键：http 条目绑定"按名查根"的懒求值闭包——与 startServer 走 buildRegistry 时同机制
  const httpEntry = httpRegistryEntry(webDist, { port, host: '127.0.0.1' }, () =>
    pluginUiRootsFor(registry, webDist),
  )
  const fullRegistry = [httpEntry, ...registry]
  writeFileSync(
    join(configDir, 'plugins.base.json'),
    `${JSON.stringify({ enabled: fullRegistry.map((e) => ({ name: e.name })) }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(configDir, 'plugins.session.json'), `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')

  const handle = await startServer({ registry: fullRegistry, port, host: '127.0.0.1', configDir, webDist })
  await waitForHealth(port)
  return {
    port,
    webDist,
    pluginDir,
    cleanup: async () => {
      await handle.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/* ------------------------------ 用例 ------------------------------ */

test('静态层：插件自带产物根能提供 bundle（200 + text/javascript / text/css）', async () => {
  const fx = await startUiFixture()
  try {
    const js = await fetch(`http://127.0.0.1:${fx.port}/plugins-ui/@ext/hello/client.js`)
    assert.equal(js.status, 200, '两段 scope 名 + 自带产物根应可服务')
    assert.match(js.headers.get('content-type') ?? '', /text\/javascript/)
    assert.match(await js.text(), /register/)
    const css = await fetch(`http://127.0.0.1:${fx.port}/plugins-ui/@ext/hello/client.css`)
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type') ?? '', /text\/css/)
  } finally {
    await fx.cleanup()
  }
})

test('静态层：webDist 第二根同样可服务（单段名）', async () => {
  const fx = await startUiFixture()
  try {
    const res = await fetch(`http://127.0.0.1:${fx.port}/plugins-ui/@t/web-ui/client.js`)
    assert.equal(res.status, 200, '插件目录没有产物时应回落 webDist/plugins-ui/<名>')
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/)
  } finally {
    await fx.cleanup()
  }
})

test('静态层：未知插件 404，且绝不落进 SPA fallback（content-type 非 text/html）', async () => {
  const fx = await startUiFixture()
  try {
    const res = await fetch(`http://127.0.0.1:${fx.port}/plugins-ui/@ext/nope/client.js`)
    assert.equal(res.status, 404, '未注册的插件名必须 404')
    const type = res.headers.get('content-type') ?? ''
    assert.ok(!type.includes('text/html'), `不得回退 index.html，实际 content-type=${type}`)
    assert.deepEqual(await res.json(), { ok: false, error: 'not_found' })
  } finally {
    await fx.cleanup()
  }
})

test('静态层：路径穿越与目录式请求一律 404', async () => {
  const fx = await startUiFixture()
  try {
    for (const path of [
      '/plugins-ui/@ext/hello/../secret.js',
      '/plugins-ui/@ext/hello/',
      '/plugins-ui/@ext/',
      '/plugins-ui/',
      '/plugins-ui/@ext/hello/a/b/client.js',
      '/plugins-ui/@ext/hello/.env',
    ]) {
      const res = await fetch(`http://127.0.0.1:${fx.port}${path}`)
      assert.equal(res.status, 404, `${path} 应 404`)
      const type = res.headers.get('content-type') ?? ''
      assert.ok(!type.includes('text/html'), `${path} 不得变成 SPA fallback（content-type=${type}）`)
      await res.arrayBuffer()
    }
  } finally {
    await fx.cleanup()
  }
})

test('静态层：编码名不被接受（插件名一律不编码，与前端约定一致）', async () => {
  const fx = await startUiFixture()
  try {
    const res = await fetch(`http://127.0.0.1:${fx.port}/plugins-ui/%40ext/hello/client.js`)
    assert.equal(res.status, 404, '%40ext 查不到表项，必须 404')
    const type = res.headers.get('content-type') ?? ''
    assert.ok(!type.includes('text/javascript'), '不得把编码名解析成真实插件')
    await res.arrayBuffer()
  } finally {
    await fx.cleanup()
  }
})

test('静态层：入口表端点在真实 server 上可达，且只列有产物的插件', async () => {
  const fx = await startUiFixture()
  try {
    const res = await fetch(`http://127.0.0.1:${fx.port}/api/plugins/ui`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = (await res.json()) as {
      ok: boolean
      version: number
      revision: string
      plugins: Record<string, { entry: string; css?: string; rev: string }>
      skipped: { name: string; reason: string }[]
    }
    assert.equal(body.ok, true)
    assert.equal(body.version, 1)
    // 两个夹具都已激活且都有产物 → 都应在表里
    assert.deepEqual(Object.keys(body.plugins).sort(), ['@ext/hello', '@t/web-ui'])
    assert.equal(body.plugins['@ext/hello']?.entry, 'client.js')
    assert.equal(body.plugins['@ext/hello']?.css, 'client.css')
    assert.match(body.plugins['@t/web-ui']?.rev ?? '', /^[0-9a-f]{8}$/)
    // ETag 与 revision 一致，且能命中 304
    assert.equal(res.headers.get('etag'), `"${body.revision}"`)
    const cached = await fetch(`http://127.0.0.1:${fx.port}/api/plugins/ui`, {
      headers: { 'if-none-match': `"${body.revision}"` },
    })
    assert.equal(cached.status, 304)
  } finally {
    await fx.cleanup()
  }
})

test('静态层：入口表与静态层对同一插件给出同一个根（不变式：存在性判定只有一份实现）', async () => {
  const fx = await startUiFixture()
  try {
    // 入口表说 @ext/hello 就绪 → 它的资产必须真的可取到（反之即是"表里有 rev、资产 404"）
    const table = (await (await fetch(`http://127.0.0.1:${fx.port}/api/plugins/ui`)).json()) as {
      plugins: Record<string, { entry: string }>
    }
    for (const [name, info] of Object.entries(table.plugins)) {
      const res = await fetch(`http://127.0.0.1:${fx.port}/plugins-ui/${name}/${info.entry}`)
      assert.equal(res.status, 200, `入口表列出的 ${name} 必须可取到 ${info.entry}`)
      await res.arrayBuffer()
    }
  } finally {
    await fx.cleanup()
  }
})
