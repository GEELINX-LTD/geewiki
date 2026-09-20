/**
 * 宿主节点目录（`src/extensions.ts`）的**自洽守卫**。
 *
 * ## 这个文件防的是什么
 * 目录是"插件声明了就能生效"的**承诺**：一个 id 只要在里面，插件就认为自己能贡献、
 * 能替换。因此目录最常见的两种坏法都是**静默**的：
 *
 * 1. **宿主节点 id 里出现了 `/`** —— 判据（不含 `/` ⇒ 宿主节点；含 `/` ⇒ 插件自定义）
 *    当场失效：插件可以"自证"成宿主节点，而拼错的宿主节点名再也无法被识别为笔误。
 * 2. **同一个事实写了两份** —— 插槽基数（`SLOT_CARDINALITY`）在目录里再抄一遍，
 *    两边漂移后的表现是"后端按单占用裁决、前端按可叠加渲染"，日志干净。
 *
 * 因此本文件既断言"形状合法"，也断言"**没有第二份真源**"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EXT_MODE,
  EXT_MODES,
  HOST_NODE_CATALOG,
  HOST_NODE_NAMES,
  extModesOf,
  extendCardinalityOf,
  hostNodeSpec,
  isExtName,
  isHostNodeName,
  modeCardinalityOf,
  nestedSlotsOf,
  supportsExtMode,
  type ExtMode,
} from '../src/extensions.js'
import { SLOT_NAMES } from '../src/slots.js'

const SPECS = Object.entries(HOST_NODE_CATALOG)

test('目录非空且规模合理（防"解析坏了两边都空 ⇒ 通过"）', () => {
  assert.ok(SPECS.length >= 7, `目录条目过少（${SPECS.length}），疑似目录被清空或声明成非对象`)
  assert.equal(HOST_NODE_NAMES.length, SPECS.length, 'HOST_NODE_NAMES 与目录键数不一致')
  assert.deepEqual([...HOST_NODE_NAMES], SPECS.map(([k]) => k), 'HOST_NODE_NAMES 顺序应与目录声明顺序一致')
})

test('宿主节点 id 一律小写连字符、且不含 `/`（判据的硬前提）', () => {
  const bad = SPECS.map(([id]) => id).filter((id) => !/^[a-z][a-z0-9-]*$/.test(id))
  assert.deepEqual(
    bad,
    [],
    '以下宿主节点 id 不合法。必须是 `^[a-z][a-z0-9-]*$`：**不含 `/`** 是判据的硬前提——' +
      '宿主名里一旦出现 `/`，"插件自定义扩展点"与"拼错的宿主节点名"就无法区分了：\n  ' + bad.join('\n  '),
  )
})

test('每个节点的 modes 合法：非空、必含 extend、无重复、都是已知模式', () => {
  const problems: string[] = []
  for (const [id, spec] of SPECS) {
    if (spec.modes.length === 0) problems.push(`${id}: modes 为空`)
    if (!spec.modes.includes('extend')) problems.push(`${id}: modes 不含 'extend'（追加永远应当合法）`)
    if (new Set(spec.modes).size !== spec.modes.length) problems.push(`${id}: modes 有重复项`)
    for (const mode of spec.modes) {
      if (!EXT_MODES.includes(mode)) problems.push(`${id}: 未知模式 ${String(mode)}`)
    }
  }
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`)
})

test('replace / wrap 的开放口径是一条规则，不是"哪个节点被点名"', () => {
  /*
   * 口径（设计文档 §3）：
   * - `kind: 'ui'` / `kind: 'shell'` / `kind: 'page'`：叶子元素，三种模式全开；
   * - **`portal: true` 的 ui 节点**：**不含 `wrap`** —— 宿主的默认实现渲染在 portal 里、
   *   **不在包装元素的 DOM 子树内**，包装元素既包不住它也传不进样式（跨不过 portal 边界）
   *   ⇒ 那是静默失效，不是"少个能力"。`replace`（接管渲染）与 `extend`（在调用处追加，
   *   看得见、位置可预期）仍然成立。
   * - `kind: 'slot'`：**单占用**的（editor / app-dock / article-summary）允许整体替换，
   *   **多占用**的（app-header / app-footer / editor-toolbar / account-identities）
   *   只允许追加——它们的价值就在于"多方共存"，替换掉等于宿主不再有那个语义。
   *
   * 写成规则而不是名单：名单每加一个节点就要改一次（P5/P6/P7 各改过一次），
   * 而规则能同时钉住"新节点的默认待遇"——这才是守卫该做的事。
   */
  const problems: string[] = []
  for (const [id, spec] of SPECS) {
    const has = (m: ExtMode): boolean => spec.modes.includes(m)
    if (spec.portal === true) {
      if (spec.kind !== 'ui') problems.push(`${id}：portal 标记只能出现在 kind: 'ui' 上`)
      if (has('wrap')) {
        problems.push(
          `${id}（portal）不得允许 wrap——宿主默认实现在 portal 里，包装元素的子树装不下它，` +
            '样式与作用域都进不去 ⇒ 静默失效',
        )
      }
      if (!has('replace')) problems.push(`${id}（portal）应当允许 replace：接管渲染，真正能生效且自由度最高`)
    } else if (spec.kind === 'ui' || spec.kind === 'shell' || spec.kind === 'page') {
      if (!has('replace') || !has('wrap')) problems.push(`${id}（${spec.kind}）应当允许 replace 与 wrap`)
    } else if (spec.kind === 'slot') {
      const single = extendCardinalityOf(id) === 'single'
      if (single && (!has('replace') || !has('wrap'))) problems.push(`${id}（单占用插槽）应当允许 replace 与 wrap`)
      if (!single && (has('replace') || has('wrap'))) {
        problems.push(`${id}（多占用插槽）不得允许 replace / wrap——它的价值是多方共存`)
      }
    }
  }
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`)

  // 非空洞自证：三类"允许 / 不允许"都必须真的存在（否则上面每条 if 都可能恒不触发）
  assert.ok(SPECS.some(([, s]) => s.modes.includes('replace')), '应当存在允许 replace 的节点')
  assert.ok(SPECS.some(([, s]) => !s.modes.includes('replace')), '应当存在不允许 replace 的节点')
  assert.ok(SPECS.some(([, s]) => s.portal === true), '应当存在 portal 节点（否则 portal 那条规则恒不触发）')
  assert.ok(
    SPECS.some(([, s]) => s.kind === 'ui' && s.portal !== true && s.modes.includes('wrap')),
    '应当存在**非 portal** 的 ui 节点且允许 wrap（反向对照）',
  )
})

test('kind: "slot" 的条目不得自带 extendCardinality（基数唯一真源是 SLOT_CARDINALITY）', () => {
  const problems = SPECS.filter(([, s]) => s.kind === 'slot' && s.extendCardinality !== undefined).map(([id]) => id)
  assert.deepEqual(
    problems,
    [],
    '以下插槽条目在目录里又写了一份基数。基数真源是 `SLOT_CARDINALITY`（packages/core/src/slots.ts:138），' +
      '两处各写一份必然漂移，漂移的表现是"后端按单占用裁决、前端按可叠加渲染"：\n  ' + problems.join('\n  '),
  )
})

test('nestedSlots 只出现在非 slot 条目上（插槽套插槽没有语义）', () => {
  const problems = SPECS.filter(([, s]) => s.kind === 'slot' && s.nestedSlots !== undefined).map(([id]) => id)
  assert.deepEqual(
    problems,
    [],
    '"内层出口"是**容器节点**的概念（宿主独占的外壳元素里嵌着一个多方共存的插槽出口）：\n  ' + problems.join('\n  '),
  )
})

test('nestedSlots：每项都是内置插槽名、不重复，且该节点确实开放 replace', () => {
  for (const [id, spec] of SPECS) {
    const nested = spec.nestedSlots
    if (nested === undefined) continue
    assert.ok(nested.length > 0, `${id} 的 nestedSlots 是空数组——等价于没声明，直接删掉这个字段`)
    assert.equal(new Set(nested).size, nested.length, `${id} 的 nestedSlots 有重复项：${nested.join('、')}`)
    for (const slot of nested) {
      assert.ok(
        (SLOT_NAMES as readonly string[]).includes(slot),
        `${id} 的内层出口 ${slot} 不是内置插槽名——内层出口必须是**宿主自己渲染**的插槽（多方共存），` +
          '插件自定义扩展点不在此列',
      )
    }
    /*
     * 为什么要求开放 `replace`：这条机制**只为**"容器节点被单方替换时，其他插件的贡献不能消失"
     * 而存在（用户当场驳回的缺陷）。不开放 replace/wrap 的节点声明它，只会让 `props.slots`
     * 里多出一个没人能用的挂载点。
     */
    assert.ok(
      spec.modes.includes('replace'),
      `${id} 声明了 nestedSlots 却没开放 replace —— 这条机制就没有保护对象了`,
    )
  }
})

test('nestedSlotsOf：已知容器节点返回声明值；未知 / 畸形输入返回空数组', () => {
  assert.deepEqual(nestedSlotsOf('shell-header'), ['app-header'])
  assert.deepEqual(nestedSlotsOf('shell-footer'), ['app-footer'])
  assert.deepEqual(nestedSlotsOf('ui-button'), [], '非容器节点没有内层出口')
  assert.deepEqual(nestedSlotsOf('app-header'), [], '插槽本身不是容器')
  assert.deepEqual(nestedSlotsOf(undefined), [])
  assert.deepEqual(nestedSlotsOf(42), [])
  assert.deepEqual(nestedSlotsOf('no/such-node'), [])
})

test('kind: "slot" 的 id 必须正好是内置插槽名（不能多、不能少）', () => {  const slotIds = SPECS.filter(([, s]) => s.kind === 'slot').map(([id]) => id).sort()
  const expected = [...SLOT_NAMES].sort()
  assert.deepEqual(
    slotIds,
    expected,
    '目录里 kind 为 slot 的条目与 SLOT_NAMES 不一致。两者必须严格对应——' +
      '插槽名单是公开契约（有守卫测试），目录是它泛化后的外壳。',
  )
})

test('非 slot 条目不得与内置插槽重名（否则同一 id 有两种 kind 语义）', () => {
  const clash = SPECS.filter(([id, s]) => s.kind !== 'slot' && SLOT_NAMES.includes(id as never)).map(([id]) => id)
  assert.deepEqual(clash, [], `以下 id 同时是内置插槽名与非 slot 节点：${clash.join(', ')}`)
})

test('propsVersion 是正整数（0 会被插件误判成"未声明"）', () => {
  const bad = SPECS.filter(([, s]) => !Number.isInteger(s.propsVersion) || s.propsVersion < 1).map(([id]) => id)
  assert.deepEqual(bad, [], `以下节点的 propsVersion 不是正整数：${bad.join(', ')}`)
})

test('每个节点都有面向人的 description（管理台与诊断端点要展示它）', () => {
  const bad = SPECS.filter(([, s]) => typeof s.description !== 'string' || s.description.trim().length < 4).map(([id]) => id)
  assert.deepEqual(bad, [], `以下节点缺少可读说明：${bad.join(', ')}`)
})

test('extendCardinalityOf：插槽取 SLOT_CARDINALITY，未知节点按 multi', () => {
  // 与真源逐条比对，而不是与"我记忆里的值"比对
  for (const id of SLOT_NAMES) {
    const single = ['editor', 'app-dock', 'article-summary']
    const expected = single.includes(id) ? 'single' : 'multi'
    assert.equal(extendCardinalityOf(id), expected, `${id} 的 extend 基数与 SLOT_CARDINALITY 不一致`)
  }
  assert.equal(extendCardinalityOf('no-such-node'), 'multi', '未知节点应按 multi 处理（判错方向更安全）')
})

test('modeCardinalityOf：replace / wrap 恒为 single，extend 随节点', () => {
  for (const [id, spec] of SPECS) {
    for (const mode of spec.modes) {
      const got = modeCardinalityOf(id, mode)
      const expected = mode === 'extend' ? extendCardinalityOf(id) : 'single'
      assert.equal(got, expected, `${id} / ${mode} 的基数错了`)
    }
  }
  // 反向对照：确认"恒为 single"不是我把所有情况都写成 single 的空洞断言
  assert.equal(modeCardinalityOf('app-header', 'extend'), 'multi')
  assert.equal(modeCardinalityOf('editor', 'extend'), 'single')
})

test('查询函数对未知/畸形输入不抛错（诊断端点要能容忍旧插件声明）', () => {
  // 注：'shell-brand' 曾经是这条断言里的"未知名占位"，P5 接线后它成了真节点——
  // 于是改用一个**真的不存在**的名字（这正是守卫该红的信号：目录长大了，占位名要换）。
  for (const weird of ['', 'app-headr', 'shell-brandd', 'ui-buton', 'AI/x', 'a//b', '../../../etc', '-x']) {
    assert.equal(isHostNodeName(weird), false, `isHostNodeName(${JSON.stringify(weird)}) 应为 false`)
    assert.equal(hostNodeSpec(weird), undefined)
    assert.deepEqual(extModesOf(weird), [])
    assert.equal(supportsExtMode(weird, 'extend'), false)
    assert.equal(extendCardinalityOf(weird), 'multi')
  }
  for (const weird of [null, undefined, 42, {}, []]) {
    assert.equal(isHostNodeName(weird), false)
    assert.equal(isExtName(weird), false)
  }
})

test('isExtName = 宿主节点 ∪ 插件自定义扩展点（且笔误仍被挡下）', () => {
  // 宿主侧
  for (const id of HOST_NODE_NAMES) assert.equal(isExtName(id), true, `${id} 是宿主节点，应被接受`)
  // 插件侧：语法沿用 PLUGIN_SLOT_NAME（至少一段 `/`）
  for (const ok of ['ai-assistant/answer-actions', 'my-plugin/toolbar', 'a/b/c']) {
    assert.equal(isExtName(ok), true, `${ok} 是合法的插件自定义扩展点，应被接受`)
  }
  // 笔误与畸形：既不在目录里、又不含 `/`
  for (const bad of ['app-headr', 'shell-brandd', 'Shell-Brand', 'app__header', 'app-header/']) {
    assert.equal(isExtName(bad), false, `${bad} 不应被接受（它既不是宿主节点，也不是合法的自定义扩展点名）`)
  }
})

test('★ 插件自定义扩展点只允许 extend（宿主不为别人的扩展点背书 replace/wrap）', () => {
  /*
   * 这条断言来自一次真实缺陷：`extModesOf` 起初对"不在目录里的名字"一律返回空数组，
   * 而 manager 的新校验（`supportsExtMode`）据此把**所有**自定义扩展点的贡献都拒掉了
   * ——既有测试立刻变红 6 条（`contribute('plugin-a', 'plugin-a/toolbar')` 登记不上）。
   * 教训：把"允许的模式"为空 与 "这个节点不存在" 混为一谈，会把一个正常通路整条关掉。
   */
  for (const name of ['plugin-a/toolbar', 'a/b/c']) {
    assert.deepEqual(extModesOf(name), ['extend'], `${name} 应只允许 extend`)
    assert.equal(supportsExtMode(name, 'extend'), true)
    assert.equal(supportsExtMode(name, 'replace'), false)
    assert.equal(supportsExtMode(name, 'wrap'), false)
  }
  // 反向对照：畸形名字连 extend 都不允许（否则"未知节点"与"非法名字"又混成一类）
  assert.deepEqual(extModesOf('app-headr'), [])
  assert.equal(supportsExtMode('app-headr', 'extend'), false)
  // 宿主节点则按目录授权
  assert.deepEqual(extModesOf('editor'), ['extend', 'wrap', 'replace'])
  assert.deepEqual(extModesOf('app-header'), ['extend'])
})

test('DEFAULT_EXT_MODE / EXT_MODES 自洽', () => {
  assert.deepEqual([...EXT_MODES], ['replace', 'wrap', 'extend'], 'EXT_MODES 顺序 = 应用顺序（replace→wrap→extend）')
  assert.equal(DEFAULT_EXT_MODE, 'extend')
  assert.ok(EXT_MODES.includes(DEFAULT_EXT_MODE))
  // 所有出现的模式都必须在 EXT_MODES 里（防新增模式只改了类型）
  const used = new Set<ExtMode>(SPECS.flatMap(([, s]) => [...s.modes]))
  for (const mode of used) assert.ok(EXT_MODES.includes(mode), `目录里用了未登记的模式 ${mode}`)
})
