/**
 * `app-dock` 展开/收起动画的**源码守卫**。
 *
 * ## 为什么是源码守卫
 * 用户的原话是「展开和收起没有动画，非常生硬」。**动画的判据全在结构里**：
 * 面板是不是常驻 DOM、折叠盒上有没有多写一条 padding、两种状态的输入行是不是同一个盒子。
 * 这些改错了都不会报错，也不会让任何渲染测试变红——症状只有一个："看着还是生硬"，
 * 而那是主观的、不会有人为它写回归测试。所以这里把每一处"为什么会生硬/会漏"变成断言。
 *
 * 本仓前端测试的约定是「`.tsx`/`.css` 只当源文本读、不 import」（见 `pluginUi.test.ts`
 * 的同类做法）：真渲染要牵进 React、插槽注册表与插件加载器，代价远大于收益。
 *
 * ## 各条守卫对应的事实（每条都是踩过的或明确会踩的坑）
 *   ① 面板必须**常驻 DOM**。回到 `{open && …}` 就等于回到"没有动画"。
 *   ② 折叠只是几何变化，DOM 还在 ⇒ 收起态必须 `inert`（+ `aria-hidden`），
 *      否则「历史 / 新对话 / 收起 / 发送」这些看不见的按钮仍然进 Tab 序列。
 *   ③ 高度必须由 `grid-template-rows: 0fr → 1fr` 过渡（而不是猜一个 max-height）。
 *   ④ 网格项（`.gw-dock-clip`）上不能有 padding / border / margin：它们不受
 *      `min-height: 0` 约束，`0fr` 塌不到 0，收起后留一条亮线。
 *   ⑤ 投影要在**裁剪盒之外**（`.gw-dock-shell`）——`overflow: hidden` 会把面板自己的
 *      外投影裁掉，卡片会突然没有影子。
 *   ⑥ 两种状态的输入行必须是同一个盒子（55px）：`.gw-dock-bar` 与 `.gw-dock-form`
 *      原先是 55px 与 auto（≈45px），展开那一瞬间底行会缩 10px。
 *   ⑦ 有动效就必须有"减少动效"偏好守卫（这条 `pluginUi.test.ts` 也管，但那里只管
 *      "有没有"，这里管"覆没覆盖到全部动效选择器"）。
 *   ⑧ **输入条也必须常驻 DOM**（用 `.gw-dock-bar-clip` 的高度收放，不是 `{!open && …}`）。
 *      用户第二批反馈「点击收起后会抽搐一下」就是这条：卸载让根盒子瞬间少 63px，
 *      而根是钉住底边的 ⇒ 顶边瞬移 63px。当时的量取只看 `.gw-dock-shell` 的高度
 *      （那一项单调），所以没抓到——判据要看**根盒子**。
 *   ⑨ 展开后焦点必须交接到面板里的输入框。收起态与展开态是**两个不同的** input，
 *      点收起态那个 ⇒ 它被收进 inert 的裁剪盒 ⇒ 焦点被甩到 body ⇒ 用户得再点一下。
 *   ⑪ 输入条与面板输入行的落差 `--dock-row-lift` 必须等于"外壳下边距 + 面板下内边距
 *      + 面板下边框"（三项任意一项改了都要跟着改，故用守卫算这笔账）。
 *   ⑩ 大位移（面板高度/输入条高度/容器宽度）必须走 `--ease-move`。`--ease-standard`
 *      是给 150ms 的颜色·小位移调的：25% 时间走完 50% 距离、峰值 2.9×平均速度
 *      （184px ⇒ 单帧 37px），用在抽屉上就是"一冲一顿"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const UI_FILE = join(here, '..', 'ui', 'index.tsx')
const CSS_FILE = join(here, '..', 'ui', 'style.css')

const uiSource = readFileSync(UI_FILE, 'utf8')
/** 注释里会提到选择器与属性名，判定必须看剥掉注释的代码 */
const css = readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 取某条选择器的声明块（按选择器文本精确查找，找不到就抛——守卫失效不得静默通过） */
function block(selector: string): string {
  const blocks = allBlocks(selector)
  assert.ok(blocks.length > 0, `style.css 里找不到 \`${selector}\` —— 结构变了，守卫已失效，不得静默通过`)
  return blocks[0] as string
}

/**
 * 取**全部**同名选择器的声明块。
 * 为什么需要它：`.gw-dock-panel` 在本表里出现两次（收起态一组属性、卡片本体一组），
 * 只看第一处会漏掉第二处——"面板上不该再留 box-shadow"这种断言必须扫全部。
 */
function allBlocks(selector: string): string[] {
  const out: string[] = []
  for (let at = css.indexOf(`${selector} {`); at >= 0; at = css.indexOf(`${selector} {`, at + 1)) {
    const open = css.indexOf('{', at)
    const close = css.indexOf('}', open)
    assert.ok(close > open, `\`${selector}\` 的声明块没有闭合`)
    out.push(css.slice(open + 1, close))
  }
  return out
}

/* ============================ ① 面板常驻 DOM ============================ */

test('① 面板不再被条件挂载（`{open && …}` 一挂上去动画就没有起点）', () => {
  assert.ok(
    !/\{open\s*&&\s*\(\s*\n\s*<section className="gw-dock-panel"/.test(uiSource),
    '面板又回到 `{open && (<section className="gw-dock-panel">…)}` 了：元素被卸载就没有可插值的起点，展开/收起必然瞬间完成',
  )
  const shell = uiSource.indexOf('<div className="gw-dock-shell"')
  const panel = uiSource.indexOf('<section className="gw-dock-panel"')
  assert.ok(shell >= 0, '找不到 `.gw-dock-shell`：折叠容器没了，动画与 inert 都无从谈起')
  assert.ok(panel > shell, '面板必须在 `.gw-dock-shell` **之内**（否则折叠的是空气）')
})

/* ============================ ② 收起态必须 inert ============================ */

test('② 收起态 inert + aria-hidden 绑在裁剪盒上（折叠 ≠ 卸载）', () => {
  /*
    2026-09-16 第三批：`inert` 从外壳挪到了**裁剪盒**。
    输入行（`.gw-dock-row`）现在是外壳的第二个网格行、在裁剪盒之外，若 inert 还挂在外壳上，
    收起态会把**唯一**的输入框也一起冻住——而收起态恰恰是它最该能打字的时候（点它才展开）。
    裁剪盒里装的是表头与对话流，它们才需要被挡住。
  */
  const clipTag = uiSource.slice(
    uiSource.indexOf('<div className="gw-dock-clip"'),
    uiSource.indexOf('>', uiSource.indexOf('<div className="gw-dock-clip"')) + 1,
  )
  assert.match(clipTag, /inert=\{!open\}/, `.gw-dock-clip 上必须 inert={!open}（当前：${clipTag}）`)
  assert.match(
    clipTag,
    /aria-hidden=\{!open\}/,
    `.gw-dock-clip 上必须 aria-hidden={!open} —— inert 管键盘，这一条是同一件事对读屏的表述`,
  )
  const shellTag = uiSource.slice(
    uiSource.indexOf('<div className="gw-dock-shell"'),
    uiSource.indexOf('>', uiSource.indexOf('<div className="gw-dock-shell"')) + 1,
  )
  assert.doesNotMatch(shellTag, /inert=/, '外壳不得 inert：输入行住在它里面')
})

/* ============================ ③④⑤ 折叠机制 ============================ */

test('③ 高度走 `grid-template-rows: 0fr → 1fr` 过渡（不猜 max-height）', () => {
  const collapsed = block('.gw-dock-shell')
  assert.match(collapsed, /display:\s*grid/, '折叠容器必须是 grid，否则 fr 轨道无从谈起')
  assert.match(collapsed, /grid-template-rows:\s*0fr/, '收起态必须是 0fr')
  assert.match(
    collapsed,
    /transition:[\s\S]*grid-template-rows/,
    '必须声明 grid-template-rows 的过渡，否则 0fr 与 1fr 之间仍是瞬间切换',
  )
  assert.match(
    block('.gw-dock-open .gw-dock-shell'),
    /grid-template-rows:\s*1fr/,
    '展开态必须是 1fr（终值取内容自然高度）',
  )
})

test('④ 网格项 `.gw-dock-clip` 只有裁剪，不许带 padding/border/margin', () => {
  const clip = block('.gw-dock-clip')
  assert.match(clip, /min-height:\s*0/, 'min-height: 0 是网格项能塌到 0 的前提')
  assert.match(clip, /overflow:\s*hidden/, '没有 overflow: hidden 就裁不掉折叠中的卡片')
  for (const prop of ['padding', 'border', 'margin']) {
    assert.ok(
      !new RegExp(`(^|[;\\s])${prop}[\\s:-]`).test(clip),
      `.gw-dock-clip 上出现了 ${prop}：它不受 min-height: 0 约束，0fr 会塌不到 0（收起后留一条亮线或一条缝）`,
    )
  }
})

test('⑤ 卡片投影挂在裁剪盒之外（`overflow: hidden` 会裁掉外投影）', () => {
  assert.match(
    block('.gw-dock-open .gw-dock-shell'),
    /box-shadow:\s*0 10px 32px/,
    '展开态的卡片投影应在 .gw-dock-shell 上；挂在 .gw-dock-panel 上会被裁剪盒裁得一干二净',
  )
  assert.ok(
    allBlocks('.gw-dock-panel').every((b) => !/box-shadow/.test(b)),
    '.gw-dock-panel（**每一处**声明，含卡片本体那条）都不该再有 box-shadow：它被 .gw-dock-clip 裁掉，留着只会让人以为它会显示',
  )
  assert.match(
    block('.gw-dock-shell'),
    /box-shadow:\s*0 0 0 rgb\(0 0 0 \/ 0%\)/,
    '收起态（基础值）必须是全透明投影：0 高盒子配 32px 模糊投影会在输入条上方留一道灰印',
  )
})

/* ============================ ⑥ 两种状态的输入行同一个盒子 ============================ */

test('⑥ 输入行只能有**一个**：收起的与展开的必须是同一个 DOM 节点（用户原话："感觉收起的输入框和展开的是两个东西"）', () => {
  /*
    2026-09-16 第三批。改前是两个盒子：收起态 `.gw-dock-bar` 里的 input、展开态面板里
    `.gw-dock-form` 的 input（连占位文案都不同）。堆了三处补丁（常驻 DOM + 裁剪盒高度插值 +
    抬 19px 对齐）也盖不住"有两个盒子"这件事——交接期间两个框一收一放，看起来就是换了个东西。

    现在：唯一输入行 `.gw-dock-row` 是外壳的第二个网格行、在裁剪盒**之外**，
    卡片用 `grid-template-rows: 0fr auto → 1fr auto` 在它上方长大。
  */
  assert.equal((uiSource.match(/className="gw-dock-input"/g) ?? []).length, 1, '整个界面只能有一个输入框')
  assert.equal((uiSource.match(/<form\s/g) ?? []).length, 1, '整个 dock 只有一个 form（两份就意味着又有两套输入行）')
  assert.equal((uiSource.match(/className="gw-dock-row"/g) ?? []).length, 1, '输入行只能有一个')
  assert.ok(!/gw-dock-bar|gw-dock-form/.test(uiSource.replace(/\/\*[\s\S]*?\*\//g, '')), '代码里不得再出现 `.gw-dock-bar` / `.gw-dock-form`（只剩历史注释）')

  const shellAt = uiSource.indexOf('className="gw-dock-shell"')
  const clipAt = uiSource.indexOf('className="gw-dock-clip"')
  const rowAt = uiSource.indexOf('className="gw-dock-row"')
  assert.ok(shellAt < clipAt && clipAt < rowAt, '顺序必须是 外壳 → 裁剪盒 → 输入行：输入行要在裁剪盒之外，两个状态都原地不动')
  /*
   * ⚠️ 顺序对了**不代表嵌套对了**。这里补一条真正的配对检查：
   * 只查"外壳在裁剪盒前面、输入行在裁剪盒后面"是不够的——输入行当时确实满足这个顺序，
   * 却是外壳的**兄弟节点**（它替换的是旧 `.gw-dock-bar-clip` 的位置，那本来就是外壳的兄弟），
   * 于是卡片表面（外壳的背景/描边）盖不到它，用户看到的就是"面板透明、输入行单独一个框"。
   */
  assert.ok(
    rowAt < closeIndexOf(uiSource, shellAt),
    '输入行必须在外壳**内部**（只查先后顺序会让"外壳的兄弟节点"蒙混过关，那正是卡片看起来透明的原因）',
  )
  assert.doesNotMatch(uiSource.slice(shellAt, shellAt + 60), /inert=/, '外壳不能 inert：输入行住在它里面，收起态也得能打字')
  assert.match(uiSource.slice(clipAt, clipAt + 130), /inert=\{!open\}/, '收起态必须由裁剪盒 inert 挡住 Tab 与读屏（折叠 ≠ 卸载）')

  // 卡片表面必须挂在外壳上，且输入行自己不许再画一层（两层描边正是"两个东西"的观感来源）
  const shell = /(?:^|\n)\.gw-dock-shell\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  /*
   * ⚠️ 网格**只许有一条轨道**。写成 `0fr auto → 1fr auto` 会让浏览器把两行一起插值：
   * 逐帧实测第二行（输入行）中途被撑到 98.5px 再缩回 55px，输入行因此在动画里上下移动 43px。
   * 输入行必须改为**绝对定位**、由外壳的 `padding-bottom` 给它留位。
   */
  const baseRows = /grid-template-rows:\s*([^;]+);/.exec(shell)?.[1]?.trim() ?? ''
  assert.equal(baseRows, '0fr', `基础态的网格轨道只能有一条（当前 "${baseRows}"）；两条轨道会让输入行一起被插值`)
  assert.match(css, /\.gw-dock-open \.gw-dock-shell\s*\{[^}]*grid-template-rows:\s*1fr\s*;/, '展开态同样只有一条轨道（1fr）')
  assert.match(shell, /position:\s*relative/, '外壳要作为输入行的定位包含块')
  assert.match(shell, /border:\s*1px solid var\(--color-line\)/, '卡片描边在外壳上')
  const row = /(?:^|\n)\.gw-dock-row\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.ok(row.length > 0, '缺少 `.gw-dock-row` 规则')
  assert.match(row, /height:\s*55px/, '55px 必须是两个状态共用的高度（原先两个盒子各写一份，展开瞬间会缩 10px）')
  assert.match(row, /box-sizing:\s*border-box/, '高度要含内边距，否则与旧值不是同一件事')
  assert.ok(!/box-shadow/.test(row), '输入行不得自带投影：表面由外壳提供')
  assert.ok(!/\bborder:\s*1px/.test(row), '输入行不得自带整圈描边（只有展开态那条上分隔线）')
  assert.match(css, /\.gw-dock-open \.gw-dock-row\s*\{[^}]*border-top-color:\s*var\(--color-line\)/, '展开态才显形那条上分隔线')
  assert.match(row, /border-top:\s*1px solid transparent/, '收起态那条上分隔线必须是透明的（否则卡片顶部会悬着一条横线）')
  // 输入行必须钉在卡片底边（它不参与网格插值，见上）
  assert.match(row, /position:\s*absolute/, '输入行必须绝对定位：网格项会随轨道插值而位移')
  assert.match(row, /bottom:\s*0/, '输入行要贴住卡片底边')
  // 外壳必须为它留出与它自身等高的一块空间，否则卡片会矮一截、输入行会压在内容上
  const reserve = /padding-bottom:\s*(\d+)px/.exec(shell)?.[1]
  const rowH = /height:\s*(\d+)px/.exec(row)?.[1]
  assert.ok(reserve !== undefined && rowH !== undefined, '外壳的 padding-bottom 与输入行的高度都必须能解析出来')
  assert.equal(reserve, rowH, `外壳的 padding-bottom（${reserve}px）必须等于输入行高度（${rowH}px）`)
})

/* ============================ ⑦ 减少动效偏好 ============================ */

test('⑦ `prefers-reduced-motion: reduce` 覆盖全部动效选择器', () => {
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(at >= 0, '有过渡却没有"减少动效"守卫')
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  const guard = css.slice(open + 1, close)
  // 这份清单是**枚举**：每个写了 `transition` 的选择器都必须在这里出现（新增动效时同步登记）
  for (const sel of ['.gw-dock', '.gw-dock-shell', '.gw-dock-panel', '.gw-dock-icon', '.gw-dock-tools-chevron']) {
    assert.ok(guard.includes(sel), `${sel} 有过渡，但"减少动效"块里没有它`)
  }
  assert.match(guard, /transition:\s*none/, '"减少动效"块里必须真的把过渡关掉')
})

/* ============================ ⑧ 输入条常驻（"抽搐一下"的判据） ============================ */

test('⑧ 输入行常驻 DOM、两个状态都可交互（原先"收起会抽搐"就是因为它曾随 `{!open && …}` 卸载）', () => {
  assert.ok(
    !/\{!open && \(\s*\n\s*<form/.test(uiSource),
    '输入行又回到 `{!open && <form …>}` 了：卸载会让钉住底边的根盒子瞬间少 55px ⇒ 顶边跳一下（"抽搐"）',
  )
  assert.match(uiSource, /<form\s+className="gw-dock-row"/, '输入行必须常驻（`.gw-dock-row` 一直在 DOM 里）')
  const rowAt = uiSource.indexOf('className="gw-dock-row"')
  assert.doesNotMatch(uiSource.slice(rowAt, rowAt + 140), /inert=/, '输入行在任何状态都不能 inert（收起态恰恰是它最该能打字的时候）')
  const shellAt = uiSource.indexOf('className="gw-dock-shell"')
  assert.doesNotMatch(uiSource.slice(shellAt, shellAt + 60), /inert=/, '外壳不得 inert：输入行住在它里面')
})

/* ============================ ⑨ 展开后焦点交接 ============================ */

test('⑨ ref 挂在唯一的输入行上；展开时的 focus 只为覆盖"不是点它打开的"那几条路径', () => {
  assert.match(uiSource, /const inputRef = useRef<HTMLInputElement \| null>\(null\)/, '缺少输入框 ref')
  const rowAt = uiSource.indexOf('className="gw-dock-row"')
  const refAt = uiSource.indexOf('ref={inputRef}')
  assert.ok(refAt > rowAt, 'ref 必须挂在唯一的输入行（`.gw-dock-row`）里的那个 input 上')
  const at = uiSource.indexOf('inputRef.current?.focus(')
  assert.ok(at >= 0, '展开后没有把焦点放进输入框（用户得再点一下才能输入）')
  /* 切片要盖到 focus 调用**之后**（到 effect 收尾），否则下面那条 preventScroll 断言看不到它 */
  const body = uiSource.slice(uiSource.lastIndexOf('useEffect(', at), uiSource.indexOf('}, [open])', at))
  assert.match(body, /if \(!open\) return/, '抢焦点只能在展开时做：收起时抢会与"点外部收起"打架')
  /*
   * `preventScroll: true` 不是可选项：`.gw-dock-thread` 与 `.gw-dock-clip` 都是 overflow 盒子，
   * 而这类盒子**照样能被 focus 滚动**。真踩过——不带它时浏览器把裁剪盒滚到底（实测 scrollTop≈200），
   * 整段动画露出来的就不是本该揭开的内容，而且每一帧追着焦点重滚，看着就是抖。
   */
  assert.match(body, /focus\(\{ preventScroll: true \}\)/, '聚焦必须 preventScroll：否则 overflow 盒子会被滚到底')
})

/* ============================ ⑩ 几何过渡走 --ease-move ============================ */

test('⑩ 大位移（宽度、揭幕高度）必须走 `--ease-move`；`--ease-standard` 只留给颜色与淡入', () => {
  /*
    2026-09-15 丝滑批：`--ease-standard` 是给 150ms 的颜色/小位移调的（峰值约 2.9× 平均速度、
    25% 的时间就走完 50% 的距离），用在大位移上就是"一冲一顿"。宿主因此新增了 `--ease-move`
    （峰值约 1.6×），由 tokens.css 的 4b 契约块提供（`pluginUi.test.ts` 会校验它真的存在）。
    这条守卫防的是"有人顺手把曲线换回去"——那种回归在单帧截图里看不出来，只有逐帧量速度才认得。
  */
  const dock = /(?:^|\n)\.gw-dock\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(dock, /transition:\s*width\s+\d+ms\s+var\(--ease-move\)/, '`.gw-dock` 的宽度过渡必须走 --ease-move')
  assert.ok(!/transition:\s*width[^\n,]*--ease-standard/.test(dock), '宽度过渡不得用 --ease-standard')
  const shell = /(?:^|\n)\.gw-dock-shell\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(shell, /grid-template-rows\s+\d+ms\s+var\(--ease-move\)/, '揭幕（轨道尺寸）过渡必须走 --ease-move')
  assert.ok(!/grid-template-rows[^\n,]*--ease-standard/.test(shell), '揭幕过渡不得用 --ease-standard（注意别把同一 transition 里 box-shadow 那项也扫进来）')
  assert.match(shell, /box-shadow\s+\d+ms\s+var\(--ease-standard\)/, '投影淡入属于颜色类动效，仍走 --ease-standard')
})

/* ============================ ⑪ 旧机制必须删干净（防回流） ============================ */

test('⑪ 两个输入行时代的补丁必须已删除：`--dock-row-lift` / `.gw-dock-bar` / `.gw-dock-form` 不得回流', () => {
  /*
    这些补丁不是"没用了先留着"的冗余，而是**会重新引入用户报的那个问题**：
    只要还留着"第二个输入行"的钩子（`.gw-dock-form` / `.gw-dock-bar`），
    下一个人很容易把它接回去；`--dock-row-lift` 更是把"两个输入行错位 19px"这个假设写死了。
    注释里提到它们（解释历史）是允许的，所以先剥注释再查。
  */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const dead of ['--dock-row-lift', '.gw-dock-bar', '.gw-dock-form']) {
    assert.ok(!cssCode.includes(dead), `CSS 里不得再出现 ${dead}（旧的两个输入行机制）`)
  }
  const uiCode = uiSource.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const dead of ['gw-dock-bar', 'gw-dock-form']) {
    assert.ok(!uiCode.includes(dead), `界面代码里不得再出现 ${dead}（唯一输入行是 .gw-dock-row）`)
  }
})

test('⑫ 揭幕方向必须"从下往上"：输入行是面板底部，锚在裁剪盒顶部会让它最后才出现（用户实测：下半部分先消失再出现）', () => {
  /*
    2026-09-16 用户反馈："当前 dock 展开时，下半部分会先消失再出现，收起时也是。"

    逐帧实测（页面内 rAF 录制，见 `data/verify/dock-ui/flicker.mjs`）拿到的是：
      · 展开动画第 1~3 帧，**输入行谁都不在**——收起态 `.gw-dock-bar` 已随裁剪盒被裁掉，
        而展开态 `.gw-dock-form` 还在裁剪盒下方（`form=[854,909]` vs `clip=[681,820]`）；
      · 根因是方向：网格行 `0fr → 1fr` 让裁剪盒**顶边先出现**、内容照常锚在顶部，
        于是只有面板上半部分先露出来，而输入行在面板**底部**，要等裁剪盒长到最后才轮到它。

    修法：把内容锚到裁剪盒**底边**（`justify-content: flex-end` + 面板 `flex: none`）。
    这里钉住"锚底"这件事本身：`flex-end` 被删掉就退回"上半部分先出现"，
    而 `flex: none` 漏掉会被 flex 压缩（子项默认 `flex-shrink: 1`），揭幕变成"整块挤扁"。
  */
  /** 取某个选择器的全部规则块（本文件里 ⑪ 也有一份同名局部函数，作用相同） */
  const pick = (sel: string): string => {
    const re = new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'g')
    const parts = [...css.matchAll(re)].map((m) => m[1] as string)
    assert.ok(parts.length > 0, `找不到 ${sel} 的规则块`)
    return parts.join('\n')
  }
  const clip = pick('.gw-dock-clip')
  assert.match(clip, /display:\s*flex/, '裁剪盒要成为 flex 容器才能锚底')
  assert.match(clip, /flex-direction:\s*column/, '纵向排列')
  assert.match(clip, /justify-content:\s*flex-end/, '必须锚到**底边**：这是"输入行从第一帧就在"的前提')
  assert.match(clip, /min-height:\s*0/, '既有约束不能丢（0fr 要能塌到 0）')
  const panelInClip = pick('.gw-dock-clip > .gw-dock-panel')
  assert.match(panelInClip, /flex:\s*none/, '面板不得被 flex 压缩，否则揭幕变成把面板挤扁')
})

/**
 * 从某个开标签的位置出发，配对找到它对应的闭合标签（只数 div / section / form 三种，够用）。
 *
 * 源码级守卫里"谁在谁前面"很好写，但"谁在谁**里面**"才是这次真正的 bug——
 * 输入行曾经是外壳的兄弟节点（顺序上仍然在裁剪盒之后），卡片表面因此盖不到它。
 */
function closeIndexOf(src: string, openIdx: number): number {
  const tagRe = /<(\/?)(div|section|form)\b[^>]*>/g
  /*
   * 起点必须退到开标签的 `<`：调用方给的往往是 `className="…"` 的位置，那已经在标签**内部**，
   * 从那里起扫会漏掉这个标签自己的开括号 ⇒ 深度永远差一（本守卫第一版就这么假红过一次）。
   */
  tagRe.lastIndex = src.lastIndexOf('<', openIdx)
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(src)) !== null) {
    if (m[1] === '/') {
      depth -= 1
      if (depth === 0) return m.index
    } else {
      depth += 1
    }
  }
  return -1
}
