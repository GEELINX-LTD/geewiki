/**
 * **插件自带界面（`packages/plugin-ai-{qa,assistant}/ui`）的构建链与资产守卫**。
 *
 * ## 这个文件存在的唯一理由
 * 那两个界面**不住在 `packages/web` 里**，却依赖这里的一整套约定：构建脚本、产物目录名、
 * 宿主注入 CSS 的约定、设计 token。任何一环断了，症状都不是"构建失败"，而是
 * **"构建绿了，但插件界面凭空不出现"**（宿主按插件名解析 `/plugins-ui/<名>/client.js`，
 * 名字对不上就归入 `entry_missing` 静默跳过）。这类故障必须由一条测试变红。
 *
 * ## 三类断言
 * 1. **构建链**：脚本、产物目录名、manifest 声明、typecheck 配置 —— 四者必须互相咬合。
 * 2. **样式自主性**：面板只能靠自己的 `client.css` 好看（宿主那张表不是插件的资产），
 *    且插件样式**不得**重定义宿主的全局类（`.btn`/`.card`/…）——那是全局注入的副作用。
 * 3. **token 名字真实性**：引用了不存在的 `--gw-*` 会**静默回退**到 var 的第二个参数，
 *    CSS 不报错、构建不失败、typecheck 看不见（`fixtures/editor/style.css` 真实踩过这个坑，
 *    后果是对比度 4.09:1 被 axe 记为 serious）。这里做同样的静态比对。
 *
 * ## 为什么"产物存在才校验产物"
 * `packages/web/public/plugins-ui/` 在 `.gitignore` 里（构建产物，不入库）⇒ 干净克隆里
 * 没有 `client.js`。所以产物形状只在文件存在时校验；而**脚本与源码的咬合**永远校验，
 * 那才是会漂的部分。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRepoRoot(from: string): string {
  let cur = from
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, 'pnpm-workspace.yaml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  throw new Error(`未找到仓库根（从 ${HERE} 向上）`)
}

const ROOT = findRepoRoot(HERE)
const read = (rel: string): string => {
  const p = join(ROOT, rel)
  assert.ok(existsSync(p), `守卫依赖的文件应存在：${rel}`)
  return readFileSync(p, 'utf8')
}

/** tsconfig 是 JSONC（带注释），直接 `JSON.parse` 会炸 ⇒ 先剥注释 */
function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>
}

const ASSISTANT_REL = 'packages/plugin-ai-assistant'
const SUMMARY_REL = 'packages/plugin-ai-summary'
const WEB_PKG_REL = 'packages/web/package.json'
const PLUGIN_UI_TSCONFIG_REL = 'packages/web/tsconfig.plugin-ui.json'
const UI_OUT_REL = 'packages/web/public/plugins-ui'

/** 插件名 → 源码所在包目录（产物目录名必须用**左边**那个，源码路径用右边那个） */
const PLUGIN_UI_SOURCES: Record<string, string> = {
  '@geewiki/ai-assistant': 'plugin-ai-assistant',
  '@geewiki/ai-summary': 'plugin-ai-summary',
  /*
   * 账号页的「外部身份」面板（2026-09-16 从宿主搬进插件）。
   * 它一度需要读 `window.location.hash` 才能拿到 `?link=required`（下面的"不碰路由"断言会红），
   * 后来改成**宿主读、当 prop 传**（`AccountIdentitiesSlotProps.linkPending`）——
   * 于是这条纪律不需要任何例外，它也就被纳进这份名单里接受同样的校验。
   */
  '@geewiki/oidc': 'plugin-oidc',
}

/** 去掉块注释与行注释：注释里出现被禁的词不算实现残留 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')
}

/* ============================ 构建链咬合 ============================ */

test('自带界面的 AI 插件的清单都声明了产物名与插槽（宿主据此派生入口表）', () => {
  const cases: Array<[string, string, string]> = [
    [`${ASSISTANT_REL}/src/index.ts`, '@geewiki/ai-assistant', 'app-dock'],
    [`${SUMMARY_REL}/src/index.ts`, '@geewiki/ai-summary', 'article-summary'],
  ]
  for (const [rel, name, slot] of cases) {
    const manifest = read(rel)
    assert.ok(manifest.includes(`name: '${name}'`), `${rel} 的插件名与目录不匹配`)
    assert.ok(
      /client: \{ entry: 'client\.js', css: 'client\.css' \}/.test(manifest),
      `${rel} 必须声明 client.entry=client.js + css=client.css（与构建产物的文件名逐字对应）`,
    )
    assert.ok(manifest.includes(`slots: ['${slot}']`), `${rel} 的 slots 必须恰好是 ['${slot}']`)
  }
})

test('build:plugin-ui 为每个自带界面的插件各产一份 client.js/client.css，且目录名逐字等于插件名', () => {
  const scripts = (parseJsonc(read(WEB_PKG_REL)).scripts ?? {}) as Record<string, string>
  const raw = scripts['build:plugin-ui']
  assert.equal(typeof raw, 'string', 'packages/web 必须提供 build:plugin-ui 脚本')
  const script = raw as string
  for (const name of ['@geewiki/ai-assistant', '@geewiki/ai-summary']) {
    assert.ok(
      script.includes(`FIXTURE_OUT=${name}`),
      `build:plugin-ui 必须用 FIXTURE_OUT=${name} 产出到 /plugins-ui/${name}/（宿主按插件名解析）`,
    )
    const entry = PLUGIN_UI_SOURCES[name]
    assert.ok(entry !== undefined, `未知的插件名：${name}`)
    assert.ok(
      script.includes(`FIXTURE_ENTRY=../../${entry as string}/ui/index.tsx`),
      `build:plugin-ui 必须把入口指到 ../../${entry as string}/ui/index.tsx`,
    )
    assert.ok(script.includes('vite build --config fixtures/vite.config.ts'), '必须复用同一份 vite 配置')
  }
  // 各自先清自己的目录：否则上一次构建的残留文件会继续被服务（症状是"改了没生效"）
  assert.ok((script.match(/rm -rf/g) ?? []).length >= 1, '构建前应清掉旧产物目录')
})

test('build:fixtures 清整个 plugins-ui 之后会重链 build:plugin-ui（否则一条命令就抹掉 AI 界面）', () => {
  const scripts = (parseJsonc(read(WEB_PKG_REL)).scripts ?? {}) as Record<string, string>
  const fixtures = scripts['build:fixtures'] ?? ''
  assert.ok(fixtures.startsWith('rm -rf public/plugins-ui'), 'build:fixtures 的清理语义已变化，请同步核对')
  assert.ok(
    fixtures.includes('build:plugin-ui'),
    'build:fixtures 会先 `rm -rf public/plugins-ui` ⇒ 结尾必须重链 build:plugin-ui，' +
      '否则跑一次 fixtures 就把两个自带界面的 AI 插件产物抹掉（表现为"界面凭空消失"）',
  )
  // 原有三份夹具仍在同一条命令里（迁移不能把既有夹具构建挤掉）
  for (const must of ['plugins/ui-demo/dist', '@geewiki-plugin/hello', '@geewiki/editor-plain']) {
    assert.ok(fixtures.includes(must), `build:fixtures 里少了既有夹具：${must}`)
  }
})

/*
 * 只有**自带前端产物**的包才有 build:ui。`@geewiki/ai-writing` 已随决策 18 拆掉界面
 * （它现在只声明四条客户端工具名），故它不该有这条脚本——留着会在 `pnpm -r run build` 里
 * 跑一次什么都不产的构建。
 */
test('自带界面的插件包各自的 build:ui 都委托给 @geewiki/web 的 build:plugin-ui', () => {
  for (const rel of [`${ASSISTANT_REL}/package.json`, `${SUMMARY_REL}/package.json`]) {
    const scripts = (parseJsonc(read(rel)).scripts ?? {}) as Record<string, string>
    assert.equal(
      scripts['build:ui'],
      'pnpm --filter @geewiki/web build:plugin-ui',
      `${rel} 的 build:ui 必须委托给 web 的统一构建（别在插件包里再起一份 vite）`,
    )
  }
})

test('fixtures/vite.config.ts 校验"产物目录名 == 入口所属包名"（防静默不加载）', () => {
  const config = read('packages/web/fixtures/vite.config.ts')
  assert.ok(
    /assertPluginNameMatchesEntry/.test(config),
    '必须存在"FIXTURE_OUT 与入口包名一致"的校验：对不上会静默不加载',
  )
  // 这三条是 react 系插件产物的硬约束，配置一旦被改就得立刻变红
  for (const must of [`jsx: 'automatic'`, 'publicDir: false', `'process.env.NODE_ENV'`, `cssFileName: 'client'`]) {
    assert.ok(config.includes(must), `构建配置里缺少关键约定：${must}`)
  }
  for (const external of ['react', 'react/jsx-runtime']) {
    assert.ok(config.includes(`'${external}'`), `${external} 必须是 external（打进产物会出现两份 React）`)
  }
})

test('tsconfig.plugin-ui.json 覆盖各插件的 ui 目录，并被 web 的 typecheck 串上', () => {
  const cfg = parseJsonc(read(PLUGIN_UI_TSCONFIG_REL))
  const include = cfg.include
  assert.ok(Array.isArray(include) && include.length >= 2, 'include 必须列出各插件的 ui 目录')
  const flat = JSON.stringify(include)
  assert.ok(
    flat.includes('plugin-ai-assistant/ui') && flat.includes('plugin-ai-summary/ui'),
    `include 不完整：${flat}`,
  )
  const options = (cfg.compilerOptions ?? {}) as Record<string, unknown>
  assert.equal(options.jsx, 'react-jsx', 'ui 是 JSX 源码')
  assert.ok(JSON.stringify(options.lib ?? '').includes('DOM'), 'ui 用 DOM 类型（fetch / <dialog>）')
  assert.ok(JSON.stringify(options.paths ?? '').includes('@types/react'), 'react 类型必须显式指到 web 的安装')
  const scripts = (parseJsonc(read(WEB_PKG_REL)).scripts ?? {}) as Record<string, string>
  assert.ok(
    (scripts.typecheck ?? '').includes('tsconfig.plugin-ui.json'),
    'typecheck 必须跑这份配置，否则插件界面源码处于"没人检查"状态',
  )
})

/* ============================ 样式自主性 ============================ */

/*
 * 这里曾有一组 `E2E_ASSERTED_CLASSES` 守卫，钉的是问答面板那套 `.ask-*` 类名必须留在
 * **插件自己的** `client.css` 里（不能只活在宿主样式表里）。随 P8 拆除 `wiki-ask`
 * 与 `@geewiki/ai-qa`，那套类名连同面板一起消失了，守卫也随之失效——它守的对象不存在了。
 *
 * **没有一起删掉的是下面这条**：它不针对某一个插件，而是插件样式的**全局注入**这个
 * 事实约束（`<style>` 是全局的，`.btn` 这类宿主类名被插件重定义会覆盖宿主的修正，
 * 且不会有任何报错）。任何新插件都继续受它约束。
 */
test('各插件样式都不重定义宿主的全局类（插件样式是全局注入的）', () => {
  for (const rel of [`${ASSISTANT_REL}/ui/style.css`, `${SUMMARY_REL}/ui/style.css`]) {
    const css = stripComments(read(rel))
    for (const hostClass of ['btn', 'card', 'notice', 'badge', 'chip', 'muted', 'small', 'md-body']) {
      const re = new RegExp(`^\\s*\\.${hostClass}\\b`, 'm')
      assert.ok(!re.test(css), `${rel} 重定义了宿主的 .${hostClass} —— 同名同值也会随宿主漂移并覆盖其修正`)
    }
    /*
     * "减少动效"守卫**按需**要求：这张表里没有 animation/transition 时，一个空的
     * `@media (prefers-reduced-motion: reduce)` 块是死代码 —— 守卫要钉的是
     * "做了动效就要尊重偏好"，不是"每张表都得抄一段仪式"。
     * 判据看的是剥注释后的**属性声明**（不是媒体查询本身，否则它会自我满足）。
     */
    const animates = /(^|[;{\s])(animation|transition)\s*:/.test(css)
    if (animates) {
      assert.ok(/prefers-reduced-motion: reduce/.test(css), `${rel} 声明了动效却缺少"减少动效"偏好守卫`)
    }
    assert.ok(/:focus-visible/.test(css), `${rel} 没有焦点态：键盘用户看不见焦点在哪`)
  }
})

/* ============================ token 名字真实性 ============================ */

const HOST_TOKEN_PREFIXES = ['--gw-', '--radius-', '--text-', '--spacing-', '--color-', '--font-', '--shadow-', '--ease-', '--z-']

/** Tailwind 主题提供的名字（不在 `tokens.css` 里，但宿主页面确实会注入）；每加一个都要说明出处 */
const ALLOWED_FROM_TAILWIND = new Set(['--spacing'])

const TOKENS_CSS_REL = 'packages/web/src/styles/tokens.css'
const OIDC_REL = 'packages/plugin-oidc'
const PLUGIN_STYLE_RELS = [`${ASSISTANT_REL}/ui/style.css`, `${SUMMARY_REL}/ui/style.css`, `${OIDC_REL}/ui/style.css`]

/**
 * 找出 `@theme` 块的字符区间（顶层的，含嵌套的同名 at-rule 一并算进去）。
 *
 * 为什么要区分块内块外：`@theme` 里的名字**不保证进产物**。`@theme inline` 的语义是
 * 「把值内联进生成的工具类」，变量声明本身根本不输出；即便不用 `inline`，Tailwind 也会
 * 按「宿主有没有用到」裁剪。宿主自己的界面不受影响（工具类里写的是 `var(--gw-ink)` 真值），
 * 但**插件 CSS 只能引用变量名** —— 于是引用一个只在 `@theme` 里出现过的名字，
 * 症状是「深色下摘要条没有底色」「回退值生效变成白块」，而构建、typecheck、本文件原先
 * 那条只看源码的守卫**全都不会红**（实测就是这么漏过去的）。
 */
function themeBlockRanges(css: string): Array<[number, number]> {
  const code = stripComments(css)
  const ranges: Array<[number, number]> = []
  const re = /@theme\b[^{]*\{/g
  for (const m of code.matchAll(re)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    ranges.push([m.index, i])
  }
  return ranges
}

/** 只在**非 `@theme` 块**里声明的 token —— 这些才是产物里无条件存在的名字 */
function contractTokens(css: string): Set<string> {
  const ranges = themeBlockRanges(css)
  const inTheme = (idx: number): boolean => ranges.some(([a, b]) => idx >= a && idx <= b)
  const code = stripComments(css)
  const set = new Set<string>()
  for (const m of code.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    if (!inTheme(m.index)) set.add(m[1] as string)
  }
  return set
}

function definedTokens(css: string): Set<string> {
  const set = new Set<string>()
  for (const m of stripComments(css).matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm)) set.add(m[1] as string)
  return set
}

function referencedTokens(css: string): Set<string> {
  const set = new Set<string>()
  for (const m of stripComments(css).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) set.add(m[1] as string)
  return set
}

test('插件样式引用的宿主 token 必须在 tokens.css 里真实存在（防静默回退）', () => {
  const defined = definedTokens(read(TOKENS_CSS_REL))
  assert.ok(defined.size >= 40, `tokens.css 解析出的定义过少（${defined.size}），疑似正则失效`)
  let total = 0
  const problems: string[] = []
  for (const rel of PLUGIN_STYLE_RELS) {
    const refs = referencedTokens(read(rel))
    total += refs.size
    for (const name of refs) {
      if (!HOST_TOKEN_PREFIXES.some((p) => name.startsWith(p)) && !ALLOWED_FROM_TAILWIND.has(name)) continue
      if (defined.has(name) || ALLOWED_FROM_TAILWIND.has(name)) continue
      const hint = name === '--gw-muted' ? '（疑似应为 --gw-ink-muted）' : ''
      problems.push(`${rel} 引用了未定义的宿主 token ${name}${hint}`)
    }
  }
  assert.ok(total >= 20, `两份样式里解析出的 token 引用过少（${total}），疑似正则失效`)
  assert.deepEqual(problems, [], `以下引用会**静默回退**到 var() 的第二个参数：\n  ${problems.join('\n  ')}`)
})

test('★ 插件引用的 token 必须落在「契约块」里，而不是只在 @theme 内（那不进产物）', () => {
  const css = read(TOKENS_CSS_REL)
  const contract = contractTokens(css)
  const all = definedTokens(css)
  // 契约块本身不能空：空了说明扫描失效，而不是"恰好没有"
  assert.ok(contract.size >= 20, `契约块解析出的定义过少（${contract.size}），疑似扫描失效`)
  // 反向对照：@theme 里确实有块外没有的名字（否则这条守卫在自欺——它必须真的在区分两者）
  const themeOnly = [...all].filter((n) => !contract.has(n))
  assert.ok(
    themeOnly.length >= 5,
    `@theme 内独有（块外没有）的名字只有 ${themeOnly.length} 个，本条守卫的区分度可疑：${themeOnly.join(', ')}`,
  )

  const problems: string[] = []
  let total = 0
  for (const rel of PLUGIN_STYLE_RELS) {
    for (const name of referencedTokens(read(rel))) {
      if (!HOST_TOKEN_PREFIXES.some((p) => name.startsWith(p))) continue
      if (name.startsWith('--gw-')) continue // --gw-* 是 :root 上的原始变量，天然在契约里
      total += 1
      if (contract.has(name)) continue
      const where = all.has(name) ? '只在 @theme 块里出现（该块不输出变量声明）' : 'tokens.css 里根本没有'
      problems.push(`${rel} 引用了 ${name}：${where}`)
    }
  }
  assert.ok(total >= 10, `解析出的语义 token 引用过少（${total}），疑似正则失效`)
  assert.deepEqual(
    problems,
    [],
    `插件产物在页面里只会引用变量名，拿不到声明就等于没有这个颜色。\n` +
      `请把名字加进 ${TOKENS_CSS_REL} 第 4b 节的契约 \`:root\`：\n  ${problems.join('\n  ')}`,
  )
})

test('★ 插件样式不得写 var() 回退值（回退值会掩盖契约断裂，且只对一种主题成立）', () => {
  const problems: string[] = []
  for (const rel of PLUGIN_STYLE_RELS) {
    const css = stripComments(read(rel))
    for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*,/g)) {
      problems.push(`${rel} 的 ${m[1]} 带了回退值：${m[0]}`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    '回退值在变量存在时不生效、在变量缺失时给出一个**只有浅色主题正确**的值，' +
      `于是"深色下变白块"永远等不到一条会红的测试。宁可整条声明失效（一眼可见）。\n  ${problems.join('\n  ')}`,
  )
})

test('★ tokens.css 的注释必须闭合干净（注释正文里出现 */ 会把后面的 @theme 吞掉）', () => {
  const css = read(TOKENS_CSS_REL)
  let i = 0
  let depth = 0
  const stray: string[] = []
  while (i < css.length) {
    if (depth === 0 && css.startsWith('/*', i)) {
      depth = 1
      i += 2
      continue
    }
    if (depth === 1 && css.startsWith('*/', i)) {
      depth = 0
      i += 2
      continue
    }
    if (depth === 0 && css.startsWith('*/', i)) {
      const line = css.slice(0, i).split('\n').length
      stray.push(`第 ${line} 行出现游离的 */`)
      i += 2
      continue
    }
    i += 1
  }
  assert.ok(depth === 0, '注释没有闭合（文件结束时仍在注释里）')
  assert.deepEqual(
    stray,
    [],
    '注释正文里写成 `xxx-*/yyy` 会**提前闭合**该注释，剩下的注释文本被当成 CSS 解析，' +
      `紧随其后的 @theme 块会被整块丢弃 —— 症状是"自定义颜色工具类全部消失"，而不是构建失败。\n  ${stray.join('\n  ')}`,
  )
})

test('★ 自定义色工具类必须真的进产物（拿构建产物复核，缺产物时跳过）', () => {
  const assetsDir = join(ROOT, 'packages/web/dist/assets')
  if (!existsSync(assetsDir)) {
    console.log('[skip] packages/web/dist 不存在（未构建）')
    return
  }
  const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
  if (cssFiles.length === 0) {
    console.log('[skip] packages/web/dist/assets 下没有 .css')
    return
  }
  // 取最大的那个（应用主样式表）
  const main = cssFiles
    .map((f) => ({ f, size: statSync(join(assetsDir, f)).size }))
    .sort((a, b) => b.size - a.size)[0]!.f
  const built = readFileSync(join(assetsDir, main), 'utf8')
  const missing = ['.text-ink{', '.text-muted{', '.bg-sunken{', '.border-line{'].filter((c) => !built.includes(c))
  assert.deepEqual(
    missing,
    [],
    `${main} 里缺少自定义色工具类：${missing.join(', ')}。\n` +
      '这说明 `@theme inline` 块没有被 Tailwind 读到（最常见原因是它被一段提前闭合的注释吞掉了）。',
  )
  // 契约变量必须真的输出（`.gw-summary` 之类是**插件自己**的类名，在 client.css 里，不在这里查）
  const contractVars = ['--color-sunken:', '--color-line:', '--color-muted:', '--color-warn-line:']
  const absent = contractVars.filter((v) => !built.includes(v))
  assert.deepEqual(
    absent,
    [],
    `${main} 里缺少契约变量：${absent.join(', ')}。\n` +
      '插件 CSS 引用的语义色应当由 tokens.css 第 4b 节的 :root 契约块无条件输出。',
  )
})

/* ============================ 产物形状（存在才校验） ============================ */

test('已构建的产物：导出 register、只从 react 拿运行时、不碰路由', () => {
  const built: string[] = []
  for (const name of ['@geewiki/ai-assistant', '@geewiki/ai-summary']) {
    const dir = join(ROOT, UI_OUT_REL, name)
    if (!existsSync(dir)) continue // 干净克隆里没有（public/plugins-ui 被 gitignore）
    built.push(name)
    const js = readFileSync(join(dir, 'client.js'), 'utf8')
    const cssFiles = readdirSync(dir).filter((f) => f.endsWith('.css'))
    assert.ok(cssFiles.length > 0, `${name} 的产物目录缺 client.css（manifest 声明了它）`)
    assert.ok(/export\s*{[\s\S]*\bregister\b/.test(js), `${name}/client.js 必须导出 register`)
    // 只允许从 react / react/jsx-runtime 取运行时；把 react 打进产物会出现两份实例
    const imported = [...js.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1] as string)
    const bad = imported.filter((s) => s !== 'react' && s !== 'react/jsx-runtime')
    assert.deepEqual(bad, [], `${name}/client.js 还从别处取运行时：${bad.join(', ')}`)
    assert.ok(!/location\.hash|window\.location/.test(js), `${name}/client.js 里出现了路由直改`)
    assert.ok(/credentials/.test(js), `${name}/client.js 必须带凭据发起请求（权限判定依赖会话主体）`)
    assert.ok(/x-gw-csrf/.test(js), `${name}/client.js 的 POST 必须带 CSRF 头`)
  }
  // 防空洞：至少说明本条在有产物时真的跑了（没有产物时上面整个循环跳过）
  if (built.length === 0) {
    console.log('[skip] public/plugins-ui 下没有已构建的 AI 产物（跑 `pnpm --filter @geewiki/web build:plugin-ui` 后本条才会校验）')
  }
})

test('宿主样式表里若还留着 `.ask-*`，只是过渡期的重复（不构成本守卫的失败）', () => {
  const hostCssPath = join(ROOT, 'packages/web/src/styles.css')
  if (!existsSync(hostCssPath)) return
  const hostCss = readFileSync(hostCssPath, 'utf8')
  const stillThere = /\.ask-/.test(hostCss)
  if (!stillThere) return
  // 宿主那份是**过渡期**残留（插件产物已自带一份）。这里只钉住"不许再往宿主里加 ask 专属规则"
  // 的反向条件：宿主表里的 `.ask-` 规则不得引用插件自己的 `gw-assist` 类（两张表必须互不依赖）。
  assert.ok(!hostCss.includes('gw-assist'), '宿主样式表不该引用插件私有类：两张表必须互不依赖')
  const lines = hostCss.split('\n').filter((l) => /\.ask-/.test(l)).length
  assert.ok(lines < 60, `宿主里残留了 ${lines} 行 .ask-* 规则，插件产物已自带 ⇒ 应删除（见 docs/design/ai-plugin-split.md §4.5）`)
})

/** 顺带钉住一条容易忽略的事实：ui 目录里不该混进 node 端代码（会被打进浏览器产物） */
test('ui 目录只放浏览器代码（不得 import node: 或服务端 src）', () => {
  const files: string[] = []
  for (const rel of [`${ASSISTANT_REL}/ui`, `${SUMMARY_REL}/ui`]) {
    const dir = join(ROOT, rel)
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isFile()) files.push(p)
    }
  }
  assert.ok(files.length >= 6, `ui 目录里的文件数异常（${files.length}）`)
  for (const p of files) {
    if (!p.endsWith('.ts') && !p.endsWith('.tsx')) continue
    const src = stripComments(readFileSync(p, 'utf8'))
    assert.ok(!/from 'node:|require\('node:/.test(src), `${relative(ROOT, p)} 引入了 node: 依赖`)
    // 只查 **import 说明符**：文案字符串里出现 `@geewiki/search` 是在告诉用户该启用哪个插件，那是合法的
    assert.ok(
      !/from\s*['"]\.\.\/src\//.test(src),
      `${relative(ROOT, p)} import 了服务端 src（会把 cordis 拖进浏览器）`,
    )
    assert.ok(
      !/from\s*['"]@geewiki\//.test(src),
      `${relative(ROOT, p)} import 了 workspace 包（宿主能力要用自带的最小声明）`,
    )
  }
})
/* ============================ 摘要卡：一条只存在于分支里的不变量 ============================ */

/*
 * "没有可用模型 ⇒ **整张卡片不渲染**"是 P6 的验收判据之一，而它是一条**只存在于
 * 一个 if 分支里**的事实：它没有任何可观测的产出（不渲染就是不渲染），
 * 于是一个"改成显示『暂不可用』"的改动不会被任何行为测试抓到——
 * 而那个改动恰好把这条裁决的意义抹掉了：一张永远转不出结果的折叠卡会让读者
 * **学会不再看摘要**，连带真正有摘要的页面一起被忽略。
 *
 * 所以这里按源码钉住它。判据收窄到 `!view.available` 之后的 400 字符内：
 * 扫整个文件会因为别处也有 `return null`（例如"还没生成且不能重算"那条分支）而恒真。
 */
test('摘要卡：available=false 时必须 return null（不是显示一句"暂不可用"）', () => {
  const src = stripComments(read(`${SUMMARY_REL}/ui/index.tsx`))
  const at = src.indexOf('!view.available')
  assert.ok(at > 0, '未找到 `!view.available` 分支——接口改了就要一起改这条守卫，不允许静默通过')
  const branch = src.slice(at, at + 400)
  assert.ok(branch.includes('return null'), `available=false 时必须什么都不渲染，实际分支：\n${branch}`)
  assert.ok(
    !/暂不可用|不可用|无法生成/.test(branch),
    '这一分支里不得出现"不可用"之类的文案：没有模型时读者不该看到任何东西',
  )
})
