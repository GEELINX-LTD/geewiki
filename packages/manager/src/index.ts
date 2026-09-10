/**
 * @geewiki/manager —— GeeWiki 插件管理器（核心大脑）
 *
 * 子系统落地（对应 docs/architecture.md 第 5 章）：
 * - 5.1 热插拔引擎：session 激活仅限 supportsHotReload:true 的插件；依赖链热授权检查；
 *       卸载前按 manifest.runtime.drainTimeout 优雅排空在途 HTTP 请求，超时才强制卸载
 * - 5.2 依赖图谱：清单驱动装配 + 依赖拓扑排序 + 反向依赖卸载拦截；graph() 供 React Flow
 * - 5.3 会话层沙箱：Base（plugins.base.json）/ Session（plugins.session.json）双层状态；
 *       临时操作仅落 Session；persistSession() 把会话合并进 Base；看门狗熔断时清空会话自愈；
 *       会话层是**叠加在基础层之上的覆盖层**：同名插件在两层的条目并存时，基础层负责激活、
 *       会话层负责覆盖配置（boot 阶段经 fork.update 叠加，见 applySessionOverlay）
 * - 5.4 广义冲突组：conflictGroup 同组互斥，激活时自动检测冲突方
 * - 5.5 迁移控制器：激活前执行 ctx.db.migrate(插件迁移目录)，失败阻止加载（事务已回滚）
 * - 5.6 看门狗：健康探针轮询；Session 插件 5 秒试用期内探针失败即回滚；
 *       连续失败达阈值（默认 3 次）触发熔断：清空 Session 后以退出码 1 退出（容器重启回 Base）
 * - 5.7 插件配置：GET/PUT /api/plugins/:name/config；声明 schemastery configSchema 的插件走
 *       校验 + 默认值填充 + 白名单裁剪，未声明者按"JSON 原文"语义原样透传给 apply；
 *       已激活插件的 PUT 走 fork.update 热更新（失败则内存/磁盘双向回滚），未激活只落盘
 *       （响应 requiresRestart:true）；卸载声明 runtime.requiresCachePurge 的插件后，
 *       经事件总线广播 CACHE_PURGE_EVENT
 *
 * 本插件由 @geewiki/server 引导加载（内核组件，不入清单），清单中的插件由本管理器
 * 按依赖拓扑依次激活；REST 路由经 @geewiki/http 的路由服务挂载。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from 'cordis'
import {
  CACHE_PURGE_EVENT,
  closeAfterResponse,
  normalizeRuntime,
  type ConfigSchema,
  type DatabaseAdapter,
  type FiberLike,
  type HttpRouterService,
  type RouteHandlerContext,
} from '@geewiki/core'
export type { RegisteredPlugin } from './deps.js'
export {
  DiscoveryError,
  ENTRY_CANDIDATES,
  isInsideDir,
  isInsideDirReal,
  listPluginDirs,
  loadExternalPlugins,
  parsePluginManifest,
  resolvePluginEntry,
  scanPluginDirs,
  type DiscoveryIssue,
  type DiscoveryOptions,
  type DiscoveryResult,
  type PluginDirScan,
} from './discovery.js'
import {
  checkHotChain,
  collectDependents,
  collectDependentsClosure,
  directDependencies,
  findConflict,
  findUncoveredRequires,
  resolveDependency,
  topologicalOrder,
  type RegisteredPlugin,
} from './deps.js'
import { decideWatchdog } from './watchdog.js'
import { buildPluginUiTable, statFileSync, type PluginUiTable } from './plugin-ui.js'
export {
  buildPluginUiTable,
  isPluginUiName,
  pluginUiEntryOf,
  pluginUiNameFromSegments,
  pluginUiRootsFor,
  resolvePluginUiHit,
  resolvePluginUiRoots,
  statFileSync,
  type PluginUiSkipped,
  type PluginUiTable,
  type PluginUiTableEntry,
  type UiFileStat,
  type UiStatFile,
} from './plugin-ui.js'
import type { DiscoveryIssue } from './discovery.js'
import {
  formatIssues,
  isSchemaInstance,
  pruneUnknownFields,
  sanitizeSchemaPayload,
  validateConfig,
  type ConfigSchemaPayload,
} from './config-schema.js'

/* ====================== 崩溃标记（架构 §5.3 自愈） ====================== */

/**
 * 写崩溃标记文件。宿主进程在捕获致命异常（uncaughtException /
 * unhandledRejection / 启动失败）后、退出前调用；下次 boot 检测到该标记
 * 即认为"上次是崩溃而非优雅退出"，忽略会话层装配（回滚至基础层）。
 */
export function writeCrashMarker(file: string, reason: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), reason }, null, 2)}\n`, 'utf8')
}

/** 删除崩溃标记（优雅退出路径；文件不存在视为已清理，不抛错） */
export function removeCrashMarker(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* 不存在即已清理 */
  }
}

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
  /**
   * 崩溃标记文件路径（架构 §5.3 自愈）：缺省不启用崩溃恢复；
   * boot 发现标记 → 醒目日志 + 忽略会话层装配 + 删除标记；
   * disposeAll 优雅卸载成功时删除标记。通常由宿主进程置于 data/ 下。
   */
  crashMarkerFile?: string
  /**
   * 外部插件发现阶段的问题（组合根 `buildRegistry` 扫描 plugins/ 得到）：
   * 只读透出到 `GET /api/plugins` 的 `issues` 字段，让"目录里躺着但没被加载"的插件可见。
   */
  discoveryIssues?: DiscoveryIssue[]
  /**
   * 前端静态产物目录（绝对路径）：用于解析插件 UI 产物的**第二候选根**
   * `<webDist>/plugins-ui/<插件名>`（第一候选根是外部插件自带的 `<插件目录>/dist`）。
   * 仅影响 `GET /api/plugins/ui` 的入口表计算，与静态托管本身无关。null/缺省 = 只看插件自带产物。
   */
  webDist?: string | null
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
  /** 来源：内置（组合根登记）/ 外部（plugins/ 目录发现） */
  source: 'builtin' | 'external'
  /** 是否声明了 schemastery configSchema（管理台据此决定渲染表单还是 JSON 编辑框） */
  configurable: boolean
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
  // 原子替换（先写 .tmp 再 rename）：避免进程在写中途被杀导致清单半截损坏，
  // 坏清单会让下次启动丢失全部插件装配（readList 抛 invalid_list_file）。
  // 临时名带 pid + 随机后缀并以 wx 独占创建：多实例共用同一 config 目录时互不覆盖。
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  // ownsTmp 表示"本次调用确实创建了这个临时文件"：wx 独占创建失败（EEXIST）时临时名属于
  // 别的进程/上一次残留，清理阶段绝不能把不属于自己的文件删掉。
  let ownsTmp = false
  try {
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    ownsTmp = true
    renameSync(tmp, file)
    ownsTmp = false // rename 成功后临时名已不存在
  } catch (err) {
    if (ownsTmp) {
      try {
        unlinkSync(tmp)
      } catch {
        // 清理失败不得掩盖原始错误
      }
    }
    throw err
  }
}

/* ============================= 管理器本体 ============================= */

interface ManagedPlugin {
  entry: RegisteredPlugin
  active: boolean
  layer: Layer | null
  error: string | null
  config: Record<string, unknown> | undefined
  /** ctx.plugin() 返回的 cordis fiber 句柄（dispose 动态卸载） */
  fiber: FiberLike | null
}

export class GeeWikiManager {
  readonly ctx: Context
  private readonly config: Required<Omit<ManagerConfig, 'registry' | 'crashMarkerFile'>> & {
    registry: RegisteredPlugin[]
    crashMarkerFile?: string
  }
  private readonly plugins = new Map<string, ManagedPlugin>()
  /** 激活顺序（dispose 时逆序卸载） */
  private readonly activationOrder: string[] = []
  private base: PluginListFile = { enabled: [] }
  private session: PluginListFile = { enabled: [] }
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private bootErrors: string[] = []
  /** 已就"configSchema 非 schemastery 实例"告警过的插件名（每个插件只吵一次） */
  private readonly warnedLegacySchema = new Set<string>()
  /** 最近一次会话层激活的插件（看门狗试用期回滚归因目标） */
  private lastEnabledName: string | null = null
  private lastEnabledAt: number | null = null
  /**
   * 会话层配置**叠加失败**的插件名（boot 阶段 {@link applySessionOverlay} 抛出的出口登记）。
   * 这些插件进程内仍以基础层配置运行（activeLayer 也是 base），因此 `configOf` 的 layer
   * 必须回落 base，否则会报出"layer=session 但生效值来自 base"的自相矛盾。
   */
  private readonly overlayFailed = new Set<string>()

  constructor(ctx: Context, config: ManagerConfig) {
    this.ctx = ctx
    this.config = {
      registry: config.registry,
      baseFile: config.baseFile,
      sessionFile: config.sessionFile,
      watchdogIntervalMs: config.watchdogIntervalMs ?? 5000,
      gracePeriodMs: config.gracePeriodMs ?? 5000,
      meltdownThreshold: config.meltdownThreshold ?? 3,
      crashMarkerFile: config.crashMarkerFile,
      discoveryIssues: config.discoveryIssues ?? [],
      webDist: config.webDist ?? null,
    }
  }

  /* ------------------------- 查询（供 REST） ------------------------- */

  /** 全部注册插件的运行快照（含未激活） */
  snapshot(): PluginSnapshot[] {
    return this.config.registry
      .map((entry) => this.snapshotOf(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 插件客户端 UI 入口表（`GET /api/plugins/ui` 的数据源）。
   *
   * 每次调用**现算**：注册表只有几条，`existsSync`/`statSync` 的开销可忽略，
   * 而缓存会引入"改了产物但表没更新"的一致性风险——不值得。
   * 判定逻辑全部在 `plugin-ui.ts` 的纯函数里（含双根优先级与存在性），此处只喂真实 IO。
   */
  uiTable(): PluginUiTable {
    return buildPluginUiTable({
      registry: this.config.registry,
      activeNames: this.activeNames(),
      webDist: this.config.webDist,
      statFile: statFileSync,
    })
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
      source: entry.source ?? 'builtin',
      configurable: this.configSchemaOf(entry) !== undefined,
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

  /** 外部插件发现阶段的问题（plugins/ 扫描所得），透出到 `GET /api/plugins` 的 issues */
  discoveryIssues(): DiscoveryIssue[] {
    return [...this.config.discoveryIssues]
  }

  /** 双层清单内容（含启动时各插件的激活错误） */
  sessionState(): { base: PluginListFile; session: PluginListFile; bootErrors: string[] } {
    return { base: this.base, session: this.session, bootErrors: this.bootErrors }
  }

  /* ----------------------- 配置（架构 §5.7） ----------------------- */

  /**
   * 插件的配置 Schema：优先取 cordis 约定的 `module.Config`（设置后 cordis 会在
   * `ctx.plugin(plugin, raw)` 时自动校验并填默认值），否则取 manifest 的 configSchema。
   * 旧式 JSON Schema 字面量（普通对象）视为"无 schema"，仅告警一次。
   */
  private configSchemaOf(entry: RegisteredPlugin): ConfigSchema | undefined {
    const fromModule = entry.module.Config
    if (isSchemaInstance(fromModule)) return fromModule
    const declared = entry.manifest.geewiki.configSchema
    if (isSchemaInstance(declared)) return declared
    if (declared !== undefined && !this.warnedLegacySchema.has(entry.name)) {
      this.warnedLegacySchema.add(entry.name)
      console.warn(
        `[manager] 插件 ${entry.name} 的 configSchema 不是 schemastery Schema（旧式 JSON Schema 字面量？）：` +
          '已跳过结构化校验与表单生成，仅提供 JSON 原文编辑',
      )
    }
    return undefined
  }

  /**
   * 配置查询（REST GET）：当前生效配置 + 清洗后的 schema 载荷 + 层信息。
   *
   * `layer` = **这份生效配置实际取自哪一层**（会话层条目带 config 时是会话层覆盖，
   * 否则下沉到基础层；两层都无条目则为下次保存的默认落点 base），
   * `activeLayer` = **激活层**（未激活为 null）。注意 `GET /api/plugins` 列表里的
   * `PluginSnapshot.layer` 仍是激活层，两者是不同维度。
   */
  configOf(name: string): {
    name: string
    layer: Layer
    activeLayer: Layer | null
    config: Record<string, unknown>
    schema: ConfigSchemaPayload | null
  } {
    const entry = this.registryOf(name)
    const schema = this.configSchemaOf(entry)
    const managed = this.plugins.get(name)
    let config = managed?.config ?? this.persistedConfigOf(name)
    if (config === undefined && schema) {
      // 未激活且从未落盘：用 schema 校验空对象补齐默认值，与激活态的展示口径一致
      const filled = validateConfig(schema, {})
      if (filled.ok) config = pruneUnknownFields(schema, filled.value) as Record<string, unknown>
    }
    return {
      name,
      layer: this.effectiveConfigLayerOf(name),
      activeLayer: managed?.layer ?? null,
      config: config ?? {},
      schema: schema ? sanitizeSchemaPayload(schema) : null,
    }
  }

  /**
   * 配置更新（REST PUT）：校验 → 原子落盘 → 已激活则 `fork.update` 热更新。
   *
   * 语义：
   * - 声明了 schemastery configSchema：按 schema 校验、填默认值、按白名单裁剪未知字段；
   * - 未声明 schema：按"JSON 原文编辑框"语义（架构 §5.7），只要求顶层是 JSON 对象，
   *   不做结构化校验也不裁剪字段，原样透传给插件 apply；
   * - 未激活：只落盘（按插件当前所在层写 session / base；从未出现过则写 base），不加载；
   * - 已激活：落盘后热更新；`fork.update` 失败时**显式回滚**进程内配置与磁盘
   *   （cordis 的 update 在 apply 抛错后会把 fiber.config 置为新值，不回滚就会内存/磁盘不一致）；
   * - 未发生热更新时返回 `requiresRestart: true`：配置已落盘，待下次激活/重启生效；
   * - 依赖方被连带重启是 cordis inject 的预期行为，不在此阻止。
   */
  async updateConfig(
    name: string,
    raw: unknown,
  ): Promise<{ config: Record<string, unknown>; hotUpdated: boolean; requiresRestart: boolean }> {
    const entry = this.registryOf(name)
    const schema = this.configSchemaOf(entry)
    let config: Record<string, unknown>
    if (schema) {
      const validation = validateConfig(schema, raw)
      if (!validation.ok) {
        throw new ManagerError('invalid_config', `配置校验失败: ${formatIssues(validation.issues)}`, {
          issues: validation.issues,
        })
      }
      config = pruneUnknownFields(schema, validation.value) as Record<string, unknown>
    } else {
      // 无 schema 插件：只校验"必须是 JSON 对象"这一形状约束，字段原样透传
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ManagerError('invalid_config', `${name} 未声明 configSchema，配置必须是 JSON 对象`, {
          issues: [{ message: '配置必须是 JSON 对象' }],
        })
      }
      config = raw as Record<string, unknown>
    }

    const managed = this.plugins.get(name)
    const previous = managed?.config
    const layer = this.layerOf(name)
    this.persistConfig(name, config, layer)

    const fiber = managed?.active ? managed.fiber : null
    if (!managed?.active || !fiber?.update) {
      // 未激活（或运行期无热更新能力）：仅落盘，等待下次激活时生效
      if (managed) managed.config = config
      return { config, hotUpdated: false, requiresRestart: true }
    }

    try {
      await fiber.update(config)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // 回滚磁盘：恢复旧配置（无旧配置则移除该条目的 config 字段）
      try {
        if (previous === undefined) this.removePersistedConfig(name)
        else this.persistConfig(name, previous, layer)
      } catch (rollbackErr) {
        console.error(`[manager] 配置回滚（磁盘）失败 ${name}:`, rollbackErr)
      }
      // 回滚进程内：cordis 在 update 失败后 fiber.config 已是新值，需显式再 update 回旧值
      let rolledBack = false
      try {
        await fiber.update(previous ?? {})
        rolledBack = true
      } catch (rollbackErr) {
        console.error(`[manager] 配置回滚（进程内）失败 ${name}:`, rollbackErr)
      }
      if (managed) managed.config = previous
      throw new ManagerError(
        'hot_update_failed',
        `配置热更新失败（进程内配置${rolledBack ? '已回滚' : '回滚失败，详见服务端日志'}）: ${reason}`,
        { config: previous ?? {}, rolledBack },
      )
    }

    managed.config = config
    if (layer === 'session') {
      // 会话层配置已成功热更新：清除"叠加失败"标记（同一进程内先失败后成功不得残留）
      this.overlayFailed.delete(name)
      // 与 enable 对称：会话层插件热更新后进入试用期，探针失败可被看门狗回滚
      this.lastEnabledName = name
      this.lastEnabledAt = Date.now()
    }
    console.log(`[manager] 插件 ${name} 配置已热更新（${layer} 层）`)
    return { config, hotUpdated: true, requiresRestart: false }
  }

  /** 插件在清单中的落盘位置（= 配置的**写入**目标层）：session 优先（会话层变更不应污染基础层），否则 base */
  private layerOf(name: string): Layer {
    return this.session.enabled.some((e) => e.name === name) ? 'session' : 'base'
  }

  /**
   * 生效配置**实际取自**哪一层（`configOf` 的 layer 口径）。
   *
   * 与 {@link layerOf}（写入目标层）的差别只在"会话条目没写 config"这一种情况：
   * 会话层是叠加在基础层之上的覆盖层，条目存在但没有 config 就不构成有效覆盖，
   * 此时生效值来自基础层 —— 若仍按"有条目即 session"上报，就会出现
   * "报 session、实际生效的是 base"的自相矛盾。
   */
  private effectiveConfigLayerOf(name: string): Layer {
    const inSession = this.session.enabled.find((e) => e.name === name)
    if (inSession?.config === undefined) return 'base'
    // 报"实际生效的配置来自哪一层"，而不是"条目写在哪一层"：会话层叠加失败的条目
    // 进程内仍以基础层配置运行（activeLayer 也是 base），此时报 session 会自相矛盾。
    // 仅在插件确实处于激活态时才回落（未激活时展示的就是持久化值，按条目所在层报即可）。
    if (this.overlayFailed.has(name) && this.plugins.get(name)?.active) return 'base'
    return 'session'
  }

  /**
   * 读取已落盘（清单文件）的配置；两层都没有该插件时返回 undefined。
   * 会话条目未写 config 时不构成有效覆盖，继续下沉到基础层（叠加层语义）。
   */
  private persistedConfigOf(name: string): Record<string, unknown> | undefined {
    const inSession = this.session.enabled.find((e) => e.name === name)
    if (inSession?.config !== undefined) return inSession.config
    return this.base.enabled.find((e) => e.name === name)?.config
  }

  /** 把配置写入对应层的清单并原子落盘 */
  private persistConfig(name: string, config: Record<string, unknown>, layer: Layer): void {
    const file = layer === 'session' ? this.session : this.base
    const existing = file.enabled.find((e) => e.name === name)
    if (existing) existing.config = config
    else file.enabled.push({ name, config })
    writeList(layer === 'session' ? this.config.sessionFile : this.config.baseFile, file)
  }

  /**
   * 移除清单条目上的 config 字段并落盘（回滚路径：原先没有配置时恢复"无配置"状态）。
   * 只写**真正包含该条目**的那个清单：失败的 PUT 不得顺手重写另一层的文件字节。
   * 返回是否命中（未命中说明从未落盘，无需写盘）。
   */
  private removePersistedConfig(name: string): boolean {
    let touched = false
    for (const [file, path] of [
      [this.session, this.config.sessionFile],
      [this.base, this.config.baseFile],
    ] as const) {
      const existing = file.enabled.find((e) => e.name === name)
      if (!existing) continue
      delete existing.config
      writeList(path, file)
      touched = true
    }
    return touched
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
    // 崩溃恢复（架构 §5.3）：上次进程异常退出（崩溃标记残留）→ 忽略会话层装配
    const marker = this.config.crashMarkerFile
    const crashed = marker !== undefined && existsSync(marker)
    if (crashed) {
      console.error(
        `[manager] 检测到崩溃标记（${marker}）：上次进程异常退出。按架构 §5.3 本次启动忽略会话层（Session），回滚至基础层（Base）`,
      )
      this.bootErrors.push('检测到崩溃标记（上次进程异常退出），本次启动已忽略会话层并回滚至基础层')
      this.session = { enabled: [] }
      // 与看门狗熔断路径（writeList sessionFile 空态后 exit(1)）对称：同步清空会话清单文件，
      // 否则残留的会话条目会在下一次正常启动（无标记）时被重新装配，自愈只保护一次 boot
      try {
        writeList(this.config.sessionFile, { enabled: [] })
      } catch (err) {
        console.error('[manager] 崩溃恢复：清空会话清单文件失败:', err)
      }
      removeCrashMarker(marker)
    } else {
      try {
        this.session = readList(this.config.sessionFile)
      } catch (err) {
        this.bootErrors.push((err as Error).message)
        this.session = { enabled: [] }
      }
    }
    const desired = new Map<string, { config: Record<string, unknown>; layer: Layer }>()
    for (const e of this.base.enabled) {
      if (!desired.has(e.name)) desired.set(e.name, { config: e.config ?? {}, layer: 'base' })
    }
    // 会话层是**叠加在基础层之上的覆盖层**（§5.3），不是"另一份激活意图"：
    // 同名插件已在基础层时，其会话条目若仍按 activateCore(..., 'session') 走，会被
    // "已激活早退（base 提升不降级）"整条丢弃 —— 于是重启后生效的仍是基础层旧值，
    // 而 GET /config 又按"会话层有条目"上报 layer: session（报的层与生效的层不一致）。
    // 因此这里把这类条目收集为"叠加意图"，等基础装配完成后再热更新进去。
    const sessionOverlay = new Map<string, Record<string, unknown>>()
    for (const e of this.session.enabled) {
      if (!desired.has(e.name)) {
        desired.set(e.name, { config: e.config ?? {}, layer: 'session' })
        continue
      }
      // 条目没写 config 时不构成有效覆盖（生效值仍来自基础层），无需求叠加
      if (e.config !== undefined) sessionOverlay.set(e.name, e.config)
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
        if (intent.layer === 'session') {
          // 看门狗试用期归因基准：最近一次会话层激活
          this.lastEnabledName = name
          this.lastEnabledAt = Date.now()
        }
      } catch (err) {
        const p = this.plugins.get(name)
        if (p) p.error = (err as Error).message
        this.bootErrors.push(`插件 ${name} 激活失败: ${(err as Error).message}`)
      }
    }
    // 会话层叠加（基础装配之后，按同一拓扑序=依赖先叠）：
    // 单条失败只记录不抛出，boot 不因此整体失败；插件继续以基础层配置服务。
    for (const name of order) {
      const overlayConfig = sessionOverlay.get(name)
      if (overlayConfig === undefined) continue
      const managed = this.plugins.get(name)
      if (!managed?.active) continue // 基础层激活失败：上面的 catch 已记入 bootErrors，无处可叠
      try {
        await this.applySessionOverlay(name, managed, overlayConfig)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[manager] 插件 ${name} 的会话层配置叠加失败（仍以基础层配置运行）: ${reason}`)
        this.bootErrors.push(`插件 ${name} 会话层配置叠加失败（仍以基础层配置运行）: ${reason}`)
      }
    }
  }

  /**
   * 会话层热启用（enable）：校验热授权/依赖链/冲突/迁移后激活并写入 Session 清单。
   *
   * **单一回滚点**：本方法是所有递归深度的唯一回滚处（实现在 enableWithDeps），递归主体见 enableInner。
   * 回滚集合（activated）由 enableInner 各帧**共用**——历史缺陷（W2）：回滚集合曾是
   * 每递归帧各自的局部数组，且由父帧替子帧记账，导致目标插件激活失败时**深度 ≥2 的
   * 孙依赖**无人回滚，残留在 Session 清单文件里（落盘为已启用但进程内并不活跃）。
   * 该缺陷在内置注册表（依赖深度最大 1）下不可达，但 buildRegistry 会把外部插件与
   * 内置插件并入同一注册表，深度 ≥2 的链路可由外部插件构造，故必须修。
   */
  async enable(name: string, config?: Record<string, unknown>): Promise<PluginSnapshot> {
    return this.enableWithDeps(name, config)
  }

  /**
   * enable 的带参入口：`skipDeps` 中的插件名在递归装配依赖时被跳过。
   * 目前唯一用途是冲突组替换（replace）——目标插件与旧插件往往 `provides` 同一服务，
   * 旧插件卸载后若仍把 requires 解析到它，会把它当依赖重新拉起来（进而撞上冲突组互斥）。
   */
  private async enableWithDeps(
    name: string,
    config: Record<string, unknown> | undefined,
    skipDeps?: ReadonlySet<string>,
  ): Promise<PluginSnapshot> {
    const activated: string[] = []
    try {
      return await this.enableInner(name, config, activated, skipDeps)
    } catch (err) {
      // 按**逆激活序**回滚本次调用新增激活的全部插件（含任意递归深度）：
      // 先卸依赖方再卸被依赖者，逐个移出会话清单，不留半激活残留
      for (const n of [...activated].reverse()) {
        try {
          await this.deactivateCore(n)
        } catch (rollbackErr) {
          console.error(`[manager] 启用 ${name} 失败后的回滚卸载 ${n} 出错:`, rollbackErr)
        }
        this.removeFromSession(n)
      }
      throw err
    }
  }

  /**
   * enable 的递归主体：校验 → 递归激活未激活的直接依赖 → 激活并落盘自身。
   *
   * 所有递归帧共用同一个 activated 数组并**自登记**（激活成功的那一帧自己 push），
   * 而不是由父帧替子帧记账——这是 W2 的修法要点。
   *
   * 注：cordis 的 inject 语义使得依赖方在依赖被更新时会连带重启（dispose + 重新 apply），
   * 这是预期行为，不是回滚。
   */
  private async enableInner(
    name: string,
    config: Record<string, unknown> | undefined,
    activated: string[],
    skipDeps?: ReadonlySet<string>,
  ): Promise<PluginSnapshot> {
    const entry = this.registryOf(name)
    const m = entry.manifest.geewiki

    if (this.plugins.get(name)?.active) {
      // 幂等：已在活动状态（无论 base 还是 session）视为成功。
      // 但显式传入了非空配置时**不得静默丢弃**：委托到配置更新路径（已激活 → fork.update 热更新）
      if (config && Object.keys(config).length > 0) {
        await this.updateConfig(name, config)
      }
      return this.snapshotOf(name)
    }
    if (m.runtime?.supportsHotReload !== true) {
      throw new ManagerError(
        'hot_reload_not_supported',
        `${name} 未声明 runtime.supportsHotReload: true，仅支持持久化安装 + 进程重启（冷操作）`,
      )
    }
    // 冲突预检（在任何副作用之前）：目标所在冲突组已有活动成员 → 直接 409，零残留
    const preConflict = findConflict(this.config.registry, this.activeNames(), name)
    if (preConflict) {
      throw new ManagerError(
        'conflict_group',
        `冲突组 "${m.conflictGroup}" 已有激活插件 ${preConflict}，同组互斥`,
        { with: preConflict },
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
    // 事务性启用：先递归启用未激活依赖（同样走会话层热路径）。
    // 任一环节失败时的回滚由 enable 的**单一回滚点**统一负责（共用 activated 数组），
    // 本帧不再自行回滚——避免深度 ≥2 时孙依赖无人记账（W2）。
    // 未显式传配置时回退到清单里已持久化的配置（PUT /config 的成果应当生效）
    const effectiveConfig = config && Object.keys(config).length > 0 ? config : (this.persistedConfigOf(name) ?? {})
    for (const dep of directDependencies(this.config.registry, name)) {
      if (skipDeps?.has(dep)) continue // 冲突组替换：被顶替的旧插件不当作依赖重新拉起
      if (!this.plugins.get(dep)?.active) {
        await this.enableInner(dep, undefined, activated, skipDeps)
      }
    }
    await this.activateCore(name, effectiveConfig, 'session')
    // 自登记：激活成功的那一帧自己记账（目标自身激活失败时不登记）
    activated.push(name)
    this.lastEnabledName = name
    this.lastEnabledAt = Date.now()
    // 落盘用"生效配置"（activateCore 已按 schema 填默认值/裁剪未知字段）
    this.addToSession(name, this.plugins.get(name)?.config ?? effectiveConfig)
    return this.snapshotOf(name)
  }

  /**
   * 冲突组替换（replace）：把同 conflictGroup 的会话层插件顶替掉，并热激活目标插件。
   *
   * 顺序即语义：
   *  1. 目标已激活 → 幂等返回当前快照（不顶替任何插件，`replaced` 为 null）。
   *  2. 无同组冲突 → 退化为普通会话层启用（`replaced` 为 null、`restarted` 为空）。
   *  3. 有冲突 → 前置校验（全部在做任何副作用之前）：
   *     - 目标 `runtime.supportsHotReload`；
   *     - 热依赖链可用（`checkHotChain`）；
   *     - **旧插件的真实激活层**必须是 session（`managed.layer`，不是 `layerOf()`）——
   *       同名条目同时在两层的叠加态下它以 base 层激活，属冷操作，热替换无从谈起；
   *     - **整个卸载集合的成员**（旧插件 + 活跃的传递依赖方）真实激活层都必须是 session：
   *       卸载走 `deactivateCore` 会绕过 `disable()` 的守卫，而接回依赖方时 `enable()` 落的是
   *       会话层条目，会把基础层插件的持久化层静默改写；
   *     - **提供者覆盖**：被顶替者自身与每个待接回的依赖方，凡"原本指向被顶替者的依赖边"
   *       都必须能被目标承接（按插件名或按 `provides`）。依赖方**按具体插件名**依赖被顶替者时
   *       会被拒绝（`provider_mismatch`）——按名的边无法由新插件承接，正解是依赖方改为依赖服务
   *       标识；目标是"宁可 409，也不返回 200 却留下无人提供的服务"。目标自身依赖它要顶替掉的
   *       插件同样被拒（不自洽）。
   *  4. 卸载集合 = 旧插件 ∪ 其（传递）依赖方中当前活跃者，按拓扑序**逆序**逐个卸载
   *     （依赖方先卸、被依赖者后卸），再激活目标；随后按正向拓扑序把依赖方接回
   *     （`skipDeps` 阻止旧插件被当依赖重新拉起）。成功返回的 `restarted` 即接回的依赖方。
   *  5. 失败则回滚：先防御性卸下目标，再按正向激活序恢复旧插件与依赖方；
   *     恢复也失败时抛 replace_rollback_failed（500），把当前真实状态写进 message 供人工介入。
   *
   * 注：整个过程会多次写会话清单（卸载集合一次 + 目标 + 每个接回的依赖方），每次都是
   * tmp+rename 原子替换，因此任意时刻的清单文件都是自洽的；不追求"全程仅一次落盘"。
   */
  async replace(
    name: string,
    config?: Record<string, unknown>,
  ): Promise<{
    plugin: PluginSnapshot
    replaced: { name: string; config?: Record<string, unknown> } | null
    restarted: string[]
  }> {
    if (this.plugins.get(name)?.active) {
      // 幂等：目标已在活动状态，没什么可顶替的
      if (config && Object.keys(config).length > 0) await this.updateConfig(name, config)
      return { plugin: this.snapshotOf(name), replaced: null, restarted: [] }
    }
    const conflict = findConflict(this.config.registry, this.activeNames(), name)
    if (!conflict) {
      // 无冲突：等价于一次普通会话层启用
      const plugin = await this.enable(name, config)
      return { plugin, replaced: null, restarted: [] }
    }
    // ---- 前置校验（零副作用）----
    const m = this.registryOf(name).manifest.geewiki
    if (m.runtime?.supportsHotReload !== true) {
      throw new ManagerError(
        'hot_reload_not_supported',
        `${name} 未声明 runtime.supportsHotReload: true，无法热替换 ${conflict}`,
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
    // B1：判据必须是**真实激活层**（managed.layer），不能用 layerOf()——后者判的是"有没有
    // 会话条目"（它的语义是"配置写入目标层"，别处依赖它）。同名插件同时出现在基础层与会话层
    // 清单是本仓库明确支持的叠加态（会话层是叠加在基础层之上的覆盖层），此时它实际以 base 层
    // 激活，而 layerOf() 会误报 session → 冷插件被热替换，且旧插件仍留在基础层清单里，
    // 重启后每次启动都会撞冲突组互斥。disable() 用的就是真实激活层，两处必须一致。
    const conflictManaged = this.plugins.get(conflict)
    if (conflictManaged?.layer !== 'session') {
      throw new ManagerError(
        'base_layer',
        `${conflict} 属于基础层（冷操作），无法热替换：请编辑基础层清单 ${basename(this.config.baseFile)} 后重启进程`,
      )
    }
    // ---- 计算卸载集合与顺序 ----
    const active = this.activeNames()
    const restarted = collectDependentsClosure(this.config.registry, [conflict]).filter((n) => active.has(n))
    const unloadSet = [conflict, ...restarted]
    // S2：卸载集合里不允许出现基础层成员。卸载走 deactivateCore，它**绕过** disable() 的
    // base_layer 守卫直接热卸载；而把依赖方接回时走 enable() 落的是**会话层**条目，于是基础层
    // 插件的持久化层会被静默改写成 session（此后对它的 PUT /config 会写进会话清单）。
    const baseLayerMembers = unloadSet.filter((n) => this.plugins.get(n)?.layer !== 'session')
    if (baseLayerMembers.length > 0) {
      throw new ManagerError(
        'base_layer',
        `无法热替换 ${conflict}：${baseLayerMembers.join('、')} 属于基础层（冷插件），其活跃依赖方不可热卸载；请编辑基础层清单 ${basename(this.config.baseFile)} 后重启进程`,
        { plugins: baseLayerMembers },
      )
    }
    // S1：提供者覆盖校验。被顶替者自身与每个将要接回的依赖方，凡"原本指向被顶替者的依赖边"
    // 都必须能被目标承接；否则替换会返回 200，而服务已无人提供（依赖方依赖落空）。
    const uncovered = findUncoveredRequires(this.config.registry, conflict, name, [conflict, ...restarted])
    const firstUncovered = uncovered[0]
    if (firstUncovered) {
      throw new ManagerError(
        'provider_mismatch',
        `${firstUncovered.plugin} 依赖 ${firstUncovered.token}（原本由 ${conflict} 提供），但目标 ${name} 无法承接该依赖：请让依赖方改为依赖服务标识（provides token）`,
        {
          plugin: firstUncovered.plugin,
          token: firstUncovered.token,
          target: name,
          targetProvides: m.provides ?? null,
          violations: uncovered,
        },
      )
    }
    // S1（目标自洽）：目标自身依赖它要顶替掉的插件 → 拒绝。此处**不给"目标恰好 provides
    // 同名 token"的豁免：按名的边仍指向旧插件，目标激活后该依赖恒不满足。
    const selfRequiresConflict = (m.requires ?? []).filter(
      (t) => resolveDependency(this.config.registry, t)?.name === conflict,
    )
    if (selfRequiresConflict.length > 0) {
      throw new ManagerError(
        'provider_mismatch',
        `目标 ${name} 自身依赖 ${selfRequiresConflict.join('、')}（即它要顶替掉的 ${conflict}），不自洽`,
        { plugin: name, tokens: selfRequiresConflict, target: name, conflict },
      )
    }
    const restoreOrder = this.safeTopological(unloadSet)
    const unloadOrder = [...restoreOrder].reverse()
    // 卸载前捕获各插件已落盘的配置：会话条目即将被移除，恢复时要原样写回
    const captured = new Map<string, Record<string, unknown> | undefined>()
    for (const n of unloadSet) captured.set(n, this.persistedConfigOf(n))
    // 调用前的会话清单快照：回滚若全部成功就原样写回，使"替换失败不留痕"是**顺序与格式**层面的
    // 真属性——逐条 enable 恢复只会把条目按拓扑序追加回去，与原顺序（用户启用顺序）不一定一致。
    const sessionBackup = JSON.parse(JSON.stringify(this.session)) as PluginListFile
    try {
      for (const n of unloadOrder) await this.deactivateCore(n)
      this.removeManyFromSession(unloadSet) // 卸载集合整体一次性落盘
      // 目标先激活，再按正向拓扑序把依赖方接回新提供者（skipDeps 阻止旧插件被当依赖拉回）
      const skip = new Set([conflict])
      const plugin = await this.enableWithDeps(name, config, skip)
      const restartedDone: string[] = []
      for (const n of restoreOrder) {
        if (n === conflict) continue
        if (this.plugins.get(n)?.active) {
          restartedDone.push(n)
          continue
        }
        await this.enableWithDeps(n, captured.get(n) ?? {}, skip)
        restartedDone.push(n)
      }
      return { plugin, replaced: { name: conflict, config: captured.get(conflict) }, restarted: restartedDone }
    } catch (err) {
      // ---- 回滚：卸下可能已激活的目标 → 按正向激活序恢复旧插件与依赖方 ----
      try {
        if (this.plugins.get(name)?.active) await this.deactivateCore(name)
      } catch (unloadErr) {
        console.error(`[manager] 替换 ${conflict} → ${name} 失败后卸下目标出错:`, unloadErr)
      }
      this.removeFromSession(name)
      const failures: string[] = []
      for (const n of restoreOrder) {
        if (this.plugins.get(n)?.active) continue
        try {
          await this.enable(n, captured.get(n) ?? {})
        } catch (restoreErr) {
          failures.push(`${n}: ${(restoreErr as Error).message}`)
        }
      }
      if (failures.length > 0) {
        throw new ManagerError(
          'replace_rollback_failed',
          `替换 ${conflict} → ${name} 失败且回滚未完全成功，需人工介入（回滚失败项: ${failures.join('; ')}）。原始错误: ${(err as Error).message}`,
          { failed: failures, cause: (err as Error).message, conflict, target: name },
        )
      }
      // 全部恢复成功：会话清单还原成调用前的字节（条目顺序/配置一处不差，替换失败不留痕）
      this.session = sessionBackup
      writeList(this.config.sessionFile, this.session)
      throw err
    }
  }

  /** 拓扑排序的安全包装：存在依赖环时退回清单原序（后续逐个激活仍会各自失败并记录） */
  private safeTopological(names: readonly string[]): string[] {
    try {
      return topologicalOrder(this.config.registry, names)
    } catch (err) {
      console.warn(`[manager] 依赖拓扑排序失败（${(err as Error).message}），退回清单原序:`, names)
      return [...names]
    }
  }

  /** 会话层停用（disable）：仅限 Session 层插件；有活动依赖者时阻止卸载 */
  async disable(name: string): Promise<void> {
    const p = this.plugins.get(name)
    if (!p?.active) throw new ManagerError('not_active', `插件未激活: ${name}`)
    if (p.layer !== 'session') {
      throw new ManagerError(
        'base_layer',
        `${name} 属于基础层（冷操作），请编辑基础层清单 ${basename(this.config.baseFile)} 后重启进程`,
      )
    }
    const dependents = collectDependents(this.config.registry, this.activeNames(), name)
    if (dependents.length > 0) {
      throw new ManagerError('has_dependents', `存在依赖方，禁止卸载: ${dependents.join(', ')}`, { dependents })
    }
    await this.deactivateCore(name)
    this.removeFromSession(name)
  }

  /** 应用并持久化：Session 层"活动"条目合并进 Base，清空会话（构想 5.3 的"应用并持久化"）。
   * 激活失败（error 态/未装配）的条目不提升——避免坏配置被持久化后每次启动报错。 */
  persistSession(): { promoted: string[] } {
    const promoted: string[] = []
    for (const entry of this.session.enabled) {
      const p = this.plugins.get(entry.name)
      if (!p?.active) {
        console.warn(
          `[manager] persistSession: 跳过未激活条目 ${entry.name}（激活失败或未装配，不提升进基础层）`,
        )
        continue
      }
      const existing = this.base.enabled.find((e) => e.name === entry.name)
      if (existing) existing.config = entry.config
      else this.base.enabled.push({ ...entry })
      promoted.push(entry.name)
      p.layer = 'base'
    }
    this.session = { enabled: [] }
    writeList(this.config.baseFile, this.base)
    writeList(this.config.sessionFile, this.session)
    return { promoted }
  }

  /* ------------------------- 内部实现 ------------------------- */

  private registryOf(name: string): RegisteredPlugin {
    const entry = this.config.registry.find((p) => p.name === name)
    if (!entry) throw new ManagerError('not_found', `未知插件: ${name}（未注册）`)
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

  /** 一次性移除多个会话条目并**只落盘一次**（冲突组替换整体卸载时用） */
  private removeManyFromSession(names: readonly string[]): void {
    const drop = new Set(names)
    const before = this.session.enabled.length
    this.session.enabled = this.session.enabled.filter((e) => !drop.has(e.name))
    if (this.session.enabled.length !== before) writeList(this.config.sessionFile, this.session)
  }

  /**
   * 激活核心流程（boot/session 共用）：依赖已就绪前提下——
   * 冲突组检查 → 迁移控制器 → cordis 加载。任一失败抛 ManagerError 且不留半激活态。
   */
  private async activateCore(name: string, config: Record<string, unknown>, layer: Layer): Promise<void> {
    const entry = this.registryOf(name)
    let managed = this.plugins.get(name)
    if (!managed) {
      managed = { entry, active: false, layer: null, error: null, config: undefined, fiber: null }
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

    // 5.7 配置校验：声明了 schema 的插件在加载前先校验并填入默认值，
    // 使 managed.config（快照/热更新回滚基准）始终是"生效配置"而非原始入参
    let effectiveConfig = config
    const schema = this.configSchemaOf(entry)
    if (schema) {
      const validation = validateConfig(schema, config)
      if (!validation.ok) {
        managed.error = `配置校验失败: ${formatIssues(validation.issues)}`
        throw new ManagerError('invalid_config', `插件 ${name} 的配置非法: ${formatIssues(validation.issues)}`, {
          issues: validation.issues,
        })
      }
      effectiveConfig = pruneUnknownFields(schema, validation.value) as Record<string, unknown>
    }

    // cordis 动态加载：await 等激活完成（含 async apply）；激活失败经 _error 抛出
    let fiber: FiberLike
    try {
      fiber = await this.ctx.plugin(entry.module, effectiveConfig)
    } catch (err) {
      managed.error = (err as Error).message
      throw new ManagerError('load_failed', `加载失败 ${name}: ${(err as Error).message}`)
    }
    managed.fiber = fiber
    managed.active = true
    managed.layer = layer
    managed.error = null
    managed.config = effectiveConfig
    this.activationOrder.push(name)
  }

  /**
   * 会话层配置叠加（仅 boot 调用）：插件已由基础层激活时，把会话层条目的配置经
   * `fork.update` 热更新进去 —— 等价于"进程内执行一次 PUT /config"，但**不落盘**
   * （两个清单文件的字节都已是用户意图，重启不该改写它们；§5.3 会话层是覆盖层）。
   *
   * 与 `updateConfig` 的差异：不重新激活、不重跑迁移控制器（迁移是激活前置，
   * 基础层激活时已执行）、不动 `managed.layer` 与看门狗试用期（这不是一次新的会话层激活，
   * 激活层归属保持基础层，`GET /api/plugins` 的 layer 语义不变）。
   * 与 `updateConfig` 一致：按 configSchema 校验 + 白名单裁剪（清单文件可被手工编辑），
   * 且 `fork.update` 失败后显式回滚进程内配置 —— cordis 在 apply 抛错时会把 fiber.config
   * 置为新值（方案文档 F-3），不回滚就会留下"上报配置 ≠ 实际 apply 配置"的残留。
   */
  private async applySessionOverlay(
    name: string,
    managed: ManagedPlugin,
    config: Record<string, unknown>,
  ): Promise<void> {
    const fiber = managed.fiber
    if (!fiber?.update) {
      this.overlayFailed.add(name)
      throw new Error('运行期句柄不支持 fork.update，无法叠加会话层配置')
    }
    let effective = config
    const schema = this.configSchemaOf(managed.entry)
    if (schema) {
      const validation = validateConfig(schema, config)
      if (!validation.ok) {
        this.overlayFailed.add(name)
        throw new ManagerError('invalid_config', `配置校验失败: ${formatIssues(validation.issues)}`, {
          issues: validation.issues,
        })
      }
      effective = pruneUnknownFields(schema, validation.value) as Record<string, unknown>
    }
    const previous = managed.config
    if (isDeepStrictEqual(effective, previous)) {
      // 覆盖值与基础层生效值相同（enable 写会话条目时通常就是这样）：跳过，
      // 免得每次启动都白做一次 dispose + apply，并连带重启依赖方
      return
    }
    try {
      await fiber.update(effective)
    } catch (err) {
      this.overlayFailed.add(name)
      try {
        await fiber.update(previous ?? {})
        console.error(`[manager] 插件 ${name} 会话层配置叠加失败，已回滚为基础层配置`)
      } catch (rollbackErr) {
        console.error(`[manager] 插件 ${name} 会话层配置叠加回滚失败:`, rollbackErr)
      }
      throw err
    }
    this.overlayFailed.delete(name)
    managed.config = effective
    console.log(`[manager] 插件 ${name} 已叠加会话层配置（基础层激活 + 会话层覆盖生效）`)
  }

  private async deactivateCore(name: string): Promise<void> {
    const managed = this.plugins.get(name)
    if (!managed?.active) return
    const error = await this.unloadPlugin(name, managed)
    if (error) console.error(`[manager] 插件 ${name} 卸载出错:`, error)
    if (this.lastEnabledName === name) {
      this.lastEnabledName = null
      this.lastEnabledAt = null
    }
    const idx = this.activationOrder.indexOf(name)
    if (idx >= 0) this.activationOrder.splice(idx, 1)
  }

  /**
   * 卸载统一出口（disable / enable 回滚 / disposeAll 共用）：
   * 优雅排空（§5.1）→ cordis dispose → 缓存清理钩子（§5.7）。
   * 卸载异常不在此抛出，而是返回给调用方决定处置（deactivateCore 记日志、disposeAll 聚合上抛）。
   */
  private async unloadPlugin(name: string, managed: ManagedPlugin): Promise<Error | null> {
    await this.drainBeforeUnload(name, managed)
    let error: Error | null = null
    if (managed.fiber) {
      try {
        await managed.fiber.dispose()
      } catch (err) {
        error = err as Error
      }
    }
    managed.fiber = null
    managed.active = false
    managed.layer = null
    await this.purgeCaches(name, managed)
    return error
  }

  /**
   * 卸载前优雅排空（架构 §5.1）：按插件 manifest 的 `runtime.drainTimeout`（秒，缺省 5）
   * 等待"处理器尚未结算"的在途 HTTP 请求完成；超时则记录告警后强制卸载。
   * `drainTimeout <= 0` 表示不等待（立即卸载）。
   *
   * 语义（与 HttpRouterService.drain 一致）：等待的是全站在途请求，
   * **不含发起本次卸载的那次管理请求本身**（REST 卸载由处理器内部调用，
   * 若把自己算进去就会等自己、必然空转满 drainTimeout）。
   * 按插件（owner）粒度排空属于后续工作。
   */
  private async drainBeforeUnload(name: string, managed: ManagedPlugin): Promise<void> {
    const { drainTimeout } = normalizeRuntime(managed.entry.manifest.geewiki.runtime)
    if (drainTimeout <= 0) return
    const router = this.ctx.get('http') as HttpRouterService | undefined
    if (!router) return
    // 以 pending() 为准（已排除发起本次卸载的管理请求自身）：为 0 → 零开销快路径，
    // 也保证"未真正等待就不打印耗时"这一日志语义是确定的（不依赖毫秒计时是否跨过边界）
    const waiting = router.pending()
    if (waiting === 0) return
    const startedAt = Date.now()
    const drained = await router.drain(drainTimeout * 1000)
    if (drained) {
      console.log(`[manager] 插件 ${name} 排空完成：耗时 ${Date.now() - startedAt}ms（等待 ${waiting} 个在途请求）`)
      return
    }
    console.warn(
      `[manager] 插件 ${name} 排空超时（${drainTimeout}s，仍有 ${router.pending()} 个在途请求未结算），强制卸载`,
    )
  }

  /**
   * 缓存清理钩子（架构 §5.7）：插件声明 `runtime.requiresCachePurge: true` 时，
   * 卸载完成后经 cordis 事件总线广播 {@link CACHE_PURGE_EVENT}（参数为插件名），
   * 由持有派生缓存（索引、渲染结果、资源表等）的插件或宿主监听后自行清理。
   *
   * 用 `ctx.parallel`（内部为 Promise.allSettled）而**不是** `ctx.emit`：cordis 的同步
   * `emit` 逐个调用监听器且无 per-listener 保护，任一监听器抛错会跳过其后的监听器，
   * 导致后续插件的缓存清理被静默丢失。失败者在此聚合记录，不影响其它插件与卸载结果。
   */
  private async purgeCaches(name: string, managed: ManagedPlugin): Promise<void> {
    const { requiresCachePurge } = normalizeRuntime(managed.entry.manifest.geewiki.runtime)
    if (!requiresCachePurge) return
    try {
      await this.ctx.parallel(CACHE_PURGE_EVENT, name)
    } catch (err) {
      console.error(`[manager] 插件 ${name} 缓存清理事件有监听器失败（其余监听器不受影响）:`, err)
    }
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
    const last = this.lastEnabledName ? this.plugins.get(this.lastEnabledName) : undefined
    const decision = decideWatchdog({
      consecutiveFailures: stats.consecutiveFailures,
      meltdownThreshold: this.config.meltdownThreshold,
      gracePeriodMs: this.config.gracePeriodMs,
      now: Date.now(),
      lastEnabledName: this.lastEnabledName,
      lastEnabledAt: this.lastEnabledAt,
      lastEnabledActive: last?.active === true,
      sessionNonEmpty: this.session.enabled.length > 0,
    })

    if (decision.action === 'rollback') {
      console.warn(
        `[manager:watchdog] 会话插件 ${decision.name} 试用期内（${this.config.gracePeriodMs}ms）健康探针失败，回滚该插件`,
      )
      this.disable(decision.name).catch((err) =>
        console.error(`[manager:watchdog] 回滚失败 ${decision.name}:`, err),
      )
      return
    }
    // 熔断：连续失败达阈值且存在会话层变更 → 清空会话 + 退出码 1（容器重启自愈回 Base）
    if (decision.action === 'meltdown') {
      console.error(
        `[manager:watchdog] 连续 ${stats.consecutiveFailures} 次健康探针失败且存在会话层变更，触发熔断：清空会话层并重启`,
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

  /**
   * 逆序卸载全部活动插件（管理器 dispose 时调用）；成功后清除崩溃标记（优雅退出）。
   * 与 deactivateCore 复用同一卸载出口：逐个优雅排空（§5.1）→ dispose → 缓存清理（§5.7）。
   */
  async disposeAll(): Promise<void> {
    this.stopWatchdog()
    const errors: string[] = []
    for (const name of [...this.activationOrder].reverse()) {
      const managed = this.plugins.get(name)
      if (!managed?.active) continue
      const error = await this.unloadPlugin(name, managed)
      if (error) errors.push(`${name}: ${error.message}`)
    }
    this.activationOrder.length = 0
    if (errors.length > 0) throw new Error(`卸载失败: ${errors.join('; ')}`)
    this.lastEnabledName = null
    this.lastEnabledAt = null
    if (this.config.crashMarkerFile) removeCrashMarker(this.config.crashMarkerFile)
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
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'payload_too_large'
          ? 413
          : err.code === 'replace_rollback_failed'
            ? 500 // 回滚也未成功：状态不确定，需人工介入（非客户端错误）
            : err.code === 'conflict_group' ||
              err.code === 'hot_reload_not_supported' ||
              err.code === 'hot_dependency_not_supported' ||
              err.code === 'provider_mismatch' || // 依赖边无法由目标承接：客户端可改依赖为 provides 后重试
              err.code === 'has_dependents' ||
              err.code === 'base_layer' ||
              err.code === 'hot_update_failed' ||
              err.code === 'migration_failed'
            ? 409
            : 400
    // 请求体超限：剩余请求体未消费，响应刷出后关闭连接（413 仍走统一出口，计入 stats）
    if (err.code === 'payload_too_large') closeAfterResponse(h)
    send(h, status, { ok: false, error: err.code, message: err.message, details: err.details })
    return
  }
  console.error('[manager:api] 未预期错误:', err)
  send(h, 500, { ok: false, error: 'internal', message: '服务器内部错误（详见服务端日志）' })
}

/** 挂载管理器 REST 路由（导出以便集成测试直接以路由服务替身驱动，无需真实 HTTP） */
export function registerRoutes(router: HttpRouterService, manager: GeeWikiManager): void {
  router.register('GET', '/api/plugins', (h) =>
    // issues：外部插件目录里被跳过的目录/清单（机器可读 code），前端与 CLI 据此提示"装了但没加载"
    ok(h, { plugins: manager.snapshot(), issues: manager.discoveryIssues() }),
  )
  router.register('GET', '/api/plugins/graph', (h) => ok(h, { graph: manager.graph() }))
  // 插件 UI 入口表（前端插槽用）：由注册表 × 激活集合 × 产物 stat 现算。
  // 注册位置说明：本路由是 3 段（/api/plugins/ui），与既有 GET /api/plugins/graph 同形；
  // 4 段路由（如 /api/plugins/:name/config）不受影响——某插件恰好叫 "ui" 时仅裸 3 段路径被占用。
  router.register('GET', '/api/plugins/ui', (h) => {
    try {
      const table = manager.uiTable()
      // 派生自活状态，绝不能被中间缓存当成静态文件：显式 no-store（HttpRouter.json 只在
      // 未发送响应头时 writeHead，会与这里的 setHeader 合并）。
      if (!h.res.headersSent) h.res.setHeader('cache-control', 'no-store')
      const etag = `"${table.revision}"`
      if (!h.res.headersSent) h.res.setHeader('etag', etag)
      // If-None-Match：刻意只做简化匹配——剥离可选 W/ 与前后引号后与当前 revision 全等比较，
      // 不做 RFC 7232 的列表/通配符解析（前端只会回传我们给出的那一个值）。
      const inm = h.req.headers['if-none-match']
      if (typeof inm === 'string' && stripEtagWeakness(inm) === table.revision) {
        h.json(304, null)
        return
      }
      ok(h, table)
    } catch (err) {
      fail(h, err)
    }
  })
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
  router.register('GET', '/api/plugins/:name/config', (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      ok(h, manager.configOf(name))
    } catch (err) {
      fail(h, err)
    }
  })
  router.register('PUT', '/api/plugins/:name/config', async (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      const body = await readJsonBody(h)
      if (!('config' in body)) throw new ManagerError('bad_request', '请求体缺少 config 字段')
      const result = await manager.updateConfig(name, body['config'])
      ok(h, result)
    } catch (err) {
      fail(h, err)
    }
  })
  router.register('POST', '/api/plugins/:name/replace', async (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      let body: { config?: Record<string, unknown> } = {}
      if (h.req.headers['content-length'] || h.req.headers['transfer-encoding']) {
        body = await readJsonBody(h)
      }
      const result = await manager.replace(name, body.config)
      ok(h, result)
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
  console.log(
    '[@geewiki/manager] REST API 已挂载: /api/plugins, /api/plugins/graph, /api/plugins/ui, /api/plugins/:name/config, /api/session',
  )
}

/**
 * 归一化 If-None-Match 的值用于比较：剥离可选的弱校验前缀 `W/` 与前后引号。
 * 只处理"单个 ETag"这一实际形态（见路由内注释），不做 RFC 7232 完整解析。
 */
function stripEtagWeakness(value: string): string {
  const trimmed = value.trim().replace(/^W\//, '')
  return trimmed.replace(/^"(.*)"$/, '$1')
}

/** 读取 enable 请求体 JSON（1MB 上限）：超限暂停读取剩余请求体并以 payload_too_large 拒绝，
 *  413 响应由路由层统一出口写出（fail → send，计入 stats/看门狗探针），随后关闭连接。 */
function readJsonBody(h: RouteHandlerContext, limit = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    h.req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        if (rejected) return // 已拒绝：忽略后续数据块
        rejected = true
        h.req.pause()
        rejectBody(new ManagerError('payload_too_large', `请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(c)
    })
    h.req.on('end', () => {
      if (rejected) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch (err) {
        rejectBody(new ManagerError('bad_request', `请求体 JSON 解析失败: ${(err as Error).message}`))
      }
    })
    h.req.on('error', (err) => {
      if (!rejected) rejectBody(err)
    })
  })
}
