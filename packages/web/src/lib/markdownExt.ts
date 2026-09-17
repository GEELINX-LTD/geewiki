/**
 * ★ F8：**Markdown 渲染扩展注册表**。
 *
 * ## 这个文件解决什么
 * 审计 §2 C2：Markdown 渲染管线此前**没有任何扩展点**。插件想渲染 ` ```mermaid `
 * 或自定义块语法，唯一办法是 import `marked` 单例然后 `marked.use(...)` —— 各写各的，
 * 且写进去就**收不回来**。
 *
 * ## 为什么不用全局 `marked.use()`（这是本文件存在的技术理由）
 * `marked.use()` 是**只增不减**的：它把扩展 push 进单例，marked 没有 `unuse`。
 * 后果在实际使用中是这样的：
 * - 插件 UI 产物更新后整页刷新，模块重新求值，**同一扩展被再注册一次**；
 * - 热重载/重复 import 同理。
 *
 * 扩展重复注册**不会报错**，只会让 tokenizer 被调用多次、renderer 被套娃 ——
 * 症状是"用久了渲染越来越怪"，而且**没有任何日志**。这与仓库其它注册表
 * （插槽/路由/能力）面对的是同一个问题，故用同一种解法：
 * **保留自己的注册表，按版本重建一个独立的 `Marked` 实例**，而不是改全局单例。
 * 于是撤销是真的撤销（重建成原样），而不是"再叠一层抵消"。
 *
 * ## 安全边界（**最重要的一条，改动时不要破坏**）
 * 扩展产出的仍是**字符串 HTML**，它**照旧**要经过 `sanitize.ts` 的 DOMPurify 才能落地。
 * 本注册表**不提供任何绕过消毒的路径**：`activeMarked()` 只负责"用哪些 marked 扩展去
 * 生成 HTML"，生成之后的消毒一步没变。这一点由
 * `packages/web/test/markdownExt.test.ts` 的用例钉住（扩展注入 `<script>`/`onerror`
 * 必须被消毒掉）—— 因为"给插件开放 HTML 生成"最容易的翻车方式就是把这条链断掉。
 *
 * 同一条边界也解释了为什么这里**只允许贡献 marked 扩展**、不允许贡献
 * "已渲染好的 HTML"：后者会让插件绕过全部后处理（链接改写、附件标注、标题锚点）。
 */
import { Marked, type MarkedExtension } from 'marked'

/** 插件贡献的一个 Markdown 扩展 */
export interface MarkdownExtension {
  /**
   * 扩展名（**全局唯一**，小写 kebab）。
   *
   * 冲突时**先注册者胜出**（与插槽/路由/能力的裁决同向）：后来者被告警并忽略。
   * 静默顶替比拒绝更糟 —— 症状是"我启用的插件渲染器变成了另一个插件的"，且无从查起。
   */
  readonly name: string
  /** 交给 marked 的扩展对象（`extensions` / `renderer` / `tokenizer` / `hooks` 的任意子集） */
  readonly marked: MarkedExtension
}

interface Registered {
  readonly owner: string
  readonly ext: MarkdownExtension
}

/** 扩展名 → 注册项。`Map` 保持插入顺序，故渲染顺序 = 注册顺序（可预期） */
const registry = new Map<string, Registered>()

/**
 * 注册表版本号：每次生效的注册/撤销都 +1。
 *
 * `activeMarked()` 据此判断缓存是否失效。**只有真正改变了集合才 +1** ——
 * 被拒绝的重复注册不该让缓存失效（否则一个写错的插件会让我们每帧重建 Marked）。
 */
let version = 0

let cached: Marked | undefined
let cachedFor = -1

/**
 * 当前生效的扩展（诊断用）。返回顺序稳定：注册顺序。
 *
 * 暴露它是为了排障："我注册的渲染器为什么没生效" 与 "别人先占了同名扩展"
 * 必须能区分开 —— 这正是"静默顶替"要避免的那件事。
 */
export function markdownExtensions(): readonly { owner: string; name: string }[] {
  return [...registry.values()].map((r) => ({ owner: r.owner, name: r.ext.name }))
}

/** 当前注册表版本号（每次生效变更 +1） */
export function markdownRegistryVersion(): number {
  return version
}

/**
 * 注册一个 Markdown 扩展。
 *
 * @returns 撤销函数。**幂等**：重复调用只有第一次生效。
 *   owner 整体卸载时请用 {@link unregisterMarkdownExtensions}。
 */
export function registerMarkdownExtension(owner: string, ext: MarkdownExtension): () => void {
  if (typeof ext?.name !== 'string' || ext.name === '' || typeof ext.marked !== 'object' || ext.marked === null) {
    console.warn(`[geewiki-md] ${owner} 传来的 Markdown 扩展形态不合法（缺 name 或 marked），已忽略`)
    return () => {}
  }
  const existing = registry.get(ext.name)
  if (existing) {
    console.warn(
      `[geewiki-md] Markdown 扩展名 ${JSON.stringify(ext.name)} 已被 ${existing.owner} 注册，` +
        `忽略 ${owner} 的重复注册（先注册者生效）。扩展名须全局唯一。`,
    )
    return () => {}
  }
  registry.set(ext.name, { owner, ext })
  version += 1
  let undone = false
  return () => {
    if (undone) return
    undone = true
    // 只有"当前这条仍是自己的"才撤销：先注册者被卸载后，后来者并未接管（它当时被拒了），
    // 所以这里判 owner 是为了防止"卸载 A 却删掉了 B 后来补上的同名扩展"。
    if (registry.get(ext.name)?.owner !== owner) return
    registry.delete(ext.name)
    version += 1
  }
}

/**
 * 撤销一个 owner 注册的**全部**扩展（插件卸载/热更新时调用）。
 *
 * 没有它就等于把"插件能注册渲染器"变成一次性的：插件产物更新后旧扩展仍在，
 * 新的又注册不进来（同名冲突），表现是"改了代码没反应"。
 */
export function unregisterMarkdownExtensions(owner: string): void {
  for (const [name, r] of [...registry.entries()]) {
    if (r.owner === owner) {
      registry.delete(name)
      version += 1
    }
  }
}

/**
 * 取**当前装配好**的 `Marked` 实例（按版本缓存）。
 *
 * 基础选项与改造前 `mdToHtml` 里逐字一致（`gfm` + `breaks`）—— 本次改造只换
 * "扩展从哪来"，不换渲染语义。`async: false` 在 `parse()` 调用处给出，
 * 因为它是**调用期**选项而非实例配置。
 */
export function activeMarked(): Marked {
  if (cached !== undefined && cachedFor === version) return cached
  const instance = new Marked({ gfm: true, breaks: true })
  for (const { ext } of registry.values()) instance.use(ext.marked)
  cached = instance
  cachedFor = version
  return instance
}

/**
 * 便捷形态：为某个**围栏语言**注册渲染器（插件最常见的需求）。
 *
 * ```ts
 * host.registerMarkdownExtension({ name: 'fence-mermaid',
 *   marked: fenceExtension('mermaid', (code) => `<div class="mermaid">…</div>`).marked })
 * ```
 *
 * 用 marked 的 `renderer.code` 覆盖 + **返回 `false` 表示落回默认渲染**：
 * 只有语言匹配时接管，其余代码块行为一字不变（这是"不接管非本语言围栏"的关键，
 * 否则一个插件会悄悄改掉所有代码块的输出）。
 *
 * ⚠️ 产出仍是 HTML 字符串，**照旧经 DOMPurify 消毒**（见文件头）。
 */
export function fenceExtension(
  lang: string,
  render: (code: string, info: string) => string,
): MarkdownExtension {
  const target = lang.trim().toLowerCase()
  return {
    name: `fence-${target}`,
    marked: {
      renderer: {
        code(token) {
          // marked 的围栏 info 形如 "mermaid title=foo"；只取第一段比对语言
          const info = token.lang ?? ''
          const first = info.trim().split(/\s+/)[0]?.toLowerCase()
          if (first !== target) return false
          return render(token.text, info)
        },
      },
    },
  }
}
