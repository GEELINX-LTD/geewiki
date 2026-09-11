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
echo "=== 阶段 G：过期授权回收（§8.2 P4 第 3 条）==="
# ⚠️ 两处坑，都是本阶段第一版踩到的：
#  ① 授予端点是**按主体幂等 upsert**的 —— 若造两条 subjectId 相同的授予，第二条会覆盖第一条，
#     库里就没有过期行，purge 恒返回 expired=0 也照样"通过"（空洞断言）。现在只造**一条**。
#  ② 阶段 E 结尾按用户批量吊销了所有会话，`$JAR` 已经失效 —— 必须重新登录取新 jar，
#     否则下面的建授予会被 401 挡掉，而断言会以"看起来对"的方式失败。
JAR_G="$TMP/jar-g.txt"
curl -s -c "$JAR_G" -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"email":"owner@example.com","password":"correct-horse-battery"}' >/dev/null
GRANT="$(curl -s -b "$JAR_G" -X POST "http://127.0.0.1:$PORT/api/pages/secret/grants" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"subjectKind":"user","subjectId":"1","role":"viewer","expiresAt":"2020-01-01T00:00:00.000Z"}')"
check "G0 造出一条已过期授权" "2020-01-01T00:00:00.000Z" "$(echo "$GRANT" | field 'expiresAt')"
PURGE="$(curl -s -H "x-gw-admin-token: $TOKEN" -X POST "http://127.0.0.1:$PORT/api/admin/grants/purge")"
check "G1 回收了那条过期授权" "1" "$(echo "$PURGE" | field 'expired')"
check "G2 回收后表里不再有它" "0" "$(echo "$PURGE" | field 'remaining')"
PURGE2="$(curl -s -H "x-gw-admin-token: $TOKEN" -X POST "http://127.0.0.1:$PORT/api/admin/grants/purge")"
check "G3 空跑返回 expired=0" "0" "$(echo "$PURGE2" | field 'expired')"
check "G4 只有真回收了才写审计（恰 1 条）" "1" "$(adm '/api/admin/audit?action=admin.grants_purge' | field 'total')"
check "G5 它属于权限变更视图，不属于安全视图" "1/0" "$(adm '/api/admin/audit?view=acl&action=admin.grants_purge' | field 'total')/$(adm '/api/admin/audit?view=security&action=admin.grants_purge' | field 'total')"
check "G6 非 admin 不得调用" "401" "$(code_of -X POST "http://127.0.0.1:$PORT/api/admin/grants/purge")"

echo
echo "=== 阶段 H：反向展开「谁能看这条」（§8.1 P4）==="
# 造两层树：hx → hx/pub。先让 hx/pub 自己 public+published 且**前置可读**，
# 再把祖先 hx 收紧成 private —— 这样"被祖先收紧"才是可归因的，而不是一开始就读不到。
curl -s -b "$JAR_G" -X PUT "http://127.0.0.1:$PORT/api/pages/hx%2Fpub" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"title":"孙页","content":"HXUNIQBODY"}' >/dev/null
curl -s -b "$JAR_G" -X PUT "http://127.0.0.1:$PORT/api/pages/hx%2Fpub/visibility" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"visibility":"public","published":true}' >/dev/null
# 前置断言：否则下面的"被收紧"可能是假绿（一开始就读不到也会让 H1 变成 404）
check "H0 前置：此刻匿名读得到 hx/pub" "200" "$(code_of "http://127.0.0.1:$PORT/api/pages/hx%2Fpub")"
# ⚠️ 必须先**把 hx 建出来**：缺失的祖先是 `continue`（不构成收紧），这是刻意语义。
#    若 hx 不存在，"把 hx 设成 private" 只会 404，H1 会因为"压根没被收紧"而失败 ——
#    这个坑我在第一版里踩了（当时 hx 从未创建）。
curl -s -b "$JAR_G" -X PUT "http://127.0.0.1:$PORT/api/pages/hx" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"title":"祖先","content":"HXPARENT"}' >/dev/null
check "H0b 前置：hx 已存在（否则下面的收紧动作是空转）" "200" \
  "$(code_of -H "x-gw-admin-token: $TOKEN" "http://127.0.0.1:$PORT/api/admin/access-explain?slug=hx")"
curl -s -b "$JAR_G" -X PUT "http://127.0.0.1:$PORT/api/pages/hx/visibility" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"visibility":"private"}' >/dev/null
EX="$(adm '/api/admin/access-explain?slug=hx%2Fpub')"
check "H1 祖先收紧后匿名读不到" "404" "$(code_of "http://127.0.0.1:$PORT/api/pages/hx%2Fpub")"
check "H2 解释里 reach.anonymous=none" "none" "$(echo "$EX" | field 'reach.anonymous')"
# ⚠️ 这里**不能**期望 inherited-denied：`decideNormally` 的 reason 是按**有效档位**给的，
#    而 hx/pub 的有效档位被祖先压成了 private ⇒ 落空原因是 default-deny。
#    "是祖先把它收紧的"这件事要看 `sources.ancestors`（下一条 H4），不是靠 reason 字符串。
check "H3 落空原因是 default-deny（有效档位已被压到最窄档）" \
  "default-deny" "$(echo "$EX" | field 'reach.anonymousReason')"
check "H4 祖先 hx 被标为**真的收紧了**（不是笼统列出）" "1" \
  "$(echo "$EX" | grep -c '"slug":"hx","visibility":"private","inherit":true,"effect":"tightens"')"
check "H5 组织角色那条只标相关、不标生效（生效与否取决于看的人）" "false/true" \
  "$(echo "$EX" | field 'sources.orgRole.effective')/$(echo "$EX" | field 'sources.orgRole.relevant')"
check "H6 应急覆盖那条同样只标相关" "false/true" \
  "$(echo "$EX" | field 'sources.adminOverride.effective')/$(echo "$EX" | field 'sources.adminOverride.relevant')"
check "H7 无授予时 grants.effective=false" "false" "$(echo "$EX" | field 'sources.grants.effective')"
# ★ H8 原先是**恒真的**，这里必须说明为什么改：原先它用 `$JAR_G`（owner）去读，而 owner 读任何
#   **存在**的页都会被 D14 应急覆盖放行（`decideNormally` 落空 ⇒ `isAdminRole` ⇒ O1 升为 full）——
#   把授予删掉照样 200，于是"授予排在祖先收紧之前"这条排序**零覆盖**。
#   改成用**非管理员的组织成员**读：他不在 O1 之内，200 只可能来自授予。
#   成员账号走「管理员发邀请 → `/api/org/invitations/redeem` 自助开户」这条路
#   （`/api/auth/setup` 是一次性的，系统里没有其它创建第二个用户的途径）；邮箱取自邀请本身，
#   注册者无法自选。redeem **不建会话**（会话属于身份域），故开户后再自己登录一次。
GRANTEE='grantee@example.com'
GI="$(curl -s -b "$JAR_G" -X POST "http://127.0.0.1:$PORT/api/org/invitations" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d "{\"email\":\"$GRANTEE\",\"orgRole\":\"viewer\"}")"
GT="$(echo "$GI" | field 'token')"
check_ge "H7b 反空洞：拿到邀请令牌" 20 "$(printf '%s' "$GT" | wc -c)"
curl -s -X POST "http://127.0.0.1:$PORT/api/org/invitations/redeem" -H 'content-type: application/json' \
  -d "{\"token\":\"$GT\",\"password\":\"correct-horse-battery\"}" >/dev/null
JAR_M="$TMP/jar-member.txt"
curl -s -c "$JAR_M" -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d "{\"email\":\"$GRANTEE\",\"password\":\"correct-horse-battery\"}" >/dev/null
MID="$(curl -s -b "$JAR_M" "http://127.0.0.1:$PORT/api/auth/me" | field 'user.id')"
# 反空洞：id 必须真的取到，否则下面的授予会打到一个空 subjectId 上、H8 以"看起来对"的方式失败
check_ge "H7c 反空洞：拿到非管理员成员的 userId" 1 "${MID:-0}"
# 前置：未被授予时读不到 —— 这一条同时证明了"他不是靠 O1 进来的"（否则这里就会是 200）
check "H7d 前置：该成员未被授予时读不到（他不在 D14 应急覆盖之内）" "404" \
  "$(code_of -b "$JAR_M" "http://127.0.0.1:$PORT/api/pages/hx%2Fpub")"
# 显式授予 ⇒ 它就是"明确指名的例外"，应当恢复可见
curl -s -b "$JAR_G" -X POST "http://127.0.0.1:$PORT/api/pages/hx%2Fpub/grants" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d "{\"subjectKind\":\"user\",\"subjectId\":\"$MID\",\"role\":\"viewer\"}" >/dev/null
check "H8 显式授予后**非管理员被授权者**恢复可见（授予排在祖先收紧之前）" "200" \
  "$(code_of -b "$JAR_M" "http://127.0.0.1:$PORT/api/pages/hx%2Fpub")"
check "H9 此时 grants.effective=true" "true" "$(adm '/api/admin/access-explain?slug=hx%2Fpub' | field 'sources.grants.effective')"
check "H10 需要 slug 参数" "400" "$(code_of -H "x-gw-admin-token: $TOKEN" "http://127.0.0.1:$PORT/api/admin/access-explain")"
check "H11 页面不存在时如实 404（不编造"可能是红链"）" "404" \
  "$(code_of -H "x-gw-admin-token: $TOKEN" "http://127.0.0.1:$PORT/api/admin/access-explain?slug=no/such/page")"
check "H12 非 admin 不得调用" "401" "$(code_of "http://127.0.0.1:$PORT/api/admin/access-explain?slug=hx%2Fpub")"
check_ge "H13 反向展开写审计" 1 "$(adm '/api/admin/audit?action=admin.access_explain' | field 'total')"

echo
echo "=== 阶段 I：sitemap 与匿名可读的**独立**核对（§5.12）==="
# 前置：sitemap 只列**匿名可见**的页。本脚本此前把唯一那条页（secret）改成了 private，
# 所以这里必须先造一条真正公开的页 —— 否则下面的逐条读是空转（I0 反空洞断言会红）。
curl -s -b "$JAR_G" -X PUT "http://127.0.0.1:$PORT/api/pages/pubpage" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"title":"公开页","content":"PUBUNIQBODY"}' >/dev/null
curl -s -b "$JAR_G" -X PUT "http://127.0.0.1:$PORT/api/pages/pubpage/visibility" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"visibility":"public","published":true}' >/dev/null
check "I00 前置：匿名读得到那条公开页" "200" "$(code_of "http://127.0.0.1:$PORT/api/pages/pubpage")"
# ⚠️ 为什么这里才是"独立的"那一半：进程内的 /api/admin/sitemap-audit 用的是与
# visibleSlugs 同一套判定（都对匿名调 decideNormally），所以它自己证明不了什么。
# 真正独立的口径是：取自 /sitemap.xml 的 slug，**再逐条真去匿名读一次** ——
# 读走的是另一条 HTTP 路径（`GET /api/pages/:slug`），两者不一致就是泄漏。
SITEMAP="$(curl -s "http://127.0.0.1:$PORT/sitemap.xml")"
SLUGS_IN_MAP="$(echo "$SITEMAP" | grep -o '<loc>[^<]*</loc>' | sed 's|<loc>/p/||; s|</loc>||')"
MAP_N="$(printf '%s\n' "$SLUGS_IN_MAP" | grep -c .)"
# 反空洞：sitemap 得真的广告了东西，否则下面的逐条读是空转
check_ge "I0 前置：sitemap 至少广告了一条" 1 "$MAP_N"
BAD_READ=0
while IFS= read -r s; do
  [[ -z "$s" ]] && continue
  # ⚠️ 嵌套 slug 必须 URL 编码才能路由到 `GET /api/pages/:slug`（`hx/pub` → `hx%2Fpub`）
  enc="${s//\//%2F}"
  [[ "$(code_of "http://127.0.0.1:$PORT/api/pages/$enc")" == "200" ]] || BAD_READ=$((BAD_READ + 1))
done <<< "$SLUGS_IN_MAP"
check "I1 sitemap 广告的每一条都真的匿名读得到（独立 oracle，必须 0）" "0" "$BAD_READ"
# ⚠️ I2/I3 **不是验证**，只是"如实标注"的回归钉子，请勿把它们读成核对通过：
#   进程内的 `sitemap-audit` 拿 sitemap 广告集合去撞的，是**与 sitemap 生成器同一套规则**
#   算出来的可见集合（`buildAccess` → `decideNormally`）⇒ 差集**结构性恒空**，它报 consistent
#   是必然的，把可见性写坏它照样报 true。**真正有信息量的是上面的 I1** —— 它取自
#   `/sitemap.xml` 的 slug 再**逐条真去匿名读一次**（另一条 HTTP 路径），这才是独立 oracle。
#   I2/I3 钉住的是"端点仍如实自报 sameSource=true、没有把它夸大成两条独立来源的差集"。
check "I2 [非验证·仅标注] 进程内核对恒报一致（同源 ⇒ 必然为空，不构成核对）" "true" \
  "$(adm '/api/admin/sitemap-audit' | field 'consistent')"
check "I3 [非验证·仅标注] 端点如实自报 sameSource=true（没夸大成独立差集）" "true" \
  "$(adm '/api/admin/sitemap-audit' | field 'sameSource')"
check "I4 sitemap 自身 no-store（否则运维核对到的是缓存副本）" "1" \
  "$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/sitemap.xml" | grep -ci 'cache-control: no-store')"
check "I5 非 admin 不得调用 sitemap-audit" "401" "$(code_of "http://127.0.0.1:$PORT/api/admin/sitemap-audit")"

echo
echo "=== 阶段 J：清缓存指引（§5.10）==="
CP="$(adm '/api/admin/cache-plan')"
check "J1 指出唯一可被共享缓存的是门户" "/portal" "$(echo "$CP" | grep -o '"path":"[^"]*"' | head -1 | cut -d'"' -f4)"
# ★ J2 原先**名不副实**：它只 grep 门户的真实响应头里有没有那串，**从不与端点复述的值比对**——
#   于是"复述串与实际不一致"这种情况它照绿（两边各自独立地"看起来对"）。改成真比对：
#   取门户实际的 `cache-control` 头，与 `sharedCacheable[0].cacheControl` 逐字相等。
PORTAL_CC="$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/portal" \
  | grep -i '^cache-control:' | sed 's/^[Cc]ache-[Cc]ontrol:[[:space:]]*//' | tr -d '\r')"
# 反空洞：两边都不能是空串（否则"都空"也会相等而假绿）
check_ge "J2a 反空洞：门户确实带 cache-control 头" 1 "$(printf '%s' "$PORTAL_CC" | wc -c)"
check "J2 端点复述的缓存串与门户**实际**响应头逐字一致" "$PORTAL_CC" \
  "$(echo "$CP" | field 'sharedCacheable.0.cacheControl')"
check "J3 明说 sitemap 无需清理" "1" "$(echo "$CP" | grep -c '/sitemap.xml')"
check "J4 近期有 ACL 变更 ⇒ 建议清缓存" "true" "$(echo "$CP" | field 'purgeRecommended')"
check "J5 非 admin 不得调用" "401" "$(code_of "http://127.0.0.1:$PORT/api/admin/cache-plan")"

echo
echo "=== 阶段 K：过期邀请回收（回收只是回收）==="
# ⚠️ 与阶段 G 同一条口径：**过期失效在判定时就已经发生**，回收只做空间回收。
# 所以本阶段除了断言"回收了过期的"，还必须断言"**不跑回收时那条邀请也已经无效**"——
# 后者才是真正要守的性质（否则运维会以为"不跑清理 ⇒ 过期邀请仍可用"）。
#
# 造过期行的办法：邀请创建端点**不接受**客户端指定 expires_at（服务端算
# `isoPlus(now, invitationTtlMs)`），所以只能直接改库。库路径来自脚本自己设的
# GEEWIKI_DATA_DIR，服务与这里是两个连接，SQLite 允许这种一行 UPDATE。
INV="$(curl -s -b "$JAR_G" -X POST "http://127.0.0.1:$PORT/api/org/invitations" -H 'content-type: application/json' \
  -H 'x-gw-csrf: 1' -d '{"email":"expired@example.com","orgRole":"viewer"}')"
INV_ID="$(echo "$INV" | field 'invitation.id')"
INV_TOKEN="$(echo "$INV" | field 'token')"
check "K0 建出一条邀请" "1" "$(echo "$INV" | grep -c '"ok":true')"
# 反空洞：id 与 token 都得真的取到，否则后面几条会以"看起来对"的方式失败
check_ge "K0b 反空洞：拿到了邀请 id" 8 "$(printf '%s' "$INV_ID" | wc -c)"
check_ge "K0c 反空洞：拿到了明文令牌" 20 "$(printf '%s' "$INV_TOKEN" | wc -c)"

# 前置：未过期时**不**得被回收（否则"回收过期"这条断言可能只是"把全都清了"）
PURGE_I0="$(curl -s -b "$JAR_G" -H 'x-gw-csrf: 1' -X POST "http://127.0.0.1:$PORT/api/org/invitations/purge")"
check "K1 未过期的邀请**不**被回收" "0" "$(echo "$PURGE_I0" | field 'expired')"
check_ge "K2 且它仍在表里（remaining ≥ 1）" 1 "$(echo "$PURGE_I0" | field 'remaining')"
check "K3 空跑不写审计（避免把审计淹掉）" "0" "$(adm '/api/admin/audit?action=org.invitation.purge' | field 'total')"

# 把它改成已过期
node -e "
const Database = require(process.argv[1] + '/packages/db-sqlite/node_modules/better-sqlite3')
const db = new Database(process.argv[2])
db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', process.argv[3])
db.close()
" "$ROOT" "$TMP/data/geewiki.db" "$INV_ID"
check "K4 已把该邀请改成过期" "2020-01-01T00:00:00.000Z" \
  "$(node -e "
const Database = require(process.argv[1] + '/packages/db-sqlite/node_modules/better-sqlite3')
const db = new Database(process.argv[2])
process.stdout.write(String(db.prepare('SELECT expires_at FROM invitations WHERE id = ?').get(process.argv[3]).expires_at))
db.close()
" "$ROOT" "$TMP/data/geewiki.db" "$INV_ID")"

# ★ 关键：**在回收之前**先验兑换已经失效 —— 这才是"判定不依赖回收"
check "K5 未跑回收时，兑换已过期邀请即失败（判定不依赖回收）" "400" \
  "$(code_of -X POST "http://127.0.0.1:$PORT/api/org/invitations/redeem" -H 'content-type: application/json' \
     -d "{\"token\":\"$INV_TOKEN\"}")"

PURGE_I="$(curl -s -b "$JAR_G" -H 'x-gw-csrf: 1' -X POST "http://127.0.0.1:$PORT/api/org/invitations/purge")"
check "K6 回收了那条过期邀请" "1" "$(echo "$PURGE_I" | field 'expired')"
check "K7 真有副作用时才写审计" "1" "$(adm '/api/admin/audit?action=org.invitation.purge' | field 'total')"
check "K8 它属于权限变更视图，不属于安全视图" "1/0" \
  "$(adm '/api/admin/audit?view=acl&action=org.invitation.purge' | field 'total')/$(adm '/api/admin/audit?view=security&action=org.invitation.purge' | field 'total')"
check "K9 未登录不得调用（该端点的判据是会话角色，不是 break-glass 令牌）" "401" "$(code_of -X POST "http://127.0.0.1:$PORT/api/org/invitations/purge")"

echo
echo "==================================="
echo "通过 $PASS 项，失败 $FAIL 项"
[[ "$FAIL" -eq 0 ]] || exit 1
