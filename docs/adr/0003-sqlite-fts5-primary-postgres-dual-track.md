# 0003. 以 SQLite + FTS5 为主库，Postgres 走双轨兼容层

- 状态：proposed
- 记录日期：2026-09-28
- 说明：本条为**回填**（决策既成事实，按仓库现状整理）。状态取 `proposed` 而非 `accepted`，理由见「后果」末尾。

## 技术背景

「极致轻量」要求一条不依赖外部数据库服务的部署路径；「不绑厂商」又要求换库不是迁移成本。SQLite 免部署、单文件、备份即拷文件，且自带 FTS5 全文索引——中文检索可用 `trigram` 分词，并自实现高亮而非用 FTS5 的 `snippet()`（trigram 下 `snippet()` 上限约 64 token ≈ 中文 64 字，太短且切碎）。代价是 Postgres 没有 FTS5，也接不住 SQLite 专属语法。

两个硬事实决定了这条决策的性质：① 全文检索的 SQL 直接写在 `packages/plugin-search/src/index.ts`，**没有 SQL 抽象层**；② 整套 AI 能力（工具注册表、journal、知识库、助手、管理台）被登记为 SQLite-only。所以 Postgres 支持的实际范围比"支持两种数据库"窄得多。

## 考虑选项

- **A. Postgres 为主**：多一个必须部署的服务，直接违背「极致轻量」。
- **B. 只支持 SQLite**：最轻，但把"不绑厂商"变成口号。
- **C. 引入 ORM/查询构建器屏蔽方言差异**：给每个插件强加运行时依赖与构建期 codegen（与 ADR-0002 相冲），且 FTS5 的 `rank` / `snippet` 抽象不出来。
- **D. SQLite 为主 + Postgres 双轨兼容层**（选中）。

## 决策结果

选 D。落地形态（可复核）：

- **两套迁移目录**：`packages/db-sqlite/src/migrations/`（SQLite；目录带 `src/`）与 `packages/db-postgres/migrations/`（PG；不带 `src/`）。
- **方言差异用语法糖吸收**：`packages/db-sqlite/src/index.ts` 的 `SqliteDatabase.query/run` 把 `?` 转正；`packages/db-postgres/src/index.ts` 的 `toPgSql()` 按位置扫描串外 `?` 换成 `$n` 并跳过字符串/注释，同时提供 `insert().returningId()`（PG 补 `RETURNING "id"`，SQLite 走 `lastInsertRowid`）——**`insert()` 是契约扩展，不是 `query()` 语法糖**，因为 PG 的 `INSERT ... RETURNING` 形态不同。
- **AI 链路整条 SQLite-only**：`packages/manager/test/migrations-dialect.test.ts` 的 `SQLITE_ONLY` 登记 `ai-admin` / `ai-journal` / `ai-assistant` / `ai-kb` / `ai-pages` / `ai-tools`；`packages/server/src/index.ts` 的 `defaultRegistry()` 里 `@geewiki/ai-journal` 只登记 sqlite 迁移目录。
- **守卫**：`migrations-dialect.test.ts`（扫 SQLite-only 写法：`AUTOINCREMENT` / `PRAGMA` / `sqlite_master` / `WITHOUT ROWID` / `CREATE VIRTUAL TABLE` / `USING fts5` / `INSERT OR REPLACE` / `GROUP_CONCAT` / `strftime`；分类前先 `codeOnly()` 剥 `--` 行注释）+ `packages/manager/test/db-dual-track.test.ts`（任何取 `ctx.get('db')` 的源文件必须同时出现 `asAsync`）。
- **PG 侧只在本地跑**：`GEEWIKI_E2E_PG=1 pnpm --filter @geewiki/postgres test`；CI 无 PG service（`docs/ci-cd.md` 已登记）。

两处必须写清、否则一定被误读的细节：

1. **`ADD COLUMN` 不是禁令。** `packages/plugin-wiki/test/slug-hierarchy.test.ts` 的 `isAddColumn` 是**重放场景的分类器**——SQLite 老版本不支持 `ALTER TABLE ... DROP COLUMN`，加列类迁移一旦需要重建表就必须与回滚配对，所以按「幂等 / 加列 / 表重建」三类分别决定重放策略。把它当禁令会让后来人误以为 SQLite 不许加列。该文件自述这是「本仓反复踩到的同一类坑（第 7 次）」：`0022_invitation_open_code.sql` 头注释写了「0012/0017/0019/0020 全是 ADD COLUMN」就被误判过，**现修法是先 `stripComments` 再分类**——但文本启发式的性质没变，注释里出现这三个词仍会改变分类结果。
2. **PG 缺 `0002_pages_updated_at_index.sql` 是登记过的刻意内联，不是漏网。** `migrations-dialect.test.ts` 的 `DIALECT_PAIRS` 把它记在 `inlinedInPostgres`（PG 的 `0001_init.sql` 已内联该索引）。**新加 PG 迁移前，先看这个登记表**：一个真漏的迁移与一个刻意内联，在目录列表里长得一模一样。

## 后果

**正面**

- 默认部署零外部服务，符合「极致轻量」；备份 = 拷文件 + `scripts/backup.ts`。
- FTS5 + trigram 直接支撑中文全文检索与高亮，不引入 ES 这类外部组件。
- 双轨靠守卫维持，不靠人自觉：缺一条 PG 镜像、业务代码漏 `asAsync`、PG 侧写了 SQLite-only 语法，都会在 `pnpm --filter @geewiki/manager test` 里红。

**负面 / 风险（如实）**

- **Postgres 不是等价替代。** 全文检索只在 SQLite 侧（FTS5 trigram 虚表 + `INSERT OR REPLACE` 维护），PG 侧检索能力明显更弱；AI 整条链路 SQLite-only。**"换 PG 就能水平扩展 AI"不成立**——这条边界对最终用户不可见，只有读到这里才知道。
- **无 SQL 抽象层**：插件手写 SQL 必须自己保证双方言兼容，守卫只拦得住已知的 SQLite-only 写法。
- **文本启发式会误判**：靠 `stripComments` / `codeOnly` 缓解，本质仍是文本匹配（本条与 ADR-0004 的教训同源）。
- **PG 路径无 CI 覆盖**：CI 无 PG service，PG 兼容靠本地手动跑，**回归只能靠人**。
- **双份迁移会漂移**：守卫只比对登记过的配对，新增 SQLite 迁移若忘了登记 PG 镜像或 `inlinedInPostgres` 就可能长期无人发现。
- **产品理念张力**：「不绑厂商」在这条决策上只覆盖元数据与页面内容层。数据层的事实是"默认且主推 SQLite，PG 为兼容轨"——把这句话写进 README 比写进 ADR 更有效。

**状态取 `proposed` 的理由（诚实说明）**：双轨的 PG 侧既无 CI 门禁、也无自动化验收，"accepted" 会让人误以为两条路径具备同等保障等级。待 PG 侧进入 CI（或文档明确降级为"尽力支持"）后再改 `accepted`。
