-- 站点主页（2026-09-18，主页批）。
--
-- 一行（`id = 1`）：存"本站主页指向哪一篇页面"的 slug。
--
-- 为什么要有它：主页原先**只有约定** —— slug 恰为 `home` 的那一篇
-- （`packages/web/src/lib/wikiRoute.ts` 的 `HOME_SLUG` 与 README 的「开发」一节）。
-- 约定 slug 的好处是零迁移、零新表，也是 `wikiRoute.ts` 头注里明写的默认值方案；
-- 但它把"本站主页是哪一篇"绑死在一个名字上：库里已有一篇 `home` 时，
-- 想换主页就得改那一篇的 slug（= 改 URL、丢外链与历史深链）。
-- 本表把这件事变成一条可写、可清、可回落的设置。
--
-- 为什么不放进 `pages` 表（与 `page_nav_state` 0003 是同一条理由，此处不重复全文）：
--   ① 主页设置**不参与可见性判定**。策略层的唯一真源仍是 `pages.visibility/published_at`
--      与块的 `tier`；把"摆在首页"混进去，会让"看不见"与"没摆在首页"在下一个人手里
--      很容易被写成同一个判断；
--   ② `pages` 的建表语句在两个驱动里各有一份（`db-sqlite/src/migrations/0001_init.sql`、
--      `db-postgres/migrations/0001_init.sql`），加列要同时动两边，并顺带影响所有
--      `SELECT * FROM pages`；而这张表的读写只在 @geewiki/wiki 内部。
--
-- 为什么不是 `builtin_docs_state` 那种键值表：本表**只有一个键**。键值对会把
-- "是否已设置"变成"这一行在不在"与"值是不是空串"两种判据，而两者在写入方拼错时
-- 会给出不同答案。一行一张表：**没有行 = 未设置 = 回落约定 slug `home`**，只有一种判据。
--
-- 与 `page_nav_state` 一样刻意**方言中立**（INTEGER/TEXT、无 BOOLEAN、无 NOW()）：
-- 一份 SQL 同时跑 SQLite 与 PostgreSQL。写路径的 upsert 同样只用
-- `ON CONFLICT ... DO UPDATE SET x = excluded.x`（两驱动通用）。
CREATE TABLE IF NOT EXISTS site_home (
  -- 恒为 1（单行表）。不写 CHECK 约束：约束在"两驱动同一份 DDL"下的行为差异
  -- 不值得为一行表引入，而 id 只由 `setHomeSlug` 一处写入（常量 1）。
  id         INTEGER PRIMARY KEY,
  -- 主页页面的 slug。该页面被删除时由 `deletePage` **同事务**清掉这一行，
  -- 不留指向不存在 slug 的悬挂设置（见 plugin-wiki/src/index.ts 的 deletePage）。
  slug       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
