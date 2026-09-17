#!/usr/bin/env bash
# P2-M2 组织/成员/组/邀请 端到端验收 —— 真实起服务 + 真实 curl，不 mock 任何东西。
# 用法：bash packages/plugin-org/test/e2e-p2-org.sh
#
# 覆盖的语义（每条都是"写错了不会报错、只会静默错"的那类）：
#   A. setup 必须把首个账号落成 owner（否则系统永远没有 owner）
#   B. orgRole 真的进了 Principal ⇒ access:'admin' 的端点对 owner 放行、对 member 403
#   C. guest 通道（orgRole=null）⇒ **不写 org_members**，而不是写一个最低档角色
#   D. 最后一个 owner 不可被降级 / 移除（并发下也不会漏，判据在同一事务里）
#   E. 组身份进 Principal.groupIds ⇒ 组授权才有意义
#   F. 邀请令牌只存哈希、缺失/过期/已用一律同一文案、邮箱必须匹配
#   G. 凭邀请自助开户（redeem）能让"邀请"不至于无人可接受
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-43201}"
TMP="$(mktemp -d)"
JAR="$TMP/owner.jar"
JAR2="$TMP/member.jar"
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
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi; }

start_server() {
  mkdir -p "$TMP/cfg" "$TMP/data"
  cp "$ROOT/config/plugins.base.json" "$TMP/cfg/plugins.base.json"
  printf '{\n  "enabled": []\n}\n' > "$TMP/cfg/plugins.session.json"
  # `exec` 让子 shell 被 node 取代 ⇒ $! 就是 node 自己的 pid，kill 才真的杀得到它
  ( cd "$ROOT" && exec env GEEWIKI_CONFIG_DIR="$TMP/cfg" GEEWIKI_DATA_DIR="$TMP/data" \
      GEEWIKI_PORT="$PORT" node --import tsx packages/server/src/index.ts ) >>"$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    H=$(curl -s "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
    case "$H" in *'"present":true'*) return 0;; esac
    sleep 0.5
  done
  echo "服务未能就绪，日志："; tail -30 "$LOG"; exit 1
}

# req <jar|-> <method> <path> [json] → 打印状态码，响应体写入 $TMP/body.json
req() {
  local jar="$1" m="$2" p="$3" body="${4:-}"
  local args=(-s -o "$TMP/body.json" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p"
              -H 'x-gw-csrf: 1' -H 'content-type: application/json')
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}
# req_raw <method> <path> [json]（匿名）
req_raw() { req "-" "$@"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o.'+process.argv[1]);console.log(v===undefined||v===null?'':String(v))}catch(e){console.log('')}})" "$1" < "$TMP/body.json"; }
# reqfield <jar> <method> <path> <js-expr>：发请求后只输出字段值
# （不能写成 "$(req … ; node …)" —— 那会把状态码和字段值拼成一个字符串，
#   于是断言拿到 "2001" 这种既非状态码也非值的怪东西）
reqfield() { req "$1" "$2" "$3" >/dev/null; field "$4"; }

echo "=== 启动服务 ==="
start_server
echo "  就绪"

echo
echo "=== A. 首次初始化必须落成 owner ==="
# ★ 必须带 jar：setup 会下发会话 cookie，用匿名请求跑会把登录态丢掉，
#   后面所有带凭据的断言都会变成匿名请求（症状是满屏 401，且完全不报"测试写错了"）
check "A1 POST /api/auth/setup" 201 "$(req "$JAR" POST /api/auth/setup '{"email":"owner@example.com","password":"ownerpass123","displayName":"Owner"}')"
check "A2 setup 返回的 orgRole 是 owner" "owner" "$(field user.orgRole)"

echo
echo "=== B. owner 能过 access:'admin'（这正是 P1 遗留后果的解除） ==="
check "B1 GET /api/auth/me" 200 "$(req "$JAR" GET /api/auth/me)"
check "B1b orgRole=owner" "owner" "$(field user.orgRole)"
check "B1c capabilities.administer=true" "true" "$(field capabilities.administer)"
check "B2 GET /api/org" 200 "$(req "$JAR" GET /api/org)"
check "B2b me.role=owner" "owner" "$(field me.role)"
check "B2c me.isGuest=false" "false" "$(field me.isGuest)"
check "B2d 组织名" "默认组织" "$(field org.name)"
check "B3 ★ GET /api/org/members（access:'admin'）" 200 "$(req "$JAR" GET /api/org/members)"
MEMBERS=$(node -e "const o=require('$TMP/body.json');console.log(o.members.map(m=>m.email+':'+m.role).join(','))")
check "B3b 成员列表含 owner" "owner@example.com:owner" "$MEMBERS"

echo
echo "=== C. 建组 + 签邀请（带组、orgRole=member） ==="
check "C1 POST /api/org/groups" 201 "$(req "$JAR" POST /api/org/groups '{"name":"编辑部"}')"
GROUP_ID=$(field group.id)
echo "      groupId=$GROUP_ID"
check "C1b 同名组重复创建被拒" 409 "$(req "$JAR" POST /api/org/groups '{"name":"编辑部"}')"
check "C2 POST /api/org/invitations" 201 "$(req "$JAR" POST /api/org/invitations "{\"email\":\"member@example.com\",\"orgRole\":\"member\",\"groupId\":$GROUP_ID}")"
TOKEN=$(field token)
[[ -n "$TOKEN" ]] && ok "C2b 返回了一次性原始令牌（长度 ${#TOKEN}）" || bad "C2b 未返回令牌"
check "C3 GET /api/org/invitations" 200 "$(req "$JAR" GET /api/org/invitations)"
check "C3b ★ 列表里没有任何令牌字段" "" "$(node -e "const o=require('$TMP/body.json');console.log(o.invitations.map(i=>Object.keys(i).filter(k=>/token/i.test(k)).join(',')).join(''))")"

echo
echo "=== C4. 通用码：不绑定邮箱（持码者自填） ==="
check "C4 签发通用码（不传 email）" 201 "$(req "$JAR" POST /api/org/invitations '{"orgRole":"member"}')"
OPEN_A=$(field token)
check "C4b ★ 通用码的 email 落库为 null（不是空串）" "null" "$(node -e "const o=require('$TMP/body.json');console.log(o.invitation.email===null?'null':JSON.stringify(o.invitation.email))")"
check "C5 再签一个通用码" 201 "$(req "$JAR" POST /api/org/invitations '{"orgRole":"member"}')"
OPEN_B=$(field token)
check "C6 非法邮箱仍被拒（可选项不等于不校验）" 400 "$(req "$JAR" POST /api/org/invitations '{"email":"not-an-email","orgRole":"member"}')"
check "C6b 错误码" "invalid_email" "$(field error)"

echo
echo "=== D. 凭邀请自助开户（匿名，这是新用户唯一的入口） ==="
check "D1 错误令牌 → 400 且文案统一" 400 "$(req_raw POST /api/org/invitations/redeem '{"token":"bogus","password":"memberpass123"}')"
check "D1b 错误码" "invalid_invitation" "$(field error)"
check "D2 redeem 开户" 201 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$TOKEN\",\"password\":\"memberpass123\",\"displayName\":\"Member\"}")"
NEW_UID=$(field userId)
check "D2b 入伙角色为 member" "member" "$(field orgRole)"
check "D3 同一令牌**不能**二次使用" 400 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$TOKEN\",\"password\":\"another123\"}")"

echo
echo "=== D4. 通用码：注册者自选邮箱 + 用户名 ==="
check "D4 ★ 通用码但不传邮箱 → 400（必须显式给出，不编一个）" 400 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$OPEN_A\",\"password\":\"selfpass12345\"}")"
check "D4b 错误码 email_required" "email_required" "$(field error)"
check "D5 ★ 通用码 + 自选邮箱 → 201" 201 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$OPEN_B\",\"email\":\"self@example.com\",\"password\":\"selfpass12345\",\"displayName\":\"自选\"}")"
check "D5b 开户邮箱就是自选的那个" "self@example.com" "$(field email)"
JAR3="$TMP/self.jar"
check "D5c ★ 用自选邮箱能登录" 200 "$(req "$JAR3" POST /api/auth/login '{"email":"self@example.com","password":"selfpass12345"}')"
check "D6 签发定向码（限定 bound@example.com）→ 201" 201 "$(req "$JAR" POST /api/org/invitations '{"email":"bound@example.com","orgRole":"member"}')"
BOUND=$(field token)
check "D6b ★ 定向码 + 另一个邮箱 → 403" 403 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$BOUND\",\"email\":\"someone-else@example.com\",\"password\":\"boundpass12345\"}")"
check "D6c 错误码 email_mismatch" "email_mismatch" "$(field error)"
check "D6d 定向码 + 正确邮箱 → 201" 201 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$BOUND\",\"email\":\"bound@example.com\",\"password\":\"boundpass12345\"}")"

echo
echo "=== E. 新成员登录后的主体语义 ==="
check "E1 新成员登录" 200 "$(req "$JAR2" POST /api/auth/login '{"email":"member@example.com","password":"memberpass123"}')"
check "E1b orgRole=member" "member" "$(field user.orgRole)"
# login 的响应体里没有 capabilities（那是 state / me 的字段），必须另查一次
check "E1c capabilities.editContent=true" "true" "$(reqfield "$JAR2" GET /api/auth/me 'capabilities.editContent')"
check "E1d capabilities.administer=false" "false" "$(reqfield "$JAR2" GET /api/auth/me 'capabilities.administer')"
# ★ 2026-09-17 更正：本条原先断言 member GET /api/org/members → 403，**已经过时** ——
#  该端点后来刻意放宽为 `access:'user'`（handler 里有注释：「让我选一个授权对象」，
#  凡是能走到授权界面的人都该看得到）。断言没跟上，于是在本次改动之前就一直是红的
#  （它不在 pnpm test 里，故没人发现）。改成断言它**真正的**语义：
#  读得到列表，但过不了 admin **动作**。
check "E2 ★ member 能读成员列表（access:'user'，用于选授权对象）" 200 "$(req "$JAR2" GET /api/org/members)"
check "E2c ★ member 过不了 admin 动作（改别人的角色）" 403 "$(req "$JAR2" PUT "/api/org/members/$NEW_UID" '{"role":"viewer"}')"
check "E2d 错误码 forbidden" "forbidden" "$(field error)"
check "E3 ★ 组身份进了 Principal.groupIds" "$GROUP_ID" "$(reqfield "$JAR2" GET /api/org "me.groupIds.join(',')")"

echo
echo "=== F. 不变式：最后一个 owner 不可被降级 / 移除 ==="
check "F1 降级最后一个 owner → 409" 409 "$(req "$JAR" PUT /api/org/members/1 '{"role":"viewer"}')"
check "F1b 错误码 last_owner" "last_owner" "$(field error)"
check "F2 移除自己 → 409" 409 "$(req "$JAR" DELETE /api/org/members/1)"
check "F2b 错误码 cannot_remove_self" "cannot_remove_self" "$(field error)"
check "F3 把新成员提升为 admin（合法变更）" 200 "$(req "$JAR" PUT "/api/org/members/$NEW_UID" '{"role":"admin"}')"
check "F4 ★ 非 owner 不能触碰 owner（admin 也不行）" 403 "$(req "$JAR2" PUT /api/org/members/1 '{"role":"viewer"}')"
check "F4b 错误码 forbidden" "forbidden" "$(field error)"

echo
echo "=== G. 组只收组织成员（防幽灵成员）+ 幂等语义 ==="
check "G1 不存在的用户入组 → 409" 409 "$(req "$JAR" PUT "/api/org/groups/$GROUP_ID/members/9999")"
check "G1b 错误码 not_org_member" "not_org_member" "$(field error)"
# 该成员在 redeem 时已随邀请入组 ⇒ 再加一次是**幂等空操作**，应当 200 且不重复写审计
check "G2 重复入组是幂等空操作" 200 "$(req "$JAR" PUT "/api/org/groups/$GROUP_ID/members/$NEW_UID")"
check "G3 新建一个组" 201 "$(req "$JAR" POST /api/org/groups '{"name":"审校组"}')"
GROUP2_ID=$(field group.id)
check "G4 把真实成员加入新组（这次会真实变更）" 200 "$(req "$JAR" PUT "/api/org/groups/$GROUP2_ID/members/$NEW_UID")"
check "G5 GET /api/org/groups 能看到两个组" "2" "$(reqfield "$JAR" GET /api/org/groups 'groups.length')"

echo
echo "=== I. 改资料（邮箱 / 用户名）—— 必须验当前口令 ==="
check "I1 未登录 → 401" 401 "$(req_raw POST /api/auth/profile '{"currentPassword":"x","displayName":"y"}')"
check "I2 ★ 当前口令错误 → 401（这正是防"被盗会话改登录标识符"的那道闸门）" 401 "$(req "$JAR2" POST /api/auth/profile '{"currentPassword":"wrong","displayName":"新名字"}')"
check "I2b 错误码 invalid_credentials" "invalid_credentials" "$(field error)"
check "I3 改成已被占用的邮箱 → 409" 409 "$(req "$JAR2" POST /api/auth/profile '{"currentPassword":"memberpass123","email":"owner@example.com"}')"
check "I3b 错误码 email_taken" "email_taken" "$(field error)"
check "I4 空内容 → 400" 400 "$(req "$JAR2" POST /api/auth/profile '{"currentPassword":"memberpass123"}')"
check "I4b 错误码 nothing_to_update" "nothing_to_update" "$(field error)"
check "I5 改显示名 → 200" 200 "$(req "$JAR2" POST /api/auth/profile '{"currentPassword":"memberpass123","displayName":"改名了"}')"
check "I5b changed=true" "true" "$(field changed)"
check "I5c 新显示名生效" "改名了" "$(reqfield "$JAR2" GET /api/auth/me 'user.displayName')"
check "I6 改邮箱 → 200" 200 "$(req "$JAR2" POST /api/auth/profile '{"currentPassword":"memberpass123","email":"renamed@example.com"}')"
check "I6b ★ 新邮箱能登录（登录标识符真的换了）" 200 "$(req "$TMP/renamed.jar" POST /api/auth/login '{"email":"renamed@example.com","password":"memberpass123"}')"
check "I6c ★ 旧邮箱**不能**再登录" 401 "$(req_raw POST /api/auth/login '{"email":"member@example.com","password":"memberpass123"}')"

echo
echo "=== J. 邀请码换发（随时能拿到一个可用的码，且库里仍不存明文） ==="
check "J1 签发一条待用邀请" 201 "$(req "$JAR" POST /api/org/invitations '{"orgRole":"member"}')"
ROT_ID=$(field invitation.id)
ROT_A=$(field token)
check "J2 ★ 换发 → 200" 200 "$(req "$JAR" POST "/api/org/invitations/$ROT_ID/rotate")"
ROT_B=$(field token)
[[ -n "$ROT_B" && "$ROT_B" != "$ROT_A" ]] && ok "J2b 新令牌与旧的不同（长度 ${#ROT_B}）" || bad "J2b 换发没有产生新令牌"
check "J3 ★ 旧令牌**已作废**（兑换 → 400）" 400 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$ROT_A\",\"email\":\"rot-old@example.com\",\"password\":\"rotpass12345\"}")"
check "J4 ★ 新令牌可用（兑换 → 201）" 201 "$(req_raw POST /api/org/invitations/redeem "{\"token\":\"$ROT_B\",\"email\":\"rot-new@example.com\",\"password\":\"rotpass12345\"}")"
check "J5 ★ 已接受的邀请**不得**换发（否则第二个人也能用它进来）" 409 "$(req "$JAR" POST "/api/org/invitations/$ROT_ID/rotate")"
check "J5b 错误码 already_accepted" "already_accepted" "$(field error)"

# 造一条已过期的邀请：直接把 expires_at 改到过去（不走时间旅行）
check "J6 再签一条（用来造过期）" 201 "$(req "$JAR" POST /api/org/invitations '{"orgRole":"member"}')"
EXP_ID=$(field invitation.id)
node -e "
const D=require('$ROOT/packages/db-sqlite/node_modules/better-sqlite3');
const db=new D('$TMP/data/geewiki.db');
db.prepare('update invitations set expires_at = ? where id = ?').run('2020-01-01T00:00:00Z', process.argv[1]);
" "$EXP_ID"
check "J7 ★ 已过期的邀请 → 409（换发**不**代替续期）" 409 "$(req "$JAR" POST "/api/org/invitations/$EXP_ID/rotate")"
check "J7b 错误码 invitation_expired" "invitation_expired" "$(field error)"
check "J8 ★ member 不得换发" 403 "$(req "$JAR3" POST "/api/org/invitations/$ROT_ID/rotate")"
check "J9 不存在的邀请 → 404" 404 "$(req "$JAR" POST /api/org/invitations/does-not-exist/rotate)"

echo
echo "=== H. 审计留痕 ==="
AUD=$(node -e "
const D=require('$ROOT/packages/db-sqlite/node_modules/better-sqlite3');
const db=new D('$TMP/data/geewiki.db',{readonly:true});
const rows=db.prepare('select action, count(*) c from audit_log group by action order by action').all();
for (const r of rows) console.error('      '+r.action+' x'+r.c);
const need=['org.invitation.create','org.invitation.redeem','org.group.create','org.member.set_role','org.group.add_member','user.profile.update','org.invitation.rotate'];
const have=rows.map(r=>r.action);
console.log(need.every(a=>have.includes(a))?'OK':'MISSING:'+need.filter(a=>!have.includes(a)).join(','));
const leak=db.prepare(\"select count(*) c from audit_log where coalesce(after_json,'') like ? or coalesce(before_json,'') like ?\").get('%$TOKEN%','%$TOKEN%').c;
console.log('leak='+leak);
")
check "H1 关键动作都有审计" "OK" "$(echo "$AUD" | head -1)"
check "H2 ★ 审计里不含邀请令牌" "leak=0" "$(echo "$AUD" | tail -1)"

# 身份变更的台账价值全在 before/after —— 只记"某人改了资料"等于没记
PROF=$(node -e "
const D=require('$ROOT/packages/db-sqlite/node_modules/better-sqlite3');
const db=new D('$TMP/data/geewiki.db',{readonly:true});
// 注意取**最后**一条：本轮有两次改资料（先只改显示名、再改邮箱），
// 取第一条会拿到"只改显示名"那条，于是断言永远看不到邮箱变化。
const r=db.prepare(\"select before_json b, after_json a from audit_log where action='user.profile.update' order by id desc limit 1\").get();
const okB=!!r&&/member@example\.com/.test(r.b||'');
const okA=!!r&&/renamed@example\.com/.test(r.a||'');
console.log(okB&&okA?'OK':'BAD:'+(r?JSON.stringify(r).slice(0,120):'no-row'));
")
check "H3 ★ 改资料记了 before/after（能答出"改成了什么"）" "OK" "$PROF"

echo
echo "==================================="
echo "通过 $PASS 项，失败 $FAIL 项"
[[ "$FAIL" -eq 0 ]]
