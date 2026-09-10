# GeeWiki 系统设计文档

> 本文档是 GeeWiki 的系统设计蓝图，事实来源为项目构想全文，字段、键名与数值（如 `drainTimeout: 5`、5 秒试用期、退出码 1 等）均按原稿保留。代码实现将随 [roadmap.md](./roadmap.md) 的各阶段逐步落地。

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
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis)（`cordis@^4.0.0-rc.10`） | 提供依赖注入、事件总线与插件生命周期管理，天然契合"万物皆插件"的内核需求 |
| 开发语言 | TypeScript（Node.js 环境） | 静态类型约束插件契约（manifest、接口），生态成熟 |
| 前端框架 | React 19+ | 利用 use Hook、Suspense 流式渲染及 Compiler 优化，实现前端组件的动态插拔与懒加载 |
| 数据库层 | 插件抽象 | 默认 better-sqlite3（零外部依赖）；生产环境切换 pg（PostgreSQL），见第 4 章"数据库即互斥插件" |
| 容器编排 | Docker Compose（Profiles 模式） | 默认不启动 Postgres 服务，保持开箱即用；生产环境通过 profile 一键拉起数据库 |

### 2.1 内核版本事实（cordis）

原稿未指定 cordis 版本，实现期核实结论如下（2026-09，npm registry + 本地 `node_modules` 实测）：

- **实际使用 `cordis@4.0.0-rc.10`**：仓库 6 个包统一声明 `"cordis": "^4.0.0-rc.10"`，锁文件解析即该版本。npm `dist-tags` 为 `latest = 4.0.0-rc.10`、`next = 4.0.0-beta.5`——即默认安装命令拿到的就是这条 RC 线。
- **未采用 3.x 稳定线**：3.x 序列止于 `3.18.1`（已不再被 `latest` 指向）。本项目实现面向 4.x 的 API 面（`ctx.plugin()` 返回可 `dispose()` 的 Fiber、`ctx.provide/get` 服务注册、事件总线 `ctx.on/emit`），保持现状不做跨大版本迁移。
- **Node 兼容性**：`cordis@4.0.0-rc.10` 自身未声明 `engines` 字段，本项目在 Node 22.23.2 上实测通过（typecheck 7/7、单元测试全绿、运行期装配正常）。
- **升级路径**：`^4.0.0-rc.10` 按 semver 覆盖 `4.0.0` 正式版及其后 4.x，届时 `pnpm update cordis` 即可（若 4.0.0 有 API 破坏需同步回归）。
- **类型面缺口**：4.x 的 `lib/index.d.ts` 以 `export *` 链暴露类型，外部消费时 `Context` 的方法补充声明可能不生效；仓库以 `packages/core/src/cordis-env.ts` 自包含增强补齐（所有包经 `@geewiki/core` 获得该增强）。

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
  - *语义（当前实现，务必按此理解）*：排空等待的是**全站在途请求**（一次卸载会等待所有插件的在途请求），
    **不含发起本次卸载的那次请求自身**——REST 停用插件时，管理请求本身也在在途计数里，
    若不自排除就会"等自己"，必然空转满 `drainTimeout` 并打出假的超时告警（该缺陷已修复，见 `packages/server/test/router.test.ts` 回归用例）。
    按插件（owner）粒度排空属于**后续工作**，当前不做请求来源归属。
  - *实现现状（已落地）*：`@geewiki/http` 的路由服务以 `inflight()` 跟踪"处理器尚未结算"的在途请求，
    `pending()` 返回**扣除调用方自身请求**后的在途数，`drain(timeoutMs)` 等待其归零；
    管理器在**统一卸载出口**（`disable` / `enable` 失败回滚 / `disposeAll`）先看 `pending()`（为 0 则零开销直卸），
    否则调用 `drain(drainTimeout × 1000)`：成功则打印 `排空完成：耗时 Xms（等待 N 个在途请求）` 后继续 `fiber.dispose()`，
    超时则打印告警（含仍未结算的请求数）后**强制卸载**；`drainTimeout ≤ 0` 表示不等待。
    `@geewiki/http` 自身关停时同样先排空在途 API 请求再关闭监听。

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
  - *实现现状（部分落地）*：卸载侧已消费该字段——统一卸载出口在 `fiber.dispose()` 完成后，对声明 `requiresCachePurge: true` 的插件经 cordis 事件总线广播 `CACHE_PURGE_EVENT`（事件名 `geewiki/cache-purge`，常量定义于 `@geewiki/core`，参数为插件名），由持有派生缓存的插件/宿主自行清理。派发走 `ctx.parallel(...)`（内部 `Promise.allSettled`）而非同步 `ctx.emit(...)`：后者无 per-listener 保护，任一监听器抛错会**跳过其后的监听器**，导致后续插件的缓存清理被静默丢失；失败监听器由管理器聚合记录，不影响其它插件与卸载结果。配置**热更新**（`ctx.config.update()` 推送 + `configSchema` 自动表单）仍属 Phase 4。

## 6. 前端 UI 插槽机制（React 19 深度应用）

- 在 **@geewiki/web-ui** 中预设扩展点：`header-slots`、`editor-toolbar-slots`、`admin-page-slots` 等。
- 插件通过 `ctx.slot('header-slots', MyReactComponent)` 注册组件（UI 插件属于无状态插件，支持热操作）。
- **懒加载**：React 19 的 Suspense + use Hook 将远端插件的 JS Bundle 懒加载到主界面。
- **卸载不白屏**：插件被热卸载时，Suspense 自动触发 Fallback UI，主界面保持可用。
- 依赖图可视化（React Flow DAG，见 5.2）同样以插槽形式渲染进管理界面。

## 7. 插件元数据规范（Manifest）

每个插件根目录包含 `geewiki.manifest.json`（或扩展 `package.json`，将元数据嵌套在顶层 `geewiki` 键下）。

> 现状说明：当前仓库不存在清单文件，也未实现文件清单加载；内置插件由代码内置注册表静态登记（`packages/server/src/index.ts` 的 `defaultRegistry`，共 4 个：`@geewiki/http`、`@geewiki/db-sqlite`、`@geewiki/wiki`、`@geewiki/echo`）。文件清单加载列 Phase 3。

完整示例：

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
| `geewiki.runtime.requiresCachePurge` | `geewiki.runtime` | 否 | `false` | 热操作/热更新后是否要求清理运行时缓存（示例为 `false`）；卸载后广播 `geewiki/cache-purge` 事件，见 5.7 |
| `geewiki.runtime.drainTimeout` | `geewiki.runtime` | 否 | `5`（秒） | 卸载前等待进行中任务完成的秒数（示例 `drainTimeout: 5`）；`≤ 0` 表示不等待，见 5.1 |
| `geewiki.configSchema` | `geewiki` | 否（可选） | — | JSON Schema 格式的配置定义与校验（支持 `format: "password"` 等），驱动管理界面自动生成配置表单（见 5.7） |

## 8. 部署模型

部署编排见根目录 **docker-compose.yml**（Compose V2，无已废弃的 `version` 字段），要点：

- **geewiki-app 服务**：端口 `3000:3000`；环境变量 `NODE_ENV=production`，以及应用实际读取的 `GEEWIKI_PORT=3000`、`GEEWIKI_CONFIG_DIR=/app/config`（插件清单目录）、`GEEWIKI_DATA_DIR=/app/data`（SQLite 数据库与 `crash.marker` 所在目录）、`GEEWIKI_WEB_DIST=/app/packages/web/dist`（前端静态产物目录；其默认值 `packages/web/dist` 以**仓库根**为基准解析，与进程工作目录无关，镜像内通常无需显式给出）；三个挂载卷 `./data:/app/data`（SQLite 数据）、`./plugins:/app/plugins`（外部插件挂载点）、`./config:/app/config`（插件清单）；`restart: unless-stopped`。清单文件名固定为 `<config 目录>/plugins.base.json`（基础层）与 `plugins.session.json`（会话层），无独立环境变量。
- **容器交付状态（已提供）**：多阶段 `Dockerfile` 已落地 —— `builder` 阶段安装依赖、构建前端（`packages/web/dist`）并生成 `pnpm --filter @geewiki/server deploy --legacy --prod` 生产部署树，`runtime` 阶段仅携带部署树 + 前端产物 + 运行期 `tsx`，以非 root 的 `node` 用户运行；`docker compose up -d --build` 可直接启动（已实测构建、健康检查、持久化与 SIGTERM 优雅退出）。镜像自带 `HEALTHCHECK`，判据为 `/api/health` 的 `ok:true` **且** `db.present:true`（仅判 HTTP 200 会在数据目录不可写时误报健康）。目录权限、备份、排障与验证清单见 [deployment.md](deployment.md)；本地开发仍推荐 `pnpm dev`。
- **自愈逻辑**（已由应用实现，见 `packages/server/src/index.ts` 与 `packages/manager/src/index.ts`）：仅在三种情形写入 `<data 目录>/crash.marker` —— 未捕获异常、未处理 Promise 拒绝、`startServer()` 抛错；重启后启动阶段检测到该标记即跳过会话层装配并删除标记，系统回滚至基础层（与 5.3 会话层沙箱呼应）。**HTTP 监听失败（如端口被占用）不属于上述情形：进程以退出码 1 退出，但不写标记**。看门狗熔断则先清空会话层清单文件，再以退出码 **1** 退出。
- **postgres 服务**：`image: postgres:15`，挂载在 `profiles: ["production"]` 之下（默认不启动，仅启用 PG 插件时通过 `docker compose --profile production up -d` 启动）；环境变量 `POSTGRES_DB=geewiki`、`POSTGRES_USER=geewiki`、`POSTGRES_PASSWORD=${DB_PASSWORD:-}`（`:-` 兜底只为消除未启用 profile 时的告警；未提供口令时 postgres 会拒绝空口令初始化并立即退出，属安全失败，见 [deployment.md](deployment.md)）；数据保存在 named volume `pgdata`。
- **密钥管理**：仓库不提交 `.env` 文件；`DB_PASSWORD` 由部署者在部署环境的 `.env` 中提供。
- **默认开箱即用**：不启用任何 profile 时仅运行 geewiki-app，SQLite 持久化于 `./data`，无需额外数据库容器。

## 9. 参考与对比

- **PandaWiki**：借鉴其 Wiki 功能边界，摒弃重架构（Redis、多服务拆解）。
- **Cordis 生态**：学习插件间 `ctx` 的隔离与通信模式。
- **VS Code / Obsidian**：借鉴插件沙箱与禁用/启用交互范式（对应本系统的会话层沙箱与显式授权热插拔）。
