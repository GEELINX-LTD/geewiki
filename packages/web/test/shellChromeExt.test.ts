/**
 * **外壳节点**（`kind: 'shell'`，`App.tsx` 这一层）的接线守卫（P11 收尾）。
 *
 * ## 这个文件为什么必须存在
 * 与 `shellBrandExt.test.ts` / `pageExt.test.ts` / `uiExt.test.ts` 同一个理由：接线是
 * **极易退化的**。`<Ext id="shell-header">` 只要被重构掉一层，插件贡献就会"注册成功、
 * 界面毫无变化"——**没有任何报错**；而目录里留着这个 id 反而更坏（作者照着目录写代码，
 * 然后拿到一个静默失败）。所以这里做四件事：
 *
 * 1. **双向比对**：目录里 `kind: 'shell'` 的每一条都必须在 `App.tsx` 里有接线点，反之亦然；
 * 2. 钉住**容器节点**这条边界（被用户当场驳回后定下的）：`shell-header` / `shell-footer` 是
 *    **内容**节点——`<header>` / `<footer class="app-footer">` 与 `app-header` / `app-footer`
 *    插槽出口**由宿主独占**，出口刻意留在节点之外。若有人把 `Ext` 挪回去包住整个外壳元素，
 *    单个插件就又获得"删掉其他所有插件贡献"的权力，而且**没有任何报错**；
 * 3. 钉住一条**决定**：`shell-sidebar` 刻意不在目录里（宿主外壳没有这个元素）；
 * 4. 用 `react-dom/server` 真渲染，验证三模式行为，尤其是两条硬约束：
 *    "无贡献时 `Ext` **不产生 DOM 节点**"（`shell-footer` 的 `:only-child` 契约依赖它）与
 *    "`replace` 容器节点时其他插件的贡献**不可能被删掉**"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HOST_NODE_CATALOG, hostNodeSpec, isHostNodeName, supportsExtMode, type HostNodeName } from '@geewiki/core/extensions'

/* 与 `extOutlet.test.ts` 同理：SDK / 调试出口都有 `typeof window` 守卫，Node 下可安全 import。 */
import { Ext, NestedSlotOutlet, registerExtensionByName, slotSummary, unregisterSlot } from '../src/lib/slots'

const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

/** `App.tsx` 里出现的全部 `<Ext id="…">`（按出现次数计，便于断言"同一个 id 多处渲染"） */
function extIdsInShell(): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of APP.matchAll(/<Ext\s+id="([a-z0-9-]+)"/g)) {
    const id = m[1]!
    out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

function catalogShellIds(): HostNodeName[] {
  return (Object.keys(HOST_NODE_CATALOG) as HostNodeName[]).filter(
    (id) => HOST_NODE_CATALOG[id].kind === 'shell',
  )
}

test('★ 双向比对：目录里 kind=shell 的条目 ⇄ App.tsx 里的 <Ext> 接线点', () => {
  const wired = extIdsInShell()
  const catalog = catalogShellIds()

  // ① 目录 → 源码：登记了就必须接线（否则是"声明成功、界面毫无变化"的静默失败）
  const missing = catalog.filter((id) => !wired.has(id))
  assert.deepEqual(missing, [], `这些 shell 节点在目录里但 App.tsx 里找不到接线点：${missing.join('、')}`)

  // ② 源码 → 目录：接线了就必须登记（否则插件根本声明不了这个节点）
  const unknown = [...wired.keys()].filter((id) => !catalog.includes(id as HostNodeName))
  assert.deepEqual(
    unknown,
    [],
    `App.tsx 里这些接线点不在目录里（kind=shell）：${unknown.join('、')}——` +
      '若它们其实是别的 kind，请把断言范围改对；若是新节点，请先加进目录。',
  )

  // 非空洞自证：两边都不是空集合（否则上面两条 filter 恒为空、永远绿）
  assert.ok(catalog.length >= 7, `shell 节点太少（${catalog.length}），双向比对失去意义`)
  assert.equal(wired.size, catalog.length, 'App.tsx 里的 shell 接线点数量应与目录条目一一对应')
})

test('★ 每个 shell 节点都允许三种模式（replace / wrap / extend），propsVersion 为 1', () => {
  for (const id of catalogShellIds()) {
    const spec = hostNodeSpec(id)
    assert.ok(spec, `${id} 必须在目录里`)
    assert.equal(spec.kind, 'shell')
    assert.deepEqual([...spec.modes], ['extend', 'wrap', 'replace'], `${id} 的模式集合变了`)
    assert.equal(spec.propsVersion, 1)
    for (const mode of ['extend', 'wrap', 'replace'] as const) {
      assert.equal(supportsExtMode(id, mode), true, `${id} 应当支持 ${mode}`)
    }
  }
})

test('★ shell-sidebar 刻意不在目录里（宿主外壳没有这个元素）', () => {
  /*
   * 设计文档初稿把"侧栏"列为候选，接线时发现外壳里没有它：桌面导航是 `<header>` 里的
   * 横向 `<nav>`（已被 `shell-header` 覆盖），阅读页的右栏 / 折叠块在 `WikiPage.tsx` 里
   * （已被 `wiki-toc` 覆盖）。**为一个不存在的元素登记名字比拒绝更坏**——插件会得到
   * "声明成功、界面毫无变化"。这条断言把"移除该候选"钉成决定，防止有人照着旧文档加回来。
   */
  assert.equal(isHostNodeName('shell-sidebar'), false, 'shell-sidebar 不得出现在目录里')
  assert.equal(hostNodeSpec('shell-sidebar'), undefined)
  assert.equal(extIdsInShell().has('shell-sidebar'), false, 'App.tsx 里也不该有 shell-sidebar 的接线点')
})

test('★ 双向比对：目录声明的 nestedSlots ⇄ App.tsx 里的 <NestedSlotOutlet> 承载点', () => {
  /*
   * 容器节点的**内层出口**必须两处一致：
   * 目录声明了（插件据此知道 `props.slots` 里有什么、文档据此描述）⇄ 宿主真的承载了
   * （`App.tsx` 里有一个 `<NestedSlotOutlet>`）。任一侧缺失的后果都是静默的：
   * 只声明不承载 ⇒ 出口根本不存在，插槽贡献凭空消失；只承载不声明 ⇒ 贡献者拿不到挂载点，
   * 且 `NestedSlotOutlet` 会告警。
   */
  const wired = [...APP.matchAll(/<NestedSlotOutlet node="([a-z0-9-]+)" slot="([a-z0-9-]+)" \/>/g)].map(
    (m) => `${m[1]}:${m[2]}`,
  )
  const declared = catalogShellIds().flatMap((id) =>
    (hostNodeSpec(id)?.nestedSlots ?? []).map((slot) => `${id}:${slot}`),
  )
  assert.deepEqual(wired.slice().sort(), declared.slice().sort(), '目录的 nestedSlots 与 App.tsx 的承载点必须一一对应')
  // 非空洞自证：这条断言今天恰好覆盖两个容器节点
  assert.deepEqual(declared.slice().sort(), ['shell-footer:app-footer', 'shell-header:app-header'])
})

test('★ 源码结构：shell-header 是**内容**节点（<header> 与 app-header 出口由宿主独占）', () => {
  const header = /<header\b[\s\S]*?<\/header>/.exec(APP)
  assert.ok(header, 'App.tsx 里应当有 <header> 元素')
  const block = header[0]
  const extAt = block.indexOf('<Ext id="shell-header">')
  const outletAt = block.indexOf('<NestedSlotOutlet node="shell-header" slot="app-header" />')
  assert.ok(extAt > -1, '<Ext id="shell-header"> 必须在 <header> **之内**（节点只覆盖顶栏内容）')
  assert.ok(outletAt > -1, 'app-header 出口必须由 <NestedSlotOutlet> 承载')
  assert.ok(
    outletAt > extAt,
    'app-header 出口必须在 shell-header 节点**之后**：否则 replace 会把其他插件的贡献一起接管（用户当场驳回的缺陷）',
  )
  assert.equal(
    block.includes('<SlotOutlet name="app-header"'),
    false,
    '不得回退成裸 <SlotOutlet name="app-header">——它会落在节点之内、被 replace 连带删除',
  )
  // 反向对照：品牌区嵌在顶栏之内，且在 shell-header 节点之内
  assert.ok(block.indexOf('shell-brand') > extAt, 'shell-brand 应当嵌在 shell-header 内部')
})

test('★ 源码结构：shell-footer 是**内容**节点（<footer> 与 app-footer 出口由宿主独占）', () => {
  const footer = /<footer className="app-footer">[\s\S]*?<\/footer>/.exec(APP)
  assert.ok(footer, 'App.tsx 里应当有 <footer className="app-footer">')
  const block = footer[0]
  const extAt = block.indexOf('<Ext id="shell-footer">')
  const outletAt = block.indexOf('<NestedSlotOutlet node="shell-footer" slot="app-footer" />')
  assert.ok(extAt > -1, '<Ext id="shell-footer"> 必须在 <footer> **之内**')
  assert.ok(outletAt > extAt, 'app-footer 出口必须在 shell-footer 节点之后（同理，防被 replace 连带删除）')
  assert.equal(
    block.includes('<SlotOutlet name="app-footer"'),
    false,
    '不得回退成裸 <SlotOutlet name="app-footer">',
  )
})

test('★ 渲染：无贡献时 Ext **不产生 DOM 节点**（shell-footer 的 :only-child 契约）', () => {
  /*
   * 这条是本文件里最容易被"顺手优化"弄坏的一条：只要 `Ext` 在无贡献时改成渲染一个
   * 包裹元素（`<div>` / `<span>` / 甚至 Fragment 之外的东西），`<footer>` 的直接子元素
   * 就不再是 `.slot-outlet`，于是 `styles.css` 里
   * `.app-footer:has(> .slot-outlet[data-count='0']:only-child){display:none}` 失配——
   * **空页脚重新占位**，而且没有任何报错。
   * 这里渲染的是 `App.tsx` 里的**真实结构**（footer 由宿主独占 + `Ext` 内容节点 + 宿主承载的
   * 出口），而不是手搭的近似物——否则重构之后断言仍会"绿"，守卫就失去意义了。
   */
  unregisterSlot('shell-footer')
  unregisterSlot('app-footer')
  const shell = (): ReactElement =>
    createElement(
      'footer',
      { className: 'app-footer' },
      createElement(Ext, { id: 'shell-footer', children: null }),
      createElement(NestedSlotOutlet, { node: 'shell-footer', slot: 'app-footer' }),
    )
  const plain = renderToStaticMarkup(shell())
  assert.equal(
    plain,
    '<footer class="app-footer"><div class="slot-outlet" data-slot="app-footer" data-count="0"></div></footer>',
    '无贡献时 footer 的唯一子元素必须是那个 .slot-outlet（:only-child 命中 ⇒ 不占位）',
  )
  assert.equal((plain.match(/slot-outlet/g) ?? []).length, 1, '出口必须**恰好渲染一次**')

  // 反向对照：有 extend 贡献时追加在 footer **之内**（节点本身就在 footer 里）⇒ 页脚显形
  const off = registerExtensionByName(
    'shell-footer',
    () => createElement('span', { className: 'site-note' }, '本站由插件加注'),
    '@demo/footer',
    'extend',
  )
  assert.equal(
    renderToStaticMarkup(shell()),
    '<footer class="app-footer"><span class="site-note">本站由插件加注</span>' +
      '<div class="slot-outlet" data-slot="app-footer" data-count="0"></div></footer>',
    'extend 的贡献落在 footer 之内 ⇒ 不再是 :only-child，页脚显形（符合直觉）',
  )
  off()
})

test('★ 渲染：replace shell-header 只换内容，app-header 的贡献**不可能**被删掉', () => {
  /*
   * 这是**用户当场驳回的那个缺陷**的回归测试：`replace` 若接管整棵子树，单个插件就能删掉
   * 其他所有插件在页头的贡献（而且没有任何报错）。现在出口在节点之外、由宿主渲染，
   * 因此无论 replace 贡献者做什么，那些贡献都在——最坏情况只是**位置**不合意。
   */
  unregisterSlot('shell-header')
  unregisterSlot('app-header')
  const shell = (): ReactElement =>
    createElement(
      'header',
      { className: 'host-header' },
      createElement(Ext, {
        id: 'shell-header',
        children: createElement('span', { className: 'text-wordmark' }, 'GeeWiki'),
      }),
      createElement(NestedSlotOutlet, { node: 'shell-header', slot: 'app-header' }),
    )
  const counter = registerExtensionByName(
    'app-header',
    () => createElement('button', { className: 'plugin-counter' }, '+1'),
    '@demo/counter',
    'extend',
  )

  // 1) 无 shell-header 贡献 ⇒ 宿主默认内容 + 页头插槽贡献
  assert.equal(
    renderToStaticMarkup(shell()),
    '<header class="host-header"><span class="text-wordmark">GeeWiki</span>' +
      '<div class="slot-outlet" data-slot="app-header" data-count="1">' +
      '<button class="plugin-counter">+1</button></div></header>',
  )

  // 2) replace 顶栏内容，且**完全无视** props.slots ⇒ 别人的贡献照样在（本测试的要害）
  const offIgnore = registerExtensionByName(
    'shell-header',
    () => createElement('nav', { className: 'my-nav' }, '自定义导航'),
    '@demo/shell',
    'replace',
  )
  const ignored = renderToStaticMarkup(shell())
  assert.match(ignored, /<nav class="my-nav">自定义导航<\/nav>/, 'replace 贡献应当接管顶栏内容')
  assert.equal(ignored.includes('text-wordmark'), false, 'replace 生效后宿主默认内容不渲染')
  assert.match(
    ignored,
    /<button class="plugin-counter">\+1<\/button>/,
    'replace 无视 props.slots 时，其他插件的页头贡献**必须**仍然渲染',
  )
  offIgnore()

  // 3) replace 渲染 props.slots['app-header'] ⇒ 拿到挂载点，可把它摆进自己的标记里
  const offPlace = registerExtensionByName(
    'shell-header',
    (props: Record<string, unknown>) =>
      createElement(
        'nav',
        { className: 'my-nav' },
        createElement('span', null, '左'),
        (props.slots as Record<string, ReactNode>)['app-header'],
        createElement('span', null, '右'),
      ),
    '@demo/shell',
    'replace',
  )
  const placed = renderToStaticMarkup(shell())
  assert.match(
    placed,
    /<nav class="my-nav"><span>左<\/span><span data-ext-slot-mount="app-header"[^>]*><\/span><span>右<\/span><\/nav>/,
    'props.slots 里给出的是**挂载点元素**，可以渲染在自己标记的任意位置',
  )
  /*
   * SSR 没有 DOM ⇒ 搬运不发生，出口仍按宿主位置渲染（这是刻意的：见 `NestedSlotOutlet` 注释）。
   * "在真实浏览器里搬进挂载点"由 `scripts/acceptance/ui-extension-cdp.mjs` 验。
   */
  assert.match(placed, /<div class="slot-outlet" data-slot="app-header" data-count="1">/)
  offPlace()

  // 4) 卸载 ⇒ 逐字还原
  counter()
  assert.equal(
    renderToStaticMarkup(shell()),
    '<header class="host-header"><span class="text-wordmark">GeeWiki</span>' +
      '<div class="slot-outlet" data-slot="app-header" data-count="0"></div></header>',
  )
  assert.equal(slotSummary()['shell-header'], 0)
})

test('★ 渲染：wrap shell-theme-toggle 时宿主默认控件仍在 default 里（不会把开关弄丢）', () => {
  unregisterSlot('shell-theme-toggle')
  const fallback = createElement('button', { className: 'theme-toggle' }, '深色')
  const off = registerExtensionByName(
    'shell-theme-toggle',
    (props: Record<string, unknown>) =>
      createElement('div', { className: 'theme-wrap' }, props.default as never, createElement('span', null, 'β')),
    '@demo/theme',
    'wrap',
  )
  const html = renderToStaticMarkup(createElement(Ext, { id: 'shell-theme-toggle', children: fallback }))
  assert.equal(html, '<div class="theme-wrap"><button class="theme-toggle">深色</button><span>β</span></div>')
  off()
  unregisterSlot('shell-theme-toggle')
})

test('★ 渲染：extend 命令面板 / 系统状态对话框（追加在默认实现之后，默认不被顶掉）', () => {
  for (const id of ['shell-command-palette', 'shell-status-dialog'] as const) {
    unregisterSlot(id)
    const fallback = createElement('div', { className: 'host-dialog', role: 'dialog' }, '宿主对话框')
    const off = registerExtensionByName(
      id,
      () => createElement('div', { className: 'my-dialog' }, '插件对话框'),
      '@demo/dialog',
      'extend',
    )
    const html = renderToStaticMarkup(createElement(Ext, { id, children: fallback }))
    assert.equal(
      html,
      '<div class="host-dialog" role="dialog">宿主对话框</div><div class="my-dialog">插件对话框</div>',
      `${id} 的 extend 应当追加在宿主默认实现之后`,
    )
    off()
    unregisterSlot(id)
    assert.equal(slotSummary()[id], 0)
  }
})
