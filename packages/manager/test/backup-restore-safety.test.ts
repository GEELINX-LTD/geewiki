import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { BACKUP_MANIFEST_FILE, createBackup, readBackupManifest, restoreBackup, validateRestore, verifyBackup } from '../src/backup.js'

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'gw-restore-safety-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const dir of ['data/attachments', 'config']) fs.mkdirSync(join(root, dir), { recursive: true })
  fs.writeFileSync(join(root, 'data', 'geewiki.db'), 'current-database')
  fs.writeFileSync(join(root, 'data', 'geewiki.db-wal'), 'current-wal')
  fs.writeFileSync(join(root, 'data', 'attachments', 'a.txt'), 'snapshot-attachment')
  fs.writeFileSync(join(root, 'config', 'plugins.base.json'), '{"enabled":[]}')
  fs.writeFileSync(join(root, 'config', 'secrets.json'), '{"key":"snapshot-secret"}')
  const backup = await createBackup({
    repoRoot: root, outDir: join(root, 'backups'),
    snapshotDatabase: async (dest) => fs.writeFileSync(dest, 'snapshot-database'),
  })
  fs.writeFileSync(join(root, 'config', 'secrets.json'), '{"key":"current-secret"}')
  fs.writeFileSync(join(root, 'config', 'local.json'), '{"keep":true}')
  const options = { backupDir: backup.dir, repoRoot: root, force: true }
  return { root, backup, options }
}

function tree(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {}
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(String).sort()
    .filter((path) => fs.lstatSync(join(root, path)).isFile())
    .map((path) => [path, fs.readFileSync(join(root, path)).toString('base64')]))
}
const live = (root: string) => ({ data: tree(join(root, 'data')), config: tree(join(root, 'config')) })
const noStages = (root: string) => assert.equal(fs.readdirSync(root).some((name) => name.includes('.restore-stage-')), false)

function patchFs<K extends 'copyFileSync' | 'renameSync'>(t: TestContext, key: K, fn: typeof fs[K]): void {
  const original = fs[key]
  t.mock.method(fs, key, fn)
  syncBuiltinESMExports()
  t.after(() => { fs[key] = original; syncBuiltinESMExports() })
}

test('恢复：清单结构、重复路径和文件/目录冲突在写入前拒绝', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const manifest = env.backup.manifest
  const first = manifest.files[0]!
  const cases = [
    null,
    { ...manifest, database: null },
    { ...manifest, createdAt: 'not-a-date' },
    { ...manifest, secretsIncluded: false },
    { ...manifest, files: [null] },
    { ...manifest, files: [{ ...first, bytes: -1 }] },
    { ...manifest, files: [{ ...first, sha256: 'not-a-hash' }] },
    { ...manifest, files: [...manifest.files, first] },
    { ...manifest, files: [...manifest.files, { ...first, path: 'data/GEEWIKI.DB' }] },
    { ...manifest, files: [...manifest.files, { ...first, path: 'data/attachments' }] },
    ...['../escape', '/data/x', 'data/../escape', 'data//x', 'data\\escape', 'data/C:x', 'README.md', 'config/sub/a.json', 'data/geewiki.db-wal'].map((path) => ({
      ...manifest, files: [...manifest.files, { ...first, path }],
    })),
  ]
  for (const value of cases) {
    fs.writeFileSync(join(env.backup.dir, BACKUP_MANIFEST_FILE), JSON.stringify(value))
    assert.throws(() => restoreBackup(env.options), /清单/)
    assert.deepEqual(live(env.root), before)
    noStages(env.root)
  }
})

test('恢复：哈希正确但大小元数据错误也拒绝，完整预检不写文件', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const manifest = env.backup.manifest
  fs.writeFileSync(join(env.backup.dir, BACKUP_MANIFEST_FILE), JSON.stringify({
    ...manifest, files: manifest.files.map((file, i) => i === 0 ? { ...file, bytes: file.bytes + 1 } : file),
  }))
  assert.equal(verifyBackup(env.backup.dir).ok, false)
  assert.throws(() => validateRestore(env.options), /大小不符/)
  assert.deepEqual(live(env.root), before)
  noStages(env.root)
})

test('恢复：源文件、清单、目标子文件与目标根的符号链接均拒绝', async (t) => {
  for (const kind of ['source', 'manifest', 'target-file', 'target-root']) {
    await t.test(kind, async (child) => {
      const env = await fixture(child)
      if (kind === 'source') {
        const source = join(env.backup.dir, 'data', 'geewiki.db')
        fs.renameSync(source, join(env.root, 'external-snapshot'))
        fs.symlinkSync(join(env.root, 'external-snapshot'), source)
      } else if (kind === 'manifest') {
        const source = join(env.backup.dir, BACKUP_MANIFEST_FILE)
        fs.renameSync(source, join(env.root, 'external-manifest.json'))
        fs.symlinkSync(join(env.root, 'external-manifest.json'), source)
      } else if (kind === 'target-file') {
        fs.renameSync(join(env.root, 'config', 'secrets.json'), join(env.root, 'external-secret.json'))
        fs.symlinkSync(join(env.root, 'external-secret.json'), join(env.root, 'config', 'secrets.json'))
      } else {
        fs.renameSync(join(env.root, 'config'), join(env.root, 'external-config'))
        fs.symlinkSync(join(env.root, 'external-config'), join(env.root, 'config'))
      }
      const before = fs.readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8')
      assert.throws(() => restoreBackup(env.options), /符号链接/)
      assert.equal(fs.readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8'), before)
      if (kind === 'target-file') assert.equal(fs.readFileSync(join(env.root, 'external-secret.json'), 'utf8'), '{"key":"current-secret"}')
      noStages(env.root)
    })
  }
})

test('恢复：目标重叠、备份源重叠和已有目录冲突在换入前拒绝', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  for (const patch of [
    { dataDir: join(env.root, 'config') },
    { configDir: join(env.root, 'data', 'nested') },
    { dataDir: env.root },
    { dataDir: join(env.root, 'backups') },
  ]) assert.throws(() => validateRestore({ ...env.options, ...patch }), /重叠|仓库根|备份源/)
  fs.rmSync(join(env.root, 'config', 'secrets.json'))
  fs.mkdirSync(join(env.root, 'config', 'secrets.json'))
  assert.throws(() => restoreBackup(env.options), /冲突/)
  assert.deepEqual(tree(join(env.root, 'data')), before.data)
  noStages(env.root)
})

test('恢复：只有配置冲突、没有数据库时默认也需要 --force', async (t) => {
  const env = await fixture(t)
  fs.rmSync(join(env.root, 'data'), { recursive: true })
  assert.throws(() => validateRestore({ ...env.options, force: false }), /拒绝覆盖[\s\S]*--force/)
  assert.equal(fs.existsSync(join(env.root, 'data')), false)
  validateRestore(env.options)
  assert.equal(fs.existsSync(join(env.root, 'data')), false)
  noStages(env.root)
})

test('恢复：暂存复制失败不修改任一原目录，也清理暂存', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const copy = fs.copyFileSync
  patchFs(t, 'copyFileSync', (source, dest, mode) => {
    if (String(source) === join(env.backup.dir, 'config', 'secrets.json')) throw new Error('synthetic ENOSPC')
    copy(source, dest, mode)
  })
  assert.throws(() => restoreBackup(env.options), /已回退原数据和配置[\s\S]*synthetic ENOSPC/)
  assert.deepEqual(live(env.root), before)
  noStages(env.root)
  assert.equal(fs.readdirSync(env.root).some((name) => name.includes('.pre-restore-')), false)
})

test('恢复：第二个目录换入失败，原数据与配置一起回退', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const rename = fs.renameSync
  patchFs(t, 'renameSync', (source, dest) => {
    if (String(source).includes('.restore-stage-') && String(dest) === join(env.root, 'config')) throw new Error('synthetic commit failure')
    rename(source, dest)
  })
  assert.throws(() => restoreBackup(env.options), /已回退原数据和配置[\s\S]*synthetic commit failure/)
  assert.deepEqual(live(env.root), before)
  noStages(env.root)
  assert.equal(fs.readdirSync(env.root).some((name) => name.includes('.pre-restore-')), false)
})

test('恢复：暂存内容在复制时变化也拒绝，目标仍保持原状', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const copy = fs.copyFileSync
  patchFs(t, 'copyFileSync', (source, dest, mode) => {
    copy(source, dest, mode)
    if (String(source) === join(env.backup.dir, 'config', 'secrets.json')) fs.writeFileSync(dest, 'changed-during-copy')
  })
  assert.throws(() => restoreBackup(env.options), /暂存文件校验失败/)
  assert.deepEqual(live(env.root), before)
  noStages(env.root)
})

test('恢复：首次恢复换入失败后清理新目标及本次创建的空父目录', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const target = join(env.root, 'new-deployment')
  const rename = fs.renameSync
  patchFs(t, 'renameSync', (source, dest) => {
    if (String(source).includes('.restore-stage-') && String(dest) === join(target, 'config')) throw new Error('synthetic first-restore failure')
    rename(source, dest)
  })
  assert.throws(() => restoreBackup({ ...env.options, dataDir: join(target, 'data'), configDir: join(target, 'config') }), /已回退/)
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(live(env.root), before)
})

test('恢复：回退自身失败仍保留原目录并明确报告，不能假报已回退', async (t) => {
  const env = await fixture(t)
  const rename = fs.renameSync
  patchFs(t, 'renameSync', (source, dest) => {
    if (String(source).includes('.restore-stage-') && String(dest) === join(env.root, 'config')) throw new Error('synthetic commit failure')
    if (String(source).includes('.pre-restore-') && String(dest) === join(env.root, 'data')) throw new Error('synthetic rollback failure')
    rename(source, dest)
  })
  assert.throws(() => restoreBackup(env.options), /回退未完成[\s\S]*data.pre-restore-[\s\S]*synthetic rollback failure/)
  const saved = fs.readdirSync(env.root).find((name) => name.startsWith('data.pre-restore-'))!
  assert.equal(fs.readFileSync(join(env.root, saved, 'geewiki.db'), 'utf8'), 'current-database')
  assert.equal(fs.readFileSync(join(env.root, 'config', 'secrets.json'), 'utf8'), '{"key":"current-secret"}')
  noStages(env.root)
})

test('恢复：成功后两份原目录留底，配置覆盖保留未列入的文件，数据库不带旧 WAL', async (t) => {
  const env = await fixture(t)
  const before = live(env.root)
  const report = restoreBackup(env.options)
  assert.ok(report.setAside)
  assert.ok(report.configSetAside)
  assert.deepEqual(tree(report.setAside), before.data)
  assert.deepEqual(tree(report.configSetAside), before.config)
  assert.equal(fs.readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8'), 'snapshot-database')
  assert.equal(fs.existsSync(join(env.root, 'data', 'geewiki.db-wal')), false)
  assert.equal(fs.readFileSync(join(env.root, 'config', 'secrets.json'), 'utf8'), '{"key":"snapshot-secret"}')
  assert.equal(fs.readFileSync(join(env.root, 'config', 'local.json'), 'utf8'), '{"keep":true}')
  noStages(env.root)
})

test('恢复：不含数据库的部分备份保留目标现有数据库和边车', async (t) => {
  const env = await fixture(t)
  const partial = await createBackup({ repoRoot: env.root, outDir: join(env.root, 'partial') })
  const report = restoreBackup({ ...env.options, backupDir: partial.dir })
  assert.ok(report.setAside)
  assert.equal(fs.readFileSync(join(env.root, 'data', 'geewiki.db'), 'utf8'), 'current-database')
  assert.equal(fs.readFileSync(join(env.root, 'data', 'geewiki.db-wal'), 'utf8'), 'current-wal')
  assert.equal(fs.readFileSync(join(env.root, 'data', 'attachments', 'a.txt'), 'utf8'), 'snapshot-attachment')
})

test('恢复：格式合法、哈希匹配的额外仓库根文件不应获准写入', async (t) => {
  const env = await fixture(t)
  const content = 'unexpected root write'
  fs.writeFileSync(join(env.backup.dir, 'README.md'), content)
  fs.writeFileSync(join(env.backup.dir, BACKUP_MANIFEST_FILE), JSON.stringify({
    ...readBackupManifest(env.backup.dir),
    files: [...env.backup.manifest.files, { path: 'README.md', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }],
  }))
  const before = live(env.root)
  assert.throws(() => restoreBackup(env.options), /清单条目路径不合法/)
  assert.deepEqual(live(env.root), before)
  assert.equal(fs.existsSync(join(env.root, 'README.md')), false)
})
