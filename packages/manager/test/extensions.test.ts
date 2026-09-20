/**
 * **界面扩展平台的模式化裁决**（P3）守卫。
 *
 * ## 这个文件防的是什么
 * `resolveExtensions` 决定了"谁在什么位置上、以什么模式生效"，而它的两种典型坏法
 * 都是**静默**的：
 *
 * 1. **单占用裁决反了**（最新胜出而不是最早胜出）——后来启用的插件**悄悄顶掉**
 *    正在工作的编辑器/输入条，用户只看到"东西被换了"，日志干净。
 * 2. **模式被当成装饰**（`replace` 与 `extend` 混在一起算）——`replace` 会让宿主默认实现
 *    整个不渲染（无障碍与键盘可达的责任转移给插件），把它与"追加"混算等于让插件
 *    无意间接管了宿主控件。
 *
 * 因此这里既断言正向结果，也用**反向对照**（同一节点、不同模式、不同激活顺序）
 * 证明断言不是"怎么写都绿"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SlotRegistry } from '../src/slots.js'
import { resolveExtensions, resolveSlots } from '../src/slots.js'
import type { SlotContribution } from '@geewiki/core'

/** 造一条贡献记录（字段与 SlotContribution 对齐） */
function contrib(
  owner: string,
  node: string,
  mode: 'replace' | 'wrap' | 'extend' = 'extend',
  extra: { lazy?: boolean; importPath?: string } = {},
): SlotContribution {
  return {
    slot: node as SlotContribution['slot'],
    owner,
    via: 'runtime',
    lazy: extra.lazy ?? false,
    mode,
    ...(extra.importPath === undefined ? {} : { importPath: extra.importPath }),
  }
}

test('extend()：登记指定模式的贡献，list() 带上模式', () => {
  const reg = new SlotRegistry()
  const off = reg.extend('p1', 'editor', 'replace')
  const listed = reg.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.mode, 'replace')
  assert.equal(listed[0]?.slot, 'editor')
  // 幂等注销
  off()
  off()
  assert.deepEqual(reg.list(), [])
})

test('contribute() 是 extend 的简写（既有行为逐字不变）', () => {
  const reg = new SlotRegistry()
  reg.contribute('p1', 'app-header')
  assert.equal(reg.list()[0]?.mode, 'extend', 'contribute 的缺省模式必须是 extend')
})

test('★ 节点不允许的模式被拒绝并告警（不静默、也不抛）', () => {
  const reg = new SlotRegistry()
  const warns: string[] = []
  const orig = console.warn
  console.warn = (msg?: unknown) => warns.push(String(msg))
  try {
    // app-header 只允许 extend（整体替换掉页头没有意义：宿主就没有页头语义了）
    reg.extend('p1', 'app-header', 'replace')
    reg.extend('p1', 'app-header', 'wrap')
    // 插件自定义扩展点只为 extend 背书
    reg.extend('p1', 'other-plugin/panel', 'replace')
  } finally {
    console.warn = orig
  }
  assert.deepEqual(reg.list(), [], '被拒绝的贡献不得落进注册表')
  assert.equal(warns.length, 3, `三种非法组合都应告警，实际：${warns.join(' | ')}`)
  assert.ok(warns.every((w) => w.includes('[manager:slot]')))
  // 反向对照：允许的模式必须登记得上（否则上面的断言可能只是"一律拒绝"）
  reg.extend('p1', 'editor', 'replace')
  assert.equal(reg.list().length, 1)
})

test('★ 同一 (owner, node) 改模式会告警（不静默改写别人的界面）', () => {
  const reg = new SlotRegistry()
  const warns: string[] = []
  const orig = console.warn
  console.warn = (msg?: unknown) => warns.push(String(msg))
  try {
    reg.extend('p1', 'editor', 'extend')
    reg.extend('p1', 'editor', 'replace')
  } finally {
    console.warn = orig
  }
  assert.equal(reg.list().length, 1, '同一 (owner, node) 只有一条贡献')
  assert.equal(reg.list()[0]?.mode, 'replace', '后登记的模式生效')
  assert.equal(warns.length, 1)
  assert.match(warns[0] as string, /模式由 extend 改为 replace/)
})

test('★ 单占用（replace）：激活顺序最早者胜出，后来者进 suppressed 且点名被谁顶掉', () => {
  const contributions = [contrib('late', 'editor', 'replace'), contrib('early', 'editor', 'replace')]
  // 激活顺序：early 先启用
  const [a] = resolveExtensions(contributions, ['early', 'late'])
  assert.ok(a)
  assert.equal(a.byMode.replace, 'early', '必须是最早激活者胜出（最新胜出会静默顶掉别人的编辑器）')
  assert.deepEqual(a.suppressed, ['late'])
  assert.deepEqual(a.suppressedDetail, [{ owner: 'late', mode: 'replace', winner: 'early' }])
  // 反向对照：换一个激活顺序，胜出者必须跟着换（证明不是硬编码）
  const [b] = resolveExtensions(contributions, ['late', 'early'])
  assert.equal(b?.byMode.replace, 'late')
})

test('★ wrap 与 replace 各自单占用，互不顶替；extend 叠加', () => {
  const contributions = [
    contrib('r1', 'editor', 'replace'),
    contrib('r2', 'editor', 'replace'),
    contrib('w1', 'editor', 'wrap'),
    contrib('e1', 'editor', 'extend'),
    contrib('e2', 'editor', 'extend'),
  ]
  const [a] = resolveExtensions(contributions, ['e2', 'w1', 'r1', 'r2', 'e1'])
  assert.ok(a)
  assert.equal(a.byMode.replace, 'r1', 'replace 最早者 r1 胜出')
  assert.equal(a.byMode.wrap, 'w1')
  // editor 的 extend 是单占用（SLOT_CARDINALITY）：只剩最早激活的 e2
  assert.deepEqual([...a.byMode.extend], ['e2'])
  assert.deepEqual([...a.suppressed].sort(), ['e1', 'r2'])
  // effective 的顺序 = 应用顺序 replace → wrap → extend
  assert.deepEqual(
    a.effective.map((e) => `${e.mode}:${e.owner}`),
    ['replace:r1', 'wrap:w1', 'extend:e2'],
  )
})

test('app-header 是 multi：extend 贡献全部生效，不抑制', () => {
  const contributions = [contrib('p1', 'app-header'), contrib('p2', 'app-header')]
  const [a] = resolveExtensions(contributions, ['p1', 'p2'])
  assert.ok(a)
  assert.equal(a.cardinality, 'multi')
  assert.deepEqual([...a.byMode.extend], ['p1', 'p2'])
  assert.deepEqual(a.suppressed, [])
})

test('自定义扩展点：kind=custom、modes=[extend]、propsVersion=1；声明 single 时按 single 裁决', () => {
  const contributions = [contrib('p1', 'a/toolbar'), contrib('p2', 'a/toolbar')]
  const [multi] = resolveExtensions(contributions, ['p1', 'p2'])
  assert.ok(multi)
  assert.equal(multi.kind, 'custom')
  assert.deepEqual([...multi.modes], ['extend'])
  assert.equal(multi.propsVersion, 1)
  assert.equal(multi.cardinality, 'multi', '未声明即 multi')
  assert.deepEqual([...multi.byMode.extend], ['p1', 'p2'])

  // 声明 single 之后，同一份贡献列表的裁决必须变（否则"声明"就是个摆设）
  const [single] = resolveExtensions(contributions, ['p1', 'p2'], [{ slot: 'a/toolbar', owner: 'a', cardinality: 'single' }])
  assert.ok(single)
  assert.equal(single.cardinality, 'single')
  assert.deepEqual([...single.byMode.extend], ['p1'])
  assert.deepEqual(single.suppressed, ['p2'])
})

test('宿主节点带目录事实：kind / modes / propsVersion 都来自目录', () => {
  const [a] = resolveExtensions([contrib('p1', 'article-summary')], ['p1'])
  assert.ok(a)
  assert.equal(a.kind, 'slot')
  assert.deepEqual([...a.modes], ['extend', 'wrap', 'replace'])
  assert.equal(a.propsVersion, 1)
  assert.equal(a.cardinality, 'single', 'article-summary 是单占用')
})

test('节点顺序 = 内置插槽白名单序 → 自定义扩展点字典序（顺序稳定，不随插入序漂移）', () => {
  const shuffled = [
    contrib('p', 'zz/c'),
    contrib('p', 'app-footer'),
    contrib('p', 'editor'),
    contrib('p', 'aa/a'),
    contrib('p', 'app-header'),
  ]
  const nodes = resolveExtensions(shuffled, ['p']).map((a) => a.node)
  assert.deepEqual(nodes, ['app-header', 'app-footer', 'editor', 'aa/a', 'zz/c'])
  // 反向对照：换一个插入顺序，输出必须完全相同
  const reversed = [...shuffled].reverse()
  assert.deepEqual(resolveExtensions(reversed, ['p']).map((a) => a.node), nodes)
})

test('★ resolveSlots 是 resolveExtensions 的投影（旧视图不得与新裁决分裂）', () => {
  const contributions = [contrib('p1', 'editor'), contrib('p2', 'editor'), contrib('p3', 'app-footer')]
  const ext = resolveExtensions(contributions, ['p1', 'p2', 'p3'])
  const legacy = resolveSlots(contributions, ['p1', 'p2', 'p3'])
  assert.deepEqual(
    legacy.map((a) => a.slot),
    ext.map((a) => a.node),
  )
  for (const [i, a] of legacy.entries()) {
    const e = ext[i]
    assert.ok(e)
    assert.equal(a.cardinality, e.cardinality)
    assert.deepEqual([...a.owners], [...e.owners])
    // 旧视图的 effective = 单占用取第一个 / 多占用全取（与 mode 无关的旧公式）
    assert.deepEqual(
      [...a.effective],
      a.cardinality === 'single' ? a.owners.slice(0, 1) : [...a.owners],
    )
  }
  // 非空洞：确实解析出了东西
  assert.ok(legacy.length >= 2, `解析出的节点过少（${legacy.length}），疑似解析失效`)
})

test('按 owner 回收后，裁决结果里不再有它的痕迹（生命周期挂钩）', () => {
  const reg = new SlotRegistry()
  reg.extend('p1', 'editor', 'replace')
  reg.extend('p2', 'editor', 'extend')
  const before = resolveExtensions(reg.list(), ['p1', 'p2'])
  assert.equal(before[0]?.byMode.replace, 'p1')
  reg.release('p1')
  const after = resolveExtensions(reg.list(), ['p1', 'p2'])
  assert.equal(after[0]?.byMode.replace, undefined, '卸载后 replace 胜出者必须消失')
  assert.deepEqual([...after[0]!.byMode.extend], ['p2'])
  // 反向对照：p2 仍在，说明不是"整条被清掉"
  assert.equal(after.length, 1)
})

test('清单路径：contributeFromManifest 带模式，且 via 保持 manifest', () => {
  const reg = new SlotRegistry()
  reg.contributeFromManifest('p1', 'editor', undefined, 'replace')
  const [c] = reg.list()
  assert.equal(c?.via, 'manifest')
  assert.equal(c?.mode, 'replace')
  // 非法模式走同一套拒绝（不落表）
  reg.contributeFromManifest('p2', 'app-header', undefined, 'replace')
  assert.equal(reg.list().length, 1)
})
