# 0009. 极简部署形态：单进程 + SQLite 默认 + `pnpm deploy` 部署树

- **状态**：accepted
- **日期**：2026-09-28（记录日期）
- **取代 / 关联**：ADR-0001（纯 `node:http`，本条的"单进程"是它的部署侧后果）、ADR-0002（运行期直跑 TS，决定部署树里装什么）、ADR-0003（SQLite 为主 + PG 双轨）、ADR-0007（看门狗熔断的自愈前提是"容器重启回基础层"）

## 技术背景

产品定位是**自托管知识库**：拿到一台机器（或一个容器）就能跑起来，不需要先准备数据库、缓存、消息队列或对象存储。当前落地形态：

| 事实 | 证据（路径 + 符号名） |
| --- | --- |
| 一个进程承担全部：HTTP 服务、插件装配、会话层、健康探针 | `packages/server/src/index.ts` 的 `startServer` 与 `defaultRegistry` |
| 镜像三段：`builder`（构建前端 + 产出部署树）→ `deployer`（跑 `pnpm deploy --filter @geewiki/server --legacy --prod`）→ `runtime`（只 `COPY --from=deployer /app /app` + `packages/web/dist` + 全局 `tsx`） | `Dockerfile` |
| 运行用户非 root（uid 1000），`HEALTHCHECK` 判据是 `/api/health` 的 `ok` **且** `db.present` | `Dockerfile` |
| 默认后端是单文件 SQLite，读写一体、无独立数据库容器；PG 走 `profiles: ["production"]` | `docker-compose.yml`；`packages/db-sqlite/src/index.ts` 的 `DatabaseAdapter`（同步接口） |
| 外部插件"挂进来即被发现"，不打进镜像 | `packages/manager/src/discovery.ts` 的 `scanPluginDirs` / `loadExternalPlugins`；`GEEWIKI_PLUGINS_DIR` |
| 优雅退出：SIGTERM/SIGINT → 落盘会话层与配置 → 停服务 → `handle.dispose()` → 删 `crash.marker` | `packages/server/src/index.ts` 的 `shutdown` |
| 卸载前排空在途请求（全站语义） | `packages/http/src/index.ts` 的 `HttpRouterService.drain` / `trackStream`；`packages/manager/src/index.ts` 的 `drainBeforeUnload` |

需要回答的问题是：**这套形态要不要为"更大规模"预留结构**——多副本、独立 worker、编译产物分发、外部对象存储，还是接受"一个进程装下一切"并把边界写清楚。

## 考虑选项

1. **多服务拓扑**（API / worker / 独立检索服务 / 对象存储）。
   否：与"自托管一条 `docker compose up` 就能起"直接冲突，见 `docs/architecture.md` 的部署编排一节；而且它要推翻 ADR-0001 的"插件在同一 cordis 图上互相 `require`"这个地基。
2. **服务端产出编译后的 JS 再部署**（`tsc` emit）。
   否：那是 ADR-0002 已否掉的事（本条只承担它的部署侧后果）。
3. **把 PostgreSQL / 外部 KV / 对象存储设成默认**，SQLite 只在 demo 里用。
   否：ADR-0003 已定"开箱即用优先"，`docs/design/attachments.md` 明确否掉"附件进 DB BLOB"与"引 MinIO/S3"（多组件违背「极致轻量」，自托管多一道故障域）。
4. **维持单进程 + 部署树**，并把"单进程假设"与"退出语义的边界"逐条写进文档与守卫。← 本决策。

## 决策结果

**一个进程就是一套 GeeWiki**：HTTP、插件图、会话层、看门狗、检索、AI 编排全在同一 cordis 上下文里；默认存储是单文件 SQLite（PG 是可选双轨，不是第二套架构）；交付物是 `pnpm deploy` 产出的**部署树**（含 TS 源码，见 ADR-0002）+ 前端静态产物；横向扩展**不在当前设计范围内**，需要更大规模时的正确答案是"换架构"而不是"多开副本"。

"极简模式"**不是一个开关**，而是配置事实（见下方负面后果 ④）。

## 后果

### 正面

- 落地成本接近零：单容器 + 两个卷（`./data`、`./config`）+ 一个 `restart: unless-stopped`；无中间件运维。
- 崩溃自愈闭环成立：`crash.marker` 只在未捕获异常 / 未处理 Promise 拒绝 / `startServer()` 抛错时写入，重启后跳过会话层装配并删标记（`packages/server/src/index.ts` 的 `writeCrashMarker` / `removeCrashMarker`），把"坏插件反复崩溃"收敛成"回到基础层"。
- 审计、权限、检索、AI 工具链共享同一个 `Principal` 与同一份判据（ADR-0004、ADR-0011），不存在跨服务传身份的失真问题。
- 镜像不含 `devDependencies`、不含 `.git`、非 root 运行、`HEALTHCHECK` 双条件，这些是部署侧已经付过成本的 hygiene。

### 负面（如实）

**① 没有任何水平扩展路径，而且这是架构级的，不是"还没做"。** 三类状态都是单进程假设：
- 会话层清单与 `crash.marker` 是**进程本机文件**（`packages/manager/src/index.ts` 的 `ManagerConfig.crashMarkerFile`）；两副本共享 `./config` 时，一边熔断清空会话层会把另一边一起打回基础层。
- 看门狗归因是进程内的（`packages/manager/src/watchdog.ts` 的 `decideWatchdog`）：它只看本进程的连续 5xx 与本进程的"最近一次会话层激活"。多副本下故障归属与回滚都会失真。
- 排空是**全站语义**：`HttpRouterService.drain` 等的是本进程全部在途请求，而按插件（owner）粒度的在途排空在 `drainBeforeUnload` 的注释里就写着"仍未实现"。
结论：**跑多副本前必须先解决"会话层是共享状态还是本机状态"**，而当前答案是本机状态。README/部署文档不应暗示"多开几个就行"。

**② 部署树里带全部 TS 源码，"极致轻量"只在依赖维度成立。** 因为 ADR-0002 选了运行期直跑 TS，`runtime` 阶段必然携带 `packages/**/src/**`。省掉的是 `devDependencies` 与 `.git`，没有省掉源码，也没有 JIT 前的启动收益。对"镜像里不希望看到源码"的部署者，这不是可选项。

**③ 退出语义只覆盖 SIGTERM/SIGINT，不覆盖 SIGKILL。** `shutdown` 的顺序是"先落盘会话层/配置，再停服务，再 `dispose()`"，这个顺序的正确性依赖信号真的送达。K8s 的 `preStop` 钩子、过短的 `terminationGracePeriodSeconds`、OOM kill 都会把"优雅卸载"变成"进程直接消失"——此时在途请求被硬切、插件的 `dispose` 没跑、`crash.marker` 不会写（它只在三种崩溃情形写），运维侧表现为"干净退出但状态可疑"。仓库里**没有任何优雅停机相关的开关或超时配置**（全仓无 `supportsGracefulShutdown` 命中，环境变量清单见 `docs/deployment.md` §6）。

**④ "轻量模式"目前靠手工裁剪清单，没有开关。** 想跑一个"纯 wiki、无 AI"的实例，今天的做法是：写一份只留 `db-sqlite http wiki` 的 `config/plugins.base.json`（基础层 live 文件不入库，模板是 `config/plugins.base.example.json`）、不给 `GEEWIKI_PLUGINS_DIR`、不注册模型 provider。全仓**没有** `GEEWIKI_DISABLE_SESSION` 之类的精简开关（`packages/server/src` 里出现的环境变量只有 `GEEWIKI_PORT` / `GEEWIKI_HOST` / `GEEWIKI_CONFIG_DIR` / `GEEWIKI_DATA_DIR` / `GEEWIKI_WEB_DIST` / `GEEWIKI_PLUGIN_UI_DIST` / `GEEWIKI_PLUGINS_DIR` / `GEEWIKI_ADMIN_TOKEN` / `GEEWIKI_STRICT_ROUTE_ACCESS`）。
两个静默陷阱与它同源：`./config` 挂空目录会**遮蔽**镜像内的模板 ⇒ 读到空清单 ⇒ `REST API 未挂载` ⇒ `exit=0` ⇒ 被 `restart: unless-stopped` 反复拉起（见 `docs/architecture.md` 部署一节，已实测）；`GEEWIKI_PLUGINS_DIR` 写相对值时，部署树里没有 `pnpm-workspace.yaml`，发现根会回退到 `process.cwd()`（`packages/core/src/services.ts` 的 `repoRoot` 判据是"有没有 `pnpm-workspace.yaml`"），表现为**静默发现 0 个插件且不报错**（已实测）。

**⑤ 单写者存储的并发上限是这台机器的上限。** better-sqlite3 是同步驱动、单写者（`docs/design/attachments.md` 记着"往 SQLite 写 10 MiB BLOB 会阻塞全站写"，这也是附件走文件系统而不进库的理由）。写并发到量之后的正确答案是切 PG（ADR-0003），而切过去之后 ① 依然存在。

**⑥ 与「不绑厂商」的张力：形态没绑，运维形状绑了 Docker/Compose。** `docker-compose.yml` 与 `Dockerfile` 是事实上的交付面（`--init`、健康检查、卷语义、非 root uid 1000 的属主约定都写死在其中）；不用 Docker 也能跑（`pnpm start`），但崩溃自愈、健康检查、`restart` 策略这三件运维事实需要部署者自己重建。`docs/deployment.md` 已给出"不用 compose 时"的等价命令，这是缓解而非消除。

**⑦ 与「安全可控」的张力：单进程把"爆炸半径"收成一个。** ADR-0006 的无沙箱 + 本条的单进程 = 一个坏插件能吃掉这个实例的全部资源与数据；多副本不会缩小这个风险，只会把它复制 N 份。真正的隔离手段仍是 ADR-0006 的长期方向。

## 重新评估触发条件

- 出现**必须多副本**的真实需求（多实例负载均衡、蓝绿发布）：先解决"会话层清单与 `crash.marker` 的归属"，再谈副本数。
- 出现**必须优雅停机**的环境（K8s 生产、有长任务/长连接）：需要把 `drain` 的超时与"K8s 探针失败 → 主动预关"做成显式配置，而不是依赖信号时序。
- 出现"镜像不能带源码"的合规要求：那时要重评的是 ADR-0002（编译产物），本条要跟着改部署段。
- 单实例写并发或数据量超过 SQLite 的舒适区：按 ADR-0003 切 PG，并复评本条 ①。
