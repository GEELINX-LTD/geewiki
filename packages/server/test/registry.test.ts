/**
 * 组合根注册表构建（packages/server/src/index.ts 的 buildRegistry）测试。
 *
 * 覆盖：内置注册表 + 外部插件目录合并；被跳过的插件目录以 issue 形式返回
 * （旧实现丢弃 `discovered.issues`，管理台完全看不到"目录里躺着但没加载"的插件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('出厂配置：默认基础层清单**不得**启用会顶掉内置编辑器的插件（X1）', () => {
  /*
   * 这条钉的是真机实测过一次的数据丢失：
   * `editor` 是**单占用**插槽（`packages/web/src/lib/slots.tsx` 的 `SINGLE_OCCUPANCY_SLOTS`），
   * 而插槽契约 `EditorSlotProps`（core 侧权威副本）里**没有上传通道** ⇒ 插件一旦占了它，
   * 内置 CodeMirror —— **唯一**支持附件拖拽/粘贴上传的编辑器 —— 根本不渲染：
   * 用户拖入文件时 0 个请求、无占位、无提示，浏览器还会把窗口导航到那个文件
   * （未保存的正文一起丢）。
   *
   * 所以"出厂配置不得启用编辑器类插件"不是偏好，而是**在插槽契约补上上传能力之前**的硬约束。
   * 将来真要默认启用某个编辑器插件，请先让 `EditorSlotProps` 带上上传通道
   * （core 副本 + web 镜像 + `packages/web/test/editorSlotProps.test.ts` 的镜像守卫一起改），
   * 再把它的名字从下面的清单里删掉。
   */
  const editorPlugins = ['@geewiki/editor-plain']
  /*
   * 读**随版本发布**的那一份（`plugins.base.example.json`），不是本机 live 文件。
   *
   * `config/plugins.base.json` 被 `.gitignore` 整个拒绝（保存一次配置就会重写它），
   * 所以它在**干净检出里根本不存在**——本测试曾经因此在 CI 里必然以
   * `ENOENT: ... config/plugins.base.json` 失败，而在开发者本机（那份文件恰好在）通过。
   * 一条只在某些机器上能过的守卫，比没有守卫更坏：它把"没人跑过"伪装成"已经验过"。
   *
   * 而本测试要钉的是**出厂**配置，那正是 example 那份：manager 的 `readBaseList`
   * （`packages/manager/src/index.ts`，live 文件缺失时回退读 example）意味着
   * **新部署实际装配的就是它**。本机 live 文件里启用什么是这台机器的选择，
   * 不该让一条测试在别人机器上变红。
   */
  const configPath = join(repoRoot(), 'config', 'plugins.base.example.json')
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { enabled: { name: string }[] }
  const names = cfg.enabled.map((e) => e.name)

  // 反空洞：先证明真的读到了清单（路径写错时 names 会是空数组，"0 个违规"就成了假绿）
  assert.ok(names.includes('@geewiki/wiki'), `未能从 ${configPath} 读到默认清单（names=${names.join(',')}）`)

  assert.deepEqual(
    names.filter((n) => editorPlugins.includes(n)),
    [],
    `默认基础层清单启用了编辑器插件（${configPath}）：它会顶掉内置编辑器，用户将无法拖拽/粘贴上传附件。` +
      '先把上传能力补进 EditorSlotProps，再考虑默认启用。',
  )
})

/** 从本测试文件向上找到含 pnpm-workspace.yaml 的仓库根 */
function repoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    try {
      readFileSync(join(cur, 'pnpm-workspace.yaml'))
      return cur
    } catch {
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  throw new Error('未能向上找到仓库根（pnpm-workspace.yaml）')
}
