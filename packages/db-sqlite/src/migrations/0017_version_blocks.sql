-- 0017_version_blocks.sql —— 版本快照承载「权限」（P3c）
--
-- 见 docs/design/access-control.md §3.5 / §4.4。给 `page_versions` 增两列：
--   blocks_json —— 该版本的**块集合快照**（JSON 数组：ordinal/kind/text/visibility/inherit）
--   acl_json    —— 该版本的**页面级 ACL 快照**（visibility/published_at/inherit）
--
-- ★★ **为什么版本必须承载权限**（本阶段最重要的一条规则）：
--    「恢复此版本」若只恢复正文、不恢复权限，就会出现这种事故 ——
--      三月把某段设成「仅编辑者可见」，六月放开成「组织可见」，
--      此时恢复三月那一版：系统会把**三月的正文**配上**现在的权限**还给你，
--      结果可能是**把本该受限的内容放开了**。故恢复必须是**四位一体**：
--      正文 + 块级权限 + 页面 visibility + published_at + inherit。
--    由此推出配套规则：**任何权限变更（visibility / published_at / inherit /
--    块级 visibility / 授予）都必须产生一条新的 page_versions** —— 否则版本里的
--    权限快照会与实际权限脱节，「恢复」就会恢复出错误的（可能是放宽的）权限。
--    这类版本 `content` 不变、只有 `blocks_json`/`acl_json` 变化，由写入路径产生。
--
-- ★ 老版本（本列加入之前写入的行）`blocks_json IS NULL` ⇒ 恢复时**只恢复正文**，
--   并在响应里带 `warnings: ['block_acls_not_restored']`。**绝不猜测老版本的权限** ——
--   猜错的后果正是上面那个泄漏。
--
-- ★ 必须用 TEXT 而不是 JSONB（PG 侧同理）：业务代码只做整体读写、不做 JSON 查询，
--   而 TEXT 让**双方言 SQL 逐字相同**，不引入方言分支。恢复时校验 1MB 上限（超限 413）。
--
-- ★ **本文件在 SQLite 上不可重放**：`ALTER TABLE ... ADD COLUMN` 没有
--   `IF NOT EXISTS` 形式（SQLite 的方言边界，与 0012 同类）。生产幂等性由
--   `_migrations` 控制器提供（已应用的文件不再执行）；`slug-hierarchy.test.ts` 里
--   那条重放守卫会把这个限制**钉死**：第二次执行必须抛 `duplicate column name`。
--
-- 约定同 0001/0010/0011/0012/0013/0014/0015/0016：**不写 BEGIN/COMMIT**（控制器逐文件包事务）。

ALTER TABLE page_versions ADD COLUMN blocks_json TEXT;
ALTER TABLE page_versions ADD COLUMN acl_json    TEXT;

-- 「某页权限版本」的查询形态：按页取最新一条，`saved_at` 倒序已在 idx_page_versions_page_id
-- 覆盖（`(page_id)`），数据量小，不再额外加索引 —— 避免为一次读取引入写放大。
