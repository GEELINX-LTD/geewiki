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
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
   * 根目录可位于仓库之外；备份包只记录规范的 `data/…`、`config/…` 逻辑键。
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
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const toPosix = (p: string): string => p.split(sep).join('/')

/** 相对仓库根、且**必须留在仓库内**的路径（恢复端据此拒绝清单里的穿越路径） */
function safeRelPath(repoRoot: string, path: string, what: string): string {
  const rel = relative(resolve(repoRoot), resolve(path))
  if (!isInside(repoRoot, path)) {
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

/** 读取不跟随链接的普通源文件，路径已由清单结构检查或常量保证规范。 */
function sourceFile(root: string, path: string): string {
  const parts = path.split('/')
  let full = root
  for (const [index, part] of parts.entries()) {
    full = join(full, part)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new MaintenanceError(`清单条目不是普通文件或经过符号链接：${path}`)
    }
  }
  return full
}

function backupRoot(dir: string): string {
  const root = resolve(dir)
  const stat = lstatSync(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MaintenanceError(`备份目录不是普通目录：${root}`)
  return realpathSync(root)
}

const recordObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 清单先完整验形；任何条目都不能借后续校验失败让前面的文件先被恢复。 */
export function readBackupManifest(dir: string): BackupManifest {
  const root = backupRoot(dir)
  const file = join(root, BACKUP_MANIFEST_FILE)
  if (!existsSync(file)) {
    throw new MaintenanceError(`不是备份目录（缺少 ${BACKUP_MANIFEST_FILE}）：${dir}\n该文件在备份最后才写入，缺少时拒绝恢复半成品。`)
  }
  sourceFile(root, BACKUP_MANIFEST_FILE)
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) }
  catch (err) { throw new MaintenanceError(`清单不是合法 JSON（${file}）：${(err as Error).message}`) }
  if (!recordObject(parsed)) throw new MaintenanceError('清单必须是对象')
  if (parsed['formatVersion'] !== BACKUP_FORMAT_VERSION) {
    throw new MaintenanceError(`清单格式版本不匹配：期望 ${BACKUP_FORMAT_VERSION}，文件里是 ${String(parsed['formatVersion'])}`)
  }
  const database = parsed['database']
  if (typeof parsed['createdAt'] !== 'string' || !Number.isFinite(Date.parse(parsed['createdAt'])) ||
    typeof parsed['secretsIncluded'] !== 'boolean' || !recordObject(database) ||
    typeof database['included'] !== 'boolean' ||
    database['engine'] !== (database['included'] ? 'sqlite' : 'none') ||
    (database['note'] !== undefined && typeof database['note'] !== 'string') ||
    (!database['included'] && (typeof database['note'] !== 'string' || database['note'].length === 0))) {
    throw new MaintenanceError('清单创建时间、数据库或密钥标记不合法')
  }
  if (!Array.isArray(parsed['files'])) throw new MaintenanceError(`清单缺少 files 数组（${file}）`)
  const files: BackupFileEntry[] = []
  const names = new Set<string>()
  for (const entry of parsed['files'] as unknown[]) {
    if (!recordObject(entry) || typeof entry['path'] !== 'string' ||
      !Number.isSafeInteger(entry['bytes']) || (entry['bytes'] as number) < 0 ||
      typeof entry['sha256'] !== 'string' || !/^[a-f\d]{64}$/i.test(entry['sha256'])) {
      throw new MaintenanceError('清单条目必须包含规范路径、非负整数大小与 SHA-256')
    }
    const path = entry['path']
    const parts = path.split('/')
    if (parts.length < 2 || !['data', 'config'].includes(parts[0]!) ||
      parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0') || /[\\:]/.test(part)) ||
      (parts[0] === 'config' && (parts.length !== 2 || !path.endsWith('.json'))) ||
      (parts[0] === 'data' && /(?:-(?:wal|shm|journal)|\.tmp)$/.test(path))) {
      throw new MaintenanceError(`清单条目路径不合法：${path}`)
    }
    const key = path.toLowerCase()
    if (names.has(key)) throw new MaintenanceError(`清单条目重复或大小写冲突：${path}`)
    names.add(key)
    files.push({ path, bytes: entry['bytes'] as number, sha256: entry['sha256'].toLowerCase() })
  }
  for (const { path } of files) {
    const parts = path.toLowerCase().split('/')
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join('/'))) throw new MaintenanceError(`清单条目文件与目录冲突：${path}`)
    }
  }
  if (parsed['secretsIncluded'] !== files.some(({ path }) => path === 'config/secrets.json') ||
    (database['included'] && !files.some(({ path }) => path.startsWith('data/')))) {
    throw new MaintenanceError('清单数据库或密钥标记与文件列表不一致')
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: parsed['createdAt'],
    database: { included: database['included'], engine: database['included'] ? 'sqlite' : 'none', ...(typeof database['note'] === 'string' ? { note: database['note'] } : {}) },
    secretsIncluded: parsed['secretsIncluded'],
    files,
  }
}

function verifyFiles(root: string, files: readonly BackupFileEntry[]): string[] {
  const issues: string[] = []
  for (const entry of files) {
    try {
      const full = sourceFile(root, entry.path)
      const actual = sha256Of(full)
      if (actual !== entry.sha256) issues.push(`哈希不符：${entry.path}（期望 ${entry.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
      else if (lstatSync(full).size !== entry.bytes) issues.push(`大小不符：${entry.path}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') issues.push(`缺失：${entry.path}`)
      else issues.push(`清单条目 ${entry.path} 读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return issues
}

/** 校验完整结构、源文件类型、大小与哈希；不写入文件。 */
export function verifyBackup(dir: string): { ok: boolean; issues: string[] } {
  const root = backupRoot(dir)
  const manifest = readBackupManifest(root)
  const issues = verifyFiles(root, manifest.files)
  return { ok: issues.length === 0, issues }
}

export interface RestoreReport {
  readonly restored: readonly string[]
  /** 成功换入后保留的原数据目录。 */
  readonly setAside?: string
  /** 与数据一同保留的原配置目录（可能包含密钥）。 */
  readonly configSetAside?: string
}

export interface RestoreOptions {
  readonly backupDir: string
  readonly repoRoot: string
  /** 覆盖已有文件或替换非空数据目录必须显式允许。 */
  readonly force?: boolean
  readonly dataDir?: string
  readonly configDir?: string
}

function maybeStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new MaintenanceError(`无法检查恢复目标 ${path}：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 根目录由操作者指定，可在仓库外；规范化现有父目录别名，拒绝根本身是链接。 */
function targetRoot(path: string): string {
  const full = resolve(path)
  let ancestor = full
  let stat = maybeStat(ancestor)
  if (stat?.isSymbolicLink()) throw new MaintenanceError(`恢复目标不能是符号链接：${full}`)
  while (!stat) {
    ancestor = dirname(ancestor)
    stat = maybeStat(ancestor)
  }
  if (!statSync(ancestor).isDirectory()) throw new MaintenanceError(`恢复目标不是目录：${full}`)
  return resolve(realpathSync(ancestor), relative(ancestor, full))
}

function checkTree(root: string): void {
  const stat = maybeStat(root)
  if (!stat) return
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new MaintenanceError(`恢复目录包含符号链接或特殊文件：${root}`)
  if (stat.isDirectory()) for (const name of readdirSync(root)) checkTree(join(root, name))
}

/** 已有中间层必须是目录，已有最终条目必须是普通文件。 */
function checkDestination(root: string, path: string): boolean {
  const parts = path.split('/')
  let full = root
  for (const [index, part] of parts.entries()) {
    full = join(full, part)
    const stat = maybeStat(full)
    if (!stat) return false
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new MaintenanceError(`恢复目标文件或目录冲突：${full}`)
    }
  }
  return true
}

interface RestoreRoot {
  readonly kind: 'data' | 'config'
  readonly target: string
  readonly entries: readonly BackupFileEntry[]
  readonly merge: boolean
}

function restorePlan(options: RestoreOptions): { backupDir: string; manifest: BackupManifest; roots: RestoreRoot[] } {
  const backupDir = backupRoot(options.backupDir)
  const manifest = readBackupManifest(backupDir)
  const issues = verifyFiles(backupDir, manifest.files)
  if (issues.length > 0) throw new MaintenanceError(`备份校验失败，拒绝恢复（共 ${issues.length} 处问题）：\n  - ${issues.slice(0, 10).join('\n  - ')}`)
  const repoRoot = targetRoot(options.repoRoot)
  const dataDir = targetRoot(options.dataDir ?? join(repoRoot, 'data'))
  const configDir = targetRoot(options.configDir ?? join(repoRoot, 'config'))
  const overlaps = (a: string, b: string): boolean => a === b || isInside(a, b) || isInside(b, a)
  if (overlaps(dataDir, configDir)) throw new MaintenanceError('数据与配置恢复目标不能重叠')
  for (const target of [dataDir, configDir]) {
    if (target === repoRoot || isInside(target, repoRoot) || target === dirname(target) || overlaps(target, backupDir)) {
      throw new MaintenanceError(`恢复目标不能覆盖仓库根、包含备份源或与其重叠：${target}`)
    }
  }
  const roots: RestoreRoot[] = []
  for (const kind of ['data', 'config'] as const) {
    const entries = manifest.files.filter(({ path }) => path.startsWith(`${kind}/`))
    if (entries.length === 0) continue
    const target = kind === 'data' ? dataDir : configDir
    const merge = kind === 'config' || !manifest.database.included
    checkTree(target)
    for (const entry of entries) {
      if (checkDestination(target, entry.path.slice(kind.length + 1)) && !options.force) {
        throw new MaintenanceError(`目标已存在文件（${entry.path}），拒绝覆盖。确认替换请加 --force；原数据和配置均保留同级留底。`)
      }
    }
    if (!merge && !options.force && existsSync(target) && readdirSync(target).length > 0) {
      throw new MaintenanceError(`目标已存在数据库或其他数据，拒绝覆盖。确认替换请加 --force：${target}`)
    }
    roots.push({ kind, target, entries, merge })
  }
  return { backupDir, manifest, roots }
}

/** 与实际恢复相同的完整预检，不建目录、不写文件。供 CLI --dry-run 使用。 */
export function validateRestore(options: RestoreOptions): void { restorePlan(options) }

/** 暂存成功后再换入；捕获的提交异常回退两个目录，进程崩溃仍需按留底手工恢复。 */
export function restoreBackup(options: RestoreOptions): RestoreReport {
  const { backupDir, manifest, roots } = restorePlan(options)
  type Staged = RestoreRoot & { stage: string; aside?: string; installed: boolean }
  const staged: Staged[] = []
  const parents: string[] = []
  try {
    for (const root of roots) {
      const missing: string[] = []
      for (let dir = dirname(root.target); !existsSync(dir); dir = dirname(dir)) missing.push(dir)
      for (const dir of missing.reverse()) { mkdirSync(dir); parents.push(dir) }
      const stage = mkdtempSync(join(dirname(root.target), `.${basename(root.target)}.restore-stage-`))
      staged.push({ ...root, stage, installed: false })
      if (root.merge && existsSync(root.target)) cpSync(root.target, stage, { recursive: true })
      checkTree(stage)
      for (const entry of root.entries) {
        const rel = entry.path.slice(root.kind.length + 1)
        checkDestination(stage, rel)
        const dest = join(stage, rel)
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(sourceFile(backupDir, entry.path), dest)
        if (lstatSync(dest).size !== entry.bytes || sha256Of(dest) !== entry.sha256) {
          throw new MaintenanceError(`暂存文件校验失败：${entry.path}`)
        }
      }
      checkTree(stage)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const root of staged) {
      if (existsSync(root.target)) {
        const aside = join(dirname(root.target), `${basename(root.target)}.pre-restore-${stamp}-${randomUUID()}`)
        renameSync(root.target, aside)
        root.aside = aside
      }
      renameSync(root.stage, root.target)
      root.installed = true
    }
  } catch (err) {
    const rollbackIssues: string[] = []
    for (const root of [...staged].reverse()) {
      try {
        if (root.installed) rmSync(root.target, { recursive: true, force: true })
        if (root.aside) renameSync(root.aside, root.target)
      } catch (rollbackError) {
        rollbackIssues.push(`${root.target}（原目录留底 ${root.aside ?? '无'}）：${String(rollbackError)}`)
      }
      try { rmSync(root.stage, { recursive: true, force: true }) }
      catch (cleanupError) { rollbackIssues.push(`暂存目录未清理 ${root.stage}：${String(cleanupError)}`) }
    }
    for (const dir of parents.reverse()) {
      try { rmdirSync(dir) } catch { /* 只清理本次新建且为空的父目录，不碰已回退的目录。 */ }
    }
    const detail = err instanceof Error ? err.message : String(err)
    if (rollbackIssues.length > 0) throw new MaintenanceError(`恢复失败，回退未完成，请按留底手工恢复：${detail}\n${rollbackIssues.join('\n')}`)
    throw new MaintenanceError(`恢复失败，已回退原数据和配置：${detail}`)
  }
  return {
    restored: manifest.files.map(({ path }) => path),
    setAside: staged.find(({ kind }) => kind === 'data')?.aside,
    configSetAside: staged.find(({ kind }) => kind === 'config')?.aside,
  }
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
