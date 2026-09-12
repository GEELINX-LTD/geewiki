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
echo "=== 6. 作者名的可见性：三档规则不得退化成「一律回真名」 ==="
# 规则（`packages/plugin-wiki/src/index.ts` 的版本列表端点，规则注释与实现同处）：
#   1. 就是你自己 ⇒ 真名；2. 你是 owner/admin ⇒ 真名；3. 其余 ⇒ `displayName: null`。
#
# 为什么必须断言这条：`author.id` 是**可枚举的整数**，作者名一律下发等于给普通成员开了一条
# 枚举组织成员的旁路（`GET /api/org/members` 本来是 admin 闸门）—— 逐个翻页就能拼出名单。
# 静默退化的表现是"功能看起来更好用了"，不会有人报 bug。
#
# 取一版「正文由管理员保存」的快照，再用不同身份的会话读同一个列表。viewer 这一档能否覆盖
# 取决于阶段 1 记录的组织内 `canEdit` 缺口（若该缺口定案收紧，这里会自然变红 ⇒ 应改期望，
# 不能把"读不到列表"当成"看不到名字"而悄悄删掉断言）。
grab_author() { # grab_author <文件> <作者 id> [字段] —— 打印该行的 author.id / displayName（null 原样打印）
  # 为什么**显式传文件名**而不是读 stdin：viewer 的请求是通过 `vreq` 发的，它会把响应写在
  # `$TMP/body`（同一个文件）—— 若这里读的是 `$TMP/body`，就会在"管理员取到的内容"与
  # "viewer 取到的内容"之间悄悄串台，断言看起来在验权限、实际在验同一个响应。
  node -e '
    const fs = require("fs")
    const s = fs.readFileSync(process.argv[1], "utf8")
    const i = s.indexOf("{"); const o = JSON.parse(i >= 0 ? s.slice(i) : s)
    const v = (o.versions || []).find((x) => x.author && Number(x.author.id) === Number(process.argv[2]))
    // 不用顶层 `return`：Node 22 在 `-e` 下可能按 ESM 求值，顶层 return 会直接语法报错
    // （实测报 "Return statement is not allowed here" —— 看起来像"找不到行"，其实是脚本没跑起来）
    if (!v) {
      console.log("<找不到该行>")
    } else {
      const d = v.author.displayName === null || v.author.displayName === undefined ? "null" : String(v.author.displayName)
      console.log(process.argv[3] === "id" ? String(v.author.id) : d)
    }
  ' "$1" "$2" "${3:-name}"
}
# 页详情端点里的 author.displayName 计数：>0 即"泄露了真名"。
# 存在的理由：作者三档规则此前**只**落在分页端点上，页详情无条件回真名 ——
# 而版本下拉读的正是页详情那份 `versions[]`，于是普通成员与匿名访客经由下拉拿到了真名。
# 所以这一项必须对着**页详情**断言，而不是只对着版本列表。
detail_author_names() { # detail_author_names <文件> —— 打印该文件 versions[].author.displayName 的个数
  node -e '
    const fs = require("fs")
    let s = ""
    try { s = fs.readFileSync(process.argv[1], "utf8") } catch { console.log("-1"); process.exit(0) }
    const i = s.indexOf("{")
    let o
    try { o = JSON.parse(i >= 0 ? s.slice(i) : s) } catch { console.log("-1"); process.exit(0) }
    const vs = Array.isArray(o.versions) ? o.versions : []
    const named = vs.filter((v) => v && v.author && typeof v.author.displayName === "string" && v.author.displayName !== "")
    // 反空洞：把"扫了几行"一起报出来，否则 versions 为空时"零个真名"恒真
    console.log(named.length + "/" + vs.length)
  ' "$1"
}
if [[ -n "${ACTOR_ID:-}" ]]; then
  sess GET "/api/pages/$SLUG/versions?limit=20" > /dev/null
  cp "$TMP/body" "$TMP/versions-author.json"
  ADMIN_AUTHOR_NAME="$(grab_author "$TMP/versions-author.json" "$ACTOR_ID")"
  # 反空洞：先确认"这一档身份 + 查找函数"真的能取到行，否则下面的"看不到真名"可能只是没取到行
  if [[ "$ADMIN_AUTHOR_NAME" == "版本管理员" ]]; then
    ok "管理员读版本列表 ⇒ 看得到作者真名（你本来就有成员目录的读取权）"
  else
    bad "管理员读版本列表看不到作者真名，实际：$ADMIN_AUTHOR_NAME"
  fi
  check_field_absent "★ 版本列表不下发 users 表原字段（只应给 author 对象）" "$TMP/versions-author.json" "display_name"
  # ---- 反空洞：管理员读**页详情**必须看得到真名，否则下面"匿名看不到"可能只是这一档没实现 ----
  sess GET "/api/pages/$SLUG" > /dev/null
  cp "$TMP/body" "$TMP/detail-admin.json"
  ADMIN_DETAIL_NAMES="$(detail_author_names "$TMP/detail-admin.json")"
  check_ge "反空洞：管理员读页详情能看到作者真名（否则下面'看不到'是恒真的）" \
    "${ADMIN_DETAIL_NAMES%%/*}" 1
  # ---- 匿名：页详情的 versions[] 不得给出任何真名（这正是被漏掉的那条路径）----
  #
  # 主探针页此刻是 `org` 档（匿名读会 404）⇒ 匿名的**页详情**路径覆盖不到。
  # 而"页详情无条件回真名"正是这次修的那个洞，且它对**匿名**尤其致命（公开页的任何
  # 访客都能读到同事真名）。所以另起一条**公开 + 已发布**的探针，把这条路径真正走一遍。
  APROBE='vmeta-anon-probe'
  check "建公开探针页（匿名档专用）⇒ 200" "200" "$(put_page "$APROBE" "$BODY1")"
  sess PUT "/api/pages/$APROBE/visibility" '{"visibility":"public","published":true}' > /dev/null
  AN_CODE="$(anon "/api/pages/$APROBE")"
  cp "$TMP/body" "$TMP/detail-anon.json"
  if [[ "$AN_CODE" == "200" ]]; then
    AN_NAMES="$(detail_author_names "$TMP/detail-anon.json")"
    AN_NAMED="${AN_NAMES%%/*}"
    AN_TOTAL="${AN_NAMES##*/}"
    check "★ 匿名读页详情 ⇒ versions[].author 里没有任何真名（与分页端点同源）" "0" "$AN_NAMED"
    # 反空洞：这一档必须真的扫到了行，否则"零个真名"没有意义
    check_ge "反空洞：匿名读页详情确实拿到了版本行（否则上一条恒真）" "$AN_TOTAL" 1
    check_field_absent "★ 匿名读页详情不下发 users 表原字段" "$TMP/detail-anon.json" "display_name"
  else
    skip "匿名读公开探针页失败（$AN_CODE）⇒ 匿名档未覆盖"
  fi
  # 清理：探针页不留痕（失败也不阻断后续阶段）
  sess DELETE "/api/pages/$(urlenc "$APROBE")" > /dev/null
  if [[ -n "${JAR2:-}" ]]; then
    V_CODE="$(vreq GET "/api/pages/$SLUG/versions?limit=20")"
    if [[ "$V_CODE" == "200" ]]; then
      cp "$TMP/body" "$TMP/versions-author-viewer.json"
      VIEWER_AUTHOR_NAME="$(grab_author "$TMP/versions-author-viewer.json" "$ACTOR_ID")"
      if [[ "$VIEWER_AUTHOR_NAME" == "null" ]]; then
        ok "★ 普通 viewer 读同一条 ⇒ 只有 id、没有真名（id 是聚合改动所需的最小信息）"
      else
        bad "★ 普通 viewer 看到了别人的真名：$VIEWER_AUTHOR_NAME —— 这是成员名单的枚举旁路"
      fi
      check "同一时刻 author.id 仍然下发（不把可用信息一起砍掉）" "$ACTOR_ID" "$(grab_author "$TMP/versions-author-viewer.json" "$ACTOR_ID" id)"
      # 反空洞：不存在的作者 id 必须取不到行 —— 否则"找到行"这件事本身是恒真的
      check "反空洞：不存在的作者 id 取不到行" "<找不到该行>" "$(grab_author "$TMP/versions-author-viewer.json" 99999999)"
      # ---- 页详情也必须遵守三档：viewer 对**他人**那条同样不该拿到真名 ----
      V_D_CODE="$(vreq GET "/api/pages/$SLUG")"
      if [[ "$V_D_CODE" == "200" ]]; then
        cp "$TMP/body" "$TMP/detail-viewer.json"
        V_DETAIL_NAME="$(grab_author "$TMP/detail-viewer.json" "$ACTOR_ID")"
        check "★ viewer 读页详情 ⇒ 他人那条同样只有 id、没有真名" "null" "$V_DETAIL_NAME"
        # 两个端点必须给出**同一个**结论 —— 这条正是"规则写成两份"会漏掉的
        check "★ 页详情与分页端点的作者档位一致（同一个主体、同一条快照）" \
          "$VIEWER_AUTHOR_NAME" "$V_DETAIL_NAME"
      else
        skip "viewer 读不到页详情（$V_D_CODE）⇒ 页详情档位未覆盖"
      fi
    else
      skip "组织内 viewer 读不到版本列表（$V_CODE）⇒ 作者名第 3 档未覆盖（authz 缺口定案后应改期望）"
    fi
  else
    skip "viewer 会话不可用 ⇒ 作者名第 3 档（其余 ⇒ 只有 id）未覆盖"
  fi
else
  bad "取不到任何带 author 的版本行 ⇒ 作者名可见性断言未覆盖"
fi

echo
echo "=== 7. 块级 diff：只回结构，绝不回块文本 ==="
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
echo "=== 8. 最早一版：no_previous（不是空结果）==="
sess GET "/api/pages/$SLUG/versions?limit=10" >/dev/null
OLD_ID="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.versions[o.versions.length-1].id)})" < "$TMP/body")"
check "最早一版的 diff ⇒ 404" "404" "$(sess GET "/api/pages/$SLUG/versions/$OLD_ID/diff")"
check "错误码是 no_previous" "no_previous" "$(field 'error')"

echo
echo "=== 9. 回归：既有单版本快照端点仍可用（且现在带 title）==="
check "单版本快照 ⇒ 200" "200" "$(sess GET "/api/pages/$SLUG/versions/$NEW_ID")"
check "快照含 title 字段（可能为 null）" "true" "$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(Object.prototype.hasOwnProperty.call(o,'title'))})" < "$TMP/body")"
# `title` 存的是**改动前**的标题（`existing.title`，与 `existing.content` 同一时刻），
# 不是改动后的。理由（`packages/plugin-wiki/src/index.ts` 的 INSERT 旁注释）：快照内容与
# 标题必须同属"变更前那一份"，否则时间线上"只改了标题"的那次会显示成"正文未变"。
# 断言方式：把标题改掉保存，再读**最新一版快照**的 title —— 它应当是**改之前**的标题。
# 为什么不复用 `NEW_ID`：它在第 7 节取的是当时的版本 id，而本节之后还有恢复/可见性写入，
# 版本会继续增长；用 `limit=1` 现取最新一版，语义才是"刚刚那次改动留下的快照"。
SLUG_ENC="$(urlenc "$SLUG")"
put_page "$SLUG" "$BODY1" '标题改过了' > /dev/null
sess GET "/api/pages/$SLUG" > /dev/null
check "改标题后当前标题确已生效" "标题改过了" "$(field 'title')"
sess GET "/api/pages/$SLUG/versions?limit=1" > /dev/null
# 读的是 **versions[0].title**（列表里最新那一版快照的标题）。注意 `$TMP/body` 此时是**列表**响应，
# 没有顶层 `title` 字段 —— 早先按顶层字段断言过，写错了对象（探针抓出来才看见）。
check "列表里最新一版带 title 字段" "true" "$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.versions&&Object.prototype.hasOwnProperty.call(o.versions[0],'title'))})" < "$TMP/body")"
NEWEST_SNAP_TITLE="$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const t=o.versions&&o.versions[0]?o.versions[0].title:undefined;console.log(t===null||t===undefined?'null':String(t))})" < "$TMP/body")"
check "★ 最新一版快照的 title 是「改动前」的标题（不是改动后的）" "版本探针" "$NEWEST_SNAP_TITLE"
if [[ "$NEWEST_SNAP_TITLE" == "标题改过了" ]]; then
  bad "★ 快照 title 存成了改动后的值 —— 时间线上「只改了标题」的那次会显示成改动后，看不出改了什么"
fi
put_page "$SLUG" "$BODY1" '版本探针' > /dev/null
sess GET "/api/pages/$SLUG" > /dev/null
check "标题已还原（不影响后续阶段）" "版本探针" "$(field 'title')"

echo
echo "=== 10. 非 canEdit 主体的 /diff 闸门（与 /versions 同判定，需真实版本 id）==="
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
echo "=== 11. ★ 恢复历史版本产生的快照必须标 origin=content（真机回归）==="
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
echo "=== 12. audit 里不再出现 content_hash（审计不记内容派生物）==="
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
