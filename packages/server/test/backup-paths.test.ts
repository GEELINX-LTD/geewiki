import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DatabaseAdapter } from '@geewiki/core'
import { createBackup, readBackupManifest, verifyBackup } from '../../manager/src/backup.js'
import { defaultRegistry, startServer } from '../src/index.js'
import { ADMIN_TOKEN, adminHeaders, freePort } from './helpers.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gw-backup-paths-'))
  const dataDir = join(root, 'storage', 'live')
  const configDir = join(root, 'settings', 'live')
  for (const dir of [dataDir, configDir, join(root, 'config'), join(root, 'elsewhere')]) mkdirSync(dir, { recursive: true })
  // --repo-root 指向隔离部署树；复用已安装驱动，不复制依赖，也不读取真实运行数据。
  const driverDir = join(root, 'packages', 'db-sqlite')
  mkdirSync(driverDir, { recursive: true })
  symlinkSync(fileURLToPath(new URL('../../db-sqlite/node_modules', import.meta.url)), join(driverDir, 'node_modules'), 'dir')
  writeFileSync(join(configDir, 'plugins.base.json'), JSON.stringify({ enabled: [] }))
  writeFileSync(join(configDir, 'secrets.json'), JSON.stringify({ '@t/provider': { apiKey: 'synthetic-backup-secret' } }))
  writeFileSync(join(root, 'config', 'plugins.base.json'), JSON.stringify({ enabled: [], decoy: true }))
  mkdirSync(join(dataDir, 'attachments'), { recursive: true })
  writeFileSync(join(dataDir, 'attachments', 'sample.txt'), '合成附件')
  const db = new DatabaseSync(join(dataDir, 'geewiki.db'))
  db.exec("CREATE TABLE backup_probe (value TEXT); INSERT INTO backup_probe VALUES ('synthetic-row')")
  db.close()
  return { root, dataDir, configDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function cli(script: 'backup' | 'restore', env: ReturnType<typeof fixture>, args: string[]) {
  const result = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL(`../../../scripts/${script}.ts`, import.meta.url)),
    ...args,
  ], {
    cwd: join(env.root, 'elsewhere'),
    env: { ...process.env, GEEWIKI_DATA_DIR: 'storage/live', GEEWIKI_CONFIG_DIR: 'settings/live' },
    encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result
}

test('备份 CLI：非仓库工作目录下按 --repo-root 解析自定义数据和配置目录，不混入默认配置', (t) => {
  const env = fixture()
  t.after(env.cleanup)
  const outDir = join(env.root, 'snapshots')
  const result = cli('backup', env, ['--repo-root', env.root, '--out', outDir])
  const backupDir = join(outDir, readdirSync(outDir)[0]!)
  const manifest = readBackupManifest(backupDir)
  assert.ok(manifest.files.some((file) => file.path === 'config/secrets.json'), '必须包含实际配置目录中的密钥')
  assert.equal(manifest.secretsIncluded, true)
  assert.deepEqual(verifyBackup(backupDir), { ok: true, issues: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(backupDir, 'config', 'plugins.base.json'), 'utf8')), { enabled: [] })
  assert.equal(readFileSync(join(backupDir, 'data', 'attachments', 'sample.txt'), 'utf8'), '合成附件')
  const snapshot = new DatabaseSync(join(backupDir, 'data', 'geewiki.db'), { readOnly: true })
  try { assert.equal(snapshot.prepare('SELECT value FROM backup_probe').get()?.['value'], 'synthetic-row') }
  finally { snapshot.close() }
  assert.equal(`${result.stdout}${result.stderr}`.includes('synthetic-backup-secret'), false)
})

test('恢复 CLI：把规范备份布局映射到自定义目标目录，默认配置保持原样', async (t) => {
  const env = fixture()
  t.after(env.cleanup)
  const backup = await createBackup({
    repoRoot: env.root, dataDir: env.dataDir, configDir: env.configDir,
    outDir: join(env.root, 'snapshots'), dialect: 'sqlite',
    snapshotDatabase: async (dest) => copyFileSync(join(env.dataDir, 'geewiki.db'), dest),
  })
  const original = readFileSync(join(env.root, 'config', 'plugins.base.json'), 'utf8')
  writeFileSync(join(env.configDir, 'plugins.base.json'), JSON.stringify({ enabled: [], changed: true }))
  writeFileSync(join(env.configDir, 'secrets.json'), '{}')
  writeFileSync(join(env.dataDir, 'attachments', 'sample.txt'), '恢复前附件')
  cli('restore', env, [backup.dir, '--repo-root', env.root, '--force'])
  assert.deepEqual(JSON.parse(readFileSync(join(env.configDir, 'plugins.base.json'), 'utf8')), { enabled: [] })
  assert.equal(readFileSync(join(env.configDir, 'secrets.json'), 'utf8').includes('synthetic-backup-secret'), true)
  assert.equal(readFileSync(join(env.root, 'config', 'plugins.base.json'), 'utf8'), original)
  assert.equal(existsSync(join(env.root, 'config', 'secrets.json')), false)
  assert.equal(readFileSync(join(env.dataDir, 'attachments', 'sample.txt'), 'utf8'), '合成附件')
})

test('HTTP 备份：实际清单目录优先于环境变量，数据目录与宿主一致', { timeout: 30000 }, async () => {
  const env = fixture()
  const patch = { GEEWIKI_DATA_DIR: env.dataDir, GEEWIKI_CONFIG_DIR: join(env.root, 'config'), GEEWIKI_BACKUP_DIR: join(env.root, 'http-backups'), GEEWIKI_ADMIN_TOKEN: ADMIN_TOKEN }
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]))
  const previousCwd = process.cwd()
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    process.chdir(join(env.root, 'elsewhere'))
    Object.assign(process.env, patch)
    const port = await freePort()
    const registry = defaultRegistry(null, { port, host: '127.0.0.1' })
      .filter((entry) => ['@geewiki/db-sqlite', '@geewiki/http'].includes(entry.name))
    writeFileSync(join(env.configDir, 'plugins.base.json'), JSON.stringify({ enabled: registry.map(({ name }) => ({ name })) }))
    handle = await startServer({ registry, configDir: env.configDir, webDist: null, pluginsDir: null, requiredServices: ['db', 'http'] })
    // WAL 中的新提交必须出现在实际数据库的快照中。
    const db = handle.app.get('db') as DatabaseAdapter
    db.run("INSERT INTO backup_probe VALUES ('live-wal-row')")
    const response = await fetch(`http://127.0.0.1:${port}/api/backup`, { method: 'POST', headers: adminHeaders({ connection: 'close' }) })
    const body = await response.json() as { ok: boolean; dir: string; secretsIncluded: boolean }
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.secretsIncluded, true)
    assert.equal(readBackupManifest(body.dir).database.included, true)
    assert.deepEqual(verifyBackup(body.dir), { ok: true, issues: [] })
    assert.equal(readFileSync(join(body.dir, 'config', 'secrets.json'), 'utf8').includes('synthetic-backup-secret'), true)
    assert.equal(readFileSync(join(body.dir, 'data', 'attachments', 'sample.txt'), 'utf8'), '合成附件')
    const snapshot = new DatabaseSync(join(body.dir, 'data', 'geewiki.db'), { readOnly: true })
    try { assert.equal(snapshot.prepare('SELECT count(*) AS n FROM backup_probe').get()?.['n'], 2) }
    finally { snapshot.close() }
  } finally {
    await handle?.dispose()
    process.chdir(previousCwd)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    env.cleanup()
  }
})
