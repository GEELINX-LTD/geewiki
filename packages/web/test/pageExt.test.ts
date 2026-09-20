/**
 * **页面内元素级挂点**（`kind: 'page'`）的接线守卫（P6）。
 *
 * ## 为什么需要这个文件
 * 与 `shellBrandExt.test.ts` / `uiExt.test.ts` 同一个理由：接线是**极易退化的**。
 * 页面里的 `<Ext id="wiki-actions">` 只要被重构掉一层，插件贡献就会"注册成功、
 * 界面毫无变化"——**没有任何报错**。目录里留着这个 id 反而更坏：插件作者会照着
 * 目录写代码，然后得到一个静默失败。
 *
 * 因此这里做三件事：
 * 1. **双向比对**：目录里 `kind: 'page'` 的每一条都必须在页面源码里有对应接线点，
 *    反之页面里的每个 `page` 节点也必须在目录里（只做单向就会出现"幽灵节点"）；
 * 2. 钉住 `wiki-toc` **两处渲染点共用同一个 id** 这个决策（见测试内注释）；
 * 3. 用 `react-dom/server` 真渲染一遍，验证 replace 生效、卸载后**逐字**还原。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HOST_NODE_CATALOG, hostNodeSpec, supportsExtMode, type HostNodeName } from '@geewiki/core/extensions'

/* 与 `extOutlet.test.ts` 同理：SDK / 调试出口都有 `typeof window` 守卫，Node 下可安全 import。 */
import { Ext, registerExtensionByName, slotSummary, unregisterSlot } from '../src/lib/slots'

/** 已接线 page 节点的三个宿主页面（新增接线点必须加进这里，否则双向比对会红） */
const PAGE_SOURCES = ['WikiPage.tsx', 'GraphPage.tsx', 'AccountPage.tsx'] as const

function pageSource(file: (typeof PAGE_SOURCES)[number]): string {
  return readFileSync(new URL(`../src/pages/${file}`, import.meta.url), 'utf8')
}

/** 页面源码里出现的全部 `<Ext id="…">`（按出现次数计，便于断言"两处渲染点"） */
function extIdsInPages(): Map<string, number> {
  const out = new Map<string, number>()
  for (const file of PAGE_SOURCES) {
    const src = pageSource(file)
    for (const m of src.matchAll(/<Ext\s+id="([a-z0-9-]+)"/g)) {
      const id = m[1]!
      out.set(id, (out.get(id) ?? 0) + 1)
    }
  }
  return out
}

function catalogPageIds(): HostNodeName[] {
  return (Object.keys(HOST_NODE_CATALOG) as HostNodeName[]).filter(
    (id) => HOST_NODE_CATALOG[id].kind === 'page',
  )
}

test('★ 双向比对：目录里 kind=page 的条目 ⇄ 页面源码里的 <Ext> 接线点', () => {
  const wired = extIdsInPages()
  const catalog = catalogPageIds()

  // ① 目录 → 源码：登记了就必须接线（否则是"声明成功、界面毫无变化"的静默失败）
  const missing = catalog.filter((id) => !wired.has(id))
  assert.deepEqual(missing, [], `这些 page 节点在目录里但页面源码里找不到接线点：${missing.join('、')}`)

  // ② 源码 → 目录：接线了就必须登记（否则插件根本声明不了这个节点）
  const unknown = [...wired.keys()].filter((id) => !catalog.includes(id as HostNodeName))
  assert.deepEqual(unknown, [], `这些页面接线点不在目录里（kind=page）：${unknown.join('、')}`)

  // 非空洞自证：两边都不是空集合（否则上面两条 filter 恒为空、永远绿）
  assert.ok(catalog.length >= 5, `page 节点太少（${catalog.length}），双向比对失去意义`)
  assert.ok(wired.size >= 5, `接线点太少（${wired.size}），双向比对失去意义`)
})

test('★ 每个 page 节点都允许三种模式（replace / wrap / extend），propsVersion 为 1', () => {
  for (const id of catalogPageIds()) {
    const spec = hostNodeSpec(id)
    assert.ok(spec, `${id} 必须在目录里`)
    assert.equal(spec.kind, 'page')
    assert.deepEqual([...spec.modes], ['extend', 'wrap', 'replace'], `${id} 的模式集合变了`)
    assert.equal(spec.propsVersion, 1)
    for (const mode of ['extend', 'wrap', 'replace'] as const) {
      assert.equal(supportsExtMode(id, mode), true, `${id} 应当支持 ${mode}`)
    }
  }
})

test('★ wiki-toc 两处渲染点共用同一个 id（窄屏折叠块 + xl 右侧栏）', () => {
  /*
   * 这条断言钉的是一个**决策**，不是实现细节：插件说的是"文章页的目录"，
   * 不是"某一个断点下的目录"。分两个 id 会让作者为同一件事声明两次，且很容易
   * 只接了一处——表现是"宽屏换了、窄屏没换"这种极难被发现的半坏状态。
   */
  const wiki = pageSource('WikiPage.tsx')
  const occurrences = [...wiki.matchAll(/<Ext\s+id="wiki-toc"/g)].length
  assert.equal(occurrences, 2, 'wiki-toc 应当正好出现在两处渲染点（inline 与 sidebar）')
  assert.match(wiki, /variant="inline"/, 'inline（窄屏折叠块）那一处应当仍在')
  assert.match(wiki, /variant="sidebar"/, 'sidebar（右栏）那一处应当仍在')
})

test('★ 渲染：replace wiki-actions 后默认实现不渲染；卸载后逐字还原', () => {
  unregisterSlot('wiki-actions')
  const fallback = createElement('div', { className: 'ml-auto' }, createElement('button', null, '编辑'))
  const render = (): string =>
    renderToStaticMarkup(createElement(Ext, { id: 'wiki-actions', children: fallback }))

  // 1) 无贡献 ⇒ 宿主默认实现（DOM 与接线前逐字一致）
  assert.equal(render(), '<div class="ml-auto"><button>编辑</button></div>')

  // 2) replace ⇒ 完全接管，默认实现不渲染
  const off = registerExtensionByName(
    'wiki-actions',
    () => createElement('div', { className: 'my-actions' }, createElement('button', null, '分享')),
    '@demo/actions',
    'replace',
  )
  assert.equal(render(), '<div class="my-actions"><button>分享</button></div>')
  assert.equal(slotSummary()['wiki-actions'], 1)

  // 3) 卸载 ⇒ 逐字还原
  off()
  assert.equal(render(), '<div class="ml-auto"><button>编辑</button></div>')
  assert.equal(slotSummary()['wiki-actions'], 0)
})

test('★ 渲染：wrap account-profile 时宿主默认卡仍在 default 里（不会弄丢表单）', () => {
  unregisterSlot('account-profile')
  const fallback = createElement('div', { className: 'card' }, createElement('form', null, '资料'))
  const off = registerExtensionByName(
    'account-profile',
    (props: Record<string, unknown>) =>
      createElement('section', { className: 'my-profile' }, props.default as never),
    '@demo/profile',
    'wrap',
  )
  const html = renderToStaticMarkup(createElement(Ext, { id: 'account-profile', children: fallback }))
  assert.equal(html, '<section class="my-profile"><div class="card"><form>资料</form></div></section>')
  off()
  unregisterSlot('account-profile')
})

test('★ 渲染：extend wiki-meta 追加在默认行之后（默认行不变）', () => {
  unregisterSlot('wiki-meta')
  const fallback = createElement('div', { className: 'meta' }, '更新于 昨天')
  const off = registerExtensionByName(
    'wiki-meta',
    () => createElement('span', { className: 'reading-time' }, '3 分钟'),
    '@demo/reading-time',
    'extend',
  )
  const html = renderToStaticMarkup(createElement(Ext, { id: 'wiki-meta', children: fallback }))
  assert.match(html, /<div class="meta">更新于 昨天<\/div>/)
  assert.match(html, /<span class="reading-time">3 分钟<\/span>/)
  off()
  unregisterSlot('wiki-meta')
})
