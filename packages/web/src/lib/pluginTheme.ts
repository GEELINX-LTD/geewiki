/**
 * ★ F16：主题 / 品牌插件化 —— 插件对**设计 token** 的覆盖注册表。
 *
 * ## 与 `theme.ts` 的分工（两者不可混为一谈）
 * `theme.ts` 管的是**用户偏好**：三态 `system/light/dark`，落盘 + 把 `.light`/`.dark`
 * 写到 `<html>` 上，首帧由 `index.html` 的内联脚本抢跑（防白闪）。
 * 本文件管的是**插件贡献的 token 值**：它**不**决定深浅，只在用户/系统已经选定的
 * 那一种模式里替换若干 `--gw-*`。两者正交，互不调用。
 *
 * ## 为什么覆盖的是 `--gw-*`（原始 palette），而不是语义 token
 * `tokens.css` 刻意做成两段式：语义 token（`--color-surface` 等，注册进 Tailwind 的
 * `@theme`）**只指向** `--gw-*`；真正的深浅色赋值发生在 `--gw-*` 上（`:root` / `.dark`）。
 * 好处正在此处：**改一处 `--gw-*`，语义 token、工具类、深浅两套主题全部自动跟随**，
 * 插件无须知道 `--color-surface` 与 `--gw-gray-25` 之间的那层间接。
 * 反之若允许插件直接改 `--color-*`，它同时绕过了两段式（深浅色不再自动跟随）并可能
 * 改坏布局类 token —— 收益更小、破坏面更大，故**拒绝**（见 {@link TOKEN_NAME}）。
 *
 * ## 层叠顺序：这是本文件最容易做错的地方
 * 插件样式表是**后注入**的，而同特异性下 CSS **后者胜**。于是天真写法（把浅色覆盖
 * 写成 `:root{…}`）会踩一个很隐蔽的坑：`:root` 与 `.dark` 的特异性都是 (0,1,0)，
 * 内置样式表在前 ⇒ **插件的浅色值会把内置的深色值盖掉**。症状是"深色模式下主题
 * 突然变回浅色"，且只在配了主题的部署里出现。
 *
 * 所以生成的四段必须**镜像内置结构**（`tokens.css` 的 `.dark` + `prefers-color-scheme`
 * 两条路径），按模式分别钉住：
 * - 显式 `:root.light` / `:root.dark`（`theme.ts` 的 `applyTheme()` 负责写这两个 class）；
 * - 两个 `@media (prefers-color-scheme: …)` 段，各带 `:not(.light):not(.dark)`，
 *   只在**未显式指定**时生效 —— 与内置那条路径逐字对应。
 * 单测里有一条专门钉"浅色覆盖不泄漏进深色"，它就是这条设计的回归守卫。
 *
 * ## 同一 token 多来源：**按当前贡献者集合，注册顺序在前者胜**
 * 与 `markdownExt`（扩展名先到先得）和插槽基数裁决（最早激活者胜出）**同一取向**：
 * 插件激活顺序不由用户控制，若"后到者胜"，一个部署的最终配色会随加载时序漂移，
 * 而没有任何地方能看出是谁盖了谁。先到先得才是可复现、可排障的。
 *
 * 但裁决是**每次求值时现算**的，而不是在注册那一刻一次性判死 —— 因此撤销先注册者后，
 * 同名的后来者会**接管**该 token。这一点**与 `markdownExt` 刻意不同**：后者在注册时就
 * 拒绝了重名（那条贡献压根没进注册表），而这里所有贡献都进注册表，只是在渲染时被压制。
 * 之所以选这个方向：插件 A 卸载后它设的品牌色本就该消失，而**仍然加载着的**插件 B
 * 当初明确要过这个颜色 —— 此时让 B 生效才符合直觉；反过来（永久判死）会让 B 在
 * "A 已卸载"的状态下依然不生效，且没有任何补救途径（只能重载 B）。
 * 单测里有一条专门钉住这个接管语义。
 *
 * ## 注入面 = CSS 注入面
 * token 值是被**拼进样式表**的，所以值的安全字符集是第一道防线：
 * 一个 `;` 就能闭合声明并追加任意规则（`--gw-x:red;}body{display:none}:root{`）。
 * 详见 {@link isSafeTokenValue}。
 */

/**
 * 允许被插件覆盖的 token 名：**只放行 `--gw-`**（理由见文件头）。
 *
 * 刻意要求"前缀 + 至少一段小写字母数字"：`--gw-` 后面什么都没有、或出现大写/下划线，
 * 都不可能是本仓库真实存在的 token（`tokens.css` 的命名是 `--gw-<族>-<档位>`），
 * 与其静默接受一个永远不生效的名字，不如当场拒绝并告警。
 */
const TOKEN_NAME = /^--gw-[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * token 值是否可安全拼进样式表。
 *
 * 拒绝的是"**一条覆盖声明能变成一整段样式表**"的字符与构造：
 * - `;` `{` `}` —— 闭合声明 / 开新规则块（唯一的语法逃逸路径）；
 * - `<` `>` —— 防把样式表当 HTML 处理的环境（历史上出现过这类路径）；
 * - `\` —— CSS 转义能把上面那些字符拼出来（`\3b` 就是 `;`），故一并拒绝；
 * - `/*` 与 `*`+`/` —— 注释可以吞掉后面的规则；
 * - `url(` / `expression(` —— 自定义属性里的 `url()` 在**被使用时**才取资源，
 *   而值是插件可控的；没有理由让一个颜色 token 能指向远端；
 * - 换行/制表符 —— 破坏"值是一行"这一不变量，同样是拼接手段。
 *
 * 长度上限 200：合法的颜色/尺寸值远小于它，超长只可能是构造出来的东西。
 */
export function isSafeTokenValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 200) return false
  if (/[;{}<>\\]/.test(value)) return false
  if (value.includes('/*') || value.includes('*/')) return false
  if (/url\s*\(/i.test(value)) return false
  if (/expression\s*\(/i.test(value)) return false
  if (/[\r\n\t]/.test(value)) return false
  return true
}

/** 一次主题贡献：浅色与深色分别给出要覆盖的 token（两者都可省略） */
export interface ThemeContribution {
  /** **面向人的短名**（管理台 / 排障展示）。缺失时回退到 owner。 */
  readonly name?: string
  readonly light?: Readonly<Record<string, string>>
  readonly dark?: Readonly<Record<string, string>>
}

/** 注册表里的一条贡献（统计口径见 {@link themeContributors}） */
export interface ThemeContributor {
  readonly owner: string
  readonly name: string
  /** 实际生效的 token 数（**不含**被别人先占的） */
  readonly applied: number
  /** 被拒绝/被压制的 token，形如 `--gw-x: 原因`（排障的唯一线索） */
  readonly rejected: readonly string[]
}

interface Entry {
  readonly owner: string
  readonly name: string
  readonly light: ReadonlyMap<string, string>
  readonly dark: ReadonlyMap<string, string>
  readonly rejected: readonly string[]
}

/* ------------------------------ 注册表 ------------------------------ */

/** 注册顺序即优先级：**先注册者对某个 token 胜出**（见文件头） */
const entries: Entry[] = []

/**
 * 环境里有没有 DOM。
 *
 * node 下的单测**没有 DOM**（本仓库不引入 jsdom，与 `markdownExt` 的同类说明一致），
 * 所以"算 CSS"（纯函数）与"把 CSS 放进文档"（DOM）必须是**两件可分开的事**：
 * 前者才是值得单测的部分，后者只在浏览器里跑、且失败也不该让插件注册崩掉。
 */
function hasDom(): boolean {
  return typeof document !== 'undefined' && document.head !== null && document.head !== undefined
}

/** 主题样式表的宿主元素 id（便于在 devtools 里一眼认出是谁注入的） */
export const THEME_STYLE_ID = 'geewiki-plugin-theme'

/**
 * 把当前注册表**整表重建**成 CSS 文本（**纯函数**，可脱离 DOM 单测）。
 *
 * 为什么整表重建而不是增量打补丁：被压制的后来者**会**在先注册者撤销后接管，
 * 所以"谁生效"完全由**当前**注册表决定，增量维护要额外记住一份压制历史、且极易与
 * 实际集合不一致；全量重建每次从注册表求出唯一正确的结果，不存在状态错位的可能。
 * 主题规模是几十条声明，重建成本可忽略。
 *
 * @param source 默认取模块内注册表；显式传入只为单测构造场景。
 */
export function buildThemeCss(source: readonly Entry[] = entries): string {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  // 遍历顺序 = 注册顺序，`if (!has)` 即"先注册者胜"
  for (const e of source) {
    for (const [k, v] of e.light) if (!light.has(k)) light.set(k, v)
    for (const [k, v] of e.dark) if (!dark.has(k)) dark.set(k, v)
  }
  if (light.size === 0 && dark.size === 0) return ''
  const decl = (m: ReadonlyMap<string, string>): string =>
    [...m].map(([k, v]) => `${k}:${v}`).join(';')
  const blocks: string[] = []
  if (light.size > 0) {
    blocks.push(`:root.light{${decl(light)}}`)
    blocks.push(`@media (prefers-color-scheme: light){:root:not(.light):not(.dark){${decl(light)}}}`)
  }
  if (dark.size > 0) {
    blocks.push(`:root.dark{${decl(dark)}}`)
    blocks.push(`@media (prefers-color-scheme: dark){:root:not(.light):not(.dark){${decl(dark)}}}`)
  }
  return blocks.join('')
}

/** 把当前 CSS 同步进文档（无 DOM 时静默跳过——node 单测走的就是这条路） */
function syncDocument(): void {
  if (!hasDom()) return
  const css = buildThemeCss()
  let el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (css === '') {
    // 没有贡献者时**移除**元素而不是留一个空标签：留空标签会让 devtools 里看不出
    // "主题到底有没有在起作用"，也会让"插件卸载了但样式还在"变得难以判断。
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = THEME_STYLE_ID
    /*
     * 必须**追加到 head 末尾**：与内置样式表同特异性时靠"后者胜"取胜。
     * 若插到前面，整套覆盖会静默失效（深色那段的表现会是"只有深色生效了"——
     * 一个很难反推的形态）。
     */
    document.head.appendChild(el)
  }
  el.textContent = css
}

/**
 * 贡献一组主题 token。
 *
 * @returns 撤销函数。**幂等**：重复调用只有第一次生效。
 *   owner 整体卸载请用 {@link unregisterThemes}。
 *
 * 形态非法（owner 空 / 不是对象 / 两个模式都没给出可用 token）**整条拒绝**并告警 ——
 * 部分接受会让作者拿到"一半生效了"的错觉。
 * **单个 token** 非法则只丢弃那一条，其余照常生效（并计入 {@link ThemeContributor.rejected}）：
 * token 之间彼此独立，这里没有"要么全对要么全错"的理由。
 */
export function registerTheme(owner: string, contribution: ThemeContribution): () => void {
  if (typeof owner !== 'string' || owner === '') {
    console.warn('[geewiki-theme] registerTheme 需要一个非空的 owner，已忽略')
    return () => {}
  }
  if (typeof contribution !== 'object' || contribution === null) {
    console.warn(`[geewiki-theme] ${owner} 传来的主题形态不合法（应为对象），已忽略`)
    return () => {}
  }
  const rejected: string[] = []
  const collect = (
    raw: Readonly<Record<string, string>> | undefined,
    mode: string,
  ): ReadonlyMap<string, string> => {
    const out = new Map<string, string>()
    if (raw === undefined) return out
    if (typeof raw !== 'object' || raw === null) {
      rejected.push(`${mode}: 应为对象`)
      return out
    }
    for (const [k, v] of Object.entries(raw)) {
      if (!TOKEN_NAME.test(k)) {
        rejected.push(`${k}: token 名非法（只允许 --gw-<小写字母数字段>）`)
        continue
      }
      if (!isSafeTokenValue(v)) {
        rejected.push(`${k}: 值非法（含危险字符或超长）`)
        continue
      }
      out.set(k, v)
    }
    return out
  }
  const light = collect(contribution.light, 'light')
  const dark = collect(contribution.dark, 'dark')
  if (light.size === 0 && dark.size === 0) {
    console.warn(
      `[geewiki-theme] ${owner} 的主题贡献没有任何可用的 token，已忽略` +
        (rejected.length > 0 ? `（全部被拒：${rejected.join('；')}）` : ''),
    )
    return () => {}
  }
  const entry: Entry = {
    owner,
    name: typeof contribution.name === 'string' && contribution.name !== '' ? contribution.name : owner,
    light,
    dark,
    rejected,
  }
  entries.push(entry)
  if (rejected.length > 0) {
    console.warn(`[geewiki-theme] ${owner} 的部分主题 token 被拒绝：${rejected.join('；')}`)
  }
  syncDocument()
  let undone = false
  return () => {
    if (undone) return
    undone = true
    const at = entries.indexOf(entry)
    if (at < 0) return
    entries.splice(at, 1)
    syncDocument()
  }
}

/** 撤销某个 owner 贡献的全部主题（插件 UI 卸载时调用） */
export function unregisterThemes(owner: string): void {
  let removed = false
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.owner === owner) {
      entries.splice(i, 1)
      removed = true
    }
  }
  if (removed) syncDocument()
}

/**
 * 当前贡献者清单（诊断）。
 *
 * 与 `markdownExtensions()` 同理：必须能区分"我注册的主题为什么没生效"与
 * "别人先占了同一个 token"——否则唯一的线索就只是"颜色不对"。
 */
export function themeContributors(): readonly ThemeContributor[] {
  const won = new Map<string, string>()
  const out: ThemeContributor[] = []
  for (const e of entries) {
    const rejected = [...e.rejected]
    let applied = 0
    for (const k of [...e.light.keys(), ...e.dark.keys()]) {
      const holder = won.get(k)
      if (holder === undefined) {
        won.set(k, e.owner)
        applied += 1
      } else if (holder !== e.owner) {
        rejected.push(`${k}: 已被 ${holder} 先占（先注册者胜）`)
      }
    }
    out.push({ owner: e.owner, name: e.name, applied, rejected })
  }
  return out
}

/** 当前**生效**的 token 值（浅/深各一份），供排障与单测断言 */
export function themeTokens(): { light: Record<string, string>; dark: Record<string, string> } {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const e of entries) {
    for (const [k, v] of e.light) if (!(k in light)) light[k] = v
    for (const [k, v] of e.dark) if (!(k in dark)) dark[k] = v
  }
  return { light, dark }
}

/** 仅测试用：清空注册表（避免用例间串味） */
export function __resetThemesForTest(): void {
  entries.length = 0
  syncDocument()
}
