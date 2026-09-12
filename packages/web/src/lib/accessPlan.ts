/**
 * 权限治理界面的**可见性文案与档位收敛**（纯函数，可单测）。
 * ============================================================================
 *
 * 为什么单独一个文件：治理界面上有三类"说错就是安全事故"的文案 ——
 * 1. **档位说明**：三档各自"匿名能不能读、成员能不能读"必须写清，用户才敢点；
 * 2. **扇出（tier 重算）结果**：`index_tiers_resync_failed: true` 是**内容泄漏级**
 *    （读路径已收紧、检索仍按旧档位命中），与"没有子孙块"（resynced === 0）是两件事，
 *    文案必须分开，且都要指路运维；
 * 3. **冲突码文案**：`already_requested` / `already_has_access` / `request_not_pending`
 *    的下一步动作完全不同，按**机器码**分支，未知码返回 `null` 让调用方回退到通用提示
 *    （**不臆造文案** —— 编出来的解释比"请求未被接受"更坏）。同一个码在不同端点还可能
 *    指不同的对象（`not_found`：页面 vs 申请），故取文案要带**语境**（`ConflictContext`）。
 *
 * 放进组件里这些就只能靠浏览器验证；这里可以用 `node:test` 钉住每个分支。
 */
import type { BlockVisibility, GrantRole, PageVisibility, SubjectKind } from '../api'
import { safeDecodeSegment } from './wikiRoute'

/* ============================ 〇、路由解析 ============================ */

export type AccessRoute = { kind: 'home' } | { kind: 'page'; slug: string }

/**
 * 解析 `#/access` 之后的子路径（纯函数）。
 *
 * 与 `parseWikiRoute` **同一套写法**：先整体解码、再按 `/` 切分，
 * 于是 `guide%2Fintro` 与 `guide/intro` 归一成同一个 slug（否则编码过的分层 slug
 * 会被当成"段内斜杠"而不是分隔符）。解码器复用 `wikiRoute.safeDecodeSegment`，
 * 两处不能各写一份 —— 坏转义（`%E0%A4%A`）在一处抛错、在另一处退回原串就会分叉。
 *
 * ⚠️ 治理路由**不能**塞进 `wiki/` 下：`parseWikiRoute` 只保留首段
 * `search|ask|new|list`，`#/wiki/<slug>/access` 里的 `access` 会被当成 slug 的一部分。
 */
export function parseAccessRoute(sub: string): AccessRoute {
  const seg = safeDecodeSegment(sub)
    .split('/')
    .filter((s) => s !== '')
  const first = seg[0]
  if (first === undefined) return { kind: 'home' }
  return { kind: 'page', slug: seg.join('/') }
}

/* ============================ 一、档位说明 ============================ */

/**
 * 页面档位三档的选项文案（`VisibilitySection` 的 radio 与测试共用同一份）。
 *
 * `hint` 里的三件事**缺一不可**：
 * - 匿名访客能不能读到（这是最容易想当然的一档：`public` 还必须**已发布**才生效）；
 * - 登录成员能不能读到；
 * - `org` 档的边界在哪（"组织外"的登录者=访客）。
 *
 * 关于"更窄"的措辞：本文件统一用**宽松度**刻度（public 最宽、private 最窄），
 * 与后端 `blocks.ts` 的 `tierFor` 注释同一口径（那里的 `tier` 列方向相反，
 * 见 `tierFor` 上方"为什么这里是 max 而不是文档写的 min"）。
 */
export const PAGE_VISIBILITY_OPTIONS: ReadonlyArray<{
  id: PageVisibility
  label: string
  hint: string
}> = [
  {
    id: 'private',
    label: '私有（最窄）',
    hint: '只有本页的例外授予对象能读；匿名访客与同组织成员都读不到。适合尚未成稿或含敏感信息的内容。',
  },
  {
    id: 'org',
    label: '组织内',
    hint: '本组织成员（登录且已入伙）能读；匿名访客读不到。用于"内部可见、不对外"的内容。',
  },
  {
    id: 'public',
    label: '公开（最宽）',
    hint: '匿名访客也能读（组织成员当然也能读）—— 但还必须同时勾选「已发布」才真正对匿名可见：公开档位只说明"可以公开"，发布才是那个开关（发布不继承，见下方说明）。',
  },
]

/** 页面档位的宽松度刻度：越大越宽。**只用于比较，不参与判定**（判定在服务端）。 */
const PAGE_RANK: Record<PageVisibility, number> = { private: 0, org: 1, public: 2 }

/** 块档位的宽松度刻度（同一把尺子：public 最宽、granted 最窄）。 */
const BLOCK_RANK: Record<BlockVisibility, number> = { granted: 0, org: 1, public: 2 }

/**
 * 页面档位的**真实枚举值**（窄 → 宽）。
 *
 * ⚠️ 这是后端 `packages/plugin-wiki/src/index.ts:1724`
 * `VISIBILITIES = ['private', 'org', 'public']` 的**手抄镜像**（web 不能 import 后端包，
 * 与 `lib/slugRules.ts` / `lib/pluginUiPlan.ts` 同款做法）。改一侧必须改另一侧。
 */
export const PAGE_VISIBILITIES: readonly PageVisibility[] = ['private', 'org', 'public']

/**
 * 块档位的**真实枚举值**（窄 → 宽）。
 *
 * ⚠️ 这是后端 `packages/plugin-wiki/src/blocks.ts:28`
 * `BlockVisibility = 'public' | 'org' | 'granted'` 的手抄镜像。
 * **注意它不含 `private`**：块没有"私有"这一档，最窄的一档是 `granted`（授权档）。
 * 旧的 `private` 与 `role=*` 标记会被后端**显式拒绝**（`gated_marker_removed`），不是静默忽略。
 */
export const BLOCK_VISIBILITIES: readonly BlockVisibility[] = ['granted', 'org', 'public']

const VISIBILITY_LABEL: Record<string, string> = {
  private: '私有',
  org: '组织内',
  public: '公开',
  granted: '授权档',
}

/** 档位的中文短名；不认识的值原样回显（**不猜**它是什么档） */
export function visibilityLabel(value: string): string {
  return VISIBILITY_LABEL[value] ?? value
}

/** 档位宽松度排序序号；未知值返回 `null`（调用方据此失败关闭，而不是当最窄放行） */
function rankOfPage(value: string): number | null {
  return Object.prototype.hasOwnProperty.call(PAGE_RANK, value)
    ? PAGE_RANK[value as PageVisibility]
    : null
}

function rankOfBlock(value: string): number | null {
  return Object.prototype.hasOwnProperty.call(BLOCK_RANK, value)
    ? BLOCK_RANK[value as BlockVisibility]
    : null
}

/** 该块档位是否**比页面更宽**（规则 B1 禁止的形态）。任一侧不认识 ⇒ `false`（不指控） */
export function isWiderThanPage(block: string, page: string): boolean {
  const b = rankOfBlock(block)
  const p = rankOfPage(page)
  if (b === null || p === null) return false
  return b > p
}

/**
 * 块的档位选项：**只保留不比页面更宽的档位**（设计文档 §2.3 规则 B1）。
 *
 * 为什么要这个函数而不是写死一份列表：页面档位会变（页面 `public` 时块可以三档任选；
 * 页面收到 `org` 之后 `public` 块就变成"比页面宽"了）。收敛规则只有一处真源，
 * 界面与测试都从它取，才不会出现"某处还留着 public 选项"的漂移。
 *
 * 入参 `all` 由调用方给出（通常是真实枚举值），函数**只做筛选、不新增取值**：
 * 不认识的值一律丢掉（无法判断宽窄 ⇒ 宁可不展示，也不给一个可能更宽的选项）。
 */
export function blockVisibilityOptions(page: string, all: readonly string[]): string[] {
  const p = rankOfPage(page)
  if (p === null) return []
  return all.filter((v) => {
    const r = rankOfBlock(v)
    return r !== null && r <= p
  })
}

/**
 * 单个块的可见性说明（治理列表里每块一行）。
 *
 * `tier === null` 是**授权档**的判据（后端 `blockLevelOf('granted') === null`）：
 * 这种块不属于任何读者等级，等级分支永不命中 ⇒ **只有被单独授权的人能读**，
 * 而且页面档位后来变宽也**不会**顺带放行它。这句话必须出现在界面上，
 * 否则管理员会以为"把页面改成公开，这些块也就公开了"。
 */
export function narrowingHint(
  block: { visibility: string; tier: number | null },
  page: string,
): string {
  const pageLabel = `${visibilityLabel(page)}档`
  if (block.tier === null || block.visibility === 'granted') {
    return '授权档：只有被单独授权的人可读，页面档位变宽也不会一并放行。'
  }
  if (isWiderThanPage(block.visibility, page)) {
    return (
      `该块声明「${visibilityLabel(block.visibility)}」，比页面档位（${pageLabel}）更宽；` +
      '规则是块只能更窄，因此实际可见范围由页面档位决定 —— 给它加授权也不会突破页面上限。'
    )
  }
  return `该块声明「${visibilityLabel(block.visibility)}」，不比页面档位（${pageLabel}）更宽；实际可见范围取两者中更窄的一方。`
}

/* ======================= 二、扇出（tier 重算）结果 ======================= */

/**
 * 把 `PUT /visibility` 的扇出结果翻译成提示。
 *
 * ⚠️ **`failed === true` 与 `resynced === 0` 是两件处置完全不同的事**：
 * - `failed` ⇒ 祖先档位已提交，但子孙块的 `tier` **一个都没重算**。读路径已按新档位
 *   收紧，而检索仍按**旧**档位命中 ⇒ **内容泄漏级**，必须由运维重算（前端没有重算端点，
 *   故文案只指路，不造按钮）；
 * - `resynced === 0 && !failed` ⇒ 该页压根没有子孙块，没有任何需要同步的东西。
 *
 * 把这两条合并成一句"已保存"是本函数存在的全部理由。
 */
export function resyncNotice(r: {
  index_tiers_resynced: number
  index_tiers_resync_failed: boolean
}): { tone: 'ok' | 'danger'; text: string } {
  if (r.index_tiers_resync_failed) {
    return {
      tone: 'danger',
      text:
        '档位已保存，但子孙块的检索档位未能重算（内容泄漏级）：读路径已收紧，检索仍可能按旧档位命中。' +
        '请运维重算块档位后再核对。',
    }
  }
  if (r.index_tiers_resynced > 0) {
    return { tone: 'ok', text: `档位已保存，并同步了 ${r.index_tiers_resynced} 个子孙块的检索档位` }
  }
  return { tone: 'ok', text: '档位已保存，该页没有子孙块需要同步' }
}

/* ========================== 三、冲突码 → 人话 ========================== */

/**
 * 冲突码的**语境**：同一个码在不同端点说的不是同一件事（本批 R2 修掉的真实缺陷）。
 *
 * `not_found` 是最典型的例子 —— 后端三处 404 的原文与对象都不同：
 * - `POST /api/pages/:slug/access-requests`（申请提交）的 404 是**页面**不存在；
 * - approve / deny / withdraw 的 404 是 `申请不存在: <id>` —— **这条申请**不存在
 *   （已被他人裁决或已撤回），与"页面在不在"毫无关系。
 *
 * 原先只有一句"这条内容不存在，无法申请。"给三处共用：管理员点「批准」失败时，
 * 界面把**动作**（申请）说成了"申请"，把**对象**说成了"内容"，两句都错，
 * 用户会去怀疑页面被删了，而真正该做的是"刷新列表"。
 */
export type ConflictContext =
  /** 申请提交（`POST /access-requests`）：404 = 这一页不存在 ⇒ 无法申请 */
  | 'apply'
  /** 对**已存在的申请**动手（approve / deny / withdraw）：404 = 这条申请已不存在 */
  | 'request'

/**
 * 这些端点会回的**机器码** → 人话。取值与顺序无关，只保证"每个码都有话说"。
 *
 * 只收**权限治理界面真的会遇到**的码：
 * - `already_requested` / `already_has_access` / `request_not_pending`：申请闭环的三态冲突；
 * - `not_found`：读路径对「不存在」与「无权访问」一律 404（防存在性探测），申请入口也会撞到；
 *   它在 `apply` 语境下指页面、在 `request` 语境下指申请（见 `ConflictContext`）；
 * - `forbidden`：有读权限、但没有该条目的可见性管理权；
 * - `unauthorized`：会话失效（全局出口通常会先跳登录页，这里是兜底文案）；
 * - `invalid_subject_kind`：把角色（org_role）当授权对象提交 —— D13 明确禁止的形态。
 *
 * ⚠️ 刻意**不**把 `message` 文本当判据：上游文案会变、会被脱敏，只有 `error` 是稳定契约。
 */
const CONFLICT_TEXT: Readonly<Record<string, string>> = {
  already_requested: '你已经提交过申请了，请等待处理。',
  already_has_access: '你已经有这条内容的访问权限了，无需申请（请刷新页面）。',
  request_not_pending: '这条申请已被处理（可能在你打开页面后被他人裁决），列表已刷新。',
  not_found: '这条内容不存在，无法申请。',
  forbidden: '你没有这条内容的可见性管理权限（可能只有读权限）。',
  unauthorized: '登录状态已失效，请重新登录后再试。',
  invalid_subject_kind: '授权对象只能是「用户」或「用户组」—— 角色不是授权对象，请改选对象类别。',
}

/**
 * 语境相关的**覆盖表**：只有"同一个码确实要说两种话"时才在这里加一条。
 *
 * 为什么不复制整张表：两张表会漂移（改了 `forbidden` 的文案只改了一张）。
 * 这里只放**例外**，其余码一律落回 `CONFLICT_TEXT` —— 于是"新增语境"这件事
 * 只需回答一个问题："这个码在这个语境下说的还是同一件事吗？"
 */
const CONFLICT_TEXT_BY_CONTEXT: Readonly<Record<ConflictContext, Readonly<Record<string, string>>>> = {
  apply: {},
  request: {
    not_found: '这条申请已不存在（可能已被他人裁决或撤回），列表已刷新。',
  },
}

/**
 * 冲突码 → 文案。**未知码返回 `null`**：调用方回退到通用错误提示（`describeError`），
 * 不要在这里编一句看起来合理的解释 —— 那会让用户按错误的假设行动。
 *
 * `context` 默认 `apply`（申请提交语境）——调用方**应当显式传**，默认值只是为了让
 * 老调用点不静默变成"编译不过"，而不是一个可长期依赖的行为。
 */
export function conflictText(code: string, context: ConflictContext = 'apply'): string | null {
  const override: string | undefined = CONFLICT_TEXT_BY_CONTEXT[context][code]
  if (override !== undefined) return override
  return Object.prototype.hasOwnProperty.call(CONFLICT_TEXT, code)
    ? (CONFLICT_TEXT[code] as string)
    : null
}

/** 冲突码全集（测试与"每个码都要有文案"的自检共用；**不导出为可变值**） */
export const CONFLICT_CODES: readonly string[] = Object.keys(CONFLICT_TEXT)

/* ============================ 四、表单辅助 ============================ */

/** 授权对象类别的选项文案（**只有** user | group，不提供 org_role） */
export const SUBJECT_KIND_OPTIONS: ReadonlyArray<{ id: SubjectKind; label: string }> = [
  { id: 'user', label: '用户' },
  { id: 'group', label: '用户组' },
]

/** 授予角色的选项文案：`editor` 比 `viewer` 宽 */
export const GRANT_ROLE_OPTIONS: ReadonlyArray<{ id: GrantRole; label: string }> = [
  { id: 'viewer', label: '只读（viewer）' },
  { id: 'editor', label: '可编辑（editor）' },
]

/** `subjectId` 的上限 —— 与服务端校验（非空且 ≤128）一致，前端先挡一次 */
export const SUBJECT_ID_MAX = 128

/** 申请附言上限 —— 与服务端 `MAX_REQUEST_MESSAGE = 500` 一致 */
export const REQUEST_MESSAGE_MAX = 500

/** 校验授权对象 id：服务端拒绝的条件在这里先挡一次（错误文案与之一致） */
export function subjectIdError(raw: string): string | null {
  const v = raw.trim()
  if (v === '') return '请填写授权对象 id（用户填用户 id、用户组填组 id）'
  if (v.length > SUBJECT_ID_MAX) return `授权对象 id 过长（上限 ${SUBJECT_ID_MAX} 字符）`
  return null
}

/**
 * 到期时间的展示文案。`null`/空串 ⇒ 「不过期」。
 *
 * 不解析成功时**原样回显**：把服务端给的串改成"未知"会丢掉排障线索，
 * 而"不过期"是**放宽方向**的误读 —— 绝不能靠猜。
 */
export function expiryLabel(iso: string | null): string {
  if (iso === null || iso.trim() === '') return '不过期'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * `datetime-local` 的输入值 → 提交给服务端的 ISO 串。
 *
 * 三态刻意用**判别式**而不是 `null` 兼表两义：
 * - `{ ok: true, iso: null }` ⇒ 空串 = **不过期**（调用方据此决定不放该字段或用 `null`）；
 * - `{ ok: true, iso: '…' }` ⇒ 合法的 ISO 串；
 * - `{ ok: false }` ⇒ 输入框里是非法/敲到一半的内容 ⇒ **拦在提交前**，不要把它当"不过期"
 *   发出去 —— 那会静默地把一条限时授权变成永久授权（放宽方向）。
 */
export function expiresAtFromLocal(value: string): { ok: true; iso: string | null } | { ok: false } {
  const v = value.trim()
  if (v === '') return { ok: true, iso: null }
  const t = new Date(v)
  if (Number.isNaN(t.getTime())) return { ok: false }
  return { ok: true, iso: t.toISOString() }
}
