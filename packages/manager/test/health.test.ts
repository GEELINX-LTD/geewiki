/**
 * ★ F12：插件健康检查 + 按登记方归因的请求计数。
 *
 * ## 这一层要防的失效
 * 插件"激活成功"只说明 `apply()` 没抛错，**不说明它现在是好的**：模型供应商连不上、
 * 迁移漏了一张表、外部 API 挂了，都发生在激活之后。没有探针时，运维只能从用户的报错里
 * 反推是哪个插件坏了 —— 而多插件系统里"某个插件半死不活"是最常见的故障形态。
 *
 * 探针本身也是插件代码，于是这里有三个**必须**钉住的方向：
 * 1. 探针**卡死**不能让健康端点整体挂住（超时是宿主强制的，且结论与 `ok:false` 分开）；
 * 2. 探针**抛错**不能让端点 500（报成 `error`，其余插件照常返回）；
 * 3. 探针**返回垃圾**不能被当成健康（形态校验失败 ⇒ `error`，绝不默认 `ok:true`）。
 *
 * 第 3 条是最要紧的：把"没看懂"当成"没问题"，是健康检查这类设施唯一会骗人的方式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { GeeWikiManifest, PluginHealth, PluginHealthReport } from '@geewiki/core'
import { GeeWikiManager } from '../src/index.js'
import type { RegisteredPlugin } from '../src/deps.js'

/* ------------------------------ 夹具 ------------------------------ */

interface Env {
  baseFile: string
  sessionFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-health-'))
  return {
    baseFile: join(dir, 'plugins.base.json'),
    sessionFile: join(dir, 'plugins.session.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 一个带可选健康探针的插件（探针挂到 `module.health` 上，见 deps.ts 的说明） */
function plugin(name: string, health?: RegisteredPlugin['module']['health']): RegisteredPlugin {
  const manifest: GeeWikiManifest = { name, version: '1.0.0', geewiki: { requires: [] } }
  return {
    name,
    manifest,
    module: health === undefined ? { name, apply: () => () => {} } : { name, apply: () => () => {}, health },
  }
}

/** 真激活插件（`boot()` 会按基础清单装配）；清单里逐个列出 */
async function bootEnv(env: Env, registry: RegisteredPlugin[]): Promise<GeeWikiManager> {
  const { writeFileSync } = await import('node:fs')
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

const byName = (reports: readonly PluginHealthReport[], name: string): PluginHealthReport => {
  const r = reports.find((x) => x.name === name)
  assert.ok(r, `报告里应有 ${name}`)
  return r
}

/* ------------------------------ 探针语义 ------------------------------ */

test('★ F12：只探测 active 插件；未激活的只报 state，不调探针', async () => {
  const env = makeEnv()
  let called = 0
  try {
    const inactive = plugin('@t/inactive', () => {
      called += 1
      return { ok: false, detail: '不该被调用' }
    })
    const registry = [plugin('@t/active', () => ({ ok: true })), inactive]
    // 只把 active 那个写进基础清单 ⇒ inactive 不会激活
    const { writeFileSync } = await import('node:fs')
    writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [{ name: '@t/active' }] }, null, 2)}\n`, 'utf8')
    writeFileSync(env.sessionFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
    const manager = new GeeWikiManager(new Context(), {
      registry,
      baseFile: env.baseFile,
      sessionFile: env.sessionFile,
      crashMarkerFile: undefined,
    })
    await manager.boot()

    const reports = await manager.pluginHealth()
    assert.equal(byName(reports, '@t/active').state, 'active')
    assert.deepEqual(byName(reports, '@t/active').health, { ok: true })
    assert.equal(byName(reports, '@t/inactive').state, 'inactive')
    assert.equal(byName(reports, '@t/inactive').health, undefined, '未激活的插件不该有健康结论')
    assert.equal(called, 0, '未激活插件的探针**一次都不能被调用**（"没在跑"不是"坏了"）')
  } finally {
    env.cleanup()
  }
})

test('★ F12：探针**卡死**时宿主强制超时，且结论与 `ok:false` 分开', async () => {
  const env = makeEnv()
  try {
    const manager = await bootEnv(env, [
      plugin('@t/hang', () => new Promise<PluginHealth>(() => {})), // 永不 settle
      plugin('@t/bad', () => ({ ok: false, detail: '上游挂了' })),
      plugin('@t/good', () => ({ ok: true })),
    ])
    const started = Date.now()
    const reports = await manager.pluginHealth(120)
    const elapsed = Date.now() - started

    const hang = byName(reports, '@t/hang')
    assert.equal(hang.timedOut, true, '卡死的探针必须报 timedOut')
    assert.equal(hang.health, undefined, 'timedOut 不是 ok:false —— "没问到"与"问到且它说坏了"要能区分')
    // 一个卡死的探针不能拖垮整次探测，也不能拖垮其它插件
    assert.ok(elapsed < 1500, `整体探测不该被卡死探针拖住（实测 ${elapsed}ms）`)
    assert.deepEqual(byName(reports, '@t/bad').health, { ok: false, detail: '上游挂了' })
    assert.deepEqual(byName(reports, '@t/good').health, { ok: true })
  } finally {
    env.cleanup()
  }
})

test('★ F12：探针抛错报成 `error`，不 500、不拖累其它插件', async () => {
  const env = makeEnv()
  try {
    const manager = await bootEnv(env, [
      plugin('@t/throws', () => {
        throw new Error('探针内部炸了')
      }),
      plugin('@t/rejects', () => Promise.reject(new Error('异步炸了'))),
      plugin('@t/fine', () => ({ ok: true })),
    ])
    const reports = await manager.pluginHealth(200)
    assert.equal(byName(reports, '@t/throws').error, '探针内部炸了')
    assert.equal(byName(reports, '@t/rejects').error, '异步炸了')
    assert.equal(byName(reports, '@t/throws').health, undefined, '抛错不是 ok:false')
    assert.deepEqual(byName(reports, '@t/fine').health, { ok: true }, '一个插件抛错不得影响其它插件的结论')
  } finally {
    env.cleanup()
  }
})

test('★ F12：没有探针的插件既不算健康也不算不健康（`health` 留空）', async () => {
  const env = makeEnv()
  try {
    const manager = await bootEnv(env, [plugin('@t/noprobe')])
    const report = byName(await manager.pluginHealth(), '@t/noprobe')
    assert.equal(report.state, 'active')
    /*
     * 把"没探针"报成 `ok:true` 是**撒谎**（我们并没有验证过任何东西），
     * 报成 `ok:false` 是误报。`undefined` 是唯一诚实的取值，消费方据此显示"未探测"。
     */
    assert.equal(report.health, undefined)
    assert.equal(report.error, undefined)
    assert.equal(report.timedOut, undefined)
  } finally {
    env.cleanup()
  }
})

test('★ F12：单插件探测失败不使整次聚合失败（逐个隔离）', async () => {
  const env = makeEnv()
  try {
    const manager = await bootEnv(env, [
      plugin('@t/a', () => {
        throw new Error('a')
      }),
      plugin('@t/b', () => ({ ok: true })),
      plugin('@t/c', () => {
        throw new Error('c')
      }),
    ])
    const reports = await manager.pluginHealth()
    assert.equal(reports.length, 3, '三个插件的报告都要在（不能因为有人抛错就整体 reject）')
    assert.equal(byName(reports, '@t/b').health?.ok, true)
  } finally {
    env.cleanup()
  }
})

test('★ F12：报告覆盖**全部注册插件**（含未启用的），名字与注册表一致', async () => {
  const env = makeEnv()
  try {
    const registry = [plugin('@t/one', () => ({ ok: true })), plugin('@t/two')]
    const manager = await bootEnv(env, registry)
    const names = (await manager.pluginHealth()).map((r) => r.name).sort()
    assert.deepEqual(names, ['@t/one', '@t/two'])
  } finally {
    env.cleanup()
  }
})

test('★ F12：探针返回形态非法 ⇒ `error`，绝不默认 `ok:true`（本设施唯一会骗人的方式）', async () => {
  const env = makeEnv()
  try {
    const manager = await bootEnv(env, [
      plugin('@t/undef', () => undefined as unknown as PluginHealth),
      plugin('@t/empty', () => ({}) as unknown as PluginHealth),
      plugin('@t/stringy', () => 'ok' as unknown as PluginHealth),
      plugin('@t/truthy-but-wrong', () => ({ ok: 1 }) as unknown as PluginHealth),
      plugin('@t/fine', () => ({ ok: true })),
    ])
    const reports = await manager.pluginHealth(200)
    for (const n of ['@t/undef', '@t/empty', '@t/stringy', '@t/truthy-but-wrong']) {
      const r = byName(reports, n)
      assert.ok(r.error, `${n} 的非法返回值必须报 error，而不是以"有 health"的形态出现`)
      assert.equal(r.health, undefined, `${n} 不得产出健康结论`)
    }
    assert.deepEqual(byName(reports, '@t/fine').health, { ok: true }, '合法探针不受影响')
  } finally {
    env.cleanup()
  }
})
