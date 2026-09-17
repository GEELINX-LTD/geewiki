/**
 * **临时停用**（进程内停用基础层插件）的契约测试。
 *
 * 用户口径："立即停止，若没有另行持久化，重启后仍启用"。翻译成可断言的四条：
 *   1. 停用基础层插件**不再是错误**（此前 `base_layer` 直接拒绝，界面上那句"先临时停用"
 *      是一句做不到的提示），且立即生效（dispose 被调用）；
 *   2. **不落任何盘**——基础清单与会话清单都与停用前逐字节相同；`runtimeDisabled` 置位，
 *      于是界面能把"临时停用"与"未启用"分开上色；
 *   3. **重启即恢复**：新起一个管理器 boot，它照基础清单重新装配（这是与"未启用"的唯一区别）；
 *   4. **可持久化**：`persistSession()` 把条目从基础清单删掉并清登记，此后重启也不再加载；
 *      反向地，重新启用（或作为依赖被拉起）会清掉登记（不得出现"既在跑又被标记停用"）。
 *
 * 另有两处必须钉住的边界：有活跃依赖方时**两种层都拒绝**（先卸再报错就已经把别人弄坏了）；
 * 会话层插件停用走原路径（从会话清单移除），**不得**被误登记成基础层临时停用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { GeeWikiManager, ManagerError, type RegisteredPlugin } from '../src/index.js'

interface Env {
  dir: string
  baseFile: string
  sessionFile: string
  markerFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-tmpdisable-'))
  return {
    dir,
    baseFile: join(dir, 'plugins.base.json'),
    sessionFile: join(dir, 'plugins.session.json'),
    markerFile: join(dir, 'crash.marker'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function writeList(file: string, enabled: { name: string; config?: Record<string, unknown> }[]): void {
  writeFileSync(file, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

function makeManager(env: Env, registry: RegisteredPlugin[]): GeeWikiManager {
  return new GeeWikiManager(new Context(), {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
    crashMarkerFile: env.markerFile,
  })
}

function plugin(
  name: string,
  log: string[],
  requires: string[] = [],
  opts: { cold?: boolean } = {},
): RegisteredPlugin {
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: { requires, runtime: { supportsHotReload: opts.cold !== true, drainTimeout: 0 } },
    },
    module: {
      name,
      apply: () => {
        log.push(`apply:${name}`)
        return () => log.push(`dispose:${name}`)
      },
    },
  }
}

const snap = (m: GeeWikiManager, name: string) => {
  const s = m.snapshot().find((p) => p.name === name)
  assert.ok(s, `快照应含 ${name}`)
  return s
}

test('临时停用：基础层插件可就地停用，立即生效且两个清单文件都不动', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/a' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/a', log)])
    await m.boot()
    assert.equal(snap(m, '@t/a').state, 'active')
    assert.equal(snap(m, '@t/a').runtimeDisabled, false, '运行中不得被标记为临时停用')

    const baseBefore = readFileSync(env.baseFile, 'utf8')
    const sessionBefore = readFileSync(env.sessionFile, 'utf8')
    await m.disable('@t/a')

    assert.equal(snap(m, '@t/a').state, 'inactive', '停用后不得处于运行态')
    assert.equal(snap(m, '@t/a').runtimeDisabled, true, '基础层停用必须登记为"临时停用"')
    assert.deepEqual(log, ['apply:@t/a', 'dispose:@t/a'], '停用必须立即生效（dispose 已被调用）')
    assert.equal(readFileSync(env.baseFile, 'utf8'), baseBefore, '临时停用不得改动基础清单')
    assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '临时停用不得在会话清单里留条目')
    assert.deepEqual(m.sessionState().runtimeDisabled, ['@t/a'], 'sessionState 应透出临时停用名单')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('临时停用：重启后照基础清单恢复（与"未启用"的区别就在这里）', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/a' }])
    writeList(env.sessionFile, [])
    const log1: string[] = []
    const m1 = makeManager(env, [plugin('@t/a', log1)])
    await m1.boot()
    await m1.disable('@t/a')
    assert.equal(snap(m1, '@t/a').runtimeDisabled, true)
    await m1.disposeAll()

    // 新进程：临时停用只存在于上一个实例的内存里 ⇒ 这里必须重新加载
    const log2: string[] = []
    const m2 = makeManager(env, [plugin('@t/a', log2)])
    await m2.boot()
    assert.equal(snap(m2, '@t/a').state, 'active', '临时停用不落盘，重启后应恢复运行')
    assert.equal(snap(m2, '@t/a').runtimeDisabled, false, '新实例里不得残留临时停用登记')
    assert.deepEqual(m2.sessionState().runtimeDisabled, [])
    await m2.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('临时停用：应用并持久化后基础清单移除该条目，且重启不再加载', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/a' }, { name: '@t/b' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/a', log), plugin('@t/b', log)])
    await m.boot()
    await m.disable('@t/a')
    assert.equal(snap(m, '@t/a').runtimeDisabled, true)

    const result = m.persistSession()
    assert.deepEqual(result.disabled, ['@t/a'], 'persistSession 应报告被持久化停用的插件')
    assert.deepEqual(result.promoted, [])
    assert.deepEqual(m.sessionState().runtimeDisabled, [], '持久化成功后登记必须清空')
    assert.deepEqual(
      m.sessionState().base.enabled.map((e) => e.name),
      ['@t/b'],
      '基础清单里该条目应已移除',
    )
    assert.deepEqual(
      (JSON.parse(readFileSync(env.baseFile, 'utf8')) as { enabled: { name: string }[] }).enabled.map((e) => e.name),
      ['@t/b'],
      '落盘的清单也要真的少了它',
    )
    assert.equal(snap(m, '@t/a').runtimeDisabled, false)
    assert.equal(snap(m, '@t/a').layer, null, '已不在任何清单里，激活层应为 null')
    await m.disposeAll()

    const log2: string[] = []
    const m2 = makeManager(env, [plugin('@t/a', log2), plugin('@t/b', log2)])
    await m2.boot()
    assert.equal(snap(m2, '@t/a').state, 'inactive', '持久化停用后重启不得再加载')
    assert.deepEqual(log2, ['apply:@t/b'], '新实例只应装配基础清单里剩下的那个（b）')
    await m2.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('临时停用：重新启用（或作为依赖被拉起）会清掉登记，不得出现"既在跑又被标记停用"', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/a' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/a', log), plugin('@t/b', log, ['@t/a'])])
    await m.boot()
    await m.disable('@t/a')
    assert.equal(snap(m, '@t/a').runtimeDisabled, true)

    // 直接启用：这是"恢复"，不是"新启用" ⇒ 层仍是 base，且不得产生会话条目
    await m.enable('@t/a')
    assert.equal(snap(m, '@t/a').state, 'active')
    assert.equal(snap(m, '@t/a').runtimeDisabled, false, '激活即应撤销临时停用登记')
    assert.equal(snap(m, '@t/a').layer, 'base', '恢复基础层插件不得把层降级成 session')
    assert.deepEqual(m.sessionState().session.enabled, [], '恢复基础层插件不得写会话条目（否则成叠加态）')

    // 再停一次，这次由**依赖方**把它拉起来（走 activateCore 的同一条成功路径）
    await m.disable('@t/a')
    assert.equal(snap(m, '@t/a').runtimeDisabled, true)
    await m.enable('@t/b')
    assert.equal(snap(m, '@t/a').state, 'active', '依赖方启用应连带把它拉起来')
    assert.equal(snap(m, '@t/a').runtimeDisabled, false, '被依赖拉起同样要撤登记')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('临时停用：有活跃依赖方时拒绝，且拒绝必须发生在卸载之前', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/a' }, { name: '@t/b' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/a', log), plugin('@t/b', log, ['@t/a'])])
    await m.boot()

    await assert.rejects(
      () => m.disable('@t/a'),
      (err: unknown) => err instanceof ManagerError && err.code === 'has_dependents',
    )
    assert.equal(snap(m, '@t/a').state, 'active', '被拒绝时不得已经把它卸掉（守卫必须先于卸载）')
    assert.equal(snap(m, '@t/a').runtimeDisabled, false)
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('会话层插件停用仍走原路径：从会话清单移除，且不得被误登记成临时停用', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/a', log)])
    await m.boot()
    await m.enable('@t/a')
    assert.equal(snap(m, '@t/a').layer, 'session')

    await m.disable('@t/a')
    assert.equal(snap(m, '@t/a').state, 'inactive')
    assert.equal(
      snap(m, '@t/a').runtimeDisabled,
      false,
      '会话条目移除后重启本来就不会加载它，登记成"临时停用"会让界面说反话',
    )
    assert.deepEqual(
      (JSON.parse(readFileSync(env.sessionFile, 'utf8')) as { enabled: { name: string }[] }).enabled,
      [],
      '会话清单条目必须被清掉',
    )
    assert.deepEqual(m.sessionState().runtimeDisabled, [])
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('临时停用：不支持热插拔的基础层插件也能在同一进程内恢复（否则临时停用变成单向陷阱）', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/cold' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    /*
     * 反面教材（沙箱实测）：`@geewiki/org` 不支持热插拔、且没有活跃依赖方 ⇒ 能被临时停用，
     * 但重新启用撞上 `hot_reload_not_supported` ⇒ "停了只能重启才能起来"。
     * 恢复路径要豁免这条守卫：它要防的是"把从未在本进程跑过的冷插件热装上来"。
     */
    const m = makeManager(env, [plugin('@t/cold', log, [], { cold: true })])
    await m.boot()
    assert.equal(snap(m, '@t/cold').state, 'active')
    await m.disable('@t/cold')
    assert.equal(snap(m, '@t/cold').runtimeDisabled, true)

    await m.enable('@t/cold')
    assert.equal(snap(m, '@t/cold').state, 'active', '同一进程内必须能恢复')
    assert.equal(snap(m, '@t/cold').layer, 'base', '恢复后仍在基础层')
    assert.equal(snap(m, '@t/cold').runtimeDisabled, false)
    assert.deepEqual(m.sessionState().session.enabled, [], '恢复不得写会话条目')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('临时停用：从未运行过的冷插件仍然拒绝热启用（恢复豁免不得放宽守卫）', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/cold', log, [], { cold: true })])
    await m.boot()
    await assert.rejects(
      () => m.enable('@t/cold'),
      (err: unknown) => err instanceof ManagerError && err.code === 'hot_reload_not_supported',
      '没被临时停用过的冷插件不适用恢复豁免',
    )
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('依赖图与快照：runtimeDisabled 必须透出（界面靠它上第三种颜色）', async () => {
  const env = makeEnv()
  try {
    writeList(env.baseFile, [{ name: '@t/a' }])
    writeList(env.sessionFile, [])
    const log: string[] = []
    const m = makeManager(env, [plugin('@t/a', log)])
    await m.boot()
    const before = m.graph().nodes.find((n) => n.id === '@t/a')
    assert.equal(before?.runtimeDisabled, false)
    await m.disable('@t/a')
    const after = m.graph().nodes.find((n) => n.id === '@t/a')
    assert.equal(after?.runtimeDisabled, true, '依赖图节点必须带上临时停用标记')
    assert.equal(after?.state, 'inactive')
    await m.disposeAll()
  } finally {
    env.cleanup()
  }
})
