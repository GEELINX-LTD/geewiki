/**
 * ★ F21：外部插件脚手架 CLI。
 *
 * ```bash
 * pnpm run new:plugin my-notes              # 后端插件（默认）
 * pnpm run new:plugin my-notes --ui         # 额外生成手写的零构建前端产物
 * pnpm run new:plugin my-notes --dry-run    # 只打印将要写入的内容
 * ```
 *
 * 本文件**只做参数解析与终端输出**，生成逻辑全在 `@geewiki/manager` 的 `scaffold.ts`
 * （那边是纯函数 + 可单测的写盘函数；这里没有业务逻辑，故不重复测一遍）。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scaffoldFiles,
  validatePluginName,
  writeScaffold,
  type ScaffoldSpec,
} from '../packages/manager/src/scaffold.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法: pnpm run new:plugin <插件名> [选项]

选项:
  --ui                 额外生成前端产物（dist/client.js + dist/client.css，手写零构建）
  --no-hot             不声明 runtime.supportsHotReload（需要重启才能生效）
  --display <名字>     面向人的短名（缺省用插件名）
  --desc <说明>        一句话说明
  --dir <目录>         插件根目录（缺省 <仓库根>/plugins）
  --dry-run            只打印将要写入的文件，不落盘
  -h, --help           显示本帮助

插件名规则: 小写字母开头，由小写字母/数字组成，以单连字符分段（如 my-notes）。
它会进 URL 与文件路径，故只做白名单校验、不做字符替换。
`

interface Args {
  name?: string
  withUi: boolean
  hotReload: boolean
  displayName?: string
  description?: string
  dir?: string
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { withUi: false, hotReload: true, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} 缺少取值`)
      i += 1
      return v
    }
    if (a === '--ui') out.withUi = true
    else if (a === '--no-ui') out.withUi = false
    else if (a === '--no-hot') out.hotReload = false
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '-h' || a === '--help') out.help = true
    else if (a === '--display') out.displayName = next()
    else if (a === '--desc') out.description = next()
    else if (a === '--dir') out.dir = next()
    else if (a.startsWith('-')) throw new Error(`未知选项: ${a}`)
    else if (out.name === undefined) out.name = a
    else throw new Error(`只接受一个插件名，多出: ${a}`)
  }
  return out
}

function main(): number {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`✖ ${(err as Error).message}\n`)
    console.error(USAGE)
    return 2
  }
  if (args.help || args.name === undefined) {
    console.log(USAGE)
    return args.name === undefined && !args.help ? 2 : 0
  }
  const invalid = validatePluginName(args.name)
  if (invalid !== undefined) {
    console.error(`✖ ${invalid}`)
    return 2
  }
  const pluginsRoot = args.dir !== undefined ? resolve(args.dir) : join(REPO_ROOT, 'plugins')
  const spec: ScaffoldSpec = {
    name: args.name,
    displayName: args.displayName ?? args.name,
    description: args.description ?? `${args.name} —— GeeWiki 外部插件`,
    withUi: args.withUi,
    hotReload: args.hotReload,
  }

  if (args.dryRun) {
    console.log(`（dry-run）将写入 ${join(pluginsRoot, spec.name)}：\n`)
    for (const f of scaffoldFiles(spec)) {
      console.log(`─── ${f.path} ${'─'.repeat(Math.max(0, 60 - f.path.length))}`)
      console.log(f.content)
    }
    if (spec.withUi) printGitignoreHint(spec.name)
    return 0
  }

  let result: ReturnType<typeof writeScaffold>
  try {
    result = writeScaffold(pluginsRoot, spec)
  } catch (err) {
    console.error(`✖ ${(err as Error).message}`)
    return 1
  }
  console.log(`✔ 已生成插件 ${spec.name} → ${result.dir}`)
  for (const p of result.written) console.log(`   + ${p}`)
  console.log(`
下一步：
  1. 启用它 —— 把 { "name": "@geewiki-plugin/${spec.name}" } 加进 config/plugins.base.json 的 enabled
     （那是**本机** live 清单，不入库、首次保存配置时生成）；
     要让它在**随版本发布的默认值**里生效，则改 config/plugins.base.example.json。
     也可以在管理台里临时启用 —— 外部插件不会自动启用
  2. 跑起来 —— pnpm run dev，然后 curl -s localhost:3000/api/${spec.name}
     发现失败的原因会出现在 GET /api/plugins 的 issues 里，先看那里再看日志`)
  if (spec.withUi) printGitignoreHint(spec.name)
  return 0
}

/**
 * UI 产物的 .gitignore 例外提示。
 *
 * 这条提示是脚手架里**唯一不可省**的交互：不提示的话，作者会看到文件在磁盘上、
 * 界面也正常，直到一次干净检出才发现界面消失（见 scaffold.ts 文件头那段坑）。
 */
function printGitignoreHint(name: string): void {
  console.log(`
⚠  前端产物落在 dist/，而仓库 .gitignore 全局忽略 dist/。
   若这些产物是**手写**的（不是构建出来的），请把下面两行加到根 .gitignore 末尾，
   否则它们不会进版本库：
     !plugins/${name}/dist/
     !plugins/${name}/dist/**`)
}

process.exitCode = main()
