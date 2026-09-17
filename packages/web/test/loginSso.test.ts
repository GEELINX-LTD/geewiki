/**
 * ★ 登录页：SSO 不可用时**什么都不渲染**。
 *
 * ## 这条守卫防的是一次真实回退
 * 登录页曾经在 SSO「已配置但连不上」时渲染一条告警：
 * 「SSO 不可用 —— 已配置的单点登录当前无法连接（unreachable），本地账号登录不受影响」。
 * 它已被删除，理由见 `LoginPage.tsx` 头部的第 5 条（匿名访客不可操作、
 * 向未认证者暴露内部配置状态、与"账号页 SSO 界面归还给提供者插件"的原则冲突）。
 *
 * 删除这类提示的风险是**它会被人以"这是有用的诊断信息"为由加回来**，
 * 所以这里把它变成一条会在 CI 里响的判据，而不是只写在注释里。
 *
 * ## 为什么是源码级
 * web 的测试跑在 node 下、**没有 DOM**（仓库里没有 jsdom），无法渲染组件后断言
 * "页面上没有这几个字"。源码级判据是这里唯一可行的形式，代价是它**必须先剥注释**：
 * 本页头部那段解释里就原样引述了被删的文案，不剥注释会把解释本身当违规 ——
 * 这个坑本仓库已经踩过两次（脚手架生成器、迁移方言守卫），规则相同：
 * **判据要能区分"代码里写了"与"注释里提到"。**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'src', 'pages', 'LoginPage.tsx'), 'utf8')

/** 剥掉块注释与整行注释 —— 只留下会真正执行的代码 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const CODE = codeOnly(SOURCE)

test('★ 登录页不得渲染任何「SSO 不可用」提示（含原因与徽标）', () => {
  // 先断言剥注释没有把整份代码剥空：判据写坏时后面的断言会**空集通过**
  assert.ok(CODE.includes('oidc'), '剥注释后连 oidc 都没了——判据可能已失效')

  assert.doesNotMatch(CODE, /SSO\s*不可用/, '不得再渲染「SSO 不可用」')
  assert.doesNotMatch(CODE, /oidc\?\.available\s*===\s*false/, '不得再对"不可用"分支渲染任何东西')
  assert.doesNotMatch(CODE, /oidc\.reason/, '不得把内部失败原因渲染到匿名页面上')
  assert.doesNotMatch(CODE, /Badge\s+tone="warn"/, '不得用告警徽标提示 SSO 状态')
})

test('★ 登录页的 SSO 卡片仍只在可用时出现（这条是功能，不是告警）', () => {
  // 删除的是「不可用告警」，**不是** SSO 入口本身：可用时那条真实链接必须还在
  assert.match(CODE, /oidc\?\.available\s*===\s*true/, 'SSO 入口必须以 available === true 为条件')
  assert.match(CODE, /href=\{ssoHref\}/, 'SSO 入口必须是真实链接（走完整导航才能完成 IdP 回跳）')
  assert.match(CODE, /oidc\.startPath/, '起点路径来自服务端下发的能力，不在前端拼')
})

test('★ 登录页的 SSO 入口不得变成 onClick 跳转', () => {
  // 注释里已写明理由（fetch/JS 跳转会因跨站与 cookie 语义失败），这里把它钉住
  assert.doesNotMatch(CODE, /onClick=\{\(\)\s*=>\s*[^}]*oidc/, 'SSO 入口不得走 onClick')
})
