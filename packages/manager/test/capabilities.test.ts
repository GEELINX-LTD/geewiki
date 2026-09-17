/**
 * 能力注册表的单元测试（★ F9）。
 *
 * 这一组用例钉的是"**权限判定方向错了也不会报错**"这一类缺陷。能力是一张
 * 布尔表，消费方（前端导航、路由闸门）只问"这个键是不是 `true`" —— 于是
 * "该 false 的判成了 true"**不会崩、不会红、不会有日志**，只会多出一些入口。
 * 因此每条用例都在钉一个**方向**，而不是一个数值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CapabilityDecl, Principal } from '@geewiki/core'
import {
  CapabilityRegistry,
  collectCapabilityDecls,
  resolveCapabilityDecls,
  unresolvedCapabilities,
  type OwnedCapabilityDecl,
} from '../src/capabilities.js'

const decl = (owner: string, name: string, extra: Partial<CapabilityDecl> = {}): OwnedCapabilityDecl => ({
  owner,
  decl: { name, ...extra },
})

const registryOf = (entries: Array<[string, CapabilityDecl[]]>) =>
  entries.map(([name, capabilities]) => ({ name, manifest: { geewiki: { capabilities } } }))

const user = (orgRole: Principal['orgRole']): Principal => ({
  kind: 'user',
  userId: 1,
  orgId: 1,
  orgRole,
  groupIds: [],
  sessionId: 's1',
})

/* ------------------------- 声明：收集与语法校验 ------------------------- */

test('collectCapabilityDecls：内置名与不含 `/` 的名字都被拒绝', () => {
  // 用告警文本捕获来断言"拒绝"这件事发生了（否则三条都会静默消失）
  const warned: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    const out = collectCapabilityDecls(
      registryOf([
        ['p', [{ name: 'administer' }, { name: 'review/approve' }, { name: 'nope' }, { name: 'Bad/Case' }]],
      ]),
    )
    assert.deepEqual(out.map((d) => d.decl.name), ['review/approve'])
  } finally {
    console.warn = orig
  }
  assert.equal(warned.length, 3, `应告警三次（内置名/无斜杠/大写非法），实际：${warned.join(' | ')}`)
  assert.ok(warned.some((w) => w.includes('内置能力')))
})

test('collectCapabilityDecls：capabilities 不是数组时忽略该插件而不抛错', () => {
  const orig = console.warn
  console.warn = () => {}
  try {
    const out = collectCapabilityDecls([
      { name: 'p', manifest: { geewiki: { capabilities: 'nope' as unknown as CapabilityDecl[] } } },
      { name: 'q', manifest: { geewiki: { capabilities: [{ name: 'a/b' }] } } },
    ])
    assert.deepEqual(out.map((d) => d.owner), ['q'])
  } finally {
    console.warn = orig
  }
})

/* ------------------------------ 裁决：冲突 ------------------------------ */

test('resolveCapabilityDecls：同名能力由最早激活者胜出，其余进 conflicts', () => {
  const { capabilities, conflicts } = resolveCapabilityDecls(
    [decl('late', 'review/approve'), decl('early', 'review/approve'), decl('solo', 'review/read')],
    ['early', 'late', 'solo'],
  )
  assert.deepEqual(capabilities.map((c) => c.decl.name), ['review/approve', 'review/read'])
  assert.equal(capabilities[0]?.owner, 'early')
  assert.deepEqual(conflicts, [{ name: 'review/approve', winner: 'early', suppressed: ['late'] }])
})

test('resolveCapabilityDecls：同一 owner 重复声明同名只留第一条', () => {
  const orig = console.warn
  console.warn = () => {}
  try {
    const { capabilities, conflicts } = resolveCapabilityDecls(
      [decl('p', 'a/b', { label: '第一' }), decl('p', 'a/b', { label: '第二' })],
      ['p'],
    )
    assert.equal(capabilities.length, 1)
    assert.equal(capabilities[0]?.decl.label, '第一')
    assert.deepEqual(conflicts, [])
  } finally {
    console.warn = orig
  }
})

/* --------------------------- 运行期：注册与快照 --------------------------- */

test('CapabilityRegistry：内置名不可被顶替，非法名被拒绝', () => {
  const reg = new CapabilityRegistry()
  const orig = console.warn
  console.warn = () => {}
  try {
    reg.provide('p', 'administer', () => true)
    reg.provide('p', 'notnamespaced', () => true)
    assert.deepEqual(reg.registered(), [])
    // 被拒绝的注册返回**空操作**撤销函数（不是 undefined）：调用方可以无条件调它
    const undo = reg.provide('p', 'administer', () => true)
    assert.equal(typeof undo, 'function')
    undo()
    assert.deepEqual(reg.registered(), [])
  } finally {
    console.warn = orig
  }
})

test('CapabilityRegistry 快照：内置（角色推导）与插件求解器合并，缺失即不具备', () => {
  const reg = new CapabilityRegistry()
  reg.provide('review', 'review/approve', (p) => p.orgRole === 'owner')

  const admin = reg.snapshot(user('admin')) as Record<string, boolean>
  assert.equal(admin.administer, true)
  // 插件求解器只给 owner ⇒ admin 拿不到（能力是"谁说了算"，不是"是不是管理员"）
  assert.equal(admin['review/approve'], false)

  const owner = reg.snapshot(user('owner')) as Record<string, boolean>
  assert.equal(owner['review/approve'], true)

  const viewer = reg.snapshot(user('viewer')) as Record<string, boolean>
  assert.equal(viewer.administer, false)
  assert.equal(viewer.editContent, false)
  assert.equal(viewer['review/approve'], false)

  // 应急通道等同 owner（内置规则未变）
  const bg = reg.snapshot({ kind: 'break-glass', userId: null, orgId: null, orgRole: null, groupIds: [], sessionId: null })
  assert.equal(bg.administer, true)
})

test('CapabilityRegistry：求解器抛错判为不具备（失败关闭，不是放行）', () => {
  const reg = new CapabilityRegistry()
  reg.provide('bad', 'bad/boom', () => {
    throw new Error('求解器写错了')
  })
  reg.provide('good', 'good/ok', () => true)

  const orig = console.warn
  console.warn = () => {}
  let snap: Record<string, boolean>
  try {
    snap = reg.snapshot(user('owner')) as Record<string, boolean>
  } finally {
    console.warn = orig
  }
  /*
   * 方向断言：抛错 ⇒ false。若写成"catch 后 keep 上一次的值"或"catch 后判 true"，
   * 一次插件异常就变成一次**越权**，且没有任何症状 —— 这是本用例存在的全部理由。
   */
  assert.equal(snap['bad/boom'], false)
  // 且一个求解器抛错不影响其它能力
  assert.equal(snap['good/ok'], true)
  assert.equal(snap.administer, true)
})

test('CapabilityRegistry：principal 为 undefined 时全部不具备，且**不调用任何求解器**', () => {
  const reg = new CapabilityRegistry()
  let called = 0
  reg.provide('p', 'p/x', () => {
    called += 1
    return true
  })
  const snap = reg.snapshot(undefined) as Record<string, boolean>
  assert.equal(snap['p/x'], false)
  assert.equal(snap.administer, false)
  /*
   * `Principal` 的设计是"没有空主体，只有 kind:'anonymous'"。把 undefined 透传给求解器
   * 等于要求每个作者处理一个设计上不存在的输入 —— 而漏处理时的默认分支常写成
   * "不是已知用户就 true"。边界必须收在宿主侧，故这里断言**调用次数为 0**。
   */
  assert.equal(called, 0)
})

test('CapabilityRegistry：同名先到先得，release 按 owner 成组撤销', () => {
  const reg = new CapabilityRegistry()
  const orig = console.warn
  console.warn = () => {}
  try {
    reg.provide('first', 'k/a', () => true)
    reg.provide('second', 'k/a', () => false)
    reg.provide('first', 'k/b', () => true)
  } finally {
    console.warn = orig
  }
  assert.deepEqual(reg.registered(), ['k/a', 'k/b'])
  // 先到者生效：后来者的求解器没有覆盖它
  assert.equal((reg.snapshot(user('viewer')) as Record<string, boolean>)['k/a'], true)

  reg.release('first')
  assert.deepEqual(reg.registered(), [])
})

/* -------------------------- 诊断：声明了但没求解器 -------------------------- */

test('unresolvedCapabilities：报出"声明了却没有注册求解器"的能力名', () => {
  /*
   * 这是 F9 引入的**新失效形态**：声明只说"我引入了这个名字"，值要靠 provide()。
   * 漏了后者 ⇒ 该能力恒 false ⇒ 依赖它的导航项永远不出现、且没有任何报错。
   * 判据必须能把这件事故意报出来（与插槽的 `undeclared` 同构）。
   */
  assert.deepEqual(unresolvedCapabilities(['a/x', 'a/y'], ['a/x']), ['a/y'])
  assert.deepEqual(unresolvedCapabilities(['a/x'], ['a/x', 'b/z']), [])
  assert.deepEqual(unresolvedCapabilities([], []), [])
})

test('CapabilityRegistry.declarations：内置三个在前且顺序稳定，插件能力按名字排序', () => {
  const reg = new CapabilityRegistry()
  reg.provide('p', 'z/last', () => true)
  reg.provide('p', 'a/first', () => true)
  assert.deepEqual(
    reg.declarations().map((d) => d.name),
    ['editContent', 'administer', 'manageVisibility', 'a/first', 'z/last'],
  )
  assert.equal(reg.declarations()[0]?.owner, '<builtin>')
})
