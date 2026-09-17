-- 0022_invitation_open_code.sql —— 邀请码不再**必须**绑定邮箱（开放码）
--
-- ★★ 为什么要它（现状的缺口）：
--   在此之前 `invitations.email` 是 `NOT NULL`，而 `POST /api/org/invitations/redeem`
--   的请求体只有 `{token, password, displayName}` —— **没有 email**，因为邮箱是从这条
--   邀请里取出来的。于是被邀请人**无法使用自己的邮箱**：管理员必须先知道对方用什么邮箱、
--   填进去、再把令牌给对方。两处合起来的实际体验是"管理员替对方决定了登录标识符"，
--   而登录标识符是账号最私人的属性。
--
-- ★ 语义（新）：
--   · `email IS NULL`  ⇒ **通用码**：持码者注册时自填邮箱；
--   · `email` 非 NULL  ⇒ **定向码**：注册时填的邮箱必须与它相等（保底行为不变）。
--     ⚠️ 定向码这一半**必须保留**，不是兼容包袱：OIDC 的 `invite_only` 闸门
--     （`packages/plugin-auth` 的 `hasUnconsumedInvite(email)`）就是**按邮箱查这张表**的。
--     把 `email` 整列删掉会让"OIDC 首次登录要不要放行"失去判据。
--
-- ★ 为什么是"表重建"而不是 `ALTER TABLE`：
--   SQLite 没有 `ALTER COLUMN ... DROP NOT NULL`。本仓此前**没有表重建先例**
--   （0012/0017/0019/0020 全是 `ADD COLUMN`），故把两个安全前提写在这里：
--   1. **`invitations` 是叶子表** —— 没有任何表引用它（FK 都是它指向 orgs/users/groups）。
--      因此 `DROP TABLE` 不会牵连别的表，也不需要动 `PRAGMA foreign_keys`
--      （那个 PRAGMA 在事务内本来就是空操作，而本文件由运行器包在一个事务里执行）。
--   2. 重建期间**没有并发写入**：迁移在插件的 `apply` 之前、单进程启动阶段跑完。
--   另一个选择是"用空串 `''` 当哨兵表示通用码"（零迁移），但那是把语义编码进魔法值，
--   而 `''` 永远不是合法邮箱这件事是**隐含**的 —— 后人看不出这是刻意的。
--
-- ★ **本文件在 SQLite 上不可重放**（同 0017/0019/0020 的说明）：`CREATE TABLE` +
--   `DROP` + `RENAME` 重复执行会丢数据。`_migrations` 表保证它只跑一次。
--   （PG 那一份只是 `DROP NOT NULL`，天然幂等。）

CREATE TABLE invitations_new (
  id          TEXT    PRIMARY KEY,      -- 随机 id（令牌本身只存哈希）
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL = 通用码（持码者自填邮箱）；非 NULL = 定向码（注册邮箱必须相等）
  email       TEXT,
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

-- 逐列点名搬数据（不用 `SELECT *`）：列序若与旧表不同，`SELECT *` 会**静默错位**。
INSERT INTO invitations_new (
  id, org_id, email, org_role, group_id, invited_by, token_hash, expires_at, accepted_at, created_at
)
SELECT
  id, org_id, email, org_role, group_id, invited_by, token_hash, expires_at, accepted_at, created_at
FROM invitations;

-- 旧索引随旧表一起消失，重建（`idx_invitations_email` 是 OIDC 那条按邮箱查的判据）
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(org_id, email);
CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at);
