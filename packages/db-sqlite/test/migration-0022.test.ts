/**
 * `0022_invitation_open_code.sql` 的**升级路径**测试 —— 这是本仓**第一个表重建迁移**。
 *
 * ## 为什么必须有这个测试（而不是"e2e 过了就行"）
 *
 * e2e 脚本跑在**全新的空库**上：迁移按序应用，`invitations` 表在重建时**一行数据都没有**。
 * 也就是说它能证明"迁移不报错"，**证明不了"既有邀请不丢"** —— 而丢数据恰恰是表重建
 * （`CREATE 新表 → INSERT SELECT → DROP 旧表 → RENAME`）唯一真正危险的失败方式。
 * 更糟的是它**不报错**：一个写错的 `INSERT INTO ... SELECT` 列序会把邮箱塞进
 * `token_hash`，迁移照样"成功"。
 *
 * 所以这里**精确复现 0022 之前的状态**：整表 DROP 掉、按 0011 的旧 DDL 重建、
 * 删掉 `_migrations` 里那条记录、造三条数据，再让 `migrate()` 正常应用 0022。
 *
 * ## 反空洞
 *
 * 造完数据后**先断言旧约束真的在**（`email = NULL` 必须插入失败）。少了这一步，
 * "旧 DDL 重建没生效"会让后面的"NULL 能插进去了"退化成"本来就能插" —— 测试照样全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATION_TABLE } from '@geewiki/core'
import { SqliteDatabase } from '../src/index.js'

const MIGRATION_NAME = '0022_invitation_open_code.sql'

/**
 * `invitations` 在 0022 **之前**的 DDL（逐字取自 0011_org_team.sql）。
 *
 * 这里刻意**复制**而不是从 0011 读：它代表的是"历史某一刻的表结构"，是一份**冻结的
 * 夹具**，会永远保持这个样子；从 0011 读反而会在 0011 被改（不会，但语义上）时失去意义。
 */
const OLD_TABLE_DDL = `
CREATE TABLE invitations (
  id          TEXT    PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  org_role    TEXT,
  group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  invited_by  INTEGER REFERENCES users(id)  ON DELETE SET NULL,
  token_hash  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  accepted_at TEXT,
  created_at  TEXT    NOT NULL
)`

const COLUMNS = 'id, org_id, email, org_role, group_id, invited_by, token_hash, expires_at, accepted_at, created_at'

test('★ 0022 表重建：既有邀请一行不丢，且 email 从此可为 NULL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-mig0022-'))
  const db = new SqliteDatabase(join(dir, 'geewiki.db'))
  try {
    db.open() // 全部迁移（含 0022）先跑一遍，拿到一个完好的库

    // ── 回到 0022 之前 ──
    db.run('DROP TABLE invitations')
    db.run(OLD_TABLE_DDL)
    // 索引单独建：`SqliteDatabase` 没有公开的多语句 `exec`，而 DDL 必须逐条执行
    db.run('CREATE INDEX idx_invitations_email ON invitations(org_id, email)')
    db.run('CREATE INDEX idx_invitations_expires ON invitations(expires_at)')
    db.run(`DELETE FROM ${MIGRATION_TABLE} WHERE name = ?`, [MIGRATION_NAME])

    // 造数据：org id=1 由 0011 自带；三条邀请覆盖"有角色/无角色/已消费"三种形态
    db.run(
      `INSERT INTO invitations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv-a', 1, 'alice@example.com', 'member', null, null, 'hash-a', '2030-01-01T00:00:00Z', null, '2026-01-01T00:00:00Z'],
    )
    db.run(
      `INSERT INTO invitations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv-b', 1, 'bob@example.com', null, null, null, 'hash-b', '2030-01-02T00:00:00Z', null, '2026-01-02T00:00:00Z'],
    )
    db.run(
      `INSERT INTO invitations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv-c', 1, 'carol@example.com', 'admin', null, null, 'hash-c', '2020-01-01T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'],
    )

    /*
     * ★ 反空洞：先证明**旧约束真的在**。
     * 少了这一步，"NULL 能插进去了"会因为"旧 DDL 重建压根没生效"而通过 —— 测试全绿，
     * 却什么也没证明。
     */
    assert.throws(
      () =>
        db.run(
          `INSERT INTO invitations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['pre', 1, null, null, null, null, 'h', '2030-01-01T00:00:00Z', null, '2026-01-01T00:00:00Z'],
        ),
      /NOT NULL/i,
      '0022 之前 email 是 NOT NULL —— 若这里没抛错，说明"旧状态"没被真正复现',
    )

    // ── 应用 0022 ──
    db.migrate()

    // ── 数据必须一行不差 ──
    const rows = db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM invitations ORDER BY id`)
    assert.deepEqual(
      rows,
      [
        { id: 'inv-a', org_id: 1, email: 'alice@example.com', org_role: 'member', group_id: null, invited_by: null, token_hash: 'hash-a', expires_at: '2030-01-01T00:00:00Z', accepted_at: null, created_at: '2026-01-01T00:00:00Z' },
        { id: 'inv-b', org_id: 1, email: 'bob@example.com', org_role: null, group_id: null, invited_by: null, token_hash: 'hash-b', expires_at: '2030-01-02T00:00:00Z', accepted_at: null, created_at: '2026-01-02T00:00:00Z' },
        { id: 'inv-c', org_id: 1, email: 'carol@example.com', org_role: 'admin', group_id: null, invited_by: null, token_hash: 'hash-c', expires_at: '2020-01-01T00:00:00Z', accepted_at: '2026-01-03T00:00:00Z', created_at: '2026-01-03T00:00:00Z' },
      ],
      '表重建后每一列都必须与原值逐字相同（列序写错会静默错位，不会报错）',
    )

    // ── 新语义：通用码（email = NULL）能插进去 ──
    db.run(
      `INSERT INTO invitations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv-open', 1, null, 'member', null, null, 'hash-open', '2030-02-01T00:00:00Z', null, '2026-02-01T00:00:00Z'],
    )
    const open = db.query<{ email: unknown }>('SELECT email FROM invitations WHERE id = ?', ['inv-open'])
    assert.equal(open[0]?.email, null, '通用码必须能落成 NULL（不是空串）')

    // ── 索引被重建（`idx_invitations_email` 是 OIDC 那条按邮箱查的判据）──
    const indexes = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invitations'")
      .map((r) => r.name)
      // `sqlite_autoindex_invitations_1` 是 SQLite 为 `id TEXT PRIMARY KEY` 自动建的**内部**
      // 索引（非 WITHOUT ROWID 表的文本主键都会有一个）。它由引擎维护，不是我们要管的对象 ——
      // 但它出现在这里恰好也是一条证据：主键约束被真的重建了。
      .filter((name) => !name.startsWith('sqlite_autoindex_'))
      .sort()
    assert.deepEqual(indexes, ['idx_invitations_email', 'idx_invitations_expires'])

    // ── 不留临时表、迁移记录到位 ──
    const leftovers = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'invitations%'",
    )
    assert.deepEqual(leftovers.map((r) => r.name), ['invitations'], '不得残留 invitations_new')
    assert.equal(
      db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${MIGRATION_TABLE} WHERE name = ?`, [MIGRATION_NAME])[0]?.n,
      1,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
