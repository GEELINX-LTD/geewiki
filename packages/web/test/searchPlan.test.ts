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
  scoreBadges,
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

/* ------------------------- scoreBadges ------------------------- */

/** 断言一条徽标既没有 NaN/Infinity，也不是负百分比（本批要消灭的呈现故障） */
function assertSaneLabel(label: string): void {
  assert.ok(!/NaN|Infinity/.test(label), `不得出现 NaN/Infinity：${label}`)
  assert.ok(!label.startsWith('-'), `不得出现负百分比：${label}`)
}

test('scoreBadges：真实量级的 BM25（1e-6）**不再显示成 0.00**——最高分为 100%、其余按比例', () => {
  // 取自隔离实例的实测值：三段不同相关度的真实分数
  const badges = scoreBadges([
    { score: 1.906253824501285e-6 },
    { score: 1.3604087514738635e-6 },
    { score: 1.1517302573203196e-6 },
  ])
  assert.equal(badges[0]?.label, '100%', '最高分应显示 100%')
  assert.equal(badges[0]?.top, true)
  assert.equal(badges[1]?.label, '71%', '1.3604/1.9063 ≈ 71%')
  assert.equal(badges[2]?.label, '60%', '1.1517/1.9063 ≈ 60%')
  for (const b of badges) {
    assertSaneLabel(b.label)
    assert.ok(!/^0(\.0+)?%$/.test(b.label), `非零分数不得显示为 0%：${b.label}`)
    assert.match(b.title, /相对值|相对/, '说明必须点明是相对值')
    assert.match(b.title, /仅同一次查询内可比/)
  }
})

test('scoreBadges：并列最高分都为 100%（同等相关），且已不同于旧的"全 0.00"', () => {
  const badges = scoreBadges([{ score: 1.375e-6 }, { score: 1.375e-6 }, { score: 1.375e-6 }])
  assert.deepEqual(
    badges.map((b) => b.label),
    ['100%', '100%', '100%'],
  )
  assert.ok(badges.every((b) => b.top))
})

test('scoreBadges：非最高分永不超过 99%（不出现两个 100% 造成歧义）', () => {
  // 0.999 会被 round 成 100，必须被压到 99
  const badges = scoreBadges([{ score: 1 }, { score: 0.999 }])
  assert.equal(badges[0]?.label, '100%')
  assert.equal(badges[1]?.label, '99%')
  assert.equal(badges[1]?.top, false)
})

test('scoreBadges：**like 兜底路径（全 0 分）**→ 标注"关键词匹配"，绝不显示 0%/NaN', () => {
  // 实测 2 字中文查询走 LIKE，score 恒为 0
  const badges = scoreBadges([{ score: 0 }, { score: 0 }])
  assert.deepEqual(
    badges.map((b) => b.label),
    ['关键词匹配', '关键词匹配'],
  )
  assert.ok(badges.every((b) => b.keywordOnly))
  for (const b of badges) {
    assertSaneLabel(b.label)
    assert.match(b.title, /关键词匹配/)
    assert.ok(!b.label.includes('%'), '零分路径不得显示任何百分比')
    assert.ok(!/相对值/.test(b.title), '本次没有分数，标题不得声称是"相对值"（会被读成"分很低"）')
  }
})

test('scoreBadges：本次有正分时，某条为 0 分 → 显示 0%（确实没有相关度信号）', () => {
  const badges = scoreBadges([{ score: 1e-5 }, { score: 0 }])
  assert.equal(badges[0]?.label, '100%')
  assert.equal(badges[1]?.label, '0%')
  assert.equal(badges[1]?.keywordOnly, false)
})

test('scoreBadges：极小但非零的相对值显示 <1%（不谎报为 0%）', () => {
  const badges = scoreBadges([{ score: 1 }, { score: 1e-9 }])
  assert.equal(badges[1]?.label, '<1%')
  assertSaneLabel(badges[1]?.label ?? '')
})

test('scoreBadges：边界——空数组不产生任何徽标（不除零）', () => {
  assert.deepEqual(scoreBadges([]), [])
})

test('scoreBadges：边界——单条结果为 100% 且 top', () => {
  const badges = scoreBadges([{ score: 3.2e-7 }])
  assert.equal(badges.length, 1)
  assert.equal(badges[0]?.label, '100%')
  assert.equal(badges[0]?.top, true)
})

test('scoreBadges：边界——负值/NaN/Infinity 都按"没有相关度分"处理，不污染其它行', () => {
  const badges = scoreBadges([
    { score: -5 },
    { score: Number.NaN },
    { score: Number.POSITIVE_INFINITY },
    { score: Number.NEGATIVE_INFINITY },
  ])
  // 全部非正分/非有限值 → 无法给出相对值 → 关键词匹配分支
  for (const b of badges) {
    assertSaneLabel(b.label)
    assert.ok(!b.label.includes('%'), `无有效正分时不得显示百分比：${b.label}`)
  }
  // 混合：有正分时，异常值行按 0% 处理
  const mixed = scoreBadges([{ score: 2e-6 }, { score: -1 }, { score: Number.NaN }])
  assert.equal(mixed[0]?.label, '100%')
  assert.equal(mixed[1]?.label, '0%')
  assert.equal(mixed[2]?.label, '0%')
  for (const b of mixed) assertSaneLabel(b.label)
})

test('scoreBadges：极大值不产生 Infinity（比值恒在 0~1 之间）', () => {
  const badges = scoreBadges([{ score: Number.MAX_VALUE }, { score: Number.MAX_VALUE / 2 }])
  assert.equal(badges[0]?.label, '100%')
  assert.equal(badges[1]?.label, '50%')
  for (const b of badges) assertSaneLabel(b.label)
})

test('scoreBadges：返回数组与入参**等长同序**（调用方可按 index 直接取）', () => {
  const hits = [{ score: 3e-6 }, { score: 0 }, { score: 1e-6 }, { score: 2e-6 }]
  const badges = scoreBadges(hits)
  assert.equal(badges.length, hits.length)
  assert.equal(badges[0]?.label, '100%')
  assert.equal(badges[3]?.label, '67%', '2/3 ≈ 67%')
})
