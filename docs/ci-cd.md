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

注意：tag 推送**不会**产生 `latest`（`latest` 只跟随默认分支）。

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

> **首次发布后需手动设置镜像可见性**：GHCR 上的 package 默认是 **private**，
> 即使仓库是 public 也一样。公开分发需到
> `https://github.com/orgs/GEELINX-LTD/packages` 打开该 package 的
> Package settings → Change visibility → Public。

---

## 5. 依赖更新

`.github/dependabot.yml` 每周一 09:00（Asia/Shanghai）检查三类更新：

- **npm**：仓库根的 pnpm workspace（Dependabot 在根目录即可识别全部工作区包）；
  minor/patch 合并为单个 PR 以降低噪音，major 单独开 PR 便于逐个评估。
- **github-actions**：`actions/*`、`docker/*` 等 action 版本。
- **docker**：`Dockerfile` 的基础镜像 `node:22-bookworm-slim`。

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

## 7. 建议：为 main 配置分支保护

CI 只有在被强制时才能拦住合入。建议在
`Settings → Rules → Rulesets` 为 `main` 添加规则，要求以下状态检查通过后再合并：

```
lint
typecheck
test
build
```

> 作业名刻意使用 ASCII（而非中文描述），就是为了让这些检查名便于在 ruleset 里填写与维护。
> **改动 `.github/workflows/ci.yml` 中的 `name:` 时，需同步更新 ruleset。**
