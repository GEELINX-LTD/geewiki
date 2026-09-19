# GeeWiki 工程开发约定与教训

> **性质**：本文是**工程约束的唯一真源** —— 沙箱环境、数据库迁移、PostgreSQL 方言、验收与验证纪律、文档纪律、协作与委派约定。
> **读者**：任何在本仓库实现、评审或验收的人（含 agent）。**实现交付必须遵守本文全部条目**；条目里保留具体数字、报错文本与命令，是为了让约束可复现、可核对，而不是装饰。

---

## 1. 环境、沙箱与运行约束

- **沙箱只允许写 `/root/dev/geewiki` 之内** ⇒ worktree 必须建在仓库内（`.wt-<阶段>`），不能建在仓库外。
- **`/tmp` 在本沙箱跨 bash 调用不保留** ⇒ 日志/中间产物要写在工作区内，或在**同一条命令里**产生并消费。
- **`tmp/` 必须与正式对象同文件系统**：上传完成后用 `rename()` **原子**落到正式路径。跨越文件系统的 `rename` 会 `EXDEV` 失败 ⇒ **不要**把 `tmp/` 放到 `/tmp`（容器的 `/tmp` 常是 tmpfs）。
- **主工作树默认没有 `node_modules`** ⇒ 在 `main` 上跑 typecheck/test 前需 `pnpm install --frozen-lockfile`。
- **路径解析陷阱**：`edit` / `write` 按**会话工作区（主工作树）**解析相对路径 ⇒ 在 worktree 里干活**必须用绝对路径**（多位执行者踩过）。
- **PG 隔离配方**：临时目录写 `plugins.base.json`，`@geewiki/postgres` 内联 `config` 用 `passwordEnv: "GEEWIKI_DB_PASSWORD"`；启动：
  ```bash
  GEEWIKI_CONFIG_DIR=<tmp> GEEWIKI_DATA_DIR=<tmp> GEEWIKI_DB_PASSWORD=testpw GEEWIKI_PORT=<自选> \
    node --import tsx packages/server/src/index.ts
  ```
  **必须轮询 `/api/health` 到 `"present":true` 才开始验收**（http 就绪即 200，迁移可能没跑完 —— 三位执行者栽在这里）。
- **PG 共享库 `geewiki_test` 已"中毒"**（留着先前运行的 owner 账号 ⇒ e2e 跳过 setup 直接登录 ⇒ 全线 401 假失败）⇒ 用干净库 **`geewiki_e2e_clean`**。
- **容器 `geewiki-pg-test`**：`postgres:15-alpine`，host `127.0.0.1` port **55432**，user `geewiki` / password `testpw`。
- **端口分段避让**：41xxx PG 验证 / 42xxx P1.5 / 43xxx P2 / 45xxx 合并验证 / 46xxx M5 合并 / 47xxx P3a / 48xxx M5 前端 / **50xxx P3bcd**。
- **`plugin-search` 在 PG 上报** `迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"` —— 这是**预期行为**（插件有显式方言守卫，见 `packages/plugin-search/src/index.ts`）。根因是它用**裸字符串**声明 `migrations: './migrations'` ⇒ 在 `resolveMigrationsDirs` 里归入 `'default'` 键、被所有方言命中；**最小修法一行**：`migrations: { sqlite: './migrations' }`。
- **多实例部署必然失败**（OIDC 流程状态存进程内，方向是**失败关闭**）；附件的进程内并发计数同理 ⇒ 附件能力**不支持多实例共享目录**，要在部署文档里写明。

---

## 2. 数据库与迁移约定

- **SQLite 没有 `ADD COLUMN IF NOT EXISTS`** ⇒ 给既有表**加列**的迁移**无法重放**（守卫测试已钉死，**不要放宽**）；新表用 `CREATE TABLE IF NOT EXISTS` 则安全。
- **新列必须内联在 `CREATE TABLE` 里**（如 `tier`），不要另起 `ALTER ... ADD COLUMN` —— 独立 ALTER 会让迁移无法重放（P2 在 `0012` 上踩过并用守卫测试钉死）。
- **守卫测试有基于文本启发的**（如 `/\bADD\s+COLUMN\b/i` 判断迁移可重放）⇒ **注释里写这几个词也会被误判**。
- **迁移落点必须在 `packages/db-sqlite/migrations` 与 `packages/db-postgres/migrations` 双方言成对**：**不要**写进 `plugin-wiki/migrations` —— `@geewiki/wiki` 的迁移目录**只声明了 sqlite** ⇒ 照设计文档写会让 **PG 部署下 `blocks` 表根本不被建出来**。
- **`plugin-wiki` 自带的单目录、双方言共用迁移目录**（`WIKI_MIGRATIONS_DIR`，由 `apply()` 自己执行 `db.migrate()`）：目录里的 SQL **必须双方言都能跑**；**不写 `BEGIN` / `COMMIT`**（`db.migrate()` 已把每个文件包在事务里，脚本内再开事务会嵌套报错）；幂等操作用 `CREATE INDEX IF NOT EXISTS` 一类写法并说明"为什么是空操作"。
- **`packages/server/test/builtin-migrations.test.ts` 的判据 A/B/C/D** 强制"注册表覆盖 + 回退项"：`MANIFEST_MIGRATION_FALLBACKS = { '@geewiki/postgres': ['postgres'], '@geewiki/wiki': ['sqlite'] }`；判据 C 要求 manifest 补上声明后**必须把回退项删掉**，判据 A 要求注册表里至少覆盖 **4 个迁移目录**。
- **SQL 括号陷阱**：`A OR B AND C` 的优先级是 `A OR (B AND C)` ⇒ 权限过滤条件**必须加括号**（P2 栽过一次）。

---

## 3. PostgreSQL 方言差异

- **PG 的 `COUNT(*)` / `SUM()` / `bigint` 聚合返回字符串** ⇒ 必须 `Number()` 强转（`page_grants` 求和、`grants/purge`、会话端点、附件配额求和都踩过；`SELECT SUM(bytes)` 同理）。
- **PG 下 `RETURNING id` 是插入自增主键的唯一可行方式**；缺它 PG 报
  `violates foreign key constraint "blocks_page_id_fkey" / Key (page_id)=(0) is not present`。
- **索引表存在性判定要看方言文案**：SQLite 是 `no such table:`，PG 是 `relation "blocks_fts" does not exist` ⇒ 只匹配 SQLite 文案会让**每次写块都失败**。
- **每一处 `blocks_fts` 语句都必须有方言守卫**：`deletePage` 里的 `DELETE FROM blocks_fts` 漏了守卫 ⇒ **PostgreSQL 上删除任何页面都返回 500 且页面删不掉**（PG 事务一旦报错即 aborted、整体回滚）。漏掉的原因正是下面 §4 说的"该阶段在 PG 下被整体跳过"。
- **结论（原样保留）**：*"块模型的 PG 可用性依赖 `RETURNING id`、索引表存在的方言判定、以及每一处 `blocks_fts` 语句的方言守卫 —— 这三点都不由类型系统保证，必须有真方言 e2e 兜底。"*
- **SQLite / FTS5 侧实测（真 probe）**：SQLite **3.53.4**（better-sqlite3 13.0.3）；`contentless_delete=1` 建表/删除/rowid 复用均 OK；**trigram 3 字符门槛真实**（2 字查询 `MATCH` 恒为空 ⇒ 短查询必须走 LIKE 兜底）；**`snippet()` 静默返回 `null` 而不报错**；**`tier` 过滤绝不能写在 FTS 表上**（contentless + `UNINDEXED` 会静默返回 0 行）。
- **不要给判定层加 TTL 缓存**：`acl_revision` 那条"代际失效"从未实现、也**不必**实现 —— 判定每请求现查库。

---

## 4. 验收与验证纪律

### 4.1 三类"断言自己会骗人"的形态（真实踩过，逐条记）

1. **把多个计数拼成字符串再比较**：e2e 的 C1 第一版把四个 `grep -o | wc -l` 的结果拼成字符串再比 `"4"`（得到 `"1111"`），**永不可能通过**。
2. **夹具会被 upsert 覆盖，导致"过期"场景实际不存在**：阶段 G 第一版造了两条 `subjectId` 相同的授予，而授予端点**按主体幂等 upsert** ⇒ 第二条覆盖第一条、库里没有过期行、`purge` 恒返回 `expired=0` 也照样"通过"。
3. **前置步骤让后续请求"看起来对"地失败**：阶段 G 漏了"阶段 E 结尾批量吊销了所有会话 ⇒ `$JAR` 已失效"，于是后续断言以"看起来对"的方式失败。

**对策**：先证明**前置状态可读**（有权者确实能拿到 200 / 搜索确实命中），再断言无权者 404 一类的负向结果 —— 否则"上传/创建根本没成功"也会让 404 通过（**假绿**）。"比对模板"必须先用**真实的** not-found 响应**标定**，防的是"比对恒真"这种假绿（`e2e-attachments.sh` 的 D8a 就是标定用例）。

### 4.2 方言覆盖与"跳过不给信号"

- **靠直读 SQLite 文件断言的 e2e 阶段在 PG 下会整体跳过，而且不会告诉你**：`deletePage` 因此在 PG 上**从没被端到端跑到过**（⇒ PG 上删除任何页面 500 且删不掉）。
  ⇒ **每个这类阶段都要配一条方言中立（纯 HTTP）的替代断言**（`e2e-p3a.sh` 的阶段 L 就是）。
- **PG 下 FTS 检索阶段整体跳过**是设计如此（FTS 仅 SQLite）；涉及检索的结论不要假设在 PG 上跑过。

### 4.3 交界处缺陷与跨阶段回归

- **"每个阶段各自看自己那一段都对"的缺陷只能靠跨阶段覆盖抓到**：跨阶段不变量漏扇出（失效 **3 次**）与 `blocks_fts` 漏一处方言守卫，**都是交界处缺陷**。实证：`syncBlocksForPage` 的"删光重建"会让 `block_grants` 被 `ON DELETE CASCADE` 静默清空 —— 两个阶段各自看自己那一半都对，缺陷只在交界处。
  ⇒ ① 凡新增一条写共享状态的路径，都要问"**谁还要跟着变**"；② 凡"只测自己那一半"的 e2e 阶段，要**显式声明它没覆盖交界面**。
- **跨阶段回归是必须做的**：`pnpm test` 是各包单测，**覆盖不到跨阶段的服务端端到端**；合并后必须把六条 e2e 全跑一遍。

### 4.4 让失败可区分、可观测

- **把"失败"与"什么都没做"设计成可区分的信号**：`index_tiers_resynced: 0` 曾同时表示"没有子孙"（正常）与"扇出整个失败"（永久泄漏）⇒ 遂有 `index_tiers_resync_failed` + 审计 `acl.resync_failed`。
  ⇒ **凡"计数为 0"的信号，都要问一句"0 是不是有两种含义"**。
- **显式白名单而非排除法**：排除法会把将来新增的动作**默认**归进某个视图；白名单让未分类的动作只出现在 `all` 里，**漏分类是可见的失败**（`GET /api/admin/audit` 的 `acl` / `security` 两视图用 `ACL_ACTIONS` / `SECURITY_ACTIONS`；新增动作必须记得加进白名单，否则只在 `all` 可见）。

### 4.5 证据强度与复核

- **红-绿自检是最硬的证据**：临时禁用被测路径 ⇒ 断言必须**变红**（样例：临时禁用两处扇出 ⇒ `K5/K6/K14/K15` 全红并报出响应体里的 `KKK777LEAK` / `DDD999LEAK`；恢复后全绿）。**探针 → 变红 → 删除 → 复绿**。
- **检查脚本会假阳性**（grep 命中注释、grep 模式路径写错、mN 引用过期）⇒ **关键结论一律二次确认**。
- **端到端结论必须同时给出 HEAD 与取数时刻**（例：`HEAD 98b4618` + 未提交工作树，取数 `2026-09-13T22:0x+08:00`）。复核请**以你自己当时的 `HEAD` 为准并把提交号写下来**。**早期基线已过时，不要引用**。

### 4.6 前端与浏览器行为

- **前端行为不能用 curl 代替**：仓库明确记录 **"真实浏览器交互从未验证"** —— 所有端到端都是 curl，前端只有类型检查、守卫测试与 SSR 测试 ⇒ 任何前端交互结论都必须标注"**未在真实浏览器验证**"。
- **CDP 里发 ⌘Z 必须用 Ctrl（modifiers 2）**：CodeMirror 的 `Mod-` 在非 macOS 上就是 Ctrl，发 Meta 在 Linux 上**什么都不会发生**，而"撤销后正文没变"很容易被读成"符合预期"。
- **用状态行判断"有没有未保存改动"会骗人**：草稿自动保存（900ms 防抖）之后，文案从「有未保存的改动」被换成「草稿已自动保存（…）」⇒ "脏"与"已保存"在文本上不可区分；判据改成**看正文**（探针字符串在不在、原文有没有回来）。

### 4.7 验证基线（复现用）

```bash
pnpm install --frozen-lockfile        # 主工作树默认没有 node_modules
pnpm typecheck                        # 预期 exit 0（17 个包）
pnpm test                             # 各包单测（不含 e2e）
pnpm build                            # 预期 exit 0

# e2e（真实起服务 + 真实 curl，pnpm test 不包含它们）
PORT=46101 bash packages/plugin-auth/test/e2e-p1.sh      # 38/38
bash packages/plugin-oidc/test/e2e-p15.sh                # 44/44（测试内 mock IdP）
PORT=46301 bash packages/plugin-org/test/e2e-p2-org.sh   # 44/44
PORT=46401 bash packages/plugin-authz/test/e2e-p2.sh     # 34/34（SQLite）
bash packages/plugin-wiki/test/e2e-p3a.sh                # P3a：SQLite 85/0/0；PG 下 G/H/I/K 整体跳过，阶段 L 方言中立
bash packages/plugin-authz/test/e2e-p4.sh                # 80/80（后期基线）
```

**最近一次记录的全量基线**（`main` = `ed2a3a9`，由编排者实际复跑；取数时刻见当轮记录）：`pnpm typecheck` exit 0（17 包全 Done）；`pnpm test` **886 / 886 通过 / 0 失败**；`pnpm build` exit 0；六条 e2e **共 325 项断言零失败**（38 / 44 / 44 / 34 / 85 / 80）。
> 起服务后**必须轮询 `/api/health` 到 `"present":true`** 再开始验收（见 §1）。

### 4.8 已声明的验证盲区（诚实清单）

- **真实浏览器交互从未验证**（见 §4.6）。
- **PG 上新端点的运行时端到端只覆盖了部分**：审计闭环、两视图分离、会话列表在 PG 上验过；`grants/purge` 未在 PG 上跑；`e2e-p3a` 的 G/H/I/K 阶段在 PG 下整体跳过，只有**阶段 L** 方言中立。
- **AI 两条端点的端到端不泄漏未验**（需要 LLM 配置；单测层面已覆盖主体透传与 SSE 建连时取主体）。
- **D8 存量回填没有真实对象可验**（e2e 库是空的，回填无对象可作用）。
- `plugin-org` / `plugin-authz` / P3 新增的辅助函数**无单元测试**，只由 e2e 覆盖。

---

## 5. 文档纪律：注释与真源

- **文档注释会成为错误的传播媒介**：规则 B1 那个 `min` 方向错误**正是从设计文档抄进 4 处代码注释的**，而"照注释去修正实现"会**直接造出内容泄漏**。4 处落点：`packages/plugin-search/migrations/0002_blocks_fts.sql`、`packages/db-sqlite/src/migrations/0015_blocks.sql`（两处）、`packages/db-postgres/migrations/0015_blocks.sql`。
  ⇒ **引用设计的注释必须写明"哪一份是权威、以及为什么"**，否则注释会先于代码老化。
  > **复核提醒**：这几个迁移文件里至今仍出现 `min(`，但**全部是"解释为什么不是 `min`"的行文**（`packages/plugin-wiki/src/blocks.ts` 同理）。**不要再把它们"改成 `max`"，那会把注释改瞎。** 复核命令：`grep -rn "min(" packages/*/migrations/*.sql packages/*/src/migrations/*.sql`。
- **两个真源迟早漂移**：例——"哪些扩展名允许"（`ATTACHMENT_EXT_WHITELIST`）与"扩展名 → MIME"（`MIME_BY_EXT`）若是两张独立的表，今天键集合相同，将来往白名单加一项却忘了补 MIME，回退分支就会把 `text/html` 当合法类型下发 ⇒ **存储型 XSS**。
  ⇒ 用**源码级守卫测试**钉住两份清单相等，而不是靠注释里的约定。
- **关键工作笔记必须落到仓库文件里**：对话上下文会被压缩（`compress` 工具曾反复报 `session event "user/message" carries an invalid replace surfaceOp`，但压缩**实际仍生效**，用 `acp_status` 核实）⇒ **不要把关键工作笔记只留在对话上下文里**。

---

## 6. 协作与委派约定

- **派工必须写明"绝对不要创建 worktree 或分支"**：已发生过两次执行者自己另建 worktree/分支，导致工作 split 在两条分支上、编排者差点在旧基线上继续（靠"报告里的提交号与 worktree tip 对不上"才发现）。
- **子代理会继承对话上下文**，可能把自己当编排者转手派活（发生过：一行代码没写）⇒ 派工要写"你亲自写代码，禁止派发子代理 / 子会话 / 转交"。
- **job 型子代理无法用 `send_message` 插话**（报 `unavailable`）⇒ 只能事后核查；常驻子代理（reviewer / debugger / plan / docs / git）可以插话，但**不能用 `job_output` 阻塞等待**，只能等通知。
- **`interrupt_agent` 只停"当轮"**，不等于停止；用**文件 mtime** 确认原执行者真停了，别用轮数判断。
- **agent 会因上下文耗尽而中途收尾** ⇒ 派工时就把"按里程碑提交、跑不完就交代停在哪里"写死。
