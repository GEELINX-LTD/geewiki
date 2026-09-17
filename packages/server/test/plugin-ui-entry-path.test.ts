/**
 * ★ F13：插件 UI **入口/样式**支持分层路径（消除 A4）。
 *
 * ## 改的是什么、没改的是什么
 * 改动前 `geewiki.client.entry` / `.css` 必须是**单段文件名**（`PLUGIN_UI_FILE_SEGMENT`，
 * 不含 `/`）。而产物形态是插件自己的事：多入口或分目录输出时入口很自然落在
 * `ui/index.js`。此时插件只有两条路 —— 把产物摊平去迁就宿主，或者**声明不了自己的 UI**
 * （`pluginUiEntryOf` 对非法名返回 `undefined`，症状是"插件激活了但界面完全不加载"，
 * 日志里只有一条"没有产物"）。
 *
 * **限制被放宽，防护一个字没动**：路径判据复用 `PLUGIN_UI_ASSET_PATH`（逐段
 * `[A-Za-z0-9][A-Za-z0-9._-]*`），因此 `..`、`.`、空段、绝对路径全部不匹配；
 * 真正的路径防护仍在静态资源层（段比较 `isContained()` + realpath + 严格不折叠空段）。
 * 本文件第 1 组用例专门钉"放宽的部分不是安全边界"，第 3 组钉端到端真的能取到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { GeeWikiManifest } from '@geewiki/core'
import { pluginUiEntryOf, pluginUiRootsFor, type RegisteredPlugin } from '@geewiki/manager'
import { httpRegistryEntry, startServer } from '../src/index.js'
import { freePort, waitForHealth } from './helpers.js'

/* ============ 1. 清单解析：分层路径放行，危险形态一个不放 ============ */

/** 造一个只有 `client` 的最小清单 */
const manifestWith = (client: GeeWikiManifest['geewiki']['client']): GeeWikiManifest => ({
  name: '@t/entry',
  version: '1.0.0',
  geewiki: { requires: [], client },
})

test('★ F13：entry/css 接受分层路径（原先一律被拒）', () => {
  assert.deepEqual(pluginUiEntryOf(manifestWith({ entry: 'ui/index.js' })), { entry: 'ui/index.js' })
  assert.deepEqual(
    pluginUiEntryOf(manifestWith({ entry: 'ui/index.js', css: 'styles/main.css' })),
    { entry: 'ui/index.js', css: 'styles/main.css' },
  )
  // 单段文件名照旧（向后兼容）：既有插件的声明不受影响
  assert.deepEqual(pluginUiEntryOf(manifestWith({ entry: 'client.js' })), { entry: 'client.js' })
  // 缺省值仍是单段
  assert.deepEqual(pluginUiEntryOf(manifestWith({})), { entry: 'client.js' })
  // 深路径在深度上限内即可
  assert.deepEqual(pluginUiEntryOf(manifestWith({ entry: 'a/b/c/d/e.js' })), { entry: 'a/b/c/d/e.js' })
})

test('★ F13：放宽的是**限制**，不是**防护** —— 危险形态仍整体视为未声明', () => {
  /*
   * 失败方向与改动前一致：**不加载**，而不是"加载到别处去"。
   * 若哪天有人把判据换成"包含 `/` 就放行"，`../secret.txt` 会被拼进 `join(root, entry)`，
   * 于是入口探测会去 stat 根外的路径 —— 本用例就是拦这个的。
   */
  for (const bad of [
    '../escape.js', // 上跳
    'ui/../../escape.js', // 中段上跳
    '/etc/passwd', // 绝对路径
    'ui//index.js', // 空段
    'ui/./index.js', // 当前目录段
    './ui/index.js', // 以 `.` 开头
    '.hidden/index.js', // 段以 `.` 开头
    'ui/index.js/', // 尾随斜杠（尾段为空）
    'ui/%2e%2e/x.js', // 编码变形（判据不解码 ⇒ 直接非法）
    'ui/a b.js', // 含空白
    'ui\\index.js', // 反斜杠（Windows 分隔符）
    'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q.js', // 超过深度上限
  ]) {
    assert.equal(
      pluginUiEntryOf(manifestWith({ entry: bad })),
      undefined,
      `必须整体视为未声明（不加载）：${JSON.stringify(bad)}`,
    )
  }
  // css 用同一条判据：入口合法但样式是穿越路径 ⇒ 整条声明作废（不留"半可信"状态）
  assert.equal(pluginUiEntryOf(manifestWith({ entry: 'ui/index.js', css: '../evil.css' })), undefined)
})

/* ============ 2. 端到端：分层入口真的被服务 ============ */

function nestedUiPlugin(name: string, dir: string): RegisteredPlugin {
  const manifest: GeeWikiManifest = {
    name,
    version: '1.0.0',
    geewiki: {
      provides: 'ui-fixture',
      requires: [],
      runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
      client: { entry: 'ui/index.js', css: 'styles/main.css' },
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

test('★ F13：声明 `ui/index.js` 的插件，入口与样式都能经 /plugins-ui 取到', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-ui-entry-'))
  const pluginDir = join(root, 'nested-ext')
  const webDist = join(root, 'web')
  const configDir = join(root, 'config')
  const dist = join(pluginDir, 'dist')
  mkdirSync(join(dist, 'ui'), { recursive: true })
  mkdirSync(join(dist, 'styles'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(webDist, { recursive: true })

  const bundle = 'export const register = () => "nested"\n'
  const css = '.nested { color: red }\n'
  writeFileSync(join(dist, 'ui', 'index.js'), bundle, 'utf8')
  writeFileSync(join(dist, 'styles', 'main.css'), css, 'utf8')
  // 与入口同目录的其它资源（字体/wasm/sourcemap 走同一条通道，无需声明）
  writeFileSync(join(dist, 'ui', 'index.js.map'), '{"version":3}\n', 'utf8')

  const ext = nestedUiPlugin('@ext/nested', pluginDir)
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
  try {
    await waitForHealth(port)
    const base = `http://127.0.0.1:${port}/plugins-ui/@ext/nested/`

    const entryRes = await fetch(`${base}ui/index.js`)
    assert.equal(entryRes.status, 200, '分层入口必须可取（改动前这里 404 —— 入口表压根不认这条声明）')
    assert.match(entryRes.headers.get('content-type') ?? '', /javascript/)
    assert.equal(await entryRes.text(), bundle)

    const cssRes = await fetch(`${base}styles/main.css`)
    assert.equal(cssRes.status, 200, '分层样式同样可取')
    assert.match(cssRes.headers.get('content-type') ?? '', /text\/css/)

    // sourcemap 与入口同目录：走同一条静态通道，无需任何声明
    const mapRes = await fetch(`${base}ui/index.js.map`)
    assert.equal(mapRes.status, 200)
    assert.match(mapRes.headers.get('content-type') ?? '', /json/)

    // 入口表必须把**分层路径原样**下发，否则前端会去请求 client.js
    const tableRes = await fetch(`http://127.0.0.1:${port}/api/plugins/ui`)
    const table = (await tableRes.json()) as { plugins: Record<string, { entry: string; css?: string }> }
    assert.equal(table.plugins['@ext/nested']?.entry, 'ui/index.js')
    assert.equal(table.plugins['@ext/nested']?.css, 'styles/main.css')

    // 穿越请求仍然被静态层拒（放宽入口路径没有放松这一侧）
    const escape = await fetch(`http://127.0.0.1:${port}/plugins-ui/@ext/nested/../../secret.txt`)
    assert.equal(escape.status, 404)
  } finally {
    await handle.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
