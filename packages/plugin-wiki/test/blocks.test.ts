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
import { BlockParseError, parseBlocks, sha256Hex, syncBlocksForPage, tierFor } from '../src/blocks.js'

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
      } catch {
        /* 与本次无关的单条语句失败不阻断（例如 FTS 相关的边界） */
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
  await syncBlocksForPage(tx as never, { pageId: 1, content: 'a\n\nb', pageLevel: 0, now: 't1' })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n, 2)
  await syncBlocksForPage(tx as never, { pageId: 1, content: '只有一段', pageLevel: 0, now: 't2' })
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
