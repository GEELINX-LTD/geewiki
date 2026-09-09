-- 0001_init.sql —— 初始表结构
-- Wiki 页面主表 + 版本历史表（为后续 Wiki CRUD 与版本管理预留）

CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,             -- 页面路径标识，如 "getting-started"
  title       TEXT    NOT NULL,                    -- 页面标题
  content     TEXT    NOT NULL DEFAULT '',         -- 页面正文（Markdown）
  created_at  TEXT    NOT NULL,                    -- ISO8601 创建时间
  updated_at  TEXT    NOT NULL                     -- ISO8601 最后更新时间
);

-- 版本历史：每次更新正文插入一条快照
CREATE TABLE IF NOT EXISTS page_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  saved_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_page_versions_page_id ON page_versions(page_id);
