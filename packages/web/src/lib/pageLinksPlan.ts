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
  /**
   * 后端对出链给出的**存在性**判定（`packages/plugin-wiki/src/index.ts` 的 `listOutlinks`）：
   * - `true`      → 目标存在且**你看得到**，正常链接
   * - `false`     → 目标不存在（红链，可引导创建）
   * - `'hidden'`  → 目标**存在但你无权查看**
   * - 缺失        → 兼容旧后端；**反向链接本就没有这个字段**（服务端已按可见性过滤过）
   */
  exists?: boolean | 'hidden'
}

/**
 * 链接项的四种状态。
 *
 * 为什么是四种而不是两种：`'hidden'` 与 `false` **必须分开**。把"存在但你看不到"渲染成
 * "不存在"，用户就会去**创建一个已经存在的页面** —— 那不是显示问题，是脏数据 + 错误引导
 * （设计文档 §5.5）。
 */
export type LinkState = 'ok' | 'missing' | 'hidden' | 'unknown'

/**
 * 由后端字段解析出链接状态。
 *
 * **判据是 `exists` 而不是 `title === null`**：`title` 只是 `LEFT JOIN` 的副产物，而
 * `exists` 是服务端**按主体算过**的结论（匿名拿不到 `'hidden'`，因为"存在但你看不到"
 * 与"根本不存在"的区别本身就是存在性信息）。
 *
 * `exists` 缺失时返回 `'unknown'`，**不返回 `'missing'`**：缺失只说明"这个后端没告诉我们"，
 * 把"不知道"当成"不存在"就会给用户一个**可能建出重复页面**的创建入口。宁可少给一个入口。
 */
export function linkStateOf(ref: PageLinkRef): LinkState {
  if (ref.exists === 'hidden') return 'hidden'
  if (ref.exists === true) return 'ok'
  if (ref.exists === false) return 'missing'
  return 'unknown'
}

/** 是否为「红链」（目标确实不存在，可以引导创建）。 */
export function isMissingRef(ref: PageLinkRef): boolean {
  return linkStateOf(ref) === 'missing'
}

/**
 * 是否为「存在但无权查看」。**这一项既不是正常链接、也绝不能渲染成红链。**
 */
export function isHiddenRef(ref: PageLinkRef): boolean {
  return linkStateOf(ref) === 'hidden'
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
 * 「存在但无权查看」的说明文案。
 *
 * 措辞刻意说"存在"：这一项的全部价值就在于**告诉用户别去新建它**。若只写"无权查看"，
 * 用户仍可能以为目标不存在而去创建。
 */
export function hiddenHint(slug: string): string {
  return `目标页面已存在，但当前身份无权查看：${slug}`
}

/**
 * 「存在但无权查看」项的标记属性。
 *
 * 与红链的 `MISSING_LINK_ATTR` 并列存在，是为了让**测试与样式都能一眼区分这三态**：
 * 少了它，"hidden 没有渲染成红链"这件事就只能靠类名字符串去猜。
 */
export const HIDDEN_LINK_ATTR = 'data-gw-hidden'

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
