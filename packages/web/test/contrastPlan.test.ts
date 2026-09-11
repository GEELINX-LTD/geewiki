/**
 * 对比度守卫：把「设计 token 是否达 WCAG AA」变成可执行断言。
 *
 * 起因：axe-core 审计在浅色主题下命中 283 个 `color-contrast`（serious）节点，
 * 根因**全部**收敛到同一个 token（`--gw-ink-muted`）。逐个页面肉眼检查抓不住这类
 * "一个 token 决定成百个节点"的问题，故写成断言。
 *
 * 数据来源：**直接读 `styles/tokens.css` 源文本**（而非手抄一份值）——本仓库既有的
 * 跨包镜像守卫（`degradedReason.test.ts`、`slots.test.ts`）都是这个做法，避免同义反复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AA_TEXT_MIN, KNOWN_FAILING_TEXT_TOKENS, LIGHT_TEXT_BACKGROUNDS, contrastRatio } from '../src/lib/contrastPlan'

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')

/**
 * 只取**浅色主题块**。tokens.css 里 `:root` 与 `.dark` / `prefers-color-scheme` 都定义了
 * 同名 token（浅色 gray-600、深色 gray-400），若整文件解析会 last-write-wins 取到深色值，
 * 于是拿深色文字去和浅色背景算对比度——结论必然错。故显式切出浅色块。
 */
function lightThemeBlock(source: string): string {
  // 浅色主题 = 「第一个 `.dark {` 之前的全部内容」——它同时包含灰阶定义（首个 `:root`）
  // 与浅色语义别名（第二个 `:root`）。深色在 `.dark` / `prefers-color-scheme: dark` 里重定义
  // 同名 token（如 --gw-ink-muted 用 gray-400），若整文件解析会 last-write-wins 取到深色值，
  // 于是拿深色文字去和浅色背景算对比度——结论必然错。
  const cut = source.indexOf('.dark {')
  assert.ok(cut > 0, 'tokens.css 里未找到 `.dark {` 块，无法切出浅色主题')
  return source.slice(0, cut)
}
const lightCss = lightThemeBlock(css)

/** 从 tokens.css 解析 `--gw-<name>: <value>` 到映射（含灰阶与语义别名）。 */
function parseTokens(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of source.matchAll(/--gw-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|var\(--gw-[a-z0-9-]+\))/g)) {
    out.set(`--gw-${m[1]}`, m[2] as string)
  }
  return out
}

/** 解析到最终十六进制值（跟随一层 var() 间接，与 tokens.css 的写法一致）。 */
function resolveHex(tokens: Map<string, string>, name: string): string | undefined {
  const raw = tokens.get(name)
  if (!raw) return undefined
  if (/^#/.test(raw)) return raw
  const inner = /var\((--gw-[a-z0-9-]+)\)/.exec(raw)
  return inner ? resolveHex(tokens, inner[1] as string) : undefined
}

test('相对亮度与对比度的实现符合 WCAG 已知值（防止公式写错导致守卫空洞通过）', () => {
  // 已知锚点：黑白 21:1；同色 1:1；#777 对白约 4.48:1（WCAG 文档常用的临界示例）
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21)
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1)
  const grey = contrastRatio('#767676', '#ffffff')
  assert.ok(grey > 4.5 && grey < 4.6, `#767676 对白应≈4.54，实际 ${grey.toFixed(3)}`)
  // 顺序无关
  assert.equal(contrastRatio('#000000', '#ffffff'), contrastRatio('#ffffff', '#000000'))
  // 非法输入必须是 NaN（调用方据此判失败），而不是静默返回 1 或 21
  assert.ok(Number.isNaN(contrastRatio('nope', '#ffffff')))
  assert.ok(Number.isNaN(contrastRatio('#fff', '#ffffff')))
})

test('浅色主题的正文文字 token 全部达 AA（4.5:1），已知例外仅限清单内', () => {
    // 灰阶定义在**第一个** `:root` 块（浅色块只写语义别名，如 --gw-ink: var(--gw-gray-850)），
  // 故解析时把「全文件的灰阶」与「浅色块的别名」合并——浅色块优先，保证取到浅色语义值。
  const tokens = new Map([...parseTokens(css), ...parseTokens(lightCss)])
  const textTokens = ['--gw-ink', '--gw-ink-soft', '--gw-ink-muted', '--gw-accent']

  const failing: string[] = []
  for (const name of textTokens) {
    const hex = resolveHex(tokens, name)
    assert.ok(hex, `${name} 未能在 tokens.css 中解析出十六进制值（token 改名或写法变化？）`)
    for (const bg of LIGHT_TEXT_BACKGROUNDS) {
      const ratio = contrastRatio(hex, bg)
      assert.ok(!Number.isNaN(ratio), `${name} 对 ${bg} 的对比度算出 NaN`)
      if (ratio < AA_TEXT_MIN) failing.push(name)
    }
  }

  // 「只允许变短」：清单外的 token 不得失败；清单内的失败项必须**确实**在失败
  const unexpected = failing.filter((n) => !(n in KNOWN_FAILING_TEXT_TOKENS))
  assert.deepEqual(unexpected, [], `以下 token 低于 ${AA_TEXT_MIN}:1 且不在已知清单内：${unexpected.join(', ')}`)

  const stale = Object.keys(KNOWN_FAILING_TEXT_TOKENS).filter((n) => !failing.includes(n))
  assert.deepEqual(
    stale,
    [],
    `这些 token 已达标（或已不在统计范围），请从 KNOWN_FAILING_TEXT_TOKENS 移除：${stale.join(', ')}`,
  )
})

test('已知失败清单的处置建议是可核算的：gray-600 确实全部达标', () => {
    // 灰阶定义在**第一个** `:root` 块（浅色块只写语义别名，如 --gw-ink: var(--gw-gray-850)），
  // 故解析时把「全文件的灰阶」与「浅色块的别名」合并——浅色块优先，保证取到浅色语义值。
  const tokens = new Map([...parseTokens(css), ...parseTokens(lightCss)])
  const gray600 = resolveHex(tokens, '--gw-gray-600')
  assert.ok(gray600, '未找到 --gw-gray-600（建议的替代值）')
  for (const bg of LIGHT_TEXT_BACKGROUNDS) {
    const ratio = contrastRatio(gray600, bg)
    assert.ok(ratio >= AA_TEXT_MIN, `--gw-gray-600 对 ${bg} 为 ${ratio.toFixed(2)}:1，未达 ${AA_TEXT_MIN}:1`)
  }
  // 仍应明显弱于正文色，保证"次要文字"的视觉层次不被抹平
  const ink = resolveHex(tokens, '--gw-ink')
  assert.ok(ink && contrastRatio(gray600, '#ffffff') < contrastRatio(ink, '#ffffff'), '替代值不应比正文色更强')
})
