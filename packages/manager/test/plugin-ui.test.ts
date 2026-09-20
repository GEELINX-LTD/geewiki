/**
 * 插件 UI 入口表的纯函数单元测试（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/manager test
 *
 * 覆盖：双资产根优先级与命中判定、`client` 声明的解析与非法名剔除、入口表的
 * 四态（active/no_client/entry_missing/invalid_name）、revision 的稳定性与敏感性、
 * 插件名与路径段的边界（含 scope 两段名、编码名、穿越尝试）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GeeWikiManifest } from '@geewiki/core'
import {
  buildPluginUiTable,
  isPluginUiName,
  pluginUiEntryOf,
  pluginUiNameFromSegments,
  pluginUiRootsFor,
  resolvePluginUiHit,
  resolvePluginUiRoots,
  type UiStatFile,
} from '../src/plugin-ui.js'
import type { RegisteredPlugin } from '../src/deps.js'
import type { ExtNodeAssignment } from '../src/slots.js'

/* ------------------------------ 夹具 ------------------------------ */

function manifestOf(name: string, client?: { entry?: string; css?: string }): GeeWikiManifest {
  return {
    name,
    version: '1.0.0',
    geewiki: {
      runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
      ...(client === undefined ? {} : { client }),
    },
  }
}

function pluginOf(name: string, opts: { dir?: string; client?: { entry?: string; css?: string } } = {}): RegisteredPlugin {
  return {
    name,
    manifest: manifestOf(name, opts.client),
    module: { name, apply: () => undefined },
    ...(opts.dir === undefined ? {} : { dir: opts.dir, source: 'external' as const }),
  }
}

/** 假目录判定：纯函数测试里路径是虚构的，目录一律视为存在（真实场景由 existsSync 兜底） */
const anyDirExists = (): boolean => true

/** 假 stat：只认 map 里登记过的路径（值为 `[mtimeMs, size]`） */
function fakeStat(files: Record<string, [number, number]>): UiStatFile {
  return (path) => {
    const hit = files[path]
    return hit ? { mtimeMs: hit[0], size: hit[1] } : undefined
  }
}

/** 真实临时目录夹具：用于验证 existsSync 驱动的候选根过滤 */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ui-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/* ---------------------- client 声明解析 ---------------------- */

test('pluginUiEntryOf：未声明 client → undefined；client:{} → 缺省 client.js', () => {
  assert.equal(pluginUiEntryOf(manifestOf('@t/a')), undefined, '未声明应为 undefined')
  assert.equal(pluginUiEntryOf(undefined), undefined, 'manifest 缺失应为 undefined')
  assert.deepEqual(pluginUiEntryOf(manifestOf('@t/a', {})), { entry: 'client.js' }, '空对象应取缺省入口')
  assert.deepEqual(pluginUiEntryOf(manifestOf('@t/a', { entry: 'ui.js' })), { entry: 'ui.js' })
  assert.deepEqual(
    pluginUiEntryOf(manifestOf('@t/a', { entry: 'client.js', css: 'client.css' })),
    { entry: 'client.js', css: 'client.css' },
    '声明样式时应一并返回',
  )
})

test('pluginUiEntryOf：路径不合法（隐藏/空白/穿越/空段）整体视为未声明', () => {
  /*
   * ★ F13：`'a/b.js'` **已从本列表移除** —— 分层路径现在是合法的入口形态
   * （原先"必须单段"是纯限制，没有安全理由；静态层早就支持子目录）。
   * 放宽的是限制，防护清单原样保留：隐藏名、空白、反斜杠、上跳、空段。
   */
  for (const bad of ['../evil.js', '.env', 'x y.js', '', 'a\\b.js', 'a//b.js', '/abs.js', 'a/../b.js']) {
    assert.equal(
      pluginUiEntryOf(manifestOf('@t/a', { entry: bad })),
      undefined,
      `入口路径 ${JSON.stringify(bad)} 应被剔除`,
    )
  }
  // 样式非法同样整体剔除（宁可当作没有 UI，也不下发半截声明）
  assert.equal(pluginUiEntryOf(manifestOf('@t/a', { entry: 'client.js', css: '../x.css' })), undefined)
  // 合法边界：以字母/数字开头，其后允许 . _ -
  assert.deepEqual(pluginUiEntryOf(manifestOf('@t/a', { entry: 'client-a1_b2.js' })), { entry: 'client-a1_b2.js' })
  // ★ F13：分层入口与分层样式都合法，且**原样**保留（前端要按这个路径去取）
  assert.deepEqual(pluginUiEntryOf(manifestOf('@t/a', { entry: 'ui/index.js', css: 'styles/a.css' })), {
    entry: 'ui/index.js',
    css: 'styles/a.css',
  })
})

/* ---------------------- 插件名与路径段 ---------------------- */

test('isPluginUiName：单段与 2 段 scope 合法，多段/穿越/空白/空串非法', () => {
  for (const good of ['wiki', '@geewiki/wiki', 'hello-geewiki', '@geewiki-plugin/hello', 'a.b', 'x1']) {
    assert.equal(isPluginUiName(good), true, `${good} 应合法`)
  }
  for (const bad of ['a/b/c', '../x', 'a/..', '@scope', '@/x', 'a b', '', 'a\tb', 'a\u0000b', '/x', 'x/']) {
    assert.equal(isPluginUiName(bad), false, `${JSON.stringify(bad)} 应非法`)
  }
})

test('pluginUiNameFromSegments：1 段 / 2 段 scope 还原，其余拒绝（编码名一律不认）', () => {
  assert.equal(pluginUiNameFromSegments(['wiki']), 'wiki')
  assert.equal(pluginUiNameFromSegments(['@geewiki', 'wiki']), '@geewiki/wiki')
  assert.equal(pluginUiNameFromSegments(['@geewiki-plugin', 'hello']), '@geewiki-plugin/hello')
  // 多段 / 空段 / 首段非 scope
  assert.equal(pluginUiNameFromSegments(['a', 'b', 'c']), undefined)
  assert.equal(pluginUiNameFromSegments([]), undefined)
  assert.equal(pluginUiNameFromSegments(['wiki', 'x']), undefined, '首段无 @ 的 2 段不是合法插件名')
  assert.equal(pluginUiNameFromSegments(['@geewiki', 'wiki', 'client.js']), undefined, '3 段不是插件名')
  // 编码名（%40geewiki/wiki）解码前是单段 '%40geewiki'，不匹配任何表项
  assert.equal(pluginUiNameFromSegments(['%40geewiki', 'wiki']), undefined)
})

/* ---------------------- 候选根与命中 ---------------------- */

test('resolvePluginUiRoots：只返回存在的目录，顺序 = 优先级（插件自带 dist 在前）', () => {
  const tmp = makeTmpDir()
  try {
    const pluginDir = join(tmp.dir, 'plugins', 'ext')
    const webDist = join(tmp.dir, 'web')
    mkdirSync(join(pluginDir, 'dist'), { recursive: true })
    mkdirSync(join(webDist, 'plugins-ui', '@t/ext'), { recursive: true })
    assert.deepEqual(
      resolvePluginUiRoots('@t/ext', pluginDir, webDist),
      [join(pluginDir, 'dist'), join(webDist, 'plugins-ui', '@t/ext')],
      '两个根都存在时应按优先级全部返回',
    )
    // 目录不存在则不出现
    assert.deepEqual(resolvePluginUiRoots('@t/ext', join(tmp.dir, 'nope'), webDist), [
      join(webDist, 'plugins-ui', '@t/ext'),
    ])
    assert.deepEqual(resolvePluginUiRoots('@t/ext', undefined, undefined), [], '无任何根时应为空')
  } finally {
    tmp.cleanup()
  }
})

test('resolvePluginUiHit：优先插件自带产物；缺失则回落 webDist；都没有 → undefined', () => {
  const pluginDir = '/plugins/ext'
  const webDist = '/web'
  const declared = { entry: 'client.js', css: 'client.css' }
  // ① 自带产物命中：rev 由该根的文件决定
  const both = fakeStat({
    [`${pluginDir}/dist/client.js`]: [1000, 10],
    [`${pluginDir}/dist/client.css`]: [1000, 20],
    [`${webDist}/plugins-ui/@t/ext/client.js`]: [2000, 30],
    [`${webDist}/plugins-ui/@t/ext/client.css`]: [2000, 40],
  })
  const hitBoth = resolvePluginUiHit('@t/ext', pluginDir, webDist, declared, both, anyDirExists)
  assert.equal(hitBoth?.root, `${pluginDir}/dist`, '第一候选根命中时不得回落')
  assert.equal(hitBoth?.entryStat.size, 10)
  // ② 自带产物入口缺失 → 回落 webDist
  const onlyWeb = fakeStat({
    [`${webDist}/plugins-ui/@t/ext/client.js`]: [2000, 30],
    [`${webDist}/plugins-ui/@t/ext/client.css`]: [2000, 40],
  })
  assert.equal(
    resolvePluginUiHit('@t/ext', pluginDir, webDist, declared, onlyWeb, anyDirExists)?.root,
    `${webDist}/plugins-ui/@t/ext`,
  )
  // ③ 都没有 → undefined（调用方记 entry_missing）
  assert.equal(resolvePluginUiHit('@t/ext', pluginDir, webDist, declared, fakeStat({}), anyDirExists), undefined)
  // ④ 样式的存在性不参与命中判定（入口在即算就绪，只是不注入样式）
  const noCss = fakeStat({ [`${pluginDir}/dist/client.js`]: [1000, 10] })
  const hitNoCss = resolvePluginUiHit('@t/ext', pluginDir, webDist, declared, noCss, anyDirExists)
  assert.equal(hitNoCss?.root, `${pluginDir}/dist`)
  assert.equal(hitNoCss?.cssStat, undefined, '样式缺失时不应带 cssStat')
})

test('resolvePluginUiRoots/pluginUiHit：真实文件系统下 existsSync 过滤与命中一致', () => {
  const tmp = makeTmpDir()
  try {
    const pluginDir = join(tmp.dir, 'p')
    const webDist = join(tmp.dir, 'w')
    mkdirSync(join(pluginDir, 'dist'), { recursive: true })
    writeFileSync(join(pluginDir, 'dist', 'client.js'), 'export const register = () => {}\n', 'utf8')
    const hit = resolvePluginUiHit('@t/a', pluginDir, webDist, { entry: 'client.js' })
    assert.equal(hit?.root, join(pluginDir, 'dist'))
    assert.ok((hit?.entryStat.size ?? 0) > 0, '真实 stat 应报出非零大小')
  } finally {
    tmp.cleanup()
  }
})

/* ---------------------- 入口表 ---------------------- */

test('buildPluginUiTable：只列 active + 有 client + 入口存在；其余进 skipped（四态互斥）', () => {
  const stat = fakeStat({ '/p/ok/dist/client.js': [1, 2], '/p/ok/dist/client.css': [1, 3] })
  const registry = [
    pluginOf('@t/ok', { dir: '/p/ok', client: { entry: 'client.js', css: 'client.css' } }), // 入表
    pluginOf('@t/off', { dir: '/p/off', client: {} }), // inactive（未在 activeNames）
    pluginOf('@t/noui'), // no_client
    pluginOf('@t/missing', { dir: '/p/missing', client: {} }), // entry_missing
    pluginOf('bad/name/x', { dir: '/p/bad', client: {} }), // invalid_name
  ]
  const table = buildPluginUiTable({
    registry,
    activeNames: new Set(['@t/ok', '@t/noui', '@t/missing', 'bad/name/x']),
    webDist: null,
    statFile: stat,
    dirExists: anyDirExists,
  })
  assert.equal(table.version, 1)
  assert.deepEqual(Object.keys(table.plugins), ['@t/ok'], '只有满足三条件的插件才进表')
  assert.deepEqual(table.plugins['@t/ok'], { entry: 'client.js', css: 'client.css', rev: table.plugins['@t/ok']?.rev })
  assert.deepEqual(table.skipped, [
    { name: '@t/missing', reason: 'entry_missing' },
    { name: '@t/noui', reason: 'no_client' },
    { name: '@t/off', reason: 'inactive' },
    { name: 'bad/name/x', reason: 'invalid_name' },
  ])
})

test('buildPluginUiTable：entry_missing 不进 plugins 但在 skipped（产物缺失的唯一可见出口）', () => {
  const table = buildPluginUiTable({
    registry: [pluginOf('@t/a', { dir: '/p/a', client: {} })],
    activeNames: new Set(['@t/a']),
    webDist: '/web',
    statFile: fakeStat({}),
  })
  assert.deepEqual(table.plugins, {})
  assert.deepEqual(table.skipped, [{ name: '@t/a', reason: 'entry_missing' }])
})

test('buildPluginUiTable：空表仍返回 200 语义的形状（version/revision 齐备）', () => {
  const table = buildPluginUiTable({ registry: [], activeNames: new Set(), webDist: null, statFile: fakeStat({}), dirExists: anyDirExists })
  assert.equal(table.version, 1)
  assert.deepEqual(table.plugins, {})
  assert.deepEqual(table.skipped, [])
  assert.match(table.revision, /^[0-9a-f]{12}$/)
})

test('buildPluginUiTable：revision 只随表格内容变化（注册表顺序无关、skipped 无关）', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2], '/p/b/dist/client.js': [3, 4] })
  const a = pluginOf('@t/a', { dir: '/p/a', client: {} })
  const b = pluginOf('@t/b', { dir: '/p/b', client: {} })
  const noisy = pluginOf('@t/noisy', { dir: '/p/noisy', client: {} }) // entry_missing → skipped
  const base = buildPluginUiTable({
    registry: [a, b],
    activeNames: new Set(['@t/a', '@t/b']),
    webDist: null,
    statFile: stat,
    dirExists: anyDirExists,
  })
  const reordered = buildPluginUiTable({
    registry: [b, a],
    activeNames: new Set(['@t/b', '@t/a']),
    webDist: null,
    statFile: stat,
    dirExists: anyDirExists,
  })
  assert.equal(base.revision, reordered.revision, '注册表顺序变化不应改变 revision')
  const withSkipped = buildPluginUiTable({
    registry: [a, b, noisy],
    activeNames: new Set(['@t/a', '@t/b', '@t/noisy']),
    webDist: null,
    statFile: stat,
    dirExists: anyDirExists,
  })
  assert.equal(withSkipped.revision, base.revision, 'skipped 不参与 revision')
  // 激活集合变化 → revision 变化
  const fewer = buildPluginUiTable({
    registry: [a, b],
    activeNames: new Set(['@t/a']),
    webDist: null,
    statFile: stat,
    dirExists: anyDirExists,
  })
  assert.notEqual(fewer.revision, base.revision, '集合变化必须改变 revision')
  // 产物变化（size/mtime）→ revision 变化
  const changed = buildPluginUiTable({
    registry: [a, b],
    activeNames: new Set(['@t/a', '@t/b']),
    webDist: null,
    statFile: fakeStat({ '/p/a/dist/client.js': [1, 999], '/p/b/dist/client.js': [3, 4] }),
    dirExists: anyDirExists,
  })
  assert.notEqual(changed.revision, base.revision, '产物指纹变化必须改变 revision')
})

test('buildPluginUiTable：rev 由入口（与样式）的 mtime-大小决定，样式参与指纹', () => {
  const entry = { '/p/a/dist/client.js': [1000, 10] as [number, number] }
  const withCss = { ...entry, '/p/a/dist/client.css': [1000, 20] as [number, number] }
  const noCssPlugin = pluginOf('@t/a', { dir: '/p/a', client: {} })
  const cssPlugin = pluginOf('@t/a', { dir: '/p/a', client: { entry: 'client.js', css: 'client.css' } })
  const revNoCss = buildPluginUiTable({
    registry: [noCssPlugin],
    activeNames: new Set(['@t/a']),
    webDist: null,
    statFile: fakeStat(entry),
    dirExists: anyDirExists,
  }).plugins['@t/a']?.rev
  const revCss = buildPluginUiTable({
    registry: [cssPlugin],
    activeNames: new Set(['@t/a']),
    webDist: null,
    statFile: fakeStat(withCss),
    dirExists: anyDirExists,
  }).plugins['@t/a']?.rev
  assert.match(revNoCss ?? '', /^[0-9a-f]{8}$/)
  assert.match(revCss ?? '', /^[0-9a-f]{8}$/)
  assert.notEqual(revNoCss, revCss, '声明样式后指纹应不同（样式也参与 rev）')
})

/* ---------------------- 静态层根表 ---------------------- */

test('pluginUiRootsFor：给出命中根；未声明 client / 入口缺失 / 名非法的插件不出现', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2], '/w/plugins-ui/@t/b/client.js': [3, 4] })
  const registry = [
    pluginOf('@t/a', { dir: '/p/a', client: {} }),
    pluginOf('@t/b', { client: {} }), // 只有 webDist 根
    pluginOf('@t/c', { dir: '/p/c', client: {} }), // 入口缺失
    pluginOf('@t/d'), // 未声明 client
    pluginOf('bad/name/x', { dir: '/p/x', client: {} }), // 名非法
  ]
  const roots = pluginUiRootsFor(registry, '/w', stat, anyDirExists)
  assert.deepEqual(roots, { '@t/a': '/p/a/dist', '@t/b': '/w/plugins-ui/@t/b' })
})

test('pluginUiRootsFor：不按激活过滤（在途 import 需结算，与入口表的过滤口径刻意不同）', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2] })
  // 该插件当前未激活，但它刚被停用，可能仍有在途 import → 静态层仍须能取到文件（缓存/结算）
  const roots = pluginUiRootsFor([pluginOf('@t/a', { dir: '/p/a', client: {} })], null, stat, anyDirExists)
  assert.deepEqual(roots, { '@t/a': '/p/a/dist' }, '根表不接收 activeNames，不做激活过滤')
})

/* ---------------------- 与静态层共用的不变式 ---------------------- */

test('不变式：入口表命中的根 === 静态层根表里该插件的根（同一函数判定，不得各算一遍）', () => {
  const stat = fakeStat({
    '/p/a/dist/client.js': [1, 2],
    '/w/plugins-ui/@t/a/client.js': [9, 9], // 两处都有 → 必须以插件自带产物为准
  })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} })]
  const table = buildPluginUiTable({
    registry,
    activeNames: new Set(['@t/a']),
    webDist: '/w',
    statFile: stat,
    dirExists: anyDirExists,
  })
  const roots = pluginUiRootsFor(registry, '/w', stat, anyDirExists)
  assert.equal(roots['@t/a'], '/p/a/dist')
  const hit = resolvePluginUiHit('@t/a', '/p/a', '/w', { entry: 'client.js' }, stat, anyDirExists)
  assert.equal(hit?.root, roots['@t/a'], '静态层与入口表必须得到同一个根')
  assert.equal(table.plugins['@t/a']?.entry, 'client.js')
})

/* ---------------------- 插槽字段（slots / slotConflicts） ---------------------- */

test('slots：无贡献时整个键被省略 —— 保证既有部署的 revision 逐字节不变', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2] })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} })]
  const base = { registry, activeNames: new Set(['@t/a']), webDist: '/w', statFile: stat, dirExists: anyDirExists }

  const withoutSlots = buildPluginUiTable(base)
  // 显式传入"空裁决结果"，必须与完全不传得到**完全相同**的表（含 revision）
  const withEmptyAssignments = buildPluginUiTable({ ...base, slotAssignments: [] })

  assert.equal('slots' in (withoutSlots.plugins['@t/a'] as object), false, '无贡献时不应出现 slots 键')
  assert.equal(withoutSlots.revision, withEmptyAssignments.revision, '空裁决结果不得改变 revision')
})

test('slots：贡献者的 slots 字段计入 revision（否则 304 会隐藏"编辑器换人"）', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2], '/p/b/dist/client.js': [1, 2] })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} }), pluginOf('@t/b', { dir: '/p/b', client: {} })]
  const base = {
    registry,
    activeNames: new Set(['@t/a', '@t/b']),
    webDist: '/w',
    statFile: stat,
    dirExists: anyDirExists,
  }

  // 场景一：只有 a 声明 editor
  const onlyA = buildPluginUiTable({
    ...base,
    slotAssignments: [{ slot: 'editor', cardinality: 'single', owners: ['@t/a'], effective: ['@t/a'], suppressed: [] }],
  })
  // 场景二：a 被停用（不再有贡献），editor 归 b
  const onlyB = buildPluginUiTable({
    ...base,
    slotAssignments: [{ slot: 'editor', cardinality: 'single', owners: ['@t/b'], effective: ['@t/b'], suppressed: [] }],
  })

  assert.deepEqual(onlyA.plugins['@t/a']?.slots, ['editor'])
  assert.equal(onlyA.plugins['@t/b']?.slots, undefined, '未生效者不应带 slots')
  assert.deepEqual(onlyB.plugins['@t/b']?.slots, ['editor'])
  assert.notEqual(
    onlyA.revision,
    onlyB.revision,
    '插槽归属变化必须改变 revision，否则前端 If-None-Match 会拿到 304 而静默沿用旧编辑器',
  )
})

test('extNodes：非插槽节点的生效贡献下发；**不含插槽**（与 slots 互不重叠）且计入 revision', () => {
  /*
   * 前端拿 `slots ∪ extNodes` 做越权闸门（P12）。这里钉三件事：
   * ① 缺省/空裁决 ⇒ 键不出现、revision 与改动前逐字节相同（既有部署不被平白触发全量重取）；
   * ② 生效的非插槽节点出现在 `extNodes`，**插槽不重复出现在这里**（同一事实两份表示必然漂移）；
   * ③ 归属变化必须改变 revision——否则 304 会隐藏"谁接管了这个节点"。
   */
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2], '/p/b/dist/client.js': [1, 2] })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} }), pluginOf('@t/b', { dir: '/p/b', client: {} })]
  const base = {
    registry,
    activeNames: new Set(['@t/a', '@t/b']),
    webDist: '/w',
    statFile: stat,
    dirExists: anyDirExists,
  }
  const extNode = (node: string, owner: string): ExtNodeAssignment => ({
    node,
    kind: 'ui',
    cardinality: 'single',
    modes: ['extend', 'wrap', 'replace'],
    propsVersion: 1,
    owners: [owner],
    effective: [{ owner, mode: 'replace', via: 'manifest', lazy: false }],
    suppressed: [],
    byMode: { replace: owner, extend: [] },
    suppressedDetail: [],
  })

  const none = buildPluginUiTable(base)
  assert.equal('extNodes' in (none.plugins['@t/a'] as object), false, '无贡献时不应出现 extNodes 键')
  assert.equal(
    none.revision,
    buildPluginUiTable({ ...base, extAssignments: [] }).revision,
    '空裁决结果不得改变 revision',
  )

  const withExt = buildPluginUiTable({
    ...base,
    // 同一次裁决里既有插槽（kind slot）又有非插槽节点：只有后者进 extNodes
    slotAssignments: [{ slot: 'app-header', cardinality: 'multi', owners: ['@t/a'], effective: ['@t/a'], suppressed: [] }],
    extAssignments: [
      extNode('ui-button', '@t/a'),
      { ...extNode('app-header', '@t/a'), kind: 'slot' },
      { ...extNode('ui-card', '@t/b'), kind: 'slot' },
    ],
  })
  assert.deepEqual(withExt.plugins['@t/a']?.extNodes, ['ui-button'], 'kind=slot 的裁决不得混进 extNodes')
  assert.deepEqual(withExt.plugins['@t/a']?.slots, ['app-header'], '插槽仍由 slots 字段承担')
  assert.equal(withExt.plugins['@t/b']?.extNodes, undefined, '未被列出的 owner 不应带 extNodes')
  assert.notEqual(
    withExt.revision,
    none.revision,
    '扩展节点归属变化必须改变 revision，否则 304 会让前端沿用旧的越权判据',
  )
})

test('slotConflicts：只在真有多方声明时出现，且**不计入** revision（诊断信息不触发重取）', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2], '/p/b/dist/client.js': [1, 2] })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} }), pluginOf('@t/b', { dir: '/p/b', client: {} })]
  const base = {
    registry,
    activeNames: new Set(['@t/a', '@t/b']),
    webDist: '/w',
    statFile: stat,
    dirExists: anyDirExists,
  }

  const noConflict = buildPluginUiTable({
    ...base,
    slotAssignments: [{ slot: 'app-header', cardinality: 'multi', owners: ['@t/a', '@t/b'], effective: ['@t/a', '@t/b'], suppressed: [] }],
  })
  assert.equal('slotConflicts' in noConflict, false, 'multi 插槽多人贡献不是冲突')

  const conflicted = buildPluginUiTable({
    ...base,
    slotAssignments: [{ slot: 'editor', cardinality: 'single', owners: ['@t/a', '@t/b'], effective: ['@t/a'], suppressed: ['@t/b'] }],
  })
  assert.deepEqual(conflicted.slotConflicts, [
    { slot: 'editor', winner: '@t/a', suppressed: ['@t/b'], owners: ['@t/a', '@t/b'] },
  ])
  // 冲突是诊断信息：与"该加载什么"无关，故刻意不计入 revision
  const sameWithoutConflictFlag = buildPluginUiTable({
    ...base,
    slotAssignments: [{ slot: 'editor', cardinality: 'single', owners: ['@t/a'], effective: ['@t/a'], suppressed: [] }],
  })
  assert.equal(
    conflicted.revision,
    sameWithoutConflictFlag.revision,
    'slotConflicts 不应计入 revision（否则仅多一条告警也会触发前端重取 bundle）',
  )
})

/* ---------------------- F2：路由字段（routes） ---------------------- */

test('routes：无声明时整个键被省略 —— 保证既有部署的 revision 逐字节不变', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2] })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} })]
  const base = { registry, activeNames: new Set(['@t/a']), webDist: '/w', statFile: stat, dirExists: anyDirExists }

  const withoutRoutes = buildPluginUiTable(base)
  const withEmptyMap = buildPluginUiTable({ ...base, routesByOwner: new Map() })

  assert.equal('routes' in (withoutRoutes.plugins['@t/a'] as object), false, '无声明时不应出现 routes 键')
  assert.equal(withoutRoutes.revision, withEmptyMap.revision, '空路由表不得改变 revision')
})

test('routes：声明者的 routes 计入 revision（否则 304 会隐藏"插件多了一个页面"）', () => {
  const stat = fakeStat({ '/p/a/dist/client.js': [1, 2] })
  const registry = [pluginOf('@t/a', { dir: '/p/a', client: {} })]
  const base = { registry, activeNames: new Set(['@t/a']), webDist: '/w', statFile: stat, dirExists: anyDirExists }

  const before = buildPluginUiTable(base)
  const after = buildPluginUiTable({
    ...base,
    routesByOwner: new Map([['@t/a', [{ id: 'board', label: '看板', group: 'main' as const }]]]),
  })

  assert.deepEqual(after.plugins['@t/a']?.routes?.map((r) => r.id), ['board'])
  assert.notEqual(before.revision, after.revision, '新增页面必须改变 revision，否则前端会一直拿 304')

  // 只改 nav 元信息（id 不变）同样必须计入：导航标签变了而 revision 不变 ⇒ 界面永远显示旧标签
  const relabeled = buildPluginUiTable({
    ...base,
    routesByOwner: new Map([['@t/a', [{ id: 'board', label: '数据看板', group: 'main' as const }]]]),
  })
  assert.notEqual(after.revision, relabeled.revision, '导航元信息变化同样要计入 revision')
})
