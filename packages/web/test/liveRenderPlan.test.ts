/**
 * `lib/liveRenderPlan.ts` —— 实时渲染的**块级渲染判定**。
 * ============================================================================
 *
 * 这些判据都有一类共同的失败形态：**不报错，但画面是错的**。
 * 范围少算一行 ⇒ 相邻正文被吃掉半行；多算一行 ⇒ 表格少画一行；
 * `---` 在引用里被当成整行分隔线 ⇒ 引用符号凭空消失。故每一条都单独钉一个用例，
 * 并且**用真实语法树的偏移**当输入（`@lezer/markdown` 实测得到的 `[from,to]`），
 * 而不是自己编一组"看起来差不多"的数字。
 *
 * 为什么这个文件里没有"渲染出来的 HTML 长什么样"的断言：那需要 DOM 与 marked，
 * 属于浏览器侧（`components/editor/liveRender.ts`），由端到端脚本覆盖。
 * 本文件只管**判据**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { markdownLanguage } from '@codemirror/lang-markdown'

import {
  alignToLines,
  bulletForListMark,
  hideInlineCodeMark,
  isWholeLine,
  lineEndAt,
  lineStarts,
  liveBlockKindOf,
  overlaps,
  taskGlyph,
  LIVE_BLOCK_NODES,
} from '../src/lib/liveRenderPlan'

/** 在源码里找某个节点名的第一个实例（用真解析器，不用手写偏移） */
function nodeRange(text: string, name: string): { from: number; to: number } {
  const tree = markdownLanguage.parser.parse(text)
  let found: { from: number; to: number } | null = null
  tree.iterate({
    enter: (node) => {
      if (found === null && node.name === name) found = { from: node.from, to: node.to }
    },
  })
  assert.ok(found !== null, `语法树里没有 ${name} 节点`)
  return found
}

/* ---------------------------- 行结构 ---------------------------- */

test('lineStarts：`\\n` / `\\r\\n` / `\\r` 都算一次换行，末尾换行产生一个空行', () => {
  assert.deepEqual(lineStarts('a\nb'), [0, 2])
  assert.deepEqual(lineStarts('a\nb\n'), [0, 2, 4], '末尾换行 ⇒ 多一个空行（与 editorBlocks.splitLines 对齐）')
  assert.deepEqual(lineStarts('a\r\nb\r\n'), [0, 3, 6])
  assert.deepEqual(lineStarts('a\rb'), [0, 2])
  assert.deepEqual(lineStarts(''), [0])
})

test('lineEndAt：行尾不含换行符；`\\r\\n` 时把 `\\r` 一起扣掉', () => {
  const text = 'a\nbb\r\nccc'
  assert.equal(lineEndAt(text, 0), 1)
  assert.equal(lineEndAt(text, 2), 4, 'bb 的行尾在 \\r 之前')
  assert.equal(lineEndAt(text, 7), 9, '末行到文末')
})

/* ---------------------------- 对齐（块装饰的前置条件） ---------------------------- */

test('alignToLines：把表格节点的范围扩到整行（结尾换行不进范围，否则会把空行一起吃掉）', () => {
  const text = '| 层 | 职责 |\n| --- | --- |\n| core | 类型 |\n\n后一段\n'
  const table = nodeRange(text, 'Table')
  const span = alignToLines(text, table.from, table.to)
  assert.deepEqual(span, { from: table.from, to: table.to }, '表格节点本就与行边界对齐，扩行不改变它')
  assert.equal(text.slice(span?.from, span?.to), text.slice(table.from, table.to))
  assert.equal(text[span?.to ?? 0], '\n', '范围止于末行行尾 —— 结尾的换行留给文档，不被替换')
})

test('alignToLines：节点范围落在行中间时**扩到整行**（否则块装饰跨行/错位）', () => {
  const text = '前言\n> quoted\n后记\n'
  const span = alignToLines(text, 4, 6) // 落在 `> quoted` 这一行的中间
  assert.deepEqual(span, { from: 3, to: 11 }, '扩到该行的行首与行尾')
  assert.equal(text.slice(span?.from, span?.to), '> quoted')
})

test('alignToLines：越界 / 反向 / 空行一律 null，绝不"就近凑一个"', () => {
  const text = 'a\n\nb\n'
  assert.equal(alignToLines(text, 2, 2), null, '空行没有可替换的内容')
  assert.equal(alignToLines(text, 5, 2), null, '反向范围')
  assert.equal(alignToLines(text, 0, 99), null, '越界')
  assert.equal(alignToLines(text, 0.5, 2), null, '非整数')
  assert.equal(alignToLines(text, -1, 2), null, '负偏移')
  assert.equal(alignToLines('a\n\n\nb', 3, 3), null, '空行上的零宽范围 ⇒ null（不凭空多出一块高度）')
  assert.deepEqual(alignToLines(text, 1, 1), { from: 0, to: 1 }, '行中间的零宽范围扩到该行（`a` 这一行）')
})

test('alignToLines：代码块跨行且带 CRLF 时也按整行给范围', () => {
  const text = '```ts\r\nconst a = 1\r\n```\r\n'
  const fence = nodeRange(text, 'FencedCode')
  const span = alignToLines(text, fence.from, fence.to)
  assert.equal(span?.from, 0)
  assert.equal(text.slice(0, span?.to).endsWith('```'), true, '范围止于末行行尾，不含 CRLF')
})

/* ---------------------------- 分隔线 ---------------------------- */

test('isWholeLine：`---` 独占整行才算分隔线，`> ---` 不算（引用里的一行）', () => {
  const alone = 'para\n\n---\n\npara2\n'
  const rule = nodeRange(alone, 'HorizontalRule')
  assert.equal(isWholeLine(alone, rule.from, rule.to), true)

  const quoted = '> ---\n'
  const quotedRule = nodeRange(quoted, 'HorizontalRule')
  assert.equal(isWholeLine(quoted, quotedRule.from, quotedRule.to), false, '引用里的 --- 不是整行')
})

/* ---------------------------- 行内标记的替换判据 ---------------------------- */

test('bulletForListMark：只用字形替掉无序列表标记；有序列表的 `1.` 原样保留', () => {
  assert.equal(bulletForListMark('-'), '•')
  assert.equal(bulletForListMark('*'), '•')
  assert.equal(bulletForListMark('+'), '•')
  assert.equal(bulletForListMark('1.'), null, '数字就是渲染后的样子')
  assert.equal(bulletForListMark('12)'), null)
  assert.equal(bulletForListMark(''), null)
})

test('taskGlyph：`[ ]` / `[x]` / `[X]` 认得出来，其余原样不动', () => {
  assert.equal(taskGlyph('[ ]'), '☐')
  assert.equal(taskGlyph('[x]'), '☑')
  assert.equal(taskGlyph('[X]'), '☑')
  assert.equal(taskGlyph('[y]'), null, '不认识就不动，不猜')
  assert.equal(taskGlyph('[]'), null)
})

test('hideInlineCodeMark：只藏行内代码的反引号，围栏的 ``` 不归它管', () => {
  assert.equal(hideInlineCodeMark('InlineCode'), true)
  assert.equal(hideInlineCodeMark('FencedCode'), false, '围栏属于代码块自身（整块由块装饰渲染）')
  assert.equal(hideInlineCodeMark('CodeBlock'), false)
  assert.equal(hideInlineCodeMark(null), false)
  assert.equal(hideInlineCodeMark(undefined), false)
})

/* ---------------------------- 块级渲染的节点表 ---------------------------- */

test('liveBlockKindOf：只有实测存在的五类节点整块渲染', () => {
  assert.equal(liveBlockKindOf('Table'), 'table')
  assert.equal(liveBlockKindOf('FencedCode'), 'code')
  assert.equal(liveBlockKindOf('CodeBlock'), 'code')
  assert.equal(liveBlockKindOf('HTMLBlock'), 'html')
  assert.equal(liveBlockKindOf('HorizontalRule'), 'rule')
  assert.equal(liveBlockKindOf('HTMLTag'), null, '行内 HTML 标签**不**整块渲染（会吃掉标签之间的内容）')
  assert.equal(liveBlockKindOf('Paragraph'), null)
  assert.equal(liveBlockKindOf('BulletList'), null)
  assert.equal(liveBlockKindOf(''), null)
})

test('LIVE_BLOCK_NODES 的节点名在真实语法树里都存在（写错名字 ⇒ 静默不渲染）', () => {
  const text = [
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const a = 1',
    '```',
    '',
    '    indented code',
    '',
    '<div>block html</div>',
    '',
    '---',
    '',
  ].join('\n')
  const seen = new Set<string>()
  markdownLanguage.parser.parse(text).iterate({
    enter: (node) => {
      seen.add(node.name)
    },
  })
  for (const name of Object.keys(LIVE_BLOCK_NODES)) {
    assert.ok(seen.has(name), `语法树里没有 ${name}，这个名字写错了（块级渲染会静默失效）`)
  }
})

/* ---------------------------- 区间相交 ---------------------------- */

test('overlaps：半开区间相交判定，相邻不算相交', () => {
  assert.equal(overlaps(0, 5, 5, 9), false, '首尾相接不算重叠')
  assert.equal(overlaps(0, 6, 5, 9), true)
  assert.equal(overlaps(5, 9, 0, 6), true, '参数顺序不影响')
  assert.equal(overlaps(0, 5, 6, 9), false)
  assert.equal(overlaps(3, 3, 0, 5), true, '零宽区间按"点"判定：点落在区间内即算相交')
  assert.equal(overlaps(5, 5, 0, 5), false, '点在区间右端之外')
})
