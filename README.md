# GeeWiki

面向团队内部的 AI 原生 Wiki 知识库。

核心哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。
系统默认仅依赖一个 SQLite 数据库即可运行（开箱即用）；插件可热插拔、可替换，**前端界面同样由插件按插槽贡献**。

**当前状态**：Phase 0/1/2 已完成，Phase 3/4 主体落地 —— 配置热更新、外部插件发现、宿主侧插槽与动态扩展点（`F1`）、
路由/导航/页面注册（`F2`）、契约下沉（`F3`）、附件 provider（`F4`）、编辑器等价契约（`F5`）、react-dom/portal（`F6`）、
平台事件契约（`F7`）、Markdown 渲染器注册表（`F8`）、能力注册表（`F9`）、权限清单（`F10`）、路由审计（`F11`）、
健康检查（`F12`）、资源根（`F13`）、apply 超时（`F14`）、主题插件化（`F16`）、向量检索接口（`F18`）、备份恢复（`F20`）、
插件脚手架（`F21`）、插件安装与完整性校验（`F17`）、**i18n 体系（`F15`：宿主与插件共用一套 message catalog）** 均已落地
—— **审计的 F1–F21 至此全部落地**。`F10` 的进程内隔离模式与 `F18` 的检索查询路径接线为**有意后置**（理由见报告各自小节）。
**PostgreSQL 适配（`F19`）已落地并完成真实端到端验证**（PG 15：20 个插件全 active、0 迁移失败，
登录 → 建页 → 读回 → `psql` 落库确认全通）—— `roadmap` 的 `L-9` 原先记它「有意延期」，该条口径已更新。
完整的进度、A/B/C 级阻碍清单与剩余工作见
**[docs/review/plugin-freedom-audit.md](docs/review/plugin-freedom-audit.md)** —— 每一项都标了落地位置与验证判据。

**质量基线（实测）**：`pnpm run typecheck` **27 个项目 + `scripts/`、0 个 `error TS`**；`pnpm test` **2105 例 / 25 个包 / 0 失败**。

> **本 README 只回答「现在是什么、怎么跑起来」。**
> 逐批实现记录（含用户原话、暴露的问题、做法与当时的验证读数）在
> [docs/changelog/implementation-log.md](docs/changelog/implementation-log.md)；
> 历次测试读数台账（含已废弃的旧口径）在 [docs/changelog/test-ledger.md](docs/changelog/test-ledger.md)。
> **找文档先看 [docs/README.md](docs/README.md)** —— 那是一份「我想知道 X，该看哪一篇」的索引。

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
| `pnpm typecheck` | 全仓类型检查（`pnpm -r --no-bail --if-present run typecheck`）。**当前实测：20 个包全部 `Done`、0 个 `error TS`、Exit 0**（取数 `2026-09-15T00:40+08:00`，工作树含未提交改动、HEAD `98b4618`；作用域 `Scope: 20 of 21 workspace projects`，`plugins/hello-geewiki` 无该脚本被 `--if-present` 跳过）。**⚠️ 一条历史瞬态现象（已不可复现，仅存档）**：早前某批在并行写入期取数时，同一命令曾因当时新建的 `packages/plugin-openai/tsconfig.json` 的 `include: ["src","test"]` 里 `test/` 尚不存在而整体失败（`error TS18003: No inputs were found in config file …`），该错误随目录补齐自行消失——**报告读数时须同时给出 HEAD 与取数时刻** |
| `pnpm test` | 运行单元测试（`pnpm -r --no-bail --if-present run test`；各包的 `test` 脚本都是 `node --import tsx --test test/*.test.ts`） |

**当前质量基线（实测）**：`pnpm test` **2105 例 / 25 个包 / 0 失败**；`pnpm run typecheck` **27 个项目 + `scripts/`、0 个 `error TS`**。
取数方式：在仓库根执行 `pnpm test`（汇总打印 `# tests` / `# pass` / `# fail`）与 `pnpm run typecheck`（输出 `error TS` 计数）。

> **为什么这里不再放逐包明细**：本行此前把**历次读数台账**塞进表格单元格，追加到单格约 6900 字节，
> 而格内含未转义的 `|` ⇒ 整行被解析成 5 列、出现在一张 2 列表格里。**它本来就是坏的**，不只是太长。
> 台账已逐字迁到 [docs/changelog/test-ledger.md](docs/changelog/test-ledger.md)。


环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | 后端监听端口（优先级：`startServer({ port })` 选项 > 本变量 > 默认值）。**注意**：前端 dev server 的代理目标**不是**从本变量推导的——它由 `GEEWIKI_DEV_API` 单独指定（见下表），**两者不同步**：改了本变量却不设 `GEEWIKI_DEV_API`，开发形态下前后端就断链 |
| `GEEWIKI_DEV_API` | `http://127.0.0.1:3000` | **仅开发形态**：Vite dev server 把 `/api` 与 `/plugins-ui` 代理到的后端地址（`packages/web/vite.config.ts:10`，不再硬编码）。给隔离端口上的验收脚本用（本项目验收纪律要求不得占用 3000/5173） |
| `GEEWIKI_DEV_PORT` | `5173` | **仅开发形态**：Vite dev server 的监听端口（`packages/web/vite.config.ts:11`）。dev server 显式 `host: '::'`（双栈），以免在某些环境下只绑定 IPv6 回环 |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端监听地址（优先级：`startServer({ host })` 选项 > 本变量 > 默认值）；如需仅本机可访问可设为 `127.0.0.1` |
| `GEEWIKI_DATA_DIR` | `./data` | SQLite 数据库与运行时数据目录（库文件 `geewiki.db`、崩溃标记 `crash.marker`）；**相对路径以仓库根为基准**，绝对路径原样使用 |
| `GEEWIKI_CONFIG_DIR` | `./config` | 插件清单目录（`plugins.base.json` / `plugins.session.json`）与**密钥文件 `secrets.json`**（`role: 'secret'` 字段的落盘位置，0600、已被 `.gitignore` 忽略）；相对路径同样以仓库根为基准 |
| `GEEWIKI_WEB_DIST` | `packages/web/dist` | **前端静态产物根**（app shell 的 `index.html`、`/assets/*`、SPA fallback）；**相对路径一律以仓库根为基准**（与进程工作目录无关，故从任意子目录启动都指向同一份产物），绝对路径原样透传。**注意**：本变量只决定"静态服务用哪个根"，`null` 才是"不启用静态服务"（`ServerOptions.webDist: null`）；留空/未设置时根仍解析为默认的 `packages/web/dist`，**未执行 `pnpm build` 时静态层照常启用、只是请求都 404**（`packages/server/src/index.ts:647` 只判 `!root`，不判目录是否存在） |
| `GEEWIKI_PLUGIN_UI_DIST` | 同 `GEEWIKI_WEB_DIST` | **内置插件 UI 资产根**：包含 `plugins-ui/<插件名>/` 的目录，是插件 UI 产物的**第二候选根**（第一候选根是插件自带的 `<插件目录>/dist`）。与 `GEEWIKI_WEB_DIST` **分开配置**——后者供 app shell，本项供插件 UI 资产（dev 下插件 UI 免构建可用，而 app shell 仍走 `packages/web/dist`）。根 `dev` 脚本把它设为 `packages/web/public`；`dev:server` / `start` 保持默认（= `GEEWIKI_WEB_DIST`）。**两个 `null` 语义不同**：`ServerOptions.pluginUiDist: null` = 不用内置根（只看插件自带产物），而 `webDist: null` = 不启用静态服务；环境变量层面留空即等同"未设置 = 回落 `GEEWIKI_WEB_DIST`" |

> 以上相对路径均由 `@geewiki/core` 的 `resolveProjectPath` 以**仓库根**（向上查找 `pnpm-workspace.yaml`）为基准解析，与进程 cwd 无关；启动时 `[@geewiki/http] 静态资源目录: <绝对路径>`（前端产物根）与 `[server] 插件 UI 内置资产根: <绝对路径>` 两条日志可用于核对。

- 零外部依赖默认配置：数据落在 `data/geewiki.db`（WAL + 自动迁移建表）。
- 界面（hash 路由，共 7 态，见 `packages/web/src/lib/wikiRoute.ts`）：`#/wiki` **知识库主页**（约定 slug `home` 的文章：可编辑/版本历史，见下方三条）· `#/wiki/list` 知识库列表（**内置搜索框**/新建）· `#/wiki/new` 新建 · `#/wiki/<slug>` 详情（**支持分层 slug**，编码为 `%2F`）· `#/wiki/<slug>/edit` 编辑 · `#/wiki/search/<q>` 检索结果（**宿主原生 UI**）· `#/wiki/ask/<q>` 问答（**路由归宿主、面板归插件**——本批起由 `@geewiki/ai-qa` 经 `wiki-ask` 插槽渲染，含 SSE 逐字渲染；没有贡献者时宿主只显示一句中性占位）· `#/plugins` 插件管理（会话层热启停、schema 自动生成的配置表单——无 schema 插件退回 JSON 编辑、应用并持久化、被跳过的 UI 入口分级展示）· `#/graph` 依赖图（React Flow DAG）。另有 `⌘K` / `/` 唤起的**命令面板**（最近访问 + 操作，`components/CommandPalette.tsx`）与**侧边栏页树**（`components/Sidebar.tsx`）。
- **主页 = 一篇约定 slug 为 `home` 的普通文章**（`packages/web/src/lib/wikiRoute.ts` 的 `HOME_SLUG`）：空 hash / `#/` / `#/wiki` 三种写法**都渲染这篇主页**（此前渲染"知识库列表"），`#/wiki/home` 重定向到 `#/wiki`（同一篇内容，避免两个 URL 两种形态）；列表页退居 `#/wiki/list`，入口是左侧栏新增的「全部页面」与命令面板。主页可编辑、有版本历史，并**与其它的页一样受既有页面权限体系管辖**（档位/继承/发布/块级受限段落全部适用）。
- **主页缺失或读不到时按身份分流（两个面板）**（`packages/web/src/pages/WikiPage.tsx`）：有全局 `editContent` ⇒ 「创建主页」引导，创建入口是 **`#/wiki/new?create=home`**（**不是** `#/wiki/home/new`——后者是**合法 slug**，曾被路由劫持）；匿名/无编辑权 ⇒ 中性面板「主页当前不可访问 —— 可能尚未创建，或未对本身份开放」+ 登录/全部页面/重试。创建入口的文案同时提示：**若主页其实已存在、只是没对当前的你开放，保存会覆盖它的正文**，被覆盖的那一版会作为历史快照留在版本历史里。⚠️ 新建页默认 `visibility='org'` 且未发布（`published_at = NULL`），而 `public` 档**必须同时发布**才对匿名可见 ⇒ **经「创建主页」建出来的主页，匿名访客默认看不到**；要公开就走页面的「权限」入口设为公开并打开发布开关。
- ⚠️ **升级影响（无迁移步骤、无提示）**：既有部署若库里**已存在 slug 为 `home` 的页面**，它会**直接成为站点主页**，`#/wiki` 的默认落点随之从"列表"变成它。本批**没有**新增配置项、插件或环境变量，也**没有**"站点设置里换主页"的机制——`home` 是**约定值**（将来可加一层 `homeSlug()` 读点）。
- 插件热操作示例：在「插件管理」启用 `@geewiki/echo` 即时挂载 `GET /api/echo`，停用即摘除；**AI 插件共十个，全部默认启用**（`llm` / `openai` / `ai-tools` / `ai-journal` / `ai-kb` / `ai-summary` / `ai-pages` / `ai-assistant` / `ai-writing` / `ai-nav` / `ai-admin`——按 `config/plugins.base.json` 为准），它们都**在基础层清单里** ⇒ 经管理台停用会返回 409 `base_layer`「请编辑基础层清单后重启」，要停用只能改 `config/plugins.base.json` + 重启（外部插件与会话层插件才是热层）。**P8 已删除 `@geewiki/ai-qa`**（决策 22），旧文里拿它做的 409 `base_layer` 实测例子随之作废，但**结论不变**：基础层插件一律不可热停用（外部插件与会话层插件才是热层）；启用 `@geewiki/editor-plain` 后用纯文本编辑器**替换知识库的默认 CodeMirror 编辑区**（`editor` 插槽的第一个真实消费者），停用即回落到内置编辑器；⚠️ **启用它之后附件上传就没了**——`editor` 是单占用插槽，插件占住后内置编辑器（**唯一**支持拖拽/粘贴上传的编辑器）根本不渲染，而 `EditorSlotProps` 契约里没有上传通道；真机实测的现场是「拖入文件 0 个请求、无提示，浏览器还把窗口导航到了那个文件」。故**出厂配置本就不含它**（`config/plugins.base.json` 本批未改动、`git log` 里也从未收录它，故默认不占用 `editor` 插槽；它只由**运行时会话层**启用——管理台写入被 `.gitignore` 忽略的 `config/plugins.session.json`），并在 `EditorSlotOutlet` 加了兜底（阻止默认拖放 + `role="status"` 可见提示）；**第三方编辑器在补上上传能力前不得默认占用 `editor` 插槽**（理由写在 `packages/server/src/index.ts` 的注册条目注释里）；「应用并持久化」把会话变更合并进 `config/plugins.base.json`（**含各自的 `config` 字段**）。⚠️ **基础层插件（`db-sqlite` / `http` / `wiki` / `search`，以及本批起默认启用的 `@geewiki/ai-qa` / `@geewiki/ai-writing`）与声明 `supportsHotReload: false` 的插件（两个数据库插件）不支持热操作**——停用基础层插件返回 409 `base_layer`（本批实测 `@geewiki/ai-qa`），启用 `@geewiki/postgres` 返回 409 `hot_reload_not_supported`。
- REST 面：`/api/health`（健康/库表/迁移/**长连接计数**）· `/api/plugins*`（含 `/api/plugins/graph`、**`/api/plugins/slots`**、`/api/plugins/ui`、`/api/plugins/:name/{enable,disable,replace,config}`）· `/api/session` + `/api/session/persist` · `/api/pages*`（含 `:slug/{backlinks,links}`）· **`/api/search`（全文检索，默认启用；`mode=phrase|terms`）** · **`/api/ai/turn` + `/api/ai/assistant/capabilities`（AI 助手会话核心，由 `@geewiki/ai-assistant` 提供；SSE 帧为 `status` / `delta` / `tool` / `done` / `error`）** · **`/api/ai/summary` + `/api/ai/summary/search` + `/api/ai/summary/capabilities`（文章摘要，由 `@geewiki/ai-summary` 提供）**。**P8 已删除**：`/api/ai/ask`、`/api/ai/stream`、`/api/ai/capabilities`（随 `@geewiki/ai-qa` 整包删除，实测三个端点现在都是 **404**）与 `/api/ai/assist`（P3 随决策 18 删除）。
- **Docker 部署**：仓库自带多阶段 `Dockerfile` 与 `docker-compose.yml`，容器内以非 root（`node`）运行、数据落在宿主机 `./data`（SQLite）：
  ```bash
  mkdir -p data config plugins && chown -R 1000:1000 data config plugins
  docker compose up -d --build        # → http://localhost:3000
  ```
  镜像已提供并实测（含健康检查、持久化与 SIGTERM 优雅退出）；完整的目录权限、备份、排障与验证清单见 [docs/deployment.md](docs/deployment.md)。本地开发仍推荐 `pnpm dev`。

### 如何接入真实模型（**只在一个地方配置**）

**出厂状态**：**AI 四件套** `@geewiki/llm`（模型接入）、`@geewiki/openai`（OpenAI 兼容协议支持）、`@geewiki/ai-qa`（AI 问答）、`@geewiki/ai-writing`（AI 辅助写作）**已默认启用**；但没有密钥 ⇒ **问答与辅助写作明确不可用**（`503 model_unavailable`，`GET /api/ai/capabilities` 报 `available:false` 并说清缺什么），**不再是"看起来能用"**（旧形态在这里会返回一段抽取式检索摘要冒充答案）。全文检索不受影响，仍开箱可用。接上模型只需要在「插件管理 → **模型接入 `@geewiki/llm`**」里填一次：

| 字段 | 说明（schema 原文见 `packages/plugin-llm/src/index.ts` 的 `LlmConfigSchema`） |
| --- | --- |
| `provider` | **模型服务商**：下拉，选项来自**已启用**的适配器插件（默认已启用 `@geewiki/openai`；装了别的适配器就多一个选项）。留空 = 自动用第一个可用的 |
| `baseUrl` | 端点根地址，如 `https://api.deepseek.com/v1`；留空 = 用该服务商的默认端点 |
| `apiKey` | **写一次、不可回读**：保存后界面与接口都不再回显；留空 = 不修改，填新值 = 替换 |
| `model` | 模型名，如 `deepseek-chat`；**可点「获取模型」直接读端点自己的清单**（`POST /api/llm/models`）后从下拉里选，也可以手填清单外的名字；留空 = 用该服务商的默认模型 |
| `contextWindow` | 模型上下文窗口（token）：决定一次问答最多塞入多少检索正文 |
| `maxOutputTokens` | 单次回答的最长输出（token） |
| `reasoningEffort` | **思考强度**：下拉给 `off` / `low` / `medium` / `high` 四个常用档位，另有「自定义…」可填服务商自己的档位名（如 `minimal`、`extra-high`），**原样**作为上游 `reasoning_effort` 发出；留空或 `off` = **不发**该参数 |
| 高级选项（默认折叠） | `timeoutMs` / `includeUsage` / `extraBody`（网关私有参数透传）/ `apiKeyEnv`（环境变量兜底） |
| **采样温度** | **配置里没有这一项，是刻意的**：任何一层都不再下发 `temperature`，由服务端用它自己的默认值。要覆盖只能在高级项 `extraBody` 里显式写 `"temperature": 0.2` |

**「高级选项」为什么是折叠而不是删掉**：这几项默认值就能用，但它们**必须留在配置顶层**——cordis 会按 schema 裁掉未声明的键，把某项"挪进一个嵌套分组"等于让存量部署里的该项静默失效（症状是"我的环境变量密钥突然不生效了"）。所以分组是**渲染期**的事：schema 上打 `.collapse()` 标记，管理台把它们收进一个 `<details>`，展开照样能改。

**为什么其它插件不用配**：适配器只提供**协议支持**（把统一配置翻译成 `/chat/completions` 请求），自身**没有任何配置项**（`@geewiki/openai` 的 `configSchema` 是零字段 schema，管理台里显示"本插件没有可配置项"）；`@geewiki/ai-kb` 的检索条数、`@geewiki/ai-assistant` 的轮次上限与工具结果长度、`@geewiki/ai-summary` 的摘要长度与去抖窗口等，都是各自功能的"行为调优项"，与模型接入无关且默认值即可用。**旧文这里写的 `@geewiki/ai-qa` 与其 `budget.ts` 上下文预算推导已随 P8 删除**（那个插件整包没了）；现在真正需要"上下文预算"的是 `@geewiki/ai-assistant` 的 `maxHistoryMessages` / `maxToolResultChars` 与 `@geewiki/ai-summary` 的 `maxSourceChars`，三者都各有独立配置项。

**密钥（本批的安全口径）**：
- 值落在 **`config/secrets.json`**：权限 `0600`、**已在 `.gitignore` 里**、不进版本库也不进镜像；
- **绝不写进 `config/plugins.*.json`**（那是入库文件）——管理器在落盘前就把 `role: 'secret'` 字段摘掉；
- **任何 HTTP 响应都不回显**：`GET /api/plugins/:name/config` 只回 `secrets: { apiKey: true }`（"是否已配置"），`config.apiKey` 恒为空；
- 改：只能填新值；删：`PUT` 请求体里带 `clearSecrets: ["apiKey"]`（管理台上是"清除已保存的值"勾选框）；
- 仍可用环境变量兜底：把 `apiKeyEnv` 填成变量名（如 `DEEPSEEK_API_KEY`）并在外部注入，**界面填写的密钥优先**；
- **边界（如实记录）**：`config/secrets.json` 是**明文**文件，威胁模型与同目录的 SQLite 库一致——能读宿主机文件系统的人就能读到密钥。要更强的姿态就走上面那条环境变量路径（编排平台的 secret 注入）。

**REST 等价物**（管理台点完即可，下面给脚本化路径；配置类端点都是 `admin` 级）：

```bash
BASE=http://127.0.0.1:3000
curl -s -X PUT "$BASE/api/plugins/%40geewiki%2Fllm/config" -H 'content-type: application/json' -d '{
  "config": {
    "provider": "openai",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-REPLACE_WITH_YOUR_KEY",
    "model": "deepseek-chat",
    "contextWindow": 128000,
    "maxOutputTokens": 4096,
    "reasoningEffort": "medium"
  }
}'
```

`GET /api/llm/providers` 是配置表单里那个下拉的数据源：列出已启用的适配器、各自的默认端点/模型、当前是否可用、密钥来源（`inline` / `env` / `none`，**只有来源，没有值**），以及思考强度的候选档位（`effortPresets`——清单只有这一个出处，前端不抄一份）。

**配置表单自带的两个探测端点**（都是 `admin` 级 `POST`，管理台上分别是「获取模型」与「测试连接」）：

```bash
# 模型清单：请求体是**表单草稿**，所以改完端点密钥、不必先保存就能挑模型
curl -s -X POST "$BASE/api/llm/models" -H 'content-type: application/json' \
  -d '{"baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-REPLACE"}'
# 连接测试：清单 + 一次最小对话（`max_tokens` 极短），逐步回报
curl -s -X POST "$BASE/api/llm/test" -H 'content-type: application/json' -d '{"model":"deepseek-chat"}'
```

三条口径：① **草稿优先**——参数取"表单当前值 > 已保存配置 > 服务商默认"，`apiKey` 留空表示**用已保存的密钥**（密钥不回显，空串不是"清除"）；② 只有"请求体不是合法 JSON"才返回 4xx，**探测失败一律 `200 + ok:false`**，否则"上游 401"这种有用的诊断会被 HTTP 错误外壳吃掉；③ `ok` 只看**对话**那一步——不少网关不实现 `/models` 却能正常对话，清单失败只作为附带信息给出。所有报错文本（含上游原文，最长 800 字符）都经脱敏 + 屏蔽本次用的密钥字面量后返回。

**网关私有参数**：`extraBody` 是原样并入请求体的 JSON **对象**，用来填各家的私有形态——DeepSeek 的 `{"thinking":{"type":"enabled"}}`、Qwen 的 `{"enable_thinking":true}`；它排在请求体最后，**同名键由它覆盖**。非法 JSON 会让插件**激活失败**并给出可读原因（不静默忽略）。

**验证**：`curl -s "$BASE/api/ai/capabilities"` 里 `providers[].available` 应为 `true`、`credential.source` 不是 `none`；此后 `POST /api/ai/stream` 才会下发 `delta` 帧。

**几条边界**：
- **适配器不再互斥**：`@geewiki/openai` 撤掉了 `conflictGroup: 'llm-provider'`。多个适配器（如将来的 `@geewiki/deepseek`）是**并列的可选服务商**、由 `provider` 字段单选，因此同时启用是正常的，不再 409。
- 把**密钥值本身**填进 `apiKeyEnv` 仍会让激活失败并显式报错（白名单：全大写 + 至少一个下划线），且**报错不回显该值**——`plugins.*.json` 是入库文件，这条路必须继续堵死。
- 适配器**没有配置**这件事是刻意的：同一个模型名写在两个插件里，迟早出现"改了 A 处、B 处还是旧值"。
- **本批实测范围**：在隔离端口 + 本地假上游上实测了完整链路（界面填密钥 → `secrets.json` 以 0600 落盘、清单文件无密钥、`GET /config` 不回显、`providers.available` 变 `true`、辅助写作真实生成且上游收到 `Bearer <key>` / `model` / `max_tokens` / `reasoning_effort: high` / `thinking` 透传字段（**不含 `temperature`**：采样温度已改由服务端决定）、`clearSecrets` 后密钥文件被删除且路由回到不可用）。**真实厂商端点（需要真实付费凭据）仍未实测**。

### 如何用 PostgreSQL

包名是 **`@geewiki/postgres`**（已实现，与 `@geewiki/db-sqlite` 同属互斥的 `database-provider` 冲突组、**默认不启用**）。
切换步骤、两条必须知道的边界（切库后 `/api/search` 与 `/api/ai` 问答不可用；搜索依赖 SQLite 专有的 FTS5）与 Compose `production` profile 见
**[docs/deployment.md](docs/deployment.md) §7**。

## 特性亮点

- **开箱即用**：默认仅依赖一个 SQLite 数据库（better-sqlite3）即可运行，实现 0 外部依赖部署。
- **检索开箱可用；问答需要模型，缺了就明说**：默认部署自带 **SQLite FTS5 全文检索**（`@geewiki/search`，**显式 `trigram` 分词器**解决中文检索，查询 <3 字符时 LIKE 兜底；纯只读增强、不需要任何凭据）。**`@geewiki/ai-qa` 的问答必须有可用模型**：没有 key ⇒ **503 `model_unavailable`**，且 `GET /api/ai/capabilities` 说清缺什么，**不再用抽取式检索摘要冒充答案**（旧承诺「没有 API key 也完整可用」已在问答侧撤销——它交付的是一段「像答案」的检索片段拼接，用户读完才判断得出那不是回答）。**503 = 前置条件不满足（根本没调用模型）／502 = 上游真的失败**，两者现在在界面与日志里分得开。
- **AI 能力不绑定厂商**：`@geewiki/llm` 是 route→provider 的**契约层**（稳定错误码枚举 + 终止 chunk 保证 + **服务绝不重试**），因此可组合多家 provider；密钥可**直接在界面里填**（`role: 'secret'` 写一次、不可回读，值落在 gitignored 的 `config/secrets.json`），也可只写**环境变量名**（`apiKeyEnv`）由运维在环境中提供。**已自带第一个真实 adapter** `@geewiki/openai`（OpenAI 兼容），**与 `@geewiki/llm` / `@geewiki/ai-qa` / `@geewiki/ai-writing` 一起默认启用**（AI 四件套）；接入步骤见上方「如何接入真实模型」。
- **数据库即互斥插件**：系统通过标准 `DatabaseAdapter` 接口抽象数据库层（见 `packages/core`），SQLite ↔ PostgreSQL 以互斥插件（`conflictGroup: 'database-provider'`）方式切换，业务代码零改动。**`@geewiki/postgres` 已实现**（异步适配器，`packages/db-postgres/`；`@geewiki/wiki` 也已适配异步驱动），但**默认不启用**且切库是**冷操作**（两个数据库插件均 `supportsHotReload: false`）——见上方「如何用 PostgreSQL」。⚠️ **PG 下全文检索不可用**（`@geewiki/search` 依赖 SQLite 专有 FTS5，会显式拒绝，见「已知限制」⑬）。
- **插件管理器（核心大脑）**：依赖拓扑/环检测、会话层沙箱热启停（显式热授权 + 试用期看门狗 + 熔断）、广义冲突组互斥、迁移控制器、持久化清单合并。卸载走统一出口（`disable` / 启停回滚 / `disposeAll`）：先按 `runtime.drainTimeout` **优雅排空**在途 HTTP 请求（超时告警并强制卸载），卸载后对声明 `requiresCachePurge` 的插件广播**缓存清理事件**。**长连接（SSE）出口已与排空共存，且真实流式输出已交付**（提交 `2273006` + `@geewiki/ai-qa` 的 `/api/ai/stream`：`trackStream` 登记的长连接**按 owner 分组、不计入在途**，`closeStreams(owner?)` 卸载时定向回收，`noteStatus` 只记指标而不结束响应，teardown 主动收流；**宿主层仍无通用长连接超时**，超时/取消由插件自管，见「已知限制」⑦）。配置**热更新已落地**（schema 校验 + 原子落盘 + `fork.update()` 热重跑，失败双向回滚）；Slot 为**宿主侧插槽 + 后端下发入口表 + 后端注册链路**（白名单插槽现为 **6 个**：`app-header` / `app-footer`（零属性）/ **`editor`**（带数据的单占用）/ **`editor-toolbar`**（多占用，AI 辅助写作的工具条按钮组）/ **`wiki-ask`**（单占用，AI 问答面板）/ **`app-dock`**（单占用，P2a 新增的常驻底部输入条；**归 `ON_DEMAND_SLOTS`**，因为宿主只在已登录时才渲染它）；`window.__GEEWIKI_HOST__` 宿主 SDK；入口表来自 `GET /api/plugins/ui`，UI 随插件启停自动出现/消失；插件另可经 `ctx.get('slot')` 做运行期 `contribute`）；`admin-page-slots` 仍列 Phase 3（见 roadmap）；`editor-toolbar-slots` 这个候选名已由本批的 `editor-toolbar` 落地取代。
- **管理面可视化**：React 19 管理台 —— 插件状态/层/热能力一览、会话层热操作、依赖图（React Flow DAG）、Wiki 页面编辑与版本历史。
- **编辑体验：两模式编辑器 + 排版工具栏，权限随正文一起改**：编辑页是**单栏**（原先与编辑区并排的预览面板已去掉），要看成品效果用「按访客视角预览」**对话框** —— 它渲染的是**真的**投影后 HTML（含可见性判定与视角切换），与编辑器的就地渲染不是一回事。编辑器有**源码**与**实时渲染**两种模式（Typora 式就地渲染：隐藏 `#` / `**` / `[]()` 等行内标记、把图片画出来，**光标所在的段落保持 Markdown 源码**），选择记在 localStorage 的 `gw.editor-mode.v1`（默认 `live`，见 `packages/web/src/lib/editorModePlan.ts`）；编辑区上方是**排版工具栏**（加粗/标题/列表/表格/链接等 15 个动作 + 撤销/重做 + 附件上传 + 段落权限锁按钮），格式动作是 `packages/web/src/lib/markdownActions.ts` 的纯函数，CodeMirror 路径与降级 `<textarea>` 共用。**段落级阅读权限就在编辑器里改**：工具栏的锁按钮改写正文里的 `<!--gated:org-->` / `<!--gated:granted-->` 标记（`packages/web/src/lib/editorBlocks.ts`），**没有新端点** —— 服务端保存时重新解析（`packages/plugin-wiki/src/blocks.ts`），与正文同一条保存路径、同一份版本历史。锁菜单里还有**「授权给谁…」**：为光标所在那一段增删**例外授予**（`packages/web/src/components/access/BlockGrantsDialog.tsx` + `BlockGrantEditor.tsx`，后者与只读的块总览共用一份实现）—— 段落设成「需单独授权」后，这是**唯一**能指定谁读得到它的地方（否则那一档就是"设得出来、没人能看"的死档）；块 id 只有保存正文时才生成，故未保存的段落会提示先保存正文再继续授权。授权对象是**账号 id**（`users.id`）或**用户组 id**（`groups.id`）；**任何登录用户都能读成员/用户组名单**（`GET /api/org/members|groups` 为 `access: 'user'`），所以编辑者直接**从成员下拉里选**（`packages/web/src/lib/subjectDirectory.ts` 仍保留"无权限⇒手填 / 读取失败⇒如实报错"两条退路）；读名单放宽，**写**（成员角色、邀请、建组与组成员增删）仍只有管理员。页面档位、例外授予与访问申请都在**页面自己的**「权限」对话框里（阅读页右上角，**不带省略号**）；对话框**不含块级分区**（段落档位在编辑器里改）。原独立的「权限治理」页**已从导航移除**（`packages/web/src/App.tsx` 的 `LEGACY_ROUTES`），`#/access/<slug>` 仍可用但**重定向**到 `#/wiki/<slug>?access=1`（同一个「权限」对话框 —— 它对**所有有 `manageVisibility` 的人**可用，包括没有正文编辑权的人）。

## 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 后端内核 | [Cordis](https://github.com/cordiverse/cordis) `cordis@^4.0.0-rc.10` | 依赖注入、事件总线与插件生命周期管理。当前实际安装 `4.0.0-rc.10`（npm `latest` 标签即指向该 RC；3.x 稳定线止于 `3.18.1`，本项目未采用） |
| 开发语言 | TypeScript（Node.js 环境） | — |
| 前端框架 | React 19+ | 管理台基座；插件 UI 经宿主 SDK（`window.__GEEWIKI_HOST__` 暴露 React 单例）+ 插槽注册接入（**当前未用 Suspense / use Hook 做远端 Bundle 懒加载**，见 [docs/architecture.md](docs/architecture.md) §6） |
| 默认数据库 | better-sqlite3 | 零外部依赖，开箱即用 |
| 全文检索 | SQLite **FTS5**（由 better-sqlite3 内置提供）+ **`trigram`** 分词器 | `better-sqlite3@13.0.3` 的**预编译包已含 FTS5**（`compile_options` 有 `ENABLE_FTS5`，内置 SQLite **3.53.4**，实测可直接建 `tokenize='trigram'` 表）⇒ **无需 node-gyp**。显式选 `trigram` 是中文可检索的前提：FTS5 默认的 `unicode61` 把**连续 CJK 当成一个 token**，`MATCH '"知识库"'` 实测 **0 命中**。`trigram` 的硬缺口——查询串 **<3 字符**时 `MATCH` 恒空（中文 2 字词如「检索」）——由插件层的 **LIKE 兜底**覆盖（走 `pages` 真源表，故索引缺失时短查询仍正确）。代价：索引体积与正文**同量级**（自测 5000 行 / 正文 6.23 MB → 索引 +7.07 MB ≈ 1.14×） |
| LLM 接入 | 自研契约层 `@geewiki/llm`（**不绑定厂商**）+ 自带 adapter `@geewiki/openai` | `llm-service` 是 route→provider **注册表**（多 provider 可共存，故不进任何 `conflictGroup`）；**已自带第一个真实 adapter**（OpenAI 兼容，`packages/plugin-openai/`，声明 `conflictGroup: 'llm-provider'` 保证厂商间互斥），且**已默认启用**（在基础层清单里）但仍需外部凭据，故**开箱状态下无可用 provider ⇒ 问答与辅助写作明确不可用（503）**，不再有 `retrieval-only` 这条冒充答案的路。契约核心是**稳定错误码枚举** + **终止 chunk 恰一次且在末位** + **绝不重试**；密钥由界面填写（写一次、不可回读，落 `config/secrets.json`）或只写环境变量名（`apiKeyEnv`）由运维提供 |
| AI 助手（会话） | `@geewiki/ai-assistant`（**默认启用**，显示名「AI 助手」） | 常驻底部输入条（`app-dock` 插槽）→ 智能体循环 → SSE 逐帧。**必须有可用模型**：没有 key ⇒ **503 `model_unavailable`**；**必需工具集缺席 ⇒ 503 `tools_unavailable`**（不偷偷降级成通用聊天机器人）。端点 `POST /api/ai/turn`、`GET /api/ai/assistant/capabilities`（帧 `status` / `delta` / `tool` / `done` / `error`；前置判定全部在写 SSE 头之前以普通 JSON 返回）。**P8 已删除**：旧的 `/api/ai/ask` + `/api/ai/stream` + `/api/ai/capabilities` 三个端点与整个 `@geewiki/ai-qa` 包（决策 22），其检索能力由 `@geewiki/ai-kb` 的三条工具接走 |
| 辅助写作 | `@geewiki/ai-writing`（**默认启用**，显示名「AI 辅助写作」；由原 `@geewiki/ai` 改名让出问答） | `POST /api/ai/assist`（改写 / 润色 / 摘要 / 续写）+ 本批新增 `GET /api/ai/assist/capabilities`。**红线：进模型的正文只来自请求体**（`ASSIST_TEXT_MAX=4000`），`slug` **只**用于编辑权判定（`policy-service` 缺失 ⇒ **失败关闭 403**，且**权限判定先于降级判定**，否则"降级"成了一条权限探测通道）；全路径不读库。失败语义与问答同一口径（503 前置 / 502 上游），**上游正常结束但零字符也算失败**（502 + `PROVIDER_ERROR`，绝不 200 + 空文本冒充生成结果）；界面侧「先预览、确认才写回」，写回走宿主 `insertAtCursor` 回调 |
| 生产数据库 | PostgreSQL（`pg` 驱动，`@geewiki/postgres`） | **已实现**（异步适配器 + schema 化配置 + 自有迁移，15 例单测），与 SQLite 同属 `database-provider` 冲突组互斥；**默认不启用**，切库为**冷操作**（两者均 `supportsHotReload: false`，须改 `config/plugins.base.json` 后重启）。**⚠️ PG 下 `@geewiki/search` 不可用**（依赖 SQLite 专有 FTS5）；本批未做真实 PG 端到端验证 |
| 容器编排 | Docker Compose（Profiles 模式） | 多阶段 `Dockerfile` + `docker compose up -d --build` 已可用（非 root 运行、SQLite 持久化到 `./data`）；`--profile production` 预留 Postgres 服务，默认不启动，详见 [docs/deployment.md](docs/deployment.md) |

**内核版本事实（cordis，2026-09 核实）**：仓库 6 个包（core / db-sqlite / manager / server / plugin-wiki / plugin-echo）统一声明 `"cordis": "^4.0.0-rc.10"`，`pnpm-lock.yaml` 解析并安装 `cordis@4.0.0-rc.10`。npm `dist-tags` 为 `latest = 4.0.0-rc.10`、`next = 4.0.0-beta.5`（即 `pnpm add cordis` 装到的就是该 RC），3.x 序列的最后一个版本是 `3.18.1`。该包本身未声明 `engines` 字段，本项目在 Node 22.23.2 上实测通过（typecheck + 测试 + 运行）。`^4.0.0-rc.10` 按 semver 语义覆盖 `4.0.0` 正式版及其后 4.x，正式版发布后 `pnpm update cordis` 即可升级。另需注意 4.x 的类型发布缺口：`lib/index.d.ts` 的 `export *` 链使 `Context` 的 `provide/get/plugin` 等方法在外部消费时不被解析，本仓库由 `packages/core/src/cordis-env.ts` 的自包含模块增强补齐（详见该文件头注释）。

## 架构总览

分层架构如下（完整设计见 [docs/architecture.md](docs/architecture.md)）：

```
React 19 前端（宿主侧 Slot：`app-header` / `app-footer`（零属性）、`editor`（带数据、单占用）、`editor-toolbar`（多占用）、`wiki-ask`（单占用）**五个白名单插槽** + `window.__GEEWIKI_HOST__` 单例宿主；插件 UI 按后端下发的入口表 `GET /api/plugins/ui` 从 `/plugins-ui/<插件名>/<入口相对路径>` 加载（支持子目录资产，MIME + 缓存分级）/ 依赖图可视化 / wiki 内**宿主原生的检索界面** `#/wiki/search/<q>`（**问答界面已迁出宿主**：路由 `#/wiki/ask/<q>` 仍在，面板由 `@geewiki/ai-qa` 插入，见上方「AI 界面改由插件贡献」））
        │
        │  REST API（HTTP；当前无 WebSocket 通道；SSE 长连接**出口机制已就绪且已接线**，见 docs/architecture.md §5.1.1）
        ▼
Plugin Manager（核心大脑）：热加载引擎、依赖图/冲突组、会话层沙箱机制、迁移控制器、看门狗探针、配置热管理中心、插槽贡献注册表（`ctx.get('slot')`）
        │
        │  服务抽象层 (DI)
        ▼
插件生态（按冲突组划分）：[数据库组: @geewiki/db-sqlite ↔ @geewiki/postgres（已实现，默认不启用，冷切换）] [编辑器组: `editor` 插槽 —— 内置 @geewiki/editor-plain 已接入（**默认不启用**：它会顶掉唯一支持附件上传的内置编辑器，见上）， Milkdown / TipTap 等第三方编辑器仍未做]
        +
AI 层（**不进任何冲突组**，可自由组合）：@geewiki/search（FTS5 + trigram 检索，默认启用）
        → @geewiki/ai-qa（AI 问答：检索 → 模型作答带 [n] 引用 → SSE；无可用模型即明确 503 不可用）
        → @geewiki/ai-writing（AI 辅助写作：上下文只来自请求体、slug 仅用于编辑权判定；无模型即 503）
        → @geewiki/llm（契约层：route→provider 注册表 + 降级词汇/脱敏的唯一归属）
        → @geewiki/openai（OpenAI 兼容 adapter，第一个真实 provider，默认不启用，与其它 adapter 同属 `llm-provider` 冲突组）
```

## 仓库结构

```
geewiki/
├── packages/         # 共 13 个包（`ls -d packages/*/`）
│   ├── core/         # 内核类型与常量：Manifest 规范、DatabaseAdapter 接口、SlotService/EditorSlotProps、cordis 类型增强
│   ├── db-sqlite/    # 默认数据库插件 @geewiki/db-sqlite（better-sqlite3 + SQL 迁移）
│   ├── db-postgres/  # PostgreSQL 插件 @geewiki/postgres（异步适配器 + 自有迁移 + schema 化连接配置，默认不启用、冷切换）
│   ├── manager/      # 插件管理器 @geewiki/manager：依赖图/冲突组/会话层沙箱/迁移控制器/看门狗/插槽注册表（SlotRegistry）
│   ├── server/       # 应用宿主 @geewiki/server：http 服务、静态文件服务（含 /plugins-ui 子目录资产）、内置插件注册表
│   ├── web/          # React 19 管理台 @geewiki/web（Vite 6，7 态 wiki 路由 + #/plugins + #/graph + 命令面板；fixtures/ 为 Slot 验证用示例插件 UI）
│   ├── plugin-wiki/  # Wiki 业务插件 @geewiki/wiki：页面 CRUD（支持分层 slug）+ 版本历史 + 反向链接 + wiki-service 服务
│   ├── plugin-search/# 全文检索插件 @geewiki/search：FTS5(trigram) 索引 + 短语/词元两种模式 + 短词 LIKE 兜底（migrations/0001_search.sql）
│   ├── plugin-llm/   # LLM 契约插件 @geewiki/llm：route→provider 注册表 + 终止保证 + **降级词汇与可用性投影**（`DegradedReason` / `makeDegraded` / `hasAvailableModel`）+ 密钥脱敏（**不含厂商 adapter**）
│   ├── plugin-openai/# OpenAI 兼容 adapter @geewiki/openai：向 llm-service 注册一条真实路由（默认不启用，需外部凭据）
│   ├── plugin-ai-assistant/ # AI 助手会话核心 @geewiki/ai-assistant：agent loop + 系统提示 + 预算（**不含检索逻辑**，检索是 ai-kb 贡献的工具）；自带 `app-dock` 输入条界面（原 `plugin-ai-qa` 已于 P8 整包删除）
│   ├── plugin-ai-writing/ # AI 辅助写作 @geewiki/ai-writing：改写/润色/摘要/续写，上下文只来自请求体；自带 `editor-toolbar` 工具条
│   ├── plugin-editor-plain/ # 纯文本编辑器插件 @geewiki/editor-plain：`editor` 插槽的第一个真实消费者（`slots: ['editor']`）；**默认不启用**（插槽契约无上传通道，启用即失去附件拖拽/粘贴上传）
│   └── plugin-echo/  # 示例插件 @geewiki/echo：热插拔演示（GET /api/echo）
├── config/           # 插件清单：plugins.base.json（默认启用 db-sqlite / http / wiki / search）/ plugins.session.json（运行时改写、不入库）
├── data/             # SQLite 数据库与运行时数据（已在 .gitignore 中排除）
├── docs/
│   ├── architecture.md          # 系统设计文档
│   ├── deployment.md            # Docker 部署指南（镜像构成、目录权限、备份、排障、验证清单）
│   ├── plugin-platform-plan.md  # 插件平台批次方案与内核实证（配置/外部插件/Slot 的落地记录与已知限制）
│   └── roadmap.md               # 开发路线图（Phase 0 – Phase 4）
├── plugins/          # 外部插件目录：<name>/ 一个子目录一个插件，启动时自动发现
│   ├── hello-geewiki/  # 零依赖示例（清单即 package.json 的 geewiki 键；自带前端产物根 dist/）
│   └── ui-demo/        # 插槽/资产演示（dist/ 由 build:fixtures 生成）
├── scripts/acceptance/plugin-ui-cdp.mjs  # 浏览器侧端到端验收（零依赖，直连 CDP，刻意不入 pnpm test）
├── scripts/acceptance/ai-split-e2e/  # AI 拆分验收：run.mjs 后端契约（503/502、SSE 帧、提示词、密钥）+ cdp-ui.mjs 浏览器侧 19 条（真 Chrome + CDP）+ 共享确定性假上游
├── scripts/acceptance/theme-header-cdp.mjs  # 顶栏跟随主题的验收：四态底色 + WCAG 对比度 + 代码块恒深（同上不入 pnpm test）
├── Dockerfile             # 多阶段生产镜像（builder + runtime，非 root 运行）
├── .dockerignore
├── docker-compose.yml     # Compose 编排（默认 SQLite；--profile production 预留 Postgres）
├── LICENSE
└── README.md
```

> 说明：内置插件共 **24 个**（**P8 读数**：`grep -c "source: 'builtin'" packages/server/src/index.ts` = 24，由代码内注册表 `defaultRegistry()` 静态登记），**默认基础层清单启用 21 条**（`db-sqlite` / `http` / `auth` / `org` / `authz` / `wiki` / `search` + **十一个 AI 插件** `llm` / `openai` / `ai-tools` / `ai-journal` / `ai-kb` / `ai-summary` / `ai-pages` / `ai-assistant` / `ai-writing` / `ai-nav` / `ai-admin`），其余（`postgres` / `echo` / `editor-plain` / `oidc`）**已注册但未启用**（在管理台按需启用；其中 `postgres` 是冷操作、须改基础层清单后重启）。**P8 实测**（隔离实例 `GEEWIKI_PORT=3931` + `data/verify/p8-teardown`，`pluginsDir: null` 故不含外部插件）：`GET /api/plugins` 返回 **22 条内置**，`issues` **0 条**，`state:'active'` **18 条**，`inactive` 四条：`echo` / `editor-plain` / `oidc` / `postgres`；`GET /api/plugins/ui` 的 `plugins` **恰两键**（`@geewiki/ai-assistant: ['app-dock']`、`@geewiki/ai-summary: ['article-summary']`）；`GET /api/plugins/slots` 恰两条且 **`wiki-ask` 已不在表里**。**旧读数「15 条内置 / 启用 11 条 / active 11 条」属于 AI 插件化重构之前的口径**（`@geewiki/ai-qa` 已于 P8 整包删除）。**`plugins/` 目录下的外部插件已在宿主启动时自动发现并并入同一注册表**（清单取子目录 `package.json` 的 `geewiki` 键或独立 `geewiki.manifest.json`，见 [docs/architecture.md](docs/architecture.md) §5.8）。
>
> 另注：插件前端 UI 的产物由 `pnpm --filter @geewiki/web run build:fixtures` 单独生成（**不在 `pnpm build` 内**）——它先 `rm -rf packages/web/public/plugins-ui`（**全清**，避免旧生成物残留导致"入口表说就绪、资产却 404"），再构建**三份** bundle：默认 fixture 落 **`plugins/ui-demo/dist/`**、hello 夹具落 **`plugins/hello-geewiki/dist/`**（两者都演示"插件自带产物根"这条链路）、editor 夹具落 **`packages/web/public/plugins-ui/@geewiki/editor-plain/`**（演示内置插件的第二候选根）。`packages/web/public/plugins-ui/` 已被 `.gitignore` 排除（`.gitignore` 的 `packages/web/public/plugins-ui/` 条），两份 `plugins/<名>/dist/` 同样不入库（由通用 `dist/` 条覆盖），且**旧的静态入口表 `registry.json` 已停用**（入口表改由 `GET /api/plugins/ui` 现算，构建脚本不再生成它）——因此新克隆的仓库需先执行该命令，管理台上才会有示例插件 UI；缺失时宿主不会报错，只是入口表把这些插件记入 `skipped: entry_missing`。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：设计哲学、技术栈选型、分层架构、数据库即互斥插件、插件管理器六大子系统、前端 Slot 插槽（宿主侧插槽 + 后端下发入口表）、Manifest 规范、部署模型 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署：快速开始、镜像构成、目录权限、环境变量、数据备份、生命周期自愈、PostgreSQL profile、升级、排障与验证清单 |
| [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md) | 插件平台实施记录：内核实证（cordis / schemastery / ESM / **SQLite FTS5 与中文分词**）、批次 A–G 方案、契约裁决、已知限制 L-1…L-20、质量基线与验证纪律 |
| [docs/roadmap.md](docs/roadmap.md) | 开发路线图：Phase 0 – Phase 4 的目标、任务清单与验收口径 |
| [docs/README.md](docs/README.md) | **文档索引（结论优先）**：「我想知道 X，该看哪一篇」 |
| [docs/review/plugin-freedom-audit.md](docs/review/plugin-freedom-audit.md) | 平台自由度审计与整改：A/B/C 级阻碍、F1–F21 落地位置、每项的判据与验证读数、§4 优化点 |
| [docs/changelog/](docs/changelog/) | 历史记录：逐批实现台账（`implementation-log.md`）与测试读数台账（`test-ledger.md`） |

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
