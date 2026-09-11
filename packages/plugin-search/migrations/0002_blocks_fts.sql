-- 0002_blocks_fts.sql —— 块级全文索引（P3a）
--
-- 见 docs/design/access-control.md §4.3（含「实测」结论与两个必须避开的坑）。
--
-- ★★ 本文件是 **SQLite 专有**（FTS5），**没有也不该有 PG 孪生文件**。
--    §3.0 的"新增表必须双侧方言成对"只管 **db 插件**的迁移；FTS5 在 PostgreSQL 上
--    不存在，`@geewiki/search` 有**显式的方言守卫**提前拒绝激活（见
--    packages/plugin-search/src/index.ts 的 apply()），这是刻意的设计——
--    **宁可显式拒绝，也不要"启动成功但检索恒为空"**（后者更难排查、且会让人误以为检索可用）。
--    PG 侧若要实现等价物是 `tsvector` + `pg_trgm`，且 §4.3 整套 tier 分层可见性都得重做
--    一遍（工作量可能与 P3a 本体相当）⇒ **明确列为非目标**。
--
-- ★★ 与 0001_search.sql 的关系：**本文件把旧的三个触发器摘掉**。
--    `pages_fts`（external content，索引 pages.title/content）连同它的三条触发器是
--    P0/P1/P2 时代的检索底层；条目级的 `WHERE slug IN (…)` 过滤在 P2 已经加上了，
--    但**索引本身仍是"整页正文"**，无法表达"同一页里部分块受限"。
--    P3a 改为块级索引后，继续让触发器往 `pages_fts` 里写是**纯浪费 + 双份漂移风险**
--    （两份索引对同一内容给出不同可见性结论），所以必须显式 DROP。
--    `pages_fts` 表本身**保留**（作为回滚锚点；需要时 `ALTER TABLE … RENAME TO pages_fts_legacy`）。
--
-- 约定同 0001：全部语句幂等，可安全重放；**不写 BEGIN/COMMIT**（控制器逐文件包事务）。

-- ① 块级索引表：contentless + contentless_delete
--
--    形态是**实测出来的**，照抄即可，改前请先复验：
--    - `content=''`      必须显式空串 —— `contentless_delete=1` 只对 contentless 表生效。
--    - `contentless_delete=1` 支持 `DELETE FROM blocks_fts WHERE rowid = ?`。
--      没有它就只能整体 rebuild。**要求 SQLite ≥ 3.43**（本仓 better-sqlite3@13.0.3 /
--      SQLite 3.53.4 满足）—— 启动时有一条 `sqlite_version()` 自检，版本不足会**显式报错**，
--      不会静默建表失败。
--    - `tokenize='trigram'` 与 0001 保持一致：FTS5 默认的 unicode61 会把连续 CJK 当成
--      一个 token，中文等于搜不到；trigram 切 3 字符片段，中文 ≥3 字可命中。
--      **硬缺口**：查询串 < 3 字符时 MATCH 恒为空 ⇒ 必须由插件层用 LIKE 兜底
--      （见 src/index.ts —— 那条路是**独立的另一条 SQL**，加权限过滤时最容易漏）。
--    - **不存正文**（contentless）：省掉一份正文存储。代价是 `snippet()` 不可用
--      （无 stored text）⇒ 高亮必须从 `blocks.text` 取原文自行标记。
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  text,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);

-- ② rowid 约定：**应用层显式把 rowid 指定为 blocks.id**
--    于是检索时可以直接 `JOIN blocks b ON b.id = f.rowid`，把过滤条件全部落在
--    `blocks`（普通表）上。这一条是避坑的前提，见下。

-- ③ ★★ 摘掉旧的 pages 触发器（必须显式 DROP，见文件头第 ★★ 段）
DROP TRIGGER IF EXISTS pages_fts_ai;
DROP TRIGGER IF EXISTS pages_fts_ad;
DROP TRIGGER IF EXISTS pages_fts_au;

-- ④ ★★ 为什么不给 blocks 建触发器 —— 后人看到没有触发器时**不要以为这里忘了写**：
--
--    0001 的同步是纯 SQL 能表达的（pages 的三个字段直接抄进索引）。块级**不是**：
--    要写进 `blocks_fts` 之前，得先算出该块的 `tier = min(页面有效档位, 块档位)`，
--    而页面有效档位取决于**祖先链的可见性交集与发布闸门**（§2.3 的规则）——
--    那是 `policy-service` 的业务逻辑，不是触发器能表达的 SQL。
--
--    ⇒ **块级索引的同步由应用层在同一事务内维护**：
--        DELETE FROM blocks_fts WHERE rowid IN (该页所有块 id);
--        逐块 INSERT INTO blocks_fts(rowid, text) VALUES (块 id, 块文本);
--    全部块写入收敛到单一模块（packages/plugin-wiki 的 blocksWriters），
--    并由 `GET /api/admin/search/verify` 比对 `blocks` 与 `blocks_fts` 的行数差与抽样命中
--    —— **这条一致性探针是 P3a 的强制验收项**，因为它替代了触发器的自动同步保证。
--
-- ⑤ ★★ 两个已实测的坑（改这段 SQL 前务必先读，它们都**不报错、只是搜不到**）：
--
--    坑 1：**tier 过滤不能写在 FTS 表上**。
--          试过 `fts5(text, tier UNINDEXED, content='', contentless_delete=1, …)` 且
--          `WHERE tier <= ?` 写在 FTS 表上 ⇒ **静默返回 0 行**：contentless 表的
--          `UNINDEXED` 列不可读，`tier` 恒为 NULL ⇒ 谓词恒不成立。
--          正确形态：`tier` 冗余在 **`blocks`** 表上，检索时
--              JOIN blocks b ON b.id = f.rowid AND b.tier <= :readerTier
--          （该路径已实测正确；anon 对 org 块恒为空）。
--
--    坑 2：**`granted` 档（tier 为 NULL）永远不被等级分支命中**，只能靠授权分支：
--              AND ( b.tier <= :readerTier OR b.id IN (:grantedBlockIds) )
--          这是刻意的（NULL 比较恒不成立 ⇒ 失败关闭）。`:grantedBlockIds` 由
--          `policy-service` 提供 —— **不允许在 SQL 里另写一套授权判定**（那是第二真源）。
--
--    另注：`pages_fts` 是 external content 表，`INSERT INTO pages_fts(pages_fts) VALUES('rebuild')`
--    可用；`blocks_fts` 是 contentless 表，**`rebuild` 语义不同**，重建只能由应用层做。
