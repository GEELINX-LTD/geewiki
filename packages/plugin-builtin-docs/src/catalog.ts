/**
 * 内置文档的**目录与正文装载**（正文在 `content/<slug>.md`，这里只登记 slug/标题/顺序）。
 *
 * ★ 改任何一篇的正文/标题/slug 集合，必须同时 bump `types.ts` 的 `DOCS_VERSION`，
 * 否则已部署的库永远不会拿到新内容（同步引擎比对的是版本戳，不是内容）。
 *
 * ## 为什么正文是 `.md` 文件而不是 TS 模板字符串
 *
 * 正文是 Markdown，而本包正文里**大量出现反引号、`${...}`、反斜杠**（例如"表格里的 `|`
 * 要写成 `\|`"这类必须逐字展示的语法）。写在模板字符串里，每一处都要转义成
 * `` \` `` / `\${` / `\\` —— 抄错一个反引号就是一次构建失败，而"源码 ↔ 效果"对照页
 * 恰恰是反引号最密集的文档。真实文件还带来两个直接好处：编辑器有 Markdown 高亮、
 * diff 只显示改了哪一句（模板字符串里改一行常常显示为整段重写）。
 *
 * 目录解析与 `migrations` 同款（见 `index.ts` 的 `DOCS_MIGRATIONS_DIR`）：
 * 相对**本文件所在目录**取 `../content`，因此源码运行（`exports` 指向 `src/index.ts`）
 * 与将来若有的编译产物运行都落在包根的 `content/`。
 *
 * 内容纪律（`content.test.ts` 逐条校验，不只看字数）：
 *   - 只写**这个仓库真实存在**的行为。写了做不到的事，文档就成了反模式；
 *   - slug 必须合法、gated 标记必须可解析（不闭合/未知档位直接红）；
 *   - wikilink 目标必须是目录内页面或 `example/` 前缀（红链演示），且**不带 `#` 锚点**；
 *   - 前端渲染是 marked(gfm+breaks) → DOMPurify：没有 mermaid / KaTeX / 代码高亮，
 *     演示里出现它们只会得到纯文本代码块——所以只作为"不支持清单"出现。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuiltinDoc } from './types.js'

/** 正文目录：`content/<slug>.md`（slug 里的 `/` 就是子目录） */
export const DOCS_CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'content')

/** 目录登记表：顺序即"目录构成"测试与同步日志的顺序 */
const ENTRIES: readonly { slug: string; title: string }[] = [
  { slug: 'home', title: '欢迎使用 GeeWiki' },
  { slug: 'guide/architecture', title: '架构' },
  { slug: 'guide/features', title: '功能介绍' },
  { slug: 'guide/markdown-demo', title: 'Markdown 语法参考' },
  { slug: 'guide/special-structures', title: '特殊结构' },
]

/**
 * 装载正文。
 *
 * 读文件失败**直接抛**（不要让装载变成"某几篇悄悄消失"——那正是 README 里
 * 反复记档的静默失败形态）：插件激活时抛错会走 `syncDocs` 的 try/catch，
 * 表现为"文档同步失败，下次启动重试"，且**不盖版本戳** ⇒ 可修复、可重试、可观测。
 */
export const BUILTIN_DOCS: readonly BuiltinDoc[] = ENTRIES.map(({ slug, title }) => {
  const file = join(DOCS_CONTENT_DIR, `${slug}.md`)
  try {
    return { slug, title, content: readFileSync(file, 'utf8') }
  } catch (err) {
    throw new Error(`内置文档正文读取失败: ${file}（${(err as Error).message}）`, { cause: err })
  }
})
