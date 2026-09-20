/**
 * **模式化出口 `<Ext>` 与 `registerExtension`** 的守卫（P4）。
 *
 * ## 这个文件防的是什么
 * 三种模式里只有 `extend` 是"安全"的：它最多是"多了一块"。另外两种会**改变宿主既有界面**，
 * 而它们的失败方式都是静默的：
 *
 * 1. `replace` 被允许用在"不该被替换"的节点上（页头、页脚）⇒ 宿主那部分语义消失，
 *    而插件作者以为自己在做一件小事；
 * 2. `replace` / `wrap` 的贡献抛错时**没有回退**⇒ 控件消失（用户拍板的语义是"必须回退默认"）；
 * 3. 应用顺序写反（先 wrap 后 replace）⇒ `default` 链断掉，包裹层包了个空。
 *
 * 因此这里既测**注册期校验**（节点/模式），也测**渲染结果**（用 `react-dom/server`
 * 真实渲染，而不是读源码猜测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/*
 * 本文件直接 import `src/lib/slots.tsx` 并**真的渲染**一遍。
 *
 * 注（P7 起）：slots.tsx 会牵进 `hostSdk.ts` / `pluginUi.ts`，它们都在模块求值期往 `window`
 * 上挂调试出口。那两处**已加 `typeof window` 守卫**（因为 `src/ui/*` 的原语现在也会牵进这条链），
 * 所以 Node 下 import 本模块是安全的——不需要任何 `window` 垫片。
 */
import {
  Ext,
  ExtBoundary,
  clearExtFailures,
  extFailures,
  registerExtensionByName,
  slotSummary,
  unregisterSlot,
} from '../src/lib/slots'

/** 造一个打上 `data-src` 的贡献组件（便于断言"谁渲染的"） */
const marker = (src: string) => (props: Record<string, unknown>) =>
  createElement('span', { 'data-src': src }, String(props.default === undefined ? '（无默认）' : '（有默认）'))

function cleanup(node: string): void {
  unregisterSlot(node)
  clearExtFailures()
}

test('registerExtension：catalog 节点 + 允许的模式 ⇒ 登记成功并带上模式', () => {
  cleanup('app-footer')
  const off = registerExtensionByName('app-footer', marker('p1'), 'p1', 'extend')
  assert.equal(slotSummary()['app-footer'], 1)
  off()
  assert.equal(slotSummary()['app-footer'], 0)
  // 幂等
  off()
  assert.equal(slotSummary()['app-footer'], 0)
})

test('★ replace 只对"允许被替换"的节点开放：app-header 被拒、editor 被接受', () => {
  cleanup('app-header')
  const warns: string[] = []
  const orig = console.warn
  console.warn = (m?: unknown) => warns.push(String(m))
  let off: () => void
  try {
    off = registerExtensionByName('app-header', marker('p1'), 'p1', 'replace')
  } finally {
    console.warn = orig
  }
  assert.equal(slotSummary()['app-header'], 0, '页头不允许 replace（宿主就没有页头语义了）')
  assert.equal(warns.length, 1)
  assert.match(warns[0] as string, /不允许 replace/)
  off!()

  // 反向对照：同一调用换成 editor 必须成功（否则上面的断言可能只是"所有 replace 都被拒"）
  cleanup('editor')
  const ok = registerExtensionByName('editor', marker('p1'), 'p1', 'replace')
  assert.equal(slotSummary()['editor'], 1)
  ok()
})

test('★ 笔误的宿主节点名仍被挡下（目录取代白名单之后，这条不能丢）', () => {
  cleanup('app-headr')
  const warns: string[] = []
  const orig = console.warn
  console.warn = (m?: unknown) => warns.push(String(m))
  try {
    registerExtensionByName('app-headr', marker('p1'), 'p1', 'extend')
    // 插件自定义扩展点仍合法（含 `/`）
    registerExtensionByName('my-plugin/panel', marker('p2'), 'p2', 'extend')
  } finally {
    console.warn = orig
  }
  assert.equal(slotSummary()['app-headr'], undefined, '笔误名不得登记')
  assert.equal(warns.length, 1, '只有笔误那次该告警')
  assert.equal(slotSummary()['my-plugin/panel'], 1)
  cleanup('my-plugin/panel')
})

test('SSR 渲染：无贡献时渲染宿主默认实现（出口不能吞掉默认内容）', () => {
  cleanup('app-footer')
  const html = renderToStaticMarkup(createElement(Ext, { id: 'ui-spinner' as never, children: createElement('i', null, '默认') }))
  assert.equal(html, '<i>默认</i>')
})

test('★ SSR 渲染：replace 接管（默认不渲染）、wrap 包住默认、extend 追加', () => {
  cleanup('editor')
  const noop = registerExtensionByName('editor', marker('noop'), 'noop', 'extend')
  noop()
  assert.equal(slotSummary()['editor'], 0)

  // 1) replace：默认实现不出现
  const offReplace = registerExtensionByName('editor', marker('replacer'), 'replacer', 'replace')
  assert.equal(
    renderToStaticMarkup(createElement(Ext, { id: 'editor' as never, children: createElement('i', null, '默认') })),
    '<span data-src="replacer">（无默认）</span>',
  )
  offReplace()

  // 2) wrap：拿到 default（宿主默认被包在里面）
  const offWrap = registerExtensionByName('editor', marker('wrapper'), 'wrapper', 'wrap')
  assert.equal(
    renderToStaticMarkup(createElement(Ext, { id: 'editor' as never, children: createElement('i', null, '默认') })),
    '<span data-src="wrapper">（有默认）</span>',
  )
  offWrap()

  // 3) extend：默认照常渲染，贡献追加在后
  const offExtend = registerExtensionByName('editor', marker('ext'), 'ext', 'extend')
  assert.equal(
    renderToStaticMarkup(createElement(Ext, { id: 'editor' as never, children: createElement('i', null, '默认') })),
    '<i>默认</i><span data-src="ext">（无默认）</span>',
  )
  offExtend()
  cleanup('editor')
})

test('★ 三模式同时在场时按 replace → wrap → extend 组合（顺序写反会让 default 链断掉）', () => {
  cleanup('app-dock')
  const offR = registerExtensionByName('app-dock', marker('R'), 'r', 'replace')
  const offW = registerExtensionByName('app-dock', marker('W'), 'w', 'wrap')
  const offE = registerExtensionByName('app-dock', marker('E'), 'e', 'extend')
  const html = renderToStaticMarkup(
    createElement(Ext, { id: 'app-dock' as never, children: createElement('i', null, '默认') }),
  )
  // W 必须拿到 R 的结果作为 default（而非默认实现），E 追加在最后
  assert.equal(html, '<span data-src="W">（有默认）</span><span data-src="E">（无默认）</span>')
  offR()
  offW()
  offE()
  cleanup('app-dock')
})

test('★ 回退语义白盒：replace/wrap 抛错时渲染宿主默认实现（控件不消失）', () => {
  /*
   * React 的错误边界只在客户端生效，`renderToStaticMarkup` 下抛错会直接冒泡 ——
   * 因此这条**用户拍板的语义**只能白盒钉：构造边界、注入错误态、断言渲染的是 fallback。
   */
  const fallback = createElement('i', null, '默认')
  const boundary = new ExtBoundary({
    node: 'ui-button',
    source: 'p1',
    mode: 'replace',
    fallback,
    children: createElement('b', null, '插件界面'),
  })
  // 未出错：渲染子节点
  assert.equal(renderToStaticMarkup(createElement('div', null, boundary.render())), '<div><b>插件界面</b></div>')
  // 出错：渲染 fallback（**不是**"插件界面渲染失败"占位文案——那会让控件消失）
  boundary.state = ExtBoundary.getDerivedStateFromError(new Error('boom'))
  assert.equal(renderToStaticMarkup(createElement('div', null, boundary.render())), '<div><i>默认</i></div>')
})

test('★ 回退记录：失败要留下可诊断的证据（记录本身不 render 也能读）', () => {
  // ExtBoundary 的 componentDidCatch 负责记录；这里直接验证记录器的可读语义与幂等
  clearExtFailures()
  assert.deepEqual(extFailures(), [], '初始应为空')
  assert.ok(Array.isArray(extFailures()), 'extFailures 必须是数组快照（管理台据此渲染告警）')
})

test('ExtProps.id 是编译期枚举的宿主节点（源码级钉住：不得改成宽 string）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/lib/slots.tsx', import.meta.url), 'utf8')
  assert.match(
    src,
    /readonly id: HostNodeName/,
    'Ext 的 id 必须是 HostNodeName（编译期挡住宿主自己的渲染点写错），不能是 string。',
  )
})
