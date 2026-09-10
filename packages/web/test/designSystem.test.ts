/**
 * 设计系统地基的纯逻辑单测。
 *
 * 覆盖两类"容易悄悄坏掉"的东西：
 *  1. **index.html 内联主题脚本 与 src/lib/theme.ts 的约定一致性** ——
 *     两处各写了一份存储键名/取值语义，任一处改动而另一处没跟上，症状是
 *     "深色模式时好时坏/刷新后跳回浅色"，而且只在真浏览器里才看得见。
 *     这里直接读 index.html 的源码来钉住它。
 *  2. **展示与主题工具的边界值** —— 非法输入不得吐出 "NaN 秒" 之类的文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { formatUptime } from '../src/lib/format'
import { THEME_STORAGE_KEY, isThemeChoice } from '../src/lib/theme'

const here = dirname(fileURLToPath(import.meta.url))
const htmlPath = join(here, '..', 'index.html')

/* ------------------------ 主题：内联脚本一致性 ------------------------ */

test('主题：index.html 的内联脚本与 theme.ts 使用同一个存储键名', () => {
  const html = readFileSync(htmlPath, 'utf8')
  assert.ok(
    html.includes(`'${THEME_STORAGE_KEY}'`),
    `index.html 的内联脚本应引用 '${THEME_STORAGE_KEY}'（实际未找到；两处键名不一致会导致刷新后主题丢失）`,
  )
})

test('主题：index.html 内联脚本存在、位于 head 内且同步执行（无 type=module / defer / async）', () => {
  const html = readFileSync(htmlPath, 'utf8')
  const headEnd = html.indexOf('</head>')
  const script = html.indexOf("localStorage.getItem('" + THEME_STORAGE_KEY + "')")
  assert.ok(script > 0, '应能找到读取主题存储的脚本')
  assert.ok(script < headEnd, '主题脚本必须在 </head> 之前（否则会先绘制一帧再变色 → 白闪）')

  // 取该脚本所在 <script ...> 开标签，断言它是同步的 classic script：
  // 一旦被改成 module/defer/async，执行时机就晚于首次绘制，白闪会回来。
  const openTagStart = html.lastIndexOf('<script', script)
  const openTag = html.slice(openTagStart, html.indexOf('>', openTagStart) + 1)
  assert.ok(!/type\s*=\s*["']module["']/.test(openTag), `主题脚本不得为 module：${openTag}`)
  assert.ok(!/\bdefer\b/.test(openTag), `主题脚本不得 defer：${openTag}`)
  assert.ok(!/\basync\b/.test(openTag), `主题脚本不得 async：${openTag}`)
})

test('主题：index.html 的 import map 仍先于任何 module script（插件单例不变量）', () => {
  const html = readFileSync(htmlPath, 'utf8')
  const importmap = html.indexOf('type="importmap"')
  assert.ok(importmap > 0, 'index.html 必须保留 import map（插件 bundle 依赖它解析 react）')
  // 找第一个 type="module" 的 script
  const moduleRe = /<script[^>]*type\s*=\s*["']module["'][^>]*>/g
  const first = moduleRe.exec(html)
  assert.ok(first !== null, 'index.html 应有 module script（应用入口）')
  assert.ok(
    importmap < first.index,
    'import map 必须在第一个 module script 之前，否则插件 bundle 会解析不到 react',
  )
})

test('主题：import map 仍位于 head 的第一个元素位置（允许其前只有注释/空白）', () => {
  const html = readFileSync(htmlPath, 'utf8')
  const headStart = html.indexOf('<head>')
  const importmap = html.indexOf('<script type="importmap">')
  assert.ok(headStart > 0 && importmap > headStart, '应在 head 内找到 import map')
  const between = html.slice(headStart + '<head>'.length, importmap)
  // 去掉注释与空白后应为空 —— 即 import map 是 head 的第一个**元素**
  const stripped = between.replace(/<!--[\s\S]*?-->/g, '').trim()
  assert.equal(stripped, '', `import map 之前不应有其它元素，实际：${JSON.stringify(stripped.slice(0, 120))}`)
})

/* ------------------------ 主题：取值判定 ------------------------ */

test('isThemeChoice：只接受三态字面量，其余（含 null/大小写变体）为假', () => {
  assert.equal(isThemeChoice('light'), true)
  assert.equal(isThemeChoice('dark'), true)
  assert.equal(isThemeChoice('system'), true)
  for (const bad of [null, undefined, '', 'Light', 'DARK', 'auto', 0, {}, []]) {
    assert.equal(isThemeChoice(bad), false, `${JSON.stringify(bad)} 不应被当作合法主题`)
  }
})

/* ------------------------ formatUptime ------------------------ */

test('formatUptime：各量级下输出人话，且绝不出现 NaN/负值', () => {
  assert.equal(formatUptime(0), '0 秒')
  assert.equal(formatUptime(45), '45 秒')
  assert.equal(formatUptime(60), '1 分钟')
  assert.equal(formatUptime(3599), '59 分钟')
  assert.equal(formatUptime(3600), '1 小时 0 分钟')
  assert.equal(formatUptime(3660), '1 小时 1 分钟')
  assert.equal(formatUptime(86400), '1 天 0 小时')
  assert.equal(formatUptime(86400 + 4 * 3600), '1 天 4 小时')
  assert.equal(formatUptime(3 * 86400 + 4 * 3600), '3 天 4 小时')
})

test('formatUptime：非法输入回退「未知」而不是 NaN', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, -0.5]) {
    assert.equal(formatUptime(bad), '未知', `${String(bad)} 应回退为「未知」`)
  }
  // 小数向下取整（不四舍五入：运行 1.9 秒说"1 秒"比说"2 秒"更诚实）
  assert.equal(formatUptime(1.9), '1 秒')
})
