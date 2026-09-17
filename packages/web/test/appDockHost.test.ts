/**
 * `app-dock` 宿主侧**结构性**不变量的源码守卫。
 *
 * ## 为什么这些必须用源码守卫，而不是渲染测试
 * 本仓的前端测试约定是"`.tsx` 只当源文本读、不 import"（见 `breadcrumb.test.ts` 的
 * `readFileSync('…/WikiPage.tsx')`）——渲染它们要牵进 React、插槽注册表、插件加载器
 * 与一批浏览器全局量，代价远大于收益。
 *
 * 而这里要钉的两条恰恰**只存在于结构里**，用普通单测根本表达不出来：
 *
 * 1. **dock 必须挂在 `<main>` 之外**——这是"切页不丢会话"的**唯一**机制。
 *    App 不随路由重挂，所以挂在壳子里的组件实例存活；挪进 `<main>`（也就是挪进路由渲染的
 *    那棵树）之后，症状不是报错，而是"切一次页会话就没了"，且不会有任何测试变红。
 * 2. **匿名必须一次都不触发 `ensureSlotLoaded('app-dock')`**——这是验收判据
 *    "匿名不加载 bundle" 的**唯一**实现位置。写成 `useEffect(() => { ensureSlotLoaded() }, [])`
 *    再在渲染里 `if (!loggedIn) return null` 是很自然的写法，但那样**匿名照样下载整套
 *    AI bundle**（effect 在渲染之后无条件跑），而界面看起来完全正常。
 *
 * 两条都是"改错了不会报错"的那一类，所以值得用守卫把它们钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const APP_FILE = join(here, '..', 'src', 'App.tsx')
const DOCK_FILE = join(here, '..', 'src', 'components', 'AppDock.tsx')

const appSource = readFileSync(APP_FILE, 'utf8')
const dockSource = readFileSync(DOCK_FILE, 'utf8')

/* ============================ ① 渲染位置 ============================ */

test('App.tsx 把 <AppDock> 挂在 </main> **之后**（切页不重挂的机制）', () => {
  const mainClose = appSource.indexOf('</main>')
  const dock = appSource.indexOf('<AppDock')
  assert.ok(mainClose >= 0, 'App.tsx 里找不到 </main>——结构变了，本守卫已失效，不得静默通过')
  assert.ok(dock >= 0, 'App.tsx 里找不到 <AppDock>——dock 没被挂载')
  assert.ok(
    dock > mainClose,
    '<AppDock> 出现在 </main> 之前：它被放进了随路由重挂的那棵子树，切页会丢会话',
  )
})

test('App.tsx 里没有第二个 <main>（否则上一条的 indexOf 判据会失真）', () => {
  /*
   * `<main(?![>])` 而不是 `<main\b`：**注释里会写 `<main>`**（本例中 dock 的注释
   * 恰好就要说明"放在 `<main>` 之外"），而 `<main\b` 会把它一起数进去。
   * 真实的开标签后面跟的是换行与属性，注释里的那个紧跟 `>`。
   */
  const opens = appSource.match(/<main(?![>])/g) ?? []
  const closes = appSource.match(/<\/main>/g) ?? []
  assert.equal(opens.length, 1, `App.tsx 有 ${opens.length} 个 <main>，上面那条位置判据不再可靠`)
  assert.equal(closes.length, 1, `App.tsx 有 ${closes.length} 个 </main>`)
})

test('App.tsx 的 AppDock 带着 route（需求②的"当前页"上下文来自宿主路由）', () => {
  const tag = /<AppDock[^>]*>/s.exec(appSource)?.[0] ?? ''
  assert.match(tag, /route=\{/, 'AppDock 必须收到 route，否则插件拿不到当前页上下文')
  assert.match(tag, /openPage=\{/, 'AppDock 必须收到 openPage，插件不得自己拼 hash')
})

/* ============================ ② 匿名零下载 ============================ */

/**
 * 组件体（`export function AppDock` 之后）——**所有结构断言都必须在这段里找**。
 *
 * 为什么不能直接在整个文件里 `indexOf`：本文件的**文件头注释恰好引用了它要守卫的那两行**
 * （`` `ensureSlotLoaded('app-dock')` `` 与 `useEffect(() => { ensureSlotLoaded() }, [])`），
 * 于是 `indexOf` 会先命中注释里的那一份，`loadAt < effectAt`，切片得到空串，
 * 断言**恒红**——第一版就是这么挂的。
 *
 * 教训与 `@ts-expect-error` 那条同源：**被守卫的东西出现在被扫描的文本里**，
 * 是所有源码级守卫的共同陷阱；把扫描范围收到"一定要含它、注释一定不含它"的区段里，
 * 比把正则写得更精巧可靠得多。
 */
const dockBody = dockSource.slice(dockSource.indexOf('export function AppDock'))

test('匿名**不触发** ensureSlotLoaded：加载调用必须在登录判定的分支里', () => {
  const loadAt = dockBody.indexOf("ensureSlotLoaded('app-dock')")
  assert.ok(loadAt >= 0, "AppDock 组件体里找不到 ensureSlotLoaded('app-dock')")

  const effectAt = dockBody.indexOf('useEffect(')
  assert.ok(effectAt >= 0, 'AppDock 组件体里找不到 useEffect')
  assert.ok(loadAt > effectAt, 'ensureSlotLoaded 必须在 useEffect 内部（不是在渲染期或模块初始化期）')

  const effectBody = dockBody.slice(effectAt, loadAt)
  assert.match(
    effectBody,
    /if\s*\(\s*!loggedIn\s*\)\s*return/,
    'ensureSlotLoaded 之前必须有 `if (!loggedIn) return`——否则匿名也会下载 AI bundle（界面看不出来）',
  )
  // 依赖数组在调用**之后**，故这里看的是整个 effect 到其收尾为止
  const effectTail = dockBody.slice(effectAt).split('}, [')[1] ?? ''
  assert.match(effectTail, /^loggedIn\]/, 'effect 的依赖里必须有 loggedIn，否则登录后不会补加载')
})

test('未登录时渲染出口返回 null（不产出任何 DOM）', () => {
  assert.match(
    dockSource,
    /if\s*\(\s*!loggedIn\s*\)\s*return null/,
    '未登录必须直接返回 null——dock 不是"隐藏"，而是"不存在"',
  )
})

test('所有 hooks 都在提前 return 之前调用（React 调用顺序约束）', () => {
  const earlyReturn = dockSource.search(/if\s*\(\s*!loggedIn\s*\)\s*return null/)
  assert.ok(earlyReturn >= 0, '找不到未登录的提前 return')
  // 提前 return 之后不得再出现 hook 调用
  const after = dockSource.slice(earlyReturn)
  for (const hook of ['useAuth(', 'useMemo(', 'useSyncExternalStore(', 'useEffect(']) {
    assert.equal(after.includes(hook), false, `提前 return 之后还有 ${hook} 调用——会破坏 hooks 顺序`)
  }
})

test('dock 的会话状态在插件侧：宿主不替它存历史（决策 12）', () => {
  // 宿主只传 page / clientTools / openPage / invokeTool 四项，
  // 出现 localStorage / sessionStorage 就说明宿主越界替插件管会话了
  for (const store of ['localStorage', 'sessionStorage']) {
    assert.equal(
      dockSource.includes(store),
      false,
      `AppDock.tsx 里出现了 ${store}：会话历史归插件（决策 12），宿主不该碰`,
    )
  }
})

/* ============================ ② 跳转类客户端工具的登记位置 ============================ */

/**
 * 剥注释：**状态机而不是正则**。
 *
 * 正则版会在 `'https://x'` 里把 `//` 当注释起点，从那里往后的代码全被吃掉——
 * 守卫会**静默变松**，那比误报更糟（本仓已记档三次这条教训）。
 * 这里尤其需要它：`navTools.ts` 的**文件头注释里就写着** `side: 'client'`
 * （它在解释工具的两半分工），不剥注释的话下面那条断言会一直红。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: '"' | "'" | '`' | null = null
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

test('★ registerNavTools 也在登录判定的分支里（未登录不许登记浏览器执行不了的能力）', () => {
  /*
   * 与 `ensureSlotLoaded` 那条同源，但后果不同：
   * dock 没渲染（未登录）却登记了工具，会让服务端看到一份浏览器**其实执行不了**的
   * 可调用集——模型于是会去调一个必定失败的工具，而用户看到的是
   * "AI 说要跳转，没反应"。界面看起来完全正常。
   */
  const at = dockBody.indexOf('registerNavTools(')
  assert.ok(at >= 0, 'AppDock 组件体里找不到 registerNavTools —— 跳转工具没有宿主处理器')
  const effectAt = dockBody.lastIndexOf('useEffect(', at)
  assert.ok(effectAt >= 0, 'registerNavTools 必须在 useEffect 内部')
  assert.match(
    dockBody.slice(effectAt, at),
    /if\s*\(\s*!loggedIn\s*\)\s*return/,
    'registerNavTools 之前必须有 `if (!loggedIn) return`',
  )
  /*
   * 注销必须由 effect 的返回值完成，否则登出后重登会撞上 `registerClientTool` 的"重名抛错"。
   * 判据看的是**调用点之前**有没有 `return`——调用点本身就以下一个字符开始，
   * 只看它之后的文本永远匹配不到（第一版就是这么写的，它恒红）。
   */
  assert.match(dockBody.slice(effectAt, at), /return\s*$/, 'effect 必须 `return registerNavTools(...)` 以完成注销')
})

test('★ 宿主只登记处理器，不自己贡献描述符（工具是两半，这一半不能替另一半说话）', () => {
  /*
   * 描述符必须由插件在服务端以 `side:'client'` 贡献，否则模型看不到它；
   * 处理器必须由宿主登记，否则"客户端上报的可调用集"就成了插件可控的输入（扩权路径）。
   * 宿主侧出现一张"我声明有哪些工具"的名单，就是这一半越界了。
   */
  const nav = stripComments(readFileSync(join(here, '..', 'src', 'lib', 'navTools.ts'), 'utf8'))
  assert.equal(
    /side\s*:/.test(nav),
    false,
    'navTools.ts 的实现里出现了 side —— 描述符是插件的资产，宿主不该声明工具"存在"',
  )
  assert.match(nav, /registerClientTool\('open_page'/, 'open_page 的处理器必须由宿主登记')
  assert.match(nav, /registerClientTool\('scroll_to'/, 'scroll_to 的处理器必须由宿主登记')
})
