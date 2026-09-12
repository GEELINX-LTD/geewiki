-- 0018_attachments.sql —— 附件元数据（SQLite 方言，本批 M2/M3）
--
-- ★ 落点理由（与 0015_blocks.sql 同一条，且是决定性的）：
--   `@geewiki/wiki` 自带的迁移目录在组合根 `defaultRegistry()` 里**只声明了 sqlite**
--   （`packages/server/src/index.ts:1405` 的 `{ sqlite: WIKI_MIGRATIONS_DIR }`）。
--   把本文件放进 `packages/plugin-wiki/migrations/` 的话，**PostgreSQL 部署下这张表
--   根本不会被建出来** ⇒ 附件功能在 PG 上整个不可用（且报错是运行时才出现的
--   `no such table: attachments`）。故两侧方言成对落在 db 包。
--
-- ★ 三条设计决定：
--
--   ① 外键指向 `pages(id)` 而**不是** slug：与 `blocks` 同口径。
--      级联因此天然正确（删页 ⇒ 附件元数据一起走），也不需要"改 slug 时同步改引用"
--      这类额外逻辑。已验证本仓**不存在改名路径**（`savePage` 按 slug upsert、
--      全仓无 `UPDATE pages SET slug`）⇒ `page_slug` 这一列不会陈旧，它只是为
--      审计/排障留的人类可读冗余（一条 SQL 就能看懂"这是哪一页的附件"）。
--
--   ② `UNIQUE (page_id, sha256)`：同一页的同一份内容只有一行。
--      幂等上传（同文件二次上传返回 dedup）靠它兜底，`UNIQUE` 是**并发下的最后一道**：
--      应用层"先查后插"在竞态下仍可能双双通过，只有唯一约束能拦住第二行。
--      ⚠️ 刻意**不是** `UNIQUE (sha256)`：不同页可以引用同一份字节（落盘路径共享，
--      元数据各记一行），页级配额与"谁传的"都是按页的语义。
--
--   ③ 磁盘上**只有字节，没有这张表的镜像**：`sha256` + `ext` 一起决定落盘路径
--      （`resolveAttachmentPath`），`byte_size`/`mime`/`original_name` 只用于响应头与展示。
--      ⇒ 附件目录里出现"数据库里没有的文件"是**可检测**的（GC 的判据），
--         反过来"库里有一行而文件不在"由下载路径的 `blob_missing` 显式报出。
--
-- 约定同 0001/0010..0017：**不写 BEGIN/COMMIT**（控制器逐文件包事务）。
-- 全部语句幂等（IF NOT EXISTS），可安全重放。

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 外键到 id（不是 slug）：删页时元数据随 CASCADE 一起走，不留孤儿行
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- 冗余的人类可读列（审计/排障）。**不参与任何判定** —— 判定用 pages.slug 现值联查。
  page_slug     TEXT    NOT NULL,
  -- 内容哈希：落盘路径的一半，也是幂等去重的唯一键
  sha256        TEXT    NOT NULL,
  -- 已过白名单的扩展名（含前导点、小写）：落盘路径的另一半，并决定响应头
  ext           TEXT    NOT NULL,
  byte_size     INTEGER NOT NULL,
  -- 由扩展名推出的 MIME（**不信任上传时的 Content-Type 声明**，见 attachments.ts）
  mime          TEXT    NOT NULL,
  -- 原始文件名：**只用于展示**（Content-Disposition），从不参与路径拼接
  original_name TEXT    NOT NULL,
  -- 上传者；老数据/系统导入可能为 NULL ⇒ 可空
  uploader_id   INTEGER,
  created_at    TEXT    NOT NULL,
  -- 同页同内容只一行（并发下的最后一道，见头注 ②）
  UNIQUE (page_id, sha256)
);

-- 页面附件清单（`GET /api/pages/:slug/attachments` 与配额求和都走它）
CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id);
-- 跨页查同一份内容（GC 判据："还有没有元数据指向这个文件"）
CREATE INDEX IF NOT EXISTS idx_attachments_sha  ON attachments(sha256);
