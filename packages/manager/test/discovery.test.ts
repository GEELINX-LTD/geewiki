/**
 * 外部插件发现（packages/manager/src/discovery.ts）测试。
 *
 * 覆盖：两种清单来源、入口探测优先级、重名跳过、路径穿越拒绝、
 * 加载抛错与非法模块的失败隔离、隐藏目录忽略，以及各纯函数。
 * 夹具用临时目录真实落盘 + 真实 ESM 动态 import（不走桩）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DiscoveryError,
  isInsideDir,
  isInsideDirReal,
  listPluginDirs,
  loadExternalPlugins,
  parsePluginManifest,
  resolvePluginEntry,
  scanPluginDirs,
} from '../src/discovery.js'

/* ------------------------------ 夹具工具 ------------------------------ */

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'gw-plugins-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/** 写一个插件目录：package.json（可选）+ 清单文件（可选）+ 入口（可选） */
function writePlugin(
  root: string,
  dir: string,
  opts: { pkg?: unknown; standalone?: unknown; entryFile?: string; entryContent?: string },
): string {
  const pluginDir = join(root, dir)
  mkdirSync(pluginDir, { recursive: true })
  if (opts.pkg !== undefined) writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(opts.pkg, null, 2), 'utf8')
  if (opts.standalone !== undefined) {
    writeFileSync(join(pluginDir, 'geewiki.manifest.json'), JSON.stringify(opts.standalone, null, 2), 'utf8')
  }
  if (opts.entryFile) writeFile(join(pluginDir, opts.entryFile), opts.entryContent ?? '', )
  return pluginDir
}

const OK_MODULE = 'export default { name: "%NAME%", apply() { return () => {} } }\n'

/* ------------------------------ 纯函数 ------------------------------ */

test('parsePluginManifest：package.json 的 geewiki 键优先，其次独立 geewiki.manifest.json', () => {
  const fromPkg = parsePluginManifest(
    { name: '@x/a', version: '2.1.0', geewiki: { provides: 'a-service' } },
    { name: '@x/ignored', version: '9.9.9', geewiki: { provides: 'ignored' } },
  )
  assert.equal(fromPkg.name, '@x/a')
  assert.equal(fromPkg.version, '2.1.0')
  assert.equal(fromPkg.geewiki.provides, 'a-service')

  const fromStandalone = parsePluginManifest(undefined, { name: '@x/b', version: '1.0.0', geewiki: { provides: 'b' } })
  assert.equal(fromStandalone.name, '@x/b')

  // package.json 存在但没有 geewiki 键 → 回落到独立清单
  const fallback = parsePluginManifest({ name: '@x/c' }, { name: '@x/c', version: '3.0.0', geewiki: {} })
  assert.equal(fallback.name, '@x/c')

  // 版本缺省 → 0.0.0
  assert.equal(parsePluginManifest({ name: '@x/d', geewiki: {} }, undefined).version, '0.0.0')
})

test('parsePluginManifest：无清单/缺名称 → missing_manifest / invalid_manifest', () => {
  assert.throws(
    () => parsePluginManifest({ name: '@x/e' }, undefined),
    (err: unknown) => err instanceof DiscoveryError && err.code === 'missing_manifest',
  )
  assert.throws(
    () => parsePluginManifest({ geewiki: {} }, undefined),
    (err: unknown) => err instanceof DiscoveryError && err.code === 'invalid_manifest',
  )
  assert.throws(
    () => parsePluginManifest(undefined, { version: '1.0.0', geewiki: {} }),
    (err: unknown) => err instanceof DiscoveryError && err.code === 'invalid_manifest',
  )
})

test('isInsideDir：目录内为真，越界/相等/绝对路径为假', () => {
  assert.equal(isInsideDir('/a/b', '/a/b/c.ts'), true)
  assert.equal(isInsideDir('/a/b', '/a/b/deep/c.ts'), true)
  assert.equal(isInsideDir('/a/b', '/a/b'), false, '相等不算"内"')
  assert.equal(isInsideDir('/a/b', '/a/b/../escape.ts'), false)
  assert.equal(isInsideDir('/a/b', '/a/other/c.ts'), false)
  assert.equal(isInsideDir('/a/b', '/etc/passwd'), false)
})

test('resolvePluginEntry：显式 entry 优先，其后 index.ts → index.js → src/index.ts', () => {
  const { root, cleanup } = makeRoot()
  try {
    const dir = join(root, 'p')
    mkdirSync(dir, { recursive: true })
    writeFile(join(dir, 'index.ts'), 'export default {}\n')
    writeFile(join(dir, 'src/index.ts'), 'export default {}\n')
    assert.equal(resolvePluginEntry(dir), join(dir, 'index.ts'), 'index.ts 先于 src/index.ts')

    writeFile(join(dir, 'custom.js'), 'export default {}\n')
    assert.equal(resolvePluginEntry(dir, 'custom.js'), join(dir, 'custom.js'), '显式 entry 优先')

    // 无 index.ts 时回落 index.js
    const dir2 = join(root, 'p2')
    mkdirSync(dir2, { recursive: true })
    writeFile(join(dir2, 'index.js'), 'export default {}\n')
    assert.equal(resolvePluginEntry(dir2), join(dir2, 'index.js'))

    // 均不存在 → undefined
    const dir3 = join(root, 'p3')
    mkdirSync(dir3, { recursive: true })
    assert.equal(resolvePluginEntry(dir3), undefined)

    // 越界 → invalid_plugin_path
    assert.throws(
      () => resolvePluginEntry(dir, '../outside.ts'),
      (err: unknown) => err instanceof DiscoveryError && err.code === 'invalid_plugin_path',
    )
  } finally {
    cleanup()
  }
})

test('listPluginDirs：忽略隐藏目录与下划线目录，按名称排序', () => {
  const { root, cleanup } = makeRoot()
  try {
    for (const name of ['b-plugin', 'a-plugin', '.hidden', '_template']) mkdirSync(join(root, name), { recursive: true })
    writeFile(join(root, 'not-a-dir.txt'), 'x')
    assert.deepEqual(
      listPluginDirs(root).map((p) => p.slice(root.length + 1)),
      ['a-plugin', 'b-plugin'],
    )
    assert.deepEqual(listPluginDirs(join(root, 'missing')), [], '根目录不存在 → 空数组')
  } finally {
    cleanup()
  }
})

/* --------------------------- loadExternalPlugins --------------------------- */

test('loadExternalPlugins：发现两种清单来源的插件，其余异常目录逐个隔离为 issue', async () => {
  const { root, cleanup } = makeRoot()
  const log: string[] = []
  try {
    // A：package.json 内嵌清单 + index.js 入口
    writePlugin(root, 'plugin-a', {
      pkg: { name: '@ext/a', version: '1.0.0', type: 'module', geewiki: { provides: 'a-service', entry: 'index.js' } },
      entryFile: 'index.js',
      entryContent: OK_MODULE.replace('%NAME%', '@ext/a'),
    })
    // B：独立 geewiki.manifest.json + src/index.ts 入口（TS 由进程内 tsx loader 执行）
    writePlugin(root, 'plugin-b', {
      standalone: {
        name: '@ext/b',
        version: '2.0.0',
        geewiki: { provides: 'b-service', runtime: { supportsHotReload: true } },
      },
      entryFile: 'src/index.ts',
      entryContent: 'const plugin = { name: "@ext/b", apply() { return () => {} } }\nexport default plugin\n',
    })
    // C：没有任何清单
    writePlugin(root, 'plugin-c', { entryFile: 'index.js', entryContent: OK_MODULE.replace('%NAME%', '@ext/c') })
    // D：有清单但无入口文件
    writePlugin(root, 'plugin-d', { pkg: { name: '@ext/d', version: '1.0.0', geewiki: {} } })
    // E：与内置插件重名
    writePlugin(root, 'plugin-e', {
      pkg: { name: '@builtin/x', version: '1.0.0', type: 'module', geewiki: {} },
      entryFile: 'index.js',
      entryContent: OK_MODULE.replace('%NAME%', '@builtin/x'),
    })
    // F：入口越界（../escape.js）
    writePlugin(root, 'plugin-f', {
      pkg: { name: '@ext/f', version: '1.0.0', geewiki: { entry: '../escape.js' } },
    })
    // G：入口加载即抛错
    writePlugin(root, 'plugin-g', {
      pkg: { name: '@ext/g', version: '1.0.0', type: 'module', geewiki: { entry: 'index.js' } },
      entryFile: 'index.js',
      entryContent: 'throw new Error("boom from plugin-g")\n',
    })
    // H：合法模块但未导出 apply
    writePlugin(root, 'plugin-h', {
      pkg: { name: '@ext/h', version: '1.0.0', type: 'module', geewiki: { entry: 'index.js' } },
      entryFile: 'index.js',
      entryContent: 'export default { name: "@ext/h" }\n',
    })
    // 隐藏目录与模板目录不应被扫描
    writePlugin(root, '.ignored', { entryFile: 'index.js', entryContent: 'throw new Error("不应被加载")\n' })
    writePlugin(root, '_template', { entryFile: 'index.js', entryContent: 'throw new Error("不应被加载")\n' })

    const result = await loadExternalPlugins({
      root,
      builtinNames: ['@builtin/x'],
      log: (msg) => log.push(msg),
    })

    assert.deepEqual(
      result.plugins.map((p) => p.name).sort(),
      ['@ext/a', '@ext/b'],
      '只有 A、B 应被加载',
    )
    for (const p of result.plugins) {
      assert.equal(p.source, 'external')
      assert.equal(typeof p.module.apply, 'function')
      assert.ok(p.dir?.startsWith(root))
    }
    const b = result.plugins.find((p) => p.name === '@ext/b')
    assert.equal(b?.manifest.version, '2.0.0')
    assert.equal(b?.manifest.geewiki.provides, 'b-service')

    const codes = new Map(result.issues.map((i) => [i.dir.slice(root.length + 1), i.code]))
    assert.deepEqual(codes.get('plugin-c'), 'missing_manifest')
    assert.deepEqual(codes.get('plugin-d'), 'entry_not_found')
    assert.deepEqual(codes.get('plugin-e'), 'duplicate_plugin')
    assert.deepEqual(codes.get('plugin-f'), 'invalid_plugin_path')
    assert.deepEqual(codes.get('plugin-g'), 'load_failed')
    assert.deepEqual(codes.get('plugin-h'), 'invalid_module')
    assert.equal(result.issues.length, 6, '隐藏/下划线目录不产生 issue')
    assert.ok(
      result.issues.some((i) => i.message.includes('boom from plugin-g')),
      '加载失败应保留原始错误信息',
    )
    assert.ok(log.some((m) => m.includes('已发现外部插件 @ext/a')), '成功加载应打印日志')
  } finally {
    cleanup()
  }
})

test('loadExternalPlugins：插件根目录不存在 → 空结果且不抛错', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = await loadExternalPlugins({ root: join(root, 'missing'), log: () => {} })
    assert.deepEqual(result, { plugins: [], issues: [] })
  } finally {
    cleanup()
  }
})

/* --------------------- 路径守卫：符号链接（realpath） --------------------- */

test('isInsideDirReal：两侧都按真实路径判定，根目录自身是符号链接时不误拒', () => {
  const { root, cleanup } = makeRoot()
  try {
    const real = join(root, 'real')
    mkdirSync(join(real, 'p'), { recursive: true })
    writeFile(join(real, 'p', 'index.ts'), 'export default {}\n')
    const linkRoot = join(root, 'link-root')
    symlinkSync(real, linkRoot, 'dir')

    assert.equal(isInsideDirReal(join(linkRoot, 'p'), join(linkRoot, 'p', 'index.ts')), true)
    assert.equal(isInsideDirReal(join(linkRoot, 'p'), join(real, 'p', 'index.ts')), true, '同一文件的另一种写法')
    assert.equal(isInsideDirReal(join(linkRoot, 'p'), '/etc/passwd'), false)
    assert.equal(isInsideDirReal(join(root, 'nope'), join(root, 'nope', 'x')), false, 'realpath 失败 → 保守拒绝')
  } finally {
    cleanup()
  }
})

test('resolvePluginEntry：插件目录内的 symlink 指向目录外 → invalid_plugin_path', () => {
  const { root, cleanup } = makeRoot()
  try {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFile(join(outside, 'evil.ts'), 'export default { name: "@evil", apply() { return () => {} } }\n')

    const dir = join(root, 'p')
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(outside, 'evil.ts'), join(dir, 'index.ts'))
    assert.throws(
      () => resolvePluginEntry(dir),
      (err: unknown) => err instanceof DiscoveryError && err.code === 'invalid_plugin_path',
      '词法上在目录内、真实路径在目录外 → 必须拒绝（否则会执行目录外代码）',
    )
  } finally {
    cleanup()
  }
})

test('resolvePluginEntry：指向目录内文件的 symlink 放行；插件根自身是 symlink 时正常工作', () => {
  const { root, cleanup } = makeRoot()
  try {
    // 真实插件根 + 指向它的符号链接（用 symlink 挂载 plugins/ 是合法用法）
    const realRoot = join(root, 'real-plugins')
    mkdirSync(join(realRoot, 'p'), { recursive: true })
    writeFile(join(realRoot, 'p', 'index.ts'), 'export default {}\n')
    const linkRoot = join(root, 'plugins-link')
    symlinkSync(realRoot, linkRoot, 'dir')
    assert.equal(
      resolvePluginEntry(join(linkRoot, 'p')),
      join(linkRoot, 'p', 'index.ts'),
      '根目录是符号链接时不得把全部插件误判为越界',
    )

    // 目录内 → 目录内文件的符号链接：真实路径仍在目录内 → 放行
    const dir = join(root, 'p2')
    mkdirSync(dir, { recursive: true })
    writeFile(join(dir, 'real.ts'), 'export default {}\n')
    symlinkSync(join(dir, 'real.ts'), join(dir, 'index.ts'))
    assert.equal(resolvePluginEntry(dir), join(dir, 'index.ts'))
  } finally {
    cleanup()
  }
})

test('loadExternalPlugins：migrations 符号链接越界 → 记 issue 且不采用该迁移目录（插件本体仍加载）', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const outsideMigrations = join(root, 'outside-migrations')
    mkdirSync(outsideMigrations, { recursive: true })
    writeFile(join(outsideMigrations, '0001.sql'), 'create table x(id integer);\n')
    const dir = writePlugin(root, 'plugin-m', {
      pkg: {
        name: '@ext/m',
        version: '1.0.0',
        type: 'module',
        geewiki: { entry: 'index.js', migrations: './migrations' },
      },
      entryFile: 'index.js',
      entryContent: OK_MODULE.replace('%NAME%', '@ext/m'),
    })
    symlinkSync(outsideMigrations, join(dir, 'migrations'), 'dir')

    const result = await loadExternalPlugins({ root, log: () => {} })
    assert.deepEqual(
      result.plugins.map((p) => p.name),
      ['@ext/m'],
      '迁移目录越界只影响迁移，不应连插件一起拒绝',
    )
    assert.equal(result.plugins[0]?.migrationsDir, undefined, '越界的迁移目录不得被采用（否则会执行目录外 SQL）')
    assert.ok(
      result.issues.some((i) => i.code === 'invalid_plugin_path' && i.message.includes('迁移目录')),
      `应记录迁移目录越界的 issue: ${JSON.stringify(result.issues)}`,
    )
  } finally {
    cleanup()
  }
})

test('scanPluginDirs：符号链接目录纳入扫描；目标不是目录/悬空链接 → invalid_plugin_dir', () => {
  const { root, cleanup } = makeRoot()
  try {
    mkdirSync(join(root, 'real-plugin'), { recursive: true })
    symlinkSync(join(root, 'real-plugin'), join(root, 'linked-plugin'), 'dir')
    writeFile(join(root, 'plain.txt'), 'x')
    symlinkSync(join(root, 'plain.txt'), join(root, 'linked-file'))
    symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'))

    const scan = scanPluginDirs(root)
    assert.deepEqual(
      scan.dirs.map((p) => p.slice(root.length + 1)),
      ['linked-plugin', 'real-plugin'],
      'symlink 指向目录时必须被扫描（旧实现静默忽略）',
    )
    const byName = new Map(scan.issues.map((i) => [i.dir.slice(root.length + 1), i.code]))
    assert.equal(byName.get('linked-file'), 'invalid_plugin_dir')
    assert.equal(byName.get('dangling'), 'invalid_plugin_dir')
    assert.equal(scan.issues.length, 2, '普通文件不产生 issue')
  } finally {
    cleanup()
  }
})

test('scanPluginDirs：插件根不是目录 → 返回空并记 issue（旧实现会抛 ENOTDIR 冒泡成启动崩溃）', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const notADir = join(root, 'plugins.txt')
    writeFile(notADir, 'x')

    const scan = scanPluginDirs(notADir)
    assert.deepEqual(scan.dirs, [])
    assert.equal(scan.issues[0]?.code, 'invalid_plugin_dir')

    // 组合根视角：必须拿到 issue 而不是异常（异常会被当成启动崩溃 + crash.marker + 容器重启循环）
    const result = await loadExternalPlugins({ root: notADir, log: () => {} })
    assert.deepEqual(result.plugins, [])
    assert.equal(result.issues.length, 1)
  } finally {
    cleanup()
  }
})

/* ---------------- 展示字段必须能穿过外部清单解析（无白名单裁剪） ---------------- */

test('外部清单：displayName/description 被完整解析（证明 manifest 无字段白名单裁剪）', async () => {
  const { root, cleanup } = makeRoot()
  try {
    // ① 纯函数层：package.json#geewiki 与独立清单都要保留这两个字段
    const fromPkg = parsePluginManifest(
      {
        name: '@x/named',
        version: '1.0.0',
        geewiki: { displayName: '外部插件示例', description: '演示从 plugins/ 目录加载插件', provides: 'x' },
      },
      undefined,
    )
    assert.equal(fromPkg.geewiki.displayName, '外部插件示例')
    assert.equal(fromPkg.geewiki.description, '演示从 plugins/ 目录加载插件')

    const fromStandalone = parsePluginManifest(undefined, {
      name: '@x/standalone',
      version: '1.0.0',
      geewiki: { displayName: '独立清单', description: '走 geewiki.manifest.json' },
    })
    assert.equal(fromStandalone.geewiki.displayName, '独立清单')
    assert.equal(fromStandalone.geewiki.description, '走 geewiki.manifest.json')

    // ② 端到端：真实目录发现后，字段仍在注册表条目里（供 /api/plugins 快照透传）
    writePlugin(root, 'named-plugin', {
      pkg: {
        name: '@ext/named',
        version: '1.0.0',
        geewiki: { displayName: '命名插件', description: '一句话说明', entry: 'index.js' },
      },
      entryFile: 'index.js',
      entryContent: 'export default { name: "@ext/named", apply() { return () => {} } }\n',
    })
    const result = await loadExternalPlugins({ root, log: () => {} })
    const found = result.plugins.find((p) => p.name === '@ext/named')
    assert.ok(found, '应发现该外部插件')
    assert.equal(found.manifest.geewiki.displayName, '命名插件', '展示字段不得在发现期被丢弃')
    assert.equal(found.manifest.geewiki.description, '一句话说明')
  } finally {
    cleanup()
  }
})
