-- 0011_org_team.sql —— 组织、成员、组、邀请（P2）
--
-- 见 docs/design/access-control.md §3.2。五张表：
--   orgs           组织。本期单组织，恒 1 行（D1）；列与索引为多租户预留。
--   org_members    成员与角色（owner|admin|member|viewer）—— **角色只管能力**
--   groups         组（授权的批量载体）
--   group_members  组成员
--   invitations    邀请；带 group_id 时"接受即入组"
--
-- **guest 不是角色，而是"无组织角色"**（§2.1）：即 org_members 里**没有这一行**。
-- 为什么不做成"最低档角色"：最低档角色仍会被组织级继承规则牵连，外部协作者会意外
-- 拿到组织内容；"无默认角色"则永远只能通过显式授予（page_grants）获得访问。
--
-- **invitations.org_role 不是授权对象**（§2.0、§12 第 17 条）：它是"入伙后拿到哪个
-- 角色（能力）"，与 `page_grants.subject_kind`（只有 user|group）无关。该列为 NULL
-- 表示走 guest 通道 —— 入伙但**不给**组织角色。
--
-- **D13：授权对象里没有角色。** 本文件不建任何"角色→内容"的表；角色只决定"能做什么"
-- （能不能管成员、能不能建改内容），"能看什么"由 0012 的可见性字段 + page_grants 决定。
--
-- 约定同 0001/0010：**不写 BEGIN/COMMIT**（迁移控制器已逐文件包事务）、
-- 全部 IF NOT EXISTS 以保证 db.migrate() 幂等重放安全。

CREATE TABLE IF NOT EXISTS orgs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  -- 站点级默认可见性（private|public）。**P2 不消费它**：真正决定条目可见性的是
  -- pages.visibility（0012）。保留此列是为了让"站点级默认"将来有落点，而不是
  -- 让每个调用点各写一份硬编码。
  visibility TEXT    NOT NULL DEFAULT 'private',
  created_at TEXT    NOT NULL                  -- ISO8601
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id    INTEGER NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- owner|admin|member|viewer。**这一列只承载能力**，不参与"谁能看哪条内容"的判定
  -- （§2.0 两条正交的轴）。
  role      TEXT    NOT NULL,
  joined_at TEXT    NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
-- 按用户反查"我在哪些组织、什么角色"是每请求热路径（Principal 组装）
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
-- 组名在组织内唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_org_name ON groups(org_id, name);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  added_at TEXT    NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
-- 与 idx_org_members_user 同理：Principal 组装时要按用户展开 groupIds
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT    PRIMARY KEY,      -- 随机 id（令牌本身只存哈希）
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  -- NULL = guest 通道（入伙但不给组织角色）；
  -- ★ 这是"入伙后拿到哪个角色（能力）"，**不是授权对象**（§2.0、§12 第 17 条）。
  org_role    TEXT,
  group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,  -- 非 NULL ⇒ 接受即入组
  invited_by  INTEGER REFERENCES users(id)  ON DELETE SET NULL,
  token_hash  TEXT    NOT NULL,         -- sha256(raw token)，与 sessions 同款纪律
  expires_at  TEXT    NOT NULL,
  accepted_at TEXT,                     -- 非 NULL = 已消费（一次性）
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(org_id, email);
CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at);

-- ★ 默认组织种子（幂等）。
-- 为什么放在迁移里而不是应用启动时：org_members / groups / invitations 都有
-- `REFERENCES orgs(id)`，没有这一行则**任何**成员写入都会因外键失败；放在迁移里
-- 可以保证"表建好即自洽"，也让测试与生产走同一条路径。
-- 用 INSERT ... SELECT ... WHERE NOT EXISTS 而非 INSERT OR IGNORE：后者是 SQLite 专有，
-- 会让两侧方言的文件形状分叉（PG 侧用同样的 SELECT ... WHERE NOT EXISTS 写法）。
INSERT INTO orgs (id, slug, name, visibility, created_at)
SELECT 1,
       'default',
       '默认组织',
       'private',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM orgs WHERE id = 1);
