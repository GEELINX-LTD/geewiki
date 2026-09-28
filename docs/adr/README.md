# 架构决策记录（ADR）

本目录是 GeeWiki 的**决策日志**：记录「为什么选这条路、当时放弃了什么、代价是什么」。

它**不是实现说明书**。实现细节以代码与 `docs/` 下的专题文档为准（`docs/architecture.md`、
`docs/plugin-platform.md`、`docs/deployment.md` 等）。一条 ADR 里出现的文件路径与符号名只是
**当期证据**，代码会移动、符号会改名；如果某条 ADR 的描述与代码不符，**以代码为准**，
并补一条新 ADR 说明为什么改变，而不是回头改旧文件。

## 格式

沿用 MADR 精简式（与 `0003-sqlite-fts5-primary-postgres-dual-track.md` 同构）：

```
# NNNN. 标题
- 状态：
- 记录日期：
## 技术背景
## 考虑选项
## 决策结果
## 后果            ← 必须分「正面」与「负面 / 风险（如实）」两栏
```

两条硬规矩：

1. **不锚定 commit hash / 行号**。证据一律写成「路径 + 符号名」或行为描述。
   原因很简单：行号在下一次编辑后就错了，而 ADR 是要被读半年的。
   `scripts/docs-conventions.ts` 会检查文档里的「路径:行号」式引用。
2. **负面后果不许省略**。只写优点的 ADR 等于广告，不叫决策记录。
   只有一方利益的方案（例如「引入 prettier」）也是同样：写清它被放弃的理由，
   将来有人重新提出来时不必重开讨论。

## 状态取值

| 状态 | 用法 |
|---|---|
| `proposed` | 方案已成文、尚未拍板；或回填时作者不愿替团队声称「大家同意了」；或决策已落地但带有作者认为**必须公示**的未解风险 |
| `accepted` | 已拍板并落地，当前有效。新代码遇到同类问题按它办 |
| `deprecated` | 曾经有效、现在不推荐用于新场景，但存量仍在跑，不强制迁移 |
| `superseded` | 被后续 ADR 取代。必须写明被哪一条取代（`取代：ADR-NNNN`），新 ADR 反过来也要写 `取代 / 关联：ADR-NNNN` |

状态是**追加**的：不要改历史决策的正文来反映新看法，写新的一条并让旧的变 `superseded`。

## 什么情况必须写 ADR

`CONTRIBUTING.md` 的口径是「涉及架构取舍的改动，同时写一篇 ADR」。落到本仓，下列改动
在提 PR 前必须先落一条 ADR（哪怕状态只是 `proposed`）：

- **改依赖图形状**：新增/删除包、改 `provides` / `requires` token、引入或替换 cordis
  这一级的基础设施（见 ADR-0001）。
- **改构建/运行模型**：动 `exports` 指向、动 `tsconfig.base.json`、换运行期转译器、
  给某个包加真实构建步骤（见 ADR-0002）。
- **改质量门禁**：ESLint 规则集增删、引入或移除 formatter、改 husky/lint-staged 钩子
  （见 ADR-0004、ADR-0008）。
- **改安全边界语义**：权限模型、路由 `access`、对外鉴权（见 ADR-0006）。
  这一类**特别**要求把「它不挡住什么」写清楚。
- **改 CI / 部署契约**：锁文件解析、镜像结构、挂载点、环境变量（见 ADR-0005、ADR-0009）。
- **改插件清单 schema 或热替换/停机协议**：新增清单字段、改超时/回滚语义（见 ADR-0007）。

不需要 ADR 的：修 bug、补测试、局部重构、文案、依赖小版本升级（Dependabot 那些走 PR 描述即可）。
判据是一句话：**这个改动会不会让后来人问「当初为什么不选另一种」？** 会，就写。

## 索引

| 编号 | 标题 | 状态 | 一句话论点 |
|---|---|---|---|
| 0001 | [cordis 插件图 + 纯 node:http](./0001-cordis-plugin-graph-and-node-http.md) | proposed | 依赖顺序与节点级诊断交给 cordis 的声明图，HTTP 只留 `node:http` 一层；代价是横切能力全部手写 |
| 0002 | [后端运行期直接跑 TypeScript](./0002-serve-typescript-at-runtime.md) | proposed | 后端不做构建产物、由 tsx 运行期转译 TS，代价在启动延迟与内存 |
| 0003 | [SQLite + FTS5 主库，Postgres 双轨兼容层](./0003-sqlite-fts5-primary-postgres-dual-track.md) | proposed | 单文件库当默认（非「只支持 SQLite」），靠最小 DSL 保住 Postgres 轨；回填条目，两轨各有一次实测失败 |
| 0004 | [ESLint 刻意不用 type-aware 规则](./0004-eslint-no-type-aware.md) | proposed | 只用能抓真实缺陷的规则集，不为 28 个包建 project service；代价是拿不到 promise 类检查 |
| 0005 | [pnpm storeDir/cacheDir 用相对路径](./0005-pnpm-relative-store-and-cache-dirs.md) | accepted | 绝对 store 路径会让 CI、Docker、Dependabot 全线失败，且失败点离病因很远 |
| 0006 | [插件同进程 + 声明式权限](./0006-inprocess-plugins-declarative-permissions.md) | accepted | 权限是管理台展示与审计语义，**不是**安全边界；未声明的跨界只告警不拦截 |
| 0007 | [清单两层 + 看门狗回滚](./0007-two-layer-manifest-and-watchdog.md) | accepted | JSON 说「这是什么」、TS 说「怎么跑」；代价是 JSON 那半层带不动 schemastery |
| 0008 | [不引入代码格式化器](./0008-no-code-formatter.md) | proposed | 格式交给 `.editorconfig` 与 review；28 包一次性重排的代价是永久污染 blame |
| 0009 | [单进程与 SQLite 最小部署](./0009-single-process-sqlite-minimal-deployment.md) | accepted | 默认形态是一个进程一个实例的 SQLite，用 crash marker 兜住「插件把宿主拖挂」；水平扩展明确划到范围外 |

编号是**追加式**的，不复用、不插号。空号一旦出现就说明有文件被删了——本目录里已经发生过一次
（编号缺位会留下死链，`scripts/docs-links.ts` 在 CI 里拒绝指向不存在文件的链接）。
