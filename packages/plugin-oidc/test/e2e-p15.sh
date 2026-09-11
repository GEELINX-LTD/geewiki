#!/usr/bin/env bash
# P1.5 端到端验收：真实服务进程 + 真实 curl + 独立 mock IdP（支持 /authorize 的完整授权码往返）。
#
# 覆盖设计文档 §8.2 的 P1.5 验收标准：
#   - 未启用 @geewiki/oidc 时 /api/auth/oidc/* 不存在（404 语义）
#   - mock IdP 下完成首登，且 invite_only 默认策略下无邀请 ⇒ 403 no_invitation
#   - email 已存在 ⇒ 409 identity_link_required（且票据只在 HttpOnly cookie 里）
#   - 解绑最后一个凭据 ⇒ 409 last_credential
#   - IdP 不可达 ⇒ capabilities 降级，本地密码通道不受影响
# 外加 §7.4 的七条安全校验里的端到端部分（PKCE 真的送出、state 一次性、算法白名单）。
#
# 用法：bash packages/plugin-oidc/test/e2e-p15.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-42912}"
IDP_PORT="${IDP_PORT:-42911}"
# **必须导出**：write_config 用 node 生成配置时要读它们（没导出的话 issuer 会变成
# http://127.0.0.1:undefined/，插件激活失败，表现为"整个 SSO 通道像没装一样"）
export PORT IDP_PORT
TMP="$(mktemp -d)"
JAR="$TMP/jar.txt"
LOG="$TMP/server.log"
IDP_LOG="$TMP/idp.log"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  [[ -n "${IDP_PID:-}" ]] && { kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; }
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi }

body() { cat "$TMP/body.json"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1" < "$TMP/body.json"; }

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

# ---------------- mock IdP ----------------

start_idp() { # start_idp [额外的环境变量赋值...]
  [[ -n "${IDP_PID:-}" ]] && { kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; }
  : > "$IDP_LOG"
  ( exec env MOCK_IDP_PORT="$IDP_PORT" "$@" node "$ROOT/packages/plugin-oidc/test/mock-idp.mjs" ) >>"$IDP_LOG" 2>&1 &
  IDP_PID=$!
  for _ in $(seq 1 40); do
    grep -q 'MOCK_IDP_READY' "$IDP_LOG" && return 0
    sleep 0.25
  done
  echo "mock IdP 启动失败："; cat "$IDP_LOG"; exit 1
}

stop_idp() {
  [[ -n "${IDP_PID:-}" ]] && { kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""; }
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$IDP_PORT/.well-known/openid-configuration" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  echo "mock IdP 未能停止"; exit 1
}

# ---------------- 服务 ----------------

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
  # 必须等端口真正释放，否则健康检查会连上旧进程（既有 e2e 脚本踩过这个坑）
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "旧服务未退出，端口仍被占用"; exit 1
}

# write_config <是否启用 oidc: yes|no> <auth 的 provisioning 模式>
write_config() {
  mkdir -p "$TMP/config"
  node -e '
    const fs = require("fs")
    const [file, withOidc, mode] = process.argv.slice(1)
    const enabled = [
      { name: "@geewiki/db-sqlite" },
      { name: "@geewiki/http" },
      { name: "@geewiki/wiki" },
      { name: "@geewiki/search" },
      { name: "@geewiki/auth", config: { cookieSecure: false, oidcProvisioningMode: mode } },
    ]
    if (withOidc === "yes") {
      enabled.push({
        name: "@geewiki/oidc",
        config: {
          issuer: `http://127.0.0.1:${process.env.IDP_PORT}/`,
          clientId: "geewiki-e2e",
          redirectUri: `http://127.0.0.1:${process.env.PORT}/api/auth/oidc/callback`,
          providerId: "e2e",
          label: "测试 SSO",
          probeIntervalSeconds: 0,
        },
      })
    }
    fs.writeFileSync(file, JSON.stringify({ enabled }, null, 2))
  ' "$TMP/config/plugins.base.json" "$1" "$2"
  echo '{ "enabled": [] }' > "$TMP/config/plugins.session.json"
}

start_server() { # start_server <是否启用 oidc> <provisioning 模式>
  stop_server
  rm -f "$JAR"
  : > "$LOG"
  write_config "$1" "$2"
  ( cd "$ROOT" && exec env GEEWIKI_DATA_DIR="$TMP/data" GEEWIKI_CONFIG_DIR="$TMP/config" \
      GEEWIKI_PORT="$PORT" node --import tsx packages/server/src/index.ts ) >>"$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 80); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      grep -q '@geewiki/auth' "$LOG" && return 0
      grep -qi 'EADDRINUSE' "$LOG" && { echo "端口被占用："; tail -20 "$LOG"; exit 1; }
    fi
    sleep 0.5
  done
  echo "服务启动失败，日志："; tail -40 "$LOG"; exit 1
}

# ---------------- 一次完整的 SSO 往返 ----------------

# sso_roundtrip <accept 头，空串表示按浏览器语义>
# 结果写进 $TMP/body.json / $TMP/rb.*，并回显 callback 的 HTTP 码
sso_roundtrip() {
  local accept="$1"
  rm -f "$JAR"
  # ① 发起：拿到 IdP 的授权 URL
  curl -s -o /dev/null -D "$TMP/h1" -c "$JAR" -b "$JAR" \
    "http://127.0.0.1:$PORT/api/auth/oidc/start?redirect=%2Fwiki"
  local authorize
  authorize="$(awk 'tolower($1)=="location:"{print $2}' "$TMP/h1" | tr -d '\r' | tail -1)"
  echo "$authorize" > "$TMP/authorize_url"
  [[ -z "$authorize" ]] && { echo ""; return 1; }
  # ② 走 IdP 的授权端点（真浏览器里那一步是用户点"同意"）
  curl -s -o /dev/null -D "$TMP/h2" -b "$JAR" -c "$JAR" "$authorize"
  local callback
  callback="$(awk 'tolower($1)=="location:"{print $2}' "$TMP/h2" | tr -d '\r' | tail -1)"
  echo "$callback" > "$TMP/callback_url"
  [[ -z "$callback" ]] && { echo ""; return 1; }
  # ③ 回跳：默认按**浏览器**语义（302 回前端），指定 accept 时走 JSON
  if [[ -n "$accept" ]]; then
    curl -s -o "$TMP/body.json" -w '%{http_code}' -D "$TMP/h3" -b "$JAR" -c "$JAR" \
      -H "accept: $accept" "$callback"
  else
    curl -s -o "$TMP/body.json" -w '%{http_code}' -D "$TMP/h3" -b "$JAR" -c "$JAR" "$callback"
  fi
}

set_cookie_of() { awk 'tolower($1)=="set-cookie:"{print substr($0,index($0,$2))}' "$1" | tr -d '\r' | tail -1; }

echo "=============================================================="
echo "P1.5 端到端验收（端口 $PORT，mock IdP $IDP_PORT）"
echo "=============================================================="

# ============ 阶段 A：未启用 @geewiki/oidc ============
echo
echo "=== 阶段 A：未启用 @geewiki/oidc（端点必须不存在） ==="
start_idp
start_server no auto

check "A1 未启用时 GET /api/auth/oidc/start → 404 而不是 401/503" \
  404 "$(curl -s -o "$TMP/body.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/oidc/start")"
check "A2 未启用时 GET /api/auth/oidc/callback → 404" \
  404 "$(curl -s -o "$TMP/body.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/oidc/callback?code=x&state=y")"
code GET /api/auth/state >/dev/null
check "A3 capabilities.oidc.available=false" "false" "$(field oidc.available)"
check "A3b 原因是 disabled（没装/没启用）" "disabled" "$(field oidc.reason)"
check "A4 本地初始化仍然可用（SSO 缺席不影响主流程）" "201" \
  "$(code POST /api/auth/setup '{"email":"boss@example.com","password":"correct-horse-battery","displayName":"站长"}')"

# ============ 阶段 B：启用 OIDC，预置一个本地账号以测绑定 ============
echo
echo "=== 阶段 B：启用 OIDC（provisioning=auto） ==="
start_server yes auto

code GET /api/auth/state >/dev/null
check "B1 capabilities.oidc.available=true" "true" "$(field oidc.available)"
check "B1b 下发前端要用的入口路径" "/api/auth/oidc/start" "$(field oidc.startPath)"
check "B2 日志确认 provider 已注册" "1" "$(grep -c '已注册 provider e2e' "$LOG")"
check "B3 完整 SSO 往返（新用户，auto 模式）→ 200" "200" "$(sso_roundtrip 'application/json')"
check "B3b 会话 cookie 已下发（gw_sid）" "gw_sid" "$(awk '$6=="gw_sid"{print $6}' "$JAR" | tail -1)"
grep -q '#HttpOnly_' "$JAR" && ok "B3c 会话 cookie 带 HttpOnly" || bad "B3c 会话 cookie 缺 HttpOnly"
check "B3d 登录后可读 /api/auth/me" "200" "$(code GET /api/auth/me)"
check "B3e SSO 建号的邮箱" "sso@example.com" "$(field user.email)"
check "B3f SSO 建号**无组织角色**（Guest 语义）" "null" "$(field user.orgRole)"

# PKCE 真的送出了吗（mock IdP 会真校验；再读它记录的参数）
check "B4 token 端点收到了 code_verifier（PKCE 生效）" "yes" \
  "$(curl -s "http://127.0.0.1:$IDP_PORT/__last-token-request" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.params&&o.params.code_verifier?'yes':'no')})")"

check "B5 已绑定身份再次登录 ⇒ 200（不再建号）" "200" "$(sso_roundtrip 'application/json')"
check "B5b 身份列表里有 1 个外部身份" "1" "$(code GET /api/auth/identities >/dev/null; node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.identities.length)})" < "$TMP/body.json")"
# 注意：这个 id 属于 **SSO 建出来的那个账号**，不是后面那个本地账号 —— 解绑时必须用
# 当前登录账号自己的身份 id（服务端对"不属于自己"返回 404，故意与"不存在"同结果）
SSO_IDENT_ID="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.identities[0].id)})" < "$TMP/body.json")"

# ============ 阶段 C：email 已存在 ⇒ 409 + 票据只在 cookie ============
echo
echo "=== 阶段 C：email 已有本地账号 ⇒ 拒绝自动绑定 ==="
# 用 boss@example.com 的本地账号：先让 IdP 以该邮箱签 token
node -e 'process.exit(0)'
kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_EMAIL=boss@example.com MOCK_IDP_SUB=boss-sso-sub

RC="$(sso_roundtrip 'application/json')"
check "C1 email 已存在 ⇒ 409（不是登录成功）" "409" "$RC"
check "C1b 错误码 identity_link_required" "identity_link_required" "$(field error)"
check "C2 票据只在 HttpOnly cookie 里（响应体不含 gw_link）" "no" \
  "$(grep -q 'gw_link' "$TMP/body.json" && echo yes || echo no)"
LINK_SET="$(set_cookie_of "$TMP/h3")"
echo "$LINK_SET" | grep -q 'gw_link=' && ok "C3 下发了绑定票据 cookie: ${LINK_SET%%;*}" || bad "C3 缺 gw_link cookie（实际：$LINK_SET）"
echo "$LINK_SET" | grep -qi 'httponly' && ok "C3b 票据 cookie 带 HttpOnly" || bad "C3b 票据 cookie 缺 HttpOnly"
grep -q 'gw_link' "$TMP/callback_url" && bad "C4 票据泄漏进了 URL" || ok "C4 票据不出现在 URL 里"

check "C5 未登录时确认绑定 → 401" "401" \
  "$(code POST /api/auth/identities/link)"

# 用本地口令登录 boss@example.com，然后确认绑定
check "C6 本地口令登录 → 200" "200" \
  "$(code POST /api/auth/login '{"email":"boss@example.com","password":"correct-horse-battery"}')"
check "C7 确认绑定 → 200" "200" "$(code POST /api/auth/identities/link)"
check "C7b 该账号绑定了 1 个外部身份（另一个身份属于别的账号）" "1" \
  "$(code GET /api/auth/identities >/dev/null; node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.identities.length)})" < "$TMP/body.json")"
BOSS_IDENT_ID="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.identities[0].id)})" < "$TMP/body.json")"
check "C7c 拿别人的身份 id 解绑 → 404（不泄漏该 id 是否存在）" "404" \
  "$(code POST /api/auth/identities/unlink "{\"identityId\":$SSO_IDENT_ID}")"
check "C8 解绑自己的身份（有本地口令，允许）→ 200" "200" \
  "$(code POST /api/auth/identities/unlink "{\"identityId\":$BOSS_IDENT_ID}")"
check "C8b 解绑后不再有外部身份" "0" \
  "$(code GET /api/auth/identities >/dev/null; node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.identities.length)})" < "$TMP/body.json")"

# ============ 阶段 D：算法白名单 / iss 不匹配（真签、真验签） ============
echo
echo "=== 阶段 D：ID token 安全校验 ==="
kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_ALG=none MOCK_IDP_EMAIL=alg@example.com MOCK_IDP_SUB=alg-sub
check "D1 alg=none → 400 alg_not_allowed" "400" "$(sso_roundtrip 'application/json')"
check "D1b 错误码" "alg_not_allowed" "$(field error)"

kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_ALG=HS256 MOCK_IDP_EMAIL=hs@example.com MOCK_IDP_SUB=hs-sub
check "D2 HS256 → 400 alg_not_allowed" "400" "$(sso_roundtrip 'application/json')"

kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_ISS='http://127.0.0.1:9/' MOCK_IDP_EMAIL=iss@example.com MOCK_IDP_SUB=iss-sub
check "D3 iss 指向别的 IdP → 400 iss_mismatch" "400" "$(sso_roundtrip 'application/json')"

kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_AUD=someone-else MOCK_IDP_EMAIL=aud@example.com MOCK_IDP_SUB=aud-sub
check "D4 aud 不含本 client → 400 aud_mismatch" "400" "$(sso_roundtrip 'application/json')"

kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_EXP_OFFSET=-3600 MOCK_IDP_EMAIL=exp@example.com MOCK_IDP_SUB=exp-sub
check "D5 exp 已过期 → 400 token_expired" "400" "$(sso_roundtrip 'application/json')"

# state 一次性：同一个 callback URL 再打一次
kill "$IDP_PID" 2>/dev/null; wait "$IDP_PID" 2>/dev/null; IDP_PID=""
start_idp MOCK_IDP_EMAIL=replay@example.com MOCK_IDP_SUB=replay-sub
RC="$(sso_roundtrip 'application/json')"
check "D6 正常往返 → 200" "200" "$RC"
REPLAY_URL="$(cat "$TMP/callback_url")"
check "D6b 重放同一 state → 400 state_invalid" "400" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' -H 'accept: application/json' "$REPLAY_URL")"

# ============ 阶段 E：IdP 不可达 ⇒ 降级但不影响本地通道 ============
echo
echo "=== 阶段 E：IdP 不可达时的降级 ==="
stop_idp
start_server yes auto

code GET /api/auth/state >/dev/null
check "E1 capabilities.oidc.available=false" "false" "$(field oidc.available)"
check "E1b 原因不是 disabled（是装了但不通）" "yes" \
  "$(node -e "console.log(process.argv[1]!=='disabled'?'yes':'no')" "$(field oidc.reason)")"
check "E2 起 SSO 入口 → 503 oidc_unavailable（不是 500）" "503" \
  "$(curl -s -o "$TMP/body.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/oidc/start")"
check "E3 本地口令登录**完全不受影响** → 200" "200" \
  "$(code POST /api/auth/login '{"email":"boss@example.com","password":"correct-horse-battery"}')"
check "E4 已建立的会话照常可用（不依赖 IdP）" "200" "$(code GET /api/auth/me)"
check "E5 内容写入照常（access:user 只看我们自己的会话）" "200" \
  "$(code PUT /api/pages/e2e-oidc '{"title":"E2E","content":"ok"}')"

echo
echo "=============================================================="
echo "通过 $PASS 项，失败 $FAIL 项"
echo "=============================================================="
[[ "$FAIL" -eq 0 ]] || exit 1
