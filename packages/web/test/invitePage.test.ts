/**
 * 「凭邀请码自助开户」的**链路守卫**：链接形态 → 路由 → 开户 → 自动登录。
 * ============================================================================
 *
 * ## 这条链路此前是断的
 *
 * 服务端有 `POST /api/org/invitations/redeem`（匿名可调、凭 256 位熵的令牌开户），
 * 而**界面上没有任何地方消费那个令牌**：卡片把令牌显示成「邀请链接」并给一个
 * 「复制链接」按钮，但那个"链接"没有路由会处理它（全仓 grep 不到 `#/invite`、
 * `invite=`、`redeemInvitation`）。于是**要开一个本地账号，被邀请人必须自己发 HTTP 请求**
 * —— `scripts/seed-demo.sh` 与四个 e2e 脚本就是这么干的。
 *
 * ## 为什么这些断言必须是"跨文件"的
 *
 * 断链的每一段单看都是对的：卡片拼了一个链接、App 有分派、服务端有端点。
 * 出问题的地方**全在接缝上**，而接缝不报错：
 *   · 卡片拼的是 `#/invite/<t>` 而路由认的是 `invites` ⇒ 点开落 notfound；
 *   · `invite` 忘了进 `AUTH_ROUTES` ⇒ 未登录时被引去登录页，开户页**永远看不到**；
 *   · 忘了进 `RESERVED_ROUTE_IDS` ⇒ 某个插件可以合法占用 `invite`，把它顶掉；
 *   · 开户成功后没调 `login` ⇒ 用户"注册成功了"却停在未登录状态。
 *
 * 所以下面刻意把这几处**放在同一条断言里**比对，而不是各测各的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const here = import.meta.dirname
/** 剥注释：本仓第 N 次踩这个坑 —— 解释"为什么不能这么写"的注释本身含那个字面量 */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const appRaw = readFileSync(join(SRC, 'App.tsx'), 'utf8')
const app = codeOnly(appRaw)
const page = codeOnly(readFileSync(join(SRC, 'pages', 'InvitePage.tsx'), 'utf8'))
const card = codeOnly(readFileSync(join(SRC, 'components', 'org', 'InvitationsCard.tsx'), 'utf8'))
const account = codeOnly(readFileSync(join(SRC, 'pages', 'AccountPage.tsx'), 'utf8'))
const core = codeOnly(readFileSync(join(here, '..', '..', 'core', 'src', 'domain.ts'), 'utf8'))
const api = codeOnly(readFileSync(join(SRC, 'api.ts'), 'utf8'))

/* ============================== 链接 → 路由 ============================== */

test('★ 卡片拼出的链接形态、App 的分派、公开路由表、保留清单：四处必须对齐', () => {
  // ① 卡片真的拼出了 `#/invite/<token>`
  assert.match(
    card,
    /\/#\/invite\/\$\{/,
    '邀请卡片必须拼出 `#/invite/<token>` 形态的链接 —— 只给裸令牌，对方还得自己拼地址',
  )
  // ② App 认这个首段
  assert.match(app, /active === 'invite'/, 'App 必须有 invite 的分派分支')
  // ③ 且它被取成"首段之后的部分"（token）
  assert.match(
    app,
    /route\.slice\('invite'\.length\)/,
    "token 必须从路由首段之后取 —— 取错位置会拿到一个含 'invite/' 前缀的字符串，而服务端只会说「邀请无效」",
  )
  // ④ 未登录也要能到
  assert.match(
    app,
    /AUTH_ROUTES = \[[^\]]*'invite'/,
    'invite 必须进 AUTH_ROUTES：否则未登录访客会被引去登录页，而开户页的全部意义就是"此刻还没有账号"',
  )
  // ⑤ 插件不得占用它
  assert.match(core, /'invite'/, 'invite 必须在 RESERVED_ROUTE_IDS 里，否则插件可以合法顶掉这个页面')
  // 反空洞：确认上面几条看的是同一段代码，而不是某个文件读空了
  assert.ok(app.length > 3000 && card.length > 2000 && core.length > 3000)
})

/* ============================== 开户链路 ============================== */

test('★ 未登录分支：redeem → 自动登录 → 进知识库（缺一环就"注册成功了但仍未登录"）', () => {
  assert.match(page, /api\.redeemInvitation\(/, '必须调用 redeem 开户')
  assert.match(page, /redeemInvitation\(\{[\s\S]{0,220}?token,/, '必须把路由里的令牌交出去')
  assert.match(page, /email: trimmedEmail/, '必须把用户自填的邮箱交出去（通用码下这是唯一来源）')
  /*
   * ★ 自动登录这一步不能省：`redeem` **刻意不建会话**（会话的建立属身份域），
   * 少了这次 `login`，用户会看到"创建成功"然后停在一个未登录的页面上。
   */
  assert.match(page, /await login\(/, '开户成功后必须接着登录（redeem 不建会话）')
  assert.match(page, /window\.location\.hash = '\/wiki'/, '登录后应进知识库')
  // 反空洞：login 的入参必须是刚才开户用的那对凭据
  assert.match(page, /await login\(trimmedEmail, password\)/, '必须用刚设的邮箱口令登录')
})

test('★ 已登录分支：走 accept 入伙，不再开户', () => {
  assert.match(page, /api\.acceptInvitation\(/, '已登录时应凭码入伙（accept），而不是再走一次注册')
  assert.match(page, /auth\.authenticated/, '两条分支按"有没有登录"分开')
})

test('邀请页不得把令牌写进任何持久位置（它只应存在于当前事务的内存与路由参数里）', () => {
  const raw = readFileSync(join(SRC, 'pages', 'InvitePage.tsx'), 'utf8')
  assert.doesNotMatch(raw, /localStorage|sessionStorage/, '令牌不得写入本地存储')
  assert.doesNotMatch(raw, /console\./, '令牌不得进控制台')
  assert.doesNotMatch(
    raw,
    /token[\s\S]{0,40}location\.hash\s*=/,
    '不得把令牌再写回 location（它已经在路由里了，再写一次只会多一处历史记录）',
  )
})

/* ============================== 账号页：两个"有端点没界面"的补口 ============================== */

test('★ 账号页必须真的接上「改资料」与「改口令」（它们此前调用者数量都是 0）', () => {
  assert.match(api, /authProfile:/, 'api.ts 要定义 authProfile')
  assert.match(api, /authChangePassword:/, 'api.ts 要定义 authChangePassword')
  assert.match(account, /api\.authProfile\(/, '账号页必须调用 authProfile —— 否则端点能用、界面进不去')
  assert.match(account, /api\.authChangePassword\(/, '账号页必须调用 authChangePassword（此前全仓 0 个调用者）')
})

test('★ 改邮箱必须带当前口令（它是登录标识符，只凭会话 cookie 改等于账号接管）', () => {
  const call = /api\.authProfile\(\{([\s\S]*?)\}\)/.exec(account)
  assert.ok(call, '未能抽出 authProfile 的调用（判据失效即红）')
  assert.match(call[1] as string, /currentPassword/, 'authProfile 必须带 currentPassword')
  assert.match(
    account,
    /type="password"[\s\S]{0,120}?name="currentPassword"/,
    '资料表单里要有一个当前口令输入框（不能只靠状态里的 secret）',
  )
})

test('★ 资料表单必须挡住空值 —— 服务端把空串解释成"这一项不改"', () => {
  /*
   * 服务端的语义是"空串 = 不改"（见 `POST /api/auth/profile`）。所以用户清空用户名后提交，
   * 会得到"什么都没发生"——而那是**最坏的一种反馈**：他会以为改成功了。
   * 这一层必须在前端挡住，并且是**显式报错**而不是默默不发请求。
   */
  assert.match(account, /邮箱不能为空/, '必须挡住空邮箱')
  assert.match(account, /用户名不能为空/, '必须挡住空用户名')
})

test('账号页不得泄露"外部身份"这个概念（界面归提供者插件）', () => {
  assert.doesNotMatch(account, /SSO/, '宿主页面不得出现 SSO 文案')
  assert.doesNotMatch(account, /外部身份/, '也不得出现"外部身份"')
  assert.match(account, /AccountIdentitiesSlotOutlet/, '那块界面由插槽贡献')
})
