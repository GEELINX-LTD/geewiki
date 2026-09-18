# GeeWiki CI/CD 说明

> **性质**：本文说明本仓库的持续集成与持续交付流水线——跑什么、何时跑、如何发版、出问题怎么查。
> **配置文件**：`.github/workflows/ci.yml`、`.github/actions/setup/action.yml`、`.github/dependabot.yml`。
> 工程约束（沙箱、数据库、验收纪律）见 `docs/development.md`；部署运维见 `docs/deployment.md`。

---

## 1. 流水线概览

单个 workflow（名为 `CI/CD`）包含六个作业：

| 作业 | 内容 | 触发时机 |
|---|---|---|
| `lint` | `pnpm lint` —— ESLint 硬门禁 | push main / push tag / PR |
| `typecheck` | `pnpm typecheck` —— 28 个包 + `tsconfig.scripts.json` | 同上 |
| `test` | `pnpm test` —— Node 内置测试运行器，177 个测试文件 | 同上 |
| `build` | `pnpm build` —— 各包 `vite build` 等产物 | 同上 |
| `docker-build` | 构建镜像但**不推送**，验证 Dockerfile 未被破坏 | 仅 PR |
| `publish` | 构建多阶段镜像并推送到 GHCR；tag 推送时另建 GitHub Release | push main / push tag `v*` |

**`publish` 受门禁约束**：它声明了 `needs: [lint, typecheck, test, build]`，因此四个门禁
全部通过才会产出镜像。未通过测试的提交不会被发布。

**权限最小化**：workflow 默认 `contents: read`，只有 `publish` 作业单独提权到
`packages: write`（推送镜像所需）。因此 PR 触发的运行无法写入仓库或镜像仓库。

**并发策略**：同一个 PR 上连续的推送会取消旧任务；发往 `main` 的运行**不取消**，
因为其中可能正在推送镜像，中途取消会留下不完整的发布，故 main 的多次推送串行排队。

---

## 2. 本地复现门禁

CI 跑的就是根 `package.json` 里的那几个脚本，本地原样执行即可：

```bash
pnpm install --frozen-lockfile
pnpm lint        # ESLint；pnpm lint:fix 可自动修复一部分
pnpm typecheck
pnpm test
pnpm build
```

只跑单个包：

```bash
pnpm --filter @geewiki/server test
pnpm --filter @geewiki/web typecheck
```

**`node_modules` 缺失时**（例如新克隆或新 worktree）必须先 `pnpm install --frozen-lockfile`，
否则 typecheck / test 会因解析不到依赖而整体失败。

---

## 3. 环境准备的硬约束（重要）

`.github/actions/setup/action.yml` 是所有作业共用的复合 action，其中有一步
**必须在 `actions/setup-node` 之前执行**：

```bash
sed -i '/^storeDir:/d; /^cacheDir:/d' pnpm-workspace.yaml
```

原因：`pnpm-workspace.yaml` 是**入库文件**，其中 `storeDir` / `cacheDir` 指向本机沙箱的
绝对路径（`/root/dev/geewiki/.pnpm-store`）。pnpm 11 中这两个键的优先级**高于** `.npmrc`，
且**无法用环境变量覆盖**（`npm_config_store_dir`、`PNPM_STORE_DIR` 均已实测无效）。
若不删除，CI 会尝试写入 runner 上不存在的 `/root` 而失败。

顺序不能颠倒：`actions/setup-node` 的 `cache: pnpm` 会调用 `pnpm store path` 来决定
缓存目录，因此 sed 必须先于它执行，缓存才会指向正确的 store。

同样的 sed 在本仓 `Dockerfile` 第 55、65 行出于同样原因存在。本地开发不受影响——
CI 只修改 runner 上的工作副本。

---

## 4. 容器镜像（CD）

### 4.1 镜像位置与标签

推送目标：`ghcr.io/geelinkx-ltd/geewiki`

> 仓库属主 `GEELINX-LTD` 含大写字母，而 GHCR 要求路径**全小写**，
> 故 workflow 中用 `${GITHUB_REPOSITORY,,}` 做小写转换。

| 触发 | 产生的标签 |
|---|---|
| push `main` | `latest`、`main`、`sha-<短哈希>` |
| push tag `v1.2.3` | `1.2.3`、`1.2`、`sha-<短哈希>` |

`latest` **只跟随默认分支**，tag 推送不会产生它。这是显式配置的结果：workflow 里设了
`flavor: latest=false` 关掉 metadata-action 的自动行为，再用
`type=raw,value=latest,enable=${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}`
单独控制。

> ⚠️ 不要删掉 `flavor: latest=false`。metadata-action 的 `flavor.latest` 默认是 `auto`，
> 它会在**默认分支和 semver tag 推送两种情况**下都追加 `latest`（已实测：tag `v0.1.0`
> 的运行确实产出了 `latest`）。那会使「用旧提交打的 tag」把 `latest` 回退到旧镜像。

### 4.2 发版流程

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

tag 推送会先跑四个门禁，全绿后才构建并推送带版本号的镜像，
并创建一个 GitHub Release（`--generate-notes` 自动生成变更说明；
该步骤幂等，重跑同一 tag 不会因 Release 已存在而失败）。

> `contents: write` 权限只为创建 Release 而开，且仅 `publish` 作业持有；
> 其余作业与 PR 触发的运行都只有 `contents: read`。

### 4.3 部署侧拉取

```bash
docker pull ghcr.io/geelinkx-ltd/geewiki:latest
docker compose up -d --force-recreate geewiki-app
```

详细的挂载、权限、环境变量与备份恢复见 `docs/deployment.md`。

> **镜像包默认是 private，且只能手动改**：GHCR 上的 package 默认是 **private**，
> 即使仓库是 public 也一样。**改可见性需要「包级管理员」权限，无法用仓库自带的
> `GITHUB_TOKEN` 完成**（已实测：GITHUB_TOKEN 能读到 `visibility`，但
> `PATCH /orgs/{org}/packages/container/{name}` 返回 `404 Not Found`；
> 细粒度 PAT 若未勾选 Packages 权限，则连包列表都读不到，返回 403）。
>
> 修改步骤（约 30 秒）：
>
> 1. 打开 `https://github.com/orgs/GEELINX-LTD/packages/container/geewiki/settings`
> 2. 页面底部 **Danger Zone** → **Change package visibility**
> 3. 选择 **Public** 并确认
>
> 或者：给 PAT 加上 **Packages: Read and write** 权限后，用该 PAT 执行
> `gh api -X PATCH /orgs/GEELINX-LTD/packages/container/geewiki -f visibility=public`。
>
> 发布流水线里有一个**只读巡检**步骤，会把当前可见性打进 Actions 日志；
> 若仍是 private 会输出一条 notice 提醒。

---

## 5. 依赖更新

`.github/dependabot.yml` 每周一 09:00（Asia/Shanghai）检查三类更新：

- **npm**：仓库根的 pnpm workspace（Dependabot 在根目录即可识别全部工作区包）；
  minor/patch 合并为单个 PR 以降低噪音，major 单独开 PR 便于逐个评估。
- **github-actions**：`actions/*`、`docker/*` 等 action 版本。
- **docker**：`Dockerfile` 的基础镜像 `node:22-bookworm-slim`。

  > ⚠️ **Node 大版本升级要留意随镜像内置工具的变化**：Node 26 起官方镜像
  > **不再内置 corepack**，`corepack enable` 会直接报 `corepack: not found`
  > （exit 127）。本仓 Dockerfile 已改用 `npm install -g pnpm@<packageManager 版本>`，
  > 因此不受影响。这也是为什么 PR 阶段的 `docker-build` 作业值得保留 ——
  > 四个代码门禁跑在 runner 的 Node 22 上，**只有它会真正用新基础镜像构建**，
  > 从而拦住这类只在升级镜像后才暴露的破坏。

---

## 6. 未纳入 CI 的部分（诚实清单）

以下内容**刻意不进 CI**，避免把需要外部环境的东西混进主门禁：

- **`packages/plugin-auth/test/*.sh`、`packages/plugin-authz/test/*.sh`**：需要真实
  PostgreSQL 的 e2e 脚本，不在 `pnpm test` 范围内。
- **`scripts/acceptance/**`**：基于 CDP 的浏览器验收脚本，需要真实浏览器与运行中的服务。
- **Type-aware ESLint 规则**（`recommendedTypeChecked`）：需要为 28 个包建立
  project service，CI 时间成倍增长而收益有限，故未启用。副作用是
  `@typescript-eslint/require-await` 这类规则失效，代码中针对它的
  `eslint-disable` 指令已被替换为普通注释。
- **React Compiler 系 ESLint 规则**（`react-hooks/set-state-in-effect`、
  `react-hooks/refs`、`react-hooks/immutability`）：在存量代码上会产生约 52 个 error，
  需要重构 UI 才能收敛。当前只启用经典子集：`rules-of-hooks` 报错、
  `exhaustive-deps` 警告（不阻断）。

## 7. main 分支保护（已启用）

仓库已有一个名为 **`main-protection`** 的 ruleset（target: branch，
enforcement: active，作用于默认分支），包含四条规则：

| 规则 | 作用 |
|---|---|
| `deletion` | 禁止删除 `main` |
| `non_fast_forward` | 禁止强推（force push） |
| `pull_request` | 合入必须走 PR（批准人数要求 0） |
| `required_status_checks` | 必须通过以下检查，且要求分支为最新 |

必需的状态检查：`lint`、`typecheck`、`test`、`build`

**管理员豁免**：ruleset 的 bypass 列表里放了 `RepositoryRole` = admin，
`bypass_mode: always`，因此仓库管理员仍可直接推 `main`（API 返回的
`current_user_can_bypass` 为 `always`）。这样做是为了不改变本仓库既有的
直推习惯，同时对其他贡献者强制走 PR + 门禁。

> 作业名刻意使用 ASCII（而非中文描述），就是为了让这些检查名便于在 ruleset 里填写与维护。
> **改动 `.github/workflows/ci.yml` 中的 `name:` 时，需同步更新 ruleset**，否则检查会一直
> 处于 pending 而无法合入。
>
> 查看 / 修改：`https://github.com/GEELINX-LTD/geewiki/rules/23638645`，
> 或用 API：`gh api /repos/GEELINX-LTD/geewiki/rulesets`。

> ⚠️ 不要给 PR 加 `paths-ignore`（例如跳过纯文档改动）。一旦某个必需检查因路径过滤而
> 从未上报，PR 会永久卡在 pending 无法合并。
