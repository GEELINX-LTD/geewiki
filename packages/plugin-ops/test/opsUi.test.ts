/**
 * 「审计与运维」插件的**声明级不变量** —— 源码级守卫。
 *
 * ## ⚠️ 本文件先**剥掉注释**再断言
 *
 * 文本型守卫有一个固有陷阱：**"解释为什么不能这么写"的注释本身会含那个字面量**。
 * 本仓库已经踩过六次（脚手架生成器、迁移方言守卫、附件探针守卫、表格守卫、
 * 选区/xyflow 守卫、编辑器高度守卫）。本文件尤其要紧 —— 上面每一段说明都在引述旧写法。
 *
 * 每段正则都配一条**反空洞断言**（先证明抽到了东西、再断言内容），
 * 否则一次路径写错就会让"0 处违规"退化成"0 个文件"，测试照样全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8')
/** 剥块注释与行注释：见文件头 */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const server = read('../src/index.ts')
const uiRaw = read('../ui/index.tsx')
const apiRaw = read('../ui/api.ts')
const ui = codeOnly(uiRaw)
const api = codeOnly(apiRaw)

test('反空洞：剥注释后代码仍在', () => {
  assert.ok(ui.length > 3000, `剥注释后 ui/index.tsx 应仍有大量代码（实际 ${ui.length} 字符）`)
  assert.ok(ui.length < uiRaw.length, '剥注释应确实减少了内容')
  assert.ok(api.length > 1000, `剥注释后 ui/api.ts 应仍有代码（实际 ${api.length} 字符）`)
})

/*
 * ★ 最重要的一条。
 *
 * 路由 id 在**两个地方**各写一遍：清单的 `routes[0].id`（宿主据此渲染导航项、
 * 决定产物是否可推迟）与 `registerRoute('audit', …)`（宿主据此把组件挂到那个 id 上）。
 * 两者不一致的症状**完全没有报错**：导航项在（它来自入口表，不需要 bundle），
 * 点进去是一片空白 —— 而"路由未注册"的告警也不会出现，因为那个 id 确实被声明过。
 */
test('★ 清单声明的路由 id 与客户端注册的 id 必须逐字一致', () => {
  const declared = /routes:\s*\[\s*\{[^}]*id:\s*'([a-z0-9-]+)'/.exec(codeOnly(server))
  assert.ok(declared, '未能从清单里抽出 routes[0].id（判据失效即红）')
  const registered = /registerRoute\(\s*'([a-z0-9-]+)'/.exec(ui)
  assert.ok(registered, '未能抽出 registerRoute 的 id（判据失效即红）')
  assert.equal(
    registered[1],
    declared[1],
    `清单声明的是 "${declared[1]}"，客户端注册的是 "${registered[1]}" —— ` +
      '不一致时导航项照常出现、点进去一片空白且没有任何报错',
  )
  assert.equal(declared[1], 'audit', '这一页的 id 是 audit（宿主路由首段）')
})

/*
 * 两类审计**必须各自取数**，不得取 `view: 'all'` 再在前端分类。
 *
 * 服务端用显式白名单（`SECURITY_ACTIONS` / `ACL_ACTIONS`）把"要告警"与"要留存"分开，
 * 理由是"有人在探测权限边界"会被"某人改了可见性"稀释掉 —— 而两者的处置完全不同。
 * 前端取 `all` 再自己分，等于把那套白名单抄了第二份，且漂移是**静默**的：
 * 只是某类事件不再出现在它该在的那张表里。
 */
test('★ 两类审计各自取数，不得取 view: all 再在前端分类', () => {
  const security = ui.match(/view="security"/g) ?? []
  const acl = ui.match(/view="acl"/g) ?? []
  assert.equal(security.length, 1, `应有且仅有一次 view="security"（实际 ${security.length}）`)
  assert.equal(acl.length, 1, `应有且仅有一次 view="acl"（实际 ${acl.length}）`)
  assert.doesNotMatch(ui, /view="all"|view: 'all'/, "不得取 view:'all' 再在前端分类")
  // 反空洞：两个 view 必须真的走到取数函数上（只渲染不取数等于两张空表）
  assert.match(ui, /fetchAudit\(props\.view/, '取数必须用当前分区的 view')
})

/*
 * 「回收」不能写成"让过期授权失效"。
 *
 * 过期失效在**判定时**就已经发生（判定层比较 `expires_at`），这两个按钮只做空间回收。
 * 若文案暗示"不点它 ⇒ 过期授权仍然有效"，运维会形成**失败开放**方向的心智模型。
 */
test('★ 「回收」不得被说成「让过期失效」', () => {
  assert.match(ui, /只做空间回收/, '应显式说明回收只是回收')
  assert.doesNotMatch(
    ui,
    /清理失效|失效授权|让过期[^']*失效/,
    '文案不得暗示"不回收 ⇒ 过期授权仍然有效" —— 那是失败开放方向',
  )
})

test('★ ipHash 必须写明是哈希（否则运维会把它当 IP 用）', () => {
  assert.match(ui, /哈希/, '会话表必须显式说明 ip 列是哈希不是原文')
})

/*
 * 危险操作必须**先确认再执行**。
 *
 * 这类回归极隐蔽：把 `revokeSession(...)` 直接挪回 `onClick` 里，类型检查、构建、
 * 甚至大多数手工点击都不会报错 —— 只是危险操作少了一次确认。故用**源码位置**钉死顺序。
 */
test('★ 危险操作先 confirm 再调 api（顺序不得倒过来）', () => {
  const firstConfirm = ui.indexOf('props.confirm(')
  assert.ok(firstConfirm >= 0, '应存在确认入口')
  for (const call of ['revokeSession(', 'revokeUserSessions(', 'purgeGrants(', 'purgeInvitations(', 'resyncBlocks(']) {
    const at = ui.indexOf(call)
    assert.ok(at >= 0, `应调用 ${call}（端点改名时请同步更新本守卫）`)
    assert.ok(firstConfirm < at, `${call} 出现在首个 props.confirm( 之前 —— 危险操作会不经确认直接执行`)
  }
})

/*
 * ★ 本轮"功能性优化"的核心：四个此前**零入口**的端点必须有调用者。
 *
 * 这条守卫存在的理由与宿主 `opsPage.test.ts` 里那条（`api.accessExplain` 曾经
 * "定义好了却没有任何调用者"）完全相同：**"定义了但没人用"恰恰是类型检查与构建
 * 都不会报的那类问题** —— 端点能用、界面进不去，等价于这个能力对运维不存在。
 */
test('★ 四个此前无入口的能力都必须有真实界面入口', () => {
  for (const [fn, path] of [
    ['verifySearchIndex', '/api/admin/search/verify'],
    ['verifyBlocks', '/api/admin/blocks/verify'],
    ['resyncBlocks', '/api/admin/blocks/resync'],
    ['revokeUserSessions', '/api/admin/users/'],
  ] as const) {
    assert.match(api, new RegExp(`${fn}`), `api.ts 应导出 ${fn}`)
    assert.ok(api.includes(path), `api.ts 里 ${fn} 的路径应含 ${path}`)
    assert.match(ui, new RegExp(`${fn}\\(`), `${fn} 必须被界面真的调用（不能只 import 类型）`)
  }
})

/*
 * `before` / `after` 必须真的被渲染。
 *
 * 这两个字段一直有数据，而旧界面从来没显示过 —— 于是「谁在什么时候改了哪条可见性」
 * 这张表**答不出"改成了什么"**，而那正是合规记录的全部意义。
 */
test('★ 审计表必须渲染 before → after（合规记录要答得出"改成了什么"）', () => {
  assert.match(ui, /changedFields\(/, '必须用 changedFields 展开差异')
  const plan = codeOnly(read('../ui/plan.ts'))
  assert.match(plan, /before\?: unknown/, 'AuditEntry 的形状里 before 必须仍在（端点契约，定义在纯判据层）')
  assert.match(plan, /after\?: unknown/, 'AuditEntry 的形状里 after 必须仍在（端点契约）')
})

/*
 * 筛选与分页必须真的接上后端的查询参数。
 *
 * 此前是写死的 `limit: 50`、一页到底 —— 而"上周谁动过权限"这种问题在大库上答不出来。
 */
test('★ 审计查询必须走 auditQuery（筛选 + 分页真的用上了）', () => {
  assert.match(api, /auditQuery\(/, 'api.ts 应经 auditQuery 构造查询串')
  assert.match(ui, /fetchAudit\(/, '界面必须调用 fetchAudit')
  assert.match(ui, /setApplied\(/, '筛选必须真的提交（否则输入框只是个摆设）')
})

test('★ CSRF 头不得遗漏（漏了则所有写动作 403，界面表现是"点了没反应"）', () => {
  assert.match(api, /'x-gw-csrf':\s*'1'/, '每个请求都要带 x-gw-csrf（服务端在带会话 cookie 时强制校验）')
  assert.match(api, /credentials:\s*'same-origin'/, '会话走 cookie')
})

test('插件不得自带框架：react 是唯一的外部依赖（产物里不许出现第二份 React）', () => {
  // 插件 UI 只从 'react' 取东西；出现 'react-dom' 的 import 就意味着产物会打进第二份实例
  assert.doesNotMatch(ui, /from 'react-dom/, '插件 UI 不得 import react-dom')
  assert.match(ui, /from 'react'/, '插件 UI 从 react 取 hooks（由宿主 import map 解析到同一个实例）')
})