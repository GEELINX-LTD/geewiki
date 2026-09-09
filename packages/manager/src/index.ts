/**
 * @geewiki/manager —— GeeWiki 插件管理器（核心大脑）
 *
 * 子系统落地（对应 docs/architecture.md 第 5 章）：
 * - 5.1 热插拔引擎：session 激活仅限 supportsHotReload:true 的插件；依赖链热授权检查
 * - 5.2 依赖图谱：清单驱动装配 + 依赖拓扑排序 + 反向依赖卸载拦截；graph() 供 React Flow
 * - 5.3 会话层沙箱：Base（plugins.base.json）/ Session（plugins.session.json）双层状态；
 *       临时操作仅落 Session；persistSession() 把会话合并进 Base；看门狗熔断时清空会话自愈
 * - 5.4 广义冲突组：conflictGroup 同组互斥，激活时自动检测冲突方
 * - 5.5 迁移控制器：激活前执行 ctx.db.migrate(插件迁移目录)，失败阻止加载（事务已回滚）
 * - 5.6 看门狗：健康探针轮询；Session 插件 5 秒试用期内探针失败即回滚；
 *       连续失败达阈值（默认 3 次）触发熔断：清空 Session 后以退出码 1 退出（容器重启回 Base）
 * - 5.7 配置热更新：REST enable 携带 config，经 JSON Schema（configSchema）由上层校验
 *
 * 本插件由 @geewiki/server 引导加载（内核组件，不入清单），清单中的插件由本管理器
 * 按依赖拓扑依次激活；REST 路由经 @geewiki/http 的路由服务挂载。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from 'cordis'
import { type DatabaseAdapter, type FiberLike, type HttpRouterService, type RouteHandlerContext } from '@geewiki/core'
export type { RegisteredPlugin } from './deps.js'
import {
  checkHotChain,
  collectDependents,
  directDependencies,
  findConflict,
  topologicalOrder,
  type RegisteredPlugin,
} from './deps.js'

/* ============================== 类型定义 ============================== */

export type Layer = 'base' | 'session'

export interface PluginListEntry {
  name: string
  config?: Record<string, unknown>
}

export interface PluginListFile {
  enabled: PluginListEntry[]
}

export interface ManagerConfig {
  /** 已注册插件（实现 + Manifest + 迁移目录） */
  registry: RegisteredPlugin[]
  /** 基础层清单路径（plugins.base.json） */
  baseFile: string
  /** 会话层清单路径（plugins.session.json） */
  sessionFile: string
  /** 看门狗轮询间隔（毫秒，默认 5000） */
  watchdogIntervalMs?: number
  /** 会话插件试用期（毫秒，默认 5000，对应构想 5 秒试用期） */
  gracePeriodMs?: number
  /** 熔断连续失败阈值（默认 3） */
  meltdownThreshold?: number
}

export interface PluginSnapshot {
  name: string
  version: string
  state: 'active' | 'inactive' | 'error'
  layer: Layer | null
  hotReloadable: boolean
  provides?: string
  requires: string[]
  conflictGroup?: string
  migrations?: string
  config?: Record<string, unknown>
  error?: string
}

export interface PluginGraphNode {
  id: string
  label: string
  layer: Layer | null
  state: 'active' | 'inactive' | 'error'
  hotReloadable: boolean
  conflictGroup?: string
}

export interface PluginGraph {
  nodes: PluginGraphNode[]
  edges: { id: string; source: string; target: string }[]
}

/** 管理器错误：带机器可读 code（REST 层映射为 HTTP 状态码） */
export class ManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/* ============================ 清单文件 IO ============================ */

function readList(file: string): PluginListFile {
  if (!existsSync(file)) return { enabled: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as PluginListFile).enabled)) {
      throw new Error('缺少 enabled 数组')
    }
    return parsed as PluginListFile
  } catch (err) {
    throw new ManagerError('invalid_list_file', `插件清单解析失败: ${file}: ${(err as Error).message}`)
  }
}

function writeList(file: string, list: PluginListFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
}

/* ============================= 管理器本体 ============================= */

interface ManagedPlugin {
  entry: RegisteredPlugin
  active: boolean
  layer: Layer | null
  error: string | null
  config: Record<string, unknown> | undefined
  activatedAt: number | null
  /** ctx.plugin() 返回的 cordis fiber 句柄（dispose 动态卸载） */
  fiber: FiberLike | null
}

export class GeeWikiManager {
  readonly ctx: Context
  private readonly config: Required<Omit<ManagerConfig, 'registry'>> & { registry: RegisteredPlugin[] }
  private readonly plugins = new Map<string, ManagedPlugin>()
  /** 激活顺序（dispose 时逆序卸载） */
  private readonly activationOrder: string[] = []
  private base: PluginListFile = { enabled: [] }
  private session: PluginListFile = { enabled: [] }
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private bootErrors: string[] = []

  constructor(ctx: Context, config: ManagerConfig) {
    this.ctx = ctx
    this.config = {
      registry: config.registry,
      baseFile: config.baseFile,
      sessionFile: config.sessionFile,
      watchdogIntervalMs: config.watchdogIntervalMs ?? 5000,
      gracePeriodMs: config.gracePeriodMs ?? 5000,
      meltdownThreshold: config.meltdownThreshold ?? 3,
    }
  }

  /* ------------------------- 查询（供 REST） ------------------------- */

  /** 全部注册插件的运行快照（含未激活） */
  snapshot(): PluginSnapshot[] {
    return this.config.registry
      .map((entry) => this.snapshotOf(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private snapshotOf(name: string): PluginSnapshot {
    const entry = this.config.registry.find((p) => p.name === name)
    if (!entry) throw new ManagerError('not_found', `未知插件: ${name}`)
    const p = this.plugins.get(name)
    const m = entry.manifest
    return {
      name,
      version: m.version,
      state: p?.active ? 'active' : p?.error ? 'error' : 'inactive',
      layer: p?.layer ?? null,
      hotReloadable: m.geewiki.runtime?.supportsHotReload === true,
      provides: m.geewiki.provides,
      requires: directDependencies(this.config.registry, name),
      conflictGroup: m.geewiki.conflictGroup,
      migrations: m.geewiki.migrations,
      config: p?.config,
      error: p?.error ?? undefined,
    }
  }

  /** 依赖图（React Flow DAG 数据源）：节点=全部注册插件，边=requires 解析结果 */
  graph(): PluginGraph {
    const nodes: PluginGraphNode[] = this.config.registry.map((entry) => {
      const p = this.plugins.get(entry.name)
      const m = entry.manifest
      return {
        id: entry.name,
        label: entry.name,
        layer: p?.layer ?? null,
        state: p?.active ? 'active' : p?.error ? 'error' : 'inactive',
        hotReloadable: m.geewiki.runtime?.supportsHotReload === true,
        conflictGroup: m.geewiki.conflictGroup,
      }
    })
    const edges = this.config.registry.flatMap((entry) =>
      directDependencies(this.config.registry, entry.name).map((dep) => ({
        id: `${dep}->${entry.name}`,
        source: dep,
        target: entry.name,
      })),
    )
    return { nodes, edges }
  }

  /** 双层清单内容（含启动时各插件的激活错误） */
  sessionState(): { base: PluginListFile; session: PluginListFile; bootErrors: string[] } {
    return { base: this.base, session: this.session, bootErrors: this.bootErrors }
  }

  /* ------------------------- 装配与激活 ------------------------- */

  /** 启动装配：读取双层清单并按依赖拓扑激活（单个失败不阻断整体，错误可查询） */
  async boot(): Promise<void> {
    try {
      this.base = readList(this.config.baseFile)
    } catch (err) {
      this.bootErrors.push((err as Error).message)
      this.base = { enabled: [] }
    }
    try {
      this.session = readList(this.config.sessionFile)
    } catch (err) {
      this.bootErrors.push((err as Error).message)
      this.session = { enabled: [] }
    }
    const desired = new Map<string, { config: Record<string, unknown>; layer: Layer }>()
    for (const e of this.base.enabled) {
      if (!desired.has(e.name)) desired.set(e.name, { config: e.config ?? {}, layer: 'base' })
    }
    for (const e of this.session.enabled) {
      if (!desired.has(e.name)) desired.set(e.name, { config: e.config ?? {}, layer: 'session' })
    }
    const names = [...desired.keys()]
    let order: string[]
    try {
      order = topologicalOrder(this.config.registry, names)
    } catch (err) {
      this.bootErrors.push((err as Error).message)
      order = names // 环存在时退回清单原序（激活仍会逐个失败并记录）
    }
    for (const name of order) {
      const intent = desired.get(name)
      if (!intent) continue
      try {
        await this.activateCore(name, intent.config, intent.layer)
      } catch (err) {
        const p = this.plugins.get(name)
        if (p) p.error = (err as Error).message
        this.bootErrors.push(`插件 ${name} 激活失败: ${(err as Error).message}`)
      }
    }
  }

  /** 会话层热启用（enable）：校验热授权/依赖链/冲突/迁移后激活并写入 Session 清单 */
  async enable(name: string, config?: Record<string, unknown>): Promise<PluginSnapshot> {
    const entry = this.registryOf(name)
    const m = entry.manifest.geewiki

    if (this.plugins.get(name)?.active) {
      // 幂等：已在活动状态（无论 base 还是 session）视为成功
      return this.snapshotOf(name)
    }
    if (m.runtime?.supportsHotReload !== true) {
      throw new ManagerError(
        'hot_reload_not_supported',
        `${name} 未声明 runtime.supportsHotReload: true，仅支持持久化安装 + 进程重启（冷操作）`,
      )
    }
    const violations = checkHotChain(this.config.registry, this.activeNames(), name)
    if (violations.length > 0) {
      throw new ManagerError(
        'hot_dependency_not_supported',
        `依赖链中存在不支持热加载的未激活依赖: ${violations.join('; ')}`,
        { path: violations },
      )
    }
    // 未激活依赖先递归启用（同样走会话层热路径）
    for (const dep of directDependencies(this.config.registry, name)) {
      if (!this.plugins.get(dep)?.active) await this.enable(dep)
    }
    await this.activateCore(name, config ?? {}, 'session')
    this.addToSession(name, config ?? {})
    return this.snapshotOf(name)
  }

  /** 会话层停用（disable）：仅限 Session 层插件；有活动依赖者时阻止卸载 */
  async disable(name: string): Promise<void> {
    const p = this.plugins.get(name)
    if (!p?.active) throw new ManagerError('not_active', `插件未激活: ${name}`)
    if (p.layer !== 'session') {
      throw new ManagerError(
        'base_layer',
        `${name} 属于基础层（冷操作），请编辑 ${this.config.baseFile} 后重启进程`,
      )
    }
    const dependents = collectDependents(this.config.registry, this.activeNames(), name)
    if (dependents.length > 0) {
      throw new ManagerError('has_dependents', `存在依赖方，禁止卸载: ${dependents.join(', ')}`, { dependents })
    }
    await this.deactivateCore(name)
    this.removeFromSession(name)
  }

  /** 应用并持久化：Session 层全部变更合并进 Base，清空会话（构想 5.3 的"应用并持久化"） */
  persistSession(): { promoted: string[] } {
    const promoted: string[] = []
    for (const entry of this.session.enabled) {
      const existing = this.base.enabled.find((e) => e.name === entry.name)
      if (existing) existing.config = entry.config
      else this.base.enabled.push({ ...entry })
      promoted.push(entry.name)
      const p = this.plugins.get(entry.name)
      if (p) p.layer = 'base'
    }
    this.session = { enabled: [] }
    writeList(this.config.baseFile, this.base)
    writeList(this.config.sessionFile, this.session)
    return { promoted }
  }

  /* ------------------------- 内部实现 ------------------------- */

  private registryOf(name: string): RegisteredPlugin {
    const entry = this.config.registry.find((p) => p.name === name)
    if (!entry) throw new ManagerError('not_found', `未知插件: ${name}（未注册，registry 含: ${this.config.registry.map((p) => p.name).join(', ')}）`)
    return entry
  }

  private activeNames(): Set<string> {
    return new Set([...this.plugins.values()].filter((p) => p.active).map((p) => p.entry.name))
  }

  private addToSession(name: string, config: Record<string, unknown>): void {
    const existing = this.session.enabled.find((e) => e.name === name)
    if (existing) existing.config = config
    else this.session.enabled.push({ name, config })
    writeList(this.config.sessionFile, this.session)
  }

  private removeFromSession(name: string): void {
    this.session.enabled = this.session.enabled.filter((e) => e.name !== name)
    writeList(this.config.sessionFile, this.session)
  }

  /**
   * 激活核心流程（boot/session 共用）：依赖已就绪前提下——
   * 冲突组检查 → 迁移控制器 → cordis 加载。任一失败抛 ManagerError 且不留半激活态。
   */
  private async activateCore(name: string, config: Record<string, unknown>, layer: Layer): Promise<void> {
    const entry = this.registryOf(name)
    let managed = this.plugins.get(name)
    if (!managed) {
      managed = { entry, active: false, layer: null, error: null, config: undefined, activatedAt: null, fiber: null }
      this.plugins.set(name, managed)
    }
    if (managed.active) {
      managed.layer = layer === 'base' ? 'base' : managed.layer // base 提升不降级
      return
    }

    // 5.4 广义冲突组：同组互斥
    const conflictWith = findConflict(this.config.registry, this.activeNames(), name)
    if (conflictWith) {
      managed.error = `冲突组 "${entry.manifest.geewiki.conflictGroup}" 已有激活插件 ${conflictWith}`
      throw new ManagerError(
        'conflict_group',
        `冲突组 "${entry.manifest.geewiki.conflictGroup}" 已有激活插件 ${conflictWith}，同组互斥`,
        { with: conflictWith },
      )
    }

    // 5.5 迁移控制器：插件声明迁移目录且 db 服务可用时，激活前执行（失败=阻止加载，事务已回滚）
    if (entry.migrationsDir) {
      const db = this.ctx.get('db') as DatabaseAdapter | undefined
      if (db) {
        try {
          db.migrate(entry.migrationsDir)
        } catch (err) {
          managed.error = `迁移执行失败: ${(err as Error).message}`
          throw new ManagerError(
            'migration_failed',
            `迁移执行失败（已回滚），阻止加载 ${name}: ${(err as Error).message}`,
          )
        }
      }
    }

    // cordis 动态加载：await 等激活完成（含 async apply）；激活失败经 _error 抛出
    let fiber: FiberLike
    try {
      fiber = await this.ctx.plugin(entry.module, config)
    } catch (err) {
      managed.error = (err as Error).message
      throw new ManagerError('load_failed', `加载失败 ${name}: ${(err as Error).message}`)
    }
    managed.fiber = fiber
    managed.active = true
    managed.layer = layer
    managed.error = null
    managed.config = config
    managed.activatedAt = layer === 'session' ? Date.now() : null
    this.activationOrder.push(name)
  }

  private async deactivateCore(name: string): Promise<void> {
    const managed = this.plugins.get(name)
    if (!managed?.active) return
    if (managed.fiber) {
      try {
        await managed.fiber.dispose()
      } catch (err) {
        console.error(`[manager] 插件 ${name} 卸载出错:`, err)
      }
    }
    managed.fiber = null
    managed.active = false
    managed.layer = null
    managed.activatedAt = null
    this.activationOrder.splice(this.activationOrder.indexOf(name), 1)
  }

  /* ------------------------- 看门狗（5.6） ------------------------- */

  startWatchdog(): void {
    this.stopWatchdog()
    this.watchdogTimer = setInterval(() => {
      try {
        this.watchdogTick()
      } catch (err) {
        console.error('[manager:watchdog] 探针异常:', err)
      }
    }, this.config.watchdogIntervalMs)
    this.watchdogTimer.unref?.()
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private watchdogTick(): void {
    const router = this.ctx.get('http') as HttpRouterService | undefined
    if (!router) return
    const stats = router.stats()
    const now = Date.now()

    // 试用期（Grace Period）：Session 插件激活后 5 秒内探针出现失败 → 回滚该插件
    for (const [name, p] of this.plugins) {
      if (!p.active || p.layer !== 'session' || p.activatedAt === null) continue
      if (now - p.activatedAt > this.config.gracePeriodMs) continue
      if (stats.consecutiveFailures > 0) {
        console.warn(`[manager:watchdog] 试用期内探针失败，回滚会话插件 ${name}`)
        this.disable(name).catch((err) => console.error(`[manager:watchdog] 回滚失败 ${name}:`, err))
      }
    }

    // 熔断：连续失败达阈值且存在会话变更 → 清空会话 + 退出码 1（容器重启自愈回 Base）
    if (stats.consecutiveFailures >= this.config.meltdownThreshold && this.session.enabled.length > 0) {
      console.error(
        `[manager:watchdog] 连续 ${stats.consecutiveFailures} 次健康探针失败，触发熔断：清空会话层并重启`,
      )
      try {
        writeList(this.config.sessionFile, { enabled: [] })
      } catch (err) {
        console.error('[manager:watchdog] 清空会话清单失败:', err)
      }
      process.exit(1)
    }
  }

  /* --------------------------- 卸载 --------------------------- */

  /** 逆序卸载全部活动插件（管理器 dispose 时调用） */
  async disposeAll(): Promise<void> {
    this.stopWatchdog()
    const errors: string[] = []
    for (const name of [...this.activationOrder].reverse()) {
      const managed = this.plugins.get(name)
      if (managed?.active && managed.fiber) {
        try {
          await managed.fiber.dispose()
        } catch (err) {
          errors.push(`${name}: ${(err as Error).message}`)
        }
        managed.active = false
        managed.fiber = null
      }
    }
    if (errors.length > 0) throw new Error(`卸载失败: ${errors.join('; ')}`)
  }
}

/* ============================ cordis 插件 ============================ */

export const PluginManagerPlugin = {
  name: '@geewiki/manager',

  async apply(ctx: Context, config: ManagerConfig) {
    const manager = new GeeWikiManager(ctx, config)

    // 启动装配：读取 Base/Session 双层清单，按依赖拓扑逐个 await 激活
    await manager.boot()

    // REST API（经 @geewiki/http 路由服务挂载）
    const router = ctx.get('http') as HttpRouterService | undefined
    if (!router) {
      console.warn('[@geewiki/manager] http 路由服务不可用：REST API 未挂载（@geewiki/http 未在清单中？）')
    } else {
      registerRoutes(router, manager)
    }

    const unprovide = ctx.provide('manager', manager)
    manager.startWatchdog()

    return async () => {
      await manager.disposeAll()
      unprovide()
    }
  },
}

/* ============================ REST 路由 ============================ */

function send(h: RouteHandlerContext, status: number, body: unknown): void {
  h.json(status, body)
}

function ok(h: RouteHandlerContext, body: unknown): void {
  h.json(200, { ok: true, ...(body as object) })
}

function fail(h: RouteHandlerContext, err: unknown): void {
  if (err instanceof ManagerError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'conflict_group' || err.code === 'hot_reload_not_supported' || err.code === 'hot_dependency_not_supported' || err.code === 'has_dependents' || err.code === 'base_layer' || err.code === 'migration_failed' ? 409 : 400
    send(h, status, { ok: false, error: err.code, message: err.message, details: err.details })
    return
  }
  console.error('[manager:api] 未预期错误:', err)
  send(h, 500, { ok: false, error: 'internal', message: (err as Error).message })
}

function registerRoutes(router: HttpRouterService, manager: GeeWikiManager): void {
  router.register('GET', '/api/plugins', (h) => ok(h, { plugins: manager.snapshot() }))
  router.register('GET', '/api/plugins/graph', (h) => ok(h, { graph: manager.graph() }))
  router.register('GET', '/api/session', (h) => ok(h, manager.sessionState()))
  router.register('POST', '/api/plugins/:name/enable', async (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      let body: { config?: Record<string, unknown> } = {}
      if (h.req.headers['content-length'] || h.req.headers['transfer-encoding']) {
        body = await readJsonBody(h)
      }
      const snapshot = await manager.enable(name, body.config ?? {})
      ok(h, { plugin: snapshot })
    } catch (err) {
      fail(h, err)
    }
  })
  router.register('POST', '/api/plugins/:name/disable', async (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      await manager.disable(name)
      ok(h, { plugin: name })
    } catch (err) {
      fail(h, err)
    }
  })
  router.register('POST', '/api/session/persist', async (h) => {
    try {
      const result = manager.persistSession()
      ok(h, result)
    } catch (err) {
      fail(h, err)
    }
  })
  console.log('[@geewiki/manager] REST API 已挂载: /api/plugins, /api/plugins/graph, /api/session')
}

function readJsonBody(h: RouteHandlerContext): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    h.req.on('data', (c: Buffer) => chunks.push(c))
    h.req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch (err) {
        rejectBody(new ManagerError('bad_request', `请求体 JSON 解析失败: ${(err as Error).message}`))
      }
    })
    h.req.on('error', rejectBody)
  })
}
