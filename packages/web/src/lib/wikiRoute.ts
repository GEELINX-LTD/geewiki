/**
 * `#/wiki/<sub>` 的路由解析（纯函数，可单测）。
 *
 * 为什么从 `WikiPage` 里抽出来：路由解析原本内联在组件里，于是"分层 slug 打不开"
 * 这个缺陷没有任何测试能碰到——它只在真实浏览器里表现为"闪回列表"或 404。
 * 抽成纯函数后，编码/未编码、保留段、`/edit` 后缀、深度等边界都能用单测钉死。
 *
 * ## 本文件修掉的三个真缺陷（前两个由分层 slug 引入，第三个是主页别名）
 * 1. **未编码的分层路径被当成"未知深层路径"**：旧逻辑只接受 `seg.length === 1` 作详情页，
 *    `guide/intro` 会命中 `unknownDeep` 分支**静默跳回列表**——页面明明存在却打不开。
 * 2. **编码的分层路径被双重编码**：列表页的链接是 `#/wiki/${encodeURIComponent(slug)}`
 *    （`guide%2Fintro`），而 `api.page()` 内部**又**会 `encodeURIComponent`。
 *    旧逻辑直接把仍带 `%2F` 的字符串当 slug 传下去 ⇒ `guide%252Fintro` ⇒ **404**。
 *    修法：解析时**先整体解码再按 `/` 切分**，于是两种写法（`guide%2Fintro` 与
 *    `guide/intro`）得到同一个 slug，交给 `api.page()` 时是未编码的原值。
 * 3. **主页别名的"不重写也不渲染"夹缝**（`isWikiHomeAlias`，2026-09-14）：`#/wiki/home/`
 *    这种尾斜杠写法，组件里的字符串全等守卫（`stripHashQuery(hash) !== 'wiki/home'`）判 false
 *    ⇒ 不重写 URL；而本文件解析 `home/` 得到 `detail + home` ⇒ 组件 `return null`
 *    ⇒ **永久空白**（还不像未知 slug 那样给"页面不存在"提示）。判据因此收进本文件。
 *
 * ## 保留段（与后端 `RESERVED_FIRST_SEGMENTS` 对齐）
 * `search`/`new`/`list` 会被这里吃掉，所以后端不允许它们作首段——
 * 两边是同一份约定，改动其一必须同步另一（后端有对齐守卫，本文件由 wikiRoute 测试覆盖）。
 *
 * `ask` **仍然保留为保留段，但本文件已不再解析它**（P8 拆除 `#/wiki/ask/<q>`，决策 17：
 * 对话的唯一入口是 `app-dock`）。保留的理由是**解禁是单向不可回收的**：一旦放开，
 * 历史上被拒的 `ask/…` 这类 slug 会变成合法，而既有的 `#/wiki/ask` 分享链接会**静默**
 * 从"问答页"变成一个页面——没有报错、没有迁移提示，只是打开的东西换了。
 * 保留段不占位、不影响任何东西，代价只是多一个永远不会被消费的保留字。
 */

/** 会被前端路由占用、因而不能作为页面 slug 首段的名字（镜像后端 `RESERVED_FIRST_SEGMENTS`） */
export const WIKI_RESERVED_FIRST_SEGMENTS: readonly string[] = ['search', 'ask', 'new', 'list']

/**
 * 该 slug 是否**结构上不可能存在**——首段是保留段，后端 `RESERVED_FIRST_SEGMENTS` 会拒绝创建它。
 *
 * ## 为什么需要这个判据（P8 拆 `ask` 时暴露出来的）
 * `parseWikiRoute` 对保留段的处理是"能识别的识别、识别不了的落到详情页"。`ask` 拆掉视图之后
 * 就属于后者：`#/wiki/ask/foo` 解析成 `detail + slug='ask/foo'`。这个结果**自洽但危险**——
 * 有两个下游会把 detail 当成"用户正看着某一篇真实存在的文章"：
 * - `dockPlan.pageContextOf` ⇒ 告诉模型"当前页是 ask/foo"，模型随后去读一个不存在的页；
 * - `commandPlan.visitedSlugFromSub` ⇒ 把一个从未存在的 slug 记进"最近访问"。
 *
 * 两处的症状都是**安静的错**：不报错，只是上下文指向空气。所以判据收在这里一处，
 * 而不是在两个调用点各写一遍 `startsWith('ask')` 那种会随保留段增减而漂移的特判。
 */
export function isUnreachableSlug(slug: string): boolean {
  const first = slug.split('/')[0] ?? ''
  return WIKI_RESERVED_FIRST_SEGMENTS.includes(first)
}

export type WikiRoute =
  /** 默认落点：主页文章（约定 slug `home`），见 `HOME_SLUG` */
  | { kind: 'home' }
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'search'; q: string }
  | { kind: 'detail'; slug: string }
  | { kind: 'edit'; slug: string }

/**
 * 主页文章的约定 slug。
 *
 * 为什么用约定 slug 而不是"站点设置里指向某一页"：**零迁移、零新表**。
 * 已有部署不需要任何数据变更——没有这一页时首页给出「创建主页」引导。
 * 将来若要"管理员可换主页"，把这里当成**默认值**再读一处 `homeSlug()` 即可，
 * 不必推翻本方案。
 *
 * 为什么是 `home`：它**不在** `WIKI_RESERVED_FIRST_SEGMENTS` 里，因此不需要改动
 * 前后端镜像的保留段集合（动了就要同步后端 `RESERVED_FIRST_SEGMENTS`，那是
 * 有守卫测试钉住的约定）；`index` 有"目录页"歧义、`_home` 不符合既有 slug 惯例。
 */
export const HOME_SLUG = 'home'

/**
 * 单个路径段的解码：坏转义（如 `%E0%A4%A`）不抛错，退回原串（否则整页白屏）。
 *
 * 导出供**权限治理路由**（`#/access/<encodeURIComponent(slug)>`）复用：
 * 那里同样要"先整体解码再按 `/` 切分"，否则 `guide%2Fintro` 这种编码过的分层 slug
 * 会被当成"段内斜杠"而不是分隔符，于是同一个页面在两条路由下解析出不同的 slug。
 * 两处必须用同一个解码器，不能各写一份。
 */
export function safeDecodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 解析 `wiki/` 之后的子路径。
 *
 * 步骤刻意是"**先解码、再切分**"——顺序反了就会让 `%2F` 变成一个"段内斜杠"而不是分隔符，
 * 于是 `guide%2Fintro` 与 `guide/intro` 会走到不同分支（前者 detail+错误 slug，后者被
 * 当成未知深层）。先解码再切分让两者归一。
 */
export function parseWikiRoute(sub: string): WikiRoute {
  const decoded = safeDecodeSegment(sub)
  const seg = decoded.split('/').filter((s) => s !== '')
  const first = seg[0] ?? ''

  /*
   * 空路由 = **主页**（默认落点），不再与 `list` 合并：
   * `#/`、`#/wiki`、空 hash 三种写法都落到主页那篇文章；列表退居 `#/wiki/list`。
   * 合并成一支的实现是上一版的做法，它让"主页"这个词在路由层根本不存在。
   */
  if (seg.length === 0) return { kind: 'home' }
  if (first === 'list') return { kind: 'list' }
  if (first === 'new') return { kind: 'new' }
  // 检索的查询串可能自身含 `/`（被编码过），故取"首段之后的全部"再拼回
  if (first === 'search') return { kind: 'search', q: seg.slice(1).join('/') }

  // 到这里首段非保留字。末尾 `edit` 表示编辑路由——要求至少两段，
  // 这样"名字就叫 edit 的页面"（`#/wiki/edit`）仍能作为详情页打开。
  if (seg.length >= 2 && seg[seg.length - 1] === 'edit') {
    return { kind: 'edit', slug: seg.slice(0, -1).join('/') }
  }
  return { kind: 'detail', slug: seg.join('/') }
}

/**
 * 生成 wiki 路由的 hash（`?a=` 锚点由调用方另行拼接）。
 * slug **必须**编码：未编码的 `/` 会被切分逻辑吃掉（虽然 `parseWikiRoute` 已能容忍两种写法，
 * 但链接是"会被复制/分享"的，编码形式是唯一无歧义的）。
 */
export function wikiRouteHash(slug: string): string {
  return `#/wiki/${encodeURIComponent(slug)}`
}

/**
 * 当前 hash 是不是**主页别名的写法**（`#/wiki/home`、`#/wiki/home/`、`#/wiki/home?v=68`…）。
 *
 * 主页的规范地址是 `#/wiki`，但别名有一堆等价写法都会被人真的用出来：
 *   - `#/wiki/home`：约定 slug 的裸写法（历史深链、文档里的旧地址）；
 *   - `#/wiki/home/`：**地址栏自动补全、从聊天记录粘贴、IM 自动加链接**都会加这条尾斜杠；
 *   - `#/wiki/home?v=68`：版本下拉产出的历史快照地址；
 *   - `#/wiki/home?a=usage`：正文标题的页内锚点地址。
 *
 * ⚠️ 为什么必须有一个**共用判据**，而不是各处自己拼字符串（实测缺陷 2026-09-14）：
 * `WikiPage` 原本用字符串全等（`stripHashQuery(hash) !== 'wiki/home'`）判断"要不要把别名改写成
 * 规范地址"，而它只认裸写法。于是 `#/wiki/home/` 落到一个夹缝里 —— 组件不重写 URL（串不等），
 * 同时本文件把 `home/` 解析成 `detail + home` ⇒ 组件 `return null` ⇒ **永久空白**
 * （`#root` 只剩空壳，连"页面不存在"的提示都没有）。
 *
 * 判据必须与 {@link parseWikiRoute} **同一口径**：这里先剥 `#` 与查询串、再剥 `wiki` 前缀
 * （与 `App.tsx` 传 `sub` 的算法一致），最后交给同一个解析器。
 * 自己再写一套字符串判断就是上一条缺陷的成因。
 *
 * 未登录/无权也照常返回 true：它只回答"这是不是主页地址"，权限判定不归它管。
 *
 * @param rawHash `window.location.hash`（可含 `#`、可含 `?…` 查询串）
 */
export function isWikiHomeAlias(rawHash: string): boolean {
  const withoutPrefix = rawHash.replace(/^#\/?/, '')
  const q = withoutPrefix.indexOf('?')
  const route = q === -1 ? withoutPrefix : withoutPrefix.slice(0, q)
  // 整串锚定在 `wiki` 命名空间内：`access/home`、`wiki/homework` 一律不在此列
  if (route !== 'wiki' && !route.startsWith('wiki/')) return false
  try {
    const parsed = parseWikiRoute(route.slice('wiki'.length).replace(/^\/+/, ''))
    // `#/wiki` 本身解析成 `{kind:'home'}`（规范落点，无需改写）；只有 slug 恰为 `home` 的
    // 详情路由才是"别名"——这两者必须分开，否则规范地址会被反复重写。
    return parsed.kind === 'detail' && parsed.slug === HOME_SLUG
  } catch {
    // `parseWikiRoute` 对坏转义已有兜底，这里只是保底：调用方在 effect 里跑，
    // 抛出去就是整页空白，代价远大于忽略一个畸形地址。
    return false
  }
}
