/**
 * ★ F19：**迁移的方言完备性**守卫。
 *
 * ## 这条守卫要防的失效（已被真实触发过一次）
 * 在真 PostgreSQL 上启动时，日志里出现的是这样一行：
 *
 * ```
 * [db-postgres] 迁移失败（已回滚）: 0001_ai_mutations.sql error: syntax error at or near "AUTOINCREMENT"
 * ```
 *
 * `packages/plugin-ai-journal/migrations/0001_ai_mutations.sql` 用了
 * `INTEGER PRIMARY KEY AUTOINCREMENT` —— SQLite 专有语法。而本插件是**自己调
 * `db.migrate()`** 的，调用点只有"一个目录"这个概念 ⇒ PG 拿到的是 SQLite 的 DDL
 * ⇒ 插件在激活期整块失败。
 *
 * **这类缺陷的特征是"默认路径上看不见"**：SQLite 部署全绿、单测全绿（单测跑在 SQLite 上），
 * 只有真的切到 PG 才会暴露，而那时暴露的形式是数据库抛的原始语法错误。
 * 所以它必须由一条**静态**守卫来兜，而不是靠"记得在 PG 上跑一遍"。
 *
 * ## 判据（两条互斥的出路，缺一不可）
 * 1. **有 PG 版本**：该插件另有 `migrations-postgres/`，且与 SQLite 目录**文件名一一对应**。
 * 2. **声明为 SQLite 专有**：登记在下面的 `SQLITE_ONLY` 里，并写明理由。
 *    登记不是"免检"——它必须与"插件在运行期真的拒绝了非 sqlite 方言"配套，
 *    否则就是把"激活期报一个语法错误"换成"激活成功、用起来才发现表不存在"。
 *
 * 另外：`SQLITE_ONLY` 里的条目若**已经不再含 SQLite 专有语法**，本用例会红——
 * 过期登记会让这份清单慢慢变成"没人敢删的历史"，而它的全部价值就在于"每条都还成立"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { repoRootOf } from '@geewiki/core'

/**
 * 仓库根：用 `@geewiki/core` 的共享实现，**不再本地重复一份**。
 * 本文件初稿抄了 `platformEvents.test.ts` 里的同名函数——那是本仓库里已有的一份重复，
 * 而 core 早就导出了它（`repoRootOf`）。判据取自"调用方模块位置"而非 cwd，
 * 故从任意工作目录跑测试结果一致。
 */
const REPO_ROOT = repoRootOf(import.meta.url)

/**
 * SQLite 专有（或 PG 上不成立）的构造。
 *
 * **`CREATE VIRTUAL TABLE` / `USING fts5` 必须在内**：本项目里 `@geewiki/search`
 * 正是靠 FTS5 提供检索，而它是 PG 上无等价实现的东西——第一版判据漏了这两条，
 * 于是 `plugin-search` 被判为"干净"，那是个**假阴性**。
 */
const SQLITE_ONLY_PATTERNS: readonly RegExp[] = [
  /\bAUTOINCREMENT\b/i,
  /\bPRAGMA\b/i,
  /\bsqlite_master\b/i,
  /\bWITHOUT\s+ROWID\b/i,
  /\bCREATE\s+VIRTUAL\s+TABLE\b/i,
  /\bUSING\s+fts5\b/i,
  /\bINSERT\s+OR\s+REPLACE\b/i,
  /\bGROUP_CONCAT\s*\(/i,
  /\bstrftime\s*\(/i,
]

/**
 * 声明为 **SQLite 专有**的迁移目录（无 PG 版本），附带理由。
 * 每条都必须与"运行期显式拒绝非 sqlite 方言"配套——否则失败只是从激活期推迟到使用期。
 */
const SQLITE_ONLY: readonly { readonly dir: string; readonly reason: string }[] = [
  {
    dir: 'packages/plugin-search/migrations',
    reason:
      '依赖 FTS5 虚拟表（`CREATE VIRTUAL TABLE … USING fts5`）与配套触发器，PostgreSQL 无等价实现；' +
      '该插件在 apply 里按 `dialect` 显式拒绝非 sqlite 方言（见 core 的 DatabaseDialect 注释所举之例）。',
  },
]

/**
 * **方言提供者对**：SQLite 提供者自身的迁移目录不需要 `migrations-postgres/`，
 * 因为 PG 的 schema 由**另一个包**提供，两边共用同一套编号体系。
 *
 * 但"共用编号"必须被检查，否则会出现最典型的一种漂移：
 * **给 SQLite 加了表、忘了 PG** —— 而它在 SQLite 部署上完全看不出来。
 */
const DIALECT_PAIRS: readonly {
  readonly sqlite: string
  readonly postgres: string
  /** SQLite 侧有、PG 侧**内联在 0001_init.sql 里**的文件（内联是刻意的，不是遗漏） */
  readonly inlinedInPostgres: readonly string[]
}[] = [
  {
    sqlite: 'packages/db-sqlite/src/migrations',
    postgres: 'packages/db-postgres/migrations',
    inlinedInPostgres: ['0002_pages_updated_at_index.sql'],
  },
]

/** 剥掉 `--` 行注释：引述"SQLite 用 AUTOINCREMENT"的解释性注释不该算违规 */
function codeOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

function sqlFilesIn(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
}

function hitsIn(dir: string): string[] {
  const hits: string[] = []
  for (const name of sqlFilesIn(dir)) {
    const code = codeOnly(readFileSync(join(dir, name), 'utf8'))
    for (const re of SQLITE_ONLY_PATTERNS) {
      const m = re.exec(code)
      if (m) hits.push(`${name}: ${m[0]}`)
    }
  }
  return hits
}

/**
 * 扫描所有包下的迁移目录（`migrations/` 与 `src/migrations/`）。
 *
 * ⚠️ 写这条注释时连踩两次同一个坑：原先写的是带通配符的路径，
 * 而**星号紧跟斜杠**这个序列会**提前闭合块注释**，后面的文本就变成代码
 * （F21 的脚手架生成器踩过完全相同的坑）。第一次改完之后，
 * 我在解释这件事的注释里又把它写了进去 —— 于是它再次闭合。
 * 结论：**在块注释里描述这个序列时要拆开写**（例如"星号紧跟斜杠"），不要照抄原样。
 */
function migrationDirs(): string[] {
  const out: string[] = []
  const packagesDir = join(REPO_ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    for (const candidate of [`migrations`, join('src', 'migrations')]) {
      const dir = join(packagesDir, pkg, candidate)
      if (existsSync(dir) && statSync(dir).isDirectory()) out.push(dir)
    }
  }
  return out
}

test('★ F19：用了 SQLite 专有语法的迁移目录，必须有 PostgreSQL 版本或登记为 SQLite 专有', () => {
  const offenders: string[] = []
  const examined: string[] = []
  for (const dir of migrationDirs()) {
    // 只检查**非** postgres 的目录：pg 目录本身就是答案
    if (dir.includes('postgres')) continue
    // 方言提供者自身由 DIALECT_PAIRS 的对应关系用例负责（它的 PG 对手在另一个包里）
    const relPath = dir.slice(REPO_ROOT.length + 1).split('\\').join('/')
    if (DIALECT_PAIRS.some((pair) => pair.sqlite === relPath)) continue
    const hits = hitsIn(dir)
    if (hits.length === 0) continue
    examined.push(dir)

    const rel = dir.slice(REPO_ROOT.length + 1).split('\\').join('/')
    if (SQLITE_ONLY.some((e) => e.dir === rel)) continue

    // 出路一：有对应的 PG 版本，且文件名一一对应。
    // PG 目录一律是同级的 `migrations-postgres/` —— 对 `packages/X/migrations` 与
    // `packages/X/src/migrations` 都成立，故不需要按位置分支。
    const candidate = join(dirname(dir), 'migrations-postgres')
    const sqliteFiles = sqlFilesIn(dir)
    const pgFiles = sqlFilesIn(candidate)
    const missing = sqliteFiles.filter((f) => !pgFiles.includes(f))
    if (pgFiles.length > 0 && missing.length === 0) continue

    offenders.push(
      `${rel}\n    命中: ${hits.slice(0, 3).join('；')}` +
        (pgFiles.length === 0
          ? `\n    且没有 ${candidate.slice(REPO_ROOT.length + 1)}/`
          : `\n    PG 目录缺少同名文件: ${missing.join(', ')}`),
    )
  }

  // 先断言"确实检查到了东西"：判据写坏时若枚举为空，后面的断言会**空集通过**
  assert.ok(examined.length > 0, '没有检查到任何含 SQLite 专有语法的迁移目录——判据可能已失效')

  assert.deepEqual(
    offenders,
    [],
    '以下迁移目录含 SQLite 专有语法，会导致 PostgreSQL 部署上激活失败（实测报 ' +
      '`syntax error at or near "AUTOINCREMENT"`）。两条出路：① 加一份 `migrations-postgres/` ' +
      '（文件名与 SQLite 目录一一对应）；② 若该插件本就只支持 SQLite，登记到本文件的 ' +
      `SQLITE_ONLY 并写明理由。\n  - ${offenders.join('\n  - ')}`,
  )
})

test('★ F19：SQLITE_ONLY 登记不得过期（已不含专有语法的条目必须删掉）', () => {
  // 登记的价值全在"每条都还成立"。不检查这一点，它就会退化成一份没人敢删的历史清单，
  // 而后来者会照抄这种"反正没人管"的写法。
  const stale = SQLITE_ONLY.filter((e) => hitsIn(join(REPO_ROOT, e.dir)).length === 0).map((e) => e.dir)
  assert.deepEqual(
    stale,
    [],
    `以下登记已不再含 SQLite 专有语法，请从 SQLITE_ONLY 移除：${stale.join(', ')}`,
  )
  for (const e of SQLITE_ONLY) {
    assert.ok(e.reason.length > 20, `登记 ${e.dir} 必须写明理由（>20 字），而不是留空`)
  }
})

test('★ F19：PostgreSQL 官方迁移目录自身不得含 SQLite 专有语法', () => {
  // 最基础的一条：给 PG 用的 SQL 里出现 SQLite 语法，等于这份目录从没被执行过。
  const pgDir = join(REPO_ROOT, 'packages', 'db-postgres', 'migrations')
  const hits = hitsIn(pgDir)
  assert.deepEqual(hits, [], `packages/db-postgres/migrations 含 SQLite 专有语法：${hits.join('；')}`)
})

test('★ F19：ai-journal 的 PG 版本与 SQLite 版本只差自增主键写法', () => {
  // 守卫只能检查"存在性"，无法判断两份内容是否同步；这一条把最要紧的那半句钉住：
  // 两份文件除自增主键外**逐字相同**。一旦有人在 SQLite 那份里加了列而忘了 PG 那份，
  // 本用例会红，而不是等到 PG 部署上查询报 `column does not exist`。
  const sqliteFile = join(REPO_ROOT, 'packages', 'plugin-ai-journal', 'migrations', '0001_ai_mutations.sql')
  const pgFile = join(REPO_ROOT, 'packages', 'plugin-ai-journal', 'migrations-postgres', '0001_ai_mutations.sql')
  assert.ok(existsSync(pgFile), 'plugin-ai-journal 必须有 migrations-postgres/0001_ai_mutations.sql')

  const normalize = (text: string): string[] =>
    codeOnly(text)
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '')
      // 只在这一处允许不同
      .map((l) => l.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i, 'ID_COLUMN'))
      .map((l) => l.replace(/INTEGER\s+GENERATED\s+BY\s+DEFAULT\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i, 'ID_COLUMN'))

  const a = normalize(readFileSync(sqliteFile, 'utf8'))
  const b = normalize(readFileSync(pgFile, 'utf8')).filter((l) => !l.startsWith('--'))
  // PG 版多了一段文件头说明，逐行比对时按"SQLite 版的每一行都在 PG 版里同序出现"来判
  const idx = (line: string, from: number): number => b.indexOf(line, from)
  let cursor = 0
  for (const line of a) {
    const at = idx(line, cursor)
    assert.notEqual(at, -1, `PG 版本缺少（或顺序不同）SQLite 版本中的行：${line}`)
    cursor = at
  }
})

test('★ F19：ai-journal 的 self-migrate 必须按方言选目录【且 await】', async () => {
  // 行为级测不了（单测跑在 SQLite 上），故用源码级判据钉住两个都修掉才算数的点：
  // ① 方言目录选择；② await —— PG 适配器的 migrate 返回 Promise，漏 await 会出现
  // "迁移还在跑、路由已挂上"的竞态，而它在 SQLite 上完全看不见。
  const src = readFileSync(join(REPO_ROOT, 'packages', 'plugin-ai-journal', 'src', 'index.ts'), 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')

  assert.match(code, /await asAsync\(db\)\.migrate\(journalMigrationsDirFor\(/, '必须按方言选目录、且 await')
  assert.equal(
    /\bdb\.migrate\(/.test(code),
    false,
    '不得再直接调用同步形态的 db.migrate()：PG 下它返回 Promise，不 await 就是竞态',
  )
  // 两条出路都声明了，管理器路径（外部插件/未来内置插件走注册表）也不会错
  assert.match(code, /migrations:\s*\{\s*default:\s*'\.\/migrations',\s*postgres:\s*'\.\/migrations-postgres'\s*\}/)
})

test('★ F19：db-sqlite 与 db-postgres 的迁移必须一一对应（除已登记的内联项）', () => {
  // 这是"共用编号体系"能成立的前提：给 SQLite 加了迁移却忘了 PG，会让 PG 部署缺表，
  // 而它在 SQLite 上全绿 —— 与本文件开头那条真回归是同一类失败。
  for (const pair of DIALECT_PAIRS) {
    const sqliteFiles = sqlFilesIn(join(REPO_ROOT, pair.sqlite))
    const pgFiles = sqlFilesIn(join(REPO_ROOT, pair.postgres))
    assert.ok(sqliteFiles.length > 0 && pgFiles.length > 0, `${pair.sqlite} 或 ${pair.postgres} 为空`)

    const missingInPg = sqliteFiles.filter(
      (f) => !pgFiles.includes(f) && !pair.inlinedInPostgres.includes(f),
    )
    assert.deepEqual(
      missingInPg,
      [],
      `${pair.postgres} 缺少以下迁移（若已在 0001 里内联，请登记到 inlinedInPostgres）：${missingInPg.join(', ')}`,
    )

    const missingInSqlite = pgFiles.filter((f) => !sqliteFiles.includes(f))
    assert.deepEqual(
      missingInSqlite,
      [],
      `${pair.sqlite} 缺少以下迁移（PG 侧单方面新增会让两边编号体系分叉）：${missingInSqlite.join(', ')}`,
    )

    // 内联登记不得过期：那个文件必须真的存在，否则登记就是在替一个不存在的文件豁免
    for (const f of pair.inlinedInPostgres) {
      assert.ok(sqliteFiles.includes(f), `inlinedInPostgres 登记了 ${f}，但 ${pair.sqlite} 里没有它`)
    }
  }
})
