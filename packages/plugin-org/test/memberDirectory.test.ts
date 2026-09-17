/**
 * **成员 / 用户组名单的可见性**（★ 本批放宽）—— 源码级守卫。
 * ============================================================================
 *
 * ## 为什么放宽（作者要求）
 *
 * 授权要填一个 `subjectId`（数据库 id），而"这个人到底是谁"只能靠名单认：
 * 改页面/段落权限只需要 `manageVisibility`（**组织成员也有**），可名单端点原本要**管理员**
 * ⇒ 出现"有权授权、却只能凭记忆猜一个数字 id"的人（作者的原话："授权时，所谓的 id 是什么"）。
 * 现在：**任何登录用户都能读名单**（`{ access: 'user' }`），选择框因此对所有人可用。
 *
 * ## 放宽的边界（明说，不静默）
 *
 * - **读**名单（成员：id/邮箱/姓名/组织角色/加入时间；用户组：id/名字/成员 id）⇒ 登录即可；
 * - **写**（成员角色、邀请、建组、组的成员增删）⇒ **仍然只有管理员**；
 * - `GET /api/org/invitations`（含尚未加入的人与邀请状态）⇒ **仍然只有管理员**。
 *
 * 邮箱被刻意留在成员列表里：重名时它是唯一能区分"授权给谁"的信息。
 *
 * ## 为什么源码级而不是跑起来打请求
 *
 * 这里要钉的是**路由的声明点**（`access` 级别 + 处理器里有没有那道 admin 门）——
 * 它们决定了所有调用方的可见性，而 `plugin-org` 目前没有 HTTP 夹具（本仓的夹具在
 * `plugin-wiki` / `server` 里）。真渲染侧由端到端验收覆盖：脚本最后一段以**普通成员**
 * 登录，断言选择框里真的列出了成员（`scripts/acceptance/editor-modes-cdp.mjs` 的 O 步）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'index.ts')

/** 去掉块注释与行注释（负向断言必须先剥：注释里就写着 `requireAdmin` 的解释） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const raw = readFileSync(SRC, 'utf8')
const code = codeOnly(raw)

/**
 * 取某个路由注册的**整段**源码：从 `'<method>'` 起，到该注册调用的 `{ access: … }` 为止。
 * 比"整文件 includes"稳得多 —— 后者只要文件里任何地方出现过 `access: 'user'` 就会绿。
 */
function routeBlock(method: string, path: string): string {
  const at = code.indexOf(`'${method}',\n        '${path}'`)
  assert.ok(at > 0, `反空洞：应能定位 ${method} ${path} 的注册`)
  const end = code.indexOf('{ access:', at)
  assert.ok(end > at, `反空洞：${method} ${path} 应带 access 声明`)
  const close = code.indexOf('}', end)
  return code.slice(at, close + 1)
}

test('成员名单：登录用户可读，且处理器里不再有 admin 门', () => {
  const block = routeBlock('GET', '/api/org/members')
  assert.match(block, /\{ access: 'user' \}/, 'GET /api/org/members 必须是 access: user（登录即可读名单）')
  assert.doesNotMatch(block, /requireAdmin/, '处理器里不得再拦 admin —— 那会让非管理员选不了授权对象')
  // 正向锚点：这个端点仍然要真的去查成员（防止把整段删掉也算"通过"）
  assert.match(raw, /GET \/api\/org\/members/, '端点仍在（注释里的标题即正向锚点）')
})

test('用户组名单：登录用户可读（组是授权对象，看不见就选不了）', () => {
  const block = routeBlock('GET', '/api/org/groups')
  assert.match(block, /\{ access: 'user' \}/, 'GET /api/org/groups 必须是 access: user')
  assert.doesNotMatch(block, /requireAdmin/, '处理器里不得再拦 admin')
  assert.match(raw, /GET \/api\/org\/groups/, '端点仍在')
})

test('写操作与邀请名单**仍然只有管理员**（放宽的边界必须守住）', () => {
  // 写：改成员角色、建组/改组/删组
  for (const [method, path] of [
    ['PUT', '/api/org/members/:userId'],
    ['POST', '/api/org/groups'],
    ['DELETE', '/api/org/groups/:id'],
  ] as const) {
    const block = routeBlock(method, path)
    assert.match(block, /\{ access: 'admin' \}/, `${method} ${path} 必须仍是 access: admin`)
  }
  // 邀请：含尚未加入的人与邀请状态 ⇒ 不放宽
  const inv = routeBlock('GET', '/api/org/invitations')
  assert.match(inv, /\{ access: 'admin' \}/, 'GET /api/org/invitations 必须仍是 access: admin')

  /*
   * 反向锚点：文件里必须**仍然**存在 admin 门（否则"放宽"就成了"全放开"）。
   * 用计数而不是布尔，改动方向一眼可见。
   */
  const adminRoutes = (code.match(/\{ access: 'admin' \}/g) ?? []).length
  const userRoutes = (code.match(/\{ access: 'user' \}/g) ?? []).length
  assert.ok(adminRoutes >= 8, `管理端点仍应是多数（admin=${adminRoutes}）`)
  assert.equal(userRoutes, 4, `user 级端点应恰为 4 个（org 概览 + members + groups + 一个既有端点），实际 ${userRoutes}`)
})
