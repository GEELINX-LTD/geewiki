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
  checkQuery,
  detectQueryMode,
  hasHighlight,
  queryModeNote,
  queryModeOption,
  scoreBadges,
  snippetToHtml,
  suggestTermsOnEmpty,
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

/* ------------------------- detectQueryMode（查询语义） ------------------------- */

/*
  这一组钉住的是**本批要修的那个症状**：自然语言问句在缺省的 `phrase` 语义下恒为 0 命中。
  断言分两类——该判 terms 的（问句、长串、多词）与**必须留在 phrase** 的（短关键词）。
  后者同样重要：把「插件热插拔」也判成 terms 会让精确检索的既有语义静默变宽。
*/

test('detectQueryMode：短关键词留在 phrase（精确语义不因本批变宽）', () => {
  for (const q of ['插件热插拔', 'OIDC', 'search', '附件上传']) {
    assert.equal(detectQueryMode(q), 'phrase', `短关键词应保持精确匹配：${q}`)
  }
})

test('detectQueryMode：**含"请求式动词"但实为精确关键词**的短串不得被判成问句', () => {
  // 反例防线：这几个词本身是常见正文用词，把它们当问句信号会让用户的精确检索静默变宽。
  // 判据因此收紧为"动词 + 一下"（见 REQUEST_PHRASES）。
  for (const q of ['说明书模板', '插件平台介绍', '总结报告', '解释器配置']) {
    assert.equal(detectQueryMode(q), 'phrase', `不得误判为问句：${q}`)
  }
  // 但真正的请求式问句仍要判 terms
  assert.equal(detectQueryMode('介绍一下插件平台'), 'terms')
  assert.equal(detectQueryMode('说明一下权限模型'), 'terms')
})

test('detectQueryMode：问句/长查询/含空白一律判 terms', () => {
  // 问句信号
  assert.equal(detectQueryMode('怎么配置 OIDC'), 'terms')
  assert.equal(detectQueryMode('如何实现段落级权限'), 'terms')
  assert.equal(detectQueryMode('检索增强是什么'), 'terms')
  assert.equal(detectQueryMode('为什么搜不到'), 'terms')
  assert.equal(detectQueryMode('什么是插件热插拔'), 'terms')
  assert.equal(detectQueryMode('介绍一下插件平台'), 'terms')
  // 标点信号（含全角）
  assert.equal(detectQueryMode('插件热插拔？'), 'terms')
  assert.equal(detectQueryMode('检索增强!'), 'terms')
  // 含空白（多词）——即使每个词都很短
  assert.equal(detectQueryMode('OIDC 配置'), 'terms')
  assert.equal(detectQueryMode('附件 上传 权限'), 'terms')
  // 纯长度信号：无问号、无引导词、无空白，但已经是一句话
  assert.equal(detectQueryMode('段落级阅读权限的实现方式'), 'terms')
})

test('detectQueryMode：空串返回缺省 phrase（调用方本应先过 checkQuery）', () => {
  assert.equal(detectQueryMode(''), 'phrase')
  assert.equal(detectQueryMode('   '), 'phrase')
})

test('detectQueryMode：长度按**码点**计，BMP 外汉字不被算成两个字符', () => {
  // 「𠀀」是 CJK 扩展 B 的代理对：`.length` 为 2，[...q].length 为 1。
  // 若误用 .length，9 个这种字会被当成 18 字符而误判 terms。
  assert.equal(detectQueryMode('𠀀'.repeat(9)), 'phrase', '9 个码点仍是短查询')
  assert.equal(detectQueryMode('𠀀'.repeat(10)), 'terms', '10 个码点达到长查询阈值')
})

test('suggestTermsOnEmpty：只在「精确匹配 + 0 命中」时引导换分词', () => {
  assert.equal(suggestTermsOnEmpty('phrase', 0), true, '这正是本批要修的症状')
  // 反向不成立：terms 已是最宽的一侧，0 命中时换 phrase 只会更少 —— 不能给按钮
  assert.equal(suggestTermsOnEmpty('terms', 0), false)
  // 有结果时不打扰
  assert.equal(suggestTermsOnEmpty('phrase', 3), false)
  assert.equal(suggestTermsOnEmpty('terms', 3), false)
})

test('queryModeNote / queryModeOption：文案齐备且两个语义措辞不同', () => {
  assert.notEqual(queryModeNote('phrase'), queryModeNote('terms'))
  for (const id of ['phrase', 'terms'] as const) {
    const o = queryModeOption(id)
    assert.equal(o.id, id)
    assert.ok(o.label.length > 0)
    assert.ok(o.hint.length > 0)
    // 界面上该 hint 按纯文本渲染，故不得依赖 markdown 强调号
    assert.ok(!o.hint.includes('**'), 'hint 不得依赖 markdown 强调（界面按纯文本渲染）')
  }
})
