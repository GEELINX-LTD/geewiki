/**
 * 两处**配色适配**的守卫。
 *
 * ## 一、编辑器的选区必须与底色可分辨
 * 主题里曾用 `--gw-accent-soft` 画选区 —— 那是给"淡色底"（chip / 提示块）设计的 token：
 * 浅色 `#eff6ff`、深色 `#10203a`，与编辑区表面**亮度几乎一致** ⇒ 选中一片文字
 * **看不出来**（用户报的「选中文本不会表现出来」）。选区要的是"明确可分辨"。
 * 现在用中间调的 `--gw-accent-soft-line`（浅色 `--gw-blue-200` / 深色 `--gw-dk-blue-line`），
 * 两种模式都不需要额外分支。
 *
 * ## 二、React Flow 的控件必须挂在本项目的 token 上
 * 库用**自己的 CSS 变量**画控件（`--xy-controls-button-*`），默认只有浅色值；
 * 只在 Tailwind 类上写 `bg-surface` 是**无效的**（未分层规则压过分层规则）。
 * 故必须把这些变量指到 `--gw-*`，否则暗色模式下按钮仍是浅底深图标。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
/** 剥 CSS 注释：解释"为什么不能这么写"的注释里必然引述旧写法（本仓库踩过四次） */
const stripCss = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '')

test('★ 编辑器选区用的必须是中间调 token（用 accent-soft 会与底色几乎同亮度）', () => {
  const ts = readFileSync(join(SRC, 'components', 'MarkdownEditor.tsx'), 'utf8')
  const rule = /'\.cm-selectionBackground, ::selection':\s*\{\s*backgroundColor:\s*'([^']+)'/.exec(ts)
  assert.ok(rule, '未找到选区主题规则（判据失效即红）')
  assert.equal(
    rule[1],
    'var(--gw-accent-soft-line)',
    '选区要用中间调；用 --gw-accent-soft 会让选中范围在两种模式下都几乎看不见',
  )
})

test('★ React Flow 控件的颜色必须指到本项目 token（库默认只有浅色值）', () => {
  const css = stripCss(readFileSync(join(SRC, 'styles', 'xyflow.css'), 'utf8'))
  for (const v of [
    '--xy-controls-button-background-color',
    '--xy-controls-button-background-color-hover',
    '--xy-controls-button-color',
    '--xy-controls-button-border-color',
  ]) {
    const m = new RegExp(`${v}:\\s*([^;]+);`).exec(css)
    assert.ok(m, `${v} 必须被显式接上（否则暗色模式下按钮仍是库的浅色默认值）`)
    assert.match(m[1] as string, /var\(--gw-/, `${v} 必须指向 --gw-* token`)
  }
  // 未分层注入：库那份 style.css 是未分层的，分层规则会被它压过
  const index = readFileSync(join(SRC, 'styles', 'index.css'), 'utf8')
  assert.match(index, /@import '\.\/xyflow\.css';/, 'xyflow.css 必须以未分层方式 import')
  assert.doesNotMatch(index, /@import '\.\/xyflow\.css' layer\(/, '不要把它放进 @layer')
})
