/**
 * 内建插件的**迁移目录真源**自检（node:test + tsx）。
 * 运行：pnpm --filter @geewiki/server test（根 pnpm test 一并执行）
 *
 * 为什么必须有本文件：此前内建插件的迁移目录是在组合根 `defaultRegistry()` 里**各自硬编码**
 * 的，而插件 manifest 里写的 `geewiki.migrations` 只对**外部**插件（走 discovery）生效。
 * 同一件事有两个真源，后果是：
 * 1. 每个新内建插件都要记得在注册表里补一行 `migrationsDirs`，**漏了就静默无迁移**
 *    （@geewiki/wiki 就漏过，只能在 apply() 里自行 migrate 绕过）；
 * 2. manifest 里写的 `migrations` 对内置插件**不生效**，读者会被误导；
 * 3. 两处不一致时**没有任何测试能发现**——本文件就是补上这个缺失的判据。
 *
 * 判据（互不重叠，各自能独立变红）：
 * A. 每个内置条目的每个迁移目录**必须真实存在**（目录不存在是另一类静默故障）；
 * B. manifest 已声明 `migrations` 的插件，注册表实际使用的目录必须**等于**在真实磁盘包根上
 *    解析该声明所得（用 `packages/<dir>/package.json` 的 name 定位包根，与运行时无关）；
 * C. manifest 未声明 `migrations` 的插件必须**恰好**是已知的回退清单——一旦插件自己补上声明，
 *    本用例会失败并提醒把回退项删掉，避免"回退"退化成永久存在的第二个真源；
 * D. 反向覆盖：manifest 声明了迁移、但注册表没给出目录 ⇒ 失败（"漏写"这一类）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultRegistry } from '../src/index.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/**
 * manifest **未**声明 `migrations` 的内建插件，及其在注册表里由回退补齐的方言。
 * 这是唯一允许的例外清单；插件补上声明后本表必须相应清空（用例 C 会强制）。
 */
const MANIFEST_MIGRATION_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  '@geewiki/postgres': ['postgres'],
  '@geewiki/wiki': ['sqlite'],
}

/**
 * 在真实磁盘上按 package.json 的 name 定位插件包根；找不到返回 `undefined`。
 *
 * 刻意**不**用 `require.resolve('@geewiki/<pkg>/package.json')`：各包的 `exports` 只映射 `'.'`，
 * 实测该写法与裸 specifier 解析均 MODULE_NOT_FOUND。也刻意**不**复用运行时的 `packageRootOf()`，
 * 否则就是拿实现验证实现（同义反复）——这里独立地扫目录。
 *
 * 注意：**插件名与包名不总是一致**（如清单名 `@geewiki/http` 位于包 `@geewiki/server`），
 * 故找不到时返回 undefined 由调用方降级处理，而不是断言失败。
 */
function packageRootByName(name: string): string | undefined {
  for (const dirent of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const pkgFile = join(PACKAGES_DIR, dirent.name, 'package.json')
    if (!existsSync(pkgFile)) continue
    const parsed = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: unknown }
    if (parsed.name === name) return join(PACKAGES_DIR, dirent.name)
  }
  return undefined
}

/** 按插件名定位包根；定位不到即失败（用于"必须能定位"的用例） */
function requirePackageRoot(name: string): string {
  const root = packageRootByName(name)
  assert.ok(root, `找不到名为 ${name} 的包（packages/*/package.json 里没有匹配项）`)
  return root
}

/** 清单声明的迁移目录：string ⇒ ['default']；对象 ⇒ 其字符串值的键 */
function declaredDialects(manifest: { geewiki: { migrations?: unknown } }): string[] {
  const declared = manifest.geewiki.migrations
  if (typeof declared === 'string') return ['default']
  if (declared && typeof declared === 'object') {
    return Object.entries(declared as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k]) => k)
  }
  return []
}

/** 清单声明的迁移目录：string ⇒ 原串；对象 ⇒ 键 → 值 */
function declaredSpec(manifest: { geewiki: { migrations?: unknown } }): Record<string, string> {
  const declared = manifest.geewiki.migrations
  if (typeof declared === 'string') return { default: declared }
  if (declared && typeof declared === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  }
  return {}
}

test('A. 每个内置插件声明的迁移目录都真实存在', () => {
  const entries = defaultRegistry(null)
  const checked: string[] = []
  for (const entry of entries) {
    for (const [dialect, dir] of Object.entries(entry.migrationsDirs ?? {})) {
      assert.ok(existsSync(dir), `${entry.name} 的 ${dialect} 迁移目录不存在: ${dir}`)
      checked.push(`${entry.name}/${dialect}`)
    }
  }
  // 守卫：断言本用例确实覆盖到了迁移目录（否则注册表全空也会"通过"）
  assert.ok(checked.length >= 4, `迁移目录覆盖过少（${checked.length}）：${checked.join(', ')}`)
})

test('B. manifest 已声明 migrations 的插件：注册表目录 === 在真实包根上解析该声明所得', () => {
  const entries = defaultRegistry(null)
  const verified: string[] = []
  for (const entry of entries) {
    const spec = declaredSpec(entry.manifest)
    if (Object.keys(spec).length === 0) continue // 未声明 ⇒ 归用例 C 管
    const root = requirePackageRoot(entry.name)
    for (const [dialect, rel] of Object.entries(spec)) {
      const expected = resolve(root, rel)
      const actual = entry.migrationsDirs?.[dialect]
      assert.equal(
        actual,
        expected,
        `${entry.name} 的 ${dialect} 迁移目录与 manifest 声明不一致：` +
          `注册表=${String(actual)}，manifest("${rel}") 解析=${expected}`,
      )
      verified.push(`${entry.name}/${dialect}`)
    }
    // 反向覆盖（用例 D 的内联形态）：manifest 声明了却查不到目录 ⇒ 就是"漏写"
    for (const dialect of declaredDialects(entry.manifest)) {
      assert.ok(
        entry.migrationsDirs?.[dialect],
        `${entry.name} 在 manifest 里声明了 ${dialect} 迁移，但注册表没有给出该方言的目录（漏写）`,
      )
    }
  }
  assert.ok(verified.length >= 2, `没有任何插件走过"manifest 声明"这条路径（${verified.length}）`)
})

test('C. manifest 未声明 migrations 的插件必须恰好是已知回退清单', () => {
  const entries = defaultRegistry(null)
  const gaps = entries
    .filter((e) => Object.keys(declaredSpec(e.manifest)).length === 0 && e.migrationsDirs)
    .map((e) => e.name)
    .sort()
  assert.deepEqual(
    gaps,
    Object.keys(MANIFEST_MIGRATION_FALLBACKS).sort(),
    'manifest 未声明迁移却有迁移目录的插件集合发生变化：' +
      '若某插件已在 manifest 里补上声明，请从 MANIFEST_MIGRATION_FALLBACKS 删除它',
  )
  // 回退清单里的插件必须真的还有回退（否则注册表等于没迁移）
  for (const [name, dialects] of Object.entries(MANIFEST_MIGRATION_FALLBACKS)) {
    const entry = entries.find((e) => e.name === name)
    assert.ok(entry, `回退清单里的 ${name} 不在注册表中`)
    for (const dialect of dialects) {
      assert.ok(entry?.migrationsDirs?.[dialect], `${name} 的 ${dialect} 回退目录丢失`)
    }
  }
})

test('D. 解析结果不越过所属包/仓库（迁移目录必须在包内）', () => {
  const entries = defaultRegistry(null)
  let checked = 0
  for (const entry of entries) {
    const dirs = Object.entries(entry.migrationsDirs ?? {})
    if (dirs.length === 0) continue
    // ① 仓库级containment：迁移目录必须落在 packages/ 下的某个插件包里
    const pkgRoot = packageRootByName(entry.name)
    for (const [dialect, dir] of dirs) {
      assert.ok(
        dir.startsWith(PACKAGES_DIR + '/'),
        `${entry.name} 的 ${dialect} 迁移目录不在 packages/ 下：${dir}`,
      )
      // ② 能定位到包根时做更强的断言：必须在该插件包内
      if (pkgRoot) {
        assert.ok(
          dir === pkgRoot || dir.startsWith(pkgRoot.replace(/\/+$/, '') + '/'),
          `${entry.name} 的 ${dialect} 迁移目录越出包根：${dir}（包根 ${pkgRoot}）`,
        )
      }
      checked++
    }
  }
  assert.ok(checked >= 4, `迁移目录覆盖过少（${checked}）`)
})
