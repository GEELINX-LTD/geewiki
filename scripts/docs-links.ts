/**
 * docs:links —— 全仓 Markdown 的「相对链接 / 锚点」存活检查（**阻断式**门禁）
 *
 * 为什么要有它：文档是本仓的唯一真源（见 docs/README.md 的「文档纪律」），而
 * 「链接指向一个不存在的文件 / 一个不存在的标题」是文档最容易产生、又最容易
 * 被读者当成谎言之类腐化。人眼扫不出来，机器一眼就能扫出来 —— 所以进 CI。
 *
 * ── 三条贯穿全文件的设计取舍 ─────────────────────────────────────────────
 * 1) **误报比漏报更坏**。一条误报的代价不是「多改一行」，而是「作者把门禁
 *    降成 warning，从此所有人都当它不存在」。因此凡是 GitHub 的 slug 规则
 *    我没把握的标题（含反引号、括号、emoji、全角标点……），一律**放弃校验
 *    指向它的锚点**，并在末尾输出跳过计数，让覆盖率是透明的而不是假的。
 * 2) **只校验机器可无歧义判定的链接**：inline 链接 `[](目标)`、图片 `![](目标)`、
 *    以及引用式链接的**定义行** `[id]: 目标`。不校验 `[P3]`、`[API]` 这类隐式
 *    引用 —— 本仓文档里大量方括号是普通文本（阶段名、判据编号），校验它必误报。
 * 3) **代码块 / 行内代码 / HTML 注释内不校验**：文档会在 bash 示例、diff、报错栈、
 *    JSON 片段里写路径，那不是给人点的链接（行内代码里的链接只校验目标、
 *    标签文本里的反引号先剥掉，所以 [`docs/x.md`](docs/x.md) 仍然正常校验）。
 *
 * ── 一条必须写下来的实测结论 ─────────────────────────────────────────────
 * **以 `/` 开头的目标一律跳过**：本仓文档里 `](/api/attachments/42)`、
 * `](/guide/features)` 是**运行时 URL**（内置文档正文与 docs/design/*.md 都有实例，
 * 如 docs/design/attachments.md 与 packages/plugin-builtin-docs/content/guide/markdown-demo.md），
 * 不是「仓库根相对路径」。把它们当文件路径查会一次性造出几十条误报。
 *
 * 用法：
 *   pnpm run docs:links                     # 扫仓库根
 *   pnpm run docs:links -- --root <目录>     # 扫指定目录（调试 / 只跑子树）
 *   pnpm run docs:links -- --no-anchors     # 只查文件存活，不查锚点（**仅排障用**，别进 CI）
 *   pnpm run docs:links -- --all            # 连内置文档正文一起扫（默认排除，见 EXCLUDE_DIR_NAMES 注释）
 *
 * 退出码：0 = 无死链；1 = 有死链（清单打到 stdout）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

// ────────────────────────────── 语料范围 ──────────────────────────────

/**
 * 跳过的目录名。每一条都是**产物或本机状态**，扫它们只会产生与提交无关的噪音。
 * 依据：.gitignore、eslint.config.js 的 ignores、docs/ci-cd.md 的 pnpm store 章节。
 */
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist', // vite/tsc 产物（含 packages/web/fixtures/dist）
  'coverage',
  '.vite',
  '.cache',
  'tmp', // 运行时会话/上传中转（docs/development.md §1）
  'data', // SQLite 库等本机状态
  'logs',
  '.npm-cache',
  '.pnpm-store',
  '.pnpm-cache', // pnpm 本地 store：里面是全量第三方包的 README，绝不该进门禁
  '.pi', // 本地 agent 工作目录，未入库
  'fixtures-dist',
])

/**
 * 按相对路径前缀排除的目录。
 *
 * `packages/plugin-builtin-docs/content/` 是**发布给用户看的 wiki 正文**，不是工程文档：
 * 它内部的相对链接由 wiki 在运行时按 slug 解析（`[首页](home)` 指向的是页面 slug
 * `home`，磁盘上并不存在 `home.md`）。按文件存活去查会把整篇演示文档判成死链。
 * 需要连它一起查时显式加 `--all`。
 */
const EXCLUDE_PATH_PREFIXES = ['packages/plugin-builtin-docs/content/']

/** 只在这些扩展名里做链接检查。 */
const MD_EXT = new Set(['.md', '.markdown'])

// ────────────────────────────── 工具函数 ──────────────────────────────

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

/** 仓库根：优先向上找 pnpm-workspace.yaml（工作区根的标记），退化到脚本所在仓库。 */
function findRepoRoot(explicit: string | undefined): string {
  if (explicit) return resolve(explicit)
  let dir = process.cwd()
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return process.cwd()
}

function walkMd(root: string, skipContentDir: boolean): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 读不了的目录（权限/竞态）不算失败，静默略过
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      const rel = toPosix(relative(root, abs))
      if (ent.isDirectory()) {
        if (EXCLUDE_DIR_NAMES.has(ent.name)) continue
        if (/^\.wt-/.test(ent.name)) continue // 仓内 worktree（docs/development.md §1 的约定）
        if (skipContentDir && EXCLUDE_PATH_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue
        stack.push(abs)
      } else if (ent.isFile()) {
        const dot = ent.name.lastIndexOf('.')
        if (dot < 0) continue
        if (!MD_EXT.has(ent.name.slice(dot).toLowerCase())) continue
        if (skipContentDir && EXCLUDE_PATH_PREFIXES.some((p) => rel.startsWith(p))) continue
        out.push(abs)
      }
    }
  }
  return out.sort()
}

function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// ─────────────────────────── 锚点（GitHub slug） ───────────────────────────
//
// GitHub 的规则（实证部分）：标题文本 → 小写 → 删除标点 → 空白转 `-`；
// 重复 slug 依次追加 `-1`、`-2`。中文**不是**标点，会原样保留（`## 1. 环境准备`
// → `#1-环境准备`）。
//
// 但「哪些字符算标点」的完整集合我没有权威来源（github-slugger 内部是一张
// 很长的 unicode 区间表），所以这里按「有把握 / 没把握」分治：
//   · 标题只由 ASCII 字母数字、空格、`-`、`_`、`.`（会被删）与中日韩表意文字组成
//     → 判定为**有把握**，锚点必须命中，否则报错。
//   · 含其它字符（反引号、半角/全角括号、`：`、`（）`、emoji、`+`、`/`、引号……）
//     → 判定为**没把握**：只有当待查锚点与该标题的「松散形态」（只留字母数字）
//     对上时才跳过，否则仍然报错。这样「本文件里根本没有这个标题」依然能被抓住，
//     放过的是「有这个标题但我不确定 slug 长什么样」。

/**
 * 允许出现在「有把握」标题里的非 ASCII 字符：**只有中日韩表意文字**。
 * 刻意不含全角标点（U+FF00–U+FFEF，里面有 `（）`）、不含假名、不含 emoji、
 * 不含 CJK 符号表（U+3000–U+303F）—— 这些 GitHub 怎么处理我没有权威来源，
 * 一律归入「没把握」，代价只是少校验一个锚点，而不是误报。
 */
const CJK_IDEO = /[㐀-䶿一-鿿豈-﫿]/u

/** 判定为「有把握」时允许的字符（小写后）。`.` 允许出现但最终会被删掉。 */
const CONFIDENT_CHAR = /^[a-z0-9 _.-]$/u

interface HeadingInfo {
  /** 已按 GitHub 规则去重（追加 -1/-2）后的 slug 集合，仅含「有把握」的标题 */
  confident: Set<string>
  /** 「没把握」标题的松散形态集合，用于决定某个未命中锚点是跳过还是报错 */
  loose: Set<string>
}

function stripInlineMd(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1') // 行内代码：GitHub 取文本、丢反引号
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 标题里的链接：取链接文字
    .replace(/\*\*|__|~~|\*|!/g, '') // 强调/删除线标记字符会被丢掉
    .replace(/\s*\{#[^}]*\}\s*$/u, '') // remark 自定义 id：另存为锚点，正文里去掉
    .trim()
}

function looseForm(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

/** 返回 { slug, confident }：slug 是尽量贴近 GitHub 的结果，confident 表示是否可用来报错。 */
function slugOf(rawText: string): { slug: string; confident: boolean } {
  const text = stripInlineMd(rawText)
  const lower = text.toLowerCase()
  let confident = true
  for (const ch of lower) {
    if (CONFIDENT_CHAR.test(ch)) continue
    if (CJK_IDEO.test(ch)) continue
    confident = false
    break
  }
  const slug = lower
    .replace(/\./g, '') // 句点被删除：`## 1. 环境准备` → `1-环境准备`
    .replace(/\s+/g, '-') // 空白 → 连字符
    .replace(/[^a-z0-9_\-\p{L}\p{N}]/gu, '') // 其余符号删除（含全角标点）
  return { slug, confident }
}

/** 收集一个 markdown 文件里所有可用锚点。 */
function collectAnchors(absPath: string): HeadingInfo | null {
  let text: string
  try {
    text = readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
  const confident = new Set<string>()
  const loose = new Set<string>()
  const seen = new Map<string, number>()
  let inFence = false
  let inHtmlComment = false

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false
      continue
    }
    if (/^\s*<!--(?!!)/.test(line) && !line.includes('-->')) {
      inHtmlComment = true
      continue
    }

    // 1) 显式 HTML 锚点：<a id="x"> / <a name="x"> —— 这是精确匹配，算有把握
    for (const m of line.matchAll(/<a\s[^>]*?(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      const id = m[1]
      if (id) confident.add(id)
    }

    // 2) ATX 标题
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
    if (!h) continue
    const raw = h[2] ?? ''
    // 自定义 id：`## 标题 {#custom}` —— remark 风格，GitHub 不认，但不少工具链认，
    // 一律当**合法锚点**收下（多收下只会少报错，符合「不误报」优先级）
    const custom = /\{#([^}]+)\}\s*$/u.exec(raw)
    if (custom?.[1]) confident.add(custom[1].trim())
    const { slug, confident: sure } = slugOf(raw)
    if (!slug) continue
    // GitHub 对重复标题追加 -1 / -2
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    const final = n === 0 ? slug : `${slug}-${n}`
    if (sure) confident.add(final)
    else loose.add(looseForm(raw))
  }
  return { confident, loose }
}

// ─────────────────────────── 链接提取 ───────────────────────────

interface FoundLink {
  file: string
  line: number
  target: string
}

function extractLinks(absPath: string, root: string): FoundLink[] {
  const raw = readFileSync(absPath, 'utf8')
  const out: FoundLink[] = []
  let inFence = false
  let inHtmlComment = false
  const rel = toPosix(relative(root, absPath))
  let lineNo = 0

  for (const line of raw.split(/\r?\n/)) {
    lineNo++
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false
      continue
    }
    if (/^\s*<!--(?!!)/.test(line) && !line.includes('-->')) {
      inHtmlComment = true
      continue
    }

    // 行内代码整体剥掉（示例里的假链接），但 [x] 的空标签仍保留，
    // 于是 [`docs/x.md`](docs/x.md) 的目标照旧能被检查。
    // 行内代码**整段剥掉**（只剥反引号会把 `` `![名](url)` `` 这种语法示例
    // 变成真链接 —— docs/design/attachments.md 实测会误报 5 处）。
    // 副作用是 [`docs/x.md`](docs/x.md) 退化成 [](docs/x.md)，目标照旧被检（空标签已允许）。
    const scannable = line.replace(/<!--[\s\S]*?-->/g, '').replace(/`+[^`]*`+/g, ' ')

    // inline 链接与图片：标签允许一层嵌套方括号
    // 注意 JS 字符类的写法：[^][] 在 JS 里是 [^] + [] 两个类（不是“不含方括号”），
    // 所以这里必须写成 [^\]]（类里的 ] 需要转义，[ 不需要）。
    const linkRe = /!?\[(?:[^\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]*)/g
    for (const m of scannable.matchAll(linkRe)) {
      let target = m[1] ?? ''
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
      if (target) out.push({ file: rel, line: lineNo, target })
    }

    // 引用式链接的定义行：`[id]: 目标 "标题"` —— 目标无论有没有被用到都该存在
    const def = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(scannable)
    if (def?.[1]) {
      let target = def[1]
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
      out.push({ file: rel, line: lineNo, target })
    }
  }
  return out
}

// ─────────────────────────── 判定 ───────────────────────────

interface Problem {
  kind: 'missing-file' | 'missing-anchor'
  file: string
  line: number
  target: string
  note: string
}

const anchorCache = new Map<string, HeadingInfo | null>()

function anchorsOf(absPath: string): HeadingInfo | null {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath) ?? null
  const info = collectAnchors(absPath)
  anchorCache.set(absPath, info)
  return info
}

/** 目标是否「不是文件链接」——URL / 运行时路径 / 占位符等，一律跳过。 */
function shouldSkipTarget(target: string): boolean {
  if (!target) return true
  if (target.startsWith('#')) return false // 同文件锚点
  if (target.startsWith('//')) return true // 协议相对 URL
  if (target.startsWith('/')) return true // 运行时 URL（见文件头「实测结论」）
  if (target.startsWith('\\')) return true
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return true // http:/mailto:/data:/…
  if (target.includes('<') || target.includes('>')) return true // 占位符如 /api/attachments/<id>
  if (target.includes('?')) return true // 带 query 的目标形态不定，不赌
  if (/^www\./i.test(target)) return true
  return false
}

function checkTarget(link: FoundLink, root: string, checkAnchors: boolean): Problem | null {
  const abs = join(root, link.file)
  const target = link.target
  const hashAt = target.indexOf('#')
  const filePart = hashAt >= 0 ? target.slice(0, hashAt) : target
  const frag = hashAt >= 0 ? target.slice(hashAt + 1) : ''

  // 只有锚点的链接（`#章节`）：查本文件
  if (filePart === '') {
    if (!checkAnchors || !frag) return null
    const info = anchorsOf(abs)
    if (!info) return null
    const want = decodeMaybe(frag)
    if (info.confident.has(want)) return null
    if (info.loose.has(looseForm(want))) return null // 可能是「没把握」的那个标题，放过
    return {
      kind: 'missing-anchor',
      file: link.file,
      line: link.line,
      target,
      note: `本文件内没有匹配 ` + '`#' + frag + '`' + ' 的标题',
    }
  }

  const decoded = decodeMaybe(filePart)
  const absTarget = isAbsolute(decoded) ? resolve(decoded) : resolve(dirname(abs), decoded)

  if (!existsSync(absTarget)) {
    return {
      kind: 'missing-file',
      file: link.file,
      line: link.line,
      target,
      note: `目标不存在：${toPosix(relative(root, absTarget))}`,
    }
  }

  if (!frag || !checkAnchors) return null
  let st
  try {
    st = statSync(absTarget)
  } catch {
    return null
  }
  if (!st.isFile()) return null // 目录不带锚点语义
  const dot = absTarget.lastIndexOf('.')
  if (dot < 0 || !MD_EXT.has(absTarget.slice(dot).toLowerCase())) return null // 非 md 不查锚点
  const info = anchorsOf(absTarget)
  if (!info) return null
  const want = decodeMaybe(frag)
  if (info.confident.has(want)) return null
  if (info.loose.has(looseForm(want))) return null
  return {
    kind: 'missing-anchor',
    file: link.file,
    line: link.line,
    target,
    note: `${toPosix(relative(root, absTarget))} 里没有匹配 ` + '`#' + frag + '`' + ' 的标题',
  }
}

// ─────────────────────────── main ───────────────────────────

function parseArgs(argv: string[]): { root?: string; anchors: boolean; all: boolean; help: boolean } {
  const opts = { anchors: true, all: false, help: false } as { root?: string; anchors: boolean; all: boolean; help: boolean }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opts.root = argv[++i]
    else if (a?.startsWith('--root=')) opts.root = a.slice(7)
    else if (a === '--no-anchors') opts.anchors = false
    else if (a === '--all') opts.all = true
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('用法：pnpm run docs:links -- [--root <目录>] [--no-anchors] [--all]')
    return 0
  }
  const root = findRepoRoot(opts.root)
  const files = walkMd(root, !opts.all)
  if (files.length === 0) {
    console.error(`docs:links：在 ${root} 下没找到任何 markdown —— 检查 --root 是否写错`)
    return 1
  }

  const problems: Problem[] = []
  let links = 0
  let skippedRuntimePaths = 0
  for (const abs of files) {
    for (const link of extractLinks(abs, root)) {
      if (shouldSkipTarget(link.target)) {
        skippedRuntimePaths++
        continue
      }
      links++
      const problem = checkTarget(link, root, opts.anchors)
      if (problem) problems.push(problem)
    }
  }

  console.log(`docs:links —— 扫描 ${files.length} 个 markdown 文件，检查 ${links} 个站内链接目标`)
  if (skippedRuntimePaths > 0) {
    console.log(`  （跳过 ${skippedRuntimePaths} 个非文件目标：URL、以 / 开头的运行时路径、占位符）`)
  }
  if (!opts.anchors) console.log('  ⚠ 已按 --no-anchors 跳过锚点校验（仅排障用，不得进 CI）')

  if (problems.length === 0) {
    console.log('  ✅ 无死链')
    return 0
  }

  const byFile = new Map<string, Problem[]>()
  for (const p of problems) {
    const list = byFile.get(p.file) ?? []
    list.push(p)
    byFile.set(p.file, list)
  }
  console.log(`  ❌ ${problems.length} 处失效（${byFile.size} 个文件）：`)
  for (const [file, list] of byFile) {
    console.log(`\n${file}`)
    for (const p of list) {
      const tag = p.kind === 'missing-file' ? '死链' : '锚点失效'
      console.log(`  ${String(p.line).padStart(4)}: [${tag}] ${p.target}`)
      console.log(`         ↳ ${p.note}`)
    }
  }
  console.log('')
  console.log('修法：改链接或补标题。确需新增目标文件就把它写出来；')
  console.log('      若确信是检查器误报，请把该标题改成只含字母数字与中文的形态（不要降低门禁强度）。')
  return 1
}

process.exit(main())
