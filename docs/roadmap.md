# GeeWiki 开发路线图

> 阶段按依赖顺序推进。任务清单中的"清单文件"指 `plugins.base.json` / `plugins.session.json`，"双层状态"指基础层（Base Layer）与会话层（Session Layer）。设计细节见 [architecture.md](./architecture.md)。

| 阶段 | 主题 | 里程碑 | 状态 |
| --- | --- | --- | --- |
| Phase 0 | 基础骨架 | monorepo + core 类型 + db-sqlite + server 宿主 | ✅ 完成（07bb411） |
| Phase 1 | 插件管理器 | 依赖图/双层状态/迁移控制器/看门狗/REST | ✅ 完成（e97ce6b） |
| Phase 2 | 前端可视化 + Wiki MVP | React 19 管理台 + React Flow + Wiki CRUD/版本 | ✅ 完成（本次提交） |
| Phase 3 | AI 原生能力 | Slots 插槽、LLM/RAG、编辑器组插件 | ⏳ 候选 |
| Phase 4 | 稳定性加固 | PG 适配、配置热更新表单（容器镜像与 Compose 部署已提前完成，见 [deployment.md](deployment.md)） | ⏳ 候选 |

## Phase 0：基础骨架 ✅

**交付**：`packages/core`（Manifest 规范类型 + DatabaseAdapter + 常量 + cordis-env 类型增强面）、`packages/db-sqlite`（better-sqlite3 适配器 + `src/migrations` SQL 迁移 + `0001_init.sql` 建 pages/page_versions）、`packages/server`（组合根：引导 manager，http 服务 + 健康检查）、pnpm workspace + tsconfig base + docker-compose 骨架 + docs。

**验收**：最小形态启动冒烟通过（db-sqlite 自动迁移建表、健康检查返回库表与迁移清单、SIGINT/TERM 优雅退出链路验证）。

## Phase 1：插件管理器 ✅

**交付**：`packages/manager`（600 行核心）——

- 依赖解析 `resolveDependency`（按插件名或 provides）/ `directDependencies` / `topologicalOrder`（字母序稳定 + 环检测抛错）/ `collectDependents`（反向依赖）/ `findConflict`（conflictGroup 同组互斥）/ `checkHotChain`（热插件依赖未激活冷依赖即违规）——纯函数，单元测试全绿（`packages/manager/test/deps.test.ts`，8 例）。
- Session/Base 双层清单（`plugins.base.json` + `plugins.session.json`）合并去重装配；boot 逐个拓扑激活、失败记 `bootErrors` 继续。
- `enable()`：会话层热操作——热授权（`supportsHotReload !== true` → 409 `hot_reload_not_supported`）、热链检查、未激活依赖递归启用、激活后写 session 文件。
- `disable()`：基础层插件 → 409 `base_layer`；存在依赖者 → 409 `has_dependents`；卸载（`fiber.dispose()`）并清 session 记录。
- `persistSession()`：会话合并进 base 清单（"应用并持久化"），重启后以 base 层激活。
- 迁移控制器：entry 声明 `migrationsDir` 且 db 可用时，激活前 `db.migrate(dir)`，失败阻止加载。
- 看门狗：5s 探针——session 插件 5s 试用期内健康检查连续失败 → 自动 disable 回滚；连续失败 ≥3 且会话非空 → 熔断（清 session 文件 + `process.exit(1)`，容器自愈联动占位）。
- REST：`GET /api/plugins`（snapshot：state/layer/hotReloadable/provides/requires/conflictGroup/migrations/config/error）、`GET /api/plugins/graph`（React Flow DAG：nodes+edges）、`GET /api/session`、`POST /api/plugins/:name/enable|disable`、`POST /api/session/persist`。错误 → HTTP 映射（404/409/400/500）。

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

> 后续治理批次（同一实现期）在 `manager.test.ts` 增补崩溃自愈、persist 跳过失败条目、enable 事务性、看门狗决策、卸载排空与缓存清理等用例，并新增 `repo-paths.test.ts`（3 例，路径解析与进程工作目录解耦）与 `packages/server/test/router.test.ts`（11 例，覆盖 HTTP 路由排空/413/端口选项）；当前累计单测 **35/35**（deps 8 + manager 13 + repo-paths 3 + server 11）。

## Phase 3（候选）：AI 原生能力

- [ ] Slots 插槽机制：`ctx.slot(name, component)` 注册 + 前端 `header-slots` / `editor-toolbar-slots` / `admin-page-slots` 扩展点
- [ ] Suspense + use Hook 懒加载远端插件 JS Bundle；热卸载自动 Fallback、主界面不白屏
- [ ] LLM 组插件（OpenAI/Anthropic 示例，configSchema 含密码字段）+ RAG 检索管线
- [ ] 编辑器组插件（Milkdown / TipTap 示例）替换 textarea
- [ ] 插件级静态资源注入（每插件可携带前端资源目录，随激活挂载）

## Phase 4（候选）：稳定性加固与生产化

- [ ] @geewiki/db-pg：PostgreSQL 适配插件（conflictGroup database-provider 与 sqlite 互斥切换）
- [ ] 配置热更新：`POST /api/plugins/:name/config`（fiber.update 热重跑 apply）+ configSchema 自动生成 React 表单
- [ ] 卸载排空倒计时 UI（drainTimeout 展示）——**后端已就绪**：管理器在统一卸载出口按 `runtime.drainTimeout` 排空在途请求（见 architecture §5.1），仅缺前端展示
- [ ] 冲突组替换交互（加载同组新插件时提示替换）
- [ ] 依赖阻止卸载弹窗提示（当前 409 文案展示）
- [x] docker-compose 应用镜像多阶段构建（web build → server），容器自愈联动实测 —— **已完成**：`Dockerfile`（多阶段、非 root 运行、`HEALTHCHECK` 判 `ok && db.present`）+ `docker compose up -d --build` 已实测（构建、持久化、插件启停持久化、SIGTERM 优雅退出、数据目录不可写时如实变 `unhealthy`）；详见 [deployment.md](deployment.md)
- [ ] 端到端故障演练：注入崩溃/慢查询验证熔断与数据无损
