/**
 * `editor.*` 工具名的**镜像守卫**（P3）。
 *
 * ## 为什么要有这个文件
 * 一条客户端工具是**两半点名同一个名字**：
 * - 服务端：本包 `src/index.ts` 的 `EDITOR_TOOL_NAMES`（描述符进模型的工具表）；
 * - 浏览器：`packages/web/src/lib/editorTools.ts` 的 `EDITOR_TOOL_NAMES`（注册处理器）。
 *
 * 浏览器侧不能 import 本包（不进 node bundle 的反向同理：服务端也不该 import 一个
 * 带 DOM 假设的模块），所以两边是**被迫的镜像**——照本仓既有文化
 * （`api.ts` 的 `DegradedReason`、`searchPlan.ts` 的 `MAX_QUERY_LENGTH`、
 * `slots.tsx` 的 `SLOT_NAMES`），镜像必须由源级守卫钉住。
 *
 * ## 漂移的症状，以及为什么它是静默的
 * 两半名字不一致时**没有任何运行期报错**：
 * - 服务端多一个名字 ⇒ 模型会去调它 ⇒ 客户端 `invokeClientTool` 抛"未登记"，
 *   用户看到一次莫名其妙的工具失败；
 * - 客户端多一个名字 ⇒ 它进不了模型看到的工具表（交集取的是服务端 `side:'client'`
 *   声明 ∩ 宿主登记），于是**那条工具永远不会被调用**，而界面上一切正常。
 *
 * 后一种更坏：它长得和"这个功能没做"一模一样。所以这里比对的是**两侧源码里的字面量**，
 * 而不是运行期行为——运行期行为在两侧各自为真时也是自洽的，看不出漂移。
 *
 * ## 扫描范围收窄（本仓的踩坑教训）
 * `packages/web/src/lib/clientTools.ts` 的**文件头注释里就写着**
 * `editor.replace_selection` 这个名字（它举的例子）。若在整个文件里 `indexOf`，
 * 会先命中注释里那份。本文件的读法因此是**先剥注释再取 `EDITOR_TOOL_NAMES` 数组字面量**，
 * 并且只在 `export const EDITOR_TOOL_NAMES` 之后的一小段里取——把范围收窄比把正则写精巧可靠
 * （`packages/web/test/appDockHost.test.ts` 记过同一条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EDITOR_TOOL_NAMES, EDITOR_MUTATING_TOOL_NAMES } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_FILE = join(HERE, '..', '..', 'web', 'src', 'lib', 'editorTools.ts')
const PLUGIN_FILE = join(HERE, '..', 'src', 'index.ts')

/**
 * 取出源码里 `EDITOR_TOOL_NAMES` 数组的字符串字面量。
 *
 * 先剥注释：`editorTools.ts` 的文件头与实现注释里都出现过工具名（举例子），
 * 不剥就会把注释里的那几份也当成"声明"。剥法是**状态机**而不是正则——
 * 正则版会在 `'https://x'` 里把 `//` 当注释起点，从那里往后的代码全被吃掉，
 * **守卫会静默变松**，那比误报更糟（`ui/index.tsx` 那次教训）。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: '"' | "'" | '`' | null = null
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 从 `export const <name> = [ ... ]` 里取出字符串字面量。
 *
 * ⚠️ **必须先跳过 `=`**：`EDITOR_HANDLE_TOOL_NAMES` 的声明是
 * `export const EDITOR_HANDLE_TOOL_NAMES: readonly EditorToolName[] = [...]` ——
 * 类型标注里就有方括号。若直接找名字之后的第一个 `[`，取到的是**类型**那对空方括号，
 * 于是函数安静地返回 `[]`，守卫从此恒真（**比误报更糟**：它看起来还在检查）。
 */
function stringLiteralsOf(source: string, exportName: string): string[] {
  const clean = stripComments(source)
  const at = clean.indexOf(`export const ${exportName}`)
  assert.ok(at >= 0, `没在源码里找到 export const ${exportName}`)
  const eq = clean.indexOf('=', at)
  assert.ok(eq >= 0, `${exportName} 的声明里没有 =`)
  const open = clean.indexOf('[', eq)
  assert.ok(open >= 0, `${exportName} 不是数组字面量`)
  const close = clean.indexOf(']', open)
  assert.ok(close > open, `${exportName} 的数组没有收尾`)
  const body = clean.slice(open + 1, close)
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
}

test('宿主侧的 editorTools.ts 读得到（守卫的第一件事是证明它真的读了文件）', () => {
  const source = readFileSync(HOST_FILE, 'utf8')
  assert.match(source, /export const EDITOR_TOOL_NAMES/)
  assert.ok(stringLiteralsOf(source, 'EDITOR_TOOL_NAMES').length >= 4)
})

test('两侧的工具名逐元素相等（含顺序）', () => {
  const host = stringLiteralsOf(readFileSync(HOST_FILE, 'utf8'), 'EDITOR_TOOL_NAMES')
  assert.deepEqual(
    host,
    [...EDITOR_TOOL_NAMES],
    '服务端描述符与宿主处理器的名字漂移了。\n' +
      '服务端多一个 ⇒ 模型调它时客户端抛"未登记"；\n' +
      '客户端多一个 ⇒ 它永远进不了模型的工具表，而界面上一切正常（最坏的那种：' +
      '长得和"这个功能没做"一模一样）。',
  )
})

/*
 * 顺序也要一致：这份名单会经轮次协议上送服务端参与构成发给模型的工具表，
 * 顺序不稳 ⇒ 每轮请求前缀都变 ⇒ 上游前缀缓存全失效（本仓已多处记档）。
 */
test('两侧的顺序一致，且已排序（前缀缓存要求）', () => {
  const host = stringLiteralsOf(readFileSync(HOST_FILE, 'utf8'), 'EDITOR_TOOL_NAMES')
  assert.deepEqual(host, [...host].sort(), '宿主侧名单必须是有序的')
  assert.deepEqual([...EDITOR_TOOL_NAMES], [...EDITOR_TOOL_NAMES].sort(), '服务端名单必须是有序的')
})

test('宿主侧的 EDITOR_HANDLE_TOOL_NAMES 恰是"除 read_doc 外的三条"', () => {
  const host = stringLiteralsOf(readFileSync(HOST_FILE, 'utf8'), 'EDITOR_HANDLE_TOOL_NAMES')
  assert.deepEqual(
    [...host].sort(),
    EDITOR_TOOL_NAMES.filter((n) => n !== 'editor.read_doc').sort(),
    '没有编辑框句柄时不登记的那三条，必须与"能力由句柄提供"的那三条完全对应',
  )
})

test('本插件声明的 mutating 名单与"会改用户东西"的两条一致', () => {
  const source = stripComments(readFileSync(PLUGIN_FILE, 'utf8'))
  /*
   * 按 `name: 'editor.…'` 把源码切成一块块**描述符区间**（每块从自己的名字起、
   * 到下一个名字或文件尾为止），再问"这一块里有没有 `mutating: true`"。
   *
   * 不能用「name … 懒惰匹配到最近的 mutating」那种写法：读工具的块里没有 `mutating`，
   * 懒惰匹配会一路吃到**下面那条写工具**的 `mutating: true`，于是读工具被误判成写工具，
   * 而这条守卫的断言恰好是"写工具集合相等" —— 它会**恒真**，看起来还在检查。
   * （同源教训见文件头：把范围收窄比把正则写精巧可靠。）
   */
  const names = [...source.matchAll(/name: '(editor\.[a-z_]+)'/g)]
  const declared: string[] = []
  for (let i = 0; i < names.length; i++) {
    const start = names[i]!.index as number
    const end = i + 1 < names.length ? (names[i + 1]!.index as number) : source.length
    if (/mutating: true/.test(source.slice(start, end))) declared.push(names[i]![1] as string)
  }
  assert.deepEqual(
    declared,
    [...EDITOR_MUTATING_TOOL_NAMES],
    'mutating 标记与 MUTATING 名单漂移：自锁护栏与回退 UI 都看这份名单',
  )
})
