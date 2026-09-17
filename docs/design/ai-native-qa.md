# AI 原生问答改造方案（草稿 · 待评审）

> 本文件是**方案**，不是已落地事实。所有"实测"段落都在隔离实例上跑过，原始读数见
> `data/verify/ai-native-probe/`（探针库 + 服务日志）。凡未标注实测的，都是设计判断。

## 0. 一句话结论

今天的问答**不是"体验差"，是"结构上没有这条路"**：

1. 插槽契约里**根本没有"当前页面"** ⇒ 需求「针对本页回答」今天不可能实现（实测 E1）；
2. 检索是"问句的每个 3-gram 各自 OR"，**措辞一变就 0 命中**（实测 E2）；
3. **命中页喂给模型的是页头，不是命中的那一段** —— 最严重的一条：页对上、分够高、`used:true`，
   模型却答「资料不足」（实测 E4）；
4. 没有摘要层、没有会话、没有页作用域。

**而"给 AI 更多自由"（需求 ⑤⑥）这条路是通的，但有个反直觉的次序。** 上游（vLLM）实测
完整支持 OpenAI 风格工具调用，我们也真的跑通了一轮 agent loop：问「怎么新建内容」，模型自己
换了 15 次检索措辞、走了 5 个 LLM 轮次，**最终答对了**。但：

- 第 2 轮它连猜 5 次**全空**——没有语料词汇线索时，它只能盲猜；
- 真正让它上岸的是第 3 轮**偶然**命中一篇后拿到的词汇反馈；
- 单让模型做「查询改写」（无反馈）产出的三条查询，**在真实索引上全部 `total=0`**。

⇒ **所以正确次序是：先做摘要索引（把语料词汇提前摆到模型面前），再考虑工具循环。**
反过来的话，会得到一个「要检索十几次才答对」的系统。见 §5.5。

四条需求里有三条（本页回答 / 摘要索引 / 摘要展示）**都需要改契约**，不是调参能解决的；
需求 ⑥ 不依赖工具调用，可以更早做掉。

---

## 1. 现状诊断（全部为实测）

### 1.1 契约里没有"当前页面"——需求 ①② 今天是死的

`WikiAskSlotProps`（`packages/core/src/index.ts:910`）只有三个字段：

```ts
export interface WikiAskSlotProps {
  readonly query: string          // 来自 #/wiki/ask/<q>
  onAsk(query: string): void
  openPage(slug: string): void
}
```

没有 slug、没有页面内容、没有选区、没有会话。而问答面板**只在 `#/wiki/ask/<q>` 挂载**
（`packages/web/src/pages/WikiPage.tsx` 的 `route.kind === 'ask'` 分支，
`packages/web/src/lib/pluginUiPlan.ts:110` 的 `ON_DEMAND_SLOTS` 含 `wiki-ask`）——
读文章时**一个 AI bundle 都不加载**，页面上也没有任何 AI 入口。

后端同样没有这条路。**实测 E1**：

```
POST /api/ai/ask   {"q":"…","page":"mixed-visibility","history":[…]}
  → 400 {"ok":false,"error":"invalid_body","message":"未知字段: page, history"}
POST /api/ai/stream {"q":"…","slug":"mixed-visibility"}
  → 400 {"ok":false,"error":"invalid_body","message":"未知字段: slug"}
```

⇒ 需求 ①（嵌合在页面里）与 ②（针对当前页回答）**是契约缺口，不是体验问题**。

### 1.2 检索：措辞一变就 0 命中（实测 E2）

`mode:'terms'` 把问句切成 3-gram 后**逐个 OR**
（`packages/plugin-search/src/index.ts:566-569`，切词见同文件 `buildTermQuery` `:351`）。
「怎么新建内容」→ `怎么新 / 么新建 / 新建内 / 建内容`，而主页正文写的是
「想写新内容：右上角「<b>新建页面</b>」（需要编辑权限）」——**四个 gram 一个都不在里面**：

| 查询 | 模式 | total | 结果 |
| --- | --- | --- | --- |
| `新建页面`（原文措辞） | phrase | **1** | `home` 命中，snippet 含高亮 |
| `怎么新建内容`（用户措辞） | terms | **0** | `mode:"no-context"`，`answer:null` |

这一条**不是 bug，是字面检索的固有上限**：用户措辞与作者措辞不重合时，FTS5 无能为力。
而它恰好是需求 ③（摘要索引）要解决的那一类问题。

### 1.3 命中页给的是"页头"，不是"命中的那一段"（最严重）

`packages/plugin-ai-qa/src/select.ts:58-70` 的 `accumulateBlocks()` **从 `view.blocks[0]` 开始**
按整块累加，而 `view.blocks` 是按 `b.ordinal` **升序**返回的
（`packages/plugin-search/src/index.ts:719-724` 的 `ORDER BY b.page_id, b.ordinal`）。
默认预算 `perSourceChars: 1200`（`packages/plugin-ai-qa/src/index.ts:128` 的 `AiQaConfigSchema`）。

⇒ **长页面永远只把开头 1200 字喂给模型**，命中位置在页面中后段时，模型拿到的资料与问题无关。

**实测 E4**：造一页 6437 字符，60 段占位正文，结论 `**麒麟协议**的握手超时时间是 **42 秒**`
放在**最后一段**。问「麒麟协议的握手超时时间是多少」：

```json
{"mode":"rag","retrieval":{"mode":"fts","total":1,"limit":8},
 "sources":[{"n":1,"used":true,"slug":"long-page-probe","score":54.03}],
 "answer":"知识库资料不足，无法回答。\n\n当前资料[1]未包含"麒麟协议""握手"…"}
```

**页面命中了、排第一、score 54、`used:true`，模型却答"资料不足"** —— 因为 42 秒从没进过 prompt。
这是当前 RAG 最致命的一条：它把"没检索到"和"检索到了但没给模型看"变成同一种表现，
而两者该做的事完全不同。

### 1.4 没有摘要层

全仓没有任何"页面摘要"概念。唯一的 `summarize` 是 `@geewiki/ai-assist` 的编辑器动作
（`packages/plugin-ai-assist/src/assist.ts:79`），**不写回正文、也不落库**
（`ui/assistPlan.ts:229`：「摘要仅供查看，不会写入正文」）。

检索单元是**原始块**，没有"以文章为单位"的入口 ⇒ 无法回答"哪篇文章讲这个"，
也无法用更短、更高信号的文本做召回。

**实测 E3（可行性验证）**：造一页，正文就是一段自然语言概述
「本页概述：主页说明如何编辑与新建内容，如何浏览全部页面与目录树…」，**同一问句**
「怎么新建内容」→ `total:1`，score `12.86`，命中该页。

⇒ **摘要式措辞确实补上了 1.2 的召回缺口**，这是需求 ③ 的经验依据，不是想当然。

### 1.5 单轮：没有会话

`packages/plugin-ai-qa/src/prompt.ts` 的 `buildMessages(query, sources)` **没有 history 参数**，
恒返回 system + user 两条消息。每一次追问都是一次全新检索 + 全新生成。
用户问「那第二点呢？」时，检索用的是这五个字本身的 3-gram —— 必然召回噪声。

### 1.6 附带发现：break-glass 的"读"与"检索"不一致（**与本次改造无关，但应记档**）

**实测 E5**（库内该页 `visibility='org'`、`published_at IS NULL`、`blocks.tier = 1`）：

```
GET  /api/pages/private-probe        (break-glass) → 404 {"error":"not_found"}
GET  /api/search?q=玄武令牌&mode=terms (break-glass) → total 1，snippet 含正文
```

原因：`readerTierOf()`（`packages/plugin-search/src/index.ts:1082-1085`）对
`kind === 'break-glass'` **硬编码返回 1**，而 `Principal.orgRole` 对 break-glass 是 `null`
（`packages/core/src/index.ts:549`，刻意如此）⇒ 页面读路径判"不是组织成员"，
检索路径判"组织级可见"。两条路对同一主体给出相反结论。
**修哪个方向是策略决定**，但两者必须收敛到一处真源。

---

## 2. 需求 → 改造映射

| 用户需求 | 根因 | 改造 |
| --- | --- | --- |
| ① 问答嵌合进页面 | 只在 `#/wiki/ask/<q>` 挂载 | **A. 契约与放置** |
| ② 回答当前页 + 按需找其他页 | props/API 都没有页上下文 | **A. 契约与放置** |
| ③ 自动写摘要 + 按摘要检索 | 无摘要层、无摘要索引 | **B. 摘要子系统** |
| ④ 摘要在文章最上方折叠显示 | 无摘要、无展示位 | **B. 摘要子系统** |
| （体验）答得准 | 命中段没进 prompt、3-gram OR 无精度 | **C. 检索质量** |
| （体验）能追问 | 无 history | **D. 多轮** |

---

## 3. 改造 A：问答嵌合 + 当前页作用域

### 3.1 契约（**三处镜像 + 两份守卫测试必须同步改**）

真源 `packages/core/src/index.ts:910`，镜像 `packages/web/src/lib/slots.tsx` 与
`packages/web/src/lib/pluginUiPlan.ts`，守卫 `packages/web/test/slotPropsMirror.test.ts`
（逐字段比对）与 `packages/manager/test/slots.test.ts`（`SLOT_NAMES` 字面量）。
仓库既有纪律：**新字段一律可选或带默认语义**。

```ts
export interface WikiAskSlotProps {
  readonly query: string
  onAsk(query: string): void
  openPage(slug: string): void

  /** ★ 新增：宿主只传身份，不传正文 —— 正文一律由插件带主体自己去取（见 §3.3 红线） */
  readonly page?: { readonly slug: string; readonly title: string }
  /** ★ 新增：面板形态。'dock' = 阅读页内嵌，'full' = #/wiki/ask/<q> 整页 */
  readonly variant?: 'dock' | 'full'
  /** ★ 新增：会话。宿主只透传/托管，不解释内容 */
  readonly history?: readonly AskTurn[]
  onHistoryChange?(turns: readonly AskTurn[]): void
}

export interface AskTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}
```

**关键取舍：宿主只传 `slug`，绝不传正文。** 正文若从宿主塞进 props，就绕过了
"命中层与正文层各过滤一次"这条既有权限红线（`search-service.contents()` 是唯一正文出口）。
宿主自己取正文还会造出第二条 ACL 实现 —— 必然漂移。

### 3.2 宿主侧放置（"自然嵌合"具体长什么样）

- **阅读页 `#/wiki/<slug>`**：`<WikiAskSlotOutlet variant="dock" page={{slug,title}} …>`
  渲染在 `.gw-reader` 的**右下角**(或阅读栏底部)，**初始折叠为一条单行输入**
  （「问这一页…」+「⌘J」提示），聚焦后才展开成面板。不改 hash、不跳路由。
- **`#/wiki/ask/<q>`**：`variant="full"`，整页面板（保持现有形态与深链可分享能力）。
- **搜索结果页 / 列表页**：`page` 为 `undefined`，面板退化为"全库问答"。

**懒加载必须改但方向要克制**：今天 `ON_DEMAND_SLOTS` 让读页**零 AI bundle**，
这是设计文档明确写下的决定（`docs/design/ai-plugin-split.md` §4.4）。
改造后**不要在文章挂载时就加载**，而是：
**首次交互（点输入框/按 ⌘J）+ `requestIdleCallback` 兜底**才 `ensureSlotLoaded('wiki-ask')`。
文章正文照旧先出来，AI bundle 后到。

### 3.3 后端：页作用域（`scope`）

`POST /api/ai/ask` 与 `POST /api/ai/stream` 的 body 扩展：

```ts
{ q: string
  limit?: number
  scope?: 'page' | 'all' | 'auto'   // 缺省 'auto'：本页优先，全库补充
  page?: string                     // scope 为 page/auto 时的当前 slug
  history?: readonly AskTurn[]      // 见 §6
}
```

`retrieve()`（`packages/plugin-ai-qa/src/index.ts:421`）改为**两桶**：

```
桶 1【当前页面】：scope ∈ {page, auto} 且 page 非空
   → search.contents(principal, [page])       // 仍带主体，红线不动
桶 2【知识库其他页面】：始终执行
   → search.search(principal, q, { limit, mode:'terms' })   // 排除桶 1 的 slug
   → search.contents(principal, hits.map(h => h.slug))
```

Prompt 相应改为**分区标注**（`packages/plugin-ai-qa/src/prompt.ts`）：

```
[1] 【当前页面】<标题>（<slug>）
<本页可见正文，按预算>
[2] 【知识库其他资料】<标题>（<slug>）
<…>
```

system prompt 增补两条：① 标着【当前页面】的资料就是用户正在读的那一篇，
当问题是「这一页/本页」时以它为准；② 若答案主要来自其他页面，在回答里点明来自哪一页，
便于用户点开（`sources[].slug` 已经在响应里，前端今天就能跳）。

`scope` 的**产品含义**：面板上给一个**可见的切换**「仅本页 / 全库」（缺省"自动"）。
可见的开关比隐式启发式更好验收，也让用户有主体感 —— 这正是"嵌合"的一部分。

**`capabilities` 不变**（`available = modelReady && searchReady`）。
但新增一个**诚实的降级**：`scope:'page'` 而 `contents()` 返回空（页面全受限/已删除）⇒
**200 且明确说明"当前页面对你不可见或没有可读内容"**，不退化成"全库问答"冒充本页回答。

---

## 4. 改造 B：页面摘要子系统

### 4.1 归属：新插件 `@geewiki/ai-summary`

| 项 | 值 |
| --- | --- |
| `provides` | `summary-service` |
| `requires` | `['http-service','database-provider','llm-service','policy-service']` |
| 迁移 | 自带 `migrations/0001_page_summaries.sql`（插件级迁移目录，范式同 `@geewiki/search`） |
| 端点 | `GET /api/summaries/:slug`、`POST /api/admin/summaries/rebuild`、`GET /api/admin/summaries/verify` |
| 插槽 | 新增 `wiki-summary`（**单占用**、带数据） |
| 默认层 | 进 `config/plugins.base.json`（与另外三个 AI 插件一致） |

**为什么单开一个插件而不是塞进 `@geewiki/ai-qa`**：摘要的生产者与消费者都多于问答
（将来列表页/搜索页的摘要条、站点地图、门户都要读它）。塞进 ai-qa 会让
"停用问答"顺带把摘要也停掉，而这两件事的可用性条件并不相同。

### 4.2 数据模型

```sql
CREATE TABLE IF NOT EXISTS page_summaries (
  page_id           INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  slug              TEXT    NOT NULL,          -- 审计冗余；现值一律以 pages 为准
  summary           TEXT    NOT NULL,          -- 2–4 句概述（折叠态显示这一行）
  bullets           TEXT    NOT NULL DEFAULT '[]',  -- 展开态的要点 JSON 数组
  keywords          TEXT    NOT NULL DEFAULT '',    -- 空格分隔的扩展词（同义词/别名）
  tier              INTEGER,                   -- 生成时的 effectiveIndexLevel；NULL = 不可索引
  source_hash       TEXT    NOT NULL,          -- 生成时正文的 sha256（判定过期）
  source_updated_at TEXT    NOT NULL,          -- 生成时 pages.updated_at
  model             TEXT    NOT NULL,
  status            TEXT    NOT NULL,          -- 'ok' | 'failed' | 'skipped'
  error_code        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  summary, keywords, title,
  content='', contentless_delete=1, tokenize='trigram'
);
```

**必须照抄 `blocks_fts` 的两个实测坑**（见 `packages/plugin-search/migrations/0002_blocks_fts.sql` 文件头）：

1. **tier 过滤绝不能写在 FTS 表上** —— contentless 表的 `UNINDEXED` 列读回是 `NULL`，
   谓词恒不成立、**静默 0 行**。正确形态：`tier` 冗余在 `page_summaries` 上，
   检索时 `JOIN page_summaries s ON s.page_id = f.rowid AND (s.tier <= :readerTier OR s.page_id IN (:grantedPageIds))`。
2. **`granted` 档（`tier IS NULL`）永不被等级分支命中**（`NULL <= ?` 恒不成立，失败关闭），
   只能靠授权分支放行；而授权集合**只能来自 `policy-service`**，不许另写一套判定。

**同步必须收敛到单一模块**（范式同 `packages/plugin-wiki/src/blocks.ts` 的 `syncBlocksForPage()`）：
`packages/plugin-ai-summary/src/store.ts` 的 `writeSummaryForPage()`，
配一条**源级守卫测试**断言全仓再无第二处 `INSERT INTO summaries_fts`，
并加 `GET /api/admin/summaries/verify` 一致性探针（行数差 + 抽样命中）——
`contentless` FTS 表没有触发器兜底，探针是替代品。

### 4.3 生成触发：**拉，不是推**

**明确不做的**：不给 `plugin-wiki` 加保存钩子。理由：那会给 wiki 引入一个新耦合面，
且插件重启、并发保存、失败重试都要在钩子侧各写一遍。**拉模型天然对这些免疫。**

三条触发路径：

1. **追赶扫描（主路径）**：`setInterval`（默认 60s；范式同 `packages/plugin-oidc/src/index.ts:476`
   与 `packages/manager/src/index.ts:1530`）找
   `page_summaries` 缺失 **或** `source_updated_at < pages.updated_at` **或**
   `status='failed' AND attempts < N` 的页，**串行**生成（默认并发 1）。
2. **按需（首读体验）**：`GET /api/summaries/:slug` 发现过期/缺失 ⇒ 入队并**立即返回
   `{status:'pending'}`**，前端显示"摘要生成中"；生成完成后前端轮询或下次进入即可见。
   **不做同步等待**——一次 LLM 调用塞进页面 GET 会拖死首屏。
3. **手动重建**：`POST /api/admin/summaries/rebuild`（带 `slug?` / `all` / `stale`），
   范式与既有 `GET /api/admin/search/verify` 同级，走运维权限。

**成本闸门**（全部进 `configSchema`，与 ai-qa 把预算做成配置项的风格一致）：

| 配置 | 默认 | 理由 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不生成、不展示，但不删已有摘要 |
| `sweepIntervalMs` | `60000` | 追赶节奏 |
| `maxPerSweep` | `4` | 单轮最多生成 4 页，防一次性烧配额 |
| `concurrency` | `1` | 串行，避免与用户问答抢上游配额 |
| `minPageChars` | `120` | 太短的页不值得花一次调用，`status='skipped'` |
| `maxPageChars` | `12000` | 超长页截断后再喂（摘要不需要全文） |
| `maxAttempts` | `3` | 失败退避上限，超了标 `failed` 等人工重建 |
| `maxOutputTokens` | `512` | 单次摘要输出上限 |

**没有可用模型时**：不生成、不报错、不写 `failed`（那是"上游失败"的语义），
`GET /api/summaries/:slug` 返回 `{available:false}`，前端**什么都不渲染**。

### 4.4 可见性与安全红线（**这一节不能省**）

摘要是**页面的派生内容**，一旦落库就多了一份可能泄漏的副本。三条硬规则：

1. **生成输入的取法**：正文**只能经 `search-service` 取**，且是**按该页自身有效检索等级
   投影后的可见块**（`policy-service.effectiveIndexLevel(slug)` 给出 0/1/NULL），
   **不是** `pages.content` 全文。
   ⇒ 「公开页 + 组织内块」的页，摘要里**不可能**出现那个块的内容。
   落地方式：给 `search-service` 增加一个**窄读接口**
   `contentAtEffectiveLevel(slug)`（与 `contents()` 共用同一条 SQL 与同一套谓词，
   只把 `readerTier` 换成 `effectiveIndexLevel`）——**绝不复制第二份 tier 计算**。
2. **命中过滤与正文过滤两道**：`summary-service.search(principal, q)` 的候选集
   **必须过 `policy-service`**（范式同 `plugin-search` 的命中层过滤），
   不能因为"摘要很短"就省掉。
3. **`tier IS NULL` 的页不生成**（没有任何等级能看到它）⇒ `status='skipped'`，
   `error_code='not_indexable'`。

**一个需要拍板的取舍**：按规则 1，受块级限制的页面只会得到"公开部分"的摘要 ——
对有受限段落的页，摘要可能**偏浅**。备选是这类页干脆不生成（更保守、但覆盖面小）。
**建议取前者**（偏浅好过缺失），并在展开态的摘要下方标注「本页含受限段落，摘要只覆盖公开部分」——
**诚实**比"看起来完整"重要，这也是本仓库一贯的口径。

### 4.5 展示：文章最上方的折叠卡片

**位置**：`packages/web/src/pages/WikiPage.tsx:2017` 的 `<article className="gw-reader">` 内，
`:2018` 的 `<h1>` **之前**，插一个 `<WikiSummarySlotOutlet slug title />`。

**视觉契约不能忘**：同文件 2026-09-13 的用户反馈明确要求 article 卡**没有卡片外观**
（无 bg/border/shadow/padding）。摘要卡片必须**从属于正文排版**，不能变成一个新的"盒子"：

```
▸ AI 摘要 · 3 个要点 · 2 天前                        ← 折叠态：一行、muted、无边框
▾ AI 摘要 · 3 个要点 · 2 天前
    • 主页说明如何编辑与新建内容，以及浏览目录树的入口
    • 写新内容需要编辑权限；公开档必须同时发布才对匿名可见
    基于 2026-09-12 的版本 · 由 AI 生成，可能有误 · [重新生成]
```

四种状态（**都要实现，不能只做 happy path**）：

| 状态 | 渲染 |
| --- | --- |
| 有摘要 | 折叠一行（默认折叠），展开显示要点 + 脚注 |
| 生成中 | 一行骨架「AI 摘要生成中…」，**占住高度避免布局抖动** |
| 已过期（`source_updated_at < pages.updated_at`） | 照常显示旧摘要 + 一行「内容已更新，摘要可能过期 · 重新生成」 |
| 不可用（无模型 / 无摘要且不可生成） | **什么都不渲染**，不留空位、不报错 |

**为什么归插件不归宿主**：本仓库刚用一整批把 AI 界面从宿主搬到插件
（`docs/design/ai-plugin-split.md`），理由写在 `WikiPage.tsx:876-878`：
"为什么不可用只有插件知道，宿主替它解释就是替别人的功能编造理由"。摘要卡同理。

**代价要如实记**：`wiki-summary` 挂在每一篇阅读页上，**AI bundle 会随阅读页加载**，
与 `docs/design/ai-plugin-split.md` §4.4「读页面首屏不加载任何 AI bundle」冲突。
两条出路，需拍板：
- **(a) 推荐**：保留懒加载 —— 文章正文先渲染，摘要卡用 `IntersectionObserver`/`requestIdleCallback`
  在空闲时加载并渲染（它是"补充信息"，晚几百毫秒无所谓），配合上表"生成中"骨架。
- **(b)** 摘要改为宿主原生渲染（`/api/pages/:slug` 加 `summary` 字段）。
  首屏就有摘要、无额外 bundle，代价是把 AI UI 放回宿主，并让 `plugin-wiki` 认识"摘要"这个概念。

---

## 5. 改造 C：检索质量

按"收益/成本"排序，前三项建议一起做。

### 5.1 把"命中的那一段"喂给模型（修 §1.3）——**最高优先级**

现在 `SearchHit` 只有页级 `snippet`，没有块身份，所以 `selectSources` 只能从头累加。
最小改动：**让 `search()` 顺带回传命中块 id**。

```ts
export interface SearchHit {
  // …既有字段不变…
  /** ★ 新增：本次命中的块 id（按 rank 升序，最多前 N 个）；LIKE 路为空数组 */
  readonly matchedBlockIds?: readonly number[]
}
```

`selectSources` 改为**围绕命中块取上下文**：命中块 + 前后各若干块，
按 `perSourceChars` 预算向两侧扩张，**仍保证"绝不跨块截断"与"块级可见性"两条既有性质**。
`ContentView.blocks[].ordinal` 已有，块级定位不需要新的 SQL。

**验收基准（可复现）**：§1.3 那个 6437 字符的探针页 + 问句
「麒麟协议的握手超时时间是多少」⇒ **必须答出 42 秒**。这条今天必然失败。

### 5.2 摘要通道（需求 ③ 的兑现）

`retrieve()` 变成**三桶**：

```
候选 A：summary-service.search(principal, q, {limit})   ← 语义更宽、措辞无关，用于"找文章"
候选 B：search-service.search(principal, q, {mode:'terms', limit})  ← 字面精确，用于"找段落"
合并：slug 并集，A 的 slug 加权（它更可能"整篇相关"）
落地：search-service.contents(principal, mergedSlugs)   ← 正文唯一出口不变
```

**同时候选 A 的摘要文本也进 prompt**：每条的 `[n]` 前面先给一句"这篇讲什么"，
模型在长资料里定位答案的能力会明显改善。

### 5.3 词元 AND 分组 + 覆盖率重排

现在的 3-gram 全 OR 是"召回了但没排序"。两步改：

1. **同一连续片段的 gram 用 AND 分组，组间才 OR**（`buildTermQuery`/`matchExpr`）：
   `("检索增" AND "索增强") OR ("增强怎" AND "强怎么") OR …`。
   字面意义上就是"至少有某个 3 字窗口完整出现"，比"任意一个 gram 出现"精确得多，
   且**仍然只是加引号的字面量**——注入防护仍只有 `toFtsPhrase` 一处。
2. **应用层覆盖率重排**：对返回的至多 `limit` 页，算
   `coverage = 命中的查询 gram 数 / 查询 gram 总数`（`instr` 扫文本，代价可忽略），
   最终分 = `BM25取负 + λ·coverage + μ·标题命中`。
   ⇒ 精确率提升**不动 FTS 索引**，纯函数、可单测。

### 5.4 标题权重

`blocks_fts` 只索引了块文本，标题完全没参与打分。摘要索引（§4.2）把 `title` 作为
第三列并给 `bm25(summaries_fts, w_summary, w_keywords, w_title)` 加权，
**这是"按标题找文章"这条最常用路径的直接兑现**。

---

### 5.5 让 AI 自己检索（工具调用 / 智能体循环）——需求 ⑤⑥ 的兑现

**上游已实测支持工具调用**（本仓 `@geewiki/openai` adapter 目前不透传，须先扩 `@geewiki/llm`）：

- **非流式**：`tools` + `tool_choice:'auto'` → `choices[0].finish_reason:'tool_calls'`、
  `message.tool_calls:[{id,type:'function',function:{name,arguments}}]`、`content:null`，
  另带 `message.reasoning_content`（思考过程）。
- **流式**：按 OpenAI 规范给 tool_calls delta —— 首帧给 `id`/`name` 与**空** `arguments`，
  后续帧按 `index` 分片流式给出 `arguments` 片段（实测 `{"city": ` / `上海` / `"}`），
  末尾 `finish_reason:'tool_calls'`。

**契约缺口（三处都要扩，缺一不可）**：

| 位置 | 现状 | 缺什么 |
| --- | --- | --- |
| `LlmRequest`（`packages/plugin-llm/src/types.ts`） | 只有 `route`/`model`/`messages`/`maxTokens`/`temperature` | `tools` / `toolChoice` |
| `LlmMessage.role` | `'system' \| 'user' \| 'assistant'` | **没有 `'tool'`** ⇒ 工具结果无法回灌 |
| `LlmChunk` | `status` / `text-delta` / `done` / `error` | 没有工具调用变体（id/name/arguments 分片） |

**实测代价：同一隔离实例跑通一轮完整 agent loop**

脚本 `data/verify/ai-native-probe/agent-loop.mjs`，system 提示为「先判断用户想找什么，再用
`search_kb` 检索；措辞不匹配会返回空结果，换同义词/更通用的词重试，最多 5 次」。
问句「**怎么新建内容**」（真实索引上裸问 `total=0`）：

| 轮 | 工具调用（命中数） |
| --- | --- |
| 1 | 新建内容 0 ／ 如何创建内容 0 ／ 新建 内容 操作 步骤 0 |
| 2 | 新增内容 0 ／ 创建内容 0 ／ 新建文章 0 ／ 发布内容 0 ／ 内容管理 新建 0 |
| 3 | 新建文档 0 ／ 创建文档 步骤 0 ／ **知识库 新建 → 1（`getting-started`）** ／ 内容 新建 按钮 0 |
| 4 | **GeeWiki 新建 → 3（`home`/`operations/backup`/`getting-started`）**；Wiki 新建页面 → 3；新建页面 → 1（`home`）；创建页面 → 1（`home`）；内容类型 新建 0 |
| 5 | （无工具调用）最终答案：「在 GeeWiki 首页右上角点击「新建页面」即可新建内容；需要有编辑权限。」✅ |

**合计 15 次 `search_kb`、5 个 LLM 轮次。两条教训，都是设计输入**：

1. **靠反馈重试最终能找到，但代价是 15 次检索 + 5 次 LLM 往返**——延迟与配额都成倍。
   裸循环**不可直接上线**，必须有轮次上限与预算收敛。
2. **模型在没有语料词汇线索时只能盲猜**——第 2 轮连猜 5 次全空。真正让它上岸的，是第 3 轮
   **偶然**命中 `getting-started` 之后拿到的词汇反馈。⇒ **光有「重试自由」不够，得先把语料
   词汇放到它面前**，而摘要索引（§4.2）正是那个东西。

**反证：一次性查询改写不足以修召回**。单独让模型做「查询改写」（**无反馈**，一次输出
`{"queries":[...]}`），对「怎么新建内容」产出「新建内容 操作步骤 入口」「创建内容 发布
内容管理」「添加内容 撰写 编辑」——**三条在真实索引上全部 `total=0`**。
⇒ 纯改写 ≠ 修召回；要么有**结果反馈**，要么有**摘要/关键词索引**。

**设计结论（按优先级）**：

1. **先做 §5.2 摘要通道，再开工具调用**。摘要把语料词汇提前给模型，第一轮就大概率命中，
   工具循环只作兜底。顺序反过来，会得到一个「要检索 15 次才答对」的系统。
2. 工具集**只给一个 `search_kb(query, mode?)`**，且证据必须返回**「命中页 + 命中块文本」**
   （不是只回 slug）——这是把第 3 轮那种「词汇反馈」**提前到第 1 轮**的关键。
3. 循环上限建议 **3 轮 / 6 次检索**，与 §4.3 的生成预算共用；超限就用已有资料作答，
   并**如实标注**「检索了 N 轮未找到」，不得编造。
4. **需求 ⑥（判断是不是知识库问题）走「先理解」而不是「先检索」**：把 `retrieve()` 从
   「无条件跑」改成「判定分类 → 需要才检索」。分类复用**同一次调用**的 system 提示即可，
   不额外增加往返。`mode` 在 `rag`/`rag-partial`/`no-context` 之外加**第四档
   `out-of-scope`**：问题与知识库无关时直接回答，但**明确标注**「以下不是知识库内容」。
   ——这条与既有红线**不冲突**：红线是「不得**冒充**知识库答案」，不是「不得回答知识库
   之外的问题」。旧版把两者混为一谈，代价是连「你好」都要先跑一次检索。

---

## 6. 改造 D：多轮与会话

1. **`buildMessages(query, sources, history)`** —— 新增可选 history，
   切成 `LlmMessage[]` 插在 system 之后、当前 user 之前。
2. **预算必须一起算**：history 计入 `totalContextChars`（`src/budget.ts`），
   上限建议 `maxHistoryTurns: 6` / `maxHistoryChars: 4000`，**都进 `configSchema`**。
   超预算从**最旧**的一轮开始丢，不切半句。
3. **追问改写（retrieval query rewrite）**：有 history 时，先用一次**极小**的调用
   把「那第二点呢？」改写成自足查询再检索。这是多轮质量的关键一步。
   **必须可降级**：改写失败/超时（建议 5s）就用原问句检索，**绝不因为改写失败而拒答**。
4. **`history` 由宿主托管**（`onHistoryChange`），面板不自己存 hash —— 保持
   "路由是宿主的资产"这条既有边界。是否落 localStorage 由宿主决定（建议落，
   刷新不丢会话）。

---

## 7. 分期与验收

| 期 | 内容 | 解决 | 验收（可复现，非"看起来好了"） |
| --- | --- | --- | --- |
| **P1** | §5.1 命中块定位 | 答不准 | §1.3 探针页必须答出 42 秒；旧行为必须失败（红-绿） |
| **P2** | §3 契约 + 嵌合 + 页作用域 | 需求 ①② | `page/history/variant` 字段端到端；`#/wiki/<slug>` 上折叠入口可见；无贡献者时中性占位不变；镜像守卫测试全绿 |
| **P3** | §4 摘要插件 | 需求 ③④ | 保存一页 → ≤60s 内摘要落库并出现在页顶（折叠）；改正文 → 标"已过期"；无模型 → 卡片**不渲染**；`/api/admin/summaries/verify` 行数差为 0 |
| **P4** | §5.2–5.4 检索质量 | 需求 ③ 的效果 | §1.2 的「怎么新建内容」必须命中主页（今天 total=0）；覆盖率重排的排序用例 |
| **P5** | §6 多轮 | 追问 | 两轮对话的第二轮答对；改写失败时降级仍答；history 超预算按最旧丢 |
| **P6** | §5.5 工具调用 | 需求 ⑤⑥ | 扩 `@geewiki/llm` 的 tools/tool 角色/工具 chunk；`search_kb` 循环 ≤3 轮；「你好」不触发检索且标 `out-of-scope`；**同一问句「怎么新建内容」的检索次数从实测的 15 次降到 ≤3 次**（有摘要索引后重新计一次数，作为回归基准） |

**每期都必须配的测试**（本仓既有纪律，别漏）：
- 契约镜像守卫（`slotPropsMirror.test.ts`、`slots.test.ts`）随字段更新；
- 权限红线用例：匿名/无权限主体不得因摘要或页作用域拿到任何受限文本；
- 摘要索引同步的**源级守卫**（全仓仅一处 `INSERT INTO summaries_fts`）；
- **红-绿**：每条修复都要先证明旧行为失败。

---

## 8. 需要拍板的决策点

1. **摘要卡归属**：插件渲染（§4.5(a)，一致性好，但阅读页多一个 bundle）
   还是宿主原生（§4.5(b)，首屏即有，但把 AI UI 放回宿主）？**建议 (a)+懒加载**。
2. **受限段落的页**：按公开投影生成"偏浅摘要"并**如实标注**，还是干脆不生成？
   **建议前者 + 标注**。
3. **`scope` 缺省**：`auto`（本页+全库，回答更全但可能"答的不是这一页"）
   还是 `page`（更聚焦但可能答不出）？**建议 `auto` + 面板上的可见开关**。
4. **追问改写**是否值得多一次 LLM 往返？**建议做，但只在有 history 时**，
   且带硬超时与降级。
5. **§1.6 的 break-glass 读/检索不一致**：单开一条修复，还是并入本批？
   **建议单开** —— 它与本次改造无关，混在一起会让两边都难验收。
6. **工具调用要不要现在就扩 `@geewiki/llm`**：这是本次改造里**唯一一处要动公共契约**的
   （`LlmRequest` / `LlmMessage.role` / `LlmChunk` 三处），影响面比 §3 的插槽契约更靠底层。
   **建议排在 P6**——先用摘要索引把「第一轮就命中」做到，再看裸循环的 15 次检索还剩多少次；
   如果摘要索引把召回修好了（§5.2 + §5.3），工具调用可能根本不必要。
   **但需求 ⑥（判断是否知识库问题）不依赖工具调用**，它可以更早、更便宜地在 P2 就做掉。
7. **`out-of-scope` 的回答边界**：允许模型用先验知识回答知识库之外的问题（并明确标注），
   还是仍然一律「请去问别的工具」？前者对用户有用，风险是标注一旦被忽略就等于放宽了红线。
   **建议前者 + 前端强制显示醒目标注**（不是一行小字）。
