-- 0022_invitation_open_code.sql —— 邀请码不再**必须**绑定邮箱（开放码）
--
-- 与 SQLite 那一份（`packages/db-sqlite/src/migrations/0022_invitation_open_code.sql`）
-- 语义完全一致：`email IS NULL` = 通用码（持码者自填邮箱），非 NULL = 定向码。
-- 详细的"为什么要它 / 为什么保留定向码"写在 SQLite 那份的文件头里，不重复。
--
-- ★ 方言差异：SQLite 没有 `ALTER COLUMN`，那边只能整表重建；
--   PG 直接摘掉 NOT NULL 即可，两条既有索引（`idx_invitations_email` /
--   `idx_invitations_expires`）与数据都不受影响。因此本文件天然幂等。
ALTER TABLE invitations ALTER COLUMN email DROP NOT NULL;
