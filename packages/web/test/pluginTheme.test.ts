/**
 * ★ F16：主题 / 品牌插件化 —— 覆盖注册表的单测。
 *
 * ## 这个文件要防的失效（按严重度）
 * 1. **浅色覆盖泄漏进深色模式**。这是本设计唯一真正难缠的坑：`:root` 与 `.dark` 的
 *    特异性相同（都是 (0,1,0)），插件样式表后注入 ⇒ 天真的 `:root{…}` 写法会把内置的
 *    深色值盖掉。症状是"深色模式下主题突然变浅"，且**只在配了主题的部署里出现**，
 *    本地默认主题的开发环境永远复现不了。所以这里有一条专门钉它的用例。
 * 2. **CSS 注入**。token 值是拼进样式表的，一个 `;` 就能闭合声明并追加任意规则。
 *    多条用例从"危险字符被拒"与"产物里不含危险字符"两个方向夹住它。
 * 3. **覆盖了不该覆盖的东西**。只放行 `--gw-*`：语义 token（`--color-*`）必须被拒，
 *    否则插件就绕过了两段式深浅色机制。
 * 4. **冲突无声**。同一 token 多来源时先注册者胜，但必须**可诊断**，
 *    否则排障线索只有"颜色不对"。
 *
 * 注意：本仓库的 node 测试**没有 DOM**（不引 jsdom），故全部断言都落在
 * `buildThemeCss()` 这个纯函数产物上——这也正是把"算 CSS"与"放进文档"拆开的原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  THEME_STYLE_ID,
  buildThemeCss,
  isSafeTokenValue,
  registerTheme,
  themeContributors,
  themeTokens,
  unregisterThemes,
  __resetThemesForTest,
} from '../src/lib/pluginTheme'

const fresh = (): void => __resetThemesForTest()

/** 花括号/圆括号配平 + 无裸分号逃逸：产物必须是合法 CSS 的最小自检 */
function assertCssSane(css: string): void {
  let depth = 0
  for (const ch of css) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    assert.ok(depth >= 0, `CSS 花括号提前闭合（可能被注入）: ${css}`)
  }
  assert.equal(depth, 0, `CSS 花括号未配平（可能被注入）: ${css}`)
}

/* --------------------------- 1. 深浅不互相泄漏 --------------------------- */

test('★ F16：只给 light 时，产物里【不存在】任何深色段（浅色覆盖不泄漏进深色）', () => {
  fresh()
  registerTheme('@t/brand', { light: { '--gw-blue-600': '#0b5fff' } })
  const css = buildThemeCss()
  assert.ok(css.includes('--gw-blue-600:#0b5fff'))
  // 浅色值只能出现在 `.light` 与 `prefers-color-scheme: light` 两处
  assert.ok(css.includes(':root.light{'), '应有显式浅色段')
  assert.ok(css.includes('@media (prefers-color-scheme: light)'), '应有系统偏好浅色段')
  assert.equal(css.includes('prefers-color-scheme: dark'), false, '只给了 light 就不得生成深色段')
  // 注意不能用 `css.includes('.dark')` 判：浅色段里的 `:not(.dark)` 同样含这个字面量
  assert.equal(css.includes(':root.dark{'), false, '只给了 light 就不得出现深色赋值块')
  assertCssSane(css)
})

test('★ F16：只给 dark 时，产物里【不存在】任何浅色段（反向同样成立）', () => {
  fresh()
  registerTheme('@t/brand', { dark: { '--gw-gray-25': '#0b131d' } })
  const css = buildThemeCss()
  assert.ok(css.includes(':root.dark{'))
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'))
  assert.equal(css.includes('prefers-color-scheme: light'), false)
  // 同上：深色段里的 `:not(.light)` 含 `.light` 字面量，故按赋值块判
  assert.equal(css.includes(':root.light{'), false, '只给了 dark 就不得出现浅色赋值块')
  assertCssSane(css)
})

test('★ F16：深浅都给 → 四段齐全，且系统偏好段必须带 :not(.light):not(.dark)', () => {
  fresh()
  registerTheme('@t/brand', {
    light: { '--gw-blue-600': '#0b5fff' },
    dark: { '--gw-blue-600': '#5b9bff' },
  })
  const css = buildThemeCss()
  assert.ok(css.includes(':root.light{--gw-blue-600:#0b5fff}'))
  assert.ok(css.includes(':root.dark{--gw-blue-600:#5b9bff}'))
  /*
   * 这两条是**与 theme.ts 的契约**：`system` 模式下 `<html>` 上两个 class 都没有，
   * 此时只能靠 `prefers-color-scheme` + `:not(.light):not(.dark)` 来选中。
   * 若有人把它"简化"成裸 `:root`，system 模式会双段同时命中（后者胜），
   * 表现为"跟随系统时永远显示深色主题"。
   */
  assert.ok(
    css.includes('@media (prefers-color-scheme: light){:root:not(.light):not(.dark){'),
    '系统偏好浅色段必须带 :not(.light):not(.dark)（否则 system 模式下两段会同时命中）',
  )
  assert.ok(
    css.includes('@media (prefers-color-scheme: dark){:root:not(.light):not(.dark){'),
    '系统偏好深色段必须带 :not(.light):not(.dark)',
  )
  assertCssSane(css)
})

/* ------------------------------ 2. 覆盖范围 ------------------------------ */

test('★ F16：只放行 --gw-* —— 语义 token 与畸形名字一律拒绝', () => {
  fresh()
  registerTheme('@t/brand', {
    light: {
      '--color-surface': '#fff', // 语义 token：改它会绕过两段式深浅色机制
      '--gw-blue-600': '#0b5fff', // 合法
      '--gw-': '#000', // 空段
      '--gw-Blue-600': '#000', // 大写
      '--gw-blue_600': '#000', // 下划线
      'color': 'red', // 根本不是自定义属性
      '--other-token': '#000', // 非 gw 前缀
    },
  })
  const { light } = themeTokens()
  assert.deepEqual(Object.keys(light), ['--gw-blue-600'], '只有合法的 --gw-* 才该生效')
  const rej = themeContributors()[0]!.rejected.join('\n')
  for (const bad of ['--color-surface', '--gw-:', '--gw-Blue-600', '--gw-blue_600', 'color', '--other-token']) {
    assert.ok(rej.includes(bad), `${bad} 应被记录为拒绝（排障需要看到原因）`)
  }
})

/* ------------------------------ 3. CSS 注入面 ------------------------------ */

test('★ F16：危险值被拒，且【产物里不含任何危险字符】（注入面为零）', () => {
  fresh()
  const dangerous = [
    'red;}body{display:none',
    'red;background:url(http://evil/x)',
    '#fff/**/',
    '#fff\\3b ',
    'a<b',
    'a>b',
    'red\n}',
    'red\t}',
    'a'.repeat(201),
  ]
  for (const v of dangerous) {
    assert.equal(isSafeTokenValue(v), false, `应判定为不安全: ${JSON.stringify(v)}`)
  }
  registerTheme('@t/evil', {
    light: Object.fromEntries(dangerous.map((v, i) => [`--gw-x${i}`, v])),
  })
  const css = buildThemeCss()
  assert.equal(css, '', '全部值非法 ⇒ 整条贡献无可用 token ⇒ 不产生任何 CSS')
  assertCssSane(css)

  // 混合场景：合法的那条仍生效，非法的不进入产物
  registerTheme('@t/evil2', {
    light: { '--gw-blue-600': '#0b5fff', '--gw-evil': 'red;}body{display:none}' },
  })
  const css2 = buildThemeCss()
  assert.ok(css2.includes('--gw-blue-600:#0b5fff'))
  for (const ch of [';', '{', '}']) {
    // 只允许作为「声明分隔」与「规则块」的结构性字符出现，绝不能作为值的残留
    assert.equal(css2.includes('red;'), false)
    assert.equal(css2.includes('display:none'), false)
    void ch
  }
  assertCssSane(css2)
})

test('★ F16：合法值必须放行（含 rgb()/hsl()/var()/颜色关键字/尺寸）', () => {
  const ok = [
    '#0b5fff',
    'rgb(11 95 255)',
    'rgb(11, 95, 255)',
    'rgba(0,0,0,.5)',
    'hsl(217 91% 60%)',
    'oklch(0.6 0.2 250)',
    'var(--gw-blue-500)',
    'transparent',
    'currentColor',
    '0.5rem',
    'calc(1rem + 2px)',
  ]
  for (const v of ok) assert.equal(isSafeTokenValue(v), true, `不应误伤合法值: ${v}`)
})

/* ------------------------------ 4. 冲突裁决 ------------------------------ */

test('★ F16：同一 token 先注册者胜，且冲突在诊断里可见', () => {
  fresh()
  registerTheme('@t/first', { light: { '--gw-blue-600': '#111111', '--gw-gray-25': '#fbfcfe' } })
  registerTheme('@t/second', { light: { '--gw-blue-600': '#222222', '--gw-red-600': '#cc0000' } })

  const { light } = themeTokens()
  assert.equal(light['--gw-blue-600'], '#111111', '先注册者胜')
  assert.equal(light['--gw-red-600'], '#cc0000', '不同 token 可叠加（后来的并非整条被丢）')

  const [first, second] = themeContributors()
  assert.equal(first!.applied, 2)
  assert.equal(second!.applied, 1, 'second 只有 red 生效')
  assert.ok(
    second!.rejected.some((r) => r.includes('--gw-blue-600') && r.includes('@t/first')),
    `second 的冲突应指向 @t/first，实测: ${JSON.stringify(second!.rejected)}`,
  )
})

test('★ F16：撤销先注册者后，被它压制的后来者【会】接管（裁决是现算的，不是注册时判死）', () => {
  fresh()
  const undoFirst = registerTheme('@t/first', { light: { '--gw-blue-600': '#111111' } })
  registerTheme('@t/second', { light: { '--gw-blue-600': '#222222' } })
  assert.equal(themeTokens().light['--gw-blue-600'], '#111111', 'A 在先 ⇒ A 胜')

  undoFirst()
  /*
   * 与 markdownExt **刻意不同**：那里重名在注册时就被拒（贡献根本没进注册表），
   * 所以先注册者撤销后名字就空了；这里所有贡献都进注册表、只在渲染时被压制，
   * 于是 A 一走，仍加载着的 B 应当接管。
   *
   * 为什么这个方向才对：A 卸载后它设的品牌色本就该消失，而 B 当初明确要过这个颜色。
   * 若永久判死，B 会在"A 已卸载"的状态下依然不生效，且只能靠重载 B 补救。
   */
  assert.equal(
    themeTokens().light['--gw-blue-600'],
    '#222222',
    'A 卸载后 B 应接管（若这里变红，说明裁决改成了注册时判死——那是另一种语义，需同步改文档）',
  )
  // 接管后诊断也要跟着变：不再是冲突
  assert.deepEqual(themeContributors().map((c) => c.owner), ['@t/second'])
  assert.deepEqual(themeContributors()[0]!.rejected, [])
})

test('★ F16：撤销函数幂等；unregisterThemes 撤销该 owner 的全部贡献', () => {
  fresh()
  const undo = registerTheme('@t/a', { light: { '--gw-blue-600': '#111111' } })
  const undo2 = registerTheme('@t/b', { dark: { '--gw-gray-25': '#000000' } })
  undo()
  undo() // 重复调用安全
  assert.equal(themeTokens().light['--gw-blue-600'], undefined)
  undo2()
  assert.equal(themeTokens().dark['--gw-gray-25'], undefined)
  assert.deepEqual(themeContributors(), [])

  // 同一 owner 的多条贡献被一次清掉
  registerTheme('@t/c', { light: { '--gw-blue-500': '#111111' } })
  registerTheme('@t/c', { light: { '--gw-blue-700': '#222222' } })
  assert.equal(themeContributors().length, 2)
  unregisterThemes('@t/c')
  assert.deepEqual(themeContributors(), [])
  assert.deepEqual(themeTokens(), { light: {}, dark: {} })
})

/* ------------------------------ 5. 形态与健壮性 ------------------------------ */

test('★ F16：owner 空 / 形态非法 / 无可用 token ⇒ 整条拒绝，不产生贡献者', () => {
  fresh()
  registerTheme('', { light: { '--gw-blue-600': '#111111' } })
  // @ts-expect-error 故意传错类型（外部插件是裸 JS，宿主必须自己兜住）
  registerTheme('@t/x', null)
  registerTheme('@t/y', {})
  registerTheme('@t/z', { light: {} })
  registerTheme('@t/w', { light: { '--color-surface': '#fff' } }) // 全被拒 ⇒ 等价于空
  assert.deepEqual(themeContributors(), [])
  assert.equal(buildThemeCss(), '')
})

test('★ F16：无 DOM 环境（node 单测）下注册不抛错', () => {
  fresh()
  assert.equal(typeof globalThis.document, 'undefined', '本仓库 node 测试没有 DOM（前提变了要重审本用例）')
  assert.doesNotThrow(() => {
    registerTheme('@t/nodom', { light: { '--gw-blue-600': '#111111' } })
    unregisterThemes('@t/nodom')
  })
})

test('★ F16：注入用的元素 id 固定为 geewiki-plugin-theme', () => {
  // 固定 id 是"幂等重建"的前提：改成随机 id 会让每次同步都新增一个 <style>，
  // 旧样式残留、且撤销后再也移除不掉。
  assert.equal(THEME_STYLE_ID, 'geewiki-plugin-theme')
})
