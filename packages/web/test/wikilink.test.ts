/**
 * `[[wikilink]]` 语法测试。
 *
 * 直接打 **marked 的输出**（而不是打 DOM），因为这一层的职责就是"产出正确的 HTML 片段"；
 * 后处理层（标题回填、缺失标注）由 `markdownRender` 的用例与真机 E2E 覆盖。
 *
 * 最要紧的两组断言：
 * 1. **代码块与行内代码里不得解析**——这是"字符串替换"方案会踩坏的地方，
 *    也是本模块选择 marked 扩展 API 的唯一理由。若哪天有人把它换成正则替换，
 *    这两条必须立刻变红。
 * 2. 显示文本必须**转义**（纵深防御：即便将来消毒被换掉，也不能因为这里未转义而成注入口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import '../src/lib/wikilink.ts'
import { WIKILINK_ATTR, WIKILINK_AUTO_ATTR } from '../src/lib/wikilink'

const inline = (src: string): string => marked.parseInline(src) as string
const block = (src: string): string => marked.parse(src) as string

test('基本语法：[[slug]] 渲染为站内 hash 链接', () => {
  const html = inline('见 [[getting-started]] 一节')
  assert.match(html, /<a href="#\/wiki\/getting-started"/)
  assert.match(html, /见 /)
  assert.match(html, / 一节/)
})

test('基本语法：无显式文本时带 auto 标记（供后处理层回填页面标题）', () => {
  const html = inline('[[getting-started]]')
  assert.ok(html.includes(WIKILINK_AUTO_ATTR), '应带 auto 标记')
  assert.ok(html.includes(`${WIKILINK_ATTR}="getting-started"`))
})

test('带显示文本：[[slug|文本]] 用文本且**不带** auto 标记', () => {
  const html = inline('[[getting-started|从这里开始]]')
  assert.match(html, />从这里开始<\/a>/)
  assert.ok(!html.includes(WIKILINK_AUTO_ATTR), '显式文本不该被标题覆盖')
})

test('层级目标编码成 %2F（否则路由段数不符 → 404）', () => {
  const html = inline('[[guides/authoring]]')
  assert.match(html, /href="#\/wiki\/guides%2Fauthoring"/)
})

test('**围栏代码块内不得解析**（字符串替换方案正是在这里出错）', () => {
  const html = block('```\n[[not-a-link]]\n```')
  assert.ok(!html.includes('<a '), '代码块里不该出现链接')
  assert.ok(html.includes('[[not-a-link]]'), '应保持字面量')
})

test('**行内代码内不得解析**', () => {
  const html = inline('示例 `[[not-a-link]]` 结束')
  assert.ok(!html.includes('<a '), '行内代码里不该出现链接')
  assert.ok(html.includes('[[not-a-link]]'))
})

test('目标归一：/wiki/ 前缀与前导斜杠被剥掉', () => {
  for (const src of ['[[/wiki/foo]]', '[[wiki/foo]]', '[[/foo]]']) {
    const html = inline(src)
    assert.match(html, /href="#\/wiki\/foo"/, src)
  }
})

test('指向站点根的畸形目标不产出链接', () => {
  for (const src of ['[[/]]', '[[/wiki]]', '[[   ]]', '[[|x]]', '[[a|]]']) {
    const html = inline(src)
    assert.ok(!html.includes('<a '), `${src} 不该产出链接`)
  }
})

test('畸形输入不崩且不吃掉过多正文', () => {
  // 目标里不允许 `[`/`]`：否则会把很远的 `]]` 之前的整段都吃成目标
  const html = inline('[[unclosed and [[a|b]] tail')
  assert.ok(html.includes('[[unclosed and'), '未闭合的开头应保留为字面量')
  assert.match(html, />b<\/a>/, '后面那个合法的应正常解析')
  assert.ok(!html.includes('unclosed and [[a<'), '不得把中间正文当目标')
})

test('跨行不解析', () => {
  const html = block('[[foo\nbar]]')
  assert.ok(!html.includes('<a '), 'wikilink 不应跨行')
})

test('显示文本与目标中的 HTML 被转义（纵深防御）', () => {
  const html = inline('[[foo|<img src=x onerror=alert(1)>]]')
  // 关键：不得出现**真正的标签**。转义后 `onerror=alert(1)` 仍会作为**文本**出现，
  // 那是无害的（它不在属性位置），所以断言的是"尖括号被转义 + 无标签"，
  // 而不是"字符串里不含 onerror"（后者会是一条永远无法满足的假断言）。
  assert.ok(!html.includes('<img'), '不得输出真实的 <img 标签')
  assert.ok(html.includes('&lt;img'), '尖括号必须被转义成实体')
  assert.match(html, />&lt;img[^<]*&lt;\/a>|>&lt;img[^>]*&gt;<\/a>/, '危险内容应整体落在文本节点里')
})

test('目标里的引号被转义，不会逃出属性', () => {
  const html = inline('[[a"onmouseover="alert(1)]]')
  assert.ok(!/href="[^"]*"\s+onmouseover=/.test(html), '不得因未转义而注入属性')
})

test('中文目标可用', () => {
  const html = inline('[[指南/撰写]]')
  assert.match(html, /href="#\/wiki\/%E6%8C%87%E5%8D%97%2F%E6%92%B0%E5%86%99"/)
})

test('一行内多个 wikilink 各自解析', () => {
  const html = inline('[[a]] 与 [[b|c]]')
  assert.match(html, /href="#\/wiki\/a"/)
  assert.match(html, /href="#\/wiki\/b"[^>]*>c<\/a>/)
})

test('与普通 Markdown 链接共存', () => {
  const html = inline('[普通](https://x.dev) 和 [[foo]]')
  assert.match(html, /href="https:\/\/x\.dev"/)
  assert.match(html, /href="#\/wiki\/foo"/)
})

test('重复注册不产生重复渲染（幂等）', async () => {
  const mod = await import('../src/lib/wikilink')
  mod.registerWikilink()
  mod.registerWikilink()
  const html = inline('[[foo]]')
  assert.equal(html.match(/<a /g)?.length, 1, '不应因重复注册而输出两条链接')
})
