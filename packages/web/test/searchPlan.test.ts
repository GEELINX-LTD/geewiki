/**
 * 检索/问答纯逻辑单测（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/web test
 *
 * 本文件重点钉住两件最容易做错的事：
 * 1. **`snippet` 不得被二次转义**——服务端已把正文转义并注入 `<mark>`，前端再转义一遍
 *    会让用户看到字面的 `&lt;mark&gt;`（高亮失效）；
 * 2. **白名单消毒**——除 `<mark>` 之外的标签必须被转义，不能让服务端之外的 HTML 进入页面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_QUERY_LENGTH,
  answerRenderer,
  checkQuery,
  degradedNotice,
  hasHighlight,
  snippetToHtml,
} from '../src/lib/searchPlan'

/* ------------------------- snippetToHtml ------------------------- */

test('snippetToHtml：保留 <mark> 高亮标签', () => {
  const out = snippetToHtml('命中片段：<mark>检索增强</mark> 的实现')
  assert.equal(out, '命中片段：<mark>检索增强</mark> 的实现')
  assert.ok(hasHighlight(out))
})

test('snippetToHtml：**不做二次转义**——已有实体必须原样保留（否则显示成字面 &lt;）', () => {
  // 服务端对正文里的 `<b>` 会转义成 `&lt;b&gt;`，前端若再转义一遍就会变成 `&amp;lt;b&amp;gt;`
  const serverSnippet = '前文 &lt;b&gt;加粗&lt;/b&gt; 后文 <mark>命中</mark>'
  const out = snippetToHtml(serverSnippet)
  assert.equal(out, serverSnippet, '已有实体不得被再次转义')
  assert.ok(!out.includes('&amp;lt;'), '不得出现双重转义产物 &amp;lt;')
  assert.ok(!out.includes('&amp;gt;'), '不得出现双重转义产物 &amp;gt;')
})

test('snippetToHtml：保留常见实体（&amp; &quot; &#39;）', () => {
  const serverSnippet = 'A &amp; B &quot;引号&quot; &#39;单引号&#39; <mark>命中</mark>'
  assert.equal(snippetToHtml(serverSnippet), serverSnippet)
})

test('snippetToHtml：除 <mark> 外的标签一律转义（白名单消毒）', () => {
  const out = snippetToHtml('<script>alert(1)</script> <mark>safe</mark>')
  assert.ok(!out.includes('<script>'), '不得保留 script 标签')
  assert.ok(out.includes('&lt;script&gt;'), 'script 标签应被转义')
  assert.ok(out.includes('<mark>safe</mark>'), 'mark 应保留')
})

test('snippetToHtml：带属性的 mark 不算白名单（防事件属性注入）', () => {
  const out = snippetToHtml('<mark onclick="alert(1)">x</mark>')
  assert.ok(!out.includes('<mark onclick'), '带属性的 mark 必须被转义')
  assert.ok(out.includes('&lt;mark onclick'), '应转义为文本')
})

test('snippetToHtml：裸尖括号被转义，不产生可解析标签', () => {
  const out = snippetToHtml('a < b > c <mark>hit</mark>')
  assert.equal(out, 'a &lt; b &gt; c <mark>hit</mark>')
})

test('snippetToHtml：大小写不敏感地识别 mark，并归一化为小写', () => {
  assert.equal(snippetToHtml('<MARK>x</MARK>'), '<mark>x</mark>')
})

test('snippetToHtml：空串与无高亮片段', () => {
  assert.equal(snippetToHtml(''), '')
  assert.equal(snippetToHtml('无高亮'), '无高亮')
  assert.equal(hasHighlight('无高亮'), false)
})

/* --------------------------- checkQuery --------------------------- */

test('checkQuery：空串与纯空白被拦下', () => {
  assert.equal(checkQuery('').ok, false)
  assert.equal(checkQuery('   ').ok, false)
  assert.equal(checkQuery('\t\n').ok, false)
})

test('checkQuery：正常查询 trim 后通过', () => {
  const r = checkQuery('  检索增强  ')
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value, '检索增强')
})

test('checkQuery：超过上限（500）被拦下，边界值通过', () => {
  const ok = checkQuery('a'.repeat(MAX_QUERY_LENGTH))
  assert.equal(ok.ok, true, '正好 500 字符应通过')
  const tooLong = checkQuery('a'.repeat(MAX_QUERY_LENGTH + 1))
  assert.equal(tooLong.ok, false)
  if (!tooLong.ok) assert.match(tooLong.message, /上限 500/)
})

test('checkQuery：2 字中文查询合法（会走 like 路径，前端不拦）', () => {
  const r = checkQuery('检索')
  assert.equal(r.ok, true)
})

/* ------------------------- degradedNotice ------------------------- */

test('degradedNotice：null/undefined → 无提示条', () => {
  assert.equal(degradedNotice(null), null)
  assert.equal(degradedNotice(undefined), null)
})

test('degradedNotice：无密钥类原因是 **info** 级（信息性，不是错误）', () => {
  const a = degradedNotice({ reason: 'no_provider', code: null, message: '' })
  assert.ok(a)
  assert.equal(a.level, 'info')
  assert.match(a.title, /未配置模型密钥/)
  const b = degradedNotice({ reason: 'missing_credential', code: 'MISSING_CREDENTIAL', message: '' })
  assert.ok(b)
  assert.equal(b.level, 'info')
})

test('degradedNotice：search_unavailable 有专门文案', () => {
  const n = degradedNotice({ reason: 'search_unavailable', code: null, message: '' })
  assert.ok(n)
  assert.match(n.title, /检索服务不可用/)
})

test('degradedNotice：按 reason 分支，且采用后端 message 作为 detail', () => {
  const n = degradedNotice({ reason: 'rate_limit', code: 'RATE_LIMIT', message: '上游限流，请稍后重试' })
  assert.ok(n)
  assert.equal(n.detail, '上游限流，请稍后重试')
  assert.equal(n.level, 'warn')
})

test('degradedNotice：未知 reason 回退到通用文案且不抛错', () => {
  const n = degradedNotice({ reason: 'brand_new_reason' as never, code: null, message: '新原因' })
  assert.ok(n)
  assert.equal(n.detail, '新原因')
  assert.match(n.title, /已降级/)
})

test('degradedNotice：message 为空时用内置 detail 兜底（不出现空白提示条）', () => {
  const n = degradedNotice({ reason: 'timeout', code: 'TIMEOUT', message: '' })
  assert.ok(n)
  assert.notEqual(n.detail, '')
})

/* ------------------------- answerRenderer ------------------------- */

test('answerRenderer：markdown 走 markdown 渲染，其余按纯文本', () => {
  assert.equal(answerRenderer('markdown'), 'markdown')
  assert.equal(answerRenderer('plain'), 'plain')
  assert.equal(answerRenderer(undefined), 'plain')
})
