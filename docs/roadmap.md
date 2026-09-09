# GeeWiki 开发路线图

> 阶段按依赖顺序推进：上一阶段验收通过后进入下一阶段。任务清单中的"清单文件"指 `plugins.base.json` / `plugins.session.json"，"双层状态"指基础层（Base Layer）与会话层（Session Layer）。设计细节见 [docs/architecture.md](docs/architecture.md)。

| 阶段 | 主题 | 里程碑 |
| --- | --- | --- |
| Phase 0 | 基础骨架 | Cordis + TypeScript 环境跑通，core 与 db-sqlite 可加载 |
| Phase 1 | 管理器攻坚（MVP） | 热加载、双层状态、依赖图 API 可用 |
| Phase 2 | 前端可视化 | React 19 管理界面 + React Flow 依赖图 |
| Phase 3 | Wiki 业务 | CRUD、版本管理、AI 助手（RAG）、Slots 插槽 |
| Phase 4 | 稳定性加固 | 看门狗、迁移控制器、配置热更新 |

## Phase 0：基础骨架

**目标**：搭建 Cordis + TypeScript 开发环境与仓库目录结构，实现 db-sqlite 与 core 两个基础插件，使系统能以"仅一个 SQLite 文件"的最小形态启动。

**任务清单**

- [ ] 建立 monorepo 目录结构：`packages/core`、`packages/db-sqlite`、`packages/db-pg`、`packages/web-ui`、`plugins/`、`config/`、`data/`
- [ ] 配置 TypeScript / 构建 / 测试基础工程（tsconfig 等，按 packages 拆分）
- [ ] 引入 Cordis，搭建依赖注入与事件总线骨架
- [ ] 定义标准 `DatabaseAdapter` 接口（`query` / `migrate` / `transaction`）
- [ ] 实现 @geewiki/db-sqlite（better-sqlite3，0 外部依赖运行）
- [ ] 实现 @geewiki/core（插件生命周期基线：manifest 解析与加载雏形）
- [ ] 定义 `geewiki.manifest.json` 的解析与基础字段校验（name / version / provides / requires）
- [ ] 落地 `config/plugins.base.json`、`config/plugins.session.json` 的读写约定
- [ ] 验证 docker-compose.yml：应用镜像可构建启动，健康检查通过（退出码 1 自愈逻辑占位）

**验收口径**：仅凭一个 SQLite 数据库文件即可启动最小应用骨架，core 与 db-sqlite 插件正常加载并通过冒烟测试。

## Phase 1：管理器攻坚（MVP）

**目标**：实现插件管理器底层——热加载引擎、Session/Base 双层状态读写分离与依赖图计算 API，为前端可视化提供完整后端能力。

**任务清单**

- [ ] 热加载引擎实现：以 `runtime.supportsHotReload` 显式授权为准入门槛（默认禁止）
- [ ] 冷热分离：热操作仅限无状态插件（UI、AI 工具），冷操作（数据库驱动、核心鉴权）仅支持持久化安装 + 重启
- [ ] 依赖链检查：依赖插件不支持热加载时，禁止上层插件的热加载
- [ ] 卸载排空：按 `runtime.drainTimeout`（秒）等待进行中任务完成
- [ ] Session/Base 双层状态读写分离：临时操作仅写会话层，即时生效
- [ ] 崩溃自愈：重启后忽略会话层、自动回滚至基础层
- [ ] "应用并持久化"：会话层变动合并至基础层的操作与 API
- [ ] 依赖图计算 API：加载时递归加载未激活依赖项；卸载时计算下游依赖者并阻止卸载
- [ ] conflictGroup 注册表：同组互斥激活、加载新插件时提示替换

**验收口径**：管理器可在不重启进程的情况下临时加载/卸载 UI 类插件，临时插件致崩后重启即自动回到基础层稳定状态。

## Phase 2：前端可视化

**目标**：搭建 React 19 管理界面，以 React Flow 渲染插件依赖图，将"临时加载/卸载"与"持久化生效"两类操作以可视化方式分离呈现。

**任务清单**

- [ ] 搭建 @geewiki/web-ui 工程（React 19 + Vite，Suspense 流式渲染）
- [ ] React Flow 依赖图渲染（DAG）：拉取 Phase 1 依赖图 API 并绘制
- [ ] 节点颜色区分热能力：绿色 = 支持热加载，红色 = 需重启
- [ ] 依赖阻止卸载弹窗：存在下游依赖者时提示原因
- [ ] 冲突组替换交互：加载同组新插件时弹窗提示替换
- [ ] "临时加载/卸载"与"持久化生效（应用并持久化）"分离的操作 UI
- [ ] 卸载排空倒计时展示（drainTimeout）

**验收口径**：管理员可在管理界面直观查看依赖图，并完整走通"临时测试 → 崩溃回滚 / 应用并持久化"两类操作流程。

## Phase 3：Wiki 业务

**目标**：在稳定的插件管理基座上构建 Wiki 核心业务与 AI 能力，并通过 Slots 插槽机制验证前端动态扩展的完整链路。

**任务清单**

- [ ] Wiki Core：文档 CRUD
- [ ] Wiki Core：版本管理
- [ ] AI 助手：RAG（检索增强生成）管线接入
- [ ] Slots 插槽机制：在 @geewiki/web-ui 预设 `header-slots`、`editor-toolbar-slots`、`admin-page-slots` 扩展点
- [ ] 插槽注册：插件经 `ctx.slot('header-slots', MyReactComponent)` 注入组件
- [ ] 懒加载与容错：Suspense + use Hook 懒加载远端插件 JS Bundle；热卸载时自动 Fallback、主界面不白屏
- [ ] 编辑器组插件接入（Milkdown / TipTap 示例插件）
- [ ] LLM 组插件接入（OpenAI / Anthropic 示例插件，含 configSchema 密码字段配置）

**验收口径**：文档 CRUD 与版本管理可用；编辑器、LLM 与自定义 UI 插件均可动态装卸并即时生效，卸载不导致界面白屏。

## Phase 4：稳定性加固

**目标**：补齐生产级稳定性机制——看门狗探针与熔断、迁移控制器、配置热更新，并完成故障演练。

**任务清单**

- [ ] 看门狗健康探针：持续监测 `/api/health` 响应时间与进程 CPU 负载
- [ ] 试用期机制：热加载新插件时设定 5 秒"试用期（Grace Period）"
- [ ] 自动熔断：响应超时或资源飙升 → 丢弃该插件的 Session 记录，向进程发送 SIGTERM 重启容器
- [ ] 迁移控制器：插件激活前自动执行 `ctx.db.migrate()`；迁移失败阻止加载并回滚事务（避免 Schema 不一致导致 500）
- [ ] 配置热更新：configSchema → 自动生成 React 配置表单 → 事件总线推送 `ctx.config.update()`，无需卸载重载
- [ ] 容器自愈联动：启动脚本对退出码 1 自动删除 session 配置并重启
- [ ] 端到端故障演练：注入崩溃/慢查询，验证自动恢复与数据无损

**验收口径**：人为注入临时插件崩溃或慢查询时系统自动熔断并恢复稳定；迁移失败不会破坏现有数据与 Schema 一致性。
