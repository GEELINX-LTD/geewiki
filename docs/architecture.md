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
React 19 前端（宿主侧 Slot：`app-header` / `app-footer` 零属性插槽 + 后端声明的 `editor` 数据插槽，详见第 6 章 / 依赖图可视化）
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
        ＋ @geewiki/llm（契约层：route→provider 注册表 + 统一「模型接入」配置 + 降级/脱敏词汇的唯一真源）
        ＋ @geewiki/openai（厂商 adapter：只向 llm-service 注册一条 OpenAI 兼容路由，**无 provides**，默认启用）
        ＋ @geewiki/ai-qa（检索增强问答：requires http-service / search-service / llm-service；没有可用模型 = 503 显式不可用）
        ＋ @geewiki/ai-writing（编辑器辅助写作：requires http-service / llm-service / policy-service；纯生成、不检索）
```

> **修正（本批）**：这块 ASCII 原先画的是 `@geewiki/search → @geewiki/ai（检索增强问答，无 key 时降级 retrieval-only）→ @geewiki/llm（契约层：route→provider 注册表，**本阶段尚无厂商 adapter**）`，两条口径同时失效：① `@geewiki/ai` 已一分为二——`@geewiki/ai-qa`（问答）与 `@geewiki/ai-writing`（辅助写作），`retrieval-only` 连同 `extract.ts` 一起删除，**问答不再"没有 key 也出答案"**（这是刻意的产品裁决，见 §9.5）；② "尚无厂商 adapter"更早的批次就已过时——`@geewiki/openai`（`packages/plugin-openai/`，manifest 见 `packages/plugin-openai/src/index.ts:50-69`）存在、登记进 `defaultRegistry()`（`packages/server/src/index.ts:1473`），并与 `@geewiki/llm` 一起写在 `config/plugins.base.json` 里默认启用。依赖形态也从"问答直连 llm"变成"两个插件都按**服务 token** requires"（`packages/plugin-ai-qa/src/index.ts:167`、`packages/plugin-ai-writing/src/index.ts:84`——`ai-qa` 不列 `database-provider`，正文只经 `search-service` 取；`ai-assist` 列 `policy-service`，编辑权判定必须问策略层）。拆分契约见 [design/ai-plugin-split.md](design/ai-plugin-split.md)。

各层职责（对应上图中原稿的完整描述）：

1. **React 19 前端**：管理界面与 Wiki 界面。宿主侧 Slot 插槽机制——插件 UI bundle 加载后把组件注册进宿主的插槽（`app-header` / `app-footer` 是**零属性**插槽；后端另有 `ctx.slot` 链路与一个具名的 `editor` 数据插槽，见第 6 章）；以 React Flow 渲染依赖图可视化。前端通过 **REST API（HTTP）**与 Plugin Manager 通信——**当前没有 WebSocket / 推送通道**，界面数据靠请求-响应获取。
2. **Plugin Manager（核心大脑）**：位于服务抽象层（DI，由 Cordis 提供）之上，包含热加载引擎、依赖图/冲突组管理、会话层沙箱机制、迁移控制器、看门狗探针与配置热管理中心。详见第 5 章。
3. **插件生态**：全部业务能力以插件形式存在。**按冲突组划分**的是真正互斥的同类实现，例如数据库组（SQLite / PG）、编辑器组（Milkdown / TipTap）；而**检索（`@geewiki/search`）、问答（`@geewiki/ai`）、LLM 契约层（`@geewiki/llm`）三类插件刻意不进任何冲突组**——它们提供的是可被多方复用的服务，互斥应留给各厂商 adapter 自己声明（详见第 9 节）。
   > **修正（本批）：清单变成五条，且"互斥留给各厂商 adapter 自己声明"这半句已作废。** 拆分后的实际清单是**五个插件的 manifest 都写 `conflictGroup: undefined`**：`@geewiki/search`（`packages/plugin-search/src/index.ts:67`）、`@geewiki/llm`（`packages/plugin-llm/src/index.ts:218`）、`@geewiki/openai`（`packages/plugin-openai/src/index.ts:60`）、`@geewiki/ai-qa`（`packages/plugin-ai-qa/src/index.ts:168`）、`@geewiki/ai-writing`（`packages/plugin-ai-writing/src/index.ts:85`）。原句里"问答（`@geewiki/ai`）"这一条现在是两条（`ai-qa` / `ai-assist`——写作与问答是两个功能，同时启用完全正常）。作废的那半句：`@geewiki/openai` 原先**确实**声明过 `conflictGroup: 'llm-provider'`，本批撤掉了——多个适配器现在是「模型接入」`provider` 字段**单选**的并列服务商，同时启用是正常需求（多家共存、各自注册一条路由）而不是冲突，"两家抢同一个注册表键"这个互斥前提已不成立（理由见 `packages/plugin-openai/src/index.ts:13` 与 `packages/server/src/index.ts:1466-1472`）。**同批被推翻的还有"问答恒走 retrieval-only"**：见 §9.4 / §9.5 的修正。

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

#### 5.1.1 长连接（SSE）出口与优雅排空的共存（提交 `2273006`）

**结论先说**：长连接**不计入排空**，且**不能**用 `json()` 去"记一次指标"。这两条都是刻意的，各自有实测依据。

**（a）长连接为什么不占在途——机理（`packages/server/src/index.ts:358-371`）**

`dispatch` 只在 `isThenable(result)` 为真时才把 `exitHandler` 挂到 Promise 结算上：

```ts
const result: unknown = route.handler(h)
if (isThenable(result)) { void Promise.resolve(result).then(() => this.exitHandler(state), …) }
else { this.exitHandler(state) }
```

因此 **SSE 处理器只要同步返回非 thenable，就会在同一 tick 内结算**，在途计数立刻归零；而连接的存活状态由**提供方自己持有**（处理器已把 `res` 交给某个长生命周期对象持续写帧）。这就是"长连接不阻塞排空"的全部秘密——不需要任何特判计数逻辑。

反过来说醒：**若把长连接算进在途**，卸载插件时 `drain()` 会一直等到连接关闭，必然空转满 `drainTimeout` 并打印**假的**"排空超时"告警。本仓曾在 REST 卸载路径上因同类归因错误稳定误报（对应回归用例在 `packages/server/test/router.test.ts`）。

**（b）`noteStatus` 为什么必须存在——一条被实测证伪的设计设想（务必记档，后人最易重犯）**

原设计设想：长连接出口"先 `res.writeHead(200, { 'content-type': 'text/event-stream' })` 再 `h.json(200, null)`，这样就恰好记了一次指标、又不结束响应"。**该设想已被实测证伪。**

实测事实：

- `writeHead` 之后，`res.headersSent` **立即为 `true`**，而 `res.writableEnded` **仍为 `false`**——所以 `json()` 开头那道 `if (res.writableEnded || res.destroyed) return` 的 write-after-end 防护**拦不住**这种情况。
- `json()` 内的 `writeHead` 是**有条件**的（`if (!res.headersSent) res.writeHead(...)`，`packages/server/src/index.ts:298-300`），但紧随其后的 **`res.end(JSON.stringify(body))` 是无条件的**（`:301-306`）。
- 合起来：会往 SSE 流里**追加字面 `null` 并立即终结流**。实测客户端读到的正文为：

  ```
  event: status
  data: {"type":"status"}

  null
  ```

因此**必须**另开一条"只记指标、绝不碰响应"的通路，即 `RouteHandlerContext.noteStatus?(status)`（`packages/core/src/index.ts:299`）。它与 `json()` **共用同一记账点**（`packages/server/src/index.ts:272-292`）——`settledStats` 幂等守卫保证**每个请求只记一次**：长连接先 `noteStatus(200)` 记状态码、随后（如异常收尾路径）仍可能经 `json()` 再走一次，重复记账会让 `stats()` 总数虚高、看门狗连续失败计数被放大。

长连接出口的正确姿势：**确定状态码时调用 `noteStatus()` 记一次指标 → 自行持续写帧 → 自行 `res.end()` 收尾。**

**（c）`trackStream` / `closeStreams`**

- `HttpRouterService.trackStream?(res)`（`packages/core/src/index.ts:375`）登记长连接，返回**幂等**注销函数（`packages/server/src/index.ts:170-178` 用 `released` 布尔守卫）。登记的**唯一价值**是让路由服务在**自身卸载/关停**时能主动结束这些连接——否则客户端会一直挂着等一个再也不会来的字节。持有者若要按自己的生命周期收流，调用返回的注销函数即可。
- **该集合不参与排空计数**（`packages/server/src/index.ts:128` 的 `private readonly activeStreams = new Set<ServerResponse>()`，注释 `:121-127` 明写"**刻意不计入 `inFlight`**"）。
- **⚠️ `closeStreams()` 不在 `HttpRouterService` 接口上**——它是 `HttpRouter` **具体类**的方法（`packages/server/src/index.ts:186`，接口见 `packages/core/src/index.ts:340`）。也就是说：**其他包经 `ctx.get('http')`（静态类型为 `HttpRouterService`）拿到的服务上没有这个方法**，它是路由服务自身的**实现细节**，只由 `HttpPlugin.apply` 的 teardown 在自己的闭包里调用（那里持有的是具体类实例）。实现为逐个 `res.end()` 并 `try/catch`（`console.warn('[@geewiki/http] 结束长连接失败:', err)`），单个连接异常不得阻断其它连接的收尾；最后 `clear()`。
- 与之对照，两个新成员里 `noteStatus` 与 `trackStream` 都做成**接口上的可选成员**（`?`）以保持向后兼容——既有 4 处测试替身无需改动。

**（d）`HttpPlugin.apply` 的 teardown 现为五步（`packages/server/src/index.ts:627-654`）**

```
unprovide()                      // ① 先摘掉服务，后续 get('http') 拿不到
→ closeStreams()                 // ② 主动结束全部活跃长连接（它们不计入排空，drain 不会等）
→ await drain(drainTimeout×1000) // ③ 优雅排空在途 API 请求；长连接不占在途，故应立即返回
→ server.closeIdleConnections?.()// ④ 只关空闲 keep-alive、保留在途（Node 22 有）
→ server.close()                 // ⑤ 关闭监听
```

第 ④ 步**刻意不用 `closeAllConnections()`**：那会连测试里 undici 连接池的复用连接一并掐断，代价大于收益。第 ③ 步的**告警文案与语义一字未改**（超时仍打印 `[@geewiki/http] 排空超时（Nms，仍有 M 个请求在途），强制关闭监听`）。

**（e）测试证据（`packages/server/test/sse-drain.test.ts`，6 例）**

- 核心断言走的是**真实生产卸载路径**（REST `/disable` → `manager.disable()` → `deactivateCore` → `unloadPlugin` → `drainBeforeUnload` 生产排空代码 → `fiber.dispose()`），长连接由持有者插件自己的 `dispose` 收掉；其中一例覆盖 `HttpPlugin.apply` 的真实 teardown（经 `startServer().dispose()`）。
- 一例是**负对照**：处理器返回**永不 resolve 的 thenable** → 排空确实等待、超时并打印告警——证明主用例（长连接不空转）**有判别力**，而不是"恰好没触发"。
- 一例回归 `json()` 终结流的坑：`noteStatus` 恰好记一次指标，且**响应体不得出现字面 `null`**。
- 一例覆盖 `trackStream` 注销的**幂等性**（重复调用不抛错、集合不残留）。
- **两处变异取证**：① 在 `trackStream` 里加 `inFlight++`（把长连接算进在途）→ 用例红，报"长连接不得阻塞排空（实际 5004ms）"——正是本特性要消灭的假超时；② teardown 去掉 `closeStreams` → 用例红。两处变异均已还原。
- **`packages/server/test/router.test.ts` 的 11 条一字未改**（`git diff --stat 2273006^ HEAD -- packages/server/test/router.test.ts` 为空）。

> **修正（本批）**：本节写就时"地基已铺、尚未接线"是实情；现在**已有真实流式输出**——`@geewiki/ai-qa` 的 `POST /api/ai/stream`（`packages/plugin-ai-qa/src/index.ts:931`）逐帧写 `status` / `delta` / `done` / `error`，超时与取消在插件内自管（`packages/plugin-ai-qa/src/sse.ts:30` / `:38` / `:46`：硬超时 120s / idle 30s / 并发 4）。**本节描述的宿主级出口机制未变**（登记/记账/主动收流/排空共存），变的只是"终于有了消费者"。契约细节见 §9.5。

### 5.2 依赖图谱与约束系统

- 后端维护插件依赖数据并提供查询 API；前端使用 **React Flow** 将依赖图渲染为 DAG。
- **加载时**：自动递归加载所有未激活的依赖项。
- **卸载时**：计算下游依赖者（反向依赖）；若存在依赖者，则阻止卸载并给出**专门说明块**（`409 has_dependents`）。管理台不再只显示泛化错误：`packages/web/src/pages/AdminPage.tsx:423-455` 的 `.dependents-block` 列出依赖方名单（来自响应 `details.dependents`；形状不符时退化为"后端未返回名单"的兜底文案），并给两段**可操作指引**——① 先在上表逐个停用依赖方，再回来停用目标；② 若目标是被同冲突组的其它插件顶替，可在目标插件那行点「启用」走**冲突组替换**（会连同依赖方一起安全接管）。**刻意不实现自动级联停用**（破坏性操作，不属本批）。
- **节点颜色区分热能力**：绿色 = 支持热加载；红色 = 需重启。

### 5.3 会话层沙箱机制（防崩溃安全阀）

- **双层状态存储**：
  - *基础层（Base Layer）*：持久化于磁盘，保存系统稳定运行的插件清单（对应部署中的 `plugins.base.json`）；
  - *会话层（Session Layer）*：保存在内存/临时文件中，记录管理员在会话中的临时调整（对应 `plugins.session.json`）。
- **临时操作仅修改会话层**，即时生效，用于测试新插件或新组合。
- **自愈恢复**：临时插件导致崩溃/卡死时，只需重启容器——系统忽略会话层、自动回滚至基础层状态；仅当管理员点击**"应用并持久化"**，会话层变动才会被合并进基础层。
- **真·临时停用（本批新增）**：此前 `disable()` 对**基础层**插件直接 409 `base_layer`（"冷操作，请改清单后重启"），
  于是 5.3 的"临时"只有**启用**一个方向——界面上那句"先临时停用或改清单"是一句做不到的提示。现在补上另一半：
  - 机制：基础层插件被停用时**只登记在内存**（`GeeWikiManager` 的私有 `runtimeDisabled: Set<string>`），
    **不写任何清单文件** ⇒ **正常重启后照基础清单恢复运行**（这正是用户口径"立即停止，若没有另行持久化，重启后仍启用"）；
  - 与会话层停用的区别（两者运行态都是 `inactive`，命运不同）：会话层插件停用 = 从会话清单移除条目，
    重启后同样不会加载（它本来就不在基础清单里）；基础层插件停用 = 条目仍在基础清单里，重启即回来；
  - 三条不变量（缺一条这个功能就变成"静默改配置"）：**不落盘**；**激活即清登记**（清除点放在 `activateCore` 成功处，
    boot / enable / 递归拉依赖 / 冲突组替换全部自动覆盖，不会留下"既在跑又被标记停用"）；**持久化即删除**——
    `persistSession()` 把条目从基础清单**移除之后**才清空登记（顺序反了会在写盘失败时留下"标记没了、清单也没改"的假持久化）；
  - 依赖方守卫对两种层一视同仁且**先于卸载**执行（有活跃依赖方 → 409 `has_dependents`，拒绝时插件必须还在跑）；
  - 重新启用被临时停用过的插件走**恢复**路径：按 `base` 层激活且**不写会话条目**（否则会得到"基础层 + 会话层同名条目"的叠加态，
    并把层降级成 session，界面会说反话：显示"临时启用"）；
  - **恢复路径同时豁免两条热插拔守卫**（`hot_reload_not_supported` / `hot_dependency_not_supported`）：
    守卫要防的是"把从未在本进程跑过的冷插件热装上来"，而恢复是"回到本进程本来就有的状态"。
    不豁免就会形成**单向陷阱**——`@geewiki/org` 这类冷插件（基础层里另有 `auth`/`db-sqlite`/`http`）往往没有活跃依赖方，
    于是能被临时停用、却启不回来（实测 409 `hot_reload_not_supported`），只能靠重启。守卫对真正的新启用仍然生效（单测有反例钉住）；
  - **界面口径**：「临时变更」卡片的空态、标题项数（"临时变更（N 项）"）与「应用并持久化」的可用性都必须把
    **两种**临时变更算上（只判会话层时，纯临时停用态会显示"当前没有临时变更"、且持久化按钮是灰的——用户实测报过前者）；
    停用成功的提示按层分流（基础层**不能说**"已保存"，它什么都没写盘）；
  - 证据：语义由 `packages/manager/test/runtime-disable.test.ts`（7 例）钉住；**真实进程 + 真实注册表 + 真重启**由
    `scripts/acceptance/plugin-runtime-disable/run.ts` 验收（11/11，含"两个清单文件逐字节未变"这条最硬的证据）。
    ⚠️ 该验收脚本第一版曾**假绿**：`spawn('pnpm', …)` 的 `pnpm` 只是包装，`kill(pnpm)` 杀不掉真正监听端口的孙进程，
    于是"重启"变成"同一进程继续服务"（重启后仍报 `runtimeDisabled=true`，看起来像后端不落盘失效）。修法是
    `detached: true` + `process.kill(-pid)` 杀整个进程组，并在停服后**反空洞确认端口真的不再响应**。

### 5.3b 前端：插件管理与依赖图**已合二为一**

本批把「插件管理」与「依赖图」两个页面合并为一页（`packages/web/src/pages/GraphPage.tsx`）：**图即管理台**，
点任一节点弹出详情/配置弹窗（拉平了原先大表格里的"行 + 展开的配置区"）。三件事一起落地：

- **重复连线不再画（传递归约）**：某个直接依赖若已由另一个直接依赖（更上游）传递带来，`C→X` 这根线就不再画——
  判据是"绕开这条边本身，端点还能由长度 ≥2 的路径到达吗"。真实注册表：**47 → 33 条线**，**可见交叉 77 → 16**
  （被删的正是横穿全图的长线，它们本就是交叉的主要来源）。四条边界：只影响**画线**（详情弹窗仍列全部直接依赖）；
  路径长度 ≥2（否则平行边会互相判成冗余而全消失）；含环安全；删掉的是**当前**的重复线——上游被停用后直达线自己回来。
- **线不再交织**：分层只解决"被依赖方在左"，**层内顺序**才是交叉的来源（原先沿用注册表顺序）。
  布局改走 `packages/web/src/lib/pluginGraphPlan.ts` 的**重心法 + 贪心相邻交换**：目标函数是**可见交叉对数**
  （横向区间不重叠的边对不计——用"全部对"当目标会去优化肉眼看不见的交叉，本批先踩了这个坑）。
  真实注册表（26 节点 / 47 边 / 4 列）实测：注册表顺序 **151 对可见交叉** → 重心法 105 → 加重心法后的贪心交换 **77**；
  再叠加传递归约（画线 47 → 33 条）后为 **16**。单独用贪心交换（不先跑重心法）是 80，两步互补。
- **悬停高亮一整条依赖链，只向前、不向后**：`upstreamClosure` 只沿"我依赖谁"的方向（图上向左）传递，
  **下游（依赖它的插件）一律不亮**——那是"停用它会影响谁"，属于另一个问题；链外节点与边降到 40% 不透明度。
- **五态两种新色**：运行中（绿）/ **临时启用（青，`--color-session`）** / **临时停用（紫，`--color-suspended`）** /
  异常（琥珀）/ 未启用（灰）。两种"临时"的差别是**重启后还在不在**，故图例与节点提示都按此措辞
  （`TONE_TEXT` / `TONE_HINT`，`packages/web/src/lib/pluginDisplay.ts`）。

**★ 悬停高亮的一次返工（同批，值得记档）**：首版实现是"压暗链外、链内保持原样"，用户实测反馈**"高亮没有用，
且在节点内移动鼠标会不断闪烁"**。两个症状同源：节点标签上挂的原生 `title` tooltip 弹出在光标附近会抢走 `mouseout`，
于是悬停态丢失 ⇒ tooltip 收起 ⇒ 再次弹出，自激成闪烁，高亮一并丢失。**headless 量不到**——它不渲染原生 tooltip，
那套 CDP 判据一路全绿而真人一用就坏 ⇒ 这类"只在真实渲染里成立"的缺陷必须靠**源码守卫**钉（
`packages/web/test/pluginGraphHover.test.ts`：节点内不得出现 `title=` 等 6 条）。修法是三件事：去掉原生 title
（包名全称改由悬停提示面板 + 详情弹窗承载）、**把高亮从"压暗别人"改成正强调**（链内加 `ring-2 ring-accent/70` 与抬投影、
链上边加粗上色）、去掉 26 个节点同时过渡的动画并给离开加 80ms 防抖。另有一处"看起来像坏了"的边界：上游为空的节点
（如 `db-sqlite`）悬停后链里只有它自己，面板现在明说"不依赖任何插件——它是依赖链的起点"。

> 历史引用说明：本文档（及 `docs/plugin-platform-plan.md`）里凡引用 `packages/web/src/pages/AdminPage.tsx`
> 的**行号与结构**，都是**合并前**的记录；该文件已 `git mv` 为 `pages/GraphPage.tsx`（画布抽到
> `components/PluginGraph.tsx`），行号不再对应。老链接 `#/plugins` 在路由解析处改写成 `#/graph`，书签仍可用。

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

> **修正（本批，2026-09-15 · AI 插件化重构 P8）**：本节下文凡提 `wiki-ask` 的地方均已过时。
> **白名单现为 6 个**（P8 前是 7 个）：`app-header` / `app-footer` / `editor` / `editor-toolbar` /
> `app-dock` / `article-summary`（真源 `packages/core/src/index.ts` 的 `SlotName` /
> `SLOT_NAMES` / `SLOT_CARDINALITY`，浏览器侧镜像 `packages/web/src/lib/slots.tsx`，
> 第三份镜像 `packages/web/src/lib/pluginUiPlan.ts`）。
> **`wiki-ask` 与 `#/wiki/ask/<q>` 路由一起拆除了**（决策 17：AI 对话的唯一入口是常驻的
> `app-dock`；同一个功能有两条界面路径时两条都会漂移）。**`@geewiki/ai-qa` 随之整包删除**
> （决策 22：拆掉那个插槽后它的 `ui/`、`ai-qa-service`、两个端点全部无家可归，
> 而能力已被 `ai-kb` / `ai-assistant` / `ai-summary` 接走）。
> `WIKI_RESERVED_FIRST_SEGMENTS` 里的 **`'ask'` 刻意保留**——解禁是单向不可回收的
> （既有的 `#/wiki/ask` 分享链接会**静默**变成一个页面）。实测读数、拆除面与两处连带修复见
> [design/ai-plugin-architecture.md](./design/ai-plugin-architecture.md) §7.1 / §8.12。

**当前实现形态是"仅宿主侧插槽"**：插件的 UI bundle 由浏览器加载后，把组件**注册进宿主预设的插槽**；宿主不向插件暴露任何后端注册 API。**哪些插件的 UI 该加载由后端下发**（`GET /api/plugins/ui`，见下），加载与撤销则**跟随插件生命周期自动同步**（管理台动作即时、外部变更 ≤15s 收敛）。

- **宿主 SDK**：`@geewiki/web` 在 `window.__GEEWIKI_HOST__` 上暴露 React 单例与插槽 API（`packages/web/src/lib/hostSdk.ts`，**`HOST_SDK_VERSION = '0.2.0'`**）：`{ React, jsxRuntime: { jsx, jsxs, Fragment }, registerSlot(name, component), unregisterSlot(name, token?), renderMarkdown(md): string, version, pluginName }`。**`renderMarkdown` 是本批（AI 界面插件化）新增的**：问答要把模型输出的 Markdown 渲染成 HTML，而全仓只该有一份 marked + DOMPURify 实现 —— 插件自带一份等于把净化器变成"每人一份、各自漂移"，那正是 XSS 面上的经典退化路径。插件侧**必须特性探测**（`typeof host.renderMarkdown === 'function'`，缺席就退回纯文本渲染），**不要按 version 字符串比大小**（`hostSdk.ts:18-19` 明写这条；比大小会把"未来版本"判成"不支持"）。初始化必须是宿主入口的**第一个导入**（`packages/web/src/main.tsx:1-3`），因为 import map 指向的 shim 在模块求值期就要读这个全局。
- **React 单例共享（D-8）**：`packages/web/index.html` 的 `<script type="importmap">` 必须位于 head 首位，把裸标识符 `react` 映射到 `/host-sdk/react.js`、`react/jsx-runtime` 映射到 `/host-sdk/jsx-runtime.js`——两者是从 `window.__GEEWIKI_HOST__` 取宿主实例再 re-export 的**薄 shim**（`packages/web/public/host-sdk/`）。插件 bundle 以 external 形式构建，因此与宿主共用同一个 React 实例，不会出现双实例 `Invalid hook call`。**刻意不映射 `react-dom` / `react-dom/client`**——插件不得自带框架。注意这与"用 import map 分发宿主产物"的方案不同：此处 import map 只做**标识符到 shim 的转接**，react 实例仍由宿主 bundle 持有（D-4 / D-8 / S-19）。
- **插槽名是白名单（两处镜像，后端为权威）**：后端 `packages/core/src/index.ts:797` 的 `export type SlotName` / `:800` 的 `export const SLOT_NAMES` 是**权威**；前端 `packages/web/src/lib/slots.tsx:49` / `:52` 里是**手抄镜像**（web 不能 import core：core 顶层 `import 'node:fs'`，进浏览器会炸）。现有 **5 个**：`app-header` / `app-footer`（零属性）/ `editor`（带数据、单占用）/ **`editor-toolbar`**（多占用，本批新增）/ **`wiki-ask`**（单占用，本批新增）。**镜像由两处守卫钉住**：`packages/manager/test/slots.test.ts` 比对 core ↔ web，`packages/web/test/slotPropsMirror.test.ts` 比对 core / `slots.tsx` / `pluginUiPlan.ts` **三处逐元素相等（含顺序）**并校验 `SLOT_CARDINALITY` 的键与 `SLOT_NAMES` 相等（源码级比对，照本仓既有先例）。该守卫经历过一次**真实的收敛过程**，值得记录：后端先加了具名数据插槽 `editor`，而前端批次尚未跟上，中间状态由源码里的显式记账常量 `PENDING_WEB_SYNC` 钉住（**该清单只允许变短**——web 一旦补上，守卫会因"清单里还有它"而变红并提示移除）；前端补上后守卫转而要求**清空该清单**，从而**不允许"已同步"的陈述长期滞留**。这正是守卫存在的意义：两个方向都受检，且不允许退化成"两边都空"的空洞相等。未在名单内的名字只打印 `[geewiki-slot] 未知插槽名 "…"，已忽略（可用：…）` 并忽略，不抛错。
- **渲染与容错**：`SlotOutlet({ name })` 用 `useSyncExternalStore` 订阅插槽注册表，外层包 `SlotErrorBoundary`（`packages/web/src/lib/slots.tsx:102`）——插件组件渲染抛错时只丢弃该插槽的内容、保留兜底 UI，**主界面不白屏**。`registerSlot(name, component, source = 'host')` 返回**幂等的撤销函数**。
- **插件 UI 的加载**：加载器在 `packages/web/src/lib/pluginUi.ts`，不接触 DOM 的纯逻辑部分在 `packages/web/src/lib/pluginUiPlan.ts`（顶层不写 `window`，故可直接用 `node --test` 单测）。**入口表由后端下发**：`GET /api/plugins/ui` → `{ ok, version: 1, revision, plugins: { "<name>": { entry, css?, rev } }, skipped }`，其中 `plugins` **只含**"当前已激活 ∩ 声明了 `geewiki.client` ∩ 入口产物确实存在（只 stat 不读内容）"的插件，`skipped` 逐条记未入表原因（`inactive` / `no_client` / `entry_missing` / `invalid_name`）。前端带 `If-None-Match: "<revision>"`，命中 **304 即零动作**（不触碰已加载 UI）；响应不可信时（请求抛错 / 非 2xx / JSON 解析失败 / 格式不符契约）**既不加载也不卸载**，只 `console.debug`——避免网络抖动清空已加载的界面。`planUiSync(entries, loaded)` 算出"该装载 / 该卸载"的差集：表中新增 → load，已加载但表中消失 → unload，`rev` 变化 → **先卸后装**（产物换了必须重跑 `register`），两个数组均按插件名排序以保证确定性。装载即 `await import(pluginUiBase(name) + '/' + entry)`（**同源绝对 URL，不带任何 query**），要求模块导出 `register(host)`（或 default），收集其返回的清理函数；卸载时执行 disposers、移除 `<link data-plugin-ui=…>`，并以 `epoch` 使在途 import 作废（防"卸载后又被在途 import 复活"）。插件 CSS 由宿主**集中注入** `<link data-plugin-ui=…>`（lib 模式不会自动注入样式，集中注入可避免重复与卸载残留）。`pluginUiBase(name)` 先做路径段校验（1 段非 scope 名，或 2 段且首段为 `@` 开头的 scope 名；段内拒绝 `.` / `..` / 分隔符 / 空白与控制字符）再映射为 `/plugins-ui/<name>`；非法名返回 `undefined` 而不抛错。
- **入口表为什么由后端下发、而不是"拼约定 URL + 试探"**（`packages/web/src/lib/pluginUi.ts:22-26` 记录的三条实测结论）：① dev 下非绝对 URL 的动态 import 会被 Vite 追加 `?import` 并返回 **500**；② dev 下缺失入口返回 **200 + text/html**，浏览器报 MIME 错（`Failed to load module script … MIME type of text/html`，JS 捕获不掉）；③ prod 下缺失入口直接 **404**，而 Chrome 把任何 404 记为控制台 `log:error`。故"先探测再 import"必然产生噪声或误判。现在"产物缺失"由后端归入 `skipped: entry_missing`，前端根本不会去 import 那些插件——三种噪声**结构性消失**。表本身也不再是构建生成物（旧形态 `/plugins-ui/registry.json` **已停用**），而是由活状态（注册表 × 激活集合 × 产物 stat）**每请求现算**（`GeeWikiManager.uiTable()` → `buildPluginUiTable`），因此"装了插件就有 UI、停用就消失"不需要任何重新构建、也不需要重新生成任何 JSON。
- **两条已实测证伪的做法（排障时最容易误判的点，`packages/web/src/lib/pluginUiPlan.ts:17-26`）**：① **不要给 bundle URL 加 `?v=<rev>` 之类的 cache-busting query**——给**根相对** URL 加 query 在 dev 下会触发 Vite 的 `injectQuery` 改写（`?import&v=…`）→ **必然 500**（`This file is in /public…`）；即便改用同源绝对 URL 绕开改写，`rev` 一变就产生**新模块实例**，而 `registerSlot` 是 append、已加载集合只按插件名去重 → **插槽条目翻倍**（实测 widget 2→4），且 ESM 无法从模块图卸载。故 `rev` **只用于变更检测、不进 URL**。② **`/* @vite-ignore */` 并不能阻止 Vite 改写动态 import**——dev 之所以没踩坑，是因为 `pluginUiBase()` 返回的是**同源绝对 URL**（首字符 `h`），而 `injectQuery` 只对以 `.` / `/` 开头的 URL 追加参数；这个"同源绝对 URL"的形态是**硬要求**，不要改成相对路径。
- **生命周期自动同步**：`startPluginUiSync({ intervalMs = 15000 })`（`packages/web/src/main.tsx:21` 调用）先**立即同步一次**，再挂 `visibilitychange`（变可见时同步）与**可见期低频轮询**（`document.hidden` 为真时跳过；`If-None-Match` 让空闲期几乎零成本），返回幂等的停止函数；`syncPluginUi()` 本身**幂等 + 单飞**（在途请求复用同一个 Promise）。集成点是管理台 `AdminPage` 的 `load()`（`packages/web/src/pages/AdminPage.tsx:83`）——它是四条变更成功路径（act / confirmEnable / doReplace / saveConfig）的汇聚点，故**只挂这一处**即可让插槽跟随启停，`revision` 未变时同步是纯 no-op。轮询存在的理由：**外部变更不经过前端**（看门狗试用期回滚会在后端异步 `disable()`、CLI 直接改清单、其它标签页同理），只靠"动作后刷新"会让界面长期与后端不一致；因此**外部变更的 UI 收敛延迟上界是一次轮询间隔（默认 ≤15s）**，而管理台自身动作路径为**即时**。
- **304 短路的一个真问题与修法**：`revision` 只是**表格内容**的哈希，"启用 → 停用 → 再启用"会回到**同一个**值；若此前某次加载失败，304 会让宿主**永久**漏加载那个插件（表内容一样、短路一直命中，界面永远起不来）。修法是 `isUiSettled(entries, loaded, failed)` 判定"界面是否已收敛到最近一次看到的入口表"：**未收敛时不带 `If-None-Match`**（强制取一次完整表重新对齐），并以 `rev` 为键**记忆加载失败**、把"已按同一 rev 失败过"视为已收敛——避免 15s 轮询对同一个坏产物反复 import 与重复告警，`rev` 变化后自然重新尝试。
- **第二个 304 短路真问题：`revision` 不含 `skipped`（提交 `3bdcf4b` 修）**。`buildPluginUiTable` 的哈希输入**只有 `{version, plugins}`**（`packages/manager/src/plugin-ui.ts:255` 的 `createHash('sha1').update(JSON.stringify({ version: 1, plugins })).digest('hex').slice(0, 12)`，注释 `:221` 明写 `skipped` 不参与），因此"**未启用 / 无前端界面**的插件集合"发生变化时（例如新装了一个未启用的插件、或某插件从未启用变为无界面），`revision` **纹丝不动** ⇒ 客户端带着同一个 `If-None-Match` 请求，后端照旧回 **304** ⇒ 管理台**永远看不到**这类变化。这与上一条不同：上一条是"已加载集合与 revision 脱钩"，本条是"**展示字段根本不在指纹里**"。修法是给 `syncPluginUi` 加 **`force`** 参数（`packages/web/src/lib/pluginUi.ts:305-307` 的 `PluginUiSyncRequest.force`）：`useEtag = !force && lastRevision !== undefined && isSettled()`（`:333`），命中 304 直接 `return`（`:344`）；**管理台 `load()` 走 `syncPluginUi({ force: true })`**（`packages/web/src/pages/AdminPage.tsx:109`，不使用 `If-None-Match`），而 **`startPluginUiSync` 的 15s 可见期轮询仍走 304 短路**（`packages/web/src/lib/pluginUi.ts:400/404/412` 调无参 `syncPluginUi()`）——既保证展示字段的新鲜度，又不牺牲空闲期的零成本。
- **`skipped` 的前端呈现按严重度分级（提交 `3bdcf4b`）**：`classifyUiSkips(skipped)`（`packages/web/src/lib/pluginUiPlan.ts:226`，纯函数）把跳过项分为 `attention`（`entry_missing` / `invalid_name`）与 `normal`（`inactive` / `no_client`）两组，各自按名排序保证渲染确定性。分级的理由：`entry_missing` 是"作者声明了界面、产物却没跟上"的**真实故障**（典型症状是发布漏带 `dist/`），必须显著；而 `inactive` / `no_client` 是**预期状态**，与故障同级用告警样式呈现只会让真正的故障淹没在噪声里。管理台据此渲染：`attention` → `.ui-skips-attention` 红系显著告警块（`AdminPage.tsx:385-402`）；`normal` → `.ui-skips-normal` **可折叠 `<details>`**（默认收起，`:404-421`）。四值的中文标签与解释见 `UI_SKIP_LABEL` / `UI_SKIP_HELP`（`pluginUiPlan.ts:240` / `:248`）。
- **`skipped` 与"发现期 issues"语义不同，不可混为一谈**：`GET /api/plugins/ui` 的 `skipped` 是"**插件在（已注册/已发现），但它的前端界面没加载**"（唯一机器可读出口，典型情形：声明了 `client` 却忘了跑 `build:fixtures` → `entry_missing`）；`GET /api/plugins` 的 `issues` 是"**整个插件都没加载进来**"（发现/加载期失败：目录、清单、入口模块）。管理台的告警块文案已把这条区别写死："与上面的'发现期问题'不同：那一类是整个插件都没加载进来，这一类是插件在、界面缺。"
- **订阅式读取路径**：`pluginUi.ts` 原有的 `parseUiTable` 会**直接丢弃** `skipped`（没有对外可读入口），故本批补了最小订阅式读取（`pluginUiState()` / `subscribePluginUiState()`，`packages/web/src/lib/pluginUi.ts:148/159`；快照引用稳定、仅在变更后通知），管理台用 `useSyncExternalStore` 消费（`AdminPage.tsx:96`）——**没有新写第二份 fetch**。解析侧 `readSkipped` **刻意从宽**：`skipped` 坏掉绝不能让"加载/卸载"也判为不可信（否则一个展示字段会拖垮入口表关键路径）。
- **静态资源的托管**：URL 形态为 `/plugins-ui/<插件名>/<相对路径>`——**入口与样式仍是单段文件名**（`PLUGIN_UI_FILE_SEGMENT`），而**其它资源可以是嵌套子目录**（`PLUGIN_UI_ASSET_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/`，段数上限 `PLUGIN_UI_ASSET_MAX_DEPTH = 16`，故 `assets/logo.svg`、`js/chunks/chunk-abc.js` 可用），**插件名不做 URL 编码**（scope 名 `@geewiki/wiki` 就是两个路径段），**编码名一律 404**（编码后 dev 会落 Vite 的 SPA fallback 200 + text/html，prod 静态层不解码必 404）。资产有**双根**、顺序即优先级：① `<插件目录>/dist`（外部插件**自带**产物——Docker 里 `plugins/` 是 bind mount，这是"安装即生效、无需重建 web 包"的唯一路径）② `<pluginUiDist>/plugins-ui/<名>`（内置插件与夹具）。**内置根由 `GEEWIKI_PLUGIN_UI_DIST`（`ServerOptions.pluginUiDist`）指定、缺省 = `webDist`**——两者是**两个独立配置项**（dev 下根 `package.json` 的 `dev` 脚本把内置根设为 `packages/web/public`，而 app shell 仍走 `packages/web/dist`）。之所以必须拆开：`webDist` 一个项曾同时承担"前端产物根（app shell 与 `/assets/*`）"与"内置插件 UI 资产兜底根"两个职责，dev 为让插件 UI 免构建可用而把它指向 `packages/web/public`，那里**没有 `index.html`** → 静态层与 SPA fallback 都取不到 app shell → 后端首页 404（提交 `88e0c58` 修复）。**两个 null 的语义不同**（`packages/server/src/index.ts:605-614` 的类型注释）：`pluginUiDist: null` = **不使用内置根**（只看插件自带产物），`webDist: null` = **不启用静态服务**；且 `pluginUiDist` 缺省**回落 `webDist`**，故既有部署行为完全不变。"用哪个根 / 入口在不在"由 `packages/manager/src/plugin-ui.ts` 的 `resolvePluginUiHit` **唯一**实现，被入口表与静态层的按名查根表（`pluginUiRootsFor`）**共同调用**——这是本机制最关键的不变式：两处若各算一遍，就会出现"表里说就绪、资产却 404"或"`rev` 变了内容还是旧的"这类**在快照里与"没报错"长得一样**的不一致。`/plugins-ui` 在静态层走**独立分支**且**绝不 SPA fallback**：路径不合法/插件不在根表/文件缺失一律 404 `application/json`（若回退 `index.html` 就会被掩盖成 200 `text/html`，浏览器报 MIME 错而真因不可见）。dev 下 `/plugins-ui` 由 `packages/web/vite.config.ts` 的 `server.proxy` 转发到后端——**必须**如此，因为资产可能来自 `plugins/<name>/dist`，位于 `publicDir` 之外。
- **静态层根表禁止缓存（提交 `a24241a`）**：`packages/server/src/index.ts` 的 `pluginUiRoots` 必须**每请求现算**（`config.pluginUiRoots?.() ?? {}`），因为入口表也是每请求现算——两者寿命若不同，就会出现"入口表说该插件就绪（并给出 `rev`），静态层却从**已消失的根**取文件 → 404"，而前端还会照表去 import 那个 404 的资产。触发条件很具体：**同名入口文件在两个候选根都存在**，随后高优先级那个根消失——`resolvePluginUiHit` 会回退到次优先根并在表里继续列出该插件，而缓存仍指着已消失的根。代价可控（`pluginUiRootsFor()` 只对声明了 `client` 的插件做几次 stat，注册表只有几条）。注意保留"函数"形态（而非快照对象）是**另一件事**：它解开的是"http 条目早于外部插件发现"的**注册顺序陷阱**，与缓存无关。

**已知边界（不要按"完整的插件前端扩展"理解）**：

1. **后端 `ctx.slot` 链路已建立，前端镜像与消费者尚在收敛中**（提交 `084dab4`）：后端已有 `SlotService`（`ctx.get('slot')` 可取，提供 `contribute(owner, slot, meta?)` / `list(slot?)` / `ownersOf(slot)` / `release(owner)`，且**插件卸载时按 owner 自动回收**），插槽基数由 `SLOT_CARDINALITY` 声明（`packages/core/src/index.ts:821`：`app-header` / `app-footer` / **`editor-toolbar`** 为 `multi`，`editor` / **`wiki-ask`** 为 **`single`**），`GeeWikiMeta.slots?: SlotName[]` 让插件可在 manifest 里声明占用，`GET /api/plugins/slots` 与入口表新增的 `slots` 字段对外可见（**`slots` 计入 `revision`**——否则"编辑器换人"会被 304 静默隐藏）。`app-header` / `app-footer` 的**零属性**语义**未变**；`editor` 是**新增的具名数据插槽**（`EditorSlotProps`：`value` / `mode` / `slug` / `readOnly?` / `onChange` / `onSave` / `onCancel`），**刻意不留 `[k: string]: unknown` 逃生口**——加字段必须显式改类型。**仍在收敛中的部分**：只剩 `admin-page-slots`（`editor-toolbar-slots` 这个候选名已由本批落地的 `editor-toolbar` 取代；`wiki-ask` 同批新增，两者都由 `@geewiki/ai-writing` / `@geewiki/ai-qa` 真实消费）。**`PENDING_WEB_SYNC` 那套记账已随前端补齐而清空**（守卫现在要求它保持为空），消费 `editor` 的插件也已存在（内置 `@geewiki/editor-plain`）——早期设计的目标态见 [plugin-platform-plan.md](./plugin-platform-plan.md) 第 4 节批次 D，那里已按现状标注修正。同基数插槽（`single`）同时被多个 active 插件占用时，裁决规则是**激活顺序最早者胜出**、其余进 `slotConflicts`——选"最早"而非"最新"是因为最新胜出会让后启用的插件**静默顶掉**用户正在用的编辑器；但正解仍是作者用 **`conflictGroup`** 声明互斥（插件级互斥会在**启用时**就明确拒绝，而不是留到运行期裁决）。
2. **没有 Suspense + use Hook 懒加载**：远端 bundle 由加载器显式 `import()`；"不白屏"靠上面的 ErrorBoundary，而不是 Suspense Fallback。**但"按需"是真的**：`ON_DEMAND_SLOTS = ['editor', 'editor-toolbar', 'wiki-ask']`（`packages/web/src/lib/pluginUiPlan.ts:110`）里的插槽，其 `client.js` 推迟到对应视图真正挂载时经 `ensureSlotLoaded(slot)` 拉起（`packages/web/src/pages/WikiPage.tsx:319` 问答视图、`:2371` / `:2375` 编辑视图 —— 后两行必须**成对存在**）。本批为此付出过两个隐蔽的假缺陷，两条都值得记档：**① 入口可见性只能按入口表的声明 + 仲裁判，不能按"已注册组件"判**（`pluginUiDeclaredFor`，`packages/web/src/lib/pluginUi.ts:190`；`slots` 字段是后端裁决后的**生效集**，被抑制的单占用声明者不在其中）。按已注册组件判在懒加载插槽下会**自锁**：按钮只有"已经出现过"才会出现 ⇒ 列表页的「AI 问答」入口恒不渲染，而管理台里插件是 active、入口表里条目也齐。**② 漏掉一句 `ensureSlotLoaded('editor-toolbar')` 的后果是一片静默空白**：入口表条目"生效"、无 console error、无网络请求，与"该插件根本没提供界面"长得一模一样（`WikiPage.tsx:2372-2374` 的注释记的就是这个）。
3. **ESM 模块实例不回收**（`packages/web/src/lib/pluginUi.ts:36-41` 明列为"决策，不是待办"）：`unloadPluginUi` 只做"注销插槽注册 + 移除插件 CSS"，已 import 的模块留在模块图中。因此 `rev` 变化走的是 unload → load，**同一 URL 命中模块缓存**——产物更新后**需整页刷新**才能拿到新代码（未更新时重新 enable 会复用同一实例，`register` 重跑、不累积实例）。与第 5 节的 L-6 同源。
4. **样式无隔离**：插件 CSS 以 `<link data-plugin-ui=…>` 全局注入文档，v1 **不做任何样式隔离**（无 Shadow DOM、无样式前缀改写）。示例夹具以 `.gw-fixture-*` 前缀命名类名（`packages/web/fixtures/src/style.css`）作为**约定示范**，宿主侧无强制手段。
5. **入口/样式是单段文件名，其它产物资源可以是子目录**：**入口与样式名**必须匹配 `PLUGIN_UI_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`（**刻意不放宽**——入口表契约依赖"单段"语义）；而**其它资源**（字体 / 图片 / 代码分割出的 chunk）可以放在子目录里，走 `PLUGIN_UI_ASSET_PATH`（段必须以字母或数字开头 ⇒ `..`、`.env`、空段、绝对路径、尾随斜杠与**任何百分号编码**天然非法，故无需解码、`%2e%2e` 这类编码变体不构成攻击面）。静态层对资源做**四层防护**：按段精确还原插件名并查根表 → 形态校验与段数上限 → **段比较**的包含判定（`isContained()`，用 `relative()` 而非 `startsWith`——后者是前缀比较，`/a/b-evil` 会通过 `/a/b` 的检查）→ `realpath` 后再比一次以挡**符号链接逃逸**。MIME 按扩展名映射（含 `.js`/`.css`/`.svg`/`.png`/`.woff2`/`.wasm` 等），**未知扩展名一律 `application/octet-stream`（从不是 `text/html`**，避免把未知内容当 HTML 渲染成 XSS 面）；缓存分级：**带内容指纹**的文件名（Vite 的 `logo-D3f4G5h6.svg`）→ `immutable` 长缓存，无指纹的 `client.js` 沿用既有 `no-cache`，并另有资产 `ETag` + 条件请求 304（入口表的 `revision`/304 是**独立机制**，不受影响）。
6. **无版本协商与完整性校验**：插件 UI 目前没有签名与版本校验（`packages/web/src/lib/pluginUi.ts:41` 明确登记为未做的边界）。
7. **import map 的浏览器基线**：import map 需要 Chrome / Edge 89+、Safari 16.4+、Firefox 108+（本项目未提供降级路径）。**本仓的浏览器侧验收（`scripts/acceptance/plugin-ui-cdp.mjs`）只在 Chromium 上实测过**。
8. **验收脚本不接入 `pnpm test`**：`scripts/acceptance/plugin-ui-cdp.mjs` 零依赖（Node 内置 WebSocket + 直连 CDP），但需要 Chrome、一个运行中的实例与已构建的插件产物，属集成/验收层，故**刻意不进 `pnpm test`**（后者只跑无浏览器、无网络的单测）。**同款的还有** `scripts/acceptance/theme-header-cdp.mjs`（以及 `editor-modes-cdp.mjs`）——它验的是"只在真浏览器、且只在浅色主题下才看得见"的那一类缺陷：顶栏底色在 `light` / `dark` / `system(偏好浅色)` / `system(偏好深色)` **四态**下是否跟随主题、顶栏前景对底色的 WCAG 1.4.3 对比度是否 **≥ 4.5:1**（半透明底先合成再算），以及**代码块底色是否仍恒为深色**（它与顶栏曾共用 `--gw-header-*`，顶栏改为跟随主题时最容易被误伤）。源码级守卫（`packages/web/test/designSystem.test.ts` 的"不得回流 `text-white` / `bg-white`"与"两个令牌必须解耦"）只能挡住写法回流，**证明不了浅色主题下顶栏真的是白底深字**——两者互补。

依赖图可视化（React Flow DAG，见 5.2）由宿主页面自身渲染，**不经过插槽机制**——早期设计曾把它列为插槽渲染目标，此处按实现收敛。

### 6.1 插件产物的样式契约：`--color-*` 为什么必须单独输出（2026-09-15 实测后新增）

上面第 4 条说"样式无隔离"——插件 CSS 与宿主 CSS 在同一份文档里。**这不等于插件能拿到宿主的变量**：
变量的**声明**要不要进产物，是构建期的事。

`packages/web/src/styles/tokens.css` 的语义色写在 `@theme inline` 里，而 `inline` 的语义是
"把值**内联进生成的工具类**"。宿主自己因此完全正常（生成出来的工具类里写的是 `var(--gw-ink)` 真值），
但**变量声明本身不输出**。实测改动前的产物（`packages/web/dist/assets/index-*.css`）：

| | 名字 |
| --- | --- |
| 在 | `--color-surface` / `--color-header*` / `--text-*` / `--radius-*` / `--shadow-*` —— 只是恰好被某条工具类捎带上，**不是承诺** |
| **不在** | `--color-line` / `--color-sunken` / `--color-ink` / `--color-ink-soft` / `--color-muted` / `--color-hover` / `--color-line-strong` / `--color-warn*` / `--color-danger-ink` —— **一个都没有** |

症状只落在插件产物上，而且**三种检查全都不红**（CSS 不报错、构建成功、typecheck 看不见）：
`@geewiki/ai-summary` 的摘要条 `background: var(--color-sunken)` 整条声明变成
invalid-at-computed-value-time（背景全透明、边框退回 `currentColor`），
`@geewiki/ai-assistant` 的 `var(--color-sunken, #f9fafb)` 这类**浅色回退值**则在深色主题下渲染成白块。

**结论（已落地）**：`tokens.css` 第 4b 节用一段**不分层的普通 `:root`** 把插件可引用的名字无条件输出。
它能工作是因为两点：`@theme` 的产物在 `layer theme` 里而普通规则不分层（优先级更高），
以及值仍然只是"指向 `--gw-*`"⇒ 深浅色由 `.dark` 与 `prefers-color-scheme` 决定，**契约块一行都不用改**。

**两条试过且不成立的错路**（记下来免得重走）：`@theme static inline` 与 `@theme static` 在本仓这份
Tailwind 下会把自定义色工具类**一起弄没**（`.text-ink` 直接不再生成）；把 `@theme` 整份抄一遍则立刻
有**两份会漂的名单**，代价是"插件悄悄变色"。

**守卫**（`packages/web/test/pluginUi.test.ts`，四条，均已做红-绿）：
① 插件引用的语义 token 必须落在**非 `@theme` 块**里（并带反向对照：`@theme` 内独有名必须够多，
否则这条守卫在自欺）；② 插件样式**不得写 `var()` 回退值**——回退值会掩盖契约断裂，且它只在一种主题下正确；
③ `tokens.css` 的注释必须闭合干净；④ 拿**构建产物**复核自定义色工具类真的在。

第 ③ 条不是洁癖，它是本次真正的**元凶**：注释正文里写了 `packages/plugin-*/ui/style.css`，
其中的 `*/` **提前闭合了注释**，剩下的注释文本被当成 CSS 解析，紧随其后的 `@theme inline` 被整块丢弃。
症状是"自定义颜色工具类全部消失"，与"构建失败"毫无相似之处。**同一个坑在本仓是第二次**——
第 287 行记的那类源码守卫也栽在"被守卫的东西出现在被扫描的文本里"。

## 7. 插件元数据规范（Manifest）

每个插件根目录包含 `geewiki.manifest.json`（或扩展 `package.json`，将元数据嵌套在顶层 `geewiki` 键下）。

**（P6 批复测，再次取代本文多处数量口径）**：新增内置插件 **`@geewiki/ai-summary`**
（`provides: undefined` 的纯贡献者，`requires: ['http-service','database-provider','wiki-service','policy-service','llm-service','ai-tool-service']`；
自带迁移 `0001_page_summaries.sql`；贡献 `article-summary` 插槽与 `get_summary` / `search_summaries`
两条只读工具）。**平台层新增**：插槽白名单第七项 **`article-summary`**（单占用）、
平台事件 **`PAGE_SAVED_EVENT = 'geewiki/page-saved'`**（`@geewiki/wiki` 在 `savePage` 的
**事务提交之后**用 `ctx.emit` 同步广播，不等待订阅者；`unchanged` 不广播；负载不含正文）。
**实测读数**：内置插件注册表 **23 个**、`config/plugins.base.json` 启用 **19 条**；
全仓 `pnpm test` **1817/1817 绿 / 23 个包**、`pnpm typecheck` 作用域 **26 个项目全 Done**。
详见 [design/ai-plugin-architecture.md](./design/ai-plugin-architecture.md) §8.11。

**（P5 批复测，取代本文多处数量口径）**：新增两个内置插件——**`@geewiki/ai-nav`**
（纯贡献者，贡献 `open_page` / `scroll_to` 两条 `side:'client'` 描述符，处理器在宿主
`packages/web/src/lib/navTools.ts`）与 **`@geewiki/ai-admin`**（纯贡献者，四条服务端工具
`plugin.list` / `plugin.read_config` / `plugin.set_enabled` / `plugin.set_config`，
仅所有者/管理员可用，受 `@geewiki/ai-journal` 的 `PROTECTED_AI_NODES` 自锁护栏约束）。
两者都**没有 HTTP 端点、没有前端产物、不 provide 服务**，因此入口表 `GET /api/plugins/ui`
的键数不变。**实测读数**：内置插件注册表 **20 个**、`config/plugins.base.json` 启用 **18 条**
（`issues` 空）；全仓 `pnpm test` **1774/1774 绿 / 22 个包**、`pnpm typecheck` **作用域 25 个项目全部 Done、0 个 `error TS`**。**本文更早的"17 个已注册 / 启用 13 条"已被取代**——
判断口径请以 `defaultRegistry()` 与 `config/plugins.base.json` 两份真源为准。
详见 [design/ai-plugin-architecture.md](./design/ai-plugin-architecture.md) §8.10。

> 现状说明：**外部插件目录发现已落地**（见 5.8）：宿主启动时扫描 `<仓库根>/plugins/<name>/`，按子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json` 读取清单并加载；内置插件仍由代码内置注册表静态登记（`packages/server/src/index.ts` 的 `defaultRegistry()`，**17 个已注册**：`db-sqlite`、`postgres`、`http`、`echo`、`editor-plain`、`auth`、`org`、`authz`、`oidc`、`llm`、`search`、`wiki`、**`ai-tools`**、**`ai-kb`**、**`ai-assist`**、**`ai-qa`**、`openai`），两者并入同一注册表。**数量口径注意（本批实测，真实出厂配置 + 隔离数据目录起实例）**：默认基础层清单 `config/plugins.base.json` **启用 13 条**（`db-sqlite` / `http` / `auth` / `org` / `authz` / `wiki` / `search` + **AI 六件套 `llm` / `openai` / `ai-tools` / `ai-kb` / `ai-assist` / `ai-qa`**），其余（`postgres` / `echo` / `editor-plain` / `oidc`）已注册但未启用；**P1 批复测**（`pluginsDir: null`，故不含外部插件）`GET /api/plugins` 返回 **17 条内置**（`issues` 为空，`state:'active'` 共 **13 条**，`inactive` 四条即上述四个）。本文更早的"9 个已注册 / 启用 4 个 / 显示 9 条"与"12 条 = 10 内置 + 2 外部"都已被取代——**这类数量的漂移是必然的**，所以判断口径请以 `defaultRegistry()` 与 `config/plugins.base.json` 两份真源为准，不要引用本文行数。零依赖示例见 `plugins/hello-geewiki/`。
>
> **`provides` 与服务名不是一回事**：`geewiki.provides` 只是**依赖图谱 token**，不会创建 cordis 服务；且它与本插件 `ctx.provide` 的服务名**并不总相同**（`db-sqlite` 声明 `database-provider` 但提供 `'db'`；`http` 声明 `http-service` 但提供 `'http'`）。**完整映射表见第 9.2 节——写消费方代码前必读。**

完整示例：

```json
{
  "name": "@geewiki/ai-writingant",
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
| `name` | 顶层 | 是 | — | 插件名称（npm 风格，如 `@geewiki/ai-writingant`），依赖图与冲突组以它作为标识 |
| `version` | 顶层 | 是 | — | 插件版本号（语义化版本） |
| `geewiki` | 顶层 | 是 | — | 插件元数据命名空间（扩展 package.json 时必填） |
| `geewiki.provides` | `geewiki` | 是 | — | 该插件对外提供的服务/能力标识（如 `ai-service`），供其他插件 `requires` 引用。**⚠️ 这是依赖图谱 token，不会创建 cordis 服务**，且**与 `ctx.provide` 的服务名并不总相同**（`db-sqlite` 声明 `database-provider` 但提供 `'db'`、`http` 声明 `http-service` 但提供 `'http'`；search / wiki / llm / ai 四者同名）——完整映射表见 **9.2 节**，消费方必须按真实服务名 `ctx.get` |
| `geewiki.requires` | `geewiki` | 是 | — | 依赖的插件/服务标识列表（示例依赖 `@geewiki/core`）；加载时自动递归加载未激活的依赖项 |
| `geewiki.conflictGroup` | `geewiki` | 否（可选） | — | 广义冲突组名：同组内全局仅允许激活一个（如 `llm-provider`、`database-provider`） |
| `geewiki.migrations` | `geewiki` | 否（可选目录） | — | 迁移脚本目录（SQL/JS，相对插件目录），插件激活前由迁移控制器执行（见 5.5）；外部插件的该目录必须位于插件目录内（拒绝路径穿越） |
| `geewiki.entry` | `geewiki` | 否 | `index.ts` → `index.js` → `src/index.ts` | 外部插件入口文件（相对插件目录）；仅外部插件使用，探测顺序见 5.8 |
| `geewiki.client` | `geewiki` | 否（可选） | `client: {}` 等价于 `{ entry: 'client.js' }` | **客户端 UI 入口**声明（类型 `GeeWikiClient = { entry?: string; css?: string }`，`packages/core/src/index.ts:53-61`）。`entry` 是 UI 入口**单段文件名**（缺省 `client.js`）、`css` 是可选样式**单段文件名**（缺省不注入样式），两者都相对该插件的 UI 根、都必须匹配 `PLUGIN_UI_FILE_SEGMENT`（`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`，故**这两个字段本身不支持子目录**——但插件产物里的**其它**资源可以放子目录，见第 6 节第 5 条）；声明非法时**整体视为未声明**（不抛错）。**声明后**该插件才会进入宿主下发的入口表 `GET /api/plugins/ui`，未声明则**永不进入**（见第 6 节）。**注意与上一行 `geewiki.entry` 不是一回事**：`entry` 是**后端**入口（`index.ts` 等），`client` 是**前端**入口 |
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

> **修正（本批，2026-09-15 · AI 插件化重构 P8）**：本层的插件清单已变。
> **§9.5 的 `@geewiki/ai-qa` 已整包删除**（决策 22），本节其余小节的下文凡引用该插件之处
> 均已过时。**现行 AI 插件共十二个**（全部默认启用）：
> `@geewiki/llm`（模型接入契约层）/ `@geewiki/openai`（OpenAI 兼容 adapter）/
> `@geewiki/ai-tools`（工具总线，`provides: 'ai-tool-service'`）/
> `@geewiki/ai-journal`（变更日志与回退）/ `@geewiki/ai-kb`（`list_pages` / `search_kb` / `read_page`）/
> `@geewiki/ai-web-search`（`web_search` 联网检索，默认经 AnySearch，见下表末行）/
> `@geewiki/ai-summary`（自动摘要 + 按摘要检索）/ `@geewiki/ai-pages`（`page.update`）/
> `@geewiki/ai-assistant`（会话核心，贡献 `app-dock`）/ `@geewiki/ai-writing`（`editor.*` 客户端工具描述符）/
> `@geewiki/ai-nav`（`open_page` / `scroll_to`）/ `@geewiki/ai-admin`（插件启停与配置读写）。
> **能力迁移对照**：原 `ai-qa` 的检索 → `ai-kb` 的三条工具；会话 → `ai-assistant`；
> 摘要与按摘要检索 → `ai-summary`。**缺模型/缺工具的状态码口径不变**（503 = 前置条件不满足，
> 只是词从 `search_unavailable` 换成了 `@geewiki/ai-assistant` 的 `tools_unavailable`——
> 检索变成贡献工具之后，缺的不再是一个检索服务，而是**必需的那几条工具**）。

本阶段落地的是"AI 原生知识库"的**检索地基 + 问答骨架**：把"检索"与"生成"彻底解耦，让**没有 API key 时整条链路依然完整可用**。三个插件均在 `packages/server/src/index.ts` 的 `defaultRegistry()` 静态登记，且**都不进任何冲突组**。

### 9.1 六个插件（原 `@geewiki/ai` 已拆分为 `ai-qa` / `ai-assist`；`ai-tools` / `ai-kb` 是 P1 新增的工具层）

| 插件 | 包路径 | `provides` | `requires`（服务 token） | 默认部署 | 对外端点 |
| --- | --- | --- | --- | --- | --- |
| `@geewiki/search` | `packages/plugin-search/` | `search-service` | `['database-provider', 'http-service', 'policy-service']`（**`policy-service` 是 P2 读路径依赖**：返回任何命中之前必须先问策略层「这个主体能看哪些条目」，`packages/plugin-search/src/index.ts:66`） | **启用**（`config/plugins.base.json` 第 4 条） | `GET /api/search?q=&limit=&mode=` |
| `@geewiki/llm` | `packages/plugin-llm/` | `llm-service` | `['http-service']`（`packages/plugin-llm/src/index.ts:218`，**只为首屏填服务商下拉用**；无 provider 也能装载） | **启用** | 无 AI 端点；`GET /api/llm/providers` + 模型接入配置面 |
| `@geewiki/openai` | `packages/plugin-openai/` | **`provides` 为空**（不声明 token） | `['llm-service']` | **启用** | 无（只向 `llm-service` 注册一条 OpenAI 兼容路由；`conflictGroup` 也已撤销，见 §3 修正） |
| `@geewiki/ai-qa` | `packages/plugin-ai-qa/` | `ai-qa-service` | `['http-service', 'search-service', 'llm-service']`（**不列 `database-provider`**：正文只经 `search-service` 取） | **启用** | `POST` / `GET /api/ai/ask`、`POST /api/ai/stream`、`GET /api/ai/capabilities` |
| `@geewiki/ai-writing` | `packages/plugin-ai-writing/` | `ai-assist-service` | `['http-service', 'llm-service', 'policy-service']`（**`policy-service` 是硬前置**：编辑权判定缺失即失败关闭） | **启用** | `POST /api/ai/assist`、`GET /api/ai/assist/capabilities` |
| `@geewiki/ai-tools` **（P1 新增）** | `packages/plugin-ai-tools/` | `ai-tool-service` | **无**（`requires: undefined`——它是依赖图的根之一，必须能被最先激活的那批插件接纳） | **启用** | 无端点：只暴露一张**工具注册表**（`contribute` / `list(principal)` / `ownerOf` / `release` / `diagnostics`） |
| `@geewiki/ai-kb` **（P1 新增）** | `packages/plugin-ai-kb/` | **`provides` 为空**（纯贡献者） | `['ai-tool-service', 'wiki-service', 'search-service']` | **启用** | 无端点：向工具总线注册 `list_pages` / `search_kb` / `read_page`（三条都是 `side: 'server'` 的**只读**工具，无 `mutating` 标记） |

| `@geewiki/ai-journal` **（P4 新增）** | `packages/plugin-ai-journal/` | `ai-journal-service` | `['http-service', 'database-provider']`（**刻意不依赖 llm / ai-tools**：它是工具的下游，反过来依赖会成环） | **启用** | `POST/GET /api/ai/journal`、`POST /api/ai/journal/undo`、`POST /api/ai/journal/undo/ack`（四个端点一律要求登录主体） |
| `@geewiki/ai-pages` **（P4 新增）** | `packages/plugin-ai-pages/` | **`provides` 为空**（纯贡献者） | `['ai-tool-service', 'wiki-service', 'policy-service', 'ai-journal-service']` | **启用** | 无端点：向工具总线注册 `page.update`（本仓**第一条 `mutating: true`** 的工具，逆操作由 journal 的 `page` 域撤销执行体提供） |
| `@geewiki/builtin-docs` **（本批新增）** | `packages/plugin-builtin-docs/` | `builtin-docs-service` | `['database-provider', 'wiki-service']`（**刻意不依赖 http-service**：本包**零端点**——读走 wiki 的 `GET /api/pages/:slug`，管理走 manager 的启停与配置面） | **启用** | 无端点：`ctx.provide('builtin-docs-service')`（`isManagedPage` / `isHidden`）供 `@geewiki/authz` **懒取**；迁移 `builtin_docs_state` 是方言中立的键值表（整条链路只登记 sqlite 回退目录） |

| `@geewiki/ai-web-search` **（本批新增）** | `packages/plugin-ai-web-search/` | **`provides` 为空**（纯贡献者） | `['ai-tool-service']`（**刻意不依赖 wiki / search / policy**：它查的是**站外**，与知识库无关，也不做权限判定——能不能用由工具总线按主体过滤） | **启用** | 无端点：向工具总线注册 `web_search`（`side: 'server'` 的**只读**工具，无 `mutating` 标记）。出站只有一件事：`POST {baseUrl}/v1/search`（默认 AnySearch，`/v1/extract` 等其它端点**未接线**）。**未配密钥时走匿名额度**（按来源 IP 计），故"能装就能用"；结果声明 `grounding: 'web'`——`AiToolGrounding` 的第二个取值由本包连同界面标注一起定义 |

> **修正（P4）**：上表的两行是本批新增，前面几节里"17 个内置插件""启用 13 条"的口径随之变成
> **19 个内置 / 启用 16 条**（新增的两条都进基础层）。同样地，`@geewiki/ai-journal` 的迁移目录
> 是由 `defaultRegistry()` 的 `migrationsDirs` 声明的（**只登记 sqlite**：那条迁移用了
> `AUTOINCREMENT` 与部分索引，是 SQLite 方言；整条 AI 链路本来就是 SQLite-only）。
> **一条实现期的重要缺口**：`WikiService.save(slug, input)` **不带主体**——四个读方法都要求主体，
> 唯独写方法没有，授权发生在 HTTP 处理器里。故 `@geewiki/ai-pages` 必须自己向 `policy-service`
> 要 `canEdit` 判据（那正是判据的唯一出口），并 `requires` 它以便"拿不到判据就激活失败"。
> 见 [design/ai-plugin-architecture.md](design/ai-plugin-architecture.md) §8.8。

本节表内**七个插件（search / llm / openai / ai-qa / ai-assist / ai-tools / ai-kb）都声明 `runtime.supportsHotReload: true`、`requiresCachePurge: false`、`drainTimeout: 5`**，均无进程内状态（索引在库里、路由注册表在内存但可安全重建），故可安全热插拔。**但"热插拔"与"能否在管理台点停用"不是一回事**：这七个插件都写在基础层清单里，而基础层是**冷层**——`POST /api/plugins/:name/disable` 会返回 **409 `base_layer`**（本批对 `@geewiki/ai-qa` 实测），要停用只能改清单 + 重启。`@geewiki/search` 另带 `migrations: './migrations'`（`SEARCH_MIGRATIONS_DIR`），由**管理器的迁移控制器在激活前执行**（见 5.5），不依赖 `db-sqlite` 自己的迁移。

### 9.2 服务名映射表（**消费方必读**）

> ⚠️ **manifest 的 `provides` token 与本插件 `ctx.provide` 的服务名并不总相同。** 两者是**两套命名空间**：`requires` 里写的是 **`provides` token**（由管理器的 `resolveDependency` 解析依赖边），而 `ctx.get(...)` 取的是**真实 cordis 服务名**。混用**不会报错**，只会让 `ctx.get` 拿到 `undefined`，表现为"功能静默不可用"——这是本仓最难定位的一类症状。

| `provides` token（写进 `requires` 用） | 真实服务名（`ctx.get` 用） | 提供者插件 | 定义处 | 同名？ |
| --- | --- | --- | --- | --- |
| `database-provider` | **`db`** | `@geewiki/db-sqlite` | `packages/db-sqlite/src/index.ts:160`（`ctx.provide('db', adapter)`） | ❌ **不同名** |
| `http-service` | **`http`** | `@geewiki/http` | `packages/server/src/index.ts:575`（`ctx.provide('http', router)`） | ❌ **不同名** |
| `wiki-service` | `wiki-service` | `@geewiki/wiki` | `packages/plugin-wiki/src/index.ts:443` | ✅ |

导航批（2026-09-16）另加两张**导航状态表**与两个端点，都只写在 `@geewiki/wiki` 内部（不碰 `pages`）：
`page_nav_state(slug, hidden, updated_at)` 存"在左侧边栏隐藏"（站点级），
`page_nav_order(parent, item, position)` 存**每个父级一整个同级顺序**——`item` 既可以是页面 slug，
也可以是**没有页面的分组路径**（层级由 slug 决定，`guide`/`demo` 这类目录同样需要位次；
把它们排除在外就等于"目录永远排不了序"，还会让它们在"排过的在前"规则下被挤到同层最后）。
端点是 `POST /api/pages/:slug/hidden` 与 `POST /api/pages/order`，门控沿用既有的 `requireCap(…, 'canEdit')`；
`GET /api/pages` 一并下发 `nav_order`（与 `pages` 同一次请求，避免中间态）。
集合与顺序都由前端 `packages/web/src/lib/navTree.ts` 推导（继承在**读时**算，不级联写库）。
| `search-service` | `search-service` | `@geewiki/search` | `packages/plugin-search/src/index.ts:383` | ✅ |
| `llm-service` | `llm-service` | `@geewiki/llm` | `packages/plugin-llm/src/index.ts:117` | ✅ |
| `ai-qa-service` | `ai-qa-service` | `@geewiki/ai-qa` | `packages/plugin-ai-qa/src/index.ts:951`（`ctx.provide('ai-qa-service', svc)`） | ✅ |
| `ai-assist-service` | `ai-assist-service` | `@geewiki/ai-writing` | `packages/plugin-ai-writing/src/index.ts:292`（`ctx.provide('ai-assist-service', svc)`；manifest 的 `provides` token 在 `:84`） | ✅ |
| `ai-tool-service` | `ai-tool-service` | `@geewiki/ai-tools` | `packages/plugin-ai-tools/src/index.ts`（`ctx.provide(AI_TOOL_SERVICE_NAME, registry)`，常量在 `src/types.ts`） | ✅ |
| `builtin-docs-service` | `builtin-docs-service` | `@geewiki/builtin-docs` | `packages/plugin-builtin-docs/src/index.ts`（`ctx.provide('builtin-docs-service', svc)`）。**唯一消费者是 `@geewiki/authz`，且是懒取**：`buildAccess` 每次判定现取（try/catch，缺席 ⇒ 无覆盖），据此对记账页强制 `canEdit/canDelete/canManageVisibility=false`、`hidden` 时判 `level='none'`。内置文档的**只读与隐藏判据只写在策略层这一处**——本包与 wiki 都不设第二份判据。**派生列的一致性也由本包负责触发**：`hidden` 不写 `pages.visibility`，而检索命中层只读物化列 `blocks.tier`（`plugin-search` 不再求 `visibleSlugs` 交集），故本包每次激活都调 `WikiService.resyncTiers(记账页)` 重刷 tier——判据在策略层、物化由生产者触发 | ✅ |
| （未声明 `provides`） | `manager` | `@geewiki/manager` | `packages/manager/src/index.ts:1393` | — |
| （**已撤销** `echo-service`） | **无服务** | `@geewiki/echo` | — | — |

**本阶段的"服务提供一致性"三次修复**（同一类缺陷的三种表现，均已收敛）：

1. **`@geewiki/wiki` 只声明不提供**：manifest 写着 `provides: 'wiki-service'`，却从未 `ctx.provide` ⇒ 任何 `requires: ['wiki-service']` 的消费方依赖被解析为"已满足"，而 `ctx.get('wiki-service')` 恒为 `undefined`。**已补**真实 `ctx.provide('wiki-service', svc)`（`packages/plugin-wiki/src/index.ts:443`）。
2. **`@geewiki/echo` 谎报 token**：声明 `provides: 'echo-service'` 但从未提供，且**全仓无任何消费方**。**已撤掉**该字段（`packages/plugin-echo/src/index.ts:33`），而不是为它硬造一个无人使用的服务契约。
3. **新增插件一律"声明 token + 显式 provide + 同名"**：`search` / `llm` / `ai-qa` / `ai-assist` 四者的 `provides` token 与服务名**严格同名**，并在源码注释里写明"两者名字必须一致，否则消费方 `ctx.get` 拿到 `undefined`"。

> 判断规则（写新插件时照此执行）：`provides` 是**依赖图谱 token**，它**不会创建任何 cordis 服务**；要对外提供能力，必须显式 `ctx.provide(<服务名>, svc)` 并在 dispose 时注销，同时导出服务契约类型供消费方使用。

**并列的第二类认知陷阱：`provide` 的可见性受 `apply` 结算时机约束。** 在一个插件 `apply` **尚未结算**时 `provide` 的服务，对它**在此期间创建的子插件不可见**（`ctx.get` 返回 `undefined`）。它与上面那条是**两类不同的陷阱**，但症状同形：**不报错，只是拿不到服务**，因而同样表现为"功能静默不可用"。

具体到本仓：管理器在 `apply` **内部**调用 `boot()` 激活插件，因此"管理器自己 `provide('slot', …)` 再 `boot()`"这个组合**天然自相矛盾**——被激活的插件里 `ctx.get('slot')` 恒为 `undefined`，插件的运行期插槽贡献被 `if (!slot) return` 静默跳过，**与"这个插件本来就没贡献"完全无法区分**。（提交 `084dab4` 实测踩到：夹具的 3 条插槽贡献只登记了 2 条，**零报错**；诊断日志为 `[slot-demo] ctx.get('slot') → undefined`。）

**正确做法**：把服务提供者做成**独立的兄弟插件**，在组合根里**先于**消费者装载（如 `@geewiki/slot` 之于 `@geewiki/manager`，与 `@geewiki/db-sqlite` / `@geewiki/http` 同理），而不是让消费者在自己的 `apply` 里提供、又在自己内部激活别人。

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
- **✅ 曾登记的缺陷与修复状态（该修复已落地并提交）**：`phrase` 作为缺省使 `@geewiki/ai` 的问答**按整串短语检索**，而自然语言问句几乎不可能逐字连续出现在正文里 ⇒ **恒为 0 命中**，问答的检索地基实际不可用。**修复**即上面的 `terms` 模式，并让问答一律走 `terms`（现在在 `packages/plugin-ai-qa/src/index.ts:431`：`search.search(principal, query, { limit, mode: 'terms' })`——**首参是主体**，权限过滤发生在命中层，见 §9.5）。**该修复已提交为 `04c45c3`**（此前本文标注的"工作树已实现但尚未提交"已过时；HEAD `585dbac` 的旧行为是 `search(query, { limit })` 且端点不读 `mode` 参数）。**仍成立的边界**：`mode=terms` **未接入 Web UI**（搜索框保持 `phrase` 语义，`queryMode` 随响应下发备用）；**已知代价**：terms 召回更宽、精确率天然低于短语检索（提交说明原文），建议纳入后续检索质量评估。**未验证项**：端到端召回质量**未经本文档作者复跑验证**（无真实问答链路）。

**服务契约** `SearchService`（`ctx.get('search-service')`，签名以 `packages/plugin-search/src/index.ts:191` 起为准）：`search(principal, q, opts?: { limit?: number; mode?: SearchMode }): Promise<SearchResult>`（`SearchMode = 'phrase' | 'terms'`，缺省 `'phrase'`）与 `contents(principal, slugs): Promise<ReadonlyMap<string, ContentView>>`（`ContentView = { text, blocks, gatedCount, maxVisibleTier }`，`:162-175`）。**两个方法的首参都是主体，且是必填**——权限过滤发生在命中层与正文层各一次，这正是 §9.5 问答红线的地基；把签名抄成 `search(q, …)` 会让本节直接反驳 §9.5。`search()` 与端点走**同一份实现**（端点只做 HTTP 层），故两者在同 `q` 同 `limit` 下结果逐字段一致；`limit` 非法时服务层抛 `RangeError`（对应端点的 400）。`contents()` 供 RAG 拼上下文，**只包含真实存在的 slug**（查不到的键不出现，消费方据此区分"页面不存在"与"正文为空串"）；占位符按 `slugs.length` 动态生成、值一律参数绑定（绝不把 slug 文本拼进 SQL）。插件卸载后调用**显式报错**，绝不返回空结果——"卸载后静默返回 0 命中"会被误读成"库里没有匹配内容"。

### 9.4 `@geewiki/llm`：契约 + 降级词汇 + 密钥安全（**契约层，不含厂商 adapter；adapter 在 `@geewiki/openai`**）

**本包至今不含任何厂商 adapter**——这一点没变，变的是两件事：① **adapter 已经存在**，在兄弟包 `@geewiki/openai`（只向 `llm-service` 注册一条 OpenAI 兼容路由，`provides` 为空，默认启用）；② 这里当初的理由"没有 API key 时整条链路依然完整可用"**已被本批的问答裁决推翻**（问答不再用抽取式摘要冒充答案，缺模型即 503 显式不可用，见 §9.5）。本包保留的是与厂商无关的三件事：route→provider 注册表与终止保证、**降级词汇的唯一真源**（`degrade.ts` 的 `Degraded`/`DegradedReason`/`CODE_TO_REASON`/`makeDegraded` + `redact.ts`）、以及**可用性投影**（`availability.ts` 的 `safeAvailable`/`listRouteInfos`/`hasAvailableModel`/`noModelDegraded`）。**"注册表里有没有路由"与"路由可用不可用"是两件事，旧文把它们混成了一句**（本批改正）：注册表里**有两条路由**——恒不可用的兜底占位 `null` 与默认启用的 `openai`（本批实测 `GET /api/ai/capabilities` 的 `providers` 恰是这两条：route=`null`（label 未配置（降级占位））一条 + route=`openai`（label OpenAI 兼容端点）一条）。开箱状态下**两条都 `available:false`**（`openai` 那条缺凭据），所以"没有可用模型"这个结论仍然成立，但**成因不是"表里没有 provider"**——把成因写错会让人去查注册表而不是去查凭据。兜底占位 `NULL_PROVIDER` 在 `packages/plugin-llm/src/service.ts:102`（`route: 'null'`、`label: '未配置（降级占位）'`、`available: () => false`，被点名时只产一个终止 chunk `error{MISSING_CREDENTIAL}`）——它的职责是**让"没配置"成为一条可被枚举、可被 `capabilities` 如实报告的路由**，而不是让调用静默返回空。

**契约要点**（`packages/plugin-llm/src/types.ts`）：

- **统一错误码枚举**（跨 provider 可判别，不依赖各厂商的错误文本）：`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` / `NETWORK` / `PROVIDER_ERROR` / `ABORTED`。
- **调用方按 `type`/`code` 分支，绝不按 `message` 文本分支**——message 是给人看的，可能被脱敏、也可能被上游改写。
- **`error` chunk 在结构上就没有 `message` 字段**：上游报错文本里可能夹带密钥（URL query、鉴权头回显），从结构上让它无处可去，比"记得脱敏"更可靠。
- **终止保证**：`stream()` **保证终止 chunk（`done` / `error`）恰出现一次且在末位**，且**绝不抛异常** ⇒ 消费方可以无判空 `for await`。五条路径都被钉死：provider 抛错 → `error`；signal 已/中途 abort → `error{ABORTED}`；终止之后仍产 chunk → 丢弃并关闭上游；未产终止就结束 → `error{PROVIDER_ERROR}`；无可用 provider → `error{NO_ADAPTER}`。
- **服务本身绝不重试**：重试涉及退避、配额与幂等语义，属独立层的职责；偷偷重试会让上层无法判断"这次失败到底花了多少配额"。
- 重复注册同一 `route` **必须抛错**（不得静默覆盖）；`available()` 抛错视为不可用（不拖垮整个服务）。

**密钥安全**（结构性而非纪律性）：

- **密钥有两条路，主路已不是环境变量名**（本批核对，旧文只写了第二条）：**① `apiKey` = 写一次、不可回读的 secret 字段**（`packages/plugin-llm/src/index.ts:138` 的 `.role('secret')`），落**独立的 `config/secrets.json`**（`packages/manager/src/secrets.ts`；实测 `-rw-------` 即 0600，且在 `.gitignore` 里 `:34`），**绝不进入库的 `config/plugins.*.json`**，任何 HTTP 响应也不回显（`GET /config` 该字段回空串 + `secrets.apiKey: true`）；**② `apiKeyEnv` = 环境变量名**（`:200`，校验必须是全大写+下划线，`:245`）仍支持，给"密钥由部署环境持有"的部署方式。两条都结构上杜绝密钥进入**会落盘入库**的 `config/plugins.base.json`。
- **激活期的闸门是 `isEnvVarName()`，不是密钥启发式**（`packages/plugin-llm/src/credentials.ts:57`，调用点 `packages/plugin-llm/src/index.ts:243-250`）：`apiKeyEnv` 必须是全大写 + 下划线的**环境变量名**，命中"看起来像密钥值"的输入直接**让激活失败**并给出可执行提示（要填密钥请用 `apiKey` 那个 secret 字段）。空串必须放行——那是"未配置"的降级路径。**旧文这里写的是 `detectSuspiciousCredential()`，那个函数已不再用于配置校验**（`packages/plugin-llm/src/redact.ts:4` 明写），它是黑名单启发式、永远补不全（32 位 hex、被 `UPPER_SNAKE_NAME` 主动豁免的全大写串都漏判），而"漏判"在配置校验语境下的后果正是**静默失败**；它现在只服务于脱敏相关判断。**用白名单式语法校验而不是黑名单识别**，是本节最该记住的一条（throw 而非 `process.exit(1)`——后者会把一个可恢复的配置问题升级成整站不可用）。**保守优先**：全大写 SNAKE 命名（`DEEPSEEK_API_KEY`）一律放行，因为把变量名误判成密钥会让插件无法激活，而漏判只是少脱敏一处日志。
- `redact()`：日志/错误文本脱敏，与检测**共用同一组正则源**（`SECRET_PATTERN_SOURCES`，单一事实来源），并遮蔽 `authorization` / `proxy-authorization` / `x-api-key` / `api-key` 等头名后面的值（保留原有引号，避免把 JSON 日志改成非法 JSON）。
- `status.message` 经 `redact` 后输出；**`text-delta`（模型输出）刻意不脱敏**——脱敏会篡改模型输出内容。

### 9.5 `@geewiki/ai-qa`：检索增强问答（**模型必需，缺了就明确不可用**）

**产品裁决本批改了。** 旧形态的口号是「没有 API key 时也完整可用」，实现方式是 `mode:'retrieval-only'` +
零成本抽取式摘要——响应结构不变、`answer` 字段里装的却是检索片段拼接。用户只有读完才判断得出"这不是回答"，
这正是「AI 辅助功能很不好用」的第一来源。**`extract.ts` 与该形态连同其测试一并删除**；现在没有可用模型就是
**不可用**，界面与日志都说得出口。裁决与后果见 [design/ai-plugin-split.md](design/ai-plugin-split.md)。

**顺序即语义**（`src/index.ts` 的 `ask()` / `runStream()`）：**先判模型 → 再检索 → 再看有没有资料 → 最后才生成**。
把"没有模型"放在检索**之前**是刻意的：反正答不出来，就不白跑一次检索，也不在响应里附一批 `sources`
诱导前端"显示点什么"。

**状态码现在能说真话**（固定口径，写进 `src/index.ts` 与 `src/types.ts` 文件头，改一处必须改两处）：

| 码 | 含义 | 出现的 `error` | 处置动作 |
| --- | --- | --- | --- |
| **503** | **前置条件不满足，我们根本没调用模型** | `model_unavailable`（无可用路由）、`search_unavailable`（检索服务不可用/未启用） | 去「插件管理 → 模型接入」配凭据 / 等检索回来 |
| **502** | **上游真的失败了** | `generation_failed`（带 `degraded.code`，如 `RATE_LIMIT` / `PROVIDER_ERROR`） | 稍后重试、查上游状态；**配置本身没问题** |
| **200** | 正常，**含"没找到资料"** | — | — |
| 400 / 401 / 413 | 调用方问题 | `empty_query` / `too_long` / `invalid_limit` / `invalid_body` / `invalid_json` / `payload_too_large` | 改请求 |

把 503 与 502 混成一个码是本批修掉的真缺陷：**"没配密钥"与"网关抽风"在界面与监控里原本长成同一个样子**，
前者该去配置、后者该重试，处置动作完全相反。同理，**检索 0 命中是 200 `mode:'no-context'` + `answer:null`**
——那是事实（知识库里没有），不是失败，也**不调用模型**（本批实测 `modelCalled:false`）。

**"半截"与"没有"是两件事**（`src/index.ts:513-524`）：上游中断但已经吐出文本 ⇒ **200 + `mode:'rag-partial'` +
`partial:true` + `degraded`**（诚实标注"这是半截"）；`text === ''` 一个字符都没有 ⇒ **502 + `PROVIDER_ERROR`**。
判据刻意用 `text === ''` 而不是 `usage.completionTokens === 0`——后者是可选字段，缺席不等于"没生成"。
半截产物绝不冒充完整回答，空产物绝不冒充生成结果。

**权限红线**：`search-service` 的 **`search(principal, …)` 与 `contents(principal, …)` 两处都必须带主体**
（`src/index.ts` 的 `retrieve()`）。命中层与正文层各过滤一次，**漏一处就是"标题/正文泄漏"**——
只过滤命中层意味着攻击者可以用问答枚举不可见页的正文。检索**一律 `mode:'terms'`**（`src/index.ts:431`），
词元切分复用 `@geewiki/search` 的单一实现，本插件不重复实现分词。

**引用与提示词**：`sources[].n` 只对 `used:true` 者从 1 起连续编号（类型 `number | null`），与 prompt 里的
`[n]` 严格一致；系统提示词（`src/prompt.ts`）要求**只依据给定资料**、**资料不足必须明说「知识库资料不足，无法回答」**、
**不得编造**、Markdown 先结论。上下文截断策略沿用旧设计（`src/select.ts` 的 `selectSources()`：按 `score` 降序、
`perSourceChars` 截断、**放不下就整条丢弃、绝不做尾部裁切**——半句话会诱导模型顺着编下去），
`totalContextChars` 默认 0 = 由 `contextWindow − maxOutputTokens − 提示词余量` 自动推导（`src/budget.ts`）。

**流式（`POST /api/ai/stream`，`src/index.ts:931`）**：帧只有四种（`src/sse.ts:49-52`），且
**所有前置判定（401 / 400 / 429 / 503，含检索不可用）一律在写 SSE 头之前以普通 JSON 返回**——
一旦事件流开始，就没有"用事件流表达前置失败"这种含混状态。于是
`status`(mode + sources) → `delta`* → `done` | `error` 是**结构保证**而非约定（守卫在
`test/stream.test.ts`：一条钉"检索不可用走 JSON 503 且不写头"，一条钉"现存全部流路径首帧都是 `status`"）。
超时/取消仍是插件内自管：硬超时 **120s** / idle **30s** / 并发 **4**（`src/sse.ts:30` / `:38` / `:46`，
**刻意不进 `configSchema`**，只留测试注入口）；客户端断开走 `res.on('close')` ⇒ `ac.abort()` 立刻停上游。

**降级词汇不再归本包**：`Degraded` / `DegradedReason` / `degradedFromCode` / `makeDegraded` / `redact` 现在在
**`@geewiki/llm`**（`packages/plugin-llm/src/degrade.ts`、`redact.ts`），可用性投影在 `availability.ts`
（`safeAvailable` / `listRouteInfos` / `hasAvailableModel` / `noModelDegraded`）。`DegradedReason` 恰好 **8 个成员**；
**`search_unavailable` 不在其中**——它是问答的功能前提，活在 `src/types.ts` 的 `AskErrorCode` 里。
镜像守卫的归属见 §9.7。

**本批实测**（`data/verify/ai-split-e2e/`，确定性假上游，读数 `result-backend.json` / `result-ui.json`）：
无凭据 ⇒ `503 model_unavailable` + 响应体**没有 `answer` 字段** + `A_stream` **不是 event-stream** + **上游调用数 0**；
配好密钥 ⇒ `200 mode:'rag'` 且答案逐字等于模型输出、`sources[].n` 与 `[1]` 一致；429 ⇒ `502 RATE_LIMIT`；
空产出 ⇒ `502 PROVIDER_ERROR`；0 命中 ⇒ `200 no-context` 且不调模型。

### 9.6 `@geewiki/ai-writing`（辅助写作）与 **AI 界面的插件化接入**

**后端红线**：进模型的正文**只来自请求体**（`before` / `selection` / `title` / `docText`，
上限 `ASSIST_TEXT_MAX = 4000`，`src/assist.ts:46`），`slug` **只**用于编辑权判定，全路径没有
`wiki-service` / `readPage` / 任何取正文的调用。`policy-service` 缺失 ⇒ **失败关闭 403**（不是"跳过检查"），
且**权限判定先于降级判定**——否则"降级"会成了一条无需权限的探测通道。响应体逐字段沿用旧形状
（`mode: 'generated' | 'unavailable'` + `text: null` + `degraded`），本批新增 `GET /api/ai/assist/capabilities`
（只回答"有没有能写作的模型"，与问答的 `capabilities` 语义不同，不共用）。失败语义与问答同一口径
（503 前置 / 502 上游），**上游正常结束但零字符同样判失败**（502 + `PROVIDER_ERROR`）。
守卫：`test/assist.test.ts`（禁用调用清单 + `slug` 白名单的源码级守卫 + 零 token 用例）。

**前端归属（本批的"归属修正"）**：宿主 `packages/web/` 里**不再有问答面板与辅助写作工具条**——
`components/AskPanel.tsx`、`components/ai/AssistToolbar.tsx`、`lib/aiStreamPlan.ts`、`lib/assistPlan.ts`、
`api.ts` 的四个 AI 方法、`lib/searchPlan.ts` 的降级文案、`styles.css` 的 `.ask-*` 一并删除。界面现在住在各插件的
`ui/`，经**两个新增插槽**插入宿主：`wiki-ask`（单占用，问答面板）、`editor-toolbar`（多占用，工具条按钮组）。

宿主只保留**自己的资产**：路由 `#/wiki/ask/<q>`、`[data-slot="wiki-ask"]` 出口、以及没有贡献者时一句
**中性占位**（「当前没有启用提供问答界面的插件…」）。占位文案**不写插件名、不猜原因**——为什么不可用只有插件
自己知道，宿主替它解释就是替别人的功能编造理由。**宿主不替插件说话，但也不是"零 AI 文案"——准确口径是"不写插件名/模型名、不猜不可用的原因"**：入口按钮的文案是**功能名**「AI 问答」，由宿主渲染并刻意不写插件名（`packages/web/src/pages/WikiPage.tsx:870-874` 的注释就是这条裁决："用哪个模型、缺什么配置"是插件的知识，点进面板由它自己说）；没有贡献者时那句「问答功能未启用」也**不点名插件**。

**守卫归属要分三方，别把插件侧守卫当成宿主侧守卫**：`packages/plugin-ai-qa/test/uiPanel.test.ts` 与 `packages/plugin-ai-writing/test/uiToolbar.test.ts` 钉的是**插件自己的**产物（字符串、状态分支、镜像词汇），**它们根本不读 `packages/web/src`**；钉"宿主侧不再残留 AI 界面"的是 `packages/web/test/pluginUi.test.ts`（清单声明的产物名与插槽、构建链 `FIXTURE_OUT` 咬合、**样式归属**——宿主 `styles.css` 里若残留 `.ask-*` 规则即变红、产物只能从 react 取运行时、`ui/` 目录不得 import 服务端）；"中性占位不点名插件"则由**浏览器侧断言**钉（`scripts/acceptance/ai-split-e2e/cdp-ui.mjs` 的 1c 与 5b/5c）。

**产物归属**：界面**源码在插件包、构建仍由 `@geewiki/web` 编排**（`build:plugin-ui` →
`packages/web/public/plugins-ui/<插件名>/client.js|client.css`）。这不是洁癖而是必要：内置插件在管理器里
**没有 `dir`**（`packages/manager/src/deps.ts` 只给外部插件挂资产根），"从插件目录直接发资产"那条资产根对内置
插件根本不可用。**宿主 SDK 因此新增 `renderMarkdown`**（`HOST_SDK_VERSION` `0.1.0` → **`0.2.0`**）——
全仓只留一份 marked/DOMPurify；插件用 `typeof host.renderMarkdown === 'function'` **特性探测**，缺席退回纯文本。

**两条踩过的教训**（都已写进代码注释，都是"看起来像产品缺陷"的那类）：
① 入口可见性只能按入口表的**声明 + 仲裁**判（`pluginUiDeclaredFor`，`packages/web/src/lib/pluginUi.ts:190`；
`slots` 字段是后端裁决后的**生效集**）。按"已注册组件"判在懒加载插槽下会**自锁**——按钮永远不出现，除非它
已经出现过。② 懒加载集合 `ON_DEMAND_SLOTS = ['editor', 'editor-toolbar', 'wiki-ask']`
（`packages/web/src/lib/pluginUiPlan.ts:110`）；进编辑视图必须**同时**拉起 `editor` 与 `editor-toolbar`
（`packages/web/src/pages/WikiPage.tsx:2371` / `:2375`），漏后者得到的是**一片静默空白**：管理台里插件 active、
入口表条目齐、零 console error，与"该插件没提供界面"长得一模一样。

**"停用插件不需要重建前端"已实测，但路径与直觉不同**：内置插件在基础层清单里，
当时 `POST /api/plugins/:name/disable` 返回 **409 `base_layer`**（会话层才是热层）；那条限制本批已放开
（基础层插件可**临时停用**，见 §5.3，重启即恢复）。当时的验收因此走的是
**改清单 + 重启进程**，并比对**产物指纹**——`packages/web/dist/index.html` 与两个插件 bundle 的 SHA-256
**逐字节不变**，同时入口消失、界面出现宿主中性占位（`scripts/acceptance/ai-split-e2e/cdp-ui.mjs`，19/19）。

### 9.7 本层已知边界（不做，且都有理由）

| 边界 | 状态 | 理由 / 后续方案 |
| --- | --- | --- |
| **无可用 provider（默认部署）** | 现状 | `@geewiki/openai` **已默认启用**但仍需外部凭据，所以开箱问答与辅助写作**明确不可用（503）**——不再有 `retrieval-only` 冒充答案。`rag` / `rag-partial` / `no-context` / 429 / 空产出五条链路**已用确定性假上游实测**（`data/verify/ai-split-e2e/`）；**仍未实测的只有"接真实厂商"**（见 `docs/design/ai-plugin-split.md` §8） |
| ~~**流式（SSE）未做**~~ **已交付** | 本批（见 §9.5） | **出口机制已就绪**（提交 `2273006`）：长连接经 `trackStream` 登记后**不参与排空计数**，`noteStatus` 提供"只记指标、不结束响应"的通路，teardown 五步内会主动收流——即"SSE 出口必须与排空语义一起设计"这件事**已经做完**。**真实流式输出本批也已接线**：`@geewiki/ai-qa` 的 `POST /api/ai/stream`（`packages/plugin-ai-qa/src/index.ts:931`）持续写 `status` / `delta` / `done` / `error`；原先"尚未落地的两件"都落地了——**硬超时 120s / idle 30s / 并发 4**（`packages/plugin-ai-qa/src/sse.ts:30` / `:38` / `:46`，刻意不进 `configSchema`，只留测试注入口）与 **`res.on('close')` 即 `ac.abort()` 取消上游**（`packages/plugin-ai-qa/src/index.ts:784`）。旧文里"`generate()` 是唯一未接线点"随之作废（该函数已随拆分重写）。真正仍缺的仍是**宿主级通用治理**（见下表最后一行）。另须记住 §5.1.1(b) 的实测结论——**不要**用 `writeHead` + `h.json()` 去"记一次指标"，它会给事件流追加字面 `null` 并立即终结流 |
| **向量 / 语义检索未做** | 有意后置 | 离线 + 零重依赖前提下不现实（本地 ONNX 需预烤模型与 ORT WASM 运行时）；只留接口位。当前检索是**纯字面**匹配，故同义改写、跨语言、模糊表述都搜不到 |
| **`search` / `ask` 是保留 slug** | 现状 | **四个**首段是保留的：`search` / `ask` / `new` / `list`（前端判据 `packages/web/src/lib/wikiRoute.ts:27` 的 `WIKI_RESERVED_FIRST_SEGMENTS`，后端判据 `packages/plugin-wiki/src/index.ts:535` 的 `RESERVED_FIRST_SEGMENTS`，两处同集合） |
| **密钥** | 边界（**本批收窄**） | 主路 `apiKey` 是**写一次、不可回读**的 secret 字段 ⇒ 落 `config/secrets.json`（0600、gitignored），`GET /api/plugins/:name/config` 该字段恒回空串 + `secrets.apiKey: true`，故**不再构成回显面**；备选路 `apiKeyEnv` 只是环境变量名，也不入库。**仍成立的边界**：`GET /api/plugins/:name/config` 对**普通配置字段**（`baseUrl` / `model` / `contextWindow` …）依然**明文返回**（见 5.7）——写一次语义只保护被标成 secret 的字段 |
| **`redact` 是启发式** | 现状 | 未覆盖的密钥形态不会被脱敏；`text-delta`（模型输出）**刻意不脱敏** |
| **宿主级通用长连接治理** | 仍缺 | `@geewiki/http` 不提供通用超时/背压/心跳，每个写流的插件都得自己实现（`trackStream` / `closeStreams` 只解决"卸载时收得掉"，不解决"卡住时断得开"） |
| **镜像守卫的归属** | 本批改判 | 旧做法是让宿主 web 替插件守镜像（`packages/web/test/degradedReason.test.ts`），而界面迁走后宿主**不再消费任何 AI 字段**，那个守卫就变成了"没人用的东西守着一份没人用的词汇"。**已删除**，改由消费方自守：`packages/plugin-llm/test/degrade.test.ts`（`CODE_TO_REASON` 对 `LlmErrorCode` 全量覆盖 + `search_unavailable` 钉在 union 外 + `listRouteInfos` 脱敏）与两插件界面侧守卫。留下的判据是**谁消费，谁守镜像** |

## 10. 参考与对比

- **PandaWiki**：借鉴其 Wiki 功能边界，摒弃重架构（Redis、多服务拆解）。
- **Cordis 生态**：学习插件间 `ctx` 的隔离与通信模式。
- **VS Code / Obsidian**：借鉴插件沙箱与禁用/启用交互范式（对应本系统的会话层沙箱与显式授权热插拔）。
