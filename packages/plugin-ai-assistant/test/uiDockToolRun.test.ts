/**
 * 工具活动"收成一行"的守卫（用户原话："当前回答完后，所有工具的使用都会堆积在下面，感觉不好"）。
 *
 * 改前：每个工具调用一行 `<li>` 平铺在回答下方，一轮里查两次知识库 + 搜一次网络 + 改一次页面
 * 就是四五条堆在底部。改后：默认一行摘要，点开才铺明细；流式期间照旧铺开（那时它是进度指示器）。
 *
 * 分两层钉：**纯函数** `toolRunSummary` 的文案边界，**源码**上的三条行为约束
 * （默认收起 / 流式铺开 / 一轮结束复位）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolRunSummary } from '../ui/dockPlan.js'

const SRC = join(import.meta.dirname, '..', 'ui')
const component = readFileSync(join(SRC, 'index.tsx'), 'utf8')
const css = readFileSync(join(SRC, 'style.css'), 'utf8')

const act = (name: string, ok: boolean | null = true) => ({ name, ok })

test('摘要文案：跑完的工具报"本次用了 N 个工具"+去重后的名字', () => {
  assert.equal(toolRunSummary([]), '', '没有活动时返回空串（调用方据此不渲染）')
  assert.equal(toolRunSummary([act('list_pages')]), '本次用了 1 个工具：list_pages')
  assert.equal(
    toolRunSummary([act('list_pages'), act('web_search')]),
    '本次用了 2 个工具：list_pages、web_search',
  )
  assert.equal(
    toolRunSummary([act('list_pages'), act('list_pages')]),
    '本次用了 2 个工具：list_pages',
    '同名工具跑两次：名字只写一遍，**次数仍要报 2**——"跑了两次"与"用了两个工具"是两件事',
  )
})

test('摘要文案：还在跑的时候只说"正在执行"（名字列表那时还在变）', () => {
  assert.equal(toolRunSummary([act('web_search', null)]), '正在执行 1 个工具：web_search')
  assert.equal(
    toolRunSummary([act('list_pages'), act('web_search', null)]),
    '正在执行 2 个工具：list_pages、web_search',
  )
})

test('摘要文案：有失败必须点名数量（否则收起后用户永远看不出出过问题）', () => {
  assert.equal(
    toolRunSummary([act('list_pages'), act('page.update', false)]),
    '本次用了 2 个工具：list_pages、page.update（其中 1 个失败）',
  )
  assert.doesNotMatch(toolRunSummary([act('list_pages')]), /失败/, '全成功时不提"失败"二字')
})

test('renderThread 必须把活动交给 ToolRun，不得再平铺成一整个 <ul>', () => {
  assert.match(component, /nodes\.push\(<ToolRun activities=\{state\.activities\} streaming=\{state\.streaming\} key="activities" \/>\)/)
  const legacy = /<ul className="gw-dock-tools" key="activities">/.test(component)
  assert.equal(legacy, false, '旧的平铺列表必须消失（它是用户抱怨的"堆积"本体）')
})

test('ToolRun：默认收起、流式期间铺开、一轮结束复位', () => {
  const body = /function ToolRun\(\{[\s\S]*?\n\}\n/.exec(component)?.[0] ?? ''
  assert.ok(body.length > 200, '应能读到 ToolRun 组件')
  assert.match(body, /useState\(false\)/, '默认必须是收起的')
  assert.match(body, /const showList = expanded \|\| streaming/, '流式期间必须铺开（那是进度指示器）')
  assert.match(body, /if \(streaming\) setExpanded\(false\)/, '一轮结束要复位"手动展开"，否则下一轮又会堆起来')
  assert.match(body, /aria-expanded=\{showList\}/, 'aria-expanded 必须与实际渲染一致')
  assert.match(body, /\{showList && \(/, '明细列表只能在 showList 为真时渲染')
  assert.doesNotMatch(component, /<details[^>]*gw-dock-tools/, '不要用 <details> 的原生开合：它与"流式结束自动收起"会打架')
})

test('样式：箭头只做旋转，且登记进 prefers-reduced-motion', () => {
  assert.match(css, /\.gw-dock-tools-chevron-open\s*\{[^}]*transform: rotate\(90deg\)/)
  assert.match(css, /\.gw-dock-tools-chevron\s*\{[^}]*transition:/, '箭头需要有过渡')
  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  assert.match(rm, /\.gw-dock-tools-chevron/, '有 transition 就必须在 reduced-motion 里关掉')
})
