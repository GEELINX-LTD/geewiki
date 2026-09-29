# AGENTS.md

给 AI 编码代理的**唯一入口**。这里只放**你自己读代码读不出来**的东西——
目录结构、框架惯例、依赖清单一律不写，那些请自己看。

产品理念（一切取舍的裁判）：**万物皆插件的积木式 Wiki · 极致轻量 · 高可扩展 · 安全可控 · 不绑厂商**。
展开见 [README.md](README.md) 与 [docs/architecture.md](docs/architecture.md)。
发现**代码与理念不符**时，写进 [docs/agent/backlog.md](docs/agent/backlog.md)，不要因为"文档说应该这样"就硬改代码。

## 改任何东西之前，按任务读这一份

| 你要做的事 | 先读 |
|---|---|
| 任何改动，第一次进仓库 | [CONTRIBUTING.md](CONTRIBUTING.md)（**尤其 §2「首次克隆的三个坑」**） |
| 跨包改动 / 拿不准依赖方向 | [ARCHITECTURE.md](ARCHITECTURE.md) §3 依赖图 + §4 十二条硬不变量 |
| 写或改插件 | [docs/plugin/index.md](docs/plugin/index.md) → `quickstart` → `api-reference`，收口看 `anti-patterns` + `review-checklist` |
| 仓库细则（命名/迁移/测试/密钥） | [docs/agent/conventions.md](docs/agent/conventions.md) |
| 要做**跨切面**改动（安全语义、依赖图、构建模型、CI 契约、清单 schema） | 先写 ADR，见 [docs/adr/README.md](docs/adr/README.md) |
| 想知道哪里已经烂了 | [docs/agent/backlog.md](docs/agent/backlog.md)（F1–F30，含"未能复现"，**别重复调研**） |
| 部署 / 环境变量 | [docs/deployment.md](docs/deployment.md) |
| CI 为什么红 | [docs/ci-cd.md](docs/ci-cd.md) |

**为什么要有这张表**：本仓文档之间存在明确的**权威边界**（同一个事实只允许一个出处，见
[docs/README.md](docs/README.md) §事实的真源）。绕过它去改，就会造出第二真源——
那正是本仓最贵的历史病。

## 命令（`package.json` 里没有的别自己发明）

```bash
pnpm install          # 之后必须 pnpm build，否则 3000 端口没有界面（web 产物不参与 dev 的构建）
pnpm dev              # POSIX shell；Windows 要分两终端跑 dev:server + dev:web
pnpm typecheck && pnpm lint && pnpm test
pnpm docs:links       # 死链检查，阻断
pnpm docs:conventions # 文档规范检查，默认只报告（R1 未登记 / R2 行号引用 / R3 私有端点）
```

- **测试是 `node:test` + `tsx`，不是 Vitest/Jest**；198 个测试文件，`pnpm test` 用 `--no-bail`。
- **8 个 `e2e-*.sh` 不在 `pnpm test` 里**，要手动跑且必须自选端口（如 `PORT=46101 bash packages/plugin-wiki/test/e2e-p3a.sh`）；
  `plugin-oidc` 那条要同时给 `PORT` 和 `IDP_PORT`，否则 issuer 变成 `http://127.0.0.1:undefined/`。
- **`scripts/acceptance/` 是零依赖 CDP 脚本，不是 Playwright**；dev 与 prod 必须各跑一遍（Vite 的 `?import` 改写只在 dev 出现）。
- **`.pnpm-store` / `.npm-cache` 在本仓内**（`pnpm-workspace.yaml` 的 `storeDir`/`cacheDir` **必须是相对路径**，绝对路径会同时破坏 CI / Docker / Dependabot —— 见 ADR-0005）。

## 机器不拦、但必须守住的（`ARCHITECTURE.md` §6 有完整理由）

- **`eslint` 刻意不是 type-aware**，且没有 prettier / biome（ADR-0004、ADR-0008）。别为了"更严格"引入类型感知规则或格式化器。
- **注册 HTTP 路由必须显式写 `access`**。省略第 4 参会静默变成 `public`；
  `GEEWIKI_STRICT_ROUTE_ACCESS=1` 只在启动期审计，不是编译期保证。
- **插件清单的 `permissions` 是声明，不是沙箱**——进程内、无配额、无隔离（ADR-0006）。
  别写出"看起来被权限挡住了"的代码或文档。
- **改了插槽 / Manifest / 宿主 API 就要同步 4 处**：`core` 契约、`manager` 校验、`web` 宿主镜像、文档地图。
  插槽名与 props 契约由 `SLOT_PROPS_SCHEMA` + 两条镜像测试钉住；漏一处是静默空白页，不是报错。
- **`provides` 只是依赖图 token，不会替你造服务。**

## 文档纪律（agent 违反率最高，且有门禁）

- **禁止在文档里写「源码路径 + 冒号 + 行号」这种引用**——行号必腐。写「路径 + 符号名」或行为描述。
  `pnpm docs:conventions` 的 R2 会统计存量（集中在 `docs/design/` 与 `docs/changelog/`，那是历史记录，**不要批量改**）。
- **新增文档必须在 [docs/README.md](docs/README.md) 登记**，并在地图里划清权威边界；未登记 = 第二真源。
- **删除或改名文件要全仓改引用**，改完跑 `pnpm docs:links`（它是阻断的）。
- **`docs/changelog/implementation-log.md` 不是当前口径**，别拿它当事实来源。

## 提交与 PR

- Conventional Commits，**subject 用中文**，scope 用包名或域名；`commitlint` + `husky` 已在本地拦截。
- CI 的 `lint / typecheck / test / build` 是分支保护的 required checks，**作业名不能改**。
- 跨切面改动没有 ADR 就别提 PR（模板会问你 ADR 编号）。

## 一句话总结

先确认**这件事是不是已经有人做过 / 该不该做**（`docs/plugin/index.md` §2、`docs/agent/backlog.md`），
再确认**改动会碰到几处真源**，最后才动手。本仓的失败模式从来不是写不出来，而是**造出第二个真源然后慢慢腐烂**。
