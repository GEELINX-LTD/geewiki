/**
 * "点 dock 外部直接收起"的源码守卫。
 *
 * ## 为什么是源码守卫
 * 用户的要求是「当点击 dock 外的时候直接收起，而不是一定要点收起按钮」。这件事的判据全在
 * **DOM 结构 + 事件监听**里，而两条最容易写错的路都**不会报错、界面也看着正常**：
 *   · 判"内部/外部"的 `contains` 挂在**面板**上而不是**根节点**上 —— 于是点输入条、点历史面板
 *     都会被当成"点外部"，刚展开就自己收起；
 *   · 忘记 `removeEventListener` —— 每次开合都多留一个 document 监听，用久了变成
 *     "点一下页面收起好几次"（`setOpen(false)` 幂等，所以症状只是偶发怪异，不是崩溃）。
 *
 * 本仓前端测试约定：`.tsx` 只当源文本读、不 import（见 `pluginUi.test.ts`）。
 * 真正的行为判据在真浏览器里（`data/verify/dock-ui/motion.mjs` 会真的点外部与点内部）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const uiSource = readFileSync(join(here, '..', 'ui', 'index.tsx'), 'utf8')

/* ============================ ① 判据挂在哪 ============================ */

test('① "外部"判据挂在**根节点**上（不是面板：面板/输入条/历史面板都在根节点下）', () => {
  assert.match(uiSource, /const rootRef = useRef<HTMLDivElement \| null>\(null\)/, '缺少根节点 ref')
  assert.match(
    uiSource,
    /<div ref=\{rootRef\} className=\{`gw-dock\$\{open \? ' gw-dock-open' : ''\}`\} data-slot="app-dock">/,
    '根节点必须带 ref={rootRef}（少了它 contains 永远拿到 null，"点外部"整个失效）',
  )
  assert.match(uiSource, /root\.contains\(target\)/, '判据必须是 root.contains(target)')
  assert.ok(
    !/panelRef[\s\S]{0,200}contains\(/.test(uiSource),
    '判据不许挂在面板上：那样点输入条/历史面板也会被当成"外部"',
  )
})

/* ============================ ② 事件与清理 ============================ */

test('② pointerdown 挂捕获阶段，且**只在展开时**挂、带着 cleanup（不泄漏监听）', () => {
  const at = uiSource.indexOf('const onPointerDown')
  assert.ok(at >= 0, '找不到 onPointerDown 处理器')
  const body = uiSource.slice(uiSource.lastIndexOf('useEffect(', at), uiSource.indexOf('}, [open])', at))
  assert.match(body, /if \(!open\) return/, '收起态不该挂 document 监听（白多一个全局监听）')
  assert.match(
    body,
    /document\.addEventListener\('pointerdown', onPointerDown, true\)/,
    '必须挂捕获阶段（第三个参数 true）：别人的 stopPropagation 不该让"点外部"失效',
  )
  assert.match(body, /document\.removeEventListener\('pointerdown', onPointerDown, true\)/, '缺少 pointerdown 的 cleanup')
  assert.match(body, /document\.addEventListener\('keydown', onKeyDown\)/, 'Esc 是同一件事的键盘对应物')
  assert.match(body, /document\.removeEventListener\('keydown', onKeyDown\)/, '缺少 keydown 的 cleanup')
  assert.match(body, /e\.key === 'Escape'/, 'Esc 判据必须是 e.key === \'Escape\'')
})

/* ============================ ③ 不要自己把自己关了 ============================ */

test('③ 不许在收起后把焦点还给输入条（它的 onFocus 就是"展开"，等于 Esc 无效）', () => {
  assert.ok(
    !/setOpen\(false\)[\s\S]{0,200}?\.focus\(\)/.test(uiSource),
    '收起路径里出现了 .focus()：两个输入框的 onFocus 都是 setOpen(true)，还焦点会让收起立刻反弹',
  )
})
