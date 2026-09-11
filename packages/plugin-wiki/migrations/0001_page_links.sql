-- 0001_page_links.sql —— 反向链接索引（page_links）
--
-- 语义：一行 = 「source_slug 这一页的正文里，有一个指向 target_slug 的站内链接」。
-- 由本插件的保存路径在**同一事务内**重建（先删该页全部出行、再按正文重插），
-- 因此它总是正文的派生物，不会累积陈旧边。
--
-- 设计要点（改前请先复验）：
--
-- 1. **主键就是去重**：`(source_slug, target_slug)` 保证同一页对同一目标只留一行。
--    正文里重复链接同一页是常态，靠主键而不是靠应用层去重更可靠（应用层去掉重是
--    为了少写无用行，但即使漏了也不会产生重复行）。
--
-- 2. **target_slug 故意不加外键**：链接指向一个**尚不存在**的页面是完全正常的
--    （先写引用、后建页面），加外键会让这种正文存不进去。反向链接查询用
--    `JOIN pages` 取标题，所以指向不存在页面的行不会出现在结果里。
--
-- 3. **source_slug 也不加外键**：与 target 同理保持两列对等；源页面删除时由
--    应用层在同一事务里显式清理（见 deletePage），不依赖级联行为在不同驱动下的差异。
--
-- 4. 索引 `idx_page_links_target` 是反向查询（`WHERE target_slug = ?`）的唯一入口；
--    正向查询（`WHERE source_slug = ?`）由主键的最左前缀覆盖，无需额外索引。
--
-- 5. 全部语句幂等（IF NOT EXISTS）；**不写 BEGIN/COMMIT** —— db.migrate() 已把每个
--    迁移文件包在单个事务里执行，脚本内再开事务会嵌套报错。

CREATE TABLE IF NOT EXISTS page_links (
  source_slug TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  PRIMARY KEY (source_slug, target_slug)
);

CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links (target_slug);
