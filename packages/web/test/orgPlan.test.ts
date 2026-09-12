/**
 * **组织与邀请管理的纯逻辑**（P5-B M4/M5）—— 单测。
 * ============================================================================
 *
 * 这些函数看着像"文案表 + 一个小筛选"，但每一条错误都对应一次真实的权限事故：
 * - `roleChangeOptions` 漏掉"涉及 owner 仅 owner 可做" ⇒ 界面给出一个点了必然 403 的选项；
 * - 漏掉"自己不能改自己" ⇒ 管理员把自己降级，**当场**失去本页与运维入口；
 * - `orgConflictText` 把 `last_owner` 说成 `cannot_remove_self` ⇒ 用户去检查自己是不是自己；
 * - `invitationRoleValue` 把未知值猜成 `member` ⇒ 一次手误变成越权（**收紧**方向才是对的）；
 * - `invitationState` 把解析不出来的过期时间说成"已过期" ⇒ 管理员去重发一条仍然有效的邀请。
 *
 * 所以下面既断言"有文案"，也断言**分支之间可区分**（互相不同的文本），
 * 并用**真实枚举值**参数化（手写几个假角色名会让测试与生产取值脱节）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/api'
import {
  EMAIL_MAX,
  GROUP_NAME_MAX,
  INVITATION_GUEST_VALUE,
  INVITATION_ROLE_OPTIONS,
  INVITATION_STATE_LABEL,
  ORG_CONFLICT_CODES,
  ORG_ROLE_LABEL,
  ORG_ROLES,
  emailError,
  groupNameError,
  invitationRoleValue,
  invitationState,
  isOrgAdminRole,
  orgConflictOf,
  orgConflictText,
  roleChangeOptions,
} from '../src/lib/orgPlan'

/* ========================= 一、角色文案全覆盖 ========================= */

test('ORG_ROLE_LABEL：四个角色全覆盖，且取值与真实枚举一一对应', () => {
  // 反空洞：先证明枚举与文案表都抽到了东西
  assert.equal(ORG_ROLES.length, 4, `组织角色应有 4 个（实际 ${ORG_ROLES.length}）`)
  assert.deepEqual([...ORG_ROLES], ['owner', 'admin', 'member', 'viewer'])

  assert.equal(ORG_ROLE_LABEL.owner, '拥有者')
  assert.equal(ORG_ROLE_LABEL.admin, '管理员')
  assert.equal(ORG_ROLE_LABEL.member, '成员')
  assert.equal(ORG_ROLE_LABEL.viewer, '只读')

  // 键集合必须与枚举**完全一致**：多一个键是死代码，少一个键会让界面显示 undefined
  assert.deepEqual(Object.keys(ORG_ROLE_LABEL).sort(), [...ORG_ROLES].sort())
  for (const role of ORG_ROLES) {
    assert.ok(ORG_ROLE_LABEL[role].trim().length > 0, `${role} 必须有中文名`)
  }
  const labels = new Set(ORG_ROLES.map((r) => ORG_ROLE_LABEL[r]))
  assert.equal(labels.size, 4, '四个中文名不得重复（重复会让用户选错角色）')
})

test('isOrgAdminRole：只有 owner / admin 有管理权（与后端 requireAdmin 同判据）', () => {
  assert.equal(isOrgAdminRole('owner'), true)
  assert.equal(isOrgAdminRole('admin'), true)
  assert.equal(isOrgAdminRole('member'), false)
  assert.equal(isOrgAdminRole('viewer'), false)
  assert.equal(isOrgAdminRole(null), false, 'null 是 Guest（没有角色），当然没有管理权')
})

/* ======================= 二、角色选项的服务端规则 ======================= */

test('roleChangeOptions：涉及 owner 的变更仅 owner 可做（admin 对 owner 目标为空）', () => {
  assert.deepEqual(roleChangeOptions('admin', 'owner', 1, 2), [], 'admin 改 owner 必然 403')
  assert.deepEqual(roleChangeOptions('member', 'owner', 1, 2), [])
  assert.deepEqual(roleChangeOptions('viewer', 'owner', 1, 2), [])
  assert.deepEqual(
    roleChangeOptions('owner', 'owner', 1, 2),
    [...ORG_ROLES],
    'owner 对 owner 目标非空（还剩 last_owner 由服务端在写入时兜底）',
  )
})

test('roleChangeOptions：非 owner 也不能把别人**变成** owner（选项里不得出现 owner）', () => {
  for (const actor of ['admin', 'member', 'viewer'] as const) {
    const opts = roleChangeOptions(actor, 'member', 1, 2)
    assert.ok(opts.length > 0, `${actor} 改 member 应当有可选项`)
    assert.ok(!opts.includes('owner'), `${actor} 的选项里不得出现 owner —— 那也是涉及 owner 的变更`)
  }
  assert.deepEqual(roleChangeOptions('admin', 'member', 1, 2), ['admin', 'member', 'viewer'])
  assert.deepEqual(roleChangeOptions('owner', 'member', 1, 2), [...ORG_ROLES])
})

test('roleChangeOptions：自己不能改自己（selfId === targetId 一律空）', () => {
  for (const actor of ORG_ROLES) {
    for (const target of ORG_ROLES) {
      assert.deepEqual(
        roleChangeOptions(actor, target, 7, 7),
        [],
        `${actor} 改自己（当前 ${target}）必须没有选项：把自己降级会当场失去本页入口`,
      )
    }
  }
  // 反空洞：同一个参数只要 targetId 换成别人就非空，证明上面的空不是"函数恒返回空"
  assert.ok(roleChangeOptions('owner', 'viewer', 7, 8).length > 0)
})

test('roleChangeOptions：返回的永远是真实角色、且含当前角色（下拉要显示当前值）', () => {
  for (const actor of ORG_ROLES) {
    for (const target of ORG_ROLES) {
      const opts = roleChangeOptions(actor, target, 1, 2)
      for (const o of opts) {
        assert.ok(
          (ORG_ROLES as readonly string[]).includes(o),
          `${o} 必须是真实存在的组织角色（不得凭筛选"造"出取值）`,
        )
      }
      if (opts.length > 0) {
        assert.ok(opts.includes(target), `选项里必须含当前角色 ${target}，否则下拉显示不出当前值`)
      }
      // 顺序与 ORG_ROLES 一致（宽 → 窄），调用方不再排序
      assert.deepEqual(opts, ORG_ROLES.filter((r) => opts.includes(r)))
    }
  }
})

/* ======================= 三、冲突码 → 人话 ======================= */

test('orgConflictText：五条文案逐字正确（M4 要求的原话）', () => {
  assert.equal(orgConflictText('last_owner'), '组织必须至少保留一位拥有者，请先指定另一位拥有者。')
  assert.equal(orgConflictText('cannot_remove_self'), '不能移除自己，请让另一位管理员操作。')
  assert.equal(
    orgConflictText('not_org_member'),
    '该用户还不是组织成员，请先把他加入组织再分到组里。',
  )
  assert.equal(orgConflictText('group_exists'), '已存在同名用户组。')
  assert.equal(orgConflictText('forbidden'), '只有拥有者或管理员可以执行这个操作。')
})

test('orgConflictText：五个码都有文案、互不相同，且与码清单一致', () => {
  const codes = ['last_owner', 'cannot_remove_self', 'not_org_member', 'group_exists', 'forbidden']
  const texts = codes.map((c) => orgConflictText(c))
  for (const [i, t] of texts.entries()) {
    assert.ok(t !== null && t.trim() !== '', `${codes[i]} 必须有专门文案（否则用户只能看到通用提示）`)
  }
  assert.equal(new Set(texts).size, 5, '5 条文案必须互不相同 —— 不同码的下一步动作不同')
  assert.deepEqual([...ORG_CONFLICT_CODES].sort(), [...codes].sort(), '表里加了码，测试要跟上')
})

test('orgConflictText：未知码返回 null（**不臆造文案**）', () => {
  for (const unknown of [
    '',
    'boom',
    'LAST_OWNER',
    'last_owner ',
    'member_not_found',
    'invalid_role',
    'invalid_email',
    'group_not_found',
    'cannot_remove_owner',
  ]) {
    assert.equal(
      orgConflictText(unknown),
      null,
      `${JSON.stringify(unknown)} 不该有文案 —— 调用方应回退到通用错误提示`,
    )
  }
})

test('orgConflictOf：只从 ApiError 的 `error` 取码，别的错误一律回退（不猜 message）', () => {
  assert.equal(orgConflictOf(new ApiError(409, 'last_owner', '不能降级最后一个 owner')), orgConflictText('last_owner'))
  assert.equal(orgConflictOf(new ApiError(403, 'forbidden', '需要 owner 权限')), orgConflictText('forbidden'))
  // 未知码 / 非 ApiError / 字符串 / null：都必须回退
  assert.equal(orgConflictOf(new ApiError(409, 'some_new_code', '未来新增的冲突')), null)
  assert.equal(orgConflictOf(new Error('last_owner')), null, '普通 Error 的 message 不是契约，不得当码用')
  assert.equal(orgConflictOf('last_owner'), null)
  assert.equal(orgConflictOf(null), null)
  assert.equal(orgConflictOf(undefined), null)
})

/* ==================== 四、邀请的角色与状态 ==================== */

test('INVITATION_ROLE_OPTIONS：Guest 通道是**显式选项**，且文案说清它不是 viewer', () => {
  const guest = INVITATION_ROLE_OPTIONS.filter((o) => o.id === null)
  assert.equal(guest.length, 1, 'Guest 通道必须恰好有一个选项（不能靠"什么都不选"表达）')
  assert.equal(guest[0]?.label, '不授予组织角色（Guest 通道）')

  const labels = new Set(INVITATION_ROLE_OPTIONS.map((o) => o.label))
  assert.equal(labels.size, INVITATION_ROLE_OPTIONS.length, '选项文案不得重复')
  // 四个具名角色都在（管理员要能直接发 member / viewer 邀请）
  for (const role of ORG_ROLES) {
    assert.ok(
      INVITATION_ROLE_OPTIONS.some((o) => o.id === role),
      `缺少角色选项 ${role}`,
    )
  }
  // Guest 不是第一项：默认落在第一个选项上时不该是"不给角色"（组件里的默认值另有守卫）
  assert.notEqual(INVITATION_ROLE_OPTIONS[0]?.id, null)
  assert.notEqual(INVITATION_GUEST_VALUE, 'viewer', 'Guest 的 DOM 取值不得与 viewer 混用')
  assert.equal(INVITATION_GUEST_VALUE, '')
})

test('invitationRoleValue：空串 = Guest(null)，具名角色原样，未知值一律收紧成 null', () => {
  assert.equal(invitationRoleValue(INVITATION_GUEST_VALUE), null)
  for (const role of ORG_ROLES) {
    assert.equal(invitationRoleValue(role), role)
  }
  // 未知值：**收紧**方向（少给角色）而不是猜成更宽的角色
  for (const unknown of ['guest', 'Guest', 'null', 'undefined', 'OWNER', ' admin', '']) {
    const v = invitationRoleValue(unknown)
    assert.ok(v === null || (ORG_ROLES as readonly string[]).includes(v), `${unknown} 不得映射出非法角色`)
  }
  assert.equal(invitationRoleValue('guest'), null, '拼错的值不得被猜成任何具名角色')
  assert.equal(invitationRoleValue('OWNER'), null, '大小写不同不是同一个角色')
})

test('emailError：空 / 格式不合法 / 过长，与服务端 EMAIL_RE、EMAIL_MAX 同一判据', () => {
  assert.ok(emailError('') !== null)
  assert.ok(emailError('   ') !== null, '纯空白视为空')
  assert.ok(emailError('not-an-email') !== null)
  assert.ok(emailError('a@b') !== null, '服务端要求有域名点号（EMAIL_RE 手抄镜像）')
  assert.ok(emailError('a b@example.com') !== null, '含空白不合法')
  assert.equal(emailError('someone@example.com'), null)
  assert.equal(emailError('  Someone@Example.COM '), null, '两侧空白应被容忍')
  assert.ok(emailError(`${'a'.repeat(EMAIL_MAX)}@example.com`) !== null, '超过服务端上限要拦下')
})

test('invitationState：已接受优先；过期/待接受按时间；**时间解析不出来不算过期**', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z')
  assert.equal(
    invitationState({ acceptedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:00.000Z' }, now),
    'accepted',
    '已接受优先于过期：它是入伙记录，撤销也不移除成员',
  )
  assert.equal(invitationState({ acceptedAt: null, expiresAt: '2026-05-31T23:59:59.000Z' }, now), 'expired')
  assert.equal(invitationState({ acceptedAt: null, expiresAt: '2026-06-02T00:00:00.000Z' }, now), 'pending')
  assert.equal(invitationState({ acceptedAt: null, expiresAt: '不是时间' }, now), 'pending', '宁可说"待接受"也不误报"已过期"')
  // 空串与 null 一样按"未接受"处理（服务端 accepted_at 缺省就是 null）
  assert.equal(invitationState({ acceptedAt: '', expiresAt: '2026-06-02T00:00:00.000Z' }, now), 'pending')
  // 三个状态都有中文标签且互不相同
  const labels = Object.values(INVITATION_STATE_LABEL)
  assert.equal(labels.length, 3)
  assert.equal(new Set(labels).size, 3, '三个状态的中文标签必须互不相同')
  for (const l of labels) assert.ok(l.trim() !== '', '每个状态都要有中文标签')
})

/* ========================== 五、建组表单 ========================== */

test('groupNameError：空 / 超 80 拦下，其余放行（与服务端 GROUP_NAME_MAX 一致）', () => {
  assert.equal(GROUP_NAME_MAX, 80)
  assert.ok(groupNameError('') !== null)
  assert.ok(groupNameError('   ') !== null)
  assert.equal(groupNameError('编辑部'), null)
  assert.equal(groupNameError('a'.repeat(GROUP_NAME_MAX)), null)
  assert.ok(groupNameError('a'.repeat(GROUP_NAME_MAX + 1)) !== null)
  assert.ok(groupNameError('a'.repeat(GROUP_NAME_MAX + 1))?.includes('1–80'), '文案要与服务端一致地给出区间')
})
