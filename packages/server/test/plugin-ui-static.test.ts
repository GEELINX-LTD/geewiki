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
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

interface TwoRootFixture extends UiFixture {
  /** 高优先级根（`<dir>/dist`）里的入口文件路径 */
  extEntry: string
  /** 次优先根（`<webDist>/plugins-ui/<名>`）里的入口文件路径 */
  webEntry: string
}

/**
 * 双根并存夹具：同一插件的**两个候选根都有同名入口文件**，内容不同以便区分实际命中的根。
 *
 * 用途单一但关键——验证"根表的寿命必须与入口表一致"：静态层若把"用哪个根"缓存成一次性
 * 求值，则高优先级根消失后仍会指着旧根 → 404，而入口表（每次现算）已回退到次优先根并在表里
 * 继续列出该插件，前端就会照表里的值去 import 一个 404 的资产。
 */
async function startTwoRootFixture(): Promise<TwoRootFixture> {
  const root = mkdtempSync(join(tmpdir(), 'gw-ui-2root-'))
  const pluginDir = join(root, 'both-ext')
  const webDist = join(root, 'web')
  const configDir = join(root, 'config')
  const extEntry = join(pluginDir, 'dist', 'client.js')
  const webEntry = join(webDist, 'plugins-ui', '@ext', 'both', 'client.js')
  mkdirSync(join(pluginDir, 'dist'), { recursive: true })
  mkdirSync(join(webDist, 'plugins-ui', '@ext', 'both'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  // 两个根都放同名入口，正文不同（含可 grep 的标记）
  writeFileSync(extEntry, 'export const register = () => {}\n// CONTENT: plugin-dir-dist\n', 'utf8')
  writeFileSync(webEntry, 'export const register = () => {}\n// CONTENT: web-dist-plugins-ui\n', 'utf8')

  const both = externalUiPlugin('@ext/both', pluginDir)
  const registry = [both]
  const port = await freePort()
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
    extEntry,
    webEntry,
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

test('静态层：高优先级根消失后必须回退次优先根（根表判定与入口表同寿命，禁止一次性缓存）', async () => {
  const fx = await startTwoRootFixture()
  try {
    const url = `http://127.0.0.1:${fx.port}/plugins-ui/@ext/both/client.js`

    // 1) 两个根都有产物时：高优先级 <dir>/dist 生效
    const first = await fetch(url)
    assert.equal(first.status, 200, '两个根都有产物时应 200')
    const firstBody = await first.text()
    assert.match(firstBody, /CONTENT: plugin-dir-dist/, '应先命中高优先级根 <dir>/dist')

    // 2) 删除高优先级根里的入口文件（模拟插件产物被清掉/挂载点变化）
    rmSync(fx.extEntry, { force: true })

    // 3) 同一资产必须回退到次优先根并仍为 200——若"用哪个根"被一次性缓存，这里会是 404
    const second = await fetch(url)
    assert.equal(
      second.status,
      200,
      '高优先级根消失后必须回退 <webDist>/plugins-ui/<名>，不得 404（根表不得缓存）',
    )
    const secondBody = await second.text()
    assert.match(secondBody, /CONTENT: web-dist-plugins-ui/, '回退后正文应来自次优先根')

    // 4) 表与资产一致：入口表仍列出该插件，且它给出的 rev 必须正是静态层此刻真正服务的那个文件
    const tableRes = await fetch(`http://127.0.0.1:${fx.port}/api/plugins/ui`)
    assert.equal(tableRes.status, 200)
    const table = (await tableRes.json()) as {
      plugins: Record<string, { entry: string; rev: string }>
    }
    const listed = table.plugins['@ext/both']
    assert.ok(listed, '入口表应仍列出 @ext/both（现算后回退到次优先根）')
    const info = statSync(fx.webEntry)
    const expectedRev = createHash('sha1')
      .update(`${info.mtimeMs}-${info.size}`)
      .digest('hex')
      .slice(0, 8)
    assert.equal(
      listed?.rev,
      expectedRev,
      '入口表的 rev 必须与静态层实际服务的文件同源（表说有 rev、资产却是旧的/404 即为两真源不一致）',
    )
  } finally {
    await fx.cleanup()
  }
})
