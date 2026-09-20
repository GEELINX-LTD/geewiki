/**
 * **Shadow DOM 隔离**（P9）的守卫。
 *
 * ## 为什么单测只能钉一半，另一半必须交给 CDP
 * `attachShadow` 是 DOM API，而本仓的 web 单测跑在 Node 里（只有 `react-dom/server`），
 * 没有 DOM。因此这里能钉住的是：
 * 1. **`shadow` 标志只对 `replace` 成立**（其余模式忽略并告警，而不是静默生效、
 *    也不是丢弃整条贡献——见 `registerSlotByName` 的注释）；
 * 2. **声明了隔离的贡献不会内联渲染进宿主 DOM**（SSR 下渲染出的是空的隔离壳，
 *    若哪天有人"顺手"把它改成内联渲染，这条会立刻红）；
 * 3. **隔离壳的接线位置**（源码级）：`attachShadow` 只有一处、`data-ext-shadow` 标记存在、
 *    `shadow` 只从 `replaceEntry` 上读取。
 *
 * "shadow 内 `--gw-*` 生效、宿主类名不生效、包装元素不参与布局"这三条**必须在真实浏览器里**
 * 复验（`scripts/acceptance/plugin-ui-cdp.mjs`，刻意不进 `pnpm test`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Ext, isUsableMountTarget, registerExtensionByName, slotSummary, unregisterSlot } from '../src/lib/slots'

const SLOTS_SRC = readFileSync(new URL('../src/lib/slots.tsx', import.meta.url), 'utf8')

/** 静默 `console.warn` 并返回收集到的告警（结束后由调用方还原） */
function captureWarn(): { warns: string[]; restore: () => void } {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (m?: unknown) => warns.push(String(m))
  return { warns, restore: () => (console.warn = orig) }
}

test('★ P9：replace + shadow 的贡献不内联渲染进宿主 DOM（SSR 下是空的隔离壳）', () => {
  unregisterSlot('shell-brand-text')
  const fallback = createElement('span', { className: 'text-wordmark' }, 'GeeWiki')
  const render = (): string =>
    renderToStaticMarkup(createElement(Ext, { id: 'shell-brand-text', children: fallback }))

  const off = registerExtensionByName(
    'shell-brand-text',
    () => createElement('span', { className: 'my-brand' }, 'MyWiki'),
    '@demo/shadow-brand',
    'replace',
    true,
  )

  const html = render()
  // 隔离壳在，且**只有**壳——贡献的标记绝不能出现在宿主的 DOM 里
  assert.match(html, /data-ext-shadow=""/, '隔离壳必须带 data-ext-shadow 标记（排障与 CDP 断言都靠它）')
  assert.match(html, /style="display:contents"/, '壳必须不参与布局（display: contents）')
  assert.ok(!html.includes('my-brand'), '声明隔离的贡献不得内联渲染进宿主 DOM')
  assert.ok(!html.includes('MyWiki'), '贡献的文案同样不得出现在宿主 DOM 里')
  assert.ok(!html.includes('GeeWiki'), 'replace 已接管，宿主默认实现不应渲染')

  off()
  unregisterSlot('shell-brand-text')
  // 卸载后回到宿主默认（隔离与否都不影响"卸载即还原"）
  assert.equal(render(), '<span class="text-wordmark">GeeWiki</span>')
})

test('★ P9：wrap / extend 上的 shadow 被忽略并告警（贡献本身照常生效）', () => {
  // 用 `editor`：它是少数**同时**允许 extend 与 wrap 的节点，能干净地隔离出"shadow 标志"
  // 这一个变量（`app-header` 只允许 extend，wrap 会另外触发一条"模式不被允许"的告警）
  for (const mode of ['wrap', 'extend'] as const) {
    unregisterSlot('editor')
    const cap = captureWarn()
    let off: () => void
    try {
      off = registerExtensionByName('editor', () => createElement('b', null, 'X'), '@demo/x', mode, true)
    } finally {
      cap.restore()
    }
    assert.equal(cap.warns.length, 1, `${mode} + shadow 应当恰好告警一次，实际：${cap.warns.join(' | ')}`)
    assert.match(cap.warns[0]!, /shadow/, '告警必须点名 shadow，否则作者不知道为什么没隔离')
    assert.match(cap.warns[0]!, /replace/, '告警必须说清"只有 replace 有意义"')
    // 反向对照：**贡献没有被丢弃**（丢弃会让作者去查一个不存在的加载失败）
    assert.equal(slotSummary()['editor'], 1, `${mode} 贡献应当照常登记`)
    off!()
    assert.equal(slotSummary()['editor'], 0)
  }
})

test('★ P11c：Shadow Root 内的挂载点必须判为不可用（否则别人的贡献被拖进隔离根）', () => {
  /*
   * 这条的起因是**先实测到的真缺陷**：`replace shell-header` + `shadow: true` 的贡献者把
   * `props.slots['app-header']` 渲染在隔离根里，出口就被 portal 进 Shadow Root ——
   * 其他插件的页头贡献丢掉全部宿主样式，且从宿主视角看**与"贡献消失"完全一样**
   * （CDP 探针在未修复时读到 `counterLight:false, outletsLight:0`，两处都查才发现
   * `counterShadow:true, outletsShadow:1`）。
   *
   * 这里用**假对象**钉判据（Node 没有 DOM），真浏览器里的效果由
   * `scripts/acceptance/ui-extension-cdp.mjs` 的 P11c 场景验。
   */
  const doc = { kind: 'document' }
  assert.equal(isUsableMountTarget({ isConnected: true, getRootNode: () => doc }, doc), true, 'light DOM + 在文档里 ⇒ 可用')
  assert.equal(
    isUsableMountTarget({ isConnected: true, getRootNode: () => ({ kind: 'shadow-root' }) }, doc),
    false,
    'Shadow Root 内 ⇒ 不可用（这就是缺陷本身）',
  )
  assert.equal(isUsableMountTarget({ isConnected: false, getRootNode: () => doc }, doc), false, '不在文档里 ⇒ 不可用')
  assert.equal(isUsableMountTarget({ isConnected: true, getRootNode: () => doc }, undefined), false, '没有 document ⇒ 不可用')
  // 源码级：判断必须真的接在登记循环里（否则等于写了个没人用的函数）
  assert.match(SLOTS_SRC, /if \(!isUsableMountTarget\(el\)\)/, 'notifyMounts 必须用它过滤挂载点')
  assert.match(SLOTS_SRC, /挂载点落在 Shadow Root 内，已忽略/, '忽略时必须告警（否则作者以为宿主坏了）')
})

test('★ P11c：容器节点 + shadow 在**注册时**就告知"挂载点会被忽略"（不是拒绝，也不是静默）', () => {
  for (const node of ['shell-header', 'shell-footer'] as const) {
    unregisterSlot(node)
    const cap = captureWarn()
    let off: () => void
    try {
      off = registerExtensionByName(node, () => createElement('div', null, 'X'), '@demo/x', 'replace', true)
    } finally {
      cap.restore()
    }
    assert.equal(cap.warns.length, 1, `${node} + shadow 应当恰好告警一次，实际：${cap.warns.join(' | ')}`)
    assert.match(cap.warns[0]!, /容器节点/, '告警必须点名"容器节点"')
    assert.match(cap.warns[0]!, /props\.slots/, '告警必须指向 props.slots（作者的下一步动作）')
    // 反向对照：隔离**仍然生效**、贡献**照常登记**——只忽略挂载点，不是丢弃贡献
    assert.equal(slotSummary()[node], 1, `${node} 的贡献应当照常登记`)
    off!()
    assert.equal(slotSummary()[node], 0)
  }
})

test('★ P9：源码级 —— attachShadow 只有一处，且 shadow 只从 replaceEntry 读取', () => {  const attaches = [...SLOTS_SRC.matchAll(/\.attachShadow\(/g)].length
  assert.equal(attaches, 1, `attachShadow 调用应当只有一处（实际 ${attaches} 处）——多处意味着有两条隔离路径`)

  // shadow 只被 replace 分支消费：wrap/extend 不得读它
  assert.match(SLOTS_SRC, /replaceEntry\.shadow/, 'replace 分支必须读 shadow 标志')
  assert.ok(!/wrapEntry\.shadow/.test(SLOTS_SRC), 'wrap 分支不得读 shadow（隔离只对 replace 成立）')
  assert.ok(
    !/extendEntries[\s\S]{0,200}\.shadow/.test(SLOTS_SRC),
    'extend 渲染不得读 shadow',
  )

  // 隔离壳复用已有 root（StrictMode 双跑 effect 时重复 attachShadow 会抛）
  assert.match(SLOTS_SRC, /el\.shadowRoot \?\? el\.attachShadow/, '必须先复用已有 shadowRoot 再创建')
})
