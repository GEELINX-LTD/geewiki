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
| 知道**改跨包代码要守哪些红线**（分层、依赖方向、硬不变量） | [../ARCHITECTURE.md](../ARCHITECTURE.md)（结论 + 不变量 + 哪些已被机器强制） |
| 知道**某个决定当初为什么这么定** | [adr/README.md](adr/README.md)（决策日志；**不描述当前实现**） |
| **提交代码 / 提 PR**（提交信息怎么写、门禁有哪些） | [../CONTRIBUTING.md](../CONTRIBUTING.md)；勾选清单见 [../.github/pull_request_template.md](../.github/pull_request_template.md) |
| 知道 **CI 到底跑什么、为什么没跑 X** | [ci-cd.md](ci-cd.md)（含「未纳入 CI 的诚实清单」与本地复现命令） |
| 知道平台**还有哪些限制**、哪些是**有意不做**的 | [plugin-platform.md](plugin-platform.md) 的「当前限制与风险」（条目编号 `L-*`） |
| 想知道文档里说「已实现」但**跑起来不对**的东西 | [agent/backlog.md](agent/backlog.md)（理念违背整改台账，**现状快照**） |
| **写一个自己的插件** | 作者视角从 [plugin/index.md](plugin/index.md) 进；契约条款在 [architecture.md](architecture.md) 的 Manifest 规范 + [plugin-platform.md](plugin-platform.md)；脚手架 `pnpm run new:plugin <名字>` |
| 想知道**我的插件能不能被收** | [plugin/review-checklist.md](plugin/review-checklist.md) |
| 插件**写了不报错但不生效** | [plugin/anti-patterns.md](plugin/anti-patterns.md) |
| 想知道**兼容性谁负责**（宿主其实不校验） | [plugin/compatibility.md](plugin/compatibility.md) |
| **部署到服务器** | [deployment.md](deployment.md) |
| 知道**备份 / 恢复**怎么做 | [deployment.md](deployment.md)；命令是 `pnpm run backup` / `pnpm run restore` |
| 知道**开发时有哪些约定与坑** | [development.md](development.md)（数据库迁移约定、双方言差异、验收纪律） |
| 给**AI 编码代理**下硬性约定 | [../AGENTS.md](../AGENTS.md)（入口）→ [agent/conventions.md](agent/conventions.md)（细则） |
| **接入模型 / 配密钥** | [../README.md](../README.md) 的「配置 → 接入模型」 |
| **用 PostgreSQL** | [deployment.md](deployment.md)；注意 PG 下全文检索不可用 |
| 界面上某个元素**能不能被插件替换** | [design/ui-extension-platform.md](design/ui-extension-platform.md) |
| 看**专题设计** | [design/access-control.md](design/access-control.md) 访问控制与组织管理 · [design/attachments.md](design/attachments.md) 附件 · [design/block-attribution.md](design/block-attribution.md) 块级归属 · [design/dock-images.md](design/dock-images.md) 输入条图片输入 · [design/ui-extension-platform.md](design/ui-extension-platform.md) 界面扩展平台 · [design/ai-plugin-architecture.md](design/ai-plugin-architecture.md) AI 能力架构（**旧口径，见下方登记表的告警**） |
| 查历史：**某批为什么这么改** | [changelog/implementation-log.md](changelog/implementation-log.md)（**非当前口径**） |

---

## 文档地图

```
仓库根
├── AGENTS.md                     **AI 代理唯一入口**：只放读代码读不出来的东西（命令陷阱、隐性契约、文档纪律）
├── README.md                     项目门面：是什么、怎么跑起来、怎么配
├── ARCHITECTURE.md               架构约束地图（给 agent 与新贡献者）：分层、依赖方向、硬不变量、机器强制现状
├── CONTRIBUTING.md               怎么把一次改动送到 main：环境、脚本、代码风格、Git 规范、PR 门禁、文档同步
├── commitlint.config.mjs         提交信息的判定规则（由 .husky/commit-msg 执行）
├── lint-staged.config.mjs        pre-commit 只对本次暂存的 TS/JS 跑 eslint
├── .husky/                       本地钩子：commit-msg（commitlint）、pre-commit（lint-staged）
└── .github/
    └── pull_request_template.md  PR 描述模板与勾选清单

docs/
├── README.md                 ← 你在这里：唯一索引 + 真源登记表
├── architecture.md           系统设计真源：分层、插件管理器、插槽、Manifest、REST 面
├── ci-cd.md                  CI/CD：跑什么、何时跑、本地复现、镜像、依赖更新、分支保护、未纳入 CI 清单
├── plugin-platform.md        插件平台：接口契约、生命周期、验证纪律、已知限制与风险（L-*）
├── deployment.md             部署与运维：镜像、权限、环境变量、备份、PostgreSQL、排障
├── development.md            工程约定：环境约束、迁移约定、方言差异、验收纪律
├── roadmap.md                路线图：已完成、接下来做什么、有意不做
├── agent/                    给 AI 编码代理的落地文档（conventions = 细则，backlog = 现状快照）
├── plugin/                   插件作者文档（index → quickstart → api-reference → anti-patterns → compatibility → review-checklist）
├── design/                   专题设计（决策与契约的定稿；六篇，见下方登记表）
├── adr/                      架构决策记录（编号 + 状态；索引在 docs/adr/README.md）
└── changelog/
    └── implementation-log.md 历史实施台账 —— **不是当前口径**
```

### 逐篇登记

只登记**此前漏登**与**本批新增**的篇目；没在这里出现的仍以「文档地图」里的一句话描述为准。
「权威边界」一列写的是**它管到哪里为止**——越界的部分去看它指向的下一篇，不要在这里找。

| 路径 | 是什么 · 什么时候该读 | 权威边界到哪里 |
| --- | --- | --- |
| [../ARCHITECTURE.md](../ARCHITECTURE.md)（仓库根） | 架构**约束地图**：分层与依赖方向、硬不变量、以及每条不变量当前**靠什么强制**（测试 / lint / 只有约定）。改跨包代码前先对一遍 | 只管「结论 + 不变量 + 强制手段」。实现细节、数据结构、时序仍以 [architecture.md](architecture.md) 为真源；两者说法不一致时以那份加代码为准 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md)（仓库根） | 贡献流程：环境要求、脚本全集、代码风格、Git 与提交规范、PR 门禁、文档同步要求。**第一次提 PR 前读** | 只管「怎么把改动送进来」。技术红线出处在 `ARCHITECTURE.md`，门禁的实际判定在 [ci-cd.md](ci-cd.md) |
| [../.github/pull_request_template.md](../.github/pull_request_template.md) | PR 描述模板：勾选清单、access 变更显式声明、是否需要补 ADR | 它是**清单**不是门禁；判据在哪见 [ci-cd.md](ci-cd.md) |
| [ci-cd.md](ci-cd.md) | 流水线各 job 跑什么、触发条件、发版与镜像、store 相对路径、依赖更新，以及**哪些检查根本没进 CI**（诚实清单）与 main 分支保护现状。问「为什么 CI 没跑 X」时读 | 「CI 覆盖面」的真源。workflow YAML 本身是最终事实，本文是解读；本地门禁命令与 `../CONTRIBUTING.md` 保持同一套 |
| [plugin/index.md](plugin/index.md) | 插件作者文档**总入口**：该不该写插件、写哪种形态（内置包 / 外部插件）、按什么顺序读下面几篇 | 只做导航与选型判断，不定义契约 |
| [plugin/quickstart.md](plugin/quickstart.md) | 从零跑通一个外部插件的**可复制执行路径**（命令、目录、加载与验证） | 管到「本地跑通 + 看到自己的代码出现在界面上」。上架/收录条件不在这里 |
| [plugin/api-reference.md](plugin/api-reference.md) | Manifest 字段、宿主 API、插槽与扩展点、错误码的**速查表** | **不是真源**（它自己开头就声明了）。与源码冲突时以本文件下方「事实的真源」为准，然后回来改这里 |
| [plugin/anti-patterns.md](plugin/anti-patterns.md) | 已踩过的**静默失败**陷阱：写了不报错但不生效的写法、怎么认出、怎么改 | 管「怎么认出坑与怎么改」。坑的正式编号与风险分级仍归 [plugin-platform.md](plugin-platform.md) 的 `L-*` |
| [plugin/compatibility.md](plugin/compatibility.md) | 兼容性政策：宿主版本与 SDK 版本怎么看、废弃节奏、作者侧该锁什么 | 政策文。宿主**不做**运行期兼容校验（见下方 SDK 版本一行），所以这份政策描述的是**作者**的责任边界 |
| [plugin/review-checklist.md](plugin/review-checklist.md) | 插件收录 / 合并门槛清单 | 评审判据清单；契约定义不重复写，一律回指真源 |
| [agent/conventions.md](agent/conventions.md) | **给 AI agent 的硬性约定细则**（权限默认值、DB 双方言、文档同步、必须贴的门禁读数）。它是入口文件指向的落地文档 | 只写「别处查不到且必须遵守」的；已写在 development / ci-cd / plugin-platform 的**只给链接不复述**（避免造第二个真源）。冲突项不在这里，在 backlog |
| [agent/backlog.md](agent/backlog.md) | **理念违背整改台账**：文档/设计说的与代码现状不符之处，逐条带现状、建议修法、验证方式与核实基准 HEAD。查「现在已知哪些没修」先来这里 | 「已知未修」的真源（**现状快照**，每轮刷新）。**不是路线图**——要做什么看 [roadmap.md](roadmap.md)，为什么这么选看 [adr/README.md](adr/README.md) |
| [adr/README.md](adr/README.md) | ADR 目录索引与格式约定（MADR 精简式；两条硬规矩：不锚定 commit hash / 行号，负面后果不许省略）。想知道某个不可逆决定的背景与代价时读 | 只记「为什么这么定」，**不描述当前实现**。当前实现看 [architecture.md](architecture.md) 与代码；ADR 与代码不符时以代码为准并**补一条新 ADR**，不回头改旧文件 |
| [adr/0003-sqlite-fts5-primary-postgres-dual-track.md](adr/0003-sqlite-fts5-primary-postgres-dual-track.md) | 以 SQLite + FTS5 为主库、Postgres 走双轨兼容层的决策（回填，状态 `proposed`）。改检索或加 SQL 前必读 | 决策与其代价。检索的实际 SQL 在 `packages/plugin-search/src/index.ts`，没有 SQL 抽象层 |
| [adr/0009-single-process-sqlite-minimal-deployment.md](adr/0009-single-process-sqlite-minimal-deployment.md) | 极简部署形态：单进程 + SQLite 默认 + `pnpm deploy` 部署树（状态 `accepted`）。动部署形态、进程边界、打包前读 | 部署形态的决策依据；操作手册在 [deployment.md](deployment.md)，流水线在 [ci-cd.md](ci-cd.md) |
| [design/ui-extension-platform.md](design/ui-extension-platform.md) | **界面扩展平台契约定稿**：可被替换 / 包裹 / 扩展的节点目录、三种模式语义、多插件共存裁决、主题令牌 | 界面扩展的**设计**真源。实际取值与允许模式以源码为凭：`packages/core/src/extensions.ts` 与 `packages/core/src/slots.ts`（见真源表） |
| [design/block-attribution.md](design/block-attribution.md) | **块级归属**：谁最后改了哪一块——归属模型、写入时机、呈现方式 | 只管「归属」。权限判定在 [design/access-control.md](design/access-control.md)，别在这里找可见性规则 |
| [design/dock-images.md](design/dock-images.md) | 输入条（dock）的**图片输入**：设计、现状、未做项 | 只管图片输入。dock 作为 AI 唯一对话入口的契约在 [plugin-platform.md](plugin-platform.md) 与 `packages/plugin-ai-assistant` |
| [design/access-control.md](design/access-control.md) | 访问控制、组织管理与公开门户的**设计定稿**（P0–P4 已合入 `main`） | 权限模型的设计真源。**定稿 ≠ 每句都已验证**：除标「实测」的结论外，标「原文如此，实现前需复核」的条目不许照着猜。块归属见 block-attribution |
| [design/attachments.md](design/attachments.md) | 附件能力的设计基线 + 与实现一致的现状说明 | 附件的设计与现状。文中大量「路径 + 行号」是**书写时快照且已前移**（文首自己声明了），定位一律用符号名；这条也是门禁 R2 抓的东西 |
| [design/ai-plugin-architecture.md](design/ai-plugin-architecture.md) | AI 插件化重构的能力贡献架构**方案与决策** | ⚠️ **历史口径**：文中描述的 `@geewiki/ai` / `@geewiki/ai-qa` / `@geewiki/ai-assist` / `wiki-ask` 插槽 / `POST /api/ai/stream` **已拆除**（该文决策 22），AI 侧现状只剩 `@geewiki/ai-assistant` 经 `app-dock` 提供的唯一对话入口。当前口径看 [../README.md](../README.md)、[architecture.md](architecture.md)、[plugin-platform.md](plugin-platform.md) |

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
| **内置插槽清单** | `packages/core/src/slots.ts` 的 `SLOT_NAMES`（类型 `BuiltinSlotName`）—— 当前 **7** 个，**以该数组为准**。注意：仓库里**没有** `SLOT_DEFINITIONS` 这个符号，别照抄外部写法 |
| **插槽的单/多占用** | 同文件 `SLOT_CARDINALITY`（类型 `Readonly<Record<BuiltinSlotName, 'single' \| 'multi'>>`）—— 键集与 `SLOT_NAMES` 相等，**同为 7 条**，不是「7 个插槽 / 12 条基数」两个数。自定义插槽名走 `slotCardinalityOf()`（未声明即 `multi`）。键集一致性由 `packages/web/test/slotPropsMirror.test.ts` 与 `packages/manager/test/slots.test.ts` 钉住 |
| **自定义插槽/扩展点命名** | `packages/core/src/slots.ts` 的 `PLUGIN_SLOT_NAME` —— **名字必须含 `/`**；内置插槽名一律不含，所以 `app-headr` 这类笔误会被**拒绝**而不是静默多出一个插槽。自定义节点同理 |
| **宿主扩展点目录** | `packages/core/src/extensions.ts` 的 `HOST_NODE_CATALOG` / `HOST_NODE_NAMES`；节点分类见 `HostNodeKind`（`slot` / `shell` / `page` / `ui`），**条目数以 `HOST_NODE_NAMES` 为准**（不在文档里抄数） |
| **扩展允许的模式取值** | 同文件 `ExtMode`（`'replace' \| 'wrap' \| 'extend'`）+ `EXT_MODES` + `DEFAULT_EXT_MODE`（`'extend'`）；**逐节点**允许集是 `HostNodeSpec.modes`（常量 `UI_MODES` / `PAGE_MODES` / `PORTAL_UI_MODES`，portal 类不给 `wrap`），取数走 `extModesOf()` / `supportsExtMode()` / `hostNodeSpec()`。仓库里**没有** `GeeWikiUiMode` / `GEEWIKI_UI_MODES` / `normalizeMode()` |
| **一次扩展能不能多人共用** | `extensions.ts` 的 `modeCardinalityOf()`：`replace` / `wrap` **恒 `single`**；`extend` 走 `extendCardinalityOf()` —— `kind: 'slot'` 一律回 `SLOT_CARDINALITY`（目录里不许重复声明），非 slot 节点取目录字段 `extendCardinality?`（未声明即 `multi`）。守卫：`packages/core/test/extensions-catalog.test.ts`。**不存在「宿主节点一律允许多人」这回事** |
| **主题注册** | `packages/web/src/lib/pluginTheme.ts` 的 `registerTheme(owner, contribution)` / `unregisterThemes(owner)` / `buildThemeCss()` / `THEME_STYLE_ID`；对比度守卫同文件 `themeContrastIssues()`。插件侧的**作用域包装**在 `packages/web/src/lib/pluginUi.ts`。（`packages/web/src/lib/host.ts` 这个路径**不存在**） |
| **Markdown 扩展注册** | `packages/web/src/lib/markdownExt.ts` 的 `registerMarkdownExtension(owner, ext)` / `unregisterMarkdownExtensions(owner)` / `activeMarked()` / `fenceExtension()` / `markdownRegistryVersion()`；内置消费者示例 `packages/web/src/lib/wikilink.ts`。（`packages/web/src/lib/mdExt.ts` 这个路径**不存在**） |
| **宿主 SDK 版本** | `packages/web/src/lib/hostSdk.ts` 的 `HOST_SDK_VERSION`（读数以该常量为准，别在文档里抄版本号）。**Web 独有**：`packages/server` / `packages/core` / `packages/manager` 内没有任何 `sdkVersion` / `HOST_SDK` / `apiVersion` 命中，**后端不发版本信号**（台账 F22），所以插件只能做能力探测，不能靠版本号判断后端新旧 |
| **保留路由 id（插件不得占用）** | `packages/core/src/domain.ts` 的 `RESERVED_ROUTE_IDS`；插件侧路由命名判据是同文件 `PLUGIN_ROUTE_ID`。前端镜像在 `packages/web/src/lib/pluginUiPlan.ts`。（`packages/plugin-http/` 这个包**不存在**） |
| **wiki slug 保留段**（与上条**不是一套**） | `packages/plugin-wiki/src/index.ts` 的 `RESERVED_FIRST_SEGMENTS` ↔ 前端镜像 `packages/web/src/lib/wikiRoute.ts` 的 `WIKI_RESERVED_FIRST_SEGMENTS`。改 wiki 短链路由要同时改两处 |
| **提交信息规范** | `commitlint.config.mjs`（`type-enum` 取值、`header-max-length`）；本地钩子 `.husky/commit-msg` 执行它，暂存区 lint 由 `.husky/pre-commit` + `lint-staged.config.mjs` 负责 |
| **文档规范 R1 / R2 / R3** | `scripts/docs-conventions.ts`（R1 未被本索引登记、R2「路径 + 行号」式引用、R3 私有端点字面量）。跑 `pnpm run docs:conventions`，逐条收紧用 `--fail-on R1` |
| **文档链接与锚点存活** | `scripts/docs-links.ts`（`pnpm run docs:links`，阻断式）。它**不校验**代码块与行内代码里的路径，所以反引号里的裸路径是安全的；跨篇引用请写「文件 + 符号名/节标题」 |
| 前端路由 | `packages/web/src/App.tsx` |
| 数据库迁移 | `packages/db-sqlite/src/migrations/` 与 `packages/db-postgres/migrations/` |
| 测试与类型读数 | `pnpm test` / `pnpm typecheck` 的实时输出 |

> **跨篇引用节号时注意（台账 F15）**：`plugin-platform.md` 的第五章节条目正在被并行任务重排，
> 已经出现「把 `L-*` 已知限制条目写成 §5.1」这类**指错节号**的引用（`L-*` 实际在「已知限制条目」小节下）。
> 在节号稳定之前，**引用一律写「文件名 + 小节标题」，不要写 §编号**——门禁 R2 管的是行号，节号漂移它抓不到。
