#!/usr/bin/env bash
# 附件上传（本批 M1/M2/M3）端到端验收 —— 真实起服务 + 真实 curl，不 mock 任何东西。
#
# 覆盖的安全关键点（每条都是"写错了不会报错、只会静默失守"的那类）：
#   - **越权下载负向断言**：匿名读 org 段附件 ⇒ 404、成员 ⇒ 200；
#     `granted` 段附件未授予 ⇒ **404**、被授予者 ⇒ 200、**撤销后立刻回到 404**（无 TTL 窗口）；
#     **从正文里删掉引用后 ⇒ 404**（附件可见性跟着正文投影走，不存在第二套规则）。
#     ★ 越权一律 404 且**响应体与「不存在」逐字节相同**：403 与 404 的差别配合可枚举的
#     整数 id 就是一个"附件存在性预言机"（见 `expect_404_not_found` 的说明）
#   - **上传者可用性补丁的边界**：本人 + 可编辑 ⇒ 能读自己刚传、正文还没引用的附件；
#     **另一个同样可编辑的用户读同一附件必须 404**
#   - 上传：匿名 401、private 页 404（不泄露存在性）、超限 413、单页配额 413、
#     不支持的类型 **415 `unsupported_media_type`**（X2：此前实现回 400 `unsupported_ext`，
#     与前端注释/设计文档不一致 ⇒ 统一到语义更准的 415）、错误扩展名不落盘、
#     同内容二次上传 dedup=true 且磁盘只有一份
#   - **截断上传**（X6）：声明 100KB、实发 50KB ⇒ 400 且 `attachments/` 与 `tmp/` 零残留、
#     不落成"自洽但残缺"的元数据行（内容寻址下最难发现的一类静默错误）
#   - **网关层拒绝也是完整响应**（X3）：匿名 401 与缺 CSRF 403 都发生在**处理器之前**，
#     故 `nosniff` 与 `cache-control: no-store` 必须由网关层自己补，不能指望插件入口
#   - **审计**（X5）：`attachment.upload` 与 `attachment.delete` 都在 `view=acl` 里可见
#     （此前 upload 不在 `ACL_ACTIONS` 白名单里、删除成功则完全不写审计）
#   - 响应头：`nosniff` 由**两层**共同负责 —— 插件处理器入口覆盖进入处理器后的全部出口
#     （200/201/304/400/404/409/413/415/503，见 B4e/D7c/D8c），网关层覆盖**未进入处理器**的
#     拒绝（匿名 401 / 缺 CSRF 403，见 B1b–B1e；X3）、
#     `cache-control` **不含 public** 且**不含 max-age**
#     （同 URL 的可见性随 ACL 变化 ⇒ `private, no-cache`：每次复用前回源校验，撤销即时生效）、
#     `content-type` 用白名单推出的值（不信任声明）、svg 强制 `attachment`
#   - 存储异常 ⇒ **503**（不是 500：5xx 会计入连续失败并可能熔断），且**只告警、不阻止激活**
#   - 删除**只删元数据行**，磁盘文件留给 GC（内容寻址可能被他页共享）
#   - 删页 ⇒ 附件元数据随外键级联清理
#
# 关于 `curl -I`（HEAD）：路由服务按 method **精确匹配**，`HttpRouterService.register` 的
# 方法联合类型里**没有 HEAD** ⇒ HEAD `/api/attachments/:id` 会落到 `/api` 的 404，
# 拿不到本端点的响应头（见本脚本 S 段之前的说明）。故响应头断言用**真实 GET** 的
# `-D`（转存响应头）：浏览器与 `<img src>` 走的正是 GET，那才是有安全含义的那条路径。
#
# 用法：
#   bash packages/plugin-wiki/test/e2e-attachments.sh          # SQLite（默认）
#   BASE=http://127.0.0.1:47112 bash …/e2e-attachments.sh      # 对既有实例跑（跳过起停服务）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-47112}"
TMP="$(mktemp -d)"
JAR="$TMP/owner.jar"
JAR2="$TMP/member.jar"
LOG="$TMP/server.log"
CFG="$TMP/cfg"
DBFILE="$TMP/data/geewiki.db"
PASS=0
FAIL=0
SKIP=0

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ 跳过：$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1（$3）"; else bad "$1 —— 期望 $2，实际 $3"; fi; }
check_absent() { if grep -qF "$3" "$2"; then bad "$1 —— 出现了 $3"; else ok "$1（未出现 $3）"; fi }
check_present() { if grep -qF "$3" "$2"; then ok "$1（含 $3）"; else bad "$1 —— 没有 $3"; fi }
check_ge() { if [[ "${2:-x}" =~ ^[0-9]+$ ]] && [[ "$2" -ge "$3" ]]; then ok "$1（$2 ≥ $3）"; else bad "$1 —— 实际 \"${2:-<空>}\"，期望 ≥ $3"; fi }

# req <jar|-> <method> <path> [json] → 打印状态码；响应体 → $TMP/body
req() {
  local jar="$1" m="$2" p="$3" body="${4:-}"
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p"
              -H 'x-gw-csrf: 1' -H 'content-type: application/json')
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}
anon()  { req "-" "$@"; }
sess()  { req "$JAR" "$@"; }
sess2() { req "$JAR2" "$@"; }
# field <js 表达式>（在响应体上求值，如 'attachments.length'、'after.sha256'）
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1" < "$TMP/body"; }
# body_expr <js 表达式>（可用 o = 已解析的响应体；用于 field 表达不了的判断）
body_expr() { node -e "const fs=require('fs');const o=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const v=(function(){return eval(process.argv[2])})();console.log(v===undefined?'':String(v))" "${2:-$TMP/body}" "$1"; }
urlenc() { printf '%s' "${1//\//%2F}"; }
qenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
node_db() { ( cd "$ROOT/packages/db-sqlite" && node -e "$1" "$DBFILE" "${@:2}" ); }

# upload <jar|-> <slug> <文件> <原始名> [声明的 content-type] → 状态码；响应体 → $TMP/body
upload() {
  local jar="$1" slug="$2" file="$3" name="$4" ct="${5:-application/octet-stream}"
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X PUT
    "http://127.0.0.1:$PORT/api/attachments/$(urlenc "$slug")?name=$(qenc "$name")"
    -H 'x-gw-csrf: 1' -H "content-type: $ct" --data-binary "@$file")
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  curl "${args[@]}"
}
# dl <jar|-> <id> [额外 curl 参数…] → 状态码；响应体 → $TMP/dl.body，响应头 → $TMP/dl.head
dl() {
  local jar="$1" id="$2"; shift 2
  # 必须先清空：curl 在"无响应体"（如 304）时不会截断已有文件，
  # 留着上一次的字节会让"304 不带 body"这类断言变假绿
  rm -f "$TMP/dl.body"
  local args=(-s -D "$TMP/dl.head" -o "$TMP/dl.body" -w '%{http_code}')
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  curl "${args[@]}" "$@" "http://127.0.0.1:$PORT/api/attachments/$id"
}
# del_att <jar|-> <id> → 状态码；响应体 → $TMP/del.body，响应头 → $TMP/del.head
# （与 dl 同款纪律：先清空 body —— 无响应体时 curl 不截断旧文件，留着会让断言假绿）
del_att() {
  local jar="$1" id="$2"
  rm -f "$TMP/del.body" "$TMP/del.head"
  local args=(-s -D "$TMP/del.head" -o "$TMP/del.body" -w '%{http_code}' -X DELETE
    -H 'x-gw-csrf: 1' "http://127.0.0.1:$PORT/api/attachments/$id")
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  curl "${args[@]}"
}

# ---- 越权下载的 404 判据（T1）----
# 服务端对「无权」（页面不可见 / 段落受限 / 引用已被从正文删掉）与「附件不存在」必须回
# **同一个 404 信封**、且响应体**逐字节相同** —— 只把 403 改成 404 是不够的：只要响应体里
# 多带一个标识字段（例如 `gated:true`），可枚举的整数 id 就重新变成一个存在性预言机。
# 判据分两步，缺一不可：
#   ① 状态码是 404（不是 403）；
#   ② 响应体 ==「**同一个 id** 不存在时」应有的响应体。
# 第 ② 步用模板比对。模板本身在 D8a 处被**真实的** not-found 响应标定过一次 ——
# 少了那一步，"模板 == 模板"是恒真的，这条断言就只是装饰。
make_not_found_body() { # make_not_found_body <id> → 打印"该 id 不存在"时的响应体（模板）
  node -e 'process.stdout.write(JSON.stringify({ok:false,error:"not_found",message:"附件不存在: "+process.argv[1]}))' "$1"
}
# 状态码 + 响应体的共同判据（GET 与 DELETE 共用；两者的信封必须**完全同形**）：
#   assert_404_envelope <断言名> <实际状态码> <实际响应体文件> <id> <失败时打印的响应体文件>
assert_404_envelope() { # assert_404_envelope <label> <code> <bodyfile> <id> <errbody>
  local label="$1" code="$2" body="$3" id="$4" errbody="$5"
  if [[ "$code" != "404" ]]; then
    bad "$label —— 期望 404（越权不得与「不存在」不同），实际 $code：$(head -c 160 "$errbody" 2>/dev/null)"
    return 1
  fi
  make_not_found_body "$id" > "$TMP/nf.body"
  if cmp -s "$body" "$TMP/nf.body"; then
    ok "$label（404，且响应体与「$id 不存在」逐字节相同）"
  else
    bad "$label —— 状态码对，但响应体与「不存在」不同：$(head -c 200 "$body" 2>/dev/null)"
    return 1
  fi
}
expect_404_not_found() { # expect_404_not_found <jar|-> <id> <断言名>（下载端点）
  local jar="$1" id="$2" label="$3" code
  code="$(dl "$jar" "$id")"
  assert_404_envelope "$label" "$code" "$TMP/dl.body" "$id" "$TMP/dl.body"
}
# ★ T5：**删除端点同款判据**。DELETE 此前对"行存在但无权"回 403 `forbidden`，而附件 id 是
# 可枚举的连续整数 —— 403/404 的差别本身就是"这个 id 存在"的答案。现在两者同口径：
# 越权与"不存在"必须是同一个 `attachmentNotFound` 信封，逐字节相同（与下载端点一致）。
expect_404_not_found_del() { # expect_404_not_found_del <jar|-> <id> <断言名>（删除端点）
  local jar="$1" id="$2" label="$3" code
  code="$(del_att "$jar" "$id")"
  assert_404_envelope "$label" "$code" "$TMP/del.body" "$id" "$TMP/del.body"
}

put_page() { # put_page <slug> <正文> [标题]
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({title:process.argv[3]||"附件演示页",content:process.argv[2]}))' "$TMP/put.json" "$2" "${3:-}"
  curl -s -o "$TMP/body" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$1")" \
    -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' --data-binary "@$TMP/put.json"
}
set_vis() { # set_vis <slug> <json>
  curl -s -o "$TMP/body" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/pages/$(urlenc "$1")/visibility" \
    -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'X-GW-CSRF: 1' -d "$2"
}
# attachments_count → $TMP/data/attachments 下的文件数（用来断言"超限不留残渣"）
attachments_count() { find "$TMP/data/attachments" -type f 2>/dev/null | wc -l | tr -d ' '; }
tmp_count() { find "$TMP/data/tmp" -type f 2>/dev/null | wc -l | tr -d ' '; }

# X6：合成"声明的 Content-Length 与实发字节数不符"的请求。
# curl 不会主动制造这种请求（长度由它自己算），故直接用裸 socket：
# 声明 <declared> 字节、只发 <actual> 字节，然后**半关闭**（shutdown write）——
# 这是最"礼貌"的截断方式（不是粗暴断开），也是最容易骗过"读完整就落盘"的写法。
# 打印完整原始响应（含状态行）到 stdout，调用方自己取状态码。
truncated_upload() { # truncated_upload <slug> <原始名> <声明字节> <实发字节> [cookie jar]
  node -e '
const fs = require("node:fs")
const net = require("node:net")
const [port, slug, name, declared, actual, jar] = process.argv.slice(1)
let cookie = ""
try {
  const row = fs
    .readFileSync(jar, "utf8")
    .split("\n")
    // ⚠️ curl 的 Netscape 格式里，HttpOnly 的 cookie 会被写成 `#HttpOnly_<域>` 前缀行 ——
    // 它**不是注释**，直接按 # 过滤会把会话 cookie 丢掉，于是这条断言会退化成一个 401
    // （本脚本第一版就踩了这个坑）。故只过滤真正的注释行。
    .filter((l) => l !== "" && (!l.startsWith("#") || l.startsWith("#HttpOnly_")))
    .map((l) => l.replace(/^#HttpOnly_/, "").split("\t"))
    .find((c) => c[5] === "gw_sid")
  if (row) cookie = `Cookie: gw_sid=${row[6]}\r\n`
} catch {
  /* 没有 jar ⇒ 匿名请求 */
}
const sock = net.connect(Number(port), "127.0.0.1", () => {
  sock.write(
    `PUT /api/attachments/${encodeURIComponent(slug)}?name=${encodeURIComponent(name)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\nContent-Type: image/png\r\n${cookie}` +
      `x-gw-csrf: 1\r\nContent-Length: ${declared}\r\nConnection: close\r\n\r\n`,
  )
  sock.write(Buffer.alloc(Number(actual), 0x41), () => sock.end())
})
const chunks = []
sock.on("data", (d) => chunks.push(d))
sock.on("close", () => process.stdout.write(Buffer.concat(chunks).toString("latin1")))
sock.on("error", (e) => {
  process.stderr.write(String(e.code))
  process.exit(1)
})
' "$PORT" "$1" "$2" "$3" "$4" "${5:-$JAR}"
}

# 自带的配置目录：把单文件上限压到 1MB、单页配额压到 2MB，**不改仓库里的 config/**
# （否则"配额/超限"两条断言只能靠上传几十 MB 的真文件来触发）。
# 阶段 T 会用 `WIKI_CFG` 换一份配置重启，故这里是参数化的。
WIKI_CFG='{ "attachmentMaxBytes": 1048576, "attachmentPageQuotaBytes": 2097152 }'
write_config() {
  mkdir -p "$CFG"
  cat > "$CFG/plugins.base.json" <<JSON
{
  "enabled": [
    { "name": "@geewiki/db-sqlite" },
    { "name": "@geewiki/http" },
    { "name": "@geewiki/auth" },
    { "name": "@geewiki/org" },
    { "name": "@geewiki/authz" },
    { "name": "@geewiki/wiki", "config": $WIKI_CFG },
    { "name": "@geewiki/search" }
  ]
}
JSON
  printf '{\n  "enabled": []\n}\n' > "$CFG/plugins.session.json"
}

start_server() {
  write_config
  ( cd "$ROOT" && exec env GEEWIKI_CONFIG_DIR="$CFG" GEEWIKI_DATA_DIR="$TMP/data" \
      GEEWIKI_PORT="$PORT" node --import tsx packages/server/src/index.ts ) >>"$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
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
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || break
    sleep 0.25
  done
}

# 用 BASE 指向既有实例时不起服务（本脚本默认自己起，与 e2e-p3a.sh 同款）
EXTERNAL=0
[[ -n "${BASE:-}" ]] && EXTERNAL=1

echo "=== 启动服务（端口 $PORT，SQLite）==="
if [[ "$EXTERNAL" == "1" ]]; then
  echo "  使用外部实例 BASE=$BASE（不起停服务；S 段会被跳过）"
else
  start_server
  echo "  服务已就绪"
fi

# 夹具：小而确定的字节（内容是任意字节，MIME 一律由扩展名推出）
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],Buffer.from("ATT-PNG-0001-payload-\u56fe\u7247","utf8"));fs.writeFileSync(process.argv[2],Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>","utf8"));fs.writeFileSync(process.argv[3],Buffer.from("ATT-TXT-0002","utf8"));fs.writeFileSync(process.argv[4],Buffer.alloc(1500000,0x42));fs.writeFileSync(process.argv[5],Buffer.alloc(800000,0x41));fs.writeFileSync(process.argv[6],Buffer.alloc(800000,0x43));fs.writeFileSync(process.argv[7],Buffer.alloc(800000,0x44))' \
  "$TMP/tiny.png" "$TMP/tiny.svg" "$TMP/tiny.txt" "$TMP/too-big.bin" "$TMP/q1.dat" "$TMP/q2.dat" "$TMP/q3.dat"
# .dat 不在白名单里 ⇒ 配额用例改用 .zip（同为二进制、可容纳任意字节）
cp "$TMP/q1.dat" "$TMP/q1.zip"; cp "$TMP/q2.dat" "$TMP/q2.zip"; cp "$TMP/q3.dat" "$TMP/q3.zip"
: > "$TMP/empty-length-check"

echo
echo "=== 阶段 A：身份（owner + 一个成员）==="
A=$(sess POST /api/auth/setup '{"email":"owner@example.com","password":"correct-horse-battery"}')
A1=$(echo "$A" | awk '{print $1}')
if [[ "$A1" == "201" || "$A1" == "409" ]]; then ok "A1 setup 首个 owner → $A1"; else bad "A1 setup 意外状态码 $A1"; fi
check "A2 owner 登录 → 200" "200" "$(sess POST /api/auth/login '{"email":"owner@example.com","password":"correct-horse-battery"}')"
check "A3 邀请 member → 201" "201" "$(sess POST /api/org/invitations '{"email":"member@example.com","orgRole":"member"}')"
TOKEN=$(field token)
check_ge "A3b 拿到一次性令牌（长度≥16）" "${#TOKEN}" 16
check "A4 凭邀请开户（匿名）→ 201" "201" "$(anon POST /api/org/invitations/redeem "{\"token\":\"$TOKEN\",\"password\":\"memberpass123\",\"displayName\":\"成员\"}")"
MEMBER_ID=$(field userId)
check_ge "A4b 拿到成员 userId（≥1）" "${MEMBER_ID:-0}" 1
check "A5 member 登录 → 200" "200" "$(sess2 POST /api/auth/login '{"email":"member@example.com","password":"memberpass123"}')"

echo
echo "=== 阶段 B：上传（裸 body PUT）—— 鉴权、类型、幂等、超限 ==="
check "B0 建页 att-pub → 200" "200" "$(put_page att-pub '初始正文 ATT0000')"
check "B1 **匿名上传 → 401**（access:'user' 闸门先于处理器）" "401" "$(upload - att-pub "$TMP/tiny.png" 'x.png')"
# ★ X3：**网关层的拒绝同样是响应，不能少安全头那一层**。
# 这两条断言的对象都是"处理器一行都没跑"的响应：401 出自 `gateThenInvoke` 的
# `judgeAccess`，403 出自 `@geewiki/auth` 的 CSRF 钩子（`runHooks` 的 verdict 分支）。
# 四个附件端点在**处理器入口**设的 `nosniff` / `no-store` 在这里**根本轮不到** ——
# 修复前实测：这两个响应的 `x-content-type-options` 是 **null**。
curl -s -D "$TMP/anon401.head" -o /dev/null -X PUT "http://127.0.0.1:$PORT/api/attachments/$(urlenc att-pub)?name=x.png" \
  -H 'content-type: image/png' --data-binary @"$TMP/tiny.png" >/dev/null
check_present "B1b **匿名 401 也带 nosniff**（网关层自己补，不靠插件入口）" "$TMP/anon401.head" "x-content-type-options: nosniff"
check_present "B1c 匿名 401 也带 cache-control: no-store" "$TMP/anon401.head" "cache-control: no-store"
# 缺 CSRF（带会话 cookie、但那一个自定义头故意不发）⇒ `authHook` 拒绝
curl -s -D "$TMP/nocsrf.head" -o /dev/null -X PUT "http://127.0.0.1:$PORT/api/attachments/$(urlenc att-pub)?name=x.png" \
  -b "$JAR" -c "$JAR" -H 'content-type: image/png' --data-binary @"$TMP/tiny.png" >/dev/null
check_present "B1d **缺 CSRF 的 403 也带 nosniff**（钩子拒绝，处理器没跑）" "$TMP/nocsrf.head" "x-content-type-options: nosniff"
check_present "B1e 缺 CSRF 的 403 也带 cache-control: no-store" "$TMP/nocsrf.head" "cache-control: no-store"
# 上传时**故意声明 text/html**：响应头必须仍由扩展名推出 image/png（存储型 XSS 的常见入口）
check "B2 owner 上传 png → 201" "201" "$(upload "$JAR" att-pub "$TMP/tiny.png" '图片 一.png' 'text/html')"
PNG_ID=$(field id); PNG_URL=$(field url); PNG_SHA=$(field sha256); PNG_SIZE=$(field size)
check "B2b 回的是相对 URL（同源，cookie 自动带）" "/api/attachments/$PNG_ID" "$PNG_URL"
check "B2c dedup=false（首次上传）" "false" "$(field dedup)"
check "B2d size 等于文件字节数" "$(stat -c%s "$TMP/tiny.png")" "$PNG_SIZE"
check "B3 同文件二次上传 → 201（PUT 幂等，同一形状）" "201" "$(upload "$JAR" att-pub "$TMP/tiny.png" '另一个名字.png')"
check "B3a **同文件二次上传 dedup=true**" "true" "$(field dedup)"
check "B3b 幂等：返回同一个 id" "$PNG_ID" "$(field id)"
check "B3c 磁盘上该内容只有一份（按 sha 前 4 位两级目录）" "1" \
  "$(find "$TMP/data/attachments" -type f -name "$PNG_SHA*" | wc -l | tr -d ' ')"
check "B3d 落盘路径就是内容寻址（<2>/<2>/<sha>.png）" "1" \
  "$(find "$TMP/data/attachments/${PNG_SHA:0:2}/${PNG_SHA:2:2}" -maxdepth 1 -type f -name "$PNG_SHA.png" | wc -l | tr -d ' ')"
check "B3e 临时目录无残留" "0" "$(tmp_count)"
check "B4 不支持的类型（x.php）→ 415" "415" "$(upload "$JAR" att-pub "$TMP/tiny.png" 'x.php')"
check "B4b 错误码 unsupported_media_type" "unsupported_media_type" "$(field error)"
# ★ T2：`nosniff` 必须覆盖**错误响应**（`h.json` 只写 content-type，不带 nosniff）；
# 附件端点改为在处理器入口设置一次，因此 415/404/413 这些分支也不会漏
curl -s -D "$TMP/err.head" -o /dev/null -X PUT "http://127.0.0.1:$PORT/api/attachments/$(urlenc att-pub)?name=x.php" \
  -b "$JAR" -c "$JAR" -H 'x-gw-csrf: 1' -H 'content-type: image/png' --data-binary @"$TMP/tiny.png" >/dev/null
check_present "B4e **415 错误响应也带 nosniff**（错误分支没漏）" "$TMP/err.head" "x-content-type-options: nosniff"
# 同页同内容但扩展名不一致 ⇒ 409（扩展名决定响应头，不能静默保留第一次的）
check "B4c 同内容换扩展名 → 409 attachment_conflict" "409" "$(upload "$JAR" att-pub "$TMP/tiny.png" 'same.txt')"
check "B4d 错误码 attachment_conflict" "attachment_conflict" "$(field error)"
BEFORE_FILES=$(attachments_count)
check "B5 **超限上传 → 413**（上限 1MB，实传 1.5MB）" "413" "$(upload "$JAR" att-pub "$TMP/too-big.bin" 'big.zip')"
check "B5b 错误码 payload_too_large" "payload_too_large" "$(field error)"
check "B5c 超限后 attachments 目录无残留" "$BEFORE_FILES" "$(attachments_count)"
check "B5d 超限后 tmp 目录无残留" "0" "$(tmp_count)"
# ★ T6：错误响应必须带 `cache-control: no-store`。
# 缺了它，浏览器可以**启发式缓存**这个 413（没有显式指令时按 Date/Last-Modified 猜新鲜期）——
# 用户把文件改小后重传，可能直接复用那份旧 413，表现为"明明没超限了还说太大"。
curl -s -D "$TMP/big.head" -o /dev/null -X PUT "http://127.0.0.1:$PORT/api/attachments/$(urlenc att-pub)?name=big2.zip" \
  -b "$JAR" -c "$JAR" -H 'x-gw-csrf: 1' -H 'content-type: application/zip' --data-binary @"$TMP/too-big.bin" >/dev/null
check_present "B5e **413 错误响应带 cache-control: no-store**（错误响应不可复用）" "$TMP/big.head" "cache-control: no-store"
# 对照面：**成功**响应必须覆盖掉入口那层 no-store —— 可以留，但每次复用前回源校验。
# 用白名单内的 `.txt`（`.bin` 不在白名单 ⇒ 会先撞 400，那样这条断言测的就不是成功分支了）
OK_CODE=$(curl -s -D "$TMP/ok.head" -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/attachments/$(urlenc att-pub)?name=ok.txt" \
  -b "$JAR" -c "$JAR" -H 'x-gw-csrf: 1' -H 'content-type: text/plain' --data-binary @"$TMP/tiny.txt")
check "B5f 对照面：该上传本身是成功（201）" "201" "$OK_CODE"
check_present "B5f2 **201 成功响应覆盖为 cache-control: private, no-cache**" "$TMP/ok.head" "cache-control: private, no-cache"
check_absent "B5g 成功响应**不再**是 no-store（否则每次都整传，且丢掉了 304 复用）" "$TMP/ok.head" "no-store"
check "B6 无 Content-Length 的裸 body → 413 length_required" "413" \
  "$(curl -s -o "$TMP/body" -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/api/attachments/att-pub?name=b.png" \
     -b "$JAR" -c "$JAR" -H 'x-gw-csrf: 1' -H 'content-type: image/png' -H 'transfer-encoding: chunked' --data-binary @"$TMP/tiny.png")"
check "B6b 错误码 length_required" "length_required" "$(field error)"
# ★ X6：截断上传（声明 100KB、实发 50KB）⇒ 400，且**磁盘与数据库都不留痕**。
#
# 为什么必须断言"不留痕"：落盘路径是**内容寻址**的，被截断的字节是一份**全新的哈希** ——
# 它路径自洽、`byte_size` 自洽、下载也吐得回来，而去重**挡不住**它（去重比的正是哈希），
# 于是"同一哈希 ⇒ 同一字节"这条不变式会被**静默**破坏，发现时机是"用户某天打开这张图，
# 下半截是灰的"。服务端的对策是 `storeStream()` 的 `expectedBytes` 对照（**放在 rename 之前**，
# 失败时最终路径从未被创建 ⇒ 零残留，也不会误删 dedup 场景下别页引用的那份内容）。
#
# ⚠️ 实测口径（重要，别把这条断言读成"覆盖了那条分支"）：在这套 HTTP 栈上，
# **Content-Length 分帧下的截断请求由 Node 的 HTTP 解析器直接回 400**（路由与处理器
# 一行都没跑）。所以本段断言的是"**400 + 零残留**"这个可观察事实；`length_mismatch`
# 那条应用层分支由 `packages/plugin-wiki/test/attachments.test.ts` 的内存流用例直接覆盖。
X6_BEFORE_FILES=$(attachments_count)
X6_CODE=$(truncated_upload att-pub trunc.png 102400 51200 | head -1 | awk '{print $2}')
check "B6c 声明 100KB 实发 50KB 的截断上传 → 400" "400" "$X6_CODE"
X6_SHA=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(Buffer.alloc(51200,0x41)).digest("hex"))')
check "B6d **截断的那 50KB 没有落盘**（按它的 sha 查磁盘：0 个文件）" "0" \
  "$(find "$TMP/data/attachments" -type f -name "$X6_SHA*" | wc -l | tr -d ' ')"
check "B6e 截断上传后 attachments 目录无新增" "$X6_BEFORE_FILES" "$(attachments_count)"
check "B6f 截断上传后 tmp 目录无残留" "0" "$(tmp_count)"
check "B6g **没有落成一条「自洽」的元数据行**（按 sha 查库：0 行）" "0" \
  "$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);process.stdout.write(String(db.prepare("SELECT COUNT(*) n FROM attachments WHERE sha256=?").get(process.argv[2]).n))' "$X6_SHA")"
# private 页：member（visibility=none ⇒ canEdit=false）上传必须 404 —— **不是 403**，403 会确认它存在
check "B7 建 private 页 → 200" "200" "$(put_page att-private '私密页')"
check "B7b 设为 private → 200" "200" "$(set_vis att-private '{"visibility":"private"}')"
check "B8 **对 private 页上传 → 404**（member）" "404" "$(upload "$JAR2" att-private "$TMP/tiny.txt" 'a.txt')"
check "B8b 而 owner（应急覆盖）可以 → 201" "201" "$(upload "$JAR" att-private "$TMP/tiny.txt" 'a.txt')"
check "B9 元数据表结构：UNIQUE(page_id, sha256) 与两个索引都在" "ok" \
  "$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get("attachments").sql;const idx=db.prepare("SELECT name FROM sqlite_master WHERE type=?").all("index").map(r=>r.name);const okk=/UNIQUE\s*\(page_id,\s*sha256\)/i.test(sql)&&idx.includes("idx_attachments_page")&&idx.includes("idx_attachments_sha");process.stdout.write(okk?"ok":"bad")')"
check "B9b 冗余列 page_slug 与 pages.slug 一致（值正确）" "att-pub" \
  "$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const r=db.prepare("SELECT a.page_slug s FROM attachments a JOIN pages p ON p.id=a.page_id WHERE a.id=?").get(Number(process.argv[2]));process.stdout.write(r.s)' "$PNG_ID")"

echo
echo "=== 阶段 C：单页配额（配额 2MB，单文件上限 1MB）==="
check "C1 建页 att-quota → 200" "200" "$(put_page att-quota '配额测试页')"
check "C2 第 1 个 800KB → 201" "201" "$(upload "$JAR" att-quota "$TMP/q1.zip" 'q1.zip')"
check "C3 第 2 个 800KB → 201" "201" "$(upload "$JAR" att-quota "$TMP/q2.zip" 'q2.zip')"
check "C4 **第 3 个 800KB → 413 page_quota_exceeded**" "413" "$(upload "$JAR" att-quota "$TMP/q3.zip" 'q3.zip')"
check "C4b 错误码 page_quota_exceeded" "page_quota_exceeded" "$(field error)"
sess GET "/api/pages/att-quota/attachments" >/dev/null
check "C5 前置：该页确实只有 2 条（配额判定不是空转）" "2" "$(field 'attachments.length')"

echo
echo "=== 阶段 D：下载与响应头（判定通过才开文件）==="
DL_CONTENT=$(cat <<MD
公开段落 ATT0001 任何人都能看。

![图片]($PNG_URL)

尾部公开 ATT0002
MD
)
check "D0 正文引用该附件 → 200" "200" "$(put_page att-pub "$DL_CONTENT")"
check "D0b 设为 public + 已发布 → 200" "200" "$(set_vis att-pub '{"visibility":"public","published":true}')"
check "D1 匿名下载 → 200" "200" "$(dl - "$PNG_ID")"
if cmp -s "$TMP/dl.body" "$TMP/tiny.png"; then ok "D1b 下载字节与上传字节逐字节一致"; else bad "D1b 下载字节与上传字节不一致"; fi
check_present "D2 **响应头含 x-content-type-options: nosniff**" "$TMP/dl.head" "x-content-type-options: nosniff"
if grep -i '^cache-control:' "$TMP/dl.head" | grep -qi 'public'; then
  bad "D3 cache-control **含 public**（同一 URL 的可见性随 ACL 变化，共享缓存会喂给下一个人）"
else
  ok "D3 cache-control 不含 public（$(grep -i '^cache-control:' "$TMP/dl.head" | tr -d '\r')）"
fi
check_present "D3b cache-control 是 private（只有本浏览器可缓存）" "$TMP/dl.head" "cache-control: private"
# ★ T2：`max-age` 说的是"N 秒内别再问服务端"，而本能力的判定逐请求现查 ⇒ 撤权后仍有一个
# ≤N 秒的本地窗口（浏览器根本不再发请求，服务端连拒绝的机会都没有）。`no-cache` 是
# "每次复用前必须回源校验"：校验带 If-None-Match 跑完整判定，有权 ⇒ 304、撤权 ⇒ 404。
CC_HEAD=$(grep -i '^cache-control:' "$TMP/dl.head" | tr -d '\r')
if grep -qi 'max-age' <<<"$CC_HEAD"; then
  bad "D3c cache-control **含 max-age**（撤销权限后会留下本地缓存窗口）：$CC_HEAD"
else
  ok "D3c cache-control 不含 max-age（$CC_HEAD）"
fi
check_present "D3d cache-control 含 no-cache（每次复用前必须回源校验）" "$TMP/dl.head" "no-cache"
# `curl -I`（HEAD）能不能用：本仓路由服务按 method **精确匹配**，`register()` 的方法联合类型
# 里没有 HEAD ⇒ 它拿不到本端点的响应头。这里把**实测结果**记下来（不是"省略不写"）：
HEAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' -I "http://127.0.0.1:$PORT/api/attachments/$PNG_ID")
if [[ "$HEAD_CODE" == "200" ]]; then
  ok "HEAD /api/attachments/:id → 200（若将来路由服务补上 HEAD→GET 映射，这条会自然生效）"
else
  skip "curl -I（HEAD）实测 → $HEAD_CODE：路由服务按 method 精确匹配、方法集合里没有 HEAD ⇒ 响应头断言用真实 GET 的 -D（D2/D3 已断言 nosniff 与 private）"
fi
check_present "D4 content-type 由扩展名推出（**不是**上传时声明的 text/html）" "$TMP/dl.head" "content-type: image/png"
check_present "D5 位图 inline 展示" "$TMP/dl.head" "content-disposition: inline"
check_present "D6 ETag 就是内容哈希" "$TMP/dl.head" "etag: \"$PNG_SHA\""
check "D7 If-None-Match 命中 → 304" "304" "$(dl - "$PNG_ID" -H "If-None-Match: \"$PNG_SHA\"")"
if [[ -s "$TMP/dl.body" ]]; then bad "D7b 304 不应带响应体"; else ok "D7b 304 无响应体"; fi
check_present "D7c **304 也带 nosniff**（校验器与安全头一起回）" "$TMP/dl.head" "x-content-type-options: nosniff"
check "D8 不存在的附件 id → 404" "404" "$(dl - 999999)"
# ★ 标定：模板必须能**逐字节复现真实的** not-found 响应。少了这一步，下面那些
# `cmp` 比对就退化成"模板跟自己比"，恒真且毫无价值。
make_not_found_body 999999 > "$TMP/nf.ref"
if cmp -s "$TMP/dl.body" "$TMP/nf.ref"; then
  ok "D8a 标定：「不存在」的真实响应体与比对模板逐字节一致（越权用例的比对因此有意义）"
else
  bad "D8a 标定失败：真实响应体 ≠ 模板 —— 实际 $(cat "$TMP/dl.body")"
fi
check "D8b 非法 id → 404" "404" "$(dl - abc)"
check_present "D8c **404（错误响应）也带 nosniff**" "$TMP/dl.head" "x-content-type-options: nosniff"
# svg：默认强制 attachment（同源内联 SVG 可执行脚本 = 存储型 XSS）
check "D9 上传 svg（声明 image/svg+xml）→ 201" "201" "$(upload "$JAR" att-pub "$TMP/tiny.svg" 'vector.svg' 'image/svg+xml')"
SVG_ID=$(field id)
check "D9b 正文引用 svg → 200" "200" "$(put_page att-pub "$DL_CONTENT

![矢量图](/api/attachments/$SVG_ID)")"
check "D9c 匿名下载 svg → 200" "200" "$(dl - "$SVG_ID")"
check_present "D9d **svg 强制 attachment**（不得 inline）" "$TMP/dl.head" "content-disposition: attachment"
check_present "D9e svg 的 content-type 是 image/svg+xml" "$TMP/dl.head" "content-type: image/svg+xml"
# 从正文里删掉引用 ⇒ 立刻 404（判定跟着投影走，没有第二套规则、也没有缓存窗口）
check "D10 删掉正文里的引用 → 200" "200" "$(put_page att-pub '公开段落 ATT0001，引用已删除。')"
expect_404_not_found - "$PNG_ID" "D10b **删引用后匿名下载 → 404**（不是 403：403 会确认这个 id 存在）"
check "D10c 错误码是 not_found（不再是 attachment_gated）" "not_found" "$(body_expr 'o.error' "$TMP/dl.body")"
check "D11 恢复引用 → 200" "200" "$(put_page att-pub "$DL_CONTENT

![矢量图](/api/attachments/$SVG_ID)")"
check "D11b 恢复后匿名下载 → 200" "200" "$(dl - "$PNG_ID")"

echo
echo "=== 阶段 E：块级/页面级越权（本能力最关键的安全点）==="
# ---- E1：org 档页面 + org 段引用：匿名连页面都看不到 ⇒ 404（页面级） ----
check "E1 建页 att-org → 200" "200" "$(put_page att-org '初始')"
check "E1a 上传（org 页）→ 201" "201" "$(upload "$JAR" att-org "$TMP/tiny.txt" '内部说明.txt')"
ORG_ID=$(field id)
ORG_CONTENT=$(cat <<MD
公开段落 ORG0001

<!--gated:org-->
内部段落 ORG0002 见附件
![内部](/api/attachments/$ORG_ID)
<!--/gated-->
MD
)
check "E1b 保存含 org 段的正文 → 200" "200" "$(put_page att-org "$ORG_CONTENT")"
expect_404_not_found - "$ORG_ID" "E2 **匿名读 org 段附件 → 404**（页面不可见，不泄露存在性）"
check "E3 **member 读 org 段附件 → 200**" "200" "$(dl "$JAR2" "$ORG_ID")"
# ---- E2：granted 段 + 显式块级授予 ----
check "E4 建页 att-grant → 200" "200" "$(put_page att-grant '初始')"
check "E4a 上传（granted 段用）→ 201" "201" "$(upload "$JAR" att-grant "$TMP/tiny.txt" '秘密.txt')"
GRANT_ID_ATT=$(field id)
GRANT_URL=$(field url)
GRANT_SHA=$(field sha256)
GRANT_CONTENT=$(cat <<MD
公开段落 GRANT0001

<!--gated:granted-->
秘密段落 GRANT0002
![秘密]($GRANT_URL)
<!--/gated-->
MD
)
check "E4b 保存含 granted 段的正文 → 200" "200" "$(put_page att-grant "$GRANT_CONTENT")"
check "E4c 设为 public + 已发布 → 200" "200" "$(set_vis att-grant '{"visibility":"public","published":true}')"
expect_404_not_found - "$GRANT_ID_ATT" "E5 **匿名读 granted 段附件 → 404**（页面可读、块不可见）"
expect_404_not_found "$JAR2" "$GRANT_ID_ATT" "E6 **member 未授予时 → 404**"
# 取出承载该附件的块 id（用 sha/URL 定位，避免依赖块顺序）
# 注意：`GET /api/pages/:slug/blocks` **不回块文本**（治理视图只给结构与授权），
# 所以"哪个块承载了这份附件"只能从库里定位（按正文里的 URL 反查）
BLOCK_ID=$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const r=db.prepare("SELECT b.id AS i FROM blocks b JOIN pages p ON p.id = b.page_id WHERE p.slug = ? AND b.text LIKE ?").get("att-grant", "%" + process.argv[2] + "%");process.stdout.write(r ? String(r.i) : "")' "$GRANT_URL")
check_ge "E7 定位到承载附件的块（块级授权的前提）" "${BLOCK_ID:-0}" 1
check "E7b 匿名读 blocks 清单 → 401（管理面）" "401" "$(anon GET /api/pages/att-grant/blocks)"
check "E7c 授予 member 该块（viewer）→ 200" "200" \
  "$(sess POST "/api/pages/att-grant/blocks/$BLOCK_ID/grants" "{\"subjectKind\":\"user\",\"subjectId\":\"$MEMBER_ID\",\"role\":\"viewer\"}")"
check "E8 **被授予者读该附件 → 200**" "200" "$(dl "$JAR2" "$GRANT_ID_ATT")"
GID=$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);const r=db.prepare("SELECT id AS i FROM block_grants WHERE subject_kind = ? AND subject_id = ? ORDER BY id DESC").get("user", process.argv[2]);process.stdout.write(r ? String(r.i) : "")' "$MEMBER_ID")
check_ge "E8b 定位到刚写入的块级授权（撤销的前提）" "${GID:-0}" 1
check "E8c 撤销该块级授权 → 200" "200" "$(sess DELETE "/api/pages/att-grant/blocks/$BLOCK_ID/grants/$GID")"
expect_404_not_found "$JAR2" "$GRANT_ID_ATT" "E9 **撤销后立刻回到 404**（没有 TTL 窗口）"
# ---- E3：可用性补丁的边界（本人可读自己未引用的附件；别人不行） ----
check "E10 建页 att-draft → 200" "200" "$(put_page att-draft '草稿页（正文尚未引用附件）')"
check "E10a 设为 public + 已发布 → 200" "200" "$(set_vis att-draft '{"visibility":"public","published":true}')"
check "E10b owner 上传但不写进正文 → 201" "201" "$(upload "$JAR" att-draft "$TMP/tiny.txt" '草稿附件.txt')"
DRAFT_ID=$(field id); DRAFT_SHA=$(field sha256)
check "E11 **上传者本人（canEdit）可读未引用附件 → 200**" "200" "$(dl "$JAR" "$DRAFT_ID")"
expect_404_not_found "$JAR2" "$DRAFT_ID" "E12 **另一个同样可编辑的成员读同一附件 → 404**（补丁只放宽自己上传的字节）"
expect_404_not_found - "$DRAFT_ID" "E12b 匿名读该未引用附件 → 404"
# E12b 的响应体留一份：F4b 删掉这个附件之后，**同一个 id** 会再回一次 404 ——
# 那时"真的不存在"与此刻"存在但越权"必须逐字节相同（这是最硬的一条同形证据）
cp "$TMP/dl.body" "$TMP/gated-draft.body"

echo
echo "=== 阶段 F：管理面清单 / 删除（只删元数据，磁盘留给 GC）==="
check "F1 匿名读附件清单 → 403" "403" "$(anon GET /api/pages/att-pub/attachments)"
check "F2 member（可编辑 public 页）读清单 → 200" "200" "$(sess2 GET /api/pages/att-pub/attachments)"
check_present "F2b 清单含刚上传的附件名" "$TMP/body" "图片 一.png"
check "F2c 清单字段集固定（不含任何正文/字节字段）" "createdAt,ext,id,mime,name,sha256,size,uploaderId,url" \
  "$(body_expr '[...new Set(o.attachments.flatMap(a=>Object.keys(a)))].sort().join(",")')"
# ---- T5：越权删除与下载**完全同口径**（可枚举的 id 面前，403 就是存在性预言机）----
# 需要的形态是"**页可见、但无编辑权且非上传者**"：private 页 + 一条 **viewer** 页面授权
# （viewer ⇒ level=full、canEdit=false），这才是此前回 403 的那条路径。
check "F2d 建页 att-del → 200" "200" "$(put_page att-del '删除越权测试页')"
check "F2e 设为 private → 200" "200" "$(set_vis att-del '{"visibility":"private"}')"
check "F2f owner 上传 → 201" "201" "$(upload "$JAR" att-del "$TMP/tiny.txt" 'del.txt')"
DEL_ID=$(field id)
check "F2g 给 member 一条 **viewer** 页面授权 → 200" "200" \
  "$(sess POST "/api/pages/att-del/grants" "{\"subjectKind\":\"user\",\"subjectId\":\"$MEMBER_ID\",\"role\":\"viewer\"}")"
# 反空洞前置：member 此刻**确实看得见这一页** —— 否则下面的 404 可能只是"页面不可见"，
# 就证明不了"可见但无权删"与"不存在"同口径
check "F2h member 读该页详情 → 200（可见，正是 F2i 的前提）" "200" "$(sess2 GET /api/pages/att-del)"
expect_404_not_found_del "$JAR2" "$DEL_ID" "F2i **越权删除 → 404**（此前是 403：403 会确认这个 id 存在）"
check_present "F2j **越权 404 也带 cache-control: no-store**（否则授权后仍可能复用旧 404）" "$TMP/del.head" "cache-control: no-store"
cp "$TMP/del.body" "$TMP/del-gated.body"
# 同形的最硬证据：**同一个 id** 在"存在但越权"与"真的不存在"两种状态下必须逐字节相同
code_owner="$(del_att "$JAR" "$DEL_ID")"
check "F2k 上传者（owner）删除该附件 → 200" "200" "$code_owner"
cp "$TMP/del.head" "$TMP/del-ok.head"
check_present "F2l **删除成功响应带 cache-control: private, no-cache**（成功覆盖入口的 no-store）" "$TMP/del-ok.head" "cache-control: private, no-cache"
check_absent "F2l2 删除成功响应**不是** no-store" "$TMP/del-ok.head" "no-store"
code_again="$(del_att "$JAR2" "$DEL_ID")"
check "F2m 删除后 member 再删 → 404" "404" "$code_again"
if cmp -s "$TMP/del.body" "$TMP/del-gated.body"; then
  ok "F2n 同一个 id：「越权删除 404」（F2i）与「删除后 404」（F2m）响应体逐字节相同"
else
  bad "F2n 同一个 id 的两种删除 404 响应体不同：$(head -c 200 "$TMP/del.body" 2>/dev/null)"
fi

check "F3 匿名删除 → 401" "401" "$(anon DELETE "/api/attachments/$DRAFT_ID")"
check "F4 上传者本人删除 → 200" "200" "$(sess DELETE "/api/attachments/$DRAFT_ID")"
check "F4b 删除后该附件 404" "404" "$(dl - "$DRAFT_ID")"
# ★ T1 最硬的一条：**同一个 id** 在两种状态下的 404 必须逐字节相同
# （E12b 是"存在但越权"，这里是"真的不存在"）
if cmp -s "$TMP/dl.body" "$TMP/gated-draft.body"; then
  ok "F4b2 同一个 id：「越权 404」（E12b）与「删除后 404」的响应体逐字节相同"
else
  bad "F4b2 同一个 id 的两种 404 响应体不同：$(head -c 200 "$TMP/dl.body" 2>/dev/null)"
fi
check "F4c **磁盘文件仍在**（内容寻址可能被他页共享 ⇒ 只删元数据行，回收留给 GC）" "1" \
  "$(find "$TMP/data/attachments" -type f -name "$DRAFT_SHA*" | wc -l | tr -d ' ')"
sess GET /api/pages/att-draft/attachments >/dev/null
check "F4d 清单里也没有它了" "0" "$(field 'attachments.filter(a=>String(a.id)==="'"$DRAFT_ID"'").length')"
# 删页 ⇒ 附件元数据随外键级联（外键指向 pages(id) 而非 slug 的直接收益）
check "F5 建页 att-cascade → 200" "200" "$(put_page att-cascade '级联测试')"
check "F5a 上传 → 201" "201" "$(upload "$JAR" att-cascade "$TMP/tiny.txt" 'c.txt')"
CASCADE_ID=$(field id)
check "F5b 删除该页 → 200" "200" "$(sess DELETE "/api/pages/att-cascade")"
check "F5c 附件元数据被级联删除（0 行）" "0" \
  "$(node_db 'const D=require("better-sqlite3");const db=new D(process.argv[1]);process.stdout.write(String(db.prepare("SELECT COUNT(*) n FROM attachments WHERE id=?").get(Number(process.argv[2])).n))' "$CASCADE_ID")"
check "F5d 该附件随之 404" "404" "$(dl - "$CASCADE_ID")"

echo
echo "=== 阶段 G：审计与收尾 ==="
check "G1 查审计（action=attachment.upload）→ 200" "200" "$(sess GET '/api/admin/audit?action=attachment.upload&limit=50')"
check_ge "G1b 至少有一条上传审计" "$(field total)" 1
# ★ 字段名必须是 sha256：`hash` 会被 core 的 FORBIDDEN_AUDIT_KEYS 静默删掉（写进去等于没写）
check "G2 审计 after.sha256 是 64 位 hex（**没有被静默脱敏掉**）" "64" "$(field 'entries[0].after.sha256.length')"
check "G2b 审计 after 的字段集固定（不含正文，且 sha256 具名）" "byte_size,ext,mime,page,sha256" \
  "$(body_expr 'Object.keys(o.entries[0].after).sort().join(",")')"
sess GET '/api/admin/audit?limit=200' >/dev/null
check "G3 下载成功**不写审计**（图片是高频内联请求，逐次留痕会冲垮审计表）" "0" \
  "$(field 'entries.filter(e=>String(e.action).includes("attachment.download")||String(e.action).includes("attachment.read")).length')"
# ★ X5：**删除成功必须留痕**（此前只有上传写审计，删除什么都不写 ——
# 而删除是破坏性动作，"这份附件为什么不见了"只有审计能回答）。
sess GET '/api/admin/audit?action=attachment.delete&limit=50' >/dev/null
check_ge "G3b 至少有一条删除审计（action=attachment.delete）" "$(field total)" 1
check "G3c 删除审计 after 的字段集固定（id/page_slug/sha256/ext/size；**不含 hash**）" "ext,id,page_slug,sha256,size" \
  "$(body_expr 'Object.keys(o.entries[0].after).sort().join(",")')"
check "G3d 删除审计带操作者（actorId 非空）" "true" \
  "$(body_expr 'String(o.entries[0].actorId !== null && o.entries[0].actorId !== undefined)')"
check "G3e 删除审计的 targetKind=attachment 且 targetId 是数值 id" "ok" \
  "$(body_expr 'o.entries[0].targetKind === "attachment" && /^[0-9]+$/.test(String(o.entries[0].targetId)) ? "ok" : "bad"')"
# ★ X5：两个动作都要能在审计界面的「权限变更」（acl）视图里看到 ——
# 此前 `attachment.upload` 不在 `ACL_ACTIONS` 白名单里，于是它**只在 all 视图可见**，
# 而白名单的设计意图是"未分类的动作只出现在 all 里"（漏分类是可见的）。
sess GET '/api/admin/audit?view=acl&action=attachment.upload&limit=10' >/dev/null
check_ge "G3f **上传审计出现在 acl 视图**（已收入 ACL_ACTIONS）" "$(field total)" 1
sess GET '/api/admin/audit?view=acl&action=attachment.delete&limit=10' >/dev/null
check_ge "G3g **删除审计也出现在 acl 视图**" "$(field total)" 1
# 对照面（防空洞）：两者都**不该**出现在 security 视图 —— 那一档是"要告警的越权事件"，
# 把正常的上传/删除塞进去会把"有人在探测权限边界"稀释掉。这两条同时证明 G3f/G3g 的红绿
# 是白名单决定的，而不是"view 参数根本没生效"（若没生效，这里会跟着一起 ≥1）。
sess GET '/api/admin/audit?view=security&action=attachment.upload&limit=10' >/dev/null
check "G3h 对照：上传**不在** security 视图（越权才进那一档）" "0" "$(field total)"
sess GET '/api/admin/audit?view=security&action=attachment.delete&limit=10' >/dev/null
check "G3i 对照：删除**不在** security 视图" "0" "$(field total)"
check "G4 服务仍健康 → 200" "200" "$(anon GET /api/health)"
if grep -qE "\[http\] 路由 .* 异常|no such table: attachments|Unhandled|unhandledRejection" "$LOG"; then
  echo "  日志中的可疑行："; grep -nE "\[http\] 路由 .* 异常|no such table: attachments|Unhandled|unhandledRejection" "$LOG" | head -5
  bad "G5 服务日志里有异常"
else
  ok "G5 服务日志无异常（无 500、无缺表）"
fi

echo
echo "=== 阶段 S：存储异常 ⇒ 503（且**只告警、不阻止激活**）==="
if [[ "$EXTERNAL" == "1" ]]; then
  skip "S1-S5：BASE 指向外部实例时不能改它的数据目录"
else
  stop_server
  # 把 attachments 换成"指向只读文件系统上不存在路径"的符号链接：
  # 激活期探针与上传都会失败，而失败原因是存储状态（不是代码缺陷）
  rm -rf "$TMP/data/attachments"
  ln -s /sys/geewiki-attachments-probe "$TMP/data/attachments"
  : > "$LOG"
  start_server
  check "S1 附件目录不可用时服务**照常激活**（只告警，不阻止整站启动）" "200" "$(anon GET /api/health)"
  check_present "S1b 日志里留下了告警（运维能看到原因）" "$LOG" "附件目录不可用"
  check "S2 页面读写不受影响（正文与附件目录无关）→ 200" "200" "$(put_page att-storage-fault '存储故障下的正文')"
  # 附件目录整个不见了 ⇒ 已登记的附件是"元数据在、文件不在"：必须是**可判别**的 404，
  # 而不是 500（后者会让运维以为服务坏了，实际只是挂载没回来）
  check "S2b 已登记附件的文件缺失 → 404 blob_missing（可判别，不是 500）" "404" "$(dl - "$PNG_ID")"
  check "S2c 错误码 blob_missing" "blob_missing" "$(body_expr 'o.error' "$TMP/dl.body")"
  check "S3 **上传 → 503 storage_unavailable**（不是 500：那会计入连续失败并可能熔断）" "503" \
    "$(upload "$JAR" att-storage-fault "$TMP/tiny.txt" 'x.txt')"
  check "S3b 错误码 storage_unavailable" "storage_unavailable" "$(field error)"
  stop_server
  rm -f "$TMP/data/attachments"
  mkdir -p "$TMP/data/attachments"
  start_server
  check "S4 恢复后上传 → 201（探针与端点都是幂等的，无需额外修复动作）" "201" \
    "$(upload "$JAR" att-storage-fault "$TMP/tiny.txt" 'x.txt')"
fi

echo
echo "=== 阶段 T：配置项生效（白名单**只收窄**、svg 内联开关）==="
if [[ "$EXTERNAL" == "1" ]]; then
  skip "T1-T3：BASE 指向外部实例时不能改它的配置并重启"
else
  stop_server
  # 收窄到 .txt/.svg（配置只能比内置白名单更窄），并显式打开 svg 内联
  WIKI_CFG='{ "attachmentMaxBytes": 1048576, "attachmentPageQuotaBytes": 2097152,
    "attachmentAllowedExt": [".txt", ".svg"], "attachmentInlineSvg": true }'
  start_server
  check "T0 新配置下服务就绪 → 200" "200" "$(anon GET /api/health)"
  check "T1 建页 → 200" "200" "$(put_page att-config '配置生效测试')"
  check "T1a 被收窄掉的 .png → 415 unsupported_media_type" "415" "$(upload "$JAR" att-config "$TMP/tiny.png" 'narrowed.png')"
  check "T1b 错误码 unsupported_media_type" "unsupported_media_type" "$(field error)"
  check "T2 仍在白名单内的 .txt → 201" "201" "$(upload "$JAR" att-config "$TMP/tiny.txt" 'kept.txt')"
  CFG_TXT_ID=$(field id)
  check "T2b 上传者本人可读（未引用；可用性补丁）→ 200" "200" "$(dl "$JAR" "$CFG_TXT_ID")"
  check "T3 .svg → 201" "201" "$(upload "$JAR" att-config "$TMP/tiny.svg" 'vector.svg' 'image/svg+xml')"
  CFG_SVG_ID=$(field id)
  check "T3b 下载 svg → 200" "200" "$(dl "$JAR" "$CFG_SVG_ID")"
  check_present "T3c **开启 attachmentInlineSvg 后 svg 才 inline**（默认是 attachment，见 D9d）" "$TMP/dl.head" "content-disposition: inline"
fi

echo
echo "=============================================================="
echo "通过 $PASS 项，失败 $FAIL 项，跳过 $SKIP 项"
echo "=============================================================="
[[ "$FAIL" -eq 0 ]] || exit 1
