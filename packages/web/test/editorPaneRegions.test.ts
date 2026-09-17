/**
 * 编辑页「正文 / 预览」两个面板的**可命名区域**守卫（单栏改版后的版本）。
 *
 * ## 这个测试防的是什么
 * `<section>` 只有在**具备可访问名称**时才映射为 `region` 地标；否则按 HTML-AAM 退化为
 * `generic` —— 也就是"写了个 section，但屏幕阅读器看不到它是个区域"。
 * 见 https://w3c.github.io/html-aam/ 的 section 行：
 *   "region role if the section element has an accessible name. Otherwise, the generic role."
 * 同理，`aria-labelledby` 加在**没有角色**的元素上会被忽略（generic 元素不接受可访问名称），
 * 所以预览那个滚动容器必须显式写 `role="region"`。
 *
 * 于是这里有四类**静默**失败，都只能靠静态断言抓住：
 *  1. `aria-labelledby` 指向一个**不存在**或**被改名**的 id ⇒ 可访问名称为空 ⇒ 退化 generic，
 *     **浏览器不报错、构建不失败、typecheck 也看不见**；
 *  2. 有人把面板改回裸 `<div>`，或在别处又用了同一个 id（重复 id ⇒
 *     `aria-labelledby` 取到第一个匹配，指向另一个元素）；
 *  3. 预览被从 Dialog 里搬出去、或 `role="region"` 被顺手删掉；
 *  4. 「标记不合法 ⇒ 保存会被服务端拒绝」这条**保存阻断**提示被挪进预览里 ——
 *     那样不打开预览就看不到"保存必然失败"，作者写完一大段才被 400 拒绝。
 *
 * 依据 W3C WAI《Headings》教程（预览区之所以要做成区域）原文：
 *   "Headings are useful for labeling page regions. Use `aria-labelledby` to associate
 *    headings with their page region… If the headings are visible, the regions are easy to
 *    identify for all users."
 *   https://www.w3.org/WAI/tutorials/page-structure/headings/
 *
 * ## 布局改版（本版重写的原因）
 * 编辑页不再是左右分栏：`gw-split-pane` / `setPane` / `xl:grid-cols-2` 全部消失，
 * 正文是**单栏** `<section aria-labelledby={EDITOR_PANE_LABEL_ID}>`，预览搬进
 * 「按访客视角预览」的 Dialog。因此旧守卫里"两个面板的 `<section>` 都应保留
 * `gw-split-pane` 类名"这一条已不成立，换成"分栏痕迹一处都不剩"（见第 4 条）。
 *
 * ## ⚠️ 这个文件自己踩过的坑（务必保留这条注释）
 * 第一版用**常量的值**（`gw-editor-pane-label`）去正则匹配源码，而源码里写的是**标识符**
 * （`EDITOR_PANE_LABEL_ID`）⇒ 永远匹配 0 次、测试恒红。**"我以为源码里写的是值"就是一个
 * 未经验证的假设**；判据必须与源码的实际书写形态对齐。
 *
 * ## 引用形态的取舍
 * `refBody()` **同时接受**两种写法并**合计**计数：共享常量标识符（仓库惯例）与内联字面量
 * （`aria-labelledby="gw-editor-pane-label"`）。取"合计"而非"只认标识符"是为了避免
 * 内联字面量导致的**假失败**——它仍然是**一个**引用、语义等价；而"该用共享常量"是风格问题，
 * 不该由一个无障碍守卫来裁决（本文件要守的是"名字接得上、且只有一处"）。
 *
 * ## 为什么不会空洞通过
 * 1. 先断言 id 常量**确实存在且非空**（正则写坏 ⇒ 立刻红，而不是 `undefined === undefined`）；
 * 2. 断言两个 id **互不相同**（相同则 labelledby 会互相抢名字）；
 * 3. 断言 `aria-labelledby` 与 `id` 对每个面板**各恰好引用 1 次**——0 次说明接线丢了，
 *    ≥2 次说明重复 id；
 * 4. 断言正文面板的 `<section>` 上**没有** `aria-label`（两名并存时 `aria-labelledby` 胜出，
 *    写 `aria-label` 会让人误以为改了名字却无效——这类混淆要挡住）；
 * 5. 断言预览的引用元素**同时**带 `role="region"`，且整段落在预览 Dialog 之内；
 * 6. 断言保存阻断提示落在正文面板的 `<section>` 里、且排在预览 Dialog **之前**；
 * 7. 每条负向断言都先剥注释（注释里写"不要再用 `xl:grid-cols-2`"不该把自己测红）。
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

/**
 * 去掉注释：块注释（含 JSX 里的 `{/* … *\/}`）与行注释。
 *
 * `(?<!:)` 那处环视保住 `https://…` 这类字面量不被腰斩。
 * **负向断言必须先剥注释**：本文件头就写着 `gw-split-pane` / `setPane` / `xl:grid-cols-2`，
 * 不剥的话这几条会命中自己的说明文字 —— 本仓库反复踩过这个坑。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')
}

/** 取出每个 `<section …>` 开标签的原始文本 */
function sectionOpenTags(src: string): string[] {
  const out: string[] = []
  const re = /<section\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[0])
  return out
}

/**
 * 取出**包含** `needle` 的那个元素开标签：从它前面最近的 `<` 到该 `<` 之后的第一个 `>`。
 *
 * 用途是把"两个属性必须在**同一个元素**上"写成一条断言 —— 分别 `includes` 全文件是不够的：
 * 把 `role="region"` 写到兄弟节点上，两次 `includes` 依然全绿，而闸门实际已经失效。
 */
function openTagAround(src: string, needle: string): string {
  const at = src.indexOf(needle)
  if (at < 0) return ''
  const start = src.lastIndexOf('<', at)
  if (start < 0) return ''
  const end = src.indexOf('>', start)
  if (end < 0) return ''
  return src.slice(start, end + 1)
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
const EDITOR = { label: '正文', ident: 'EDITOR_PANE_LABEL_ID', value: EDITOR_PANE_LABEL_ID } as const
const PREVIEW = { label: '预览', ident: 'PREVIEW_PANE_LABEL_ID', value: PREVIEW_PANE_LABEL_ID } as const
const PANES = [EDITOR, PREVIEW] as const

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

/* ------------------- 2. 正文面板：<section> + 唯一 id ------------------- */

test('源码守卫：正文面板是带 aria-labelledby 的 <section>，且 id 恰好一处', () => {
  // 反空洞：组件文件本应很大，读空了说明路径错了
  assert.ok(page.length > 5000, `WikiPage.tsx 读入异常（仅 ${page.length} 字符），路径可能不对`)
  const sections = sectionOpenTags(page)
  assert.ok(sections.length >= 1, `反空洞：应能抽出 <section> 开标签（实际 ${sections.length} 个）`)

  const labelled = countRefs(page, 'aria-labelledby', EDITOR.ident, EDITOR.value)
  const idRefs = countRefs(page, '(?<![\\w-])id', EDITOR.ident, EDITOR.value)
  assert.equal(
    labelled,
    1,
    `${EDITOR.label}面板：aria-labelledby 应恰好引用 ${EDITOR.ident} 1 次，实际 ${labelled}（0 次=接线丢了；≥2 次=重复标注）`,
  )
  assert.equal(
    idRefs,
    1,
    `${EDITOR.label}面板：id 应恰好引用 ${EDITOR.ident} 1 次（0 次=名字没了；≥2 次=重复 id 会让 labelledby 指向错误元素），实际 ${idRefs}`,
  )

  // 承载 aria-labelledby 的必须是一个 <section>，而不是别的元素
  const owner = sections.filter((s) => countRefs(s, 'aria-labelledby', EDITOR.ident, EDITOR.value) === 1)
  assert.equal(
    owner.length,
    1,
    `${EDITOR.label}面板：应有且仅有 1 个 <section> 承载该 aria-labelledby（实际 ${owner.length}）`,
  )
  const tag = owner[0] as string
  // 同时写 aria-label 会让人以为改了名字，但 aria-labelledby 优先级更高 ⇒ 静默无效
  assert.ok(
    !/aria-label=/.test(tag),
    `${EDITOR.label}面板：不要同时写 aria-label 与 aria-labelledby（后者优先，前者会被静默忽略）`,
  )
})

/* ------------------- 3. 预览：Dialog 内 + role=region ------------------- */

test('源码守卫：预览搬进 Dialog，引用它的元素同时带 role="region"，id 恰好一处', () => {
  const labelled = countRefs(page, 'aria-labelledby', PREVIEW.ident, PREVIEW.value)
  const idRefs = countRefs(page, '(?<![\\w-])id', PREVIEW.ident, PREVIEW.value)
  assert.equal(
    labelled,
    1,
    `${PREVIEW.label}面板：aria-labelledby 应恰好引用 ${PREVIEW.ident} 1 次，实际 ${labelled}（0 次=接线丢了；≥2 次=重复标注）`,
  )
  assert.equal(
    idRefs,
    1,
    `${PREVIEW.label}面板：id 应恰好引用 ${PREVIEW.ident} 1 次（0 次=名字没了；≥2 次=重复 id 会让 labelledby 指向错误元素），实际 ${idRefs}`,
  )

  /*
   * `role="region"` 与 `aria-labelledby` 必须在**同一个元素**上：
   * `aria-labelledby` 加在 generic 元素上会被忽略（generic 不接受可访问名称），
   * 拆到两个元素上等于两边都没生效 —— 所以判据取"同一个开标签里两者都在"。
   */
  const needle = `aria-labelledby={${PREVIEW.ident}}`
  const refAt = page.indexOf(needle)
  assert.ok(refAt > 0, `应能定位预览面板的 aria-labelledby（书写形态应为 {${PREVIEW.ident}}）`)
  const tag = openTagAround(page, needle)
  assert.ok(tag.length > 0, '反空洞：应能取出承载该 aria-labelledby 的开标签')
  assert.match(
    tag,
    /role="region"/,
    `承载 aria-labelledby 的元素必须同时写 role="region"，否则名称被忽略：实际开标签 ${tag.replace(/\s+/g, ' ').slice(0, 160)}`,
  )

  // 预览整段必须在「按访客视角预览」的 Dialog 之内 —— 它不再是一个常驻面板
  const dialogAt = page.indexOf('open={previewOpen}')
  assert.ok(dialogAt > 0, '应有 <Dialog open={previewOpen}>：预览现在只在对话框里（常驻面板会被误读成"作者看到的 = 访客看到的"）')
  assert.ok(
    refAt > dialogAt,
    '预览区域必须落在预览 Dialog 之内（搬出去就与"按访客视角遮蔽"的语义脱节）',
  )
})

/* --------------------- 4. 左右分栏的痕迹必须清零 --------------------- */

test('源码守卫：左右分栏已从编辑页删除（gw-split-pane / setPane / xl:grid-cols-2 一处都不剩）', () => {
  /*
   * 编辑页现在是**单栏**：写的地方不再被预览挤窄，看成品改用「按访客视角预览」。
   * 三个字面量分别是旧分栏的容器类、状态名与栅格断点 —— 任何一个回来都说明有人把分栏搬了回来。
   *
   * 范围说明：**不需要**按 WikiEdit 函数体切片。实测这三者在整份 `WikiPage.tsx` 里都是
   * 0 命中（`grep -n "gw-split-pane\|setPane\|xl:grid-cols-2"`），所以整文件级断言比"只在
   * 某个函数体内断言"更强也更简单；将来若其它页面**合法地**用到 `xl:grid-cols-2`
   * （例如卡片栅格），再按 WikiEdit 的函数体缩范围即可 —— 那时这条消息会直接指出该怎么做。
   */
  assert.doesNotMatch(page, /gw-split-pane/, 'gw-split-pane 容器类应已随分栏删除')
  assert.doesNotMatch(page, /setPane\b/, 'setPane 状态应已随分栏删除（`\\b` 避免误伤 setPanelOpen 这类名字）')
  assert.doesNotMatch(page, /xl:grid-cols-2/, '旧分栏的两列栅格应已删除（单栏布局不再需要它）')

  // 反空洞：确认读到的确实是改版后的编辑页 —— 单栏的两个替代物都必须在
  assert.match(
    page,
    new RegExp(`<section aria-labelledby=\\{${EDITOR.ident}\\}`),
    '反空洞：正文面板的 <section> 必须在（否则上面三条可能只是"文件读空了"）',
  )
  assert.match(page, /按访客视角预览/, '反空洞：分栏的替代物（按访客视角预览）必须在')
})

/* ------------- 5. 保存阻断提示在正文面板里，不在预览 Dialog 里 ------------- */

test('源码守卫：gated 标记的保存阻断提示在正文面板里，且排在预览 Dialog 之前', () => {
  /*
   * 「标记不合法 ⇒ 保存会被服务端拒绝」是**保存阻断项**，与"有没有打开预览"无关。
   * 它曾经长在预览面板里 —— 后果是：不打开预览就不知道保存必然失败（写完一大段才被 400 拒绝）。
   *
   * 用**偏移量**表达"在正文面板里、不在预览对话框里"：
   * 1) 它落在正文面板那个 <section> 的**闭合标签之前**；
   * 2) 它排在 <Dialog open={previewOpen}> **之前**。
   *
   * 右边界从"下一个 <section>（权限区）"改成"正文面板自己的 </section>"：编辑页的权限区
   * 已按作者要求移除，用 `</section>` 做边界反而更直接 —— 它断言的正是"在这块区域内部"。
   */
  const warnAt = page.indexOf('保存会被服务端拒绝')
  assert.ok(warnAt > 0, '「保存会被服务端拒绝」的就地提示必须存在（它是保存阻断项的可见凭据）')

  const editorAt = page.indexOf(`<section aria-labelledby={${EDITOR.ident}}`)
  const editorCloseAt = page.indexOf('</section>', editorAt)
  const dialogAt = page.indexOf('open={previewOpen}')
  assert.ok(editorAt > 0 && editorCloseAt > editorAt, '反空洞：正文面板的 <section> 与其闭合标签都要能定位')
  assert.ok(dialogAt > 0, '反空洞：预览 Dialog 要能定位')
  assert.ok(
    warnAt > editorAt && warnAt < editorCloseAt,
    '提示必须落在正文面板的 <section> 之内（用它的开闭标签夹住，增删注释不会让它漂）',
  )
  assert.ok(
    warnAt < dialogAt,
    '提示必须排在预览 Dialog **之前**：挪进预览里等于"不打开预览就看不到保存会被拒"',
  )

  // 它是"必须被感知"的错误：role="alert" 不能被降级成普通段落
  const tag = openTagAround(page, '保存会被服务端拒绝')
  assert.match(
    tag,
    /role="alert"/,
    `该提示必须带 role="alert"（保存阻断项要立即播报，不能等用户自己去发现）：实际开标签 ${tag.replace(/\s+/g, ' ').slice(0, 160)}`,
  )
})

/* ------------------- 6. 段落级权限判据：blockTiers ------------------- */

test('源码守卫：MarkdownEditorLazy 收到 blockTiers，正文面板标注区仍恰好一处', () => {
  /*
   * 段落级权限菜单要按**页面档位**决定可选范围（段档位不能比页面更宽），
   * 所以宿主必须把 `blockTiers={{ pageVisibility: … }}` 交给编辑器。
   * 漏传不会报错 —— 工具栏只是少一个按钮、或按错的前提给出选项，属于静默失败。
   */
  const at = page.indexOf('<MarkdownEditorLazy')
  assert.ok(at > 0, '应能找到 <MarkdownEditorLazy')
  const end = page.indexOf('/>', at)
  assert.ok(end > at, '反空洞：应能取出 MarkdownEditorLazy 的开标签')
  const tag = page.slice(at, end)
  assert.ok(tag.length > 100, `反空洞：开标签切片异常（${tag.length} 字符）`)
  assert.match(tag, /blockTiers=\{/, 'MarkdownEditorLazy 必须收到 blockTiers（每段权限菜单的判据）')
  assert.match(
    tag,
    /pageVisibility/,
    'blockTiers 必须带 pageVisibility —— 段落档位的可选范围由页面档位决定，没有它就无从判断',
  )

  // 编辑器换了实现也不能把这层接线弄丢：正文面板的标注区仍恰好一处
  assert.equal(
    countRefs(page, 'aria-labelledby', EDITOR.ident, EDITOR.value),
    1,
    '正文面板的 aria-labelledby 仍应恰好一处（blockTiers 接线不该以拆掉区域标注为代价）',
  )
})
