/**
 * 两处**配色/层叠适配**的守卫。
 *
 * ## 一、编辑器选区必须**画在内容之上**，而且必须**半透明**
 *
 * 这条判据换过一次，原因是第一次的**诊断是错的**（记录在此，避免再走一遍）：
 * 当时以为"选中了看不出来"只是配色不对，于是把 token 从 `--gw-accent-soft` 换成中间调的
 * `--gw-accent-soft-line`。**换完用户仍报「还是看不出来」** —— 因为真正的机制是：
 *
 *   - CodeMirror 的 `drawSelection` 把选区放进 `.cm-selectionLayer`，并用**行内样式**
 *     给它 `z-index: -1`（`layer({ above: false })`），即选区画在**正文下面**；
 *   - 而本编辑器有多处**不透明**底纹（活跃行、源码态代码块/表格、受限区段、
 *     实时渲染 widget），会把下面的选区**整块盖掉**；
 *   - 雪上加霜：库里那条
 *     `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
 *     有 **5 个类选择器**，本项目主题生成的 `.ͼX .cm-selectionBackground` 只有 2 个
 *     ⇒ **选中态下生效的一直是库的默认色**，换 token 根本不生效。
 *
 *   实测（headless Chrome 逐像素取色）：选区内与同行未选处**同为 `#eef2f7`**。
 *
 * 故现在的判据是两条**结构性**约束，缺一不可：
 *   1. `.cm-selectionLayer` 抬到内容之上（行内 `z-index` 只能靠 `!important` 覆盖），
 *      且**必须让出鼠标事件**（`pointer-events: none`），否则在选区上按下无法重新选择；
 *   2. 颜色走 `--gw-selection-bg` **并且带 `!important`**（同时解决上面那条优先级问题）。
 *
 * 还有一条**新引入的失败方式**必须一起钉住：选区的颜色不能是不透明的 ——
 * 它现在画在文字之上，不透明会把**被选中的字**盖掉，比"看不见选区"更糟。
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
/**
 * 剥 CSS/TS 块注释：解释"为什么不能这么写"的注释里必然引述旧写法。
 * 本轮尤其要紧 —— 上面那段说明里就写着 `.cm-selectionBackground` 和旧 token 名。
 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '')

test('★ 选区层必须抬到内容之上，并让出鼠标事件', () => {
  const ts = stripComments(readFileSync(join(SRC, 'components', 'MarkdownEditor.tsx'), 'utf8'))
  const rule = /'\.cm-selectionLayer':\s*\{([\s\S]*?)\}/.exec(ts)
  assert.ok(rule, '未找到 `.cm-selectionLayer` 主题规则（判据失效即红）')
  const body = rule[1] as string

  const z = /zIndex:\s*'(\d+)(\s*!important)?'/.exec(body)
  assert.ok(z, '`.cm-selectionLayer` 必须显式设置 z-index')
  assert.ok(
    z[2],
    'z-index 必须带 !important：CodeMirror 是用**行内样式**写 `z-index: -1` 的，' +
      '普通声明（连样式表里的高优先级也不行）盖不过行内样式',
  )
  assert.ok(
    Number(z[1]) > 0,
    '选区层必须在**内容之上**（正 z-index）：它默认是 -1，会被活跃行、' +
      '代码块、受限区段等不透明底纹整块盖掉 —— 这正是「选中了看不出来」的根因',
  )

  assert.match(
    body,
    /pointerEvents:\s*'none'/,
    '抬到内容之上后**必须**让出鼠标事件：否则在选区上按下会被这层吃掉，无法重新选择',
  )
})

test('★ 选区颜色必须走 --gw-selection-bg 且带 !important（否则被库的基础主题压过）', () => {
  const ts = stripComments(readFileSync(join(SRC, 'components', 'MarkdownEditor.tsx'), 'utf8'))
  const rule = /'\.cm-selectionBackground':\s*\{\s*backgroundColor:\s*'([^']+)'/.exec(ts)
  assert.ok(rule, '未找到 `.cm-selectionBackground` 主题规则（判据失效即红）')
  assert.equal(
    rule[1],
    'var(--gw-selection-bg) !important',
    '选区色必须取 `--gw-selection-bg` 且带 `!important`：库的基础主题有 5 个类选择器的' +
      '聚焦态规则（`#d7d4f0` / `#233`），不带 !important 就永远轮不到本项目的颜色 —— ' +
      '上一轮只换 token 看不出变化，一半原因就在这里',
  )
})

test('★ --gw-selection-bg 必须是**半透明**的，且浅色/深色都要有', () => {
  const css = stripComments(readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8'))
  const defs = [...css.matchAll(/--gw-selection-bg:\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim())
  assert.ok(
    defs.length >= 3,
    `--gw-selection-bg 必须定义三处（浅色 :root / 显式 .dark / 跟随系统深色的媒体查询），实得 ${defs.length} 处`,
  )

  for (const v of defs) {
    const alpha = alphaOf(v)
    assert.ok(alpha !== null, `无法解析 --gw-selection-bg 的透明度：${v}`)
    assert.ok(
      alpha < 1,
      `--gw-selection-bg 必须**半透明**（${v} 是不透明的）：选区现在画在文字**之上**，` +
        '不透明色会把被选中的字盖住 —— 那是比"看不见选区"更糟的失败方式',
    )
    assert.ok(alpha > 0, `--gw-selection-bg 不能完全透明（${v}），否则等于没有选区`)
  }
})

/** 取颜色值的 alpha：支持 `rgb(r g b / 30%)` 与 `rgba(r,g,b,0.3)`；无 alpha 返回 1，解析不了返回 null */
function alphaOf(value: string): number | null {
  const pct = /\/\s*([\d.]+)%\s*\)/.exec(value)
  if (pct) return Number(pct[1]) / 100
  const rgba = /^rgba?\([^)]*,\s*([\d.]+)\s*\)$/.exec(value.trim())
  if (rgba) return Number(rgba[1])
  if (/^(#|rgb\(|var\()/i.test(value.trim())) return /^rgba?\(/i.test(value.trim()) ? null : 1
  return null
}

test('★ React Flow 控件的颜色必须指到本项目 token（库默认只有浅色值）', () => {
  const css = stripComments(readFileSync(join(SRC, 'styles', 'xyflow.css'), 'utf8'))
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
