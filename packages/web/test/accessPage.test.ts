/**
 * **旧「权限治理」路由的去处**（`#/access` 与 `#/access/<slug>`）—— 源码级守卫 + 一条 SSR 路由守卫。
 * ============================================================================
 *
 * `pages/AccessPage.tsx` 已经**不再是治理台**：它是一个重定向 / 落地页（文件名与导出名
 * 刻意保留，因为 `#/access/<slug>` 出现在文档、书签与聊天记录里，老链接不能死）。
 * 权限跟着**动作**走 —— 页面档位在阅读页的「权限…」对话框与**编辑页的「权限」区**，
 * 段落档位写在正文的 gated 标记里。
 *
 * 于是本文件守的东西与旧版**不同**了，一共三件事：
 *   ① 重定向目的地对不对（`?access=1`，且在 effect 里跳而不是渲染期跳）；
 *   ② 旧路由首段**仍然被认识**（老链接落到「页面不存在」是最糟的处理方式）；
 *   ③ 它**不再出现在任何导航点**（顶栏、窄屏菜单、命令面板）。
 *
 * 为什么用源码级而不是渲染级：这里要钉的本质上是**声明点**问题（常量声明在哪个数组里、
 * 还有没有渲染路径引用它），而整页跑起来要 React + Radix + 路由 + fetch。仓库既有先例
 * 就是这么做的（`navPlan.test.ts`、`opsPage.test.ts`、`authCacheInvalidation.test.ts`）。
 *
 * ## ⚠️ 先剥注释再断言
 *
 * 与 `opsPage.test.ts` 同款：**"解释为什么不这么做"的注释本身就会含那个字面量** ——
 * 本文件的文件头就是一例（它写着 `governDests`、`LEGACY_ROUTES.map`、`action:access`）。
 * 负向断言若不剥注释，会把自己的说明文字当成违规命中。
 *
 * ## 最后一条是真渲染
 *
 * "`#/access/foo` 渲染的是重定向页而不是「页面不存在」"这件事**只能**由真路由判定来证明：
 * 源码里出现 `...LEGACY_ROUTES` 并不等于 `known` 会对 `access` 求值为真（变量名写错、
 * 漏加数组都会让源码守卫全绿而用户在浏览器里看到 404 页）。故用 `react-dom/server`
 * 渲染整个 `App`（shim 同 `navGate.test.ts`：hash 路由 + 客户端取数 ⇒ SSR 结果完全可预测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/** 剥掉块注释与行注释（见文件头） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function readSrc(...parts: string[]): { raw: string; code: string } {
  const raw = readFileSync(join(SRC, ...parts), 'utf8')
  return { raw, code: codeOnly(raw) }
}

/** 一个正则在源码里出现几次（负向断言用计数，报错时能直接给出"多了几处"） */
function countOf(source: string, pattern: RegExp): number {
  return (source.match(new RegExp(pattern.source, 'g')) ?? []).length
}

/**
 * 从 `at` 起取出一个 `useEffect(() => { … }, [deps])` 的**函数体**。
 *
 * 断言"两件事出现在同一段代码里"必须限定在这段体内：整文件级的 `includes` 等于没断言 ——
 * 两个判据分别在别处出现也会让它变绿，而它们是否真的在**同一个 effect** 里才是要守的东西。
 */
function effectBodyAfter(code: string, at: number, span = 500): string {
  return code.slice(at, at + span).split(/\n\s*\}, \[/)[0] ?? ''
}

const accessPage = readSrc('pages', 'AccessPage.tsx')
const panel = readSrc('components', 'access', 'PageAccessPanel.tsx')
const wiki = readSrc('pages', 'WikiPage.tsx')
const app = readSrc('App.tsx')
const palette = readSrc('components', 'CommandPalette.tsx')
const plan = readSrc('lib', 'accessPlan.ts')
const wikiRoute = readSrc('lib', 'wikiRoute.ts')

/* ------------------------------ 反空洞 ------------------------------ */

test('反空洞：剥注释后各文件仍能看到关键声明（防路径写错导致 0===0）', () => {
  assert.ok(accessPage.code.length > 1000, `AccessPage.tsx 读入异常（${accessPage.code.length} 字符）`)
  assert.ok(accessPage.code.includes('export function AccessPage'), '应能看到 AccessPage 定义')
  assert.ok(panel.code.includes('export function PageAccessPanel'), '应能看到 PageAccessPanel 定义')
  assert.ok(wiki.code.length > 5000, `WikiPage.tsx 读入异常（${wiki.code.length} 字符）`)
  assert.ok(app.code.includes('export function App'), '应能看到 App 定义')
  assert.ok(palette.code.includes("id: 'action:theme'"), '应能看到命令面板的动作清单')
})

/* --------------------------- 设计 token --------------------------- */

test('新界面只用已注册 token：不得出现 muted-foreground / border-border', () => {
  /*
   * `text-muted-foreground` / `border-border` 是 shadcn 默认主题的名字，**本仓库没有注册**
   * （见 `src/styles/tokens.css`：本仓用 `text-muted` / `text-ink-soft` / `border-line`）。
   * 写错的症状是"这些类被静默忽略"—— 文字照常显示成继承色、边框直接没有，
   * 在浅色主题下几乎看不出来，深色主题下才变成一片糊。
   *
   * 覆盖范围：`access/` 下的**全部**组件（重定向页 + 阅读页/编辑页共用的治理面板）。
   * 全仓另有一条更宽的守卫（见 `designSystem.test.ts`），这里保留一份更窄的清单**不是冗余**：
   * 权限界面是"说错就是安全事故"的地方，它的守卫不该因为将来有人给全仓扫描加例外名单而失效。
   */
  const files: Array<[string, string]> = [
    ['pages/AccessPage.tsx', accessPage.code],
    ['components/access/PageAccessPanel.tsx', panel.code],
  ]
  // 其余 access 组件一并纳入（它们与本文件同属一批）
  for (const name of readdirSync(join(SRC, 'components', 'access'))) {
    if (!name.endsWith('.tsx')) continue
    files.push([`components/access/${name}`, codeOnly(readFileSync(join(SRC, 'components', 'access', name), 'utf8'))])
  }
  files.push(['lib/accessPlan.ts', plan.code])

  assert.ok(files.length >= 5, `应至少扫到 5 个治理文件（实际 ${files.length}）`)
  const hits: string[] = []
  for (const [name, src] of files) {
    if (src.includes('muted-foreground')) hits.push(`${name}: text-muted-foreground（应改用 text-muted / text-ink-soft）`)
    if (/[\s"'`]border-border/.test(src)) hits.push(`${name}: border-border（应改用 border-line）`)
  }
  assert.deepEqual(hits, [], `发现未注册 token 的用法：\n  ${hits.join('\n  ')}`)
})

/* --------------------- AccessPage：重定向页（不再是治理台） --------------------- */

test('AccessPage：不再有手动 slug 表单（旧治理台的输入框已整段删除）', () => {
  /*
   * 旧页有一个"输入 slug 去治理"的表单：`isValidSlug` 校验 + `SLUG_HINT` 提示 + `<Input>`。
   * 它随治理台一起删掉了 —— 留在原地会让人以为"要管权限还得先在这里找页面"，
   * 而真正的入口是页面自己的「权限…」与编辑页的「权限」区。
   */
  assert.doesNotMatch(accessPage.code, /isValidSlug/, '旧治理台的 slug 校验应已删除')
  assert.doesNotMatch(accessPage.code, /SLUG_HINT/, '旧治理台的 slug 提示常量应已删除')
  assert.doesNotMatch(accessPage.code, /<Input/, '本页不该再有任何输入框')
  assert.doesNotMatch(
    accessPage.code,
    /PageAccessPanel/,
    '重定向页不得自己嵌治理面板：落点是**页面自己**的「权限…」对话框，两份实现必然漂移',
  )
  // 反空洞：文件当然仍在渲染 Button —— 否则上面四条"没有 X"可能只是因为读错了文件
  assert.match(accessPage.code, /<Button/, '反空洞：本页应仍渲染 Button（手动跳转出口）')
})

test('AccessPage：带 slug 时重定向到「页面 + ?access=1」，且跳转发生在 useEffect 体内', () => {
  const at = accessPage.code.indexOf('useEffect(')
  assert.ok(
    at > 0,
    '带 slug 的分支必须用 useEffect 做跳转：渲染期改路由会在提交过程中再次 setState（React 会报 "Cannot update a component while rendering a different component"），而且"正在打开…"那行可见文案根本没机会出现 —— 用户只看到一闪',
  )
  assert.doesNotMatch(
    accessPage.code.slice(0, at),
    /onNavigate\(/,
    'onNavigate 不得出现在第一个 useEffect 之前 —— 那是组件体（渲染期）',
  )

  const body = effectBodyAfter(accessPage.code, at)
  assert.ok(
    body.length > 30 && body.includes('onNavigate('),
    `反空洞：应能取出 effect 体并看到跳转（实际 ${body.length} 字符）`,
  )
  assert.match(body, /onNavigate\(/, '跳转必须发生在 effect 体内')
  assert.match(body, /\?access=1/, '目的地必须带 ?access=1 —— 阅读页的 WikiDetail 靠它打开「权限…」对话框')
  assert.match(
    body,
    /encodeURIComponent\(slug\)/,
    '分层 slug（含 `/`）必须先编码再拼进 hash，否则 `/` 会被当成路由分隔符、跳到别的页面',
  )
  assert.match(body, /if \(slug === null\) return/, '无 slug（`#/access`）时不得跳转 —— 那是"说明搬去哪了"的分支')
})

test('AccessPage：无 slug（#/access）时说明「已并入页面」，并给出去知识库列表的出口', () => {
  assert.match(accessPage.code, /已并入页面/, '文案必须说明权限设置已并入页面本身')
  assert.match(accessPage.code, /不再是一个独立的治理台/, '首页态要直说这一页不再是治理台（并给出理由）')
  assert.match(
    accessPage.code,
    /onNavigate\('wiki'\)/,
    '首页态必须给一个明确去处（去知识库列表挑页面）—— 只解释不给去处等于死胡同',
  )
  assert.match(accessPage.code, /去知识库挑一个页面/, '出口按钮的文案要写清是去挑页面，而不是笼统的「返回」')

  const earlyReturn = accessPage.code.indexOf('if (slug !== null)')
  assert.ok(earlyReturn > 0, '带 slug 的分支应当是**早返回**')
  assert.ok(
    accessPage.code.indexOf('不再是一个独立的治理台') > earlyReturn,
    '首页态的文案必须排在带 slug 的早返回**之后**（排在前面的话那条分支永远不可达）',
  )
})

/* --------------------- App：旧路由仍被认识、但不再被渲染 --------------------- */

test('App：旧路由常量仍存在、仍含 id: access，且声明在 ADMIN_NAV 数组体之外', () => {
  /*
   * `navPlan.test.ts` 从 `App.tsx` 抽取 `ADMIN_NAV` 的数组体，并断言
   * "条目数 == requires: 'administer' 的次数"。旧路由要的是**另一个能力**
   * （`manageVisibility`，普通成员也有），一旦被那段正则吞进去，两个计数就都不对了。
   */
  const adminBlock = /const ADMIN_NAV: NavItem\[\] = \[([\s\S]*?)\n\]/.exec(app.code)?.[1] ?? ''
  assert.ok(adminBlock.length > 40, '反空洞：ADMIN_NAV 数组体应能抽出')

  const legacyBlock = /const LEGACY_ROUTES: NavItem\[\] = \[([\s\S]*?)\n\]/.exec(app.code)?.[1] ?? ''
  assert.ok(legacyBlock.length > 30, `应能抽取出 LEGACY_ROUTES 的数组体（实际 ${legacyBlock.length} 字符）`)
  assert.match(legacyBlock, /id: 'access'/, '旧路由的首段必须仍是 `access` —— 老链接靠它被认识')

  assert.doesNotMatch(adminBlock, /LEGACY_ROUTES|id: 'access'/, 'LEGACY_ROUTES 必须声明在 ADMIN_NAV 之外')
  // 两段切片必须真的不同来源（正则写坏时最容易出现"两侧取到同一段"而静默通过）
  assert.notEqual(adminBlock, legacyBlock, '反空洞：ADMIN_NAV 与 LEGACY_ROUTES 不应抽到同一段源码')

  const adminEnd = app.code.indexOf('\n]', app.code.indexOf('const ADMIN_NAV'))
  assert.ok(
    app.code.indexOf('const LEGACY_ROUTES') > adminEnd,
    '常量声明必须落在 ADMIN_NAV 的 `]` 之外（否则 navPlan 的计数正则会把它的条目吞进去）',
  )
})

test('App：known 判定含旧路由数组，且 access 仍有独立分派（否则 #/access 会落到「页面不存在」）', () => {
  const at = app.code.indexOf('const known')
  assert.ok(at > 0, '应能找到 known 判定')
  // 取判定表达式所在的整段（它跨两行：`const known =` 换行后才是表达式）
  const known = app.code.slice(at, at + 300).split('\n\n')[0] ?? ''
  assert.ok(
    known.includes('...LEGACY_ROUTES'),
    `known 判定必须含 ...LEGACY_ROUTES（实际：${known.trim().slice(0, 160)}）`,
  )
  assert.match(app.code, /import \{ AccessPage \} from '\.\/pages\/AccessPage'/, 'AccessPage 必须仍被 import')
  assert.match(app.code, /active === 'access'\)/, '必须有 access 路由分派')
  assert.match(app.code, /<AccessPage sub=/, '分派必须真的渲染 AccessPage，并把它后面的子路径交进去')
})

test('App：旧路由不出现在任何导航点（顶栏标签与窄屏菜单都没有它的渲染路径）', () => {
  /*
   * 这是"那个没用的入口确实下线了"的**真正**回归守卫：源码里出现 `...LEGACY_ROUTES`
   * 只说明路由**认识**它，不说明它没被渲染。旧实现在顶栏用 `governDests.map(...)` 铺一排
   * 与「知识库」平级的标签、又在窄屏菜单里另写一段下拉项 —— 两处都只能靠"这些东西不存在"
   * 来守住（"看得见但点进去没用"正是本次要消灭的形态）。
   */
  assert.doesNotMatch(app.code, /governDests/, '旧的 governDests 过滤结果应已整体删除')
  assert.doesNotMatch(app.code, /LEGACY_ROUTES\.map|LEGACY_ROUTES\.filter/, '旧路由不得被 map/filter 成导航项')
  assert.doesNotMatch(
    app.code,
    /visibleDests\(LEGACY_ROUTES/,
    '旧路由不得再过 visibleDests —— 一旦过了，说明它又参与渲染了',
  )
  assert.equal(
    countOf(app.code, /LEGACY_ROUTES/),
    2,
    '对 LEGACY_ROUTES 的引用只应有 2 处：声明处 + known 判定（多一处就说明有人把它接回了渲染路径）',
  )
})

test('命令面板：不再提供指向旧治理路由的动作（⌘K 里也搜不到那一页）', () => {
  /*
   * 命令面板是继顶栏、窄屏菜单之后的**第三条**入口（`navPlan.test.ts` 已经点明这条纪律：
   * "只藏顶栏而漏了这里，用户按 ⌘K 仍能搜到并跳进去 —— 那正是'藏了个寂寞'"）。
   * 旧治理台现在只会把人重定向走，把它留在动作清单里就是让人白跑一趟。
   *
   * 若这条变红：`CommandPalette.tsx` 里仍留着旧的 `action:access` 条目
   * （label 是「权限治理」、run 是 `go('access')`），删掉那一项即可。
   */
  // 反空洞：先证明动作清单确实读进来了（否则路径写错时下面三条会全绿）
  assert.match(palette.code, /id: 'action:theme'/, '反空洞：命令面板的动作清单应能读到')
  assert.doesNotMatch(palette.code, /action:access/, "⌘K 里不应再有 action:access 这一项")
  assert.doesNotMatch(palette.code, /go\('access'\)/, '不应再有任何把用户送到 #/access 的动作')
  assert.doesNotMatch(palette.code, /权限治理/, '「权限治理」不得再作为命令面板的条目文案出现')
})

/* --------------------- WikiPage：阅读页的 ?access=1 落点 --------------------- */

test('WikiPage（阅读页）：?access=1 打开「权限…」对话框，且判据是 canManageVisibility 而不是 canEdit', () => {
  const declAt = wiki.code.indexOf('const wantAccess')
  assert.ok(declAt > 0, '阅读页必须有 wantAccess 判定 —— 它是 `#/access/<slug>` 的落点')
  const decl = wiki.code.slice(declAt, declAt + 300)
  assert.match(decl, /get\('access'\) === '1'/, "wantAccess 必须判 `get('access') === '1'`（重定向写的就是 ?access=1）")
  assert.match(decl, /query/, '判据必须来自本页接收的查询串 prop，而不是渲染期直接读 window.location')

  const effectAt = wiki.code.indexOf('useEffect(', declAt)
  assert.ok(effectAt > declAt, 'wantAccess 判定之后必须紧跟打开对话框的 effect')
  const body = effectBodyAfter(wiki.code, effectAt)
  assert.ok(
    body.length > 30 && body.includes('setAccessOpen(true)'),
    `反空洞：应能取出该 effect 体并看到开启动作的（实际 ${body.length} 字符）`,
  )
  assert.match(body, /wantAccess/, 'effect 的判据必须直接来自上面那个 wantAccess（两处各判一次迟早分叉）')
  assert.match(
    body,
    /canManageVisibility/,
    '必须检查 canManageVisibility：无权时不自动弹 —— 弹出来只会是一张"没有可见性管理权"的卡片，不如让用户正常阅读',
  )
  assert.doesNotMatch(body, /canEdit/, '不得用 canEdit 当判据：能编辑 ≠ 能改"谁能看"')
  assert.match(body, /setAccessOpen\(true\)/, 'effect 必须真的打开对话框')
})

test('WikiPage（阅读页）：权限按钮落在 canManageVisibility 门控之内（不是 canEdit，也不是无条件）', () => {
  const gate = 'page.capabilities.canManageVisibility &&'
  const at = wiki.code.indexOf(gate)
  assert.ok(at >= 0, '详情页必须有 `page.capabilities.canManageVisibility &&` 门控')
  assert.equal(wiki.code.indexOf(gate, at + 1), -1, '门控只应出现一次（否则两处判据会分叉）')

  // 取到**下一个**能力门控为止 = 这个按钮所在的受控块（比"固定切 500 字符"稳：注释增删不会让它漂）
  const end = wiki.code.indexOf('page.capabilities.canDelete', at)
  assert.ok(end > at, '反空洞：门控块应有明确的结束边界')
  const block = wiki.code.slice(at, end)
  assert.match(block, /权限/, '门控内应有「权限」按钮')
  // ★ 按钮文案**不带省略号**（作者要求）：`权限…` 读起来像"还有没显示出来的东西"
  assert.doesNotMatch(block, /权限…/, '按钮文案是「权限」，不带省略号')
  assert.match(block, /setAccessOpen\(true\)/, '按钮必须真的打开治理面板')
  assert.doesNotMatch(block, /canEdit/, '权限入口不得挂在 canEdit 上（能编辑 ≠ 能改谁能看）')
})

test('WikiPage：权限面板只有**一处**调用（阅读页对话框），编辑页不再有权限区', () => {
  assert.match(wiki.code, /import \{ PageAccessPanel \} from '\.\.\/components\/access\/PageAccessPanel'/)
  assert.match(
    wiki.code,
    /<PageAccessPanel slug=/,
    '面板必须复用 —— 另写一份必然漂移，而漂移的后果是权限被改错',
  )
  // 阅读页：面板必须随弹窗关闭而卸载（否则会拿旧档位回填）
  assert.match(wiki.code, /\{accessOpen && <PageAccessPanel/, '阅读页面板应受 accessOpen 控制挂载')
  /*
   * ★ 编辑页**不再**嵌权限面板（作者要求：编辑页底部的权限区去掉）。
   * 这条断言是防回潮的：多一处 `<PageAccessPanel` 就说明又有人在编辑页/别处塞了一份，
   * 而两份可编辑档位控件各有本地状态，"只发改动过的字段"的部分更新会拿旧基线发反向 patch。
   */
  assert.equal(
    countOf(wiki.code, /<PageAccessPanel/),
    1,
    '权限面板只应在阅读页的对话框里渲染一次（编辑页的权限区已按作者要求移除）',
  )
  // 页面档位控件（VisibilitySection）在 WikiPage 里也不再出现：它只属于 PageAccessPanel
  assert.doesNotMatch(wiki.code, /<VisibilitySection/, '编辑页不再就地渲染档位控件')
  assert.doesNotMatch(wiki.code, /VisibilitySection/, 'WikiPage 不得再引用 VisibilitySection（避免第二个可编辑档位实例）')
})

test('WikiPage（编辑页）：**没有**权限区，但编辑器仍拿到 blockTiers', () => {
  /*
   * ★ 作者要求：编辑页底部的「权限」区**去掉**（页面档位属于"这条目对谁可见"的治理动作，
   * 入口在页面自己的「权限」对话框里，那里同时有例外授予与访问申请，是**一处完整**的界面）。
   *
   * 这条守卫因此是**反向**的：编辑页不得再出现权限区（否则同一屏又会有第二个可编辑档位控件）。
   * 同时保住真正该留的东西 —— 段落级权限的判据（编辑器要拿到页面档位才知道这一段能收紧到什么程度）。
   */
  const importAt = wiki.code.indexOf("from '../lib/domIds'")
  assert.ok(importAt > 0, 'WikiPage 必须从 lib/domIds 取共享 id')
  const importStmt = wiki.code.slice(Math.max(0, wiki.code.lastIndexOf('import', importAt)), importAt)
  for (const ident of ['EDITOR_PANE_LABEL_ID', 'PREVIEW_PANE_LABEL_ID']) {
    assert.ok(importStmt.includes(ident), `lib/domIds 的 import 必须含 ${ident}（否则标注会指空）`)
  }
  assert.doesNotMatch(wiki.code, /PERMISSION_SECTION_LABEL_ID/, '编辑页权限区的标注 id 已随该区一起移除')

  // 段落级权限：编辑器要拿到页面档位才有"这一段能收紧到什么程度"的判据
  const editorAt = wiki.code.indexOf('<MarkdownEditorLazy')
  assert.ok(editorAt > 0, '编辑页应有 MarkdownEditorLazy')
  const editorEnd = wiki.code.indexOf('/>', editorAt)
  assert.ok(editorEnd > editorAt, '反空洞：应能取出 MarkdownEditorLazy 的开标签')
  const editorTag = wiki.code.slice(editorAt, editorEnd)
  assert.ok(editorTag.length > 100, `反空洞：开标签切片异常（${editorTag.length} 字符）`)
  assert.match(editorTag, /blockTiers=\{/, 'MarkdownEditorLazy 必须收到 blockTiers（每段权限菜单的判据）')
  assert.match(
    editorTag,
    /pageVisibility/,
    'blockTiers 里必须带页面档位 —— 段落档位不能比页面更宽，没有它就无法给出合法选项',
  )
})

/* --------------------------- 面板内部：无能力时不渲染 --------------------------- */

test('审批区：无可见性管理权时**整块面板**不渲染（不是显示禁用按钮）', () => {
  const gateAt = panel.code.indexOf('if (!page.capabilities.canManageVisibility)')
  const reqAt = panel.code.indexOf('<RequestsSection')
  assert.ok(gateAt > 0, '必须有 canManageVisibility 的早返回')
  assert.ok(reqAt > gateAt, '审批区必须排在该早返回之后 —— 无权时它根本不该挂载')
  assert.doesNotMatch(
    panel.code.slice(0, gateAt),
    /<RequestsSection|<GrantsSection|<VisibilitySection/,
    '早返回之前不得渲染任何治理区块',
  )
  /*
   * ★ 块级分区（`BlocksSection`）已按作者要求从面板移除：段落档位就是正文里的标记，
   * 改它在**编辑器**里（工具栏锁按钮），不在这里。代码与端点保留，故只断言"面板不渲染它"。
   */
  assert.doesNotMatch(panel.code, /<BlocksSection/, '权限面板不再渲染块级分区（块档位在编辑器里改）')
})

test('审批区：`request_not_pending` 走"重新取一次列表"，拒绝前有确认', () => {
  const req = codeOnly(readFileSync(join(SRC, 'components', 'access', 'RequestsSection.tsx'), 'utf8'))
  assert.match(req, /request_not_pending/, '必须识别该冲突码（未知码会走通用错误提示，用户不知道要刷新）')
  // 识别之后要真的重新取数，而不是只弹一句错误
  assert.match(req, /code === 'request_not_pending' \|\| code === 'not_found'/, '该码要与 not_found 一起处置（屏幕上的列表过期了）')
  // 拒绝要确认，且确认文案说明"仍可再次提交"
  assert.match(req, /拒绝后申请人仍可再次提交申请。确定拒绝？/, '拒绝前必须确认，且说清后果')
})

test('申请对话框：附言输入有可访问名称，且带 n/500 计数', () => {
  const apply = codeOnly(readFileSync(join(SRC, 'components', 'access', 'ApplyAccessDialog.tsx'), 'utf8'))
  assert.match(apply, /htmlFor="apply-message"/, '附言输入必须与 <label> 配对（否则读屏只听到"编辑框"）')
  assert.match(apply, /maxLength=\{REQUEST_MESSAGE_MAX\}/, '必须按共享常量限制长度（前后端各写一个数字必然漂移）')
  assert.match(apply, /\{message\.length\}\/\{REQUEST_MESSAGE_MAX\}/, '必须有 n/500 计数：用户要知道还能写多少')
})

/* ------------------------------ 真渲染：路由落点 ------------------------------ */

/*
 * 为什么必须有这一段（而不是只留源码守卫）：源码里出现 `...LEGACY_ROUTES` 并不等于
 * `known` 会对 `access` 求值为真 —— 变量名写错、漏加数组都会让源码守卫全绿，
 * 而用户在浏览器里看到的是「页面不存在」。只有真渲染才能证明它命中的是重定向页。
 *
 * shim 与 `navGate.test.ts` 同款（hash 路由 + 客户端取数 ⇒ SSR 结果完全可预测），
 * 且**必须在 import App 之前**装好：App 的模块图在加载期会碰 window/document。
 */
const ssrBacking: Record<string, string> = {}
;(globalThis as unknown as { window: unknown }).window = {
  location: { hash: '', pathname: '/', search: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: {
    getItem: (k: string) => ssrBacking[k] ?? null,
    setItem: (k: string, v: string) => {
      ssrBacking[k] = v
    },
    removeItem: (k: string) => {
      delete ssrBacking[k]
    },
  },
}
;(globalThis as unknown as { document: unknown }).document = {
  documentElement: { classList: { add: () => {}, remove: () => {} }, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  activeElement: null,
  title: '',
}
;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  new Response(JSON.stringify({ ok: false, error: 'unauthorized', message: '需要登录' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })

const { renderToStaticMarkup } = await import('react-dom/server')
const React = await import('react')
const { App } = await import('../src/App')

function renderAt(hash: string): string {
  ;(globalThis as unknown as { window: { location: { hash: string } } }).window.location.hash = hash
  return renderToStaticMarkup(React.createElement(App))
}

test('SSR：`#/access/foo` 命中重定向页（不是「页面不存在」兜底页）', () => {
  const html = renderAt('#/access/foo')
  assert.ok(
    !html.includes('页面不存在'),
    '旧治理深链不得落到兜底页 —— 用户会以为**页面**没了（这正是保留该路由的原因）',
  )
  assert.ok(html.includes('正在打开这一页的权限设置'), '必须渲染「正在打开这一页的权限设置…」的过渡态')
  assert.ok(html.includes('权限设置已并入页面本身'), '必须说明权限设置已并入页面本身')
  assert.ok(html.includes('打开 foo 的权限设置'), '必须给出不依赖自动跳转的手动出口（按钮文案带上 slug）')
  // 旧治理台首页态的那句"正在确认你的权限…"必须已经消失
  assert.ok(!html.includes('正在确认你的权限'), '旧的「正在确认你的权限」首页态已随治理台删除')
})

test('SSR：`#/access`（无 slug）是说明页 —— 不渲染「正在打开…」', () => {
  const home = renderAt('#/access')
  assert.ok(!home.includes('页面不存在'), '`#/access` 仍是被认识的路由首段')
  assert.ok(home.includes('权限设置已并入页面本身'), '`#/access` 应说明权限设置已并入页面本身')
  assert.ok(!home.includes('正在打开这一页的权限设置'), '`#/access` 不应渲染「正在打开…」—— 没有 slug，没有落点')
})

/* --------------------------- 路由解码复用 --------------------------- */

