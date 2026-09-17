/**
 * ★ F20：恢复 CLI —— `pnpm run restore <备份目录> [--force]`
 *
 * ```bash
 * pnpm run restore backups/geewiki-backup-2026-02-14T03-00-00-000Z --verify-only
 * pnpm run restore backups/geewiki-backup-…            # 目标没有库时直接恢复
 * pnpm run restore backups/geewiki-backup-… --force    # 覆盖目标（原 data/ 被移到一边，不删）
 * ```
 *
 * ## 为什么恢复只能走 CLI，不能是 HTTP 路由
 * 恢复要在服务器**正拿着库和附件读写**的时候替换这些文件，等价于"边跑边换引擎"。
 * 备份可以热做（`VACUUM INTO` 由引擎保证一致性），**恢复不行** —— 所以它刻意不是路由，
 * 而是一个要求你先把服务停掉、再在终端里显式敲下去的动作。
 *
 * ## 破坏性操作的三条纪律（实现在 `packages/manager/src/backup.ts`）
 * 1. **先校验再动手**：逐文件 sha256 比对，不符即拒绝（覆盖了就回不去了）；
 * 2. **清单里的路径必须落在仓库内**：清单是普通文件、可能被改过，`../../etc/passwd`
 *    这类路径若被信任，恢复就变成任意写；
 * 3. **覆盖前把原 `data/` 移到 `data.pre-restore-<时间戳>/`，不删** ——
 *    恢复这个动作本身就会让事情变好或变坏，留一份原状是唯一能救回来的东西。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKUP_DIR_PREFIX, readBackupManifest, restoreBackup, verifyBackup } from '../packages/manager/src/backup.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法: pnpm run restore <备份目录> [选项]

选项:
  --verify-only       只校验备份完整性，不写入任何文件
  --force             目标已存在数据库时也覆盖（原 data/ 会被移到 data.pre-restore-<时间戳>/）
  --list              列出 --out/缺省目录下已有的备份，然后退出
  --out <目录>        与 --list 搭配：备份产物所在的父目录（缺省 <仓库根>/backups）
  --repo-root <目录>  恢复目标的仓库根（缺省由本脚本位置推出；主要供测试）
  -h, --help          显示本帮助

⚠ 恢复前请确认 GeeWiki 服务已停止。备份可以热做，恢复不行。
`

function main(): number {
  const argv = process.argv.slice(2)
  let force = false
  let verifyOnly = false
  let list = false
  let outDir: string | undefined
  let repoRoot = REPO_ROOT
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') {
      console.log(USAGE)
      return 0
    } else if (a === '--force') force = true
    else if (a === '--verify-only') verifyOnly = true
    else if (a === '--list') list = true
    else if (a === '--out' || a === '--repo-root') {
      const v = argv[i + 1]
      if (v === undefined) {
        console.error(`✖ ${a} 缺少取值`)
        return 2
      }
      i += 1
      if (a === '--out') outDir = resolve(v)
      else repoRoot = resolve(v)
    } else if (a.startsWith('-')) {
      console.error(`✖ 未知选项: ${a}\n`)
      console.error(USAGE)
      return 2
    } else positional.push(a)
  }

  if (list) {
    const base = outDir ?? join(repoRoot, 'backups')
    if (!existsSync(base)) {
      console.log(`没有备份目录: ${base}`)
      return 0
    }
    const dirs = readdirSync(base)
      .filter((n) => n.startsWith(BACKUP_DIR_PREFIX))
      .sort()
    if (dirs.length === 0) {
      console.log(`暂无备份: ${base}`)
      return 0
    }
    for (const n of dirs) {
      const dir = join(base, n)
      try {
        const m = readBackupManifest(dir)
        console.log(
          `${n}  ${m.files.length} 个文件  数据库:${m.database.included ? '含' : '未含'}` +
            `${m.secretsIncluded ? '  含密钥' : ''}`,
        )
      } catch (err) {
        // 坏清单**显式列出**而不是静默跳过：跳过会让"备份丢了"表现为"列表里没有它"
        console.log(`${n}  ✖ 清单不可读：${(err as Error).message}`)
      }
    }
    return 0
  }

  const target = positional[0]
  if (target === undefined) {
    console.error('✖ 缺少备份目录参数\n')
    console.error(USAGE)
    return 2
  }
  const backupDir = resolve(target)
  if (!existsSync(backupDir)) {
    console.error(`✖ 备份目录不存在: ${backupDir}`)
    return 1
  }

  const started = Date.now()
  const verdict = verifyBackup(backupDir)
  const manifest = readBackupManifest(backupDir)
  console.log(`备份：${backupDir}`)
  console.log(`创建于 ${manifest.createdAt}，共 ${manifest.files.length} 个文件`)
  console.log(
    `数据库：${manifest.database.included ? '已包含' : `**未包含** —— ${manifest.database.note ?? '未说明'}`}`,
  )
  if (manifest.secretsIncluded) console.log('⚠ 该备份含 config/secrets.json（明文密钥）')
  console.log(`完整性校验：${verdict.ok ? '✔ 通过' : `✖ ${verdict.issues.length} 处问题`}（${Date.now() - started} ms）`)
  if (!verdict.ok) {
    for (const issue of verdict.issues.slice(0, 10)) console.error(`  - ${issue}`)
    if (verdict.issues.length > 10) console.error(`  …另有 ${verdict.issues.length - 10} 处`)
    console.error('\n✖ 拒绝恢复：损坏的备份恢复出来比不恢复更糟（原数据已被覆盖）')
    return 1
  }
  if (verifyOnly) {
    console.log('\n✔ 校验通过（--verify-only，未写入任何文件）')
    return 0
  }

  try {
    const report = restoreBackup({
      backupDir,
      repoRoot,
      force,
      dataDir: resolve(repoRoot, process.env['GEEWIKI_DATA_DIR'] ?? 'data'),
    })
    console.log(`\n✔ 已恢复 ${report.restored.length} 个文件到 ${repoRoot}`)
    if (report.setAside) {
      console.log(`  原数据已移到（未删除）：${report.setAside}`)
      console.log('  确认恢复结果无误后可自行删除它；若结果不对，把它移回 data/ 并重新启动服务。')
    }
    console.log('\n请重新启动 GeeWiki 服务。')
    return 0
  } catch (err) {
    console.error(`\n✖ 恢复失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

process.exitCode = main()
