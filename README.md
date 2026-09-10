# GeeWiki

面向团队内部的 AI 原生 Wiki 知识库。

核心哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用）；PostgreSQL 适配规划中（Phase 4），当前尚未提供 PostgreSQL 适配包。

**当前状态：Phase 2 完成 + Phase 3 部分落地** —— 插件管理器（依赖图/冲突组/会话层/看门狗）、Wiki CRUD + 版本历史、React 19 管理台与依赖图均可完整交互；插件配置系统（schema 表单 + 热更新）与外部插件目录发现已落地；前端 Slot 为**宿主侧插槽 + 后端下发入口表 + 随插件生命周期自动同步**（边界见下方"已知限制"）。开发路线与阶段进度见 [docs/roadmap.md](docs/roadmap.md)。

**当前实现状态**

- **已完成（Phase 0-2）**：pnpm monorepo 共 7 个包；`pnpm dev` 一条命令同时启动后端 http://127.0.0.1:3000 与前端开发服务器 http://localhost:5173（生产形态 `pnpm build` 后用 `pnpm start`，由后端静态托管前端产物）；**4 个内置插件已由代码内注册表静态登记**（`@geewiki/http`、`@geewiki/db-sqlite`、`@geewiki/wiki`、`@geewiki/echo`；其中默认基础层清单只**启用 3 个**——`@geewiki/echo` 已注册未启用，故 `GET /api/plugins` 显示 4 条内置，挂载示例外部插件后为 5 条）；Web 管理台含 `#/wiki`、`#/plugins`、`#/graph` 三个路由；**单元测试 134/134 通过**（`packages/web` 19 + `packages/manager` 91 + `packages/server` 24，逐文件明细见下表 `pnpm test` 行），`pnpm typecheck` 7 个包 0 错误。卸载统一出口已消费 `runtime.drainTimeout`（优雅排空在途 HTTP 请求，超时强制卸载）并在 `requiresCachePurge` 时广播缓存清理事件。
- **插件平台已落地（Phase 3 的四条链路）**：
  - **配置系统（schema 驱动）**：manifest 的 `geewiki.configSchema` 采用 [schemastery](https://github.com/shigma/schemastery) 3.18.0；`GET` / `PUT /api/plugins/:name/config` 提供读写，服务端做校验 + 白名单裁剪 + **原子落盘**（先写 `<文件>.tmp` 再 `rename`）；已激活插件经 `fork.update()` 热更新，失败时把进程内配置与磁盘清单**双向回滚**并返回 409。管理台按 schema 自动生成表单（开关 / 数字 / 文本 / 多行 / 枚举 / 字段组 / 列表；`meta.role: 'password'` 渲染为密码输入框），**未声明 schema 的插件退回 JSON 原文编辑框**（不校验、不裁剪）。
  - **外部插件加载**：启动时扫描 `./plugins/<name>/`（`GEEWIKI_PLUGINS_DIR` 可覆盖），清单取子目录 `package.json` 的 `geewiki` 键（优先）或独立 `geewiki.manifest.json`，与内置插件**并入同一注册表、完全同权**；单个插件的清单缺失 / 入口缺失 / 路径越界 / 重名 / 加载抛错都只记一条 issue 并跳过，不阻断宿主启动；发现期问题经 `GET /api/plugins` 的 `issues` 字段对外可见（`{code,dir,message}`，`code` 为八值枚举）。零依赖示例见 `plugins/hello-geewiki/`。
  - **冲突组替换（顶替交互）**：同 `conflictGroup` 的插件除互斥拦截外，可经 `POST /api/plugins/:name/replace` 顶替：先卸载组内已激活的旧插件（连同它当前活跃的传递依赖方），再热激活目标插件，并把依赖方接回新提供者（`skipDeps` 阻止旧插件被当依赖重新拉起）。**前置校验在三类情形下直接拒绝**（均在产生任何副作用之前，故拒绝路径零残留）：① 旧插件（将被顶替者）的**真实激活层**不是 session → 409 `base_layer`（判据是 `managed.layer`，不是 `layerOf()`；同名条目同时在两层清单的叠加态下它以 base 层激活，属冷操作）；② **卸载集合内任一成员**（旧插件 ∪ 其活跃传递依赖方）的真实激活层不是 session → 409 `base_layer`，响应 `details.plugins` 列出基础层成员（活跃的基础层插件不可热卸载，否则接回时会把它在会话层重新落盘、静默改写其持久化层）；③ 被顶替者自身或任一待接回的依赖方，其 `requires` 里的 token 经 `resolveDependency` 解析后指向被顶替者，而目标无法承接（目标的插件名或 `provides` 均不命中）→ 409 `provider_mismatch`（响应 `details` 带 `plugin` / `token` / `target` / `targetProvides` / `violations`）；目标自身依赖它要顶替的插件同样被拒（`details.tokens`，不自洽）。**对外影响**：依赖方**按具体插件名**依赖被顶替者时替换必然被 409 拒绝——按名的边无法由新插件承接，正解是依赖方改为依赖**服务标识**（`provides` token）；这是刻意取舍（宁可 409，也不返回 200 却留下无人提供的服务）。失败会回滚旧插件与依赖方，并**按调用前的条目顺序与原内容复原会话清单**（文件格式会规范化为 `JSON.stringify(…, null, 2)` + 末尾换行，故人工编辑过的非规范格式不会被逐字节保留）；回滚也失败时返回 500 `replace_rollback_failed`（该路径下整个卸载集合的会话条目都已消失、内存与磁盘一致，需人工介入；仅代码路径 + 人工推演，**无单测覆盖**）。管理台在启用撞上冲突时弹出顶替确认框（列出被顶替者与**当前活跃的**依赖方，并预告"被卸载插件会短暂不可用约几秒"），用户确认后走该端点；若响应 `replaced: null`（无冲突降级）则提示"冲突已解除，已直接启用（未发生替换）"。
  - **前端 Slot（宿主侧插槽 + 后端下发入口表）**：宿主经 `window.__GEEWIKI_HOST__` 暴露 React 单例与 `registerSlot` / `unregisterSlot`，插件 UI bundle 从 `/plugins-ui/<插件名>/<入口文件名>`（默认 `client.js`）动态加载并注册组件；插槽名是白名单，当前**仅 `app-header` 与 `app-footer`**（未知插槽名告警并忽略），插槽外层包 ErrorBoundary——插件组件抛错只丢该插槽，主界面不白屏。**哪些插件的 UI 该加载由后端下发**：插件在清单里声明 `geewiki.client`（`{ entry?, css? }`，均为**单段文件名**，`entry` 缺省 `client.js`；**未声明 `client` 的插件永不进入口表**——注意它与**后端**入口 `geewiki.entry` 不是一回事）。宿主读 `GET /api/plugins/ui`（每请求由"注册表 × 激活集合 × 产物 stat"现算，只列 active ∩ 声明 `client` ∩ 入口实际存在者，`skipped` 记 `inactive` / `no_client` / `entry_missing` / `invalid_name`；带 `no-store` + `ETag`，`If-None-Match` 命中即 **304**，空表仍 200）；前端按整表 `revision` 与逐插件 `rev` 的差集**先卸后装**，并由管理台动作（即时）+ `visibilitychange` + 15s 可见期轮询自动收敛——**UI 随插件启停自动出现/消失**（外部变更 ≤15s）。资产按**双根**解析：`<插件目录>/dist` 优先、`<GEEWIKI_PLUGIN_UI_DIST>/plugins-ui/<名>` 兜底（该变量**缺省 = `GEEWIKI_WEB_DIST`**，故既有部署行为不变）。**边界见下方"已知限制"。**
- **尚未实现 / 已知限制**：Phase 3 余项——LLM / RAG 检索管线、编辑器组插件（Milkdown / TipTap）、插件级静态资源注入（**已部分落地**：插件可自带 UI 产物根 `<插件目录>/dist`，但只覆盖入口与样式两个单段文件名，不支持任意资源目录与子目录资源），以及后端 `ctx.slot(name, component)` 注册链路与 `editor-toolbar-slots` / `admin-page-slots` 扩展点；Phase 4 的 PostgreSQL 适配（`@geewiki/db-pg`，**已裁决延期**）。另有 5 条已知限制：① **Slot 仍无后端注册链路、也无 Suspense + use Hook 懒加载**——不存在 `ctx.slot()`，远端 bundle 仍由加载器显式 `import()`（"不白屏"靠 ErrorBoundary 而非 Suspense Fallback）；且 **ESM 模块实例不回收**——`rev` 变化走 unload → load、同一 URL 命中模块缓存，故**插件产物更新后需整页刷新才生效**；插件 CSS 以 `<link data-plugin-ui=…>` 全局注入、v1 **不做样式隔离**（示例夹具以 `.gw-fixture-*` 前缀命名类名作为约定示范，宿主侧无强制手段），且入口与样式名必须是**单段文件名**，故 `plugins/<name>/dist` 内的**子目录资源（字体/图片等）v1 不支持**（应内联进 bundle）；② 排空粒度是**全站**在途请求，非 owner 级；③ 密码字段的脱敏**只覆盖表单输入框的呈现**——`meta.role: 'password'` 已渲染为 `type="password"` + `autoComplete="new-password"` 输入框，但 `GET /api/plugins/:name/config` 响应体里的 `config` 仍是**明文原值**（config 是普通 JSON 字段，不在传输层做脱敏）；④ 浏览器侧验收脚本 `scripts/acceptance/plugin-ui-cdp.mjs`（零依赖，Node 内置 WebSocket + 直连 CDP）**刻意不接入 `pnpm test`**——它需要 Chrome、一个运行中的实例与已构建的插件产物；且其**实测只在 Chromium 上进行**（import map 的浏览器基线为 Chrome / Edge 89+、Safari 16.4+、Firefox 108+，本项目不提供降级路径）；⑤ `packages/web/tsconfig.json` 的 `types` 同时含 `vite/client` 与 `node`（为让 `test/*.test.ts` 通过类型检查），因此**若在 `packages/web` 的源码里误用 Node API，类型检查不再拦截**。**容器镜像与 Compose 编排已可用**（多阶段 `Dockerfile` + `docker compose up -d --build`，见 [docs/deployment.md](docs/deployment.md)）。详见 [docs/roadmap.md](docs/roadmap.md) 与 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md)。

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

**开发形态**：浏览器打开 **http://localhost:5173** —— Vite dev server 提供前端（热更新），并把 `/api` **与 `/plugins-ui`** 自动代理到后端 `http://127.0.0.1:3000`（`/plugins-ui` 必须代理：插件 UI 资产可能来自 `plugins/<name>/dist`，位于 Vite `publicDir` 之外）；后端自身也在 3000 提供 REST 接口（可用 `http://127.0.0.1:3000/api/health` 探活）。注意 `pnpm dev` 给后端的是 **`GEEWIKI_PLUGIN_UI_DIST=packages/web/public`**（只改内置**插件 UI 资产根**，让插件 UI 免构建可用；dev 下前端由 Vite 直接提供），`GEEWIKI_WEB_DIST` 仍为默认 `packages/web/dist` —— 后端因此照样能提供 app shell（`http://127.0.0.1:3000/`）。`pnpm dev:server` / `pnpm start` 两项都保持默认。

**生产形态**：先 `pnpm build` 生成前端产物 `packages/web/dist`，再由后端在 **http://127.0.0.1:3000** 直接静态托管该产物 —— 即 `pnpm start`（与 `pnpm dev:server` 是同一条命令：**只起后端、不起 Vite**）。该产物目录已被 `.gitignore` 忽略、**不在版本库中**，因此新克隆的仓库必须先执行 `pnpm build`，否则 3000 端口只有后端 API、没有界面。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | **一条命令同时启动**后端（:3000，`GEEWIKI_PLUGIN_UI_DIST=packages/web/public`）与前端 Vite 开发服务器（:5173，`/api` 与 `/plugins-ui` 均代理到 :3000） |
| `pnpm dev:server` | 仅启动后端 → http://127.0.0.1:3000 |
| `pnpm dev:web` | 仅启动前端开发服务器 → http://localhost:5173（需后端已在 :3000 运行） |
| `pnpm build` | 构建全仓产物（`@geewiki/web` → `packages/web/dist`） |
| `pnpm start` | 与 `pnpm dev:server` 同一条命令：**仅启动后端**（不起 Vite）；生产形态下由后端静态托管 `packages/web/dist` → http://127.0.0.1:3000（需先 `pnpm build`） |
| `pnpm typecheck` | 全仓类型检查（`pnpm -r --if-present run typecheck`，7 个包） |
| `pnpm test` | 运行单元测试（`pnpm -r --if-present run test`，实际跑到 `packages/web` / `packages/manager` / `packages/server` 三个包，各自的 `test` 脚本都是 `node --import tsx --test test/*.test.ts`）。**当前 134/134 全绿**：`packages/web` **19**（`pluginUiPlan` 19）+ `packages/manager` **91**（`deps` 10 + `manager` 14 + `config` 36 + `discovery` 13 + `plugin-ui` 15 + `repo-paths` 3）+ `packages/server` **24**（`registry` 3 + `router` 11 + `plugin-ui-static` 10）。契约迁移（`layer` = 持久化层、无 schema 插件接受原始 JSON）已完成，此前 2 条旧断言已随新契约更新（详见 `docs/plugin-platform-plan.md` 第 6 节）。**注意 `packages/web` 自本轮起首次拥有单测**（此前只有 manager / server 两行） |

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | 后端监听端口（优先级：`startServer({ port })` 选项 > 本变量 > 默认值）。注意：前端 dev server 的 `/api` 代理目标在 `packages/web/vite.config.ts:9` 中硬编码为 `http://127.0.0.1:3000`，**改动本变量需同步修改该代理配置**，否则开发形态下前后端断链 |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端监听地址（优先级：`startServer({ host })` 选项 > 本变量 > 默认值）；如需仅本机可访问可设为 `127.0.0.1` |
| `GEEWIKI_DATA_DIR` | `./data` | SQLite 数据库与运行时数据目录（库文件 `geewiki.db`、崩溃标记 `crash.marker`）；**相对路径以仓库根为基准**，绝对路径原样使用 |
| `GEEWIKI_CONFIG_DIR` | `./config` | 插件清单目录（`plugins.base.json` / `plugins.session.json`）；相对路径同样以仓库根为基准 |
| `GEEWIKI_WEB_DIST` | `packages/web/dist` | **前端静态产物根**（app shell 的 `index.html`、`/assets/*`、SPA fallback）；**相对路径一律以仓库根为基准**（与进程工作目录无关，故从任意子目录启动都指向同一份产物），绝对路径原样透传。**注意**：本变量只决定"静态服务用哪个根"，`null` 才是"不启用静态服务"（`ServerOptions.webDist: null`）；留空/未设置时根仍解析为默认的 `packages/web/dist`，**未执行 `pnpm build` 时静态层照常启用、只是请求都 404**（`packages/server/src/index.ts:458-462` 只判 `!root`，不判目录是否存在） |
| `GEEWIKI_PLUGIN_UI_DIST` | 同 `GEEWIKI_WEB_DIST` | **内置插件 UI 资产根**：包含 `plugins-ui/<插件名>/` 的目录，是插件 UI 产物的**第二候选根**（第一候选根是插件自带的 `<插件目录>/dist`）。与 `GEEWIKI_WEB_DIST` **分开配置**——后者供 app shell，本项供插件 UI 资产（dev 下插件 UI 免构建可用，而 app shell 仍走 `packages/web/dist`）。根 `dev` 脚本把它设为 `packages/web/public`；`dev:server` / `start` 保持默认（= `GEEWIKI_WEB_DIST`）。**两个 `null` 语义不同**：`ServerOptions.pluginUiDist: null` = 不用内置根（只看插件自带产物），而 `webDist: null` = 不启用静态服务；环境变量层面留空即等同"未设置 = 回落 `GEEWIKI_WEB_DIST`" |

> 以上相对路径均由 `@geewiki/core` 的 `resolveProjectPath` 以**仓库根**（向上查找 `pnpm-workspace.yaml`）为基准解析，与进程 cwd 无关；启动时 `[@geewiki/http] 静态资源目录: <绝对路径>`（前端产物根）与 `[server] 插件 UI 内置资产根: <绝对路径>` 两条日志可用于核对。

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
- **插件管理器（核心大脑）**：依赖拓扑/环检测、会话层沙箱热启停（显式热授权 + 试用期看门狗 + 熔断）、广义冲突组互斥、迁移控制器、持久化清单合并。卸载走统一出口（`disable` / 启停回滚 / `disposeAll`）：先按 `runtime.drainTimeout` **优雅排空**在途 HTTP 请求（超时告警并强制卸载），卸载后对声明 `requiresCachePurge` 的插件广播**缓存清理事件**。配置**热更新已落地**（schema 校验 + 原子落盘 + `fork.update()` 热重跑，失败双向回滚）；前端 Slot 为**宿主侧插槽 + 后端下发入口表**（`app-header` / `app-footer` 两个白名单插槽 + `window.__GEEWIKI_HOST__` 宿主 SDK；入口表来自 `GET /api/plugins/ui`，UI 随插件启停自动出现/消失）；后端 `ctx.slot()` 注册链路与 `editor-toolbar-slots` / `admin-page-slots` 扩展点仍列 Phase 3（见 roadmap）。
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
React 19 前端（宿主侧 Slot：`app-header` / `app-footer` 两个插槽 + `window.__GEEWIKI_HOST__` 单例宿主；插件 UI 按后端下发的入口表 `GET /api/plugins/ui` 从 `/plugins-ui/<插件名>/<入口文件名>` 加载 / 依赖图可视化）
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
> 另注：插件前端 UI 的产物由 `pnpm --filter @geewiki/web run build:fixtures` 单独生成（**不在 `pnpm build` 内**）——它先 `rm -rf packages/web/public/plugins-ui`（**全清**，避免旧生成物残留导致"入口表说就绪、资产却 404"），再构建两份 bundle：默认 fixture 落 `packages/web/public/plugins-ui/@geewiki/wiki/`，hello 夹具落 **`plugins/hello-geewiki/dist/`**（演示"插件自带产物根"这条链路）。`packages/web/public/plugins-ui/` 已被 `.gitignore` 排除（`.gitignore` 的 `packages/web/public/plugins-ui/` 条），hello 的 `plugins/hello-geewiki/dist/` 同样不入库（由通用 `dist/` 条覆盖），且**旧的静态入口表 `registry.json` 已停用**（入口表改由 `GET /api/plugins/ui` 现算，构建脚本不再生成它）——因此新克隆的仓库需先执行该命令，管理台上才会有示例插件 UI；缺失时宿主不会报错，只是入口表把这些插件记入 `skipped: entry_missing`。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：设计哲学、技术栈选型、分层架构、数据库即互斥插件、插件管理器六大子系统、前端 Slot 插槽（宿主侧插槽 + 后端下发入口表）、Manifest 规范、部署模型 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署：快速开始、镜像构成、目录权限、环境变量、数据备份、生命周期自愈、PostgreSQL profile、升级、排障与验证清单 |
| [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) | 插件平台实施记录：内核实证（cordis / schemastery / ESM）、批次 A–F 方案、契约裁决、已知限制 L-1…L-14、质量基线与验证纪律 |
| [docs/roadmap.md](docs/roadmap.md) | 开发路线图：Phase 0 – Phase 4 的目标、任务清单与验收口径 |

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
