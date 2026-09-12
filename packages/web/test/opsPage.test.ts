/**
 * **审计与运维页（P4）的声明级不变量** —— 源码级守卫。
 * ============================================================================
 *
 * 为什么用源码级而不是渲染级：`OpsPage` 跑起来要整套 React + Radix + 路由 + fetch，
 * 而这里要钉的三条本质上是**声明点**问题。仓库既有先例就是这么做的
 * （`navPlan.test.ts`、`authCacheInvalidation.test.ts`、`breadcrumb.test.ts`）。
 *
 * ## ⚠️ 本文件刻意先**剥掉注释**再断言
 *
 * 文本型守卫有一个固有陷阱：**"解释为什么不能这么写"的注释本身会含那个字面量**。
 * 本仓库已经踩过同类的坑（`App.tsx` 的 `ADMIN_NAV` 注释里写了能力键字面量，
 * 把 `navPlan.test.ts` 的计数正则多数出一个；迁移注释里写 `ADD COLUMN` 被
 * 可重放性守卫误判）。
 *
 * 所以下面所有断言都跑在 `codeOnly()` 的结果上：块注释与行注释先被剥掉。
 * 负向断言（"不得出现 X"）天然需要这个处理；正向断言一并沿用，保证两者看的是
 * **同一段代码**，不会出现"正向在注释里命中、负向在代码里没命中"这种自相矛盾。
 *
 * 守卫如何避免"空洞通过"：每段正则都配一条**反空洞断言**（先证明抽取到了东西、
 * 再断言内容）。正则写坏会立刻变红，而不是静默通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 剥掉块注释与行注释。见文件头：注释里会写"为什么不能这么写"，那本身会命中
 * 负向断言，制造假阳性。JSX 文本不是注释，不受影响。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const opsRaw = readFileSync(join(here, '../src/pages/OpsPage.tsx'), 'utf8')
const appRaw = readFileSync(join(here, '../src/App.tsx'), 'utf8')
const ops = codeOnly(opsRaw)
const app = codeOnly(appRaw)

test('反空洞：剥注释后代码仍在（防止正则把整个文件剥没了）', () => {
  assert.ok(ops.length > 500, `剥注释后仍应有大量代码（实际 ${ops.length} 字符）`)
  assert.ok(ops.includes('export function OpsPage'), '剥注释后应仍能看到 OpsPage 的定义')
  assert.ok(ops.length < opsRaw.length, '剥注释应确实减少了内容')
})

test('OpsPage：两类审计**各自取数**（不是取一次 all 再在前端筛）', () => {
  const security = ops.match(/view: 'security'/g) ?? []
  const acl = ops.match(/view: 'acl'/g) ?? []
  // 反空洞：先证明两个 view 字面量确实出现过
  assert.equal(security.length, 1, `应有且仅有一次 view:'security' 取数（实际 ${security.length}）`)
  assert.equal(acl.length, 1, `应有且仅有一次 view:'acl' 取数（实际 ${acl.length}）`)
  // 负向：不得退化成"取 all 再自己分"
  assert.doesNotMatch(
    ops,
    /view: 'all'/,
    "不得取 view:'all' 再在前端分类 —— 那等于把服务端的白名单抄了第二份",
  )
})

test('OpsPage：越权告警与权限变更渲染成**两个独立区块**', () => {
  const renderer = ops.match(/const auditTable = /g) ?? []
  // 反空洞：渲染器必须存在，否则下面的"调用两次"毫无意义
  assert.equal(renderer.length, 1, `应存在唯一的 auditTable 渲染器（实际 ${renderer.length}）`)
  const calls = ops.match(/auditTable\(/g) ?? []
  assert.equal(calls.length, 2, `auditTable 应被调用两次（安全事件 + 权限变更），实际 ${calls.length}`)
  assert.match(ops, /auditTable\(\s*'越权尝试（安全事件）'/, '第一个区块应是越权告警')
  assert.match(ops, /auditTable\('权限变更（合规记录）'/, '第二个区块应是权限变更')
})

test('OpsPage：文案不得把「回收」说成「让过期失效」', () => {
  // 反空洞：先证明确实写了"只做空间回收"这句
  assert.match(ops, /只做空间回收/, '应显式说明回收只是回收')
  // 负向：不得出现暗示"不回收就仍有效"的措辞（跑在剥注释后的代码上）
  assert.doesNotMatch(
    ops,
    /清理失效|失效授权|让过期[^']*失效/,
    '文案不得暗示"不回收 ⇒ 过期授权仍然有效" —— 那是失败开放方向',
  )
})

test('OpsPage：ipHash 不得被当作 IP 展示', () => {
  assert.match(ops, /哈希不是原文/, '会话表必须显式说明 ip 列是哈希（否则运维会把它当 IP 用）')
})

test('App：审计入口与其余运维入口**同一判据**（不新开能力字段）', () => {
  assert.match(
    app,
    /id: 'audit'[^\n]*requires: 'administer'/,
    "audit 入口必须声明 administer（AuthCapabilities 只有三个键，不新开字段）",
  )
  assert.match(app, /active === 'audit'\) body = <OpsPage \/>/, 'audit 路由必须分派到 OpsPage')
})

/*
 * 反向展开的界面入口。
 *
 * 这条守卫的存在理由：`api.accessExplain` 曾经**定义好了却没有任何调用者** ——
 * 端点能用、界面进不去，等价于这个能力对运维不存在。源码级断言"有调用者"是最省的钉子，
 * 因为"定义了但没人用"恰恰是类型检查与构建都不会报的那类问题。
 */
test('OpsPage：反向展开有真实界面入口（否则 api.accessExplain 定义了也没人能用）', () => {
  const calls = ops.match(/api\.accessExplain\(/g) ?? []
  assert.ok(calls.length >= 1, 'OpsPage 必须真的调用 api.accessExplain（不能只 import 类型）')
  // 反空洞：确认它是被表单提交触发的，而不是某处顺手写了一句不会执行到的调用
  assert.match(ops, /onSubmit=\{/, '应有一个表单提交入口')
  assert.match(ops, /htmlFor="ops-explain-slug"/, 'Input 必须配 <label htmlFor>（Input 原语的无障碍要求）')
  assert.match(ops, /id="ops-explain-slug"/, 'label 的 htmlFor 必须能对应到输入框的 id')
})

/*
 * 「先确认、后执行」的顺序守卫。
 *
 * 三个破坏性端点（吊销会话 / 回收过期条目授权 / 回收过期邀请）都必须**先**过 `confirm(...)`。
 * 这类回归极隐蔽：把 `api.revokeSession(...)` 直接挪回 `onClick` 里，类型检查、构建、
 * 甚至大多数手工点击都不会报错 —— 只是危险操作少了一次确认。故用**源码位置**钉死顺序，
 * 且要求 api 调用保持字面量形态（不抽成变量再调），否则本守卫会失去着力点。
 */
test('OpsPage：危险操作先 confirm 再调 api（顺序不得倒过来）', () => {
  const firstConfirm = ops.indexOf('confirm(')
  // 反空洞：先证明 `confirm(` 确实出现过（注意 `useConfirm(` 是大写 C，不匹配）
  assert.ok(firstConfirm >= 0, 'OpsPage 应使用统一确认框（useConfirm 返回的 confirm）')
  for (const call of ['api.revokeSession(', 'api.purgeGrants(', 'api.purgeInvitations(']) {
    const at = ops.indexOf(call)
    assert.ok(at >= 0, `OpsPage 应调用 ${call}（端点改名时请同步更新本守卫）`)
    assert.ok(
      firstConfirm < at,
      `${call} 出现在首个 confirm( 之前 —— 危险操作会不经确认直接执行`,
    )
  }
  // 反空洞：确认请求必须真的被渲染出来，否则点了按钮只会什么都不发生
  assert.match(ops, /<ConfirmDialog/, '确认框必须渲染在页面上（有状态但没组件等于没有确认）')
})
