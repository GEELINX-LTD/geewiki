/**
 * **主题令牌的可扩展性契约守卫**（P0：令牌统一化）。
 *
 * ## 这个测试防的是什么
 * 本仓的目标之一是「插件能改一切界面元素」，而**改外观**的第一步是让插件只覆盖
 * `--gw-*` 就能让全站跟着变。这要求两件事同时成立：
 *
 * 1. **规范值必须声明在「非 `@theme` 块」里**（`:root` / `.dark` / `@media`）。
 *    Tailwind v4 的 `@theme` 块**不会**向产物输出自定义属性声明——它只登记工具类。
 *    于是把 `--gw-radius-md` 写进 `@theme` 的后果是：Tailwind 工具类照常工作，
 *    但**插件侧 `var(--gw-radius-md)` 拿到的是空值**（静默失效，构建绿、typecheck 绿）。
 *    这正是 `pluginUi.test.ts` 已为插件引用的**非 `--gw-`** 名字建立的判据；本文件把
 *    同一条判据补到 `--gw-*` 上——因为 P0 之后插件的覆盖面**就是** `--gw-*`。
 *
 * 2. **除了 `--gw-*` 自己，任何声明都必须是 `var(--gw-*)` 别名，而不是字面值**。
 *    若 `--radius-md: 8px` 而 `--gw-radius-md: 8px` 各写一份，插件覆盖 `--gw-radius-md`
 *    时 `rounded-md`（走 `--radius-md`）不跟着变——症状是「插件改了令牌，有的圆角变了、
 *    有的没变」，同样不报任何错。
 *
 *    ⚠️ 这条**必须**同时覆盖 `@theme` 块**内**的声明（第 2 条测试最初只查块外，被阴性对照
 *    抓出盲区：把 `@theme inline` 里的 `--radius-md` 改成字面值 `8px` 时它依然是绿的）。
 *    块内写死字面值的后果更直接：Tailwind 会把字面值**编译进每个工具类**，
 *    插件覆盖令牌对存量工具类彻底失效——而 `@theme inline` 正是为了内联别名而存在的。
 *
 * ## 为什么断言"全套"而不是只挑几个名字
 * 漂移是逐个名字发生的（某天有人给 `--text-note` 加一档 `--text-lg`，只加进 `@theme`）。
 * 因此第 1、2 条是**全量**扫描 + 规模自证；第 3 条才逐个钉住六类尺度的规范名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 从仓库内的某个路径向上找到含 pnpm-workspace.yaml 的根 */
function findRepoRoot(start: string): string {
  let cur = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, 'pnpm-workspace.yaml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  throw new Error(`未找到仓库根（从 ${start} 向上）`)
}

const ROOT = findRepoRoot(HERE)
const TOKENS_REL = 'packages/web/src/styles/tokens.css'
const TOKENS_CSS = join(ROOT, TOKENS_REL)
const RAW = readFileSync(TOKENS_CSS, 'utf8')

/** 去掉 CSS 注释：注释里的 `var(--x)` 与 `--x: y` 都是**说明**，不是契约（既有守卫同款处理） */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** tokens.css 的源码（已剥注释）—— 行号定位都以它为准 */
const CODE = stripComments(RAW)

/**
 * `@theme` 块的字符区间（含嵌套花括号记数）。
 * 判据来自 Tailwind v4：只有**块外**的声明才会作为自定义属性进入产物。
 */
function themeBlockRanges(css: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const m of css.matchAll(/@theme\b[^{]*\{/g)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    ranges.push([m.index, i])
  }
  return ranges
}

const THEME_RANGES = themeBlockRanges(CODE)
const inTheme = (idx: number): boolean => THEME_RANGES.some(([a, b]) => idx >= a && idx <= b)

/** 每条自定义属性声明：名字、值、是否在 @theme 内 */
interface Decl {
  readonly name: string
  readonly value: string
  readonly inTheme: boolean
}

function declarations(css: string): Decl[] {
  const out: Decl[] = []
  for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g)) {
    out.push({ name: m[1] as string, value: (m[2] as string).trim(), inTheme: inTheme(m.index) })
  }
  return out
}

const DECLS = declarations(CODE)

/** 块外声明过的名字（产物里无条件存在的名字） */
const CONTRACT = new Set(DECLS.filter((d) => !d.inTheme).map((d) => d.name))

/** 全文件引用过的名字（`var(--x)` / `var(--x, fallback)` 都算） */
function referenced(css: string): Set<string> {
  const set = new Set<string>()
  for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) set.add(m[1] as string)
  return set
}

test('★ 每个被引用的 --gw-* 都必须在「非 @theme 块」里声明（@theme 不输出声明，插件拿不到）', () => {
  // 自证 1：解析确实分出了两类块，否则本测试可能在自欺
  assert.ok(THEME_RANGES.length >= 2, `tokens.css 里解析出的 @theme 块过少（${THEME_RANGES.length}），疑似扫描失效`)
  assert.ok(CONTRACT.size >= 100, `块外声明的自定义属性过少（${CONTRACT.size}），疑似解析失效`)

  const refs = [...referenced(CODE)].filter((n) => n.startsWith('--gw-'))
  assert.ok(refs.length >= 20, `tokens.css 里解析出的 --gw-* 引用过少（${refs.length}），疑似正则失效`)

  const problems = refs.filter((n) => !CONTRACT.has(n))
  assert.deepEqual(
    problems,
    [],
    '以下 --gw-* 只被引用、却没有在「非 @theme 块」里声明。Tailwind 的 @theme 只登记工具类、' +
      '**不输出自定义属性声明**，因此插件侧 var() 会拿到空值（构建与 typecheck 都不会报错）。\n' +
      `请把它们的**规范值**写进 ${TOKENS_REL} 的 :root（P0 起是第 1b 节），@theme 里只留 var(--gw-*) 别名：\n  ` +
      problems.join('\n  '),
  )
})

test('★ 任何声明要么是 --gw-* 真值（且不得住在 @theme 里），要么是指向 var(--gw-*) 的别名', () => {
  assert.ok(DECLS.length >= 200, `tokens.css 里解析出的声明过少（${DECLS.length}），疑似解析失效`)
  const aliases = DECLS.filter((d) => !d.name.startsWith('--gw-'))
  // 自证：别名块确实非空且规模合理（P0 后 @theme inline 与 4b 契约块都在这里）
  assert.ok(aliases.length >= 60, `别名声明过少（${aliases.length}），疑似解析失效`)

  const literals = aliases.filter((d) => !/^var\(--gw-/.test(d.value))
  assert.deepEqual(
    literals.map((d) => `${d.inTheme ? '@theme 内' : '块外'} ${d.name} = ${d.value}`),
    [],
    '以下名字持有**字面值**——它们的真值不在 --gw-* 上，于是插件覆盖 --gw-* 时它们不会跟着变，' +
      '症状是「插件改了令牌，有的地方变了、有的没变」且没有任何报错。' +
      '@theme 内的字面值更糟：Tailwind 会把它编译进每个工具类。\n' +
      `请改为 var(--gw-*) 别名，并把真值放到 :root 的 --gw-* 声明：\n  ` +
      literals.map((d) => `${d.name} = ${d.value}`).join('\n  '),
  )

  const truthInTheme = DECLS.filter((d) => d.name.startsWith('--gw-') && d.inTheme)
  assert.deepEqual(
    truthInTheme.map((d) => d.name),
    [],
    '@theme 块**不输出自定义属性声明**，因此规范值写在里面等于插件读不到：' +
      `请把这些搬到 :root（只有 :root / .dark / @media 里的声明会进入产物）：\n  ${truthInTheme.map((d) => d.name).join('\n  ')}`,
  )
})

test('★ 六类尺度的规范声明必须齐全（P0 的真值表；@theme 与 4b 都只是别名）', () => {
  // 名单来自 P0 的落盘事实，逐个钉住：删掉任何一项都会让"插件只覆盖 --gw-* 就改全站"部分失效。
  const REQUIRED: Readonly<Record<string, readonly string[]>> = {
    '--gw-text-': ['--gw-text-3xs', '--gw-text-2xs', '--gw-text-note', '--gw-text-md', '--gw-text-wordmark'],
    '--gw-radius-': ['--gw-radius-xs', '--gw-radius-sm', '--gw-radius-md', '--gw-radius-lg', '--gw-radius-xl', '--gw-radius-full'],
    '--gw-shadow-': ['--gw-shadow-xs', '--gw-shadow-sm', '--gw-shadow-md', '--gw-shadow-lg', '--gw-shadow-xl'],
    '--gw-ease-': ['--gw-ease-standard', '--gw-ease-out', '--gw-ease-move'],
    '--gw-z-': ['--gw-z-base', '--gw-z-sticky', '--gw-z-dropdown', '--gw-z-overlay', '--gw-z-modal', '--gw-z-toast'],
    '--gw-spacing-': ['--gw-spacing-gutter', '--gw-spacing-header', '--gw-spacing-measure', '--gw-spacing-wide'],
  }

  const problems: string[] = []
  for (const [family, names] of Object.entries(REQUIRED)) {
    for (const name of names) {
      if (!CONTRACT.has(name)) problems.push(`${name} 不在块外声明（${family} 家族的规范值缺失或搬进了 @theme）`)
    }
    // 家族自证：该家族在块外至少要有一条声明，防"名单写对但家族被整体改名"
    if (![...CONTRACT].some((n) => n.startsWith(family))) problems.push(`${family} 家族在块外一条声明都没有`)
  }
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`)

  // 4b 契约块：插件最常直接引用的那批别名，必须是 var(--gw-*) 指向上面这些规范名
  const EXPOSE_AS_ALIAS = [
    '--text-3xs',
    '--text-2xs',
    '--text-note',
    '--text-md',
    '--radius-xs',
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--ease-standard',
    '--ease-move',
  ]
  const byName = new Map(DECLS.filter((d) => !d.inTheme).map((d) => [d.name, d.value]))
  const missing = EXPOSE_AS_ALIAS.filter((n) => !byName.has(n))
  assert.deepEqual(missing, [], `契约块缺少这些别名：${missing.join(', ')}`)
})

test('★ tokens.css 里的每个 --gw-* 都必须能被 registerTheme 覆盖（命名空间与插件 API 一致）', () => {
  // 与 `packages/web/src/lib/pluginTheme.ts` 的 TOKEN_NAME 同源：只放行 `--gw-<小写字母数字段>`。
  // 若这里出现下划线 / 大写 / 空段，插件**永远**覆盖不到它——而令牌本身照常工作，
  // 于是表现为「插件注册了主题，颜色全变了、就这一项没变」，没有任何报错。
  const TOKEN_NAME = /^--gw-[a-z0-9]+(-[a-z0-9]+)*$/
  const gw = [...new Set(DECLS.filter((d) => d.name.startsWith('--gw-')).map((d) => d.name))]
  assert.ok(gw.length >= 60, `tokens.css 里的 --gw-* 名字过少（${gw.length}），疑似解析失效`)

  const unreachable = gw.filter((n) => !TOKEN_NAME.test(n))
  assert.deepEqual(
    unreachable,
    [],
    '以下 --gw-* 名字不符合 registerTheme 的 TOKEN_NAME（--gw-[a-z0-9]+(-[a-z0-9]+)*），' +
      `插件永远无法通过主题覆盖它们（真源 packages/web/src/lib/pluginTheme.ts:57）：\n  ${unreachable.join('\n  ')}`,
  )

  // P0 的核心收益必须可见：六类尺度令牌全部落在这个可覆盖命名空间里。
  // （P0 之前 `--text-wordmark` / `--radius-md` 是**不带 --gw- 前缀**的宿主私有名，
  //   registerTheme 的 §"只放行 --gw-*" 判据直接把它们拒掉 ⇒ 字号与圆角对插件不可改。）
  for (const kind of ['--gw-text-', '--gw-radius-', '--gw-shadow-', '--gw-ease-', '--gw-z-', '--gw-spacing-']) {
    assert.ok(
      gw.includes(`${kind}md`) || gw.some((n) => n.startsWith(kind)),
      `${kind}* 不在 --gw- 命名空间里：插件无法覆盖这一类尺度`,
    )
  }
})

test('产物里必须能看见规范声明与「别名被内联进工具类」（dist 存在时才校验）', () => {
  const assets = join(ROOT, 'packages/web/dist/assets')
  if (!existsSync(assets)) return // 干净克隆里没有 dist：与 pluginUi.test.ts 同款"产物存在才校验"

  const cssFiles = readdirSync(assets)
    .filter((n) => n.endsWith('.css'))
    .map((n) => join(assets, n))
    .filter((p) => statSync(p).isFile())
  assert.ok(cssFiles.length > 0, 'dist/assets 下没有 .css —— 构建产物形状变了，请同步本守卫')

  const biggest = cssFiles
    .map((p) => ({ p, size: statSync(p).size }))
    .sort((a, b) => b.size - a.size)[0]!.p
  const built = readFileSync(biggest, 'utf8')

  // 1) 规范值真的进了产物（块外声明）
  for (const name of ['--gw-radius-md', '--gw-text-wordmark', '--gw-spacing-measure', '--gw-z-modal']) {
    assert.match(built, new RegExp(`${name}\\s*:`), `产物里没有 ${name} 的声明：块外声明没进构建产物`)
  }
  // 2) @theme inline 的别名被 Tailwind 内联成 var(--gw-*)——这正是"插件覆盖 --gw-* 会穿透到工具类"的证据
  for (const name of ['--gw-radius-md', '--gw-text-wordmark']) {
    assert.match(
      built,
      new RegExp(`var\\(${name}\\)`),
      `产物里没有 var(${name})：说明工具类没有内联 --gw-* 别名（@theme inline 被改回 @theme？），` +
        '插件覆盖 --gw-* 将无法影响已经编译进产物的工具类',
    )
  }
})
