-- 0001_page_summaries.sql —— 每页一份的 AI 摘要（用户需求 ③④）
--
-- 为什么摘要要有自己的表，而不是在 `pages` 上加一列：
--   ① `pages` 属**核心数据**，它的迁移在 `@geewiki/db-sqlite` 里；而摘要是**可再生的派生
--      数据**——它随时可以被删掉重算，丢了不影响知识库。把可再生的东西加进真源表，
--      会让"能不能重建摘要"变成一个需要小心对待的问题（备份、还原、导出都得决定它算不算）。
--   ② 摘要**属于插件**。`@geewiki/ai-summary` 停用后，它的表留着不碍事、删掉也不影响任何
--      别的插件（没有外键指向它）。这正是插件平台想要的边界。
--
-- 不写 BEGIN/COMMIT：`db.migrate()` 已把每个迁移文件包在单个事务里（同 0001_search 的约定）。

CREATE TABLE IF NOT EXISTS page_summaries (
  -- ★ 主键就是 `pages.id`，于是它同时是 SQLite 的 rowid 别名。
  --   一个 page 至多一份摘要（重算是 UPDATE 而不是 INSERT 第二行）——
  --   "同一页有两份摘要"会让卡片显示哪一份变成任意选择，且两份可能互相矛盾。
  page_id      INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  -- 审计冗余：`page_id` 才是真源（同 `attachments.page_slug` 的口径）。
  -- 保留它是为了让"摘要表里有哪些页"这条排查查询不必联表。
  slug         TEXT    NOT NULL,
  summary      TEXT    NOT NULL,
  -- 生成时用的是**哪一档读者的投影**（见 src/index.ts 的 projectedFor）：
  --   'public' = 匿名可见的投影 / 'org' = 组织成员的投影 / 'restricted' = 应急旁路（全量）。
  -- 这一列是**可审计性**，不是权限判据（判据在服务端每次现算）。
  audience     TEXT    NOT NULL,
  -- 生成时用的模型名。排障时第一个要问的就是"这份摘要是哪个模型写的"。
  model        TEXT    NOT NULL,
  -- 生成时输入正文的 sha256。**判过期用它，不用时间戳**：
  --   `updated_at` 只到毫秒，同一毫秒内的"生成"与"保存"会比不出先后；
  --   而内容哈希既精确又不会被"内容没变的保存"误伤。
  source_hash  TEXT    NOT NULL,
  generated_at TEXT    NOT NULL
);

-- 按 slug 取摘要（卡片的读路径）走它；`page_id` 主键只覆盖"按 id 查"。
CREATE INDEX IF NOT EXISTS idx_page_summaries_slug ON page_summaries(slug);

-- ★ 这里**刻意没有** FTS5 虚拟表，与 `@geewiki/search` 的 `blocks_fts` 不同：
--   摘要很短（默认上限 300 字符）且**一页只有一条**，于是"按摘要检索"是一条
--   覆盖全表的 LIKE 扫描 —— 在这个体量上它比维护第二份 FTS 索引更便宜，而且
--   **方言中立**（PG 上照样工作，不需要 @@geewiki/search 那种"非 sqlite 直接抛错"的守卫）。
--   代价如实记在这里：条目数到十万量级时这条扫描会成为瓶颈，届时该换成真正的索引；
--   判断口径见 src/plan.ts 的 searchSummaries 注释。
