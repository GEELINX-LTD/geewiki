/**
 * GeeWikiManager 本体集成测试（node:test + tsx + 真实 cordis Context）。
 * 运行：pnpm --filter @geewiki/manager test
 *
 * 覆盖修复批次的关键语义：
 * 1. 崩溃标记（架构 §5.3）：boot 发现 marker → 忽略会话层装配 + 清理标记；
 *    优雅 disposeAll 删除标记（正常重启仍装配会话层）。
 * 3. persistSession 跳过激活失败（error/未装配）条目，坏配置不提升进基础层。
 * 4. enable 事务性：冲突预检零副作用；目标加载失败时逆序回滚已启用的依赖。
 * 5. 看门狗决策纯函数 decideWatchdog 的归因/熔断语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { GeeWikiManager, ManagerError, writeCrashMarker } from '../src/index.js'
import { decideWatchdog } from '../src/watchdog.js'
import type { RegisteredPlugin } from '../src/deps.js'

/* ------------------------------ helpers ------------------------------ */

interface Env {
  dir: string
  baseFile: string
  sessionFile: string
  markerFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-mgr-'))
  const baseFile = join(dir, 'plugins.base.json')
  const sessionFile = join(dir, 'plugins.session.json')
  const markerFile = join(dir, 'crash.marker')
  return {
    dir,
    baseFile,
    sessionFile,
    markerFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function writeList(file: string, enabled: { name: string; config?: Record<string, unknown> }[]): void {
  writeFileSync(file, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

function readList(file: string): { name: string; config?: Record<string, unknown> }[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { enabled: { name: string }[] }).enabled
}

function makeManager(
  env: Env,
  registry: RegisteredPlugin[],
  opts: { crashMarkerFile?: boolean } = {},
): GeeWikiManager {
  const ctx = new Context()
  return new GeeWikiManager(ctx, {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
    crashMarkerFile: opts.crashMarkerFile === false ? undefined : env.markerFile,
  })
}

function plugin(
  name: string,
  log: string[],
  opts: { fail?: boolean; requires?: string[]; conflictGroup?: string; cold?: boolean } = {},
): RegisteredPlugin {
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: {
        requires: opts.requires ?? [],
        conflictGroup: opts.conflictGroup,
        runtime: { supportsHotReload: opts.cold ? false : true, requiresCachePurge: false, drainTimeout: 5 },
      },
    },
    module: {
      name,
      apply: () => {
        if (opts.fail) throw new Error(`${name} boom`)
        log.push(`apply:${name}`)
        return () => log.push(`dispose:${name}`)
      },
    },
  }
}

function snapshotOf(manager: GeeWikiManager, name: string) {
  const s = manager.snapshot().find((p) => p.name === name)
  assert.ok(s, `快照应含 ${name}`)
  return s
}

/* ------------------------- 2. 崩溃标记（§5.3 自愈） ------------------------- */

test('boot：崩溃标记 → 忽略会话层装配并清理；无标记 → 正常装配；优雅 dispose 删除标记', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [{ name: '@t/echo' }])
    const log: string[] = []
    const registry = [plugin('@t/echo', log)]

    // (a) 无崩溃标记：会话层条目照常装配（优雅重启语义）
    const m1 = makeManager(env, registry)
    await m1.boot()
    assert.equal(snapshotOf(m1, '@t/echo').state, 'active')
    assert.equal(snapshotOf(m1, '@t/echo').layer, 'session')
    await m1.disposeAll()
    assert.deepEqual(log, ['apply:@t/echo', 'dispose:@t/echo'])

    // (b) 优雅退出后标记不存在 → 下次 boot 依旧装配会话层
    const m1b = makeManager(env, registry)
    await m1b.boot()
    assert.equal(snapshotOf(m1b, '@t/echo').state, 'active')
    await m1b.disposeAll()

    // (c) 崩溃退出（标记残留）→ 忽略会话层：不装配、清单视为空、标记被清理
    writeCrashMarker(env.markerFile, 'probe: uncaughtException')
    assert.ok(existsSync(env.markerFile), '标记应已写入')
    const m2 = makeManager(env, registry)
    await m2.boot()
    assert.equal(snapshotOf(m2, '@t/echo').state, 'inactive', '崩溃恢复后会话插件不得装配')
    assert.deepEqual(m2.sessionState().session.enabled, [], '会话清单应被忽略')
    assert.deepEqual(readList(env.sessionFile), [], '崩溃恢复后 session 文件应同步清空（与熔断路径对称，防下次启动重装配）')
    assert.equal(existsSync(env.markerFile), false, 'boot 后标记应被清理')
    assert.ok(
      m2.sessionState().bootErrors.some((e) => e.includes('崩溃标记')),
      'bootErrors 应有崩溃恢复提示',
    )
    await m2.disposeAll()

    // (d) 优雅 disposeAll 删除标记：预写标记后正常 boot（清掉），再写入 → dispose 删除
    writeCrashMarker(env.markerFile, 'again')
    const m3 = makeManager(env, registry)
    await m3.boot() // 忽略会话层并清理标记
    writeCrashMarker(env.markerFile, 'before-dispose')
    await m3.disposeAll()
    assert.equal(existsSync(env.markerFile), false, 'disposeAll 应删除标记（优雅退出）')
  } finally {
    env.cleanup()
  }
})

test('boot：未配置 crashMarkerFile 时 marker 机制不生效', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [{ name: '@t/echo' }])
    const log: string[] = []
    const registry = [plugin('@t/echo', log)]
    const m = makeManager(env, registry, { crashMarkerFile: false })
    writeCrashMarker(env.markerFile, 'ignored')
    await m.boot()
    assert.equal(snapshotOf(m, '@t/echo').state, 'active', '未启用 marker 时应照常装配会话层')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

/* ------------------------- 3. persist 跳过失败条目 ------------------------- */

test('persistSession：跳过激活失败条目，仅提升活动插件', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [{ name: '@t/fail' }, { name: '@t/ok' }])
    const log: string[] = []
    const registry = [
      plugin('@t/fail', log, { fail: true }),
      plugin('@t/ok', log),
    ]
    const m = makeManager(env, registry)
    await m.boot()
    assert.equal(snapshotOf(m, '@t/fail').state, 'error', 'fail 插件激活应失败并落 error 态')
    assert.equal(snapshotOf(m, '@t/ok').state, 'active')

    const { promoted } = m.persistSession()
    assert.deepEqual(promoted, ['@t/ok'], '仅活动插件被提升')
    const baseNames = readList(env.baseFile).map((e) => e.name)
    assert.deepEqual(baseNames, ['@t/ok'], '坏配置不得持久化进基础层')
    const sessionNames = readList(env.sessionFile).map((e) => e.name)
    assert.deepEqual(sessionNames, [], 'persist 后会话清空')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

/* ----------------------- 4. enable 事务性 / 冲突预检 ----------------------- */

test('enable：冲突组预检在任何副作用之前 → 409 且会话零残留', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/db-a' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const registry = [
      plugin('@t/db-a', log, { conflictGroup: 'database-provider' }),
      plugin('@t/db-b', log, { conflictGroup: 'database-provider' }),
    ]
    const m = makeManager(env, registry)
    await m.boot()
    assert.equal(snapshotOf(m, '@t/db-a').state, 'active')

    await assert.rejects(
      () => m.enable('@t/db-b'),
      (err: unknown) => err instanceof ManagerError && err.code === 'conflict_group',
      '同冲突组启用应 409 conflict_group',
    )
    assert.equal(snapshotOf(m, '@t/db-b').state, 'inactive')
    assert.deepEqual(m.sessionState().session.enabled, [], '失败路径不得写会话层')
    assert.deepEqual(readList(env.sessionFile).map((e) => e.name), [], '会话文件零残留')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('enable：目标加载失败 → 逆序回滚本次启用的依赖（无半激活残留）', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const registry = [
      plugin('@t/dep', log),
      plugin('@t/top', log, { requires: ['@t/dep'], fail: true }),
    ]
    const m = makeManager(env, registry)
    await m.boot()

    await assert.rejects(
      () => m.enable('@t/top'),
      (err: unknown) => err instanceof ManagerError && err.code === 'load_failed',
      '目标插件加载失败应抛 load_failed',
    )
    assert.equal(snapshotOf(m, '@t/dep').state, 'inactive', '依赖应被回滚卸载')
    // 目标自身留 error 态（激活失败留痕，UI 显示"重试"入口），但不产生任何会话/文件残留
    const top = snapshotOf(m, '@t/top')
    assert.equal(top.state, 'error')
    assert.ok(top.error, '应记录激活失败原因')
    assert.deepEqual(m.sessionState().session.enabled, [], '会话层无残留')
    assert.deepEqual(readList(env.sessionFile).map((e) => e.name), [], '会话文件无残留')
    assert.deepEqual(log, ['apply:@t/dep', 'dispose:@t/dep'], '依赖激活后应被逆序 dispose')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

/* --------------------------- 5. 看门狗决策函数 --------------------------- */

test('decideWatchdog：试用期回滚绑定最近会话插件，仅会话层存在时熔断', () => {
  const base = {
    consecutiveFailures: 0,
    meltdownThreshold: 3,
    gracePeriodMs: 5000,
    now: 100_000,
    lastEnabledName: '@t/echo' as string | null,
    lastEnabledAt: 99_000, // 窗口内（1s 前）
    lastEnabledActive: true,
    sessionNonEmpty: true,
  }
  // 无失败 → 无动作
  assert.deepEqual(decideWatchdog(base), { action: 'none' })
  // 窗口内失败 → 回滚最近会话插件（不因 base 故障连坐其它会话插件）
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 1 }), {
    action: 'rollback',
    name: '@t/echo',
  })
  // 回滚优先于熔断（失败已达标仍先回滚试用期插件）
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 3 }), {
    action: 'rollback',
    name: '@t/echo',
  })
  // 试用期窗口过期 → 不再归因回滚；会话层仍有变更 → 连续失败达标熔断
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 1, lastEnabledAt: 90_000 }), {
    action: 'none',
  })
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 3, lastEnabledAt: 90_000 }), {
    action: 'meltdown',
  })
  // 无会话层变更 → 纯基础层故障不触发看门狗动作
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 5, sessionNonEmpty: false }), {
    action: 'none',
  })
  // 无"最近会话插件"记录但会话层仍有条目（如 boot 装配失败残留）→ 连续失败达标仍熔断
  assert.deepEqual(
    decideWatchdog({ ...base, consecutiveFailures: 5, lastEnabledName: null, lastEnabledAt: null }),
    { action: 'meltdown' },
  )
  // 会话层完全空（无变更 + 无最近会话插件）→ 纯基础层故障不触发任何看门狗动作
  assert.deepEqual(
    decideWatchdog({
      ...base,
      consecutiveFailures: 5,
      sessionNonEmpty: false,
      lastEnabledName: null,
      lastEnabledAt: null,
    }),
    { action: 'none' },
  )
  // 最近会话插件已被停用（active=false）→ 不回滚
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 2, lastEnabledActive: false }), {
    action: 'none',
  })
  // 阈值以下连续失败（无试用期）→ 无动作
  assert.deepEqual(decideWatchdog({ ...base, consecutiveFailures: 2, lastEnabledAt: 90_000 }), {
    action: 'none',
  })
})

test('enable/disable：会话插件热启停与归因清空（end-to-end）', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const registry = [plugin('@t/echo', log)]
    const m = makeManager(env, registry)
    await m.boot()
    await m.enable('@t/echo')
    assert.equal(snapshotOf(m, '@t/echo').state, 'active')
    assert.equal(snapshotOf(m, '@t/echo').layer, 'session')

    // 停用后最近会话插件归因被清空（disable 路径）
    await m.disable('@t/echo')
    assert.equal(snapshotOf(m, '@t/echo').state, 'inactive')
    assert.deepEqual(readList(env.sessionFile).map((e) => e.name), [])
    await m.disposeAll()
    assert.deepEqual(log, ['apply:@t/echo', 'dispose:@t/echo'])
  } finally {
    env.cleanup()
  }
})
