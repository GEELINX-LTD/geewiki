/**
 * 设计系统地基的纯逻辑单测。
 *
 * 覆盖两类"容易悄悄坏掉"的东西：
 *  1. **index.html 内联主题脚本 与 src/lib/theme.ts 的约定一致性** ——
 *     两处各写了一份存储键名/取值语义，任一处改动而另一处没跟上，症状是
 *     "深色模式时好时坏/刷新后跳回浅色"，而且只在真浏览器里才看得见。
 *     这里直接读 index.html 的源码来钉住它。
 *  2. **展示与主题工具的边界值** —— 非法输入不得吐出 "NaN 秒" 之类的文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { formatUptime } from '../src/lib/format'
import { THEME_STORAGE_KEY, isThemeChoice } from '../src/lib/theme'

const here = dirname(fileURLToPath(import.meta.url))
const htmlPath = join(here, '..', 'index.html')

/* ------------------------ 主题：内联脚本一致性 ------------------------ */

test('主题：index.html 的内联脚本与 theme.ts 使用同一个存储键名', () => {
  const html = readFileSync(htmlPath, 'utf8')
  assert.ok(
    html.includes(`'${THEME_STORAGE_KEY}'`),
    `index.html 的内联脚本应引用 '${THEME_STORAGE_KEY}'（实际未找到；两处键名不一致会导致刷新后主题丢失）`,
  )
})

test('主题：index.html 内联脚本存在、位于 head 内且同步执行（无 type=module / defer / async）', () => {
  const html = readFileSync(htmlPath, 'utf8')
  const headEnd = html.indexOf('</head>')
  const script = html.indexOf("localStorage.getItem('" + THEME_STORAGE_KEY + "')")
  assert.ok(script > 0, '应能找到读取主题存储的脚本')
  assert.ok(script < headEnd, '主题脚本必须在 </head> 之前（否则会先绘制一帧再变色 → 白闪）')

  // 取该脚本所在 <script ...> 开标签，断言它是同步的 classic script：
  // 一旦被改成 module/defer/async，执行时机就晚于首次绘制，白闪会回来。
  const openTagStart = html.lastIndexOf('<script', script)
  const openTag = html.slice(openTagStart, html.indexOf('>', openTagStart) + 1)
  assert.ok(!/type\s*=\s*["']module["']/.test(openTag), `主题脚本不得为 module：${openTag}`)
  assert.ok(!/\bdefer\b/.test(openTag), `主题脚本不得 defer：${openTag}`)
  assert.ok(!/\basync\b/.test(openTag), `主题脚本不得 async：${openTag}`)
})

test('主题：index.html 的 import map 仍先于任何 module script（插件单例不变量）', () => {
  const html = readFileSync(htmlPath, 'utf8')
  const importmap = html.indexOf('type="importmap"')
  assert.ok(importmap > 0, 'index.html 必须保留 import map（插件 bundle 依赖它解析 react）')
  // 找第一个 type="module" 的 script
  const moduleRe = /<script[^>]*type\s*=\s*["']module["'][^>]*>/g
  const first = moduleRe.exec(html)
  assert.ok(first !== null, 'index.html 应有 module script（应用入口）')
  assert.ok(
    importmap < first.index,
    'import map 必须在第一个 module script 之前，否则插件 bundle 会解析不到 react',
  )
})

test('主题：import map 仍位于 head 的第一个元素位置（允许其前只有注释/空白）', () => {
  const html = readFileSync(htmlPath, 'utf8')
  const headStart = html.indexOf('<head>')
  const importmap = html.indexOf('<script type="importmap">')
  assert.ok(headStart > 0 && importmap > headStart, '应在 head 内找到 import map')
  const between = html.slice(headStart + '<head>'.length, importmap)
  // 去掉注释与空白后应为空 —— 即 import map 是 head 的第一个**元素**
  const stripped = between.replace(/<!--[\s\S]*?-->/g, '').trim()
  assert.equal(stripped, '', `import map 之前不应有其它元素，实际：${JSON.stringify(stripped.slice(0, 120))}`)
})

/* ------------------------ 主题：取值判定 ------------------------ */

test('isThemeChoice：只接受三态字面量，其余（含 null/大小写变体）为假', () => {
  assert.equal(isThemeChoice('light'), true)
  assert.equal(isThemeChoice('dark'), true)
  assert.equal(isThemeChoice('system'), true)
  for (const bad of [null, undefined, '', 'Light', 'DARK', 'auto', 0, {}, []]) {
    assert.equal(isThemeChoice(bad), false, `${JSON.stringify(bad)} 不应被当作合法主题`)
  }
})

/* ------------------------ formatUptime ------------------------ */

test('formatUptime：各量级下输出人话，且绝不出现 NaN/负值', () => {
  assert.equal(formatUptime(0), '0 秒')
  assert.equal(formatUptime(45), '45 秒')
  assert.equal(formatUptime(60), '1 分钟')
  assert.equal(formatUptime(3599), '59 分钟')
  assert.equal(formatUptime(3600), '1 小时 0 分钟')
  assert.equal(formatUptime(3660), '1 小时 1 分钟')
  assert.equal(formatUptime(86400), '1 天 0 小时')
  assert.equal(formatUptime(86400 + 4 * 3600), '1 天 4 小时')
  assert.equal(formatUptime(3 * 86400 + 4 * 3600), '3 天 4 小时')
})

test('formatUptime：非法输入回退「未知」而不是 NaN', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, -0.5]) {
    assert.equal(formatUptime(bad), '未知', `${String(bad)} 应回退为「未知」`)
  }
  // 小数向下取整（不四舍五入：运行 1.9 秒说"1 秒"比说"2 秒"更诚实）
  assert.equal(formatUptime(1.9), '1 秒')
})

/* ------------- 源码守卫：未注册的 Tailwind token 不得回流 ------------- */

const SRC = join(here, '..', 'src')

/**
 * 剥掉块注释与行注释（与 `accessPage.test.ts` 同款写法）。
 *
 * **必须剥**：本文件、`accessPage.test.ts` 与若干组件注释里**故意**写着
 * `text-muted-foreground` 这两个名字（"不要写成……"），不剥就会把自己的说明文字
 * 当成违规命中 —— 而"注释里的反例"恰恰是防止这种写法回流的文档。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 递归收集 `src` 下所有 .ts/.tsx（此刻约 60 个文件；只收集文件、不跟随符号链接） */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkSources(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/*
 * 为什么必须用源码级断言：`text-muted-foreground` / `border-border` 是 Tailwind 的**默认**
 * token 名（来自它的预置主题），而本仓库走 CSS-first 的 `@theme inline`，只注册了
 * `muted` / `line` / `ink` 等自有名字。写成默认名时 Tailwind **不会报错**——它只是
 * 不生成任何样式，症状是"这行字/这条线看起来没生效"，肉眼与构建都极难发现。
 *
 * 覆盖范围（本批 R10 收口）：**整个 `src`**。此前只扫 `pages/OpsPage.tsx` 一个文件，
 * 于是 `pages/WikiPage.tsx` / `App.tsx` / `components/CommandPalette.tsx` 这些大文件
 * 不在任何 token 守卫覆盖内 —— 单个文件的守卫给不了"全仓没有回流"这个结论。
 */
test('设计系统：全仓源码不得使用未注册的 Tailwind token', () => {
  const files = walkSources(SRC)

  /*
   * 反空洞（三条）：只有"确实扫到了很多东西"才能支撑下面的负向断言。
   * 少了它们，一次路径写错（目录改名、cwd 变化）就会让"0 处违规"退化成"0 个文件"，
   * 测试照样全绿。
   */
  assert.ok(files.length > 20, `应扫到 20 个以上源文件（实际 ${files.length}），扫描路径可能不对`)
  for (const must of [
    'App.tsx',
    'pages/WikiPage.tsx',
    // 注：`pages/OpsPage.tsx` 已删（2026-09-17 搬成插件 @geewiki/ops）。插件的界面产物
    // **自带 CSS**（`packages/plugin-ops/ui/style.css`），一个 Tailwind 类都不用，故不在此扫描集内。
    'pages/OrgPage.tsx',
    'pages/AccessPage.tsx',
    'components/CommandPalette.tsx',
  ]) {
    assert.ok(files.includes(join(SRC, must)), `${must} 必须落在扫描集里（否则它不在任何 token 守卫覆盖内）`)
  }
  // 抽样自证：大文件真的读到了内容（不是 0 字节）
  const wiki = codeOnly(readFileSync(join(SRC, 'pages', 'WikiPage.tsx'), 'utf8'))
  assert.ok(wiki.length > 5000, `WikiPage.tsx 读入异常（仅 ${wiki.length} 字符），路径可能不对`)

  const hits: string[] = []
  for (const file of files) {
    const src = codeOnly(readFileSync(file, 'utf8'))
    const rel = file.slice(SRC.length + 1)
    if (src.includes('muted-foreground')) hits.push(`${rel}: text-muted-foreground（应改用 text-muted / text-ink-soft）`)
    if (src.includes('border-border')) hits.push(`${rel}: border-border（应改用 border-line）`)
  }
  assert.deepEqual(hits, [], `发现未注册 token 的用法：\n  ${hits.join('\n  ')}`)
})

test('设计系统：顶栏不得写死"为深色底设计"的颜色（text-white / bg-white）', () => {
  /*
   * 为什么需要这条守卫（它对应一个真实的用户反馈）：顶栏此前**在两种主题下都保持深色**，
   * 于是其子元素写了 `text-white` / `hover:bg-white/10` 这类**为深色底写死**的值。
   * 顶栏改成跟随主题后，同一个类在浅色主题下就是"白字压白底"（直接看不见）——
   * 而 Tailwind 不会为此报任何错，构建也照样过。这类缺陷只在真浏览器里、且只在浅色主题下
   * 才看得见，正是最该被源码级断言钉住的那类（同上面 `muted-foreground` / `border-border` 的思路）。
   *
   * 判据刻意只认 `text-white` / `bg-white` 两个**完整**类名：
   * 不能用裸 `white` 子串——`whitespace-nowrap` 里就含它，会误报一片。
   * 比较用的是**已剥注释**的源码，所以"不要写 text-white"这类说明文字不会把自己判违规。
   */
  const hits: string[] = []
  for (const file of walkSources(SRC)) {
    const src = codeOnly(readFileSync(file, 'utf8'))
    const rel = file.slice(SRC.length + 1)
    for (const cls of ['text-white', 'bg-white']) {
      // 允许带透明度后缀（bg-white/10）与状态前缀（hover:bg-white/10）
      if (new RegExp(`(^|[\\s'"\`:])(hover:|focus:|active:)?${cls}(\\/[0-9]+)?`).test(src)) {
        hits.push(`${rel}: ${cls}（顶栏跟随主题后应改用 text-header-ink / bg-header-hover 等语义色）`)
      }
    }
  }
  assert.deepEqual(hits, [], `顶栏相关的写死颜色回流：\n  ${hits.join('\n  ')}`)
})

test('设计系统：顶栏与代码块的底色是两个独立令牌（顶栏随主题、代码块恒深）', () => {
  const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8')
  const code = codeOnly(tokens)
  /*
   * 反空洞：先证明读到的是真的 tokens.css。
   * 然后钉住**解耦**这件事本身——曾经 `--gw-code-bg` 就是 `--gw-header-bg`，
   * 于是"顶栏改成跟随主题"会让浅色主题下的代码块一起变白（深底代码块是刻意保留的观感）。
   * 这里不检查具体色值（值可以调），只检查**职责分离**：两套名字都在，且代码块不借用顶栏的。
   */
  assert.ok(tokens.length > 2000, `tokens.css 读入异常（仅 ${tokens.length} 字符）`)
  assert.match(code, /--gw-code-bg:/, 'tokens.css 必须定义 --gw-code-bg（代码块底色）')
  assert.match(code, /--gw-code-ink:/, 'tokens.css 必须定义 --gw-code-ink（代码块前景）')
  // 代码块的两个令牌不得指向顶栏令牌（一旦如此，两个职责又合并了）
  const codeBg = /--gw-code-bg:\s*([^;]+);/.exec(code)?.[1] ?? ''
  const codeInk = /--gw-code-ink:\s*([^;]+);/.exec(code)?.[1] ?? ''
  assert.ok(
    !codeBg.includes('gw-header') && !codeInk.includes('gw-header'),
    `代码块的令牌不得引用顶栏令牌（bg=${codeBg.trim()}, ink=${codeInk.trim()}）`,
  )
  // 顶栏底色必须在**三处**主题作用域里各自赋值：浅色 :root / 显式 .dark / 系统偏好 media
  const occurrences = code.match(/--gw-header-bg:/g)?.length ?? 0
  assert.equal(
    occurrences,
    3,
    `--gw-header-bg 应在浅色 :root、.dark 与 prefers-color-scheme 三处各赋值一次（实际 ${occurrences} 处）——` +
      '只在常量块里赋值一次就等于"顶栏不随主题切换"，正是本次修掉的缺陷',
  )
})

test('设计系统：危险操作确认组件存在，并从 ui barrel 统一导出', () => {
  const src = readFileSync(join(SRC, 'ui', 'ConfirmDialog.tsx'), 'utf8')
  // 反空洞：同上，先证明读到了组件本体
  assert.ok(src.length > 500, `ConfirmDialog.tsx 读入异常（仅 ${src.length} 字符），路径可能不对`)
  assert.match(src, /export function ConfirmDialog\(/, '应导出 ConfirmDialog 组件')
  assert.match(src, /export function useConfirm\(/, '应导出 useConfirm（否则调用方无法发起确认）')
  // barrel 也要导出：否则各页面会绕过统一出口各自 import 文件，替换 window.confirm 时容易漏
  const barrel = readFileSync(join(SRC, 'ui', 'index.ts'), 'utf8')
  assert.match(barrel, /from '\.\/ConfirmDialog'/, 'ui/index.ts 应导出 ConfirmDialog 模块')
  assert.match(barrel, /useConfirm/, 'ui/index.ts 应导出 useConfirm')
})
