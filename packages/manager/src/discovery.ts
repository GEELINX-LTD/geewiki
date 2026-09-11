/**
 * 外部插件发现与加载（架构 §4：插件目录 = <仓库根>/plugins/<name>/）。
 *
 * 约定（每个子目录一个插件）：
 * - 清单来源二选一：子目录 package.json 的顶层 `geewiki` 键（优先）/ 独立 geewiki.manifest.json；
 * - 入口：清单的 geewiki.entry → index.ts → index.js → src/index.ts（须存在于插件目录内）；
 * - 迁移：清单的 geewiki.migrations（目录，须存在于插件目录内）；
 * - 加载：`await import(pathToFileURL(入口))` 后取 `mod.default ?? mod`，形态为 cordis
 *   对象 `{ name, apply }`（apply 返回 dispose 函数）。
 *
 * 失败隔离：任何单个插件的清单缺失/入口缺失/路径越界/重名/加载抛错都只记录为一条
 * issue 并跳过它，绝不阻断宿主启动与其余插件的加载。
 *
 * 路径安全：入口与迁移目录 resolve 后必须仍在插件目录内（拒绝 `../` 越界），
 * 并且**还要通过真实路径（realpath）复核**——`statSync`/`existsSync` 跟随符号链接，
 * 只做词法检查时插件目录内的 symlink 可以指向目录外，从而加载执行目录外代码。
 * 说明：Node 的 ESM 动态 import 不解析目录说明符（ERR_UNSUPPORTED_DIR_IMPORT），
 * 且含 `#`/`?` 的裸绝对路径会被当作 URL 解析失败（ERR_MODULE_NOT_FOUND），
 * 故一律经 pathToFileURL 转换。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GeeWikiManifest } from '@geewiki/core'
import type { RegisteredPlugin } from './deps.js'

/** 发现过程中的跳过/失败原因（机器可读码 + 人类可读说明） */
export interface DiscoveryIssue {
  code:
    | 'missing_manifest'
    | 'invalid_manifest'
    | 'entry_not_found'
    | 'invalid_plugin_path'
    | 'invalid_plugin_dir'
    | 'duplicate_plugin'
    | 'invalid_module'
    | 'load_failed'
  /** 出问题的插件目录绝对路径 */
  dir: string
  message: string
}

export interface DiscoveryResult {
  /** 成功加载、可直接并入 registry 的插件条目 */
  plugins: RegisteredPlugin[]
  /** 被跳过的目录及其原因（供管理台/日志展示） */
  issues: DiscoveryIssue[]
}

export interface DiscoveryOptions {
  /** 插件根目录绝对路径（通常为 <仓库根>/plugins） */
  root: string
  /** 内置插件名（重名判定：外部插件不得覆盖内置插件） */
  builtinNames?: readonly string[]
  /** 日志出口（缺省 console.log / console.warn） */
  log?: (message: string) => void
}

/** 发现过程的可预期错误（携带机器可读码，供上层记为 issue） */
export class DiscoveryError extends Error {
  constructor(
    readonly code: DiscoveryIssue['code'],
    message: string,
  ) {
    super(message)
  }
}

/* --------------------------- 纯函数（可单测） --------------------------- */

/** 候选入口文件名（按优先级） */
export const ENTRY_CANDIDATES = ['index.ts', 'index.js', 'src/index.ts'] as const

/**
 * 解析插件清单（纯函数）。
 * @param pkg       插件目录 package.json 的解析结果（缺失传 undefined）
 * @param standalone geewiki.manifest.json 的解析结果（缺失传 undefined）
 * @throws DiscoveryError code=missing_manifest | invalid_manifest
 */
export function parsePluginManifest(pkg: unknown, standalone: unknown): Pick<GeeWikiManifest, 'name' | 'version' | 'geewiki'> {
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

  const pkgRecord = asRecord(pkg)
  const embedded = asRecord(pkgRecord?.['geewiki'])
  if (pkgRecord && embedded) {
    const name = typeof pkgRecord['name'] === 'string' ? pkgRecord['name'] : undefined
    if (!name) throw new DiscoveryError('invalid_manifest', 'package.json 的 geewiki 清单缺少插件名（package.json.name）')
    const version = typeof pkgRecord['version'] === 'string' ? pkgRecord['version'] : '0.0.0'
    return { name, version, geewiki: embedded as GeeWikiManifest['geewiki'] }
  }

  const standaloneRecord = asRecord(standalone)
  const standaloneMeta = asRecord(standaloneRecord?.['geewiki'])
  if (standaloneRecord && standaloneMeta) {
    const name = typeof standaloneRecord['name'] === 'string' ? standaloneRecord['name'] : undefined
    if (!name) throw new DiscoveryError('invalid_manifest', 'geewiki.manifest.json 缺少 name 字段')
    const version = typeof standaloneRecord['version'] === 'string' ? standaloneRecord['version'] : '0.0.0'
    return { name, version, geewiki: standaloneMeta as GeeWikiManifest['geewiki'] }
  }

  throw new DiscoveryError(
    'missing_manifest',
    '未找到插件清单：package.json 中缺少 geewiki 键，且没有 geewiki.manifest.json',
  )
}

/** 候选路径是否位于目录内（防 `../` 路径穿越；相等视为不在"内"） */
export function isInsideDir(dir: string, candidate: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate))
  // rel === '' 表示两者相同；以 '..' 开头或为绝对路径（跨盘符）都表示越界
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && !isAbsolute(rel)
}

/** realpath（跟随符号链接）；失败（不存在/无权限/悬空链接）返回 null */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * 真实路径版的"在目录内"判定：**两侧都先 realpath**。
 * 根目录侧同样必须做，否则 `plugins/` 自身是符号链接时会把全部插件误判为越界。
 * 任一侧 realpath 失败即视为"不在目录内"（宁保守勿放行）。
 */
export function isInsideDirReal(dir: string, candidate: string): boolean {
  const realDir = realpathOrNull(dir)
  if (!realDir) return false
  const realCandidate = realpathOrNull(candidate)
  if (!realCandidate) return false
  return isInsideDir(realDir, realCandidate)
}

/**
 * 解析插件入口文件（纯探测，不加载）。
 * @param dir   插件目录绝对路径
 * @param entry 清单声明的入口（相对路径；越界则抛 invalid_plugin_path）
 * @returns 入口绝对路径；均不存在时返回 undefined
 */
export function resolvePluginEntry(dir: string, entry?: string): string | undefined {
  const candidates = entry ? [entry, ...ENTRY_CANDIDATES] : [...ENTRY_CANDIDATES]
  for (const candidate of candidates) {
    const abs = resolve(dir, candidate)
    if (!isInsideDir(dir, abs)) {
      throw new DiscoveryError('invalid_plugin_path', `入口 "${candidate}" 越出插件目录（拒绝路径穿越）`)
    }
    if (existsSync(abs) && statSync(abs).isFile()) {
      // 词法检查之后再用真实路径复核：命中可能是插件目录内的符号链接 → 指向目录外则不加载
      if (!isInsideDirReal(dir, abs)) {
        throw new DiscoveryError(
          'invalid_plugin_path',
          `入口 "${candidate}" 的真实路径越出插件目录（拒绝符号链接穿越）`,
        )
      }
      return abs
    }
  }
  return undefined
}

export interface PluginDirScan {
  /** 候选插件目录绝对路径（含符号链接指向的目录，按名称排序） */
  dirs: string[]
  /** 扫描期问题（根目录不可读、符号链接目标不是目录等） */
  issues: DiscoveryIssue[]
}

/**
 * 扫描插件根目录：忽略隐藏目录与下划线前缀目录。
 *
 * - 符号链接指向目录时**纳入扫描**（用 symlink 挂载插件目录是合法用法，不能静默忽略）；
 * - 根目录不可读（EACCES 等）只记 issue 并返回空列表：否则异常会冒泡到组合根，
 *   被当成启动崩溃写 crash.marker + exit(1)，在容器里变成重启循环并反复清空会话层。
 */
export function scanPluginDirs(root: string): PluginDirScan {
  const issues: DiscoveryIssue[] = []
  if (!existsSync(root)) return { dirs: [], issues }

  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    issues.push({
      code: 'invalid_plugin_dir',
      dir: root,
      message: `插件根目录不可读，已跳过全部外部插件: ${(err as Error).message}`,
    })
    return { dirs: [], issues }
  }

  const dirs: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue
    const abs = join(root, e.name)
    if (e.isDirectory()) {
      dirs.push(abs)
      continue
    }
    if (!e.isSymbolicLink()) continue
    // statSync 跟随符号链接；悬空链接会抛错
    let target: Stats
    try {
      target = statSync(abs)
    } catch (err) {
      issues.push({ code: 'invalid_plugin_dir', dir: abs, message: `符号链接无法解析: ${(err as Error).message}` })
      continue
    }
    if (target.isDirectory()) dirs.push(abs)
    else issues.push({ code: 'invalid_plugin_dir', dir: abs, message: '符号链接目标不是目录，已跳过' })
  }
  return { dirs: dirs.sort(), issues }
}

/** 列出插件根目录下的候选插件目录（忽略隐藏目录与下划线前缀目录），按名称排序 */
export function listPluginDirs(root: string): string[] {
  return scanPluginDirs(root).dirs
}

/* ------------------------------ 加载（IO） ------------------------------ */

function readJsonIfExists(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (err) {
    throw new DiscoveryError('invalid_manifest', `${file} 解析失败: ${(err as Error).message}`)
  }
}

/**
 * 扫描并加载外部插件：单个插件失败只记 issue，不影响其余插件与宿主启动。
 */
export async function loadExternalPlugins(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { root, builtinNames = [] } = options
  const log = options.log ?? ((msg: string) => console.log(msg))
  const warn = (msg: string) => console.warn(msg)
  const result: DiscoveryResult = { plugins: [], issues: [] }
  const takenNames = new Set<string>(builtinNames)

  const scan = scanPluginDirs(root)
  result.issues.push(...scan.issues)
  const dirs = scan.dirs
  if (dirs.length === 0) return result

  for (const dir of dirs) {
    try {
      const manifest = parsePluginManifest(
        readJsonIfExists(join(dir, 'package.json')),
        readJsonIfExists(join(dir, 'geewiki.manifest.json')),
      )
      if (takenNames.has(manifest.name)) {
        throw new DiscoveryError(
          'duplicate_plugin',
          `插件名 ${manifest.name} 已被占用（内置插件或先前发现的外部插件），跳过该目录`,
        )
      }

      const entryAbs = resolvePluginEntry(dir, manifest.geewiki.entry)
      if (!entryAbs) {
        throw new DiscoveryError(
          'entry_not_found',
          `未找到入口文件（已尝试 ${manifest.geewiki.entry ?? ''}${manifest.geewiki.entry ? ' → ' : ''}${ENTRY_CANDIDATES.join(' → ')}）`,
        )
      }

      // 迁移目录：声明则必须位于插件目录内；不存在仅告警（该插件自管表结构）。
      // 支持 string（通用）与 { default?, postgres? }（按方言）两种写法，逐个变体做同样的
      // 路径安全校验——**安全校验不能被"新写法"绕过**。
      const migrationsDirs: Record<string, string> = {}
      const declaredMigrations = manifest.geewiki.migrations
      const migrationVariants: Array<[string, string]> =
        typeof declaredMigrations === 'string'
          ? [['default', declaredMigrations]]
          : declaredMigrations
            ? Object.entries(declaredMigrations).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              )
            : []
      for (const [dialectKey, rel] of migrationVariants) {
        const abs = resolve(dir, rel)
        if (!isInsideDir(dir, abs)) {
          throw new DiscoveryError(
            'invalid_plugin_path',
            `迁移目录 "${rel}"（${dialectKey}）越出插件目录（拒绝路径穿越）`,
          )
        }
        if (!existsSync(abs)) {
          warn(`[manager:discovery] ${manifest.name}: 迁移目录不存在，已忽略（${dialectKey}）: ${abs}`)
        } else if (!isInsideDirReal(dir, abs)) {
          // 符号链接越界：只忽略该迁移目录并记 issue，不因此拒绝整个插件
          const message = `迁移目录 "${rel}"（${dialectKey}）的真实路径越出插件目录（拒绝符号链接穿越），已忽略该迁移目录`
          result.issues.push({ code: 'invalid_plugin_path', dir, message })
          warn(`[manager:discovery] ${manifest.name}: ${message}`)
        } else {
          migrationsDirs[dialectKey] = abs
        }
      }

      const imported: unknown = await import(pathToFileURL(entryAbs).href)
      const mod = ((imported as { default?: unknown }).default ?? imported) as {
        name?: unknown
        apply?: unknown
        Config?: unknown
      }
      if (typeof mod.apply !== 'function') {
        throw new DiscoveryError('invalid_module', `入口 ${entryAbs} 未导出 cordis 插件（缺少 apply 方法）`)
      }

      takenNames.add(manifest.name)
      result.plugins.push({
        name: manifest.name,
        manifest: { name: manifest.name, version: manifest.version, geewiki: manifest.geewiki },
        module: mod as RegisteredPlugin['module'],
        migrationsDirs: Object.keys(migrationsDirs).length > 0 ? migrationsDirs : undefined,
        source: 'external',
        dir,
      })
      log(`[manager:discovery] 已发现外部插件 ${manifest.name}@${manifest.version}（${relative(root, dir) || '.'}）`)
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : 'load_failed'
      const message = err instanceof Error ? err.message : String(err)
      result.issues.push({ code, dir, message })
      warn(`[manager:discovery] 跳过插件目录 ${dir}（${code}）: ${message}`)
    }
  }

  return result
}
