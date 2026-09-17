/**
 * ★ 优化点 6：`tmp/` 清理的守卫。
 *
 * ## 这个文件要防的失效
 * 递归删除**不可逆**，而它的失败模式不是"报错"，是"删掉了不该删的东西"。
 * 所以这里重点钉的不是"能不能删"，而是**四道闸门是否真的在**：
 * 1. 默认只产出计划（`planCleanup` 是纯函数，根本不碰文件系统）；
 * 2. `tmp` 必须是仓库内的真实目录 —— **符号链接逃逸**这一条尤其要紧：
 *    若 `tmp/` 被换成指向 `/somewhere/else` 的链接，`readdir + rmSync` 就会删到仓库外，
 *    而这一切在删除**之前**不会有任何报错；
 * 3. 太新的条目默认保留（验证脚本常常正在往 `tmp/` 里写东西）；
 * 4. 只删计划内的条目，不碰计划外的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MaintenanceError,
  assertSafeTempDir,
  deleteTempEntries,
  formatBytes,
  planCleanup,
  readTempEntries,
  summarize,
  type TempEntry,
} from '../src/maintenance.js'

const entry = (name: string, over: Partial<TempEntry> = {}): TempEntry => ({
  name,
  path: `/tmp-root/${name}`,
  bytes: 100,
  mtimeMs: 0,
  isSymlink: false,
  ...over,
})

const DAY = 24 * 60 * 60 * 1000

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/* ------------------------------ 纯判据 ------------------------------ */

test('★ 优化点 6：太新的条目默认保留，且理由可见（验证脚本可能正在写）', () => {
  const now = 1_000 * DAY
  const plan = planCleanup(
    [
      entry('old-scratch', { mtimeMs: now - 3 * DAY, bytes: 2048 }),
      entry('in-flight', { mtimeMs: now - 1000, bytes: 4096 }),
    ],
    { now, olderThanMs: DAY },
  )
  assert.deepEqual(
    plan.targets.map((t) => t.name),
    ['old-scratch'],
  )
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.skipped[0]!.entry.name, 'in-flight')
  assert.match(plan.skipped[0]!.reason, /太新/)
  // 体积统计要分开：可释放 vs 合计
  assert.equal(plan.targetBytes, 2048)
  assert.equal(plan.totalBytes, 6144)
})

test('★ 优化点 6：--all（olderThanMs=0）不限时间；受保护的名字永不删', () => {
  const now = 1_000 * DAY
  const all = planCleanup([entry('a', { mtimeMs: now }), entry('b', { mtimeMs: now })], {
    now,
    olderThanMs: 0,
  })
  assert.equal(all.targets.length, 2, 'olderThanMs=0 表示不设时间限制')
  assert.deepEqual(all.skipped, [])

  const guarded = planCleanup([entry('.gitignore'), entry('.keep'), entry('scratch')], {
    now,
    olderThanMs: 0,
  })
  assert.deepEqual(
    guarded.targets.map((t) => t.name),
    ['scratch'],
  )
  assert.equal(guarded.skipped.length, 2)
  for (const s of guarded.skipped) assert.match(s.reason, /受保护/)
})

test('★ 优化点 6：空目录 / 全被保留时不报错，计划为空', () => {
  const plan = planCleanup([], { now: 0, olderThanMs: DAY })
  assert.deepEqual(plan.targets, [])
  assert.equal(plan.targetBytes, 0)
  assert.equal(plan.totalBytes, 0)
})

test('★ 优化点 6：formatBytes 的边界（含非法输入不吐 NaN）', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB')
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB')
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(formatBytes(bad).includes('NaN'), false, `${bad} 不该吐出 NaN`)
  }
})

/* ------------------------------ 读目录 ------------------------------ */

test('★ 优化点 6：readTempEntries 求体积但【不跟随】符号链接', () => {
  const env = tempDir('gw-maint-read-')
  try {
    const outside = tempDir('gw-maint-outside-')
    try {
      writeFileSync(join(env.dir, 'plain.txt'), 'x'.repeat(100), 'utf8')
      mkdirSync(join(env.dir, 'sub'), { recursive: true })
      writeFileSync(join(env.dir, 'sub', 'inner.txt'), 'y'.repeat(50), 'utf8')
      // 指向仓库外的大目录：跟随的话体积会把它算进来，且删除时语义会变得危险
      writeFileSync(join(outside.dir, 'big.txt'), 'z'.repeat(100000), 'utf8')
      symlinkSync(outside.dir, join(env.dir, 'link-out'), 'dir')

      const entries = readTempEntries(env.dir)
      const byName = new Map(entries.map((e) => [e.name, e]))
      assert.equal(byName.get('plain.txt')!.bytes, 100)
      assert.equal(byName.get('sub')!.bytes, 50, '目录体积应递归求')
      const link = byName.get('link-out')!
      assert.equal(link.isSymlink, true, '必须标出符号链接')
      assert.equal(link.bytes, 0, '不跟随符号链接（否则会走出 tmp/ 甚至走进环）')
      // 按体积降序（CLI 直接照此打印）
      assert.equal(entries[0]!.name, 'plain.txt')
    } finally {
      outside.cleanup()
    }
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 6：目录不存在时 readTempEntries 返回空数组而不是抛错', () => {
  assert.deepEqual(readTempEntries(join(tmpdir(), 'gw-maint-does-not-exist-xyz')), [])
})

/* --------------------------- 安全闸门（重点） --------------------------- */

test('★ 优化点 6：tmp 是指向仓库外的符号链接时【拒绝操作】—— 否则会删到仓库外', () => {
  const env = tempDir('gw-maint-escape-')
  try {
    const repo = join(env.dir, 'repo')
    mkdirSync(repo, { recursive: true })
    const outside = join(env.dir, 'elsewhere', 'tmp')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'victim.txt'), 'must survive\n', 'utf8')
    // repo/tmp → <env>/elsewhere/tmp（名字仍是 "tmp"，故只有包含性检查能拦住它）
    symlinkSync(outside, join(repo, 'tmp'), 'dir')

    assert.throws(
      () => assertSafeTempDir(join(repo, 'tmp'), repo),
      (err: unknown) => {
        assert.ok(err instanceof MaintenanceError, `应是 MaintenanceError，实测 ${String(err)}`)
        assert.match(err.message, /不在仓库根/)
        return true
      },
    )
    // 闸门只是"拒绝操作"，绝不该顺手删掉什么
    assert.equal(readTempEntries(outside).length, 1, '受害者文件必须原样存在')
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 6：目录名不是 "tmp" 时拒绝（本模块不是通用删除工具）', () => {
  const env = tempDir('gw-maint-name-')
  try {
    const dir = join(env.dir, 'data')
    mkdirSync(dir, { recursive: true })
    assert.throws(() => assertSafeTempDir(dir, env.dir), /目录名不是 "tmp"/)
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 6：正常的仓库内 tmp 通过闸门，并解析为真实路径', () => {
  const env = tempDir('gw-maint-ok-')
  try {
    const dir = join(env.dir, 'tmp')
    mkdirSync(dir, { recursive: true })
    assert.equal(assertSafeTempDir(dir, env.dir), assertSafeTempDir(dir, env.dir))
    // 不存在的目录：直接返回解析后的绝对路径（调用方会先判存在）
    assert.ok(assertSafeTempDir(join(env.dir, 'tmp', 'nope'), env.dir).endsWith('nope'))
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 真删 ------------------------------ */

test('★ 优化点 6：deleteTempEntries 只删计划内条目，计划外的原样保留', () => {
  const env = tempDir('gw-maint-del-')
  try {
    mkdirSync(join(env.dir, 'old-dir'), { recursive: true })
    writeFileSync(join(env.dir, 'old-dir', 'a.txt'), 'a', 'utf8')
    writeFileSync(join(env.dir, 'old-file.txt'), 'b', 'utf8')
    writeFileSync(join(env.dir, 'keep-me.txt'), 'c', 'utf8')

    const entries = readTempEntries(env.dir)
    const plan = planCleanup(entries, { now: Date.now(), olderThanMs: 0, protect: ['keep-me.txt'] })
    assert.equal(plan.targets.length, 2)
    const n = deleteTempEntries(plan)
    assert.equal(n, 2)

    const left = readTempEntries(env.dir).map((e) => e.name)
    assert.deepEqual(left, ['keep-me.txt'], '受保护条目必须还在')
  } finally {
    env.cleanup()
  }
})

test('★ 优化点 6：汇总文案里必须写明「不碰 data/」', () => {
  // 这不是装饰：tmp/ 与 data/ 只差一个字，而后者是真实数据。
  // 输出里显式写出边界，是为了让执行者在按下 --yes 之前就能确认自己删的是哪一个。
  const text = summarize(planCleanup([entry('x')], { now: 0, olderThanMs: 0 }))
  assert.match(text, /data\//)
  assert.match(text, /不碰/)
  assert.match(text, /config\//)
})
