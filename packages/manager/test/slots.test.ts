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
  undeclaredSlots,
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

/* ---------------------- 跨包白名单：单一真源守卫 ---------------------- */

/**
 * ## 这条守卫的形状变过一次，值得留痕
 * 改造前：插槽白名单有**两份真源**——权威在 `packages/core`，镜像在
 * `packages/web/src/lib/slots.tsx`（web 不能 import core，因为 core 顶层 `import 'node:fs'`，
 * 进浏览器会炸）。手抄镜像会漂移，且漂移的表现是**静默的**：core 加了 `editor` 而 web 没加
 * ⇒ 后端登记了贡献、前端 `registerSlot` 却把它当未知插槽忽略 ⇒ 插件"激活了、管理台表里也有、
 * 界面上什么都没有"，而日志一片干净。
 *
 * 当时为"core 先加、web 后跟"这个合法中间状态留了一个 `PENDING_WEB_SYNC` 记账清单
 * （只允许变短，收敛后清空）。
 *
 * **现在镜像已经删除**：白名单拆到无 Node 依赖的 `packages/core/src/slots.ts`，
 * 开出 `@geewiki/core/slots` 子路径，web 侧两个文件一律**转出**同一份。
 * 于是"待同步"这个状态在**构造上**不再存在——记账清单随之删除。
 * 注意它是**被删掉**而不是被放宽：断言强度是升的，不是降的。
 *
 * 本守卫现在钉两件事：
 * ① web 侧**不得再本地定义**白名单（一旦回归就红）；
 * ② web 侧确实是从 `@geewiki/core/slots` 取的。
 *
 * 运行期**同一性**断言（`web.SLOT_NAMES === core.SLOT_NAMES`，副本无法伪装）在
 * `packages/web/test/slotPropsMirror.test.ts`——那里能同时 import 两侧模块。
 * 本包只能读源码：`slots.tsx` 求值期需要 `window`，node 下 import 不了。
 */

test('SlotName 白名单：web 侧必须是转出（不得再本地定义镜像）', () => {
  const root = findRepoRoot(fileURLToPath(import.meta.url))
  const webFile = join(root, 'packages/web/src/lib/slots.tsx')
  const source = readFileSync(webFile, 'utf8')

  assert.match(
    source,
    /from '@geewiki\/core\/slots'/,
    `${webFile} 必须从 '@geewiki/core/slots' 导入白名单（单一真源）。`,
  )

  // 剥注释后再查：注释里提到这些名字是允许的（本文件的说明就大量提到），定义不行
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const localDefs =
    /\bexport\s+(?:const|type|interface)\s+(SLOT_NAMES|SLOT_CARDINALITY|PLUGIN_SLOT_NAME|BuiltinSlotName|SlotName)\b\s*[=:]/g
  const hits = [...code.matchAll(localDefs)].map((m) => m[0].trim())
  assert.deepEqual(
    hits,
    [],
    `${webFile} 又本地定义了一份白名单：\n  ${hits.join('\n  ')}\n` +
      '完整白名单只能有一份，即 @geewiki/core/slots。手抄会漂移，且漂移是静默的：' +
      '后端登记了贡献、前端把它当未知插槽忽略 ⇒ 插件激活了、管理台表里也有、界面上什么都没有。',
  )

  // core 侧仍须覆盖基数表（同时防"解析正则失效 ⇒ 空集合 ⇒ 静默通过"）
  assert.ok(SLOT_NAMES.length > 0, 'core 白名单不得为空')
  assert.ok(SLOT_NAMES.includes('account-identities'), 'account-identities 必须在白名单里')
  assert.ok(SLOT_NAMES.includes('editor'), 'editor 必须在白名单里')
})

test('插槽基数表：覆盖白名单全部成员，且 editor 是单占用', () => {
  for (const slot of SLOT_NAMES) {
    assert.ok(SLOT_CARDINALITY[slot], `插槽 ${slot} 缺少基数声明`)
  }
  assert.equal(Object.keys(SLOT_CARDINALITY).length, SLOT_NAMES.length, '基数表有多余键或缺失键')
  assert.equal(SLOT_CARDINALITY.editor, 'single', 'editor 必须是单占用（两个编辑器同时渲染没有意义）')
  assert.equal(SLOT_CARDINALITY['app-header'], 'multi')
  assert.equal(SLOT_CARDINALITY['app-footer'], 'multi')
  // 编辑页工具条允许多个插件各挂一组按钮
  assert.equal(SLOT_CARDINALITY['editor-toolbar'], 'multi')
  // app-dock（常驻输入条）：两个同时存在同样不是丰富而是坏掉——屏幕底部叠两条一样的输入框
  assert.equal(SLOT_CARDINALITY['app-dock'], 'single')
})

test('resolveSlots：app-dock 单占用——两个助手类插件同时贡献时按激活顺序裁决并可见报告冲突', () => {
  /*
   * 这条用例原先用 `wiki-ask`（两个问答面板）。P8 拆掉那个插槽后，语义完全相同的位置
   * 只剩 `app-dock`——单占用裁决的**机制**没变，换的只是被裁决的插槽名。
   * 保留同一条用例而不是删掉它：单占用是"两个同时渲染就是坏掉"的兜底，
   * 没有它，两个助手插件会同时渲染两条输入条且不报任何错。
   */
  const out = resolveSlots([contrib('qa-a', 'app-dock'), contrib('qa-b', 'app-dock')], ['qa-b', 'qa-a'])
  const dock = out.find((x) => x.slot === 'app-dock')
  assert.ok(dock)
  assert.deepEqual([...dock.effective], ['qa-b'], '应按激活顺序最早者胜出，而非字典序')
  assert.deepEqual([...dock.suppressed], ['qa-a'])
  const conflicts = conflictsOf(out)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]?.slot, 'app-dock')
  assert.equal(conflicts[0]?.winner, 'qa-b')
})

test('resolveSlots：editor-toolbar 多占用全部生效（多个插件各挂一组按钮是允许的）', () => {
  const out = resolveSlots(
    [contrib('assist', 'editor-toolbar'), contrib('translate', 'editor-toolbar')],
    ['assist', 'translate'],
  )
  const toolbar = out.find((x) => x.slot === 'editor-toolbar')
  assert.ok(toolbar)
  assert.deepEqual([...toolbar.effective], ['assist', 'translate'])
  assert.deepEqual(conflictsOf(out), [])
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

/* ==================== A1：插件自定义扩展点（动态插槽） ==================== */

test('isSlotName：内置 ∪ 含 `/` 的自定义扩展点；不含 `/` 的未知名仍是笔误', () => {
  // 内置名
  assert.equal(isSlotName('editor'), true)
  assert.equal(isSlotName('account-identities'), true)
  // 自定义扩展点：至少一段 `/`
  assert.equal(isSlotName('my-plugin/toolbar'), true)
  assert.equal(isSlotName('a/b'), true)
  assert.equal(isSlotName('ns/sub/leaf'), true)
  // ✗ 关键：不含 `/` 又不在白名单里 ⇒ 仍被拒绝（这是"笔误可见"的落点，
  //   若哪天放宽成"任意字符串都合法"，这条会红——那正是守卫失效的信号）
  assert.equal(isSlotName('app-headr'), false, '内置名笔误必须仍被拒绝')
  assert.equal(isSlotName('nope'), false)
  // ✗ 语法非法的自定义名
  assert.equal(isSlotName('My-Plugin/Toolbar'), false, '大写不接受')
  assert.equal(isSlotName('/toolbar'), false, '空首段不接受')
  assert.equal(isSlotName('my-plugin/'), false, '空尾段不接受')
  assert.equal(isSlotName('my-plugin//x'), false, '空中间段不接受')
  assert.equal(isSlotName('my_plugin/x'), false, '下划线不接受')
  assert.equal(isSlotName('my-plugin/x y'), false, '空格不接受')
  assert.equal(isSlotName(42), false)
})

test('contribute：自定义扩展点被接受并登记（不再被当作未知插槽丢弃）', () => {
  const reg = new SlotRegistry()
  const off = reg.contribute('plugin-a', 'plugin-a/toolbar')
  assert.deepEqual(reg.list().map((c) => `${c.slot}:${c.owner}`), ['plugin-a/toolbar:plugin-a'])
  off()
  assert.deepEqual(reg.list(), [], '注销函数必须真的收回这条贡献')
})

test('define + resolveSlots：声明 single 的自定义扩展点按激活顺序裁决，冲突可见', () => {
  const reg = new SlotRegistry()
  reg.define('canvas-plugin', 'canvas-plugin/main', { cardinality: 'single' })
  // 两个插件都往这个扩展点贡献
  reg.contribute('canvas-plugin', 'canvas-plugin/main')
  reg.contribute('other-plugin', 'canvas-plugin/main')

  const assignments = resolveSlots(reg.list(), ['canvas-plugin', 'other-plugin'], reg.declarations())
  assert.equal(assignments.length, 1)
  assert.equal(assignments[0]!.cardinality, 'single')
  assert.deepEqual([...assignments[0]!.effective], ['canvas-plugin'], '激活顺序最早者胜出')
  assert.deepEqual([...assignments[0]!.suppressed], ['other-plugin'])

  const conflicts = conflictsOf(assignments)
  assert.equal(conflicts.length, 1, '单占用被多方声明必须产生可见的冲突诊断')
  assert.equal(conflicts[0]!.winner, 'canvas-plugin')
})

test('resolveSlots：未声明的自定义扩展点默认 multi（全部生效，不抑制）', () => {
  const reg = new SlotRegistry()
  reg.contribute('a', 'x/y')
  reg.contribute('b', 'x/y')
  const assignments = resolveSlots(reg.list(), ['a', 'b'], reg.declarations())
  assert.equal(assignments[0]!.cardinality, 'multi', '没声明过基数就按可叠加处理')
  assert.deepEqual([...assignments[0]!.effective], ['a', 'b'])
  assert.deepEqual(conflictsOf(assignments), [])
})

test('define：拒绝内置名 / 非法名 / 他人的重复声明（先声明者保留）', () => {
  const reg = new SlotRegistry()
  // 内置插槽的基数由 core 固定，不接受插件声明
  reg.define('p1', 'editor', { cardinality: 'single' })
  assert.deepEqual(reg.declarations(), [], '内置插槽名不得进入声明表')
  // 语法非法
  reg.define('p1', 'not-namespaced')
  assert.deepEqual(reg.declarations(), [])
  // 正常声明
  reg.define('p1', 'p1/slot', { cardinality: 'single', description: '主画布' })
  assert.deepEqual(
    reg.declarations().map((d) => `${d.slot}:${d.owner}:${d.cardinality}`),
    ['p1/slot:p1:single'],
  )
  assert.equal(reg.declarations()[0]!.description, '主画布')
  // 他人重复声明：先声明者保留（与 single 裁决同向：先来的有效，后来者可见地被拒）
  reg.define('p2', 'p1/slot', { cardinality: 'multi' })
  assert.deepEqual(reg.declarations().map((d) => d.owner), ['p1'], '重复声明不得改掉基数')
  // 自己重复声明：允许覆盖自己的声明
  reg.define('p1', 'p1/slot', { cardinality: 'multi' })
  assert.equal(reg.declarations()[0]!.cardinality, 'multi')
})

test('define：返回的撤销函数幂等，且 release(owner) 连带撤销声明', () => {
  const reg = new SlotRegistry()
  const off = reg.define('p1', 'p1/slot', { cardinality: 'single' })
  off()
  off() // 幂等
  assert.deepEqual(reg.declarations(), [])

  // release 必须把该 owner 的声明一起收走：否则插件卸载后仍占着扩展点名，
  // 别的插件永远声明不进来（且表现为"我明明声明了但基数没生效"）
  reg.define('p1', 'p1/slot', { cardinality: 'single' })
  reg.contribute('p1', 'p1/slot')
  reg.release('p1')
  assert.deepEqual(reg.declarations(), [], 'release 必须撤销该 owner 的声明')
  assert.deepEqual(reg.list(), [], 'release 必须撤销该 owner 的贡献')
})

test('list：自定义扩展点排在内置之后，且彼此按插槽名字典序（顺序稳定）', () => {
  const a = new SlotRegistry()
  a.contribute('z', 'zz/last')
  a.contribute('a', 'aa/first')
  a.contribute('m', 'editor')
  const b = new SlotRegistry()
  b.contribute('m', 'editor')
  b.contribute('a', 'aa/first')
  b.contribute('z', 'zz/last')
  const order = ['editor', 'aa/first', 'zz/last']
  assert.deepEqual(a.list().map((c) => c.slot), order, '内置在前，自定义按字典序')
  assert.deepEqual(
    b.list().map((c) => `${c.slot}:${c.owner}`),
    a.list().map((c) => `${c.slot}:${c.owner}`),
    '登记顺序不得影响输出顺序',
  )
})

test('declarations：按插槽名字典序输出（诊断/管理台展示顺序确定）', () => {
  const reg = new SlotRegistry()
  reg.define('p', 'zz/b')
  reg.define('p', 'aa/a')
  assert.deepEqual(reg.declarations().map((d) => d.slot), ['aa/a', 'zz/b'])
})

test('undeclaredSlots：只报"有贡献但无人声明"的**自定义**扩展点（内置名永不入列）', () => {
  const reg = new SlotRegistry()
  // 已声明 + 有贡献 ⇒ 不入列
  reg.define('p', 'p/declared', { cardinality: 'single' })
  reg.contribute('p', 'p/declared')
  // 未声明但有贡献 ⇒ 入列（这是"拼错命名空间"或"声明方还没迁到 define()"的信号）
  reg.contribute('q', 'q/undeclared')
  // 内置插槽 ⇒ 永不入列（它的基数由 core 固定，不需要谁声明）
  reg.contribute('r', 'editor')
  // 已声明但**无人贡献** ⇒ 也不入列（诊断的是"有贡献者却没人声明"，不是"空扩展点"）
  reg.define('s', 's/empty')

  const assignments = resolveSlots(reg.list(), ['p', 'q', 'r'], reg.declarations())
  assert.deepEqual(undeclaredSlots(assignments, reg.declarations()), ['q/undeclared'])
})

test('undeclaredSlots：命名空间拼错会被**分别**报出来（开放键空间的新失败模式）', () => {
  const reg = new SlotRegistry()
  reg.contribute('a', 'plugin-a/toolbar')
  reg.contribute('b', 'pulgin-a/toolbar') // 拼错：与上面那个永远碰不到一起
  const assignments = resolveSlots(reg.list(), ['a', 'b'], reg.declarations())
  assert.deepEqual(
    undeclaredSlots(assignments, reg.declarations()),
    ['plugin-a/toolbar', 'pulgin-a/toolbar'],
    '两个"看起来一样"的扩展点都会被报为未声明——这正是该诊断要让人看见的事',
  )
})

