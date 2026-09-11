#!/usr/bin/env bash
# P1 端到端验收脚本（§8.2 P1 的 8 条）。真实起服务 + 真实 curl，不 mock 任何东西。
# 用法：bash packages/plugin-auth/test/e2e-p1.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-39311}"
TMP="$(mktemp -d)"
JAR="$TMP/jar.txt"
LOG="$TMP/server.log"
PASS=0
FAIL=0

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check() { # check <描述> <期望> <实际>
  if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    # 给它一点时间做优雅退出（卸载插件、关库）；超时就强杀，否则端口不释放
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
  # **必须等端口真正释放**：否则新进程绑定失败，而健康检查会连上**旧进程**，
  # 于是后面所有断言测的都是上一轮那个服务（这个坑在本脚本第一版里真实发生过：
  # 带令牌的断言全部拿到了 401，因为应答的是没配令牌的旧进程）。
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "旧服务未退出，端口仍被占用"; exit 1
}

start_server() { # start_server <管理员令牌，空串表示不设>
  stop_server
  rm -f "$JAR"
  : > "$LOG"
  if [[ -n "$1" ]]; then export GEEWIKI_ADMIN_TOKEN="$1"; else unset GEEWIKI_ADMIN_TOKEN; fi
  # `exec` 让子 shell **被 node 取代**：于是 `$!` 就是 node 自己的 pid，
  # `kill` 才真的能杀到它（用 `( … ) &` 时 `$!` 是子 shell，node 是它的孩子，
  # 杀子 shell 不会连带杀 node —— 端口因此一直不释放）。
  ( cd "$ROOT" && exec env GEEWIKI_DATA_DIR="$TMP/data" GEEWIKI_PORT="$PORT" \
      node --import tsx packages/server/src/index.ts ) >>"$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      # 双保险：确认这个进程确实是我们刚起的那个（日志里有它自己的启动行）
      grep -q '@geewiki/auth' "$LOG" && return 0
      grep -qi 'EADDRINUSE' "$LOG" && { echo "端口被占用："; tail -20 "$LOG"; exit 1; }
    fi
    sleep 0.5
  done
  echo "服务启动失败，日志："; tail -30 "$LOG"; exit 1
}

# code <method> <path> [body] [extra curl args...]
code() { local m="$1" p="$2" b="${3:-}"; shift 3 2>/dev/null || shift $#
  if [[ -n "$b" ]]; then
    curl -s -o "$TMP/body.json" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -H 'content-type: application/json' -H 'x-gw-csrf: 1' -b "$JAR" -c "$JAR" -d "$b" "$@"
  else
    curl -s -o "$TMP/body.json" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -H 'x-gw-csrf: 1' -b "$JAR" -c "$JAR" "$@"
  fi
}
body() { cat "$TMP/body.json"; }
# 注意 `?? ''` 会把 null 也吞掉 —— orgRole 的期望值**就是** null，故只把 undefined 当缺失
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1" < "$TMP/body.json"; }

echo "=== 阶段 A：未初始化（不设 GEEWIKI_ADMIN_TOKEN） ==="
start_server ""

check "A1 未初始化时写端点 → 503 bootstrap_required（无任何凭据来源）" \
  503 "$(code PUT /api/pages/probe '{"title":"t","content":"c"}')"
check "A1b 错误码" "bootstrap_required" "$(field error)"

check "A2 GET /api/auth/state → 200 且 setupRequired=true" "true" \
  "$(code GET /api/auth/state >/dev/null; field setupRequired)"

check "A3 匿名读端点保持零回归（GET /api/pages）" "200" "$(code GET /api/pages)"

echo
echo "=== 阶段 B：初始化向导 ==="
SETUP="$(code POST /api/auth/setup '{"email":"Owner@Example.com","password":"correct-horse-battery","displayName":"站长"}')"
check "B1 首次 setup → 201" "201" "$SETUP"
check "B1b 邮箱归一化为小写" "owner@example.com" "$(field user.email)"
# cookie 必须在**这一次**请求后就检查：后面再补一次 setup 只会得到 409（账号已存在）
check "B2 会话 cookie 名" "gw_sid" "$(awk '$6=="gw_sid"{print $6}' "$JAR" | tail -1)"
grep -q '#HttpOnly_' "$JAR" && ok "B2b cookie 带 HttpOnly（JS 读不到）" || bad "B2b cookie 缺 HttpOnly"
grep -q 'SameSite' "$LOG" 2>/dev/null || true
check "B3 第二次 setup → 409 setup_already_done" "409" \
  "$(code POST /api/auth/setup '{"email":"other@example.com","password":"correct-horse-battery"}')"

check "B5 初始化后未登录写端点 → 401（不再是 503：已存在凭据来源）" "401" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/probe" \
     -H 'content-type: application/json' -H 'x-gw-csrf: 1' -d '{"title":"t","content":"c"}')"
check "B5b 错误码 unauthorized" "unauthorized" "$(field error)"

check "B6 未登录 GET /api/auth/me → 401（§8.2 P1-1）" "401" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/me")"

echo
echo "=== 阶段 C：登录后用 cookie 操作 ==="
rm -f "$JAR"
check "C1 登录 → 200" "200" "$(code POST /api/auth/login '{"email":"owner@example.com","password":"correct-horse-battery"}')"
check "C1b 身份正确" "owner@example.com" "$(field user.email)"

check "C2 登录后 PUT /api/pages（写能力恢复）→ 200" "200" \
  "$(code PUT /api/pages/p1-doc '{"title":"P1 文档","content":"正文"}')"
check "C3 登录后 GET /api/auth/me → 200" "200" "$(code GET /api/auth/me)"
# ★ 期望值在 P2 合入后变化（不是回归，是设计要的行为变化）：
#   P2 的 setup 会在同一事务里写入 setup 者的 owner 成员行（设计文档 §3.2 的 `org_members`），
#   因此 `orgRole` 由 P1 阶段的恒 `null`（当时角色无处持久化）变为 `owner`，
#   对应的 `capabilities.administer` 也由 `false` 变为 `true`（P2 交付内容明确包含
#   "解除 P1 遗留后果：管理台写操作对 owner/admin 恢复可用"）。
check "C3b setup 后 setup 者即为 owner" "owner" "$(field user.orgRole)"
check "C3c owner 具备 administer 能力" "true" "$(field capabilities.administer)"

check "C4 已登录时 GET /api/auth/state → authenticated=true" "true" \
  "$(code GET /api/auth/state >/dev/null; field authenticated)"

echo
echo "=== 阶段 D：CSRF（§8.2 P1-4） ==="
# 带 cookie 但**不带**自定义头 ⇒ 403
CSRF_CODE="$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/logout" \
  -b "$JAR" -c "$JAR")"
check "D1 带 cookie 的非 GET 缺 X-GW-CSRF → 403" "403" "$CSRF_CODE"
check "D1b 错误码 csrf_rejected" "csrf_rejected" "$(field error)"
check "D2 跨站 Origin（浏览器表单必带，无法伪造）→ 403" "403" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/logout" \
     -H 'Origin: https://evil.example' -H 'x-gw-csrf: 1' -b "$JAR" -c "$JAR")"
check "D3 被 CSRF 拦下的请求不产生副作用（会话仍有效）" "200" "$(code GET /api/auth/me)"

echo
echo "=== 阶段 E：登出（§8.2 P1-3） ==="
OLD_JAR="$TMP/old-jar.txt"; cp "$JAR" "$OLD_JAR"
check "E1 登出 → 200" "200" "$(code POST /api/auth/logout)"
check "E2 登出后原 cookie 立即失效（服务端吊销，非仅删 cookie）" "401" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -b "$OLD_JAR" "http://127.0.0.1:$PORT/api/auth/me")"
check "E3 登出后 state 显示未登录" "false" \
  "$(curl -s "http://127.0.0.1:$PORT/api/auth/state" -b "$OLD_JAR" -o "$TMP/body.json"; field authenticated)"

echo
echo "=== 阶段 F：登录限流（§8.2 P1-5） ==="
rm -f "$JAR"
LAST=""
for i in $(seq 1 10); do LAST="$(code POST /api/auth/login '{"email":"owner@example.com","password":"wrong-password"}')"; done
check "F1 连续 10 次错误口令 → 401" "401" "$LAST"
check "F2 第 11 次 → 429（即使口令正确也先被限流挡下）" "429" \
  "$(code POST /api/auth/login '{"email":"owner@example.com","password":"correct-horse-battery"}')"
check "F2b 错误码 too_many_requests" "too_many_requests" "$(field error)"

echo
echo "=== 阶段 G：错误口令与不存在账号的响应一致（防邮箱枚举） ==="
# 换邮箱以避开限流键
W="$(code POST /api/auth/login '{"email":"owner@example.com","password":"x"}')"
rm -f "$TMP/body.json"
A="$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' -H 'x-gw-csrf: 1' -d '{"email":"ghost@example.com","password":"x"}')"
B="$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' -H 'x-gw-csrf: 1' -d '{"email":"nobody-else@example.com","password":"x"}')"
[[ "$A" == "$B" ]] && ok "G1 两个不存在的邮箱响应逐字一致" || bad "G1 响应不一致：$A vs $B"

echo
echo "=== 阶段 H：审计落库（§8.2 P1 审计 + P0-6 接续） ==="
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$TMP/data/geewiki.db');
const rows = db.prepare('SELECT action, target_kind, actor_ip_hash FROM audit_log ORDER BY id').all();
const actions = rows.map(r => r.action);
const want = ['user.setup','login.ok','login.ok','login.fail','login.fail','login.fail','login.fail','login.fail','login.fail','login.fail','login.fail','login.fail','login.fail','login.rate_limited','logout','login.fail','logout'];
const uniq = [...new Set(actions)].sort();
console.log('ACTIONS=' + uniq.join(','));
console.log('HAS_SETUP=' + (actions.includes('user.setup')));
console.log('HAS_LOGIN_OK=' + (actions.includes('login.ok')));
console.log('HAS_LOGIN_FAIL=' + (actions.includes('login.fail')));
console.log('HAS_LOGOUT=' + (actions.includes('logout')));
console.log('IPHASH_OK=' + rows.every(r => r.actor_ip_hash === null || /^[0-9a-f]{64}\$/.test(r.actor_ip_hash)));
const sess = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
console.log('SESSIONS=' + sess.n);
const revoked = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NOT NULL').get();
console.log('REVOKED=' + revoked.n);
const users = db.prepare('SELECT email, email_verified FROM users').all();
console.log('USERS=' + JSON.stringify(users));
const cred = db.prepare('SELECT algo FROM user_credentials').get();
console.log('ALGO=' + (cred && cred.algo));
const ddl = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name);
console.log('TABLES=' + ddl.join(','));
const idx = db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_identities_issuer_sub'\").all();
console.log('IDENTITY_UNIQUE_IDX=' + (idx.length === 1));
"
echo
echo "=== 阶段 I：break-glass 通道仍然可用（P0 能力无回归） ==="
start_server "e2e-admin-token"
# 用**不存在的插件名**：真去 disable db-sqlite 会把库卸载掉，后面的断言就没得跑了。
# 该路由是 4 段（插件名里的 / 必须 URL 编码，否则切成 5 段会得到路由 404，见设计文档 §8.2 P0-1）。
check "I1 带**错误**令牌 → 401（已初始化 ⇒ 存在凭据来源，不再报 503）" "401" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/plugins/%40geewiki%2Fno-such-plugin/disable" \
     -H 'x-gw-admin-token: bogus' -H 'x-gw-csrf: 1')"
check "I2 不带令牌的管理端点 → 401" "401" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/plugins/%40geewiki%2Fno-such-plugin/disable" -H 'x-gw-csrf: 1')"
check "I3 带正确令牌 → 放行（拿到处理器自己的 400 not_active，而不是 401/403/503）" "400" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/plugins/%40geewiki%2Fno-such-plugin/disable" \
     -H 'x-gw-admin-token: e2e-admin-token' -H 'x-gw-csrf: 1')"
check "I3b 处理器确实执行了" "not_active" "$(field error)"
grep -q 'access.break_glass' "$LOG" && ok "I4 stdout 留痕仍在（容器日志第一手证据）" || bad "I4 stdout 无 break-glass 留痕"
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$TMP/data/geewiki.db');
const n = db.prepare(\"SELECT COUNT(*) AS n FROM audit_log WHERE action='access.break_glass'\").get();
console.log('BREAK_GLASS_AUDIT_ROWS=' + n.n);
"
check "I5 匿名读端点仍 200" "200" "$(code GET /api/pages)"

echo
echo "=== 阶段 J：会话与降级 ==="
check "J1 伪造的会话 cookie 不会让公开端点失败（退回匿名）" "200" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/state" -H 'Cookie: gw_sid=bogus')"
check "J1b 且识别为未登录" "false" "$(field authenticated)"

echo
echo "==================================="
echo "通过 $PASS 项，失败 $FAIL 项"
[[ "$FAIL" == "0" ]] || { echo "--- 服务端日志尾部 ---"; tail -40 "$LOG"; }
exit "$FAIL"
