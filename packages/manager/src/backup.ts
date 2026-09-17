/**
 * ★ F20：备份 / 恢复——`data/` + `config/` 的**一致性**快照。
 *
 * ## 为什么"把目录拷一份"是错的
 * 默认后端是 SQLite 且开着 **WAL**。运行中的库由「主文件 + `-wal` + `-shm`」三者共同构成，
 * 于是朴素拷贝会得到两种坏结果：
 * 1. **撕裂快照**：`cp` 期间还有提交在写，主文件与 WAL 不是同一个时点，恢复出来是**没人见过**的状态；
 * 2. **陈旧边车**：即便主文件拷对了，把一个旧的 `-wal` 一起拷过去，SQLite 下次打开会去**重放不属于该快照的帧**。
 *
 * 所以数据库必须走 **SQLite 自己的快照机制**，本模块的办法是 `VACUUM INTO`（SQLite ≥ 3.27）：
 * 它由数据库引擎自己保证一致性，对**运行中的库**也安全，且产出的文件**自包含、不带边车**
 * （实测：源目录有 `s.db`/`s.db-wal`/`s.db-shm`，快照只有一个 `snap.db`）。
 *
 * 关键实现选择：快照能力是**注入**的（`snapshotDatabase`），而不是在这里 import `better-sqlite3`。
 * 原因是 pnpm 的严格隔离——`better-sqlite3` 只从 `packages/db-sqlite` 可解析，从管理器里
 * import 会失败；而管理器**已经**有 `ctx.get('db')` 这个服务，`db.run('VACUUM INTO ?', [dest])`
 * 实测可用（带绑定参数）。于是备份**不需要任何新依赖**，也不需要放宽包边界。
 *
 * ## 不假装完整
 * 若 `snapshotDatabase` 没提供（例如 PostgreSQL 部署，或库还没建），备份会**显式记录**
 * 「本快照不含数据库」并给出原因，而不是产出一个看起来完整、恢复后缺数据的包。
 * PG 部署必须用 `pg_dump`——那是另一条路径，本模块不冒充它。
 *
 * ## 恢复为什么只走 CLI、且必须停机
 * 恢复要在服务器**正拿着库和附件读写**的时候替换文件，等价于"边跑边换引擎"。
 * 故恢复不进 HTTP、不做热恢复，并要求调用方确认服务已停（见 `scripts/restore.ts`）。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { MaintenanceError } from './maintenance.js'

/** 清单格式版本。将来改结构时**必须**升它，恢复端据此拒绝不认识的包 */
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_MANIFEST_FILE = 'manifest.json'
/** 备份目录名前缀（时间戳后缀，便于排序与人工识别） */
export const BACKUP_DIR_PREFIX = 'geewiki-backup-'

/** 默认的数据库相对路径（内置 SQLite 后端的落点） */
export const DEFAULT_DATABASE_REL_PATH = join('data', 'geewiki.db')

/**
 * 拷贝 `data/` 时要**排除**的形态。
 *
 * - 数据库与其边车：由 `snapshotDatabase` 单独产出**自包含**快照，绝不能把旧的
 *   `-wal`/`-shm` 一起带上（见文件头第 2 条）；
 * - `*.tmp`：附件是"先写 tmp 再 rename"的（`att-<pid>-<ts>-<hex>.tmp`），
 *   拷到的是一个**写了一半**的文件，恢复后表现为"某个附件打不开"。
 */
const EXCLUDED_DATA_PATTERNS: readonly RegExp[] = [
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.db-journal$/,
  /\.tmp$/,
]

export interface BackupFileEntry {
  /** 相对仓库根的路径，**始终用 `/` 分隔**（清单要跨平台可读） */
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface BackupManifest {
  readonly formatVersion: number
  readonly createdAt: string
  readonly database: {
    readonly included: boolean
    readonly engine: 'sqlite' | 'none'
    /** 未包含时的**原因**（必填当 `included:false`），供恢复前人工判断 */
    readonly note?: string
  }
  /** 是否把 `config/secrets.json` 也打了进去（含密钥，需按敏感物对待） */
  readonly secretsIncluded: boolean
  readonly files: readonly BackupFileEntry[]
}

export interface BackupReport {
  readonly dir: string
  readonly manifest: BackupManifest
  readonly totalBytes: number
}

export interface CreateBackupOptions {
  readonly repoRoot: string
  /** 备份产物的**父目录**（会在其下建一个带时间戳的子目录） */
  readonly outDir: string
  readonly now?: Date
  readonly databaseRelPath?: string
  /**
   * `data/` 与 `config/` 的**实际位置**（缺省 `<repoRoot>/data`、`<repoRoot>/config`）。
   *
   * 为什么需要它：本部署可以用 `GEEWIKI_DATA_DIR` 把数据放到别处；若这里仍写死
   * `<repoRoot>/data`，就会出现"库快照取自真实数据目录，而其余文件扫的是另一个目录"
   * ——备份看起来成功、内容却自相矛盾。两者**必须**来自同一个来源。
   * 二者都要求落在 `repoRoot` 之内（清单键是仓库相对路径，见 `safeRelPath`）。
   */
  readonly dataDir?: string
  readonly configDir?: string
  /**
   * 把数据库的一致性快照写到 `destPath`。
   * 缺省 ⇒ 本快照不含数据库（并记录原因），**不会**退化成"拷贝 .db 文件"。
   */
  readonly snapshotDatabase?: (destPath: string) => Promise<void>
  /** 不提供 `snapshotDatabase` 时记入清单的原因说明 */
  readonly databaseNote?: string
}

const sha256Of = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** `child` 是否在 `parent` 之内（用 relative 而非 startsWith：`/a-evil` 会通过 `startsWith('/a')`） */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('..')
}
const toPosix = (p: string): string => p.split(sep).join('/')

/** 相对仓库根、且**必须留在仓库内**的路径（恢复端据此拒绝清单里的穿越路径） */
function safeRelPath(repoRoot: string, path: string, what: string): string {
  const rel = relative(resolve(repoRoot), resolve(path))
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new MaintenanceError(`拒绝操作：${what} 不在仓库根之内（${path}）`)
  }
  return rel
}

/** 递归收集待拷贝文件（应用 `data/` 的排除规则） */
function collectFiles(root: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && filter(name)) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * 产出一个备份。
 *
 * 顺序刻意如此：**先写文件、最后写清单**。若中途失败，留下的是一个**没有清单**的半成品目录，
 * 而 `readBackupManifest` 会明确拒绝它——"半成品看起来像完整备份"是比"备份失败"严重得多的结果。
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupReport> {
  const repoRoot = resolve(options.repoRoot)
  const now = options.now ?? new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const dir = join(resolve(options.outDir), `${BACKUP_DIR_PREFIX}${stamp}`)
  if (existsSync(dir)) {
    throw new MaintenanceError(`备份目录已存在，拒绝覆盖：${dir}`)
  }
  mkdirSync(dir, { recursive: true })

  const dataDir = resolve(options.dataDir ?? join(repoRoot, 'data'))
  const configDir = resolve(options.configDir ?? join(repoRoot, 'config'))

  /**
   * 物理路径 → **逻辑路径**（清单键，也是备份目录内的布局）。
   *
   * 数据的物理落点是可配置的（`GEEWIKI_DATA_DIR`），但清单不该因此变形：用 `data/…`、
   * `config/…` 这样的**逻辑**名字，恢复端再按它自己的配置展开回物理位置。
   * 于是「备份在一台机器上做、在另一台布局不同的机器上恢复」才是可能的。
   */
  const logicalOf = (absPath: string): string => {
    if (isInside(dataDir, absPath)) return toPosix(join('data', relative(dataDir, absPath)))
    if (isInside(configDir, absPath)) return toPosix(join('config', relative(configDir, absPath)))
    return toPosix(safeRelPath(repoRoot, absPath, '备份源'))
  }

  const entries: BackupFileEntry[] = []
  const record = (logical: string, backupPath: string): void => {
    entries.push({ path: toPosix(logical), bytes: statSync(backupPath).size, sha256: sha256Of(backupPath) })
  }
  const copyInto = (absPath: string): void => {
    const logical = logicalOf(absPath)
    const dest = join(dir, logical)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(absPath, dest)
    // 记的是**逻辑键**，不是 `dest` 相对仓库根的路径 —— 备份目录缺省就在仓库里
    // （`<仓库根>/backups/`），用后者会把键写成 `backups/geewiki-backup-…/data/…`。
    record(logical, dest)
  }

  // 1) 数据库：走引擎自己的快照，而不是拷文件
  const databaseRelPath = options.databaseRelPath ?? DEFAULT_DATABASE_REL_PATH
  let database: BackupManifest['database']
  if (options.snapshotDatabase) {
    const dest = join(dir, databaseRelPath)
    mkdirSync(dirname(dest), { recursive: true })
    await options.snapshotDatabase(dest)
    record(databaseRelPath, dest)
    database = { included: true, engine: 'sqlite' }
  } else {
    database = {
      included: false,
      engine: 'none',
      note:
        options.databaseNote ??
        '本快照不含数据库（调用方未提供 snapshotDatabase）。PostgreSQL 部署请改用 pg_dump。',
    }
  }

  // 2) data/ 的其余部分（附件等），排除库文件与写了一半的 tmp
  const dataRoot = dataDir
  for (const f of collectFiles(dataRoot, (name) => !EXCLUDED_DATA_PATTERNS.some((re) => re.test(name)))) {
    // 已在步骤 1 写过的库快照不重复拷（同一逻辑键）
    if (logicalOf(f) === toPosix(databaseRelPath)) continue
    // 备份目录若落在被扫描的树里（`--out data/backups` 这类用法），必须跳过自身：
    // 否则本次备份会把**上一次的备份**当数据拷进来，体积逐次翻倍且毫无提示。
    if (isInside(dir, f)) continue
    copyInto(f)
  }

  // 3) config/*.json（含 secrets.json —— 不含它，恢复后 API key 就没了）
  const configRoot = configDir
  let secretsIncluded = false
  if (existsSync(configRoot)) {
    for (const name of readdirSync(configRoot)) {
      const full = join(configRoot, name)
      if (!name.endsWith('.json') || !statSync(full).isFile()) continue
      if (isInside(dir, full)) continue
      if (name === 'secrets.json') secretsIncluded = true
      copyInto(full)
    }
  }

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    database,
    secretsIncluded,
    files: entries,
  }
  writeFileSync(join(dir, BACKUP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { dir, manifest, totalBytes: entries.reduce((s, e) => s + e.bytes, 0) }
}

/** 读清单。**没有清单就抛错**：半成品目录必须被拒绝，而不是被当成"空备份"恢复 */
export function readBackupManifest(dir: string): BackupManifest {
  const file = join(dir, BACKUP_MANIFEST_FILE)
  if (!existsSync(file)) {
    throw new MaintenanceError(
      `不是备份目录（缺少 ${BACKUP_MANIFEST_FILE}）：${dir}\n` +
        '该文件在备份**最后**才写入，故缺它多半意味着那次备份中途失败了。',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new MaintenanceError(`清单不是合法 JSON（${file}）：${(err as Error).message}`)
  }
  const m = parsed as Partial<BackupManifest>
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new MaintenanceError(
      `清单格式版本不匹配：期望 ${BACKUP_FORMAT_VERSION}，文件里是 ${String(m.formatVersion)}`,
    )
  }
  if (!Array.isArray(m.files)) throw new MaintenanceError(`清单缺少 files 数组（${file}）`)
  return m as BackupManifest
}

/**
 * 校验备份完整性：每个条目**存在且 sha256 一致**。
 * 恢复前必须先跑这一步——一个损坏的备份恢复出来比不恢复更糟（原数据已被覆盖）。
 */
export function verifyBackup(dir: string): { ok: boolean; issues: string[] } {
  const manifest = readBackupManifest(dir)
  const issues: string[] = []
  for (const e of manifest.files) {
    const full = join(dir, e.path)
    if (!existsSync(full)) {
      issues.push(`缺失：${e.path}`)
      continue
    }
    const actual = sha256Of(full)
    if (actual !== e.sha256) issues.push(`哈希不符：${e.path}（期望 ${e.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
  }
  return { ok: issues.length === 0, issues }
}

export interface RestoreReport {
  readonly restored: readonly string[]
  /** 被移到一边的原数据目录（若有）——出问题时可据此手工回退 */
  readonly setAside?: string
}

export interface RestoreOptions {
  readonly backupDir: string
  readonly repoRoot: string
  /** 目标已存在数据时是否允许覆盖。缺省 false（拒绝），符合"破坏性操作要显式" */
  readonly force?: boolean
  /**
   * `data/` 与 `config/` 的实际落点（缺省 `<repoRoot>/data`、`<repoRoot>/config`）。
   *
   * 与 `CreateBackupOptions` 里的同名项**必须**成对使用：清单里的键是仓库相对路径
   * （`data/geewiki.db`），若恢复端把它一律展开到 `<repoRoot>/data`，那么一个用
   * `GEEWIKI_DATA_DIR` 把数据放到别处的部署，恢复后会把文件写到**服务根本不读的地方**
   * ——"恢复成功"而数据没回来，是最难排查的一类失败。
   */
  readonly dataDir?: string
  readonly configDir?: string
}

/**
 * 恢复一个备份。
 *
 * 三条安全性质：
 * 1. **先校验再动手**：哈希不符直接拒绝（覆盖了就回不去了）；
 * 2. **清单里的路径必须落在仓库内** —— 清单是文件，可能被改过；`../../etc/passwd` 这类
 *    路径如果被信任，恢复就成了任意写；
 * 3. **覆盖前先把原数据移到一边**（`data.pre-restore-<ts>/`），**不删**。
 *    恢复这个动作本身就会让事情变好或变坏，留一份原状是唯一能救回来的东西。
 */
export function restoreBackup(options: RestoreOptions): RestoreReport {
  const repoRoot = resolve(options.repoRoot)
  const backupDir = resolve(options.backupDir)
  const { ok, issues } = verifyBackup(backupDir)
  if (!ok) {
    throw new MaintenanceError(
      `备份校验失败，拒绝恢复（共 ${issues.length} 处问题）：\n  - ${issues.slice(0, 10).join('\n  - ')}` +
        (issues.length > 10 ? `\n  …另有 ${issues.length - 10} 处` : ''),
    )
  }
  const manifest = readBackupManifest(backupDir)

  // 清单键 → 实际落点。带 `data/`、`config/` 前缀的走可注入目录，其余按仓库相对。
  const dataDir = resolve(options.dataDir ?? join(repoRoot, 'data'))
  const configDir = resolve(options.configDir ?? join(repoRoot, 'config'))
  const destOf = (rel: string): string => {
    const posix = toPosix(rel)
    if (posix === 'data' || posix.startsWith('data/')) return join(dataDir, posix.slice('data'.length + 1))
    if (posix === 'config' || posix.startsWith('config/')) return join(configDir, posix.slice('config'.length + 1))
    return join(repoRoot, rel)
  }

  // 目标冲突判定：只看"有没有数据库"，因为附件目录存在是常态
  const dbRel = manifest.files.find((f) => /(^|\/)data\/[^/]+\.db$/.test(f.path))?.path
  const dbExists = dbRel !== undefined && existsSync(destOf(dbRel))
  if (dbExists && !options.force) {
    throw new MaintenanceError(
      `目标已存在数据库（${dbRel}），拒绝覆盖。确认要覆盖请加 --force；` +
        '原数据会被移到 data.pre-restore-<时间戳>/ 而不是删除。',
    )
  }

  let setAside: string | undefined
  if (dbExists && options.force && existsSync(dataDir)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // 移到数据目录的**同级**（而不是永远移到 repoRoot）：数据目录可被 GEEWIKI_DATA_DIR 改到别处
    setAside = join(dirname(dataDir), `${basename(dataDir)}.pre-restore-${stamp}`)
    renameSync(dataDir, setAside)
  }

  const restored: string[] = []
  for (const e of manifest.files) {
    // 清单是普通文件、可能被改过：逐一确认展开后的落点没逃出其基准目录
    const dest = destOf(e.path)
    safeRelPath(e.path.startsWith('data/') ? dataDir : e.path.startsWith('config/') ? configDir : repoRoot, dest, `清单条目 ${e.path}`)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(backupDir, e.path), dest)
    restored.push(e.path)
  }
  return { restored, setAside }
}

/** 汇总文案（把"含了什么、没含什么"讲清楚，尤其是密钥与数据库） */
export function describeBackup(manifest: BackupManifest): string {
  const lines = [
    `创建时间：${manifest.createdAt}`,
    `文件数：${manifest.files.length}`,
    manifest.database.included
      ? '数据库：已包含（VACUUM INTO 一致性快照，自包含、无 WAL 边车）'
      : `数据库：**未包含** —— ${manifest.database.note ?? '未说明原因'}`,
    manifest.secretsIncluded
      ? '密钥：**已包含 config/secrets.json（明文，按敏感物对待：不要进 git、不要走不安全的通道）**'
      : '密钥：未包含（该部署没有 config/secrets.json）',
    `备份目录名：${basename(BACKUP_DIR_PREFIX)}…（时间戳后缀）`,
  ]
  return lines.join('\n')
}

/** 供 CLI 提示用：列出备份目录下的实际文件（人工核对） */
export function listBackupFiles(dir: string): string[] {
  return collectFiles(dir, () => true).map((f) => toPosix(relative(dir, f)))
}

/** 移除一个备份目录（供自动化清理用；恢复路径不使用它） */
export function removeBackup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
