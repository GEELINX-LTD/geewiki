/**
 * dock 头部三个动作（历史 / 新对话 / 收起）的**图标化**与**可访问名**源码守卫。
 *
 * ## 为什么是源码守卫
 * 用户的要求是「都以图标来显示，不要文字」。这一改动的风险全在**看不见的地方**：
 * 图标按钮没有可见文字，`aria-label` 就成了**唯一**的可访问名来源——漏一个，读屏只会
 * 念"按钮"；历史的条数随文字一起丢掉，用户就再也看不出有几段历史。
 * 这两件事都不会让任何渲染测试变红，界面看起来也完全正常（对看得见的人尤其正常）。
 *
 * 本仓前端测试约定：`.tsx` / `.css` 只当源文本读、不 import（见 `pluginUi.test.ts`）。
 *
 * ## 各条守卫对应的事实
 *   ① 三个按钮都必须是 `gw-dock-icon`（不是 `.gw-dock-link`），且**按钮文字已经清空**——
 *      只留 `<svg>` 与数字角标：把"历史（3）"加回去是最自然的回退写法，也是对需求的违背。
 *   ② 每个按钮必须有非空 `aria-label`，并带 `title`（看得见的人的悬停提示）。
 *   ③ 历史条数不能随文字丢掉：`aria-label` 里必须插值 `history.length`，且角标自己
 *      `aria-hidden`（否则读屏把条数念两遍）。
 *   ④ 图标是**装饰**：每个 svg 都必须 `aria-hidden="true"`，不许成为可访问名的一部分。
 *   ⑤ 图标按钮靠悬停底色表达可点（图标没有下划线可依），故 CSS 里必须有 `.gw-dock-icon`
 *      的底色规则与 `:focus-visible`；且它得在"减少动效"清单里（有 transition 就受影响）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const UI_FILE = join(here, '..', 'ui', 'index.tsx')
const ICONS_FILE = join(here, '..', 'ui', 'icons.tsx')
const CSS_FILE = join(here, '..', 'ui', 'style.css')

const uiSource = readFileSync(UI_FILE, 'utf8')
const iconsSource = readFileSync(ICONS_FILE, 'utf8')
const css = readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 头部三个动作的按钮块（按 aria-label 定位，避免依赖书写顺序） */
function buttonBlock(label: string): string {
  const at = uiSource.indexOf(label)
  assert.ok(at >= 0, `ui/index.tsx 里找不到 ${label} —— 结构变了，守卫已失效，不得静默通过`)
  const open = uiSource.lastIndexOf('<button', at)
  const close = uiSource.indexOf('</button>', at)
  assert.ok(open >= 0 && close > open, `${label} 所在的 <button> 块没有闭合`)
  return uiSource.slice(open, close + '</button>'.length)
}

/** 跳过一段 `{…}` 表达式（含嵌套、含其中的字符串），返回它后面的位置 */
function skipBraces(s: string, at: number): number {
  let depth = 0
  for (let i = at; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === '`' || c === "'") {
      const end = s.indexOf(c, i + 1)
      i = end < 0 ? s.length : end
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return s.length
}

/**
 * 取一段 JSX 里的**文本节点**：跳过标签、引号里的属性值、`{…}` 表达式。
 *
 * 为什么不能图省事写 `block.replace(/<[^>]*>/g, '')`：属性里的箭头函数
 * （`onClick={() => …}`）带着一个 `>`，那条正则会在 `=>` 处把"标签"截断，
 * 于是 `aria-label="收起"` 这些**属性值**会被当成可见文字——本守卫第一版就是这么
 * 假红的（报「按钮里有文字：setOpen(false)}aria-label="收起"」）。
 */
function textNodes(jsx: string): string {
  let out = ''
  let inTag = false
  for (let i = 0; i < jsx.length; ) {
    const c = jsx[i] as string
    if (inTag) {
      if (c === '"' || c === "'") {
        const end = jsx.indexOf(c, i + 1)
        i = end < 0 ? jsx.length : end + 1
        continue
      }
      if (c === '{') { i = skipBraces(jsx, i); continue }
      if (c === '>') { inTag = false; i++; continue }
      i++
      continue
    }
    if (c === '<') { inTag = true; i++; continue }
    if (c === '{') { i = skipBraces(jsx, i); continue }
    out += c
    i++
  }
  return out
}

const HISTORY_LABEL = 'aria-label={`历史（${history.length}）`}'
const LABELS = ['aria-label="收起"', 'aria-label="新对话"', HISTORY_LABEL]

/* ============================ ①② 图标化 + 可访问名 ============================ */

test('① 三个头部动作都是图标按钮，且按钮里已经没有可见文字', () => {
  for (const label of LABELS) {
    const block = buttonBlock(label)
    assert.match(block, /className=\{?`?"?gw-dock-icon/, `${label} 不是图标按钮（className 里没有 gw-dock-icon）`)
    assert.ok(!/gw-dock-link/.test(block), `${label} 还用着文字链接样式 .gw-dock-link`)
    assert.match(block, /<svg|<[A-Z]\w*Icon/, `${label} 里没有图标组件`)
    const text = textNodes(block).replace(/\s+/g, '')
    assert.equal(text, '', `${label} 的按钮里出现了可见文字「${text}」——图标按钮不该有文字`)
  }
})

test('② 每个图标按钮都有非空 aria-label 与 title（图标按钮的唯一可访问名来源）', () => {
  for (const label of LABELS) {
    const block = buttonBlock(label)
    assert.match(block, /aria-label=\{?[`"']/, `${label} 所在的按钮缺 aria-label：读屏只会念"按钮"`)
    assert.match(block, /title="[^"]+"/, `${label} 所在的按钮缺 title：看得见的人没有悬停提示`)
  }
})

/* ============================ ③ 条数不能丢 ============================ */

test('③ 历史条数仍在可访问名里，角标自己 aria-hidden（否则念两遍）', () => {
  const block = buttonBlock(HISTORY_LABEL)
  assert.match(block, /aria-label=\{`历史（\$\{history\.length\}）`\}/, '历史按钮的 aria-label 必须插值 history.length')
  assert.match(block, /className="gw-dock-count"\s+aria-hidden="true"/, '条数角标必须 aria-hidden（可访问名里已经念过）')
  assert.match(block, /aria-expanded=\{historyOpen\}/, '历史按钮必须用 aria-expanded 表达"面板开着"，不能只靠颜色')
})

/* ============================ ④ 图标只是装饰 ============================ */

test('④ 图标 svg 都 aria-hidden（可访问名由按钮提供，不重复朗读）', () => {
  const svgs = iconsSource.match(/const BASE[\s\S]*?\n\}/)
  assert.ok(svgs, 'ui/icons.tsx 里找不到共用的 BASE 属性对象——结构变了，守卫已失效')
  assert.match(svgs[0], /'aria-hidden':\s*true/, 'BASE 里必须 aria-hidden: true')
  assert.match(svgs[0], /focusable:\s*'false'/, 'BASE 里必须 focusable: "false"')
  // 反向对照：每个导出图标都必须走 BASE（自己手写 svg 属性就会漏掉 aria-hidden）
  const exported = [...iconsSource.matchAll(/export function (\w+)\(\) \{\n\s*return \(\n\s*<svg \{\.\.\.BASE\}/g)].map((m) => m[1])
  /*
   * 这份清单是**枚举**而非"至少包含"：新增图标必须显式登记，否则它掉了 BASE 也没人发现。
   * 2026-09-16 新增 `ChevronIcon`（工具摘要行的展开指示）——它同样只是装饰，
   * 可访问名由那个 `aria-expanded` 按钮提供。
   */
  assert.deepEqual(
    exported.sort(),
    ['ChevronIcon', 'CollapseIcon', 'HistoryIcon', 'NewChatIcon'],
    `每个图标都必须展开 BASE（当前：${exported.join(' / ')}）——手写属性会漏掉 aria-hidden`,
  )
})

/* ============================ ⑤ 可点性靠底色 ============================ */

test('⑤ 图标按钮的悬停/焦点/减少动效都在 CSS 里', () => {
  assert.match(css, /\.gw-dock-icon:hover\b[\s\S]*?background:\s*var\(--color-hover\)/, '图标按钮必须靠悬停底色表达可点')
  assert.match(css, /\.gw-dock-icon-on\b[\s\S]*?background:\s*var\(--color-hover\)/, '"历史面板开着"必须有常驻底色')
  assert.match(css, /\.gw-dock-icon:focus-visible\b/, '图标按钮缺 :focus-visible（键盘用户看不见焦点）')
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
  const guard = css.slice(css.indexOf('{', at), css.indexOf('}', css.indexOf('{', at)))
  assert.ok(guard.includes('.gw-dock-icon'), '.gw-dock-icon 有 transition，必须在"减少动效"清单里')
  assert.ok(!/\.gw-dock-link\s*\{/.test(css), '.gw-dock-link 已经是死规则，应当删掉（留着会让人以为还有文字链接）')
})
