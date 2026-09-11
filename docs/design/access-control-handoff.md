# 访问控制实现进度与交接

> **本文件是状态交接，不是设计说明。** 设计与规格看 `docs/design/access-control.md`（v7，2077 行）。
> 用途：让下一任（人或 agent）能在不看历史对话的情况下接手剩余工作。
> **维护要求：每完成一个阶段、或发现一条规格错误，就把事实写进这里。** 对话上下文会被压缩，这里不会。

## 一句话状态

**`main` = `d3a82a7`。已合入：P0 / P1 / 文档 v7 / P1.5 / P2 / P2-M5（前 3 项）/ P3a（块模型与分层检索）。**
**P3b + P3c + P3d 已完成并 rebase 到 main（分支 `feat/p3bcd-block-acl`，tip `d03be06`，等审查）。**
**P4 已实现主体（分支 `feat/p4-audit-ops`，4 个提交），六条验收标准均已满足。**

### ★ 合并后的验证基线（`main` = `975fa61`）

`pnpm typecheck` exit 0（17 包）；`pnpm test` **843 例 / 843 通过 / 0 失败**；`pnpm build` exit 0；
五条 e2e **共 245 项断言零失败**：`e2e-p1` 38、`e2e-p15` 44、`e2e-p2-org` 44、`e2e-p2` 34、`e2e-p3a`(SQLite) 85。

### ★ 下一步：P3bcd 的 rebase

`feat/p3bcd-block-acl` **堆叠在 P3a 之上但基点仍是旧的 `289f0b4`**，现需 rebase 到含 P3a 修复的 `main`。
两者都改 `packages/plugin-wiki/src/index.ts`（P3a 补子孙 tier 重算与 `resyncDescendantsReporting`；
P3b 改保守重解析、写入路径与授予/申请访问端点）⇒ **冲突需按语义合并**：P3a 的扇出调用必须保留，
P3b 的块身份保留逻辑也必须保留，**不要二选一**。

### ★ P3a 修复轮（4 个提交 `a3d72b7` / `1d608a6` / `dee82cd` / `e941da5`）

- **C1/C2 已修**：`savePage` create 分支（`packages/plugin-wiki/src/index.ts:1001`）与 `deletePage`（`:1057`）
  各调一次 `resyncDescendantsReporting(slug)`；档位端点（`:1522`）也改用它。
- **扇出保留在提交之后，而非塞进同一事务** —— 实现者给出的理由（我判断成立）：
  `pageLevelOf` 走策略层（**另一条连接**读 `pages`），**PG 的 MVCC 下看不到本事务未提交的插入/删除**；
  不会死锁，但会**读到旧值，等于没修**。因此改为把失败**升级为一等可观测信号**：
  `ResyncReport{resynced, failed, error?}` + 审计 `acl.resync_failed` + 响应字段
  `index_tiers_resync_failed` / `index_tiers_resync_error`，与 `index_tiers_resynced` 并列
  —— **让"重算了 0 个子孙"与"扇出整个失败"可区分**。泄露窗口是毫秒级；真正的风险是**失败后永久泄漏**，后者已解决。
- **红-绿自检（最硬的证据）**：临时禁用两处扇出 ⇒ `K5/K6/K14/K15` 全红，`K6` 报响应体里出现 `KKK777LEAK`、
  `K15` 报 `DDD999LEAK`（通过 71 / 失败 4）；恢复后全绿。
- **★ 又抓到第三个 PG 专有缺陷（内容级）**：`deletePage` 里的 `DELETE FROM blocks_fts ...` **没有方言守卫**
  ⇒ **PostgreSQL 上删除任何页面都返回 500 且页面删不掉**（PG 事务一旦报错即 aborted、整体回滚）。
  `blocksIndexSupported` 在回填与 `savePage` 都用了，唯独这里漏了。**此前从未被发现，是因为 e2e 的阶段
  G/H/I/K 靠直读 SQLite 文件核对 tier、在 PG 下整体跳过** ⇒ `deletePage` 在 PG 上从没被端到端跑到过。
  已修，并新增**方言中立阶段 L** 覆盖扇出的 HTTP 可见面。
- **e2e 加固**：新增阶段 K（两条扇出顺序，含"先证明前置状态可读"的反假绿断言）；修正 H 阶段两处假绿
  （H1 原按"`tier=0` 的行数"断言 ⇒ 库里有合法 tier=0 块即假绿，改为按 `run()` 的 `changes` 并加 H0 前置；
  H3 原还原语句只在"所有块恰好都该是 1"时正确，改为按记录逐行还原）。
- **验收**：`pnpm test` 823/0；`e2e-p3a.sh` SQLite **85/0/0**、真 PG 15（新库 `geewiki_e2e_final`）**32/0/7 跳过**；
  跨阶段四条 38/44/44/34 全零失败。

## 对照最初的四项需求

| # | 需求 | 状态 |
|---|---|---|
| 1 | 权限管理 | ✅ 完成 |
| 2 | 团队/组织管理 | ✅ 完成 |
| 3 | 部分条目**或条目中的内容**需权限才能显示 | ⚠️ **条目级 ✅**；**内容级（块级）实现中**（P3a 待修、P3b 基本完成、P3c/P3d 未做） |
| 4 | 未登录进站应有主页面 | ✅ 服务端门户 `/portal` 完成；✅ 前端导航能力驱动已完成（M5） |

## 分支与 worktree 现状

```
main                     953f41d   已合入 P0/P1/v7-doc/P1.5/P2/M5
feat/p3a-blocks-cont     289f0b4   worktree .wt-p3a2   ← P3a 全部实现完成；审查判不可合并，修复中
feat/p3bcd-block-acl     8a58db6   worktree .wt-p3bcd  ← P3b 基本完成；P3c/P3d/申请访问未做
feat/p3a-blocks          0f34e06   worktree .wt-p3a    ← 上面那条的祖先（旧），勿动
feat/p0-route-auth-guard / feat/p1-identity / feat/p15-oidc / feat/p2-org-visibility /
feat/p2-m5-frontend-ia              均已合入，worktree .wt-p0/.wt-p1/.wt-p15/.wt-p2/.wt-m5
```

**合并顺序与 rebase 计划**：先合 **P3a（含修复）**，再把 **P3bcd rebase** 上去。
两者都改 `packages/plugin-wiki/src/index.ts`（P3a 补子孙 tier 重算、P3b 改保守重解析与写入路径），
**rebase 必有冲突，需按语义合并**——它们是两件不同的事，不要二选一。

## P3a 的两条 Critical 泄漏（审查端到端复现；修复轮进行中）

**根因链**：`blocks.tier` 是检索用的**物化派生列**，而读路径按 slug 前缀**实时算**有效档位。
两者一旦不同步 ⇒ **读路径 404、检索却命中并吐出正文片段**。当前实现只在"改档位"一条路径上做了子孙重算。

**Critical 1 —— `packages/plugin-wiki/src/index.ts:907-937`（`savePage` create 分支）**
只有本页 `syncBlocksForPage`，**无子孙扇出**。复现：建 `a/b`（public + published）→ 匿名读 200、搜 `total=1`；
再 `PUT /api/pages/a`（默认 org）→ 匿名读 `a/b` **404**，但匿名 `/api/search` 仍 **`total:1` 且响应体出现唯一词 `CHILDUNIQ777`**。
同刻 `blocks/verify` 报 `tier_mismatched:1, mismatched:0`。

**Critical 2 —— `packages/plugin-wiki/src/index.ts:991-1007`（`deletePage`）**
无扇出。复现：`a`=private、`a/b`=public + published + **`inherit=false`**（断链点）、`a/b/c`=public + published
→ 匿名读 `c` 200、搜得到；`DELETE /api/pages/a%2Fb` 后 → 匿名读 404，但匿名搜仍吐 `DEEPUNIQ999`。

**根因（已独立核实）**：`packages/plugin-authz/src/index.ts:261-271` 的 `effectiveRank`——
`ancestorsOf` **由近及远**；对**缺失**祖先 `continue`（不构成收紧）、对 `inherit !== 1` 才 `break`（断链）。
删掉断链点后更上层更严的祖先**重新开始压制**，rank 0→2，而 `blocks.tier` 仍为 0。
**`continue`/`break` 的不对称是刻意的，不要去改它**，只能补"档位变了要重算 tier"。

**要求的修法**：`savePage` create 分支与 `deletePage` 事务提交后各调一次 `resyncDescendantTiers(slug)`（与 `:1404` 同写法）；
并评估能否把扇出放进同一事务（当前扇出在提交**之后**且失败只 `console.warn` ⇒ 泄漏窗口 + 无自动修复，
`index_tiers_resynced=0` 与"没有子孙"不可区分）。
**e2e 必须补这两条顺序的断言**——现有脚本 G 阶段**只测了"改档位"**，所以它绿着而泄漏仍在。

## P3b/P3c/P3d 状态

已完成（5 个提交，`feat/p3bcd-block-acl`）：`0014_access_requests.sql` + `0016_block_grants.sql`（双方言，
含 `idx_block_grants_subject`）；`grantedBlockIds()` 真实查询（user 直授 + groupIds 组授、**按 `expires_at` 过滤**、
匿名/break-glass 返回空集、**激活期表存在性自检**）；投影授权分支；**保守重解析**（保留块 id、拆分继承授权、
合并/删除已授权块 409，全部在写入前拒绝）；块级治理与授予端点（3 个，含 `acl_revision` 递增与审计）。

**未完成**：① 申请访问流程端点（表已建、端点未做，§8.2 P3b 第 6 条）；② **P3c 完全未开始**（`0017_version_blocks.sql`、
`blocks_json`/`acl_json`、"改权限也产生版本"、四位一体恢复、1MB 上限、老版本 `warnings:['block_acls_not_restored']`）；
③ **P3d 完全未开始**（标记高亮、「预览为匿名视角」开关）。

**★ 一条跨阶段的隐性依赖（P3b 执行者发现的）**：`syncBlocksForPage` 的"删光重建"会让 `block_grants`
被 `ON DELETE CASCADE` **静默清空** ⇒ P3b **必须**改写入路径。两个阶段各自看自己那一半都对，
**缺陷只存在于交界处**——这是"必须做跨阶段 e2e"的实证。

## P4 状态（分支 `feat/p4-audit-ops`，worktree `.wt-p4`，基线 `d3a82a7`）

**已实现（4 个提交）**：

- `03c47f0` **越权尝试记录 + 审计查询**。`access.denied` 此前在 `AuditEntry` 的文档注释里被列为
  预期动作但**从未被写入**；现由 `packages/plugin-wiki/src/index.ts` 的 `recordAccessDenied` 独家写入，
  三处调用点（详情路由 404 分支、backlinks、links）。
  **关键判据：只在"页面存在、但对该主体不可见"时记录** —— 对外两条路径都返回 404（§2.3 不泄露存在性），
  但服务端内部分得清：「请求了不存在的页」只是普通 404，「请求了存在但无权看的页」才是越权尝试。
  `GET /api/admin/audit`（`access: admin`）用 `view` 把两类**分开**：`acl`（权限/配置变更，合规记录要留存）、
  `security`（越权尝试与特权访问，安全事件要告警）、`all`。
  **用显式白名单而非排除法** —— 排除法会把将来新增的动作默认归进 acl 视图；白名单让未分类的动作
  只出现在 `all` 里，漏分类是**可见的**。支持 action / targetKind / targetId / since / until 过滤，limit 上限 200。
- `3ce534d` **会话管理**：`GET /api/admin/sessions`（列出，带 `active|expired|revoked` 综合状态）、
  `POST /api/admin/sessions/:id/revoke`（定点吊销）、`POST /api/admin/users/:userId/sessions/revoke`（批量）。
  服务端吊销写 `revoked_at`；**`token_hash` 连哈希都不出接口**；重复吊销幂等**且不重复写审计**。
- `391aece` / `96780a1` **e2e `packages/plugin-authz/test/e2e-p4.sh`（37 项断言，全通过）+ 过期授权回收端点**
  `POST /api/admin/grants/purge`（**只做空间回收** —— 失效在判定时就发生；只在真回收了才写审计）。

**两条源码级守卫**（`packages/plugin-authz/test/audit-appendonly.test.ts`，由 `pnpm test` 覆盖）：
`audit_log` 无 UPDATE/DELETE（§8.2 P4 第 2 条）、`page_versions` 无保留策略清理（第 6 条）。
**做过红-绿自检**（探针 → 变红 → 删除 → 复绿）。

★★ **第 6 条按字面与既有合法代码冲突，已按真实意图落为"白名单 + 锚定"**：验收原文是
"代码中无删除 `page_versions` 行的路径"，但 `deletePage` 本来就要删掉**被删页自己的**版本 ——
那是页面生命周期级联，与 D11 反对的"保留策略清理"是两回事。按字面写会让守卫与既有代码冲突、
然后被人放宽，那等于没有守卫。现判据：只允许一处，且必须锚定在 `deletePage` 内。

**★ 三处"断言自己会骗人"的实例（本阶段踩到两次，值得记住）**：
① e2e 的 C1 第一版把四个 `grep -o | wc -l` 的结果**拼成字符串**再比 "4"（得到 "1111"），永不可能通过；
② 阶段 G 第一版造了两条 `subjectId` 相同的授予，而授予端点**按主体幂等 upsert** ⇒ 第二条覆盖第一条、
库里没有过期行、`purge` 恒返回 `expired=0` 也照样"通过"；
③ 阶段 G 还漏了"阶段 E 结尾批量吊销了所有会话 ⇒ `$JAR` 已失效"，会以"看起来对"的方式失败。

**已满足的验收标准**：第 1 条（ACL 变更入审计且不含正文）、第 2 条（守卫）、第 3 条（到期判定即时生效，
回收只是回收）、第 4 条（越权记录 + 两视图分开）、第 5 条（两个 verify 端点，P3a 已交付）、第 6 条（守卫）。

**未做（诚实列出）**：
- **反向展开**（"谁能看这条"：直接授予 / 祖先链收紧 / 组织角色覆盖三条来源）—— 设计 §8.1 P4 行有此项
- **运维动作**：门户缓存清理提示（`s-maxage=300` ⇒ 收紧后需"清缓存 + 请求重新抓取"，§5.12）、
  `/sitemap.xml` 与匿名可见集合做集合差的核对入口、组织站点级设置接到界面
- `invitations.expires_at` 的回收（本轮只做了 `page_grants`；`invitations` 在 `packages/plugin-org`）
- **前端界面**：审计页与会话管理页都**只有后端端点**，未接界面
- PG 上验了审计闭环、两视图分离、会话列表；`grants/purge` 未在 PG 上跑（它与会话端点一样是纯 SQL，
  但 **PG 的 `COUNT(*)` 返回字符串**这一点在两条端点上都必须 `Number()` 强转，已在代码里处理）

## ★★ 待回写的设计文档更正（**累积清单，不要丢**）

1. **§2.3 规则 B1 的方向写反了（安全相关）**：文档写 `effectiveBlockTier = min(block, page)`，但那句话的刻度是
   "**宽松度**"（越大越宽松），而 `tier` 列是"**限制等级**"（`b.tier <= :readerTier`，**越小越公开**）
   ⇒ 同一语义必须是 **`max`**。写反会让"页面 org + 块 public"的块拿到 tier 0，**匿名在搜索里就能搜到它**。
   以代码的 `effectiveIndexLevel` / `packages/plugin-authz` 的 `RANK_*` 为准（`RANK_PUBLIC=0 / RANK_ORG=1 / RANK_PRIVATE=2`，越右越窄）。
   **★ 这条错误已扩散到代码注释里，且共 4 处、只修了 1 处**：
   - ✅ 已修：`packages/plugin-search/migrations/0002_blocks_fts.sql:60-62`（提交 `1d608a6`，现在写着
     "用 `tier` 的刻度写就是 **`max`**"并解释了照文档写会让"页面 org + 块 public"的块拿到 `tier = 0`）
   - ❌ **未修的三处**：`packages/db-sqlite/src/migrations/0015_blocks.sql:41`、同文件 `:53`、
     `packages/db-postgres/migrations/0015_blocks.sql:29` —— 都还写着 `min(块档位, 页面有效档位)`。
     **风险**：后来的人读注释会以为实现写错了，去"修正"成 `min` ⇒ **直接造出泄漏**。
   - 参照：`packages/plugin-wiki/src/blocks.ts:224` 有一处**解释正确**的注释（说明为什么这里是 `max`）。
2. **§3.6 的迁移落点是错的**：文档说写 `plugin-wiki/migrations/`，但 `@geewiki/wiki` 的迁移目录**只声明了 sqlite**
   ⇒ 照文档写，**PG 部署下 `blocks` 表根本不会被建出来**。实际落在 db 包、两侧成对。
3. **§9 R9（约 1558 行）写错**：把 `navOrder.test.ts（导航合并）` 列为"P2 必然触碰"——
   该文件测的是 `lib/navTree.ts` 的前后序，**与顶栏导航无关**（审查用 `git diff --stat` 证明其 diff 长度 0 行）。
4. **`tier` 必须内联在 `CREATE TABLE` 里**（不是另起 `ALTER ... ADD COLUMN`）：SQLite 没有"加列时若已存在则跳过"的语法
   ⇒ 独立 ALTER 会让迁移**无法重放**（P2 在 0012 上踩过并用守卫测试钉死）。
5. **config 脱敏的判据被放宽**：文档只写 break-glass，实现为 **break-glass 或 `orgRole ∈ {owner,admin}`**
   （否则登录为 owner 的管理员拿不到 config、配置表单无法回填；不重新打开匿名泄漏）。两条通道都堵
   （`/api/plugins` + `/api/session` 经 `PluginListFile.enabled[].config`），**未改 `snapshotOf()`**（改了会打瞎配置表单）。
6. **`snippet()` 是静默失败**：设计写"不可用"，实测是**返回 `null` 而不报错**（我已用真 probe 验过）。
7. **§8.2 的 P2 验收标准 1–14 全是后端项**，没有前端 IA 条目 ⇒ M5 工作**没有设计文档层面的验收标准**。
8. **§4.3 低估了 P3a 的方言成本**：文档说"块模型与读路径裁剪两部分仍可两方言落地"——
   在这**三个** PG 缺陷修掉之前那句话不成立：① 写块靠捕获异常判"`blocks_fts` 不存在"，只匹配 SQLite 的
   `no such table:`（PG 文案是 `relation "blocks_fts" does not exist`）⇒ 每次写块都失败；② 缺 `RETURNING id`
   ⇒ PG 报 `violates foreign key constraint "blocks_page_id_fkey" / Key (page_id)=(0) is not present`；
   ③ **`deletePage` 里的 `DELETE FROM blocks_fts` 没有方言守卫 ⇒ PG 上删除任何页面返回 500 且删不掉**。
   建议补一句：*"块模型的 PG 可用性依赖 `RETURNING id`、索引表存在的方言判定、以及每一处 `blocks_fts` 语句的
   方言守卫——**这三点都不由类型系统保证，必须有真方言 e2e 兜底**。"*
9. **`blocks_fts` 只索引块文本** ⇒ **FTS 路不再按标题匹配**（LIKE 路仍匹配）。这是 §4.3 SQL 形态的直接后果，
   已有断言钉住。建议写进文档。
10. **`系统状态`（服务健康/DB 方言/表清单）随 `管理 ▾` 下沉为管理员专属**——文档里 `grep 系统状态|服务健康`
    **零命中**，规格从未表态。**编排者裁定：维持管理员专属**（内容是运维细节，与所在分组的"运维台面"语义一致；
    `GET /api/health` 本身仍是公共端点，看门狗不受影响）。

## 环境约束与教训（**必须遵守**）

- **沙箱只允许写 `/root/dev/geewiki` 之内** ⇒ worktree 必须建在仓库内（`.wt-<阶段>`）。
- **⛔ 派工必须写明"绝对不要创建 worktree 或分支"**。已发生过两次：执行者自己另建 worktree/分支，
  导致工作 split 在两条分支上、编排者差点在旧基线上继续（靠"报告里的提交号与 worktree tip 对不上"才发现）。
- **路径陷阱**：`edit`/`write` 按**会话工作区（主工作树）**解析相对路径 ⇒ 在 worktree 里干活**必须用绝对路径**。十三位执行者里踩过的占多数。
- **`subagent_implementer` / `subagent_general` 会继承对话上下文**，可能把自己当编排者转手派活（发生过：一行代码没写）⇒ 派工要写"你亲自写代码，禁止派发子代理/子会话/转交"。
- **job 型子代理无法用 `send_message` 插话**（报 `unavailable`）⇒ 只能事后核查。常驻子代理（reviewer/debugger/plan/docs/git）可以，但**不能用 `job_output` 阻塞等待**，只能等通知。
- **`interrupt_agent` 只停"当轮"**，不等于停止；用**文件 mtime** 确认原执行者真停了，别用轮数判断。
- **agent 会因上下文耗尽而中途收尾** ⇒ 派工时就把"按里程碑提交、跑不完就交代停在哪里"写死。
- **PG 隔离配方**：临时目录写 `plugins.base.json`，`@geewiki/postgres` 内联 `config` 用 `passwordEnv: "GEEWIKI_DB_PASSWORD"`；
  启动 `GEEWIKI_CONFIG_DIR=<tmp> GEEWIKI_DATA_DIR=<tmp> GEEWIKI_DB_PASSWORD=testpw GEEWIKI_PORT=<自选> node --import tsx packages/server/src/index.ts`。
  ⚠️ **必须轮询 `/api/health` 到 `"present":true` 才开始验收**（http 就绪即 200，迁移可能没跑完 —— 三位执行者栽在这里）。
- **PG 共享库 `geewiki_test` 已"中毒"**（留着先前运行的 owner 账号 ⇒ e2e 跳过 setup 直接登录 ⇒ 全线 401 假失败）⇒ 用干净库 **`geewiki_e2e_clean`**。
- **容器 `geewiki-pg-test`**：`postgres:15-alpine`，host `127.0.0.1` port **55432**，user `geewiki` / password `testpw`。
- **端口分段避让**：41xxx PG 验证 / 42xxx P1.5 / 43xxx P2 / 45xxx 合并验证 / 46xxx M5 合并 / 47xxx P3a / 48xxx M5 前端 / **50xxx P3bcd**
- **`plugin-search` 在 PG 上报** `迁移失败（已回滚）: 0001_search.sql error: syntax error at or near "VIRTUAL"` —— **预期行为**
  （插件有显式方言守卫 `packages/plugin-search/src/index.ts:307-320`）。根因是它用**裸字符串**声明 `migrations: './migrations'`（`:67`）
  ⇒ 在 `resolveMigrationsDirs` 里归入 `'default'` 键被所有方言命中；**最小修法一行**：`migrations: { sqlite: './migrations' }`。
- **FTS5 实测（编排者跑的真 probe）**：SQLite **3.53.4**（better-sqlite3 13.0.3）；`contentless_delete=1` 建表/删除/rowid 复用均 OK；
  **trigram 3 字符门槛真实**（2 字查询 `MATCH` 恒为空 ⇒ 短查询必须走 LIKE 兜底）；**`snippet()` 静默返回 `null` 而不报错**；
  **`tier` 过滤绝不能写在 FTS 表上**（contentless + `UNINDEXED` 会静默返回 0 行）。
- **SQL 括号陷阱**：`A OR B AND C` 的优先级是 `A OR (B AND C)` ⇒ 权限过滤条件必须加括号（P2 栽过一次）。
- **SQLite 没有 `ADD COLUMN IF NOT EXISTS`** ⇒ 给既有表加列的迁移**无法重放**（守卫测试已钉死，**不要放宽**）。
- **既有守卫测试有基于文本启发的**（如 `/\bADD\s+COLUMN\b/i` 判断迁移可重放）⇒ **注释里写这几个词会被误判**。
- **`/tmp` 在本沙箱跨 bash 调用不保留** ⇒ 日志要写在工作区内或同一条命令里消费。
- **主工作树默认没有 `node_modules`** ⇒ 在 main 上跑 typecheck/test 前需 `pnpm install --frozen-lockfile`。
- **`compress` 工具反复报错** `session event "user/message" carries an invalid replace surfaceOp`，但**压缩实际仍生效**（用 `acp_status` 核实）。
  ⚠️ **教训：不要把关键工作笔记只留在对话上下文里——压缩会吃掉它们（本文件就是这么产生的）。**
- **编排者（我）犯过的错**：① 指令里写过 `901`/`8192` 两个**不存在**的数值；② 任务书写成 `/api/slots`，真实是 `/api/plugins/slots`；
  ③ 要求补的 `details` 修复**原本无测试覆盖**；④ 任务书要求"同步更新 `navOrder.test.ts`" —— **错，该文件与顶栏导航无关**；
  ⑤ **检查脚本四次假阳性**（grep 命中注释、grep 模式路径写错、mN 引用过期）⇒ 关键结论一律二次确认。

## 验证基线（复现用）

```bash
pnpm install --frozen-lockfile        # 主工作树默认没有 node_modules
pnpm typecheck                        # 预期 exit 0（17 个包）
pnpm test                             # main 上 831 例全绿；各分支基线见其提交信息
pnpm build                            # exit 0

# e2e（真实起服务 + 真实 curl，pnpm test 不包含它们）
PORT=46101 bash packages/plugin-auth/test/e2e-p1.sh      # 38/38
bash packages/plugin-oidc/test/e2e-p15.sh                # 44/44（测试内 mock IdP）
PORT=46301 bash packages/plugin-org/test/e2e-p2-org.sh   # 44/44
PORT=46401 bash packages/plugin-authz/test/e2e-p2.sh     # 34/34（SQLite）
bash packages/plugin-wiki/test/e2e-p3a.sh                # P3a：SQLite 59/0/0、PG 22/0/6 跳过
```

**跨阶段回归是必须做的**：P3a 分支上既有四条 e2e 共 160 项全绿；P3bcd 分支上五条共 219 项全绿。
`pnpm test` 是各包单测，**覆盖不到跨阶段的服务端到端**。

## 已知未完成的安全/质量项（非阻塞，应跟进）

- `packages/web/src/pages/WikiPage.tsx:341,487` 仍有两个**未按 `editContent` 收口**的「新建页面」按钮
- **能力不随角色变更刷新**：`capabilities` 只在 `loadAuth()` 写入；`denied`(403) 分支只跳转不刷新
  ⇒ 提升后不重载看不到新入口、降级后旧入口留着（外观层面的失败开放；服务端仍独立判定）
- `<SlotOutlet name="app-header" />` **零门控**（当前无插件贡献该槽，属潜在洞）
- 测试守卫窄缝：`packages/web/test/navPlan.test.ts:127-137` 的 `id` 计数正则；`navGate.test.ts:84-86` 以子串 `管理` 计数
- `packages/plugin-auth/src/index.ts:1278` 的 `clearLink()` 被重复调用且无 `writableEnded` 防护
- `packages/web/src/pages/AccountPage.tsx:63` 跳登录丢掉 `link=required`
- `packages/plugin-oidc/test/oidc.test.ts` 缺三块单测（`kid` 未命中强制刷新一次、`nbf` 边界、`jwks_empty` 失败关闭）
- `backlinks`/`links` 的可见性防护在**路由层**（`packages/plugin-wiki/src/index.ts:1217-1249` 两重检查），
  **服务方法本身仍只查 `pageExists`**（`:765-772`）—— 无当前消费者的不对称点
- `packages/db-postgres` 的 20 例是 **`fakePool()` 桩测试**（`packages/db-postgres/test/postgres.test.ts:98` 起），**不连真库**
- P3a 的扇出性能（子树 N 页 = N 次全表扫描）；检索不再覆盖 `page_grants` 与 owner/admin 覆盖（方向是"少给"，非泄漏）；
  `search/verify` 的 `tier_mismatch` 只做 NULL 计数代理 ⇒ 对"非 NULL 的陈旧 tier"完全盲
- `packages/plugin-wiki/src/blocks.ts:22` 曾声称"有源码级守卫测试钉住唯一写入路径"而**该测试不存在**（修复轮要求补上）；
  `0002_blocks_fts.sql:63` 引用的模块名 `blocksWriters` 不存在（实际是 `blocks.ts` 的 `syncBlocksForPage`）

## 未验证项（诚实清单）

- **真实浏览器交互从未验证**：所有端到端都是 curl；前端只有类型检查、守卫测试与 SSR 测试
- **多实例部署必然失败**（OIDC 流程状态存进程内，**失败关闭方向**）
- **AI 两条端点的端到端不泄漏未验**（需要 LLM 配置；单测层面已覆盖主体透传与 SSE 建连时取主体）
- **D8 存量回填没有真实对象可验**（e2e 库是空的，回填无对象可作用）
- 移动条目后权限变化、第二个账号授权后立即可见 —— 未构造
- `plugin-org` / `plugin-authz` / P3a 新增的辅助函数 **无单元测试**，只由 e2e 覆盖
- PG 模式跳过了检索阶段（FTS 仅 SQLite，设计如此）与部分 e2e 阶段
