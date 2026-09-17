/**
 * ★ F20：备份 / 恢复的守卫。
 *
 * ## 这个文件真正要防的东西
 * 备份与恢复各自有一个"看起来成功、实际有害"的失效模式，两条都由用例钉住：
 *
 * - **备份**：WAL 模式下把主文件拷一份 ≈ 撕裂快照；把 `-wal`/`-shm` 一起带走则会让 SQLite
 *   下次打开时**重放不属于该快照的帧**。附件还是"先写 tmp 再 rename"的，拷到写了一半的
 *   `att-*.tmp` 会表现为"某个附件打不开"。所以 `data/` 的排除规则必须被固定住。
 * - **恢复**：它是**不可逆**的。故三条纪律各有用例：先校验再动手、清单里的路径必须落在
 *   仓库内（否则恢复变成任意写）、覆盖前把原数据移到一边而不是删。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_FILE,
  createBackup,
  readBackupManifest,
  restoreBackup,
  verifyBackup,
  type BackupManifest,
} from '../src/backup.js'

const NOW = new Date('2026-02-14T03:00:00.000Z')

/** 造一个"像仓库"的临时目录：data/（含库、边车、附件、半成品 tmp）+ config/ */
function fakeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'gw-backup-'))
  mkdirSync(join(root, 'data', 'attachments'), { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'data', 'geewiki.db'), 'OLD DB BYTES', 'utf8')
  writeFileSync(join(root, 'data', 'geewiki.db-wal'), 'WAL FRAMES', 'utf8')
  writeFileSync(join(root, 'data', 'geewiki.db-shm'), 'SHM', 'utf8')
  writeFileSync(join(root, 'data', 'attachments', 'abc123.bin'), 'REAL ATTACHMENT', 'utf8')
  writeFileSync(join(root, 'data', 'attachments', 'att-9-1-deadbeef.tmp'), 'HALF WRITTEN', 'utf8')
  writeFileSync(join(root, 'config', 'plugins.base.json'), '{"enabled":[]}', 'utf8')
  writeFileSync(join(root, 'config', 'secrets.json'), '{"openai":{"apiKey":"sk-x"}}', 'utf8')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 一次成功的备份（数据库用假的快照写入，模拟 VACUUM INTO 的产物） */
async function makeBackup(root: string): Promise<string> {
  const report = await createBackup({
    repoRoot: root,
    outDir: join(root, 'backups'),
    now: NOW,
    snapshotDatabase: async (dest) => {
      writeFileSync(dest, 'CONSISTENT SNAPSHOT', 'utf8')
    },
  })
  return report.dir
}

const pathsOf = (m: BackupManifest): string[] => m.files.map((f) => f.path).sort()

/* ------------------------------ 备份 ------------------------------ */

test('★ F20：data/ 的排除规则 —— 库边车与写了一半的 tmp 绝不进备份', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    const paths = pathsOf(readBackupManifest(dir))
    // 库由 snapshotDatabase 单独产出（自包含），旧的 WAL/SHM 必须被排除：
    // 带上它们会让 SQLite 在恢复后重放不属于该快照的帧。
    assert.equal(paths.some((p) => p.endsWith('.db-wal')), false, '不得包含 -wal')
    assert.equal(paths.some((p) => p.endsWith('.db-shm')), false, '不得包含 -shm')
    assert.equal(paths.some((p) => p.endsWith('.tmp')), false, '不得包含写了一半的附件临时文件')
    // 应当包含的：快照、真实附件、config 的两个 json
    assert.deepEqual(paths, [
      'config/plugins.base.json',
      'config/secrets.json',
      'data/attachments/abc123.bin',
      'data/geewiki.db',
    ])
    // 快照的内容来自 snapshotDatabase，而不是原库文件（这句是"没退化成拷贝"的直接证据）
    assert.equal(readFileSync(join(dir, 'data', 'geewiki.db'), 'utf8'), 'CONSISTENT SNAPSHOT')
  } finally {
    env.cleanup()
  }
})

test('★ F20：快照的来源是引擎而非拷贝 —— 原库字节不同即证明', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    assert.notEqual(readFileSync(join(dir, 'data', 'geewiki.db'), 'utf8'), 'OLD DB BYTES')
    const m = readBackupManifest(dir)
    assert.equal(m.database.included, true)
    assert.equal(m.database.engine, 'sqlite')
    assert.equal(m.secretsIncluded, true, '含密钥备份必须被标记出来')
  } finally {
    env.cleanup()
  }
})

test('★ F20：没有 snapshotDatabase 时【如实说没包含数据库】，而不是拷一份 .db', async () => {
  const env = fakeRepo()
  try {
    const report = await createBackup({
      repoRoot: env.root,
      outDir: join(env.root, 'backups'),
      now: NOW,
      databaseNote: '本部署使用 PostgreSQL，请用 pg_dump',
    })
    const m = report.manifest
    assert.equal(m.database.included, false)
    assert.equal(m.database.engine, 'none')
    assert.match(m.database.note ?? '', /pg_dump/)
    // 关键：绝不能在 included:false 的同时把 .db 拷进去（那是最坏的组合：既不完整又装作有）
    assert.equal(pathsOf(m).some((p) => p.endsWith('.db')), false)
  } finally {
    env.cleanup()
  }
})

test('★ F20：清单【最后】才写 —— 缺清单的半成品必须被拒绝，而不是当成空备份', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    rmSync(join(dir, BACKUP_MANIFEST_FILE))
    assert.throws(() => readBackupManifest(dir), /不是备份目录/)
  } finally {
    env.cleanup()
  }
})

test('★ F20：清理早退 —— 目标目录已存在时拒绝覆盖', async () => {
  const env = fakeRepo()
  try {
    await makeBackup(env.root)
    // 同一个 now ⇒ 同一个目录名，第二次必须拒绝而不是把第一次的盖掉
    await assert.rejects(
      () =>
        createBackup({
          repoRoot: env.root,
          outDir: join(env.root, 'backups'),
          now: NOW,
          snapshotDatabase: async (dest) => writeFileSync(dest, 'X', 'utf8'),
        }),
      /已存在，拒绝覆盖/,
    )
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 校验 ------------------------------ */

test('★ F20：verifyBackup 抓出被改动的文件与缺失的文件', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    assert.deepEqual(verifyBackup(dir), { ok: true, issues: [] })

    writeFileSync(join(dir, 'config', 'plugins.base.json'), '{"tampered":true}', 'utf8')
    rmSync(join(dir, 'data', 'attachments', 'abc123.bin'))
    const v = verifyBackup(dir)
    assert.equal(v.ok, false)
    assert.equal(v.issues.length, 2)
    assert.ok(v.issues.some((i) => i.startsWith('哈希不符：config/plugins.base.json')))
    assert.ok(v.issues.some((i) => i.startsWith('缺失：data/attachments/abc123.bin')))
  } finally {
    env.cleanup()
  }
})

test('★ F20：清单格式版本不匹配即拒绝（改结构时必须升版本号的理由）', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    const m = JSON.parse(readFileSync(join(dir, BACKUP_MANIFEST_FILE), 'utf8')) as BackupManifest
    writeFileSync(
      join(dir, BACKUP_MANIFEST_FILE),
      JSON.stringify({ ...m, formatVersion: BACKUP_FORMAT_VERSION + 1 }),
      'utf8',
    )
    assert.throws(() => readBackupManifest(dir), /格式版本不匹配/)
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 恢复 ------------------------------ */

test('★ F20：目标已存在数据库时【默认拒绝覆盖】，并说明怎么继续', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    assert.throws(
      () => restoreBackup({ backupDir: dir, repoRoot: env.root }),
      /拒绝覆盖[\s\S]*--force/,
    )
    // 拒绝之后原库必须原样在位（"拒绝"如果顺手改了东西，就不是拒绝）
    assert.equal(readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8'), 'OLD DB BYTES')
  } finally {
    env.cleanup()
  }
})

test('★ F20：--force 覆盖时原 data/ 被【移到一边而不是删掉】（唯一的救命绳）', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    writeFileSync(join(env.root, 'data', 'geewiki.db'), 'NEWER DB BYTES', 'utf8')
    const report = restoreBackup({ backupDir: dir, repoRoot: env.root, force: true })

    assert.ok(report.setAside, '必须报告被移到一边的目录')
    assert.equal(existsSync(report.setAside!), true)
    assert.equal(
      readFileSync(join(report.setAside!, 'geewiki.db'), 'utf8'),
      'NEWER DB BYTES',
      '被覆盖的那份数据必须还能读回来',
    )
    assert.equal(readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8'), 'CONSISTENT SNAPSHOT')
    assert.equal(report.restored.length, 4)
  } finally {
    env.cleanup()
  }
})

test('★ F20：备份损坏时【先拒绝，再不动任何文件】', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    writeFileSync(join(dir, 'config', 'secrets.json'), '{"broken":true}', 'utf8')
    assert.throws(
      () => restoreBackup({ backupDir: dir, repoRoot: env.root, force: true }),
      /备份校验失败，拒绝恢复/,
    )
    // 覆盖前的目标数据未被触碰
    assert.equal(readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8'), 'OLD DB BYTES')
  } finally {
    env.cleanup()
  }
})

test('★ F20：清单里的路径逃出仓库根时拒绝 —— 否则恢复就是任意写', async () => {
  const env = fakeRepo()
  try {
    const dir = await makeBackup(env.root)
    const m = readBackupManifest(dir)
    // 构造"被改过的清单 + 与之匹配的文件"：哈希是对的，故校验会通过，
    // 此时**只有**路径包含性检查能拦住它——这正是这条用例要单独钉住的原因。
    const relEscape = join('..', '..', 'evil.txt')
    const payload = 'PWNED'
    const absEscape = join(dir, relEscape)
    writeFileSync(absEscape, payload, 'utf8')
    writeFileSync(
      join(dir, BACKUP_MANIFEST_FILE),
      JSON.stringify({
        ...m,
        files: [
          ...m.files,
          {
            path: relEscape.split(sep).join('/'),
            bytes: payload.length,
            sha256: createHash('sha256').update(payload).digest('hex'),
          },
        ],
      }),
      'utf8',
    )
    assert.throws(
      () => restoreBackup({ backupDir: dir, repoRoot: env.root, force: true }),
      /清单条目|不在仓库根之内/,
    )
  } finally {
    env.cleanup()
  }
})

test('★ F20：config/*.json 全部进入备份（不含 secrets.json 的备份恢复后就丢了 API key）', async () => {
  const env = fakeRepo()
  try {
    writeFileSync(join(env.root, 'config', 'plugins.session.json'), '{"enabled":["x"]}', 'utf8')
    const dir = await makeBackup(env.root)
    const paths = pathsOf(readBackupManifest(dir))
    assert.ok(paths.includes('config/plugins.base.json'))
    assert.ok(paths.includes('config/plugins.session.json'))
    assert.ok(paths.includes('config/secrets.json'))
  } finally {
    env.cleanup()
  }
})

/* ------------------- 逻辑键 ↔ 物理落点（可移植性） ------------------- */

test('★ F20：清单键与物理落点解耦 —— 备份可在数据目录布局不同的机器上恢复', async () => {
  const env = fakeRepo()
  const other = mkdtempSync(join(tmpdir(), 'gw-restore-'))
  try {
    // 源仓库：数据放在 <root>/store/，而不是 <root>/data/
    const srcData = join(env.root, 'store')
    mkdirSync(srcData, { recursive: true })
    writeFileSync(join(srcData, 'geewiki.db'), 'SOURCE DB', 'utf8')
    const report = await createBackup({
      repoRoot: env.root,
      outDir: join(env.root, 'backups'),
      now: NOW,
      dataDir: srcData,
      snapshotDatabase: async (dest) => writeFileSync(dest, 'SNAP', 'utf8'),
    })
    // 键必须是**逻辑**路径：否则清单会绑死在"数据放在哪"上，换台机器就恢复不了
    const paths = report.manifest.files.map((f) => f.path)
    assert.ok(paths.includes('data/geewiki.db'), `键应为 data/geewiki.db，实际 ${paths.join(',')}`)
    assert.equal(paths.some((p) => p.startsWith('store/')), false, '不得泄漏物理布局')

    // 目标：一个布局**不同**的仓库（数据在 <other>/data，且没有库 ⇒ 无需 --force）
    mkdirSync(join(other, 'data'), { recursive: true })
    const report2 = restoreBackup({ backupDir: report.dir, repoRoot: other })
    assert.equal(readFileSync(join(other, 'data', 'geewiki.db'), 'utf8'), 'SNAP')
    assert.ok(report2.restored.includes('data/geewiki.db'))
    assert.equal(readFileSync(join(other, 'config', 'secrets.json'), 'utf8'), '{"openai":{"apiKey":"sk-x"}}')
  } finally {
    env.cleanup()
    rmSync(other, { recursive: true, force: true })
  }
})

test('★ F20：恢复端用 dataDir 覆盖时，写到被指定的位置而不是写死的 data/', async () => {
  const env = fakeRepo()
  const target = mkdtempSync(join(tmpdir(), 'gw-restore2-'))
  try {
    const dir = await makeBackup(env.root)
    const customData = join(target, 'srv-data')
    mkdirSync(customData, { recursive: true })
    restoreBackup({ backupDir: dir, repoRoot: target, dataDir: customData })
    assert.equal(readFileSync(join(customData, 'geewiki.db'), 'utf8'), 'CONSISTENT SNAPSHOT')
    // 写死的位置**不该**被创建：否则就是"恢复成功但服务读不到"
    assert.equal(existsSync(join(target, 'data', 'geewiki.db')), false)
  } finally {
    env.cleanup()
    rmSync(target, { recursive: true, force: true })
  }
})
