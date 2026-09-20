/**
 * 阅读页布局守卫：把"正文不再缩成中间一根窄柱 / 不再被留白挤成一条"变成可执行断言。
 *
 * 缘起（用户原话，两轮）：
 *   1. 「居中好歹把整体页面填充满啊，两边空着这么多是什么意思」——当时 1920 视口下正文列
 *      694px、两侧各空 613px；
 *   2. 「面包屑的位置奇怪，而且切换文章时闪烁」「空得太多了」——第一版为"整页居中"加的
 *      左侧留白列 + `translateX(-131px)` 补丁，实测在侧栏与正文之间留下 187px 空白带
 *      （用户在图里框住了它），还让栅格盒子压住侧栏右半边、把面包屑推进留白列。
 *
 * 这个文件的断言都对应**真机踩过的具体回归**，不是形式化检查：
 *   · 右侧列若写 `1fr`，会被解析成"吃满剩余空间"（实测 1920 下 526px）；
 *   · 右侧列若写 `max-content`，会由列里最宽的**动作条**（445px）决定 ⇒ 正文列被挤窄；
 *   · 面包屑/预览条若不显式声明列号，自动放置会把它们丢进右侧那一列；
 *   · 右栏容器若不在 `xl` 以下隐藏，它会作为**第二行**摊在正文下方（实测被摊成整宽）；
 *   · 列里若哪张卡片自己加了 `width`/`margin-inline`，会与同列其它卡片错开（86px 阶梯）。
 *
 * 数据来源：直接读 `src` 与 `src/styles.css` 源文本（与 `contrastPlan.test.ts` 同做法），
 * 避免手抄数值产生同义反复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')

/*
 * 剥注释的工具。
 *
 * ⚠️ 这里刻意**不写含 `*` + `/` 的字面量**（例如 JSX 注释的收尾符号）：本文件自身是块注释
 * 包裹的模块，源码里出现那两个字面量会把上面的注释**提前闭合**，esbuild 直接报
 * `Unexpected "}"`（本轮踩过）。故用字符串拼接绕开。
 */
const CLOSE = '*' + '/'
const stripCssComments = (s: string): string => s.split('/*').map((part, i) => (i === 0 ? part : part.slice(part.indexOf(CLOSE) + 2))).join('')
const stripTsxComments = (s: string): string =>
  s
    .split('{' + CLOSE)
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf(CLOSE) + 2)))
    .join('')
    .replace(/^\s*\/\/.*$/gm, '')

const cssRaw = read('../src/styles.css')
const css = stripCssComments(cssRaw)
const wikiRaw = read('../src/pages/WikiPage.tsx')
const wiki = stripTsxComments(wikiRaw)

/** 抽出一条规则的规则体（选择器按字面量转义后精确匹配；允许规则被包在 @media 里缩进） */
const ruleBody = (selector: string): string => {
  const m = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.[\]()*+?^$|\\/]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(css)
  assert.ok(m, `应能找到 ${selector} 规则`)
  return m[1] as string
}

test('阅读栅格：存在且确实读到了文件', () => {
  assert.ok(cssRaw.length > 10_000, `styles.css 太短（${cssRaw.length}），疑似读错文件`)
  assert.ok(wiki.length > 20_000, `WikiPage.tsx 太短（${wiki.length}），疑似读错文件`)
  assert.ok(ruleBody('.gw-reader-grid').length > 0)
})

test('阅读栅格：正文列吃满中间（不得再有左侧留白列与整页居中补偿）', () => {
  /*
    两条断言锁的是用户这一轮明确要求放弃的形态（原话「空得太多了」「正文列吃满中间」）：
      · 左侧留白列（`.gw-reader-align`）与 `translateX(-131px)` 补偿：实测 1920 下
        侧栏右缘 302、正文左缘 489 ⇒ 187px 空白带；且 transform 不参与布局，
        栅格盒子会压在侧栏上 —— `elementFromPoint(194,135)` 实测返回 `DIV.gw-reader-grid`，
        侧栏每条链接的右半截点不动。
  */
  const hasRail = /\.gw-reader-grid\.has-rail\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(hasRail, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--gw-rail\)/, '有右栏时必须写「正文列 1fr + 右栏 --gw-rail」')
  assert.doesNotMatch(css, /gw-reader-align/, '左侧留白列必须已删除（它正是那块空白带）')
  assert.doesNotMatch(css, /translateX/, '整页居中的平移补偿必须已删除（它会压住侧栏、点不动）')
  assert.doesNotMatch(wiki, /gw-reader-align/, 'JSX 里的留白占位 div 也必须已删除')
})

test('阅读栅格：右栏必须是裸像素定宽（1fr / max-content 都踩过）', () => {
  const rail = ruleBody('.gw-reader-grid')
  assert.match(rail, /--gw-rail:\s*\d+px/, '右栏宽度必须定义成裸像素变量')
  const px = Number(/--gw-rail:\s*(\d+)px/.exec(rail)![1])
  assert.ok(px >= 200 && px <= 360, `右栏 ${px}px 超出合理区间 200~360：它装的是页内目录，不该吃满余量`)
  /*
    列宽里出现裸 `1fr` / `max-content` 就是回归：1fr 按"吃满剩余空间"解析（实测 526px），
    max-content 由列里最宽的动作条决定（实测 445px ⇒ 正文列只剩 777px）。
    `minmax(0, 1fr)` 是**正文列**的下限写法，不在此列 —— 故只禁裸 `1fr` 与 `max-content`。
  */
  const cols = [...css.matchAll(/grid-template-columns:([^;]*);/g)].map((m) => m[1] as string)
  assert.ok(cols.length > 0, '反空洞：应能抽到 grid-template-columns')
  for (const c of cols) {
    /* `minmax(0, 1fr)` 是正文列的合法写法（下限 0、可伸缩），先摘掉再看有没有裸轨道 */
    const bare = c.replace(/minmax\(\s*0\s*,\s*1fr\s*\)/g, '')
    assert.doesNotMatch(bare, /(^|[\s,(])1fr/, `列宽里的裸 1fr 会让右栏吃满剩余空间：${c.trim()}`)
    assert.doesNotMatch(c, /max-content/, `列宽里的 max-content 会随内容浮动（动作条实测 445px）：${c.trim()}`)
  }
})

test('阅读栅格：面包屑 / 预览条 / 正文都显式落在第 1 列', () => {
  /*
    自动放置的坑（实测踩过两次）：
      · 面包屑写 `grid-column: 1 / -1` ⇒ 起点落在左侧留白列里，看着像侧栏的一行（用户原话"位置奇怪"）；
      · 预览条**什么都没写** ⇒ 被自动放置丢进右侧那一列（当时宽 240px、与侧栏横向重叠）。
    动作条占满整行，自动放置的游标在它之后落到第 2 列，所以凡是没写列号的子项都会被塞进右栏。
  */
  assert.match(css, /\.gw-reader-grid\s*>\s*nav\[aria-label='面包屑'\][\s\S]{0,240}?grid-column:\s*1\s*;/, '面包屑必须显式落在第 1 列')
  assert.match(css, /\.gw-reader-grid\s*>\s*\.gw-reader-preview[\s\S]{0,240}?grid-column:\s*1\s*;/, '预览条必须显式落在第 1 列')
  assert.match(css, /\.gw-reader-grid\s*>\s*\.gw-reader-main[\s\S]{0,300}?grid-column:\s*1\s*;/, '正文列必须显式落在第 1 列')
  assert.match(wiki, /className="gw-reader-preview /, '预览条必须挂 gw-reader-preview 类名（列号由 CSS 给）')
})

test('阅读栅格：动作条占满整行 ⇒ 按钮组与右栏同右缘', () => {
  const actions = ruleBody('.gw-reader-actions')
  assert.match(actions, /grid-column:\s*1\s*\/\s*-1/, '动作条必须占满整行（按钮组才会与右栏同右缘）')
  assert.doesNotMatch(actions, /(^|[^-])width\s*:/, '动作条不得自设宽度：错误/提示条也活在这一行，按内容定宽会挤窄正文列')
})

test('阅读栅格：没有右栏时正文按 measure 封顶，且与有右栏时同左缘', () => {
  const noRail = /\.gw-reader-grid:not\(\.has-rail\)\s*>\s*\.gw-reader-main\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(noRail, /width:\s*min\(100%,\s*var\(--spacing-measure\)\)/, '无右栏的单列页必须把正文封顶在 --spacing-measure（否则超宽屏上会拉成一条长文）')
  assert.doesNotMatch(noRail, /margin-inline/, '不得居中：居中会让"有目录 / 没目录"两种页面左右错开 123px（切文章时看着像闪）')
  const measure = read('../src/styles/tokens.css')
  assert.match(measure, /--gw-spacing-measure:\s*min\(84rem,\s*92em\)/, '行宽上限被改过：有右栏时它不生效，改动要先想清楚单列页')
})

test('阅读卡片：仍不自己限宽/居中（否则同列卡片错开成阶梯）', () => {
  const article = ruleBody('article.gw-reader')
  assert.doesNotMatch(article, /(^|[^-])width\s*:/, 'article.gw-reader 不得自己设 width（宽度归栅格列）')
  assert.doesNotMatch(article, /margin-inline\s*:/, 'article.gw-reader 不得自己居中（会让同列卡片错开）')
})

test('右栏容器：xl 以下必须隐藏（否则摊成正文下方整宽的一块）', () => {
  /*
    栅格的双栏规则带 `@media (min-width: 1280px)` 门槛；右栏容器若不隐藏，
    1280 以下会作为第二行落下（实测 1024 档「本页信息」被摊成 703px 整宽，
    且该行 x 变成父容器的 x，与正文列不再对齐）。
  */
  assert.match(wiki, /className="gw-reader-rail hidden min-w-0 flex-col gap-4 xl:flex"/, '右栏容器必须 `hidden … xl:flex`：窄屏要回到纯单栏')
})

test('右栏内容：目录跟着"正在显示的那一份"走（预览历史版本时必须换）', () => {
  /*
    实测缺陷（`#/wiki/getting-started?v=6`）：快照正文的小节是「安装 / 特性」，
    右栏目录却列着当前版的「安装 / 下一步」—— 点得到的小节在快照里不存在，快照里真有的
    那一节又不在目录里。两份 TOC 必须与正文同源，均取 `shownToc`。
  */
  assert.match(wiki, /const shownToc = previewing \? renderedSnapshot\.toc : rendered\.toc/, 'TOC 必须跟着 shown（预览态 = 快照）走')
  assert.equal((wiki.match(/entries=\{shownToc\}/g) ?? []).length, 2, '两份 TOC（窄屏折叠 + 右栏）都必须用 shownToc')
  assert.doesNotMatch(wiki, /entries=\{rendered\.toc\}/, '不得再用当前正文的目录喂 TOC')
  assert.match(wiki, /homeMode && <HomeAside/, '主页的「最近更新」必须仍在右栏')
  assert.match(wiki, /variant="sidebar"/, '页内目录的 sidebar 变体必须仍在右栏')
})

test('骨架屏：与真实阅读页同构（同一个 .gw-reader-grid），否则切文章会整屏跳', () => {
  /*
    实测（1920，把接口延迟 2500ms）：旧骨架是一叠整宽方块 —— 面包屑 x=324、正文块宽 734；
    数据到达后同一元素变成 x=193、正文列 489..1431 ⇒ 一次导航整屏位移，用户原话"切换文章时闪烁"。
  */
  assert.match(
    wiki,
    /<LoadingState slow=\{slowDetail\} label="正在加载页面…">[\s\S]{0,1400}?className="gw-reader-grid has-rail"/,
    '加载骨架必须复用 .gw-reader-grid.has-rail',
  )
  assert.match(
    wiki,
    /className="gw-reader-actions flex flex-wrap items-center gap-2"[\s\S]{0,900}?className="gw-reader-main flex min-w-0 flex-col gap-4"/,
    '骨架必须有动作条与正文列两个同名容器',
  )
})

test('右栏 TOC：包含块必须被撑高，否则 position: sticky 形同虚设（用户实测"目录不跟随下滑"）', () => {
  /*
    2026-09-16 用户原话："文章中的本页目录要求随用户下滑，能够一直显示在右侧，方便导航"。

    组件里早就写了 `position: sticky`，但**从来没生效过**。真凶不是 overflow（祖先链全部 visible，
    唯一非 visible 的是 nav 自己的 overflow-y-auto），而是**高度**：
    sticky 只能在自己的**包含块**内滑动，包含块就是那层 `<aside>`；而 `.gw-reader-rail` 是
    `flex flex-col`，flex **纵轴不拉伸**（`align-items: stretch` 只管横轴）⇒ aside 留在内容高度
    （真浏览器实测 516px，与目录自身等高），rail 被栅格行拉到 8818px（= 正文高度）⇒
    目录一格都滑不动：滚 1800px 后它的顶边跑到 −1645，仍在文档流里被推走。

    修法：给包含块 `xl:grow` 吃掉 rail 的剩余高度。这条判据钉的就是"包含块必须被撑高"，
    以及 nav 的三个 sticky 前提（sticky + top 用顶栏高度 + 自身限高可滚）。
  */
  // 本文件此前只用 `readFileSync(WIKI)` 读单个文件，没有 SRC/join 常量：就地补上
  const SRC = join(import.meta.dirname, '..', 'src')
  const toc = readFileSync(join(SRC, 'components', 'TableOfContents.tsx'), 'utf8')
  const aside = /<aside className="([^"]+)"/.exec(toc)?.[1] ?? ''
  assert.match(aside, /\bxl:grow\b|\bgrow\b/, `sidebar 的 <aside> 必须 grow（当前 "${aside}"）——它是 sticky 的包含块`)
  assert.match(aside, /hidden/, '窄屏仍必须隐藏（折叠块接管）')
  assert.match(toc, /包含块/, '必须保留"包含块为什么必须撑高"的注释，否则下一个人会把 grow 当装饰删掉')

  // 直接认"以 sticky 开头的那串 className"：文件里有**两个** aria-label="页内目录" 的 nav
  // （窄屏折叠块在前），按顺序取第一个会取到折叠块、判据必然假红
  const nav = /className="(sticky[^"]*)"/.exec(toc)?.[1] ?? ''
  assert.match(nav, /\bsticky\b/, 'nav 必须 sticky')
  assert.match(nav, /top-\[calc\(var\(--spacing-header\)\+16px\)\]/, 'sticky 的 top 必须与顶栏高度同源（--spacing-header）')
  assert.match(nav, /max-h-\[calc\(100vh/, 'nav 必须自身限高')
  assert.match(nav, /overflow-y-auto/, 'nav 必须自身可滚（超长目录不能溢出视口）')
})

test('阅读页：折叠摘要卡挂在标题**下面**（2026-09-17 用户要求；别再挪回标题之上）', () => {
  /*
    用户原话：「把摘要的显示位置调整到标题下面」。

    摘要位刚落地时渲染在 `<h1>` **之前**（"文章最上方"的字面要求，当时的理由写在
    `WikiPage.tsx` 的挂载点注释里）；本批按用户口径改为**标题之后、正文之前**。
    守卫钉三件事，都不靠数值：
      ① 标题在前、摘要在后；
      ② 摘要仍落在 `article.gw-reader` 里（不能跑到栅格其它列，也不该跑到面包屑之上）；
      ③ 摘要仍在正文之前 —— 它是标题的补充，不是正文的第一段。
  */
  const articleAt = wiki.indexOf('<article className="gw-reader">')
  const articleEnd = wiki.indexOf('</article>', articleAt)
  assert.ok(articleAt > 0 && articleEnd > articleAt, '应能找到 article.gw-reader 的开闭标签')

  const card = wiki.slice(articleAt, articleEnd)
  const h1At = card.indexOf('<h1 className="mt-0 mb-3 text-2xl leading-tight font-bold text-ink">{page.title}</h1>')
  const summaryAt = card.indexOf('<ArticleSummarySlotOutlet slug={page.slug} title={page.title} />')
  const bodyAt = card.indexOf('<MarkdownBody html={shown.html} className="md-body" />')

  assert.ok(h1At >= 0, '文章标题 <h1> 必须仍在 article.gw-reader 内')
  assert.ok(summaryAt >= 0, 'article-summary 出口必须仍在 article.gw-reader 内（不能挪去栅格其它列）')
  assert.ok(bodyAt >= 0, '正文 <MarkdownBody> 必须仍在 article.gw-reader 内')
  assert.ok(h1At < summaryAt, `摘要必须在标题**之后**（现状 h1@${h1At}、summary@${summaryAt}）—— 用户要求"调整到标题下面"`)
  assert.ok(summaryAt < bodyAt, `摘要必须在正文**之前**（现状 summary@${summaryAt}、body@${bodyAt}）`)
})
