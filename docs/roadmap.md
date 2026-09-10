# GeeWiki 开发路线图

> 阶段按依赖顺序推进。任务清单中的"清单文件"指 `plugins.base.json` / `plugins.session.json`，"双层状态"指基础层（Base Layer）与会话层（Session Layer）。设计细节见 [architecture.md](./architecture.md)。

| 阶段 | 主题 | 里程碑 | 状态 |
| --- | --- | --- | --- |
| Phase 0 | 基础骨架 | monorepo + core 类型 + db-sqlite + server 宿主 | ✅ 完成（07bb411） |
| Phase 1 | 插件管理器 | 依赖图/双层状态/迁移控制器/看门狗/REST | ✅ 完成（e97ce6b） |
| Phase 2 | 前端可视化 + Wiki MVP | React 19 管理台 + React Flow + Wiki CRUD/版本 | ✅ 完成（本次提交） |
| Phase 3 | AI 原生能力 | Slots 插槽、LLM/RAG、编辑器组插件 | 🟡 部分落地：配置系统、外部插件发现、**宿主侧** Slot 已完成；LLM/RAG、编辑器组插件、后端 `ctx.slot()` 注册链路仍为候选 |
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
- `packages/server`：静态文件服务（`packages/web/dist` 或 `GEEWIKI_WEB_DIST`）——扩展名 MIME、hash asset 永久缓存、SPA fallback（无扩展名路径）、`/api/*` 404 与静态互不干扰；`dispatch()` 返回接管语义；204/304 无响应体。`@geewiki/wiki` 纳入 default registry 与默认 base 清单。

**验收**：headless Chrome（playwright chromium 1228）真实渲染三路由——列表含 API 数据、插件表状态正确、React Flow 画布出节点、详情页 Markdown 渲染与版本历史齐全；全仓 typecheck 全绿、单测 15/15（`packages/manager/test/deps.test.ts` 8 例 + `manager.test.ts` 7 例）、`vite build` 通过；REST 冒烟（创建/幂等/版本/历史读取/删除/409）全过。

> 后续治理批次（同一实现期）在 `manager.test.ts` 增补崩溃自愈、persist 跳过失败条目、enable 事务性、看门狗决策、卸载排空与缓存清理等用例，并新增 `repo-paths.test.ts`（3 例，路径解析与进程工作目录解耦）与 `packages/server/test/router.test.ts`（11 例，覆盖 HTTP 路由排空/413/端口选项）；该批累计单测 **35/35**（deps 8 + manager 13 + repo-paths 3 + server 11）。
>
> **当前口径（冲突组替换前置校验收紧后实跑）**：单测 **87/87 全绿** = `packages/manager` **73**（`deps` 10 + `manager` 14 + `config` 33 + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**（`registry` 3 + `router` 11），`pnpm typecheck` 7 个包 0 错误。因此上文 Phase 2 验收里的 15/15 与本段的 35/35、以及此前的 72/72、81/81 均为**历史时点口径**，不代表当前工作树；契约迁移（`layer` = 持久化层、无 schema 插件接受原始 JSON）已完成、两条旧断言已随新契约更新，逐条记录见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 6 节与第 9 节。

## Phase 3（候选）：AI 原生能力

- [x] Slots 插槽机制（**宿主侧**已落地）：宿主经 `window.__GEEWIKI_HOST__` 暴露 `registerSlot(name, component)` / `unregisterSlot`（`packages/web/src/lib/slots.tsx`、`packages/web/src/lib/hostSdk.ts`，SDK 版本 `0.1.0`）；插件 UI bundle 从 `/plugins-ui/<name>/client.js` 动态加载后调用 `register(host)` 注册。**插槽名是白名单，当前仅 `app-header` 与 `app-footer` 两个**，未知插槽名告警并忽略；`SlotOutlet` 外层包 ErrorBoundary——插件组件抛错只丢该插槽内容，主界面不白屏
- [ ] 后端注册链路与更多扩展点：`ctx.slot(name, component)`、`editor-toolbar-slots`、`admin-page-slots`（**尚未提供**）
- [ ] Suspense + use Hook 懒加载远端插件 JS Bundle —— 当前为**入口表静态 JSON**（`/plugins-ui/registry.json`）+ 显式 `import()`：加载时机是手动刷新（`window.__GEEWIKI_PLUGIN_UI__.refresh()`），**未绑定 fork 生命周期**（插件停用不会自动撤销其 UI）；热卸载只撤销插槽注册与移除插件 CSS，**ESM 模块实例不回收**
- [ ] LLM 组插件（OpenAI/Anthropic 示例，configSchema 含密码字段）+ RAG 检索管线
- [ ] 编辑器组插件（Milkdown / TipTap 示例）替换 textarea
- [ ] 插件级静态资源注入（每插件可携带前端资源目录，随激活挂载）

## Phase 4（候选）：稳定性加固与生产化

- [ ] @geewiki/db-pg：PostgreSQL 适配插件（conflictGroup database-provider 与 sqlite 互斥切换）——**已裁决延期**（DB 不在当前关键路径上；`DatabaseAdapter` 的 3 处实际消费点、双轨接口 `DatabaseAdapterAsync` + `isAsyncAdapter()`、以及唯一防返工项 `GeeWikiMeta.migrations` 扩为双路径，见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 5 节 L-9）
- [x] 配置热更新 + 自动表单 —— **已完成**：`GET` / `PUT /api/plugins/:name/config`（服务端 schemastery 校验 + 白名单裁剪 + 原子落盘，已激活插件经 `fork.update()` 热重跑 apply，失败双向回滚并返回 409）+ 管理台按 `configSchema` 自动生成 React 表单（`packages/web/src/components/SchemaForm.tsx`）；无 schema 插件退回 JSON 原文编辑（不校验、不裁剪）
- [ ] 卸载排空倒计时 UI（drainTimeout 展示）——**后端已就绪**：管理器在统一卸载出口按 `runtime.drainTimeout` 排空在途请求（见 architecture §5.1），仅缺前端展示。**注意排空粒度是"全站"在途请求，不是被卸载插件的 owner 级**（见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 5 节 L-1）
- [x] 冲突组替换交互（加载同组新插件时提示替换）—— **已完成**：新增 `POST /api/plugins/:name/replace`（body 可选 `{config}`；200 返回 `{ok, plugin, replaced, restarted}`，**`replaced: null` 表示未发生替换**——目标已激活的幂等路径或"无同组冲突"的降级路径），409 `base_layer` / **`provider_mismatch`** / `hot_reload_not_supported` / `hot_dependency_not_supported`，400 `load_failed` / `migration_failed`，500 `replace_rollback_failed`），配套 `packages/manager/src/deps.ts` 的传递闭包 `collectDependentsClosure` 与提供者覆盖校验纯函数 `findUncoveredRequires`、管理台顶替确认框（`packages/web/src/pages/AdminPage.tsx` 的 `replacePrompt`）。**前置校验（零副作用阶段）三类拒绝**：① 旧插件**真实激活层**非 session（判据 `managed.layer`，不是 `layerOf()`）→ 409 `base_layer`；② 卸载集合（旧插件 ∪ 活跃传递依赖方）内任一成员非 session → 409 `base_layer` 带 `details.plugins`；③ 依赖边经 `resolveDependency` 解析后指向被顶替者而目标无法承接 → 409 `provider_mismatch`（`details` 含 `plugin` / `token` / `target` / `targetProvides` / `violations`），目标自身依赖被顶替者同样被拒。**对外影响**：依赖方按**具体插件名**依赖被顶替者时该替换会被 409 拒绝（按名的边无法由新插件承接），正解是改为依赖**服务标识**（`provides` token）——刻意取舍，宁可 409 也不留下无人提供的服务。失败回滚会**按调用前的条目顺序与原内容复原**会话清单（文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行，故非规范格式不被逐字节保留）；返回 500 时整个卸载集合的会话条目均已从清单消失、内存与磁盘一致，需人工介入（该分支**无单测覆盖**，见 G-1）。管理台确认框预告"被卸载插件短暂不可用（约几秒）"、依赖方只列**当前活跃者**，无替换降级时提示"冲突已解除，已直接启用（未发生替换）"。见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节 G-1；隔离实例与浏览器 CDP 均已实测。
- [x] `enable` 失败回滚作用域修复 —— **已完成**：回滚集合改为**全递归帧共用**（公开 `enable` 作唯一回滚点、private `enableInner` 自登记 `activated`），依赖深度 ≥2 的孙依赖不再泄漏进 session 清单；回归用例「enable：递归深度 ≥2 时回滚集合必须覆盖孙依赖（会话清单零残留）」做了红-绿验证。见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节 G-2 与第 5 节 L-2。
- [x] `meta.role: 'password'` 脱敏输入框 —— **已完成**：`role: 'password'` 的字符串字段渲染为 `type="password"` + `autoComplete="new-password"` 输入框（`packages/web/src/lib/configSchema.ts` 置 `secret`、`packages/web/src/components/SchemaForm.tsx` 据此选控件）。**边界（仍未做）**：脱敏只作用于表单输入框的呈现，`GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（不在传输层脱敏），见 architecture §5.7
- [ ] 发现期 issues 的前端提示位（后端 `GET /api/plugins` 的 `issues` 字段已对外可见，管理台尚未展示"有插件被跳过"，见第 5 节 L-14）
- [ ] 依赖阻止卸载弹窗提示（当前 409 文案展示）
- [x] docker-compose 应用镜像多阶段构建（web build → server），容器自愈联动实测 —— **已完成**：`Dockerfile`（多阶段、非 root 运行、`HEALTHCHECK` 判 `ok && db.present`）+ `docker compose up -d --build` 已实测（构建、持久化、插件启停持久化、SIGTERM 优雅退出、数据目录不可写时如实变 `unhealthy`）；详见 [deployment.md](deployment.md)
- [ ] 端到端故障演练：注入崩溃/慢查询验证熔断与数据无损
