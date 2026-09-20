/**
 * **插件 CSS 的颜色纪律**（P10）——纯函数，可脱离 DOM / 构建产物单测。
 *
 * ## 规则（一句话）
 * 插件样式里的颜色**只能**经 `var(--gw-*)` 取，**不得**硬编码
 * （`#rgb` / `rgb()` / `hsl()` / 颜色关键字）。
 *
 * ## 为什么"硬编码颜色"必须被挡下，而不是风格问题
 * 主题统一化（P0）的全部价值都建立在"颜色只有一个来源"上：`--gw-*` 由宿主定义、
 * 可被 `registerTheme` 整体覆盖。一处硬编码的颜色会**同时**破坏三件事：
 * 1. 深色模式下它不会变（插件那块变成刺眼的白板 / 黑块）；
 * 2. 主题插件覆盖 `--gw-*` 时它不跟着变（"我换了主题，就那一块没变"）；
 * 3. 对比度告警（{@link ./pluginTheme} 的 `themeContrastIssues`）**看不见它**——
 *    算不出来的颜色不会被报告，于是它连"被诊断"的机会都没有。
 *
 * ## 回退值为什么是**允许**的（与"禁止硬编码"不矛盾）
 * 插件不假定宿主 token 一定存在（独立调试插件产物时也要有色），故本仓夹具的约定是
 * `var(--gw-accent, #1d4ed8)`。回退值只在**宿主没有这个 token** 时生效，
 * 而"名字是否真的存在"由 `packages/web/test/fixtureTokens.test.ts` 静态守卫
 * （`--gw-muted` 那次事故就是它抓的）。
 *
 * 因此扫描器的判据是精确的：**把 `var(...)` 调用整体摘掉，再在剩下的文本里找颜色字面量**。
 * 于是
 * - `color: var(--gw-accent-soft-ink, #1d4ed8)` ⇒ 干净（回退值在 var() 里）；
 * - `color: #1d4ed8` ⇒ 违规；
 * - `border: 1px solid #3b82f6` ⇒ 违规（同一把尺子，不论属性是不是 `color`）。
 */

/** 允许出现的"不是颜色"的关键字（它们描述继承/透明，不描述某个具体色值） */
export const ALLOWED_COLOR_KEYWORDS: readonly string[] = Object.freeze([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none',
  'auto',
])

/**
 * 视为"硬编码颜色"的关键字。
 *
 * **不是**完整的 CSS 具名颜色表（148 个），而是**实际会被写进插件样式的常见色**：
 * 一份从记忆里抄出来的长表比一份短表更容易出错，而 hex / `rgb()` / `hsl()` 已经覆盖了
 * 真实世界里的绝大多数硬编码。新增色名时请连带在守卫测试里加一条用例。
 */
export const NAMED_COLORS: readonly string[] = Object.freeze([
  'white',
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
  'gray',
  'grey',
  'silver',
  'gold',
  'navy',
  'teal',
  'lime',
  'aqua',
  'cyan',
  'magenta',
  'fuchsia',
  'maroon',
  'olive',
  'beige',
  'ivory',
  'khaki',
  'coral',
  'salmon',
  'crimson',
  'indigo',
  'violet',
  'turquoise',
  'tan',
  'plum',
  'orchid',
  'azure',
  'linen',
  'snow',
  'wheat',
  'chocolate',
  'tomato',
  'seagreen',
  'steelblue',
  'slategray',
  'slategrey',
  'dimgray',
  'dimgrey',
  'lightgray',
  'lightgrey',
  'darkgray',
  'darkgrey',
  'whitesmoke',
  'gainsboro',
])

/** 找到的一处硬编码颜色 */
export interface HardcodedColor {
  /** 在**传入文本**里的行号（1 基）——注释已被摘掉，故不是原文件行号时请自行对照 */
  readonly line: number
  /** 出现它的声明（`属性: 值` 原文，便于一眼看出是哪个属性） */
  readonly declaration: string
  /** 命中的颜色字面量 */
  readonly color: string
}

/** 摘掉 `/* … *\/` 注释（保留换行，行号才与原文一致） */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * 摘掉值里所有 `var(...)` 调用（**按括号配对**，支持嵌套如
 * `var(--a, var(--b, #fff))`）。
 *
 * 用括号配对而不是正则：`var\([^)]*\)` 会在嵌套时只吃到第一个 `)`，把回退值的一部分
 * 留在"剩余文本"里 ⇒ 合法写法被误报。误报会让守卫失去信任，比漏报更糟。
 */
export function stripVarCalls(value: string): string {
  let out = ''
  let i = 0
  while (i < value.length) {
    if (value.startsWith('var(', i)) {
      let depth = 0
      let j = i + 3 // 指向 '('
      for (; j < value.length; j++) {
        if (value[j] === '(') depth += 1
        else if (value[j] === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      // 未闭合时整段丢弃（坏 CSS 交给别的守卫，这里不制造第二个判据）
      i = j >= value.length ? value.length : j + 1
      continue
    }
    out += value[i]
    i += 1
  }
  return out
}

const HEX = /#[0-9a-fA-F]{3,8}\b/
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/

/** 声明扫描：`属性: 值` 直到 `;` / `}`（选择器里的 `:` 因为后面不是 `;`/`}` 而天然不匹配） */
const DECLARATION = /([a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g

/** 在一段 CSS 文本里找出全部硬编码颜色 */
export function hardcodedColors(css: string): HardcodedColor[] {
  const text = stripComments(css)
  const found: HardcodedColor[] = []
  for (const m of text.matchAll(DECLARATION)) {
    const property = m[1] ?? ''
    const value = m[2] ?? ''
    const rest = stripVarCalls(value)
    const hit = findColorLiteral(rest)
    if (hit === null) continue
    const at = m.index ?? 0
    const line = text.slice(0, at).split('\n').length
    found.push({ line, declaration: `${property}: ${value.trim()}`, color: hit })
  }
  return found
}

/** 在（已摘掉 var() 的）文本里找第一个颜色字面量；没有则 null */
export function findColorLiteral(text: string): string | null {
  const hex = HEX.exec(text)
  if (hex !== null) return hex[0]
  const fn = COLOR_FN.exec(text)
  if (fn !== null) return fn[0].replace(/\s*\($/, '()')
  for (const word of text.matchAll(/[a-zA-Z][a-zA-Z-]*/g)) {
    const lower = word[0].toLowerCase()
    if (ALLOWED_COLOR_KEYWORDS.includes(lower)) continue
    if (NAMED_COLORS.includes(lower)) return word[0]
  }
  return null
}
