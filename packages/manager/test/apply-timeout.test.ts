/**
 * ★ F14：插件 `apply()` 的超时保护。
 *
 * ## 这一层要防的失效
 * `apply()` 是**插件自己的代码**。一个死循环、或一个永不 settle 的 `await`，
 * 会让 `ctx.plugin()` 永远不返回——而激活跑在**进程启动路径**上，
 * 于是故障形态是「进程既没起来、也没报错、也不退出」，日志停在上一个插件。
 * 除了超时，没有任何别的机制能把这个状态变成一条可读的错误。
 *
 * 于是这里有三个**必须**钉住的方向：
 * 1. 卡死的 apply 必须在有限时间内变成一条明确的错误（而不是静默挂住）；
 * 2. 正常插件**不受影响**——超时定时器在正常路径上被清掉，不留悬挂句柄；
 * 3. 超时后**晚到**的 fiber 必须被回收，否则会得到一个**幽灵插件**：
 *    管理器认为它没激活，它却已经把服务/路由装进容器，且再无句柄可回收。
 *
 * 第 3 条比超时本身更要紧：它把「一个卡住的插件」变成「一个看不见的插件」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { DEFAULT_APPLY_TIMEOUT_SECONDS, normalizeRuntime } from '@geewiki/core'
import type { GeeWikiManifest, GeeWikiRuntime } from '@geewiki/core'
import { GeeWikiManager, ManagerError } from '../src/index.js'
import type { RegisteredPlugin } from '../src/deps.js'

/* ------------------------------ 夹具 ------------------------------ */

interface Env {
  baseFile: string
  sessionFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-apply-timeout-'))
  return {
    baseFile: join(dir, 'plugins.base.json'),
    sessionFile: join(dir, 'plugins.session.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 构造一个插件；`apply` 与 `runtime` 都由调用方给定 */
function plugin(
  name: string,
  opts: { runtime?: GeeWikiRuntime; apply?: RegisteredPlugin['module']['apply'] } = {},
): RegisteredPlugin {
  const manifest: GeeWikiManifest = {
    name,
    version: '1.0.0',
    geewiki: { requires: [], ...(opts.runtime ? { runtime: opts.runtime } : {}) },
  }
  const apply = opts.apply ?? (() => () => {})
  return { name, manifest, module: { name, apply } }
}

/** 永久不结算的 apply（模拟死循环 / 永不 settle 的 await） */
const neverSettles = (): Promise<never> => new Promise<never>(() => {})

async function bootEnv(env: Env, registry: RegisteredPlugin[]): Promise<GeeWikiManager> {
  writeFileSync(
    env.baseFile,
    `${JSON.stringify({ enabled: registry.map((e) => ({ name: e.name })) }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(env.sessionFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
  const manager = new GeeWikiManager(new Context(), {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
    crashMarkerFile: undefined,
  })
  await manager.boot()
  return manager
}

const snapshotOf = (manager: GeeWikiManager, name: string) => {
  const snap = manager.snapshot().find((s) => s.name === name)
  assert.ok(snap, `快照里应有 ${name}`)
  return snap
}

/* ---------------------------- 缺省值与逃生口 ---------------------------- */

test('★ F14：默认 apply 超时是 30 秒，且是「宽松」而非「灵敏」的取值', () => {
  assert.equal(DEFAULT_APPLY_TIMEOUT_SECONDS, 30)
  assert.equal(normalizeRuntime(undefined).applyTimeout, 30)
  assert.equal(normalizeRuntime({}).applyTimeout, 30)
  // 显式声明覆盖缺省
  assert.equal(normalizeRuntime({ applyTimeout: 2 }).applyTimeout, 2)
  // `<= 0` 是逃生口（不超时），必须**原样保留**而不是被 `??` 当成缺省替换掉
  assert.equal(normalizeRuntime({ applyTimeout: 0 }).applyTimeout, 0)
  // 与 drainTimeout 互不干扰（两个超时方向不同：加载 vs 卸载）
  const r = normalizeRuntime({ drainTimeout: 1 })
  assert.equal(r.drainTimeout, 1)
  assert.equal(r.applyTimeout, 30)
})

/* ------------------------------ 正常路径 ------------------------------ */

test('★ F14：apply 正常结算的插件不受影响，且不留悬挂定时器', async () => {
  const env = makeEnv()
  try {
    const fast = plugin('@t/fast', { apply: () => () => {} })
    const manager = await bootEnv(env, [fast])
    assert.equal(snapshotOf(manager, '@t/fast').state, 'active')
    assert.deepEqual(manager.sessionState().bootErrors, [])
    await manager.disposeAll()
  } finally {
    env.cleanup()
  }
})

/* ------------------------------ 卡死路径 ------------------------------ */

test('★ F14：apply 永不结算时 boot 有限返回，插件记为 error 而非静默挂住', async () => {
  const env = makeEnv()
  try {
    const stuck = plugin('@t/stuck', {
      runtime: { applyTimeout: 0.02 },
      apply: neverSettles,
    })
    const started = Date.now()
    const manager = await bootEnv(env, [stuck])
    const elapsed = Date.now() - started

    // boot 必须返回（不挂），且是被超时结束的——给足余量，只排除"根本没超时"
    assert.ok(elapsed < 5000, `boot 应在超时后返回，实测 ${elapsed}ms`)
    assert.equal(snapshotOf(manager, '@t/stuck').state, 'error')
    const errors = manager.sessionState().bootErrors
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /加载超时/)
    assert.match(errors[0]!, /@t\/stuck/)
  } finally {
    env.cleanup()
  }
})

test('★ F14：`applyTimeout: 0` 关闭超时——慢但有限的 apply 照常完成', async () => {
  const env = makeEnv()
  try {
    const slow = plugin('@t/slow', {
      runtime: { applyTimeout: 0 },
      apply: () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
    })
    const manager = await bootEnv(env, [slow])
    assert.equal(snapshotOf(manager, '@t/slow').state, 'active')
    assert.deepEqual(manager.sessionState().bootErrors, [])
    await manager.disposeAll()
  } finally {
    env.cleanup()
  }
})

test('★ F14：同一个慢插件，给了小超时就会被判超时（对照组）', async () => {
  const env = makeEnv()
  try {
    const slow = plugin('@t/slow2', {
      runtime: { applyTimeout: 0.01 },
      apply: () => new Promise<void>((resolve) => setTimeout(resolve, 80)),
    })
    const manager = await bootEnv(env, [slow])
    assert.equal(snapshotOf(manager, '@t/slow2').state, 'error')
    assert.match(manager.sessionState().bootErrors[0]!, /加载超时/)
  } finally {
    env.cleanup()
  }
})

/* --------------------------- 幽灵插件回收 --------------------------- */

test('★ F14：超时后晚到并成功的 fiber 被主动回收（不留幽灵插件）', async () => {
  const env = makeEnv()
  try {
    let disposed = false
    const late = plugin('@t/late', {
      runtime: { applyTimeout: 0.03 },
      // 120ms 后才结算并交出 disposer；超时（30ms）早已发生
      apply: () =>
        new Promise<() => void>((resolve) => {
          setTimeout(() => {
            resolve(() => {
              disposed = true
            })
          }, 120)
        }),
    })
    const manager = await bootEnv(env, [late])
    assert.equal(snapshotOf(manager, '@t/late').state, 'error')

    // 此刻 apply 尚未结算（30ms < 120ms），fiber 还回不来
    assert.equal(disposed, false, '超时发生时 apply 仍未结算')
    // 等它结算并被回收
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(disposed, true, '晚到的 fiber 必须被 dispose，否则是幽灵插件')
  } finally {
    env.cleanup()
  }
})

test('★ F14：晚到的 apply 最终【失败】时不产生 unhandledRejection', async () => {
  const env = makeEnv()
  try {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const late = plugin('@t/late-fail', {
        runtime: { applyTimeout: 0.03 },
        apply: () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('晚到的失败')), 100)
          }),
      })
      const manager = await bootEnv(env, [late])
      assert.equal(snapshotOf(manager, '@t/late-fail').state, 'error')
      // 给那个 promise 足够时间结算——它的失败必须已被接住
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.deepEqual(rejections, [], '无人等待的 promise 失败必须被吞掉，不能冒泡成 unhandledRejection')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  } finally {
    env.cleanup()
  }
})

/* ------------------------- 错误码不被降级吞掉 ------------------------- */

test('★ F14：热启用路径抛出带 code `load_timeout` 的 ManagerError（不被包成 load_failed）', async () => {
  const env = makeEnv()
  try {
    writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
    writeFileSync(env.sessionFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
    const stuck = plugin('@t/hot-stuck', {
      runtime: { applyTimeout: 0.02, supportsHotReload: true },
      apply: neverSettles,
    })
    const manager = new GeeWikiManager(new Context(), {
      registry: [stuck],
      baseFile: env.baseFile,
      sessionFile: env.sessionFile,
      crashMarkerFile: undefined,
    })
    await manager.boot()

    await assert.rejects(
      () => manager.enable('@t/hot-stuck'),
      (err: unknown) => {
        assert.ok(err instanceof ManagerError, `应是 ManagerError，实测 ${String(err)}`)
        // 这条是本项最容易退化的一环：`activateCore` 的 catch 曾把**所有**错误
        // 一律包成 `load_failed`，于是 REST 层只能按 400 回，运维看不到"是超时"。
        assert.equal((err as ManagerError).code, 'load_timeout')
        assert.deepEqual((err as ManagerError).details, { timeoutSeconds: 0.02 })
        return true
      },
    )
    // 超时失败不留半激活态：state 是 'error'（"试过且失败"，带原因）而不是 'active'。
    // 注意**不是** 'inactive'——管理器会把失败原因留在快照里供管理台显示，
    // 这正是本设施的意图：把"卡住"变成一个**可见的**失败，而不是一个静默的空洞。
    const snap = snapshotOf(manager, '@t/hot-stuck')
    assert.equal(snap.state, 'error')
    assert.match(snap.error ?? '', /加载超时/)
    assert.equal(snap.layer, null)
  } finally {
    env.cleanup()
  }
})
