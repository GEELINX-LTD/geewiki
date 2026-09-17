/**
 * ★ 优化点 6：`tmp/` 清理 CLI。
 *
 * ```bash
 * pnpm run clean:tmp                      # 只看（dry-run），列出 1 天前的条目
 * pnpm run clean:tmp --yes                # 真删
 * pnpm run clean:tmp --yes --all          # 不限时间，全删
 * pnpm run clean:tmp --older-than 7       # 只删 7 天前的
 * ```
 *
 * **默认 dry-run**：递归删除不可逆，且它的失败模式不是报错而是"删了不该删的"。
 * 判据与安全闸门全在 `packages/manager/src/maintenance.ts`（受测），这里只做参数与打印。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSafeTempDir,
  deleteTempEntries,
  dirExists,
  formatBytes,
  planCleanup,
  readTempEntries,
  summarize,
  MaintenanceError,
} from '../packages/manager/src/maintenance.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法: pnpm run clean:tmp [选项]

默认**只列出**将删除的内容（dry-run），不动任何文件。

选项:
  --yes                真正执行删除（不加此项一律只打印）
  --all                不限时间，删除 tmp/ 下全部条目
  --older-than <天数>   只删除该天数之前的条目（缺省 1）
  -h, --help           显示本帮助

只清理 <仓库根>/tmp/。明确不碰：data/、config/、.pnpm-store/、.npm-cache/。
`

function main(): number {
  const argv = process.argv.slice(2)
  let yes = false
  let all = false
  let olderThanDays = 1
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--yes' || a === '-y') yes = true
    else if (a === '--all') all = true
    else if (a === '-h' || a === '--help') {
      console.log(USAGE)
      return 0
    } else if (a === '--older-than') {
      const v = argv[i + 1]
      if (v === undefined) {
        console.error('✖ --older-than 缺少取值')
        return 2
      }
      i += 1
      olderThanDays = Number(v)
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        console.error(`✖ --older-than 需要一个非负数字，收到 ${JSON.stringify(v)}`)
        return 2
      }
    } else {
      console.error(`✖ 未知选项: ${a}\n`)
      console.error(USAGE)
      return 2
    }
  }

  const tmpDir = join(REPO_ROOT, 'tmp')
  if (!dirExists(tmpDir)) {
    console.log(`暂存目录不存在，无需清理: ${tmpDir}`)
    return 0
  }

  let safeDir: string
  try {
    safeDir = assertSafeTempDir(tmpDir, REPO_ROOT)
  } catch (err) {
    // 安全闸门：宁可不清理，也不要在"不确定这是哪里"的情况下递归删除
    console.error(`✖ ${err instanceof MaintenanceError ? err.message : String(err)}`)
    return 1
  }

  const entries = readTempEntries(safeDir)
  const plan = planCleanup(entries, {
    now: Date.now(),
    olderThanMs: all ? 0 : olderThanDays * 24 * 60 * 60 * 1000,
  })

  console.log(`暂存目录: ${safeDir}\n`)
  if (!yes) {
    console.log('（dry-run，不会删除任何文件；加 --yes 才真正执行）\n')
  }
  console.log(summarize(plan))

  if (plan.targets.length > 0) {
    console.log('\n将删除的条目（按体积降序）:')
    for (const t of plan.targets.slice(0, 20)) {
      console.log(`  - ${formatBytes(t.bytes).padStart(9)}  ${t.name}${t.isSymlink ? '  [符号链接]' : ''}`)
    }
    if (plan.targets.length > 20) console.log(`  …另有 ${plan.targets.length - 20} 项`)
  }

  if (!yes) {
    console.log('\n提示：加上 --yes 执行；若 tmp/ 里有正在跑的验证脚本的产物，先确认它已结束。')
    return 0
  }
  const n = deleteTempEntries(plan)
  console.log(`\n✔ 已删除 ${n} 项，释放约 ${formatBytes(plan.targetBytes)}`)
  return 0
}

process.exitCode = main()
