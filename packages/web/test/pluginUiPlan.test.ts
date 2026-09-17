/**
 * 插件 UI 入口表纯函数单测（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/web test
 *
 * 被测模块 `packages/web/src/lib/pluginUiPlan.ts` 刻意不接触 DOM/window，
 * 因此这里可以在 node 下直接 import（`pluginUi.ts` 顶层会写 `window.__GEEWIKI_PLUGIN_UI__`，无法单测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_UI_FILE_SEGMENT,
  PLUGIN_UI_PREFIX,
  PLUGIN_UI_TABLE_PATH,
  UI_SKIP_HELP,
  UI_SKIP_LABEL,
  UI_SKIP_REASONS,
  classifyUiSkips,
  SLOT_TABLE_PATH,
  isLazyOnlyEntry,
  isPluginUiName,
  isUiSettled,
  parseSuppressedOwners,
  parseUiTable,
  planUiSync,
  pluginUiBase,
  type UiTableEntry,
} from '../src/lib/pluginUiPlan'
import {
  PLUGIN_UI_PREFIX as CORE_PLUGIN_UI_PREFIX,
  PLUGIN_UI_FILE_SEGMENT as CORE_PLUGIN_UI_FILE_SEGMENT,
  isPluginUiEntryPath,
} from '@geewiki/core/domain'

const ORIGIN = 'http://127.0.0.1:3000'

/** 构造一份合法响应体 */
function table(plugins: Record<string, unknown>, revision = 'rev-table'): unknown {
  return { ok: true, version: 1, revision, plugins, skipped: [] }
}

const WIKI: UiTableEntry = { entry: 'client.js', css: 'client.css', rev: 'aaa111' }

/* ------------------------- 常量与跨包不变式 ------------------------- */

test('常量：入口表端点与 UI 前缀与后端契约一致', () => {
  assert.equal(PLUGIN_UI_TABLE_PATH, '/api/plugins/ui')
  assert.equal(PLUGIN_UI_PREFIX, '/plugins-ui')
  /*
   * ★ F13：这里从"两边各一份、用同一张输入表钉住内容一致"改成了**引用同一性**。
   * 副本无法伪装成同一个对象；而"内容相等"在有人刚抄完一份时是通过的，
   * 只在漂移发生之后才红 —— 那正是插槽镜像当初失守的方式。
   */
  assert.equal(PLUGIN_UI_PREFIX, CORE_PLUGIN_UI_PREFIX)
  assert.equal(PLUGIN_UI_FILE_SEGMENT, CORE_PLUGIN_UI_FILE_SEGMENT)
  // 单段规则本身没有放宽（入口路径的放宽走独立的 isPluginUiEntryPath）
  for (const ok of ['client.js', 'client.css', 'a', 'A1', 'x_y-z.9']) {
    assert.ok(PLUGIN_UI_FILE_SEGMENT.test(ok), `应接受：${ok}`)
  }
  for (const bad of ['', 'a/b', '../x', '.hidden', '-lead', 'a b', 'a\\b']) {
    assert.ok(!PLUGIN_UI_FILE_SEGMENT.test(bad), `应拒绝：${bad}`)
  }
})

/* ------------------------- isPluginUiName ------------------------- */

test('isPluginUiName：1 段非 scope 名与 2 段 scope 名合法，其余非法', () => {
  for (const ok of ['wiki', '@geewiki/wiki', '@geewiki-plugin/hello', 'a1', 'x_y.z']) {
    assert.equal(isPluginUiName(ok), true, `应接受：${ok}`)
  }
  for (const bad of [
    '', // 空
    'a/b/c', // 3 段
    '../x', // 穿越
    'a b', // 空白
    '@scope', // 只有 scope 没有名字
    'wiki/x', // 2 段但首段非 scope
    '/wiki', // 前导斜杠（空首段）
    'wiki/', // 尾随斜杠（空末段）
    'a\\b', // 反斜杠
    '..',
    '.',
  ]) {
    assert.equal(isPluginUiName(bad), false, `应拒绝：${bad}`)
  }
})

/* ------------------------- pluginUiBase ------------------------- */

test('pluginUiBase：返回同源绝对 URL、插件名不编码', () => {
  assert.equal(pluginUiBase('wiki', ORIGIN), `${ORIGIN}/plugins-ui/wiki`)
  // scope 名原样保留两段 + @，绝不做 encodeURIComponent（编码名在 dev 会落 SPA fallback、prod 必 404）
  assert.equal(pluginUiBase('@geewiki/wiki', ORIGIN), `${ORIGIN}/plugins-ui/@geewiki/wiki`)
  assert.ok(!pluginUiBase('@geewiki/wiki', ORIGIN)?.includes('%40'))
  // 必须是绝对 URL：相对/根路径形式的动态 import 会被 Vite 注入 ?import（见模块头注释）
  assert.ok(pluginUiBase('wiki', ORIGIN)?.startsWith('http'))
})

test('pluginUiBase：非法插件名返回 undefined（不抛错）', () => {
  for (const bad of ['', 'a/b/c', '../etc', 'a b', '@scope', 'wiki/x']) {
    assert.equal(pluginUiBase(bad, ORIGIN), undefined, `应拒绝：${bad}`)
  }
})

/* ------------------------- parseUiTable ------------------------- */

test('parseUiTable：合法响应解析出 revision 与条目', () => {
  const parsed = parseUiTable(table({ '@geewiki/wiki': { entry: 'client.js', css: 'client.css', rev: 'aaa111' } }, 'rev-1'))
  assert.ok(parsed)
  assert.equal(parsed.revision, 'rev-1')
  assert.deepEqual(parsed.entries, { '@geewiki/wiki': { entry: 'client.js', css: 'client.css', rev: 'aaa111' } })
})

test('parseUiTable：css 可缺省', () => {
  const parsed = parseUiTable(table({ wiki: { entry: 'client.js', rev: 'r' } }))
  assert.deepEqual(parsed?.entries['wiki'], { entry: 'client.js', rev: 'r' })
})

test('parseUiTable：整体不可信时返回 undefined（调用方据此既不加载也不卸载）', () => {
  const bad: unknown[] = [
    null,
    undefined,
    'nope',
    42,
    [], // 数组
    { ok: true, version: 2, revision: 'r', plugins: {} }, // 版本不认识
    { ok: true, version: 1, plugins: {} }, // 缺 revision
    { ok: true, version: 1, revision: 7, plugins: {} }, // revision 非字符串
    { ok: true, version: 1, revision: 'r' }, // 缺 plugins
    { ok: true, version: 1, revision: 'r', plugins: [] }, // plugins 非对象
    { ok: true, version: 1, revision: 'r', plugins: null },
  ]
  for (const payload of bad) {
    assert.equal(parseUiTable(payload), undefined, `应判为不可信：${JSON.stringify(payload)}`)
  }
})

test('parseUiTable：空表是合法响应（200 + plugins:{}），不是错误', () => {
  const parsed = parseUiTable(table({}))
  assert.ok(parsed, '空表必须可解析——宿主据此卸载全部插件 UI')
  assert.deepEqual(parsed.entries, {})
})

test('parseUiTable：单条非法只跳过该条，不影响其它插件', () => {
  const parsed = parseUiTable(
    table({
      '@geewiki/wiki': { entry: 'client.js', rev: 'ok' },
      'bad name': { entry: 'client.js', rev: 'r' }, // 名字非法
      '../evil': { entry: 'client.js', rev: 'r' }, // 名字穿越
      'no-entry': { rev: 'r' }, // 缺 entry
      'entry-traversal': { entry: '../x.js', rev: 'r' }, // 入口文件名非法
      'css-traversal': { entry: 'client.js', css: '../../x.css', rev: 'r' }, // 样式名非法
      'no-rev': { entry: 'client.js' }, // 缺 rev
      'null-entry': null,
    }),
  )
  assert.ok(parsed)
  assert.deepEqual(Object.keys(parsed.entries), ['@geewiki/wiki'], '只有合法条目应保留')
})

/* ------------------------- planUiSync ------------------------- */

test('planUiSync：表中新增一项 → 只 load', () => {
  const plan = planUiSync({ '@geewiki/wiki': WIKI }, new Map())
  assert.deepEqual(plan, { load: ['@geewiki/wiki'], unload: [] })
})

test('planUiSync：表中少一项 → 只 unload（停用插件后 UI 消失的服务端半边）', () => {
  const plan = planUiSync({}, new Map([['@geewiki/wiki', 'aaa111']]))
  assert.deepEqual(plan, { load: [], unload: ['@geewiki/wiki'] })
})

test('planUiSync：完全一致 → 两者皆空（幂等，不触发重渲染）', () => {
  const plan = planUiSync({ '@geewiki/wiki': WIKI }, new Map([['@geewiki/wiki', WIKI.rev]]))
  assert.deepEqual(plan, { load: [], unload: [] })
})

test('planUiSync：rev 变化 → 该插件同时出现在 unload 与 load（先卸后装）', () => {
  const plan = planUiSync({ '@geewiki/wiki': { ...WIKI, rev: 'newrev' } }, new Map([['@geewiki/wiki', 'aaa111']]))
  assert.deepEqual(plan, { load: ['@geewiki/wiki'], unload: ['@geewiki/wiki'] })
})

test('planUiSync：多插件混合场景 + 结果确定性排序', () => {
  const entries: Record<string, UiTableEntry> = {
    '@z/last': { entry: 'client.js', rev: 'r1' },
    '@a/first': { entry: 'client.js', rev: 'r2' },
    same: { entry: 'client.js', rev: 'r3' },
  }
  const loaded = new Map([
    ['gone', 'r9'], // 表里没有 → unload
    ['same', 'r3'], // 一致 → 不动
  ])
  const plan = planUiSync(entries, loaded)
  // '@a/first' 与 '@z/last' 是表中新增（→ load）；'same' 已加载且 rev 一致（→ 不动）；'gone' 表中已无（→ unload）
  assert.deepEqual(plan.load, ['@a/first', '@z/last'])
  assert.deepEqual(plan.unload, ['gone'])
  // 同一输入重复调用必须得到同一结果（排序保证，不受 Map 插入顺序影响）
  assert.deepEqual(planUiSync(entries, loaded), plan)
})

/* ------------------------- isUiSettled ------------------------- */

test('isUiSettled：全部按同一 rev 加载 → 收敛（此时才允许 304 短路）', () => {
  assert.equal(isUiSettled({ '@gw/a': WIKI }, new Map([['@gw/a', WIKI.rev]])), true)
  assert.equal(isUiSettled({}, new Map()), true, '空表 + 什么都没加载也算收敛')
})

test('isUiSettled：有该加载却没加载的条目 → 未收敛（必须放弃 304 重新对齐）', () => {
  // 这是真实故障场景：加载失败导致 revision 推进而 loaded 缺项；此后 revision 回到同一值（启用→停用→再启用）
  // 时若仍带 If-None-Match，后端回 304，该插件就永久漏加载。
  assert.equal(isUiSettled({ '@gw/a': WIKI }, new Map()), false)
})

test('isUiSettled：rev 不一致 → 未收敛', () => {
  assert.equal(isUiSettled({ '@gw/a': WIKI }, new Map([['@gw/a', 'stale']])), false)
})

test('isUiSettled：多余的在加载项 → 未收敛（应被卸载）', () => {
  assert.equal(isUiSettled({}, new Map([['@gw/gone', 'r']])), false)
  assert.equal(isUiSettled({ '@gw/a': WIKI }, new Map([['@gw/a', WIKI.rev], ['@gw/extra', 'r']])), false)
})

test('isUiSettled：已知失败且 rev 未变 → 视为收敛（不重复重试、不重复告警）', () => {
  const failed = new Map([['@gw/a', WIKI.rev]])
  assert.equal(isUiSettled({ '@gw/a': WIKI }, new Map(), failed), true)
  // rev 变了 → 失败记录失效，重新尝试
  assert.equal(isUiSettled({ '@gw/a': { ...WIKI, rev: 'newrev' } }, new Map(), failed), false)
})

/* ------------------------- skipped：解析（从宽） ------------------------- */

/** 构造带 skipped 的响应体 */
function tableWithSkipped(skipped: unknown, plugins: Record<string, unknown> = {}): unknown {
  return { ok: true, version: 1, revision: 'rev-skip', plugins, skipped }
}

test('parseUiTable：解析 skipped 的合法项（name + reason）', () => {
  const parsed = parseUiTable(
    tableWithSkipped([
      { name: '@gw/db', reason: 'no_client' },
      { name: '@gw/x', reason: 'entry_missing' },
      { name: '@gw/y', reason: 'inactive' },
      { name: 'bad name', reason: 'invalid_name' },
    ]),
  )
  assert.deepEqual(parsed?.skipped, [
    { name: '@gw/db', reason: 'no_client' },
    { name: '@gw/x', reason: 'entry_missing' },
    { name: '@gw/y', reason: 'inactive' },
    { name: 'bad name', reason: 'invalid_name' },
  ])
})

test('parseUiTable：缺 skipped 字段 → 空数组（兼容旧后端，不得因此判整表不可信）', () => {
  const parsed = parseUiTable({ ok: true, version: 1, revision: 'r', plugins: { wiki: { entry: 'client.js', rev: 'x' } } })
  assert.ok(parsed, '缺 skipped 绝不能导致整表不可信——那会让入口表加载被跳过')
  assert.deepEqual(parsed.skipped, [])
})

test('parseUiTable：skipped 不是数组 → 按空处理，且**不影响** plugins 的可信性', () => {
  for (const bad of ['nope', 42, null, {}]) {
    const parsed = parseUiTable(tableWithSkipped(bad, { wiki: { entry: 'client.js', rev: 'x' } }))
    assert.ok(parsed, `skipped=${JSON.stringify(bad)} 不应让整表不可信`)
    assert.deepEqual(parsed.skipped, [])
    assert.deepEqual(Object.keys(parsed.entries), ['wiki'], 'plugins 仍应正常解析')
  }
})

test('parseUiTable：skipped 单条损坏只丢该条（缺 name / 未知 reason / 非对象）', () => {
  const parsed = parseUiTable(
    tableWithSkipped([
      { name: '@gw/keep', reason: 'inactive' },
      { reason: 'inactive' }, // 缺 name
      { name: '', reason: 'inactive' }, // 空 name
      { name: '@gw/future', reason: 'some_future_reason' }, // 未知 reason（前向兼容：宁可少显示也不误分级）
      null,
      'str',
      { name: '@gw/keep2', reason: 'entry_missing' },
    ]),
  )
  assert.deepEqual(parsed?.skipped, [
    { name: '@gw/keep', reason: 'inactive' },
    { name: '@gw/keep2', reason: 'entry_missing' },
  ])
})

test('parseUiTable：skipped 独立于整体可信性判定（version/revision/plugins 仍各司其职）', () => {
  // skipped 合法但 version 不对 → 整表仍不可信
  assert.equal(parseUiTable({ version: 2, revision: 'r', plugins: {}, skipped: [{ name: 'a', reason: 'inactive' }] }), undefined)
  // skipped 合法但 revision 缺失 → 整表仍不可信
  assert.equal(parseUiTable({ version: 1, plugins: {}, skipped: [{ name: 'a', reason: 'inactive' }] }), undefined)
})

/* ------------------------- skipped：分级 ------------------------- */

test('classifyUiSkips：entry_missing / invalid_name 归"需要注意"，inactive / no_client 归"正常"', () => {
  const groups = classifyUiSkips([
    { name: '@gw/a', reason: 'inactive' },
    { name: '@gw/b', reason: 'entry_missing' },
    { name: '@gw/c', reason: 'no_client' },
    { name: '@gw/d', reason: 'invalid_name' },
  ])
  assert.deepEqual(groups.attention, [
    { name: '@gw/b', reason: 'entry_missing' },
    { name: '@gw/d', reason: 'invalid_name' },
  ])
  assert.deepEqual(groups.normal, [
    { name: '@gw/a', reason: 'inactive' },
    { name: '@gw/c', reason: 'no_client' },
  ])
})

test('classifyUiSkips：两组各自按名排序（渲染确定性），空输入得两个空数组', () => {
  const groups = classifyUiSkips([
    { name: 'zeta', reason: 'entry_missing' },
    { name: 'alpha', reason: 'entry_missing' },
    { name: 'y', reason: 'inactive' },
    { name: 'b', reason: 'inactive' },
  ])
  assert.deepEqual(groups.attention.map((s) => s.name), ['alpha', 'zeta'])
  assert.deepEqual(groups.normal.map((s) => s.name), ['b', 'y'])
  assert.deepEqual(classifyUiSkips([]), { attention: [], normal: [] })
})

test('classifyUiSkips：不修改入参（纯函数）', () => {
  const input = [
    { name: 'z', reason: 'entry_missing' as const },
    { name: 'a', reason: 'entry_missing' as const },
  ]
  const snapshot = JSON.parse(JSON.stringify(input))
  classifyUiSkips(input)
  assert.deepEqual(input, snapshot, '不得就地排序入参')
})

test('UI_SKIP_LABEL / UI_SKIP_HELP：四个 reason 都有中文标签与解释', () => {
  for (const reason of UI_SKIP_REASONS) {
    assert.ok(UI_SKIP_LABEL[reason], `${reason} 缺标签`)
    assert.ok(UI_SKIP_HELP[reason], `${reason} 缺解释`)
  }
})

/* ------------------------- 懒加载判定（isLazyOnlyEntry） ------------------------- */

test('isLazyOnlyEntry：生效插槽只有 editor → 可推迟加载', () => {
  assert.equal(isLazyOnlyEntry({ entry: 'c.js', rev: 'r', slots: ['editor'] }), true)
})

test('isLazyOnlyEntry：含首屏可见插槽 → 不推迟（推迟它们只会造成视觉抖动）', () => {
  assert.equal(isLazyOnlyEntry({ entry: 'c.js', rev: 'r', slots: ['app-header'] }), false)
  assert.equal(isLazyOnlyEntry({ entry: 'c.js', rev: 'r', slots: ['editor', 'app-header'] }), false)
})

test('isLazyOnlyEntry：未声明插槽 → 不推迟（无法判断何时需要，保守加载）', () => {
  assert.equal(isLazyOnlyEntry({ entry: 'c.js', rev: 'r' }), false)
  assert.equal(isLazyOnlyEntry({ entry: 'c.js', rev: 'r', slots: [] }), false)
})

test('planUiSync：被推迟的条目不进 load（懒加载的核心行为）', () => {
  const entries = { '@gw/edit': { entry: 'c.js', rev: 'r1', slots: ['editor'] as const } } as unknown as Record<string, UiTableEntry>
  assert.deepEqual(planUiSync(entries, new Map()).load, ['@gw/edit'])
  assert.deepEqual(planUiSync(entries, new Map(), new Set(['@gw/edit'])).load, [], '被推迟 ⇒ 不该同步加载')
})

test('planUiSync：被推迟的条目 rev 变化时**仍要先卸**（旧产物必须停止贡献）', () => {
  const entries = { '@gw/edit': { entry: 'c.js', rev: 'r2', slots: ['editor'] as const } } as unknown as Record<string, UiTableEntry>
  const plan = planUiSync(entries, new Map([['@gw/edit', 'r1']]), new Set(['@gw/edit']))
  assert.deepEqual(plan.unload, ['@gw/edit'], 'rev 变了必须卸掉旧注册')
  assert.deepEqual(plan.load, [], '推迟中 ⇒ 重新装载留给按需触发')
})

test('isUiSettled：被推迟的条目算"处理完了"（否则每轮轮询都会白拉一次完整表）', () => {
  const entries = { '@gw/edit': { entry: 'c.js', rev: 'r1', slots: ['editor'] as const } } as unknown as Record<string, UiTableEntry>
  assert.equal(isUiSettled(entries, new Map()), false, '既没加载也没推迟 ⇒ 未收敛')
  assert.equal(isUiSettled(entries, new Map(), new Map(), new Map([['@gw/edit', 'r1']])), true, '已按同一 rev 推迟 ⇒ 收敛')
  assert.equal(isUiSettled(entries, new Map(), new Map(), new Map([['@gw/edit', 'r0']])), false, '推迟记录的 rev 不匹配 ⇒ 未收敛')
})

/* ------------------------- 插槽仲裁（parseSuppressedOwners） ------------------------- */

test('parseSuppressedOwners：取出被抑制的声明者（这是"被抑制者不得注册"的权威判据）', () => {
  const map = parseSuppressedOwners({
    ok: true,
    slots: [
      { slot: 'editor', cardinality: 'single', owners: ['@a', '@b'], effective: ['@a'], suppressed: ['@b'] },
      { slot: 'app-header', cardinality: 'multi', owners: ['@a'], effective: ['@a'], suppressed: [] },
    ],
  })
  assert.ok(map)
  assert.deepEqual([...(map.get('editor') ?? [])], ['@b'])
  assert.equal(map.get('app-header'), undefined, '无抑制者的插槽不该出现在表里')
})

test('parseSuppressedOwners：响应不可信时返回 undefined（调用方据此沿用上一次结果）', () => {
  assert.equal(parseSuppressedOwners(null), undefined)
  assert.equal(parseSuppressedOwners([]), undefined)
  assert.equal(parseSuppressedOwners({ ok: true }), undefined, 'slots 不是数组 ⇒ 不可信')
})

test('parseSuppressedOwners：未知插槽名与坏 owner 逐条丢弃，不影响其它条目', () => {
  const map = parseSuppressedOwners({
    slots: [
      { slot: 'nonexistent', suppressed: ['@x'] },
      { slot: 'editor', suppressed: ['@ok', 42, '', null] },
    ],
  })
  assert.ok(map)
  assert.equal(map.has('nonexistent' as never), false)
  assert.deepEqual([...(map.get('editor') ?? [])], ['@ok'])
})

test('SLOT_TABLE_PATH：仲裁端点路径与后端注册一致', () => {
  assert.equal(SLOT_TABLE_PATH, '/api/plugins/slots')
})
