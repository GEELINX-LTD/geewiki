/**
 * 阅读页布局守卫：把"正文不再缩成中间一根窄柱"变成可执行断言。
 *
 * 起因（用户原话）：「居中好歹把整体页面填充满啊，两边空着这么多是什么意思」——
 * 当时的实测是 1920 视口下正文列 694px、两侧各空 613px；右栏只在"有 ≥2 个标题或主页"
 * 时才出现，于是没有两级标题的普通页（`welcome`）右栏整条消失，正文独自居中。
 *
 * 这个文件的断言都对应**真机踩过的具体回归**，不是形式化检查：
 *   · 右栏若不在 `xl` 以下隐藏，它会作为**第二行**摊在正文下方（实测 1024 档被摊成 703px 整宽）；
 *   · 栅格若被撑满（列宽之和超过阅读区），`margin-inline: auto` 失效 ⇒ 内容贴右边
 *     （实测 1280 档左空 284 / 右空 22）；
 *   · 列里若哪张卡片自己加了 `width`/`margin-inline`，会与同列其它卡片错开（历史上 86px 阶梯）；
 *   · 右栏若改用 `1fr`/`max-content`，两列不再是一个视觉整体（实测 1fr 在 1920 下算出 528px）。
 *
 * 数据来源：直接读 `src` 与 `src/styles.css` 源文本（与 `contrastPlan.test.ts` 同做法），
 * 避免手抄数值产生同义反复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

test('阅读栅格：列宽用变量，不再写死 694px/15rem 这类旧值', () => {
  // 反空洞：文件确实被读到、确实是那份 CSS
  assert.ok(cssRaw.length > 10_000, `styles.css 太短（${cssRaw.length}），疑似读错文件`)
  assert.match(css, /\.gw-reader-grid\s*\{[\s\S]*?--gw-read:\s*clamp\(/, '.gw-reader-grid 必须定义正文列宽变量 --gw-read')
  assert.match(css, /\.gw-reader-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*var\(--gw-read\)\)/, '单栏轨道必须引用 --gw-read')
  assert.doesNotMatch(css, /minmax\(0,\s*694px\)/, '不得回退到写死的 694px（旧行宽口径）')
  assert.doesNotMatch(css, /minmax\(0,\s*15rem\)/, '右栏不得回退到 15rem（240px，两列之和撑不满阅读区）')
})

test('阅读栅格：右栏宽度分档且随断点单调不减', () => {
  /*
    真机依据（1920×1080）：右栏 240 时两列之和 958，而阅读区 1246 ⇒ 居中后两侧各空 144。
    现取 300 / 320 / 360 三档，覆盖 1280 / 1440 / 1600 三个断点。

    ⚠️ 同一断点下可能有多条 `.gw-reader-grid.has-rail` 规则（列宽一条、补偿一条），
    所以这里按"媒体块"归并后再找右栏宽度，不能假设"一个断点只有一条、且第一条就是列宽"。
  */
  const byBreakpoint = new Map<number, string[]>()
  for (const m of css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.gw-reader-grid\.has-rail\s*\{([^}]*)\}/g)) {
    const min = Number(m[1])
    byBreakpoint.set(min, [...(byBreakpoint.get(min) ?? []), m[2] as string])
  }
  assert.ok(byBreakpoint.size >= 3, `应有三档右栏规则，实际找到 ${byBreakpoint.size} 个断点`)
  const railPx = [...byBreakpoint.entries()]
    .map(([min, bodies]) => {
      /*
        ⚠️ 右栏列必须写成**裸像素**（`… var(--gw-read)) 360px`）。
        曾经写成 `minmax(300px, 1fr)`：`1fr` 会按栅格可用空间解析 ⇒ 1920 下右栏被拉成
        **526px**，而「本页信息」只有四行短文字 ⇒ 卡内空出几百像素（用户看到的"右栏被拉宽、
        内部反而空"）。也**不能**写 `minmax(0, Npx)`：下限 0 让轨道可被压到 0 宽。
        故这里取"轨道的裸像素宽度"，并要求它落在窄栏区间内（内容相称，不随视口膨胀）。
      */
      const found = bodies
        .map((b) => /var\(--gw-read\)\)\s*(\d+)px/.exec(b))
        .filter((r): r is RegExpExecArray => r !== null)
      assert.ok(found.length > 0, `断点 ${min} 的 has-rail 规则里找不到右栏像素宽度（该断点规则体：${bodies.join(' | ').trim()}）`)
      const px = Number(found[0]![1])
      assert.ok(px >= 260 && px <= 400, `右栏宽度 ${px}px 超出窄栏区间 260~400：右栏应与内容相称，不吃满余量`)
      return { min, px }
    })
    .sort((a, b) => a.min - b.min)
  for (let i = 1; i < railPx.length; i += 1) {
    assert.ok(railPx[i]!.min > railPx[i - 1]!.min, '右栏断点必须严格递增（否则后写的规则永远盖住前一条）')
    assert.ok(railPx[i]!.px >= railPx[i - 1]!.px, `右栏宽度不得随视口变宽而变窄：${railPx[i - 1]!.px} → ${railPx[i]!.px}`)
  }
  assert.ok(railPx[0]!.px > 240, '最窄一档也必须比旧的 240px 宽，否则又回到"两列撑不满阅读区"')
})

test('阅读栅格：块宽按内容定宽 + 居中，且 ≥1440 补偿阅读区偏移', () => {
  /*
    两件互相牵制的事，缺一条就会退回用户抱怨的形态（2026-09-13 实测）：
      · 块宽写 `100%`（撑满）⇒ 两列只占一段、`margin-inline: auto` 没有余量可分
        ⇒ 块右对齐、文章贴左，右侧空一大条；
      · 只居中不补偿 ⇒ 阅读区本身被左侧栏右推 131px，块跟着右偏（实测 1920 左空 487 / 右空 225）。
    实测补偿后：1920 356/356、1600 196/196、1440 153/153（左右完全相等）。
  */
  const grid = /^\.gw-reader-grid\s*\{([\s\S]*?)\n\}/m.exec(css)
  assert.ok(grid, '应能找到 .gw-reader-grid 规则')
  const body = grid[1]!
  assert.match(body, /width:\s*max-content/, '块宽必须 max-content（按内容定宽，才能被 auto 边距居中）')
  assert.match(body, /margin-inline:\s*auto/, '块必须 margin-inline: auto 居中')
  assert.doesNotMatch(body, /(^|[^-])width:\s*100%/, '块宽不得写 100%：撑满后居中失效、内容贴左')
  assert.match(
    css,
    /@media\s*\(min-width:\s*1440px\)\s*\{\s*\.gw-reader-grid\.has-rail\s*\{\s*transform:\s*translateX/,
    '≥1440 有右栏时必须补偿阅读区偏移（否则块相对视口右偏约 131px）',
  )
  assert.match(
    css,
    /@media\s*\(min-width:\s*1280px\)\s*\{\s*\.gw-reader-grid:not\(\.has-rail\)\s*\{\s*transform:\s*translateX/,
    '≥1280 无右栏时的补偿规则不得被删（窄屏无侧栏，两者中心重合）',
  )
})

test('阅读栅格：1280~1439 有右栏时收窄正文列（否则内容贴右缘）', () => {
  /*
    这一档侧栏已出现（lg:block）而外壳还没到 1552，阅读区只有 974px：
    `764 + 24 + 272 = 1060` 超出 86px ⇒ 栅格被撑满、`margin-inline: auto` 失效。
    实测未收窄时 1280×900：左空 284 / 右空 22（内容贴右边）。故必须有一条收窄规则。
  */
  assert.match(
    css,
    /@media\s*\(min-width:\s*1280px\)\s*and\s*\(max-width:\s*1439px\)\s*\{\s*\.gw-reader-grid\.has-rail\s*\{\s*--gw-read:\s*\d+px/,
    '缺 1280~1439 档的收窄规则：栅格会超出阅读区，文章被推到右缘',
  )
})

test('阅读栅格：不得用 1fr / max-content 定右栏列宽', () => {
  const gridBlocks = Array.from(css.matchAll(/\.gw-reader-grid[^{]*\{[^}]*\}/g))
    .map((m) => m[0])
    .join('\n')
  assert.ok(gridBlocks.includes('grid-template-columns'), '反空洞：应能抽到栅格规则')
  assert.doesNotMatch(gridBlocks, /grid-template-columns:[^;]*\b1fr\b/, '右栏写 1fr 会被 fit-content 解析成整块可用空间，两列被拉开')
  assert.doesNotMatch(gridBlocks, /grid-template-columns:[^;]*max-content/, '右栏写 max-content 会随内容换行浮动，撑不住整体居中')
})

test('阅读卡片：仍不自己限宽/居中（否则同列卡片错开成阶梯）', () => {
  const article = /article\.gw-reader\s*\{([^}]*)\}/.exec(css)
  assert.ok(article, '应能找到 article.gw-reader 规则')
  assert.doesNotMatch(article[1]!, /(^|[^-])width\s*:/, 'article.gw-reader 不得自己设 width（宽度归栅格列）')
  assert.doesNotMatch(article[1]!, /margin-inline\s*:/, 'article.gw-reader 不得自己居中（会让同列卡片错开）')
})

test('右栏容器：xl 以下必须隐藏（否则摊成正文下方整宽的一块）', () => {
  /*
    栅格的双栏规则带 `@media (min-width: 1280px)` 门槛；右栏容器若不隐藏，
    1280 以下会作为第二行落下（实测 1024 档「本页信息」被摊成 703px 整宽，
    且该行 x 变成父容器的 x，与正文列不再对齐）。
  */
  assert.match(wiki, /className="hidden min-w-0 flex-col gap-4 xl:flex"/, '右栏容器必须 `hidden … xl:flex`：窄屏要回到纯单栏')
})

test('右栏内容：本页信息恒在（任何页面都有右栏的依据）', () => {
  assert.match(wiki, /<PageInfoAside page=\{page\} \/>/, '右栏必须包含「本页信息」——它是 hasRightRail 恒为真的依据')
  assert.match(wiki, /function PageInfoAside\(/, 'PageInfoAside 组件必须存在')
  // 反空洞：确认读到的确实是 WikiPage 源码，而不是空串或别的文件
  assert.ok(wiki.length > 20_000, `WikiPage.tsx 太短（${wiki.length}），疑似读错文件`)
  // 主页的「最近更新」与页内目录仍在右栏（不能因为加信息块而把它们挤掉）
  assert.match(wiki, /homeMode && <HomeAside/, '主页的「最近更新」必须仍在右栏')
  assert.match(wiki, /variant="sidebar"/, '页内目录的 sidebar 变体必须仍在右栏')
})
