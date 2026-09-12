/**
 * **写入口门控**（R11 判据 + 本批 G1 补齐的侧栏与编辑路由）—— 运行时单测 + 声明点守卫。
 * ============================================================================
 *
 * ## 缺陷形态（真实浏览器取证）
 *
 * 匿名访客在 `#/wiki/list` 上看到可点亮的「新建页面」→ 点进去拿到**完整编辑器** →
 * 填完一屏 → 保存才 401。「侧栏空态的按钮」与「`#/wiki/<slug>/edit` 直达」是同一缺陷的
 * 另两条路径：前者压根没门控，后者给了匿名一条"白填一次"的路。服务端拒绝得没错
 * （**不越权**），但把人引进死路是纯浪费。
 *
 * ## 为什么两段都要
 *
 * 1. **运行时**：三态判据是纯函数（`newPageEntry`），直接测它 —— 光有源码守卫的话，
 *    判据写反（例如把 `editContent` 写成 `administer`）仍然会绿。
 * 2. **声明点**：判据写对了但**某个渲染点没用它**，只有源码级断言能钉住
 *    （侧栏那处就是这么漏的）。两条渲染路径（`#/wiki/new`、`#/wiki/<slug>/edit`）
 *    必须都落在 `kind !== 'ready'` 的早返回之后，且**不得**各写一份判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { newPageEntry } from '../src/lib/newPageGate'
import type { AuthCapabilities, AuthUser } from '../src/api'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/** 剥掉块注释与行注释（注释里会引用被禁的写法，会让负向断言假阳性） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const gate = codeOnly(readFileSync(join(SRC, 'lib', 'newPageGate.tsx'), 'utf8'))
const wiki = codeOnly(readFileSync(join(SRC, 'pages', 'WikiPage.tsx'), 'utf8'))
const sidebar = codeOnly(readFileSync(join(SRC, 'components', 'Sidebar.tsx'), 'utf8'))

const USER = { id: 7, orgRole: 'member' } as unknown as AuthUser
const CAN_EDIT = { editContent: true, administer: false, manageVisibility: false } as AuthCapabilities
const CANNOT_EDIT = { editContent: false, administer: false, manageVisibility: false } as AuthCapabilities

/* ------------------------------ 反空洞 ------------------------------ */

test('反空洞：三个文件都读进来了，且关键声明都在（防路径写错导致断言恒真）', () => {
  assert.ok(gate.length > 800, `newPageGate.tsx 读入异常（仅 ${gate.length} 字符），路径可能不对`)
  assert.ok(wiki.length > 5000, `WikiPage.tsx 读入异常（仅 ${wiki.length} 字符），路径可能不对`)
  assert.ok(sidebar.length > 800, `Sidebar.tsx 读入异常（仅 ${sidebar.length} 字符），路径可能不对`)
  assert.match(gate, /export function newPageEntry\(/, '判据必须由 newPageGate 导出')
  assert.match(gate, /export function NewPageAction\(/, '按钮实现必须由 newPageGate 导出')
})

/* --------------------------- 一、三态判据（运行时） --------------------------- */

test('判据：匿名 ⇒ login（可点，去登录后能回来），而不是禁用', () => {
  assert.deepEqual(newPageEntry(null, CAN_EDIT), { kind: 'login' })
  // 能力还没确认时也按匿名处理：匿名没有"正在确认"，直接给可走的路
  assert.deepEqual(newPageEntry(null, null), { kind: 'login' })
})

test('判据：能力未确认 ⇒ blocked 且原因可见（失败关闭，不给点了必然 401 的按钮）', () => {
  const e = newPageEntry(USER, null)
  assert.equal(e.kind, 'blocked')
  if (e.kind === 'blocked') assert.match(e.reason, /正在确认/, '原因必须说清"还没确认完"')
})

test('判据：有会话但无 editContent ⇒ blocked；判据是 editContent 而不是 administer', () => {
  const e = newPageEntry(USER, CANNOT_EDIT)
  assert.equal(e.kind, 'blocked')
  if (e.kind === 'blocked') assert.match(e.reason, /权限/, '原因必须给出来（不能只挂 title）')
  // ★ 反例：只有 administer 的人（owner/admin）**照旧**能编辑 —— 判据不是运维能力
  const adminOnly = { editContent: true, administer: true, manageVisibility: true } as AuthCapabilities
  assert.deepEqual(newPageEntry(USER, adminOnly), { kind: 'ready' })
})

test('判据：新建与编辑**共用同一个判定**，只有原因文案里的动作名不同', () => {
  assert.deepEqual(newPageEntry(USER, CAN_EDIT, 'edit'), { kind: 'ready' })
  assert.deepEqual(newPageEntry(USER, CAN_EDIT, 'new'), { kind: 'ready' })
  assert.equal(newPageEntry(USER, CANNOT_EDIT).kind, newPageEntry(USER, CANNOT_EDIT, 'edit').kind)
  const asEdit = newPageEntry(USER, CANNOT_EDIT, 'edit')
  if (asEdit.kind === 'blocked') {
    assert.match(asEdit.reason, /编辑页面/, '编辑入口的原因必须说"编辑"，不能照抄"新建"')
  }
  const asNew = newPageEntry(USER, CANNOT_EDIT, 'new')
  if (asNew.kind === 'blocked') assert.match(asNew.reason, /新建页面/)
})

/* --------------------- 二、登录回跳：编码与站内校验 --------------------- */

test('回跳：编辑页的 redirect 带编码后的 slug（分层 slug 不得被拆成多一段）', () => {
  // 只断言"构造规则"（该函数会写 window.location，故不在单测里调用）：见 loginForEditPage
  assert.match(gate, /`\/wiki\/\$\{encodeURIComponent\(slug\)\}\/edit`/, '编辑页回跳必须对 slug 做 encodeURIComponent')
  assert.match(gate, /`\/login\?redirect=\$\{encodeURIComponent\(hashPath\)\}`/, '回跳地址必须整体编码进 redirect 参数')
  // 站内路径（normalizeRedirect 的判据是"以 / 开头且不以 // 开头"）
  assert.match(gate, /loginForWikiPath\('\/wiki\/new'\)/, '新建页回跳仍是 /wiki/new')
})

/* ------------------------ 三、声明点：侧栏空态（G1） ------------------------ */

test('侧栏空态：按钮走共享实现，且登录态在任何 early return 之前取（React #310）', () => {
  assert.match(
    sidebar,
    /<NewPageAction[^>]*entry=\{newEntry\}[^>]*onNew=\{\(\) => props\.onNavigate\('new'\)\}/,
    '空态必须复用 NewPageAction（共享门控），而不是自己写一个 Button',
  )
  assert.match(sidebar, /newPageEntry\(auth\.user, auth\.capabilities\)/, '判据必须来自 newPageGate')
  assert.match(sidebar, /const auth = useAuth\(\)/, '侧栏自己要取登录态（它不接收 auth props）')

  // 负向：不得再出现"裸按钮直接跳新建"（这正是本批修掉的写法）
  assert.doesNotMatch(
    sidebar,
    /<Button[^>]{0,300}onNavigate\('new'\)/,
    '侧栏空态不得再有无门控的「新建页面」按钮（匿名点进去会白填一屏）',
  )

  // hook 顺序：`useAuth()` 必须在第一个 early return 之前
  const authAt = sidebar.indexOf('const auth = useAuth()')
  const firstReturn = sidebar.indexOf('if (error !== null)')
  assert.ok(authAt > 0, '应能定位 useAuth()')
  assert.ok(firstReturn > 0, '应能定位第一个 early return')
  assert.ok(authAt < firstReturn, 'useAuth() 必须在 early return 之前（否则 React #310）')
})

/* ---------------------- 四、声明点：两条编辑器渲染路径 ---------------------- */

test('路由兜底：两条编辑器路径之前都必须有 kind !== \'ready\' 的早返回', () => {
  const gates = [...wiki.matchAll(/kind !== 'ready'/g)].map((m) => m.index ?? -1)
  const editors = [...wiki.matchAll(/<WikiEdit/g)].map((m) => m.index ?? -1)
  // 反空洞：三条路径都必须抽到，否则下面的循环会空转
  assert.ok(gates.length >= 3, `应有 ≥3 处写入门控（实际 ${gates.length}）`)
  /*
   * 三条编辑器渲染路径（新增第三条时**必须**同时补门控，本断言就是提醒）：
   *   1. `#/wiki/new`            —— `slug=""` + 空 slug 分支的门控
   *   2. `#/wiki/<slug>/edit`    —— `slug={route.slug}` + 编辑分支的门控
   *   3. `#/wiki/home/new`       —— 主页创建引导（`prefillSlug={HOME_SLUG}`）+ 主页门控
   * 第三条是本轮主页重设计引入的：它是**真实可达的 URL**（主页缺失时页面上的按钮就指向它），
   * 因此与另外两条同罪——没有门控，匿名/无编辑权的人会拿到完整可用的编辑器。
   */
  assert.equal(
    editors.length,
    3,
    `应有三条编辑器渲染路径（#/wiki/new、#/wiki/<slug>/edit、#/wiki/home/new，实际 ${editors.length}）`,
  )
  // 三条路径各自的特征必须都还在（否则"三条"可能来自同一处的复制粘贴）
  assert.match(wiki, /prefillSlug=\{HOME_SLUG\}/, '主页创建路径必须以 prefillSlug 预填约定 slug')

  for (const at of editors) {
    const before = wiki.slice(Math.max(0, at - 3000), at)
    const lastGate = before.lastIndexOf("kind !== 'ready'")
    assert.ok(
      lastGate >= 0,
      `编辑器渲染点（偏移 ${at}）之前 3000 字符内没有 kind !== 'ready' 门控 —— 匿名直达会拿到完整编辑器，` +
        `上下文：${wiki.slice(Math.max(0, at - 80), at + 40)}`,
    )
    // 门控必须真的 return（否则只是算了个布尔值，编辑器照样渲染）
    assert.match(before.slice(lastGate), /return \(/, "门控必须 return 一个说明页，而不是只算个布尔值")
  }

  // 编辑路由的判据必须与新建**同一来源**（带 'edit' 参数），而不是自己写一套 editContent 判断
  assert.match(
    wiki,
    /newPageEntry\(auth\.user, auth\.capabilities, 'edit'\)/,
    '编辑路由必须复用 newPageEntry(…, \'edit\')',
  )
  assert.match(wiki, /import \{[^}]*newPageEntry[^}]*\} from '\.\.\/lib\/newPageGate'/, '判据只能来自 newPageGate')
})

test('判据只定义一处：WikiPage / Sidebar 不得自己复制一份', () => {
  assert.doesNotMatch(wiki, /function newPageEntry\(/, 'WikiPage 不得再定义一份判据（漂移的来源）')
  assert.doesNotMatch(wiki, /function NewPageAction\(/, 'WikiPage 不得再定义一份按钮实现')
  assert.doesNotMatch(sidebar, /function newPageEntry\(/, 'Sidebar 不得自己写判据')
  // 模块内部也只有一份
  assert.equal(gate.match(/export function newPageEntry\(/g)?.length, 1, 'newPageEntry 只应导出一次')
})

test('编辑页门控的下一步：匿名给"去登录"（带回跳），两种情况都给"返回页面"', () => {
  const at = wiki.indexOf("newPageEntry(auth.user, auth.capabilities, 'edit')")
  assert.ok(at > 0, '应能定位编辑路由的门控')
  /*
   * 切到**下一个 `<WikiEdit` 之前**为止：这一段就是"门控分支 + 它 return 的说明页"，
   * 不含 ready 分支的编辑器 —— 于是"门控块里不许出现编辑器"才是有意义的断言。
   */
  const editorAt = wiki.indexOf('<WikiEdit', at)
  assert.ok(editorAt > at, '编辑路由必须在门控之后才渲染 WikiEdit')
  const block = wiki.slice(at, editorAt)
  assert.ok(block.length > 300, `编辑门控切片过短（${block.length} 字符），切片依据可能已失效`)
  assert.match(block, /loginForEditPage\(route\.slug\)/, '匿名必须有"去登录"，且回跳带 slug')
  assert.match(block, /onNavigate\(route\.slug\)/, '必须给"返回页面"的下一步（回本页详情）')
  assert.match(block, /编辑页面需要先登录/, '文案要说清是"编辑"')
  assert.match(block, /if \(editEntry\.kind !== 'ready'\)/, '必须在非 ready 时走这一支')
  assert.match(block, /<EmptyState/, '门控必须渲染一个说明页（不是空白、也不是编辑器）')
  assert.doesNotMatch(block, /<WikiEdit/, '门控块内不得渲染编辑器')
})
