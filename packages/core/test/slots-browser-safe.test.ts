/**
 * `src/slots.ts` 的**浏览器安全**守卫 + 「镜像已删除」守卫。
 *
 * ## 这个文件为什么存在
 * `src/slots.ts` 是插槽白名单的单一真源，但它被 `packages/web`（浏览器 bundle）
 * 经 `@geewiki/core/slots` 直接 import。因此它必须**永远**满足两个条件：
 *
 * 1. **不引入任何 Node / 服务端依赖**（`node:*`、`cordis`、`schemastery`）——
 *    否则 Vite 构建会炸，或更糟：`node:fs` 被打进来后在浏览器里运行时才抛。
 * 2. **不 import 本包的 `index.ts`** —— 那会把 `index.ts` 顶层的 `import 'node:fs'`
 *    整条链拖回来，条件 1 就白写了（这是最容易在重构中无意破坏的一条：
 *    「顺手从 index 里 import 一个类型」看起来无害）。
 *
 * 这两条**测试不出运行期行为**（Node 下两边都能跑），所以只能做源码级断言。
 * 同 `packages/manager/test/slots.test.ts` 的既有做法。
 *
 * ## 为什么还要断言"镜像真的没了"
 * 改造的收益全部来自"删掉镜像"，而**回归的方式是静默的**：有人图省事在 `slots.tsx`
 * 里再抄一份字面量数组，一切照常工作，直到两边漂移。故本守卫反过来钉：
 * web 侧的插槽白名单**必须是**从 `@geewiki/core/slots` 转出的，不得自带字面量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const coreSlotsPath = join(here, '..', 'src', 'slots.ts')
const coreIndexPath = join(here, '..', 'src', 'index.ts')

/** 去掉注释，避免"注释里提到 node:fs"被误判（本文件的文档就大量提到它）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('src/slots.ts 不引入任何 Node / 服务端依赖', () => {
  const code = stripComments(readFileSync(coreSlotsPath, 'utf8'))
  const forbidden = [
    { re: /from\s+['"]node:[^'"]+['"]/g, what: 'node:* 导入' },
    { re: /require\(\s*['"]node:/g, what: 'node:* require' },
    { re: /from\s+['"]cordis['"]/g, what: 'cordis 导入' },
    { re: /from\s+['"]schemastery['"]/g, what: 'schemastery 导入' },
  ]
  for (const { re, what } of forbidden) {
    const hit = code.match(re)
    assert.equal(
      hit,
      null,
      `src/slots.ts 出现了 ${what}：${hit?.join(', ')}。` +
        '本文件会被 Vite 打进浏览器 bundle，任何 Node 依赖都会让前端构建失败或在运行期抛错。',
    )
  }
})

test('src/slots.ts 不 import 本包 index.ts（否则 node:fs 会被拖回来）', () => {
  const code = stripComments(readFileSync(coreSlotsPath, 'utf8'))
  const bad = code.match(/from\s+['"]\.\/index(\.js)?['"]/g)
  assert.equal(
    bad,
    null,
    'src/slots.ts 不得 import ./index.js —— index.ts 顶层 import "node:fs"，' +
      '这会让浏览器构建把 node:fs 拖进来，正好废掉本文件"浏览器安全子集"的全部意义。',
  )
})

test('src/slots.ts 确实导出了前后端共用的那组常量与纯函数', () => {
  const code = readFileSync(coreSlotsPath, 'utf8')
  // 先断言"解析出的是非空集合"：正则写坏时立即红，不会退化成"两边都空 ⇒ 通过"
  for (const name of [
    'BuiltinSlotName',
    'PLUGIN_SLOT_NAME',
    'SLOT_NAMES',
    'SLOT_CARDINALITY',
    'SlotName',
    'SlotDeclaration',
    'isBuiltinSlotName',
    'isPluginSlotName',
    'slotCardinalityOf',
  ]) {
    assert.match(
      code,
      new RegExp(`export (type|const|function|interface) ${name}\\b`),
      `src/slots.ts 缺少导出 ${name}（前端依赖它，缺了会让 web 的类型/运行期同时失效）`,
    )
  }
})

test('core 的 index.ts 转出 slots.ts（既有 import from "@geewiki/core" 不能断）', () => {
  const code = readFileSync(coreIndexPath, 'utf8')
  assert.match(
    code,
    /export \* from '\.\/slots\.js'/,
    'src/index.ts 必须 `export * from \'./slots.js\'`，否则既有调用点 ' +
      "（manager 的 `import { SLOT_NAMES } from '@geewiki/core'`）会在升级后静默拿不到值。",
  )
})

/**
 * web 侧镜像删除守卫：`slots.tsx` / `pluginUiPlan.ts` 必须**转出**真源，
 * 而不是自己再**定义**一份白名单。
 *
 * ## 判据为什么是「不得本地 export 定义」而不是「不得出现插槽名字面量」
 * 试过两种更"直觉"的判据，都会误判：
 * - "数组里出现内置插槽名" ⇒ 误伤 `pluginUiPlan.ts` 的 `ON_DEMAND_SLOTS`
 *   （那是 web **自己的子集选择**：挑哪几个按需加载，合法地列出 editor/app-dock 等）；
 * - "不得出现 `'app-header'` 字面量" ⇒ 误伤 `slots.tsx` 的 `ZeroPropsSlotName`
 *   （`'app-header' | 'app-footer'` 是 web **自己的窄化**：零属性插槽子集）。
 *
 * 真正要禁的是**定义**：`export const SLOT_NAMES = [...]` / `export type BuiltinSlotName = …` /
 * `export const PLUGIN_SLOT_NAME = …` 这类"又抄了一份白名单"的写法。
 * 转出（`export { SLOT_NAMES } from …` / `export type { BuiltinSlotName }`）不含 `=`，
 * 不会被误伤。
 *
 * 更强的运行期判据（**同一性**：`web.SLOT_NAMES === core.SLOT_NAMES`，副本无法伪装）
 * 放在 `packages/web/test/slotPropsMirror.test.ts` —— 那里能同时 import 两侧模块；
 * 本文件在 core 里，不能反向依赖 web。
 */
test('web 侧不得再本地定义插槽白名单（必须转出 @geewiki/core/slots）', () => {
  const localDefs = /\bexport\s+(?:const|type|interface)\s+(SLOT_NAMES|SLOT_CARDINALITY|PLUGIN_SLOT_NAME|BuiltinSlotName|SlotName)\b\s*[=:]/g
  for (const rel of ['packages/web/src/lib/slots.tsx', 'packages/web/src/lib/pluginUiPlan.ts']) {
    const file = join(repoRoot, rel)
    const code = stripComments(readFileSync(file, 'utf8'))
    assert.match(
      code,
      /from '@geewiki\/core\/slots'/,
      `${rel} 必须从 '@geewiki/core/slots' 导入插槽白名单（单一真源）。`,
    )
    const hits = [...code.matchAll(localDefs)].map((m) => m[0].trim())
    assert.deepEqual(
      hits,
      [],
      `${rel} 又本地定义了一份白名单：\n  ${hits.join('\n  ')}\n` +
        '完整白名单只能有一份，即 @geewiki/core/slots。手抄会漂移，且漂移是静默的' +
        '（后端登记了贡献、前端当未知插槽忽略 ⇒ 界面空白而日志干净）。\n' +
        '注：web 自己的子集（`ON_DEMAND_SLOTS`、`ZeroPropsSlotName`）是合法决策，不受此断言限制。',
    )
  }
})

/* ==================== ★ F9：能力名的真源与镜像守卫 ==================== */

/**
 * F9 把**能力名**放进了 `src/domain.ts`（它此前只有 `PageVisibility`）。
 * 于是该文件承担与 `slots.ts` **完全相同**的约束 —— 它是前端经
 * `@geewiki/core/domain` 直接 import 的浏览器安全子集，任何 Node 依赖都会
 * 让 Vite 构建失败、或在运行期才抛。
 *
 * ⚠️ 这两条**运行期测不出来**（Node 下 `node:fs` 完全可用），只能源码级断言 ——
 * 与文件头所述同理：最容易破坏它的动作是"顺手从 index 里 import 一个类型"。
 */
const coreDomainPath = join(here, '..', 'src', 'domain.ts')

test('src/domain.ts 不引入任何 Node / 服务端依赖', () => {
  const code = stripComments(readFileSync(coreDomainPath, 'utf8'))
  const forbidden = [
    { re: /from\s+['"]node:[^'"]+['"]/g, what: 'node:* 导入' },
    { re: /require\(\s*['"]node:/g, what: 'node:* require' },
    { re: /from\s+['"]cordis['"]/g, what: 'cordis 导入' },
    { re: /from\s+['"]schemastery['"]/g, what: 'schemastery 导入' },
  ]
  for (const { re, what } of forbidden) {
    const hit = code.match(re)
    assert.equal(
      hit,
      null,
      `src/domain.ts 出现了 ${what}：${hit?.join(', ')}。` +
        '本文件会被 Vite 打进浏览器 bundle（前端 import type 能力名/档位），' +
        '任何 Node 依赖都会让前端构建失败或在运行期抛错。',
    )
  }
})

test('src/domain.ts 不 import 本包 index.ts（否则 node:fs 会被拖回来）', () => {
  const code = stripComments(readFileSync(coreDomainPath, 'utf8'))
  const bad = code.match(/from\s+['"]\.\/index(\.js)?['"]/g)
  assert.equal(
    bad,
    null,
    'src/domain.ts 不得 import ./index.js —— index.ts 顶层 import "node:fs"，' +
      '这会让浏览器构建把 node:fs 拖进来，正好废掉本文件"浏览器安全子集"的全部意义。',
  )
})

test('src/domain.ts 导出能力名的单一真源（F9）', () => {
  const code = readFileSync(coreDomainPath, 'utf8')
  // 先断言"解析出的是非空集合"：正则写坏时立即红，不会退化成"两边都空 ⇒ 通过"
  for (const name of [
    'BuiltinCapability',
    'BUILTIN_CAPABILITIES',
    'PLUGIN_CAPABILITY_NAME',
    'CapabilityName',
    'CapabilitySet',
    'CapabilityDecl',
    'isBuiltinCapability',
    'isPluginCapability',
    'isCapabilityName',
  ]) {
    assert.match(
      code,
      new RegExp(`export (type|const|function|interface) ${name}\\b`),
      `src/domain.ts 缺少导出 ${name}（前端/plugin-auth/manager 都依赖它，缺了会让三侧同时失效）`,
    )
  }
})

test('★ F9：web 与 plugin-auth 不得再本地定义 AuthCapabilities 白名单', () => {
  /*
   * F9 之前同一份"能力的三个键"存在于**三处**：`plugin-auth/src/index.ts`、
   * `web/src/api.ts` 各一份接口，`web/src/lib/navPlan.ts` 再一份名字数组。
   * 漏改其中一处的症状是**静默的**：那个能力键在前端被当成未知 ⇒ 入口永远不出现。
   *
   * 判据是"不得再**定义**"，而不是"不得出现 editContent 字面量" ——
   * 后者会误伤合法的改动点（例如测试里构造 `{ editContent: true }` 这类快照）。
   */
  const cases: Array<{ rel: string; must: RegExp; why: string }> = [
    {
      rel: 'packages/web/src/api.ts',
      must: /\bAuthCapabilities\b[^\n]*=\s*CapabilitySet/,
      why: 'api.ts 的 AuthCapabilities 必须**转出** @geewiki/core/domain 的 CapabilitySet',
    },
    {
      rel: 'packages/plugin-auth/src/index.ts',
      must: /\bbuiltinCapabilitiesOf\b/,
      why: 'plugin-auth 必须用 core 的 builtinCapabilitiesOf（角色语义的唯一真源）',
    },
    {
      rel: 'packages/web/src/lib/navPlan.ts',
      must: /\bNAV_CAPABILITIES\s*=\s*BUILTIN_CAPABILITIES\b/,
      why: 'navPlan 的 NAV_CAPABILITIES 必须**转出** core 的 BUILTIN_CAPABILITIES',
    },
  ]
  const localCapInterface = /\bexport interface AuthCapabilities\b/
  for (const { rel, must, why } of cases) {
    const code = stripComments(readFileSync(join(repoRoot, rel), 'utf8'))
    assert.equal(
      localCapInterface.test(code),
      false,
      `${rel} 又本地定义了一份 AuthCapabilities 接口 —— 白名单只能有一份（@geewiki/core/domain）。`,
    )
    assert.match(code, must, `${rel}: ${why}。`)
  }
})

/* ==================== 界面扩展平台：宿主节点目录的浏览器安全守卫 ==================== */

/**
 * `src/extensions.ts` 是「宿主节点目录 + 扩展模式」的真源，与 `slots.ts`、`domain.ts`
 * 承担**完全相同**的约束：前端经 `@geewiki/core/extensions` 直接 import 它
 * （`<Ext>` 出口要据此判断"这个节点认不认识"、`registerExtension` 要据此校验模式），
 * 因此任何 Node / cordis 依赖都会让 Vite 构建失败、或在运行期才抛。
 */
const coreExtensionsPath = join(here, '..', 'src', 'extensions.ts')

test('src/extensions.ts 不引入任何 Node / 服务端依赖', () => {
  const code = stripComments(readFileSync(coreExtensionsPath, 'utf8'))
  const forbidden = [
    { re: /from\s+['"]node:[^'"]+['"]/g, what: 'node:* 导入' },
    { re: /require\(\s*['"]node:/g, what: 'node:* require' },
    { re: /from\s+['"]cordis['"]/g, what: 'cordis 导入' },
    { re: /from\s+['"]schemastery['"]/g, what: 'schemastery 导入' },
  ]
  for (const { re, what } of forbidden) {
    const hit = code.match(re)
    assert.equal(
      hit,
      null,
      `src/extensions.ts 出现了 ${what}：${hit?.join(', ')}。` +
        '本文件会被 Vite 打进浏览器 bundle（前端据此校验节点名与模式），' +
        '任何 Node 依赖都会让前端构建失败或在运行期抛错。',
    )
  }
})

test('src/extensions.ts 不 import 本包 index.ts（否则 node:fs 会被拖回来）', () => {
  const code = stripComments(readFileSync(coreExtensionsPath, 'utf8'))
  const bad = code.match(/from\s+['"]\.\/index(\.js)?['"]/g)
  assert.equal(
    bad,
    null,
    'src/extensions.ts 不得 import ./index.js —— index.ts 顶层 import "node:fs"，' +
      '这会让浏览器构建把 node:fs 拖进来，正好废掉本文件"浏览器安全子集"的全部意义。',
  )
})

test('★ src/extensions.ts 必须从 slots.ts 取插槽事实，而不是重抄一份', () => {
  const code = stripComments(readFileSync(coreExtensionsPath, 'utf8'))
  // 正面：确实从 ./slots.js 取类型与常量（基数真源 SLOT_CARDINALITY、判据 PLUGIN_SLOT_NAME）
  assert.match(
    code,
    /from '\.\/slots\.js'/,
    'src/extensions.ts 必须从 ./slots.js 取插槽事实（BuiltinSlotName / SLOT_CARDINALITY / isPluginSlotName）。',
  )
  // 反面：不得出现"自己又写一份插槽名字数组"的写法
  const localDefs = code.match(/\b(?:const|type)\s+(?:SLOT_NAMES|SLOT_CARDINALITY|BuiltinSlotName|PLUGIN_SLOT_NAME)\b\s*[=:]/g)
  assert.equal(
    localDefs,
    null,
    `src/extensions.ts 又本地定义了一份插槽事实：${localDefs?.join(', ')}。` +
      '宿主节点目录必须**并入** BuiltinSlotName，而不是把它重抄成第二份字面量。',
  )
})

test('src/extensions.ts 导出目录与模式判据的那组名字', () => {
  const code = readFileSync(coreExtensionsPath, 'utf8')
  for (const name of [
    'ExtMode',
    'HostNodeKind',
    'HostNodeName',
    'HostNodeSpec',
    'HOST_NODE_CATALOG',
    'HOST_NODE_NAMES',
    'DEFAULT_EXT_MODE',
    'EXT_MODES',
    'isHostNodeName',
    'isExtName',
    'hostNodeSpec',
    'extModesOf',
    'supportsExtMode',
    'extendCardinalityOf',
    'modeCardinalityOf',
  ]) {
    assert.match(
      code,
      new RegExp(`export (type|const|function|interface) ${name}\\b`),
      `src/extensions.ts 缺少导出 ${name}（前端与 manager 都依赖它）`,
    )
  }
})

test('core 的 index.ts 转出 extensions.ts，且 package.json 有对应子路径', () => {
  const index = readFileSync(coreIndexPath, 'utf8')
  assert.match(
    index,
    /export \* from '\.\/extensions\.js'/,
    "src/index.ts 必须 `export * from './extensions.js'`，否则既有调用点拿不到目录。",
  )
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string>
  }
  assert.equal(
    pkg.exports['./extensions'],
    './src/extensions.ts',
    "package.json 的 exports 里必须有 './extensions' —— web 侧要经它 import（否则只能从 index 引，进而拖进 node:fs）。",
  )
})
