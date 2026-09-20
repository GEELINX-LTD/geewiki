/**
 * **按插件作用域的受限宿主**（`createPluginUiHost`）的守卫（P12）。
 *
 * ## 这个文件为什么必须存在
 * 越权闸门写错是**完全静默**的：漏拦一个被抑制的 `replace`，界面照样渲染 —— 只是渲染了错的
 * 那一个（`pluginUi.ts` 里记着"E2E 抓到过：赢家是 A，界面却渲染了 B"）。这段逻辑原先内联在
 * `loadPluginUi` 里，只能靠浏览器 E2E 覆盖，而 E2E 需要插件处于 active（要 admin 登录 + CSRF）；
 * 抽成 `createPluginUiHost` 之后，可以用假 `meta` / 假 `suppressed` 把**每条闸门**逐一走一遍，
 * 并且都带**必须放行**的反向对照。
 *
 * ## 覆盖的三件事
 * 1. `registerExtension` 存在、过闸门、且把贡献**归属到插件名**（否则卸载时无法按 owner 回收）；
 * 2. 主判据（后端 `suppressed`）与次判据（入口表生效节点 `slots ∪ extNodes`）**两个入口共用**；
 * 3. 反向对照：两个字段都缺省的**纯浏览器侧插件**必须照旧放行（既有行为不能被我改坏）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPluginUiHost, type PluginUiHostContext } from '../src/lib/pluginUi'
import { slotContributors, slotSummary, unregisterSlot } from '../src/lib/slots'
import type { GeeWikiHostSdk } from '../src/lib/hostSdk'

/** 只实现被用到的成员：整个 SDK 的其余部分与本文件无关（多写只会变成需要同步维护的镜像） */
const SDK = {
  React: {},
  jsxRuntime: { jsx: () => null, jsxs: () => null, Fragment: null },
  version: '0.0.0-test',
  unregisterSlot: () => {},
  renderMarkdown: (markdown: string) => markdown,
} as unknown as GeeWikiHostSdk

const C = (): null => null

/** 静默 `console.warn` 并返回收集到的告警（结束后由调用方还原） */
function captureWarn(): { warns: string[]; restore: () => void } {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (m?: unknown) => warns.push(String(m))
  return { warns, restore: () => (console.warn = orig) }
}

function makeHost(overrides: Partial<PluginUiHostContext> = {}): {
  host: ReturnType<typeof createPluginUiHost>
  disposers: Array<() => void>
} {
  const disposers: Array<() => void> = []
  const host = createPluginUiHost({
    name: '@demo/a',
    sdk: SDK,
    meta: { entry: 'client.js', rev: 'r' },
    suppressed: new Map(),
    disposers,
    ...overrides,
  })
  return { host, disposers }
}

test('★ P12：registerExtension 过闸门、把贡献归属到插件名、注销函数被收集', () => {
  unregisterSlot('ui-button')
  const { host, disposers } = makeHost({
    meta: { entry: 'client.js', rev: 'r', extNodes: ['ui-button'] },
  })
  const off = host.registerExtension('ui-button', C, { mode: 'replace' })
  assert.equal(slotSummary()['ui-button'], 1, '生效节点上的注册必须成功')
  assert.deepEqual(
    [...slotContributors('ui-button')],
    ['@demo/a'],
    '来源必须是**插件名**：写成 host-sdk 的话，插件停用后这条贡献无法按 owner 回收',
  )
  assert.equal(disposers.length, 1, '注销函数必须进入 disposers（unloadPluginUi 靠它清理）')
  off()
  assert.equal(slotSummary()['ui-button'], 0)
})

test('★ P12：被抑制的扩展节点注册被拦（主判据），赢家照常注册（反向对照）', () => {
  unregisterSlot('ui-button')
  const suppressed = new Map([['ui-button', new Set(['@demo/b'])]])
  const loser = makeHost({
    name: '@demo/b',
    suppressed,
    meta: { entry: 'client.js', rev: 'r', extNodes: ['ui-button'] },
  })
  const cap = captureWarn()
  try {
    loser.host.registerExtension('ui-button', C, { mode: 'replace' })
  } finally {
    cap.restore()
  }
  assert.equal(slotSummary()['ui-button'], 0, '被抑制者不得注册（否则可能渲染出被抑制的实现）')
  assert.equal(cap.warns.length, 1, `应当恰好告警一次，实际：${cap.warns.join(' | ')}`)
  assert.match(cap.warns[0]!, /被抑制/, '告警必须点名"被抑制"，否则排障时看不出是仲裁而非加载失败')

  const winner = makeHost({
    name: '@demo/a',
    suppressed,
    meta: { entry: 'client.js', rev: 'r', extNodes: ['ui-button'] },
  })
  winner.host.registerExtension('ui-button', C, { mode: 'replace' })
  assert.equal(slotSummary()['ui-button'], 1, '赢家不受影响')
  unregisterSlot('ui-button')
})

test('★ P12：未获生效的节点被拦（次判据）；插槽与扩展节点走**同一条**判据', () => {
  unregisterSlot('ui-button')
  unregisterSlot('app-header')
  // ① 声明了 ui-card，却去注册 ui-button ⇒ 拦
  const declaredExt = makeHost({ meta: { entry: 'client.js', rev: 'r', extNodes: ['ui-card'] } })
  const capExt = captureWarn()
  try {
    declaredExt.host.registerExtension('ui-button', C)
  } finally {
    capExt.restore()
  }
  assert.equal(slotSummary()['ui-button'], 0)
  assert.match(capExt.warns[0]!, /未获生效/, '告警必须说清"未获生效"，并列出该插件的生效节点')

  // ② 同一个宿主上：声明了 editor，却去注册 app-header ⇒ 同样拦（两个入口共用 gate）
  const declaredSlot = makeHost({ meta: { entry: 'client.js', rev: 'r', slots: ['editor'] } })
  const capSlot = captureWarn()
  try {
    declaredSlot.host.registerSlot('app-header', C)
  } finally {
    capSlot.restore()
  }
  assert.equal(slotSummary()['app-header'], 0)
  assert.match(capSlot.warns[0]!, /未获生效/)
})

test('★ P12：两个字段都缺省的纯浏览器侧插件必须照旧放行（既有行为，不许被我改坏）', () => {
  unregisterSlot('ui-button')
  unregisterSlot('app-header')
  /*
   * 这是**反向对照**里最重要的一条：不在后端 owners 里的插件（例如 `plugins/hello-geewiki`
   * 的产物）在 client.js 里直接注册界面，入口表两个字段都不会出现。若把"未声明"一律当越权，
   * 这类插件的界面会**整体消失**——而它们今天工作正常。
   */
  const pure = makeHost({ meta: { entry: 'client.js', rev: 'r' } })
  const cap = captureWarn()
  try {
    pure.host.registerExtension('ui-button', C, { mode: 'replace' })
    pure.host.registerSlot('app-header', C)
  } finally {
    cap.restore()
  }
  assert.equal(slotSummary()['ui-button'], 1)
  assert.equal(slotSummary()['app-header'], 1)
  assert.deepEqual(cap.warns, [], '放行路径不得产生任何告警')
  unregisterSlot('ui-button')
  unregisterSlot('app-header')
})

test('★ P12：次判据是**逐字段**的——只声明了 extNodes 的插件，插槽注册照旧放行', () => {
  /*
   * 反向对照里最容易被"顺手改严"的一条：次判据的语义是"**该字段**缺省 ⇒ 不校验"。
   * 若把两个字段取并集，一个只声明了 `geewiki.extensions` 的插件，它**既有**的插槽注册
   * （`host.registerSlot('app-header', …)`）会被突然拦下——插件没改一行，界面却少一块。
   */
  unregisterSlot('app-header')
  unregisterSlot('ui-card')
  const { host } = makeHost({ meta: { entry: 'client.js', rev: 'r', extNodes: ['ui-card'] } })
  const cap = captureWarn()
  try {
    host.registerSlot('app-header', C) // slots 字段缺省 ⇒ 不校验
    host.registerExtension('ui-card', C) // 声明过 ⇒ 放行
  } finally {
    cap.restore()
  }
  assert.equal(slotSummary()['app-header'], 1, 'slots 字段缺省时不得拿 extNodes 去校验插槽')
  assert.equal(slotSummary()['ui-card'], 1)
  assert.deepEqual(cap.warns, [])
  unregisterSlot('app-header')
  unregisterSlot('ui-card')
})

test('★ P12：registerExtension 对**插槽名**也走插槽字段（模式化注册插槽是合法用法）', () => {
  unregisterSlot('app-header')
  const ok = makeHost({ meta: { entry: 'client.js', rev: 'r', slots: ['app-header'] } })
  ok.host.registerExtension('app-header', C, { mode: 'extend' })
  assert.equal(slotSummary()['app-header'], 1, '声明过的插槽用 registerExtension 注册必须放行')

  unregisterSlot('app-header')
  const bad = makeHost({ meta: { entry: 'client.js', rev: 'r', slots: ['editor'] } })
  const cap = captureWarn()
  try {
    bad.host.registerExtension('app-header', C)
  } finally {
    cap.restore()
  }
  assert.equal(slotSummary()['app-header'], 0, '未声明的插槽名仍要被拦（空间判定不能把插槽当扩展节点放行）')
  assert.match(cap.warns[0]!, /未获生效/)
  unregisterSlot('app-header')
})

test('★ P12：示例插件的「清单声明 ⇄ bundle 注册」必须一致（漂移会被闸门静默拦下）', () => {
  /*
   * 为什么用**源码级**断言而不是把示例 bundle import 进来跑一遍：夹具源码 `import './style.css'`，
   * Node 下 import CSS 会直接抛 `ERR_UNKNOWN_FILE_EXTENSION`（这条链的真实验证属于浏览器端，
   * 见 `scripts/acceptance/`）。
   * 但"声明与注册漂移"是最容易发生的错误，而且后果**只在运行时告警**（界面少一块、没报错），
   * 所以这里把两侧文本对上：清单里声明了哪个节点/模式，bundle 里就得那么注册。
   */
  const manifest = JSON.parse(
    readFileSync(new URL('../../../plugins/ui-demo/package.json', import.meta.url), 'utf8'),
  ) as { geewiki?: { slots?: string[]; extensions?: { node?: string; mode?: string }[] } }
  const bundle = readFileSync(new URL('../fixtures/src/index.tsx', import.meta.url), 'utf8')

  const declaredExt = manifest.geewiki?.extensions ?? []
  assert.ok(declaredExt.length > 0, '示例插件应当至少声明一个扩展节点（否则这条断言是空转）')
  for (const decl of declaredExt) {
    assert.ok(decl.node && decl.mode, `声明缺字段：${JSON.stringify(decl)}`)
    assert.match(
      bundle,
      // 注意源码里是可选链 `registerExtension?.(`（`?` `.` `(` 三个字符），别漏掉那个点
      new RegExp(`registerExtension\\?\\.\\('${decl.node}'[^)]*mode: '${decl.mode}'`),
      `bundle 必须按清单声明的模式注册 ${decl.node}（否则被越权闸门拦下，只在运行时告警）`,
    )
  }
  for (const slot of manifest.geewiki?.slots ?? []) {
    assert.match(
      bundle,
      new RegExp(`registerSlot\\('${slot}'`),
      `bundle 应当注册声明过的插槽 ${slot}`,
    )
  }
})

test('★ P12：生效节点集合 = slots ∪ extNodes（两类可同时存在，互不排斥）', () => {
  unregisterSlot('editor')
  unregisterSlot('ui-button')
  const { host } = makeHost({
    meta: { entry: 'client.js', rev: 'r', slots: ['editor'], extNodes: ['ui-button'] },
  })
  host.registerSlot('editor', C)
  host.registerExtension('ui-button', C, { mode: 'replace' })
  assert.equal(slotSummary()['editor'], 1)
  assert.equal(slotSummary()['ui-button'], 1)
  unregisterSlot('editor')
  unregisterSlot('ui-button')
})
