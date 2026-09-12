/**
 * `#/wiki/<sub>` 的路由解析（纯函数，可单测）。
 *
 * 为什么从 `WikiPage` 里抽出来：路由解析原本内联在组件里，于是"分层 slug 打不开"
 * 这个缺陷没有任何测试能碰到——它只在真实浏览器里表现为"闪回列表"或 404。
 * 抽成纯函数后，编码/未编码、保留段、`/edit` 后缀、深度等边界都能用单测钉死。
 *
 * ## 本函数修掉的两个真缺陷（都是分层 slug 引入后暴露的）
 * 1. **未编码的分层路径被当成"未知深层路径"**：旧逻辑只接受 `seg.length === 1` 作详情页，
 *    `guide/intro` 会命中 `unknownDeep` 分支**静默跳回列表**——页面明明存在却打不开。
 * 2. **编码的分层路径被双重编码**：列表页的链接是 `#/wiki/${encodeURIComponent(slug)}`
 *    （`guide%2Fintro`），而 `api.page()` 内部**又**会 `encodeURIComponent`。
 *    旧逻辑直接把仍带 `%2F` 的字符串当 slug 传下去 ⇒ `guide%252Fintro` ⇒ **404**。
 *    修法：解析时**先整体解码再按 `/` 切分**，于是两种写法（`guide%2Fintro` 与
 *    `guide/intro`）得到同一个 slug，交给 `api.page()` 时是未编码的原值。
 *
 * ## 保留段（与后端 `RESERVED_FIRST_SEGMENTS` 对齐）
 * `search`/`ask`/`new`/`list` 会被这里吃掉，所以后端不允许它们作首段——
 * 两边是同一份约定，改动其一必须同步另一（后端有对齐守卫，本文件由 wikiRoute 测试覆盖）。
 */

/** 会被前端路由占用、因而不能作为页面 slug 首段的名字（镜像后端 `RESERVED_FIRST_SEGMENTS`） */
export const WIKI_RESERVED_FIRST_SEGMENTS: readonly string[] = ['search', 'ask', 'new', 'list']

export type WikiRoute =
  /** 默认落点：主页文章（约定 slug `home`），见 `HOME_SLUG` */
  | { kind: 'home' }
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'search'; q: string }
  | { kind: 'ask'; q: string }
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
  // 检索/问答的查询串可能自身含 `/`（被编码过），故取"首段之后的全部"再拼回
  if (first === 'search') return { kind: 'search', q: seg.slice(1).join('/') }
  if (first === 'ask') return { kind: 'ask', q: seg.slice(1).join('/') }

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
