/**
 * 详情页「反向链接 / 本页引用了」区块的**纯逻辑**。
 *
 * 抽成纯函数的理由与仓库其它 `*Plan.ts` 一致：把"显示什么、指向哪里、算不算坏链"从 JSX 里
 * 拿出来单测，避免这类判断散落在组件中、又只能靠端到端才发现错。
 */
import { pageHash } from './linkPlan'

/** 与 `api.ts` 的 `PageLinkRef` 同形（此处不 import api，保持 lib 不依赖网络层）。 */
export interface PageLinkRef {
  slug: string
  title: string | null
}

/**
 * 是否为「红链」：后端对解析得到、但**页面并不存在**的目标返回 `title: null`。
 *
 * 判据刻意用 `title === null` 而不是 `!title`：空字符串标题（用户把标题清空）是**存在的页面**，
 * 不该被当成坏链——那会把"页面存在但没标题"误报成"页面不存在"。
 */
export function isMissingRef(ref: PageLinkRef): boolean {
  return ref.title === null
}

/**
 * 列表项显示名：优先标题，退化为 slug。
 * 退化而非留空，是因为空白的列表项看起来就像界面坏了。
 */
export function refLabel(ref: PageLinkRef): string {
  const title = ref.title?.trim()
  return title !== undefined && title !== '' ? title : ref.slug
}

/**
 * 该项的 hash 路由。**复用 `linkPlan` 的 `pageHash`**：层级 slug 必须编码成 `%2F`，否则路由
 * 段数不符 → 404。这里若另写一份拼装，就会与正文链接的编码规则漂移。
 */
export function refHref(slug: string): string {
  return pageHash(slug)
}

/**
 * 反向链接区块的说明文案（也承担"被引用 N 次"的轻量提示）。
 *
 * **未加载完成时返回 null**：加载中就宣称"0 个页面引用"是在陈述一个还不知道的事实。
 * 计数不放进页面顶部的元信息行，是为了避免为此把取数状态提升到详情页组件——那样会多一次
 * 请求或引入跨组件状态，而区块头部本来就在视线内。
 */
export function backlinkSummary(count: number, loaded: boolean): string | null {
  if (!loaded) return null
  return count === 0 ? '还没有页面引用本页' : `${count} 个页面引用了本页`
}

/** 红链的悬停说明：带上 slug，用户可以直接复制它去新建页面。 */
export function missingHint(slug: string): string {
  return `目标页面不存在：${slug}`
}

/**
 * 红链的"新建该页"入口。
 *
 * ⚠️ 已知限制：`#/wiki/new` 路由**不接受预填 slug**（`lib/wikiRoute.ts` 的 `new` 分支无参数），
 * 所以这里只能把用户送到新建页；slug 通过 `missingHint` 的悬停说明与列表项里的 slug 徽标给出，
 * 便于复制。要真正预填需改路由与新建页组件，属另一批的决策。
 */
export function missingNewPageHref(): string {
  return '#/wiki/new'
}
