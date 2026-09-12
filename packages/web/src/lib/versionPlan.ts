/**
 * versionPlan —— 版本选择与快照预览的**纯逻辑**（无 React、无 DOM、无 fetch）。
 *
 * 存在的理由：版本相关的文案与判据散落过三处（`VersionPicker` 的行标签、
 * `VersionDiffDialog` 的 `versionLabelOf`、`WikiPage` 的恢复确认框），
 * 三份实现迟早会漂移。这里做**唯一真源**，组件只负责渲染。
 *
 * ⚠️ 本文件的函数必须保持纯：可单测、可在 SSR 下跑（仓库有 SSR 渲染测试的既有做法）。
 */
import type { PageDetail, VersionMeta } from '../api'
import { authorText } from './authorText'
import { absoluteTime, relativeTime } from './timePlan'

/** 版本列表里一项的展示模型（把"算出来的标签"与"接口给的事实"分开）。 */
export interface VersionOption {
  id: number
  /** 该快照的版本号（v1、v2 …）；由 `versionNumberOf` 计算，不用数组下标硬推 */
  number: number
  saved_at: string
  author: { id: number; displayName: string | null } | null
  /** 该版本是否是"当前版本"（当前版本**没有**快照行，故恒为 false；保留字段供调用方判断） */
  isCurrent: boolean
}

/* ------------------------------------------------------------------ *
 * 版本号
 * ------------------------------------------------------------------ */

/**
 * 快照数组只给"最近 N 条"（`recentVersions` 默认 10，被截断时 `versions.length` 小于
 * 历史总数）⇒ **不能用 `version - index - 1` 数下标**：
 *
 * - `page.version` 是**当前**版本号，历史快照总数 = `page.version - 1`。
 * - 截断时数组里第 0 项并不是最新的历史版本，而是"最近 N 条里最新的那条"，
 *   它的版本号仍然是 `page.version - 1`（倒数第 1 条历史）。
 * - 所以正确算法是**从总数往下数**：第 i 项 = `page.version - 1 - i`。
 *
 * 当 `versions.length === page.version - 1`（未截断）时，两种算法等价；
 * 截断时只有这一种是对的。**绝不能**让"当前版本"被标低成历史版本。
 */
export function versionNumberOf(page: Pick<PageDetail, 'version'>, index: number): number {
  return page.version - 1 - index
}

/**
 * 历史快照是否被截断（数组没覆盖到 v1）。
 *
 * `page.version - 1` 是历史总数（当前版本号 1 不算快照）；数组长度小于它即为截断。
 */
export function isTruncated(page: Pick<PageDetail, 'version' | 'versions'>): boolean {
  return page.version - 1 > page.versions.length
}

/** 把页面的 `versions[]` 映射成展示模型（顺序与接口一致：新 → 旧）。 */
export function versionOptions(page: Pick<PageDetail, 'version' | 'versions'>): VersionOption[] {
  return page.versions.map((v: VersionMeta, i: number) => ({
    id: v.id,
    number: versionNumberOf(page, i),
    saved_at: v.saved_at,
    author: v.author ?? null,
    isCurrent: false,
  }))
}

/**
 * 版本下拉底部的**条数摘要**：`当前 vN · 共 M 次改动`，被截断时追加"仅列最近 K 次"。
 *
 * 为什么要有一行摘要：它原本在正文下方那块常驻列表里，随该列表一起被移除。删掉之后
 * "下拉里就这几条"会被误读成"这一页只改过这几次" —— 这是**诚实性**问题，不是装饰，
 * 所以搬进下拉而不是删除。措辞与 `isTruncated` 同源，避免两套"是不是全部"的说法。
 *
 * ⚠️ 只依赖页面详情已有字段：`versions[]` 是异步按需补拉的（拉不到时不显示摘要行），
 * 而这行必须在**没有任何额外请求**时也能说真话。
 */
export function versionCountText(
  page: Pick<PageDetail, 'version' | 'versions'>,
  /**
   * 下拉里**实际列出**的条数。省略时按页内 `versions.length` 算。
   *
   * 为什么必须能传：下拉的行以分页端点的 `rows` 为准（到货后条数通常**多于**页内那份被
   * `recentVersions` 截断的数组）。真机验收里就撞到过这一处 —— 下拉已经列出全部 12 条，
   * 摘要却还写着"下拉里仅列最近 10 次"，**同一屏自己跟自己矛盾**（只是这次是少报）。
   */
  listedCount?: number,
): string {
  const history = page.version - 1
  if (history <= 0) return '暂无历史版本'
  const listed = listedCount === undefined ? page.versions.length : listedCount
  const base = `当前 v${page.version} · 共 ${history} 次改动`
  return listed < history
    ? `${base}（下拉里仅列最近 ${listed} 次，更早的见「浏览全部历史…」）`
    : base
}

/* ------------------------------------------------------------------ *
 * 判据
 * ------------------------------------------------------------------ */

/**
 * 页头是否该渲染**版本下拉**。
 *
 * 判据用 `canEdit`：历史快照端点（`GET …/versions/:id`）要求 `canEdit`，
 * 非 `canEdit` 时展开菜单点任何一项都必然 404 ⇒ 给一个"点了必然失败"的入口是反模式，
 * 故只读用户退化为静态徽标（存在性信息仍然给，见 `VersionHistorySummary`）。
 */
export function canPickVersion(page: Pick<PageDetail, 'capabilities'> | null): boolean {
  return page?.capabilities.canEdit === true
}

/**
 * 是否该显示「恢复此版本」。
 *
 * 判据是 `canManageVisibility` 而**不是** `canEdit`：恢复会改页面状态
 * （正文 + 块级权限 + 档位 + 发布态四位一体），服务端的 restore 端点正是要求这个能力。
 * 让只有编辑权的人看到恢复按钮，等于给出一个点了必然 403 的入口。
 */
export function canRestoreVersion(page: Pick<PageDetail, 'capabilities'> | null): boolean {
  return page?.capabilities.canManageVisibility === true
}

/* ------------------------------------------------------------------ *
 * 预览态（`?v=<版本 id>`）
 * ------------------------------------------------------------------ */

/** `?v=` 的解析结果：合法就带 id，非法就带一个**可读原因**（不静默吞掉）。 */
export type PreviewParam = { kind: 'none' } | { kind: 'ok'; id: number } | { kind: 'invalid' }

/**
 * 解析裸查询串（`App.tsx` 把 `?` 之后的部分原样传给 `WikiPage` 的 `query` prop）。
 *
 * 非法形态一律归 `invalid`，由调用方**静默回到最新 + 从 URL 清掉 `?v=`**：
 * - 空串 / 非数字 / 非正整数 / 超出安全整数：都不是"某一版"
 * - 允许前导零（`0007`）与前后空白：那是同一个 id，不必当成错误
 * - **不接受负数与 0**：服务端的 id 是自增正整数，0/负数是伪造的
 */
export function parsePreviewParam(query: string): PreviewParam {
  const raw = new URLSearchParams(query).get('v')
  if (raw === null) return { kind: 'none' }
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' }
  const id = Number(trimmed)
  if (!Number.isSafeInteger(id) || id <= 0) return { kind: 'invalid' }
  return { kind: 'ok', id }
}

/** 拼预览态的路由（`onNavigate` 收的是裸 slug + 裸查询串，`App.tsx` 会拼成 `#/wiki/…`）。 */
export function previewRoute(slug: string, versionId: number): string {
  return `${encodeURIComponent(slug)}?v=${versionId}`
}

/** 非法 `?v=` 的提示语。**必须同时说出两种可能** —— 服务端对"不存在"与"无权"都回 404。 */
export const PREVIEW_INVALID_TEXT = '该版本不存在或你无权查看'

/* ------------------------------------------------------------------ *
 * 文案
 * ------------------------------------------------------------------ */

/** 页头触发按钮的两种文案：最新态 / 预览历史态。 */
export function pickerTriggerText(pageVersion: number, previewNumber: number | null): string {
  return previewNumber === null ? `v${pageVersion} · 最新` : `v${previewNumber} · 历史 · 只读`
}

/** 预览态状态条的主文案（时间用绝对时间：分享出去的链接要能被别人读懂）。 */
export function previewBarText(versionNumber: number, savedAt: string): string {
  return `正在查看 v${versionNumber}（保存于 ${absoluteTime(savedAt)}）· 只读`
}

/** 预览态状态条的附注 —— 附件的判定口径与正文不同，必须说明。 */
export const PREVIEW_ATTACHMENT_NOTE =
  '历史快照按保存时的原文显示；其中的附件按**当前**正文引用判定，可能无法下载。'

/**
 * 菜单项右侧的"何时 / 谁"（与时间线共用格式，避免两处漂移）。
 *
 * `author` 的类型带 `id`：作者文案要区分「没有作者信息」（`author === null`）与
 * 「记了作者、但名字被权限收走」（`{ id, displayName: null }`）—— 后者显示「另一位成员」。
 * 只传 `displayName` 的话这一层信息在路上就丢了，两处又得各写一遍判断。
 */
export function versionMetaText(
  savedAt: string,
  author: { id: number; displayName: string | null } | null,
): string {
  /*
   * 作者文案经 `lib/authorText.ts` —— **「未记录」这个措辞全站只有一处定义**。
   * 在这里重写一遍判断（`displayName ?? '未记录'`）会让"空字符串算不算未记录"这类
   * 边界在两处慢慢分叉，而这类分叉的表现是"同一个人在两个地方显示不同"。
   */
  return `${relativeTime(savedAt)} · ${authorText(author)}`
}

/**
 * 改动摘要：把后端 `change` 结构压成一句话。
 *
 * 真实键名以 `packages/plugin-wiki/src/index.ts` 的 `/versions` 响应为准：
 * `{ contentChanged, blocksDelta, grantsDelta }`。
 *
 * ## `origin` 为什么必须参与（真机验收抓到的缺陷）
 *
 * 此前只看 `change`，而 `origin === 'acl'`（只动了权限：改档位/发布/发撤授权）
 * 的那一条**恰好也是 `change === null`**（正文与块都没动，服务端不给 `change` 对象）。
 * 于是界面上那一版**一个字的摘要都没有** —— 用户会把它读成"这一版没什么变化"，
 * 而它其实是"有人改了这条的可见性/发布状态"。
 *
 * 更麻烦的是 `change === null` 本身**有歧义**：它既可能是"只改了权限"，
 * 也可能是"最早的那一版，没有对照对象"。两者靠 `change` 分不开，**只有 `origin` 能分开**
 * （0021 记的就是"这次动作是什么性质"）。所以权限变更这一档用 `origin` 判定，
 * **不**从 `change` 去猜。
 *
 * ## `change` 的方向（别读反了）
 *
 * `change` 说的是「**比这一版更晚的那一版**相对它改了多少」，服务端算的是
 * `countBlocks(本版) − countBlocks(更晚那版)`。所以正数意味着**更晚那版更少**
 * （即那一版删了段落）。界面上的摘要因此挂在"被覆盖掉的那一版"上 ——
 * 要看清某次改动，应点进对比弹窗（那里给行级 `+N −M` 与具体增删行）。
 *
 * ⚠️ 契约未就绪或字段缺失时返回 `null`，界面**不显示摘要** ——
 * 编一个"0 段改动"比不显示更糟（那是在声称一件没根据的事）。
 */
export function versionChangeSummary(
  change: { contentChanged?: boolean; blocksDelta?: number; grantsDelta?: number } | null | undefined,
  origin?: string | null,
): string | null {
  /*
   * 只动了权限：`origin` 是权威判据。即使 `change` 意外带了授权计数，也一并说清
   * —— 那同样是权限侧的变化。
   */
  if (origin === 'acl') {
    const g = typeof change?.grantsDelta === 'number' ? change.grantsDelta : 0
    if (g > 0) return `+${g} 条授权`
    if (g < 0) return `−${Math.abs(g)} 条授权`
    return '仅权限变更（档位/发布）'
  }
  if (!change || typeof change.contentChanged !== 'boolean') return null
  const blocks = typeof change.blocksDelta === 'number' ? change.blocksDelta : 0
  const grants = typeof change.grantsDelta === 'number' ? change.grantsDelta : 0
  if (!change.contentChanged && blocks === 0 && grants === 0) return '仅标题变更'
  const parts: string[] = []
  if (blocks > 0) parts.push(`+${blocks} 段`)
  else if (blocks < 0) parts.push(`−${Math.abs(blocks)} 段`)
  if (grants !== 0) parts.push(grants > 0 ? `+${grants} 条授权` : `−${Math.abs(grants)} 条授权`)
  if (change.contentChanged && parts.length === 0) parts.push('正文已改')
  return parts.join(' · ')
}

/* ------------------------------------------------------------------ *
 * 恢复
 * ------------------------------------------------------------------ */

/**
 * 恢复确认框的正文（三行，逐条说清后果）。
 *
 * 为什么必须写"会新生成一个版本，不会回到旧编号"：用户对"恢复"的直觉是
 * "时光倒流"，而实现是**追加一次新版本**。不写清楚，用户会以为历史被抹掉了。
 */
export function restoreConfirmBody(
  target: number,
  current: number,
  targetSavedAt: string,
): string {
  return [
    `当前内容（v${current}）会被 v${target}（保存于 ${absoluteTime(targetSavedAt)}）的正文覆盖，并新生成一个版本（不会回到旧编号）。`,
    `v${target} 的块级权限、页面档位与发布状态会一并回滚；之后仍可再恢复回来。`,
    `若该版本早于块级权限功能，则只恢复正文，块级权限不动。`,
  ].join('\n')
}

/**
 * 恢复后的提示语。
 *
 * ⚠️ 服务端的恢复响应**只回 `restored`（被恢复那一版的 id）与 `acl_revision`，
 * 不回新版本号** —— 新版本号在重新拉取页面数据后由页头显示。所以这里**不编版本号**，
 * 只说"已恢复"与"这次没做到的部分"。
 *
 * `warnings` 是服务端如实回报的"这次恢复没能做到的事"（例如老快照没有块级权限数据
 * ⇒ `block_acls_not_restored`）。**必须翻译出来**：只显示"已恢复"而吞掉警告，
 * 会让用户以为权限也回滚了。
 */
export function restoreDoneText(warnings: readonly string[] | undefined): string {
  if (!warnings || warnings.length === 0) return '已恢复到该版本（正文、块级权限、档位与发布状态均已回滚）'
  const known: Record<string, string> = {
    block_acls_not_restored: '该版本早于块级权限功能，块级权限未回滚（只恢复了正文）',
  }
  const texts = warnings.map((w) => known[w] ?? `未识别的警告：${w}`)
  return `已恢复，但注意：${texts.join('；')}`
}

/** 恢复被拒时，把服务端的 `details.blockedOrdinals` 翻成人话。 */
export function restoreErrorText(err: { details?: unknown } | null | undefined): string | null {
  const details = err?.details as { blockedOrdinals?: unknown } | undefined
  const ordinals = details?.blockedOrdinals
  if (!Array.isArray(ordinals) || ordinals.length === 0) return null
  return `该版本含 ${ordinals.length} 个当前你无权查看的段落，无法恢复`
}

/* ------------------------------------------------------------------ *
 * 列表末尾的"还有没有更早的"这一句
 * ------------------------------------------------------------------ */

/** 列表末尾那一行该说什么。三种取值各对应一个**不同的事实主张**，不可互换。 */
export type OlderVersionsNote = 'load-more' | 'earliest' | 'not-listed' | 'none'

/**
 * 决定"已加载 N 条"之后，列表末尾该给「加载更早」还是「已到最早」。
 *
 * ## 为什么这个判断值得单独一个函数
 *
 * 它此前是用接口的 `hasMore` 直接判的，而那说的是"**这一页之外**还有没有"，
 * 不是"**页内那份被 LIMIT 截断的数组**之外还有没有"。两者在"一次就装下全部历史"
 * 时**恰好相反** —— 实测 `welcome`：历史共 12 条，接口一次全回且 `hasMore=false`，
 * 而页内 `versions[]` 受 `recentVersions` 限制只给最近 10 条。旧判据于是在 10 条之后
 * 打印「已到最早版本（v1）」，同一屏底部的条数摘要却写着「更早的见「浏览全部历史…」」
 * —— 自相矛盾，而且用户被告知"到最早了"而 v2/v1 根本没列出来。
 *
 * ## 判据
 * - `loadedCount >= historyTotal` ⇒ 真的到底了 ⇒ `'earliest'`；
 * - 否则接口说还有（`hasMore`）⇒ `'load-more'`；
 * - 否则（没到底、接口也说没有更早的 —— 即被单屏上限截断）⇒ `'not-listed'`：**如实说，
 *   但不谎称到最早**；
 * - 一条都没加载 ⇒ `'none'`（别在空列表下面写"已到最早"）。
 *
 * @param historyTotal 历史总数 = `page.version - 1`（权威来源是 `COUNT(page_versions)`）
 * @param loadedCount  当前已列出的条数
 * @param hasMore      接口是否报告还有下一页
 */
export function olderVersionsNote(
  historyTotal: number,
  loadedCount: number,
  hasMore: boolean,
): OlderVersionsNote {
  if (loadedCount <= 0) return 'none'
  if (loadedCount >= historyTotal) return 'earliest'
  return hasMore ? 'load-more' : 'not-listed'
}

/** 列表末尾那一行的文案。空态组件不渲染任何东西。 */
export function olderVersionsText(note: OlderVersionsNote): string | null {
  switch (note) {
    case 'load-more':
      return '加载更早的版本…'
    case 'earliest':
      return '已到最早版本（v1）'
    case 'not-listed':
      return '更早的版本未在此列出（这一屏最多取 100 条）—— 用「浏览全部历史…」看全部。'
    default:
      return null
  }
}
