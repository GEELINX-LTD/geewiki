/**
 * 「站点主页指向哪一篇」的**纯推导**（可单测）。
 *
 * 主页批之前，"主页是哪一篇"是编译期常量 `HOME_SLUG`；现在它是一处设置（`SiteHome`
 * 三态，见 api.ts）。但**消费方要做的事没变**：`#/wiki` 该渲染哪一篇、`#/wiki/home`
 * 还是不是别名、列表里哪一行挂「主页」徽标、AI 对话该说"当前页是哪个 slug"。
 * 这四处必须用**同一个换算**，否则就会出现"侧栏高亮 A、正文是 B"这种自相矛盾的界面。
 *
 * 所以换算只在这里定义一次：`SiteHome` → 一个 slug（或 null）。
 */
import { HOME_SLUG } from './wikiRoute'
import type { SiteHome } from '../api'

/**
 * 站点主页**实际渲染哪一篇**；`null` = 现在没有可渲染的一篇，调用方据三态决定显示什么。
 *
 * - `null`（**还没有结论**：加载中或上次失败）⇒ `null`。**刻意不回落** `HOME_SLUG`：
 *   那会在设置的是另一篇时先渲染一篇错的再换掉（"闪一下换了东西"）。
 * - `unset`（从来没人设置过）⇒ 约定 slug `HOME_SLUG`。升级上来的站点全是这一态，
 *   行为与本批之前**逐字节一致**（所以 `null` 与 `unset` 绝不能合流）。
 * - `visible` ⇒ 设置的那一篇。
 * - `hidden`（设置了，但当前主体读不到）⇒ `null`：没有哪一篇可以渲染，
 *   且**不能**退回约定 slug —— 那等于把无权者悄悄送去另一篇文章。
 */
export function homePageSlug(home: SiteHome | null): string | null {
  if (home === null) return null
  if (home.state === 'unset') return HOME_SLUG
  if (home.state === 'visible') return home.slug
  return null
}

/**
 * `#/wiki/home` 这个写法**现在还是不是主页别名**（即：要不要把它改写成规范地址 `#/wiki`）。
 *
 * 只有一种情况是：**主页恰好就是约定 slug `home`**（未设置时的默认，或显式设成
 * `home` 这一篇）。这与本批之前的判据完全一致，因此历史深链、地址栏补的尾斜杠、
 * `?v=` 快照地址的行为都不变。
 *
 * ⚠️ 反过来的那一半才是本批的**新缺陷防线**：一旦管理员把主页设成别的 slug，
 * `home` 就退化成一篇**普通文章**，`#/wiki/home` 必须照常打开它，不能被改写成
 * "去站点主页"——那会让一篇真实存在的文章打不开，而它的 URL 依然对外分享着。
 * 判据取 `homePageSlug()`（同一换算）而不是再拼一次字符串，就是为了这两条不会漂移。
 */
export function isHomeAliasNow(home: SiteHome | null): boolean {
  return homePageSlug(home) === HOME_SLUG
}

/**
 * 站点主页是不是**显式设置**过（也就是"取消/恢复默认"这个动作有没有意义）。
 *
 * `unset` 时"取消设置"是一个什么都不做的按钮（主页仍然落在约定 slug 上），
 * 因此界面只在 `visible`/`hidden` 时给这个入口。`null`（还没有结论）时同样返 false：
 * 结论未到就给按钮，点下去可能是在取消一个"其实不存在"的设置。
 */
export function hasExplicitHome(home: SiteHome | null): boolean {
  return home !== null && home.state !== 'unset'
}
