#!/usr/bin/env bash
# P3a 端到端验收脚本（块模型 + 分层检索 + 一致性探针 + tier 重算扇出）。
# 真实起服务 + 真实 curl，不 mock 任何东西。
#
# 覆盖设计文档 §8.2 的 P3a 验收标准里**安全关键**的那几条：
#   - 含受限块的条目：**匿名读到的响应体里不含受限片段的任何字符**（唯一字符串 + 全文 grep = 0）
#   - 占位文案与片段计数存在，且**不含块内容**
#   - 检索不泄漏：**FTS 路与短查询 LIKE 路分别验**（后者用 2 字元中文词 —— 它走完全不同的 SQL）
#   - **改写不残留**：受限块 A→B 后，匿名搜 A 与 B 均 0，有权限者搜 B 命中
#   - **高亮非空且含命中词**（不能用 FTS5 的 snippet()：它在 contentless 表上静默返回 null）
#   - **存量回填**：只有 pages 行、没有 blocks 行的历史内容，激活后能被搜到且按 tier 正确遮蔽
#   - **一致性探针**返回 {mismatched:0,tier_mismatched:0} / {missing:0,extra:0}
#   - **tier 重算扇出**：页面档位一变，本页与**整棵子树**的 blocks.tier 都要跟着变
#     （不重算是**内容泄漏级**缺陷：读路径 404 而检索命中并吐出正文片段）
#   - 旧标记 `<!--gated:role=editor-->` 被显式拒绝
#
# ⚠️ 方言语义（设计文档 §4.3 ★v7）：`blocks_fts` 是 FTS5，**仅 SQLite 适用**。
#    在 PostgreSQL 下 `@geewiki/search` 不激活（显式方言守卫），故所有检索相关断言
#    标为 ⊘ 跳过而不是"通过" —— 把从未验证过的断言伪装成绿的比不验更糟。
#
# 用法：
#   bash packages/plugin-wiki/test/e2e-p3a.sh                   # SQLite（默认）
#   GEEWIKI_E2E_PG=1 PG_DB=geewiki_e2e_clean bash …/e2e-p3a.sh  # 真实 PostgreSQL 15
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-47111}"
TMP="$(mktemp -d)"
JAR="$TMP/jar.txt"
LOG="$TMP/server.log"
DBFILE="$TMP/data/geewiki.db"
PASS=0
FAIL=0
SKIP=0

PG_MODE=0
[[ "${GEEWIKI_E2E_PG:-0}" == "1" ]] && PG_MODE=1

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
# 明确标注"跳过"：用于 §4.3 方言语义下不存在的路径（PG 下没有 FTS5）
skip() { SKIP=$((SKIP+1)); echo "  ⊘ 跳过：$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi; }
# 断言"响应体里不含/含有某个字符串"（唯一字符串探针 —— 比断言字段存在强得多）
check_absent() { # check_absent <描述> <文件> <串>
  if grep -qF "$3" "$2"; then bad "$1 —— 响应体里**出现了** $3"; else ok "$1（未出现 $3）"; fi
}
check_present() { # check_present <描述> <文件> <串>
  if grep -qF "$3" "$2"; then ok "$1（含 $3）"; else bad "$1 —— 响应体里**没有** $3"; fi
}
# 数值比较：check_ge <描述> <实际> <下界>
check_ge() { if [[ "${2:-x}" =~ ^[0-9]+$ ]] && [[ "$2" -ge "$3" ]]; then ok "$1（$2 ≥ $3）"; else bad "$1 —— 实际 \"${2:-<空>}\"，期望 ≥ $3"; fi; }

anon()      { curl -s -o "$TMP/body" -w '%{http_code}' "http://127.0.0.1:$PORT$1"; }
anon_save() { anon "$1" > "$TMP/code"; cp "$TMP/body" "$TMP/body.saved"; }
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
}
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1" < "$TMP/body"; }
# slug 里的 `/` 必须转义成 %2F —— slug 是**单个**路由参数，不转义会被切成多段而 404
urlenc() { printf '%s' "${1//\//%2F}"; }
# 查询串里的非 ASCII 必须百分号编码：curl 直接发原始 UTF-8 会被 HTTP 层以 400 拒掉
qenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
# 直接读写 SQLite 文件（用于造"存量数据"与验证 tier —— HTTP 面看不到 tier）
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
    { "name": "@geewiki/authz" },
    { "name": "@geewiki/search" }
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
  # ★ 必须轮询到 "present":true —— http 就绪即返回 200，而迁移可能还没跑完
  for _ in $(seq 1 80); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"present":true'; then return 0; fi
    sleep 0.5
  done
  echo "服务未就绪，日志尾部："; tail -30 "$LOG"; exit 1
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 40); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
  # 必须等端口真正释放，否则新进程绑定失败而健康检查会连上旧进程（这个坑发生过）
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || break
    sleep 0.25
  done
}

put_page() { # put_page <slug> <content> [标题]
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({title:process.argv[3]||"P3a 演示页",content:process.argv[2]}))' "$TMP/put.json" "$2" "${3:-}"
  curl -s -o "$TMP/body" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$1")" \
    -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' --data-binary "@$TMP/put.json"
}
set_vis() { # set_vis <slug> <json>
  curl -s -o "$TMP/body" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$1")/visibility" \
    -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' -d "$2"
}

echo "=== 启动服务（端口 $PORT，方言 $([[ $PG_MODE == 1 ]] && echo PostgreSQL || echo SQLite)）==="
start_server
echo "  服务已就绪"

# 唯一字符串探针 —— 每个都只在**一处**出现，故"响应体里有没有它"就是精确的泄漏判据
PUB1='AAA111'      # 公开段
GATED1='BBB222'    # 受限段（org 档）
GATED2CN='拓扑'     # 2 字元中文，**只出现在受限段** ⇒ 专门用来打 LIKE 短查询路
GATED3='DDD444'    # 改写后的受限段
LEGACY='EEE555'    # 存量回填页的受限段
SUB='YYY888'       # 子树测试用

echo
echo "=== 阶段 A：初始化 owner 并登录取会话 ==="
A=$(sess POST /api/auth/setup '{"email":"owner@example.com","password":"correct-horse-battery"}')
A1=$(echo "$A" | awk '{print $1}')
if [[ "$A1" == "201" ]]; then ok "A1 setup 创建首个 owner → 201"
elif [[ "$A1" == "409" ]]; then ok "A1 库中已有 owner（409）—— 直接登录"
else bad "A1 setup 意外状态码 $A1"; fi
A=$(sess POST /api/auth/login '{"email":"owner@example.com","password":"correct-horse-battery"}')
check "A2 登录 → 200" "200" "$(echo "$A" | awk '{print $1}')"

echo
echo "=== 阶段 B：写入含受限块的条目，匿名读到的正文必须是投影后的 ==="
CONTENT=$(cat <<'MD'
公开段落 AAA111 任何人都能看。

<!--gated:org-->
内部细节 BBB222 拓扑 与密钥轮换流程
<!--/gated-->

尾部公开 CCC333
MD
)
check "B1 写入条目 → 200" "200" "$(put_page p3a-gated "$CONTENT")"
check "B2 设为 public 并发布 → 200" "200" "$(set_vis p3a-gated '{"visibility":"public","published":true}')"

anon_save /api/pages/p3a-gated
check "B3 匿名读条目 → 200" "200" "$(cat "$TMP/code")"
check_present "B4 公开段落可见" "$TMP/body.saved" "$PUB1"
# ★ 本脚本最强的一条断言：受限段的任何字符都不得出现在响应体里
check_absent  "B5 受限段未泄漏（唯一字符串全文 grep）" "$TMP/body.saved" "$GATED1"
check_absent  "B6 受限段的 2 字元中文未泄漏" "$TMP/body.saved" "$GATED2CN"
check_present "B7 有显式占位文案" "$TMP/body.saved" "此处有 1 段内容需登录查看"

sess GET /api/pages/p3a-gated >/dev/null
check_present "B8 有权限者（owner）能读到受限段" "$TMP/body" "$GATED1"

echo
echo "=== 阶段 C：检索隔离 —— FTS 路与短查询 LIKE 路分别验 ==="
if [[ "$PG_MODE" == "1" ]]; then
  skip "C1-C7 全部：PG 下 @geewiki/search 显式拒绝激活（§4.3 ★v7：该 FTS 形态仅 SQLite 适用）"
else
  Q_CN=$(qenc "$GATED2CN")
  S=$(anon "/api/search?q=$GATED1")
  check "C1 匿名搜受限段词 → 200" "200" "$(echo "$S" | awk '{print $1}')"
  check "C2 匿名搜受限段词 total=0（FTS 路）" "0" "$(echo "$S" | field total)"
  check "C2b 走的是 FTS 路" "fts" "$(echo "$S" | field mode)"

  S=$(anon "/api/search?q=$Q_CN")
  check "C3 匿名搜 2 字元中文（LIKE 路）total=0" "0" "$(echo "$S" | field total)"
  check "C3b 走的是 LIKE 路" "like" "$(echo "$S" | field mode)"

  sess GET "/api/search?q=$GATED1" >/dev/null
  check_ge "C4 有权限者搜受限段词 total≥1" "$(field total)" 1

  sess GET "/api/search?q=$Q_CN" >/dev/null
  check_ge "C5 有权限者搜 2 字元中文 total≥1" "$(field total)" 1
  # 高亮：不能只断言"字段存在"（null 也存在），必须断言**非空且含命中词**
  SNIP=$(field 'hits[0].snippet')
  if [[ -n "$SNIP" && "$SNIP" == *"$GATED2CN"* ]]; then
    ok "C6 高亮非空且含命中词"
  else
    bad "C6 高亮为空或不含命中词 —— 实际 \"$SNIP\"（snippet() 在 contentless 表上会静默返回 null）"
  fi

  sess GET "/api/search?q=$PUB1" >/dev/null
  check_ge "C7 匿名搜公开段落词 total≥1（未过度遮蔽）" "$(field total)" 1
fi

echo
echo "=== 阶段 D：改写受限段后，旧文本不得残留在索引里 ==="
if [[ "$PG_MODE" == "1" ]]; then
  skip "D1-D4 全部：同上（检索仅 SQLite）"
else
  CONTENT2=$(cat <<'MD'
公开段落 AAA111 任何人都能看。

<!--gated:org-->
内部细节 DDD444 拓扑 与密钥轮换流程
<!--/gated-->

尾部公开 CCC333
MD
)
  check "D0 改写条目 → 200" "200" "$(put_page p3a-gated "$CONTENT2")"
  check "D1 匿名搜旧词 total=0" "0" "$(anon "/api/search?q=$GATED1" | field total)"
  check "D2 匿名搜新词 total=0" "0" "$(anon "/api/search?q=$GATED3" | field total)"
  sess GET "/api/search?q=$GATED1" >/dev/null
  check "D3 有权限者搜旧词 total=0（索引里旧词元已清）" "0" "$(field total)"
  sess GET "/api/search?q=$GATED3" >/dev/null
  check_ge "D4 有权限者搜新词 total≥1" "$(field total)" 1
fi

echo
echo "=== 阶段 E：旧标记必须被显式拒绝（不得静默按 public 暴露） ==="
LEGACYBODY=$(node -e 'process.stdout.write(JSON.stringify({title:"旧标记页",content:"公开 EEE555 之外还有一段\n\n<!--gated:role=editor-->\n不该被当成公开的内容\n<!--/gated-->\n"}))')
E=$(sess PUT /api/pages/p3a-legacy-marker "$LEGACYBODY")
E1=$(echo "$E" | awk '{print $1}')
if [[ "$E1" == "200" ]]; then
  bad "E1 旧标记被接受了（$E1）—— 必须显式拒绝，静默按 public 暴露是泄漏"
elif [[ "$E1" == "400" ]]; then
  # 400 而不是 500：这是**用户输入问题**，调用方要能按机器码判别
  check "E1b 错误码是可判别的 gated_marker_removed" "gated_marker_removed" "$(field error)"
else
  bad "E1 旧标记被拒绝了，但状态码是 $E1（应为 400 —— 用户输入问题不该报成服务器故障）"
fi
anon_save /api/pages/p3a-legacy-marker
check_absent "E2 被拒的正文没有落库" "$TMP/body.saved" "不该被当成公开的内容"

echo
echo "=== 阶段 F：一致性探针 ==="
sess GET /api/admin/blocks/verify >/dev/null
check "F1 blocks/verify mismatched=0" "0" "$(field mismatched)"
check "F1b blocks/verify unparseable=0" "0" "$(field unparseable)"
check "F1c blocks/verify tier_mismatched=0" "0" "$(field tier_mismatched)"
check_ge "F1d tier 检查确实跑了（tier_checked≥1，否则上一条是假绿）" "$(field tier_checked)" 1
check "F1e tier 检查未被跳过" "false" "$(field tier_check_skipped)"

if [[ "$PG_MODE" == "1" ]]; then
  # 检索插件在 PG 下**整体不激活**（显式方言守卫）⇒ 它注册的路由不存在。
  # 注意这与"端点存在但报 index=absent"不同 —— 后者只在 SQLite 下索引被手工删掉时出现。
  check "F2p PG 下 search/verify 不存在（404，因为 @geewiki/search 未激活）" "404" "$(anon /api/admin/search/verify)"
  skip "F2-F3：PG 下检索插件不激活，索引行数与缺漏无从谈起"
else
  sess GET /api/admin/search/verify >/dev/null
  check "F2 search/verify missing=0" "0" "$(field missing)"
  check "F2b search/verify extra=0" "0" "$(field extra)"
  check "F2c search/verify tier_mismatch=false" "false" "$(field tier_mismatch)"
  check "F2d search/verify 抽样命中无 miss" "0" "$(field sample_misses)"
  check_ge "F3 探针至少抽样了 1 个块（否则上面那条是假绿）" "$(field sampled)" 1
fi

A1=$(anon /api/admin/blocks/verify);  check "F4 匿名访问 blocks/verify → 401" "401" "$A1"
if [[ "$PG_MODE" == "1" ]]; then
  # PG 下该路由根本不存在，故是 404 而不是 401 —— 两者都不是"泄漏"，但含义不同
  check "F5 PG 下匿名访问 search/verify → 404（路由不存在）" "404" "$(anon /api/admin/search/verify)"
else
  A1=$(anon /api/admin/search/verify);  check "F5 匿名访问 search/verify → 401" "401" "$A1"
fi

echo
echo "=== 阶段 G：tier 重算扇出 —— 页面档位一变，本页与整棵子树的 tier 都要跟着变 ==="
if [[ "$PG_MODE" == "1" ]]; then
  skip "G：本阶段直接读写 SQLite 文件核对 tier，PG 下需另写 psql 路径（未做）"
else
  R1=$(set_vis p3a-gated '{"visibility":"org"}')
  check "G1 收回成 org → 200" "200" "$R1"
  check "G2 本页块 tier 立刻回到 1（收紧必须即时生效）" "1" "$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const r=db.prepare("SELECT b.tier t FROM blocks b JOIN pages p ON p.id=b.page_id WHERE p.slug=?").get("p3a-gated");process.stdout.write(String(r.t))')"
  check "G3 收紧后匿名搜不到该页（回归守卫：这条以前是 total=1 且吐片段）" "0" "$(anon "/api/search?q=$PUB1" | field total)"

  # 子树：三种深度，验证扇出不是只作用于本页
  put_page p3a-sub "$SUB 子树测试" >/dev/null
  put_page p3a-sub/child "$SUB 子树测试" >/dev/null
  put_page p3a-sub/child/grand "$SUB 子树测试" >/dev/null
  R2=$(set_vis p3a-sub '{"visibility":"public","published":true}')
  check "G4 发布父页 → 200" "200" "$R2"
  check_ge "G5 扇出确实触到了子孙（index_tiers_resynced≥2）" "$(field index_tiers_resynced)" 2
  check_ge "G6 公开子树对匿名可搜" "$(anon "/api/search?q=$SUB" | field total)" 1
  R3=$(set_vis p3a-sub '{"visibility":"org"}')
  check "G7 收回父页 → 200" "200" "$R3"
  check "G8 收回后整棵子树对匿名不可搜（扇出的收紧生效）" "0" "$(anon "/api/search?q=$SUB" | field total)"
fi

echo
echo "=== 阶段 H：探针的**反空洞**测试 —— 故意把 tier 改错，探针必须报出来 ==="
if [[ "$PG_MODE" == "1" ]]; then
  skip "H：同上（需直接改 SQLite 文件）"
else
  stop_server
  # ★ 两处假绿在这里被修掉（审查指出）：
  #   ① 原实现断言的是"此刻 `tier = 0` 的行数" —— 只要库里本就存在**合法的** `tier = 0` 块
  #      （例如已发布的公开页），即便那条 UPDATE 一行都没改到也会 ≥1 ⇒ 前置断言假绿。
  #      改为按 `run()` 返回的 **`changes`（实际改动行数）** 断言。
  #   ② 还原时用 `UPDATE ... SET tier = 1 WHERE tier = 0` —— 只在"此刻所有块恰好都该是
  #      tier=1"时才正确，否则会把本来就该是 0 的块也改成 1（把测试污染成另一种不一致）。
  #      改为**记录确切行 id**、按记录逐行还原。
  node_db 'const D=require("better-sqlite3");const fs=require("node:fs");const p=process.argv[1];const db=new D(p);const ids=db.prepare("SELECT id FROM blocks WHERE tier = 1").all().map(r=>r.id);fs.writeFileSync(process.argv[2],JSON.stringify(ids));const info=db.prepare("UPDATE blocks SET tier = 0 WHERE tier = 1").run();process.stdout.write(JSON.stringify({tier1:ids.length,changed:info.changes}))' "$TMP/tierbak.json" > "$TMP/body"
  check_ge "H0 前置：确实存在 tier=1 的块可供改错（否则本阶段是空转）" "$(field tier1)" 1
  check_ge "H1 已人为把若干块的 tier 改错（按**实际改动行数**计，而非此刻 tier=0 的行数）" "$(field changed)" 1
  start_server
  sess GET /api/admin/blocks/verify >/dev/null
  check_ge "H2 探针报出 tier_mismatched>0（证明它不是摆设）" "$(field tier_mismatched)" 1
  check "H2b 而块↔正文那一项仍然为 0（两类不一致能分开看）" "0" "$(field mismatched)"
  stop_server
  node_db 'const D=require("better-sqlite3");const fs=require("node:fs");const p=process.argv[1];const db=new D(p);const ids=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const st=db.prepare("UPDATE blocks SET tier = 1 WHERE id = ?");db.transaction(()=>{for(const id of ids) st.run(id)})()' "$TMP/tierbak.json"
  start_server
  sess GET /api/admin/blocks/verify >/dev/null
  check "H3 按记录逐行还原后探针恢复 0" "0" "$(field tier_mismatched)"
fi

echo
echo "=== 阶段 I：存量回填 —— 只有 pages 行、没有 blocks 行的历史内容 ==="
if [[ "$PG_MODE" == "1" ]]; then
  skip "I：需直接写 SQLite 文件造历史数据，PG 下需另写 psql 路径（未做）"
else
  stop_server
  node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const now=new Date().toISOString();
    db.prepare("INSERT INTO pages (slug,title,content,created_at,updated_at,visibility,inherit,acl_revision,content_hash,published_at) VALUES (?,?,?,?,?,?,1,0,NULL,?)")
      .run("p3a-legacy-page","历史页","历史公开段 FFF666\n\n<!--gated:org-->\n历史受限段 EEE555 拓扑\n<!--/gated-->\n",now,now,"public",now);' >/dev/null
  check "I0 造出的历史页确实没有 blocks 行（否则证明不了回填干活）" "blocks=0" "$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const n=db.prepare("SELECT COUNT(*) n FROM blocks WHERE page_id=(SELECT id FROM pages WHERE slug=?)").get("p3a-legacy-page").n;process.stdout.write("blocks="+n)')"

  start_server
  sess GET "/api/search?q=$LEGACY" >/dev/null
  check_ge "I1 回填后能被检索到（有权限者）" "$(field total)" 1
  check "I2 回填后受限段对匿名仍搜不到" "0" "$(anon "/api/search?q=$LEGACY" | field total)"

  anon_save /api/pages/p3a-legacy-page
  check_present "I3 历史页的公开段可读" "$TMP/body.saved" "FFF666"
  check_absent  "I4 历史页的受限段未泄漏" "$TMP/body.saved" "$LEGACY"

  sess GET /api/admin/blocks/verify >/dev/null
  check "I5 回填后 blocks/verify 仍全 0（回填写出了一致的块与 tier）" "0" "$(field mismatched)"
  check "I5b 回填后 tier_mismatched 仍为 0" "0" "$(field tier_mismatched)"
fi

echo
echo "=== 阶段 K：tier 扇出的另外两条顺序 —— 新建祖先 / 删除断链点 ==="
# 为什么必须有这一段：阶段 G **只覆盖"改档位"**这一个顺序。审查实测复现了两条同类泄漏，
# 而当时的 e2e 是**全绿**的 —— 因为 G 走的是唯一做了扇出的那条路径。
# 两条都先断言"前置状态是能读到"，否则后面的"遮蔽了"可能是假绿（本来就读不到）。
if [[ "$PG_MODE" == "1" ]]; then
  skip "K：直接读写 SQLite 文件核对 tier，PG 下需另写 psql 路径（未做）"
else
  # ---- K1：**新建祖先**——新页成为已有页的祖先，子孙有效档位被收紧，而它们的 tier 不会自己变 ----
  #
  # ⚠️ 标记为什么要比查询串**长**：检索响应里有 `query: q`（**回显查询串**），
  #    所以"整串 grep 查询词"必然命中 —— 那是假阳性，不是泄漏。这里用
  #    查询 `KKK777` + 内容标记 `KKK777LEAK`：回显的只是前者，后者只可能来自泄漏。
  KID='KKK777'
  KLK="${KID}LEAK"
  put_page k1/child "子页正文 $KLK" >/dev/null
  check "K1 子页设为 public + 已发布 → 200" "200" "$(set_vis k1/child '{"visibility":"public","published":true}')"
  check "K2 前置：此刻匿名**读得到**子页（否则后面的 404 可能是假绿）" "200" "$(anon "/api/pages/k1%2Fchild")"
  check_ge "K3 前置：此刻匿名**搜得到**子页（唯一词命中）" "$(anon "/api/search?q=$KID" | field total)" 1
  # ★ 新建父页（默认 org）—— 它成为子页的祖先
  put_page k1 "父页正文" >/dev/null
  check "K4 匿名读子页被遮蔽（404）" "404" "$(anon "/api/pages/k1%2Fchild")"
  anon "/api/search?q=$KID" >/dev/null
  cp "$TMP/body" "$TMP/k1.search"
  check "K5 匿名搜**同时**被遮蔽（total=0）" "0" "$(field total)"
  check_absent "K6 且检索响应体里不含内容标记（不是只改了计数）" "$TMP/k1.search" "$KLK"

  # ---- K2：**删除断链点**——更上层更严的祖先重新开始压制子孙 ----
  # 策略层 `effectiveRank` 对"祖先不存在"是 continue、对"inherit !== 1"才是 break；
  # 那个不对称是**刻意的语义**，要验的是"档位变了，物化的 tier 要跟着变"。
  DID='DDD999'
  DLK="${DID}LEAK"
  put_page k2 "父页正文" >/dev/null
  put_page k2/mid "断链点" >/dev/null
  put_page k2/mid/deep "深层正文 $DLK" >/dev/null
  check "K7 父页设为 private → 200" "200" "$(set_vis k2 '{"visibility":"private"}')"
  check "K8 断链点设为 public + 已发布 + **inherit=false** → 200" "200" "$(set_vis k2/mid '{"visibility":"public","published":true,"inherit":false}')"
  check "K9 深层页设为 public + 已发布 → 200" "200" "$(set_vis k2/mid/deep '{"visibility":"public","published":true}')"
  check "K10 前置：此刻匿名**读得到**深层页（断链生效）" "200" "$(anon "/api/pages/k2%2Fmid%2Fdeep")"
  check_ge "K11 前置：此刻匿名**搜得到**深层页" "$(anon "/api/search?q=$DID" | field total)" 1
  # ★ 删掉断链点 ⇒ 更上层那条 private 重新开始压制
  check "K12 删除断链点 → 200" "200" "$(sess DELETE "/api/pages/$(urlenc 'k2/mid')")"
  check "K13 匿名读深层页被遮蔽（404）" "404" "$(anon "/api/pages/k2%2Fmid%2Fdeep")"
  anon "/api/search?q=$DID" >/dev/null
  cp "$TMP/body" "$TMP/k2.search"
  check "K14 匿名搜**同时**被遮蔽（total=0）" "0" "$(field total)"
  check_absent "K15 且检索响应体里不含内容标记" "$TMP/k2.search" "$DLK"
fi

echo
echo "=== 阶段 J：收尾 —— 服务仍健康、日志无异常 ==="
check "J1 /api/health → 200" "200" "$(anon /api/health)"
if grep -qE "no such table|Unhandled|unhandledRejection" "$LOG"; then
  echo "  日志中的可疑行："; grep -nE "no such table|Unhandled|unhandledRejection" "$LOG" | head -5
  bad "J2 服务日志里有异常"
else
  ok "J2 服务日志无异常"
fi

echo
echo "=============================================================="
echo "通过 $PASS 项，失败 $FAIL 项，跳过 $SKIP 项"
if [[ "$SKIP" -gt 0 ]]; then
  echo '（跳过的都是 §4.3 ★v7 方言语义下不存在的路径：PG 没有 FTS5 —— 它们不算"通过"）'
fi
echo "=============================================================="
[[ "$FAIL" -eq 0 ]] || exit 1
