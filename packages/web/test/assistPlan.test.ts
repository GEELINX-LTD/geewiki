/**
 * AI 辅助写作的纯逻辑测试（`lib/assistPlan.ts`）。
 *
 * 这里钉住的都是"错了也不报错、只是 AI 输出莫名其妙"的判断：动作可用性、
 * 上下文截断方向、降级文案、写回落点。另有两条**源码级守卫**保证界面侧不退化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSIST_ACTION_LABEL,
  ASSIST_ACTION_ORDER,
  ASSIST_TEXT_LIMIT,
  appliedText,
  applyLabel,
  availableActions,
  beforeCursor,
  buildAssistRequest,
  canApplyToBody,
  clampContext,
  hasUsableSelection,
  unavailableText,
} from '../src/lib/assistPlan.js'

const HERE = import.meta.dirname
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8')

test('ASSIST_TEXT_LIMIT 与后端 ASSIST_TEXT_MAX 同值（两份真源必须一致）', () => {
  const backend = read('../../plugin-ai/src/assist.ts')
  const m = /ASSIST_TEXT_MAX = (\d+)/.exec(backend)
  assert.ok(m !== null, '反空洞：后端源码里应能抽到 ASSIST_TEXT_MAX')
  assert.equal(Number(m[1]), ASSIST_TEXT_LIMIT)
})

test('四个动作都有中文标签，且顺序表覆盖全部动作且不重复', () => {
  assert.deepEqual([...ASSIST_ACTION_ORDER].sort(), Object.keys(ASSIST_ACTION_LABEL).sort())
  assert.equal(new Set(ASSIST_ACTION_ORDER).size, ASSIST_ACTION_ORDER.length)
  for (const label of Object.values(ASSIST_ACTION_LABEL)) {
    assert.ok(label.length > 0 && /[\u4e00-\u9fff]/.test(label), '标签应是中文')
  }
})

test('hasUsableSelection：null 与纯空白都不算有选区', () => {
  assert.equal(hasUsableSelection(null), false)
  assert.equal(hasUsableSelection({ from: 0, to: 0, text: '' }), false)
  assert.equal(hasUsableSelection({ from: 0, to: 3, text: '   \n\t ' }), false)
  assert.equal(hasUsableSelection({ from: 0, to: 2, text: '正文' }), true)
})

test('availableActions：四象限（有选区×有正文）', () => {
  const sel = { from: 0, to: 2, text: '选中' }
  // 有正文 + 有选区：四个全可用
  assert.deepEqual(availableActions({ selection: sel, docText: '正文' }), ['continue', 'rewrite', 'polish', 'summarize'])
  // 有正文 + 无选区：改写与润色不可用
  assert.deepEqual(availableActions({ selection: null, docText: '正文' }), ['continue', 'summarize'])
  // 空正文 + 有选区（例如刚删完再选中残留）：不能续写，但能改写/润色/摘要
  assert.deepEqual(availableActions({ selection: sel, docText: '   ' }), ['rewrite', 'polish', 'summarize'])
  // 都空：一个都不给（空文档上给按钮等于骗点击）
  assert.deepEqual(availableActions({ selection: null, docText: '  \n ' }), [])
})

test('clampContext：超长时按方向截断，未超长时原样返回', () => {
  const short = 'x'.repeat(10)
  assert.equal(clampContext(short, false, 100), short)
  const long = 'a'.repeat(50) + 'b'.repeat(50)
  // 保留尾部（靠近光标的一侧）
  assert.equal(clampContext(long, false, 10), 'b'.repeat(10))
  // 保留头部（摘要这类"开头更重要"的场景）
  assert.equal(clampContext(long, true, 10), 'a'.repeat(10))
  // 边界：正好等于上限不截断
  assert.equal(clampContext('y'.repeat(10), false, 10), 'y'.repeat(10))
})

test('beforeCursor：从光标前取文本，并保留**靠近光标**的一段', () => {
  // 未超上限时原样返回（不截断）
  assert.equal(beforeCursor('短文本', 3), '短文本')
  // 超过 ASSIST_TEXT_LIMIT 时只保留**靠近光标**的一段：构造 A…AB…B，光标在 B 段末尾
  const doc = 'A'.repeat(ASSIST_TEXT_LIMIT) + 'B'.repeat(100)
  const got = beforeCursor(doc, doc.length)
  assert.equal(got.length, ASSIST_TEXT_LIMIT)
  // 期望 = 丢掉开头那 100 个 A（远端被裁掉），保留 3900 个 A + 靠近光标的 100 个 B
  assert.equal(got, 'A'.repeat(ASSIST_TEXT_LIMIT - 100) + 'B'.repeat(100), '只会裁掉远端，靠近光标的一段必须保留')
  // 靠近光标那一侧（B 段）必须完整保留；被丢掉的只能是远端的 A
  assert.ok(got.endsWith('B'.repeat(100)), '尾部必须完整保留')
  // 远端被丢弃：结果里最多只剩「上限 − B 段」那么长的 A
  assert.equal(got.includes('A'.repeat(ASSIST_TEXT_LIMIT - 100 + 1)), false)
  // 光标越界不抛错（防御：选区位置与服务端不同步时不该崩）
  assert.equal(beforeCursor('短文本', 999), '短文本')
  assert.equal(beforeCursor('短文本', -5), '')
})

test('buildAssistRequest：只发该动作需要的字段', () => {
  const sel = { from: 10, to: 12, text: '选中内容' }
  const base = { selection: sel, docText: '前面的正文' + '选中内容', title: '标题', slug: 'a/b' }

  const cont = buildAssistRequest({ ...base, action: 'continue' })
  assert.equal(cont.action, 'continue')
  assert.equal(cont.selection, undefined, '续写不应把选中文本当输入')
  assert.ok(typeof cont.before === 'string' && cont.before.length > 0)
  assert.equal(cont.title, '标题')
  assert.equal(cont.slug, 'a/b')

  const rew = buildAssistRequest({ ...base, action: 'rewrite' })
  assert.equal(rew.selection, '选中内容')
  assert.equal(rew.before, undefined, '改写不应把光标前文本一起发')
  assert.equal(rew.title, '标题')

  // 摘要优先用选区；无选区时用全文开头
  const sumSel = buildAssistRequest({ ...base, action: 'summarize' })
  assert.equal(sumSel.selection, '选中内容')
  const sumNoSel = buildAssistRequest({ ...base, action: 'summarize', selection: null })
  assert.equal(sumNoSel.selection, undefined)
  assert.ok(typeof sumNoSel.before === 'string' && sumNoSel.before.startsWith('前面的正文'))

  // 空 title/slug 不得出现在请求体里（避免服务端收到空串还要判空）
  const bare = buildAssistRequest({ action: 'continue', selection: null, docText: 'x', title: '', slug: '' })
  assert.equal('title' in bare, false)
  assert.equal('slug' in bare, false)
})

test('unavailableText：插件未启用 / 缺凭据 / 无路由 / 可用 四态互不相同', () => {
  const noPlugin = unavailableText({ pluginActive: false, modelAvailable: false, degraded: null })
  const noKey = unavailableText({ pluginActive: true, modelAvailable: false, degraded: null })
  const noRoute = unavailableText({
    pluginActive: true,
    modelAvailable: false,
    degraded: { reason: 'no_provider', code: 'NO_ADAPTER', message: 'm' },
  })
  const missing = unavailableText({
    pluginActive: true,
    modelAvailable: false,
    degraded: { reason: 'missing_credential', code: 'MISSING_CREDENTIAL', message: 'm' },
  })
  const okText = unavailableText({ pluginActive: true, modelAvailable: true, degraded: null })
  const all = [noPlugin, noKey, noRoute, missing]
  assert.equal(new Set(all).size, all.length, '四条不可用文案必须互不相同，否则用户分不清原因')
  for (const t of all) {
    assert.match(t, /[\u4e00-\u9fff]/, '文案应为中文')
    assert.ok(t.length > 8, '文案应说清"缺什么"')
  }
  assert.equal(okText, '', '可用时不得有提示文案')
  // 关键立场：不可用时绝不能暗示"已降级为摘要"——写作没有降级产物
  for (const t of all) assert.doesNotMatch(t, /摘要/, '写作不可用时不得提"抽取式摘要"（那是问答的降级）')
})

test('applyLabel / appliedText / canApplyToBody：摘要不写回正文', () => {
  assert.equal(applyLabel('continue'), '插入到光标处')
  for (const a of ['rewrite', 'polish', 'summarize'] as const) assert.equal(applyLabel(a), '替换选中内容')
  assert.equal(canApplyToBody('summarize'), false)
  assert.equal(canApplyToBody('continue'), true)
  assert.equal(canApplyToBody('rewrite'), true)
  assert.match(appliedText('summarize'), /不会写入正文/)
  assert.match(appliedText('continue'), /⌘Z/)
  assert.match(appliedText('polish'), /⌘Z/)
})

/* ------------------------- 源码级守卫 ------------------------- */

test('守卫：编辑器不做写回以外的网络请求，且插入走可撤销事务', () => {
  const editor = read('../src/components/MarkdownEditor.tsx')
  assert.ok(editor.length > 10000, '反空洞：源码读取失败时必须变红')
  // 编辑器自己绝不发请求（与 onSave 同一约定：它只把结果写回正文）
  assert.doesNotMatch(editor, /fetch\(/)
  // 插入必须带 userEvent: 'input'（否则 ⌘Z 撤不掉 AI 产物）
  assert.match(editor, /insertIntoView/)
  const fn = editor.slice(editor.indexOf('function insertIntoView'), editor.indexOf('function insertIntoView') + 700)
  assert.match(fn, /userEvent: 'input'/, '插入事务必须可撤销')
  // 选区上报是**可选**能力：不提供时不得影响既有上传
  assert.match(editor, /onSelectionChange\?/)
  assert.match(editor, /handleRef\?/)
})

test('守卫：AI 工具条有隐藏式禁用原因之外的**可见**原因，且不自己编造文本', () => {
  const bar = read('../src/components/ai/AssistToolbar.tsx')
  assert.ok(bar.length > 3000, '反空洞')
  // 禁用原因必须可见（role=status），不能只挂 title
  assert.match(bar, /role="status"/)
  assert.match(bar, /modelHint/)
  // 不得用任何"占位回答"冒充模型产物
  assert.doesNotMatch(bar, /抽取式摘要/)
  // 不得自己发保存请求：落库仍走用户的保存
  assert.doesNotMatch(bar, /savePage|api\.savePage|PUT/)
})

test('守卫：编辑页把工具条挂在宿主面板里，且不依赖编辑器插槽', () => {
  const page = read('../src/pages/WikiPage.tsx')
  assert.ok(page.length > 50000, '反空洞')
  assert.match(page, /<AssistToolbar/)
  // 工具条必须在编辑分支里、与 uploadNotice 同区域（编辑区下方）
  const idx = page.indexOf('<AssistToolbar')
  const around = page.slice(idx - 200, idx + 1200)
  assert.match(around, /uploadNotice/, '工具条应与既有提示区同区域，便于统一反馈')
  // 不得把 AI 能力接到编辑器插槽上（插槽契约没有选区/插入通道）
  assert.doesNotMatch(page, /onSelectionChange=\{[^}]*Slot/)
})
