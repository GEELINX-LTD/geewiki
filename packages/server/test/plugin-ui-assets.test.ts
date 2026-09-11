/**
 * 插件 UI 资产的**子目录**支持端到端测试（真实 HTTP，非替身）。
 *
 * 为什么需要本文件：改动前 `/plugins-ui/<名>/<相对路径>` 只接受**单段文件名**
 * （`PLUGIN_UI_FILE_SEGMENT` 不含 `/`），故插件无法提供 `assets/logo.svg`、字体、
 * 图片或代码分割出的 chunk——真实插件的 UI 必然需要这些。本文件钉住新能力，
 * 同时钉住它**没有**把安全边界放松（这是本批的主要风险）。
 *
 * 覆盖四类：① 子目录资源可取且 MIME 正确；② 未知扩展名给安全默认值而**不是** text/html；
 * ③ 路径穿越（`..`、编码变形、绝对路径、**符号链接逃逸**）一律 404；
 * ④ 缓存分级（带指纹长缓存 / 无指纹 no-cache）与资产 ETag/304。
 *
 * 与既有 `plugin-ui-static.test.ts` 的分工：那个文件守住**入口文件**与既有约定
 * （含「`a/b/client.js` 文件不存在时必须 404」与「编码名不认」），本文件只加新面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { GeeWikiManifest } from '@geewiki/core'
import { PLUGIN_UI_ASSET_MAX_DEPTH, PLUGIN_UI_ASSET_PATH } from '@geewiki/core'
import { pluginUiRootsFor, type RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, startServer } from '../src/index.js'
import { freePort, waitForHealth } from './helpers.js'

/* ------------------------------ 夹具 ------------------------------ */

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function externalUiPlugin(name: string, dir: string): RegisteredPlugin {
  const manifest: GeeWikiManifest = {
    name,
    version: '1.0.0',
    geewiki: {
      provides: 'ui-fixture',
      requires: [],
      runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
      client: { entry: 'client.js' },
    },
  }
  return {
    name,
    manifest,
    module: { name, apply: (_ctx: Context) => () => undefined },
    dir,
    source: 'external',
  }
}

interface Fixture {
  port: number
  pluginDir: string
  outside: string
  cleanup: () => Promise<void>
}

/**
 * 起一个隔离实例：插件自带产物根里放**子目录**资源、字体、带指纹 chunk、
 * 一个指向根外的**符号链接**（用于验证 realpath containment），
 * 以及根外的一个 `secret.txt` 作为穿越目标。
 */
async function startAssetFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'gw-ui-assets-'))
  const pluginDir = join(root, 'asset-ext')
  const webDist = join(root, 'web')
  const configDir = join(root, 'config')
  const dist = join(pluginDir, 'dist')
  mkdirSync(dist, { recursive: true })
  mkdirSync(join(dist, 'assets'), { recursive: true })
  mkdirSync(join(dist, 'js', 'chunks'), { recursive: true })
  mkdirSync(join(dist, 'fonts'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(webDist, { recursive: true })

  writeFileSync(join(dist, 'client.js'), 'export const register = () => {}\n', 'utf8')
  // 子目录里的图片（一层）
  writeFileSync(join(dist, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'utf8')
  // 嵌套两层的代码分割 chunk
  writeFileSync(join(dist, 'js', 'chunks', 'chunk-abc.js'), 'export const x = 1\n', 'utf8')
  // 字体
  writeFileSync(join(dist, 'fonts', 'inter.woff2'), 'wOF2fake', 'utf8')
  // 未知扩展名（须给安全默认 MIME，绝不能是 text/html）
  writeFileSync(join(dist, 'assets', 'blob.bin'), 'BINARY', 'utf8')
  // 带内容指纹的资源（应长缓存）
  writeFileSync(join(dist, 'assets', 'logo-D3f4G5h6.svg'), '<svg/>\n', 'utf8')
  writeFileSync(join(dist, 'assets', 'pixel.png'), Buffer.from(PNG_1PX, 'base64'))

  // 根外的敏感文件：任何穿越尝试的目标
  const outside = join(root, 'secret.txt')
  writeFileSync(outside, 'TOP-SECRET-OUTSIDE-ROOT\n', 'utf8')
  // 符号链接逃逸：dist/escape.txt → 根外文件（形态合法，只能靠 realpath 拦住）
  symlinkSync(outside, join(dist, 'escape.txt'))

  const ext = externalUiPlugin('@ext/assets', pluginDir)
  const registry = [ext]
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
    pluginDir,
    outside,
    cleanup: async () => {
      await handle.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const url = (f: Fixture, p: string): string => `http://127.0.0.1:${f.port}/plugins-ui/@ext/assets/${p}`

/**
 * 用**原始 socket** 发请求，绕过客户端的 URL 规范化。
 *
 * 为什么必须这样测路径穿越：`fetch`（undici）走 `new URL()`，而 URL 解析会**在发出前**
 * 就把 `/a/../b` 规范化成 `/b`——实测确认。于是用 fetch 测 `../secret.txt` 时，
 * 服务器**从未收到**穿越串，用例恒绿却什么也没验证（本文件的穿越用例第一版正是如此，
 * 被变异测试抓出：去掉服务端两层防护后仍然全绿）。
 * 只有手写请求行，才能把服务端**自己**的规范化与校验置于真实输入之下。
 */
async function rawGet(port: number, rawPath: string): Promise<{ status: number; headers: string; body: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buf = ''
    socket.setTimeout(5000)
    socket.on('connect', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
    })
    socket.on('timeout', () => {
      socket.destroy()
      rejectPromise(new Error(`rawGet 超时：${rawPath}`))
    })
    socket.on('error', rejectPromise)
    socket.on('close', () => {
      const idx = buf.indexOf('\r\n\r\n')
      const head = idx < 0 ? buf : buf.slice(0, idx)
      const body = idx < 0 ? '' : buf.slice(idx + 4)
      const status = Number.parseInt(head.split(' ')[1] ?? '0', 10)
      resolvePromise({ status, headers: head, body })
    })
  })
}

/* ------------------------------ ① 子目录资源可取 ------------------------------ */

test('子目录资产：一层子目录的 SVG 可取，MIME 正确', async () => {
  const f = await startAssetFixture()
  try {
    const res = await fetch(url(f, 'assets/logo.svg'))
    assert.equal(res.status, 200, 'assets/logo.svg 应可服务（改动前必 404）')
    assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/)
    assert.match(await res.text(), /<svg/)
  } finally {
    await f.cleanup()
  }
})

test('子目录资产：嵌套两层的 JS chunk 可取且 MIME 是可执行脚本', async () => {
  const f = await startAssetFixture()
  try {
    const res = await fetch(url(f, 'js/chunks/chunk-abc.js'))
    assert.equal(res.status, 200, 'js/chunks/chunk-abc.js 应可服务')
    // 必须是 JS MIME：否则浏览器会因严格的 MIME 检查拒绝加载模块
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/)
    assert.match(await res.text(), /export const x/)
  } finally {
    await f.cleanup()
  }
})

test('子目录资产：字体与 PNG 的 MIME 正确', async () => {
  const f = await startAssetFixture()
  try {
    const woff = await fetch(url(f, 'fonts/inter.woff2'))
    assert.equal(woff.status, 200)
    assert.match(woff.headers.get('content-type') ?? '', /font\/woff2/)

    const png = await fetch(url(f, 'assets/pixel.png'))
    assert.equal(png.status, 200)
    assert.match(png.headers.get('content-type') ?? '', /image\/png/)
    // 二进制不得被当文本改写：字节数应与源文件一致
    const bytes = Buffer.from(await png.arrayBuffer())
    assert.equal(bytes.length, Buffer.from(PNG_1PX, 'base64').length)
  } finally {
    await f.cleanup()
  }
})

/* ------------------------------ ② MIME 安全默认 ------------------------------ */

test('未知扩展名给 application/octet-stream，绝不回退 text/html', async () => {
  const f = await startAssetFixture()
  try {
    const res = await fetch(url(f, 'assets/blob.bin'))
    assert.equal(res.status, 200)
    const type = res.headers.get('content-type') ?? ''
    // 关键：未知内容若被当 HTML 渲染，就是一个 XSS 面
    assert.ok(!type.includes('text/html'), `未知扩展名不得是 text/html，实际=${type}`)
    assert.match(type, /application\/octet-stream/)
  } finally {
    await f.cleanup()
  }
})

/* ------------------------------ ③ 路径穿越与逃逸 ------------------------------ */

test('路径穿越：原始请求行（绕过客户端规范化）一律 404，且不泄漏任何根外内容', async () => {
  const f = await startAssetFixture()
  try {
    // 前置事实：URL 构造（fetch/undici 所用）会**消解点段**，故穿越串根本到不了服务器。
    // 这条断言是纯客户端的（不经服务器），它解释了为什么必须用 rawGet。
    assert.equal(
      new URL('http://127.0.0.1/plugins-ui/@ext/assets/../secret.txt').pathname,
      '/plugins-ui/@ext/secret.txt',
      '前提：URL 解析会在发出前把 /assets/../secret.txt 消解掉',
    )

    // 这些串必须以**原始形态**到达服务器才有意义
    for (const p of [
      '/plugins-ui/@ext/assets/../secret.txt',
      '/plugins-ui/@ext/assets/../../secret.txt',
      '/plugins-ui/@ext/assets/..%2fsecret.txt',
      '/plugins-ui/@ext/assets/%2e%2e/secret.txt',
      '/plugins-ui/@ext/assets/%2e%2e%2fsecret.txt',
      '/plugins-ui/@ext/assets/%252e%252e/secret.txt',
      '/plugins-ui/@ext/assets/....//secret.txt',
      '/plugins-ui/@ext/assets//secret.txt',
      '/plugins-ui/@ext/assets/../../../etc/passwd',
      '/plugins-ui/@ext/assets/..\\secret.txt',
      '/plugins-ui/@ext/assets/.env',
      '/plugins-ui/@ext/assets/.hidden',
      '/plugins-ui/@ext/assets/',
      '/plugins-ui/@ext/assets/a//b.js',
      '/plugins-ui',
      '/plugins-ui/',
    ]) {
      const res = await rawGet(f.port, p)
      assert.equal(res.status, 404, `${p} 应为 404，实际 ${res.status}`)
      const all = res.headers + res.body
      assert.ok(!all.includes('TOP-SECRET-OUTSIDE-ROOT'), `${p} 泄漏了根外文件内容`)
      assert.ok(!all.includes(f.pluginDir), `${p} 泄漏了服务器路径`)
      assert.ok(!all.includes('root:x:'), `${p} 泄漏了 /etc/passwd`)
      // 插件资产绝不回退 index.html（否则 200 + text/html 会掩盖真因）
      assert.ok(!/content-type:\s*text\/html/i.test(res.headers), `${p} 不得落进 SPA fallback`)
    }
  } finally {
    await f.cleanup()
  }
})

test('严格不折叠空段：`assets//logo.svg`（目标文件**存在**）必须 404 而非静默规范化', async () => {
  const f = await startAssetFixture()
  try {
    // 为什么这条用例是必要的：其它穿越串的目标文件都不存在，故"文件缺失导致的 404"会
    // 掩盖"严格检查缺席"。这里刻意指向一个**真实存在**的文件，使两者的结果可区分——
    // 若去掉严格检查，空段被 filter 掉后就会 200（也曾是 fetch 版用例失败的原因）。
    const res = await rawGet(f.port, '/plugins-ui/@ext/assets/assets//logo.svg')
    assert.equal(res.status, 404, '含空段的请求必须严格 404（不规范化后放行）')

    // 对照：去掉一个斜杠就能 200，证明"404 不是因为文件不存在"
    const ok = await rawGet(f.port, '/plugins-ui/@ext/assets/assets/logo.svg')
    assert.equal(ok.status, 200, '对照：同一文件在合法路径下必须 200')
  } finally {
    await f.cleanup()
  }
})

test('对照：同一批原始路径里，合法路径仍能 200（证明上面的 404 不是"全都坏"）', async () => {
  const f = await startAssetFixture()
  try {
    const ok = await rawGet(f.port, '/plugins-ui/@ext/assets/assets/logo.svg')
    assert.equal(ok.status, 200, '合法原始请求必须仍然成功')
    assert.ok(ok.body.includes('<svg'), '正文应是真实文件内容')
  } finally {
    await f.cleanup()
  }
})

test('符号链接逃逸：形态合法（escape.txt）但指向根外，必须 404', async () => {
  const f = await startAssetFixture()
  try {
    // 先确认这个链接真的存在且真的指向根外——否则本用例会“因为文件不存在”而空洞通过
    const { readlinkSync } = await import('node:fs')
    const target = readlinkSync(join(f.pluginDir, 'dist', 'escape.txt'))
    assert.equal(target, f.outside, '夹具前提：escape.txt 是指向根外文件的符号链接')

    const res = await fetch(url(f, 'escape.txt'))
    assert.equal(res.status, 404, '符号链接逃逸必须被 realpath 包含判定拦住')
    const body = await res.text()
    assert.ok(!body.includes('TOP-SECRET-OUTSIDE-ROOT'), '不得通过符号链接读到根外文件')
  } finally {
    await f.cleanup()
  }
})

test('未注册的插件名 → 404（子目录形态也一样）', async () => {
  const f = await startAssetFixture()
  try {
    for (const p of ['/plugins-ui/@ext/nope/assets/logo.svg', '/plugins-ui/@unknown/x/a/b/c.js']) {
      const res = await fetch(`http://127.0.0.1:${f.port}${p}`)
      assert.equal(res.status, 404, `${p} 应 404`)
      const type = res.headers.get('content-type') ?? ''
      assert.ok(!type.includes('text/html'), `${p} 不得落进 SPA fallback（type=${type}）`)
      await res.arrayBuffer()
    }
  } finally {
    await f.cleanup()
  }
})

test('不含扩展名的深层请求也 404，不会变成 SPA fallback', async () => {
  const f = await startAssetFixture()
  try {
    const res = await fetch(url(f, 'assets/not-there'))
    assert.equal(res.status, 404)
    const type = res.headers.get('content-type') ?? ''
    assert.ok(!type.includes('text/html'), `插件资产绝不回退 index.html，实际=${type}`)
  } finally {
    await f.cleanup()
  }
})

/* ------------------------------ ④ 缓存与条件请求 ------------------------------ */

test('缓存分级：带内容指纹的资产长缓存，无指纹的 no-cache', async () => {
  const f = await startAssetFixture()
  try {
    const hashed = await fetch(url(f, 'assets/logo-D3f4G5h6.svg'))
    assert.equal(hashed.status, 200)
    const hashedCc = hashed.headers.get('cache-control') ?? ''
    assert.match(hashedCc, /max-age=31536000/, `带指纹资源应长缓存，实际=${hashedCc}`)
    assert.match(hashedCc, /immutable/)

    const plain = await fetch(url(f, 'assets/logo.svg'))
    assert.equal(plain.status, 200)
    assert.equal(plain.headers.get('cache-control'), 'no-cache', '无指纹资源沿用既有 no-cache')
  } finally {
    await f.cleanup()
  }
})

test('资产 ETag：条件请求命中 304，且 304 不带响应体', async () => {
  const f = await startAssetFixture()
  try {
    const first = await fetch(url(f, 'assets/logo.svg'))
    assert.equal(first.status, 200)
    const etag = first.headers.get('etag')
    assert.ok(etag, '资产应带 ETag')
    await first.arrayBuffer()

    const second = await fetch(url(f, 'assets/logo.svg'), { headers: { 'if-none-match': etag } })
    assert.equal(second.status, 304, '携带相同 If-None-Match 应命中 304')
    const body = await second.arrayBuffer()
    assert.equal(body.byteLength, 0, '304 不得带响应体')
  } finally {
    await f.cleanup()
  }
})

test('含量变化后 ETag 变化（不是恒定值）', async () => {
  const f = await startAssetFixture()
  try {
    const before = await fetch(url(f, 'assets/logo.svg'))
    const etagBefore = before.headers.get('etag')
    await before.arrayBuffer()

    // 改内容（大小不同 ⇒ size 分量必变）
    writeFileSync(join(f.pluginDir, 'dist', 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n', 'utf8')

    const after = await fetch(url(f, 'assets/logo.svg'))
    const etagAfter = after.headers.get('etag')
    await after.arrayBuffer()
    assert.notEqual(etagBefore, etagAfter, '内容变化后 ETag 必须变化，否则客户会一直用旧缓存')
  } finally {
    await f.cleanup()
  }
})

/* ------------------------------ 规则本身的单元断言 ------------------------------ */

test('PLUGIN_UI_ASSET_PATH：接受合法层级路径、拒绝一切危险形态', () => {
  for (const ok of [
    'client.js',
    'assets/logo.svg',
    'js/chunks/chunk-abc.js',
    'fonts/inter.woff2',
    'a1/b2/c3/d4.e5',
    'logo-D3f4G5h6.svg',
  ]) {
    assert.ok(PLUGIN_UI_ASSET_PATH.test(ok), `应接受：${ok}`)
  }
  for (const bad of [
    '',
    '/',
    '/etc/passwd',
    '..',
    '../secret.txt',
    'a/../b',
    'a//b',
    'assets/',
    '/assets/x.js',
    '.env',
    'assets/.hidden',
    'a\\b.js',
    'a b.js',
    '%2e%2e/x',
    'assets/%2e%2e/x',
    'x%00y',
  ]) {
    assert.ok(!PLUGIN_UI_ASSET_PATH.test(bad), `应拒绝：${bad}`)
    assert.ok(!PLUGIN_UI_ASSET_PATH.test(bad), `应拒绝：${bad}`)
  }
  // 无 g 标志 ⇒ test() 无 lastIndex 状态（有状态会让交替调用结果不稳定）
  assert.ok(!PLUGIN_UI_ASSET_PATH.global)
  assert.ok(PLUGIN_UI_ASSET_MAX_DEPTH >= 4, '深度上限应容得下真实产物')
})
