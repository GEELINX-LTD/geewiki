/**
 * `EditorSlotProps` 的**双侧镜像守卫**。
 *
 * ## 这个测试防的是什么
 * `editor` 插槽的 props 类型有**两份**必须逐字一致的声明：
 * - 权威副本：`packages/core/src/index.ts` 的 `EditorSlotProps`（插件按它实现编辑器）
 * - 前端镜像：`packages/web/src/lib/slots.tsx` 的 `EditorSlotProps`（宿主按它传数据）
 *
 * web 不能 import core（core 顶层 `import 'node:fs'`，进不了浏览器 bundle），所以这份重复
 * **不可避免**——既然如此就必须有守卫，否则一侧加了字段而另一侧没跟，症状是
 * **运行期静默**：宿主不传那个字段，插件的编辑器读到 `undefined`，既不报错也不崩，
 * 只是功能少了一块。这与本仓库此前踩过的 `DegradedReason`、`SLOT_NAMES` 镜像漂移是同一类。
 *
 * ## 为什么是"源码级"比对而不是 import 两边类型
 * 类型在运行期不存在（`interface` 会被完全擦除），无法 import 后比较；
 * 仓库既有先例同此（`manager/test/slots.test.ts` 的 SLOT_NAMES 守卫、
 * `web/test/degradedReason.test.ts` 的 union 守卫）。
 *
 * ## 为什么不会空洞通过
 * 解析失败 ⇒ 立刻红（不允许"两侧都解析出空集合 → 0 === 0 相等"）；
 * 并用 `assert.ok(fields.length > 0)` 显式拒绝空集合。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** 从仓库内的某个路径向上找到含 pnpm-workspace.yaml 的根 */
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
const CORE_FILE = join(root, 'packages/core/src/index.ts')
const WEB_FILE = join(root, 'packages/web/src/lib/slots.tsx')

/** 一个字段的解析结果 */
interface FieldShape {
  name: string
  optional: boolean
  readonly: boolean
}

/**
 * 从源码里解析 `export interface EditorSlotProps { … }` 的字段形状。
 *
 * 只保留"方法签名与属性声明"两类行：
 * - 属性：`readonly value: string` / `readOnly?: boolean`
 * - 方法：`onChange(next: string): void`
 * 注释块（`/** … *\/`）与空行先剥掉，避免把 JSDoc 里的示例误当字段。
 */
function parseEditorSlotProps(source: string, file: string): FieldShape[] {
  const start = source.indexOf('export interface EditorSlotProps {')
  assert.ok(start >= 0, `未能从 ${file} 找到 export interface EditorSlotProps（正则/文件结构变了即红）`)
  const bodyStart = source.indexOf('{', start)
  // 用花括号配平找接口体结束（字段里含 `=>`/泛型也不受影响）
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end > bodyStart, `未能解析出 EditorSlotProps 的接口体（${file}）`)
  let body = source.slice(bodyStart + 1, end)

  // 剥掉块注释与行注释（JSDoc 里出现的 `value?: string` 之类不能算字段）
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  const fields: FieldShape[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    // 属性：`[readonly] name[?]: type`；方法：`name(args): ret`
    const prop = /^(readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/.exec(line)
    const method = /^([A-Za-z_$][\w$]*)\s*\(/.exec(line)
    if (prop) {
      fields.push({ name: prop[2] as string, optional: prop[3] === '?', readonly: prop[1] !== undefined })
    } else if (method) {
      // 方法在接口上都是必填的（本接口没有可选方法）
      fields.push({ name: method[1] as string, optional: false, readonly: false })
    }
  }
  return fields
}

test('EditorSlotProps 镜像：core 与 web 两侧的字段名/可选性逐个相等', () => {
  const coreFields = parseEditorSlotProps(readFileSync(CORE_FILE, 'utf8'), CORE_FILE)
  const webFields = parseEditorSlotProps(readFileSync(WEB_FILE, 'utf8'), WEB_FILE)

  // 兜底：解析写坏时两侧都可能变成空数组（0 === 0 恒等），必须显式拒绝
  assert.ok(coreFields.length > 0, `core 侧解析出的字段为空（正则失效或类型被清空）：${CORE_FILE}`)
  assert.ok(webFields.length > 0, `web 侧解析出的字段为空（正则失效或类型被清空）：${WEB_FILE}`)

  // 契约本身的最低要求：这几个字段是插槽能力的全部出口，少一个就等于砍掉一项能力
  const required = ['value', 'mode', 'slug', 'onChange', 'onSave', 'onCancel']
  for (const name of required) {
    assert.ok(
      coreFields.some((f) => f.name === name),
      `core 的 EditorSlotProps 缺少必需字段 ${name}——契约被削弱了`,
    )
  }

  assert.deepEqual(
    webFields,
    coreFields,
    'EditorSlotProps 两侧镜像漂移：字段名或可选性不一致。\n' +
      'web 侧必须逐字跟随 core（web 不能 import core，故只能镜像）——\n' +
      '漂移的症状是运行期静默：宿主不传该字段，插件的编辑器读到 undefined 且不报错。',
  )
})

test('EditorSlotProps 镜像：新增字段只允许可选（否则会破坏既有编辑器插件）', () => {
  const coreFields = parseEditorSlotProps(readFileSync(CORE_FILE, 'utf8'), CORE_FILE)
  // core 的 JSDoc 明写"加字段只允许可选语义"；这里把这条约束变成可执行断言。
  // 允许必填的只有最初那批（它们是契约的最小集），其余一律必须可选。
  const originalRequired = new Set(['value', 'mode', 'slug', 'onChange', 'onSave', 'onCancel'])
  const newRequired = coreFields.filter((f) => !f.optional && !originalRequired.has(f.name))
  assert.deepEqual(
    newRequired.map((f) => f.name),
    [],
    '新增了必填字段：既有编辑器插件会因缺少该 prop 而行为未定义。' +
      '按 core 的演进约束，加字段必须是可选（`?`）。',
  )
})
