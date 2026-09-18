# GeeWiki

**面向团队内部的 AI 原生 Wiki 知识库。**

> 设计哲学：**万物皆插件，积木式搭建** —— 极致轻量、高可扩展、安全可控。

GeeWiki 默认只依赖一个 SQLite 数据库即可完整运行，不需要任何外部服务；全文检索开箱可用。
数据库、编辑器、AI 能力、访问控制乃至**前端界面**都由插件提供，插件可热插拔、可整组替换。

---

## 核心特性

- **零外部依赖启动** —— 默认落一个 SQLite 文件（`better-sqlite3`，WAL 模式，启动自动迁移建表）。
- **中文全文检索开箱可用** —— SQLite FTS5 + 显式 `trigram` 分词器；查询串 <3 字符时由 LIKE 兜底，
  纯只读增强，不需要任何凭据。
- **AI 能力不绑定厂商** —— `@geewiki/llm` 是 route→provider 的契约层（稳定错误码枚举、终止 chunk
  恰一次、绝不重试），厂商适配器只是并列的可选 provider。已自带 OpenAI 兼容适配器 `@geewiki/openai`。
- **失败语义诚实** —— **503 = 前置条件不满足（根本没调用模型）**，**502 = 上游真的失败（调用了它）**；
  「上游正常结束但零字符」也判失败，绝不用空文本或检索片段冒充生成结果。
- **数据库即互斥插件** —— 业务代码只依赖 `DatabaseAdapter` 接口，SQLite ↔ PostgreSQL 以
  `conflictGroup: 'database-provider'` 互斥切换，业务层零改动。
- **插件热插拔** —— 依赖拓扑与环检测、广义冲突组互斥、会话层沙箱热启停（显式热授权 + 试用期
  看门狗 + 熔断）、卸载时优雅排空在途请求。
- **前端界面由插件贡献** —— 宿主只提供插槽与入口表，插件自带 UI 产物；停用插件，界面随之消失。
- **段落级阅读权限** —— 正文里用 `<!--gated:org-->` 之类的标记声明段落档位，与正文同一条保存
  路径、同一份版本历史，并可为单段增删例外授权。
- **访问控制与 SSO** —— 页面/块两级可见性、继承与冲突裁决、OIDC 身份接入、公开门户与 sitemap。

## 快速开始

环境要求：**Node ≥ 22**、**pnpm 11.x**（见根 `package.json` 的 `engines` 与 `packageManager`）。

```bash
pnpm install   # 安装依赖（含 better-sqlite3 预编译二进制）
pnpm dev       # 同时启动后端（:3000）与前端开发服务器（:5173）
```

浏览器打开 <http://localhost:5173>。

首次进入时会跳到 **`#/setup`** 引导创建第一个账号（页面自身的守卫：已有账号时
`POST /api/auth/setup` 返回 `409 setup_already_done`）。

> **`pnpm dev` 必须在仓库根目录执行**：该脚本同时拉起后端与前端。若在 `packages/web`
> 下执行 `pnpm dev`，只会启动 Vite 而不启动后端，`/api` 代理必然失败。
>
> **Windows 用户**：根 `dev` 脚本使用 POSIX shell 语法（`&`、`$!`、`kill`），请在两个终端
> 分别运行 `pnpm dev:server` 与 `pnpm dev:web`。

**开发形态**：Vite dev server（:5173）提供前端并热更新，把 `/api` 与 `/plugins-ui` 代理到后端
`http://127.0.0.1:3000`。`/plugins-ui` 必须走代理——插件 UI 资产可能来自 `plugins/<name>/dist`，
位于 Vite `publicDir` 之外。

**生产形态**：`pnpm build` 生成前端产物 `packages/web/dist`，再由后端在 <http://127.0.0.1:3000>
静态托管（`pnpm start`）。产物目录已被 `.gitignore` 忽略，因此新克隆的仓库**必须先 `pnpm build`**，
否则 3000 端口只有 API、没有界面。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 同时启动后端（:3000）与前端 dev server（:5173） |
| `pnpm dev:server` | 仅启动后端 → <http://127.0.0.1:3000> |
| `pnpm dev:web` | 仅启动前端 dev server → <http://localhost:5173> |
| `pnpm build` | 构建全仓产物（`@geewiki/web` → `packages/web/dist`） |
| `pnpm start` | 仅启动后端并由它静态托管 `packages/web/dist`（需先 `pnpm build`） |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 运行单元测试（`node --import tsx --test test/*.test.ts`） |
| `pnpm run new:plugin <名字>` | 生成一个插件脚手架 |
| `pnpm run backup` / `pnpm run restore` | 数据备份 / 恢复 |
| `pnpm run install-plugin` | 安装外部插件 |
| `pnpm run clean:tmp` | 清理临时目录 |

### 质量基线

在仓库根目录执行，读数可自行复核：

```bash
pnpm test        # 汇总打印 # tests / # pass / # fail
pnpm typecheck   # 输出 error TS 计数
```

**当前实测**：`pnpm test` **2241 例 / 26 个包 / 0 失败**；`pnpm typecheck` **0 个 `error TS`**。
读数会随提交变化，**引用时请同时给出取数时刻与 HEAD**。

## 配置

### 接入模型

出厂状态下 **AI 插件已默认启用，但没有密钥** —— 因此 AI 相关功能会**明确报不可用**，
而不是"看起来能用"。接上模型只需要在一处配置：

**插件管理 → 模型接入 `@geewiki/llm`**

| 字段 | 说明 |
| --- | --- |
| `provider` | 模型服务商。选项来自**已启用**的适配器插件；留空 = 自动取第一个可用的 |
| `baseUrl` | 端点根地址，如 `https://api.deepseek.com/v1`；留空 = 用服务商默认端点 |
| `apiKey` | **写一次、不可回读**。保存后界面与接口都不再回显；留空 = 不修改，填新值 = 替换 |
| `model` | 模型名。可点「获取模型」读端点自己的清单（`POST /api/llm/models`）后从下拉选，也可手填 |
| `contextWindow` | 模型上下文窗口（token），决定一次问答最多塞入多少正文 |
| `maxOutputTokens` | 单次回答的最长输出（token） |
| `reasoningEffort` | 思考强度。下拉给 `off` / `low` / `medium` / `high`，另有「自定义…」；留空或 `off` = 不发该参数 |
| 高级选项（默认折叠） | `timeoutMs` / `includeUsage` / `extraBody` / `apiKeyEnv` |

采样温度**刻意不提供配置项**：任何一层都不再下发 `temperature`，由服务端用自己的默认值。
要覆盖只能在高级项 `extraBody` 里显式写 `"temperature": 0.2`。

**密钥的处理口径**：

- 值落在 `config/secrets.json`，权限 `0600`，已在 `.gitignore` 中，不进版本库也不进镜像；
- **绝不写进 `config/plugins.*.json`**（那是入库文件）——管理器在落盘前就摘掉 `role: 'secret'` 字段；
- **任何 HTTP 响应都不回显**：`GET /api/plugins/:name/config` 只回 `secrets: { apiKey: true }`
  表示"是否已配置"，`config.apiKey` 恒为空；
- 清除：`PUT` 请求体里带 `clearSecrets: ["apiKey"]`；
- 也可用环境变量兜底：把 `apiKeyEnv` 填成变量名（如 `DEEPSEEK_API_KEY`）由外部注入；
  **界面填写的密钥优先**。

> **边界（如实记录）**：`config/secrets.json` 是**明文**文件，威胁模型与同目录的 SQLite 库一致——
> 能读宿主机文件系统的人就能读到密钥。需要更强姿态就走环境变量注入路径。

配置类端点都是 `admin` 级，等价于管理台操作的脚本化路径：

```bash
BASE=http://127.0.0.1:3000
curl -s -X PUT "$BASE/api/plugins/%40geewiki%2Fllm/config" \
  -H 'content-type: application/json' -d '{
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

两个探测端点（均为 `admin` 级 `POST`，请求体是**表单草稿**，因此改完端点密钥不必先保存）：

```bash
curl -s -X POST "$BASE/api/llm/models" -H 'content-type: application/json' \
  -d '{"baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-REPLACE"}'
curl -s -X POST "$BASE/api/llm/test" -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat"}'
```

三条口径：① **草稿优先**（表单当前值 > 已保存配置 > 服务商默认；`apiKey` 留空表示用已保存的密钥）；
② 只有"请求体不是合法 JSON"才返回 4xx，**探测失败一律 `200 + ok:false`**，否则上游 401 这类
有用诊断会被 HTTP 错误外壳吃掉；③ `ok` 只看**对话**那一步——不少网关不实现 `/models` 却能正常对话。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | 后端监听端口 |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端监听地址；仅本机可访问可设 `127.0.0.1` |
| `GEEWIKI_DEV_API` | `http://127.0.0.1:3000` | **仅开发形态**：Vite 把 `/api`、`/plugins-ui` 代理到的后端地址 |
| `GEEWIKI_DEV_PORT` | `5173` | **仅开发形态**：Vite dev server 监听端口 |
| `GEEWIKI_DATA_DIR` | `./data` | SQLite 数据库与运行时数据目录 |
| `GEEWIKI_CONFIG_DIR` | `./config` | 插件清单与密钥文件 `secrets.json` 所在目录 |
| `GEEWIKI_WEB_DIST` | `packages/web/dist` | 前端静态产物根（app shell、`/assets/*`、SPA fallback） |
| `GEEWIKI_PLUGIN_UI_DIST` | 同 `GEEWIKI_WEB_DIST` | **内置插件 UI 资产根**，即含 `plugins-ui/<插件名>/` 的目录 |
| `GEEWIKI_PLUGINS_DIR` | `./plugins` | **外部插件目录**，启动时扫描其中的子目录；设为 `null`（选项层）则完全不启用外部插件发现 |
| `GEEWIKI_OIDC_TICKET_SECRET` | 未设置 | OIDC 票据签名密钥。**未配置则每进程随机** —— 多实例部署或重启后既有票据失效 |

**所有相对路径一律以仓库根为基准**，与进程工作目录无关（`@geewiki/core` 的 `resolveProjectPath`
向上查找 `pnpm-workspace.yaml` 定位仓库根），因此后端从任意目录启动都指向同一份数据与配置。

`GEEWIKI_PORT` 与 `GEEWIKI_DEV_API` **不同步**：改了前者却不设后者，开发形态下前后端就断链。

两个 `null` 语义不同：`webDist: null` = 不启用静态服务；`pluginUiDist: null` = 不用内置资产根
（只看插件自带产物）。环境变量留空即等同"未设置 = 回落 `GEEWIKI_WEB_DIST`"。

### 使用 PostgreSQL

包名是 **`@geewiki/postgres`**，与 `@geewiki/db-sqlite` 同属互斥的 `database-provider` 冲突组，
**默认不启用**，且切换是**冷操作**（两者都声明 `supportsHotReload: false`，须改
`config/plugins.base.json` 后重启）。

> ⚠️ **切换到 PostgreSQL 后全文检索不可用**：`@geewiki/search` 依赖 SQLite 专有的 FTS5，
> 它会显式拒绝而不是静默退化。

切换步骤、Compose `production` profile 与两条必须知道的边界见 [docs/deployment.md](docs/deployment.md)。

**验证状态**：PostgreSQL 适配已完成过一次**真实 PG 15 端到端验证** —— `db-postgres` 的 13 个迁移
全部应用、迁移失败 0、插件 20 active / 0 error，`setup` 201 → `login` 200 → 建页 200 → 读回正文
逐字一致 → `psql` 落库确认。该过程抓出并修掉了三个"在 SQLite 上全绿、在 PG 上必炸"的真缺陷，
并留下两条类级守卫随 `pnpm test` 一起运行：`packages/manager/test/migrations-dialect.test.ts`
（用了 SQLite 专有语法的迁移目录必须配 `migrations-postgres/`）与
`packages/manager/test/db-dual-track.test.ts`（凡在代码里取 `ctx.get('db')` 的文件必须出现 `asAsync`）。
该次读数**未入库为可复跑资产**——要回归请按实跑取数。

## 插件平台

插件是 GeeWiki 唯一的扩展机制。宿主启动时读取 `config/plugins.base.json`，并从 `plugins/` 目录
自动发现外部插件（清单取子目录 `package.json` 的 `geewiki` 键或独立的 `geewiki.manifest.json`）。

**出厂清单**：内置插件共 **25 个**注册于代码内注册表 `defaultRegistry()`，其中 **21 个默认启用**：

```
db-sqlite  http  auth  org  authz  ops  wiki  builtin-docs  search
llm  openai  ai-tools  ai-journal  ai-kb  ai-web-search  ai-summary
ai-pages  ai-assistant  ai-writing  ai-nav  ai-admin
```

其余 4 个**已注册但未启用**，可在管理台按需启用：`postgres`（冷操作）、`echo`（热插拔演示）、
`editor-plain`（纯文本编辑器）、`oidc`（OIDC 身份提供者）。

**层次与热能力**：基础层清单里的插件**不可热停用**（管理台操作返回 `409 base_layer`，需改
`config/plugins.base.json` 后重启）；外部插件与运行时会话层插件才是热层。声明
`supportsHotReload: false` 的插件（两个数据库插件）连启用也是冷的。

**前端插槽**：宿主提供 7 个内置插槽，插件在清单里声明占用，界面随插件启停自动出现或消失。

| 插槽 | 基数 | 用途 |
| --- | --- | --- |
| `app-header` | multi | 顶栏 |
| `app-footer` | multi | 页脚 |
| `editor` | single | 正文编辑器（带数据的具名契约） |
| `editor-toolbar` | multi | 编辑器工具条按钮组（当前无占用者） |
| `app-dock` | single | 常驻底部输入条（AI 对话入口） |
| `article-summary` | single | 文章标题下方的折叠摘要位 |
| `account-identities` | multi | 账号页的「外部身份（SSO）」区 |

单占用插槽同时被多个激活插件占用时，按**激活顺序最早者胜出**，其余进入冲突列表并在
`GET /api/plugins/slots` 与管理台可见。插件也可以自行 `slot.define()` 声明**自定义扩展点**
（名字必须至少含一段 `/`，从而与内置插槽名永不碰撞）。

> `@geewiki/editor-plain` 默认不启用是有原因的：`editor` 是单占用插槽，它占住之后内置编辑器
> （**唯一**支持拖拽/粘贴附件上传的编辑器）不再渲染，而插槽契约里没有上传通道。
> **第三方编辑器在补上上传能力之前不应默认占用 `editor` 插槽。**

编写自己的插件：见 [docs/architecture.md](docs/architecture.md) 的 Manifest 规范与
[docs/plugin-platform.md](docs/plugin-platform.md) 的插件接口契约；脚手架直接跑
`pnpm run new:plugin <名字>`。

## 架构总览

```
React 19 前端（宿主提供 7 个内置插槽 + window.__GEEWIKI_HOST__ 宿主 SDK；
             插件 UI 按后端下发的入口表 GET /api/plugins/ui 从 /plugins-ui/<插件名>/… 加载）
        │
        │  REST API（HTTP + SSE 长连接）
        ▼
Plugin Manager（核心大脑）：热加载引擎 · 依赖图/冲突组 · 会话层沙箱 ·
             迁移控制器 · 看门狗探针 · 配置热更新 · 插槽贡献注册表
        │
        │  服务抽象层（cordis 依赖注入）
        ▼
插件生态
  ├─ 数据库组：@geewiki/db-sqlite  ↔  @geewiki/postgres     （互斥 conflictGroup，冷切换）
  ├─ 编辑器组：@geewiki/editor-plain + 第三方编辑器          （占用 editor 插槽，单占用）
  ├─ 检索：    @geewiki/search                              （FTS5 + trigram）
  └─ AI 层（不进任何冲突组，可自由组合）
       @geewiki/llm        契约层：route→provider 注册表、降级词汇与脱敏的唯一归属
       @geewiki/openai     OpenAI 兼容适配器（并列可选的服务商之一）
       @geewiki/ai-tools / ai-kb / ai-web-search / ai-pages / ai-journal / ai-nav / ai-admin
       @geewiki/ai-assistant   常驻底部输入条（app-dock）→ 智能体循环 → SSE（POST /api/ai/turn）
       @geewiki/ai-writing     编辑器内的改写/润色/摘要/续写（客户端工具，无 HTTP 端点）
       @geewiki/ai-summary     文章摘要卡片（article-summary，/api/ai/summary*）
```

完整设计见 [docs/architecture.md](docs/architecture.md)。

## 仓库结构

```
geewiki/
├── packages/                 # 28 个 workspace 包
│   ├── core/                 # 内核类型与常量：Manifest 规范、DatabaseAdapter、SlotService、cordis 类型增强
│   ├── manager/              # 插件管理器：依赖图 / 冲突组 / 会话层沙箱 / 迁移 / 看门狗 / 插槽注册表
│   ├── server/               # 应用宿主：HTTP 服务、静态资源、内置插件注册表（@geewiki/http 也在此）
│   ├── web/                  # React 19 管理台与 wiki 前端（Vite；fixtures/ 为插槽演示）
│   ├── db-sqlite/            # @geewiki/db-sqlite —— 默认数据库
│   ├── db-postgres/          # @geewiki/postgres —— PostgreSQL 适配器（默认不启用）
│   └── plugin-*/             # 22 个插件包：auth org authz ops echo editor-plain llm openai oidc
│                             #   search wiki builtin-docs 与 10 个 ai-* 插件
│                             #   （连同上面两个数据库插件，共 24 个包提供 25 个内置插件注册）
├── config/                   # 插件清单：plugins.base.json（入库） / plugins.session.json（运行时）
├── data/                     # SQLite 数据库与运行时数据（.gitignore）
├── docs/                     # 项目文档（见下方「文档」）
├── plugins/                  # 外部插件目录：一个子目录一个插件，启动时自动发现
│   ├── hello-geewiki/        # 零依赖示例
│   └── ui-demo/              # 插槽与资产演示
├── scripts/acceptance/       # 浏览器侧端到端验收脚本（零依赖直连 CDP，刻意不入 pnpm test）
├── Dockerfile                # 多阶段生产镜像（builder + runtime，非 root 运行）
├── docker-compose.yml        # Compose 编排（默认 SQLite；--profile production 预留 PostgreSQL）
├── LICENSE
└── README.md
```

> 插件 UI 产物由 `pnpm --filter @geewiki/web run build:fixtures` 单独生成（**不在 `pnpm build` 内**）。
> 该命令先全量清空 `packages/web/public/plugins-ui`（避免旧产物残留导致"入口表说就绪、资产却 404"），
> 再构建三份 bundle 到 `plugins/ui-demo/dist/`、`plugins/hello-geewiki/dist/` 与
> `packages/web/public/plugins-ui/@geewiki/editor-plain/`。这些产物都不入库，因此新克隆的仓库
> 需要先执行该命令，管理台上才会有示例插件 UI；缺失时宿主不报错，只是把它们记入
> `skipped: entry_missing`。

## 开发

```bash
pnpm install
pnpm dev                 # 起后端 + 前端
pnpm test                # 单元测试
pnpm typecheck           # 类型检查
pnpm run new:plugin foo  # 生成插件脚手架
```

- **代码改动**：`packages/` 下是 pnpm workspace 包，彼此通过 workspace 协议依赖。
- **界面路由**（hash 路由）：`#/wiki` 知识库主页 · `#/wiki/list` 列表 · `#/wiki/new` 新建 ·
  `#/wiki/<slug>` 详情（支持分层 slug）· `#/wiki/<slug>/edit` 编辑 · `#/wiki/search/<q>` 检索结果 ·
  `#/plugins` 插件管理（旧链接 `#/graph` 仍可用，解析时改写为 `#/plugins`，两者是同一页）·
  `#/org` 组织管理 · `#/audit` 审计与运维（由 `@geewiki/ops` 声明）· `#/account` · `#/invite/<token>` ·
  `#/login` · `#/setup` · `#/denied`。
- **`#/wiki` 的主页是一篇约定 slug 为 `home` 的普通文章**：可编辑、有版本历史，与其它页面一样受
  既有权限体系管辖。⚠️ 升级提示：若库里已存在 slug 为 `home` 的页面，它会直接成为站点主页。
- **保留段**：`WIKI_RESERVED_FIRST_SEGMENTS = ['search', 'ask', 'new', 'list']`——这些名字不能作为
  页面 slug 的首段。（`ask` 已不再被路由解析，但保留，因为解禁是单向不可回收的。）
- **验收脚本**在 `scripts/acceptance/`，零依赖直连 Chrome DevTools Protocol，刻意不纳入 `pnpm test`。

## 部署

仓库自带多阶段 `Dockerfile` 与 `docker-compose.yml`，容器内以非 root（`node`）运行，
数据落在宿主机 `./data`：

```bash
mkdir -p data config plugins && chown -R 1000:1000 data config plugins
docker compose up -d --build        # → http://localhost:3000
```

目录权限、环境变量、数据备份与恢复、生命周期自愈、PostgreSQL profile、升级步骤、排障与
验证清单见 [docs/deployment.md](docs/deployment.md)。本地开发仍推荐 `pnpm dev`。

## 文档

完整索引见 **[docs/README.md](docs/README.md)**（「我想知道 X，该看哪一篇」）。主要入口：

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统设计：分层架构、插件管理器、插槽与入口表、Manifest 规范、REST 面 |
| [docs/plugin-platform.md](docs/plugin-platform.md) | 插件接口契约、生命周期、验证纪律、已知限制与有意不做 |
| [docs/deployment.md](docs/deployment.md) | 部署与运维：镜像、目录权限、环境变量、备份、PostgreSQL、排障 |
| [docs/development.md](docs/development.md) | 工程约定：环境约束、数据库迁移约定、方言差异、验收纪律 |
| [docs/roadmap.md](docs/roadmap.md) | 路线图与当前工程状态 |
| [docs/design/](docs/design/) | 专题设计：访问控制、附件、AI 能力架构 |
| [docs/changelog/implementation-log.md](docs/changelog/implementation-log.md) | 历史实施台账（**非当前口径**） |

## 许可证

[MIT](LICENSE) © 2025 GeeWiki contributors
