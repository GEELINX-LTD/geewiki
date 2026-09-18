# GeeWiki 部署指南（Docker）

本文档描述如何用仓库自带的 `Dockerfile` 与 `docker-compose.yml` 部署 GeeWiki。
默认形态只需一条命令，数据存放在宿主机的 `./data`（单个 SQLite 文件），**不依赖任何外部数据库服务**。

---

## 1. 快速开始

前置条件：Docker Engine 24+ 与 Docker Compose V2（`docker compose version`）。

```bash
# 1) 准备挂载目录并让属主与容器内用户一致（默认 uid/gid = 1000）
mkdir -p data config plugins
sudo chown -R 1000:1000 data config plugins

# 2) 构建并启动
docker compose up -d --build

# 3) 查看状态与日志
docker compose ps
docker compose logs -f geewiki-app
```

访问 <http://localhost:3000> 即可使用 Wiki 界面（`#/wiki` 页面管理、`#/plugins` 插件管理与依赖图——**两者已是同一页**，老链接 `#/graph` 会被改写成 `#/plugins`）。

自检：

```bash
curl -s http://localhost:3000/api/health
```

响应字段的含义（**不要把某一时刻的取值当契约**——`tables` / `migrations` 随启用的数据库插件与已落地的插件变化，与具体部署强相关）：

- `ok`：服务是否正常；`uptime`：进程运行秒数；`timestamp`：服务端时间。
- `db.present`：数据库适配器是否已就绪（`false` 时业务接口会全部 404，见第 9 节；健康检查本身**仍返回 HTTP 200**）。
- `db.dialect`：当前数据库方言（`sqlite` / `postgres`）。
- `db.tables` / `db.migrations`：**当前实际**的表名与已应用迁移文件名清单（各一个数组），随启用插件变化。
- `streams`（存在时）：长连接统计 `HttpStreamStats`（含因并发上限被拒的次数等）。

`ok:true` 且 `db.present:true` 即表示服务端已启动、数据库连接正常、迁移已应用。

### 端口

容器内固定监听 `3000`（`GEEWIKI_PORT`），宿主端口默认也是 `3000`，可用环境变量改写：

```bash
GEEWIKI_HOST_PORT=8080 docker compose up -d
```

### 停止与清理

```bash
docker compose stop          # 发送 SIGTERM，应用优雅退出（卸载插件 → 关闭数据库 → 退出码 0）
docker compose down          # 停止并删除容器与网络（./data 中的数据保留）
docker compose down -v       # 连同 named volume 一并删除（bind mount 的 ./data 不受影响）
```

---

## 2. 镜像构成

`Dockerfile` 为多阶段构建，基础镜像 `node:22-bookworm-slim`（glibc，与 better-sqlite3 预编译产物匹配）：

| 阶段 | 作用 |
| --- | --- |
| `builder` | `corepack` 固定 `pnpm@11.7.0` → `pnpm install --frozen-lockfile` → `pnpm -r --if-present run build`（生成 `packages/web/dist`）→ 生成生产部署树 → 安装运行期 `tsx` |
| `runtime` | 仅复制部署树、前端静态产物与 `tsx`，以非 root 的 `node` 用户运行 |

三个关键设计：

- **为什么运行期还需要 tsx**：后端各包没有编译产物，`exports` 直接指向 `src/index.ts`，由 tsx 在运行时转译 TypeScript 源码。`--prod` 部署会裁掉 devDependencies，因此在 builder 阶段单独安装一份 `tsx` 到 `/opt/tsx`，版本直接取自 lockfile 中实际安装的那一份（不使用浮动范围，也不会写回 `pnpm-lock.yaml`）。
- **为什么运行镜像里没有编译器**：`better-sqlite3@13` 自带 `prebuilds/**`（含 `linux-x64`），运行时由 `lib/binding.js` 优先加载预编译产物。不过 pnpm 11 的 legacy deploy 在生成部署树时**仍会执行一次原生安装脚本**（即使设置 `npm_config_ignore_scripts=true` 也会调用 `node-gyp`，已实测），因此 **builder 阶段必须安装 `python3/make/g++`**；这些工具不会进入运行镜像。
- **为什么这里没有 `storeDir`/`cacheDir` 的处理步骤**：`pnpm-workspace.yaml` 里的 store/cache 曾经写死为宿主机的绝对路径，镜像内必须 `sed` 删两次（`COPY . .` 会把原文件覆盖回来）。现已改为**相对路径**（`.pnpm-store` / `.npm-cache`），在 builder 内解析为 `/src/.pnpm-store`，本地、CI、镜像与 Dependabot 各环境通用，相关 `sed` 已随之移除。

构建产物参考（`docker images geewiki:latest`；**读数时点 HEAD `98b0ddd`（2026-09-17），以实跑为准**）：`DISK USAGE` 约 `386MB`、`CONTENT SIZE` 约 `96.8MB`。两者口径不同 —— `DISK USAGE` 是该镜像层在本地磁盘上的未压缩占用，`CONTENT SIZE` 是压缩后的分发体积；容器实际运行时占用的可写层还会另计。镜像内容为 `node:22-bookworm-slim` 基础层 + 约 28MB 生产部署树 + 运行期 `tsx`。

镜像内环境变量（已在 `Dockerfile` 中固化，无需在 compose 重复声明应用层变量）：

```
NODE_ENV=production
GEEWIKI_PORT=3000
GEEWIKI_DATA_DIR=/app/data
GEEWIKI_CONFIG_DIR=/app/config
GEEWIKI_PLUGINS_DIR=/app/plugins
GEEWIKI_WEB_DIST=/app/packages/web/dist
```

> **`GEEWIKI_PLUGIN_UI_DIST` 镜像内刻意不设**（已只读核实 `Dockerfile:96-103` 与 `docker-compose.yml:45-52`，两处都只固化 `GEEWIKI_WEB_DIST`）：该变量**缺省即回落 `GEEWIKI_WEB_DIST`**（`packages/server/src/index.ts:1863-1870`；`ServerOptions.pluginUiDist` 的类型声明在 `:1428`），因此镜像里"前端产物根"与"内置插件 UI 资产根"**指向同一个目录** `/app/packages/web/dist`（内置插件 UI 位于其下的 `plugins-ui/<插件名>/`，由镜像内 `vite build` 从 `packages/web/public/` 拷贝而来，见 `.dockerignore` **未排除** `packages/web/public/plugins-ui/` 与 `Dockerfile:111` 的 `COPY --from=builder /src/packages/web/dist /app/packages/web/dist`；**前提**是构建上下文里已有 `packages/web/public/plugins-ui/**`，即宿主机先跑过 `pnpm --filter @geewiki/web run build:fixtures`——该目录被 `.gitignore` 排除、不入版本库。**本次未实跑镜像构建，本段为只读核实 + 推断**）。**镜像行为与拆分前完全一致，无需显式设置**；只有当你想让插件 UI 走独立目录（如 dev 形态的 `packages/web/public`）时，才需要额外覆盖该变量。启动日志会同时打印两个根，相同的那一份带"（同静态产物根）"注记，便于核对。

镜像自带 `HEALTHCHECK`（每 30s 请求 `/api/health`），判据是 **`ok:true` 且 `db.present:true`**（即服务在跑、SQLite 已连接），满足时 `docker compose ps` 显示 `healthy`；数据目录不可写等导致数据库插件激活失败的情况会如实显示 `unhealthy`（详见第 9 节）。

### 外部插件：镜像内不打包，只来自挂载

`plugins/` **不打进镜像**。这是刻意的：compose 的绑定挂载会覆盖镜像内同名目录，若两边都放插件，宿主 `./plugins` 为空时插件反而"消失"，语义含糊。因此容器内的外部插件**只来自** `-v "$PWD/plugins:/app/plugins"` 这一挂载（compose 默认已配置）。

- **发现规则**：`/app/plugins/<子目录>/` 每个子目录识别为一个插件；清单取自该目录 `package.json` 的 `geewiki` 键，或同目录的 `geewiki.manifest.json`；入口按 `geewiki.entry` → `index.ts` → `index.js` → `src/index.ts` 顺序解析（TypeScript 入口由运行期 `tsx` 转译）。仓库自带示例：`plugins/hello-geewiki/`。
- **扫描时机**：仅**启动时**扫描一次。增删插件后需 `docker compose restart geewiki-app`。
- **挂载目标必须是 `/app/plugins`**（只比 `/app` 深一层）：插件内的裸模块说明符（如 `import ... from 'cordis'`）要沿 `node_modules` 逐级上溯才能命中部署树 `/app/node_modules`，挂得更深就会 `ERR_MODULE_NOT_FOUND`。
- **插件应自带扁平、可读的 `node_modules`**，不要使用指向宿主 pnpm store 的 symlink：pnpm 严格布局下顶层 `node_modules` 没有传递依赖的直接链接，插件若 `import` 传递依赖（例如 `better-sqlite3`）会解析失败（第 5 节热备份命令记录了同类实测：裸 `require('better-sqlite3')` 抛 `MODULE_NOT_FOUND`）。
- 宿主 `./plugins` 的属主需与容器内用户一致（同 `./data`、`./config`，见第 3 节）。
- 配置文件同理：镜像内**自带** `config/plugins.base.json`（默认基础层清单），但一旦把 `./config` 挂载到 `/app/config`，就以宿主目录为准 —— 宿主目录为空时应用会读到"空清单"，导致**没有任何插件被激活**：HTTP 不监听，进程以退出码 0 结束，再被 `restart: unless-stopped` 反复拉起，形成静默重启循环（见第 9 节）。

---

## 3. 目录权限（绑定挂载）

容器内以**非 root** 的 `node` 用户（uid/gid 默认 `1000`）运行。绑定挂载时宿主目录的属主决定容器能否写入：

- `./data`：必须可写。SQLite 需要在该目录创建 `geewiki.db` 及其 `-wal`/`-shm` 文件；崩溃自愈标记 `crash.marker` 也写在这里。
- `./config`：必须可写。除只读的 `plugins.base.json` 外，插件管理器还会写 `plugins.session.json`（会话层清单）、`plugins.base.json`（持久化操作）与 **`secrets.json`**（`role: 'secret'` 字段的落盘位置：模型 API 密钥等，权限 `0600`，已被 `.gitignore` 忽略）。目录不可写会导致「启用插件/持久化/**保存密钥**」失败——典型症状是管理台里填了密钥、保存报错或重启后"未配置"。容器内进程以 `node`（uid 1000）运行，宿主目录属主不对时先 `chown -R 1000:1000 config`。
- `./plugins`：外部插件的发现根。每个子目录识别为一个插件（清单见下节），插件文件需可读；容器内该路径固定为 `/app/plugins`（由镜像的 `GEEWIKI_PLUGINS_DIR` 决定）。

两种处理方式，任选其一：

```bash
# 方式 A：把宿主目录交给 uid 1000（默认）
sudo chown -R 1000:1000 data config plugins

# 方式 B：让容器使用你自己的 uid/gid（不需要 sudo）
GEEWIKI_UID=$(id -u) GEEWIKI_GID=$(id -g) docker compose up -d --build
```

方式 B 可写入 `.env` 以便长期生效：

```dotenv
GEEWIKI_UID=1001
GEEWIKI_GID=1001
```

验证容器内身份与目录可写性：

```bash
docker compose exec geewiki-app id
# uid=1000(node) gid=1000(node) groups=1000(node)

docker compose exec geewiki-app sh -c 'touch /app/data/.w && rm /app/data/.w && echo writable'
```

> 使用 named volume 代替绑定挂载时，Docker 会把镜像中 `/app/data` 的属主（`node:node`，即 `1000:1000`）带入新卷，因此**只有在容器以默认 uid/gid 运行时**才无需手动 chown。若按方式 B 改成其他 uid/gid，空卷的属主仍是 `1000:1000`，容器用户会因不可写而让 SQLite 建库失败（表现为 `/api/health` 的 `db.present:false`）。此时对空卷补一次属主即可：

```bash
# 仅 named volume 场景需要；绑定挂载请用第 3 节的 chown 或 GEEWIKI_UID/GID
docker compose run --rm --user 0 --entrypoint chown geewiki-app -R 1001:1001 /app/data /app/config /app/plugins
```

> 本仓库默认使用绑定挂载，以便直接在宿主机查看 SQLite 文件与配置。

---

## 4. 环境变量一览

Compose 层变量（写入 `.env` 或命令行前缀即可）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_HOST_PORT` | `3000` | 映射到宿主机的端口（容器内始终为 3000） |
| `GEEWIKI_HOST_DATA_DIR` | `./data` | 数据目录宿主路径 |
| `GEEWIKI_HOST_CONFIG_DIR` | `./config` | 配置目录宿主路径（须含 `plugins.base.json`） |
| `GEEWIKI_HOST_PLUGINS_DIR` | `./plugins` | 外部插件目录的宿主路径；挂载到容器内固定路径 `/app/plugins`（发现根本身由镜像内的 `GEEWIKI_PLUGINS_DIR` 决定，见下节） |
| `GEEWIKI_UID` / `GEEWIKI_GID` | `1000` / `1000` | 容器运行用户，用于对齐宿主目录属主 |
| `DB_PASSWORD` | 无 | 仅 `--profile production` 的 postgres 服务需要 |

应用层变量（由 `packages/server/src/index.ts` 读取，镜像已内置合理默认值）：

| 变量 | 镜像内取值 | 说明 |
| --- | --- | --- |
| `GEEWIKI_PORT` | `3000` | HTTP 监听端口 |
| `GEEWIKI_DATA_DIR` | `/app/data` | SQLite 数据库与 `crash.marker` 所在目录 |
| `GEEWIKI_CONFIG_DIR` | `/app/config` | 基础层/会话层插件清单目录 |
| `GEEWIKI_PLUGINS_DIR` | `/app/plugins` | 外部插件发现根。**必须是绝对路径**：部署树里没有 `pnpm-workspace.yaml`，相对路径会回退到 `process.cwd()`，一旦覆盖工作目录就会**静默发现 0 个插件且不报错**（已实测：`-w /tmp` + `GEEWIKI_PLUGINS_DIR=plugins` 时发现根变为 `/tmp/plugins`、0 个插件、无任何告警） |
| `GEEWIKI_WEB_DIST` | `/app/packages/web/dist` | **前端静态产物根**（app shell 的 `index.html`、`/assets/*`、SPA fallback；`null` = 不启用静态服务）。镜像内为绝对路径，与工作目录无关 |
| `GEEWIKI_PLUGIN_UI_DIST` | **未设置**（= 回落 `GEEWIKI_WEB_DIST`） | **内置插件 UI 资产根**（含 `plugins-ui/<插件名>/` 的目录），是插件 UI 产物的**第二候选根**（第一候选根是插件自带的 `<插件目录>/dist`）。**缺省 = `GEEWIKI_WEB_DIST`**，故镜像内与静态产物根同值、无需设置。注意它与 `GEEWIKI_WEB_DIST` 的 **`null` 语义不同**（`pluginUiDist: null` = 不用内置根、只看插件自带产物；`webDist: null` = 不启用静态服务）——该区分只存在于 `ServerOptions`，环境变量层面留空即等同"未设置 = 回落" |
| `GEEWIKI_HOST` | `0.0.0.0` | 后端**监听地址**（`packages/server/src/index.ts:1848`：`options.host ?? process.env.GEEWIKI_HOST ?? '0.0.0.0'`）。容器内保持默认即可；只绑 `127.0.0.1` 会让端口映射失效 |
| `GEEWIKI_OIDC_TICKET_SECRET` | **未设置**（每进程随机） | **OIDC 登录票据的签名密钥**（`packages/plugin-auth/src/index.ts:506-511`）。多实例部署、或需要重启后票据仍有效时必须配置；未配置时每进程随机生成，重启即失效 |

> ⚠️ **`GEEWIKI_DATABASE_URL` / `GEEWIKI_DB_PASSWORD` 不是内置变量**：它们只是 `@geewiki/postgres` 配置项 `connectionStringEnv` / `passwordEnv` 的**示例名**（`packages/db-postgres/src/index.ts:65` / `:73`）。应用本身从不读这两个名字——真正被读的是**你在插件配置里填的那个环境变量名**，填什么读什么。

---

## 5. 数据持久化与备份

| 路径（宿主） | 内容 |
| --- | --- |
| `./data/geewiki.db` | 全部页面、版本快照与迁移记录（`_migrations` / `pages` / `page_versions`） |
| `./data/geewiki.db-wal`、`-shm` | SQLite WAL 模式附带文件（备份时建议一并复制，或先 `docker compose stop`） |
| `./data/crash.marker` | 崩溃自愈标记，仅异常退出时出现（见下节） |
| `./config/plugins.base.json` | 基础层清单（随仓库提交）。**当前默认启用 21 条内置插件**：`db-sqlite http auth org authz ops wiki builtin-docs search` + `llm openai ai-tools ai-journal ai-kb ai-web-search ai-summary ai-pages ai-assistant ai-writing ai-nav ai-admin`；内置注册表共 **25** 个（另有 `echo editor-plain oidc postgres` 已注册未启用），另有 `plugins/` 下 2 个外部示例。以 `defaultRegistry()` 与该文件为真源 |
| `./config/plugins.session.json` | 会话层清单（运行时生成，已被 `.gitignore` 忽略） |
| `./config/secrets.json` | **密钥文件**（`role: 'secret'` 字段的值，如模型 API 密钥；运行时生成，权限 `0600`，已被 `.gitignore` 忽略）。**备份它 = 备份密钥**：请与数据库同级看待——放进受控的备份位置，不要把备份产物提交进版本库。不需要它时删掉即可（配置里只留下"未配置"） |
| `./plugins/` | 外部插件源码（每个子目录一个插件）。**不打进镜像**，容器只通过该绑定挂载发现（见第 2 节） |

热备份（在线，无需停机；走 SQLite backup API）：

```bash
# 1) 先查出部署树里 better-sqlite3 的真实路径：pnpm 严格布局下顶层 node_modules 中没有
#    它的直接软链，裸 require('better-sqlite3') 会抛 MODULE_NOT_FOUND（已实测）
docker compose exec geewiki-app sh -c 'ls -d /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3'
# → /app/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3

# 2) 用该绝对路径做在线备份（版本号随 pnpm-lock.yaml 变化，请用上一步的实际输出）
docker compose exec geewiki-app node -e 'const D=require("/app/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3"); new D("/app/data/geewiki.db").backup("/app/data/backup-"+Date.now()+".db").then(f=>console.log("hot backup ok:",f)).catch(e=>{console.error("hot backup failed:",e.message);process.exit(1)})'
# hot backup ok: { totalPages: 8, remainingPages: 0 }
```

不想手填版本号时，可让容器内的 shell 自行解析路径（与版本无关，已实测）：

```bash
docker compose exec geewiki-app sh -lc 'node -e "const D=require(process.argv[1]);new D(\"/app/data/geewiki.db\").backup(\"/app/data/backup-\"+Date.now()+\".db\").then(f=>console.log(\"hot backup ok:\",f)).catch(e=>{console.error(\"hot backup failed:\",e.message);process.exit(1)})" "$(ls -d /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3)"'
```

备份产物是**完整快照**（含 WAL 中已提交的数据，因此体积可能大于当前的 `geewiki.db`），落在同一个 `./data` 目录里；归档后建议移出该目录，避免与运行期文件混淆。

冷备份（推荐，简单可靠）：`docker compose stop && cp -a data config /path/to/backup/ && docker compose start`。

---

## 6. 生命周期与自愈语义

- **优雅退出**：`docker compose stop` 发送 SIGTERM，应用会卸载全部插件、关闭数据库连接并以退出码 0 退出（`init: true` 保证 PID 1 正确转发信号并回收僵尸进程）。
- **不用 compose 时**：请自行加上 `--init` 与挂载，例如
  `docker run --init -d -p 3000:3000 -v "$PWD/data:/app/data" -v "$PWD/config:/app/config" -v "$PWD/plugins:/app/plugins" geewiki:latest`。
  镜像已内置 `GEEWIKI_PLUGINS_DIR=/app/plugins` 与 `GEEWIKI_CONFIG_DIR=/app/config`，因此即使加了 `-w /somewhere` 改变工作目录，插件与清单发现仍然正确（相对路径会退回 `process.cwd()`，这正是镜像内固化绝对路径的原因）。
- **崩溃自愈**：仅在「未捕获异常 / 未处理的 Promise 拒绝 / `startServer()` 抛错」三种情形写入 `data/crash.marker`。重启时若检测到该标记，会跳过会话层（Session Layer）装配、把它清空，并删除标记，从而自动回滚到基础层（Base Layer）的稳定状态，避免坏插件导致反复崩溃。
- **监听失败不算崩溃**：端口被占用时进程以退出码 1 退出，但**不写**标记（便于排障，不影响插件状态）。
- **看门狗熔断**：插件试用期内异常会导致熔断，先清空会话层清单文件再以退出码 1 退出。

`restart: unless-stopped` 会让容器在退出后自动重启，配合上述标记实现「崩溃 → 重启 → 回滚到基础层」的闭环。

---

## 7. 生产 profile（PostgreSQL）

```bash
echo "DB_PASSWORD=请改成强密码" >> .env
docker compose --profile production up -d --build
```

该 profile 会额外启动 `postgres:15`（不映射宿主端口，仅在同网络内以 `postgres:5432` 可达）。应用侧对应的插件是 **`@geewiki/postgres`**（`packages/db-postgres/`，**不是** `@geewiki/db-pg`）——它**已实现**（异步适配器 + schema 化配置 + 自有迁移；单测以 `pnpm --filter @geewiki/postgres test` 的**实时读数**为准，本文不写死例数——文档曾写 20、`packages/db-postgres/test/postgres.test.ts` 实测 17 处 `test(`、roadmap 另处写 15，三方不一），与 `@geewiki/db-sqlite` 同属 `conflictGroup: 'database-provider'`（天然互斥）且**默认不启用**。该 profile 只负责把 Postgres 服务跑起来，**切换动作在应用侧显式做**，见下。

`docker-compose.yml` 里 `POSTGRES_PASSWORD` 写成 `${DB_PASSWORD:-}`：未启用该 profile 时不会再出现 `The "DB_PASSWORD" variable is not set` 告警；而一旦启用却没有提供密码，postgres 官方镜像会拒绝以空密码初始化并立即退出（`Error: Database is uninitialized and superuser password is not specified.`，已实测），属安全失败，不会产生弱密码实例。

---

### 应用侧：怎么切到 PostgreSQL

包名是 **`@geewiki/postgres`**（`packages/db-postgres/`，**不是** `@geewiki/db-pg`）。它已实现——异步适配器 + schema 化配置 + 自有迁移，与 `@geewiki/db-sqlite` 同属 `conflictGroup: 'database-provider'`（**天然互斥**），并且**默认不启用**：刻意不写进 `config/plugins.base.json`，因为"切库"是显式决策。

**⚠️ 切库是冷操作，不能热切。** 实测确认：`@geewiki/postgres` 与 `@geewiki/db-sqlite` 都声明了 `runtime.supportsHotReload: false`，因此

- `POST /api/plugins/%40geewiki%2Fdb-sqlite/disable` → **409 `base_layer`**：`@geewiki/db-sqlite 属于基础层（冷操作），请编辑基础层清单 plugins.base.json 后重启进程`（基础层插件不可热卸载）；
- `POST /api/plugins/%40geewiki%2Fpostgres/enable` → **409 `hot_reload_not_supported`**：`@geewiki/postgres 未声明 runtime.supportsHotReload: true，仅支持持久化安装 + 进程重启（冷操作）`。

**正确步骤**：① 在外部设好连接串环境变量；② **直接编辑 `config/plugins.base.json`**，把 `{"name": "@geewiki/db-sqlite"}` 换成 `@geewiki/postgres` 条目并带上 `config`；③ 重启进程。

```bash
export GEEWIKI_DATABASE_URL='postgres://geewiki:REPLACE_ME@127.0.0.1:5432/geewiki'
```

```jsonc
// config/plugins.base.json —— 把 db-sqlite 换成 postgres（示例，凭据一律用变量名）
{
  "enabled": [
    { "name": "@geewiki/postgres",
      "config": { "connectionStringEnv": "GEEWIKI_DATABASE_URL", "ssl": false } },
    { "name": "@geewiki/http" },
    { "name": "@geewiki/wiki" }
    // ⚠️ 不要同时保留 @geewiki/db-sqlite：两者同属 database-provider 冲突组，互斥
    // ⚠️ 也不建议保留 @geewiki/search：它依赖 SQLite 专有 FTS5，在 PG 方言下会激活失败（见「已知限制」⑬）
  ]
}
```

`@geewiki/postgres` 的 `configSchema` 字段（真源 `packages/db-postgres/src/index.ts:41` 的 `PostgresConfigSchema`）：

| 字段 | 类型 / 默认 | 说明（schema 里的原文） |
| --- | --- | --- |
| `connectionStringEnv` | string，`''` | 存放连接串的**环境变量名**（推荐；留空则用下面的分项配置）。例如 `GEEWIKI_DATABASE_URL` |
| `host` | string，`'127.0.0.1'` | 数据库主机 |
| `port` | number，`5432`（1–65535） | 端口 |
| `database` | string，`'geewiki'` | 库名 |
| `user` | string，`'geewiki'` | 用户名 |
| `passwordEnv` | string，`''` | 存放密码的**环境变量名**（推荐；留空表示无密码）。例如 `GEEWIKI_DB_PASSWORD` |
| `password` | string（`role: password`），`''` | ⚠️ **明文密码（仅本地开发）**——会明文落进入库清单，生产请改用 `passwordEnv` |
| `max` | number，`10`（1–100） | 连接池上限 |
| `connectionTimeoutMillis` | number，`10000` | 建立连接超时（毫秒） |
| `idleTimeoutMillis` | number，`30000` | 空闲连接回收（毫秒） |
| `ssl` | boolean，`false` | 是否使用 SSL |

**关于"`config/plugins.base.json` 能否承载连接配置"**：**能**。实测：`PUT /api/plugins/:name/config` 会把 `config` 写进该插件所在清单层的条目上，`POST /api/session/persist`（管理台的「应用并持久化」）再把它并入入库的 `config/plugins.base.json`——条目形状就是 `{ "name": …, "config": { … } }`（`packages/manager/src/index.ts:642` 的 `persistConfig()`，已实测看到 postgres 的完整配置出现在入库文件里）。**所以"把凭据放进环境变量名"是纪律问题而非结构限制**——别把明文密码填 `password` 字段。

**两条必须知道的边界**：① 切到 PostgreSQL 后 **`/api/search` 不可用**——`@geewiki/search` 依赖 SQLite 专有的 FTS5，启用时会显式抛错拒绝（详见「已知限制」⑬）。（旧文写的"`/api/ai` 的问答也不可用"已作废：**系统已无任何问答插件**——`@geewiki/ai-qa` 已整包删除。现行 AI 能力经 `@geewiki/ai-assistant` 的 `POST /api/ai/turn` 提供，"不可用"只取决于**有没有可用模型**，与数据库方言无关；缺模型即 503。）② 真实 PG 端到端验证**已完成**，读数、三个被 PG 抓出的真缺陷与两条类级守卫见 **§11**。

## 8. 升级与重建

```bash
git pull
docker compose up -d --build          # 重新构建镜像并滚动替换容器（数据卷不受影响）
docker image prune -f                 # 清理悬空镜像（可选）
```

完全干净重建（依赖或基础镜像有变化时）：

```bash
docker compose build --no-cache && docker compose up -d
```

### 用 CI 发布的镜像替代本地构建（可选）

上面两步都是在服务器上**本地构建**镜像。CI 也会在每次 push `main` 与打 tag 时把镜像
发布到 GHCR（`ghcr.io/geelinx-ltd/geewiki`），服务器可以改为直接拉取，省掉构建：

```bash
# 私有包（默认状态）：需先登录。password 用**具备 read:packages 权限的 token**，
# 不是账号密码 —— classic PAT 勾 read:packages，或 fine-grained PAT 勾 Packages: Read：
echo "$CR_PAT" | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
docker pull ghcr.io/geelinx-ltd/geewiki:latest

# 公开包：无需登录
docker pull ghcr.io/geelinx-ltd/geewiki:latest
```

改用拉取时，把 `docker-compose.yml` 里 `geewiki-app` 服务的 `build:` 段去掉、`image:`
改为 `ghcr.io/geelinx-ltd/geewiki:latest`。注意 **`build:` 与 `image:` 同时存在时
compose 只会构建、不会拉取**（`image:` 仅作为构建产物的名字），这正是当前配置的行为。

> ⚠️ **包的可见性与仓库的可见性是两回事**：仓库是 public 并不代表镜像 public。
> GHCR 的包默认是 private，且改变可见性需要**包级管理员**权限 —— 仓库自带的
> `GITHUB_TOKEN` 做不到（已实测 404），需在包设置页手动改。步骤见 `docs/ci-cd.md` 第 4.3 节。

---

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动即退出，日志含 `[@geewiki/http] 监听失败:` | 宿主端口被占用（退出码 1，不写崩溃标记）。改 `GEEWIKI_HOST_PORT` 或释放端口：`ss -ltnp \| grep 3000` |
| 服务在跑但页面接口全部 404；`/api/health` 里 `db.present` 为 `false`；插件列表中 `@geewiki/db-sqlite` 为 `state: error` | 数据目录不可写（SQLite 建不了库）。插件激活失败不影响主进程启动，因此接口照常响应：`/api/health` 仍返回 **HTTP 200** 但 `db.present:false`，业务接口全部 404；镜像 HEALTHCHECK 会据此把容器标为 **`unhealthy`**（间隔 30s × 3 次后）。按第 3 节 chown，或用 `GEEWIKI_UID/GID` 对齐宿主用户 |
| 日志出现 `[@geewiki/manager] http 路由服务不可用：REST API 未挂载`，所有接口 404 | 配置目录中缺少 `plugins.base.json`（或其中 `enabled` 为空）→ 没有任何插件被激活。从仓库复制一份：`cp config/plugins.base.json <配置目录>/`。**容器内**注意两点：镜像已自带 `/app/config/plugins.base.json`，但你若把 `./config`（宿主空目录）挂到 `/app/config`，镜像内那份就被遮蔽了，必须自己放入该文件；反之完全不挂载 config 时（`docker run` 只挂 data）镜像自带的默认清单会生效，服务照常起来 |
| 启用 `--profile production` 后 `postgres` 容器立即退出，日志含 `Error: Database is uninitialized and superuser password is not specified.` | 未提供 `DB_PASSWORD`。compose 中该变量写成 `${DB_PASSWORD:-}` 只是为了避免未启用 profile 时每条命令都告警；实际启用时为空串会被 postgres 官方镜像拒绝（安全失败，不会造出弱密码实例）。在 `.env` 中写入 `DB_PASSWORD=强密码` 后重试。未启用该 profile 时不会再出现该告警 |
| 启动即退出，日志含 `Error: EACCES: permission denied, open '/app/package.json'` | pnpm deploy 生成的部署树中少量文件权限为 `600`（仅 root 可读），非 root 运行时读取 `package.json` 会被拒绝。镜像已在构建末尾用 `find` 只给**缺少全局读位/进入位**的条目补 `o+rX`（见 `Dockerfile` 的权限归一化步骤）；自行改写 Dockerfile 或更换基础镜像时请保留该步骤 |
| 插件页「启用/持久化」报错 | `./config` 不可写（需要写 `plugins.session.json`），同上处理 |
| `Could not locate the bindings file` / better-sqlite3 加载失败 | 镜像内依赖预编译产物；若自行改动了依赖或基础镜像（如换成 Alpine/musl、或其他 CPU 架构），需确认对应 `prebuilds/*.node` 存在 |
| 页面能打开但接口 404 | 确认访问的是后端端口（容器 3000）而不是 Vite 开发端口 5173 |
| 重启后插件回到初始状态 | 属预期：这是崩溃自愈把会话层回滚到了基础层；确认 `./config` 可写后重新启用即可持久化 |
| 想看构建阶段细节 | `docker build -t geewiki:latest --progress=plain .` |

---

## 10. 部署验证清单

```bash
docker compose up -d --build
docker compose ps                                   # geewiki-app 为 running / healthy
curl -s localhost:3000/api/health                   # ok:true 且 db.tables 含 pages
curl -s localhost:3000/api/plugins | head -c 200     # 内置插件 + 外部示例 @geewiki-plugin/hello（外部插件未激活也会出现在列表里，source:"external"）。内置当前 25 注册 / 21 默认启用；plugins/ 下有 2 个外部示例（hello-geewiki、ui-demo）
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/            # 200（前端静态页）
curl -s -X PUT localhost:3000/api/pages/deploy-check \
     -H 'Content-Type: application/json' \
     -d '{"title":"部署自检","content":"# 容器持久化自检"}'          # ok:true, version:1
docker compose restart geewiki-app
curl -s localhost:3000/api/pages/deploy-check        # 重启后仍可读到，证明 ./data 持久化生效
docker compose exec geewiki-app id                   # 非 root：uid=1000(node)
docker compose stop && docker inspect -f '{{.State.ExitCode}}' $(docker compose ps -aq geewiki-app)   # 0（优雅退出）
```

> 注意最后一条：compose 生成的容器名带项目前缀（本项目目录名为 `geewiki`，故实际容器名是
> `geewiki-geewiki-app-1`），直接用服务名 `docker inspect geewiki-app` 会报
> `error: no such object: geewiki-app`（已实测）。因此统一用 `$(docker compose ps -aq <服务名>)`
> 取容器 ID；`-a` 不可省略，否则 `stop` 之后查不到已停止的容器。

---

## 11. 验证状态

本仓库的镜像与 compose 编排已在 `x86_64` / Docker 29.7.2 / Compose v5.4.0 上实测（即第 10 节命令的真实执行结果）。**读数时点：HEAD `98b0ddd`（2026-09-17）；容器与镜像相关读数以实跑为准，环境或基础镜像变化都会使其漂移。**

- `docker compose up -d --build` 启动成功，`/api/health` 返回 `ok:true`，SQLite 迁移 `0001_init.sql` 已应用，`/api/plugins` 列出内置插件（**当时**为 4 条，外部插件能力落地后为 5 条 = 内置 4 + `./plugins` 下的示例；**当前为 25 注册 / 21 默认启用**）；
- `GET /` 返回 200（前端静态产物由后端托管）；`PUT /api/pages/deploy-check` 写入成功，`docker compose restart` 后仍可读取（`./data` 持久化生效）；
- 通过 REST 启用 `@geewiki/echo` 并 `POST /api/session/persist`，宿主 `./config/plugins.base.json` 被正确改写，重启后该插件仍处于基础层激活状态（证明 `./config` 可写）；
- 容器内 `id` 为 `uid=1000(node) gid=1000(node)`（非 root），`init: true` 生效；
- `docker compose stop` 后 `docker inspect` 的 `ExitCode` 为 `0`，日志可见完整的插件卸载过程（`收到 SIGTERM，正在优雅退出...` → 各插件 `已卸载` → `已清理全部插件，退出`）。

后续一轮修复后的复验（同一环境）：

- **健康判据**：把数据目录挂成不可写（root:700）后，`/api/health` 仍返回 **HTTP 200** 且 `{"ok":true,...,"db":{"present":false}}` —— 镜像的 HEALTHCHECK 此时判为 `unhealthy`（`Health.Log` 连续 `exit=1`），而只判 HTTP 200 的旧判据会把这种「页面全 404」的容器误判为 healthy。
- **权限收敛**：镜像内常规文件模式只有 `644`/`755`（pnpm deploy 产生的 26 个 `600` 文件被 `find` 定向修正，`700` 类可执行文件不会被降级），`find /app /opt/tsx -type f -perm -o+w` 与 `-type d -perm -o+w` 均为空；`node_modules/*` 下显示为 `777` 的条目全是 symlink，属正常。
- **热备份**：文档中的两条命令均实测成功，输出 `hot backup ok: { totalPages: 8, remainingPages: 0 }`，备份文件可用 `readonly` 打开并列出 `_migrations` / `pages` / `page_versions`。
- **命名卷**：新建命名卷会继承镜像内 `/app/data` 的属主 `1000:1000`，以 `--user 1001:1001` 运行时写入被拒（`touch: cannot touch '/app/data/ok2': Permission denied`），故非默认 uid 时需按第 3 节补一次 chown。
- **退出码命令**：`docker compose stop && docker inspect -f '{{.State.ExitCode}}' geewiki-app` 会报 `error: no such object: geewiki-app`（compose 生成的容器名带项目前缀），按第 10 节的 `$(docker compose ps -aq geewiki-app)` 写法返回 `0`。

### 外部插件与容器集成的复验（同一环境）

- **未挂载 config 卷不再是"死壳"**：不挂 `./config` 直接 `docker run --rm -d -p 3100:3000 geewiki:bc` 时，`/api/health` 返回 `{"ok":true,...,"db":{"present":true}}`。镜像内的 `/app/config/plugins.base.json`（`node:node`；**内容即仓库根 `config/plugins.base.json`，当前默认启用 21 条内置插件**）由构建阶段的 `COPY --from=builder /src/config /app/config` 带入。**反证**：把配置目录指向不存在的路径（`-e GEEWIKI_CONFIG_DIR=/tmp/emptycfg`）时，日志只剩 `[@geewiki/manager] http 路由服务不可用：REST API 未挂载（@geewiki/http 未在清单中？）`，进程以**退出码 0** 结束（`status=exited exit=0`）、端口无监听，随后会被 `restart: unless-stopped` 反复拉起——静默重启循环，这正是镜像必须自带默认清单的原因。
- **外部插件在容器内被发现并可热插拔**：挂载 `./plugins`、`./config` 与数据目录后启动，日志出现 `[server] 外部插件目录: /app/plugins` 与 `[manager:discovery] 已发现外部插件 @geewiki-plugin/hello@0.1.0（hello-geewiki）`；`/api/plugins` 列出全部内置插件 + 该外部插件（**当时**为 4 内置 + 1 外部；当前内置 25 注册 / 21 默认启用）；`POST /api/plugins/@geewiki-plugin%2Fhello/enable` 返回 `state:active, layer:session`，其自带路由 `GET /api/hello` 返回插件响应；`disable` 后该路由回到 404，宿主 `config/plugins.base.json` 与 `plugins.session.json` 的 md5 与操作前一致。
- **工作目录无关性**：以 `--entrypoint tsx geewiki:bc /app/src/index.ts -w /tmp` 启动（即覆盖工作目录）时，镜像内置的 `GEEWIKI_PLUGINS_DIR=/app/plugins` 仍使发现根为 `/app/plugins`、发现 1 个外部插件；作为反证，显式传相对值 `-e GEEWIKI_PLUGINS_DIR=plugins` 时发现根变为 `/tmp/plugins`、发现 0 个插件且**不报任何错**（`/api/plugins` 只剩内置插件——当时 4 条，当前 25 条）——这正是镜像内必须固化绝对路径的原因。

### PostgreSQL 端到端验证（真实 PostgreSQL 15.19，已完成）

**这一轮验证的读数**（记录自原 `docs/review/plugin-freedom-audit.md` §F19；该文档随本轮文档整理删除，故这段记录**落到本文件**）：

**环境（可复现）**：

```bash
docker run -d --name gw-pg-verify -e POSTGRES_PASSWORD=… -e POSTGRES_USER=geewiki \
  -e POSTGRES_DB=geewiki -p 55432:5432 postgres:15
# 配置：把 config/plugins.base.json 的 @geewiki/db-sqlite 换成 @geewiki/postgres
#   （host 127.0.0.1 / port 55432 / passwordEnv GW_PG_PASSWORD），search 暂不启用
GEEWIKI_PORT=3101 GW_PG_PASSWORD=… pnpm start
```

**读数（真实 PostgreSQL 15.19）**：`db-postgres` **13 个迁移全部应用、迁移失败 0**；插件 **20 active / 0 error**；`POST /api/auth/setup` → **201**；`POST /api/auth/login` → **200**；`PUT /api/pages/pg-e2e` → **200**（`outcome: created`, `version: 1`）；`GET /api/pages/pg-e2e` 返回正文与写入**逐字一致**；`psql -c "select slug,title from pages where slug='pg-e2e'"` → `pg-e2e | PG 端到端验证`；`GET /api/pages` 能看到 `builtin-docs` 在 PG 上创建的文档。

> ⚠️ **时点说明**：该轮读数取数于审计报告归档提交 `de53b2f`（2026-09-17 14:04）**之前**，当时 `packages/db-postgres/migrations/` 有 13 个文件。当前 HEAD `98b0ddd` 下该目录为 **15 个**（`0022_invitation_open_code.sql` / `0023_invitation_accepted_by.sql` 于 2026-09-17 17:16 / 17:51 加入）。**迁移数与 active 插件数请以实跑为准。**

**该轮抓出并修掉三个「SQLite 上全绿、PG 上必炸」的真缺陷**：

1. `@geewiki/ai-journal` 的迁移 SQL 用 SQLite 专有的 `INTEGER PRIMARY KEY AUTOINCREMENT`（报错原文 `syntax error at or near "AUTOINCREMENT"`）⇒ 新增 `packages/plugin-ai-journal/migrations-postgres/0001_ai_mutations.sql` 改用 `INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`，调用点改为 `await asAsync(db).migrate(journalMigrationsDirFor(db.dialect))`，清单声明 `migrations: { default, postgres }`。
2. `@geewiki/builtin-docs` 用 `ctx.get('db') as DatabaseAdapter` 按**同步**接口调用，而 PG 适配器的 `query` 返回 **Promise** ⇒ `.map` / `[0]` 失效（症状 `db.query(...).map is not a function`）。**类型断言本身在撒谎，所以类型检查拦不住**——修法是在**获取点**用 `asAsync(dbRaw)` 归一化（归一化后忘写 `await` 会直接是类型错误）。
3. `@geewiki/ai-summary` 有 6 处同类同步式调用（含跨行 `.map()`），同样改为 async + `await`。

**两条类级守卫**（会随 `pnpm test` 一起跑）：

- `packages/manager/test/migrations-dialect.test.ts`（6 例）：用了 SQLite 专有语法的迁移目录必须配 `migrations-postgres/` 且**文件名一一对应**，或登记进 `SQLITE_ONLY` 并写明理由；判据含 `CREATE VIRTUAL TABLE` / `USING fts5`；含 `db-sqlite` ↔ `db-postgres` **编号对应**检查（防"给 SQLite 加了表、忘了 PG"）；`SQLITE_ONLY` 登记**不得过期**。
- `packages/manager/test/db-dual-track.test.ts`（2 例）：凡**在代码里**取 `ctx.get('db')` 的源文件必须出现 `asAsync`；先断言枚举到的消费方 ≥8 且含预期成员，避免判据写坏后**空集通过**；当前 11 个消费方全部合规。
- 两条守卫都**先剥注释再断言**（解释"旧写法错在哪"的注释里必然引述旧代码/旧消息，不剥注释就会把解释当违规）。

> **这段读数没有入库为可复跑资产**：`data/verify/` 与 `scripts/acceptance/` 下**都没有 PG 目录**。要回归请按上面的环境**实跑**；上面两条守卫会随 `pnpm test` 一起跑。
