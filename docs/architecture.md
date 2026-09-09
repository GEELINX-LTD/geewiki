# GeeWiki 系统设计文档

> 本文档是 GeeWiki 的系统设计蓝图，事实来源为项目构想全文，字段、键名与数值（如 `drainTimeout: 5`、5 秒试用期、退出码 1 等）均按原稿保留。代码实现将随 [docs/roadmap.md](docs/roadmap.md) 的各阶段逐步落地。

## 1. 总览与设计哲学

GeeWiki 是面向团队内部的 **AI 原生 Wiki 知识库**。核心哲学为 **"万物皆插件，积木式搭建"**：从数据库、AI 服务、编辑器到前端 UI 组件，一切能力都以插件形式存在，由统一的插件管理器负责加载、约束、隔离与生命周期管理。

三大设计目标：

- **极致轻量**：系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用），0 外部依赖部署。
- **高可扩展性**：插件生态按冲突组划分（数据库组、LLM 组、编辑器组……），前端通过 Slot 插槽动态插拔组件。
- **安全可控**：热插拔需显式授权、会话层沙箱自愈、看门狗熔断、迁移控制器拦截，保证系统在持续扩展中保持稳定。

设计参照（见第 9 节）：借鉴 PandaWiki 的 Wiki 功能边界并摒弃其重架构（Redis、多服务拆解）；学习 Cordis 生态中插件间 `ctx` 的隔离与通信模式；参考 VS Code / Obsidian 的插件沙箱与禁用/启用交互范式。

## 2. 技术栈选型

| 层次 | 选型 | 理由 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis) | 提供依赖注入、事件总线与插件生命周期管理，天然契合"万物皆插件"的内核需求 |
| 开发语言 | TypeScript（Node.js 环境） | 静态类型约束插件契约（manifest、接口），生态成熟 |
| 前端框架 | React 19+ | 利用 use Hook、Suspense 流式渲染及 Compiler 优化，实现前端组件的动态插拔与懒加载 |
| 数据库层 | 插件抽象 | 默认 better-sqlite3（零外部依赖）；生产环境切换 pg（PostgreSQL），见第 4 章"数据库即互斥插件" |
| 容器编排 | Docker Compose（Profiles 模式） | 默认不启动 Postgres 服务，保持开箱即用；生产环境通过 profile 一键拉起数据库 |

## 3. 分层架构

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

各层职责（对应上图中原稿的完整描述）：

1. **React 19 前端**：管理界面与 Wiki 界面。支持 Slot 插槽机制——动态渲染第三方插件注入的 UI 组件；以 React Flow 渲染依赖图可视化。前端通过 API / WebSocket 与 Plugin Manager 通信。
2. **Plugin Manager（核心大脑）**：位于服务抽象层（DI，由 Cordis 提供）之上，包含热加载引擎、依赖图/冲突组管理、会话层沙箱机制、迁移控制器、看门狗探针与配置热管理中心。详见第 5 章。
3. **插件生态**：全部业务能力以插件形式存在，按冲突组划分，例如数据库组（SQLite / PG）、LLM 组（OpenAI / Anthropic）、编辑器组（Milkdown / TipTap）。

## 4. 数据库即互斥插件

系统定义标准 **DatabaseAdapter 接口**，所有数据库能力均由实现该接口的插件提供：

| 接口成员 | 职责 |
| --- | --- |
| `query` | 执行查询/写入，返回结果集（参数化，屏蔽 SQL 方言差异） |
| `migrate` | 执行迁移：应用该插件 migrations 目录中的 SQL/JS 迁移脚本 |
| `transaction` | 提供事务边界：回调内操作全部成功才提交，任一失败整体回滚 |

互斥与默认规则：

- 数据库插件归属 `conflictGroup: "database-provider"`，同一时间仅允许激活一个（机制见 5.4 广义冲突组）。
- 默认激活 **@geewiki/db-sqlite**（基于 better-sqlite3），实现 0 外部依赖部署：仅凭一个 SQLite 数据库文件即可运行整套系统。
- 生产环境切换至 @geewiki/db-pg（PostgreSQL）时，通过 Docker Compose 的 `production` profile 启动 postgres 服务（见第 8 章与根目录 docker-compose.yml）。
- 业务代码只面向 `DatabaseAdapter` 编程，因此 SQLite ↔ PostgreSQL 切换对上层透明。

## 5. 插件管理器子系统（项目核心）

### 5.1 热插拔引擎（基于显式授权）

- **默认不支持热加载**：热操作仅对显式声明者开放——插件须在 manifest 中设置 `runtime.supportsHotReload: true`，才允许被临时加载/卸载。
- **冷热分离**：
  - *热操作*仅针对 UI、AI 工具等**无状态插件**，即时生效；
  - *冷操作*针对数据库驱动、核心鉴权等**有状态/关键插件**，仅支持"持久化安装 + 进程重启"。
- **依赖链检查**：若插件 A 支持热加载、但其依赖的插件 B 不支持热加载，则禁止 A 的热加载。
- **优雅排空**：卸载前按 manifest 的 `runtime.drainTimeout`（单位：秒，见第 7 章）等待进行中任务完成，超时才强制卸载。

### 5.2 依赖图谱与约束系统

- 后端维护插件依赖数据并提供查询 API；前端使用 **React Flow** 将依赖图渲染为 DAG。
- **加载时**：自动递归加载所有未激活的依赖项。
- **卸载时**：计算下游依赖者（反向依赖）；若存在依赖者，则阻止卸载并弹窗提示。
- **节点颜色区分热能力**：绿色 = 支持热加载；红色 = 需重启。

### 5.3 会话层沙箱机制（防崩溃安全阀）

- **双层状态存储**：
  - *基础层（Base Layer）*：持久化于磁盘，保存系统稳定运行的插件清单（对应部署中的 `plugins.base.json`）；
  - *会话层（Session Layer）*：保存在内存/临时文件中，记录管理员在会话中的临时调整（对应 `plugins.session.json`）。
- **临时操作仅修改会话层**，即时生效，用于测试新插件或新组合。
- **自愈恢复**：临时插件导致崩溃/卡死时，只需重启容器——系统忽略会话层、自动回滚至基础层状态；仅当管理员点击**"应用并持久化"**，会话层变动才会被合并进基础层。

### 5.4 广义冲突组管理

- 插件通过 `conflictGroup` 字段声明组别；管理器维护组注册表。
- **同组互斥**：同一组内全局只能激活一个插件（类似 Windows 的默认应用设置）。
- **自动提示替换**：加载新插件时，若其组内已有激活插件，管理器自动提示替换。

### 5.5 数据迁移与版本一致性（迁移控制器）

- 涉及表结构的插件须在 `migrations` 目录存放 SQL/JS 迁移脚本（manifest 的 `geewiki.migrations` 字段声明目录位置）。
- **加载拦截**：插件激活前，管理器自动执行 `ctx.db.migrate()`。
- **失败回滚**：迁移失败（如表冲突）→ 阻止该插件加载并回滚事务，避免 ORM 模型与 Schema 不一致导致 500。

### 5.6 看门狗与优雅降级（Watchdog）

- **试用期机制**：热加载新插件时设定 **5 秒"试用期（Grace Period）"**。
- **健康探针**：持续监测 `/api/health` 响应时间与进程 CPU 负载。
- **自动熔断**：响应超时或资源飙升 → 丢弃该插件的 Session 记录，并向进程发送 **SIGTERM** 重启容器，恢复稳定状态。

### 5.7 插件配置热更新（JSON Schema 驱动）

- 插件在 `configSchema`（JSON Schema）中声明配置项与校验规则，例如 `apiKey: { type: 'string', format: 'password' }`。
- 管理界面利用 Schema **自动生成 React 配置表单**（含密码等敏感字段的展示与脱敏处理）。
- 修改配置后，管理器经**事件总线**推送新配置（`ctx.config.update()`），无需卸载重载；若插件声明 `runtime.requiresCachePurge`，热更新后按需执行缓存清理。

## 6. 前端 UI 插槽机制（React 19 深度应用）

- 在 **@geewiki/web-ui** 中预设扩展点：`header-slots`、`editor-toolbar-slots`、`admin-page-slots` 等。
- 插件通过 `ctx.slot('header-slots', MyReactComponent)` 注册组件（UI 插件属于无状态插件，支持热操作）。
- **懒加载**：React 19 的 Suspense + use Hook 将远端插件的 JS Bundle 懒加载到主界面。
- **卸载不白屏**：插件被热卸载时，Suspense 自动触发 Fallback UI，主界面保持可用。
- 依赖图可视化（React Flow DAG，见 5.2）同样以插槽形式渲染进管理界面。

## 7. 插件元数据规范（Manifest）

每个插件根目录包含 `geewiki.manifest.json`（或扩展 `package.json`，将元数据嵌套在顶层 `geewiki` 键下）。完整示例：

```json
{
  "name": "@geewiki/ai-assistant",
  "version": "1.0.0",
  "geewiki": {
    "provides": "ai-service",
    "requires": ["@geewiki/core"],
    "conflictGroup": "llm-provider",
    "migrations": "./migrations",
    "runtime": { "supportsHotReload": true, "requiresCachePurge": false, "drainTimeout": 5 },
    "configSchema": { "type": "object", "properties": { "apiKey": { "type": "string", "format": "password" } } }
  }
}
```

字段逐项说明：

| 字段名 | 位置 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | 顶层 | 是 | — | 插件名称（npm 风格，如 `@geewiki/ai-assistant`），依赖图与冲突组以它作为标识 |
| `version` | 顶层 | 是 | — | 插件版本号（语义化版本） |
| `geewiki` | 顶层 | 是 | — | 插件元数据命名空间（扩展 package.json 时必填） |
| `geewiki.provides` | `geewiki` | 是 | — | 该插件对外提供的服务/能力标识（如 `ai-service`），供其他插件 `requires` 引用 |
| `geewiki.requires` | `geewiki` | 是 | — | 依赖的插件/服务标识列表（示例依赖 `@geewiki/core`）；加载时自动递归加载未激活的依赖项 |
| `geewiki.conflictGroup` | `geewiki` | 否（可选） | — | 广义冲突组名：同组内全局仅允许激活一个（如 `llm-provider`、`database-provider`） |
| `geewiki.migrations` | `geewiki` | 否（可选目录） | — | 迁移脚本目录（SQL/JS），插件激活前由迁移控制器执行（见 5.5） |
| `geewiki.runtime.supportsHotReload` | `geewiki.runtime` | 否 | `false` | 是否允许临时加载/卸载（热操作）。**默认不支持热加载**，必须显式声明为 `true` |
| `geewiki.runtime.requiresCachePurge` | `geewiki.runtime` | 否 | `false` | 热操作/热更新后是否要求清理运行时缓存（示例为 `false`） |
| `geewiki.runtime.drainTimeout` | `geewiki.runtime` | 否 | `5`（秒） | 卸载前等待进行中任务完成的秒数（示例 `drainTimeout: 5`） |
| `geewiki.configSchema` | `geewiki` | 否（可选） | — | JSON Schema 格式的配置定义与校验（支持 `format: "password"` 等），驱动管理界面自动生成配置表单（见 5.7） |

## 8. 部署模型

部署编排见根目录 **docker-compose.yml**（Compose V2，无已废弃的 `version` 字段），要点：

- **geewiki-app 服务**：`build: .`；端口 `3000:3000`；环境变量 `NODE_ENV=production`、`GEEWIKI_BASE_PLUGINS=/app/config/plugins.base.json`（基础层清单）、`GEEWIKI_SESSION_PLUGINS=/app/config/plugins.session.json`（会话层清单）；三个挂载卷 `./data:/app/data`（SQLite 数据）、`./plugins:/app/plugins`（外部插件挂载点）、`./config:/app/config`（插件清单）；`restart: unless-stopped`。
- **自愈逻辑**：应用启动脚本内置——若进程崩溃退出码为 **1**，自动删除 session 配置并重启，系统回滚至基础层（与 5.3 会话层沙箱呼应）。
- **postgres 服务**：`image: postgres:15`，挂载在 `profiles: ["production"]` 之下（默认不启动，仅启用 PG 插件时通过 `docker compose --profile production up -d` 启动）；环境变量 `POSTGRES_DB=geewiki`、`POSTGRES_USER=geewiki`、`POSTGRES_PASSWORD=${DB_PASSWORD}`；数据保存在 named volume `pgdata`。
- **密钥管理**：仓库不提交 `.env` 文件；`DB_PASSWORD` 由部署者在部署环境的 `.env` 中提供。
- **默认开箱即用**：不启用任何 profile 时仅运行 geewiki-app，SQLite 持久化于 `./data`，无需额外数据库容器。

## 9. 参考与对比

- **PandaWiki**：借鉴其 Wiki 功能边界，摒弃重架构（Redis、多服务拆解）。
- **Cordis 生态**：学习插件间 `ctx` 的隔离与通信模式。
- **VS Code / Obsidian**：借鉴插件沙箱与禁用/启用交互范式（对应本系统的会话层沙箱与显式授权热插拔）。
