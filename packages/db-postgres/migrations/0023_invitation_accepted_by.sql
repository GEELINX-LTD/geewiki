-- 0023_invitation_accepted_by.sql —— 邀请记录"是谁用它进来的"
--
-- 与 SQLite 那一份（`packages/db-sqlite/src/migrations/0023_invitation_accepted_by.sql`）
-- 语义完全一致：`accepted_by` = 凭这条邀请入伙的用户；NULL 表示还没被用，
-- 或这是一条 0023 之前的历史行（不做回溯猜测）。详细的"为什么要它 / 为什么允许 NULL"
-- 写在 SQLite 那份的文件头里，不重复。
ALTER TABLE invitations ADD COLUMN accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
