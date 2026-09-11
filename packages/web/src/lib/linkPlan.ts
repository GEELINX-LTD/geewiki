/**
 * 正文链接的目标解析与重写（纯函数，无 DOM、无请求）。
 *
 * ## 为什么需要它
 *
 * 本应用是 **hash 路由**（`#/wiki/<slug>`）。而 Markdown 正文里的链接是"网络惯例"写法：
 * `[架构](/architecture)`、`[快速开始](/wiki/getting-started)`、`[章节](#section)`。
 * 实测这三种在当前应用里**全是坏的**：
 *
 * 1. `/architecture` → 浏览器**整页加载** `/architecture`（发出 document 请求），hash 被清空、
 *    SPA 退回列表页 ⇒ 用户看到的是"链接坏了"；
 * 2. `#section` → 把 `location.hash` 设成 `#section`，而路由只认 `#/wiki/...` ⇒ **路由被打乱**
 *    （同页锚点的正确形态见 `lib/hashAnchor.ts`）；
 * 3. 没有任何"写站内链接"的可用语法。
 *
 * 一个无法在页面之间互相链接的知识库是不可用的，故在渲染后处理层统一改写。
 *
 * ## 为什么是纯函数
 *
 * 改写规则有相当多分支（外链 / 锚点 / 站内存在 / 站内不存在 / 危险 scheme / 编码 slug /
 * 相对路径歧义），把它从 DOM 里剥出来才能逐条单测——DOM 层的断言只能覆盖"点一下试试"，
 * 而边界（例如 `javascript:`、`%2F` 编码、前后空格）恰恰是最需要穷举的部分。
 *
 * ## 安全边界
 *
 * 本模块**只决定"新 href 是什么"**，不解析、不拼接正文内容：
 * 新 href 要么由我们自己构造（`pageHash()`/`buildHash()`），要么是**原值原样保留**。
 * 消毒仍是 `lib/sanitize.ts` 的唯一职责（危险 scheme 在那一层已被摘掉）；这里额外做的
 * 只是"不要把它变回可点的东西"——未知/危险 scheme 一律 `keep`，不做任何加工。
 */
import { buildHash } from './hashAnchor'

/** 链接分类（供调用方决定加什么属性，也便于测试逐类断言） */
export type LinkKind = 'keep' | 'external' | 'anchor' | 'page' | 'missing'

export interface LinkResolution {
  kind: LinkKind
  /** 改写后的 href；`keep` 时等于原值（已 trim） */
  href: string
  /** 是否应在新标签打开（仅 http/https 外链） */
  blank: boolean
  /** 站内目标 slug（`page`/`missing` 时给出） */
  slug?: string
}

/** "目标页面不存在"的标记属性与类名（后处理层写入，样式在 `styles/markdown.css`） */
export const MISSING_LINK_ATTR = 'data-gw-missing'
export const MISSING_LINK_CLASS = 'gw-link-missing'

/** `http(s):` 等协议头（只匹配开头，且要求 `:` 前形如 scheme） */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/** 站内页面链接的 hash 形态；层级 slug 必须编码（`%2F`），否则路由段数不符 → 404 */
export function pageHash(slug: string): string {
  return `#/wiki/${encodeURIComponent(slug)}`
}

/**
 * 把各种写法归一成 slug：
 * `/wiki/foo`、`#/wiki/foo`、`wiki/foo`、`foo`、`guides%2Fauthoring`、`foo?x=1#y`
 * 全部归一到 `foo` / `guides/authoring`。
 *
 * 导出是为了让 `[[wikilink]]` 的解析复用同一套归一（两处若各写一份，迟早漂移）。
 */
export function normalizeSlugTarget(pathish: string): string {
  let s = pathish.trim()
  // 允许直接传 hash 形态（`#/wiki/foo`）：先剥掉开头的 `#/`，
  // 否则下面的"去 fragment"会把整串当成 fragment 而清空（这一步实测踩到过）。
  s = s.replace(/^#\/?/, '')
  // 此后出现的 `#` 才是真正的 fragment
  const hash = s.indexOf('#')
  if (hash !== -1) s = s.slice(0, hash)
  const q = s.indexOf('?')
  if (q !== -1) s = s.slice(0, q)
  try {
    s = decodeURIComponent(s)
  } catch {
    /* 非法百分号编码（如 `%zz`）：按原样继续，交给后续判定 */
  }
  return (
    s
      .replace(/^\/+/, '')
      // `wiki` 既是路由前缀也是站点根：`/wiki`、`/wiki/`、`wiki/foo` 都要归一
      .replace(/^wiki(\/|$)/, '')
      .replace(/\/+$/, '')
  )
}

/**
 * 解析一个正文链接该怎么处理。
 *
 * @param href      `<a href>` 的原值
 * @param ctx.route 当前页面路由（形如 `wiki/<slug>`），锚点改写需要它
 * @param ctx.knownSlugs 已知页面 slug 的存在性判定；`null` 表示**尚未取到列表**。
 *        语义差别很重要：`null` 时我们**不判定"缺失"**（否则会在列表加载完成前
 *        把全站链接都标成不存在），只做"显式路径 → hash 表单"的形态改写。
 *        类型故意写成结构化的 `{ has }` 而非 `ReadonlySet`：调用方手上是
 *        `Map<slug, title>`（还需要标题来渲染 `[[wikilink]]` 的显示文本），
 *        没必要为了满足类型再复制一份 Set。
 */
export function resolveBodyLink(
  href: string,
  ctx: { route: string; knownSlugs: { has(slug: string): boolean } | null },
): LinkResolution {
  const raw = href.trim()
  const keep = (): LinkResolution => ({ kind: 'keep', href: raw, blank: false })

  if (raw === '') return keep()

  // 协议相对地址（`//example.com/x`）：按外链处理（它的 scheme 由当前页面决定）
  if (raw.startsWith('//')) return { kind: 'external', href: raw, blank: true }

  const scheme = SCHEME_RE.exec(raw)
  if (scheme !== null) {
    const s = (scheme[1] ?? '').toLowerCase()
    // 只有 http/https 值得新开标签；`mailto:`/`tel:` 交给系统处理，加了反而多一个空白页
    if (s === 'http' || s === 'https') return { kind: 'external', href: raw, blank: true }
    // `javascript:`/`data:`/未知 scheme：**原样保留、不做任何加工**。
    // 消毒层已摘掉危险 href；这里保证不会把它变成"我们构造的可点链接"。
    return keep()
  }

  if (raw.startsWith('#')) {
    const body = raw.slice(1)
    if (body === '') return keep() // `href="#"`：无目标，保持原样
    // 已经是本站的 hash 路由形态（正文里直接写 `#/wiki/foo`）
    if (body.startsWith('/')) return pageResolution(normalizeSlugTarget(body), raw, ctx)
    // 同页锚点 → 转成"路由内锚点"形态，否则会把 hash 换成 `#section` 打乱路由
    if (ctx.route === '') return keep() // 没有路由上下文时无法构造合法 hash（预览等场景）
    let id = body
    try {
      id = decodeURIComponent(body)
    } catch {
      /* 原样 */
    }
    return { kind: 'anchor', href: buildHash(ctx.route, id), blank: false }
  }

  // 站内绝对路径（`/architecture`）
  if (raw.startsWith('/')) return pageResolution(normalizeSlugTarget(raw), raw, ctx)

  // 相对路径：**有歧义**（`getting-started` 是页面，`image.png` 是文件）。
  // 只有在"确知它是页面"时才改写；否则原样保留，绝不猜。
  const slug = normalizeSlugTarget(raw)
  if (ctx.knownSlugs !== null && ctx.knownSlugs.has(slug)) {
    return pageResolution(slug, raw, ctx)
  }
  return keep()
}

function pageResolution(
  slug: string,
  raw: string,
  ctx: { knownSlugs: { has(slug: string): boolean } | null },
): LinkResolution {
  // 归一后为空（例如 `href="/"`）：这是站点根，不是页面，保持原样
  if (slug === '') return { kind: 'keep', href: raw, blank: false }
  const missing = ctx.knownSlugs !== null && !ctx.knownSlugs.has(slug)
  return { kind: missing ? 'missing' : 'page', href: pageHash(slug), blank: false, slug }
}
