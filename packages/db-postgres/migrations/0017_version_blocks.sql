-- 0017_version_blocks.sql —— 版本快照承载「权限」（PostgreSQL 方言）
--
-- 与 packages/db-sqlite/src/migrations/0017_version_blocks.sql **语义等价**。
-- 方言差异对照：
--
-- | 语义     | SQLite                          | PostgreSQL                |
-- | -------- | ------------------------------- | ------------------------- |
-- | 增列     | ALTER TABLE … ADD COLUMN（逐条）  | 同左（同一形状）           |
-- | 列类型   | TEXT                            | TEXT（**刻意保持 TEXT**）  |
--
-- **为什么是 TEXT 而不是 JSONB**：业务代码只对该列做整体读写（序列化 / 反序列化），
-- 从不做 JSON 路径查询。用 JSONB 会让两侧 SQL 出现方言分支（SQLite 无对应类型），
-- 而 TEXT 让**双方言语义逐字相同**。代价是放弃数据库层的 JSON 校验 —— 由写入路径
-- 与恢复路径的上限校验（1MB ⇒ 413）承担。
--
-- **本文件的增列在 PG 上不重写表**：加的是**可空、无默认值**的列，PG 11+ 对这种情况
-- 只更新目录（与 0012 那批 `NOT NULL DEFAULT` 不同 —— 那批会锁表重写，本项目规模下
-- 可接受，这里则连重写都没有）。
--
-- 语义与理由（为什么版本必须承载权限、老版本怎么办、四位一体恢复）见 SQLite 侧同名文件，
-- 此处不重复。约定同 0001/0010/0011/0012/0013/0014/0015/0016：**不写 BEGIN/COMMIT**。

ALTER TABLE page_versions ADD COLUMN blocks_json TEXT;
ALTER TABLE page_versions ADD COLUMN acl_json    TEXT;
