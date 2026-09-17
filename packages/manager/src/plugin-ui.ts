/**
 * 插件客户端 UI 入口表（架构 §6 前端插槽）——**纯函数 + 可注入 IO**，便于单元测试。
 *
 * 解决的问题：宿主侧插槽机制（`packages/web/src/lib/slots.tsx`）与插件 bundle 加载
 * （`packages/web/src/lib/pluginUi.ts`）此前依赖一个**构建生成物**静态文件
 * （`<webDist>/plugins-ui/registry.json`）来得知"该加载哪些插件的界面"。那份表在运行时
 * 不会随插件启停变化，删插件目录还得重跑构建。本模块把入口表改为**由活状态派生**：
 * 注册表（谁声明了 `geewiki.client`）× 当前激活集合 × 产物是否真的存在。
 *
 * ## 最重要的不变式：双资产根 + 存在性判定只有一份实现
 *
 * 一个插件的 UI 产物可能位于两处，按优先级：
 *   ① `<插件目录>/dist`            —— 外部插件自带产物（Docker 里 plugins/ 是 bind mount，
 *                                     这是"安装即生效、无需重建 web 包"的唯一路径）
 *   ② `<webDist>/plugins-ui/<名>`  —— 内置插件与既有夹具（dev 指 publicDir，prod 指 dist）
 *
 * "用哪个根 / 入口在不在"必须由 {@link resolvePluginUiHit} **唯一**决定，并被
 * {@link buildPluginUiTable}（下发入口表）与 {@link pluginUiRootsFor}（静态层按名查根）
 * 共同复用。若两处各算一遍，就会出现"表里给了 rev、资产却 404"或"rev 变了但内容还是旧的"
 * 这类"看门狗式不一致"——它们在快照里和"没报错"长得一样，极难排查。
 *
 * 另注：入口表只列**已激活**插件（决定"该不该加载"），而静态层按名查根**不按激活过滤**
 * （决定"能不能取到"）——刚被停用的插件可能还有在途 import 需要结算，此时给 404 会制造
 * 无谓的 console error。两个集合的差异是刻意的。
 */
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  isPluginUiEntryPath,
  type GeeWikiManifest,
  type PluginRouteDecl,
  type SlotName,
} from '@geewiki/core'
import type { RegisteredPlugin } from './deps.js'
import { conflictsOf, effectiveSlotsByOwner, type SlotAssignment, type SlotConflict } from './slots.js'

/** 文件指纹（只 stat，不读内容）：入口/样式的 mtime 与大小 */
export interface UiFileStat {
  mtimeMs: number
  size: number
}

/** 可注入的 stat：文件不存在/无权限/不是普通文件时返回 undefined */
export type UiStatFile = (path: string) => UiFileStat | undefined

/** 默认 stat 实现（基于 node:fs.statSync） */
export const statFileSync: UiStatFile = (path) => {
  try {
    const info = statSync(path)
    if (!info.isFile()) return undefined
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return undefined
  }
}

/** 入口表中单个插件的条目：文件名（单段）+ 产物指纹 */
export interface PluginUiTableEntry {
  /** UI 入口文件名（单段，不含目录） */
  entry: string
  /** 可选样式文件名（单段） */
  css?: string
  /** 该插件产物的指纹（entry 与 css 的 mtime-大小拼接入 sha1 的前 8 位） */
  rev: string
  /**
   * 该插件**实际生效**的插槽（见 `@geewiki/core` 的 `SlotName`）。
   *
   * **为空时整个键被省略**，理由有两条：
   * ① 绝大多数插件不贡献插槽，塞一个空数组只会让下发体积与 diff 噪声变大；
   * ② 更实际的是——`revision` 是对 `{version, plugins}` 求 sha1，省略空值意味着
   *    **本次新增该字段不会改变任何既有部署的 revision**，不会平白触发一次全量重取。
   */
  slots?: SlotName[]
  /**
   * 该插件**生效的**页面路由声明（F2 新增）。同样空值时省略该键（理由同上）。
   *
   * 为什么路由要进入口表而不是只在客户端 bundle 里注册：入口表是**加载决策**的唯一依据，
   * 而"这个插件的产物里有没有页面"必须参与"要不要推迟加载"的判定——
   * 只贡献按需插槽 + 一个页面的插件若被整个推迟，用户点它的导航项会看到空白页**且不报错**。
   * 前端据此把它标为不可推迟（`isLazyOnlyEntry` 返回 false）。
   */
  routes?: readonly PluginRouteDecl[]
}

/** 未能进入入口表的原因（`GET /api/plugins/ui` 的 `skipped`） */
export type PluginUiSkipReason = 'inactive' | 'no_client' | 'entry_missing' | 'invalid_name'

export interface PluginUiSkipped {
  name: string
  reason: PluginUiSkipReason
}

export interface PluginUiTable {
  /** 入口表**格式**版本（沿用旧的 registry.json 的 version:1） */
  version: 1
  /** 表格内容指纹（sha1 前 12 位）：只随"该加载的集合及各插件 rev"变化 */
  revision: string
  plugins: Record<string, PluginUiTableEntry>
  /** 为什么某些插件没出现（按 name 排序）；`entry_missing` 是"产物缺失"的唯一可见出口 */
  skipped: PluginUiSkipped[]
  /**
   * 单占用插槽被多个 active 插件声明时的**冲突诊断**（为空时省略该键，见 `slots` 字段的同款理由）。
   *
   * 为什么要把"冲突"下发给前端而不是只写服务端日志：冲突的后果是**用户可见**的
   * （"我启用的编辑器没生效"），只留在日志里就等于让用户去猜。
   * 裁决本身是确定性的（见 `resolveSlots`），这里是把结果**可见化**。
   */
  slotConflicts?: SlotConflict[]
}

/**
 * 单个 URL 路径段能否作为插件名的一部分：
 * 非空、不含 `/` 或 `\`、不是 `.`/`..`、无空白与控制字符。
 */
function isPluginUiNameSegment(segment: string): boolean {
  if (!segment) return false
  if (segment === '.' || segment === '..') return false
  if (segment.includes('/') || segment.includes('\\')) return false
  // eslint-disable-next-line no-control-regex -- 显式排除控制字符（含 NUL）是安全校验的一部分
  if (/[\s\u0000-\u001f\u007f]/.test(segment)) return false
  return true
}

/**
 * 插件名能否安全地原样放进 URL 路径（`/plugins-ui/<名>/<文件>`）。
 *
 * 规则（与 npm 命名语义一致）：非 scope 名恰好 1 段（`wiki`）；scope 名恰好 2 段
 * （`@geewiki/wiki`），且首段以 `@` 开头、长度 > 1；每段都必须通过
 * {@link isPluginUiNameSegment}。因此 `a/b/c`、`../x`、`a b`、`@scope`（只有 scope 无名字）、
 * `wiki/x`（2 段但首段非 scope）、空串都非法。
 *
 * 注意：**插件名不做 URL 编码**（`@geewiki/wiki` 就是两段），编码名一律不认——
 * 编码后 dev 会落 Vite 的 SPA fallback（200 + text/html），prod 静态层不解码必 404。
 */
export function isPluginUiName(name: string): boolean {
  const segments = name.split('/')
  if (segments.length === 1) {
    const only = segments[0] as string
    // 单段名不得以 @ 开头：那是 scope 形态，必须带 `/名字`
    return !only.startsWith('@') && isPluginUiNameSegment(only)
  }
  if (segments.length === 2) {
    const scope = segments[0] as string
    const rest = segments[1] as string
    return scope.length > 1 && scope.startsWith('@') && isPluginUiNameSegment(scope) && isPluginUiNameSegment(rest)
  }
  return false
}

/**
 * 把 `/plugins-ui/` 之后的路径段还原成插件名（静态层用）：
 * 1 段，或 2 段且首段为 `@` 开头的 scope 形态。其余（含多段、编码名解出的空段）一律 undefined。
 */
export function pluginUiNameFromSegments(segments: readonly string[]): string | undefined {
  if (segments.length === 1) {
    const only = segments[0] as string
    return isPluginUiName(only) ? only : undefined
  }
  if (segments.length === 2) {
    const candidate = `${segments[0]}/${segments[1]}`
    return isPluginUiName(candidate) ? candidate : undefined
  }
  return undefined
}

/**
 * 解析插件清单声明的 UI 入口（`geewiki.client`）。
 * 未声明 → undefined；`client: {}` → 缺省 `entry: 'client.js'`；
 * 路径不满足 {@link isPluginUiEntryPath}（`..`、绝对路径、空段、以 `.` 开头、含空白等）→
 * **整体视为未声明**（返回 undefined，不抛错——一个坏声明不该让宿主启动失败）。
 *
 * ★ F13：判据从"必须单段"放宽为"单段**或**分层路径"。放宽的部分是**限制**，
 * 不是**防护**：`..` / 绝对路径 / 空段都由 `PLUGIN_UI_ASSET_PATH` 的逐段规则挡住，
 * 而真正的路径防护在静态资源层（段比较 + realpath）。
 */
export function pluginUiEntryOf(manifest: GeeWikiManifest | undefined): { entry: string; css?: string } | undefined {
  const client = manifest?.geewiki.client
  if (!client) return undefined
  const entry = client.entry ?? 'client.js'
  if (!isPluginUiEntryPath(entry)) return undefined
  if (client.css !== undefined && !isPluginUiEntryPath(client.css)) return undefined
  return client.css === undefined ? { entry } : { entry, css: client.css }
}

/** 目录存在性判定（可注入，纯函数测试用） */
export type UiDirExists = (path: string) => boolean

/** 默认目录存在性判定（node:fs.existsSync） */
export const dirExistsSync: UiDirExists = (path) => existsSync(path)

/**
 * 候选 UI 根（**有序，顺序即优先级**）：只返回"目录存在"的候选。
 * 这是"可能有哪些根"，实际命中哪个由 {@link resolvePluginUiHit} 判定。
 */
export function resolvePluginUiRoots(
  name: string,
  pluginDir: string | undefined,
  webDist: string | null | undefined,
  dirExists: UiDirExists = dirExistsSync,
): string[] {
  const roots: string[] = []
  // ① 外部插件自带产物目录
  if (pluginDir) roots.push(join(pluginDir, 'dist'))
  // ② 宿主 web 产物里的既有约定位置
  if (webDist) roots.push(join(webDist, 'plugins-ui', name))
  return roots.filter((root) => dirExists(root))
}

/**
 * **实际命中的 UI 根**：按优先级取第一个"入口文件存在"的候选根。
 * 这是双根与存在性判定的唯一实现——入口表与静态层都必须经由此函数（见文件头不变式）。
 */
export function resolvePluginUiHit(
  name: string,
  pluginDir: string | undefined,
  webDist: string | null | undefined,
  declared: { entry: string; css?: string },
  statFile: UiStatFile = statFileSync,
  dirExists: UiDirExists = dirExistsSync,
): { root: string; entryStat: UiFileStat; cssStat?: UiFileStat } | undefined {
  for (const root of resolvePluginUiRoots(name, pluginDir, webDist, dirExists)) {
    const entryStat = statFile(join(root, declared.entry))
    if (!entryStat) continue
    // 样式缺失不算失败：入口在即视为产物就绪，只是不注入样式
    const cssStat = declared.css === undefined ? undefined : statFile(join(root, declared.css))
    return cssStat === undefined ? { root, entryStat } : { root, entryStat, cssStat }
  }
  return undefined
}

/** 产物指纹：入口（与样式）的 `mtime-大小` 拼接入 sha1 的前 8 位 */
function revOf(hit: { entryStat: UiFileStat; cssStat?: UiFileStat }): string {
  const parts = [`${hit.entryStat.mtimeMs}-${hit.entryStat.size}`]
  if (hit.cssStat) parts.push(`${hit.cssStat.mtimeMs}-${hit.cssStat.size}`)
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8)
}

export interface BuildPluginUiTableOptions {
  registry: readonly RegisteredPlugin[]
  /** 当前激活集合（通常来自管理器的 activeNames()） */
  activeNames: ReadonlySet<string>
  webDist: string | null | undefined
  /** 注入的 stat（真实环境传 {@link statFileSync}，测试可传假实现） */
  statFile: UiStatFile
  /** 注入的目录存在性判定（缺省 existsSync；纯函数测试可传 `() => true`） */
  dirExists?: UiDirExists
  /** 插槽裁决结果（`resolveSlots` 的产物）。缺省视为"无人贡献插槽"，行为与改动前完全一致。 */
  slotAssignments?: readonly SlotAssignment[]
  /**
   * 每个 owner **生效的**路由声明（`effectiveRoutesByOwner` 的产物）。
   * 缺省视为"没有插件声明路由"，行为与改动前完全一致（`routes` 键不出现 ⇒ revision 不变）。
   */
  routesByOwner?: ReadonlyMap<string, readonly PluginRouteDecl[]>
}

/**
 * 构造入口表。
 *
 * 进入 `plugins` 的条件（三者同时满足）：插件名合法 → 当前**已激活** → 声明了 `client`
 * 且入口文件在某个候选根里**确实存在**（只 stat，不读内容）。
 *
 * `skipped` 的判定顺序：名字非法 > 未激活 > 未声明 client > 入口缺失（互斥，每插件至多一条）。
 * `revision` 只对 `{version, plugins}` 求 sha1（`skipped` 不参与），且 `plugins` 按键排序，
 * 因此同一份表格内容必定得到同一个 revision（与注册表顺序无关）。
 *
 * ## 插槽字段与 revision 的关系（必须理解，否则会踩"改了却不刷新"的坑）
 * `slots` 是 `plugins[name]` 的**内容**，因此**天然计入 revision**——这是刻意的：
 * 若插槽归属变了而 revision 不变，前端的 `If-None-Match` 会拿到 304，
 * 于是"某个编辑器插件被停用、editor 换人"这类变化会被**静默隐藏**，
 * 用户看到的是旧编辑器继续渲染、且没有任何报错。本仓库此前在别处踩过同类坑
 * （`skipped` 不参与 revision 导致变更被 304 掩盖），故这里明确纳入。
 * 对既有部署的兼容性由"空值省略"保证：没人贡献插槽时 `slots` 根本不出现，
 * revision 与改动前逐字节相同，不会平白触发一次全量重取。
 *
 * `slotConflicts` **刻意不计入 revision**：它是诊断信息，不是"该加载什么"的指令；
 * 把它算进去会让"仅仅多了一条告警"也触发前端重取 bundle。代价是冲突的**新增**
 * 可能被 304 掩盖——接受这一点的理由是：冲突一旦存在就会稳定存在（不是瞬时状态），
 * 且用户下次真正改动插件启停时 revision 必然变化、届时冲突随之可见。
 */
export function buildPluginUiTable(opts: BuildPluginUiTableOptions): PluginUiTable {
  const found: Record<string, PluginUiTableEntry> = {}
  const skipped: PluginUiSkipped[] = []
  const slotsByOwner = effectiveSlotsByOwner(opts.slotAssignments ?? [])
  for (const entry of opts.registry) {
    const name = entry.name
    if (!isPluginUiName(name)) {
      skipped.push({ name, reason: 'invalid_name' })
      continue
    }
    if (!opts.activeNames.has(name)) {
      skipped.push({ name, reason: 'inactive' })
      continue
    }
    const declared = pluginUiEntryOf(entry.manifest)
    if (!declared) {
      skipped.push({ name, reason: 'no_client' })
      continue
    }
    const hit = resolvePluginUiHit(name, entry.dir, opts.webDist, declared, opts.statFile, opts.dirExists)
    if (!hit) {
      skipped.push({ name, reason: 'entry_missing' })
      continue
    }
    const slots = slotsByOwner.get(name)
    const routes = opts.routesByOwner?.get(name)
    found[name] = {
      entry: declared.entry,
      ...(declared.css === undefined ? {} : { css: declared.css }),
      rev: revOf(hit),
      // 空数组时省略键：见 PluginUiTableEntry.slots 的说明（保持既有部署 revision 不变）
      ...(slots === undefined || slots.length === 0 ? {} : { slots }),
      ...(routes === undefined || routes.length === 0 ? {} : { routes }),
    }
  }
  // 按键排序后再序列化：revision 只反映内容，不反映注册表顺序
  const plugins: Record<string, PluginUiTableEntry> = {}
  for (const name of Object.keys(found).sort()) plugins[name] = found[name] as PluginUiTableEntry
  skipped.sort((a, b) => a.name.localeCompare(b.name))
  const revision = createHash('sha1').update(JSON.stringify({ version: 1, plugins })).digest('hex').slice(0, 12)
  const conflicts = conflictsOf(opts.slotAssignments ?? [])
  return {
    version: 1,
    revision,
    plugins,
    skipped,
    ...(conflicts.length === 0 ? {} : { slotConflicts: conflicts }),
  }
}

/**
 * 静态层的"按插件名查 UI 根"表。**不按激活过滤**（见文件头说明）：
 * 只要求"声明了 client 且入口确实存在"，命中根与入口表用同一函数判定。
 */
export function pluginUiRootsFor(
  registry: readonly RegisteredPlugin[],
  webDist: string | null | undefined,
  statFile: UiStatFile = statFileSync,
  dirExists: UiDirExists = dirExistsSync,
): Record<string, string> {
  const roots: Record<string, string> = {}
  for (const entry of registry) {
    const name = entry.name
    if (!isPluginUiName(name)) continue
    const declared = pluginUiEntryOf(entry.manifest)
    if (!declared) continue
    const hit = resolvePluginUiHit(name, entry.dir, webDist, declared, statFile, dirExists)
    if (hit) roots[name] = hit.root
  }
  return roots
}
