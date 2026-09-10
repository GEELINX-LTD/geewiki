-- 0001_search.sql —— 全文检索索引（FTS5 external content + 触发器同步）
--
-- 设计要点（均为实测结论，改前请先复验）：
-- 1. **必须显式 tokenize='trigram'**：FTS5 默认的 unicode61 分词器会把连续 CJK 当成
--    一个 token，于是「知识库」只有整段完全相同才命中——中文等于搜不到。
--    trigram 切 3 字符片段，任意子串（中文 ≥3 字、英文 ≥3 字符）都能命中。
-- 2. **external content（content='pages', content_rowid='id'）**：索引不复制正文，
--    靠下面的触发器与 pages 表保持同步，省掉一份正文存储。
-- 3. 代价：trigram 索引本身占用与正文同量级（实测 5000 行 / 6.6MB 语料增约 7.9MB）。
-- 4. **trigram 的硬缺口**：查询串短于 3 字符时 MATCH 无法命中（英文 <3 字符、
--    中文 2 字词如「检索」都是空结果），必须由插件层用 LIKE 兜底（见 src/index.ts）。
-- 5. 全部语句幂等（IF NOT EXISTS / rebuild 可重放），可安全重跑。
-- 6. **不写 BEGIN/COMMIT**：db.migrate() 已把每个迁移文件包在单个事务里执行，
--    脚本内再开事务会嵌套报错。

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  content,
  content='pages',
  content_rowid='id',
  tokenize='trigram'
);

-- 插入：把新行写进索引
CREATE TRIGGER IF NOT EXISTS pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- 删除：external content 约定——先把旧值从索引里"delete"掉
CREATE TRIGGER IF NOT EXISTS pages_fts_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;

-- 更新：先 delete 旧值再插入新值（两步缺一不可，否则旧词会残留）
CREATE TRIGGER IF NOT EXISTS pages_fts_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- 回填存量行：本迁移在既有数据库上应用时，pages 里可能已有数据，
-- 而上面三条触发器只对"此后发生的"变更生效。
INSERT INTO pages_fts(pages_fts) VALUES ('rebuild');
