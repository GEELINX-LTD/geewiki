-- 0013_audit.sql —— 全局 ACL 版本号 + 审计日志（P1 建表）
--
-- 见 docs/design/access-control.md §3.4。与 0001/0010 同约定：
-- 不写 BEGIN/COMMIT、全部 IF NOT EXISTS。
--
-- 序号跳过 0011/0012（组织/成员与条目可见性，属 P2），从 0010 起编是文档 §3.0
-- 的统一约定 —— 双方言序号本已不同步（sqlite 有 0002、PG 把它并进 0001），
-- 统一从 0010 起编可避免"两侧逐一对齐"的心理负担。

-- 全局 ACL 版本号：任何 ACL 变更（成员/授予/可见性）都 +1，
-- 供 P2 的 policy-service 做**代际失效**（不是 TTL —— TTL 必然产生
-- "改完权限还看得见"的窗口，见文档 §4.5 与 R10 反模式第 3 条）。
CREATE TABLE IF NOT EXISTS acl_revision (
  id       INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行表：CHECK 是"只有一行"的落点
  revision INTEGER NOT NULL DEFAULT 1
);

-- 预置单行，使 `SELECT revision FROM acl_revision WHERE id = 1` 恒有结果
-- （否则 P2 首次读取会拿到空集，调用方必须额外处理"表在但行不在"）。
-- SQLite 的 INSERT OR IGNORE 与 PG 的 ON CONFLICT DO NOTHING 语义一致（幂等重放安全）。
INSERT OR IGNORE INTO acl_revision (id, revision) VALUES (1, 1);

-- 审计日志：**append-only**（应用层不提供 UPDATE/DELETE 路径）。
--
-- 取值约定（action）：acl.change | page.publish | login.ok | login.fail
--                    | access.denied | access.admin_override | access.break_glass
-- target_kind：page | user | group | grant | session | org
--
-- **为什么不记正文**：OWASP 指出日志"太多"本身也是弱点（CWE-779）—— 敏感数据被无谓写进
-- 日志。审计只记元数据与差异：before_json/after_json 里**不得**出现页面正文、口令、
-- 令牌或任何凭据值。
--
-- 两类事件的用途**刻意分开**（文档 §9 反模式）：`access.denied` 是**安全事件**（要告警），
-- `acl.change` 等是**合规记录**（要留存）。混在一起会让两者都不可用。
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT    NOT NULL,  -- ISO8601
  actor_id      INTEGER,           -- NULL = 系统/引导
  actor_ip_hash TEXT,              -- 只存哈希：审计够用，避免留 IP 原文
  action        TEXT    NOT NULL,
  target_kind   TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  before_json   TEXT,              -- 变更前（不含正文/凭据）
  after_json    TEXT,              -- 变更后（不含正文/凭据）
  request_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);
