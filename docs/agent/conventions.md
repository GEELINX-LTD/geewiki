# 规范细则（agent conventions）

> **定位**：本文件是**给 AI agent 的硬性约定细则**，是仓库根 `AGENTS.md` / `CLAUDE.md` /
> `.github/instructions/*` 指向的落地文档。
>
> **只写「别处查不到、且必须遵守」的东西。** 凡是 `docs/development.md`、`docs/ci-cd.md`、
> `docs/plugin-platform.md`、`.editorconfig` 已经写过的，这里**只给链接、不复述**——
> 复述就是制造第二个真源（见 `docs/README.md`「文档纪律」）。
>
> 现状与理念的冲突项**不在这里**，在 `backlog.md`。
> 核实基准：HEAD `64ff6fa`（2026-09-28）。

---

## 1. 包与骨架

| 约定 | 理由 |
| --- | --- |
| 目录名 ≠ 包名，**以各 `packages/*/package.json` 的 `name` 为准**（下表）。 | `plugin-` 前缀在包名里被去掉，两个 DB 包更是完全不规则；照目录名猜包名会写出错的 `workspace:` 依赖。 |
| 新增包必须同时出现在 `pnpm-workspace.yaml` 覆盖范围内，并复用现有骨架：`package.json`（`type: module` + `exports: {".": "./src/index.ts"}`）+ `src/index.ts` + `tsconfig.json` + `test/*.test.ts`。 | 28 个包共用同一形态，任何偏形都会让 `pnpm typecheck` / 构建脚本 / 外部插件发现逻辑额外分叉。 |
| 依赖一律 `workspace:*`（例：`packages/plugin-wiki/package.json` 的 `"@geewiki/core": "workspace:*"`）。 | 保证 monorepo 内永远解析到本地源码，不会误装 registry 版本。 |
| `cordis` 用 `^4.0.0-rc.10`，`schemastery` **钉死** `3.18.0`（无 `^`）。 | schemastery 的 `toJSON()`/`refs` 结构被本仓的清单序列化直接依赖，漂移代价高。 |
| 优先用 `pnpm run new:plugin <名字>` 生成骨架，而不是手抄。 | 脚手架产出的清单字段与守卫测试是配套的。 |

**目录 → 包名映射**（共 28 个包；`ls -d packages/*/` 是数量的真源）：

| 目录 | 包名 | 目录 | 包名 |
| --- | --- | --- | --- |
| `core` | `@geewiki/core` | `plugin-llm` | `@geewiki/llm` |
| `server` | `@geewiki/server` | `plugin-oidc` | `@geewiki/oidc` |
| `manager` | `@geewiki/manager` | `plugin-openai` | `@geewiki/openai` |
| `web` | `@geewiki/web` | `plugin-ops` | `@geewiki/ops` |
| `db-sqlite` | `@geewiki/db-sqlite` | `plugin-org` | `@geewiki/org` |
| `db-postgres` | **`@geewiki/postgres`** | `plugin-search` | `@geewiki/search` |
| `plugin-ai-admin` | `@geewiki/ai-admin` | `plugin-wiki` | `@geewiki/wiki` |
| `plugin-ai-assistant` | `@geewiki/ai-assistant` | `plugin-auth` | `@geewiki/auth` |
| `plugin-ai-journal` | `@geewiki/ai-journal` | `plugin-authz` | `@geewiki/authz` |
| `plugin-ai-kb` | `@geewiki/ai-kb` | `plugin-builtin-docs` | `@geewiki/builtin-docs` |
| `plugin-ai-nav` | `@geewiki/ai-nav` | `plugin-echo` | `@geewiki/echo` |
| `plugin-ai-pages` | `@geewiki/ai-pages` | `plugin-editor-plain` | `@geewiki/editor-plain` |
| `plugin-ai-summary` | `@geewiki/ai-summary` | | |
| `plugin-ai-tools` | `@geewiki/ai-tools` | | |
| `plugin-ai-web-search` | `@geewiki/ai-web-search` | | |
| `plugin-ai-writing` | `@geewiki/ai-writing` | | |

> 易错点三处：`db-postgres` → `@geewiki/postgres`（**不是** `@geewiki/db-postgres`）、
> `plugin-*` 系列包名**去掉** `plugin-` 前缀、`@geewiki/web` 是唯一**没有** `exports` 字段的包。

- `@geewiki/core` 额外提供子导出 `./slots`、`./extensions`、`./domain`——**需要插槽类型或扩展点类型时
  走子导出**，不要从 barrel 里绕。理由：`index.ts` 是最大的一文件，子导出给依赖图与 tree-shaking 留了明确的边界。
- **所有包**的 `exports` 都指向 `./src/index.ts`（运行期由 tsx 直跑 TS，无构建产物）。
  这是有意的极简取舍还是遗留问题**尚未定论**，见 `backlog.md` F21；**在决定之前不要单方面引入 `dist/`**。

---

## 2. 源码文件命名与组织

| 约定 | 理由 |
| --- | --- |
| `packages/core/src/` 用**域名小写**文件名：`audit.ts` / `cordis-env.ts` / `domain.ts` / `extensions.ts` / `index.ts` / `llm.ts` / `services.ts` / `slots.ts` / `sse.ts`。不按 class 命名、不加后缀。 | core 是纯类型 + 纯函数层，按域切分才能让「找一个类型」变成猜一个文件名就中。 |
| `packages/web/src/lib/` 用 **camelCase**（`pluginUiPlan.ts`、`editorModePlan.ts`、`slugRules.ts`）。 | 与 React 生态一致，且和 `pages/*.tsx` 的 PascalCase 组件形成「逻辑 vs 视图」的视觉分界。 |
| **可测逻辑必须从组件里抽出来**，落成 `*Plan.ts`（纯函数 + 类型），配套 `test/<同名>.test.ts`；跨页面共享的状态落 `*Store.ts`（`authStore.ts` / `pagesStore.ts` / `homeStore.ts`）。 | `node:test` **渲染不了 React**：不抽出来就只能靠类型检查覆盖，逻辑分支全部落在门禁外。这正是 `packages/web/test` 成为全仓测试最多（`find packages -name '*.test.ts' -not -path '*/node_modules/*'` 里的大头）的原因。 |
| 纯守卫（钉住不变式/常量/导出面）的单测也放各包 `test/`，例：`packages/web/test/hostSdkSurface.test.ts` 用正则解析 `HOST_SDK_VERSION` 常量。 | 与本仓「用守卫测试钉住源码事实」的做法一致，比注释可靠。 |
| barrel（`src/index.ts`）顶部保留中文 doc 头，并引用架构文档的**章节号**（如 `packages/core/src/index.ts` 引用「docs/architecture.md 第 7 节『插件元数据规范（Manifest）』逐字段对齐」、`packages/manager/src/index.ts` 引用「对应 docs/architecture.md 第 5 章」）。 | 章节号稳定、行号不稳定；barrel 的 doc 头是「实现 ↔ 契约」的唯一对齐声明。 |

---

## 3. 数据库与迁移

- **迁移必须 SQLite / Postgres 双方言成对**。落点以 `docs/README.md`「事实的真源」为准：
  `packages/db-sqlite/src/migrations/`（**注意有 `src/`**）与 `packages/db-postgres/migrations/`；
  插件侧若需要方言差异，用**双目录**：`<插件>/migrations` + `<插件>/migrations-postgres`
  （唯一现成样本：`packages/plugin-ai-journal/migrations` 与 `packages/plugin-ai-journal/migrations-postgres`）。
  完整约定与方言差异见 `docs/development.md` §2 / §3。
- **manifest 的 `migrations` 字段写法决定安全边界**：裸字符串 `migrations: './migrations'` 会被
  **两个方言共用**——`@geewiki/search` 就在 PG 上炸过：
  `迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"`（`GENERATED ... VIRTUAL` 是 SQLite 语法）。
  只想给 SQLite 用就写 **`migrations: { sqlite: './migrations' }`**。
  理由：这一条报错发生在启动迁移期、且带事务回滚，日志很容易被淹没在启动噪声里。
- 改动迁移后必须跑守卫测试：`packages/manager/test/migrations-dialect.test.ts`、
  `packages/manager/test/db-dual-track.test.ts`、`packages/server/test/builtin-migrations.test.ts`
  （后者含 `MANIFEST_MIGRATION_FALLBACKS = { '@geewiki/postgres': ['postgres'], '@geewiki/wiki': ['sqlite'] }`
  这类**方言归属白名单**——新增 DB 相关插件时要同步该表，否则守卫判据 A/B/C/D 直接失败）。
- 起 PG 的隔离配方、必须轮询 `/api/health` 直到 `"present": true`、以及「多实例并发必败」的说明：
  见 `docs/development.md` §1，**不要在本文复述**。

---

## 4. 测试

| 约定 | 理由 |
| --- | --- |
| 单测框架是 **`node:test` + tsx**，不是 vitest / jest。各包统一：`"test": "node --import tsx --test test/*.test.ts"`。 | 零测试依赖、与「不绑厂商」一致；引入第二套 runner 会让 28 个包的门禁分裂。 |
| 测试文件放**各包自己的** `test/*.test.ts`，不散在根目录。 | `pnpm test` 靠 workspace 逐个跑；跨包共享夹具用相对路径引用，别靠魔法路径。 |
| 需要起服务的端到端测试写成 shell：`packages/<包>/test/e2e-*.sh`，端口用 `PORT="${PORT:-<默认>}"` 允许外部覆盖。 | CI 不跑它们（`docs/ci-cd.md` §6），本地必须能一条命令复现。 |
| **端口以各脚本 `PORT:-` 默认值为准，新增脚本前先 `grep` 避让**：`grep -rhoE 'PORT="\$\{PORT:-[0-9]+\}"' packages/*/test/*.sh`。 | `docs/development.md` §1 的分段表已被实际脚本突破（现存默认端口跨 3xxxx–5xxxx，PG 测试容器 55432），复述区间会腐化，见 `backlog.md` F18。 |
| 浏览器/CDP 界面验收放 `scripts/acceptance/`，**刻意不进 `pnpm test`、不进 CI**。 | 理由与诚实清单见 `docs/ci-cd.md` §6；它们需要真实浏览器与运行中的实例。 |
| 交付时的验证口径：`pnpm lint`（`eslint . --max-warnings 0`）+ `pnpm typecheck` + `pnpm test` + `pnpm build` 四条全绿。 | 这四条是分支保护的必需检查（`docs/ci-cd.md` §7）；**具体读数（多少测试/多少包）以命令输出为准**，不要抄进文档（纪律第 5 条）。 |
| 每个包都得有 `test` 脚本与至少一个 `test/*.test.ts`（`plugin-echo`、`plugin-editor-plain` 目前是**反例**，已登记 `backlog.md` F16）。 | 空 `test` 脚本会让 `pnpm test` 静默跳过该包，缺陷被当成「测试通过」。 |

---

## 5. 配置、环境变量与密钥

- **没有 dotenv**（全仓 `grep dotenv` 无命中）：一律 `process.env['GEEWIKI_XXX']` 直读，
  变量名统一 `GEEWIKI_` 前缀。理由：多一层 dotenv 就有两套加载顺序，容器与本机行为会分叉。
- 相对路径经 `@geewiki/core` 的 **`resolveProjectPath(path, fromUrl)`** 解析——它以向上找
  `pnpm-workspace.yaml` 的方式定位仓库根。**规则**：所有默认路径经它，不要手算 `../../`。
  理由：容器工作目录与 monorepo 目录不同，手算相对路径是 Docker 排障的头号来源。
- 变量清单的真源分两处、**不要在三处抄**：面向宿主的运行变量在 `README.md`「环境变量」表，
  容器侧（compose 变量 + 容器内变量）在 `docs/deployment.md`。
  新增变量时**两处都要加**，并在源码消费点给出「未设置时的行为」（参考
  `packages/server/src/index.ts` 的 `envAdminToken()`：未设置 = 整条通道禁用，空串也算未启用）。
- **密钥的四条硬约定**（`packages/manager/src/secrets.ts` 的 `setSecret(store, plugin, field, value)` 是落盘单点）：
  1. schema 里用 `role: 'secret'` 标记（识别逻辑在 `packages/manager/src/config-schema.ts`），
     值**绝不进** `plugins.base.json` / `plugins.session.json`，只进 `config/secrets.json`（0600 + 原子写）。
  2. HTTP 读取只回「是否已设置」，不回显明文；**留空 = 不修改**（见 `packages/plugin-llm/src/settings.ts` 的
     「`apiKey` 是 `role:'secret'`：保存后不再回显，留空=不修改」）。
  3. 清空走显式 `clearSecrets`（`packages/manager/src/index.ts` 的 `absorbSecrets(name, config, opts.clearSecrets ?? [])`），
     **不要**用空串表达「删除」。
  4. `apiKeyEnv` 是环境变量兜底，**界面值优先**（`packages/plugin-llm/src/credentials.ts`；
     `packages/plugin-ai-web-search/src/types.ts` 同款）。
  理由：威胁模型已在 `docs/deployment.md` 写明（能读宿主文件系统者即可读密钥）；这四条保证的是
  「密钥不会通过配置/HTTP/清单这三条更宽的路泄漏」。
- **配置模板与文档里不得出现真实端点或真实密钥**：`config/plugins.base.example.json` 是随版本发布的示例。
  当前它写着私有端点 `https://zhigu.bsnc.cn/llm/v1` 与 `model: "DeepSeek V4 Flash"` —— **这是已登记的违背
  「不绑厂商」理念的现状，见 `backlog.md` F8；新增/改动模板时不得照抄它。**

---

## 6. 插件作者的两条隐性契约（别处只在源码注释里）

这两条最容易踩、且症状是**静默失效**，因此在这里成文；正式契约位建议收敛到 `docs/plugin-platform.md`。

1. **`geewiki.provides` 只是依赖图谱 token，不会创建 cordis 服务。**
   它的全部作用是让别人的 `requires` 能命中你（`packages/manager/src/deps.ts` 按
   `manifest.geewiki.provides === dep` 匹配）。服务必须在 `apply()` 里真实 `ctx.provide(...)`。
   谎报的后果：依赖方解析「已满足」，而 `ctx.get(...)` 恒为 `undefined`，功能静默不可用（依据：
   `packages/plugin-echo/src/index.ts` 文件头注释；整改项 `backlog.md` F3）。
2. **配置校验只认 schemastery 实例，不认 JSON。** 管理器取 schema 的顺序是
   **入口模块的 `Config`** → **manifest 的 `configSchema`**（`packages/manager/src/index.ts` 的 `configSchemaOf()`）；
   普通对象（旧式 JSON Schema 字面量）**视为「无 schema」**，只打印一次告警，之后 PUT 只校验「必须是 JSON 对象」。
   而 `geewiki.manifest.json` 是纯 JSON ⇒ **无法承载实例**。
   ⇒ **规则**：外部插件的 `Config` 必须写在入口模块（候选见 `packages/manager/src/discovery.ts` 的
   `ENTRY_CANDIDATES = ['index.ts', 'index.js', 'src/index.ts']`），不要指望 JSON 清单里的 `configSchema` 生效
   （整改项 `backlog.md` F20）。
3. 附带一条：manifest 里的 `slots` 与 bundle 里的 `registerSlot()` **不一致时是静默空白**
   （查询面：`GET /api/plugins/slots`，由 `packages/manager/src/slots.ts` 的 `effectiveSlotsByOwner` / `conflictsOf` 汇总；
   单占用插槽「激活顺序最早者胜出」）。改完前端插件请核对这个端点，别只看界面。

---

## 7. 文档纪律（agent 最容易违反的三条）

1. **引用代码用「路径 + 符号名」，禁止「路径:行号」。**
   行号只允许作为**辅助注**（写法：「截至 `<sha>` 约第 N 行，会漂移」）。
   理由：本仓 `docs/plugin-platform.md` 曾有 30 处行号引用，其中至少一处已明显漂移
   （指 `RouteAccessOptions.access?` 的那条），而且**其中相当一部分指的是第三方库 schemastery 的内部源码**——
   我们根本无法保证那些行号稳定。
2. **不写死会腐化的读数**（测试数、包数、断言数、启用条数）。写「取数命令 + HEAD + 时刻」，
   或直接写「以命令输出为准」。数量类口径的真源只有：
   `config/plugins.base.example.json` 的 `enabled`、`packages/server/src/index.ts` 的 `defaultRegistry()`、
   `ls -d packages/*/`、`pnpm test` / `pnpm typecheck` 的实时输出（见 `docs/README.md`「事实的真源」）。
3. **新增 / 改名 / 删除任何 .md 必须同步 `docs/README.md` 的文档地图**（纪律第 6 条），
   并且**先 `grep -rn "<文件名>" .` 再动手**——引用不只出现在 `docs/`，也在 `README.md` 与源码注释里。
   理由：本仓的索引页自己也漏登过 4 篇（`backlog.md` F10），说明这条只能靠自觉 + 门禁双保险。
4. **本目录（`docs/agent/`）的定位**：`conventions.md` = 必须遵守的细则；
   `backlog.md` = 现状快照 + 整改台账，**条目修好后删除并把结论写进对应真源**。
   根 `AGENTS.md` / `CLAUDE.md` / `.github/instructions/*` 只做**入口**，不复述本文细则。

---

## 8. Git 约定

| 约定 | 写法 |
| --- | --- |
| Conventional Commits + **中文 subject** + scope = 包名或域 | `feat(wiki): 附件上传去掉大小上限…` / `fix(docker): 镜像补齐内置插件界面产物，并加构建期守卫` |
| scope 用**域/包短名**，不带 `@geewiki/` 前缀 | `feat(lint): …`、`fix(docker): …`、`chore(deps): …` |
| 分支名 `feat/<pN-slug>` 或 `fix/<slug>` | `feat/p3a-blocks`、`feat/p4-audit-ops`、`fix/docker-build-builtin-plugin-ui` |
| 依赖升级交给 dependabot 分支，不手拧 | `remotes/origin/dependabot/npm_and_yarn/...` |

- **目前没有** commitlint / husky / lint-staged（`git log` 靠约定维持）——见 `backlog.md` F12；
  在门禁落地之前，提交前自查 subject 格式。
- 本地跑 `pnpm lint` 时注意它是**硬门禁**（`--max-warnings 0`）；CI 的必需检查名与 ruleset 说明见
  `docs/ci-cd.md` §7，**改作业名要先改仓库 ruleset**。

---

## 9. 代码风格

- **唯一来源是 `.editorconfig`**：`charset=utf-8`、`end_of_line=lf`、`indent_style=space`、
  `indent_size=2`、`trim_trailing_whitespace=true`、`insert_final_newline=true`。
- **没有 prettier，也不要引入**：本仓无 `.prettierrc`，`package.json` 里没有 `prettier` / `lint-staged`
  依赖；`eslint.config.js` 是唯一的 lint 入口（`pnpm lint` = `eslint . --max-warnings 0`，`pnpm lint:fix` 修）。
  理由：引入 formatter 会与存量代码大规模冲突；见 `backlog.md` F12 的取向建议。
- 注释用中文，且写「**为什么** + 踩过的坑」而不是复述代码；本仓大量注释是这个风格
  （例：`packages/manager/src/slots.ts` 的冲突规则说明、`packages/web/src/lib/pluginUi.ts`
  的「已知边界（决策，不是待办）」）。
  理由：本仓的决策类注释本身就是契约的一部分，写成复述等于把契约丢掉。
- 类型检查是逐包的（各包 `tsc --noEmit`，根 `pnpm typecheck` 覆盖所有包 + `scripts`；
  包数口径见 `ls -d packages/*/`，不要抄进文档）。
- **`as any` 不会被 lint 拦下**——`eslint.config.js` 里 `@typescript-eslint/no-explicit-any` 是 `'off'`。
  所以克制断言只是**约定**、不是门禁：需要断言时优先 `satisfies` / 收窄 / 类型守卫，
  并在断言处写明为什么类型系统推不出来。
