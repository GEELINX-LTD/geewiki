# GeeWiki

面向团队内部的 AI 原生 Wiki 知识库。

核心哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用）；PostgreSQL 亦可作为数据库插件切换（`@geewiki/postgres`，与 `@geewiki/db-sqlite` 同属 `database-provider` 冲突组、天然互斥），但**默认不启用**——切库是显式决策（见下方「如何用 PostgreSQL」）。

**当前状态：Phase 2 完成 + Phase 3 主体落地** —— 插件管理器（依赖图/冲突组/会话层/看门狗）、Wiki CRUD + 版本历史、React 19 管理台与依赖图均可完整交互；插件配置系统（schema 表单 + 热更新）、外部插件目录发现、前端 Slot（**宿主侧插槽 + 后端下发入口表 + 随插件生命周期自动同步**）与**后端插槽注册链路**（`ctx.get('slot')` / `SlotService`：`contribute` / `list` / `ownersOf` / `release`，含单占用基数裁决与 owner 级回收）均已落地；**全文检索已默认启用**（SQLite FTS5 + `trigram` 分词器解决中文检索 + 短查询 LIKE 兜底），**检索增强问答（RAG）已落地"没有 API key 也完整可用"的检索-only 形态**；**LLM 厂商 adapter 已落地**——OpenAI 兼容 adapter `@geewiki/openai`（`packages/plugin-openai/`，自带 49 例单测）已提交并登记进 `defaultRegistry()`，向 `llm-service` 注册一条真实路由（默认不启用，需显式开启 + 自备凭据，见下方「如何启用真实模型」）；**SSE 流式问答已交付**：`POST /api/ai/stream` 逐帧下发（事件名共 4 个：`status` / `delta` / `done` / `error`，见 `packages/plugin-ai/src/sse.ts:49-52`），前端按帧增量渲染（`packages/web/src/lib/aiStreamPlan.ts` + `components/AskPanel.tsx`）。开发路线与阶段进度见 [docs/roadmap.md](docs/roadmap.md)（**注**：该文档与 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) 的若干段落仍停留在更早批次的口径——把厂商 adapter、`ctx.slot()`、真实流式输出等记为"未做"；**以本 README 的实测结论为准**）。

**当前实现状态**

- **已完成（Phase 0-2）**：pnpm monorepo 共 **13 个包**（`ls -d packages/*/`；另有工作区项目 `plugins/hello-geewiki`，故 `pnpm -r` 的作用域是 **14 个** project）；`pnpm dev` 一条命令同时启动后端 http://127.0.0.1:3000 与前端开发服务器 http://localhost:5173（生产形态 `pnpm build` 后用 `pnpm start`，由后端静态托管前端产物）；**10 个内置插件已由代码内注册表静态登记**（`packages/server/src/index.ts:938` 的 `defaultRegistry()`：`@geewiki/db-sqlite`、**`@geewiki/postgres`**、`@geewiki/http`、`@geewiki/echo`、**`@geewiki/editor-plain`**、`@geewiki/llm`、`@geewiki/search`、`@geewiki/wiki`、`@geewiki/ai`、**`@geewiki/openai`**；其中默认基础层清单 `config/plugins.base.json` **只启用 4 个**——`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki` / **`@geewiki/search`**，其余 6 个（`postgres` / `echo` / `editor-plain` / `llm` / `ai` / `openai`）属**已注册未启用**；实测 `GET /api/plugins` 返回 **12 条** = 10 条内置 + 2 条外部（`plugins/` 下的 `@geewiki-plugin/hello`、`@geewiki-plugin/ui-demo`），`issues` 为空）；Web 管理台含 `#/wiki`、`#/plugins`、`#/graph` 三个主路由；wiki 下的 hash 子路由共 **7 态**（`packages/web/src/lib/wikiRoute.ts` 的 `WikiRoute`）：`#/wiki`（**主页文章**，约定 slug `home`）、`#/wiki/list`（列表）、`#/wiki/new`、`#/wiki/<slug>`（详情，支持分层 slug）、`#/wiki/<slug>/edit`、`#/wiki/search/<q>`、`#/wiki/ask/<q>`（后两者为宿主原生检索/问答 UI），另有 `⌘K` / `/` 唤起的**命令面板**（`packages/web/src/components/CommandPalette.tsx`）与**侧边栏页树**（`components/Sidebar.tsx`）；**单元测试全绿，一次实跑读数**（命令 `pnpm -r --no-bail --if-present run test`，逐包逐文件明细见下表 `pnpm test` 行）：**746/746，9 个包**，两次同值（取数 `2026-09-11T20:16:33+08:00` 与 `2026-09-11T20:29:55+08:00`；后者在并行批次提交后的**干净工作树** HEAD `1c9e083` 上复跑）。`pnpm typecheck`：**13 个包全部 `Done`、0 个 `error TS`**（Exit 0；取数 `2026-09-11T20:29:55+08:00`；作用域 `Scope: 13 of 14 workspace projects`，`plugins/hello-geewiki` 无该脚本被 `--if-present` 跳过）。**⚠️ 两条必须记档的瞬态现象（都不是已提交代码的缺陷，是"读工作树"在并行写入期遇到的中间态）**：① `2026-09-11T20:14:53` 首次跑 `pnpm test` 时**整体失败**——`[ERR_PNPM_RECURSIVE_FAIL]` / `Summary: 1 fails, 8 passes` / `packages/web: [ERROR] @geewiki/web@0.1.0 test: node --import tsx --test test/*.test.ts Exit status 1`；**紧接着单独复跑 `packages/web` 即 314/314 全绿**，原因是并行批次当时正在写 `test/editorPaneRegions.test.ts`，故报告读数时**须同时给出 HEAD 与取数时刻**。② 更早一轮（`00:29`，HEAD `3bdcf4b`）同一命令曾因当时新建的 `packages/plugin-openai` 的 `tsconfig.json` 声明了 `include: ["src","test"]` 而 `test/` 尚未创建，报 `error TS18003: No inputs were found in config file '/root/dev/geewiki/packages/plugin-openai/tsconfig.json'. Specified 'include' paths were '["src","test"]' and 'exclude' paths were '[]'.` 并整体失败；该错误随该目录补齐而自行消失。卸载统一出口已消费 `runtime.drainTimeout`（优雅排空在途 HTTP 请求，超时强制卸载）并在 `requiresCachePurge` 时广播缓存清理事件；**SSE 长连接出口已与排空共存，且真实流式输出已接线**（`packages/server/src/index.ts`：`HttpRouter.trackStream(res, owner)` 登记的长连接**按 owner 分组**、`activeStreams` 不计入在途、`closeStreams(owner?)` 在卸载时定向回收、`noteStatus()` 只记指标不结束响应、teardown 走 `unprovide()` → `closeStreams()` → `await drain()` → `server.closeIdleConnections?.()` → `server.close()` 五步；提交 `2273006`）。
- **插件平台已落地（Phase 3 的既有四条链路）**：
  - **配置系统（schema 驱动）**：manifest 的 `geewiki.configSchema` 采用 [schemastery](https://github.com/shigma/schemastery) 3.18.0；`GET` / `PUT /api/plugins/:name/config` 提供读写，服务端做校验 + 白名单裁剪 + **原子落盘**（先写 `<文件>.tmp` 再 `rename`）；已激活插件经 `fork.update()` 热更新，失败时把进程内配置与磁盘清单**双向回滚**并返回 409。管理台按 schema 自动生成表单（开关 / 数字 / 文本 / 多行 / 枚举 / 字段组 / 列表；`meta.role: 'password'` 渲染为密码输入框），**未声明 schema 的插件退回 JSON 原文编辑框**（不校验、不裁剪）。
  - **外部插件加载**：启动时扫描 `./plugins/<name>/`（`GEEWIKI_PLUGINS_DIR` 可覆盖），清单取子目录 `package.json` 的 `geewiki` 键（优先）或独立 `geewiki.manifest.json`，与内置插件**并入同一注册表、完全同权**；单个插件的清单缺失 / 入口缺失 / 路径越界 / 重名 / 加载抛错都只记一条 issue 并跳过，不阻断宿主启动；发现期问题经 `GET /api/plugins` 的 `issues` 字段对外可见（`{code,dir,message}`，`code` 为八值枚举）。零依赖示例见 `plugins/hello-geewiki/`。
  - **冲突组替换（顶替交互）**：同 `conflictGroup` 的插件除互斥拦截外，可经 `POST /api/plugins/:name/replace` 顶替：先卸载组内已激活的旧插件（连同它当前活跃的传递依赖方），再热激活目标插件，并把依赖方接回新提供者（`skipDeps` 阻止旧插件被当依赖重新拉起）。**前置校验在三类情形下直接拒绝**（均在产生任何副作用之前，故拒绝路径零残留）：① 旧插件（将被顶替者）的**真实激活层**不是 session → 409 `base_layer`（判据是 `managed.layer`，不是 `layerOf()`；同名条目同时在两层清单的叠加态下它以 base 层激活，属冷操作）；② **卸载集合内任一成员**（旧插件 ∪ 其活跃传递依赖方）的真实激活层不是 session → 409 `base_layer`，响应 `details.plugins` 列出基础层成员（活跃的基础层插件不可热卸载，否则接回时会把它在会话层重新落盘、静默改写其持久化层）；③ 被顶替者自身或任一待接回的依赖方，其 `requires` 里的 token 经 `resolveDependency` 解析后指向被顶替者，而目标无法承接（目标的插件名或 `provides` 均不命中）→ 409 `provider_mismatch`（响应 `details` 带 `plugin` / `token` / `target` / `targetProvides` / `violations`）；目标自身依赖它要顶替的插件同样被拒（`details.tokens`，不自洽）。**对外影响**：依赖方**按具体插件名**依赖被顶替者时替换必然被 409 拒绝——按名的边无法由新插件承接，正解是依赖方改为依赖**服务标识**（`provides` token）；这是刻意取舍（宁可 409，也不返回 200 却留下无人提供的服务）。失败会回滚旧插件与依赖方，并**按调用前的条目顺序与原内容复原会话清单**（文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行，故人工编辑过的非规范格式不会被逐字节保留）；回滚也失败时返回 500 `replace_rollback_failed`（该路径下整个卸载集合的会话条目都已消失、内存与磁盘一致，需人工介入；仅代码路径 + 人工推演，**无单测覆盖**）。管理台在启用撞上冲突时弹出顶替确认框（列出被顶替者与**当前活跃的**依赖方，并预告"被卸载插件会短暂不可用约几秒"），用户确认后走该端点；若响应 `replaced: null`（无冲突降级）则提示"冲突已解除，已直接启用（未发生替换）"。
  - **前端 Slot（宿主侧插槽 + 后端下发入口表）**：宿主经 `window.__GEEWIKI_HOST__` 暴露 React 单例与 `registerSlot` / `unregisterSlot`，插件 UI bundle 从 `/plugins-ui/<插件名>/<入口文件名>`（默认 `client.js`）动态加载并注册组件；插槽名是白名单，当前共 **3 个**（`packages/core/src/index.ts:640` 的 `SLOT_NAMES`）——`app-header` / `app-footer` 是**零属性（不传任何数据）的 multi 插槽**，`editor` 是**带数据的 single（单占用）插槽**（props 见 `EditorSlotProps`：`value` / `mode: 'create'|'edit'` / `slug` / `readOnly?` / `onChange` / `onSave` / `onCancel`，是**宿主唯一向插件传数据的通道**；基数表见同文件 `SLOT_CARDINALITY`：两个 app-* 为 `multi`、`editor` 为 `single`，冲突时由宿主确定性裁决并在 `GET /api/plugins/slots` 的 `suppressed` / `conflicts` 里可见）；未知插槽名告警并忽略，插槽外层包 ErrorBoundary——插件组件抛错只丢该插槽，主界面不白屏。**后端侧插槽注册链路也已落地**：插件可经 `ctx.get('slot')`（服务名 `'slot'`，实现类 `SlotRegistry` 在 `packages/manager/src/slots.ts:157`）拿到 `SlotService` 做运行期 `contribute(owner, slot, meta?)`（返回幂等注销函数）/ `ownersOf(slot)` / `list` / `release`，或直接在清单里写 `slots: ['editor']` 做**声明式**贡献（激活时自动登记，`@geewiki/editor-plain` 即此形态）。**哪些插件的 UI 该加载由后端下发**：插件在清单里声明 `geewiki.client`（`{ entry?, css? }`，均为**单段文件名**，`entry` 缺省 `client.js`；**未声明 `client` 的插件永不进入口表**——注意它与**后端**入口 `geewiki.entry` 不是一回事）。宿主读 `GET /api/plugins/ui`（每请求由"注册表 × 激活集合 × 产物 stat"现算，只列 active ∩ 声明 `client` ∩ 入口实际存在者，条目形状为 `{ entry, css?, rev, slots }`（`slots` 是该插件声明的插槽名数组），`skipped` 记 `inactive` / `no_client` / `entry_missing` / `invalid_name`；带 `no-store` + `ETag`，`If-None-Match` 命中即 **304**，空表仍 200）；前端按整表 `revision` 与逐插件 `rev` 的差集**先卸后装**，并由管理台动作（即时）+ `visibilitychange` + 15s 可见期轮询自动收敛——**UI 随插件启停自动出现/消失**（外部变更 ≤15s）。资产按**双根**解析：`<插件目录>/dist` 优先、`<GEEWIKI_PLUGIN_UI_DIST>/plugins-ui/<名>` 兜底（该变量**缺省 = `GEEWIKI_WEB_DIST`**，故既有部署行为不变）。**静态资产已支持子目录**：`/plugins-ui/<插件名>/<相对路径>` 走独立分支，相对路径由 `PLUGIN_UI_ASSET_PATH`（`packages/core/src/index.ts:411`）校验——逐段 `[A-Za-z0-9][A-Za-z0-9._-]*`、**≤ `PLUGIN_UI_ASSET_MAX_DEPTH` = 16 段**，`..` / `.env` / 空段 / 绝对路径 / 反斜杠 / 尾随斜杠 / 任何 `%` 编码一律非法（**因此不解码也不存在 `%2e%2e` 这类陷阱**）；服务端另做**四层包含防护**（按段还原插件名再查根表 → 路径段形态 → 词法 `relative()` 包含（刻意不用 `startsWith`）→ `realpath` 后再比一次挡软链逃逸），并**绝不回退 `index.html`**（缺失即 404 JSON，否则会被 SPA fallback 掩盖成 200 `text/html`），MIME 按扩展名分级、带内容指纹的资产长缓存 + `immutable`、无指纹的 `no-cache`、`ETag` 支持 304。**边界见下方"已知限制"。**
- **检索与问答已落地（本阶段新增的 AI 原生能力）**：
  - **全文检索 `@geewiki/search`**（`packages/plugin-search/`，提交 `e6ddfbd`）：`provides: 'search-service'`、`requires: ['database-provider','http-service']`、**不进任何冲突组**、自带迁移 `migrations/0001_search.sql`（FTS5 external content 表 `pages_fts` + 三条同步触发器 + `rebuild` 回填；由管理器的迁移控制器在激活前执行，`migrationsDir = SEARCH_MIGRATIONS_DIR`）。**默认部署即启用**（`config/plugins.base.json` 第 4 条）——纯只读增强、不需要任何凭据。端点 `GET /api/search?q=&limit=&mode=` → `{ok, query, mode:'fts'|'like', queryMode:'phrase'|'terms', total, hits:[{slug,title,snippet,score,updated_at}]}`；**空查询 → 400 `invalid_query`、非法 `limit` → 400 `invalid_limit`**（`limit` 须为 1..100 的整数）、**非法 `mode` → 400 `invalid_mode`**；**`total` 是全量命中数，不受 `limit` 限制**（用 `COUNT(DISTINCT p.id)` 统计，同一行被多个词元命中只计一次）；响应里有两个方向不同的字段——**`mode`** 回传**实际走的那条路径**（`'fts'` / `'like'`，观测用）、**`queryMode`** 回传**本次请求的查询语义**（`'phrase'` 整串字面短语 / `'terms'` 词元 OR，`mode` 参数缺省 `'phrase'`）；`snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`，前端**不得二次转义**）；`score` 是**取负后的 BM25**（越大越相关，**不是归一化**，值域无界，**仅同一次查询内可比**，LIKE 路恒为 0）。
  - **✅ 已知并已修复：整串按 FTS5 短语匹配，自然语言问句需按词元检索（修复已落地，提交 `04c45c3`）**。`mode` 缺省为 `'phrase'`——把**整串**当作一个 FTS5 字面短语，这正是搜索框语义（搜什么就要求正文里连续出现什么）；但**自然语言问句**（如「检索增强怎么做」）几乎不可能逐字连续出现在正文里，按短语匹配**恒为 0 命中**，问答的检索地基等于不可用。**修复方案**：新增 `mode: 'terms'`——把查询切成**词元**后以 **OR** 连接（CJK 连续片段取 **3-gram 滑窗**、ASCII 按空白与标点切词且只保留 **≥3 字符**者；每个词元**仍各自加引号当字面量**，注入防护的实现只有一处），并让 `@geewiki/ai` 的问答**一律走 `terms`**；`terms` 切不出词元时（<3 字符、纯标点）**回退 LIKE**，不构造空 `MATCH`。**状态：该修复已落地并提交**（`04c45c3`）——`packages/plugin-search/src/index.ts` 新增 `mode: 'terms'`（词元 OR 切分 + 字面量引号，注入防护仍只有一处），`packages/plugin-ai/src/index.ts:432` 的问答改为 `search.search(query, { limit, mode: 'terms' })`。**注意 `mode=terms` 未接入 Web UI**（`packages/web/src/api.ts:465-469` 的 `search()` 只传 `q` 与 `limit`，搜索框保持短语语义 `phrase`，`queryMode` 已随响应下发备用）——**本批实测**：对同一问句「检索增强怎么做」，`GET /api/search?q=…`（缺省）返回 `{"mode":"fts","queryMode":"phrase","total":0}`，加 `&mode=terms` 才返回 `{"mode":"fts","queryMode":"terms","total":1}`；已知代价是 terms 召回更宽、精确率天然低于短语检索，建议纳入后续检索质量评估。**上表 `pnpm test` 的 `plugin-search` 40 / `plugin-ai` 65 两个读数即当前稳定值**。
  - **FTS5 与中文检索的关键事实（本仓最易被误传的一点，均已在 `better-sqlite3@13.0.3` 上实测复验）**：① `better-sqlite3` 的**预编译包已含 FTS5**（`compile_options` 含 `ENABLE_FTS5`，内置 SQLite **3.53.4**，`tokenize='trigram'` 可直接建表 ⇒ **无需 node-gyp**）；② FTS5 默认的 `unicode61` 分词器把**连续 CJK 当成一个 token** ⇒ `MATCH '"知识库"'` **0 命中**，中文等于搜不到；③ 故**必须显式 `tokenize='trigram'`**（中文 ≥3 字子串可命中；`MATCH '"全文检索"'` 命中，`'"知识库"'` 命中）；④ **trigram 的硬缺口**：查询串 **<3 字符**时 `MATCH` 恒为空（中文 2 字词如「检索」、英文 2 字母都是空结果）⇒ 插件层用 **LIKE 兜底**，且该路径**直接扫 `pages` 真源表而非索引**，故索引缺失/漂移时短查询仍给出正确结果；⑤ 索引体积与正文**同量级**（自测：5000 行、正文合计 6.23 MB → 索引使库文件增长 7.07 MB，约 **1.14×** 正文；`migrations/0001_search.sql` 记录的仓库内实测为 6.6 MB 语料 +7.9 MB）。
  - **LLM 服务契约层 `@geewiki/llm`**（`packages/plugin-llm/`，同批提交 `e6ddfbd`）：`provides: 'llm-service'`、**不进任何 conflictGroup**（它是 route→provider 注册表，互斥应由各 adapter 自己声明）。**本批起已含第一个真实厂商 adapter**（`@geewiki/openai`，OpenAI 兼容端点；它只往注册表注册路由、不 `provides`），故"有没有可用 provider"取决于是否启用它 + 是否备好凭据——**实测默认部署**（`config/plugins.base.json` 只启用 4 个插件）下 `GET /api/ai/capabilities` 返回 `{"available":false,"degraded":true,"providers":[{"route":"null",…},{"route":"openai",…}]}`，两条路由均 `available:false`，故问答恒走 `retrieval-only`。契约要点：**稳定错误码枚举**（`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` / `NETWORK` / `PROVIDER_ERROR` / `ABORTED`）；调用方**按 code 分支、绝不按 message 文本分支**（`error` chunk 在**结构上就没有 message 字段**）；**终止 chunk 恰一次且在末位**由包装器保证（消费方可无判空 `for await`）；**服务本身绝不重试**。**密钥安全**：配置里只存**环境变量名**（`apiKeyEnv`）而非密钥值——结构上杜绝 LLM 密钥进入入库的 `config/plugins.base.json`（白名单闸门 `isEnvVarName`：全大写 + 至少一个下划线，`packages/plugin-llm/src/credentials.ts:57`，另有 schema `.pattern(ENV_VAR_NAME_FIELD_RE)` 覆盖配置读写路径、`apply()` 内再查一次覆盖"以代码直接构造 config"的路径）；配套 `redact`（日志/响应脱敏）。**⚠️ 唯一的例外是数据库插件**——`@geewiki/postgres` 除 `passwordEnv` 外还提供一个 **`password` 明文密码字段**（`.role('password')`，schema 自述"仅本地开发"），它会**明文写进入库的 `config/plugins.*.json`**；生产请只用 `passwordEnv` / `connectionStringEnv`（详见「如何用 PostgreSQL」与已知限制 ③⑪）。
  - **检索增强问答 `@geewiki/ai`**（`packages/plugin-ai/`，提交 `585dbac`）：`provides: 'ai-service'`、`requires: ['http-service','database-provider','search-service','llm-service']`（**按服务 token 依赖，非插件名**）、**不进任何冲突组**、显式 `ctx.provide('ai-service', svc)`。端点 `POST` / `GET /api/ai/ask`（`{q, limit?, extractive?}`）、**`POST /api/ai/stream`（SSE 逐帧）** 与 `GET /api/ai/capabilities`。**核心产品承诺：没有 API key 时也完整可用** —— **`200` 一律正常**（含"未配置密钥"与"检索无结果"），**绝不用 4xx/5xx 表达"没有 key"**；降级时 `mode:'retrieval-only'` + `degraded{reason,code,message}` + **完整 `sources`** + `answer` 为**零成本抽取式摘要**；`400 empty_query`（空查询）/ `400 too_long`（查询串 > **500** 字符）。上下文截断：按 `perSourceChars` 截断后逐条尝试放入，不超 `totalContextChars` / `maxSourcesInContext`，**放不下就整条丢弃**（不做尾部裁切），被丢弃者 `used:false` 且 `n:null`；`sources[].n` 只对 `used:true` 者连续编号；正文一律经 `search-service` 的 `contents()` 取，**不直连 wiki 的 `pages` 表**。`generate()` 是**唯一接线点**——`@geewiki/ai` 本身不认任何厂商，有可用 provider 时走 `rag` / `rag-partial`，无 provider 或路由不可用时降级为 `retrieval-only`（默认部署即后者；本批未做真实模型链路验证）。
  - **前端检索与问答界面**（`packages/web/`，提交 `dc5885e`）：wiki 内的搜索框与问答界面走 hash 子路由 `#/wiki/search/<q>` 与 `#/wiki/ask/<q>`；**没有改 Slot 机制**（`packages/web/src/lib/slots.tsx` 一行未动，"宿主不向插件传数据"的冻结裁决保持）——搜索/问答是**宿主原生 UI**。降级提示条是**信息性**的（`no_provider` / `missing_credential` → `level: 'info'`，非错误样式）；插件未启用时**静默降级**（入口 disabled + 提示，不产生 console error）。已知取舍：`search` / `ask` 成为 wiki 下的**保留首段 slug**。
  - **平台一致性修复（同批）**：`@geewiki/wiki` 补了真实的 `ctx.provide('wiki-service', svc)`（此前是"只声明 token 不提供服务"）；`@geewiki/echo` **撤掉了** `provides: 'echo-service'`（无消费方，属谎报 token）；根 `package.json` 的 `test` 脚本加了 **`--no-bail`**（此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行 ⇒ 过去的"全量绿"读数可能是**部分**读数）。
- **尚未实现 / 已知限制**：**Phase 3 余项（本批逐条实测后真正仍未落地的）**——`editor-toolbar-slots` / `admin-page-slots` 扩展点（仍为候选）；**第三方编辑器组插件**（Milkdown / TipTap）——`editor` 插槽目前只有内置 `@geewiki/editor-plain`（纯 `<textarea>`）一个真实消费者；**其它厂商 LLM adapter**（Anthropic 等）——目前只有 OpenAI 兼容一个；**向量 / 语义检索**（有意后置）。**Phase 4 的 PostgreSQL 适配已不再是"未实现"**：`packages/db-postgres/`（包名 **`@geewiki/postgres`**，**不是**旧文里的 `@geewiki/db-pg`）已实现异步适配器并登记进内置注册表，`@geewiki/wiki` 也已适配异步 `DatabaseAdapter`；但它**默认不启用**，且与 `@geewiki/search` **不兼容**（见下方 ⑬）。**本批同时从前一版删除的已落地项**（均实测复核）：LLM 厂商 adapter、`editor` 插槽链路、插件级子目录静态资源、后端 `ctx.slot()` 注册链路、PostgreSQL 适配、SSE 流式输出。**检索与问答侧的边界另见下条 ⑥–⑫。** 另有 **15 条已知限制**：① **Slot 仍无 Suspense + use Hook 懒加载**——远端 bundle 仍由加载器显式 `import()`（`packages/web/src/lib/pluginUi.ts:241`），"不白屏"靠 ErrorBoundary 而非 Suspense Fallback；且 **ESM 模块实例不回收**——`rev` 变化走 unload → load、同一 URL 命中模块缓存，故**插件产物更新后需整页刷新才生效**（`packages/web/src/lib/pluginUi.ts:45-46`、`:88`，刻意的取舍）；插件 CSS 以 `<link data-plugin-ui=…>` 全局注入、**不做样式隔离**（`:217`；示例夹具以 `.gw-fixture-*` 前缀命名类名作为约定示范，宿主侧无强制手段）。**注意两条路径不是一回事**：插件**入口与样式名**仍必须是**单段文件名**（`client.entry` / `client.css`，校验用 `PLUGIN_UI_FILE_SEGMENT`），但 bundle 内部引用的**子目录资产已能经服务端取到**（`PLUGIN_UI_ASSET_PATH`，见上方「前端 Slot」一节）；② **排空粒度仍是全站**在途 HTTP 请求，非 owner 级——`packages/server/src/index.ts:272` 的注释明示"按插件（owner）粒度排空属于后续工作：当前不做请求来源归属，一次卸载会等待所有插件的在途请求"；**但长连接（SSE）已按 owner 分组定向回收**（`activeStreams` 按 owner 分组 / `trackStream(res, owner)` / `closeStreams(owner?)`），故插件级卸载不会漏收自己开的流；③ 密码字段的脱敏**只覆盖表单输入框的呈现**——`meta.role: 'password'` 已渲染为 `type="password"` + `autoComplete="new-password"` 输入框，但 `GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层做脱敏）。**本批实测**：对 `@geewiki/postgres` 发 `PUT /api/plugins/%40geewiki%2Fpostgres/config` body `{"config":{"password":"PLAINTEXT_TEST_SECRET_123"}}`，响应体即**回显该明文**，随后 `GET` 该端点**原样回读**；再调 `POST /api/session/persist`，该明文**落进入库的 `config/plugins.base.json`**；④ 浏览器侧验收脚本 `scripts/acceptance/plugin-ui-cdp.mjs`（零依赖，Node 内置 WebSocket + 直连 CDP）**刻意不接入 `pnpm test`**——它需要 Chrome、一个运行中的实例与已构建的插件产物；且其**实测只在 Chromium 上进行**（import map 的浏览器基线为 Chrome / Edge 89+、Safari 16.4+、Firefox 108+，本项目不提供降级路径）；⑤ `packages/web/tsconfig.json` 的 `types` 同时含 `vite/client` 与 `node`（为让 `test/*.test.ts` 通过类型检查），因此**若在 `packages/web` 的源码里误用 Node API，类型检查不再拦截**；⑥ **默认部署下没有可用 provider**——`llm-service` 注册了恒不可用的兜底路由 `null`（`packages/plugin-llm/src/service.ts:50-52`），`@geewiki/openai` 虽已实现但**默认不启用**（不在 `config/plugins.base.json` 里），且即使启用也需运维在外部备好凭据；故**开箱状态下问答恒走 `retrieval-only`**（实测 `GET /api/ai/capabilities` → `{"available":false,"degraded":true,"providers":[{"route":"null",…},{"route":"openai",…}]}`，两条路由均 `available:false`）；`packages/plugin-ai` 的 `rag` / `rag-partial` 两条路径**目前仅有"假 provider"的单测覆盖**（`packages/plugin-ai/test/ai.test.ts:541` 的 `fakeProvider()`，用例在 `:558` 「有可用 provider 时真的走模型路径，mode 为 rag」与 `:583` 「生成中途失败但有部分文本 → mode 为 rag-partial」）——**本批未做真实模型链路验证**（无凭据，属未核实项）；⑦ **流式（SSE）已交付，但超时/取消是"插件自管"而非"宿主通用能力"**——`POST /api/ai/stream`（`packages/plugin-ai/src/index.ts:913`）以 `event: status | delta | done | error` 逐帧下发（事件名常量在 `packages/plugin-ai/src/sse.ts:49-52`），前端 `packages/web/src/lib/aiStreamPlan.ts` 做增量解析、`components/AskPanel.tsx` 渲染；出口机制同前（`HttpRouterService.trackStream?()` 登记的长连接**不参与排空计数**、`RouteHandlerContext.noteStatus?()` 只记指标不结束响应、teardown 走 `unprovide()` → `closeStreams()` → `await drain()` → `server.closeIdleConnections?.()` → `server.close()` 五步主动收流，提交 `2273006`）。**硬超时 / idle 超时 / `res.on('close')` 取消上游三件也都已落地**，但实现位置在 **`@geewiki/ai` 内部**而非宿主层：`:667` `idleMs: cfg.streamIdleTimeoutMs`、`:669` `onTimeout: () => ac.abort()`、`:684-685` `h.res.on('close', () => { if (!h.res.writableEnded) ac.abort() })`、`:785` 超时日志，常量 `STREAM_IDLE_TIMEOUT_MS = 30_000` / `STREAM_HARD_TIMEOUT_MS = 120_000`（`packages/plugin-ai/src/sse.ts:38` / `:30`）且**刻意不进 `configSchema`**（只能程序化覆盖）。⇒ **真正仍缺的是宿主级的通用长连接治理**：`@geewiki/http` 不提供任何通用超时/背压/心跳，每个要写流的插件都得自己实现这一套（`trackStream` / `closeStreams` 只解决"卸载时收得掉"，不解决"卡住时断得开"）。**一处务必记档的实测结论**：**不要**用"先 `res.writeHead(200, {'content-type':'text/event-stream'})` 再 `h.json(200, null)`"去"只记一次指标"——`writeHead` 后 `res.headersSent` 立即为 `true` 而 `writableEnded` 仍为 `false`，`json()` 会跳过 `writeHead` 却**仍无条件执行 `res.end(JSON.stringify(body))`**，给事件流追加字面 `null` **并立即终结流**（实测客户端正文 `event: status\ndata: {"type":"status"}\n\nnull`）；正解是用 `noteStatus()`。另注：`closeStreams()` **不在 `HttpRouterService` 接口上**，它是 `HttpRouter` 具体类的实现细节（`packages/server/src/index.ts:222`），其他包经 `ctx.get('http')` 拿不到它。详见 [docs/architecture.md](docs/architecture.md) §5.1.1；⑧ **向量 / 语义检索未做（有意后置）**——离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时），当前只留接口位，检索是**纯字面**匹配（FTS5 trigram + LIKE 兜底），因此**同义改写、跨语言、模糊表述都搜不到**；⑨ `snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`）⇒ 前端**不得二次转义**（否则显示成字面 `&lt;mark&gt;`），也**不得**当纯文本插入页面；`score` **只在同一次查询内可比**（非归一化、值域无界，跨查询与跨 `mode` 比大小无意义）；⑩ **wiki 下有 4 个保留首段**——`search` / `ask` / `new` / `list` 都不能再作页面 slug 的首段（前端镜像 `packages/web/src/lib/wikiRoute.ts:31` 的 `WIKI_RESERVED_FIRST_SEGMENTS`，后端有 `RESERVED_FIRST_SEGMENTS` 与之对齐并有守卫测试）；**旧文只列 `search` / `ask` 两项，本批订正为 4 项**；⑪ **密钥**——LLM 侧配置里只存**环境变量名**（`apiKeyEnv`），**环境变量本身**由运维在外部设置；`GET /api/plugins/:name/config` 对**普通配置字段**仍**明文返回**（该边界见 ③），`apiKeyEnv` 只是变量名故不构成泄漏；**但务必注意 `@geewiki/postgres` 的 `password` 是明文密码字段**（与 `passwordEnv` 并存，schema 自述"仅本地开发；生产请改用 passwordEnv"），它会明文落进入库清单——**生产请只用 `connectionStringEnv` / `passwordEnv`，把值放进环境变量**；⑫ `@geewiki/llm` 的 `redact` 是**启发式**——未覆盖的密钥形态不会被脱敏（宁可漏判不可误伤，全大写 SNAKE 命名一律放行，见 `packages/plugin-llm/src/redact.ts` 的 `UPPER_SNAKE_NAME` 主动豁免），且 `text-delta`（模型输出）**刻意不脱敏**（`packages/plugin-llm/src/service.ts:107`，脱敏会篡改模型输出内容）；**该启发式已不再用于配置校验**——`apiKeyEnv` 改用 `credentials.ts` 的白名单 `isEnvVarName`，因为黑名单对 `a1b2c3d4e5f60718293a4b5c6d7e8f90`（32 位 hex）、`ABCDEF1234567890ABCDEF1234567890`（全大写 32 位）、`Xk9mQ2pLvR4tN8w`（16 字符混合）三种随机密钥形态**一条都拦不住**；⑬ **PostgreSQL 与全文检索不兼容**——`@geewiki/search` 的索引建立在 SQLite 专有的 FTS5（`tokenize='trigram'`）之上，**PG 没有 FTS5**；插件在 `apply()` 里**显式抛错拒绝**而不是静默降级（`packages/plugin-search/src/index.ts:305-320`，报错原文含 `@geewiki/search: 当前数据库方言是 ${dialect}，而本插件的全文索引依赖 SQLite 专有的 FTS5（trigram 分词器），暂不支持该方言。请改用 @geewiki/db-sqlite，或等待基于 tsvector 的 PG 检索实现。`）⇒ **切到 PostgreSQL 后 `/api/search` 与 `@geewiki/ai` 的问答都不可用**（PG 侧 `tsvector` 检索属另一个工程，本批未做）；⑭ **无真实屏幕阅读器实测**——无障碍侧只有自动化检查（对比度 / 标题层级 / 编辑区区域的可计算断言，见 `packages/web/test/contrastPlan.test.ts`、`headingPlan.test.ts`、`editorPaneRegions.test.ts` 与 `lib/contrastPlan.ts`），**没有用 NVDA / VoiceOver / TalkBack 等真实读屏软件做过人工验证**；浏览器侧端到端验收 `scripts/acceptance/plugin-ui-cdp.mjs` 同样**只在 Chromium 上跑过**（见 ④）；⑮ **开发期临时产物无清理机制**——`data/` 下堆积着历次批次的验证残留（`data/verify/` 下 25 个子目录，另有 `shots*/`、`spike/`、`a11y-*/`、`docbatch/`、`*.html` 快照、`npm-cache/` 等），**没有任何清理脚本或定期回收**；`data/` 已被 `.gitignore` 排除、不影响仓库体积，但会持续占用本机磁盘。**容器镜像与 Compose 编排已可用**（多阶段 `Dockerfile` + `docker compose up -d --build`，见 [docs/deployment.md](docs/deployment.md)）。详见 [docs/roadmap.md](docs/roadmap.md) 与 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md)（**注意：这两份文档的若干段落尚未跟上本批口径**）。

## 快速开始

环境要求：**Node ≥ 22**、**pnpm 11.x**（见根 `package.json` 的 `engines` 与 `packageManager`）。

```bash
pnpm install   # 安装依赖（含 better-sqlite3 预编译二进制）
pnpm dev       # 一条命令同时启动后端（:3000）与前端开发服务器（:5173）
```

> ⚠️ **必须在仓库根目录执行 `pnpm dev`**：该脚本同时拉起后端与前端。若在 `packages/web` 目录下执行，只会启动 Vite 前端而不启动后端（`packages/web/package.json` 的 `dev` 仅运行 `vite`），前端会因 `/api` 代理不到后端而请求失败。
>
> 补充：应用内部的**路径解析已与进程工作目录解耦**——`data/`、`config/`、`packages/web/dist` 等相对路径一律以**仓库根**为基准（`@geewiki/core` 的 `resolveProjectPath`，依据 `pnpm-workspace.yaml` 定位仓库根），因此后端从任意目录启动都指向同一份数据与配置。
>
> Windows 用户：根 `dev` 脚本使用 POSIX shell 语法（`&`、`$!`、`kill`），请在**两个终端**分别运行 `pnpm dev:server` 与 `pnpm dev:web`。

**开发形态**：浏览器打开 **http://localhost:5173** —— Vite dev server 提供前端（热更新），并把 `/api` **与 `/plugins-ui`** 自动代理到后端 `http://127.0.0.1:3000`（`/plugins-ui` 必须代理：插件 UI 资产可能来自 `plugins/<name>/dist`，位于 Vite `publicDir` 之外）；后端自身也在 3000 提供 REST 接口（可用 `http://127.0.0.1:3000/api/health` 探活）。注意 `pnpm dev` 给后端的是 **`GEEWIKI_PLUGIN_UI_DIST=packages/web/public`**（只改内置**插件 UI 资产根**，让插件 UI 免构建可用；dev 下前端由 Vite 直接提供），`GEEWIKI_WEB_DIST` 仍为默认 `packages/web/dist` —— 后端因此照样能提供 app shell（`http://127.0.0.1:3000/`）。`pnpm dev:server` / `pnpm start` 两项都保持默认。

**生产形态**：先 `pnpm build` 生成前端产物 `packages/web/dist`，再由后端在 **http://127.0.0.1:3000** 直接静态托管该产物 —— 即 `pnpm start`（与 `pnpm dev:server` 是同一条命令：**只起后端、不起 Vite**）。该产物目录已被 `.gitignore` 忽略、**不在版本库中**，因此新克隆的仓库必须先执行 `pnpm build`，否则 3000 端口只有后端 API、没有界面。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | **一条命令同时启动**后端（:3000，`GEEWIKI_PLUGIN_UI_DIST=packages/web/public`）与前端 Vite 开发服务器（:5173，`/api` 与 `/plugins-ui` 均代理到 :3000） |
| `pnpm dev:server` | 仅启动后端 → http://127.0.0.1:3000 |
| `pnpm dev:web` | 仅启动前端开发服务器 → http://localhost:5173（需后端已在 :3000 运行） |
| `pnpm build` | 构建全仓产物（`@geewiki/web` → `packages/web/dist`） |
| `pnpm start` | 与 `pnpm dev:server` 同一条命令：**仅启动后端**（不起 Vite）；生产形态下由后端静态托管 `packages/web/dist` → http://127.0.0.1:3000（需先 `pnpm build`） |
| `pnpm typecheck` | 全仓类型检查（`pnpm -r --no-bail --if-present run typecheck`）。**当前实测：13 个包全部 `Done`、0 个 `error TS`、Exit 0**（取数 `2026-09-11T20:29:55+08:00`，干净工作树 HEAD `1c9e083`；作用域 `Scope: 13 of 14 workspace projects`，`plugins/hello-geewiki` 无 `typecheck` 脚本，被 `--if-present` 跳过）。**⚠️ 一条必须记档的瞬态现象**：在并行批次写入期的 `2026-09-11T00:29` 取数时，同一命令曾**整体失败**，唯一原因是当时新建的 `packages/plugin-openai` 尚不完整——其 `tsconfig.json` 的 `include: ["src","test"]` 里 `test/` 目录还不存在，报 `error TS18003: No inputs were found in config file '/root/dev/geewiki/packages/plugin-openai/tsconfig.json'. Specified 'include' paths were '["src","test"]' and 'exclude' paths were '[]'.`，pnpm 随即以 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @geewiki/openai@0.1.0 typecheck` 中止。该错误随该目录补齐 **自行消失**，现已不可复现。**结论**：这不是已提交代码的缺陷，而是"读工作树"在并行写入期遇到的中间态——报告读数时**须同时给出 HEAD 与取数时刻** |
| `pnpm test` | 运行单元测试（`pnpm -r --no-bail --if-present run test`，各包的 `test` 脚本都是 `node --import tsx --test test/*.test.ts`）。**实测读数：746/746 全绿（9 个包）**，两次同值——取数 `2026-09-11T20:16:33+08:00`（HEAD `787a816` + 并行批次未提交的 `packages/web/{src/lib/domIds.ts, src/pages/WikiPage.tsx, test/editorPaneRegions.test.ts}`）与 `2026-09-11T20:29:55+08:00`（**干净工作树** HEAD `1c9e083`）= `packages/web` **314**（26 个文件：`pluginUiPlan` 38 + `searchPlan` 30 + `commandPlan` 21 + `linkPlan` 20 + `headingPlan` 19 + `aiStreamPlan` 18 + `draftPlan` 16 + `wikilink` 16 + `breadcrumb` 14 + `wikiRoute` 13 + `pageFormPlan` 13 + `navOrder` 12 + `navTree` 12 + `pageMeta` 12 + `hashAnchor` 11 + `pluginDisplay` 8 + `designSystem` 7 + `errorText` 6 + `pageLinksPlan` 6 + `degradedReason` 4 + `areaState` 4 + `slugRules` 4 + `contrastPlan` 3 + `editorPaneRegions` 3 + `editorSlotProps` 2 + `fixtureTokens` 2）+ `packages/manager` **124**（`config` 36 + `manager` 20 + `slots` 19 + `discovery` 18 + `plugin-ui` 18 + `deps` 10 + `repo-paths` 3）+ `packages/plugin-ai` **65**（`ai` 25 + `sse` 20 + `stream` 15 + `queryLengthGuard` 5）+ `packages/server` **53**（`plugin-ui-assets` 14 + `router` 11 + `sse-drain` 11 + `plugin-ui-static` 10 + `builtin-migrations` 4 + `registry` 3）+ `packages/plugin-openai` **49**（`provider` 16 + `sse` 11 + `plugin` 8 + `errors` 7 + `credential-guard` 7）+ `packages/plugin-wiki` **45**（`links` 20 + `service` 16 + `slug-hierarchy` 9）+ `packages/plugin-llm` **41**（`service` 24 + `redact` 9 + `credentials` 8）+ `packages/plugin-search` **40**（`search` 40）+ `packages/db-postgres` **15**（`postgres` 15）。逐文件计数用 `node --import tsx --test <单文件>` 在各包目录下复跑核对。<br>**⚠️ 取数时刻的瞬态（必须记档）**：同一命令在 `2026-09-11T20:14:53` 首次运行时**整体失败**——`[ERR_PNPM_RECURSIVE_FAIL]` / `Summary: 1 fails, 8 passes` / `packages/web: [ERROR] @geewiki/web@0.1.0 test: node --import tsx --test test/*.test.ts Exit status 1`；**紧接着单独复跑 `packages/web` 即 314/314 全绿**，原因是并行批次当时正在写新增的 `test/editorPaneRegions.test.ts`。**该瞬态现已不可复现**（该文件已随并行批次提交为 `1c9e083`，提交后干净工作树复跑 314/314 全绿）。**结论**：这不是已提交代码的缺陷，而是"读工作树"在并行写入期遇到的中间态——报告读数时**须同时给出 HEAD 与取数时刻**。<br>**注意 `packages/core` / `packages/db-sqlite` / `packages/plugin-echo` / `packages/plugin-editor-plain` / `plugins/hello-geewiki` 没有 `test` 脚本**（`--if-present` 跳过）。`--no-bail` 是早前阶段新加的：此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行，故更早的"全量绿"可能是**部分**读数。↑ 历史口径（134/134 三包 → 242/242 七包 → 266/266 七包 → 308/308 八包）均已被本行取代，逐条记录见 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) 第 9 节 |

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | 后端监听端口（优先级：`startServer({ port })` 选项 > 本变量 > 默认值）。**注意**：前端 dev server 的代理目标**不是**从本变量推导的——它由 `GEEWIKI_DEV_API` 单独指定（见下表），**两者不同步**：改了本变量却不设 `GEEWIKI_DEV_API`，开发形态下前后端就断链 |
| `GEEWIKI_DEV_API` | `http://127.0.0.1:3000` | **仅开发形态**：Vite dev server 把 `/api` 与 `/plugins-ui` 代理到的后端地址（`packages/web/vite.config.ts:10`，不再硬编码）。给隔离端口上的验收脚本用（本项目验收纪律要求不得占用 3000/5173） |
| `GEEWIKI_DEV_PORT` | `5173` | **仅开发形态**：Vite dev server 的监听端口（`packages/web/vite.config.ts:11`）。dev server 显式 `host: '::'`（双栈），以免在某些环境下只绑定 IPv6 回环 |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端监听地址（优先级：`startServer({ host })` 选项 > 本变量 > 默认值）；如需仅本机可访问可设为 `127.0.0.1` |
| `GEEWIKI_DATA_DIR` | `./data` | SQLite 数据库与运行时数据目录（库文件 `geewiki.db`、崩溃标记 `crash.marker`）；**相对路径以仓库根为基准**，绝对路径原样使用 |
| `GEEWIKI_CONFIG_DIR` | `./config` | 插件清单目录（`plugins.base.json` / `plugins.session.json`）；相对路径同样以仓库根为基准 |
| `GEEWIKI_WEB_DIST` | `packages/web/dist` | **前端静态产物根**（app shell 的 `index.html`、`/assets/*`、SPA fallback）；**相对路径一律以仓库根为基准**（与进程工作目录无关，故从任意子目录启动都指向同一份产物），绝对路径原样透传。**注意**：本变量只决定"静态服务用哪个根"，`null` 才是"不启用静态服务"（`ServerOptions.webDist: null`）；留空/未设置时根仍解析为默认的 `packages/web/dist`，**未执行 `pnpm build` 时静态层照常启用、只是请求都 404**（`packages/server/src/index.ts:647` 只判 `!root`，不判目录是否存在） |
| `GEEWIKI_PLUGIN_UI_DIST` | 同 `GEEWIKI_WEB_DIST` | **内置插件 UI 资产根**：包含 `plugins-ui/<插件名>/` 的目录，是插件 UI 产物的**第二候选根**（第一候选根是插件自带的 `<插件目录>/dist`）。与 `GEEWIKI_WEB_DIST` **分开配置**——后者供 app shell，本项供插件 UI 资产（dev 下插件 UI 免构建可用，而 app shell 仍走 `packages/web/dist`）。根 `dev` 脚本把它设为 `packages/web/public`；`dev:server` / `start` 保持默认（= `GEEWIKI_WEB_DIST`）。**两个 `null` 语义不同**：`ServerOptions.pluginUiDist: null` = 不用内置根（只看插件自带产物），而 `webDist: null` = 不启用静态服务；环境变量层面留空即等同"未设置 = 回落 `GEEWIKI_WEB_DIST`" |

> 以上相对路径均由 `@geewiki/core` 的 `resolveProjectPath` 以**仓库根**（向上查找 `pnpm-workspace.yaml`）为基准解析，与进程 cwd 无关；启动时 `[@geewiki/http] 静态资源目录: <绝对路径>`（前端产物根）与 `[server] 插件 UI 内置资产根: <绝对路径>` 两条日志可用于核对。

- 零外部依赖默认配置：数据落在 `data/geewiki.db`（WAL + 自动迁移建表）。
- 界面（hash 路由，共 7 态，见 `packages/web/src/lib/wikiRoute.ts`）：`#/wiki` **知识库主页**（约定 slug `home` 的文章：可编辑/版本历史，见下方三条）· `#/wiki/list` 知识库列表（**内置搜索框**/新建）· `#/wiki/new` 新建 · `#/wiki/<slug>` 详情（**支持分层 slug**，编码为 `%2F`）· `#/wiki/<slug>/edit` 编辑 · `#/wiki/search/<q>` 检索结果 · `#/wiki/ask/<q>` 检索增强问答（**支持 SSE 逐字渲染**）· `#/plugins` 插件管理（会话层热启停、schema 自动生成的配置表单——无 schema 插件退回 JSON 编辑、应用并持久化、被跳过的 UI 入口分级展示）· `#/graph` 依赖图（React Flow DAG）。另有 `⌘K` / `/` 唤起的**命令面板**（最近访问 + 操作，`components/CommandPalette.tsx`）与**侧边栏页树**（`components/Sidebar.tsx`）。
- **主页 = 一篇约定 slug 为 `home` 的普通文章**（`packages/web/src/lib/wikiRoute.ts` 的 `HOME_SLUG`）：空 hash / `#/` / `#/wiki` 三种写法**都渲染这篇主页**（此前渲染"知识库列表"），`#/wiki/home` 重定向到 `#/wiki`（同一篇内容，避免两个 URL 两种形态）；列表页退居 `#/wiki/list`，入口是左侧栏新增的「全部页面」与命令面板。主页可编辑、有版本历史，并**与其它的页一样受既有页面权限体系管辖**（档位/继承/发布/块级受限段落全部适用）。
- **主页缺失或读不到时按身份分流（两个面板）**（`packages/web/src/pages/WikiPage.tsx`）：有全局 `editContent` ⇒ 「创建主页」引导，创建入口是 **`#/wiki/new?create=home`**（**不是** `#/wiki/home/new`——后者是**合法 slug**，曾被路由劫持）；匿名/无编辑权 ⇒ 中性面板「主页当前不可访问 —— 可能尚未创建，或未对本身份开放」+ 登录/全部页面/重试。创建入口的文案同时提示：**若主页其实已存在、只是没对当前的你开放，保存会覆盖它的正文**，被覆盖的那一版会作为历史快照留在版本历史里。⚠️ 新建页默认 `visibility='org'` 且未发布（`published_at = NULL`），而 `public` 档**必须同时发布**才对匿名可见 ⇒ **经「创建主页」建出来的主页，匿名访客默认看不到**；要公开就走页面的「权限…」入口设为公开并打开发布开关。
- ⚠️ **升级影响（无迁移步骤、无提示）**：既有部署若库里**已存在 slug 为 `home` 的页面**，它会**直接成为站点主页**，`#/wiki` 的默认落点随之从"列表"变成它。本批**没有**新增配置项、插件或环境变量，也**没有**"站点设置里换主页"的机制——`home` 是**约定值**（将来可加一层 `homeSlug()` 读点）。
- 插件热操作示例：在「插件管理」启用 `@geewiki/echo` 即时挂载 `GET /api/echo`，停用即摘除；启用 `@geewiki/ai` 即时挂载 `POST/GET /api/ai/ask`、**`POST /api/ai/stream`（SSE）** 与 `GET /api/ai/capabilities`；启用 `@geewiki/editor-plain` 后用纯文本编辑器**替换知识库的默认 CodeMirror 编辑区**（`editor` 插槽的第一个真实消费者），停用即回落到内置编辑器；⚠️ **启用它之后附件上传就没了**——`editor` 是单占用插槽，插件占住后内置编辑器（**唯一**支持拖拽/粘贴上传的编辑器）根本不渲染，而 `EditorSlotProps` 契约里没有上传通道；真机实测的现场是「拖入文件 0 个请求、无提示，浏览器还把窗口导航到了那个文件」。故**出厂配置本就不含它**（`config/plugins.base.json` 本批未改动、`git log` 里也从未收录它，故默认不占用 `editor` 插槽；它只由**运行时会话层**启用——管理台写入被 `.gitignore` 忽略的 `config/plugins.session.json`），并在 `EditorSlotOutlet` 加了兜底（阻止默认拖放 + `role="status"` 可见提示）；**第三方编辑器在补上上传能力前不得默认占用 `editor` 插槽**（理由写在 `packages/server/src/index.ts` 的注册条目注释里）；「应用并持久化」把会话变更合并进 `config/plugins.base.json`（**含各自的 `config` 字段**）。⚠️ **基础层插件（`db-sqlite` / `http` / `wiki` / `search`）与声明 `supportsHotReload: false` 的插件（两个数据库插件）不支持热操作**——停用基础层插件返回 409 `base_layer`，启用 `@geewiki/postgres` 返回 409 `hot_reload_not_supported`。
- REST 面：`/api/health`（健康/库表/迁移/**长连接计数**）· `/api/plugins*`（含 `/api/plugins/graph`、**`/api/plugins/slots`**、`/api/plugins/ui`、`/api/plugins/:name/{enable,disable,replace,config}`）· `/api/session` + `/api/session/persist` · `/api/pages*`（含 `:slug/{backlinks,links}`）· **`/api/search`（全文检索，默认启用；`mode=phrase|terms`）** · **`/api/ai/ask` + `/api/ai/stream` + `/api/ai/capabilities`（检索增强问答，需启用 `@geewiki/ai`）**。
- **Docker 部署**：仓库自带多阶段 `Dockerfile` 与 `docker-compose.yml`，容器内以非 root（`node`）运行、数据落在宿主机 `./data`（SQLite）：
  ```bash
  mkdir -p data config plugins && chown -R 1000:1000 data config plugins
  docker compose up -d --build        # → http://localhost:3000
  ```
  镜像已提供并实测（含健康检查、持久化与 SIGTERM 优雅退出）；完整的目录权限、备份、排障与验证清单见 [docs/deployment.md](docs/deployment.md)。本地开发仍推荐 `pnpm dev`。

### 如何启用真实模型（OpenAI 兼容）

**出厂状态下问答恒为 `retrieval-only`**（没有任何可用 provider）。要接上真实模型，需要三件事：**契约层 `@geewiki/llm`** + **一个厂商 adapter `@geewiki/openai`** + **运维在外部提供的凭据**。前三步都可在管理台点完（也可用下面的 REST）。

**① 密钥只在环境里，配置文件里只写变量名。** 密钥值**永远不要**写进插件配置——`config/plugins.*.json` 是入库文件：

```bash
export OPENAI_API_KEY=sk-REPLACE_WITH_YOUR_KEY    # 变量名必须与配置里的 apiKeyEnv 一致
# 自建网关 / 本地 mock 也可以：端点写在 baseUrl 配置项里，无需额外环境变量
```

**② 启用两个插件**（`@geewiki/openai` 需要 `llm-service`，管理器会按服务 token 自动先拉 `@geewiki/llm`）：

```bash
BASE=http://127.0.0.1:3000
curl -s -X POST "$BASE/api/plugins/%40geewiki%2Fllm/enable"    -H 'content-type: application/json' -d '{}'
curl -s -X POST "$BASE/api/plugins/%40geewiki%2Fopenai/enable" -H 'content-type: application/json' -d '{}'
```

**③ 按需改配置**（管理台的「插件管理」会按 schema 自动生成表单，也可直接 PUT）。`@geewiki/openai` 的 `configSchema` 字段（真源 `packages/plugin-openai/src/index.ts:45` 的 `OpenAiConfigSchema`）：

| 字段 | 类型 / 默认 | 说明（schema 里的原文） |
| --- | --- | --- |
| `route` | string，`'openai'` | 路由名（同组内唯一；llm-service 注册表键） |
| `label` | string，`'OpenAI 兼容端点'` | 管理台展示用的中文名 |
| `baseUrl` | string，`'https://api.openai.com/v1'` | 端点根地址（OpenAI 兼容；自建网关或本地 mock 也可） |
| `model` | string，`'gpt-4o-mini'` | 默认模型名 |
| `apiKeyEnv` | string，`'OPENAI_API_KEY'` | 凭据的**环境变量名**（如 `OPENAI_API_KEY`；**此处不要填密钥本身**） |
| `timeoutMs` | number，`60000`（1000–600000） | 单次请求总超时（毫秒） |
| `includeUsage` | boolean，`true` | 请求上游在流末尾附带 token 用量（个别兼容端点不认此字段时请关闭） |

可复制示例（指向一个兼容端点，**全是占位符**）：

```bash
curl -s -X PUT "$BASE/api/plugins/%40geewiki%2Fopenai/config" -H 'content-type: application/json' -d '{
  "config": {
    "route": "main",
    "label": "生产模型",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKeyEnv": "MY_LLM_KEY"
  }
}'
```

**验证**：`curl -s "$BASE/api/ai/capabilities"` 里对应 route 的 `available` 应变成 `true`（`available:false` 时 `message` 会说清是缺凭据还是缺 provider）；`POST "$BASE/api/ai/stream"` 此时才会开始下发 `delta` 帧。服务端日志会打印 `[@geewiki/openai] 已注册路由 …（模型 …，端点 …，凭据环境变量名 …，当前可用/不可用：缺少该环境变量）`（`packages/plugin-openai/src/index.ts:149-153`）。**⚠️ 本批实测范围**：`capabilities` 的 `available:false` 形态与 `stream` 在无 provider 时只发 `status`+`done` 的行为**均已实测**（见下方原始 curl）；但**配好真实凭据后 `available:true` 与 `delta` 帧的实际内容未被任何人实测过**（无凭据可用）——这一句是**基于源码的预期，不是实测结论**。

**几条必须知道的边界**：
- **把密钥值本身填进 `apiKeyEnv` 会让激活直接失败并显式报错**（白名单校验：只接受"全大写 + 至少一个下划线"的环境变量名；报错文本**不回显**该值）。这是刻意的——该字段会落盘进入库清单。
- `@geewiki/openai` 声明了 `conflictGroup: 'llm-provider'`，**与将来的其它厂商 adapter 同组互斥，不能同时启用**。
- 它依赖 `llm-service`（**服务 token**，不是插件名）；`@geewiki/llm` 未激活时它会**显式报错**而不是静默降级。
- **未验证项**：本仓库的自动化测试与本文档作者**都没有跑过真实模型链路**（无凭据可用）。`rag` / `rag-partial` 两条路径目前只有"假 provider"单测覆盖（`packages/plugin-ai/test/ai.test.ts:541`）。**本 README 不声称已端到端验证过真实模型。**

### 如何用 PostgreSQL

包名是 **`@geewiki/postgres`**（`packages/db-postgres/`，**不是** `@geewiki/db-pg`）。它已实现——异步适配器 + schema 化配置 + 自有迁移，与 `@geewiki/db-sqlite` 同属 `conflictGroup: 'database-provider'`（**天然互斥**），并且**默认不启用**：刻意不写进 `config/plugins.base.json`，因为"切库"是显式决策。

**⚠️ 切库是冷操作，不能热切。** 本批实测确认：`@geewiki/postgres` 与 `@geewiki/db-sqlite` 都声明了 `runtime.supportsHotReload: false`，因此

- `POST /api/plugins/%40geewiki%2Fdb-sqlite/disable` → **409 `base_layer`**：`@geewiki/db-sqlite 属于基础层（冷操作），请编辑基础层清单 plugins.base.json 后重启进程`（基础层插件不可热卸载）；
- `POST /api/plugins/%40geewiki%2Fpostgres/enable` → **409 `hot_reload_not_supported`**：`@geewiki/postgres 未声明 runtime.supportsHotReload: true，仅支持持久化安装 + 进程重启（冷操作）`。

**正确步骤**：① 在外部设好连接串环境变量；② **直接编辑 `config/plugins.base.json`**，把 `{"name": "@geewiki/db-sqlite"}` 换成 `@geewiki/postgres` 条目并带上 `config`；③ 重启进程。

```bash
export GEEWIKI_DATABASE_URL='postgres://geewiki:REPLACE_ME@127.0.0.1:5432/geewiki'
```

```jsonc
// config/plugins.base.json —— 把 db-sqlite 换成 postgres（示例，凭据一律用变量名）
{
  "enabled": [
    { "name": "@geewiki/postgres",
      "config": { "connectionStringEnv": "GEEWIKI_DATABASE_URL", "ssl": false } },
    { "name": "@geewiki/http" },
    { "name": "@geewiki/wiki" }
    // ⚠️ 不要同时保留 @geewiki/db-sqlite：两者同属 database-provider 冲突组，互斥
    // ⚠️ 也不建议保留 @geewiki/search：它依赖 SQLite 专有 FTS5，在 PG 方言下会激活失败（见「已知限制」⑬）
  ]
}
```

`@geewiki/postgres` 的 `configSchema` 字段（真源 `packages/db-postgres/src/index.ts:41` 的 `PostgresConfigSchema`）：

| 字段 | 类型 / 默认 | 说明（schema 里的原文） |
| --- | --- | --- |
| `connectionStringEnv` | string，`''` | 存放连接串的**环境变量名**（推荐；留空则用下面的分项配置）。例如 `GEEWIKI_DATABASE_URL` |
| `host` | string，`'127.0.0.1'` | 数据库主机 |
| `port` | number，`5432`（1–65535） | 端口 |
| `database` | string，`'geewiki'` | 库名 |
| `user` | string，`'geewiki'` | 用户名 |
| `passwordEnv` | string，`''` | 存放密码的**环境变量名**（推荐；留空表示无密码）。例如 `GEEWIKI_DB_PASSWORD` |
| `password` | string（`role: password`），`''` | ⚠️ **明文密码（仅本地开发）**——会明文落进入库清单，生产请改用 `passwordEnv` |
| `max` | number，`10`（1–100） | 连接池上限 |
| `connectionTimeoutMillis` | number，`10000` | 建立连接超时（毫秒） |
| `idleTimeoutMillis` | number，`30000` | 空闲连接回收（毫秒） |
| `ssl` | boolean，`false` | 是否使用 SSL |

**关于"`config/plugins.base.json` 能否承载连接配置"**：**能**。本批实测：`PUT /api/plugins/:name/config` 会把 `config` 写进该插件所在清单层的条目上，`POST /api/session/persist`（管理台的「应用并持久化」）再把它并入入库的 `config/plugins.base.json`——条目形状就是 `{ "name": …, "config": { … } }`（`packages/manager/src/index.ts:642` 的 `persistConfig()`，已实测看到 postgres 的完整配置出现在入库文件里）。**所以"把凭据放进环境变量名"是纪律问题而非结构限制**——别把明文密码填 `password` 字段。

**两条必须知道的边界**：① 切到 PostgreSQL 后 **`/api/search` 与 `/api/ai` 的问答都不可用**——`@geewiki/search` 依赖 SQLite 专有的 FTS5，启用时会显式抛错拒绝（详见「已知限制」⑬）；② 本批**未做真实 PG 端到端验证**（本机无 PG 实例可用），只核实了代码路径（`async apply` + `@geewiki/wiki` 已适配异步 `DatabaseAdapter`）与 `packages/db-postgres` 的 15 例单测。`docker-compose.yml` 的 `--profile production` 预留了 Postgres 服务（默认不启动），详见 [docs/deployment.md](docs/deployment.md)。

## 特性亮点

- **开箱即用**：默认仅依赖一个 SQLite 数据库（better-sqlite3）即可运行，实现 0 外部依赖部署。
- **检索与问答开箱可用，且无凭据也能用**：默认部署自带 **SQLite FTS5 全文检索**（`@geewiki/search`，**显式 `trigram` 分词器**解决中文检索，查询 <3 字符时 LIKE 兜底；纯只读增强、不需要任何凭据）；**`@geewiki/ai` 提供检索增强问答，没有 API key 时同样完整可用**——检索永远执行、来源永远返回，只有"生成回答"这一步降级为零成本的**抽取式摘要**，且响应结构与有 key 时**完全一致**（绝不用 4xx/5xx 表达"没有 key"）。
- **AI 能力不绑定厂商**：`@geewiki/llm` 是 route→provider 的**契约层**（稳定错误码枚举 + 终止 chunk 保证 + **服务绝不重试**），因此可组合多家 provider；密钥只以**环境变量名**（`apiKeyEnv`）入库，值由运维在环境中提供。**已自带第一个真实 adapter** `@geewiki/openai`（OpenAI 兼容，`conflictGroup: 'llm-provider'` 保证厂商间互斥），默认不启用——启用步骤见上方「如何启用真实模型」。
- **数据库即互斥插件**：系统通过标准 `DatabaseAdapter` 接口抽象数据库层（见 `packages/core`），SQLite ↔ PostgreSQL 以互斥插件（`conflictGroup: 'database-provider'`）方式切换，业务代码零改动。**`@geewiki/postgres` 已实现**（异步适配器，`packages/db-postgres/`；`@geewiki/wiki` 也已适配异步驱动），但**默认不启用**且切库是**冷操作**（两个数据库插件均 `supportsHotReload: false`）——见上方「如何用 PostgreSQL」。⚠️ **PG 下全文检索不可用**（`@geewiki/search` 依赖 SQLite 专有 FTS5，会显式拒绝，见「已知限制」⑬）。
- **插件管理器（核心大脑）**：依赖拓扑/环检测、会话层沙箱热启停（显式热授权 + 试用期看门狗 + 熔断）、广义冲突组互斥、迁移控制器、持久化清单合并。卸载走统一出口（`disable` / 启停回滚 / `disposeAll`）：先按 `runtime.drainTimeout` **优雅排空**在途 HTTP 请求（超时告警并强制卸载），卸载后对声明 `requiresCachePurge` 的插件广播**缓存清理事件**。**长连接（SSE）出口已与排空共存，且真实流式输出已交付**（提交 `2273006` + `@geewiki/ai` 的 `/api/ai/stream`：`trackStream` 登记的长连接**按 owner 分组、不计入在途**，`closeStreams(owner?)` 卸载时定向回收，`noteStatus` 只记指标而不结束响应，teardown 主动收流；**宿主层仍无通用长连接超时**，超时/取消由插件自管，见「已知限制」⑦）。配置**热更新已落地**（schema 校验 + 原子落盘 + `fork.update()` 热重跑，失败双向回滚）；Slot 为**宿主侧插槽 + 后端下发入口表 + 后端注册链路**（白名单插槽 `app-header` / `app-footer` / **`editor`**，后者是带数据的单占用插槽；`window.__GEEWIKI_HOST__` 宿主 SDK；入口表来自 `GET /api/plugins/ui`，UI 随插件启停自动出现/消失；插件另可经 `ctx.get('slot')` 做运行期 `contribute`）；`editor-toolbar-slots` / `admin-page-slots` 扩展点仍列 Phase 3（见 roadmap）。
- **管理面可视化**：React 19 管理台 —— 插件状态/层/热能力一览、会话层热操作、依赖图（React Flow DAG）、Wiki 页面编辑与版本历史。

## 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis) `cordis@^4.0.0-rc.10` | 依赖注入、事件总线与插件生命周期管理。当前实际安装 `4.0.0-rc.10`（npm `latest` 标签即指向该 RC；3.x 稳定线止于 `3.18.1`，本项目未采用） |
| 开发语言 | TypeScript（Node.js 环境） | — |
| 前端框架 | React 19+ | 管理台基座；插件 UI 经宿主 SDK（`window.__GEEWIKI_HOST__` 暴露 React 单例）+ 插槽注册接入（**当前未用 Suspense / use Hook 做远端 Bundle 懒加载**，见 [docs/architecture.md](docs/architecture.md) §6） |
| 默认数据库 | better-sqlite3 | 零外部依赖，开箱即用 |
| 全文检索 | SQLite **FTS5**（由 better-sqlite3 内置提供）+ **`trigram`** 分词器 | `better-sqlite3@13.0.3` 的**预编译包已含 FTS5**（`compile_options` 有 `ENABLE_FTS5`，内置 SQLite **3.53.4**，实测可直接建 `tokenize='trigram'` 表）⇒ **无需 node-gyp**。显式选 `trigram` 是中文可检索的前提：FTS5 默认的 `unicode61` 把**连续 CJK 当成一个 token**，`MATCH '"知识库"'` 实测 **0 命中**。`trigram` 的硬缺口——查询串 **<3 字符**时 `MATCH` 恒空（中文 2 字词如「检索」）——由插件层的 **LIKE 兜底**覆盖（走 `pages` 真源表，故索引缺失时短查询仍正确）。代价：索引体积与正文**同量级**（自测 5000 行 / 正文 6.23 MB → 索引 +7.07 MB ≈ 1.14×） |
| LLM 接入 | 自研契约层 `@geewiki/llm`（**不绑定厂商**）+ 自带 adapter `@geewiki/openai` | `llm-service` 是 route→provider **注册表**（多 provider 可共存，故不进任何 `conflictGroup`）；**已自带第一个真实 adapter**（OpenAI 兼容，`packages/plugin-openai/`，声明 `conflictGroup: 'llm-provider'` 保证厂商间互斥），但它**默认不启用**且需外部凭据，故**开箱状态下仍无可用 provider、问答恒走 `retrieval-only`**。契约核心是**稳定错误码枚举** + **终止 chunk 恰一次且在末位** + **绝不重试**；密钥只以**环境变量名**（`apiKeyEnv`）入库，值由运维在环境里提供 |
| 问答（RAG） | `@geewiki/ai`（**默认**为检索增强问答的检索-only 形态） | 检索与生成彻底解耦：**没有 API key 时也完整可用**——`200` 一律正常，降级只体现在 `mode` / `degraded` / `answer` 三个字段上，**绝不用 4xx/5xx 表达"没有 key"**；回答降级为零成本**抽取式摘要**，`sources` 永远完整返回。配好 provider 后同一端点、同一响应结构下 `mode` 变为 `rag` / `rag-partial`，并有 `POST /api/ai/stream` 的 SSE 逐帧路径（`event: status \| delta \| done \| error`） |
| 生产数据库 | PostgreSQL（`pg` 驱动，`@geewiki/postgres`） | **已实现**（异步适配器 + schema 化配置 + 自有迁移，15 例单测），与 SQLite 同属 `database-provider` 冲突组互斥；**默认不启用**，切库为**冷操作**（两者均 `supportsHotReload: false`，须改 `config/plugins.base.json` 后重启）。**⚠️ PG 下 `@geewiki/search` 不可用**（依赖 SQLite 专有 FTS5）；本批未做真实 PG 端到端验证 |
| 容器编排 | Docker Compose（Profiles 模式） | 多阶段 `Dockerfile` + `docker compose up -d --build` 已可用（非 root 运行、SQLite 持久化到 `./data`）；`--profile production` 预留 Postgres 服务，默认不启动，详见 [docs/deployment.md](docs/deployment.md) |

**内核版本事实（cordis，2026-09 核实）**：仓库 6 个包（core / db-sqlite / manager / server / plugin-wiki / plugin-echo）统一声明 `"cordis": "^4.0.0-rc.10"`，`pnpm-lock.yaml` 解析并安装 `cordis@4.0.0-rc.10`。npm `dist-tags` 为 `latest = 4.0.0-rc.10`、`next = 4.0.0-beta.5`（即 `pnpm add cordis` 装到的就是该 RC），3.x 序列的最后一个版本是 `3.18.1`。该包本身未声明 `engines` 字段，本项目在 Node 22.23.2 上实测通过（typecheck + 测试 + 运行）。`^4.0.0-rc.10` 按 semver 语义覆盖 `4.0.0` 正式版及其后 4.x，正式版发布后 `pnpm update cordis` 即可升级。另需注意 4.x 的类型发布缺口：`lib/index.d.ts` 的 `export *` 链使 `Context` 的 `provide/get/plugin` 等方法在外部消费时不被解析，本仓库由 `packages/core/src/cordis-env.ts` 的自包含模块增强补齐（详见该文件头注释）。

## 架构总览

分层架构如下（完整设计见 [docs/architecture.md](docs/architecture.md)）：

```
React 19 前端（宿主侧 Slot：`app-header` / `app-footer`（零属性）与 `editor`（带数据、单占用）三个白名单插槽 + `window.__GEEWIKI_HOST__` 单例宿主；插件 UI 按后端下发的入口表 `GET /api/plugins/ui` 从 `/plugins-ui/<插件名>/<入口相对路径>` 加载（支持子目录资产，MIME + 缓存分级）/ 依赖图可视化 / **wiki 内宿主原生的检索与问答界面 `#/wiki/search/<q>`、`#/wiki/ask/<q>`**（问答支持 SSE 逐字渲染））
        │
        │  REST API（HTTP；当前无 WebSocket 通道；SSE 长连接**出口机制已就绪且已接线**，见 docs/architecture.md §5.1.1）
        ▼
Plugin Manager（核心大脑）：热加载引擎、依赖图/冲突组、会话层沙箱机制、迁移控制器、看门狗探针、配置热管理中心、插槽贡献注册表（`ctx.get('slot')`）
        │
        │  服务抽象层 (DI)
        ▼
插件生态（按冲突组划分）：[数据库组: @geewiki/db-sqlite ↔ @geewiki/postgres（已实现，默认不启用，冷切换）] [编辑器组: `editor` 插槽 —— 内置 @geewiki/editor-plain 已接入（**默认不启用**：它会顶掉唯一支持附件上传的内置编辑器，见上）， Milkdown / TipTap 等第三方编辑器仍未做]
        +
AI 层（**不进任何冲突组**，可自由组合）：@geewiki/search（FTS5 + trigram 检索，默认启用）
        → @geewiki/ai（检索增强问答，无 key 时降级为 retrieval-only）→ @geewiki/llm（契约层：route→provider 注册表）
        → @geewiki/openai（OpenAI 兼容 adapter，第一个真实 provider，默认不启用，与其它 adapter 同属 `llm-provider` 冲突组）
```

## 仓库结构

```
geewiki/
├── packages/         # 共 13 个包（`ls -d packages/*/`）
│   ├── core/         # 内核类型与常量：Manifest 规范、DatabaseAdapter 接口、SlotService/EditorSlotProps、cordis 类型增强
│   ├── db-sqlite/    # 默认数据库插件 @geewiki/db-sqlite（better-sqlite3 + SQL 迁移）
│   ├── db-postgres/  # PostgreSQL 插件 @geewiki/postgres（异步适配器 + 自有迁移 + schema 化连接配置，默认不启用、冷切换）
│   ├── manager/      # 插件管理器 @geewiki/manager：依赖图/冲突组/会话层沙箱/迁移控制器/看门狗/插槽注册表（SlotRegistry）
│   ├── server/       # 应用宿主 @geewiki/server：http 服务、静态文件服务（含 /plugins-ui 子目录资产）、内置插件注册表
│   ├── web/          # React 19 管理台 @geewiki/web（Vite 6，7 态 wiki 路由 + #/plugins + #/graph + 命令面板；fixtures/ 为 Slot 验证用示例插件 UI）
│   ├── plugin-wiki/  # Wiki 业务插件 @geewiki/wiki：页面 CRUD（支持分层 slug）+ 版本历史 + 反向链接 + wiki-service 服务
│   ├── plugin-search/# 全文检索插件 @geewiki/search：FTS5(trigram) 索引 + 短语/词元两种模式 + 短词 LIKE 兜底（migrations/0001_search.sql）
│   ├── plugin-llm/   # LLM 契约插件 @geewiki/llm：route→provider 注册表 + 终止保证 + 无 key 降级 + 密钥脱敏（**不含厂商 adapter**）
│   ├── plugin-openai/# OpenAI 兼容 adapter @geewiki/openai：向 llm-service 注册一条真实路由（默认不启用，需外部凭据）
│   ├── plugin-ai/    # AI 问答插件 @geewiki/ai：检索增强问答（RAG），无 key 时降级为 retrieval-only 抽取式摘要；`/api/ai/stream` SSE
│   ├── plugin-editor-plain/ # 纯文本编辑器插件 @geewiki/editor-plain：`editor` 插槽的第一个真实消费者（`slots: ['editor']`）；**默认不启用**（插槽契约无上传通道，启用即失去附件拖拽/粘贴上传）
│   └── plugin-echo/  # 示例插件 @geewiki/echo：热插拔演示（GET /api/echo）
├── config/           # 插件清单：plugins.base.json（默认启用 db-sqlite / http / wiki / search）/ plugins.session.json（运行时改写、不入库）
├── data/             # SQLite 数据库与运行时数据（已在 .gitignore 中排除）
├── docs/
│   ├── architecture.md          # 系统设计文档
│   ├── deployment.md            # Docker 部署指南（镜像构成、目录权限、备份、排障、验证清单）
│   ├── plugin-platform-plan.md  # 插件平台批次方案与内核实证（配置/外部插件/Slot 的落地记录与已知限制）
│   └── roadmap.md               # 开发路线图（Phase 0 – Phase 4）
├── plugins/          # 外部插件目录：<name>/ 一个子目录一个插件，启动时自动发现
│   ├── hello-geewiki/  # 零依赖示例（清单即 package.json 的 geewiki 键；自带前端产物根 dist/）
│   └── ui-demo/        # 插槽/资产演示（dist/ 由 build:fixtures 生成）
├── scripts/acceptance/plugin-ui-cdp.mjs  # 浏览器侧端到端验收（零依赖，直连 CDP，刻意不入 pnpm test）
├── Dockerfile             # 多阶段生产镜像（builder + runtime，非 root 运行）
├── .dockerignore
├── docker-compose.yml     # Compose 编排（默认 SQLite；--profile production 预留 Postgres）
├── LICENSE
└── README.md
```

> 说明：上表 **10 个内置插件**（`@geewiki/db-sqlite`、**`@geewiki/postgres`**、`@geewiki/http`、`@geewiki/echo`、**`@geewiki/editor-plain`**、`@geewiki/llm`、`@geewiki/search`、`@geewiki/wiki`、`@geewiki/ai`、**`@geewiki/openai`**）由代码内注册表（`packages/server/src/index.ts:938` 的 `defaultRegistry()`，`source: 'builtin'`）静态登记；**默认基础层清单只启用 4 个**（`db-sqlite` / `http` / `wiki` / **`search`**），其余 6 个（`postgres` / `echo` / `editor-plain` / `llm` / `ai` / `openai`）**已注册但未启用**（在管理台按需启用；其中 `postgres` 是冷操作、须改基础层清单后重启），因此实测 `GET /api/plugins` 返回 **12 条 = 10 条内置 + 2 条外部**（`issues` 为空）。**`plugins/` 目录下的外部插件已在宿主启动时自动发现并并入同一注册表**（清单取子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json`，见 [docs/architecture.md](docs/architecture.md) §5.8）。
>
> 另注：插件前端 UI 的产物由 `pnpm --filter @geewiki/web run build:fixtures` 单独生成（**不在 `pnpm build` 内**）——它先 `rm -rf packages/web/public/plugins-ui`（**全清**，避免旧生成物残留导致"入口表说就绪、资产却 404"），再构建**三份** bundle：默认 fixture 落 **`plugins/ui-demo/dist/`**、hello 夹具落 **`plugins/hello-geewiki/dist/`**（两者都演示"插件自带产物根"这条链路）、editor 夹具落 **`packages/web/public/plugins-ui/@geewiki/editor-plain/`**（演示内置插件的第二候选根）。`packages/web/public/plugins-ui/` 已被 `.gitignore` 排除（`.gitignore` 的 `packages/web/public/plugins-ui/` 条），两份 `plugins/<名>/dist/` 同样不入库（由通用 `dist/` 条覆盖），且**旧的静态入口表 `registry.json` 已停用**（入口表改由 `GET /api/plugins/ui` 现算，构建脚本不再生成它）——因此新克隆的仓库需先执行该命令，管理台上才会有示例插件 UI；缺失时宿主不会报错，只是入口表把这些插件记入 `skipped: entry_missing`。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：设计哲学、技术栈选型、分层架构、数据库即互斥插件、插件管理器六大子系统、前端 Slot 插槽（宿主侧插槽 + 后端下发入口表）、Manifest 规范、部署模型 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署：快速开始、镜像构成、目录权限、环境变量、数据备份、生命周期自愈、PostgreSQL profile、升级、排障与验证清单 |
| [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) | 插件平台实施记录：内核实证（cordis / schemastery / ESM / **SQLite FTS5 与中文分词**）、批次 A–G 方案、契约裁决、已知限制 L-1…L-20、质量基线与验证纪律 |
| [docs/roadmap.md](docs/roadmap.md) | 开发路线图：Phase 0 – Phase 4 的目标、任务清单与验收口径 |

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
