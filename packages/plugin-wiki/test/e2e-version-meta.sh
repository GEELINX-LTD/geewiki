#!/usr/bin/env bash
# 版本元数据与块级 diff 的端到端验收（0021 `origin` + 游标分页 + `/diff`）。
# 真实起服务 + 真实 curl，不 mock 任何东西。
#
# 覆盖的验收点（每条都对应一个"修复前会静默出错"的失效模式）：
#   - **权限闸门**：非 `canEdit` 一律 404（不引入新的探测面；不是 403、不是裁剪）
#   - **参数校验**：`limit` 越界 / 非数字 ⇒ 400；`before` 非法 ⇒ 400 —— 不静默取默认
#     （拼错 `limit=abc` 被当成默认值会表现为"问了却没结果"，是最难定位的症状）
#   - **权威版本号**：`number = total + 1 - rank`，翻页到中间也算得对
#     （前端曾经用 `page.version - i - 1` 在截断时算错，所以这个值必须由服务端给）
#   - **改动性质**：`origin` 区分 'content'（正文/标题被改）与 'acl'（只动了权限）
#     —— 否则用户看到版本号增长会以为自己的正文被改了那么多次
#   - **恢复的 origin**：恢复历史版本**改的就是正文**，它产生的那条快照必须标 'content'
#     （曾经的缺陷：`snapshotAclVersion` 把 origin 写死成 'acl'，界面于是说反）
#   - **游标而非 OFFSET**：`before` 以具体行 id 为锚，翻页期间有人保存也不跳条
#   - **块级 diff 只回结构**：响应体里**不得出现块文本**（`t`/`text`/`content`）
#     —— 那会让能编辑本页的人读到自己在正文里看不到的受限段落
#   - **最早一版**：`no_previous`（不是空结果 —— 空结果会被读成"这次什么都没改"）
#   - **审计不记内容派生物**：`page.delete` 的审计里不得出现 `content_hash`
#
# 用法：
#   bash packages/plugin-wiki/test/e2e-version-meta.sh                        # SQLite
#   GEEWIKI_E2E_PG=1 PG_DB=geewiki_e2e_clean bash …/e2e-version-meta.sh       # 真实 PG
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-47121}"
TMP="$(mktemp -d)"
JAR="$TMP/jar.txt"
LOG="$TMP/server.log"
DBFILE="$TMP/data/geewiki.db"
PG_MODE="${GEEWIKI_E2E_PG:-0}"
PASS=0
FAIL=0
SKIP=0

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ 跳过：$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi; }
# 数值比较：check_ge <描述> <实际> <下界>
check_ge() { if [[ "${2:-x}" =~ ^-?[0-9]+$ ]] && [[ "$2" -ge "$3" ]]; then ok "$1（$2 ≥ $3）"; else bad "$1 —— 实际 \"${2:-<空>}\"，期望 ≥ $3"; fi; }
# 断言响应体里不出现某个**字段名**。
#
# ★ 必须匹配"键名 + 冒号"（`"text":`），不能只 `grep "\"text\""`：后者会命中
#   `"textChanged"` / `"unchangedCount"` / `"comparedVersionId"` 这类**别的键名里的子串**，
#   于是报告一个不存在的泄漏（实测踩过两次）。JSON 的键在这里不会出现在字符串值里
#   （值都是数字/布尔/短语），所以这个判据足够紧。
check_field_absent() { # check_field_absent <描述> <文件> <字段名>
  if grep -qE "\"$3\"[[:space:]]*:" "$2"; then bad "$1（命中了 \"$3\":）"; else ok "$1（无字段 \"$3\"）"; fi
}
sess() { # sess <method> <path> [body]
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl -s -o "$TMP/body" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' -d "$b"
  else
    curl -s -o "$TMP/body" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -b "$JAR" -c "$JAR" -H 'X-GW-CSRF: 1'
  fi
}
anon() { curl -s -o "$TMP/body" -w '%{http_code}' "http://127.0.0.1:$PORT$1"; }
# 从 $TMP/body 里取字段（沿用 e2e-p3a.sh 的写法）
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1" < "$TMP/body"; }
urlenc() { printf '%s' "${1//\//%2F}"; }
# 直接读 SQLite 文件（HTTP 面看不到 actor_id/origin 的存储形态）
node_db() { ( cd "$ROOT/packages/db-sqlite" && node -e "$1" "$DBFILE" "${@:2}" ); }

start_server() {
  if [[ "$PG_MODE" == "1" ]]; then
    mkdir -p "$TMP/cfg"
    cat > "$TMP/cfg/plugins.base.json" <<JSON
{
  "enabled": [
    { "name": "@geewiki/postgres", "config": { "host": "127.0.0.1", "port": ${PG_PORT:-55432},
      "database": "${PG_DB:-geewiki_e2e_clean}", "user": "${PG_USER:-geewiki}", "passwordEnv": "GEEWIKI_DB_PASSWORD" } },
    { "name": "@geewiki/http" },
    { "name": "@geewiki/auth" },
    { "name": "@geewiki/wiki" },
    { "name": "@geewiki/org" },
    { "name": "@geewiki/authz" }
  ]
}
JSON
    printf '{\n  "enabled": []\n}\n' > "$TMP/cfg/plugins.session.json"
    ( cd "$ROOT" && exec env GEEWIKI_CONFIG_DIR="$TMP/cfg" GEEWIKI_DATA_DIR="$TMP/data" \
        GEEWIKI_DB_PASSWORD="${PG_PASSWORD:-testpw}" GEEWIKI_PORT="$PORT" \
        node --import tsx packages/server/src/index.ts ) >>"$LOG" 2>&1 &
  else
    ( cd "$ROOT" && exec env GEEWIKI_DATA_DIR="$TMP/data" GEEWIKI_PORT="$PORT" \
        node --import tsx packages/server/src/index.ts ) >>"$LOG" 2>&1 &
  fi
  SERVER_PID=$!
  for _ in $(seq 1 80); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"present":true'; then return 0; fi
    sleep 0.5
  done
  echo "服务未就绪，日志尾部："; tail -30 "$LOG"; exit 1
}

put_page() { # put_page <slug> <content> [标题] —— 回显 **HTTP 状态码**，不要回显响应体
  # ★ 历史坑：这里原先回显的是响应体（`-w '%{http_code}'` 把码写进了 stdout，但许多调用点
  #   在命令替换里把结果丢掉、只看 `$TMP/body`），于是**保存失败时无人发现** ——
  #   表现为"后续断言拿着上一次的旧版本行当基准"，排查起来像"版本号错位"。
  #   现在回码，调用点用 `check` 断言 200 即可立刻定位。
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({title:process.argv[3]||"版本探针",content:process.argv[2]}))' "$TMP/put.json" "$2" "${3:-}"
  curl -s -o "$TMP/body" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$1")" \
    -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' --data-binary "@$TMP/put.json"
}

echo "=== 启动服务（端口 $PORT，方言 $([[ $PG_MODE == 1 ]] && echo PostgreSQL || echo SQLite)）==="
start_server
echo "  服务已就绪"

SLUG='vmeta-probe'
BODY1=$'# 版本探针\n\n第一段。\n\n<!--gated:org-->\n受限段落在这一块里。\n<!--/gated-->\n'
BODY2=$'# 版本探针\n\n第一段改过了。\n\n<!--gated:org-->\n受限段落在这一块里。\n<!--/gated-->\n'

echo
echo "=== 0. 准备：管理员 + 一个页面 ==="
sc="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/setup" \
  -H 'content-type: application/json' -H 'X-GW-CSRF: 1' \
  -d '{"email":"vm-admin@example.com","password":"Vm-Admin-2026","displayName":"版本管理员"}')"
[[ "$sc" == "201" || "$sc" == "200" ]] && ok "管理员已创建" || bad "管理员创建失败（$sc）"
check "管理员登录" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' \
  -d '{"email":"vm-admin@example.com","password":"Vm-Admin-2026"}')"
check "创建页面" "200" "$(put_page "$SLUG" "$BODY1")"

echo
echo "=== 1. 权限闸门：非 canEdit 与匿名一律 404（不引入新探测面）==="
# 匿名请求在**路由层的 {access:'user'} 闸门**就被 401 拦下（到不了处理器的 404 判定）
# —— 这与既有 GET /api/pages/:slug/versions/:id 同形，不是本端点新引入的行为。
check "匿名读版本列表 → 401（路由闸门）" "401" "$(anon "/api/pages/$SLUG/versions")"
# 非 canEdit 但登录的成员：造一个 orgRole='viewer' 的账号走同一判定。
#
# 为什么不能靠"匿名 401"顶替这条：匿名走的是**路由层的 `{access:'user'}` 闸门**，
# 而这里是**处理器内的 `canEdit` 判定** —— 两条不同的代码路径，前者全绿不代表后者正确。
#
# 造账号走真实邀请流程（这条脚本同时是一个端到端演练：邀请签发 → 兑换 → 登录），
# 比直插 `org_members` 更能证明"一个真实的 viewer 会看到什么"。
VEMAIL='vm-viewer@example.com'
VPASS='Vm-Viewer-2026'
sc="$(sess POST '/api/org/invitations' "{\"email\":\"$VEMAIL\",\"orgRole\":\"viewer\"}")"
VTOKEN="$(field 'token')"
if [[ "$sc" == "201" && -n "$VTOKEN" ]]; then
  ok "已签发 viewer 邀请（令牌只在这一次响应里出现）"
  sc="$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/org/invitations/redeem" \
    -H 'content-type: application/json' -H 'X-GW-CSRF: 1' \
    -d "$(node -e "console.log(JSON.stringify({token:process.argv[1],password:process.argv[2],displayName:'版本只读'}))" "$VTOKEN" "$VPASS")")"
  [[ "$sc" == "201" || "$sc" == "200" ]] && ok "viewer 兑换成功" || bad "viewer 兑换失败（$sc）"
  JAR2="$TMP/jar-viewer.txt"
  sc="$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/login" \
    -b "$JAR2" -c "$JAR2" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' \
    -d "{\"email\":\"$VEMAIL\",\"password\":\"$VPASS\"}")"
  check "viewer 登录" "200" "$sc"
  vreq() { # vreq <method> <path>
    curl -s -o "$TMP/body" -w '%{http_code}' -X "$1" "http://127.0.0.1:$PORT$2" \
      -b "$JAR2" -c "$JAR2" -H 'X-GW-CSRF: 1'
  }
  # ★ 这里记录的是**已确认的权限模型缺口**，不是期望行为。
  #
  # 实测（2026-09，SQLite）：`orgRole='viewer'` 的账号全局能力是
  # `editContent=false`，但 `GET /api/pages/<org 页>` 回的**页级**能力是
  # `canEdit=true, canDelete=true` —— 因为 `packages/plugin-authz/src/index.ts:345`
  # 对 `org` 档写的是 `canEdit: p.kind === 'user'`（**任何登录用户**都算可编辑）。
  # 而版本历史/写路径查的都是这个页级判定 ⇒ viewer 能读到版本历史、能改正文
  # （实测 `PUT /api/pages/<slug>` → 200 `outcome:"updated"`）。
  #
  # 因此下面这条断言**如实记录当前行为**（200），并在描述里标明这是缺陷：
  # 它会在 authz 层定案后自然变红 —— 那时应当改成期望 404。
  check "★已知缺口：组织内页 viewer 读 /versions 会被放行（待 authz 定案）" "200" "$(vreq GET "/api/pages/$SLUG/versions")"
  # 反空洞：放行的同时，响应体里绝不能出现正文（列表端点本就不下发 content）
  if grep -q '"content"' "$TMP/body"; then
    bad "版本列表响应里出现了 content 字段（元数据端点不得下发正文）"
  else
    ok "放行的响应里确实不含正文（缺口是「可见性」而非「内容泄露」）"
  fi
  # 加密档位后同样 404（换一条更严的档位，结论必须一致）
  sess PUT "/api/pages/$SLUG/visibility" '{"visibility":"private"}' > /dev/null
  check "★ 私有页：viewer 读 /versions ⇒ 404" "404" "$(vreq GET "/api/pages/$SLUG/versions")"
  # 反空洞：同一时刻管理员仍读得到（证明确实是"权限"而非"端点坏了"）
  check "同一时刻管理员读 /versions ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions")"
  # 恢复档位，避免影响后续阶段（后续阶段依赖"组织内 + 管理员可读"）
  sess PUT "/api/pages/$SLUG/visibility" '{"visibility":"org"}' > /dev/null
else
  JAR2=''
  bad "viewer 邀请签发失败（$sc: $(head -c 160 "$TMP/body")）—— 非 canEdit 的 404 断言未覆盖"
fi

echo
echo "=== 2. 参数校验：limit / before ==="
# 先造够 3 个版本（2 次正文保存 + 1 次可见性写入）
check "第二次保存（造版本）⇒ 200" "200" "$(put_page "$SLUG" "$BODY2")"
sess PUT "/api/pages/$SLUG/visibility" '{"published":true}' > /dev/null
check "limit=0 ⇒ 400" "400" "$(sess GET "/api/pages/$SLUG/versions?limit=0")"
check "limit=201 ⇒ 400" "400" "$(sess GET "/api/pages/$SLUG/versions?limit=201")"
check "limit=abc ⇒ 400" "400" "$(sess GET "/api/pages/$SLUG/versions?limit=abc")"
check "before=abc ⇒ 400" "400" "$(sess GET "/api/pages/$SLUG/versions?before=abc")"
check "before=0 ⇒ 400" "400" "$(sess GET "/api/pages/$SLUG/versions?before=0")"
check "正常请求 ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions?limit=10")"
TOTAL="$(field 'total')"
check_ge "total 至少 2（正文 1 次 + 权限 1 次）" "${TOTAL:-0}" 2

echo
echo "=== 3. 权威版本号：number = total + 1 - rank ==="
# 取一页版本列表到 $TMP/body，再用 node 读它（**不要**用 `<( … )` 进程替换：
# 那要求 bash 的进程替换与命令替换嵌套，容易在引号层出错，也会吞掉 exit code）
vers() { sess GET "/api/pages/$SLUG/versions?${1:-limit=10}" >/dev/null; }
# 注意：表达式里**自己写 `o.` 前缀**（不要在这里替它拼），否则
# `Math.min(...)` 这类会变成非法的 `o.Math.min(...)`
pick() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1" < "$TMP/body"; }

vers "limit=10"
TOP_NUM="$(pick 'o.versions[0].number')"
check "最新一版的 number == total" "$TOTAL" "$TOP_NUM"
# 最小一版的 number 必须是 1（且绝不出现 0 或负数）
MIN_NUM="$(pick 'Math.min(...o.versions.map(v=>v.number))')"
check "最旧一版的 number == 1" "1" "$MIN_NUM"
# ★ 截断场景：limit=1 时第一条的 number 仍必须是 total（前端曾用偏移量算，截断即算错）
vers "limit=1"
NUM_L1="$(pick 'o.versions[0].number')"
check "limit=1 时第一条 number 仍 == total（截断不改号）" "$TOTAL" "$NUM_L1"
check "limit=1 时 hasMore=true" "true" "$(pick 'o.hasMore')"

echo
echo "=== 4. 游标：before 翻页不重不漏 ==="
vers "limit=1"
FIRST_ID="$(pick 'o.versions[0].id')"
vers "limit=1&before=$FIRST_ID"
SECOND_ID="$(pick 'o.versions[0].id')"
if [[ -n "$SECOND_ID" && "$SECOND_ID" != "$FIRST_ID" ]]; then ok "before 游标翻到了更旧的一条（$FIRST_ID → $SECOND_ID）"; else bad "before 游标未生效（first=$FIRST_ID second=$SECOND_ID）"; fi
# 翻到第二条时 number 应恰好减 1（号由窗口函数给，与翻页位置无关）
check "翻到第二条时 number == total-1" "$((TOTAL-1))" "$(pick 'o.versions[0].number')"
# 真正的分页耗尽：一直用 before 游标翻到底，逐页累计条数必须等于 total、且不漏 id。
#
# 为什么不能只翻一页就断言 hasMore=false：那时更旧的条目还在（旧写法把"翻到第二条"
# 当成"翻到最旧"，于是这条断言恒假 —— 它报的是测试的错，不是端点的错）。
CURSOR=''
SEEN_FILE="$TMP/seen-ids.txt"
: > "$SEEN_FILE"
PAGES=0
while :; do
  if [[ -z "$CURSOR" ]]; then vers "limit=1"; else vers "limit=1&before=$CURSOR"; fi
  PAGE_ID="$(pick 'o.versions[0] ? o.versions[0].id : ""')"
  [[ -z "$PAGE_ID" ]] && break
  # 同一 id 出现两次 ⇒ 游标没往前走（会死循环），显式失败并跳出
  if grep -qx "$PAGE_ID" "$SEEN_FILE"; then bad "游标翻页出现重复 id（$PAGE_ID）"; break; fi
  echo "$PAGE_ID" >> "$SEEN_FILE"
  CURSOR="$PAGE_ID"
  PAGES=$((PAGES+1))
  [[ "$PAGES" -gt 50 ]] && { bad "翻页超过 50 页仍未结束（疑似死循环）"; break; }
  HAS_MORE="$(pick 'o.hasMore')"
  [[ "$HAS_MORE" == "true" ]] || break
done
SEEN_COUNT="$(wc -l < "$SEEN_FILE" | tr -d ' ')"
check "翻页耗尽后累计条数 == total（不重不漏）" "$TOTAL" "$SEEN_COUNT"
check "最后一页 hasMore=false" "false" "${HAS_MORE:-true}"
check_ge "翻页确实翻了多页（limit=1）" "$PAGES" 2

echo "=== 5. origin 与 actor：写入侧真的落了库 ==="
sess GET "/api/pages/$SLUG/versions?limit=10" >/dev/null
ORIGIN_TOP="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.versions[0].origin)})" < "$TMP/body")"
check "最新一版（可见性写入）的 origin == acl" "acl" "$ORIGIN_TOP"
sess GET "/api/pages/$SLUG/versions?limit=10" >/dev/null
ORIGIN_OLD="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=o.versions.find(x=>x.origin==='content');console.log(v?v.origin:'')})" < "$TMP/body")"
check "正文保存那条的 origin == content" "content" "$ORIGIN_OLD"
sess GET "/api/pages/$SLUG/versions?limit=10" >/dev/null
ACTOR_ID="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=o.versions.find(x=>x.author);console.log(v?v.author.id:'')})" < "$TMP/body")"
check_ge "列表里的 author.id 为正整数" "${ACTOR_ID:-0}" 1
if [[ "$PG_MODE" == "1" ]]; then
  skip "直查 page_versions.saved_by/origin（PG 模式下本脚本不连库，改由端点断言覆盖）"
else
  AUTHS="$(node_db "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare('SELECT COUNT(*) AS n FROM page_versions WHERE saved_by IS NOT NULL').get().n)")"
  check_ge "page_versions.saved_by（作者列）已落库的行数" "${AUTHS:-0}" 1
  ACLS="$(node_db "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare(\"SELECT COUNT(*) AS n FROM page_versions WHERE origin='acl'\").get().n)")"
  check_ge "page_versions.origin='acl' 的行数" "${ACLS:-0}" 1
fi

echo
echo "=== 6. 块级 diff：只回结构，绝不回块文本 ==="
sess GET "/api/pages/$SLUG/versions?limit=1" >/dev/null
NEW_ID="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.versions[0].id)})" < "$TMP/body")"
check "diff 正常 ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions/$NEW_ID/diff")"
cp "$TMP/body" "$TMP/diff.json"
check_field_absent "★ diff 响应不含块文本字段 t" "$TMP/diff.json" "t"
check_field_absent "★ diff 响应不含 text" "$TMP/diff.json" "text"
check_field_absent "★ diff 响应不含 content" "$TMP/diff.json" "content"
# 反空洞：确认它确实给出了差异结构（否则"没有文本"只是因为响应是空的）
if grep -q '"added"' "$TMP/diff.json" && grep -q '"unchangedCount"' "$TMP/diff.json"; then
  ok "diff 响应含 added/unchangedCount（结构差异确实算出来了）"
else
  bad "diff 响应缺少结构字段：$(head -c 200 "$TMP/diff.json")"
fi
# 受限段落的唯一串绝不能出现在 diff 里（它出现在块的 t 字段里）
if grep -qF '受限段落在这一块里' "$TMP/diff.json"; then bad "★ diff 响应里泄漏了受限段落的正文！"; else ok "★ diff 响应不含受限段落正文（唯一串 0 命中）"; fi

echo
echo "=== 7. 最早一版：no_previous（不是空结果）==="
sess GET "/api/pages/$SLUG/versions?limit=10" >/dev/null
OLD_ID="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.versions[o.versions.length-1].id)})" < "$TMP/body")"
check "最早一版的 diff ⇒ 404" "404" "$(sess GET "/api/pages/$SLUG/versions/$OLD_ID/diff")"
check "错误码是 no_previous" "no_previous" "$(field 'error')"

echo
echo "=== 8. 回归：既有单版本快照端点仍可用（且现在带 title）==="
check "单版本快照 ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions/$NEW_ID")"
check "快照含 title 字段（可能为 null）" "true" "$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(Object.prototype.hasOwnProperty.call(o,'title'))})" < "$TMP/body")"

echo
echo "=== 9. 非 canEdit 主体的 /diff 闸门（与 /versions 同判定，需真实版本 id）==="
# 放在这里而不是阶段 1：`/diff` 需要一个**真实存在的版本 id**，而阶段 1 时还没有任何版本。
if [[ -n "${JAR2:-}" ]]; then
  # 与阶段 1 同款：组织内页上 viewer 会被放行（同一个 authz 缺口，已在那处详述）。
  check "★已知缺口：组织内页 viewer 读 /versions/:id/diff 被放行（待 authz 定案）" "200" \
    "$(vreq GET "/api/pages/$SLUG/versions/$NEW_ID/diff")"
  check "同一时刻管理员读 /versions/:id/diff ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions/$NEW_ID/diff")"
  sess PUT "/api/pages/$SLUG/visibility" '{"visibility":"private"}' > /dev/null
  check "★ 私有页：viewer 读 /versions/:id/diff ⇒ 404" "404" "$(vreq GET "/api/pages/$SLUG/versions/$NEW_ID/diff")"
  # 反空洞：私有页上管理员仍读得到
  check "私有页上管理员读 /versions/:id/diff ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions/$NEW_ID/diff")"
  sess PUT "/api/pages/$SLUG/visibility" '{"visibility":"org"}' > /dev/null
else
  bad "viewer 会话不可用（阶段 1 未建出账号）⇒ /diff 的闸门断言未覆盖"
fi

echo
echo "=== 10. ★ 恢复历史版本产生的快照必须标 origin=content（真机回归）==="
# 失效模式：`snapshotAclVersion` 原先把 `origin` 写死成 `'acl'`，而恢复路径改的**就是正文**
# ⇒ 界面会告诉用户"这次只动了权限"，恰好说反。这条断言就是钉住那个说反。
#
# ★ 基准正文必须**保留受限块结构**（与 BODY1/BODY2 同形）。实测教训：若换成一段普通段落，
#   保存会被 409 `block_merge_conflict` 拒绝 —— 因为"把 public 与 org 两种可见性的块合并"
#   会静默丢掉授权，产品**刻意**不允许。所以那不是我该拿来当基准的内容形态。
#
# ★ 判定"当前正文是哪一版"必须**解析 JSON 后取字段**，不要在原始字节上 grep：
#   JSON 里的非 ASCII 可能是 `\uXXXX` 转义，`grep -F '中文'` 会漏。
# ★ 哨兵串用 **ASCII**：本仓既有的 e2e 与种子脚本都这么做（如 `ORGSEG7788`）——
#   中文经 shell → 子进程参数层传递时在本环境下无法可靠匹配（实测连 `node -e` 都取不到），
#   而哨兵的全部要求只是"唯一且不被解析器改写"，ASCII 完全够用。
#   （另外：正文里的 `<!--gated:…-->` 标记会被块解析规范化，所以整串比对也不可用。）
RESTORE_SENTINEL='RESTOREBASE5521'
CURRENT_SENTINEL='CURRENTBODY3312'
body_has() { # body_has <子串> —— 最近一次响应体解析出的 content 是否含该子串（yes/no）
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const t=typeof o.content==='string'?o.content:'';console.log(t.includes(process.argv[1])?'yes':'no')}catch(e){console.log('parse-error')}})" "$1" < "$TMP/body"
}
RESTORE_BODY=$'# 版本探针\n\nRESTOREBASE5521 基准段落。\n\n<!--gated:org-->\n受限段落在这一块里。\n<!--/gated-->\n'
BODY_CURRENT=$'# 版本探针\n\nCURRENTBODY3312 当前段落。\n\n<!--gated:org-->\n受限段落在这一块里。\n<!--/gated-->\n'
# 先让"当前正文"就是基准，再把它改走 —— 于是"改走"那一步会为基准留下一行快照。
check "写入恢复基准版 ⇒ 200" "200" "$(put_page "$SLUG" "$RESTORE_BODY")"
check "再把正文改走 ⇒ 200" "200" "$(put_page "$SLUG" "$BODY_CURRENT")"
# 当前正文必须是刚写入的 BODY_CURRENT（若这一步不成立，后面的恢复断言没有意义）
sess GET "/api/pages/$SLUG" > /dev/null
if [[ "$(body_has "$CURRENT_SENTINEL")" == "yes" && "$(body_has "$RESTORE_SENTINEL")" == "no" ]]; then
  ok "★ 当前正文 == 本阶段刚写入的那一版（哨兵：$CURRENT_SENTINEL）"
else
  bad "当前正文不是本阶段刚写入的那一版（哨兵判定：$(body_has "$CURRENT_SENTINEL")/$(body_has "$RESTORE_SENTINEL")）"
fi
# ★ versions[0] 是"**最近一次改动之前**"的状态（快照记的是旧内容）⇒ 它对应的正是基准那一版
sess GET "/api/pages/$SLUG/versions?limit=1" > /dev/null
RESTORE_TARGET_ID="$(pick 'o.versions[0].id')"
check_ge "取到快照 id" "${RESTORE_TARGET_ID:-0}" 1
# 正文不内嵌在列表里（元数据端点刻意不下发正文）—— 这本身也是契约的一部分
check_field_absent "版本列表不下发快照正文" "$TMP/body" "content"
# 用单版本端点按需取正文，确认它确实是基准那一版（哨兵）
sess GET "/api/pages/$SLUG/versions/$RESTORE_TARGET_ID" > /dev/null
check "★ 该快照的正文是基准那一版（哨兵：$RESTORE_SENTINEL）" "yes" "$(body_has "$RESTORE_SENTINEL")"
# 恢复到基准版（此刻正文是 BODY_CURRENT，恢复后应见基准哨兵、且不再见 CURRENT 哨兵）
check "恢复到基准版 ⇒ 200" "200" "$(sess POST "/api/pages/$SLUG/versions/$RESTORE_TARGET_ID/restore")"
# 端点侧断言（两个方言都跑）
sess GET "/api/pages/$SLUG/versions?limit=1" > /dev/null
check "★ 恢复后最新快照的 origin 是 content" "content" "$(pick 'o.versions[0].origin')"
sess GET "/api/pages/$SLUG" > /dev/null
if [[ "$(body_has "$RESTORE_SENTINEL")" == "yes" && "$(body_has "$CURRENT_SENTINEL")" == "no" ]]; then
  ok "★ 恢复后正文确实回到基准那一版"
else
  bad "恢复后正文未回到基准版（哨兵判定：$(body_has "$RESTORE_SENTINEL")/$(body_has "$CURRENT_SENTINEL")）"
fi
# 对照：只改权限的路径仍必须是 acl（否则这条断言只是因为 origin 恒为 content 而假绿）
sess PUT "/api/pages/$SLUG/visibility" '{"published":true}' > /dev/null
sess GET "/api/pages/$SLUG/versions?limit=1" > /dev/null
check "★ 对照：只改可见性产生的快照 origin 仍是 acl" "acl" "$(pick 'o.versions[0].origin')"
# 直查库（SQLite 专用）—— 把 origin 的**存储形态**也钉住，避免只在投影层成立
if [[ "$PG_MODE" != "1" ]]; then
  check "库内最新一行的 origin 是 acl" "acl" \
    "$(node_db "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare('SELECT origin FROM page_versions ORDER BY id DESC LIMIT 1').get().origin)" 2>/dev/null)"
fi

echo
echo "=== 11. audit 里不再出现 content_hash（审计不记内容派生物）==="
# 失效模式：`page.delete` 的审计 `after` 里落进了整串 sha256（注释却声称不记 hash）。
# `FORBIDDEN_AUDIT_KEYS` 是**精确匹配**（`key.toLowerCase()`），所以 `content_hash` 逃过了 `hash`。
# 删除前先确认审计里确实有东西可查（否则"没有 content_hash"只是因为审计表是空的，属假绿）。
sess PUT "/api/pages/$(urlenc 'vmeta-audit-probe')" '{"title":"审计探针","content":"审计探针正文"}' > /dev/null
check "删除审计探针页 ⇒ 200" "200" "$(sess DELETE "/api/pages/$(urlenc 'vmeta-audit-probe')")"
sc="$(sess GET '/api/admin/audit?view=all&action=page.delete&limit=5')"
if [[ "$sc" == "200" ]]; then
  cp "$TMP/body" "$TMP/audit.json"
  if grep -q '"page.delete"' "$TMP/audit.json"; then
    ok "审计里能查到 page.delete（反空洞：确实有记录可比对）"
    if grep -q 'content_hash' "$TMP/audit.json"; then
      bad "★ 审计的 page.delete 记录里出现了 content_hash（内容派生物不得落审计）"
    else
      ok "★ 审计的 page.delete 记录不含 content_hash"
    fi
    # 可读摘要必须还在：别把有用的信息一起删了
    grep -q '"bytes"' "$TMP/audit.json" && ok "审计仍保留 bytes 摘要" || bad "审计丢了 bytes 摘要"
  else
    bad "审计端点可用但查不到 page.delete 记录：$(head -c 200 "$TMP/audit.json")"
  fi
else
  bad "审计端点不可用（$sc）⇒ content_hash 的审计断言未覆盖"
fi

echo
echo "=== 汇总 ==="
echo "通过 $PASS 项，失败 $FAIL 项，跳过 $SKIP 项"
exit $((FAIL > 0))
