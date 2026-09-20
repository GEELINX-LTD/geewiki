# GeeWiki 开发路线图

> 本文档只回答"**接下来做什么**"。**已完成且形态未被推翻的事项不在此复述**——逐批历史见
> [changelog/implementation-log.md](./changelog/implementation-log.md)，当前实现口径见
> [architecture.md](./architecture.md)。凡数量口径（内置插件数、启用条数、插槽、端点数）一律以
> `defaultRegistry()`（`packages/server/src/index.ts`）与 `config/plugins.base.example.json`
> （随版本发布的默认启用清单；`plugins.base.json` 是**本机现状**、不入库，不能当口径）为真源。
> 任务清单中的"清单文件"指 `plugins.base.json` / `plugins.session.json`，"双层状态"指基础层（Base Layer）与会话层（Session Layer）。

## 阶段总览

| 阶段 | 主题 | 状态 |
| --- | --- | --- |
| Phase 0 | 基础骨架 | ✅ 完成（`07bb411`） |
| Phase 1 | 插件管理器 | ✅ 完成（`e97ce6b`） |
| Phase 2 | 前端可视化 + Wiki MVP | ✅ 完成（`75a634b`） |
| Phase 3 | AI 原生能力（Slots / LLM 契约层 / 检索地基 / 工具与会话层） | ✅ 主体完成（P0–P8）；剩余项见下文 |
| Phase 4 | 稳定性加固（PostgreSQL 适配、配置热更新表单、容器与 Compose） | ✅ 主体完成；剩余项见下文 |

## 当前读数（本文唯一一处当前读数）

- **`pnpm test`：exit 0，全绿。** **`pnpm typecheck`：exit 0，0 个 `error TS`。**
- **取数命令**（根目录）：`pnpm test`、`pnpm typecheck`；包总数 `ls -d packages/*/`；
  有 `test` 脚本的包数 `node -e "…"` 或逐包 `pnpm --filter <pkg> test` 现取。
- **本文刻意不写死包数与用例数**：它们随每次提交漂移，写死必然过期。

---

## Phase 0：基础骨架 ✅

**交付**：`packages/core`（Manifest 规范类型 + DatabaseAdapter + 常量 + cordis-env 类型增强面）、`packages/db-sqlite`（better-sqlite3 适配器 + `src/migrations` SQL 迁移 + `0001_init.sql` 建 pages/page_versions）、`packages/server`（组合根：引导 manager，http 服务 + 健康检查）、pnpm workspace + tsconfig base + docker-compose 骨架 + docs。

**验收**：最小形态启动冒烟通过（db-sqlite 自动迁移建表、健康检查返回库表与迁移清单、SIGINT/TERM 优雅退出链路验证）。

## Phase 1：插件管理器 ✅

**交付**：`packages/manager`——

- 依赖解析 `resolveDependency`（按插件名或 provides）/ `directDependencies` / `topologicalOrder`（字母序稳定 + 环检测抛错）/ `collectDependents`（反向依赖）/ `collectDependentsClosure`（传递依赖方闭包，供冲突组替换）/ `findUncoveredRequires`（替换的提供者覆盖校验）/ `findConflict`（conflictGroup 同组互斥）/ `checkHotChain`（热插件依赖未激活冷依赖即违规）——纯函数，单测见 `packages/manager/test/deps.test.ts`。
- Session/Base 双层清单（`plugins.base.json` + `plugins.session.json`）合并去重装配；boot 逐个拓扑激活、失败记 `bootErrors` 继续。
- `enable()`：会话层热操作——热授权（`supportsHotReload !== true` → 409 `hot_reload_not_supported`）、热链检查、未激活依赖递归启用、激活后写 session 文件。
- `disable()`：存在依赖者 → 409 `has_dependents`；**基础层插件可临时停用**（只登记在内存、不落盘，重启即恢复，见 architecture §5.3）；卸载（`fiber.dispose()`）并清 session 记录。
- `persistSession()`：会话合并进 base 清单（"应用并持久化"），重启后以 base 层激活。
- 迁移控制器：entry 声明 `migrationsDir` 且 db 可用时，激活前 `db.migrate(dir)`，失败阻止加载。
- 看门狗：5s 探针——session 插件试用期内健康检查连续失败 → 自动 disable 回滚；连续失败 ≥3 且会话非空 → 熔断（清 session 文件 + `process.exit(1)`，容器自愈联动）。
- REST：`GET /api/plugins`（snapshot：state/layer/hotReloadable/provides/requires/conflictGroup/migrations/config/error）、`GET /api/plugins/graph`（React Flow DAG：nodes+edges）、`GET /api/session`、`POST /api/plugins/:name/enable|disable`、`POST /api/plugins/:name/replace`（冲突组顶替）、`POST /api/session/persist`。错误 → HTTP 映射（404/409/400/500）。

**验收**：enable/disable/persist/重启持久化/409 校验/看门狗回滚全链路实测通过。

## Phase 2：前端可视化 + Wiki MVP ✅

**交付**：

- `packages/web`（React 19 + Vite + @xyflow/react + marked，零 UI 框架依赖，中文界面）：
  - `#/wiki` 知识库：页面列表 / 详情（Markdown 渲染）/ 编辑与实时预览 / 新建（slug 校验）/ 删除 / 版本历史时间线（查看快照、一键恢复旧版本）。
  - `#/plugins` **插件管理（含依赖图）**：状态统计条、插件表（状态/层/热冷徽章/提供与依赖 chip）、会话层热"启用"（行内 JSON 配置编辑）、"停用"、异常重试、基础层清单托管提示、会话变更面板 + "应用并持久化"、bootErrors 展示，以及 React Flow 渲染的插件 DAG（内置分层布局：被依赖方居左，无 dagre 依赖）、状态着色节点 + 图例 + 缩放控件。
    **「插件管理」与「依赖图」是同一页 `GraphPage.tsx`**；**主路由是 `#/plugins`**，老链接 `#/graph` 在路由解析处改写成 `#/plugins`（`packages/web/src/App.tsx:316`）。
- `packages/plugin-wiki`（`@geewiki/wiki` 核心业务插件，requires http+db，热授权）：
  - `GET/PUT/DELETE /api/pages(/:slug)` + `GET /api/pages/:slug/versions/:id`；upsert 幂等（内容未变不产生版本）；每次保存先快照旧正文至 `page_versions`；删除显式事务级联清历史；body 大小/形状校验。
- `packages/server`：静态文件服务（`packages/web/dist` 或 `GEEWIKI_WEB_DIST`）——扩展名 MIME、hash asset 永久缓存、SPA fallback（无扩展名路径）、`/api/*` 404 与静态互不干扰；`dispatch()` 返回接管语义；204/304 无响应体。`/plugins-ui/**` 走**独立分支**（按名查根、**绝不 SPA fallback**，缺失即 404 `application/json`；其"内置根"由 `GEEWIKI_PLUGIN_UI_DIST` 指定、**缺省 = `webDist`**——app shell 产物根与内置插件 UI 资产根已拆为两个独立配置项，见 architecture §6 与 [plugin-platform.md](./plugin-platform.md)），其根表由 `pluginUiRootsFor()` **每请求现算**（禁止缓存，见 architecture §6）。`@geewiki/wiki` 纳入 default registry 与默认 base 清单。

**验收**：headless Chrome（playwright chromium 1228）真实渲染路由——列表含 API 数据、插件表状态正确、React Flow 画布出节点、详情页 Markdown 渲染与版本历史齐全；全仓 typecheck 全绿、`vite build` 通过；REST 冒烟（创建/幂等/版本/历史读取/删除/409）全过。

---

## Phase 3：AI 原生能力 —— 已完成部分（P0–P8）

以下事项**均已完成**，这里只保留结论与真源位置；形态细节见
[design/ai-plugin-architecture.md](./design/ai-plugin-architecture.md)。

- [x] **LLM 契约层**：`@geewiki/llm`（route→provider 注册表 + 稳定错误码枚举 + 终止 chunk 保证 + **绝不重试** + 密钥只存 secret 字段或环境变量名 + 日志/响应脱敏）。**有意不含任何厂商 adapter**——adapter 在 `@geewiki/openai`。见 architecture §9.4。
- [x] **检索地基**：`@geewiki/search`（SQLite FTS5 + **`trigram`** 中文分词 + 短词 LIKE 兜底），端点 `GET /api/search?q=&limit=&mode=`，**默认部署即启用**（`config/plugins.base.json` 第 9 条）。中文检索的实测事实见 architecture §9.3。
- [x] **检索召回缺陷修复**：`mode` 缺省为 `phrase` 时自然语言问句**恒为 0 命中**，故 AI 检索路径改为**显式传** `mode: 'terms'`（`packages/plugin-ai-kb/src/index.ts:262`；检索端点自身的缺省**仍是** `phrase`，见 `packages/plugin-search/src/index.ts:748`）—— CJK 取 3-gram 滑窗、ASCII 只保留 ≥3 字符词元。**仍成立的边界**：`mode=terms` **未接入 Web UI**（搜索框保持 `phrase` 语义）；terms 召回更宽、精确率低于短语检索。
- [x] **AI 工具调用（P0）**：tools 透传（`LlmRequest.tools` / `toolChoice`、`role: 'tool'` 消息、`tool-call-delta` chunk、`done.finishReason`），拼装收敛到全仓唯一一份 `assembleToolCalls()`（`packages/plugin-llm/src/tools.ts`）。
- [x] **AI 工具总线与知识库工具（P1）**：`@geewiki/ai-tools`（`provides: 'ai-tool-service'`，纯注册表）与 `@geewiki/ai-kb`（`list_pages` / `search_kb` / `read_page` 三条只读工具），都进默认基础层清单。
- [x] **AI 变更日志与回退（P4）**：`@geewiki/ai-journal`（`ai-journal-service`，四个要求登录主体的端点，迁移按方言分家）+ `@geewiki/ai-pages`（本仓**第一条 `mutating: true`** 的工具 `page.update`）。回退粒度 `turnId` = 一次用户提问；**他人改过即拒绝**（"没拿到当前值"按冲突处理，不按"一致"处理）；自锁护栏 `checkSelfLock()` + `PROTECTED_AI_NODES` **在工具层不在提示层**。**已知竞态窗口（未做）**：`wiki-service.save()` 不带主体，写工具只能自己向 `policy-service` 要 `canEdit`；正解是给 wiki-service 加 `saveAs(principal, …)`。回退 UI、探针优先于客户端自报、`gatedRewriteRefusal()` 结构护栏均已落地。
- [x] **AI 插件化重构 P5**：`@geewiki/ai-nav`（`open_page` / `scroll_to`，处理器在宿主 `packages/web/src/lib/navTools.ts`）与 `@geewiki/ai-admin`（`plugin.list` / `read_config` / `set_enabled` / `set_config`，仅所有者/管理员可用，护栏在**调用管理器之前**生效）；跨知识库结果带 `grounding` 显著标注；`ai-assistant` 声明 `REQUIRED_TOOL_NAMES = ['search_kb']`，缺席时 `/api/ai/turn` 以 **503 `tools_unavailable`** 拒绝（**不偷偷降级成通用聊天机器人**）；自锁名单扩到五个。验收 `scripts/acceptance/p5-nav-admin/run.ts`。
- [x] **AI 插件化重构 P6**：`@geewiki/ai-summary` + 折叠摘要卡——平台层新增第七个插槽 `article-summary`（单占用）与第二个平台事件 `PAGE_SAVED_EVENT`（`@geewiki/wiki` 在**事务提交之后**用 `ctx.emit` 同步广播，`unchanged` 不广播、负载不含正文）。摘要只对 public/org 两档写；过期用**内容哈希**判而非时间戳；按摘要检索**有意不走 FTS5**（`LIKE` 粗筛 + JS 精排 ⇒ 方言中立，PG 上也能跑）。折叠卡渲染在 `<h1>` **之后**、正文之前（`packages/web/src/pages/WikiPage.tsx:2228` 是 `<h1>`、`:2240` 是 `ArticleSummarySlotOutlet`）；`available === false` ⇒ **整张卡片不渲染**（源码守卫钉住）。验收 `scripts/acceptance/p6-summary/run.ts`。
- [x] **AI 插件化重构 P8（已完成）**：拆除旧 UI（决策 17）+ 删除 `@geewiki/ai-qa`（决策 22）——`wiki-ask` 从 `SlotName` 与三处镜像中消失、`#/wiki/ask/<q>` 路由拆除、三个旧端点（`/api/ai/ask`、`/api/ai/stream`、`/api/ai/capabilities`）与旧产物全部 404、`PUT /api/pages/ask` 仍 **400 `invalid_slug`**（保留段未解禁）。验收读数（隔离实例 `GEEWIKI_PORT=3931`）：入口表恰两键（`ai-assistant: ['app-dock']`、`ai-summary: ['article-summary']`）、`GET /api/plugins/slots` 已无 `wiki-ask`。详见 [design/ai-plugin-architecture.md](./design/ai-plugin-architecture.md) §0 决策 22 / §7.1 / §8.12 / §9.0。
- [x] **AI 会话核心与常驻输入条（P2）**：插槽 `app-dock` + `@geewiki/ai-assistant` 的 agent loop。宿主侧纯逻辑 `lib/dockPlan.ts`（路由 → 页面上下文，`page.kind` 收窄到 `'view' | 'edit'`，列表/新建/检索/图谱/管理台一律 `null`）、客户端工具注册表 `lib/clientTools.ts`、挂载组件 `components/AppDock.tsx`（登录判定 + 按需加载 + props 组装同生同死），渲染点在 `<main>` **之外**（切页不重挂 = 会话存活）。**`POST /api/ai/turn`（无状态回合，SSE）已落地**（`packages/plugin-ai-assistant/src/index.ts:51` 的 `TURN_PATH`）：系统提示与预算、`app-dock` 的 UI bundle、会话历史（浏览器本地近 10 段，决策 9/12）、`out-of-scope` 标注（决策 4）均已接线。

---

## 接下来做什么

### 0. 界面扩展平台的收尾（2026-09-21 新增，优先级最高）

平台本体（P0–P12）已落地并端到端验收通过（契约 [design/ui-extension-platform.md](./design/ui-extension-platform.md)，
读数见其 §11：`scripts/acceptance/ui-extension-cdp.mjs` **36/36 全绿**、`plugin-ui-cdp.mjs` 亦已修复并跑通）。
**明确剩下的两件事**：

1. ~~**修 `scripts/acceptance/plugin-ui-cdp.mjs`**~~ —— **已完成（2026-09-21）**：新增共用夹具
   `scripts/acceptance/lib/session.mjs`（三条鉴权路径：`GEEWIKI_ADMIN_TOKEN` break-glass / 无账号时
   `POST /api/auth/setup` / 固定验收账号登录；自动带 `cookie` 与 `x-gw-csrf`），脚本内所有启停改为
   经该夹具发起，并把陈旧的"wiki 有界面"断言换成"入口表列 `skipped(inactive)` + wiki 不再出现在
   `loaded()`"。修复过程中还抓到两个**脚本自身的**真问题：`Runtime.enable` 会**重放**上次的 console
   历史（把"console 零错误"弄成假失败）；首屏断言假设"默认有启用的夹具插件"（该前提早已消失）。
   拿不到凭据时依赖鉴权的用例**明确跳过**（不记失败、也不记通过），跳过的名单写进结果 JSON。
2. ~~**补"插件 bundle → `registerExtension(mode)`"的 CDP 覆盖**~~ —— **已完成（2026-09-21）**：
   P12 先把链条本身修通（受限宿主补上 `registerExtension`），随后在 `ui-extension-cdp.mjs` 增加
   **P12b 场景 8 条**：启用真实示例插件 → 断言其 `registerSlot` 贡献（页头计数器）与
   **`registerExtension(wrap)`** 贡献（品牌字样被包一层、且 `default` 没丢）都出现、产物与 CSS 经入口表
   加载 → 停用后贡献**按 owner 回收**、字样逐字还原、`<link>` 移除。这条同时是"归属到插件名 ⇒ 可回收"
   的端到端证据（走全局 SDK 那条路收不回）。
3. ~~**接线剩余外壳节点**~~ —— **已完成（2026-09-21 收尾）**：`shell-header`、`shell-footer`、
   `shell-theme-toggle`、`shell-command-palette`、`shell-status-dialog` 五个已接线并登记进目录，
   守卫 `packages/web/test/shellChromeExt.test.ts`（9 条，含"目录 ⇄ 源码双向比对"与
   "extend 的追加落在节点之后、空页脚仍不占位"的 SSR 断言）；CDP 加 6 条外壳断言（当时读数 22/22）。
   **同日追加（用户当场驳回后修正）**：`shell-header` / `shell-footer` 改为**容器节点**——
   外壳元素与内层插槽出口由宿主独占，`replace` 只换内容，贡献者用 `props.slots[名]` 摆放
   （设计文档 §4.5）；守卫 `shellChromeExt.test.ts` 增至 10 条 + CDP 4 条（P11b，当时读数 27/27）。
   **再追加（P11c，先实测后修）**：容器节点 × Shadow DOM —— 隔离根内的挂载点会被忽略
   （否则别人的贡献被拖进隔离根、丢掉宿主样式，且宿主视角与"消失"无异）；CDP +1 条（读数 **28/28**）。
   **`shell-sidebar` 经核实外壳里不存在该元素，已从候选移除**（不是漏做）——桌面导航在
   `<header>` 的 `<nav>` 里、阅读页右栏由 `wiki-toc` 覆盖。
4. **portal 类组件是否接**（Dialog / ConfirmDialog / DropdownMenu / Tooltip）：当前有意不接
   （`wrap` 会在调用处留下空包裹元素）。若要接，先解决"包装元素落在哪里"这个问题。
5. **顶层直接调全局 SDK 的注册没有归属**（2026-09-21 P12 时发现并登记）：`window.__GEEWIKI_HOST__`
   上的 `registerSlot` / `registerExtension` / `registerRoute` / `registerTool` / `registerTheme` /
   `registerMarkdownExtension` 一律以 `'host-sdk'` 为来源，于是 `unloadPluginUi(name)` **收不回**
   它们（插件停用后贡献残留、重新启用会叠加），也**不经过越权闸门**。
   走 `export function register(host)` 的插件不受影响（P12 已给受限宿主补上 `registerExtension`）。
   正解：加载期间临时装一个"按插件归属的 SDK 作用域"（`Proxy` 只覆盖注册类方法即可），
   属独立批次——它同时会改掉 `registerTool` / `registerTheme` 的既有生命周期语义，需要自己的验收。

### 1. `admin-page-slots` 扩展点

后端 `SlotService` 已支持插件用 `define(owner, slot, meta?)` **自开扩展点**（含声明/贡献分离、`undeclared` 诊断），宿主自带的白名单稳定在 7 个内置槽；**宿主侧的 `admin-page-slots` 仍是候选、尚未提供**。（`editor-toolbar-slots` 这个候选名**从未存在过**——白名单里落地的是 `editor-toolbar`。）见 architecture §6 已知边界第 1 条。

### 2. 第三方编辑器插件（Milkdown / TipTap）

`editor` 插槽与 `EditorSlotProps` 已就绪（含附件上传、段落档位、段落授权、选区/写回等**可选**通道，与内置编辑器走同一实现），但**仓库内从未实现任何厂商编辑器**，内置编辑器仍是宿主自带的 textarea。这是"编辑器组"这个名字目前唯一的落点。

### 3. 其它厂商 LLM adapter（Anthropic 等）

当前只有 `@geewiki/openai` 一条 OpenAI 兼容路由（默认启用但 `apiKeyEnv` 为空串 ⇒ **默认无可用 provider，AI 功能明确 503**）。新增厂商 = 新增 adapter 包，向 `llm-service` 注册一条 route→provider；**多个 adapter 并列共存是正常需求**，不进冲突组。

### 4. 向量 / 语义检索

**有意后置**：离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时），只留接口位。当前检索是**纯字面**匹配（FTS5 trigram + LIKE），同义改写、跨语言、模糊表述都搜不到。

### 5. F10 进程内隔离模式 / F18 检索查询接线

**有意后置**。（`F10` 的 `permissions` 清单已落地，缺的是"进程内隔离"这一执行模式；`F18` 的查询接线同理。）

### 6. 外部插件签名

现状只有**完整性校验**——相对"写入基线"回答"这个插件被改过吗"（`ok` / `drift` / `unsigned`），**没有发布者签名与公钥信任链**，本轮也不冒充它。`unsigned`（无基线 ⇒ 无法判断）刻意与 `ok` 分开。

### 7. 插件级静态资源注入

**部分落地**：插件 UI 已有"自带产物根"（`<插件目录>/dist` 优先于内置根 `<GEEWIKI_PLUGIN_UI_DIST>/plugins-ui/<名>`，真源 `packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiHit`；该内置根**缺省 = `GEEWIKI_WEB_DIST`**，两者已拆为独立配置项）。**边界以实际行为为准**：`client.entry` / `client.css` 仍是**单段文件名**（`PLUGIN_UI_FILE_SEGMENT`，契约依赖"单段"语义），而**其它资源可以放子目录**——`PLUGIN_UI_ASSET_PATH` 允许 `assets/logo.svg`、`js/chunks/chunk-abc.js` 这类嵌套路径（段数上限 `PLUGIN_UI_ASSET_MAX_DEPTH = 16`，段必须以字母或数字开头，故 `..`、`.env`、绝对路径、百分号编码天然非法）。仍缺的是"插件自带任意资源目录、随激活挂载到任意位置"这一更宽的形态（字体/图片若不走 `/plugins-ui/**` 就仍需内联进 bundle）。

### 8. 插件平台仍成立的已知限制

样式**默认**无隔离（无前缀改写；P9 起 `replace` 可显式选 Shadow DOM）、**ESM 模块实例不回收**（产物更新需整页刷新）、无版本协商与完整性之外的信任机制、`on-demand` 插槽的若干踩坑边界、"插件产物更新需整页刷新"等——完整清单见 [plugin-platform.md](./plugin-platform.md) §4.9/§5 与 [architecture.md](./architecture.md) §6。
