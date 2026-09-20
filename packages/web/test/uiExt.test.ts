/**
 * **基础原语的扩展点接线**（P7）守卫。
 *
 * ## 这个文件防的是什么
 * 「一切前端元素可被扩展」的杠杆是：原语在**定义处**接一层 `<Ext>`，于是全仓所有调用点
 * （`Button` 有几十处，多数直接 `import '../ui/Button'`、不走 barrel）同时获得扩展能力。
 *
 * 这条杠杆的两种坏法都是**静默**的：
 *
 * 1. **目录与接线漂移**：目录里登记了 `ui-card`，但 `Card.tsx` 忘了接（或反过来，
 *    接了却没登记）⇒ 插件"声明成功、界面毫无变化"（前者）或"注册被拒、作者一头雾水"（后者）。
 * 2. **接线被重构掉**：某次重构把 `withExt(...)` 换回普通导出，能力**无声消失**——
 *    没有任何测试会红，因为渲染结果完全正常。
 *
 * 因此这里做**双向**比对（目录 ↔ 源码里的 `withExt` 调用），再真渲染一遍验证
 * "replace 生效 / 卸载后逐字还原"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HOST_NODE_CATALOG, hostNodeSpec } from '@geewiki/core/extensions'
import { Button } from '../src/ui/Button'
import { Input, Textarea } from '../src/ui/Input'
import { Card } from '../src/ui/Card'
import { Spinner } from '../src/ui/Spinner'
import { registerExtensionByName, slotSummary, unregisterSlot } from '../src/lib/slots'

const UI_DIR = new URL('../src/ui/', import.meta.url)
const files = readdirSync(UI_DIR).filter((n) => n.endsWith('.tsx'))

/** 源码里所有 `withExt('<node>', …)` 的节点 id（接线事实） */
function wiredNodes(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    const src = readFileSync(join(UI_DIR.pathname, f), 'utf8')
    for (const m of src.matchAll(/withExt\(\s*'([^']+)'/g)) {
      const node = m[1] as string
      assert.equal(out.has(node), false, `${node} 在多个文件里被接线（${out.get(node)} 与 ${f}）`)
      out.set(node, f)
    }
  }
  return out
}

test('★ 双向比对：目录里的每个 ui-* 都已接线，且接线了的一定在目录里', () => {
  const wired = wiredNodes()
  const declared = Object.entries(HOST_NODE_CATALOG)
    .filter(([, s]) => s.kind === 'ui')
    .map(([id]) => id)

  // 自证：两边都非空（否则"两边都空 ⇒ 相等"会空洞通过）
  assert.ok(declared.length >= 8, `目录里的 ui-* 节点过少（${declared.length}），疑似解析失效`)
  assert.ok(wired.size >= 8, `源码里解析到的 withExt 调用过少（${wired.size}），疑似正则失效`)

  const declaredNotWired = declared.filter((id) => !wired.has(id))
  assert.deepEqual(
    declaredNotWired,
    [],
    '以下节点在目录里（插件可声明、可贡献），但 `src/ui/*` 里没有任何 `withExt` 接线：\n  ' +
      `${declaredNotWired.join('\n  ')}\n` +
      '后果是"插件声明成功、界面毫无变化"——**没有任何报错**。请接线，或从目录里删掉它。',
  )
  const wiredNotDeclared = [...wired.keys()].filter((id) => !declared.includes(id))
  assert.deepEqual(
    wiredNotDeclared,
    [],
    '以下节点已接线，但不在 `@geewiki/core/extensions` 的目录里：\n  ' +
      `${wiredNotDeclared.join('\n  ')}\n` +
      '后果是插件注册时被"未知节点"拒绝（作者一头雾水），或绕过目录校验。请补目录条目。',
  )
})

test('★ 已接线的 ui 节点模式集合符合规则（叶子三模式 / portal 两模式）', () => {
  for (const [node, file] of wiredNodes()) {
    const spec = hostNodeSpec(node)
    assert.ok(spec, `${node}（${file}）不在目录里`)
    assert.equal(spec.kind, 'ui', `${node} 的 kind 应为 ui`)
    const expected = spec.portal === true ? ['extend', 'replace'] : ['extend', 'wrap', 'replace']
    assert.deepEqual([...spec.modes], expected, `${node} 的模式集合变了（portal=${String(spec.portal)}）`)
    assert.equal(spec.propsVersion, 1)
  }
})

test('★ portal 类组件已接线，但**不开放 wrap**（这是决策，不是遗漏）', () => {
  /*
   * 这四个的**可见内容**经 Radix `<Portal>` 渲染到 `document.body` 附近，**不在调用处的 DOM
   * 子树里**。于是：
   * - `replace`（接管整个渲染）成立，且自由度最高；
   * - `extend`（在调用处追加）成立——调用处就是"用到这个 tooltip / 对话框的地方"，
   *   追加的东西看得见、位置可预期；
   * - `wrap` 的契约是"把你的元素包在宿主默认实现外面"，而 portal 的内容**装不进包装元素的
   *   子树**：包装元素落在调用处、样式与作用域都进不去（CSS 继承与选择器跨不过 portal 边界）
   *   ⇒ 作者会看到"我明明包住了，什么都没变"。**静默失效**，故砍掉这个模式
   *   （`PORTAL_UI_MODES = ['extend', 'replace']`），不是限制能力。
   *
   * 反过来，`ui-dialog` / `ui-dropdown-menu` **仍然不在目录里**：它们只是 Radix `Root` 的再导出，
   * 渲染不出 DOM、也不是可见元素——要换的"对话框面 / 菜单面"是 Content，节点挂在后者上。
   *
   * 每个节点的 `portal: true` 都必须有**源码证据**（下表最后一列），否则这个标记会变成
   * 一句没人核对的注释，而它的唯一作用就是决定 `wrap` 能不能用。
   */
  const PORTAL_NODES = [
    { id: 'ui-dialog-content', file: 'Dialog.tsx', evidence: /DialogPrimitive\.Portal/ },
    { id: 'ui-dropdown-menu-content', file: 'DropdownMenu.tsx', evidence: /Menu\.Portal/ },
    // 经 `DialogContent` **间接** portal：本文件里没有 `Portal` 字样，渲染的是上面那个节点
    { id: 'ui-confirm-dialog', file: 'ConfirmDialog.tsx', evidence: /<DialogContent/ },
    { id: 'ui-tooltip', file: 'Tooltip.tsx', evidence: /TooltipPrimitive\.Portal/ },
  ] as const
  for (const { id, file, evidence } of PORTAL_NODES) {
    const spec = hostNodeSpec(id)
    assert.ok(spec, `${id} 应当在目录里（portal 类：extend + replace）`)
    assert.equal(spec.kind, 'ui', `${id} 的 kind 应为 ui`)
    assert.equal(spec.portal, true, `${id} 必须标 portal: true（它决定了 wrap 不可用）`)
    assert.deepEqual([...spec.modes], ['extend', 'replace'], `${id} 不得开放 wrap`)
    const src = readFileSync(join(UI_DIR.pathname, file), 'utf8')
    assert.match(src, evidence, `${file} 里没有 portal 渲染的证据——portal: true 这个声明不成立`)
    assert.match(src, new RegExp(`withExt\\('${id}'`), `${file} 里没有 withExt('${id}') 接线`)
  }
  for (const id of ['ui-dialog', 'ui-dropdown-menu']) {
    assert.equal(hostNodeSpec(id), undefined, `${id} 只是 Radix Root 的再导出，渲染不出 DOM，不该进目录`)
  }
})

test('★ 全站生效：替换 ui-button 后**同一个组件**的渲染结果改变，卸载后逐字还原', () => {
  unregisterSlot('ui-button')
  const before = renderToStaticMarkup(createElement(Button, null, '保存'))
  assert.match(before, /^<button/, 'Button 的宿主默认实现应当是一个 <button>')
  assert.match(before, />保存</)

  // 插件 replace：整站所有 <Button> 同时变成插件实现（定义处接线，不需要改任何调用点）
  const off = registerExtensionByName(
    'ui-button',
    (props: Record<string, unknown>) => createElement('a', { 'data-plugin': 'demo', href: '#' }, props.children as never),
    '@demo/button',
    'replace',
  )
  const after = renderToStaticMarkup(createElement(Button, null, '保存'))
  assert.equal(after, '<a data-plugin="demo" href="#">保存</a>')
  assert.equal(slotSummary()['ui-button'], 1)

  off()
  assert.equal(renderToStaticMarkup(createElement(Button, null, '保存')), before, '卸载后必须逐字还原')
})

test('★ wrap ui-input 时宿主 input 仍在 default 里（包一层不会弄丢控件）', () => {
  unregisterSlot('ui-input')
  const off = registerExtensionByName(
    'ui-input',
    (props: Record<string, unknown>) =>
      createElement('span', { className: 'field' }, props.default as never),
    '@demo/field',
    'wrap',
  )
  const html = renderToStaticMarkup(createElement(Input, { 'aria-label': '标题' }))
  assert.match(html, /^<span class="field"><input/)
  off()
  unregisterSlot('ui-input')
})

test('★ 组件自身的 props 会转发给贡献者（否则 replace 者拿不到 onClick 等）', () => {
  unregisterSlot('ui-textarea')
  let seen: Record<string, unknown> | null = null
  const off = registerExtensionByName(
    'ui-textarea',
    (props: Record<string, unknown>) => {
      seen = props
      return createElement('textarea', { 'data-plugin': 'x' })
    },
    '@demo/ta',
    'replace',
  )
  renderToStaticMarkup(createElement(Textarea, { rows: 3, 'aria-label': '正文' }))
  assert.ok(seen, '贡献者必须被调用')
  assert.equal((seen as Record<string, unknown>).rows, 3, '组件 props 必须原样转发')
  assert.equal((seen as Record<string, unknown>)['aria-label'], '正文')
  assert.equal((seen as Record<string, unknown>).propsVersion, 1)
  off()
  unregisterSlot('ui-textarea')
})

test('★ 非原语节点（Card 的兄弟）不受影响：Card 接线后仍渲染 section', () => {
  unregisterSlot('ui-card')
  assert.match(renderToStaticMarkup(createElement(Card, null, 'x')), /^<section/)
  assert.match(renderToStaticMarkup(createElement(Spinner, { label: '加载' })), /^<span/)
})
