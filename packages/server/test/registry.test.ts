/**
 * 组合根注册表构建（packages/server/src/index.ts 的 buildRegistry）测试。
 *
 * 覆盖：内置注册表 + 外部插件目录合并；被跳过的插件目录以 issue 形式返回
 * （旧实现丢弃 `discovered.issues`，管理台完全看不到"目录里躺着但没加载"的插件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry, defaultRegistry } from '../src/index.js'

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'gw-registry-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('buildRegistry：内置 4 条 + 外部插件合并，跳过目录记为 issues', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const ok = join(root, 'hello')
    mkdirSync(ok, { recursive: true })
    writeFileSync(
      join(ok, 'package.json'),
      JSON.stringify({
        name: '@ext/hello',
        version: '1.0.0',
        type: 'module',
        geewiki: { provides: 'hello-service', entry: 'index.js' },
      }),
      'utf8',
    )
    writeFileSync(join(ok, 'index.js'), 'export default { name: "@ext/hello", apply() { return () => {} } }\n', 'utf8')

    const broken = join(root, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'index.js'), 'export default {}\n', 'utf8')

    const built = await buildRegistry(null, {}, root)
    assert.equal(built.registry.length, defaultRegistry(null).length + 1, '内置 + 1 个外部插件')
    const external = built.registry.filter((p) => p.source === 'external')
    assert.deepEqual(
      external.map((p) => p.name),
      ['@ext/hello'],
    )
    assert.equal(external[0]?.manifest.geewiki.provides, 'hello-service')

    assert.equal(built.issues.length, 1, '坏目录必须变成可见的 issue，而不是被丢弃')
    assert.equal(built.issues[0]?.code, 'missing_manifest')
    assert.ok(built.issues[0]?.dir.endsWith('broken'))
  } finally {
    cleanup()
  }
})

test('buildRegistry：pluginsRoot 为 null → 仅内置注册表且 issues 为空数组', async () => {
  const { root, cleanup } = makeRoot()
  try {
    // 即使目录里躺着坏插件，null 表示"不做外部发现"，不做任何扫描
    mkdirSync(join(root, 'broken'), { recursive: true })
    const built = await buildRegistry(null, {}, null)
    assert.equal(built.registry.length, defaultRegistry(null).length)
    assert.deepEqual(built.issues, [])
  } finally {
    cleanup()
  }
})

test('buildRegistry：外部插件目录不可用（不是目录）→ issues 记录且不抛错', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const notADir = join(root, 'plugins.txt')
    writeFileSync(notADir, 'x', 'utf8')
    const built = await buildRegistry(null, {}, notADir)
    assert.equal(built.registry.length, defaultRegistry(null).length, '内置插件不受影响')
    assert.equal(built.issues[0]?.code, 'invalid_plugin_dir')
  } finally {
    cleanup()
  }
})
