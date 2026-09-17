-- 0010_identity.sql —— 身份：用户、凭据、会话、外部身份（P1）
--
-- 见 docs/design/access-control.md §3.1。四张表一次建全：
--   users            本地账号
--   user_credentials 密码哈希（算法名 + 参数 + salt 都入库，便于将来升级算法）
--   sessions         会话（DB 只存令牌哈希）
--   user_identities  外部身份（OIDC 骨架）
--
-- **为什么 user_identities 与 email_verified 在 P1 就建**（文档 §3.1 的顺序修正）：
-- 若推迟到 P1.5（OIDC）再建，届时需要一次额外的 ALTER TABLE + 一次 email 验证状态回填；
-- 而回填逻辑无法判断历史账号当初是否验证过，只能全置 0 或全置 1，
-- 两种都会让"是否允许按 email 自动合并"的判定在过渡期行为不确定。
--
-- 与 0001 的约定一致：**不写 BEGIN/COMMIT**（迁移控制器已逐文件包事务）、
-- 全部 IF NOT EXISTS 以保证 db.migrate() 幂等重放安全。

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         INTEGER NOT NULL DEFAULT 1,        -- 本期恒 1；为多租户预留
  email          TEXT    NOT NULL,
  display_name   TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'active', -- active|invited|disabled
  -- ★ 方言收敛：PG 侧同样用 INTEGER 0/1 而不是 BOOLEAN。
  -- 理由：BOOLEAN 会让 pg 驱动回 true/false、sqlite 回 0/1，业务代码必须写方言分支；
  -- 两侧同为 INTEGER 时 `WHERE email_verified = 1` 在两种方言下语义一致。
  email_verified INTEGER NOT NULL DEFAULT 0,        -- 本地账号创建即置 1
  created_at     TEXT    NOT NULL,                  -- ISO8601
  last_seen_at   TEXT
);

-- 同一组织内 email 唯一（不跨 org 唯一：多租户预留）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_email ON users(org_id, email);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  algo       TEXT    NOT NULL,  -- 'scrypt' | 'argon2id'（存算法名，便于将来升级）
  params     TEXT    NOT NULL,  -- JSON: {N,r,p}
  salt       TEXT    NOT NULL,  -- hex
  hash       TEXT    NOT NULL,  -- hex
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT    PRIMARY KEY,  -- 随机 id（与令牌分离，日志可安全引用）
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT    NOT NULL,     -- sha256(raw token)：DB 泄露也不可直接冒用
  created_at      TEXT    NOT NULL,
  last_used_at    TEXT    NOT NULL,
  expires_at      TEXT    NOT NULL,     -- 绝对过期
  idle_expires_at TEXT    NOT NULL,     -- 空闲过期，每次使用滑动
  revoked_at      TEXT,                 -- 非 NULL = 已吊销（登出/改密/踢下线）
  user_agent      TEXT,
  ip_hash         TEXT                  -- 只存哈希：审计够用，避免存 IP 原文
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
-- 按令牌哈希查会话是每请求热路径，必须走索引（唯一：同一令牌只能对应一条会话）
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS user_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer        TEXT    NOT NULL,  -- OIDC iss，**原样存**（尾部斜杠差异算不同 issuer）
  subject       TEXT    NOT NULL,  -- OIDC sub
  email_at_link TEXT,              -- 绑定时 IdP 声明的 email（快照，不参与判定）
  linked_at     TEXT    NOT NULL,
  last_login_at TEXT
);

-- 核心约束：同一 (issuer, subject) 全局唯一 ⇒ 一个外部身份只能绑一个本地用户
CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_issuer_sub ON user_identities(issuer, subject);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
-- **注意：email 上刻意没有唯一约束** —— 同一 IdP 下不同 sub 可能有相同 email；
-- 唯一性只由 (issuer, subject) 保证（文档 §7.2 禁止按 email 自动绑定）。
