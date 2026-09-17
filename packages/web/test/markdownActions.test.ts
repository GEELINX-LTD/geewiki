/**
 * `lib/markdownActions.ts` —— 工具栏动作的**纯实现**：`(正文, 选区) → (新正文, 新选区)`。
 * ============================================================================
 *
 * 为什么这些边界情形值得逐个钉住：同一套动作有**两条**落地路径 —— CodeMirror 编辑器与
 * 懒加载 chunk 取不到时的 `<textarea>` 兜底。逻辑写错一次，两条路径一起错；而且
 * "点一下按钮把我的字弄乱了"是那种**看起来像编辑器坏了**、实际只是判据写错的失败。
 * 故这里把模块注释里承诺的每条边界都变成断言：
 *
 *   - `toggleWrap`：空选区、包住选区、选区自带标记、标记紧贴选区外侧 —— 各标记都要能来回；
 *   - 行前缀：`h1` 套在 `h2` 上必须是**替换**（不能因为 `startsWith('#')` 近似而变成取消）、
 *     任务列表**不是**普通列表、`ordered` 重新编号 / 再按取消、多行选区逐行处理；
 *   - 独立块（表格 / 分隔线 / 代码块）：与段落之间必须留空行，否则表格根本不会被解析成表格；
 *   - `minimalEdit`：整篇替换要收缩成一处最小改动（撤销栈、重解析、光标跳动都靠它）；
 *   - `detectActiveFormats`：按钮的 `aria-pressed` 要与动作的 toggle 判据**同一套口径**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyFormatAction,
  detectActiveFormats,
  minimalEdit,
  type EditTarget,
  type FormatAction,
} from '../src/lib/markdownActions'

/** 选区/光标：`at(text, from)` 即光标态，`at(text, from, to)` 即选区 */
const at = (text: string, from: number, to: number = from): EditTarget => ({ text, from, to })

/** 行内包裹类动作与它们的标记（四个各认各的写法） */
const WRAPS: ReadonlyArray<{ action: FormatAction; mark: string }> = [
  { action: 'bold', mark: '**' },
  { action: 'italic', mark: '*' },
  { action: 'strike', mark: '~~' },
  { action: 'code', mark: '`' },
]

/* ========================= 一、行内包裹 ========================= */

test('toggleWrap：空选区插入一对标记，光标落在两标记**中间**（直接打字即为该样式）', () => {
  for (const { action, mark } of WRAPS) {
    const r = applyFormatAction(at('', 0), action)
    assert.equal(r.text, mark + mark, `${action}：应插入一对标记`)
    assert.equal(r.from, mark.length, `${action}：光标应在两个标记之间`)
    assert.equal(r.to, mark.length)
  }
})

test('toggleWrap：选中一段 ⇒ 包住它，且选区仍框住原来那几个字（继续打字不会跑到标记里）', () => {
  assert.deepEqual(applyFormatAction(at('abc', 0, 3), 'bold'), { text: '**abc**', from: 2, to: 5 })
  for (const { action, mark } of WRAPS) {
    const wrapped = applyFormatAction(at('甲', 0, 1), action)
    assert.equal(wrapped.text, mark + '甲' + mark, `${action}：应包住选区`)
    assert.equal(wrapped.from, mark.length)
    assert.equal(wrapped.to, mark.length + 1)
    const off = applyFormatAction(at(wrapped.text, wrapped.from, wrapped.to), action)
    assert.equal(off.text, '甲', `${action}：再按一次应回到原样`)
    assert.deepEqual(off, { text: '甲', from: 0, to: 1 })
  }
})

test('toggleWrap：选中的文本**自带**标记 ⇒ 去掉（`**x**` 全选再按加粗）', () => {
  assert.deepEqual(applyFormatAction(at('**abc**', 0, 7), 'bold'), { text: 'abc', from: 0, to: 3 })
  assert.deepEqual(applyFormatAction(at('~~甲~~', 0, 5), 'strike'), { text: '甲', from: 0, to: 1 })
  assert.deepEqual(applyFormatAction(at('`甲`', 0, 3), 'code'), { text: '甲', from: 0, to: 1 })
})

test('toggleWrap：标记紧贴选区**外侧** ⇒ 去掉（用户只选了里面的字，也算"已经在加粗里"）', () => {
  assert.deepEqual(applyFormatAction(at('**abc**', 2, 5), 'bold'), { text: 'abc', from: 0, to: 3 })
  assert.deepEqual(applyFormatAction(at('*甲*', 1, 2), 'italic'), { text: '甲', from: 0, to: 1 })
  assert.deepEqual(applyFormatAction(at('~~甲~~', 2, 3), 'strike'), { text: '甲', from: 0, to: 1 })
  assert.deepEqual(applyFormatAction(at('`甲`', 1, 2), 'code'), { text: '甲', from: 0, to: 1 })
})

test('toggleWrap：光标夹在已有的一对标记中间时再按一次**取消**（不能变成八个星号）', () => {
  for (const { action, mark } of WRAPS) {
    const between = at(mark + mark, mark.length)
    assert.ok(
      detectActiveFormats(between).has(action),
      `${action}：这个位置按钮应显示"已处于该样式"，否则用户根本没有"再按一次"的语义可依赖`,
    )
    assert.deepEqual(
      applyFormatAction(between, action),
      { text: '', from: 0, to: 0 },
      `${action}：按钮显示已加粗、点下去却插一对新标记 —— 在用户眼里就是"按钮把我的字弄乱了"`,
    )
  }
  // 上一行留下的那对标记（空选区 ⇒ 一对空标记）必须能原路退回
  const once = applyFormatAction(at('甲', 1), 'bold')
  assert.equal(once.text, '甲****')
  assert.deepEqual(applyFormatAction(at(once.text, once.from), 'bold'), { text: '甲', from: 1, to: 1 })
})

/* ============================ 二、链接 ============================ */

test('link：空选区给出 `[链接文字](https://)`，并选中占位 URL（直接打字即可替换）', () => {
  const r = applyFormatAction(at('', 0), 'link')
  assert.equal(r.text, '[链接文字](https://)')
  assert.equal(r.text.slice(r.from, r.to), 'https://', '光标应选中占位 URL')
})

test('link：选中文本 ⇒ `[选中文本](https://)`，选中部分就是 URL 的落点', () => {
  const r = applyFormatAction(at('甲文', 0, 2), 'link')
  assert.equal(r.text, '[甲文](https://)')
  assert.equal(r.text.slice(r.from, r.to), 'https://')
})

test('link：选中的本身就是 URL ⇒ `[链接文字](url)`（不用再让用户抄一遍网址）', () => {
  const text = '看 https://x.dev 这里'
  const url = 'https://x.dev'
  const from = text.indexOf(url)
  const r = applyFormatAction(at(text, from, from + url.length), 'link')
  assert.equal(r.text, '看 [链接文字](https://x.dev) 这里')
  assert.equal(r.text.slice(r.from, r.to), url, '选区应落在 URL 上，便于直接改地址')
})

/* ========================= 三、行前缀动作 ========================= */

test('行前缀：h1/h2/h3 各认各的写法，**h1 套在 h2 上是替换而不是取消**', () => {
  assert.equal(applyFormatAction(at('标题', 0), 'h1').text, '# 标题')
  assert.equal(applyFormatAction(at('标题', 0), 'h2').text, '## 标题')
  assert.equal(applyFormatAction(at('标题', 0), 'h3').text, '### 标题')
  assert.equal(
    applyFormatAction(at('## 标题', 0), 'h1').text,
    '# 标题',
    '若用 startsWith("#") 近似判据，这里会被误判成"已经是 h1"而把标题变成正文',
  )
  assert.equal(applyFormatAction(at('# 标题', 0), 'h2').text, '## 标题')
  assert.equal(applyFormatAction(at('### 标题', 0), 'h2').text, '## 标题')
  // 只有"已经就是这一档"才取消
  assert.equal(applyFormatAction(at('# 标题', 0), 'h1').text, '标题')
  assert.equal(applyFormatAction(at('## 标题', 0), 'h2').text, '标题')
  assert.equal(applyFormatAction(at('### 标题', 0), 'h3').text, '标题')
})

test('行前缀：任务列表**不是**普通列表（点「列表」应把它变成普通列表，而不是当成"已经是列表"取消）', () => {
  assert.equal(
    applyFormatAction(at('- [ ] 待办', 0), 'bullet').text,
    '- 待办',
    '若用 startsWith("-") 近似判据，点一下列表反而会把复选框吃掉',
  )
  assert.equal(applyFormatAction(at('- [x] 已办', 0), 'bullet').text, '- 已办')
  assert.equal(applyFormatAction(at('- 普通项', 0), 'bullet').text, '普通项', '普通列表上再按一次才是取消')
  assert.equal(applyFormatAction(at('- [ ] 待办', 0), 'task').text, '待办', '任务列表上再按一次取消')
  assert.equal(applyFormatAction(at('- 普通项', 0), 'task').text, '- [ ] 普通项')
})

test('行前缀：引用行 toggle（`>` 与 `> ` 都认，再按一次去掉）', () => {
  assert.equal(applyFormatAction(at('甲', 0), 'quote').text, '> 甲')
  assert.equal(applyFormatAction(at('> 甲', 0), 'quote').text, '甲')
  assert.equal(applyFormatAction(at('>甲', 0), 'quote').text, '甲', '`>甲` 也算引用（正则里的 \\s? 是可选的）')
})

test('行前缀：有序列表重新编号 1..n，全都有序号时再按一次取消', () => {
  assert.equal(
    applyFormatAction(at('1. 甲\n普通乙', 0, 8), 'ordered').text,
    '1. 甲\n2. 普通乙',
    '只要有一行还没序号，就整段转换并重新编号（复制粘贴来的段落常带着重复的 "1."）',
  )
  assert.equal(applyFormatAction(at('甲\n乙', 0, 3), 'ordered').text, '1. 甲\n2. 乙')
  assert.equal(applyFormatAction(at('1. 甲\n2. 乙', 0, 9), 'ordered').text, '甲\n乙')
})

test('行前缀：多行选区**每一行**都处理；只有一部分行是 h1 时按"还没套上"处理', () => {
  assert.equal(applyFormatAction(at('甲\n乙', 0, 3), 'h1').text, '# 甲\n# 乙')
  assert.equal(applyFormatAction(at('甲\n乙\n丙', 0, 5), 'bullet').text, '- 甲\n- 乙\n- 丙')
  assert.equal(
    applyFormatAction(at('# 甲\n乙', 0, 5), 'h1').text,
    '# 甲\n# 乙',
    '只有**所有**行都已经是该结构才算"已处于"（与 detectActiveFormats 的 every 语义一致）',
  )
})

test('行前缀：行范围含首尾整行，但不牵连没碰到的行', () => {
  assert.equal(applyFormatAction(at('甲\n乙', 2, 3), 'h1').text, '甲\n# 乙', '选区只碰到第二行 ⇒ 只改第二行')
  assert.equal(applyFormatAction(at('甲\n乙', 0, 1), 'h1').text, '# 甲\n乙', '只碰到第一行 ⇒ 只改第一行')
  assert.equal(
    applyFormatAction(at('甲\n乙丙', 1, 3), 'bullet').text,
    '- 甲\n- 乙丙',
    '选区从行尾拉到下一行中间 ⇒ 首尾两整行都算选中（否则"拖到行尾"会漏掉一行）',
  )
})

test('行前缀：旧结构先剥掉再加新的（叠加写法不留下残渣）', () => {
  assert.equal(applyFormatAction(at('> - [ ] 甲', 0), 'bullet').text, '- 甲', '先清干净再套新结构')
  assert.equal(applyFormatAction(at('## 甲', 0), 'quote').text, '> 甲')
  assert.equal(applyFormatAction(at('  ## 甲', 0), 'quote').text, '  > 甲', '缩进保留（缩进属于作者排版）')
  assert.equal(
    applyFormatAction(at('  甲\n乙', 0, 5), 'bullet').text,
    '  - 甲\n- 乙',
    '每行各自保留缩进',
  )
})

/* ==================== 四、独立块：代码块/表格/分隔线 ==================== */

test('codeblock：空选区把光标放到围栏里那一空行；非空选区把整段围起来', () => {
  const empty = applyFormatAction(at('', 0), 'codeblock')
  assert.equal(empty.text, '```\n\n```')
  assert.equal(empty.from, 4)
  assert.equal(empty.to, 4)
  assert.deepEqual(empty.text.slice(0, empty.from).split('\n'), ['```', ''], '光标应在开围栏之后的那一行')

  const wrapped = applyFormatAction(at('abc', 0, 3), 'codeblock')
  assert.equal(wrapped.text, '```\nabc\n```')
  assert.equal(wrapped.text.slice(wrapped.from, wrapped.to), '```\nabc\n```', '选区应覆盖整个代码块')
})

test('独立块与段落之间必须留空行（紧贴段落的表格根本不会被解析成表格）', () => {
  assert.equal(applyFormatAction(at('甲\n\n乙', 1), 'hr').text, '甲\n\n---\n\n乙', '两侧各补一个空行')
  assert.equal(
    applyFormatAction(at('甲\n\n乙', 3), 'hr').text,
    '甲\n\n---\n\n乙',
    '前面已经是空行 ⇒ 不得再补一行（否则每点一次就多一行空行）',
  )
  assert.equal(applyFormatAction(at('甲', 0), 'table').text, [
    '| 列一 | 列二 | 列三 |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '',
    '甲',
  ].join('\n'))
  assert.equal(applyFormatAction(at('甲\n\n乙', 1), 'codeblock').text, '甲\n\n```\n\n```\n\n乙')
})

test('table / hr：光标落在新块之后（接着敲字不会跑进表格里）', () => {
  const table = applyFormatAction(at('甲', 0), 'table')
  assert.equal(table.from, table.to, '这两个动作不产生选区')
  assert.equal(table.text.slice(table.from), '\n\n甲', '光标就在表格块之后')
  const hr = applyFormatAction(at('甲', 0), 'hr')
  assert.equal(hr.text, '---\n\n甲')
  assert.equal(hr.from, 3)
})

/* ========================= 五、minimalEdit ========================= */

test('minimalEdit：文本没变 ⇒ null（调用方据此"什么都不做"，不发空事务）', () => {
  assert.equal(minimalEdit('abc', 'abc'), null)
  assert.equal(minimalEdit('', ''), null)
})

test('minimalEdit：只改一个字符 ⇒ 改动范围就只有那一个字符', () => {
  assert.deepEqual(minimalEdit('abc', 'axc'), { from: 1, to: 2, insert: 'x' })
  assert.deepEqual(minimalEdit('**abc**', '**abX**'), { from: 4, to: 5, insert: 'X' }, '标记里的一个字被换掉')
  assert.deepEqual(minimalEdit('a\nb\nc', 'a\nB\nc'), { from: 2, to: 3, insert: 'B' })
  assert.deepEqual(minimalEdit('**abc**', '**axbc**'), { from: 3, to: 3, insert: 'x' }, '插入 ⇒ 空区间')
})

test('minimalEdit：末尾插入 / 删除各只动该动的地方', () => {
  assert.deepEqual(minimalEdit('abc', 'abcd'), { from: 3, to: 3, insert: 'd' })
  assert.deepEqual(minimalEdit('abc', 'ac'), { from: 1, to: 2, insert: '' })
  assert.deepEqual(minimalEdit('abc', ''), { from: 0, to: 3, insert: '' })
  assert.deepEqual(minimalEdit('', '甲'), { from: 0, to: 0, insert: '甲' })
})

test('minimalEdit：把改动贴回原文必然得到新文本（from/to/insert 自洽）', () => {
  const cases: Array<[string, string]> = [
    ['abc', 'axc'],
    ['abc', 'abcd'],
    ['abc', 'ac'],
    ['', '甲'],
    ['甲', ''],
    ['**ab**', '**aXb**'],
    ['a\nb\nc', 'a\nB\nc'],
    ['甲\n乙', '甲\n- 乙'],
    ['ab', 'ba'],
    ['aaa', 'aa'],
  ]
  for (const [before, after] of cases) {
    const edit = minimalEdit(before, after)
    assert.ok(edit !== null, `${JSON.stringify(before)} → ${JSON.stringify(after)} 应有改动`)
    assert.ok(edit.from <= edit.to, 'from 不得跑到 to 后面')
    assert.equal(before.slice(0, edit.from) + edit.insert + before.slice(edit.to), after)
  }
})

/* ===================== 六、detectActiveFormats ===================== */

test('detectActiveFormats：标题按层级各报各的（h1 与 h2 不能混）', () => {
  assert.deepEqual([...detectActiveFormats(at('# 甲', 0))], ['h1'])
  assert.deepEqual([...detectActiveFormats(at('## 甲', 0))], ['h2'])
  assert.deepEqual([...detectActiveFormats(at('### 甲', 0))], ['h3'])
  assert.deepEqual([...detectActiveFormats(at('#### 甲', 0))], [], 'h4 不在动作取值域里')
})

test('detectActiveFormats：**加粗不能同时报斜体**（`**x**` 也满足 `*x*` 的两侧判据）', () => {
  assert.deepEqual([...detectActiveFormats(at('**粗**', 0, 5))], ['bold'])
  assert.deepEqual([...detectActiveFormats(at('*斜*', 0, 3))], ['italic'])
  assert.deepEqual([...detectActiveFormats(at('~~删~~', 0, 5))], ['strike'])
  assert.deepEqual([...detectActiveFormats(at('`码`', 0, 3))], ['code'])
})

test('detectActiveFormats：列表与任务列表互斥，有序列表各报各的', () => {
  assert.deepEqual([...detectActiveFormats(at('- [ ] 待办', 0))], ['task'])
  assert.deepEqual([...detectActiveFormats(at('- 普通项', 0))], ['bullet'])
  assert.deepEqual([...detectActiveFormats(at('1. 项', 0))], ['ordered'])
  assert.deepEqual([...detectActiveFormats(at('> 引', 0))], ['quote'])
})

test('detectActiveFormats：光标夹在标记中间也算"已处于"（与 toggleWrap 的取消判据同一套口径）', () => {
  for (const { action, mark } of WRAPS) {
    assert.ok(detectActiveFormats(at(mark + mark, mark.length)).has(action), `${action}：按钮应亮着`)
  }
})

test('detectActiveFormats：只满足一部分行时按"未处于"呈现（与动作的 every 语义一致）', () => {
  assert.deepEqual([...detectActiveFormats(at('# 甲\n乙', 0, 5))], [], '一半是标题 ⇒ 按钮不亮，点一下会全都套上')
  assert.deepEqual([...detectActiveFormats(at('# 甲\n# 乙', 0, 7))], ['h1'])
})

test('detectActiveFormats：普通文本 / 空文档 ⇒ 空集合（按钮不亮）', () => {
  assert.deepEqual([...detectActiveFormats(at('普通文本', 0))], [])
  assert.deepEqual([...detectActiveFormats(at('普通文本', 0, 4))], [])
  assert.deepEqual([...detectActiveFormats(at('', 0))], [])
})

/* ========================= 七、源码级守卫 ========================= */

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'markdownActions.ts'), 'utf8')

/** 去掉 `/* … *\/` 与 `// …`：注释里的示例代码不是生效代码（本仓库踩过这个坑） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('守卫：纯实现不得依赖 CodeMirror / DOM（降级路径的 <textarea> 也要能用同一份逻辑）', () => {
  const code = codeOnly(SOURCE)
  assert.ok(SOURCE.includes('CodeMirror'), '反空洞：注释里确实提到 CodeMirror，说明这条断言在测"剥注释"')
  for (const banned of ['@codemirror/', 'CodeMirror', 'document.', 'window.', 'localStorage']) {
    assert.ok(!code.includes(banned), `去掉注释后的实现里不得出现 ${banned}（否则 <textarea> 兜底路径用不了）`)
  }
  assert.match(code, /export function applyFormatAction/, '实现应还在这个模块里（别把它搬去 CM 侧）')
})
