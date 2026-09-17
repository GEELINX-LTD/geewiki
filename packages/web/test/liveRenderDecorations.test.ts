/**
 * 实时渲染的**装饰区间**守卫（`components/editor/liveRender.ts`）。
 *
 * ## 为什么需要它
 * 这一层此前**没有任何测试**（`liveRenderPlan.test.ts` 只测纯逻辑），于是下面这个
 * 用户可见的缺陷一直没人发现：
 *
 * Lezer 的 `HeaderMark` 只覆盖 `#` / `##` **本身，不含其后的空格**（实测：
 * `# 标题` ⇒ `HeaderMark [0,1]`）。装饰层原先只按 `HeaderMark` 的区间做
 * `Decoration.replace({})` ⇒ 那个空格留在文档里 ⇒ **标题文本比正文右移一个空格宽**，
 * 标题字号更大故偏移更显眼。用户的原话是「正文和标题的缩进不一样」。
 *
 * ## 在 node 下怎么测（没有 DOM）
 * `@codemirror/state` 的 `EditorState` 不需要 DOM；`liveRender()` 返回的扩展数组的
 * **第一个元素就是那个 `StateField`**，故可直接 `state.field(field)` 取出装饰集合断言区间 ——
 * 不需要为测试在生产代码里开任何导出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState, type StateField } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { liveRender } from '../src/components/editor/liveRender'

/**
 * 取出处于"全篇按渲染显示"状态下的全部装饰区间。
 *
 * ⚠️ 三个坑，都实测踩过：
 * 1. **只能调一次 `liveRender()`** —— 每次调用都新建一个 StateField；用 A 次的 field
 *    去读 B 次创建的 state 会报 `Field is not present in this state`。
 * 2. **三个选项都是必填**（`hideMarks` / `renderImages` / `renderBlocks`）。
 * 3. **光标所在的块不做任何隐藏**（`liveRender.ts` 文件头约束 1）。新建 state 时光标在 0，
 *    正好落在第一个块（标题）里 ⇒ `## ` 根本不会被藏，于是"验证标题"的断言会因为
 *    **没被隐藏**而失败，看起来像改错了。把光标放到文末（落在块间的空行上）让全篇渲染，
 *    这才是用户在正文里打字时的实际状态。
 */
function rangesOf(doc: string): { from: number; to: number }[] {
  const ext = liveRender({ hideMarks: true, renderImages: true, renderBlocks: true })
  // 用**真实类型**断言，别用 `Parameters<…>[0]`：那会退化成 `unknown`，
  // 于是 `between` 的回调参数全无类型（tsc 会报 TS2571/TS7006，实测踩过）。
  const field = (ext as unknown as [StateField<DecorationSet>, unknown])[0]
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdown({ base: markdownLanguage }), ext],
  })
  const out: { from: number; to: number }[] = []
  state.field(field).between(0, doc.length, (from, to) => {
    out.push({ from, to })
  })
  return out
}

const covers = (rs: { from: number; to: number }[], from: number, to: number): boolean =>
  rs.some((r) => r.from === from && r.to === to)

test('★ 实时渲染：标题标记连同其后空格一起隐藏（否则标题比正文右移一个空格）', () => {
  const doc = '## 标题\n\n正文\n'
  // 先确认装饰集非空：判据写坏时下面的断言会空集通过
  assert.ok(rangesOf(doc).length > 0, '应产生装饰（否则本用例是空转）')
  // `## 标题`：`##` 是 [0,2)，其后空格在 [2,3) —— 必须**一起**吃掉
  assert.equal(covers(rangesOf(doc), 0, 3), true, '应有一个装饰覆盖 `## `（标记 + 空格）')
  assert.equal(covers(rangesOf(doc), 0, 2), false, '只覆盖 `##` 会让标题多出一个空格宽')
})

test('★ 实时渲染：正文段落起始处不得有替换装饰（正文就是左边界基准）', () => {
  const doc = '## 标题\n\n正文\n'
  const paraStart = doc.indexOf('正文')
  assert.equal(
    rangesOf(doc).some((r) => r.from <= paraStart && r.to > paraStart),
    false,
    '正文起始处不该被替换装饰覆盖（否则正文自身也会偏移，成为另一个基准）',
  )
})

test('★ 实时渲染：空标题后面的换行不得被吃掉（吃进去会把两行并掉）', () => {
  // 空标题 `##` 后面直接换行；只吃空格/制表符，故覆盖区间必须止于 `##` 本身
  assert.equal(covers(rangesOf('##\n\n正文\n'), 0, 2), true, '空标题只藏 `##`，不得跨过换行')
})
