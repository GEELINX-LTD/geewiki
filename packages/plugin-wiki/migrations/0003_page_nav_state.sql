-- 侧栏导航状态（2026-09-16，导航批）。
--
-- 两张表，因为它们是**两件不同的事**：
--
-- ① `page_nav_state` —— "在左侧边栏隐藏"（站点级，所有人看到的导航一致）。
--    只有**页面**才能被隐藏（分组没有可隐藏的东西），所以主键就是页面 slug。
--
-- ② `page_nav_order` —— 同一层级内的自定义顺序，**按父级存一整串**。
--    为什么不是"每个页面存一个 sort_key"：同层里混着**没有页面的分组**
--    （本仓的层级由 slug 决定，`guide/architecture` 存在而 `guide` 本身可能不是页面），
--    而分组没有可写 sort_key 的地方 —— 那样一来分组永远排不了序，还会在
--    "排过序的页面在前、没排过的在后"的规则下被整体挤到同层最下面。
--    这里让 `item` 同时容纳两种身份：页面 slug，或分组路径（如 `guide`）。
--    分组路径的形状与 slug 完全一致，因此"直接子级"的判据
--    （`parentOf(item) == parent`）对两者是同一条规则。
--
-- 为什么**不放进 pages 表**：
--   ① 这两个字段**不参与可见性判定**。策略层的唯一真源仍然是
--      `pages.visibility/published_at` 与块的 `tier`；把导航呈现混进去，会让
--      "看不见"与"不列出来"两件事在下一个人手里很容易被写成一个判断；
--   ② `pages` 的建表语句在两个驱动里各有一份（db-sqlite/src/migrations/0001_init.sql、
--      db-postgres/migrations/0001_init.sql），加列要同时动两边并顺带影响所有
--      `SELECT * FROM pages`；而这两张表的读写只在 @geewiki/wiki 内部。
--
-- 与 `builtin_docs_state` 一样刻意**方言中立**（INTEGER/TEXT、无 BOOLEAN、无 NOW()）：
-- 一份 SQL 同时跑 SQLite 与 PostgreSQL。
CREATE TABLE IF NOT EXISTS page_nav_state (
  slug       TEXT PRIMARY KEY,
  hidden     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_nav_order (
  -- 父级路径；顶层为空串（不用 NULL：主键里的 NULL 在两种驱动下行为不同）
  parent   TEXT NOT NULL,
  -- 兄弟身份：页面 slug，或没有页面的分组路径
  item     TEXT NOT NULL,
  -- 从 0 开始的位次
  position INTEGER NOT NULL,
  PRIMARY KEY (parent, item)
);
