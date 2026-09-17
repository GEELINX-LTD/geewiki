/**
 * `@geewiki/ai-summary` 的**纯函数**测试（`src/plan.ts`）。
 *
 * 这一层值得单独测，因为它的每一条都对应一个**不报错的**失败：
 * 提示词漏了截断说明 ⇒ 摘要看起来完整却漏掉后半篇；清洗没去代码围栏 ⇒ 卡片里出现 ```；
 * 2-gram 切错 ⇒ 中文问句恒 0 命中（而"0 命中"与"库里真没有"长得一模一样）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSummaryMessages,
  cleanSummary,
  escapeLike,
  hashOf,
  isStale,
  likePatternsOf,
  queryGrams,
  scoreSummary,
  MAX_QUERY_GRAMS,
  TRUNCATION_NOTE,
} from '../src/plan.js'

/* ============================== 提示词 ============================== */

test('buildSummaryMessages：恰好两条消息，system 在前', () => {
  const messages = buildSummaryMessages('标题', '正文', 1000)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages[1]?.role, 'user')
})

test('buildSummaryMessages：正文超限时**说出**被截断，而不是静默切掉', () => {
  const long = '甲'.repeat(50)
  const cut = buildSummaryMessages('标题', long, 10)
  assert.ok(cut[1]?.content.includes(TRUNCATION_NOTE), '截断必须写在提示里')
  assert.equal(cut[1]?.content.includes('甲'.repeat(11)), false, '超出上限的部分不该出现在提示里')

  const whole = buildSummaryMessages('标题', long, 1000)
  assert.equal(whole[1]?.content.includes(TRUNCATION_NOTE), false, '没截断就不该有那句话')
})

/* ============================== 清洗 ============================== */

test('cleanSummary：去掉「摘要：」前缀（含叠加的多个）', () => {
  assert.equal(cleanSummary('摘要：这一页讲的是检索。', 100), '这一页讲的是检索。')
  assert.equal(cleanSummary('摘要：总结: 这一页讲的是检索。', 100), '这一页讲的是检索。')
  assert.equal(cleanSummary('Summary: how search works', 100), 'how search works')
})

test('cleanSummary：去掉代码围栏与整段引号', () => {
  assert.equal(cleanSummary('```markdown\n这一页讲检索。\n```', 100), '这一页讲检索。')
  assert.equal(cleanSummary('“这一页讲检索。”', 100), '这一页讲检索。')
})

test('cleanSummary：折行并成一段（折叠态要能压成一行）', () => {
  assert.equal(cleanSummary('第一句。\n\n第二句。', 100), '第一句。 第二句。')
})

test('cleanSummary：超长时在**句末**截，而不是在字数处硬切', () => {
  const text = '甲'.repeat(30) + '。' + '乙'.repeat(100)
  const out = cleanSummary(text, 50)
  assert.ok(out.endsWith('。'), `应该在句末收尾，实际结尾：${out.slice(-5)}`)
  assert.ok(out.length <= 50)
})

test('cleanSummary：找不到句末标点才退回硬切（宁可难看，不要为好看丢一半）', () => {
  const out = cleanSummary('甲'.repeat(100), 40)
  assert.equal(out.length, 40)
})

test('cleanSummary：空输入产出空串（调用方必须据此判"这次生成没成功"）', () => {
  assert.equal(cleanSummary('', 100), '')
  assert.equal(cleanSummary('   \n  ', 100), '')
})

/* ============================== 过期判定 ============================== */

test('isStale：哈希不同即过期；相同即不过期', () => {
  const a = hashOf('正文甲')
  assert.equal(isStale(a, hashOf('正文甲')), false)
  assert.equal(isStale(a, hashOf('正文乙')), true)
})

/* ============================== 检索片段 ============================== */

test('queryGrams：中文取 2-gram（中文的关键概念常是两个字，3-gram 会整个漏掉）', () => {
  const grams = queryGrams('新建内容')
  assert.ok(grams.includes('新建'), `缺少「新建」：${grams.join('|')}`)
  assert.ok(grams.includes('内容'), `缺少「内容」：${grams.join('|')}`)
})

test('queryGrams：英文按词切且小写化', () => {
  const grams = queryGrams('How To Search')
  assert.ok(grams.includes('how'))
  assert.ok(grams.includes('search'))
  assert.equal(grams.some((g) => /[A-Z]/.test(g)), false, '不该留下大写（问句的大小写不该参与匹配）')
})

test('queryGrams：单个 CJK 字**不**产出片段（单字几乎命中一切，没有区分度）', () => {
  // 这一条同时钉住了端点的兜底路径：片段为空时端点会退化成"整串 LIKE"，
  // 而不是把 where 子句变成空条件（那会返回全表，看起来像检索坏了）。
  assert.deepEqual(queryGrams('的'), [])
})

test('queryGrams：空串与纯空白产出空数组', () => {
  assert.deepEqual(queryGrams(''), [])
  assert.deepEqual(queryGrams('   '), [])
})

test('queryGrams：片段数有上限（长问句不该把 SQL 撑爆）', () => {
  // 用**互不相同**的汉字，否则 Set 会把重复的 bigram 收敛成一个（那样测不出上限）
  const grams = queryGrams(Array.from({ length: 500 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(''))
  assert.equal(grams.length, MAX_QUERY_GRAMS)
})

test('escapeLike：% 与 _ 必须转义，否则搜「100%」会命中全部', () => {
  assert.equal(escapeLike('100%'), '100\\%')
  assert.equal(escapeLike('a_b'), 'a\\_b')
  assert.equal(escapeLike('c\\d'), 'c\\\\d')
})

test('likePatternsOf：产出 %片段% 形态（% 是问句里的分隔符，不是词元的一部分）', () => {
  const patterns = likePatternsOf('100%新建')
  assert.ok(patterns.includes('%新建%'), patterns.join('|'))
  assert.ok(patterns.includes('%100%'), patterns.join('|'))
})

/* ============================== 打分 ============================== */

test('scoreSummary：按命中的**不同片段数**计分', () => {
  // 「新建内容」的 bigram 是 新建 / 建内 / 内容 三个
  const grams = queryGrams('新建内容')
  assert.equal(grams.length, 3)
  assert.equal(scoreSummary(grams, '这一页讲怎么新建内容。'), 3)
  assert.equal(scoreSummary(grams, '这一页只讲了新建。'), 1)
  assert.equal(scoreSummary(grams, '毫不相关。'), 0)
})

test('scoreSummary：大小写不敏感（英文提问者不会记得正文里的写法）', () => {
  const grams = queryGrams('search')
  assert.equal(scoreSummary(grams, 'About SEARCH and indexing'), 1)
})

test('scoreSummary：没有片段时恒 0（不能变成"全体满分"）', () => {
  assert.equal(scoreSummary([], '任何摘要'), 0)
})
