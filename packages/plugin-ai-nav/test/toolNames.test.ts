/**
 * `open_page` / `scroll_to` 工具名的**镜像守卫**（P5）。
 *
 * 一条客户端工具是**两半点名同一个名字**：
 * - 服务端：本包 `src/index.ts` 的 `NAV_TOOL_NAMES`（描述符进模型的工具表）；
 * - 浏览器：`packages/web/src/lib/navTools.ts` 的 `NAV_TOOL_NAMES`（注册处理器）。
 *
 * 漂移的症状**完全是静默的**：
 * - 服务端多一个名字 ⇒ 模型会去调它 ⇒ 客户端 `invokeClientTool` 抛"未登记"；
 * - 客户端多一个名字 ⇒ 它进不了模型看到的工具表（交集 = 服务端 `side:'client'` 声明
 *   ∩ 宿主登记），于是**那条工具永远不会被调用**，而界面上一切正常。
 *
 * 后一种更坏：它长得和"这个功能没做"一模一样。
 *
 * ## 扫描范围收窄（本仓踩过三次的坑）
 * `navTools.ts` 与 `clientTools.ts` 的**文件头注释里就写着** `open_page` /
 * `scroll_to` 这些名字（它们在举例子）。若在整个文件里 `indexOf`，会先命中注释里那份。
 * 故这里的读法是：**先用状态机剥注释，再只在 `export const NAV_TOOL_NAMES` 的
 * `=` 之后的数组字面量里取字面量**。
 *
 * `stringLiteralsOf` 里那句"先跳过 `=`"也是踩出来的：类型标注里就有方括号
 * （`readonly string[]`），直接找名字之后的第一个 `[` 会取到**类型**那对空方括号，
 * 于是函数安静地返回 `[]`、守卫从此恒真——**比误报更糟，因为它看起来还在检查**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAV_TOOL_NAMES } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_FILE = join(HERE, '..', '..', 'web', 'src', 'lib', 'navTools.ts')
const PLUGIN_FILE = join(HERE, '..', 'src', 'index.ts')

/** 剥注释：状态机而不是正则（正则版会在 `'https://x'` 上把 `//` 当注释起点，守卫会静默变松） */
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

/** 取 `export const <name> = [ … ]` 里的字符串字面量（**先跳过 `=`**，见文件头） */
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
  return [...clean.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
}

test('宿主侧的 navTools.ts 读得到（守卫的第一件事是证明它真的读了文件）', () => {
  const source = readFileSync(HOST_FILE, 'utf8')
  assert.match(source, /export const NAV_TOOL_NAMES/)
  assert.equal(stringLiteralsOf(source, 'NAV_TOOL_NAMES').length, 2)
})

test('★ 两侧的工具名逐元素相等（含顺序）', () => {
  const host = stringLiteralsOf(readFileSync(HOST_FILE, 'utf8'), 'NAV_TOOL_NAMES')
  assert.deepEqual(
    host,
    [...NAV_TOOL_NAMES],
    '服务端描述符与宿主处理器的名字漂移了。\n' +
      '服务端多一个 ⇒ 模型调它时客户端抛"未登记"；\n' +
      '客户端多一个 ⇒ 它永远进不了模型的工具表，而界面上一切正常。',
  )
})

/*
 * 顺序也要一致：这份名单会经轮次协议上送服务端参与构成发给模型的工具表
 * （`resolveTurnTools` 做交集、`clientToolNames()` 排序），顺序不稳 ⇒
 * 每轮请求前缀都变 ⇒ 上游前缀缓存全失效（本仓已多处记档）。
 */
test('两侧的顺序一致且已排序（前缀缓存要求）', () => {
  const host = stringLiteralsOf(readFileSync(HOST_FILE, 'utf8'), 'NAV_TOOL_NAMES')
  assert.deepEqual(host, [...host].sort(), '宿主侧名单必须是有序的')
  assert.deepEqual([...NAV_TOOL_NAMES], [...NAV_TOOL_NAMES].sort(), '服务端名单必须是有序的')
})

test('★ 守卫：两条都是 side:client 且都**不是** mutating（跳转不改数据，标了会让回退 UI 出现点了没反应的条目）', () => {
  const source = stripComments(readFileSync(PLUGIN_FILE, 'utf8'))
  const names = [...source.matchAll(/name: '([a-z_]+)'/g)]
  assert.equal(names.length, 2, '本插件应恰好贡献两条工具')
  for (let i = 0; i < names.length; i++) {
    const start = names[i]!.index as number
    const end = i + 1 < names.length ? (names[i + 1]!.index as number) : source.length
    const block = source.slice(start, end)
    const name = names[i]![1] as string
    assert.ok(/side: 'client'/.test(block), `${name} 必须是客户端工具`)
    assert.ok(!/mutating: true/.test(block), `${name} 不该是 mutating：跳转与滚动改的不是数据`)
  }
})
