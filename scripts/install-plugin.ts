/**
 * ★ F17：外部插件安装 / 完整性校验 CLI。
 *
 * ```bash
 * pnpm run install-plugin ./some-plugin            # 从目录安装（开发期常用）
 * pnpm run install-plugin ./dist/foo-1.0.0.tgz    # 从压缩包安装
 * pnpm run install-plugin https://…/foo.tgz        # 从 URL 安装（仅 https）
 * pnpm run install-plugin ./foo --dry-run          # 只规划，不动任何文件
 * pnpm run install-plugin ./foo --name bar         # 指定目标目录名
 * pnpm run install-plugin ./foo --force            # 覆盖已存在的同名插件
 * pnpm run install-plugin --verify                 # 校验全部已安装插件的完整性
 * ```
 *
 * **`--verify` 的结果有三种，其中一种不是"通过"**：
 * `ok`（与安装基线一致）、`drift`（被改过）、**`unsigned`（没有基线 ⇒ 无法判断）**。
 * 把 `unsigned` 当成通过，正是那种"看起来在防护、实际什么都没防"的实现。
 *
 * **边界（不冒充）**：这是**完整性**不是**签名**。它能回答"相对安装那一刻被改过吗"，
 * 不能回答"这是谁发布的、可信吗"。若攻击者能改写插件文件，也就能改写随包落地的基线。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifySource,
  cleanupPlan,
  describePlan,
  installPlugin,
  planInstall,
  verifyAllIntegrity,
} from '../packages/manager/src/plugin-install.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法: pnpm run install-plugin <来源> [选项]

来源可以是：目录、.tar.gz/.tgz 压缩包、https:// 开头的压缩包地址。

选项:
  --name <目录名>   目标目录名（缺省用清单里的插件短名）
  --force           目标已存在时覆盖（原目录会先被移到 <目录>.replaced-<时间戳>，不直接删）
  --dry-run         只规划并打印，不写入任何文件
  --verify          校验全部已安装插件相对其完整性基线的状态，然后退出
  --json            --verify 时输出 JSON
  -h, --help        显示本帮助

插件目录: GEEWIKI_PLUGINS_DIR 或 <仓库根>/plugins

⚠ 这是**完整性**校验，不是**签名**：它能发现"装进来之后被改过"，
  不能证明"这个插件是谁发布的"。
`

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let name: string | undefined
  let force = false
  let dryRun = false
  let verify = false
  let asJson = false
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') {
      console.log(USAGE)
      return 0
    } else if (a === '--force') force = true
    else if (a === '--dry-run') dryRun = true
    else if (a === '--verify') verify = true
    else if (a === '--json') asJson = true
    else if (a === '--name') {
      const v = argv[i + 1]
      if (v === undefined) {
        console.error('✖ --name 缺少取值')
        return 2
      }
      i += 1
      name = v
    } else if (a.startsWith('-')) {
      console.error(`✖ 未知选项: ${a}\n`)
      console.error(USAGE)
      return 2
    } else positional.push(a)
  }

  const pluginsRoot = resolve(
    REPO_ROOT,
    process.env['GEEWIKI_PLUGINS_DIR'] ?? 'plugins',
  )

  if (verify) {
    const reports = verifyAllIntegrity(pluginsRoot)
    if (asJson) {
      console.log(JSON.stringify({ pluginsRoot, reports }, null, 2))
    } else {
      console.log(`插件目录：${pluginsRoot}\n`)
      if (reports.length === 0) console.log('没有已安装的外部插件。')
      for (const r of reports) {
        const mark = r.status === 'ok' ? '✔' : r.status === 'unsigned' ? '?' : '✖'
        console.log(`${mark} ${r.name ?? '(未知)'}  ${r.status}`)
        if (r.status === 'drift') {
          for (const f of r.changed.slice(0, 5)) console.log(`     改动: ${f}`)
          for (const f of r.added.slice(0, 5)) console.log(`     新增: ${f}`)
          for (const f of r.removed.slice(0, 5)) console.log(`     删除: ${f}`)
          const total = r.changed.length + r.added.length + r.removed.length
          if (total > 15) console.log(`     …另有 ${total - 15} 项`)
        } else if (r.status === 'unsigned') {
          console.log(`     ${r.reason ?? ''}`)
        }
      }
      const drift = reports.filter((r) => r.status === 'drift').length
      const unsigned = reports.filter((r) => r.status === 'unsigned').length
      console.log(
        `\n合计 ${reports.length} 个：ok ${reports.filter((r) => r.status === 'ok').length}` +
          `、drift ${drift}、unsigned ${unsigned}`,
      )
      if (unsigned > 0) {
        console.log('注意：unsigned 表示"无法判断"（安装时没有留基线），**不等于通过**。')
      }
    }
    return 0
  }

  const source = positional[0]
  if (source === undefined) {
    console.error('✖ 缺少来源参数\n')
    console.error(USAGE)
    return 2
  }
  if (positional.length > 1) {
    console.error(`✖ 只接受一个来源，收到 ${positional.length} 个`)
    return 2
  }

  return await run(source, { pluginsRoot, name, force, dryRun })
}

async function run(
  source: string,
  opts: { pluginsRoot: string; name?: string; force: boolean; dryRun: boolean },
): Promise<number> {
  try {
    const kind = classifySource(source)
    console.log(`来源类型：${kind}\n`)
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const planOptions = {
    pluginsRoot: opts.pluginsRoot,
    source,
    ...(opts.name === undefined ? {} : { name: opts.name }),
  }

  if (opts.dryRun) {
    // 规划会把来源落到暂存区（解包/下载），但**不碰目标目录**
    try {
      const plan = await planInstall(planOptions)
      console.log(describePlan(plan))
      // 规划本身会解包/下载到暂存区；dry-run 必须把它清掉，否则每跑一次都留一个 .gw-install-*
      cleanupPlan(plan)
      console.log('\n（--dry-run：未写入任何插件目录，暂存区已清理）')
      return 0
    } catch (err) {
      console.error(`✖ 规划失败：${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  try {
    const result = await installPlugin({ ...planOptions, force: opts.force })
      console.log(`✔ 已安装：${result.name} @ ${result.version}`)
      console.log(`  目录：${result.dir}`)
      console.log(`  文件：${result.files} 个，rootHash ${result.integrity.rootHash.slice(0, 12)}…`)
      console.log(`  完整性基线：${result.dir}/.geewiki-integrity.json`)
    console.log('\n提示：外部插件不是 workspace 包、**不能有自己的依赖**（只应用 Node 内置 + ctx 提供的服务）。')
    console.log('     插件默认不启用；在「插件管理」里启用，或用 config/plugins.session.json 临时启用。')
    return 0
  } catch (err) {
    console.error(`✖ 安装失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

// 安装路径是异步的（下载/解包），顶层用 then 收尾
void Promise.resolve()
  .then(() => main())
  .then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(`✖ ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    },
  )
