/**
 * ★ F20：备份 CLI —— `pnpm run backup [--out <目录>] [--repo-root <目录>]`
 *
 * ```bash
 * pnpm run backup                      # 备份到 <仓库根>/backups/geewiki-backup-<时间戳>/
 * pnpm run backup --out /srv/backups    # 指定输出父目录
 * ```
 *
 * ## 为什么需要 SQLite 驱动，以及怎么在不引新依赖的前提下拿到它
 * 数据库必须走 **`VACUUM INTO`**（一致性、对运行中的库安全、产物自包含不带 WAL 边车），
 * 而这是 SQLite 自己的能力，纯文件拷贝做不到。但 pnpm 严格隔离下 `better-sqlite3`
 * **只从 `packages/db-sqlite` 可解析**：从仓库根 `require.resolve('better-sqlite3')` 是
 * MODULE_NOT_FOUND。
 *
 * 解法是 `createRequire(<packages/db-sqlite/package.json>)`：这让**解析基准**变成那个包，
 * 于是拿到的正是它已经声明并安装的那一份驱动。比起"往根 devDependencies 里再加一个原生模块"
 * 或"拼 `.pnpm/better-sqlite3@x.y.z/…` 的真实路径"，这条既不新增依赖、也不依赖安装布局的内部细节。
 *
 * ## 与 REST 端点的关系
 * `POST /api/backup`（admin）是同一条逻辑的服务端入口（走 `ctx.get('db')`）。两者产出的清单格式
 * 完全一致，恢复端不关心备份是谁做的。**恢复只能走 CLI**（见 `scripts/restore.ts`）。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackup, describeBackup } from '../packages/manager/src/backup.js'
import { formatBytes } from '../packages/manager/src/maintenance.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 只声明真正用到的那一小块驱动形态；不去 import 包类型（根目录没有它的类型） */
interface SqliteDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown }
  close(): void
}

const USAGE = `用法: pnpm run backup [选项]

产出一个一致性快照：数据库走 VACUUM INTO，另有 data/ 的其余部分与 config/*.json。

选项:
  --out <目录>        备份产物的父目录（缺省 <仓库根>/backups）
  --repo-root <目录>  被备份的仓库根（缺省由本脚本位置推出；主要供测试）
  -h, --help          显示本帮助

恢复用: pnpm run restore <备份目录> [--force]
`

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let outDir: string | undefined
  let repoRoot = REPO_ROOT
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') {
      console.log(USAGE)
      return 0
    } else if (a === '--out' || a === '--repo-root') {
      const v = argv[i + 1]
      if (v === undefined) {
        console.error(`✖ ${a} 缺少取值`)
        return 2
      }
      i += 1
      if (a === '--out') outDir = resolve(v)
      else repoRoot = resolve(v)
    } else {
      console.error(`✖ 未知选项: ${a}\n`)
      console.error(USAGE)
      return 2
    }
  }
  return run(repoRoot, outDir)
}

async function run(repoRoot: string, outDir: string | undefined): Promise<number> {
  const dataDir = resolve(repoRoot, process.env['GEEWIKI_DATA_DIR'] ?? 'data')
  const dbPath = join(dataDir, 'geewiki.db')

  let snapshotDatabase: ((dest: string) => Promise<void>) | undefined
  let databaseNote: string | undefined
  if (existsSync(dbPath)) {
    // 解析基准 = packages/db-sqlite，故拿到的正是该包已安装的那一份驱动
    const requireFromDbSqlite = createRequire(join(repoRoot, 'packages', 'db-sqlite', 'package.json'))
    let Database: new (path: string, opts?: { readonly?: boolean }) => SqliteDatabase
    try {
      Database = requireFromDbSqlite('better-sqlite3') as typeof Database
    } catch (err) {
      console.error(
        `✖ 找不到 SQLite 驱动（better-sqlite3）：${(err as Error).message}\n` +
          '  该驱动由 @geewiki/db-sqlite 声明；若依赖未安装，请先在仓库根跑 pnpm install。\n' +
          '  刻意**不**退化成"直接拷贝 .db 文件"：WAL 模式下那是撕裂快照（见 backup.ts 文件头）。',
      )
      return 1
    }
    snapshotDatabase = async (dest: string) => {
      // 目标必须不存在——VACUUM INTO 拒绝覆盖已存在文件，这正好是我们的意图
      const db = new Database(dbPath)
      try {
        db.prepare('VACUUM INTO ?').run(dest)
      } finally {
        db.close()
      }
    }
  } else {
    // 如实记录"没包含数据库"，而不是产出一个看起来完整、恢复后缺数据的包
    databaseNote = `本快照不含数据库：${dbPath} 不存在（该部署可能用 PostgreSQL：请改用 pg_dump）。`
  }

  try {
    const report = await createBackup({
      repoRoot,
      dataDir,
      outDir: outDir ?? join(repoRoot, 'backups'),
      ...(snapshotDatabase ? { snapshotDatabase } : { databaseNote }),
    })
    console.log(`✔ 备份完成：${report.dir}\n`)
    console.log(describeBackup(report.manifest))
    console.log(`\n合计 ${report.manifest.files.length} 个文件 / ${formatBytes(report.totalBytes)}`)
    console.log(`\n恢复用: pnpm run restore ${report.dir}`)
    return 0
  } catch (err) {
    console.error(`✖ 备份失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

// createBackup 是异步的：顶层用 then 收尾，而不是同步读一个 Promise
main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(`✖ 备份失败：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  },
)
