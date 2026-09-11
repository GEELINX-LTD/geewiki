-- 0014_access_requests.sql —— 申请访问（P3b）
--
-- 见 docs/design/access-control.md §3.5。
--
-- 为什么要有这张表："申请访问"让用户不必去找管理员私聊，是一个**一等流程** ——
-- 403 页与受限块占位文案上都应有入口。
--
-- 与授权的区别（别混）：
--   - `page_grants` / `block_grants` 是**已生效的授予**
--   - `access_requests` 是**待裁决的请求**，批准后才落一条授予
--   两者分开存，是因为"请求"有生命周期（pending/approved/denied/withdrawn）与
--   裁决人，而"授予"只有生效/过期两态。
--
-- 约定同 0001/0010/0011/0012/0013/0015/0016：**不写 BEGIN/COMMIT**（控制器逐文件包事务）。

CREATE TABLE IF NOT EXISTS access_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 绑 slug 而非 page_id：与 page_grants 同款考量 —— 条目删除后重建同 slug 时，
  -- 历史请求不该"悬空复活"到新条目上；而删除条目时由写入路径显式清理。
  page_slug    TEXT    NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 申请人留言（可为空）。**这是唯一承载用户自由文本的列**，展示时必须转义。
  message      TEXT,
  -- pending|approved|denied|withdrawn
  status       TEXT    NOT NULL DEFAULT 'pending',
  decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TEXT,
  created_at   TEXT    NOT NULL
);

-- 同一 (条目, 用户) 在**同一状态下**只能有一条
--
-- 为什么把 `status` 也纳入唯一键（而不是只 (page_slug, user_id)）：
--   ① "已拒绝"之后用户应当能**再次申请**（情形会变），所以不能把它们压成一条；
--   ② 但**同一状态下不允许重复** —— 否则待审列表会出现同一个人的多条 pending，
--      审批人会重复点、也会重复落授予。
--   ⇒ 用 (page_slug, user_id, status) 正好同时满足这两条。
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_req_pending
  ON access_requests(page_slug, user_id, status);

-- 审批人视角：「待我处理的请求」——按状态查，最新在前
CREATE INDEX IF NOT EXISTS idx_access_req_status
  ON access_requests(status, created_at DESC);
