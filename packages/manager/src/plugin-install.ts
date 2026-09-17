/**
 * ★ F17：外部插件的**安装**与**完整性校验**。
 *
 * ## 这一项要解决什么
 * 在此之前，装一个外部插件只有一条路：**手工把目录放进 `plugins/`**。由此有两个后果：
 * 1. 没有"安装"这个动作，也就没有地方做**安装前的校验**（清单是否合法、入口是否存在、
 *    压缩包里有没有越界条目）；
 * 2. 装完之后**没有任何办法判断它有没有被改过** —— 审计 §3 里记为「外部插件无签名/完整性校验」。
 *
 * ## ★ 一句话说清本模块的边界：这是**完整性**，不是**签名**
 * 它记录"装进来那一刻每个文件的哈希"，之后能回答"**相对那个基线，它被改过吗**"。
 * 它**不能**回答"这个插件是谁发布的、可信吗" —— 那需要发布者签名与公钥信任链，
 * 本模块**不冒充**它。两者必须分清，否则会得到一个"校验通过"的假安全感：
 * 攻击者若能改写插件文件，也就能改写随包一起落地的完整性基线。
 * 真正让"装进来的东西能被审计"的另一半是 **F10 的 `permissions` 清单**（它声明要碰哪些跨界能力）。
 *
 * ## 为什么不新增依赖
 * 解包需要 tar，而仓库里没有 JS 的 tar 实现（`tar` / `tar-stream` 都不可解析）。
 * 新增一个依赖只为跑一条安装命令并不划算，故用系统 `tar`，并**在它之外**加自己的防线：
 * 先 `tar -tzf` **列出条目并逐条判越界**，解包后再**走一遍目录树**确认没有符号链接、
 * 没有逃出目标目录的文件。两条防线叠加：不把安全性寄托在某个 tar 实现的行为上
 * （`--no-same-owner` 这类开关解决的是权限，不是路径穿越）。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DiscoveryError, isInsideDir, parsePluginManifest } from './discovery.js'
import { MaintenanceError } from './maintenance.js'

/** 完整性基线的文件名（放在插件目录根部） */
export const INTEGRITY_FILE = '.geewiki-integrity.json'
export const INTEGRITY_FORMAT_VERSION = 1

/** 计算哈希时跳过的目录/文件：它们不是"插件内容" */
const SKIP_NAMES = new Set(['node_modules', '.git', INTEGRITY_FILE])

export interface IntegrityFile {
  readonly formatVersion: number
  readonly name: string
  readonly version: string
  /** 来源描述（目录路径 / 压缩包路径 / URL），仅供人看 */
  readonly source: string
  readonly installedAt: string
  /** 源压缩包的 sha256（仅 tarball/url 来源有；目录来源没有"一个包"的哈希） */
  readonly sourceDigest?: string
  /** 相对路径（正斜杠）→ 文件 sha256 */
  readonly files: Readonly<Record<string, string>>
  /** 把 `files` 排序后串起来再哈希得到的单一值，便于快速比对 */
  readonly rootHash: string
}

export type IntegrityStatus = 'ok' | 'drift' | 'unsigned' | 'missing'

export interface IntegrityReport {
  readonly dir: string
  readonly name?: string
  readonly status: IntegrityStatus
  readonly changed: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** 非 `ok` 时的一句话说明（供 REST/CLI 直接展示） */
  readonly reason?: string
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const toPosix = (p: string): string => p.split(sep).join('/')

/** 递归收集"插件内容"文件（相对路径 → 绝对路径），跳过 `node_modules`/`.git`/基线文件自身 */
export function collectPluginFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (SKIP_NAMES.has(name)) continue
      const full = join(current, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        // 符号链接不计入基线：它的"内容"取决于运行时指向哪里，哈希它没有意义，
        // 反而会让"链接被换成指向别处"看起来仍然一致。安装路径会整体拒绝符号链接。
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) out.set(toPosix(relative(dir, full)), full)
    }
  }
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  return out
}

/** 由 `files` 算出单一的 `rootHash`（顺序无关：先按键排序再拼） */
export function rootHashOf(files: Readonly<Record<string, string>>): string {
  const lines = Object.keys(files)
    .sort()
    .map((k) => `${k}:${files[k]}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 为一个已就位的插件目录生成完整性基线（不写盘） */
export function computeIntegrity(
  dir: string,
  meta: { name: string; version: string; source: string; installedAt?: string; sourceDigest?: string },
): IntegrityFile {
  const files: Record<string, string> = {}
  for (const [rel, abs] of collectPluginFiles(dir)) files[rel] = sha256File(abs)
  return {
    formatVersion: INTEGRITY_FORMAT_VERSION,
    name: meta.name,
    version: meta.version,
    source: meta.source,
    installedAt: meta.installedAt ?? new Date().toISOString(),
    ...(meta.sourceDigest === undefined ? {} : { sourceDigest: meta.sourceDigest }),
    files,
    rootHash: rootHashOf(files),
  }
}

/** 写基线（覆盖）；供安装路径调用 */
export function writeIntegrity(dir: string, integrity: IntegrityFile): void {
  writeFileSync(join(dir, INTEGRITY_FILE), `${JSON.stringify(integrity, null, 2)}\n`, 'utf8')
}

/** 读基线；不存在返回 `null`，**损坏则抛错**（静默当"没装过"会把篡改伪装成"未签名"） */
export function readIntegrity(dir: string): IntegrityFile | null {
  const file = join(dir, INTEGRITY_FILE)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new MaintenanceError(`完整性基线不是合法 JSON（${file}）：${(err as Error).message}`)
  }
  const f = parsed as Partial<IntegrityFile>
  if (f.formatVersion !== INTEGRITY_FORMAT_VERSION) {
    throw new MaintenanceError(
      `完整性基线格式版本不匹配（${file}）：期望 ${INTEGRITY_FORMAT_VERSION}，文件里是 ${String(f.formatVersion)}`,
    )
  }
  if (typeof f.files !== 'object' || f.files === null) throw new MaintenanceError(`完整性基线缺少 files（${file}）`)
  return f as IntegrityFile
}

/**
 * 校验一个插件目录相对其完整性基线是否被改动。
 *
 * **`unsigned` 不是 `ok`**：没有基线就是"无法判断"，而不是"没问题"。这条区分是刻意的 ——
 * 把"没装过基线"报成通过，正是那种"看起来在防护、实际什么都没防"的实现。
 */
export function verifyIntegrity(dir: string): IntegrityReport {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { dir, status: 'missing', changed: [], added: [], removed: [], reason: '目录不存在' }
  }
  const baseline = readIntegrity(dir)
  if (!baseline) {
    return {
      dir,
      // 没有基线时仍**尽力报出插件名**：只打"(未知)"会让运维无法知道该去查哪一个，
      // 而名字就在该目录的清单里。读不到就算（清单坏了是另一件事，由发现流程报）。
      ...nameOfDir(dir),
      status: 'unsigned',
      changed: [],
      added: [],
      removed: [],
      reason: `没有完整性基线（${INTEGRITY_FILE}）：无法判断是否被改动（这是"未签名"，不是"通过"）`,
    }
  }
  const current: Record<string, string> = {}
  for (const [rel, abs] of collectPluginFiles(dir)) current[rel] = sha256File(abs)

  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const [rel, hash] of Object.entries(current)) {
    const before = baseline.files[rel]
    if (before === undefined) added.push(rel)
    else if (before !== hash) changed.push(rel)
  }
  for (const rel of Object.keys(baseline.files)) if (!(rel in current)) removed.push(rel)

  const sort = (a: string[]): string[] => a.sort()
  const status: IntegrityStatus = changed.length + added.length + removed.length === 0 ? 'ok' : 'drift'
  return {
    dir,
    name: baseline.name,
    status,
    changed: sort(changed),
    added: sort(added),
    removed: sort(removed),
    ...(status === 'ok'
      ? {}
      : {
          reason:
            `自 ${baseline.installedAt} 安装以来内容有变化：` +
            `${changed.length} 个改动、${added.length} 个新增、${removed.length} 个删除`,
        }),
  }
}

/** 从目录里的清单读插件名；读不到就返回空对象（不抛错——报不出名字不该让整个体检失败） */
function nameOfDir(dir: string): { name?: string } {
  try {
    const pkgPath = join(dir, 'package.json')
    const manifestPath = join(dir, 'geewiki.manifest.json')
    const parsed = parsePluginManifest(
      existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : undefined,
      existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined,
    )
    return { name: parsed.name }
  } catch {
    return {}
  }
}

/** 校验 `pluginsRoot` 下的全部插件目录（供 REST/CLI 的"整体体检"用） */
export function verifyAllIntegrity(pluginsRoot: string): IntegrityReport[] {
  if (!existsSync(pluginsRoot)) return []
  return readdirSync(pluginsRoot)
    .filter((name) => {
      try {
        return statSync(join(pluginsRoot, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .map((name) => verifyIntegrity(join(pluginsRoot, name)))
}

/* ============================ 安装 ============================ */

export type InstallSourceKind = 'dir' | 'tarball' | 'url'

/** 依据来源字符串判定类型。**只接受 https**：明文 http 会让"下载的东西"在路上就能被换掉 */
export function classifySource(source: string): InstallSourceKind {
  if (/^https:\/\//i.test(source)) return 'url'
  if (source.startsWith('http://')) {
    throw new MaintenanceError('拒绝 http:// 来源：明文通道上任何人都能换掉压缩包。请用 https://')
  }
  if (/\.(tar\.gz|tgz)$/i.test(source)) return 'tarball'
  return 'dir'
}

export interface InstallPlan {
  readonly kind: InstallSourceKind
  readonly source: string
  readonly name: string
  readonly version: string
  readonly targetDir: string
  readonly wouldOverwrite: boolean
  /** 压缩包里的条目（目录来源为空） */
  readonly entries: readonly string[]
  readonly sourceDigest?: string
  /**
   * 插件内容当前所在的位置（目录来源 = 用户的目录本身；压缩包来源 = 解包后的插件根，
   * 可能是解包目录的子目录）。**它与 `stagingRoot` 常常不是同一个目录** ——
   * 把它们混为一谈，`dir` 来源就会把**空的暂存目录** rename 到目标位置。
   */
  readonly contentRoot: string
  /** 本次安装创建的暂存根目录（无论如何都要清理掉，且必须在 `pluginsRoot` 下以保证 rename 同文件系统） */
  readonly stagingRoot: string
}

export interface PlanInstallOptions {
  readonly pluginsRoot: string
  readonly source: string
  /** 目标目录名（缺省用清单里的插件短名） */
  readonly name?: string
  /** 下载/解包的临时目录（缺省在 pluginsRoot 下建，保证 rename 同文件系统） */
  readonly tmpRoot?: string
  /** 单次下载字节上限（缺省 64 MiB） */
  readonly maxBytes?: number
}

/** 从插件名取短名：`@scope/name` → `name`；已是短名则原样 */
export function shortNameOf(name: string): string {
  const i = name.lastIndexOf('/')
  return i === -1 ? name : name.slice(i + 1)
}

function runTar(args: readonly string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('tar', args as string[], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { ok: false, out: '', err: (r.error as Error).message }
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/**
 * 列出压缩包条目并**逐条拒绝**可疑路径。
 *
 * 这一道防线刻意放在解包**之前**：越界条目在解包时是否被 tar 拦下，取决于具体实现与版本；
 * 而"有没有这种条目"是我们自己就能判定的确定事实。
 */
export function listTarEntries(tarball: string): string[] {
  const r = runTar(['-tzf', tarball])
  if (!r.ok) throw new MaintenanceError(`无法读取压缩包（tar -tzf 失败）：${r.err.trim() || '未知原因'}`)
  const entries = r.out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const bad = entries.filter((e) => {
    if (e.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(e)) return true // 绝对路径
    const segs = e.split('/')
    return segs.includes('..') // 回溯段
  })
  if (bad.length > 0) {
    throw new MaintenanceError(
      `拒绝安装：压缩包含越界条目（${bad.length} 个），前几个：${bad.slice(0, 3).join(', ')}。` +
        '合法的插件包只会包含自己目录内的相对路径。',
    )
  }
  return entries
}

/** 解包后的第二道防线：整棵树不得有符号链接/特殊文件（它们能让"目录内"的东西指向目录外） */
function assertNoSymlinks(dir: string): void {
  const offenders: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) offenders.push(toPosix(relative(dir, full)))
      else if (st.isDirectory()) walk(full)
      else if (!st.isFile()) offenders.push(`${toPosix(relative(dir, full))}（非普通文件）`)
    }
  }
  walk(dir)
  if (offenders.length > 0) {
    throw new MaintenanceError(
      `拒绝安装：解包结果含符号链接或特殊文件：${offenders.slice(0, 3).join(', ')}。` +
        '外部插件不使用依赖、也不需要链接；链接会让"插件目录之外"的文件被当成插件内容。',
    )
  }
}

/** 在给定目录里定位真正的插件根：包内可能有一层顶层目录（`tar` 的常见形态） */
function locatePluginRoot(dir: string): string {
  const candidates = [dir]
  const entries = readdirSync(dir)
  if (entries.length === 1 && entries[0] !== undefined) {
    const only = join(dir, entries[0])
    if (statSync(only).isDirectory()) candidates.push(only)
  }
  for (const c of candidates) {
    try {
      parsePluginManifest(
        existsSync(join(c, 'package.json')) ? JSON.parse(readFileSync(join(c, 'package.json'), 'utf8')) : undefined,
        existsSync(join(c, 'geewiki.manifest.json'))
          ? JSON.parse(readFileSync(join(c, 'geewiki.manifest.json'), 'utf8'))
          : undefined,
      )
      return c
    } catch {
      // 继续找下一个候选
    }
  }
  throw new DiscoveryError(
    'missing_manifest',
    `压缩包内未找到合法的插件清单（找过：${candidates.map((c) => toPosix(relative(dir, c)) || '.').join(', ')}）：` +
      '需要 package.json 的 geewiki 键或 geewiki.manifest.json',
  )
}

async function downloadHttps(url: string, dest: string, maxBytes: number): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new MaintenanceError(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > maxBytes) {
    throw new MaintenanceError(`下载内容超过上限（${buf.byteLength} > ${maxBytes} 字节），已拒绝`)
  }
  writeFileSync(dest, buf)
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 规划一次安装：把来源落到临时目录、校验清单、算出基线，**但不碰目标目录**。
 *
 * 先规划后执行的理由与备份一致：安装是"看起来成功但留下半成品"的典型场景，
 * 而半成品插件目录会被下次启动的发现流程当成一个"装了但坏了"的插件报出来。
 */
export async function planInstall(options: PlanInstallOptions): Promise<InstallPlan> {
  const kind = classifySource(options.source)
  const pluginsRoot = options.pluginsRoot
  mkdirSync(pluginsRoot, { recursive: true })
  const staging = mkdtempSync(join(options.tmpRoot ?? pluginsRoot, '.gw-install-'))
  let entries: string[] = []
  let sourceDigest: string | undefined
  let root: string

  try {
    if (kind === 'dir') {
      const src = options.source
      if (!existsSync(src) || !statSync(src).isDirectory()) {
        throw new MaintenanceError(`目录来源不存在或不是目录：${src}`)
      }
      root = src
    } else {
      let tarball = options.source
      if (kind === 'url') {
        tarball = join(staging, 'download.tgz')
        sourceDigest = await downloadHttps(options.source, tarball, options.maxBytes ?? 64 * 1024 * 1024)
      } else {
        if (!existsSync(tarball)) throw new MaintenanceError(`压缩包不存在：${tarball}`)
        sourceDigest = sha256File(tarball)
      }
      entries = listTarEntries(tarball)
      const extractDir = join(staging, 'extract')
      mkdirSync(extractDir, { recursive: true })
      // `--no-same-owner/--no-same-permissions`：不要把打包者的 uid/gid 与权限带进本机
      const r = runTar(['-xzf', tarball, '-C', extractDir, '--no-same-owner', '--no-same-permissions'])
      if (!r.ok) throw new MaintenanceError(`解包失败（tar -xzf）：${r.err.trim() || '未知原因'}`)
      assertNoSymlinks(extractDir)
      root = locatePluginRoot(extractDir)
    }

    const parsed = parsePluginManifest(
      existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : undefined,
      existsSync(join(root, 'geewiki.manifest.json'))
        ? JSON.parse(readFileSync(join(root, 'geewiki.manifest.json'), 'utf8'))
        : undefined,
    )
    const dirName = options.name ?? shortNameOf(parsed.name)
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(dirName) || dirName === '.' || dirName === '..') {
      throw new MaintenanceError(`拒绝安装：目标目录名非法（${dirName}）`)
    }
    const targetDir = join(pluginsRoot, dirName)
    // 目标必须真的落在 pluginsRoot 内（对外部传入的 --name 做最后一道确认）
    if (!isInsideDir(pluginsRoot, targetDir)) {
      throw new MaintenanceError(`拒绝安装：目标目录不在插件目录内（${targetDir}）`)
    }
    return {
      kind,
      source: options.source,
      name: parsed.name,
      version: parsed.version,
      targetDir,
      wouldOverwrite: existsSync(targetDir),
      entries,
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      contentRoot: root,
      stagingRoot: staging,
    }
  } catch (err) {
    // 失败即清理暂存区，不留 `.gw-install-*` 垃圾（它们会被发现流程忽略，但会堆积）
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
}

export interface InstallResult {
  readonly dir: string
  readonly name: string
  readonly version: string
  readonly files: number
  readonly integrity: IntegrityFile
}

export interface InstallOptions extends PlanInstallOptions {
  readonly force?: boolean
  readonly now?: Date
}

/**
 * 执行安装：规划 → 搬到目标目录 → 写完整性基线。
 *
 * 顺序刻意如此：**内容先就位、基线最后写**。中途失败时留下的是一个**没有基线**的目录，
 * 它会以 `unsigned` 状态暴露出来 —— 而不是一个"看起来已校验"的假象。
 */
export async function installPlugin(options: InstallOptions): Promise<InstallResult> {
  const plan = await planInstall(options)
  /*
   * 整个执行体包在 try/finally 里，**包括"拒绝覆盖"这条提前退出**。
   * 这一条曾经写在 finally 外面，于是每次被拒绝的安装都在 `plugins/` 下留一个
   * `.gw-install-*` 目录 —— 它会被发现流程忽略（以 `.` 开头），所以**不会报任何错**，
   * 只会一路堆积。测试用例（断言"拒绝后 pluginsRoot 里只剩 demo"）把它抓了出来。
   */
  try {
    if (plan.wouldOverwrite && options.force !== true) {
      throw new MaintenanceError(
        `目标目录已存在：${plan.targetDir}。确认要覆盖请加 --force（原目录会先被移到一边，不会直接删）。`,
      )
    }

    /*
     * 把内容**先在暂存区里备好**，再一次性 rename 到目标位置。两个理由：
     * 1. `dir` 来源必须是**复制**而不是搬走 —— 用户点了一个目录，不该在安装后把它挪空；
     * 2. rename 是原子的（同文件系统），因此目标位置不会出现"解包到一半"的插件目录。
     */
    const readyDir = join(plan.stagingRoot, 'ready')
    if (plan.kind === 'dir') {
      mkdirSync(readyDir, { recursive: true })
      copyTree(plan.contentRoot, readyDir)
    } else {
      // 压缩包：`contentRoot` 就在暂存区内，直接搬（省一次全量复制）
      renameSync(plan.contentRoot, readyDir)
    }

    if (plan.wouldOverwrite && options.force === true) {
      const setAside = `${plan.targetDir}.replaced-${Date.now()}`
      renameSync(plan.targetDir, setAside)
    }
    renameSync(readyDir, plan.targetDir)

    /*
     * **内容先就位、基线最后写**：中途失败时留下的是一个**没有基线**的目录，
     * 它会以 `unsigned` 状态暴露出来 —— 而不是一个"看起来已校验"的假象。
     */
    const integrity = computeIntegrity(plan.targetDir, {
      name: plan.name,
      version: plan.version,
      source: plan.source,
      ...(options.now === undefined ? {} : { installedAt: options.now.toISOString() }),
      ...(plan.sourceDigest === undefined ? {} : { sourceDigest: plan.sourceDigest }),
    })
    writeIntegrity(plan.targetDir, integrity)
    return {
      dir: plan.targetDir,
      name: plan.name,
      version: plan.version,
      files: Object.keys(integrity.files).length,
      integrity,
    }
  } finally {
    // 无论成败都清掉暂存区：失败时留下 `.gw-install-*` 会堆积，且看起来像个坏插件目录
    rmSync(plan.stagingRoot, { recursive: true, force: true })
  }
}

/** 递归复制（外部插件不需要保留符号链接；安装路径整体拒绝链接） */
export function copyTree(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    if (name === INTEGRITY_FILE) continue
    const src = join(from, name)
    const dst = join(to, name)
    const st = lstatSync(src)
    if (st.isDirectory()) {
      mkdirSync(dst, { recursive: true })
      copyTree(src, dst)
    } else if (st.isFile()) {
      writeFileSync(dst, readFileSync(src))
    }
  }
}

/** 供 CLI 打印：把一次安装计划的要点讲清楚（含"会不会覆盖"） */
export function describePlan(plan: InstallPlan): string {
  const lines = [
    `来源类型：${plan.kind}`,
    `来源：${plan.source}`,
    `插件：${plan.name} @ ${plan.version}`,
    `目标：${plan.targetDir}${plan.wouldOverwrite ? '（**已存在，需要 --force**）' : ''}`,
  ]
  if (plan.sourceDigest) lines.push(`压缩包 sha256：${plan.sourceDigest}`)
  if (plan.entries.length > 0) lines.push(`压缩包条目数：${plan.entries.length}`)
  lines.push(`内容根：${toPosix(relative(plan.stagingRoot, plan.contentRoot)) || '.'}`)
  return lines.join('\n')
}

/**
 * 丢弃一次规划占用的暂存区。
 *
 * `planInstall` 成功时**不会**自己清理（内容还要用），所以只做规划、不安装的调用方
 * （`--dry-run`）必须显式调它 —— 否则每跑一次 dry-run 就在 `plugins/` 下留一个
 * `.gw-install-*` 目录。它们会被发现流程忽略（以 `.` 开头），但会一路堆积。
 */
export function cleanupPlan(plan: InstallPlan): void {
  rmSync(plan.stagingRoot, { recursive: true, force: true })
}
