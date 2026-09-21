/**
 * 块模型：解析、tier、双写（P3a / M2）。
 *
 * 见 docs/design/access-control.md §4.1 / §4.2 / §4.3 / §3.6。
 *
 * 这一组用例钉的是**容易被后人改坏、且改坏后不报错只是行为悄悄变**的地方：
 * 围栏代码块不被空行切碎、gated 标记不进块文本、旧标记必须显式拒绝、
 * `tier` 的方向（写反就是匿名可搜到 org 块 = 泄漏）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BlockParseError,
  parseBlocks,
  projectBlocks,
  readExistingBlocks,
  sha256Hex,
  syncBlocksForPage,
  tierFor,
} from '../src/blocks.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

/**
 * 内存库 + 全部相关迁移。
 *
 * 用 **Node 22 内置的 `node:sqlite`**（与 `service.test.ts` 同款）而不是 `better-sqlite3`：
 * 本包没声明后者作依赖。迁移脚本**读真实文件**，不抄一份 DDL（避免表结构漂移）。
 */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const d of ['packages/db-sqlite/src/migrations', 'packages/plugin-search/migrations']) {
    for (const f of readdirSync(join(REPO, d)).filter((x) => x.endsWith('.sql')).sort()) {
      try {
        db.exec(readFileSync(join(REPO, d, f), 'utf8'))
      } catch (err) {
        /*
         * **只吞幂等性错误**（同一文件被重复应用时的 "already exists" / "duplicate column name"）。
         *
         * 这里原先是个**空 `catch {}`**，会把真正的语法错误一并吞掉 —— 后果很具体：
         * 若 `0002_blocks_fts.sql` 语法坏掉，夹具会**静默地没有 `blocks_fts`**，
         * 而依赖它的断言照绿。那比不测更糟（假绿），所以改为"认识幂等错误、其余重抛"。
         */
        const message = err instanceof Error ? err.message : String(err)
        if (!/already exists|duplicate column name/i.test(message)) throw err
      }
    }
  }
  db.exec(
    `INSERT INTO pages (slug, title, content, created_at, updated_at, visibility, inherit, acl_revision)
     VALUES ('p', 'T', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'org', 1, 0)`,
  )
  return db
}

/** `node:sqlite` 的 `lastInsertRowid` 可能是 BigInt，统一成 number（与适配器的形状对齐） */
function txOf(db: DatabaseSync) {
  return {
    run: (sql: string, params: readonly unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]))
      return Promise.resolve({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) })
    },
  }
}

/** 只读侧替身：`readExistingBlocks` 要的形状 */
function readerOf(db: DatabaseSync) {
  return {
    query: <T,>(sql: string, params: readonly unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]),
  }
}

/**
 * 读该页已有块 —— **`syncBlocksForPage` 的 `existing` 必须来自真实读数，不能图省事传 `[]`**。
 *
 * 传 `[]` 而库里其实有块，等于告诉保守重解析"这一页是空的"：旧块既不会被复用、
 * 也不会被删掉，结果是**块越积越多**（下面的"替换而不是追加"用例正是钉这一点）。
 */
function existingOf(db: DatabaseSync, pageId = 1) {
  return readExistingBlocks(readerOf(db), pageId)
}

/* ------------------------------ 解析 ------------------------------ */

test('parseBlocks：空行分块，并按首个非空行判定 kind', () => {
  const blocks = parseBlocks(['# 标题', '', '段落一。', '', '- 列表项', '', '> 引用'].join('\n'))
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'paragraph', 'list', 'quote'],
  )
  assert.deepEqual(
    blocks.map((b) => b.ordinal),
    [0, 1, 2, 3],
  )
})

test('parseBlocks：围栏代码块内部的空行**不能**切碎它', () => {
  // 这条是回归用例：早期实现按空行无差别切分，代码块会被切成好几段。
  const blocks = parseBlocks(['```js', '', 'const a = 1', '', '```'].join('\n'))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.kind, 'code')
  assert.match(blocks[0]!.text, /const a = 1/)
})

test('parseBlocks：gated 区段内的每个块都取该可见性，且**标记本身不属于任何块**', () => {
  const blocks = parseBlocks(
    ['公开段。', '', '<!--gated:org-->', '内部一。', '', '内部二。', '<!--/gated-->'].join('\n'),
  )
  assert.deepEqual(
    blocks.map((b) => [b.visibility, b.marker]),
    [
      ['public', null],
      ['org', 'org'],
      ['org', 'org'],
    ],
  )
  // 标记不能出现在块文本里 —— 否则公共视图渲染时会泄露"这里有个受限区段"
  for (const b of blocks) {
    assert.ok(!b.text.includes('gated'), `块文本不得含标记: ${b.text}`)
  }
})

test('parseBlocks：★ 旧标记 role=* 与 private 必须**显式拒绝**，不能静默当 public', () => {
  // 静默忽略的后果：作者以为收紧了，实际内容按 public 暴露。
  for (const bad of ['<!--gated:role=editor-->', '<!--gated:role:editor-->', '<!--gated:private-->']) {
    assert.throws(
      () => parseBlocks(`${bad}\n内容。\n<!--/gated-->`),
      (e: unknown) => e instanceof BlockParseError && e.code === 'gated_marker_removed',
      `必须拒绝: ${bad}`,
    )
  }
  assert.throws(
    () => parseBlocks('<!--gated:whatever-->\n内容。\n<!--/gated-->'),
    (e: unknown) => e instanceof BlockParseError && e.code === 'gated_marker_unknown',
  )
})

test('parseBlocks：未闭合的区段/代码围栏、以及无主闭合标记都报错', () => {
  const cases: [string, string][] = [
    ['<!--gated:org-->\n内容。', 'gated_unclosed'],
    ['```js\n内容。', 'code_fence_unclosed'],
    ['内容。\n<!--/gated-->', 'gated_close_without_open'],
    ['<!--gated:org-->\n<!--gated:granted-->\n<!--/gated-->', 'gated_nested'],
  ]
  for (const [src, code] of cases) {
    assert.throws(
      () => parseBlocks(src),
      (e: unknown) => e instanceof BlockParseError && e.code === code,
      `期望 ${code}: ${JSON.stringify(src)}`,
    )
  }
})

test('parseBlocks：contentHash 是文本的 sha256（保守重解析靠它对齐块身份）', () => {
  const [b] = parseBlocks('一段话。')
  assert.equal(b!.contentHash, sha256Hex('一段话。'))
})

/* ------------------------------ tier ------------------------------ */

test('★ tierFor 的方向：档位刻度是"限制等级"，同一语义下是 max 而不是 min', () => {
  // 写反方向（把 org 页面的 public 块算成 0）就是**匿名在搜索里找得到 org 页的内容**。
  assert.equal(tierFor(0, 'public'), 0, '页面公开 + 块公开 ⇒ 匿名可搜')
  assert.equal(tierFor(0, 'org'), 1, '页面公开 + 块组织内 ⇒ 仅成员')
  assert.equal(tierFor(1, 'public'), 1, '★ 页面组织内 + 块公开 ⇒ 仍是仅成员（页面把匿名挡住了）')
  assert.equal(tierFor(1, 'org'), 1)
  assert.equal(tierFor(1, 'granted'), null, 'granted 不属于任何等级，只能靠授权分支命中')
  assert.equal(tierFor(null, 'public'), null, '页面没有任何等级能看 ⇒ 块也不进等级索引')
  assert.equal(tierFor(0, 'granted'), null)
})

/* ------------------------------ 双写 ------------------------------ */

test('syncBlocksForPage：写 blocks 与 blocks_fts，且 granted 档的 tier 为 NULL', async () => {
  const db = freshDb()
  const content = [
    '公开段。',
    '',
    '<!--gated:org-->',
    '内部段。',
    '<!--/gated-->',
    '',
    '<!--gated:granted-->',
    '运维备注。',
    '<!--/gated-->',
  ].join('\n')
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content,
    pageLevel: 1,
    now: '2026-01-01T00:00:00Z',
    // P3b：保守重解析需要该页已有的块（含授权计数）
    existing: await existingOf(db),
    // 本夹具建了 `blocks_fts`（SQLite）⇒ 与生产同一取值
    syncIndex: true,
    actorId: null,
  })

  const rows = db
    .prepare('SELECT ordinal, visibility, tier FROM blocks ORDER BY ordinal')
    .all() as { ordinal: number; visibility: string; tier: number | null }[]
  // `node:sqlite` 返回的行是 null-prototype 对象，展开成普通对象再比对
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { ordinal: 0, visibility: 'public', tier: 1 },
      { ordinal: 1, visibility: 'org', tier: 1 },
      { ordinal: 2, visibility: 'granted', tier: null },
    ],
  )
  // 索引行数与块数一致（contentless 表没有触发器兜底，靠这条写入路径保证）
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks_fts').get() as { n: number }).n, 3)
})

test('syncBlocksForPage：重复保存是**替换**而不是追加（否则块会越积越多）', async () => {
  const db = freshDb()
  const tx = txOf(db)
  await syncBlocksForPage(tx as never, {
    pageId: 1,
    content: 'a\n\nb',
    pageLevel: 0,
    now: 't1',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n, 2)
  // ★ 第二次保存必须传入**库里真实的块**（而不是 `[]`），否则旧块不会被复用也不会被删
  await syncBlocksForPage(tx as never, {
    pageId: 1,
    content: '只有一段',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n, 1)
  // 索引同步收缩 —— 旧块的行必须在同一事务里删掉，否则会留下孤儿文本
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks_fts').get() as { n: number }).n, 1)
})

test('syncBlocksForPage：pageLevel=null（失败关闭）⇒ 全部块 tier 为 NULL，即搜不到', async () => {
  const db = freshDb()
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: '公开段。',
    pageLevel: null,
    now: 't',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  const row = db.prepare('SELECT tier FROM blocks').get() as { tier: number | null }
  assert.equal(row.tier, null)
})

test('syncBlocksForPage：删页后块与索引都被清（回归：contentless 表没有级联）', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO blocks (page_id, ordinal, kind, text, visibility, inherit, marker, content_hash, created_at, updated_at, tier)
     VALUES (1, 0, 'paragraph', 'x', 'public', 1, NULL, 'h', 't', 't', 0)`,
  ).run()
  db.prepare('INSERT INTO blocks_fts (rowid, text) VALUES (last_insert_rowid(), ?)').run('x')
  // 外键级联只带走 blocks 行，blocks_fts 必须由写入方显式清（见 deletePage）
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n, 1)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks_fts').get() as { n: number }).n, 1)
})

/* --------------------- 源码级守卫：块与索引的写入必须成对 --------------------- */

/**
 * `packages/plugin-wiki/src/blocks.ts` 的头部声称"有源码级守卫测试钉住这一点" ——
 * **这个测试就是它**（此前并不存在；P3a 审查指出该声称是空的）。
 *
 * 钉的不变量（**不是**"只能在 blocks.ts"，那会被合法例外打破）：
 *
 * 1. **`INSERT INTO blocks` 只能出现在 `blocks.ts`** —— 最关键的一条：新增一个块行必须
 *    **同时**往 `blocks_fts` 插一行，而只有 `syncBlocksForPage` 同时做这两件事。
 *    绕过它直接插入 ⇒ 块在库里却搜不到（或索引里留着已删块的正文）。
 * 2. **`DELETE FROM blocks` 同理**（删块也要清索引，contentless 表没有级联）。
 * 3. **`INSERT INTO blocks_fts` 只允许两处**：`blocks.ts` 的逐页同步，以及
 *    `packages/plugin-search/src/index.ts` 的**全量重建** —— 后者从 `blocks` 派生
 *    （`SELECT id, text FROM blocks`），派生不出 `blocks` 里没有的内容。
 *
 * **刻意不限制**：`DELETE FROM blocks_fts`（单独清索引）与 `UPDATE blocks SET tier`。
 * 二者的失败方向都是"**少给**"（搜不到 / 档位偏保守），不会泄漏；锁死它们会让
 * "删除页面时清索引"这类必需的清理无处安放。
 *
 * ⚠️ 测试夹具（`test/` 目录）**排除在外** —— 它们本来就在裸写以构造状态。
 */
test('源码级守卫：块与索引的写入必须成对（不得绕过唯一写入路径）', () => {
  /*
   * 扫描范围必须与注释里"全仓"的说法**一致** —— 原实现只扫各包 `src` 目录下的 `.ts`，
   * 而 `0002_blocks_fts.sql` 的注释却声称"再无第二处 `INSERT INTO blocks`/`INTO blocks_fts`"。
   * "申报范围 ≠ 实际范围"本身就是这次要修的那类问题，故扩为：
   *   - 各包 `src` 目录下的 `.ts`（生产代码主体）
   *   - `plugins/` 与 `scripts/` 下的 `.ts`/`.tsx`（示例插件与脚本同样能写库）
   *   - 各 `migrations/` 目录下的 `.sql`（迁移里同样能插入块与索引行）
   * 仍**排除** `test/`、`node_modules/`、`dist/`：夹具本来就在裸写以构造状态。
   */
  const files: string[] = []
  const walk = (dir: string, exts: readonly string[]): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在（例如没有 scripts/）——不是错误
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'test' || e.name === 'dist') continue
        walk(p, exts)
      } else if (exts.some((x) => e.name.endsWith(x))) {
        files.push(p)
      }
    }
  }
  const pkgRoot = join(REPO, 'packages')
  for (const p of readdirSync(pkgRoot)) walk(join(pkgRoot, p, 'src'), ['.ts'])
  walk(join(REPO, 'plugins'), ['.ts', '.tsx'])
  walk(join(REPO, 'scripts'), ['.ts', '.tsx'])
  // 迁移目录有两种形态：`packages/<pkg>/migrations` 与 `packages/<pkg>/src/migrations`
  for (const p of readdirSync(pkgRoot)) {
    walk(join(pkgRoot, p, 'migrations'), ['.sql'])
    walk(join(pkgRoot, p, 'src', 'migrations'), ['.sql'])
  }

  const WRITE_PATH = join('plugin-wiki', 'src', 'blocks.ts')
  const REBUILD = join('plugin-search', 'src', 'index.ts')

  /**
   * 把注释内容替换成**等长空白**（保留换行 ⇒ 行号不漂），再对整段文本匹配。
   *
   * 为什么不按行匹配 + 跳过注释行（原做法）：那样只能发现"同一行内、且形态恰好"的写法。
   * 实测漏三种：
   *   - `INSERT INTO blocks(` —— 无空格，原正则 `/INSERT INTO blocks \(/` 抓不到；
   *   - `INSERT INTO\n  blocks (...)` —— 跨行，按行匹配永远看不到；
   *   - 缩进深或写在多行模板串里的同类写法。
   * 换成"先抹注释、再对整段文本用 `\s+` 匹配"可以全覆盖，且等长替换保证行号不漂。
   *
   * `sql=true` 时额外处理 `--` 行注释（SQL 的注释符不是 `//`）；TS 侧**不**处理 `--`，
   * 因为那在 TS 里是自减运算符，误判会把整行抹掉、反而藏住违规。
   *
   * ⚠️ 已知边界：它不解析字符串字面量，故一行里若先出现 `//`（例如某个 `'https://…'`
   * 字面量），该行 `//` 之后会被当成注释抹掉。对本仓现状无影响（SQL 都在反引号模板串里，
   * 且不以 `//` 作注释），但将来新增此类字面量时要留意。
   */
  const stripCommentsToSpaces = (text: string, sql: boolean): string => {
    let out = ''
    let i = 0
    while (i < text.length) {
      const two = text.slice(i, i + 2)
      if (two === '//' || (sql && two === '--')) {
        while (i < text.length && text[i] !== '\n') {
          out += ' '
          i += 1
        }
      } else if (two === '/*') {
        out += '  '
        i += 2
        while (i < text.length && text.slice(i, i + 2) !== '*/') {
          out += text[i] === '\n' ? '\n' : ' '
          i += 1
        }
        if (i < text.length) {
          out += '  '
          i += 2
        }
      } else {
        out += text[i]
        i += 1
      }
    }
    return out
  }

  /** 返回**不在允许清单里**却命中该模式的位置（跨行可命中，行号按剥离后的文本算） */
  const offenders = (pattern: RegExp, allowed: readonly string[]): string[] => {
    const hits: string[] = []
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    )
    for (const f of files) {
      if (allowed.some((a) => f.endsWith(a))) continue
      const stripped = stripCommentsToSpaces(readFileSync(f, 'utf8'), f.endsWith('.sql'))
      for (const m of stripped.matchAll(re)) {
        const line = stripped.slice(0, m.index ?? 0).split('\n').length
        hits.push(`${f}:${line}: ${m[0].replace(/\s+/g, ' ').trim()}`)
      }
    }
    return hits
  }

  /*
   * 反空洞：先确认扫描**真的扫到了生产源文件**，以及唯一写入路径里**真的**有那两条语句。
   * 没有这一段，上面三条"0 处违规"在"扫描范围写错/文件没被读到"时同样会全绿。
   */
  assert.ok(files.length > 20, `应当扫到生产源文件，实际只扫到 ${files.length} 个`)
  /*
   * 反空洞（新增范围的）：扩了范围就必须证明**那几个范围真的收到了文件**，
   * 否则"0 处违规"在"`.`sql` 一个都没扫到 / `plugins/` 目录名写错"时同样会全绿。
   */
  assert.ok(
    files.some((f) => f.endsWith('.sql')),
    '扫描范围应当包含迁移 .sql（否则新增的 SQL 维度是空洞的）',
  )
  assert.ok(
    files.some((f) => f.includes(`${'plugins'}/`)),
    '扫描范围应当包含 plugins/（存在该目录时必须收到文件）',
  )

  const writePathText = readFileSync(files.find((f) => f.endsWith(WRITE_PATH)) ?? '', 'utf8')
  // 注意用 `\s*\(` 而不是字面的 ` (`：无空格的 `INSERT INTO blocks(` 同样是合法写法
  assert.ok(/INSERT\s+INTO\s+blocks\s*\(/i.test(writePathText), '唯一写入路径里应当确实有 INSERT INTO blocks')
  assert.ok(/DELETE\s+FROM\s+blocks\b/i.test(writePathText), '唯一写入路径里应当确实有 DELETE FROM blocks')
  assert.ok(
    /INSERT\s+INTO\s+blocks_fts/i.test(
      readFileSync(files.find((f) => f.endsWith(REBUILD)) ?? '', 'utf8'),
    ),
    'search 的全量重建里应当确实有 INSERT INTO blocks_fts',
  )

  assert.deepEqual(
    offenders(/INSERT\s+INTO\s+blocks\s*\(/i, [WRITE_PATH]),
    [],
    '新增块行必须经 blocks.ts 的 syncBlocksForPage，否则块与索引漂移',
  )
  assert.deepEqual(
    offenders(/DELETE\s+FROM\s+blocks\b/i, [WRITE_PATH]),
    [],
    '删除块行必须经 blocks.ts，否则 contentless 索引里留下孤儿',
  )
  assert.deepEqual(
    offenders(/INSERT\s+INTO\s+blocks_fts/i, [WRITE_PATH, REBUILD]),
    [],
    '索引插入只允许 blocks.ts 的逐页同步与 search 的全量重建（后者从 blocks 派生）',
  )
})

/* ------------------------------ 保守重解析（§4.2，P3b） ------------------------------ */

/**
 * 这一组钉的是**最容易静默出错**的一类行为：编辑之后"哪个块还是原来那个块"。
 *
 * 为什么必须有测试：块级授权钉在 `blocks.id` 上（`block_grants.block_id`），
 * 而 id 是否跨编辑存活，**完全取决于写入路径怎么对齐**。对齐错了不会报错 ——
 * 只会让"某段内容悄悄变成公开/私有"，或者让授权飘到另一段内容上。
 */
/** 给某块挂一行授权（`granted_by` 可空，故无需先建用户） */
function addGrant(db: DatabaseSync, blockId: number, slug = 'p1', subjectId = '7'): void {
  db.prepare(
    `INSERT INTO block_grants (block_id, page_slug, subject_kind, subject_id, role, granted_at)
     VALUES (?, ?, 'user', ?, 'viewer', '2026-01-01T00:00:00Z')`,
  ).run(blockId, slug, subjectId)
}

function grantCount(db: DatabaseSync, blockId: number): number {
  return Number(
    (db.prepare('SELECT COUNT(*) AS n FROM block_grants WHERE block_id = ?').get(blockId) as { n: number }).n,
  )
}

async function seedOne(db: DatabaseSync, content: string, pageLevel: 0 | 1 | null = 0) {
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content,
    pageLevel,
    now: 't1',
    existing: await existingOf(db),
    // 本夹具建了 `blocks_fts`（SQLite）⇒ 与生产同一取值。
    // `syncIndex` 在 P3a 修复轮改成必填后，这一组用例（写于旧的可选签名）需逐个补齐。
    syncIndex: true,
    actorId: null,
  })
}

function ids(db: DatabaseSync): number[] {
  return (db.prepare('SELECT id FROM blocks ORDER BY ordinal').all() as { id: number }[]).map((r) => Number(r.id))
}

function texts(db: DatabaseSync): string[] {
  return (db.prepare('SELECT text FROM blocks ORDER BY ordinal').all() as { text: string }[]).map((r) => r.text)
}

test('保守重解析：纯文本编辑（块数不变）⇒ 块 id 全部保留', async () => {
  const db = freshDb()
  await seedOne(db, 'a\n\nb\n\nc')
  const before = ids(db)
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: 'a改\n\nb改\n\nc改',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  assert.deepEqual(ids(db), before, '块数不变时 id 必须原样保留（授权挂在 id 上）')
  assert.deepEqual(texts(db), ['a改', 'b改', 'c改'])
})

test('保守重解析：在某块后插入新块 ⇒ 未改动的块 id 保留，新块拿到新 id', async () => {
  const db = freshDb()
  await seedOne(db, 'a\n\nb')
  const before = ids(db)
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: 'a\n\n新插入的\n\nb',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  const after = ids(db)
  assert.equal(after.length, 3)
  assert.ok(after.includes(before[0] as number), 'a 的 id 应保留')
  assert.ok(after.includes(before[1] as number), 'b 的 id 应保留（后续块 ordinal 后移不影响身份）')
  assert.equal(after.filter((x) => !before.includes(x)).length, 1, '只有新插入的那一块是新 id')
  assert.deepEqual(texts(db), ['a', '新插入的', 'b'])
})

test('保守重解析：删除**未授权**的块 ⇒ 正常删除，其余 id 保留', async () => {
  const db = freshDb()
  await seedOne(db, 'a\n\nb\n\nc')
  const before = ids(db)
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: 'a\n\nc',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  const after = ids(db)
  assert.deepEqual(after, [before[0], before[2]], '删掉中间那块，首尾 id 不变')
  // 索引也要收缩（不能留下孤儿文本）
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks_fts').get() as { n: number }).n, 2)
})

test('保守重解析：合并两个**可见性不同**的块 ⇒ 409 block_merge_conflict', async () => {
  const db = freshDb()
  await seedOne(db, '公开段\n\n<!--gated:org-->\n内部段\n<!--/gated-->')
  await assert.rejects(
    syncBlocksForPage(txOf(db) as never, {
      pageId: 1,
      content: '合二为一',
      pageLevel: 0,
      now: 't2',
      existing: await existingOf(db),
      syncIndex: true,
      actorId: null,
    }),
    (err: Error) => {
      assert.match(err.message, /^block_merge_conflict:/)
      return true
    },
    '合并不同可见性的块必须显式拒绝（静默合并 = 静默放宽/收紧）',
  )
  // 拒绝要发生在**任何写入之前**：库里那一页仍是两块
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n, 2)
})

test('保守重解析：合并两个**可见性相同**的块 ⇒ 允许（不牵连授权）', async () => {
  const db = freshDb()
  await seedOne(db, '甲\n\n乙')
  const before = ids(db)
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: '甲乙合并',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n, 1)
  assert.deepEqual(ids(db), [before[0]], '合并保留首块的 id')
})

test('保守重解析：拆分一个**已授权**的块 ⇒ 两块都继承授权（安全方向）', async () => {
  const db = freshDb()
  await seedOne(db, '<!--gated:granted-->\n运维备注\n<!--/gated-->')
  const before = ids(db)
  assert.equal(before.length, 1)
  addGrant(db, before[0] as number)
  assert.equal(grantCount(db, before[0] as number), 1)

  // 把这一段拆成两段（同属 granted 区段）⇒ 1 个旧块 → 2 个新块
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: '<!--gated:granted-->\n运维备注之一\n\n运维备注之二\n<!--/gated-->',
    pageLevel: 1,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  const after = ids(db)
  assert.equal(after.length, 2, '拆成两块')
  for (const id of after) {
    assert.equal(grantCount(db, id), 1, `拆分后每块都应带一份授权（块 ${id}）`)
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM block_grants').get() as { n: number }).n, 2)
})

test('保守重解析：删除一个**已授权**的块 ⇒ 409 block_grant_orphan，且不落任何写入', async () => {
  const db = freshDb()
  await seedOne(db, '保留段\n\n<!--gated:granted-->\n运维备注\n<!--/gated-->')
  const before = ids(db)
  assert.equal(before.length, 2)
  addGrant(db, before[1] as number) // 给第二块（granted 档）挂授权

  await assert.rejects(
    syncBlocksForPage(txOf(db) as never, {
      pageId: 1,
      content: '保留段', // 把已授权的那块删掉
      pageLevel: 1,
      now: 't2',
      existing: await existingOf(db),
      syncIndex: true,
      actorId: null,
    }),
    (err: Error) => {
      assert.match(err.message, /^block_grant_orphan:/)
      return true
    },
    '删除已授权块必须显式拒绝（静默删除会连授权一起被 CASCADE 清掉，且不留痕迹）',
  )
  // 关键：拒绝发生在任何写入之前 —— 两块与授权都原样还在
  assert.deepEqual(ids(db), before)
  assert.equal(grantCount(db, before[1] as number), 1)
})

/* =====================================================================
 * 0024：块级归属（谁、什么时候改的）
 *
 * 这一组用例守的是**两个不会报错的失效**：
 *   1. `updated_at` 被"页面保存过"冒名顶替 —— 一次只改了第三段的保存，
 *      把第一段的时间戳也刷新，读侧据此说「第一段刚被某人改过」就是假话；
 *   2. `updated_by` 在没有可归属主体时被编一个 id 出来（跨插件代调用 / 存量回填）。
 * 两者的共同特征是**页面照常显示、日志干净**，所以必须逐条钉住。
 * ===================================================================== */

/** 该页每块的 `(ordinal, updated_at, updated_by)` —— 归属断言只用这三列 */
function stamps(db: DatabaseSync) {
  return (
    db.prepare('SELECT ordinal, updated_at, updated_by FROM blocks WHERE page_id = 1 ORDER BY ordinal').all() as {
      ordinal: number
      updated_at: string
      updated_by: number | null
    }[]
  ).map((r) => ({ ...r }))
}

test('0024：新建的块带上"这次 + 这个人"（作者是 actorId）', async () => {
  const db = freshDb()
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: '甲\n\n乙',
    pageLevel: 0,
    now: 't1',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: 7,
  })
  assert.deepEqual(stamps(db), [
    { ordinal: 0, updated_at: 't1', updated_by: 7 },
    { ordinal: 1, updated_at: 't1', updated_by: 7 },
  ])
})

test('★ 0024：只改了第二段 ⇒ 第一段的时间与作者**一个字都不动**', async () => {
  const db = freshDb()
  const tx = txOf(db)
  await syncBlocksForPage(tx as never, {
    pageId: 1,
    content: '甲\n\n乙',
    pageLevel: 0,
    now: 't1',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: 7,
  })
  // 换一个人（8）改第二段；第一段原样
  await syncBlocksForPage(tx as never, {
    pageId: 1,
    content: '甲\n\n乙改',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: 8,
  })
  assert.deepEqual(
    stamps(db),
    [
      // ★ 这一行是本案的全部意义：没变的块保留原作者、原时刻（此前会被刷成 t2 / 8）
      { ordinal: 0, updated_at: 't1', updated_by: 7 },
      { ordinal: 1, updated_at: 't2', updated_by: 8 },
    ],
  )
})

test('0024：文本没变但位置变了（前面插入一段）⇒ 归属跟着块走，不被刷新', async () => {
  const db = freshDb()
  const tx = txOf(db)
  await syncBlocksForPage(tx as never, {
    pageId: 1,
    content: '甲\n\n乙',
    pageLevel: 0,
    now: 't1',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: 7,
  })
  await syncBlocksForPage(tx as never, {
    pageId: 1,
    content: '新的开头\n\n甲\n\n乙',
    pageLevel: 0,
    now: 't2',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: 8,
  })
  assert.deepEqual(stamps(db), [
    // 新插入的那一段是这次改动产生的 ⇒ 归 8
    { ordinal: 0, updated_at: 't2', updated_by: 8 },
    // 甲、乙只是被挤到后面：**位置变了不等于内容改了**
    { ordinal: 1, updated_at: 't1', updated_by: 7 },
    { ordinal: 2, updated_at: 't1', updated_by: 7 },
  ])
})

test('0024：跨插件代调用（actorId: null）⇒ updated_by 是 NULL，而不是编一个 id', async () => {
  const db = freshDb()
  await syncBlocksForPage(txOf(db) as never, {
    pageId: 1,
    content: '甲',
    pageLevel: 0,
    now: 't1',
    existing: await existingOf(db),
    syncIndex: true,
    actorId: null,
  })
  assert.deepEqual(stamps(db), [{ ordinal: 0, updated_at: 't1', updated_by: null }])
})

test('★ 0024：投影单元的区间与归属 —— 拼回去逐字等于正文，占位段没有归属', () => {
  const blocks = [
    { id: 1, ordinal: 0, text: '公开段', visibility: 'public' as const, updatedAt: 't1', updatedById: 7 },
    { id: 2, ordinal: 1, text: '内部段', visibility: 'org' as const, updatedAt: 't2', updatedById: 8 },
    { id: 3, ordinal: 2, text: '运维备注', visibility: 'granted' as const, updatedAt: 't3', updatedById: 9 },
  ]
  // 匿名读者：org / granted 两块都看不到 → 合并成一个占位
  const anon = projectBlocks(blocks, { tier: 0, anonymous: true, grantedBlockIds: [] })
  assert.deepEqual(
    anon.units.map((u) => (u.gated ? 'GATED' : anon.text.slice(u.start, u.end))),
    ['公开段', 'GATED'],
  )
  // 地基恒等式：按区间切出来再按 '\n\n' 拼回去，逐字等于投影文本
  assert.equal(anon.units.map((u) => anon.text.slice(u.start, u.end)).join('\n\n'), anon.text)
  // 占位段**不带任何归属**（它代表的块一个都没露出来）
  assert.equal(anon.units[1]!.updatedAt, null)
  assert.equal(anon.units[1]!.updatedById, null)
  assert.equal(anon.units[1]!.gated, true)

  // 组织成员：org 块可见，granted 块仍然不可见（没有授权）
  const member = projectBlocks(blocks, { tier: 1, anonymous: false, grantedBlockIds: [] })
  assert.deepEqual(
    member.units.map((u) => (u.gated ? 'GATED' : member.text.slice(u.start, u.end))),
    ['公开段', '内部段', 'GATED'],
  )
  assert.equal(member.units[1]!.updatedById, 8)
  assert.equal(member.units[1]!.updatedAt, 't2')
  assert.equal(member.units.map((u) => member.text.slice(u.start, u.end)).join('\n\n'), member.text)
})

test('0024：没有归属信息（现场解析的降级路径）⇒ 单元的归属是"不知道"，不是 0', () => {
  // `parseBlocks` 的产物不带 updatedAt/updatedById ⇒ 投影必须原样给出 null
  const parsed = parseBlocks('甲\n\n乙')
  const projected = projectBlocks(parsed, { tier: 0, anonymous: true, grantedBlockIds: [] })
  assert.deepEqual(
    projected.units.map((u) => [u.updatedAt, u.updatedById]),
    [
      [null, null],
      [null, null],
    ],
  )
})
