-- @geewiki/builtin-docs 的状态表：docs_version 戳记 + `page:<slug>` 记账行。
--
-- 刻意只用 SQLite / PostgreSQL 都认的语法（TEXT 主键 + NOT NULL），方言中立：
-- manifest 的 `geewiki.migrations: './migrations'` 对**所有 dialect** 生效，
-- 不像 ai-journal/ai-summary 那样只登记 sqlite（它们用了 AUTOINCREMENT 等方言特征）。
--
-- 记账行是保护与接管判据的**权威来源**（不是代码里的目录清单）：
-- slug 撞名时用户的同名页面不会被接管，也就不会被锁、不会被隐藏、更不会被同步删除。
CREATE TABLE IF NOT EXISTS builtin_docs_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
