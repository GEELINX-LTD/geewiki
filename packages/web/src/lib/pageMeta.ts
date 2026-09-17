/**
 * 页面元信息（标题、正文首个标题去重）——**纯函数，不接触 DOM**，便于 node 单测。
 *
 * 拆成独立模块的理由与 `searchPlan.ts` 一致：标题映射与 Markdown 首标题剥离都是
 * 可判定的字符串逻辑，放进组件里就只能靠浏览器验证；放这里可以用 `node:test` 钉住边界。
 * 真正写 `document.title` 的副作用在 `useDocumentTitle.ts`（单独一个文件，保持本模块纯净）。
 */

/** 产品名（标题后缀与品牌名共用一处，避免散落） */
export const APP_NAME = 'GeeWiki'

/** 路由首段 → 展示名（不含详情页的动态标题） */
const SECTION_LABEL: Record<string, string> = {
  wiki: '知识库',
  plugins: '插件管理',
  // 权限治理（M1）。它是**独立首段**（`#/access` 与 `#/access/<slug>`），
  // 不能挂在 `wiki/` 下：`parseWikiRoute` 只保留 search|ask|new|list 四个首段，
  // `#/wiki/<slug>/access` 会被解析成"slug 含 /access"的页面。
  access: '权限治理',
  // 组织与邀请管理（P5-B M4/M5）。同样是独立首段（`#/org`）：它整页按 `administer`
  // 门控，与权限治理（普通成员也有 manageVisibility）不是同一批人用的入口。
  org: '组织',
  // 身份相关（P1）。它们不进导航，但会出现在 `document.title` 里 ——
  // 浏览器标签页与历史记录里显示"登录 · GeeWiki"远比显示裸产品名有用。
  login: '登录',
  setup: '初始化',
  denied: '无访问权限',
  // P1.5：SSO 身份的绑定/解绑入口
  account: '账号',
}

/**
 * 知识库下的**有自己视图**的保留子路由 → 展示名。
 *
 * `ask` 曾在表里（P8 随 `#/wiki/ask/<q>` 一起删除，决策 17）。它仍是**保留段**
 * （`WIKI_RESERVED_FIRST_SEGMENTS`，见 lib/wikiRoute.ts 的理由），只是不再有视图——
 * 于是 `#/wiki/ask` 现在按详情页解析，标题退化为「知识库」或该 slug 的标题。
 */
const WIKI_SUB_LABEL: Record<string, string> = {
  new: '新建页面',
  search: '搜索',
}

/**
 * 把当前 hash 路由映射为 `document.title`。
 *
 * @param route 形如 `wiki/getting-started`（调用方已剥掉 `#/` 前缀与首尾斜杠）
 * @param pageTitle 详情页的**页面标题**（异步取回）。取不到时传 null/undefined，
 *                  此时退化为「知识库」，**不要**退化成 slug（slug 是给 URL 用的，不是给人看的）。
 */
export function titleForRoute(route: string, pageTitle?: string | null): string {
  const seg = route
    .replace(/^#/, '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  // 空路由 = 知识库首页（App 的 `nav()` 也把空路由规范化为 /wiki）
  if (seg.length === 0) return withAppName(SECTION_LABEL['wiki'] as string)

  const root = seg[0] as string
  const label = SECTION_LABEL[root]

  if (root === 'wiki') {
    if (seg.length === 1) return withAppName('知识库')
    const sub = seg[1] as string
    const subLabel = WIKI_SUB_LABEL[sub]
    if (subLabel !== undefined && subLabel !== '') {
      // search/<q> 的第二段是查询串：不进标题（可能很长），只显示分区名
      return withAppName(subLabel)
    }
    // 到这里 seg[1] 是 slug：详情页（seg[2] === 'edit' 时为编辑页）
    if (seg[2] === 'edit') return withAppName('编辑页面')
    const title = (pageTitle ?? '').trim()
    return withAppName(title !== '' ? title : '知识库')
  }

  if (label !== undefined && label !== '') return withAppName(label)

  // 未知路由：只显示产品名（不伪装成某个页面）
  return APP_NAME
}

function withAppName(label: string): string {
  return `${label} · ${APP_NAME}`
}

/** 归一化标题文本：折叠空白、去首尾（用于比较"是否同一个标题"） */
function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 去掉正文**开头的第一个标题**——当它与页面标题重复时。
 *
 * 详情页会单独渲染 `<h1>{page.title}</h1>`，而很多页面正文自己也以 `# 同名标题` 开头，
 * 于是同一个标题在页面上出现两次（用户反馈的"标题重复"）。
 *
 * 做法：**只在首个标题与页面标题相同时**移除该标题行，其余结构与正文一字不动
 * （Markdown 仍照常交给 `mdToHtml` 消毒，本函数不产生任何 HTML）。
 *
 * 支持的写法：
 * - ATX：`# 标题`、`# 标题 #`（闭合井号）、`#标题`（无空格）
 * - Setext：`标题` 紧跟一行 `=====`
 *
 * 保守原则：只要不确定，就**原样返回**（宁可重复一次，也不要误删作者真正想显示的小标题）。
 */
export function stripDuplicateLeadingTitle(markdown: string, title: string): string {
  const want = normalizeHeading(title)
  if (want === '') return markdown

  const lines = markdown.split('\n')

  // 跳过开头的空行（正文常以空行打头）；保留它们，以便"不确定就原样返回"时字节不变
  let start = 0
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++
  if (start >= lines.length) return markdown

  const first = lines[start] ?? ''
  let end = start // 标题块最后一行下标（含）

  // ATX 标题：`#` 到 `######`（`(?!#)` 防止把 7 个 `#` 误判成 6 级）
  const atx = /^ {0,3}(#{1,6})(?!#)\s*(.*?)\s*#*\s*$/.exec(first)
  if (atx !== null) {
    const hashes = atx[1] ?? ''
    const text = atx[2] ?? ''
    if (hashes.length !== 1) return markdown // 只认为一级标题与页面标题重复
    if (normalizeHeading(text) !== want) return markdown
  } else {
    // Setext 一级标题：`标题` 紧跟一行 `=====`（当心 `---` 是二级标题，不动）
    const underline = lines[start + 1]
    if (underline === undefined || !/^ {0,3}=+\s*$/.test(underline)) return markdown
    if (normalizeHeading(first) !== want) return markdown
    end = start + 1
  }

  // 连同标题后紧跟的一个空行一起删掉，避免留下多余空白
  let removeTo = end
  if ((lines[removeTo + 1] ?? '').trim() === '') removeTo += 1

  return [...lines.slice(0, start), ...lines.slice(removeTo + 1)].join('\n')
}
