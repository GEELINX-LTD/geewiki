# GeeWiki 文档索引

这一页只回答一件事：**「我想知道 X，该看哪一篇」**。

每篇文档的第一节都应当是结论与「**不做什么**」，推导、取舍与历史留在后面。

---

## 我想……

| 我想…… | 看这里 |
| --- | --- |
| **5 分钟跑起来** | [../README.md](../README.md) 的「快速开始」 |
| 知道**现在有哪些能力**、到什么程度 | [roadmap.md](roadmap.md) |
| 知道系统**长什么样** | [architecture.md](architecture.md) |
| 知道平台**还有哪些限制**、哪些是**有意不做**的 | [plugin-platform.md](plugin-platform.md) 的「当前限制与风险」 |
| **写一个自己的插件** | [architecture.md](architecture.md) 的 Manifest 规范 + [plugin-platform.md](plugin-platform.md) 的插件接口契约；脚手架跑 `pnpm run new:plugin <名字>` |
| **部署到服务器** | [deployment.md](deployment.md) |
| 知道**备份 / 恢复**怎么做 | [deployment.md](deployment.md)；命令是 `pnpm run backup` / `pnpm run restore` |
| 知道**开发时有哪些约定与坑** | [development.md](development.md)（数据库迁移约定、双方言差异、验收纪律） |
| **接入模型 / 配密钥** | [../README.md](../README.md) 的「配置 → 接入模型」 |
| **用 PostgreSQL** | [deployment.md](deployment.md)；注意 PG 下全文检索不可用 |
| 看**专题设计** | [design/](design/)：访问控制 · 附件 · AI 能力架构 |
| 查历史：**某批为什么这么改** | [changelog/implementation-log.md](changelog/implementation-log.md)（**非当前口径**） |

---

## 文档地图

```
README.md                     项目门面：是什么、怎么跑起来、怎么配
docs/
├── README.md                 ← 你在这里：索引
├── architecture.md           系统设计：分层、插件管理器、插槽、Manifest、REST 面
├── plugin-platform.md        插件平台：接口契约、生命周期、验证纪律、已知限制与风险
├── deployment.md             部署与运维：镜像、权限、环境变量、备份、PostgreSQL、排障
├── development.md            工程约定：环境约束、迁移约定、方言差异、验收纪律
├── roadmap.md                路线图：已完成、接下来做什么、有意不做
├── design/                   专题设计（决策与契约的定稿）
│   ├── access-control.md         访问控制与组织管理
│   ├── attachments.md            附件能力
│   └── ai-plugin-architecture.md AI 能力架构：工具总线 + 单入口 + mutation journal
└── changelog/
    └── implementation-log.md 历史实施台账 —— **不是当前口径**
```

---

## 文档纪律

这几条都是踩过之后定下的，改动文档时请一并遵守。

1. **README 只讲「现在是什么、怎么跑起来」**，不记变更流水。
   流水一律进 `changelog/` —— 它曾在 README 里逐批追加到 **834 行 / 约 220 KB**，把「快速开始」挤到了第 841 行。

2. **结论优先**。每篇开头先给结论与「不做什么」，推导放在后面；读者多数时候只需要第一段。

3. **不要在一行里写一篇文章。** README 里曾有一行**表格单元格**长到约 6900 字节、内含未转义的 `|`，
   于是整行被 Markdown 解析成 5 列、出现在一张 2 列表格里 —— **它本来就是坏的**，不只是"太长"。

4. **不要用「修正」块打补丁。** 本仓库一度流行在旧段落后面追加修正块，
   结果是同一节里正确与错误并存、读者无法判断哪句算数。**正文直接写当前事实**，历史折到文末或进 `changelog/`。

5. **具体读数必须给出取数方式**（命令 + HEAD + 时刻），否则它会过时且不可复核。
   本仓库的 README 一度同时写着「1904/1904」「内置插件 22 个」「启用 18 条」——**过时的数字比没有数字更坏**，
   它让人以为已经核对过。数量类口径的真源只有两个：**`config/plugins.base.example.json`**（随版本发布的
   默认启用清单；本机 live 文件 `config/plugins.base.json` 不入库，**不能当口径**）与源码里的
   **`defaultRegistry()`**；不要在多处各抄一份。

6. **删除或改名文档时，同步全仓引用**。引用不只出现在 `docs/`，也在 `README.md` 与**源码注释**里；
   `grep -rn "<文件名>" .` 之后再动手。

---

## 事实的真源

文档之间互相引用时，请引用**真源**而不是转述，避免同一数字在两处漂移：

| 事实 | 真源 |
| --- | --- |
| 包清单 | `ls -d packages/*/` |
| 内置插件注册清单 | `packages/server/src/index.ts` 的 `defaultRegistry()`（`grep -c "source: 'builtin'"`） |
| 默认启用清单 | `config/plugins.base.example.json` 的 `enabled`（随版本发布；`plugins.base.json` 是本机现状） |
| 内置插槽与基数 | `packages/core/src/slots.ts`（`BuiltinSlotName` / `SLOT_NAMES` / `SLOT_CARDINALITY`） |
| 前端路由 | `packages/web/src/App.tsx` |
| 数据库迁移 | `packages/db-sqlite/src/migrations/` 与 `packages/db-postgres/migrations/` |
| 测试与类型读数 | `pnpm test` / `pnpm typecheck` 的实时输出 |
