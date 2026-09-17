/**
 * **授权对象的"通讯录"**：把 `subjectId`（一个数据库 id 字符串）换成看得懂的名字。
 * ============================================================================
 *
 * ## 为什么需要它（一个真实的产品问题）
 *
 * 例外授予要填 `subjectKind` + `subjectId`，而 `subjectId` 是**数据库里的 id**：
 * - `subjectKind = 'user'` ⇒ `users.id`（判定侧逐字比对：`WHERE subject_kind = 'user' AND subject_id = ?`，
 *   参数是主体的 `userId` 字符串，见 `packages/plugin-authz/src/index.ts`）；
 * - `subjectKind = 'group'` ⇒ `groups.id`（同上，组侧按主体所属组的 id 列表 `IN (…)` 命中）。
 *
 * 于是界面上只写"对象 id"就是在逼作者去猜一个数字 —— 真实反馈就是这么来的
 * （"授权时，所谓的 id 是什么"）。本模块的职责：**能拿到名单时就把 id 变成名字**，
 * 拿不到时**如实说明拿不到以及为什么**。
 *
 * ## 名单权限：本批已放宽，但**三态不能塌成两态**
 *
 * `GET /api/org/members` 与 `GET /api/org/groups` **曾经**要求管理员（`requireAdmin`）；本批按作者
 * 要求放宽为**任何登录用户可读**（`{ access: 'user' }`，见 `packages/plugin-org/src/index.ts`）——
 * "能看到名单，才谈得上按名单授权"（作者反馈："授权时，所谓的 id 是什么"）。
 *
 * 但**放宽不等于三态可以合并**：未登录、令牌失效、运维把端点改回 admin、断网或 500 ——
 * 这些情形下界面仍然拿不到名单，而**授权本身只要 `manageVisibility`**（组织成员也有）。
 * 所以"有权授权却列不出名单"依然是一类真实存在的人：对他们不能假装有下拉框，也不能把入口藏起来，
 * 只能手填 id 并被告知去哪里问 / 为什么列不出来。
 *
 * 因此本模块返回的是一个显式的**三态**，而不是"有名单 / 没名单"两态：
 * - `{ kind: 'available', users, groups }`：当前主体能列名单 ⇒ 界面给下拉选择；
 * - `{ kind: 'forbidden' }`：确知被拒（401/403）⇒ 界面手填，并说明"你没有管理员权限，看不到名单"；
 * - `{ kind: 'failed', error }`：其它失败（网络/500）⇒ 手填 + 如实报错，**不谎称"你没权限"**。
 */
import { api, ApiError, type OrgGroup, type OrgMember } from '../api'

/** 一条可选的授权对象 */
export interface SubjectOption {
  /** 写入 `subjectId` 的值：**数据库 id 的字符串形式** */
  id: string
  /** 主标签（人的姓名 / 组的名字） */
  label: string
  /** 次要信息（邮箱 / 成员数）—— 同名时靠它区分 */
  hint: string
}

export type SubjectDirectory =
  | { kind: 'available'; users: SubjectOption[]; groups: SubjectOption[] }
  | { kind: 'forbidden' }
  | { kind: 'failed'; error: unknown }

function toUserOption(m: OrgMember): SubjectOption {
  return {
    id: String(m.userId),
    label: m.displayName.trim() === '' ? m.email : m.displayName,
    hint: m.email,
  }
}

function toGroupOption(g: OrgGroup): SubjectOption {
  return { id: String(g.id), label: g.name, hint: `${g.memberIds.length} 名成员` }
}

/** 取名单（两个请求并发；任一被拒即整体视为"无权列名单"） */
export async function loadSubjectDirectory(): Promise<SubjectDirectory> {
  try {
    const [members, groups] = await Promise.all([api.orgMembers(), api.orgGroups()])
    return {
      kind: 'available',
      users: members.members.map(toUserOption),
      groups: groups.groups.map(toGroupOption),
    }
  } catch (e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return { kind: 'forbidden' }
    return { kind: 'failed', error: e }
  }
}

/**
 * 把一份授权（或草稿里的 id）描述成人看得懂的一行。
 *
 * `id` 解析不到名字时**不编造**：写出 `用户 id 42（名单不可见）`，而不是空字符串或"未知用户"。
 */
export function describeSubject(
  subjectKind: 'user' | 'group',
  subjectId: string,
  directory: SubjectDirectory | null,
): string {
  const kindWord = subjectKind === 'group' ? '用户组' : '用户'
  if (directory !== null && directory.kind === 'available') {
    const pool = subjectKind === 'group' ? directory.groups : directory.users
    const hit = pool.find((o) => o.id === subjectId)
    if (hit !== undefined) return `${hit.label}（${kindWord} ${subjectId}）`
  }
  return `${kindWord} id ${subjectId}`
}

/** 名单不可用时，界面上要**如实**说的那一句（说不出原因就别说原因） */
export function directoryUnavailableHint(directory: SubjectDirectory | null): string | null {
  if (directory === null) return null
  if (directory.kind === 'available') return null
  if (directory.kind === 'forbidden') {
    return '你（或当前主体）没有组织管理员权限，因此这里列不出成员与用户组名单 —— 只能手填 id：用户 id 与用户组 id 都可以在「管理 → 组织」页里看到，也可以向管理员索取。'
  }
  return '成员与用户组名单读取失败（不是权限问题），因此这里只能手填 id；刷新页面可以再试一次（**授权本身不受名单影响**，照样能提交）。'
}
