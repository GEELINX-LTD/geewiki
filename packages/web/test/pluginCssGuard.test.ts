/**
 * **插件 CSS 的颜色纪律 + 主题对比度告警**（P10）的守卫。
 *
 * ## 两件事，两个理由
 * 1. **硬编码颜色必须被挡下**（`pluginCssPlan.ts`）：一处写死的颜色会同时破坏
 *    深色模式、主题覆盖与对比度诊断（详见该文件头）。判据是精确的——
 *    把 `var(...)` 整体摘掉后再找颜色字面量，于是夹具约定的
 *    `var(--gw-accent-soft-ink, #1d4ed8)` 合法、`color: #1d4ed8` 违规。
 * 2. **对比度必须可见**（`pluginTheme.ts` 的 `themeContrastIssues`）：糟糕主题不阻断注册
 *    （判据是运维，不是宿主），但必须能在管理台看到——否则用户只知道"字看不清"。
 *
 * ## 为什么扫描真实文件而不是只看纯函数
 * 纯函数测试只能证明"扫描器会红"，证明不了"仓库里的插件样式现在是干净的"。
 * 两者都要：前者防判据退化（改坏了正则还全绿），后者防有人再写回硬编码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_COLOR_KEYWORDS,
  NAMED_COLORS,
  findColorLiteral,
  hardcodedColors,
  stripVarCalls,
} from '../src/lib/pluginCssPlan'
import {
  __resetThemesForTest,
  contrastIssuesIn,
  registerTheme,
  themeContrastIssues,
} from '../src/lib/pluginTheme'
import { AA_TEXT_MIN } from '../src/lib/contrastPlan'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const REPO = join(WEB, '..', '..')

/* ------------------------- 扫描器判据（含阴性对照） ------------------------- */

test('★ P10：扫描器抓硬编码颜色 —— hex / rgb() / hsl() / 具名色都抓得到', () => {
  const cases: readonly [string, string][] = [
    ['color: #ff0000;', '#ff0000'],
    ['color: #f00;', '#f00'],
    ['background: rgb(255 0 0);', 'rgb()'],
    ['background: rgba(0, 0, 0, 0.5);', 'rgba()'],
    ['color: hsl(210 40% 20%);', 'hsl()'],
    ['color: oklch(0.7 0.1 200);', 'oklch()'],
    ['border: 1px solid red;', 'red'],
    ['box-shadow: 0 0 4px black;', 'black'],
    ['.x { color: white }', 'white'],
  ]
  for (const [css, expected] of cases) {
    const found = hardcodedColors(css)
    assert.equal(found.length, 1, `应当抓到一处硬编码：${css}（实际 ${JSON.stringify(found)}）`)
    assert.equal(found[0]!.color, expected, `命中的字面量不对：${css}`)
  }
})

test('★ P10：阴性对照 —— var() 引用（含回退值）与"非颜色"关键字不算违规', () => {
  const ok: readonly string[] = [
    'color: var(--gw-accent-soft-ink, #1d4ed8);',
    // 嵌套 var：回退值里还有一层 var —— 括号配对摘除，不能误报
    'color: var(--gw-a, var(--gw-b, #fff));',
    'background: transparent;',
    'color: currentColor;',
    'color: inherit;',
    'border: none;',
    'background: none;',
    'border-radius: 999px;',
    'display: inline-flex;',
    'font-family: ui-monospace, SFMono-Regular, Menlo, monospace;',
    '/* color: #ff0000; 注释里的颜色不算 */',
  ]
  for (const css of ok) {
    assert.deepEqual(hardcodedColors(css), [], `不应报违规：${css}`)
  }

  // 反向对照：确实存在"允许"与"违规"两类（否则上面每条断言都可能恒成立）
  assert.ok(ALLOWED_COLOR_KEYWORDS.includes('transparent'))
  assert.ok(NAMED_COLORS.includes('red'))
  assert.ok(!NAMED_COLORS.includes('transparent'), '允许列表与具名色列表不得重叠')
})

test('★ P10：stripVarCalls 按括号配对摘除（嵌套不残留、未闭合不抛）', () => {
  assert.equal(stripVarCalls('var(--a, var(--b, #fff))').trim(), '')
  assert.equal(stripVarCalls('1px solid var(--x)').trim(), '1px solid')
  assert.equal(stripVarCalls('var(--unclosed').trim(), '', '未闭合时整段丢弃，不抛错')
  assert.equal(findColorLiteral('1px solid'), null)
})

/* --------------------------- 真实插件样式的扫描 --------------------------- */

/** 插件侧 CSS 源文件（新增夹具时请加进来——否则新文件不受守卫约束） */
function pluginCssFiles(): string[] {
  const out: string[] = []
  const fixtures = join(WEB, 'fixtures')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name)
      if (name.isDirectory()) walk(full)
      else if (name.name.endsWith('.css')) out.push(full)
    }
  }
  walk(fixtures)
  // 插件自带的**构建产物**（`plugins/*/dist/client.css`）：存在就查，不存在跳过
  // （产物不入库，`build:fixtures` 才生成——与 pluginUi.test.ts 的 dist 检查同一姿态）
  const pluginsDir = join(REPO, 'plugins')
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const css = join(pluginsDir, name.name, 'dist', 'client.css')
      if (existsSync(css)) out.push(css)
    }
  }
  return out
}

test('★ P10：仓库里现有的插件 CSS 必须零硬编码颜色（含构建产物，若已生成）', () => {
  const files = pluginCssFiles()
  assert.ok(files.length >= 2, `至少应当扫到 2 个插件 CSS（实际 ${files.length}）——否则守卫是空转的`)

  const problems: string[] = []
  for (const file of files) {
    for (const hit of hardcodedColors(readFileSync(file, 'utf8'))) {
      problems.push(`${file.replace(REPO + '/', '')}:${hit.line} ${hit.declaration}（硬编码 ${hit.color}）`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `插件 CSS 里的颜色必须经 var(--gw-*) 取（可带回退值）：\n  ${problems.join('\n  ')}`,
  )
})

/* ------------------------------ 对比度告警 ------------------------------ */

test('★ P10：contrastIssuesIn 对不达标组合报警、对达标组合沉默', () => {
  // 不达标：浅灰字落在白底上（约 1.6:1）
  const bad = contrastIssuesIn({ '--gw-ink': '#cccccc', '--gw-surface': '#ffffff' })
  assert.equal(bad.length, 1)
  assert.equal(bad[0]!.text, '--gw-ink')
  assert.equal(bad[0]!.background, '--gw-surface')
  assert.ok(bad[0]!.ratio < AA_TEXT_MIN)
  assert.equal(bad[0]!.required, AA_TEXT_MIN)

  // 达标：深灰字落在白底上
  assert.deepEqual(contrastIssuesIn({ '--gw-ink': '#333333', '--gw-surface': '#ffffff' }), [])

  // 算不出来的值（var 链 / 具名色）**跳过**而不是报失败——报告噪声比漏报更坏
  assert.deepEqual(contrastIssuesIn({ '--gw-ink': 'var(--gw-gray-800)', '--gw-surface': '#ffffff' }), [])
  assert.deepEqual(contrastIssuesIn({ '--gw-ink': '#333', '--gw-surface': '#ffffff' }), [], '只认 6 位 hex')
})

test('★ P10：registerTheme 提交的坏主题 —— 注册照常生效，但对比度问题可见', () => {
  __resetThemesForTest()
  try {
    const off = registerTheme('@demo/bad-theme', {
      name: '糟糕主题',
      light: { '--gw-ink': '#cccccc', '--gw-surface': '#ffffff' },
    })

    // ① 不阻断注册（设计文档 §7.4：最终判据是运维，不是宿主）
    assert.equal(themeContrastIssues().length, 1, '坏主题必须被报告')
    const issue = themeContrastIssues()[0]!
    assert.equal(issue.owner, '@demo/bad-theme')
    assert.equal(issue.name, '糟糕主题')
    assert.equal(issue.mode, 'light')
    assert.ok(issue.ratio < AA_TEXT_MIN)

    // ② 卸载后告警随之消失（不留残影）
    off()
    assert.deepEqual(themeContrastIssues(), [])
  } finally {
    __resetThemesForTest()
  }
})

test('★ P10：达标主题不产生告警（反向对照，防"恒报警"）', () => {
  __resetThemesForTest()
  try {
    registerTheme('@demo/good-theme', {
      light: { '--gw-ink': '#1f2937', '--gw-surface': '#ffffff' },
      dark: { '--gw-ink': '#e8eef6', '--gw-surface': '#111827' },
    })
    assert.deepEqual(themeContrastIssues(), [])
  } finally {
    __resetThemesForTest()
  }
})
