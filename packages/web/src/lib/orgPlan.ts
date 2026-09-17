/**
 * 组织与邀请管理的**纯逻辑**（无 DOM、无 React，可单测）。
 * ============================================================================
 *
 * 为什么单独一个文件：这一批界面里有三类"判错就是权限事故"的判断 ——
 * 1. **角色选项的收敛**：服务端有两条硬规则（涉及 owner 的变更仅 owner 可做、
 *    不能移除/改自己），把它们只写在 JSX 里就只能靠浏览器验证，而且很容易在
 *    三张卡里各写一份、各自漂移；
 * 2. **冲突码 → 人话**：`last_owner` / `cannot_remove_self` / `not_org_member` /
 *    `group_exists` 的下一步动作完全不同，按**机器码**分支；未知码返回 `null`
 *    让调用方回退到通用提示（**不臆造文案** —— 编出来的解释比"请求未被接受"更坏，
 *    与 `accessPlan.conflictText` 同一条纪律）；
 * 3. **Guest 通道 ≠ viewer**：`orgRole: null` 是"没有组织角色"，把它渲染成
 *    `viewer` 会让管理员以为"他只是只读"，而实际语义是"不出现在成员列表里、
 *    只能靠单条授权访问"。这个区分是本文件的重点之一。
 *
 * 放进组件里这些就只能靠浏览器验证；这里可以用 `node:test` 钉住每个分支。
 */
import { ApiError, type OrgRole } from '../api'

/* ============================ 一、角色文案 ============================ */

/**
 * 角色的**真实枚举值**（宽 → 窄）。
 *
 * ⚠️ 这是后端 `packages/plugin-org/src/index.ts:58` 的 `OrgRole` 的手抄镜像
 * （web 不能 import 后端包）。顺序刻意与成员列表的服务端排序一致
 * （owner → admin → member → viewer），界面直接照它渲染下拉。
 */
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer']

/**
 * 角色 → 中文名。
 *
 * 取值必须**覆盖全部四个角色**（`Record<OrgRole, string>` 由类型强制）：
 * 漏一个的后果不是"少个翻译"，而是界面上出现 `undefined` 或回退成英文枚举值
 * ——管理者会以为自己看错了角色。
 */
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  owner: '拥有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
}

/** 该角色是否具备组织管理权（与后端 `isAdminRole` 同判据：owner / admin）。 */
export function isOrgAdminRole(role: OrgRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

/* ========================== 二、角色选项收敛 ========================== */

/**
 * 某一行成员的角色下拉里**可以选**的角色。
 *
 * 两条服务端规则（`packages/plugin-org/src/index.ts:390` 与 `:479`）在这里收敛成
 * "界面上根本不出现点了必然失败的选项"：
 *
 * 1. **涉及 owner 的变更仅 owner 可做**（后端 `touchesOwner` 判据）：
 *    - 目标**已经是** owner ⇒ 任何改动都涉及 owner ⇒ 非 owner 的 `actor` 拿到**空数组**
 *      （调用方据此把该行渲染成只读文本，而不是一个空下拉）；
 *    - 目标不是 owner 但要把谁**变成** owner 同样涉及 owner ⇒ 非 owner 的选项里
 *      去掉 `owner`（否则 100% 403）。
 * 2. **自己不能改自己** ⇒ `selfId === targetId` 返回空数组。这不是洁癖：把自己降级
 *    会**立刻**让自己进不来这个页面（下一次 `/api/auth/state` 就少了 `administer`），
 *    与后端禁止 `cannot_remove_self` 是同一个理由。改角色走别人、转让走 owner 路径。
 *
 * 返回值的顺序与 {@link ORG_ROLES} 一致（宽 → 窄），调用方不再排序。
 */
export function roleChangeOptions(
  actor: OrgRole,
  target: OrgRole,
  selfId: number,
  targetId: number,
): OrgRole[] {
  if (selfId === targetId) return []
  if (target === 'owner') return actor === 'owner' ? [...ORG_ROLES] : []
  return actor === 'owner' ? [...ORG_ROLES] : ORG_ROLES.filter((r) => r !== 'owner')
}

/* ======================= 三、冲突码 → 人话 ======================= */

/**
 * 组织侧端点会回的**机器码** → 人话。
 *
 * ⚠️ 刻意**不**把 `message` 文本当判据：上游文案会变、会被脱敏，只有 `error` 是稳定契约
 * （与 `accessPlan.conflictText` 同款）。
 *
 * 只收这一批界面真的会遇到的码：
 * - `last_owner`：降级/移除最后一位 owner（两处端点共用一个码，文案都成立）；
 * - `cannot_remove_self`：移除自己；
 * - `not_org_member`：把非组织成员加进用户组（下拉过期时才会出现，故文案必须指路"先邀请他入组织"）；
 * - `group_exists`：建组撞唯一约束；
 * - `forbidden`：非 owner 做了涉及 owner 的变更（界面已收敛，这里是兜底）。
 */
const ORG_CONFLICT_TEXT: Readonly<Record<string, string>> = {
  last_owner: '组织必须至少保留一位拥有者，请先指定另一位拥有者。',
  cannot_remove_self: '不能移除自己，请让另一位管理员操作。',
  not_org_member: '该用户还不是组织成员，请先把他加入组织再分到组里。',
  group_exists: '已存在同名用户组。',
  forbidden: '只有拥有者或管理员可以执行这个操作。',
}

/**
 * 冲突码 → 文案。**未知码返回 `null`**：调用方回退到通用错误提示（`describeError`），
 * 不要在这里编一句看起来合理的解释 —— 那会让用户按错误的假设行动。
 */
export function orgConflictText(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(ORG_CONFLICT_TEXT, code)
    ? (ORG_CONFLICT_TEXT[code] as string)
    : null
}

/** 冲突码全集（测试与"每个码都有文案"的自检共用） */
export const ORG_CONFLICT_CODES: readonly string[] = Object.keys(ORG_CONFLICT_TEXT)

/**
 * 从**错误值**里取组织侧冲突文案（`null` = 不是已知冲突码，调用方用 `ErrorNotice`）。
 *
 * 为什么收在这里而不是让三张卡各写一遍 `err instanceof ApiError && orgConflictText(err.code)`：
 * 那种写法一旦某处漏了 `instanceof` 判断就会去读 `undefined.code`，而 `orgConflictText`
 * 恰好对未知码返回 `null` —— 于是失败被静默吞掉，界面只剩一个通用提示。
 */
export function orgConflictOf(err: unknown): string | null {
  return err instanceof ApiError ? orgConflictText(err.code) : null
}

/* ==================== 四、邀请的角色与状态 ==================== */

/**
 * 邀请角色下拉的一项。`id === null` 即 **Guest 通道**（`orgRole: null`）。
 *
 * 用 `null` 而不是造一个 `'guest'` 字符串：服务端的契约就是
 * "`orgRole` 缺省 / `null` ⇒ 不给组织角色"，前端凭空造一个枚举值会在提交时
 * 变成 `invalid_role`（400）。这里让类型直接承载那个 `null`。
 */
export interface InvitationRoleOption {
  id: OrgRole | null
  label: string
}

/**
 * 签发邀请时可选的"角色"。
 *
 * ⚠️ **Guest 通道必须是一个显式选项**（不是"什么都不选"的默认态）：
 * 管理员要能明确地选"不给角色"，也要能看懂它与 `viewer` 的区别。
 */
export const INVITATION_ROLE_OPTIONS: ReadonlyArray<InvitationRoleOption> = [
  { id: 'owner', label: '拥有者（owner）' },
  { id: 'admin', label: '管理员（admin）' },
  { id: 'member', label: '成员（member）' },
  { id: 'viewer', label: '只读（viewer）' },
  { id: null, label: '不授予组织角色（Guest 通道）' },
]

/**
 * 表单里代表 Guest 通道的 `<select>` 值。
 *
 * `<option value>` 只能是字符串，故用一个**空串**表示 `null`（而不是 `"guest"`：
 * 那会被误当成角色名提交）。映射只允许经过 {@link invitationRoleValue}。
 */
export const INVITATION_GUEST_VALUE = ''

/**
 * 邮箱正则 —— 后端 `packages/plugin-org/src/index.ts:131` 的
 * `EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/` 的手抄镜像。
 * 前端先挡一次只是为了不让明显写错的邮箱走一趟网络，**真正的判定在服务端**。
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 邮箱输入的服务端上限（`EMAIL_MAX`），前端与它一致。 */
export const EMAIL_MAX = 254

/**
 * 校验邮箱：空 / 格式不合法 / 过长 ⇒ 中文提示，合法 ⇒ `null`。
 *
 * `emptyMessage` 可覆盖"空值"那句：同一个规则在不同场景要不同的话 ——
 * 管理员签发邀请时是「请填写**受邀人**的邮箱」，而被邀请人自己开户时填的是**自己**的邮箱
 * （见 `pages/InvitePage.tsx`）。**规则只有这一份**，只有文案按场景变。
 */
export function emailError(raw: string, emptyMessage = '请填写受邀人的邮箱'): string | null {
  const v = raw.trim()
  if (v === '') return emptyMessage
  if (!EMAIL_RE.test(v.toLowerCase())) return '邮箱格式不合法（例如 someone@example.com）'
  if (v.length > EMAIL_MAX) return `邮箱过长（上限 ${EMAIL_MAX} 字符）`
  return null
}

/**
 * `<select>` 的值 → 提交给服务端的 `orgRole`。
 *
 * 未知值一律当 **Guest 通道**（`null`）：这是**收紧**方向 —— 宁可少给一个角色
 * （对方仍可靠单条授权访问），也不把一个拼错的值猜成更宽的角色。
 * 换个方向（猜成 `member`）会让一次手误变成越权。
 */
export function invitationRoleValue(raw: string): OrgRole | null {
  if (raw === INVITATION_GUEST_VALUE) return null
  return (ORG_ROLES as readonly string[]).includes(raw) ? (raw as OrgRole) : null
}

/** 邀请的展示状态。 */
export type InvitationState = 'accepted' | 'expired' | 'pending'

export const INVITATION_STATE_LABEL: Record<InvitationState, string> = {
  accepted: '已接受',
  expired: '已过期',
  pending: '待接受',
}

/**
 * 一条邀请现在处于什么状态。
 *
 * - `acceptedAt` 非空 ⇒ `'accepted'`（**这是一条入伙记录**，撤销只删记录、不影响成员身份）；
 * - 否则按 `expiresAt` 与当前时间比 ⇒ 过期 / 待接受。
 *
 * ⚠️ **解析不出来的时间不算"已过期"**：把一条可能仍然有效的邀请显示成"已过期"，
 * 会诱导管理员去重发/撤销。时间原文另有列展示，这里只保证不误报。
 * （判定层也是每次现查库，与这里显示的状态可能相差几秒 —— 界面文案不该据此承诺"此刻一定可用"。）
 */
export function invitationState(
  inv: { acceptedAt: string | null; expiresAt: string },
  now: number = Date.now(),
): InvitationState {
  if (inv.acceptedAt !== null && inv.acceptedAt !== '') return 'accepted'
  const t = Date.parse(inv.expiresAt)
  if (Number.isNaN(t)) return 'pending'
  return t <= now ? 'expired' : 'pending'
}

/* ========================== 五、建组表单 ========================== */

/** 组名上限 —— 与后端 `GROUP_NAME_MAX = 80`（`packages/plugin-org/src/index.ts:133`）一致。 */
export const GROUP_NAME_MAX = 80

/** 校验组名：服务端拒绝的条件（空 / 超 80）在这里先挡一次，文案与之一致。 */
export function groupNameError(raw: string): string | null {
  const v = raw.trim()
  if (v === '') return '请填写用户组名称'
  if (v.length > GROUP_NAME_MAX) return `组名长度须在 1–${GROUP_NAME_MAX} 之间`
  return null
}
