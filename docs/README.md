# GeeWiki 文档索引

**结论优先**：这一页只回答一件事——「我想知道 **X**，该看哪一篇」。
每篇文档的第一节都应该是结论与「**不做什么**」，推导、取舍与历史留在后面。

---

## 我想……

| 我想…… | 看这里 |
| --- | --- |
| **5 分钟跑起来** | [../README.md](../README.md) 的「快速开始」 |
| 知道**现在有哪些能力**、到什么程度 | [roadmap.md](roadmap.md)（Phase 0–4 的目标与验收口径） |
| 知道平台**还有哪些限制**，以及哪些是**有意不做**的 | [plugin-platform-plan.md](plugin-platform-plan.md) 第 5 节（**L-1…L-20**） |
| 知道最近的自由度整改**做了什么、怎么验证的** | [review/plugin-freedom-audit.md](review/plugin-freedom-audit.md)（A/B/C 级阻碍、F1–F21 落地位置与判据、§4 优化点） |
| **理解系统设计** | [architecture.md](architecture.md) |
| **写一个自己的插件** | [architecture.md](architecture.md) 的 Manifest 规范 + [plugin-platform-plan.md](plugin-platform-plan.md)；脚手架直接跑 `pnpm run new:plugin <名字>` |
| **部署到服务器** | [deployment.md](deployment.md)（含 PostgreSQL、备份、排障与验证清单） |
| 知道**备份 / 恢复怎么做** | [deployment.md](deployment.md) §5；命令是 `pnpm run backup` / `pnpm run restore` |
| 查历史：**某批为什么这么改** | [changelog/implementation-log.md](changelog/implementation-log.md) |
| 查历史：**测试读数台账** | [changelog/test-ledger.md](changelog/test-ledger.md) |
| 看**专题设计**（访问控制、AI 插件架构、附件…） | [design/](design/) |

---

## 文档纪律（四条，都是踩过之后定下的）

1. **README 只讲「现在是什么、怎么跑起来」**，不记变更流水。
   流水一律进 `changelog/` —— 它曾经在 README 里逐批追加到 **834 行 / 约 220 KB**，把「快速开始」挤到第 841 行。
2. **结论优先**。每篇开头先给结论与「不做什么」；「我们认为…因为…」的推导放在后面。
   读者多数时候只需要第一段。
3. **不要在一行里写一篇文章**。README 里曾有一行**表格单元格**长到约 6900 字节、内含未转义的 `|`，
   于是整行被 Markdown 解析成 5 列、出现在一张 2 列表格里——**它本来就是坏的**，不只是"太长"。
4. **文档里出现具体读数（测试例数、插件数、行号）时，必须同时给出取数方式**，让它可被重新验证。
   读数会过时：本仓库的 README 一度同时写着「1904/1904」「内置插件 22 个」「启用 18 条」，
   而实际是 **2105 / 24 / 21**。**过时的数字比没有数字更坏**——它让人以为已核对过。

---

## 文档地图

```
README.md                       现在是什么、怎么跑起来（272 行）
docs/
├── README.md                   ← 你在这里：结论优先的索引
├── roadmap.md                  目标与验收口径（Phase 0–4）
├── architecture.md             系统设计
├── deployment.md               部署、PostgreSQL、备份、排障
├── plugin-platform-plan.md     插件平台实施记录 + 已知限制 L-1…L-20
├── design/                     专题设计（访问控制 / AI 插件架构 / 附件 / AI 原生问答…）
├── review/                     审计与整改报告
└── changelog/                  历史台账（实现记录 / 测试读数）——**不是当前口径**
```
