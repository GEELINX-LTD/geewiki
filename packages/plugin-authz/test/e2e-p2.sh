#!/usr/bin/env bash
# P2 端到端验收脚本（组织与条目级可见性）。真实起服务 + 真实 curl，不 mock 任何东西。
#
# 覆盖设计文档 §8.2 的 P2 验收标准里**安全关键**的那几条：
#   - 公开父 + 私有子 ⇒ 匿名 404，且列表不含它
#   - 私有父 + 公开已发布子 ⇒ 匿名仍 404
#   - 改可见性**立即**生效（无 TTL 窗口），且 acl_revision 递增
#   - 检索不泄漏：**FTS 路与短查询 LIKE 路分别验**
#   - 反链不泄漏（受限条目的标题不得经他人的反链出现）
#   - 门户：X-Robots-Tag + 按 cookie 存在性分流的 Cache-Control + Vary: Cookie
#   - /api/plugins 与 /api/session 对匿名不含 config
#   - 新建条目默认 org
#
# 用法：bash packages/plugin-authz/test/e2e-p2.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-43111}"
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

ok() { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi; }

# 匿名请求：返回 "<状态码> <响应体>"
anon() {
  curl -s -o "$TMP/body" -w '%{http_code}' "http://127.0.0.1:$PORT$1"
  echo -n " "; cat "$TMP/body"
}
anon_code() { curl -s -o "$TMP/body" -w '%{http_code}' "http://127.0.0.1:$PORT$1"; }
anon_body() { cat "$TMP/body"; }
# 带会话请求（写操作必须带 CSRF 头）
sess() { # sess <method> <path> [body]
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl -s -o "$TMP/body" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' -d "$b"
  else
    curl -s -o "$TMP/body" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -b "$JAR" -c "$JAR" -H 'X-GW-CSRF: 1'
  fi
  echo -n " "; cat "$TMP/body"
}
# 从 "<状态码> <JSON>" 里取字段（sess/anon 的输出形态就是那样）
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=s.indexOf('{');try{const o=JSON.parse(i>=0?s.slice(i):s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1"; }
# slug 里的 `/` 必须转义成 %2F：slug 是**单个**路由参数，不转义会被切成多段而 404
urlenc() { printf '%s' "${1//\//%2F}"; }

# ★ 方言可切换：默认 SQLite；设 GEEWIKI_E2E_PG=1 则在真实 PostgreSQL 上跑同一套断言。
# PG 用**隔离配置目录**（临时目录）而非改仓库里被跟踪的 config/ —— 插件配置是内联在
# 清单文件 `enabled[]` 条目里的，故指一个临时 GEEWIKI_CONFIG_DIR 就能完全隔离。
start_server() {
  if [[ "${GEEWIKI_E2E_PG:-0}" == "1" ]]; then
    mkdir -p "$TMP/cfg"
    cat > "$TMP/cfg/plugins.base.json" <<JSON
{
  "enabled": [
    { "name": "@geewiki/postgres", "config": { "host": "127.0.0.1", "port": ${PG_PORT:-55432},
      "database": "${PG_DB:-geewiki_test}", "user": "${PG_USER:-geewiki}", "passwordEnv": "GEEWIKI_DB_PASSWORD" } },
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
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"present":true'; then return 0; fi
    sleep 0.5
  done
  echo "服务未就绪，日志尾部："; tail -20 "$LOG"; exit 1
}

echo "=== 启动服务（端口 $PORT）==="
start_server
echo "  服务已就绪"

echo
echo "=== 阶段 A：初始化 owner 并登录取会话 ==="
A=$(sess POST /api/auth/setup '{"email":"owner@example.com","password":"correct-horse-battery"}')
# 幂等：库里已有 owner 时 setup 返回 409，这不是失败 —— 直接走登录。
# （脚本要能在"复用同一个库反复跑"的场景下工作，否则每次都得手工清库。）
A1=$(echo "$A" | awk '{print $1}')
if [[ "$A1" == "201" ]]; then ok "A1 setup 创建首个 owner → 201"
elif [[ "$A1" == "409" ]]; then ok "A1 库中已有 owner（409）—— 跳过 setup，直接登录"
else bad "A1 setup 意外状态码 $A1"; fi
A=$(sess POST /api/auth/login '{"email":"owner@example.com","password":"correct-horse-battery"}')
check "A2 登录 → 200" "200" "$(echo "$A" | awk '{print $1}')"

echo
echo "=== 阶段 B：造数据（公开父 / 私有子 / 独立私有页 / 公开已发布页）==="
U=$(date +%s)
PUB="pub-$U"; SEC="sec-$U"; CHILD="pub-$U/child-$U"
for pair in "$PUB:公开父:公开父的正文，含独特词公开阿尔法。:public:true" \
            "$CHILD:私有子:私有子的正文，含独特词机密奥米克戎。:private:false" \
            "$SEC:独立私有:独立私有的正文，含独特词机密奥米克戎。:private:false"; do
  IFS=':' read -r slug title content vis pub <<<"$pair"
  R=$(sess PUT "/api/pages/$(urlenc "$slug")" "{\"title\":\"$title\",\"content\":\"$content\"}")
  [[ "$(echo "$R" | awk '{print $1}')" == "200" ]] || { bad "创建 $slug 失败: $R"; }
  R=$(sess PUT "/api/pages/$(urlenc "$slug")/visibility" "{\"visibility\":\"$vis\",\"published\":$pub}")
  [[ "$(echo "$R" | awk '{print $1}')" == "200" ]] || { bad "设置 $slug 可见性失败: $R"; }
done
ok "B1 三条数据已创建并设好档位"

echo
echo "=== 阶段 C：新建条目默认可见性必须是 org（不是 private）==="
DEF="def-$U"
sess PUT "/api/pages/$(urlenc "$DEF")" '{"title":"默认档","content":"验证默认可见性。"}' >/dev/null
check "C1 匿名读新建条目 → 404（默认 org = 组织内可见，匿名不是成员）" "404" "$(anon_code "/api/pages/$DEF")"
check "C2 登录成员读同一条 → 200（证明默认档是 org 而非 private）" "200" "$(sess GET "/api/pages/$(urlenc "$DEF")" | awk '{print $1}')"

echo
echo "=== 阶段 D：匿名可见性（公开父 + 私有子 ⇒ 子 404）==="
check "D1 匿名读公开父 → 200" "200" "$(anon_code "/api/pages/$PUB")"
check "D2 匿名读私有子 → **404**（继承取交集）" "404" "$(anon_code "/api/pages/$CHILD")"
check "D3 匿名读独立私有页 → 404" "404" "$(anon_code "/api/pages/$SEC")"
L=$(anon "/api/pages")
if echo "$L" | grep -q "$SEC"; then bad "D4 列表泄漏了受限条目"; else ok "D4 列表不含受限条目"; fi
if echo "$L" | grep -q "$PUB"; then ok "D5 列表含公开条目（反证过滤没把整条路堵死）"; else bad "D5 列表里找不到公开条目"; fi

echo
echo "=== 阶段 E：检索不泄漏（FTS 路 与 短查询 LIKE 路 分别验）==="
if [[ "${GEEWIKI_E2E_PG:-0}" == "1" ]]; then
  # ★ 设计文档 §4.3 的「★ v7：方言语义」：整套分层 FTS 建立在 FTS5 之上，**仅 SQLite 适用**；
  # PG 部署下 `@geewiki/search` 会显式拒绝激活（不是静默恒空）。故这三条在 PG 上 N/A ——
  # 记成"跳过"而不是"通过"，避免把一条从未真正验证过的断言伪装成绿的。
  echo "  ⊘ E1-E3 跳过：本形态的全文检索仅 SQLite 适用（§4.3 v7），PG 下检索插件不激活"
else
  E=$(anon "/api/search?q=%E6%9C%BA%E5%AF%86%E5%A5%A5%E7%B1%B3%E5%85%8B%E6%88%8E")   # 「机密奥米克戎」≥3 字符 → FTS 路
  T=$(echo "$E" | field total)
  check "E1 FTS 路：受限条目唯一词匿名命中数 = 0" "0" "$T"
  E=$(anon "/api/search?q=%E6%9C%BA%E5%AF%86")                                        # 「机密」2 字元 → LIKE 路
  T=$(echo "$E" | field total)
  check "E2 短查询 LIKE 路：受限条目匿名命中数 = 0（**另一条 SQL**）" "0" "$T"
  E=$(anon "/api/search?q=%E5%85%AC%E5%BC%80%E9%98%BF%E5%B0%94%E6%B3%95")            # 「公开阿尔法」→ 公开条目
  T=$(echo "$E" | field total)
  check "E3 反向：公开条目的词仍搜得到" "1" "$T"

fi

echo
echo "=== 阶段 F：反链不泄漏（受限条目不得经他人的反链暴露标题）==="
# 让私有子引用公开父：更新私有子的正文带上 wikilink
sess PUT "/api/pages/$(urlenc "$CHILD")" "{\"title\":\"私有子\",\"content\":\"见 [[$PUB]]，含独特词机密奥米克戎。\"}" >/dev/null
B=$(anon "/api/pages/$(urlenc "$PUB")/backlinks")
if echo "$B" | grep -q "$CHILD"; then bad "F1 反链泄漏了受限条目"; else ok "F1 反链不含受限条目"; fi

echo
echo "=== 阶段 G：改可见性立即生效 + acl_revision 递增（无 TTL 窗口）==="
R=$(sess PUT "/api/pages/$(urlenc "$SEC")/visibility" '{"visibility":"public","published":true}')
REV=$(echo "$R" | field acl_revision)
[[ "$REV" -ge 2 ]] && ok "G1 改档位后 acl_revision 递增（=$REV）" || bad "G1 acl_revision 未递增（=$REV）"
check "G2 发布后匿名立即可读" "200" "$(anon_code "/api/pages/$SEC")"
R=$(sess PUT "/api/pages/$(urlenc "$SEC")/visibility" '{"visibility":"private"}')
check "G3 收回后匿名立即 404（无 TTL 窗口）" "404" "$(anon_code "/api/pages/$SEC")"

echo
echo "=== 阶段 H：例外授予端点可用，且 D13（只有 user|group）==="
R=$(sess POST "/api/pages/$(urlenc "$SEC")/grants" '{"subjectKind":"user","subjectId":"1","role":"viewer"}')
check "H1 授予 user 成功 → 200" "200" "$(echo "$R" | awk '{print $1}')"
R=$(sess POST "/api/pages/$(urlenc "$SEC")/grants" '{"subjectKind":"org_role","subjectId":"member","role":"viewer"}')
check "H2 **拒绝** org_role（D13：角色不是授权对象）" "400" "$(echo "$R" | awk '{print $1}')"
CODE=$(echo "$R" | field error)
check "H3 错误码为 invalid_subject_kind" "invalid_subject_kind" "$CODE"
GID=$(sess GET "/api/pages/$(urlenc "$SEC")/grants" | field 'grants[0]?.id')
[[ -n "$GID" ]] && ok "H4 授权列表可读（id=$GID）" || bad "H4 授权列表为空"
sess DELETE "/api/pages/$(urlenc "$SEC")/grants/$GID" >/dev/null

echo
echo "=== 阶段 I：门户与收录控制（D4）==="
HDRS=$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/portal")
if echo "$HDRS" | grep -qi 'x-robots-tag:.*noindex'; then ok "I1 /portal 带 X-Robots-Tag: noindex"; else bad "I1 缺 X-Robots-Tag"; fi
if echo "$HDRS" | grep -qi 'cache-control:.*public'; then ok "I2 匿名 /portal 走公开缓存"; else bad "I2 匿名缓存头不对"; fi
if echo "$HDRS" | grep -qi 'vary:.*cookie'; then ok "I3 带 Vary: Cookie"; else bad "I3 缺 Vary: Cookie"; fi
BODY=$(curl -s "http://127.0.0.1:$PORT/portal")
if echo "$BODY" | grep -q "$PUB"; then ok "I4 门户列出公开条目"; else bad "I4 门户未列出公开条目"; fi
if echo "$BODY" | grep -q "$SEC"; then bad "I5 门户泄漏了受限条目"; else ok "I5 门户不含受限条目"; fi
HDRS=$(curl -s -D - -o /dev/null -H 'Cookie: gw_sid=anything' "http://127.0.0.1:$PORT/portal")
if echo "$HDRS" | grep -qiE 'cache-control:.*(private|no-store)'; then ok "I6 带任意 gw_sid 即降级为 private/no-store（判存在性不判有效性）"; else bad "I6 带 cookie 时缓存头未降级"; fi
RB=$(curl -s "http://127.0.0.1:$PORT/robots.txt")
if echo "$RB" | grep -q 'Disallow: /'; then ok "I7 robots.txt 全站 Disallow"; else bad "I7 robots.txt 不对"; fi
SM=$(curl -s "http://127.0.0.1:$PORT/sitemap.xml")
if echo "$SM" | grep -q "$PUB" && ! echo "$SM" | grep -q "$SEC"; then ok "I8 sitemap 与匿名可见集合一致"; else bad "I8 sitemap 与可见集合不一致"; fi

echo
echo "=== 阶段 J：config 回显脱敏（§8.2 P2 第 14 条）==="
P=$(anon "/api/plugins")
if echo "$P" | grep -q '"config"'; then bad "J1 /api/plugins 对匿名仍回显 config"; else ok "J1 /api/plugins 匿名不含 config"; fi
S=$(anon "/api/session")
if echo "$S" | grep -q '"config"'; then bad "J2 /api/session 对匿名仍回显 config（第二条通道）"; else ok "J2 /api/session 匿名不含 config"; fi
# 反向：登录的 owner **应当**看得到 config（否则管理台配置表单无法回填）
P2R=$(sess GET /api/plugins)
if echo "$P2R" | grep -q '"config"'; then ok "J3 已登录 owner 仍能看到 config（管理台表单可用）"; else bad "J3 owner 也拿不到 config"; fi

echo
echo "=== 阶段 K：未登录写操作受限 ==="
check "K1 匿名改可见性 → 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$PUB")/visibility" -H 'content-type: application/json' -d '{"visibility":"public"}')"
check "K2 带 cookie 但缺 CSRF 头 → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$PUB")/visibility" -b "$JAR" -H 'content-type: application/json' -d '{"visibility":"public"}')"

echo
echo "==================================="
echo "通过 $PASS 项，失败 $FAIL 项"
[[ "$FAIL" -eq 0 ]] || exit 1
