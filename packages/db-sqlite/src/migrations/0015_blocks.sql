-- 0015_blocks.sql —— 内容块（块级模型的核心，P3a）
--
-- 见 docs/design/access-control.md §3.6 / §4.1 / §4.2 / §4.3。
--
-- ★ 落点说明（与 §3.6 的一处偏差，理由在此）：
--   §3.6 把本文件写在 `packages/plugin-wiki/migrations/` 下。但 `@geewiki/wiki` 的
--   迁移目录在 `defaultRegistry()` 里**只声明了 sqlite**（`{ sqlite: WIKI_MIGRATIONS_DIR }`），
--   照那个落点写，**PostgreSQL 部署下 blocks 表根本不会被建出来** ⇒ 块级模型在 PG 上
--   整个不存在。而 `blocks` 的外键指向 `pages`（由 db 插件的 0001 建立），把它放在
--   **db 插件的迁移目录**既保证双方言都有，也让外键目标与建表语句同属一个迁移集。
--   ⇒ 本文件落在 db 包，**两侧方言成对**（与 0010/0011/0012/0013 的落点一致）。
--
-- ★ 三件事：
--   ① 建 `blocks`（解析出的结构化真源，与 pages.content 同事务双写）
--   ② 建两个查询索引（渲染/投影/RAG 走 (page_id, ordinal)；治理查询走 visibility）
--   ③ ★★ `tier` **内联在建表里、且不给默认值** —— 这是本文件最关键的一处决定，见下。
--
-- 约定同 0001/0010/0011/0012/0013：**不写 BEGIN/COMMIT**（控制器逐文件包事务）。
-- 全部语句幂等（IF NOT EXISTS），可安全重放。

-- ① 内容块
--
--    pages.content  = **作者源快照**（Markdown 原文，含 <!--gated:*--> 标记）
--    blocks         = **解析出的结构化真源**
--
--    两者**同一事务双写**（见 packages/plugin-wiki 的 savePage），并由
--    `pages.content_hash = sha256(pages.content)` 做漂移探针（GET /api/admin/blocks/verify）。
--    为什么 blocks 不是"可有可无的缓存"：**块级授权必须钉在稳定的块身份上**，
--    不能钉在一次解析结果上（§3.6）。
CREATE TABLE IF NOT EXISTS blocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- 文档序，0 起连续。**块身份是 (page_id, ordinal) 的解析结果 + kind 序列对齐**，
  -- 不是 ordinal 本身（见 §4.2 的"保守重解析"）。
  ordinal       INTEGER NOT NULL,
  -- paragraph|heading|code|list|list_item|quote|table|html|gated
  kind          TEXT    NOT NULL,
  -- 该块的 Markdown 源（**未裁剪**，与 pages.content 同真源）。投影/裁剪发生在读路径。
  text          TEXT    NOT NULL,
  -- ★ v4：public|org|granted（**不再有"仅编辑者"**）。受规则 B1 约束：
  --   有效档位 = min(块档位, 页面有效档位)，**块只能更窄、不能更宽**（§2.3）。
  visibility    TEXT    NOT NULL DEFAULT 'public',
  -- 子块（列表项/嵌套块）是否随父块收紧。与页面级的 inherit 同义。
  inherit       INTEGER NOT NULL DEFAULT 1,
  -- 来源标记原文（'org' / 'granted'），NULL = 未标记（即 public）。
  -- 保留它只为治理界面能显示"这块为什么被收紧"，**不参与判定**。
  marker        TEXT,
  -- sha256(text)：检测"文本变了但 ordinal 没变"——保守重解析靠它对齐块身份。
  content_hash  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  --
  -- ★★★ 检索用的密级冗余列（派生列：min(页面有效档位, 块档位)，随祖先可见性变化重算）
  --
  --    取值域严格是 { 0 = anon, 1 = org }；**`granted` 档写 NULL**（它不属于任何读者等级，
  --    是逐块 ACL，只能靠检索时的"授权分支"命中，见 §4.3）。
  --
  --    **为什么内联在这里、而不是像 §3.6 那样另起一条独立的加列语句**：
  --    `blocks` 是本文件**新建**的表，SQLite 没有"加列时若已存在则跳过"的语法 ⇒ 写成
  --    独立的 ALTER，本文件就**无法重放**（第二次跑 CREATE TABLE IF NOT EXISTS 跳过建表、
  --    ALTER 却抛 duplicate column name）。P2 在 0012 上已经踩过并把这个限制用守卫测试
  --    钉死（见 packages/db-sqlite/test 的迁移幂等用例），这里不该重蹈。
  --
  --    **为什么故意不给默认值**：`DEFAULT 0` 是**失败开放** —— 任何"忘记算 tier"的写入
  --    都会让该块以**匿名等级**进入检索索引；若它其实是 org/granted，那就是**泄漏**。
  --    无默认（NULL）的失败方向是"**该块搜不到**"（NULL 的比较恒不成立 ⇒ 等级分支永不命中），
  --    并且由一致性探针兜住：
  --        SELECT COUNT(*) FROM blocks WHERE tier IS NULL;                    -- 必须等于 ↓
  --        SELECT COUNT(*) FROM blocks WHERE visibility = 'granted';
  --    两个数不等 ⇒ 有块被漏算，GET /api/admin/search/verify 报警（§4.3）。
  tier          INTEGER
);

-- ② 查询路径：按页取块（渲染 / 投影 / RAG 全走这条）
CREATE INDEX IF NOT EXISTS idx_blocks_page_ordinal ON blocks(page_id, ordinal);

-- 治理查询："哪些块被单独收紧过"（部分索引：public 是绝大多数，不进索引）
CREATE INDEX IF NOT EXISTS idx_blocks_visibility ON blocks(visibility) WHERE visibility <> 'public';

-- 检索路径：等级分支 `b.tier <= ?` 走这条（§4.3 的 FTS 查询 JOIN 后用）
CREATE INDEX IF NOT EXISTS idx_blocks_tier ON blocks(tier);
