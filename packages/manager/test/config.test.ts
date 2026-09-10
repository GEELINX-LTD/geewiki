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
  opts: {
    schema?: ConfigSchema
    rejectWith?: string
    declaredSchema?: boolean
    /** 冲突组（同组互斥，供 replace 用例） */
    conflictGroup?: string
    /** 提供的服务标识 */
    provides?: string
    /** 依赖列表（按插件名或服务标识解析） */
    requires?: string[]
    /** apply 恒抛错：用于"目标激活失败 → 整体回滚"路径 */
    failActivate?: boolean
    /** 客户端 UI 入口声明（geewiki.client），供入口表用例 */
    client?: { entry?: string; css?: string }
  } = {},
): RegisteredPlugin {
  const schema = opts.schema ?? MESSAGE_SCHEMA
  const declared = opts.declaredSchema ?? true
  return {
    name,
    manifest: {
      name,
      version: '1.0.0',
      geewiki: {
        provides: opts.provides,
        requires: opts.requires ?? [],
        conflictGroup: opts.conflictGroup,
        runtime: { supportsHotReload: true, requiresCachePurge: false, drainTimeout: 0 },
        ...(opts.client === undefined ? {} : { client: opts.client }),
        ...(declared ? { configSchema: schema } : {}),
      },
    },
    module: {
      name,
      ...(declared ? { Config: schema } : {}),
      apply: (_ctx: unknown, config?: unknown) => {
        const value = (config ?? {}) as { message?: string }
        if (opts.failActivate === true) throw new Error(`激活失败: ${name}`)
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

/** 带 webDist（入口表第二候选根）的管理器 */
function makeManagerWithUi(env: Env, registry: RegisteredPlugin[], webDist: string | null): GeeWikiManager {
  return new GeeWikiManager(new Context(), {
    registry,
    baseFile: env.baseFile,
    sessionFile: env.sessionFile,
    webDist,
  })
}

/** UI 产物夹具：真实临时 webDist，内含 @t/with-ui 的 client.js / client.css（不含 @t/no-asset） */
function makeUiEnv(): { webDist: string; cleanup: () => void } {
  const webDist = mkdtempSync(join(tmpdir(), 'gw-ui-web-'))
  const dir = join(webDist, 'plugins-ui', '@t/with-ui')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'client.js'), 'export function register() {}\n', 'utf8')
  writeFileSync(join(dir, 'client.css'), '.gw-fixture { color: red; }\n', 'utf8')
  return { webDist, cleanup: () => rmSync(webDist, { recursive: true, force: true }) }
}

/** 在替身路由上挂载管理器路由并请求入口表 */
async function invokeUi(
  manager: GeeWikiManager,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const { service, invoke } = makeRouter()
  registerRoutes(service, manager)
  return invoke('GET', '/api/plugins/ui', {}, undefined, headers)
}

/** 路由服务替身：记录路由表，可编程式调用处理器并取回状态码/响应体/响应头 */
function makeRouter(): {
  service: HttpRouterService
  invoke(
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }>
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
    invoke: (method, path, params, body, headers) => {
      const handler = routes.get(`${method} ${path}`)
      assert.ok(handler, `应已注册路由 ${method} ${path}`)
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = Readable.from(chunks) as unknown as IncomingMessage
      // 补齐 headers：enable / replace 路由按 content-length 决定是否读取请求体；
      // ui 路由读 if-none-match；调用方可通过 headers 参数注入请求头。
      ;(req as unknown as { headers: Record<string, string> }).headers = {
        ...(body === undefined ? {} : { 'content-length': String(chunks[0]?.length ?? 0) }),
        ...(headers ?? {}),
      }
      // 响应头替身：新路由会 setHeader（cache-control / etag），故必须有这两个方法
      const responseHeaders: Record<string, string> = {}
      const res = {
        once: () => {},
        headersSent: false,
        setHeader: (name: string, value: unknown) => {
          responseHeaders[name.toLowerCase()] = String(value)
        },
        getHeader: (name: string) => responseHeaders[name.toLowerCase()],
      } as unknown as ServerResponse
      return new Promise((resolvePromise, rejectPromise) => {
        const h: RouteHandlerContext = {
          req,
          res,
          url: new URL(`http://localhost${path}`),
          params,
          json: (status, payload) =>
            resolvePromise({ status, body: payload as Record<string, unknown>, headers: responseHeaders }),
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

/* ------------------------- 冲突组替换（replace） ------------------------- */

test('replace：同冲突组替换成功——旧插件卸载、目标激活、依赖方接回新提供者', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      // 依赖方按**服务标识**依赖旧插件（provides token，本仓库推荐用法）：替换后必须接回新提供者，
      // 且不得把旧插件当依赖拉回来。按**插件名**依赖被顶替者的边无法由新插件承接，会被
      // provider_mismatch 拒绝（见 S1 用例）。
      cfgPlugin('@t/app', log, { requires: ['db-provider'] }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()

    await manager.enable('@t/old-db', { message: 'old' })
    await manager.enable('@t/app')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/app')?.state, 'active')

    // S1(c) 正路径：依赖方按服务标识 require，旧插件与目标 provides 同一 token → 放行
    const result = await manager.replace('@t/new-db', { message: 'new' })
    assert.equal(result.replaced?.name, '@t/old-db', '应报告被顶替的插件')
    assert.deepEqual(result.replaced?.config, { message: 'old', count: 1 }, '应回报旧插件原配置')
    assert.deepEqual(result.restarted, ['@t/app'], '依赖方应被接回并出现在 restarted')
    assert.equal(result.plugin.state, 'active')

    const states = new Map(manager.snapshot().map((p) => [p.name, p.state]))
    assert.equal(states.get('@t/new-db'), 'active', '目标应激活')
    assert.equal(states.get('@t/old-db'), 'inactive', '旧插件应卸载')
    assert.equal(states.get('@t/app'), 'active', '依赖方应重新激活')
    assert.deepEqual(
      readList(env.sessionFile).map((e) => e.name).sort(),
      ['@t/app', '@t/new-db'],
      '会话清单应只剩目标与依赖方（旧插件条目必须移除）',
    )
    assert.deepEqual(readList(env.baseFile), [], '基础层不应被替换操作污染')
  } finally {
    env.cleanup()
  }
})

test('replace：无同组冲突时降级为普通会话层启用', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const manager = makeManager(env, [cfgPlugin('@t/solo', log, { conflictGroup: 'solo-group' })])
    await manager.boot()

    const result = await manager.replace('@t/solo', { message: 'hi' })
    assert.equal(result.replaced, null, '无冲突不应报告被顶替者')
    assert.deepEqual(result.restarted, [])
    assert.equal(result.plugin.state, 'active')
    assert.deepEqual(readList(env.sessionFile), [{ name: '@t/solo', config: { message: 'hi', count: 1 } }])
  } finally {
    env.cleanup()
  }
})

test('replace：目标已激活时幂等（不顶替、返回当前快照）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()

    await manager.enable('@t/new-db', { message: 'first' })
    const result = await manager.replace('@t/new-db', { message: 'second' })
    assert.equal(result.replaced, null, '目标已激活：无可顶替对象')
    assert.deepEqual(result.restarted, [])
    assert.deepEqual(result.plugin.config, { message: 'second', count: 1 }, '显式配置不得被静默丢弃')
    // 旧插件从未激活过；目标仍在会话层
    assert.deepEqual(readList(env.sessionFile).map((e) => e.name), ['@t/new-db'])
  } finally {
    env.cleanup()
  }
})

test('replace：旧插件位于基础层 → base_layer（冷操作，不可热替换）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
    ]
    const manager = makeManager(env, registry)
    // 旧插件写进基础层清单 → boot 时以 base 层激活
    writeFileSync(
      env.baseFile,
      `${JSON.stringify({ enabled: [{ name: '@t/old-db' }] }, null, 2)}\n`,
      'utf8',
    )
    await manager.boot()
    const before = readFileSync(env.sessionFile, 'utf8')

    await assert.rejects(
      () => manager.replace('@t/new-db'),
      (err: unknown) => err instanceof ManagerError && err.code === 'base_layer',
      '基础层插件不得被热替换',
    )
    assert.equal(manager.snapshot().find((p) => p.name === '@t/old-db')?.state, 'active', '旧插件应仍在跑')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/new-db')?.state, 'inactive', '目标不得被激活')
    assert.equal(readFileSync(env.sessionFile, 'utf8'), before, '失败路径不得改动会话清单')
  } finally {
    env.cleanup()
  }
})

test('replace：目标激活失败 → 旧插件与依赖方被恢复，会话清单语义等价复原（顺序由另一条用例负责）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, {
        conflictGroup: 'database-provider',
        provides: 'db-provider',
        failActivate: true,
      }),
      cfgPlugin('@t/app', log, { requires: ['db-provider'] }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()

    await manager.enable('@t/old-db', { message: 'old' })
    await manager.enable('@t/app')
    const parseSessionSnapshot = readList(env.sessionFile)

    await assert.rejects(
      () => manager.replace('@t/new-db', { message: 'new' }),
      (err: unknown) => err instanceof ManagerError,
      '目标激活失败应抛 ManagerError（而非 500 回滚失败）',
    )
    // 回滚后：旧插件与依赖方都回来，目标不在
    const states = new Map(manager.snapshot().map((p) => [p.name, p.state]))
    assert.equal(states.get('@t/old-db'), 'active', '旧插件应被恢复')
    assert.equal(states.get('@t/app'), 'active', '依赖方应被恢复')
    // 失败目标留 error 态（本仓库既有语义：激活失败的插件不以 active 留存，而是记 error），关键是不得 active
    assert.equal(states.get('@t/new-db'), 'error', '失败目标必须已卸载（留 error 态，不得 active）')
    // 本用例只有**一个**依赖方，其恢复序恰好等于启用序，因此"逐字节"在这里是空转的
    // （实测：注释掉 replace() 里的 sessionBackup 还原两行，本用例照样通过）。
    // 故此处只断言**语义等价**（条目集合与各自 config 一致，按名排序后比较），"条目顺序也
    // 逐字节复原"由专门构造了"启用顺序与拓扑序相反"的用例负责钉住。
    const byName = (list: { name: string; config?: Record<string, unknown> }[]) =>
      [...list].sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(
      byName(readList(env.sessionFile)),
      byName(parseSessionSnapshot),
      '回滚后会话清单应与调用前语义等价（条目集合与各条 config 一致；顺序由另一条用例负责）',
    )
    assert.equal(readList(env.sessionFile).length, 2, '不得多出或缺少条目')
  } finally {
    env.cleanup()
  }
})

test('REST：POST /api/plugins/:name/replace 的状态码与响应形状', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/base-db', log, { conflictGroup: 'other-group', provides: 'other-provider' }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()
    const { service, invoke } = makeRouter()
    registerRoutes(service, manager)

    await manager.enable('@t/old-db', { message: 'old' })
    const okRes = await invoke('POST', '/api/plugins/:name/replace', { name: '@t/new-db' }, { config: { message: 'new' } })
    assert.equal(okRes.status, 200, JSON.stringify(okRes.body))
    assert.equal(okRes.body['ok'], true)
    assert.equal((okRes.body['replaced'] as { name: string }).name, '@t/old-db')
    assert.deepEqual(okRes.body['restarted'], [])

    // 目标已激活 → 幂等 200
    const again = await invoke('POST', '/api/plugins/:name/replace', { name: '@t/new-db' }, {})
    assert.equal(again.status, 200)
    assert.equal(again.body['replaced'], null)

    // 未知插件 → 404 not_found
    const missing = await invoke('POST', '/api/plugins/:name/replace', { name: '@t/nope' }, {})
    assert.equal(missing.status, 404)
    assert.equal(missing.body['error'], 'not_found')
  } finally {
    env.cleanup()
  }
})

test('replace：回滚按调用前的条目顺序逐字节复原会话清单（依赖方启用顺序与拓扑序相反时也成立）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, {
        conflictGroup: 'database-provider',
        provides: 'db-provider',
        failActivate: true,
      }),
      // 两个互相独立的依赖方：故意按与拓扑序（按名排序）相反的顺序启用，钉住"顺序也要复原"
      cfgPlugin('@t/zeta', log, { requires: ['db-provider'] }),
      cfgPlugin('@t/alpha', log, { requires: ['db-provider'] }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()

    await manager.enable('@t/old-db', { message: 'old' })
    await manager.enable('@t/zeta')
    await manager.enable('@t/alpha')
    assert.deepEqual(
      readList(env.sessionFile).map((e) => e.name),
      ['@t/old-db', '@t/zeta', '@t/alpha'],
      '前置：会话条目按用户启用顺序排列（zeta 在 alpha 之前，与拓扑序相反）',
    )
    const sessionBefore = readFileSync(env.sessionFile, 'utf8')

    await assert.rejects(
      () => manager.replace('@t/new-db'),
      (err: unknown) =>
        err instanceof ManagerError && err.code === 'load_failed',
      '必须是目标加载失败（load_failed）触发的回滚；若改成 provider_mismatch 等前置校验拒绝，本用例就不再覆盖回滚路径',
    )
    assert.equal(
      readFileSync(env.sessionFile, 'utf8'),
      sessionBefore,
      '回滚后会话清单必须逐字节复原（含条目顺序），不能只保证语义等价',
    )
    const states = new Map(manager.snapshot().map((p) => [p.name, p.state]))
    assert.equal(states.get('@t/old-db'), 'active')
    assert.equal(states.get('@t/zeta'), 'active')
    assert.equal(states.get('@t/alpha'), 'active')
  } finally {
    env.cleanup()
  }
})

test('replace：旧插件同名条目同时在两层（实际以 base 层激活）→ base_layer 拒绝热替换', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
    ]
    const manager = makeManager(env, registry)
    // 叠加态：同名插件同时写在基础层与会话层清单里（本仓库明确支持，见 boot 叠加用例）。
    // boot 时基础层优先 → 该插件实际以 **base 层**激活，会话条目只是一层配置覆盖。
    writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [{ name: '@t/old-db' }] }, null, 2)}\n`, 'utf8')
    writeFileSync(
      env.sessionFile,
      `${JSON.stringify({ enabled: [{ name: '@t/old-db', config: { message: 'session-overlay', count: 1 } }] }, null, 2)}\n`,
      'utf8',
    )
    await manager.boot()

    // 前置：确认这确实是"激活层 = base、但会话层有条目"的叠加态
    assert.equal(
      manager.snapshot().find((p) => p.name === '@t/old-db')?.layer,
      'base',
      '前置：叠加态下旧插件的激活层必须是 base',
    )
    assert.equal(manager.configOf('@t/old-db').layer, 'session', '前置：会话条目构成有效覆盖，故配置层报 session')
    const baseBefore = readFileSync(env.baseFile, 'utf8')
    const sessionBefore = readFileSync(env.sessionFile, 'utf8')

    await assert.rejects(
      () => manager.replace('@t/new-db'),
      (err: unknown) => err instanceof ManagerError && err.code === 'base_layer',
      '实际以基础层激活的插件不得被热替换（否则旧插件仍在基础层清单里，重启后每次启动都撞冲突组互斥）',
    )
    assert.equal(manager.snapshot().find((p) => p.name === '@t/old-db')?.state, 'active', '旧插件应仍在跑')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/new-db')?.state, 'inactive', '目标不得被激活')
    assert.equal(readFileSync(env.baseFile, 'utf8'), baseBefore, '失败路径不得改动基础层清单')
    assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '失败路径不得改动会话清单')
  } finally {
    env.cleanup()
  }
})

test('replace：活跃依赖方位于基础层 → base_layer（不得把基础层插件的持久化层改写成会话层）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      // 依赖方在**基础层**清单里（冷插件），但它依赖旧插件
      cfgPlugin('@t/base-app', log, { requires: ['db-provider'] }),
    ]
    const manager = makeManager(env, registry)
    writeFileSync(env.baseFile, `${JSON.stringify({ enabled: [{ name: '@t/base-app' }] }, null, 2)}\n`, 'utf8')
    await manager.boot()
    // 旧插件在会话层启用（它不在基础层清单里）
    await manager.enable('@t/old-db', { message: 'old' })
    assert.equal(manager.snapshot().find((p) => p.name === '@t/base-app')?.layer, 'base', '前置：依赖方激活层是 base')

    const baseBefore = readFileSync(env.baseFile, 'utf8')
    const sessionBefore = readFileSync(env.sessionFile, 'utf8')

    await assert.rejects(
      () => manager.replace('@t/new-db'),
      (err: unknown) => {
        assert.ok(err instanceof ManagerError, '应为 ManagerError')
        assert.equal(err.code, 'base_layer')
        assert.deepEqual((err.details as { plugins?: string[] })?.plugins, ['@t/base-app'], '应指明集合内的基础层成员')
        return true
      },
      '活跃依赖方位于基础层时不得热替换',
    )
    // 核心：基础层插件的持久化层不得被静默改写成会话层
    assert.equal(readFileSync(env.baseFile, 'utf8'), baseBefore, '基础层清单不得改动')
    assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '会话清单不得改动')
    assert.equal(
      readList(env.sessionFile).some((e) => e.name === '@t/base-app'),
      false,
      '基础层插件不得被写进会话清单（否则其持久化层被改写）',
    )
    assert.equal(manager.snapshot().find((p) => p.name === '@t/base-app')?.layer, 'base', '依赖方仍应属基础层')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/new-db')?.state, 'inactive', '目标不得被激活')
  } finally {
    env.cleanup()
  }
})

test('replace：依赖方按插件名依赖被顶替者 → provider_mismatch 拒绝（不假报成功）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      // 按**具体插件名**依赖旧插件：这条边无法由新插件承接
      cfgPlugin('@t/app', log, { requires: ['@t/old-db'] }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()
    await manager.enable('@t/old-db', { message: 'old' })
    await manager.enable('@t/app')

    const sessionBefore = readFileSync(env.sessionFile, 'utf8')
    await assert.rejects(
      () => manager.replace('@t/new-db'),
      (err: unknown) => {
        assert.ok(err instanceof ManagerError)
        assert.equal(err.code, 'provider_mismatch')
        assert.deepEqual(
          (err.details as { plugin?: string; token?: string })?.plugin,
          '@t/app',
          '应指明违规的依赖方',
        )
        assert.equal((err.details as { token?: string })?.token, '@t/old-db', '应指明无法承接的 token')
        return true
      },
      '按插件名的依赖边无法由目标承接，必须拒绝而非返回 200',
    )
    assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '拒绝路径不得有副作用')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/new-db')?.state, 'inactive', '目标不得被激活')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/app')?.state, 'active', '依赖方应仍在跑')
  } finally {
    env.cleanup()
  }
})

test('replace：目标自身依赖它要顶替的插件 → provider_mismatch（不自洽）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      // 目标 requires 指向旧插件
      cfgPlugin('@t/new-db', log, {
        conflictGroup: 'database-provider',
        provides: 'db-provider',
        requires: ['@t/old-db'],
      }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()
    await manager.enable('@t/old-db', { message: 'old' })
    const sessionBefore = readFileSync(env.sessionFile, 'utf8')

    await assert.rejects(
      () => manager.replace('@t/new-db'),
      (err: unknown) => {
        assert.ok(err instanceof ManagerError)
        assert.equal(err.code, 'provider_mismatch')
        assert.deepEqual(
          (err.details as { tokens?: string[] })?.tokens,
          ['@t/old-db'],
          '应指明目标自依赖的 token',
        )
        return true
      },
      '目标依赖它要顶替掉的插件：替换不自洽，必须拒绝',
    )
    assert.equal(readFileSync(env.sessionFile, 'utf8'), sessionBefore, '拒绝路径不得有副作用')
    assert.equal(manager.snapshot().find((p) => p.name === '@t/new-db')?.state, 'inactive')
  } finally {
    env.cleanup()
  }
})

test('REST：replace 的 409 分支（base_layer / provider_mismatch）', async () => {
  const env = makeEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/old-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/new-db', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/app', log, { requires: ['@t/old-db'] }),
    ]
    const manager = makeManager(env, registry)
    await manager.boot()
    const { service, invoke } = makeRouter()
    registerRoutes(service, manager)
    await manager.enable('@t/old-db', { message: 'old' })
    await manager.enable('@t/app')

    const mismatch = await invoke('POST', '/api/plugins/:name/replace', { name: '@t/new-db' }, {})
    assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body))
    assert.equal(mismatch.body['error'], 'provider_mismatch')

    // 基础层分支：把旧插件下沉到基础层清单（叠加态：会话条目仍在，使其激活层为 base）
    const other = makeManager(env, [
      cfgPlugin('@t/base-old', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
      cfgPlugin('@t/base-new', log, { conflictGroup: 'database-provider', provides: 'db-provider' }),
    ])
    writeFileSync(
      env.baseFile,
      `${JSON.stringify({ enabled: [{ name: '@t/base-old' }] }, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(
      env.sessionFile,
      `${JSON.stringify({ enabled: [{ name: '@t/base-old', config: { message: 'ov', count: 1 } }] }, null, 2)}\n`,
      'utf8',
    )
    await other.boot()
    const { service: service2, invoke: invoke2 } = makeRouter()
    registerRoutes(service2, other)
    const baseLayer = await invoke2('POST', '/api/plugins/:name/replace', { name: '@t/base-new' }, {})
    assert.equal(baseLayer.status, 409, JSON.stringify(baseLayer.body))
    assert.equal(baseLayer.body['error'], 'base_layer')
  } finally {
    env.cleanup()
  }
})

/* ------------------- 插件 UI 入口表（GET /api/plugins/ui） ------------------- */

test('GET /api/plugins/ui：只列 active 且有产物的插件；停用后从表中消失', async () => {
  const env = makeEnv()
  const uiEnv = makeUiEnv()
  try {
    const log: string[] = []
    const registry = [
      cfgPlugin('@t/with-ui', log, { client: { entry: 'client.js', css: 'client.css' } }),
      cfgPlugin('@t/no-ui', log),
    ]
    const manager = makeManagerWithUi(env, registry, uiEnv.webDist)
    await manager.boot()

    // 两个插件默认都不在基础层（makeUiEnv 的产物目录里只有 @t/with-ui）
    const empty = await invokeUi(manager)
    assert.equal(empty.status, 200, '空表也必须 200（永不 404）')
    assert.deepEqual(empty.body['plugins'], {}, '未激活插件不应进表')
    assert.equal(empty.body['version'], 1)
    assert.match(String(empty.body['revision']), /^[0-9a-f]{12}$/)

    await manager.enable('@t/with-ui')
    const one = await invokeUi(manager)
    assert.equal(one.status, 200)
    assert.deepEqual(Object.keys(one.body['plugins'] as object), ['@t/with-ui'])
    const entry = (one.body['plugins'] as Record<string, { entry: string; css?: string; rev: string }>)['@t/with-ui']
    assert.equal(entry?.entry, 'client.js')
    assert.equal(entry?.css, 'client.css')
    assert.match(String(entry?.rev), /^[0-9a-f]{8}$/)
    assert.notEqual(one.body['revision'], empty.body['revision'], '激活后 revision 必须变化')

    // 停用 → 该插件从入口表消失（"停用后 UI 自动消失"的服务端半边）
    await manager.disable('@t/with-ui')
    const afterDisable = await invokeUi(manager)
    assert.deepEqual(afterDisable.body['plugins'], {}, '停用后不得再出现在入口表')
    assert.notEqual(afterDisable.body['revision'], one.body['revision'], '停用后 revision 必须变化')
    assert.ok(
      (afterDisable.body['skipped'] as { name: string; reason: string }[]).some(
        (s) => s.name === '@t/with-ui' && s.reason === 'inactive',
      ),
      `停用后应记 inactive: ${JSON.stringify(afterDisable.body['skipped'])}`,
    )
  } finally {
    env.cleanup()
    uiEnv.cleanup()
  }
})

test('GET /api/plugins/ui：产物缺失记 entry_missing，插件不进表但端点仍 200', async () => {
  const env = makeEnv()
  const uiEnv = makeUiEnv()
  try {
    const log: string[] = []
    const manager = makeManagerWithUi(env, [cfgPlugin('@t/no-asset', log, { client: {} })], uiEnv.webDist)
    await manager.boot()
    await manager.enable('@t/no-asset')

    const res = await invokeUi(manager)
    assert.equal(res.status, 200, '产物缺失不得变成 4xx/5xx')
    assert.deepEqual(res.body['plugins'], {}, '入口缺失的插件不进表')
    assert.deepEqual(res.body['skipped'], [{ name: '@t/no-asset', reason: 'entry_missing' }])
  } finally {
    env.cleanup()
    uiEnv.cleanup()
  }
})

test('GET /api/plugins/ui：ETag/If-None-Match 命中返回 304 且无 body；cache-control 为 no-store', async () => {
  const env = makeEnv()
  const uiEnv = makeUiEnv()
  try {
    const log: string[] = []
    const manager = makeManagerWithUi(env, [cfgPlugin('@t/with-ui', log, { client: {} })], uiEnv.webDist)
    await manager.boot()
    await manager.enable('@t/with-ui')

    const first = await invokeUi(manager)
    const etag = first.headers['etag']
    assert.equal(first.headers['cache-control'], 'no-store', '派生数据绝不能被中间缓存')
    assert.equal(etag, `"${String(first.body['revision'])}"`, 'ETag 必须与 revision 一致')

    // 回传同一 ETag → 304，且不携带响应体
    const cached = await invokeUi(manager, { 'if-none-match': etag as string })
    assert.equal(cached.status, 304)
    assert.equal(cached.body, null, '304 不得带 body')
    // 弱校验前缀与裸值也应命中（简化匹配：剥 W/ 与引号）
    const weak = await invokeUi(manager, { 'if-none-match': `W/${String(etag)}` })
    assert.equal(weak.status, 304)
    const bare = await invokeUi(manager, { 'if-none-match': String(first.body['revision']) })
    assert.equal(bare.status, 304)
    // 不匹配 → 200 正常返回
    const stale = await invokeUi(manager, { 'if-none-match': '"deadbeefcafe"' })
    assert.equal(stale.status, 200)
  } finally {
    env.cleanup()
    uiEnv.cleanup()
  }
})
