# GeeWiki

面向团队内部的 AI 原生 Wiki 知识库。

核心哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用）；PostgreSQL 适配规划中（Phase 4），当前尚未提供 PostgreSQL 适配包。

**当前状态：Phase 2 完成 + Phase 3 部分落地** —— 插件管理器（依赖图/冲突组/会话层/看门狗）、Wiki CRUD + 版本历史、React 19 管理台与依赖图均可完整交互；插件配置系统（schema 表单 + 热更新）与外部插件目录发现已落地，前端 Slot **仅宿主侧**（边界见下方"已知限制"）。开发路线与阶段进度见 [docs/roadmap.md](docs/roadmap.md)。

**当前实现状态**

- **已完成（Phase 0-2）**：pnpm monorepo 共 7 个包；`pnpm dev` 一条命令同时启动后端 http://127.0.0.1:3000 与前端开发服务器 http://localhost:5173（生产形态 `pnpm build` 后用 `pnpm start`，由后端静态托管前端产物）；**4 个内置插件已由代码内注册表静态登记**（`@geewiki/http`、`@geewiki/db-sqlite`、`@geewiki/wiki`、`@geewiki/echo`；其中默认基础层清单只**启用 3 个**——`@geewiki/echo` 已注册未启用，故 `GET /api/plugins` 显示 4 条内置，挂载示例外部插件后为 5 条）；Web 管理台含 `#/wiki`、`#/plugins`、`#/graph` 三个路由；**单元测试 72/72 通过**（`packages/manager` 58 + `packages/server` 14，逐文件明细见下表 `pnpm test` 行），`pnpm typecheck` 7 个包 0 错误。卸载统一出口已消费 `runtime.drainTimeout`（优雅排空在途 HTTP 请求，超时强制卸载）并在 `requiresCachePurge` 时广播缓存清理事件。
- **插件平台已落地（Phase 3 的三条链路）**：
  - **配置系统（schema 驱动）**：manifest 的 `geewiki.configSchema` 采用 [schemastery](https://github.com/shigma/schemastery) 3.18.0；`GET` / `PUT /api/plugins/:name/config` 提供读写，服务端做校验 + 白名单裁剪 + **原子落盘**（先写 `<文件>.tmp` 再 `rename`）；已激活插件经 `fork.update()` 热更新，失败时把进程内配置与磁盘清单**双向回滚**并返回 409。管理台按 schema 自动生成表单（开关 / 数字 / 文本 / 多行 / 枚举 / 字段组 / 列表；`meta.role: 'password'` 渲染为密码输入框），**未声明 schema 的插件退回 JSON 原文编辑框**（不校验、不裁剪）。
  - **外部插件加载**：启动时扫描 `./plugins/<name>/`（`GEEWIKI_PLUGINS_DIR` 可覆盖），清单取子目录 `package.json` 的 `geewiki` 键（优先）或独立 `geewiki.manifest.json`，与内置插件**并入同一注册表、完全同权**；单个插件的清单缺失 / 入口缺失 / 路径越界 / 重名 / 加载抛错都只记一条 issue 并跳过，不阻断宿主启动；发现期问题经 `GET /api/plugins` 的 `issues` 字段对外可见（`{code,dir,message}`，`code` 为八值枚举）。零依赖示例见 `plugins/hello-geewiki/`。
  - **前端 Slot（仅宿主侧）**：宿主经 `window.__GEEWIKI_HOST__` 暴露 React 单例与 `registerSlot` / `unregisterSlot`，插件 UI bundle 从 `/plugins-ui/<name>/client.js` 动态加载并注册组件；插槽名是白名单，当前**仅 `app-header` 与 `app-footer`**（未知插槽名告警并忽略），插槽外层包 ErrorBoundary——插件组件抛错只丢该插槽，主界面不白屏。**边界见下方"已知限制"。**
- **尚未实现 / 已知限制**：Phase 3 余项——LLM / RAG 检索管线、编辑器组插件（Milkdown / TipTap）、插件级静态资源注入，以及后端 `ctx.slot(name, component)` 注册链路与 `editor-toolbar-slots` / `admin-page-slots` 扩展点；Phase 4 的 PostgreSQL 适配（`@geewiki/db-pg`，**已裁决延期**）与冲突组替换交互。另有 4 条已知限制：① **Slot 只有宿主侧**——无 `ctx.slot()` 后端注册、无 Suspense + use Hook 懒加载，加载时机为手动刷新（`window.__GEEWIKI_PLUGIN_UI__.refresh()`）、**未绑定 fork 生命周期**（插件停用不会自动撤销其 UI），且 **ESM 模块实例不回收**（卸载只撤销插槽注册与移除插件 CSS）；② `enable` 失败回滚集合 `activatedByThisCall` 是**每递归帧局部数组**，依赖深度 ≥2 时孙依赖可能残留并泄漏 session 清单（修法已定稿、代码未落地）；③ 排空粒度是**全站**在途请求，非 owner 级；④ 密码字段的脱敏**只覆盖表单输入框的呈现**——`meta.role: 'password'` 已渲染为 `type="password"` + `autoComplete="new-password"` 输入框，但 `GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层做脱敏）。**容器镜像与 Compose 编排已可用**（多阶段 `Dockerfile` + `docker compose up -d --build`，见 [docs/deployment.md](docs/deployment.md)）。详见 [docs/roadmap.md](docs/roadmap.md) 与 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md)。

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

**开发形态**：浏览器打开 **http://localhost:5173** —— Vite dev server 提供前端（热更新），并把 `/api` 自动代理到后端 `http://127.0.0.1:3000`；后端自身也在 3000 提供 REST 接口（可用 `http://127.0.0.1:3000/api/health` 探活）。

**生产形态**：先 `pnpm build` 生成前端产物 `packages/web/dist`，再由后端在 **http://127.0.0.1:3000** 直接静态托管该产物 —— 即 `pnpm start`（与 `pnpm dev:server` 是同一条命令：**只起后端、不起 Vite**）。该产物目录已被 `.gitignore` 忽略、**不在版本库中**，因此新克隆的仓库必须先执行 `pnpm build`，否则 3000 端口只有后端 API、没有界面。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | **一条命令同时启动**后端（:3000）与前端 Vite 开发服务器（:5173，`/api` 代理到 :3000） |
| `pnpm dev:server` | 仅启动后端 → http://127.0.0.1:3000 |
| `pnpm dev:web` | 仅启动前端开发服务器 → http://localhost:5173（需后端已在 :3000 运行） |
| `pnpm build` | 构建全仓产物（`@geewiki/web` → `packages/web/dist`） |
| `pnpm start` | 与 `pnpm dev:server` 同一条命令：**仅启动后端**（不起 Vite）；生产形态下由后端静态托管 `packages/web/dist` → http://127.0.0.1:3000（需先 `pnpm build`） |
| `pnpm typecheck` | 全仓类型检查（`pnpm -r --if-present run typecheck`，7 个包） |
| `pnpm test` | 运行单元测试（`packages/manager/test` 与 `packages/server/test`）。**当前 72/72 全绿**：`packages/manager` **58**（`deps` 8 + `manager` 13 + `config` 21 + `discovery` 13 + `repo-paths` 3）+ `packages/server` **14**（`registry` 3 + `router` 11）。契约迁移（`layer` = 持久化层、无 schema 插件接受原始 JSON）已完成，此前 2 条旧断言已随新契约更新（详见 `docs/plugin-platform-plan.md` 第 6 节） |

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | 后端监听端口（优先级：`startServer({ port })` 选项 > 本变量 > 默认值）。注意：前端 dev server 的 `/api` 代理目标在 `packages/web/vite.config.ts:9` 中硬编码为 `http://127.0.0.1:3000`，**改动本变量需同步修改该代理配置**，否则开发形态下前后端断链 |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端监听地址（优先级：`startServer({ host })` 选项 > 本变量 > 默认值）；如需仅本机可访问可设为 `127.0.0.1` |
| `GEEWIKI_DATA_DIR` | `./data` | SQLite 数据库与运行时数据目录（库文件 `geewiki.db`、崩溃标记 `crash.marker`）；**相对路径以仓库根为基准**，绝对路径原样使用 |
| `GEEWIKI_CONFIG_DIR` | `./config` | 插件清单目录（`plugins.base.json` / `plugins.session.json`）；相对路径同样以仓库根为基准 |
| `GEEWIKI_WEB_DIST` | `packages/web/dist` | 前端静态产物目录（未构建时不启用静态服务）；**相对路径一律以仓库根为基准**（与进程工作目录无关，故从任意子目录启动都指向同一份产物），绝对路径原样透传 |

> 以上相对路径均由 `@geewiki/core` 的 `resolveProjectPath` 以**仓库根**（向上查找 `pnpm-workspace.yaml`）为基准解析，与进程 cwd 无关；启动时 `[@geewiki/http] 静态资源目录: <绝对路径>` 日志可用于核对。

- 零外部依赖默认配置：数据落在 `data/geewiki.db`（WAL + 自动迁移建表）。
- 界面（hash 路由）：`#/wiki` 知识库（列表/编辑/Markdown/版本历史）· `#/plugins` 插件管理（会话层热启停、schema 自动生成的配置表单——无 schema 插件退回 JSON 编辑、应用并持久化）· `#/graph` 依赖图（React Flow DAG）。
- 插件热操作示例：在「插件管理」启用 `@geewiki/echo` 即时挂载 `GET /api/echo`，停用即摘除；「应用并持久化」把会话变更合并进 `config/plugins.base.json`。
- REST 面：`/api/health`（健康/库表/迁移）· `/api/plugins*` · `/api/pages*`。
- **Docker 部署**：仓库自带多阶段 `Dockerfile` 与 `docker-compose.yml`，容器内以非 root（`node`）运行、数据落在宿主机 `./data`（SQLite）：
  ```bash
  mkdir -p data config plugins && chown -R 1000:1000 data config plugins
  docker compose up -d --build        # → http://localhost:3000
  ```
  镜像已提供并实测（含健康检查、持久化与 SIGTERM 优雅退出）；完整的目录权限、备份、排障与验证清单见 [docs/deployment.md](docs/deployment.md)。本地开发仍推荐 `pnpm dev`。

## 特性亮点

- **开箱即用**：默认仅依赖一个 SQLite 数据库（better-sqlite3）即可运行，实现 0 外部依赖部署。
- **数据库即互斥插件**：系统通过标准 `DatabaseAdapter` 接口抽象数据库层（见 `packages/core`），SQLite ↔ PostgreSQL 以互斥插件（conflictGroup）方式切换，业务代码零改动；PostgreSQL 适配包 `@geewiki/db-pg` 属 Phase 4 规划，尚未实现。
- **插件管理器（核心大脑）**：依赖拓扑/环检测、会话层沙箱热启停（显式热授权 + 试用期看门狗 + 熔断）、广义冲突组互斥、迁移控制器、持久化清单合并。卸载走统一出口（`disable` / 启停回滚 / `disposeAll`）：先按 `runtime.drainTimeout` **优雅排空**在途 HTTP 请求（超时告警并强制卸载），卸载后对声明 `requiresCachePurge` 的插件广播**缓存清理事件**。配置**热更新已落地**（schema 校验 + 原子落盘 + `fork.update()` 热重跑，失败双向回滚）；前端 Slot 目前**仅宿主侧**（`app-header` / `app-footer` 两个白名单插槽 + `window.__GEEWIKI_HOST__` 宿主 SDK），后端 `ctx.slot()` 注册链路与 `editor-toolbar-slots` / `admin-page-slots` 扩展点仍列 Phase 3（见 roadmap）。
- **管理面可视化**：React 19 管理台 —— 插件状态/层/热能力一览、会话层热操作、依赖图（React Flow DAG）、Wiki 页面编辑与版本历史。

## 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis) `cordis@^4.0.0-rc.10` | 依赖注入、事件总线与插件生命周期管理。当前实际安装 `4.0.0-rc.10`（npm `latest` 标签即指向该 RC；3.x 稳定线止于 `3.18.1`，本项目未采用） |
| 开发语言 | TypeScript（Node.js 环境） | — |
| 前端框架 | React 19+ | 管理台基座；插件 UI 经宿主 SDK（`window.__GEEWIKI_HOST__` 暴露 React 单例）+ 插槽注册接入（**当前未用 Suspense / use Hook 做远端 Bundle 懒加载**，见 [docs/architecture.md](docs/architecture.md) §6） |
| 默认数据库 | better-sqlite3 | 零外部依赖，开箱即用 |
| 生产数据库 | PostgreSQL（pg 驱动） | 适配规划中（Phase 4），当前尚未提供适配包 |
| 容器编排 | Docker Compose（Profiles 模式） | 多阶段 `Dockerfile` + `docker compose up -d --build` 已可用（非 root 运行、SQLite 持久化到 `./data`）；`--profile production` 预留 Postgres 服务，默认不启动，详见 [docs/deployment.md](docs/deployment.md) |

**内核版本事实（cordis，2026-09 核实）**：仓库 6 个包（core / db-sqlite / manager / server / plugin-wiki / plugin-echo）统一声明 `"cordis": "^4.0.0-rc.10"`，`pnpm-lock.yaml` 解析并安装 `cordis@4.0.0-rc.10`。npm `dist-tags` 为 `latest = 4.0.0-rc.10`、`next = 4.0.0-beta.5`（即 `pnpm add cordis` 装到的就是该 RC），3.x 序列的最后一个版本是 `3.18.1`。该包本身未声明 `engines` 字段，本项目在 Node 22.23.2 上实测通过（typecheck + 测试 + 运行）。`^4.0.0-rc.10` 按 semver 语义覆盖 `4.0.0` 正式版及其后 4.x，正式版发布后 `pnpm update cordis` 即可升级。另需注意 4.x 的类型发布缺口：`lib/index.d.ts` 的 `export *` 链使 `Context` 的 `provide/get/plugin` 等方法在外部消费时不被解析，本仓库由 `packages/core/src/cordis-env.ts` 的自包含模块增强补齐（详见该文件头注释）。

## 架构总览

分层架构如下（完整设计见 [docs/architecture.md](docs/architecture.md)）：

```
React 19 前端（宿主侧 Slot：`app-header` / `app-footer` 两个插槽 + `window.__GEEWIKI_HOST__` 单例宿主，插件 UI 从 `/plugins-ui/<name>/client.js` 加载 / 依赖图可视化）
        │
        │  REST API（HTTP；当前无 WebSocket 通道）
        ▼
Plugin Manager（核心大脑）：热加载引擎、依赖图/冲突组、会话层沙箱机制、迁移控制器、看门狗探针、配置热管理中心
        │
        │  服务抽象层 (DI)
        ▼
插件生态（按冲突组划分）：[数据库组: SQLite / PG] [LLM组: OpenAI / Anthropic] [编辑器组: Milkdown / TipTap]
```

## 仓库结构

```
geewiki/
├── packages/
│   ├── core/         # 内核类型与常量：Manifest 规范、DatabaseAdapter 接口、cordis 类型增强
│   ├── db-sqlite/    # 默认数据库插件 @geewiki/db-sqlite（better-sqlite3 + SQL 迁移）
│   ├── manager/      # 插件管理器 @geewiki/manager：依赖图/冲突组/会话层沙箱/迁移控制器/看门狗
│   ├── server/       # 应用宿主 @geewiki/server：http 服务、静态文件服务与内置插件注册表
│   ├── web/          # React 19 管理台 @geewiki/web（Vite 6，路由 #/wiki、#/plugins、#/graph；fixtures/ 为 Slot 验证用示例插件 UI）
│   ├── plugin-wiki/  # Wiki 业务插件 @geewiki/wiki：页面 CRUD + 版本历史 REST
│   └── plugin-echo/  # 示例插件 @geewiki/echo：热插拔演示（GET /api/echo）
├── config/           # 插件清单：plugins.base.json / plugins.session.json
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

> 说明：上表 4 个内置插件（`@geewiki/http`、`@geewiki/db-sqlite`、`@geewiki/wiki`、`@geewiki/echo`）由代码内注册表（`packages/server/src/index.ts` 的 `defaultRegistry`）静态登记；**`plugins/` 目录下的外部插件已在宿主启动时自动发现并并入同一注册表**（清单取子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json`，见 [docs/architecture.md](docs/architecture.md) §5.8）。
>
> 另注：插件前端 UI 的产物目录 `packages/web/public/plugins-ui/` 由 `pnpm --filter @geewiki/web run build:fixtures` 单独生成（**不在 `pnpm build` 内**），且已被 `.gitignore` 排除——因此新克隆的仓库需先执行该命令，管理台上才会有示例插件 UI；缺失时宿主不会报错，只是没有插件 UI 可加载。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：设计哲学、技术栈选型、分层架构、数据库即互斥插件、插件管理器六大子系统、前端 Slot 插槽（宿主侧）、Manifest 规范、部署模型 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署：快速开始、镜像构成、目录权限、环境变量、数据备份、生命周期自愈、PostgreSQL profile、升级、排障与验证清单 |
| [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) | 插件平台实施记录：内核实证（cordis / schemastery / ESM）、批次 A–F 方案、契约裁决、已知限制 L-1…L-14、质量基线与验证纪律 |
| [docs/roadmap.md](docs/roadmap.md) | 开发路线图：Phase 0 – Phase 4 的目标、任务清单与验收口径 |

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
