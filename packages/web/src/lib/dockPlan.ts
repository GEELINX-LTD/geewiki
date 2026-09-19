/**
 * `app-dock` 的**纯逻辑**：宿主路由 → 页面上下文的翻译。
 *
 * 单独成文件的理由与仓库里其它 `*Plan.ts` 相同：它是可判定的纯函数，应当能在 node 下
 * 直接单测；而 `components/AppDock.tsx` 一旦被 import 就会牵进 React、插槽注册表与
 * 插件加载器（本仓的测试约定是**只把这些 `.tsx` 当源文本读**，不 import——见
 * `packages/web/test/breadcrumb.test.ts` 的 `readFileSync('…/WikiPage.tsx')`）。
 *
 * 这条翻译值得单测，因为它错起来很安静：把列表页翻译成"当前页 = 上一篇"不会报错，
 * 只会让模型对着旧上下文回答，而用户看不出答案为什么不对。
 */
import { isUnreachableSlug, parseWikiRoute } from './wikiRoute'

/**
 * 当前页面上下文。
 *
 * ## 为什么只有 `'view'` 与 `'edit'` 两种 kind（对设计文档 §3.4 的一处收窄）
 * §3.4 的草图写的是 `kind: 'view' | 'edit' | 'list' | 'search' | 'graph' | 'admin'` +
 * `page: … | null`。实现期发现这两者**互相矛盾**：若列表页也产出 `page`，
 * 它的 `slug` 只能填空串，而插件看到 `slug: ''` 时无法区分"这是列表页"与
 * "宿主把 slug 传丢了"——一个字段要么承载真信息，要么就该是 `null`。
 *
 * 所以收窄成：**`page` 只在"用户正看着/改着某一篇文章"时非空**，其余视图一律 `null`。
 * 那四个 kind 提供不了任何插件能据此行动的信息（列表页没有"当前页"，图谱页与知识库
 * 正文无关），留着只会诱使插件把空 slug 当真的用。
 *
 * ## `null` 是合法状态，且**不得回落到"上一次的 slug"**
 * 列表页 → 详情页 → 列表页 的往返里，第二次是 `null`。插件若缓存上一次的 slug 并在
 * `null` 时用它，就会在列表页上回答"关于上一篇"的问题——把陈旧上下文当成当前上下文，
 * 比没有上下文更糟（用户看不出答案为什么不对）。
 */
export interface DockPageContext {
  readonly slug: string
  readonly kind: 'view' | 'edit'
}

export function pageContextOf(route: string, homeSlug: string | null): DockPageContext | null {
  if (route !== 'wiki' && !route.startsWith('wiki/')) return null
  const sub = route === 'wiki' ? '' : route.slice('wiki/'.length)
  const parsed = parseWikiRoute(sub)
  switch (parsed.kind) {
    case 'home':
      /*
       * ★ 主页批（2026-09-18）：`#/wiki` 落点是**哪一篇**由站点设置决定，不再是编译期常量
       * （调用方传 `homePageSlug(home)`，见 `lib/homePlan.ts`）。
       *
       * `null` 有两种来源，都**不能**回落成约定 slug `home`：
       *   · 结论还没到（设置请求在途/失败）⇒ 猜一个 slug 等于告诉模型"当前页是 X"，
       *     而 X 可能根本不对 —— 那正是本文件头注里点名要避免的"安静的错"；
       *   · 设置了，但当前主体读不到 ⇒ 更不能用别的 slug 顶上（用户看的是"主页不可访问"，
       *     不是那一篇约定主页）。
       * 没有当前页是**诚实**的答案，插件的正确反应是"不回答关于当前页的问题"。
       */
      return homeSlug === null ? null : { slug: homeSlug, kind: 'view' }
    case 'detail':
    case 'edit': {
      /*
       * ★ P8 补的一道判据：保留段开头的 slug **结构上不可能存在**（后端拒建）。
       * 拆掉 `#/wiki/ask/<q>` 之后，`wiki/ask/foo` 会解析成 `detail + slug='ask/foo'`，
       * 若照单全收，宿主就会告诉模型"当前页是 ask/foo"——模型随后去读一个不存在的页，
       * 而它没有任何办法从这句话里看出这一点。返回 `null` 才是诚实的。
       */
      if (isUnreachableSlug(parsed.slug)) return null
      return { slug: parsed.slug, kind: parsed.kind === 'edit' ? 'edit' : 'view' }
    }
    default:
      // list / new / search：都不对应"某一篇现有文章"。
      // `new` 尤其如此——slug 还没确定，编一个出来只会误导模型去读一个不存在的页。
      return null
  }
}
