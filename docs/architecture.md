# GeeWiki 系统设计文档

> 本文档是 GeeWiki 的系统设计蓝图，事实来源为项目构想全文，字段、键名与数值（如 `drainTimeout: 5`、5 秒试用期、退出码 1 等）均按原稿保留。代码实现将随 [roadmap.md](./roadmap.md) 的各阶段逐步落地。

## 1. 总览与设计哲学

GeeWiki 是面向团队内部的 **AI 原生 Wiki 知识库**。核心哲学为 **"万物皆插件，积木式搭建"**：从数据库、AI 服务、编辑器到前端 UI 组件，一切能力都以插件形式存在，由统一的插件管理器负责加载、约束、隔离与生命周期管理。

三大设计目标：

- **极致轻量**：系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用），0 外部依赖部署。
- **高可扩展性**：插件生态按冲突组划分（数据库组、LLM 组、编辑器组……），前端通过**宿主侧 Slot 插槽**动态插拔组件（边界见第 6 章）。
- **安全可控**：热插拔需显式授权、会话层沙箱自愈、看门狗熔断、迁移控制器拦截，保证系统在持续扩展中保持稳定。

设计参照（见第 9 节）：借鉴 PandaWiki 的 Wiki 功能边界并摒弃其重架构（Redis、多服务拆解）；学习 Cordis 生态中插件间 `ctx` 的隔离与通信模式；参考 VS Code / Obsidian 的插件沙箱与禁用/启用交互范式。

## 2. 技术栈选型

| 层次 | 选型 | 理由 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis)（`cordis@^4.0.0-rc.10`） | 提供依赖注入、事件总线与插件生命周期管理，天然契合"万物皆插件"的内核需求 |
| 开发语言 | TypeScript（Node.js 环境） | 静态类型约束插件契约（manifest、接口），生态成熟 |
| 前端框架 | React 19+ | 管理台基座；插件 UI 经 `window.__GEEWIKI_HOST__` 暴露的 React 单例 + 插槽注册接入（**未使用 Suspense / use Hook 做远端 Bundle 懒加载**，见第 6 章） |
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
React 19 前端（宿主侧 Slot：`app-header` / `app-footer` 两个插槽，插件 UI 经 `window.__GEEWIKI_HOST__` 注册 / 依赖图可视化）
        │
        │  REST API（HTTP）
        ▼
Plugin Manager（核心大脑）：热加载引擎、依赖图/冲突组、会话层沙箱机制、迁移控制器、看门狗探针、配置热管理中心
        │
        │  服务抽象层 (DI)
        ▼
插件生态（按冲突组划分）：[数据库组: SQLite / PG] [LLM组: OpenAI / Anthropic] [编辑器组: Milkdown / TipTap]
```

各层职责（对应上图中原稿的完整描述）：

1. **React 19 前端**：管理界面与 Wiki 界面。宿主侧 Slot 插槽机制——插件 UI bundle 加载后把组件注册进宿主的 `app-header` / `app-footer` 插槽（无后端 `ctx.slot()` 链路，见第 6 章）；以 React Flow 渲染依赖图可视化。前端通过 **REST API（HTTP）**与 Plugin Manager 通信——**当前没有 WebSocket / 推送通道**，界面数据靠请求-响应获取。
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
- **自动提示替换（已落地）**：加载新插件时，若其组内已有激活插件，直接 `enable` 会被互斥拦截（409 `conflict_group`，响应带 `details.with` = 冲突插件名）；管理台据此弹出**顶替确认框**（列出被顶替插件与前端按 `requires` 反查出的依赖方），用户确认后调 `POST /api/plugins/:name/replace` 完成替换。
- **替换的语义**：目标已激活 → 幂等返回当前快照；组内无冲突 → 降级为普通会话层启用；有冲突 → 前置校验（目标 `runtime.supportsHotReload`、热依赖链可用、**旧插件的持久化层必须是 session**，基础层属冷操作 → 409 `base_layer`）→ 卸载集合 = 旧插件 ∪ 其**传递依赖方**中当前活跃者（`packages/manager/src/deps.ts` 的 `collectDependentsClosure`），按拓扑序**逆序**卸载 → 激活目标（`skipDeps` 传 `{旧插件}`，避免它被当依赖重新拉起）→ 按正向拓扑序把依赖方接回新提供者，记入响应的 `restarted`。
- **替换的失败语义**：任一环节失败 → 防御性卸下目标、按正向序恢复旧插件与依赖方，并把会话清单**还原成调用前的字节**（含条目顺序）；恢复也失败 → 500 `replace_rollback_failed`，此时状态不确定、需人工介入。注意这条路径**不是"零落盘"**——卸载集合与逐条 `enable` 都会各自原子落盘，靠"调用前快照 + 回滚成功时原样写回"来保证"失败不留痕"。

### 5.5 数据迁移与版本一致性（迁移控制器）

- 涉及表结构的插件须在 `migrations` 目录存放 SQL/JS 迁移脚本（manifest 的 `geewiki.migrations` 字段声明目录位置）。
- **加载拦截**：插件激活前，管理器自动执行 `ctx.db.migrate()`。
- **失败回滚**：迁移失败（如表冲突）→ 阻止该插件加载并回滚事务，避免 ORM 模型与 Schema 不一致导致 500。

### 5.6 看门狗与优雅降级（Watchdog）

- **试用期机制**：热加载新插件时设定 **5 秒"试用期（Grace Period）"**。
- **健康探针**：持续监测 `/api/health` 响应时间与进程 CPU 负载。
- **自动熔断**：响应超时或资源飙升 → 丢弃该插件的 Session 记录，并向进程发送 **SIGTERM** 重启容器，恢复稳定状态。

### 5.7 插件配置（Schema 驱动的表单 + 持久化 + 热更新）

- 插件在 manifest 的 `geewiki.configSchema` 中声明配置定义。**作者侧 API 采用 [schemastery](https://github.com/shigma/schemastery) 3.18.0**（`Schema.object({...})` 风格），它同时提供类型校验、默认值填充与可序列化的表单描述；插件模块也可以按 cordis 约定声明 `Config: <Schema>`，此时 `ctx.plugin(plugin, raw)` 会自动校验并填默认值。
- **校验与默认值填充一律在服务端完成**（管理器在激活前与热更新前各做一次），并把结果作为"生效配置"记录进插件快照与清单文件；校验还会按 schema 声明的字段做**白名单裁剪**（schemastery 自身不剔除未知字段）。
- REST 端点（挂在既有 `/api/plugins` 路由组）：

  | 方法与路径 | 语义 | 状态码 |
  | --- | --- | --- |
  | `GET /api/plugins/:name/config` | 返回 `{ ok, name, layer, activeLayer, config, schema }`；`layer` 为**持久化层**（这份配置存在哪、重启后是否生效），`activeLayer` 为**激活层**（未激活为 `null`）；`schema` 为清洗后的序列化载荷，无 schema 时为 `null` | 200 / 404 |
  | `PUT /api/plugins/:name/config` | body `{ config }`：校验 → 原子落盘 → 已激活则 `fork.update` 热更新 | 200 / 400 `invalid_config`（附逐条 `{message,path}`）/ 400 `config_not_supported`（**不再由该路径产出**——`packages/manager/src` 中已无该错误码的抛出点，无 schema 插件改走"JSON 原文"通道、形状非法时抛 `invalid_config`）/ 409 `hot_update_failed` |

> **路径里的插件名必须 URL 编码**：`:name` 只占**单个路径段**——路由层先按 `/` 切分、再逐段 `decodeURIComponent`（`packages/server/src/index.ts:270-277`），因此 `GET /api/plugins/@geewiki/wiki/config` 会被切成 5 段而落 `404 not_found`，必须写成 `GET /api/plugins/%40geewiki%2Fwiki/config`（即 `encodeURIComponent(name)`）。包名含 `/` 的插件在 UI 上无影响（前端客户端已统一编码，`packages/web/src/api.ts:176-182`），但 curl / CLI 手工调用会踩。

> **注意两个端点的 `layer` 不同义**：配置端点的 `layer` 是持久化层，列表端点 `GET /api/plugins` 的 `PluginSnapshot.layer` 仍是激活层（未激活 `null`）。判据见 `docs/plugin-platform-plan.md` 批次 C 的端点契约。

- `updateConfig(name, config)` 语义：
  - **未激活**：只落盘、不加载，落盘位置按插件当前所在层（在会话清单里就写 `plugins.session.json`，否则写 `plugins.base.json`；从未出现过默认写基础层）；启用（`POST /enable`）未显式传配置时会回退使用落盘配置。
  - **已激活**：校验 → 落盘 → `fork.update(config)`（cordis 内部为 dispose 旧 apply → 以新配置重新 apply；依赖方会被连带重启，属 inject 的预期行为）。
  - **失败回滚**：`fork.update` 抛错时 `fiber.config` **已经是新值**（cordis 实测行为），因此管理器会显式再 `update(旧配置)` 把进程内配置回滚，并把磁盘也恢复成旧配置，然后以 409 返回回滚后的配置。作用域为"该插件的配置"，不涉及依赖方。
  - 每次 `persistConfig` 都是**原子写**（先写 `<文件>.tmp` 再 `rename`），避免进程在写中途被杀导致清单半截损坏——坏清单会让下次启动丢失全部插件装配。
- 管理台按 schema 自动生成配置表单（`packages/web/src/components/SchemaForm.tsx` + `packages/web/src/lib/configSchema.ts`）：支持开关、数字（尊重 `min`/`max`/`step`）、文本、多行文本（`meta.role: 'textarea'`）、枚举下拉（`union` 且分支全为 `const`）、字段组（`object`）、可增删列表（`array`），其余类型（联合、字典、元组、bitset、transform 等）退化为 JSON 编辑框。**未声明 schema 的插件**（例如零依赖的外部插件）退回 JSON 原文编辑框：**接受并保存原始 JSON，不做结构化校验、不做字段裁剪**（属已知取舍——脚本式插件没有可校验的契约，强行校验只会把合法配置挡在门外）。
- **`hidden` 字段语义**：`meta.hidden === true` 的字段**表单完全不渲染该字段，也没有任何说明行**（`packages/web/src/lib/configSchema.ts:106` 对 `hidden === true` 直接返回 `kind: 'hidden'`，`packages/web/src/components/SchemaForm.tsx:210-212` 的 `case 'hidden': return null`）；它照常参与校验与默认值填充，写进快照与清单，只是**不提供任何编辑入口**。注意 **`kind: 'static'` 是"只读展示"分支而非 hidden 的映射**——它渲染成一段静态文本（`SchemaForm.tsx:213-219`），实际只用于 `const` 节点（`configSchema.ts:136`，即枚举字面量），与"由宿主或迁移写入、不该由管理员手改"无关。
- **`meta.role: 'password'` 已实现表单脱敏，但边界明确**：`role: 'password'` 的字符串字段渲染为**密码输入框**——`packages/web/src/lib/configSchema.ts:132` 置 `secret: role === 'password'`，`packages/web/src/components/SchemaForm.tsx:131-132` 据此设 `type="password"` 与 `autoComplete="new-password"`；只有**非 `textarea`、非 `password`** 的 `role` 才退化为普通文本框并附 `role=…` 注记（`configSchema.ts:133`）。**脱敏只作用于表单输入框的呈现**：`GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层做脱敏），本仓库也没有"密钥加密存储"。
- **安全红线（必须遵守）**：schemastery 的反序列化 `Schema(payload)` 会对节点里的 `callback` 字符串执行 `new Function('return ' + source)()`——插件是半可信输入，因此**前端绝不可对下发的载荷调用 `Schema(payload)`**。管理器在下发前经 `sanitizeSchemaPayload()` 剥离 `callback`/`preserve`/`constructor`，前端只按 `refs` 图渲染（载荷形态为 `{ uid, refs }`，`refs` 是 uid 字符串到节点的映射而非数组，节点上没有 `uid` 字段，`dict`/`list`/`inner`/`sKey` 的值都是数字 uid）。渲染还须做路径记忆与深度上限（schema 允许 DAG 共享与 `lazy` 自引用）。
- 旧式 JSON Schema 字面量（普通对象而非 schemastery 实例）在运行期被视作"无 schema"：跳过结构化校验、只提供 JSON 编辑，并打印一次告警。
- **缓存清理钩子（`runtime.requiresCachePurge`）**：统一卸载出口在 `fiber.dispose()` 完成后，对声明该字段的插件经 cordis 事件总线广播 `CACHE_PURGE_EVENT`（事件名 `geewiki/cache-purge`，常量定义于 `@geewiki/core`，参数为插件名），由持有派生缓存的插件/宿主自行清理。派发走 `ctx.parallel(...)`（内部 `Promise.allSettled`）而非同步 `ctx.emit(...)`：后者无 per-listener 保护，任一监听器抛错会**跳过其后的监听器**，导致后续插件的缓存清理被静默丢失；失败监听器由管理器聚合记录，不影响其它插件与卸载结果。

### 5.8 外部插件发现与加载

- 插件目录为 **`<仓库根>/plugins/<name>/`**（可用 `GEEWIKI_PLUGINS_DIR` 覆盖；`null`/空表示关闭外部发现）。宿主启动时先登记内置注册表，再扫描该目录把外部插件并入同一注册表（`packages/manager/src/discovery.ts`），因此外部插件与内置插件在依赖拓扑、冲突组、会话沙箱、看门狗上**完全同权**。
- 清单来源二选一：子目录 `package.json` 顶层 `geewiki` 键（优先）或独立的 `geewiki.manifest.json`。入口按 `geewiki.entry` → `index.ts` → `index.js` → `src/index.ts` 顺序探测，加载用 `await import(pathToFileURL(entry).href)` 后取 `mod.default ?? mod`（ESM 不解析目录说明符；含 `#`/`?` 的裸绝对路径会被当作 URL 解析失败，故一律走 `pathToFileURL`）。
- **失败隔离**：单个插件的清单缺失/入口缺失/路径越界/重名/加载抛错都只记一条 issue 并跳过它，不阻断宿主启动与其余插件。入口与迁移目录**经 `realpathSync` 取真实路径后**必须仍在插件目录内（拒绝 `../` 穿越与 symlink 逃逸；根目录与候选路径都做真实化，因此把整个插件目录做成 symlink 不会误拒全部插件）；symlink 子目录**是目录则纳入发现、否则记一条 issue**（不再静默忽略）。与内置插件或先发现者重名的一律跳过并告警。
- **发现期问题对外可见**：`GET /api/plugins` 的响应为 `{ plugins, issues }`——`issues` 是 `DiscoveryIssue[]`，元素形状 `{ code, dir, message }`，`code` 为 `missing_manifest` / `invalid_manifest` / `entry_not_found` / `invalid_plugin_path` / `invalid_plugin_dir` / `duplicate_plugin` / `invalid_module` / `load_failed` 八值枚举（`packages/manager/src/discovery.ts`）。因此"目录里躺着但没被加载"的插件**在 API 上可见**（例：插件根目录不可读 → `invalid_plugin_dir`）；前端管理页仍待补"有插件被跳过"的提示位（登记于 `docs/plugin-platform-plan.md` 第 5 节 L-14）。
- 插件目录**不是** pnpm workspace 包，不需要（也不应）为它做安装步骤；入口里的 TypeScript 由宿主进程的 tsx loader 直接执行，因此外部插件只应使用 Node 内置能力与宿主经 `ctx` 暴露的服务（零依赖示例见 `plugins/hello-geewiki/`）。

## 6. 前端 UI 插槽机制（React 19）

**当前实现形态是"仅宿主侧插槽"**：插件的 UI bundle 由浏览器加载后，把组件**注册进宿主预设的插槽**；宿主不向插件暴露任何后端注册 API。

- **宿主 SDK**：`@geewiki/web` 在 `window.__GEEWIKI_HOST__` 上暴露 React 单例与插槽 API（`packages/web/src/lib/hostSdk.ts`，`HOST_SDK_VERSION = '0.1.0'`）：`{ React, jsxRuntime: { jsx, jsxs, Fragment }, registerSlot(name, component), unregisterSlot(name, token?), version }`。初始化必须是宿主入口的**第一个导入**（`packages/web/src/main.tsx:1-3`），因为 import map 指向的 shim 在模块求值期就要读这个全局。
- **React 单例共享（D-8）**：`packages/web/index.html` 的 `<script type="importmap">` 必须位于 head 首位，把裸标识符 `react` 映射到 `/host-sdk/react.js`、`react/jsx-runtime` 映射到 `/host-sdk/jsx-runtime.js`——两者是从 `window.__GEEWIKI_HOST__` 取宿主实例再 re-export 的**薄 shim**（`packages/web/public/host-sdk/`）。插件 bundle 以 external 形式构建，因此与宿主共用同一个 React 实例，不会出现双实例 `Invalid hook call`。**刻意不映射 `react-dom` / `react-dom/client`**——插件不得自带框架。注意这与"用 import map 分发宿主产物"的方案不同：此处 import map 只做**标识符到 shim 的转接**，react 实例仍由宿主 bundle 持有（D-4 / D-8 / S-19）。
- **插槽名是白名单**：当前仅 **`app-header`** 与 **`app-footer`**（`packages/web/src/lib/slots.tsx:12` 的 `export type SlotName = 'app-header' | 'app-footer'`，白名单常量 `SLOT_NAMES` 在 `:15`）。未在名单内的名字只打印 `[geewiki-slot] 未知插槽名 "…"，已忽略（可用：app-header, app-footer）` 并忽略，不抛错。
- **渲染与容错**：`SlotOutlet({ name })` 用 `useSyncExternalStore` 订阅插槽注册表，外层包 `SlotErrorBoundary`（`packages/web/src/lib/slots.tsx:102`）——插件组件渲染抛错时只丢弃该插槽的内容、保留兜底 UI，**主界面不白屏**。`registerSlot(name, component, source = 'host')` 返回**幂等的撤销函数**。
- **插件 UI 的加载**：加载器在 `packages/web/src/lib/pluginUi.ts`，读**入口表** `/plugins-ui/registry.json`（静态 JSON，字段 `{ version, plugins: { "<name>": { entry, css? } } }`），只加载"表中存在**且** `GET /api/plugins` 中 `state === 'active'`"的插件；随后 `await import(/* @vite-ignore */ \`${base}/${meta.entry}\`)`，要求模块导出 `register(host)`（或 default），收集其返回的清理函数，并把插件 CSS 以 `<link data-plugin-ui=…>` 注入文档。`pluginUiBase(name)` 先做路径段校验（段数 ≤2、拒绝 `.` / `..` 与非法字符）再映射为 `/plugins-ui/<name>/`。
- **入口表为什么是静态 JSON**（源码头部 `packages/web/src/lib/pluginUi.ts:15-26` 记录的三条实测理由）：① dev 下直接 `import('/plugins-ui/...')` 会被 Vite 的 import-analysis 改写为 `import(__vite__injectQuery(url, 'import'))` 而返回 500；② dev 的 SPA fallback 对不存在的路径返回 **200 + text/html**，浏览器打出 `Failed to load module script … MIME type of text/html`（JS 捕获不掉）；③ prod 下不存在的路径直接 **404**，而 Chrome 把任何 404 记为控制台 `log:error`。故"先探测再 import"必然产生噪声或误判。
- **静态资源的托管**：`/plugins-ui/**`（入口表 + 各插件 bundle）与 `/host-sdk/**`（shim）都在 `packages/web/public/`（Vite 的 `publicDir`）——dev 由 Vite 直接提供，`vite build` 时被原样复制进 `dist/` 再由后端静态托管。因此**既不需要 Vite proxy，也不需要后端新增挂载点**，dev 与 prod 的 URL 形态完全一致。该目录由 `pnpm --filter @geewiki/web run build:fixtures` 生成（**不在 `pnpm build` 内**）、且被 `.gitignore` 排除，缺失时宿主只是"没有插件 UI 可加载"，不报错。

**已知边界（不要按"完整的插件前端扩展"理解）**：

1. **没有后端注册链路**：不存在 `ctx.slot(name, component)`，插槽注册只发生在浏览器侧；`editor-toolbar-slots`、`admin-page-slots` 等扩展点**尚未提供**（早期设计的目标态，见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节批次 D）。
2. **没有 Suspense + use Hook 懒加载**：远端 bundle 由加载器显式 `import()`；"不白屏"靠上面的 ErrorBoundary，而不是 Suspense Fallback。
3. **未绑定 fork 生命周期**：刷新入口是 `window.__GEEWIKI_PLUGIN_UI__ = { refresh, unload, loaded, base }`（`packages/web/src/lib/pluginUi.ts:262-267`），由宿主显式调用——插件停用/热更新**不会**自动加载或撤销其 UI，需手动刷新。
4. **ESM 模块实例不回收**：`unloadPluginUi` 只做"注销插槽注册 + 移除插件 CSS"，已 import 的模块留在模块图中（源码注释 `:193`；与第 5 节的 L-6 同源）。
5. **样式无隔离**：插件 CSS 以 `<link>` 全局注入文档。
6. **无版本协商与完整性校验**：插件 UI 目前没有签名与版本校验（源码 TODO `:27-30` 登记的三项剩余工作：入口表改由后端下发、按 fork 事件自动刷新、版本与完整性校验）。
7. **import map 的浏览器基线**：import map 需要 Chrome / Edge 89+、Safari 16.4+、Firefox 108+（本项目未提供降级路径）。

依赖图可视化（React Flow DAG，见 5.2）由宿主页面自身渲染，**不经过插槽机制**——早期设计曾把它列为插槽渲染目标，此处按实现收敛。

## 7. 插件元数据规范（Manifest）

每个插件根目录包含 `geewiki.manifest.json`（或扩展 `package.json`，将元数据嵌套在顶层 `geewiki` 键下）。

> 现状说明：**外部插件目录发现已落地**（见 5.8）：宿主启动时扫描 `<仓库根>/plugins/<name>/`，按子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json` 读取清单并加载；内置插件仍由代码内置注册表静态登记（`packages/server/src/index.ts` 的 `defaultRegistry`，共 **4 个已注册**：`@geewiki/http`、`@geewiki/db-sqlite`、`@geewiki/wiki`、`@geewiki/echo`），两者并入同一注册表。**数量口径注意**：默认基础层清单 `config/plugins.base.json` 只**启用 3 个**（`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki`），`@geewiki/echo` 已注册但默认未启用——因此 `GET /api/plugins` 显示 4 条内置，挂载示例外部插件后为 5 条。零依赖示例见 `plugins/hello-geewiki/`。

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
    "entry": "index.ts",
    "runtime": { "supportsHotReload": true, "requiresCachePurge": false, "drainTimeout": 5 },
    "configSchema": "Schema.object({ apiKey: Schema.string().role('password').description('服务密钥') })"
  }
}
```

> 上例的 `configSchema` 是 schemastery 实例（JS 对象），JSON 清单无法表达，故以字符串示意写法；实际写法见 `packages/plugin-echo/src/index.ts` 的 `EchoConfigSchema`（当前内置插件仍以 JSON Schema 风格字面量承载，契约迁移见 `docs/plugin-platform-plan.md` 批次 C 的"现状与契约缺口"）。外部插件的清单若用 JSON 描述，可省略 `configSchema`（该插件将只获得 JSON 原文配置编辑，不做校验与裁剪，见 5.7）。

字段逐项说明：

| 字段名 | 位置 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | 顶层 | 是 | — | 插件名称（npm 风格，如 `@geewiki/ai-assistant`），依赖图与冲突组以它作为标识 |
| `version` | 顶层 | 是 | — | 插件版本号（语义化版本） |
| `geewiki` | 顶层 | 是 | — | 插件元数据命名空间（扩展 package.json 时必填） |
| `geewiki.provides` | `geewiki` | 是 | — | 该插件对外提供的服务/能力标识（如 `ai-service`），供其他插件 `requires` 引用 |
| `geewiki.requires` | `geewiki` | 是 | — | 依赖的插件/服务标识列表（示例依赖 `@geewiki/core`）；加载时自动递归加载未激活的依赖项 |
| `geewiki.conflictGroup` | `geewiki` | 否（可选） | — | 广义冲突组名：同组内全局仅允许激活一个（如 `llm-provider`、`database-provider`） |
| `geewiki.migrations` | `geewiki` | 否（可选目录） | — | 迁移脚本目录（SQL/JS，相对插件目录），插件激活前由迁移控制器执行（见 5.5）；外部插件的该目录必须位于插件目录内（拒绝路径穿越） |
| `geewiki.entry` | `geewiki` | 否 | `index.ts` → `index.js` → `src/index.ts` | 外部插件入口文件（相对插件目录）；仅外部插件使用，探测顺序见 5.8 |
| `geewiki.runtime.supportsHotReload` | `geewiki.runtime` | 否 | `false` | 是否允许临时加载/卸载（热操作）。**默认不支持热加载**，必须显式声明为 `true` |
| `geewiki.runtime.requiresCachePurge` | `geewiki.runtime` | 否 | `false` | 热操作/热更新后是否要求清理运行时缓存（示例为 `false`）；卸载后广播 `geewiki/cache-purge` 事件，见 5.7 |
| `geewiki.runtime.drainTimeout` | `geewiki.runtime` | 否 | `5`（秒） | 卸载前等待进行中任务完成的秒数（示例 `drainTimeout: 5`）；`≤ 0` 表示不等待，见 5.1 |
| `geewiki.configSchema` | `geewiki` | 否（可选） | — | 配置定义与校验（schemastery `Schema` 实例），驱动管理界面自动生成配置表单与热更新前的服务端校验（见 5.7） |

## 8. 部署模型

部署编排见根目录 **docker-compose.yml**（Compose V2，无已废弃的 `version` 字段），要点：

- **geewiki-app 服务**：端口 `3000:3000`；环境变量 `NODE_ENV=production`，以及应用实际读取的 `GEEWIKI_PORT=3000`、`GEEWIKI_CONFIG_DIR=/app/config`（插件清单目录）、`GEEWIKI_DATA_DIR=/app/data`（SQLite 数据库与 `crash.marker` 所在目录）、`GEEWIKI_PLUGINS_DIR=/app/plugins`（**外部插件发现根，由镜像固化；比 `/app` 深一层，插件内裸模块说明符才能上溯到部署树 `/app/node_modules`**——**必须是绝对路径**，相对值会回退到 `process.cwd()`，覆盖工作目录时静默发现 0 个插件且不报错）、`GEEWIKI_WEB_DIST=/app/packages/web/dist`（前端静态产物目录；其默认值 `packages/web/dist` 以**仓库根**为基准解析，与进程工作目录无关，镜像内通常无需显式给出）；三个挂载卷 `./data:/app/data`（SQLite 数据）、`./plugins:/app/plugins`（外部插件挂载点，由 5.8 的发现器消费：容器内把插件目录挂进来即可被发现；**外部插件只来自该挂载——`plugins/` 刻意不打进镜像**，见 [deployment.md](deployment.md)）、`./config:/app/config`（插件清单）；`restart: unless-stopped`。清单文件名固定为 `<config 目录>/plugins.base.json`（基础层）与 `plugins.session.json`（会话层），无独立环境变量。**镜像自带** `/app/config/plugins.base.json`（构建期 `COPY` 进镜像，默认启用 db-sqlite/http/wiki 三条），因此不挂 config 卷也能正常起来；但**一旦挂上一个空的宿主 `./config`，镜像内那份就被遮蔽**——空清单 → 无插件激活 → 日志 `REST API 未挂载` → 进程以 `exit=0` 退出 → 被 `restart: unless-stopped` 反复拉起，形成**静默重启循环**（已实测；排障见 [deployment.md](deployment.md) 第 9 节）。
- **容器交付状态（已提供并已实测）**：多阶段 `Dockerfile` 已落地 —— `builder` 阶段安装依赖、构建前端（`packages/web/dist`）并生成 `pnpm --filter @geewiki/server deploy --legacy --prod` 生产部署树，`runtime` 阶段仅携带部署树 + 前端产物 + 运行期 `tsx`，以非 root 的 `node` 用户运行；`docker compose up -d --build` 可直接启动（已实测构建、健康检查、持久化与 SIGTERM 优雅退出）。镜像自带 `HEALTHCHECK`，判据为 `/api/health` 的 `ok:true` **且** `db.present:true`（仅判 HTTP 200 会在数据目录不可写时误报健康）。**Docker 批次实跑另确认**：镜像从零重建成功、镜像内自带基础层清单（不挂 config 卷也能服务）、`-w /tmp` 覆盖工作目录后插件发现根不漂移（外部插件仍被发现）。目录权限、备份、排障与验证清单见 [deployment.md](deployment.md)；本地开发仍推荐 `pnpm dev`。
- **自愈逻辑**（已由应用实现，见 `packages/server/src/index.ts` 与 `packages/manager/src/index.ts`）：仅在三种情形写入 `<data 目录>/crash.marker` —— 未捕获异常、未处理 Promise 拒绝、`startServer()` 抛错；重启后启动阶段检测到该标记即跳过会话层装配并删除标记，系统回滚至基础层（与 5.3 会话层沙箱呼应）。**HTTP 监听失败（如端口被占用）不属于上述情形：进程以退出码 1 退出，但不写标记**。看门狗熔断则先清空会话层清单文件，再以退出码 **1** 退出。
- **postgres 服务**：`image: postgres:15`，挂载在 `profiles: ["production"]` 之下（默认不启动，仅启用 PG 插件时通过 `docker compose --profile production up -d` 启动）；环境变量 `POSTGRES_DB=geewiki`、`POSTGRES_USER=geewiki`、`POSTGRES_PASSWORD=${DB_PASSWORD:-}`（`:-` 兜底只为消除未启用 profile 时的告警；未提供口令时 postgres 会拒绝空口令初始化并立即退出，属安全失败，见 [deployment.md](deployment.md)）；数据保存在 named volume `pgdata`。
- **密钥管理**：仓库不提交 `.env` 文件；`DB_PASSWORD` 由部署者在部署环境的 `.env` 中提供。
- **默认开箱即用**：不启用任何 profile 时仅运行 geewiki-app，SQLite 持久化于 `./data`，无需额外数据库容器。

## 9. 参考与对比

- **PandaWiki**：借鉴其 Wiki 功能边界，摒弃重架构（Redis、多服务拆解）。
- **Cordis 生态**：学习插件间 `ctx` 的隔离与通信模式。
- **VS Code / Obsidian**：借鉴插件沙箱与禁用/启用交互范式（对应本系统的会话层沙箱与显式授权热插拔）。
