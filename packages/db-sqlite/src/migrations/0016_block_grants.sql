-- 0016_block_grants.sql —— 块级例外授予（P3b）
--
-- 见 docs/design/access-control.md §3.7。与 0012 的 `page_grants` **完全同构**：
--   - 同名的 `subject_kind`（★ D13：只有 `user|group`，**没有 `org_role`**）
--   - 同名的 `role`（`editor|viewer`）
--   - 同一条语义：**授权只放宽、不收紧**
-- 唯一差别是"挂在块上还是挂在页面上"。
--
-- ★ 为什么 `page_slug` 冗余存在这里（而不是只靠 `block_id` 反查 pages）：
--   页面**移动/重命名**时 slug 变、但块 id 不变，授权应当**跟着块走、不失效**。
--   冗余这一列是为了让"这个页面下有哪些块级授予"这类治理查询不必 JOIN（索引
--   `idx_block_grants_page`），不是为了判定 —— **判定一律走 `block_id`**。
--
-- ★ 为什么 `block_id` 有外键 CASCADE，而 `page_grants.page_slug` 没有外键：
--   块是**解析产物**，它的生命周期严格从属于页面（页面没了块必然没），故 CASCADE 是
--   正确的清理语义；而 `page_grants` 绑的是 slug 字符串（条目删除后重建同 slug 时
--   授予不该悬空复活），那是另一套考量，见 0012 的说明。
--   ⚠️ **推论（P3b 实现必须处理）**：`syncBlocksForPage` **不能再用"删光重建"的方式
--   写块** —— 那会让块 id 全变、CASCADE 把授权全清掉。它必须改成能**保留块 id** 的
--   保守重解析（见 §4.2 与 `packages/plugin-wiki/src/blocks.ts`）。
--
-- 约定同 0001/0010/0011/0012/0013/0015：**不写 BEGIN/COMMIT**（控制器逐文件包事务）。

CREATE TABLE IF NOT EXISTS block_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 块被删则授予一并清掉（块的生命周期从属于页面）
  block_id     INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  -- 冗余存 slug：页面移动/重命名时授权不失效。**仅供治理查询与排障，不参与判定。**
  page_slug    TEXT    NOT NULL,
  -- ★ D13：只有 user|group。**没有 org_role** —— 角色只决定能力，不是授权对象（§2.0）。
  subject_kind TEXT    NOT NULL,
  subject_id   TEXT    NOT NULL,   -- userId / groupId
  role         TEXT    NOT NULL,   -- editor|viewer
  granted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at   TEXT    NOT NULL,
  -- 外部协作者到期自动失效。判定时比较 `expires_at > now`，**不依赖后台清理任务**
  -- （清理只是回收空间；即使清理没跑，过期授予也已不生效 —— 与 page_grants 同款）。
  expires_at   TEXT
);

-- 同一 (块, 主体) 只有一条授予（改角色即覆盖）
CREATE UNIQUE INDEX IF NOT EXISTS idx_block_grants_unique
  ON block_grants(block_id, subject_kind, subject_id);

-- 「这个页面下有哪些块级授予」——治理面板用
CREATE INDEX IF NOT EXISTS idx_block_grants_page
  ON block_grants(page_slug);

-- ★ 新增：按主体反查"这个人/这个组被授予了哪些块"
--
-- **这条索引是检索热路径的必需品**：`policy-service.grantedBlockIds()` 每次检索都要
-- 按主体反查该表，缺它则每次检索退化成全表扫。与页面级的 `idx_page_grants_subject` 对齐。
CREATE INDEX IF NOT EXISTS idx_block_grants_subject
  ON block_grants(subject_kind, subject_id);
