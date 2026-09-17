/**
 * 「全部页面」列表页的三条界面不变量（导航批 2026-09-16）——源码级守卫。
 *
 * 为什么是源码级：这三条都是"改起来很容易顺手破坏、跑起来又不报错"的类型——
 * 比如把隐藏项也剪掉（用户就再也找不到那个开关了）、把拖动写成"任意层级都能放"
 * （会把页面挪到别的分组，而层级是 URL 的一部分）、或者只有拖动没有键盘出口。
 *
 * 行为本身由浏览器验收（`data/verify/nav-tree/run.mjs`）与纯函数单测（`navHidden.test.ts`）覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const wikiPage = readFileSync(join(SRC, 'pages', 'WikiPage.tsx'), 'utf8')
const sidebar = readFileSync(join(SRC, 'components', 'Sidebar.tsx'), 'utf8')
const navTree = readFileSync(join(SRC, 'lib', 'navTree.ts'), 'utf8')

test('列表页用**未剪枝**的树：隐藏项必须显示出来（灰色 + 标记），否则用户再也点不到"取消隐藏"', () => {
  // 列表页建树时不得调用 pruneHidden
  const listStart = wikiPage.indexOf('function WikiList(')
  const listEnd = wikiPage.indexOf('function ', listStart + 10)
  const listSrc = wikiPage.slice(listStart, listEnd < 0 ? undefined : listEnd)
  /*
   * **先剥注释**：本文件里那段解释"剪枝只发生在侧栏"的注释本身就写着 `pruneHidden`，
   * 直接 `includes` 会命中注释而不是代码（本守卫第一版就是这么假红的）。
   */
  const listCode = listSrc.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(listCode.includes('buildNavTree('), '列表页要自己建树（同级顺序要生效）')
  assert.ok(!listCode.includes('pruneHidden'), '列表页不得剪掉隐藏项——剪枝只属于侧栏与翻页')
  assert.match(listCode, /node\.hidden && 'text-muted'/, '隐藏行必须有灰色（text-muted）')
  assert.match(listCode, /inheritedHidden \? '随父级隐藏' : '已隐藏'/, '两种隐藏要被区分（自己的开关 vs 被父级带下来）')
})

test('每行只有"有页面"的才给隐藏开关，且用 aria-pressed 表达状态', () => {
  assert.match(
    wikiPage,
    /\{page !== null && !inheritedHidden && \(\s*<button[\s\S]{0,400}?aria-pressed=\{ownHidden\}/,
    '隐藏开关必须绑 aria-pressed、只出现在有页面、且**不是被父级带下来隐藏**的行上',
  )
  assert.match(wikiPage, /api\.setNavHidden\(slug, !own\)/, '开关提交的是"取反"后的目标状态')
})

test('排序：拖动**只接受同层**，且必须另有键盘出口（↑/↓ 按钮）', () => {
  assert.match(
    wikiPage,
    /if \(drag === null \|\| drag\.parent !== row\.parent \|\| drag\.path === node\.path\) return/,
    '拖动必须判"同层"——跨层拖放等于把页面挪到别的分组，而层级是 URL 的一部分',
  )
  assert.match(wikiPage, /aria-label=\{`上移「\$\{page\?\.title \?\? node\.segment\}」`\}/, '上移要有可访问名（拖动不是键盘可达的操作）')
  assert.match(wikiPage, /aria-label=\{`下移「\$\{page\?\.title \?\? node\.segment\}」`\}/, '下移同理')
  assert.match(wikiPage, /moveRow\(row, -1\)/, '上移按钮要真的调用移动逻辑')
  assert.match(wikiPage, /moveWithinSiblings\(/, '移动必须走那一个纯函数（拖动与按钮共用同一实现）')
  assert.match(wikiPage, /api\.setNavOrder\(parent === '' \? null : parent, items\)/, '提交的是"这一层的新顺序"（顶层用 null）')
})

test('侧栏与翻页都按剪枝后的树渲染：隐藏的（含被父级带下来的）不出现', () => {
  assert.match(sidebar, /pruneHidden\(buildNavTree\(pages \?\? \[\], order\)\)/, '侧栏要剪掉隐藏子树')
  assert.match(sidebar, /countPages\(tree\)/, '"N 个页面"要用剪过的树（与能点到的条目数一致）')
  // 详情页的上一篇/下一篇走 flattenPages（它跳过 hidden）
  assert.match(wikiPage, /neighborsOf\(buildNavTree\(siblings, navOrder\), slug\)/, '翻页必须与侧栏同一棵树、同一份顺序')
  assert.match(navTree, /if \(node\.hidden\) continue/, 'flattenPages 必须跳过隐藏节点（含其子树）')
})
