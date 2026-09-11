/**
 * 编辑页「正文 / 预览」两个面板的**可命名区域**守卫。
 *
 * ## 这个测试防的是什么
 * `<section>` 只有在**具备可访问名称**时才映射为 `region` 地标；否则按 HTML-AAM 退化为
 * `generic` —— 也就是"写了个 section，但屏幕阅读器看不到它是个区域"。
 * 见 https://w3c.github.io/html-aam/ 的 section 行：
 *   "region role if the section element has an accessible name. Otherwise, the generic role."
 *
 * 于是这里存在两类**静默**失败，都只能靠静态断言抓住：
 *  1. `aria-labelledby` 指向一个**不存在**或**被改名**的 id ⇒ 可访问名称为空 ⇒ 退化 generic，
 *     **浏览器不报错、构建不失败、typecheck 也看不见**；
 *  2. 有人把面板改回裸 `<div>`，或在别处又用了同一个 id（重复 id ⇒
 *     `aria-labelledby` 取到第一个匹配，指向另一个元素）。
 *
 * 依据 W3C WAI《Headings》教程（预览区之所以要做成区域）原文：
 *   "Headings are useful for labeling page regions. Use `aria-labelledby` to associate
 *    headings with their page region… If the headings are visible, the regions are easy to
 *    identify for all users."
 *   https://www.w3.org/WAI/tutorials/page-structure/headings/
 *
 * ## ⚠️ 这个文件自己踩过的坑（务必保留这条注释）
 * 第一版用**常量的值**（`gw-editor-pane-label`）去正则匹配源码，而源码里写的是**标识符**
 * （`EDITOR_PANE_LABEL_ID`）⇒ 永远匹配 0 次、测试恒红。**"我以为源码里写的是值"就是一个
 * 未经验证的假设**；判据必须与源码的实际书写形态对齐。
 *
 * ## 引用形态的取舍
 * `refOf()` **同时接受**两种写法并**合计**计数：共享常量标识符（仓库惯例）与内联字面量
 * （`aria-labelledby="gw-editor-pane-label"`）。取"合计"而非"只认标识符"是为了避免
 * 内联字面量导致的**假失败**——它仍然是**一个**引用、语义等价；而"该用共享常量"是风格问题，
 * 不该由一个无障碍守卫来裁决（本文件要守的是"名字接得上、且只有一处"）。
 *
 * ## 为什么不会空洞通过
 * 1. 先断言 id 常量**确实存在且非空**（正则写坏 ⇒ 立刻红，而不是 `undefined === undefined`）；
 * 2. 断言两个 id **互不相同**（相同则 labelledby 会互相抢名字）；
 * 3. 断言 `aria-labelledby` 与 `id` 对每个面板**各恰好引用 1 次**——0 次说明接线丢了，
 *    ≥2 次说明重复 id；
 * 4. 断言承载 `aria-labelledby` 的 `<section>` 上**没有** `aria-label`（两名并存时
 *    `aria-labelledby` 胜出，写 `aria-label` 会让人误以为改了名字却无效——这类混淆要挡住）；
 * 5. 断言 `gw-split-pane` **不再是裸 div**（回归到脏 div 就红）。
 *
 * 真机 DOM 侧另有一组 CDP 断言（labelledby 目标存在且唯一、两条编辑器路径都成立、
 * AX 树里 role=region 且 name 非空）——本文件只做"源码接线正确"这一层，两层互补。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EDITOR_PANE_LABEL_ID, PREVIEW_PANE_LABEL_ID } from '../src/lib/domIds'

const here = dirname(fileURLToPath(import.meta.url))
const WIKI_PAGE = join(here, '..', 'src', 'pages', 'WikiPage.tsx')

/** 去掉 `/* … *\/` 与 `// …` 注释：注释里的示例代码不是生效代码（本仓库踩过这个坑） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 取出每个 `<section …>` 开标签的原始文本 */
function sectionOpenTags(src: string): string[] {
  const out: string[] = []
  const re = /<section\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[0])
  return out
}

/** 正则转义 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 一个 id 在 JSX 里的引用形态（**不含**属性名的花括号前缀，由调用方拼上）。
 *
 * 两种都接受：`{EDITOR_PANE_LABEL_ID}`（共享常量）与 `"gw-editor-pane-label"`（内联字面量）。
 */
function refBody(ident: string, value: string): string {
  return `\\{${esc(ident)}\\}|"${esc(value)}"`
}

/** 统计 `attr`（`aria-labelledby` / `id`）对给定面板标注的引用次数 */
function countRefs(src: string, attr: string, ident: string, value: string): number {
  // `(?<![\w-])` 防止把别的属性名里的 `id=` 误当成本属性（例如 `data-id=`）
  const re = new RegExp(`${attr}=(?:${refBody(ident, value)})`, 'g')
  return src.match(re)?.length ?? 0
}

const rawPage = readFileSync(WIKI_PAGE, 'utf8')
const page = stripComments(rawPage)

/** 面板定义：中文名 + 常量标识符 + 常量值（值从导入的常量取，避免手抄漂移） */
const PANES = [
  { label: '正文', ident: 'EDITOR_PANE_LABEL_ID', value: EDITOR_PANE_LABEL_ID },
  { label: '预览', ident: 'PREVIEW_PANE_LABEL_ID', value: PREVIEW_PANE_LABEL_ID },
] as const

/* --------------------------- 1. 常量本身 --------------------------- */

test('两个面板标注 id 存在、非空、互不相同', () => {
  for (const { ident, value } of PANES) {
    assert.equal(typeof value, 'string', `${ident} 应当是字符串`)
    // 正则写坏时最容易出现"两侧都 undefined ⇒ 相等 ⇒ 静默通过"，故显式挡住空值
    assert.ok(value.length > 0, `${ident} 不能为空——aria-labelledby 指向空 id 等于没有名字`)
  }
  assert.notEqual(
    EDITOR_PANE_LABEL_ID,
    PREVIEW_PANE_LABEL_ID,
    '两个面板的标注 id 必须不同，否则它们会互相抢同一个可访问名称',
  )
})

/* ----------------------- 2. 源码接线：section 与 id ----------------------- */

test('源码守卫：两个面板各自是带 aria-labelledby 的 <section>，且 id 唯一', () => {
  // 反空洞：组件文件本应很大，读空了说明路径错了
  assert.ok(page.length > 5000, `WikiPage.tsx 读入异常（仅 ${page.length} 字符），路径可能不对`)

  const sections = sectionOpenTags(page)
  assert.ok(
    sections.length >= 2,
    `组件里应至少有两个 <section>（正文 / 预览），实际 ${sections.length} 个`,
  )

  for (const { label, ident, value } of PANES) {
    const labelled = countRefs(page, 'aria-labelledby', ident, value)
    const idRefs = countRefs(page, '(?<![\\w-])id', ident, value)

    assert.equal(
      labelled,
      1,
      `${label}面板：aria-labelledby 应恰好引用 ${ident} 1 次，实际 ${labelled}（0 次=接线丢了）`,
    )
    assert.equal(
      idRefs,
      1,
      `${label}面板：id 应恰好引用 ${ident} 1 次（0 次=名字没了；≥2 次=重复 id 会让 labelledby 指向错误元素），实际 ${idRefs}`,
    )

    // 承载 aria-labelledby 的必须是一个 <section>，而不是别的元素
    const owner = sections.filter(
      (s) => countRefs(s, 'aria-labelledby', ident, value) === 1,
    )
    assert.equal(owner.length, 1, `${label}面板：应有且仅有 1 个 <section> 承载该 aria-labelledby`)
    const tag = owner[0] as string
    // 同时写 aria-label 会让人以为改了名字，但 aria-labelledby 优先级更高 ⇒ 静默无效
    assert.ok(
      !/aria-label=/.test(tag),
      `${label}面板：不要同时写 aria-label 与 aria-labelledby（后者优先，前者会被静默忽略）`,
    )
  }
})

test('源码守卫：面板不再是裸 div（gw-split-pane 必须落在 <section> 上）', () => {
  // 回归信号：有人把 <section> 改回 div，只剩下"有 class 但不可命名"的容器
  const barePaneDiv = page.match(/<div[^>]*gw-split-pane[^>]*>/g) ?? []
  assert.equal(
    barePaneDiv.length,
    0,
    `gw-split-pane 不应再出现在裸 <div> 上（面板必须是 <section aria-labelledby>），实际 ${barePaneDiv.length} 处`,
  )
  const paneSections = sectionOpenTags(page).filter((s) => s.includes('gw-split-pane'))
  assert.equal(paneSections.length, 2, `两个面板的 <section> 都应保留 gw-split-pane 类名，实际 ${paneSections.length}`)
})
