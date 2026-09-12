#!/usr/bin/env bash
#
# seed-demo.sh —— 给一个**空库**的 geewiki 实例灌入「权限模型演示数据」。
#
# 目的：让访问控制的效果**肉眼可见** —— 同一个页面，未登录 / 组织成员 / 管理员
# 三种身份看到的正文不同，尤其是**块级受限段落**在匿名视角下只剩一行占位。
#
# 设计与安全边界：
#   - **只通过 HTTP API 写入**，不直连数据库、不 import 任何源码。这样它顺带成了
#     一次端到端演练：能跑通就说明这些端点的契约是自洽的。
#   - **不启动、不停止、不重启服务**；只对 `$BASE` 发请求。
#   - **幂等**：重复执行不会报错、不会产生重复数据（页面是 upsert、可见性是赋值、
#     授予是按主体 upsert、邀请会各生成一条新的但邮已被占用时会跳过兑换）。
#     注意：每次重跑会**多留一条未兑换的邀请**，这是刻意的（邀请是一次性凭据，
#     没有"取回旧令牌"的接口 —— 库里只存 sha256）。
#
# 用法：
#   bash scripts/seed-demo.sh
#   BASE=http://127.0.0.1:9000 bash scripts/seed-demo.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------- 演示账号（口令须 8–200 位，见 plugin-auth 的 PASSWORD_MIN/MAX） ----------------
ADMIN_EMAIL='admin@example.com'
ADMIN_PASS='Demo-Admin-2026'
ADMIN_NAME='演示管理员'
MEMBER_PASS='Demo-Member-2026'
ALICE_EMAIL='alice@example.com'
ALICE_NAME='爱丽丝'
BOB_EMAIL='bob@example.com'
BOB_NAME='鲍勃'
GROUP_NAME='演示组'

# 受限段落里的**唯一标记**：用来证明"匿名视角下这些字符一个都没出现"。
# 选无意义的字母数字串，避免被 Markdown 渲染或分词改写。
ORG_TOKEN='ORGSEG7788'
GRANT_TOKEN='GRANTSEG9900'

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
note() { echo "    · $1"; }

# ---------------- HTTP 辅助 ----------------
# req <jar|-> <method> <path> [json-body]  → 打印状态码，响应体落在 $TMP/body
req() {
  local jar="$1" m="$2" p="$3" b="${4:-}"
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$m" "$BASE$p")
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  if [[ -n "$b" ]]; then
    args+=(-H 'content-type: application/json' -H 'X-GW-CSRF: 1' -d "$b")
  elif [[ "$m" != "GET" ]]; then
    args+=(-H 'X-GW-CSRF: 1')
  fi
  curl "${args[@]}"
}
body() { cat "$TMP/body"; }
code_anon() { curl -s -o "$TMP/body" -w '%{http_code}' "$BASE$1"; }
# field <点路径>：从 $TMP/body 里取字段（沿用既有 e2e 的写法）
field() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=s.indexOf('{');try{const o=JSON.parse(i>=0?s.slice(i):s);const v=eval('o.'+process.argv[1]);console.log(v===undefined?'':String(v))}catch(e){console.log('')}})" "$1" <"$TMP/body"
}
# slug 里的 `/` 必须编码，否则会被当成路由分段
enc() { printf '%s' "${1//\//%2F}"; }

if ! curl -sf -m 5 "$BASE/api/health" >/dev/null; then
  echo "无法连接 $BASE —— 请确认服务已在运行（本脚本不会替你启动它）" >&2
  exit 1
fi

echo "=== 目标实例：$BASE ==="

# ---------------- 1. 管理员（一次性 setup） ----------------
echo
echo "[1/7] 管理员账号"
JAR_ADMIN="$TMP/jar-admin.txt"
sc="$(req - POST /api/auth/setup "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\",\"displayName\":\"$ADMIN_NAME\"}")"
case "$sc" in
  201|200) ok "已创建 owner 账号 $ADMIN_EMAIL" ;;
  409|400) note "setup 返回 $sc（库中已有账号，属正常 —— 改走登录）" ;;
  *) bad "setup 意外返回 $sc: $(body | head -c 200)" ;;
esac
sc="$(req "$JAR_ADMIN" POST /api/auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")"
if [[ "$sc" == "200" ]]; then
  ok "管理员登录成功"
else
  bad "管理员登录失败（$sc: $(body | head -c 200)）—— 无法继续"
  echo
  echo "若库中已有**别的**管理员，请改用它的凭据执行："
  echo "  ADMIN_EMAIL=... ADMIN_PASS=... bash scripts/seed-demo.sh"
  exit 1
fi

# ---------------- 2. 组 ----------------
echo
echo "[2/7] 组织内的组"
sc="$(req "$JAR_ADMIN" POST /api/org/groups "{\"name\":\"$GROUP_NAME\"}")"
GROUP_ID="$(field 'group.id')"
if [[ "$sc" == "201" && -n "$GROUP_ID" ]]; then
  ok "已创建组「$GROUP_NAME」(id=$GROUP_ID)"
else
  # 重跑时组已存在：从列表里找回来
  req "$JAR_ADMIN" GET /api/org/groups >/dev/null
  GROUP_ID="$(node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const o=JSON.parse(s.slice(s.indexOf('{')));
      const g=(o.groups||[]).find(x=>x.name===process.argv[1]);
      console.log(g?String(g.id):'')}catch(e){console.log('')}
    })" "$GROUP_NAME" <"$TMP/body")"
  if [[ -n "$GROUP_ID" ]]; then ok "组「$GROUP_NAME」已存在 (id=$GROUP_ID)"; else bad "无法创建或找到组（$sc）"; fi
fi

# ---------------- 3. 普通成员（走真实邀请流程） ----------------
echo
echo "[3/7] 普通成员（管理员发邀请 → 自助兑换）"
seed_member() { # seed_member <email> <displayName> <varName>
  local email="$1" name="$2" var="$3"
  local sc token
  sc="$(req "$JAR_ADMIN" POST /api/org/invitations \
        "{\"email\":\"$email\",\"orgRole\":\"member\"$([[ -n "$GROUP_ID" ]] && echo ",\"groupId\":$GROUP_ID")}")"
  token="$(field 'token')"
  if [[ "$sc" != "201" || -z "$token" ]]; then
    bad "$email 的邀请签发失败（$sc）"
    eval "$var=''"
    return
  fi
  note "已签发邀请（令牌只在这一次响应里出现，库里只存 sha256）"
  sc="$(req - POST /api/org/invitations/redeem "{\"token\":\"$token\",\"password\":\"$MEMBER_PASS\",\"displayName\":\"$name\"}")"
  if [[ "$sc" == "201" || "$sc" == "200" ]]; then
    ok "$email 兑换成功（orgRole=member，已入组）"
  elif [[ "$sc" == "409" ]]; then
    note "$email 已存在，跳过兑换（重跑的正常路径）"
  else
    bad "$email 兑换失败（$sc: $(body | head -c 200)）"
  fi

  # 取 userId（授予要用数字 id）
  local jar="$TMP/jar-$var.txt" uid
  sc="$(req "$jar" POST /api/auth/login "{\"email\":\"$email\",\"password\":\"$MEMBER_PASS\"}")"
  if [[ "$sc" == "200" ]]; then
    uid="$(field 'user.id')"
    eval "$var='$uid'"
    note "$email userId=$uid"
  else
    eval "$var=''"
    bad "$email 登录失败（$sc）"
  fi
}
seed_member "$ALICE_EMAIL" "$ALICE_NAME" ALICE_ID
seed_member "$BOB_EMAIL" "$BOB_NAME" BOB_ID

# ---------------- 4. 页面正文 ----------------
echo
echo "[4/7] 页面与正文"

save_page() { # save_page <slug> <title> <content>
  local sc
  sc="$(req "$JAR_ADMIN" PUT "/api/pages/$(enc "$1")" \
        "$(node -e "console.log(JSON.stringify({title:process.argv[1],content:process.argv[2]}))" "$2" "$3")")"
  if [[ "$sc" == "200" || "$sc" == "201" ]]; then ok "已写入 $1"; else bad "写入 $1 失败（$sc: $(body | head -c 160)）"; fi
}
set_visibility() { # set_visibility <slug> <visibility> <published:true|false> [inherit:true|false]
  local sc
  sc="$(req "$JAR_ADMIN" PUT "/api/pages/$(enc "$1")/visibility" \
        "{\"visibility\":\"$2\",\"published\":$3${4:+,\"inherit\":$4}}")"
  if [[ "$sc" == "200" ]]; then ok "$1 ⇒ visibility=$2 published=$3${4:+ inherit=$4}"; else bad "$1 可见性设置失败（$sc: $(body | head -c 160)）"; fi
}

save_page welcome "欢迎来到演示站点" \
'# 欢迎

这是一条**公开**条目：**未登录访客也能读到它，也能在站内搜索里搜到它**。

用途：演示"公开 + 已发布"这一档。注意公开档必须**同时**打开"发布"开关才对匿名可见 ——
只设 `public` 而不发布，匿名同样读不到。

试一试：退出登录后打开本页，应该照常显示。'

save_page team-handbook "团队手册（组织内）" \
'# 团队手册

这是一条**组织内可见**条目。

- 未登录访客：读不到（按设计返回 404，**不告诉你它是否存在**）
- 登录的组织成员：读得到

内部代号 `TEAMONLY5522` —— 匿名视角下这个字符串不应该出现在任何响应里。'

save_page secrets "机密备忘（私有）" \
'# 机密备忘

这是一条**私有**条目：组织成员也读不到，只有 owner / admin 能读。

注意管理员读它时走的是一条**应急通道**（规则 O1），而且**每次覆盖式访问都会写一条审计**，
所以管理员的日常浏览不会把审计刷爆 —— 只在"本来会被拒"时才记。

内部代号 `PRIVATEONLY3311`。'

save_page demo/parent "继承演示 · 父页（组织内）" \
'# 继承演示 · 父页

本页是**组织内**可见。它的子页 `demo/parent/child` 自己的档位设成了**公开 + 已发布** ——
但**位置性继承取最窄**，所以子页实际上**也跟着变成组织内可见**：

- 未登录访客打开子页 → 404（**祖先把它收紧了**）
- 组织成员打开子页 → 正常读到

这正是"权限跟着位置走"的效果：把父页收紧，整棵子树跟着收紧，**不需要逐个改子页**。'

save_page demo/parent/child "继承演示 · 子页（自身是公开）" \
'# 继承演示 · 子页

本页**自身的档位是公开 + 已发布**，但你多半读不到它 —— 因为父页是组织内，继承取最窄。

- 若你是未登录访客：这就是继承生效的证据
- 若你是组织成员：确实读得到，说明你自己的档位允许

把父页改成公开，本页就会对匿名可见；把父页改成私有，连成员也读不到。**子页自身不用动。**'

save_page mixed-visibility "混合可见性演示（重点看这页）" \
'# 混合可见性演示

本条目的**自身档位是公开 + 已发布**，所以未登录访客可以打开它。

**但正文里有两段是被单独标记的**：一段"仅组织内"，一段"仅授权"。往下看：

这一段是**公开**的：任何身份都能读到，包括未登录访客。

<!--gated:org-->
这一段是**仅组织内可见**的。未登录访客看不到这里的任何字符，
只会看到一行占位提示；登录的组织成员则能正常读到。

内部代号 `ORGSEG7788` —— 匿名视角下这个字符串必须一次都不出现。
<!--/gated-->

中间这一段又回到**公开**：可见性只作用于被标记圈定的那一段，不波及全文。

<!--gated:granted-->
这一段是**仅授权可见**的：**连组织成员默认也看不到**，
必须被**单独授予**该块的权限才可见。

内部代号 `GRANTSEG9900` —— 爱丽丝被授予后应当能读到它，鲍勃读不到。
<!--/gated-->

结尾同样是公开的。

> 说明：占位的措辞按**读者**而不是按**内容**选择 —— 匿名读者看到"需登录查看"，
> 已登录但权限不够的读者看到"需更高权限查看"。这样既不泄露受限段落的档位，又让访客知道该做什么。'

# ---------------- 5. 可见性 ----------------
echo
echo "[5/7] 各页可见性"
set_visibility welcome          public  true
set_visibility team-handbook    org     false
set_visibility secrets          private false
set_visibility demo/parent      org     false
set_visibility demo/parent/child public true
set_visibility mixed-visibility public  true

# ---------------- 6. 块级例外授予 ----------------
echo
echo "[6/7] 块级例外授予（把"仅授权"那段单独授给爱丽丝）"
sc="$(req "$JAR_ADMIN" GET "/api/pages/$(enc mixed-visibility)/blocks")"
# 把该页**所有** granted 块逐个授予爱丽丝 —— 一个区段在解析后可能落成多个块
# （块边界 = 空行），只授第一个会让演示看起来"授了却没用"。
GRANT_IDS="$(node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const i=s.indexOf('{');const o=JSON.parse(i>=0?s.slice(i):s);
  console.log((o.blocks||[]).filter(b=>b.visibility==='granted').map(b=>b.id).join(' '))}catch(e){console.log('')}
})" <"$TMP/body")"
if [[ -n "$GRANT_IDS" && -n "${ALICE_ID:-}" ]]; then
  note "该页的 granted 块 id: $GRANT_IDS"
  for bid in $GRANT_IDS; do
    sc="$(req "$JAR_ADMIN" POST "/api/pages/$(enc mixed-visibility)/blocks/$bid/grants" \
          "{\"subjectKind\":\"user\",\"subjectId\":\"$ALICE_ID\",\"role\":\"viewer\"}")"
    if [[ "$sc" == "200" || "$sc" == "201" ]]; then
      ok "block $bid ⇒ 已授予 $ALICE_EMAIL"
    else
      bad "block $bid 授予失败（$sc: $(body | head -c 160)）"
    fi
  done
else
  bad "未能取到 granted 块（ids='$GRANT_IDS', aliceId='${ALICE_ID:-}'）"
fi

# ---------------- 7. 校验 ----------------
echo
echo "[7/7] 灌完后自检"

# 匿名列表：只应含公开页
sc="$(code_anon /api/pages)"
ANON_LIST="$(body)"
echo "$ANON_LIST" | grep -q '"welcome"' && ok "匿名列表含 welcome（公开）" || bad "匿名列表缺 welcome"
echo "$ANON_LIST" | grep -q '"mixed-visibility"' && ok "匿名列表含 mixed-visibility（公开）" || bad "匿名列表缺 mixed-visibility"
echo "$ANON_LIST" | grep -q '"secrets"' && bad "匿名列表**泄**了 secrets！" || ok "匿名列表不含 secrets"
echo "$ANON_LIST" | grep -q '"team-handbook"' && bad "匿名列表**泄**了 team-handbook！" || ok "匿名列表不含 team-handbook"

# 匿名读受限段：唯一串必须 0 次命中
sc="$(code_anon "/api/pages/$(enc mixed-visibility)")"
BODY_ANON="$(body)"
if [[ "$sc" == "200" ]]; then ok "匿名可读 mixed-visibility（200）"; else bad "匿名读 mixed-visibility 返回 $sc"; fi
if echo "$BODY_ANON" | grep -qF "$ORG_TOKEN"; then bad "匿名响应体里出现了 $ORG_TOKEN（块级泄漏！）"; else ok "匿名响应体不含 $ORG_TOKEN（0 次命中）"; fi
if echo "$BODY_ANON" | grep -qF "$GRANT_TOKEN"; then bad "匿名响应体里出现了 $GRANT_TOKEN（块级泄漏！）"; else ok "匿名响应体不含 $GRANT_TOKEN（0 次命中）"; fi
echo "$BODY_ANON" | grep -q '需登录查看' && ok "能看到占位文案（需登录查看）" || bad "看不到占位文案"

# 匿名读组织/私有页：404
for s in team-handbook secrets; do
  sc="$(code_anon "/api/pages/$(enc "$s")")"
  [[ "$sc" == "404" ]] && ok "匿名读 $s ⇒ 404（不泄露存在性）" || bad "匿名读 $s ⇒ $sc（期望 404）"
done

# 成员视角：组织段与「被授予的段」都应可见
JAR_ALICE="$TMP/jar-ALICE_ID.txt"
if [[ -f "$JAR_ALICE" ]]; then
  sc="$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$JAR_ALICE" "$BASE/api/pages/$(enc mixed-visibility)")"
  BODY_ALICE="$(body)"
  [[ "$sc" == "200" ]] && ok "成员可读 mixed-visibility（200）" || bad "成员读 mixed-visibility 返回 $sc"
  echo "$BODY_ALICE" | grep -qF "$ORG_TOKEN" && ok "成员能看到组织段（$ORG_TOKEN 命中）" || bad "成员看不到组织段"
  echo "$BODY_ALICE" | grep -qF "$GRANT_TOKEN" && ok "成员能看到**被授予的段**（$GRANT_TOKEN 命中）" || bad "成员看不到被授予的段 —— 块级授予没生效"
  sc="$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$JAR_ALICE" "$BASE/api/pages/$(enc team-handbook)")"
  [[ "$sc" == "200" ]] && ok "成员可读组织页 team-handbook（200）" || bad "成员读 team-handbook 返回 $sc"
  sc="$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$JAR_ALICE" "$BASE/api/pages/$(enc secrets)")"
  [[ "$sc" == "404" ]] && ok "成员读私有页 secrets ⇒ 404（按设计不给 403，避免存在性探测）" || bad "成员读 secrets 返回 $sc（期望 404）"
fi
# 未被授予的成员（鲍勃）：组织段可见、被授予的段不可见 —— 证明授予是**指名**的
JAR_BOB="$TMP/jar-BOB_ID.txt"
if [[ -f "$JAR_BOB" ]]; then
  curl -s -o "$TMP/body" -b "$JAR_BOB" "$BASE/api/pages/$(enc mixed-visibility)"
  BODY_BOB="$(body)"
  echo "$BODY_BOB" | grep -qF "$ORG_TOKEN" && ok "未获授予的成员能看到组织段" || bad "未获授予的成员看不到组织段"
  echo "$BODY_BOB" | grep -qF "$GRANT_TOKEN" && bad "未获授予的成员**竟然**看到了被授予的段（授权泄漏！）" || ok "未获授予的成员看不到被授予的段（$GRANT_TOKEN 0 次命中）"
fi

echo
echo "=== 自检：$PASS 通过 / $FAIL 失败 ==="
echo
echo "接下来请人工看这几件事（脚本不代做，因为要浏览器/多身份）："
echo "  1. 用 $ADMIN_EMAIL / $ADMIN_PASS 登录，打开 #/wiki/mixed-visibility，看清公开段与两处占位"
echo "  2. 用 $ALICE_EMAIL / $MEMBER_PASS 登录 —— 组织段与「被授予的那段」都应显示出来"
echo "  3. 退出登录（匿名）再看同一页 —— 两段都只剩占位，且页面源码里搜不到 $ORG_TOKEN / $GRANT_TOKEN"
echo "  4. 搜索：匿名搜 TEAMONLY5522 应无结果；成员搜应命中 team-handbook"
exit $((FAIL > 0))
