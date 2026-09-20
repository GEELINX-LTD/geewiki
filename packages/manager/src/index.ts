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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from 'cordis'
import {
  CACHE_PURGE_EVENT,
  PLUGIN_ACTIVATED_EVENT,
  PLUGIN_DEACTIVATED_EVENT,
  asAsync,
  closeAfterResponse,
  SLOT_PROPS_SCHEMA,
  normalizeRuntime,
  type AnyDatabaseAdapter,
  type ConfigSchema,
  type FiberLike,
  type HttpRouterService,
  type PluginLifecycleEvent,
  type RouteHandlerContext,
  type SlotDeclaration,
  type SlotService,
  isPluginPermission,
  PLUGIN_PERMISSIONS,
  sortPermissions,
  type PluginPermission,
  type PluginHealthReport,
  type PluginHealth,
  DEFAULT_DATA_DIR,
  DEFAULT_DB_FILENAME,
  DEFAULT_LOCALE,
  isLocaleCode,
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
  resolveMigrationsDirs,
  resolvePluginEntry,
  scanPluginDirs,
  type DiscoveryIssue,
  type DiscoveryOptions,
  type DiscoveryResult,
  type MigrationsHooks,
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
import { SlotRegistry, resolveExtensions, resolveSlots, undeclaredSlots, type ExtNodeAssignment, type SlotAssignment } from './slots.js'
import {
  collectRouteDecls,
  effectiveRoutesByOwner,
  resolveRouteDecls,
  type ResolvedRoute,
  type RouteConflict,
} from './routes.js'
import {
  CapabilityRegistry,
  collectCapabilityDecls,
  resolveCapabilityDecls,
  unresolvedCapabilities,
  type CapabilityConflict,
  type ResolvedCapability,
} from './capabilities.js'
import { SLOT_SERVICE_NAME } from './slot-plugin.js'
import { CAPABILITY_SERVICE_NAME } from './capability-plugin.js'

export { SlotRegistry, resolveSlots, SLOT_SERVICE_NAME }
export type { SlotAssignment }
export { slotPlugin, type SlotPluginConfig } from './slot-plugin.js'
export { capabilityPlugin, type CapabilityPluginConfig } from './capability-plugin.js'
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
  secretFieldNames,
  validateConfig,
  type ConfigSchemaPayload,
} from './config-schema.js'
import { readSecretFile, setSecret, writeSecretFile, type SecretStore } from './secrets.js'
import { BACKUP_DIR_PREFIX, createBackup, describeBackup, readBackupManifest } from './backup.js'
import { verifyAllIntegrity, type IntegrityReport } from './plugin-install.js'
import {
  availableLocales,
  collectLocaleDecls,
  loadCatalogsFor,
  type CatalogIssue,
  type LocaleDecl,
  type ResolvedCatalogs,
} from './i18n.js'

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
  /**
   * 基础层清单路径（**本机** live 文件 `plugins.base.json`）。
   *
   * 它不是版本库里的文件（`.gitignore` 默认拒绝整个 `config/`）：保存一次配置就会重写它。
   * 随版本发布的默认值在同目录的 `plugins.base.example.json`，live 文件缺失时由
   * {@link readBaseList} 回退读它；写入永远只写这里。
   */
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
   * **密钥文件路径**（`role: 'secret'` 字段的落盘位置，见 `secrets.ts`）。
   *
   * 缺省 = 与基础层清单同目录的 `secrets.json`（即 `config/secrets.json`，已被 `.gitignore` 忽略）。
   * 组合根可显式指定（例如把配置目录与数据目录分开挂载时）。
   */
  secretsFile?: string
  /**
   * 外部插件发现阶段的问题（组合根 `buildRegistry` 扫描 plugins/ 得到）：
   * 只读透出到 `GET /api/plugins` 的 `issues` 字段，让"目录里躺着但没被加载"的插件可见。
   */
  discoveryIssues?: DiscoveryIssue[]
  /**
   * ★ F17：外部插件目录的绝对路径（用于**完整性校验**）。
   *
   * 为什么由组合根传进来、而不是管理器自己推：插件目录的解析规则（`options > GEEWIKI_PLUGINS_DIR >
   * 仓库根下 plugins/`）在组合根里已经有一份**唯一实现**，这里再推一次就是第二份判据。
   * 缺省 `undefined` ⇒ 完整性接口明确回"未配置"，而不是去猜一个目录然后报告"没有插件"。
   */
  pluginsDir?: string
  /**
   * **内置插件 UI 资产的兜底根**（绝对路径）：用于解析插件 UI 产物的**第二候选根**
   * `<本目录>/plugins-ui/<插件名>`（第一候选根是外部插件自带的 `<插件目录>/dist`）。
   * 仅影响 `GET /api/plugins/ui` 的入口表计算，与静态托管本身无关。null/缺省 = 只看插件自带产物。
   *
   * @deprecated 语义已收窄为"内置 UI 根"的兜底缺省值；新代码请用 `pluginUiDist`。
   *   两者曾共用一个配置项 `webDist`，导致"app shell 产物根"与"插件 UI 资产根"被过载：
   *   dev 为了让插件 UI 免构建可用而把 webDist 指向 `packages/web/public`，结果 app shell
   *   的 SPA fallback 找不到 `index.html` → 后端首页 404。
   */
  webDist?: string | null
  /**
   * 内置插件 UI 资产根（绝对路径，包含 `plugins-ui/<插件名>/` 的目录）。
   *
   * 与 `webDist` 分离是必要的：`webDist` 只指**前端产物根**（app shell 与 `/assets/*`），
   * 而插件 UI 资产可能有独立来源（dev 下即 `packages/web/public/plugins-ui/**`，无需前端构建）。
   * **缺省值 = `webDist`**，保证既有行为完全不变。
   */
  pluginUiDist?: string | null
}

/**
 * ★ F10：读取并**校验**一个插件的权限声明。
 *
 * 未知取值被**拒绝并告警**，而不是静默收下 —— 这一点是刻意的：静默接受任意字符串会让
 * `fs:raed`、`FS:read`、`filesystem` 这类拼写/命名错误**看起来像"已经声明过了"**，
 * 于是声明表里出现一堆永远不会被任何消费方认出的项，而作者以为自己做对了。
 * 与"能力名必须含 `/`"是同一类设计（把拼写错误变成可见的，而不是静默降级）。
 *
 * `undefined`（没写这个字段）是**合法**的：绝大多数插件不需要跨界能力，
 * 强制每个插件都写一个空数组只会制造噪声。它返回空数组，与"写了 []"同义。
 */
function readPluginPermissions(owner: string, raw: unknown): PluginPermission[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    console.warn(
      `[manager:permissions] 插件 ${owner} 的 geewiki.permissions 不是数组，已忽略；` +
        `合法取值：${PLUGIN_PERMISSIONS.join(', ')}`,
    )
    return []
  }
  const out: PluginPermission[] = []
  for (const v of raw) {
    if (typeof v === 'string' && isPluginPermission(v)) {
      if (!out.includes(v)) out.push(v)
      continue
    }
    console.warn(
      `[manager:permissions] 插件 ${owner} 声明了未知权限 ${JSON.stringify(v)}，已忽略；` +
        `合法取值：${PLUGIN_PERMISSIONS.join(', ')}`,
    )
  }
  // 按危险度升序输出：管理台与日志都直接用它，顺序即"从轻到重"
  return sortPermissions(out) as PluginPermission[]
}

export interface PluginSnapshot {
  name: string
  version: string
  /**
   * **面向人的短名称**（manifest `geewiki.displayName`）。缺失时管理台回退到 `name`（包名）。
   * 纯展示字段，不参与任何运行时判定。
   */
  displayName?: string
  /** **一句话说明**（manifest `geewiki.description`）；缺失时界面隐藏说明区域，勿用包名冒充 */
  description?: string
  state: 'active' | 'inactive' | 'error'
  layer: Layer | null
  /**
   * **进程内临时停用**（本批新增）：插件来自基础清单、但被管理台在当前进程内停掉了。
   *
   * 与"未启用"的区别只在**重启后会不会回来**：临时停用不写任何清单文件，正常重启
   * 仍按基础清单加载（用户口径："立即停止，若没有另行持久化，重启后仍启用"）；
   * 想让它永久消失，走"应用并持久化"（会把条目从基础清单里删掉）。
   *
   * `state` 保持 `inactive` 不变（它描述的是运行态），本字段才是"为什么没在跑"。
   */
  runtimeDisabled: boolean
  hotReloadable: boolean
  provides?: string
  requires: string[]
  conflictGroup?: string
  /** 迁移目录声明（string = 各方言通用；对象 = 按方言，与 GeeWikiMeta.migrations 同形） */
  migrations?: string | { default?: string; postgres?: string }
  config?: Record<string, unknown>
  error?: string
  /** 来源：内置（组合根登记）/ 外部（plugins/ 目录发现） */
  source: 'builtin' | 'external'
  /** 是否声明了 schemastery configSchema（管理台据此决定渲染表单还是 JSON 编辑框） */
  configurable: boolean
  /**
   * ★ F10：插件声明的**跨界能力**（文件系统 / 环境变量 / 外网 / 进程 / 密钥）。
   *
   * 恒为数组（可能为空）：管理台据此渲染"装它之前该知道什么"。宿主**不做强制**
   * （同进程同权限），所以这里是**信息**而不是**闸门** —— 但它必须能被执行到，
   * 否则声明就只是源码里的注释（见 `readPluginPermissions` 的未知项告警）。
   */
  permissions: PluginPermission[]
}

export interface PluginGraphNode {
  id: string
  label: string
  layer: Layer | null
  state: 'active' | 'inactive' | 'error'
  /** 进程内临时停用（见 {@link PluginSnapshot.runtimeDisabled}）；依赖图据此上第三种颜色 */
  runtimeDisabled: boolean
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

/**
 * 构造插件生命周期事件的负载（F7）。
 *
 * 抽成纯函数是为了让两个发射点（激活 / 停用）**共用同一份字段逻辑**；
 * 但 `ctx.emit(常量, …)` 那一步刻意留在各自的调用点——见 {@link GeeWikiManager.emitPluginActivated}
 * 的说明（抽掉会让 `platformEvents.test.ts` 的"每个事件都有发射点"守卫失去作用）。
 */
function pluginLifecyclePayload(
  name: string,
  entry: RegisteredPlugin,
  error?: string,
): PluginLifecycleEvent {
  return {
    name,
    /*
     * 清单里 `provides` 是**单个字符串**（一个插件最多声明一个能力 token），
     * 而事件契约上统一成数组：订阅者判"我要的那个服务来了没有"时用 `includes`，
     * 比 `===` 更不容易在将来（若放宽为多个 token）写错。
     */
    provides: entry.manifest.geewiki.provides === undefined ? [] : [entry.manifest.geewiki.provides],
    ...(error === undefined ? {} : { error }),
  }
}

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

/**
 * 随版本发布的默认清单的文件名：`plugins.base.json` → `plugins.base.example.json`。
 *
 * ## 为什么基础层要有"example + live"两份，而会话层只有一份
 * `plugins.base.json` 是**运行期可写**文件：在管理台保存一次插件配置就会重写它。它一旦入库，
 * 后果有两个，都不是理论上的：① 每个人的本机设置（模型端点、开关、超时）会以"改动"的形式
 * 出现在别人的 `git status` 里，并随时可能被 `git add -A` 提交；② "随版本发布的默认启用清单"
 * 与"我这台机器的现状"变成同一个文件，升级时无法区分该保留谁的。
 *
 * 但默认清单本身**必须**随版本发布：缺了它，未挂载 `config/` 的容器会读到「空清单」→
 * 没有任何插件被激活 → HTTP 不监听 → 进程退出码 0 结束被反复拉起（挂载场景的静默重启循环，
 * 已实测）。所以拆成两份：
 *   - `plugins.base.example.json`：**入库、只读**，随版本发布的默认值；
 *   - `plugins.base.json`：**不入库、可写**，本机现状（首次写入时生成）。
 * live 文件缺失时读 example（虚拟下发默认值，**不在启动时偷偷写盘**——启动写盘会在只读挂载的
 * 部署上直接变成启动失败）；写入永远只写 live 文件，example 不会被进程改写。
 *
 * ## 为什么用文件名派生，而不是给 `ManagerConfig` 加一个字段
 * `ManagerConfig` 的构造点遍布测试与宿主；加一个必填字段等于要求每个构造点都知道这条约定，
 * 而派生让"同目录、同主名、不同后缀"成为唯一口径（守卫测试见 `test/base-manifest.test.ts`）。
 */
export function exampleManifestPathOf(liveFile: string): string | null {
  return liveFile.endsWith('.json') ? `${liveFile.slice(0, -'.json'.length)}.example.json` : null
}

/** 读取**基础层**清单：live 文件不存在时回退到随版本发布的默认值模板（见 {@link exampleManifestPathOf}） */
function readBaseList(liveFile: string): PluginListFile {
  if (existsSync(liveFile)) return readList(liveFile)
  const example = exampleManifestPathOf(liveFile)
  if (example !== null && existsSync(example)) {
    console.log(
      `[manager] 未找到 ${basename(liveFile)}：按随版本发布的默认值 ${basename(example)} 装配` +
        '（本机清单会在首次保存配置/启用插件时生成）',
    )
    return readList(example)
  }
  return readList(liveFile)
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
  private readonly config: Required<Omit<ManagerConfig, 'registry' | 'crashMarkerFile' | 'pluginsDir'>> & {
    registry: RegisteredPlugin[]
    crashMarkerFile?: string
    /**
     * ★ F17：外部插件目录。`null` = 未配置 —— 完整性校验据此**明确回"未配置"**，
     * 而不是猜一个目录然后报告"没有插件"（那会让"没装插件"与"看错地方了"长得一模一样）。
     * `Required<>` 会把可选字段变成 `string`，故与 `crashMarkerFile` 一样在此显式放宽。
     */
    pluginsDir: string | null
  }
  private readonly plugins = new Map<string, ManagedPlugin>()
  /** 激活顺序（dispose 时逆序卸载） */
  private readonly activationOrder: string[] = []
  /**
   * 插槽贡献注册表。
   *
   * **正常路径**下这是 `@geewiki/slot` 插件经 `ctx.provide('slot', …)` 暴露的实例
   * （见 `slot-plugin.ts` 的文件头：为什么提供者必须是独立且排在管理器之前的插件）。
   * 构造时若服务不可见，则**自建一份**并仅供管理器自用——这是为"管理器被单独使用"
   * （单测、嵌入其它宿主）留的兜底。代价是**此时运行期 `contribute()` 对子插件不可见**
   * （同一可见性规则），只有 manifest 声明式贡献有效；服务器组合根走的是正常路径，
   * 端到端已覆盖。兜底的存在是为了不把"没装 slot 插件"变成管理器无法启动。
   */
  private readonly slots: SlotRegistry
  /**
   * ★ F9 能力注册表。
   *
   * 与 `slots` 同样是"**优先用独立兄弟插件已暴露的那一份**（唯一真源），拿不到则自建兜底"。
   *
   * ⚠️ 这里**不能**写成 `ctx.provide('capability-service', …)`：实测证明，
   * 在管理器的 `apply` 里 provide 的服务，对它 boot 出来的子插件**不可见**（`ctx.get`
   * 返回 `undefined` 且静默），于是每个插件的能力注册都会被悄悄跳过 ——
   * 表现是一道永远 403 的闸门和一份干净得可疑的日志。提供者必须是排在管理器之前的
   * 独立插件（见 `capability-plugin.ts` 文件头，与 `slot-plugin.ts` 同一结论）。
   */
  private readonly capabilities: CapabilityRegistry
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

  /**
   * **进程内临时停用的插件名**（本批新增）：基础清单里的插件被管理台就地停掉时登记在这里。
   *
   * 三条不变量，缺一条这个功能就会变成"静默改配置"：
   *   1. **不落盘**——任何清单文件都不写它，故正常重启后插件照基础清单回来（这正是"临时"）；
   *   2. **激活即清除**——清除点放在 {@link activateCore} 成功处而不是 enable() 里，
   *      这样 boot / enable / 递归拉依赖 / 冲突组替换 全都自动覆盖，不会留下"既在跑又被标记停用"；
   *   3. **持久化即删除**——{@link persistSession} 把条目从基础清单移除后才清空登记，
   *      于是"应用并持久化"之后重启也不会再加载它。
   */
  private readonly runtimeDisabled = new Set<string>()

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
      pluginsDir: config.pluginsDir ?? null,
      webDist: config.webDist ?? null,
      // 内置插件 UI 根：缺省回落 webDist（与拆分前行为一致）
      pluginUiDist: config.pluginUiDist ?? config.webDist ?? null,
      // 密钥文件：缺省与基础层清单同目录（config/secrets.json，已被 .gitignore 忽略）
      secretsFile: config.secretsFile ?? join(dirname(config.baseFile), 'secrets.json'),
    }
    // 插槽注册表：优先用 `@geewiki/slot` 已暴露的那一份（唯一真源）；
    // 拿不到则自建兜底（见字段注释——此时只有 manifest 声明式贡献可用）。
    const provided = ctx.get(SLOT_SERVICE_NAME) as SlotRegistry | undefined
    this.slots = provided ?? new SlotRegistry()
    // 同 `slots`：优先用 `@geewiki/capability` 已暴露的那一份，拿不到则自建兜底
    this.capabilities = (ctx.get(CAPABILITY_SERVICE_NAME) as CapabilityRegistry | undefined) ?? new CapabilityRegistry()
  }

  /* ------------------------- 查询（供 REST） ------------------------- */

  /**
   * ★ F20：产出一个备份 —— `data/` + `config/` 的**一致性**快照。
   *
   * ## 为什么数据库必须走 `VACUUM INTO`，而不是拷文件
   * 默认后端是 SQLite 且开着 WAL：运行中的库由「主文件 + `-wal` + `-shm`」共同构成，
   * 朴素拷贝会得到**撕裂快照**（cp 期间还有提交在写），或者把旧的 `-wal` 一起带走、
   * 让 SQLite 下次打开时**重放不属于该快照的帧**。
   * `VACUUM INTO` 由引擎自己保证一致性、对运行中的库安全，且产出**自包含、不带边车**
   * （实测：源目录有 `s.db`/`s.db-wal`/`s.db-shm`，快照只有一个 `snap.db`）。
   *
   * ## 为什么快照能力是注入的
   * pnpm 严格隔离下 `better-sqlite3` 只从 `@geewiki/db-sqlite` 可解析，管理器 import 不到；
   * 而管理器**已经**握着 `db` 服务，`db.run('VACUUM INTO ?', [dest])` 实测可用（带绑定参数）。
   * 于是备份**不需要任何新依赖**，也不需要放宽包边界。
   *
   * ## 非 SQLite 部署：如实说"没包含"，而不是假装完整
   * PG 部署下不产出数据库文件，清单里 `database.included=false` 并写明要改用 `pg_dump`。
   * 一个"看起来完整、恢复后缺数据"的备份，比一个明说不含数据库的备份危险得多。
   */
  async createBackup(
    opts: { outDir?: string; repoRoot?: string; now?: Date } = {},
  ): Promise<import('./backup.js').BackupReport> {
    const repoRoot = resolve(opts.repoRoot ?? process.cwd())
    const outDir = opts.outDir ?? process.env['GEEWIKI_BACKUP_DIR'] ?? join(repoRoot, 'backups')
    // 迁移控制器处已有同款取法（`this.ctx.get('db') as AnyDatabaseAdapter | undefined`）
    const db = this.ctx.get('db') as AnyDatabaseAdapter | undefined
    const dialect = db?.dialect ?? 'sqlite'
    const snapshot = opts.now === undefined ? {} : { now: opts.now }
    const databaseRelPath = join(DEFAULT_DATA_DIR, DEFAULT_DB_FILENAME)
    if (db !== undefined && dialect === 'sqlite') {
      return createBackup({
        repoRoot,
        outDir,
        databaseRelPath,
        ...snapshot,
        snapshotDatabase: async (dest: string) => {
          // 目标文件必须不存在：`VACUUM INTO` 拒绝覆盖已存在的文件（这正好是我们的意图）
          db.run('VACUUM INTO ?', [dest])
        },
      })
    }
    return createBackup({
      repoRoot,
      outDir,
      databaseRelPath,
      ...snapshot,
      databaseNote:
        db === undefined
          ? '本快照不含数据库：当前没有可用的 db 服务（未激活数据库插件？）。'
          : `本快照不含数据库：当前后端方言是 ${dialect}，它不是 SQLite。` +
            'PostgreSQL 部署请在该库上用 pg_dump 单独备份 —— 本命令不冒充它。',
    })
  }

  /** 已存在的备份目录（按时间倒序），供 REST/CLI 展示 */
  listBackups(opts: { outDir?: string; repoRoot?: string } = {}): {
    dir: string
    createdAt: string
    files: number
    bytes: number
    databaseIncluded: boolean
  }[] {
    const repoRoot = resolve(opts.repoRoot ?? process.cwd())
    const outDir = opts.outDir ?? process.env['GEEWIKI_BACKUP_DIR'] ?? join(repoRoot, 'backups')
    if (!existsSync(outDir)) return []
    const out: ReturnType<GeeWikiManager['listBackups']> = []
    for (const name of readdirSync(outDir)) {
      if (!name.startsWith(BACKUP_DIR_PREFIX)) continue
      const dir = join(outDir, name)
      // 单个坏清单不能让整个列表 500：跳过并在下面靠"列表里没有它"体现出来
      let manifest: ReturnType<typeof readBackupManifest>
      try {
        manifest = readBackupManifest(dir)
      } catch {
        continue
      }
      out.push({
        dir,
        createdAt: manifest.createdAt,
        files: manifest.files.length,
        bytes: manifest.files.reduce((s, f) => s + f.bytes, 0),
        databaseIncluded: manifest.database.included,
      })
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * ★ F12：**插件健康探针**的聚合（可被 REST 请求触发）。
   *
   * ## 三条判据都是刻意的
   * 1. **只探测 `active` 的插件**：未激活的插件没有"健康"可言（`state` 字段已经说明
   *    一切），去调它的探针会把"没在跑"报成"坏了"。
   * 2. **超时由宿主强制**（缺省 2s）：探针是插件代码，一个 `await` 卡死的探针会让
   *    健康端点整体挂住 —— 于是"某个插件不健康"升级成"健康检查不可用"，
   *    而后者恰恰是运维最需要它的时候。超时结论放 `timedOut`，**不**混进 `ok:false`。
   * 3. **`ok:false` 与 `error` 严格分开**：前者是"插件说它坏了"（要去看它的 `detail`），
   *    后者是"我们没能问到它"（要去看宿主日志）。混在一起会让运维做错方向的动作。
   *
   * 探针**缺失不是不健康**：绝大多数插件没有可探测的状态，`health` 字段留空即可。
   * 把"没探针"报成 `ok:true` 是撒谎（我们并没有验证过），报成 `ok:false` 是误报。
   */
  async pluginHealth(timeoutMs = 2000): Promise<PluginHealthReport[]> {
    const reports: PluginHealthReport[] = []
    for (const entry of this.config.registry) {
      const name = entry.name
      const p = this.plugins.get(name)
      const state: PluginHealthReport['state'] = p?.active ? 'active' : p?.error ? 'error' : 'inactive'
      const probe = entry.module.health
      if (state !== 'active' || typeof probe !== 'function') {
        reports.push({ name, state })
        continue
      }
      const started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => probe()),
          new Promise<'__timeout__'>((resolve) => {
            /*
             * ⚠️ 这个定时器**必须**保持被引用状态 —— 不加 `unref()`。
             *
             * 加过的后果实测过：`unref()` 让定时器不再阻止事件循环退出，于是在
             * "除了这个探针没有别的待处理工作"的场景（单测、空闲实例）下，事件循环
             * 直接结束、定时器永远不触发 ⇒ `Promise.race` **永不 settle** ⇒
             * 健康端点挂住，而且现象是"测试进程报 Promise 一直 pending"这种极难定位的形态。
             * 换句话说：超时保护本身不能依赖任何外部工作来驱动。
             */
            timer = setTimeout(() => resolve('__timeout__'), timeoutMs)
          }),
        ])
        const durationMs = Date.now() - started
        if (result === '__timeout__') {
          reports.push({ name, state, timedOut: true, durationMs })
          continue
        }
        /*
         * ★ **形态校验**：探针返回的东西必须是 `{ ok: boolean, ... }`。
         *
         * 这是本设施唯一会骗人的地方：把"没看懂"当成"没问题"。一个返回 `undefined`
         * 或 `{}` 的探针（写错了、忘了 return、被 TS 的 any 放过去）如果不校验，
         * 就会以"有 health 字段"的形态出现在报告里，消费方很容易把它读成健康。
         * 这里报 `error`，与"插件自报 ok:false"和"超时"三者互不混淆。
         */
        if (typeof result !== 'object' || result === null || typeof (result as PluginHealth).ok !== 'boolean') {
          reports.push({
            name,
            state,
            error: `探针返回值形态非法（应为 { ok: boolean }，实际 ${JSON.stringify(result) ?? String(result)}）`,
            durationMs,
          })
          continue
        }
        reports.push({ name, state, health: result, durationMs })
      } catch (err) {
        reports.push({
          name,
          state,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    return reports
  }

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
      // 这里喂给纯函数的是"内置插件 UI 资产根"（= pluginUiDist ?? webDist，已在构造函数解析）。
      // 纯函数里那个形参仍叫 webDist 是历史命名，语义就是"第二候选根的内置根"。
      webDist: this.config.pluginUiDist,
      statFile: statFileSync,
      slotAssignments: this.slotAssignments(),
      /*
        P12：扩展点裁决也要进入口表（`extNodes` 字段）。前端拿它做越权闸门——
        "声明了但被抑制"与"根本没声明"必须区分开，否则被抑制的 replace 仍会注册，
        而 `Ext` 按注册顺序取第一个 ⇒ 可能渲染出后端判为被抑制的那一个。
        只下发插槽（`slots`）覆盖不到 `ui-*` / `shell-*` / `page` 这些节点。
      */
      extAssignments: this.extNodeAssignments(),
      // F2：路由声明必须进入口表 —— 它是"要不要推迟加载该插件产物"的判据之一
      // （只贡献按需插槽 + 一个页面的插件若被推迟，点导航项会看到空白页且不报错）。
      routesByOwner: effectiveRoutesByOwner(this.routeResolution().routes),
    })
  }

  /**
   * 插件页面路由的**声明裁决**（F2）。
   *
   * 与 {@link slotAssignments} 同一条教训：裁决只做一次、所有消费方读同一份结果。
   * 入口表、REST 诊断、（未来）服务端渲染都走这里；各处自行判一遍必然走向
   * "表里说 A 生效、界面渲染 B"。
   */
  routeResolution(): { routes: ResolvedRoute[]; conflicts: RouteConflict[] } {
    return resolveRouteDecls(collectRouteDecls(this.config.registry), this.activationOrder)
  }

  /**
   * 插槽裁决结果（`resolveSlots` 的产物）。
   *
   * 公开它是为了让它成为**唯一**的裁决入口：入口表、未来的前端、REST 诊断
   * （`GET /api/plugins/slots`）都必须读同一份结果。
   * 若各处各自按 `list()` 重新判一遍基数，就会出现"表里说 A 生效、界面渲染 B"这种
   * 极难排查的分裂——与 `resolvePluginUiHit` 的"唯一判定"是同一条教训。
   */
  slotAssignments(): SlotAssignment[] {
    /*
     * 必须把**声明表**一起传进去（A1）：插件自定义扩展点的基数不是从名字推出来的，
     * 只在 `declarations()` 里。漏传的后果很隐蔽——`single` 声明被当成默认 `multi`，
     * 于是一个本该"最早激活者胜出"的扩展点会同时渲染两个贡献者，且**不报任何冲突**
     * （因为裁决时压根不知道它是单占用）。
     */
    return resolveSlots(this.slots.list(), this.activationOrder, this.slots.declarations())
  }

  /**
   * **模式化**的扩展裁决结果（`resolveExtensions` 的产物，界面扩展平台 P3）。
   *
   * 与 {@link slotAssignments} 的关系：后者是"只有追加语义"的旧视图（形状是已发布契约，
   * 入口表与既有诊断都在读它），本方法返回同一份裁决**加上模式信息**。
   * 两者由同一个纯函数产出（`resolveSlots` 只是它的投影），因此不存在"两套裁决"。
   */
  extNodeAssignments(): ExtNodeAssignment[] {
    return resolveExtensions(this.slots.list(), this.activationOrder, this.slots.declarations())
  }

  /**
   * 插件自定义扩展点的**声明**表（`slot.define()` 的产物；A1 起可由插件自行开放扩展点）。
   *
   * 与 {@link slotAssignments} 分开暴露的原因：这张表回答"**谁开了哪些扩展点**"，
   * 而裁决结果回答"**每个扩展点谁生效**"。管理台/排障两者都要，且受众不同。
   */
  slotDeclarations(): readonly (SlotDeclaration & { readonly slot: string })[] {
    return this.slots.declarations()
  }

  /**
   * 插槽注册表实例（诊断与测试用）。
   *
   * 注意它**不负责 provide**：服务的提供者是 `@geewiki/slot` 插件
   * （见 `slot-plugin.ts` 的文件头，那里记录了"管理器自己 provide 会失效"的实测结论）。
   */
  slotService(): SlotService {
    return this.slots
  }

  /**
   * ★ F9：能力声明的裁决结果（`resolveCapabilityDecls` 的产物）。
   *
   * 与 `routeResolution()` 同构：**从活状态现算**，不做快照——插件激活/停用会改变
   * 激活顺序，而"同名能力谁生效"正是由激活顺序裁决的。
   */
  capabilityResolution(): { capabilities: ResolvedCapability[]; conflicts: CapabilityConflict[] } {
    return resolveCapabilityDecls(collectCapabilityDecls(this.config.registry), this.activationOrder)
  }

  /** ★ F9：能力注册表实例（manager 持有并 `ctx.provide('capability-service')`） */
  capabilityService(): CapabilityRegistry {
    return this.capabilities
  }

  private snapshotOf(name: string): PluginSnapshot {
    const entry = this.config.registry.find((p) => p.name === name)
    if (!entry) throw new ManagerError('not_found', `未知插件: ${name}`)
    const p = this.plugins.get(name)
    const m = entry.manifest
    return {
      name,
      version: m.version,
      // 面向人的展示字段：直接透传，缺失即 undefined（管理台自行回退到包名/隐藏说明）
      displayName: m.geewiki.displayName,
      description: m.geewiki.description,
      state: p?.active ? 'active' : p?.error ? 'error' : 'inactive',
      layer: p?.layer ?? null,
      runtimeDisabled: this.runtimeDisabled.has(name),
      hotReloadable: m.geewiki.runtime?.supportsHotReload === true,
      provides: m.geewiki.provides,
      requires: directDependencies(this.config.registry, name),
      conflictGroup: m.geewiki.conflictGroup,
      migrations: m.geewiki.migrations,
      config: p?.config,
      error: p?.error ?? undefined,
      source: entry.source ?? 'builtin',
      configurable: this.configSchemaOf(entry) !== undefined,
      permissions: readPluginPermissions(name, m.geewiki.permissions),
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
        runtimeDisabled: this.runtimeDisabled.has(entry.name),
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

  /**
   * ★ F15：插件**文案目录声明**（惰性缓存）。
   *
   * 缓存的是"哪个插件声明了哪个语言的哪个文件"（注册表在启动后基本不变），
   * 而**文件内容每次现读**：译文是可以热改的，缓存内容会让"改了译文但界面不变"
   * 表现为一个需要重启的谜题。
   */
  private localeDeclsCache?: { decls: LocaleDecl[]; issues: CatalogIssue[] }

  private localeDecls(): { decls: LocaleDecl[]; issues: CatalogIssue[] } {
    this.localeDeclsCache ??= collectLocaleDecls(this.config.registry)
    return this.localeDeclsCache
  }

  /** ★ F15：可选语言集合与默认语言（供前端初始化与语言切换器） */
  i18nAvailable(): { default: string; locales: string[]; issues: CatalogIssue[] } {
    const { decls, issues } = this.localeDecls()
    return { default: DEFAULT_LOCALE, locales: availableLocales(decls), issues }
  }

  /**
   * ★ F15：某个语言下应当下发的插件文案。
   *
   * 返回**整条回退链**的 catalog（见 `manager/src/i18n.ts` 的解释）：
   * 回退逻辑只在 core 的 `fallbackChain` 里实现一次，前端不重复一份。
   */
  i18nCatalogs(locale: string): ResolvedCatalogs & { declIssues: CatalogIssue[] } {
    const { decls, issues } = this.localeDecls()
    return { ...loadCatalogsFor(decls, locale), declIssues: issues }
  }

  /**
   * ★ F17：**外部插件完整性体检**（相对各自的安装基线）。
   *
   * 刻意不做进 `snapshot()`：那是一个会被前端高频轮询的端点（插件探测、UI 入口表都读它），
   * 而完整性校验要对每个插件的每个文件算 sha256 —— 放进热路径等于给每次轮询加一次全量磁盘读。
   * 校验是**按需**动作，故走独立的 admin 端点/CLI。
   *
   * 未配置 `pluginsDir` 时返回 `[]` 并附带说明，**不猜目录**：猜错会让"没有插件"与
   * "看错地方了"这两种完全不同的情况长得一模一样。
   */
  verifyPluginIntegrity(): { pluginsDir: string | null; reports: IntegrityReport[]; note?: string } {
    const dir = this.config.pluginsDir
    if (dir === null) {
      return {
        pluginsDir: null,
        reports: [],
        note: '未配置插件目录（pluginsDir）：无法校验。请在组合根传入，或设置 GEEWIKI_PLUGINS_DIR。',
      }
    }
    return { pluginsDir: dir, reports: verifyAllIntegrity(dir) }
  }

  /** 双层清单内容（含启动时各插件的激活错误） */
  sessionState(): {
    base: PluginListFile
    session: PluginListFile
    bootErrors: string[]
    /** 进程内临时停用的插件名（重启即恢复；顺序按登记先后，便于界面上排） */
    runtimeDisabled: string[]
  } {
    return {
      base: this.base,
      session: this.session,
      bootErrors: this.bootErrors,
      runtimeDisabled: [...this.runtimeDisabled],
    }
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
    /**
     * 声明为 `role: 'secret'` 的字段**是否已有值**（只报有无，绝不返回值）。
     *
     * `config` 里对应的字段恒为空串：这是"保存后不再回显"的落点 ——
     * 管理台据此把输入框显示为「已配置（留空表示不修改）」，用户要改只能填一个新值。
     */
    secrets: Record<string, boolean>
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
      secrets: this.secretPresenceOf(name),
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
    opts: {
      /**
       * 要**显式清除**的密钥字段（§ `role: 'secret'`）。
       *
       * 单独开一个口子而不是用"空串 = 清除"：表单回显的密钥恒为空串，
       * 若把它当清除，用户每改一次别的字段就会顺手删掉密钥。
       */
      clearSecrets?: readonly string[]
    } = {},
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

    // 密钥：值写进密钥文件，配置里**不留**该字段（见 absorbSecrets / hydrateSecrets）
    config = this.absorbSecrets(name, config, opts.clearSecrets ?? [])

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
      await fiber.update(this.hydrateSecrets(name, config))
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
        await fiber.update(this.hydrateSecrets(name, previous ?? {}))
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

  /**
   * 插件在清单中的落盘位置（= 配置的**写入**目标层）：session 优先（会话层变更不应污染基础层），否则 base。
   *
   * ⚠️ **本方法不是激活层判据**：它只回答"会话清单里有没有该插件的条目"，而"有条目"≠"以会话层激活"。
   * 真实激活层请用 `this.plugins.get(name)?.layer`（`disable()` 与 `replace()` 的守卫用的都是它）。
   * 两者在"同一插件同时出现在基础层与会话层清单"的叠加态下**结论相反**：本方法返回 `'session'`，
   * 而插件实际以 base 层激活（叠加语义见 `applySessionOverlay`）。
   *
   * 反面教材：`replace()` 曾用本方法判"被顶替的旧插件是否在会话层"，于是上述叠加态下**冷插件被热替换**，
   * 且旧插件仍留在基础层清单里 → 重启后每次启动都撞冲突组互斥（已改用真实激活层）。
   * 现存消费点只有配置写入（`updateConfig()` → `persistConfig()`）；新增调用前请先确认语义。
   */
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

  /* ------------------------- 写一次、不可回读的密钥 ------------------------- */

  /**
   * 该插件声明的密钥字段名（schema `role: 'secret'`）。无 schema / 无该角色 → 空数组，
   * 调用方据此走"零开销的原路径"（不读密钥文件、不做任何拷贝）。
   */
  private secretFieldsOf(name: string): string[] {
    const entry = this.config.registry.find((p) => p.name === name)
    if (!entry) return []
    const schema = this.configSchemaOf(entry)
    if (!schema) return []
    return secretFieldNames(schema)
  }

  /**
   * **吸收**入参里的密钥值并返回"可入库的配置"（密钥字段已被摘掉）。
   *
   * 三条语义（与前端表单的文案一一对应）：
   * - 字段是**非空字符串** → 写进密钥文件（替换旧值）；
   * - 字段是**空/缺失** → 不修改（保留文件里的旧值）——这是"保存后不再回显"的必然结果：
   *   表单拿到的就是空串，若把它当成"清除"，那么每次改其它字段都会顺手删掉密钥；
   * - 字段名出现在 `clear` 里 → 清除（显式动作，与"留空"区分开）。
   *
   * 返回值**必须**用于落盘（`persistConfig`）——密钥值绝不能出现在 `plugins.*.json` 里。
   */
  private absorbSecrets(name: string, config: Record<string, unknown>, clear: readonly string[]): Record<string, unknown> {
    const fields = this.secretFieldsOf(name)
    if (fields.length === 0) return config
    const out: Record<string, unknown> = { ...config }
    const file = this.config.secretsFile
    const store: SecretStore = readSecretFile(file)
    let dirty = false
    for (const field of fields) {
      const incoming = out[field]
      delete out[field] // 无论何种情况都不入库：密钥只存在于密钥文件与"交给插件的那一份"
      if (clear.includes(field)) {
        if (setSecret(store, name, field, null)) dirty = true
        continue
      }
      if (typeof incoming === 'string' && incoming.trim() !== '') {
        if (setSecret(store, name, field, incoming)) dirty = true
      }
    }
    if (dirty) writeSecretFile(file, store)
    return out
  }

  /**
   * 把密钥文件里的值**填回**交给插件的那一份配置（只在 `ctx.plugin` / `fiber.update`
   * 的边界上调用）。
   *
   * 为什么不让密钥一直待在 `managed.config` 里：那份对象会被 `addToSession` /
   * `persistSession` / `snapshotOf` 反复消费，只要有一处漏了脱敏就会写进入库文件。
   * 让它在**内存记录里根本不存在**，是唯一不需要靠"记得脱敏"来保证的形态。
   */
  private hydrateSecrets(name: string, config: Record<string, unknown>): Record<string, unknown> {
    const fields = this.secretFieldsOf(name)
    if (fields.length === 0) return config
    const stored = readSecretFile(this.config.secretsFile)[name]
    if (!stored) return config
    let out = config
    for (const field of fields) {
      const value = stored[field]
      if (value === undefined) continue
      if (out === config) out = { ...config }
      out[field] = value
    }
    return out
  }

  /** 哪些密钥字段已有值（**只报有无，不报值**；`GET /config` 用它驱动"已配置"提示） */
  private secretPresenceOf(name: string): Record<string, boolean> {
    const fields = this.secretFieldsOf(name)
    if (fields.length === 0) return {}
    const stored = readSecretFile(this.config.secretsFile)[name] ?? {}
    const out: Record<string, boolean> = {}
    for (const field of fields) out[field] = (stored[field] ?? '') !== ''
    return out
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
      this.base = readBaseList(this.config.baseFile)
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
    /*
     * "恢复"与"新启用"必须分开，而且**判定要放在热插拔守卫之前**：
     *   · 被**临时停用**的基础层插件仍在基础清单里，重新启用它是"回到本进程本来就有的状态"，
     *     不是热插拔——所以不该被 `hot_reload_not_supported` 挡住。
     *   · 反例（沙箱实测）：`@geewiki/org` 不支持热插拔，但**没有活跃依赖方**，于是能被临时停用，
     *     却启不回来 ⇒ "停了只能重启才能起来"，把临时停用变成了单向陷阱。
     *   · 该守卫原本要防的是"把一个从未在本进程跑过的冷插件热装上来"，恢复路径不属此列。
     * 判据用登记 + 基础清单条目双重确认：登记本身就意味着该插件来自基础清单。
     */
    const restoringBase = this.runtimeDisabled.has(name) && this.base.enabled.some((e) => e.name === name)
    if (!restoringBase && m.runtime?.supportsHotReload !== true) {
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
    /*
     * 依赖链守卫同理：它要拒的是"热启用时链上有冷依赖"，而恢复链上的冷依赖**本身也是恢复**
     * （同样在基础清单里、同样只是被临时停掉），由递归帧各自判定——真正不可恢复的冷依赖
     * 会在那一帧的上面那条守卫里被拒（`restoringBase` 为 false），保护并未失效。
     */
    if (!restoringBase) {
      const violations = checkHotChain(this.config.registry, this.activeNames(), name)
      if (violations.length > 0) {
        throw new ManagerError(
          'hot_dependency_not_supported',
          `依赖链中存在不支持热加载的未激活依赖: ${violations.join('; ')}`,
          { path: violations },
        )
      }
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
    await this.activateCore(name, effectiveConfig, restoringBase ? 'base' : 'session')
    // 自登记：激活成功的那一帧自己记账（目标自身激活失败时不登记）
    activated.push(name)
    this.lastEnabledName = name
    this.lastEnabledAt = Date.now()
    // 落盘用"生效配置"（activateCore 已按 schema 填默认值/裁剪未知字段）。
    // 恢复基础层插件不落盘：它的条目本来就在基础清单里，写入会话层等于复制一份
    //（那会造出"基础层 + 会话层同名条目"的叠加态，并把层降级成 session、界面显示成"临时启用"）。
    if (!restoringBase) this.addToSession(name, this.plugins.get(name)?.config ?? effectiveConfig)
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
  /**
   * 停用插件（支持两种层，重启后的命运不同）：
   *
   *   · **会话层**（本来就不是随启动加载的）：卸载 + 从会话清单移除。重启后仍不会加载，
   *     因为它从来不在基础清单里——这不需要额外登记。
   *   · **基础层**（随启动加载）：卸载 + 记入 {@link runtimeDisabled}（**不写任何文件**）。
   *     重启后照基础清单回来，这就是用户要的"临时停用"。想永久停用走"应用并持久化"。
   *
   * 两者共用同一条依赖方守卫：有活跃依赖方就拒绝（否则会把别人一起弄坏）。守卫在两种层
   * 上都必须先于卸载执行——先卸了再报错就已经把依赖方弄坏了。
   */
  async disable(name: string): Promise<void> {
    const p = this.plugins.get(name)
    if (!p?.active) throw new ManagerError('not_active', `插件未激活: ${name}`)
    const dependents = collectDependents(this.config.registry, this.activeNames(), name)
    if (dependents.length > 0) {
      throw new ManagerError('has_dependents', `存在依赖方，禁止卸载: ${dependents.join(', ')}`, { dependents })
    }
    /*
     * 层必须在卸载**之前**取：`deactivateCore → unloadPlugin` 会把 `managed.layer` 置为 null，
     * 卸载后再读只会拿到 null，于是会话层插件会走错分支（被登记成"临时停用基础层插件"，
     * 会话清单里的条目也永远清不掉）。
     */
    const layer = p.layer
    await this.deactivateCore(name)
    if (layer === 'session') {
      this.removeFromSession(name)
      return
    }
    // 基础层：只在本进程里记住它被停了（不落盘 ⇒ 重启照基础清单回来）
    this.runtimeDisabled.add(name)
    console.log(`[manager] 插件 ${name} 已在本进程内临时停用（基础清单未改动，重启后仍会加载）`)
  }

  /** 应用并持久化：Session 层"活动"条目合并进 Base，清空会话（构想 5.3 的"应用并持久化"）。
   * 激活失败（error 态/未装配）的条目不提升——避免坏配置被持久化后每次启动报错。 */
  persistSession(): { promoted: string[]; disabled: string[] } {
    /*
     * 临时停用一并持久化：把条目从基础清单里删掉，**然后**才清空登记（不变量 ③）。
     * 顺序不能反——先清登记再落盘，中途写盘失败就会留下"标记没了、清单也没改"的
     * 假持久化：界面显示已持久化，重启后插件却又回来了。
     */
    const disabled = [...this.runtimeDisabled].filter(
      (name) => this.plugins.get(name)?.active !== true && this.base.enabled.some((e) => e.name === name),
    )
    if (disabled.length > 0) {
      const drop = new Set(disabled)
      this.base.enabled = this.base.enabled.filter((e) => !drop.has(e.name))
    }
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
    // 落盘成功之后才撤登记：上面的 filter 已经保证只删"确实没在跑"的条目
    for (const name of disabled) {
      this.runtimeDisabled.delete(name)
      const mp = this.plugins.get(name)
      if (mp) mp.layer = null
    }
    if (disabled.length > 0) {
      console.log(`[manager] 临时停用已持久化：基础清单移除 ${disabled.join(', ')}`)
    }
    return { promoted, disabled }
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
   * ★ F14：带超时的插件加载。
   *
   * 为什么必须有（本项是审计 §3.2「可靠性」里唯一**没有**任何缓解措施的中风险项）：
   * `apply()` 是插件自己的代码。一个死循环、或一个永不 settle 的 `await`，
   * 会让 `ctx.plugin()` **永远不返回**——而激活跑在**进程启动路径**上，
   * 于是故障形态是「进程既没起来、也没报错、也不退出」，日志停在上一个插件。
   * 除了超时，没有任何别的机制能把这个状态变成一条可读的错误。
   *
   * 超时后的处置**分两步，缺一不可**：
   * 1. 立刻抛 `load_timeout`（与 `load_failed` 走同一条单点回滚路径）；
   * 2. **接住那个已经没人等的 promise**：若它最终成功了，就主动 `dispose()` 掉那个 fiber。
   *    不做第 2 步会得到比超时更糟的东西——一个**幽灵插件**：管理器认为它没激活，
   *    它却已经把服务/路由/插槽装进了容器，且再无句柄可回收。
   *
   * 定时器**刻意不 `unref()`**：本仓库刚在 F12 踩过这个坑——`unref()` 之后空闲场景下
   * 事件循环直接结束，`Promise.race` 永不 settle，超时反而**永不触发**。
   * 正确做法是在正常路径上显式 `clearTimeout`（见 `finally`）。
   */
  private async loadPluginModule(
    name: string,
    entry: RegisteredPlugin,
    effectiveConfig: Record<string, unknown>,
  ): Promise<FiberLike> {
    const { applyTimeout } = normalizeRuntime(entry.manifest.geewiki.runtime)
    const pending = this.ctx.plugin(entry.module, this.hydrateSecrets(name, effectiveConfig))
    // `<= 0` = 显式关闭超时（逃生口，与 drainTimeout 的 `<= 0` 语义方向一致）
    if (applyTimeout <= 0) return await pending

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ManagerError('load_timeout', `加载超时 ${name}: apply() 在 ${applyTimeout}s 内未结算`, {
            timeoutSeconds: applyTimeout,
          }),
        )
      }, applyTimeout * 1000)
    })

    try {
      return await Promise.race([pending, timeout])
    } catch (err) {
      if (err instanceof ManagerError && err.code === 'load_timeout') {
        // 幽灵插件回收：成功则 dispose，失败则吞掉（原始错误已由超时错误代表，
        // 这里再抛会变成一条没人认领的 unhandledRejection）
        void pending.then(
          (late) => {
            void late.dispose().catch(() => {})
          },
          () => {},
        )
      }
      throw err
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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

    // 5.5 迁移控制器：插件声明迁移目录且 db 服务可用时，激活前执行（失败=阻止加载，事务已回滚）。
    // 迁移目录**按当前适配器的方言**取：先精确匹配方言键，再回退 'default'；
    // 两者都没有 ⇒ 该插件在当前数据库下没有迁移（跳过，不阻断激活）。
    const dbForMigration = this.ctx.get('db') as AnyDatabaseAdapter | undefined
    if (dbForMigration && entry.migrationsDirs) {
      const adapter = asAsync(dbForMigration)
      const dirForDialect = entry.migrationsDirs[adapter.dialect] ?? entry.migrationsDirs['default']
      if (dirForDialect) {
        try {
          await adapter.migrate(dirForDialect)
        } catch (err) {
          managed.error = `迁移执行失败: ${(err as Error).message}`
          throw new ManagerError(
            'migration_failed',
            `迁移执行失败（已回滚），阻止加载 ${name}: ${(err as Error).message}`,
          )
        }
      } else {
        console.warn(
          `[manager] ${name} 未声明 ${adapter.dialect} 方言的迁移目录，跳过迁移（表结构由插件自管）`,
        )
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
    // 密钥：入参里的值落进密钥文件，交给插件的那一份再把已存的值填回去。
    // `managed.config` 记的是**没有密钥**的那一份（落盘与会话清单都消费它）。
    effectiveConfig = this.absorbSecrets(name, effectiveConfig, [])

    // cordis 动态加载：await 等激活完成（含 async apply）；激活失败经 _error 抛出
    let fiber: FiberLike
    try {
      fiber = await this.loadPluginModule(name, entry, effectiveConfig)
    } catch (err) {
      managed.error = (err as Error).message
      /*
       * ★ F14：已经**结构化**的错误（如 `load_timeout`）原样上抛，不再包成 `load_failed`。
       * 否则超时会被这个 catch 抹掉 code，REST 层只能按 400 回，运维看不到"是超时"。
       */
      if (err instanceof ManagerError) throw err
      throw new ManagerError('load_failed', `加载失败 ${name}: ${(err as Error).message}`)
    }
    managed.fiber = fiber
    managed.active = true
    managed.layer = layer
    managed.error = null
    managed.config = effectiveConfig
    // 激活即撤掉"临时停用"登记（不变量 ②）：否则会出现"既在跑、又被标记为临时停用"的自相矛盾
    this.runtimeDisabled.delete(name)
    this.activationOrder.push(name)
    /*
     * ★ F10：激活时把权限声明**打出来**。
     *
     * 为什么在激活而不是在快照查询里：快照是查询路径（管理台轮询会把它刷屏），
     * 而"装了什么、它要碰什么"是**每次激活一次**的事实，正好对应运维读日志的场景。
     * 无声明时**一行都不打** —— 否则 20 个内置插件会刷出 20 行"权限: （无）"，
     * 把真正有声明的那几行淹掉。
     */
    const declaredPermissions = readPluginPermissions(name, entry.manifest.geewiki.permissions)
    if (declaredPermissions.length > 0) {
      console.log(`[manager] 插件 ${name} 声明的跨界能力: ${declaredPermissions.join(', ')}`)
    }
    // 插槽声明登记：**放在激活成功之后**（apply 抛错时不该留下归属记录，
    // 否则插件起来了才算数这条不变式会被破坏）。声明式来源标记为 'manifest'。
    this.registerManifestSlots(name, entry)
    // 路由声明**不需要**在这里登记：它与插槽不同，是"纯声明"——没有需要按 owner 回收的
    // 运行期状态，入口表每次现算（见 routeResolution()）。在这里多发一个事件反而会让
    // "声明表"与"激活集合"建立一份多余的同步关系。
    this.emitPluginActivated(name, entry)
  }

  /**
   * 广播「插件已激活」（F7）。
   *
   * ## 为什么需要这个事件（而不只是日志）
   * 它是 "**`provide` 可见性陷阱**"的正规解除点：一个插件 `apply` 未结算时 `provide` 的服务
   * 对它期间创建的子插件不可见（`ctx.get` 返回 `undefined` 并**静默跳过**）。在此之前，
   * 依赖方唯一的办法是"排在自己前面"这种脆弱的顺序约定。订阅 `PLUGIN_ACTIVATED_EVENT`
   * 则可以在服务真正可用之后再做延迟绑定。
   *
   * ## 为什么 `ctx.emit` 写在这里而不是抽进一个通用辅助函数
   * 抽掉之后，`PLUGIN_ACTIVATED_EVENT` 就不在"发射点"上了——
   * 而 `packages/manager/test/platformEvents.test.ts` 正是靠"常量出现在 `ctx.emit(…)` 的第一个实参"
   * 来防"声明了却没人发"的**谎报 token**。为了一个 3 行的 helper 让那条守卫失去作用不划算。
   *
   * 纪律（与其它平台事件一致）：同步 emit、**吞掉订阅者异常**——这里跑在插件启停路径上，
   * 让某个订阅者的 bug 把一次成功的激活上报成失败是最坏结果（插件已加载、状态已改，
   * 调用方却重试 ⇒ 重复激活）。
   */
  private emitPluginActivated(name: string, entry: RegisteredPlugin): void {
    try {
      this.ctx.emit(PLUGIN_ACTIVATED_EVENT, pluginLifecyclePayload(name, entry))
    } catch (err) {
      console.warn(`[manager] ${PLUGIN_ACTIVATED_EVENT} 的订阅者抛错（已忽略，插件启停本身照常）:`, err)
    }
  }

  /**
   * 把 manifest 的 `geewiki.slots` / `geewiki.extensions` 声明登记为扩展贡献。
   *
   * 为什么在激活后才登记：与激活失败的处理保持一致——失败的插件不应占着插槽。
   * 未知节点名 / 该节点不允许的模式由 `SlotRegistry` 忽略并告警（不阻断激活），
   * 与前端"忽略未知节点"一致。
   *
   * `slots` 是 `extensions` 中 `mode: 'extend'` 的简写：两者都走同一条登记路径，
   * 于是不存在"声明式扩展点只在清单里有效、运行期查询看不到"的分裂。
   * 同一 `(owner, node)` 重复声明时**先登记者保留 `via`**：`slots` 里已经声明过的节点，
   * 在 `extensions` 里再以别的模式出现时会被 `extend()` 告警并覆盖模式（可见，不静默）。
   */
  private registerManifestSlots(name: string, entry: RegisteredPlugin): void {
    const declared = entry.manifest.geewiki.slots
    if (declared && declared.length > 0) {
      for (const slot of declared) this.slots.contributeFromManifest(name, slot)
    }
    const extensions = entry.manifest.geewiki.extensions
    if (extensions && extensions.length > 0) {
      for (const decl of extensions) {
        if (decl === null || typeof decl !== 'object') {
          console.warn(`[manager] 插件 ${name} 的 geewiki.extensions 里有非对象条目（已忽略）`)
          continue
        }
        this.slots.contributeFromManifest(name, decl.node, undefined, decl.mode ?? 'extend')
      }
    }
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
    // 会话层覆盖也走同一套：清单文件里本来就没有密钥，这里只把已存的密钥补进运行时那一份
    effective = this.absorbSecrets(name, effective, [])
    const previous = managed.config
    if (isDeepStrictEqual(effective, previous)) {
      // 覆盖值与基础层生效值相同（enable 写会话条目时通常就是这样）：跳过，
      // 免得每次启动都白做一次 dispose + apply，并连带重启依赖方
      return
    }
    try {
      await fiber.update(this.hydrateSecrets(name, effective))
    } catch (err) {
      this.overlayFailed.add(name)
      try {
        await fiber.update(this.hydrateSecrets(name, previous ?? {}))
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
    /*
     * F7：停用完成事件。放在**所有回收动作之后**（贡献注销、长连接回收、排空都已结算）——
     * 订阅者收到它时去查该插件的状态，看到的必须是"确实已经停了"，
     * 否则会读到半停用的中间态（例如插槽贡献还在、服务已经没了）。
     */
    this.emitPluginDeactivated(name, managed.entry, error?.message)
  }

  /** 广播「插件已停用」（F7）。**放在所有回收动作之后**——见调用点的说明。 */
  private emitPluginDeactivated(name: string, entry: RegisteredPlugin, error?: string): void {
    try {
      this.ctx.emit(PLUGIN_DEACTIVATED_EVENT, pluginLifecyclePayload(name, entry, error))
    } catch (err) {
      console.warn(`[manager] ${PLUGIN_DEACTIVATED_EVENT} 的订阅者抛错（已忽略，插件启停本身照常）:`, err)
    }
  }

  /**
   * 卸载统一出口（disable / enable 回滚 / disposeAll 共用）：
   * 优雅排空（§5.1）→ cordis dispose → 缓存清理钩子（§5.7）。
   * 卸载异常不在此抛出，而是返回给调用方决定处置（deactivateCore 记日志、disposeAll 聚合上抛）。
   */
  private async unloadPlugin(name: string, managed: ManagedPlugin): Promise<Error | null> {
    // 先定向回收该插件自己开的长连接（SSE 等），再按 drainTimeout 排空在途请求。
    //
    // 顺序与理由：长连接**不计入排空**（见 HttpRouterService.trackStream 的语义），
    // 所以 drain() 不会等它们；若不在这里收，插件级 /disable 既不退在途、也不收流，
    // 客户端会**静默悬空**——历史上这被记为"把噪声故障换成了沉默故障"。
    // 收流本身不改变排空语义与告警文案：真实在途请求该等还是要等、该告警还是要告警。
    this.closeOwnStreams(name)
    // 插槽贡献同步回收：与收流同层、同理由——卸载统一出口上做一次，
    // 所有卸载路径（disable / 启停回滚 / disposeAll）自动覆盖。
    // 放在 drain 之前：贡献已经"不该再生效"了，没必要等排空完才撤。
    this.slots.release(name)
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
   * 定向收掉某插件自己开的长连接（owner 粒度）。
   *
   * 落点说明：卸载统一出口 `unloadPlugin`（disable / enable 回滚 / disposeAll 共用），
   * 因此在**所有**卸载路径上都生效，不需要每个调用点各自记得收流。
   *
   * 与 drainTimeout 无关：排空约束的是"在途请求"，而长连接不占在途数——
   * 即便插件声明 drainTimeout: 0（不等待排空），它的长连接也必须被收掉，
   * 否则客户端会一直挂着等一个再也不会来的字节。
   *
   * 路由服务未实现 `closeStreams`（例如测试替身）时静默跳过：这是可选成员，
   * 缺失只意味着"该实现不支持流回收"，不应让卸载失败。
   */
  private closeOwnStreams(name: string): void {
    const router = this.ctx.get('http') as HttpRouterService | undefined
    if (!router?.closeStreams) return
    try {
      router.closeStreams(name)
    } catch (err) {
      // 收流失败不得让卸载失败（路由服务内部已逐个 try/catch，这里是兜底）
      console.warn(`[manager] 插件 ${name} 的长连接回收出错（继续卸载）:`, err)
    }
  }

  /**
   * 卸载前优雅排空（架构 §5.1）：按插件 manifest 的 `runtime.drainTimeout`（秒，缺省 5）
   * 等待"处理器尚未结算"的在途 HTTP 请求完成；超时则记录告警后强制卸载。
   * `drainTimeout <= 0` 表示不等待（立即卸载）。
   *
   * 语义（与 HttpRouterService.drain 一致）：等待的是全站在途请求，
   * **不含发起本次卸载的那次管理请求本身**（REST 卸载由处理器内部调用，
   * 若把自己算进去就会等自己、必然空转满 drainTimeout）。
   *
   * 按插件（owner）粒度的**长连接回收**已在 {@link closeOwnStreams} 里完成；
   * 按插件粒度的**在途请求**排空仍未实现（drain 是全站语义）。
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
          : err.code === 'load_timeout'
            ? 504 // ★ F14：服务端等待插件 apply 结算超时——不是客户端的请求有问题
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

/* ------------------------- P2：插件 config 回显脱敏 ------------------------- */

/**
 * 是否允许在响应里回显插件的 `config`（设计文档 §8.2 P2 第 14 条）。
 *
 * **为什么必须在路由层脱敏、而不是改 `snapshotOf()`**：`snapshotOf()` 的返回值同时被
 * `enable`/`replace` 的响应复用（`ok(h, { plugin: snapshot })`）。在那一层裁剪会把管理台
 * 的**配置表单**一起打瞎 —— 表单正是靠 `config` 回填当前值。
 *
 * **为什么两条路都要覆盖**：`GET /api/plugins` 与 `GET /api/session` 回显的是**同一批
 * config**（后者经 `PluginListFile.enabled[].config`）。只改前者会留下第二条通道。
 *
 * 判据是 break-glass **或** 组织 owner/admin。设计文档原文只写了 break-glass，
 * 那是因为写下它时（P1 阶段）**还没有真实角色** —— 角色的持久化位置 `org_members`
 * 是 P2 才建的。现状下若只认 break-glass，登录为 owner 的管理员也会拿不到 config，
 * 管理台的配置表单将无法回填。放宽到 owner/admin **不重新打开匿名泄漏**
 * （匿名与普通成员的 `orgRole` 不是这两个值），故这是对原文的**有据收窄**。
 */
function mayReadPluginConfig(h: RouteHandlerContext): boolean {
  const p = h.principal
  if (!p) return false // 拿不到主体 ⇒ 失败关闭
  if (p.kind === 'break-glass') return true
  return p.orgRole === 'owner' || p.orgRole === 'admin'
}

/** 剥掉单个插件快照里的 `config` 字段（返回新对象，不改原对象） */
function withoutPluginConfig(snapshot: PluginSnapshot): Omit<PluginSnapshot, 'config'> {
  const { config: _drop, ...rest } = snapshot
  return rest
}

/** 剥掉清单文件里每个条目的 `config` 字段（`PluginListFile.enabled[].config`） */
function withoutListConfig(file: { enabled: readonly { name: string; config?: unknown }[] }): unknown {
  return { ...file, enabled: file.enabled.map(({ config: _drop, ...rest }) => rest) }
}

/** 挂载管理器 REST 路由（导出以便集成测试直接以路由服务替身驱动，无需真实 HTTP） */
export function registerRoutes(router: HttpRouterService, manager: GeeWikiManager): void {
  /*
   * 访问等级（P0）：
   *
   * - **读端点保持 `public`**（`/api/plugins`、`/graph`、`/slots`、`/ui`）：前端的插件
   *   探测（`packages/web/src/pages/WikiPage.tsx` 据 `/api/plugins` 的 state 决定搜索/AI
   *   入口是否可用）与插件 UI 加载（`/api/plugins/ui`）都依赖它们，收紧会让**内容浏览**
   *   这一核心路径回归——那不属于 P0 要堵的"整类端点被匿名调用"。
   * - **状态变更与配置读写一律 `admin`**：这些端点此前匿名可调，其中
   *   `/api/plugins/:name/disable` 能热卸载数据库插件，是本项目当前最高危的一组。
   *   注意：`GET /api/plugins` 的响应里含各插件的 `config`（可能含上游密钥），
   *   本次**未**裁剪（属读路径改造，留给 P2 的"非 admin 返回公开子集"）。
   */
  router.register('GET', '/api/plugins', (h) => {
    // ★ P2：非 owner/admin/break-glass 的主体**看不到 `config`**（§8.2 P2 第 14 条）。
    // 其余字段（state/provides/requires/displayName…）照常返回 —— 前端的插件探测
    // 与依赖图都依赖它们，收紧它们会让内容浏览主路径回归。
    const snapshots = manager.snapshot()
    // issues：外部插件目录里被跳过的目录/清单（机器可读 code），前端与 CLI 据此提示"装了但没加载"
    ok(h, {
      plugins: mayReadPluginConfig(h) ? snapshots : snapshots.map(withoutPluginConfig),
      issues: manager.discoveryIssues(),
    })
  }, { access: 'public', owner: '@geewiki/manager' })
  router.register('GET', '/api/plugins/graph', (h) => ok(h, { graph: manager.graph() }), {
    access: 'public',
    // ★ F12：登记方 —— 内置插件在此**示范**怎么声明（插件可自行决定是否归因）
    owner: '@geewiki/manager',
  })
  // 插槽裁决结果与冲突诊断。
  //
  // 为什么单独开一个只读端点而不是只塞进入口表：入口表是**给前端驱动加载**的，
  // 而冲突是**运维/排障**问题（"我启用的编辑器为什么没生效"）。两者受众与缓存策略不同
  // （入口表走 revision + 304，这里必须每次现算），混在一起会让排障必须绕过缓存。
  router.register('GET', '/api/plugins/slots', (h) => {
    const assignments = manager.slotAssignments()
    const declarations = manager.slotDeclarations()
    const routeResolution = manager.routeResolution()
    const capabilityResolution = manager.capabilityResolution()
    ok(h, {
      slots: assignments,
      conflicts: assignments.filter((a) => a.suppressed.length > 0),
      /*
       * 界面扩展平台（P3）：同一份裁决**加上模式**。
       *
       * 为什么是**新增字段**而不是把 `slots` 改成新模式：`slots` 的形状是已发布契约
       * （既有前端解析器、既有守卫测试、既有管理台都在读它）。新增而不是改写，
       * 于是"后端升级、前端未升级"的组合仍然工作——这是插件平台的常态，不是过渡期。
       *
       * `node` 是宿主节点 id 或插件自定义扩展点名；`byMode` 让前端直接组装
       * （replace → wrap → extend 的应用顺序已由 `effective` 排好）。
       */
      extensions: manager.extNodeAssignments(),
      // A1：谁开了哪些插件自定义扩展点（基数由声明决定，未声明默认 multi）
      declarations,
      /*
       * 有贡献者、但**无人 `define()` 声明过**的自定义扩展点（诊断）。
       *
       * 这**不是错误**（未声明按 `multi` 处理，功能正常），但必须可见——它通常意味着两件事之一：
       * ① 贡献方已经迁到自定义扩展点、声明方还没调 `define()`（缺基数声明，单占用会失效）；
       * ② **拼错了命名空间**：`pulgin-a/toolbar` 与 `plugin-a/toolbar` 会各自成为一个扩展点，
       *    两个贡献者永远碰不到一起，而界面上**什么都不会报**（各自渲染进一个空出口）。
       * ②正是"开放键空间"引入的新失败模式，故必须带上这条补偿（判据见 `undeclaredSlots`）。
       */
      undeclared: undeclaredSlots(assignments, declarations),
      // F2：路由声明的裁决结果与冲突（同一端点，因为两者是同一件事的两面：
      // "插件能往哪儿插" 与 "插件能不能有自己的页面"）
      routes: routeResolution.routes,
      routeConflicts: routeResolution.conflicts,
      // F9：能力声明的裁决与冲突（同一端点，理由同上：都是"插件能宣称什么"）
      capabilities: capabilityResolution.capabilities,
      capabilityConflicts: capabilityResolution.conflicts,
      capabilityDeclarations: manager.capabilityService().declarations(),
      /*
       * 声明了却没有注册求解器的能力（诊断）。
       *
       * 这**不是错误**（该能力恒 false，不影响别的功能），但必须可见：它意味着
       * 某个插件声明的能力**永远算不出 true**，于是依赖它的导航项/路由完全不出现、
       * 且没有任何报错。判据与插槽的 `undeclared` 同构（见本端点上方那段注释）。
       */
      unresolvedCapabilities: unresolvedCapabilities(
        capabilityResolution.capabilities.map((c) => c.decl.name),
        manager.capabilityService().registered(),
      ),
      /*
       * ★ 优化点 8：内置插槽的 props 描述表。
       *
       * 与上面几项不同，这一项**不是**运行期裁决结果，而是**契约的自助入口**：
       * 外部插件是裸 JS，作者没有 `EditorSlotProps` 这类类型可查。放在这个端点是因为
       * 它是"插槽"这个主题的既有落点（受众相同：写插件 UI 的人 + 排障的人）。
       *
       * 一致性不靠纪律：`packages/core/test/slot-props-schema.test.ts` 会按每一项自己声明的
       * `contract` 锚点去源码里比对接口的顶层字段名与可选性，两侧任一方向漂移即红。
       */
      props: SLOT_PROPS_SCHEMA,
    })
  }, { access: 'public', owner: '@geewiki/manager' })
  /*
   * ★ F12：**插件健康检查**端点。
   *
   * 为什么单独一个端点而不是塞进 `GET /api/plugins`：两者的**时效与代价**完全不同 ——
   * 快照是纯内存读，而这里要**执行插件代码**（每个 active 插件一次探针，逐个带超时）。
   * 混在一起会让"列一下插件"变成一个会阻塞数秒的请求。
   *
   * 顺带回传 `routeOwners`（按登记方聚合的请求计数）：两者都是**运行期遥测**
   * （与上面那个"插件宣称了什么"的静态诊断端点受众相同、数据性质不同），
   * 放在一起可以让一次排障请求拿全。
   */
  router.register(
    'GET',
    '/api/plugins/health',
    async (h) => {
      const plugins = await manager.pluginHealth()
      // 本函数已经持有 router 本身（`registerRoutes(router, manager)`），无需 ctx.get
      // 失败关闭：第三方实现可以不提供 ownerStats ⇒ 报空数组，而不是编一个 0
      // （0 会被读成"没有请求"，那是在撒谎）
      const routeOwners = router.ownerStats?.() ?? []
      ok(h, {
        plugins,
        routeOwners,
        // 明确告诉消费方"摘要只覆盖自报不健康的与探测失败的"，避免把 ok:true 读成"全都验证过了"
        summary: {
          active: plugins.filter((p) => p.state === 'active').length,
          unhealthy: plugins.filter((p) => p.health?.ok === false).length,
          failed: plugins.filter((p) => p.timedOut === true || p.error !== undefined).length,
          unprobed: plugins.filter((p) => p.state === 'active' && p.health === undefined && p.error === undefined && p.timedOut !== true).length,
        },
      })
    },
    { access: 'admin', owner: '@geewiki/manager' },
  )
  /*
   * ★ F20：备份。**只有服务器进程**能产出一致的数据库快照（它握着 `db` 服务），
   * 所以备份是服务端能力；而**恢复刻意不做成路由** —— 恢复要在服务器正拿着库和附件
   * 读写的时候替换文件，等价于"边跑边换引擎"，只能停机用 CLI 做。
   *
   * 访问等级 `admin`：备份产物含 `config/secrets.json`（明文密钥），且读写的是宿主机文件，
   * 属于本项目里仅次于"热卸载数据库插件"的高危操作。
   */
  router.register(
    'POST',
    '/api/backup',
    async (h) => {
      try {
        const report = await manager.createBackup()
        ok(h, {
          dir: report.dir,
          files: report.manifest.files.length,
          bytes: report.totalBytes,
          database: report.manifest.database,
          secretsIncluded: report.manifest.secretsIncluded,
          describe: describeBackup(report.manifest),
        })
      } catch (err) {
        fail(h, err)
      }
    },
    { access: 'admin', owner: '@geewiki/manager' },
  )
  router.register('GET', '/api/backup', (h) => ok(h, { backups: manager.listBackups() }), {
    access: 'admin',
    owner: '@geewiki/manager',
  })
  /*
   * ★ F17：外部插件**完整性体检**。刻意不做进 `GET /api/plugins`：那是前端会轮询的热端点，
   * 而校验要对每个插件的每个文件算 sha256。这里按需触发。
   *
   * `unsigned`（没有安装基线）与 `ok` 必须在响应里保持可区分 —— 把"无法判断"报成"通过"
   * 正是这类设施最容易退化成"看起来在防护、实际什么都没防"的方式。
   */
  router.register('GET', '/api/plugins/integrity', (h) => ok(h, manager.verifyPluginIntegrity()), {
    access: 'admin',
    owner: '@geewiki/manager',
  })
  /*
   * ★ F15：i18n。**刻意是 `public`**：界面文案要在**登录之前**就能用（登录页自己也有文案），
   * 而这里下发的只有插件贡献的界面文本，没有密钥、没有正文、没有主体信息。
   * 若将来有人在 catalog 里放敏感性内容，这条访问等级就要重新审视 —— 故在此写明理由。
   */
  router.register('GET', '/api/i18n', (h) => ok(h, manager.i18nAvailable()), {
    access: 'public',
    owner: '@geewiki/manager',
  })
  router.register(
    'GET',
    '/api/i18n/:locale',
    (h) => {
      const locale = h.params['locale'] ?? ''
      // 语言标记会参与回退链计算与语言码比较；非法输入直接 400，不要让它流进解析逻辑
      if (!isLocaleCode(locale)) {
        h.json(400, { ok: false, error: 'invalid_locale', message: `语言标记不合法: ${JSON.stringify(locale)}` })
        return
      }
      const resolved = manager.i18nCatalogs(locale)
      ok(h, {
        locale,
        default: DEFAULT_LOCALE,
        chain: resolved.chain,
        catalogs: resolved.catalogs,
        issues: [...resolved.declIssues, ...resolved.issues],
      })
    },
    { access: 'public', owner: '@geewiki/manager' },
  )
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
  }, { access: 'public' })
  // 刻意保持 public：P0 的契约是"读端点行为与改动前完全一致"（设计文档 §8.1 P0 行），
  // 读路径裁剪统一留给 P2。这里**不是"暂缓收紧"，而是收紧会直接弄坏管理台首屏**：
  // 插件页（packages/web/src/pages/GraphPage.tsx）用 Promise.all 取 plugins/session/slots/graph，
  // 三个里只有 api.session() 没有 .catch()，它一旦 401/503 就整体 reject ⇒ 插件列表根本不渲染。
  // （packages/web 在 P0 不得改动，前端测试又全部 mock 掉了 api 模块，故此回归不会有测试变红。）
  router.register('GET', '/api/session', (h) => {
    // ★ P2：这里是 config 回显的**第二条通道** —— `sessionState()` 里的
    // `PluginListFile.enabled[].config` 与 `/api/plugins` 是同一批数据。
    // 只堵前一条会留下这个旁路（§8.2 P2 第 14 条明确点名）。
    const state = manager.sessionState()
    if (mayReadPluginConfig(h)) {
      ok(h, state)
      return
    }
    ok(h, {
      ...state,
      base: withoutListConfig(state.base),
      session: withoutListConfig(state.session),
    })
  }, { access: 'public' })
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
  }, { access: 'admin' })
  router.register('GET', '/api/plugins/:name/config', (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      ok(h, manager.configOf(name))
    } catch (err) {
      fail(h, err)
    }
  }, { access: 'admin' })
  router.register('PUT', '/api/plugins/:name/config', async (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      const body = await readJsonBody(h)
      if (!('config' in body)) throw new ManagerError('bad_request', '请求体缺少 config 字段')
      // `clearSecrets` 是可选的动作字段（不在 config 里，免得被 schema 裁剪掉）：
      // 用于"显式清除已配置的密钥"，与"留空 = 不修改"区分开
      const clearSecrets = Array.isArray(body['clearSecrets'])
        ? body['clearSecrets'].filter((v): v is string => typeof v === 'string')
        : []
      const result = await manager.updateConfig(name, body['config'], { clearSecrets })
      ok(h, result)
    } catch (err) {
      fail(h, err)
    }
  }, { access: 'admin' })
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
  }, { access: 'admin' })
  router.register('POST', '/api/plugins/:name/disable', async (h) => {
    try {
      const name = h.params['name']
      if (!name) throw new ManagerError('not_found', '缺少插件名')
      await manager.disable(name)
      ok(h, { plugin: name })
    } catch (err) {
      fail(h, err)
    }
  }, { access: 'admin' })
  router.register('POST', '/api/session/persist', async (h) => {
    try {
      const result = manager.persistSession()
      ok(h, result)
    } catch (err) {
      fail(h, err)
    }
  }, { access: 'admin' })
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
