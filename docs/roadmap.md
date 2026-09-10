# GeeWiki 开发路线图

> 阶段按依赖顺序推进。任务清单中的"清单文件"指 `plugins.base.json` / `plugins.session.json`，"双层状态"指基础层（Base Layer）与会话层（Session Layer）。设计细节见 [architecture.md](./architecture.md)。

| 阶段 | 主题 | 里程碑 | 状态 |
| --- | --- | --- | --- |
| Phase 0 | 基础骨架 | monorepo + core 类型 + db-sqlite + server 宿主 | ✅ 完成（07bb411） |
| Phase 1 | 插件管理器 | 依赖图/双层状态/迁移控制器/看门狗/REST | ✅ 完成（e97ce6b） |
| Phase 2 | 前端可视化 + Wiki MVP | React 19 管理台 + React Flow + Wiki CRUD/版本 | ✅ 完成（本次提交） |
| Phase 3 | AI 原生能力 | Slots 插槽、LLM/RAG、编辑器组插件 | 🟡 部分落地：配置系统、外部插件发现、**宿主侧** Slot 已完成；**检索地基（`@geewiki/search`，默认启用）与问答检索-only（`@geewiki/ai`）已落地**；**SSE 长连接出口已与优雅排空共存**（提交 `2273006`，**仅为地基，真实流式输出仍未接线**）；**厂商 LLM adapter、真实流式输出、向量检索**未做（分别属后续批次 / 有意未做 / 有意后置）；编辑器组插件、后端 `ctx.slot()` 注册链路仍为候选 |
| Phase 4 | 稳定性加固 | PG 适配、配置热更新表单（容器镜像与 Compose 部署已提前完成，见 [deployment.md](deployment.md)） | 🟡 部分落地：配置热更新表单**已完成**；PG 适配**已裁决延期**；容器镜像与 Compose 部署已提前完成 |

## Phase 0：基础骨架 ✅

**交付**：`packages/core`（Manifest 规范类型 + DatabaseAdapter + 常量 + cordis-env 类型增强面）、`packages/db-sqlite`（better-sqlite3 适配器 + `src/migrations` SQL 迁移 + `0001_init.sql` 建 pages/page_versions）、`packages/server`（组合根：引导 manager，http 服务 + 健康检查）、pnpm workspace + tsconfig base + docker-compose 骨架 + docs。

**验收**：最小形态启动冒烟通过（db-sqlite 自动迁移建表、健康检查返回库表与迁移清单、SIGINT/TERM 优雅退出链路验证）。

## Phase 1：插件管理器 ✅

**交付**：`packages/manager`（600 行核心）——

- 依赖解析 `resolveDependency`（按插件名或 provides）/ `directDependencies` / `topologicalOrder`（字母序稳定 + 环检测抛错）/ `collectDependents`（反向依赖）/ `collectDependentsClosure`（传递依赖方闭包，供冲突组替换）/ `findUncoveredRequires`（替换的提供者覆盖校验，供冲突组替换）/ `findConflict`（conflictGroup 同组互斥）/ `checkHotChain`（热插件依赖未激活冷依赖即违规）——纯函数，单元测试全绿（`packages/manager/test/deps.test.ts`，10 例）。
- Session/Base 双层清单（`plugins.base.json` + `plugins.session.json`）合并去重装配；boot 逐个拓扑激活、失败记 `bootErrors` 继续。
- `enable()`：会话层热操作——热授权（`supportsHotReload !== true` → 409 `hot_reload_not_supported`）、热链检查、未激活依赖递归启用、激活后写 session 文件。
- `disable()`：基础层插件 → 409 `base_layer`；存在依赖者 → 409 `has_dependents`；卸载（`fiber.dispose()`）并清 session 记录。
- `persistSession()`：会话合并进 base 清单（"应用并持久化"），重启后以 base 层激活。
- 迁移控制器：entry 声明 `migrationsDir` 且 db 可用时，激活前 `db.migrate(dir)`，失败阻止加载。
- 看门狗：5s 探针——session 插件 5s 试用期内健康检查连续失败 → 自动 disable 回滚；连续失败 ≥3 且会话非空 → 熔断（清 session 文件 + `process.exit(1)`，容器自愈联动占位）。
- REST：`GET /api/plugins`（snapshot：state/layer/hotReloadable/provides/requires/conflictGroup/migrations/config/error）、`GET /api/plugins/graph`（React Flow DAG：nodes+edges）、`GET /api/session`、`POST /api/plugins/:name/enable|disable`、`POST /api/plugins/:name/replace`（冲突组顶替）、`POST /api/session/persist`。错误 → HTTP 映射（404/409/400/500）。

**验收**：enable/disable/persist/重启持久化/409 校验/看门狗回滚全链路实测通过。

## Phase 2：前端可视化 + Wiki MVP ✅

**交付**：

- `packages/web`（React 19 + Vite 6 + @xyflow/react + marked，零 UI 框架依赖，中文界面）：
  - `#/wiki` 知识库：页面列表 / 详情（Markdown 渲染）/ 编辑与实时预览 / 新建（slug 校验）/ 删除 / 版本历史时间线（查看快照、一键恢复旧版本）。
  - `#/plugins` 插件管理：状态统计条、插件表（状态/层/热冷徽章/提供与依赖 chip）、会话层热"启用"（行内 JSON 配置编辑）、"停用"、异常重试、基础层清单托管提示、会话变更面板 + "应用并持久化"、bootErrors 展示。
  - `#/graph` 依赖图：React Flow 渲染插件 DAG（内置分层布局：被依赖方居左，无 dagre 依赖），状态着色节点 + 图例 + 缩放控件。
- `packages/plugin-wiki`（`@geewiki/wiki` 核心业务插件，requires http+db，热授权）：
  - `GET/PUT/DELETE /api/pages(/:slug)` + `GET /api/pages/:slug/versions/:id`；upsert 幂等（内容未变不产生版本）；每次保存先快照旧正文至 `page_versions`；删除显式事务级联清历史；body 大小/形状校验。
- `packages/server`：静态文件服务（`packages/web/dist` 或 `GEEWIKI_WEB_DIST`）——扩展名 MIME、hash asset 永久缓存、SPA fallback（无扩展名路径）、`/api/*` 404 与静态互不干扰；`dispatch()` 返回接管语义；204/304 无响应体。**后续批次补充**：`/plugins-ui/**` 走**独立分支**（按名查根、**绝不 SPA fallback**，缺失即 404 `application/json`；其"内置根"由 `GEEWIKI_PLUGIN_UI_DIST` 指定、**缺省 = `webDist`**——app shell 产物根与内置插件 UI 资产根已拆为两个独立配置项，见 architecture §6 与 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 9 节），其根表由 `pluginUiRootsFor()` **每请求现算**（禁止缓存，见 architecture §6）。`@geewiki/wiki` 纳入 default registry 与默认 base 清单。

**验收**：headless Chrome（playwright chromium 1228）真实渲染三路由——列表含 API 数据、插件表状态正确、React Flow 画布出节点、详情页 Markdown 渲染与版本历史齐全；全仓 typecheck 全绿、单测 15/15（`packages/manager/test/deps.test.ts` 8 例 + `manager.test.ts` 7 例）、`vite build` 通过；REST 冒烟（创建/幂等/版本/历史读取/删除/409）全过。

> 后续治理批次（同一实现期）在 `manager.test.ts` 增补崩溃自愈、persist 跳过失败条目、enable 事务性、看门狗决策、卸载排空与缓存清理等用例，并新增 `repo-paths.test.ts`（3 例，路径解析与进程工作目录解耦）与 `packages/server/test/router.test.ts`（11 例，覆盖 HTTP 路由排空/413/端口选项）；该批累计单测 **35/35**（deps 8 + manager 13 + repo-paths 3 + server 11）。
>
> **当前口径（SSE 出口与管理台批次落地后实跑）：两个读数，差别只来自一个并行批次未提交的新包，二者都是真读数。**
>
> **✅ 读数 C（已提交状态 HEAD `3bdcf4b`，取值时刻 `2026-09-11T00:29 +08:00`）：266/266**（fail 0 / skipped 0，**7 个包**）= `packages/manager` **91**（`config` 36 + `deps` 10 + `discovery` 13 + `manager` 14 + `plugin-ui` 15 + `repo-paths` 3）+ `packages/web` **47**（`pluginUiPlan` **28** + `searchPlan` **19**）+ `packages/plugin-llm` **33**（`service` 24 + `redact` 9）+ `packages/plugin-search` **32**（`search` 32）+ `packages/server` **30**（`router` **11** + `plugin-ui-static` **10** + `registry` **3** + `sse-drain` **6**）+ `packages/plugin-ai` **25**（`ai` 25）+ `packages/plugin-wiki` **8**（`service` 8）。
>
> **读数 D（工作树含并行批次未提交的 `packages/plugin-openai/**`，取值时刻 `2026-09-11T00:38 +08:00`）：308/308**（**8 个包**）= 读数 C 的七包**逐包完全相同**，唯一新增 `packages/plugin-openai` **42**（`errors` 7 + `plugin` 8 + `provider` 16 + `sse` 11）。**⚠️ `packages/plugin-openai` 尚未提交**，**不得据此认为厂商 adapter 已落地**。
>
> **命令**（两个读数相同）：`pnpm -r --no-bail --if-present run test` 与 `pnpm -r --if-present run typecheck`；逐文件计数用 `node --import tsx --test <单文件>` 在各包目录下复跑核对。**`pnpm typecheck`**：读数 D 时刻**全量通过，11 个包全部 `Done`、0 个 `error TS`**；读数 C 时刻同一命令曾**整体失败**，唯一原因是并行批次**当时**尚不完整的 `packages/plugin-openai`（`tsconfig.json` 的 `include` 含 `test` 而该目录尚未创建 → `error TS18003: No inputs were found in config file '/root/dev/geewiki/packages/plugin-openai/tsconfig.json'. Specified 'include' paths were '["src","test"]' and 'exclude' paths were '[]'.`，pnpm 以 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @geewiki/openai@0.1.0 typecheck` 中止），以 `--filter '!@geewiki/openai'` 复跑得 10 个包 0 错误——**该错误随并行批次补齐 `test/` 自行消失，属"读工作树"的中间态，不是已提交代码的缺陷**。**教训：报告读数必须同时给出 HEAD 与取数时刻。**
>
> **历史读数（已过时，保留备查）**：**读数 B（工作树含并行批次对 `packages/plugin-search/**`、`packages/plugin-ai/**` 的改动，`2026-09-10T23:35 +08:00`）：251/251** = `plugin-search` **32**、`plugin-ai` **25**，其余五包同读数 A。**读数 A（HEAD `585dbac`，`2026-09-10T23:24 +08:00`）：242/242** = `packages/manager` **91** + `packages/web` **38**（`pluginUiPlan` 19 + `searchPlan` 19）+ `packages/plugin-llm` **33** + `packages/plugin-search` **25** + `packages/server` **24**（`router` 11 + `plugin-ui-static` 10 + `registry` 3）+ `packages/plugin-ai` **23** + `packages/plugin-wiki` **8**。**两个读数都曾是"真读数"，差别来自一个并行批次的未提交改动；该批次的检索召回修复已落为提交 `04c45c3`**，故读数 B 的 `plugin-search` 32 / `plugin-ai` 25 已被当前口径继承为**稳定值**，不再是"待复核"读数。相对读数 B 的 **251 → 266（+15）** 全部来自本批两个提交：`packages/server` **+6**（`sse-drain`，`2273006`）与 `packages/web` **+9**（`pluginUiPlan` 19→28，`3bdcf4b`）。
>
> **⚠️ 与更早口径的差别有三处，勿混用**：① 测试**现在跑到 7 个包**（此前只 web / manager / server 三包）——`packages/plugin-search`、`packages/plugin-llm`、`packages/plugin-ai`、`packages/plugin-wiki` 四个包**本轮起拥有单测**；② 根 `package.json` 的 `test` 脚本**新加了 `--no-bail`**——此前 `pnpm -r` 在**首个失败包处即中止**、后续包根本不执行，故"全量绿"读数可能是**部分**读数；③ `packages/core` / `packages/db-sqlite` / `packages/plugin-echo` / `plugins/hello-geewiki` **没有 `test` 脚本**，`--if-present` 跳过（`typecheck` 在**已提交状态**是 10 个包；若工作树含并行批次未提交的 `packages/plugin-openai` 则为 11 个包，`plugins/hello-geewiki` 始终无该脚本）。
>
> 因此上文 Phase 2 验收里的 15/15 与曾经的 35/35、72/72、81/81、87/87、132/132、134/134、242/242、251/251 均为**历史时点口径**，不代表当前工作树；契约迁移（`layer` = 持久化层、无 schema 插件接受原始 JSON）已完成、两条旧断言已随新契约更新，逐条记录见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 6 节与第 9 节。

## Phase 3（候选）：AI 原生能力

- [x] Slots 插槽机制（**宿主侧**已落地）：宿主经 `window.__GEEWIKI_HOST__` 暴露 `registerSlot(name, component)` / `unregisterSlot`（`packages/web/src/lib/slots.tsx`、`packages/web/src/lib/hostSdk.ts`，SDK 版本 `0.1.0`）；插件 UI bundle 由加载器（`packages/web/src/lib/pluginUi.ts`）按**后端下发的入口表**（`GET /api/plugins/ui`）动态加载后调用 `register(host)` 注册。**插槽名是白名单，当前仅 `app-header` 与 `app-footer` 两个**，未知插槽名告警并忽略；`SlotOutlet` 外层包 ErrorBoundary——插件组件抛错只丢该插槽内容，主界面不白屏
- [ ] 后端注册链路与更多扩展点：`ctx.slot(name, component)`、`editor-toolbar-slots`、`admin-page-slots`（**尚未提供**）
- [ ] Suspense + use Hook 懒加载远端插件 JS Bundle —— 远端 bundle 目前仍由加载器显式 `import()`（"不白屏"靠 ErrorBoundary 而非 Suspense Fallback）；**加载时机已不再是问题**（见下一项：入口表由后端下发 + 生命周期自动同步），本项剩下的只是"改用 Suspense / use Hook 的加载表现"这一件事
- [x] 插件 UI 入口表由后端下发 + 跟随插件生命周期自动同步（**已完成**）：入口表不再是静态 JSON（`/plugins-ui/registry.json` **已停用**），改由 `GET /api/plugins/ui` 从**活状态**现算（注册表 × 激活集合 × 产物 stat → `{ ok, version: 1, revision, plugins: { <name>: { entry, css?, rev } }, skipped }`；`skipped` 记 `inactive` / `no_client` / `entry_missing` / `invalid_name`），响应带 `cache-control: no-store` + `ETag`，`If-None-Match` 命中即 **304**（**空表仍 200**，永不 404）；前端 `syncPluginUi()`（幂等 + 单飞）按整表 `revision` 与逐插件 `rev` 的差集**先卸后装**，`startPluginUiSync({ intervalMs: 15000 })` 立即同步一次 + `visibilitychange` + 可见期轮询 → **UI 随插件启停自动出现/消失**（管理台动作即时，外部变更收敛上界 ≤15s）。**本批补充（提交 `3bdcf4b`）**：`skipped` 现已**在管理台分级展示**——`classifyUiSkips()`（`packages/web/src/lib/pluginUiPlan.ts:226`）把 `entry_missing` / `invalid_name` 归为红系显著告警块 `.ui-skips-attention`，`inactive` / `no_client` 归为可折叠 `<details>` `.ui-skips-normal`（`packages/web/src/pages/AdminPage.tsx:385-421`）；注意它与 `GET /api/plugins` 的发现期 `issues` **语义不同**（前者 = 插件在、界面缺；后者 = 整个插件没加载进来）。**同时修掉一个真实交互缺陷**：`revision` 只对 `{version, plugins}` 求 sha1（`packages/manager/src/plugin-ui.ts:255`）**不含 `skipped`**，故"未启用/无界面插件集合"的变化不改 `revision` → 304 短路会让管理台**永远看不到**这类变化；修法是给 `syncPluginUi` 加 `force` 参数（**管理台走 force、不使用 `If-None-Match`**，15s 可见期轮询仍走 304 短路）。**仍成立的边界**：**ESM 模块实例不回收**——`rev` 变化走 unload → load，同 URL 命中模块缓存，故**产物更新需整页刷新才生效**（见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 5 节 L-6）
- [x] **检索地基**：`@geewiki/search` 全文检索插件（SQLite FTS5 + **`trigram`** 中文分词 + 短词 LIKE 兜底），自带迁移 `migrations/0001_search.sql`，端点 `GET /api/search?q=&limit=&mode=`，**默认部署即启用**（`config/plugins.base.json` 第 4 条）——**已落地**（提交 `e6ddfbd`）。FTS5 预编译可用性、`unicode61` 中文失效、`trigram` 解药与 **<3 字符硬缺口**的实测见 [architecture.md](./architecture.md) §9.3
- [x] **检索召回缺陷修复（已完成）**——**曾经的已知缺陷**：`mode` 缺省 `phrase` 把**整串**当 FTS5 字面短语（搜索框语义），而**自然语言问句**几乎不可能逐字连续出现在正文里 ⇒ **恒为 0 命中**，问答的检索地基实际不可用。**修复**：新增 `mode: 'terms'`（词元 OR；CJK 取 **3-gram 滑窗**、ASCII 按空白/标点切词且只保留 **≥3 字符**者；每个词元仍各自加引号当字面量），并让 `@geewiki/ai` 一律走 `terms`（`packages/plugin-ai/src/index.ts:361`）；`terms` 切不出词元时回退 LIKE。**状态：已落地并提交 `04c45c3`**（`packages/plugin-search/src/index.ts` +141、`packages/plugin-ai/src/index.ts` +6，两包测试 +173 / +45）。**已知代价（提交说明原文）**：terms 召回更宽，精确率天然低于短语检索，建议纳入后续检索质量评估；**`mode=terms` 未接入 Web UI**（搜索框保持 `phrase` 语义，`queryMode` 随响应下发备用）。**未验证项**：端到端召回质量未经本文档作者复跑（无真实问答链路）。见 [architecture.md](./architecture.md) §9.3
- [x] **LLM 服务契约层**：`@geewiki/llm`（route→provider 注册表 + 稳定错误码枚举 + 终止 chunk 保证 + **绝不重试** + 密钥只存**环境变量名** + 日志/响应脱敏）——**已落地**（提交 `e6ddfbd`，**已注册未启用**）。**有意不含任何厂商 adapter**，故当前无可用 provider。见 [architecture.md](./architecture.md) §9.4
- [x] **RAG 检索管线（检索-only 形态）**：`@geewiki/ai` 检索增强问答——**核心承诺"没有 API key 时也完整可用"**（`200` 一律正常，降级为 `mode: 'retrieval-only'` + 抽取式摘要，`sources` 永远完整返回；截断放不下则**整条丢弃**、`used:false` / `n:null`）——**已落地**（提交 `585dbac`，**已注册未启用**）；前端界面走宿主原生 UI（`#/wiki/search/<q>`、`#/wiki/ask/<q>`，提交 `dc5885e`）。见 [architecture.md](./architecture.md) §9.5、§9.6
- [ ] **厂商 LLM adapter**（OpenAI / Anthropic 等真实 provider，`configSchema` 含密码字段）——**未做**：`llm-service` 当前**无任何可用 provider**，问答**恒走 `retrieval-only`**；`rag` / `rag-partial` 两条路径**仅有"假 provider"的单测覆盖**。唯一接线点是 `packages/plugin-ai/src/index.ts:261` 的 `generate()`。**⚠️ 并行情况（截至本批取数时刻 `2026-09-11T00:38 +08:00`）**：另有一批并行工作正在新增 OpenAI 兼容 adapter 包 `packages/plugin-openai`，**尚未提交**——该包已有 `src/{index,provider,sse,errors}.ts` + `test/{plugin,provider,sse,errors}.test.ts`（自带 **42** 例单测：`errors` 7 + `plugin` 8 + `provider` 16 + `sse` 11），且 `packages/server/src/index.ts` 的 `defaultRegistry()` 已在**未提交**的工作树里登记 `@geewiki/openai`（无 `provides`、`requires` 点名 `llm-service`、`conflictGroup: 'llm-provider'`、只登记不入默认基础层清单）。**不得据此认为厂商 adapter 已落地**，以最终提交为准
- [ ] **流式（SSE）输出——有意未做（但出口地基已就绪）**：**为什么有意**：SSE 出口必须与宿主排空（`drain`）语义一起设计，否则长连接会在途计数常驻，使卸载/关停的 `drain` 空转满 `drainTimeout` 并打印**假的排空超时告警**（见第 5 节 L-1）。**本批（提交 `2273006`）已把这件事做完**：`RouteHandlerContext.noteStatus?(status)`（**只记指标、不结束响应**）、`HttpRouterService.trackStream?(res)`（登记长连接、返回幂等注销函数；**该集合不参与排空计数**）、`HttpRouter.closeStreams()`（**注意：不在 `HttpRouterService` 接口上，是具体类方法**），以及 `HttpPlugin.apply` 的五步 teardown（`unprovide()` → `closeStreams()` → `await drain()` → `server.closeIdleConnections?.()` → `server.close()`，**刻意不用 `closeAllConnections()`**）。**仍未接线的部分**：真实流式输出本身——尚无任何插件向客户端持续写帧，检索与问答均为**一次成型返回**；**硬超时 / idle 超时**与 **`res.on('close')` 即取消上游**两件亦未做。**一条务必记档的实测证伪**：**不要**用"先 `writeHead(200, {'content-type':'text/event-stream'})` 再 `h.json(200, null)`"去"只记指标"——`writeHead` 后 `res.headersSent` 立即为 `true` 而 `writableEnded` 仍为 `false`，`json()` 会跳过 `writeHead` 却**仍无条件执行 `res.end(JSON.stringify(body))`**，给事件流追加字面 `null` **并立即终结流**（实测客户端正文 `event: status\ndata: {"type":"status"}\n\nnull`）；正解是 `noteStatus()`。见 [architecture.md](./architecture.md) §5.1.1
- [ ] **向量 / 语义检索**——**有意后置**：离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时），只留接口位；当前检索是**纯字面**匹配（FTS5 trigram + LIKE），同义改写 / 跨语言 / 模糊表述均搜不到
- [ ] 编辑器组插件（Milkdown / TipTap 示例）替换 textarea
- [ ] 插件级静态资源注入（每插件可携带前端资源目录，随激活挂载）——**部分落地**：插件 UI 已有"自带产物根"（`<插件目录>/dist` 优先于内置根 `<GEEWIKI_PLUGIN_UI_DIST>/plugins-ui/<名>`，见 `packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiHit`；该内置根**缺省 = `GEEWIKI_WEB_DIST`**，两者已拆为独立配置项，见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 9 节），但**只覆盖 UI 入口与样式两个单段文件名**（`entry` / `css`），**不支持任意资源目录、也不支持子目录资源**（字体/图片需内联进 bundle）

## Phase 4（候选）：稳定性加固与生产化

- [ ] @geewiki/db-pg：PostgreSQL 适配插件（conflictGroup database-provider 与 sqlite 互斥切换）——**已裁决延期**（DB 不在当前关键路径上；`DatabaseAdapter` 的 3 处实际消费点、双轨接口 `DatabaseAdapterAsync` + `isAsyncAdapter()`、以及唯一防返工项 `GeeWikiMeta.migrations` 扩为双路径，见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 5 节 L-9）
- [x] 配置热更新 + 自动表单 —— **已完成**：`GET` / `PUT /api/plugins/:name/config`（服务端 schemastery 校验 + 白名单裁剪 + 原子落盘，已激活插件经 `fork.update()` 热重跑 apply，失败双向回滚并返回 409）+ 管理台按 `configSchema` 自动生成 React 表单（`packages/web/src/components/SchemaForm.tsx`）；无 schema 插件退回 JSON 原文编辑（不校验、不裁剪）
- [ ] 卸载排空倒计时 UI（drainTimeout 展示）——**仍未做**（保持未勾选）。**后端已就绪**：管理器在统一卸载出口按 `runtime.drainTimeout` 排空在途请求（见 architecture §5.1），仅缺前端展示。**注意排空粒度是"全站"在途请求，不是被卸载插件的 owner 级**（见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 5 节 L-1）。**本批补充**：SSE 长连接**不计入**排空（提交 `2273006`），故倒计时 UI 不应把长连接算作"待等待的在途请求"（见 architecture §5.1.1）
- [x] 冲突组替换交互（加载同组新插件时提示替换）—— **已完成**：新增 `POST /api/plugins/:name/replace`（body 可选 `{config}`；200 返回 `{ok, plugin, replaced, restarted}`，**`replaced: null` 表示未发生替换**——目标已激活的幂等路径或"无同组冲突"的降级路径），409 `base_layer` / **`provider_mismatch`** / `hot_reload_not_supported` / `hot_dependency_not_supported`，400 `load_failed` / `migration_failed`，500 `replace_rollback_failed`），配套 `packages/manager/src/deps.ts` 的传递闭包 `collectDependentsClosure` 与提供者覆盖校验纯函数 `findUncoveredRequires`、管理台顶替确认框（`packages/web/src/pages/AdminPage.tsx` 的 `replacePrompt`）。**前置校验（零副作用阶段）三类拒绝**：① 旧插件**真实激活层**非 session（判据 `managed.layer`，不是 `layerOf()`）→ 409 `base_layer`；② 卸载集合（旧插件 ∪ 活跃传递依赖方）内任一成员非 session → 409 `base_layer` 带 `details.plugins`；③ 依赖边经 `resolveDependency` 解析后指向被顶替者而目标无法承接 → 409 `provider_mismatch`（`details` 含 `plugin` / `token` / `target` / `targetProvides` / `violations`），目标自身依赖被顶替者同样被拒。**对外影响**：依赖方按**具体插件名**依赖被顶替者时该替换会被 409 拒绝（按名的边无法由新插件承接），正解是改为依赖**服务标识**（`provides` token）——刻意取舍，宁可 409 也不留下无人提供的服务。失败回滚会**按调用前的条目顺序与原内容复原**会话清单（文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行，故非规范格式不被逐字节保留）；返回 500 时整个卸载集合的会话条目均已从清单消失、内存与磁盘一致，需人工介入（该分支**无单测覆盖**，见 G-1）。管理台确认框预告"被卸载插件短暂不可用（约几秒）"、依赖方只列**当前活跃者**，无替换降级时提示"冲突已解除，已直接启用（未发生替换）"。见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节 G-1；隔离实例与浏览器 CDP 均已实测。
- [x] `enable` 失败回滚作用域修复 —— **已完成**：回滚集合改为**全递归帧共用**（公开 `enable` 作唯一回滚点、private `enableInner` 自登记 `activated`），依赖深度 ≥2 的孙依赖不再泄漏进 session 清单；回归用例「enable：递归深度 ≥2 时回滚集合必须覆盖孙依赖（会话清单零残留）」做了红-绿验证。见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节 G-2 与第 5 节 L-2。
- [x] `meta.role: 'password'` 脱敏输入框 —— **已完成**：`role: 'password'` 的字符串字段渲染为 `type="password"` + `autoComplete="new-password"` 输入框（`packages/web/src/lib/configSchema.ts` 置 `secret`、`packages/web/src/components/SchemaForm.tsx` 据此选控件）。**边界（仍未做）**：脱敏只作用于表单输入框的呈现，`GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（不在传输层脱敏），见 architecture §5.7
- [x] 发现期 issues 的前端提示位 —— **已回填：该项此前登记为"未做"，实际横幅已在代码里**（本轮核对更正）。管理台 `packages/web/src/pages/AdminPage.tsx:314` 的 `.discovery-issues` 区块渲染 `GET /api/plugins` 的 `issues`（逐条展示 `code` / `dir` / `message`，样式见 `packages/web/src/styles.css:179-183`），标题为"外部插件发现期有 N 条问题（这些插件未加载）"。因此第 5 节 **L-14 的"前端待补"半截已闭合**（该限制条目保留作为接口可见性的契约锚点）
- [x] 依赖阻止卸载弹窗提示 —— **已完成（本批，提交 `3bdcf4b`）**。此项此前只有泛化的 409 文案。现管理台捕获 `409 has_dependents` 并弹出**专门说明块** `.dependents-block`（`packages/web/src/pages/AdminPage.tsx:423-455`）：标题「无法停用 X：仍有插件在依赖它」+ 列出依赖方名单（来自响应 `details.dependents`）+ 两段**可操作指引**（① 先在上表逐个停用依赖方，再回来停用目标；② 若它是被同冲突组其它插件顶替，可在目标插件那行点「启用」走**冲突组替换**，会连同依赖方一起安全接管）。`dependentNamesOf()` 防御性读取 `details`——形状不符退回空数组，走"后端未返回名单，可在依赖图中查看指向它的边"的兜底文案，**不显示 `undefined`**。**刻意未实现自动级联停用**（破坏性操作，不属本批）。见 [architecture.md](./architecture.md) §5.2
- [x] docker-compose 应用镜像多阶段构建（web build → server），容器自愈联动实测 —— **已完成**：`Dockerfile`（多阶段、非 root 运行、`HEALTHCHECK` 判 `ok && db.present`）+ `docker compose up -d --build` 已实测（构建、持久化、插件启停持久化、SIGTERM 优雅退出、数据目录不可写时如实变 `unhealthy`）；详见 [deployment.md](deployment.md)
- [ ] 端到端故障演练：注入崩溃/慢查询验证熔断与数据无损
