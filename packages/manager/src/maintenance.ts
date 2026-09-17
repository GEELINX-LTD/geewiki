/**
 * ★ 优化点 6：仓库级维护——`tmp/` 暂存目录的**安全**清理。
 *
 * ## 为什么"删一个 gitignore 的目录"也值得写成受测代码
 * 递归删除是**不可逆**的，而且它的失败模式不是"报错"，是"删掉了不该删的东西"。
 * `tmp/` 与 `data/` 只差一个字，而后者是本机的真实数据（默认 SQLite 数据库）。
 * 所以这里把**判据**（哪些条目该删）做成纯函数，把**IO 外壳**（读目录 / 真删）分开，
 * 与 `watchdog.ts` 的"纯决策 + IO 外壳"同构。
 *
 * ## 四道安全闸门
 * 1. **默认不删**：`planCleanup` 只产出计划；真删要显式调 `deleteTempEntries`。
 *    CLI 因此默认 dry-run，`--yes` 才动手。
 * 2. **`tmp` 本身必须是仓库内的真实目录**：若它被换成指向仓库外的符号链接，
 *    递归删除就会删到仓库外——这与 discovery 的 `realpathSync` 防穿越是同一条教训
 *    （**判据必须是 realpath 后的包含关系，不是字符串前缀**，否则 `..` 与符号链接都能绕过）。
 * 3. **只删 `tmp/` 的条目，不删 `tmp/` 自己**：目录本身留着，下次运行不必重建。
 * 4. **不碰 `data/` / `config/` / 缓存目录**：它们不是暂存区，且本模块根本没有接受
 *    这些路径的参数——"不碰"是靠**接口没有这个口子**保证的，不是靠自觉。
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

/** 维护类操作的错误（与 `DiscoveryError`/`ManagerError` 同风格：可预期、可直接打印） */
export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MaintenanceError'
  }
}

/**
 * 人类可读的体积（用于 CLI 输出；不做本地化，运维看得懂即可）。
 *
 * 非法输入返回 `'—'` 而**不是** `String(bytes)`：本仓库对"把 NaN 打到界面上"有过明确裁决
 * （见 `designSystem.test.ts` 对 `formatUptime` 的同类断言）——「NaN 秒」「NaN B」这类文案
 * 只会让看的人多花时间去怀疑是自己看错了，而不是去查真因。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${i === 0 ? String(n) : n.toFixed(1)} ${units[i]}`
}

/** `tmp/` 下的一个条目（已探明体积与时间） */
export interface TempEntry {
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
  /** 是符号链接（删除它只删链接本身，但要在报告里说清楚） */
  readonly isSymlink: boolean
}

export interface CleanupPlan {
  readonly targets: readonly TempEntry[]
  readonly skipped: readonly { readonly entry: TempEntry; readonly reason: string }[]
  readonly targetBytes: number
  readonly totalBytes: number
}

/**
 * 决定哪些条目该删（**纯函数**，不碰文件系统——这是本模块值得单测的部分）。
 *
 * @param olderThanMs 只删 mtime 早于 `now - olderThanMs` 的条目；`0` 表示不设时间限制。
 *   默认给一个非零值（CLI 是 1 天）是**刻意的**：验证脚本常常正在往 `tmp/` 里写东西，
 *   一个"上来就全删"的默认会把正在跑的验证搞坏，而症状是几十分钟后才出现的诡异失败。
 */
export function planCleanup(
  entries: readonly TempEntry[],
  options: { readonly now: number; readonly olderThanMs: number; readonly protect?: readonly string[] },
): CleanupPlan {
  const protect = new Set(options.protect ?? ['.gitignore', '.keep'])
  const targets: TempEntry[] = []
  const skipped: { entry: TempEntry; reason: string }[] = []
  const cutoff = options.olderThanMs > 0 ? options.now - options.olderThanMs : Number.POSITIVE_INFINITY
  for (const e of entries) {
    if (protect.has(e.name)) {
      skipped.push({ entry: e, reason: '受保护的名字（.gitignore/.keep 一类占位文件）' })
      continue
    }
    if (e.mtimeMs > cutoff) {
      skipped.push({ entry: e, reason: '太新（可能在用；用 --all 可忽略时间限制）' })
      continue
    }
    targets.push(e)
  }
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0)
  return {
    targets,
    skipped,
    targetBytes: targets.reduce((s, e) => s + e.bytes, 0),
    totalBytes,
  }
}

/** 递归求体积。**不跟随符号链接**（跟随会走出 `tmp/`，甚至走进环）。 */
function sizeOf(path: string): number {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size
  let sum = 0
  for (const name of readdirSync(path)) sum += sizeOf(join(path, name))
  return sum
}

/** 读出 `tmp/` 的条目（含体积、mtime、是否符号链接） */
export function readTempEntries(dir: string): TempEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      let st: ReturnType<typeof lstatSync> | undefined
      try {
        st = lstatSync(path)
      } catch {
        st = undefined
      }
      return {
        name,
        path,
        bytes: sizeOf(path),
        mtimeMs: st?.mtimeMs ?? 0,
        isSymlink: st?.isSymbolicLink() ?? false,
      }
    })
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * 闸门 2：确认 `tmpDir` 是**仓库内**的真实目录。
 *
 * 判据用 `relative()` 而不是 `startsWith`：`/repo-evil` 会通过 `startsWith('/repo')`。
 * 且两侧都先 `realpathSync`（目录不存在时退化为 `resolve`），否则符号链接能绕过包含性检查。
 */
export function assertSafeTempDir(tmpDir: string, repoRoot: string): string {
  const abs = resolve(tmpDir)
  if (!existsSync(abs)) return abs
  const real = realpathSync(abs)
  const realRoot = realpathSync(resolve(repoRoot))
  if (basename(real) !== 'tmp') {
    throw new MaintenanceError(
      `拒绝操作：${real} 的目录名不是 "tmp"（本模块只清理仓库的暂存目录，不做通用删除工具）`,
    )
  }
  const rel = relative(realRoot, real)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new MaintenanceError(
      `拒绝操作：${real} 不在仓库根 ${realRoot} 之内` +
        '（若 tmp/ 是指向仓库外的符号链接，递归删除会删到仓库外）',
    )
  }
  return real
}

/** 真删（调用方应先把 `planCleanup` 的结果展示给用户）。返回删除的条目数。 */
export function deleteTempEntries(plan: CleanupPlan): number {
  let n = 0
  for (const e of plan.targets) {
    // `force` 让"文件已不在"成为成功；`recursive` 处理目录。
    // 刻意**不**用 `rm -rf` 拼字符串：路径含空格/特殊字符时会出事。
    rmSync(e.path, { recursive: true, force: true })
    n += 1
  }
  return n
}

/** 汇总信息（供 CLI 打印；把"我碰了什么、没碰什么"讲清楚） */
export function summarize(plan: CleanupPlan): string {
  const lines = [
    `暂存目录合计 ${formatBytes(plan.totalBytes)}（${plan.targets.length + plan.skipped.length} 项）`,
    `计划删除 ${plan.targets.length} 项，可释放 ${formatBytes(plan.targetBytes)}`,
  ]
  if (plan.skipped.length > 0) {
    lines.push(`保留 ${plan.skipped.length} 项：`)
    for (const s of plan.skipped.slice(0, 10)) lines.push(`  - ${s.entry.name}（${s.reason}）`)
    if (plan.skipped.length > 10) lines.push(`  …另有 ${plan.skipped.length - 10} 项`)
  }
  lines.push('明确不碰：data/（真实数据）、config/、.pnpm-store/、.npm-cache/')
  return lines.join('\n')
}

/** 供调用方判断目录是否存在（避免各处重复 import fs） */
export const dirExists = (p: string): boolean => {
  if (!existsSync(p)) return false
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
