/**
 * docs:conventions —— 文档写作纪律的机器检查（**只报告，不阻断**）
 *
 * 为什么不阻断：三条规则里 R1/R2 判的是「应该改成什么」而不是「坏了」，且存量违规
 * 很多（集中在 docs/design/ 与 docs/changelog/ 的历史文档里，成片的 `路径.ts:123`）。把它们做成
 * 阻断门禁 = 这个门禁永远绿不了 = 永远没人看。所以默认 exit 0，违规清单进 CI 日志；
 * 想按规则收紧时用 `--fail-on R3` 这种**逐条**开关（R1 已为 0、可直接收紧；R3 只有在运行环境注入了
 * `GEEWIKI_FORBIDDEN_ENDPOINTS` 时才可能产出命中，默认空数组 → 恒 0，CI 要不要收紧取决于是否注入该变量）。
 *
 * 规则（与 docs/README.md「文档纪律」、docs/development.md §5 同源，这里只是把它编译成检查）：
 *
 *  R1  每个 docs 目录下的 .md 必须被 `docs/README.md` 按路径引用。
 *      真源表纪律第 6 条的反面：新增文档不进索引，等于没写。
 *      允许「目录级索引」覆盖：`docs/adr/README.md` 存在时，它引用的同目录文件算已覆盖
 *      （否则 ADR 攒到 20 篇后这条规则只剩噪音）。
 *
 *  R2  不允许「路径 + 行号」引用（`packages/x/src/index.ts:262`、`:413-422`、`` `:414` ``）。
 *      行号必腐：docs/plugin-platform.md 里的行号引用在改动后已对不上，
 *      而 CONTRIBUTING/README 的纪律都写着「引用代码用**路径 + 符号名**」。
 *      代码块内不检查：那是报错栈、日志、diff 的引用现场，不是给读者跳代码的链接。
 *
 *  R3  不允许出现私有端点字面量。待禁字面量**不写在本文件里**，由环境变量
 *      `GEEWIKI_FORBIDDEN_ENDPOINTS` 提供（逗号分隔；未设置则为空数组，本规则自动空跑）。
 *      为什么搬到环境变量：这条门禁防的正是「私有端点字面量进 git」，而把待禁字面量硬编码在
 *      源码里，等于让门禁自身成为泄漏点——历史上就漏过一次，代价是整条历史被迫改写。
 *      出厂示例必须是占位符（`https://api.example.com/v1`）。历史上私有端点泄进过
 *      `config/plugins.base.example.json`（那条在整改台账里单独跟），文档示例同理。
 *      这里刻意用**字面量数组**而不是正则：正则写错会静默失效，字面量漏了看得见。
 *      注：R3 只扫 markdown；非 .md 的落点由台账跟，避免一个检查器管两类事实。
 *
 * 退出码：默认恒 0（除非 --fail-on 命中的规则确有违规）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.vite',
  '.cache',
  'tmp',
  'data',
  'logs',
  '.npm-cache',
  '.pnpm-store',
  '.pnpm-cache',
  '.pi',
])

/** 私有端点字面量（R3）。从环境变量 GEEWIKI_FORBIDDEN_ENDPOINTS 读取（逗号分隔）；
 *  该变量不入库，真实端点字面量因此永远不会进 git。未设置时为空数组。 */
const FORBIDDEN_LITERALS = (process.env.GEEWIKI_FORBIDDEN_ENDPOINTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** R2 允许的文件扩展名集合：只有这些扩展名后面的 `:数字` 才算行号引用。 */
const CODE_EXT = 'ts|tsx|js|mjs|cjs|jsx|json|sql|sh|bash|py|css|scss|less|html|vue|yml|yaml|toml|md|go|rs|java|kt'

/** 反引号在模板字面量里会提前结束字面量（本仓的坑：tsconfig.scripts.json 注释里记过同类事故），
 *  所以正则里的反引号一律用 \u0060 转义写。 */
/** `packages/x/src/index.ts:262` / `docs/x.md:12-15` */
const RE_PATH_LINE = new RegExp(
  '(^|[\\s(\\[\uff08\u300c\\u0060>])((?:[\\w.@\\-]+\\/)+[\\w.@\\-]+\\.(?:' +
    CODE_EXT +
    '))(?::(\\d{1,6}(?:\\s*-\\s*\\d{1,6})?))(?!\\d)',
  'g',
)
/** `\u0060:413-422\u0060` —— 省略了路径的行号引用（同一句里前半段已给出路径，仓库里大量这种写法） */
const RE_BARE_LINE = /(^|[\s(\uff08\u3001\uff0c])\u0060:\d{1,6}(?:\s*-\s*\d{1,6})?\u0060/g

interface Violation {
  rule: 'R1' | 'R2' | 'R3'
  file: string
  line?: number
  detail: string
}

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

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

function walkMd(root: string, subdir: string): string[] {
  const base = join(root, subdir)
  const out: string[] = []
  const stack: string[] = [base]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!EXCLUDE_DIR_NAMES.has(ent.name) && !/^\.wt-/.test(ent.name)) stack.push(abs)
      } else if (/\.(md|markdown)$/i.test(ent.name)) {
        out.push(abs)
      }
    }
  }
  return out.sort()
}

/** 逐行返回「是否在 ``` 围栏内」，围栏内的行不参与 R2/R3 判定。 */
function fenceFlags(text: string): boolean[] {
  const flags: boolean[] = []
  let inFence = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      flags.push(true) // 围栏行本身也不算正文
      continue
    }
    flags.push(inFence)
  }
  return flags
}

// ───────────────────────────── R1 ─────────────────────────────

function checkR1(root: string): Violation[] {
  const violations: Violation[] = []
  const readmeAbs = join(root, 'docs/README.md')
  if (!existsSync(readmeAbs)) {
    return [{ rule: 'R1', file: 'docs/README.md', detail: '索引文件不存在，无法判定覆盖情况' }]
  }
  const readme = readFileSync(readmeAbs, 'utf8')
  const docsFiles = walkMd(root, 'docs').map((abs) => toPosix(relative(root, abs)))

  // 目录级索引：docs/<dir>/README.md —— 它自己必须被上层覆盖，才允许它替子文件背书
  const dirIndexes = new Map<string, string>() // dir(rel) → 索引文件内容
  for (const relPath of docsFiles) {
    if (basename(relPath) !== 'README.md') continue
    const dir = relPath.slice('docs/'.length, -'README.md'.length).replace(/\/$/, '')
    if (dir === '') continue // docs/README.md 是总索引
    dirIndexes.set(dir, readFileSync(join(root, relPath), 'utf8'))
  }

  for (const relPath of docsFiles) {
    const relToDocs = relPath.slice('docs/'.length)
    if (relToDocs === 'README.md') continue
    const base = basename(relPath)
    const coveredInReadme = readme.includes(relPath) || readme.includes(relToDocs) || readme.includes(`(${relToDocs})`)
    if (coveredInReadme) continue

    // 目录级索引背书：该目录有 README，且总索引引用了这个目录或该目录的 README
    const dir = dirname(relToDocs)
    const indexText = dirIndexes.get(dir)
    if (indexText !== undefined) {
      const indexCovered =
        readme.includes(`docs/${dir}/README.md`) ||
        readme.includes(`${dir}/README.md`) ||
        readme.includes(`${dir}/`) ||
        readme.includes(`(${dir})`) ||
        readme.includes(`(${dir}/)`)
      const coveredHere = indexText.includes(base) || indexText.includes(`${dir}/${base}`)
      if (indexCovered && coveredHere) continue
    }
    violations.push({
      rule: 'R1',
      file: relPath,
      detail: `docs/README.md 里按路径找不到它（可用写法：\`${relToDocs}\` 或 \`${relPath}\`）${
        dirIndexes.has(dir) ? `；同目录索引 docs/${dir}/README.md 存在但总索引未引用该目录` : ''
      }`,
    })
  }
  return violations
}

// ───────────────────────────── R2 ─────────────────────────────

function checkR2(root: string, mdFiles: string[]): Violation[] {
  const violations: Violation[] = []
  for (const abs of mdFiles) {
    const rel = toPosix(relative(root, abs))
    const text = readFileSync(abs, 'utf8')
    const flags = fenceFlags(text)
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (flags[i]) continue
      for (const m of line.matchAll(RE_PATH_LINE)) {
        const path = m[2] as string
        const ln = (m[3] as string).replace(/\s+/g, '')
        violations.push({ rule: 'R2', file: rel, line: i + 1, detail: `\`${path}:${ln}\` → 改成「路径 + 符号名」，例如 \`${path}\` 的 \`某个函数名\`（行号会漂移）` })
      }
      for (const m of line.matchAll(RE_BARE_LINE)) {
        violations.push({ rule: 'R2', file: rel, line: i + 1, detail: `\`裸行号引用 ${m[0].trim()}\` → 同上，改为符号名` })
      }
    }
  }
  return violations
}

// ───────────────────────────── R3 ─────────────────────────────

function checkR3(root: string, mdFiles: string[]): Violation[] {
  const violations: Violation[] = []
  for (const abs of mdFiles) {
    const rel = toPosix(relative(root, abs))
    const text = readFileSync(abs, 'utf8')
    const flags = fenceFlags(text)
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (flags[i]) continue
      for (const lit of FORBIDDEN_LITERALS) {
        const at = line.indexOf(lit)
        if (at < 0) continue
        const sample = line.trim().slice(0, 100)
        violations.push({ rule: 'R3', file: rel, line: i + 1, detail: `出现私有端点 \`${lit}\` → 示例改用占位符（如 \`https://api.example.com/v1\`）｜${sample}` })
      }
    }
  }
  return violations
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv: string[]): { root?: string; failOn: Set<string>; help: boolean } {
  const opts = { failOn: new Set<string>(), help: false } as { root?: string; failOn: Set<string>; help: boolean }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opts.root = argv[++i]
    else if (a?.startsWith('--root=')) opts.root = a.slice(7)
    else if (a === '--fail-on') for (const r of String(argv[++i] ?? '').split(',')) opts.failOn.add(r.trim().toUpperCase())
    else if (a?.startsWith('--fail-on='))
      for (const r of a.slice(10).split(',')) opts.failOn.add(r.trim().toUpperCase())
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('用法：pnpm run docs:conventions -- [--root <目录>] [--fail-on R1,R2,R3]')
    return 0
  }
  const root = findRepoRoot(opts.root)
  const docsReadme = join(root, 'docs/README.md')
  if (!existsSync(docsReadme)) {
    console.error(`docs:conventions：找不到 ${docsReadme} —— --root 是否写错？`)
    return 1
  }
  const mdFiles = walkMd(root, 'docs').map((abs) => abs)

  const all: Violation[] = [...checkR1(root), ...checkR2(root, mdFiles), ...checkR3(root, mdFiles)]
  const counts = { R1: 0, R2: 0, R3: 0 } as Record<'R1' | 'R2' | 'R3', number>
  for (const v of all) counts[v.rule]++

  const describe: Record<'R1' | 'R2' | 'R3', string> = {
    R1: 'R1 未进文档索引（docs/README.md 里按路径找不到）',
    R2: 'R2 「路径 + 行号」引用（行号必腐，改用符号名）',
    R3: 'R3 出现私有端点字面量（示例必须用占位符）',
  }

  console.log(`docs:conventions —— 扫描 ${mdFiles.length} 个 docs markdown`)
  for (const rule of ['R1', 'R2', 'R3'] as const) {
    const list = all.filter((v) => v.rule === rule)
    console.log(`\n${describe[rule]}：${list.length} 处`)
    if (list.length === 0) continue
    // R2 存量太多时按文件聚合，让清单可读、可分派（否则一次刷出几百行没人看）
    if (rule === 'R2' && list.length > 25) {
      const byFile = new Map<string, number>()
      for (const v of list) byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1)
      for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)} 处  ${file}`)
      }
      console.log('  （明细：pnpm run docs:conventions -- --fail-on R2 会逐条列出）')
    } else {
      for (const v of list) console.log(`  ${v.file}${v.line ? `:${v.line}` : ''}  ${v.detail}`)
    }
  }

  console.log(`\n合计：R1 ${counts.R1}｜R2 ${counts.R2}｜R3 ${counts.R3}`)
  console.log('本命令默认不阻断（exit 0）；逐条收紧用 --fail-on <规则>。')

  const failing = [...opts.failOn].filter((r) => ((counts as Record<string, number>)[r] ?? 0) > 0)
  if (failing.length > 0) {
    console.error(`--fail-on 命中：${failing.join(', ')}`)
    return 1
  }
  return 0
}

process.exit(main())
