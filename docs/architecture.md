# GeeWiki 系统设计文档

> 本文档是 GeeWiki 的系统设计蓝图，事实来源为项目构想全文，字段、键名与数值（如 `drainTimeout: 5`、5 秒试用期、退出码 1 等）均按原稿保留。代码实现将随 [roadmap.md](./roadmap.md) 的各阶段逐步落地。

## 1. 总览与设计哲学

GeeWiki 是面向团队内部的 **AI 原生 Wiki 知识库**。核心哲学为 **"万物皆插件，积木式搭建"**：从数据库、AI 服务、编辑器到前端 UI 组件，一切能力都以插件形式存在，由统一的插件管理器负责加载、约束、隔离与生命周期管理。

三大设计目标：

- **极致轻量**：系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用），0 外部依赖部署。
- **高可扩展性**：插件生态按冲突组划分（数据库组、编辑器组……），而**检索 / 问答 / LLM 契约层三类插件刻意不进任何冲突组**（它们是可自由组合的服务提供方，详见第 9 节）；前端通过**宿主侧 Slot 插槽**动态插拔组件（边界见第 6 章）。
- **安全可控**：热插拔需显式授权、会话层沙箱自愈、看门狗熔断、迁移控制器拦截，保证系统在持续扩展中保持稳定。

设计参照（见第 10 节）：借鉴 PandaWiki 的 Wiki 功能边界并摒弃其重架构（Redis、多服务拆解）；学习 Cordis 生态中插件间 `ctx` 的隔离与通信模式；参考 VS Code / Obsidian 的插件沙箱与禁用/启用交互范式。

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
插件生态（按冲突组划分）：[数据库组: SQLite / PG] [编辑器组: Milkdown / TipTap]
        ＋
AI 能力层（**不进任何冲突组**，可自由组合）：@geewiki/search（FTS5+trigram 检索，默认启用）
        → @geewiki/ai（检索增强问答，无 key 时降级 retrieval-only）→ @geewiki/llm（契约层：route→provider 注册表，**本阶段尚无厂商 adapter**）
```

各层职责（对应上图中原稿的完整描述）：

1. **React 19 前端**：管理界面与 Wiki 界面。宿主侧 Slot 插槽机制——插件 UI bundle 加载后把组件注册进宿主的 `app-header` / `app-footer` 插槽（无后端 `ctx.slot()` 链路，见第 6 章）；以 React Flow 渲染依赖图可视化。前端通过 **REST API（HTTP）**与 Plugin Manager 通信——**当前没有 WebSocket / 推送通道**，界面数据靠请求-响应获取。
2. **Plugin Manager（核心大脑）**：位于服务抽象层（DI，由 Cordis 提供）之上，包含热加载引擎、依赖图/冲突组管理、会话层沙箱机制、迁移控制器、看门狗探针与配置热管理中心。详见第 5 章。
3. **插件生态**：全部业务能力以插件形式存在。**按冲突组划分**的是真正互斥的同类实现，例如数据库组（SQLite / PG）、编辑器组（Milkdown / TipTap）；而**检索（`@geewiki/search`）、问答（`@geewiki/ai`）、LLM 契约层（`@geewiki/llm`）三类插件刻意不进任何冲突组**——它们提供的是可被多方复用的服务，互斥应留给各厂商 adapter 自己声明（详见第 9 节）。

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
- **自动提示替换（已落地）**：加载新插件时，若其组内已有激活插件，直接 `enable` 会被互斥拦截（409 `conflict_group`，响应带 `details.with` = 冲突插件名）；管理台据此弹出**顶替确认框**（列出被顶替插件与前端按 `requires` 反查出的依赖方——**只列当前活跃者**，与后端"卸载/接回集合 = 传递闭包 ∩ 活跃集合"的口径一致；框内并预告"替换期间被卸载的插件会短暂不可用（约几秒，需等待在途请求排空），完成后自动恢复"），用户确认后调 `POST /api/plugins/:name/replace` 完成替换。
- **替换的语义**：目标已激活 → 幂等返回当前快照（`replaced: null`）；组内无冲突 → 降级为普通会话层启用（`replaced: null`，管理台据此改说"冲突已解除，已直接启用 X（未发生替换）"）；有冲突 → 前置校验（零副作用）→ 卸载集合 = 旧插件 ∪ 其**传递依赖方**中当前活跃者（`packages/manager/src/deps.ts` 的 `collectDependentsClosure` 取闭包、调用方再与活跃集合取交集），按拓扑序**逆序**卸载 → 激活目标（`skipDeps` 传 `{旧插件}`，避免它被当依赖重新拉起）→ 按正向拓扑序把依赖方接回新提供者，记入响应的 `restarted`。
- **替换的前置校验（含三类拒绝，均在产生任何副作用之前，故拒绝路径零残留）**：热能力校验——目标 `runtime.supportsHotReload` 非 true → 409 `hot_reload_not_supported`；热依赖链存在未激活的冷依赖 → 409 `hot_dependency_not_supported`。三类拒绝：① **旧插件（被顶替者）的真实激活层**必须是 session（判据为 `this.plugins.get(conflict)?.layer`，**不是 `layerOf()`**——后者语义是"配置的写入目标层"、判的是"会话清单里有没有条目"，`disable()` 用的也是真实激活层，两处必须一致）；非 session → 409 `base_layer`（基础层属冷操作；同名条目同时出现在基础层与会话层是本仓库明确支持的**叠加态**，此时插件实际以 base 层激活而 `layerOf()` 会误报 session）；② **整个卸载集合**（旧插件 + 活跃的传递依赖方）中任一成员的真实激活层不是 session → 409 `base_layer`，响应 `details.plugins` 列出基础层成员——卸载走 `deactivateCore` 会绕过 `disable()` 的 base_layer 守卫，而接回依赖方时 `enable()` 落的是**会话层**条目，会把基础层插件的持久化层静默改写；③ **提供者覆盖**：被顶替者自身与每个待接回的依赖方，凡 `requires` 中经 `resolveDependency` 解析后**指向被顶替者**的 token，都必须能被目标承接（目标的**插件名**命中，或目标的 `provides` 命中）；否则 409 `provider_mismatch`（`packages/manager/src/deps.ts` 的 `findUncoveredRequires(registry, replaced, target, names)`，响应 `details` = `{plugin, token, target, targetProvides, violations}`）。目标自身依赖它要顶替掉的插件同样被拒（`details` = `{plugin: 目标名, tokens, target, conflict}`，**不给"目标恰好 provides 同名 token"的豁免**——按名的边仍指向旧插件，目标激活后该依赖恒不满足）。
  - **刻意取舍（对外影响）**：依赖方**按具体插件名**依赖被顶替者时，该替换会被 **409 拒绝**——按名的边无法由新插件承接；正解是依赖方改为依赖**服务标识**（`provides` token，本仓库推荐用法）。取舍理由是"宁可 409，也不返回 200 却留下无人提供的服务"。代价是该场景下用户需先改依赖声明才能完成同组替换；收益是替换成功即保证依赖方服务有人提供。
- **替换的失败语义**：任一环节失败 → 防御性卸下目标、按正向序恢复旧插件与依赖方，并**按调用前的条目顺序与原内容复原会话清单**（`replace()` 在动手前用 `JSON.parse(JSON.stringify(this.session))` 快照，回滚全部成功时写回；**文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行**，因此人工编辑过的非规范格式（自定义缩进 / 字段顺序颠倒 / 无末尾换行）不会被逐字节保留——语义与条目顺序相同、字节不再相同）；恢复也失败 → 500 `replace_rollback_failed`，**此时整个卸载集合的会话条目都已从清单消失（内存与磁盘始终一致、无分歧），需人工介入**；该分支**仅代码路径 + 人工推演，无单测覆盖**（构造"回滚本身也失败"需要更细的注入点）。注意这条路径**不是"零落盘"**——卸载集合与逐条 `enable` 都会各自原子落盘（`writeList()` 的 tmp + `rename`），靠"调用前快照 + 回滚成功时写回"来保证"失败不留痕"。

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
- **发现期问题对外可见**：`GET /api/plugins` 的响应为 `{ plugins, issues }`——`issues` 是 `DiscoveryIssue[]`，元素形状 `{ code, dir, message }`，`code` 为 `missing_manifest` / `invalid_manifest` / `entry_not_found` / `invalid_plugin_path` / `invalid_plugin_dir` / `duplicate_plugin` / `invalid_module` / `load_failed` 八值枚举（`packages/manager/src/discovery.ts`）。因此"目录里躺着但没被加载"的插件**在 API 上可见**（例：插件根目录不可读 → `invalid_plugin_dir`）；前端管理页的"有插件被跳过"提示位**已补**（`packages/web/src/pages/AdminPage.tsx:314` 的 `.discovery-issues` 区块渲染 `code` / `dir` / `message`，样式见 `packages/web/src/styles.css:179-183`），该条缺口已闭合（原登记于 `docs/plugin-platform-plan.md` 第 5 节 L-14）。
- 插件目录**不是** pnpm workspace 包，不需要（也不应）为它做安装步骤；入口里的 TypeScript 由宿主进程的 tsx loader 直接执行，因此外部插件只应使用 Node 内置能力与宿主经 `ctx` 暴露的服务（零依赖示例见 `plugins/hello-geewiki/`）。

## 6. 前端 UI 插槽机制（React 19）

**当前实现形态是"仅宿主侧插槽"**：插件的 UI bundle 由浏览器加载后，把组件**注册进宿主预设的插槽**；宿主不向插件暴露任何后端注册 API。**哪些插件的 UI 该加载由后端下发**（`GET /api/plugins/ui`，见下），加载与撤销则**跟随插件生命周期自动同步**（管理台动作即时、外部变更 ≤15s 收敛）。

- **宿主 SDK**：`@geewiki/web` 在 `window.__GEEWIKI_HOST__` 上暴露 React 单例与插槽 API（`packages/web/src/lib/hostSdk.ts`，`HOST_SDK_VERSION = '0.1.0'`）：`{ React, jsxRuntime: { jsx, jsxs, Fragment }, registerSlot(name, component), unregisterSlot(name, token?), version }`。初始化必须是宿主入口的**第一个导入**（`packages/web/src/main.tsx:1-3`），因为 import map 指向的 shim 在模块求值期就要读这个全局。
- **React 单例共享（D-8）**：`packages/web/index.html` 的 `<script type="importmap">` 必须位于 head 首位，把裸标识符 `react` 映射到 `/host-sdk/react.js`、`react/jsx-runtime` 映射到 `/host-sdk/jsx-runtime.js`——两者是从 `window.__GEEWIKI_HOST__` 取宿主实例再 re-export 的**薄 shim**（`packages/web/public/host-sdk/`）。插件 bundle 以 external 形式构建，因此与宿主共用同一个 React 实例，不会出现双实例 `Invalid hook call`。**刻意不映射 `react-dom` / `react-dom/client`**——插件不得自带框架。注意这与"用 import map 分发宿主产物"的方案不同：此处 import map 只做**标识符到 shim 的转接**，react 实例仍由宿主 bundle 持有（D-4 / D-8 / S-19）。
- **插槽名是白名单**：当前仅 **`app-header`** 与 **`app-footer`**（`packages/web/src/lib/slots.tsx:12` 的 `export type SlotName = 'app-header' | 'app-footer'`，白名单常量 `SLOT_NAMES` 在 `:15`）。未在名单内的名字只打印 `[geewiki-slot] 未知插槽名 "…"，已忽略（可用：app-header, app-footer）` 并忽略，不抛错。
- **渲染与容错**：`SlotOutlet({ name })` 用 `useSyncExternalStore` 订阅插槽注册表，外层包 `SlotErrorBoundary`（`packages/web/src/lib/slots.tsx:102`）——插件组件渲染抛错时只丢弃该插槽的内容、保留兜底 UI，**主界面不白屏**。`registerSlot(name, component, source = 'host')` 返回**幂等的撤销函数**。
- **插件 UI 的加载**：加载器在 `packages/web/src/lib/pluginUi.ts`，不接触 DOM 的纯逻辑部分在 `packages/web/src/lib/pluginUiPlan.ts`（顶层不写 `window`，故可直接用 `node --test` 单测）。**入口表由后端下发**：`GET /api/plugins/ui` → `{ ok, version: 1, revision, plugins: { "<name>": { entry, css?, rev } }, skipped }`，其中 `plugins` **只含**"当前已激活 ∩ 声明了 `geewiki.client` ∩ 入口产物确实存在（只 stat 不读内容）"的插件，`skipped` 逐条记未入表原因（`inactive` / `no_client` / `entry_missing` / `invalid_name`）。前端带 `If-None-Match: "<revision>"`，命中 **304 即零动作**（不触碰已加载 UI）；响应不可信时（请求抛错 / 非 2xx / JSON 解析失败 / 格式不符契约）**既不加载也不卸载**，只 `console.debug`——避免网络抖动清空已加载的界面。`planUiSync(entries, loaded)` 算出"该装载 / 该卸载"的差集：表中新增 → load，已加载但表中消失 → unload，`rev` 变化 → **先卸后装**（产物换了必须重跑 `register`），两个数组均按插件名排序以保证确定性。装载即 `await import(pluginUiBase(name) + '/' + entry)`（**同源绝对 URL，不带任何 query**），要求模块导出 `register(host)`（或 default），收集其返回的清理函数；卸载时执行 disposers、移除 `<link data-plugin-ui=…>`，并以 `epoch` 使在途 import 作废（防"卸载后又被在途 import 复活"）。插件 CSS 由宿主**集中注入** `<link data-plugin-ui=…>`（lib 模式不会自动注入样式，集中注入可避免重复与卸载残留）。`pluginUiBase(name)` 先做路径段校验（1 段非 scope 名，或 2 段且首段为 `@` 开头的 scope 名；段内拒绝 `.` / `..` / 分隔符 / 空白与控制字符）再映射为 `/plugins-ui/<name>`；非法名返回 `undefined` 而不抛错。
- **入口表为什么由后端下发、而不是"拼约定 URL + 试探"**（`packages/web/src/lib/pluginUi.ts:22-26` 记录的三条实测结论）：① dev 下非绝对 URL 的动态 import 会被 Vite 追加 `?import` 并返回 **500**；② dev 下缺失入口返回 **200 + text/html**，浏览器报 MIME 错（`Failed to load module script … MIME type of text/html`，JS 捕获不掉）；③ prod 下缺失入口直接 **404**，而 Chrome 把任何 404 记为控制台 `log:error`。故"先探测再 import"必然产生噪声或误判。现在"产物缺失"由后端归入 `skipped: entry_missing`，前端根本不会去 import 那些插件——三种噪声**结构性消失**。表本身也不再是构建生成物（旧形态 `/plugins-ui/registry.json` **已停用**），而是由活状态（注册表 × 激活集合 × 产物 stat）**每请求现算**（`GeeWikiManager.uiTable()` → `buildPluginUiTable`），因此"装了插件就有 UI、停用就消失"不需要任何重新构建、也不需要重新生成任何 JSON。
- **两条已实测证伪的做法（排障时最容易误判的点，`packages/web/src/lib/pluginUiPlan.ts:17-26`）**：① **不要给 bundle URL 加 `?v=<rev>` 之类的 cache-busting query**——给**根相对** URL 加 query 在 dev 下会触发 Vite 的 `injectQuery` 改写（`?import&v=…`）→ **必然 500**（`This file is in /public…`）；即便改用同源绝对 URL 绕开改写，`rev` 一变就产生**新模块实例**，而 `registerSlot` 是 append、已加载集合只按插件名去重 → **插槽条目翻倍**（实测 widget 2→4），且 ESM 无法从模块图卸载。故 `rev` **只用于变更检测、不进 URL**。② **`/* @vite-ignore */` 并不能阻止 Vite 改写动态 import**——dev 之所以没踩坑，是因为 `pluginUiBase()` 返回的是**同源绝对 URL**（首字符 `h`），而 `injectQuery` 只对以 `.` / `/` 开头的 URL 追加参数；这个"同源绝对 URL"的形态是**硬要求**，不要改成相对路径。
- **生命周期自动同步**：`startPluginUiSync({ intervalMs = 15000 })`（`packages/web/src/main.tsx:21` 调用）先**立即同步一次**，再挂 `visibilitychange`（变可见时同步）与**可见期低频轮询**（`document.hidden` 为真时跳过；`If-None-Match` 让空闲期几乎零成本），返回幂等的停止函数；`syncPluginUi()` 本身**幂等 + 单飞**（在途请求复用同一个 Promise）。集成点是管理台 `AdminPage` 的 `load()`（`packages/web/src/pages/AdminPage.tsx:83`）——它是四条变更成功路径（act / confirmEnable / doReplace / saveConfig）的汇聚点，故**只挂这一处**即可让插槽跟随启停，`revision` 未变时同步是纯 no-op。轮询存在的理由：**外部变更不经过前端**（看门狗试用期回滚会在后端异步 `disable()`、CLI 直接改清单、其它标签页同理），只靠"动作后刷新"会让界面长期与后端不一致；因此**外部变更的 UI 收敛延迟上界是一次轮询间隔（默认 ≤15s）**，而管理台自身动作路径为**即时**。
- **304 短路的一个真问题与修法**：`revision` 只是**表格内容**的哈希，"启用 → 停用 → 再启用"会回到**同一个**值；若此前某次加载失败，304 会让宿主**永久**漏加载那个插件（表内容一样、短路一直命中，界面永远起不来）。修法是 `isUiSettled(entries, loaded, failed)` 判定"界面是否已收敛到最近一次看到的入口表"：**未收敛时不带 `If-None-Match`**（强制取一次完整表重新对齐），并以 `rev` 为键**记忆加载失败**、把"已按同一 rev 失败过"视为已收敛——避免 15s 轮询对同一个坏产物反复 import 与重复告警，`rev` 变化后自然重新尝试。
- **静态资源的托管**：URL 形态为 `/plugins-ui/<插件名>/<单段文件名>`，**插件名不做 URL 编码**（scope 名 `@geewiki/wiki` 就是两个路径段），**编码名一律 404**（编码后 dev 会落 Vite 的 SPA fallback 200 + text/html，prod 静态层不解码必 404）。资产有**双根**、顺序即优先级：① `<插件目录>/dist`（外部插件**自带**产物——Docker 里 `plugins/` 是 bind mount，这是"安装即生效、无需重建 web 包"的唯一路径）② `<pluginUiDist>/plugins-ui/<名>`（内置插件与夹具）。**内置根由 `GEEWIKI_PLUGIN_UI_DIST`（`ServerOptions.pluginUiDist`）指定、缺省 = `webDist`**——两者是**两个独立配置项**（dev 下根 `package.json` 的 `dev` 脚本把内置根设为 `packages/web/public`，而 app shell 仍走 `packages/web/dist`）。之所以必须拆开：`webDist` 一个项曾同时承担"前端产物根（app shell 与 `/assets/*`）"与"内置插件 UI 资产兜底根"两个职责，dev 为让插件 UI 免构建可用而把它指向 `packages/web/public`，那里**没有 `index.html`** → 静态层与 SPA fallback 都取不到 app shell → 后端首页 404（提交 `88e0c58` 修复）。**两个 null 的语义不同**（`packages/server/src/index.ts:605-614` 的类型注释）：`pluginUiDist: null` = **不使用内置根**（只看插件自带产物），`webDist: null` = **不启用静态服务**；且 `pluginUiDist` 缺省**回落 `webDist`**，故既有部署行为完全不变。"用哪个根 / 入口在不在"由 `packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiHit` **唯一**实现，被入口表与静态层的按名查根表（`pluginUiRootsFor`）**共同调用**——这是本机制最关键的不变式：两处若各算一遍，就会出现"表里说就绪、资产却 404"或"`rev` 变了内容还是旧的"这类**在快照里与"没报错"长得一样**的不一致。`/plugins-ui` 在静态层走**独立分支**且**绝不 SPA fallback**：路径不合法/插件不在根表/文件缺失一律 404 `application/json`（若回退 `index.html` 就会被掩盖成 200 `text/html`，浏览器报 MIME 错而真因不可见）。dev 下 `/plugins-ui` 由 `packages/web/vite.config.ts` 的 `server.proxy` 转发到后端——**必须**如此，因为资产可能来自 `plugins/<name>/dist`，位于 `publicDir` 之外。
- **静态层根表禁止缓存（提交 `a24241a`）**：`packages/server/src/index.ts` 的 `pluginUiRoots` 必须**每请求现算**（`config.pluginUiRoots?.() ?? {}`），因为入口表也是每请求现算——两者寿命若不同，就会出现"入口表说该插件就绪（并给出 `rev`），静态层却从**已消失的根**取文件 → 404"，而前端还会照表去 import 那个 404 的资产。触发条件很具体：**同名入口文件在两个候选根都存在**，随后高优先级那个根消失——`resolvePluginUiHit` 会回退到次优先根并在表里继续列出该插件，而缓存仍指着已消失的根。代价可控（`pluginUiRootsFor()` 只对声明了 `client` 的插件做几次 stat，注册表只有几条）。注意保留"函数"形态（而非快照对象）是**另一件事**：它解开的是"http 条目早于外部插件发现"的**注册顺序陷阱**，与缓存无关。

**已知边界（不要按"完整的插件前端扩展"理解）**：

1. **没有后端注册链路**：不存在 `ctx.slot(name, component)`，插槽注册只发生在浏览器侧；`editor-toolbar-slots`、`admin-page-slots` 等扩展点**尚未提供**（早期设计的目标态，见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节批次 D）。
2. **没有 Suspense + use Hook 懒加载**：远端 bundle 由加载器显式 `import()`；"不白屏"靠上面的 ErrorBoundary，而不是 Suspense Fallback。
3. **ESM 模块实例不回收**（`packages/web/src/lib/pluginUi.ts:36-41` 明列为"决策，不是待办"）：`unloadPluginUi` 只做"注销插槽注册 + 移除插件 CSS"，已 import 的模块留在模块图中。因此 `rev` 变化走的是 unload → load，**同一 URL 命中模块缓存**——产物更新后**需整页刷新**才能拿到新代码（未更新时重新 enable 会复用同一实例，`register` 重跑、不累积实例）。与第 5 节的 L-6 同源。
4. **样式无隔离**：插件 CSS 以 `<link data-plugin-ui=…>` 全局注入文档，v1 **不做任何样式隔离**（无 Shadow DOM、无样式前缀改写）。示例夹具以 `.gw-fixture-*` 前缀命名类名（`packages/web/fixtures/src/style.css`）作为**约定示范**，宿主侧无强制手段。
5. **产物内资源只支持单段文件名**：入口与样式名必须匹配 `PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`，因此 `plugins/<name>/dist` 里的**子目录资源（字体 / 图片等）v1 不支持**——插件应把所需资源内联进 bundle。
6. **无版本协商与完整性校验**：插件 UI 目前没有签名与版本校验（`packages/web/src/lib/pluginUi.ts:41` 明确登记为未做的边界）。
7. **import map 的浏览器基线**：import map 需要 Chrome / Edge 89+、Safari 16.4+、Firefox 108+（本项目未提供降级路径）。**本仓的浏览器侧验收（`scripts/acceptance/plugin-ui-cdp.mjs`）只在 Chromium 上实测过**。
8. **验收脚本不接入 `pnpm test`**：`scripts/acceptance/plugin-ui-cdp.mjs` 零依赖（Node 内置 WebSocket + 直连 CDP），但需要 Chrome、一个运行中的实例与已构建的插件产物，属集成/验收层，故**刻意不进 `pnpm test`**（后者只跑无浏览器、无网络的单测）。

依赖图可视化（React Flow DAG，见 5.2）由宿主页面自身渲染，**不经过插槽机制**——早期设计曾把它列为插槽渲染目标，此处按实现收敛。

## 7. 插件元数据规范（Manifest）

每个插件根目录包含 `geewiki.manifest.json`（或扩展 `package.json`，将元数据嵌套在顶层 `geewiki` 键下）。

> 现状说明：**外部插件目录发现已落地**（见 5.8）：宿主启动时扫描 `<仓库根>/plugins/<name>/`，按子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json` 读取清单并加载；内置插件仍由代码内置注册表静态登记（`packages/server/src/index.ts` 的 `defaultRegistry()`，共 **7 个已注册**：`@geewiki/db-sqlite`、`@geewiki/http`、`@geewiki/echo`、`@geewiki/llm`、`@geewiki/search`、`@geewiki/wiki`、`@geewiki/ai`），两者并入同一注册表。**数量口径注意**：默认基础层清单 `config/plugins.base.json` 只**启用 4 个**（`@geewiki/db-sqlite` / `@geewiki/http` / `@geewiki/wiki` / **`@geewiki/search`**），`@geewiki/echo`、`@geewiki/llm`、`@geewiki/ai` 已注册但默认未启用——因此 `GET /api/plugins` 显示 7 条内置，挂载示例外部插件后为 8 条。零依赖示例见 `plugins/hello-geewiki/`。
>
> **`provides` 与服务名不是一回事**：`geewiki.provides` 只是**依赖图谱 token**，不会创建 cordis 服务；且它与本插件 `ctx.provide` 的服务名**并不总相同**（`db-sqlite` 声明 `database-provider` 但提供 `'db'`；`http` 声明 `http-service` 但提供 `'http'`）。**完整映射表见第 9.2 节——写消费方代码前必读。**

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
    "client": { "entry": "client.js", "css": "client.css" },
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
| `geewiki.provides` | `geewiki` | 是 | — | 该插件对外提供的服务/能力标识（如 `ai-service`），供其他插件 `requires` 引用。**⚠️ 这是依赖图谱 token，不会创建 cordis 服务**，且**与 `ctx.provide` 的服务名并不总相同**（`db-sqlite` 声明 `database-provider` 但提供 `'db'`、`http` 声明 `http-service` 但提供 `'http'`；search / wiki / llm / ai 四者同名）——完整映射表见 **9.2 节**，消费方必须按真实服务名 `ctx.get` |
| `geewiki.requires` | `geewiki` | 是 | — | 依赖的插件/服务标识列表（示例依赖 `@geewiki/core`）；加载时自动递归加载未激活的依赖项 |
| `geewiki.conflictGroup` | `geewiki` | 否（可选） | — | 广义冲突组名：同组内全局仅允许激活一个（如 `llm-provider`、`database-provider`） |
| `geewiki.migrations` | `geewiki` | 否（可选目录） | — | 迁移脚本目录（SQL/JS，相对插件目录），插件激活前由迁移控制器执行（见 5.5）；外部插件的该目录必须位于插件目录内（拒绝路径穿越） |
| `geewiki.entry` | `geewiki` | 否 | `index.ts` → `index.js` → `src/index.ts` | 外部插件入口文件（相对插件目录）；仅外部插件使用，探测顺序见 5.8 |
| `geewiki.client` | `geewiki` | 否（可选） | `client: {}` 等价于 `{ entry: 'client.js' }` | **客户端 UI 入口**声明（类型 `GeeWikiClient = { entry?: string; css?: string }`，`packages/core/src/index.ts:53-61`）。`entry` 是 UI 入口**单段文件名**（缺省 `client.js`）、`css` 是可选样式**单段文件名**（缺省不注入样式），两者都相对该插件的 UI 根、都必须匹配 `PLUGIN_UI_FILE_SEGMENT`（`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`，故**不支持子目录**）；声明非法时**整体视为未声明**（不抛错）。**声明后**该插件才会进入宿主下发的入口表 `GET /api/plugins/ui`，未声明则**永不进入**（见第 6 节）。**注意与上一行 `geewiki.entry` 不是一回事**：`entry` 是**后端**入口（`index.ts` 等），`client` 是**前端**入口 |
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

## 9. 检索与 AI 能力层（本阶段新增）

本阶段落地的是"AI 原生知识库"的**检索地基 + 问答骨架**：把"检索"与"生成"彻底解耦，让**没有 API key 时整条链路依然完整可用**。三个插件均在 `packages/server/src/index.ts` 的 `defaultRegistry()` 静态登记，且**都不进任何冲突组**。

### 9.1 三个插件

| 插件 | 包路径 | `provides` | `requires`（服务 token） | 默认部署 | 对外端点 |
| --- | --- | --- | --- | --- | --- |
| `@geewiki/search` | `packages/plugin-search/` | `search-service` | `['database-provider', 'http-service']` | **启用**（`config/plugins.base.json` 第 4 条） | `GET /api/search?q=&limit=&mode=` |
| `@geewiki/llm` | `packages/plugin-llm/` | `llm-service` | `[]`（零依赖，无 provider 也能装载） | 已注册未启用 | 无（纯服务契约层） |
| `@geewiki/ai` | `packages/plugin-ai/` | `ai-service` | `['http-service', 'database-provider', 'search-service', 'llm-service']` | 已注册未启用 | `POST` / `GET /api/ai/ask`、`GET /api/ai/capabilities` |

三者都声明 `runtime.supportsHotReload: true`、`requiresCachePurge: false`、`drainTimeout: 5`，均无进程内状态（索引在库里、路由注册表在内存但可安全重建），故可安全热插拔。`@geewiki/search` 另带 `migrations: './migrations'`（`SEARCH_MIGRATIONS_DIR`），由**管理器的迁移控制器在激活前执行**（见 5.5），不依赖 `db-sqlite` 自己的迁移。

### 9.2 服务名映射表（**消费方必读**）

> ⚠️ **manifest 的 `provides` token 与本插件 `ctx.provide` 的服务名并不总相同。** 两者是**两套命名空间**：`requires` 里写的是 **`provides` token**（由管理器的 `resolveDependency` 解析依赖边），而 `ctx.get(...)` 取的是**真实 cordis 服务名**。混用**不会报错**，只会让 `ctx.get` 拿到 `undefined`，表现为"功能静默不可用"——这是本仓最难定位的一类症状。

| `provides` token（写进 `requires` 用） | 真实服务名（`ctx.get` 用） | 提供者插件 | 定义处 | 同名？ |
| --- | --- | --- | --- | --- |
| `database-provider` | **`db`** | `@geewiki/db-sqlite` | `packages/db-sqlite/src/index.ts:160`（`ctx.provide('db', adapter)`） | ❌ **不同名** |
| `http-service` | **`http`** | `@geewiki/http` | `packages/server/src/index.ts:575`（`ctx.provide('http', router)`） | ❌ **不同名** |
| `wiki-service` | `wiki-service` | `@geewiki/wiki` | `packages/plugin-wiki/src/index.ts:443` | ✅ |
| `search-service` | `search-service` | `@geewiki/search` | `packages/plugin-search/src/index.ts:383` | ✅ |
| `llm-service` | `llm-service` | `@geewiki/llm` | `packages/plugin-llm/src/index.ts:117` | ✅ |
| `ai-service` | `ai-service` | `@geewiki/ai` | `packages/plugin-ai/src/index.ts:552` | ✅ |
| （未声明 `provides`） | `manager` | `@geewiki/manager` | `packages/manager/src/index.ts:1393` | — |
| （**已撤销** `echo-service`） | **无服务** | `@geewiki/echo` | — | — |

**本阶段的"服务提供一致性"三次修复**（同一类缺陷的三种表现，均已收敛）：

1. **`@geewiki/wiki` 只声明不提供**：manifest 写着 `provides: 'wiki-service'`，却从未 `ctx.provide` ⇒ 任何 `requires: ['wiki-service']` 的消费方依赖被解析为"已满足"，而 `ctx.get('wiki-service')` 恒为 `undefined`。**已补**真实 `ctx.provide('wiki-service', svc)`（`packages/plugin-wiki/src/index.ts:443`）。
2. **`@geewiki/echo` 谎报 token**：声明 `provides: 'echo-service'` 但从未提供，且**全仓无任何消费方**。**已撤掉**该字段（`packages/plugin-echo/src/index.ts:33`），而不是为它硬造一个无人使用的服务契约。
3. **新增三个插件一律"声明 token + 显式 provide + 同名"**：`search` / `llm` / `ai` 三者的 `provides` token 与服务名**严格同名**，并在源码注释里写明"两者名字必须一致，否则消费方 `ctx.get` 拿到 `undefined`"。

> 判断规则（写新插件时照此执行）：`provides` 是**依赖图谱 token**，它**不会创建任何 cordis 服务**；要对外提供能力，必须显式 `ctx.provide(<服务名>, svc)` 并在 dispose 时注销，同时导出服务契约类型供消费方使用。

### 9.3 `@geewiki/search`：FTS5 + `trigram` 的中文检索事实

**索引形态**（`packages/plugin-search/migrations/0001_search.sql`）：FTS5 **external content** 虚表 `pages_fts(title, content, content='pages', content_rowid='id', tokenize='trigram')`，配三条触发器（`pages_fts_ai` / `pages_fts_ad` / `pages_fts_au`）与末尾的 `rebuild` 回填；迁移脚本**不写 `BEGIN`/`COMMIT`**（`db.migrate()` 已把每个迁移文件包在单个事务里，脚本内再开事务会嵌套报错）。

> ⚠️ **本仓最容易被误传的一点**：中文检索能不能用，**完全取决于 `tokenize` 参数**。以下四条均已在 `better-sqlite3@13.0.3` 上复验（2026-09-10，HEAD `585dbac`）：

| # | 事实 | 实测证据 |
| --- | --- | --- |
| ① | `better-sqlite3` 的**预编译包已含 FTS5**，**无需 node-gyp** | `db.pragma('compile_options')` 含 **`ENABLE_FTS5`**（59 项之一）；`select sqlite_version()` = **3.53.4**；`CREATE VIRTUAL TABLE … USING fts5(x, tokenize='trigram')` 直接成功 |
| ② | FTS5 默认的 **`unicode61` 分词器把连续 CJK 当成一个 token** ⇒ **中文等于搜不到** | 同一段中文正文下，`MATCH '"知识库"'` → **0 命中**、`'"全文检索"'` → **0 命中**、`'"插件化知识库"'` → 0 命中；只有整段完全相同（如 `'"GeeWiki"'`）才命中 |
| ③ | 因此**必须显式 `tokenize='trigram'`** | 同一正文下 `MATCH '"知识库"'` → **1 命中**、`'"全文检索"'` → 1 命中、`'"gee"'` → 1 命中（大小写不敏感的子串匹配） |
| ④ | **trigram 的硬缺口**：查询串 **<3 字符**时 `MATCH` 恒为空 | `MATCH '"检索"'`（中文 2 字）→ **0 命中**、`'"库"'`（1 字）→ 0 命中；`'"知识"'` → 0 命中。该缺口由插件层 **LIKE 兜底**（`mode: 'like'`）覆盖 |

**两条检索路径**（响应里的 `mode` 回传实际走的那条，用于观测与测试）：

- `fts`：查询串（trim 后）**≥3 字符**（`MIN_TRIGRAM_LENGTH = 3`）→ `pages_fts MATCH ?`，按 BM25 相关度排序。查询串经 `toFtsPhrase()` **整体加双引号**（内部双引号翻倍）——这是**查询语法注入防护**：用户输入绝不按 FTS5 语法解释，否则 `*`、`NEAR(`、`a OR b`、裸 `"` 会抛 `fts5: syntax error` 或改变语义。
- `like`：**<3 字符** → LIKE 兜底，且**直接扫 `pages` 真源表而非索引**。这是刻意的：短查询本就用不上 trigram 索引（切不出完整 3 字符片段），且这样在**索引漂移**（迁移未跑全、触发器被删）时短查询仍给出正确结果。`%` / `_` / `\` 经 `escapeLike()` 转义并配 `ESCAPE '\'`。

**索引体积**：trigram 索引与正文**同量级**。本轮自测（5000 行、正文合计 6.23 MB）→ 建索引后库文件增长 **7.07 MB**（≈ **1.14×** 正文）；`migrations/0001_search.sql` 内记录的仓库实测为 6.6 MB 语料 +7.9 MB。

**端点契约** `GET /api/search?q=&limit=&mode=` → `{ ok, query, mode: 'fts'|'like', queryMode: 'phrase'|'terms', total, hits: [{ slug, title, snippet, score, updated_at }] }`：

- **请求参数是 `q` / `limit` / `mode`**；`limit` 须为 **1..100** 的整数（配置项 `limit` 默认 20）；`mode` 缺省 `'phrase'`。
- **响应里有两个方向不同的字段，不要混**：**`mode`** 回传**实际走的那条路径**（`'fts'` / `'like'`，观测与测试用）；**`queryMode`** 回传**本次请求的查询语义**（`'phrase'` / `'terms'`）。
- 参数错误 → **400**：空查询（含只有空白）`invalid_query`；非法 `limit` `invalid_limit`；**非法 `mode`（非 `phrase` / `terms`）`invalid_mode`**——不做静默降级，因为把 `term` / `keywords` 这类拼错当 `phrase` 会表现为"问了却没结果"。
- **`total` 是全量命中数，不受 `limit` 限制**，且用 **`COUNT(DISTINCT p.id)`** 统计：`terms` 模式下 OR 会让同一行被多个词元各自命中，`COUNT(*)` 会把该行按命中次数重复计入，而契约里 `total` 与 `hits` 是同一套"行"语义。
- `snippet` 是**服务端已 HTML 转义的 HTML**（只含 `<mark>`）：正文先按原始下标切片、三段分别转义、再拼进 `<mark>`，故正文里的 `<script>` 不可能逃逸成真标签。**消费方不得二次转义**（会显示成字面 `&lt;mark&gt;`），也不得当纯文本插入页面。自实现高亮而非用 FTS5 的 `snippet()`——trigram 下后者上限约 64 token（≈ 中文 64 字），太短且会把片段切得很碎。
- `score` 是 FTS 路**取负后的 BM25**（越大越相关）；**这不是归一化**——值域无界、量级随语料规模与查询词变化，故**只在同一次查询的结果内部可比**；LIKE 路恒为 `0`，两种 `mode` 的 `score` 也不可比。

**查询语义 `queryMode`（`phrase` 缺省 / `terms`）**——这一维与"走 FTS 还是 LIKE"正交：

- `phrase`（缺省，**搜索框语义**）：整串经 `toFtsPhrase()` 加引号当一个**字面短语**。
- `terms`（**问句检索 / RAG 语义**）：把查询切成**词元**后以 **OR** 连接。切分规则由 trigram 的硬约束决定（<3 字符的词元在 `MATCH` 下恒为空）：**CJK 连续片段**取长度 3 的**滑窗 3-gram**（「检索增强怎么做」→ 检索增/索增强/…）；**ASCII/数字片段**按空白与常见标点切词，只保留长度 ≥3 者。**每个词元仍各自 `toFtsPhrase()` 后拼 OR**——切词与转义分开，"注入防护只有一处实现"。`terms` 切不出词元时（<3 字符、纯标点）**回退 LIKE**（不构造空 `MATCH`，它抛 `fts5: syntax error`）。`terms` 下 BM25 天然让"命中词元更多"的行排前（OR 的相关度是各词元得分之和）；`snippet` 的锚点也改为**逐个词元试**（问句本身不在正文里，用整句定位会让每条命中都高亮为空）。
- **⚠️ 已知缺陷与修复状态（如实记录，以最终提交为准）**：`phrase` 作为缺省使 `@geewiki/ai` 的问答**按整串短语检索**，而自然语言问句几乎不可能逐字连续出现在正文里 ⇒ **恒为 0 命中**，问答的检索地基实际不可用。**修复**即上面的 `terms` 模式，并让 `@geewiki/ai` 一律走 `terms`（`packages/plugin-ai/src/index.ts` 的 `search.search(query, { limit, mode: 'terms' })`）。**截至本文取数时刻，该修复在工作树中已实现但尚未提交**：HEAD `585dbac` 的已提交版本仍是 `search(query, { limit })` 且端点不读 `mode` 参数。**本文不对"问答召回是否正常"下任何断言。**

**服务契约** `SearchService`（`ctx.get('search-service')`）：`search(q, opts?: { limit?: number; mode?: SearchMode }): SearchResult`（`SearchMode = 'phrase' | 'terms'`，缺省 `'phrase'`）与 `contents(slugs: readonly string[]): ReadonlyMap<string, string>`。`search()` 与端点走**同一份实现**（端点只做 HTTP 层），故两者在同 `q` 同 `limit` 下结果逐字段一致；`limit` 非法时服务层抛 `RangeError`（对应端点的 400）。`contents()` 供 RAG 拼上下文，**只包含真实存在的 slug**（查不到的键不出现，消费方据此区分"页面不存在"与"正文为空串"）；占位符按 `slugs.length` 动态生成、值一律参数绑定（绝不把 slug 文本拼进 SQL）。插件卸载后调用**显式报错**，绝不返回空结果——"卸载后静默返回 0 命中"会被误读成"库里没有匹配内容"。

### 9.4 `@geewiki/llm`：契约 + 降级 + 密钥安全（**本阶段不含任何厂商 adapter**）

本阶段有意**不实现任何厂商 adapter**：产品价值"没有 API key 时整条链路依然完整可用"这条契约不需要 adapter 就能验证，而"流式 SSE + 宿主排空"是更难的一层，混批会让两类缺陷互相掩盖。因此**当前实际不存在任何可用 provider**——只注册了一个恒不可用的兜底路由 `null`（`NULL_PROVIDER`：`available: () => false`，被点名时产出单个 `error{MISSING_CREDENTIAL}`）。

**契约要点**（`packages/plugin-llm/src/types.ts`）：

- **统一错误码枚举**（跨 provider 可判别，不依赖各厂商的错误文本）：`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` / `NETWORK` / `PROVIDER_ERROR` / `ABORTED`。
- **调用方按 `type`/`code` 分支，绝不按 `message` 文本分支**——message 是给人看的，可能被脱敏、也可能被上游改写。
- **`error` chunk 在结构上就没有 `message` 字段**：上游报错文本里可能夹带密钥（URL query、鉴权头回显），从结构上让它无处可去，比"记得脱敏"更可靠。
- **终止保证**：`stream()` **保证终止 chunk（`done` / `error`）恰出现一次且在末位**，且**绝不抛异常** ⇒ 消费方可以无判空 `for await`。五条路径都被钉死：provider 抛错 → `error`；signal 已/中途 abort → `error{ABORTED}`；终止之后仍产 chunk → 丢弃并关闭上游；未产终止就结束 → `error{PROVIDER_ERROR}`；无可用 provider → `error{NO_ADAPTER}`。
- **服务本身绝不重试**：重试涉及退避、配额与幂等语义，属独立层的职责；偷偷重试会让上层无法判断"这次失败到底花了多少配额"。
- 重复注册同一 `route` **必须抛错**（不得静默覆盖）；`available()` 抛错视为不可用（不拖垮整个服务）。

**密钥安全**（结构性而非纪律性）：

- 配置里只存**环境变量名**（`apiKeyEnv`，如 `DEEPSEEK_API_KEY`）而非密钥值——结构上杜绝密钥进入**会落盘入库**的 `config/plugins.base.json`。
- `detectSuspiciousCredential()`：识别"把密钥值本身填进该字段"，命中则让**插件激活失败**（throw 而非 `process.exit(1)`——后者会把一个可恢复的配置问题升级成整站不可用）。**保守优先**：全大写 SNAKE 命名（`DEEPSEEK_API_KEY`）一律放行，因为把变量名误判成密钥会让插件无法激活，而漏判只是少脱敏一处日志。
- `redact()`：日志/错误文本脱敏，与检测**共用同一组正则源**（`SECRET_PATTERN_SOURCES`，单一事实来源），并遮蔽 `authorization` / `proxy-authorization` / `x-api-key` / `api-key` 等头名后面的值（保留原有引号，避免把 JSON 日志改成非法 JSON）。
- `status.message` 经 `redact` 后输出；**`text-delta`（模型输出）刻意不脱敏**——脱敏会篡改模型输出内容。

### 9.5 `@geewiki/ai`：检索增强问答的**检索-only 形态**

**核心产品承诺：没有 API key 时也完整可用。** 因此检索与生成彻底解耦：**检索永远执行、`sources` 永远返回**，只有"回答"这一步会因缺模型而降级为零成本的**抽取式摘要**。有没有 key，**响应结构完全相同**（`AskResponse`），差别只在 `mode` / `degraded` / `answer` 三个字段上——前端不必为降级写一套平行的错误分支。

**状态码语义**（`packages/plugin-ai/src/types.ts` 的注释即契约）：`200` = 正常（**含降级、含检索无结果**）、`400` = 调用方输入问题、`500` = 我们自己的代码炸了。**绝不用 4xx/5xx 表达"没有配置模型"**。

| 端点 | 入参 | 成功 | 错误 |
| --- | --- | --- | --- |
| `POST /api/ai/ask` | body `{ q, limit?, extractive? }`（未知字段/非对象 body → `invalid_body`） | `200` + `AskResponse` | `400 empty_query`（`q` 缺失/空白）、`400 too_long`（`q.length > 500`）、`400 invalid_limit`、`400 invalid_extractive`、`400 invalid_json`、`413 payload_too_large`（body 上限 1 MB） |
| `GET /api/ai/ask` | query `q`、`limit`、`extractive` | 同上 | 同上 |
| `GET /api/ai/capabilities` | — | `200` + `CapabilitiesResponse`（`available` / `degraded` / `providers` / `message`） | — |

`MAX_QUERY_LENGTH = 500`（`packages/plugin-ai/src/index.ts:98`）。`capabilities()` 让前端据此决定是否显示"未配置模型"提示，`message` 已脱敏。

**响应字段与降级**：`mode` **诚实反映实际发生了什么**——`retrieval-only`（没有可用 provider，只返回检索结果 + 抽取式摘要；**本阶段恒为此值**）/ `rag`（模型确实生成了回答）/ `rag-partial`（生成中途失败但有部分文本，`partial: true`）。`degraded: { reason, code, message }` 中 `reason` 是**跨 provider 可判别的枚举**（`no_provider` / `missing_credential` / `invalid_credential` / `rate_limit` / `timeout` / `context_window_exceeded` / `network` / `provider_error`，加上本插件自身的 `search_unavailable` / `empty_query`），**前端据此选文案，不要按 `message` 分支**。

**上下文截断策略**（`packages/plugin-ai/src/select.ts:44` 的 `selectSources()`，纯函数）：

- 按 `score` 降序排序（LIKE 路 `score` 全为 0，靠 `Array.prototype.sort` 的稳定性保持检索服务给的 `updated_at DESC` 顺序）。
- 逐条：先用 `perSourceChars` 截断正文，再判断 `usedChars + text.length <= totalContextChars`，且已入选条数 `< maxSourcesInContext`。
- ⚠️ **放不下就整条丢弃，绝不做尾部裁切**：半句话会诱导模型顺着编下去，而"少一条来源"只是信息量略低。
- 答案必须精确回传到响应的 `sources[].used` 与 `sources[].n` 上——否则前端会展示一批"看起来被引用了、实际没进 prompt"的来源。被丢弃者 `used: false` 且 `n: null`；**`n` 只对 `used: true` 者从 1 起连续编号**（故类型是 `number | null`），与 prompt 里的 `[n]` 严格一致。
- 页面在"检索命中"与"取正文"之间被删除（竞态）时该条无法进上下文；注意区分"页面不存在"（`undefined`）与"页面正文为空串"——后者仍可只靠标题入上下文。
- 抽取式摘要用**未截断**的原文定位命中词（命中点可能落在 `perSourceChars` 之外）。
- **检索一律走 `mode: 'terms'`**：`search.search(query, { limit, mode: 'terms' })`（工作树状态，见 §9.3 的修复状态说明）。本插件的入口是**自然语言问句**，按整串短语检索会恒为 0 命中；词元切分复用 `@geewiki/search` 的单一实现（`buildTermQuery`），本插件**不重复实现分词**。
- 正文一律经 `search-service.contents()` 取，**不直连 wiki 的 `pages` 表**——否则 wiki 的表结构会变成跨包隐式契约。

**唯一接线点**：`generate()`（`packages/plugin-ai/src/index.ts:261`）是本阶段**唯一有意未接线**的函数——没有厂商 adapter 时 `availableProviders()` 为空，它必然走降级分支。将来 adapter 批次只需在这一个函数里补齐"按需中断/超时、token 计量口径、SSE 增量外发"三件事，其余代码无需改动；prompt 拼装已拆成纯函数（`prompt.ts` 的 `buildContext` / `buildMessages` / `SYSTEM_PROMPT`）并有单测。

**服务契约** `AiService`（`ctx.get('ai-service')`）：`ask(q, opts?)` 与 `capabilities()`，两者都是**端点正在使用的那份实现**（端点只做 HTTP 层），故 REST 与服务的输出逐字段一致。服务层的语义边界与端点有别：空查询/超长**不在服务层拦**（那是 HTTP 语义），直接的空白查询会照常走完检索并返回 200 + 空结果；`opts.limit` 非法时抛错；**卸载后再调用显式抛错**，绝不返回空结果（口径同 `search-service`）。

### 9.6 前端接入（**宿主原生 UI，不改 Slot 机制**）

检索与问答界面是**宿主原生 UI**，走 hash 子路由 `#/wiki/search/<q>` 与 `#/wiki/ask/<q>`（可分享、刷新不丢）。**Slot 机制一行未改**——`packages/web/src/lib/slots.tsx` 在本阶段零改动，"宿主不向插件传数据"的冻结裁决保持。

- **插件未启用时静默降级**：入口探测用两路——`GET /api/plugins`（恒可用）判插件是否 `active`，这是权威判据、**不产生 404**；`GET /api/ai/capabilities`（按契约要求调用）拿"模型是否就绪"的说明，插件未启用时它会 404，前端**静默降级**（只 `console.debug`，**绝不产生 console error**）。插件未启用时搜索框 disabled + 给出提示。
- **降级提示条是信息性的**，不是错误样式：`no_provider` / `missing_credential` → `level: 'info'`，文案"未配置模型密钥，以下为检索结果与摘要"（`packages/web/src/lib/searchPlan.ts:77-86`）；未知 `reason` 回退到通用文案并带上 `message`，**绝不 throw**（降级提示本身不该成为新的故障点）。

### 9.7 本层已知边界（不做，且都有理由）

| 边界 | 状态 | 理由 / 后续方案 |
| --- | --- | --- |
| **无任何厂商 LLM adapter** | 现状 | `llm-service` 无可用 provider，问答**恒走 `retrieval-only`**；`rag` / `rag-partial` 两条路径目前**仅有"假 provider"的单测覆盖**，无真实模型链路验证 |
| **流式（SSE）未做** | **有意不做** | 长连接在途期间会被**永久计入在途计数**，会让卸载/关停时的优雅排空（`drain`）空转满 `drainTimeout` 并打印**假的排空超时告警**。因此 SSE 出口**必须与排空语义一起设计**；方案已定：流式响应登记为"不阻塞排空" + 硬超时 / idle 超时 + `res.on('close')` 即取消上游。本阶段检索与问答均为一次成型返回 |
| **向量 / 语义检索未做** | 有意后置 | 离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时）；只留接口位。当前检索是**纯字面**匹配，故同义改写、跨语言、模糊表述都搜不到 |
| **`search` / `ask` 是保留 slug** | 现状 | 二者成为 wiki 下的**保留首段 slug**，不能再创建同名页面（判据见 `packages/web/src/pages/WikiPage.tsx:37` 的 `allowedSecond`） |
| **密钥** | 边界 | 配置里只存**环境变量名**，**环境变量本身**由运维在外部设置；`GET /api/plugins/:name/config` 对**普通配置字段**仍**明文返回**（见 5.7），而 `apiKeyEnv` 只是变量名故不构成泄漏 |
| **`redact` 是启发式** | 现状 | 未覆盖的密钥形态不会被脱敏；`text-delta`（模型输出）**刻意不脱敏** |

## 10. 参考与对比

- **PandaWiki**：借鉴其 Wiki 功能边界，摒弃重架构（Redis、多服务拆解）。
- **Cordis 生态**：学习插件间 `ctx` 的隔离与通信模式。
- **VS Code / Obsidian**：借鉴插件沙箱与禁用/启用交互范式（对应本系统的会话层沙箱与显式授权热插拔）。
