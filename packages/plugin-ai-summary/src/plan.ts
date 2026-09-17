/**
 * `@geewiki/ai-summary` 的**纯函数核心**（零 IO、零 cordis、零数据库）。
 *
 * 分成单独一份的理由与 `plugin-ai-journal/src/plan.ts` 相同：这里的东西全部可以用
 * 普通单测钉死，而 `index.ts` 里剩下的都是接线。**判据一旦混进 IO 就很难验**——
 * 例如"摘要该不该判过期"这件事，混在 `index.ts` 里就只能起一个真数据库去测。
 */
import { createHash } from 'node:crypto'
import type { LlmMessage } from '@geewiki/llm'

/* ============================== 生成：提示词 ============================== */

/**
 * 摘要的系统提示。
 *
 * ## 为什么要求里有一句"覆盖读者可能的问法"
 * 用户需求 ③ 有两半：**自动写摘要** 与 **按摘要检索**。第二半对第一半提了要求——
 * 摘要必须**长得像提问**才可能被自然语言问句检索到。
 *
 * 这一条不是凭感觉写的，它有实测依据：在本仓的 RAG 探针里，同一个问句
 * 「怎么新建内容」对**真实正文**检索 `total = 0`，而对一段"用自然语言概述这一页讲了什么"
 * 的文本 `total = 1`（score 12.86）。差别就在措辞——正文写的是「右上角【新建页面】」，
 * 而问句说的是「怎么新建内容」，两者**没有一个 3-gram 相同**。
 *
 * ## 为什么禁止 Markdown 与分点
 * 摘要在卡片里以**一段文字**呈现（折叠态还要压成一行）。让模型自由发挥格式的后果是
 * 卡片里出现半截列表、半截标题，而折叠态的一行预览会变成 `- **要点**：…` 这种残骸。
 * 格式约束放在这里比放在渲染层可靠：渲染层只能删掉它看不懂的东西，那是在丢信息。
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '你是 GeeWiki 知识库的摘要助手。为用户给出的文章写一段摘要，供两种用途：',
  '(1) 读者在文章顶部一眼看出这一页讲什么；(2) 别人用自然语言提问时能检索到这一页。',
  '',
  '硬性要求：',
  '- 只输出摘要正文本身：**不要**分点、**不要**标题、**不要**任何 Markdown 标记、**不要**代码块；',
  '- 写成一段连续的文字（可以有多句），用文章本身的语言；',
  '- 直接写内容，不要写「本文」「这篇文章」「摘要如下」这类引言；',
  '- 把文章里的关键概念连同**同义的说法**都写进去（例如「新建页面」也写成「创建内容」），' +
    '这样别人换一种问法也能检索到它——这是摘要最重要的用途，不要为了简短而省略；',
  '- 只依据给出的正文，不要补充正文之外的知识，也不要编造事实；',
  '- 如果正文明显不完整（例如只有半句话），照实概括已有的部分，不要脑补。',
].join('\n')

/** 正文被截断时补在提示里的说明（见 {@link buildSummaryMessages}） */
export const TRUNCATION_NOTE =
  '（注意：原文过长，下面只给出了前半部分。请只概括给出的部分，不要假设后面还有什么。）'

/**
 * 构造摘要请求：**恰好两条消息**（system + user）。
 *
 * 截断必须**说出来**，这是本仓的一条既有纪律（`read_page` 的 `truncated` + `hint`）：
 * 静默截断会把"我没看到"伪装成"资料里没有"，于是模型会给出一份看起来完整、
 * 实际漏掉后半篇的摘要，而**没有任何地方能看出它漏了**。
 */
export function buildSummaryMessages(title: string, content: string, maxSourceChars: number): LlmMessage[] {
  const truncated = content.length > maxSourceChars
  const body = truncated ? content.slice(0, maxSourceChars) : content
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `标题：${title}\n\n` +
        (truncated ? `${TRUNCATION_NOTE}\n\n` : '') +
        `正文：\n${body}`,
    },
  ]
}

/* ============================== 生成：清洗模型输出 ============================== */

/** 模型爱加而这些前缀对读者无意义（去掉后卡片更像"这一页的摘要"而不是"一段生成物"） */
const LEADING_LABEL_RE = /^\s*(?:摘要|总结|概要|简介|内容摘要|summary)\s*[:：]\s*/i
const FENCE_RE = /^\s*```[a-zA-Z]*\s*\n?|\n?\s*```\s*$/g

/**
 * 把模型输出收敛成**一段可以放进卡片**的文字。
 *
 * 返回值可能是空串 —— 调用方必须把它当成"这次生成没成功"处理，**不要存空摘要**：
 * 一张写着空白的卡片比没有卡片更糟（读者会以为这一页没内容）。
 * 这与 `@geewiki/ai-qa` 那条"宁可明确不可用，也不能冒充答案"是同一条纪律。
 */
export function cleanSummary(raw: string, maxChars: number): string {
  let text = raw.replace(FENCE_RE, '').trim()
  // 去前缀要循环：模型偶尔会写「摘要：总结：…」
  for (let i = 0; i < 3 && LEADING_LABEL_RE.test(text); i++) text = text.replace(LEADING_LABEL_RE, '')
  // 整段被引号包住（模型把摘要当引用写）
  text = text.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '')
  // 折行并成一段：卡片里是连续文字，保留换行只会让折叠态出现空洞
  text = text.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
  if (text.length <= maxChars) return text
  /*
   * 超长时在**句末**截，不要在字数处硬切：硬切出来的半句话在中文里尤其刺眼
   * （「…支持三种可见性：公开、」）。找不到句末标点才退回硬切——
   * 宁可难看，也不要为了好看而丢掉超过一半的内容。
   */
  const head = text.slice(0, maxChars)
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('. '),
    head.lastIndexOf('；'),
    head.lastIndexOf('; '),
  )
  return cut >= Math.floor(maxChars * 0.5) ? head.slice(0, cut + 1).trim() : head.trim()
}

/* ============================== 过期判定 ============================== */

/** 正文的内容哈希（摘要的"我这份对应哪一版正文"） */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 摘要是否过期：**存下来的输入哈希 ≠ 现在的输入哈希**。
 *
 * 为什么不用时间戳（`pages.updated_at > page_summaries.generated_at`）：
 * 两者都只到毫秒，而"保存完立刻生成"是很常见的时序 —— 同一毫秒内的比较结果是任意的，
 * 于是一份刚生成的摘要会随机地被标成"已过期"。哈希没有这个问题，而且它顺带把
 * "内容没变但行被更新过"（例如只改了可见性）也正确判成**没过期**：摘要说的是内容，
 * 内容没变它就没过期。
 */
export function isStale(storedHash: string, currentHash: string): boolean {
  return storedHash !== currentHash
}

/* ============================== 按摘要检索（纯函数） ============================== */

/** 查询里最多取多少个片段去匹配（防止长问句把 SQL 撑爆） */
export const MAX_QUERY_GRAMS = 40
/** 片段短于这个长度就不取（单字在中文里几乎命中一切，没有区分度） */
export const MIN_GRAM = 2

/** 无词边界的文字系统（与 `@geewiki/search` 的 trigram 判据同源，只是取 2-gram） */
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const ASCII_TOKEN_RE = /[A-Za-z0-9_]+/g

/**
 * 把查询切成用于 LIKE 匹配的片段。
 *
 * ## 为什么是 2-gram，而 `@geewiki/search` 用的是 3-gram
 * 两者的约束不同：FTS5 的 `trigram` 分词器**只能**索引 3 字符片段，短于 3 字符的查询
 * 在 `MATCH` 下恒为空（那是分词器的硬限制，本仓已实测并把 LIKE 兜底写进了检索插件）。
 * 这里不走 FTS，走的是 `LIKE '%片段%'`，于是**长度由我们自己定**。
 * 取 2 而不是 3 是因为中文里大量关键概念就是两个字（「摘要」「检索」「权限」），
 * 3-gram 会把它们整个漏掉。
 *
 * ## 为什么不直接用整串查
 * 自然语言问句在正文里逐字出现的概率极低——这正是检索插件当初那个"`phrase` 模式
 * 对问句恒为 0 命中"的缺陷。切片 OR 匹配是同一个解药。
 */
export function queryGrams(query: string): string[] {
  const out = new Set<string>()
  const text = query.trim()
  if (text === '') return []
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0]
    if (run.length < MIN_GRAM) continue
    if (run.length === MIN_GRAM) {
      out.add(run)
      continue
    }
    for (let i = 0; i + MIN_GRAM <= run.length; i++) out.add(run.slice(i, i + MIN_GRAM))
  }
  for (const match of text.matchAll(ASCII_TOKEN_RE)) {
    const token = match[0]
    if (token.length >= MIN_GRAM) out.add(token.toLowerCase())
  }
  return [...out].slice(0, MAX_QUERY_GRAMS)
}

/**
 * LIKE 的通配符转义。
 *
 * **不转义的后果是不报错的**：用户搜 `100%` 会命中所有摘要（`%` 被当成通配符），
 * 而搜 `a_b` 会命中 `axb`。`ESCAPE '\'` 由调用方在 SQL 里声明。
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 供 `... LIKE ? ESCAPE '\'` 使用的模式串（`%片段%`），已转义 */
export function likePatternsOf(query: string): string[] {
  return queryGrams(query).map((gram) => `%${escapeLike(gram)}%`)
}

/**
 * 一条摘要在这次查询下得了多少分 = **命中的不同片段数**。
 *
 * 为什么按"命中数"而不是"命中长度"排序：短问句里每个片段都该算一票
 * （「怎么新建内容」的「新建」与「内容」各命中一次，说明这一页确实讲这两件事）；
 * 按长度排会让"碰巧含一个长词"的摘要压过"两个概念都对上"的摘要。
 *
 * 一处刻意的偏差：**大小写按不敏感比**（英文提问者不会记得正文里的大小写），
 * 而 SQL 那侧的 `LIKE` 在 SQLite 下对 ASCII 本就不敏感、在 PG 下敏感 ——
 * 故最终排序以这里的 JS 打分为准，SQL 只负责**粗筛**（多召回一些候选，排序在我们手上）。
 */
export function scoreSummary(grams: readonly string[], summary: string): number {
  if (grams.length === 0) return 0
  const haystack = summary.toLowerCase()
  let hits = 0
  for (const gram of grams) if (haystack.includes(gram.toLowerCase())) hits++
  return hits
}

/**
 * 粗筛阶段一次最多取回多少行候选。
 *
 * 取回后由 {@link scoreSummary} 精确排序并截到调用方要的条数。上限存在的意义是
 * **让最坏情况可预测**：没有它，一条由逗号拼成的长查询会把整张表拖进内存。
 */
export const MAX_CANDIDATES = 200
