-- 0002_pages_updated_at_index.sql —— 列表查询的排序索引
--
-- 背景：页面列表（`GET /api/pages`）按 `updated_at DESC` 排序，而 0001 只给
-- `page_versions.page_id` 建了索引，`pages.updated_at` 上没有索引 ⇒ 每次列表都是
-- `SCAN pages` + 临时 B 树排序。
--
-- 为什么索引是**复合**的 `(updated_at DESC, id DESC)`：
-- 1. 与查询的 `ORDER BY p.updated_at DESC, p.id DESC` **逐列对应**，SQLite 可直接走索引
--    取有序结果，省掉临时 B 树（实测计划由 `SCAN pages | USE TEMP B-TREE FOR ORDER BY`
--    变为 `SCAN pages USING INDEX idx_pages_updated_at`）。
-- 2. **次级键必须进索引**：`updated_at` 是 ISO 秒级字符串，批量创建/脚本导入极易并列。
--    实测同一份并列数据，加索引后单键排序的结果会**完全反转**（`alpha,beta,…` →
--    `epsilon,delta,…`）——即"看起来稳定"的顺序会随查询计划悄悄翻转，分页/侧边栏
--    会因此漏项或重项。把 `id DESC` 写进索引，索引顺序与 SQL 顺序就永远一致。
--
-- 幂等：`IF NOT EXISTS`，且本文件由 `db.migrate()` 包在单个事务里执行
-- （**不要**在此写 BEGIN/COMMIT，会嵌套报错）。

CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at DESC, id DESC);
