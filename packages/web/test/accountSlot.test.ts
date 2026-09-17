/**
 * 「外部身份（SSO）的界面归提供者插件」这条归属的守卫（2026-09-16）。
 *
 * 用户指出的现象：**没装 SSO 插件时，账号页照样显示讲企业 SSO 的空态**
 * ——那是一个指向不存在功能的界面。修法是把这块界面从宿主搬进 `@geewiki/oidc`
 * 通过插槽 `account-identities` 贡献，宿主只留「本地密码」。
 *
 * 这里钉三件事：
 *   ① 账号页不再出现任何 SSO 文案（宿主不认识这个概念），且真的渲染那个插槽；
 *   ② 插槽名在**唯一的真源**（core `slots.ts`，经 `@geewiki/core/slots` 转出给两个 web 文件）
 *      里声明，并且确实出现在两侧消费者的代码里；漏一处的症状是"插件声明被忽略/类型对不上"，
 *      都在很远的地方报错；
 *   ③ 它是**按需加载**的（只有账号页需要，匿名读者不该为此下载一份 SSO 界面）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const page = readFileSync(join(SRC, 'pages', 'AccountPage.tsx'), 'utf8')
const slots = readFileSync(join(SRC, 'lib', 'slots.tsx'), 'utf8')
const plan = readFileSync(join(SRC, 'lib', 'pluginUiPlan.ts'), 'utf8')
/*
 * 真源是 `core/src/slots.ts`。这里原先读的是 `core/src/index.ts` —— 白名单在本次改造中
 * 从 `index.ts`（顶层 `import 'node:fs'`，浏览器不可用）拆到 `slots.ts` 并开出
 * `@geewiki/core/slots` 子路径，web 侧的三份手抄镜像随之删除。
 */
const core = readFileSync(join(import.meta.dirname, '..', '..', 'core', 'src', 'slots.ts'), 'utf8')

test('账号页不出现 SSO 文案（宿主不认识"外部身份"），只留本地密码 + 插槽位', () => {
  // 注释里解释历史是允许的（它正是这次归属变更的记录），所以先剥注释再查文案
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(code, /SSO/, '代码里不得再出现 SSO')
  assert.doesNotMatch(code, /外部身份/, '也不得出现"外部身份"（那是插件的概念）')
  assert.doesNotMatch(code, /authLinkIdentity|authUnlinkIdentity|AuthIdentity/, '绑定/解绑与身份类型都归插件')
  assert.match(code, /<AccountIdentitiesSlotOutlet linkPending=\{linkPending\} \/>/, '必须渲染插槽位，并把"这次回跳要确认"的提示传下去')
  assert.match(code, /ensureSlotLoaded\('account-identities'\)/, '插槽是按需加载的，进页面时要触发')
  assert.match(code, /本地密码/, '核心那件事（本地密码状态）要留着')
})

test('提示由宿主传（插件不碰 location）：props 与"路由归宿主"这条纪律', () => {
  /*
   * 插件一度自己去读 `window.location.hash` 拿 `?link=required`——宿主守则明令禁止插件碰路由
   * （`pluginUi.test.ts` 的产物断言）。改成"宿主读、当 prop 传"之后，那条纪律不需要任何例外，
   * 插件也就被纳进了同一份守卫名单。
   */
  assert.match(slots, /export interface AccountIdentitiesSlotProps \{[\s\S]{0,120}?linkPending\?: boolean/, '宿主侧要声明这个 props')
  const oidcUi = readFileSync(join(import.meta.dirname, '..', '..', 'plugin-oidc', 'ui', 'index.tsx'), 'utf8')
  const oidcCode = oidcUi.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(oidcCode, /window\.location|location\.hash/, '插件不得读路由（提示由宿主传）')
  assert.match(oidcCode, /props: \{ readonly linkPending\?: boolean \}/, '插件要接受宿主传来的提示')
  assert.match(oidcCode, /const linkPending = props\.linkPending === true && !dismissed/, '宿主重复传 true 也不该把用户点掉的卡片翻回来')
})

test('插槽名声明在唯一真源里，且两侧消费者都用到 + 在按需清单里', () => {
  // 真源：core/src/slots.ts
  assert.match(core, /'account-identities'/, 'core slots.ts 里必须声明这个插槽名')
  // 两个 web 消费者：slots.tsx 用它做带 props 的组件收窄；pluginUiPlan.ts 列进按需清单
  assert.match(plan, /ON_DEMAND_SLOTS[\s\S]{0,400}?'account-identities'/, '必须列进按需加载清单')
  assert.match(
    plan,
    /from '@geewiki\/core\/slots'/,
    'pluginUiPlan.ts 必须从真源转出白名单（不得再手抄）',
  )
  // 带 props（只传一个路由提示），且**不在**零属性名单里
  assert.match(slots, /'account-identities': AccountIdentitiesSlotComponent/, '要按带 props 的组件收窄')
  assert.doesNotMatch(slots, /ZeroPropsSlotName = [^\n]*account-identities/, '它不再是零属性插槽')
})
