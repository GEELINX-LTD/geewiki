/**
 * ★ F19：`db` 服务的**双轨消费纪律**守卫。
 *
 * ## 这条守卫要防的失效（在真 PostgreSQL 上被抓到两次）
 * `DatabaseAdapter`（同步，为 better-sqlite3 而生）与 `DatabaseAdapterAsync`（为 pg 而生）
 * 是**两条轨道**，靠 `asAsync()` 归一化。于是所有"按同步接口写、却拿到异步适配器"的代码
 * 都会在 SQLite 上完全正常、在 PostgreSQL 上炸——而且报错形式各不相同：
 *
 * ```
 * [@geewiki/builtin-docs] 加载失败: db.query(...).map is not a function
 * ```
 *
 * 原因：`db.query()` 在 PG 上返回 **Promise**，对它做 `[0]` 得到 `undefined`、
 * 做 `.map()` 直接 **TypeError**。相同的一类还在 `plugin-ai-summary` 上存在
 * （`db.query(...)[0]`），只是因为该路径没被走到而没在日志里露头。
 *
 * **为什么必须静态兜住**：单测跑在 SQLite 上（`db-sqlite` 是默认后端），
 * 这类缺陷**永远不会**在 `pnpm test` 里出现。等到 PG 部署上暴露时，
 * 报错是 `xxx is not a function` 这种离原因很远的形式。
 *
 * ## 判据
 * 任何**在代码里**取 `ctx.get('db')` 的源文件，必须同时出现 `asAsync`
 * ——即"我把这个句柄归一化过"。注释里提到 `get('db')` 不算（本仓库大量文档在解释
 * 这件事，把它们算进来会立刻产生一堆误报，而**误报的守卫会被顺手删掉**）。
 *
 * 手工核对该判据时用的就是本文件里的 `codeOnly()`：先剥注释，再找 `get('db')`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoRootOf } from '@geewiki/core'

const REPO_ROOT = repoRootOf(import.meta.url)

/** 剥掉块注释与整行注释。判据必须能区分"代码里写了"与"注释里提到" */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** 递归收集 `packages/<pkg>/src/**\/*.ts` */
function sourceFiles(): string[] {
  const out: string[] = []
  const packagesDir = join(REPO_ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src')
    if (!statSync(join(packagesDir, pkg)).isDirectory()) continue
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
      }
    }
    walk(srcDir)
  }
  return out
}

test('★ F19：取用 db 服务的源文件必须用 asAsync 归一化（否则在 PG 上必炸）', () => {
  const offenders: string[] = []
  const consumers: string[] = []

  for (const file of sourceFiles()) {
    const code = codeOnly(readFileSync(file, 'utf8'))
    if (!code.includes("get('db')")) continue
    const rel = file.slice(REPO_ROOT.length + 1).split('\\').join('/')
    consumers.push(rel)
    if (!code.includes('asAsync')) offenders.push(rel)
  }

  // 先断言"确实枚举到了消费方"：判据若写坏（例如正则失配），
  // 后面的空集断言会**静默通过**——那比没有守卫更糟。
  assert.ok(consumers.length >= 8, `只枚举到 ${consumers.length} 个 db 消费方，判据可能已失效`)
  for (const expected of ['packages/plugin-wiki/src/index.ts', 'packages/plugin-builtin-docs/src/index.ts']) {
    assert.ok(consumers.includes(expected), `枚举结果里应包含 ${expected}`)
  }

  assert.deepEqual(
    offenders,
    [],
    '以下文件在代码里取用了 db 服务却没有用 asAsync 归一化。默认后端是 SQLite（同步），' +
      '所以 `db.query(...)[0]` 与 `db.query(...).map(...)` 在测试里全绿；' +
      '而 PostgreSQL 适配器返回 Promise，前者得到 undefined、后者直接 ' +
      '`is not a function`（实测报错原文：`db.query(...).map is not a function`）。' +
      `改法：` + '`await asAsync(db).query(...)`。\n  - ' + offenders.join('\n  - '),
  )
})

test('★ F19：不得对 ctx.get(\'db\') 拿到的句柄直接调同步接口', () => {
  // 上一条是"文件级"判据（够用且不易误报）。这一条补一个更贴身的形状检查：
  // 直接把 `ctx.get('db')` 的结果当同步适配器用，是最常见的写法。
  const offenders: string[] = []
  for (const file of sourceFiles()) {
    const code = codeOnly(readFileSync(file, 'utf8'))
    // `const db = ctx.get('db') as DatabaseAdapter` 这一类断言本身没错（类型是在描述 SQLite），
    // 错的是**断言之后直接用它**。所以只要求同一文件里有 asAsync —— 由上面那条负责；
    // 这里只禁止一种明确的错误写法：对 get('db') 的返回值**立即**调用方法。
    if (/get\('db'\)[^;\n]*\.(query|run|migrate)\s*\(/.test(code)) {
      offenders.push(file.slice(REPO_ROOT.length + 1).split('\\').join('/'))
    }
  }
  assert.deepEqual(offenders, [], `不要在 ctx.get('db') 的返回值上直接调用同步方法：${offenders.join(', ')}`)
})
