# GeeWiki

面向团队内部的 AI 原生 Wiki 知识库。

核心哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用）；PostgreSQL 适配规划中（Phase 4），当前尚未提供 PostgreSQL 适配包。

**当前状态：Phase 2 完成 + Phase 3 部分落地** —— 插件管理器（依赖图/冲突组/会话层/看门狗）、Wiki CRUD + 版本历史、React 19 管理台与依赖图均可完整交互；插件配置系统（schema 表单 + 热更新）、外部插件目录发现与前端 Slot（**宿主侧插槽 + 后端下发入口表 + 随插件生命周期自动同步**）均已落地；**全文检索已默认启用**（SQLite FTS5 + `trigram` 分词器解决中文检索 + 短查询 LIKE 兜底），**检索增强问答（RAG）已落地"没有 API key 也完整可用"的检索-only 形态**——LLM 契约层已就绪但**尚无任何厂商 adapter**（边界见下方"已知限制"）。开发路线与阶段进度见 [docs/roadmap.md](docs/roadmap.md)。

**当前实现状态**

- **已完成（Phase 0-2）**：pnpm monorepo 共 **10 个包**；`pnpm dev` 一条命令同时启动后端 http://127.0.0.1:3000 与前端开发服务器 http://localhost:5173（生产形态 `pnpm build` 后用 `pnpm start`，由后端静态托管前端产物）；**7 个内置插件已由代码内注册表静态登记**（`packages/server/src/index.ts` 的 `defaultRegistry()`：`@geewiki/db-sqlite`、`@geewiki/http`、`@geewiki/echo`、`@geewiki/llm`、`@geewiki/search`、`@geewiki/wiki`、`@geewiki/ai`；其中默认基础层清单 `config/plugins.base.json` **启用 4 个**——`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki` / **`@geewiki/search`**，而 `@geewiki/echo`、`@geewiki/llm`、`@geewiki/ai` 属**已注册未启用**，故 `GET /api/plugins` 显示 7 条内置，挂载示例外部插件后为 8 条）；Web 管理台含 `#/wiki`、`#/plugins`、`#/graph` 三个主路由，并在 wiki 下提供 `#/wiki/search/<q>` 与 `#/wiki/ask/<q>` 两个**检索/问答子路由**（宿主原生 UI）；**单元测试全绿，实跑两个读数**（读数 A = 已提交状态 HEAD `585dbac`、`2026-09-10T23:24:15+08:00`，**242/242**；读数 B = 工作树含并行批次对 `packages/plugin-search/**`、`packages/plugin-ai/**` 的未提交改动、`2026-09-10T23:35:15+08:00`，**251/251**；命令均为 `pnpm -r --no-bail --if-present run test`，逐包逐文件明细见下表 `pnpm test` 行），`pnpm typecheck` **10 个包 0 错误**（`Scope: 10 of 11 workspace projects`——`plugins/hello-geewiki` 无 `typecheck` 脚本故被 `--if-present` 跳过）。卸载统一出口已消费 `runtime.drainTimeout`（优雅排空在途 HTTP 请求，超时强制卸载）并在 `requiresCachePurge` 时广播缓存清理事件。
- **插件平台已落地（Phase 3 的既有四条链路）**：
  - **配置系统（schema 驱动）**：manifest 的 `geewiki.configSchema` 采用 [schemastery](https://github.com/shigma/schemastery) 3.18.0；`GET` / `PUT /api/plugins/:name/config` 提供读写，服务端做校验 + 白名单裁剪 + **原子落盘**（先写 `<文件>.tmp` 再 `rename`）；已激活插件经 `fork.update()` 热更新，失败时把进程内配置与磁盘清单**双向回滚**并返回 409。管理台按 schema 自动生成表单（开关 / 数字 / 文本 / 多行 / 枚举 / 字段组 / 列表；`meta.role: 'password'` 渲染为密码输入框），**未声明 schema 的插件退回 JSON 原文编辑框**（不校验、不裁剪）。
  - **外部插件加载**：启动时扫描 `./plugins/<name>/`（`GEEWIKI_PLUGINS_DIR` 可覆盖），清单取子目录 `package.json` 的 `geewiki` 键（优先）或独立 `geewiki.manifest.json`，与内置插件**并入同一注册表、完全同权**；单个插件的清单缺失 / 入口缺失 / 路径越界 / 重名 / 加载抛错都只记一条 issue 并跳过，不阻断宿主启动；发现期问题经 `GET /api/plugins` 的 `issues` 字段对外可见（`{code,dir,message}`，`code` 为八值枚举）。零依赖示例见 `plugins/hello-geewiki/`。
  - **冲突组替换（顶替交互）**：同 `conflictGroup` 的插件除互斥拦截外，可经 `POST /api/plugins/:name/replace` 顶替：先卸载组内已激活的旧插件（连同它当前活跃的传递依赖方），再热激活目标插件，并把依赖方接回新提供者（`skipDeps` 阻止旧插件被当依赖重新拉起）。**前置校验在三类情形下直接拒绝**（均在产生任何副作用之前，故拒绝路径零残留）：① 旧插件（将被顶替者）的**真实激活层**不是 session → 409 `base_layer`（判据是 `managed.layer`，不是 `layerOf()`；同名条目同时在两层清单的叠加态下它以 base 层激活，属冷操作）；② **卸载集合内任一成员**（旧插件 ∪ 其活跃传递依赖方）的真实激活层不是 session → 409 `base_layer`，响应 `details.plugins` 列出基础层成员（活跃的基础层插件不可热卸载，否则接回时会把它在会话层重新落盘、静默改写其持久化层）；③ 被顶替者自身或任一待接回的依赖方，其 `requires` 里的 token 经 `resolveDependency` 解析后指向被顶替者，而目标无法承接（目标的插件名或 `provides` 均不命中）→ 409 `provider_mismatch`（响应 `details` 带 `plugin` / `token` / `target` / `targetProvides` / `violations`）；目标自身依赖它要顶替的插件同样被拒（`details.tokens`，不自洽）。**对外影响**：依赖方**按具体插件名**依赖被顶替者时替换必然被 409 拒绝——按名的边无法由新插件承接，正解是依赖方改为依赖**服务标识**（`provides` token）；这是刻意取舍（宁可 409，也不返回 200 却留下无人提供的服务）。失败会回滚旧插件与依赖方，并**按调用前的条目顺序与原内容复原会话清单**（文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行，故人工编辑过的非规范格式不会被逐字节保留）；回滚也失败时返回 500 `replace_rollback_failed`（该路径下整个卸载集合的会话条目都已消失、内存与磁盘一致，需人工介入；仅代码路径 + 人工推演，**无单测覆盖**）。管理台在启用撞上冲突时弹出顶替确认框（列出被顶替者与**当前活跃的**依赖方，并预告"被卸载插件会短暂不可用约几秒"），用户确认后走该端点；若响应 `replaced: null`（无冲突降级）则提示"冲突已解除，已直接启用（未发生替换）"。
  - **前端 Slot（宿主侧插槽 + 后端下发入口表）**：宿主经 `window.__GEEWIKI_HOST__` 暴露 React 单例与 `registerSlot` / `unregisterSlot`，插件 UI bundle 从 `/plugins-ui/<插件名>/<入口文件名>`（默认 `client.js`）动态加载并注册组件；插槽名是白名单，当前**仅 `app-header` 与 `app-footer`**（未知插槽名告警并忽略），插槽外层包 ErrorBoundary——插件组件抛错只丢该插槽，主界面不白屏。**哪些插件的 UI 该加载由后端下发**：插件在清单里声明 `geewiki.client`（`{ entry?, css? }`，均为**单段文件名**，`entry` 缺省 `client.js`；**未声明 `client` 的插件永不进入口表**——注意它与**后端**入口 `geewiki.entry` 不是一回事）。宿主读 `GET /api/plugins/ui`（每请求由"注册表 × 激活集合 × 产物 stat"现算，只列 active ∩ 声明 `client` ∩ 入口实际存在者，`skipped` 记 `inactive` / `no_client` / `entry_missing` / `invalid_name`；带 `no-store` + `ETag`，`If-None-Match` 命中即 **304**，空表仍 200）；前端按整表 `revision` 与逐插件 `rev` 的差集**先卸后装**，并由管理台动作（即时）+ `visibilitychange` + 15s 可见期轮询自动收敛——**UI 随插件启停自动出现/消失**（外部变更 ≤15s）。资产按**双根**解析：`<插件目录>/dist` 优先、`<GEEWIKI_PLUGIN_UI_DIST>/plugins-ui/<名>` 兜底（该变量**缺省 = `GEEWIKI_WEB_DIST`**，故既有部署行为不变）。**边界见下方"已知限制"。**
- **检索与问答已落地（本阶段新增的 AI 原生能力）**：
  - **全文检索 `@geewiki/search`**（`packages/plugin-search/`，提交 `e6ddfbd`）：`provides: 'search-service'`、`requires: ['database-provider','http-service']`、**不进任何冲突组**、自带迁移 `migrations/0001_search.sql`（FTS5 external content 表 `pages_fts` + 三条同步触发器 + `rebuild` 回填；由管理器的迁移控制器在激活前执行，`migrationsDir = SEARCH_MIGRATIONS_DIR`）。**默认部署即启用**（`config/plugins.base.json` 第 4 条）——纯只读增强、不需要任何凭据。端点 `GET /api/search?q=&limit=&mode=` → `{ok, query, mode:'fts'|'like', queryMode:'phrase'|'terms', total, hits:[{slug,title,snippet,score,updated_at}]}`；**空查询 → 400 `invalid_query`、非法 `limit` → 400 `invalid_limit`**（`limit` 须为 1..100 的整数）、**非法 `mode` → 400 `invalid_mode`**；**`total` 是全量命中数，不受 `limit` 限制**（用 `COUNT(DISTINCT p.id)` 统计，同一行被多个词元命中只计一次）；响应里有两个方向不同的字段——**`mode`** 回传**实际走的那条路径**（`'fts'` / `'like'`，观测用）、**`queryMode`** 回传**本次请求的查询语义**（`'phrase'` 整串字面短语 / `'terms'` 词元 OR，`mode` 参数缺省 `'phrase'`）；`snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`，前端**不得二次转义**）；`score` 是**取负后的 BM25**（越大越相关，**不是归一化**，值域无界，**仅同一次查询内可比**，LIKE 路恒为 0）。
  - **⚠️ 已知：整串按 FTS5 短语匹配，自然语言问句需按词元检索（修复进行中）**。`mode` 缺省为 `'phrase'`——把**整串**当作一个 FTS5 字面短语，这正是搜索框语义（搜什么就要求正文里连续出现什么）；但**自然语言问句**（如「检索增强怎么做」）几乎不可能逐字连续出现在正文里，按短语匹配**恒为 0 命中**，问答的检索地基等于不可用。**修复方案**：新增 `mode: 'terms'`——把查询切成**词元**后以 **OR** 连接（CJK 连续片段取 **3-gram 滑窗**、ASCII 按空白与标点切词且只保留 **≥3 字符**者；每个词元**仍各自加引号当字面量**，注入防护的实现只有一处），并让 `@geewiki/ai` 的问答**一律走 `terms`**；`terms` 切不出词元时（<3 字符、纯标点）**回退 LIKE**，不构造空 `MATCH`。**状态：截至本文取数时刻，该修复已在工作树中实现但尚未提交**——HEAD `585dbac` 的已提交版本仍是"整串短语"（`search(q, { limit })`），工作树改动位于 `packages/plugin-search/src/index.ts` 与 `packages/plugin-ai/src/index.ts`（后者改为 `search(query, { limit, mode: 'terms' })`）。**因此本文不对"问答召回是否正常"下任何断言**，一切以最终提交为准；相关用例数也不稳定（见下表 `pnpm test` 行的读数 A / B）。
  - **FTS5 与中文检索的关键事实（本仓最易被误传的一点，均已在 `better-sqlite3@13.0.3` 上实测复验）**：① `better-sqlite3` 的**预编译包已含 FTS5**（`compile_options` 含 `ENABLE_FTS5`，内置 SQLite **3.53.4**，`tokenize='trigram'` 可直接建表 ⇒ **无需 node-gyp**）；② FTS5 默认的 `unicode61` 分词器把**连续 CJK 当成一个 token** ⇒ `MATCH '"知识库"'` **0 命中**，中文等于搜不到；③ 故**必须显式 `tokenize='trigram'`**（中文 ≥3 字子串可命中；`MATCH '"全文检索"'` 命中，`'"知识库"'` 命中）；④ **trigram 的硬缺口**：查询串 **<3 字符**时 `MATCH` 恒为空（中文 2 字词如「检索」、英文 2 字母都是空结果）⇒ 插件层用 **LIKE 兜底**，且该路径**直接扫 `pages` 真源表而非索引**，故索引缺失/漂移时短查询仍给出正确结果；⑤ 索引体积与正文**同量级**（自测：5000 行、正文合计 6.23 MB → 索引使库文件增长 7.07 MB，约 **1.14×** 正文；`migrations/0001_search.sql` 记录的仓库内实测为 6.6 MB 语料 +7.9 MB）。
  - **LLM 服务契约层 `@geewiki/llm`**（`packages/plugin-llm/`，同批提交 `e6ddfbd`）：`provides: 'llm-service'`、**不进任何 conflictGroup**（它是 route→provider 注册表，互斥应由各 adapter 自己声明）。**本阶段有意不含任何厂商 adapter，故实际没有任何可用 provider**。契约要点：**稳定错误码枚举**（`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` / `NETWORK` / `PROVIDER_ERROR` / `ABORTED`）；调用方**按 code 分支、绝不按 message 文本分支**（`error` chunk 在**结构上就没有 message 字段**）；**终止 chunk 恰一次且在末位**由包装器保证（消费方可无判空 `for await`）；**服务本身绝不重试**。**密钥安全**：配置里只存**环境变量名**（`apiKeyEnv`）而非密钥值——结构上杜绝密钥进入入库的 `config/plugins.base.json`；配套 `detectSuspiciousCredential`（识别"把密钥值本身填进该字段"并让激活失败）与 `redact`（日志/响应脱敏，两者共用同一组正则源）。
  - **检索增强问答 `@geewiki/ai`**（`packages/plugin-ai/`，提交 `585dbac`）：`provides: 'ai-service'`、`requires: ['http-service','database-provider','search-service','llm-service']`（**按服务 token 依赖，非插件名**）、**不进任何冲突组**、显式 `ctx.provide('ai-service', svc)`。端点 `POST` / `GET /api/ai/ask`（`{q, limit?, extractive?}`）与 `GET /api/ai/capabilities`。**核心产品承诺：没有 API key 时也完整可用** —— **`200` 一律正常**（含"未配置密钥"与"检索无结果"），**绝不用 4xx/5xx 表达"没有 key"**；降级时 `mode:'retrieval-only'` + `degraded{reason,code,message}` + **完整 `sources`** + `answer` 为**零成本抽取式摘要**；`400 empty_query`（空查询）/ `400 too_long`（查询串 > **500** 字符）。上下文截断：按 `perSourceChars` 截断后逐条尝试放入，不超 `totalContextChars` / `maxSourcesInContext`，**放不下就整条丢弃**（不做尾部裁切），被丢弃者 `used:false` 且 `n:null`；`sources[].n` 只对 `used:true` 者连续编号；正文一律经 `search-service` 的 `contents()` 取，**不直连 wiki 的 `pages` 表**。`generate()` 是**唯一接线点**（本阶段恒走降级），接 adapter 时只需替换它。
  - **前端检索与问答界面**（`packages/web/`，提交 `dc5885e`）：wiki 内的搜索框与问答界面走 hash 子路由 `#/wiki/search/<q>` 与 `#/wiki/ask/<q>`；**没有改 Slot 机制**（`packages/web/src/lib/slots.tsx` 一行未动，"宿主不向插件传数据"的冻结裁决保持）——搜索/问答是**宿主原生 UI**。降级提示条是**信息性**的（`no_provider` / `missing_credential` → `level: 'info'`，非错误样式）；插件未启用时**静默降级**（入口 disabled + 提示，不产生 console error）。已知取舍：`search` / `ask` 成为 wiki 下的**保留首段 slug**。
  - **平台一致性修复（同批）**：`@geewiki/wiki` 补了真实的 `ctx.provide('wiki-service', svc)`（此前是"只声明 token 不提供服务"）；`@geewiki/echo` **撤掉了** `provides: 'echo-service'`（无消费方，属谎报 token）；根 `package.json` 的 `test` 脚本加了 **`--no-bail`**（此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行 ⇒ 过去的"全量绿"读数可能是**部分**读数）。
- **尚未实现 / 已知限制**：Phase 3 余项——**LLM 厂商 adapter**（OpenAI / Anthropic 等真实 provider）、编辑器组插件（Milkdown / TipTap）、插件级静态资源注入（**已部分落地**：插件可自带 UI 产物根 `<插件目录>/dist`，但只覆盖入口与样式两个单段文件名，不支持任意资源目录与子目录资源），以及后端 `ctx.slot(name, component)` 注册链路与 `editor-toolbar-slots` / `admin-page-slots` 扩展点；Phase 4 的 PostgreSQL 适配（`@geewiki/db-pg`，**已裁决延期**）。**检索与问答侧的边界另见下条 ⑥–⑫。** 另有 **12 条已知限制**：① **Slot 仍无后端注册链路、也无 Suspense + use Hook 懒加载**——不存在 `ctx.slot()`，远端 bundle 仍由加载器显式 `import()`（"不白屏"靠 ErrorBoundary 而非 Suspense Fallback）；且 **ESM 模块实例不回收**——`rev` 变化走 unload → load、同一 URL 命中模块缓存，故**插件产物更新后需整页刷新才生效**；插件 CSS 以 `<link data-plugin-ui=…>` 全局注入、v1 **不做样式隔离**（示例夹具以 `.gw-fixture-*` 前缀命名类名作为约定示范，宿主侧无强制手段），且入口与样式名必须是**单段文件名**，故 `plugins/<name>/dist` 内的**子目录资源（字体/图片等）v1 不支持**（应内联进 bundle）；② 排空粒度是**全站**在途请求，非 owner 级；③ 密码字段的脱敏**只覆盖表单输入框的呈现**——`meta.role: 'password'` 已渲染为 `type="password"` + `autoComplete="new-password"` 输入框，但 `GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层做脱敏）；④ 浏览器侧验收脚本 `scripts/acceptance/plugin-ui-cdp.mjs`（零依赖，Node 内置 WebSocket + 直连 CDP）**刻意不接入 `pnpm test`**——它需要 Chrome、一个运行中的实例与已构建的插件产物；且其**实测只在 Chromium 上进行**（import map 的浏览器基线为 Chrome / Edge 89+、Safari 16.4+、Firefox 108+，本项目不提供降级路径）；⑤ `packages/web/tsconfig.json` 的 `types` 同时含 `vite/client` 与 `node`（为让 `test/*.test.ts` 通过类型检查），因此**若在 `packages/web` 的源码里误用 Node API，类型检查不再拦截**；⑥ **无任何厂商 LLM adapter**——`llm-service` 目前**不存在可用 provider**（只注册了恒不可用的兜底路由 `null`），故问答**恒走 `retrieval-only`**；`packages/plugin-ai` 的 `rag` / `rag-partial` 两条路径**目前仅有"假 provider"的单测覆盖**，无真实模型链路验证；⑦ **流式（SSE）未做，且这是有意的**——长连接在途期间会被**永久计入在途计数**，会让卸载/关停时的优雅排空（`drain`）空转满 `drainTimeout` 并打印**假的排空超时告警**；因此 SSE 出口必须与排空语义一起设计（方案已定：流式响应登记为"不阻塞排空" + 硬超时 / idle 超时 + `res.on('close')` 即取消上游），当前检索与问答均为**一次成型返回**；⑧ **向量 / 语义检索未做（有意后置）**——离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时），当前只留接口位，检索是**纯字面**匹配（FTS5 trigram + LIKE 兜底），因此**同义改写、跨语言、模糊表述都搜不到**；⑨ `snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`）⇒ 前端**不得二次转义**（否则显示成字面 `&lt;mark&gt;`），也**不得**当纯文本插入页面；`score` **只在同一次查询内可比**（非归一化、值域无界，跨查询与跨 `mode` 比大小无意义）；⑩ `search` / `ask` 是 **wiki 下的保留首段 slug**——不能再创建同名页面（判据见 `packages/web/src/pages/WikiPage.tsx:37` 的 `allowedSecond`）；⑪ **密钥**——配置里只存**环境变量名**（`apiKeyEnv`），而**环境变量本身**由运维在外部设置；`GET /api/plugins/:name/config` 对**普通配置字段**仍**明文返回**（该边界见 ③），`apiKeyEnv` 只是变量名故不构成泄漏；⑫ `@geewiki/llm` 的 `redact` 是**启发式**——未覆盖的密钥形态不会被脱敏（宁可漏判不可误伤，全大写 SNAKE 命名一律放行），且 `text-delta`（模型输出）**刻意不脱敏**（脱敏会篡改模型输出内容）。**容器镜像与 Compose 编排已可用**（多阶段 `Dockerfile` + `docker compose up -d --build`，见 [docs/deployment.md](docs/deployment.md)）。详见 [docs/roadmap.md](docs/roadmap.md) 与 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md)。

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
| `pnpm typecheck` | 全仓类型检查（`pnpm -r --if-present run typecheck`）——**实跑 10 个包 0 错误**（取数时刻 `2026-09-10T23:35:29+08:00`；pnpm 报告 `Scope: 10 of 11 workspace projects`，第 11 个 `plugins/hello-geewiki` 无 `typecheck` 脚本，被 `--if-present` 跳过） |
| `pnpm test` | 运行单元测试（`pnpm -r --no-bail --if-present run test`，各包的 `test` 脚本都是 `node --import tsx --test test/*.test.ts`）。**⚠️ 本行有两个实测读数，差别来自一个并行批次的未提交改动，二者都是真读数**：<br>**读数 A（已提交状态 HEAD `585dbac`，取数 `2026-09-10T23:24:15+08:00`）：242/242 全绿** = `packages/manager` **91**（`config` 36 + `deps` 10 + `discovery` 13 + `manager` 14 + `plugin-ui` 15 + `repo-paths` 3）+ `packages/web` **38**（`pluginUiPlan` 19 + `searchPlan` 19）+ `packages/plugin-llm` **33**（`service` 24 + `redact` 9）+ `packages/plugin-search` **25**（`search` 25）+ `packages/server` **24**（`router` 11 + `plugin-ui-static` 10 + `registry` 3）+ `packages/plugin-ai` **23**（`ai` 23）+ `packages/plugin-wiki` **8**（`service` 8）。<br>**读数 B（工作树含并行批次对 `packages/plugin-search/**` 与 `packages/plugin-ai/**` 的未提交改动，取数 `2026-09-10T23:35:15+08:00`）：251/251 全绿** = 仅两包变化：`packages/plugin-search` **32**（+7）、`packages/plugin-ai` **25**（+2），其余五包与读数 A 相同。<br>**因此 `plugin-search` / `plugin-ai` 两行属"待并行批次落地后复核"的不稳定读数**；其余五包已稳定。**`--no-bail` 是本阶段新加的**：此前 `pnpm -r` 会在**首个失败包处中止**、后续包根本不执行，故过去的"全量绿"可能是**部分**读数。注意 `packages/core` / `packages/db-sqlite` / `packages/plugin-echo` / `plugins/hello-geewiki` **没有 `test` 脚本**（`--if-present` 跳过）。↑ 旧口径（134/134，仅 web/manager/server 三包）已被本行取代 |

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | 后端监听端口（优先级：`startServer({ port })` 选项 > 本变量 > 默认值）。注意：前端 dev server 的 `/api` 代理目标在 `packages/web/vite.config.ts:9` 中硬编码为 `http://127.0.0.1:3000`，**改动本变量需同步修改该代理配置**，否则开发形态下前后端断链 |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端监听地址（优先级：`startServer({ host })` 选项 > 本变量 > 默认值）；如需仅本机可访问可设为 `127.0.0.1` |
| `GEEWIKI_DATA_DIR` | `./data` | SQLite 数据库与运行时数据目录（库文件 `geewiki.db`、崩溃标记 `crash.marker`）；**相对路径以仓库根为基准**，绝对路径原样使用 |
| `GEEWIKI_CONFIG_DIR` | `./config` | 插件清单目录（`plugins.base.json` / `plugins.session.json`）；相对路径同样以仓库根为基准 |
| `GEEWIKI_WEB_DIST` | `packages/web/dist` | **前端静态产物根**（app shell 的 `index.html`、`/assets/*`、SPA fallback）；**相对路径一律以仓库根为基准**（与进程工作目录无关，故从任意子目录启动都指向同一份产物），绝对路径原样透传。**注意**：本变量只决定"静态服务用哪个根"，`null` 才是"不启用静态服务"（`ServerOptions.webDist: null`）；留空/未设置时根仍解析为默认的 `packages/web/dist`，**未执行 `pnpm build` 时静态层照常启用、只是请求都 404**（`packages/server/src/index.ts:458-462` 只判 `!root`，不判目录是否存在） |
| `GEEWIKI_PLUGIN_UI_DIST` | 同 `GEEWIKI_WEB_DIST` | **内置插件 UI 资产根**：包含 `plugins-ui/<插件名>/` 的目录，是插件 UI 产物的**第二候选根**（第一候选根是插件自带的 `<插件目录>/dist`）。与 `GEEWIKI_WEB_DIST` **分开配置**——后者供 app shell，本项供插件 UI 资产（dev 下插件 UI 免构建可用，而 app shell 仍走 `packages/web/dist`）。根 `dev` 脚本把它设为 `packages/web/public`；`dev:server` / `start` 保持默认（= `GEEWIKI_WEB_DIST`）。**两个 `null` 语义不同**：`ServerOptions.pluginUiDist: null` = 不用内置根（只看插件自带产物），而 `webDist: null` = 不启用静态服务；环境变量层面留空即等同"未设置 = 回落 `GEEWIKI_WEB_DIST`" |

> 以上相对路径均由 `@geewiki/core` 的 `resolveProjectPath` 以**仓库根**（向上查找 `pnpm-workspace.yaml`）为基准解析，与进程 cwd 无关；启动时 `[@geewiki/http] 静态资源目录: <绝对路径>`（前端产物根）与 `[server] 插件 UI 内置资产根: <绝对路径>` 两条日志可用于核对。

- 零外部依赖默认配置：数据落在 `data/geewiki.db`（WAL + 自动迁移建表）。
- 界面（hash 路由）：`#/wiki` 知识库（列表/**内置搜索框**/编辑/Markdown/版本历史）· `#/wiki/search/<q>` 检索结果 · `#/wiki/ask/<q>` 检索增强问答 · `#/plugins` 插件管理（会话层热启停、schema 自动生成的配置表单——无 schema 插件退回 JSON 编辑、应用并持久化）· `#/graph` 依赖图（React Flow DAG）。
- 插件热操作示例：在「插件管理」启用 `@geewiki/echo` 即时挂载 `GET /api/echo`，停用即摘除；启用 `@geewiki/ai` 即时挂载 `POST/GET /api/ai/ask` 与 `GET /api/ai/capabilities`；「应用并持久化」把会话变更合并进 `config/plugins.base.json`。
- REST 面：`/api/health`（健康/库表/迁移）· `/api/plugins*` · `/api/pages*` · **`/api/search`（全文检索，默认启用）** · **`/api/ai/ask` + `/api/ai/capabilities`（检索增强问答，需启用 `@geewiki/ai`）**。
- **Docker 部署**：仓库自带多阶段 `Dockerfile` 与 `docker-compose.yml`，容器内以非 root（`node`）运行、数据落在宿主机 `./data`（SQLite）：
  ```bash
  mkdir -p data config plugins && chown -R 1000:1000 data config plugins
  docker compose up -d --build        # → http://localhost:3000
  ```
  镜像已提供并实测（含健康检查、持久化与 SIGTERM 优雅退出）；完整的目录权限、备份、排障与验证清单见 [docs/deployment.md](docs/deployment.md)。本地开发仍推荐 `pnpm dev`。

## 特性亮点

- **开箱即用**：默认仅依赖一个 SQLite 数据库（better-sqlite3）即可运行，实现 0 外部依赖部署。
- **检索与问答开箱可用，且无凭据也能用**：默认部署自带 **SQLite FTS5 全文检索**（`@geewiki/search`，**显式 `trigram` 分词器**解决中文检索，查询 <3 字符时 LIKE 兜底；纯只读增强、不需要任何凭据）；**`@geewiki/ai` 提供检索增强问答，没有 API key 时同样完整可用**——检索永远执行、来源永远返回，只有"生成回答"这一步降级为零成本的**抽取式摘要**，且响应结构与有 key 时**完全一致**（绝不用 4xx/5xx 表达"没有 key"）。
- **AI 能力不绑定厂商**：`@geewiki/llm` 是 route→provider 的**契约层**（稳定错误码枚举 + 终止 chunk 保证 + **服务绝不重试**），因此可组合多家 provider；密钥只以**环境变量名**入库，值由运维在环境中提供。厂商 adapter 属后续批次。
- **数据库即互斥插件**：系统通过标准 `DatabaseAdapter` 接口抽象数据库层（见 `packages/core`），SQLite ↔ PostgreSQL 以互斥插件（conflictGroup）方式切换，业务代码零改动；PostgreSQL 适配包 `@geewiki/db-pg` 属 Phase 4 规划，尚未实现。
- **插件管理器（核心大脑）**：依赖拓扑/环检测、会话层沙箱热启停（显式热授权 + 试用期看门狗 + 熔断）、广义冲突组互斥、迁移控制器、持久化清单合并。卸载走统一出口（`disable` / 启停回滚 / `disposeAll`）：先按 `runtime.drainTimeout` **优雅排空**在途 HTTP 请求（超时告警并强制卸载），卸载后对声明 `requiresCachePurge` 的插件广播**缓存清理事件**。配置**热更新已落地**（schema 校验 + 原子落盘 + `fork.update()` 热重跑，失败双向回滚）；前端 Slot 为**宿主侧插槽 + 后端下发入口表**（`app-header` / `app-footer` 两个白名单插槽 + `window.__GEEWIKI_HOST__` 宿主 SDK；入口表来自 `GET /api/plugins/ui`，UI 随插件启停自动出现/消失）；后端 `ctx.slot()` 注册链路与 `editor-toolbar-slots` / `admin-page-slots` 扩展点仍列 Phase 3（见 roadmap）。
- **管理面可视化**：React 19 管理台 —— 插件状态/层/热能力一览、会话层热操作、依赖图（React Flow DAG）、Wiki 页面编辑与版本历史。

## 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis) `cordis@^4.0.0-rc.10` | 依赖注入、事件总线与插件生命周期管理。当前实际安装 `4.0.0-rc.10`（npm `latest` 标签即指向该 RC；3.x 稳定线止于 `3.18.1`，本项目未采用） |
| 开发语言 | TypeScript（Node.js 环境） | — |
| 前端框架 | React 19+ | 管理台基座；插件 UI 经宿主 SDK（`window.__GEEWIKI_HOST__` 暴露 React 单例）+ 插槽注册接入（**当前未用 Suspense / use Hook 做远端 Bundle 懒加载**，见 [docs/architecture.md](docs/architecture.md) §6） |
| 默认数据库 | better-sqlite3 | 零外部依赖，开箱即用 |
| 全文检索 | SQLite **FTS5**（由 better-sqlite3 内置提供）+ **`trigram`** 分词器 | `better-sqlite3@13.0.3` 的**预编译包已含 FTS5**（`compile_options` 有 `ENABLE_FTS5`，内置 SQLite **3.53.4**，实测可直接建 `tokenize='trigram'` 表）⇒ **无需 node-gyp**。显式选 `trigram` 是中文可检索的前提：FTS5 默认的 `unicode61` 把**连续 CJK 当成一个 token**，`MATCH '"知识库"'` 实测 **0 命中**。`trigram` 的硬缺口——查询串 **<3 字符**时 `MATCH` 恒空（中文 2 字词如「检索」）——由插件层的 **LIKE 兜底**覆盖（走 `pages` 真源表，故索引缺失时短查询仍正确）。代价：索引体积与正文**同量级**（自测 5000 行 / 正文 6.23 MB → 索引 +7.07 MB ≈ 1.14×） |
| LLM 接入 | 自研契约层 `@geewiki/llm`（**不绑定厂商**） | `llm-service` 是 route→provider **注册表**（多 provider 可共存，故不进任何 `conflictGroup`）；**本阶段不含任何厂商 adapter，因此实际无可用 provider**，问答恒走 `retrieval-only`。契约核心是**稳定错误码枚举** + **终止 chunk 恰一次且在末位** + **绝不重试**；密钥只以**环境变量名**（`apiKeyEnv`）入库，值由运维在环境里提供 |
| 问答（RAG） | `@geewiki/ai`（检索增强问答的**检索-only 形态**） | 检索与生成彻底解耦：**没有 API key 时也完整可用**——`200` 一律正常，降级只体现在 `mode` / `degraded` / `answer` 三个字段上，**绝不用 4xx/5xx 表达"没有 key"**；回答降级为零成本**抽取式摘要**，`sources` 永远完整返回 |
| 生产数据库 | PostgreSQL（pg 驱动） | 适配规划中（Phase 4），当前尚未提供适配包 |
| 容器编排 | Docker Compose（Profiles 模式） | 多阶段 `Dockerfile` + `docker compose up -d --build` 已可用（非 root 运行、SQLite 持久化到 `./data`）；`--profile production` 预留 Postgres 服务，默认不启动，详见 [docs/deployment.md](docs/deployment.md) |

**内核版本事实（cordis，2026-09 核实）**：仓库 6 个包（core / db-sqlite / manager / server / plugin-wiki / plugin-echo）统一声明 `"cordis": "^4.0.0-rc.10"`，`pnpm-lock.yaml` 解析并安装 `cordis@4.0.0-rc.10`。npm `dist-tags` 为 `latest = 4.0.0-rc.10`、`next = 4.0.0-beta.5`（即 `pnpm add cordis` 装到的就是该 RC），3.x 序列的最后一个版本是 `3.18.1`。该包本身未声明 `engines` 字段，本项目在 Node 22.23.2 上实测通过（typecheck + 测试 + 运行）。`^4.0.0-rc.10` 按 semver 语义覆盖 `4.0.0` 正式版及其后 4.x，正式版发布后 `pnpm update cordis` 即可升级。另需注意 4.x 的类型发布缺口：`lib/index.d.ts` 的 `export *` 链使 `Context` 的 `provide/get/plugin` 等方法在外部消费时不被解析，本仓库由 `packages/core/src/cordis-env.ts` 的自包含模块增强补齐（详见该文件头注释）。

## 架构总览

分层架构如下（完整设计见 [docs/architecture.md](docs/architecture.md)）：

```
React 19 前端（宿主侧 Slot：`app-header` / `app-footer` 两个插槽 + `window.__GEEWIKI_HOST__` 单例宿主；插件 UI 按后端下发的入口表 `GET /api/plugins/ui` 从 `/plugins-ui/<插件名>/<入口文件名>` 加载 / 依赖图可视化 / **wiki 内宿主原生的检索与问答界面 `#/wiki/search/<q>`、`#/wiki/ask/<q>`**）
        │
        │  REST API（HTTP；当前无 WebSocket 通道）
        ▼
Plugin Manager（核心大脑）：热加载引擎、依赖图/冲突组、会话层沙箱机制、迁移控制器、看门狗探针、配置热管理中心
        │
        │  服务抽象层 (DI)
        ▼
插件生态（按冲突组划分）：[数据库组: SQLite / PG] [编辑器组: Milkdown / TipTap]
        +
AI 层（**不进任何冲突组**，可自由组合）：@geewiki/search（FTS5 + trigram 检索，默认启用）
        → @geewiki/ai（检索增强问答，无 key 时降级为 retrieval-only）→ @geewiki/llm（契约层：route→provider 注册表，本阶段尚无厂商 adapter）
```

## 仓库结构

```
geewiki/
├── packages/
│   ├── core/         # 内核类型与常量：Manifest 规范、DatabaseAdapter 接口、cordis 类型增强
│   ├── db-sqlite/    # 默认数据库插件 @geewiki/db-sqlite（better-sqlite3 + SQL 迁移）
│   ├── manager/      # 插件管理器 @geewiki/manager：依赖图/冲突组/会话层沙箱/迁移控制器/看门狗
│   ├── server/       # 应用宿主 @geewiki/server：http 服务、静态文件服务与内置插件注册表
│   ├── web/          # React 19 管理台 @geewiki/web（Vite 6，路由 #/wiki、#/plugins、#/graph + #/wiki/search/<q>、#/wiki/ask/<q> 子路由；fixtures/ 为 Slot 验证用示例插件 UI）
│   ├── plugin-wiki/  # Wiki 业务插件 @geewiki/wiki：页面 CRUD + 版本历史 REST + wiki-service 服务
│   ├── plugin-search/# 全文检索插件 @geewiki/search：FTS5(trigram) 索引 + 短词 LIKE 兜底（migrations/0001_search.sql）
│   ├── plugin-llm/   # LLM 契约插件 @geewiki/llm：route→provider 注册表 + 终止保证 + 无 key 降级 + 密钥脱敏（**不含厂商 adapter**）
│   ├── plugin-ai/    # AI 问答插件 @geewiki/ai：检索增强问答（RAG），无 key 时降级为 retrieval-only 抽取式摘要
│   └── plugin-echo/  # 示例插件 @geewiki/echo：热插拔演示（GET /api/echo）
├── config/           # 插件清单：plugins.base.json（默认启用 db-sqlite / http / wiki / search）/ plugins.session.json
├── data/             # SQLite 数据库与运行时数据（已在 .gitignore 中排除）
├── docs/
│   ├── architecture.md          # 系统设计文档
│   ├── deployment.md            # Docker 部署指南（镜像构成、目录权限、备份、排障、验证清单）
│   ├── plugin-platform-plan.md  # 插件平台批次方案与内核实证（配置/外部插件/Slot 的落地记录与已知限制）
│   └── roadmap.md               # 开发路线图（Phase 0 – Phase 4）
├── plugins/          # 外部插件目录：<name>/ 一个子目录一个插件，启动时自动发现（零依赖示例 hello-geewiki/）
├── Dockerfile             # 多阶段生产镜像（builder + runtime，非 root 运行）
├── .dockerignore
├── docker-compose.yml     # Compose 编排（默认 SQLite；--profile production 预留 Postgres）
├── LICENSE
└── README.md
```

> 说明：上表 **7 个内置插件**（`@geewiki/db-sqlite`、`@geewiki/http`、`@geewiki/echo`、`@geewiki/llm`、`@geewiki/search`、`@geewiki/wiki`、`@geewiki/ai`）由代码内注册表（`packages/server/src/index.ts` 的 `defaultRegistry()`，`source: 'builtin'`）静态登记；**默认基础层清单只启用 4 个**（`db-sqlite` / `http` / `wiki` / **`search`**），`echo` / `llm` / `ai` **已注册但未启用**（在管理台按需热启用），因此 `GET /api/plugins` 显示 7 条内置，挂载示例外部插件后为 8 条。**`plugins/` 目录下的外部插件已在宿主启动时自动发现并并入同一注册表**（清单取子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json`，见 [docs/architecture.md](docs/architecture.md) §5.8）。
>
> 另注：插件前端 UI 的产物由 `pnpm --filter @geewiki/web run build:fixtures` 单独生成（**不在 `pnpm build` 内**）——它先 `rm -rf packages/web/public/plugins-ui`（**全清**，避免旧生成物残留导致"入口表说就绪、资产却 404"），再构建两份 bundle：默认 fixture 落 `packages/web/public/plugins-ui/@geewiki/wiki/`，hello 夹具落 **`plugins/hello-geewiki/dist/`**（演示"插件自带产物根"这条链路）。`packages/web/public/plugins-ui/` 已被 `.gitignore` 排除（`.gitignore` 的 `packages/web/public/plugins-ui/` 条），hello 的 `plugins/hello-geewiki/dist/` 同样不入库（由通用 `dist/` 条覆盖），且**旧的静态入口表 `registry.json` 已停用**（入口表改由 `GET /api/plugins/ui` 现算，构建脚本不再生成它）——因此新克隆的仓库需先执行该命令，管理台上才会有示例插件 UI；缺失时宿主不会报错，只是入口表把这些插件记入 `skipped: entry_missing`。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：设计哲学、技术栈选型、分层架构、数据库即互斥插件、插件管理器六大子系统、前端 Slot 插槽（宿主侧插槽 + 后端下发入口表）、Manifest 规范、部署模型 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署：快速开始、镜像构成、目录权限、环境变量、数据备份、生命周期自愈、PostgreSQL profile、升级、排障与验证清单 |
| [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) | 插件平台实施记录：内核实证（cordis / schemastery / ESM / **SQLite FTS5 与中文分词**）、批次 A–G 方案、契约裁决、已知限制 L-1…L-20、质量基线与验证纪律 |
| [docs/roadmap.md](docs/roadmap.md) | 开发路线图：Phase 0 – Phase 4 的目标、任务清单与验收口径 |

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
