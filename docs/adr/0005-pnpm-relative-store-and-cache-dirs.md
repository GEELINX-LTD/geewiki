# 0005. pnpm 的 storeDir / cacheDir 用相对路径

- 状态：`accepted`（回填：`pnpm-workspace.yaml` 里的注释就是这条决策的墓碑）
- 记录日期：2026-09-28
- 关联：ADR-0002（运行期形态）、ADR-0009（最小部署）、`docs/ci-cd.md`

## 技术背景

本仓不用 npm（根目录没有 `package-lock.json`），包管理器固定 pnpm。
`pnpm-workspace.yaml` 里额外钉了两行：

```yaml
storeDir: .pnpm-store
cacheDir: .npm-cache
```

两者都在仓库内、都在 `.gitignore` 里。

## 考虑选项

| 选项 | 为什么不选 |
|---|---|
| **不写这两行**（用 pnpm 默认的全局 store） | 每台机器一份全局 store，换 node 版本/换机器就要重下；CI 缓存 key 与本地行为不一致 |
| **写机器的绝对路径**（如 `/home/me/.pnpm-store`） | **这条路踩过坑**：pnpm 会把 store 绝对路径解析结果写进 `pnpm-lock.yaml` 的 resolver 信息，换一台机器就装不出来 |
| 写相对路径 | 见下方决策 |

## 决策结果

**只用相对路径**，指向仓库内的 `.pnpm-store` / `.npm-cache`。

`pnpm-workspace.yaml` 的注释原文（务必保留）：
「必须用**相对路径**——绝对机器路径会被写进 `pnpm-lock.yaml` 的解析信息，CI / Docker / Dependabot
上该路径不存在，导致依赖安装全线失败，且失败现象与病因相距很远（表现为 lockfile 损坏或找不到包）。」

`.github/workflows/ci.yml` 的安装步骤也留了同一条警告注释。

## 后果

**正面**

- 同一个 lockfile 在本地、CI runner、Docker 构建、Dependabot 上解析结果一致。
- 换 Node 版本不必重装依赖；仓库自带一份可复现的 store。

**负面 / 风险（如实）**

- **占盘**：每个克隆各有一份 store，28 个包的依赖会复制多份。
- **CI 缓存要显式处理**：store 在仓库内，缓存 key 写错等于每次重装；具体 key 以 `ci.yml` 为准。
- **改这两行属于危险动作**：任何"我本机慢，指到 `~/.pnpm-store` 试试"的改动都会污染 lockfile，
  而且失败点离病因极远。这条是 `ARCHITECTURE.md` 的 **INV-6**。
- **`docs/ci-cd.md` 与本 ADR 是同一事实的两处表述**——改一处必须同步另一处（已登记在
  `docs/agent/backlog.md`）。

## 证据与参考

- `pnpm-workspace.yaml`（两行 + 注释）、`.gitignore`、`.github/workflows/ci.yml`（安装步骤注释）
- `ARCHITECTURE.md` 的 `INV-6`、`CONTRIBUTING.md` §2（首次克隆的坑）、`docs/ci-cd.md`
- `docs/adr/0009-single-process-sqlite-minimal-deployment.md`（同一批部署契约）
