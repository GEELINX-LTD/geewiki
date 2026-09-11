-- 0012_page_acl.sql —— 条目可见性字段 + 页面级例外授予（P2）
--
-- 见 docs/design/access-control.md §3.3。两件事：
--   ① 给 pages 增 6 列（可见性三字段 + 归属 + 缓存失效 + 一致性哈希）
--   ② 建 page_grants（页面级例外授予）
--
-- ★★ **本文件是 P2 唯一触碰 pages 表的地方，且刻意不动 FTS**（§8.0 的顺序修正）：
--    `pages_fts` 的建表与三条触发器归 `@geewiki/search`（packages/plugin-search/migrations/
--    0001_search.sql），FTS 改造（pages_fts → blocks_fts）**一次性推到 P3a**。
--    P2 只在**查询层**加 `WHERE slug IN (…)` 过滤，不碰索引结构。
--    注意：下面的 D8 回填是一条 `UPDATE pages`，它会**照常触发** `pages_fts_au`
--    （external content 表的 delete+insert 两步）—— 这是一次性的、必然的写放大，
--    不是"改了 FTS"，无需也无法回避（回填不改 title/content，故 delete 用旧值仍然正确）。
--
-- ★★★ **两层默认值，别搞混**（§3.3 的 v5 说明，D8 派生项）：
--    - **DDL 层 = `'private'`**：故意保持最严档、**失败关闭**。任何"忘记设置可见性"的
--      写入路径（导入脚本、第三方插件、直接写库）都落到"仅被显式授权的人可见"。
--    - **应用层 = `'org'`**：通过产品界面 / API 新建条目时**显式写入** `'org'`
--      （组织内可见）——这是本产品的常态。**该默认值由写入路径负责，不在本文件里**
--      （见 packages/plugin-wiki/src/index.ts 的 savePage：新建分支显式写 'org'）。
--    - 两者不冲突：DDL 默认守"没人管的写入路径"，应用默认守"人的日常体验"。
--    ⇒ **新建页面默认是"组织内可见"，不是"私有"。**
--
-- 约定同 0001/0010/0011：**不写 BEGIN/COMMIT**（控制器逐文件包事务）。

-- ① 可见性三字段（§2.2）
--    visibility  —— 谁默认能看：private|org|public
--    inherit     —— 是否向子树下传收紧（默认 1 = 继承）。**放宽（public）不继承**，
--                   它由独立的 published_at 发布闸门表达（§2.3 的规则）。
--    published_at—— 独立发布开关，默认 NULL（未发布）。**发布是显式动作**，
--                   这也是 D8 里"public 不会被批量设置"的机制保证。
ALTER TABLE pages ADD COLUMN visibility   TEXT    NOT NULL DEFAULT 'private';
ALTER TABLE pages ADD COLUMN inherit      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pages ADD COLUMN published_at TEXT;

-- ② 归属与缓存
--    created_by  —— 作者。**刻意不加外键**：用户被删除后条目必须留存（历史资产），
--                   加 FK 会连带删除或阻塞删除。
--    acl_revision—— 本条 ACL 版本号。用于**代际失效**而不是 TTL：任何 ACL 变更（含祖先
--                   可见性变化波及到的后代）都把它 +1，策略缓存命中条件必须是"版本相等"。
--                   用 TTL 必然产生"撤销权限后仍可见"的窗口（§9 R10 的反模式）。
ALTER TABLE pages ADD COLUMN created_by   INTEGER;
ALTER TABLE pages ADD COLUMN acl_revision INTEGER NOT NULL DEFAULT 0;

-- ③ 一致性探针（P3 用）：sha256(pages.content)，用于检测 pages.content 与 blocks 的双写漂移。
--    P2 只建列不消费；放在这里是为了避免 P3a 再动一次 pages 表（§9 R15）。
ALTER TABLE pages ADD COLUMN content_hash TEXT;

-- 列表页与可见性过滤的主索引（策略层按 visibility + published_at 预筛）
CREATE INDEX IF NOT EXISTS idx_pages_visibility ON pages(visibility, published_at);

-- ④ 页面级例外授予（§2.2 的"授权对象"）
CREATE TABLE IF NOT EXISTS page_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 绑 slug 而非 page_id：条目删除后重建（同 slug）时，授予**不悬空复活** ——
  -- 删除会连带清掉这一行（见 plugin-wiki 的 deletePage），而 page_id 自增会让语义暧昧。
  page_slug    TEXT    NOT NULL,
  -- ★ D13：只有 user|group。**没有 org_role** —— 角色只决定能力，不是授权对象（§2.0）。
  subject_kind TEXT    NOT NULL,
  subject_id   TEXT    NOT NULL,   -- userId / groupId（不再有 'member' 这类角色字面量）
  role         TEXT    NOT NULL,   -- editor|viewer
  granted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at   TEXT    NOT NULL,
  -- 外部协作者到期自动失效。判定时比较 `expires_at > now`，**不依赖后台清理任务**
  -- （清理只是回收空间；即使清理没跑，过期授予也已不生效）。
  expires_at   TEXT
);
-- 同一 (条目, 主体) 只有一条授予（改角色即覆盖）
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_grants_unique
  ON page_grants(page_slug, subject_kind, subject_id);
-- 「这个主体被授予了哪些条目」——策略层每请求都要按主体反查，必须走索引
CREATE INDEX IF NOT EXISTS idx_page_grants_subject
  ON page_grants(subject_kind, subject_id);

-- ⑤ ★ D8：存量条目一次性回填为 `org`（组织内可见）
-- 为什么必须回填：`visibility` 是新增列，DDL 默认 'private' ⇒ 不回填的话，
-- 升级当天**全站条目会瞬间对所有人不可见**（连组织成员都看不到），看起来像数据丢失。
-- 为什么是 'org' 而不是 'public'：'org' 保持"团队内部可见"这一既有事实（升级前所有
-- 登录用户本来就能看到全部条目），不扩大暴露面；**'public' 绝不会被批量设置** ——
-- 公开必须由管理员逐条显式发布（published_at）。
-- 幂等性说明：本语句第二次执行时条件恒假只影响"迁移后被管理员显式改回 private"的条目，
-- 而 `_migrations` 表保证本文件只跑一次；`ALTER TABLE ADD COLUMN` 本身不可重放，
-- 故整个文件的重放安全性由控制器提供（与 0010 一致）。
UPDATE pages SET visibility = 'org' WHERE visibility = 'private';
