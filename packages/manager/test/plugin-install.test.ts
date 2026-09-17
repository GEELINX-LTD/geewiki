/**
 * ★ F17：外部插件**安装**与**完整性校验**的守卫。
 *
 * ## 这个文件重点防两类东西
 *
 * **一、恶意压缩包。** 安装路径会解包**外部来源**的内容，而 tar 条目可以写成
 * 绝对路径（`/etc/passwd`）、带回溯段的相对路径（`../../x`）、或符号链接。
 * 前两种让文件落到目标目录之外，第三种让"目录内的文件"在运行时指向目录外。
 * 三种都由 GNU tar 的 `-P` 真实构造出来（不是假设），并断言**拒绝**且目标未被创建。
 * 防御分两层：解包**前**逐条判路径，解包**后**再走一遍树确认没有链接 ——
 * 不把安全性寄托在某个 tar 实现的行为上。
 *
 * **二、把"无法判断"说成"通过"。** 没有完整性基线的插件是 `unsigned`（不知道有没有被改过），
 * **不是** `ok`。把这两者混起来，就会得到一个"看起来在防护、实际什么都没防"的实现 ——
 * 那正是本模块开头声明要避免的事。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INTEGRITY_FILE,
  classifySource,
  collectPluginFiles,
  installPlugin,
  planInstall,
  readIntegrity,
  verifyAllIntegrity,
  verifyIntegrity,
} from '../src/plugin-install.js'

/** 造一个合法插件目录；`extra` 用于追加文件 */
function makePlugin(root: string, dirName: string, extra: Record<string, string> = {}): string {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@geewiki-plugin/${dirName}`, version: '1.0.0', geewiki: { displayName: dirName } }),
    'utf8',
  )
  writeFileSync(join(dir, 'index.ts'), 'export function apply() {}\n', 'utf8')
  for (const [rel, content] of Object.entries(extra)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'gw-install-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function tar(args: readonly string[], cwd?: string): void {
  const r = spawnSync('tar', args as string[], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `tar ${args.join(' ')} 失败: ${r.stderr}`)
}

/* ------------------------------ 来源判定 ------------------------------ */

test('★ F17：只接受 https 的远程来源（明文 http 会让包在路上被换掉）', () => {
  assert.equal(classifySource('./some-plugin'), 'dir')
  assert.equal(classifySource('/abs/foo.tgz'), 'tarball')
  assert.equal(classifySource('foo.tar.gz'), 'tarball')
  assert.equal(classifySource('https://example.test/foo.tgz'), 'url')
  assert.throws(() => classifySource('http://example.test/foo.tgz'), /拒绝 http:\/\//)
})

/* ------------------------------ 目录来源 ------------------------------ */

test('★ F17：从目录安装 → 基线写入且校验为 ok；源目录【不被搬走】', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo', { 'lib/util.ts': 'export const x = 1\n' })

    const result = await installPlugin({ pluginsRoot: plugins, source: src })
    assert.equal(result.name, '@geewiki-plugin/demo')
    assert.equal(result.files, 3, 'package.json + index.ts + lib/util.ts')
    assert.equal(existsSync(join(result.dir, INTEGRITY_FILE)), true)

    // 源目录必须原样还在（安装是复制，不是搬家）
    assert.equal(existsSync(join(src, 'index.ts')), true)
    assert.equal(readIntegrity(result.dir)?.rootHash, result.integrity.rootHash)

    assert.deepEqual(verifyIntegrity(result.dir).status, 'ok')
  } finally {
    env.cleanup()
  }
})

test('★ F17：基线与内容不一致时报告 drift，并分清改动/新增/删除', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo', { 'a.txt': 'A', 'b.txt': 'B' })
    const { dir } = await installPlugin({ pluginsRoot: plugins, source: src })

    writeFileSync(join(dir, 'a.txt'), 'A CHANGED', 'utf8') // 改
    writeFileSync(join(dir, 'c.txt'), 'C', 'utf8') // 增
    rmSync(join(dir, 'b.txt')) // 删

    const report = verifyIntegrity(dir)
    assert.equal(report.status, 'drift')
    assert.deepEqual(report.changed, ['a.txt'])
    assert.deepEqual(report.added, ['c.txt'])
    assert.deepEqual(report.removed, ['b.txt'])
    assert.match(report.reason ?? '', /1 个改动、1 个新增、1 个删除/)
  } finally {
    env.cleanup()
  }
})

test('★ F17：没有基线是 unsigned【不是 ok】—— "无法判断"不等于"通过"', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo')
    const { dir } = await installPlugin({ pluginsRoot: plugins, source: src })

    rmSync(join(dir, INTEGRITY_FILE))
    const report = verifyIntegrity(dir)
    assert.equal(report.status, 'unsigned')
    assert.match(report.reason ?? '', /未签名|无法判断/)
    // 这一条是本文件的核心：unsigned 绝不能被当成 ok
    assert.notEqual(report.status, 'ok')
  } finally {
    env.cleanup()
  }
})

test('★ F17：基线文件损坏时抛错，而不是静默当"没装过"', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo')
    const { dir } = await installPlugin({ pluginsRoot: plugins, source: src })
    writeFileSync(join(dir, INTEGRITY_FILE), '{ not json', 'utf8')
    // 静默当"未签名"会把篡改伪装成"没留基线"，那正好给了攻击者一条降级路径
    assert.throws(() => verifyIntegrity(dir), /不是合法 JSON/)
  } finally {
    env.cleanup()
  }
})

test('★ F17：目标已存在时默认拒绝，且【原目录一字未动】、暂存区不留垃圾', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo')
    await installPlugin({ pluginsRoot: plugins, source: src })

    const target = join(plugins, 'demo')
    const before = readFileSync(join(target, 'package.json'), 'utf8')
    writeFileSync(join(target, 'mine.txt'), 'user edit', 'utf8')

    const src2 = makePlugin(join(env.root, 'src2'), 'demo', { 'other.txt': 'O' })
    await assert.rejects(() => installPlugin({ pluginsRoot: plugins, source: src2 }), /已存在[\s\S]*--force/)

    // 拒绝就真的是拒绝：用户对已装插件的改动必须还在
    assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), before)
    assert.equal(existsSync(join(target, 'mine.txt')), true)
    // 且不留 `.gw-install-*`：失败清理不干净会让 plugins/ 一路堆积看起来像坏插件的目录
    assert.deepEqual(readdirSync(plugins), ['demo'])
  } finally {
    env.cleanup()
  }
})

test('★ F17：--force 覆盖时原目录被【移到一边】而不是删掉', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo')
    await installPlugin({ pluginsRoot: plugins, source: src })
    writeFileSync(join(plugins, 'demo', 'mine.txt'), 'user edit', 'utf8')

    const src2 = makePlugin(join(env.root, 'src2'), 'demo', { 'other.txt': 'O' })
    await installPlugin({ pluginsRoot: plugins, source: src2, force: true })

    const aside = readdirSync(plugins).filter((n) => n.startsWith('demo.replaced-'))
    assert.equal(aside.length, 1, '必须留下被替换的那一份')
    assert.equal(readFileSync(join(plugins, aside[0]!, 'mine.txt'), 'utf8'), 'user edit')
    // 新装的那份里不该有被替换版本的文件
    assert.equal(existsSync(join(plugins, 'demo', 'other.txt')), true)
    assert.equal(existsSync(join(plugins, 'demo', 'mine.txt')), false)
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 压缩包来源 ------------------------------ */

test('★ F17：从压缩包安装；包内多一层顶层目录时也能定位插件根', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo')
    const tarball = join(env.root, 'demo.tgz')
    tar(['-czf', tarball, '-C', join(env.root, 'src'), 'demo'])

    const result = await installPlugin({ pluginsRoot: plugins, source: tarball })
    assert.equal(result.name, '@geewiki-plugin/demo')
    assert.equal(existsSync(join(result.dir, 'index.ts')), true, '应装到 plugins/demo/ 而不是 plugins/demo/demo/')
    assert.equal(verifyIntegrity(result.dir).status, 'ok')
    assert.deepEqual(readdirSync(plugins), ['demo'])
  } finally {
    env.cleanup()
  }
})

/** 构造一个含危险条目的压缩包（GNU tar 的 `-P` 会保留绝对路径与 `../`） */
function makeNastyTar(env: { root: string }, kind: 'absolute' | 'dotdot' | 'symlink'): string {
  const work = join(env.root, `nasty-${kind}`)
  mkdirSync(work, { recursive: true })
  const out = join(work, 'nasty.tgz')
  if (kind === 'symlink') {
    // 一个"看起来正常"的插件，但里面有一个指向 /etc/hostname 的链接
    const dir = makePlugin(work, 'demo')
    symlinkSync('/etc/hostname', join(dir, 'link-out'))
    tar(['-czf', out, '-C', work, 'demo'])
  } else {
    writeFileSync(join(work, 'outside.txt'), 'OUTSIDE', 'utf8')
    const entry = kind === 'absolute' ? join(work, 'outside.txt') : join('..', `nasty-${kind}`, 'outside.txt')
    tar(['-czf', out, '-P', '-C', work, entry])
  }
  return out
}

test('★ F17：压缩包含【绝对路径】条目时拒绝安装，且不创建目标目录', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const tarball = makeNastyTar(env, 'absolute')
    await assert.rejects(
      () => installPlugin({ pluginsRoot: plugins, source: tarball }),
      /越界条目|绝对路径|拒绝安装/,
    )
    assert.deepEqual(existsSync(plugins) ? readdirSync(plugins) : [], [], '失败不得留下任何目录')
  } finally {
    env.cleanup()
  }
})

test('★ F17：压缩包含【`..` 回溯】条目时拒绝安装', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const tarball = makeNastyTar(env, 'dotdot')
    await assert.rejects(() => installPlugin({ pluginsRoot: plugins, source: tarball }), /越界条目|拒绝安装/)
    assert.deepEqual(existsSync(plugins) ? readdirSync(plugins) : [], [])
  } finally {
    env.cleanup()
  }
})

test('★ F17：解包结果含【符号链接】时拒绝 —— 链接能让"目录内"指向目录外', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const tarball = makeNastyTar(env, 'symlink')
    await assert.rejects(
      () => installPlugin({ pluginsRoot: plugins, source: tarball }),
      /符号链接|拒绝安装/,
    )
    assert.deepEqual(existsSync(plugins) ? readdirSync(plugins) : [], [])
  } finally {
    env.cleanup()
  }
})

test('★ F17：压缩包缺少合法清单时拒绝，且不留半成品目录', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const dir = join(env.root, 'notaplugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'readme.txt'), 'no manifest here', 'utf8')
    const tarball = join(env.root, 'bad.tgz')
    tar(['-czf', tarball, '-C', env.root, 'notaplugin'])

    await assert.rejects(() => installPlugin({ pluginsRoot: plugins, source: tarball }), /清单|manifest/i)
    assert.deepEqual(existsSync(plugins) ? readdirSync(plugins) : [], [])
  } finally {
    env.cleanup()
  }
})

test('★ F17：dry-run 只规划不落盘，但暂存区必须能清干净', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    const src = makePlugin(join(env.root, 'src'), 'demo')
    const tarball = join(env.root, 'demo.tgz')
    tar(['-czf', tarball, '-C', join(env.root, 'src'), 'demo'])

    const { cleanupPlan } = await import('../src/plugin-install.js')
    const plan = await planInstall({ pluginsRoot: plugins, source: tarball })
    assert.equal(plan.wouldOverwrite, false)
    assert.equal(plan.entries.length > 0, true, '压缩包来源应报告条目')
    // 规划本身会建暂存区（并占用 `.gw-install-*`），所以 dry-run 结束必须清理
    assert.equal(readdirSync(plugins).some((n) => n.startsWith('.gw-install-')), true)
    cleanupPlan(plan)
    assert.deepEqual(readdirSync(plugins), [])

    void src
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 收集与批量 ------------------------------ */

test('★ F17：基线不纳入 node_modules / .git / 基线文件自身', async () => {
  const env = sandbox()
  try {
    const dir = makePlugin(join(env.root, 'src'), 'demo', {
      'node_modules/dep/index.js': 'module.exports = 1',
      '.git/config': '[core]',
    })
    const files = [...collectPluginFiles(dir).keys()].sort()
    assert.deepEqual(files, ['index.ts', 'package.json'])

    // 而且它们即使事后变化也不该被判成 drift（否则每次 npm i 都会让完整性报警）
    const plugins = join(env.root, 'plugins')
    const { dir: installed } = await installPlugin({ pluginsRoot: plugins, source: dir })
    writeFileSync(join(installed, 'node_modules/dep/index.js'), 'module.exports = 2', 'utf8')
    assert.equal(verifyIntegrity(installed).status, 'ok')
  } finally {
    env.cleanup()
  }
})

test('★ F17：verifyAllIntegrity 逐目录给出状态（含 unsigned 的区分）', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    await installPlugin({ pluginsRoot: plugins, source: makePlugin(join(env.root, 'src'), 'alpha') })
    // 手工造一个"装了但没基线"的
    mkdirSync(join(plugins, 'beta'), { recursive: true })
    writeFileSync(join(plugins, 'beta', 'index.ts'), 'x', 'utf8')

    const reports = verifyAllIntegrity(plugins)
    assert.deepEqual(
      reports.map((r) => [r.name ?? '(无)', r.status]),
      [
        ['@geewiki-plugin/alpha', 'ok'],
        ['(无)', 'unsigned'],
      ],
    )
    // 目录不存在时返回空数组而不是抛错（未启用外部插件是正常状态）
    assert.deepEqual(verifyAllIntegrity(join(env.root, 'nope')), [])
  } finally {
    env.cleanup()
  }
})

test('★ F17：非目录的 plugins 条目（例如误放的文件）不参与校验', async () => {
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    mkdirSync(plugins, { recursive: true })
    writeFileSync(join(plugins, 'stray.txt'), 'not a plugin', 'utf8')
    assert.deepEqual(verifyAllIntegrity(plugins), [])
    assert.equal(statSync(plugins).isDirectory(), true)
  } finally {
    env.cleanup()
  }
})

/* ------------------- 管理器侧：完整性体检方法 ------------------- */

test('★ F17：未配置插件目录时【明确说"未配置"】，而不是猜一个目录报"没有插件"', async () => {
  const { Context } = await import('cordis')
  const { GeeWikiManager } = await import('../src/index.js')
  const env = sandbox()
  try {
    const manager = new GeeWikiManager(new Context(), {
      registry: [],
      baseFile: join(env.root, 'plugins.base.json'),
      sessionFile: join(env.root, 'plugins.session.json'),
    })
    const r = manager.verifyPluginIntegrity()
    assert.equal(r.pluginsDir, null)
    assert.deepEqual(r.reports, [])
    // "没有插件"与"看错地方了"是两种完全不同的情况，必须在返回里能分辨
    assert.match(r.note ?? '', /未配置/)
  } finally {
    env.cleanup()
  }
})

test('★ F17：配置了插件目录时逐插件给出完整性状态', async () => {
  const { Context } = await import('cordis')
  const { GeeWikiManager } = await import('../src/index.js')
  const env = sandbox()
  try {
    const plugins = join(env.root, 'plugins')
    await installPlugin({ pluginsRoot: plugins, source: makePlugin(join(env.root, 'src'), 'alpha') })
    mkdirSync(join(plugins, 'beta'), { recursive: true })
    writeFileSync(join(plugins, 'beta', 'index.ts'), 'x', 'utf8')

    const manager = new GeeWikiManager(new Context(), {
      registry: [],
      baseFile: join(env.root, 'plugins.base.json'),
      sessionFile: join(env.root, 'plugins.session.json'),
      pluginsDir: plugins,
    })
    const r = manager.verifyPluginIntegrity()
    assert.equal(r.pluginsDir, plugins)
    assert.deepEqual(
      r.reports.map((x) => x.status),
      ['ok', 'unsigned'],
    )
  } finally {
    env.cleanup()
  }
})
