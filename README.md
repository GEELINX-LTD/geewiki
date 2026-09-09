# GeeWiki

面向团队内部的 AI 原生 Wiki 知识库。

核心哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用），亦可一键切换至 PostgreSQL 等生产级数据库。

**当前状态：Phase 2（可交互 MVP 完成）** —— 插件管理器（依赖图/冲突组/会话层/看门狗）、Wiki CRUD + 版本历史、React 19 管理台与依赖图均已落地，浏览器可完整交互。开发路线与阶段进度见 [docs/roadmap.md](docs/roadmap.md)。

## 快速开始

```bash
pnpm install                       # 安装依赖（含 better-sqlite3 预编译二进制）
pnpm --filter @geewiki/web build   # 构建知识库与管理界面（→ packages/web/dist）
pnpm dev                           # 启动服务 → http://127.0.0.1:3000
```

- 零外部依赖默认配置：数据落在 `data/geewiki.db`（WAL + 自动迁移建表）。
- 界面（hash 路由）：`#/wiki` 知识库（列表/编辑/Markdown/版本历史）· `#/plugins` 插件管理（会话层热启停、JSON 配置、应用并持久化）· `#/graph` 依赖图（React Flow DAG）。
- 插件热操作示例：在「插件管理」启用 `@geewiki/echo` 即时挂载 `GET /api/echo`，停用即摘除；「应用并持久化」把会话变更合并进 `config/plugins.base.json`。
- REST 面：`/api/health`（健康/库表/迁移）· `/api/plugins*` · `/api/pages*`。
- 前端开发热更：`pnpm --filter @geewiki/web dev`（vite :5173，`/api` 自动代理后端）。

## 特性亮点

- **开箱即用**：默认仅依赖一个 SQLite 数据库（better-sqlite3）即可运行，实现 0 外部依赖部署；亦可一键切换至 PostgreSQL 等生产级数据库。
- **数据库即互斥插件**：系统通过标准 `DatabaseAdapter` 接口抽象数据库层，SQLite ↔ PostgreSQL 以互斥插件（conflictGroup）方式一键切换，业务代码零改动。
- **插件管理器（核心大脑）**：依赖拓扑/环检测、会话层沙箱热启停（显式热授权 + 试用期看门狗 + 熔断）、广义冲突组互斥、迁移控制器、持久化清单合并。配置热更新与前端 Slot 插槽机制列 Phase 3（见 roadmap）。
- **管理面可视化**：React 19 管理台 —— 插件状态/层/热能力一览、会话层热操作、依赖图（React Flow DAG）、Wiki 页面编辑与版本历史。

## 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis) | 依赖注入、事件总线与插件生命周期管理 |
| 开发语言 | TypeScript（Node.js 环境） | — |
| 前端框架 | React 19+ | use Hook、Suspense 流式渲染及 Compiler 优化，实现前端组件的动态插拔 |
| 默认数据库 | better-sqlite3 | 零外部依赖，开箱即用 |
| 生产数据库 | PostgreSQL（pg 驱动） | 生产环境一键切换 |
| 容器编排 | Docker Compose（Profiles 模式） | 默认不启动 Postgres 服务 |

## 架构总览

分层架构如下（完整设计见 [docs/architecture.md](docs/architecture.md)）：

```
React 19 前端（支持 Slot 插槽机制：动态渲染第三方插件注入的 UI 组件 / 依赖图可视化）
        │
        │  API / WebSocket
        ▼
Plugin Manager（核心大脑）：热加载引擎、依赖图/冲突组、会话层沙箱机制、迁移控制器、看门狗探针、配置热管理中心
        │
        │  服务抽象层 (DI)
        ▼
插件生态（按冲突组划分）：[数据库组: SQLite / PG] [LLM组: OpenAI / Anthropic] [编辑器组: Milkdown / TipTap]
```

## 仓库结构（预期布局，随 Phase 0 开发逐步建立）

```
geewiki/
├── packages/
│   ├── core/        # 内核插件：Cordis DI、事件总线与插件生命周期基线
│   ├── db-sqlite/   # 默认数据库插件（SQLite，better-sqlite3，0 外部依赖）
│   ├── db-pg/       # 生产数据库插件（PostgreSQL，pg）
│   └── web-ui/      # React 19 前端（含 header-slots 等 Slot 扩展点）
├── plugins/         # 外部插件挂载点（运行时挂载，如 ./plugins:/app/plugins）
├── config/          # 插件清单：plugins.base.json / plugins.session.json
├── data/            # SQLite 数据库与运行时数据（已在 .gitignore 中预留）
├── docs/
│   ├── architecture.md    # 系统设计文档
│   └── roadmap.md         # 开发路线图（Phase 0 – Phase 4）
├── docker-compose.yml
├── LICENSE
└── README.md
```

> 说明：上述 `packages/`、`plugins/`、`config/`、`data/` 目录当前尚未创建，将随 Phase 0 开发逐步建立；`data/` 已与 `.gitignore` 的预留保持一致。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：设计哲学、技术栈选型、分层架构、数据库即互斥插件、插件管理器六大子系统、前端 Slot 插槽、Manifest 规范、部署模型 |
| [docs/roadmap.md](docs/roadmap.md) | 开发路线图：Phase 0 – Phase 4 的目标、任务清单与验收口径 |

## 快速开始

本项目处于骨架初始化阶段，尚无代码可运行。请先阅读 [docs/architecture.md](docs/architecture.md) 了解系统设计，再按 [docs/roadmap.md](docs/roadmap.md) 的 **Phase 0（基础骨架）** 启动开发。

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
