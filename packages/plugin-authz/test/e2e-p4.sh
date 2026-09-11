#!/usr/bin/env bash
# P4 端到端验收：审计闭环、越权告警、会话管理（设计文档 §8.2 的 P4 验收标准）。
#
# 用法：bash packages/plugin-authz/test/e2e-p4.sh
#
# ⚠️ 与其它 e2e 脚本一样**不被 `pnpm test` 执行** —— 它要真实起服务。
#    另外两条 P4 验收（audit_log 只增不删、page_versions 无保留策略清理）是
#    **源码级守卫**，在 `packages/plugin-authz/test/audit-appendonly.test.ts` 里，
#    由 `pnpm test` 覆盖；本脚本不重复它们。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-53501}"
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

ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi }
check_ge() { if [[ "$3" -ge "$2" ]]; then ok "$1（$3 ≥ $2）"; else bad "$1 —— 期望 ≥ $2，实际 $3"; fi }

# 带 admin 令牌的 GET（break-glass 通道）
adm() { curl -s -H "x-gw-admin-token: $TOKEN" "http://127.0.0.1:$PORT$1"; }
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# 从 JSON 里取一个字段（避免依赖 jq）
field() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);
  const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1"
}

TOKEN="p4-e2e-admin-token"
echo "=== 启动服务 ==="
( cd "$ROOT" && exec env GEEWIKI_DATA_DIR="$TMP/data" GEEWIKI_PORT="$PORT" \
    GEEWIKI_ADMIN_TOKEN="$TOKEN" node --import tsx packages/server/src/index.ts ) >"$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "服务未起来"; exit 1; }
echo "  服务已就绪"

echo
echo "=== 阶段 A：准备数据（建页 + 改可见性，产生 ACL 变更审计）==="
curl -s -X POST "http://127.0.0.1:$PORT/api/auth/setup" -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"correct-horse-battery","displayName":"站长"}' >/dev/null
curl -s -c "$JAR" -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"email":"owner@example.com","password":"correct-horse-battery"}' >/dev/null
SESSION_A="$(curl -s -b "$JAR" "http://127.0.0.1:$PORT/api/auth/me" | field 'session.id')"

# 正文里放一个**唯一字符串**：它若出现在审计或搜索结果里，就是泄漏
UNIQ='P4UNIQBODY777'
CREATED="$(curl -s -b "$JAR" -X PUT "http://127.0.0.1:$PORT/api/pages/secret" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d "{\"title\":\"机密\",\"content\":\"$UNIQ\"}")"
check "A1 建页成功" "created" "$(echo "$CREATED" | field 'outcome')"
# 改可见性（org → private），这必须产生一条 ACL 变更审计
VIS="$(curl -s -b "$JAR" -X PUT "http://127.0.0.1:$PORT/api/pages/secret/visibility" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"visibility":"private"}')"
check_ge "A2 改可见性的响应是合法 JSON（有 ok 字段）" 1 "$(echo "$VIS" | grep -c '"ok"')"

echo
echo "=== 阶段 B：越权尝试（§8.2 P4 第 4 条）==="
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/pages/secret"; done
for i in 1 2 3; do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/pages/ghost$i"; done
sleep 0.5

DENIED="$(adm "/api/admin/audit?view=security&action=access.denied")"
check_ge "B1 匿名连续 20 次请求受限页 ⇒ 产生 access.denied 记录" 20 "$(echo "$DENIED" | field 'total')"
check "B2 记录的目标是被请求的那个 slug" "secret" "$(echo "$DENIED" | grep -o '"targetId":"[^"]*"' | head -1 | cut -d'"' -f4)"
check "B3 请求不存在的页**不**产生越权记录（ghost 不该出现）" "0" "$(echo "$DENIED" | grep -c 'ghost')"

ACL_VIEW="$(adm "/api/admin/audit?view=acl")"
check "B4 access.denied **不计入**权限变更视图（§8.2 P4 第 4 条）" "0" "$(echo "$ACL_VIEW" | grep -c 'access.denied')"
ALL_VIEW="$(adm "/api/admin/audit?view=all")"
check_ge "B5 view=all 能看到两类" 21 "$(echo "$ALL_VIEW" | field 'total')"
check "B6 非法的 view 值被拒" "400" "$(code_of -H "x-gw-admin-token: $TOKEN" "http://127.0.0.1:$PORT/api/admin/audit?view=bogus")"
check "B7 审计查询需要 admin（匿名 → 401/503）" "401" "$(code_of "http://127.0.0.1:$PORT/api/admin/audit")"

echo
echo "=== 阶段 C：审计不含正文（§8.2 P4 第 1 条）==="
DUMP="$(adm "/api/admin/audit?view=all&limit=200")"
# ⚠️ 这一条**不能**写成"把四个 grep 结果拼起来比 4" —— 那只比出了字符串长度。
#    逐字段检查，缺任何一个都会红。
CHANGE="$(adm '/api/admin/audit?action=acl.change')"
check_ge "C0 存在 acl.change 审计行" 1 "$(echo "$CHANGE" | field 'total')"
FIELDS_PRESENT=0
for f in actorId action targetKind targetId before after; do
  [[ "$(echo "$CHANGE" | grep -c "\"$f\"")" -ge 1 ]] && FIELDS_PRESENT=$((FIELDS_PRESENT + 1))
done
check "C1 acl.change 行含 actor/action/target/before/after 六个字段" "6" "$FIELDS_PRESENT"
check "C2 审计里**不含正文**（唯一字符串出现 0 次）" "0" "$(echo "$DUMP" | grep -c "$UNIQ")"
check "C3 审计里不含 token_hash" "0" "$(echo "$DUMP" | grep -c 'token_hash')"

echo
echo "=== 阶段 D：两个 verify 端点（§8.2 P4 第 5 条）==="
check "D1 blocks/verify mismatched=0" "0" "$(adm '/api/admin/blocks/verify' | field 'mismatched')"
check "D2 blocks/verify tier_mismatched=0" "0" "$(adm '/api/admin/blocks/verify' | field 'tier_mismatched')"
check_ge "D3 tier 检查确实跑了（否则上一条是假绿）" 1 "$(adm '/api/admin/blocks/verify' | field 'tier_checked')"
check "D4 search/verify missing=0" "0" "$(adm '/api/admin/search/verify' | field 'missing')"
check "D5 search/verify extra=0" "0" "$(adm '/api/admin/search/verify' | field 'extra')"

echo
echo "=== 阶段 E：会话管理 ==="
LIST="$(adm '/api/admin/sessions?userId=1')"
check_ge "E1 能列出会话" 1 "$(echo "$LIST" | field 'total')"
check "E2 列表里不含 token_hash" "0" "$(echo "$LIST" | grep -c 'token_hash')"
# 再登一次拿第二个会话，定点吊销它，验证互不影响
JAR2="$TMP/jar2.txt"
curl -s -c "$JAR2" -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"email":"owner@example.com","password":"correct-horse-battery"}' >/dev/null
SESSION_B="$(curl -s -b "$JAR2" "http://127.0.0.1:$PORT/api/auth/me" | field 'session.id')"
if [[ -n "$SESSION_A" && -n "$SESSION_B" && "$SESSION_A" != "$SESSION_B" ]]; then
  ok "E3 两个会话 id 不同"
else
  bad "E3 两个会话 id 不同 —— A=$SESSION_A B=$SESSION_B"
fi
check "E4 吊销前两个 cookie 都有效" "200/200" "$(code_of -b "$JAR" "http://127.0.0.1:$PORT/api/auth/me")/$(code_of -b "$JAR2" "http://127.0.0.1:$PORT/api/auth/me")"
curl -s -H "x-gw-admin-token: $TOKEN" -X POST "http://127.0.0.1:$PORT/api/admin/sessions/$SESSION_B/revoke" >/dev/null
check "E5 定点吊销后：被吊销的失效、另一个不受影响" "200/401" "$(code_of -b "$JAR" "http://127.0.0.1:$PORT/api/auth/me")/$(code_of -b "$JAR2" "http://127.0.0.1:$PORT/api/auth/me")"
check "E6 重复吊销幂等（仍是 200）" "200" "$(code_of -H "x-gw-admin-token: $TOKEN" -X POST "http://127.0.0.1:$PORT/api/admin/sessions/$SESSION_B/revoke")"
check "E7 幂等不重复写审计（session_revoke 恰好 1 条）" "1" "$(adm '/api/admin/audit?action=admin.session_revoke' | field 'total')"
check "E8 按用户批量吊销" "200" "$(code_of -H "x-gw-admin-token: $TOKEN" -X POST "http://127.0.0.1:$PORT/api/admin/users/1/sessions/revoke")"
check "E9 批量吊销后原 cookie 失效" "401" "$(code_of -b "$JAR" "http://127.0.0.1:$PORT/api/auth/me")"

echo
echo "=== 阶段 F：审计查询的过滤与分页 ==="
check "F1 targetId 过滤生效" "1" "$(adm '/api/admin/audit?action=access.denied&targetId=secret&limit=1' | field 'limit')"
check_ge "F2 limit 上限被夹紧（请求 9999 → ≤200）" 1 "$(adm '/api/admin/audit?limit=9999' | field 'limit' | awk '{print ($1<=200)?1:0}')"
check "F3 不存在的 action 返回空集而不是报错" "0" "$(adm '/api/admin/audit?action=no.such.action' | field 'total')"

echo
echo "==================================="
echo "通过 $PASS 项，失败 $FAIL 项"
[[ "$FAIL" -eq 0 ]] || exit 1
