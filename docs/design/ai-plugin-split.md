# AI 能力拆分：辅助写作 / 问答 两个插件 + 前端由插件插入

> 状态：**实施中**（本文件是这批的实施契约，插件/插槽/端点的口径以此为准）。
> 触发原因：用户反馈「当前的 AI 辅助功能很不好用」，追问后发现是**命名与形态同时错位**——
> 显示名叫「智能问答」的插件（`@geewiki/ai`）里，真正好用的只有 `/api/ai/assist`（辅助写作），
> 而「问答」那一半是**没有模型也能出答案**的检索式摘要冒充（`mode:'retrieval-only'` + 抽取式摘要），
> 且界面全部长在 `packages/web` 里，插件一个前端都没插。

## 1. 三条错位（本批要消除的）

| 错位 | 现场 | 后果 |
| --- | --- | --- |
| 名字对不上实现 | `packages/plugin-ai/src/index.ts:178` `displayName: '智能问答'`，但「问答」的 answer 是 `extractiveSummary()`（`extract.ts`）拼出来的抽取式摘要 | 管理台/侧栏写着「问答」，用户拿到的是带 `<mark>` 的检索片段拼接；`@geewiki/ai` 这个名字也盖住了「辅助写作」这个真实能力 |
| 「没有 key 也完整可用」的产品承诺 | `types.ts` 文件头：「绝不用 4xx/5xx 表达没有配置模型」 | 问答在没有模型时**仍返回一个看起来像答案的东西**，这是"不好用"的第一来源：宁可不出，也不能冒充 |
| 前端不在插件里 | `AskPanel.tsx`(409) / `ai/AssistToolbar.tsx`(217) / `lib/aiStreamPlan.ts`(322) / `lib/assistPlan.ts`(141) 全在 `packages/web`；插件清单**没有** `geewiki.client` / `geewiki.slots`（实测 `GET /api/plugins/ui` 把 `@geewiki/ai` 记为 `skipped: no_client`） | 插件停用后 web 里的 AI 界面与文案还在；「插件化」在 AI 这条线上是假的 |

## 2. 决策（已与用户确认）

1. **改名 + 拆分**：`@geewiki/ai` → **`@geewiki/ai-assist`**（`displayName: 'AI 辅助写作'`，只保留 `/api/ai/assist` 与编辑器工具条）；**新建 `@geewiki/ai-qa`**（`displayName: 'AI 问答'`）承接问答。
2. **问答彻底重写为模型问答**：检索 → 带引用编号的回答 → 流式。**删除抽取式降级路径**（`extract.ts` 及其用例），旧承诺「没有 key 也完整可用」在问答这条线上**主动放弃**：没有模型 = 明确不可用，绝不用检索摘要冒充答案。
3. **前端由插件插入**：新增两个插槽 **`editor-toolbar`**（多占用）与 **`wiki-ask`**（单占用），两套 AI 界面变成插件自带 bundle；`web` 里的 `AskPanel.tsx` / `AssistToolbar.tsx` 删除。宿主保留 `#/wiki/ask/<q>` 路由（路由表是宿主资产）。

## 3. 目标形态

| 插件 | displayName | 目录 | provides | 路由 | 插槽 |
| --- | --- | --- | --- | --- | --- |
| `@geewiki/ai-assist` | AI 辅助写作 | `packages/plugin-ai-assist` | `ai-assist-service` | `POST /api/ai/assist`、`GET /api/ai/assist/capabilities` | `editor-toolbar` |
| `@geewiki/ai-qa` | AI 问答 | `packages/plugin-ai-qa` | `ai-qa-service` | `POST/GET /api/ai/ask`、`POST /api/ai/stream`、`GET /api/ai/capabilities` | `wiki-ask` |

- 两个插件各自拥有自己的 `capabilities` 探测端点——**界面只问自己所属的插件**，不再跨插件猜「模型有没有」。
- 服务 token 一并改名（`ai-service` 目前**零外部消费方**，改名是仓库内部事务）。
- 默认基础层清单 `config/plugins.base.json` 用两条新插件替换原 `@geewiki/ai`（仍默认启用；没配密钥时问答显式不可用，辅助写作同理）。

## 4. 契约

### 4.1 问答（`@geewiki/ai-qa`，重写）

```
POST /api/ai/ask        body {q, limit?}      GET /api/ai/ask?q=&limit=
200 {ok:true, mode:'rag'|'rag-partial'|'no-context', query, answer:string|null,
     sources:[{n,slug,title,snippet,score,updated_at,used}], retrieval:{mode,total,limit},
     usage, elapsedMs, degraded, partial}
400 empty_query | too_long(>500) | invalid_limit | invalid_body(未知字段)
401 unauthorized（无主体——RAG 的正文入口必须带主体）
503 {ok:false, error:'model_unavailable', degraded}      ← 生成前判定：没有可用模型路由（**不跑检索**，省一次上游）
503 {ok:false, error:'search_unavailable', degraded}     ← 检索服务缺失/抛错：没有检索就没有问答
502 {ok:false, error:'generation_failed', degraded}      ← 调用了模型但一个 token 都没出来
```

- `mode` 只剩三档，语义诚实：`rag` = 模型真的生成了；`rag-partial` = 生成了半截（带 `partial:true` + `degraded`）；`no-context` = 检索 0 命中（`answer:null`，**不**为了"看起来有答案"而让模型无资料硬答）。
- `sources[].n` 只对 `used:true` 者从 1 连续编号，与 prompt 里的 `[n]` 严格一致；回答按 `[n]` 标注引用（system prompt 强制 + 「资料不足要明说」）。
- 删除 `answerFormat`（恒 markdown）、`extractive` 请求字段与配置项、`mode:'retrieval-only'`。
- `GET /api/ai/capabilities`：`{ok, available, degraded, providers[], message}`，`available` = 有可用模型路由 **且** 检索服务在位。

### 4.2 流式（`POST /api/ai/stream`）

事件名不变（`status` / `delta` / `done` / `error`，`sse.ts`）。改动：**所有前置判定一律在写 SSE 头之前以普通 JSON 返回**（401/400/429/503），流内只表达"已经开始生成之后"的事：`status`(retrieval+sources) → `delta`(text) → `done`(mode/usage/partial) 或 `error`。`no-context` 不发 `error`（不是错误），走 `status` + `done{mode:'no-context', answer:null}`。并发上限 4、硬超时 120s / idle 30s、常量不进 `configSchema`（测试专用注入口保留）——均沿用现状。

### 4.3 辅助写作（`@geewiki/ai-assist`）

`POST /api/ai/assist` 与其响应体（`mode:'generated'|'unavailable'` + `text:null` + `degraded`）**逐字段不变**；新增 `GET /api/ai/assist/capabilities`（只回答一件事：有没有能写作的模型）。配置项：`ASSIST_TEXT_MAX=4000` / 四个动作的 token 上限仍是代码常量（不进 schema）。

### 4.4 新插槽（`packages/core/src/index.ts` 权威 + `web/src/lib/slots.tsx` 镜像，两端有守卫测试）

```ts
export type SlotName = 'app-header' | 'app-footer' | 'editor' | 'editor-toolbar' | 'wiki-ask'
// 基数：app-header/app-footer/editor-toolbar = multi；editor/wiki-ask = single

export interface EditorToolbarSlotProps {
  readonly mode: 'create' | 'edit'
  readonly slug: string
  readonly docText: string                      // 全文（续写需要光标前的上下文）
  readonly selection: { readonly text: string; readonly from: number; readonly to: number } | null
  readonly readOnly?: boolean                   // 宿主 saving=true 时为 true
  /** 内置编辑器在场时 true；被插件编辑器占住 editor 插槽时 false（写回通道不存在） */
  readonly canInsert: boolean
  insertAtCursor(text: string): void
  replaceSelection(text: string): void
}

export interface WikiAskSlotProps {
  readonly query: string                        // 来自 #/wiki/ask/<q>
  onAsk(query: string): void                    // 改问题 → 宿主更新 hash 路由（路由真源在宿主）
  openPage(slug: string): void                  // 来源跳转同上
}
```

- 新字段一律**可选或带默认语义**：`editorSlotProps.test.ts` 逐字段比对两端，字段名/可选性/readonly 不一致即红。
- `wiki-ask` 单占用：两个问答类插件同时启用时按"最早激活优先"裁决（与 `editor` 同规则），冲突在 `GET /api/plugins/slots` 与管理台可见。
- 宿主侧新增 `host.markdownToHtml(md): string`（宿主 SDK；**落地时命名为 `renderMarkdown`**，SDK 版本 `0.1.0` → `0.2.0`，以 `packages/web/src/lib/hostSdk.ts` 为准）：问答答案是模型产出的 markdown，**消毒必须留在宿主一处**（`lib/sanitize` 的白名单 + DOMPurify 是唯一实现），插件只 `dangerouslySetInnerHTML`。未消毒的字符串不得入 DOM。
- 懒加载：`isLazyOnlyEntry` 从「slots 全为 editor」推广为「slots ⊆ `{editor, editor-toolbar, wiki-ask}`」，宿主在编辑页/问答页挂载时 `ensureSlotLoaded(...)`。⇒ **读页面首屏不加载任何 AI bundle**。

### 4.5 前端产物归属

- **UI 源码归插件所有**：`packages/plugin-ai-assist/ui/index.tsx`、`packages/plugin-ai-qa/ui/{index.tsx,style.css,…}`。
- **构建仍由 `@geewiki/web` 编排**（`build:plugin-ui`，复用 `fixtures/vite.config.ts` 的 lib 模式配方：`formats:['es']`、`fileName: client.js`、`cssFileName: client`、react/jsx-runtime external、`publicDir:false`、`define NODE_ENV`），产物落 `packages/web/public/plugins-ui/<插件名>/`（内置插件的资产根②；dev 由 `GEEWIKI_PLUGIN_UI_DIST` 指向 public）。
  - 为什么不放 `<插件目录>/dist`：`RegisteredPlugin.dir` **只对外部插件存在**（`manager/src/deps.ts:32`「内置插件无此字段」），内置插件拿不到自带资产根①。
  - 为什么不在插件包内另起 vite：需要给包加 vite/react devDeps（新依赖 + 安装面），而产物根①对内置插件本来就不生效。
- **类型仍靠镜像 + 守卫测试**（浏览器侧不能 import `@geewiki/core`/插件服务端包：core 顶层 `import 'node:fs'`）。这是本仓库既有文化（`api.ts` 的 `DegradedReason`、`assistPlan.ts` 的 `ASSIST_TEXT_LIMIT`、`searchPlan.ts` 的 `MAX_QUERY_LENGTH` 都是镜像 + 守卫），插件 bundle 侧同理，守卫测试放在**插件包的 test 目录**里读两侧源码比对。
- 禁止：给入口 URL 加 `?v=`（Vite dev 会 500）；同 URL 换字节需整页刷新（ESM 模块缓存）。

## 5. 影响面清单（改这些，别漏）

- **注册表**：`packages/server/src/index.ts`（import + `defaultRegistry()` 条目，一分为二）、`packages/server/package.json` 依赖、`config/plugins.base.json`。
- **web 删除**：`components/AskPanel.tsx`、`components/ai/AssistToolbar.tsx`、`lib/aiStreamPlan.ts`、`lib/assistPlan.ts`、`api.ts` 的 `aiAsk`/`aiCapabilities`/`aiAssist`/`aiAskStream` 及 AI 类型、`styles.css` 的 `.ask-*`（与 `.search-*` 有合并选择器，需拆开）、`WikiPage.tsx` 的问答页渲染（367-381）/`WikiList` 的问答按钮与 `stateOf('@geewiki/ai')` 硬编码（725）/编辑页 `AssistToolbar` 挂载（2945）与探针（2350）。
- **web 新增**：`lib/slots.tsx` 两个插槽 + 两个 outlet + `hostSdk` 的 `markdownToHtml`（**落地名 `renderMarkdown`**）；`WikiPage` 渲染 outlet；问答入口按钮的显隐改为「`wiki-ask` 插槽有贡献者」而非硬编码插件名。
- **共享词汇 `Degraded`/`DegradedReason`/`degradedFromCode`/`makeDegraded` 上移到 `@geewiki/llm`**（它已拥有 `LlmErrorCode` 与 `redact`，两个插件都依赖它），避免映射表在两个插件里各抄一份。`web/test/degradedReason.test.ts` 的源路径常量随之更新。
- **守卫测试**：`web/test/askPanel.test.ts`、`assistPlan.test.ts`、`aiStreamPlan.test.ts` 随文件删除/迁移；`plugin-ai/test/queryLengthGuard.test.ts` 迁到 `plugin-ai-qa`；`manager/test/slots.test.ts` 的 `SLOT_NAMES` 字面量镜像随之更新。
- **验收脚本**：`data/verify/openai-e2e/run.mjs`（按名启用插件 + 断言）、`data/verify/search-e2e/cdp-degraded.mjs`（`.ask-card` 类名随 UI 迁移）。`data/verify/**/result.json` 是**历史快照**，不改写。
- **文档**：`README.md` 的 AI 段落（第 7/11/19/21/22/25/78/79/89/105/148/203/208/209/211/225/247/266/288 行附近）——「没有 key 也完整可用」这条承诺在问答侧**必须改写**；`docs/architecture.md` 的插件表与服务注册表；`docs/plugin-platform-plan.md` 插槽白名单；`docs/design/access-control.md` §5.7；`docs/roadmap.md`。

## 6. 验证

1. `pnpm typecheck`（15 个包）+ `pnpm -r --no-bail --if-present run test` 全绿。
2. `pnpm --filter @geewiki/web build:plugin-ui && pnpm --filter @geewiki/web build` 产物存在，`GET /api/plugins/ui` 里两个插件带 `slots` 字段且 `rev` 非空。
3. **真实模型链路**（本机 `config/secrets.json` 已配 `@geewiki/llm.apiKey`，`GET /api/ai/capabilities` 实测 `available:true`，模型 `DeepSeek V4 Flash`）：`POST /api/ai/ask` 返回 `mode:'rag'` + 非空 `answer` + `sources[].n` 与 `[n]` 引用一致；`POST /api/ai/stream` 逐帧出 `delta`。README 里「本批未做真实模型链路验证」这条限制因此可以摘除（问答侧）。
4. 停用 `@geewiki/ai-qa` ⇒ 问答入口消失、`#/wiki/ask/x` 显示宿主的中性占位（不出现任何 AI 文案/插件名）；停用 `@geewiki/ai-assist` ⇒ 编辑页工具条消失。两者都**不需要重建 web**。
5. 读页面首屏零 AI bundle 请求（懒加载），编辑页/问答页才加载。

## 7. 落地补充（实现期对本设计的五处改写，均已实测）

实现时本设计的口径有五处被证伪或不够用。**保留上方原文**（它是决策时的真实状态），
以下按"改了什么 / 为什么 / 证据"记录，后续读者以本节为最终口径。

1. **`model_unavailable` 的状态码从 502 改为 503**（`@geewiki/ai-qa` 与 `@geewiki/ai-assist` 同步）。
   原设计把"没有可用模型"与"模型调用失败"都记作 502，于是**两件相反的事在界面与监控里长成同一个样子**：
   没配密钥该去「模型接入」填配置，上游 429/超时该等一会儿。现在固定为
   **503 = 前置条件不满足（根本没调用模型）**、**502 = 上游真的失败（调用了它）**。
   证据：`scripts/acceptance/ai-split-e2e/run.mjs` 阶段 A（无凭据）→ `A_ask.status=503`、`A_stream.status=503`
   且 `isEventStream=false`、`A_assist.status=503`；阶段 B（限流）→ `B_ask429.status=502` + `RATE_LIMIT`。

2. **"上游正常结束但零字符"必须算失败**，两个插件一致。
   `llm-service` 的契约只保证终止帧恰一次，**不保证** `done` 时有内容。照单返回 200 会让界面显示
   一个空的"生成结果"，用户读到的是"模型就是这么写的"。现在两处都判 `text === ''` ⇒ 502 +
   `PROVIDER_ERROR`。判据用文本而不是 `usage.completionTokens`（用量字段可选，关掉 `includeUsage` 就没有）。
   证据：`B_askEmpty={"status":502,"error":"generation_failed","degradedCode":"PROVIDER_ERROR"}`；
   单测 `packages/plugin-ai-assist/test/assist.test.ts`「上游正常结束但一个字符都没给」。

3. **上游失败的降级文案不再罗列路由清单**。
   实现第一版把 `已注册 N 个路由但均不可用：…` 拼进了所有失败路径，于是 429 被说成"没有可用路由"——
   用户照着去查配置，而正确动作是等一会儿。现在只有 `NO_ADAPTER` 说路由清单，其余说
   "请求已发往模型服务，是它拒绝了或没能及时返回"。路由 label 也只在 `NO_ADAPTER` 分支进入文案
   （它曾是一条真实的外泄面：label 里带疑似密钥时会进入响应，见 `plugin-ai-qa/test/stream.test.ts` 的脱敏守卫）。

4. **"有没有问答界面"必须按**入口表的声明 + 仲裁**判，不能按"已注册的组件"判**——否则自锁。
   `wiki-ask` 是懒加载插槽，组件只在进入问答视图后才加载，而入口按钮要在进入**之前**出现；
   用已加载组件判等于"按钮永远不出现，除非按钮已经出现过"（实测第一版就是这样：列表页的
   "AI 问答"入口恒不渲染）。新增 `pluginUiDeclaredFor(slot)` + `useWikiAskSlotState()`
   （三源合一：`entry` / `failures` / `declared`），宿主据此在**面板 / 载入中 / 加载失败 / 没有功能**
   四种界面之间选一个。入口表 `slots` 字段是后端裁决后的**生效集**，所以它恰好回答"点进去之后真的有人渲染"。

5. **`web/test/degradedReason.test.ts` 被删除**（原 §5 计划是"更新其路径常量"）。
   它守的是"宿主手抄一份 `DegradedReason` 镜像 + `REASON_NOTICE` 文案"，而本批之后宿主侧
   **一个 AI 字段都不消费**（`api.ts` 的 AI 类型与 `searchPlan.ts` 的降级文案一并删除）。
   镜像守卫随之移到真正的消费方：`@geewiki/llm`（`CODE_TO_REASON` 对 `LlmErrorCode` 的总数覆盖 +
   `search_unavailable` 被钉在 `DegradedReason` **之外**）与 `@geewiki/ai-qa` 的界面侧守卫。
   留下的判据是：**谁消费，谁守镜像**。

附带一条流程事实，值得记下来免得下次再猜：管理台保存配置走
`PUT /api/plugins/:name/config`，它是**整份替换**语义 —— 只发 `{apiKey}` 会把 `baseUrl`/`model`
抹成 schema 默认值（实测后果是适配器回落到自己的默认端点 ⇒ `NETWORK`）。管理台表单能"只发改动项"
是因为它总是先读回现值再整份提交。

## 8. 验证执行结果（本批实测，含"哪一条是用什么验的"）

两份脚本都起**隔离实例**（独立 config / data / 端口）+ 一个**确定性假 OpenAI 兼容上游**
（`mock-upstream.mjs`，三模式 `ok|429|empty`）。用假上游是为了**读数可复现**——真实厂商的
token 数、限速与拒答每次都不同，而这些差异正是本批要断言的东西（429 必须是 502、空产出必须是
502、`[1]` 必须与 `sources[].n` 一致）。

| §6 条目 | 状态 | 读数与取证方式 |
| --- | --- | --- |
| 1 typecheck + 全量测试 | ✅ | `pnpm typecheck` Exit 0（`Scope: 18 of 19 workspace projects`，0 个 `error TS`）；`pnpm -r --no-bail --if-present run test` **1397/1397**（14 个包）。逐包读数见 `README.md` 的 `pnpm test` 行 |
| 2 产物与入口表 | ✅ | `GET /api/plugins/ui` 的 `plugins` 恰两键：`@geewiki/ai-assist: ["editor-toolbar"]`、`@geewiki/ai-qa: ["wiki-ask"]`，`rev` 非空；`GET /api/plugins/slots` ⇒ `editor-toolbar:multi effective=["@geewiki/ai-assist"]`、`wiki-ask:single effective=["@geewiki/ai-qa"]`；`/plugins-ui/@geewiki/ai-qa/client.js` 返回 200 且 `text/javascript` |
| 3 模型链路（rag / 429 / 空产出 / 0 命中） | ✅ **对假上游** | `result-backend.json`：`A_ask=503 model_unavailable` + **上游调用数 0** + `A_stream` 非 event-stream；`B_ask=200 mode=rag` 且答案逐字等于上游文本、`usage{132,39}`、`retrieval{fts,1,8}`；`B_prompt` 七项形状全真；`B_ask429=502 generation_failed/RATE_LIMIT`；`B_askEmpty=502 PROVIDER_ERROR`；`B_askNoContext=200 no-context` 且**模型未被调用**；`B_stream` 帧序列 `status→delta×3→done` |
| 3′ **真实厂商端点** | ❌ **本批未做** | 上面那一行的"模型链路"是**确定性假上游**，不是真实厂商。真凭据下的行为与假上游一致属合理外推，但**没有实测过**，故 `README.md` 已知限制 ⑥ 保留"仍未核实项只剩接真实厂商"。（前一批曾在辅助写作侧真实生成过一次，见 `README.md`「本批实测范围」；本批未重复消耗真实凭据。） |
| 4 停用不需重建 web | ✅ 但**路径与预期不同** | 内置插件在基础层清单里 ⇒ `POST /api/plugins/%40geewiki%2Fai-qa/disable` 返回 **409 `base_layer`「请编辑 plugins.base.json 后重启进程」**（会话层才是热层）。于是断言改成**改清单 + 重启进程**，并比对产物指纹：`packages/web/dist/index.html` 与两个插件 bundle 的 SHA-256 前 12 位**逐字节不变**，同时 `GET /api/plugins/ui` 少掉该键、界面出现宿主中性提示「当前没有启用提供问答界面的插件…」（不点名插件） |
| 5 懒加载零请求 | ✅ | `result-ui.json` 19 条全过，其中 1b 断言"入口已出现时 `Network` 里 `plugins-ui/` 请求数为 **0**"，2c 断言 bundle 是**进入问答视图之后**才被请求的 |

浏览器侧（`cdp-ui.mjs`，真 Chrome + CDP，无 Playwright）覆盖的是"界面到底是谁画的"这类只有真渲染
才能证的事：入口按**声明**可见（1a）、懒加载不自锁（1b/2c）、`.ask-card` 在 `[data-slot="wiki-ask"]`
内且面板 CSS 独立加载（2a/2b）、回答经宿主 `renderMarkdown` 渲染成块级元素（3b）、点参考资料由
**宿主**导航（3c，`location.hash` 从 `#/wiki/ask/…` 变成 `#/wiki/ui-e2e`）、编辑页工具条由插件渲染且
写回按钮经宿主回调写进 CodeMirror（4a–4d）、全程 0 条 console error。踩过的七条坑记在
`scripts/acceptance/ai-split-e2e/README.md`。
