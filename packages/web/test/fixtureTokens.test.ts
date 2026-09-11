/**
 * 插件 UI 夹具样式的**宿主 token 引用守卫**。
 *
 * ## 这个测试防的是什么
 * `packages/web/fixtures/**` 下的样式是**插件侧**代码：它引用宿主的 CSS 自定义属性
 * （`--gw-*` / `--radius-*` / `--text-*` …），但**每个引用都带回退值**，因为插件不假定
 * token 一定存在（独立调试插件产物时也要有色）。
 *
 * 问题在于：**回退值会把"token 名写错"变成静默降级**。本仓库真实踩过——
 * `packages/web/fixtures/editor/style.css` 曾写 `var(--gw-muted, #6b7a8c)`，而宿主
 * **根本没有** `--gw-muted`（正确名是 `--gw-ink-muted`）⇒ 回退值一直在生效，且它恰好是
 * 旧调色板的 gray-500 ⇒ 浅色 4.09:1 / 深色 4.26:1，双双低于 4.5:1，被 axe 记为 serious
 * （命中 4 个节点）。**CSS 不会报错，构建不会失败，typecheck 也看不见**——只能靠真机
 * axe 审计才发现，代价很高。
 *
 * 而 `getComputedStyle` 在运行期也看不出来：拿到的就是那个回退值，与"token 存在且值恰好
 * 相同"无法区分。**唯一能定位的办法是静态比对"引用的名字"与"定义的名字"**，故本测试就做
 * 这一件事。
 *
 * ## 为什么不会空洞通过
 * 1. 解析 `tokens.css` 得到的**已定义集合**必须非空且规模合理（正则写坏 ⇒ 立刻红，
 *    而不是"两侧都空 ⇒ 0 === 0 相等"）；
 * 2. 解析夹具得到的**被引用集合**必须非空且规模合理（同上）；
 * 3. 断言里显式列出缺失项，失败信息直接给出"哪个文件、哪个名字、建议改成什么"。
 *
 * 迁移期提示：`--gw-muted` 这类"看着像但其实不存在"的名字，最可能的正确写法是
 * `--gw-ink-muted`；补 token 也行，但要改的是 `styles/tokens.css`（本测试只读它）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** 从仓库内的某个路径向上找到含 pnpm-workspace.yaml 的根 */
function findRepoRoot(start: string): string {
  let cur = start
  for (let i = 0; i < 12; i++) {
    try {
      readFileSync(join(cur, 'pnpm-workspace.yaml'))
      return cur
    } catch {
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  throw new Error(`未找到仓库根（从 ${start} 向上）`)
}

const root = findRepoRoot(here)
const TOKENS_CSS = join(root, 'packages/web/src/styles/tokens.css')
const FIXTURES_DIR = join(root, 'packages/web/fixtures')

/**
 * 视为"宿主 token 命名空间"的前缀。
 * 只查这些前缀：插件自己的局部自定义属性（若将来有）不属于宿主契约，不该被本守卫约束。
 *
 * ⚠️ 这份清单**必须覆盖 `tokens.css` 里全部已定义的名字**——否则插件引用某个命名空间时
 * 守卫看不见它（静默失效）。第二个测试就是为此加的：一旦 `tokens.css` 出现清单之外的
 * 命名空间，它会立刻红并提示补齐（本清单首版就漏了 `--shadow-*` / `--ease-*` / `--z-*`，
 * 正是被那条测试抓出来的）。
 */
const HOST_TOKEN_PREFIXES = [
  '--gw-',
  '--radius-',
  '--text-',
  '--spacing-',
  '--color-',
  '--font-',
  '--shadow-',
  '--ease-',
  '--z-',
]

/** 去掉 CSS 注释块：注释里的 `var(--x, …)` 是**说明**，不是真实引用（首版守卫被自己的注释绊红过） */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** 递归收集目录下的 `.css` 文件（跳过 node_modules 与构建产物目录） */
function collectCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'public') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectCss(p, out)
    else if (name.endsWith('.css')) out.push(p)
  }
  return out
}

/** 从 tokens.css 解析出全部**已定义**的自定义属性名（同样剔除注释：被注释掉的定义不算定义） */
function definedTokens(css: string): Set<string> {
  const set = new Set<string>()
  for (const m of stripComments(css).matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm)) set.add(m[1] as string)
  return set
}

/** 从一份样式里解析出全部**被引用**的宿主 token 名（含回退值的 var() 与不带回退的 var()） */
function referencedHostTokens(css: string): Set<string> {
  const set = new Set<string>()
  for (const m of stripComments(css).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    const name = m[1] as string
    if (HOST_TOKEN_PREFIXES.some((p) => name.startsWith(p))) set.add(name)
  }
  return set
}

test('插件夹具样式引用的宿主 token 必须在 tokens.css 中真实存在', () => {
  const tokensCss = readFileSync(TOKENS_CSS, 'utf8')
  const defined = definedTokens(tokensCss)

  // 自证 1：定义集合非空且规模合理（正则写坏会立刻在这里红，而不是让后面 0===0 通过）
  assert.ok(defined.size >= 40, `tokens.css 解析出的已定义 token 过少（${defined.size}），疑似正则失效`)
  for (const must of ['--gw-ink-muted', '--gw-ink', '--radius-md']) {
    assert.ok(defined.has(must), `tokens.css 里没有 ${must}——解析逻辑或 token 被删`)
  }

  const files = collectCss(FIXTURES_DIR)
  assert.ok(files.length > 0, '未找到任何夹具样式文件，收集逻辑失效')

  const problems: string[] = []
  let totalRefs = 0
  for (const file of files) {
    const refs = referencedHostTokens(readFileSync(file, 'utf8'))
    totalRefs += refs.size
    for (const name of refs) {
      if (defined.has(name)) continue
      const hint = name === '--gw-muted' ? '（疑似应为 --gw-ink-muted）' : ''
      problems.push(`${relative(root, file)} 引用了未定义的宿主 token ${name}${hint}`)
    }
  }

  // 自证 2：确实解析出了引用（否则本测试等于没跑）
  assert.ok(totalRefs >= 5, `夹具样式里解析出的宿主 token 引用过少（${totalRefs}），疑似正则失效`)

  assert.deepEqual(
    problems,
    [],
    `以下引用会**静默回退**到 var() 的第二个参数，构建与类型检查都不会报错：\n  ${problems.join('\n  ')}`,
  )
})

test('已定义的宿主 token 命名空间与守卫前缀一致（防新增命名空间后守卫失效）', () => {
  const defined = definedTokens(readFileSync(TOKENS_CSS, 'utf8'))
  const outside = [...defined].filter((n) => !HOST_TOKEN_PREFIXES.some((p) => n.startsWith(p)))
  assert.deepEqual(
    outside,
    [],
    `tokens.css 里出现了守卫前缀之外的 token：${outside.join(', ')}\n` +
      '若这是有意的新命名空间，请把它加进 HOST_TOKEN_PREFIXES，否则插件引用它时守卫看不到。',
  )
})
