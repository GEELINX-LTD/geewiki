/**
 * **页头品牌位**（`shell-brand` / `shell-brand-text`）的接线守卫（P5）。
 *
 * ## 这个文件为什么必须存在
 * 本目标的起点是一个具体问题：「左上角 geewiki 字样能不能用插件改」。
 * 在 P5 之前答案是"官方做不到"——只能靠私有类名（全局 CSS 注入）或直接改 DOM
 * 这两个**后门**：插件卸载后残留、宿主无法诊断、也不受任何契约约束。
 *
 * 接线本身是**极易退化的**：`App.tsx` 的 `<Ext>` 只要被重构掉一层，
 * 插件贡献就会"注册成功、界面毫无变化"——**没有任何报错**。因此这里既断言源码里
 * 那两层 `<Ext>` 真的包住了品牌区，也用 `react-dom/server` 真渲染一遍验证
 * "replace 生效 / 卸载后逐字还原"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HOST_NODE_CATALOG, hostNodeSpec, supportsExtMode } from '@geewiki/core/extensions'

/* 与 `extOutlet.test.ts` 同理：P7 起 SDK / 调试出口都有 `typeof window` 守卫，Node 下可安全 import。 */
import { Ext, registerExtensionByName, slotSummary, unregisterSlot } from '../src/lib/slots'

const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

/** 品牌链接那一块（从 `shell-brand` 的 Ext 开始到它闭合的 `</Ext>`，用括号配对取） */
function shellBrandBlock(): string {
  const start = APP.indexOf('<Ext id="shell-brand">')
  assert.ok(start >= 0, 'App.tsx 里找不到 `<Ext id="shell-brand">` —— 品牌区没有被接成宿主节点')
  let depth = 0
  let i = start
  while (i < APP.length) {
    if (APP.startsWith('<Ext ', i)) depth += 1
    else if (APP.startsWith('</Ext>', i)) {
      depth -= 1
      if (depth === 0) return APP.slice(start, i + '</Ext>'.length)
    }
    i += 1
  }
  throw new Error('shell-brand 的 <Ext> 没有闭合')
}

test('★ App.tsx：品牌链接被 shell-brand 包住，字样被 shell-brand-text 包住（嵌套关系明确）', () => {
  const block = shellBrandBlock()
  assert.match(block, /<a\s/, 'shell-brand 里应当仍然有宿主的 <a> 链接触点')
  assert.match(block, /href="#\/wiki"/, '宿主默认实现仍是"点回知识库首页"的链接')
  assert.match(
    block,
    /<Ext id="shell-brand-text">[\s\S]*?text-wordmark[\s\S]*?<\/Ext>/,
    '品牌**字样**必须被单独的 shell-brand-text 节点包住（否则"只改文字"的插件只能替换整块链接）',
  )
  // 反向对照：字样**必须**在 shell-brand 里面（嵌套关系写反了就等于两个互不相干的节点）
  assert.ok(
    block.indexOf('shell-brand-text') > block.indexOf('href="#/wiki"'),
    'shell-brand-text 应当嵌在品牌链接内部（图标之后）',
  )
})

test('★ 目录：两个品牌节点都允许三种模式，且 propsVersion 为 1', () => {
  for (const id of ['shell-brand', 'shell-brand-text'] as const) {
    const spec = hostNodeSpec(id)
    assert.ok(spec, `${id} 必须在目录里（没接线就不该出现在插件可声明的名单里）`)
    assert.equal(spec.kind, 'shell')
    assert.deepEqual([...spec.modes], ['extend', 'wrap', 'replace'], `${id} 的模式集合变了`)
    assert.equal(spec.propsVersion, 1)
    for (const mode of ['extend', 'wrap', 'replace'] as const) {
      assert.equal(supportsExtMode(id, mode), true)
    }
  }
  // 非空洞：目录确实解析出来了（而不是 hostNodeSpec 恒返回 undefined）
  assert.ok(Object.keys(HOST_NODE_CATALOG).length >= 9)
})

test('★ 渲染：插件 replace 品牌字样后文字改变；卸载后逐字还原宿主默认', () => {
  unregisterSlot('shell-brand-text')
  const fallback = createElement('span', { className: 'text-wordmark' }, 'GeeWiki')
  const render = (): string => renderToStaticMarkup(createElement(Ext, { id: 'shell-brand-text', children: fallback }))

  // 1) 无贡献 ⇒ 宿主默认（就是原来那串字）
  assert.equal(render(), '<span class="text-wordmark">GeeWiki</span>')

  // 2) replace 贡献 ⇒ 换掉文字（这**正是**用户最初问的那件事，现在走正规契约）
  const off = registerExtensionByName(
    'shell-brand-text',
    () => createElement('span', { className: 'text-wordmark' }, 'MyWiki'),
    '@demo/rename',
    'replace',
  )
  assert.equal(render(), '<span class="text-wordmark">MyWiki</span>')
  assert.equal(slotSummary()['shell-brand-text'], 1)

  // 3) 卸载 ⇒ **逐字**还原（后门做不到这一点：全局 CSS / 直接改 DOM 都会留残留）
  off()
  assert.equal(render(), '<span class="text-wordmark">GeeWiki</span>')
  assert.equal(slotSummary()['shell-brand-text'], 0)
})

test('★ 渲染：wrap 品牌字样时默认文字仍在（加角标/包裹不会弄丢内容）', () => {
  unregisterSlot('shell-brand-text')
  const fallback = createElement('span', { className: 'text-wordmark' }, 'GeeWiki')
  const off = registerExtensionByName(
    'shell-brand-text',
    (props: Record<string, unknown>) =>
      createElement('span', { className: 'brand-wrap' }, props.default as never, createElement('sup', null, 'β')),
    '@demo/badge',
    'wrap',
  )
  const html = renderToStaticMarkup(createElement(Ext, { id: 'shell-brand-text', children: fallback }))
  assert.equal(html, '<span class="brand-wrap"><span class="text-wordmark">GeeWiki</span><sup>β</sup></span>')
  off()
  unregisterSlot('shell-brand-text')
})

test('★ 品牌位的 replace 接受任意贡献者名（目录只约束节点，不约束 owner）', () => {
  // 反向对照：同一节点、不同 owner 名都能注册；被抑制的裁决在**后端**（前端只认 effective）
  unregisterSlot('shell-brand')
  const a = registerExtensionByName('shell-brand', () => createElement('b', null, 'A'), '@x/a', 'replace')
  const b = registerExtensionByName('shell-brand', () => createElement('b', null, 'B'), '@x/b', 'replace')
  assert.equal(slotSummary()['shell-brand'], 2, '两条都已注册（前端不做单占用裁决，裁决在后端）')
  a()
  b()
  assert.equal(slotSummary()['shell-brand'], 0)
})
