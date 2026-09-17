/**
 * 「审计与运维」的**归属**守卫：它现在是插件 `@geewiki/ops` 的页面，宿主不再拥有一份。
 * ============================================================================
 *
 * ## 为什么需要这个文件（它替换了原来的 `opsPage.test.ts`）
 *
 * 2026-09-17 把这一页从宿主页面（`packages/web/src/pages/OpsPage.tsx`，536 行）
 * 搬成了插件（见 `packages/plugin-ops/`）。搬迁最危险的**不是**"新代码不工作"，
 * 而是**旧代码留了一半**：
 *
 *   · 只删 `ADMIN_NAV` 条目、忘了删 `App.tsx` 的分派分支 ⇒ 分支永远赢，
 *     插件页面永远不渲染 —— 而它**不会报错**，只是"插件改了没效果"；
 *   · 只删分派分支、忘了把 `audit` 从 `RESERVED_ROUTE_IDS` 移出 ⇒
 *     插件那条路由声明会被 `resolveRouteDecls` 按"保留 id"**整条拒绝**，
 *     症状是导航项与页面一起消失，日志里同样什么都没有；
 *   · 忘了删宿主页面文件本身 ⇒ 它继续被 typecheck 与设计系统守卫扫描，
 *     下一个人会以为"宿主还有一份，改这里也行"。
 *
 * 三种都是**静默**的，所以必须由守卫钉住"宿主这边一点都不能剩"。
 *
 * ## 页面自身的判据搬去了插件
 *
 * 「两类审计分开取数」「回收文案不得说成让过期失效」「ipHash 不是 IP」
 * 「危险操作先 confirm 再调 api」这些**页面级**不变量现在住在
 * `packages/plugin-ops/test/opsUi.test.ts` —— 它们描述的是页面的行为，
 * 而页面已经不在这个包里了。留在这里只会变成"钉一个不存在的文件"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
/** 剥注释：解释"为什么不能这么写"的注释里必然引述旧写法（本仓库第 7 次踩这个坑） */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const app = codeOnly(readFileSync(join(WEB, 'src', 'App.tsx'), 'utf8'))

test('★ 宿主不再拥有 audit：导航项、分派分支、页面文件三样都不能剩', () => {
  assert.doesNotMatch(
    app,
    /\{\s*id:\s*'audit'/,
    'ADMIN_NAV 里不得再有 audit 条目 —— 它的导航项现在来自插件清单的 routes 声明',
  )
  assert.doesNotMatch(
    app,
    /active === 'audit'/,
    'App.tsx 不得再有 audit 的分派分支 —— 宿主分支优先级更高，留着它插件页面永远不渲染且不报错',
  )
  assert.equal(
    existsSync(join(WEB, 'src', 'pages', 'OpsPage.tsx')),
    false,
    'pages/OpsPage.tsx 必须已删除 —— 留着它会让下一个人以为"宿主还有一份，改这里也行"',
  )
})

test('★ audit 必须已从 RESERVED_ROUTE_IDS 移出（否则插件那条声明会被整条拒绝）', async () => {
  const core = await import('@geewiki/core/domain')
  assert.ok(core.RESERVED_ROUTE_IDS.length > 0, '反空洞：保留清单不得为空')
  assert.equal(
    core.RESERVED_ROUTE_IDS.includes('audit'),
    false,
    'audit 仍在保留清单里 ⇒ @geewiki/ops 的 routes 声明会被 resolveRouteDecls 按"保留 id"拒绝，' +
      '症状是导航项与页面一起消失、且没有任何报错',
  )
  // 反空洞：其余保留项必须还在（否则"移出 audit"可能是把整份清单删空了）
  for (const id of ['wiki', 'plugins', 'org', 'login', 'account', 'notfound']) {
    assert.ok(core.RESERVED_ROUTE_IDS.includes(id), `${id} 应当仍在保留清单里`)
  }
})

test('★ 归属必须真的落在插件清单上（不能只是从宿主删掉）', () => {
  const manifest = codeOnly(readFileSync(join(WEB, '..', 'plugin-ops', 'src', 'index.ts'), 'utf8'))
  assert.match(
    manifest,
    /id:\s*'audit'[\s\S]{0,200}?requires:\s*'administer'/,
    '插件清单必须声明 audit 路由，且判据是 administer（与其余运维入口同一判据）',
  )
  assert.match(manifest, /group:\s*'admin'/, "必须声明 group: 'admin' —— 否则它不会出现在「管理 ▾」里")
  assert.match(manifest, /client:\s*\{[\s\S]*?entry:\s*'client\.js'/, '必须声明前端产物入口')
})

test('★ 其余运维入口照旧在宿主里（搬迁不得顺手删掉别的）', () => {
  assert.match(app, /\{\s*id:\s*'plugins'/, '「插件管理」必须仍在 ADMIN_NAV 里')
  assert.match(app, /\{\s*id:\s*'org'/, '「组织」必须仍在 ADMIN_NAV 里')
})