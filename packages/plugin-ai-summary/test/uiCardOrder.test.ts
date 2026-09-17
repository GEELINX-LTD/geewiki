/**
 * 摘要卡**两处文案的位置**守卫（折叠态 head / 展开态脚注）。
 *
 * 缘起是两条用户口径，都发生在同一张卡片上：
 *   1. 2026-09-17「把摘要的显示位置调整到标题下面」——那是**卡片整体**在文章里的位置，
 *      钉在 `packages/web/test/readingLayout.test.ts`；
 *   2. 2026-09-17「把摘要的 仅公开部分 字样放到 由AI生成 的后面」——那是**卡片内部**
 *      这句限定语的位置，钉在这里。
 *
 * 为什么值得一条守卫：「仅公开部分」原先在折叠态的 `<summary>` 里（紧跟「摘要」/「已过期」），
 * 而「由 AI 生成」在展开态的脚注里 —— 两句话分处两个状态，读者只有展开后才会同时看到它们。
 * 这句限定语表达的是"摘要只覆盖公开的那一部分"（公开页含受限段落时），位置是用户要求的，
 * 故连同"它必须仍在**公开档**才出现"一起钉住，避免下次重构搬回去或顺手放宽成对所有页面都标。
 *
 * 做法与 `packages/web/test/readingLayout.test.ts` 一致：直接读源文本，不手抄 DOM 结构。
 * 读取前剥掉块注释 —— 否则**注释里提到这句文案**就会让 indexOf 命中注释而不是真代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../ui/index.tsx', import.meta.url), 'utf8')
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('「仅公开部分」必须紧跟「由 AI 生成」之后（展开态脚注里，且仍在公开档才出现）', () => {
  const footAt = code.indexOf('className="gw-summary-foot"')
  const metaAt = code.indexOf('由 AI 生成')
  const noteAt = code.indexOf('仅公开部分')

  assert.ok(footAt > 0, '应能找到展开态脚注 .gw-summary-foot')
  assert.ok(metaAt > footAt, '「由 AI 生成」必须仍在展开态脚注里（用户要求把限定语放到它后面）')
  assert.ok(noteAt > metaAt, `「仅公开部分」必须在「由 AI 生成」**之后**（现状 meta@${metaAt}、note@${noteAt}）`)

  // 折叠态里不得再有它：同一句话分处两个状态，正是这次要修掉的样子
  const head = /<summary className="gw-summary-head">([\s\S]*?)<\/summary>/.exec(code)?.[1] ?? ''
  assert.ok(head.length > 0, '应能找到折叠态 <summary className="gw-summary-head">')
  assert.doesNotMatch(head, /仅公开部分/, '折叠态里不得再有「仅公开部分」——它已按要求搬到脚注')

  // 只在公开档标注：组织内页面的读者都是成员，说"公开部分"是噪音
  assert.match(code, /audience === 'public'[\s\S]{0,400}?仅公开部分/, '这句限定语必须仍由 `audience === \'public\'` 守卫（不得对所有页面都标）')
})

test('「仅公开部分」不得被并进「由 AI 生成」的那条三元分支（出错时也要在）', () => {
  /*
    脚注里有 `err ? 错误 : 生成时间` 这个三元。把限定语放进 `else` 分支的实现看起来也能过
    上一条（正常的 DOM 顺序一样），但重新生成失败时它会被一起换掉 —— 而"摘要只覆盖公开
    部分"与"这次重算成没成"是两件事。故这里钉住它在那条三元**之外**。
  */
  const ternary = /err !== ''[\s\S]*?\n\s*\)\}/.exec(code)?.[0] ?? ''
  assert.ok(ternary.length > 0, '应能找到脚注里的 err / meta 三元分支')
  assert.doesNotMatch(ternary, /仅公开部分/, '限定语不得写进那条三元（否则出错时看不到它）')
})
