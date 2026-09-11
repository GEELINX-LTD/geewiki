/**
 * 插槽契约测试：纯函数裁决（{@link resolveSlots}）+ 注册表（{@link SlotRegistry}）
 * + **跨包白名单对齐守卫**。
 *
 * 为什么要有最后一类守卫：`SlotName` 白名单有两份真源——权威在 `packages/core`
 * （后端登记用），镜像在 `packages/web/src/lib/slots.tsx`（前端渲染用；web 不能 import
 * core，因为 core 顶层 `import 'node:fs'`，进浏览器会炸）。
 * 手抄镜像会漂移，且漂移的表现是**静默的**：core 加了 `editor` 而 web 没加 ⇒
 * 后端登记了贡献、前端 `registerSlot` 却把它当未知插槽忽略 ⇒ 插件"激活了、表里也有、
 * 界面上什么都没有"，日志里却一片干净。这正是本仓库反复踩过的"两个真源"形状
 * （`DegradedReason` 镜像、`PLUGIN_UI_FILE_SEGMENT` 副本、迁移目录硬编码）。
 *
 * 守卫如何避免空洞通过（沿用 `degradedReason.test.ts` 的既有做法）：
 * - 先断言两侧都解析出**非空**集合（正则写坏 ⇒ 立即红，不会退化成 0===0）；
 * - 再断言两侧集合**元素逐个相等**（顺序也一致，便于人读时比对）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOT_CARDINALITY, SLOT_NAMES, type SlotContribution } from '@geewiki/core'
import {
  SlotRegistry,
  conflictsOf,
  effectiveSlotsByOwner,
  isSlotImportPath,
  isSlotName,
  resolveSlots,
} from '../src/slots.js'

function findRepoRoot(from: string): string {
  let dir = dirname(from)
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`未能从 ${from} 向上找到仓库根（pnpm-workspace.yaml）`)
}

/** 造一条贡献记录（测试用，字段与 SlotContribution 对齐） */
function contrib(owner: string, slot: string, lazy = false): SlotContribution {
  return { slot: slot as SlotContribution['slot'], owner, via: 'manifest', lazy }
}

/* ---------------------- 跨包白名单对齐守卫 ---------------------- */

/**
 * 尚未同步到前端的插槽（**这个清单只允许变短**）。
 *
 * 为什么需要它：本批在 core 侧新增了 `editor`，而 `packages/web/src/lib/slots.tsx`
 * 由**另一个批次**负责（本批被明确禁止改 web）。于是"core 有、web 无"这个中间状态
 * 客观存在，直接断言两侧全等会让本批门禁恒红——而**把断言删掉**就等于放弃了守卫，
 * 那正是本仓库反复踩的坑（`DegradedReason` 镜像漂移、迁移目录两个真源）。
 *
 * 故这里把中间状态**显式记账**，并保持两个方向都受检：
 * - **危险方向**（web 有而 core 无）：永远直接失败，不设豁免——那会让后端登记不出
 *   前端却认得的插槽，属于纯故障。
 * - **待同步方向**（core 有而 web 无）：必须逐字列在这里。web 一旦补上 `editor`，
 *   下面的 `assert.deepEqual(pending, ...)` 会因"清单里还有它"而变红，
 *   提醒移除该行——**清单位于唯一的收敛路径上，不会悄悄留在代码里**。
 * ## 当前状态：**清单已空**（收敛完成）
 * `editor` 已由前端批次补齐（`packages/web/src/lib/slots.tsx` 的 `SlotName`/`SLOT_NAMES`），
 * 两侧现已全等，故清空记账。这条**记账机制保留**——下一个"core 先加、web 后跟"的插槽
 * 仍应走同一条路径，而不是把断言放宽。
 */
const PENDING_WEB_SYNC: readonly string[] = []

test('SlotName 白名单：core 与 web 两侧解析出的集合逐元素相等', () => {
  const root = findRepoRoot(fileURLToPath(import.meta.url))
  const webFile = join(root, 'packages/web/src/lib/slots.tsx')
  const source = readFileSync(webFile, 'utf8')

  const match = /export const SLOT_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(source)
  assert.ok(match, `未能从 ${webFile} 解析出 SLOT_NAMES 数组字面量（正则失效即红，不允许静默通过）`)
  const webNames = [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)

  // 兜底：正则写坏时上面可能匹配到空数组，这里显式拒绝空集合
  assert.ok(webNames.length > 0, 'web 侧解析出的插槽白名单为空（正则有误或白名单被清空）')

  const coreNames = [...SLOT_NAMES]
  const coreSet = new Set<string>(coreNames)
  const webSet = new Set(webNames)

  // ① 危险方向：web 认得而 core 不认 —— 永远失败，不设豁免
  const webOnly = webNames.filter((n) => !coreSet.has(n))
  assert.deepEqual(
    webOnly,
    [],
    `web 侧存在 core 未声明的插槽 ${JSON.stringify(webOnly)}：前端会渲染一个后端永远不会登记的位置`,
  )

  // ② 待同步方向：core 有而 web 无 —— 必须与记账清单**逐字相等**
  const coreOnly = coreNames.filter((n) => !webSet.has(n))
  assert.deepEqual(
    coreOnly,
    [...PENDING_WEB_SYNC],
    'core 侧独有插槽与 PENDING_WEB_SYNC 记账不一致：' +
      '若 web 已补上某插槽，请从该清单移除它（清单只允许变短）；' +
      '若新增了 core 独有插槽，必须在此显式记账并同步给前端批次',
  )

  // ③ 两侧共有的部分必须逐元素一致（顺序也一致，便于人读比对）
  const shared = coreNames.filter((n) => webSet.has(n))
  assert.deepEqual(shared, webNames.filter((n) => coreSet.has(n)), '两侧共有插槽的顺序不一致')
})

test('插槽基数表：覆盖白名单全部成员，且 editor 是单占用', () => {
  for (const slot of SLOT_NAMES) {
    assert.ok(SLOT_CARDINALITY[slot], `插槽 ${slot} 缺少基数声明`)
  }
  assert.equal(Object.keys(SLOT_CARDINALITY).length, SLOT_NAMES.length, '基数表有多余键或缺失键')
  assert.equal(SLOT_CARDINALITY.editor, 'single', 'editor 必须是单占用（两个编辑器同时渲染没有意义）')
  assert.equal(SLOT_CARDINALITY['app-header'], 'multi')
  assert.equal(SLOT_CARDINALITY['app-footer'], 'multi')
})

/* ---------------------- resolveSlots 裁决 ---------------------- */

test('resolveSlots：无人贡献时返回空（不产生空壳条目）', () => {
  assert.deepEqual(resolveSlots([], []), [])
})

test('resolveSlots：multi 插槽全部生效，无抑制', () => {
  const out = resolveSlots([contrib('a', 'app-header'), contrib('b', 'app-header')], ['a', 'b'])
  const header = out.find((x) => x.slot === 'app-header')
  assert.ok(header)
  assert.deepEqual([...header.effective], ['a', 'b'])
  assert.deepEqual([...header.suppressed], [])
})

test('resolveSlots：single 插槽按激活顺序取最早者生效（不是字典序）', () => {
  // 故意让字典序与激活顺序相反：z 先激活 ⇒ z 胜出
  const out = resolveSlots([contrib('a', 'editor'), contrib('z', 'editor')], ['z', 'a'])
  const editor = out.find((x) => x.slot === 'editor')
  assert.ok(editor)
  assert.deepEqual([...editor.effective], ['z'], '应按激活顺序最早者胜出，而非字典序')
  assert.deepEqual([...editor.suppressed], ['a'])
  assert.deepEqual([...editor.owners], ['z', 'a'])
})

test('resolveSlots：未在激活顺序里的 owner 排在最后（按字典序），不会顶掉已激活者', () => {
  const out = resolveSlots([contrib('zzz', 'editor'), contrib('live', 'editor')], ['live'])
  const editor = out.find((x) => x.slot === 'editor')
  assert.ok(editor)
  assert.deepEqual([...editor.effective], ['live'])
  assert.deepEqual([...editor.suppressed], ['zzz'])
})

test('resolveSlots：输出顺序按白名单顺序，与注册顺序无关', () => {
  const a = resolveSlots([contrib('x', 'editor'), contrib('x', 'app-header')], ['x'])
  const b = resolveSlots([contrib('x', 'app-header'), contrib('x', 'editor')], ['x'])
  assert.deepEqual(a.map((s) => s.slot), b.map((s) => s.slot))
  assert.deepEqual(a.map((s) => s.slot), ['app-header', 'editor'])
})

test('effectiveSlotsByOwner / conflictsOf：从裁决结果派生入口表与诊断所需形状', () => {
  const assignments = resolveSlots(
    [contrib('a', 'app-header'), contrib('b', 'editor'), contrib('c', 'editor')],
    ['a', 'b', 'c'],
  )
  const byOwner = effectiveSlotsByOwner(assignments)
  assert.deepEqual(byOwner.get('a'), ['app-header'])
  assert.deepEqual(byOwner.get('b'), ['editor'])
  assert.equal(byOwner.get('c'), undefined, '被抑制者不应出现在"实际生效"里')

  const conflicts = conflictsOf(assignments)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]?.slot, 'editor')
  assert.equal(conflicts[0]?.winner, 'b')
  assert.deepEqual([...conflicts[0]!.suppressed], ['c'])
})

test('conflictsOf：multi 插槽无论多少贡献者都不算冲突', () => {
  const assignments = resolveSlots([contrib('a', 'app-header'), contrib('b', 'app-header')], ['a', 'b'])
  assert.deepEqual(conflictsOf(assignments), [])
})

/* ---------------------- SlotRegistry ---------------------- */

test('contribute/list：登记后可见，注销函数幂等', () => {
  const reg = new SlotRegistry()
  const off = reg.contribute('p1', 'editor', { lazy: true, importPath: 'chunks/editor.js' })
  const listed = reg.list()
  assert.equal(listed.length, 1)
  assert.deepEqual(
    { ...listed[0] },
    { slot: 'editor', owner: 'p1', via: 'runtime', lazy: true, importPath: 'chunks/editor.js' },
  )
  off()
  off() // 幂等：第二次不应抛，也不应影响别人
  assert.deepEqual(reg.list(), [])
  assert.equal(reg.size(), 0)
})

test('contribute：同一 (owner, slot) 重复登记是同一条，不产生重复项', () => {
  const reg = new SlotRegistry()
  reg.contribute('p1', 'editor', { lazy: true })
  reg.contribute('p1', 'editor', { lazy: false, importPath: 'a.js' })
  const listed = reg.list()
  assert.equal(listed.length, 1, '同一 owner+slot 不应重复')
  assert.equal(listed[0]?.lazy, false, '后登记的 meta 覆盖先前')
  assert.equal(listed[0]?.importPath, 'a.js')
})

test('contribute：注销函数只影响自己那一条（不误伤同 owner 的其它插槽）', () => {
  const reg = new SlotRegistry()
  const offEditor = reg.contribute('p1', 'editor')
  reg.contribute('p1', 'app-header')
  offEditor()
  assert.deepEqual(reg.ownersOf('editor'), [])
  assert.deepEqual(reg.ownersOf('app-header'), ['p1'])
})

test('release：按 owner 一次性注销全部贡献（卸载统一出口的语义）', () => {
  const reg = new SlotRegistry()
  reg.contribute('p1', 'editor')
  reg.contribute('p1', 'app-header')
  reg.contribute('p2', 'app-header')
  reg.release('p1')
  assert.deepEqual(reg.ownersOf('editor'), [], '卸载后其插槽贡献必须消失')
  assert.deepEqual(reg.ownersOf('app-header'), ['p2'], '不得误伤其它 owner')
})

test('contributeFromManifest：via 标记为 manifest，且运行期改写不会把它变回 runtime', () => {
  const reg = new SlotRegistry()
  reg.contributeFromManifest('p1', 'editor')
  assert.equal(reg.list()[0]?.via, 'manifest')
  // 运行期补充 lazy 信息：仍应保留声明式身份（否则入口表无法区分来源）
  reg.contribute('p1', 'editor', { lazy: true })
  assert.equal(reg.list()[0]?.via, 'manifest')
  assert.equal(reg.list()[0]?.lazy, true)
})

test('contribute：未知插槽名被忽略且不抛（与前端忽略未知名的既有行为一致）', () => {
  const reg = new SlotRegistry()
  const off = reg.contribute('p1', 'nope' as never)
  assert.deepEqual(reg.list(), [])
  off() // 返回空操作注销函数，仍可安全调用
  assert.equal(isSlotName('nope'), false)
  assert.equal(isSlotName('editor'), true)
})

test('contribute：非法 importPath 被忽略并降级为"不声明路径"，贡献本身仍成立', () => {
  const reg = new SlotRegistry()
  reg.contribute('p1', 'editor', { lazy: true, importPath: '../../etc/passwd' })
  const listed = reg.list()
  assert.equal(listed.length, 1, '非法路径不应让整个贡献作废')
  assert.equal(listed[0]?.importPath, undefined, '非法路径必须被丢弃（不能留给宿主去取）')
  assert.equal(listed[0]?.lazy, true)
})

test('isSlotImportPath：只接受逐段 [A-Za-z0-9][A-Za-z0-9._-]*，拒绝穿越/绝对/空段/超深', () => {
  assert.equal(isSlotImportPath('editor.js'), true)
  assert.equal(isSlotImportPath('chunks/editor-abc123.js'), true)
  assert.equal(isSlotImportPath('a/b/c/d.js'), true)
  // 以下全部必须为假
  assert.equal(isSlotImportPath(''), false)
  assert.equal(isSlotImportPath('../secret.js'), false)
  assert.equal(isSlotImportPath('a/../b.js'), false)
  assert.equal(isSlotImportPath('a//b.js'), false)
  assert.equal(isSlotImportPath('/abs.js'), false)
  assert.equal(isSlotImportPath('a/'), false)
  assert.equal(isSlotImportPath('.hidden'), false)
  assert.equal(isSlotImportPath('%2e%2e/x.js'), false)
  assert.equal(isSlotImportPath('a\\b.js'), false)
  assert.equal(isSlotImportPath(Array.from({ length: 17 }, () => 'a').join('/')), false, '超过 16 段应拒绝')
  assert.equal(isSlotImportPath(undefined), false)
  assert.equal(isSlotImportPath(42), false)
})

test('list：顺序稳定（先白名单顺序、再 owner 字典序），与登记顺序无关', () => {
  const a = new SlotRegistry()
  a.contribute('z', 'editor')
  a.contribute('a', 'app-header')
  const b = new SlotRegistry()
  b.contribute('a', 'app-header')
  b.contribute('z', 'editor')
  assert.deepEqual(
    a.list().map((c) => `${c.slot}:${c.owner}`),
    b.list().map((c) => `${c.slot}:${c.owner}`),
  )
  assert.deepEqual(a.list().map((c) => c.slot), ['app-header', 'editor'])
})

test('resolveSlots 与 SlotRegistry 串起来：卸载后裁决结果随之收敛（端到端形状）', () => {
  const reg = new SlotRegistry()
  reg.contributeFromManifest('editor-a', 'editor')
  reg.contributeFromManifest('editor-b', 'editor')
  let assignments = resolveSlots(reg.list(), ['editor-a', 'editor-b'])
  assert.deepEqual([...assignments[0]!.effective], ['editor-a'])
  assert.equal(conflictsOf(assignments).length, 1)

  // 模拟卸载 editor-a：贡献被回收 ⇒ 冲突消失，editor-b 接位
  reg.release('editor-a')
  assignments = resolveSlots(reg.list(), ['editor-a', 'editor-b'])
  assert.deepEqual([...assignments[0]!.effective], ['editor-b'])
  assert.deepEqual(conflictsOf(assignments), [], '竞品卸载后不应再报冲突')
})
