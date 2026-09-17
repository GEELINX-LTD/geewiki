/**
 * 页面跳转类客户端工具的**宿主侧一半**（需求 ②：既能问当前页，也能自己去别的页）。
 *
 * ## 工具是两半，这个文件是其中一半
 * `packages/web/src/lib/clientTools.ts` 的文件头把这条分工写死了：
 * **服务端说"这个工具存在"**（描述符进模型的工具表），
 * **浏览器说"它在我这儿怎么跑"**（处理器）。
 *
 * - 描述符由 `@geewiki/ai-nav` 以 `side: 'client'` 贡献（否则模型看不到它、也就不会请求它）；
 * - 处理器在**这里**（宿主），而不是在插件的 UI bundle 里。
 *
 * 第二句不是洁癖：客户端工具的执行结果由浏览器拼成 `tool` 消息回灌，
 * 若处理器可以由插件自己登记，那么"客户端上报的可调用集"就成了**插件可控的输入**
 * ——一条把任意名字塞进那个集合的路径（扩权）。宿主登记时，插件只能声明它想要的**名字**，
 * 而名字必须同时出现在服务端的收窄交集里才会被执行。
 *
 * ## 与 `editorTools.ts` 的关系
 * 同一个形态的第二个实例（第一个是编辑框工具）。两处刻意**不**抽公共底座：
 * 它们的能力形状只共享"注册一张名字→处理器的表"这一点，
 * 而共同点只有一个 `Map`——为它抽一层抽象，换来的是每个读者都得多跳一次文件。
 *
 * ## 锚点的形态
 * 本应用是 hash 路由，"跳到小节"不能写 `location.hash = id`（会被路由解析器当成新路由）。
 * 锚点编码进 hash 的查询串（`#/wiki/<slug>?a=<id>`），机制与目录、正文标题链接**共用一处**
 * ——`lib/hashAnchor.ts`。这里只调它，不重写。
 */
import { registerClientTool } from './clientTools'
import { scrollToAnchor, settleHashAnchor } from './hashAnchor'
import { slugifyHeading } from './headingPlan'

/**
 * 本插件贡献的工具名（**排序后**）。
 *
 * 与 `packages/plugin-ai-nav/src/index.ts` 的 `NAV_TOOL_NAMES` 是一份事实的两半——
 * 浏览器侧不能 import 服务端包（core 顶层 `import 'node:fs'`），故只能镜像，
 * 由 `packages/plugin-ai-nav/test/toolNames.test.ts` 读**两侧源码**逐字比对钉住。
 */
export const NAV_TOOL_NAMES: readonly string[] = ['open_page', 'scroll_to']

/** 一次 `scroll_to` 最多回给模型几个候选小节（反馈要有，但不能把结果撑爆） */
export const MAX_HEADING_HINTS = 20

/** 一个可跳转的小节 */
export interface HeadingRef {
  readonly id: string
  readonly text: string
}

/**
 * 宿主能力的**窄口**：只有跳转与"看当前页有哪些小节"。
 *
 * 做成端口而不是直接摸 `document`，是为了让本文件的判据能在 node 里单测
 * （`scrollIntoView` 与 `getElementById` 在测试环境里不存在，而**判据本身**
 * ——"模型给的话该怎么对上真实的小节 id"——恰恰是最容易写错、也最该被测的部分）。
 */
export interface NavDom {
  /** 当前页面的小节（id + 标题文本），按正文顺序 */
  headings(): readonly HeadingRef[]
  /** 滚到某个**已存在**的 id；返回是否真的找到了 */
  scrollTo(id: string): boolean
  /** 把锚点写进 URL（不新增历史条目） */
  settle(id: string): void
}

export const defaultNavDom: NavDom = {
  headings: () => {
    const out: HeadingRef[] = []
    for (const el of document.querySelectorAll('h2[id], h3[id]')) {
      const id = el.id
      if (id === '') continue
      // 标题里那个零宽字符的锚点链接会污染 textContent（见 `markdownRender`），必须剥掉
      out.push({ id, text: (el.textContent ?? '').replace(/\u200B/g, '').trim() })
    }
    return out
  },
  scrollTo: (id) => scrollToAnchor(id),
  settle: (id) => settleHashAnchor(id),
}

export interface NavCapability {
  /** 打开某个页面（宿主路由；`App.tsx` 负责拼 `wiki/` 前缀） */
  openPage(slug: string): void
  /** 测试注入口；不传则用真实 DOM 实现 */
  readonly dom?: NavDom
}

/* ============================== 参数解析 ============================== */

/** 工具参数来自**模型**（外部输入），一律先校验再用 */
function readString(args: unknown, key: string): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const raw = (args as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw.trim() : null
}

/**
 * 模型给的小节说法 → 真实存在的 id。三种写法都要认，因为模型**看不到** id：
 *
 * 1. **原样就是 id**（它从 `list_pages` / 上一轮结果里抄来的，或用户直接说的 `usage`）；
 * 2. **标题原文**（`## 用法` ⇒ 模型多半写"用法"）——按 `slugifyHeading` 归一化后比对；
 * 3. **大小写/空白不一致的 id**（`Usage` ⇒ `usage`）。
 *
 * 全部落空则回 `null`，由调用方把"这一页有哪些小节"回给模型——
 * 与 `search_kb` 0 命中时给"换词再试"的提示同一条纪律：
 * **空结果必须带一条能据以改主意的信息**，否则模型只能继续猜。
 */
export function resolveAnchor(anchor: string, headings: readonly HeadingRef[]): string | null {
  const want = anchor.trim()
  if (want === '') return null
  // 1. 原样 id（先精确，避免"A B"被归一化成 a-b 之后反而对不上真实的 "a-b"）
  for (const h of headings) if (h.id === want) return h.id
  // 2/3. 归一化后比对：既比 id 也比标题文本
  const slug = slugifyHeading(want)
  const lower = want.toLowerCase()
  for (const h of headings) {
    if (h.id.toLowerCase() === lower) return h.id
    if (slug !== '' && h.id === slug) return h.id
    if (h.text === want || (slug !== '' && slugifyHeading(h.text) === slug)) return h.id
  }
  return null
}

/** 这一页有哪些小节（回给模型的一行提示，带条数上限） */
export function headingHints(headings: readonly HeadingRef[]): string {
  if (headings.length === 0) return '当前页面没有带锚点的小节（h2/h3）'
  const shown = headings.slice(0, MAX_HEADING_HINTS)
  const list = shown.map((h) => `${h.id}（${h.text}）`).join('、')
  return shown.length < headings.length ? `${list} 等 ${headings.length} 个` : list
}

/* ============================== 注册 ============================== */

/**
 * 登记两条跳转工具，返回**幂等**的注销函数。
 *
 * 与 `registerEditorTools` 同一形态：由宿主在真正需要时调用，卸载时注销
 * （不注销的话，登出之后再登录会撞上 `registerClientTool` 的"重名抛错"）。
 */
export function registerNavTools(capability: NavCapability): () => void {
  const dom = capability.dom ?? defaultNavDom

  const offOpen = registerClientTool('open_page', (args) => {
    const slug = readString(args, 'slug')
    if (slug === null || slug === '') {
      return { ok: false, error: 'invalid_slug', message: 'slug 必须是非空字符串' }
    }
    capability.openPage(slug)
    return {
      ok: true,
      slug,
      note: `已打开页面 ${slug}。它现在也成了用户"正在阅读的页面"，后续问题可以直接针对它。`,
    }
  })

  const offScroll = registerClientTool('scroll_to', (args) => {
    const anchor = readString(args, 'anchor')
    if (anchor === null || anchor === '') {
      return { ok: false, error: 'invalid_anchor', message: 'anchor 必须是非空字符串' }
    }
    const headings = dom.headings()
    const id = resolveAnchor(anchor, headings)
    if (id === null) {
      /*
       * 落空时**如实说 + 给出候选**。只说"没找到"会让模型重复同一个词，
       * 而它根本不知道这一页有哪些小节（它看不到渲染后的 DOM）。
       */
      return {
        ok: false,
        error: 'anchor_not_found',
        anchor,
        headings: headingHints(headings),
        note: '当前页面上没有这个小节。可以从上面这些真实存在的小节里选一个，或先说明你指的是哪一段。',
      }
    }
    const scrolled = dom.scrollTo(id)
    if (scrolled) dom.settle(id)
    return {
      ok: true,
      id,
      // 找到了但滚不动（元素在渲染后才出现）也要如实说，不能让模型以为用户看到了
      ...(scrolled ? {} : { note: '这个页面还没有渲染出内容（可能正在加载），位置没有真正滚动过去。' }),
    }
  })

  return () => {
    offOpen()
    offScroll()
  }
}
