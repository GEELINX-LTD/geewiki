# `ai-split-e2e`：AI 拆分为「AI 辅助写作」+「AI 问答」的端到端验收

> ## ⚠️ 历史验收留痕——当前不可运行
>
> **本目录是历史留痕，不是可回归的资产。** 它验收的是**已被 P8 拆除**的形态：`@geewiki/ai` 单体一分为二为 `@geewiki/ai-assist`（贡献 `editor-toolbar`）与 **`@geewiki/ai-qa`**（贡献 **`wiki-ask`**）。这两个包、`wiki-ask` 插槽与 `#/wiki/ask/<q>` 子路由现均已整包 / 整体删除（P8 决策 22 / 决策 17）；AI 能力现由 `@geewiki/ai-assistant` 等插件提供，对话入口是 `app-dock` 插槽，端点为 `/api/ai/turn`。
>
> **脚本可用性判断（按当前源码 grep 核对，结论：当前不可运行，保留为决策与坑的记录）**：
> - `run.mjs` —— **不可运行**。仍直接调用已删除的端点：`GET /api/ai/capabilities`、`POST /api/ai/ask`、`POST /api/ai/stream`、`POST /api/ai/assist`（现均 404），并以 `@geewiki/ai-qa` / `@geewiki/ai-assist` 作为启停对象。
> - `cdp-ui.mjs` —— **不可运行**。断言 `[data-slot="wiki-ask"]` 内的 `.ask-card`，并请求 `plugins-ui/@geewiki/ai-qa/client.js` / `@geewiki/ai-assist/client.js`（产物已不再生成）。
> - `mock-upstream.mjs` —— **本身仍可用**：它是通用的假 OpenAI 兼容上游（`POST /v1/chat/completions`，SSE 分帧，`ok`/`429`/`empty` 三模式），与已删除对象无耦合。
>
> 保留它们的价值在于**记录当时的判据与踩过的坑**（隔离手法、端口变量名必须是 `GEEWIKI_PORT`、实例根必须放 `instance/` 子目录、`PUT .../config` 是整份替换语义），**不要当作当前验收使用**。下文提到的源级守卫路径 `packages/plugin-ai-assist/test/assist.test.ts` 也已随包删除。
>
> **位置与状态更正（与下文若干旧口径段落冲突，以本条为准）**：本目录实际位于 `scripts/acceptance/ai-split-e2e/`，**四个文件都已入库**（`git ls-files` 可见）；下文提到的两份读数快照 `result-backend.json` / `result-ui.json` **并不存在于本目录**，也不在版本库里。下文凡自称"本目录在 `data/verify/`"或"本目录整体不在版本库"的段落，都是写作当时的旧口径。

**本批**（2026-09-14）把 `@geewiki/ai` 一分为二 —— `@geewiki/ai-assist`（贡献 `editor-toolbar`）与 `@geewiki/ai-qa`（贡献 `wiki-ask`），并把两套 AI 前端从 `packages/web` 迁进插件自带 bundle。本目录的两个脚本验的就是这件事在**真实进程**里成立：后端契约（状态码 / SSE 帧 / 提示词 / 密钥安全）与浏览器侧（插槽里真的是插件的 DOM、宿主一个 AI 节点都不产）。

设计契约现指向 [`docs/design/ai-plugin-architecture.md`](../../../docs/design/ai-plugin-architecture.md)（该文档保留，是 AI 能力架构的权威记录；下文写作时引用的 `docs/design/ai-plugin-split.md` 已删除，其 §7「落地补充」等小节亦随之消失）。

> **位置为什么在 `scripts/acceptance/` 而不是 `data/verify/`**：本仓库的约定是——**可复跑的验收脚本入库**（与 `scripts/acceptance/plugin-ui-cdp.mjs` 同等待遇），**跑出来的残留不入库**（`data/` 已被 `.gitignore` 排除）。因此：脚本与本 README 在版本库里；实例目录 `instance/`、Chrome profile、以及两份读数快照（`data/verify/ai-split-e2e/result-backend.json`、`result-ui.json`）**不在**。读数被 `README.md` 与 `docs/` 引用时按"某次实测的留痕"理解，不当作可回归的资产；**要回归请重跑脚本**（确定性假上游 ⇒ 读数应逐字段复现，不复现即是缺陷）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `run.mjs` | **后端契约**：无浏览器，`node scripts/acceptance/ai-split-e2e/run.mjs` 一条命令跑完三个阶段并把 JSON 打到 stdout。端口固定 `3433`（实例）/ `3457`（mock 上游） |
| `cdp-ui.mjs` | **浏览器侧**：零依赖 CDP（Node 内置 WebSocket 直连 Chromium）驱动真实页面，逐条 `check(...)`，退出码 0 = 全绿。端口经环境变量可换（见下） |
| `mock-upstream.mjs` | **两个脚本共用的假 OpenAI 兼容上游**（`POST /v1/chat/completions`，SSE 分帧；`ok` / `429` / `empty` 三模式经 `GET /__mode?m=…` 切换，`state.requests` 记录每次请求体）。`run.mjs` 与 `cdp-ui.mjs` 都 `import` 它——曾经 `run.mjs` 内联过一份等价实现（"改一处要改两处"），已合并为单一真源：两份夹具会漂移，而漂移后的失败根本分不清是被测方还是夹具的问题 |
| `result-backend.json` | `run.mjs` 的**定版读数**（本批最后一次跑的 stdout 副本；重跑请看 stdout 或另存新名，不要就地覆盖） |
| `result-ui.json` | `cdp-ui.mjs` 的**定版读数**（19 条 checks + notes；同上） |

> 为什么用 mock 而不是真密钥：本批要钉的是**边界行为**——缺模型、上游限流、"上游正常结束但一个 token 都没给"。真实上游给不给 429 是不可控的，用真模型跑验收只会得到"今天通了明天红"的抖动读数。**本目录从未调用真实厂商端点**：原 `docs/design/ai-plugin-split.md` §8 明确记着"真实厂商"这一条本批**未实测**（该文档已删除，权威记录现见 [`docs/design/ai-plugin-architecture.md`](../../../docs/design/ai-plugin-architecture.md)），这里验的是"我们这一侧的契约与状态机"，不是厂商行为。

## 前置与用法

```bash
# 1) 两个插件的前端产物必须先构建（cdp-ui.mjs 会核对它们的 sha 指纹，但不会代你构建）
pnpm --filter @geewiki/web build:plugin-ui     # → packages/web/public/plugins-ui/@geewiki/{ai-assist,ai-qa}/client.{js,css}
pnpm --filter @geewiki/web build               # app shell（cdp-ui.mjs 的 index.html 指纹也取这里）

# 2) 后端契约（读数打到 stdout；仓库里的 result-*.json 是本批定版读数，重跑别就地覆盖）
node scripts/acceptance/ai-split-e2e/run.mjs

# 3) 浏览器侧（需要本机 Chrome/Chromium；没有 /usr/bin/chromium 就显式指定，例如：）
CHROME=/usr/bin/google-chrome node scripts/acceptance/ai-split-e2e/cdp-ui.mjs
```

`cdp-ui.mjs` 的可调项：`AI_SPLIT_UI_PORT`（默认 `3435`）、`AI_SPLIT_UI_CDP_PORT`（`9540`）、`AI_SPLIT_UI_MOCK_PORT`（`3467`）、`CHROME`（`/usr/bin/chromium`）。两个脚本都**不接入 `pnpm test`**——它们要真实进程、真实端口、（UI 侧）真实浏览器，与"无浏览器无网络的单测"刻意分层。

**隔离手法**（与 `data/verify/openai-e2e/` 同一套）：独立 `GEEWIKI_CONFIG_DIR` / `GEEWIKI_DATA_DIR` / `GEEWIKI_PLUGINS_DIR`，`GEEWIKI_PLUGIN_UI_DIST` 指向 `packages/web/public`，`GEEWIKI_ADMIN_TOKEN` 走应急通道头做管理动作、内容动作走会话 cookie。**三个细节踩过坑，别再改**：① `run.mjs` 的实例根必须放 **`instance/` 子目录**（用脚本自身目录的话，收尾清理会连带删掉脚本本身）——`cdp-ui.mjs` 用的是系统临时目录（`mkdtemp`），不存在这个坑；② 端口变量名是 **`GEEWIKI_PORT`**（不是 `PORT`）——写错的后果不是"端口不对"，而是实例静默起在默认端口上、后续断言全部对着错的进程（`cdp-ui.mjs` 的注释原文如此）；③ **上面那两条 `>` 重定向会覆盖两份快照**——想保留本批的历史读数，请把输出重定向到别的文件名。

## 阶段 A —— 没有模型（本批改动的核心）

清单刻意**只注册路由、不配凭据**（`@geewiki/llm.config.apiKey: ''`），基础层**必须带 `auth` / `org` / `authz`**（少了 `authz` 就没有 `policy-service`，辅助写作会按设计失败关闭 403——那是正确行为，但不是这条线要测的东西）。实测（`result-backend.json`）：

| 断言 | 实测 |
| --- | --- |
| 两个 `capabilities` 都是 **200 + `available:false` + `degraded:true`** | `A_capsQa` / `A_capsAssist` 各列出两条路由（`null` 恒不可用占位 + `openai` 未配凭据 ⇒ `available:false`） |
| 问答非流式 ⇒ **503 `model_unavailable`**，且响应体**不含 `answer` 字段** | `A_ask = {status:503, error:"model_unavailable", hasAnswerField:false, messageLeaksKey:false}` |
| 问答流式 ⇒ **503 且是普通 JSON**（`content-type: application/json`、`isEventStream:false`、`frames:null`） | `A_stream`。**绝不允许**先写 SSE 头再用事件表达"根本没开始" |
| 辅助写作 ⇒ **503 + `mode:'unavailable'` + `text:null`** | `A_assist`（不用任何文本兜底） |
| **一次上游调用都没有** | `A_mockCalls = 0`（旧形态会先白跑一次检索再拼摘要） |

## 阶段 B —— 补上密钥之后

密钥经 `PUT /api/plugins/@geewiki/llm/config` 那**同一个**管理台端点现补（与用户在「模型接入」里填密钥同一路径，落进隔离目录的 `secrets.json`）。⚠️ 该端点是**整份替换**语义：只发 `{apiKey}` 会把 `baseUrl` / `model` 抹成 schema 默认值 ⇒ 适配器回落到自己的默认端点 ⇒ `NETWORK`。脚本因此整份提交。

| 场景 | mock 模式 | 实测 |
| --- | --- | --- |
| 正常问答 | `ok` | `200 mode:'rag'` + 非空 `answer`（就是 mock 给的模型文本）+ `usage {132, 39}` + `retrieval {mode:'fts', total:1, limit:8}` + `sources ["n=1 rag-e2e used=true"]` |
| 提示词形状 | `ok` | `B_prompt` 全真：`stream:true`、含引用规则、**含"不许编造"与"资料不足要明说"**、用户消息含资料标记 / slug / 编号 `[n]` |
| 上游限流 | `429` | **502 `generation_failed`** + `degraded.code RATE_LIMIT` / `reason rate_limit`，无 `answer` 字段，`messageLeaksKey:false` |
| 上游"成功"但零 token | `empty` | **502 `generation_failed` + `PROVIDER_ERROR`** —— 这条是本批新增的判据：**HTTP 200 不等于生成成功**，照单返回 200 会让界面显示一个空的"生成结果"，用户读到的是"模型就是这么写的" |
| 检索 0 命中 | 任意 | **200 `mode:'no-context'` + `answer:null` + `modelCalled:false`**（不为"看起来有答案"而让模型无资料硬答） |
| SSE 正常 | `ok` | `200 text/event-stream`，帧序列 `status → delta×3 → done`，`terminalCount:1` 且 `terminalIsLast:true`，`doneMode:'rag'` |
| SSE 无资料 | —— | 帧序列只有 `status(mode:'no-context') → done(answer:null)`，**不发 `error`**（不是错误），`modelCalled:false` |
| SSE 中途上游失败 | `429` | 帧序列 `status → error`，`error` 帧 `code:RATE_LIMIT` + 文案说"请求已发往模型服务"（**不说成"没有可用路由"**） |
| SSE 前置判定 | —— | 空 `q` 与未知字段都以 **400 普通 JSON** 返回（`frames:null`），不写 SSE 头 |
| 辅助写作正常 | `ok` | `200 mode:'generated' action:'continue'`，文本确为模型产物 |
| 辅助写作校验 | —— | `polish` 缺 `selection` ⇒ **400 `invalid_body`**；`before` 超 4000 字符 ⇒ **400 `payload_too_large`**，消息逐字为 `before 超过上限（4000 字符）`（`ASSIST_TEXT_MAX`） |
| 密钥安全 | —— | `llmConfigEcho.apiKeyEchoed:false`（配置回读不含密钥）、`keyLeakedInLogs:false`（进程日志不含密钥） |

## 阶段 C —— 入口表与插槽仲裁

| 实测 | 值 |
| --- | --- |
| `GET /api/plugins/ui` 的 AI 两条 | `@geewiki/ai-assist {entry:'client.js', slots:['editor-toolbar']}`、`@geewiki/ai-qa {entry:'client.js', slots:['wiki-ask']}`，`rev` 均非空；`skipped` 里**没有** AI 插件（旧的 `no_client` 状态已消失） |
| `GET /api/plugins/slots` 的裁决 | `editor-toolbar:multi:effective=["@geewiki/ai-assist"]`、`wiki-ask:single:effective=["@geewiki/ai-qa"]`，`conflicts:[]` |
| 产物与静态层 | 两个 `client.js` 存在，`/plugins-ui/@geewiki/ai-qa/client.js` ⇒ **200 + `text/javascript`** |
| 激活日志 | 两条分别点名自己的端点与并发上限（`共 4 路并发流上限`） |

## 浏览器侧（`cdp-ui.mjs`）

**权威计数：19 条断言，19 条通过（`result-ui.json` 的 `passed: 19 / total: 19`，取数 `2026-09-14T18:15+08:00`）**；逐条判据与实测细节见同文件的 `checks[]` / `notes`。**这里只记"为什么这条必须存在"**：

1. **列表页出现「AI 问答」入口，但此刻 `client.js` 一次都没被请求**（`1a` + `1b`）。这条钉的是**入口判据**：判据若是"插槽里已注册的组件"，`wiki-ask` 作为懒加载插槽会**自锁**——按钮永远不出现，除非它已经出现过（实现第一版就是这样：入口恒不渲染）。正确判据是入口表的**声明 + 仲裁后生效集**（`pluginUiDeclaredFor()`）。
2. **宿主不自行渲染问答面板**（`1c`：`hostAskNodes = 0`）——本批把面板从 web 删掉了，这条防"宿主里还留一份"。
3. **进入问答视图后 `.ask-card` 出现在 `[data-slot="wiki-ask"]` 内**、css 作为独立样式表加载、bundle 是**进入视图之后**才被请求（`2a`/`2b`/`2c`）。
4. **回答经宿主 `renderMarkdown` 渲染**（出现块级元素）且引用标记 `[1]` 原样可见（`3b`）；点参考资料由**宿主**导航（`3c`：`#/wiki/ask/… → #/wiki/ui-e2e`，插件代码里不出现 `location.hash`）；页面文本不含密钥（`3d`）。
5. **编辑页工具条在 `[data-slot="editor-toolbar"]` 里**，四个动作的禁用态正确（无选区时「改写选中」「润色」禁用，`4a`/`4b`）；生成后弹预览对话框、**写回前不改正文**，点「插入到光标处」经宿主回调真的写进编辑器缓冲区（`4c`/`4d`：`before=49 after=87`），且**不发保存请求**。
6. **停用问答插件不需要重建任何前端产物**（`5a2`：`index.html` 与两个 bundle 的 sha 前后逐字节相同）⇒ 入口消失 + 宿主中性占位（`5b`/`5c`：文案是"当前没有启用提供问答界面的插件…"，**不出现任何 AI 文案或插件名**），全程零 console error。

## 本目录**没有**覆盖什么（别把它当成全量证明）

- **权限红线不在这里验**。`run.mjs` 测的是"有没有模型"这条线，用的是 owner 会话；辅助写作的"匿名/无编辑权 ⇒ 403"与"slug 只用于一次权限判定、绝不取正文"由源级守卫守：`packages/plugin-ai-assist/test/assist.test.ts` 的 `守卫：assist.ts 不得出现任何"取正文/检索"的调用点` 与 `守卫：slug 在 assist.ts 里只能出现在解析与编辑权判定路径上`。理由见 `docs/design/access-control.md` §4.5 末尾的修正。
- **检索召回质量**不在这里判（`mode:'terms'` 的召回/精确率权衡见 `docs/architecture.md` §9.3 与本仓库 [`docs/plugin-platform.md`](../../../docs/plugin-platform.md)）。本目录只保证"问答确实走了 `terms` 且命中数如实回传"。
- **真实模型链路**不在这里（见上文的 mock 理由）。
- **PostgreSQL 部署**不在这里：`@geewiki/search` 的 FTS 形态仅支持 SQLite，PG 下该插件显式拒绝激活（`docs/design/access-control.md` §4.3 的方言裁决），届时问答会以 `search_unavailable` 显式不可用——这条路径**未在本目录实测**。
- `result-backend.json` / `result-ui.json` 是**历史快照**：它们记录的是本批取数时刻（`2026-09-14T17:59 +08:00`，工作树含本批未提交改动）的行为，**不代表当前工作树**，也不参与 `pnpm test`。
- **本目录整体不在版本库里**。仓库根 `.gitignore:23` 忽略整个 `data/`（HEAD 即如此，本批未改），所以这两个脚本与两份快照**只存在于本机工作树**——`git ls-files data/verify` 为空，`git check-ignore -v` 会命中 `data/`。这与 `scripts/acceptance/*.mjs`（**已入库**的 CDP 验收脚本）是两种待遇。**后果**：新克隆的仓库跑不出本目录的验收，本 README 的实测值也就无法被他人复核。**处置建议**（择一，需仓库所有者决定，本批未擅自改动）：把两个脚本挪进 `scripts/acceptance/` 并让快照只留本文的结论，或给 `data/verify/` 加 `.gitignore` 例外（`!data/verify/`）。
