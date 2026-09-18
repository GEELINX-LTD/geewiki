/**
 * ★ F10：插件权限声明的用例。
 *
 * ## 这一层要防的是什么
 * 权限声明是**给人看的**（宿主不做强制 —— 同进程同权限，见 `PluginPermission` 的说明）。
 * 正因为它不参与任何运行期判定，它最容易退化成**装饰**：声明写错了、漏了、或者随着
 * 代码演进而过时，都**不会有任何症状**。一条永远不会被任何东西读到的声明，
 * 与一行注释没有区别，而注释至少不会让人产生"我检查过了"的错觉。
 *
 * 所以本文件钉两件事，且第二件是本项真正的价值所在：
 * 1. **声明的读入路径是活的**：非法取值被拒绝并告警（而不是静默收下变成垃圾项）、
 *    排序稳定、能经 `GET /api/plugins` 到达管理台；
 * 2. **声明与实际用法一致**（源码级）：一个真的 import 了 `node:fs` / 读 `process.env` /
 *    发起 `fetch` 的插件，必须在清单里声明对应权限。**这条让声明随代码演进自动回归** ——
 *    有人给某个插件加了文件读写却忘了改清单，会在这里变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { PLUGIN_PERMISSIONS, type GeeWikiManifest } from '@geewiki/core'
import { GeeWikiManager } from '../src/index.js'
import type { RegisteredPlugin } from '../src/deps.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

/* ------------------------------ 夹具 ------------------------------ */

interface Env {
  dir: string
  baseFile: string
  sessionFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-perm-'))
  return {
    dir,
    baseFile: join(dir, 'plugins.base.json'),
    sessionFile: join(dir, 'plugins.session.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 只声明需要的字段；其余可选字段缺失即为管理台的回退路径 */
function plugin(name: string, geewiki: Partial<GeeWikiManifest['geewiki']> = {}): RegisteredPlugin {
  return {
    name,
    manifest: { name, version: '1.0.0', geewiki: { requires: [], ...geewiki } },
    module: { name, apply: () => () => {} },
  }
}

const managerFor = (env: Env, registry: RegisteredPlugin[]): GeeWikiManager =>
  new GeeWikiManager(new Context(), {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
  })

function captureWarn<T>(run: () => T): { value: T; warned: string[] } {
  const warned: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    return { value: run(), warned }
  } finally {
    console.warn = orig
  }
}

/* ==================== 1. 声明经快照到达管理台 ==================== */

test('★ F10：权限声明出现在 GET /api/plugins 的快照里，按危险度排序且去重', () => {
  const env = makeEnv()
  try {
    const manager = managerFor(env, [
      plugin('@t/heavy', { permissions: ['secrets', 'fs:read', 'fs:read', 'net'] }),
      plugin('@t/clean'),
    ])
    const snaps = manager.snapshot()
    const heavy = snaps.find((s) => s.name === '@t/heavy')
    assert.ok(heavy)
    // 顺序即 PLUGIN_PERMISSIONS 的"从轻到重"：管理台直接渲染这个数组
    assert.deepEqual(heavy.permissions, ['fs:read', 'net', 'secrets'], '应按危险度升序且去重')
    assert.deepEqual(snaps.find((s) => s.name === '@t/clean')?.permissions, [], '未声明 ⇔ 空数组，不是 undefined')
  } finally {
    env.cleanup()
  }
})

test('★ F10：未知权限取值被**拒绝并告警**，不静默收下', () => {
  const env = makeEnv()
  try {
    const manager = managerFor(env, [
      plugin('@t/typo', { permissions: ['fs:raed', 'fs:read'] as never }),
      plugin('@t/notarray', { permissions: 'net' as never }),
    ])
    const { value: snaps, warned } = captureWarn(() => manager.snapshot())
    /*
     * 判据是"拒绝"，不是"尽量理解"：静默接受任意字符串会让 `fs:raed`（拼写错误）、
     * `FS:read`（大小写）、`filesystem`（自造名）都变成一份**看起来已经声明过**的清单，
     * 而没有任何消费方能认出它们。把错误变成可见的，与"能力名必须含 `/`"是同一类设计。
     */
    assert.deepEqual(snaps.find((s) => s.name === '@t/typo')?.permissions, ['fs:read'], '合法项保留、非法项剔除')
    assert.deepEqual(snaps.find((s) => s.name === '@t/notarray')?.permissions, [])
    assert.equal(warned.length, 2, `两类非法输入各告警一次，实际：${warned.join(' | ')}`)
    assert.ok(warned.some((w) => w.includes('fs:raed')))
    assert.ok(warned.some((w) => w.includes('不是数组')))
    // 告警里必须给出合法取值，否则作者不知道该写什么
    assert.ok(warned.every((w) => w.includes('fs:read')))
  } finally {
    env.cleanup()
  }
})

test('★ F10：权限清单本身的取值集合是封闭且有序的（消费方依赖顺序）', () => {
  assert.deepEqual([...PLUGIN_PERMISSIONS], ['fs:read', 'env', 'net', 'fs:write', 'process', 'secrets'])
  // 升序 = 危险度递增；`secrets` 与 `process` 排在最后（最难事后收拾）
  assert.equal(PLUGIN_PERMISSIONS[0], 'fs:read')
  assert.equal(PLUGIN_PERMISSIONS[PLUGIN_PERMISSIONS.length - 1], 'secrets')
})

/* ============ 2. 声明必须与实际用法一致（源码级，随代码演进回归） ============ */

/** 去注释：文档里提到 `node:fs` / `process.env` 是常事，不能因此判定为"使用了" */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 去掉**类型导入**行后再看用法。
 *
 * `import type { IncomingMessage } from 'node:http'` 是纯类型，运行期不碰任何东西 ——
 * 实测这正是 `plugin-auth` / `plugin-org` / `plugin-ai-assistant` 被误判为"发起网络请求"
 * 的原因（它们只是用了 `ServerResponse` / `IncomingMessage` 的类型）。误判会导致
 * 为了过测试而**多声明**，那与漏声明一样是在往清单里灌水。
 */
function runtimeCode(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('import type'))
    .join('\n')
}

test('★ F10：真正使用了跨界能力的插件，其清单必须声明对应权限', () => {
  const pkgRoot = join(repoRoot, 'packages')
  const problems: string[] = []
  let checked = 0

  for (const pkg of readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const srcDir = join(pkgRoot, pkg.name, 'src')
    let files: string[]
    try {
      files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
    } catch {
      continue
    }
    const raw = files.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n')
    // 只审计**是插件**的包：没有清单的包（core / manager / web）不受这份声明约束
    if (!/export const manifest|httpManifest/.test(raw)) continue
    checked += 1

    const code = runtimeCode(stripComments(raw))
    const declared = new Set(
      [...raw.matchAll(/permissions:\s*\[([^\]]*)\]/g)]
        .flatMap((m) => (m[1] ?? '').split(','))
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
    )

    const needs: Array<[RegExp, string, string]> = [
      [/from 'node:fs(\/promises)?'/, 'fs', "至少一项 fs:read / fs:write"],
      [/process\.env/, 'env', 'env'],
      [/\bfetch\(|createServer\(/, 'net', 'net'],
    ]
    for (const [re, kind, label] of needs) {
      if (!re.test(code)) continue
      const ok = kind === 'fs' ? declared.has('fs:read') || declared.has('fs:write') : declared.has(label)
      if (!ok) {
        problems.push(
          `${pkg.name}: 运行期使用了 ${kind}（${label}）但清单未声明` +
            `（当前声明：${declared.size === 0 ? '（无）' : [...declared].join(', ')}）`,
        )
      }
    }
  }

  assert.ok(checked >= 8, `只审计到 ${checked} 个带清单的插件包，明显偏少 —— 扫描逻辑可能失效了`)
  assert.deepEqual(
    problems,
    [],
    '以下插件的权限声明与实际用法不一致：\n' +
      problems.map((p) => `  ${p}`).join('\n') +
      '\n声明是给人看的（宿主不强制），所以它**只能靠这条守卫**保持与代码同步。',
  )
})

test('★ F10：权限声明只出现在清单里（不得散落在源码其它位置当配置用）', () => {
  /*
   * 判据的边界：本项**不做强制**，所以也不该出现"某个模块读 permissions 来做判定"
   * 的用法 —— 那会给人"它是个闸门"的错觉，而实际上任何插件都能绕过它。
   * 目前唯一合法的消费点是 manager 的读入与快照（见本文件第 1 组用例）。
   */
  const consumers: string[] = []
  for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const srcDir = join(repoRoot, 'packages', pkg.name, 'src')
    let files: string[]
    try {
      files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
    } catch {
      continue
    }
    for (const f of files) {
      const code = stripComments(readFileSync(join(srcDir, f), 'utf8'))
      // 只找"把 permissions 当判据用"的形态（能读出来 → 参与分支）
      if (/geewiki\.permissions/.test(code) && pkg.name !== 'manager') consumers.push(`${pkg.name}/src/${f}`)
    }
  }
  assert.deepEqual(consumers, [], '这些文件把 permissions 当判据用了 —— 它不是闸门（宿主不做强制），别给它这个错觉')
})

test('★ F10：写一个未声明的权限字段不会被静默丢弃（快照必须能反映它）', () => {
  // 反向确认：空声明与缺字段在快照里都是 `[]`，但**字段本身必须存在**，
  // 否则管理台无法区分"没声明"与"这个管理台版本还不认识 permissions"
  const env = makeEnv()
  try {
    const snaps = managerFor(env, [plugin('@t/x')]).snapshot()
    assert.ok('permissions' in (snaps[0] ?? {}), 'permissions 必须是快照的稳定字段')
  } finally {
    env.cleanup()
  }
})
