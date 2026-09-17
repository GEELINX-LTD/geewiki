/**
 * ★ 优化点 8：`SLOT_PROPS_SCHEMA` 与权威 TS 接口的**一致性守卫**。
 *
 * ## 为什么必须有这个文件
 * `SLOT_PROPS_SCHEMA` 天然是一份**派生描述**：它说"`editor` 插槽会收到这 12 个属性"，
 * 而真正有约束力的是 `EditorSlotProps` 那个接口。两份表示靠"记得同步"必然漂移——
 * §4 优化点 1（插槽白名单曾有 4 份镜像）就是同一个教训的完整版。
 *
 * 所以这里把纪律换成**判据**：按 schema 自己声明的 `contract` 锚点，去源码里解析那个接口，
 * 比对**顶层字段名集合**与**每一条的可选性**。两侧任一方向漂移都当场变红：
 * - 接口加了字段、schema 没跟 ⇒ 红（外部插件看到的是过期的契约）；
 * - schema 写了接口里没有的字段 ⇒ 红（下发了一份**不存在**的契约，比缺字段更坏：
 *   作者会照着写代码，然后在运行时收到 `undefined`）。
 *
 * ## 为什么必须"源码级"而不是 import 类型
 * `packages/core/src/index.ts` 顶层 `import 'node:fs'`、并牵入 cordis 的全局 `Context`，
 * 从 web/DOM 侧引入会直接炸（实测 `TS2451: Cannot redeclare block-scoped variable 'Context'`）。
 * 这正是当初把白名单拆到 `slots.ts` 的同一个原因。于是"解析源码文本"是这里唯一可行的判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOT_NAMES, SLOT_PROPS_SCHEMA, isBuiltinSlotName } from '../src/slots.js'

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

/** 取接口体（花括号配平），供顶层字段解析 */
function interfaceBody(source: string, file: string, name: string): string {
  const marker = `export interface ${name} {`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `${file}：未找到 ${marker}（重命名或删除即红，不允许静默通过）`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(bodyStart + 1, i)
    }
  }
  throw new Error(`${file}：${name} 的花括号未配平`)
}

interface Field {
  name: string
  optional: boolean
}

/**
 * 解析接口的**顶层**字段。
 *
 * 必须按深度切分而不是按行切分：`blockTiers?: {\n readonly pageVisibility: …\n} | null`
 * 这种嵌套对象类型会跨多行，按行解析会把里面的字段误当成顶层字段
 * （本仓库既有的 `slotPropsMirror.test.ts` 用的就是按行解析，故它对 `app-dock`
 * 的嵌套 `page` 会多报出 `slug` / `kind` —— 这里不能沿用那个近似）。
 */
function topLevelFields(body: string): Field[] {
  const src = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const out: Field[] = []
  let depth = 0
  let buf = ''
  const flush = (): void => {
    const t = buf.trim()
    buf = ''
    if (t === '') return
    // 属性 `name?: T` 或方法 `name?(` 都算一个字段
    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*[:(]/.exec(t)
    if (m) out.push({ name: m[1] as string, optional: m[2] === '?' })
  }
  for (const ch of src) {
    if (ch === '{' || ch === '(' || ch === '[') depth++
    else if (ch === '}' || ch === ')' || ch === ']') depth--
    if ((ch === ';' || ch === '\n') && depth === 0) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  return out
}

const sortFields = (fs: readonly Field[]): Field[] =>
  [...fs].map((f) => ({ name: f.name, optional: f.optional })).sort((a, b) => a.name.localeCompare(b.name))

/* ------------------------------ 表本身的自洽 ------------------------------ */

test('★ 优化点 8：schema 覆盖全部内置插槽，键集与 SLOT_NAMES 完全一致', () => {
  const keys = Object.keys(SLOT_PROPS_SCHEMA).sort()
  assert.deepEqual(keys, [...SLOT_NAMES].sort(), 'schema 的键集必须与白名单逐一对应（双向）')
  // 反射一遍：每个键都必须是合法的内置插槽名（防止拼错的键混进来）
  for (const k of keys) assert.ok(isBuiltinSlotName(k), `schema 里的键 ${k} 不是内置插槽名`)
})

test('★ 优化点 8：零属性槽与带 props 槽的形态各自自洽', () => {
  for (const [slot, spec] of Object.entries(SLOT_PROPS_SCHEMA)) {
    if (spec.zeroProps) {
      assert.deepEqual(spec.props, [], `${slot} 声明为零属性就不该列出任何 props`)
      assert.equal(spec.contract, undefined, `${slot} 零属性不该有 contract（没有接口可比对）`)
    } else {
      assert.ok(spec.props.length > 0, `${slot} 声明带 props 就必须至少列出一条`)
      assert.ok(spec.contract !== undefined, `${slot} 带 props 必须给出 contract 锚点（否则守卫无从比对）`)
    }
  }
})

test('★ 优化点 8：props 内部无重复名、无空描述', () => {
  for (const [slot, spec] of Object.entries(SLOT_PROPS_SCHEMA)) {
    const names = spec.props.map((p) => p.name)
    assert.equal(new Set(names).size, names.length, `${slot} 的 props 名有重复: ${names.join(', ')}`)
    for (const p of spec.props) {
      assert.ok(p.description.trim().length > 0, `${slot}.${p.name} 缺描述（下发一份没说明的契约没意义）`)
      assert.ok(p.type.trim().length > 0, `${slot}.${p.name} 缺类型`)
    }
  }
})

/* ---------------------- 与权威接口的逐条比对（核心守卫） ---------------------- */

test('★ 优化点 8：每个带 props 的槽都与权威接口的顶层字段逐条一致（双向）', () => {
  for (const [slot, spec] of Object.entries(SLOT_PROPS_SCHEMA)) {
    if (spec.zeroProps) continue
    const contract = spec.contract
    assert.ok(contract, `${slot} 缺 contract`)
    const file = join(root, contract.file)
    const source = readFileSync(file, 'utf8')
    const actual = sortFields(topLevelFields(interfaceBody(source, contract.file, contract.interface)))
    const declared = sortFields(spec.props.map((p) => ({ name: p.name, optional: p.optional === true })))

    assert.deepEqual(
      declared,
      actual,
      `${slot} 的 SLOT_PROPS_SCHEMA 与 ${contract.interface}（${contract.file}）不一致：\n` +
        `  schema 声明: ${declared.map((f) => f.name + (f.optional ? '?' : '')).join(', ')}\n` +
        `  接口实有  : ${actual.map((f) => f.name + (f.optional ? '?' : '')).join(', ')}\n` +
        '两侧必须同时修（这是本守卫存在的全部意义）',
    )
  }
})

test('★ 优化点 8：account-identities 的契约确实在 web 包（既有的不对称，如实钉住）', () => {
  // 唯一"前端包才是真源"的带 props 插槽。若哪天它被搬进 core，这条会红——
  // 那时应当**同时**把 contract.file 改回 core，而不是删掉这条测试。
  const spec = SLOT_PROPS_SCHEMA['account-identities']
  assert.equal(spec.contract?.file, 'packages/web/src/lib/slots.tsx')
  const source = readFileSync(join(root, 'packages/web/src/lib/slots.tsx'), 'utf8')
  assert.ok(source.includes('export interface AccountIdentitiesSlotProps {'), 'web 侧接口必须仍在')
})
