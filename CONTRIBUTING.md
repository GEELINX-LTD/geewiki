# 贡献指南

这份文档只回答一件事：**在这个仓库里，怎么把一次改动正确地送到 `main`**。

架构约束看 [ARCHITECTURE.md](ARCHITECTURE.md)，设计真源看 [docs/](docs/README.md)，
这里只写**流程**与**别处查不到的坑**。已经在真源里写清楚的东西，本文一律链接过去，
不复制内容——按 [docs/README.md](docs/README.md)「文档纪律」的说法，同一事实抄两处必然漂移。

- 架构与分层不变量 → [ARCHITECTURE.md](ARCHITECTURE.md)
- 工程约定与坑（沙箱限制、迁移约定、方言差异、验收纪律）→ [docs/development.md](docs/development.md)
- CI/CD、镜像、分支保护 → [docs/ci-cd.md](docs/ci-cd.md)
- 部署与运维 → [docs/deployment.md](docs/deployment.md)
- 插件契约与已知限制 → [docs/plugin-platform.md](docs/plugin-platform.md)
- 跑起来 / 配置 → [README.md](README.md)

---

## 1. 环境准备

| 项 | 要求 | 依据 |
| --- | --- | --- |
| Node.js | `>=22` | 根 `package.json` 的 `engines.node` |
| pnpm | 11.x（当前锁在 `pnpm@11.7.0`） | 根 `package.json` 的 `packageManager`；CI 的 `.github/actions/setup/action.yml` 不写版本号，就是为了让 `packageManager` 当唯一真源 |

装依赖：`pnpm install`。

**仓库里没有、也不用去找**：`Makefile`、`.nvmrc`、`.env.example`、`prettier`/`biome` 配置、
`commitlint` 配置文件、`husky/`、`lint-staged` 配置、任何覆盖率工具。
理由写在 [eslint.config.js](eslint.config.js) 的文件头注释里：**不做纯风格偏好**，
缩进/引号/分号交给 `.editorconfig` 与各包既有写法；CI 时间花在能发现缺陷的地方。
所以：**不要顺手加一个 formatter**，那是一次需要 ADR 的架构决策（见 [ADR-0008](docs/adr/0008-no-code-formatter.md)）。

> `pnpm-workspace.yaml` 里的 `storeDir: .pnpm-store` 与 `cacheDir: .npm-cache` **必须保持相对路径**。
> 改成绝对路径会让 CI、Docker 构建与 Dependabot 一起坏掉，历史与实验数据见
> [docs/ci-cd.md](docs/ci-cd.md) 的 pnpm store 章节；对应的提交是
> `fix(pnpm): store/cache 改用相对路径，修复他人克隆与 Dependabot 更新`。
> 想改成本机绝对路径，用环境变量覆盖：`PNPM_CONFIG_STORE_DIR` / `PNPM_CONFIG_CACHE_DIR`
> （`npm_config_store_dir` 这个拼法**无效**；`pnpm config set --location project` 会写进入库文件，**禁止使用**）。

---

## 2. 首次克隆的三个坑

```bash
pnpm install
pnpm build                                       # ① 必须
pnpm --filter @geewiki/web run build:fixtures    # ② 必须（不在 pnpm build 内）
pnpm dev                                         # ③
```

- **① 不 `pnpm build` 就没有界面**。`pnpm dev` 只起 Vite（5173）和后端（默认 3000），
  而 3000 端口要的是 `packages/web/dist` 里的构建产物；没 build 时打开 3000 是空的。
- **② 插件 UI 产物是另一条命令**。根 `package.json` 的 `build` 脚本原文是
  `pnpm -r --if-present run build`，而只有 `@geewiki/web` 有 `build` 脚本，
  `build:fixtures` / `build:plugin-ui` / `build:builtin-ui` 都不叫 `build`，
  所以**不会**被 `pnpm build` 带起来。产物缺失时宿主不报错，只在入口表里记
  `skipped: entry_missing`——这个"静默降级"曾让验收脚本陈旧了整整一批。
  细节见 [README.md](README.md) 的「仓库结构」。
- **③ `dev` 脚本是 POSIX shell 写法**。根 `package.json` 的 `dev` 用了 `&`、`$!`、`$?`、
  `kill`，在 PowerShell / cmd 下跑不起来。Windows 贡献者请开两个终端：
  `pnpm dev:server` 与 `pnpm dev:web`。

---

## 3. 根 `package.json` 脚本全集

| 命令 | 用途 | 备注 |
| --- | --- | --- |
| `pnpm dev` | 同时起后端（`tsx packages/server/src/index.ts`）与前端（Vite） | POSIX shell；Windows 用下面两条 |
| `pnpm dev:server` | 只起后端 | 前端另开终端 |
| `pnpm dev:web` | 只起前端（Vite） | |
| `pnpm build` | 递归跑各包的 `build` | 实际只有 `@geewiki/web` 会构建；**不含**插件 UI 的 `build:fixtures` |
| `pnpm start` | 用 tsx 直跑 `packages/server/src/index.ts` | 生产镜像里也是 tsx，服务端包**没有构建步骤** |
| `pnpm typecheck` | 递归 `typecheck` + `tsc --noEmit -p tsconfig.scripts.json` | `--no-bail` 会跑完所有包再失败，别只看最后一行 |
| `pnpm test` | 递归各包 `test` | 只跑无浏览器、无网络的单测，见 §6 |
| `pnpm lint` | `eslint . --max-warnings 0` | **警告即失败**（`ba47fb9 fix(lint): 9 条警告清零，并把 lint 从"警告照过"改成硬门禁`） |
| `pnpm run lint:fix` | `eslint . --fix` | |
| `pnpm run new:plugin <名>` | 生成插件脚手架（`scripts/create-plugin.ts`） | 加 `--ui` 同时生成界面产物链；`--dry-run` 只看落点 |
| `pnpm run backup` | SQLite `VACUUM INTO` 快照 | 产物自包含，不带 WAL 边车；`--out` / `--repo-root` |
| `pnpm run restore` | 从快照恢复 | **刻意不是 HTTP 路由**；要求先停服务；`--verify-only` / `--force` |
| `pnpm run install-plugin` | 安装外部插件（目录 / tgz / https URL） | `--dry-run` / `--name` / `--force` / `--verify`（完整性校验） |
| `pnpm run clean:tmp` | 清理 `tmp/` 残留 | 默认 dry-run；`--yes` / `--all` / `--older-than N`；判据在 `packages/manager/src/maintenance.ts` |

数据库备份/恢复与部署相关的完整说明在 [docs/deployment.md](docs/deployment.md)，不在本文重复。

---

## 4. 代码风格

**唯一风格来源是 [.editorconfig](.editorconfig)**（UTF-8、LF、2 空格、去行尾空格、文件末尾换行），
而它**没有机器校验**——编辑器不配 editorconfig 插件就会静默产出 4 空格或 CRLF 的文件。
请自己配好，否则 diff 里全是噪音，Review 时会被要求重做。

`eslint.config.js` 里值得知道的几条：

- **刻意不启用 type-aware 规则**（`recommendedTypeChecked`）。注释给的理由是：要为 28 个包建
  project service，CI 时间成倍增长而收益有限。副作用是 `@typescript-eslint/require-await`
  拿不到类型信息而失效——所以下游代码里的 `await` 噪声得靠 Review 拦。
  想改这条请先写 ADR（[ADR-0004](docs/adr/0004-eslint-no-type-aware.md)）。
- `react-hooks/rules-of-hooks` = error、`exhaustive-deps` = warn；React Compiler 系规则**未启用**（会产大量 error）。
- `no-unused-vars` 允许 `^_` 前缀；`test/**` 与 `scripts/**` 关掉 `no-explicit-any`。
- 忽略目录：`dist`、`**/dist`、`coverage`、`public/plugins-ui`、`tmp`、`data`、`logs`、`.pnpm-store`、`.npm-cache`。

**没有覆盖率门禁**，所以"我加了测试"这件事只能靠你自己证明：新行为要有断言，
修 bug 要先有一条能复现旧行为的用例（红-绿自检），详见
[docs/development.md](docs/development.md) 的验收纪律章节。

> 并行推进中（**本节命令在落地前请勿依赖**）：commitlint + husky + lint-staged 的提交信息门禁，
> 以及 `pnpm run docs:links`（相对链接存活检查）与 `pnpm run docs:conventions`（文档规范检查）。
> 以根 `package.json` 的 `scripts` 实际输出为准；本文不会替它们背书。

---

## 5. Git 规范

### 5.1 提交信息

**Conventional Commits + 中文 subject**，`scope` 用包名或域名（去掉 `@geewiki/` 前缀的那种短名）。
仓库没有 commitlint 配置文件（正在引入中，见 §4），所以这条**目前靠 Review 把关**。

从 `git log` 里取的真实样本（照着写就行；完整历史看 `git log --oneline`）：

```
feat(wiki): 块级归属：作者列 + 服务端按作者聚合区间 + 阅读页署名/清单/筛选
feat(ai-assistant): dock 贴图不再压缩——上传原图，本地另存一份副本给 localStorage
fix(lint): 9 条警告清零，并把 lint 从"警告照过"改成硬门禁
fix(config): 本机配置出库，构建上下文不再带密钥
test(acceptance): 界面扩展平台的浏览器端到端验收 + 鉴权夹具
chore(deps): bump typescript from 5.9.3 to 6.0.3 (#6)
```

`body` 的既有写法（照抄结构，不要照抄内容）：

1. **先讲症状与根因**，再写"口径 / 为什么这样改"。
2. **引用设计真源的章节**，例如 `docs/design/attachments.md §6.1`、`docs/design/block-attribution.md`；
   引用**章节号**而不是行号。
3. **引用 PR / issue 编号**，例如 `(#6)`、`Merge pull request #10 from ...`。
4. 涉及"验证过什么"时，末尾单列一段**读数**：写明跑了哪些命令、HEAD 是哪次提交、取数时刻，
   以及**哪些没实测**。理由见 [docs/development.md](docs/development.md) 的验收纪律——
   过时的数字比没有数字更坏。

### 5.2 分支命名

真实样本：`feat/p1-identity`、`feat/p15-oidc`、`feat/p3a-blocks`、`feat/p3a-blocks-cont`、
`feat/p4-audit-ops`、`feat/p4b-ops-ui`、`feat/p2-org-visibility`、`feat/p3bcd-block-acl`、
`feat/m5b-redlink-tristate`、`feat/p0-route-auth-guard`、`fix/docker-build-builtin-plugin-ui`、
`fix/markdown-image-not-page-link`、`dependabot/npm_and_yarn/*`。

约定：`<type>/<阶段号>-<短slug>` 或 `fix/<slug>`。阶段号（P0/P1/P1.5/P2/P3a/P3bcd/P4/M5…）
对应 [docs/roadmap.md](docs/roadmap.md) 与 [docs/design/access-control.md](docs/design/access-control.md)
的分阶段计划，方便从分支名反查设计文档。

### 5.3 目标分支

日常就是 **分支 → PR → `main`**。管理员拥有直推 `main` 的 bypass 权限（ruleset 的
`bypass = RepositoryRole admin`，`always`）——**这是便利，不是推荐路径**：
绕过 CI 的四条必需检查，就等于把 [docs/ci-cd.md](docs/ci-cd.md) 里的保护形同虚设。

---

## 6. 测试：怎么写、怎么跑

### 6.1 单元测试

框架是 **`node:test` + tsx**，不是 vitest / jest。各包的 `test` 脚本统一是：

```
node --import tsx --test test/*.test.ts
```

- 测试文件放各包的 `test/*.test.ts`。
- 跑全包：`pnpm test`（`--no-bail`，会跑完所有包）。
- 跑单包：`pnpm --filter @geewiki/manager test`。
- **跑单文件**：进到包目录里直接 `node --import tsx --test test/<你的文件>.test.ts`。
- 少数包只有 `typecheck` 没有 `test`（`@geewiki/echo`、`@geewiki/editor-plain`）。
- 数量类读数**不要抄文档**，以 `pnpm test` 的实时输出为准（[docs/README.md](docs/README.md)「事实的真源」）。

写测试时有两条仓库特有的纪律：

- **源码级守卫测试**是常用手段：当一个事实必须在多处表示（插槽名在 core 与 web 两处）、
  或一条约束只能从迁移文本上判断（典型：哪些迁移**不可重放**），就用一条读源码文本比对的测试钉住。
  先例：`packages/manager/test/migrations-dialect.test.ts`（SQLite 专有语法必须有 PG 对应版）、
  `packages/web/test/slotPropsMirror.test.ts`、`packages/core/test/slot-props-schema.test.ts`。
  **注意一个已误传过的例子**：`packages/plugin-wiki/test/slug-hierarchy.test.ts` 的 `isAddColumn` 是
  **重放策略的分类器，不是「禁止 `ADD COLUMN`」**——`packages/db-sqlite/src/migrations/` 里有 8 个迁移真的在用加列。
  把分类器当禁令会写出与仓库现状相反的规则（详见 ADR-0003）。
- **不要为了让测试变绿而放宽守卫**。守卫变红通常意味着你真的违反了约定，
  除非你能论证守卫本身判据错了，并在 PR 里说明。

### 6.2 e2e shell 脚本（**不在 `pnpm test` 内**）

它们会真的起一个服务、占一个端口、发真请求，所以刻意排除在 CI 的 `test` 作业之外。
全部支持 `PORT="${PORT:-<默认值>}"` 覆盖，起服务时统一用
`env GEEWIKI_DATA_DIR="$TMP/data" GEEWIKI_PORT="$PORT" node --import tsx packages/server/src/index.ts`，
并轮询 `/api/health` 等到就绪。

| 脚本 | 默认端口 | 前置条件 |
| --- | --- | --- |
| `packages/plugin-auth/test/e2e-p1.sh` | 39311 | 无 |
| `packages/plugin-authz/test/e2e-p2.sh` | 43111 | 无；可选 `GEEWIKI_E2E_PG=1` 跑 PG 轨 |
| `packages/plugin-authz/test/e2e-p4.sh` | 53501 | 无；用 `x-gw-admin-token` 走 break-glass |
| `packages/plugin-oidc/test/e2e-p15.sh` | 42912（+ mock IdP 42911） | 脚本自起 `packages/plugin-oidc/test/mock-idp.mjs`；**必须 `export PORT` 与 `export IDP_PORT`**，否则 issuer 会变成 `http://127.0.0.1:undefined/` |
| `packages/plugin-org/test/e2e-p2-org.sh` | 43201 | 无 |
| `packages/plugin-wiki/test/e2e-p3a.sh` | 47111 | 无；健康检查要求响应里 `"present":true`；可选 PG 轨 |
| `packages/plugin-wiki/test/e2e-attachments.sh` | 47112 | 无 |
| `packages/plugin-wiki/test/e2e-version-meta.sh` | 47121 | 无；可选 PG 轨 |

用法示例：

```bash
PORT=46101 bash packages/plugin-auth/test/e2e-p1.sh
GEEWIKI_E2E_PG=1 PG_DB=geewiki_e2e_clean bash packages/plugin-wiki/test/e2e-p3a.sh
```

**端口分段惯例**（来自 [docs/development.md](docs/development.md)，手工验证时按批次挑一段，避免撞车）：
41xxx PG 验证 · 42xxx P1.5 · 43xxx P2 · 45xxx 合并验证 · 46xxx M5 合并 · 47xxx P3a ·
48xxx M5 前端 · 50xxx P3bcd。

**PG 轨**：本地容器 `geewiki-pg-test`（`postgres:15-alpine`，监听 `127.0.0.1:55432`，
用户 `geewiki` / 密码 `testpw`）。共享库 `geewiki_test` 已被历史数据"中毒"，
请建干净库 `geewiki_e2e_clean`。隔离启动配方与必须轮询 `/api/health` 的原因见
[docs/development.md](docs/development.md)。

`plugin-search` 在 PG 下报 `0001_search.sql error: syntax error at or near "VIRTUAL"`
**是预期行为**（显式方言守卫），不是回归。

### 6.3 浏览器侧验收（CDP）

`scripts/acceptance/` 下的脚本零依赖直连 Chrome DevTools Protocol，
需要 Chrome + 一个跑起来的实例 +（多数场景）已构建的插件产物，因此**刻意不进 `pnpm test`**
（后者只跑无浏览器、无网络的单测）。

```bash
node scripts/acceptance/plugin-ui-cdp.mjs http://127.0.0.1:3000 9451     # prod（先 pnpm build && pnpm start）
node scripts/acceptance/plugin-ui-cdp.mjs http://localhost:5173 9452     # dev（dev 与 prod 必须各跑一遍）
```

- Chrome 要以 `--remote-debugging-port=<cdpPort>` 启动（headless 亦可）。
- 启停插件需要 admin 会话：共用夹具 `scripts/acceptance/lib/session.mjs` 会在三条路径里自动选
  （实例启动时设 `GEEWIKI_ADMIN_TOKEN` 走 break-glass / 无账号时 `POST /api/auth/setup` / 固定验收账号登录），
  并自动带 `cookie` 与 `x-gw-csrf`；拿不到凭据时**明确跳过**而不是记通过。
- dev 与 prod 要各跑一遍：Vite 的 `?import` 改写只在 dev 出现。
- 只在 Chromium 上实测过（Safari / Firefox 未验证）。

### 6.4 前端行为不能用 curl 代替

[docs/development.md](docs/development.md) 明写这条纪律：**真实浏览器交互从未被自动验证覆盖**。
界面改动请用 §6.3 的脚本或手工浏览器验证，并在 PR 里说明验了什么、没验什么。

---

## 7. 数据库迁移

改表结构 = **必须双方言成对**。完整约定见 [docs/development.md](docs/development.md)「迁移约定」，
这里只列最容易踩的：

- **落点**：`packages/db-sqlite/src/migrations/` 与 `packages/db-postgres/migrations/` **成对新增**。
  **不要**写进 `packages/plugin-*/migrations`（`@geewiki/wiki` 只声明 `sqlite` 方言）。
- **SQLite 没有 `ADD COLUMN IF NOT EXISTS`** ⇒ 加列迁移无法重放。守卫测试已把这条钉死，
  **新列必须内联写在 `CREATE TABLE` 里**（P2 在 0012 迁移上踩过）。
- 守卫是**基于文本启发**的（匹配 `\bADD\s+COLUMN\b` 之类），**注释里写这几个词也会被误判**。
- `packages/server/test/builtin-migrations.test.ts` 会校验清单里的 `migrations` 声明与目录实际内容
  是否对得上；`packages/manager/test/migrations-dialect.test.ts` 与
  `packages/manager/test/db-dual-track.test.ts` 是双方言成对的守卫。
- `WIKI_MIGRATIONS_DIR` 是单目录双方言共用 ⇒ 同一份 SQL 必须两种方言都能跑，**不要写 `BEGIN`/`COMMIT`**。
- PG 侧三个反复出现的坑（聚合返回字符串要 `Number()`、`RETURNING id` 必需、
  每处 `blocks_fts` 语句都要方言守卫）见 [docs/development.md](docs/development.md)「PG 方言」。

---

## 8. 密钥与配置纪律

- **不进版本库**：`config/` 整个目录在 `.gitignore` 里默认忽略，只有
  `config/plugins.base.example.json`（随版本发布的默认清单）入库。本机 live 的
  `config/plugins.base.json`、`config/plugins.session.json`、`config/secrets.json` **都不入库**
  （`.dockerignore` 有同名的默认拒绝规则）。
  **提 PR 前跑一次 `git status --porcelain config`，输出必须为空。**
- **不进配置**：任何写 `plugins.*.json` 的路径都先剥掉密钥字段（见 `packages/manager/src/index.ts`
  的 `Manager.absorbSecrets` 与 `packages/manager/src/secrets.ts`）。
- **不回显**：HTTP 配置接口只回 `secrets: { apiKey: true }` 这样的布尔，不回原值；
  清除走请求体里的 `clearSecrets: string[]`。
- **文件权限 0600**：`SECRETS_FILE_MODE`（`packages/manager/src/secrets.ts`）。
- **`apiKeyEnv` 是环境变量名，不是密钥值**。校验在 `packages/plugin-llm/src/credentials.ts`
  的 `resolveCredential` / `isEnvVarName`（白名单：全大写 + 下划线），非法值报 `INVALID_CREDENTIAL`。
  解析顺序是**界面填写的密钥优先**，其次 `apiKeyEnv` 指向的环境变量
  （见 `packages/plugin-llm/src/settings.ts`）。
- **不要把真实密钥、私有 endpoint、真实 token 写进**：文档示例、测试夹具、e2e 脚本、
  commit message、PR 描述。写进去了就当作已泄露处理（轮换 + 清理历史）。
- 相关守卫测试：`packages/manager/test/secrets.test.ts`、
  `packages/db-postgres/test/secret-discipline.test.ts`。
  历史事故：`fix(config): 本机配置出库，构建上下文不再带密钥`（`3e04049`）、
  `fix(security): apiKeyEnv 改白名单校验，堵住明文密钥落盘入库配置`（`3acf388`）。

---

## 9. CI 与 PR

唯一 workflow 是 [.github/workflows/ci.yml](.github/workflows/ci.yml)（name `CI/CD`）。
完整说明看 [docs/ci-cd.md](docs/ci-cd.md)，这里只列**改动时必须知道的硬约束**：

- 作业名 `lint` / `typecheck` / `test` / `build` 被仓库 ruleset `main-protection` 的
  required status checks 引用（且 `require_branch_up_to_date`），**不得改名**。
  要改名必须同步改 ruleset——那是 GitHub 上的仓库设置，不在本仓库文件里。
- `docker-build` 只在 `pull_request` 跑（`push: false`）。
- `publish` 有 `needs: [lint, typecheck, test, build]` 四道门禁；镜像名
  `IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}` **必须小写化**（属主 `GEELINX-LTD` 含大写，而 GHCR 要求小写）。
  tag 推送时用 `gh release create --generate-notes` 发 Release，先 `gh release view` 判存在 ⇒ 幂等。
- **GHCR 包可见性改成 public 需要人工在 UI 操作**（包级管理员；API `PATCH` 会返 404），见
  [docs/ci-cd.md](docs/ci-cd.md)。
- **不要给 PR 加 `paths-ignore`**：必需检查会因为不触发而**永久 pending**，PR 直接卡死。
- 作业名刻意用 ASCII（历史教训见 [docs/ci-cd.md](docs/ci-cd.md)）。
- 并发策略：PR `cancel-in-progress`，`main` 不取消。

提交 PR 时按 [.github/pull_request_template.md](.github/pull_request_template.md) 的清单逐项勾选——
那不是装饰，每项都对应一次真实踩过的坑。

---

## 10. 文档同步（事实真源）

改了行为，就要改**那一类事实的真源文件**。真源表在
[docs/README.md](docs/README.md)「事实的真源」；写作纪律（结论优先、不用"修正"块打补丁、
**具体读数必须给出取数方式**、删除/改名文档要同步全仓引用）在同页「文档纪律」。

三条最容易违反的：

1. **不要写死会腐化的读数**（测试条数、包数量、启用插件数）。要提就写"以 `<命令>` 输出为准"。
   仓库里的反面教材：`.github/workflows/ci.yml` 的注释曾写"177 个测试文件"，
   而实际数量早已变化；[docs/development.md](docs/development.md) 的验证基线一节也留着
   过期的"17 个包 / 886 通过"。**别重复这个错误。**
2. **引用代码用「路径 + 符号名」，不要用行号**。行号会漂移；
   [docs/architecture.md](docs/architecture.md) 里已经有一段"历史引用说明：行号不再对应"的自认腐化。
3. **涉及架构取舍的改动，同时写一篇 ADR**（`docs/adr/`，MADR 精简格式），
   并在 commit body 与 PR 里引用编号（如 `ADR-0003`）。已有清单看
   [docs/adr/](docs/adr/0001-cordis-plugin-graph-and-node-http.md)。

---

## 11. 提 PR 之前

```bash
pnpm lint
pnpm typecheck
pnpm test
git status --porcelain config          # 必须为空（本机配置/密钥没入库）
```

界面改动另跑：`pnpm build && pnpm --filter @geewiki/web run build:fixtures && pnpm start`，
再用 `scripts/acceptance/` 里的对应脚本或手工浏览器过一遍。
改动涉及表结构，加跑双方言守卫与（有 PG 环境时）`GEEWIKI_E2E_PG=1` 的 e2e。

然后照 [.github/pull_request_template.md](.github/pull_request_template.md) 填 PR。
