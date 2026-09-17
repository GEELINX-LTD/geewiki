/**
 * **组织与邀请界面（P5-B M4/M5）的声明级不变量** —— 源码守卫 + 两条 SSR 路由守卫。
 * ============================================================================
 *
 * 为什么用源码级而不是渲染级：`OrgPage` 与三张卡跑起来要整套 React + Radix + 路由 + fetch，
 * 而这里要钉的本质上是**声明点**问题（整页门控用哪个字段、一次性令牌在哪渲染、
 * 危险操作用不用统一确认组件、用了哪些设计 token）。仓库既有先例就是这么做的
 * （`navPlan.test.ts`、`accessPage.test.ts`、`opsPage.test.ts`）。
 *
 * ## ⚠️ 先剥注释再断言
 *
 * 与 `accessPage.test.ts` / `opsPage.test.ts` 同款：**"解释为什么不能这么写"的注释本身
 * 会含那个字面量**（例如本文件的负向断言提到的那些类名）。不剥注释就会把自己的说明
 * 当成违规命中。涉及"绝不能出现在文件里"的几条（本地存储 / 控制台）则**连注释一起查**
 * ——那几条的判据是"这个文件里根本不该有这种调用"，注释里也不该有。
 *
 * ## 最要紧的一条：一次性令牌
 *
 * `POST /api/org/invitations` 回的 `token` 是**全生命周期里唯一一次出现**（库里只存 sha256）。
 * 所以这里不只断言"有渲染"，还钉住三件事：渲染点在 `created !== null` 分支之内、
 * 全文件对令牌的读取恰好两处（只读输入框 + 复制动作）、以及文件里没有任何把它写出去的通道
 * （URL / 本地存储 / 控制台）。
 *
 * ## 最后两条是真渲染
 *
 * "`#/org` 不会被 `known` 漏掉"、"无 `administer` 时一个管理控件都不挂载"这两件事
 * **只能**由真路由判定来证明：源码里出现 `...ADMIN_NAV` 并不等于 `known` 会对 `org`
 * 求值为真。故用 `react-dom/server` 渲染整个 `App`（shim 同 `accessPage.test.ts`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/** 剥掉块注释与行注释（见文件头） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function readSrc(...parts: string[]): { raw: string; code: string } {
  const raw = readFileSync(join(SRC, ...parts), 'utf8')
  return { raw, code: codeOnly(raw) }
}

const orgPage = readSrc('pages', 'OrgPage.tsx')
const members = readSrc('components', 'org', 'MembersCard.tsx')
const groups = readSrc('components', 'org', 'GroupsCard.tsx')
const invites = readSrc('components', 'org', 'InvitationsCard.tsx')
const app = readSrc('App.tsx')
const meta = readSrc('lib', 'pageMeta.ts')
const palette = readSrc('components', 'CommandPalette.tsx')
const plan = readSrc('lib', 'orgPlan.ts')
const apiSrc = readSrc('api.ts')

/* ------------------------------ 反空洞 ------------------------------ */

test('反空洞：剥注释后各文件仍能看到关键声明（防路径写错导致 0===0）', () => {
  assert.ok(orgPage.code.length > 1000, `OrgPage.tsx 读入异常（${orgPage.code.length} 字符）`)
  assert.ok(orgPage.code.includes('export function OrgPage'), '应能看到 OrgPage 定义')
  assert.ok(members.code.length > 1000, `MembersCard.tsx 读入异常（${members.code.length} 字符）`)
  assert.ok(members.code.includes('export function MembersCard'), '应能看到 MembersCard 定义')
  assert.ok(groups.code.length > 1000, `GroupsCard.tsx 读入异常（${groups.code.length} 字符）`)
  assert.ok(groups.code.includes('export function GroupsCard'), '应能看到 GroupsCard 定义')
  assert.ok(invites.code.length > 1000, `InvitationsCard.tsx 读入异常（${invites.code.length} 字符）`)
  assert.ok(invites.code.includes('export function InvitationsCard'), '应能看到 InvitationsCard 定义')
  assert.ok(app.code.includes('export function App'), '应能看到 App 定义')
  assert.ok(plan.code.includes('export function roleChangeOptions'), '应能看到 orgPlan 的纯函数')
})

/* --------------------------- 设计 token --------------------------- */

test('新界面只用已注册 token：不得出现 muted-foreground / border-border', () => {
  const files: Array<[string, string]> = [
    ['pages/OrgPage.tsx', orgPage.code],
    ['components/org/MembersCard.tsx', members.code],
    ['components/org/GroupsCard.tsx', groups.code],
    ['components/org/InvitationsCard.tsx', invites.code],
  ]
  // 目录里将来新增的组件一并纳入（不让守卫因为"多了一个文件"而漏扫）
  for (const name of readdirSync(join(SRC, 'components', 'org'))) {
    if (!name.endsWith('.tsx')) continue
    const key = `components/org/${name}`
    if (files.some(([f]) => f === key)) continue
    files.push([key, codeOnly(readFileSync(join(SRC, 'components', 'org', name), 'utf8'))])
  }
  files.push(['lib/orgPlan.ts', plan.code])

  assert.ok(files.length >= 5, `应至少扫到 5 个组织界面文件（实际 ${files.length}）`)
  const hits: string[] = []
  for (const [name, src] of files) {
    if (src.includes('muted-foreground')) hits.push(`${name}: text-muted-foreground（应改用 text-muted / text-ink-soft）`)
    if (/[\s"'`]border-border/.test(src)) hits.push(`${name}: border-border（应改用 border-line）`)
  }
  assert.deepEqual(hits, [], `发现未注册 token 的用法：\n  ${hits.join('\n  ')}`)
})

/* ----------------------- T1：api.ts 的 12 个端点 ----------------------- */

test('api.ts：12 个组织端点方法齐备，且 purgeInvitations 保持原样', () => {
  const expected = [
    "org: () => request<OrgResponse>('GET', '/api/org')",
    "orgMembers: () => request<{ ok: true; members: OrgMember[] }>('GET', '/api/org/members')",
    'setOrgMemberRole: (userId: number, role: OrgRole) =>',
    'removeOrgMember: (userId: number) =>',
    "orgGroups: () => request<{ ok: true; groups: OrgGroup[] }>('GET', '/api/org/groups')",
    'createOrgGroup: (name: string) =>',
    'deleteOrgGroup: (id: number) =>',
    'addGroupMember: (groupId: number, userId: number) =>',
    'removeGroupMember: (groupId: number, userId: number) =>',
    "orgInvitations: () =>",
    // email 自 2026-09-17 起**可选**：留空 = 通用码（持码者自填邮箱，见 0022 迁移）
    'createInvitation: (body: { email?: string; orgRole?: OrgRole | null; groupId?: number | null }) =>',
    'revokeInvitation: (id: string) =>',
  ]
  for (const line of expected) {
    assert.ok(apiSrc.code.includes(line), `api.ts 缺少方法声明：${line}`)
  }
  /*
   * 既有的回收动作（P4）**保持不动**：本批只新增，不重排别人的端点。
   *
   * ⚠️ 2026-09-17 更新：该方法的**归属**变了。「审计与运维」搬成插件 `@geewiki/ops` 之后，
   * 宿主 `api.ts` 里那 8 个方法全部成了死代码（逐名 grep 外部引用为 0）并被删除，
   * `purgeInvitations` 随之搬进 `packages/plugin-ops/ui/api.ts`。
   *
   * **端点路径不变**，所以这条不变量（"不得被删或改名"）仍然成立，只是要跟到新位置去查。
   * 留一份在宿主里才是最坏的：同一份端点契约两个实现，而两者漂移是静默的。
   */
  assert.equal(
    apiSrc.code.includes('purgeInvitations'),
    false,
    '宿主 api.ts 里不得再留 purgeInvitations —— 它现在的归属是 @geewiki/ops',
  )
  const opsApi = readFileSync(join(here, '..', '..', 'plugin-ops', 'ui', 'api.ts'), 'utf8')
  assert.ok(opsApi.includes('purgeInvitations(): Promise<PurgeResponse>'), '插件里必须有 purgeInvitations')
  assert.ok(opsApi.includes("'/api/org/invitations/purge'"), 'purge 的路径不得被改')
  // 类型写全（并导出）：四个视图类型 + 角色枚举
  for (const t of [
    'export type OrgRole =',
    'export interface OrgMember',
    'export interface OrgGroup',
    'export interface OrgInvitationView',
    'export interface InvitationCreated',
  ]) {
    assert.ok(apiSrc.code.includes(t), `api.ts 应导出 ${t}`)
  }
  // 邀请 id 是**字符串**（后端 randomBytes(16).toString('hex')），不是数字
  assert.ok(/id: string/.test(apiSrc.code), 'OrgInvitationView.id 必须是 string')
  assert.ok(
    apiSrc.code.includes('revokeInvitation: (id: string)'),
    'revokeInvitation 收的是字符串 id —— 当 number 处理会拼出错误路径',
  )
})

/* ==================== ★ 一次性令牌的呈现纪律 ==================== */

test('★ 邀请卡片：令牌只在创建成功的分支里渲染（写入点 / 清空点 / 渲染点都在）', () => {
  const code = invites.code
  // 反空洞：先证明三条都抽到了
  assert.ok(
    code.includes('setCreated({ token: r.token, email: r.invitation.email, link })'),
    '应能看到令牌的写入点（只存令牌、邮箱与拼好的链接）',
  )
  assert.ok(code.includes('setCreated(null)'), '应能看到令牌的清空点（关闭 / 重新签发）')
  assert.ok(
    code.includes('value={created.link}'),
    '应能看到邀请链接的渲染点（只读输入框）—— 显示**链接**而不是裸令牌：后者对方还得自己拼地址',
  )

  // 渲染点必须在 `created !== null` 分支之内
  const guardAt = code.indexOf('{created !== null &&')
  const renderAt = code.indexOf('value={created.link}')
  assert.ok(guardAt > 0, '令牌区块必须以 `created !== null` 为条件')
  assert.ok(renderAt > guardAt, '令牌的渲染点必须落在"刚创建成功"的分支里')
  assert.ok(
    code.indexOf('<table', renderAt) > renderAt,
    '令牌区块必须在列表**之前**（列表里永远不该出现令牌）',
  )

  /*
   * 全文件对**裸令牌**的读取恰好一处：创建区块里那行「邀请码原文」。
   * 它必须留着 —— 链接可能被聊天工具截断、或对方只想手抄一串码；
   * 但多一处就是多一个回显面，所以钉死数量。
   */
  const reads = code.match(/created\.token/g) ?? []
  assert.equal(reads.length, 1, `裸令牌只应有一处读取（实际 ${reads.length} 处）`)

  // 关闭即清空：清空点必须存在，且是"关闭/重新签发"走的路
  assert.ok(code.includes('onClick={() => setCreated(null)}'), '必须有显式的关闭动作把令牌清掉')
  // 只读 + 聚焦全选（剪贴板降级时用户要能按 ⌘/Ctrl+C）
  assert.ok(code.includes('readOnly'), '令牌输入框必须只读')
  assert.ok(code.includes('e.currentTarget.select()'), '聚焦即全选，便于手动复制')
  assert.ok(code.includes('aria-label="邀请链接（只显示一次）"'), '令牌输入框的可访问名称按约定')
  assert.ok(
    code.includes('这条链接只显示一次，关闭后无法再次查看 —— 请立即复制并发给受邀人。'),
    '必须有一句"只显示一次"的提示（否则用户关掉就永久失去它）',
  )
})

test('★ 邀请卡片：令牌不得有任何外流通道（URL / 本地存储 / 控制台）', () => {
  /*
   * 这里查**原文**（含注释）而不是剥注释后的代码：判据是"这个文件里根本不该有这种调用"，
   * 注释里出现它们同样是坏样板（复制粘贴的源头）。
   */
  const raw = invites.raw
  assert.doesNotMatch(raw, /localStorage|sessionStorage/, '令牌不得写入任何本地存储')
  assert.doesNotMatch(raw, /console\./, '令牌不得进控制台（排障者会顺手复制走它）')
  /*
   * ★ 2026-09-17 收窄：原先这里**一律禁止** `window.location`，理由是"令牌不得进 URL"。
   * 那条判据的前提（"本界面没有接受邀请的页面"）已经不成立了 —— 现在有
   * `pages/InvitePage.tsx`（`#/invite/<token>`），而邀请**只有**以链接形式传递才可用。
   *
   * 于是改成禁**写入**、允许**读 origin 拼接**，并把剩余的暴露面写清楚：
   *   · 哈希片段**不发给服务端** ⇒ 不进访问日志、不随 Referer 外泄（`?token=` 两样都会）；
   *   · 残留风险只有**被邀请人自己**的浏览器历史，而那是"点链接加入"无法避免的；
   *   · 这里仍**只读** origin，绝不写 location / history —— 后者才是会把一次性凭据
   *     变成长期凭据的那一步。
   */
  assert.doesNotMatch(
    raw,
    /(?:window\.)?location\.(?:hash|href|replace|assign)\s*=|history\.(?:push|replace)State/,
    '令牌不得被**写入** URL / 历史（读 origin 拼接链接是允许的，见上）',
  )
  assert.ok(
    raw.includes('window.location.origin'),
    '反空洞：链接必须真的由 origin 拼出来（否则上面那条负向断言可能只是没匹配到东西）',
  )
  // fetch 只允许出现在 api.ts —— 卡片里不该自己拼一次性令牌的请求
  assert.doesNotMatch(invites.code, /\bfetch\(/, '卡片不得绕过 api.ts 自己发请求')
})

test('邀请：Guest 通道是显式选项、不是默认值，且文案说清它不是 viewer', () => {
  const code = invites.code
  assert.ok(code.includes('INVITATION_ROLE_OPTIONS.map'), '角色下拉必须来自 orgPlan 的选项表')
  assert.ok(code.includes('invitationRoleValue(roleValue)'), '提交前必须经 invitationRoleValue 映射')
  assert.ok(
    code.includes("useState<string>('viewer')"),
    '默认值必须落在最窄的**具名**角色（viewer），不能默认选中 Guest 通道',
  )
  assert.ok(!code.includes("useState<string>('')"), '默认值不得是 Guest（空串）')
  assert.ok(code.includes('<Badge tone="neutral">Guest 通道</Badge>'), '列表里 orgRole === null 要用 Badge 标出')
  assert.ok(
    code.includes('Guest（无组织角色）不会出现在成员列表里，只能通过单条授权或页面授权获得访问。'),
    '页面上必须有一句解释 Guest 与成员的区别',
  )
  assert.ok(code.includes('INVITATION_STATE_LABEL[state]'), '状态要有明确文案')
})

test('危险操作一律走 useConfirm / ConfirmDialog，确认文案与级联行为一致', () => {
  for (const [name, src] of [
    ['MembersCard.tsx', members],
    ['GroupsCard.tsx', groups],
    ['InvitationsCard.tsx', invites],
  ] as const) {
    assert.doesNotMatch(src.code, /window\.confirm/, `${name} 不得用浏览器原生确认框（全站统一 ui/ConfirmDialog）`)
    assert.ok(src.code.includes('useConfirm()'), `${name} 应使用 useConfirm()`)
    assert.ok(src.code.includes('<ConfirmDialog'), `${name} 应挂载 ConfirmDialog`)
    assert.ok(src.code.includes('confirmLabel:'), `${name} 的确认按钮要有明确动词`)
  }

  // 移除成员的确认文案：说清级联（失去组织内一切权限，含用户组；授权记录保留）
  assert.ok(
    members.code.includes(
      '移除后该用户立即失去组织内一切访问权限（含其所在的用户组）；其访问申请与授权记录保留。确定移除？',
    ),
    '移除成员的确认文案必须与已核实的级联行为一致',
  )
  // 删组的确认文案：组授权是**收紧**方向，删了相关页面可能变得不可读
  assert.ok(
    groups.code.includes(
      '删除用户组不会删除成员账号。该组在页面上的授权会一并失效（授权记录保留但不再生效）—— 组授权是收紧方向，删除后相关页面可能变得不可读。确定删除？',
    ),
    '删组的确认文案必须说清"授权记录保留但不再生效"（不是"删了也没关系"）',
  )
  // 撤销邀请：令牌立即失效；已接受的要说清不影响成员身份
  assert.ok(
    invites.code.includes('撤销后该令牌立即失效，对方点链接将无法加入。确定撤销？'),
    '撤销邀请的确认文案',
  )
  assert.ok(
    invites.code.includes('已入伙的成员身份'),
    '已接受的邀请要说明"撤销不等于移除成员"（服务端删行但不回滚 org_members）',
  )
})

/* --------------------------- 三张卡的实现要点 --------------------------- */

test('成员卡：表格无障碍 + 角色选项收敛 + 409 走 orgConflictText', () => {
  assert.ok(members.code.includes('<caption className="sr-only">'), '表格必须有 sr-only 的 caption')
  const ths = members.code.match(/<th scope="col"/g) ?? []
  assert.ok(ths.length >= 5, `成员表至少 5 个列头（实际 ${ths.length}）`)
  assert.ok(
    members.code.includes('aria-label={`修改 ${m.displayName} 的角色`}'),
    '角色下拉的可访问名称必须带上目标人名（否则一屏多个"角色"读屏分不清）',
  )
  assert.ok(
    members.code.includes('roleChangeOptions(actorRole, m.role, selfUserId ?? -1, m.userId)'),
    '角色选项必须来自 orgPlan 的收敛函数（两处规则只写一份）',
  )
  assert.ok(members.code.includes('options.length === 0'), '无权改的行要渲染只读文本而不是空下拉')
  assert.ok(members.code.includes('orgConflictOf(e)'), '409/403 冲突要走 orgConflictText 的可见提示')
  assert.ok(members.code.includes('refreshCapabilitiesIfVisible'), '改到自己头上要重取能力')
})

test('用户组卡：成员下拉 + not_org_member 指路 + 建组校验', () => {
  assert.ok(groups.code.includes('api.orgMembers()'), '成员下拉要用成员列表端点（本页仅管理员可见）')
  // 加成员必须是**下拉**（不是让管理员背用户 id）：label 与 select 的 id 成对出现，并按组区分
  assert.ok(groups.code.includes('htmlFor={`org-group-add-${g.id}`}'), '加成员的下拉必须配 label')
  assert.ok(groups.code.includes('id={`org-group-add-${g.id}`}'), 'label 的 htmlFor 与 select 的 id 必须一致')
  assert.ok(
    groups.code.includes('!inGroup.has(m.userId)'),
    '候选成员必须是"还没在这个组里"的人（否则下拉里会出现已加入的人）',
  )
  assert.ok(groups.code.includes('api.addGroupMember'), '加成员调用 addGroupMember')
  assert.ok(groups.code.includes('api.removeGroupMember'), '移出成员调用 removeGroupMember')
  assert.ok(groups.code.includes('groupNameError(name)'), '建组前先做与服务端一致的长度校验')
  assert.ok(groups.code.includes('GROUP_NAME_MAX'), '组名上限来自 orgPlan 的常量')
  assert.ok(groups.code.includes('orgConflictOf(e)'), '409（同名组 / not_org_member）要给出下一步')
  // 组列表只回 memberIds：人名必须从同一份成员列表里查，不得按组逐个拉取（N+1）
  assert.ok(groups.code.includes('memberIds'), '应使用组里的 memberIds')
  assert.doesNotMatch(
    groups.code,
    /orgMembers\(\s*\)[\s\S]{0,80}\.map\(/,
    '不得对每个组各拉一次成员列表',
  )
})

/* ------------------------- 路由与导航（T4） ------------------------- */

test('App：ADMIN_NAV 含 org 且声明 administer（动态计数仍然成立）', () => {
  const block = /const ADMIN_NAV: NavItem\[\] = \[([\s\S]*?)\n\]/.exec(app.code)?.[1] ?? ''
  assert.ok(block.length > 40, `应能抽取出 ADMIN_NAV 的数组体（实际 ${block.length} 字符）`)
  const ids: string[] = block.match(/\bid: '[a-z]+'/g) ?? []
  const requires: string[] = block.match(/requires: 'administer'/g) ?? []
  assert.ok(ids.length > 0, '反空洞：至少要抽到一个条目')
  assert.equal(requires.length, ids.length, '每个运维入口都要声明能力，否则它会对所有人显示')
  assert.ok(ids.includes("id: 'org'"), "ADMIN_NAV 必须含 id: 'org'")
  assert.ok(
    /id: 'org'[^}]*requires: 'administer'/.test(block),
    "org 入口必须声明 requires: 'administer'（该页 12 个端点里 11 个要 admin+）",
  )
  assert.ok(block.includes("label: '组织'"), '入口文案是「组织」')
  assert.ok(block.includes('<Users'), '入口图标用 Users（与既有 import 风格一致）')
})

test('App：#/org 命中 OrgPage（known 判定 + 路由分派）', () => {
  assert.ok(app.code.includes('...ADMIN_NAV'), 'known 判定必须含 ...ADMIN_NAV（否则 #/org 落到「页面不存在」）')
  assert.match(app.code, /active === 'org'\)/, '必须有 org 路由分派')
  assert.match(app.code, /<OrgPage onNavigate=\{nav\} \/>/)
  assert.ok(app.code.includes("from './pages/OrgPage'"), 'App 必须 import OrgPage')
})

test('pageMeta：SECTION_LABEL 含 org（标签页标题不能显示成裸产品名）', () => {
  assert.ok(meta.code.includes("org: '组织'"), 'SECTION_LABEL 应有 org: 组织')
})

test('命令面板：action:org 追加在最后且声明 administer', () => {
  /** 与 navPlan.test.ts 同款的切片（到下一个动作 id 为止） */
  const actionBlock = (id: string): string => {
    const start = palette.code.indexOf(`id: '${id}'`)
    if (start < 0) return ''
    const rest = palette.code.slice(start)
    const next = rest.indexOf("id: 'action:", 1)
    return next < 0 ? rest : rest.slice(0, next)
  }
  const org = actionBlock('action:org')
  assert.ok(org.length > 20, '应能抽取出 action:org 的声明')
  assert.match(org, /requires: 'administer'/, '否则 ⌘K 会把它推给所有人')
  assert.match(org, /run: \(\) => go\('org'\)/)
  assert.ok(
    palette.code.indexOf("id: 'action:org'") > palette.code.indexOf("id: 'action:access'"),
    '新动作必须追加在既有 action:* 之后（切片逻辑依赖顺序）',
  )
})

/* ------------------------- 整页门控（OrgPage） ------------------------- */

test('OrgPage：整页按 administer 门控，无权时一个管理控件都不挂载', () => {
  const loadingAt = orgPage.code.indexOf('auth.capabilities === null')
  const gateAt = orgPage.code.indexOf('if (!auth.capabilities.administer)')
  const cardAt = orgPage.code.indexOf('<MembersCard')
  assert.ok(loadingAt > 0, '能力未知（首帧）必须先给加载态（失败关闭）')
  assert.ok(gateAt > loadingAt, '加载态必须排在能力判定之前')
  assert.ok(cardAt > gateAt, '三张卡必须排在无权早返回**之后**')
  assert.doesNotMatch(
    orgPage.code.slice(0, gateAt),
    /<MembersCard|<GroupsCard|<InvitationsCard/,
    '无权时不得渲染任何组织卡片',
  )
  for (const card of ['<MembersCard', '<GroupsCard', '<InvitationsCard']) {
    assert.ok(orgPage.code.includes(card), `有权时必须渲染 ${card}`)
  }
  assert.ok(orgPage.code.includes('api\n      .org()') || orgPage.code.includes('api.org()'), '页首应调 GET /api/org')
  assert.ok(orgPage.code.includes('你需要组织管理能力'), '无权时要给一句说明')
})

/* ============================ 真渲染：路由 ============================ */

/*
 * shim 必须在 import App **之前**装好（模块加载期会碰 window/document）。
 * 与 `accessPage.test.ts` / `navGate.test.ts` 同一套最小面。
 */
const backing: Record<string, string> = {}
;(globalThis as unknown as { window: unknown }).window = {
  location: { hash: '#/org', pathname: '/', search: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: {
    getItem: (k: string) => backing[k] ?? null,
    setItem: (k: string, v: string) => {
      backing[k] = v
    },
    removeItem: (k: string) => {
      delete backing[k]
    },
  },
}
;(globalThis as unknown as { document: unknown }).document = {
  documentElement: { classList: { add: () => {}, remove: () => {} }, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  activeElement: null,
  title: '',
}

test('SSR：#/org 命中的是组织管理台，而不是「页面不存在」兜底页', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { App } = await import('../src/App')
  const { __resetAuthStoreForTest } = await import('../src/lib/authStore')

  __resetAuthStoreForTest()
  const html = renderToStaticMarkup(React.createElement(App))

  assert.ok(html.length > 3000, `渲染结果应是一整个外壳（实际 ${html.length} 字符）`)
  // 能力未知（首帧）⇒ 显示"正在确认你的权限…"，这证明**路由命中**了 OrgPage
  assert.ok(
    html.includes('正在确认你的权限'),
    '`#/org` 必须命中 OrgPage（未命中会落到 NotFoundPage —— 说明 known 判定漏了 ADMIN_NAV）',
  )
  assert.ok(!html.includes('这个地址没有对应的页面'), '`#/org` 不得落到 NotFoundPage 兜底文案')
})

test('SSR（反空洞）：有 administer 的管理员能看到三张卡 —— 判据是能力不是"登录了没"', async () => {
  /*
   * 没有这一条，上面那条对"把整页删掉"的实现也会通过。
   * 走真实的 `loadAuth()` → api → fetch（只把最外层 fetch 换成桩），
   * 因此同时验证了"服务端下发的 capabilities 真的被这一页用上了"。
   */
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        setupRequired: false,
        authenticated: true,
        user: {
          id: 1,
          email: 'admin@example.com',
          displayName: 'Admin',
          orgId: 1,
          orgRole: 'owner',
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
        capabilities: { editContent: true, administer: true, manageVisibility: true },
        oidc: { available: false, reason: 'disabled' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { App } = await import('../src/App')
  const { loadAuth, __resetAuthStoreForTest } = await import('../src/lib/authStore')

  __resetAuthStoreForTest()
  await loadAuth({ force: true })
  const html = renderToStaticMarkup(React.createElement(App))

  // 首帧三张卡各自处于加载态 ⇒ 三个加载文案都应出现（证明三张卡都挂载了）
  for (const label of ['正在加载成员列表', '正在加载用户组', '正在加载邀请列表', '正在读取组织信息']) {
    assert.ok(html.includes(label), `管理员应看到「${label}」（未出现说明对应卡片没挂载）`)
  }
  assert.ok(!html.includes('你需要组织管理能力'), '有 administer 时不得显示无权说明')
})

test('SSR：无 administer 的成员**拿不到管理界面**（直接访问 #/org 也一样）', async () => {
  /*
   * 顶栏入口的隐藏由 `navPlan.test.ts` + `visibleDests` 保证；这里钉的是**路由本身**：
   * `#/org` 可以被直接输入，所以页面必须自己再判一次（服务端另有独立判定）。
   */
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        setupRequired: false,
        authenticated: true,
        user: {
          id: 2,
          email: 'bob@example.com',
          displayName: 'Bob',
          orgId: 1,
          orgRole: 'member',
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
        capabilities: { editContent: true, administer: false, manageVisibility: true },
        oidc: { available: false, reason: 'disabled' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { App } = await import('../src/App')
  const { loadAuth, __resetAuthStoreForTest } = await import('../src/lib/authStore')

  __resetAuthStoreForTest()
  await loadAuth({ force: true })
  const html = renderToStaticMarkup(React.createElement(App))

  assert.ok(html.includes('你需要组织管理能力'), 'member 直接访问 #/org 应看到说明，而不是管理界面')
  for (const label of ['正在加载成员列表', '正在加载用户组', '正在加载邀请列表']) {
    assert.ok(!html.includes(label), `无权时不得挂载「${label}」对应的卡片`)
  }
  assert.ok(!html.includes('管理 ▾') && !html.includes('审计与运维'), 'member 也不该看到运维台面入口')
})
