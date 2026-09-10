/**
 * 插件配置链路集成测试（架构 §5.7）：校验 → 原子落盘 → 热更新 → 回滚。
 *
 * 覆盖：
 * 1. 未激活插件：updateConfig 只落盘、不改内存、不加载；
 * 2. 已激活插件：fork.update 热更新（旧 apply 卸载 → 新配置 apply）；
 * 3. 非法配置：invalid_config（带逐条 issues）且磁盘不变；
 * 4. 未声明 schema：按 JSON 原文透传（不校验、不裁剪），已激活同样热更新；
 * 5. apply 抛错：hot_update_failed（409）+ 进程内与磁盘双向回滚；
 * 6. 未知字段按 schema 白名单裁剪；落盘为原子写（无 .tmp 残留）；
 * 7. REST 端点（GET/PUT /api/plugins/:name/config）的状态码与响应形状；
 * 8. layer（持久化层）与 activeLayer（激活层）两个维度；
 * 9. enable 已激活时的幂等与"显式配置不被忽略"；
 * 10. 发现期 issues 经 GET /api/plugins 透出；
 * 11. boot 会话层叠加：基础层 + 会话层并存时，会话层配置作为覆盖层生效
 *     （含"激活态热更新 → 重启后仍是新值"的复现序列回放）；
 * 12. 会话条目未写 config 时不构成有效覆盖：生效值与 layer 口径都指向基础层；
 * 13. 会话层叠加失败（非法配置 / apply 抛错）只记 bootErrors 并回滚为基础层配置，
 *     插件继续以基础层配置运行（boot 不整体失败、不写盘）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import Schema from 'schemastery'
import type { ConfigSchema, HttpRouterService, RouteHandler, RouteHandlerContext } from '@geewiki/core'
import { GeeWikiManager, ManagerError, registerRoutes } from '../src/index.js'
import type { RegisteredPlugin } from '../src/deps.js'

/* ------------------------------ 夹具 ------------------------------ */

interface Env {
  dir: string
  baseFile: string
  sessionFile: string
  cleanup(): void
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gw-cfg-'))
  const baseFile = join(dir, 'plugins.base.json')
  const sessionFile = join(dir, 'plugins.session.json')
  writeFileSync(baseFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
  writeFileSync(sessionFile, `${JSON.stringify({ enabled: [] }, null, 2)}\n`, 'utf8')
  return { dir, baseFile, sessionFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function readList(file: string): { name: string; config?: Record<string, unknown> }[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { enabled: { name: string }[] }).enabled
}

const MESSAGE_SCHEMA: ConfigSchema = Schema.object({
  message: Schema.string().default('默认消息').description('消息内容'),
  count: Schema.number().default(1).description('次数'),
})

/**
 * 可配置插件：apply 记录收到的配置；`rejectWith` 命中时抛错（用于热更新失败路径）。
 * 同时设置 cordis 约定的 module.Config（由 cordis 自动校验 + 填默认值）。
 */
function cfgPlugin(
  name: string,
  log: string[],
  opts: { schema?: ConfigSchema; rejectWith?: string; declaredSchema?: boolean } = {},
): RegisteredPlugin {
  const schema = opts.schema ?? MESSAGE_SCHEMA
  const declared = opts.declaredSchema ?? true
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: {
        runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
        ...(declared ? { configSchema: schema } : {}),
      },
    },
    module: {
      name,
      ...(declared ? { Config: schema } : {}),
      apply: (_ctx: unknown, config?: unknown) => {
        const value = (config ?? {}) as { message?: string }
        if (opts.rejectWith !== undefined && value.message === opts.rejectWith) {
          throw new Error(`拒绝配置: ${opts.rejectWith}`)
        }
        log.push(`apply:${name}:${JSON.stringify(config)}`)
        return () => log.push(`dispose:${name}`)
      },
    },
  }
}

function makeManager(env: Env, registry: RegisteredPlugin[]): GeeWikiManager {
  return new GeeWikiManager(new Context(), {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
  })
}

/** 路由服务替身：记录路由表，可编程式调用处理器并取回状态码/响应体 */
function makeRouter(): {
  service: HttpRouterService
  invoke(
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>
} {
  const routes = new Map<string, RouteHandler>()
  return {
    service: {
      register: (m, p, handler) => {
        routes.set(`${m} ${p}`, handler)
        return () => routes.delete(`${m} ${p}`)
      },
      stats: () => ({ total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastMs: 0, avgMs: 0 }),
      inflight: () => 0,
      pending: () => 0,
      drain: () => Promise.resolve(true),
    },
    invoke: (method, path, params, body) => {
      const handler = routes.get(`${method} ${path}`)
      assert.ok(handler, `应已注册路由 ${method} ${path}`)
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = Readable.from(chunks) as unknown as IncomingMessage
      return new Promise((resolvePromise, rejectPromise) => {
        const h: RouteHandlerContext = {
          req,
          res: { once: () => {} } as unknown as ServerResponse,
          url: new URL(`http://localhost${path}`),
          params,
          json: (status, payload) => resolvePromise({ status, body: payload as Record<string, unknown> }),
        }
        void Promise.resolve(handler(h)).catch(rejectPromise)
      })
    },
  }
}

/* ------------------------------ 用例 ------------------------------ */

test('updateConfig：未激活插件只落盘（不改内存、不加载）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()

    const result = await manager.updateConfig('@t/cfg', { message: 'hi' })
    assert.equal(result.hotUpdated, false, '未激活不应热更新')
    assert.deepEqual(result.config, { message: 'hi', count: 1 }, '默认值应被填入')
    assert.deepEqual(log, [], '未激活不得加载插件')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/cfg')?.state, 'inactive')
    assert.deepEqual(readList(env.baseFile), [{ name: '@t/cfg', config: { message: 'hi', count: 1 } }], '应写入基础层清单')
    assert.deepEqual(readList(env.sessionFile), [], '未涉及会话层')
    assert.equal(existsSync(`${env.baseFile}.tmp`), false, '原子写不应留下 .tmp')
  } finally {
    env.cleanup()
  }
})

test('updateConfig：已激活插件走 fork.update 热更新（dispose 旧 → apply 新配置）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()
    await manager.enable('@t/cfg', { message: 'v1' })
    assert.deepEqual(log, ['apply:@t/cfg:{"message":"v1","count":1}'])

    const result = await manager.updateConfig('@t/cfg', { message: 'v2' })
    assert.equal(result.hotUpdated, true)
    assert.deepEqual(log, [
      'apply:@t/cfg:{"message":"v1","count":1}',
      'dispose:@t/cfg',
      'apply:@t/cfg:{"message":"v2","count":1}',
    ])
    assert.equal(manager.snapshot().find((p) => p.name === '@t/cfg')?.state, 'active', '热更新后仍为 active')
    const sessionEntry = readList(env.sessionFile).find((e) => e.name === '@t/cfg')
    assert.deepEqual(sessionEntry?.config, { message: 'v2', count: 1 }, '会话层插件配置应写回会话清单')
    assert.deepEqual(readList(env.baseFile), [], '会话层插件不得污染基础层')
  } finally {
    env.cleanup()
  }
})

test('updateConfig：非法配置 → invalid_config（逐条 issues）且磁盘不变', async () => {
  const env = makeEnv()
  try {
    const manager = makeManager(env, [cfgPlugin('@t/cfg', [])])
    await manager.boot()
    await manager.updateConfig('@t/cfg', { message: 'ok' })

    await assert.rejects(
      () => manager.updateConfig('@t/cfg', { count: 'not-a-number' }),
      (err: unknown) => {
        assert.ok(err instanceof ManagerError)
        assert.equal(err.code, 'invalid_config')
        const details = err.details as { issues: { message: string; path?: (string | number)[] }[] }
        assert.ok(details.issues.length > 0, '应给出逐条校验问题')
        assert.ok(
          details.issues.some((i) => i.message.includes('count') || (i.path ?? []).includes('count')),
          `问题应指向 count 字段: ${JSON.stringify(details.issues)}`,
        )
        return true
      },
    )
    assert.deepEqual(readList(env.baseFile), [{ name: '@t/cfg', config: { message: 'ok', count: 1 } }], '校验失败不得改盘')
  } finally {
    env.cleanup()
  }
})

test('updateConfig：未声明 schema → 按 JSON 原文透传（不校验、不裁剪），已激活同样热更新', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/noschema', log, { declaredSchema: false })])
    await manager.boot()

    // 未激活：任意字段原样落盘（无校验、无白名单裁剪），并标记 requiresRestart
    const rest = await manager.updateConfig('@t/noschema', { any: 1, nested: { deep: true }, list: [1, 2] })
    assert.equal(rest.hotUpdated, false)
    assert.equal(rest.requiresRestart, true, '未激活 → 配置只在重启/重新启用后生效')
    assert.deepEqual(rest.config, { any: 1, nested: { deep: true }, list: [1, 2] }, '字段原样透传，不做裁剪')
    assert.deepEqual(readList(env.baseFile), [
      { name: '@t/noschema', config: { any: 1, nested: { deep: true }, list: [1, 2] } },
    ])
    assert.equal(manager.configOf('@t/noschema').schema, null, '无 schema 时下发 null（前端退回 JSON 原文编辑框）')

    // 已激活：走 fork.update，apply 收到的就是原始 JSON（enable 用已落盘配置激活）
    await manager.enable('@t/noschema')
    const hot = await manager.updateConfig('@t/noschema', { any: 2 })
    assert.equal(hot.hotUpdated, true)
    assert.equal(hot.requiresRestart, false)
    assert.deepEqual(log, [
      'apply:@t/noschema:{"any":1,"nested":{"deep":true},"list":[1,2]}',
      'dispose:@t/noschema',
      'apply:@t/noschema:{"any":2}',
    ])
  } finally {
    env.cleanup()
  }
})

test('updateConfig：未声明 schema 时配置形状必须是 JSON 对象（数组/标量 → invalid_config 且不改盘）', async () => {
  const env = makeEnv()
  try {
    const manager = makeManager(env, [cfgPlugin('@t/noschema', [], { declaredSchema: false })])
    await manager.boot()
    for (const bad of [[1, 2], 'text', 42, null]) {
      await assert.rejects(
        () => manager.updateConfig('@t/noschema', bad),
        (err: unknown) => err instanceof ManagerError && err.code === 'invalid_config',
        `非对象配置应被拒绝: ${JSON.stringify(bad)}`,
      )
    }
    assert.deepEqual(readList(env.baseFile), [], '非法形状不得写盘')
  } finally {
    env.cleanup()
  }
})

test('updateConfig：apply 抛错 → hot_update_failed 且进程内与磁盘双向回滚', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log, { rejectWith: 'POISON' })])
    await manager.boot()
    await manager.enable('@t/cfg', { message: 'good' })

    await assert.rejects(
      () => manager.updateConfig('@t/cfg', { message: 'POISON' }),
      (err: unknown) => {
        assert.ok(err instanceof ManagerError)
        assert.equal(err.code, 'hot_update_failed')
        const details = err.details as { config: Record<string, unknown>; rolledBack: boolean }
        assert.deepEqual(details.config, { message: 'good', count: 1 }, '响应应带回滚后的配置')
        assert.equal(details.rolledBack, true, '回滚应成功')
        return true
      },
    )

    // 进程内回滚：最后一次 apply 用的是旧配置，且插件仍为 active
    assert.equal(log.at(-1), 'apply:@t/cfg:{"message":"good","count":1}', `回滚后应重新以旧配置激活: ${JSON.stringify(log)}`)
    assert.equal(manager.snapshot().find((p) => p.name === '@t/cfg')?.state, 'active')
    // 磁盘回滚：会话清单仍为旧配置
    assert.deepEqual(
      readList(env.sessionFile).find((e) => e.name === '@t/cfg')?.config,
      { message: 'good', count: 1 },
      '磁盘配置应回滚',
    )
    assert.equal(manager.configOf('@t/cfg').config['message'], 'good')
    // 回滚后仍可正常热更新
    const ok = await manager.updateConfig('@t/cfg', { message: 'fine' })
    assert.equal(ok.hotUpdated, true)
  } finally {
    env.cleanup()
  }
})

test('updateConfig：未知字段按 schema 白名单裁剪；configOf 下发的载荷已剥离 callback', async () => {
  const env = makeEnv()
  try {
    const schema: ConfigSchema = Schema.object({
      message: Schema.string().default('m'),
      // transform 节点在序列化载荷中会带 callback 源码字符串（下发前必须剥离）
      derived: Schema.transform(Schema.string(), (v: string) => v.toUpperCase()),
    })
    const manager = makeManager(env, [cfgPlugin('@t/cfg', [], { schema })])
    await manager.boot()

    const result = await manager.updateConfig('@t/cfg', { message: 'm', bogus: 'DROP', derived: 'x' })
    assert.equal('bogus' in result.config, false, '未声明字段应被裁剪')

    const payload = manager.configOf('@t/cfg').schema
    assert.ok(payload, '应下发 schema 载荷')
    assert.equal(typeof payload.uid, 'number')
    assert.ok(Object.keys(payload.refs).length > 0, 'refs 应包含节点')
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes('callback'), false, '载荷不得包含 callback（防前端反序列化执行任意 JS）')
    assert.equal(serialized.includes('"preserve"'), false, '载荷不得包含 preserve')
    assert.equal(serialized.includes('"constructor"'), false, '载荷不得包含 constructor')
  } finally {
    env.cleanup()
  }
})

test('REST：GET/PUT /api/plugins/:name/config 的状态码与响应形状', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log, { rejectWith: 'POISON' }), cfgPlugin('@t/noschema', [], { declaredSchema: false })])
    await manager.boot()
    const router = makeRouter()
    registerRoutes(router.service, manager)

    // GET：未激活时 schema 与默认配置齐备；layer = 持久化层（未落盘则为下次保存的默认落点 base），
    // activeLayer = 激活层（未激活 → null）
    const got = await router.invoke('GET', '/api/plugins/:name/config', { name: '@t/cfg' })
    assert.equal(got.status, 200)
    assert.equal(got.body['ok'], true)
    assert.equal(got.body['layer'], 'base', '未激活但配置将/已落在基础层')
    assert.equal(got.body['activeLayer'], null, '未激活 → 无激活层')
    const schema = got.body['schema'] as { uid: number; refs: Record<string, unknown> }
    assert.ok(schema && typeof schema.uid === 'number' && Object.keys(schema.refs).length > 0)
    assert.deepEqual(got.body['config'], { message: '默认消息', count: 1 }, '未激活也按 schema 填默认值')

    // PUT：合法 → 200 且 hotUpdated=false（未激活）+ requiresRestart=true
    const put1 = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/cfg' }, { config: { message: 'rest' } })
    assert.equal(put1.status, 200)
    assert.equal(put1.body['hotUpdated'], false)
    assert.equal(put1.body['requiresRestart'], true)

    // 启用后 PUT → 200 且 hotUpdated=true / requiresRestart=false
    await manager.enable('@t/cfg', { message: 'rest' })
    const put2 = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/cfg' }, { config: { message: 'rest2' } })
    assert.equal(put2.status, 200)
    assert.equal(put2.body['hotUpdated'], true)
    assert.equal(put2.body['requiresRestart'], false)

    // PUT：非法值 → 400 invalid_config + issues
    const put3 = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/cfg' }, { config: { count: 'x' } })
    assert.equal(put3.status, 400)
    assert.equal(put3.body['error'], 'invalid_config')
    assert.ok(Array.isArray((put3.body['details'] as { issues: unknown[] }).issues))

    // PUT：apply 抛错 → 409 hot_update_failed
    const put4 = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/cfg' }, { config: { message: 'POISON' } })
    assert.equal(put4.status, 409)
    assert.equal(put4.body['error'], 'hot_update_failed')

    // PUT：无 schema → 200（JSON 原文通道），不再是 config_not_supported
    const put5 = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/noschema' }, { config: { anything: true } })
    assert.equal(put5.status, 200)
    assert.equal(put5.body['hotUpdated'], false)
    assert.equal(put5.body['requiresRestart'], true)
    assert.deepEqual(put5.body['config'], { anything: true })

    // PUT：无 schema 但形状不是对象 → 400 invalid_config
    const put5b = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/noschema' }, { config: [1] })
    assert.equal(put5b.status, 400)
    assert.equal(put5b.body['error'], 'invalid_config')

    // PUT：缺少 config 字段 → 400 bad_request
    const put6 = await router.invoke('PUT', '/api/plugins/:name/config', { name: '@t/cfg' }, {})
    assert.equal(put6.status, 400)
    assert.equal(put6.body['error'], 'bad_request')

    // GET：未知插件 → 404
    const notFound = await router.invoke('GET', '/api/plugins/:name/config', { name: '@t/missing' })
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body['error'], 'not_found')
  } finally {
    env.cleanup()
  }
})

test('enable：未显式传配置时回退到已持久化的配置', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()
    await manager.updateConfig('@t/cfg', { message: 'persisted' })
    await manager.enable('@t/cfg')
    assert.deepEqual(log, ['apply:@t/cfg:{"message":"persisted","count":1}'], '启用应使用落盘配置')
  } finally {
    env.cleanup()
  }
})

test('enable：已激活时无配置 → 幂等不重启；显式传非空配置 → 不得静默忽略（走热更新）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()
    await manager.enable('@t/cfg', { message: 'v1' })
    await manager.enable('@t/cfg')
    assert.deepEqual(log, ['apply:@t/cfg:{"message":"v1","count":1}'], '已激活 + 无配置 → 幂等，不得重启')

    await manager.enable('@t/cfg', { message: 'v2' })
    assert.deepEqual(
      log,
      ['apply:@t/cfg:{"message":"v1","count":1}', 'dispose:@t/cfg', 'apply:@t/cfg:{"message":"v2","count":1}'],
      '已激活 + 显式配置 → 必须生效（旧实现在幂等早退处丢弃了它）',
    )
    assert.deepEqual(
      readList(env.sessionFile).find((e) => e.name === '@t/cfg')?.config,
      { message: 'v2', count: 1 },
      '会话层清单应记录新配置',
    )
  } finally {
    env.cleanup()
  }
})

test('configOf：layer = 持久化层、activeLayer = 激活层（基础层激活 / 会话层激活 / 未激活三态）', async () => {
  const env = makeEnv()
  try {
    // 基础层清单里直接放一个插件（冷激活，无配置）→ boot 后 activeLayer = base
    writeFileSync(
      env.baseFile,
      `${JSON.stringify({ enabled: [{ name: '@t/base' }] }, null, 2)}\n`,
      'utf8',
    )
    const manager = makeManager(env, [cfgPlugin('@t/base', []), cfgPlugin('@t/sess', [])])
    await manager.boot()

    // 未落盘 + 未激活：持久化层报下次保存的默认落点（base），激活层为 null，配置按 schema 填默认值
    const fresh = manager.configOf('@t/sess')
    assert.equal(fresh.layer, 'base')
    assert.equal(fresh.activeLayer, null)
    assert.deepEqual(fresh.config, { message: '默认消息', count: 1 }, '未激活也按 schema 回填默认值')

    // 基础层激活：两层都是 base
    const base = manager.configOf('@t/base')
    assert.equal(base.layer, 'base')
    assert.equal(base.activeLayer, 'base')

    // 会话层激活：两层都是 session（配置也落在会话层）
    await manager.updateConfig('@t/sess', { message: 'p' })
    await manager.enable('@t/sess')
    const sess = manager.configOf('@t/sess')
    assert.equal(sess.layer, 'session')
    assert.equal(sess.activeLayer, 'session')
    assert.deepEqual(
      readList(env.sessionFile).find((e) => e.name === '@t/sess')?.config,
      { message: 'p', count: 1 },
    )

    // 列表接口的 layer 语义不变（仍是激活层）
    assert.equal(manager.snapshot().find((p) => p.name === '@t/sess')?.layer, 'session')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/cfg-missing')?.layer, undefined)
  } finally {
    env.cleanup()
  }
})

test('回滚：失败的 PUT 只回写命中的清单层，不得重写另一层文件（字节不变）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    // 基础层激活 + 配置只在基础层
    writeFileSync(
      env.baseFile,
      `${JSON.stringify({ enabled: [{ name: '@t/base', config: { message: 'good', count: 1 } }] }, null, 2)}\n`,
      'utf8',
    )
    const manager = makeManager(env, [cfgPlugin('@t/base', log, { rejectWith: 'POISON' })])
    await manager.boot()
    const sessionBefore = readFileSync(env.sessionFile, 'utf8')

    await assert.rejects(
      () => manager.updateConfig('@t/base', { message: 'POISON' }),
      (err: unknown) => err instanceof ManagerError && err.code === 'hot_update_failed',
    )

    assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '会话层清单必须字节不变（本次失败与它无关）')
    assert.deepEqual(
      readList(env.baseFile),
      [{ name: '@t/base', config: { message: 'good', count: 1 } }],
      '基础层配置应回滚为旧值',
    )
    assert.equal(manager.configOf('@t/base').config['message'], 'good', '进程内配置同步回滚')
    assert.equal(existsSync(`${env.baseFile}.tmp`), false, '原子写不得留下固定名 .tmp')
  } finally {
    env.cleanup()
  }
})

test('sanitizeSchemaPayload：transform 节点降级为透传 inner，载荷可被 new Schema(payload) 构造', async () => {
  const env = makeEnv()
  try {
    const schema: ConfigSchema = Schema.object({
      message: Schema.string().default('m'),
      derived: Schema.transform(Schema.string(), (v: string) => v.toUpperCase()),
    })
    const manager = makeManager(env, [cfgPlugin('@t/cfg', [], { schema })])
    await manager.boot()

    const payload = manager.configOf('@t/cfg').schema
    assert.ok(payload, '应下发 schema 载荷')
    const types = Object.values(payload.refs ?? {}).map((n) => n.type)
    assert.equal(types.includes('transform'), false, 'transform 必须降级为透传 inner（否则载荷不自洽）')
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes('callback'), false, '载荷不得包含 callback（防前端反序列化执行任意 JS）')

    // 自洽性：服务端自己能把载荷重新构造为 Schema 实例（前端仍不做反序列化，见安全红线）
    const rehydrated = Schema(payload as unknown as Parameters<typeof Schema>[0]) as unknown as (
      v: unknown,
    ) => { derived?: unknown; message?: unknown }
    const resolved = rehydrated({ message: 'x', derived: 'ABC' })
    assert.equal(resolved.message, 'x')
    assert.equal(resolved.derived, 'ABC', '降级后 derived 是普通字符串（不再被 transform 成大写）')
  } finally {
    env.cleanup()
  }
})

test('writeList：临时文件名唯一（预先存在的同名 .tmp 不会让写入失败）且不留残留', async () => {
  const env = makeEnv()
  try {
    const manager = makeManager(env, [cfgPlugin('@t/cfg', [])])
    await manager.boot()
    // 旧实现固定用 `${file}.tmp`：它若已存在（别的实例/上次异常退出留下的目录），写入直接 EISDIR 失败
    mkdirSync(`${env.baseFile}.tmp`, { recursive: true })

    const result = await manager.updateConfig('@t/cfg', { message: 'ok' })
    assert.deepEqual(result.config, { message: 'ok', count: 1 })
    assert.deepEqual(readList(env.baseFile), [{ name: '@t/cfg', config: { message: 'ok', count: 1 } }])
    const leftovers = readFileSync(env.baseFile, 'utf8')
    assert.ok(leftovers.includes('@t/cfg'), '清单应完整落盘')
  } finally {
    env.cleanup()
  }
})

test('REST：GET /api/plugins 透出发现期 issues（buildRegistry 的产物不再被丢弃）', async () => {
  const env = makeEnv()
  try {
    const manager = new GeeWikiManager(new Context(), {
      registry: [cfgPlugin('@t/cfg', [])],
      baseFile: env.baseFile,
      sessionFile: env.sessionFile,
      discoveryIssues: [
        { code: 'invalid_plugin_dir', dir: '/plugins/broken-link', message: '符号链接目标不是目录，已跳过' },
      ],
    })
    await manager.boot()
    const router = makeRouter()
    registerRoutes(router.service, manager)

    const res = await router.invoke('GET', '/api/plugins', {})
    assert.equal(res.status, 200)
    const issues = res.body['issues'] as { code: string; dir: string; message: string }[]
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.code, 'invalid_plugin_dir')
    assert.equal(issues[0]?.dir, '/plugins/broken-link')
    assert.ok(Array.isArray(res.body['plugins']), 'plugins 字段形状不变')

    // 未配置发现问题时是空数组（形状稳定，前端无需判空）
    const plain = makeManager(env, [cfgPlugin('@t/cfg', [])])
    await plain.boot()
    const router2 = makeRouter()
    registerRoutes(router2.service, plain)
    const res2 = await router2.invoke('GET', '/api/plugins', {})
    assert.deepEqual(res2.body['issues'], [])
  } finally {
    env.cleanup()
  }
})

/* ------------------- boot 会话层叠加（基础层 + 会话层并存） ------------------- */

/** 写两份清单：同名插件在基础层与会话层各一条（会话层是覆盖层，不是第二份激活意图） */
function writeBothLayers(
  env: Env,
  baseConfig: Record<string, unknown> | undefined,
  sessionConfig: Record<string, unknown> | undefined,
): void {
  const entry = (config: Record<string, unknown> | undefined): { name: string; config?: Record<string, unknown> } =>
    config === undefined ? { name: '@t/cfg' } : { name: '@t/cfg', config }
  writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [entry(baseConfig)] }, null, 2)}\n`, 'utf8')
  writeFileSync(env.sessionFile, `${JSON.stringify({ enabled: [entry(sessionConfig)] }, null, 2)}\n`, 'utf8')
}

test('boot 叠加：基础层 + 会话层并存时，会话层配置作为覆盖层生效（不重跑激活、激活层仍为基础层）', async () => {
  const env = makeEnv()
  try {
    writeBothLayers(env, { message: 'base-v', count: 1 }, { message: 'session-v', count: 2 })
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()

    assert.deepEqual(
      log,
      [
        'apply:@t/cfg:{"message":"base-v","count":1}',
        'dispose:@t/cfg',
        'apply:@t/cfg:{"message":"session-v","count":2}',
      ],
      '先按基础层装配，再把会话层配置热更新叠加进去',
    )
    const got = manager.configOf('@t/cfg')
    assert.deepEqual(got.config, { message: 'session-v', count: 2 }, '生效值必须是会话层的')
    assert.equal(got.layer, 'session', 'layer 必须报实际生效的那一层')
    assert.equal(got.activeLayer, 'base', '激活层仍为基础层（base 提升不降级）')
    assert.equal(
      manager.snapshot().find((p) => p.name === '@t/cfg')?.layer,
      'base',
      '列表接口的 layer（激活层）语义不变',
    )
    assert.deepEqual(manager.sessionState().bootErrors, [], '叠加成功不应产生 bootError')
  } finally {
    env.cleanup()
  }
})

test('boot 叠加：激活态热更新后的会话层配置在重启后仍然生效（复现序列回放）', async () => {
  const env = makeEnv()
  try {
    // 1. 未激活时保存配置 → 落基础层
    const first = makeManager(env, [cfgPlugin('@t/cfg', [])])
    await first.boot()
    await first.updateConfig('@t/cfg', { message: 'v1' })
    // 2. 启用 → 同一插件在两层各有一条（基础层 v1 + 会话层 v1）
    await first.enable('@t/cfg')
    // 3. 激活态热更新新值 → 会话层更新为 v2，基础层仍是 v1
    const hot = await first.updateConfig('@t/cfg', { message: 'v2' })
    assert.equal(hot.hotUpdated, true)
    assert.deepEqual(
      readList(env.baseFile).find((e) => e.name === '@t/cfg')?.config,
      { message: 'v1', count: 1 },
      '基础层保持旧值',
    )
    assert.deepEqual(
      readList(env.sessionFile).find((e) => e.name === '@t/cfg')?.config,
      { message: 'v2', count: 1 },
      '会话层写入新值',
    )

    // 4. 重启进程（同一对清单文件）→ 生效的必须是会话层新值，而不是基础层旧值
    const log2: string[] = []
    const second = makeManager(env, [cfgPlugin('@t/cfg', log2)])
    await second.boot()
    assert.equal(
      log2[log2.length - 1],
      'apply:@t/cfg:{"message":"v2","count":1}',
      '重启后插件拿到（并重新 apply）的必须是会话层的新值',
    )
    assert.deepEqual(second.configOf('@t/cfg').config, { message: 'v2', count: 1 })
    assert.equal(second.configOf('@t/cfg').layer, 'session', 'layer 与生效层一致')
    assert.equal(second.snapshot().find((p) => p.name === '@t/cfg')?.state, 'active')
  } finally {
    env.cleanup()
  }
})

test('boot 叠加：会话条目未写 config 时不构成有效覆盖（生效值与 layer 都指向基础层）', async () => {
  const env = makeEnv()
  try {
    writeBothLayers(env, { message: 'base-only', count: 3 }, undefined)
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()

    assert.deepEqual(log, ['apply:@t/cfg:{"message":"base-only","count":3}'], '无 config 的会话条目不触发叠加')
    const got = manager.configOf('@t/cfg')
    assert.deepEqual(got.config, { message: 'base-only', count: 3 }, '生效值来自基础层')
    assert.equal(got.layer, 'base', '会话条目没有值可覆盖时 layer 必须报 base（自洽）')
    assert.equal(got.activeLayer, 'base', '激活层来自基础层')
  } finally {
    env.cleanup()
  }
})

test('boot 叠加：会话层覆盖值与基础层生效值相同时不重启插件（避免每次启动空转）', async () => {
  const env = makeEnv()
  try {
    writeBothLayers(env, { message: 'same', count: 1 }, { message: 'same', count: 1 })
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()

    assert.deepEqual(log, ['apply:@t/cfg:{"message":"same","count":1}'], '覆盖值无变化 → 不得多一次 dispose/apply')
    assert.equal(manager.configOf('@t/cfg').layer, 'session', '会话条目仍是生效值的来源层')
    assert.deepEqual(manager.sessionState().bootErrors, [])
  } finally {
    env.cleanup()
  }
})

test('boot 叠加失败：非法配置 / apply 抛错 → 只记 bootErrors 并回滚为基础层配置，插件仍在跑且不写盘', async () => {
  const env = makeEnv()
  try {
    // 非法配置（会话层条目被手工改坏）：count 不是 number
    writeBothLayers(env, { message: 'base-ok', count: 1 }, { message: 'bad', count: 'oops' })
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log)])
    await manager.boot()

    assert.deepEqual(log, ['apply:@t/cfg:{"message":"base-ok","count":1}'], '非法配置不得被 apply')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/cfg')?.state, 'active', '插件仍以基础层配置运行')
    assert.deepEqual(manager.configOf('@t/cfg').config, { message: 'base-ok', count: 1 })
    // layer 报的是"实际生效的配置来自哪一层"：叠加失败后进程内跑的就是基础层配置，
    // 若仍按"条目写在会话层"报 session，运维/前端会误判"会话层配置已生效"。
    const got = manager.configOf('@t/cfg')
    assert.equal(got.layer, 'base', `叠加失败后 layer 必须回落 base: ${JSON.stringify(got)}`)
    assert.equal(got.activeLayer, 'base', '激活层仍是基础层')
    const errors = manager.sessionState().bootErrors
    assert.equal(errors.length, 1, `应记录一条叠加失败: ${JSON.stringify(errors)}`)
    assert.match(errors[0] ?? '', /叠加失败/)
  } finally {
    env.cleanup()
  }
})

test('boot 叠加失败：apply 抛错 → 进程内回滚为基础层配置（插件不以失败态留在内存）', async () => {
  const env = makeEnv()
  try {
    writeBothLayers(env, { message: 'base-ok', count: 1 }, { message: 'POISON', count: 1 })
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/cfg', log, { rejectWith: 'POISON' })])
    await manager.boot()

    assert.equal(
      log.filter((l) => l.startsWith('apply:')).length,
      2,
      `回滚必须让插件以基础层配置重新 apply（旧实例已被 dispose，不能留在失败态）: ${JSON.stringify(log)}`,
    )
    assert.equal(log[log.length - 1], 'apply:@t/cfg:{"message":"base-ok","count":1}')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/cfg')?.state, 'active')
    assert.deepEqual(manager.configOf('@t/cfg').config, { message: 'base-ok', count: 1 })
    const errors = manager.sessionState().bootErrors
    assert.equal(errors.length, 1, `应记录一条叠加失败: ${JSON.stringify(errors)}`)
    assert.match(errors[0] ?? '', /叠加失败/)
    // 叠加路径不落盘：两层清单字节保持不变（盘上已是用户意图）
    assert.deepEqual(readList(env.baseFile), [{ name: '@t/cfg', config: { message: 'base-ok', count: 1 } }])
    assert.deepEqual(readList(env.sessionFile), [{ name: '@t/cfg', config: { message: 'POISON', count: 1 } }])
  } finally {
    env.cleanup()
  }
})
