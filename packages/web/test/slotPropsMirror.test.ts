/**
 * 插槽契约的**三处镜像守卫**（`editor-toolbar` / `app-dock` / `article-summary` 之后扩出来的一份）。
 *
 * ## 为什么单开一份，而不是塞进 `editorSlotProps.test.ts`
 * 那份守卫只管 `EditorSlotProps` 一个接口。本批把"带数据的插槽"从 1 个变成 3 个，
 * 再往那个函数名/文件名里塞第二个接口会让它的名字说谎；且这里还要管**两份**插槽白名单
 * 副本（`slots.tsx` 与 `pluginUiPlan.ts`——后者为了能进 node 纯函数测试连 react 都不能引）。
 *
 * ## 防的是同一类事故
 * 这些声明任何一侧漏改都是**运行期静默**：
 * - 白名单少一个名字 ⇒ 后端登记了插槽、前端 `isSlotName` 判假并**忽略注册**，插件界面凭空不出现，
 *   只在 console 留一条 warn；
 * - props 少一个字段 ⇒ 插件读到 `undefined`，不报错、只是功能缺一块；
 * - `SINGLE_OCCUPANCY_SLOTS` 与 core 的 `SLOT_CARDINALITY` 漂移 ⇒ 前端认为可叠加而后端已把
 *   第二个声明者判为被抑制（或反过来），单占用位置出现两个面板 / 该出现的没出现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function findRepoRoot(start: string): string {
  let cur = start
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
  throw new Error(`未能从 ${start} 向上找到仓库根（pnpm-workspace.yaml）`)
}

const root = findRepoRoot(here)
/** core 的 `index.ts`：**props / 路由契约**的真源（`EditorSlotProps`、`PluginRouteDecl` 等）。 */
const CORE_FILE = join(root, 'packages/core/src/index.ts')
/**
 * core 的 `slots.ts`：**插槽白名单与基数**的单一真源（本次改造从 `index.ts` 拆出来）。
 *
 * 为什么必须与 `CORE_FILE` 分开：白名单原先长在 `index.ts` 里，而 `index.ts` 顶层
 * `import 'node:fs'` 进不了浏览器 bundle —— 那正是 web 必须手抄镜像的**唯一**原因。
 * 拆到无 Node 依赖的 `slots.ts` 并开出 `@geewiki/core/slots` 子路径后，镜像全部删除。
 */
const CORE_SLOTS_FILE = join(root, 'packages/core/src/slots.ts')
const SLOTS_FILE = join(root, 'packages/web/src/lib/slots.tsx')
const PLAN_FILE = join(root, 'packages/web/src/lib/pluginUiPlan.ts')

const read = (file: string): string => readFileSync(file, 'utf8')

/* ============================ 源码级解析小工具 ============================ */

/** 从 `start` 处起做花括号配平，返回接口体（不含最外层花括号） */
function braceBody(source: string, start: number, file: string, label: string): string {
  const bodyStart = source.indexOf('{', start)
  assert.ok(bodyStart >= 0, `${file}：找不到 ${label} 的起始花括号（结构变了即红，不允许静默通过）`)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(bodyStart + 1, i)
    }
  }
  throw new Error(`${file}：${label} 的花括号未配平`)
}

interface FieldShape {
  name: string
  optional: boolean
  readonly: boolean
}

/** 解析 `export interface <Name> { … }` 的字段形状（属性 + 可选属性 + 方法 + 可选方法） */
function parseInterface(source: string, file: string, name: string): FieldShape[] {
  const marker = `export interface ${name} {`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `${file}：未找到 ${marker}（重命名或删除即红）`)
  let body = braceBody(source, start, file, name)
  // 剥掉块注释与行注释：JSDoc 里出现的 `foo?: string` 不是字段
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const fields: FieldShape[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const prop = /^(readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/.exec(line)
    const method = /^([A-Za-z_$][\w$]*)(\?)?\s*\(/.exec(line)
    if (prop) {
      fields.push({ name: prop[2] as string, optional: prop[3] === '?', readonly: prop[1] !== undefined })
    } else if (method) {
      fields.push({ name: method[1] as string, optional: method[2] === '?', readonly: false })
    }
  }
  assert.ok(fields.length > 0, `${file}：${name} 解析出的字段为空（正则失效或接口被清空）`)
  return fields
}

/** 解析 `export const SLOT_NAMES: readonly SlotName[] = [ … ]` 里的字面量 */
function parseSlotNames(source: string, file: string): string[] {
  const match = /export const SLOT_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(source)
  assert.ok(match, `${file}：未解析出 SLOT_NAMES 数组字面量`)
  const names = [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
  assert.ok(names.length > 0, `${file}：SLOT_NAMES 解析为空`)
  return names
}

/* ============================ ① 插槽白名单三处镜像 ============================ */

test('SLOT_NAMES：web 侧与 core 是**同一个对象**（同一性守卫，副本无法伪装）', async () => {
  /*
   * 判据从"逐元素相等"升级为"**引用同一性**"，因为镜像已经删除：
   * `slots.tsx` / `pluginUiPlan.ts` 现在只是把 `@geewiki/core/slots` 的导出转出。
   *
   * 为什么同一性严格强于相等：**副本无法伪装成同一个对象**。谁要是图省事再抄一份字面量数组，
   * 哪怕内容一字不差，`===` 也立刻为 false；而"内容相等"的断言在那一刻是**通过**的 ——
   * 它只在**漂移发生之后**才红，那时线上已经出过事故了。
   *
   * `slots.tsx` 不能在 node 下 import（它引 react 与插件加载器，模块求值期用到 `window`），
   * 故对它只做源码级断言 —— 「不得本地定义白名单」由
   * `packages/core/test/slots-browser-safe.test.ts` 钉住。
   */
  const core = await import('@geewiki/core/slots')
  const plan = await import('../src/lib/pluginUiPlan')
  assert.equal(
    plan.SLOT_NAMES,
    core.SLOT_NAMES,
    'pluginUiPlan.ts 的 SLOT_NAMES 必须是 core 的**同一个对象**（不是内容相等）',
  )
  assert.equal(
    plan.PLUGIN_SLOT_NAME,
    core.PLUGIN_SLOT_NAME,
    'pluginUiPlan.ts 的 PLUGIN_SLOT_NAME 必须是 core 的**同一个对象**',
  )
  // 源码解析与运行期值互证：解析正则失效时立即红，不会退化成"两边都空 ⇒ 通过"
  assert.deepEqual(
    parseSlotNames(read(CORE_SLOTS_FILE), CORE_SLOTS_FILE),
    [...core.SLOT_NAMES],
    `core ${CORE_SLOTS_FILE} 源码解析出的白名单与运行期导出不一致`,
  )
})

test('后加的插槽确实在白名单里（防止改名后守卫空转）', () => {
  const core = parseSlotNames(read(CORE_SLOTS_FILE), CORE_SLOTS_FILE)
  for (const slot of ['editor-toolbar', 'app-dock', 'article-summary']) {
    assert.ok(core.includes(slot), `core 白名单缺少 ${slot}`)
  }
  /*
   * `wiki-ask` 在 P8 被拆除（决策 17）。这条**反向**断言不是形式主义：白名单是"三处镜像
   * 逐元素相等"的比对对象，如果有人在某一处把它加回来而另两处没加，那种漂移会被上面的
   * 相等断言抓到；而如果有人三处一起加回来，只有这条会红——它钉的是决策本身，不是镜像。
   */
  assert.ok(!core.includes('wiki-ask' as never), 'wiki-ask 已在 P8 拆除，不得回到白名单')
})

/* ============================ ② 单占用集合 ↔ core 基数表 ============================ */

/** 从 core 源码里解析 `SLOT_CARDINALITY` 的键与值（键可能带引号，也可能是裸标识符如 `editor:`） */
function parseCardinality(source: string, file: string): Map<string, string> {
  const start = source.indexOf('export const SLOT_CARDINALITY')
  assert.ok(start >= 0, `${file}：未找到 SLOT_CARDINALITY`)
  const body = braceBody(source, start, file, 'SLOT_CARDINALITY')
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(?:'([a-zA-Z-]+)'|([A-Za-z_$][\w$]*))\s*:\s*'([a-z]+)'/g)) {
    out.set((m[1] ?? m[2]) as string, m[3] as string)
  }
  assert.ok(out.size > 0, `${file}：SLOT_CARDINALITY 解析为空（正则失效即红）`)
  // 基数表必须覆盖白名单全部成员（漏键 = 该插槽没有基数声明）
  assert.deepEqual(
    [...out.keys()].sort(),
    [...parseSlotNames(source, file)].sort(),
    `${file}：SLOT_CARDINALITY 的键与 SLOT_NAMES 不等`,
  )
  return out
}

test('单占用插槽集合：web 的 SINGLE_OCCUPANCY_SLOTS 必须由 core 基数表**现算**（不得手抄）', () => {
  const cardinality = parseCardinality(read(CORE_SLOTS_FILE), CORE_SLOTS_FILE)
  const coreSingle = [...cardinality].filter(([, v]) => v === 'single').map(([k]) => k)
  const slotsSource = read(SLOTS_FILE)
  /*
   * 判据从"两边内容相等"换成"**它必须是算出来的**"。
   * 原先 web 手抄了 `['editor','app-dock','article-summary']`，与 core 的基数表是同一事实的
   * 两份副本；现在它由 `SLOT_NAMES.filter(n => SLOT_CARDINALITY[n] === 'single')` 现算，
   * 漂移在**构造上**就不可能发生。故这里钉的是那条构造本身，而不是它的当前取值。
   */
  assert.match(
    slotsSource,
    /export const SINGLE_OCCUPANCY_SLOTS[^=]*=\s*SLOT_NAMES\.filter\(/,
    `${SLOTS_FILE}：SINGLE_OCCUPANCY_SLOTS 必须由 core 的 SLOT_CARDINALITY 现算，不得再手抄字面量。`,
  )
  assert.doesNotMatch(
    slotsSource,
    /export const SINGLE_OCCUPANCY_SLOTS[^=]*=\s*\[/,
    `${SLOTS_FILE}：SINGLE_OCCUPANCY_SLOTS 又变回了字面量数组 —— 那会与 core 的基数表漂移。`,
  )
  assert.ok(coreSingle.includes('editor') && coreSingle.includes('app-dock'), 'editor 与 app-dock 必须是单占用')
  assert.equal(cardinality.get('editor-toolbar'), 'multi', 'editor-toolbar 必须允许多个插件各挂一组按钮')
})

/* ============================ ③ 带数据插槽的 props 镜像 ============================ */

const MIRRORED_INTERFACES: readonly { name: string; required: readonly string[] }[] = [
  // 写回通道**必须是可选**（editor 被插件编辑器占住时宿主没有那个通道）——故 required 里不含它们
  { name: 'EditorToolbarSlotProps', required: ['mode', 'slug', 'docText', 'selection'] },
  { name: 'EditorToolbarSelection', required: ['text', 'from', 'to'] },
  // app-dock：四个字段**都是必需**的。page 可以**为 null**，但字段本身不能缺——
  // "没有当前页"与"宿主忘了传 page"是两件事，后者必须由类型挡住（插件无从区分二者）。
  { name: 'AppDockSlotProps', required: ['page', 'clientTools', 'userId', 'openPage', 'invokeTool'] },
  // article-summary：两个字段都是必需的。摘要的**内容**不在这里（那是插件服务端的答案），
  // 宿主只给"这是哪一页、它叫什么"——少传 slug 的症状是摘要在所有页面上都不出现且不报错。
  { name: 'ArticleSummarySlotProps', required: ['slug', 'title'] },
]

for (const { name, required } of MIRRORED_INTERFACES) {
  test(`${name} 镜像：core 与 web 两侧字段名/可选性/readonly 逐个相等`, () => {
    const coreFields = parseInterface(read(CORE_FILE), CORE_FILE, name)
    const webFields = parseInterface(read(SLOTS_FILE), SLOTS_FILE, name)
    assert.deepEqual(
      webFields,
      coreFields,
      `${name} 两侧镜像漂移（字段名/可选性/readonly）。\n` +
        `core=${JSON.stringify(coreFields)}\nweb=${JSON.stringify(webFields)}\n` +
        'web 不能 import core，只能镜像——漂移的症状是运行期静默：宿主不传该字段，插件读到 undefined 且不报错。',
    )
    for (const field of required) {
      assert.ok(
        coreFields.some((f) => f.name === field && !f.optional),
        `${name} 的必需字段 ${field} 缺失或变成了可选——契约被削弱`,
      )
    }
  })
}

test('EditorToolbarSlotProps：写回通道是可选方法（不是永远存在的空函数）', () => {
  const fields = parseInterface(read(CORE_FILE), CORE_FILE, 'EditorToolbarSlotProps')
  for (const channel of ['insertAtCursor', 'replaceSelection']) {
    const field = fields.find((f) => f.name === channel)
    assert.ok(field, `core 的 EditorToolbarSlotProps 缺少写回通道 ${channel}`)
    assert.equal(field.optional, true, `${channel} 必须可选：无内置编辑器在场时它不存在`)
  }
})

/* ============================ ④ 懒加载判据覆盖新插槽 ============================ */

test('isLazyOnlyEntry：新插槽也走按需加载，header/footer 仍首屏加载', async () => {
  const mod = await import('../src/lib/pluginUiPlan')
  const lazy = (slots?: string[]) =>
    mod.isLazyOnlyEntry({ entry: 'client.js', rev: 'x', ...(slots ? { slots: slots as never } : {}) })
  assert.equal(lazy(['editor']), true)
  assert.equal(lazy(['editor-toolbar']), true, '编辑页工具条只随编辑视图加载')
  assert.equal(lazy(['editor-toolbar', 'article-summary']), true, '两个按需插槽的组合仍可推迟')
  /*
   * `app-dock` 虽然**每页都在**，仍必须归按需插槽。
   *
   * 这条断言钉的是决策 5 的机械前提：匿名用户不渲染 dock ⇒ 宿主不调
   * `ensureSlotLoaded('app-dock')` ⇒ 不下载聊天 bundle。若有人把它从
   * ON_DEMAND_SLOTS 里拿掉（理由是"它反正每页都要"），这一行会红——
   * 而那个改动的后果是**匿名读者的首屏开始下载一整套 AI bundle**，
   * 恰恰是设计文档 §5.2 想避免的事，且不会有任何其它测试发现。
   */
  assert.equal(lazy(['app-dock']), true, '常驻 dock 仍归按需插槽（宿主按登录态决定要不要）')
  assert.equal(lazy(['app-dock', 'editor']), true, '两个按需插槽的组合仍可推迟')
  assert.equal(lazy(['app-header']), false, '首屏就渲染的插槽不得推迟')
  assert.equal(lazy(['app-dock', 'app-header']), false, '混了首屏插槽就整包不推迟（判据的已知边界）')
  assert.equal(lazy(['article-summary', 'app-footer']), false, '混了首屏插槽就整包不推迟（判据的已知边界）')
  assert.equal(lazy(undefined), false, '没声明插槽的纯浏览器侧注册不推迟')
})

/* ============ ⑤ A1：插件自定义扩展点（动态插槽）——镜像与判据 ============ */

/** 从某文件里解析 `export const SLOT_NAMES…= [ … ]` 的字面量成员 */
function slotNamesOf(file: string): string[] {
  const match = /export const SLOT_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(read(file))
  assert.ok(match, `未能从 ${file} 解析出 SLOT_NAMES 数组字面量（正则失效即红，不允许静默通过）`)
  const names = [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
  assert.ok(names.length > 0, `${file} 解析出的白名单为空（正则有误或白名单被清空）`)
  return names
}

test('内置白名单：web 侧与 core 是**同一个对象**（同一性守卫，副本无法伪装）', async () => {
  /*
   * 为什么这条在 A1 之后**必须加上**：原先 `slots.tsx` 与 `pluginUiPlan.ts` 的一致性
   * 靠**调用链触发的 TS2345**（少写成员就编译失败）。A1 把 `SlotName` 放宽成
   * `BuiltinSlotName | (string & {})` 之后两边都等价于 `string`，**那条编译器守卫静默失效了**，
   * 于是补了一对 `Expect<A extends B>` 编译期断言。
   *
   * **本批把镜像整个删掉之后，那对断言也一并删除**：不再有第二份事实要同步。
   * 现在的守卫是同一性 —— `pluginUiPlan.ts` 转出的必须就是 core 那个对象。
   * `slots.tsx` 无法在 node 下 import，其"不得本地定义白名单"由 core 的
   * `slots-browser-safe.test.ts` 做源码级断言。
   */
  const core = await import('@geewiki/core/slots')
  const plan = await import('../src/lib/pluginUiPlan')
  assert.equal(
    plan.SLOT_NAMES,
    core.SLOT_NAMES,
    'pluginUiPlan.ts 的 SLOT_NAMES 必须是 core 的**同一个对象**（不是内容相等）',
  )
  // core 侧仍做源码级断言：白名单**必须**长在 slots.ts 里，且非空
  const coreNames = slotNamesOf(CORE_SLOTS_FILE)
  assert.ok(coreNames.length > 0, 'core 白名单不得为空（正则有误或白名单被清空）')
  assert.ok(coreNames.includes('account-identities'), 'account-identities 必须在白名单里')
})

test('PLUGIN_SLOT_NAME：web 侧与 core 是**同一个对象**', async () => {
  const core = await import('@geewiki/core/slots')
  const plan = await import('../src/lib/pluginUiPlan')
  assert.equal(
    plan.PLUGIN_SLOT_NAME,
    core.PLUGIN_SLOT_NAME,
    'pluginUiPlan.ts 的 PLUGIN_SLOT_NAME 必须是 core 的**同一个对象** —— ' +
      '不一致的症状是"后端接受、前端忽略"（或反之），插件界面凭空不出现且只在 console 留一条 warn。',
  )
  // 源码解析与运行期值互证
  const m = /export const PLUGIN_SLOT_NAME\s*=\s*(\/.*?\/[a-z]*)\s*$/m.exec(read(CORE_SLOTS_FILE))
  assert.ok(m, `未能从 ${CORE_SLOTS_FILE} 解析出 PLUGIN_SLOT_NAME 字面量（正则失效即红）`)
  assert.equal(new RegExp((m[1] as string).slice(1, (m[1] as string).lastIndexOf('/'))).source, core.PLUGIN_SLOT_NAME.source)
})

test('PLUGIN_SLOT_NAME：含 `/` 才合法，逐段小写 kebab；内置名笔误不得漏过', () => {
  // 直接以 core 源码里那一份正则构造（web 侧已由上面的同一性断言钉住是同一个对象）
  const src = read(CORE_SLOTS_FILE)
  const m = /export const PLUGIN_SLOT_NAME\s*=\s*(\/.*?\/[a-z]*)\s*$/m.exec(src)
  assert.ok(m, '未能解析出 PLUGIN_SLOT_NAME')
  const re = new RegExp((m[1] as string).slice(1, (m[1] as string).lastIndexOf('/')))

  for (const ok of ['my-plugin/toolbar', 'a/b', 'ns/sub/leaf']) {
    assert.equal(re.test(ok), true, `${ok} 应当是合法的自定义扩展点名`)
  }
  /*
   * ★ 最重要的一条：内置名的**笔误**必须落在"既不是内置、也不是合法自定义名"的区间里，
   *   否则放宽键空间就把"拼错插槽名"的可见性一起弄丢了（表现为界面莫名少一块、无任何提示）。
   *   `app-headr` 不含 `/` ⇒ 不匹配自定义名语法 ⇒ 与非白名单名一起被拒绝并告警。
   */
  for (const bad of ['app-headr', 'editor-toolbarx', 'My-Plugin/Toolbar', '/x', 'x/', 'x//y', 'x_y/z']) {
    assert.equal(re.test(bad), false, `${bad} 不得被当作合法自定义扩展点名`)
  }
})

test('isLazyOnlyEntry：只贡献自定义扩展点的插件**不推迟**（宿主无法预知它何时被渲染）', async () => {
  const mod = await import('../src/lib/pluginUiPlan')
  const lazy = (slots: string[]) =>
    mod.isLazyOnlyEntry({ entry: 'client.js', rev: 'x', slots: slots as never })
  /*
   * 自定义扩展点由**别的插件**在它自己的界面里渲染，宿主既不知道那个界面何时挂载，
   * 也没有 `ensureSlotLoaded` 的触发点。故必须归"不推迟"——若哪天有人把
   * ON_DEMAND_SLOTS 改成"含 `/` 就算按需"，这条会红，而后果是**该扩展点的贡献者
   * 永远不会被加载**（插件界面永远不出现，且不报错）。
   */
  assert.equal(lazy(['my-plugin/toolbar']), false, '自定义扩展点不得被当作按需插槽')
  assert.equal(lazy(['my-plugin/toolbar', 'editor']), false, '混了自定义扩展点就整包不推迟')
})

/* ============ ⑥ F2：插件页面路由——契约镜像与加载判据 ============ */

const ROUTE_MIRRORED_INTERFACES: readonly { name: string; required: readonly string[] }[] = [
  // `id` 是唯一的必需字段：label/group/requires/order 都可缺省（缺省 = 不进导航 / 无要求）
  { name: 'PluginRouteDecl', required: ['id'] },
]

for (const { name, required } of ROUTE_MIRRORED_INTERFACES) {
  test(`${name} 镜像：core 与 pluginUiPlan 两侧字段名/可选性/readonly 逐个相等`, () => {
    const coreFields = parseInterface(read(CORE_FILE), CORE_FILE, name)
    const planFields = parseInterface(read(PLAN_FILE), PLAN_FILE, name)
    assert.deepEqual(
      planFields,
      coreFields,
      `${name} 两侧镜像漂移（字段名/可选性/readonly）。\n` +
        `core=${JSON.stringify(coreFields)}\nplan=${JSON.stringify(planFields)}\n` +
        '漂移的症状是运行期静默：后端下发了字段，前端读不到（或反之），导航项凭空不出现。',
    )
    for (const field of required) {
      assert.ok(
        coreFields.some((f) => f.name === field && !f.optional),
        `${name} 的必需字段 ${field} 缺失或变成了可选——契约被削弱`,
      )
    }
  })
}

/*
 * ★ 镜像已**消除**，故判据从"内容相等"升级为**引用同一性**。
 *
 * 原先这两项在 core 与 `pluginUiPlan.ts` 各有一份，由"逐元素相等/逐字一致"的守卫钉住。
 * 那条守卫的弱点很具体：**它只在漂移之后才红**，而"内容相等"在有人刚抄完一份时是
 * **通过**的。真源已搬进浏览器安全的 `@geewiki/core/domain`，web 侧改为转出 ——
 * 于是判据可以变成「是不是同一个对象」，而**副本无法伪装成同一个对象**。
 *
 * 这仍是一条**安全边界**（不是洁癖）：后端拒绝插件声明保留 id，前端（运行期注册）
 * 也必须拒绝。最坏的漂移方向是**前端少了一个保留 id** —— 插件页面顶掉 `#/wiki`，
 * 用户以为自己在看自己的 wiki。
 */
test('路由常量不再是镜像：pluginUiPlan 转出的必须是 core 的**同一个对象**', async () => {
  const plan = await import('../src/lib/pluginUiPlan')
  const core = await import('@geewiki/core/domain')

  assert.ok(core.RESERVED_ROUTE_IDS.length > 0, 'core 的保留清单不得为空')
  assert.equal(
    plan.RESERVED_ROUTE_IDS,
    core.RESERVED_ROUTE_IDS,
    'RESERVED_ROUTE_IDS 必须是同一个对象（若有人又抄了一份，这里会红）',
  )
  assert.equal(plan.PLUGIN_ROUTE_ID, core.PLUGIN_ROUTE_ID, 'PLUGIN_ROUTE_ID 必须是同一个对象')

  // 顺带钉住"运行期真的在用这份清单"，而不是只把它转出却没用
  assert.equal(plan.PLUGIN_ROUTE_ID.test('board'), true)
  assert.equal(plan.PLUGIN_ROUTE_ID.test('a/b'), false)
  // 注：`audit` 已从保留清单移出（2026-09-17 搬成插件 @geewiki/ops），故不在此列 ——
  // 它现在的归属由 packages/web/test/opsOwnership.test.ts 钉住
  for (const id of ['wiki', 'plugins', 'graph', 'org', 'account', 'invite']) {
    assert.ok(plan.RESERVED_ROUTE_IDS.includes(id), `${id} 应当在保留清单里`)
  }
})

test('isLazyOnlyEntry：声明了页面路由的插件**一律不推迟**（F2 的反向判据）', async () => {
  const mod = await import('../src/lib/pluginUiPlan')
  const entry = (routes: unknown[], slots?: string[]) =>
    mod.isLazyOnlyEntry({
      entry: 'client.js',
      rev: 'x',
      routes: routes as never,
      ...(slots ? { slots: slots as never } : {}),
    })
  /*
   * 若这条放松，症状是：导航项在（它来自入口表，不需要 bundle），点进去**一片空白、
   * console 里连一条错误都没有**——bundle 从未被加载过，"路由未注册"的告警也不会出现
   * （那个告警只在"声明了却没注册"时有意义，而这里是"声明了、产物压根没取"）。
   */
  assert.equal(entry([{ id: 'board' }]), false, '有路由 ⇒ 不可推迟')
  assert.equal(
    entry([{ id: 'board' }], ['editor']),
    false,
    '有路由 + 全是按需插槽 ⇒ 仍不可推迟（路由的优先级更高）',
  )
  assert.equal(entry([{ id: 'board' }], ['app-header']), false)
  // 路由数组为空/缺省 ⇒ 回到原有的插槽判据
  assert.equal(entry([], ['editor']), true, '空 routes 不得影响按需判定')
  assert.equal(entry([], ['app-header']), false)
})
